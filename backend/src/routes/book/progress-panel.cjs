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
// Everything else — which layers are visible for the profile or active state,
// ready/total/percent/done, IU vs legacy image counting,
// cover relevance — is computed here.
//
// ARCHITECTURE (F15):
// - Worker existence combines the current profile with canonical per-asset
//   PENDING/GENERATING state. Starting Image must not hide active Audio merely
//   because the book-wide profile changed to image_only.
// - x/y numbers are computed PER-SCOPE (scope/chapter_id/scene_id query params)
//   so that progress accurately reflects the selected range.
// - If no scope is provided, all data is used (backward compatible).

const path = require('path');
const fs = require('fs');
const sceneAssetsRepo = require('../../storage/postgres/repositories/scene-assets-repo');
const { computeIuReady } = require('./iu-progress-utils.cjs');
const generationProgress = require('../../services/generation-progress');

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

            // The layer config reflects the latest request only. Parallel work
            // already queued or running is represented by per-asset state and
            // must stay visible independently of that latest profile.
            const activeWorkerTypes = new Set();
            try {
                const activeKeys = await activeScenes.getAllActiveSceneKeys(redis);
                for (const key of activeKeys) {
                    const parsed = activeScenes.parseSceneKey(key);
                    if (!parsed || parsed.bookId !== bookId) continue;
                    const states = await state.getAssetStates(
                        redis,
                        parsed.bookId,
                        parsed.chapterId,
                        parsed.sceneId
                    );
                    for (const type of ['audio', 'image', 'video']) {
                        if (states?.[type] === 'pending' || states?.[type] === 'generating') {
                            activeWorkerTypes.add(type);
                        }
                    }
                }
            } catch (activeErr) {
                console.warn(`[PROGRESS-PANEL] Active state lookup failed for ${bookId}: ${activeErr.message}`);
            }

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

            // ── 3. Resolve scope independently for each worker type ──
            const storedScopes = await generationProgress.getScopes(redis, bookId);
            const fallbackScope = {
                scope: scope || 'whole_book',
                chapter_id: chapter_id || null,
                scene_id: scene_id || null,
            };

            function filterIdsForScope(workerScope) {
                const selected = workerScope || fallbackScope;
                if ((selected.scope === 'current_chapter' || selected.scope === 'chapter') && selected.chapter_id) {
                    return allChunkIds.filter(cid =>
                        chunkById.get(cid)?.chapter_id === selected.chapter_id
                    );
                }
                if ((selected.scope === 'current_scene' || selected.scope === 'scene') &&
                    selected.chapter_id && selected.scene_id) {
                    return allChunkIds.filter(cid => {
                        const c = chunkById.get(cid);
                        return c?.chapter_id === selected.chapter_id && c?.scene_id === selected.scene_id;
                    });
                }
                return allChunkIds;
            }

            const audioIds = filterIdsForScope(storedScopes.audio);
            const imageIds = filterIdsForScope(storedScopes.image);
            const videoIds = filterIdsForScope(storedScopes.video);

            function uniqueSceneCount(ids) {
                return new Set(ids.map(cid => {
                    const c = chunkById.get(cid);
                    return c?.chapter_id && c?.scene_id ? `${c.chapter_id}:${c.scene_id}` : null;
                }).filter(Boolean)).size;
            }

            // ── 4. Count GLOBAL (unfiltered) data for worker EXISTENCE ──
            // We need BOTH global and per-scope counts:
            //   - Global: decide which workers SHOW (has any work anywhere)
            //   - Per-scope: compute x/y numbers (accuracy for selected range)
            const globalAudioSceneExpected = new Map();
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
                // Global expected_count for audio existence. Keep one maximum
                // per scene because every chunk may carry the same expected count.
                if (chunk.chapter_id && chunk.scene_id && chunk.expected_chunk_count != null) {
                    const sceneKey = `${chunk.chapter_id}:${chunk.scene_id}`;
                    const expected = parseInt(chunk.expected_chunk_count, 10);
                    if (!isNaN(expected) && expected > 0) {
                        const current = globalAudioSceneExpected.get(sceneKey) || 0;
                        if (expected > current) {
                            globalAudioSceneExpected.set(sceneKey, expected);
                        }
                    }
                }
            }
            globalUniqueSceneCount = globalSceneKeys.size;
            const globalAudioExpectedTotal = [...globalAudioSceneExpected.values()]
                .reduce((a, b) => a + b, 0);

            // Second pass: Audio counts use the Audio request's original scope.
            for (const cid of audioIds) {
                const chunk = chunkById.get(cid);
                if (!chunk) continue;
                if (chunk.audio_status === 'ready') audioReadyReal++;

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

            for (const cid of imageIds) {
                const chunk = chunkById.get(cid);
                if (chunk?.image_status === 'ready' && chunk.chapter_id && chunk.scene_id) {
                    imageReadySceneKeys.add(`${chunk.chapter_id}:${chunk.scene_id}`);
                }
            }
            for (const cid of videoIds) {
                const chunk = chunkById.get(cid);
                if (chunk?.video_status === 'ready' && chunk.chapter_id && chunk.scene_id) {
                    videoReadySceneKeys.add(`${chunk.chapter_id}:${chunk.scene_id}`);
                }
            }

            const audioExpectedTotal = [...audioSceneExpected.values()].reduce((a, b) => a + b, 0);
            const imageScopeSceneCount = uniqueSceneCount(imageIds);
            const videoScopeSceneCount = uniqueSceneCount(videoIds);

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
                    for (const cid of imageIds) {
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
            const imgDenominator = useIu ? scopeIuTotal : imageScopeSceneCount;
            const imgNumerator = useIu ? scopeIuReady : imageReadySceneCount;

            // ── 5.5. Read cancelled worker types ──
            const cancelledWorkersKey = `animastor:cancelled-workers:${bookId}`;
            const cancelledTypes = new Set(await redis.smembers(cancelledWorkersKey) || []);

            // ── 6. Build worker entries ──
            // IMPORTANT: Worker existence combines profile + active state, while
            // x/y numbers use the scope stored for each individual worker type.
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
            if ((layers.audio || activeWorkerTypes.has('audio')) && globalAudioExpectedTotal > 0) {
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
            if ((layers.image || activeWorkerTypes.has('image')) && (useIu || globalUniqueSceneCount > 0)) {
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
            // x/y = per-scope videoReadyScenesCount vs videoScopeSceneCount
            if ((layers.video || activeWorkerTypes.has('video')) && globalUniqueSceneCount > 0) {
                const videoDenominator = videoScopeSceneCount > 0 ? videoScopeSceneCount : globalUniqueSceneCount;
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
