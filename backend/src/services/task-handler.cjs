// ======================================================
// ANIMASTOR BACKEND — TASK HANDLER
// ======================================================
// GPU task result handling, audio merge, and book snapshot
// management.
//
// Usage:
//   const taskHandler = require('./services/task-handler.cjs')(redis, config, deps);

const path = require('path');
const fs = require('fs');
const { publishProgress } = require('./progress-pubsub.cjs');

module.exports = function(redis, config, deps) {
    const { audio, image, video, state, book, orchestrator, activeScenes, placeholderAudio, cleanupService, utils, bookDiff } = deps;
    const { log, pad, parseChunkId, collectScenes, findSceneRuntimeData } = utils;
    const { resolveAssetPath } = cleanupService;
    const OUTPUT_DIR = config.OUTPUT_DIR;

    // ── Handle GPU task result ────────────────────────
    async function handleTaskResult(job_id, result_base64, build_id) {
        log('🎬 Handling task result:', job_id, 'build:', build_id);

        // Parse job_id to extract identifiers
        const parts = job_id.split(':');
        const assetType = parts.pop(); // 'audio', 'image', or 'video'
        const baseId = parts.join(':');

        // Resolve asset path
        const asset = resolveAssetPath(job_id, build_id);
        if (!asset) {
            console.warn('⚠️ Unknown asset type for job_id:', job_id);
            return;
        }

        log('📁 Resolved asset:', asset.type, '→', asset.fullPath);

        // Save result to filesystem
        const outputDir = path.dirname(asset.fullPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Strip data URL prefix if present (e.g. "data:audio/mp3;base64,")
        const cleanBase64 = result_base64.includes(',')
            ? result_base64.split(',')[1]
            : result_base64;
        const resultBuffer = Buffer.from(cleanBase64, 'base64');
        fs.writeFileSync(asset.fullPath, resultBuffer);
        log('✅ Saved result to disk:', asset.fullPath, `(${resultBuffer.length} bytes)`);

        // Route by asset type
        switch (asset.type) {
            case 'iu_image': {
                // Extract identifiers from baseId
                const baseParts = baseId.split('_');
                if (baseParts.length < 4) {
                    console.warn('⚠️ Invalid IU image job_id format:', job_id);
                    break;
                }
                const iuId = baseParts.pop();
                const sceneId = baseParts.pop();
                const chapterId = baseParts.pop();
                const bookId = baseParts.join('_');

                // Register IU in Redis
                try {
                    await deps.saveIURegistry(iuId, build_id);
                } catch (registryErr) {
                    console.warn('⚠️ Failed to register IU in Redis:', registryErr.message);
                }

                // Increment per-IU progress counter (used by assets-state endpoint
                // instead of filesystem listing, which includes stale PNGs).
                try {
                    const progKey = `animastor:iu-progress:${bookId}:${chapterId}:${sceneId}:image`;
                    const ready = await redis.incr(progKey);
                    await redis.expire(progKey, 14400);
                    // Push an immediate increment to any open SSE stream so the
                    // UI advances without waiting for the next poll tick.
                    await publishProgress(redis, bookId, {
                        layer: 'image', chapterId, sceneId, ready,
                    });
                } catch (progErr) {
                    console.warn(`⚠️ Failed to increment IU progress counter: ${progErr.message}`);
                }

                // Check if all IUs for this scene are complete
                try {
                    const pgRows = await deps.iuRepo.getImageUnitsForScene(build_id, bookId, chapterId, sceneId);
                    const totalIUs = pgRows.length;
                    const iuPrefix = `${bookId}_${chapterId}_${sceneId}_iu`;
                    let iuFiles = [];
                    try {
                        iuFiles = fs.readdirSync(outputDir).filter(f => f.startsWith(iuPrefix) && f.endsWith('.png'));
                    } catch (_) {}
                    log(`📊 IU progress: ${iuFiles.length}/${totalIUs} images for scene ${chapterId}/${sceneId}`);

                    if (iuFiles.length >= totalIUs && totalIUs > 0) {
                        log('🎯 All IUs complete for scene — triggering image completed');
                        await orchestrator.completeStage(redis, bookId, chapterId, sceneId, 'image', build_id);
                    } else if (totalIUs === 0) {
                        log('⚠️ No IUs registered in PG for scene — triggering completion anyway');
                        await orchestrator.completeStage(redis, bookId, chapterId, sceneId, 'image', build_id);
                    }
                } catch (err) {
                    console.error('❌ Failed to check IU completion:', err.message);
                    // If PG is down, try to trigger completion anyway
                    const baseParts2 = baseId.split('_');
                    if (baseParts2.length >= 4) {
                        const iuId2 = baseParts2.pop();
                        const sceneId2 = baseParts2.pop();
                        const chapterId2 = baseParts2.pop();
                        const bookId2 = baseParts2.join('_');
                        log('⚠️ Falling back to trigger image completed despite PG error');
                        await orchestrator.completeStage(redis, bookId2, chapterId2, sceneId2, 'image', build_id);
                    }
                }
                break;
            }

            case 'audio_chunk': {
                // Parse chunk identifiers
                const chunkId = baseId;
                const parsed = parseChunkId(chunkId);
                if (!parsed) {
                    console.warn('⚠️ Invalid chunk ID in job_id:', job_id);
                    break;
                }
                const { bookId, chapterId, sceneId, chunkIndex } = parsed;

                // Update chunk metadata in Redis
                const chunk = await deps.getChunk(chunkId) || {};
                chunk.audio = true;
                chunk.audio_status = 'ready';
                try {
                    await deps.saveChunk(chunkId, {
                        ...chunk,
                        build_id: chunk.build_id || build_id,
                        book_id: chunk.book_id || bookId,
                        chapter_id: chunk.chapter_id || chapterId,
                        scene_id: chunk.scene_id || sceneId,
                        chunk_index: chunk.chunk_index || chunkIndex,
                        audio: true,
                        audio_status: 'ready',
                    });
                    log('✅ Chunk metadata updated for', chunkId);
                } catch (chunkErr) {
                    console.error('❌ Failed to update chunk metadata:', chunkErr.message);
                }

                // Trigger audio merge
                const mergedChunk = await deps.getChunk(chunkId);
                if (mergedChunk) {
                    await triggerAudioMerge(mergedChunk);
                }
                break;
            }

            case 'scene_video': {
                const baseParts3 = baseId.split('_');
                if (baseParts3.length < 3) {
                    console.warn('⚠️ Invalid video job_id format:', job_id);
                    break;
                }
                const sceneId3 = baseParts3.pop();
                const chapterId3 = baseParts3.pop();
                const bookId3 = baseParts3.join('_');
                await orchestrator.completeStage(redis, bookId3, chapterId3, sceneId3, 'video', build_id);
                break;
            }

            case 'scene_image': {
                const baseParts4 = baseId.split('_');
                if (baseParts4.length < 3) {
                    console.warn('⚠️ Invalid scene image job_id format:', job_id);
                    break;
                }
                // Legacy scene_image: job_id = bookId_chapterId_sceneId:image
                // Parse from the end: sceneId is last, chapterId is second-to-last
                const sceneId4 = baseParts4[baseParts4.length - 1];
                const chapterId4 = baseParts4[baseParts4.length - 2];
                const bookId4 = baseParts4.slice(0, -2).join('_');
                log(`⚠️ SCENE_IMAGE (legacy) callback: ${bookId4}/${chapterId4}/${sceneId4}`);
                await orchestrator.completeStage(redis, bookId4, chapterId4, sceneId4, 'image', build_id);
                break;
            }

            default:
                console.warn('⚠️ Unhandled asset type:', asset.type);
        }
    }

    // ── Trigger audio merge ───────────────────────────
    async function triggerAudioMerge(chunk) {
        const { build_id, book_id, chapter_id, scene_id, chunk_index, expected_chunk_count } = chunk;
        const dbgStart = Date.now();

        if (!build_id || !book_id || !chapter_id || !scene_id) {
            console.warn(`⚠️ triggerAudioMerge: missing identifiers, skipping after ${Date.now() - dbgStart}ms`);
            return;
        }

        const buildDir = path.join(OUTPUT_DIR, build_id);
        if (!fs.existsSync(buildDir)) {
            console.warn(`⚠️ triggerAudioMerge: build dir not found: ${buildDir} (${Date.now() - dbgStart}ms)`);
            return;
        }

        // 🔧 AUDIO-ORCH: Читаем phase — единственный источник решения
        const orchStart = Date.now();
        const audioOrch = require('./audio-orchestrator');
        const orchState = await audioOrch.getState(redis, book_id, chapter_id, scene_id);
        const orchMs = Date.now() - orchStart;

        if (!orchState || orchState.phase === audioOrch.PHASES.DONE) {
            log(`🎵 Audio already done for ${book_id}/${chapter_id}/${scene_id} — skipping retry (${Date.now() - dbgStart}ms)`);
            return;
        }

        if (orchState.phase === audioOrch.PHASES.MERGING) {
            log(`🔀 Merge in progress for ${book_id}/${chapter_id}/${scene_id} — waiting (${Date.now() - dbgStart}ms)`);
            return;
        }

        if (orchState.phase !== audioOrch.PHASES.WAITING_CHUNKS) {
            log(`⏳ Audio phase is ${orchState.phase} — not ready for merge, skipping (${Date.now() - dbgStart}ms)`);
            return;
        }

        const expectedCount = parseInt(expected_chunk_count || orchState.expected_count || '1', 10);

        // Build all expected chunk paths and check which exist
        const chunkPaths = [];
        let allChunksExist = true;
        let missingChunks = 0;
        const chunkCheckStart = Date.now();
        for (let i = 1; i <= expectedCount; i++) {
            const chunkPath = path.join(buildDir, `${book_id}_${chapter_id}_${scene_id}_${pad(i)}.mp3`);
            chunkPaths.push(chunkPath);
            if (!fs.existsSync(chunkPath)) {
                allChunksExist = false;
                missingChunks++;
                log(`⚠️ Missing chunk ${i}: ${chunkPath}`);
            }
        }
        const chunkCheckMs = Date.now() - chunkCheckStart;

        if (!allChunksExist) {
            // ── RETRY LOGIC: chunks may still be generating ──
            const readyCount = expectedCount - missingChunks;
            log(`⏳ Audio merge: ${readyCount}/${expectedCount} chunks ready for ${book_id}/${chapter_id}/${scene_id} — scheduling retry in 15s`);

            // Use a Redis-based TTL marker to avoid piling up retries
            const retryKey = `animastor:audio-merge-retry:${book_id}:${chapter_id}:${scene_id}`;
            // Track retry count to cap at MAX_RETRIES
            const retryCountKey = `${retryKey}:count`;
            const MAX_RETRIES = 5;
            const attemptStr = await redis.get(retryCountKey);
            const attempt = attemptStr ? parseInt(attemptStr, 10) : 0;
            if (attempt >= MAX_RETRIES) {
                // ── RETRY EXHAUSTED: Mark FAILED so scheduler re-dispatches ──
                const missingIndices = [];
                for (let i = 1; i <= expectedCount; i++) {
                    const chunkPath = path.join(buildDir, `${book_id}_${chapter_id}_${scene_id}_${pad(i)}.mp3`);
                    if (!fs.existsSync(chunkPath)) {
                        missingIndices.push(i);
                    }
                }
                console.warn(`⚠️ Max retries (${MAX_RETRIES}) reached for ${book_id}/${chapter_id}/${scene_id} — ${missingIndices.length} missing (${Date.now() - dbgStart}ms)`);

                // 🔧 AUDIO-ORCH: Set FAILED phase
                await audioOrch.setFailed(redis, book_id, chapter_id, scene_id, 
                    `max_retries_exceeded:${missingIndices.length}_missing`);

                // Clear GPU hub dedup + reset metadata for missing chunks
                for (const idx of missingIndices) {
                    const chunkId = `${book_id}_${chapter_id}_${scene_id}_${pad(idx)}`;
                    const jobKey = `animastor:job:${chunkId}:audio`;
                    await redis.del(jobKey).catch(() => {});
                    const resultProcessedKey = `animastor:result-processed:${chunkId}:audio`;
                    await redis.del(resultProcessedKey).catch(() => {});

                    const chunkKey = `animastor:chunk:${chunkId}`;
                    const raw = await redis.get(chunkKey);
                    if (raw) {
                        try {
                            const ch = JSON.parse(raw);
                            ch.audio = false;
                            ch.audio_status = 'pending';
                            await redis.set(chunkKey, JSON.stringify(ch));
                        } catch (e) {}
                    }
                }

                // Clear dispatch lease + metadata + completion marker
                const leaseKey = `animastor:dispatch-lease:${book_id}:${chapter_id}:${scene_id}:audio`;
                const metaKey = `animastor:dispatch-meta:${book_id}:${chapter_id}:${scene_id}:audio`;
                const completedKey = `animastor:dispatch-completed:${book_id}:${chapter_id}:${scene_id}:audio`;
                await redis.del(leaseKey).catch(() => {});
                await redis.del(metaKey).catch(() => {});
                await redis.del(completedKey).catch(() => {});

                await redis.del(retryKey).catch(() => {});
                await redis.del(retryCountKey).catch(() => {});

                try {
                    await state.setAssetState(redis, book_id, chapter_id, scene_id, 'audio', state.AssetState.PENDING);
                    log(`🔁 Audio FAILED for ${book_id}/${chapter_id}/${scene_id} — scheduler will re-dispatch on next tick`);
                } catch (stateErr) {
                    console.error(`❌ Failed to reset asset state for re-dispatch: ${stateErr.message}`);
                }
                return;
            }

            const scheduled = await redis.set(retryKey, '1', 'NX', 'EX', 30);
            if (scheduled) {
                await redis.set(retryCountKey, String(attempt + 1), 'EX', 180);
                setTimeout(async () => {
                    try {
                        await redis.del(retryKey).catch(() => {});
                        const currentChunkId = `${book_id}_${chapter_id}_${scene_id}_${String(chunk_index).padStart(4, '0')}`;
                        const refreshed = await deps.getChunk(currentChunkId);
                        if (refreshed) {
                            log(`🔄 Merge retry (${attempt + 1}/${MAX_RETRIES}): ${book_id}/${chapter_id}/${scene_id}`);
                            await triggerAudioMerge(refreshed);
                        }
                    } catch (e) {
                        console.warn(`⚠️ Merge retry failed for ${book_id}/${chapter_id}/${scene_id}: ${e.message}`);
                    }
                }, 15000);
            } else {
                log(`⏳ Merge retry already scheduled for ${book_id}/${chapter_id}/${scene_id}`);
            }
            return;
        }

        // All chunks exist on disk — set MERGING phase and proceed with merge
        const mergePhaseStart = Date.now();
        await audioOrch.setMerging(redis, book_id, chapter_id, scene_id);
        log(`🔀 AUDIO_ORCH: ${book_id}/${chapter_id}/${scene_id} → MERGING`);

        log(`🎵 Merging ${expectedCount} audio chunks for ${book_id}/${chapter_id}/${scene_id}`);

        try {
            // Trim only chunks that have padded_text set
            const trimStart = Date.now();
            let trimmedCount = 0;
            for (let i = 0; i < chunkPaths.length; i++) {
                const currentChunkId = `${book_id}_${chapter_id}_${scene_id}_${pad(i + 1)}`;
                try {
                    const currentMeta = await deps.getChunk(currentChunkId);
                    if (currentMeta && currentMeta.padded_text) {
                        log(`✂️ Padded chunk ${i + 1}/${chunkPaths.length}: trimming ${path.basename(chunkPaths[i])}`);
                        await audio.trimPaddedSceneAudio(chunkPaths[i]);
                        trimmedCount++;
                    }
                } catch (metaErr) {
                    console.warn(`⚠️ Failed to check padded_text for chunk ${currentChunkId}: ${metaErr.message}`);
                }
            }
            const trimMs = Date.now() - trimStart;

            // Merge chunks into canonical audio using mergeSceneAudioChunks
            const mergeStart = Date.now();
            const mergeResult = await audio.mergeSceneAudioChunks(redis, book_id, chapter_id, scene_id, build_id, expectedCount);
            const mergeMs = Date.now() - mergeStart;

            if (!mergeResult) {
                const outputPath = path.join(buildDir, `${book_id}_${chapter_id}_${scene_id}.mp3`);
                if (chunkPaths.length === 1 && fs.existsSync(chunkPaths[0]) && !fs.existsSync(outputPath)) {
                    fs.copyFileSync(chunkPaths[0], outputPath);
                    log(`🎵 Single chunk fallback — copied to scene audio: ${outputPath}`);
                } else {
                    await audioOrch.setFailed(redis, book_id, chapter_id, scene_id, 'merge_failed_no_output');
                    const totalMs = Date.now() - dbgStart;
                    log(`[MERGE:DBG] ${book_id}/${chapter_id}/${scene_id}: FAILED no_output ` +
                        `orch=${orchMs}ms chunk_check=${chunkCheckMs}ms ` +
                        `trim=${trimMs}ms merge=${mergeMs}ms total=${totalMs}ms`);
                    return;
                }
            }

            // 🔧 AUDIO-ORCH: Только после успешного merge → DONE + completeStage
            const doneStart = Date.now();
            await audioOrch.setDone(redis, book_id, chapter_id, scene_id);
            const doneMs = Date.now() - doneStart;

            const completeStart = Date.now();
            await orchestrator.completeStage(redis, book_id, chapter_id, scene_id, 'audio', build_id);
            const completeMs = Date.now() - completeStart;

            const totalMs = Date.now() - dbgStart;
            log(`[MERGE:DBG] ${book_id}/${chapter_id}/${scene_id}: SUCCESS ` +
                `expected=${expectedCount} ready=${expectedCount} ` +
                `orch=${orchMs}ms chunk_check=${chunkCheckMs}ms ` +
                `trim=${trimMs}ms(${trimmedCount}) merge=${mergeMs}ms ` +
                `done=${doneMs}ms complete=${completeMs}ms total=${totalMs}ms`);
            log(`🎵 Audio merge complete for ${book_id}/${chapter_id}/${scene_id}`);
        } catch (err) {
            console.error(`❌ Audio merge failed for ${book_id}/${chapter_id}/${scene_id} after ${Date.now() - dbgStart}ms:`, err.message);
            try {
                await audioOrch.setFailed(redis, book_id, chapter_id, scene_id, `merge_error:${err.message}`);
            } catch (_) {}
        }
    }

    // ── Book snapshot ─────────────────────────────────
    async function saveBookSnapshot(bookId) {
        try {
            const bookData = book.loadBook(bookId);
            if (!bookData) {
                log(`⚠️ saveBookSnapshot: book ${bookId} not found`);
                return null;
            }
            const snapshotPath = path.join(config.BOOKS_DIR || '/data/books', `${bookId}.snapshot.json`);
            fs.writeFileSync(snapshotPath, JSON.stringify(bookData, null, 2));
            log(`💾 Book snapshot saved: ${bookId}`);
            return snapshotPath;
        } catch (err) {
            console.error(`❌ saveBookSnapshot failed for ${bookId}:`, err.message);
            return null;
        }
    }

    async function loadBookSnapshot(bookId) {
        try {
            const snapshotPath = path.join(config.BOOKS_DIR || '/data/books', `${bookId}.snapshot.json`);
            if (!fs.existsSync(snapshotPath)) {
                log(`⚠️ loadBookSnapshot: no snapshot found for ${bookId}`);
                return null;
            }
            const data = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
            log(`📖 Book snapshot loaded: ${bookId}`);
            return data;
        } catch (err) {
            console.error(`❌ loadBookSnapshot failed for ${bookId}:`, err.message);
            return null;
        }
    }

    return {
        handleTaskResult,
        triggerAudioMerge,
        saveBookSnapshot,
        loadBookSnapshot,
    };
};
