const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const state = require('../state');
const audio = require('../audio');
const image = require('../image');
const video = require('../video');
const gpu = require('../runtime/gpu-dispatcher');
const storage = require('../storage');
const runtimeScheduler = require('../runtime/runtime-scheduler');
const book = require('../book');
const placeholderAudio = require('../services/placeholder-audio');
const dispatchEngine = require('../runtime/dispatch-engine');
const { log, warn, error, logEvent } = require('./scene-utils');
const { Stage, determineNextStage } = require('./scene-state-machine');
const { handleAudioCompleted, handleImageCompleted, handleVideoCompleted, completeSceneWithoutVideo, completeSceneWithoutImage } = require('./scene-callbacks');
const { restoreSceneChunkStatus } = require('./scene-restoration');

async function startScene(redis, scene, loadedBook, buildId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    log(`START SCENE: ${bookId}/${chapterId}/${sceneId}`);

    await logEvent(redis, scene, 'SCENE_STARTED', state.SceneState.AUDIO_PENDING, {
        buildId,
        bookId,
        chapterId,
        sceneId
    });

    const result = await state.transitionSceneState(
        redis,
        bookId,
        chapterId,
        sceneId,
        state.SceneState.AUDIO_PENDING
    );

    if (result.success) {
        await runtimeScheduler.addSceneToActiveIndex(redis, bookId, chapterId, sceneId);
        log(`ADDED TO ACTIVE: ${bookId}/${chapterId}/${sceneId}`);
    }

    return result;
}

async function decideStage(redis, scene, loadedBook, buildId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    const currentState = await state.getSceneState(redis, bookId, chapterId, sceneId);
    if (!currentState) {
        error(`Decide stage failed - no state found: ${bookId}/${chapterId}/${sceneId}`);
        return { shouldExecute: false, stage: null, reason: 'no_state' };
    }

    const wfLoader = require('../workflows/workflow-loader');
    const videoAvailable = video.isVideoAvailable(wfLoader.workflows);
    const { stage, reason } = determineNextStage(currentState, videoAvailable);

    if (!stage) {
        if (reason === 'no_video_worker') {
            log(`No video worker — completing scene at IMAGE_READY: ${bookId}/${chapterId}/${sceneId}`);
            await completeSceneWithoutVideo(redis, loadedBook, bookId, chapterId, sceneId, buildId);
            return { shouldExecute: false, stage: null, reason: 'completed_no_video' };
        }
        return { shouldExecute: false, stage: null, reason };
    }

    const workerHealth = require('../runtime/worker-health');
    const workersAlive = await workerHealth.isAvailable(redis, stage);
    if (!workersAlive) {
        log(`NO ${stage.toUpperCase()} WORKERS — deferring: ${bookId}/${chapterId}/${sceneId}`);
        if (stage === Stage.AUDIO) {
            const placeholderService = require('../services/placeholder-audio');
            const hasAudioFile = fs.existsSync(
                audio.getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}.mp3`)
            );
            if (hasAudioFile) {
                log(`Placeholder audio found — completing audio stage without worker: ${bookId}/${chapterId}/${sceneId}`);
                await state.setAssetState(redis, bookId, chapterId, sceneId, 'audio', state.AssetState.PLACEHOLDER);
                await state.setSceneStateWithBuildId(redis, bookId, chapterId, sceneId, state.SceneState.AUDIO_READY, buildId);
                return { shouldExecute: false, stage: null, reason: 'audio_completed_placeholder' };
            }
            return { shouldExecute: false, stage: null, reason: 'no_audio_workers' };
        }
        if (stage === Stage.IMAGE && currentState.state === state.SceneState.AUDIO_READY) {
            log(`Completing without image: ${bookId}/${chapterId}/${sceneId}`);
            await completeSceneWithoutImage(redis, loadedBook, bookId, chapterId, sceneId, buildId);
            return { shouldExecute: false, stage: null, reason: 'completed_no_image' };
        }
        if (stage === Stage.VIDEO && currentState.state === state.SceneState.IMAGE_READY) {
            log(`Completing without video: ${bookId}/${chapterId}/${sceneId}`);
            await completeSceneWithoutVideo(redis, loadedBook, bookId, chapterId, sceneId, buildId);
            return { shouldExecute: false, stage: null, reason: 'completed_no_video' };
        }
        return { shouldExecute: false, stage: null, reason: `no_${stage}_workers` };
    }

    log(`Proceeding with ${stage} for ${bookId}/${chapterId}/${sceneId}`);

    const canSchedule = await runtimeScheduler.canScheduleStage(redis, stage);
    if (!canSchedule) {
        log(`THROTTLED: ${bookId}/${chapterId}/${sceneId} - max concurrent ${stage} reached`);
        return { shouldExecute: false, stage: null, reason: 'throttled' };
    }

    return { shouldExecute: true, stage, reason, currentState };
}

async function executeAudioDispatch(redis, scene, loadedBook, buildId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    log(`AUDIO_DISPATCH: ${bookId}/${chapterId}/${sceneId}`);

    await logEvent(redis, scene, 'AUDIO_DISPATCHED', state.SceneState.AUDIO_GENERATING, {
        buildId,
        dispatchType: 'orchestrator'
    });

    const result = await state.transitionSceneState(
        redis,
        bookId,
        chapterId,
        sceneId,
        state.SceneState.AUDIO_GENERATING
    );

    if (result.success) {
        const sceneData = {
            bookId,
            chapterId,
            sceneId,
            buildId,
            text: scene.scene?.audio?.full_text || scene.scene?.text || '',
            voice: scene.scene?.audio?.voice || 'narrator',
            scene: scene.scene,
            chapter: scene.chapter,
        };
        await audio.dispatchAudioGeneration(redis, sceneData);
        log(`AUDIO_DISPATCHED: ${bookId}/${chapterId}/${sceneId}`);
    } else {
        warn(`AUDIO_DISPATCH FAILED: ${bookId}/${chapterId}/${sceneId} - state transition failed`);
        await dispatchEngine.releaseQuota(redis, 'audio');
        log(`🔻 AUDIO quota released (dispatch fail): ${bookId}/${chapterId}/${sceneId}`);
    }

    return result;
}

async function executeImageDispatch(redis, scene, loadedBook, buildId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    log(`IMAGE_DISPATCH: ${bookId}/${chapterId}/${sceneId}`);

    await logEvent(redis, scene, 'IMAGE_DISPATCHED', state.SceneState.IMAGE_GENERATING, {
        buildId,
        dispatchType: 'orchestrator'
    });

    const result = await state.transitionSceneState(
        redis,
        bookId,
        chapterId,
        sceneId,
        state.SceneState.IMAGE_GENERATING
    );

    if (result.success) {
        const sceneData = {
            bookId,
            chapterId,
            sceneId,
            buildId,
            sceneUnits: scene.scene?.units || [],
            chapterIndex: scene.chapter?.chapter_index || 0,
            book: loadedBook,
            scene: scene.scene,
            chapter: scene.chapter,
        };

        const dispatchResult = await image.dispatchImageGeneration(redis, sceneData);
        if (!dispatchResult.success) {
            warn(`IMAGE_DISPATCH: ${bookId}/${chapterId}/${sceneId} returned failure: ${dispatchResult.reason || 'unknown'}`);
        }
    } else {
        warn(`IMAGE_DISPATCH FAILED: ${bookId}/${chapterId}/${sceneId} - state transition failed`);
        await dispatchEngine.releaseQuota(redis, 'image');
        log(`🔻 IMAGE quota released (dispatch fail): ${bookId}/${chapterId}/${sceneId}`);
    }

    return result;
}

async function executeVideoDispatch(redis, scene, loadedBook, buildId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    log(`VIDEO_DISPATCH: ${bookId}/${chapterId}/${sceneId}`);

    await logEvent(redis, scene, 'VIDEO_DISPATCHED', state.SceneState.VIDEO_GENERATING, {
        buildId,
        dispatchType: 'orchestrator'
    });

    const result = await state.transitionSceneState(
        redis,
        bookId,
        chapterId,
        sceneId,
        state.SceneState.VIDEO_GENERATING
    );

    if (result.success) {
        const sceneData = {
            bookId,
            chapterId,
            sceneId,
            buildId,
            audioPath: storage.filesystem.getSceneAudioPath(
                process.env.OUTPUT_DIR || '/data/output', buildId, bookId, chapterId, sceneId
            ),
            imagePath: image.resolveCanonicalSceneImage(
                '/data/output', buildId, bookId, chapterId, sceneId
            ),
            scene: scene.scene,
        };
        await video.dispatchVideoGeneration(redis, sceneData, loadedBook);
        log(`VIDEO_DISPATCHED: ${bookId}/${chapterId}/${sceneId}`);
    } else {
        warn(`VIDEO_DISPATCH FAILED: ${bookId}/${chapterId}/${sceneId} - state transition failed`);
        await dispatchEngine.releaseQuota(redis, 'video');
        log(`🔻 VIDEO quota released (dispatch fail): ${bookId}/${chapterId}/${sceneId}`);
    }

    return result;
}

async function dispatchStage(redis, scene, loadedBook, buildId, overrideStage = null) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    log(`DISPATCH: ${bookId}/${chapterId}/${sceneId}${overrideStage ? ` (override: ${overrideStage})` : ''}`);

    const currentState = await state.getSceneState(redis, bookId, chapterId, sceneId);
    if (!currentState) {
        log(`NEW SCENE: ${bookId}/${chapterId}/${sceneId}`);
        const started = await startScene(redis, scene, loadedBook, buildId);
        if (!started.success) {
            warn(`START SCENE FAILED: ${bookId}/${chapterId}/${sceneId}`);
        }
    }

    const decision = overrideStage
        ? { shouldExecute: true, stage: overrideStage, reason: 'override' }
        : await decideStage(redis, scene, loadedBook, buildId);

    if (!decision.shouldExecute) {
        log(`DECISION: ${bookId}/${chapterId}/${sceneId} -> skip (${decision.reason})`);
        return { dispatched: false, reason: decision.reason };
    }

    const stageToExecute = decision.stage;

    if (stageToExecute === Stage.AUDIO) {
        await dispatchEngine.acquireQuota(redis, 'audio');
        log(`🔺 AUDIO quota acquired: ${bookId}/${chapterId}/${sceneId}`);
        await runtimeScheduler.markSceneAsDispatched(redis, bookId, chapterId, sceneId);
        await executeAudioDispatch(redis, scene, loadedBook, buildId);
    } else if (stageToExecute === Stage.IMAGE) {
        await dispatchEngine.acquireQuota(redis, 'image');
        log(`🔺 IMAGE quota acquired: ${bookId}/${chapterId}/${sceneId}`);
        await runtimeScheduler.markSceneAsDispatched(redis, bookId, chapterId, sceneId);
        await executeImageDispatch(redis, scene, loadedBook, buildId);
    } else if (stageToExecute === Stage.VIDEO) {
        await dispatchEngine.acquireQuota(redis, 'video');
        log(`🔺 VIDEO quota acquired: ${bookId}/${chapterId}/${sceneId}`);
        await runtimeScheduler.markSceneAsDispatched(redis, bookId, chapterId, sceneId);
        await executeVideoDispatch(redis, scene, loadedBook, buildId);
    }

    return { dispatched: true, stage: stageToExecute, reason: decision.reason };
}

module.exports = {
    dispatchStage,
    restoreSceneChunkStatus,
    handleAudioCompleted,
    handleImageCompleted,
    handleVideoCompleted,
};
