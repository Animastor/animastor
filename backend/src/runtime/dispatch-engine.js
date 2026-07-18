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
        // B5: НЕ вызывать releaseQuota — квота не была захвачена (Lua скрипт вернул 0, INCR не было).
        // releaseQuota здесь декрементировал бы счётчик ниже нуля → дрифт активных счётчиков.
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
            log(`[DISPATCH-DEBUG] Passing buildId=${buildId} stage=${stage} dispatchId=${dispatchId.slice(0, 20)}... to orchestrator for ${bookId}/${chapterId}/${sceneId}`);
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
                }
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
        await logDispatchEvent(redis, bookId, chapterId, sceneId, 'FAILED', stage, {
            dispatchId,
            error: err.message
        });
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

    // ── 3-4. Circuit breaker + retry budget согласно outcome ──
    if (outcome === 'success') {
        try {
            const circuitResult = await circuitBreaker.recordSuccess(redis, stage);
            if (circuitResult.state === circuitBreaker.CircuitState.HALF_OPEN && circuitResult.testRequest) {
                log(`CIRCUIT_HALF_OPEN_TEST: ${stage} (test request ${circuitResult.halfOpenCount})`);
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
 * @param {Array<{chapter_id:string,scene_id:string}>} scenes - scenes to clear
 */
async function clearLeasesForScenes(redis, bookId, scenes) {
    if (!scenes || scenes.length === 0) {
        return { cancelled: 0, quotaReleased: 0, dispatchIds: [] };
    }
    const stages = ['audio', 'image', 'video'];
    let cancelled = 0;
    let quotaReleased = 0;
    const dispatchIds = [];

    for (const s of scenes) {
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
    finalizeDispatch,
    markDispatchCompleted,
    markDispatchFailed,

    // Renewal management
    startDispatchRenewal,
    stopDispatchRenewal,

    // Recovery
    clearAllLeasesForBook,
    clearLeasesForScenes,

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
