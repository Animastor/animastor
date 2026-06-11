// ======================================================
// Worker Health - v1.0.0
// ======================================================

const config = require('../config/runtime-config');

const logPrefix = '[WORKER]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

/**
 * Report a worker heartbeat: mark a worker as alive.
 * Workers call this periodically (e.g. every 15s) to signal availability.
 */
async function reportHeartbeat(redis, type, workerId) {
    const key = config.WORKER_HEARTBEAT_KEY(type, workerId);
    const payload = JSON.stringify({
        type,
        worker_id: workerId,
        ts: Date.now()
    });
    await redis.set(key, payload, 'EX', config.WORKER_HEARTBEAT_TTL);
}

/**
 * Get count of alive workers for a given type.
 * Returns 0 if no workers have recent heartbeats.
 */
async function getAliveCount(redis, type) {
    const pattern = config.WORKER_HEARTBEAT_TYPE_PATTERN(type);
    const keys = await redis.keys(pattern);
    let alive = 0;
    const now = Date.now();
    const maxAge = config.WORKER_HEARTBEAT_TTL * 1000;

    for (const key of keys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        try {
            const data = JSON.parse(raw);
            if (now - data.ts < maxAge) {
                alive++;
            }
        } catch {}
    }
    return alive;
}

/**
 * Get status of all worker types.
 * Returns { audio: N, image: N, video: N }
 */
async function getStatus(redis) {
    const status = {};
    for (const type of config.WORKER_HEARTBEAT_TYPES) {
        status[type] = await getAliveCount(redis, type);
    }
    return status;
}

/**
 * Check if at least one worker of the given type is alive.
 */
async function isAvailable(redis, type) {
    const count = await getAliveCount(redis, type);
    return count > 0;
}

module.exports = {
    reportHeartbeat,
    getAliveCount,
    getStatus,
    isAvailable
};
