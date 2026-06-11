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
function safeRequire(mod) {
    try { return require(mod); } catch { return null; }
}
const circuitBreaker = safeRequire('./circuit-breaker');
const retryBudget = safeRequire('./retry-budget-manager');
const fairness = safeRequire('./fairness-engine');
const policyEngine = safeRequire('./policy-engine');
const workloadClassifier = safeRequire('./workload-classifier');
const costEstimator = safeRequire('./cost-estimator');

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
const LEASE_TTLS = {
    audio: 30 * 60,   // 30 minutes
    image: 60 * 60,   // 60 minutes
    video: 120 * 60   // 120 minutes
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
 * Returns { acquired: boolean, token: string | null, leaseKey: string }
 */
async function acquireStageLease(redis, bookId, chapterId, sceneId, stage) {
    const leaseKey = getLeaseKey(bookId, chapterId, sceneId, stage);
    const token = generateDispatchToken();
    const ttl = LEASE_TTLS[stage];

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

/**
 * Acquire quota slot.
 */
async function acquireQuota(redis, stage) {
    const result = await checkQuota(redis, stage);
    if (result.exceeded) {
        return { acquired: false, reason: 'quota_exceeded', current: result.current, max: result.max };
    }
    await incrementActiveCounter(redis, stage);
    return { acquired: true, current: result.current + 1, max: result.max };
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
 * Evaluate policy for dispatch decision.
 * Returns policy decision object with allowed/delayed/denied and associated metadata.
 */
async function evaluateDispatchPolicy(redis, bookId, chapterId, sceneId, stage, runtimeState) {
    const scene = {
        book_id: bookId,
        chapter_id: chapterId,
        scene_id: sceneId
    };

    // Classify workload
    const workload = workloadClassifier
        ? (await workloadClassifier.getClassification(redis, scene)).workload
        : 'standard';

    // Calculate priority
    const priorityScore = await runtimeMetrics.calculatePriorityScore(
        redis,
        bookId,
        chapterId,
        sceneId,
        scene
    );

    // Get runtime metrics
    const activeAudio = await getActiveCounter(redis, 'audio');
    const activeImage = await getActiveCounter(redis, 'image');
    const activeVideo = await getActiveCounter(redis, 'video');

    // Evaluate policy
    const decision = policyEngine
        ? await policyEngine.evaluatePolicy(redis, {
            scene,
            state: { stage },
            workload,
            priority: priorityScore,
            retryBudget: {},
            quotas: {
                audio: activeAudio,
                image: activeImage,
                video: activeVideo
            },
            circuits: {},
            runtimeMetrics: {
                active: {
                    audio: activeAudio,
                    image: activeImage,
                    video: activeVideo
                }
            },
            fairnessState: {}
        })
        : { allowed: true };

    return decision;
}

/**
 * Dispatch a scene stage using policy engine.
 * This is the ONLY way to start a scene stage.
 *
 * Returns:
 * - { dispatched: true, dispatchId, stage, leaseKey }
 * - { dispatched: false, reason, skip: true/false, decision: PolicyDecision }
 */
async function dispatchStageWithPolicy(redis, bookId, chapterId, sceneId, stage, loadedBook, buildId) {
    const dispatchId = generateDispatchToken();

    log(`DISPATCH_POLICY_REQUEST: ${bookId}/${chapterId}/${sceneId}:${stage}`);

    // Get runtime metrics
    const activeAudio = await getActiveCounter(redis, 'audio');
    const activeImage = await getActiveCounter(redis, 'image');
    const activeVideo = await getActiveCounter(redis, 'video');

    // Evaluate policy BEFORE any blocking operations
    const policyDecision = policyEngine
        ? await policyEngine.evaluatePolicy(redis, {
            scene: {
                book_id: bookId,
                chapter_id: chapterId,
                scene_id: sceneId
            },
            state: { stage },
            workload: 'MEDIUM',
            priority: 50,
            retryBudget: {},
            quotas: {
                audio: activeAudio,
                image: activeImage,
                video: activeVideo
            },
            circuits: {},
            runtimeMetrics: {
                active: {
                    audio: activeAudio,
                    image: activeImage,
                    video: activeVideo
                }
            },
            fairnessState: {}
        })
        : { allowed: true, decisionType: 'permit', priority: 50, throttle: 0, delayMs: 0 };

    // Log policy decision
    log(`POLICY_DECISION: ${policyDecision.decisionType} (priority=${policyDecision.priority}, throttle=${policyDecision.throttle}, delay=${policyDecision.delayMs}ms)`);

    // Check if policy allows dispatch
    if (!policyDecision.allowed) {
        await journal.appendSceneEvent(
            redis,
            bookId,
            chapterId,
            sceneId,
            policyDecision.eventType || 'POLICY_BLOCKED',
            stage,
            { ...policyDecision, reason: policyDecision.reason }
        );

        if (policyDecision.delayMs > 0) {
            log(`POLICY_DELAYED: ${bookId}/${chapterId}/${sceneId}:${stage} (${policyDecision.delayMs}ms)`);
            return { dispatched: false, reason: 'policy_delayed', delayMs: policyDecision.delayMs, decision: policyDecision, dispatchId };
        }

        log(`POLICY_BLOCKED: ${bookId}/${chapterId}/${sceneId}:${stage} (${policyDecision.reason})`);
        return { dispatched: false, reason: 'policy_blocked', decision: policyDecision, dispatchId };
    }

    // Apply throttle delay if present
    if (policyDecision.delayMs > 0) {
        log(`APPLYING_POLICY_DELAY: ${policyDecision.delayMs}ms`);
        // In production, this would await a timeout
    }

    // Proceed with dispatch
    const result = await dispatchStage(redis, bookId, chapterId, sceneId, stage, loadedBook, buildId);

    if (result.dispatched && costEstimator) {
        const scene = { book_id: bookId, chapter_id: chapterId, scene_id: sceneId };
        const costEstimate = await costEstimator.estimateSceneCost(redis, scene);
        log(`COST_ESTIMATED: ${bookId}/${chapterId}/${sceneId} = ${costEstimate.estimatedCost}gpu-sec`);
    }

    return result;
}

/**
 * Dispatch a scene stage.
 * This is the ONLY way to start a scene stage.
 *
 * Returns:
 * - { dispatched: true, dispatchId, stage, leaseKey }
 * - { dispatched: false, reason, skip: true/false }
 */
async function dispatchStage(redis, bookId, chapterId, sceneId, stage, loadedBook, buildId) {
    const dispatchId = generateDispatchToken();

    log(`DISPATCH_REQUEST: ${bookId}/${chapterId}/${sceneId}:${stage}`);

    // Phase 9 Step 0: Check circuit breaker
    const circuitStatus = circuitBreaker
        ? await circuitBreaker.checkDispatch(redis, stage)
        : { allowed: true };
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

    // Step 1: Check for duplicate/lease
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
    const retryBudgetCheck = retryBudget
        ? await retryBudget.checkRetryBudget(
            redis,
            bookId,
            chapterId,
            sceneId,
            stage,
            failureType,
            'scheduler'
        )
        : { allowed: true };
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
    if (fairness) {
        const fairnessStatus = await fairness.isStarving(redis, bookId, chapterId, sceneId);
        if (fairnessStatus.starving) {
            log(`STARVATION_DETECTED: ${bookId}/${chapterId}/${sceneId}:${stage} (age: ${fairnessStatus.ageMinutes}m)`);
            await fairness.boostStarvingScene(redis, bookId, chapterId, sceneId);
        }
    }

    // Step 3: Acquire lease
    const lease = await acquireStageLease(redis, bookId, chapterId, sceneId, stage);
    if (!lease.acquired) {
        // Release quota if lease acquisition failed
        await releaseQuota(redis, stage);
        return { dispatched: false, reason: lease.reason, dispatchId };
    }

    // Step 4: Set dispatch metadata
    const metadata = createDispatchMetadata(dispatchId, stage);
    await setDispatchMetadata(redis, bookId, chapterId, sceneId, stage, metadata);

    // Step 5: Log dispatch event
    await logDispatchEvent(redis, bookId, chapterId, sceneId, 'STARTED', stage, {
        dispatchId,
        leaseKey: lease.leaseKey,
        started_at: metadata.started_at
    });

    // Step 6: Get orchestrator to perform dispatch
    try {
        log(`[DISPATCH-DEBUG] Passing buildId=${buildId} to orchestrator for ${bookId}/${chapterId}/${sceneId}:${stage}`);
        const orchestrator = require('../orchestration');
        const result = await orchestrator.dispatchStage(
            redis,
            { book_id: bookId, chapter_id: chapterId, scene_id: sceneId },
            loadedBook,
            buildId
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

    log(`DISPATCH_COMPLETE: ${bookId}/${chapterId}/${sceneId}:${stage}`);

    // Phase 9: Record success for circuit breaker recovery
    if (circuitBreaker) {
        const circuitResult = await circuitBreaker.recordSuccess(redis, stage);
        if (circuitResult.state === circuitBreaker.CircuitState.HALF_OPEN && circuitResult.testRequest) {
            log(`CIRCUIT_HALF_OPEN_TEST: ${stage} (test request ${circuitResult.halfOpenCount})`);
        }
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
    if (circuitBreaker) {
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
 * Recover a stale lease.
 * Moves scene back to pending state.
 */
async function recoverStaleLease(redis, bookId, chapterId, sceneId, stage) {
    log(`RECOVERY_START: ${bookId}/${chapterId}/${sceneId}:${stage}`);

    const { leaseKey, token } = await getLeaseData(redis, bookId, chapterId, sceneId, stage);

    if (token) {
        // Release the stale lease
        await releaseStageLease(redis, leaseKey, token);
    }

    // Release quota (if leaked)
    await releaseQuota(redis, stage);

    // Move scene back to pending
    const currentState = await state.getSceneState(redis, bookId, chapterId, sceneId);
    if (currentState) {
        const pendingState = state.getRecoveryPendingState(currentState.state);
        if (pendingState) {
            await state.transitionSceneState(
                redis,
                bookId,
                chapterId,
                sceneId,
                pendingState
            );

            await logDispatchEvent(redis, bookId, chapterId, sceneId, 'STALE_LEASE_RECOVERED', pendingState, {
                recoveredFrom: currentState.state,
                stage
            });

            log(`RECOVERY_COMPLETE: ${bookId}/${chapterId}/${sceneId}:${stage} -> ${pendingState}`);
        }
    }
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
 * Get current renewal timer count.
 */
function getRenewalTimerCount() {
    return leaseManager.getRenewalCount();
}

// ======================================================
// RECONCILIATION UTILS
// ======================================================

/**
 * Reconcile counter drift for all stages.
 * Uses leases as source of truth.
 */
async function reconcileCounters(redis) {
    return await counterReconciliation.reconcileCounters(redis);
}

/**
 * Get reconciliation metrics.
 */
async function getReconciliationMetrics(redis) {
    return await counterReconciliation.getReconciliationMetrics(redis);
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
    getRenewalTimerCount,

    // Recovery
    recoverStaleLease,

    // Reconciliation
    reconcileCounters,
    getReconciliationMetrics,

    // Runtime metrics
    getRuntimeMetrics,

    // Metrics and debug
    getMetrics,
    getActiveDispatches,
    getActiveLeases,
    getQuotaStatus,

    // Policy engine integration
    evaluateDispatchPolicy,
    dispatchStageWithPolicy,

    // Constants
    QUOTAS,
    LEASE_TTLS
};
