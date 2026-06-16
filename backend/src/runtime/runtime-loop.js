// ======================================================
// Runtime Loop - v1.0.0
// ======================================================
// Runs periodically to drive scene progression.
// The heartbeat of the runtime scheduler system.

const runtimeScheduler = require('./runtime-scheduler');
const reconciliationEngine = require('./reconciliation-engine');
const runtimeMetrics = require('./runtime-metrics');
const counterReconciliation = require('./counter-reconciliation');
const dispatchEngine = require('./dispatch-engine');

const logPrefix = '[RUNTIME-LOOP]';

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
// LOOP STATE
// ======================================================

let loopInterval = null;
let isRunning = false;
let currentTick = 0;

// Metrics tracking
const metricsHistory = [];

// ======================================================
// TICK HANDLER
// ======================================================

/**
 * Execute one loop iteration (tick).
 */
async function executeTick(redis, loadedBooks = {}) {
    currentTick++;

    const startTime = Date.now();
    log(`Starting tick #${currentTick}`);

    // Phase 1: Runtime scheduler progression (with dispatch engine)
    const schedulerSummary = await runtimeScheduler.tick(redis, loadedBooks);

    // Phase 2: Reconciliation & self-healing
    const reconcileReport = await reconciliationEngine.reconcileAll(redis);

    // Phase 3: Counter reconciliation (corrects leaked counters after crash/restart)
    const counterReport = await counterReconciliation.reconcileCounters(redis);

    // Phase 4: Store runtime metrics
    try {
        const metricsData = {
            tick: currentTick,
            duration: Date.now() - startTime,
            scheduler: schedulerSummary,
            reconcile: reconcileReport ? reconcileReport.toSummary() : null,
            counter: counterReport,
            timestamp: new Date().toISOString()
        };
        await runtimeMetrics.recordSchedulerTick(redis, metricsData);
    } catch (metricsErr) {
        console.warn(`[RUNTIME] Metrics storage error: ${metricsErr.message}`);
    }

    // Phase 5: Auto-fix detected inconsistencies
    if (reconcileReport && reconcileReport.inconsistentScenes && reconcileReport.inconsistentScenes.length > 0) {
        for (const inconsistent of reconcileReport.inconsistentScenes) {
            const { scene } = inconsistent;
            const sceneKey = `${scene.bookId}:${scene.chapterId}:${scene.sceneId}`;

            // Generate fix recommendation and apply it
            const fixes = reconciliationEngine.getFixRecommendations([inconsistent]);
            for (const fix of fixes) {
                if (fix.safeToExecute) {
                    try {
                        const result = await reconciliationEngine.applyFix(redis, fix);
                        log(`AUTO-FIX: ${fix.action} for ${sceneKey}: ${result.success ? 'OK' : 'FAILED'} (${result.details})`);
                    } catch (fixErr) {
                        warn(`AUTO-FIX error for ${sceneKey}: ${fixErr.message}`);
                    }
                }
            }
        }
    }

    const duration = Date.now() - startTime;
    const metrics = {
        tick: currentTick,
        duration,
        scheduler: schedulerSummary,
        reconcile: reconcileReport ? reconcileReport.toSummary() : null,
        counter: counterReport,
        timestamp: new Date().toISOString()
    };

    // Keep last 100 ticks in memory
    metricsHistory.push(metrics);
    if (metricsHistory.length > 100) {
        metricsHistory.shift();
    }

    log(`Tick #${currentTick} complete in ${duration}ms`);
    log(`  Scheduler: ${schedulerSummary.processed} processed, ${schedulerSummary.dispatched || 0} dispatched, ${schedulerSummary.throttled || 0} throttled`);
    log(`  Reconcile: ${metrics.reconcile?.totalInconsistent || 0} inconsistencies`);
    log(`  Counter: ${counterReport.summary?.correctedCount || 0} corrected, ${counterReport.summary?.totalDrift || 0} total drift`);

    return metrics;
}

/**
 * Get metrics history for debugging.
 */
function getHistory(limit = 10) {
    return metricsHistory.slice(-limit);
}

/**
 * Get current runtime metrics (live, not historical).
 */
async function getCurrentMetrics(redis) {
    const schedulerMetrics = await runtimeScheduler.getMetrics(redis);
    const reconciliationMetrics = await reconciliationEngine.getMetrics(redis);

    return {
        loop: {
            running: isRunning,
            tick: currentTick,
            metricsHistoryLength: metricsHistory.length
        },
        scheduler: schedulerMetrics,
        reconciliation: reconciliationMetrics
    };
}

// ======================================================
// LOOP CONTROL
// ======================================================

/**
 * Start the runtime loop.
 * @param {number} intervalMs - Interval in milliseconds (default: 5000)
 */
function start(redis, intervalMs = runtimeScheduler.SCHEDULER_TICK_MS) {
    if (isRunning) {
        warn('Runtime loop already running');
        return { success: false, reason: 'already_running' };
    }

    isRunning = true;
    log(`Starting runtime loop with interval: ${intervalMs}ms`);

    loopInterval = setInterval(async () => {
        try {
            // Check if Redis is available before executing tick
            const pingResult = await redis.ping();
            if (pingResult !== 'PONG') {
                warn('Redis not responding, skipping tick');
                return;
            }
            
            await executeTick(redis);
        } catch (err) {
            error(`Tick execution error: ${err.message}`);
            // Don't stop the loop on error - just log and continue
        }
    }, intervalMs);

    return { success: true, interval: intervalMs };
}

/**
 * Stop the runtime loop.
 */
function stop() {
    if (!isRunning) {
        warn('Runtime loop not running');
        return { success: false, reason: 'not_running' };
    }

    if (loopInterval) {
        clearInterval(loopInterval);
        loopInterval = null;
    }

    isRunning = false;
    log('Runtime loop stopped');

    return { success: true };
}

/**
 * Check if loop is running.
 */
function isRunningStatus() {
    return isRunning;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    start,
    stop,
    isRunning: isRunningStatus,
    executeTick,
    getHistory,
    getCurrentMetrics,
    
    // Re-export for convenience
    runtimeScheduler,
    reconciliationEngine
};
