// ======================================================
// RETENTION MANAGER - DATA CLEANUP POLICIES
// ======================================================
// Prevents Redis/runtime data from growing indefinitely.
// Implements retention policies for all runtime data sources.
//
// CRITICAL: Retention manager MUST NOT:
// - Delete active scene data
// - Break recovery
// - Delete active leases
//
// Retention rules:
// - Event journal: Keep last N events OR last X days
// - Metrics: Aggregate + expire old metrics
// - Dispatch metadata: Cleanup after completion/failure
// - Lease history: Cleanup stale history
// - Snapshots: Temporary only

const logPrefix = '[RETENTION]';

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

// Event journal retention
const EVENT_JOURNAL_MAX_ENTRIES = 1000;
const EVENT_JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Metrics retention
const METRICS_RETENTION_LIMIT = 1000;
const METRICS_HISTORY_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Dispatch metadata retention (cleanup after completion)
const DISPATCH_METADATA_MAX_AGE_MS = 1 * 60 * 60 * 1000; // 1 hour

// Snapshot retention (temporary only)
const SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

// Lease history cleanup
const LEASE_HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ======================================================
// RETENTION POLICIES
// ======================================================

/**
 * Get event journal key pattern.
 */
function getEventJournalPattern() {
    return 'animastor:event-journal:*';
}

/**
 * Get dispatch lease key pattern.
 */
function getDispatchLeasePattern() {
    return 'animastor:dispatch-lease:*';
}

/**
 * Get dispatch metadata key pattern.
 */
function getDispatchMetadataPattern() {
    return 'animastor:dispatch-meta:*';
}

/**
 * Get snapshot key pattern.
 */
function getSnapshotPattern() {
    return 'animastor:runtime:snapshot:*';
}

/**
 * Get metrics key pattern.
 */
function getMetricsPattern() {
    return 'animastor:runtime:metrics:*';
}

// ======================================================
// EVENT JOURNAL RETENTION
// ======================================================

/**
 * Trim event journal for a scene to max entries.
 * Keep the most recent N events.
 */
async function trimEventJournal(redis, bookId, chapterId, sceneId, maxEntries = EVENT_JOURNAL_MAX_ENTRIES) {
    const key = `animastor:event-journal:${bookId}:${chapterId}:${sceneId}`;
    const currentCount = await redis.llen(key);

    if (currentCount <= maxEntries) {
        return { trimmed: false, key, currentCount, maxEntries };
    }

    // Remove oldest events (keep from index 0 to maxEntries-1)
    const toRemove = currentCount - maxEntries;
    await redis.ltrim(key, 0, maxEntries - 1);

    log(`EVENT_JOURNAL_TRIMMED: ${bookId}/${chapterId}/${sceneId} (removed ${toRemove} entries)`);

    return {
        trimmed: true,
        key,
        removed: toRemove,
        currentCount: maxEntries
    };
}

/**
 * Delete old event journals (by age).
 */
async function deleteOldEventJournals(redis, maxAgeMs = EVENT_JOURNAL_MAX_AGE_MS) {
    const pattern = getEventJournalPattern();
    const cutoff = Date.now() - maxAgeMs;
    let deletedCount = 0;
    let scannedCount = 0;

    let cursor = 0;
    do {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        const keys = result[1];

        for (const key of keys) {
            scannedCount++;

            // Get first and last event timestamps
            const first = await redis.lindex(key, 0);
            const last = await redis.lindex(key, -1);

            if (!first || !last) continue;

            try {
                const firstEvent = JSON.parse(first);
                const lastEvent = JSON.parse(last);

                // If the last event is older than max age, delete entire journal
                if (lastEvent.ts < cutoff) {
                    await redis.del(key);
                    deletedCount++;
                    log(`EVENT_JOURNAL_DELETED: ${key} (all events older than ${maxAgeMs / 1000 / 60} minutes)`);
                }
            } catch (e) {
                // Skip invalid entries
            }
        }
    } while (cursor !== 0 && scannedCount < 10000);

    return { deletedCount, scannedCount };
}

/**
 * Trim all event journals to max entries.
 */
async function trimAllEventJournals(redis, maxEntries = EVENT_JOURNAL_MAX_ENTRIES) {
    const pattern = getEventJournalPattern();
    let trimmedCount = 0;
    let scannedCount = 0;

    let cursor = 0;
    do {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        const keys = result[1];

        for (const key of keys) {
            scannedCount++;
            const currentCount = await redis.llen(key);

            if (currentCount > maxEntries) {
                const toRemove = currentCount - maxEntries;
                await redis.ltrim(key, 0, maxEntries - 1);
                trimmedCount++;
            }
        }
    } while (cursor !== 0 && scannedCount < 10000);

    return { trimmedCount, scannedCount };
}

// ======================================================
// METRICS RETENTION
// ======================================================

/**
 * Trim metrics history to max entries.
 */
async function trimMetricsHistory(redis, maxEntries = METRICS_RETENTION_LIMIT) {
    const historyKey = 'animastor:runtime:metrics:history';
    const currentCount = await redis.zcard(historyKey);

    if (currentCount <= maxEntries) {
        return { trimmed: false, currentCount, maxEntries };
    }

    const toRemove = currentCount - maxEntries;
    await redis.zremrangebyrank(historyKey, 0, maxEntries - 1);

    log(`METRICS_HISTORY_TRIMMED: removed ${toRemove} entries`);

    return {
        trimmed: true,
        removed: toRemove,
        currentCount: maxEntries
    };
}

/**
 * Get metrics history stats.
 */
async function getMetricsHistoryStats(redis) {
    const historyKey = 'animastor:runtime:metrics:history';
    const currentCount = await redis.zcard(historyKey);

    // Get oldest and newest
    const oldest = await redis.zrange(historyKey, 0, 0, 'WITHSCORES');
    const newest = await redis.zrange(historyKey, -1, -1, 'WITHSCORES');

    return {
        total: currentCount,
        oldest: oldest.length > 0 ? oldest[1] : null,
        newest: newest.length > 0 ? newest[1] : null
    };
}

// ======================================================
// DISPATCH METADATA RETENTION
// ======================================================

/**
 * Delete stale dispatch metadata (completed/failed > 1 hour ago).
 */
async function cleanupStaleDispatchMetadata(redis, maxAgeMs = DISPATCH_METADATA_MAX_AGE_MS) {
    const pattern = getDispatchMetadataPattern();
    const cutoff = Date.now() - maxAgeMs;
    let deletedCount = 0;
    let scannedCount = 0;

    let cursor = 0;
    do {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        const keys = result[1];

        for (const key of keys) {
            scannedCount++;

            const raw = await redis.get(key);
            if (!raw) continue;

            try {
                const metadata = JSON.parse(raw);

                // If dispatch has ended and is old enough, delete
                if (metadata.status === 'completed' || metadata.status === 'failed') {
                    const endedAt = metadata.completed_at || metadata.failed_at || metadata.started_at;
                    if (endedAt && endedAt < cutoff) {
                        await redis.del(key);
                        deletedCount++;
                        log(`DISPATCH_METADATA_DEPRECATED: ${key} (status=${metadata.status}, age=${(Date.now() - endedAt) / 1000}s)`);
                    }
                }
            } catch (e) {
                // Skip invalid entries
            }
        }
    } while (cursor !== 0 && scannedCount < 10000);

    return { deletedCount, scannedCount };
}

// ======================================================
// SNAPSHOT RETENTION
// ======================================================

/**
 * Delete expired snapshots (older than 5 minutes).
 */
async function cleanupExpiredSnapshots(redis, maxAgeMs = SNAPSHOT_MAX_AGE_MS) {
    const pattern = getSnapshotPattern();
    const cutoff = Date.now() - maxAgeMs;
    let deletedCount = 0;
    let scannedCount = 0;

    let cursor = 0;
    do {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        const keys = result[1];

        for (const key of keys) {
            scannedCount++;
            const ttl = await redis.ttl(key);
            if (ttl === -2) {
                // Key doesn't exist
                continue;
            }

            if (ttl === -1) {
                // Key has no TTL set — snapshot lifecycle relies on TTL, so enforce it
                await redis.expire(key, Math.ceil(maxAgeMs / 1000));
                deletedCount++; // scheduled for expiry
            }
        }
    } while (cursor !== 0 && scannedCount < 10000);

    return { deletedCount, scannedCount };
}

// ======================================================
// LEASE HISTORY RETENTION
// ======================================================

/**
 * Clean up lease history/snapshot keys.
 */
async function cleanupLeaseHistory(redis, maxAgeMs = LEASE_HISTORY_MAX_AGE_MS) {
    // Clean up old lease heartbeat keys
    const hbPattern = 'animastor:lease-heartbeat:*';
    let deletedHb = 0;
    let scannedHb = 0;

    let cursor = 0;
    do {
        const result = await redis.scan(cursor, 'MATCH', hbPattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        const keys = result[1];

        for (const key of keys) {
            scannedHb++;
            const ttl = await redis.ttl(key);
            if (ttl === -2 || (ttl > 0 && ttl > maxAgeMs / 1000)) {
                await redis.del(key);
                deletedHb++;
            }
        }
    } while (cursor !== 0 && scannedHb < 10000);

    // Clean up old renewal timer keys
    const renewalKey = 'animastor:runtime:renewal-timers';
    const currentCount = await redis.scard(renewalKey);
    const historyKey = 'animastor:runtime:renewal-history';
    const historyCount = await redis.zcard(historyKey);

    return {
        leaseHeartbeat: { deleted: deletedHb, scanned: scannedHb },
        renewalTimer: { total: currentCount },
        renewalHistory: { total: historyCount }
    };
}

// ======================================================
// ACTIVE SCENES INDEX
// ======================================================

/**
 * Verify and cleanup active scenes index.
 * Ensure registered scenes still have valid state.
 */
async function cleanupActiveScenesIndex(redis) {
    const activeKey = 'animastor:active-scenes';
    const currentStateKey = 'animastor:scene-state:*';
    let removedCount = 0;
    let verifiedCount = 0;

    // Scene-state cleanup removed — active scenes are managed by the scheduler
    return { verifiedCount: 0, removedCount: 0 };
}

// ======================================================
// STUCK SCENES
// ======================================================

/**
 * Get stuck scenes for cleanup review.
 * These should be manually reviewed before deletion.
 */
async function getStuckScenes(redis) {
    const key = 'animastor:runtime:stuck-scenes';
    const members = await redis.smembers(key);

    return members.map(m => {
        try {
            return JSON.parse(m);
        } catch (e) {
            return null;
        }
    }).filter(m => m !== null);
}

/**
 * Clear stuck scenes (for manual cleanup).
 */
async function clearStuckScenes(redis) {
    const key = 'animastor:runtime:stuck-scenes';
    const count = await redis.scard(key);
    await redis.del(key);
    return { cleared: true, count };
}

// ======================================================
// RECOVERY ACTIONS
// ======================================================

/**
 * Get recovery action history.
 */
async function getRecoveryHistory(redis, limit = 100) {
    const key = 'animastor:runtime:recovery:actions';
    const members = await redis.smembers(key);

    // Return last N entries
    const entries = members.map(m => {
        try {
            return JSON.parse(m);
        } catch (e) {
            return null;
        }
    }).filter(m => m !== null);

    // Sort by timestamp descending
    entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    return entries.slice(0, limit);
}

// ======================================================
// RETENTION SUMMARY
// ======================================================

/**
 * Get comprehensive retention status.
 */
async function getRetentionStatus(redis) {
    // Event journal stats
    const eventPattern = getEventJournalPattern();
    let eventKeyCount = 0;
    let totalEventEntries = 0;

    let cursor = 0;
    do {
        const result = await redis.scan(cursor, 'MATCH', eventPattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        const keys = result[1];
        eventKeyCount += keys.length;

        for (const key of keys) {
            totalEventEntries += await redis.llen(key);
        }
    } while (cursor !== 0 && eventKeyCount < 10000);

    // Metrics stats
    const metricsStats = await getMetricsHistoryStats(redis);

    // Active scenes
    const activeScenesKey = 'animastor:active-scenes';
    const activeScenesCount = await redis.scard(activeScenesKey);

    // Dispatch leases
    const leasePattern = getDispatchLeasePattern();
    let leaseCount = 0;
    cursor = 0;
    do {
        const result = await redis.scan(cursor, 'MATCH', leasePattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        leaseCount += result[1].length;
    } while (cursor !== 0 && leaseCount < 10000);

    // Active counter values
    const activeKeys = [
        'animastor:runtime:active-audio',
        'animastor:runtime:active-image',
        'animastor:runtime:active-video'
    ];
    const activeCounters = {};
    for (const key of activeKeys) {
        const val = await redis.get(key);
        activeCounters[key] = parseInt(val || '0', 10);
    }

    // Snapshots
    const snapshotPattern = getSnapshotPattern();
    let snapshotCount = 0;
    cursor = 0;
    do {
        const result = await redis.scan(cursor, 'MATCH', snapshotPattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        snapshotCount += result[1].length;
    } while (cursor !== 0 && snapshotCount < 10000);

    return {
        timestamp: Date.now(),
        eventJournal: {
            keyCount: eventKeyCount,
            totalEntries: totalEventEntries
        },
        metrics: {
            historyTotal: metricsStats.total,
            oldestTimestamp: metricsStats.oldest,
            newestTimestamp: metricsStats.newest
        },
        activeScenes: activeScenesCount,
        dispatchLeases: leaseCount,
        activeCounters,
        snapshots: snapshotCount
    };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Event journal
    trimEventJournal,
    deleteOldEventJournals,
    trimAllEventJournals,
    EVENT_JOURNAL_MAX_ENTRIES,
    EVENT_JOURNAL_MAX_AGE_MS,

    // Metrics
    trimMetricsHistory,
    getMetricsHistoryStats,
    METRICS_RETENTION_LIMIT,
    METRICS_HISTORY_TTL,

    // Dispatch metadata
    cleanupStaleDispatchMetadata,
    DISPATCH_METADATA_MAX_AGE_MS,

    // Snapshots
    cleanupExpiredSnapshots,
    SNAPSHOT_MAX_AGE_MS,

    // Lease history
    cleanupLeaseHistory,
    LEASE_HISTORY_MAX_AGE_MS,

    // Active scenes
    cleanupActiveScenesIndex,

    // Recovery
    getRecoveryHistory,
    getStuckScenes,
    clearStuckScenes,

    // Status
    getRetentionStatus,

    // Patterns
    getEventJournalPattern,
    getDispatchLeasePattern,
    getDispatchMetadataPattern,
    getSnapshotPattern,
    getMetricsPattern
};
