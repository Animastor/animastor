// ======================================================
// Runtime Scheduler - v1.0.0
// ======================================================
// The ONLY authority for scene lifecycle progression.
// Decides WHEN to start stages, NOT HOW.
// Callbacks only register results - scheduler owns progression.

const state = require('../state');
const audio = require('../audio');
const image = require('../image');
const video = require('../video');
const journal = require('../orchestration/event-journal');
const storage = require('../storage');
const dispatchEngine = require('./dispatch-engine');

const logPrefix = '[SCHEDULER]';

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
// CONFIGURATION
// ======================================================

const MAX_CONCURRENT_AUDIO = 3;
const MAX_CONCURRENT_IMAGE = 2;
const MAX_CONCURRENT_VIDEO = 1;

const SCHEDULER_TICK_MS = 5000; // 5 seconds

// ======================================================
// ACTIVE SCENE INDEX
// ======================================================

const ACTIVE_SCENES_KEY = 'animastor:active-scenes';
const AUDIO_IN_PROGRESS_KEY = 'animastor:concurrent-audio';
const IMAGE_IN_PROGRESS_KEY = 'animastor:concurrent-image';
const VIDEO_IN_PROGRESS_KEY = 'animastor:concurrent-video';

/**
 * Add scene to active index when it enters a generating/pending state.
 */
async function addSceneToActiveIndex(redis, bookId, chapterId, sceneId) {
    const sceneKey = `${bookId}:${chapterId}:${sceneId}`;
    const added = await redis.sadd(ACTIVE_SCENES_KEY, sceneKey);
    if (added > 0) {
        log(`+ ACTIVE: ${sceneKey} added to active index`);
    }
}

/**
 * Remove scene from active index when it completes or fails.
 */
async function removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId) {
    const sceneKey = `${bookId}:${chapterId}:${sceneId}`;
    const removed = await redis.srem(ACTIVE_SCENES_KEY, sceneKey);
    if (removed > 0) {
        log(`- ACTIVE: ${sceneKey} removed from active index`);
    }
}

/**
 * Get count of scenes in a specific state (for throttling).
 */
async function getCountInState(redis, stateKey) {
    const count = await redis.get(stateKey);
    return parseInt(count || '0', 10);
}

/**
 * Increment concurrent counter atomically.
 */
async function incrementConcurrent(redis, stateKey) {
    return await redis.incr(stateKey);
}

/**
 * Decrement concurrent counter atomically.
 */
async function decrementConcurrent(redis, stateKey) {
    return await redis.decr(stateKey);
}

/**
 * Check if we can schedule a new stage (respecting concurrency limits).
 */
async function canScheduleStage(redis, stage) {
    switch (stage) {
        case 'audio':
            const audioCount = await getCountInState(redis, AUDIO_IN_PROGRESS_KEY);
            return audioCount < MAX_CONCURRENT_AUDIO;
        case 'image':
            const imageCount = await getCountInState(redis, IMAGE_IN_PROGRESS_KEY);
            return imageCount < MAX_CONCURRENT_IMAGE;
        case 'video':
            const videoCount = await getCountInState(redis, VIDEO_IN_PROGRESS_KEY);
            return videoCount < MAX_CONCURRENT_VIDEO;
        default:
            return true;
    }
}

// ======================================================
// STATE TO STAGE MAPPING
// ======================================================

// Re-export SceneState for convenience
const STATE_TO_STAGE = {
    [state.SceneState.AUDIO_PENDING]: 'audio',
    [state.SceneState.IMAGE_PENDING]: 'image',
    [state.SceneState.VIDEO_PENDING]: 'video'
};

const STAGE_TO_STATE = {
    audio: state.SceneState.AUDIO_PENDING,
    image: state.SceneState.IMAGE_PENDING,
    video: state.SceneState.VIDEO_PENDING
};

// ======================================================
// SCHEDULER API
// ======================================================

/**
 * Get list of all active scenes from the index.
 */
async function getActiveSceneKeys(redis) {
    return await redis.smembers(ACTIVE_SCENES_KEY);
}

/**
 * Remove all active scenes belonging to a specific book.
 * Used when cancelling generation for a book.
 */
async function clearBookFromActiveIndex(redis, bookId) {
    const activeKeys = await getActiveSceneKeys(redis);
    let removed = 0;
    for (const sceneKey of activeKeys) {
        if (sceneKey.startsWith(`${bookId}:`)) {
            await redis.srem(ACTIVE_SCENES_KEY, sceneKey);
            removed++;
        }
    }
    if (removed > 0) {
        log(`CANCEL: removed ${removed} active scenes for book ${bookId}`);
    }
    return removed;
}

/**
 * Parse scene key to extract bookId, chapterId, sceneId.
 */
function parseSceneKey(sceneKey) {
    const parts = sceneKey.split(':');
    if (parts.length !== 3) {
        return null;
    }
    return {
        bookId: parts[0],
        chapterId: parts[1],
        sceneId: parts[2]
    };
}

/**
 * Determine if a scene needs scheduling based on its state.
 * Returns { shouldSchedule: boolean, stage: string | null, reason: string }
 */
function shouldScheduleScene(currentState) {
    const stateName = currentState.state;

    // Already in a generating state - just monitor
    if (stateName.includes('_generating')) {
        return { shouldSchedule: false, stage: null, reason: 'already_generating' };
    }

    // Already at VIDEO_READY or FAILED - skip
    if (stateName === state.SceneState.VIDEO_READY || stateName === state.SceneState.FAILED) {
        return { shouldSchedule: false, stage: null, reason: 'terminal_state' };
    }

    // NEW state — start audio pipeline
    if (stateName === state.SceneState.NEW) {
        return { shouldSchedule: true, stage: 'audio', reason: 'new_scene' };
    }

    // Check pending states
    const stage = STATE_TO_STAGE[stateName];
    if (stage) {
        return { shouldSchedule: true, stage, reason: 'pending' };
    }

    // AUDIO_READY wait for image
    if (stateName === state.SceneState.AUDIO_READY) {
        return { shouldSchedule: true, stage: 'image', reason: 'audio_ready' };
    }

    // IMAGE_READY wait for video
    if (stateName === state.SceneState.IMAGE_READY) {
        return { shouldSchedule: true, stage: 'video', reason: 'image_ready' };
    }

    return { shouldSchedule: false, stage: null, reason: 'no_matching_stage' };
}

/**
 * Register a scene to be managed by scheduler.
 * Adds to active index and records initial state.
 */
async function registerScene(redis, bookId, chapterId, sceneId) {
    const sceneKey = `${bookId}:${chapterId}:${sceneId}`;
    const sceneStateKey = `${state.SCENE_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`;
    
    const currentState = await redis.get(sceneStateKey);
    if (!currentState) {
        log(`REGISTER: State not found for ${sceneKey}, skipping`);
        return false;
    }

    const stateData = JSON.parse(currentState);
    const { shouldSchedule, stage, reason } = shouldScheduleScene(stateData);

    if (shouldSchedule && stage) {
        await addSceneToActiveIndex(redis, bookId, chapterId, sceneId);
        log(`REGISTER: ${sceneKey} added (stage=${stage}, reason=${reason})`);
    } else {
        // Check if already in generating state (should be active)
        if (stateData.state.includes('_generating')) {
            await addSceneToActiveIndex(redis, bookId, chapterId, sceneId);
            log(`REGISTER: ${sceneKey} added (generating_state=${stateData.state})`);
        }
        // Terminal states don't get added to active index
    }

    return true;
}

/**
 * Progress a single scene to its next stage.
 * Returns { success: boolean, nextStage: string | null, completed: boolean }
 */
async function progressScene(redis, bookId, chapterId, sceneId) {
    const sceneKey = `${bookId}:${chapterId}:${sceneId}`;
    const sceneStateKey = `${state.SCENE_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`;

    // Get current state
    const currentStateRaw = await redis.get(sceneStateKey);
    if (!currentStateRaw) {
        warn(`PROGRESS: State not found for ${sceneKey}`);
        return { success: false, nextStage: null, reason: 'no_state' };
    }

    const currentState = JSON.parse(currentStateRaw);
    const currentStage = currentState.state;

    // Check if scene has been stuck too long
    const stuck = await state.isSceneStuck(redis, bookId, chapterId, sceneId);
    if (stuck.isStuck) {
        warn(`PROGRESS: Scene stuck in ${currentStage} for ${stuck.ageMinutes} minutes`);
        // Will be handled by reconciliation engine
        return { success: false, nextStage: null, reason: 'stuck' };
    }

    // Determine next stage
    const { shouldSchedule, stage, reason } = shouldScheduleScene(currentState);

    if (!shouldSchedule) {
        if (currentStage === state.SceneState.VIDEO_READY) {
            // Scene is complete - remove from active index
            await removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId);
            log(`PROGRESS: ${sceneKey} completed - removed from active index`);
            return { success: true, nextStage: null, completed: true };
        }
        return { success: true, nextStage: null, reason: 'no_progression_needed' };
    }

    // Check concurrency limits
    const canSchedule = await canScheduleStage(redis, stage);
    if (!canSchedule) {
        log(`PROGRESS: ${sceneKey} throttled - max concurrent ${stage} reached`);
        return { success: false, nextStage: null, reason: 'throttled' };
    }

    // Increment concurrent counter
    const concurrentKey = {
        audio: AUDIO_IN_PROGRESS_KEY,
        image: IMAGE_IN_PROGRESS_KEY,
        video: VIDEO_IN_PROGRESS_KEY
    }[stage];

    await incrementConcurrent(redis, concurrentKey);
    log(`CONCURRENCY: ${stage} counter incremented: ${concurrentKey}`);

    // Transition to generating state
    const generatingState = {
        audio: state.SceneState.AUDIO_GENERATING,
        image: state.SceneState.IMAGE_GENERATING,
        video: state.SceneState.VIDEO_GENERATING
    }[stage];

    const transitionResult = await state.transitionSceneState(
        redis,
        bookId,
        chapterId,
        sceneId,
        generatingState
    );

    if (!transitionResult.success) {
        // Decrement counter on failure
        await decrementConcurrent(redis, concurrentKey);
        warn(`PROGRESS: Transition failed for ${sceneKey}: ${transitionResult.reason}`);
        return { success: false, nextStage: null, reason: 'transition_failed' };
    }

    // Log to event journal
    await journal.appendSceneEvent(
        redis,
        bookId,
        chapterId,
        sceneId,
        `SCHEDULER_${stage.toUpperCase()}_STARTED`,
        generatingState,
        { scheduler: 'animastor-v1' }
    );

    // Return success - actual execution happens via external orchestration
    log(`PROGRESS: ${sceneKey} ready for ${stage} generation`);
    return { 
        success: true, 
        nextStage: stage, 
        generatingState,
        reason: 'ready_to_dispatch' 
    };
}

/**
 * Process all active scenes.
 * Returns summary of operations.
 */
async function tick(redis, loadedBooks = {}) {
    log('=== RUNTIME SCHEDULER TICK ===');

    // Acquire tick lock for single-flight protection
    const tickLock = await dispatchEngine.acquireSchedulerTickLock(redis);
    if (!tickLock.acquired) {
        log('TICK_SKIPPED: Another tick is still running');
        return {
            skipped: true,
            reason: 'tick_running',
            timestamp: new Date().toISOString()
        };
    }

    const activeKeys = await getActiveSceneKeys(redis);
    const summary = {
        totalActive: activeKeys.length,
        processed: 0,
        dispatched: 0,
        throttled: 0,
        skipped: 0,
        completed: 0,
        stuck: 0,
        errors: []
    };

    for (const sceneKey of activeKeys) {
        const parsed = parseSceneKey(sceneKey);
        if (!parsed) {
            summary.errors.push(`Invalid scene key: ${sceneKey}`);
            continue;
        }

        const { bookId, chapterId, sceneId } = parsed;

        try {
            const result = await attemptDispatch(redis, bookId, chapterId, sceneId, loadedBooks[bookId]);
            summary.processed++;

            if (result.completed) {
                summary.completed++;
            } else if (result.dispatched) {
                summary.dispatched++;
            } else if (result.skip) {
                summary.skipped++;
            } else if (result.reason === 'backpressure' || result.reason === 'throttled') {
                summary.throttled++;
            } else if (result.reason === 'stuck') {
                summary.stuck++;
            } else if (result.success) {
                // No action needed
            } else {
                summary.errors.push(`${result.reason} for ${sceneKey}`);
            }
        } catch (err) {
            summary.errors.push(`Error processing ${sceneKey}: ${err.message}`);
            error(`Tick error for ${sceneKey}: ${err.message}`);
        }
    }

    // Release tick lock
    await dispatchEngine.releaseSchedulerTickLock(redis, tickLock.token);

    log(`=== TICK COMPLETE ===`);
    log(`Active: ${summary.totalActive}, Dispatched: ${summary.dispatched}, Skipped: ${summary.skipped}, Throttled: ${summary.throttled}, Completed: ${summary.completed}`);

    if (summary.errors.length > 0) {
        log(`Errors: ${summary.errors.length}`);
        summary.errors.slice(0, 5).forEach(e => log(`  - ${e}`));
    }

    return summary;
}

/**
 * Get runtime metrics for debugging.
 */
async function getMetrics(redis) {
    const activeCount = await redis.scard(ACTIVE_SCENES_KEY);
    const audioCount = await getCountInState(redis, AUDIO_IN_PROGRESS_KEY);
    const imageCount = await getCountInState(redis, IMAGE_IN_PROGRESS_KEY);
    const videoCount = await getCountInState(redis, VIDEO_IN_PROGRESS_KEY);

    return {
        activeScenes: activeCount,
        concurrent: {
            audio: audioCount,
            image: imageCount,
            video: videoCount
        },
        limits: {
            audio: MAX_CONCURRENT_AUDIO,
            image: MAX_CONCURRENT_IMAGE,
            video: MAX_CONCURRENT_VIDEO
        }
    };
}

// ======================================================
// ATTEMPT DISPATCH (NEW: Uses dispatch engine)
// ======================================================

/**
 * Attempt to dispatch a scene stage using dispatch engine.
 * Returns { dispatched: boolean, skip: boolean, completed: boolean, reason: string }
 */
async function attemptDispatch(redis, bookId, chapterId, sceneId, loadedBook) {
    const sceneKey = `${bookId}:${chapterId}:${sceneId}`;

    // Get current state
    const currentStateRaw = await redis.get(`${state.SCENE_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`);
    if (!currentStateRaw) {
        warn(`DISPATCH: State not found for ${sceneKey}`);
        return { success: false, skip: false, reason: 'no_state' };
    }

    const currentState = JSON.parse(currentStateRaw);
    const currentStage = currentState.state;

    // Complete or failed - remove from active index
    if (currentStage === state.SceneState.VIDEO_READY || currentStage === state.SceneState.FAILED) {
        await removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId);
        log(`COMPLETE: ${sceneKey} - removed from active index`);
        return { completed: true, reason: 'terminal' };
    }

    // Check if scene is stuck
    const stuck = await state.isSceneStuck(redis, bookId, chapterId, sceneId);
    if (stuck.isStuck) {
        warn(`DISPATCH: Scene stuck in ${currentStage} for ${stuck.ageMinutes} minutes`);
        return { success: false, skip: true, reason: 'stuck' };
    }

    // Determine next stage
    const { shouldSchedule, stage, reason } = shouldScheduleScene(currentState);

    if (!shouldSchedule) {
        return { success: true, skip: true, reason: 'no_progression_needed' };
    }

    log(`ATTEMPT_DISPATCH: ${sceneKey} -> ${stage}`);

    // Call dispatch engine
    return await dispatchEngine.dispatchStage(
        redis,
        bookId,
        chapterId,
        sceneId,
        stage,
        loadedBook,
        currentState.build_id || null
    );
}

// ======================================================
// RESTART RECOVERY (Phase 11)
// ======================================================

const runtimePersistence = require('./runtime-persistence');

/**
 * Initialize runtime on startup.
 * Performs recovery from persisted state.
 */
async function initializeRuntime(redis) {
    log('INITIALIZING_RUNTIME');

    // 1. Initiate recovery
    const recovery = await runtimePersistence.initiateRecovery(redis);
    if (!recovery.success) {
        warn(`INITialization skipped: ${recovery.reason}`);
        return recovery;
    }

    // 2. Try to restore from snapshot
    const restoreResult = await runtimePersistence.restoreFromSnapshot(redis);
    if (restoreResult.success) {
        log(`RESTORED_RUNTIME: from snapshot timestamp=${restoreResult.snapshot.timestamp}`);
    } else {
        log('STARTUP: No snapshot available, starting fresh');
    }

    // 3. Verify recovery
    const verification = await runtimePersistence.verifyRecovery(redis);

    // 4. Finalize recovery
    await runtimePersistence.finalizeRecovery(redis, recovery.recoveryId);

    log(`RUNTIME_INITIALIZED: ${verification.activeSceneCount} active scenes restored`);

    return {
        success: true,
        recoveryId: recovery.recoveryId,
        verified: verification
    };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Configuration
    SCHEDULER_TICK_MS,
    MAX_CONCURRENT_AUDIO,
    MAX_CONCURRENT_IMAGE,
    MAX_CONCURRENT_VIDEO,

    // Active scene index
    ACTIVE_SCENES_KEY,
    addSceneToActiveIndex,
    removeSceneFromActiveIndex,
    clearBookFromActiveIndex,
    getActiveSceneKeys,
    parseSceneKey,

    // Scheduling
    registerScene,
    shouldScheduleScene,
    tick,
    getMetrics,

    // Helpers
    incrementConcurrent,
    decrementConcurrent,
    canScheduleStage,

    // Re-exports
    SceneState: state.SceneState,
    STATE_TO_STAGE,
    STAGE_TO_STATE,
    SCENE_STATE_KEY_PREFIX: state.SCENE_STATE_KEY_PREFIX,
    dispatchEngine,

    // Phase 11: Runtime initialization
    initializeRuntime,
    runtimePersistence
};