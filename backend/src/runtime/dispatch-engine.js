// ======================================================
// Dispatch Engine - v1.0.0
// ======================================================
// Single authority for dispatching scene stages.
// Implements leases for determinism, quotas for backpressure.
// Supports renewable leases and drift detection.

const state = require('../state');
const journal = require('../orchestration/event-journal');
const leaseManager = require('./lease-manager');
const counterReconciliation = require('./counter-reconciliation');
const runtimeMetrics = require('./runtime-metrics');
const storage = require('../storage');
const circuitBreaker = require('./circuit-breaker');
const retryBudget = require('./retry-budget-manager');
const crypto = require('crypto');

const logPrefix = '[DISPATCH]';

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

// Lease TTLs (seconds) — canonical values live in config/runtime-config.js
// (LEASE_TTL_S, единый реестр таймаутов). Leases are released immediately on
// completion callback — TTL only matters for failures.
// These are NOT used for worker toggle (toggle uses heartbeat busy status only).
const runtimeConfig = require('../config/runtime-config');
const LEASE_TTLS = {
    audio: runtimeConfig.LEASE_TTL_S.AUDIO,
    image: runtimeConfig.LEASE_TTL_S.IMAGE,
    video: runtimeConfig.LEASE_TTL_S.VIDEO,
};

// Backpressure limits (active concurrent)
// EДИНЫЙ источник — runtime-config.js. Изменяй только там.
const { QUOTAS: QUOTAS_CFG } = require('../config/runtime-config');
const QUOTAS = {
    maxActiveAudio: QUOTAS_CFG.MAX_ACTIVE_AUDIO,
    maxActiveImage: QUOTAS_CFG.MAX_ACTIVE_IMAGE,
    maxActiveVideo: QUOTAS_CFG.MAX_ACTIVE_VIDEO
};

// ======================================================
// KEY PATTERNS
// ======================================================

const DISPATCH_LEASE_PREFIX = 'animastor:dispatch-lease';
const DISPATCH_META_PREFIX = 'animastor:dispatch-meta';
// Д.1: idempotency marker for completion — guards releaseQuota against a
// repeated markDispatchCompleted (e.g. a callback retry that slipped past the
// HTTP-layer dedup). Cleared at dispatch start so each new dispatch completes once.
const DISPATCH_COMPLETED_PREFIX = 'animastor:dispatch-completed';
const ACTIVE_STAGE_PREFIX = 'animastor:runtime:active';

// IU in-flight markers (image stage): iu-processor создаёт маркер
// animastor:iu-in-flight:* ДО gpu.send и регистрирует его в per-dispatch
// индексе. Значение маркера = dispatch_id владельца. Как только GPU job
// реально отправлен, маркер снимается с индекса (с этого момента job живёт
// сам по себе, маркер очищает completion callback). Всё, что осталось в
// индексе на момент финализации dispatch — маркеры НЕотправленных jobs:
// их безопасно удалять compare-and-delete по dispatch_id (forensic audit
// 6929ba5: stale маркеры сорванного dispatch блокировали следующий dispatch
// → no_jobs_sent → ghost GENERATING).
const IU_IN_FLIGHT_INDEX_PREFIX = 'animastor:iu-in-flight-index';
const IU_IN_FLIGHT_MARKER_TTL_S = runtimeConfig.TIMEOUTS.IU_IN_FLIGHT_TTL_S;

const SCHEDULER_TICK_LOCK = 'animastor:runtime:scheduler-lock';
const SCHEDULER_TICK_LOCK_TTL = 30; // 30 seconds

// ======================================================
// LEASE MANAGEMENT
// ======================================================

/**
 * Get lease key for scene:stage.
 */
function getLeaseKey(bookId, chapterId, sceneId, stage) {
    return `${DISPATCH_LEASE_PREFIX}:${bookId}:${chapterId}:${sceneId}:${stage}`;
}

/**
 * Get dispatch metadata key.
 */
function getDispatchMetaKey(bookId, chapterId, sceneId, stage) {
    return `${DISPATCH_META_PREFIX}:${bookId}:${chapterId}:${sceneId}:${stage}`;
}

/**
 * Get dispatch-completed idempotency key (Д.1).
 */
function getDispatchCompletedKey(bookId, chapterId, sceneId, stage, dispatchId = null) {
    const base = `${DISPATCH_COMPLETED_PREFIX}:${bookId}:${chapterId}:${sceneId}:${stage}`;
    return dispatchId ? `${base}:${dispatchId}` : base;
}

/**
 * Get active stage counter key.
 */
function getActiveCounterKey(stage) {
    return `${ACTIVE_STAGE_PREFIX}-${stage}`;
}

/**
 * Generate unique dispatch token.
 * PW-2: cryptographic randomness (128-bit) instead of Math.random — the
 * dispatch_id is an ownership/claim token on the hub hot path; predictable
 * ids would let a caller guess or collide dispatch identities.
 */
function generateDispatchToken() {
    return `dispatch-${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Acquire stage lease for scene.
 * When force=true, any existing lease is deleted and a new one is created.
 * Returns { acquired: boolean, token: string | null, leaseKey: string }
 */
async function acquireStageLease(redis, bookId, chapterId, sceneId, stage, force = false) {
    const leaseKey = getLeaseKey(bookId, chapterId, sceneId, stage);
    const token = generateDispatchToken();
    const ttl = LEASE_TTLS[stage];

    if (force) {
        // Force mode: delete any existing lease, then set new one
        const existing = await redis.get(leaseKey);
        if (existing) {
            log(`LEASE_FORCE_REPLACE: ${bookId}/${chapterId}/${sceneId}:${stage} — replacing existing lease`);
            await redis.del(leaseKey);
        }
        await redis.set(leaseKey, token, 'EX', ttl);
        log(`LEASE_FORCE_ACQUIRED: ${bookId}/${chapterId}/${sceneId}:${stage} (ttl=${ttl}s, token=${token.slice(0, 16)}...)`);
        return { acquired: true, token, leaseKey, forced: true };
    }

    const acquired = await redis.set(leaseKey, token, 'NX', 'EX', ttl);

    if (acquired) {
        log(`LEASE_ACQUIRED: ${bookId}/${chapterId}/${sceneId}:${stage} (ttl=${ttl}s, token=${token.slice(0, 16)}...)`);
        return { acquired: true, token, leaseKey };
    }

    // Check if lease is still valid (not stale)
    const currentToken = await redis.get(leaseKey);
    if (currentToken) {
        warn(`DISPATCH_SKIPPED_DUPLICATE: ${bookId}/${chapterId}/${sceneId}:${stage} (lease still active)`);
        return { acquired: false, token: null, leaseKey, reason: 'lease_active', currentToken };
    }

    return { acquired: false, token: null, leaseKey, reason: 'lease_missing' };
}

/**
 * Release stage lease.
 * Only owner can release.
 */
async function releaseStageLease(redis, leaseKey, token) {
    const current = await redis.get(leaseKey);

    if (!current) {
        log(`LEASE_RELEASED: already expired (key=${leaseKey})`);
        return { released: true, reason: 'already_expired' };
    }

    if (current !== token) {
        warn(`LEASE_RELEASE_FAILED: token mismatch (key=${leaseKey}, current=${current.slice(0, 16)}..., expected=${token.slice(0, 16)}...)`);
        return { released: false, reason: 'token_mismatch' };
    }

    await redis.del(leaseKey);
    log(`LEASE_RELEASED: ${leaseKey}`);
    return { released: true, reason: 'success' };
}

/**
 * Check if lease is still valid.
 */
async function isLeaseValid(redis, leaseKey, token) {
    const current = await redis.get(leaseKey);
    return current === token;
}

/**
 * Get lease data.
 */
async function getLeaseData(redis, bookId, chapterId, sceneId, stage) {
    const leaseKey = getLeaseKey(bookId, chapterId, sceneId, stage);
    const token = await redis.get(leaseKey);
    return { leaseKey, token };
}

// ======================================================
// DISPATCH METADATA
// ======================================================

/**
 * Create dispatch metadata.
 */
function createDispatchMetadata(dispatchId, stage, worker = 'scheduler', ownership = {}) {
    return {
        dispatch_id: dispatchId,
        stage,
        started_at: Date.now(),
        worker,
        retry_attempt: 0,
        status: 'dispatched',
        lease_key: ownership.leaseKey || null,
        lease_token: ownership.leaseToken || null,
        quota_owned: ownership.quotaOwned === true
    };
}

/**
 * Set dispatch metadata.
 */
async function setDispatchMetadata(redis, bookId, chapterId, sceneId, stage, metadata) {
    const key = getDispatchMetaKey(bookId, chapterId, sceneId, stage);
    await redis.set(key, JSON.stringify(metadata), 'EX', LEASE_TTLS[stage]);
}

/**
 * Get dispatch metadata.
 */
async function getDispatchMetadata(redis, bookId, chapterId, sceneId, stage) {
    const key = getDispatchMetaKey(bookId, chapterId, sceneId, stage);
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
}

async function verifyDispatchIdentity(redis, bookId, chapterId, sceneId, stage, dispatchId) {
    if (!dispatchId || typeof dispatchId !== 'string') {
        return { valid: false, reason: 'missing_dispatch_id', metadata: null };
    }

    const metadata = await getDispatchMetadata(redis, bookId, chapterId, sceneId, stage);
    if (!metadata) {
        return { valid: false, reason: 'no_active_dispatch', metadata: null };
    }
    if (!metadata.dispatch_id) {
        return { valid: false, reason: 'metadata_missing_dispatch_id', metadata };
    }
    if (metadata.dispatch_id !== dispatchId) {
        return {
            valid: false,
            reason: 'stale_dispatch',
            metadata,
            currentDispatchId: metadata.dispatch_id
        };
    }
    return { valid: true, reason: 'current_dispatch', metadata };
}

/**
 * Delete dispatch metadata (on completion/failure).
 */
async function deleteDispatchMetadata(redis, bookId, chapterId, sceneId, stage) {
    const key = getDispatchMetaKey(bookId, chapterId, sceneId, stage);
    await redis.del(key);
}

// ======================================================
// IU IN-FLIGHT MARKER OWNERSHIP (image stage)
// ======================================================

/**
 * Per-dispatch index key of iu-in-flight markers created by this dispatch.
 */
function getInFlightIndexKey(dispatchId) {
    return `${IU_IN_FLIGHT_INDEX_PREFIX}:${dispatchId}`;
}

/**
 * Register an iu-in-flight marker under the owning dispatch (iu-processor
 * calls this right after creating the marker, BEFORE gpu.send).
 */
async function registerInFlightMarker(redis, dispatchId, markerKey) {
    if (!dispatchId || typeof dispatchId !== 'string') return;
    const indexKey = getInFlightIndexKey(dispatchId);
    await redis.sadd(indexKey, markerKey);
    await redis.expire(indexKey, IU_IN_FLIGHT_MARKER_TTL_S);
}

/**
 * Remove a marker from the owning dispatch index WITHOUT deleting the marker
 * itself. Called after gpu.send:
 *  - sent:true  → the GPU job is really running; the marker now belongs to
 *                 the job lifecycle (completion callback clears it) and must
 *                 NOT be touched by dispatch cancellation;
 *  - sent:false → the caller deletes the marker itself (job never existed).
 */
async function unregisterInFlightMarker(redis, dispatchId, markerKey) {
    if (!dispatchId || typeof dispatchId !== 'string') return;
    await redis.srem(getInFlightIndexKey(dispatchId), markerKey);
}

/**
 * Atomic compare-and-delete for an owned marker (single Lua step).
 * GET+compare+DEL отдельными командами оставляли TOCTOU-окно: claim
 * finalizeDispatch освобождает lease/metadata ДО очистки маркеров (шаг 2.5),
 * поэтому конкурентный новый dispatch мог успеть пере-создать маркер между
 * GET и DEL — и запоздалый cleanup старого dispatch'а удалил бы чужой маркер.
 * Returns:
 *   { deleted: true }                     — marker removed (we owned it)
 *   { deleted: false, reason: 'missing' } — key already gone
 *   { deleted: false, reason: 'owner_changed' } — re-owned by another dispatch
 */
const COMPARE_AND_DELETE_MARKER_SCRIPT = `
    local key = KEYS[1]
    local expected = ARGV[1]

    local current = redis.call('GET', key)

    if not current then
        return 0
    end

    if current ~= ARGV[1] then
        return -1
    end

    redis.call('DEL', KEYS[1])

    return 1
`;

async function compareAndDeleteMarker(redis, markerKey, expectedOwner) {
    const result = Number(await redis.eval(COMPARE_AND_DELETE_MARKER_SCRIPT, 1, markerKey, expectedOwner));
    if (result === 1) return { deleted: true };
    if (result === 0) return { deleted: false, reason: 'missing' };
    return { deleted: false, reason: 'owner_changed' };
}

/**
 * Release all iu-in-flight markers still owned by a dispatch (i.e. markers
 * whose GPU job was NEVER actually sent). Atomic compare-and-delete by
 * dispatch_id: a marker re-created by a newer dispatch is never touched.
 * Returns { removed, kept, errors } — errors MUST NOT be swallowed by callers.
 */
async function releaseDispatchInFlightMarkers(redis, dispatchId) {
    if (!dispatchId || typeof dispatchId !== 'string') {
        return { removed: 0, kept: 0, errors: [] };
    }
    const indexKey = getInFlightIndexKey(dispatchId);
    const errors = [];
    let members = [];
    try {
        members = await redis.smembers(indexKey);
    } catch (err) {
        errors.push(`index_read:${err.message}`);
    }

    let removed = 0;
    let kept = 0;
    for (const markerKey of members || []) {
        try {
            const cas = await compareAndDeleteMarker(redis, markerKey, dispatchId);
            if (cas.deleted) {
                removed++;
            } else if (cas.reason === 'owner_changed') {
                // Re-owned by a newer dispatch — a job may really be running.
                kept++;
            }
            // 'missing' — already gone (TTL/explicit cleanup), nothing to do
        } catch (err) {
            errors.push(`${markerKey}:${err.message}`);
        }
    }

    try {
        await redis.del(indexKey);
    } catch (err) {
        errors.push(`index_del:${err.message}`);
    }
    return { removed, kept, errors };
}

// ======================================================
// ORPHAN GENERATING DETECTION & REPAIR (audit d9d67a3)
// ======================================================
// GENERATING without ANY evidence of a live generation is an orphan: the
// dispatch died (crash/restart/TTL expiry) and no rollback ever ran, so the
// scene is stuck in GENERATING forever (UI ghost "0/9", Stop All powerless).
//
// Evidence of a LIVE generation (any one is enough):
//   - dispatch lease            (held + renewed from dispatch to finalization)
//   - dispatch metadata         (same TTL as the lease, owns the dispatch_id)
//   - iu-in-flight marker       (image only: a GPU job may still be running)
//
// A stage is only ever set GENERATING AFTER lease+metadata exist (dispatch
// order: acquireLease → setDispatchMetadata → executor markGenerating), so
// the absence of ALL evidence proves the generation is dead. Age alone is
// NEVER a reason to repair — live long jobs keep their lease renewed.

const IU_IN_FLIGHT_KEY_PREFIX = 'animastor:iu-in-flight';

/**
 * Check whether a stage's generation is still alive.
 * @returns {Promise<{alive: boolean, reason: string}>}
 */
async function getDispatchEvidence(redis, bookId, chapterId, sceneId, stage) {
    const leaseToken = await redis.get(getLeaseKey(bookId, chapterId, sceneId, stage));
    if (leaseToken) {
        return { alive: true, reason: 'lease_present' };
    }

    const metadata = await getDispatchMetadata(redis, bookId, chapterId, sceneId, stage);
    if (metadata) {
        return { alive: true, reason: 'dispatch_meta_present' };
    }

    if (stage === 'image') {
        // Marker key: animastor:iu-in-flight:{bookId}_{chapterId}_{sceneId}_{unitId}
        const pattern = `${IU_IN_FLIGHT_KEY_PREFIX}:${bookId}_${chapterId}_${sceneId}_*`;
        let cursor = '0';
        do {
            const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
            cursor = next;
            if (keys && keys.length > 0) {
                return { alive: true, reason: 'iu_in_flight_present' };
            }
        } while (cursor !== '0');
    }

    return { alive: false, reason: 'no_evidence' };
}

/**
 * Repair orphan GENERATING states for a whole book.
 *
 * Every per-asset state stuck in GENERATING with NO live-generation evidence
 * (lease/dispatch-meta/in-flight marker) is rolled back through the FSM-safe
 * path GENERATING → DIRTY → PENDING (orchestrator.rollbackStageToPending —
 * a direct GENERATING → PENDING is forbidden by the FSM).
 *
 * Used by Stop All (cancel-generation) after clearAllLeasesForBook: that
 * call only cancels lease-backed dispatches; a GENERATING state whose
 * dispatch/lease already died would otherwise survive the cancel forever.
 *
 * Never touches a live GENERATING (any evidence → skip). Does NOT dispatch
 * anything and does not require workers.
 *
 * @param {Object} redis
 * @param {string} bookId
 * @param {{reason?: string}} [opts]
 * @returns {Promise<{repaired: Array<{chapterId, sceneId, stage, path}>}>}
 */
async function repairOrphanGeneratingStates(redis, bookId, opts = {}) {
    const stateModule = require('../state');
    const orchestrator = require('../orchestration/orchestrator');
    const reason = opts.reason || 'orphan_generating_repair';
    const repaired = [];

    const pattern = `${stateModule.ASSET_STATE_KEY_PREFIX}:${bookId}:*`;
    const seen = new Set();
    let cursor = '0';
    do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        for (const key of keys || []) {
            // animastor:asset-state:{bookId}:{chapterId}:{sceneId}
            // (bookId/chapterId/sceneId never contain ':')
            const parts = key.split(':');
            if (parts.length < 5) continue;
            const chapterId = parts[3];
            const sceneId = parts[4];
            const sceneKey = `${chapterId}:${sceneId}`;
            if (seen.has(sceneKey)) continue;
            seen.add(sceneKey);

            const states = await stateModule.getAssetStates(redis, bookId, chapterId, sceneId);
            for (const stage of ['audio', 'image', 'video']) {
                if (states[stage] !== stateModule.AssetState.GENERATING) continue;
                const evidence = await getDispatchEvidence(redis, bookId, chapterId, sceneId, stage);
                if (evidence.alive) continue;
                const rollback = await orchestrator.rollbackStageToPending(
                    redis, bookId, chapterId, sceneId, stage, null, reason
                );
                if (rollback.changed) {
                    repaired.push({ chapterId, sceneId, stage, path: rollback.path });
                }
            }
        }
    } while (cursor !== '0');

    return { repaired };
}

// ======================================================
// ACTIVE COUNTERS (for backpressure)
// ======================================================

/**
 * Increment active stage counter.
 */
async function incrementActiveCounter(redis, stage) {
    const key = getActiveCounterKey(stage);
    return await redis.incr(key);
}

/**
 * Decrement active stage counter.
 */
async function decrementActiveCounter(redis, stage) {
    const key = getActiveCounterKey(stage);
    const current = await redis.get(key);
    if (current) {
        const val = parseInt(current, 10);
        if (val > 0) {
            return await redis.decr(key);
        }
    }
    return 0;
}

/**
 * Get active counter value.
 */
async function getActiveCounter(redis, stage) {
    const key = getActiveCounterKey(stage);
    const val = await redis.get(key);
    return parseInt(val || '0', 10);
}

// ======================================================
// BACKPRESSURE QUOTAS
// ======================================================

/**
 * Check if quota is available for a stage.
 */
async function checkQuota(redis, stage) {
    const current = await getActiveCounter(redis, stage);
    const max = QUOTAS[`maxActive${stage.charAt(0).toUpperCase() + stage.slice(1)}`];
    return { exceeded: current >= max, current, max };
}

// Lua script for atomic quota acquire: check limit and increment in one Redis call.
// Returns 0 if quota exceeded, or new counter value if acquired.
const ATOMIC_ACQUIRE_SCRIPT = `
    local key = KEYS[1]
    local max = tonumber(ARGV[1])
    local current = redis.call('GET', key)
    if current and tonumber(current) >= max then
        return 0
    end
    return redis.call('INCR', key)
`;

/**
 * Acquire quota slot — atomically.
 * Uses Lua EVAL to check limit and increment in a single Redis call.
 * Eliminates race condition between checkQuota (GET) and incrementActiveCounter (INCR).
 */
async function acquireQuota(redis, stage) {
    const key = getActiveCounterKey(stage);
    const max = QUOTAS[`maxActive${stage.charAt(0).toUpperCase() + stage.slice(1)}`];

    const result = await redis.eval(ATOMIC_ACQUIRE_SCRIPT, 1, key, max);

    // ioredis may return EVAL result as string '0' — use loose check
    if (!result || result === 0) {
        const current = await getActiveCounter(redis, stage);
        return { acquired: false, reason: 'quota_exceeded', current, max };
    }

    return { acquired: true, current: result, max };
}

/**
 * Release quota slot.
 */
async function releaseQuota(redis, stage) {
    await decrementActiveCounter(redis, stage);
    const current = await getActiveCounter(redis, stage);
    return { released: true, current };
}

// ======================================================
// SCHEDULER TICK LOCK (single-flight)
// ======================================================

/**
 * Acquire scheduler tick lock.
 */
async function acquireSchedulerTickLock(redis) {
    const token = generateDispatchToken();
    const acquired = await redis.set(SCHEDULER_TICK_LOCK, token, 'NX', 'EX', SCHEDULER_TICK_LOCK_TTL);
    return { acquired, token, lockKey: SCHEDULER_TICK_LOCK };
}

/**
 * Release scheduler tick lock.
 */
async function releaseSchedulerTickLock(redis, token) {
    const current = await redis.get(SCHEDULER_TICK_LOCK);
    if (!current) return { released: true, reason: 'already_expired' };
    if (current !== token) return { released: false, reason: 'token_mismatch' };
    await redis.del(SCHEDULER_TICK_LOCK);
    return { released: true, reason: 'success' };
}

/**
 * Check if scheduler tick is running.
 */
async function isSchedulerTickRunning(redis) {
    return await redis.exists(SCHEDULER_TICK_LOCK);
}

// ======================================================
// STAGE DISPATCH LOGIC
// ======================================================

/**
 * Log dispatch event to journal.
 */
async function logDispatchEvent(redis, bookId, chapterId, sceneId, eventType, stage, details = {}) {
    await journal.appendSceneEvent(
        redis,
        bookId,
        chapterId,
        sceneId,
        `DISPATCH_${eventType}`,
        stage,
        { ...details, dispatchedBy: 'dispatch-engine' }
    );
}

/**
 * Check if dispatch should be skipped (duplicate detection).
 *
 * Liveness uses the same canonical signal as reconciliation-engine: the
 * lease's REMAINING TTL (kept pinned by renewal), never metadata.started_at.
 * A live renewed lease — however old — is `lease_active` (skip, no duplicate);
 * only a lease whose TTL decayed below target - grace (renewals stopped) is
 * `stale_lease` and may be recovered. (audit c8b79f6: the started_at age
 * heuristic here mirrored the reconciliation bug that re-dispatched live
 * video jobs every ~28 min.)
 */
async function shouldSkipDispatch(redis, bookId, chapterId, sceneId, stage) {
    const { leaseKey, token } = await getLeaseData(redis, bookId, chapterId, sceneId, stage);

    if (token) {
        // Lease exists — decide liveness by remaining TTL, not started_at age.
        const leaseTtlS = await redis.ttl(leaseKey);

        if (leaseManager.isLeaseStale(leaseTtlS, stage)) {
            // Renewals stopped and the TTL decayed past the grace window — the
            // owner is gone. Surface the token so the caller can release it.
            warn(`STALE_LEASE: ${bookId}/${chapterId}/${sceneId}:${stage} (ttl=${leaseTtlS}s, target=${leaseManager.getRenewalTargetTtlS(stage)}s)`);
            return { skip: true, reason: 'stale_lease', leaseKey, currentToken: token };
        }

        return { skip: true, reason: 'lease_active', leaseKey, currentToken: token };
    }

    // No lease - proceed with dispatch
    return { skip: false, reason: 'no_lease' };
}

/**
 * Evaluate policy for dispatch decision — UNUSED (removed in Phase 6).
 * Legacy governance modules (policyEngine, workloadClassifier, costEstimator)
 * were loaded via safeRequire but never wired into the production dispatch path.
 */

/**
 * Dispatch a scene stage.
 * This is the ONLY way to start a scene stage.
 * When options.force=true, any existing lease is cleared before dispatch.
 *
 * Returns:
 * - { dispatched: true, dispatchId, stage, leaseKey }
 * - { dispatched: false, reason, skip: true/false }
 */
async function dispatchStage(redis, bookId, chapterId, sceneId, stage, loadedBook, buildId, options = {}) {
    const { force = false } = options;
    const dispatchId = generateDispatchToken();

    log(`DISPATCH_REQUEST: ${bookId}/${chapterId}/${sceneId}:${stage}${force ? ' (force=true)' : ''}`);

    // Force mode pre-clear: cancel existing dispatch, release quota ТОЛЬКО при наличии lease
    if (force) {
        const { leaseKey, token } = await getLeaseData(redis, bookId, chapterId, sceneId, stage);
        if (token) {
            log(`FORCE_CLEAR_LEASE: ${bookId}/${chapterId}/${sceneId}:${stage} — cancelling existing dispatch`);
            // T5: Используем cancelActiveDispatch для корректного освобождения
            await cancelActiveDispatch(redis, bookId, chapterId, sceneId, stage, 'force_reset');
        } else {
            log(`FORCE_CLEAR: ${bookId}/${chapterId}/${sceneId}:${stage} — no active lease, only clearing metadata`);
            await deleteDispatchMetadata(redis, bookId, chapterId, sceneId, stage);
            // T5: Не освобождаем quota — не было lease → не было quota для этой сцены
        }
    }

    // Phase 9 Step 0: Check circuit breaker (with auto-recovery: an OPEN
    // circuit that has cooled down transitions to HALF_OPEN and lets this
    // dispatch through as a test request — see checkDispatchWithRecovery).
    const circuitStatus = await circuitBreaker.checkDispatchWithRecovery(redis, stage);
    if (circuitStatus.recovered) {
        log(`CIRCUIT_RECOVERED_TEST: ${bookId}/${chapterId}/${sceneId}:${stage} → half-open test dispatch`);
    }
    // Half-open test-permit tracking: if this dispatch was admitted as a
    // half-open test request, its permit MUST be released on every abort path
    // below that does not reach finalizeDispatch('success'|'failure') — those
    // two outcomes release it themselves via recordSuccess/recordFailure.
    // Otherwise the permit leaks and the stage stays blocked on
    // 'half_open_limit_reached' forever (2026-08-26 video incident follow-up).
    const isCircuitTestRequest = Boolean(circuitStatus.allowed && circuitStatus.isTestRequest);
    const releaseTestPermit = () => isCircuitTestRequest
        ? circuitBreaker.releaseHalfOpenPermit(redis, stage)
        : Promise.resolve({ released: false });
    if (!circuitStatus.allowed) {
        log(`CIRCUIT_BLOCKED: ${bookId}/${chapterId}/${sceneId}:${stage} (circuit: ${circuitStatus.circuitState})`);
        await journal.appendSceneEvent(
            redis,
            bookId,
            chapterId,
            sceneId,
            'DISPATCH_BLOCKED_CIRCUIT',
            stage,
            { circuit: circuitStatus.circuitState, reason: circuitStatus.reason }
        );
        return { dispatched: false, reason: 'circuit_open', circuitState: circuitStatus.circuitState, dispatchId };
    }

    // Step 1: Check for duplicate/lease (skipped in force mode — lease was already cleared)
    if (!force) {
        const shouldSkip = await shouldSkipDispatch(redis, bookId, chapterId, sceneId, stage);
        if (shouldSkip.skip) {
            if (shouldSkip.reason === 'stale_lease') {
                // Recover the stale lease through the canonical cancellation
                // path (lease + owned quota + renewal timer + completion
                // marker) instead of a bare lease delete — a bare delete would
                // leak the quota slot and the in-memory renewal timer.
                await cancelActiveDispatch(redis, bookId, chapterId, sceneId, stage, 'stale_lease_recovery');
                // Fall through to create new lease
            } else {
                await logDispatchEvent(redis, bookId, chapterId, sceneId, 'SKIPPED_DUPLICATE', stage, {
                    reason: shouldSkip.reason,
                    dispatchId
                });                    await releaseTestPermit();
                    return { dispatched: false, reason: 'duplicate', skip: true, dispatchId };
            }
        }
    } else {
        log(`FORCE_DISPATCH: ${bookId}/${chapterId}/${sceneId}:${stage} — duplicate check skipped`);
    }

    // Step 2: Acquire quota
    const quota = await acquireQuota(redis, stage);
    if (!quota.acquired) {
        log(`BACKPRESSURE_DELAY: ${bookId}/${chapterId}/${sceneId}:${stage} (active=${quota.current}/${quota.max})`);
        // B5: НЕ вызывать releaseQuota — квота не была захвачена (Lua скрипт вернул 0, INCR не было).
        // releaseQuota здесь декрементировал бы счётчик ниже нуля → дрифт активных счётчиков.
        await logDispatchEvent(redis, bookId, chapterId, sceneId, 'BACKPRESSURE_DELAY', stage, {
            current: quota.current,
            max: quota.max
        });
        await releaseTestPermit();
        return { dispatched: false, reason: 'backpressure', quota: quota, dispatchId };
    }

    // Phase 9: Check retry budget
    const failureType = 'transient';
    const retryBudgetCheck = await retryBudget.checkRetryBudget(
        redis,
        bookId,
        chapterId,
        sceneId,
        stage,
        failureType,
        'scheduler'
    );
    if (!retryBudgetCheck.allowed) {
        log(`RETRY_BUDGET_EXCEEDED: ${bookId}/${chapterId}/${sceneId}:${stage} (${retryBudgetCheck.reason})`);
        await releaseQuota(redis, stage);
        await releaseTestPermit();
        await journal.appendSceneEvent(
            redis,
            bookId,
            chapterId,
            sceneId,
            'RETRY_BUDGET_EXCEEDED',
            stage,
            { reason: retryBudgetCheck.reason, budgets: retryBudgetCheck.budgets }
        );
        return { dispatched: false, reason: 'retry_budget_exceeded', budgets: retryBudgetCheck.budgets, dispatchId };
    }

    // Step 3: Acquire lease (force mode bypasses existing lease)
    const lease = await acquireStageLease(redis, bookId, chapterId, sceneId, stage, force);
    if (!lease.acquired) {
        // Release quota if lease acquisition failed
        await releaseQuota(redis, stage);
        await releaseTestPermit();
        return { dispatched: false, reason: lease.reason, dispatchId };
    }

    // Step 4: Set dispatch metadata
    const metadata = createDispatchMetadata(dispatchId, stage, 'scheduler', {
        leaseKey: lease.leaseKey,
        leaseToken: lease.token,
        quotaOwned: true
    });
    await setDispatchMetadata(redis, bookId, chapterId, sceneId, stage, metadata);

    // Step 5: Log dispatch event
    await logDispatchEvent(redis, bookId, chapterId, sceneId, 'STARTED', stage, {
        dispatchId,
        leaseKey: lease.leaseKey,
        started_at: metadata.started_at
    });        // Step 6: Get orchestrator to perform dispatch
        try {
            const orchestrator = require('../orchestration');

            // T4: передаём dispatchId — executor включит его в job specs для GPU Hub
            // dispatchId устанавливается в metadata ДО вызова executor, поэтому
            // callback при проверке identity увидит актуальный dispatchId.
            metadata.dispatch_id = dispatchId;
            await setDispatchMetadata(redis, bookId, chapterId, sceneId, stage, metadata);

            const result = await orchestrator.dispatchStage(
                redis,
                { book_id: bookId, chapter_id: chapterId, scene_id: sceneId },
                loadedBook,
                buildId,
                stage,
                dispatchId  // T4: передаём dispatchId в executor
            );

            // If orchestrator didn't dispatch (already done/cached), release quota and lease
            if (!result.dispatched) {
                log(`DISPATCH_SKIPPED: ${bookId}/${chapterId}/${sceneId}:${stage} - ${result.reason || 'already_done'}`);
                if (!result.completed) {
                    await finalizeDispatch(redis, bookId, chapterId, sceneId, stage, {
                        outcome: 'cancelled',
                        dispatchId,
                        reason: result.reason || 'executor_sent_no_jobs'
                    });
                    // Rollback состояния выполняет executor (scene-orchestrator);
                    // если он не удался — не глотаем, явный error-лог.
                    if (result.rollbackFailed) {
                        error(`STATE_ROLLBACK_FAILED: ${bookId}/${chapterId}/${sceneId}:${stage}: ${result.rollbackReason || 'unknown'} — stage may be stuck in GENERATING`);
                    }
                }
                // Cancelled finalize does not touch the circuit breaker — release
                // the test permit here so a half-open circuit can keep recovering.
                await releaseTestPermit();
                return { dispatched: false, dispatchId, reason: result.reason || 'already_done', result };
            }

            // T6: Start lease renewal for this actively dispatched job
            // Only started after confirming dispatcher returned dispatched:true
            // (not for cache hits, backpressure, or empty executor results)
            startDispatchRenewal(redis, bookId, chapterId, sceneId, stage, lease.leaseKey, lease.token);

            // Set 3s debounce — task actually sent to GPU hub
            await redis.set(`animastor:runtime:last-active:${stage}`, '1', 'EX', 3);

            return { dispatched: true, dispatchId, stage, leaseKey: lease.leaseKey, result };
    } catch (err) {
        error(`DISPATCH_FAILED: ${bookId}/${chapterId}/${sceneId}:${stage}: ${err.message}`);
        await releaseTestPermit().catch(() => {});
        await logDispatchEvent(redis, bookId, chapterId, sceneId, 'FAILED', stage, {
            dispatchId,
            error: err.message
        });
        // FSM-валидный rollback состояния: executor мог перевести стадию в
        // GENERATING до throw. Без rollback сцена осталась бы в GENERATING
        // навсегда (ghost, forensic audit 6929ba5). Ошибка rollback не
        // глотается — явный error-лог (rollbackStageToPending дополнительно
        // пишет journal + метрику).
        try {
            const orchestratorFacade = require('../orchestration/orchestrator');
            const rollback = await orchestratorFacade.rollbackStageToPending(
                redis, bookId, chapterId, sceneId, stage, buildId,
                `dispatch_error:${err.message}`
            );
            if (!rollback.changed && !rollback.alreadyPending && rollback.reason !== 'already_ready') {
                error(`STATE_ROLLBACK_FAILED: ${bookId}/${chapterId}/${sceneId}:${stage}: ${rollback.reason} — stage may be stuck in GENERATING`);
            }
        } catch (rollbackErr) {
            error(`STATE_ROLLBACK_FAILED: ${bookId}/${chapterId}/${sceneId}:${stage}: ${rollbackErr.message} — stage may be stuck in GENERATING`);
        }
        await finalizeDispatch(redis, bookId, chapterId, sceneId, stage, {
            outcome: 'cancelled',
            dispatchId,
            reason: `dispatch_error:${err.message}`
        }).catch(finalizeErr => {
            warn(`Dispatch rollback finalization failed: ${finalizeErr.message}`);
        });
        return { dispatched: false, reason: 'dispatch_error', error: err.message, dispatchId };
    }
}

// ======================================================
// T2: Единая finalization — finalizeDispatch
// ======================================================
// Единственная точка финализации dispatch. Принимает outcome:
//   'success'   → recordSuccess,  DISPATCH_COMPLETED,  без retry budget
//   'failure'   → recordFailure,  DISPATCH_FAILED,     consumeRetryBudget ровно 1×
//   'cancelled' → без circuit breaker, без retry budget, DISPATCH_CANCELLED
//
// Идемпотентность: один dispatch финализируется ровно один раз
// (проверка completion marker). Повторный вызов для того же dispatch
// возвращает { finalized: false, reason: 'already_finalized' }.
//
// Порядок:
//   1. Одним Lua-шагом проверить metadata + lease owner, claim marker,
//      удалить metadata/lease и освободить owned quota
//   2. Stop renewal
//   3. Circuit breaker согласно outcome
//   4. Retry budget только для failure
//   5. Записать journal event
// ======================================================

/**
 * Finalize a dispatch with a specific outcome.
 *
 * @param {Object} redis
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {string} stage - 'audio'|'image'|'video'
 * @param {Object} options
 * @param {'success'|'failure'|'cancelled'} options.outcome
 * @param {string} [options.dispatchId]
 * @param {string} [options.reason]
 * @param {string} [options.failureType] - for failure-taxonomy
 * @param {string} [options.workerId]
 * @returns {Promise<{finalized: boolean, reason: string}>}
 */
const CLAIM_FINALIZATION_SCRIPT = `
    local metadata = redis.call('GET', KEYS[1])
    if not metadata then
        if redis.call('EXISTS', KEYS[2]) == 1 then
            return 2
        end
        return 0
    end
    if metadata ~= ARGV[1] then
        return -1
    end

    local lease = redis.call('GET', KEYS[3])
    local expected_lease = ARGV[4]
    if lease and (expected_lease == '' or lease ~= expected_lease) then
        return -2
    end

    local claimed = redis.call(
        'SET',
        KEYS[2],
        ARGV[2],
        'NX',
        'EX',
        tonumber(ARGV[3])
    )
    if not claimed then
        return 2
    end

    redis.call('DEL', KEYS[1])

    if lease and expected_lease ~= '' then
        redis.call('DEL', KEYS[3])
    end

    if ARGV[5] == '1' then
        local quota = tonumber(redis.call('GET', KEYS[4]) or '0')
        if quota > 0 then
            redis.call('DECR', KEYS[4])
        end
    end

    return 1
`;

async function claimFinalization(
    redis,
    metadataKey,
    completedKey,
    leaseKey,
    quotaKey,
    expectedMetadataRaw,
    markerValue,
    markerTtl,
    leaseToken,
    quotaOwned
) {
    return redis.eval(
        CLAIM_FINALIZATION_SCRIPT,
        4,
        metadataKey,
        completedKey,
        leaseKey,
        quotaKey,
        expectedMetadataRaw,
        markerValue,
        markerTtl,
        leaseToken || '',
        quotaOwned ? '1' : '0'
    );
}

async function finalizeDispatch(redis, bookId, chapterId, sceneId, stage, options = {}) {
    const { outcome = 'success', dispatchId, reason, failureType, workerId } = options;

    if (!['success', 'failure', 'cancelled'].includes(outcome)) {
        throw new Error(`finalizeDispatch: invalid outcome '${outcome}' — must be success|failure|cancelled`);
    }

    if (!dispatchId || typeof dispatchId !== 'string') {
        return { finalized: false, reason: 'missing_dispatch_id' };
    }

    const completedKey = getDispatchCompletedKey(bookId, chapterId, sceneId, stage, dispatchId);
    if (await redis.get(completedKey)) {
        return { finalized: false, reason: 'already_finalized' };
    }

    const metadataKey = getDispatchMetaKey(bookId, chapterId, sceneId, stage);
    const metadataRaw = await redis.get(metadataKey);
    if (!metadataRaw) {
        return { finalized: false, reason: 'no_active_dispatch' };
    }

    let metadata;
    try {
        metadata = JSON.parse(metadataRaw);
    } catch (parseErr) {
        return { finalized: false, reason: 'invalid_dispatch_metadata' };
    }

    if (metadata.dispatch_id !== dispatchId) {
        return {
            finalized: false,
            reason: 'stale_dispatch',
            currentDispatchId: metadata.dispatch_id || null
        };
    }

    const leaseKey = metadata.lease_key || getLeaseKey(bookId, chapterId, sceneId, stage);
    const leaseToken = metadata.lease_token || null;
    if (metadata.quota_owned === true && !leaseToken) {
        return { finalized: false, reason: 'ownership_metadata_incomplete' };
    }
    const currentLeaseToken = await redis.get(leaseKey);
    if (currentLeaseToken && (!leaseToken || currentLeaseToken !== leaseToken)) {
        return { finalized: false, reason: 'lease_token_mismatch' };
    }

    // ── 1. Atomically claim finalization and release Redis-owned resources ──
    const markerValue = JSON.stringify({
        outcome,
        dispatch_id: dispatchId,
        finalized_at: Date.now()
    });
    const claimResult = Number(await claimFinalization(
        redis,
        metadataKey,
        completedKey,
        leaseKey,
        getActiveCounterKey(stage),
        metadataRaw,
        markerValue,
        LEASE_TTLS[stage] || 1800,
        leaseToken,
        metadata.quota_owned === true
    ));
    if (claimResult === 2) {
        return { finalized: false, reason: 'already_finalized' };
    }
    if (claimResult === 0) {
        return { finalized: false, reason: 'no_active_dispatch' };
    }
    if (claimResult === -1) {
        return { finalized: false, reason: 'dispatch_metadata_changed' };
    }
    if (claimResult === -2) {
        return { finalized: false, reason: 'lease_token_mismatch' };
    }
    if (claimResult !== 1) {
        throw new Error(`finalizeDispatch: unexpected claim result '${claimResult}'`);
    }

    log(`FINALIZE_${outcome.toUpperCase()}: ${bookId}/${chapterId}/${sceneId}:${stage}${reason ? ' (' + reason + ')' : ''}`);

    // ── 2. Stop renewal ──
    stopDispatchRenewal(bookId, chapterId, sceneId, stage);

    const cleanupErrors = [];

    // ── 2.5. Release iu-in-flight markers owned by this dispatch ──
    // Только для cancelled/failure и только маркеры НЕотправленных jobs
    // (отправленный job снимается с индекса сразу после gpu.send, его маркер
    // трогать нельзя — job реально выполняется). Для success очистку делает
    // completion callback по всему scene-prefix. Ошибки не глотаем — в
    // cleanupErrors и в лог.
    if (outcome === 'cancelled' || outcome === 'failure') {
        try {
            const markerCleanup = await releaseDispatchInFlightMarkers(redis, dispatchId);
            if (markerCleanup.removed > 0 || markerCleanup.kept > 0) {
                log(`IU_IN_FLIGHT_CLEANUP: ${bookId}/${chapterId}/${sceneId}:${stage} dispatch=${dispatchId.slice(0, 24)}... removed=${markerCleanup.removed} kept_running=${markerCleanup.kept}`);
            }
            if (markerCleanup.errors.length > 0) {
                cleanupErrors.push(...markerCleanup.errors.map(e => `iu_in_flight:${e}`));
                warn(`IU_IN_FLIGHT_CLEANUP_ERRORS: ${bookId}/${chapterId}/${sceneId}:${stage} dispatch=${dispatchId.slice(0, 24)}...: ${markerCleanup.errors.join('; ')}`);
            }
        } catch (cleanupErr) {
            cleanupErrors.push(`iu_in_flight:${cleanupErr.message}`);
            warn(`IU_IN_FLIGHT_CLEANUP_FAILED: ${bookId}/${chapterId}/${sceneId}:${stage} dispatch=${dispatchId.slice(0, 24)}...: ${cleanupErr.message}`);
        }
    }

    // ── 3-4. Circuit breaker + retry budget согласно outcome ──
    if (outcome === 'success') {
        try {
            const circuitResult = await circuitBreaker.recordSuccess(redis, stage);
            if (circuitResult.healed) {
                log(`CIRCUIT_HALF_OPEN_TEST_SUCCEEDED: ${stage} — circuit closed`);
            }
        } catch (circuitErr) {
            cleanupErrors.push(`circuit:${circuitErr.message}`);
            warn(`recordSuccess failed: ${circuitErr.message}`);
        }
        // Success не расходует retry budget
    } else if (outcome === 'failure') {
        try {
            await circuitBreaker.recordFailure(redis, stage);
        } catch (circuitErr) {
            cleanupErrors.push(`circuit:${circuitErr.message}`);
            warn(`recordFailure failed: ${circuitErr.message}`);
        }

        // T2.8: Расходуем retry budget ровно один раз на принятый failure
        try {
            await retryBudget.consumeRetryBudget(redis, bookId, chapterId, sceneId, stage, failureType || 'transient', workerId);
            log(`RETRY_BUDGET_CONSUMED: ${bookId}/${chapterId}/${sceneId}:${stage} (type=${failureType || 'transient'})`);
        } catch (budgetErr) {
            cleanupErrors.push(`retry_budget:${budgetErr.message}`);
            warn(`consumeRetryBudget failed: ${budgetErr.message}`);
        }
    }
    // 'cancelled': не трогаем circuit breaker, не расходуем retry budget

    // ── 5. Journal event ──
    const eventSuffix = outcome === 'success' ? 'COMPLETED' : outcome === 'failure' ? 'FAILED' : 'CANCELLED';
    try {
        await logDispatchEvent(redis, bookId, chapterId, sceneId, eventSuffix, stage, {
            outcome,
            reason: reason || null,
            failureType: failureType || null,
            workerId: workerId || null,
            dispatchId,
            cleanupErrors
        });
    } catch (journalErr) {
        cleanupErrors.push(`journal:${journalErr.message}`);
        warn(`finalization journal write failed: ${journalErr.message}`);
    }

    return { finalized: true, reason: outcome, cleanupErrors };
}

/**
 * T2: markDispatchCompleted оставлен как обратно-совместимая обёртка
 * для callers, которые пока не переведены на finalizeDispatch.
 * Все новые вызовы должны использовать finalizeDispatch.
 */
async function markDispatchCompleted(redis, bookId, chapterId, sceneId, stage) {
    const metadata = await getDispatchMetadata(redis, bookId, chapterId, sceneId, stage);
    return finalizeDispatch(redis, bookId, chapterId, sceneId, stage, {
        outcome: 'success',
        dispatchId: metadata?.dispatch_id
    });
}

/**
 * T2: markDispatchFailed — обёртка над finalizeDispatch('failure').
 */
async function markDispatchFailed(redis, bookId, chapterId, sceneId, stage, error) {
    const metadata = await getDispatchMetadata(redis, bookId, chapterId, sceneId, stage);
    return finalizeDispatch(redis, bookId, chapterId, sceneId, stage, {
        outcome: 'failure',
        reason: error,
        dispatchId: metadata?.dispatch_id
    });
}

// ======================================================
// T5: Cancellation + quota-safe lease clearing
// ======================================================

/**
 * Cancel an active dispatch: stop renewal, release lease+quota, save final record, log event.
 * Используется force mode и clearLeasesForScenes.
 * T6: Останавливает in-memory renewal timer, чтобы избежать утечки.
 */
async function cancelActiveDispatch(redis, bookId, chapterId, sceneId, stage, reason = 'cancelled') {
    const metadata = await getDispatchMetadata(redis, bookId, chapterId, sceneId, stage);
    if (metadata?.dispatch_id) {
        const result = await finalizeDispatch(redis, bookId, chapterId, sceneId, stage, {
            outcome: 'cancelled',
            dispatchId: metadata.dispatch_id,
            reason
        });
        return {
            cancelled: result.finalized,
            hadLease: !!metadata.lease_token,
            quotaReleased: result.finalized && metadata.quota_owned === true,
            dispatchId: metadata.dispatch_id,
            reason: result.reason
        };
    }

    const { leaseKey, token } = await getLeaseData(redis, bookId, chapterId, sceneId, stage);
    stopDispatchRenewal(bookId, chapterId, sceneId, stage);
    if (token) {
        await releaseStageLease(redis, leaseKey, token);
        warn(`CANCEL_ORPHAN_LEASE: ${bookId}/${chapterId}/${sceneId}:${stage} — quota ownership unknown; counter reconciliation required`);
        return {
            cancelled: true,
            hadLease: true,
            quotaReleased: false,
            dispatchId: null,
            reason: 'orphan_lease'
        };
    }
    return {
        cancelled: false,
        hadLease: false,
        quotaReleased: false,
        dispatchId: null,
        reason: 'no_active_dispatch'
    };
}

/**
 * Clear leases for specific scenes — T5: корректно освобождает quota
 * для каждого существующего dispatch. Не удаляет quota без ownership.
 *
 * @param {Array<{chapter_id:string,scene_id:string,stages?:string[]}>} scenes - scenes to clear
 * Each scene may restrict cancellation to specific stages. When omitted, all
 * stages are cleared for backward compatibility.
 */
async function clearLeasesForScenes(redis, bookId, scenes) {
    if (!scenes || scenes.length === 0) {
        return { cancelled: 0, quotaReleased: 0, dispatchIds: [] };
    }
    const allStages = ['audio', 'image', 'video'];
    let cancelled = 0;
    let quotaReleased = 0;
    const dispatchIds = [];

    for (const s of scenes) {
        const stages = Array.isArray(s.stages)
            ? s.stages.filter(stage => allStages.includes(stage))
            : allStages;
        for (const stage of stages) {
            const result = await cancelActiveDispatch(
                redis,
                bookId,
                s.chapter_id,
                s.scene_id,
                stage,
                'scene_reset'
            );
            if (result.cancelled) {
                cancelled++;
            }
            if (result.quotaReleased) {
                quotaReleased++;
            }
            if (result.dispatchId) {
                dispatchIds.push(result.dispatchId);
            }
        }
    }

    if (cancelled > 0) {
        log(`CLEAR_SCENE_LEASES: ${bookId} — ${cancelled} stages cancelled, ${quotaReleased} quota slots released for ${scenes.length} scene(s)`);
    }
    return { cancelled, quotaReleased, dispatchIds };
}

/**
 * Remove specific cancelled dispatches from GPU Hub.
 * Kept here with dispatch cancellation so every caller uses the same auth and
 * error-handling contract.
 */
async function clearHubDispatches(dispatchIds, options = {}) {
    const ids = [...new Set((dispatchIds || []).filter(Boolean))];
    const hubUrl = options.hubUrl || runtimeConfig.HUB_URL;
    const apiKey = options.apiKey !== undefined
        ? options.apiKey
        : runtimeConfig.GPU_HUB_API_KEY;
    const context = options.context || 'DISPATCH';
    const reportWarning = typeof options.warn === 'function' ? options.warn : warn;
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    let cleared = 0;
    let failed = 0;

    for (const dispatchId of ids) {
        try {
            const headers = {};
            if (apiKey) headers['x-api-key'] = apiKey;
            const response = await fetchImpl(
                `${hubUrl}/queue/clear?dispatch_id=${encodeURIComponent(dispatchId)}`,
                { method: 'DELETE', headers }
            );
            if (!response.ok) {
                failed++;
                reportWarning(`${context}: GPU hub cleanup returned ${response.status} for ${dispatchId}`);
                continue;
            }
            cleared++;
        } catch (err) {
            failed++;
            reportWarning(`${context}: GPU hub cleanup failed for ${dispatchId}: ${err.message}`);
        }
    }

    return { requested: ids.length, cleared, failed };
}

/**
 * Clear all dispatch leases and metadata for a specific stage within a book.
 * T5: quota-safe — uses cancelActiveDispatch for each lease.
 * Non-cancelled stages keep their leases and quotas intact.
 */
async function clearLeasesForBookByStage(redis, bookId, stage) {
    let deleted = 0;
    let quotaReleased = 0;
    const dispatchIds = [];
    let cursor = 0;

    const leasePattern = `${DISPATCH_LEASE_PREFIX}:${bookId}:*:${stage}`;
    do {
        const result = await redis.scan(cursor, 'MATCH', leasePattern, 'COUNT', 200);
        cursor = parseInt(result[0], 10);
        const keys = result[1];

        for (const key of keys) {
            const parts = key.split(':');
            if (parts.length >= 6) {
                const chapterId = parts[3];
                const sceneId = parts[4];
                stopDispatchRenewal(bookId, chapterId, sceneId, stage);

                const token = await redis.get(key);
                if (token) {
                    const result = await cancelActiveDispatch(
                        redis,
                        bookId,
                        chapterId,
                        sceneId,
                        stage,
                        'stage_reset'
                    );
                    if (result.cancelled && result.reason !== 'orphan_lease') {
                        quotaReleased++;
                    }
                    if (result.dispatchId) dispatchIds.push(result.dispatchId);
                }
            }
            await redis.del(key).catch(() => {});
            deleted++;
        }
    } while (cursor !== 0);

    // Clean up orphan metadata for this stage
    cursor = 0;
    const metaPattern = `${DISPATCH_META_PREFIX}:${bookId}:*:${stage}`;
    do {
        const result = await redis.scan(cursor, 'MATCH', metaPattern, 'COUNT', 200);
        cursor = parseInt(result[0], 10);
        const keys = result[1];
        if (keys.length > 0) {
            await redis.del(...keys);
            deleted += keys.length;
        }
    } while (cursor !== 0);

    if (deleted > 0 || quotaReleased > 0) {
        log(`CLEAR_STAGE_LEASES: ${bookId}/${stage} — ${deleted} keys deleted, ${quotaReleased} quota slots released`);
    }
    return { deleted, quotaReleased, dispatchIds };
}

/**
 * Clear all dispatch leases and metadata for a book — T5: quota-safe.
 */
async function clearAllLeasesForBook(redis, bookId) {
    let deleted = 0;
    let quotaReleased = 0;
    const dispatchIds = [];
    let cursor = 0;

    // Scan all dispatch leases for this book
    const leasePattern = `${DISPATCH_LEASE_PREFIX}:${bookId}:*`;
    do {
        const result = await redis.scan(cursor, 'MATCH', leasePattern, 'COUNT', 200);
        cursor = parseInt(result[0], 10);
        const keys = result[1];

        for (const key of keys) {
            // Parse: animastor:dispatch-lease:bookId:chapterId:sceneId:stage
            const parts = key.split(':');
            if (parts.length >= 6) {
                const chapterId = parts[3];
                const sceneId = parts[4];
                const stage = parts[5];

                // T6: Останавливаем renewal timer перед удалением lease
                stopDispatchRenewal(bookId, chapterId, sceneId, stage);

                const token = await redis.get(key);
                if (token) {
                    const result = await cancelActiveDispatch(
                        redis,
                        bookId,
                        chapterId,
                        sceneId,
                        stage,
                        'book_reset'
                    );
                    if (result.cancelled && result.reason !== 'orphan_lease') {
                        quotaReleased++;
                    }
                    if (result.dispatchId) dispatchIds.push(result.dispatchId);
                }
            }
            await redis.del(key).catch(() => {});
            deleted++;
        }
    } while (cursor !== 0);

    // Delete orphan metadata. Per-dispatch completion markers are retained until TTL
    // so late callbacks remain recognizable as finalized/stale.
    for (const prefix of [DISPATCH_META_PREFIX]) {
        cursor = 0;
        const pattern = `${prefix}:${bookId}:*`;
        do {
            const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
            cursor = parseInt(result[0], 10);
            const keys = result[1];
            if (keys.length > 0) {
                await redis.del(...keys);
                deleted += keys.length;
            }
        } while (cursor !== 0);
    }

    if (deleted > 0 || quotaReleased > 0) {
        log(`CLEAR_ALL_LEASES: ${bookId} — ${deleted} keys deleted, ${quotaReleased} quota slots released`);
    }
    return { deleted, quotaReleased, dispatchIds };
}

// ======================================================
// METRICS
// ======================================================

/**
 * Get current dispatch metrics.
 */
async function getMetrics(redis) {
    const [activeAudio, activeImage, activeVideo] = await Promise.all([
        getActiveCounter(redis, 'audio'),
        getActiveCounter(redis, 'image'),
        getActiveCounter(redis, 'video')
    ]);

    return {
        quotas: QUOTAS,
        active: {
            audio: activeAudio,
            image: activeImage,
            video: activeVideo
        },
        schedulerTickRunning: await isSchedulerTickRunning(redis)
    };
}

/**
 * Get all active dispatches (leases with metadata).
 */
async function getActiveDispatches(redis, limit = 100) {
    const activeDispatches = [];

    // Scan for all dispatch leases
    const pattern = `${DISPATCH_LEASE_PREFIX}:*`;
    let cursor = 0;
    let count = 0;

    do {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        const keys = result[1];

        for (const key of keys) {
            if (count >= limit) break;

            // Parse: animastor:dispatch-lease:bookId:chapterId:sceneId:stage
            const parts = key.split(':');
            if (parts.length >= 6) {
                const bookId = parts[2];
                const chapterId = parts[3];
                const sceneId = parts[4];
                const stage = parts[5];

                const token = await redis.get(key);
                const metadata = await getDispatchMetadata(redis, bookId, chapterId, sceneId, stage);

                activeDispatches.push({
                    key,
                    scene: { bookId, chapterId, sceneId },
                    stage,
                    token: token || null,
                    metadata
                });

                count++;
            }
        }
    } while (cursor !== 0 && count < limit);

    return activeDispatches;
}

/**
 * Get all active leases (for debug).
 */
async function getActiveLeases(redis) {
    const pattern = `${DISPATCH_LEASE_PREFIX}:*`;
    let cursor = 0;
    const leases = [];

    do {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        const keys = result[1];

        for (const key of keys) {
            const token = await redis.get(key);
            const parts = key.split(':');
            const leaseData = {
                key,
                scene: parts.length >= 6 ? {
                    bookId: parts[2],
                    chapterId: parts[3],
                    sceneId: parts[4],
                    stage: parts[5]
                } : null,
                token: token || null
            };
            leases.push(leaseData);
        }
    } while (cursor !== 0);

    return leases;
}

/**
 * Get current quota status.
 */
async function getQuotaStatus(redis) {
    const [audio, image, video] = await Promise.all([
        getActiveCounter(redis, 'audio'),
        getActiveCounter(redis, 'image'),
        getActiveCounter(redis, 'video')
    ]);

    return {
        audio: { current: audio, max: QUOTAS.maxActiveAudio, available: QUOTAS.maxActiveAudio - audio },
        image: { current: image, max: QUOTAS.maxActiveImage, available: QUOTAS.maxActiveImage - image },
        video: { current: video, max: QUOTAS.maxActiveVideo, available: QUOTAS.maxActiveVideo - video }
    };
}

// ======================================================
// LEASE RENEWAL TIMER MANAGEMENT
// ======================================================

/**
 * Start lease renewal timer for a dispatch.
 * Called after successful dispatch.
 */
function startDispatchRenewal(redis, bookId, chapterId, sceneId, stage, leaseKey, token) {
    return leaseManager.startLeaseRenewal(redis, bookId, chapterId, sceneId, stage, leaseKey, token);
}

/**
 * Stop lease renewal timer for a dispatch.
 * Called on completion/failure/recovery.
 */
function stopDispatchRenewal(bookId, chapterId, sceneId, stage) {
    return leaseManager.stopLeaseRenewal(bookId, chapterId, sceneId, stage);
}

/**
 * Get metrics for runtime.
 */
async function getRuntimeMetrics(redis) {
    return await runtimeMetrics.getMetricsReport(redis);
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Keys and patterns
    getLeaseKey,
    getDispatchMetaKey,
    getDispatchCompletedKey,
    getActiveCounterKey,
    SCHEDULER_TICK_LOCK,
    SCHEDULER_TICK_LOCK_TTL,

    // Lease management
    acquireStageLease,
    releaseStageLease,
    isLeaseValid,
    getLeaseData,

    // Dispatch metadata
    createDispatchMetadata,
    setDispatchMetadata,
    getDispatchMetadata,
    verifyDispatchIdentity,
    deleteDispatchMetadata,

    // IU in-flight marker ownership (image stage)
    getInFlightIndexKey,
    registerInFlightMarker,
    unregisterInFlightMarker,
    releaseDispatchInFlightMarkers,
    compareAndDeleteMarker,
    IU_IN_FLIGHT_INDEX_PREFIX,
    IU_IN_FLIGHT_MARKER_TTL_S,

    // Orphan GENERATING detection & repair (audit d9d67a3)
    getDispatchEvidence,
    repairOrphanGeneratingStates,

    // Active counters (backpressure)
    incrementActiveCounter,
    decrementActiveCounter,
    getActiveCounter,
    checkQuota,
    acquireQuota,
    releaseQuota,

    // Scheduler tick lock
    acquireSchedulerTickLock,
    releaseSchedulerTickLock,
    isSchedulerTickRunning,

    // Dispatch control
    dispatchStage,
    shouldSkipDispatch,
    finalizeDispatch,
    cancelActiveDispatch,
    markDispatchCompleted,
    markDispatchFailed,

    // Renewal management
    startDispatchRenewal,
    stopDispatchRenewal,

    // Recovery
    clearAllLeasesForBook,
    clearLeasesForBookByStage,
    clearLeasesForScenes,
    clearHubDispatches,

    // Runtime metrics
    getRuntimeMetrics,

    // Metrics and debug
    getMetrics,
    getActiveDispatches,
    getActiveLeases,
    getQuotaStatus,

    // Constants
    QUOTAS,
    LEASE_TTLS,

    // PW-2: dispatch identity generation (crypto-hardened)
    generateDispatchToken
};
