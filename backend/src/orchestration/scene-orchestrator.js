const state = require('../state');
const audio = require('../audio');
const image = require('../image');
const video = require('../video');
const gpu = require('../runtime/gpu-dispatcher');
const runtimeScheduler = require('../runtime/runtime-scheduler');
const book = require('../book');
const { log, warn, logEvent } = require('./scene-utils');
const { handleAudioCompleted, handleImageCompleted, handleVideoCompleted } = require('./scene-callbacks');
const { restoreSceneChunkStatus } = require('./scene-restoration');
const { completeStage, failStage, setScenePending, setSceneGenerating } = require('./orchestrator');

// ======================================================
// SCENE ORCHESTRATOR
// ======================================================
// Pure dispatch execution: no linear state machine, no stage decisions.
// The dispatch-engine passes overrideStage — the orchestrator just executes.
// Per-asset states (AssetState) are the source of truth.

async function startScene(redis, scene, loadedBook, buildId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    log(`START SCENE: ${bookId}/${chapterId}/${sceneId}`);

    await logEvent(redis, scene, 'SCENE_STARTED', 'audio_pending', {
        buildId, bookId, chapterId, sceneId
    });

    // T7: через фасад — единый владелец PENDING
    await setScenePending(redis, bookId, chapterId, sceneId, 'audio', buildId);
    await runtimeScheduler.addSceneToActiveIndex(redis, bookId, chapterId, sceneId);
    log(`ADDED TO ACTIVE: ${bookId}/${chapterId}/${sceneId}`);

    return { success: true };
}

// T3: Каждый executor возвращает { dispatched: true/false, jobs, reason }
async function executeAudioDispatch(redis, scene, loadedBook, buildId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;
    const dbgStart = Date.now();

    log(`AUDIO_DISPATCH: ${bookId}/${chapterId}/${sceneId}`);

    await logEvent(redis, scene, 'AUDIO_DISPATCHED', 'audio_generating', {
        buildId, dispatchType: 'orchestrator'
    });

    // T7: через фасад — единый владелец GENERATING (audio)
    await setSceneGenerating(redis, bookId, chapterId, sceneId, 'audio');

    // Fallback to disk load when runtime doesn't pass loadedBook
    const bookData = loadedBook || book.loadBook(bookId);
    const sceneData = book.findSceneRuntimeData(bookData, chapterId, sceneId);

    if (!sceneData) {
        warn(`AUDIO_DISPATCH: sceneData not found for ${bookId}/${chapterId}/${sceneId}`);
        return { dispatched: false, jobs: 0, reason: 'scene_not_found' };
    }

    // 🔧 AUDIO-ORCH: Transition PLACEHOLDER_READY → GENERATING
    const audioOrch = require('../services/audio-orchestrator');
    let transResult = await audioOrch.setGenerating(redis, bookId, chapterId, sceneId);

    // 🔧 FIX: Если стейт не существует (no_state), инициализируем PLACEHOLDER_READY
    // и повторяем переход.
    if (!transResult.success && transResult.reason === 'no_state') {
        log(`  🔧 AUDIO_ORCH: state missing for ${bookId}/${chapterId}/${sceneId} — initializing PLACEHOLDER_READY first`);
        const segList = require('../audio/segments').buildSegments(sceneData);
        await audioOrch.initPlaceholderReady(redis, bookId, chapterId, sceneId, buildId, segList.length);
        log(`  🔧 AUDIO_ORCH: initialized PLACEHOLDER_READY with ${segList.length} expected segments`);
        transResult = await audioOrch.setGenerating(redis, bookId, chapterId, sceneId);
    }

    if (!transResult.success) {
        warn(`AUDIO_ORCH: cannot set GENERATING for ${bookId}/${chapterId}/${sceneId}: ${transResult.reason}`);
        // T3: transition rejected — считаем что dispatch не выполнен
        return { dispatched: false, jobs: 0, reason: transResult.reason || 'phase_transition_rejected' };
    }

    const result = await audio.generateSceneAudio(redis, sceneData, bookData, buildId, bookId);

    if (result && result.generated) {
        await audioOrch.setWaitingChunks(redis, bookId, chapterId, sceneId);
        log(`AUDIO_DISPATCHED: ${bookId}/${chapterId}/${sceneId} (${result.chunks || 0} chunks sent)`);
        return { dispatched: true, jobs: result.chunks || 1, reason: null };
    } else if (result && result.reason === 'already_ready') {
        await audioOrch.setDone(redis, bookId, chapterId, sceneId);
        log(`AUDIO_DISPATCH: ${bookId}/${chapterId}/${sceneId} — already ready`);
        // T3.9: cache hit — результат уже готов, не считаем активным dispatch
        return { dispatched: false, jobs: 0, reason: 'already_ready' };
    } else {
        warn(`AUDIO_DISPATCH: generateSceneAudio did not send jobs for ${bookId}/${chapterId}/${sceneId}`);
        return { dispatched: false, jobs: 0, reason: 'no_jobs_generated' };
    }
}

async function executeImageDispatch(redis, scene, loadedBook, buildId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    log(`IMAGE_DISPATCH: ${bookId}/${chapterId}/${sceneId}`);

    await logEvent(redis, scene, 'IMAGE_DISPATCHED', 'image_generating', {
        buildId, dispatchType: 'orchestrator'
    });

    await state.setAssetState(redis, bookId, chapterId, sceneId, 'image', state.AssetState.GENERATING);

    const bookData = loadedBook || book.loadBook(bookId);
    const sceneData = book.findSceneRuntimeData(bookData, chapterId, sceneId);

    if (!sceneData) {
        warn(`IMAGE_DISPATCH: sceneData not found for ${bookId}/${chapterId}/${sceneId}`);
        return { dispatched: false, jobs: 0, reason: 'scene_not_found' };
    }

    // Read dirty unit IDs from PG
    let dirtyUnitIds = new Set();
    try {
        const { getDirtyUnitIds } = require('../storage/postgres/repositories/scene-assets-repo');
        const ids = await getDirtyUnitIds(bookId, chapterId, sceneId);
        if (ids && ids.length > 0) {
            dirtyUnitIds = new Set(ids);
            log(`[DIRTY-UNITS] ${bookId}/${chapterId}/${sceneId}: ${ids.length} dirty unit(s) from PG`);
        }
    } catch (err) {
        warn(`[DIRTY-UNITS] PG read failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
    }

    // T3: generateSceneIUImages возвращает количество отправленных jobs
    let jobsSent = 0;
    try {
        const genResult = await image.generateSceneIUImages(redis, sceneData, bookData, buildId, bookId, dirtyUnitIds);
        jobsSent = (genResult && genResult.jobsSent) || 0;
    } catch (genErr) {
        warn(`IMAGE_DISPATCH: generateSceneIUImages error for ${bookId}/${chapterId}/${sceneId}: ${genErr.message}`);
        return { dispatched: false, jobs: 0, reason: 'generation_error' };
    }

    if (jobsSent > 0) {
        log(`IMAGE_DISPATCHED: ${bookId}/${chapterId}/${sceneId} (${jobsSent} IU job(s) sent)`);
        return { dispatched: true, jobs: jobsSent, reason: null };
    }

    log(`IMAGE_DISPATCH: ${bookId}/${chapterId}/${sceneId} — no jobs sent (cache hit or empty units)`);
    return { dispatched: false, jobs: 0, reason: 'no_jobs_sent' };
}

async function executeVideoDispatch(redis, scene, loadedBook, buildId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    log(`VIDEO_DISPATCH: ${bookId}/${chapterId}/${sceneId}`);

    await logEvent(redis, scene, 'VIDEO_DISPATCHED', 'video_generating', {
        buildId, dispatchType: 'orchestrator'
    });

    await state.setAssetState(redis, bookId, chapterId, sceneId, 'video', state.AssetState.GENERATING);

    const bookData = loadedBook || book.loadBook(bookId);
    const sceneData = book.findSceneRuntimeData(bookData, chapterId, sceneId);

    if (!sceneData) {
        warn(`VIDEO_DISPATCH: sceneData not found for ${bookId}/${chapterId}/${sceneId}`);
        return { dispatched: false, jobs: 0, reason: 'scene_not_found' };
    }

    const wfLoader = require('../workflows/workflow-loader');
    const videoResult = await video.generateVideoAnimation(sceneData, bookData, buildId, wfLoader.workflows);

    if (!videoResult.success) {
        warn(`VIDEO_GENERATION: ${bookId}/${chapterId}/${sceneId} failed: ${videoResult.reason || 'unknown'}`);
        return { dispatched: false, jobs: 0, reason: videoResult.reason || 'generation_failed' };
    }

    const jobSpecs = videoResult.jobSpecs || [];
    if (jobSpecs.length === 0) {
        warn(`VIDEO_GENERATION: ${bookId}/${chapterId}/${sceneId}: no jobSpecs returned`);
        return { dispatched: false, jobs: 0, reason: 'no_job_specs' };
    }

    let sentCount = 0;
    for (const jobSpec of jobSpecs) {
        try {
            await gpu.sendUnified(jobSpec);
            sentCount++;
        } catch (sendErr) {
            warn(`VIDEO_DISPATCH: sendUnified failed for job ${jobSpec.job_id}: ${sendErr.message}`);
        }
    }

    if (sentCount > 0) {
        log(`VIDEO_DISPATCHED: ${bookId}/${chapterId}/${sceneId} (${sentCount}/${jobSpecs.length} job(s) sent)`);
        return { dispatched: true, jobs: sentCount, reason: null };
    }

    warn(`VIDEO_DISPATCH: ${bookId}/${chapterId}/${sceneId}: all sendUnified calls failed`);
    return { dispatched: false, jobs: 0, reason: 'send_failed' };
}

// T4: dispatchStage принимает dispatchId (из dispatch-engine) и передаёт executors
async function dispatchStage(redis, scene, loadedBook, buildId, overrideStage, dispatchId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    log(`DISPATCH: ${bookId}/${chapterId}/${sceneId} (stage=${overrideStage}, dispatch=${dispatchId ? dispatchId.slice(0, 20) : 'none'}...)`);

    const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const isNewScene = !assetStates || (
        assetStates.audio === state.AssetState.NEW &&
        assetStates.image === state.AssetState.NEW &&
        assetStates.video === state.AssetState.NEW
    );
    if (isNewScene) {
        log(`NEW SCENE: ${bookId}/${chapterId}/${sceneId} (asset-state)`);
        await startScene(redis, scene, loadedBook, buildId);
    }

    if (!overrideStage) {
        log(`DECISION: ${bookId}/${chapterId}/${sceneId} -> skip (no override stage)`);
        return { dispatched: false, reason: 'no_override' };
    }

    // T3+T4: пробрасываем реальный результат executor + dispatchId
    let result;
    if (overrideStage === 'audio') {
        result = await executeAudioDispatch(redis, scene, loadedBook, buildId, dispatchId);
    } else if (overrideStage === 'image') {
        result = await executeImageDispatch(redis, scene, loadedBook, buildId, dispatchId);
    } else if (overrideStage === 'video') {
        result = await executeVideoDispatch(redis, scene, loadedBook, buildId, dispatchId);
    } else {
        warn(`DISPATCH: Unknown stage ${overrideStage} for ${bookId}/${chapterId}/${sceneId}`);
        return { dispatched: false, reason: 'unknown_stage' };
    }

    result = result || { dispatched: false, reason: 'no_result', jobs: 0 };
    result.dispatchId = dispatchId; // T4: привязываем dispatchId к результату
    log(`DISPATCH_RESULT: ${bookId}/${chapterId}/${sceneId} ${overrideStage}: dispatched=${result.dispatched}, jobs=${result.jobs}, reason=${result.reason || 'ok'}`);
    return result;
}

module.exports = {
    dispatchStage,
    restoreSceneChunkStatus,
    handleAudioCompleted,
    handleImageCompleted,
    handleVideoCompleted,
    completeStage,
    failStage,
};
