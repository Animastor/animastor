// ======================================================
// ANIMASTOR BACKEND — ENTITY CLEANUP SERVICE
// ======================================================
// Deep cleanup for manually deleted scene / module (unit) entities.
// The caller already saved the JSON (saveBookBundle), so this service
// removes the derived state across the remaining layers:
//
//   PostgreSQL   → scene_assets / generation_tasks / image_units /
//                  storyboard_elements / audio_layers / asset_states /
//                  cache_entries / scenes (reuses bookSync.purgeRemovedSceneRows)
//   Redis        → chunks + chunk set, per-asset states, asset registry,
//                  active index, audio/video orchestrators, dispatch leases/
//                  metadata, retry counters, iu registry/progress/in-flight,
//                  GPU job/result dedup keys
//   Filesystem   → OUTPUT_DIR/<build> scene audio/chunk/IU/preview/video files
//   In-flight    → cancels GPU dispatch leases + hub jobs (reuses dispatch-engine)
//
// Reuses existing helpers instead of duplicating their logic:
//   - bookSync.purgeRemovedSceneRows             (PG scene purge)
//   - assetRegistry.deleteSceneAssetsRedis       (Redis asset registry)
//   - scheduler.removeSceneFromActiveIndex       (active index)
//   - dispatch.clearLeasesForScenes + clearHubDispatches (lease/hub cancel)
//
// Every step is best-effort: a cleanup failure is logged and swallowed so it
// never fails the already-successful entity delete response.
// ======================================================

const path = require('path');
const fs = require('fs');

module.exports = function (redis, config, deps) {
    const storage = deps.storage;
    const runtime = deps.runtime;
    const bookSync = storage?.bookSync;
    const assetRegistry = storage?.registry;
    const scheduler = runtime?.scheduler;
    const dispatchEngine = runtime?.dispatch;

    const OUTPUT_DIR = (config || {}).OUTPUT_DIR;
    const log = deps.utils?.log || ((...a) => console.log(new Date().toISOString(), ...a));

    const ALL_STAGES = ['audio', 'image', 'video'];

    // ── Redis scan helpers ────────────────────────────
    async function scanKeys(pattern) {
        const keys = [];
        let cursor = '0';
        do {
            const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
            cursor = next;
            keys.push(...batch);
        } while (cursor !== '0');
        return keys;
    }

    async function delKeys(...keys) {
        const existing = keys.filter(Boolean);
        if (existing.length === 0) return 0;
        return await redis.del(...existing);
    }

    async function scanAndDel(pattern) {
        let keys;
        try {
            keys = await scanKeys(pattern);
        } catch (err) {
            console.warn(`[ENTITY-CLEANUP] scan failed for ${pattern}: ${err.message}`);
            return 0;
        }
        if (keys.length === 0) return 0;
        const deleted = await redis.del(...keys);
        return typeof deleted === 'number' ? deleted : keys.length;
    }

    // Delete the scene's chunk keys AND remove their ids from the book chunk
    // set in one scan pass (scanning after a separate del would miss them).
    async function deleteSceneChunks(bookId, chapterId, sceneId) {
        const prefix = `animastor:chunk:${bookId}_${chapterId}_${sceneId}_`;
        let keys;
        try {
            keys = await scanKeys(`${prefix}*`);
        } catch (err) {
            console.warn(`[ENTITY-CLEANUP] scan failed for ${prefix}*: ${err.message}`);
            return 0;
        }
        if (keys.length === 0) return 0;
        const ids = keys.map(k => k.slice('animastor:chunk:'.length));
        let deleted = 0;
        if (typeof redis.del === 'function') {
            deleted = await redis.del(...keys);
        }
        await redis.srem(`animastor:chunks:${bookId}`, ...ids);
        return typeof deleted === 'number' ? deleted : keys.length;
    }

    // ── Filesystem helpers ────────────────────────────
    function listBuildDirs() {
        if (!OUTPUT_DIR || !fs.existsSync(OUTPUT_DIR)) return [];
        let entries;
        try {
            entries = fs.readdirSync(OUTPUT_DIR);
        } catch {
            return [];
        }
        return entries
            .map(e => path.join(OUTPUT_DIR, e))
            .filter(p => {
                try { return fs.statSync(p).isDirectory(); } catch { return false; }
            });
    }

    const ASSET_EXTENSIONS = ['.mp3', '.png', '.mp4'];

    // Delete every scene asset file (audio, chunk audio/image, IU image,
    // preview, video) across all build directories (best-effort multi-build).
    function deleteSceneFiles(bookId, chapterId, sceneId) {
        const prefix = `${bookId}_${chapterId}_${sceneId}`;
        let deleted = 0;
        for (const buildPath of listBuildDirs()) {
            let files;
            try {
                files = fs.readdirSync(buildPath);
            } catch { continue; }
            for (const f of files) {
                if (!f.startsWith(prefix)) continue;
                if (!ASSET_EXTENSIONS.some(ext => f.endsWith(ext))) continue;
                try {
                    fs.unlinkSync(path.join(buildPath, f));
                    deleted++;
                } catch { /* best-effort */ }
            }
        }
        return deleted;
    }

    // Delete a single unit's IU image + preview PNG across build directories.
    function deleteUnitFiles(bookId, chapterId, sceneId, unitId) {
        const imageIUId = `${bookId}_${chapterId}_${sceneId}_${unitId}`;
        const stripped = String(unitId).replace(/^iu/, '');
        const targets = [
            `${imageIUId}.png`,
            `${bookId}_${chapterId}_${sceneId}_pr${stripped}.png`,
        ];
        let deleted = 0;
        for (const buildPath of listBuildDirs()) {
            for (const t of targets) {
                const full = path.join(buildPath, t);
                try {
                    if (fs.existsSync(full)) {
                        fs.unlinkSync(full);
                        deleted++;
                    }
                } catch { /* best-effort */ }
            }
        }
        return deleted;
    }

    // ── Scene purge ───────────────────────────────────
    async function purgeScene(bookId, chapterId, sceneId) {
        const out = { pg: {}, chunks: 0, files_deleted: 0 };

        // 1. PostgreSQL — reuse the shared scene purge (also covers asset_states
        //    and cache_entries since the book-sync fix).
        try {
            if (bookSync && typeof bookSync.purgeRemovedSceneRows === 'function') {
                out.pg = await bookSync.purgeRemovedSceneRows(bookId, [`${chapterId}::${sceneId}`]);
            }
        } catch (err) {
            console.warn(`[ENTITY-CLEANUP] PG purge failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
        }

        // 2. Cancel in-flight generation — leases + GPU hub dispatches.
        try {
            if (dispatchEngine && typeof dispatchEngine.clearLeasesForScenes === 'function') {
                const cancelled = await dispatchEngine.clearLeasesForScenes(
                    redis, bookId,
                    [{ chapter_id: chapterId, scene_id: sceneId, stages: ALL_STAGES }],
                );
                if (cancelled.dispatchIds && cancelled.dispatchIds.length > 0) {
                    await dispatchEngine.clearHubDispatches(cancelled.dispatchIds, { context: 'ENTITY-DELETE-SCENE' });
                }
                out.dispatch_cancelled = cancelled.cancelled || 0;
            }
        } catch (err) {
            console.warn(`[ENTITY-CLEANUP] dispatch cancel failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
        }

        // 3. Redis — exact scene keys + per-scene patterns.
        try {
            await delKeys(
                `animastor:asset-state:${bookId}:${chapterId}:${sceneId}`,
                `animastor:assets:${bookId}:${chapterId}:${sceneId}`,
                `animastor:audio-orch:${bookId}:${chapterId}:${sceneId}`,
                `animastor:video-orch:${bookId}:${chapterId}:${sceneId}`,
                `animastor:audio-scene-lock:${bookId}:${chapterId}:${sceneId}`,
                `animastor:scene-video:${bookId}:${chapterId}:${sceneId}`,
                `animastor:iu-progress:${bookId}:${chapterId}:${sceneId}:image`,
            );
            const scenePrefix = `${bookId}_${chapterId}_${sceneId}`;
            out.chunks += await deleteSceneChunks(bookId, chapterId, sceneId);
            await scanAndDel(`animastor:iu-registry:${scenePrefix}_*`);
            await scanAndDel(`animastor:iu-in-flight:${scenePrefix}_*`);
            await scanAndDel(`animastor:job:${scenePrefix}_*`);
            await scanAndDel(`animastor:result:${scenePrefix}_*`);
            await scanAndDel(`animastor:result-processed:${scenePrefix}_*`);
            await scanAndDel(`animastor:dispatch-lease:${bookId}:${chapterId}:${sceneId}:*`);
            await scanAndDel(`animastor:dispatch-meta:${bookId}:${chapterId}:${sceneId}:*`);
            await scanAndDel(`animastor:runtime:retry:${bookId}:${chapterId}:${sceneId}:*`);
        } catch (err) {
            console.warn(`[ENTITY-CLEANUP] Redis cleanup failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
        }

        // 4. Active index — reuse the scheduler helper.
        try {
            if (scheduler && typeof scheduler.removeSceneFromActiveIndex === 'function') {
                await scheduler.removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId);
            } else {
                await redis.srem('animastor:active-scenes', `${bookId}:${chapterId}:${sceneId}`);
            }
        } catch (err) {
            console.warn(`[ENTITY-CLEANUP] active-index removal failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
        }

        // 5. Filesystem.
        try {
            out.files_deleted = deleteSceneFiles(bookId, chapterId, sceneId);
        } catch (err) {
            console.warn(`[ENTITY-CLEANUP] FS cleanup failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
        }

        log(`[ENTITY-CLEANUP] scene ${bookId}/${chapterId}/${sceneId} purged ` +
            `(pg=${JSON.stringify(out.pg)}, chunks=${out.chunks}, files=${out.files_deleted})`);
        return out;
    }

    // ── Unit (module) purge ───────────────────────────
    async function purgeUnit(bookId, chapterId, sceneId, unitId) {
        const out = { pg: {}, files_deleted: 0 };
        const imageIUId = `${bookId}_${chapterId}_${sceneId}_${unitId}`;

        // 1. PostgreSQL — the unit's image_units row + any dirty marker left on
        //    the parent scene row.
        try {
            const r1 = await storage.postgres.query(
                `DELETE FROM image_units
                 WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND unit_id = $4`,
                [bookId, chapterId, sceneId, unitId],
            );
            out.pg.image_units = r1.rowCount || 0;
            const r2 = await storage.postgres.query(
                `UPDATE scenes
                 SET dirty_unit_ids = array_remove(dirty_unit_ids, $4)
                 WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3`,
                [bookId, chapterId, sceneId, unitId],
            );
            out.pg.scenes_updated = r2.rowCount || 0;
        } catch (err) {
            console.warn(`[ENTITY-CLEANUP] PG purge failed for ${imageIUId}: ${err.message}`);
        }

        // 2. Redis — iu registry, in-flight marker, GPU hub dedup keys.
        try {
            await delKeys(
                `animastor:iu-registry:${imageIUId}`,
                `animastor:iu-in-flight:${imageIUId}`,
                `animastor:job:${imageIUId}:iu_image`,
                `animastor:job:${imageIUId}:image`,
            );
            await scanAndDel(`animastor:result-processed:${imageIUId}:*`);
        } catch (err) {
            console.warn(`[ENTITY-CLEANUP] Redis cleanup failed for ${imageIUId}: ${err.message}`);
        }

        // 3. Filesystem — IU image + preview PNG.
        try {
            out.files_deleted = deleteUnitFiles(bookId, chapterId, sceneId, unitId);
        } catch (err) {
            console.warn(`[ENTITY-CLEANUP] FS cleanup failed for ${imageIUId}: ${err.message}`);
        }

        log(`[ENTITY-CLEANUP] unit ${imageIUId} purged (pg=${JSON.stringify(out.pg)}, files=${out.files_deleted})`);
        return out;
    }

    return { purgeScene, purgeUnit };
};