// ======================================================
// Progress Panel Route — pre-computed worker list for UI
// ======================================================
// Returns a ready-to-render worker list so the frontend never
// re-derives layer visibility, percent, or done from raw counters.
//
// The frontend keeps only:
//   1. 10s "Done" row timing       (COMPLETED_WORKER_DISPLAY_MS)
//   2. Monotonic floor per worker  (workerReadyFloor)
//   3. VBook COMPLETED → IDLE transition
//   4. Hidden/DoneRow/Workers state machine
//
// Everything else — which layers are visible for the profile,
// ready/total/percent/done, IU vs legacy image counting,
// cover relevance — is computed here.
//
// IMPORTANT (F15): Scope/chapter_id/scene_id query params are IGNORED.
// The panel always shows ALL workers across ALL scenes so that parallel
// workers started with different scopes are visible simultaneously.
// x/y numbers for each worker are derived from actual dispatched work
// (expected_chunk_count for audio, IU counts for image, unique scenes
// for video), NOT from the total number of chunks in a scope.

const path = require('path');
const fs = require('fs');
const sceneAssetsRepo = require('../../storage/postgres/repositories/scene-assets-repo');
const { computeIuReady } = require('./iu-progress-utils.cjs');

module.exports = function(app, redis, deps) {
    const {
        config, state, audio, image, video, book, orchestrator, storage,
        txtImporter, lazyBook, genSessionRepo, bookSourceRepo,
        placeholderAudio, layerConfig, genScope, activeScenes,
        utils, saveChunk, getChunk, getAllChunks, getBookWindowStatus,
        detectAvailableMode, recoverChunksFromDisk, recoverAllBooksFromDisk,
        cleanupService, bookDiff, taskHandler, windowGenerator,
        iuRepo, cleanBookRedisKeys,
    } = deps;
    const { log } = utils;

    // ── Reusable helper: which layers are visible for a profile ──
    function layersForProfile(profile) {
        const audio = profile === 'audio_only' || profile === 'storyboard' || profile === 'full';
        const image = profile === 'image_only' || profile === 'storyboard' || profile === 'full';
        const video = profile === 'full' || profile === 'video_only';
        return { audio, image, video };
    }

    // ======================================================
    // PROGRESS PANEL
    // ======================================================
    app.get('/api/v1/book/:bookId/progress-panel', async (req, res) => {
        try {
            const { bookId } = req.params;

            // ── 1. Read layer config (profile) ──
            const cfg = await layerConfig.get(redis, bookId);
            const profile = layerConfig.resolveProfile(cfg);
            const layers = layersForProfile(profile);

            // ── 2. Read ALL chunk metadata (no scope filtering) ──
            const allChunkIds = await getAllChunks(bookId);

            const chunkById = new Map();
            if (allChunkIds.length > 0) {
                try {
                    const raw = await redis.mget(allChunkIds.map(id => `animastor:chunk:${id}`));
                    for (let i = 0; i < allChunkIds.length; i++) {
                        if (!raw[i]) continue;
                        try {
                            const c = JSON.parse(raw[i]);
                            if (!c.audio_status) c.audio_status = 'pending';
                            if (!c.image_status) c.image_status = c.image ? 'ready' : 'pending';
                            if (!c.video_status) c.video_status = 'pending';
                            chunkById.set(allChunkIds[i], c);
                        } catch (_) {}
                    }
                } catch (mgetErr) {
                    for (const cid of allChunkIds) {
                        try { const c = await getChunk(cid); if (c) chunkById.set(cid, c); } catch (_) {}
                    }
                }
            }

            // ── 3. Count ready chunks per layer ──
            // Each worker shows honest progress based on its own work units:
            //   - Audio: expected_count-based total. Each scene stores its expected
            //     chunk count once at dispatch time. Total = sum(expected_count)
            //     across unique scenes, so total grows only when a NEW scene
            //     appears (e.g. +5 at once), not on every individual chunk.
            //     This prevents the old jitter (25 → 30 → 34 per chunk dispatch).
            //   - Image: IU images (individual image generation tasks) or scenes with image chunks.
            //   - Video: unique scenes with chunks (one video per scene).
            // Each worker has its own total — this is fine, they are separate rows.
            let audioReady = 0, audioReadyReal = 0;
            const audioSceneExpected = new Map(); // "ch:sc" -> expected_count (stable per scene)
            const uniqueSceneKeys = new Set();     // "ch:sc" for all scenes with dispatch
            const videoReadyScenes = new Set();    // "ch:sc" for scenes with at least one ready video chunk
            const imageReadyScenes = new Set();    // "ch:sc" for scenes with at least one ready image chunk

            for (const cid of allChunkIds) {
                const chunk = chunkById.get(cid);
                if (!chunk) continue;
                if (chunk.audio_status === 'ready' || chunk.audio_status === 'placeholder') {
                    audioReady++;
                    if (chunk.audio_status === 'ready') audioReadyReal++;
                }
                if (chunk.image_status === 'ready') {
                    if (chunk.chapter_id && chunk.scene_id) {
                        imageReadyScenes.add(`${chunk.chapter_id}:${chunk.scene_id}`);
                    }
                }
                if (chunk.video_status === 'ready') {
                    if (chunk.chapter_id && chunk.scene_id) {
                        videoReadyScenes.add(`${chunk.chapter_id}:${chunk.scene_id}`);
                    }
                }

                // Track unique scenes for video/fallback denominators
                if (chunk.chapter_id && chunk.scene_id) {
                    uniqueSceneKeys.add(`${chunk.chapter_id}:${chunk.scene_id}`);
                }

                // expected_count per unique scene — take the MAX across all chunks
                // for this scene, because import may create chunks with expected=1 and
                // startScene updates them to the true segment count later. Taking the
                // first chunk may pick up the stale import value, causing "9/3" display.
                if (chunk.chapter_id && chunk.scene_id && chunk.expected_chunk_count != null) {
                    const sceneKey = `${chunk.chapter_id}:${chunk.scene_id}`;
                    const expected = parseInt(chunk.expected_chunk_count, 10);
                    if (!isNaN(expected) && expected > 0) {
                        const current = audioSceneExpected.get(sceneKey) || 0;
                        if (expected > current) {
                            audioSceneExpected.set(sceneKey, expected);
                        }
                    }
                }
            }

            const audioExpectedTotal = [...audioSceneExpected.values()].reduce((a, b) => a + b, 0);
            const uniqueSceneCount = uniqueSceneKeys.size;
            const videoReadyCount = videoReadyScenes.size;
            const imageReadySceneCount = imageReadyScenes.size;

            // ── 4. IU counts (for image worker) ──
            let scopeIuTotal = 0, scopeIuReady = 0, coverIuTotal = 0, coverIuReady = 0;
            try {
                let buildId = chunkById.get(allChunkIds[0])?.build_id;
                if (!buildId) {
                    for (const cid of allChunkIds) {
                        const b = chunkById.get(cid)?.build_id;
                        if (b) { buildId = b; break; }
                    }
                }

                if (buildId) {
                    // Count IUs for ALL scenes (not filtered by scope)
                    for (const sceneKey of uniqueSceneKeys) {
                        const [ch, sc] = sceneKey.split(':');
                        const rows = await iuRepo.getImageUnitsForScene(buildId, bookId, ch, sc);
                        if (rows.length > 0) {
                            scopeIuTotal += rows.length;
                            scopeIuReady += await computeIuReady(redis, sceneAssetsRepo, bookId, ch, sc, rows.length);
                        }
                    }

                    const imagesEnabled = cfg?.image_enabled !== false;
                    if (imagesEnabled) {
                        const coverCh = book.loadBook(bookId)?.chapters?.find(ch => ch.type === 'cover');
                        if (coverCh && coverCh.scenes && coverCh.scenes.length > 0) {
                            const coverScene = coverCh.scenes[0];
                            const coverChapterId = coverCh.chapter;
                            const coverSceneId = coverScene.scene_id;
                            const rows = await iuRepo.getImageUnitsForScene(buildId, bookId, coverChapterId, coverSceneId);
                            if (rows.length > 0) {
                                coverIuTotal = rows.length;
                                coverIuReady = await computeIuReady(redis, sceneAssetsRepo, bookId, coverChapterId, coverSceneId, rows.length);
                            } else {
                                const allUnits = [...(coverScene.units || [])];
                                for (const db of (coverScene.dialogue_blocks || [])) {
                                    if (db.units) allUnits.push(...db.units);
                                }
                                coverIuTotal = allUnits.length;
                                if (coverIuTotal > 0) {
                                    coverIuReady = await computeIuReady(redis, sceneAssetsRepo, bookId, coverChapterId, coverSceneId, allUnits.length);
                                }
                            }

                            if (coverIuReady < coverIuTotal && buildId) {
                                try {
                                    const buildDir = path.join(config.OUTPUT_DIR, buildId);
                                    if (fs.existsSync(buildDir)) {
                                        const iuPrefix = `${bookId}_${coverChapterId}_${coverSceneId}_iu`;
                                        const pngFiles = fs.readdirSync(buildDir).filter(f => f.startsWith(iuPrefix) && f.endsWith('.png'));
                                        if (pngFiles.length >= coverIuTotal) coverIuReady = coverIuTotal;
                                    }
                                } catch (_) {}
                            }
                        }
                    }
                }
            } catch (_) {}

            const useIu = scopeIuTotal > 0;

            // ── 4.5. Read cancelled worker types ──
            const cancelledWorkersKey = `animastor:cancelled-workers:${bookId}`;
            const cancelledTypes = new Set(await redis.smembers(cancelledWorkersKey) || []);

            // ── 5. Build worker entries ──
            const workers = [];

            // Cover worker (only if cover has IUs)
            if (coverIuTotal > 0) {
                const covDone = coverIuReady >= coverIuTotal;
                workers.push({
                    type: 'cover',
                    ready: coverIuReady,
                    total: coverIuTotal,
                    percent: Math.round(covDone ? 100 : (coverIuReady * 100 / coverIuTotal)),
                    done: covDone,
                    visible: true,
                    indeterminate: false,
                    cancelled: cancelledTypes.has('cover'),
                });
            }

            // Audio worker (expected_count-based, not chunk-count-based)
            if (layers.audio && audioExpectedTotal > 0) {
                const audioDone = audioReadyReal >= audioExpectedTotal;
                workers.push({
                    type: 'audio',
                    ready: audioReadyReal,
                    total: audioExpectedTotal,
                    percent: Math.round(audioDone ? 100 : (audioReadyReal * 100 / audioExpectedTotal)),
                    done: audioDone,
                    visible: true,
                    indeterminate: false,
                    cancelled: cancelledTypes.has('audio'),
                });
            }

            // Image worker (uses IU counts when available, otherwise scenes-with-image-chunks)
            if (layers.image && uniqueSceneCount > 0) {
                const imgTotal = useIu ? scopeIuTotal : uniqueSceneCount;
                const imgReady = useIu ? scopeIuReady : imageReadySceneCount;
                const imgDone = imgReady >= imgTotal && imgTotal > 0;
                workers.push({
                    type: 'image',
                    ready: imgReady,
                    total: imgTotal,
                    percent: Math.round(imgDone ? 100 : (imgReady * 100 / Math.max(1, imgTotal))),
                    done: imgDone,
                    visible: true,
                    indeterminate: useIu && imgTotal === 0,
                    cancelled: cancelledTypes.has('image'),
                });
            }

            // Video worker (denominator = unique scenes, numerator = scenes with ready video)
            if (layers.video && uniqueSceneCount > 0) {
                const videoDone = videoReadyCount >= uniqueSceneCount;
                workers.push({
                    type: 'video',
                    ready: videoReadyCount,
                    total: uniqueSceneCount,
                    percent: Math.round(videoDone ? 100 : (videoReady * 100 / uniqueSceneCount)),
                    done: videoDone,
                    visible: true,
                    indeterminate: false,
                    cancelled: cancelledTypes.has('video'),
                });
            }

            // ── 6. Overall aggregates ──
            const anyIncomplete = workers.some(w => !w.done && w.visible && w.total > 0);
            const overallPercent = workers.length > 0
                ? Math.round(workers.reduce((s, w) => s + w.percent, 0) / workers.length)
                : 0;

            res.json({
                book_id: bookId,
                profile,
                workers,
                overall_percent: overallPercent,
                any_incomplete: anyIncomplete,
            });
        } catch (err) {
            console.error('[PROGRESS-PANEL] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    log('[ROUTES] Progress panel route loaded');
};
