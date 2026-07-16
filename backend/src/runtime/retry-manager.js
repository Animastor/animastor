// ======================================================
// RETRY MANAGER - RETRY CLASSIFICATION AND POLICIES
// ======================================================
// Handles retry decisions, backoff calculation, and retry metadata tracking.
// Uses Failure Taxonomy for classification.

const failureTaxonomy = require('./failure-taxonomy');
const journal = require('../orchestration/event-journal');
const dispatchEngine = require('./dispatch-engine');

const logPrefix = '[RETRY]';

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
// CONSTANTS
// ======================================================

const RETRY_KEY_PREFIX = 'animastor:runtime:retry';
const RETRY_COUNT_KEY = `${RETRY_KEY_PREFIX}:count`;
const RETRY_EVENT_KEY = 'animastor:runtime:retry-history';

// ======================================================
// RETRY TRACKING
// ======================================================

/**
 * Get retry count for a scene:stage.
 */
function getRetryCountKey(bookId, chapterId, sceneId, stage) {
    return `${RETRY_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}:${stage}`;
}

/**
 * Get total retry count key.
 */
function getTotalRetryCountKey() {
    return RETRY_COUNT_KEY;
}

/**
 * Get retry event key (sorted set for history).
 */
function getRetryEventKey() {
    return RETRY_EVENT_KEY;
}

// ======================================================
// RETRY DECISION LOGIC
// ======================================================

/**
 * Should we attempt a retry for this error?
 * Returns: { shouldRetry, policy, reason }
 */
function shouldRetry(error) {
    const classification = failureTaxonomy.classifyFailure(error);
    const policy = failureTaxonomy.getRetryPolicy(classification.type);

    const result = {
        shouldRetry: classification.retryable,
        failureType: classification.type,
        severity: classification.severity,
        message: classification.message,
        policy: policy
    };

    if (!classification.retryable) {
        log(`RETRY_SKIPPED: ${classification.type} (permanent or needs reconciliation)`);
    } else {
        log(`RETRY_SCHEDULED: ${classification.type} (backoff: ${policy.backoffMs}ms, max: ${policy.maxRetries})`);
    }

    return result;
}

/**
 * Check if retry is allowed for failure type.
 */
function isRetryAllowed(failureType) {
    const policy = failureTaxonomy.getRetryPolicy(failureType);
    return policy.maxRetries > 0;
}

/**
 * Check if retry requires reconciliation first.
 */
function requiresReconciliation(failureType) {
    const policy = failureTaxonomy.getRetryPolicy(failureType);
    return !!policy.requiresReconciliation;
}

// ======================================================
// RETRY METADATA TRACKING
// ======================================================

/**
 * Track retry attempt in Redis.
 */
async function trackRetryAttempt(redis, bookId, chapterId, sceneId, stage, error, attempt) {
    const key = getRetryCountKey(bookId, chapterId, sceneId, stage);
    const classification = failureTaxonomy.classifyFailure(error);
    const policy = failureTaxonomy.getRetryPolicy(classification.type);
    const backoff = failureTaxonomy.calculateBackoff(policy, attempt);

    // Increment retry count
    await redis.incr(key);

    // Track total retries
    await redis.incr(getTotalRetryCountKey());

    // Log retry event to history (sorted set with timestamp)
    const eventKey = getRetryEventKey();
    const event = {
        bookId,
        chapterId,
        sceneId,
        stage,
        attempt,
        failureType: classification.type,
        severity: classification.severity,
        message: classification.message.slice(0, 200),
        scheduledBackoffMs: backoff,
        timestamp: Date.now()
    };

    await redis.zadd(eventKey, Date.now(), JSON.stringify(event));

    // Trim history (keep last 1000 entries)
    const count = await redis.zcard(eventKey);
    if (count > 1000) {
        await redis.zremrangebyrank(eventKey, 0, count - 1001);
    }

    // Log to scene event journal
    await journal.appendSceneEvent(
        redis,
        bookId,
        chapterId,
        sceneId,
        'RETRY_SCHEDULED',
        stage,
        {
            attempt,
            failureType: classification.type,
            severity: classification.severity,
            backoffMs: backoff,
            message: classification.message
        }
    );

    log(`RETRY_TRACKED: ${bookId}/${chapterId}/${sceneId}:${stage} (attempt=${attempt}, backoff=${backoff}ms)`);

    return {
        tracked: true,
        attempt,
        backoff,
        policy
    };
}

/**
 * Get retry count for a scene:stage.
 */
async function getRetryCount(redis, bookId, chapterId, sceneId, stage) {
    const key = getRetryCountKey(bookId, chapterId, sceneId, stage);
    const count = await redis.get(key);
    return parseInt(count || '0', 10);
}

/**
 * Get total retry count across all scenes.
 */
async function getTotalRetryCount(redis) {
    const key = getTotalRetryCountKey();
    const count = await redis.get(key);
    return parseInt(count || '0', 10);
}

/**
 * Get retry history for a scene.
 */
async function getSceneRetryHistory(redis, bookId, chapterId, sceneId, limit = 50) {
    const eventKey = getRetryEventKey();
    const results = [];

    let cursor = 0;
    do {
        const result = await redis.zscan(cursor, 'MATCH', `*${bookId}:${chapterId}:${sceneId}*`, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        const entries = result[1];

        for (let i = 0; i < entries.length; i += 2) {
            const score = entries[i];
            const value = entries[i + 1];
            try {
                const event = JSON.parse(value);
                if (event.sceneId === sceneId) {
                    results.push({
                        score,
                        ...event
                    });
                }
            } catch (e) {
                // Skip invalid entries
            }
        }
    } while (cursor !== 0 && results.length < limit);

    // Sort by timestamp (descending)
    return results.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

/**
 * Get retry summary for a scene.
 */
async function getRetrySummary(redis, bookId, chapterId, sceneId) {
    const stages = ['audio', 'image', 'video'];
    const summary = {};

    for (const stage of stages) {
        const count = await getRetryCount(redis, bookId, chapterId, sceneId, stage);
        summary[stage] = {
            retryCount: count
        };
    }

    return summary;
}

// ======================================================
// RETRY SCHEDULING
// ======================================================

/**
 * Calculate when next retry should happen.
 */
function calculateNextRetryTime(policy, attempt) {
    const backoffMs = failureTaxonomy.calculateBackoff(policy, attempt);
    return {
        shouldRetryAt: Date.now() + backoffMs,
        backoffMs,
        description: policy.description
    };
}

/**
 * Check if retry cooldown has expired.
 */
async function isRetryCooldownExpired(redis, bookId, chapterId, sceneId, stage) {
    const retryKey = getRetryCountKey(bookId, chapterId, sceneId, stage);
    const lastRetryKey = `${retryKey}:last-attempt`;

    const lastAttempt = await redis.get(lastRetryKey);
    if (!lastAttempt) {
        return { expired: true, reason: 'no_previous_attempt' };
    }

    const lastAttemptAt = parseInt(lastAttempt, 10);
    const elapsed = Date.now() - lastAttemptAt;

    // Get the policy for what was being attempted
    const metadata = await dispatchEngine.getDispatchMetadata(
        redis,
        bookId,
        chapterId,
        sceneId,
        stage
    );

    let policy = null;
    if (metadata && metadata.failure_type) {
        policy = failureTaxonomy.getRetryPolicy(metadata.failure_type);
    } else {
        policy = failureTaxonomy.getRetryPolicy(failureTaxonomy.FailureType.TRANSIENT);
    }

    const backoff = failureTaxonomy.calculateBackoff(policy, metadata?.retry_attempt || 0);
    const remaining = backoff - elapsed;

    return {
        expired: remaining <= 0,
        remainingMs: Math.max(0, remaining),
        backoff,
        elapsedMs: elapsed
    };
}

/**
 * Mark retry attempt (sets last attempt timestamp).
 */
async function markRetryAttempted(redis, bookId, chapterId, sceneId, stage) {
    const retryKey = getRetryCountKey(bookId, chapterId, sceneId, stage);
    const lastRetryKey = `${retryKey}:last-attempt`;

    // Increment retry count
    await redis.incr(retryKey);
    await redis.incr(getTotalRetryCountKey());

    // Set last attempt timestamp
    await redis.set(lastRetryKey, Date.now().toString(), 'EX', 3600); // 1 hour TTL

    log(`RETRY_ATTEMPT: ${bookId}/${chapterId}/${sceneId}:${stage}`);

    return { attempted: true, retryKey, lastRetryKey };
}

// ======================================================
// RETRY METRICS
// ======================================================

/**
 * Get retry metrics.
 */
async function getRetryMetrics(redis) {
    const totalRetries = await getTotalRetryCount(redis);

    // Get retries by type
    const typeKeys = failureTaxonomy.getFailureTypeKeys();
    const byType = {};

    for (const type of typeKeys) {
        const key = `${RETRY_KEY_PREFIX}:type:${type}`;
        const count = await redis.get(key);
        byType[type] = parseInt(count || '0', 10);
    }

    // Get retry history stats
    const historyKey = getRetryEventKey();
    const totalHistory = await redis.zcard(historyKey);

    // Get most recent retries (WITHSCORES → [member, score, ...] pairs)
    const recentRetries = await redis.zrange(historyKey, -10, -1, 'WITHSCORES');
    const history = [];
    for (let i = 0; i < recentRetries.length; i += 2) {
        history.push({ event: recentRetries[i], timestamp: parseInt(recentRetries[i + 1], 10) });
    }

    return {
        totalRetries,
        byType,
        totalHistory,
        recentRetries: recentRetries.length / 2,
        history
    };
}

/**
 * Increment retry counter by type.
 */
async function incrementRetryByType(redis, failureType) {
    const key = `${RETRY_KEY_PREFIX}:type:${failureType}`;
    await redis.incr(key);

    // Also track by severity
    const severity = failureType === failureTaxonomy.FailureType.PERMANENT
        ? failureTaxonomy.FailureSeverity.HIGH
        : failureTaxonomy.FailureSeverity.LOW;

    const severityKey = `${RETRY_KEY_PREFIX}:type:${failureType}:${severity}`;
    await redis.incr(severityKey);
}

// ======================================================
// RETRY CLEANUP
// ======================================================

/**
 * Clear retry count for a scene:stage.
 * Used after successful completion.
 */
async function clearRetryCount(redis, bookId, chapterId, sceneId, stage) {
    const key = getRetryCountKey(bookId, chapterId, sceneId, stage);
    await redis.del(key);
    return { cleared: true, key };
}

/**
 * Clear all retry data for a scene.
 */
async function clearSceneRetryData(redis, bookId, chapterId, sceneId) {
    const stages = ['audio', 'image', 'video'];
    const cleared = [];

    for (const stage of stages) {
        const key = getRetryCountKey(bookId, chapterId, sceneId, stage);
        const deleted = await redis.del(key);
        cleared.push({ stage, deleted });
    }

    log(`RETRY_CLEARED: ${bookId}/${chapterId}/${sceneId} (${cleared.filter(c => c.deleted).length} keys)`);

    return { cleared, clearedCount: cleared.filter(c => c.deleted).length };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Decision logic
    shouldRetry,
    isRetryAllowed,
    requiresReconciliation,
    calculateNextRetryTime,
    isRetryCooldownExpired,

    // Tracking
    trackRetryAttempt,
    getRetryCount,
    getTotalRetryCount,
    getSceneRetryHistory,
    getRetrySummary,
    markRetryAttempted,
    clearRetryCount,
    clearSceneRetryData,

    // Metrics
    getRetryMetrics,
    incrementRetryByType,

    // Keys
    getRetryCountKey,
    getTotalRetryCountKey,
    getRetryEventKey,

    // Constants
    RETRY_KEY_PREFIX
};
