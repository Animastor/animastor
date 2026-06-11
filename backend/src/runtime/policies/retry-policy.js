// ======================================================
// RETRY POLICY - RETRY PRESSURE MANAGEMENT
// ======================================================
// Prevents retry storms and manages retry budgets.
// Ensures retry pressure doesn't overwhelm the system.

const logPrefix = '[POLICY:RETRY]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

// ======================================================
// RETRY CONFIGURATION
// ======================================================

const RETRY_CONFIG = {
    // Per-scene retry limits
    maxRetriesPerScene: 20,
    baseRetryDelayMs: 1000, // 1 second base delay
    maxRetryDelayMs: 30000, // 30 seconds max delay

    // Global retry pressure thresholds
    highRetryScenesThreshold: 5, // >5 scenes with retries = retry storm
    retryStormDelayMs: 10000, // 10 second base delay during retry storm

    // Retry budget
    maxRetriesPerWindow: 100, // Per hour window
    retryWindowMs: 3600000, // 1 hour

    // Backoff strategy
    exponentialBackoffBase: 2,
    exponentialBackoffMax: 8
};

// ======================================================
// RETRY KEY PATTERNS
// ======================================================

const RETRY_COUNT_KEY = 'animastor:runtime:retry';
const RETRY_BUDGET_KEY = 'animastor:runtime:retry:budget';
const RETRY_STORM_KEY = 'animastor:runtime:retry:storm';

// ======================================================
// POLICY DECISION TYPES
// ======================================================

const RetryDecisionType = {
    ALLOWED: 'allowed',
    DELAYED: 'delayed',
    BLOCKED: 'blocked',
    RATE_LIMITED: 'rate_limited'
};

// ======================================================
// GET RETRY COUNT
// ======================================================

/**
 * Get retry count for scene.
 */
async function getRetryCount(redis, bookId, chapterId, sceneId) {
    const key = `${RETRY_COUNT_KEY}:${bookId}:${chapterId}:${sceneId}:count`;
    const count = await redis.get(key);
    return parseInt(count || '0', 10);
}

/**
 * Increment retry count for scene.
 */
async function incrementRetryCount(redis, bookId, chapterId, sceneId) {
    const key = `${RETRY_COUNT_KEY}:${bookId}:${chapterId}:${sceneId}:count`;
    const newCount = await redis.incr(key);
    await redis.expire(key, 86400); // 24 hour TTL
    return newCount;
}

/**
 * Reset retry count for scene (on success).
 */
async function resetRetryCount(redis, bookId, chapterId, sceneId) {
    const key = `${RETRY_COUNT_KEY}:${bookId}:${chapterId}:${sceneId}:count`;
    await redis.del(key);
}

// ======================================================
// RETRY DELAY CALCULATION
// ======================================================

/**
 * Calculate retry delay with exponential backoff.
 */
function calculateRetryDelay(attempt, baseDelay = RETRY_CONFIG.baseRetryDelayMs) {
    const backoff = Math.min(
        RETRY_CONFIG.exponentialBackoffMax,
        Math.pow(RETRY_CONFIG.exponentialBackoffBase, attempt)
    );
    return Math.min(
        RETRY_CONFIG.maxRetryDelayMs,
        Math.floor(baseDelay * backoff)
    );
}

/**
 * Get delay for next retry.
 */
async function getNextRetryDelay(redis, bookId, chapterId, sceneId) {
    const count = await getRetryCount(redis, bookId, chapterId, sceneId);
    const delay = calculateRetryDelay(count);
    return {
        delayMs: delay,
        attempt: count,
        maxRetries: RETRY_CONFIG.maxRetriesPerScene
    };
}

// ======================================================
// RETRY BUDGET CHECK
// ======================================================

/**
 * Get current retry budget usage.
 */
async function getRetryBudgetUsage(redis) {
    const key = `${RETRY_BUDGET_KEY}:count`;
    const count = await redis.get(key);
    return parseInt(count || '0', 10);
}

/**
 * Check if retry budget is exceeded.
 */
async function checkRetryBudget(redis) {
    const current = await getRetryBudgetUsage(redis);
    const exceeded = current >= RETRY_CONFIG.maxRetriesPerWindow;
    return {
        current,
        max: RETRY_CONFIG.maxRetriesPerWindow,
        exceeded,
        remaining: Math.max(0, RETRY_CONFIG.maxRetriesPerWindow - current)
    };
}

/**
 * Consume retry budget.
 */
async function consumeRetryBudget(redis) {
    const key = `${RETRY_BUDGET_KEY}:count`;
    const newCount = await redis.incr(key);
    await redis.expire(key, RETRY_CONFIG.retryWindowMs);
    return newCount;
}

/**
 * Reset retry budget (called periodically).
 */
async function resetRetryBudget(redis) {
    const key = `${RETRY_BUDGET_KEY}:count`;
    await redis.del(key);
}

// ======================================================
// RETRY STORM DETECTION
// ======================================================

/**
 * Count scenes with high retry counts.
 */
async function countHighRetryScenes(redis) {
    const pattern = `${RETRY_COUNT_KEY}:*:count`;
    let cursor = 0;
    let highRetryCount = 0;

    do {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        const keys = result[1];

        for (const key of keys) {
            const count = parseInt(await redis.get(key) || '0', 10);
            if (count > 10) highRetryCount++;
        }
    } while (cursor !== 0);

    return highRetryCount;
}

/**
 * Check if retry storm is active.
 */
async function isRetryStormActive(redis) {
    const highRetryCount = await countHighRetryScenes(redis);
    const stormActive = highRetryCount >= RETRY_CONFIG.highRetryScenesThreshold;

    if (stormActive) {
        await redis.set(RETRY_STORM_KEY, Date.now().toString(), 'EX', 300);
    } else {
        await redis.del(RETRY_STORM_KEY);
    }

    return {
        active: stormActive,
        highRetryScenes: highRetryCount,
        threshold: RETRY_CONFIG.highRetryScenesThreshold
    };
}

/**
 * Get retry storm delay.
 */
async function getRetryStormDelay(redis) {
    const storm = await isRetryStormActive(redis);
    if (!storm.active) return { active: false, delayMs: 0 };

    return {
        active: true,
        delayMs: RETRY_CONFIG.retryStormDelayMs,
        highRetryScenes: storm.highRetryScenes
    };
}

// ======================================================
// PER-SCENE RETRY STATE
// ======================================================

/**
 * Get retry state for scene.
 */
async function getSceneRetryState(redis, bookId, chapterId, sceneId) {
    const [count, budget] = await Promise.all([
        getRetryCount(redis, bookId, chapterId, sceneId),
        checkRetryBudget(redis)
    ]);

    return {
        sceneRetries: count,
        maxRetries: RETRY_CONFIG.maxRetriesPerScene,
        exceeded: count >= RETRY_CONFIG.maxRetriesPerScene,
        budget,
        canRetry: count < RETRY_CONFIG.maxRetriesPerScene && !budget.exceeded
    };
}

/**
 * Check if retry is allowed.
 */
async function canRetry(redis, bookId, chapterId, sceneId) {
    const state = await getSceneRetryState(redis, bookId, chapterId, sceneId);
    const storm = await isRetryStormActive(redis);

    if (!state.canRetry) {
        return {
            allowed: false,
            reason: state.exceeded ? 'max_retries_exceeded' : 'budget_exceeded'
        };
    }

    if (storm.active) {
        return {
            allowed: true,
            delayed: true,
            reason: 'retry_storm_active',
            delayMs: RETRY_CONFIG.retryStormDelayMs
        };
    }

    return {
        allowed: true,
        delayed: false,
        reason: 'retry_allowed'
    };
}

// ======================================================
// POLICY EVALUATION
// ======================================================

/**
 * Evaluate retry policy for scene/stage.
 */
async function evaluate(redis, scene, stage) {
    const { bookId, chapterId, sceneId } = scene;

    // Get retry state
    const retryState = await getSceneRetryState(redis, bookId, chapterId, sceneId);
    const storm = await isRetryStormActive(redis);

    // Check if max retries exceeded
    if (retryState.exceeded) {
        log(`RETRY_BLOCKED: ${bookId}/${chapterId}/${sceneId}:${stage} (max retries)`);
        return {
            decisionType: RetryDecisionType.BLOCKED,
            allowed: false,
            reason: 'max_retries_exceeded',
            sceneRetries: retryState.sceneRetries,
            maxRetries: RETRY_CONFIG.maxRetriesPerScene
        };
    }

    // Check budget
    if (retryState.budget.exceeded) {
        log(`RETRY_BLOCKED: global budget exceeded`);
        return {
            decisionType: RetryDecisionType.BLOCKED,
            allowed: false,
            reason: 'global_budget_exceeded',
            budgetUsed: retryState.budget.current,
            budgetMax: retryState.budget.max
        };
    }

    // Apply retry storm delay
    let delayMs = 0;
    if (storm.active) {
        delayMs = RETRY_CONFIG.retryStormDelayMs;
    }

    // Calculate backoff delay for this attempt
    const nextDelay = await getNextRetryDelay(redis, bookId, chapterId, sceneId);

    log(`RETRY_POLICY_EVALUATED: ${bookId}/${chapterId}/${sceneId}:${stage} (delay=${nextDelay.delayMs}ms)`);

    return {
        decisionType: storm.active ? RetryDecisionType.DELAYED : RetryDecisionType.ALLOWED,
        allowed: true,
        reason: storm.active ? 'retry_storm_delayed' : 'retry_allowed',
        nextAttemptDelay: nextDelay,
        totalAttempts: retryState.sceneRetries,
        retryStorm: storm.active ? {
            active: true,
            highRetryScenes: storm.highRetryScenes,
            delayMs
        } : null
    };
}

// ======================================================
// POLICY PRECEDENCE
// ======================================================
// Retry policy has high precedence to prevent system saturation.

const RETRY_PRECEDENCE = 3; // Lower = higher precedence

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    RetryDecisionType,
    RETRY_CONFIG,

    // Retry count management
    getRetryCount,
    incrementRetryCount,
    resetRetryCount,
    calculateRetryDelay,
    getNextRetryDelay,

    // Retry budget management
    getRetryBudgetUsage,
    checkRetryBudget,
    consumeRetryBudget,
    resetRetryBudget,

    // Retry storm detection
    countHighRetryScenes,
    isRetryStormActive,
    getRetryStormDelay,

    // Scene retry state
    getSceneRetryState,
    canRetry,

    // Policy evaluation
    evaluate,

    // Precedence
    RETRY_PRECEDENCE
};
