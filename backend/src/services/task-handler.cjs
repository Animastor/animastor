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
    // AUDIO_MERGE_RETRY_* removed (T7) — now in audioOrch.completeChunk

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

                // Update chunk metadata in Redis (thin: только metadata, routing)
                try {
                    const existing = await deps.getChunk(chunkId) || {};
                    await deps.saveChunk(chunkId, {
                        ...existing,
                        build_id: existing.build_id || build_id,
                        book_id: existing.book_id || bookId,
                        chapter_id: existing.chapter_id || chapterId,
                        scene_id: existing.scene_id || sceneId,
                        chunk_index: existing.chunk_index || chunkIndex,
                        audio: true,
                        audio_status: 'ready',
                    });
                    log('✅ Chunk metadata updated for', chunkId);
                } catch (chunkErr) {
                    console.error('❌ Failed to update chunk metadata:', chunkErr.message);
                }

                // T7: Делегируем merge-оркестрацию в audio-orchestrator.completeChunk
                const audioOrch = require('./audio-orchestrator');
                try {
                    await audioOrch.completeChunk(redis, bookId, chapterId, sceneId, chunkIndex, build_id, {
                        audio,
                        orchestrator,
                        getChunk: deps.getChunk,
                        saveChunk: deps.saveChunk,
                    });
                } catch (orchErr) {
                    console.error('❌ audioOrch.completeChunk failed:', orchErr.message);
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
        // triggerAudioMerge: dead — replaced by audioOrch.completeChunk (T7)
        saveBookSnapshot,
        loadBookSnapshot,
    };
};
