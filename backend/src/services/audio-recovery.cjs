// ======================================================
// ANIMASTOR BACKEND — AUDIO RECOVERY SERVICE
// ======================================================
// Periodically scans Redis for pending audio/image results
// and recovers them to disk.

const path = require('path');
const fs = require('fs');

module.exports = function(redis, config, deps) {
    const { audio, image, state, book, orchestrator, taskHandler, getChunk, saveChunk, saveIURegistry } = deps;
    const { log } = deps.utils;

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

                    let job_id, result_base64, build_id;
                    let resultBuildId, bookId, chapterId, sceneId, suffix;

                    // Try parsing as JSON first (new format: { job_id, result_base64, build_id })
                    if (raw.startsWith('{')) {
                        try {
                            const data = JSON.parse(raw);
                            job_id = data.job_id;
                            result_base64 = data.result_base64;
                            build_id = data.build_id;
                        } catch (e) {
                            console.warn('⚠️ Failed to parse JSON result:', e.message);
                            await redis.del(key);
                            continue;
                        }
                    }

                    // Extract identifiers from key: animastor:result:<buildId>:<bookId>:<chapterId>:<sceneId>:<suffix>
                    const keyParts = key.split(':');
                    if (keyParts.length >= 7) {
                        // New format: animastor:result:<buildId>:<bookId>:<chapterId>:<sceneId>:<type>
                        resultBuildId = keyParts[2];
                        bookId = keyParts[3];
                        chapterId = keyParts[4];
                        sceneId = keyParts[5];
                        suffix = keyParts[6];
                    } else if (keyParts.length >= 4) {
                        // Old GPU hub format: animastor:result:<bookId_chapterId_sceneId_index>:<type>
                        // The value is a raw data URL, not JSON. Parse it.
                        if (!result_base64) {
                            // Data URL fallback: raw is like "data:audio/mp3;base64,..."
                            result_base64 = raw;
                            // Try to extract identifiers from the job_id part
                            const combinedId = keyParts[2] || '';
                            suffix = keyParts[3] || 'audio';
                            // combinedId = bookId_chapterId_sceneId_index
                            const idParts = combinedId.split('_');
                            if (idParts.length >= 3) {
                                sceneId = idParts.pop();
                                chapterId = idParts.pop();
                                bookId = idParts.join('_');
                            }
                            resultBuildId = build_id || 'default';
                        }
                        if (!job_id) {
                            job_id = `${combinedId || 'unknown'}:${suffix}`;
                        }
                    }

                    if (!result_base64) continue;
                    if (!bookId || !chapterId || !sceneId) continue;

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

    /**
     * Per-scene audio recovery — trigger-based approach.
     * Filters results for a specific scene only, instead of scanning all keys.
     * Use this for manual/on-demand recovery when a callback was missed.
     *
     * @param {string} bookId
     * @param {string} chapterId
     * @param {string} sceneId
     * @param {string} [buildId='default']
     * @returns {Promise<{recovered: boolean, reason: string}>}
     */
    async function recoverAudioForScene(bookId, chapterId, sceneId, buildId = 'default') {
        const sceneResultKey = `animastor:result:${buildId}:${bookId}:${chapterId}:${sceneId}:audio`;

        try {
            const raw = await redis.get(sceneResultKey);
            if (!raw) {
                return { recovered: false, reason: 'no_result_key' };
            }

            let job_id, result_base64;

            if (raw.startsWith('{')) {
                try {
                    const data = JSON.parse(raw);
                    job_id = data.job_id;
                    result_base64 = data.result_base64;
                } catch (e) {
                    return { recovered: false, reason: 'parse_failed' };
                }
            } else {
                // Direct data URL format
                result_base64 = raw;
                job_id = `${bookId}_${chapterId}_${sceneId}:audio`;
            }

            if (!result_base64) {
                return { recovered: false, reason: 'no_result_data' };
            }

            // Check if audio already exists on disk
            const baseId = `${bookId}_${chapterId}_${sceneId}`;
            const buildDir = path.join(config.OUTPUT_DIR, buildId);
            const canonicalAudioPath = path.join(buildDir, `${baseId}.mp3`);

            if (fs.existsSync(canonicalAudioPath)) {
                log(`🔁 Audio already on disk: ${canonicalAudioPath} — cleaning up result key`);
                await redis.del(sceneResultKey);
                return { recovered: true, reason: 'already_on_disk' };
            }

            // Check if scene audio is already marked ready
            const chunkId = `${bookId}_${chapterId}_${sceneId}_0001`;
            const chunk = await getChunk(chunkId);
            if (chunk && chunk.audio && chunk.audio_status === 'ready') {
                log(`🔁 Audio already marked ready — cleaning up result key`);
                await redis.del(sceneResultKey);
                return { recovered: true, reason: 'already_ready' };
            }

            const sceneAudioReady = await audio.isSceneAudioReady(buildId, bookId, chapterId, sceneId);
            if (sceneAudioReady) {
                log(`🔁 Scene audio already ready — cleaning up result key`);
                await redis.del(sceneResultKey);
                return { recovered: true, reason: 'already_ready_pg' };
            }

            // Save audio chunk to disk
            if (!fs.existsSync(buildDir)) {
                fs.mkdirSync(buildDir, { recursive: true });
            }

            const chunkPath = path.join(buildDir, `${baseId}_0001.mp3`);
            try {
                const resultBuffer = Buffer.from(result_base64, 'base64');
                fs.writeFileSync(chunkPath, resultBuffer);
                log(`🔁 Saved recovered audio: ${chunkPath}`);
            } catch (saveErr) {
                return { recovered: false, reason: `save_failed: ${saveErr.message}` };
            }

            // Update chunk metadata
            try {
                await saveChunk(chunkId, {
                    build_id: buildId,
                    book_id: bookId,
                    chapter_id: chapterId,
                    scene_id: sceneId,
                    chunk_index: '0001',
                    expected_chunk_count: 1,
                    audio: true,
                    audio_status: 'ready',
                    scene_type: chunk?.scene_type || 'narration',
                });
                log(`🔁 Chunk metadata updated for recovered audio: ${chunkId}`);
            } catch (metaErr) {
                return { recovered: false, reason: `metadata_failed: ${metaErr.message}` };
            }

            // Trigger audio merge via task handler
            try {
                await taskHandler.handleTaskResult(job_id, result_base64, buildId);
            } catch (mergeErr) {
                return { recovered: false, reason: `merge_failed: ${mergeErr.message}` };
            }

            await redis.del(sceneResultKey);
            log(`🔁 Audio recovered and processed: ${bookId}/${chapterId}/${sceneId}`);
            return { recovered: true, reason: 'success' };
        } catch (err) {
            console.error('❌ Audio recovery error:', err.message);
            return { recovered: false, reason: `error: ${err.message}` };
        }
    }

    return {
        recoverAudioResults,
        recoverAudioForScene,
    };
};
