// ======================================================
// WORKLOAD POLICY - COMPUTATIONAL COST CLASSIFICATION
// ======================================================
// Classifies scenes by computational cost.
// Routes workloads appropriately based on system capacity.

const workloadClassifier = require('../workload-classifier');

const logPrefix = '[POLICY:WORKLOAD]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

// ======================================================
// WORKLOAD POLICY CONFIGURATION
// ======================================================

const WORKLOAD_POLICY_CONFIG = {
    // Workload classification thresholds
    costThresholds: {
        lightMax: 30,
        mediumMax: 70,
        heavyMax: 120,
        extremeMax: Infinity
    },

    // Concurrency by workload class
    maxConcurrency: {
        light: 5,
        medium: 3,
        heavy: 2,
        extreme: 1
    },

    // Throttling multipliers
    throttleByWorkload: {
        light: 1.0,
        medium: 0.9,
        heavy: 0.6,
        extreme: 0.25
    },

    // Recommended priority boost by workload
    priorityBoost: {
        light: 10,
        medium: 5,
        heavy: -10,
        extreme: -25
    }
};

// ======================================================
// POLICY DECISION TYPES
// ======================================================

const WorkloadDecisionType = {
    LIGHT: 'light',
    MEDIUM: 'medium',
    HEAVY: 'heavy',
    EXTREME: 'extreme',
    CLASSIFIED_SUCCESS: 'classified_success'
};

// ======================================================
// CLASSIFY WORKLOAD
// ======================================================

/**
 * Classify scene workload.
 */
async function classifyWorkload(redis, scene, loadedBook) {
    const result = await workloadClassifier.getClassification(redis, scene, loadedBook);
    return result;
}

/**
 * Get workload class from score.
 */
function getWorkloadClass(score) {
    if (score <= WORKLOAD_POLICY_CONFIG.costThresholds.lightMax) {
        return workloadClassifier.WorkloadClass.LIGHT;
    } else if (score <= WORKLOAD_POLICY_CONFIG.costThresholds.mediumMax) {
        return workloadClassifier.WorkloadClass.MEDIUM;
    } else if (score <= WORKLOAD_POLICY_CONFIG.costThresholds.heavyMax) {
        return workloadClassifier.WorkloadClass.HEAVY;
    }
    return workloadClassifier.WorkloadClass.EXTREME;
}

// ======================================================
// POLICY EVALUATION
// ======================================================

/**
 * Evaluate workload policy.
 * Returns workload decision with capacity and throttle recommendations.
 */
async function evaluate(redis, scene, loadedBook, runtimeState) {
    // Classify workload
    const classification = await classifyWorkload(redis, scene, loadedBook);
    const workload = classification.workload;

    // Get runtime state for comparison
    const activePerStage = runtimeState?.perStage || {
        audio: 0,
        image: 0,
        video: 0
    };

    // Calculate recommended concurrency
    const recommendedConcurrency = WORKLOAD_POLICY_CONFIG.maxConcurrency[workload.toLowerCase()] || 2;

    // Check quota for stage
    const activeCount = activePerStage[scene.stage || 'audio'] || 0;

    // Determine if workload can be accommodated
    letcanAccommodate = true;
    let throttle = WORKLOAD_POLICY_CONFIG.throttleByWorkload[workload.toLowerCase()] || 1.0;
    let delayMs = 0;
    let priorityAdjustment = WORKLOAD_POLICY_CONFIG.priorityBoost[workload.toLowerCase()] || 0;

    // If quota near capacity, further throttle heavy workloads
    if (activeCount >= 2) {
        if (workload === workloadClassifier.WorkloadClass.HEAVY) {
            throttle = Math.min(throttle, 0.5);
        } else if (workload === workloadClassifier.WorkloadClass.EXTREME) {
            throttle = Math.min(throttle, 0.2);
            delayMs = 5000;
        }
    }

    // Adjust priority based on workload
    let basePriority = scene.priority || 50;
    let adjustedPriority = Math.max(0, Math.min(100, basePriority + priorityAdjustment));

    log(`WORKLOAD_POLICY_EVAL: ${scene.book_id}/${scene.chapter_id}/${scene.scene_id} = ${workload} (throttle=${throttle.toFixed(2)})`);

    return {
        decisionType: WorkloadDecisionType.CLASSIFIED_SUCCESS,
        workload,
        classification,
        allowed: true,
        reason: 'workload_classified',
        throttle,
        delayMs,
        adjustedPriority,
        basePriority,
        recommendedConcurrency,
        currentActive: activeCount,
        canAccommodate
    };
}

// ======================================================
// WORKLOAD-DISPATh_CAPACITY CHECK
// ======================================================

/**
 * Check if system can handle workload of given class.
 */
async function canHandleWorkload(redis, workload, stage, runtimeState) {
    const activePerStage = runtimeState?.perStage || {
        audio: 0,
        image: 0,
        video: 0
    };

    const activeCount = activePerStage[stage || 'audio'] || 0;
    const maxConcurrency = WORKLOAD_POLICY_CONFIG.maxConcurrency[workload.toLowerCase()] || 2;

    return {
        canHandle: activeCount < maxConcurrency,
        active: activeCount,
        maxConcurrency,
        workload,
        stage
    };
}

// ======================================================
// WORKLOAD PRIORITY ADJUSTMENT
// ======================================================

/**
 * Adjust priority based on workload class.
 */
function adjustPriorityForWorkload(workload, basePriority) {
    const adjustment = WORKLOAD_POLICY_CONFIG.priorityBoost[workload.toLowerCase()] || 0;
    return Math.max(0, Math.min(100, basePriority + adjustment));
}

/**
 * Get recommended concurrency for workload.
 */
function getRecommendedConcurrency(workload) {
    return WORKLOAD_POLICY_CONFIG.maxConcurrency[workload.toLowerCase()] || 2;
}

// ======================================================
// WORKLOAD DISTRIBUTION
// ======================================================

/**
 * Get current workload distribution across active scenes.
 */
async function getActiveWorkloadDistribution(redis) {
    const distribution = {
        [workloadClassifier.WorkloadClass.LIGHT]: 0,
        [workloadClassifier.WorkloadClass.MEDIUM]: 0,
        [workloadClassifier.WorkloadClass.HEAVY]: 0,
        [workloadClassifier.WorkloadClass.EXTREME]: 0
    };

    const activeScenes = await redis.smembers('animastor:active-scenes');

    for (const sceneKey of activeScenes) {
        const [bookId, chapterId, sceneId] = sceneKey.split(':');
        const cacheKey = workloadClassifier.getWorkloadCacheKey(bookId, chapterId, sceneId);
        const cached = await redis.get(cacheKey);

        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (parsed.workload) {
                    distribution[parsed.workload] = (distribution[parsed.workload] || 0) + 1;
                }
            } catch (e) {
                // Skip invalid cache entries
            }
        }
    }

    const total = activeScenes.length;
    return {
        total,
        distribution,
        percentages: {
            [workloadClassifier.WorkloadClass.LIGHT]: total > 0 ? Math.round((distribution[workloadClassifier.WorkloadClass.LIGHT] / total) * 100) : 0,
            [workloadClassifier.WorkloadClass.MEDIUM]: total > 0 ? Math.round((distribution[workloadClassifier.WorkloadClass.MEDIUM] / total) * 100) : 0,
            [workloadClassifier.WorkloadClass.HEAVY]: total > 0 ? Math.round((distribution[workloadClassifier.WorkloadClass.HEAVY] / total) * 100) : 0,
            [workloadClassifier.WorkloadClass.EXTREME]: total > 0 ? Math.round((distribution[workloadClassifier.WorkloadClass.EXTREME] / total) * 100) : 0
        }
    };
}

// ======================================================
// POLICY PRECEDENCE
// ======================================================
// Workload policy has medium precedence for routing decisions.

const WORKLOAD_PRECEDENCE = 6; // Lower = higher precedence

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    WorkloadDecisionType,
    WORKLOAD_POLICY_CONFIG,

    // Classification
    classifyWorkload,
    getWorkloadClass,

    // Policy evaluation
    evaluate,

    // Capacity check
    canHandleWorkload,
    getRecommendedConcurrency,

    // Priority adjustment
    adjustPriorityForWorkload,

    // Distribution
    getActiveWorkloadDistribution,

    // Precedence
    WORKLOAD_PRECEDENCE
};
