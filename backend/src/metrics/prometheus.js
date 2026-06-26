// ======================================================
// Prometheus Metrics — O2
// ======================================================
// Exposes runtime metrics in Prometheus format for
// observability and monitoring.
//
// Metrics collected on every scheduler tick:
//   - Quota utilisation (gauges per stage)
//   - Active leases by stage (gauges from cached metrics)
//   - Lease age (sampled from active leases, by stage)
//   - Tick duration (histogram)
//   - Active scenes (gauge)
//   - Dispatch counters (cumulative from scheduler history)
//
// GET /metrics serves latest values from in-memory registry.
// No Redis calls on scrape — only during scheduler tick collection.

const client = require('prom-client');

// ======================================================
// REGISTRY
// ======================================================

const register = new client.Registry();
client.collectDefaultMetrics({ register });

// ======================================================
// GAUGES — current state snapshots
// ======================================================

const activeScenesGauge = new client.Gauge({
    name: 'animastor_active_scenes_total',
    help: 'Number of scenes in the active-scenes set',
    registers: [register],
});

const activeLeasesGauge = new client.Gauge({
    name: 'animastor_active_leases',
    help: 'Active dispatch leases by stage',
    labelNames: ['stage'],
    registers: [register],
});

const quotaUsageGauge = new client.Gauge({
    name: 'animastor_quota_usage',
    help: 'Current active counter by stage (concurrent dispatches)',
    labelNames: ['stage'],
    registers: [register],
});

const quotaMaxGauge = new client.Gauge({
    name: 'animastor_quota_max',
    help: 'Max concurrent dispatches by stage',
    labelNames: ['stage'],
    registers: [register],
});

const quotaUtilisationGauge = new client.Gauge({
    name: 'animastor_quota_utilisation_ratio',
    help: 'Quota utilisation ratio (usage / max) by stage, 0–1',
    labelNames: ['stage'],
    registers: [register],
});

const leaseAgeGauge = new client.Gauge({
    name: 'animastor_lease_age_seconds',
    help: 'Average lease age (TTL consumed) by stage — sampled',
    labelNames: ['stage'],
    registers: [register],
});

// ======================================================
// COUNTERS — cumulative event counts
// ======================================================

const dispatchesTotal = new client.Counter({
    name: 'animastor_dispatches_total',
    help: 'Cumulative dispatch events by status per scheduler tick',
    labelNames: ['status'],
    registers: [register],
});

// ======================================================
// HISTOGRAMS — duration distributions
// ======================================================

const tickDurationHistogram = new client.Histogram({
    name: 'animastor_tick_duration_ms',
    help: 'Scheduler tick duration in milliseconds',
    buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
    registers: [register],
});

// ======================================================
// CONFIGURATION
// ======================================================

const QUOTA_KEYS = [
    'animastor:runtime:active-audio',
    'animastor:runtime:active-image',
    'animastor:runtime:active-video',
];

const QUOTA_MAX = { audio: 3, image: 2, video: 1 };
const STAGES = ['audio', 'image', 'video'];

const LEASE_TTLS = {
    audio: 15 * 60,    // 15 minutes
    image: 20 * 60,    // 20 minutes
    video: 30 * 60,    // 30 minutes
};

const LEASE_SAMPLE_LIMIT = 20; // sample up to 20 leases per stage for age

// ======================================================
// COLLECTORS
// ======================================================

/**
 * Collect quota utilisation from Redis counters.
 * 3 GET calls — very cheap.
 */
async function collectQuotas(redis) {
    const [audioVal, imageVal, videoVal] = await Promise.all(
        QUOTA_KEYS.map(k => redis.get(k).then(v => parseInt(v || '0', 10)))
    );

    const usage = { audio: audioVal, image: imageVal, video: videoVal };

    for (const stage of STAGES) {
        const u = usage[stage];
        const max = QUOTA_MAX[stage];
        quotaUsageGauge.set({ stage }, u);
        quotaMaxGauge.set({ stage }, max);
        quotaUtilisationGauge.set({ stage }, max > 0 ? u / max : 0);
    }
}

/**
 * Collect active leases and lease age from cached runtime metrics
 * (animastor:runtime:metrics:current). Avoids expensive SCAN on every tick.
 * For lease age, samples up to LEASE_SAMPLE_LIMIT leases per stage via TTL.
 */
async function collectLeases(redis) {
    // Read cached metrics for lease counts
    const metricsRaw = await redis.get('animastor:runtime:metrics:current');
    let metrics = {};
    if (metricsRaw) {
        try { metrics = JSON.parse(metricsRaw); } catch (_) {}
    }

    for (const stage of STAGES) {
        const leaseCount = metrics[`active${stage.charAt(0).toUpperCase() + stage.slice(1)}Leases`];
        if (leaseCount !== undefined) {
            activeLeasesGauge.set({ stage }, leaseCount);
        }
    }

    // Sample lease age from first N leases per stage
    for (const stage of STAGES) {
        let totalAge = 0;
        let sampled = 0;
        let cursor = '0';
        let keys = [];

        // Collect up to LEASE_SAMPLE_LIMIT lease keys
        while (sampled < LEASE_SAMPLE_LIMIT) {
            const result = await redis.scan(cursor, 'MATCH', `animastor:dispatch-lease:*:${stage}`, 'COUNT', 50);
            cursor = result[0];
            keys = result[1];
            for (const key of keys) {
                if (sampled >= LEASE_SAMPLE_LIMIT) break;
                const ttl = await redis.ttl(key);
                if (ttl > 0) {
                    totalAge += LEASE_TTLS[stage] - ttl;
                    sampled++;
                }
            }
            if (cursor === '0') break;
        }

        const avgAge = sampled > 0 ? Math.round(totalAge / sampled) : 0;
        leaseAgeGauge.set({ stage }, avgAge);
    }
}

/**
 * Collect dispatch counters and tick duration from scheduler history.
 * Reads the latest tick entry and increments cumulative counters.
 */
async function collectDispatchCounters(redis) {
    const historyKey = 'animastor:runtime:scheduler:history';
    const lastEntry = await redis.lindex(historyKey, -1);
    if (!lastEntry) return;

    try {
        const tick = JSON.parse(lastEntry);
        const s = tick.scheduler || {};
        const processed = s.processed || 0;
        const dispatched = s.dispatched || 0;
        const throttled = s.throttled || 0;

        if (processed > 0 || dispatched > 0 || throttled > 0) {
            dispatchesTotal.inc({ status: 'evaluated' }, processed);
            dispatchesTotal.inc({ status: 'dispatched' }, dispatched);
            dispatchesTotal.inc({ status: 'backpressure' }, throttled);
        }

        const durationMs = tick.duration || 0;
        if (durationMs > 0) {
            tickDurationHistogram.observe(durationMs);
        }
    } catch (_) {}
}

/**
 * Collect active scenes count from Redis set cardinality.
 */
async function collectActiveScenes(redis) {
    const count = await redis.scard('animastor:active-scenes');
    activeScenesGauge.set(count);
}

// ======================================================
// MAIN COLLECT — call on every scheduler tick
// ======================================================

/**
 * Collect all metrics from Redis and update Prometheus gauges/counters.
 * Designed to be called from the runtime loop tick every ~5s.
 *
 * Redis calls per tick: 3 (quotas) + 1 (cached metrics) + 1 (active-scenes)
 *   + 1 (scheduler history) + up to 3×LEASE_SAMPLE_LIMIT TTL calls.
 * Total ≈ 10–12 Redis calls — lightweight.
 */
async function collect(redis) {
    try {
        await Promise.all([
            collectQuotas(redis),
            collectActiveScenes(redis),
            collectLeases(redis),
            collectDispatchCounters(redis),
        ]);
    } catch (err) {
        console.warn('[PROMETHEUS] collect error:', err.message);
    }
}

// ======================================================
// METRICS EXPOSURE
// ======================================================

/**
 * Get Prometheus-format metrics string.
 */
async function getMetricsContent() {
    return register.metrics();
}

/**
 * Get content-type header for Prometheus.
 */
function getContentType() {
    return register.contentType;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    register,
    collect,
    getMetricsContent,
    getContentType,
};
