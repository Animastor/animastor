// ======================================================
// ADMISSION CONTROL - RUNTIME GATING LAYER
// ======================================================
// Single authority for workload admission decisions.
// Runs BEFORE scheduler - prevents overload at intake.
//
// Architecture:
//   ingestion
//      ↓
//   admission-control (GATEKEEPER)
//      ↓
//   runtime scheduler
//      ↓
//   policy-engine
//      ↓
//   dispatch-engine
//      ↓
//   services

const circuitBreaker = require('./circuit-breaker');
const retryBudget = require('./retry-budget-manager');
const fairness = require('./fairness-engine');
const priorityManager = require('./priority-manager');
const runtimeMetrics = require('./runtime-metrics');
const workloadClassifier = require('./workload-classifier');
const feedbackEngine = require('./feedback-engine');
const decisionTrace = require('./decision-trace');

const logPrefix = '[ADMISSION]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function debug(msg) {
    console.debug(`${logPrefix} • ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

function error(msg) {
    console.error(`${logPrefix} ❌ ${msg}`);
}

// ======================================================
// ADMISSION CONFIGURATION
// ======================================================

const ADMISSION_CONFIG = {
    // Runtime load thresholds
    overloadActiveScenes: 100,
    overloadQuotaUtilization: 0.9, // 90% = overload

    // Retry pressure thresholds
    retryThresholdPerScene: 20,
    highRetryPressureScenes: 5, // >5 scenes with high retries = retry storm

    // Circuit breaker impact
    brokenVideoGracePeriod: 30000, // 30s grace before rejecting video

    // Admission decision defaults
    maxDelayMs: 60000, // 60 seconds max delay
    defaultPriority: 50,
    extremePriority: 30, // Lower priority for extreme workloads
    heavyPriority: 40,   // Lower priority for heavy workloads
    lightPriority: 70,   // Higher priority for light workloads

    // Backpressure at ingestion
    admissionQueueSize: 1000,
    maxEnqueuedWorkloads: 500
};

// ======================================================
// ADMISSION DECISION TYPES
// ======================================================

const AdmissionDecisionType = {
    ACCEPTED: 'accepted',
    REJECTED: 'rejected',
    DELAYED: 'delayed',
    THROTTLED: 'throttled'
};

// ======================================================
// ADMISSION REJECTION REASONS
// ======================================================

const RejectionReason = {
    OVERLOAD: 'overload',
    RETRY_STORM: 'retry_storm',
    CIRCUIT_OPEN: 'circuit_open',
    QUOTA_EXCEEDED: 'quota_exceeded',
    OVERWORKLOAD: 'overworkload',
    MAX_QUEUED: 'max_queued',
    UNKNOWN: 'unknown'
};

// ======================================================
// ADMISSION INPUTS
// ======================================================

/**
 * Validate admission request input.
 */
function validateAdmissionInput(input) {
    const errors = [];

    if (!input.scene) errors.push('scene required');
    if (!input.stage) errors.push('stage required');
    if (!input.priority) errors.push('priority required');
    if (!input.workload) errors.push('workload required');

    return {
        valid: errors.length === 0,
        errors
    };
}

// ======================================================
// GET RUNTIME STATE
// ======================================================

/**
 * Get current runtime state for admission decision.
 */
async function getRuntimeState(redis) {
    const activeScenes = await runtimeMetrics.getActiveScenesCount(redis);
    const activeAudio = await runtimeMetrics.getActiveStageCount(redis, 'audio');
    const activeImage = await runtimeMetrics.getActiveStageCount(redis, 'image');
    const activeVideo = await runtimeMetrics.getActiveStageCount(redis, 'video');
    const queuedWorkloads = await runtimeMetrics.getQueuedWorkloadsCount(redis);

    return {
        activeScenes,
        active: { audio: activeAudio, image: activeImage, video: activeVideo },
        queuedWorkloads,
        totalActive: activeAudio + activeImage + activeVideo
    };
}

/**
 * Get circuit breaker status for stage.
 */
async function getCircuitStatus(redis, stage) {
    return await circuitBreaker.checkDispatch(redis, stage);
}

/**
 * Get retry pressure for scene.
 */
async function getRetryPressure(redis, scene) {
    const key = `animastor:runtime:retry:${scene.book_id}:${scene.chapter_id}:${scene.scene_id}:count`;
    const count = parseInt(await redis.get(key) || '0', 10);

    // Check global retry pressure (multiple scenes with high retries)
    const highRetryPattern = 'animastor:runtime:retry:*:count';
    const patternKeys = [];
    let cursor = 0;
    let highRetryCount = 0;

    do {
        const result = await redis.scan(cursor, 'MATCH', highRetryPattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        const keys = result[1];

        for (const key of keys) {
            const val = parseInt(await redis.get(key) || '0', 10);
            if (val > 10) highRetryCount++;
        }
    } while (cursor !== 0);

    return {
        sceneRetries: count,
        sceneThresholdExceeded: count > ADMISSION_CONFIG.retryThresholdPerScene,
        globalRetryPressure: highRetryCount > ADMISSION_CONFIG.highRetryPressureScenes
    };
}

/**
 * Get quota status for stage.
 */
async function getQuotaStatus(redis, stage) {
    const activeKey = `animastor:runtime:active-${stage}`;
    const active = parseInt(await redis.get(activeKey) || '0', 10);

    let quota;
    switch (stage) {
        case 'audio': quota = 3; break;
        case 'image': quota = 2; break;
        case 'video': quota = 1; break;
        default: quota = 2;
    }

    return {
        active,
        quota,
        utilization: active / quota,
        exceeded: active >= quota
    };
}

// ======================================================
// ADMISSION POLICIES ( individual policy checks )
// ======================================================

/**
 * [Policy 1] Overload check
 * Reject LOW priority EXTREME workloads when overloaded.
 */
async function checkOverloadPolicy(redis, scene, stage, workload, runtimeState) {
    const overloaded = runtimeState.totalActive >= ADMISSION_CONFIG.overloadActiveScenes;
    const overloadedQuota = Object.values(runtimeState.active).some(
        a => a >= ADMISSION_CONFIG.overloadQuotaUtilization * 10
    );

    if (!overloaded && !overloadedQuota) {
        return {
            allowed: true,
            reason: 'healthy_runtime',
            delayMs: 0,
            suggestedPriority: null
        };
    }

    // Calculate throttling based on workload
    let throttle = 1.0;
    let suggestedPriority = null;

    if (workload === workloadClassifier.WorkloadClass.EXTREME) {
        throttle = 0.2;
        suggestedPriority = Math.min(scene.priority, ADMISSION_CONFIG.extremePriority);
    } else if (workload === workloadClassifier.WorkloadClass.HEAVY) {
        throttle = 0.5;
        suggestedPriority = Math.min(scene.priority, ADMISSION_CONFIG.heavyPriority);
    }

    // Quota-based delay
    let delayMs = 0;
    if (overloadedQuota) {
        const maxQuota = Math.max(...Object.values(runtimeState.active));
        const utilization = maxQuota / 10;
        if (utilization > ADMISSION_CONFIG.overloadQuotaUtilization) {
            delayMs = Math.min(
                ADMISSION_CONFIG.maxDelayMs,
                Math.floor(1000 * (1 / (1 - utilization)))
            );
        }
    }

    // Reject if zero throttle and EXTREME
    if (throttle === 0 && workload === workloadClassifier.WorkloadClass.EXTREME) {
        return {
            allowed: false,
            reason: RejectionReason.OVERLOAD,
            delayMs: 0,
            suggestedPriority
        };
    }

    return {
        allowed: throttle > 0,
        reason: overloaded ? 'overload_active' : 'quota_constrained',
        delayMs,
        suggestedPriority,
        throttle,
        overload: overloaded
    };
}

/**
 * [Policy 2] Retry storm check
 * Slow down retries when retry pressure is high.
 */
async function checkRetryPressure(redis, scene, workload, retryPressure) {
    if (!retryPressure.globalRetryPressure && !retryPressure.sceneThresholdExceeded) {
        return {
            allowed: true,
            reason: 'healthy_retry_level',
            delayMs: 0,
            suggestedPriority: null
        };
    }

    let delayMs = 0;
    let suggestedPriority = null;

    if (retryPressure.sceneThresholdExceeded) {
        delayMs = 5000; // 5 second delay for high-retry scenes
        suggestedPriority = Math.min(scene.priority || 50, 20);
    }

    if (retryPressure.globalRetryPressure) {
        // Global retry storm - slow all new retries
        delayMs = Math.max(delayMs, 10000); // 10 second base delay
    }

    return {
        allowed: true,
        reason: 'retry_pressure_applied',
        delayMs,
        suggestedPriority,
        retryPressure: {
            sceneRetries: retryPressure.sceneRetries,
            globalPressure: retryPressure.globalRetryPressure
        }
    };
}

/**
 * [Policy 3] Circuit breaker check
 * Reject heavy workloads when circuit is open.
 */
async function checkCircuit(redis, stage, runtimeState) {
    const circuitStatus = await getCircuitStatus(redis, stage);

    if (circuitStatus.allowed) {
        return {
            allowed: true,
            reason: 'circuit_closed',
            delayMs: 0
        };
    }

    // Circuit open - reject heavy workloads
    let allowed = true;
    let reason = 'circuit_open';

    if (stage === 'video' && runtimeState.active.video > 0) {
        // Allow existing video jobs to complete (grace period)
        return {
            allowed: true,
            reason: 'circuit_open_grace_period',
            delayMs: ADMISSION_CONFIG.brokenVideoGracePeriod
        };
    }

    if (stage === 'video' || runtimeState.totalActive > 5) {
        allowed = false;
        reason = RejectionReason.CIRCUIT_OPEN;
    }

    return {
        allowed,
        reason,
        delayMs: 0,
        circuitOpen: circuitStatus.circuitState,
        stage
    };
}

/**
 * [Policy 4] Quota check
 * Reject when quota exceeded for stage.
 */
async function checkQuota(redis, stage) {
    const quotaStatus = await getQuotaStatus(redis, stage);

    if (!quotaStatus.exceeded) {
        return {
            allowed: true,
            reason: 'quota_available',
            delayMs: 0,
            active: quotaStatus.active,
            quota: quotaStatus.quota
        };
    }

    return {
        allowed: false,
        reason: RejectionReason.QUOTA_EXCEEDED,
        delayMs: 2000, // 2 second delay
        active: quotaStatus.active,
        quota: quotaStatus.quota,
        utilization: quotaStatus.utilization
    };
}

/**
 * [Policy 5] Overworkload check
 * Reject extreme workloads when runtime warning.
 */
async function checkOverworkload(workload, runtimeState) {
    if (workload !== workloadClassifier.WorkloadClass.EXTREME) {
        return {
            allowed: true,
            reason: 'normal_workload',
            throttle: 1.0
        };
    }

    // Extreme workload - check if runtime is already busy
    const isBusy = runtimeState.totalActive >= 20;
    const quotaUtilized = Object.values(runtimeState.active).every(a => a > 0);

    if (isBusy || quotaUtilized) {
        return {
            allowed: false,
            reason: RejectionReason.OVERWORKLOAD,
            delayMs: 30000, // 30 second delay
            throttle: 0.2,
            workload
        };
    }

    return {
        allowed: true,
        reason: 'extended_overworkload',
        delayMs: 10000, // 10 second delay
        throttle: 0.5,
        workload
    };
}

// ======================================================
// MAIN ADMISSION CONTROL
// ======================================================

/**
 * Evaluate all admission policies and return unified decision.
 */
async function evaluateAdmission(redis, scene, stage, runtimeState = null, retryPressure = null) {
    const workload = scene.workload || workloadClassifier.WorkloadClass.MEDIUM;
    const priority = scene.priority || ADMISSION_CONFIG.defaultPriority;

    log(`ADMISSION_REQUEST: ${scene.book_id}/${scene.chapter_id}/${scene.scene_id}:${stage} (${workload})`);

    // Validate input
    const validation = validateAdmissionInput({ scene, stage, workload, priority });
    if (!validation.valid) {
        return {
            decision: AdmissionDecisionType.REJECTED,
            reason: RejectionReason.UNKNOWN,
            errors: validation.errors
        };
    }

    // Get runtime state if not provided
    const state = runtimeState || await getRuntimeState(redis);
    const pressure = retryPressure || await getRetryPressure(redis, scene);

    // Collect all policy results
    const policyResults = [];

    // Policy 1: Overload check
    const overloadPolicy = await checkOverloadPolicy(redis, scene, stage, workload, state);
    policyResults.push({ type: 'overload', ...overloadPolicy });

    // Policy 2: Retry pressure check
    const retryPolicy = await checkRetryPressure(redis, scene, workload, pressure);
    policyResults.push({ type: 'retry', ...retryPolicy });

    // Policy 3: Circuit breaker check
    const circuitPolicy = await checkCircuit(redis, stage, state);
    policyResults.push({ type: 'circuit', ...circuitPolicy });

    // Policy 4: Quota check
    const quotaPolicy = await checkQuota(redis, stage);
    policyResults.push({ type: 'quota', ...quotaPolicy });

    // Policy 5: Overworkload check
    const overworkloadPolicy = await checkOverworkload(workload, state);
    policyResults.push({ type: 'overworkload', ...overworkloadPolicy });

    // ======================================================
    // UNIFIED DECISION
    // ======================================================

    // Check for hard rejections
    const hardRejections = policyResults.filter(p => !p.allowed && p.reason !== 'healthy_runtime');
    if (hardRejections.length > 0) {
        const primaryReason = hardRejections.find(p => p.reason !== 'quota_exceeded' && p.reason !== 'overload_active');
        const reason = primaryReason ? primaryReason.reason : hardRejections[0].reason;

        log(`ADMISSION_REJECTED: ${scene.book_id}/${scene.chapter_id}/${scene.scene_id}:${stage} (${reason})`);

        return {
            decision: AdmissionDecisionType.REJECTED,
            reason,
            delayMs: 0,
            suggestedPriority: null,
            policyResults
        };
    }

    // Check for delays (soft rejections)
    const maxDelay = Math.max(...policyResults.map(p => p.delayMs || 0));
    if (maxDelay > 0) {
        const throttledPolicies = policyResults.filter(p => p.throttle && p.throttle < 1);
        const suggestedPriority = policyResults.reduce((min, p) => {
            return p.suggestedPriority !== null ? Math.min(min, p.suggestedPriority) : min;
        }, priority);

        log(`ADMISSION_DELAYED: ${scene.book_id}/${scene.chapter_id}/${scene.scene_id}:${stage} (${maxDelay}ms)`);

        return {
            decision: AdmissionDecisionType.DELAYED,
            reason: 'delayed_by_policies',
            delayMs: maxDelay,
            suggestedPriority,
            throttle: throttledPolicies.length > 0
                ? Math.min(...throttledPolicies.map(p => p.throttle || 1))
                : 1.0,
            policyResults
        };
    }

    // Check for throttling
    const throttledPolicies = policyResults.filter(p => p.throttle && p.throttle < 1);
    if (throttledPolicies.length > 0) {
        log(`ADMISSION_THROTTLED: ${scene.book_id}/${scene.chapter_id}/${scene.scene_id}:${stage}`);

        return {
            decision: AdmissionDecisionType.THROTTLED,
            reason: 'throttled_by_overload',
            delayMs: 0,
            suggestedPriority: null,
            throttle: Math.min(...throttledPolicies.map(p => p.throttle || 1)),
            policyResults
        };
    }

    // ACCEPTED
    log(`ADMISSION_ACCEPTED: ${scene.book_id}/${scene.chapter_id}/${scene.scene_id}:${stage}`);

    return {
        decision: AdmissionDecisionType.ACCEPTED,
        reason: 'all_policies_passed',
        delayMs: 0,
        suggestedPriority: null,
        throttle: 1.0,
        policyResults
    };
}

/**
 * Check if workload can be admitted (simplified).
 * Returns: { admitted: boolean, reason, delayMs }
 */
async function canAdmit(redis, scene, stage, runtimeState = null) {
    const result = await evaluateAdmission(redis, scene, stage, runtimeState);
    return {
        admitted: result.decision === AdmissionDecisionType.ACCEPTED,
        reason: result.reason,
        delayMs: result.decision === AdmissionDecisionType.DELAYED ? result.delayMs : 0,
        throttled: result.decision === AdmissionDecisionType.THROTTLED
    };
}

// ======================================================
// ENQUEUE ADMISSION DECISION
// ======================================================

/**
 * Record admission decision to journal for audit trail.
 */
async function recordAdmissionDecision(redis, scene, stage, decision) {
    const key = `animastor:admission:history:${scene.book_id}:${scene.chapter_id}:${scene.scene_id}`;
    const entry = {
        stage,
        decision: decision.decision,
        reason: decision.reason,
        delayMs: decision.delayMs,
        timestamp: Date.now(),
        policyResults: decision.policyResults.map(p => ({ type: p.type, allowed: p.allowed }))
    };

    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 99); // Keep last 100 entries
}

// ======================================================
// DEBUG: Get admission status
// ======================================================

/**
 * Get admission control status.
 */
async function getStatus(redis) {
    const runtimeState = await getRuntimeState(redis);
    const circuitStatus = {
        audio: await circuitBreaker.checkDispatch(redis, 'audio'),
        image: await circuitBreaker.checkDispatch(redis, 'image'),
        video: await circuitBreaker.checkDispatch(redis, 'video')
    };

    return {
        config: ADMISSION_CONFIG,
        runtimeState,
        circuits: {
            audio: circuitStatus.audio.circuitState,
            image: circuitStatus.image.circuitState,
            video: circuitStatus.video.circuitState
        },
        stability: await feedbackEngine.calculateStabilityScore(redis),
        recentAdjustments: await getAdaptiveAdjustmentsHistory(redis, 5)
    };
}

// ======================================================
// ADAPTIVE ADMISSION - USING FEEDBACK LOOPS (Phase 12)
// ======================================================

/**
 * Get adaptive admission configuration based on runtime stability.
 * Adjusts thresholds based on feedback.
 */
async function getAdaptiveAdmissionConfig(redis) {
    const stabilityScore = await feedbackEngine.calculateStabilityScore(redis);

    // Base config
    let config = { ...ADMISSION_CONFIG };

    // Adjust based on stability
    if (stabilityScore.score < 60) {
        // Unstable - be stricter
        config.overloadActiveScenes = Math.round(config.overloadActiveScenes * 0.8);
        config.overloadQuotaUtilization = config.overloadQuotaUtilization * 0.9;
        config.maxDelayMs = Math.round(config.maxDelayMs * 1.5);
        config.adjustmentReason = 'runtime_unstable';
    } else if (stabilityScore.score > 85) {
        // Very stable - can be more lenient
        config.overloadActiveScenes = Math.round(config.overloadActiveScenes * 1.1);
        config.overloadQuotaUtilization = Math.min(0.95, config.overloadQuotaUtilization * 1.05);
        config.adjustmentReason = 'runtime_stable';
    } else {
        config.adjustmentReason = 'normal';
    }

    return {
        ...config,
        stabilityScore: stabilityScore.score,
        stabilityStatus: stabilityScore.score >= 80 ? 'stable' : stabilityScore.score >= 60 ? 'warning' : 'unstable'
    };
}

/**
 * Log adaptive admission adjustment.
 */
async function logAdaptiveAdjustment(redis, adjustment) {
    const key = 'animastor:runtime:adaptive:admission:adjustments';
    const entry = {
        ...adjustment,
        timestamp: Date.now(),
        recordedAt: new Date().toISOString()
    };
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 99);
}

/**
 * Get adaptive admission adjustments history.
 */
async function getAdaptiveAdjustmentsHistory(redis, limit = 10) {
    const key = 'animastor:runtime:adaptive:admission:adjustments';
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

/**
 * Get admission history for scene.
 */
async function getHistory(redis, bookId, chapterId, sceneId, limit = 10) {
    const key = `animastor:admission:history:${bookId}:${chapterId}:${sceneId}`;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Decision types
    AdmissionDecisionType,
    AdmissionDecision: {
        ACCEPTED: 'accepted',
        REJECTED: 'rejected',
        DELAYED: 'delayed',
        THROTTLED: 'throttled'
    },

    // Rejection reasons
    RejectionReason,

    // Config
    ADMISSION_CONFIG,

    // Main admission control
    evaluateAdmission,
    canAdmit,
    recordAdmissionDecision,

    // Runtime state
    getRuntimeState,
    getCircuitStatus,
    getRetryPressure,
    getQuotaStatus,

    // Policies (individual for testing/composition)
    checkOverloadPolicy,
    checkRetryPressure,
    checkCircuit,
    checkQuota,
    checkOverworkload,

    // Debug
    getStatus,
    getHistory
};
