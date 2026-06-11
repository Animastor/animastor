// ======================================================
// FAILURE REPLAY ENGINE - HISTORICAL FAILURE REPLAY
// ======================================================
// Replay historical runtime failures to test recovery
// policies and understand failure patterns.
// With invariant-aware replay support.
//
// Key idea: Learn from production failures safely.

const policySimulator = require('./policy-simulator');
const governanceHealth = require('./governance-health');
const traceCompactor = require('./trace-compactor');
const invariantEngine = require('./invariant-engine');
const safeMode = require('./safe-mode');

const logPrefix = '[REPLAY]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function debug(msg) {
    console.debug(`${logPrefix} • ${msg}`);
}

// ======================================================
// FAILURE REPLAY CONFIGURATION
// ======================================================

const FAILURE_REPLAY_CONFIG = {
    // Replay modes
    modes: {
        DETERMINISTIC: 'deterministic', // Same input → same output
        ACCELERATED: 'accelerated',     // Skip waiting periods
        PARTIAL: 'partial',             // Replay subset of events
        POLICY_COMPARISON: 'policy-comparison' // Compare policies
    },

    // Replay settings
    maxEventsPerReplay: 1000,
    maxReplaysPerSession: 50,
    defaultAccelerationFactor: 10, // 10x faster

    // Replay retention
    replayRetentionMs: 86400000 * 7, // 7 days

    // Event filtering
    failureEventTypes: [
        'admission_rejected',
        'admission_delayed',
        'admission_throttled',
        'overload_throttled',
        'circuit_open',
        'circuit_blocked',
        'retry_exhausted',
        'starvation_detected',
        'failure'
    ],

    // Success event types
    successEventTypes: [
        'admission_accepted',
        'admission_delayed',
        'dispatch_completed',
        'dispatch_succeeded'
    ]
};

// ======================================================
// FAILURE REPLAY KEY PATTERNS
// ======================================================

const FAILURE_REPLAY_PREFIX = 'animastor:failure:replay';
const REPLAY_SESSIONS_KEY = `${FAILURE_REPLAY_PREFIX}:sessions`;
const REPLAY_HISTORY_KEY = `${FAILURE_REPLAY_PREFIX}:history`;
const FAILURE_EVENTS_KEY = 'animastor:runtime:failure:events';

// ======================================================
// FAILURE EVENT EXTRACTION
// ======================================================

/**
 * Extract failure events from event journal.
 */
async function extractFailureEvents(redis, limit = 100) {
    // Get journal entries
    const journalPattern = 'animastor:event-journal:*';
    const journalKeys = await redis.keys(journalPattern);

    const failureEvents = [];
    for (const key of journalKeys) {
        const entries = await redis.lrange(key, 0, limit - 1);
        for (const entry of entries) {
            try {
                const event = JSON.parse(entry);
                if (shouldIncludeEvent(event)) {
                    failureEvents.push({
                        ...event,
                        source: key,
                        timestamp: Date.parse(event.timestamp)
                    });
                }
            } catch (e) {
                // Skip invalid entries
            }
        }
    }

    return failureEvents.sort((a, b) => a.timestamp - b.timestamp).slice(0, limit);
}

/**
 * Check if event should be included in failure replay.
 */
function shouldIncludeEvent(event) {
    if (!event || !event.type) return false;

    const eventType = (event.type || '').toLowerCase();
    const eventCategory = (event.category || '').toLowerCase();

    // Include failure events
    const isFailure = FAILURE_REPLAY_CONFIG.failureEventTypes.some(
        t => eventType.includes(t) || eventCategory.includes(t)
    );

    // Include events with failure outcome
    const hasFailureOutcome = event.outcome === 'failure' || event.outcome === 'error';

    // Include events with rejection
    const isRejected = event.action === 'reject' || event.action === 'deny';

    return isFailure || hasFailureOutcome || isRejected;
}

/**
 * Extract failure events from decision traces.
 */
async function extractFailuresFromTraces(redis, limit = 100) {
    const traces = await traceCompactor.getRecentDetailedTraces(redis, limit);

    const failures = traces.filter(t => {
        const isFailure = !t.decision?.allowed || t.outcome === 'failure';
        const hasFailureReason = t.reason?.toLowerCase()?.includes('fail') ||
                                 t.reason?.toLowerCase()?.includes('deny') ||
                                 t.reason?.toLowerCase()?.includes('reject');

        return isFailure || hasFailureReason;
    });

    return failures;
}

/**
 * Extract failures from runtime metrics.
 */
async function extractFailuresFromMetrics(redis) {
    // Get runtime metrics history
    const metricsKey = 'animastor:runtime:metrics:history';
    const entries = await redis.zrange(metricsKey, 0, -1, 'WITHSCORES');

    const failures = [];

    for (let i = 0; i < entries.length; i += 2) {
        try {
            const metrics = JSON.parse(entries[i]);
            if (metrics.totalFailures && metrics.totalFailures > 0) {
                failures.push({
                    timestamp: parseInt(entries[i + 1], 10),
                    metrics,
                    type: 'metrics_failure'
                });
            }
        } catch (e) {
            // Skip
        }
    }

    return failures.sort((a, b) => a.timestamp - b.timestamp);
}

// ======================================================
// FAILURE REPLAY SESSION
// ======================================================

/**
 * Create failure replay session.
 */
async function createReplaySession(redis, config = {}) {
    const session = {
        id: `replay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: config.name || 'untitled_replay',
        description: config.description || '',
        mode: config.mode || FAILURE_REPLAY_CONFIG.modes.DETERMINISTIC,
        events: config.events || [],
        startTime: null,
        endTime: null,
        status: 'created',
        totalEvents: config.events?.length || 0,
        processedEvents: 0,
        failedEvents: 0,
        successfulEvents: 0,
        results: [],
        runtimeState: config.runtimeState || {},
        createdAt: Date.now(),
        createdAtFormatted: new Date().toISOString()
    };

    const key = `${REPLAY_SESSIONS_KEY}:${session.id}`;
    await redis.set(key, JSON.stringify(session), 'EX', FAILURE_REPLAY_CONFIG.replayRetentionMs);

    return session;
}

/**
 * Load replay session.
 */
async function loadReplaySession(redis, sessionId) {
    const key = `${REPLAY_SESSIONS_KEY}:${sessionId}`;
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
}

/**
 * Update replay session.
 */
async function updateReplaySession(redis, sessionId, updates) {
    const session = await loadReplaySession(redis, sessionId);
    if (!session) return null;

    const updated = { ...session, ...updates, updatedAt: Date.now() };
    const key = `${REPLAY_SESSIONS_KEY}:${sessionId}`;
    await redis.set(key, JSON.stringify(updated), 'EX', FAILURE_REPLAY_CONFIG.replayRetentionMs);

    return updated;
}

/**
 * Complete replay session.
 */
async function completeReplaySession(redis, sessionId, summary) {
    return updateReplaySession(redis, sessionId, {
        status: 'completed',
        endTime: Date.now(),
        summary
    });
}

// ======================================================
// FAILURE REPLAY EXECUTION
// ======================================================

/**
 * Execute failure replay with given events.
 */
async function executeReplay(redis, session, events) {
    session.startTime = Date.now();
    session.events = events;
    session.totalEvents = events.length;

    let processed = 0;
    let failed = 0;
    let successful = 0;

    const results = [];

    for (const event of events) {
        const replayResult = await replayEvent(redis, session, event);
        results.push(replayResult);

        processed++;
        if (replayResult.recovered) {
            successful++;
        } else {
            failed++;
        }

        // Update session progress
        await updateReplaySession(redis, session.id, {
            processedEvents: processed,
            failedEvents: failed,
            successfulEvents: successful
        });
    }

    const summary = {
        totalEvents: processed,
        successful: successful,
        failed: failed,
        recoveryRate: processed > 0 ? (successful / processed * 100).toFixed(1) : 0,
        avgProcessingTime: Math.round(Date.now() - session.startTime)
    };

    return completeReplaySession(redis, session.id, summary);
}

/**
 * Replay a single event with invariant checking.
 */
async function replayEventWithInvariants(redis, session, event) {
    const startTime = Date.now();

    // Build runtime state for this replay
    const runtimeState = buildRuntimeStateForReplay(session.runtimeState, event);

    // Simulate with current policy
    const workload = buildWorkloadFromEvent(event);

    // Run simulation
    const simulation = await policySimulator.simulateDispatch(runtimeState, workload);

    // Determine if event would be recovered
    const recovered = simulation.admission.decision.allowed ||
                      simulation.admission.decision.action === 'delay';

    // Check invariants
    const invariantViolations = await invariantEngine.checkRuntimeInvariants(redis, runtimeState);

    // Check safe mode status
    const safeModeActive = await safeMode.isSafeModeActive(redis);

    const result = {
        timestamp: startTime,
        originalEvent: event,
        replayedEvent: {
            workload,
            admission: simulation.admission,
            decision: simulation.admission.decision,
            recovered,
            processingTime: Date.now() - startTime
        },
        safeModeActive,
        invariantViolations,
        invariantValid: invariantViolations.length === 0,
        session: { id: session.id, name: session.name }
    };

    return result;
}

/**
 * Replay a single event (baseline - no invariant checks).
 */
async function replayEvent(redis, session, event) {
    const startTime = Date.now();

    // Build runtime state for this replay
    const runtimeState = buildRuntimeStateForReplay(session.runtimeState, event);

    // Simulate with current policy
    const workload = buildWorkloadFromEvent(event);

    // Run simulation
    const simulation = await policySimulator.simulateDispatch(runtimeState, workload);

    // Determine if event would be recovered
    const recovered = simulation.admission.decision.allowed ||
                      simulation.admission.decision.action === 'delay';

    const result = {
        timestamp: startTime,
        originalEvent: event,
        replayedEvent: {
            workload,
            admission: simulation.admission,
            decision: simulation.admission.decision,
            recovered,
            processingTime: Date.now() - startTime
        },
        session: { id: session.id, name: session.name }
    };

    return result;
}

/**
 * Execute invariant-aware failure replay.
 */
async function executeInvariantReplay(redis, session, events) {
    session.startTime = Date.now();
    session.events = events;
    session.totalEvents = events.length;
    session.mode = 'invariant_aware';

    let processed = 0;
    let failed = 0;
    let successful = 0;
    let invariantViolationsDetected = 0;

    const results = [];

    for (const event of events) {
        const replayResult = await replayEventWithInvariants(redis, session, event);
        results.push(replayResult);

        processed++;
        if (replayResult.recovered) {
            successful++;
        } else {
            failed++;
        }

        if (replayResult.invariantViolations && replayResult.invariantViolations.length > 0) {
            invariantViolationsDetected++;
        }

        // Update session progress
        await updateReplaySession(redis, session.id, {
            processedEvents: processed,
            failedEvents: failed,
            successfulEvents: successful
        });
    }

    const summary = {
        totalEvents: processed,
        successful: successful,
        failed: failed,
        recoveryRate: processed > 0 ? (successful / processed * 100).toFixed(1) : 0,
        invariantViolationsDetected,
        invariantViolationRate: processed > 0 ? (invariantViolationsDetected / processed * 100).toFixed(1) : 0,
        avgProcessingTime: Math.round(Date.now() - session.startTime)
    };

    return completeReplaySession(redis, session.id, summary);
}

/**
 * Build runtime state from replay context.
 */
function buildRuntimeStateForReplay(baseState, event) {
    const state = { ...baseState };

    // Apply event-specific state changes
    if (event.sceneId || event.bookId) {
        state.activeScenes = (state.activeScenes || 0) + 1;
    }

    if (event.class) {
        state.activeLeases = {
            ...state.activeLeases,
            [event.class]: (state.activeLeases?.[event.class] || 0) + 1
        };
    }

    if (event.overloadScore !== undefined) {
        state.overloadScore = event.overloadScore;
        state.overloadState = {
            active: event.overloadScore > 80,
            score: event.overloadScore
        };
    }

    if (event.retryFailures !== undefined) {
        state.retryHistory = {
            ...state.retryHistory,
            failures: [...(state.retryHistory?.failures || []), ...Array(event.retryFailures).fill(1)],
            lastFailure: Date.now()
        };
        state.retryState = {
            failures: event.retryFailures,
            lastFailure: Date.now()
        };
    }

    return state;
}

/**
 * Build workload from event.
 */
function buildWorkloadFromEvent(event) {
    return {
        id: event.id || event.sceneId,
        bookId: event.bookId,
        chapterId: event.chapterId,
        sceneId: event.sceneId,
        stage: event.stage || event.runtime_type || 'audio',
        class: event.class || event.runtime_type || 'audio',
        runtime_type: event.runtime_type || event.class || 'audio',
        priority: event.priority || 50,
        priorityClass: event.priorityClass || 'normal',
        ...event.workload
    };
}

// ======================================================
// REPLAY MODES
// ======================================================

/**
 * Execute deterministic replay.
 */
async function executeDeterministicReplay(redis, events) {
    const session = await createReplaySession(redis, {
        mode: FAILURE_REPLAY_CONFIG.modes.DETERMINISTIC,
        name: 'deterministic_replay'
    });

    return executeReplay(redis, session, events);
}

/**
 * Execute accelerated replay (skip waiting).
 */
async function executeAcceleratedReplay(redis, events, accelerationFactor = 10) {
    const session = await createReplaySession(redis, {
        mode: FAILURE_REPLAY_CONFIG.modes.ACCELERATED,
        name: 'accelerated_replay',
        accelerationFactor
    });

    return executeReplay(redis, session, events);
}

/**
 * Execute partial replay (subset of events).
 */
async function executePartialReplay(redis, events, subsetConfig) {
    const { start = 0, end = events.length } = subsetConfig;
    const subset = events.slice(start, end);

    const session = await createReplaySession(redis, {
        mode: FAILURE_REPLAY_CONFIG.modes.PARTIAL,
        name: 'partial_replay',
        subset: { start, end, count: subset.length }
    });

    return executeReplay(redis, session, subset);
}

/**
 * Execute policy comparison replay.
 */
async function executePolicyComparisonReplay(redis, events, basePolicy, testPolicies) {
    const session = await createReplaySession(redis, {
        mode: FAILURE_REPLAY_CONFIG.modes.POLICY_COMPARISON,
        name: 'policy_comparison_replay',
        basePolicy,
        testPolicies
    });

    const results = {
        base: { total: 0, recovered: 0, cases: [] },
        policies: {}
    };

    // Run with base policy first
    for (const event of events) {
        const runtimeState = buildRuntimeStateForReplay(session.runtimeState, event);
        const workload = buildWorkloadFromEvent(event);

        const simulation = await policySimulator.simulateDispatch(runtimeState, workload);

        results.base.total++;
        const recovered = simulation.admission.decision.allowed ||
                          simulation.admission.decision.action === 'delay';
        if (recovered) results.base.recovered++;

        results.base.cases.push({
            event,
            simulation,
            recovered
        });
    }

    // Run with test policies
    for (const [policyName, policyConfig] of Object.entries(testPolicies)) {
        results.policies[policyName] = {
            total: 0,
            recovered: 0,
            improvementOverBase: 0,
            cases: []
        };

        for (const event of events) {
            const runtimeState = buildRuntimeStateForReplay(session.runtimeState, event);
            const workload = buildWorkloadFromEvent(event);

            const simulation = await policySimulator.simulateDispatch(runtimeState, workload, policyConfig);

            results.policies[policyName].total++;
            const recovered = simulation.admission.decision.allowed ||
                              simulation.admission.decision.action === 'delay';
            if (recovered) results.policies[policyName].recovered++;

            results.policies[policyName].cases.push({
                event,
                simulation,
                recovered
            });
        }

        // Calculate improvement
        const baseRecoveryRate = results.base.recovered / results.base.total;
        const policyRecoveryRate = results.policies[policyName].recovered / results.policies[policyName].total;
        results.policies[policyName].improvementOverBase = (policyRecoveryRate - baseRecoveryRate) * 100;
    }

    return results;
}

// ======================================================
// FAILURE SCENARIO GENERATION
// ======================================================

/**
 * Generate failure scenarios from historical data.
 */
async function generateFailureScenarios(redis, limit = 100) {
    const failureEvents = await extractFailureEvents(redis, limit);

    const scenarios = {
        overloadScenarios: [],
        retryScenarios: [],
        admissionScenarios: [],
        circuitScenarios: [],
        allScenarios: []
    };

    for (const event of failureEvents) {
        const scenario = {
            id: event.id || event.sceneId,
            type: determineScenarioType(event),
            event,
            timestamp: event.timestamp,
            runtimeState: buildRuntimeStateForReplay({}, event),
            workload: buildWorkloadFromEvent(event)
        };

        scenarios.allScenarios.push(scenario);

        if (scenario.type === 'overload') {
            scenarios.overloadScenarios.push(scenario);
        } else if (scenario.type === 'retry') {
            scenarios.retryScenarios.push(scenario);
        } else if (scenario.type === 'admission') {
            scenarios.admissionScenarios.push(scenario);
        } else if (scenario.type === 'circuit') {
            scenarios.circuitScenarios.push(scenario);
        }
    }

    return scenarios;
}

/**
 * Determine scenario type from event.
 */
function determineScenarioType(event) {
    const eventString = JSON.stringify(event).toLowerCase();

    if (eventString.includes('overload') || event.overloadScore > 80) {
        return 'overload';
    } else if (eventString.includes('retry') || event.retryFailures) {
        return 'retry';
    } else if (eventString.includes('circuit') || eventString.includes('circuit')) {
        return 'circuit';
    } else if (eventString.includes('admission') || eventString.includes('reject')) {
        return 'admission';
    } else {
        return 'other';
    }
}

// ======================================================
// FAILURE ANALYSIS
// ======================================================

/**
 * Analyze failure patterns in replay results.
 */
function analyzeFailurePatterns(results) {
    const analysis = {
        total: 0,
        recovered: 0,
        patterns: {
            byType: {},
            byClass: {},
            byTime: {},
            admissionPatterns: [],
            policyRecommendations: []
        }
    };

    if (results.base) {
        analysis.total = results.base.total;
        analysis.recovered = results.base.recovered;

        for (const caseResult of results.base.cases) {
            const { event, simulation } = caseResult;

            // Group by type
            const type = determineScenarioType(event);
            analysis.patterns.byType[type] = (analysis.patterns.byType[type] || 0) + 1;

            // Group by class
            const workloadClass = event.class || 'unknown';
            analysis.patterns.byClass[workloadClass] = (analysis.patterns.byClass[workloadClass] || 0) + 1;
        }
    }

    // Generate recommendations
    if (analysis.recovered / analysis.total < 0.8) {
        analysis.patterns.policyRecommendations.push({
            type: 'admission',
            priority: 'high',
            suggestion: 'Consider relaxing admission thresholds',
            impact: 'Low recovery rate detected'
        });
    }

    if (analysis.patterns.byType.overload > 0 &&
        analysis.patterns.byType.overload > analysis.total * 0.3) {
        analysis.patterns.policyRecommendations.push({
            type: 'overload',
            priority: 'high',
            suggestion: 'Review overload protection settings',
            impact: 'Overload causes significant failures'
        });
    }

    return analysis;
}

// ======================================================
// FAILURE REPLAY HISTORY
// ======================================================

/**
 * Record replay to history.
 */
async function recordReplay(redis, session) {
    const key = REPLAY_HISTORY_KEY;
    const entry = {
        ...session,
        recordedAt: Date.now(),
        recordedAtFormatted: new Date().toISOString()
    };

    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 999);

    return entry;
}

/**
 * Get replay history.
 */
async function getReplayHistory(redis, limit = 50) {
    const key = REPLAY_HISTORY_KEY;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

/**
 * Get recent replays.
 */
async function getRecentReplays(redis, limit = 10) {
    const entries = await getReplayHistory(redis, limit);
    return entries.sort((a, b) => b.startTime || b.recordedAt - (a.startTime || a.recordedAt));
}

/**
 * Get replay status.
 */
async function getReplayStatus(redis) {
    const history = await getReplayHistory(redis, 100);
    const sessions = await getRecentReplays(redis, 20);

    return {
        timestamp: Date.now(),
        totalReplays: history.length,
        recentSessions: sessions,
        config: FAILURE_REPLAY_CONFIG
    };
}

// ======================================================
// REPLAY EVENTS
// ======================================================

/**
 * Record failure replay event.
 */
async function recordFailureReplayed(redis, event, result) {
    const replayEvent = {
        timestamp: Date.now(),
        event,
        result,
        type: 'FAILURE_REPLAYED',
        recordedAt: new Date().toISOString()
    };

    return replayEvent;
}

/**
 * Record decision replay event.
 */
async function recordDecisionReplayed(redis, decision, replayedDecision) {
    const replayEvent = {
        timestamp: Date.now(),
        originalDecision: decision,
        replayedDecision,
        type: 'DECISION_REPLAYED',
        recordedAt: new Date().toISOString()
    };

    return replayEvent;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    FAILURE_REPLAY_CONFIG,

    // Event extraction
    extractFailureEvents,
    extractFailuresFromTraces,
    extractFailuresFromMetrics,
    shouldIncludeEvent,
    determineScenarioType,

    // Session management
    createReplaySession,
    loadReplaySession,
    updateReplaySession,
    completeReplaySession,

    // Replay execution
    executeReplay,
    replayEvent,
    executeDeterministicReplay,
    executeAcceleratedReplay,
    executePartialReplay,
    executePolicyComparisonReplay,

    // Scenario generation
    generateFailureScenarios,

    // Analysis
    analyzeFailurePatterns,
    buildRuntimeStateForReplay,
    buildWorkloadFromEvent,

    // History
    recordReplay,
    getReplayHistory,
    getRecentReplays,
    getReplayStatus,

    // Events
    recordFailureReplayed,
    recordDecisionReplayed,

    // Constants
    FAILURE_REPLAY_PREFIX,
    REPLAY_SESSIONS_KEY,
    REPLAY_HISTORY_KEY
};
