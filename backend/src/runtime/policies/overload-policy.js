// ======================================================
// OVERLOAD POLICY - RUNTIME OVERLOAD DETECTION
// ======================================================
// Detects runtime overload and responds with throttling or rejection.
// Protects system from saturation.

const logPrefix = '[POLICY:OVERLOAD]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

// ======================================================
// OVERLOAD CONFIGURATION
// ======================================================

const OVERLOAD_CONFIG = {
    // Active scenes thresholds
    criticalScenesThreshold: 100,
    warningScenesThreshold: 75,
    normalScenesThreshold: 50,

    // Per-stage active thresholds
    criticalPerStage: 10,
    warningPerStage: 7,
    normalPerStage: 5,

    // Quota utilization thresholds
    criticalQuotaUtilization: 0.95,
    warningQuotaUtilization: 0.85,
    normalQuotaUtilization: 0.70,

    // Delay calculations
    baseDelayMs: 1000,
    maxDelayMs: 60000,

    // Throttling multipliers
    criticalThrottle: 0.1,  // 10% rate
    warningThrottle: 0.5,   // 50% rate
    normalThrottle: 1.0     // 100% rate
};

// ======================================================
// OVERLOAD STATE KEYS
// ======================================================

const OVERLOAD_KEY = 'animastor:runtime:overload';

// ======================================================
// POLICY DECISION TYPES
// ======================================================

const OverloadDecisionType = {
    HEALTHY: 'healthy',
    WARNING: 'warning',
    CRITICAL: 'critical',
    REJECTING: 'rejecting'
};

// ======================================================
// GET RUNTIME METRICS
// ======================================================

/**
 * Get current runtime metrics.
 */
async function getRuntimeMetrics(redis) {
    // Get active scenes count
    const scenes = await redis.scard('animastor:active-scenes');

    // Get per-stage counts
    const [audio, image, video] = await Promise.all([
        redis.get('animastor:runtime:active-audio'),
        redis.get('animastor:runtime:active-image'),
        redis.get('animastor:runtime:active-video')
    ]);

    return {
        activeScenes: parseInt(scenes || '0', 10),
        perStage: {
            audio: parseInt(audio || '0', 10),
            image: parseInt(image || '0', 10),
            video: parseInt(video || '0', 10)
        },
        totalActive: parseInt(audio || '0', 10) + parseInt(image || '0', 10) + parseInt(video || '0', 10)
    };
}

/**
 * Get quota status (assuming base quota of 10 per stage).
 */
function getQuotaStatus(perStage) {
    const baseQuota = 10;
    return {
        audio: perStage.audio / baseQuota,
        image: perStage.image / baseQuota,
        video: perStage.video / baseQuota
    };
}

// ======================================================
// OVERLOAD DETECTION
// ======================================================

/**
 * Determine current overload state.
 */
async function detectOverload(redis) {
    const metrics = await getRuntimeMetrics(redis);
    const quotaUtil = getQuotaStatus(metrics.perStage);

    // Determine overload level
    let level;
    let reason;

    // CRITICAL: too many scenes OR quota heavily utilized
    if (metrics.activeScenes >= OVERLOAD_CONFIG.criticalScenesThreshold) {
        level = OverloadDecisionType.CRITICAL;
        reason = 'too_many_active_scenes';
    } else if (metrics.totalActive >= OVERLOAD_CONFIG.criticalPerStage) {
        level = OverloadDecisionType.CRITICAL;
        reason = 'critical_stage_load';
    } else if (Object.values(quotaUtil).some(u => u >= OVERLOAD_CONFIG.criticalQuotaUtilization)) {
        level = OverloadDecisionType.CRITICAL;
        reason = 'critical_quota_utilization';
    }

    // WARNING: elevated but not critical
    else if (metrics.activeScenes >= OVERLOAD_CONFIG.warningScenesThreshold) {
        level = OverloadDecisionType.WARNING;
        reason = 'elevated_active_scenes';
    } else if (metrics.totalActive >= OVERLOAD_CONFIG.warningPerStage) {
        level = OverloadDecisionType.WARNING;
        reason = 'elevated_stage_load';
    } else if (Object.values(quotaUtil).some(u => u >= OVERLOAD_CONFIG.warningQuotaUtilization)) {
        level = OverloadDecisionType.WARNING;
        reason = 'elevated_quota_utilization';
    }

    // HEALTHY: all normal
    else {
        level = OverloadDecisionType.HEALTHY;
        reason = 'system_healthy';
    }

    // Calculate throttle based on level
    let throttle;
    let delayMs = 0;

    switch (level) {
        case OverloadDecisionType.CRITICAL:
            throttle = OVERLOAD_CONFIG.criticalThrottle;
            delayMs = Math.min(
                OVERLOAD_CONFIG.maxDelayMs,
                Math.floor(OVERLOAD_CONFIG.baseDelayMs * (1 / (1 - Math.max(...Object.values(quotaUtil)))))
            );
            break;
        case OverloadDecisionType.WARNING:
            throttle = OVERLOAD_CONFIG.warningThrottle;
            break;
        default:
            throttle = OVERLOAD_CONFIG.normalThrottle;
    }

    return {
        level,
        reason,
        metrics,
        quotaUtilization: quotaUtil,
        throttle,
        delayMs,
        rejecting: level === OverloadDecisionType.CRITICAL
    };
}

/**
 * Check if overload is critical (system near saturation).
 */
async function isOverloadCritical(redis) {
    const state = await detectOverload(redis);
    return {
        critical: state.level === OverloadDecisionType.CRITICAL,
        ...state
    };
}

/**
 * Check if overload is in warning state.
 */
async function isOverloadWarning(redis) {
    const state = await detectOverload(redis);
    return {
        warning: state.level === OverloadDecisionType.WARNING,
        ...state
    };
}

// ======================================================
// POLICY EVALUATION
// ======================================================

/**
 * Evaluate overload policy for scene/stage.
 * Returns decision with throttle and delay recommendations.
 */
async function evaluate(redis, scene, stage, workload) {
    const overload = await detectOverload(redis);

    // Calculate workload-specific throttling
    let throttledWorkload = workload === 'EXTREME';
    let workloadMultiplier = 1.0;

    if (overload.level === OverloadDecisionType.CRITICAL) {
        if (workload === 'EXTREME') {
            throttledWorkload = true;
            workloadMultiplier = 0.2;
        } else if (workload === 'HEAVY') {
            workloadMultiplier = 0.5;
        }
    } else if (overload.level === OverloadDecisionType.WARNING) {
        if (workload === 'EXTREME' || workload === 'HEAVY') {
            workloadMultiplier = 0.8;
        }
    }

    // Combine overload throttle with workload throttle
    const effectiveThrottle = Math.min(overload.throttle * workloadMultiplier, 1.0);
    const effectiveDelay = overload.delayMs;

    // Determine decision
    let decisionType;
    let reason;

    if (overload.level === OverloadDecisionType.CRITICAL && throttledWorkload) {
        decisionType = OverloadDecisionType.REJECTING;
        reason = 'critical_overload_extreme_workload';
    } else if (overload.level === OverloadDecisionType.CRITICAL) {
        decisionType = OverloadDecisionType.CRITICAL;
        reason = 'critical_overload_active';
    } else if (overload.level === OverloadDecisionType.WARNING) {
        decisionType = OverloadDecisionType.WARNING;
        reason = 'overload_warning_active';
    } else {
        decisionType = OverloadDecisionType.HEALTHY;
        reason = overload.reason;
    }

    log(`OVERLOAD_POLICY_EVAL: ${reason} (throttle=${effectiveThrottle.toFixed(2)})`);

    return {
        decisionType,
        allowed: decisionType !== OverloadDecisionType.REJECTING,
        reason,
        overloadState: overload,
        effectiveThrottle: effectiveThrottle,
        delayMs: effectiveDelay,
        throttledWorkload,
        workload
    };
}

// ======================================================
// ACTIVE SCENE LIMIT CHECK
// ======================================================

/**
 * Check if system can accept new scenes.
 */
async function canAcceptNewScenes(redis, count = 1) {
    const state = await detectOverload(redis);
    const remainingCapacity = OVERLOAD_CONFIG.criticalScenesThreshold - state.metrics.activeScenes;

    return {
        canAccept: remainingCapacity >= count,
        remainingCapacity,
        currentActive: state.metrics.activeScenes,
        criticalThreshold: OVERLOAD_CONFIG.criticalScenesThreshold
    };
}

/**
 * Get remaining capacity for new scenes.
 */
async function getRemainingCapacity(redis) {
    const state = await detectOverload(redis);
    return {
        scenes: Math.max(0, OVERLOAD_CONFIG.criticalScenesThreshold - state.metrics.activeScenes),
        stages: {
            audio: Math.max(0, OVERLOAD_CONFIG.criticalPerStage - state.metrics.perStage.audio),
            image: Math.max(0, OVERLOAD_CONFIG.criticalPerStage - state.metrics.perStage.image),
            video: Math.max(0, OVERLOAD_CONFIG.criticalPerStage - state.metrics.perStage.video)
        }
    };
}

// ======================================================
// OVERLOAD HISTORY
// ======================================================

const OVERLOAD_HISTORY_KEY = 'animastor:runtime:overload:history';

/**
 * Record overload event for history.
 */
async function recordOverloadEvent(redis, event) {
    const key = OVERLOAD_HISTORY_KEY;
    const entry = {
        ...event,
        timestamp: Date.now()
    };
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 999); // Keep last 1000 entries
}

/**
 * Get recent overload history.
 */
async function getOverloadHistory(redis, limit = 50) {
    const key = OVERLOAD_HISTORY_KEY;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

// ======================================================
// POLICY PRECEDENCE
// ======================================================
// Overload policy has very high precedence for system protection.

const OVERLOAD_PRECEDENCE = 1; // Highest precedence (first checked)

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    OverloadDecisionType,
    OVERLOAD_CONFIG,

    // Runtime metrics
    getRuntimeMetrics,
    detectOverload,
    isOverloadCritical,
    isOverloadWarning,

    // Policy evaluation
    evaluate,

    // Capacity management
    canAcceptNewScenes,
    getRemainingCapacity,

    // History
    recordOverloadEvent,
    getOverloadHistory,

    // Precedence
    OVERLOAD_PRECEDENCE
};
