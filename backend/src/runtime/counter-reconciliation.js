// ======================================================
// COUNTER RECONCILIATION - CORRECT LEAKED COUNTERS
// ======================================================
// Compares active leases (source of truth) with counters.
// Automatically corrects counter drift.
//
// LEASES = source of truth
// COUNTERS = derived runtime optimization

const logPrefix = '[DRIFT]';

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

const COUNTER_PREFIX = 'animastor:runtime:active';
const LEASE_PREFIX = 'animastor:dispatch-lease';

// ======================================================
// KEY GENERATORS
// ======================================================

function getCounterKey(stage) {
    return `${COUNTER_PREFIX}-${stage}`;
}

function getLeaseKeyPattern(stage) {
    return `${LEASE_PREFIX}:*:${stage}`;
}

// ======================================================
// COUNTER RECONCILIATION
// ======================================================

/**
 * Count active leases for a stage.
 */
async function countActiveLeasesByStage(redis, stage) {
    const pattern = getLeaseKeyPattern(stage);
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
 * Get current counter value.
 */
async function getCurrentCounter(redis, stage) {
    const key = getCounterKey(stage);
    const val = await redis.get(key);
    return parseInt(val || '0', 10);
}

/**
 * Set counter value.
 */
async function setCounter(redis, stage, value) {
    const key = getCounterKey(stage);
    await redis.set(key, String(value));
    return { set: true, key, value };
}

/**
 * Atomically correct counter using Lua script.
 */
async function correctCounterWithLua(redis, stage, targetValue) {
    const key = getCounterKey(stage);
    const target = String(targetValue);

    // NOTE: no "expected" guard here — ioredis serializes null args to ""
    // which is truthy in Lua, so a guard would always fire and skip the SET.
    const luaScript = `
        local key = KEYS[1]
        local newval = ARGV[1]

        local current = redis.call('GET', key)

        redis.call('SET', key, newval)

        return {tostring(true), 'corrected', current, newval}
    `;

    const result = await redis.eval(luaScript, 1, key, target);

    return {
        success: result[0] === 'true',
        action: result[1],
        old: result[2],
        new: result[3],
        key
    };
}

/**
 * Get current counter with drift check.
 */
async function getCounterWithDriftCheck(redis, stage) {
    const leaseCount = await countActiveLeasesByStage(redis, stage);
    const counterValue = await getCurrentCounter(redis, stage);

    return {
        stage,
        leaseCount,
        counterValue,
        drift: counterValue - leaseCount,
        correct: counterValue === leaseCount
    };
}

/**
 * Reconcile all counters.
 * Returns reconciliation report.
 */
async function reconcileCounters(redis) {
    const stages = ['audio', 'image', 'video'];
    const report = {
        timestamp: new Date().toISOString(),
        stages: {},
        summary: {
            totalDrift: 0,
            correctedCount: 0,
            errors: []
        }
    };

    for (const stage of stages) {
        try {
            const data = await getCounterWithDriftCheck(redis, stage);

            if (!data.correct) {
                warn(`COUNTER_DRIFT: ${stage}: counter=${data.counterValue}, leases=${data.leaseCount}, drift=${data.drift}`);

                // Correct the counter
                const correction = await correctCounterWithLua(redis, stage, data.leaseCount);

                if (correction.success && correction.action === 'corrected') {
                    log(`COUNTER_RECONCILED: ${stage}: ${correction.old} -> ${correction.new}`);
                    report.stages[stage] = {
                        leaseCount: data.leaseCount,
                        counterValue: data.counterValue,
                        drift: data.drift,
                        corrected: true,
                        correction: correction
                    };
                    report.summary.correctedCount++;
                    report.summary.totalDrift += Math.abs(data.drift);
                } else {
                    error(`COUNTER_CORRECTION_FAILED: ${stage}: ${correction ? correction.key : 'unknown'}`);
                    report.stages[stage] = {
                        leaseCount: data.leaseCount,
                        counterValue: data.counterValue,
                        drift: data.drift,
                        corrected: false,
                        correction
                    };
                    report.summary.errors.push(`Failed to correct ${stage}: ${correction?.key}`);
                }
            } else {
                report.stages[stage] = {
                    leaseCount: data.leaseCount,
                    counterValue: data.counterValue,
                    drift: 0,
                    corrected: false
                };
            }
        } catch (err) {
            error(`Counter reconciliation error for ${stage}: ${err.message}`);
            report.stages[stage] = {
                error: err.message,
                corrected: false
            };
            report.summary.errors.push(`Error reconciling ${stage}`);
        }
    }

    log(`COUNTER_RECONCILIATION_COMPLETE: ${report.summary.correctedCount} corrected, ${report.summary.totalDrift} total drift`);

    return report;
}

/**
 * Get current counter status.
 */
async function getCountersStatus(redis) {
    const stages = ['audio', 'image', 'video'];
    const status = {};

    for (const stage of stages) {
        status[stage] = await getCounterWithDriftCheck(redis, stage);
    }

    return status;
}

/**
 * Get reconciliation metrics.
 */
async function getReconciliationMetrics(redis) {
    const status = await getCountersStatus(redis);
    const totalLeases = status.audio.leaseCount + status.image.leaseCount + status.video.leaseCount;

    return {
        timestamp: new Date().toISOString(),
        counters: status,
        totalActiveLeases: totalLeases,
        driftStatus: {
            audio: status.audio.drift !== 0,
            image: status.image.drift !== 0,
            video: status.video.drift !== 0
        }
    };
}

/**
 * Quick check for problematic drift.
 * Returns { hasDrift: boolean, issues: [] }
 */
async function checkForDrift(redis) {
    const status = await getCountersStatus(redis);
    const issues = [];

    for (const stage of Object.keys(status)) {
        if (status[stage].drift !== 0) {
            issues.push({
                stage,
                counter: status[stage].counterValue,
                leases: status[stage].leaseCount,
                drift: status[stage].drift
            });
        }
    }

    return {
        hasDrift: issues.length > 0,
        issues
    };
}

/**
 * Manual counter correction.
 * Use only when you know the target value.
 */
async function manualCounterCorrection(redis, stage, value) {
    const result = await correctCounterWithLua(redis, stage, String(value));
    return {
        stage,
        value,
        ...result
    };
}

/**
 * Increment counter atomically.
 */
async function incrementCounter(redis, stage) {
    const key = getCounterKey(stage);
    const newVal = await redis.incr(key);
    return { stage, key, value: newVal };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Configuration
    COUNTER_PREFIX,
    LEASE_PREFIX,

    // Key generators
    getCounterKey,
    getLeaseKeyPattern,

    // Core reconciliation
    countActiveLeasesByStage,
    getCurrentCounter,
    setCounter,
    correctCounterWithLua,
    getCounterWithDriftCheck,
    reconcileCounters,
    getCountersStatus,
    getReconciliationMetrics,
    checkForDrift,
    manualCounterCorrection,

    // Counter manipulation
    incrementCounter
};
