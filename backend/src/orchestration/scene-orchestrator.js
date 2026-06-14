// ======================================================
// Scene Orchestrator - v1.0.0
// ======================================================
// Central orchestrator for scene lifecycle management.
// Lies between scheduler and services.
//
// KEY PRINCIPLE: This module only INSPECTS, DECIDES, and DISPATCHES.
// It does NOT wait for callbacks or trigger cascades.
// Callbacks only register results - scheduler owns progression.
//
// Architecture:
//   callbacks -> register results
//   scheduler -> decide next stage
//   orchestrator -> dispatch execution
//   services -> execute work

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const state = require('../state');
const audio = require('../audio');
const image = require('../image');
const video = require('../video');
const gpu = require('../runtime/gpu-dispatcher');
const journal = require('./event-journal');
const storage = require('../storage');
const runtimeScheduler = require('../runtime/runtime-scheduler');
const book = require('../book');
const placeholderAudio = require('../services/placeholder-audio');
const dispatchEngine = require('../runtime/dispatch-engine');

const logPrefix = '[ORCH]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

function error(msg) {
    console.error(`${logPrefix} ❌ ${msg}`);
}

// ======================================================
// LIFECYCLE STAGES
// ======================================================

const Stage = {
    AUDIO: 'audio',
    IMAGE: 'image',
    VIDEO: 'video'
};

// ======================================================
// ORCHESTRATOR API
// ======================================================

/**
 * Log event to journal.
 */
async function logEvent(redis, scene, type, stateName, details = {}) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    await journal.appendSceneEvent(
        redis,
        bookId,
        chapterId,
        sceneId,
        type,
        stateName,
        details
    );
}

/**
 * Start scene orchestration from scratch.
 * Called only when a new scene is discovered.
 */
async function startScene(redis, scene, loadedBook, buildId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    log(`START SCENE: ${bookId}/${chapterId}/${sceneId}`);

    // Log event to journal
    await logEvent(redis, scene, 'SCENE_STARTED', state.SceneState.AUDIO_PENDING, {
        buildId,
        bookId,
        chapterId,
        sceneId
    });

    // Initial transition to AUDIO_PENDING
    const result = await state.transitionSceneState(
        redis,
        bookId,
        chapterId,
        sceneId,
        state.SceneState.AUDIO_PENDING
    );

    // Add to active scenes index
    if (result.success) {
        await runtimeScheduler.addSceneToActiveIndex(redis, bookId, chapterId, sceneId);
        log(`ADDED TO ACTIVE: ${bookId}/${chapterId}/${sceneId}`);
    }

    return result;
}

/**
 * Determine what stage should execute next based on current state.
 * Pure decision logic - no execution.
 * Returns { stage: string | null, reason: string }
 */
function determineNextStage(currentState, videoAvailable = true) {
    const stateName = currentState.state;

    // NEW → start audio pipeline
    if (stateName === state.SceneState.NEW) {
        return { stage: Stage.AUDIO, reason: 'new_scene' };
    }

    // AUDIO stage (first stage)
    if (stateName === state.SceneState.AUDIO_PENDING) {
        return { stage: Stage.AUDIO, reason: 'first_stage' };
    }

    // AUDIO_READY => IMAGE_PENDING
    if (stateName === state.SceneState.AUDIO_READY) {
        return { stage: Stage.IMAGE, reason: 'audio_ready' };
    }

    // IMAGE_PENDING => IMAGE_GENERATING
    if (stateName === state.SceneState.IMAGE_PENDING) {
        return { stage: Stage.IMAGE, reason: 'image_pending' };
    }

    // IMAGE_READY => VIDEO_PENDING (only if video worker available)
    if (stateName === state.SceneState.IMAGE_READY) {
        if (!videoAvailable) {
            return { stage: null, reason: 'no_video_worker' };
        }
        return { stage: Stage.VIDEO, reason: 'image_ready' };
    }

    // All other states: no automatic progression
    return { stage: null, reason: 'no_progression' };
}

/**
 * Decide which stage to execute for a scene.
 * Returns { shouldExecute: boolean, stage: string | null, reason: string }
 */
async function decideStage(redis, scene, loadedBook, buildId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    // Get current state
    const currentState = await state.getSceneState(redis, bookId, chapterId, sceneId);
    if (!currentState) {
        error(`Decide stage failed - no state found: ${bookId}/${chapterId}/${sceneId}`);
        return { shouldExecute: false, stage: null, reason: 'no_state' };
    }

    // Determine next stage (check if video worker available)
    const wfLoader = require('../workflows/workflow-loader');
    const videoAvailable = video.isVideoAvailable(wfLoader.workflows);
    const { stage, reason } = determineNextStage(currentState, videoAvailable);

    if (!stage) {
        // If no video worker and scene is IMAGE_READY, mark as complete
        if (reason === 'no_video_worker') {
            log(`No video worker — completing scene at IMAGE_READY: ${bookId}/${chapterId}/${sceneId}`);
            await completeSceneWithoutVideo(redis, loadedBook, bookId, chapterId, sceneId, buildId);
            return { shouldExecute: false, stage: null, reason: 'completed_no_video' };
        }
        return { shouldExecute: false, stage: null, reason };
    }

    // Check worker availability via heartbeats
    const workerHealth = require('../runtime/worker-health');
    const workersAlive = await workerHealth.isAvailable(redis, stage);
    if (!workersAlive) {
        log(`NO ${stage.toUpperCase()} WORKERS — deferring: ${bookId}/${chapterId}/${sceneId}`);
        // Audio: if stage is AUDIO and no workers, check for placeholder audio
        // If placeholder exists, complete audio stage so image can proceed
        if (stage === Stage.AUDIO) {
            const placeholderService = require('../services/placeholder-audio');
            const hasAudioFile = fs.existsSync(
                audio.getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}.mp3`)
            );
            if (hasAudioFile) {
                log(`Placeholder audio found — completing audio stage without worker: ${bookId}/${chapterId}/${sceneId}`);
                await state.transitionSceneState(redis, bookId, chapterId, sceneId, state.SceneState.AUDIO_GENERATING);
                await state.transitionSceneState(redis, bookId, chapterId, sceneId, state.SceneState.AUDIO_READY);
                await state.setAssetState(redis, bookId, chapterId, sceneId, 'audio', state.AssetState.PLACEHOLDER);
                return { shouldExecute: false, stage: null, reason: 'audio_completed_placeholder' };
            }
            return { shouldExecute: false, stage: null, reason: 'no_audio_workers' };
        }
        // Image is optional — complete scene at AUDIO_READY if no image workers
        if (stage === Stage.IMAGE && currentState.state === state.SceneState.AUDIO_READY) {
            log(`Completing without image: ${bookId}/${chapterId}/${sceneId}`);
            await completeSceneWithoutImage(redis, loadedBook, bookId, chapterId, sceneId, buildId);
            return { shouldExecute: false, stage: null, reason: 'completed_no_image' };
        }
        // Video is optional — complete scene at IMAGE_READY if no video workers
        if (stage === Stage.VIDEO && currentState.state === state.SceneState.IMAGE_READY) {
            log(`Completing without video: ${bookId}/${chapterId}/${sceneId}`);
            await completeSceneWithoutVideo(redis, loadedBook, bookId, chapterId, sceneId, buildId);
            return { shouldExecute: false, stage: null, reason: 'completed_no_video' };
        }
        return { shouldExecute: false, stage: null, reason: `no_${stage}_workers` };
    }

    // Log that we found a valid stage
    log(`Proceeding with ${stage} for ${bookId}/${chapterId}/${sceneId}`);

    // Check concurrency limits
    const canSchedule = await runtimeScheduler.canScheduleStage(redis, stage);
    if (!canSchedule) {
        log(`THROTTLED: ${bookId}/${chapterId}/${sceneId} - max concurrent ${stage} reached`);
        return { shouldExecute: false, stage: null, reason: 'throttled' };
    }

    return { shouldExecute: true, stage, reason, currentState };
}

/**
 * Execute audio generation dispatch.
 * This is a pure dispatch - returns immediately without waiting.
 */
async function executeAudioDispatch(redis, scene, loadedBook, buildId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    log(`AUDIO_DISPATCH: ${bookId}/${chapterId}/${sceneId}`);

    // Log event to journal
    await logEvent(redis, scene, 'AUDIO_DISPATCHED', state.SceneState.AUDIO_GENERATING, {
        buildId,
        dispatchType: 'orchestrator'
    });

    // Transition to AUDIO_GENERATING
    const result = await state.transitionSceneState(
        redis,
        bookId,
        chapterId,
        sceneId,
        state.SceneState.AUDIO_GENERATING
    );

    // Update per-asset state
    await state.setAssetState(redis, bookId, chapterId, sceneId, 'audio', state.AssetState.GENERATING);

    if (!result.success) {
        await logEvent(redis, scene, 'AUDIO_DISPATCH_FAILED', state.SceneState.AUDIO_GENERATING, {
            reason: 'transition_failed'
        });
        return result;
    }

    // Check if canonical audio already exists AND is real (not placeholder)
    // Placeholder audio is valid MP3 but should NOT prevent real generation.
    // We do NOT delete the placeholder here — instead, buildSceneAudio with
    // force=true (called from mergeSceneAudioChunks) skips the canonical check
    // and always processes chunks, preserving the placeholder until real audio is ready.
    let isReady = await audio.isSceneAudioReady(buildId, bookId, chapterId, sceneId, require('music-metadata'));
    if (isReady) {
        // Double-check: if the audio is placeholder, proceed with real generation
        try {
            const placeholderService = require('../services/placeholder-audio');
            const hasReal = await placeholderService.hasRealAudio(bookId, chapterId, sceneId, buildId);
            if (!hasReal) {
                log(`Audio is placeholder — will regenerate real audio: ${bookId}/${chapterId}/${sceneId}`);
                isReady = false;
            }
        } catch (err) {
            warn(`Failed to check audio realness: ${err.message}`);
            // Conservative: if we can't check, assume placeholder and regenerate
            isReady = false;
        }
    }
    if (isReady) {
        log(`Audio already ready: ${bookId}/${chapterId}/${sceneId}`);

        // Create chunk metadata for existing audio
        const sceneBook = loadedBook || book.loadBook(bookId);
        const sceneData = book.findSceneRuntimeData(sceneBook, chapterId, sceneId);
        if (sceneData) {
            const segments = audio.buildSegments(sceneData);
            const expectedChunkCount = segments.length;
            log(`Creating chunk metadata for ${expectedChunkCount} chunks: ${bookId}/${chapterId}/${sceneId}`);
            log(`Scene data: ${sceneData ? 'found' : 'null'}`);
            log(`buildSegments returned ${segments.length} segments`);
            for (let i = 0; i < expectedChunkCount; i++) {
                const chunkIndex = i + 1;
                const chunkId = audio.makeChunkId(chapterId, sceneId, chunkIndex, bookId);
                const chunkKey = `animastor:chunk:${chunkId}`;
                const existingChunk = await redis.get(chunkKey);
                log(`Chunk ${chunkIndex}/${expectedChunkCount}: ${chunkId}, exists: ${!!existingChunk}`);
                if (!existingChunk) {
                    const chunkData = {
                        build_id: buildId,
                        book_id: bookId,
                        chapter_id: chapterId,
                        scene_id: sceneId,
                        chunk_index: String(chunkIndex).padStart(4, '0'),
                        expected_chunk_count: expectedChunkCount,
                        scene_type: sceneData.scene_type,
                        audio: true,
                        audio_status: 'ready',
                        padded_text: segments[i]?.padded || false
                    };
                    await redis.set(chunkKey, JSON.stringify(chunkData));
                    await redis.sadd(`animastor:chunks:${bookId}`, chunkId);
                    log(`Created chunk metadata: ${chunkId}`);
                } else {
                    // Chunk exists but may have stale 'pending' status from a rebuild.
                    // Update audio_status to 'ready' since the file exists on disk.
                    const existing = JSON.parse(existingChunk);
                    if (existing.audio_status !== 'ready') {
                        existing.audio = true;
                        existing.audio_status = 'ready';
                        await redis.set(chunkKey, JSON.stringify(existing));
                        log(`Updated chunk audio_status to ready: ${chunkId}`);
                    } else {
                        log(`Chunk already exists and ready: ${chunkId}`);
                    }
                    // Ensure padded_text is correct even on existing chunks
                    existing.padded_text = segments[i]?.padded || false;
                    await redis.set(chunkKey, JSON.stringify(existing));
                }
            }
        } else {
            warn(`Scene data not found for chunk metadata creation: ${bookId}/${chapterId}/${sceneId}`);
        }

        // Re-trim canonical audio if scene has short text (padded)
        // The padded_text flag in chunk metadata tells us trimming was needed.
        // If canonical exists from a previous generation where trimming failed,
        // we fix it here unconditionally — double-trim on already-correct audio
        // is harmless for these very short clips (typically <1s total).
        if (sceneData) {
            try {
                const segments = audio.buildSegments(sceneData);
                if (segments.some(s => s.padded)) {
                    const canonPath = audio.getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);
                    if (fs.existsSync(canonPath)) {
                        log(`✂️ Padded scene with existing canonical — trimming: ${bookId}/${chapterId}/${sceneId}`);
                        try {
                            await audio.trimPaddedSceneAudio(canonPath);
                        } catch (trimErr) {
                            warn(`Trim of existing canonical failed: ${trimErr.message}`);
                        }
                    }
                }
            } catch (checkErr) {
                warn(`Failed to check padded status: ${checkErr.message}`);
            }
        }

        await logEvent(redis, scene, 'AUDIO_COMPLETED', state.SceneState.AUDIO_READY, {
            reason: 'already_ready'
        });

        await state.transitionSceneState(
            redis,
            bookId,
            chapterId,
            sceneId,
            state.SceneState.AUDIO_READY
        );

        return { success: true, dispatched: false, alreadyDone: true, nextStage: Stage.IMAGE };
    }

    // Check if chunks exist for merge
    const chunkCheck = audio.allSceneChunksExist(bookId, chapterId, sceneId, buildId, null);
    if (chunkCheck.exists) {
        log(`Executing audio merge: ${bookId}/${chapterId}/${sceneId}`);

        // Check if chunks have padded_text flag — trim duplicated audio before merge
        const chunkIndexes = audio.findExistingSceneChunks(bookId, chapterId, sceneId, buildId);
        if (chunkIndexes.length > 0) {
            const firstChunkId = audio.makeChunkId(chapterId, sceneId, chunkIndexes[0], bookId);
            const firstChunkRaw = await redis.get(`animastor:chunk:${firstChunkId}`);
            if (firstChunkRaw) {
                try {
                    const firstChunk = JSON.parse(firstChunkRaw);
                    if (firstChunk.padded_text) {
                        log(`✂️ executeAudioDispatch: padded text detected — trimming chunks for ${bookId}/${chapterId}/${sceneId}`);
                        for (const idx of chunkIndexes) {
                            const cp = audio.getChunkAudioPath(buildId, bookId, chapterId, sceneId, idx);
                            try {
                                await audio.trimPaddedSceneAudio(cp);
                            } catch (trimErr) {
                                warn(`Trim failed for ${cp}: ${trimErr.message}`);
                            }
                        }
                    }
                } catch (parseErr) {
                    warn(`Failed to parse chunk metadata for padded_text check: ${parseErr.message}`);
                }
            }
        }

        const mergeResult = await audio.mergeSceneAudioChunks(redis, bookId, chapterId, sceneId, buildId, null);
        if (mergeResult) {
            log(`Audio merge successful: ${bookId}/${chapterId}/${sceneId}`);

            // [PRIORITY 3] Clean up failsafe key after successful merge
            const failsafeKey = `animastor:audio-scene-failsafe:${bookId}:${chapterId}:${sceneId}`;
            await redis.del(failsafeKey);
            log(`Failsafe key deleted: ${failsafeKey}`);

            // Validate canonical audio
            const canonicalReady = await audio.isSceneAudioReady(buildId, bookId, chapterId, sceneId);
            if (canonicalReady) {
                // Update PG scene_assets status from 'placeholder' to 'ready'
                try {
                    const audioPath = storage.filesystem.getSceneAudioPath(
                        process.env.OUTPUT_DIR || '/data/output', buildId, bookId, chapterId, sceneId
                    );
                    const mm = require('music-metadata');
                    let realDuration = 0;
                    try {
                        const metadata = await mm.parseFile(audioPath);
                        realDuration = metadata.format.duration || 0;
                    } catch {}
                    await placeholderAudio.replacePlaceholderWithRealAudio(
                        bookId, chapterId, sceneId, buildId, audioPath, realDuration
                    );
                    log(`PG scene_assets updated: placeholder → ready for ${bookId}/${chapterId}/${sceneId}`);
                } catch (e) {
                    warn(`Failed to update PG scene_assets after merge: ${e.message}`);
                }

                await logEvent(redis, scene, 'AUDIO_COMPLETED', state.SceneState.AUDIO_READY, {
                    reason: 'merge_success'
                });

                await state.transitionSceneState(
                    redis,
                    bookId,
                    chapterId,
                    sceneId,
                    state.SceneState.AUDIO_READY
                );

                return { success: true, dispatched: false, alreadyDone: true, nextStage: Stage.IMAGE };
            }
        } else {
            await logEvent(redis, scene, 'AUDIO_FAILED', state.SceneState.AUDIO_GENERATING, {
                reason: 'merge_failed'
            });
        }
    }

    // dispatch to audio service via GPU HUB
    log(`Audio dispatch triggered, generating TTS: ${bookId}/${chapterId}/${sceneId}`);

    try {
        const bookData = loadedBook || book.loadBook(bookId);
        const sceneData = book.findSceneRuntimeData(bookData, chapterId, sceneId);
        if (sceneData) {
            const genResult = await audio.generateSceneAudio(redis, sceneData, bookData, buildId, bookId);
            log(`Audio generation submitted: ${bookId}/${chapterId}/${sceneId}, chunks: ${genResult.expectedChunkCount || 0}`);
        } else {
            error(`Scene runtime data not found: ${bookId}/${chapterId}/${sceneId}`);
            return { success: false, reason: 'scene_data_not_found' };
        }
    } catch (err) {
        error(`Audio generation error: ${err.message}`);
        return { success: false, reason: 'audio_generation_error', error: err.message };
    }
    
    return { success: true, dispatched: true, waiting: true, stage: Stage.AUDIO };
}

/**
 * Execute image generation dispatch.
 * This is a pure dispatch - returns immediately without waiting.
 */
async function executeImageDispatch(redis, scene, loadedBook, buildId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    // Transition to IMAGE_PENDING first
    const result = await state.transitionSceneState(
        redis,
        bookId,
        chapterId,
        sceneId,
        state.SceneState.IMAGE_PENDING
    );

    if (!result.success) {
        return result;
    }

    // Find scene for IU generation
    const bookData = loadedBook || book.loadBook(bookId);
    const sceneData = book.findSceneRuntimeData(bookData, chapterId, sceneId);
    if (!sceneData) {
        error(`Scene not found in loadedBook: ${bookId}/${chapterId}/${sceneId}`);
        return { success: false, reason: 'scene_not_found' };
    }

    // Log dispatch event
    await logEvent(redis, scene, 'IMAGE_DISPATCHED', state.SceneState.IMAGE_PENDING, {
        buildId
    });

    // Generate IU images (sync operation)
    log(`Generating IU images: ${bookId}/${chapterId}/${sceneId}`);
    const imgResult = await image.generateSceneIUImages(redis, sceneData, bookData, buildId, bookId);
    const allCached = imgResult && imgResult.sentCount === 0 && imgResult.cacheHitCount > 0;

    if (allCached) {
        // All IU images already on disk — immediately mark scene complete
        log(`All IU images cached (${imgResult.cacheHitCount}/${imgResult.total}), completing image stage`);
        await state.transitionSceneState(redis, bookId, chapterId, sceneId, state.SceneState.IMAGE_GENERATING);
        await state.transitionSceneState(redis, bookId, chapterId, sceneId, state.SceneState.IMAGE_READY);
        // Update chunk image flags
        const chunkPattern = `animastor:chunk:${bookId}_${chapterId}_${sceneId}_*`;
        let cursor = '0';
        do {
            const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', chunkPattern, 'COUNT', 50);
            cursor = nextCursor;
            for (const key of keys) {
                const raw = await redis.get(key);
                if (raw) {
                    const ch = JSON.parse(raw);
                    if (!ch.image) {
                        ch.image = true;
                        await redis.set(key, JSON.stringify(ch));
                    }
                }
            }
        } while (cursor !== '0');
        // Clean up dispatch lease
        const leaseKey = `animastor:dispatch-lease:${bookId}:${chapterId}:${sceneId}:image`;
        await redis.del(leaseKey);
        log(`Image stage completed from cache: ${bookId}/${chapterId}/${sceneId}`);
        return { success: true, dispatched: false, waiting: false, stage: Stage.IMAGE };
    }

    // Transition to IMAGE_GENERATING to mark dispatch complete
    await state.transitionSceneState(
        redis,
        bookId,
        chapterId,
        sceneId,
        state.SceneState.IMAGE_GENERATING
    );

    // Update per-asset state
    await state.setAssetState(redis, bookId, chapterId, sceneId, 'image', state.AssetState.GENERATING);

    log(`Image dispatch complete (${imgResult.sentCount} sent): ${bookId}/${chapterId}/${sceneId}`);
    
    return { success: true, dispatched: true, waiting: true, stage: Stage.IMAGE };
}

const OUTPUT_DIR = process.env.OUTPUT_DIR || '/data/output';

/**
 * Execute video generation dispatch.
 * This is a pure dispatch - returns immediately without waiting.
 */
async function executeVideoDispatch(redis, scene, loadedBook, buildId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    // Check if video already exists - CACHING CHECK
    const videoPath = `/data/output/${buildId}/${bookId}_${chapterId}_${sceneId}.mp4`;
    const videoCheck = video.validateVideoFile(videoPath);
    
    if (videoCheck.valid) {
        log(`VIDEO CACHE HIT: ${bookId}/${chapterId}/${sceneId} - video already exists`);
        
        // Mark video as ready without dispatching generation
        await logEvent(redis, scene, 'VIDEO_COMPLETED', state.SceneState.VIDEO_READY, {
            reason: 'already_ready',
            path: videoPath,
            size: videoCheck.size
        });
        
        await state.transitionSceneState(
            redis,
            bookId,
            chapterId,
            sceneId,
            state.SceneState.VIDEO_READY
        );
        
        return { success: true, dispatched: false, alreadyDone: true, nextStage: null };
    }

    // Transition to VIDEO_PENDING first
    const result = await state.transitionSceneState(
        redis,
        bookId,
        chapterId,
        sceneId,
        state.SceneState.VIDEO_PENDING
    );

    if (!result.success) {
        return result;
    }

    // Log dispatch event
    await logEvent(redis, scene, 'VIDEO_DISPATCHED', state.SceneState.VIDEO_PENDING, {
        buildId
    });

    // Find scene runtime data for video generation (similar to executeImageDispatch)
    const bookDataVideo = loadedBook || book.loadBook(bookId);
    const sceneData = book.findSceneRuntimeData(bookDataVideo, chapterId, sceneId);
    if (!sceneData) {
        error(`Scene not found for video dispatch: ${bookId}/${chapterId}/${sceneId}`);
        return { success: false, reason: 'scene_not_found' };
    }

    // Generate video (async operation via GPU HUB)
    log(`Generating video: ${bookId}/${chapterId}/${sceneId}`);
    const wfLoader = require('../workflows/workflow-loader');
    const videoResult = await video.generateVideoAnimation(sceneData, bookDataVideo, buildId, wfLoader.workflows);
    
    if (videoResult.success) {
        // Send each workflow group as a separate video job to GPU HUB
        for (const jobSpec of videoResult.jobSpecs) {
            log(`Sending video job to GPU HUB: ${jobSpec.job_id} (${jobSpec.workflow_name || 'unknown'})`);
            await gpu.sendUnified(jobSpec);
            log(`Video job sent: ${jobSpec.job_id}`);
        }

        // Transition to VIDEO_GENERATING so handleVideoCompleted accepts the callback
        await state.transitionSceneState(
            redis,
            bookId,
            chapterId,
            sceneId,
            state.SceneState.VIDEO_GENERATING
        );

        // Update per-asset state
        await state.setAssetState(redis, bookId, chapterId, sceneId, 'video', state.AssetState.GENERATING);

        log(`${videoResult.jobSpecs.length} video job(s) sent for: ${bookId}/${chapterId}/${sceneId}`);
    } else {
        error(`Video generation preparation failed: ${videoResult.reason}`);
        await logEvent(redis, scene, 'VIDEO_FAILED', state.SceneState.VIDEO_PENDING, {
            reason: videoResult.reason
        });
        return { success: false, reason: videoResult.reason };
    }

    // Video generation is async - the callback will handle completion
    log(`Video dispatch complete: ${bookId}/${chapterId}/${sceneId}`);

    return { success: true, dispatched: true, waiting: true, stage: Stage.VIDEO };
}

/**
 * Dispatch the next stage for a scene.
 * Pure dispatch - does NOT wait for completion.
 */
async function dispatchStage(redis, scene, loadedBook, buildId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    const decideResult = await decideStage(redis, scene, loadedBook, buildId);

    if (!decideResult.shouldExecute) {
        log(`No stage to dispatch for ${bookId}/${chapterId}/${sceneId}: ${decideResult.reason}`);
        return { success: true, dispatched: false, reason: decideResult.reason };
    }

    const { stage } = decideResult;

    // Check layer config: skip audio or image dispatch if disabled by user
    if (stage === Stage.AUDIO) {
        const layerKey = `animastor:layer-config:${bookId}`;
        const layerRaw = await redis.get(layerKey);
        if (layerRaw) {
            try {
                const layerConfig = JSON.parse(layerRaw);
                if (layerConfig.audio_enabled === false) {
                    log(`LAYER: audio disabled for ${bookId}, skipping audio dispatch for ${bookId}/${chapterId}/${sceneId}`);
                    // Complete audio stage with placeholder so image/video can proceed
                    await state.transitionSceneState(redis, bookId, chapterId, sceneId, state.SceneState.AUDIO_GENERATING);
                    await state.transitionSceneState(redis, bookId, chapterId, sceneId, state.SceneState.AUDIO_READY);
                    await state.setAssetState(redis, bookId, chapterId, sceneId, 'audio', state.AssetState.PLACEHOLDER);
                    return { success: true, dispatched: false, reason: 'audio_disabled_by_layer' };
                }
            } catch (e) {
                warn(`Failed to parse layer config for ${bookId}: ${e.message}`);
            }
        }
    }

    // Check layer config: skip image dispatch if disabled by user
    if (stage === Stage.IMAGE) {
        const layerKey = `animastor:layer-config:${bookId}`;
        const layerRaw = await redis.get(layerKey);
        if (layerRaw) {
            try {
                const layerConfig = JSON.parse(layerRaw);
                if (layerConfig.image_enabled === false) {
                    log(`LAYER: image disabled for ${bookId}, skipping image dispatch for ${bookId}/${chapterId}/${sceneId}`);
                    await state.transitionSceneState(redis, bookId, chapterId, sceneId, state.SceneState.IMAGE_READY);
                    // Mark all scene chunks as image ready
                    const chunkPrefix = `animastor:chunk:${bookId}_${chapterId}_${sceneId}_`;
                    const allChunks = await redis.keys(`${chunkPrefix}*`);
                    for (const ck of allChunks) {
                        const ch = JSON.parse(await redis.get(ck));
                        if (ch) {
                            ch.image = true;
                            ch.image_status = 'ready';
                            await redis.set(ck, JSON.stringify(ch));
                        }
                    }
                    return { success: true, dispatched: false, reason: 'image_disabled_by_layer' };
                }
            } catch (e) {
                warn(`Failed to parse layer config for ${bookId}: ${e.message}`);
            }
        }
    }

    log(`DISPATCH: ${bookId}/${chapterId}/${sceneId} -> ${stage}`);

    switch (stage) {
        case Stage.AUDIO:
            return await executeAudioDispatch(redis, scene, loadedBook, buildId);
        case Stage.IMAGE:
            return await executeImageDispatch(redis, scene, loadedBook, buildId);
        case Stage.VIDEO:
            return await executeVideoDispatch(redis, scene, loadedBook, buildId);
        default:
            error(`Unknown stage: ${stage}`);
            return { success: false, dispatched: false, reason: 'unknown_stage' };
    }
}

/**
 * Handle audio completed callback.
 * 
 * KEY CHANGE: This callback ONLY:
 * - Validates asset is ready
 * - Registers asset in registry
 * - Logs event to journal
 * - Updates state
 * - Returns { nextStage: string } or { completed: true }
 * 
 * It does NOT call progressScene(). The scheduler loop
 * determines progression.
 */
async function handleAudioCompleted(redis, bookId, chapterId, sceneId, buildId) {
    log(`AUDIO_CALLBACK: ${bookId}/${chapterId}/${sceneId}`);

    // Only proceed if we're in AUDIO_GENERATING state
    const currentState = await state.getSceneState(redis, bookId, chapterId, sceneId);
    if (!currentState || currentState.state !== state.SceneState.AUDIO_GENERATING) {
        warn(`AUDIO_CALLBACK: Invalid state: ${currentState?.state || 'no_state'}`);
        // Still release quota to prevent leaked active counter
        await dispatchEngine.releaseQuota(redis, 'audio');
        log(`🔻 AUDIO quota released (invalid state fallback): ${bookId}/${chapterId}/${sceneId}`);
        return { handled: false, nextStage: null, reason: 'invalid_state' };
    }

    // Validate audio is ready
    const isReady = await audio.isSceneAudioReady(buildId, bookId, chapterId, sceneId, require('music-metadata'));
    if (!isReady) {
        error(`Audio not ready after completion: ${bookId}/${chapterId}/${sceneId}`);
        const scene = { book_id: bookId, chapter_id: chapterId, scene_id: sceneId };
        await logEvent(redis, scene, 'AUDIO_FAILED', state.SceneState.AUDIO_READY, {
            reason: 'not_ready_validation'
        });
        await dispatchEngine.releaseQuota(redis, 'audio');
        log(`🔻 AUDIO quota released (not ready fallback): ${bookId}/${chapterId}/${sceneId}`);
        return { handled: true, nextStage: null, reason: 'audio_not_ready' };
    }

    // Log event to journal
    const scene = { book_id: bookId, chapter_id: chapterId, scene_id: sceneId };
    await logEvent(redis, scene, 'AUDIO_COMPLETED', state.SceneState.AUDIO_READY, {
        buildId
    });

    // Register audio asset in cache manifest (SQLite)
    try {
        const audioPath = storage.filesystem.getSceneAudioPath(
            process.env.OUTPUT_DIR || '/data/output', buildId, bookId, chapterId, sceneId
        );
        await storage.registry.registerSceneAudio(redis, bookId, chapterId, sceneId, {
            canonicalPath: audioPath,
            ready: true
        });
        storage.manifest.recordAsset(bookId, chapterId, sceneId, 'audio', audioPath);
        log(`CACHE-MANIFEST: audio recorded for ${bookId}/${chapterId}/${sceneId}`);
    } catch (err) {
        warn(`Failed to register audio asset: ${err.message}`);
    }

    // Replace placeholder audio with real audio in PostgreSQL
    try {
        const audioPath = storage.filesystem.getSceneAudioPath(
            process.env.OUTPUT_DIR || '/data/output', buildId, bookId, chapterId, sceneId
        );
        const mm = require('music-metadata');
        let realDuration = 0;
        try {
            const metadata = await mm.parseFile(audioPath);
            realDuration = metadata.format.duration || 0;
        } catch {}
        await placeholderAudio.replacePlaceholderWithRealAudio(
            bookId, chapterId, sceneId, buildId, audioPath, realDuration
        );
    } catch (err) {
        warn(`Failed to replace placeholder audio: ${err.message}`);
    }

    // Update per-asset state
    await state.setAssetState(redis, bookId, chapterId, sceneId, 'audio', state.AssetState.READY);

    // Transition to AUDIO_READY
    await state.transitionSceneState(
        redis,
        bookId,
        chapterId,
        sceneId,
        state.SceneState.AUDIO_READY
    );

    // Release dispatch quota so worker pulse stops
    await dispatchEngine.releaseQuota(redis, 'audio');
    log(`🔻 AUDIO quota released (completed): ${bookId}/${chapterId}/${sceneId}`);

    log(`AUDIO_CALLBACK: ${bookId}/${chapterId}/${sceneId} -> AUDIO_READY`);

    // Return next stage decision (scheduler will decide when to execute)
    return { 
        handled: true, 
        nextStage: Stage.IMAGE,
        completed: false 
    };
}

/**
 * Handle image completed callback.
 * 
 * KEY CHANGE: Passive callback - only registers completion.
 * The scheduler decides when to progress to video.
 */
async function handleImageCompleted(redis, bookId, chapterId, sceneId, buildId) {
    log(`IMAGE_CALLBACK: ${bookId}/${chapterId}/${sceneId}`);

    // Only proceed if we're in IMAGE_GENERATING state
    const currentState = await state.getSceneState(redis, bookId, chapterId, sceneId);
    if (!currentState || currentState.state !== state.SceneState.IMAGE_GENERATING) {
        warn(`IMAGE_CALLBACK: Invalid state: ${currentState?.state || 'no_state'}`);
        await dispatchEngine.releaseQuota(redis, 'image');
        log(`🔻 IMAGE quota released (invalid state fallback): ${bookId}/${chapterId}/${sceneId}`);
        return { handled: false, nextStage: null, reason: 'invalid_state' };
    }

    // Check if scene image exists
    const sceneImage = image.resolveCanonicalSceneImage(
        '/data/output',
        buildId,
        bookId,
        chapterId,
        sceneId,
    );

    if (!sceneImage) {
        error(`Scene image not found after completion: ${bookId}/${chapterId}/${sceneId}`);
        const scene = { book_id: bookId, chapter_id: chapterId, scene_id: sceneId };
        await logEvent(redis, scene, 'IMAGE_FAILED', state.SceneState.IMAGE_GENERATING, {
            reason: 'not_found'
        });
        await dispatchEngine.releaseQuota(redis, 'image');
        log(`🔻 IMAGE quota released (not found fallback): ${bookId}/${chapterId}/${sceneId}`);
        return { handled: true, nextStage: null, reason: 'image_not_found' };
    }

    // Get image metadata
    const imageInfo = await image.getImageMetadata(sceneImage);

    // Register image asset in cache manifest (SQLite)
    try {
        await storage.registry.registerSceneImage(redis, bookId, chapterId, sceneId, {
            path: sceneImage,
            width: imageInfo?.width || null,
            height: imageInfo?.height || null,
            ready: true
        });
        storage.manifest.recordAsset(bookId, chapterId, sceneId, 'image', sceneImage);
        log(`CACHE-MANIFEST: image recorded for ${bookId}/${chapterId}/${sceneId}`);
    } catch (err) {
        warn(`Failed to register image asset: ${err.message}`);
    }

    // Log completion event
    const scene = { book_id: bookId, chapter_id: chapterId, scene_id: sceneId };
    await logEvent(redis, scene, 'IMAGE_COMPLETED', state.SceneState.IMAGE_READY, {
        buildId,
        path: sceneImage
    });

    // Update per-asset state
    await state.setAssetState(redis, bookId, chapterId, sceneId, 'image', state.AssetState.READY);

    // Transition to IMAGE_READY
    await state.transitionSceneState(
        redis,
        bookId,
        chapterId,
        sceneId,
        state.SceneState.IMAGE_READY
    );

    // Release dispatch quota so worker pulse stops
    await dispatchEngine.releaseQuota(redis, 'image');
    log(`🔻 IMAGE quota released (completed): ${bookId}/${chapterId}/${sceneId}`);

    log(`IMAGE_CALLBACK: ${bookId}/${chapterId}/${sceneId} -> IMAGE_READY`);

    // Return next stage decision (scheduler will decide when to execute)
    return { 
        handled: true, 
        nextStage: Stage.VIDEO,
        completed: false 
    };
}

/**
 * Handle video completed callback.
 * 
 * KEY CHANGE: Passive callback - only registers completion.
 * The scheduler will remove scene from active index.
 */
async function handleVideoCompleted(redis, bookId, chapterId, sceneId, buildId) {
    log(`VIDEO_CALLBACK: ${bookId}/${chapterId}/${sceneId}`);

    // Only proceed if we're in VIDEO_GENERATING state
    const currentState = await state.getSceneState(redis, bookId, chapterId, sceneId);
    if (!currentState || currentState.state !== state.SceneState.VIDEO_GENERATING) {
        warn(`VIDEO_CALLBACK: Invalid state: ${currentState?.state || 'no_state'}`);
        await dispatchEngine.releaseQuota(redis, 'video');
        log(`🔻 VIDEO quota released (invalid state fallback): ${bookId}/${chapterId}/${sceneId}`);
        return { handled: false, nextStage: null, reason: 'invalid_state' };
    }

    // Check if video exists
    const videoPath = `/data/output/${buildId}/${bookId}_${chapterId}_${sceneId}.mp4`;
    const { valid, duration, metadata } = video.validateVideoFile(videoPath);

    if (!valid) {
        error(`Video not valid after completion: ${bookId}/${chapterId}/${sceneId}`);
        const scene = { book_id: bookId, chapter_id: chapterId, scene_id: sceneId };
        await logEvent(redis, scene, 'VIDEO_FAILED', state.SceneState.VIDEO_GENERATING, {
            reason: 'invalid'
        });
        await dispatchEngine.releaseQuota(redis, 'video');
        log(`🔻 VIDEO quota released (invalid fallback): ${bookId}/${chapterId}/${sceneId}`);
        return { handled: true, nextStage: null, reason: 'video_invalid' };
    }

    // Register video asset in cache manifest (SQLite)
    try {
        await storage.registry.registerSceneVideo(redis, bookId, chapterId, sceneId, {
            path: videoPath,
            duration: duration || null,
            width: metadata?.width || null,
            height: metadata?.height || null,
            ready: true
        });
        storage.manifest.recordAsset(bookId, chapterId, sceneId, 'video', videoPath);
        log(`CACHE-MANIFEST: video recorded for ${bookId}/${chapterId}/${sceneId}`);
    } catch (err) {
        warn(`Failed to register video asset: ${err.message}`);
    }

    // Log completion event
    const scene = { book_id: bookId, chapter_id: chapterId, scene_id: sceneId };
    await logEvent(redis, scene, 'VIDEO_COMPLETED', state.SceneState.VIDEO_READY, {
        buildId,
        path: videoPath,
        duration: duration || 0
    });

    // Update registry
    await video.updateSceneVideoStatus(redis, bookId, chapterId, sceneId, 'ready');

    // Update per-asset state
    await state.setAssetState(redis, bookId, chapterId, sceneId, 'video', state.AssetState.READY);

    // Transition to VIDEO_READY
    await state.transitionSceneState(
        redis,
        bookId,
        chapterId,
        sceneId,
        state.SceneState.VIDEO_READY
    );

    // Release dispatch quota so worker pulse stops
    await dispatchEngine.releaseQuota(redis, 'video');
    log(`🔻 VIDEO quota released (completed): ${bookId}/${chapterId}/${sceneId}`);

    // Remove from active scenes index
    await runtimeScheduler.removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId);
    log(`SCENE COMPLETE: ${bookId}/${chapterId}/${sceneId} - removed from active index`);

    // Auto-slide the window: when the current window is fully complete, start the next batch.
    try {
        const bookData = book.loadBook(bookId);
        const sceneWindow = require('../runtime/scene-window');
        const slide = await sceneWindow.trySlideWindowOnComplete(redis, bookId, bookData, buildId);
        if (slide && slide.started > 0) {
            log(`SCENE-COMPLETE auto-slide: started=${slide.started} remaining=${slide.remaining}`);
        } else if (slide && slide.remaining === 0 && slide.started === 0) {
            log(`SCENE-COMPLETE auto-slide: scope fully complete`);
        }
    } catch (e) {
        warn(`SCENE-COMPLETE auto-slide failed: ${e.message}`);
    }


    return {
        handled: true,
        nextStage: null,
        completed: true
    };
}

// ======================================================
// HELPER: COMPLETE SCENE WITHOUT VIDEO
// ======================================================

/**
 * When no video worker is available, complete the scene at IMAGE_READY.
 * Transitions to READY state, removes from active index, slides window.
 */
async function completeSceneWithoutVideo(redis, loadedBook, bookId, chapterId, sceneId, buildId) {
    log(`Completing scene without video: ${bookId}/${chapterId}/${sceneId}`);

    // Transition through full video chain: pending → generating → ready
    await state.transitionSceneState(redis, bookId, chapterId, sceneId, state.SceneState.VIDEO_PENDING);
    await state.transitionSceneState(redis, bookId, chapterId, sceneId, state.SceneState.VIDEO_GENERATING);
    await state.transitionSceneState(redis, bookId, chapterId, sceneId, state.SceneState.VIDEO_READY);

    await runtimeScheduler.removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId);
    log(`Scene complete (no video): ${bookId}/${chapterId}/${sceneId} - removed from active index`);

    // Auto-slide the window
    try {
        const sceneWindow = require('../runtime/scene-window');
        const slide = await sceneWindow.trySlideWindowOnComplete(redis, bookId, loadedBook, buildId);
        if (slide && slide.started > 0) {
            log(`SCENE-COMPLETE auto-slide: started=${slide.started} remaining=${slide.remaining}`);
        }
    } catch (e) {
        warn(`SCENE-COMPLETE auto-slide failed: ${e.message}`);
    }
}

// ======================================================
// HELPER: COMPLETE SCENE WITHOUT IMAGE
// ======================================================

async function completeSceneWithoutImage(redis, loadedBook, bookId, chapterId, sceneId, buildId) {
    log(`Completing scene without image: ${bookId}/${chapterId}/${sceneId}`);
    await state.transitionSceneState(redis, bookId, chapterId, sceneId, state.SceneState.IMAGE_PENDING);
    await state.transitionSceneState(redis, bookId, chapterId, sceneId, state.SceneState.IMAGE_GENERATING);
    await state.transitionSceneState(redis, bookId, chapterId, sceneId, state.SceneState.IMAGE_READY);
    log(`Scene complete (no image): ${bookId}/${chapterId}/${sceneId}`);

    await runtimeScheduler.removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId);

    // Auto-slide the window
    try {
        const sceneWindow = require('../runtime/scene-window');
        const slide = await sceneWindow.trySlideWindowOnComplete(redis, bookId, loadedBook, buildId);
        if (slide && slide.started > 0) {
            log(`SCENE-COMPLETE auto-slide: started=${slide.started} remaining=${slide.remaining}`);
        }
    } catch (e) {
        warn(`SCENE-COMPLETE auto-slide failed: ${e.message}`);
    }
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Execution dispatch (pure dispatch, no waiting)
    dispatchStage,
    
    // Callback handlers (passive - only register results)
    handleAudioCompleted,
    handleImageCompleted,
    handleVideoCompleted,
};
