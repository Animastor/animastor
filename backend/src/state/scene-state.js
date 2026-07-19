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
const ASSET_STATES = new Set(Object.values(AssetState));

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
 * ⚠️ UNSAFE (S2, 2026-07-19): use ONLY for restore from disk snapshot,
 *    startup recovery, or debug routes. Lifecycle transitions MUST go
 *    through orchestrator facade (orchestrator.completeStage / failStage /
 *    markDirtyScene / markGenerating / ...). Facade owns validateAssetTransition
 *    and journal events.
 *
 * Whitelist of files allowed to call unsafe* (lint convention, S2.4):
 *   - backend/src/orchestration/orchestrator.js   (facade itself)
 *   - backend/src/orchestration/scene-restoration.js   (disk restore)
 *   - backend/src/services/startup-recovery.js    (startup restore)
 *   - backend/src/runtime/runtime-persistence.js  (snapshot restore)
 *   - backend/src/services/book-diff.cjs          (reset to PENDING on diff)
 *   - backend/src/helpers/redis-helpers.cjs       (book-wide restore)
 *   - backend/src/routes/debug-routes.cjs         (debug endpoints)
 *
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {string} asset — 'audio', 'image', or 'video'
 * @param {string} status — AssetState value
 * @returns {Promise<{audio: string, image: string, video: string}>}
 */
async function unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, asset, status) {
    if (!ASSETS.includes(asset)) {
        error(`Invalid asset type: ${asset}. Must be one of: ${ASSETS.join(', ')}`);
        return null;
    }
    if (!ASSET_STATES.has(status)) {
        error(`Invalid asset status: ${status}. Must be one of: ${[...ASSET_STATES].join(', ')}`);
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
 * ⚠️ UNSAFE (S2, 2026-07-19): use ONLY for restore from disk snapshot,
 *    startup recovery, or debug routes. Lifecycle transitions MUST go
 *    through orchestrator facade.
 *
 * @param {RedisClient} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {{audio?: string, image?: string, video?: string}} updates
 * @returns {Promise<{audio: string, image: string, video: string}>}
 */
async function unsafeRestoreAssetStates(redis, bookId, chapterId, sceneId, updates) {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        error('Invalid asset state updates: expected an object');
        return null;
    }
    for (const [asset, status] of Object.entries(updates)) {
        if (!ASSETS.includes(asset)) {
            error(`Invalid asset type: ${asset}. Must be one of: ${ASSETS.join(', ')}`);
            return null;
        }
        if (!ASSET_STATES.has(status)) {
            error(`Invalid asset status for ${asset}: ${status}. Must be one of: ${[...ASSET_STATES].join(', ')}`);
            return null;
        }
    }

    const key = `${ASSET_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`;
    await redis.hset(key, updates);
    log(`ASSET STATES: ${bookId}/${chapterId}/${sceneId} -> ${JSON.stringify(updates)}`);
    return await getAssetStates(redis, bookId, chapterId, sceneId);
}

// ── DEPRECATED ALIASES (S2) ───────────────────────────────
// Оставлены на переходный коммит, чтобы не сломать внешние callers.
// Все lifecycle writes в orchestrator.js должны быть переведены на
// приватный facade._writeAssetState (см. S2.2). После миграции
// всех callers на `unsafe*` имена удалить.
const setAssetState = unsafeRestoreAssetState;
const setAssetStates = unsafeRestoreAssetStates;

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Asset state (canonical)
    AssetState,
    ASSET_STATE_KEY_PREFIX,
    ASSETS,
    getAssetStates,

    // ⚠️ UNSAFE: use ONLY for restore/debug. Lifecycle: orchestrator facade.
    unsafeRestoreAssetState,
    unsafeRestoreAssetStates,

    // Deprecated aliases — REMOVE after S2.3 migration
    setAssetState,
    setAssetStates,

    validateAssetTransition,
};
