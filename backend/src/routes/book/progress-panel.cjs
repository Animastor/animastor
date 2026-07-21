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
            const { scope, chapter_id, scene_id } = req.query;

            // ── 1. Read layer config (profile) ──
            const cfg = await layerConfig.get(redis, bookId);
            const profile = layerConfig.resolveProfile(cfg);
            const layers = layersForProfile(profile);

            // ── 2. Read all chunk metadata ──
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

            let filteredIds = allChunkIds;
            if ((scope === 'current_chapter' || scope === 'chapter') && chapter_id) {
                filteredIds = allChunkIds.filter(cid => chunkById.get(cid)?.chapter_id === chapter_id);
            } else if ((scope === 'current_scene' || scope === 'scene') && chapter_id && scene_id) {
                filteredIds = allChunkIds.filter(cid => {
                    const c = chunkById.get(cid);
                    return c?.chapter_id === chapter_id && c?.scene_id === scene_id;
                });
            }

            // ── 3. Count ready chunks per layer ──
            // Each worker shows honest progress based on its own work units:
            //   - Audio: expected_count-based total. Each scene stores its expected
            //     chunk count once at dispatch time. Total = sum(expected_count)
            //     across unique scenes, so total grows only when a NEW scene
            //     appears (e.g. +5 at once), not on every individual chunk.
            //     This prevents the old jitter (25 → 30 → 34 per chunk dispatch).
            //   - Image: IU images (individual image generation tasks).
            //   - Video: scenes (one video per scene).
            // Each worker has its own total — this is fine, they are separate rows.
            let audioReady = 0, audioReadyReal = 0, imageReady = 0, videoReady = 0;
            const audioSceneExpected = new Map(); // "ch:sc" -> expected_count (stable per scene)

            for (const cid of filteredIds) {
                const chunk = chunkById.get(cid);
                if (!chunk) continue;
                if (chunk.audio_status === 'ready' || chunk.audio_status === 'placeholder') {
                    audioReady++;
                    if (chunk.audio_status === 'ready') audioReadyReal++;
                }
                if (chunk.image_status === 'ready') imageReady++;
                if (chunk.video_status === 'ready') videoReady++;

                // expected_count per unique scene — set once at dispatch, never changes
                if (chunk.chapter_id && chunk.scene_id && chunk.expected_chunk_count != null) {
                    const sceneKey = `${chunk.chapter_id}:${chunk.scene_id}`;
                    if (!audioSceneExpected.has(sceneKey)) {
                        const expected = parseInt(chunk.expected_chunk_count, 10);
                        if (!isNaN(expected) && expected > 0) {
                            audioSceneExpected.set(sceneKey, expected);
                        }
                    }
                }
            }

            const audioExpectedTotal = [...audioSceneExpected.values()].reduce((a, b) => a + b, 0);
            const scopeTotal = filteredIds.length;

            // ── 4. IU counts (for image worker) ──
            let scopeIuTotal = 0, scopeIuReady = 0, coverIuTotal = 0, coverIuReady = 0;
            try {
                let buildId = chunkById.get(filteredIds[0])?.build_id;
                if (!buildId) {
                    for (const cid of allChunkIds) {
                        const b = chunkById.get(cid)?.build_id;
                        if (b) { buildId = b; break; }
                    }
                }

                if (buildId) {
                    const uniqueScenes = new Map();
                    for (const cid of filteredIds) {
                        const chunk = chunkById.get(cid);
                        if (chunk?.chapter_id && chunk?.scene_id) {
                            uniqueScenes.set(`${chunk.chapter_id}:${chunk.scene_id}`, {
                                chapter_id: chunk.chapter_id, scene_id: chunk.scene_id,
                            });
                        }
                    }

                    for (const { chapter_id: ch, scene_id: sc } of uniqueScenes.values()) {
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
                });
            }

            // Image worker
            if (layers.image && scopeTotal > 0) {
                const imgTotal = useIu ? scopeIuTotal : scopeTotal;
                const imgReady = useIu ? scopeIuReady : imageReady;
                const imgDone = imgReady >= imgTotal && imgTotal > 0;
                workers.push({
                    type: 'image',
                    ready: imgReady,
                    total: imgTotal,
                    percent: Math.round(imgDone ? 100 : (imgReady * 100 / Math.max(1, imgTotal))),
                    done: imgDone,
                    visible: true,
                    indeterminate: useIu && imgTotal === 0,
                });
            }

            // Video worker
            if (layers.video && scopeTotal > 0) {
                const videoDone = videoReady === scopeTotal;
                workers.push({
                    type: 'video',
                    ready: videoReady,
                    total: scopeTotal,
                    percent: Math.round(videoDone ? 100 : (videoReady * 100 / scopeTotal)),
                    done: videoDone,
                    visible: true,
                    indeterminate: false,
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
