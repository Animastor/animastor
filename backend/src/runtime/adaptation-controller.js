// ======================================================
// ADAPTATION CONTROLLER - BOUNDED, DAMPED ADAPTATION
// ======================================================
// Controls the speed and boundedness of adaptive changes.
// Prevents runaway adaptation and oscillation.
//
// Key idea: Adaptation must be gradual, bounded, and explainable.

const logPrefix = '[ADAPT]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function debug(msg) {
    console.debug(`${logPrefix} • ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

// ======================================================
// ADAPTATION CONFIGURATION
// ======================================================

const ADAPTATION_CONFIG = {
    // Global settings
    maxAdjustmentStep: 0.1, // Max 10% change per adjustment
    minAdjustmentDelayMs: 300000, // 5 minutes between adjustments
    maxRetriesPerStep: 3, // Retry up to 3 times before giving up

    // Parameter-specific bounds (min, max)
    bounds: {
        // Quotas
        maxConcurrentAudio: { min: 1, max: 10 },
        maxConcurrentImage: { min: 1, max: 8 },
        maxConcurrentVideo: { min: 1, max: 4 },

        // Retry delays (ms)
        retryDelayBase: { min: 5000, max: 1800000 }, // 5s - 30min
        retryDelayMax: { min: 10000, max: 3600000 }, // 10s - 1hr

        // Overload thresholds
        overloadActiveScenes: { min: 10, max: 500 },
        overloadQuotaUtilization: { min: 0.5, max: 0.98 },

        // Starvation
        starvationThresholdMinutes: { min: 5, max: 60 },
        starvationBoostFactor: { min: 1.1, max: 3.0 },

        // Cost estimation
        costMultiplier: { min: 0.5, max: 3.0 },

        // Admission
        admissionStrictness: { min: 0, max: 2 },
        maxDelayMs: { min: 1000, max: 300000 } // 1s - 5min
    },

    // Moving average windows (minutes)
    maWindows: {
        overloadRate: 5,
        retryFailures: 10,
        starvationFrequency: 15,
        renderDuration: 5
    },

    // Cooldown periods (seconds)
    cooldowns: {
        quota: 300,      // 5 minutes
        retryDelay: 600, // 10 minutes
        overload: 600,   // 10 minutes
        starvation: 600, // 10 minutes
        cost: 900,       // 15 minutes
        admission: 600   // 10 minutes
    }
};

// ======================================================
// ADAPTATION KEY PATTERNS
// ======================================================

const ADAPTATION_PREFIX = 'animastor:adaptation';
const LAST_ADJUSTMENT_KEY = `${ADAPTATION_PREFIX}:lastAdjustment`;
const COOLDOWN_KEY = `${ADAPTATION_PREFIX}:cooldown`;
const ADAPTATION_HISTORY_KEY = `${ADAPTATION_PREFIX}:history`;
const ADAPTATION_STABILITY_KEY = `${ADAPTATION_PREFIX}:stability`;

// ======================================================
// BOUNDED ADAPTION UTILITIES
// ======================================================

/**
 * Apply bounded adjustment to value.
 * Ensures change is within bounds and step limits.
 */
function applyBoundedAdjustment({
    currentValue,
    targetValue,
    bounds,
    maxStep = ADAPTATION_CONFIG.maxAdjustmentStep
}) {
    // Clamp target to bounds
    const clampedTarget = Math.max(bounds.min, Math.min(bounds.max, targetValue));

    // Calculate raw change
    const rawChange = clampedTarget - currentValue;

    // Apply bounded step
    const step = Math.max(
        -Math.abs(currentValue * maxStep),
        Math.min(Math.abs(currentValue * maxStep), rawChange)
    );

    // Apply change (avoid zero when changing)
    const stepMagnitude = step === 0 && rawChange !== 0 ? Math.sign(rawChange) * 0.01 : step;
    const newValue = Math.round(currentValue + stepMagnitude);

    // Final clamp
    const finalValue = Math.max(bounds.min, Math.min(bounds.max, newValue));

    return {
        currentValue,
        targetValue,
        finalValue,
        change: finalValue - currentValue,
        bounded: Math.abs(finalValue - currentValue) < Math.abs(rawChange),
        reason: Math.abs(finalValue - currentValue) < Math.abs(rawChange)
            ? 'bounded_by_step_limits'
            : 'within_bounds'
    };
}

/**
 * Create bounded adjustment for parameter.
 */
function createBoundedAdjustment({
    parameter,
    currentValue,
    targetValue,
    adjustmentType = 'gradual'
}) {
    const bounds = ADAPTATION_CONFIG.bounds[parameter];
    if (!bounds) {
        warn(`Unknown parameter: ${parameter}`);
        return null;
    }

    const result = applyBoundedAdjustment({
        currentValue,
        targetValue,
        bounds
    });

    return {
        parameter,
        currentValue,
        targetValue,
        finalValue: result.finalValue,
        change: result.change,
        bounded: result.bounded,
        boundedBy: result.reason,
        timestamp: Date.now(),
        adjustmentType
    };
}

// ======================================================
// COOLDOWN MANAGEMENT
// ======================================================

/**
 * Check if cooldown is active for parameter.
 */
async function isCooldownActive(redis, parameter) {
    const key = `${COOLDOWN_KEY}:${parameter}`;
    const cooldownKey = `${key}:deadline`;
    const deadline = await redis.get(cooldownKey);

    if (!deadline) return false;

    const remaining = parseInt(deadline, 10) - Date.now();
    if (remaining <= 0) {
        await redis.del(cooldownKey);
        return false;
    }

    return {
        active: true,
        remainingMs: remaining,
        remainingMinutes: (remaining / 60000).toFixed(1)
    };
}

/**
 * Set cooldown for parameter.
 */
async function setCooldown(redis, parameter, cooldownSeconds = null) {
    const key = `${COOLDOWN_KEY}:${parameter}`;
    const deadline = Date.now() + (cooldownSeconds * 1000) || ADAPTATION_CONFIG.cooldowns[parameter] * 1000;

    await redis.set(`${key}:deadline`, deadline.toString(), 'EX', Math.ceil(deadline / 1000));
    await redis.set(`${key}:timestamp`, Date.now().toString(), 'EX', Math.ceil(deadline / 1000));

    debug(`COOLDOWN_SET: ${parameter} (${(cooldownSeconds || ADAPTATION_CONFIG.cooldowns[parameter])}s)`);

    return { cooldownActive: true, deadline };
}

/**
 * Clear cooldown for parameter.
 */
async function clearCooldown(redis, parameter) {
    const key = `${COOLDOWN_KEY}:${parameter}`;
    await redis.del(`${key}:deadline`, `${key}:timestamp`);
    return { cooldownCleared: true, parameter };
}

/**
 * Get cooldown status for all parameters.
 */
async function getCooldownStatus(redis) {
    const parameters = Object.keys(ADAPTATION_CONFIG.cooldowns);
    const status = {};

    for (const param of parameters) {
        const cooldown = await isCooldownActive(redis, param);
        status[param] = cooldown || { active: false };
    }

    return status;
}

/**
 * Resolve all cooldowns (used during restart).
 */
async function resolveAllCooldowns(redis) {
    const parameters = Object.keys(ADAPTATION_CONFIG.cooldowns);
    const cleared = [];

    for (const param of parameters) {
        const isCooldown = await isCooldownActive(redis, param);
        if (isCooldown && isCooldown.active) {
            await clearCooldown(redis, param);
            cleared.push(param);
        }
    }

    return { cleared, count: cleared.length };
}

// ======================================================
// LAST ADJUSTMENT TRACKING
// ======================================================

/**
 * Record adjustment timestamp.
 */
async function recordAdjustment(redis, parameter, adjustment) {
    const key = `${LAST_ADJUSTMENT_KEY}:${parameter}`;
    const entry = {
        ...adjustment,
        recordedAt: Date.now(),
        recordedAtFormatted: new Date().toISOString()
    };

    await redis.set(key, JSON.stringify(entry), 'EX', 86400); // 24 hours

    // Log to history
    const historyKey = ADAPTATION_HISTORY_KEY;
    await redis.lpush(historyKey, JSON.stringify({
        ...entry,
        parameter,
        history: true
    }));
    await redis.ltrim(historyKey, 0, 999);

    return entry;
}

/**
 * Get last adjustment for parameter.
 */
async function getLastAdjustment(redis, parameter) {
    const key = `${LAST_ADJUSTMENT_KEY}:${parameter}`;
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
}

/**
 * Get adjustment history for parameter.
 */
async function getAdjustmentHistory(redis, parameter, limit = 20) {
    const historyKey = ADAPTATION_HISTORY_KEY;
    const entries = await redis.lrange(historyKey, 0, limit - 1);
    return entries
        .map(e => {
            const parsed = JSON.parse(e);
            return parsed.parameter === parameter ? parsed : null;
        })
        .filter(Boolean);
}

/**
 * Get recent adjustments.
 */
async function getRecentAdjustments(redis, limit = 50) {
    const historyKey = ADAPTATION_HISTORY_KEY;
    const entries = await redis.lrange(historyKey, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

// ======================================================
// MOVING AVERAGE CALCULATION
// ======================================================

/**
 * Calculate moving average from values.
 */
function calculateMovingAverage(values, windowSize = null) {
    if (values.length === 0) return 0;

    const window = windowSize ? values.slice(-windowSize) : values;
    const sum = window.reduce((acc, v) => acc + v, 0);
    return sum / window.length;
}

/**
 * Calculate weighted moving average.
 */
function calculateWeightedMovingAverage(values, weights = null) {
    if (values.length === 0) return 0;

    const window = values.slice(-10); // Default last 10
    const actualWeights = weights || Array(window.length).fill(1);

    let weightedSum = 0;
    let totalWeight = 0;

    for (let i = 0; i < window.length; i++) {
        const weight = actualWeights[i] || 1;
        weightedSum += window[i] * weight;
        totalWeight += weight;
    }

    return weightedSum / totalWeight;
}

/**
 * Calculate exponential moving average.
 */
function calculateEMA(values, smoothing = 0.3) {
    if (values.length === 0) return 0;

    let ema = values[0];
    for (let i = 1; i < values.length; i++) {
        ema = values[i] * smoothing + ema * (1 - smoothing);
    }
    return ema;
}

/**
 * Calculate moving standard deviation.
 */
function calculateMovingStdDev(values) {
    if (values.length < 2) return 0;

    const avg = calculateMovingAverage(values);
    const squaredDiffs = values.map(v => Math.pow(v - avg, 2));
    const avgSquaredDiff = calculateMovingAverage(squaredDiffs);
    return Math.sqrt(avgSquaredDiff);
}

// ======================================================
// STABILITY CHECKS
// ======================================================

/**
 * Check if value is stable (low variance).
 */
function isValueStable(values, threshold = 0.2) {
    if (values.length < 3) return true; // Not enough data

    const avg = calculateMovingAverage(values);
    const stdDev = calculateMovingStdDev(values);
    const cv = stdDev / avg; // Coefficient of variation

    return cv < threshold;
}

/**
 * Detect oscillation pattern in values.
 */
function detectOscillation(values) {
    if (values.length < 4) return false;

    let oscillations = 0;
    for (let i = 2; i < values.length; i++) {
        const prev = values[i - 2];
        const curr = values[i];

        // Check for sign change (oscillation)
        if ((prev > 0 && curr < 0) || (prev < 0 && curr > 0)) {
            oscillations++;
        }
    }

    // More than 3 oscillations in last 10 samples = unstable
    const oscillationRate = oscillations / (values.length - 2);
    return oscillationRate > 0.3;
}

/**
 * Check if parameter is in unstable region.
 */
function isInUnstableRegion(current, prevValues, bounds) {
    // Check for rapid changes
    if (prevValues.length >= 3) {
        const last3 = prevValues.slice(-3);
        const changeRate = Math.abs(last3[2] - last3[0]) / Math.max(1, Math.abs(last3[0]));

        if (changeRate > 0.3) { // More than 30% change in last 3 samples
            return { unstable: true, reason: 'rapid_change', changeRate };
        }
    }

    // Check for boundary proximity (bouncing against bounds)
    if (current <= bounds.min + 1 || current >= bounds.max - 1) {
        return { unstable: true, reason: 'boundary_proximity', current, bounds };
    }

    return { unstable: false };
}

// ======================================================
// ADAPTATION CONTROLLER API
// ======================================================

/**
 * Calculate safe adjustment for parameter.
 */
async function calculateSafeAdjustment(redis, parameter, targetValue) {
    const lastAdjustment = await getLastAdjustment(redis, parameter);

    // Check cooldown
    const cooldown = await isCooldownActive(redis, parameter);
    if (cooldown && cooldown.active) {
        return {
            allowed: false,
            cooldownActive: true,
            remainingMs: cooldown.remainingMs,
            reason: 'cooldown_active'
        };
    }

    const bounds = ADAPTATION_CONFIG.bounds[parameter];
    if (!bounds) {
        return { allowed: false, reason: 'unknown_parameter' };
    }

    // Get previous values from history
    const history = await getAdjustmentHistory(redis, parameter, 20);
    const prevValues = history.map(h => h.finalValue).filter(Boolean);

    // Check stability
    const stabilityCheck = isInUnstableRegion(targetValue, prevValues, bounds);

    if (stabilityCheck.unstable) {
        warn(`UNSTABLE_ADJUSTMENT: ${parameter}: ${stabilityCheck.reason}`);

        // Suggest dampened adjustment
        const dampenedTarget = prevValues.length ? prevValues[prevValues.length - 1] * 1.05 : targetValue;
        const bounded = applyBoundedAdjustment({
            currentValue: prevValues.length ? prevValues[prevValues.length - 1] : bounds.min,
            targetValue: dampenedTarget,
            bounds
        });

        return {
            allowed: true,
            dampened: true,
            originalTarget: targetValue,
            dampenedTarget: bounded.finalValue,
            reason: 'stability_dampened',
            stabilityCheck
        };
    }

    // Apply bounded adjustment
    const bounded = applyBoundedAdjustment({
        currentValue: prevValues.length ? prevValues[prevValues.length - 1] : bounds.min,
        targetValue,
        bounds
    });

    return {
        allowed: true,
        dampened: false,
        bounded,
        reason: 'calculated'
    };
}

/**
 * Apply bounded adjustment.
 */
async function applyAdjustment(redis, parameter, targetValue, adjustmentType = 'gradual') {
    const calculation = await calculateSafeAdjustment(redis, parameter, targetValue);

    if (!calculation.allowed) {
        if (calculation.cooldownActive) {
            debug(`ADAPTATION_BLOCKED: ${parameter}: ${calculation.reason}`);
            return { applied: false, reason: calculation.reason };
        }
        return { applied: false, reason: calculation.reason };
    }

    // Record adjustment
    const adjustment = createBoundedAdjustment({
        parameter,
        currentValue: calculation.bounded.currentValue,
        targetValue: calculation.bounded.targetValue,
        adjustmentType
    });

    // Apply cooldown
    await setCooldown(redis, parameter, ADAPTATION_CONFIG.cooldowns[parameter]);

    // Record to history
    await recordAdjustment(redis, parameter, adjustment);

    log(`ADAPTATION_APPLIED: ${parameter}: ${calculation.bounded.currentValue} → ${calculation.bounded.finalValue} (${calculation.bounded.change > 0 ? '+' : ''}${calculation.bounded.change})`);

    return {
        applied: true,
        parameter,
        adjustment,
        cooldownSeconds: ADAPTATION_CONFIG.cooldowns[parameter]
    };
}

/**
 * Get bounded adjustment for parameter without applying.
 */
async function getBoundedAdjustment(redis, parameter, targetValue) {
    const calculation = await calculateSafeAdjustment(redis, parameter, targetValue);
    return {
        parameter,
        targetValue,
        ...calculation
    };
}

// ======================================================
// STABILITY WEIGHTS (for convergence)
// ======================================================

/**
 * Calculate weighted stability score.
 */
function calculateStabilityWeight(values, weights = null) {
    if (values.length === 0) return 1.0;

    const avg = calculateMovingAverage(values);
    const stdDev = calculateMovingStdDev(values);
    const cv = stdDev / Math.max(1, avg);

    // Lower CV = higher stability
    let stability = 1.0;
    if (cv > 0.1) stability -= (cv - 0.1) * 2; // Reduce for higher CV
    stability = Math.max(0.3, Math.min(1.0, stability));

    // Apply weights if provided
    if (weights) {
        const weightedAvg = calculateWeightedMovingAverage(values, weights);
        if (weightedAvg > 0) {
            stability *= (weightedAvg / Math.max(weightedAvg, avg));
        }
    }

    return stability;
}

/**
 * Get stability weights for parameters.
 */
function getStabilityWeights() {
    return {
        quota: { weight: 0.3, tolerance: 0.1 },
        retryDelay: { weight: 0.25, tolerance: 0.15 },
        overload: { weight: 0.2, tolerance: 0.1 },
        starvation: { weight: 0.15, tolerance: 0.2 },
        cost: { weight: 0.1, tolerance: 0.2 }
    };
}

// ======================================================
// ADAPTATION HISTORY ANALYSIS
// ======================================================

/**
 * Analyze adaptation pattern.
 */
async function analyzeAdaptationPattern(redis, parameter, limit = 50) {
    const history = await getAdjustmentHistory(redis, parameter, limit);

    if (history.length < 3) {
        return {
            parameter,
            count: history.length,
            stability: 'insufficient_data',
            trend: 'unknown'
        };
    }

    const values = history.map(h => h.finalValue);
    const prevValues = history.slice(0, -1).map(h => h.finalValue);
    const bounds = ADAPTATION_CONFIG.bounds[parameter] || { min: 0, max: 1000 };

    const avg = calculateMovingAverage(values, 10);
    const trend = values[values.length - 1] > values[0] ? 'increasing' : 'decreasing';
    const volatility = calculateMovingStdDev(values);

    return {
        parameter,
        count: history.length,
        firstValue: values[0],
        lastValue: values[values.length - 1],
        avg,
        volatility,
        trend,
        stability: volatility < avg * 0.1 ? 'stable' : volatility < avg * 0.3 ? 'moderate' : 'unstable',
        oscillations: detectOscillation(values) ? 'detected' : 'none'
    };
}

/**
 * Get adaptation summary across all parameters.
 */
async function getAdaptationSummary(redis) {
    const parameters = Object.keys(ADAPTATION_CONFIG.bounds);
    const summary = {};

    for (const param of parameters) {
        const pattern = await analyzeAdaptationPattern(redis, param, 30);
        const cooldown = await isCooldownActive(redis, param);

        summary[param] = {
            pattern,
            cooldown: cooldown || null,
            bounds: ADAPTATION_CONFIG.bounds[param]
        };
    }

    return summary;
}

// ======================================================
// ADAPTATION CONTROLLER ENDPOINTS
// ======================================================

/**
 * Get adaptation status for debugging.
 */
async function getAdaptationStatus(redis) {
    const [summary, cooldowns, recent] = await Promise.all([
        getAdaptationSummary(redis),
        getCooldownStatus(redis),
        getRecentAdjustments(redis, 20)
    ]);

    return {
        timestamp: Date.now(),
        config: ADAPTATION_CONFIG,
        summary,
        cooldowns,
        recentAdjustments: recent,
        totalAdjustments: await redis.llen(ADAPTATION_HISTORY_KEY)
    };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    ADAPTATION_CONFIG,

    // Bounded adjustment
    applyBoundedAdjustment,
    createBoundedAdjustment,
    applyAdjustment,
    getBoundedAdjustment,
    calculateSafeAdjustment,

    // Cooldown management
    isCooldownActive,
    setCooldown,
    clearCooldown,
    getCooldownStatus,
    resolveAllCooldowns,
    getLastAdjustment,
    recordAdjustment,
    getAdjustmentHistory,
    getRecentAdjustments,

    // Moving averages
    calculateMovingAverage,
    calculateWeightedMovingAverage,
    calculateEMA,
    calculateMovingStdDev,

    // Stability checks
    isValueStable,
    detectOscillation,
    isInUnstableRegion,
    calculateStabilityWeight,
    getStabilityWeights,

    // Analysis
    analyzeAdaptationPattern,
    getAdaptationSummary,
    getAdaptationStatus
};
