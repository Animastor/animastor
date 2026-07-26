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
// ARCHITECTURE (F15):
// - Worker existence is determined GLOBALLY (all chunks) so that ALL workers
//   are shown regardless of scope — this enables parallel progress display.
// - x/y numbers are computed PER-SCOPE (scope/chapter_id/scene_id query params)
//   so that progress accurately reflects the selected range.
// - If no scope is provided, all data is used (backward compatible).

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

            // ── 2. Read ALL chunk metadata ──
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

            // ── 3. Filter by scope (for x/y accuracy) ──
            let filteredIds = allChunkIds;
            if ((scope === 'current_chapter' || scope === 'chapter') && chapter_id) {
                filteredIds = allChunkIds.filter(cid => chunkById.get(cid)?.chapter_id === chapter_id);
            } else if ((scope === 'current_scene' || scope === 'scene') && chapter_id && scene_id) {
                filteredIds = allChunkIds.filter(cid => {
                    const c = chunkById.get(cid);
                    return c?.chapter_id === chapter_id && c?.scene_id === scene_id;
                });
            }

            // ── 4. Count GLOBAL (unfiltered) data for worker EXISTENCE ──
            // We need BOTH global and per-scope counts:
            //   - Global: decide which workers SHOW (has any work anywhere)
            //   - Per-scope: compute x/y numbers (accuracy for selected range)
            let globalAudioExpectedTotal = 0;
            let globalUniqueSceneCount = 0;
            const globalSceneKeys = new Set();

            // Per-scope counts (for x/y)
            let audioReadyReal = 0;
            const audioSceneExpected = new Map();
            let videoReadyScenesCount = 0;
            const videoReadySceneKeys = new Set();
            let imageReadySceneCount = 0;
            const imageReadySceneKeys = new Set();

            // First pass: gather global scene keys (from ALL chunks)
            for (const cid of allChunkIds) {
                const chunk = chunkById.get(cid);
                if (!chunk) continue;
                if (chunk.chapter_id && chunk.scene_id) {
                    globalSceneKeys.add(`${chunk.chapter_id}:${chunk.scene_id}`);
                }
                // Global expected_count for audio existence
                if (chunk.chapter_id && chunk.scene_id && chunk.expected_chunk_count != null) {
                    const expected = parseInt(chunk.expected_chunk_count, 10);
                    if (!isNaN(expected) && expected > 0) {
                        globalAudioExpectedTotal += expected;
                    }
                }
            }
            globalUniqueSceneCount = globalSceneKeys.size;

            // Second pass: per-scope counts for x/y (from filteredIds)
            for (const cid of filteredIds) {
                const chunk = chunkById.get(cid);
                if (!chunk) continue;
                if (chunk.audio_status === 'ready') audioReadyReal++;

                if (chunk.image_status === 'ready' && chunk.chapter_id && chunk.scene_id) {
                    imageReadySceneKeys.add(`${chunk.chapter_id}:${chunk.scene_id}`);
                }
                if (chunk.video_status === 'ready' && chunk.chapter_id && chunk.scene_id) {
                    videoReadySceneKeys.add(`${chunk.chapter_id}:${chunk.scene_id}`);
                }

                // expected_count per unique scene (per-scope)
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
            const scopeUniqueSceneCount = (new Set(filteredIds.map(cid => {
                const c = chunkById.get(cid);
                return c?.chapter_id && c?.scene_id ? `${c.chapter_id}:${c.scene_id}` : null;
            }).filter(Boolean))).size;

            videoReadyScenesCount = videoReadySceneKeys.size;
            imageReadySceneCount = imageReadySceneKeys.size;

            // ── 5. IU counts (for image worker, per-scope) ──
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
                    // Count IUs for scenes IN FILTERED SCOPE only (for x/y accuracy)
                    const scopeSceneKeys = new Set();
                    for (const cid of filteredIds) {
                        const chunk = chunkById.get(cid);
                        if (chunk?.chapter_id && chunk?.scene_id) {
                            scopeSceneKeys.add(`${chunk.chapter_id}:${chunk.scene_id}`);
                        }
                    }

                    for (const sceneKey of scopeSceneKeys) {
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
            const imgDenominator = useIu ? scopeIuTotal : scopeUniqueSceneCount;
            const imgNumerator = useIu ? scopeIuReady : imageReadySceneCount;

            // ── 5.5. Read cancelled worker types ──
            const cancelledWorkersKey = `animastor:cancelled-workers:${bookId}`;
            const cancelledTypes = new Set(await redis.smembers(cancelledWorkersKey) || []);

            // ── 6. Build worker entries ──
            // IMPORTANT: Worker EXISTENCE is based on GLOBAL data (all scenes),
            // but x/y numbers are computed PER-SCOPE (from filteredIds).
            // This ensures all workers are visible regardless of scope.
            const workers = [];

            // Cover worker (only if cover has IUs, already per-scope from IU computation)
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

            // Audio worker: existence = globalAudioExpectedTotal > 0
            // x/y = per-scope audioReadyReal vs audioExpectedTotal
            if (layers.audio && globalAudioExpectedTotal > 0) {
                const audioTotal = audioExpectedTotal > 0 ? audioExpectedTotal : globalAudioExpectedTotal;
                const audioDone = audioTotal > 0 && audioReadyReal >= audioTotal;
                workers.push({
                    type: 'audio',
                    ready: audioReadyReal,
                    total: audioTotal,
                    percent: Math.round(audioDone ? 100 : (audioReadyReal * 100 / Math.max(1, audioTotal))),
                    done: audioDone,
                    visible: true,
                    indeterminate: false,
                    cancelled: cancelledTypes.has('audio'),
                });
            }

            // Image worker: existence = IU data exists OR global scene count > 0
            // x/y = per-scope IU counts or per-scope scene counts
            if (layers.image && (useIu || globalUniqueSceneCount > 0)) {
                const imgDone = imgNumerator >= imgDenominator && imgDenominator > 0;
                workers.push({
                    type: 'image',
                    ready: imgNumerator,
                    total: imgDenominator,
                    percent: Math.round(imgDone ? 100 : (imgNumerator * 100 / Math.max(1, imgDenominator))),
                    done: imgDone,
                    visible: true,
                    indeterminate: useIu && imgDenominator === 0,
                    cancelled: cancelledTypes.has('image'),
                });
            }

            // Video worker: existence = globalUniqueSceneCount > 0
            // x/y = per-scope videoReadyScenesCount vs scopeUniqueSceneCount
            if (layers.video && globalUniqueSceneCount > 0) {
                const videoDenominator = scopeUniqueSceneCount > 0 ? scopeUniqueSceneCount : globalUniqueSceneCount;
                const videoDone = videoDenominator > 0 && videoReadyScenesCount >= videoDenominator;
                workers.push({
                    type: 'video',
                    ready: videoReadyScenesCount,
                    total: videoDenominator,
                    percent: Math.round(videoDone ? 100 : (videoReadyScenesCount * 100 / Math.max(1, videoDenominator))),
                    done: videoDone,
                    visible: true,
                    indeterminate: false,
                    cancelled: cancelledTypes.has('video'),
                });
            }

            // ── 7. Overall aggregates ──
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
