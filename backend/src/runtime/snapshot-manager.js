// ======================================================
// SNAPSHOT MANAGER - RUNTIME OPERATIONAL SNAPSHOTS
// ======================================================
// Forms point-in-time views of runtime scene state for debugging/monitoring.
//
// Snapshot sources:
// - State machine (scene state, updated_at, error)
// - Asset registry (aggregated assets)
// - Dispatch metadata (dispatch_id, stage, retry_attempt)
// - Lease manager (active leases, tokens)
// - Event journal (last N events)
// - Metrics (active scenes, leases, quotas)
//
// Snapshot format:
// {
//   scene,
//   state,
//   current_stage,
//   active_dispatch,
//   active_lease,
//   retry_counts,
//   assets,
//   last_events,
//   heartbeat_age,
//   recovery_status,
//   last_error,
//   updated_at
// }

const state = require('../state');
const dispatchEngine = require('./dispatch-engine');
const journal = require('../orchestration/event-journal');
const metrics = require('./runtime-metrics');

const logPrefix = '[SNAPSHOT]';

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

const SNAPSHOT_PREFIX = 'animastor:runtime:snapshot';
const SNAPSHOT_TTL = 300; // 5 minutes (snapshots are temporary)
const MAX_EVENTS_IN_SNAPSHOT = 10;

// ======================================================
// SNAPSHOT SOURCE DATA COLLECTORS
// ======================================================

/**
 * Collect state data for a scene.
 */
async function collectSceneState(redis, bookId, chapterId, sceneId) {
    const sceneState = await state.getSceneState(redis, bookId, chapterId, sceneId);

    if (!sceneState) {
        return null;
    }

    return {
        state: sceneState.state,
        updated_at: sceneState.updated_at,
        build_id: sceneState.build_id || null,
        error: sceneState.error || null,
        transition_count: 0 // Would need to track transitions separately
    };
}

/**
 * Collect dispatch data for a scene.
 */
async function collectDispatchData(redis, bookId, chapterId, sceneId) {
    const activeStages = ['audio', 'image', 'video'];
    const dispatchData = {};

    for (const stage of activeStages) {
        const metadata = await dispatchEngine.getDispatchMetadata(
            redis,
            bookId,
            chapterId,
            sceneId,
            stage
        );

        if (metadata) {
            dispatchData[stage] = metadata;
        }
    }

    return dispatchData;
}

/**
 * Collect lease data for a scene.
 */
async function collectLeaseData(redis, bookId, chapterId, sceneId) {
    const activeStages = ['audio', 'image', 'video'];
    const leaseData = {};

    for (const stage of activeStages) {
        const { leaseKey, token } = await dispatchEngine.getLeaseData(
            redis,
            bookId,
            chapterId,
            sceneId,
            stage
        );

        if (token) {
            const ttl = await redis.ttl(leaseKey);
            leaseData[stage] = {
                lease_key: leaseKey,
                token: token,
                ttl: ttl > 0 ? ttl : 0
            };
        }
    }

    return leaseData;
}

/**
 * Collect retry counts for a scene.
 */
async function collectRetryCounts(redis, bookId, chapterId, sceneId) {
    const retryCounts = {};

    const activeStages = ['audio', 'image', 'video'];
    for (const stage of activeStages) {
        const metadata = await dispatchEngine.getDispatchMetadata(
            redis,
            bookId,
            chapterId,
            sceneId,
            stage
        );

        if (metadata && metadata.retry_attempt !== undefined) {
            retryCounts[stage] = metadata.retry_attempt;
        }
    }

    return retryCounts;
}

/**
 * Collect assets for a scene.
 */
async function collectAssets(redis, bookId, chapterId, sceneId) {
    // Assets are tracked in asset registry
    const assets = {
        image: null,
        audio: null,
        video: null
    };

    try {
        const imageKey = `animastor:asset:image:${bookId}:${chapterId}:${sceneId}`;
        const imageData = await redis.get(imageKey);
        if (imageData) {
            assets.image = JSON.parse(imageData);
        }

        const audioKey = `animastor:asset:audio:${bookId}:${chapterId}:${sceneId}`;
        const audioData = await redis.get(audioKey);
        if (audioData) {
            assets.audio = JSON.parse(audioData);
        }

        const videoKey = `animastor:asset:video:${bookId}:${chapterId}:${sceneId}`;
        const videoData = await redis.get(videoKey);
        if (videoData) {
            assets.video = JSON.parse(videoData);
        }
    } catch (err) {
        warn(`Error collecting assets for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
    }

    return assets;
}

/**
 * Collect recent events for a scene.
 */
async function collectLastEvents(redis, bookId, chapterId, sceneId) {
    try {
        const events = await journal.getLastEvents(
            redis,
            bookId,
            chapterId,
            sceneId,
            MAX_EVENTS_IN_SNAPSHOT
        );

        return events.map(evt => ({
            type: evt.type,
            state: evt.state,
            timestamp: evt.ts,
            details: evt.details
        }));
    } catch (err) {
        return [];
    }
}

/**
 * Calculate heartbeat age in seconds.
 */
function calculateHeartbeatAge(sceneState) {
    if (!sceneState || !sceneState.updated_at) {
        return null;
    }

    const ageMs = Date.now() - sceneState.updated_at;
    return Math.floor(ageMs / 1000);
}

/**
 * Determine recovery status.
 */
function determineRecoveryStatus(sceneState, leaseData) {
    const stateName = sceneState?.state;
    const isStuck = false; // Would need stuck detection

    // Check for recovery in progress
    const recoveryStage = null; // Would check recovery state

    return {
        is_recovery_pending: false,
        recovery_stage: recoveryStage,
        is_stuck: isStuck,
        recovery_reason: null
    };
}

/**
 * Get last error from scene state.
 */
function getLastErrorMessage(sceneState) {
    if (!sceneState || !sceneState.error) {
        return null;
    }

    const errorInfo = typeof sceneState.error === 'string'
        ? { message: sceneState.error }
        : sceneState.error;

    return {
        message: errorInfo.message || sceneState.error,
        code: errorInfo.code || null,
        classified_at: errorInfo.classified_at || null,
        type: errorInfo.type || null
    };
}

// ======================================================
// MAIN SNAPSHOTS
// ======================================================

/**
 * Generate snapshot for a single scene.
 */
async function generateSceneSnapshot(redis, bookId, chapterId, sceneId) {
    const startTime = Date.now();

    log(`SNAPSHOT_START: ${bookId}/${chapterId}/${sceneId}`);

    // Collect all data sources
    const [sceneState, dispatchData, leaseData, retryCounts, assets, lastEvents] = await Promise.all([
        collectSceneState(redis, bookId, chapterId, sceneId),
        collectDispatchData(redis, bookId, chapterId, sceneId),
        collectLeaseData(redis, bookId, chapterId, sceneId),
        collectRetryCounts(redis, bookId, chapterId, sceneId),
        collectAssets(redis, bookId, chapterId, sceneId),
        collectLastEvents(redis, bookId, chapterId, sceneId)
    ]);

    if (!sceneState) {
        warn(`SNAPSHOT_FAILED: Scene not found ${bookId}/${chapterId}/${sceneId}`);
        return null;
    }

    const snapshot = {
        // Scene identity
        scene: {
            book_id: bookId,
            chapter_id: chapterId,
            scene_id: sceneId,
            canonical_id: `${bookId}_${chapterId}_${sceneId}`
        },

        // State
        state: sceneState.state,
        current_stage: sceneState.state.split('_')[0] || 'unknown', // audio, image, video
        updated_at: sceneState.updated_at,

        // Dispatch info
        active_dispatch: dispatchData,

        // Lease info
        active_lease: leaseData,

        // Retry counts
        retry_counts: retryCounts,

        // Assets
        assets: assets,

        // Events
        last_events: lastEvents,

        // Heartbeat
        heartbeat_age: calculateHeartbeatAge(sceneState),

        // Recovery status
        recovery_status: determineRecoveryStatus(sceneState, leaseData),

        // Last error
        last_error: getLastErrorMessage(sceneState),

        // Metadata
        snapshot_created_at: Date.now(),
        snapshot_generation_ms: Date.now() - startTime
    };

    log(`SNAPSHOT_COMPLETE: ${bookId}/${chapterId}/${sceneId} (${snapshot.snapshot_generation_ms}ms)`);

    return snapshot;
}

/**
 * Generate snapshot for all scenes in a build.
 */
async function generateBuildSnapshot(redis, buildId, limit = 100) {
    const startTime = Date.now();
    const scenes = [];

    // Get all active scenes
    const activePattern = 'animastor:scene-state:*';
    let cursor = 0;
    let count = 0;

    do {
        const result = await redis.scan(cursor, 'MATCH', activePattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        const keys = result[1];

        for (const key of keys) {
            if (count >= limit) break;

            // Parse: animastor:scene-state:bookId:chapterId:sceneId
            const parts = key.split(':');
            if (parts.length >= 5) {
                const bookId = parts[2];
                const chapterId = parts[3];
                const sceneId = parts[4];

                const snapshot = await generateSceneSnapshot(redis, bookId, chapterId, sceneId);
                if (snapshot) {
                    scenes.push(snapshot);
                    count++;
                }
            }
        }
    } while (cursor !== 0 && count < limit);

    const totalActive = await redis.scard('animastor:active-scenes');

    return {
        build_id: buildId,
        snapshot_generated_at: Date.now(),
        generation_ms: Date.now() - startTime,
        total_active_scenes: totalActive,
        scenes_count: scenes.length,
        scenes: scenes
    };
}

/**
 * Generate global runtime snapshot.
 */
async function generateGlobalSnapshot(redis) {
    const startTime = Date.now();

    // Get current metrics
    const metricsData = await metrics.getCurrentMetrics(redis);
    const leaseData = await dispatchEngine.getRuntimeMetrics(redis);

    // Count active scenes
    const activeScenesKey = 'animastor:active-scenes';
    const activeScenes = await redis.scard(activeScenesKey);

    // Get active leases
    const activeLeasesAudio = await dispatchEngine.getQuotaStatus(redis);

    return {
        type: 'global',
        generated_at: Date.now(),
        generation_ms: Date.now() - startTime,

        // Global metrics
        active_scenes: activeScenes,
        active_leases: metricsData.activeLeases,
        quotas: activeLeasesAudio,

        // Metrics summary
        metrics: {
            activeAudioScenes: metricsData.activeAudioScenes,
            activeImageScenes: metricsData.activeImageScenes,
            activeVideoScenes: metricsData.activeVideoScenes,
            quotaAudioUsed: metricsData.quotaAudioUsed,
            quotaImageUsed: metricsData.quotaImageUsed,
            quotaVideoUsed: metricsData.quotaVideoUsed,
            schedulerTicks: metricsData.schedulerTicks,
            lastTickDuration: metricsData.schedulerLastTickDuration
        },

        // Recovery summary
        recovery: {
            recoveryActions: await redis.scard('animastor:runtime:recovery:actions'),
            stuckScenes: await redis.scard('animastor:runtime:stuck-scenes')
        }
    };
}

// ======================================================
// SNAPSHOT STORAGE AND RETRIEVAL
// ======================================================

/**
 * Get snapshot key for a scene.
 */
function getSnapshotKey(bookId, chapterId, sceneId) {
    return `${SNAPSHOT_PREFIX}:${bookId}:${chapterId}:${sceneId}`;
}

/**
 * Store snapshot in Redis (with TTL).
 */
async function storeSnapshot(redis, bookId, chapterId, sceneId, snapshot) {
    const key = getSnapshotKey(bookId, chapterId, sceneId);
    await redis.set(key, JSON.stringify(snapshot), 'EX', SNAPSHOT_TTL);
    return { stored: true, key, ttl: SNAPSHOT_TTL };
}

/**
 * Retrieve stored snapshot.
 */
async function getStoredSnapshot(redis, bookId, chapterId, sceneId) {
    const key = getSnapshotKey(bookId, chapterId, sceneId);
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
}

/**
 * Delete stored snapshot.
 */
async function deleteSnapshot(redis, bookId, chapterId, sceneId) {
    const key = getSnapshotKey(bookId, chapterId, sceneId);
    await redis.del(key);
    return { deleted: true, key };
}

// ======================================================
// DEBUG UTILITIES
// ======================================================

/**
 * Get snapshot generation metrics.
 */
function getSnapshotMetrics() {
    return {
        maxEventsInSnapshot: MAX_EVENTS_IN_SNAPSHOT,
        snapshotTTL: SNAPSHOT_TTL,
        snapshotPrefix: SNAPSHOT_PREFIX
    };
}

/**
 * Get all snapshots for a build.
 */
async function getBuildSnapshots(redis, buildId) {
    const pattern = `${SNAPSHOT_PREFIX}:*`;
    const snapshots = [];

    let cursor = 0;
    do {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        const keys = result[1];

        for (const key of keys) {
            const raw = await redis.get(key);
            if (raw) {
                try {
                    const snapshot = JSON.parse(raw);
                    snapshots.push(snapshot);
                } catch (e) {
                    // Skip invalid entries
                }
            }
        }
    } while (cursor !== 0 && snapshots.length < 1000);

    return snapshots;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Generate snapshots
    generateSceneSnapshot,
    generateBuildSnapshot,
    generateGlobalSnapshot,

    // Storage
    getSnapshotKey,
    storeSnapshot,
    getStoredSnapshot,
    deleteSnapshot,

    // Debug
    getBuildSnapshots,
    getSnapshotMetrics,

    // Constants
    SNAPSHOT_PREFIX,
    SNAPSHOT_TTL,
    MAX_EVENTS_IN_SNAPSHOT
};
