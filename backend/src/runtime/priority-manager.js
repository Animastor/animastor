// ======================================================
// PRIORITY MANAGER - SCENE PRIORITY SCHEDULING
// ======================================================
// Implements priority scheduling for scene dispatch.
// Ensures important scenes get processed first.
//
// PRIORITY LEVELS:
// - HIGH: manual priority, critical content
// - NORMAL: default priority
// - LOW: background, lower urgency
//
// PRIORITY FACTORS:
// - manual priority override
// - retry age (older retries get boost)
// - starvation age (long wait = boost)
// - scene size (smaller scenes faster)
// - runtime congestion (light load = more priority)

const state = require('../state');

const logPrefix = '[PRIORITY]';

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
// PRIORITY LEVELS
// ======================================================

const PriorityLevel = {
    HIGH: 'high',
    NORMAL: 'normal',
    LOW: 'low'
};

const PRIORITY_SCORES = {
    [PriorityLevel.HIGH]: 100,
    [PriorityLevel.NORMAL]: 50,
    [PriorityLevel.LOW]: 10
};

// ======================================================
// PRIORITY CONFIG
// ======================================================

const PRIORITY_CONFIG = {
    // Starvation thresholds (minutes)
    starvationThreshold: 5,
    boostedPriorityTimeout: 2, // minutes

    // Scoring factors
    baseScore: 50,
    retryAgeBoost: 5, // +5 per minute of retry age
    starvationBoost: 30, // bonus when starved
    sizeFactor: 0.1, // smaller scenes get slight boost

    // Priority keys
    manualPriorityKey: 'animastor:priority:manual',
    scenePriorityKey: 'animastor:priority:scene'
};

// ======================================================
// PRIORITY KEYS
// ======================================================

/**
 * Get manual priority key.
 */
function getManualPriorityKey(bookId, chapterId, sceneId) {
    return `${PRIORITY_CONFIG.manualPriorityKey}:${bookId}:${chapterId}:${sceneId}`;
}

/**
 * Get scene priority storage key.
 */
function getScenePriorityKey(bookId, chapterId, sceneId) {
    return `${PRIORITY_CONFIG.scenePriorityKey}:${bookId}:${chapterId}:${sceneId}`;
}

/**
 * Get priority queue sorted set key.
 */
function getPriorityQueueKey() {
    return 'animastor:priority:queue';
}

// ======================================================
// PRIORITY SETUP
// ======================================================

/**
 * Set manual priority for a scene.
 */
async function setManualPriority(redis, bookId, chapterId, sceneId, level) {
    const key = getManualPriorityKey(bookId, chapterId, sceneId);
    await redis.set(key, level, 'EX', 86400); // 24 hour TTL

    log(`MANUAL_PRIORITY_SET: ${bookId}/${chapterId}/${sceneId} = ${level}`);

    return { set: true, level };
}

/**
 * Get manual priority for a scene.
 */
async function getManualPriority(redis, bookId, chapterId, sceneId) {
    const key = getManualPriorityKey(bookId, chapterId, sceneId);
    return await redis.get(key);
}

/**
 * Calculate effective priority score.
 */
async function calculatePriorityScore(redis, bookId, chapterId, sceneId, sceneData) {
    let score = PRIORITY_CONFIG.baseScore;

    // Check manual priority
    const manualLevel = await getManualPriority(redis, bookId, chapterId, sceneId);
    if (manualLevel) {
        score += PRIORITY_SCORES[manualLevel] - PRIORITY_SCORES[PriorityLevel.NORMAL];
        log(`SCORE: manual_priority=${manualLevel}, score adjustment: ${PRIORITY_SCORES[manualLevel] - PRIORITY_SCORES[PriorityLevel.NORMAL]}`);
    }

    // Check retry age (older retries get boost)
    const retryBudgetKey = `animastor:retry-budget:${bookId}:${chapterId}:${sceneId}:audio`;
    const retryData = await redis.get(`animastor:runtime:retry:${bookId}:${chapterId}:${sceneId}:audio:last-attempt`);
    if (retryData) {
        const lastRetry = parseInt(retryData, 10);
        const retryAge = (Date.now() - lastRetry) / 60000; // minutes
        if (retryAge > 0) {
            const boost = Math.min(50, Math.floor(retryAge * PRIORITY_CONFIG.retryAgeBoost));
            score += boost;
            log(`SCORE: retry_age=${retryAge.toFixed(1)}m, boost=${boost}`);
        }
    }

    // Check starvation
    const stateData = await state.getSceneState(redis, bookId, chapterId, sceneId);
    if (stateData) {
        const ageMinutes = (Date.now() - (stateData.updated_at || Date.now())) / 60000;
        if (ageMinutes > PRIORITY_CONFIG.starvationThreshold) {
            const starvationBoost = PRIORITY_CONFIG.starvationBoost;
            score += starvationBoost;
            log(`SCORE: starvation detected (${ageMinutes.toFixed(1)}m), boost=${starvationBoost}`);
        }
    }

    // Scene size factor (smaller = faster = slightly higher priority)
    // This is approximate - would need scene content size
    if (sceneData && sceneData.unit_count) {
        const sizeScore = Math.max(0, PRIORITY_CONFIG.sizeFactor * (100 - sceneData.unit_count));
        score += sizeScore;
    }

    return Math.max(0, Math.min(200, Math.floor(score)));
}

/**
 * Get priority level from score.
 */
function getPriorityLevelFromScore(score) {
    if (score >= 80) return PriorityLevel.HIGH;
    if (score >= 50) return PriorityLevel.NORMAL;
    return PriorityLevel.LOW;
}

// ======================================================
// PRIORITY QUEUE MANAGEMENT
// ======================================================

/**
 * Add scene to priority queue.
 */
async function addToPriorityQueue(redis, bookId, chapterId, sceneId, score) {
    const queueKey = getPriorityQueueKey();
    const timestamp = Date.now();

    // Score: negative so higher scores come first
    const negativeScore = -score;

    await redis.zadd(queueKey, negativeScore, JSON.stringify({
        bookId,
        chapterId,
        sceneId,
        score,
        timestamp,
        addedAt: Date.now()
    }));

    // Trim queue to max 10000 scenes
    const count = await redis.zcard(queueKey);
    if (count > 10000) {
        await redis.zremrangebyrank(queueKey, 0, count - 10001);
    }

    log(`QUEUE_ADD: ${bookId}/${chapterId}/${sceneId} (score=${score})`);

    return { added: true, score, queueCount: await redis.zcard(queueKey) };
}

/**
 * Remove scene from priority queue.
 */
async function removeFromPriorityQueue(redis, bookId, chapterId, sceneId) {
    const queueKey = getPriorityQueueKey();

    // Find and remove by member value
    const members = await redis.zrange(queueKey, 0, -1);
    for (const member of members) {
        try {
            const entry = JSON.parse(member);
            if (entry.bookId === bookId && entry.chapterId === chapterId && entry.sceneId === sceneId) {
                await redis.zrem(queueKey, member);
                log(`QUEUE_REMOVE: ${bookId}/${chapterId}/${sceneId}`);
                return { removed: true, member };
            }
        } catch (e) {
            // Skip invalid entries
        }
    }

    return { removed: false, reason: 'not_found' };
}

/**
 * Get top scenes from priority queue.
 */
async function getTopFromPriorityQueue(redis, limit = 10) {
    const queueKey = getPriorityQueueKey();
    const total = await redis.zcard(queueKey);

    // Get lowest scores first (since we store negative scores)
    const members = await redis.zrange(queueKey, 0, limit - 1);

    const scenes = members.map(member => {
        try {
            const entry = JSON.parse(member);
            return {
                bookId: entry.bookId,
                chapterId: entry.chapterId,
                sceneId: entry.sceneId,
                score: entry.score,
                addedAt: entry.addedAt,
                age: Date.now() - (entry.addedAt || Date.now())
            };
        } catch (e) {
            return null;
        }
    }).filter(s => s !== null);

    return { total,scenes };
}

/**
 * Clear priority queue.
 */
async function clearPriorityQueue(redis) {
    const queueKey = getPriorityQueueKey();
    const count = await redis.zcard(queueKey);
    await redis.del(queueKey);
    return { cleared: true, count };
}

// ======================================================
// PRIORITY STATUS
// ======================================================

/**
 * Get priority status for a scene.
 */
async function getScenePriorityStatus(redis, bookId, chapterId, sceneId) {
    const manualPriority = await getManualPriority(redis, bookId, chapterId, sceneId);
    const score = await calculatePriorityScore(redis, bookId, chapterId, sceneId);

    // Check if in queue
    const inQueue = await isSceneInQueue(redis, bookId, chapterId, sceneId);

    return {
        bookId,
        chapterId,
        sceneId,
        manualPriority,
        calculatedScore: score,
        priorityLevel: getPriorityLevelFromScore(score),
        inQueue
    };
}

/**
 * Check if scene is in priority queue.
 */
async function isSceneInQueue(redis, bookId, chapterId, sceneId) {
    const queueKey = getPriorityQueueKey();
    const members = await redis.zrange(queueKey, 0, -1);

    for (const member of members) {
        try {
            const entry = JSON.parse(member);
            if (entry.bookId === bookId && entry.chapterId === chapterId && entry.sceneId === sceneId) {
                return true;
            }
        } catch (e) {
            // Skip
        }
    }
    return false;
}

/**
 * Get queue statistics.
 */
async function getQueueStats(redis) {
    const queueKey = getPriorityQueueKey();
    const total = await redis.zcard(queueKey);

    if (total === 0) {
        return { total: 0, high: 0, normal: 0, low: 0, averageScore: 0 };
    }

    const members = await redis.zrange(queueKey, 0, -1);
    let high = 0;
    let normal = 0;
    let low = 0;
    let totalScore = 0;

    for (const member of members) {
        try {
            const entry = JSON.parse(member);
            const score = entry.score;
            totalScore += score;

            if (score >= 80) high++;
            else if (score >= 50) normal++;
            else low++;
        } catch (e) {
            // Skip
        }
    }

    return {
        total,
        high,
        normal,
        low,
        averageScore: Math.round(totalScore / total)
    };
}

// ======================================================
// PRIORITY BOOST
// ======================================================

/**
 * Boost priority for a scene.
 */
async function boostPriority(redis, bookId, chapterId, sceneId, amount = 20) {
    const scoreKey = getScenePriorityKey(bookId, chapterId, sceneId);
    const current = await redis.get(scoreKey);
    const currentScore = parseInt(current || '0', 10);
    const newScore = currentScore + amount;

    await redis.set(scoreKey, newScore.toString(), 'EX', 300); // 5 minute TTL

    log(`PRIORITY_BOOST: ${bookId}/${chapterId}/${sceneId}: ${currentScore} -> ${newScore}`);

    return { boosted: true, from: currentScore, to: newScore };
}

/**
 * Reset priority boost.
 */
async function resetPriorityBoost(redis, bookId, chapterId, sceneId) {
    const scoreKey = getScenePriorityKey(bookId, chapterId, sceneId);
    await redis.del(scoreKey);

    log(`PRIORITY_BOOST_RESET: ${bookId}/${chapterId}/${sceneId}`);

    return { reset: true };
}

// ======================================================
// PRIORITY CATEGORIES
// ======================================================

/**
 * Categorize scenes by priority needs.
 */
async function categorizeByPriority(redis, scenes) {
    const categories = {
        highPriority: [],
        needsBoost: [],
        normal: [],
        lowPriority: []
    };

    for (const scene of scenes) {
        const status = await getScenePriorityStatus(redis, scene.bookId, scene.chapterId, scene.sceneId);
        score = status.calculatedScore;

        if (score >= 80) {
            categories.highPriority.push(scene);
        } else if (score >= 60) {
            categories.needsBoost.push(scene);
        } else if (score >= 40) {
            categories.normal.push(scene);
        } else {
            categories.lowPriority.push(scene);
        }
    }

    return categories;
}

// ======================================================
// DEBUG: Get all priorities
// ======================================================

/**
 * Get all scene priorities.
 */
async function getAllPriorities(redis) {
    const pattern = getScenePriorityKey('*', '*', '*');
    const keys = [];
    const all = [];

    let cursor = 0;
    do {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        keys.push(...result[1]);
    } while (cursor !== 0 && keys.length < 10000);

    for (const key of keys) {
        const value = await redis.get(key);
        try {
            const parts = key.split(':');
            all.push({
                bookId: parts[3],
                chapterId: parts[4],
                sceneId: parts[5],
                score: parseInt(value || '0', 10),
                key
            });
        } catch (e) {
            // Skip
        }
    }

    // Sort by score
    all.sort((a, b) => b.score - a.score);

    return all;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    PriorityLevel,
    PRIORITY_LEVELS: PriorityLevel,
    PRIORITY_SCORES,

    PRIORITY_CONFIG,

    // Keys
    getManualPriorityKey,
    getScenePriorityKey,
    getPriorityQueueKey,

    // Priority management
    setManualPriority,
    getManualPriority,
    calculatePriorityScore,
    getPriorityLevelFromScore,

    // Queue management
    addToPriorityQueue,
    removeFromPriorityQueue,
    getTopFromPriorityQueue,
    clearPriorityQueue,
    isSceneInQueue,
    getQueueStats,

    // Boost
    boostPriority,
    resetPriorityBoost,

    // Analysis
    categorizeByPriority,
    getAllPriorities
};
