// ======================================================
// Scene State - v2.1.0
// ======================================================
// Per-asset states are the CANONICAL source of truth.
// Linear state (SceneState) is a DERIVED projection kept
// for backward compatibility with Redis consumers.
//
// All NEW code should use per-asset functions (AssetState).
// The linear state transition validation has been REMOVED
// because parallel dispatch requires independent asset states.

const config = require('../config/runtime-config');
const SCENE_STATE_KEY_PREFIX = config.REDIS.SCENE_STATE_KEY_PREFIX;

// ======================================================
// ASSET STATE — NEW per-asset model
// ======================================================

const ASSET_STATE_KEY_PREFIX = 'animastor:asset-state';
const ASSETS = ['audio', 'image', 'video'];

/** @type {{ [name: string]: string }} */
const AssetState = {
    NEW: 'new',
    DIRTY: 'dirty',
    PENDING: 'pending',
    GENERATING: 'generating',
    READY: 'ready',
    FAILED: 'failed',
    PLACEHOLDER: 'placeholder'
};



/** @type {{ [name: string]: SceneStateValue }} */
const SceneState = {
    NEW: 'new',
    AUDIO_PENDING: 'audio_pending',
    AUDIO_GENERATING: 'audio_generating',
    AUDIO_READY: 'audio_ready',
    IMAGE_PENDING: 'image_pending',
    IMAGE_GENERATING: 'image_generating',
    IMAGE_READY: 'image_ready',
    VIDEO_PENDING: 'video_pending',
    VIDEO_GENERATING: 'video_generating',
    VIDEO_READY: 'video_ready',
    FAILED: 'failed'
};




// ======================================================
// LOGGING HELPERS
// ======================================================
const logPrefix = '[STATE]';

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
// STATE QUERY HELPERS
// ======================================================

/**
 * Get scene state from Redis.
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @returns {Promise<SceneStateData|null>}
 */
async function getSceneState(redis, bookId, chapterId, sceneId) {
    const key = `${SCENE_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`;
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
}

/**
 * Set scene state in Redis (overwrites existing state).
 * NOT recommended for lifecycle transitions - use atomicTransitionSceneState() instead.
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {SceneStateValue} state
 * @param {string|null} [error]
 * @returns {Promise<SceneStateData>}
 */
async function setSceneState(redis, bookId, chapterId, sceneId, state, error = null) {
    const key = `${SCENE_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`;
    const data = {
        state,
        updated_at: Date.now(),
        build_id: null,
        error: error || null
    };
    await redis.set(key, JSON.stringify(data));
    return data;
}

async function setSceneStateWithBuildId(redis, bookId, chapterId, sceneId, state, buildId, error = null) {
    const key = `${SCENE_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`;
    const data = {
        state,
        updated_at: Date.now(),
        build_id: buildId || null,
        error: error || null
    };
    await redis.set(key, JSON.stringify(data));
    return data;
}

/**
 * Read current build_id from scene state, preserving it across transitions.
 * Prevents resetting build_id to null when syncing linear state.
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @returns {Promise<string|null>}
 */
async function getSceneBuildId(redis, bookId, chapterId, sceneId) {
    const key = `${SCENE_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`;
    const currentRaw = await redis.get(key);
    if (currentRaw) {
        try {
            const current = JSON.parse(currentRaw);
            return current.build_id || null;
        } catch (_) {}
    }
    return null;
}

// ======================================================
// DIRECT STATE WRITE (replaces validated transitionSceneState)
// ======================================================

/**
 * Direct state write — no validation, no locks, no FSM checks.
 * Simply writes the new state to Redis with updated_at.
 * This is the replacement for the removed transitionSceneState.
 *
 * Per-asset states (not linear state) are the source of truth.
 * Linear state is kept for backward compatibility only.
 */
async function transitionSceneState(redis, bookId, chapterId, sceneId, newState) {
    const currentState = await getSceneState(redis, bookId, chapterId, sceneId);
    const oldState = currentState?.state || SceneState.NEW;

    await setSceneStateWithBuildId(redis, bookId, chapterId, sceneId, newState, currentState?.build_id || null);

    log(`⚡ SCENE STATE: ${bookId}/${chapterId}/${sceneId}: ${oldState} -> ${newState} (direct write)`);
    return { success: true, oldState, newState, reason: 'direct_write' };
}



// ======================================================
// LINEAR STATE SYNC (derived from per-asset)
// ======================================================

/**
 * Sync the linear FSM state from per-asset states.
 * Derives the composite linear state from all three asset states
 * and writes it directly (bypassing FSM validation).
 * This keeps the linear state in sync for backward compatibility
 * while allowing independent asset-level transitions.
 *
 * Call this after every setAssetState() call.
 *
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @returns {Promise<string>} The derived linear state
 */
/**
 * Sync the linear FSM state from per-asset states.
 * PRESERVES build_id from the current state so the scheduler can
 * pass it to dispatch-engine when progressing to the next stage.
 * Without this, syncLinearState would reset build_id to null,
 * causing image/video dispatch to fail with "buildId is null".
 *
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {string|null} [overrideBuildId] — optional build_id to store (overrides existing)
 * @returns {Promise<string>} The derived linear state
 */
async function syncLinearState(redis, bookId, chapterId, sceneId, overrideBuildId = null) {
    const assetStates = await getAssetStates(redis, bookId, chapterId, sceneId);
    const linearState = deriveLinearState(assetStates);

    const buildId = overrideBuildId || await getSceneBuildId(redis, bookId, chapterId, sceneId);
    await setSceneStateWithBuildId(redis, bookId, chapterId, sceneId, linearState, buildId);
    log(`SYNC LINEAR: ${bookId}/${chapterId}/${sceneId} -> ${linearState} (build_id=${buildId}, assets=${JSON.stringify(assetStates)})`);
    return linearState;
}

// ======================================================
// ASSET STATE OPERATIONS
// ======================================================

/**
 * Per-asset transition validation map.
 * Each asset type defines its own allowed transitions.
 */
const AssetTransitions = {
    [AssetState.NEW]: [AssetState.DIRTY, AssetState.PENDING, AssetState.PLACEHOLDER],
    [AssetState.DIRTY]: [AssetState.PENDING, AssetState.PLACEHOLDER],
    [AssetState.PENDING]: [AssetState.GENERATING, AssetState.FAILED],
    [AssetState.GENERATING]: [AssetState.READY, AssetState.FAILED, AssetState.DIRTY],
    [AssetState.READY]: [AssetState.DIRTY],  // dirty is the only valid transition from ready
    [AssetState.FAILED]: [AssetState.PENDING, AssetState.DIRTY],
    [AssetState.PLACEHOLDER]: [AssetState.DIRTY, AssetState.GENERATING]
};

/**
 * Validate per-asset state transition.
 * @param {string} fromState
 * @param {string} toState
 * @returns {{ valid: boolean, reason: string }}
 */
function validateAssetTransition(fromState, toState) {
    if (fromState === toState) {
        return { valid: true, reason: 'same_state' };
    }
    const allowed = AssetTransitions[fromState] || [];
    if (allowed.includes(toState)) {
        return { valid: true, reason: 'valid' };
    }
    return { valid: false, reason: 'invalid_asset_transition', allowed };
}

/**
 * Get all per-asset states for a scene.
 * Returns { audio: 'ready', image: 'ready', video: 'ready' }
 * If no asset states exist, returns defaults based on linear state.
 *
 * Uses HGETALL for atomic read — no race with concurrent HSET writes.
 *
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @returns {Promise<{audio: string, image: string, video: string}>}
 */
async function getAssetStates(redis, bookId, chapterId, sceneId) {
    const key = `${ASSET_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`;

    let raw;
    try {
        raw = await redis.hgetall(key);
    } catch (e) {
        // Key exists but is not a hash (old JSON format or wrong type) — fall through
        warn(`Asset state key ${key} not a hash — falling back to linear state: ${e.message}`);
    }

    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return {
            audio: raw.audio || AssetState.NEW,
            image: raw.image || AssetState.NEW,
            video: raw.video || AssetState.NEW
        };
    }

    // Fallback: derive from linear state (backward compat for missing keys or old JSON format)
    const linearState = await getSceneState(redis, bookId, chapterId, sceneId);
    return deriveAssetStatesFromLinear(linearState);
}

/**
 * Derive asset states from linear FSM state.
 * Used as fallback when no per-asset state exists yet.
 *
 * @param {SceneStateData|null} linearState
 * @returns {{audio: string, image: string, video: string}}
 */
function deriveAssetStatesFromLinear(linearState) {
    if (!linearState || !linearState.state) {
        return { audio: AssetState.NEW, image: AssetState.NEW, video: AssetState.NEW };
    }

    const s = linearState.state;

    // Terminal states
    if (s === SceneState.FAILED) {
        return { audio: AssetState.FAILED, image: AssetState.FAILED, video: AssetState.FAILED };
    }
    if (s === SceneState.VIDEO_READY) {
        return { audio: AssetState.READY, image: AssetState.READY, video: AssetState.READY };
    }

    // Pipeline progression
    if (s === SceneState.NEW) {
        return { audio: AssetState.NEW, image: AssetState.NEW, video: AssetState.NEW };
    }
    if (s === SceneState.AUDIO_PENDING || s === SceneState.AUDIO_GENERATING) {
        return { audio: s === SceneState.AUDIO_GENERATING ? AssetState.GENERATING : AssetState.PENDING, image: AssetState.NEW, video: AssetState.NEW };
    }
    if (s === SceneState.AUDIO_READY) {
        return { audio: AssetState.READY, image: AssetState.NEW, video: AssetState.NEW };
    }
    if (s === SceneState.IMAGE_PENDING || s === SceneState.IMAGE_GENERATING) {
        return { audio: AssetState.READY, image: s === SceneState.IMAGE_GENERATING ? AssetState.GENERATING : AssetState.PENDING, video: AssetState.NEW };
    }
    if (s === SceneState.IMAGE_READY) {
        return { audio: AssetState.READY, image: AssetState.READY, video: AssetState.NEW };
    }
    if (s === SceneState.VIDEO_PENDING || s === SceneState.VIDEO_GENERATING) {
        return { audio: AssetState.READY, image: AssetState.READY, video: s === SceneState.VIDEO_GENERATING ? AssetState.GENERATING : AssetState.PENDING };
    }

    return { audio: AssetState.NEW, image: AssetState.NEW, video: AssetState.NEW };
}

/**
 * Derive linear FSM state from per-asset states.
 * This is the reverse mapping: per-asset → linear state.
 * Used for backward compatibility.
 *
 * @param {{audio: string, image: string, video: string}} assetStates
 * @returns {string} Linear SceneState value
 */
function deriveLinearState(assetStates) {
    const { audio, image, video } = assetStates;

    // If any asset is failed, overall state is FAILED
    if (audio === AssetState.FAILED || image === AssetState.FAILED || video === AssetState.FAILED) {
        return SceneState.FAILED;
    }

    // If all ready → VIDEO_READY
    if (audio === AssetState.READY && image === AssetState.READY && video === AssetState.READY) {
        return SceneState.VIDEO_READY;
    }

    // Follow linear pipeline order: audio → image → video
    // Return the EARLIEST asset that needs processing

    // Audio stage
    if (audio === AssetState.DIRTY) return SceneState.AUDIO_PENDING;
    if (audio === AssetState.PENDING) return SceneState.AUDIO_PENDING;
    if (audio === AssetState.GENERATING) return SceneState.AUDIO_GENERATING;
    if (audio === AssetState.NEW && image === AssetState.NEW && video === AssetState.NEW) return SceneState.NEW;

    // Audio placeholder — allow progression to image
    if (audio === AssetState.PLACEHOLDER) {
        if (image === AssetState.NEW) return SceneState.AUDIO_READY;
        if (image === AssetState.PENDING || image === AssetState.DIRTY) return SceneState.IMAGE_PENDING;
        if (image === AssetState.GENERATING) return SceneState.IMAGE_GENERATING;
        if (image === AssetState.READY) return SceneState.IMAGE_READY;
    }

    // Image stage (audio is either READY or FAILED at this point)
    if (image === AssetState.DIRTY) return SceneState.IMAGE_PENDING;
    if (image === AssetState.PENDING) return SceneState.IMAGE_PENDING;
    if (image === AssetState.GENERATING) return SceneState.IMAGE_GENERATING;

    // Video stage (audio and image are both READY at this point)
    if (video === AssetState.DIRTY) return SceneState.VIDEO_PENDING;
    if (video === AssetState.PENDING) return SceneState.VIDEO_PENDING;
    if (video === AssetState.GENERATING) return SceneState.VIDEO_GENERATING;
    if (video === AssetState.NEW) return SceneState.VIDEO_PENDING;

    // All assets READY
    return SceneState.VIDEO_READY;
}

/**
 * Set a single asset's state in the per-asset store.
 * Uses HSET for atomic per-field update — no RMW race.
 *
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {string} asset — 'audio', 'image', or 'video'
 * @param {string} status — AssetState value
 * @returns {Promise<{audio: string, image: string, video: string}>}
 */
async function setAssetState(redis, bookId, chapterId, sceneId, asset, status) {
    if (!ASSETS.includes(asset)) {
        error(`Invalid asset type: ${asset}. Must be one of: ${ASSETS.join(', ')}`);
        return null;
    }

    const key = `${ASSET_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`;
    // Н.6: Atomic HSET — no GET+merge+SET race
    await redis.hset(key, asset, status);
    log(`ASSET STATE: ${bookId}/${chapterId}/${sceneId} ${asset}: -> ${status}`);
    return await getAssetStates(redis, bookId, chapterId, sceneId);
}

/**
 * Set multiple asset states at once (atomic via HSET).
 *
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {{audio?: string, image?: string, video?: string}} updates
 * @returns {Promise<{audio: string, image: string, video: string}>}
 */
async function setAssetStates(redis, bookId, chapterId, sceneId, updates) {
    const key = `${ASSET_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`;
    // Н.6: Atomic HSET with multiple fields — no GET+merge+SET race
    await redis.hset(key, updates);
    log(`ASSET STATES: ${bookId}/${chapterId}/${sceneId} -> ${JSON.stringify(updates)}`);
    return await getAssetStates(redis, bookId, chapterId, sceneId);
}



// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    SceneState,
    SCENE_STATE_KEY_PREFIX,

    // Asset state (new)
    AssetState,
    ASSET_STATE_KEY_PREFIX,
    ASSETS,
    getAssetStates,
    setAssetState,
    setAssetStates,
    deriveLinearState,
    deriveAssetStatesFromLinear,
    validateAssetTransition,

    // State query
    getSceneState,
    setSceneState,
    setSceneStateWithBuildId,

    // Direct state write (replaces validated transitions)
    transitionSceneState,

    // Linear state sync (derives from per-asset)
    syncLinearState
};
