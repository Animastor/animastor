// ======================================================
// Worker Health - v3.0.0 (fail-closed visibility)
// ======================================================
// Two independent characteristics per worker:
//   1. liveness     — ONLINE/OFFLINE (fresh heartbeat key);
//   2. access scope — SYSTEM / SHARE / PRIVATE (heartbeat payload).
//
// RULE: a heartbeat NEVER means "available to the current caller" by itself.
// Availability is always liveness ∧ scope.
//
// Heartbeat keys `animastor:worker:heartbeat:<type>:<worker_id>` carry a JSON
// payload authored by the GPU hub (PW-4: only after credential auth):
//   { type, worker_id, ts, current_job_id,
//     workspace_id: <uuid>|null, mode: 'private'|'share'|'system', ... }
//
// Scope classification — FAIL CLOSED:
//   mode 'system'                     → SYSTEM pool (Animastor-operated);
//   mode 'share'                      → SHARE pool (community capacity);
//                                       both count as global capacity;
//   mode 'private' + workspace_id set → PRIVATE worker — visible/countable
//                                       ONLY for its owning workspace;
//   anything else (mode missing/unknown, private without workspace)
//                                     → UNAUTHORIZED — counted NOWHERE.
// A missing/invalid credential never becomes SYSTEM or SHARE: the hub no
// longer writes scope-less heartbeats, and this module refuses to count
// them as defense-in-depth.

const config = require('../config/runtime-config');

const logPrefix = '[WORKER]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

/**
 * Report a worker heartbeat: mark a worker as alive.
 * Kept for completeness — in production the GPU hub writes heartbeats itself
 * (beacon/claim/result/error) and is the author of the scope fields.
 * `scope` = { workspaceId, mode }; absent → SYSTEM worker.
 */
async function reportHeartbeat(redis, type, workerId, currentJobId = null, scope = {}) {
    const key = config.WORKER_HEARTBEAT_KEY(type, workerId);
    const payload = JSON.stringify({
        type,
        worker_id: workerId,
        ts: Date.now(),
        current_job_id: currentJobId || null,
        workspace_id: scope.workspaceId || null,
        mode: scope.mode || null
    });
    await redis.set(key, payload, 'EX', config.WORKER_HEARTBEAT_TTL);
}

/** Parse a heartbeat payload; null on missing/corrupt/shapeless data. */
function parseHeartbeat(raw) {
    if (!raw) return null;
    try {
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object' || typeof data.ts !== 'number') return null;
        return data;
    } catch (_) {
        return null;
    }
}

/**
 * All FRESH heartbeat entries of a type (liveness-filtered; scope fields kept).
 * B7: SCAN вместо keys() — не блокируем Redis.
 */
async function scanFreshHeartbeats(redis, type) {
    const pattern = config.WORKER_HEARTBEAT_TYPE_PATTERN(type);
    const keys = [];
    let cursor = '0';
    do {
        const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = nextCursor;
        keys.push(...batch);
    } while (cursor !== '0');

    const now = Date.now();
    const maxAge = config.WORKER_HEARTBEAT_TTL * 1000;
    const entries = [];
    for (const key of keys) {
        const data = parseHeartbeat(await redis.get(key));
        if (!data) continue;
        if (now - data.ts >= maxAge) continue;
        entries.push(data);
    }
    return entries;
}

/**
 * Global capacity scope: Animastor-operated SYSTEM workers and volunteered
 * SHARE workers. FAIL CLOSED: a heartbeat without an explicit mode is NEVER
 * global capacity — it is UNAUTHORIZED and counted nowhere.
 */
function isSystemScope(entry) {
    return entry.mode === 'system' || entry.mode === 'share';
}

/** PRIVATE scope of exactly one workspace (share/system are never private). */
function isPrivateScopeOf(entry, workspaceId) {
    return !!workspaceId && entry.mode === 'private' && entry.workspace_id === workspaceId;
}

function countWhere(entries, pred, busyOnly = false) {
    let n = 0;
    for (const e of entries) {
        if (!pred(e)) continue;
        if (busyOnly && !e.current_job_id) continue;
        n++;
    }
    return n;
}

/**
 * Global/system capacity: alive workers serving the common pool.
 * PRIVATE workers of ANY workspace are never counted here —
 * ONLINE ≠ available to everyone.
 */
async function getAliveCount(redis, type) {
    const entries = await scanFreshHeartbeats(redis, type);
    return countWhere(entries, isSystemScope);
}

/** Alive PRIVATE workers of one workspace (never visible to other workspaces). */
async function getPrivateAliveCount(redis, type, workspaceId) {
    if (!workspaceId) return 0;
    const entries = await scanFreshHeartbeats(redis, type);
    return countWhere(entries, (e) => isPrivateScopeOf(e, workspaceId));
}

/** Busy (current_job_id set) workers of the system/shared pool. */
async function getBusyCount(redis, type) {
    const entries = await scanFreshHeartbeats(redis, type);
    return countWhere(entries, isSystemScope, true);
}

/** Busy PRIVATE workers of one workspace. */
async function getPrivateBusyCount(redis, type, workspaceId) {
    if (!workspaceId) return 0;
    const entries = await scanFreshHeartbeats(redis, type);
    return countWhere(entries, (e) => isPrivateScopeOf(e, workspaceId), true);
}

/**
 * One-pass availability snapshot for a caller (single SCAN per type):
 *   system.*  — the global/shared pool (what every caller may use);
 *   private.* — the caller's OWN private workers (null workspace → zeros).
 * Foreign private workers appear in NEITHER bucket.
 */
async function getAvailability(redis, workspaceId = null) {
    const out = {
        system: {}, system_busy: {},
        private: {}, private_busy: {},
    };
    for (const type of config.WORKER_HEARTBEAT_TYPES) {
        const entries = await scanFreshHeartbeats(redis, type);
        out.system[type] = countWhere(entries, isSystemScope);
        out.system_busy[type] = countWhere(entries, isSystemScope, true);
        out.private[type] = countWhere(entries, (e) => isPrivateScopeOf(e, workspaceId));
        out.private_busy[type] = countWhere(entries, (e) => isPrivateScopeOf(e, workspaceId), true);
    }
    return out;
}

/**
 * Global/system status of all worker types: { audio, image, video }.
 * System/shared pool ONLY — private workers never inflate global capacity.
 */
async function getStatus(redis) {
    const status = {};
    for (const type of config.WORKER_HEARTBEAT_TYPES) {
        status[type] = await getAliveCount(redis, type);
    }
    return status;
}

/**
 * Availability for a caller: at least one system worker alive, OR (when the
 * caller's workspace is known) at least one of the workspace's OWN private
 * workers alive. Foreign private workers never contribute.
 */
async function isAvailable(redis, type, workspaceId = null) {
    const entries = await scanFreshHeartbeats(redis, type);
    if (countWhere(entries, isSystemScope) > 0) return true;
    if (!workspaceId) return false;
    return countWhere(entries, (e) => isPrivateScopeOf(e, workspaceId)) > 0;
}

module.exports = {
    reportHeartbeat,
    getAliveCount,
    getPrivateAliveCount,
    getBusyCount,
    getPrivateBusyCount,
    getAvailability,
    getStatus,
    isAvailable
};
