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
// HELPERS
// ======================================================

/**
 * Read layer config for a book.
 */
async function getLayerConfig(redis, bookId) {
    const layerKey = `animastor:layer-config:${bookId}`;
    const layerRaw = await redis.get(layerKey);
    if (layerRaw) {
        try { return JSON.parse(layerRaw); } catch (_) {}
    }
    return { audio_enabled: true, image_enabled: true, video_enabled: true };
}

/**
 * Check if scene chunks have images marked as ready on disk.
 * Used when image worker is disabled but video needs to verify images exist.
 */
async function checkChunksHaveImages(redis, bookId, chapterId, sceneId) {
    const chunkPrefix = `animastor:chunk:${bookId}_${chapterId}_${sceneId}_`;
    let cursor = '0';
    let hasImages = false;
    do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${chunkPrefix}*`, 'COUNT', 50);
        cursor = nextCursor;
        for (const key of keys) {
            const raw = await redis.get(key);
            if (raw) {
                try {
                    const ch = JSON.parse(raw);
                    if (ch.image === true && ch.image_status === 'ready') {
                        hasImages = true;
                        break;
                    }
                } catch (_) {}
            }
        }
    } while (cursor !== '0' && !hasImages);
    return hasImages;
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
 * Determine which asset stages need scheduling for a scene.
 * Uses per-asset states as source of truth.
 * Each worker is independent:
 *   - Audio: dispatches if enabled and not ready
 *   - Image: dispatches if enabled and not ready (independent of audio)
 *   - Video: dispatches if enabled, not ready, and image=ready
 *
 * Returns { stages: string[], allDone: boolean }
 */
async function shouldScheduleAssets(redis, bookId, chapterId, sceneId) {
    const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const layerCfg = await getLayerConfig(redis, bookId);

    const audioEnabled = layerCfg.audio_enabled !== false;
    const imageEnabled = layerCfg.image_enabled !== false;
    const videoEnabled = layerCfg.video_enabled !== false;

    // R4.2: Check PG version staleness as secondary dirty detection mechanism.
    // If asset_version < scene_version in PG, the scene needs regeneration
    // even if Redis per-asset states show it as 'ready' (e.g., Redis was flushed
    // or the version bump happened while Redis was offline).
    //
    // This makes PG the source of truth for dirty detection — Redis per-asset
    // states are only a runtime cache that may lag behind reality.
    let pgVersionStale = false;
    try {
        const { query } = require('../storage/postgres/database');
        const verResult = await query(`
            SELECT s.content_version, s.audio_config_version,
                   a.scene_content_version, a.scene_audio_config_version, a.status as asset_status
            FROM scenes s
            LEFT JOIN scene_assets a ON a.book_id = s.book_id
                AND a.chapter_id = s.chapter_id
                AND a.scene_id = s.scene_id
            WHERE s.book_id = $1 AND s.chapter_id = $2 AND s.scene_id = $3
        `, [bookId, chapterId, sceneId]);

        for (const row of verResult.rows) {
            if (row.asset_status === 'ready') {
                // Content version stale
                if (row.scene_content_version != null && row.content_version != null &&
                    row.scene_content_version < row.content_version) {
                    log(`[VERSION-DIRTY] ${bookId}/${chapterId}/${sceneId}: content_version stale (asset=${row.scene_content_version} < scene=${row.content_version})`);
                    pgVersionStale = true;
                }
                // Audio config version stale
                if (row.scene_audio_config_version != null && row.audio_config_version != null &&
                    row.scene_audio_config_version < row.audio_config_version) {
                    log(`[VERSION-DIRTY] ${bookId}/${chapterId}/${sceneId}: audio_config_version stale (asset=${row.scene_audio_config_version} < scene=${row.audio_config_version})`);
                    pgVersionStale = true;
                }
            }
        }
    } catch (err) {
        // PG query failed — fall back to Redis-only detection
        warn(`[VERSION-DIRTY] PG version check failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
    }

    // If version-stale, force the scene into pending state by marking assets
    // as not-ready. The dispatch engine will pick it up.
    if (pgVersionStale) {
        log(`[VERSION-DIRTY] ${bookId}/${chapterId}/${sceneId}: PG version mismatch — resetting per-asset states for dispatch`);
        // Reset per-asset states to PENDING so dispatch engine picks them up.
        // This is safe: the Lua script or fallback won't run here, we just
        // set the asset state directly to trigger dispatch.
        if (audioEnabled && assetStates.audio === state.AssetState.READY) {
            await state.setAssetState(redis, bookId, chapterId, sceneId, 'audio', state.AssetState.DIRTY);
            await state.syncLinearState(redis, bookId, chapterId, sceneId);
        }
        if (imageEnabled && assetStates.image === state.AssetState.READY) {
            await state.setAssetState(redis, bookId, chapterId, sceneId, 'image', state.AssetState.DIRTY);
            await state.syncLinearState(redis, bookId, chapterId, sceneId);
        }
        if (videoEnabled && assetStates.video === state.AssetState.READY) {
            await state.setAssetState(redis, bookId, chapterId, sceneId, 'video', state.AssetState.DIRTY);
            await state.syncLinearState(redis, bookId, chapterId, sceneId);
        }
        // Re-read asset states after reset
        const updatedStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
        Object.assign(assetStates, updatedStates);
    }

    // Check if all enabled assets are in terminal states
    // (after potential version-stale reset above)
    const allDone = (
        (!audioEnabled || assetStates.audio === state.AssetState.READY || assetStates.audio === state.AssetState.FAILED) &&
        (!imageEnabled || assetStates.image === state.AssetState.READY || assetStates.image === state.AssetState.FAILED) &&
        (!videoEnabled || assetStates.video === state.AssetState.READY || assetStates.video === state.AssetState.FAILED)
    );
    if (allDone) return { stages: [], allDone: true };

    const stages = [];

    // Audio: independent — dispatch if not ready and not already generating
    if (audioEnabled &&
        assetStates.audio !== state.AssetState.READY &&
        assetStates.audio !== state.AssetState.FAILED &&
        assetStates.audio !== state.AssetState.GENERATING &&
        assetStates.audio !== state.AssetState.PLACEHOLDER) {
        stages.push('audio');
    }

    // Image: independent of audio — dispatch if not ready and not already generating
    if (imageEnabled &&
        assetStates.image !== state.AssetState.READY &&
        assetStates.image !== state.AssetState.FAILED &&
        assetStates.image !== state.AssetState.GENERATING) {
        stages.push('image');
    }

    // Video: requires image=ready — if images aren't ready, skip silently
    if (videoEnabled &&
        assetStates.video !== state.AssetState.READY &&
        assetStates.video !== state.AssetState.FAILED &&
        assetStates.video !== state.AssetState.GENERATING) {
        let imageReady = assetStates.image === state.AssetState.READY;
        if (!imageReady && !imageEnabled) {
            imageReady = await checkChunksHaveImages(redis, bookId, chapterId, sceneId);
        }
        if (imageReady) {
            stages.push('video');
        }
    }

    return { stages, allDone };
}

/**
 * Legacy: Determine if a scene needs scheduling based on linear FSM state.
 * Kept for backward compatibility. New code should use shouldScheduleAssets.
 */
function shouldScheduleScene(currentState) {
    const stateName = currentState.state;

    if (stateName.includes('_generating')) {
        return { shouldSchedule: false, stage: null, reason: 'already_generating' };
    }
    if (stateName === state.SceneState.VIDEO_READY || stateName === state.SceneState.FAILED) {
        return { shouldSchedule: false, stage: null, reason: 'terminal_state' };
    }
    if (stateName === state.SceneState.NEW) {
        return { shouldSchedule: true, stage: 'audio', reason: 'new_scene' };
    }
    const stage = STATE_TO_STAGE[stateName];
    if (stage) {
        return { shouldSchedule: true, stage, reason: 'pending' };
    }
    if (stateName === state.SceneState.AUDIO_READY) {
        return { shouldSchedule: true, stage: 'image', reason: 'audio_ready' };
    }
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

    // Cache force-dispatch flags per book to avoid redundant Redis calls
    const forceCache = new Map();

    for (const sceneKey of activeKeys) {
        const parsed = parseSceneKey(sceneKey);
        if (!parsed) {
            summary.errors.push(`Invalid scene key: ${sceneKey}`);
            continue;
        }

        const { bookId, chapterId, sceneId } = parsed;

        // Check force-dispatch flag for recently regenerated books (cached per book)
        let force = false;
        if (forceCache.has(bookId)) {
            force = forceCache.get(bookId);
        } else {
            const forceFlag = await redis.get(`animastor:force-dispatch:${bookId}`);
            force = forceFlag === '1';
            forceCache.set(bookId, force);
        }

        try {
            const result = await attemptDispatch(redis, bookId, chapterId, sceneId, loadedBooks[bookId], force);
            summary.processed++;

            if (result.completed) {
                summary.completed++;
            } else if (result.dispatched && result.dispatched > 0) {
                summary.dispatched += result.dispatched;
                if (result.throttled > 0) summary.throttled += result.throttled;
            } else if (result.skip) {
                summary.skipped++;
            } else if (result.throttled > 0) {
                summary.throttled += result.throttled;
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
 * Attempt to dispatch scene stages using per-asset states.
 * Supports independent workers: dispatches ALL eligible stages in one tick.
 * When force=true, any existing lease is cleared before dispatch.
 * Returns { dispatched: number, completed: boolean, reason: string }
 */
async function attemptDispatch(redis, bookId, chapterId, sceneId, loadedBook, force = false) {
    const sceneKey = `${bookId}:${chapterId}:${sceneId}`;

    // Get current linear state for build_id
    const currentStateRaw = await redis.get(`${state.SCENE_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`);
    if (!currentStateRaw) {
        warn(`DISPATCH: State not found for ${sceneKey}`);
        return { success: false, skip: false, reason: 'no_state' };
    }
    const currentState = JSON.parse(currentStateRaw);
    const buildId = currentState.build_id || null;

    // Determine which asset stages need scheduling (from per-asset states)
    const { stages, allDone } = await shouldScheduleAssets(redis, bookId, chapterId, sceneId);

    if (allDone) {
        await removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId);
        log(`COMPLETE: ${sceneKey} (all assets ready) - removed from active index`);
        return { completed: true, reason: 'all_assets_ready' };
    }

    if (stages.length === 0) {
        // Assets are in non-dispatchable states (e.g., generating, placeholder)
        // or video skipped because images not ready
        return { success: true, skip: true, reason: 'no_dispatchable_stages' };
    }

    log(`ATTEMPT_DISPATCH: ${sceneKey} -> stages=[${stages.join(', ')}]${force ? ' (force=true)' : ''}`);

    let dispatched = 0;
    let throttled = 0;

    // Dispatch ALL eligible stages in this tick.
    // Concurrency limits per stage type are handled by dispatch engine.
    for (const stage of stages) {
        const result = await dispatchEngine.dispatchStage(
            redis,
            bookId,
            chapterId,
            sceneId,
            stage,
            loadedBook,
            buildId,
            { force }
        );
        if (result.dispatched) {
            dispatched++;
        } else if (result.reason === 'backpressure' || result.reason === 'throttled') {
            throttled++;
        }
    }

    return { dispatched, throttled, stages: stages.length };
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
    shouldScheduleAssets,
    getLayerConfig,
    checkChunksHaveImages,
    tick,
    getMetrics,

    // Helpers
    incrementConcurrent,
    decrementConcurrent,
    canScheduleStage,

    // Re-exports
    SceneState: state.SceneState,
    AssetState: state.AssetState,
    STATE_TO_STAGE,
    STAGE_TO_STATE,
    SCENE_STATE_KEY_PREFIX: state.SCENE_STATE_KEY_PREFIX,
    dispatchEngine,

    // Phase 11: Runtime initialization
    initializeRuntime,
    runtimePersistence
};