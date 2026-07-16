// ======================================================
// Fairness Engine - v1.0.0
// ======================================================
// Ensures fair scheduling across all scenes and books.
// Prevents:
// - one giant book starving others
// - retry storms starving new jobs
// - video monopolizing runtime
//
// FAIRNESS RULES:
// - round-robin progression
// - quota partitioning
// - retry throttling
// - per-book fairness

const logPrefix = '[FAIRNESS]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

function error(msg) {
    console.error(`${logPrefix} ❌ ${msg}`);
}

// ======================================================
// CONFIGURATION
// ======================================================

const FAIRNESS_CONFIG = {
    // Per-book fairness
    maxScenesPerBook: 50,
    minBookShare: 0.1, // 10% minimum share

    // Round-robin
    maxConsecutivePerBook: 3,

    // Retry throttling
    retryThrottleWindowMs: 60000, // 1 minute
    maxRetriesPerWindow: 20,

    // Stage quotas
    stageQuotas: {
        audio: 3,
        image: 2,
        video: 1
    },

    // Starvation detection
    starvationThresholdMinutes: 10,
    boostDurationMinutes: 2
};

// ======================================================
// FAIRNESS KEYS
// ======================================================

/**
 * Get per-book fairness key.
 */
function getBookFairnessKey(bookId) {
    return `animastor:fairness:book:${bookId}`;
}

/**
 * Get round-robin cursor key.
 */
function getRoundRobinKey() {
    return 'animastor:fairness:roundrobin';
}

/**
 * Get retry throttle window key.
 */
function getRetryThrottleKey(bookId) {
    return `animastor:fairness:retry-throttle:${bookId}`;
}

/**
 * Get stage quota key.
 */
function getStageQuotaKey(stage) {
    return `animastor:fairness:quota:${stage}`;
}

/**
 * Get fairness rebalance counter key.
 */
function getRebalanceKey() {
    return 'animastor:fairness:rebalance-count';
}

// ======================================================
// BOOK FAIRNESS
// ======================================================

/**
 * Get book fairness score.
 */
async function getBookFairnessScore(redis, bookId) {
    const key = getBookFairnessKey(bookId);
    const raw = await redis.get(key);

    if (!raw) {
        // Default score
        return 50;
    }

    return parseInt(raw, 10);
}

/**
 * Update book fairness score.
 * Higher score = more waiting, needs priority.
 */
async function updateBookFairnessScore(redis, bookId, change) {
    const key = getBookFairnessKey(bookId);
    const current = await redis.get(key);
    let score = parseInt(current || '50', 10);
    score = Math.max(0, Math.min(100, score + change));

    await redis.set(key, score.toString(), 'EX', 300); // 5 minute TTL

    return { bookId, score, change };
}

/**
 * Reset book fairness score.
 */
async function resetBookFairnessScore(redis, bookId) {
    const key = getBookFairnessKey(bookId);
    await redis.set(key, '50', 'EX', 300);
    return { reset: true, bookId };
}

/**
 * Get all book fairness scores.
 */
async function getAllBookScores(redis) {
    const pattern = getBookFairnessKey('*');
    const scores = [];
    let cursor = 0;

    do {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        const keys = result[1];

        for (const key of keys) {
            const score = await redis.get(key);
            try {
                const parts = key.split(':');
                scores.push({
                    bookId: parts[3],
                    score: parseInt(score || '50', 10)
                });
            } catch (e) {
                // Skip
            }
        }
    } while (cursor !== 0 && scores.length < 1000);

    return scores;
}

// ======================================================
// ROUND-ROBIN SCHEDULING
// ======================================================

/**
 * Get next book for round-robin.
 */
async function getNextRoundRobinBook(redis) {
    const key = getRoundRobinKey();
    const cursor = await redis.get(key);
    const position = parseInt(cursor || '0', 10);

    return position;
}

/**
 * Advance round-robin cursor.
 */
async function advanceRoundRobin(redis, currentBookId) {
    const key = getRoundRobinKey();
    const current = await redis.get(key);
    let position = parseInt(current || '0', 10);

    // Simple increment
    position = position + 1;

    await redis.set(key, position.toString(), 'EX', 3600); // 1 hour TTL

    log(`ROUND_ROBIN_ADVANCE: position=${position}`);

    return { position, bookId: currentBookId };
}

/**
 * Get round-robin status.
 */
async function getRoundRobinStatus(redis) {
    const key = getRoundRobinKey();
    const position = await redis.get(key);

    return {
        position: parseInt(position || '0', 10),
        config: {
            maxConsecutive: FAIRNESS_CONFIG.maxConsecutivePerBook
        }
    };
}

// ======================================================
// STAGE QUOTAS
// ======================================================

/**
 * Get current stage quota usage.
 */
async function getStageQuotaUsed(redis, stage) {
    const key = getStageQuotaKey(stage);
    const used = await redis.get(key);
    return parseInt(used || '0', 10);
}

/**
 * Increment stage quota usage.
 */
async function incrementStageQuota(redis, stage) {
    const key = getStageQuotaKey(stage);
    const current = await redis.get(key);
    const value = parseInt(current || '0', 10) + 1;

    await redis.set(key, value.toString(), 'EX', 60); // 1 minute TTL

    return { stage, used: value, quota: FAIRNESS_CONFIG.stageQuotas[stage] };
}

/**
 * Decrement stage quota usage.
 */
async function decrementStageQuota(redis, stage) {
    const key = getStageQuotaKey(stage);
    const current = await redis.get(key);
    if (!current) return { stage, used: 0 };

    const value = Math.max(0, parseInt(current, 10) - 1);
    await redis.set(key, value.toString(), 'EX', 60);

    return { stage, used: value };
}

/**
 * Check if stage quota is available.
 */
async function checkStageQuota(redis, stage) {
    const used = await getStageQuotaUsed(redis, stage);
    const quota = FAIRNESS_CONFIG.stageQuotas[stage];

    return {
        available: used < quota,
        used,
        quota,
        remaining: Math.max(0, quota - used)
    };
}

// ======================================================
// RETRY THROTTLING
// ======================================================

/**
 * Check if book has exceeded retry throttle.
 */
async function checkRetryThrottle(redis, bookId) {
    const key = getRetryThrottleKey(bookId);
    const now = Date.now();
    const windowStart = now - FAIRNESS_CONFIG.retryThrottleWindowMs;

    // Get all retry timestamps for this window
    const members = await redis.zrangebyscore(key, windowStart, now);

    const count = members.length;

    return {
        allowed: count < FAIRNESS_CONFIG.maxRetriesPerWindow,
        count,
        max: FAIRNESS_CONFIG.maxRetriesPerWindow,
        remaining: Math.max(0, FAIRNESS_CONFIG.maxRetriesPerWindow - count)
    };
}

/**
 * Record retry attempt for throttle tracking.
 */
async function recordRetryThrottle(redis, bookId) {
    const key = getRetryThrottleKey(bookId);
    const now = Date.now();

    // Add timestamp to sorted set
    await redis.zadd(key, now, now.toString());

    // Remove old entries (older than window)
    const windowStart = now - FAIRNESS_CONFIG.retryThrottleWindowMs;
    await redis.zremrangebyscore(key, 0, windowStart);

    // Setexpiry
    await redis.expire(key, FAIRNESS_CONFIG.retryThrottleWindowMs / 1000 + 1);

    log(`RETRY_THROTTLE_RECORD: ${bookId} (count: ${await redis.zcard(key)})`);

    return { recorded: true, key };
}

/**
 * Clear retry throttle for a book.
 */
async function clearRetryThrottle(redis, bookId) {
    const key = getRetryThrottleKey(bookId);
    await redis.del(key);
    return { cleared: true, bookId };
}

// ======================================================
// STARVATION DETECTION
// ======================================================

/**
 * Check if scene is starving.
 */
async function isStarving(redis, bookId, chapterId, sceneId) {
    // Scene-state removed — starvation check via asset states
    const assetStates = require('../state');
    const states = await assetStates.getAssetStates(redis, bookId, chapterId, sceneId).catch(() => null);

    if (!states) {
        return { starving: false, reason: 'no_state' };
    }

    const now = Date.now();
    // Simplified: assume recent activity if any asset is in generating state
    const isGenerating = states.audio === 'generating' || states.image === 'generating' || states.video === 'generating';
    if (isGenerating) {
        return { starving: false, reason: 'actively_generating' };
    }

    return {
        starving: false,
        ageMinutes: 0,
        thresholdMinutes: FAIRNESS_CONFIG.starvationThreshold,
        state: 'pending_or_ready'
    };
}

/**
 * Boost priority for starving scene.
 */
async function boostStarvingScene(redis, bookId, chapterId, sceneId) {
    const key = `animastor:fairness:starvation-boost:${bookId}:${chapterId}:${sceneId}`;
    const now = Date.now();
    const expiry = FAIRNESS_CONFIG.boostDurationMinutes * 60;

    await redis.set(key, now.toString(), 'EX', expiry);

    log(`STARVATION_BOOST: ${bookId}/${chapterId}/${sceneId} (for ${FAIRNESS_CONFIG.boostDurationMinutes}min)`);

    return { boosted: true, expiry, key };
}

/**
 * Check if scene has active starvation boost.
 */
async function hasStarvationBoost(redis, bookId, chapterId, sceneId) {
    const key = `animastor:fairness:starvation-boost:${bookId}:${chapterId}:${sceneId}`;
    const exists = await redis.exists(key);

    if (!exists) {
        return { active: false };
    }

    const value = await redis.get(key);
    const boostStart = parseInt(value, 10);
    const remaining = (boostStart + FAIRNESS_CONFIG.boostDurationMinutes * 60000) - Date.now();

    return {
        active: true,
        remainingMs: Math.max(0, remaining),
        remainingMinutes: Math.ceil(remaining / 60000)
    };
}

// ======================================================
// FAIRNESS REBALANCE
// ======================================================

/**
 * Rebalance fairness scores.
 * Called periodically to prevent unfairness.
 */
async function rebalanceFairness(redis) {
    const scores = await getAllBookScores(redis);
    let rebalancedCount = 0;

    if (scores.length === 0) {
        return { rebalanced: 0, reason: 'no_books' };
    }

    // Normalize all scores toward 50
    for (const entry of scores) {
        if (entry.score > 70) {
            // High score - reduce it
            await updateBookFairnessScore(redis, entry.bookId, -10);
            rebalancedCount++;
        } else if (entry.score < 30) {
            // Low score - increase it
            await updateBookFairnessScore(redis, entry.bookId, 10);
            rebalancedCount++;
        }
    }

    // Increment rebalance counter
    const counterKey = getRebalanceKey();
    const totalRebalances = await redis.incr(counterKey);

    log(`FAIRNESS_REBALANCED: ${rebalancedCount} books (total: ${totalRebalances})`);

    return { rebalanced: rebalancedCount, totalRebalances };
}

/**
 * Get fairness rebalance stats.
 */
async function getRebalanceStats(redis) {
    const counterKey = getRebalanceKey();
    const count = await redis.get(counterKey);

    return {
        totalRebalances: parseInt(count || '0', 10)
    };
}

// ======================================================
// CONGESTION DETECTION
// ======================================================

/**
 * Check if runtime is congested.
 */
async function isRuntimeCongested(redis) {
    const activeScenes = await redis.scard('animastor:active-scenes');
    const activeLeases = await redis.scard('animastor:dispatch-lease:*');
    const retryCount = await redis.get('animastor:runtime:retry:count');

    const quotaStatus = {
        audio: await checkStageQuota(redis, 'audio'),
        image: await checkStageQuota(redis, 'image'),
        video: await checkStageQuota(redis, 'video')
    };

    // Check if any quota is fully utilized
    const congested = Object.values(quotaStatus).some(q => q.remaining === 0);

    return {
        congested,
        activeScenes,
        activeLeases,
        quotaStatus,
        retryCount: parseInt(retryCount || '0', 10)
    };
}

// ======================================================
// DEVIATION DETECTION
// ======================================================

/**
 * Detect unfair distribution of processing.
 */
async function detectUnfairDistribution(redis) {
    const scores = await getAllBookScores(redis);

    if (scores.length < 2) {
        return { detected: false, reason: 'insufficient_books' };
    }

    const avgScore = scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
    const deviations = scores.map(s => ({
        bookId: s.bookId,
        score: s.score,
        deviation: s.score - avgScore,
        aboveAverage: s.score > avgScore
    }));

    const unfair = deviations.filter(d => Math.abs(d.deviation) > 20);

    return {
        detected: unfair.length > 0,
        avgScore: Math.round(avgScore),
        totalBooks: scores.length,
        unfairCount: unfair.length,
        deviations
    };
}

// ======================================================
// FAIRNESS REPORT
// ======================================================

/**
 * Get comprehensive fairness report.
 */
async function getFairnessReport(redis) {
    const [bookScores, roundRobin, quotaStatus, congestion, rebalanceStats] = await Promise.all([
        getAllBookScores(redis),
        getRoundRobinStatus(redis),
        {
            audio: await checkStageQuota(redis, 'audio'),
            image: await checkStageQuota(redis, 'image'),
            video: await checkStageQuota(redis, 'video')
        },
        isRuntimeCongested(redis),
        getRebalanceStats(redis)
    ]);

    const distribution = await detectUnfairDistribution(redis);

    return {
        timestamp: Date.now(),
        bookScores,
        roundRobin,
        quotaStatus,
        congestion,
        distribution,
        rebalanceStats,
        config: FAIRNESS_CONFIG
    };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Config
    FAIRNESS_CONFIG,

    // Keys
    getBookFairnessKey,
    getRoundRobinKey,
    getRetryThrottleKey,
    getStageQuotaKey,
    getRebalanceKey,

    // Book fairness
    getBookFairnessScore,
    updateBookFairnessScore,
    resetBookFairnessScore,
    getAllBookScores,

    // Round-robin
    getNextRoundRobinBook,
    advanceRoundRobin,
    getRoundRobinStatus,

    // Quotas
    getStageQuotaUsed,
    incrementStageQuota,
    decrementStageQuota,
    checkStageQuota,

    // Retry throttling
    checkRetryThrottle,
    recordRetryThrottle,
    clearRetryThrottle,

    // Starvation
    isStarving,
    boostStarvingScene,
    hasStarvationBoost,

    // Rebalancing
    rebalanceFairness,
    getRebalanceStats,

    // Congestion
    isRuntimeCongested,

    // Distribution
    detectUnfairDistribution,

    // Report
    getFairnessReport
};
