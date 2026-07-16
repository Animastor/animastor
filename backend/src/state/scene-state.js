// ======================================================
// Scene State - v2.2.0
// ======================================================
// Per-asset states (animastor:asset-state:*) are the ONLY
// source of truth. SceneState/linear state has been removed.
//
// getSceneState/setSceneState/transitionSceneState are kept
// for backward compatibility with debug routes — they write
// directly to Redis keys but are NOT lifecycle authorities.

const config = require('../config/runtime-config');
const SCENE_STATE_KEY_PREFIX = config.REDIS.SCENE_STATE_KEY_PREFIX;

// ======================================================
// ASSET STATE — canonical per-asset model
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
// STATE QUERY HELPERS (legacy scene-state keys — debug only)
// ======================================================

/**
 * Get scene state from Redis (legacy scene-state key).
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @returns {Promise<object|null>}
 */
async function getSceneState(redis, bookId, chapterId, sceneId) {
    const key = `${SCENE_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`;
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
}

/**
 * Set scene state in Redis (legacy scene-state key).
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {string} state
 * @param {string|null} [error]
 * @returns {Promise<object>}
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
 * Direct state write — legacy scene-state key.
 * Per-asset states are the source of truth.
 */
async function transitionSceneState(redis, bookId, chapterId, sceneId, newState) {
    const currentState = await getSceneState(redis, bookId, chapterId, sceneId);
    const oldState = currentState?.state || 'new';

    await setSceneStateWithBuildId(redis, bookId, chapterId, sceneId, newState, currentState?.build_id || null);

    log(`⚡ SCENE STATE: ${bookId}/${chapterId}/${sceneId}: ${oldState} -> ${newState} (direct write)`);
    return { success: true, oldState, newState, reason: 'direct_write' };
}

// ======================================================
// ASSET STATE OPERATIONS
// ======================================================

/**
 * Per-asset transition validation map.
 */
const AssetTransitions = {
    [AssetState.NEW]: [AssetState.DIRTY, AssetState.PENDING, AssetState.PLACEHOLDER],
    [AssetState.DIRTY]: [AssetState.PENDING, AssetState.PLACEHOLDER],
    [AssetState.PENDING]: [AssetState.GENERATING, AssetState.FAILED],
    [AssetState.GENERATING]: [AssetState.READY, AssetState.FAILED, AssetState.DIRTY],
    [AssetState.READY]: [AssetState.DIRTY],
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
 *
 * Uses HGETALL for atomic read.
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
        warn(`Asset state key ${key} not a hash — deleting stale key: ${e.message}`);
        await redis.del(key).catch(() => {});
    }

    if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length > 0) {
        return {
            audio: raw.audio || AssetState.NEW,
            image: raw.image || AssetState.NEW,
            video: raw.video || AssetState.NEW
        };
    }

    // Fallback: derive from legacy scene-state
    const linearState = await getSceneState(redis, bookId, chapterId, sceneId);
    return deriveAssetStatesFromLinear(linearState);
}

/**
 * Derive asset states from legacy scene-state (fallback).
 * @param {object|null} linearState
 * @returns {{audio: string, image: string, video: string}}
 */
function deriveAssetStatesFromLinear(linearState) {
    if (!linearState || !linearState.state) {
        return { audio: AssetState.NEW, image: AssetState.NEW, video: AssetState.NEW };
    }

    const s = linearState.state;

    if (s === 'failed') {
        return { audio: AssetState.FAILED, image: AssetState.FAILED, video: AssetState.FAILED };
    }
    if (s === 'video_ready') {
        return { audio: AssetState.READY, image: AssetState.READY, video: AssetState.READY };
    }
    if (s === 'new') {
        return { audio: AssetState.NEW, image: AssetState.NEW, video: AssetState.NEW };
    }
    if (s === 'audio_pending' || s === 'audio_generating') {
        return { audio: s === 'audio_generating' ? AssetState.GENERATING : AssetState.PENDING, image: AssetState.NEW, video: AssetState.NEW };
    }
    if (s === 'audio_ready') {
        return { audio: AssetState.READY, image: AssetState.NEW, video: AssetState.NEW };
    }
    if (s === 'image_pending' || s === 'image_generating') {
        return { audio: AssetState.READY, image: s === 'image_generating' ? AssetState.GENERATING : AssetState.PENDING, video: AssetState.NEW };
    }
    if (s === 'image_ready') {
        return { audio: AssetState.READY, image: AssetState.READY, video: AssetState.NEW };
    }
    if (s === 'video_pending' || s === 'video_generating') {
        return { audio: AssetState.READY, image: AssetState.READY, video: s === 'video_generating' ? AssetState.GENERATING : AssetState.PENDING };
    }

    return { audio: AssetState.NEW, image: AssetState.NEW, video: AssetState.NEW };
}

/**
 * Set a single asset's state in the per-asset store.
 * Uses HSET for atomic per-field update.
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
    await redis.hset(key, updates);
    log(`ASSET STATES: ${bookId}/${chapterId}/${sceneId} -> ${JSON.stringify(updates)}`);
    return await getAssetStates(redis, bookId, chapterId, sceneId);
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    SCENE_STATE_KEY_PREFIX,

    // Asset state (canonical)
    AssetState,
    ASSET_STATE_KEY_PREFIX,
    ASSETS,
    getAssetStates,
    setAssetState,
    setAssetStates,
    deriveAssetStatesFromLinear,
    validateAssetTransition,

    // Legacy scene-state (debug/compat only)
    getSceneState,
    setSceneState,
    setSceneStateWithBuildId,
    transitionSceneState,
};
