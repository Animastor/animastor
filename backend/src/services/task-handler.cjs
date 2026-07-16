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
const jobSchema = require('../runtime/job-schema');

module.exports = function(redis, config, deps) {
    const { audio, image, video, state, book, orchestrator, activeScenes, placeholderAudio, cleanupService, utils, bookDiff } = deps;
    const { log, pad, collectScenes, findSceneRuntimeData } = utils;
    const { resolveAssetPath } = cleanupService;
    const OUTPUT_DIR = config.OUTPUT_DIR;
    const {
        AUDIO_MERGE_RETRY_DELAY_MS,
        AUDIO_MERGE_RETRY_MAX,
        AUDIO_MERGE_RETRY_DEDUP_TTL_S,
        AUDIO_MERGE_RETRY_COUNTER_TTL_S,
    } = config.TIMEOUTS;

    // ── Handle GPU task result ────────────────────────
    async function handleTaskResult(job_id, result_base64, build_id) {
        log('🎬 Handling task result:', job_id, 'build:', build_id);

        // Единый разбор job_id (runtime/job-schema.js)
        const parsed = jobSchema.parseJobId(job_id);

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
                if (!parsed || parsed.kind !== 'iu_image') {
                    console.warn('⚠️ Invalid IU image job_id format:', job_id);
                    break;
                }
                const { iuId, sceneId, chapterId, bookId } = parsed;

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
                    log('⚠️ Falling back to trigger image completed despite PG error');
                    await orchestrator.completeStage(redis, bookId, chapterId, sceneId, 'image', build_id);
                }
                break;
            }

            case 'audio_chunk': {
                if (!parsed || parsed.kind !== 'audio_chunk') {
                    console.warn('⚠️ Invalid chunk ID in job_id:', job_id);
                    break;
                }
                const chunkId = parsed.assetId;
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
                if (!parsed || parsed.kind !== 'scene_video') {
                    console.warn('⚠️ Invalid video job_id format:', job_id);
                    break;
                }
                await orchestrator.completeStage(redis, parsed.bookId, parsed.chapterId, parsed.sceneId, 'video', build_id);
                break;
            }

            case 'scene_image': {
                if (!parsed || parsed.kind !== 'scene_image') {
                    console.warn('⚠️ Invalid scene image job_id format:', job_id);
                    break;
                }
                log(`⚠️ SCENE_IMAGE (legacy) callback: ${parsed.bookId}/${parsed.chapterId}/${parsed.sceneId}`);
                await orchestrator.completeStage(redis, parsed.bookId, parsed.chapterId, parsed.sceneId, 'image', build_id);
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
        const audioOrch = require('./audio-orchestrator');
        const orchState = await audioOrch.getState(redis, book_id, chapter_id, scene_id);

        if (!orchState || orchState.phase === audioOrch.PHASES.DONE) {
            log(`🎵 Audio already done for ${book_id}/${chapter_id}/${scene_id} — skipping retry (${Date.now() - dbgStart}ms)`);
            return;
        }

        if (orchState.phase === audioOrch.PHASES.MERGING) {
            log(`🔀 Merge in progress for ${book_id}/${chapter_id}/${scene_id} — waiting (${Date.now() - dbgStart}ms)`);
            return;
        }

        if (orchState.phase === audioOrch.PHASES.FAILED) {
            // 🔧 RECOVERY: Phase is FAILED but a late chunk arrived.
            // This happens when the last chunk arrives after MAX_RETRIES.
            // Check if ALL chunks are now present — if so, recover by
            // transitioning to WAITING_CHUNKS and proceeding with merge.
            const recoveryExpectedCount = parseInt(expected_chunk_count || orchState.expected_count || '1', 10);
            let allPresent = true;
            for (let i = 1; i <= recoveryExpectedCount; i++) {
                const chunkPath = path.join(buildDir, `${book_id}_${chapter_id}_${scene_id}_${pad(i)}.mp3`);
                if (!fs.existsSync(chunkPath)) {
                    allPresent = false;
                    break;
                }
            }
            if (allPresent) {
                log(`🔧 RECOVERY: All ${recoveryExpectedCount} chunks present despite FAILED for ${book_id}/${chapter_id}/${scene_id} — resuming merge`);
                // FAILED → WAITING_CHUNKS (now a valid transition in VALID_TRANSITIONS)
                const transResult = await audioOrch.transitionState(redis, book_id, chapter_id, scene_id, audioOrch.PHASES.WAITING_CHUNKS);
                if (!transResult.success) {
                    log(`⚠️ RECOVERY: transition FAILED→WAITING_CHUNKS failed: ${transResult.reason} (${Date.now() - dbgStart}ms)`);
                    return;
                }
                // Fall through to merge logic below
            } else {
                log(`⏳ Audio phase is FAILED (${book_id}/${chapter_id}/${scene_id}) but not all chunks present yet — waiting for scheduler re-dispatch (${Date.now() - dbgStart}ms)`);
                return;
            }
        } else if (orchState.phase !== audioOrch.PHASES.WAITING_CHUNKS) {
            log(`⏳ Audio phase is ${orchState.phase} — not ready for merge, skipping (${Date.now() - dbgStart}ms)`);
            return;
        }

        const expectedCount = parseInt(expected_chunk_count || orchState.expected_count || '1', 10);

        // Build all expected chunk paths and check which exist
        const chunkPaths = [];
        let allChunksExist = true;
        let missingChunks = 0;
        for (let i = 1; i <= expectedCount; i++) {
            const chunkPath = path.join(buildDir, `${book_id}_${chapter_id}_${scene_id}_${pad(i)}.mp3`);
            chunkPaths.push(chunkPath);
            if (!fs.existsSync(chunkPath)) {
                allChunksExist = false;
                missingChunks++;
                log(`⚠️ Missing chunk ${i}: ${chunkPath}`);
            }
        }

        if (!allChunksExist) {
            // ── RETRY LOGIC: chunks may still be generating ──
            const readyCount = expectedCount - missingChunks;
            log(`⏳ Audio merge: ${readyCount}/${expectedCount} chunks ready for ${book_id}/${chapter_id}/${scene_id} — scheduling retry in 15s`);

            // Use a Redis-based TTL marker to avoid piling up retries
            const retryKey = `animastor:audio-merge-retry:${book_id}:${chapter_id}:${scene_id}`;
            // Track retry count to cap at MAX_RETRIES
            const retryCountKey = `${retryKey}:count`;
            const MAX_RETRIES = AUDIO_MERGE_RETRY_MAX;
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

                // 🔧 AUDIO-ORCH: Set FAILED phase — отдельная машина фаз, failStage её не трогает
                await audioOrch.setFailed(redis, book_id, chapter_id, scene_id, 
                    `max_retries_exceeded:${missingIndices.length}_missing`);

                // Clear GPU hub dedup + reset metadata for missing chunks (merge-specific cleanup)
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

                await redis.del(retryKey).catch(() => {});
                await redis.del(retryCountKey).catch(() => {});

                // T5: orchestrator.failStage — единая команда: FAILED→PENDING + markDispatchCompleted
                // + journal event. Заменяет ручной state.setAssetState(PENDING) + очистку lease.
                try {
                    await orchestrator.failStage(redis, book_id, chapter_id, scene_id, 'audio', build_id,
                        `max_retries_exceeded:${missingIndices.length}_missing`);
                    log(`🔁 Audio FAILED→PENDING via failStage for ${book_id}/${chapter_id}/${scene_id}`);
                } catch (fsErr) {
                    console.error(`❌ failStage failed for ${book_id}/${chapter_id}/${scene_id}: ${fsErr.message}`);
                }
                return;
            }

            const scheduled = await redis.set(retryKey, '1', 'NX', 'EX', AUDIO_MERGE_RETRY_DEDUP_TTL_S);
            if (scheduled) {
                await redis.set(retryCountKey, String(attempt + 1), 'EX', AUDIO_MERGE_RETRY_COUNTER_TTL_S);
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
                }, AUDIO_MERGE_RETRY_DELAY_MS);
            } else {
                log(`⏳ Merge retry already scheduled for ${book_id}/${chapter_id}/${scene_id}`);
            }
            return;
        }

        // All chunks exist on disk — set MERGING phase and proceed with merge
        await audioOrch.setMerging(redis, book_id, chapter_id, scene_id);
        log(`🔀 AUDIO_ORCH: ${book_id}/${chapter_id}/${scene_id} → MERGING`);

        log(`🎵 Merging ${expectedCount} audio chunks for ${book_id}/${chapter_id}/${scene_id}`);

        try {
            // Trim only chunks that have padded_text set
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

            // Merge chunks into canonical audio using mergeSceneAudioChunks
            const mergeResult = await audio.mergeSceneAudioChunks(redis, book_id, chapter_id, scene_id, build_id, expectedCount);

            if (!mergeResult) {
                const outputPath = path.join(buildDir, `${book_id}_${chapter_id}_${scene_id}.mp3`);
                if (chunkPaths.length === 1 && fs.existsSync(chunkPaths[0]) && !fs.existsSync(outputPath)) {
                    fs.copyFileSync(chunkPaths[0], outputPath);
                    log(`🎵 Single chunk fallback — copied to scene audio: ${outputPath}`);
                } else {
                    await audioOrch.setFailed(redis, book_id, chapter_id, scene_id, 'merge_failed_no_output');
                    return;
                }
            }

            // 🔧 AUDIO-ORCH: Только после успешного merge → DONE + completeStage
            await audioOrch.setDone(redis, book_id, chapter_id, scene_id);

            await orchestrator.completeStage(redis, book_id, chapter_id, scene_id, 'audio', build_id);

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
