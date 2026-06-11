// ======================================================
// ANIMASTOR BACKEND — AUDIO RECOVERY SERVICE
// ======================================================
// Periodically scans Redis for pending audio/image results
// and recovers them to disk.
//
// Usage:
//   const audioRecovery = require('./services/audio-recovery.cjs')(redis, config, deps);

const path = require('path');
const fs = require('fs');

module.exports = function(redis, config, deps) {
    const { audio, image, state, book, orchestrator, taskHandler, getChunk, saveChunk, saveIURegistry } = deps;
    const { log, pad, parseChunkId } = deps.utils;

    async function recoverAudioResults() {
        try {
            const resultKeys = [];
            let cursor = 0;

            do {
                const result = await redis.scan(cursor, 'MATCH', 'animastor:result:*', 'COUNT', 200);
                cursor = parseInt(result[0], 10);
                resultKeys.push(...result[1]);
            } while (cursor !== 0);

            if (resultKeys.length === 0) return;

            for (const key of resultKeys) {
                try {
                    const raw = await redis.get(key);
                    if (!raw) continue;

                    const data = JSON.parse(raw);
                    const { job_id, result_base64, build_id } = data;
                    if (!job_id || !result_base64) continue;

                    // Extract identifiers from key: animastor:result:<buildId>:<bookId>:<chapterId>:<sceneId>:<suffix>
                    const keyParts = key.split(':');
                    if (keyParts.length < 7) continue;

                    const resultBuildId = keyParts[2];
                    const bookId = keyParts[3];
                    const chapterId = keyParts[4];
                    const sceneId = keyParts[5];
                    const suffix = keyParts[6]; // 'audio' or 'image'

                    const baseId = `${bookId}_${chapterId}_${sceneId}`;

                    if (job_id.endsWith(':image')) {
                        // Handle image results
                        try {
                            await taskHandler.handleTaskResult(job_id, result_base64, resultBuildId);
                            await redis.del(key);
                            log('🔁 Recovered image result:', job_id);
                        } catch (imgErr) {
                            console.warn('⚠️ Failed to recover image result:', imgErr.message);
                        }
                        continue;
                    }

                    if (job_id.endsWith(':audio')) {
                        // Handle audio results
                        const chunkId = `${bookId}_${chapterId}_${sceneId}_0001`;
                        const chunk = await getChunk(chunkId);

                        // Check if audio already exists
                        const buildDir = path.join(config.OUTPUT_DIR, resultBuildId);
                        const canonicalAudioPath = path.join(buildDir, `${baseId}.mp3`);

                        if (fs.existsSync(canonicalAudioPath)) {
                            log('🔁 Audio result already on disk:', canonicalAudioPath, '— cleaning up Redis key');
                            await redis.del(key);
                            continue;
                        }

                        if (chunk && chunk.audio && chunk.audio_status === 'ready') {
                            log('🔁 Audio result already marked ready in Redis — cleaning up key');
                            await redis.del(key);
                            continue;
                        }

                        const sceneAudioReady = await audio.isSceneAudioReady(resultBuildId, bookId, chapterId, sceneId);
                        if (sceneAudioReady) {
                            log('🔁 Scene audio already ready — cleaning up key');
                            await redis.del(key);
                            continue;
                        }

                        // Save audio chunk to disk
                        const outputDir = path.join(config.OUTPUT_DIR, resultBuildId);
                        if (!fs.existsSync(outputDir)) {
                            fs.mkdirSync(outputDir, { recursive: true });
                        }

                        const chunkPath = path.join(outputDir, `${baseId}_0001.mp3`);
                        try {
                            const resultBuffer = Buffer.from(result_base64, 'base64');
                            fs.writeFileSync(chunkPath, resultBuffer);
                            log('🔁 Saved recovered audio:', chunkPath);
                        } catch (saveErr) {
                            console.warn('⚠️ Failed to save audio chunk:', saveErr.message);
                            continue;
                        }

                        // Update chunk metadata
                        try {
                            await saveChunk(chunkId, {
                                build_id: resultBuildId,
                                book_id: bookId,
                                chapter_id: chapterId,
                                scene_id: sceneId,
                                chunk_index: '0001',
                                expected_chunk_count: 1,
                                audio: true,
                                audio_status: 'ready',
                                scene_type: chunk?.scene_type || 'narration',
                            });
                            log('🔁 Chunk metadata updated for recovered audio:', chunkId);
                        } catch (metaErr) {
                            console.warn('⚠️ Failed to update chunk metadata:', metaErr.message);
                        }

                        // Trigger audio merge
                        try {
                            const mergedChunk = await getChunk(chunkId);
                            if (mergedChunk) {
                                await taskHandler.handleTaskResult(job_id, result_base64, resultBuildId);
                            }
                        } catch (mergeErr) {
                            console.warn('⚠️ Failed to trigger audio merge:', mergeErr.message);
                        }

                        await redis.del(key);
                        log('🔁 Audio result recovered and processed:', job_id);
                    }
                } catch (itemErr) {
                    console.warn('⚠️ Failed to process recovery item:', itemErr.message);
                }
            }
        } catch (err) {
            console.error('❌ Audio recovery error:', err.message);
        }
    }

    function startRecoveryInterval() {
        // Run recovery every 5 seconds
        setInterval(recoverAudioResults, 5000);
        log('🔁 Audio recovery loop started (every 5s)');
    }

    return {
        recoverAudioResults,
        startRecoveryInterval,
    };
};
