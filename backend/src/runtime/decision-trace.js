// ======================================================
// DECISION TRACE ENGINE - GOVERNANCE EXPLAINABILITY
// ======================================================
// Collects reasoning chains for all runtime decisions.
// Makes governance decisions EXPLAINABLE.
//
// Key idea: Runtime should explain WHY a decision was made.

const logPrefix = '[TRACE]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function debug(msg) {
    console.debug(`${logPrefix} • ${msg}`);
}

// ======================================================
// TRACE CONFIGURATION
// ======================================================

const TRACE_CONFIG = {
    // Storage limits
    maxDecisionsPerScene: 100,
    maxTotalDecisions: 10000,

    // Trace retention
    retentionMs: 86400000, // 24 hours
    aggregationWindowMs: 3600000, // 1 hour for aggregations

    // Its decision fields
    minSignals: 3, // Minimum signals for confidence calculation
    maxSignals: 10, // Maximum signals considered
    confidenceScale: 100
};

// ======================================================
// TRACE KEY PATTERNS
// ======================================================

const TRACE_PREFIX = 'animastor:runtime:trace';
const DECISION_HISTORY_KEY = 'animastor:runtime:decision-history';
const POLICY_CHAIN_KEY = 'animastor:runtime:policy-chain';
const DECISION_AGGREGATE_KEY = 'animastor:runtime:decision-aggregates';
const EXPLAIN_KEY = 'animastor:runtime:explanation';

// ======================================================
// TRACE TYPES
// ======================================================

const TraceType = {
    ADMISSION: 'admission',
    DISPATCH: 'dispatch',
    RETRY: 'retry',
    PRIORITY: 'priority',
    OVERLOAD: 'overload',
    STARVATION: 'starvation',
    RECONCILIATION: 'reconciliation',
    CIRCUIT: 'circuit',
    ADAPTIVE: 'adaptive'
};

// ======================================================
// POLICY DECISION FORMATS
// ======================================================

/**
 * Policy decision with explainability fields.
 * All policies should return this format.
 */
const PolicyDecisionFormat = {
    /**
     * @param {Object} options
     * @param {boolean} options.allowed - Whether the decision allows the action
     * @param {string} options.reason - Human-readable reason
     * @param {number} options.confidence - 0-100 confidence score
     * @param {Array} options.signals - Array of decision signals
     * @param {string} options.policy - Policy name
     */
    create({ allowed, reason, confidence, signals, policy }) {
        return {
            allowed,
            reason,
            confidence: Math.min(100, Math.max(0, Math.round(confidence))),
            signals: Array.isArray(signals) ? signals.slice(0, TRACE_CONFIG.maxSignals) : [],
            policy
        };
    },

    // Signal helper functions
    createSignal(name, value, weight = 1, description = '') {
        return {
            name,
            value,
            weight,
            description
        };
    }
};

// ======================================================
// TRACE CREATION
// ======================================================

/**
 * Create a trace entry.
 */
function createTrace({
    type,
    scene,
    decision,
    outcome,
    policyChain = [],
    runtimeState = {},
    timestamp = Date.now()
}) {
    const trace = {
        trace_id: `trace-${timestamp}-${Math.random().toString(36).slice(2, 10)}`,
        type,
        timestamp,
        scene,
        decision,
        outcome,
        policyChain,
        runtimeState,
        created_at: new Date().toISOString()
    };

    // Calculate aggregate confidence
    trace.confidence = calculateAggregateConfidence(policyChain);

    return trace;
}

/**
 * Calculate aggregate confidence from policy chain.
 */
function calculateAggregateConfidence(policyChain) {
    if (policyChain.length === 0) return 0;

    const confidenceScores = policyChain
        .filter(p => p.confidence !== undefined)
        .map(p => p.confidence);

    if (confidenceScores.length === 0) return 0;

    // Weight by policy precedence (earlier policies = higher weight)
    let totalWeightedConfidence = 0;
    let totalWeight = 0;

    confidenceScores.forEach((confidence, index) => {
        const weight = confidenceScores.length - index; // Higher weight for earlier policies
        totalWeightedConfidence += confidence * weight;
        totalWeight += weight;
    });

    return Math.round(totalWeightedConfidence / totalWeight);
}

/**
 * Create policy decision with explainability.
 */
function createPolicyDecision({
    policy,
    allowed,
    reason,
    confidence = 100,
    signals = []
}) {
    return PolicyDecisionFormat.create({
        policy,
        allowed,
        reason,
        confidence,
        signals
    });
}

// ======================================================
// POLICY CHAIN BUILDING
// ======================================================

/**
 * Build a policy reasoning chain from composed decisions.
 */
function buildPolicyChain(composedResult) {
    const chain = [];

    if (!composedResult || !composedResult.policyResults) {
        return chain;
    }

    composedResult.policyResults.forEach((policyDecision, index) => {
        let signals = [];

        // Convert policy results to signals
        if (policyDecision.throttle !== undefined) {
            signals.push(PolicyDecisionFormat.createSignal(
                'throttle',
                policyDecision.throttle,
                2,
                `Throttle multiplier: ${policyDecision.throttle.toFixed(2)}`
            ));
        }

        if (policyDecision.delayMs !== undefined && policyDecision.delayMs > 0) {
            signals.push(PolicyDecisionFormat.createSignal(
                'delay',
                policyDecision.delayMs,
                1,
                `Delay: ${policyDecision.delayMs}ms`
            ));
        }

        if (policyDecision.adjustedPriority !== undefined) {
            signals.push(PolicyDecisionFormat.createSignal(
                'priority',
                policyDecision.adjustedPriority,
                2,
                `Priority: ${policyDecision.adjustedPriority}`
            ));
        }

        if (policyDecision.overload !== undefined) {
            signals.push(PolicyDecisionFormat.createSignal(
                'overload',
                policyDecision.overload,
                3,
                'Runtime overload detected'
            ));
        }

        if (policyDecision.circuitOpen !== undefined) {
            signals.push(PolicyDecisionFormat.createSignal(
                'circuit',
                policyDecision.circuitOpen,
                3,
                `Circuit breaker open: ${policyDecision.stage}`
            ));
        }

        if (policyDecision.starving !== undefined && policyDecision.starving.starving) {
            signals.push(PolicyDecisionFormat.createSignal(
                'starvation',
                policyDecision.starving.ageMinutes,
                3,
                `Scene starving for ${policyDecision.starving.ageMinutes.toFixed(1)} minutes`
            ));
        }

        if (policyDecision.exceeded !== undefined) {
            signals.push(PolicyDecisionFormat.createSignal(
                'quota_exceeded',
                policyDecision.exceeded,
                2,
                'Quota exceeded'
            ));
        }

        if (policyDecision.sceneRetries !== undefined) {
            signals.push(PolicyDecisionFormat.createSignal(
                'retry_count',
                policyDecision.sceneRetries,
                2,
                `Retry attempts: ${policyDecision.sceneRetries}`
            ));
        }

        if (policyDecision.workload !== undefined) {
            signals.push(PolicyDecisionFormat.createSignal(
                'workload',
                policyDecision.workload,
                1,
                `Workload class: ${policyDecision.workload}`
            ));
        }

        // Add reason as signal
        if (policyDecision.reason) {
            signals.push(PolicyDecisionFormat.createSignal(
                'reason',
                policyDecision.reason,
                1,
                `Decision reason: ${policyDecision.reason}`
            ));
        }

        chain.push({
            policy: policyDecision.policy || 'unknown',
            precedence: index + 1,
            ...PolicyDecisionFormat.create({
                policy: policyDecision.policy || 'unknown',
                allowed: policyDecision.allowed !== false,
                reason: policyDecision.reason || 'no_reason',
                confidence: calculateSignalConfidence(signals),
                signals
            })
        });
    });

    return chain;
}

/**
 * Calculate confidence from signals.
 */
function calculateSignalConfidence(signals) {
    if (signals.length === 0) return 100;
    if (signals.length < TRACE_CONFIG.minSignals) return 70;

    // Weighted average of signal confidence
    let weightedSum = 0;
    let totalWeight = 0;

    signals.forEach(signal => {
        // Base confidence from signal presence
        let baseConfidence = signal.weight * 20; // Each signal contributes up to 20 points
        weightedSum += baseConfidence;
        totalWeight += signal.weight;
    });

    // Normalized confidence
    const normalized = (weightedSum / (totalWeight * 20)) * 100;
    return Math.min(100, Math.round(normalized));
}

/**
 * Build trace reason string from policy chain.
 */
function buildTraceReason(chain) {
    const reasons = [];

    chain.forEach((policy, index) => {
        if (!policy.allowed) {
            reasons.push({
                policy: policy.policy,
                reason: policy.reason,
                precedence: index + 1,
                confidence: policy.confidence
            });
        } else if (policy.confidence < 80) {
            reasons.push({
                policy: policy.policy,
                reason: `Low confidence decision: ${policy.reason}`,
                precedence: index + 1,
                confidence: policy.confidence
            });
        }
    });

    if (reasons.length === 0) {
        return 'All policies passed';
    }

    return reasons.map(r => `[${r.policy}] ${r.reason}`).join(' | ');
}

// ======================================================
// TRACE STORAGE
// ======================================================

/**
 * Store trace in Redis.
 */
async function storeTrace(redis, trace) {
    const key = `${TRACE_PREFIX}:${trace.scene.book_id}:${trace.scene.chapter_id}:${trace.scene.scene_id}:${trace.decision}`;
    await redis.set(key, JSON.stringify(trace), 'EX', TRACE_CONFIG.retentionMs);

    // Store in decision history
    const historyKey = `${DECISION_HISTORY_KEY}:${trace.scene.book_id}:${trace.scene.chapter_id}:${trace.scene.scene_id}`;
    await redis.lpush(historyKey, JSON.stringify({
        trace_id: trace.trace_id,
        type: trace.type,
        decision: trace.decision,
        outcome: trace.outcome,
        timestamp: trace.timestamp,
        policyCount: trace.policyChain.length
    }));
    await redis.ltrim(historyKey, 0, TRACE_CONFIG.maxDecisionsPerScene - 1);

    return trace.trace_id;
}

/**
 * Get trace for scene/decision.
 */
async function getTrace(redis, bookId, chapterId, sceneId, decision) {
    const key = `${TRACE_PREFIX}:${bookId}:${chapterId}:${sceneId}:${decision}`;
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
}

/**
 * Get trace by trace_id.
 */
async function getTraceById(redis, traceId) {
    // Scan for trace
    const keys = await redis.keys(`${TRACE_PREFIX}:*`);
    for (const key of keys) {
        const raw = await redis.get(key);
        if (raw) {
            try {
                const trace = JSON.parse(raw);
                if (trace.trace_id === traceId) {
                    return trace;
                }
            } catch (e) {
                // Skip invalid entries
            }
        }
    }
    return null;
}

/**
 * Get decision history for scene.
 */
async function getDecisionHistory(redis, bookId, chapterId, sceneId, limit = 20) {
    const key = `${DECISION_HISTORY_KEY}:${bookId}:${chapterId}:${sceneId}`;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

/**
 * Get traces for scene.
 */
async function getTracesForScene(redis, bookId, chapterId, sceneId) {
    const traces = [];
    const keys = await redis.keys(`${TRACE_PREFIX}:${bookId}:${chapterId}:${sceneId}:*`);

    for (const key of keys) {
        const raw = await redis.get(key);
        if (raw) {
            try {
                traces.push(JSON.parse(raw));
            } catch (e) {
                // Skip invalid entries
            }
        }
    }

    return traces.sort((a, b) => b.timestamp - a.timestamp);
}

// ======================================================
// EXPLAINABILITY QUERIES
// ======================================================

/**
 * Get explanation for a decision.
 */
async function getDecisionExplanation(redis, bookId, chapterId, sceneId, decision) {
    const trace = await getTrace(redis, bookId, chapterId, sceneId, decision);

    if (!trace) {
        return {
            scene: { bookId, chapterId, sceneId },
            decision,
            explanation: {
                type: 'not_found',
                reason: 'No trace found for this decision',
                confidence: 0,
                policyChain: []
            }
        };
    }

    return {
        scene: trace.scene,
        decision: trace.decision,
        timestamp: trace.timestamp,
        outcome: trace.outcome,
        explanation: {
            type: trace.type,
            reason: buildTraceReason(trace.policyChain),
            confidence: trace.confidence,
            policyChain: trace.policyChain,
            runtimeState: trace.runtimeState,
            decisions: {
                accepted: trace.policyChain.filter(p => p.allowed).length,
                blocked: trace.policyChain.filter(p => !p.allowed).length
            },
            signals: trace.policyChain.flatMap(p => p.signals)
        }
    };
}

/**
 * Get policy chain explanation for scene.
 */
async function getPolicyChainExplanation(redis, bookId, chapterId, sceneId) {
    const traces = await getTracesForScene(redis, bookId, chapterId, sceneId);

    if (traces.length === 0) {
        return {
            scene: { bookId, chapterId, sceneId },
            chain: [],
            statistics: {
                totalDecisions: 0,
                avgConfidence: 0,
                byOutcome: {},
                byDecision: {}
            }
        };
    }

    // Aggregate statistics
    const byOutcome = {};
    const byDecision = {};
    const byPolicy = {};
    let totalConfidence = 0;

    traces.forEach(trace => {
        // Outcome counts
        const outcome = trace.outcome || 'unknown';
        byOutcome[outcome] = (byOutcome[outcome] || 0) + 1;

        // Decision counts
        const decision = trace.decision;
        byDecision[decision] = (byDecision[decision] || 0) + 1;

        // Policy chain analysis
        trace.policyChain.forEach((policy, idx) => {
            if (!byPolicy[policy.policy]) {
                byPolicy[policy.policy] = {
                    count: 0,
                    allowed: 0,
                    blocked: 0,
                    avgConfidence: 0
                };
            }
            byPolicy[policy.policy].count++;
            if (policy.allowed) {
                byPolicy[policy.policy].allowed++;
            } else {
                byPolicy[policy.policy].blocked++;
            }
            byPolicy[policy.policy].avgConfidence = (byPolicy[policy.policy].avgConfidence * (byPolicy[policy.policy].count - 1) + policy.confidence) / byPolicy[policy.policy].count;
        });

        totalConfidence += trace.confidence;
    });

    // Get latest trace for current explanation
    const latestTrace = traces[0];

    return {
        scene: { bookId, chapterId, sceneId },
        latestDecision: latestTrace.decision,
        latestOutcome: latestTrace.outcome,
        latestConfidence: latestTrace.confidence,
        policyChain: latestTrace.policyChain,
        chain: latestTrace.policyChain.map(p => ({
            policy: p.policy,
            allowed: p.allowed,
            reason: p.reason,
            confidence: p.confidence,
            precedence: p.confidence
        })),
        statistics: {
            totalDecisions: traces.length,
            avgConfidence: Math.round(totalConfidence / traces.length),
            byOutcome,
            byDecision,
            byPolicy
        }
    };
}

/**
 * Get governance explanation for scene (human-readable).
 */
async function getGovernanceExplanation(redis, bookId, chapterId, sceneId) {
    const explanation = await getPolicyChainExplanation(redis, bookId, chapterId, sceneId);

    if (explanation.policyChain.length === 0) {
        return {
            scene: { bookId, chapterId, sceneId },
            explanation: 'No governance history available'
        };
    }

    // Build narrative explanation
    const blocks = [];
    const warnings = [];
    const passes = [];

    explanation.policyChain.forEach((policy, idx) => {
        if (!policy.allowed) {
            blocks.push({
                policy: policy.policy,
                reason: policy.reason,
                precedence: idx + 1
            });
        } else if (policy.confidence < 70) {
            warnings.push({
                policy: policy.policy,
                reason: policy.reason,
                confidence: policy.confidence
            });
        } else {
            passes.push({
                policy: policy.policy,
                confidence: policy.confidence
            });
        }
    });

    // Build explanation string
    let explanationText = '';
    if (blocks.length > 0) {
        explanationText = `Decision was BLOCKED because:\n`;
        explanationText += blocks.map(b => `  - [${b.policy}] ${b.reason}`).join('\n');
    } else if (warnings.length > 0) {
        explanationText = `Decision was ALLOWED with warnings:\n`;
        explanationText += warnings.map(w => `  - [${w.policy}] Low confidence (${w.confidence}): ${w.reason}`).join('\n');
    } else {
        explanationText = 'Decision was ALLOWED - all policies passed with high confidence.';
    }

    return {
        scene: { bookId, chapterId, sceneId },
        explanation: explanationText,
        details: {
            blocks,
            warnings,
            passes
        }
    };
}

// ======================================================
// AGGREGATES AND METRICS
// ======================================================

/**
 * Get decision aggregates by type.
 */
async function getDecisionAggregates(redis, type = null) {
    const aggregates = {};

    // Get all decision types
    const typeKeys = await redis.keys(`${DECISION_AGGREGATE_KEY}:*`);
    const types = [...new Set(typeKeys.map(k => k.split(':')[2]))];

    for (const t of types) {
        if (type && t !== type) continue;

        const key = `${DECISION_AGGREGATE_KEY}:${t}`;
        const raw = await redis.get(key);
        if (raw) {
            aggregates[t] = JSON.parse(raw);
        }
    }

    return aggregates;
}

/**
 * Update decision aggregate.
 */
async function updateDecisionAggregate(redis, type, update) {
    const key = `${DECISION_AGGREGATE_KEY}:${type}`;
    const raw = await redis.get(key);
    let aggregate = raw ? JSON.parse(raw) : {
        type,
        total: 0,
        byOutcome: {},
        byDecision: {},
        avgConfidence: 0,
        firstTimestamp: Date.now(),
        lastTimestamp: Date.now()
    };

    // Update aggregate
    aggregate.total++;
    aggregate.lastTimestamp = Date.now();

    const outcome = update.outcome || 'unknown';
    aggregate.byOutcome[outcome] = (aggregate.byOutcome[outcome] || 0) + 1;

    const decision = update.decision || 'unknown';
    aggregate.byDecision[decision] = (aggregate.byDecision[decision] || 0) + 1;

    // Update average confidence
    if (update.confidence !== undefined) {
        aggregate.avgConfidence = (aggregate.avgConfidence * (aggregate.total - 1) + update.confidence) / aggregate.total;
        aggregate.confidenceHistory = [...(aggregate.confidenceHistory || []), update.confidence];
        if (aggregate.confidenceHistory.length > 100) {
            aggregate.confidenceHistory = aggregate.confidenceHistory.slice(-100);
        }
    }

    await redis.set(key, JSON.stringify(aggregate), 'EX', TRACE_CONFIG.retentionMs);

    return aggregate;
}

/**
 * Get top blocked policies.
 */
async function getBlockedPolicies(redis) {
    const blocked = [];
    const keys = await redis.keys(`${TRACE_PREFIX}:*`);
    const now = Date.now();

    for (const key of keys) {
        const raw = await redis.get(key);
        if (raw && now - parseInt(key.split(':')[3]) < 3600000) { // Last hour
            try {
                const trace = JSON.parse(raw);
                trace.policyChain.forEach(policy => {
                    if (!policy.allowed) {
                        blocked.push({
                            policy: policy.policy,
                            reason: policy.reason,
                            confidence: policy.confidence,
                            timestamp: trace.timestamp
                        });
                    }
                });
            } catch (e) {
                // Skip invalid entries
            }
        }
    }

    // Aggregate by policy
    const byPolicy = {};
    blocked.forEach(b => {
        if (!byPolicy[b.policy]) {
            byPolicy[b.policy] = { count: 0, reasons: {} };
        }
        byPolicy[b.policy].count++;
        byPolicy[b.policy].reasons[b.reason] = (byPolicy[b.policy].reasons[b.reason] || 0) + 1;
    });

    // Sort by count
    return Object.entries(byPolicy)
        .map(([policy, data]) => ({ policy, ...data }))
        .sort((a, b) => b.count - a.count);
}

// ======================================================
// TRACE REPLAY AND ANALYSIS
// ======================================================

/**
 * Replay decision trace and show reasoning steps.
 */
function replayTrace(trace) {
    const steps = [];

    steps.push({
        step: 0,
        action: 'start',
        description: `Decision trace started for ${trace.scene.book_id}/${trace.scene.chapter_id}/${trace.scene.scene_id}`
    });

    trace.policyChain.forEach((policy, idx) => {
        steps.push({
            step: idx + 1,
            action: policy.allowed ? 'allowed' : 'blocked',
            policy: policy.policy,
            reason: policy.reason,
            confidence: policy.confidence,
            signals: policy.signals.map(s => ({
                name: s.name,
                value: s.value,
                weight: s.weight
            }))
        });
    });

    steps.push({
        step: trace.policyChain.length + 1,
        action: trace.outcome || 'completed',
        description: `Final outcome: ${trace.outcome}`
    });

    return {
        trace_id: trace.trace_id,
        type: trace.type,
        decision: trace.decision,
        steps
    };
}

/**
 * Get decision trace by type.
 */
async function getTracesByType(redis, type, limit = 20) {
    const traces = [];
    const keys = await redis.keys(`${TRACE_PREFIX}:*`);

    for (const key of keys) {
        const parts = key.split(':');
        if (parts.length < 4) continue;

        // Extract type from key if available
        const raw = await redis.get(key);
        if (raw) {
            try {
                const trace = JSON.parse(raw);
                if (!type || trace.type === type) {
                    traces.push(trace);
                }
            } catch (e) {
                // Skip invalid entries
            }
        }
    }

    // Sort and limit
    return traces.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

/**
 * Find recent decisions by policy.
 */
async function getDecisionsByPolicy(redis, policyName, limit = 50) {
    const decisions = [];
    const keys = await redis.keys(`${TRACE_PREFIX}:*`);

    for (const key of keys) {
        const raw = await redis.get(key);
        if (raw) {
            try {
                const trace = JSON.parse(raw);
                const matchingPolicy = trace.policyChain.find(p => p.policy === policyName);
                if (matchingPolicy) {
                    decisions.push({
                        scene: trace.scene,
                        decision: trace.decision,
                        outcome: trace.outcome,
                        policy: policyName,
                        allowed: matchingPolicy.allowed,
                        reason: matchingPolicy.reason,
                        confidence: matchingPolicy.confidence,
                        timestamp: trace.timestamp
                    });
                }
            } catch (e) {
                // Skip invalid entries
            }
        }
    }

    return decisions.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

// ======================================================
// TRACE VISUALIZATION DATA
// ======================================================

/**
 * Get trace data for visualization.
 */
async function getTraceVisualizationData(redis, scene, limit = 100) {
    const traces = await getTracesForScene(redis, scene.book_id, scene.chapter_id, scene.scene_id);
    const recentTraces = traces.slice(0, limit);

    // Build timeline data
    const timeline = recentTraces.map(t => ({
        timestamp: t.timestamp,
        decision: t.decision,
        outcome: t.outcome,
        confidence: t.confidence,
        policies: t.policyChain.map(p => ({
            name: p.policy,
            allowed: p.allowed,
            confidence: p.confidence
        }))
    }));

    // Build policy distribution
    const policyDistribution = {};
    recentTraces.forEach(t => {
        t.policyChain.forEach(p => {
            if (!policyDistribution[p.policy]) {
                policyDistribution[p.policy] = { total: 0, allowed: 0, blocked: 0 };
            }
            policyDistribution[p.policy].total++;
            if (p.allowed) {
                policyDistribution[p.policy].allowed++;
            } else {
                policyDistribution[p.policy].blocked++;
            }
        });
    });

    return {
        scene,
        timeline,
        policyDistribution,
        summary: {
            totalTraces: recentTraces.length,
            decisions: recentTraces.map(t => t.decision),
            outcomes: recentTraces.map(t => t.outcome),
            avgConfidence: recentTraces.length > 0
                ? Math.round(recentTraces.reduce((sum, t) => sum + t.confidence, 0) / recentTraces.length)
                : 0
        }
    };
}

// ======================================================
// GOVERNANCE EXPLAINABILITY REPORT
// ======================================================

/**
 * Generate governance explainability report.
 */
async function generateGovernanceReport(redis, scene = null) {
    const report = {
        timestamp: Date.now(),
        generatedAt: new Date().toISOString(),
        metadata: {
            totalTraces: 0,
            byType: {},
            avgConfidence: 0
        }
    };

    // Count total traces
    const keys = await redis.keys(`${TRACE_PREFIX}:*`);
    report.metadata.totalTraces = keys.length;

    // Sample traces for analysis
    const samples = [];
    for (const key of keys.slice(0, 100)) {
        const raw = await redis.get(key);
        if (raw) {
            try {
                const trace = JSON.parse(raw);
                samples.push(trace);
            } catch (e) {
                // Skip
            }
        }
    }

    // Analyze samples
    report.analysis = {
        traceCount: samples.length,
        avgConfidence: samples.length > 0
            ? Math.round(samples.reduce((sum, t) => sum + t.confidence, 0) / samples.length)
            : 0,
        byType: {},
        byOutcome: {},
        blockingPolicies: {},
        signals: {}
    };

    samples.forEach(trace => {
        // Type counts
        const type = trace.type || 'unknown';
        report.analysis.byType[type] = (report.analysis.byType[type] || 0) + 1;

        // Outcome counts
        const outcome = trace.outcome || 'unknown';
        report.analysis.byOutcome[outcome] = (report.analysis.byOutcome[outcome] || 0) + 1;

        // Policy blocking analysis
        trace.policyChain.forEach(policy => {
            if (!policy.allowed) {
                if (!report.analysis.blockingPolicies[policy.policy]) {
                    report.analysis.blockingPolicies[policy.policy] = { count: 0, reasons: {} };
                }
                report.analysis.blockingPolicies[policy.policy].count++;
                report.analysis.blockingPolicies[policy.policy].reasons[policy.reason] = 
                    (report.analysis.blockingPolicies[policy.policy].reasons[policy.reason] || 0) + 1;
            }

            // Signal analysis
            policy.signals.forEach(signal => {
                if (!report.analysis.signals[signal.name]) {
                    report.analysis.signals[signal.name] = { count: 0, values: [] };
                }
                report.analysis.signals[signal.name].count++;
                report.analysis.signals[signal.name].values.push(signal.value);
            });
        });
    });

    return report;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    TraceType,
    TraceConfig: TRACE_CONFIG,

    // Trace creation
    createTrace,
    createPolicyDecision,
    PolicyDecisionFormat,

    // Policy chain building
    buildPolicyChain,
    buildTraceReason,

    // Storage
    storeTrace,
    getTrace,
    getTraceById,
    getDecisionHistory,
    getTracesForScene,
    getTracesByType,
    getDecisionsByPolicy,
    updateDecisionAggregate,
    getDecisionAggregates,

    // Explainability queries
    getDecisionExplanation,
    getPolicyChainExplanation,
    getGovernanceExplanation,
    getBlockedPolicies,

    // Replay and analysis
    replayTrace,
    getTraceVisualizationData,

    // Governance reporting
    generateGovernanceReport
};
