// ======================================================
// Scene State - v2.2.0
// ======================================================
// Per-asset states (animastor:asset-state:*) are the ONLY
// source of truth. SceneState/linear state has been removed.

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

    // No fallback — legacy scene-state has been removed
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
    // Asset state (canonical)
    AssetState,
    ASSET_STATE_KEY_PREFIX,
    ASSETS,
    getAssetStates,
    setAssetState,
    setAssetStates,
    validateAssetTransition,
};
