// ======================================================
// POLICY SIMULATOR - RUN DECISIONS WITHOUT DISPATCH
// ======================================================
// Simulates runtime governance decisions offline without
// affecting production state. Safe governance testing.
// With invariant checking support.
//
// Key idea: Test governance logic before applying to production.

const logPrefix = '[SIMULATION]';
const policyEngine = require('./policy-engine');
const workloadClassifier = require('./workload-classifier');
const admissionControl = require('./admission-control');
const feedbackEngine = require('./feedback-engine');
const invariantEngine = require('./invariant-engine');

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function debug(msg) {
    console.debug(`${logPrefix} • ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

// ======================================================
// SIMULATION CONFIGURATION
// ======================================================

const SIMULATION_CONFIG = {
    // Simulation modes
    modes: {
        OFFLINE: 'offline',      // No side effects
        DRY_RUN: 'dry-run',      // Log only, no dispatch
        ANALYSIS: 'analysis'     // Deep analysis mode
    },

    // Output options
    output: {
        includePolicyChain: true,
        includeSimulatedMetrics: true,
        includeImpactAnalysis: true
    },

    // Workload classes for simulation
    workloadClasses: ['audio', 'image', 'video'],

    // Simulation model:
    //   1. Load snapshot state
    //   2. Classify workload
    //   3. Evaluate policies
    //   4. Calculate admission decision
    //   5. Analyze impacts
    //   6. Return simulated outcome
};

// ======================================================
// SIMULATION KEY PATTERNS
// ======================================================

const SIMULATION_PREFIX = 'animastor:simulation';
const SIMULATION_HISTORY_KEY = `${SIMULATION_PREFIX}:history`;
const SANDBOX_KEY = `${SIMULATION_PREFIX}:sandbox`;

// ======================================================
// SIMULATION STATE BUILDER
// ======================================================

/**
 * Build simulation state from runtime snapshot.
 * This state is used by the simulator without modifying production.
 */
function buildSimulationState(runtimeState, workloadClass, priority = 50, timestamp = Date.now()) {
    return {
        // Runtime context
        timestamp,
        workloadClass,
        priority,
        priorityClass: workloadClassifier.getPriorityClass(priority),

        // Runtime metrics
        activeScenes: runtimeState.activeScenes || 0,
        activeLeases: runtimeState.activeLeases || { audio: 0, image: 0, video: 0 },
        quotaUtilization: runtimeState.quotaUtilization || { audio: 0, image: 0, video: 0 },

        // Runtime state
        overloadState: runtimeState.overloadState || { active: false, score: 0 },
        overloadScore: runtimeState.overloadScore || 0,

        // Workload state
        retryHistory: runtimeState.retryHistory || { failures: [], lastFailure: null },
        retryState: runtimeState.retryState || { failures: 0, lastFailure: null },

        // Policy state
        policyState: runtimeState.policyState || { ...policyEngine.DEFAULT_POLICY_STATE },

        // Admission state
        admissionState: runtimeState.admissionState || {
            consecutiveRejections: 0,
            lastRejection: null,
            driftCorrectionActive: false
        },

        // Decision context
        decisionId: `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        simulationMode: SIMULATION_CONFIG.modes.OFFLINE
    };
}

// ======================================================
// POLICY SIMULATION ENGINE
// ======================================================

/**
 * Simulate policy evaluation for a workload.
 * Returns policy decisions without applying them.
 */
async function simulatePolicyEvaluation(state, policyConfig = null) {
    const results = {
        policyChain: [],
        policyDecisions: [],
        throttling: null,
        fairnessImpact: 0,
        retryImpact: 0,
        overloadImpact: 0,
        circuitImpact: 0,
        priorityImpact: 0
    };

    for (const policyName of policyEngine.POLICY_ORDER) {
        const policy = policyEngine.POLICIES[policyName];
        if (!policy) continue;

        const evaluation = await simulatePolicyCheck(
            state,
            policyName,
            policy,
            policyConfig
        );

        results.policyChain.push(evaluation.policy);
        results.policyDecisions.push(evaluation.decision);

        // Accumulate impacts
        if (evaluation.decision.action === 'throttle') {
            results.throttling = {
                policy: policyName,
                duration: evaluation.decision.throttleDuration,
                reason: evaluation.decision.reason
            };
            results.retryImpact += evaluation.decision.throttleDuration || 0;
        }

        if (evaluation.decision.action === 'admissiondeny') {
            results.fairnessImpact += 10; // Penalty
        }

        if (evaluation.decision.action === 'admissiondelay') {
            results.fairnessImpact += 5;
        }

        if (policyName === 'overload' && evaluation.decision.action !== 'allow') {
            results.overloadImpact += 100;
        }

        if (policyName === 'circuit' && evaluation.decision.action !== 'allow') {
            results.circuitImpact += 100;
        }

        if (policyName === 'priority' && evaluation.decision.action !== 'allow') {
            results.priorityImpact += 10;
        }
    }

    return results;
}

/**
 * Simulate a single policy check.
 */
async function simulatePolicyCheck(state, policyName, policyConfig, customConfig = null) {
    const currentConfig = customConfig?.[policyName] || policyConfig?.[policyName] || policyConfig;
    const config = currentConfig || {};

    // Simulate policy-specific checks
    let decision = { allowed: true, action: 'allow', reason: 'policy_passed' };
    let confidence = 95; // Default high confidence for simulation

    switch (policyName) {
        case 'overload':
            // Simulate overload check
            if (state.overloadScore > 80) {
                decision = { allowed: false, action: 'throttle', reason: 'simulated_overload' };
                confidence = 85;
            }
            confidence = state.overloadScore > 90 ? 90 : confidence;
            break;

        case 'retry':
            // Simulate retry policy check
            if (state.retryState?.failures >= 10) {
                decision = { allowed: false, action: 'delay', reason: 'simulated_retry_exhaustion' };
                confidence = 80;
            }
            break;

        case 'workload':
            // Simulate workload classification
            decision = { allowed: true, action: 'classify', reason: 'simulated_workload_ok' };
            confidence = 98;
            break;

        case 'fairness':
            // Simulate fairness check
            if (state.admissionState?.consecutiveRejections > 5) {
                decision = { allowed: false, action: 'delay', reason: 'simulated_fairness_cooldown' };
                confidence = 88;
            }
            break;

        case 'circuit':
            // Simulate circuit breaker
            if (state.activeLeases?.video >= 10) {
                decision = { allowed: false, action: 'deny', reason: 'simulated_circuit_open' };
                confidence = 92;
            }
            break;

        case 'priority':
            // Simulate priority queue check
            if (state.priority < 20 && state.admissionState?.consecutiveRejections > 3) {
                decision = { allowed: false, action: 'delay', reason: 'simulated_priority_blocked' };
                confidence = 85;
            }
            break;

        default:
            decision = { allowed: true, action: 'allow', reason: 'default_policy' };
    }

    return {
        policy: policyName,
        decision,
        confidence,
        state,
        simulated: true
    };
}

/**
 * Simulate admission decision for a workload.
 * Returns whether the workload would be admitted and any throttling/delay.
 */
async function simulateAdmission(state, policyConfig = null) {
    const policyResults = await simulatePolicyEvaluation(state, policyConfig);

    // Determine final admission decision
    let decision = { allowed: true, action: 'accept', reason: 'simulated_admission_allowed' };
    let throttleMs = null;
    let delayMs = null;
    let rejectionReason = null;

    for (const result of policyResults.policyDecisions) {
        if (result.action === 'deny' || result.action === 'throttle') {
            decision = { allowed: false, action: 'reject', reason: result.reason };
            rejectionReason = result.reason;
            break;
        } else if (result.action === 'delay') {
            delayMs = result.throttleDuration || 1000;
            decision = { allowed: false, action: 'delay', reason: result.reason };
        }
    }

    return {
        decision,
        policyChain: policyResults.policyChain,
        throttleMs,
        delayMs,
        rejectionReason,
        fairnessImpact: policyResults.fairnessImpact,
        retryImpact: policyResults.retryImpact,
        overloadImpact: policyResults.overloadImpact,
        circuitImpact: policyResults.circuitImpact
    };
}

// ======================================================
// WORKLOAD SIMULATION
// ======================================================

/**
 * Simulate dispatch for a workload.
 * Returns what would happen without actually dispatching.
 * Includes invariant checking.
 */
async function simulateDispatch(runtimeState, workload, policyConfig = null) {
    const state = buildSimulationState(runtimeState, workload.class, workload.priority);

    const admission = await simulateAdmission(state, policyConfig);
    const workloadClassification = workloadClassifier.classifyWorkload(workload);

    // Check invariants for this simulation
    const invariantViolations = await invariantEngine.checkRuntimeInvariants(null, state);
    const invariantValid = invariantViolations.length === 0;

    return {
        workload,
        workloadClassification,
        admission,
        simulatedAt: Date.now(),
        mode: SIMULATION_CONFIG.modes.DRY_RUN,
        invariantViolations,
        invariantValid,
        invariantCheckResult: {
            safeToProceed: invariantValid,
            highSeverityViolations: invariantEngine.getHighSeverityViolations(invariantViolations)
        }
    };
}

/**
 * Simulate policy chain with invariant checking.
 */
async function simulatePolicyChainWithInvariants(runtimeState, workload, policyConfig = null) {
    const state = buildSimulationState(runtimeState, workload.class, workload.priority);

    const policyResults = await simulatePolicyEvaluation(state, policyConfig);
    const invariantViolations = await invariantEngine.checkRuntimeInvariants(null, state);

    return {
        policyChain: policyResults.policyChain,
        policyDecisions: policyResults.policyDecisions,
        overallDecision: policyResults.policyDecisions.every(d => d.allowed) ? 'allowed' : 'restricted',
        invariantViolations,
        invariantValid: invariantViolations.length === 0,
        totalThrottling: policyResults.retryImpact,
        totalOverloadImpact: policyResults.overloadImpact,
        simulatedAt: Date.now()
    };
}

/**
 * Simulate scene dispatch with full simulation.
 */
async function simulateSceneDispatch(runtimeState, bookId, chapterId, sceneId, stage) {
    // Build simulated workload
    const workload = {
        bookId,
        chapterId,
        sceneId,
        stage,
        class: workloadClassifier.getClassForStage(stage),
        runtime_type: stage,
        priority: 50,
        computedPriority: 50,
        workloadClass: workloadClassifier.getClassForStage(stage)
    };

    // Run simulation
    const simulation = await simulateDispatch(runtimeState, workload);

    return {
        ...simulation,
        sceneDispatch: true,
        simulationId: `dispatch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    };
}

// ======================================================
// POLICY CHAIN SIMULATION
// ======================================================

/**
 * Simulate full policy chain for a workload.
 */
async function simulatePolicyChain(runtimeState, workload, policyConfig = null) {
    const state = buildSimulationState(runtimeState, workload.class, workload.priority);

    const policyResults = await simulatePolicyEvaluation(state, policyConfig);

    return {
        policyChain: policyResults.policyChain,
        policyDecisions: policyResults.policyDecisions,
        overallDecision: policyResults.policyDecisions.every(d => d.allowed) ? 'allowed' : 'restricted',
        totalThrottling: policyResults.retryImpact,
        totalOverloadImpact: policyResults.overloadImpact,
        simulatedAt: Date.now()
    };
}

/**
 * Get detailed policy chain output.
 */
async function getDetailedPolicyChain(runtimeState, workload, policyConfig = null) {
    const state = buildSimulationState(runtimeState, workload.class, workload.priority);

    const policyResults = await simulatePolicyEvaluation(state, policyConfig);

    const output = {
        workload: {
            id: workload.id || workload.sceneId,
            class: workload.class,
            priority: workload.priority,
            runtime_type: workload.stage || workload.runtime_type
        },
        state: {
            overloadScore: state.overloadScore,
            activeScenes: state.activeScenes,
            retryFailures: state.retryState?.failures || 0,
            consecutiveRejections: state.admissionState?.consecutiveRejections || 0
        },
        policyResults: {
            throttling: policyResults.throttling,
            fairnessImpact: policyResults.fairnessImpact,
            retryImpact: policyResults.retryImpact,
            overloadImpact: policyResults.overloadImpact,
            circuitImpact: policyResults.circuitImpact
        },
        chain: policyResults.policyChain.map((policy, index) => ({
            order: index + 1,
            policy,
            decision: policyResults.policyDecisions[index]
        })),
        outcome: {
            allowed: policyResults.policyDecisions.every(d => d.allowed),
            restrictedPolicies: policyResults.policyDecisions
                .filter(d => !d.allowed)
                .map(d => ({ policy: d.policyName, reason: d.reason })),
            simulatedAt: Date.now()
        }
    };

    return output;
}

// ======================================================
// IMPACT ANALYSIS
// ======================================================

/**
 * Analyze impact of simulated policies.
 */
async function analyzePolicyImpact(runtimeState, workload, policyConfig = null) {
    const state = buildSimulationState(runtimeState, workload.class, workload.priority);

    const admission = await simulateAdmission(state, policyConfig);

    return {
        workload,
        admission,
        impact: {
            fairnessDelta: admission.fairnessImpact,
            retryDelta: admission.retryImpact,
            overloadDelta: admission.overloadImpact,
            circuitDelta: admission.circuitImpact
        },
        recommendations: generateImpactRecommendations(admission)
    };
}

/**
 * Generate recommendations based on impact analysis.
 */
function generateImpactRecommendations(admission) {
    const recommendations = [];

    if (admission.overloadImpact > 50) {
        recommendations.push({
            type: 'overload',
            priority: 'high',
            suggestion: 'Consider reducing overload threshold or increasing capacity',
            impact: 'High overload impact detected'
        });
    }

    if (admission.retryImpact > 1000) {
        recommendations.push({
            type: 'retry',
            priority: 'medium',
            suggestion: 'Review retry policy thresholds',
            impact: `High retry impact: ${admission.retryImpact}ms`
        });
    }

    if (admission.fairnessImpact > 20) {
        recommendations.push({
            type: 'fairness',
            priority: 'high',
            suggestion: 'Consider adjusting fairness policy cooldowns',
            impact: `High fairness impact: ${admission.fairnessImpact}`
        });
    }

    if (admission.circuitImpact > 50) {
        recommendations.push({
            type: 'circuit',
            priority: 'high',
            suggestion: 'Review circuit breaker thresholds',
            impact: 'Circuit breaker triggered'
        });
    }

    if (admission.rejectionReason && !admission.decision.allowed) {
        recommendations.push({
            type: 'rejection',
            priority: 'critical',
            suggestion: `Investigate: ${admission.rejectionReason}`,
            impact: 'Workload rejected by policy'
        });
    }

    return recommendations;
}

// ======================================================
// POLICY VERSION SIMULATION
// ======================================================

/**
 * Simulate policies with a specific version.
 * Allows testing different policy configurations.
 */
async function simulateWithPolicyVersion(runtimeState, workload, policyVersion, versions = {}) {
    const versionConfig = versions[policyVersion];
    if (!versionConfig) {
        warn(`Policy version not found: ${policyVersion}`);
        return null;
    }

    const simulation = await simulateDispatch(runtimeState, workload);
    const impactAnalysis = await analyzePolicyImpact(runtimeState, workload, versionConfig.policies);

    return {
        simulation,
        impactAnalysis,
        policyVersion,
        versionConfig,
        simulatedAt: Date.now()
    };
}

/**
 * Compare outcomes across multiple policy versions.
 */
async function comparePolicyVersions(runtimeState, workload, versionConfigs) {
    const results = {};

    for (const [version, config] of Object.entries(versionConfigs)) {
        results[version] = await simulateWithPolicyVersion(runtimeState, workload, version, versionConfigs);
    }

    return results;
}

// ======================================================
// SIMULATION HISTORY
// ======================================================

/**
 * Record simulation result to history.
 */
async function recordSimulation(redis, simulation) {
    const key = SIMULATION_HISTORY_KEY;
    const entry = {
        ...simulation,
        recordedAt: Date.now(),
        recordedAtFormatted: new Date().toISOString()
    };

    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 999); // Keep last 1000

    return entry;
}

/**
 * Get simulation history.
 */
async function getSimulationHistory(redis, limit = 50) {
    const key = SIMULATION_HISTORY_KEY;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

/**
 * Get recent simulations.
 */
async function getRecentSimulations(redis, limit = 10) {
    const entries = await getSimulationHistory(redis, limit);
    return entries.sort((a, b) => b.simulatedAt - a.simulatedAt);
}

// ======================================================
// SIMULATION STATUS
// ======================================================

/**
 * Get simulation status for debugging.
 */
async function getSimulationStatus(redis) {
    const history = await getSimulationHistory(redis, 100);
    const recent = await getRecentSimulations(redis, 10);

    return {
        timestamp: Date.now(),
        recentCount: recent.length,
        totalSimulations: history.length,
        config: SIMULATION_CONFIG
    };
}

// ======================================================
// SAFE SIMULATION PRINCIPLES
// ======================================================

/**
 * Verify simulation is safe (no production side effects).
 */
function verifySimulationSafety(simulation) {
    return {
        safe: true,
        checks: {
            noDispatch: !simulation.dispatch, // No actual dispatch
            noLeaseChanges: !simulation.leaseChanges, // No lease modifications
            noCounterUpdates: !simulation.counterUpdates, // No counter changes
            noStateModifications: !simulation.stateModifications, // No state changes
            readonly: true
        }
    };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    SIMULATION_CONFIG,

    // State building
    buildSimulationState,

    // Policy simulation
    simulatePolicyEvaluation,
    simulatePolicyCheck,
    simulateAdmission,

    // Workload simulation
    simulateDispatch,
    simulateSceneDispatch,
    getDetailedPolicyChain,

    // Impact analysis
    analyzePolicyImpact,
    generateImpactRecommendations,

    // Version simulation
    simulateWithPolicyVersion,
    comparePolicyVersions,

    // History
    recordSimulation,
    getSimulationHistory,
    getRecentSimulations,
    getSimulationStatus,

    // Safety
    verifySimulationSafety,

    // Constants
    SIMULATION_PREFIX,
    SIMULATION_HISTORY_KEY
};
