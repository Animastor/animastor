// ======================================================
// Runtime Persistence - v1.0.0
// ======================================================
// Ensures runtime state survives restarts.
// Persists critical state to Redis with atomic operations.
// Provides recovery mechanism on startup.

const state = require('../state');
const runtimeMetrics = require('./runtime-metrics');
const activeScenesIndex = require('./active-scenes-index');
const circuitBreaker = require('./circuit-breaker');
const journal = require('../orchestration/event-journal');

const logPrefix = '[PERSISTENCE]';

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
// PERSISTENCE CONFIGURATION
// ======================================================

const PERSISTENCE_CONFIG = {
    // Snapshot settings
    snapshotIntervalMs: 300000, // 5 minutes
    maxSnapshots: 10,
    snapshotTtlMs: 86400000, // 24 hours

    // Recovery settings
    recoveryBufferMs: 30000, // 30 seconds grace period
    recoveryTimeoutMs: 300000, // 5 minutes max recovery

    // Checkpoint settings
    checkpointIntervalMs: 60000, // 1 minute
    checkpointHistory: 50
};

// ======================================================
// PERSISTENCE KEY PATTERNS
// ======================================================

const PERSISTENCE_PREFIX = 'animastor:runtime:persistence';

const RUNTIME_SNAPSHOT_KEY = `${PERSISTENCE_PREFIX}:snapshot`;
const RUNTIME_CHECKPOINT_KEY = `${PERSISTENCE_PREFIX}:checkpoint`;
const RUNTIME_RECOVERY_KEY = `${PERSISTENCE_PREFIX}:recovery`;
const RUNTIME_METRICS_KEY = `${PERSISTENCE_PREFIX}:metrics`;
const RUNTIME_COUNTERS_KEY = `${PERSISTENCE_PREFIX}:counters`;
const RUNTIME_LEASES_KEY = `${PERSISTENCE_PREFIX}:leases`;
const RUNTIME_DISPATCH_KEY = `${PERSISTENCE_PREFIX}:dispatch`;
const RUNTIME_RETRY_KEY = `${PERSISTENCE_PREFIX}:retry`;
const RUNTIME_PRIORITY_KEY = `${PERSISTENCE_PREFIX}:priority`;

// TTL in seconds for Redis EX option
const SNAPSHOT_TTL_SEC = Math.ceil(PERSISTENCE_CONFIG.snapshotTtlMs / 1000);

/**
 * Collect all keys matching a pattern via SCAN (non-blocking, unlike KEYS).
 */
async function scanKeys(redis, pattern, limit = 10000) {
    const keys = [];
    let cursor = 0;
    do {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = parseInt(result[0], 10);
        keys.push(...result[1]);
    } while (cursor !== 0 && keys.length < limit);
    return keys;
}

// ======================================================
// RUNTIME STATE TYPES
// ======================================================

const RuntimeStateType = {
    SNAPSHOT: 'snapshot',
    CHECKPOINT: 'checkpoint',
    RECOVERY: 'recovery',
    METRICS: 'metrics',
    COUNTERS: 'counters',
    LEASES: 'leases',
    DISPATCH: 'dispatch',
    RETRY: 'retry',
    PRIORITY: 'priority'
};

// ======================================================
// RUNTIME SNAPSHOT - COMPLETE STATE SNAPSHOT
// ======================================================

/**
 * Generate runtime snapshot.
 * Captures complete runtime state at point in time.
 */
async function generateSnapshot(redis) {
    const timestamp = Date.now();

    // Get all active scenes
    const activeScenes = await activeScenesIndex.getActiveScenesDetail(redis);
    const activeCount = await activeScenesIndex.getActiveCount(redis);

    // Get active leases
    const leases = await getAllActiveLeases(redis);

    // Get dispatch metadata
    const dispatches = await getDispatchMetadata(redis);

    // Get retry state
    const retryState = await getRetryState(redis);

    // Get priority queue
    const priorityQueue = await getPriorityQueue(redis);

    // Get runtime counters
    const counters = await getRuntimeCounters(redis);

    // Get circuit breaker state
    const circuits = {
        audio: await circuitBreaker.checkDispatch(redis, 'audio'),
        image: await circuitBreaker.checkDispatch(redis, 'image'),
        video: await circuitBreaker.checkDispatch(redis, 'video')
    };

    const snapshot = {
        type: RuntimeStateType.SNAPSHOT,
        timestamp,
        version: '1.0',
        activeScenes,
        activeCount,
        leases,
        dispatches,
        retryState,
        priorityQueue,
        counters,
        circuits,
        metadata: {
            generatedAt: new Date().toISOString(),
            sceneCount: activeScenes.length,
            leaseCount: leases.length,
            dispatchCount: dispatches.length,
            retrySceneCount: retryState.scenes.length
        }
    };

    return snapshot;
}

/**
 * Store runtime snapshot.
 */
async function storeSnapshot(redis, snapshot) {
    const key = `${RUNTIME_SNAPSHOT_KEY}:${Date.now()}`;
    await redis.set(key, JSON.stringify(snapshot), 'EX', SNAPSHOT_TTL_SEC);

    // Maintain snapshot rotation
    const keys = await scanKeys(redis, `${RUNTIME_SNAPSHOT_KEY}:*`);
    if (keys.length > PERSISTENCE_CONFIG.maxSnapshots) {
        keys.sort(); // Sort by timestamp
        const toDelete = keys.slice(0, keys.length - PERSISTENCE_CONFIG.maxSnapshots);
        await redis.del(toDelete);
        log(`SNAPSHOT_ROTATED: deleted ${toDelete.length} old snapshots`);
    }

    return key;
}

/**
 * Get latest snapshot.
 */
async function getLatestSnapshot(redis) {
    const keys = await scanKeys(redis, `${RUNTIME_SNAPSHOT_KEY}:*`);
    if (keys.length === 0) return null;

    keys.sort();
    const latest = keys[keys.length - 1];
    const raw = await redis.get(latest);
    return raw ? JSON.parse(raw) : null;
}

// ======================================================
// RUNTIME CHECKPOINT - incremental state
// ======================================================

/**
 * Create checkpoint with scene states only.
 */
async function createCheckpoint(redis) {
    const timestamp = Date.now();

    const scenes = [];

    const checkpoint = {
        type: RuntimeStateType.CHECKPOINT,
        timestamp,
        version: '1.0',
        scenes,
        metadata: {
            sceneCount: scenes.length,
            savedAt: new Date().toISOString()
        }
    };

    // Store with timestamp suffix for rotation
    const key = `${RUNTIME_CHECKPOINT_KEY}:${timestamp}`;
    await redis.set(key, JSON.stringify(checkpoint), 'EX', SNAPSHOT_TTL_SEC);

    // Rotate checkpoints
    const keys = await scanKeys(redis, `${RUNTIME_CHECKPOINT_KEY}:*`);
    if (keys.length > PERSISTENCE_CONFIG.checkpointHistory) {
        keys.sort();
        const toDelete = keys.slice(0, keys.length - PERSISTENCE_CONFIG.checkpointHistory);
        await redis.del(toDelete);
    }

    return checkpoint;
}

/**
 * Get latest checkpoint.
 */
async function getLatestCheckpoint(redis) {
    const keys = await scanKeys(redis, `${RUNTIME_CHECKPOINT_KEY}:*`);
    if (keys.length === 0) return null;

    keys.sort();
    const latest = keys[keys.length - 1];
    const raw = await redis.get(latest);
    return raw ? JSON.parse(raw) : null;
}

// ======================================================
// RECOVERY STATE - scene states for recovery
// ======================================================

/**
 * Get recovery state for scene.
 */
async function getSceneRecoveryState(redis, bookId, chapterId, sceneId) {
    const key = `${RUNTIME_RECOVERY_KEY}:${bookId}:${chapterId}:${sceneId}`;
    const raw = await redis.get(key);
    if (!raw) return null;

    try {
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

/**
 * Store recovery state for scene.
 */
async function storeSceneRecoveryState(redis, bookId, chapterId, sceneId, state) {
    const key = `${RUNTIME_RECOVERY_KEY}:${bookId}:${chapterId}:${sceneId}`;
    await redis.set(key, JSON.stringify({
        ...state,
        storedAt: Date.now()
    }), 'EX', SNAPSHOT_TTL_SEC);
}

/**
 * Clear recovery state for scene.
 */
async function clearSceneRecoveryState(redis, bookId, chapterId, sceneId) {
    const key = `${RUNTIME_RECOVERY_KEY}:${bookId}:${chapterId}:${sceneId}`;
    await redis.del(key);
}

// ======================================================
// RUNTIME METRICS
// ======================================================

/**
 * Get runtime metrics.
 */
async function getRuntimeMetrics(redis) {
    const key = RUNTIME_METRICS_KEY;
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
}

/**
 * Store runtime metrics.
 */
async function storeRuntimeMetrics(redis, metrics) {
    const key = RUNTIME_METRICS_KEY;
    await redis.set(key, JSON.stringify({
        ...metrics,
        storedAt: Date.now()
    }), 'EX', SNAPSHOT_TTL_SEC);
}

// ======================================================
// RUNTIME COUNTERS
// ======================================================

/**
 * Get all runtime counters.
 */
async function getRuntimeCounters(redis) {
    const counterKeys = [
        'animastor:runtime:active-audio',
        'animastor:runtime:active-image',
        'animastor:runtime:active-video',
        'animastor:runtime:retry:count'
    ];

    const counters = {};
    const values = await redis.mget(...counterKeys);

    counterKeys.forEach((key, index) => {
        counters[key] = parseInt(values[index] || '0', 10);
    });

    return counters;
}

/**
 * Store runtime counters.
 */
async function storeRuntimeCounters(redis, counters) {
    const pipeline = redis.pipeline();

    Object.entries(counters).forEach(([key, value]) => {
        pipeline.set(key, value.toString(), 'EX', SNAPSHOT_TTL_SEC);
    });

    await pipeline.exec();
}

/**
 * Restore runtime counters.
 */
async function restoreRuntimeCounters(redis, counters) {
    const pipeline = redis.pipeline();

    Object.entries(counters).forEach(([key, value]) => {
        pipeline.set(key, value.toString());
    });

    await pipeline.exec();
}

// ======================================================
// ACTIVE LEASES
// ======================================================

/**
 * Get all active leases.
 */
async function getAllActiveLeases(redis) {
    const leases = [];
    const leaseKeys = await scanKeys(redis, 'animastor:dispatch-lease:*');

    for (const key of leaseKeys) {
        const token = await redis.get(key);
        if (token) {
            const parts = key.split(':');
            leases.push({
                key,
                bookId: parts[2],
                chapterId: parts[3],
                sceneId: parts[4],
                stage: parts[5],
                token,
                ttl: await redis.ttl(key)
            });
        }
    }

    return leases;
}

/**
 * Store active leases for recovery.
 */
async function storeActiveLeases(redis, leases) {
    const pipeline = redis.pipeline();

    leases.forEach(lease => {
        const key = `${RUNTIME_LEASES_KEY}:${lease.bookId}:${lease.chapterId}:${lease.sceneId}:${lease.stage}`;
        pipeline.set(key, JSON.stringify({
            ...lease,
            storedAt: Date.now()
        }), 'EX', SNAPSHOT_TTL_SEC);
    });

    await pipeline.exec();
}

// ======================================================
// DISPATCH METADATA
// ======================================================

/**
 * Get dispatch metadata.
 */
async function getDispatchMetadata(redis) {
    const dispatches = [];
    const metaKeys = await scanKeys(redis, 'animastor:dispatch-meta:*');

    for (const key of metaKeys) {
        const raw = await redis.get(key);
        if (raw) {
            try {
                const metadata = JSON.parse(raw);
                const parts = key.split(':');
                dispatches.push({
                    ...metadata,
                    bookId: parts[2],
                    chapterId: parts[3],
                    sceneId: parts[4],
                    stage: parts[5],
                    storedAt: Date.now()
                });
            } catch (e) {
                // Skip invalid entries
            }
        }
    }

    return dispatches;
}

/**
 * Store dispatch metadata.
 */
async function storeDispatchMetadata(redis, dispatches) {
    const pipeline = redis.pipeline();

    dispatches.forEach(d => {
        const key = `${RUNTIME_DISPATCH_KEY}:${d.bookId}:${d.chapterId}:${d.sceneId}:${d.stage}`;
        pipeline.set(key, JSON.stringify({
            ...d,
            storedAt: Date.now()
        }), 'EX', SNAPSHOT_TTL_SEC);
    });

    await pipeline.exec();
}

// ======================================================
// RETRY STATE
// ======================================================

/**
 * Get retry state.
 */
async function getRetryState(redis) {
    const scenes = [];
    const retryKeys = await scanKeys(redis, 'animastor:runtime:retry:*:count');

    for (const key of retryKeys) {
        const count = parseInt(await redis.get(key) || '0', 10);
        if (count > 0) {
            const parts = key.split(':');
            scenes.push({
                bookId: parts[2],
                chapterId: parts[3],
                sceneId: parts[4],
                retryCount: count,
                storedAt: Date.now()
            });
        }
    }

    return { scenes, count: scenes.length };
}

/**
 * Store retry state.
 */
async function storeRetryState(redis, retryState) {
    const pipeline = redis.pipeline();

    retryState.scenes.forEach(s => {
        const key = `${RUNTIME_RETRY_KEY}:${s.bookId}:${s.chapterId}:${s.sceneId}`;
        pipeline.set(key, JSON.stringify({
            ...s,
            storedAt: Date.now()
        }), 'EX', SNAPSHOT_TTL_SEC);
    });

    await pipeline.exec();
}

// ======================================================
// PRIORITY STATE
// ======================================================

/**
 * Get priority queue state.
 */
async function getPriorityQueue(redis) {
    const queue = [];
    const members = await redis.zrangebyscore('animastor:priority:queue', '-inf', '+inf', 'WITHSCORES');

    for (let i = 0; i < members.length; i += 2) {
        const sceneKey = members[i];
        const score = parseInt(members[i + 1], 10);
        const [bookId, chapterId, sceneId] = sceneKey.split(':');

        queue.push({
            bookId,
            chapterId,
            sceneId,
            score,
            storedAt: Date.now()
        });
    }

    return { queue, count: queue.length };
}

/**
 * Store priority queue state.
 */
async function storePriorityQueue(redis, priorityData) {
    const pipeline = redis.pipeline();

    priorityData.queue.forEach(q => {
        const key = `${RUNTIME_PRIORITY_KEY}:${q.bookId}:${q.chapterId}:${q.sceneId}`;
        pipeline.set(key, JSON.stringify({
            ...q,
            storedAt: Date.now()
        }), 'EX', SNAPSHOT_TTL_SEC);
    });

    await pipeline.exec();
}

// ======================================================
// RECOVERY - RESTORE STATE AFTER RESTART
// ======================================================

/**
 * Initiate runtime recovery.
 * Called on startup to restore runtime state.
 */
async function initiateRecovery(redis) {
    log('RECOVERY_INITIATED');

    const recoveryStart = Date.now();
    const recoveryId = `recovery-${recoveryStart}`;

    // Check for stale recovery
    const staleRecoveryKey = `${RUNTIME_RECOVERY_KEY}:stale`;
    const staleRecovery = await redis.get(staleRecoveryKey);

    if (staleRecovery) {
        const staleTime = parseInt(staleRecovery, 10);
        if (Date.now() - staleTime < PERSISTENCE_CONFIG.recoveryBufferMs) {
            warn(`RECOVERY_SKIPPED: recent recovery detected (${(Date.now() - staleTime) / 1000}s ago)`);
            return { success: false, reason: 'recent_recovery', recoveryId };
        }
    }

    // Set recovery marker
    const recoveryTtlSec = Math.ceil(PERSISTENCE_CONFIG.recoveryTimeoutMs / 1000);
    await redis.set(staleRecoveryKey, recoveryStart.toString(), 'EX', recoveryTtlSec);
    await redis.set(`${RUNTIME_RECOVERY_KEY}:current`, recoveryId, 'EX', recoveryTtlSec);

    // Reset active scenes index
    await redis.del('animastor:active-scenes');

    log('RECOVERY_IN_PROGRESS: clearing stale state');

    return { success: true, recoveryId };
}

/**
 * Recover active scenes from snapshot.
 */
async function recoverActiveScenes(redis, snapshot) {
    if (!snapshot || !snapshot.activeScenes) return 0;

    let recovered = 0;

    for (const scene of snapshot.activeScenes) {
        // T8: syncLinearState удалён — per-asset state единственный source of truth
        const perAsset = { audio: 'new', image: 'new', video: 'new' };
        await state.unsafeRestoreAssetStates(redis, scene.bookId, scene.chapterId, scene.sceneId, perAsset);
        recovered++;

        // Re-add to active index
        const activeKey = 'animastor:active-scenes';
        await redis.sadd(activeKey, `${scene.bookId}:${scene.chapterId}:${scene.sceneId}`);
    }

    log(`RECOVERED_SCENES: ${recovered} active scenes restored`);

    return recovered;
}

/**
 * Recover leases from snapshot.
 */
async function recoverLeases(redis, snapshot) {
    if (!snapshot || !snapshot.leases) return 0;

    let recovered = 0;

    for (const lease of snapshot.leases) {
        // Re-acquire lease with new token
        const leaseKey = `animastor:dispatch-lease:${lease.bookId}:${lease.chapterId}:${lease.sceneId}:${lease.stage}`;
        const newToken = `recovered-${lease.token}`;

        await redis.set(leaseKey, newToken, 'EX', lease.ttl || 1800);
        recovered++;
    }

    log(`RECOVERED_LEASES: ${recovered} leases restored`);

    return recovered;
}

/**
 * Recover dispatch metadata.
 */
async function recoverDispatchMetadata(redis, snapshot) {
    if (!snapshot || !snapshot.dispatches) return 0;

    let recovered = 0;

    for (const d of snapshot.dispatches) {
        const key = `animastor:dispatch-meta:${d.bookId}:${d.chapterId}:${d.sceneId}:${d.stage}`;
        await redis.set(key, JSON.stringify({
            ...d,
            recoveredAt: Date.now()
        }), 'EX', 3600);
        recovered++;
    }

    log(`RECOVERED_DISPATCHES: ${recovered} dispatches restored`);

    return recovered;
}

/**
 * Recover retry state.
 */
async function recoverRetryState(redis, snapshot) {
    if (!snapshot || !snapshot.retryState) return 0;

    let recovered = 0;

    for (const s of snapshot.retryState.scenes) {
        const key = `animastor:runtime:retry:${s.bookId}:${s.chapterId}:${s.sceneId}:count`;
        await redis.set(key, s.retryCount.toString());
        recovered++;
    }

    log(`RECOVERED_RETRY_STATE: ${recovered} scenes with retry history`);

    return recovered;
}

/**
 * Recover priority queue.
 */
async function recoverPriorityQueue(redis, snapshot) {
    if (!snapshot || !snapshot.priorityQueue) return 0;

    let recovered = 0;

    const pipeline = redis.pipeline();
    for (const q of snapshot.priorityQueue.queue) {
        const key = `${q.bookId}:${q.chapterId}:${q.sceneId}`;
        pipeline.zadd('animastor:priority:queue', q.score, key);
        recovered++;
    }
    await pipeline.exec();

    log(`RECOVERED_PRIORITY_QUEUE: ${recovered} scenes in priority queue`);

    return recovered;
}

/**
 * Finalize recovery.
 */
async function finalizeRecovery(redis, recoveryId) {
    // Clear recovery marker
    await redis.del(`${RUNTIME_RECOVERY_KEY}:stale`);
    await redis.del(`${RUNTIME_RECOVERY_KEY}:current`);

    log(`RECOVERY_COMPLETED: recoveryId=${recoveryId}`);

    return { success: true, recoveryId };
}

// ======================================================
// RECOVERY VERIFICATION
// ======================================================

/**
 * Verify recovery state.
 */
async function verifyRecovery(redis) {
    const activeScenes = await redis.scard('animastor:active-scenes');
    const leases = await scanKeys(redis, 'animastor:dispatch-lease:*');

    return {
        activeSceneCount: activeScenes,
        sceneStateCount: 0,
        activeLeaseCount: leases.length,
        recoveryMarkers: await redis.get(`${RUNTIME_RECOVERY_KEY}:current`)
    };
}

// ======================================================
// SNAPSHOT + RESTORE
// ======================================================

/**
 * Generate snapshot and persist.
 */
async function takeSnapshot(redis) {
    const snapshot = await generateSnapshot(redis);
    const key = await storeSnapshot(redis, snapshot);

    log(`SNAPSHOT_TAKEN: stored at ${key}`);

    return snapshot;
}

/**
 * Restore from latest snapshot.
 */
async function restoreFromSnapshot(redis) {
    const snapshot = await getLatestSnapshot(redis);
    if (!snapshot) {
        return { success: false, reason: 'no_snapshot_available' };
    }

    log(`RESTORE_START: from snapshot at ${snapshot.timestamp}`);

    // Recover all state
    await Promise.all([
        recoverActiveScenes(redis, snapshot),
        recoverLeases(redis, snapshot),
        recoverDispatchMetadata(redis, snapshot),
        recoverRetryState(redis, snapshot),
        recoverPriorityQueue(redis, snapshot)
    ]);

    log(`RESTORE_COMPLETED: snapshot timestamp=${snapshot.timestamp}`);

    return { success: true, snapshot };
}

// ======================================================
// DEBUG: PERSISTENCE STATUS
// ======================================================

/**
 * Get persistence status.
 */
async function getPersistenceStatus(redis) {
    const snapshots = await scanKeys(redis, `${RUNTIME_SNAPSHOT_KEY}:*`);
    const checkpoints = await scanKeys(redis, `${RUNTIME_CHECKPOINT_KEY}:*`);

    const latestSnapshot = await getLatestSnapshot(redis);
    const latestCheckpoint = await getLatestCheckpoint(redis);

    return {
        snapshots: {
            count: snapshots.length,
            latest: latestSnapshot ? latestSnapshot.timestamp : null,
            metadata: latestSnapshot?.metadata || null
        },
        checkpoints: {
            count: checkpoints.length,
            latest: latestCheckpoint ? latestCheckpoint.timestamp : null
        },
        recovery: {
            current: await redis.get(`${RUNTIME_RECOVERY_KEY}:current`),
            stale: await redis.get(`${RUNTIME_RECOVERY_KEY}:stale`)
        },
        metrics: await getRuntimeMetrics(redis)
    };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    RuntimeStateType,
    PERSISTENCE_CONFIG,

    // Snapshot operations
    generateSnapshot,
    storeSnapshot,
    getLatestSnapshot,
    takeSnapshot,

    // Checkpoint operations
    createCheckpoint,
    getLatestCheckpoint,

    // Recovery operations
    initiateRecovery,
    recoverActiveScenes,
    recoverLeases,
    recoverDispatchMetadata,
    recoverRetryState,
    recoverPriorityQueue,
    finalizeRecovery,
    verifyRecovery,
    restoreFromSnapshot,

    // State storage
    getSceneRecoveryState,
    storeSceneRecoveryState,
    clearSceneRecoveryState,

    // Runtime state getters
    getRuntimeMetrics,
    storeRuntimeMetrics,
    getRuntimeCounters,
    storeRuntimeCounters,
    restoreRuntimeCounters,
    getAllActiveLeases,
    getDispatchMetadata,
    getRetryState,
    getPriorityQueue,

    // Debug
    getPersistenceStatus
};
