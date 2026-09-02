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
//   mode 'private' + active public share policy (SH-1, D3)
//                                     → PRIVATE **and** global capacity
//                                       (double count is the normative D3
//                                       decision — see below);
//   anything else (mode missing/unknown, private without workspace)
//                                     → UNAUTHORIZED — counted NOWHERE.
//
// D3 (worker-sharing-model-design.md §7.4): `system.*` is a CAPACITY
// indicator — "workers currently able to serve the system pool" — NOT a
// physical inventory. A private worker with an active public share policy
// genuinely is able to serve the system pool, so it counts in BOTH the
// owner's private_* bucket and the global pool. Restated invariant:
// "a private worker WITHOUT an active public policy is never in the global
// count". Policy-LESS heartbeats are classified exactly as before — the
// share_policy field is optional (forward/backward compatibility).
//
// The marker must come from a hub that ran with the kill-switch ON: the hub
// only ever writes `share_policy` into heartbeats when SHARE_FEATURES_ENABLED
// is on and the policy is active — so a disabled switch degrades counts to
// today's behavior automatically.
//
// Expiry is re-checked on read (expires_at carried in the marker): a stale
// heartbeat cannot extend a policy past its expires_at.
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
 * SH-1 (D3): is the heartbeat's optional share_policy marker ACTIVE at
 * read time? Fail closed: malformed marker, non-public scope, an
 * expires_at in the past (relative to the read — a stale marker can never
 * extend a policy) or the kill-switch OFF (bit-for-bit today's counting,
 * §8.7 — stale marker heartbeats left over from a flag flip are ignored)
 * → not active.
 */
function hasActiveSharePolicyMarker(entry, now = Date.now()) {
    if (config.shareFeaturesEnabled() !== true) return false; // kill-switch
    const p = entry && entry.share_policy;
    if (!p || typeof p !== 'object') return false;
    if (p.scope_kind !== 'public') return false; // V1: public only
    if (p.expires_at == null) return true;       // NULL = "until stopped"
    return Number(p.expires_at) > now;           // expiry re-checked on read
}

/**
 * Global capacity scope: Animastor-operated SYSTEM workers and volunteered
 * SHARE workers. FAIL CLOSED: a heartbeat without an explicit mode is NEVER
 * global capacity — it is UNAUTHORIZED and counted nowhere.
 * D3: a policy-active PRIVATE worker is able to serve the system pool and
 * therefore counts as global capacity too (double count with private_*).
 */
function isSystemScope(entry, now = Date.now()) {
    if (entry.mode === 'system' || entry.mode === 'share') return true;
    if (entry.mode === 'private' && hasActiveSharePolicyMarker(entry, now)) return true;
    return false;
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
 * PRIVATE workers without an active public policy are never counted here —
 * ONLINE ≠ available to everyone. Policy-active private workers count (D3).
 */
async function getAliveCount(redis, type) {
    const entries = await scanFreshHeartbeats(redis, type);
    return countWhere(entries, (e) => isSystemScope(e, Date.now()));
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
    return countWhere(entries, (e) => isSystemScope(e, Date.now()), true);
}

/** Busy PRIVATE workers of one workspace. */
async function getPrivateBusyCount(redis, type, workspaceId) {
    if (!workspaceId) return 0;
    const entries = await scanFreshHeartbeats(redis, type);
    return countWhere(entries, (e) => isPrivateScopeOf(e, workspaceId), true);
}

/**
 * One-pass availability snapshot for a caller (single SCAN per type):
 *   system.*     — the global/shared pool (what every caller may use); per D3
 *                  this includes policy-active private workers of ANY owner;
 *   private.*    — the caller's OWN private workers (null workspace → zeros).
 *   available.*  — PHYSICAL union visible to this caller: system pool ∪ own
 *                  private workers, each PHYSICAL worker counted ONCE
 *                  (deduplicated by worker_id). This is the "how many workers
 *                  can I use" metric for UI counters — it deliberately does
 *                  NOT sum the overlapping D3 buckets (a policy-active private
 *                  worker is one physical unit, not two). Scheduler/capacity
 *                  consumers keep using system.* / private.* unchanged.
 * Foreign private workers appear in the system buckets ONLY when they carry
 * an active public share policy (D3) — never in this caller's private.*.
 */
async function getAvailability(redis, workspaceId = null) {
    const out = {
        system: {}, system_busy: {},
        private: {}, private_busy: {},
        available: {}, available_busy: {},
    };
    const now = Date.now();
    for (const type of config.WORKER_HEARTBEAT_TYPES) {
        const entries = await scanFreshHeartbeats(redis, type);
        out.system[type] = countWhere(entries, (e) => isSystemScope(e, now));
        out.system_busy[type] = countWhere(entries, (e) => isSystemScope(e, now), true);
        out.private[type] = countWhere(entries, (e) => isPrivateScopeOf(e, workspaceId));
        out.private_busy[type] = countWhere(entries, (e) => isPrivateScopeOf(e, workspaceId), true);
        // Physical union: dedupe by worker_id — a heartbeat key IS one physical
        // worker; sharing changes access, never the number of units.
        const usable = new Set();
        const usableBusy = new Set();
        for (const e of entries) {
            if (!e || !e.worker_id) continue;
            const mine = isPrivateScopeOf(e, workspaceId);
            if (!mine && !isSystemScope(e, now)) continue;
            usable.add(e.worker_id);
            if (e.current_job_id) usableBusy.add(e.worker_id);
        }
        out.available[type] = usable.size;
        out.available_busy[type] = usableBusy.size;
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
    const now = Date.now();
    if (countWhere(entries, (e) => isSystemScope(e, now)) > 0) return true;
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
