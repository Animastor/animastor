// ======================================================
// Callback handlers — contract (T1):
//
// Каждый handler возвращает:
//   { ok: true,  artifact: { buildId, path } }           — успех
//   { ok: false, retryable: true,  reason: '<cause>' }   — временная ошибка (→ failStage)
//   { ok: false, retryable: false, reason: '<cause>' }   — терминальная ошибка (журнал, NO READY)
//
// Handler НЕ пишет PG status='ready' — это делает completeStage()
// после валидации результата и version gate.
// ======================================================

const path = require('path');
const fs = require('fs');
const state = require('../state');
const audio = require('../audio');
const image = require('../image');
const video = require('../video');
const storage = require('../storage');
const runtimeScheduler = require('../runtime/runtime-scheduler');
const dispatchEngine = require('../runtime/dispatch-engine');
const book = require('../book');
const placeholderAudio = require('../services/placeholder-audio');
const sceneAssetsRepo = require('../storage/postgres/repositories/scene-assets-repo');
const iuRepo = require('../storage/postgres/repositories/iu-repo');
const { publishProgress } = require('../services/progress-pubsub.cjs');
const { log, warn, error, logEvent } = require('./scene-utils');

// Stage constants (replaces removed scene-state-machine.js)
const Stage = { AUDIO: 'audio', IMAGE: 'image', VIDEO: 'video' };

async function updateSceneChunks(redis, bookId, chapterId, sceneId, updates) {
    const prefix = `animastor:chunk:${bookId}_${chapterId}_${sceneId}_`;
    let cursor = '0';
    do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 50);
        cursor = nextCursor;
        for (const key of keys) {
            try {
                const raw = await redis.get(key);
                if (raw) {
                    const chunk = JSON.parse(raw);
                    Object.assign(chunk, updates);
                    await redis.set(key, JSON.stringify(chunk));
                }
            } catch (e) {
                warn(`Failed to update chunk ${key}: ${e.message}`);
            }
        }
    } while (cursor !== '0');
}

async function handleAudioCompleted(redis, bookId, chapterId, sceneId, buildId) {
    // T1: возвращает { ok, retryable, reason, artifact }
    // artifact = { buildId, path } при ok:true
    log(`AUDIO_CALLBACK: ${bookId}/${chapterId}/${sceneId}`);

    const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const audioAllowed = assetStates && (
        assetStates.audio === state.AssetState.GENERATING ||
        assetStates.audio === state.AssetState.PENDING ||
        assetStates.audio === state.AssetState.DIRTY
    );

    if (!audioAllowed) {
        warn(`AUDIO_CALLBACK: Invalid per-asset state: ${assetStates?.audio || 'unknown'} (expected GENERATING/PENDING)`);
        log(`🔻 AUDIO callback rejected (invalid per-asset state): ${bookId}/${chapterId}/${sceneId}`);
        return { ok: false, retryable: false, reason: 'invalid_asset_state' };
    }

    const isReady = await audio.isSceneAudioReady(buildId, bookId, chapterId, sceneId, require('music-metadata'));
    if (!isReady) {
        error(`Audio not ready after completion: ${bookId}/${chapterId}/${sceneId}`);
        const scene = { book_id: bookId, chapter_id: chapterId, scene_id: sceneId };
        await logEvent(redis, scene, 'AUDIO_FAILED', 'audio_ready', {
            reason: 'not_ready_validation'
        });
        log(`🔻 AUDIO callback: audio not ready: ${bookId}/${chapterId}/${sceneId}`);
        return { ok: false, retryable: true, reason: 'audio_not_ready' };
    }

    const scene = { book_id: bookId, chapter_id: chapterId, scene_id: sceneId };
    await logEvent(redis, scene, 'AUDIO_COMPLETED', 'audio_ready', {
        buildId
    });

    const audioPath = storage.filesystem.getSceneAudioPath(
        process.env.OUTPUT_DIR || '/data/output', buildId, bookId, chapterId, sceneId
    );

    try {
        await storage.registry.registerSceneAudioRedis(redis, bookId, chapterId, sceneId, {
            canonicalPath: audioPath,
            ready: true
        });
        log(`CACHE-MANIFEST: audio recorded for ${bookId}/${chapterId}/${sceneId}`);
    } catch (err) {
        warn(`Failed to register audio asset: ${err.message}`);
    }

    // T1.10: PG markReady вынесен в completeStage после version gate
    // T1.10: PG markReady is now called in completeStage() after version gate

    let realDuration = 0;
    try {
        const mm = require('music-metadata');
        try {
            const metadata = await mm.parseFile(audioPath);
            realDuration = metadata.format.duration || 0;
        } catch {}
        await placeholderAudio.replacePlaceholderWithRealAudio(
            bookId, chapterId, sceneId, buildId, audioPath, realDuration
        );
    } catch (err) {
        warn(`Failed to replace placeholder audio: ${err.message}`);
    }

    // ── IU TIMING RECALCULATION ──
    if (realDuration > 0) {
        try {
            const units = await iuRepo.getImageUnitsForScene(buildId, bookId, chapterId, sceneId);
            if (units && units.length > 0) {
                const oldSceneDur = units[0].scene_duration_sec || 0;
                const diff = Math.abs(realDuration - oldSceneDur);
                if (diff > 1.0) {
                    const durLabel = oldSceneDur > 0
                        ? `${oldSceneDur.toFixed(2)}s → ${realDuration.toFixed(2)}s (Δ=${diff.toFixed(2)}s)`
                        : `first-time calculation (${realDuration.toFixed(2)}s)`;
                    log(`[IU-RECALC] ${bookId}/${chapterId}/${sceneId}: ${durLabel}, recalculating ${units.length} IU timings`);
                    const totalTextLen = units.reduce((s, u) => s + (u.text_length || 0), 0);
                    let cursorMs = 0;
                    const sceneDurationMs = Math.round(realDuration * 1000);
                    for (const u of units) {
                        const proportion = totalTextLen > 0 ? (u.text_length || 0) / totalTextLen : 1 / units.length;
                        const durMs = Math.max(200, Math.round(realDuration * proportion * 1000));
                        const startMs = cursorMs;
                        let endMs = cursorMs + durMs;
                        if (endMs > sceneDurationMs) endMs = sceneDurationMs;
                        cursorMs = endMs;
                        await iuRepo.upsertImageUnit(buildId, bookId, chapterId, sceneId, u.unit_id, {
                            scene_order: u.scene_order || 0,
                            text: u.text,
                            text_length: u.text_length || 0,
                            text_proportion: parseFloat(proportion.toFixed(6)),
                            scene_duration_sec: realDuration,
                            estimated_duration_sec: parseFloat((realDuration * proportion).toFixed(3)),
                            scene_audio_file: u.scene_audio_file || `${bookId}_${chapterId}_${sceneId}.mp3`,
                            start_ms: startMs,
                            end_ms: endMs,
                        });
                    }
                    log(`[IU-RECALC] ✓ ${bookId}/${chapterId}/${sceneId}: ${units.length} IU timings updated to ${realDuration.toFixed(2)}s total`);
                } else {
                    log(`[IU-RECALC] ${bookId}/${chapterId}/${sceneId}: duration unchanged (${realDuration.toFixed(2)}s ≈ ${oldSceneDur.toFixed(2)}s), skipping`);
                }
            }
        } catch (err) {
            warn(`[IU-RECALC] Failed to recalculate IU timings: ${err.message}`);
        }
    }

    await publishProgress(redis, bookId, { layer: 'audio', chapterId, sceneId });
    log(`AUDIO_CALLBACK: ${bookId}/${chapterId}/${sceneId} -> READY check passed`);

    return {
        ok: true,
        artifact: { buildId, path: audioPath }
    };
}

async function handleImageCompleted(redis, bookId, chapterId, sceneId, buildId) {
    // T1: возвращает { ok, retryable, reason, artifact }
    log(`IMAGE_CALLBACK: ${bookId}/${chapterId}/${sceneId}`);

    const sceneImage = image.resolveCanonicalSceneImage(
        '/data/output', buildId, bookId, chapterId, sceneId
    );

    // Per-asset check
    const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const imageAllowed = assetStates && (
        assetStates.image === state.AssetState.GENERATING ||
        assetStates.image === state.AssetState.PENDING ||
        assetStates.image === state.AssetState.DIRTY
    );

    if (!imageAllowed) {
        warn(`IMAGE_CALLBACK: Invalid per-asset state: ${assetStates?.image || 'unknown'} — expected GENERATING/PENDING`);
        log(`🔻 IMAGE callback rejected (invalid per-asset state): ${bookId}/${chapterId}/${sceneId}`);
        return { ok: false, retryable: false, reason: 'invalid_asset_state' };
    }

    if (!sceneImage) {
        error(`Scene image not found after completion: ${bookId}/${chapterId}/${sceneId}`);
        const scene = { book_id: bookId, chapter_id: chapterId, scene_id: sceneId };
        await logEvent(redis, scene, 'IMAGE_FAILED', 'image_generating', {
            reason: 'not_found'
        });
        log(`🔻 IMAGE callback: image not found: ${bookId}/${chapterId}/${sceneId}`);
        // T1.7: не throw, а ok:false — completeStage обработает
        return { ok: false, retryable: true, reason: 'image_not_found' };
    }

    const imageInfo = await image.getImageMetadata(sceneImage);

    try {
        await storage.registry.registerSceneImageRedis(redis, bookId, chapterId, sceneId, {
            path: sceneImage,
            width: imageInfo?.width || null,
            height: imageInfo?.height || null,
            ready: true
        });
        log(`CACHE-MANIFEST: image recorded for ${bookId}/${chapterId}/${sceneId}`);
    } catch (err) {
        warn(`Failed to register image asset: ${err.message}`);
    }

    const scene = { book_id: bookId, chapter_id: chapterId, scene_id: sceneId };
    await logEvent(redis, scene, 'IMAGE_COMPLETED', 'image_ready', {
        buildId,
        path: sceneImage
    });

    // R4.1: Clear dirty unit IDs
    try {
        const dirtyIds = await sceneAssetsRepo.getDirtyUnitIds(bookId, chapterId, sceneId);
        if (dirtyIds && dirtyIds.length > 0) {
            const buildDir = path.join(process.env.OUTPUT_DIR || '/data/output', buildId);
            const stillPending = [];
            for (const uid of dirtyIds) {
                const pngPath = path.join(buildDir, `${bookId}_${chapterId}_${sceneId}_${uid}.png`);
                if (!fs.existsSync(pngPath)) {
                    stillPending.push(uid);
                }
            }
            if (stillPending.length === 0) {
                await sceneAssetsRepo.clearDirtyUnitIds(bookId, chapterId, sceneId);
                log(`[DIRTY-UNITS-CLEARED] ${bookId}/${chapterId}/${sceneId}: all ${dirtyIds.length} dirty unit(s) completed, cleared`);
                try {
                    const iuPrefix = `${bookId}_${chapterId}_${sceneId}_iu`;
                    const allFiles = fs.existsSync(buildDir) ? fs.readdirSync(buildDir) : [];
                    const iuFileCount = allFiles.filter(f => f.startsWith(iuPrefix) && f.endsWith('.png')).length;
                    if (iuFileCount > 0) {
                        const progKey = `animastor:iu-progress:${bookId}:${chapterId}:${sceneId}:image`;
                        await redis.set(progKey, String(iuFileCount), 'EX', 14400);
                        log(`[IU-COUNTER-RESET] ${bookId}/${chapterId}/${sceneId}: counter set to ${iuFileCount}`);
                    }
                } catch (counterErr) {
                    warn(`Failed to reset IU progress counter: ${counterErr.message}`);
                }
            } else {
                await sceneAssetsRepo.setDirtyUnitIds(bookId, chapterId, sceneId, stillPending);
                log(`[DIRTY-UNITS-PARTIAL] ${bookId}/${chapterId}/${sceneId}: ${stillPending.length}/${dirtyIds.length} dirty units still pending: ${stillPending.join(', ')}`);
            }
        }
    } catch (e) {
        warn(`Failed to update dirty_unit_ids in IMAGE_CALLBACK: ${e.message}`);
    }

    try {
        const scenePrefix = `${bookId}_${chapterId}_${sceneId}_iu-`;
        let cursor = '0';
        do {
            const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `animastor:iu-in-flight:${scenePrefix}*`, 'COUNT', 50);
            cursor = nextCursor;
            if (keys.length > 0) {
                await redis.del(...keys);
                log(`[IU-IN-FLIGHT-CLEARED] ${bookId}/${chapterId}/${sceneId}: cleared ${keys.length} in-flight markers`);
            }
        } while (cursor !== '0');
    } catch (e) {
        warn(`Failed to clear in-flight markers in IMAGE_CALLBACK: ${e.message}`);
    }

    await updateSceneChunks(redis, bookId, chapterId, sceneId, { image: true, image_status: 'ready' });
    log(`IMAGE_CALLBACK: ${bookId}/${chapterId}/${sceneId} -> READY check passed`);

    return {
        ok: true,
        artifact: { buildId, path: sceneImage }
    };
}

async function handleVideoCompleted(redis, bookId, chapterId, sceneId, buildId) {
    // T1: возвращает { ok, retryable, reason, artifact }
    log(`VIDEO_CALLBACK: ${bookId}/${chapterId}/${sceneId}`);

    const videoPath = `/data/output/${buildId}/${bookId}_${chapterId}_${sceneId}.mp4`;
    const { valid, duration, metadata } = video.validateVideoFile(videoPath);

    const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const videoAllowed = assetStates && (
        assetStates.video === state.AssetState.GENERATING ||
        assetStates.video === state.AssetState.PENDING ||
        assetStates.video === state.AssetState.DIRTY
    );

    if (!videoAllowed) {
        warn(`VIDEO_CALLBACK: Invalid per-asset state: ${assetStates?.video || 'unknown'} (expected GENERATING/PENDING)`);
        log(`🔻 VIDEO callback rejected (invalid per-asset state): ${bookId}/${chapterId}/${sceneId}`);
        return { ok: false, retryable: false, reason: 'invalid_asset_state' };
    }

    if (!valid) {
        error(`Video not valid after completion: ${bookId}/${chapterId}/${sceneId}`);
        const scene = { book_id: bookId, chapter_id: chapterId, scene_id: sceneId };
        await logEvent(redis, scene, 'VIDEO_FAILED', 'video_generating', {
            reason: 'invalid'
        });
        log(`🔻 VIDEO callback: video invalid: ${bookId}/${chapterId}/${sceneId}`);
        return { ok: false, retryable: true, reason: 'video_invalid' };
    }

    try {
        await storage.registry.registerSceneVideoRedis(redis, bookId, chapterId, sceneId, {
            path: videoPath,
            duration: duration || null,
            width: metadata?.width || null,
            height: metadata?.height || null,
            ready: true
        });
        log(`CACHE-MANIFEST: video recorded for ${bookId}/${chapterId}/${sceneId}`);
    } catch (err) {
        warn(`Failed to register video asset: ${err.message}`);
    }

    const scene = { book_id: bookId, chapter_id: chapterId, scene_id: sceneId };
    await logEvent(redis, scene, 'VIDEO_COMPLETED', 'video_ready', {
        buildId,
        path: videoPath,
        duration: duration || 0
    });

    await video.updateSceneVideoStatus(redis, bookId, chapterId, sceneId, 'ready');
    await updateSceneChunks(redis, bookId, chapterId, sceneId, { video: true, video_status: 'ready' });
    await publishProgress(redis, bookId, { layer: 'video', chapterId, sceneId });

    try {
        await sceneAssetsRepo.clearDirtyFlag(bookId, chapterId, sceneId);
        log(`[DIRTY-FLAG-CLEARED] ${bookId}/${chapterId}/${sceneId}: is_dirty=FALSE`);
    } catch (e) {
        warn(`Failed to clear dirty flag: ${e.message}`);
    }

    await runtimeScheduler.removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId);
    log(`SCENE COMPLETE: ${bookId}/${chapterId}/${sceneId} - removed from active index`);

    try {
        const bookData = book.loadBook(bookId);
        const sceneWindow = require('../runtime/scene-window');
        const slide = await sceneWindow.trySlideWindowOnComplete(redis, bookId, bookData, buildId);
        if (slide && slide.started > 0) {
            log(`SCENE-COMPLETE auto-slide: started=${slide.started} remaining=${slide.remaining}`);
        } else if (slide && slide.remaining === 0 && slide.started === 0) {
            log(`SCENE-COMPLETE auto-slide: scope fully complete`);
            try {
                await publishProgress(redis, bookId, { type: 'generation_complete' });
            } catch (_) {}
        }
    } catch (e) {
        warn(`SCENE-COMPLETE auto-slide failed: ${e.message}`);
    }

    return {
        ok: true,
        artifact: { buildId, path: videoPath }
    };
}

async function completeSceneWithoutVideo(redis, loadedBook, bookId, chapterId, sceneId, buildId) {
    log(`Completing scene without video: ${bookId}/${chapterId}/${sceneId}`);

    // M5: setAssetState(READY) + syncLinearState moved to orchestrator.completeStageWithoutVideo
    // This function is called THROUGH the facade, which handles state BEFORE calling here.


    try {
        await sceneAssetsRepo.clearDirtyFlag(bookId, chapterId, sceneId);
    } catch (e) {
        warn(`Failed to clear dirty flag in completeSceneWithoutVideo: ${e.message}`);
    }

    await runtimeScheduler.removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId);
    log(`Scene complete (no video): ${bookId}/${chapterId}/${sceneId} - removed from active index`);

    try {
        const sceneWindow = require('../runtime/scene-window');
        const slide = await sceneWindow.trySlideWindowOnComplete(redis, bookId, loadedBook, buildId);
        if (slide && slide.started > 0) {
            log(`SCENE-COMPLETE auto-slide: started=${slide.started} remaining=${slide.remaining}`);
        } else if (slide && slide.remaining === 0 && slide.started === 0) {
            log(`SCENE-COMPLETE auto-slide (no-video): scope fully complete`);
            try { await publishProgress(redis, bookId, { type: 'generation_complete' }); } catch (_) {}
        }
    } catch (e) {
        warn(`SCENE-COMPLETE auto-slide failed: ${e.message}`);
    }
}

async function completeSceneWithoutImage(redis, loadedBook, bookId, chapterId, sceneId, buildId) {
    log(`Completing scene without image: ${bookId}/${chapterId}/${sceneId}`);
    // M5: setAssetState(READY) + syncLinearState moved to orchestrator.completeStageWithoutImage
    // This function is called THROUGH the facade, which handles state BEFORE calling here.
    log(`Scene complete (no image): ${bookId}/${chapterId}/${sceneId}`);

    try {
        await sceneAssetsRepo.clearDirtyFlag(bookId, chapterId, sceneId);
    } catch (e) {
        warn(`Failed to clear dirty flag in completeSceneWithoutImage: ${e.message}`);
    }

    await runtimeScheduler.removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId);

    try {
        const sceneWindow = require('../runtime/scene-window');
        const slide = await sceneWindow.trySlideWindowOnComplete(redis, bookId, loadedBook, buildId);
        if (slide && slide.started > 0) {
            log(`SCENE-COMPLETE auto-slide: started=${slide.started} remaining=${slide.remaining}`);
        } else if (slide && slide.remaining === 0 && slide.started === 0) {
            log(`SCENE-COMPLETE auto-slide (no-image): scope fully complete`);
            try { await publishProgress(redis, bookId, { type: 'generation_complete' }); } catch (_) {}
        }
    } catch (e) {
        warn(`SCENE-COMPLETE auto-slide failed: ${e.message}`);
    }
}

module.exports = {
    updateSceneChunks,
    handleAudioCompleted,
    handleImageCompleted,
    handleVideoCompleted,
    completeSceneWithoutVideo,
    completeSceneWithoutImage,
};
