// ======================================================
// ADAPTIVE FEEDBACK ENGINE - LEARNING RUNTIME BEHAVIOR
// ======================================================
// Runtime learns from its own behavior and adjusts policies.
// Enables adaptive admission, cost estimation, and thresholds.
//
// Key idea: Runtime should adapt to runtime behavior.

const logPrefix = '[FEEDBACK]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

// ======================================================
// FEEDBACK CONFIGURATION
// ======================================================

const FEEDBACK_CONFIG = {
    // Data collection
    sampleIntervalMs: 60000, // 1 minute sampling
    minSamplesForAdjustment: 5, // Minimum samples before adjustment
    maxHistorySamples: 1000, // Keep last 1000 samples

    // Adaptive thresholds
    thresholdAdjustmentRate: 0.1, // 10% adjustment step
    thresholdUpdateMinDelayMs: 300000, // 5 minutes between updates

    // Cost model adaptation
    costAdjustmentFactor: 1.2, // Scale up costs when underestimating
    costAdjustmentFactorOptimistic: 0.9, // Scale down when overestimating

    // Feedback types
    feedbackTypes: {
        RENDER_DURATION: 'render_duration',
        RETRY_SUCCESS_RATE: 'retry_success_rate',
        FAILURE_RATE: 'failure_rate',
        OVERLOAD_FREQUENCY: 'overload_frequency',
        QUEUE_WAIT_TIME: 'queue_wait_time',
        STARVATION_COUNT: 'starvation_count',
        CIRCUIT_OPEN_COUNT: 'circuit_open_count'
    },

    // Adjustments
    adjustments: {
        QUOTAS: 'quotas',
        RETRY_DELAY: 'retry_delay',
        OVERLOAD_THRESHOLD: 'overload_threshold',
        STARVATION_BOOST: 'starvation_boost',
        COST_ESTIMATION: 'cost_estimation',
        ADMISSION_STRICTNESS: 'admission_strictness'
    }
};

// ======================================================
// FEEDBACK KEY PATTERNS
// ======================================================

const FEEDBACK_PREFIX = 'animastor:runtime:feedback';
const ADJUSTMENT_HISTORY_KEY = 'animastor:runtime:adjustments';
const METRICS_HISTORY_KEY = 'animastor:runtime:metrics-history';
const COST_HISTORY_KEY = 'animastor:runtime:cost-history';

// ======================================================
// FEEDBACK SAMPLE TYPE
// ======================================================

/**
 * Create a feedback sample.
 */
function createSample({
    type,
    timestamp = Date.now(),
    value,
    context = {},
    metadata = {}
}) {
    return {
        sample_id: `sample-${timestamp}-${Math.random().toString(36).slice(2, 10)}`,
        type,
        timestamp,
        value,
        context,
        metadata,
        created_at: new Date().toISOString()
    };
}

// ======================================================
// DATA COLLECTION
// ======================================================

/**
 * Record render duration sample.
 */
async function recordRenderDuration(redis, scene, durationMs) {
    const key = `${FEEDBACK_PREFIX}:render_duration`;
    const sample = createSample({
        type: FEEDBACK_CONFIG.feedbackTypes.RENDER_DURATION,
        value: durationMs,
        context: { ...scene },
        metadata: { durationMs }
    });

    await storeSample(redis, key, sample);
    return sample;
}

/**
 * Record retry success/failure.
 */
async function recordRetryOutcome(redis, scene, success) {
    const key = `${FEEDBACK_PREFIX}:retry_outcome`;
    const sample = createSample({
        type: FEEDBACK_CONFIG.feedbackTypes.RETRY_SUCCESS_RATE,
        value: success ? 1 : 0,
        context: { ...scene },
        metadata: { success }
    });

    await storeSample(redis, key, sample);
    return sample;
}

/**
 * Record failure.
 */
async function recordFailure(redis, scene, type, stage) {
    const key = `${FEEDBACK_PREFIX}:failures`;
    const sample = createSample({
        type: FEEDBACK_CONFIG.feedbackTypes.FAILURE_RATE,
        value: 1,
        context: { ...scene, failureType: type, stage },
        metadata: { type, stage }
    });

    await storeSample(redis, key, sample);
    return sample;
}

/**
 * Record overload event.
 */
async function recordOverloadEvent(redis, runtimeState) {
    const key = `${FEEDBACK_PREFIX}:overload_events`;
    const sample = createSample({
        type: FEEDBACK_CONFIG.feedbackTypes.OVERLOAD_FREQUENCY,
        value: 1,
        context: { runtimeState },
        metadata: { runtimeState }
    });

    await storeSample(redis, key, sample);
    return sample;
}

/**
 * Record queue wait time.
 */
async function recordQueueWaitTime(redis, scene, waitMs) {
    const key = `${FEEDBACK_PREFIX}:queue_wait`;
    const sample = createSample({
        type: FEEDBACK_CONFIG.feedbackTypes.QUEUE_WAIT_TIME,
        value: waitMs,
        context: { ...scene },
        metadata: { waitMs }
    });

    await storeSample(redis, key, sample);
    return sample;
}

/**
 * Record starvation event.
 */
async function recordStarvationEvent(redis, scene) {
    const key = `${FEEDBACK_PREFIX}:starvation_events`;
    const sample = createSample({
        type: FEEDBACK_CONFIG.feedbackTypes.STARVATION_COUNT,
        value: 1,
        context: { ...scene },
        metadata: { scene }
    });

    await storeSample(redis, key, sample);
    return sample;
}

/**
 * Record circuit breaker event.
 */
async function recordCircuitEvent(redis, stage, eventData) {
    const key = `${FEEDBACK_PREFIX}:circuit_events`;
    const sample = createSample({
        type: FEEDBACK_CONFIG.feedbackTypes.CIRCUIT_OPEN_COUNT,
        value: 1,
        context: { stage },
        metadata: { ...eventData }
    });

    await storeSample(redis, key, sample);
    return sample;
}

/**
 * Store sample in Redis.
 */
async function storeSample(redis, key, sample) {
    // Store sample in sorted set for time-based queries
    const sampleKey = `${key}:${sample.sample_id}`;
    await redis.set(sampleKey, JSON.stringify(sample), 'EX', 86400000); // 1 day

    // Also store in ordered set for time series
    const seriesKey = `${key}:series`;
    await redis.zadd(seriesKey, sample.timestamp, JSON.stringify(sample));

    // Keep only recent samples
    await redis.zremrangebyscore(seriesKey, '-inf', Date.now() - FEEDBACK_CONFIG.maxHistorySamples * 1000);

    return sample.sample_id;
}

/**
 * Get samples for feedback type.
 */
async function getSamples(redis, type, limit = 100) {
    const key = `${FEEDBACK_PREFIX}:${type}:series`;
    const samples = await redis.zrange(key, -limit, -1);
    return samples.map(s => JSON.parse(s));
}

/**
 * Get recent samples by type.
 */
async function getRecentSamples(redis, type, minutes = 60) {
    const key = `${FEEDBACK_PREFIX}:${type}:series`;
    const cutoff = Date.now() - minutes * 60000;

    const samples = await redis.zrangebyscore(key, cutoff, '+inf');
    return samples.map(s => JSON.parse(s));
}

// ======================================================
// METRICS AGGREGATION
// ======================================================

/**
 * Calculate average from samples.
 */
function calculateAverage(samples) {
    if (samples.length === 0) return 0;
    const sum = samples.reduce((acc, s) => acc + s.value, 0);
    return sum / samples.length;
}

/**
 * Calculate percentile from samples.
 */
function calculatePercentile(samples, percentile) {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a.value - b.value);
    const index = Math.floor((percentile / 100) * sorted.length);
    return sorted[index]?.value || 0;
}

/**
 * Calculate standard deviation.
 */
function calculateStdDev(samples) {
    if (samples.length < 2) return 0;
    const avg = calculateAverage(samples);
    const squaredDiffs = samples.map(s => Math.pow(s.value - avg, 2));
    return Math.sqrt(calculateAverage(squaredDiffs));
}

/**
 * Calculate success rate from binary samples.
 */
function calculateSuccessRate(samples) {
    if (samples.length === 0) return 0;
    const successCount = samples.filter(s => s.value === 1).length;
    return (successCount / samples.length) * 100;
}

// ======================================================
// ADAPTIVE ADJUSTMENTS
// ======================================================

/**
 * Apply adaptive adjustment.
 */
async function applyAdjustment(redis, adjustment) {
    const historyKey = ADJUSTMENT_HISTORY_KEY;
    const adjustmentWithTime = {
        ...adjustment,
        appliedAt: Date.now(),
        appliedAtFormatted: new Date().toISOString()
    };

    await redis.lpush(historyKey, JSON.stringify(adjustmentWithTime));
    await redis.ltrim(historyKey, 0, 999); // Keep last 1000

    log(`ADJUSTMENT_APPLIED: ${adjustment.adjustmentType} = ${JSON.stringify(adjustment.adjustments)}`);

    return adjustmentWithTime;
}

/**
 * Adjust quotas based on feedback.
 */
async function adjustQuotas(redis, currentQuotas, feedback) {
    const key = `${FEEDBACK_PREFIX}:quotas:adjustments`;
    const lastAdjustment = await redis.get(key);

    // Check if enough time passed
    if (lastAdjustment) {
        const age = Date.now() - parseInt(lastAdjustment, 10);
        if (age < FEEDBACK_CONFIG.thresholdUpdateMinDelayMs) {
            return null; // Too soon
        }
    }

    // Calculate adjustment directions
    const adjustments = {};
    let adjusted = false;

    // Adjust based on quota utilization
    Object.entries(currentQuotas).forEach(([stage, current]) => {
        // If consistently near quota, increase slightly
        if (current > 0.85) {
            adjustments[stage] = Math.min(10, current + 1);
            adjusted = true;
        }
        // If consistently low, decrease slightly
        else if (current < 0.3) {
            adjustments[stage] = Math.max(1, current - 1);
            adjusted = true;
        }
    });

    if (!adjusted) return null;

    // Store adjustment
    await redis.set(key, Date.now().toString());

    return await applyAdjustment(redis, {
        adjustmentType: FEEDBACK_CONFIG.adjustments.QUOTAS,
        previous: currentQuotas,
        adjustments,
        reason: 'Quota utilization feedback'
    });
}

/**
 * Adjust retry delays based on success rate.
 */
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

    // If success rate is low, increase delays (be more conservative)
    if (successRate < 50) {
        adjustmentFactor = 1.5;
        reason = 'Low success rate detected';
    }
    // If success rate is high, decrease delays (be more aggressive)
    else if (successRate > 80) {
        adjustmentFactor = 0.8;
        reason = 'High success rate detected';
    }

    if (adjustmentFactor === 1.0) return null;

    // Apply to delays
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

/**
 * Adjust overload thresholds based on frequency.
 */
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

    // If overload very frequent, be stricter
    if (overloadEvents > 10) {
        adjustmentFactor = 0.8; // Lower threshold (stricter)
        reason = 'High overload frequency - being stricter';
    }
    // If overload rare, can be more lenient
    else if (overloadEvents < 2) {
        adjustmentFactor = 1.2; // Raise threshold
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

/**
 * Adjust starvation boost based on frequency.
 */
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

    // If starvation frequent, boost more
    if (starvationEvents > 5) {
        adjustmentFactor = 1.3;
        reason = 'High starvation frequency - increasing boost';
    }
    // If starvation rare, use normal boost
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

/**
 * Adjust cost estimation based on actual vs estimated.
 */
async function adjustCostEstimation(redis, estimatedCosts, actualCosts) {
    const key = `${FEEDBACK_PREFIX}:cost:adjustments`;
    const lastAdjustment = await redis.get(key);

    if (lastAdjustment) {
        const age = Date.now() - parseInt(lastAdjustment, 10);
        if (age < FEEDBACK_CONFIG.thresholdUpdateMinDelayMs) {
            return null;
        }
    }

    // Calculate average under/over estimation
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

    // If consistently underestimating, increase costs
    if (avgFactor > 1.3) {
        adjustmentFactor = FEEDBACK_CONFIG.costAdjustmentFactor;
        reason = 'Costs consistently underestimated';
    }
    // If consistently overestimating, decrease costs
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

/**
 * Adjust admission strictness based on runtime stability.
 */
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

    // Check stability indicators
    if (stabilityMetrics.overloadFrequency > 10) {
        adjustment = 1; // Stricter
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
        // Check if we can relax
        if (stabilityMetrics.overloadFrequency === 0 &&
            stabilityMetrics.retryRate < 10 &&
            stabilityMetrics.starvationRate === 0) {
            adjustment = -1; // Relaxed
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

// ======================================================
// COST MODEL ADAPTATION
// ======================================================

/**
 * Update cost model with observed data.
 */
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
    await redis.ltrim(key, 0, 999); // Keep last 1000

    // Update running average
    const avg = await getCostModelAverage(redis, workload);
    const avgKey = `${COST_HISTORY_KEY}:${workload}:avg`;
    await redis.set(avgKey, JSON.stringify(avg));

    return { entry, avg };
}

/**
 * Get cost model average for workload.
 */
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

/**
 * Get adaptive cost estimate for workload.
 */
async function getAdaptiveCostEstimate(redis, workload) {
    const avg = await getCostModelAverage(redis, workload);

    if (avg.count < 5) {
        // Not enough data - use baseline
        return {
            estimated: null,
            reason: 'insufficient_data',
            baselineRatio: 1.0
        };
    }

    // Apply ratio to baseline
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

// ======================================================
// FEEDBACK ANALYSIS
// ======================================================

/**
 * Analyze runtime behavior from feedback.
 */
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

    // Render performance
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

    // Retry behavior
    const retrySamples = await getRecentSamples(redis, 'retry_outcome', 60);
    if (retrySamples.length > 0) {
        behavior.retryBehavior = {
            successRate: calculateSuccessRate(retrySamples),
            count: retrySamples.length
        };
    }

    // Failure patterns
    const failureSamples = await getRecentSamples(redis, 'failures', 60);
    if (failureSamples.length > 0) {
        const byType = {};
        failureSamples.forEach(s => {
            const type = s.context.failureType || 'unknown';
            byType[type] = (byType[type] || 0) + 1;
        });
        behavior.failurePatterns = { byType, total: failureSamples.length };
    }

    // Overload patterns
    const overloadSamples = await getRecentSamples(redis, 'overload_events', 60);
    if (overloadSamples.length > 0) {
        behavior.overloadPatterns = {
            frequency: overloadSamples.length,
           _SAMPLE_PER_HOUR: overloadSamples.length
        };
    }

    // Starvation patterns
    const starvationSamples = await getRecentSamples(redis, 'starvation_events', 60);
    if (starvationSamples.length > 0) {
        behavior.starvationPatterns = {
            frequency: starvationSamples.length
        };
    }

    // Circuit patterns
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

/**
 * Calculate runtime stability score.
 */
async function calculateStabilityScore(redis) {
    const behavior = await analyzeRuntimeBehavior(redis);

    // Base score of 100, deduct for issues
    let score = 100;

    // Deduct for high render variance
    if (behavior.renderPerformance?.stdDev && behavior.renderPerformance.stdDev > 10000) {
        score -= 20;
    }

    // Deduct for high retry rate
    if (behavior.retryBehavior?.successRate) {
        if (behavior.retryBehavior.successRate < 50) {
            score -= 25;
        } else if (behavior.retryBehavior.successRate < 70) {
            score -= 10;
        }
    }

    // Deduct for overload events
    if (behavior.overloadPatterns?.frequency > 10) {
        score -= 15;
    }

    // Deduct for circuit breaker events
    if (behavior.circuitPatterns?.total > 5) {
        score -= 20;
    }

    // Deduct for starvation
    if (behavior.starvationPatterns?.frequency > 5) {
        score -= 10;
    }

    return {
        score: Math.max(0, score),
        behavior
    };
}

// ======================================================
// ADAPTIVE ADJUSTMENT EXECUTION
// ======================================================

/**
 * Run adaptive adjustments.
 */
async function runAdaptiveAdjustments(redis) {
    const adjustmentsApplied = [];

    // 1. Check quotas
    const currentQuotas = {
        audio: 3,
        image: 2,
        video: 1
    };
    const quotaAdjustment = await adjustQuotas(redis, currentQuotas, {});
    if (quotaAdjustment) adjustmentsApplied.push(quotaAdjustment);

    // 2. Check retry delays
    const currentDelays = {
        baseDelayMs: 1000,
        maxDelayMs: 30000
    };
    const retryBehavior = await getRecentSamples(redis, 'retry_outcome', 60);
    const successRate = calculateSuccessRate(retryBehavior);
    const retryAdjustment = await adjustRetryDelays(redis, currentDelays, successRate);
    if (retryAdjustment) adjustmentsApplied.push(retryAdjustment);

    // 3. Check overload thresholds
    const overloadSamples = await getRecentSamples(redis, 'overload_events', 60);
    const overloadAdjustment = await adjustOverloadThresholds(
        redis,
        FEEDBACK_CONFIG.overloadActiveScenesThreshold || 100,
        overloadSamples.length
    );
    if (overloadAdjustment) adjustmentsApplied.push(overloadAdjustment);

    // 4. Check starvation boost
    const starvationSamples = await getRecentSamples(redis, 'starvation_events', 60);
    const starvationAdjustment = await adjustStarvationBoost(
        redis,
        1.5, // Default boost
        starvationSamples.length
    );
    if (starvationAdjustment) adjustmentsApplied.push(starvationAdjustment);

    // 5. Check cost estimation
    const estimatedCosts = {
        LIGHT: 10,
        MEDIUM: 20,
        HEAVY: 30,
        EXTREME: 50
    };
    const actualCosts = { MEDIUM: 25 }; // Example - would come from render data
    const costAdjustment = await adjustCostEstimation(redis, estimatedCosts, actualCosts);
    if (costAdjustment) adjustmentsApplied.push(costAdjustment);

    // 6. Check admission strictness
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

// ======================================================
// FEEDBACK DEBUGGING
// ======================================================

/**
 * Get feedback status.
 */
async function getFeedbackStatus(redis) {
    const stability = await calculateStabilityScore(redis);
    const behavior = stability.behavior;

    // Get adjustment history
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

/**
 * Get cost model status.
 */
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

/**
 * Get recent adjustments.
 */
async function getRecentAdjustments(redis, limit = 10) {
    const key = ADJUSTMENT_HISTORY_KEY;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

/**
 * Get adjustment history by type.
 */
async function getAdjustmentsByType(redis, type, limit = 20) {
    const key = ADJUSTMENT_HISTORY_KEY;
    const entries = await redis.lrange(key, 0, -1);
    return entries
        .filter(e => JSON.parse(e).adjustmentType === type)
        .slice(0, limit)
        .map(e => JSON.parse(e));
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    FEEDBACK_CONFIG,
    FEEDBACK_TYPES: FEEDBACK_CONFIG.feedbackTypes,
    ADJUSTMENT_TYPES: FEEDBACK_CONFIG.adjustments,

    // Sample creation
    createSample,
    recordRenderDuration,
    recordRetryOutcome,
    recordFailure,
    recordOverloadEvent,
    recordQueueWaitTime,
    recordStarvationEvent,
    recordCircuitEvent,

    // Data collection
    getSamples,
    getRecentSamples,
    calculateAverage,
    calculatePercentile,
    calculateStdDev,
    calculateSuccessRate,

    // Adaptive adjustments
    applyAdjustment,
    adjustQuotas,
    adjustRetryDelays,
    adjustOverloadThresholds,
    adjustStarvationBoost,
    adjustCostEstimation,
    adjustAdmissionStrictness,
    runAdaptiveAdjustments,

    // Cost model
    updateCostModel,
    getCostModelAverage,
    getAdaptiveCostEstimate,
    getCostModelStatus,
    getRecentAdjustments,
    getAdjustmentsByType,

    // Analysis
    analyzeRuntimeBehavior,
    calculateStabilityScore,
    getFeedbackStatus
};
