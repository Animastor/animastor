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
const fairness = require('./fairness-engine');

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

// Lease TTLs (seconds)
// Long enough to cover real generation duration + queue wait:
//   audio:  up to 10 min gen  → 15 min TTL
//   image:  up to 15 min gen  → 20 min TTL
//   video:  up to 20 min gen  → 30 min TTL
// Leases are released immediately on completion callback — TTL only matters for failures.
// These are NOT used for worker toggle (toggle uses heartbeat busy status only).
const LEASE_TTLS = {
    audio: 15 * 60,   // 15 minutes
    image: 20 * 60,   // 20 minutes
    video: 30 * 60    // 30 minutes
};

// Backpressure limits (active concurrent)
const QUOTAS = {
    maxActiveAudio: 3,
    maxActiveImage: 2,
    maxActiveVideo: 1
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
function getDispatchCompletedKey(bookId, chapterId, sceneId, stage) {
    return `${DISPATCH_COMPLETED_PREFIX}:${bookId}:${chapterId}:${sceneId}:${stage}`;
}

/**
 * Get active stage counter key.
 */
function getActiveCounterKey(stage) {
    return `${ACTIVE_STAGE_PREFIX}-${stage}`;
}

/**
 * Generate unique dispatch token.
 */
function generateDispatchToken() {
    return `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
function createDispatchMetadata(dispatchId, stage, worker = 'scheduler') {
    return {
        dispatch_id: dispatchId,
        stage,
        started_at: Date.now(),
        worker,
        retry_attempt: 0,
        status: 'dispatched'
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

/**
 * Delete dispatch metadata (on completion/failure).
 */
async function deleteDispatchMetadata(redis, bookId, chapterId, sceneId, stage) {
    const key = getDispatchMetaKey(bookId, chapterId, sceneId, stage);
    await redis.del(key);
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
 */
async function shouldSkipDispatch(redis, bookId, chapterId, sceneId, stage) {
    const { leaseKey, token } = await getLeaseData(redis, bookId, chapterId, sceneId, stage);

    if (token) {
        // Lease exists - check if it's stale
        const meta = await getDispatchMetadata(redis, bookId, chapterId, sceneId, stage);
        const leaseAge = token ? (Date.now() - (meta?.started_at || 0)) / 1000 : 0;

        if (leaseAge > LEASE_TTLS[stage] * 0.9) {
            // Lease is approaching expiry - it's stale
            warn(`STALE_LEASE: ${bookId}/${chapterId}/${sceneId}:${stage} (${Math.floor(leaseAge)}s old)`);
            return { skip: true, reason: 'stale_lease', leaseKey };
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

    // Force mode pre-clear: before any checks, nuke any existing lease + quota + metadata
    if (force) {
        const { leaseKey, token } = await getLeaseData(redis, bookId, chapterId, sceneId, stage);
        if (token) {
            log(`FORCE_CLEAR_LEASE: ${bookId}/${chapterId}/${sceneId}:${stage} — deleting existing lease`);
            await redis.del(leaseKey);
        }
        // Release quota if leaked
        await releaseQuota(redis, stage);
        // Delete metadata
        await deleteDispatchMetadata(redis, bookId, chapterId, sceneId, stage);
    }

    // Phase 9 Step 0: Check circuit breaker
    const circuitStatus = await circuitBreaker.checkDispatch(redis, stage);
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
                // Try to recover stale lease
                await releaseStageLease(redis, shouldSkip.leaseKey, shouldSkip.currentToken);
                // Fall through to create new lease
            } else {
                await logDispatchEvent(redis, bookId, chapterId, sceneId, 'SKIPPED_DUPLICATE', stage, {
                    reason: shouldSkip.reason,
                    dispatchId
                });
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
        await releaseQuota(redis, stage);
        await logDispatchEvent(redis, bookId, chapterId, sceneId, 'BACKPRESSURE_DELAY', stage, {
            current: quota.current,
            max: quota.max
        });
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

    // Phase 9: Check fairness - detect starvation
    const fairnessStatus = await fairness.isStarving(redis, bookId, chapterId, sceneId);
    if (fairnessStatus.starving) {
        log(`STARVATION_DETECTED: ${bookId}/${chapterId}/${sceneId}:${stage} (age: ${fairnessStatus.ageMinutes}m)`);
        await fairness.boostStarvingScene(redis, bookId, chapterId, sceneId);
    }

    // Step 3: Acquire lease (force mode bypasses existing lease)
    const lease = await acquireStageLease(redis, bookId, chapterId, sceneId, stage, force);
    if (!lease.acquired) {
        // Release quota if lease acquisition failed
        await releaseQuota(redis, stage);
        return { dispatched: false, reason: lease.reason, dispatchId };
    }

    // Step 4: Set dispatch metadata
    const metadata = createDispatchMetadata(dispatchId, stage);
    await setDispatchMetadata(redis, bookId, chapterId, sceneId, stage, metadata);

    // Д.1: Clear the completion marker for this fresh dispatch, so its eventual
    // markDispatchCompleted runs once (and a force-regen re-dispatch isn't blocked
    // by the previous build's marker).
    await redis.del(getDispatchCompletedKey(bookId, chapterId, sceneId, stage));

    // Step 5: Log dispatch event
    await logDispatchEvent(redis, bookId, chapterId, sceneId, 'STARTED', stage, {
        dispatchId,
        leaseKey: lease.leaseKey,
        started_at: metadata.started_at
    });

    // Step 6: Get orchestrator to perform dispatch
    try {
        log(`[DISPATCH-DEBUG] Passing buildId=${buildId} stage=${stage} to orchestrator for ${bookId}/${chapterId}/${sceneId}`);
        const orchestrator = require('../orchestration');
        const result = await orchestrator.dispatchStage(
            redis,
            { book_id: bookId, chapter_id: chapterId, scene_id: sceneId },
            loadedBook,
            buildId,
            stage  // Pass stage directly — orchestrator uses it instead of re-deciding
        );

        // If orchestrator didn't dispatch (already done/cached), release quota and lease
        if (!result.dispatched) {
            log(`DISPATCH_SKIPPED: ${bookId}/${chapterId}/${sceneId}:${stage} - ${result.reason || 'already_done'}`);
            await releaseStageLease(redis, lease.leaseKey, lease.token);
            await releaseQuota(redis, stage);
            return { dispatched: false, reason: result.reason || 'already_done', result };
        }

        // Set 3s debounce — task actually sent to GPU hub
        await redis.set(`animastor:runtime:last-active:${stage}`, '1', 'EX', 3);

        return { dispatched: true, dispatchId, stage, leaseKey: lease.leaseKey, result };
    } catch (err) {
        error(`DISPATCH_FAILED: ${bookId}/${chapterId}/${sceneId}:${stage}: ${err.message}`);
        await logDispatchEvent(redis, bookId, chapterId, sceneId, 'FAILED', stage, {
            dispatchId,
            error: err.message
        });
        await releaseStageLease(redis, lease.leaseKey, lease.token);
        await releaseQuota(redis, stage);
        return { dispatched: false, reason: 'dispatch_error', error: err.message, dispatchId };
    }
}

/**
 * Mark dispatch as completed.
 */
async function markDispatchCompleted(redis, bookId, chapterId, sceneId, stage) {
    const dispatchId = generateDispatchToken();

    // Д.1: Idempotency guard. releaseQuota is an unconditional decrement, so a
    // repeated markDispatchCompleted (callback retry past the HTTP dedup, manual
    // reconcile, etc.) would double-release a quota slot and drift backpressure.
    // SET NX claims the completion exactly once per dispatch; the marker is cleared
    // at dispatch start (see dispatchStage), so the next real dispatch completes again.
    // TTL matches the lease so a leaked marker self-expires.
    const completedKey = getDispatchCompletedKey(bookId, chapterId, sceneId, stage);
    const claimed = await redis.set(completedKey, '1', 'NX', 'EX', LEASE_TTLS[stage] || 1800);
    if (!claimed) {
        log(`DISPATCH_COMPLETE: already completed for ${bookId}/${chapterId}/${sceneId}:${stage} — skipping release`);
        return;
    }

    log(`DISPATCH_COMPLETE: ${bookId}/${chapterId}/${sceneId}:${stage}`);

    // Phase 9: Record success for circuit breaker recovery
    const circuitResult = await circuitBreaker.recordSuccess(redis, stage);
    if (circuitResult.state === circuitBreaker.CircuitState.HALF_OPEN && circuitResult.testRequest) {
        log(`CIRCUIT_HALF_OPEN_TEST: ${stage} (test request ${circuitResult.halfOpenCount})`);
    }

    // Stop lease renewal timer
    stopDispatchRenewal(bookId, chapterId, sceneId, stage);

    // Get lease to ensure it's still valid
    const { leaseKey, token } = await getLeaseData(redis, bookId, chapterId, sceneId, stage);

    if (!token) {
        warn(`DISPATCH_COMPLETE: lease already expired for ${bookId}/${chapterId}/${sceneId}:${stage}`);
    }

    // Release lease if valid
    if (token && leaseKey) {
        await releaseStageLease(redis, leaseKey, token);
    }

    // Release quota
    await releaseQuota(redis, stage);

    // Delete metadata
    await deleteDispatchMetadata(redis, bookId, chapterId, sceneId, stage);

    await logDispatchEvent(redis, bookId, chapterId, sceneId, 'COMPLETED', stage, {
        dispatchedBy: 'dispatch-engine'
    });
}

/**
 * Mark dispatch as failed.
 */
async function markDispatchFailed(redis, bookId, chapterId, sceneId, stage, error) {
    log(`DISPATCH_FAILED: ${bookId}/${chapterId}/${sceneId}:${stage}: ${error}`);

    // Phase 9: Record failure for circuit breaker
    const circuitResult = await circuitBreaker.recordFailure(redis, stage);
    if (circuitResult.isTripped) {
        log(`CIRCUIT_OPENED: ${stage} (threshold reached)`);
        await journal.appendSceneEvent(
            redis,
            bookId,
            chapterId,
            sceneId,
            'CIRCUIT_OPENED',
            stage,
            { failureType: stage, failures: circuitResult.newCount }
        );
    }

    // Stop lease renewal timer
    stopDispatchRenewal(bookId, chapterId, sceneId, stage);

    const { leaseKey, token } = await getLeaseData(redis, bookId, chapterId, sceneId, stage);

    // Release lease if valid
    if (token && leaseKey) {
        await releaseStageLease(redis, leaseKey, token);
    }

    // Release quota
    await releaseQuota(redis, stage);

    // Update metadata
    const metadata = await getDispatchMetadata(redis, bookId, chapterId, sceneId, stage);
    if (metadata) {
        metadata.status = 'failed';
        metadata.error = error;
        metadata.failed_at = Date.now();
        metadata.retry_attempt = (metadata.retry_attempt || 0) + 1;
        await setDispatchMetadata(redis, bookId, chapterId, sceneId, stage, metadata);
    }

    await logDispatchEvent(redis, bookId, chapterId, sceneId, 'FAILED', stage, {
        dispatchedBy: 'dispatch-engine',
        error
    });
}

// ======================================================
// RECOVERY
// ======================================================

/**
 * Clear all dispatch leases and metadata for a book.
 * Used when cancelling or regenerating a book.
 */
async function clearAllLeasesForBook(redis, bookId) {
    let deleted = 0;
    let cursor = 0;
    
    // Delete all dispatch leases
    const leasePattern = `${DISPATCH_LEASE_PREFIX}:${bookId}:*`;
    do {
        const result = await redis.scan(cursor, 'MATCH', leasePattern, 'COUNT', 200);
        cursor = parseInt(result[0], 10);
        const keys = result[1];
        if (keys.length > 0) {
            await redis.del(...keys);
            deleted += keys.length;
        }
    } while (cursor !== 0);

    // Delete all dispatch metadata
    cursor = 0;
    const metaPattern = `${DISPATCH_META_PREFIX}:${bookId}:*`;
    do {
        const result = await redis.scan(cursor, 'MATCH', metaPattern, 'COUNT', 200);
        cursor = parseInt(result[0], 10);
        const keys = result[1];
        if (keys.length > 0) {
            await redis.del(...keys);
            deleted += keys.length;
        }
    } while (cursor !== 0);

    // Д.1: Delete completion markers too, so a regenerated scene's first
    // completion isn't skipped by a stale marker from the cancelled build.
    cursor = 0;
    const completedPattern = `${DISPATCH_COMPLETED_PREFIX}:${bookId}:*`;
    do {
        const result = await redis.scan(cursor, 'MATCH', completedPattern, 'COUNT', 200);
        cursor = parseInt(result[0], 10);
        const keys = result[1];
        if (keys.length > 0) {
            await redis.del(...keys);
            deleted += keys.length;
        }
    } while (cursor !== 0);

    if (deleted > 0) {
        log(`CLEAR_ALL_LEASES: ${bookId} — ${deleted} keys deleted`);
    }
    return { deleted };
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
function startDispatchRenewal(bookId, chapterId, sceneId, stage, leaseKey, token) {
    return leaseManager.startLeaseRenewal(bookId, chapterId, sceneId, stage, leaseKey, token);
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
    deleteDispatchMetadata,

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
    markDispatchCompleted,
    markDispatchFailed,

    // Renewal management
    startDispatchRenewal,
    stopDispatchRenewal,

    // Recovery
    clearAllLeasesForBook,

    // Runtime metrics
    getRuntimeMetrics,

    // Metrics and debug
    getMetrics,
    getActiveDispatches,
    getActiveLeases,
    getQuotaStatus,

    // Constants
    QUOTAS,
    LEASE_TTLS
};
