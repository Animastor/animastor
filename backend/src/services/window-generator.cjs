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
    async function runBackgroundWindowGeneration(bookId, sessionId) {
        log(`[BG-GEN] Starting background window generation for ${bookId}, session=${sessionId}`);

        try {
            // — 1. Mark session as generating + set initial progress —
            await genSessionRepo.updateSession(sessionId, { status: 'generating' });

            // Progress callback: writes progress_msg to PG so frontend can poll /agent-status
            const progress = async (msg) => {
                try {
                    await genSessionRepo.updateSession(sessionId, {
                        progress_msg: msg,
                    });
                } catch (_) { /* non-fatal */ }
            };

            await progress('⟳ Processing next window...');

            // — 2. Bootstrap the next window from source text —
            const result = await txtImporter.bootstrapNextWindow(bookId, progress);

            if (result.all_done) {
                await genSessionRepo.updateSession(sessionId, {
                    status: 'completed',
                    progress_msg: '✓ All text processed',
                });
                await genSessionRepo.setBookCompletionStatus(bookId, 'completed');
                log(`[BG-GEN] ${bookId}: all done after window, completion_status=completed`);
            } else {
                await progress(`⟳ Creating ${result.added_scenes || 0} scenes...`);

                // — 3. Create chunks for each new scene in Redis —
                let chunkCount = 0;
                const buildId = 'default';
                if (result.chapter && result.chapter.scenes) {
                    const phScenes = [];
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
                        } catch (chunkErr) {
                            console.warn(`[BG-GEN] Failed to create chunk ${chunkId}: ${chunkErr.message}`);
                        }
                    }

                    // — 4. Generate placeholder audio —
                    if (phScenes.length > 0) {
                        try {
                            const phResult = await placeholderAudio.ensureAllPlaceholderAudio(buildId, bookId, phScenes);
                            log(`[BG-GEN] Placeholder audio: ${phResult.created} created, ${phResult.skipped} skipped`);
                        } catch (phErr) {
                            console.warn(`[BG-GEN] Placeholder audio failed: ${phErr.message}`);
                        }

                        // — 5. Register scenes for GPU scheduler (critical!) —
                        for (const ps of phScenes) {
                            try {
                                await state.setSceneStateWithBuildId(
                                    redis, bookId, ps.chapter_id, ps.scene_id,
                                    state.SceneState.NEW, buildId
                                );
                                await activeScenes.addActiveScene(
                                    redis, bookId, ps.chapter_id, ps.scene_id
                                );
                            } catch (regErr) {
                                console.warn(`[BG-GEN] Failed to register scene ${ps.chapter_id}/${ps.scene_id}: ${regErr.message}`);
                            }
                        }

                        // Update scene indices
                        try {
                            const totalScenes = parseInt(await redis.get(config.BOOK_SCENE_TOTAL(bookId)) || '0', 10);
                            const nextIdx = parseInt(await redis.get(config.BOOK_SCENE_NEXT(bookId)) || '0', 10);
                            await redis.set(config.BOOK_SCENE_TOTAL(bookId), totalScenes + phScenes.length);
                            await redis.set(config.BOOK_SCENE_NEXT(bookId), nextIdx + phScenes.length);
                        } catch (idxErr) {
                            console.warn(`[BG-GEN] Failed to update scene indices: ${idxErr.message}`);
                        }
                    }
                }

                await genSessionRepo.updateSession(sessionId, {
                    status: 'completed',
                    progress_msg: `✓ Added ${result.added_scenes || 0} scenes (${chunkCount} chunks created)`,
                });
                log(`[BG-GEN] ${bookId}: completed, added ${result.added_scenes || 0} scenes, ${chunkCount} chunks`);
            }

            // — 6. Process next queued session if any —
            const queued = await genSessionRepo.getSessionsByStatus(bookId, 'queued');
            if (queued.length > 0) {
                const nextSession = queued[0];
                log(`[BG-GEN] ${bookId}: processing queued window ${nextSession.window_index}`);
                await genSessionRepo.updateSession(nextSession.id, { status: 'pending' });
                await runBackgroundWindowGeneration(bookId, nextSession.id);
            }
        } catch (err) {
            console.error(`[BG-GEN] ${bookId} FAILED:`, err.message);
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
