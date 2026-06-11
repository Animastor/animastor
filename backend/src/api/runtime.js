// ======================================================
// Runtime Debug API - v1.0.0
// ======================================================
// GET /api/v1/debug/runtime
//
// Provides detailed view of:
// - Active scenes
// - Locks
// - Stuck scenes
// - Scheduler metrics
// - Recovery actions
// - Lease status
// - Counter reconciliation
// - Runtime metrics

const runtime = require('../runtime');

const logPrefix = '[API-RUNTIME]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

// ======================================================
// API HANDLER
// ======================================================

/**
 * GET /api/v1/debug/runtime
 *
 * Returns comprehensive runtime status.
 */
async function handleRuntimeDebug(req, res) {
    const { redis } = req;

    try {
        const startTime = Date.now();

        // Get active scenes
        const activeScenes = await runtime.activeScenes.getActiveScenesDetail(redis);

        // Get scheduler metrics
        const schedulerMetrics = await runtime.scheduler.getMetrics(redis);

        // Get active scenes count
        const activeCount = await runtime.activeScenes.getActiveCount(redis);

        // Get runtime loop status
        const loopStatus = {
            running: runtime.loop.isRunning(),
            currentTick: runtime.loop.runtimeScheduler.currentTick || 0,
            intervalMs: runtime.scheduler.SCHEDULER_TICK_MS
        };

        // Get recent history
        const history = runtime.loop.getHistory(10);

        // Get reconciliation metrics
        const reconciliationMetrics = await runtime.reconciliation.getMetrics(redis);

        // Build report of inconsistencies (from in-memory history if available)
        const lastMetrics = history.length > 0 ? history[history.length - 1] : null;

        // Find stuck scenes in current active set
        const stuckScenes = [];
        for (const scene of activeScenes) {
            const stuck = await runtime.reconciliation.checkStuckScenes(
                redis,
                scene.bookId,
                scene.chapterId,
                scene.sceneId
            );
            if (stuck) {
                stuckScenes.push({
                    ...scene,
                    stuckDetails: stuck
                });
            }
        }

        // Find scenes with stale locks
        const staleLockScenes = [];
        for (const scene of activeScenes) {
            const staleLocks = await runtime.reconciliation.checkStaleLocks(
                redis,
                scene.bookId,
                scene.chapterId,
                scene.sceneId
            );
            if (staleLocks && staleLocks.length > 0) {
                staleLockScenes.push({
                    ...scene,
                    staleLocks
                });
            }
        }

        // Get orphans
        const orphanScenes = [];
        for (const scene of activeScenes) {
            const orphanVideo = await runtime.reconciliation.checkOrphanVideoState(
                redis,
                scene.bookId,
                scene.chapterId,
                scene.sceneId
            );
            const orphanImage = await runtime.reconciliation.checkOrphanImageState(
                redis,
                scene.bookId,
                scene.chapterId,
                scene.sceneId
            );

            if (orphanVideo || orphanImage) {
                orphanScenes.push({
                    ...scene,
                    orphanVideos: orphanVideo ? [orphanVideo] : [],
                    orphanImages: orphanImage ? [orphanImage] : []
                });
            }
        }

        const duration = Date.now() - startTime;

        const response = {
            timestamp: new Date().toISOString(),
            durationMs: duration,
            
            // Summary
            summary: {
                activeScenes: activeCount,
                stuckScenes: stuckScenes.length,
                staleLockScenes: staleLockScenes.length,
                orphanScenes: orphanScenes.length,
                loopRunning: loopStatus.running
            },

            // Scheduler
            scheduler: {
                metrics: schedulerMetrics,
                loop: loopStatus,
                limits: {
                    maxConcurrentAudio: runtime.scheduler.MAX_CONCURRENT_AUDIO,
                    maxConcurrentImage: runtime.scheduler.MAX_CONCURRENT_IMAGE,
                    maxConcurrentVideo: runtime.scheduler.MAX_CONCURRENT_VIDEO
                }
            },

            // Active scenes
            activeScenes: activeScenes.map(s => ({
                bookId: s.bookId,
                chapterId: s.chapterId,
                sceneId: s.sceneId,
                currentState: s.currentState,
                updatedAt: s.updatedAt,
                buildId: s.buildId
            })),

            // Problems
            stuckScenes: stuckScenes.map(s => ({
                bookId: s.bookId,
                chapterId: s.chapterId,
                sceneId: s.sceneId,
                state: s.stuckDetails.state,
                ageMinutes: s.stuckDetails.ageMinutes,
                thresholdMinutes: s.stuckDetails.threshold
            })),

            staleLockScenes: staleLockScenes.map(s => ({
                bookId: s.bookId,
                chapterId: s.chapterId,
                sceneId: s.sceneId,
                staleLocks: s.staleLocks.map(l => ({
                    type: l.type,
                    lockKey: l.lockKey,
                    recommendation: l.recommendation
                }))
            })),

            orphanScenes: orphanScenes.map(s => ({
                bookId: s.bookId,
                chapterId: s.chapterId,
                sceneId: s.sceneId,
                orphanVideos: s.orphanVideos,
                orphanImages: s.orphanImages
            })),

            // Reconciliation
            reconciliation: reconciliationMetrics,

            // History (last 10 ticks)
            history: history.map(h => ({
                tick: h.tick,
                durationMs: h.duration,
                scheduler: h.scheduler,
                reconcile: h.reconcile,
                timestamp: h.timestamp
            })),

            // Recommendations for fixes
            recommendations: getRecommendations(stuckScenes, staleLockScenes, orphanScenes)
        };

        log(`Debug report generated: ${activeCount} active scenes, ${duration}ms`);

        res.json(response);

    } catch (err) {
        log(`Error generating debug report: ${err.message}`);
        res.status(500).json({
            error: 'internal_error',
            message: err.message
        });
    }
}

/**
 * Generate recommendations based on current problems.
 */
function getRecommendations(stuckScenes, staleLockScenes, orphanScenes) {
    const recommendations = [];

    for (const scene of stuckScenes) {
        recommendations.push({
            action: 'MOVE_TO_PENDING',
            scene: scene,
            reason: `Stuck in ${scene.state} for ${scene.ageMinutes} minutes`,
            priority: 'high'
        });
    }

    for (const scene of staleLockScenes) {
        recommendations.push({
            action: 'RELEASE_STALE_LOCKS',
            scene: scene,
            reason: 'Locks exist without active heartbeat',
            priority: 'medium'
        });
    }

    for (const scene of orphanScenes) {
        for (const video of scene.orphanVideos) {
            recommendations.push({
                action: 'REGENERATE_VIDEO',
                scene: scene,
                reason: `VIDEO_READY but no video file at ${video.missingFile}`,
                priority: 'high'
            });
        }
        for (const image of scene.orphanImages) {
            recommendations.push({
                action: 'REGENERATE_IMAGE',
                scene: scene,
                reason: 'IMAGE_READY but no image file',
                priority: 'high'
            });
        }
    }

    return recommendations;
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/leases
// ======================================================

async function handleRuntimeLeases(req, res) {
    const { redis } = req;

    try {
        const leases = await runtime.dispatch.getActiveLeases(redis);
        const quotas = await runtime.dispatch.getQuotaStatus(redis);

        log(`Leases debug: ${leases.length} active leases`);

        res.json({
            timestamp: new Date().toISOString(),
            activeLeases: leases,
            quotas
        });
    } catch (err) {
        log(`Error fetching leases: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/dispatches
// ======================================================

async function handleRuntimeDispatches(req, res) {
    const { redis } = req;

    try {
        const limit = parseInt(req.query.limit || '50', 10);
        const dispatches = await runtime.dispatch.getActiveDispatches(redis, limit);
        const metrics = await runtime.dispatch.getMetrics(redis);

        log(`Dispatches debug: ${dispatches.length} active dispatches`);

        res.json({
            timestamp: new Date().toISOString(),
            activeDispatches: dispatches,
            metrics
        });
    } catch (err) {
        log(`Error fetching dispatches: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/quotas
// ======================================================

async function handleRuntimeQuotas(req, res) {
    const { redis } = req;

    try {
        const quotas = await runtime.dispatch.getQuotaStatus(redis);
        const metrics = await runtime.dispatch.getMetrics(redis);

        log(`Quotas debug: current status`);

        res.json({
            timestamp: new Date().toISOString(),
            quotas,
            metrics
        });
    } catch (err) {
        log(`Error fetching quotas: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/metrics
// ======================================================

async function handleRuntimeMetrics(req, res) {
    const { redis } = req;

    try {
        const currentMetrics = await runtime.metrics.getCurrentMetrics(redis);
        const history = await runtime.metrics.getMetricsHistory(redis, 50);
        const driftReport = await runtime.counterReconciliation.checkForDrift(redis);
        const leaseMetrics = await runtime.leaseManager.getRenewalMetrics();

        log(`Runtime metrics: ${currentMetrics.activeScenes} active scenes`);

        res.json({
            timestamp: new Date().toISOString(),
            current: currentMetrics,
            history: history.metrics,
            drift: driftReport,
            leaseRenewals: {
                count: leaseMetrics.total,
                byStage: leaseMetrics.byStage
            }
        });
    } catch (err) {
        log(`Error fetching metrics: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/counters
// ======================================================

async function handleRuntimeCounters(req, res) {
    const { redis } = req;

    try {
        const status = await runtime.counterReconciliation.getCountersStatus(redis);
        const counterReport = await runtime.counterReconciliation.reconcileCounters(redis);

        log(`Counters debug: ${Object.keys(status).length} stages`);

        res.json({
            timestamp: new Date().toISOString(),
            status,
            recentCorrection: counterReport.summary,
            stages: counterReport.stages
        });
    } catch (err) {
        log(`Error fetching counters: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/drift
// ======================================================

async function handleRuntimeDrift(req, res) {
    const { redis } = req;

    try {
        const driftReport = await runtime.counterReconciliation.checkForDrift(redis);
        const reconciliationReport = await runtime.counterReconciliation.reconcileCounters(redis);

        log(`Drift debug: ${driftReport.issues.length} issues`);

        res.json({
            timestamp: new Date().toISOString(),
            hasDrift: driftReport.hasDrift,
            issues: driftReport.issues,
            reconciliationReport: reconciliationReport,
            current: reconciliationReport.stages
        });
    } catch (err) {
        log(`Error fetching drift: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/snapshot/:bookId/:chapterId/:sceneId
// ======================================================

async function handleRuntimeSnapshot(req, res) {
    const { redis } = req;
    const { bookId, chapterId, sceneId } = req.params;

    try {
        log(`Snapshot request: ${bookId}/${chapterId}/${sceneId}`);

        const snapshot = await runtime.debug.snapshotManager.generateSceneSnapshot(
            redis,
            bookId,
            chapterId,
            sceneId
        );

        if (!snapshot) {
            return res.status(404).json({
                error: 'not_found',
                message: `Scene ${bookId}/${chapterId}/${sceneId} not found`
            });
        }

        // Store snapshot for quick retrieval
        await runtime.debug.snapshotManager.storeSnapshot(
            redis,
            bookId,
            chapterId,
            sceneId,
            snapshot
        );

        res.json({
            timestamp: new Date().toISOString(),
            snapshot
        });
    } catch (err) {
        log(`Error generating snapshot: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/snapshots/:bookId
// ======================================================

async function handleRuntimeSnapshots(req, res) {
    const { redis } = req;
    const { bookId } = req.params;

    try {
        log(`Build snapshots request: ${bookId}`);

        const snapshot = await runtime.debug.snapshotManager.generateBuildSnapshot(redis, bookId);

        res.json({
            timestamp: new Date().toISOString(),
            ...snapshot
        });
    } catch (err) {
        log(`Error generating build snapshots: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/failures
// ======================================================

async function handleRuntimeFailures(req, res) {
    const { redis } = req;

    try {
        const typeKeys = runtime.failureTaxonomy.getFailureTypeKeys();
        const byType = {};

        for (const type of typeKeys) {
            const count = await runtime.failureTaxonomy.getFailureMetrics(redis);
            byType[type] = count[type] || 0;
        }

        // Get retry history
        const retryCount = await runtime.retryManager.getTotalRetryCount(redis);
        const retryHistory = await runtime.retryManager.getSceneRetryHistory(redis, 'dummy', 'dummy', 'dummy', 20);

        log(`Failures debug: ${retryCount} total retries`);

        res.json({
            timestamp: new Date().toISOString(),
            byType,
            totalRetries: retryCount,
            retryHistory: retryHistory.slice(0, 20)
        });
    } catch (err) {
        log(`Error fetching failures: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/retries
// ======================================================

async function handleRuntimeRetries(req, res) {
    const { redis } = req;

    try {
        const metrics = await runtime.retryManager.getRetryMetrics(redis);
        const policyInfo = {
            transient: runtime.failureTaxonomy.getRetryPolicy(runtime.failureTaxonomy.FailureType.TRANSIENT),
            permanent: runtime.failureTaxonomy.getRetryPolicy(runtime.failureTaxonomy.FailureType.PERMANENT),
            infrastructure: runtime.failureTaxonomy.getRetryPolicy(runtime.failureTaxonomy.FailureType.INFRASTRUCTURE),
            orchestration: runtime.failureTaxonomy.getRetryPolicy(runtime.failureTaxonomy.FailureType.ORCHESTRATION)
        };

        log(`Retries debug: ${metrics.totalRetries} total retries`);

        res.json({
            timestamp: new Date().toISOString(),
            totalRetries: metrics.totalRetries,
            byType: metrics.byType,
            policy: policyInfo
        });
    } catch (err) {
        log(`Error fetching retries: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/retention
// ======================================================

async function handleRuntimeRetention(req, res) {
    const { redis } = req;

    try {
        const status = await runtime.retentionManager.getRetentionStatus(redis);
        const metrics = await runtime.metrics.getMetricsReport(redis);

        log(`Retention debug: ${status.eventJournal.totalEntries} event entries`);

        res.json({
            timestamp: new Date().toISOString(),
            status,
            metrics,
            policies: {
                eventJournal: {
                    maxEntries: runtime.retentionManager.EVENT_JOURNAL_MAX_ENTRIES,
                    maxAgeMs: runtime.retentionManager.EVENT_JOURNAL_MAX_AGE_MS
                },
                metrics: {
                    retentionLimit: runtime.retentionManager.METRICS_RETENTION_LIMIT,
                    historyTtl: runtime.retentionManager.METRICS_HISTORY_TTL
                },
                snapshot: {
                    maxAgeMs: runtime.retentionManager.SNAPSHOT_MAX_AGE_MS
                }
            }
        });
    } catch (err) {
        log(`Error fetching retention: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: POST /api/v1/debug/runtime/cleanup/retention
// ======================================================

async function handleRuntimeCleanupRetention(req, res) {
    const { redis } = req;

    try {
        const result = {
            eventJournals: await runtime.retentionManager.trimAllEventJournals(redis),
            metricsHistory: await runtime.retentionManager.trimMetricsHistory(redis),
            dispatchMetadata: await runtime.retentionManager.cleanupStaleDispatchMetadata(redis),
            snapshots: await runtime.retentionManager.cleanupExpiredSnapshots(redis),
            leaseHistory: await runtime.retentionManager.cleanupLeaseHistory(redis),
            activeScenes: await runtime.retentionManager.cleanupActiveScenesIndex(redis)
        };

        log(`Retention cleanup: processed ${JSON.stringify(result)}`);

        res.json({
            timestamp: new Date().toISOString(),
            cleanupCompleted: true,
            results: result
        });
    } catch (err) {
        log(`Error running retention cleanup: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/stuck-scenes
// ======================================================

async function handleRuntimeStuckScenes(req, res) {
    const { redis } = req;

    try {
        const stuckScenes = await runtime.retentionManager.getStuckScenes(redis);

        log(`Stuck scenes: ${stuckScenes.length} scenes`);

        res.json({
            timestamp: new Date().toISOString(),
            stuckScenes,
            total: stuckScenes.length
        });
    } catch (err) {
        log(`Error fetching stuck scenes: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: DELETE /api/v1/debug/runtime/stuck-scenes
// ======================================================

async function handleRuntimeClearStuckScenes(req, res) {
    const { redis } = req;

    try {
        const result = await runtime.retentionManager.clearStuckScenes(redis);

        log(`Stuck scenes cleared: ${result.count} scenes`);

        res.json({
            timestamp: new Date().toISOString(),
            cleared: true,
            count: result.count
        });
    } catch (err) {
        log(`Error clearing stuck scenes: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/circuits
// ======================================================

async function handleRuntimeCircuits(req, res) {
    const { redis } = req;

    try {
        const circuits = await runtime.debug.circuitBreaker.getCircuitsStatus(redis);
        const allOpen = await runtime.debug.circuitBreaker.hasAnyOpenCircuit(redis);

        log(`Circuits debug: ${allOpen.openCircuits.length} open circuits`);

        res.json({
            timestamp: new Date().toISOString(),
            circuits,
            hasOpenCircuits: allOpen.hasOpen,
            openCircuits: allOpen.openCircuits,
            globalHealthy: await runtime.debug.circuitBreaker.isRuntimeHealthy(redis)
        });
    } catch (err) {
        log(`Error fetching circuits: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/priorities
// ======================================================

async function handleRuntimePriorities(req, res) {
    const { redis } = req;

    try {
        const queueStats = await runtime.debug.priorityManager.getQueueStats(redis);
        const allPriorities = await runtime.debug.priorityManager.getAllPriorities(redis);

        log(`Priorities debug: ${queueStats.total} scenes in queue`);

        res.json({
            timestamp: new Date().toISOString(),
            queueStats,
            allPriorities,
            config: runtime.debug.priorityManager.PRIORITY_CONFIG
        });
    } catch (err) {
        log(`Error fetching priorities: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/fairness
// ======================================================

async function handleRuntimeFairness(req, res) {
    const { redis } = req;

    try {
        const report = await runtime.debug.fairness.getFairnessReport(redis);

        log(`Fairness debug: ${report.bookScores.length} books, ${report.distribution.detected ? 'unfair' : 'fair'}`);

        res.json({
            timestamp: new Date().toISOString(),
            report,
            services: runtime.debug.circuitBreaker.SERVICE_TARGETS,
            stateLabels: runtime.debug.circuitBreaker.CircuitState
        });
    } catch (err) {
        log(`Error fetching fairness: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/retry-budgets
// ======================================================

async function handleRuntimeRetryBudgets(req, res) {
    const { redis } = req;

    try {
        const globalOverview = await runtime.debug.retryBudget.getGlobalBudgetOverview(redis);

        log(`Retry budgets debug: total retries used ${globalOverview.global.current}`);

        res.json({
            timestamp: new Date().toISOString(),
            globalOverview,
            config: runtime.debug.retryBudget,
            failureTypeLimits: runtime.failureTaxonomy.FailureType
        });
    } catch (err) {
        log(`Error fetching retry budgets: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/policies
// ======================================================

async function handleRuntimePolicies(req, res) {
    const { redis } = req;

    try {
        const circuitStatus = await runtime.debug.circuitBreaker.getCircuitsStatus(redis);
        const fairnessReport = await runtime.debug.fairness.getFairnessReport(redis);
        const queueStats = await runtime.debug.priorityManager.getQueueStats(redis);
        const budgetOverview = await runtime.debug.retryBudget.getGlobalBudgetOverview(redis);
        const runtimeMetrics = await runtime.metrics.getCurrentMetrics(redis);

        log(`Policies debug: policy engine overview`);

        res.json({
            timestamp: new Date().toISOString(),
            circuitStatus,
            fairnessReport,
            priorityStats: {
                queueStats,
                totalScenes: queueStats.total,
                highPriority: queueStats.high,
                normalPriority: queueStats.normal,
                lowPriority: queueStats.low
            },
            retryBudget: {
                global: budgetOverview.global,
                config: runtime.debug.retryBudget.BUDGET_CONFIG
            },
            runtimeMetrics,
            config: runtime.policyEngine.POLICY_CONFIG,
            policyEngine: {
                canEvaluate: true,
                unifiedAuthority: true
            }
        });
    } catch (err) {
        log(`Error fetching policies: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/workloads
// ======================================================

async function handleRuntimeWorkloads(req, res) {
    const { redis } = req;

    try {
        // Get distribution of workloads
        const pendingStats = await runtime.workloadClassifier.getPendingWorkloadStats(redis);

        // Sample a few scenes for classification
        const workloads = [];
        const pattern = 'animastor:scene-state:*';
        let cursor = 0;
        const scanned = [];

        do {
            const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 10);
            cursor = parseInt(result[0], 10);
            const keys = result[1];

            for (const key of keys) {
                if (scanned.length >= 10) break;

                const raw = await redis.get(key);
                if (!raw) continue;

                try {
                    const state = JSON.parse(raw);
                    const parts = key.split(':');
                    scanned.push({
                        bookId: parts[2],
                        chapterId: parts[3],
                        sceneId: parts[4]
                    });
                } catch (e) {
                    // Skip
                }
            }
            if (scanned.length >= 10) break;
        } while (cursor !== 0);

        // Classify each scanned scene
        for (const scene of scanned) {
            try {
                const classification = await runtime.workloadClassifier.getClassification(redis, {
                    book_id: scene.bookId,
                    chapter_id: scene.chapterId,
                    scene_id: scene.sceneId
                });
                workloads.push({
                    ...scene,
                    workload: classification.workload,
                    score: classification.score,
                    factors: classification.factors
                });
            } catch (e) {
                // Skip scenes that fail to classify
            }
        }

        log(`Workloads debug: ${pendingStats.total} pending scenes, ${workloads.length} samples`);

        res.json({
            timestamp: new Date().toISOString(),
            pendingDistribution: pendingStats,
            workloadSamples: workloads,
            thresholds: runtime.workloadClassifier.WORKLOAD_CONFIG.costThresholds,
            config: runtime.workloadClassifier.WORKLOAD_CONFIG
        });
    } catch (err) {
        log(`Error fetching workloads: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/costs
// ======================================================

async function handleRuntimeCosts(req, res) {
    const { redis } = req;

    try {
        // Get cost budget summary
        const costSummary = await runtime.costEstimator.getRuntimeCostSummary(redis);

        // Sample scene costs
        const sceneCosts = [];
        const pattern = 'animastor:scene-state:*';
        let cursor = 0;
        const scanned = [];

        do {
            const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 10);
            cursor = parseInt(result[0], 10);
            const keys = result[1];

            for (const key of keys) {
                if (scanned.length >= 10) break;

                const raw = await redis.get(key);
                if (!raw) continue;

                try {
                    const state = JSON.parse(raw);
                    const parts = key.split(':');
                    scanned.push({
                        bookId: parts[2],
                        chapterId: parts[3],
                        sceneId: parts[4]
                    });
                } catch (e) {
                    // Skip
                }
            }
            if (scanned.length >= 10) break;
        } while (cursor !== 0);

        // Estimate costs for each scene
        for (const scene of scanned) {
            try {
                const costEstimate = await runtime.costEstimator.estimateSceneCost(redis, {
                    book_id: scene.bookId,
                    chapter_id: scene.chapterId,
                    scene_id: scene.sceneId
                });
                sceneCosts.push({
                    ...scene,
                    estimatedCost: costEstimate.estimatedCost,
                    estimatedGpuSeconds: costEstimate.estimatedGpuSeconds,
                    components: costEstimate.components
                });
            } catch (e) {
                // Skip scenes that fail to estimate
            }
        }

        log(`Costs debug: ${sceneCosts.length} cost estimations`);

        res.json({
            timestamp: new Date().toISOString(),
            runtimeSummary: costSummary,
            sceneCosts: sceneCosts.slice(0, 10),
            config: runtime.costEstimator.COST_CONFIG,
            estimates: {
                audioPerSec: runtime.costEstimator.COST_CONFIG.gpuCosts.audio,
                imagePerCount: runtime.costEstimator.COST_CONFIG.gpuCosts.image,
                videoPerSec: runtime.costEstimator.COST_CONFIG.gpuCosts.video
            }
        });
    } catch (err) {
        log(`Error fetching costs: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/admission
// ======================================================
// Phase 11: Admission control debug endpoint

async function handleRuntimeAdmission(req, res) {
    const { redis } = req;

    try {
        const status = await runtime.admission.getStatus(redis);

        log(`Admission debug: status retrieved`);

        res.json({
            timestamp: new Date().toISOString(),
            status,
            config: runtime.admission.ADMISSION_CONFIG,
            decisions: runtime.admission.AdmissionDecisionType,
            rejections: runtime.admission.RejectionReason
        });
    } catch (err) {
        log(`Error fetching admission status: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/admission/history/:bookId/:chapterId/:sceneId
// ======================================================

async function handleRuntimeAdmissionHistory(req, res) {
    const { redis } = req;
    const { bookId, chapterId, sceneId } = req.params;
    const limit = parseInt(req.query.limit || '10', 10);

    try {
        const history = await runtime.admission.getHistory(redis, bookId, chapterId, sceneId, limit);

        log(`Admission history: ${bookId}/${chapterId}/${sceneId} (${history.length} entries)`);

        res.json({
            timestamp: new Date().toISOString(),
            scene: { bookId, chapterId, sceneId },
            history,
            limit
        });
    } catch (err) {
        log(`Error fetching admission history: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/policies/composed
// ======================================================
// Phase 11: Policy composition debug endpoint

async function handleRuntimePoliciesComposed(req, res) {
    const { redis } = req;
    const bookId = req.query.bookId || 'demo';
    const chapterId = req.query.chapterId || '0';
    const sceneId = req.query.sceneId || '0';
    const stage = req.query.stage || 'audio';

    try {
        const scene = {
            book_id: bookId,
            chapter_id: chapterId,
            scene_id: sceneId
        };

        const status = await runtime.policyEngine.getComposedPolicyStatus(redis, scene, stage);

        log(`Policy composition debug: ${bookId}/${chapterId}/${sceneId}:${stage}`);

        res.json({
            timestamp: new Date().toISOString(),
            scene: scene,
            stage,
            status,
            precedenceOrder: runtime.policyEngine.POLICY_CONFIG.policyPrecedence,
            policies: status.policies
        });
    } catch (err) {
        log(`Error fetching policy composition: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/persistence
// ======================================================
// Phase 11: Persistence debug endpoint

async function handleRuntimePersistence(req, res) {
    const { redis } = req;

    try {
        const persistenceStatus = await runtime.persistence.getPersistenceStatus(redis);

        log(`Persistence debug: status retrieved`);

        res.json({
            timestamp: new Date().toISOString(),
            status: persistenceStatus,
            config: runtime.persistence.PERSISTENCE_CONFIG,
            stateTypes: runtime.persistence.RuntimeStateType
        });
    } catch (err) {
        log(`Error fetching persistence status: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/snapshots/compacted
// ======================================================
// Phase 11: Snapshot compaction debug endpoint

async function handleRuntimeSnapshotsCompacted(req, res) {
    const { redis } = req;

    try {
        const status = await runtime.compaction.getCompactionStatus(redis);
        const counts = await runtime.compaction.getCompactedCounts(redis);

        log(`Compaction debug: compacted entries found`);

        res.json({
            timestamp: new Date().toISOString(),
            status,
            compactedCounts: counts,
            config: runtime.compaction.COMPACTION_CONFIG,
            summaryTypes: runtime.compaction.EventType
        });
    } catch (err) {
        log(`Error fetching compaction status: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/decision/:bookId/:chapterId/:sceneId
// ======================================================
// Phase 12: Decision trace explainability endpoint

async function handleRuntimeDecision(req, res) {
    const { redis } = req;
    const { bookId, chapterId, sceneId } = req.params;
    const decision = req.query.decision || 'admission';

    try {
        log(`Decision trace request: ${bookId}/${chapterId}/${sceneId}/${decision}`);

        const explanation = await runtime.decisionTrace.getDecisionExplanation(
            redis,
            bookId,
            chapterId,
            sceneId,
            decision
        );

        res.json({
            timestamp: new Date().toISOString(),
            ...explanation,
            traceConfig: runtime.decisionTrace.TraceConfig,
            traceTypes: runtime.decisionTrace.TraceType
        });
    } catch (err) {
        log(`Error fetching decision trace: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/policy-chain/:bookId/:chapterId/:sceneId
// ======================================================

async function handleRuntimePolicyChain(req, res) {
    const { redis } = req;
    const { bookId, chapterId, sceneId } = req.params;

    try {
        log(`Policy chain request: ${bookId}/${chapterId}/${sceneId}`);

        const chain = await runtime.decisionTrace.getPolicyChainExplanation(
            redis,
            bookId,
            chapterId,
            sceneId
        );

        res.json({
            timestamp: new Date().toISOString(),
            ...chain
        });
    } catch (err) {
        log(`Error fetching policy chain: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/feedback
// ======================================================

async function handleRuntimeFeedback(req, res) {
    const { redis } = req;

    try {
        log(`Feedback debug: status retrieved`);

        const stability = await runtime.feedback.calculateStabilityScore(redis);
        const feedbackStatus = await runtime.feedback.getFeedbackStatus(redis);
        const costModelStatus = await runtime.feedback.getCostModelStatus(redis);

        res.json({
            timestamp: new Date().toISOString(),
            stability: {
                score: stability.score,
                status: stability.score >= 80 ? 'stable' : stability.score >= 60 ? 'warning' : 'unstable'
            },
            feedbackStatus,
            costModelStatus,
            config: runtime.feedback.FEEDBACK_CONFIG
        });
    } catch (err) {
        log(`Error fetching feedback: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/governance-metrics
// ======================================================

async function handleRuntimeGovernanceMetrics(req, res) {
    const { redis } = req;

    try {
        const metrics = await runtime.governanceMetrics.getGovernanceMetrics(redis);

        log(`Governance metrics: fetched`);

        res.json({
            timestamp: new Date().toISOString(),
            ...metrics,
            config: runtime.governanceMetrics.METRICS_CONFIG
        });
    } catch (err) {
        log(`Error fetching governance metrics: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/adaptive-adjustments
// ======================================================

async function handleRuntimeAdaptiveAdjustments(req, res) {
    const { redis } = req;
    const limit = parseInt(req.query.limit || '20', 10);

    try {
        const adjustments = await runtime.admission.getAdaptiveAdjustmentsHistory(redis, limit);
        const feedbackAdjustments = await runtime.feedback.getRecentAdjustments(redis, limit);

        log(`Adaptive adjustments: ${adjustments.length} from admission, ${feedbackAdjustments.length} from feedback`);

        res.json({
            timestamp: new Date().toISOString(),
            admissionAdjustments: adjustments,
            feedbackAdjustments,
            total: adjustments.length + feedbackAdjustments.length,
            config: runtime.feedback.FEEDBACK_CONFIG
        });
    } catch (err) {
        log(`Error fetching adaptive adjustments: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/decision-history
// ======================================================

async function handleRuntimeDecisionHistory(req, res) {
    const { redis } = req;
    const limit = parseInt(req.query.limit || '50', 10);

    try {
        // Scan for decision history keys
        const keys = await redis.keys('animastor:admission:history:*');
        const history = [];

        for (const key of keys) {
            const entries = await redis.lrange(key, 0, limit - 1);
            const parts = key.split(':');
            history.push({
                scene: {
                    bookId: parts[2],
                    chapterId: parts[3],
                    sceneId: parts[4]
                },
                decisions: entries.map(e => JSON.parse(e))
            });
        }

        // Flatten and sort
        const allDecisions = history.flatMap(h =>
            h.decisions.map(d => ({ ...d, scene: h.scene }))
        ).sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);

        const summary = await runtime.governanceMetrics.getDecisionTypesSummary(redis);

        log(`Decision history: ${allDecisions.length} decisions across ${history.length} scenes`);

        res.json({
            timestamp: new Date().toISOString(),
            decisions: allDecisions,
            scenes: history.length,
            summary
        });
    } catch (err) {
        log(`Error fetching decision history: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/governance-health
// ======================================================
// Phase 13: Governance health score endpoint

async function handleRuntimeGovernanceHealth(req, res) {
    const { redis } = req;

    try {
        const health = await runtime.governanceHealth.getGovernanceHealthScore(redis);
        const status = await runtime.governanceHealth.getHealthStatus(redis);
        const alerts = await runtime.governanceHealth.getHealthAlerts(redis);
        const trends = await runtime.governanceHealth.getHealthTrends(redis, 24);
        const distribution = await runtime.governanceHealth.getHealthScoreDistribution(redis, 168);

        log(`Governance health: ${health.status} (${health.score}/100)`);

        res.json({
            timestamp: new Date().toISOString(),
            health,
            status,
            alerts,
            trends,
            distribution,
            config: runtime.governanceHealth.GOVERNANCE_HEALTH_CONFIG
        });
    } catch (err) {
        log(`Error fetching governance health: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/adaptation
// ======================================================

async function handleRuntimeAdaptation(req, res) {
    const { redis } = req;

    try {
        const summary = await runtime.adaptationController.getAdaptationSummary(redis);
        const cooldowns = await runtime.adaptationController.getCooldownStatus(redis);
        const status = await runtime.adaptationController.getAdaptationStatus(redis);
        const recent = await runtime.adaptationController.getRecentAdjustments(redis, 50);

        log(`Adaptation debug: ${Object.keys(summary).length} parameters`);

        res.json({
            timestamp: new Date().toISOString(),
            summary,
            cooldowns,
            status,
            recentAdjustments: recent,
            config: runtime.adaptationController.ADAPTATION_CONFIG
        });
    } catch (err) {
        log(`Error fetching adaptation: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/trace-compaction
// ======================================================

async function handleRuntimeTraceCompaction(req, res) {
    const { redis } = req;

    try {
        const status = await runtime.traceCompactor.getCompactionStatus(redis);
        const summaries = await runtime.traceCompactor.getSummaryStats(redis);
        const ageDist = await runtime.traceCompactor.getTraceAgeDistribution(redis);
        const report = await runtime.traceCompactor.generateCompactionReport(redis);

        log(`Trace compaction: ${status.summaries.totalSummaries} summaries`);

        res.json({
            timestamp: new Date().toISOString(),
            status,
            summaries,
            ageDistribution: ageDist,
            report,
            config: runtime.traceCompactor.TRACE_COMPACTOR_CONFIG
        });
    } catch (err) {
        log(`Error fetching trace compaction: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/stability-score
// ======================================================

async function handleRuntimeStabilityScore(req, res) {
    const { redis } = req;

    try {
        const score = await runtime.governanceStability.calculateStabilityScore(redis);
        const history = await runtime.governanceStability.getStabilityHistory(redis, 20);
        const oscillations = await runtime.governanceStability.getRecentOscillations(redis, 20);
        const conflicts = await runtime.governanceStability.getRecentConflicts(redis, 20);
        const cooldowns = await runtime.governanceStability.getOscillationCooldowns(redis);

        log(`Stability score: ${score.stabilityScore} (${score.status})`);

        res.json({
            timestamp: new Date().toISOString(),
            score,
            history,
            oscillations,
            conflicts,
            cooldowns,
            config: runtime.governanceStability.GOVERNANCE_STABILITY_CONFIG
        });
    } catch (err) {
        log(`Error fetching stability score: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/health-alerts
// ======================================================

async function handleRuntimeHealthAlerts(req, res) {
    const { redis } = req;

    try {
        const alerts = await runtime.governanceHealth.getHealthAlerts(redis);
        const isHealthy = await runtime.governanceHealth.isGovernanceHealthy(redis);
        const history = await runtime.governanceHealth.getHealthHistory(redis, 50);

        log(`Health alerts: ${alerts.alerts.length} alerts`);

        res.json({
            timestamp: new Date().toISOString(),
            isHealthy,
            alerts,
            history,
            config: runtime.governanceHealth.GOVERNANCE_HEALTH_CONFIG
        });
    } catch (err) {
        log(`Error fetching health alerts: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/simulation
// ======================================================
// Phase 14: Policy simulation endpoint

async function handleRuntimeSimulation(req, res) {
    const { redis } = req;
    const { workloadId, workloadClass, runtime_type, priority } = req.query;

    try {
        // Build runtime state
        const runtimeState = {
            activeScenes: await runtime.activeScenes.getActiveCount(redis),
            activeLeases: await runtime.activeScenes.getActiveLeasesByType(redis),
            quotaUtilization: await runtime.activeScenes.getQuotaUtilization(redis),
            overloadScore: await runtime.overload.getOverloadScore(redis),
            overloadState: await runtime.overload.getOverloadState(redis),
            retryState: await runtime.debug.retryBudget.getRuntimeRetryState(redis),
            policyState: await runtime.policyEngine.getPolicyState(redis)
        };

        // Build workload
        const workload = {
            id: workloadId || 'simulated_workload',
            class: workloadClass || 'audio',
            runtime_type: runtime_type || workloadClass || 'audio',
            priority: parseInt(priority, 10) || 50
        };

        // Run simulation
        const simulation = await runtime.policySimulator.simulateDispatch(runtimeState, workload);

        log(`Simulation complete for ${workload.class}`);

        res.json({
            timestamp: new Date().toISOString(),
            simulation,
            runtimeState,
            config: runtime.policySimulator.SIMULATION_CONFIG
        });
    } catch (err) {
        log(`Error in simulation: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/replay
// ======================================================

async function handleRuntimeFailureReplay(req, res) {
    const { redis } = req;
    const { limit = 50, mode = 'deterministic', acceleration } = req.query;

    try {
        // Extract failure events
        const failureEvents = await runtime.failureReplay.extractFailureEvents(redis, parseInt(limit, 10));

        if (failureEvents.length === 0) {
            return res.json({
                timestamp: new Date().toISOString(),
                message: 'No failure events found',
                events: []
            });
        }

        let session;
        if (mode === 'accelerated' && acceleration) {
            session = await runtime.failureReplay.createReplaySession(redis, {
                mode: runtime.failureReplay.FAILURE_REPLAY_CONFIG.modes.ACCELERATED,
                name: `replay_${Date.now()}`,
                events: failureEvents,
                accelerationFactor: parseInt(acceleration, 10) || 10
            });
        } else {
            session = await runtime.failureReplay.createReplaySession(redis, {
                mode: mode === 'deterministic' ? 
                    runtime.failureReplay.FAILURE_REPLAY_CONFIG.modes.DETERMINISTIC :
                    runtime.failureReplay.FAILURE_REPLAY_CONFIG.modes.PARTIAL,
                name: `replay_${Date.now()}`,
                events: failureEvents
            });
        }

        // Run replay
        const result = await runtime.failureReplay.executeReplay(redis, session, failureEvents);

        log(`Failure replay complete: ${result.summary.successful}/${result.summary.totalEvents} recovered`);

        res.json({
            timestamp: new Date().toISOString(),
            session,
            result,
            config: runtime.failureReplay.FAILURE_REPLAY_CONFIG
        });
    } catch (err) {
        log(`Error in failure replay: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/governance-diff
// ======================================================

async function handleRuntimeGovernanceDiff(req, res) {
    const { redis } = req;
    const { version1, version2, policy1, policy2 } = req.query;

    try {
        if (version1 && version2) {
            // Compare versions
            const versionDiff = await runtime.policyVersioning.getPolicyVersionDiff(redis, version1, version2);

            return res.json({
                timestamp: new Date().toISOString(),
                versionDiff,
                config: runtime.policyVersioning.POLICY_VERSIONING_CONFIG
            });
        }

        if (policy1 && policy2) {
            // Compare policies directly
            const oldPolicy = policy1.startsWith('{') ? JSON.parse(policy1) : policy1;
            const newPolicy = policy2.startsWith('{') ? JSON.parse(policy2) : policy2;

            const diff = runtime.policyVersioning.calculatePolicyDiff(
                { policies: oldPolicy },
                { policies: newPolicy }
            );

            return res.json({
                timestamp: new Date().toISOString(),
                diff,
                config: runtime.policyVersioning.POLICY_VERSIONING_CONFIG
            });
        }

        // Compare current vs proposed
        const currentPolicy = await runtime.policyEngine.getPolicyState(redis);
        const proposedPolicy = { ...currentPolicy }; // In production, load from config

        const diff = runtime.policyVersioning.calculateGovernanceDiff(
            { decision: { allowed: true } },
            { decision: { allowed: true } }
        );

        res.json({
            timestamp: new Date().toISOString(),
            currentPolicy: currentPolicy,
            diff,
            config: runtime.policyVersioning.POLICY_VERSIONING_CONFIG
        });
    } catch (err) {
        log(`Error in governance diff: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/policies/versions
// ======================================================

async function handleRuntimePolicyVersions(req, res) {
    const { redis } = req;

    try {
        const status = await runtime.policyVersioning.getPolicyVersionStatus(redis);
        const history = await runtime.policyVersioning.getPolicyVersionHistory(redis, 50);

        res.json({
            timestamp: new Date().toISOString(),
            status,
            history,
            config: runtime.policyVersioning.POLICY_VERSIONING_CONFIG
        });
    } catch (err) {
        log(`Error fetching policy versions: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/sandbox
// ======================================================

async function handleRuntimeSandboxExperiments(req, res) {
    const { redis } = req;
    const { experimentId } = req.query;

    try {
        let experiments;

        if (experimentId) {
            const experiment = await runtime.sandbox.getSandboxExperiment(redis, experimentId);
            experiments = experiment ? [experiment] : [];
        } else {
            experiments = await runtime.sandbox.listSandboxExperiments(redis, 20);
        }

        const status = await runtime.sandbox.getSandboxStatus(redis);

        res.json({
            timestamp: new Date().toISOString(),
            experiments,
            status,
            config: runtime.sandbox.SANDBOX_CONFIG
        });
    } catch (err) {
        log(`Error fetching sandbox experiments: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/policy-evolution
// ======================================================

async function handleRuntimePolicyEvolution(req, res) {
    const { redis } = req;

    try {
        const history = await runtime.policyVersioning.getPolicyVersionHistory(redis, 50);
        const allVersions = await runtime.policyVersioning.getAllPolicyVersions(redis);

        // Analyze evolution
        const evolution = runtime.policyEvolution ?
            runtime.policyEvolution.trackPolicyEvolution(history) :
            { totalPolicies: history[0]?.snapshot?.policies ? Object.keys(history[0].snapshot.policies).length : 0 };

        res.json({
            timestamp: new Date().toISOString(),
            evolution,
            allVersions,
            history: history.slice(0, 20),
            config: runtime.policyVersioning.POLICY_VERSIONING_CONFIG
        });
    } catch (err) {
        log(`Error fetching policy evolution: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/invariants
// ======================================================
// Phase 15: Invariant status endpoint

async function handleRuntimeInvariants(req, res) {
    const { redis } = req;

    try {
        const status = await runtime.invariantEngine.getInvariantStatus(redis);
        const recentViolations = await runtime.invariantEngine.getRecentViolations(redis, 50);
        const history = await runtime.invariantEngine.getInvariantHistory(redis, 50);

        log(`Invariant status: ${recentViolations.length} violations`);

        res.json({
            timestamp: new Date().toISOString(),
            status,
            recentViolations,
            history,
            config: runtime.invariantEngine.INVARIANT_CONFIG
        });
    } catch (err) {
        log(`Error fetching invariant status: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/safety
// ======================================================

async function handleRuntimeSafety(req, res) {
    const { redis } = req;

    try {
        const [invariants, safeMode] = await Promise.all([
            runtime.invariantEngine.getInvariantStatus(redis),
            runtime.safeMode.getSafeModeStatus(redis)
        ]);

        res.json({
            timestamp: new Date().toISOString(),
            invariants,
            safeMode,
            integrated: {
                isSafe: invariants.violations.length === 0 && !safeMode.safemode.active,
                triggers: runtime.safeMode.SAFE_MODE_CONFIG.triggers,
                confidence: invariants.violations.length === 0 ? 'high' : 'low'
            }
        });
    } catch (err) {
        log(`Error fetching safety status: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/governance-validation
// ======================================================

async function handleRuntimeGovernanceValidation(req, res) {
    const { redis } = req;

    try {
        const status = await runtime.validator.getValidationStats(redis);
        const recent = await runtime.validator.getRecentValidations(redis, 20);
        const certified = await runtime.validator.getPolicyVersionStatus(redis);

        res.json({
            timestamp: new Date().toISOString(),
            status,
            recent,
            certified,
            config: runtime.validator.VALIDATION_CONFIG
        });
    } catch (err) {
        log(`Error fetching governance validation: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/safe-mode
// ======================================================

async function handleRuntimeSafeMode(req, res) {
    const { redis } = req;

    try {
        const status = await runtime.safeMode.getSafeModeStatus(redis);
        const enforcement = await runtime.safeMode.getSafeModeEnforcementStatus(redis);
        const history = await runtime.safeMode.getSafeModeHistory(redis, 50);

        res.json({
            timestamp: new Date().toISOString(),
            status,
            enforcement,
            history,
            triggers: runtime.safeMode.SAFE_MODE_CONFIG.triggers,
            exitConditions: runtime.safeMode.SAFE_MODE_CONFIG.exitConditions
        });
    } catch (err) {
        log(`Error fetching safe mode: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/state-graph
// ======================================================
// Phase 16: State graph status endpoint

async function handleRuntimeStateGraph(req, res) {
    const { redis } = req;

    try {
        const stateGraph = new runtime.stateGraph.StateGraphEngine(redis);
        const stats = await stateGraph.getStats();
        const history = stateGraph.getHistory(50);

        res.json({
            timestamp: new Date().toISOString(),
            stats,
            history,
            stages: Object.keys(runtime.stateGraph.Stages).length,
            terminalStages: Object.values(runtime.stateGraph.Stages)
                .filter(s => s.isTerminal).length,
            transitionCount: Object.keys(runtime.stateGraph.Transitions.TransitionContracts).length,
            modes: runtime.stateGraph.StateGraphConfig.modes
        });
    } catch (err) {
        log(`Error fetching state graph: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/replay-consistency
// ======================================================
// Phase 16: Deterministic replay consistency endpoint

async function handleRuntimeReplayConsistency(req, res) {
    const { redis } = req;

    try {
        const replay = new runtime.deterministicReplay.DeterministicReplayEngine(redis);
        const stats = replay.getStats();

        res.json({
            timestamp: new Date().toISOString(),
            stats,
            mode: ReplayConfig.modes,
            consistency: {
                checkLeases: true,
                checkCounters: true,
                checkEvents: true,
                checkDispatches: true
            },
            causality: {
                enabled: true,
                toleranceMs: 100,
                strict: false
            },
            examples: [
                {
                    scenario: 'Normal replay',
                    events: 10,
                    stateTransitions: 5,
                    consistent: true
                },
                {
                    scenario: 'Divergent replay',
                    events: 10,
                    stateTransitions: 5,
                    divergent: true,
                    issue: 'Missing causal event'
                }
            ]
        });
    } catch (err) {
        log(`Error fetching replay consistency: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/execution-semantics
// ======================================================
// Phase 16: Execution semantics endpoint

async function handleRuntimeExecutionSemantics(req, res) {
    const { redis } = req;

    try {
        const semanticsEngine = new runtime.executionSemantics.ExecutionSemanticsEngine();
        const violations = semanticsEngine.getViolations();

        res.json({
            timestamp: new Date().toISOString(),
            violations,
            semanticCategories: [
                runtime.executionSemantics.SemanticCategory.DISPATCH,
                runtime.executionSemantics.SemanticCategory.RETRY,
                runtime.executionSemantics.SemanticCategory.RECOVERY,
                runtime.executionSemantics.SemanticCategory.REPLAY,
                runtime.executionSemantics.SemanticCategory.LEASE_OWNERSHIP
            ],
            dispatch: runtime.executionSemantics.DispatchSemantics,
            retry: runtime.executionSemantics.RetrySemantics,
            recovery: runtime.executionSemantics.RecoverySemantics,
            replay: runtime.executionSemantics.ReplaySemantics,
            leaseOwnership: runtime.executionSemantics.LeaseOwnershipSemantics
        });
    } catch (err) {
        log(`Error fetching execution semantics: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/subsystem-isolation
// ======================================================
// Phase 16: Subsystem isolation endpoint

async function handleRuntimeSubsystemIsolation(req, res) {
    const { redis } = req;

    try {
        const enforcer = new runtime.subsystems.SubsystemIsolationEnforcer();
        const subsystems = enforcer.getAllSubsystems();
        const communicationHistory = enforcer.getCommunicationHistory(50);
        const blocked = enforcer.getBlockedMessages();

        res.json({
            timestamp: new Date().toISOString(),
            subsystems: subsystems.map(s => ({
                name: s.name,
                type: s.type,
                interfaces: s.interfaces.map(i => i.name),
                restrictions: s.restrictions.map(r => r.name)
            })),
            communicationHistory,
            blockedMessages: blocked,
            contracts: {
                scheduling: runtime.subsystems.SchedulingContract,
                governance: runtime.subsystems.GovernanceContract,
                replay: runtime.subsystems.ReplayContract,
                invariants: runtime.subsystems.InvariantsContract,
                adaptation: runtime.subsystems.AdaptationContract
            }
        });
    } catch (err) {
        log(`Error fetching subsystem isolation: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/graph
// ======================================================
// Phase 17: Graph visualization endpoint

async function handleRuntimeGraph(req, res) {
    const { redis } = req;

    try {
        const visualizer = new runtime.stateGraph.StateGraphVisualizer();
        const stats = visualizer.getStats();
        const mermaid = visualizer.visualize('mermaid', { title: 'Animastor State Graph' });
        const dot = visualizer.visualize('dot', { name: 'state_graph' });
        const jsonGraph = visualizer.visualize('json');

        res.json({
            timestamp: new Date().toISOString(),
            stats,
            formats: {
                mermaid: mermaid.substring(0, 2000) + '...',
                dot: dot.substring(0, 1000) + '...',
                json: jsonGraph
            },
            graphVersion: '1.0.0'
        });
    } catch (err) {
        log(`Error fetching graph visualization: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/graph/health
// ======================================================
// Phase 17: Graph health endpoint

async function handleRuntimeGraphHealth(req, res) {
    const { redis } = req;

    try {
        const health = new runtime.graphHealth.GraphHealthMetrics();
        const metrics = await health.getMetrics();

        res.json({
            timestamp: new Date().toISOString(),
            metrics,
            recommendations: health.getRecommendations(),
            thresholds: runtime.graphHealth.GraphHealthConfig.thresholds,
            weights: runtime.graphHealth.GraphHealthConfig.weights
        });
    } catch (err) {
        log(`Error fetching graph health: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/protocol-tests
// ======================================================
// Phase 17: Protocol tests endpoint

async function handleRuntimeProtocolTests(req, res) {
    const { redis } = req;

    try {
        const engine = new runtime.testing.ProtocolTestEngine();
        const summary = await engine.runAllTests();

        res.json({
            timestamp: new Date().toISOString(),
            summary,
            results: engine.getResults().slice(0, 50),
            categories: Object.values(runtime.testing.ProtocolTestConfig.categories),
            status: Object.values(runtime.testing.ProtocolTestConfig.status)
        });
    } catch (err) {
        log(`Error running protocol tests: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// API ENDPOINT: GET /api/v1/debug/runtime/semantic-compatibility
// ======================================================
// Phase 17: Semantic compatibility endpoint

async function handleRuntimeSemanticCompatibility(req, res) {
    const { redis } = req;

    try {
        const checker = new runtime.testing.SemanticCompatibility.SemanticCompatibilityChecker();
        const report = checker.exportFullReport({}, {}, { version: '1.0.0' });

        res.json({
            timestamp: new Date().toISOString(),
            report,
            breakingChanges: report.details.changes.filter(c => c.severity === 'critical').length,
            warnings: report.details.warnings.length,
            compatibilityLevel: report.compatibility.compatibilityLevel,
            migrationRequired: report.compatibility.migrationRequired
        });
    } catch (err) {
        log(`Error checking semantic compatibility: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    handleRuntimeDebug,
    handleRuntimeLeases,
    handleRuntimeDispatches,
    handleRuntimeQuotas,
    handleRuntimeMetrics,
    handleRuntimeCounters,
    handleRuntimeDrift,
    handleRuntimeSnapshot,
    handleRuntimeSnapshots,
    handleRuntimeFailures,
    handleRuntimeRetries,
    handleRuntimeRetention,
    handleRuntimeCleanupRetention,
    handleRuntimeStuckScenes,
    handleRuntimeClearStuckScenes,
    handleRuntimeCircuits,
    handleRuntimePriorities,
    handleRuntimeFairness,
    handleRuntimeRetryBudgets,
    handleRuntimePolicies,
    handleRuntimeWorkloads,
    handleRuntimeCosts,
    handleRuntimeAdmission,
    handleRuntimeAdmissionHistory,
    handleRuntimePoliciesComposed,
    handleRuntimePersistence,
    handleRuntimeSnapshotsCompacted,

    // Phase 12: Explainability endpoints
    handleRuntimeDecision,
    handleRuntimePolicyChain,
    handleRuntimeFeedback,
    handleRuntimeGovernanceMetrics,
    handleRuntimeAdaptiveAdjustments,
    handleRuntimeDecisionHistory,

    // Phase 13: Governance stability endpoints
    handleRuntimeGovernanceHealth,
    handleRuntimeAdaptation,
    handleRuntimeTraceCompaction,
    handleRuntimeStabilityScore,
    handleRuntimeHealthAlerts,

    // Phase 14: Simulation endpoints
    handleRuntimeSimulation,
    handleRuntimeFailureReplay,
    handleRuntimeGovernanceDiff,
    handleRuntimePolicyVersions,
    handleRuntimeSandboxExperiments,
    handleRuntimePolicyEvolution,

    // Phase 15: Safety and invariant endpoints
    handleRuntimeInvariants,
    handleRuntimeSafety,
    handleRuntimeGovernanceValidation,
    handleRuntimeSafeMode,

    // Phase 16: State graph, replay, and subsystem isolation endpoints
    handleRuntimeStateGraph,
    handleRuntimeReplayConsistency,
    handleRuntimeExecutionSemantics,
    handleRuntimeSubsystemIsolation,

    // Phase 17: Graph visualization and protocol testing endpoints
    handleRuntimeGraph,
    handleRuntimeGraphHealth,
    handleRuntimeProtocolTests,
    handleRuntimeSemanticCompatibility
};
