// ======================================================
// IU Image Processor
// ======================================================
// Handles single IU image generation, scene-level IU processing,
// IU metadata persistence, and scene duration retrieval.

const path = require('path');
const fs = require('fs');
const config = require('../config/runtime-config');
const gpu = require('../runtime/gpu-dispatcher');
const jobSchema = require('../runtime/job-schema');
const wfLoader = require('../workflows/workflow-loader');
const helpers = require('./helpers');
const promptBuilder = require('./prompt-builder');
const assemblyProfile = require('./assembly-profile');
const registry = require('./registry');
const { applyImageValue, resolveImageProfileName } = require('./connector-utils');
const { collectSceneUnits } = require('./registry');

// TTL маркера animastor:iu-in-flight:* — ЕДИНЫЙ источник: runtime-config
// (используется также per-dispatch индексом в dispatch-engine).
const IU_IN_FLIGHT_TTL_S = config.TIMEOUTS.IU_IN_FLIGHT_TTL_S;

/**
 * Check an iu-in-flight marker with stale-marker self-heal.
 *
 * Значение маркера = dispatch_id владельца (legacy-маркеры: '1'). Маркер
 * уважается только пока владеющий dispatch остаётся АКТИВНЫМ dispatch'ем
 * image-стадии этой сцены (dispatch metadata). Если владелец мёртв
 * (finalized/crashed/restart — metadata нет или принадлежит другому
 * dispatch'у), маркер stale: его job либо не был отправлен, либо его
 * dispatch уже не существует, и маркер удаляется compare-and-delete,
 * чтобы текущий dispatch мог отправить IU заново.
 *
 * Это гарантирует idempotency повторного dispatch после no_jobs_sent /
 * backend restart (forensic audit 6929ba5): stale маркеры не блокируют
 * новый dispatch бесконечно.
 *
 * @returns {Promise<{inFlight: boolean, staleCleared?: boolean, owner?: string|null}>}
 */
async function checkInFlightMarker(redis, inFlightKey, bookId, chapterId, sceneId, dispatchId) {
    const owner = await redis.get(inFlightKey);
    if (!owner) return { inFlight: false, owner: null };
    if (dispatchId && owner === dispatchId) {
        // Собственный маркер текущего dispatch — реально in-flight.
        return { inFlight: true, owner };
    }

    let activeDispatchId = null;
    try {
        // Lazy require: dispatch-engine лениво требует orchestration,
        // избегаем циклического require на верхнем уровне модуля.
        const dispatchEngine = require('../runtime/dispatch-engine');
        const metadata = await dispatchEngine.getDispatchMetadata(redis, bookId, chapterId, sceneId, 'image');
        activeDispatchId = metadata?.dispatch_id || null;
    } catch (e) {
        activeDispatchId = null;
    }

    if (activeDispatchId && activeDispatchId === owner) {
        // Владеющий dispatch всё ещё активен — job может реально выполняться.
        return { inFlight: true, owner };
    }

    // Stale: владелец мёртв. Удаляем АТОМАРНЫМ compare-and-delete (один Lua-
    // шаг): между проверкой живости и удалением маркер мог быть пере-создан
    // новым dispatch'ем — чужой маркер удалять нельзя.
    let cas = { deleted: false, reason: 'missing' };
    try {
        const dispatchEngine = require('../runtime/dispatch-engine');
        cas = await dispatchEngine.compareAndDeleteMarker(redis, inFlightKey, owner);
    } catch (e) {
        helpers.warn(`[IU-IN-FLIGHT-STALE] Failed to clear stale marker ${inFlightKey}: ${e.message}`);
    }
    if (!cas.deleted && cas.reason === 'owner_changed') {
        // Маркер успел сменить владельца на живой dispatch — консервативно
        // считаем IU in-flight (self-heal повторится на следующем dispatch).
        return { inFlight: true, owner };
    }
    if (cas.deleted) {
        try {
            const runtimeMetrics = require('../runtime/runtime-metrics');
            await runtimeMetrics.incrementCounter(redis, 'iuInFlightStaleCleared');
        } catch (_) {}
        helpers.log(`[IU-IN-FLIGHT-STALE] Cleared stale marker ${inFlightKey} (owner=${owner}, active_dispatch=${activeDispatchId || 'none'})`);
    }
    return { inFlight: false, staleCleared: cas.deleted, owner };
}

async function saveIUMetadata(buildId, bookId, chapterId, sceneId, unit, sceneDuration, fullText, sceneOrder) {
    // IMPORTANT: always use unit.text (full text with speech markers for dialogue units),
    // NOT unit.audio?.text (bare dialogue, e.g. "Дайте нарзану" instead of
    // "— Дайте нарзану, — попросил Берлиоз."). The text field is used for:
    //   - Display in storyboard/timeline
    //   - text_length for IU timing recalculation (text-length proportional distribution)
    // Using audio.text would give dialogue units 3-4x less timing than they should have.
    const iuText = unit.text || '';
    const proportion = fullText.length > 0 ? iuText.length / fullText.length : 0;
    const iuDuration = sceneDuration * proportion;

    try {
        const { iu } = require('../storage/postgres/repositories');
        await iu.upsertImageUnit(buildId, bookId, chapterId, sceneId, String(unit.id), {
            scene_order: sceneOrder != null ? sceneOrder : 0,
            text: iuText,
            text_length: iuText.length,
            text_proportion: parseFloat(proportion.toFixed(6)),
            scene_duration_sec: sceneDuration,
            estimated_duration_sec: parseFloat(iuDuration.toFixed(3)),
            scene_audio_file: `${bookId}_${chapterId}_${sceneId}.mp3`,
        });
        helpers.log(`IU metadata saved to PG: ${unit.id} (${iuDuration.toFixed(3)}s)`);
    } catch (err) {
        helpers.warn(`Failed to save IU metadata to PG: ${err.message}`);
    }
}

async function getSceneDuration(buildId, bookId, chapterId, sceneId) {
    // Priority 1: Real audio file on disk (GROUND TRUTH)
    const audioPath = helpers.getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);
    if (fs.existsSync(audioPath)) {
        try {
            const mm = require('music-metadata');
            const metadata = await mm.parseFile(audioPath);
            if (metadata.format.duration > 0) return metadata.format.duration;
        } catch {}
    }

    // Priority 2: scene_assets with status='ready' (real audio registered in DB)
    try {
        const { query } = require('../storage/postgres/database');
        const result = await query(`
            SELECT duration_sec FROM scene_assets
            WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
              AND asset_type = 'audio' AND build_id = $4 AND status = 'ready'
            LIMIT 1
        `, [bookId, chapterId, sceneId, buildId]);
        if (result.rows.length > 0 && result.rows[0].duration_sec > 0) return result.rows[0].duration_sec;
    } catch {}

    // Priority 3: image_units.scene_duration_sec (may be stale placeholder-based value)
    try {
        const { query } = require('../storage/postgres/database');
        const result = await query(`
            SELECT scene_duration_sec FROM image_units
            WHERE build_id = $1 AND book_id = $2 AND chapter_id = $3 AND scene_id = $4
            LIMIT 1
        `, [buildId, bookId, chapterId, sceneId]);
        if (result.rows.length > 0 && result.rows[0].scene_duration_sec > 0) return result.rows[0].scene_duration_sec;
    } catch {}

    // Priority 4: scene_assets with status='placeholder' (original word-count estimate)
    try {
        const { query } = require('../storage/postgres/database');
        const result = await query(`
            SELECT duration_sec FROM scene_assets
            WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
              AND asset_type = 'audio' AND build_id = $4 AND status = 'placeholder'
            LIMIT 1
        `, [bookId, chapterId, sceneId, buildId]);
        if (result.rows.length > 0 && result.rows[0].duration_sec > 0) return result.rows[0].duration_sec;
    } catch {}

    return 0;
}

async function processSingleIU(redis, unit, uIdx, sceneData, loadedBook, buildId, bookId, chapterId, sceneId, sceneDuration, fullText, dirtyUnitIds = new Set(), dispatchId) {
    const canonicalUnitId = String(unit.id);
    if (!canonicalUnitId) {
        helpers.error(`IU unit.id missing, skipping: ${chapterId}/${sceneId}`);
        return { sent: false, cached: false };
    }
    const imageIUId = `${bookId}_${chapterId}_${sceneId}_${canonicalUnitId}`;
    const inFlightKey = `animastor:iu-in-flight:${imageIUId}`;

    const force = dirtyUnitIds.size > 0 && dirtyUnitIds.has(canonicalUnitId);
    if (!force) {
        const flight = await checkInFlightMarker(redis, inFlightKey, bookId, chapterId, sceneId, dispatchId);
        if (flight.inFlight) {
            helpers.log(`[IU-ALREADY-IN-FLIGHT] Skipping ${imageIUId} — already dispatched (marker owner=${flight.owner})`);
            return { sent: false, cached: false, skipped: true };
        }
        const cachedIU = registry.probeIUImage(imageIUId, buildId, config.OUTPUT_DIR);
        if (cachedIU?.image) {
            try {
                await saveIUMetadata(buildId, bookId, chapterId, sceneId, unit, sceneDuration, fullText, uIdx);
            } catch (err) {
                helpers.warn(`Failed to save IU metadata for ${unit.id}: ${err.message}`);
            }
            helpers.log(`IMAGE (IU) CACHE HIT: ${imageIUId}`);
            await registry.saveIURegistry(redis, imageIUId, buildId);
            return { sent: false, cached: true };
        }
    } else {
        helpers.log(`[DIRTY-UNIT-REGEN] Force-regenerating ${imageIUId} — this unit was modified`);
        const oldPng = path.join(config.OUTPUT_DIR, buildId, `${imageIUId}.png`);

        const flight = await checkInFlightMarker(redis, inFlightKey, bookId, chapterId, sceneId, dispatchId);
        if (flight.inFlight) {
            helpers.log(`[IU-ALREADY-IN-FLIGHT] Skipping ${imageIUId} — already dispatched (marker owner=${flight.owner})`);
            return { sent: false, cached: false, skipped: true };
        }

        try {
            await redis.del(
                `animastor:job:${imageIUId}:iu_image`,
                `animastor:job:${imageIUId}:image`
            );
            helpers.log(`[DEDUP-CLEAR] Cleared hub dedup keys for ${imageIUId}`);
        } catch (e) {
            helpers.warn(`[DEDUP-CLEAR] Failed: ${e.message}`);
        }

        try {
            if (fs.existsSync(oldPng)) {
                fs.unlinkSync(oldPng);
                helpers.log(`[DIRTY-UNIT-REGEN] Deleted stale PNG: ${oldPng}`);
            }
        } catch (delErr) {
            helpers.warn(`[DIRTY-UNIT-REGEN] Failed to delete stale PNG ${oldPng}: ${delErr.message}`);
        }

        const strippedUnitId = canonicalUnitId.replace(/^iu/, '');
        const oldPreview = path.join(config.OUTPUT_DIR, buildId,
            `${bookId}_${chapterId}_${sceneId}_pr${strippedUnitId}.png`);
        try {
            if (fs.existsSync(oldPreview)) {
                fs.unlinkSync(oldPreview);
                helpers.log(`[DIRTY-UNIT-REGEN] Deleted stale preview: ${oldPreview}`);
            }
        } catch (delErr) {
            helpers.warn(`[DIRTY-UNIT-REGEN] Failed to delete stale preview ${oldPreview}: ${delErr.message}`);
        }
    }

    try {
        await saveIUMetadata(buildId, bookId, chapterId, sceneId, unit, sceneDuration, fullText, uIdx);
    } catch (err) {
        helpers.warn(`Failed to save IU metadata for ${unit.id}: ${err.message}`);
    }

    // Assembly profile for the image workflow — resolved from the connector's
    // profile.imageProfile (e.g. "qwen-image"); falls back to the built-in
    // assembly when unset (there is no 'default' profile).
    const imageProfileName = resolveImageProfileName();
    const assemblyCfg = assemblyProfile.resolveAssembly('image', imageProfileName);

    const finalPrompt = promptBuilder.buildImagePrompt(unit, sceneData.payload, sceneData.chapter, loadedBook, { profile: imageProfileName });

    helpers.log(`GENERATE IMAGE (IU): ${imageIUId}, unit.id: ${canonicalUnitId}, profile: ${imageProfileName}`);

    const wfImg = wfLoader.getWorkflow('img-qwen-image');
    const baseNegative = assemblyCfg.defaults.negativeBase || 'blurry, low quality, artifacts';
    const customNegative = promptBuilder.resolveNegativePrompt(unit, sceneData.payload);

    applyImageValue(wfImg, 'positivePrompt', finalPrompt);
    applyImageValue(wfImg, 'negativePrompt', customNegative ? `${customNegative}, ${baseNegative}` : baseNegative);

    try {
        // Маркер = dispatch_id владельца: по нему finalizeDispatch чистит
        // маркеры НЕотправленных jobs при cancellation/failure, а следующий
        // dispatch отличает stale-маркер мёртвого dispatch от живого.
        await redis.set(inFlightKey, dispatchId || 'unknown', 'EX', IU_IN_FLIGHT_TTL_S);
        const dispatchEngine = require('../runtime/dispatch-engine');
        await dispatchEngine.registerInFlightMarker(redis, dispatchId, inFlightKey);
    } catch (e) {
        helpers.warn(`[IU-IN-FLIGHT] Failed to set marker for ${imageIUId}: ${e.message}`);
    }

    try {
        await redis.del(`animastor:result-processed:${imageIUId}:iu_image:${buildId}`);
        helpers.log(`[DEDUP-CLEAR-BACKEND] Pre-cleared result-processed dedup for ${imageIUId}`);
    } catch (e) {
        helpers.warn(`[DEDUP-CLEAR-BACKEND] Pre-clear failed: ${e.message}`);
    }

    await registry.saveIURegistry(redis, imageIUId, buildId);
    const sendResult = await gpu.send(
        jobSchema.buildJobId(imageIUId, 'iu_image'),
        wfImg,
        'image',
        buildId,
        dispatchId
    );
    try {
        const dispatchEngine = require('../runtime/dispatch-engine');
        // Маркер снимается с dispatch-индекса в обоих случаях:
        //  - sent:true  → job реально выполняется, маркер больше не входит в
        //                 abort-scope dispatch'а (его очистит completion
        //                 callback); cancellation НЕ должна его удалять;
        //  - sent:false → job не существует, маркер удаляется сразу ниже.
        await dispatchEngine.unregisterInFlightMarker(redis, dispatchId, inFlightKey);
    } catch (e) {
        helpers.warn(`[IU-IN-FLIGHT] Failed to unregister marker for ${imageIUId}: ${e.message}`);
    }
    if (!sendResult.sent) {
        await redis.del(inFlightKey).catch(() => {});
        helpers.warn(`IMAGE (IU) enqueue failed for ${imageIUId}: ${sendResult.error || 'unknown'}`);
        return { sent: false, cached: false, reason: 'enqueue_failed' };
    }

    try {
        await redis.del(`animastor:result-processed:${imageIUId}:iu_image:${buildId}`);
        helpers.log(`[DEDUP-CLEAR-BACKEND] Post-cleared result-processed dedup for ${imageIUId}`);
    } catch (e) {
        helpers.warn(`[DEDUP-CLEAR-BACKEND] Post-clear failed: ${e.message}`);
    }

    return { sent: true, cached: false };
}

async function generateSceneIUImages(redis, sceneData, loadedBook, buildId, bookId, dirtyUnitIds = new Set(), dispatchId) {
    const units = collectSceneUnits(sceneData.payload);
    const chapterId = sceneData.chapter_id;
    const sceneId = sceneData.scene_id;
    if (!buildId) {
        helpers.error(`buildId is null for ${bookId}/${chapterId}/${sceneId}!`);
    }

    const sceneDuration = await getSceneDuration(buildId, bookId, chapterId, sceneId);
    const fullText = sceneData.payload?.audio?.full_text || '';

    let sentCount = 0;
    let cachedCount = 0;
    let skippedCount = 0;
    for (let uIdx = 0; uIdx < units.length; uIdx++) {
        const result = await processSingleIU(
            redis,
            units[uIdx],
            uIdx,
            sceneData,
            loadedBook,
            buildId,
            bookId,
            chapterId,
            sceneId,
            sceneDuration,
            fullText,
            dirtyUnitIds,
            dispatchId
        );
        if (result.sent) sentCount++;
        if (result.cached) cachedCount++;
        if (result.skipped) skippedCount++;
    }
    return { sentCount, cachedCount, skippedCount, total: units.length };
}

module.exports = {
    saveIUMetadata,
    getSceneDuration,
    processSingleIU,
    generateSceneIUImages,
    checkInFlightMarker,
    IU_IN_FLIGHT_TTL_S,
};
