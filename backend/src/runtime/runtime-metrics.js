// ======================================================
// RUNTIME METRICS LAYER
// ======================================================
// Collects and exports runtime metrics for observability.
//
// Metrics stored in Redis:
// - animastor:runtime:metrics:current
// - animastor:runtime:metrics:history (sorted set)
//
// Metrics tracked:
// - active scenes
// - active dispatches/leases
// - quota utilization
// - scheduler ticks (count, duration)
// - recovery actions
// - stale recoveries
// - duplicate dispatch skips
// - counter drift

const counterReconciliation = require('./counter-reconciliation');

const logPrefix = '[METRICS]';

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

const METRICS_KEY = 'animastor:runtime:metrics:current';
const METRICS_HISTORY_KEY = 'animastor:runtime:metrics:history';
const METRICS_RETENTION_LIMIT = 1000;

// ======================================================
// METRIC DEFINITIONS
// ======================================================

const METRIC_DEFS = {
    // Scene metrics
    activeScenes: { type: 'gauge', description: 'Number of active scenes' },
    activeAudioScenes: { type: 'gauge', description: 'Active scenes in audio stages' },
    activeImageScenes: { type: 'gauge', description: 'Active scenes in image stages' },
    activeVideoScenes: { type: 'gauge', description: 'Active scenes in video stages' },

    // Dispatch/lease metrics
    activeLeases: { type: 'gauge', description: 'Total active leases' },
    activeAudioLeases: { type: 'gauge', description: 'Active audio leases' },
    activeImageLeases: { type: 'gauge', description: 'Active image leases' },
    activeVideoLeases: { type: 'gauge', description: 'Active video leases' },
    leaseRenewalsInFlight: { type: 'gauge', description: 'Active lease renewal timers' },

    // Quota metrics
    quotaAudioUsed: { type: 'gauge', description: 'Active audio dispatches' },
    quotaAudioMax: { type: 'gauge', description: 'Max concurrent audio' },
    quotaImageUsed: { type: 'gauge', description: 'Active image dispatches' },
    quotaImageMax: { type: 'gauge', description: 'Max concurrent image' },
    quotaVideoUsed: { type: 'gauge', description: 'Active video dispatches' },
    quotaVideoMax: { type: 'gauge', description: 'Max concurrent video' },

    // Scheduler metrics
    schedulerTicks: { type: 'counter', description: 'Total scheduler ticks' },
    schedulerTickDurationAvg: { type: 'gauge', description: 'Average tick duration (ms)' },
    schedulerLastTickDuration: { type: 'gauge', description: 'Last tick duration (ms)' },

    // Dispatch metrics
    dispatchesAttempted: { type: 'counter', description: 'Total dispatch attempts' },
    dispatchesSuccess: { type: 'counter', description: 'Successful dispatches' },
    dispatchesSkipped: { type: 'counter', description: 'Skipped dispatches (lease exists)' },
    dispatchesBackpressure: { type: 'counter', description: 'BackpressureBlocked dispatches' },

    // Recovery metrics
    recoveryActions: { type: 'counter', description: 'Total recovery actions' },
    staleLeaseRecoveries: { type: 'counter', description: 'Stale lease recoveries' },
    counterDriftCorrections: { type: 'counter', description: 'Counter drift corrections' },

    // Event metrics
    callbackDuplicates: { type: 'counter', description: 'Duplicate callback events' },
    queueBlocked: { type: 'counter', description: 'Queue blocked events' },

    // Drift metrics
    counterDriftTotal: { type: 'gauge', description: 'Total counter drift magnitude' }
};

// ======================================================
// GETTER FUNCTIONS
// ======================================================

/**
 * Get metric definitions.
 */
function getMetricDefinitions() {
    return METRIC_DEFS;
}

/**
 * Get current runtime metrics from Redis.
 */
async function getCurrentMetrics(redis, additionalData = {}) {
    const timestamp = Date.now();

    // Get active scenes
    const activeScenesKey = 'animastor:active-scenes';
    const activeScenes = await redis.scard(activeScenesKey);

    // Get active leases by stage
    const leasePatternAudio = 'animastor:dispatch-lease:*:audio';
    const leasePatternImage = 'animastor:dispatch-lease:*:image';
    const leasePatternVideo = 'animastor:dispatch-lease:*:video';

    const [audioCount, imageCount, videoCount] = await Promise.all([
        countPattern(redis, leasePatternAudio),
        countPattern(redis, leasePatternImage),
        countPattern(redis, leasePatternVideo)
    ]);

    // Get active counters
    const activeKeys = [
        'animastor:runtime:active-audio',
        'animastor:runtime:active-image',
        'animastor:runtime:active-video'
    ];

    const [audioCounter, imageCounter, videoCounter] = await Promise.all([
        getCounter(redis, activeKeys[0]),
        getCounter(redis, activeKeys[1]),
        getCounter(redis, activeKeys[2])
    ]);

    // Get quota settings
    const quotas = {
        maxAudio: 3,
        maxImage: 2,
        maxVideo: 1
    };

    // Get lease renewal count
    const renewalKey = 'animastor:runtime:renewal-timers';
    const renewalCount = await redis.scard(renewalKey);

    // Get scheduler history
    const schedulerKey = 'animastor:runtime:scheduler:history';
    const schedulerHistory = await redis.lrange(schedulerKey, -10, -1);

    let schedulerTicks = 0;
    let totalTickDuration = 0;
    let lastTickDuration = 0;

    if (schedulerHistory.length > 0) {
        schedulerTicks = schedulerHistory.length;
        for (const item of schedulerHistory) {
            try {
                const data = JSON.parse(item);
                totalTickDuration += data.durationMs || 0;
                lastTickDuration = data.durationMs || 0;
            } catch (e) {
                // Skip invalid entries
            }
        }
    }

    // Get recovery counts
    const recoveryKey = 'animastor:runtime:recovery:actions';
    const recoveryActions = await redis.scard(recoveryKey);

    const metrics = {
        // Timestamp
        timestamp,
        createdAt: new Date(timestamp).toISOString(),

        // Scenes
        activeScenes,
        activeAudioScenes: await getScenesInStage(redis, 'audio_generating'),
        activeImageScenes: await getScenesInStage(redis, 'image_generating'),
        activeVideoScenes: await getScenesInStage(redis, 'video_generating'),

        // Leases
        activeLeases: audioCount + imageCount + videoCount,
        activeAudioLeases: audioCount,
        activeImageLeases: imageCount,
        activeVideoLeases: videoCount,
        leaseRenewalsInFlight: renewalCount,

        // Quotas
        quotaAudioUsed: audioCounter,
        quotaAudioMax: quotas.maxAudio,
        quotaImageUsed: imageCounter,
        quotaImageMax: quotas.maxImage,
        quotaVideoUsed: videoCounter,
        quotaVideoMax: quotas.maxVideo,

        // Scheduler
        schedulerTicks,
        schedulerTickDurationAvg: schedulerTicks > 0 ? Math.round(totalTickDuration / schedulerTicks) : 0,
        schedulerLastTickDuration: lastTickDuration,

        // Additional data
        ...additionalData
    };

    return metrics;
}

/**
 * Count keys matching pattern.
 */
async function countPattern(redis, pattern) {
    let cursor = 0;
    let count = 0;

    do {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = parseInt(result[0], 10);
        count += result[1].length;
    } while (cursor !== 0 && count < 10000);

    return count;
}

/**
 * Get counter value.
 */
async function getCounter(redis, key) {
    const val = await redis.get(key);
    return parseInt(val || '0', 10);
}

/**
 * Get scenes in a specific stage (stub — scene-state removed).
 */
async function getScenesInStage(redis, stage) {
    return 0;
}

/**
 * Store current metrics in Redis.
 */
async function storeMetrics(redis, metrics) {
    // Store current
    await redis.set(METRICS_KEY, JSON.stringify(metrics));

    // Add to history (sorted set with timestamp as score)
    const historyKey = METRICS_HISTORY_KEY;
    await redis.zadd(historyKey, metrics.timestamp, JSON.stringify(metrics));

    // Trim history
    const count = await redis.zcard(historyKey);
    if (count > METRICS_RETENTION_LIMIT) {
        await redis.zremrangebyrank(historyKey, 0, count - METRICS_RETENTION_LIMIT - 1);
    }

    return { stored: true, key: METRICS_KEY, historyKey, historyLength: count };
}

/**
 * Get metrics history.
 */
async function getMetricsHistory(redis, limit = 100, offset = 0) {
    const historyKey = METRICS_HISTORY_KEY;
    const count = await redis.zcard(historyKey);

    const start = Math.max(0, count - limit - offset);
    const end = count - offset - 1;

    const range = await redis.zrange(historyKey, start, end);
    const metrics = range.map(item => {
        try {
            return JSON.parse(item);
        } catch (e) {
            return null;
        }
    }).filter(m => m !== null);

    return {
        total: count,
        metrics,
        returned: metrics.length
    };
}

/**
 * Increment counter metric.
 */
async function incrementCounter(redis, name, value = 1) {
    const key = `${METRICS_KEY}:${name}`;
    const newValue = await redis.incrby(key, value);
    return { name, key, value: newValue };
}

/**
 * Get counter metric.
 */
async function getCounterMetric(redis, name) {
    const key = `${METRICS_KEY}:${name}`;
    const val = await redis.get(key);
    return parseInt(val || '0', 10);
}

/**
 * Record scheduler tick.
 */
async function recordSchedulerTick(redis, tickMetrics) {
    const historyKey = 'animastor:runtime:scheduler:history';
    await redis.rpush(historyKey, JSON.stringify(tickMetrics));
    await redis.ltrim(historyKey, -1000, -1); // Keep last 1000

    return { recorded: true, historyKey };
}

/**
 * Record recovery action.
 */
async function recordRecoveryAction(redis, action) {
    const key = 'animastor:runtime:recovery:actions';
    const data = {
        ...action,
        timestamp: Date.now()
    };
    await redis.sadd(key, JSON.stringify(data));
    return { recorded: true, key, action };
}

/**
 * Record duplicate callback.
 */
async function recordDuplicateCallback(redis) {
    return await incrementCounter(redis, 'callbackDuplicates');
}

/**
 * Record backpressure-blocked dispatch.
 */
async function recordBackpressureBlocked(redis) {
    return await incrementCounter(redis, 'dispatchesBackpressure');
}

/**
 * Record stuck scene detection.
 */
async function recordStuckScene(redis, scene) {
    const key = 'animastor:runtime:stuck-scenes';
    const data = {
        ...scene,
        timestamp: Date.now()
    };
    await redis.sadd(key, JSON.stringify(data));
    return { recorded: true, key, scene };
}

/**
 * Get comprehensive metrics report.
 */
async function getMetricsReport(redis) {
    const current = await getCurrentMetrics(redis);
    const history = await getMetricsHistory(redis, 10);
    const driftReport = await counterReconciliation.checkForDrift(redis);

    return {
        current,
        history: history.metrics,
        drift: driftReport
    };
}

/**
 * Get runtime health status.
 */
async function getHealthStatus(redis) {
    const current = await getCurrentMetrics(redis);

    // Check if leases are growing faster than counter consumption
    const leaseGrowth = current.activeLeases > 0 && current.quotaAudioUsed > current.activeLeases;
    const potentialLeak = current.activeLeases > 100; // Suspiciously high

    return {
        healthy: !potentialLeak,
        issues: potentialLeak ? ['high_active_leases'] : [],
        metrics: current
    };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Configuration
    METRICS_KEY,
    METRICS_HISTORY_KEY,
    METRICS_RETENTION_LIMIT,

    // Definitions
    getMetricDefinitions,
    METRIC_DEFS,

    // Getters
    getCurrentMetrics,
    getMetricsHistory,
    getMetricsReport,
    getHealthStatus,

    // Storage
    storeMetrics,
    recordSchedulerTick,
    recordRecoveryAction,
    recordDuplicateCallback,
    recordBackpressureBlocked,
    recordStuckScene,

    // Counters
    getCounterMetric,

    // Helper
    countPattern,
    getCounter,
    getScenesInStage
};
