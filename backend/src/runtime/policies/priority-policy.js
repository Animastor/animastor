// ======================================================
// PRIORITY POLICY - PRIORITY NORMALIZATION AND BOOSTS
// ======================================================
// Normalizes scene priorities and applies boosts.
// Handles priority fairness and starvation recovery.

const logPrefix = '[POLICY:PRIORITY]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

// ======================================================
// PRIORITY POLICY CONFIGURATION
// ======================================================

const PRIORITY_POLICY_CONFIG = {
    // Priority range
    minPriority: 0,
    maxPriority: 100,
    defaultPriority: 50,

    // Priority normalization
    normalizeRange: { min: 0, max: 100 },

    // Boost multipliers
    boostMultipliers: {
        starving: 1.5,       // 50% boost for starving scenes
        queued: 1.2,         // 20% boost for queued scenes
        highValue: 1.3,      // 30% boost for high-value scenes
        lowValue: 0.8        // 20% reduction for low-value scenes
    },

    // Starvation thresholds (minutes without progress)
    starvationMinutes: 15,

    // Priority decay (aging)
    decayMinutes: 30,      // Decay applies after 30 minutes
    decayRate: 0.02        // 2% reduction per decay tick
};

// ======================================================
// POLICY DECISION TYPES
// ======================================================

const PriorityDecisionType = {
    NORMALIZED: 'normalized',
    BOOSTED: 'boosted',
    DECAYED: 'decayed',
    STARVATION_RECOVERY: 'starvation_recovery'
};

// ======================================================
// PRIORITY NORMALIZATION
// ======================================================

/**
 * Normalize priority within configured range.
 */
function normalizePriority(score, config = {}) {
    const min = config.min ?? PRIORITY_POLICY_CONFIG.minPriority;
    const max = config.max ?? PRIORITY_POLICY_CONFIG.maxPriority;

    // Clamp score first
    let clamped = Math.max(min, Math.min(max * 2, score)); // Allow some overflow

    // Linear normalization
    const normalized = Math.round((clamped / (max * 2)) * (max - min) + min);

    return {
        normalized,
        original: score,
        min,
        max,
        clamped
    };
}

/**
 * Get normalized priority for scene.
 */
async function getNormalizedPriority(redis, scene) {
    const score = scene.priority || PRIORITY_POLICY_CONFIG.defaultPriority;
    return normalizePriority(score);
}

// ======================================================
// PRIORITY BOOST CALCULATION
// ======================================================

/**
 * Calculate priority boost factors.
 */
async function calculateBoostFactors(redis, scene) {
    const boosts = [];

    // Check starvation
    const starvationKey = `animastor:runtime:fairness:starvation:${scene.book_id}:${scene.chapter_id}:${scene.scene_id}`;
    const lastProgress = await redis.get(starvationKey);

    if (lastProgress) {
        const lastProgressTime = parseInt(lastProgress, 10);
        const ageMinutes = (Date.now() - lastProgressTime) / 60000;

        if (ageMinutes > PRIORITY_POLICY_CONFIG.starvationMinutes) {
            boosts.push({
                type: 'starvation',
                multiplier: PRIORITY_POLICY_CONFIG.boostMultipliers.starving,
                message: `Starvation detected (${ageMinutes.toFixed(1)}m)`,
                adjustedPriority: PRIORITY_POLICY_CONFIG.defaultPriority * PRIORITY_POLICY_CONFIG.boostMultipliers.starving
            });
        }
    }

    // Check if in queue (queued scenes get small boost)
    const queueScore = await redis.zscore('animastor:priority:queue', scene.book_id + ':' + scene.chapter_id + ':' + scene.scene_id);
    if (queueScore !== null) {
        boosts.push({
            type: 'queued',
            multiplier: PRIORITY_POLICY_CONFIG.boostMultipliers.queued,
            message: 'Scene in priority queue',
            adjustedPriority: PRIORITY_POLICY_CONFIG.defaultPriority * PRIORITY_POLICY_CONFIG.boostMultipliers.queued
        });
    }

    return {
        basePriority: scene.priority || PRIORITY_POLICY_CONFIG.defaultPriority,
        boosts,
        totalBoostMultiplier: boosts.reduce((acc, b) => acc * b.multiplier, 1)
    };
}

/**
 * Calculate final priority with all boosts.
 */
async function calculateFinalPriority(redis, scene) {
    const boostFactors = await calculateBoostFactors(redis, scene);
    let finalPriority = boostFactors.basePriority * boostFactors.totalBoostMultiplier;
    finalPriority = Math.min(100, Math.max(0, Math.round(finalPriority)));

    return {
        finalPriority,
        boostFactors,
        boosted: boostFactors.totalBoostMultiplier > 1,
        totalBoostPercent: (boostFactors.totalBoostMultiplier - 1) * 100
    };
}

// ======================================================
// PRIORITY DECAY (AGING)
// ======================================================

/**
 * Calculate priority decay for waiting scene.
 */
async function calculatePriorityDecay(redis, scene) {
    const queueEntry = await redis.zscore('animastor:priority:queue', scene.book_id + ':' + scene.chapter_id + ':' + scene.scene_id);

    if (queueEntry === null) {
        return {
            decayed: false,
            decayPercent: 0,
            message: 'Not in priority queue'
        };
    }

    const queueTime = parseInt(queueEntry, 10);
    const waitMinutes = (Date.now() - queueTime) / 60000;

    if (waitMinutes < PRIORITY_POLICY_CONFIG.decayMinutes) {
        return {
            decayed: false,
            decayPercent: 0,
            waitMinutes,
            message: 'Below decay threshold'
        };
    }

    // Calculate decay
    const decayTicks = Math.floor((waitMinutes - PRIORITY_POLICY_CONFIG.decayMinutes) / 5); // Every 5 minutes
    const decayPercent = Math.min(50, decayTicks * PRIORITY_POLICY_CONFIG.decayRate * 100);

    return {
        decayed: true,
        decayPercent,
        waitMinutes,
        decayTicks,
        message: `Priority decayed ${Math.round(decayPercent)}% after ${waitMinutes.toFixed(1)}m wait`
    };
}

// ======================================================
// PRIORITY ORDERING
// ======================================================

/**
 * Compare two scenes by priority (for sorting).
 */
function compareByPriority(sceneA, sceneB) {
    const priorityA = sceneA.priority || PRIORITY_POLICY_CONFIG.defaultPriority;
    const priorityB = sceneB.priority || PRIORITY_POLICY_CONFIG.defaultPriority;
    return priorityB - priorityA; // Higher priority first
}

/**
 * Sort scenes by priority.
 */
function sortByPriority(scenes) {
    return [...scenes].sort(compareByPriority);
}

// ======================================================
// POLICY EVALUATION
// ======================================================

/**
 * Evaluate priority policy for scene.
 * Returns priority decision with boost information.
 */
async function evaluate(redis, scene) {
    const [normalized, finalPriority, boostFactors, decay] = await Promise.all([
        getNormalizedPriority(redis, scene),
        calculateFinalPriority(redis, scene),
        calculateBoostFactors(redis, scene),
        calculatePriorityDecay(redis, scene)
    ]);

    // Determine decision type
    let decisionType;
    let reason;

    if (decay.decayed) {
        decisionType = PriorityDecisionType.DECAYED;
        reason = 'priority_decay_applied';
    } else if (boostFactors.totalBoostMultiplier > 1) {
        decisionType = PriorityDecisionType.BOOSTED;
        reason = 'priority_boost_applied';
    } else {
        decisionType = PriorityDecisionType.NORMALIZED;
        reason = 'priority_normalized';
    }

    log(`PRIORITY_POLICY_EVAL: ${scene.book_id}/${scene.chapter_id}/${scene.scene_id} (priority=${finalPriority.finalPriority})`);

    return {
        decisionType,
        allowed: true,
        reason,
        originalPriority: scene.priority || PRIORITY_POLICY_CONFIG.defaultPriority,
        normalizedPriority: normalized.normalized,
        finalPriority: finalPriority.finalPriority,
        boostFactors,
        decay,
        boosted: boostFactors.totalBoostMultiplier > 1
    };
}

// ======================================================
// PRIORITY BOOST FOR STARVATION RECOVERY
// ======================================================

/**
 * Apply priority boost for starvation recovery.
 */
async function applyStarvationBoost(redis, scene) {
    const boost = PRIORITY_POLICY_CONFIG.boostMultipliers.starving;
    const original = scene.priority || PRIORITY_POLICY_CONFIG.defaultPriority;
    const boosted = Math.min(100, Math.round(original * boost));

    return {
        original,
        boosted,
        multiplier: boost,
        reason: 'starvation_recovery'
    };
}

/**
 * Get scenes that need priority boost (starving).
 */
async function getStarvingScenes(redis) {
    const starving = [];
    const pendingPattern = 'animastor:scene-state:*';
    let cursor = 0;

    do {
        const result = await redis.scan(cursor, 'MATCH', pendingPattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        const keys = result[1];

        for (const key of keys) {
            const raw = await redis.get(key);
            if (!raw) continue;

            try {
                const state = JSON.parse(raw);
                if (state.state === 'pending' || state.state === 'processing') {
                    const parts = key.split(':');
                    const scene = {
                        book_id: parts[2],
                        chapter_id: parts[3],
                        scene_id: parts[4],
                        priority: state.priority || PRIORITY_POLICY_CONFIG.defaultPriority
                    };

                    const boostFactors = await calculateBoostFactors(redis, scene);
                    if (boostFactors.boosts.some(b => b.type === 'starvation')) {
                        starving.push({ scene, boostFactors });
                    }
                }
            } catch (e) {
                // Skip invalid entries
            }
        }
    } while (cursor !== 0 && starving.length < 100);

    return starving;
}

// ======================================================
// POLICY PRECEDENCE
// ======================================================
// Priority policy has medium precedence.

const PRIORITY_PRECEDENCE = 7; // Lower = higher precedence

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    PriorityDecisionType,
    PRIORITY_POLICY_CONFIG,

    // Priority normalization
    normalizePriority,
    getNormalizedPriority,

    // Boost calculation
    calculateBoostFactors,
    calculateFinalPriority,
    applyStarvationBoost,

    // Priority decay
    calculatePriorityDecay,

    // Sorting
    compareByPriority,
    sortByPriority,

    // Policy evaluation
    evaluate,

    // Starvation detection
    getStarvingScenes,

    // Precedence
    PRIORITY_PRECEDENCE
};
