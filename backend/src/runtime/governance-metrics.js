// ======================================================
// GOVERNANCE METRICS - RUNTIME OBSERVABILITY
// ======================================================
// Tracks and reports on governance decisions.
// Enables debugging and operational visibility.

const logPrefix = '[GOVERNANCE]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function debug(msg) {
    console.debug(`${logPrefix} • ${msg}`);
}

// ======================================================
// GOVERNANCE METRICS CONFIGURATION
// ======================================================

const METRICS_CONFIG = {
    // Retention settings
    historyLimit: 1000,
    aggregationWindowMs: 3600000, // 1 hour

    // Key patterns
    POLICY_BLOCK_KEY: 'animastor:runtime:policy:block',
    DISPATCH_DENY_KEY: 'animastor:runtime:dispatch:deny',
    STARVATION_CORRECT_KEY: 'animastor:runtime:starvation:correct',
    OVERLOAD_ADJUST_KEY: 'animastor:runtime:overload:adjust',
    ADAPTIVE_TUNE_KEY: 'animastor:runtime:adaptive:adjust',
    POLICY_OVERRIDE_KEY: 'animastor:runtime:policy:override',
    ADMISSION_TIGHTEN_KEY: 'animastor:runtime:admission:tighten',
    ADMISSION_RELAX_KEY: 'animastor:runtime:admission:relax',
    COST_MODEL_UPDATE_KEY: 'animastor:runtime:cost:model:updates',
    POLICY_CHAIN_KEY: 'animastor:runtime:policy:chain',
    DECISION_HISTORY_KEY: 'animastor:runtime:decision-history'
};

// ======================================================
// POLICY BLOCK COUNTS
// ======================================================

/**
 * Record policy block event.
 */
async function recordPolicyBlock(redis, policy, reason, scene) {
    const key = `${METRICS_CONFIG.POLICY_BLOCK_KEY}:${policy}`;
    const entry = {
        timestamp: Date.now(),
        reason,
        scene: scene,
        recordedAt: new Date().toISOString()
    };
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 999);
    return entry;
}

/**
 * Get policy block counts.
 */
async function getPolicyBlockCounts(redis) {
    const policies = ['overload', 'circuit', 'retry', 'workload', 'fairness', 'priority'];
    const counts = {};

    for (const policy of policies) {
        const key = `${METRICS_CONFIG.POLICY_BLOCK_KEY}:${policy}`;
        counts[policy] = await redis.llen(key);
    }

    return counts;
}

/**
 * Get recent policy blocks.
 */
async function getRecentPolicyBlocks(redis, policy = null, limit = 50) {
    let keys = [];
    if (policy) {
        keys.push(`${METRICS_CONFIG.POLICY_BLOCK_KEY}:${policy}`);
    } else {
        keys = ['overload', 'circuit', 'retry', 'workload', 'fairness', 'priority']
            .map(p => `${METRICS_CONFIG.POLICY_BLOCK_KEY}:${p}`);
    }

    const blocks = [];
    for (const key of keys) {
        const entries = await redis.lrange(key, 0, limit - 1);
        entries.forEach(e => blocks.push(JSON.parse(e)));
    }

    return blocks.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

// ======================================================
// DISPATCH DENIAL REASONS
// ======================================================

/**
 * Record dispatch denial.
 */
async function recordDispatchDenial(redis, reason, stage, scene, circuitState = null) {
    const key = `${METRICS_CONFIG.DISPATCH_DENY_KEY}:${reason}`;
    const entry = {
        timestamp: Date.now(),
        stage,
        scene,
        circuitState,
        recordedAt: new Date().toISOString()
    };
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 999);
    return entry;
}

/**
 * Get dispatch denial reasons.
 */
async function getDispatchDenialReasons(redis) {
    const reasons = ['circuit_open', 'backpressure', 'retry_budget_exceeded', 'duplicate', 'policy_blocked'];
    const counts = {};

    for (const reason of reasons) {
        const key = `${METRICS_CONFIG.DISPATCH_DENY_KEY}:${reason}`;
        counts[reason] = await redis.llen(key);
    }

    return counts;
}

/**
 * Get recent dispatch denials.
 */
async function getRecentDispatchDenials(redis, reason = null, limit = 100) {
    let keys = [];
    if (reason) {
        keys.push(`${METRICS_CONFIG.DISPATCH_DENY_KEY}:${reason}`);
    } else {
        keys = ['circuit_open', 'backpressure', 'retry_budget_exceeded', 'duplicate', 'policy_blocked']
            .map(r => `${METRICS_CONFIG.DISPATCH_DENY_KEY}:${r}`);
    }

    const denials = [];
    for (const key of keys) {
        const entries = await redis.lrange(key, 0, limit - 1);
        entries.forEach(e => denials.push(JSON.parse(e)));
    }

    return denials.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

// ======================================================
// STARVATION CORRECTION
// ======================================================

/**
 * Record starvation correction event.
 */
async function recordStarvationCorrection(redis, scene, boostApplied) {
    const key = METRICS_CONFIG.STARVATION_CORRECT_KEY;
    const entry = {
        timestamp: Date.now(),
        scene,
        boostApplied,
        recordedAt: new Date().toISOString()
    };
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 999);
    return entry;
}

/**
 * Get starvation correction count.
 */
async function getStarvationCorrectionCount(redis) {
    const key = METRICS_CONFIG.STARVATION_CORRECT_KEY;
    return await redis.llen(key);
}

/**
 * Get recent starvation corrections.
 */
async function getRecentStarvationCorrections(redis, limit = 50) {
    const key = METRICS_CONFIG.STARVATION_CORRECT_KEY;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

// ======================================================
// OVERLOAD ADJUSTMENT
// ======================================================

/**
 * Record overload adjustment.
 */
async function recordOverloadAdjustment(redis, adjustment) {
    const key = METRICS_CONFIG.OVERLOAD_ADJUST_KEY;
    const entry = {
        timestamp: Date.now(),
        ...adjustment,
        recordedAt: new Date().toISOString()
    };
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 999);
    return entry;
}

/**
 * Get overload adjustment count.
 */
async function getOverloadAdjustmentCount(redis) {
    const key = METRICS_CONFIG.OVERLOAD_ADJUST_KEY;
    return await redis.llen(key);
}

/**
 * Get recent overload adjustments.
 */
async function getRecentOverloadAdjustments(redis, limit = 50) {
    const key = METRICS_CONFIG.OVERLOAD_ADJUST_KEY;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

// ======================================================
// ADAPTIVE TUNING EVENTS
// ======================================================

/**
 * Record adaptive tuning event.
 */
async function recordAdaptiveTuning(redis, tuning) {
    const key = METRICS_CONFIG.ADAPTIVE_TUNE_KEY;
    const entry = {
        timestamp: Date.now(),
        ...tuning,
        recordedAt: new Date().toISOString()
    };
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 999);
    return entry;
}

/**
 * Get adaptive tuning count.
 */
async function getAdaptiveTuningCount(redis) {
    const key = METRICS_CONFIG.ADAPTIVE_TUNE_KEY;
    return await redis.llen(key);
}

/**
 * Get recent adaptive tunings.
 */
async function getRecentAdaptiveTunings(redis, limit = 100) {
    const key = METRICS_CONFIG.ADAPTIVE_TUNE_KEY;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

// ======================================================
// POLICY OVERRIDE COUNTS
// ======================================================

/**
 * Record policy override.
 */
async function recordPolicyOverride(redis, policy, override) {
    const key = `${METRICS_CONFIG.POLICY_OVERRIDE_KEY}:${policy}`;
    const entry = {
        timestamp: Date.now(),
        override,
        recordedAt: new Date().toISOString()
    };
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 999);
    return entry;
}

/**
 * Get policy override counts.
 */
async function getPolicyOverrideCounts(redis) {
    const policies = ['overload', 'circuit', 'retry', 'workload', 'fairness', 'priority'];
    const counts = {};

    for (const policy of policies) {
        const key = `${METRICS_CONFIG.POLICY_OVERRIDE_KEY}:${policy}`;
        counts[policy] = await redis.llen(key);
    }

    return counts;
}

// ======================================================
// ADMISSION TIGHTEN/RELAX
// ======================================================

/**
 * Record admission tightened event.
 */
async function recordAdmissionTightened(redis, reason) {
    const key = `${METRICS_CONFIG.ADMISSION_TIGHTEN_KEY}:${reason}`;
    const entry = {
        timestamp: Date.now(),
        recordedAt: new Date().toISOString()
    };
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 999);
    return entry;
}

/**
 * Record admission relaxed event.
 */
async function recordAdmissionRelaxed(redis, reason) {
    const key = `${METRICS_CONFIG.ADMISSION_RELAX_KEY}:${reason}`;
    const entry = {
        timestamp: Date.now(),
        recordedAt: new Date().toISOString()
    };
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 999);
    return entry;
}

/**
 * Get admission tightness counts.
 */
async function getAdmissionTightnessCounts(redis) {
    const reasons = ['runtime_unstable', 'capacity_constraints', 'high_retry_rate'];
    const tightened = {};

    for (const reason of reasons) {
        const key = `${METRICS_CONFIG.ADMISSION_TIGHTEN_KEY}:${reason}`;
        tightened[reason] = await redis.llen(key);
    }

    return { tightened };
}

/**
 * Get admission relaxation counts.
 */
async function getAdmissionRelaxationCounts(redis) {
    const reasons = ['runtime_stable', 'low_load', 'low_retry_rate'];
    const relaxed = {};

    for (const reason of reasons) {
        const key = `${METRICS_CONFIG.ADMISSION_RELAX_KEY}:${reason}`;
        relaxed[reason] = await redis.llen(key);
    }

    return { relaxed };
}

// ======================================================
// COST MODEL UPDATE EVENTS
// ======================================================

/**
 * Record cost model update.
 */
async function recordCostModelUpdate(redis, workload, adjustment) {
    const key = `${METRICS_CONFIG.COST_MODEL_UPDATE_KEY}:${workload}`;
    const entry = {
        timestamp: Date.now(),
        adjustment,
        recordedAt: new Date().toISOString()
    };
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 999);
    return entry;
}

/**
 * Get cost model update counts.
 */
async function getCostModelUpdateCounts(redis) {
    const workloads = ['LIGHT', 'MEDIUM', 'HEAVY', 'EXTREME'];
    const counts = {};

    for (const workload of workloads) {
        const key = `${METRICS_CONFIG.COST_MODEL_UPDATE_KEY}:${workload}`;
        counts[workload] = await redis.llen(key);
    }

    return counts;
}

// ======================================================
// POLICY CHAIN ANALYSIS
// ======================================================

/**
 * Record policy chain for analysis.
 */
async function recordPolicyChain(redis, chain) {
    const key = `${METRICS_CONFIG.POLICY_CHAIN_KEY}:${chain.scene.book_id}:${chain.scene.chapter_id}:${chain.scene.scene_id}`;
    const entry = {
        timestamp: Date.now(),
        ...chain,
        recordedAt: new Date().toISOString()
    };
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 99);
    return entry;
}

/**
 * Get policy chain for scene.
 */
async function getPolicyChain(redis, bookId, chapterId, sceneId, limit = 10) {
    const key = `${METRICS_CONFIG.POLICY_CHAIN_KEY}:${bookId}:${chapterId}:${sceneId}`;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

// ======================================================
// GOVERNANCE RECORDING HELPERS
// ======================================================

/**
 * Record(policy blocked) event.
 */
async function recordPolicyBlocked(redis, policy, scene, reason) {
    await recordPolicyBlock(redis, policy, reason, scene);
    return { recorded: true, policy, reason };
}

/**
 * Record(dispatch denied) event.
 */
async function recordDispatchDenied(redis, reason, stage, scene, circuitState = null) {
    await recordDispatchDenial(redis, reason, stage, scene, circuitState);
    return { recorded: true, reason, stage };
}

/**
 * Record(starvation corrected) event.
 */
async function recordStarvationCorrected(redis, scene, boost) {
    await recordStarvationCorrection(redis, scene, boost);
    return { recorded: true, scene, boost };
}

/**
 * Record(admission tightened) event.
 */
async function recordAdmissionTightenedEvent(redis, reason) {
    await recordAdmissionTightened(redis, reason);
    return { recorded: true, reason };
}

/**
 * Record(admission relaxed) event.
 */
async function recordAdmissionRelaxedEvent(redis, reason) {
    await recordAdmissionRelaxed(redis, reason);
    return { recorded: true, reason };
}

/**
 * Record(adaptive adjustment) event.
 */
async function recordAdaptiveAdjustmentEvent(redis, adjustment) {
    await recordAdaptiveTuning(redis, adjustment);
    return { recorded: true, adjustment };
}

/**
 * Record(cost model update) event.
 */
async function recordCostModelUpdateEvent(redis, workload, adjustment) {
    await recordCostModelUpdate(redis, workload, adjustment);
    return { recorded: true, workload, adjustment };
}

// ======================================================
// GOVERNANCE METRICS SUMMARY
// ======================================================

/**
 * Get comprehensive governance metrics summary.
 */
async function getGovernanceMetrics(redis) {
    const [policyBlocks, dispatchDenials, starvationCorrections, overloadAdjustments,
        adaptiveTunings, policyOverrides, admissionTightness, admissionRelaxation,
        costModelUpdates] = await Promise.all([
            getPolicyBlockCounts(redis),
            getDispatchDenialReasons(redis),
            getStarvationCorrectionCount(redis),
            getOverloadAdjustmentCount(redis),
            getAdaptiveTuningCount(redis),
            getPolicyOverrideCounts(redis),
            getAdmissionTightnessCounts(redis),
            getAdmissionRelaxationCounts(redis),
            getCostModelUpdateCounts(redis)
        ]);

    return {
        timestamp: Date.now(),
        recordCounts: {
            policyBlocks,
            dispatchDenials,
            starvationCorrections,
            overloadAdjustments,
            adaptiveTunings,
            policyOverrides,
            costModelUpdates
        },
        admissionTightness,
        admissionRelaxation,
        summary: {
            totalPolicyBlocks: Object.values(policyBlocks).reduce((a, b) => a + b, 0),
            totalDispatchDenials: Object.values(dispatchDenials).reduce((a, b) => a + b, 0),
            totalCostModelUpdates: Object.values(costModelUpdates).reduce((a, b) => a + b, 0)
        }
    };
}

/**
 * Get decision types summary.
 */
async function getDecisionTypesSummary(redis) {
    const decisionCounts = {
        accepted: 0,
        rejected: 0,
        delayed: 0,
        throttled: 0
    };

    // Count from decision history
    const historyKeys = await redis.keys('animastor:admission:history:*');
    const decisionValues = await redis.mget(...historyKeys.map(k => `${k}:latest`));

    // Alternative: Scan decision history
    const allHistory = [];
    for (const key of historyKeys) {
        const count = await redis.llen(key);
        allHistory.push({ key, count });
        const entries = await redis.lrange(key, 0, 9);
        entries.forEach(e => {
            const d = JSON.parse(e);
            if (decisionCounts[d.decision] !== undefined) {
                decisionCounts[d.decision]++;
            }
        });
    }

    return {
        decisionCounts,
        totalScenesWithHistory: historyKeys.length,
        totalDecisions: Object.values(decisionCounts).reduce((a, b) => a + b, 0)
    };
}

/**
 * Get blocked policies summary.
 */
async function getBlockedPoliciesSummary(redis, limit = 10) {
    const policies = ['overload', 'circuit', 'retry', 'workload', 'fairness', 'priority'];
    const blocks = [];

    for (const policy of policies) {
        const key = `${METRICS_CONFIG.POLICY_BLOCK_KEY}:${policy}`;
        const count = await redis.llen(key);
        blocks.push({ policy, count });
    }

    // Sort by count descending
    return blocks
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
}

/**
 * Get admission adjustments summary.
 */
async function getAdmissionAdjustmentsSummary(redis) {
    const tightenCounts = await getAdmissionTightnessCounts(redis);
    const relaxCounts = await getAdmissionRelaxationCounts(redis);

    const adjustments = {
        tightened: tightenCounts.tightened,
        relaxed: relaxCounts.relaxed,
        totalAdjustments: Object.values(tightenCounts.tightened).reduce((a, b) => a + b, 0) +
                         Object.values(relaxCounts.relaxed).reduce((a, b) => a + b, 0)
    };

    return adjustments;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    METRICS_CONFIG,

    // Policy block metrics
    recordPolicyBlock,
    getPolicyBlockCounts,
    getRecentPolicyBlocks,
    recordPolicyBlocked,

    // Dispatch denial metrics
    recordDispatchDenial,
    getDispatchDenialReasons,
    getRecentDispatchDenials,
    recordDispatchDenied,

    // Starvation correction metrics
    recordStarvationCorrection,
    getStarvationCorrectionCount,
    getRecentStarvationCorrections,
    recordStarvationCorrected,

    // Overload adjustment metrics
    recordOverloadAdjustment,
    getOverloadAdjustmentCount,
    getRecentOverloadAdjustments,

    // Adaptive tuning metrics
    recordAdaptiveTuning,
    getAdaptiveTuningCount,
    getRecentAdaptiveTunings,
    recordAdaptiveAdjustmentEvent,

    // Policy override metrics
    recordPolicyOverride,
    getPolicyOverrideCounts,

    // Admission metrics
    recordAdmissionTightened,
    recordAdmissionRelaxed,
    getAdmissionTightnessCounts,
    getAdmissionRelaxationCounts,
    recordAdmissionTightenedEvent,
    recordAdmissionRelaxedEvent,
    getAdmissionAdjustmentsSummary,

    // Cost model metrics
    recordCostModelUpdate,
    getCostModelUpdateCounts,
    recordCostModelUpdateEvent,

    // Governance summary
    getGovernanceMetrics,
    getDecisionTypesSummary,
    getBlockedPoliciesSummary
};
