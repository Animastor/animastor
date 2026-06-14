// ======================================================
// Scene State - v2.0.0
// ======================================================
// DUAL state model:
//   1. Linear FSM (legacy) — single state per scene for backward compatibility
//   2. Per-asset states — independent states for audio/image/video (new)
//
// Per-asset states enable selective regeneration:
//   scene can have audio=ready, image=dirty, video=dirty
//   without going through the full linear pipeline.
//
// Architecture:
//   - Linear state is a DERIVED projection of per-asset states
//   - Per-asset states are the CANONICAL source of truth
//   - All NEW code should use per-asset functions
//   - Linear FSM kept for backward compatibility

const config = require('../config/runtime-config');
const SCENE_STATE_KEY_PREFIX = config.REDIS.SCENE_STATE_KEY_PREFIX;
const SCENE_TRANSITION_LOCK_PREFIX = config.REDIS.SCENE_TRANSITION_LOCK_PREFIX;
const SCENE_TRANSITION_LOCK_TTL = 15; // 15 seconds (can be overridden by config)

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

// Stuck detection thresholds (minutes by state)
const SCENE_STUCK_THRESHOLDS = config.STUCK_THRESHOLDS;

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

/** @type {{ [state: string]: SceneStateValue[] }} */
const SceneTransitions = {
    [SceneState.NEW]: [SceneState.AUDIO_PENDING, SceneState.IMAGE_PENDING],
    [SceneState.AUDIO_PENDING]: [SceneState.AUDIO_GENERATING],
    [SceneState.AUDIO_GENERATING]: [SceneState.AUDIO_READY, SceneState.FAILED],
    [SceneState.AUDIO_READY]: [SceneState.IMAGE_PENDING],
    [SceneState.IMAGE_PENDING]: [SceneState.IMAGE_GENERATING],
    [SceneState.IMAGE_GENERATING]: [SceneState.IMAGE_READY, SceneState.FAILED],
    [SceneState.IMAGE_READY]: [SceneState.VIDEO_PENDING],
    [SceneState.VIDEO_PENDING]: [SceneState.VIDEO_GENERATING],
    [SceneState.VIDEO_GENERATING]: [SceneState.VIDEO_READY, SceneState.FAILED],
    [SceneState.FAILED]: [SceneState.AUDIO_PENDING, SceneState.IMAGE_PENDING, SceneState.VIDEO_PENDING]
};

// Heartbeat timer tracking
const activeHeartbeatTimers = new Map();

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
// TRANSITION LOCK
// ======================================================

/**
 * Acquire transition lock for scene (short-lived, prevents parallel transitions).
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @returns {Promise<LockResult>}
 */
async function acquireTransitionLock(redis, bookId, chapterId, sceneId) {
    const lockKey = `${SCENE_TRANSITION_LOCK_PREFIX}:${bookId}:${chapterId}:${sceneId}`;
    const lockToken = `lock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    const locked = await redis.set(lockKey, lockToken, 'NX', 'EX', SCENE_TRANSITION_LOCK_TTL);
    if (locked) {
        return { acquired: true, lockKey, lockToken };
    }
    return { acquired: false, lockKey: null, lockToken: null };
}

/**
 * Release transition lock (only if owner matches).
 * @param {RedisClient} redis
 * @param {string|null} lockKey
 * @param {string|null} lockToken
 * @returns {Promise<ReleaseResult>}
 */
async function releaseTransitionLock(redis, lockKey, lockToken) {
    if (!lockKey || !lockToken) return { released: false };

    const current = await redis.get(lockKey);
    if (!current) return { released: true, reason: 'already_expired' };

    if (current === lockToken) {
        await redis.del(lockKey);
        return { released: true, reason: 'success' };
    }

    return { released: false, reason: 'token_mismatch' };
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

// ======================================================
// ATOMIC STATE TRANSITION (LUA SCRIPT)
// ======================================================

/**
 * Atomic compare-and-set transition.
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {string|null} expectedState
 * @param {string} targetState
 * @returns {Promise<TransitionResult>}
 */
async function atomicTransitionSceneState(redis, bookId, chapterId, sceneId, expectedState, targetState) {
    const key = `${SCENE_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`;

    const luaScript = `
        local key = KEYS[1]
        local expected = ARGV[1]
        local newState = ARGV[2]
        local now = ARGV[3]

        local current = redis.call('GET', key)

        if not current and expected == 'null' then
            redis.call('SET', key, cjson.encode({
                state = newState,
                updated_at = tonumber(now)
            }))
            return {tostring(true), 'null', newState}
        end

        if current then
            local data = cjson.decode(current)
            if data.state == expected then
                redis.call('SET', key, cjson.encode({
                    state = newState,
                    updated_at = tonumber(now),
                    build_id = data.build_id,
                    error = data.error
                }))
                return {tostring(true), data.state, newState}
            end
            return {tostring(false), data.state, expected}
        end

        return {tostring(false), 'unknown', expected}
    `;

    const result = await redis.eval(luaScript, 1, key,
        expectedState === null ? 'null' : expectedState,
        targetState,
        Date.now().toString()
    );

    const success = result[0] === 'true';
    const oldState = result[1] === 'null' ? null : result[1];
    const newState = result[2];

    if (success) {
        log(`🎯 SCENE STATE: ${bookId}/${chapterId}/${sceneId}: ${oldState} -> ${newState} (atomic)`);
        return { success: true, oldState, newState, reason: 'success', duplicate: false };
    }

    if (oldState === targetState) {
        log(`🔁 DUPLICATE TRANSITION: ${bookId}/${chapterId}/${sceneId}: ${oldState} -> ${targetState} (already at target)`);
        return { success: true, oldState, newState: oldState, reason: 'idempotent_duplicate', duplicate: true };
    }

    warn(`🔒 CAS FAILED: ${bookId}/${chapterId}/${sceneId}: expected=${expectedState}, current=${oldState}`);
    return { success: false, oldState, newState: oldState, reason: 'conflict', duplicate: false };
}

// ======================================================
// TRANSITION LOGIC
// ======================================================

/**
 * Main transition function - wraps atomic CAS with validation and locking.
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {SceneStateValue} newState
 * @returns {Promise<TransitionResult>}
 */
async function transitionSceneState(redis, bookId, chapterId, sceneId, newState) {
    const lockResult = await acquireTransitionLock(redis, bookId, chapterId, sceneId);
    
    if (!lockResult.acquired) {
        log(`⏳ Transition already in progress for scene: ${bookId}/${chapterId}/${sceneId}`);
        return { success: false, oldState: null, newState, reason: 'lock_held' };
    }

    try {
        const currentState = await getSceneState(redis, bookId, chapterId, sceneId);
        const oldState = currentState?.state || SceneState.NEW;

        // Check for idempotent duplicate
        if (oldState === newState) {
            log(`🔁 DUPLICATE TRANSITION: ${bookId}/${chapterId}/${sceneId}: ${oldState} -> ${newState} (already at target)`);
            return { success: true, oldState, newState, reason: 'idempotent_duplicate', duplicate: true };
        }

        // Validate transition
        const validTransitions = SceneTransitions[oldState] || [];
        if (!validTransitions.includes(newState)) {
            error(`❌ SCENE STATE TRANSITION INVALID: ${oldState} -> ${newState} (valid: ${validTransitions.join(', ')})`);
            return { success: false, oldState, newState, reason: 'invalid_transition' };
        }

        // Use atomic CAS
        // Pass null (not 'new') when state doesn't exist, so Lua script can handle it
        const casExpected = currentState ? oldState : null;
        const result = await atomicTransitionSceneState(redis, bookId, chapterId, sceneId, casExpected, newState);

        return result;
    } finally {
        await releaseTransitionLock(redis, lockResult.lockKey, lockResult.lockToken);
    }
}

// ======================================================
// HEARTBEAT MANAGEMENT
// ======================================================

/**
 * Update scene state heartbeat (refresh updated_at timestamp).
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @returns {Promise<boolean>}
 */
async function sceneHeartbeat(redis, bookId, chapterId, sceneId) {
    const key = `${SCENE_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`;

    try {
        const current = await redis.get(key);
        if (!current) {
            warn(`Scene state not found for heartbeat: ${bookId}/${chapterId}/${sceneId}`);
            return false;
        }

        const data = JSON.parse(current);
        data.updated_at = Date.now();
        await redis.set(key, JSON.stringify(data));
        return true;
    } catch (err) {
        error(`Scene heartbeat failed: ${bookId}/${chapterId}/${sceneId}`, err.message);
        return false;
    }
}

/**
 * Start periodic heartbeat timer for a scene.
 * NOTE: This requires redis to be passed from the calling context.
 * The timer calls sceneHeartbeat() to refresh the updated_at timestamp.
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {number} [intervalMs]
 * @returns {NodeJS.Timeout}
 */
function startSceneHeartbeatTimer(redis, bookId, chapterId, sceneId, intervalMs = 30000) {
    const key = `${bookId}:${chapterId}:${sceneId}`;
    const timerId = setInterval(async () => {
        await sceneHeartbeat(redis, bookId, chapterId, sceneId);
    }, intervalMs);

    activeHeartbeatTimers.set(key, timerId);
    log(`🫀 HEARTBEAT START: ${bookId}/${chapterId}/${sceneId} (every ${intervalMs}ms)`);
    return timerId;
}

/**
 * Stop periodic heartbeat timer for a scene.
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @returns {boolean}
 */
function stopSceneHeartbeatTimer(bookId, chapterId, sceneId) {
    const key = `${bookId}:${chapterId}:${sceneId}`;
    const timerId = activeHeartbeatTimers.get(key);

    if (timerId) {
        clearInterval(timerId);
        activeHeartbeatTimers.delete(key);
        log(`🫀 HEARTBEAT STOP: ${bookId}/${chapterId}/${sceneId}`);
        return true;
    }
    return false;
}

// ======================================================
// STUCK DETECTION & RECOVERY
// ======================================================

/**
 * Check if a scene is stuck in a state longer than threshold.
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @returns {Promise<StuckResult>}
 */
async function isSceneStuck(redis, bookId, chapterId, sceneId) {
    const state = await getSceneState(redis, bookId, chapterId, sceneId);

    if (!state || !state.state) {
        return { isStuck: false, reason: 'no_state', state: null, ageMinutes: null };
    }

    const stateName = state.state;
    const thresholdMinutes = SCENE_STUCK_THRESHOLDS[stateName];

    if (!thresholdMinutes) {
        return { isStuck: false, reason: 'no_threshold', state: stateName, ageMinutes: null };
    }

    const now = Date.now();
    const updated_at = state.updated_at || 0;
    const ageMinutes = (now - updated_at) / 60000;

    if (ageMinutes > thresholdMinutes) {
        return {
            isStuck: true,
            reason: `state_${stateName}_exceeded_threshold`,
            state: stateName,
            ageMinutes: Math.floor(ageMinutes),
            threshold: thresholdMinutes
        };
    }

    return { isStuck: false, reason: 'ok', state: stateName, ageMinutes: Math.floor(ageMinutes) };
}

/**
 * Check if scene has active processing (lock/heartbeat).
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @returns {Promise<boolean>}
 */
async function isSceneActivelyProcessing(redis, bookId, chapterId, sceneId) {
    const transitionLockKey = `${SCENE_TRANSITION_LOCK_PREFIX}:${bookId}:${chapterId}:${sceneId}`;
    const audioLockKey = `animastor:audio-scene-lock:${bookId}:${chapterId}:${sceneId}`;
    const videoLockKey = `animastor:video-lock:${bookId}:${chapterId}:${sceneId}`;

    const state = await getSceneState(redis, bookId, chapterId, sceneId);
    if (!state) return false;

    // Check for active heartbeat (< 2 minutes)
    const now = Date.now();
    const heartbeatFresh = (now - (state.updated_at || 0)) < 2 * 60 * 1000;

    // Check for active locks
    const hasTransitionLock = await redis.exists(transitionLockKey);
    const hasAudioLock = await redis.exists(audioLockKey);
    const hasVideoLock = await redis.exists(videoLockKey);

    return !!(heartbeatFresh && (hasTransitionLock || hasAudioLock || hasVideoLock));
}

/**
 * Get pending state for a given stuck state.
 * @param {string} stuckState
 * @returns {SceneStateValue|undefined}
 */
function getRecoveryPendingState(stuckState) {
    const recoveryMap = {
        [SceneState.AUDIO_GENERATING]: SceneState.AUDIO_PENDING,
        [SceneState.AUDIO_PENDING]: SceneState.AUDIO_PENDING,
        [SceneState.IMAGE_GENERATING]: SceneState.IMAGE_PENDING,
        [SceneState.IMAGE_PENDING]: SceneState.IMAGE_PENDING,
        [SceneState.VIDEO_GENERATING]: SceneState.VIDEO_PENDING,
        [SceneState.VIDEO_PENDING]: SceneState.VIDEO_PENDING
    };
    return recoveryMap[stuckState];
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
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @returns {Promise<{audio: string, image: string, video: string}>}
 */
async function getAssetStates(redis, bookId, chapterId, sceneId) {
    const key = `${ASSET_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`;
    const raw = await redis.get(key);

    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            return {
                audio: parsed.audio || AssetState.NEW,
                image: parsed.image || AssetState.NEW,
                video: parsed.video || AssetState.NEW
            };
        } catch (e) {
            warn(`Failed to parse asset states for ${bookId}/${chapterId}/${sceneId}: ${e.message}`);
        }
    }

    // Fallback: derive from linear state (backward compat)
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

    // All assets READY
    return SceneState.VIDEO_READY;
}

/**
 * Set a single asset's state in the per-asset store.
 * Does NOT validate transitions — use transitionAssetState() for that.
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
    const current = await getAssetStates(redis, bookId, chapterId, sceneId);
    const updated = { ...current, [asset]: status };

    await redis.set(key, JSON.stringify(updated));
    log(`ASSET STATE: ${bookId}/${chapterId}/${sceneId} ${asset}: ${current[asset]} -> ${status}`);
    return updated;
}

/**
 * Set multiple asset states at once (atomic).
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
    const current = await getAssetStates(redis, bookId, chapterId, sceneId);
    const updated = { ...current };

    for (const [asset, status] of Object.entries(updates)) {
        if (ASSETS.includes(asset)) {
            updated[asset] = status;
        }
    }

    await redis.set(key, JSON.stringify(updated));
    log(`ASSET STATES: ${bookId}/${chapterId}/${sceneId} -> ${JSON.stringify(updated)}`);
    return updated;
}

// ======================================================
// TRANSITION VALIDATION HELPERS
// ======================================================

function validateTransition(fromState, toState) {
    if (fromState === toState) {
        return { valid: true, reason: 'same_state' };
    }
    const validTransitions = SceneTransitions[fromState] || [];
    if (validTransitions.includes(toState)) {
        return { valid: true };
    }
    return { valid: false, reason: 'invalid_transition', allowed: validTransitions };
}

function isValidTransition(fromState, toState) {
    const validTransitions = SceneTransitions[fromState] || [];
    return validTransitions.includes(toState);
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    SceneState,
    SceneTransitions,
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

    // Validation
    transitionSceneState,
    validateTransition,
    isValidTransition,

    // Heartbeat
    sceneHeartbeat,
    startSceneHeartbeatTimer,
    stopSceneHeartbeatTimer,

    // Stuck detection
    isSceneStuck,
    isSceneActivelyProcessing,
    getRecoveryPendingState,

    // Backwards compatibility aliases
    SCENE_STUCK_THRESHOLDS,
    SCENE_TRANSITION_LOCK_TTL
};
