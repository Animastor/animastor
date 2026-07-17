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
const prometheus = require('../metrics/prometheus');

// Reconciliation cycle interval (60 seconds — not every 5s tick)
const RECONCILE_INTERVAL_MS = 60000;

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

let loopTimeout = null;
let reconcileTimeout = null;
let isRunning = false;
let currentTick = 0;
let tickInProgress = false;
let reconcileInProgress = false;
// Redis reference kept for tick scheduling
let loopRedis = null;
let loopIntervalMs = null;

// T7: Reconciliation deps (set from backend.cjs)
let reconcileDeps = {};

// T7: Store last reconcile summary for metrics
let lastReconcileSummary = null;

// Metrics tracking
const metricsHistory = [];

// ======================================================
// TICK HANDLER
// ======================================================

/**
 * Execute one fast tick loop iteration (T7: no full reconciliation).
 * T7: Reconciliation убран из быстрого tick (был Phase 2 с reconcileAll).
 * Теперь быстрый tick содержит только scheduler (scene progression),
 * counter reconciliation (лёгкий) и metrics/Prometheus.
 * Полный reconciliation запускается отдельным циклом раз в 60 секунд.
 */
async function executeTick(redis, loadedBooks = {}) {
    currentTick++;

    const startTime = Date.now();
    log(`Starting tick #${currentTick}`);

    // Phase 1: Runtime scheduler progression (with dispatch engine)
    const schedulerSummary = await runtimeScheduler.tick(redis, loadedBooks);

    // Phase 2 (T7): Counter reconciliation only — lightweight, no full scan
    const counterReport = await counterReconciliation.reconcileCounters(redis);

    // Phase 3: Store runtime metrics
    try {
        const metricsData = {
            tick: currentTick,
            duration: Date.now() - startTime,
            scheduler: schedulerSummary,
            reconcile: lastReconcileSummary,
            counter: counterReport,
            timestamp: new Date().toISOString()
        };
        await runtimeMetrics.recordSchedulerTick(redis, metricsData);
    } catch (metricsErr) {
        console.warn(`[RUNTIME] Metrics storage error: ${metricsErr.message}`);
    }

    // Phase 4: Collect Prometheus metrics
    try {
        await prometheus.collect(redis);
    } catch (promErr) {
        console.warn(`[RUNTIME] Prometheus collect error: ${promErr.message}`);
    }

    const duration = Date.now() - startTime;
    const metrics = {
        tick: currentTick,
        duration,
        scheduler: schedulerSummary,
        reconcile: lastReconcileSummary,
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
    log(`  Counter: ${counterReport.summary?.correctedCount || 0} corrected, ${counterReport.summary?.totalDrift || 0} total drift`);

    return metrics;
}

/**
 * T7: Execute one reconciliation cycle (slow, periodic).
 * Запускается отдельно от быстрого tick, раз в 60 секунд.
 * Использует distributed lock (CLEANUP_LOCK) внутри reconcileCycle,
 * поэтому не перекрывается с другими экземплярами.
 */
/**
 * Set reconciliation deps (taskHandler, postgres, orchestrator, etc.)
 * to enable full reconcileCycle phases during periodic execution.
 * Called from backend.cjs after starting the loop.
 */
function setReconcileDeps(deps) {
    reconcileDeps = deps || {};
}

async function executeReconcileCycle(redis) {
    if (reconcileInProgress) {
        log('RECONCILE_SKIPPED: Previous cycle still running');
        return { skipped: true, reason: 'cycle_running' };
    }

    reconcileInProgress = true;
    const startTime = Date.now();

    try {
        log('Starting periodic reconciliation cycle');
        const result = await reconciliationEngine.reconcileCycle(redis, reconcileDeps, { startup: false });
        const elapsed = Date.now() - startTime;

        // Store summary for metrics
        lastReconcileSummary = {
            lastRun: new Date().toISOString(),
            elapsedMs: elapsed,
            phases: result.phases,
            errors: result.summary?.errors || []
        };

        log(`Reconciliation cycle complete in ${elapsed}ms: phases [${result.phases.join(', ')}]`);
        if (result.summary?.errors?.length > 0) {
            log(`  Errors: ${result.summary.errors.length}`);
        }

        return result;
    } catch (err) {
        error(`Reconciliation cycle error: ${err.message}`);
        lastReconcileSummary = { lastRun: new Date().toISOString(), error: err.message };
        return { ok: false, error: err.message };
    } finally {
        reconcileInProgress = false;
    }
}

/**
 * Get metrics history for debugging.
 */
function getHistory(limit = 10) {
    return metricsHistory.slice(-limit);
}

/**
 * Get current runtime metrics (live, not historical).
 * T7: Разделяет быстрый tick и reconciliation cycle.
 */
async function getCurrentMetrics(redis) {
    const schedulerMetrics = await runtimeScheduler.getMetrics(redis);
    const reconciliationMetrics = await reconciliationEngine.getMetrics(redis);

    return {
        loop: {
            running: isRunning,
            tick: currentTick,
            metricsHistoryLength: metricsHistory.length,
            tickIntervalMs: loopIntervalMs,
            reconcileIntervalMs: RECONCILE_INTERVAL_MS
        },
        scheduler: schedulerMetrics,
        reconciliation: {
            ...reconciliationMetrics,
            lastRun: lastReconcileSummary
        }
    };
}

// ======================================================
// LOOP CONTROL
// ======================================================

/**
 * Schedule the next fast tick. Uses recursive setTimeout (не setInterval),
 * чтобы гарантировать отсутствие перекрывающихся tick'ов (T6.6).
 */
function scheduleNext() {
    if (!isRunning) return;

    loopTimeout = setTimeout(async () => {
        if (!isRunning || tickInProgress) return;

        tickInProgress = true;
        try {
            // Check if Redis is available before executing tick
            if (loopRedis) {
                try {
                    const pingResult = await loopRedis.ping();
                    if (pingResult !== 'PONG') {
                        warn('Redis not responding, skipping tick');
                        tickInProgress = false;
                        scheduleNext();
                        return;
                    }
                } catch (_) {
                    warn('Redis ping failed, skipping tick');
                    tickInProgress = false;
                    scheduleNext();
                    return;
                }
            }

            await executeTick(loopRedis);
        } catch (err) {
            error(`Tick execution error: ${err.message}`);
        } finally {
            tickInProgress = false;
            scheduleNext();
        }
    }, loopIntervalMs);
}

/**
 * T7: Schedule the next reconciliation cycle (slow, 60s interval).
 * Использует отдельный рекурсивный setTimeout, независимый от быстрого tick.
 * Неперекрываемость обеспечивается distributed lock в reconcileCycle + флаг reconcileInProgress.
 */
function scheduleReconcile() {
    if (!isRunning) return;

    reconcileTimeout = setTimeout(async () => {
        if (!isRunning || reconcileInProgress) return;
        await executeReconcileCycle(loopRedis);
        scheduleReconcile();
    }, RECONCILE_INTERVAL_MS);
}

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
    loopRedis = redis;
    loopIntervalMs = intervalMs;
    log(`Starting runtime loop: fast tick every ${intervalMs}ms, reconcile every ${RECONCILE_INTERVAL_MS}ms`);

    // Schedule first fast tick
    scheduleNext();

    // T7: Schedule first reconciliation cycle (after initial delay)
    scheduleReconcile();

    return { success: true, interval: intervalMs };
}

/**
 * Stop the runtime loop (both fast tick and reconciliation cycle).
 */
function stop() {
    if (!isRunning) {
        warn('Runtime loop not running');
        return { success: false, reason: 'not_running' };
    }

    // Предотвращаем запуск следующего tick/reconcile
    isRunning = false;

    if (loopTimeout) {
        clearTimeout(loopTimeout);
        loopTimeout = null;
    }

    if (reconcileTimeout) {
        clearTimeout(reconcileTimeout);
        reconcileTimeout = null;
    }

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
    setReconcileDeps,
    
    // Re-export for convenience
    runtimeScheduler,
    reconciliationEngine
};
