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

        const resultBuffer = Buffer.from(result_base64, 'base64');
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
                        await orchestrator.handleImageCompleted(redis, bookId, chapterId, sceneId, build_id);
                    } else if (totalIUs === 0) {
                        log('⚠️ No IUs registered in PG for scene — triggering completion anyway');
                        await orchestrator.handleImageCompleted(redis, bookId, chapterId, sceneId, build_id);
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
                        await orchestrator.handleImageCompleted(redis, bookId2, chapterId2, sceneId2, build_id);
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
                await orchestrator.handleVideoCompleted(redis, bookId3, chapterId3, sceneId3, build_id);
                break;
            }

            case 'scene_image': {
                const baseParts4 = baseId.split('_');
                if (baseParts4.length < 3) {
                    console.warn('⚠️ Invalid scene image job_id format:', job_id);
                    break;
                }
                const sceneId4 = baseParts4.pop();
                const chapterId4 = baseParts4.pop();
                const bookId4 = baseParts4.join('_');
                await orchestrator.handleSceneImageCompleted(redis, bookId4, chapterId4, sceneId4, build_id);
                break;
            }

            default:
                console.warn('⚠️ Unhandled asset type:', asset.type);
        }
    }

    // ── Trigger audio merge ───────────────────────────
    async function triggerAudioMerge(chunk) {
        const { build_id, book_id, chapter_id, scene_id, chunk_index, expected_chunk_count } = chunk;

        if (!build_id || !book_id || !chapter_id || !scene_id) {
            console.warn('⚠️ triggerAudioMerge: missing identifiers, skipping');
            return;
        }

        const buildDir = path.join(OUTPUT_DIR, build_id);
        if (!fs.existsSync(buildDir)) {
            console.warn(`⚠️ triggerAudioMerge: build dir not found: ${buildDir}`);
            return;
        }

        // Check if scene audio is already ready
        const sceneAudioReady = await audio.isSceneAudioReady(build_id, book_id, chapter_id, scene_id);
        if (sceneAudioReady) {
            log(`🎵 Scene audio already ready for ${book_id}/${chapter_id}/${scene_id} — delegating to orchestrator`);
            await orchestrator.handleAudioCompleted(redis, book_id, chapter_id, scene_id, build_id);
            return;
        }

        // Check if all expected chunks exist
        const expectedCount = parseInt(expected_chunk_count || '1', 10);
        const actualCount = parseInt(chunk_index || '1', 10);

        if (actualCount < expectedCount) {
            log(`⏳ Audio merge: ${actualCount}/${expectedCount} chunks ready for ${book_id}/${chapter_id}/${scene_id} — waiting for more`);
            return;
        }

        // All chunks ready — merge them
        log(`🎵 Merging ${actualCount} audio chunks for ${book_id}/${chapter_id}/${scene_id}`);

        // Generate chunk file paths
        let allChunksExist = true;
        const chunkPaths = [];
        for (let i = 1; i <= expectedCount; i++) {
            const chunkPath = path.join(buildDir, `${book_id}_${chapter_id}_${scene_id}_${pad(i)}.mp3`);
            chunkPaths.push(chunkPath);
            if (!fs.existsSync(chunkPath)) {
                allChunksExist = false;
                log(`⚠️ Missing chunk: ${chunkPath}`);
            }
        }

        if (!allChunksExist) {
            console.warn(`⚠️ Not all audio chunks exist for ${book_id}/${chapter_id}/${scene_id} — cannot merge`);
            return;
        }

        try {
            // First check if padded audio trimming is needed
            let finalPaths = chunkPaths;
            if (chunk.padded_text) {
                const trimmedPaths = chunkPaths.map(cp => {
                    const trimmedName = cp.replace(/\.mp3$/, '_trimmed.mp3');
                    return trimmedName;
                });
                // Trim each chunk
                for (let i = 0; i < chunkPaths.length; i++) {
                    try {
                        await audio.trimAudioChunk(chunkPaths[i], trimmedPaths[i]);
                    } catch (trimErr) {
                        // If trimming fails, use original file
                        trimmedPaths[i] = chunkPaths[i];
                        console.warn(`⚠️ Trim failed for ${chunkPaths[i]}: ${trimErr.message}`);
                    }
                }
                finalPaths = trimmedPaths;
            }

            const outputPath = path.join(buildDir, `${book_id}_${chapter_id}_${scene_id}.mp3`);
            await audio.mergeSceneAudioChunks(finalPaths, outputPath);

            // If this is a single-chunk merge, just copy the file
            if (chunkPaths.length === 1) {
                fs.copyFileSync(chunkPaths[0], outputPath);
                log(`🎵 Single chunk — copied to scene audio: ${outputPath}`);
            }

            // Cleanup trimmed files
            if (chunk.padded_text) {
                for (const tp of finalPaths) {
                    if (tp.endsWith('_trimmed.mp3') && fs.existsSync(tp)) {
                        try { fs.unlinkSync(tp); } catch (_) {}
                    }
                }
            }

            await orchestrator.handleAudioCompleted(redis, book_id, chapter_id, scene_id, build_id);
            log(`🎵 Audio merge complete for ${book_id}/${chapter_id}/${scene_id}`);
        } catch (err) {
            console.error(`❌ Audio merge failed for ${book_id}/${chapter_id}/${scene_id}:`, err.message);
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
