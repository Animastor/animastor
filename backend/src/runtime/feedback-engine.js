const {
    log, warn, FEEDBACK_CONFIG, FEEDBACK_PREFIX,
    ADJUSTMENT_HISTORY_KEY, METRICS_HISTORY_KEY, COST_HISTORY_KEY,
} = require('./feedback-config');
const {
    createSample,
    recordRenderDuration, recordRetryOutcome, recordFailure,
    recordOverloadEvent, recordQueueWaitTime,
    recordStarvationEvent, recordCircuitEvent,
    storeSample, getSamples, getRecentSamples,
} = require('./feedback-recorder');

function calculateAverage(samples) {
    if (samples.length === 0) return 0;
    const sum = samples.reduce((acc, s) => acc + s.value, 0);
    return sum / samples.length;
}

function calculatePercentile(samples, percentile) {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a.value - b.value);
    const index = Math.floor((percentile / 100) * sorted.length);
    return sorted[index]?.value || 0;
}

function calculateStdDev(samples) {
    if (samples.length < 2) return 0;
    const avg = calculateAverage(samples);
    const squaredDiffs = samples.map(s => Math.pow(s.value - avg, 2));
    return Math.sqrt(calculateAverage(squaredDiffs));
}

function calculateSuccessRate(samples) {
    if (samples.length === 0) return 0;
    const successCount = samples.filter(s => s.value === 1).length;
    return (successCount / samples.length) * 100;
}

async function applyAdjustment(redis, adjustment) {
    const historyKey = ADJUSTMENT_HISTORY_KEY;
    const adjustmentWithTime = {
        ...adjustment,
        appliedAt: Date.now(),
        appliedAtFormatted: new Date().toISOString()
    };

    await redis.lpush(historyKey, JSON.stringify(adjustmentWithTime));
    await redis.ltrim(historyKey, 0, 999);

    log(`ADJUSTMENT_APPLIED: ${adjustment.adjustmentType} = ${JSON.stringify(adjustment.adjustments)}`);

    return adjustmentWithTime;
}

async function adjustQuotas(redis, currentQuotas, feedback) {
    const key = `${FEEDBACK_PREFIX}:quotas:adjustments`;
    const lastAdjustment = await redis.get(key);

    if (lastAdjustment) {
        const age = Date.now() - parseInt(lastAdjustment, 10);
        if (age < FEEDBACK_CONFIG.thresholdUpdateMinDelayMs) {
            return null;
        }
    }

    const adjustments = {};
    let adjusted = false;

    Object.entries(currentQuotas).forEach(([stage, current]) => {
        if (current > 0.85) {
            adjustments[stage] = Math.min(10, current + 1);
            adjusted = true;
        }
        else if (current < 0.3) {
            adjustments[stage] = Math.max(1, current - 1);
            adjusted = true;
        }
    });

    if (!adjusted) return null;

    await redis.set(key, Date.now().toString());

    return await applyAdjustment(redis, {
        adjustmentType: FEEDBACK_CONFIG.adjustments.QUOTAS,
        previous: currentQuotas,
        adjustments,
        reason: 'Quota utilization feedback'
    });
}

async function adjustRetryDelays(redis, currentDelays, successRate) {
    const key = `${FEEDBACK_PREFIX}:retry_delays:adjustments`;
    const lastAdjustment = await redis.get(key);

    if (lastAdjustment) {
        const age = Date.now() - parseInt(lastAdjustment, 10);
        if (age < FEEDBACK_CONFIG.thresholdUpdateMinDelayMs) {
            return null;
        }
    }

    let adjustmentFactor = 1.0;
    let reason = '';

    if (successRate < 50) {
        adjustmentFactor = 1.5;
        reason = 'Low success rate detected';
    }
    else if (successRate > 80) {
        adjustmentFactor = 0.8;
        reason = 'High success rate detected';
    }

    if (adjustmentFactor === 1.0) return null;

    const adjustedDelays = {
        baseDelayMs: Math.round(currentDelays.baseDelayMs * adjustmentFactor),
        maxDelayMs: Math.round(currentDelays.maxDelayMs * adjustmentFactor)
    };

    await redis.set(key, Date.now().toString());

    return await applyAdjustment(redis, {
        adjustmentType: FEEDBACK_CONFIG.adjustments.RETRY_DELAY,
        previous: currentDelays,
        adjustments: adjustedDelays,
        reason,
        successRate
    });
}

async function adjustOverloadThresholds(redis, currentThreshold, overloadEvents) {
    const key = `${FEEDBACK_PREFIX}:overload:adjustments`;
    const lastAdjustment = await redis.get(key);

    if (lastAdjustment) {
        const age = Date.now() - parseInt(lastAdjustment, 10);
        if (age < FEEDBACK_CONFIG.thresholdUpdateMinDelayMs) {
            return null;
        }
    }

    let adjustmentFactor = 1.0;
    let reason = '';

    if (overloadEvents > 10) {
        adjustmentFactor = 0.8;
        reason = 'High overload frequency - being stricter';
    }
    else if (overloadEvents < 2) {
        adjustmentFactor = 1.2;
        reason = 'Low overload frequency - being more lenient';
    }

    if (adjustmentFactor === 1.0) return null;

    const adjustedThreshold = Math.round(currentThreshold * adjustmentFactor);

    await redis.set(key, Date.now().toString());

    return await applyAdjustment(redis, {
        adjustmentType: FEEDBACK_CONFIG.adjustments.OVERLOAD_THRESHOLD,
        previous: currentThreshold,
        adjustments: adjustedThreshold,
        reason,
        overloadEvents
    });
}

async function adjustStarvationBoost(redis, currentBoost, starvationEvents) {
    const key = `${FEEDBACK_PREFIX}:starvation:adjustments`;
    const lastAdjustment = await redis.get(key);

    if (lastAdjustment) {
        const age = Date.now() - parseInt(lastAdjustment, 10);
        if (age < FEEDBACK_CONFIG.thresholdUpdateMinDelayMs) {
            return null;
        }
    }

    let adjustmentFactor = 1.0;
    let reason = '';

    if (starvationEvents > 5) {
        adjustmentFactor = 1.3;
        reason = 'High starvation frequency - increasing boost';
    }
    else if (starvationEvents === 0) {
        adjustmentFactor = 0.8;
        reason = 'No starvation events - reducing boost';
    }

    if (adjustmentFactor === 1.0) return null;

    const adjustedBoost = currentBoost * adjustmentFactor;

    await redis.set(key, Date.now().toString());

    return await applyAdjustment(redis, {
        adjustmentType: FEEDBACK_CONFIG.adjustments.STARVATION_BOOST,
        previous: currentBoost,
        adjustments: adjustedBoost,
        reason,
        starvationEvents
    });
}

async function adjustCostEstimation(redis, estimatedCosts, actualCosts) {
    const key = `${FEEDBACK_PREFIX}:cost:adjustments`;
    const lastAdjustment = await redis.get(key);

    if (lastAdjustment) {
        const age = Date.now() - parseInt(lastAdjustment, 10);
        if (age < FEEDBACK_CONFIG.thresholdUpdateMinDelayMs) {
            return null;
        }
    }

    let totalFactor = 0;
    let count = 0;

    Object.entries(actualCosts).forEach(([workload, actual]) => {
        const estimated = estimatedCosts[workload] || actual;
        if (actual && actual > 0) {
            const factor = actual / estimated;
            totalFactor += factor;
            count++;
        }
    });

    if (count === 0) return null;

    const avgFactor = totalFactor / count;
    let adjustmentFactor = 1.0;
    let reason = '';

    if (avgFactor > 1.3) {
        adjustmentFactor = FEEDBACK_CONFIG.costAdjustmentFactor;
        reason = 'Costs consistently underestimated';
    }
    else if (avgFactor < 0.7) {
        adjustmentFactor = FEEDBACK_CONFIG.costAdjustmentFactorOptimistic;
        reason = 'Costs consistently overestimated';
    }

    if (adjustmentFactor === 1.0) return null;

    const adjustedCosts = {};
    Object.entries(estimatedCosts).forEach(([workload, cost]) => {
        adjustedCosts[workload] = Math.round(cost * adjustmentFactor);
    });

    await redis.set(key, Date.now().toString());

    return await applyAdjustment(redis, {
        adjustmentType: FEEDBACK_CONFIG.adjustments.COST_ESTIMATION,
        previous: estimatedCosts,
        adjustments: adjustedCosts,
        reason,
        avgFactor,
        actualCosts,
        estimatedCosts
    });
}

async function adjustAdmissionStrictness(redis, currentStrictness, stabilityMetrics) {
    const key = `${FEEDBACK_PREFIX}:admission:adjustments`;
    const lastAdjustment = await redis.get(key);

    if (lastAdjustment) {
        const age = Date.now() - parseInt(lastAdjustment, 10);
        if (age < FEEDBACK_CONFIG.thresholdUpdateMinDelayMs) {
            return null;
        }
    }

    let adjustment = 0;
    let reason = '';

    if (stabilityMetrics.overloadFrequency > 10) {
        adjustment = 1;
        reason += 'High overload frequency. ';
    }
    if (stabilityMetrics.retryRate > 30) {
        adjustment = Math.max(adjustment, 1);
        reason += 'High retry rate. ';
    }
    if (stabilityMetrics.circuitOpenRate > 5) {
        adjustment = Math.max(adjustment, 1);
        reason += 'High circuit breaker events. ';
    }
    if (stabilityMetrics.starvationRate > 5) {
        adjustment = Math.max(adjustment, 1);
        reason += 'High starvation events. ';
    }

    if (adjustment === 0) {
        if (stabilityMetrics.overloadFrequency === 0 &&
            stabilityMetrics.retryRate < 10 &&
            stabilityMetrics.starvationRate === 0) {
            adjustment = -1;
            reason = 'Runtime stable - relaxing admission';
        } else {
            return null;
        }
    }

    const adjustedStrictness = Math.max(0, Math.min(2, currentStrictness + adjustment));

    await redis.set(key, Date.now().toString());

    return await applyAdjustment(redis, {
        adjustmentType: FEEDBACK_CONFIG.adjustments.ADMISSION_STRICTNESS,
        previous: currentStrictness,
        adjustments: adjustedStrictness,
        reason,
        stabilityMetrics
    });
}

async function updateCostModel(redis, estimate, actual, workload) {
    const key = `${COST_HISTORY_KEY}:${workload}`;
    const entry = {
        timestamp: Date.now(),
        estimated: estimate,
        actual: actual,
        ratio: actual / estimate,
        estimatedAt: new Date().toISOString()
    };

    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 999);

    const avg = await getCostModelAverage(redis, workload);
    const avgKey = `${COST_HISTORY_KEY}:${workload}:avg`;
    await redis.set(avgKey, JSON.stringify(avg));

    return { entry, avg };
}

async function getCostModelAverage(redis, workload) {
    const key = `${COST_HISTORY_KEY}:${workload}`;
    const entries = await redis.lrange(key, 0, -1);

    if (entries.length === 0) {
        return { count: 0, avgRatio: 1.0, estimateAvg: 0, actualAvg: 0 };
    }

    let totalRatio = 0;
    let totalEstimate = 0;
    let totalActual = 0;

    entries.forEach(e => {
        const entry = JSON.parse(e);
        totalRatio += entry.ratio;
        totalEstimate += entry.estimated;
        totalActual += entry.actual;
    });

    const count = entries.length;
    return {
        count,
        avgRatio: totalRatio / count,
        estimateAvg: totalEstimate / count,
        actualAvg: totalActual / count
    };
}

async function getAdaptiveCostEstimate(redis, workload) {
    const avg = await getCostModelAverage(redis, workload);

    if (avg.count < 5) {
        return {
            estimated: null,
            reason: 'insufficient_data',
            baselineRatio: 1.0
        };
    }

    const baselineRatios = {
        LIGHT: 1.0,
        MEDIUM: 2.0,
        HEAVY: 3.0,
        EXTREME: 5.0
    };

    const baselineRatio = baselineRatios[workload] || 2.0;
    const adjustedRatio = avg.avgRatio * baselineRatio;

    return {
        estimated: adjustedRatio,
        actualAverage: avg.actualAvg,
        ratio: avg.avgRatio,
        count: avg.count,
        reason: 'adaptive_model'
    };
}

async function analyzeRuntimeBehavior(redis) {
    const behavior = {
        timestamp: Date.now(),
        renderPerformance: {},
        retryBehavior: {},
        failurePatterns: {},
        overloadPatterns: {},
        starvationPatterns: {},
        circuitPatterns: {}
    };

    const renderSamples = await getRecentSamples(redis, 'render_duration', 60);
    if (renderSamples.length > 0) {
        behavior.renderPerformance = {
            averageMs: calculateAverage(renderSamples),
            p95Ms: calculatePercentile(renderSamples, 95),
            p99Ms: calculatePercentile(renderSamples, 99),
            stdDev: calculateStdDev(renderSamples),
            count: renderSamples.length
        };
    }

    const retrySamples = await getRecentSamples(redis, 'retry_outcome', 60);
    if (retrySamples.length > 0) {
        behavior.retryBehavior = {
            successRate: calculateSuccessRate(retrySamples),
            count: retrySamples.length
        };
    }

    const failureSamples = await getRecentSamples(redis, 'failures', 60);
    if (failureSamples.length > 0) {
        const byType = {};
        failureSamples.forEach(s => {
            const type = s.context.failureType || 'unknown';
            byType[type] = (byType[type] || 0) + 1;
        });
        behavior.failurePatterns = { byType, total: failureSamples.length };
    }

    const overloadSamples = await getRecentSamples(redis, 'overload_events', 60);
    if (overloadSamples.length > 0) {
        behavior.overloadPatterns = {
            frequency: overloadSamples.length,
            _SAMPLE_PER_HOUR: overloadSamples.length
        };
    }

    const starvationSamples = await getRecentSamples(redis, 'starvation_events', 60);
    if (starvationSamples.length > 0) {
        behavior.starvationPatterns = {
            frequency: starvationSamples.length
        };
    }

    const circuitSamples = await getRecentSamples(redis, 'circuit_events', 60);
    if (circuitSamples.length > 0) {
        const byStage = {};
        circuitSamples.forEach(s => {
            const stage = s.context.stage || 'unknown';
            byStage[stage] = (byStage[stage] || 0) + 1;
        });
        behavior.circuitPatterns = { byStage, total: circuitSamples.length };
    }

    return behavior;
}

async function calculateStabilityScore(redis) {
    const behavior = await analyzeRuntimeBehavior(redis);

    let score = 100;

    if (behavior.renderPerformance?.stdDev && behavior.renderPerformance.stdDev > 10000) {
        score -= 20;
    }

    if (behavior.retryBehavior?.successRate) {
        if (behavior.retryBehavior.successRate < 50) {
            score -= 25;
        } else if (behavior.retryBehavior.successRate < 70) {
            score -= 10;
        }
    }

    if (behavior.overloadPatterns?.frequency > 10) {
        score -= 15;
    }

    if (behavior.circuitPatterns?.total > 5) {
        score -= 20;
    }

    if (behavior.starvationPatterns?.frequency > 5) {
        score -= 10;
    }

    return {
        score: Math.max(0, score),
        behavior
    };
}

async function runAdaptiveAdjustments(redis) {
    const adjustmentsApplied = [];

    const currentQuotas = {
        audio: 3,
        image: 2,
        video: 1
    };
    const quotaAdjustment = await adjustQuotas(redis, currentQuotas, {});
    if (quotaAdjustment) adjustmentsApplied.push(quotaAdjustment);

    const currentDelays = {
        baseDelayMs: 1000,
        maxDelayMs: 30000
    };
    const retryBehavior = await getRecentSamples(redis, 'retry_outcome', 60);
    const successRate = calculateSuccessRate(retryBehavior);
    const retryAdjustment = await adjustRetryDelays(redis, currentDelays, successRate);
    if (retryAdjustment) adjustmentsApplied.push(retryAdjustment);

    const overloadSamples = await getRecentSamples(redis, 'overload_events', 60);
    const overloadAdjustment = await adjustOverloadThresholds(
        redis,
        FEEDBACK_CONFIG.overloadActiveScenesThreshold || 100,
        overloadSamples.length
    );
    if (overloadAdjustment) adjustmentsApplied.push(overloadAdjustment);

    const starvationSamples = await getRecentSamples(redis, 'starvation_events', 60);
    const starvationAdjustment = await adjustStarvationBoost(
        redis,
        1.5,
        starvationSamples.length
    );
    if (starvationAdjustment) adjustmentsApplied.push(starvationAdjustment);

    const estimatedCosts = {
        LIGHT: 10,
        MEDIUM: 20,
        HEAVY: 30,
        EXTREME: 50
    };
    const actualCosts = { MEDIUM: 25 };
    const costAdjustment = await adjustCostEstimation(redis, estimatedCosts, actualCosts);
    if (costAdjustment) adjustmentsApplied.push(costAdjustment);

    const behavior = await analyzeRuntimeBehavior(redis);
    const stabilityMetrics = {
        overloadFrequency: behavior.overloadPatterns?.frequency || 0,
        retryRate: behavior.retryBehavior?.successRate ? (100 - behavior.retryBehavior.successRate) : 0,
        circuitOpenRate: behavior.circuitPatterns?.total || 0,
        starvationRate: behavior.starvationPatterns?.frequency || 0
    };
    const admissionAdjustment = await adjustAdmissionStrictness(redis, 0, stabilityMetrics);
    if (admissionAdjustment) adjustmentsApplied.push(admissionAdjustment);

    return adjustmentsApplied;
}

async function getFeedbackStatus(redis) {
    const stability = await calculateStabilityScore(redis);
    const behavior = stability.behavior;

    const adjustmentHistory = await redis.lrange(ADJUSTMENT_HISTORY_KEY, 0, 9);
    const adjustments = adjustmentHistory.map(a => JSON.parse(a));

    return {
        stability: {
            score: stability.score,
            status: stability.score >= 80 ? 'stable' : stability.score >= 60 ? 'warning' : 'unstable'
        },
        behavior,
        adjustments: adjustments.slice(0, 5),
        adjustmentsTotal: await redis.llen(ADJUSTMENT_HISTORY_KEY)
    };
}

async function getCostModelStatus(redis) {
    const workloads = ['LIGHT', 'MEDIUM', 'HEAVY', 'EXTREME'];
    const models = {};

    for (const workload of workloads) {
        const avg = await getCostModelAverage(redis, workload);
        models[workload] = {
            count: avg.count,
            avgRatio: avg.avgRatio,
            estimatedAvg: avg.estimateAvg,
            actualAvg: avg.actualAvg,
            status: avg.count >= 5 ? 'adaptive' : 'baseline'
        };
    }

    return {
        models,
        baselineRatios: {
            LIGHT: 1.0,
            MEDIUM: 2.0,
            HEAVY: 3.0,
            EXTREME: 5.0
        }
    };
}

async function getRecentAdjustments(redis, limit = 10) {
    const key = ADJUSTMENT_HISTORY_KEY;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

async function getAdjustmentsByType(redis, type, limit = 20) {
    const key = ADJUSTMENT_HISTORY_KEY;
    const entries = await redis.lrange(key, 0, -1);
    return entries
        .filter(e => JSON.parse(e).adjustmentType === type)
        .slice(0, limit)
        .map(e => JSON.parse(e));
}

module.exports = {
    FEEDBACK_CONFIG,
    FEEDBACK_TYPES: FEEDBACK_CONFIG.feedbackTypes,
    ADJUSTMENT_TYPES: FEEDBACK_CONFIG.adjustments,

    createSample,
    recordRenderDuration,
    recordRetryOutcome,
    recordFailure,
    recordOverloadEvent,
    recordQueueWaitTime,
    recordStarvationEvent,
    recordCircuitEvent,

    getSamples,
    getRecentSamples,
    calculateAverage,
    calculatePercentile,
    calculateStdDev,
    calculateSuccessRate,

    applyAdjustment,
    adjustQuotas,
    adjustRetryDelays,
    adjustOverloadThresholds,
    adjustStarvationBoost,
    adjustCostEstimation,
    adjustAdmissionStrictness,
    runAdaptiveAdjustments,

    updateCostModel,
    getCostModelAverage,
    getAdaptiveCostEstimate,
    getCostModelStatus,
    getRecentAdjustments,
    getAdjustmentsByType,

    analyzeRuntimeBehavior,
    calculateStabilityScore,
    getFeedbackStatus
};
