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
const { completeStage } = require('./orchestrator');

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

    await logEvent(redis, scene, 'SCENE_STARTED', state.SceneState.AUDIO_PENDING, {
        buildId, bookId, chapterId, sceneId
    });

    // M5 Шаг 3: syncLinearState в начале beginStage, не здесь
    await state.setAssetState(redis, bookId, chapterId, sceneId, 'audio', state.AssetState.PENDING);
    await runtimeScheduler.addSceneToActiveIndex(redis, bookId, chapterId, sceneId);
    log(`ADDED TO ACTIVE: ${bookId}/${chapterId}/${sceneId}`);

    return { success: true };
}

async function executeAudioDispatch(redis, scene, loadedBook, buildId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    log(`AUDIO_DISPATCH: ${bookId}/${chapterId}/${sceneId}`);

    await logEvent(redis, scene, 'AUDIO_DISPATCHED', state.SceneState.AUDIO_GENERATING, {
        buildId, dispatchType: 'orchestrator'
    });

    // §5.1: Set per-asset state to generating so callbacks can validate correctly
    // M5 Шаг 3: syncLinearState в beginStage, не здесь
    await state.setAssetState(redis, bookId, chapterId, sceneId, 'audio', state.AssetState.GENERATING);

    // 🔧 AUDIO-ORCH: Transition PLACEHOLDER_READY → GENERATING
    const audioOrch = require('../services/audio-orchestrator');
    const transResult = await audioOrch.setGenerating(redis, bookId, chapterId, sceneId);
    if (!transResult.success) {
        warn(`AUDIO_ORCH: cannot set GENERATING for ${bookId}/${chapterId}/${sceneId}: ${transResult.reason}`);
        return;
    }

    // 🧹 Delete placeholder merged audio file so triggerAudioMerge
    // doesn't exit early when it sees a merged file before all chunks arrive.
    const fs = require('fs');
    const path = require('path');
    const OUTPUT_DIR = process.env.OUTPUT_DIR || '/data/output';
    const mergedPath = path.join(OUTPUT_DIR, buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);
    if (fs.existsSync(mergedPath)) {
        try {
            fs.unlinkSync(mergedPath);
            log(`  🗑 Deleted placeholder merged audio before TTS: ${mergedPath}`);
        } catch (e) {
            warn(`  ⚠️ Failed to delete placeholder merged audio: ${e.message}`);
        }
    }

    // Fallback to disk load when runtime doesn't pass loadedBook
    const bookData = loadedBook || book.loadBook(bookId);
    const sceneData = book.findSceneRuntimeData(bookData, chapterId, sceneId);
    if (sceneData) {
        const result = await audio.generateSceneAudio(redis, sceneData, bookData, buildId, bookId);

        if (result && result.generated) {
            // TTS был отправлен — transition to WAITING_CHUNKS
            await audioOrch.setWaitingChunks(redis, bookId, chapterId, sceneId);
            log(`AUDIO_ORCH: ${bookId}/${chapterId}/${sceneId} → WAITING_CHUNKS (expected=${result.expectedChunkCount})`);
        } else if (result && result.reason === 'already_ready') {
            // Аудио уже готово — transition directly to DONE
            await audioOrch.setDone(redis, bookId, chapterId, sceneId);
            log(`AUDIO_ORCH: ${bookId}/${chapterId}/${sceneId} → DONE (already ready)`);
        }

        log(`AUDIO_DISPATCHED: ${bookId}/${chapterId}/${sceneId}`);
    } else {
        warn(`AUDIO_DISPATCH: sceneData not found for ${bookId}/${chapterId}/${sceneId}`);
    }
}

async function executeImageDispatch(redis, scene, loadedBook, buildId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    log(`IMAGE_DISPATCH: ${bookId}/${chapterId}/${sceneId}`);

    await logEvent(redis, scene, 'IMAGE_DISPATCHED', state.SceneState.IMAGE_GENERATING, {
        buildId, dispatchType: 'orchestrator'
    });

    // §5.1: Set per-asset state to generating so callbacks can validate correctly
    // M5 Шаг 3: syncLinearState в beginStage, не здесь
    await state.setAssetState(redis, bookId, chapterId, sceneId, 'image', state.AssetState.GENERATING);

    // Fallback to disk load when runtime doesn't pass loadedBook
    const bookData = loadedBook || book.loadBook(bookId);
    const sceneData = book.findSceneRuntimeData(bookData, chapterId, sceneId);
    if (sceneData) {
        // Read dirty unit IDs from PG — these are set by /regenerate when
        // a visual prompt is edited. Without this, processSingleIU will see
        // old images on disk (cache hit) and skip GPU dispatch, leaving
        // image: pending forever.
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

        await image.generateSceneIUImages(redis, sceneData, bookData, buildId, bookId, dirtyUnitIds);
        log(`IMAGE_DISPATCHED: ${bookId}/${chapterId}/${sceneId}`);
    } else {
        warn(`IMAGE_DISPATCH: sceneData not found for ${bookId}/${chapterId}/${sceneId}`);
    }
}

async function executeVideoDispatch(redis, scene, loadedBook, buildId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    log(`VIDEO_DISPATCH: ${bookId}/${chapterId}/${sceneId}`);

    await logEvent(redis, scene, 'VIDEO_DISPATCHED', state.SceneState.VIDEO_GENERATING, {
        buildId, dispatchType: 'orchestrator'
    });

    // §5.1: Set per-asset state to generating so callbacks can validate correctly
    // M5 Шаг 3: syncLinearState в beginStage, не здесь
    await state.setAssetState(redis, bookId, chapterId, sceneId, 'video', state.AssetState.GENERATING);

    // Fallback to disk load when runtime doesn't pass loadedBook
    const bookData = loadedBook || book.loadBook(bookId);
    const sceneData = book.findSceneRuntimeData(bookData, chapterId, sceneId);
    if (sceneData) {
        const wfLoader = require('../workflows/workflow-loader');
        const videoResult = await video.generateVideoAnimation(sceneData, bookData, buildId, wfLoader.workflows);
        if (videoResult.success && videoResult.jobSpecs) {
            for (const jobSpec of videoResult.jobSpecs) {
                await gpu.sendUnified(jobSpec);
            }
            log(`VIDEO_DISPATCHED: ${bookId}/${chapterId}/${sceneId} (${videoResult.jobSpecs.length} job(s))`);
        } else {
            warn(`VIDEO_GENERATION: ${bookId}/${chapterId}/${sceneId} failed: ${videoResult.reason || 'unknown'}`);
        }
    } else {
        warn(`VIDEO_DISPATCH: sceneData not found for ${bookId}/${chapterId}/${sceneId}`);
    }
}

async function dispatchStage(redis, scene, loadedBook, buildId, overrideStage) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    log(`DISPATCH: ${bookId}/${chapterId}/${sceneId} (stage=${overrideStage})`);

    const currentState = await state.getSceneState(redis, bookId, chapterId, sceneId);
    if (!currentState) {
        log(`NEW SCENE: ${bookId}/${chapterId}/${sceneId}`);
        await startScene(redis, scene, loadedBook, buildId);
    }

    if (!overrideStage) {
        log(`DECISION: ${bookId}/${chapterId}/${sceneId} -> skip (no override stage)`);
        return { dispatched: false, reason: 'no_override' };
    }

    if (overrideStage === 'audio') {
        await executeAudioDispatch(redis, scene, loadedBook, buildId);
    } else if (overrideStage === 'image') {
        await executeImageDispatch(redis, scene, loadedBook, buildId);
    } else if (overrideStage === 'video') {
        await executeVideoDispatch(redis, scene, loadedBook, buildId);
    } else {
        warn(`DISPATCH: Unknown stage ${overrideStage} for ${bookId}/${chapterId}/${sceneId}`);
        return { dispatched: false, reason: 'unknown_stage' };
    }

    return { dispatched: true, stage: overrideStage, reason: 'override' };
}

module.exports = {
    dispatchStage,
    restoreSceneChunkStatus,
    handleAudioCompleted,
    handleImageCompleted,
    handleVideoCompleted,
    completeStage,
};
