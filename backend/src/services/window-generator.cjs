// ======================================================
// ANIMASTOR BACKEND — WINDOW GENERATOR
// ======================================================
// Background window generation — processes the next window
// of scenes from the source text, creates chunks, registers
// scenes for GPU processing, and reports progress.
//
// Usage:
//   const windowGen = require('./services/window-generator.cjs')({ redis, txtImporter, genSessionRepo, state, activeScenes, placeholderAudio, saveChunk, config });

const { log } = require('../helpers/utils.cjs');

module.exports = function({ redis, txtImporter, genSessionRepo, state, activeScenes, placeholderAudio, saveChunk, config }) {
    /**
     * Run background generation for the next text window.
     * Creates chunks + placeholder audio + registers scenes for GPU scheduler.
     * Reports progress via genSessionRepo.progress_msg (visible via /agent-status).
     */
    async function runBackgroundWindowGeneration(bookId, sessionId, options = {}) {
        const { registerForGpu = true, buildId = 'default' } = options;
        const bgLog = (msg) => log(`[BG-GEN][${bookId}:${sessionId}] ${msg}`);
        bgLog(`🚀 === BACKGROUND WINDOW GENERATION START (registerForGpu=${registerForGpu}) ===`);

        try {
            // — 1. Mark session as generating + set initial progress —
            await genSessionRepo.updateSession(sessionId, { status: 'generating' });
            bgLog(`✅ Session ${sessionId} marked as 'generating'`);

            // Progress callback: handles both string and { stage, message } formats
            // The agent-service passes { stage, message } objects via txtImporter.bootstrapNextWindow
            const progress = async (msgOrObj) => {
                const msg = typeof msgOrObj === 'string' ? msgOrObj : (msgOrObj?.message || 'Working...');
                try {
                    await genSessionRepo.updateSession(sessionId, {
                        progress_msg: msg,
                    });
                    bgLog(`📊 PROGRESS: "${msg}"`);
                } catch (_) { /* non-fatal */ }
            };

            await progress('⟳ Processing next window...');

            // — 2. Bootstrap the next window from source text —
            bgLog(`📖 Calling txtImporter.bootstrapNextWindow...`);
            const result = await txtImporter.bootstrapNextWindow(bookId, progress);
            bgLog(`📖 bootstrapNextWindow result: all_done=${result.all_done} added_scenes=${result.added_scenes} cached=${result.cached}`);

            if (result.all_done) {
                bgLog(`📗 All text processed — marking session completed`);
                await genSessionRepo.updateSession(sessionId, {
                    status: 'completed',
                    progress_msg: '✓ All text processed',
                });
                await genSessionRepo.setBookCompletionStatus(bookId, 'completed');
                bgLog(`✅ completion_status=completed`);
            } else {
                const sceneCount = result.added_scenes || 0;
                await progress(`⟳ Creating ${sceneCount} scenes...`);

                // — 3. Create chunks for each new scene in Redis —                    let chunkCount = 0;
                if (result.chapter && result.chapter.scenes) {
                    const phScenes = [];
                    bgLog(`📦 Creating ${result.chapter.scenes.length} chunks for chapter ${result.chapter.chapter}...`);
                    for (const scene of result.chapter.scenes) {
                        const chunkId = `${bookId}_${result.chapter.chapter}_${scene.scene_id}_0001`;
                        try {
                            await saveChunk(chunkId, {
                                build_id: buildId,
                                book_id: bookId,
                                scene_order: 0,
                                chapter_id: result.chapter.chapter,
                                scene_id: scene.scene_id,
                                chunk_index: '0001',
                                expected_chunk_count: 1,
                                scene_type: scene.type || 'narration',
                                audio: true,
                                audio_status: 'placeholder',
                                image: false,
                                video: false,
                                video_status: 'pending',
                                padded_text: false,
                            });
                            chunkCount++;
                            phScenes.push({ chapter_id: result.chapter.chapter, scene_id: scene.scene_id });
                            bgLog(`  ✅ Chunk created: ${chunkId}`);
                        } catch (chunkErr) {
                            console.warn(`[BG-GEN] Failed to create chunk ${chunkId}: ${chunkErr.message}`);
                        }
                    }

                    // — 4. Generate placeholder audio —
                    if (phScenes.length > 0) {
                        bgLog(`🔊 Generating placeholder audio for ${phScenes.length} scenes...`);
                        try {
                            const phResult = await placeholderAudio.ensureAllPlaceholderAudio(buildId, bookId, phScenes);
                            bgLog(`🔊 Placeholder audio: ${phResult.created} created, ${phResult.skipped} skipped`);
                        } catch (phErr) {
                            console.warn(`[BG-GEN] Placeholder audio failed: ${phErr.message}`);
                        }

                    // — 5. Register scenes for GPU scheduler (only if registerForGpu is true) —
                    if (registerForGpu) {
                        bgLog(`🎮 Registering ${phScenes.length} scenes for GPU scheduler (registerForGpu=true)...`);
                        for (const ps of phScenes) {
                            try {
                                await state.setSceneStateWithBuildId(
                                    redis, bookId, ps.chapter_id, ps.scene_id,
                                    state.SceneState.NEW, buildId
                                );
                                await activeScenes.addActiveScene(
                                    redis, bookId, ps.chapter_id, ps.scene_id
                                );
                                bgLog(`  🎮 Scene ${ps.chapter_id}/${ps.scene_id} registered for GPU`);
                            } catch (regErr) {
                                console.warn(`[BG-GEN] Failed to register scene ${ps.chapter_id}/${ps.scene_id}: ${regErr.message}`);
                            }
                        }
                    } else {
                        bgLog(`⏭️ Skipping GPU registration for ${phScenes.length} scenes (triggered by auto window gen, not user Generate button)`);
                        bgLog(`⏭️ Scenes will be picked up later when user clicks "Generate" button`);
                    }

                        // Update scene indices
                        try {
                            const totalScenes = parseInt(await redis.get(config.BOOK_SCENE_TOTAL(bookId)) || '0', 10);
                            const nextIdx = parseInt(await redis.get(config.BOOK_SCENE_NEXT(bookId)) || '0', 10);
                            await redis.set(config.BOOK_SCENE_TOTAL(bookId), totalScenes + phScenes.length);
                            await redis.set(config.BOOK_SCENE_NEXT(bookId), nextIdx + phScenes.length);
                            bgLog(`📊 Scene indices updated: total=${totalScenes + phScenes.length} next=${nextIdx + phScenes.length}`);
                        } catch (idxErr) {
                            console.warn(`[BG-GEN] Failed to update scene indices: ${idxErr.message}`);
                        }
                    }
                }

                const finalMsg = `✓ Added ${result.added_scenes || 0} scenes (${chunkCount} chunks created)`;
                bgLog(`✅ ${finalMsg}`);
                await genSessionRepo.updateSession(sessionId, {
                    status: 'completed',
                    progress_msg: finalMsg,
                });
            }

            // — 6. Process next queued session if any —
            const queued = await genSessionRepo.getSessionsByStatus(bookId, 'queued');
            if (queued.length > 0) {
                const nextSession = queued[0];
                bgLog(`🔄 Processing queued window ${nextSession.window_index} (session=${nextSession.id})`);
                await genSessionRepo.updateSession(nextSession.id, { status: 'pending' });
                await runBackgroundWindowGeneration(bookId, nextSession.id);
            } else {
                bgLog(`✅ No queued sessions — done`);
            }
        } catch (err) {
            console.error(`[BG-GEN][${bookId}:${sessionId}] ❌ FAILED:`, err.message);
            await genSessionRepo.updateSession(sessionId, {
                status: 'failed',
                error: err.message,
                progress_msg: `✗ Failed: ${err.message}`,
            }).catch(() => {});
        }
    }

    return {
        runBackgroundWindowGeneration,
    };
};
