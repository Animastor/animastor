// ======================================================
// FAIRNESS POLICY - EQUITABLE PROGRESS GUARANTEE
// ======================================================
// Ensures no scene is starved of resources.
// Detects and handles starvation scenarios.

const logPrefix = '[POLICY:FAIRNESS]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

// ======================================================
// FAIRNESS CONFIGURATION
// ======================================================

const FAIRNESS_CONFIG = {
    // Starvation thresholds
    starvationThresholdMinutes: 15, // 15 minutes without progress
    boostFactor: 1.5, // 50% priority boost for starving scenes

    // Fairness scoring
    minScore: 0,
    maxScore: 100,
    deviationThreshold: 20, // Score deviation to trigger fairness action

    // Book-level fairness
    maxConcurrentPerBook: 5,
    minScenesPerBook: 1
};

// ======================================================
// FAIRNESS STATE KEYS
// ======================================================

const FAIRNESS_BOOK_KEY = 'animastor:runtime:fairness:book';
const FAIRNESS_STARVATION_KEY = 'animastor:runtime:fairness:starvation';

// ======================================================
// POLICY DECISION TYPES
// ======================================================

const FairnessDecisionType = {
    FAIR: 'fair',
    STARVATION_DETECTED: 'starvation_detected',
    BOOST_APPLIED: 'boost_applied',
    BOOK_LIMITED: 'book_limited'
};

// ======================================================
// CHECK STARVATION
// ======================================================

/**
 * Check if scene is starving.
 * Starvation = no progress for configured threshold.
 */
async function checkStarvation(redis, bookId, chapterId, sceneId) {
    const key = `${FAIRNESS_STARVATION_KEY}:${bookId}:${chapterId}:${sceneId}`;
    const lastProgress = await redis.get(key);

    if (!lastProgress) {
        // New scene - track its start
        await redis.set(key, Date.now().toString(), 'EX', 3600);
        return { starving: false, ageMinutes: 0 };
    }

    const lastProgressTime = parseInt(lastProgress, 10);
    const ageMinutes = (Date.now() - lastProgressTime) / 60000;

    if (ageMinutes > FAIRNESS_CONFIG.starvationThresholdMinutes) {
        log(`STARVATION_DETECTED: ${bookId}/${chapterId}/${sceneId} (${ageMinutes.toFixed(1)}m)`);
        return { starving: true, ageMinutes, lastProgressTime };
    }

    return { starving: false, ageMinutes, lastProgressTime };
}

/**
 * Mark scene progress (for starvation tracking).
 */
async function markProgress(redis, bookId, chapterId, sceneId) {
    const key = `${FAIRNESS_STARVATION_KEY}:${bookId}:${chapterId}:${sceneId}`;
    await redis.set(key, Date.now().toString(), 'EX', 3600);
}

/**
 * Boost priority for starving scene.
 */
function boostStarvingPriority(priority) {
    const boosted = Math.min(priority * FAIRNESS_CONFIG.boostFactor, 100);
    return Math.round(boosted);
}

// ======================================================
// BOOK-LEVEL FAIRNESS
// ======================================================

/**
 * Get book's active scene count.
 */
async function getBookActiveCount(redis, bookId) {
    const key = `${FAIRNESS_BOOK_KEY}:${bookId}`;
    const count = await redis.get(key);
    return parseInt(count || '0', 10);
}

/**
 * Increment book's active scene count.
 */
async function incrementBookActive(redis, bookId) {
    const key = `${FAIRNESS_BOOK_KEY}:${bookId}`;
    const newCount = await redis.incr(key);
    return newCount;
}

/**
 * Decrement book's active scene count.
 */
async function decrementBookActive(redis, bookId) {
    const key = `${FAIRNESS_BOOK_KEY}:${bookId}`;
    const count = await redis.get(key);
    if (count) {
        return await redis.decr(key);
    }
    return 0;
}

/**
 * Check if book has exceeded max concurrent scenes.
 */
async function checkBookLimit(redis, bookId) {
    const activeCount = await getBookActiveCount(redis, bookId);
    const exceeded = activeCount >= FAIRNESS_CONFIG.maxConcurrentPerBook;
    return {
        active: activeCount,
        max: FAIRNESS_CONFIG.maxConcurrentPerBook,
        exceeded,
        limited: exceeded
    };
}

/**
 * Record scene start for book fairness tracking.
 */
async function recordSceneStart(redis, bookId, chapterId, sceneId) {
    await incrementBookActive(redis, bookId);
    await markProgress(redis, bookId, chapterId, sceneId);
}

/**
 * Record scene completion for book fairness tracking.
 */
async function recordSceneCompletion(redis, bookId, chapterId, sceneId) {
    await decrementBookActive(redis, bookId);
}

// ======================================================
// POLICY EVALUATION
// ======================================================

/**
 * Evaluate fairness policy for scene.
 * Returns decision with fairness constraints.
 */
async function evaluate(redis, scene) {
    const { bookId, chapterId, sceneId } = scene;

    // Check for starvation
    const starvation = await checkStarvation(redis, bookId, chapterId, sceneId);

    // Check book limit
    const bookLimit = await checkBookLimit(redis, bookId);

    // Build fairness score
    let fairnessScore = 100;
    let reason = 'no_fairness_issue';
    let priorityBoost = 0;

    if (starvation.starving) {
        reason = 'starvation_detected';
        priorityBoost = FAIRNESS_CONFIG.boostFactor;
        fairnessScore = Math.max(fairnessScore - 50, 0);
    }

    if (bookLimit.exceeded) {
        reason = 'book_limit_reached';
        fairnessScore = Math.max(fairnessScore - 30, 0);
    }

    return {
        decisionType: starvation.starving ? FairnessDecisionType.STARVATION_DETECTED : FairnessDecisionType.FAIR,
        allowed: true,
        reason,
        fairnessScore,
        priorityBoost,
        starvation: starvation,
        bookLimit,
        boostApplied: starvation.starving
    };
}

// ======================================================
// SCENE-LEVEL FAIRNESS (performance tracking)
// ======================================================

const SCENE_PERF_KEY = 'animastor:runtime:fairness:perf';

/**
 * Record scene completion time.
 */
async function recordScenePerf(redis, scene, perfMs) {
    const key = `${SCENE_PERF_KEY}:${scene.book_id}:${scene.chapter_id}:${scene.scene_id}`;
    await redis.rpush(key, perfMs.toString());
    await redis.ltrim(key, 0, 99); // Keep last 100
}

/**
 * Get average scene completion time.
 */
async function getSceneAvgPerf(redis, scene) {
    const key = `${SCENE_PERF_KEY}:${scene.book_id}:${scene.chapter_id}:${scene.scene_id}`;
    const times = await redis.lrange(key, 0, -1);
    if (times.length === 0) return null;

    const sum = times.reduce((acc, t) => acc + parseInt(t, 10), 0);
    return sum / times.length;
}

// ======================================================
// SCENE SCORE CALCULATION
// ======================================================

/**
 * Calculate fairness score based on multiple factors.
 */
async function calculateSceneScore(redis, scene) {
    const [starvation, avgPerf] = await Promise.all([
        checkStarvation(redis, scene.book_id, scene.chapter_id, scene.sceneId),
        getSceneAvgPerf(redis, scene)
    ]);

    let score = 100;

    // Starvation penalty
    if (starvation.starving) {
        score -= 50;
    }

    // Performance deviation (faster scenes get boost)
    if (avgPerf) {
        const idealPerf = 30000; // 30 seconds ideal
        const deviation = Math.abs(avgPerf - idealPerf) / idealPerf;
        if (deviation < 0.5) {
            score += 10;
        } else if (deviation > 1.5) {
            score -= 10;
        }
    }

    return Math.max(0, Math.min(100, Math.round(score)));
}

// ======================================================
// POLICY PRECEDENCE
// ======================================================
// Fairness has high precedence for preventing starvation.

const FAIRNESS_PRECEDENCE = 5; // Lower = higher precedence

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    FairnessDecisionType,
    FAIRNESS_CONFIG,

    // Starvation detection
    checkStarvation,
    markProgress,
    boostStarvingPriority,

    // Book-level fairness
    getBookActiveCount,
    incrementBookActive,
    decrementBookActive,
    checkBookLimit,
    recordSceneStart,
    recordSceneCompletion,

    // Scene fairness
    evaluate,
    calculateSceneScore,
    recordScenePerf,
    getSceneAvgPerf,

    // Precedence
    FAIRNESS_PRECEDENCE
};
