// ======================================================
// Book Chunks Routes — GET chunks, GET assets-state
// ======================================================

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

    // ======================================================
    // BOOK CHUNKS (playback queue)
    // ======================================================
    app.get('/api/v1/book/:bookId/chunks', async (req, res) => {
        const allIds = await getAllChunks(req.params.bookId);
        const windowStatus = await getBookWindowStatus(req.params.bookId);

        // Build chunk_positions map + find cover_chunk_id in one pass so the
        // client never needs N individual getChunkStoryboard calls (F9 audit).
        let coverChunkId = null;
        const chunkPositions = {};

        // Deduplicate: the playback queue needs exactly one entry per scene.
        // TTS pipeline may create multiple chunks per scene (_0001, _0002, _0003)
        // for long text segments — they all serve the same merged audio file.
        // Keep only the first chunk (lowest chunk_index) per (chapter_id, scene_id).
        const dedupedIds = [];
        const seenScenes = new Set();

        if (allIds.length > 0) {
            try {
                const keys = allIds.map(id => `animastor:chunk:${id}`);
                const raw = await redis.mget(keys);
                for (let i = 0; i < allIds.length; i++) {
                    if (!raw[i]) {
                        // Chunk without metadata — keep it (defensive)
                        if (!seenScenes.has('__unknown__')) {
                            seenScenes.add('__unknown__');
                            dedupedIds.push(allIds[i]);
                        }
                        continue;
                    }
                    try {
                        const c = JSON.parse(raw[i]);
                        const sceneKey = `${c.chapter_id || ''}:${c.scene_id || ''}`;

                        chunkPositions[allIds[i]] = {
                            chapter_id: c.chapter_id || null,
                            scene_id: c.scene_id || null,
                        };
                        if (c.scene_type === 'cover') {
                            coverChunkId = allIds[i];
                        }

                        // Only add to deduped list if this scene hasn't been seen yet
                        if (!seenScenes.has(sceneKey)) {
                            seenScenes.add(sceneKey);
                            dedupedIds.push(allIds[i]);
                        }
                    } catch (_) {}
                }
            } catch (err) {
                console.warn('[CHUNKS] Failed to load chunk metadata:', err.message);
                // Fallback: return all IDs (no dedup)
                dedupedIds.push(...allIds);
            }
        }

        res.json({
            chunk_ids: dedupedIds,
            total: dedupedIds.length,
            cover_chunk_id: coverChunkId,
            chunk_positions: chunkPositions,
            ...windowStatus
        });
    });

    // ======================================================
    // ASSETS STATE
    // ======================================================
    app.get('/api/v1/book/:bookId/assets-state', async (req, res) => {
        try {
            const { bookId } = req.params;
            const { scope, chapter_id, scene_id } = req.query;

            const allChunkIds = await getAllChunks(bookId);
            const totalChunks = allChunkIds.length;

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

            let audioReady = 0, audioReadyReal = 0, imageReady = 0, videoReady = 0;
            let audioError = 0, imageError = 0, videoError = 0;
            let hasAudio = false, hasImage = false, hasVideo = false;

            const isErr = (s) => s === 'error' || s === 'failed';
            for (const cid of filteredIds) {
                const chunk = chunkById.get(cid);
                if (!chunk) continue;
                if (chunk.audio_status === 'ready' || chunk.audio_status === 'placeholder') {
                    audioReady++; hasAudio = true;
                    if (chunk.audio_status === 'ready') audioReadyReal++;
                } else if (isErr(chunk.audio_status)) { audioError++; }
                if (chunk.image_status === 'ready') { imageReady++; hasImage = true; }
                else if (isErr(chunk.image_status)) { imageError++; }
                if (chunk.video_status === 'ready') { videoReady++; hasVideo = true; }
                else if (isErr(chunk.video_status)) { videoError++; }
            }

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

                    const layerCfg = await layerConfig.get(redis, bookId);
                    const imagesEnabled = layerCfg?.image_enabled !== false;
                    if (imagesEnabled) {
                        const coverCh = book.loadBook(bookId)?.chapters?.find(ch => ch.type === 'cover');
                        if (coverCh && coverCh.scenes && coverCh.scenes.length > 0) {
                            const coverScene = coverCh.scenes[0];
                            // chapter_id for modern lazy-book chapters, `chapter`
                            // for legacy parse.js chapters (see generation-routes.cjs).
                            const coverChapterId = coverCh.chapter_id ?? coverCh.chapter;
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

            res.json({
                book_id: bookId, scope: scope || 'book', total_chunks: totalChunks,
                audio_ready: audioReady, audio_ready_real: audioReadyReal,
                image_ready: imageReady, video_ready: videoReady,
                has_audio: hasAudio, has_image: hasImage, has_video: hasVideo,
                all_audio_ready: audioReadyReal === filteredIds.length && filteredIds.length > 0,
                all_image_ready: imageReady === filteredIds.length && filteredIds.length > 0,
                all_video_ready: videoReady === filteredIds.length && filteredIds.length > 0,
                has_assets: audioReady > 0 || imageReady > 0 || videoReady > 0,
                scope_total: filteredIds.length,
                scope_audio_ready: audioReady, scope_audio_ready_real: audioReadyReal,
                scope_image_ready: imageReady, scope_video_ready: videoReady,
                scope_all_audio_ready: audioReadyReal === filteredIds.length && filteredIds.length > 0,
                scope_all_image_ready: imageReady === filteredIds.length && filteredIds.length > 0,
                scope_all_video_ready: videoReady === filteredIds.length && filteredIds.length > 0,
                scope_iu_total: scopeIuTotal, scope_iu_ready: scopeIuReady,
                cover_iu_total: coverIuTotal, cover_iu_ready: coverIuReady,
                audio_error: audioError, image_error: imageError, video_error: videoError,
            });
        } catch (err) {
            console.error('[ASSETS-STATE] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
};
