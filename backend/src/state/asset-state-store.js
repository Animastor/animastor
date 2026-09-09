// ======================================================
// Asset State Store — host Redis adapter (S-4 correction)
// ======================================================
// The pure per-asset FSM/domain core (AssetState enum, transition validation,
// state normalization) lives in the Generation core: generation/scene-state.js.
//
// THIS module is the host/infrastructure adapter: it owns the Redis key
// namespace (`animastor:asset-state:*`) and implements the per-scene hash
// persistence (HGETALL/HSET/DEL) over the redis client injected by the
// callers. Redis keys, FSM semantics, unsafe-restore whitelist and the public
// API are unchanged (S-6 will formalize this seam as a port).

const core = require('../generation/scene-state');

const ASSET_STATE_KEY_PREFIX = 'animastor:asset-state';

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

    return core.normalizeAssetStates(raw);
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
 *   - backend/src/runtime/reconciliation-engine.js (C7 WORK_TO_DO rebuild: PENDING
 *       пишется ТОЛЬКО через orchestrator facade (setScenePending / markDirtyScene —
 *       валидация переходов, GENERATING→PENDING rejected); unsafe* остаётся только
 *       для guarded READY restore-fact (файл валиден на диске, никогда поверх
 *       GENERATING/PENDING) и для существующих фаз C0/C1/C1b (startup recovery)
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
    const err = core.validateAssetUpdate(asset, status);
    if (err) {
        error(err);
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
    const err = core.validateAssetUpdates(updates);
    if (err) {
        error(err);
        return null;
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

module.exports = {
    // Pure core re-exports (FSM contract)
    AssetState: core.AssetState,
    ASSETS: core.ASSETS,
    validateAssetTransition: core.validateAssetTransition,

    // Asset state store (canonical, host adapter)
    ASSET_STATE_KEY_PREFIX,
    getAssetStates,

    // ⚠️ UNSAFE: use ONLY for restore/debug. Lifecycle: orchestrator facade.
    unsafeRestoreAssetState,
    unsafeRestoreAssetStates,

    // Deprecated aliases — REMOVE after S2.3 migration
    setAssetState,
    setAssetStates,
};
