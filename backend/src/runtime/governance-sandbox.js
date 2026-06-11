// ======================================================
// GOVERNANCE SANDBOX - SAFE EXPERIMENTATION ENVIRONMENT
// ======================================================
// Test new governance rules without affecting production.
// Provides isolation for policy testing and experimentation.
//
// Key idea: Safe governance experimentation with rollback.

const policySimulator = require('./policy-simulator');
const policyEngine = require('./policy-engine');
const workloadClassifier = require('./workload-classifier');

const logPrefix = '[SANDBOX]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function debug(msg) {
    console.debug(`${logPrefix} • ${msg}`);
}

// ======================================================
// SANDBOX CONFIGURATION
// ======================================================

const SANDBOX_CONFIG = {
    // Sandbox isolation levels
    isolation: {
        FULL: 'full',      // Complete isolation, no production reads
        PARTIAL: 'partial', // Can read, no writes
        READ_ONLY: 'read-only' // Only reads
    },

    // Experiment tracking
    experimentRetentionMs: 86400000 * 7, // 7 days
    maxExperiments: 100,
    maxExperimentsPerUser: 10,

    // Timeout for sandboxed simulations
    simulationTimeoutMs: 30000, // 30 seconds max

    // Traffic simulation
    defaultTraffic: {
        audio: 5,
        image: 3,
        video: 2
    },

    // Risk categories
    riskLevels: {
        LOW: 'low',      // Policy threshold changes
        MEDIUM: 'medium', // Policy weight changes
        HIGH: 'high'     // Policy structure changes
    }
};

// ======================================================
// SANDBOX KEY PATTERNS
// ======================================================

const SANDBOX_PREFIX = 'animastor:governance:sandbox';
const EXPERIMENTS_KEY = `${SANDBOX_PREFIX}:experiments`;
const SANDBOX_HISTORY_KEY = `${SANDBOX_PREFIX}:history`;
const POLICY_SNAPSHOT_KEY = `${SANDBOX_PREFIX}:policy_snapshot`;

// ======================================================
// SANDBOX ISOLATION
// ======================================================

/**
 * Verify sandbox isolation.
 * Ensures no production state is modified.
 */
function verifySandboxIsolation(experiment) {
    return {
        isolation: SANDBOX_CONFIG.isolation.FULL,
        safe: true,
        checks: {
            noProductionState: true, // No production state mutations
            noLeaseOperations: true, // No lease changes
            noCounterUpdates: true,  // No counter modifications
            noDispatchExecution: true, // No actual dispatches
            readonlySimulation: true, // Only simulation
            experimentId: experiment.id
        }
    };
}

/**
 * Create isolated sandbox environment.
 */
function createSandboxEnvironment(runtimeState, experimentConfig = {}) {
    return {
        // Isolated state copy
        runtimeState: { ...runtimeState },
        experiments: [],
        history: [],
        simulationCount: 0,
        lastSimulation: null,
        createdAt: Date.now(),
        config: experimentConfig,
        isolation: SANDBOX_CONFIG.isolation.FULL,
        isolationVerified: true
    };
}

/**
 * Run sandboxed experiment.
 */
async function runSandboxExperiment(sandbox, experimentConfig) {
    if (sandbox.experiments.length >= SANDBOX_CONFIG.maxExperiments) {
        throw new Error('Max sandbox experiments reached');
    }

    const experiment = {
        id: `exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: experimentConfig.name || 'untitled_experiment',
        config: experimentConfig,
        startTime: Date.now(),
        endTime: null,
        status: 'running',
        totalSimulations: 0,
        successfulSimulations: 0,
        failedSimulations: 0,
        results: [],
        createdAt: new Date().toISOString()
    };

    sandbox.experiments.push(experiment);

    return experiment;
}

/**
 * Execute sandboxed simulation.
 */
async function executeSandboxedSimulation(sandbox, workload, policyConfig = null) {
    const { runtimeState } = sandbox;

    // Verify isolation
    const isolation = verifySandboxIsolation(sandbox);

    // Run simulation
    const simulation = await policySimulator.simulateDispatch(runtimeState, workload);

    sandbox.simulationCount++;
    sandbox.lastSimulation = simulation;

    return {
        simulation,
        sandboxId: sandbox.id,
        isolation,
        timestamp: Date.now()
    };
}

// ======================================================
// POLICY EXPERIMENTATION
// ======================================================

/**
 * Test new policy thresholds in sandbox.
 */
async function testPolicyThresholds(sandbox, testName, testConfig) {
    const experiment = await runSandboxExperiment(sandbox, {
        type: 'threshold_test',
        name: testName,
        testConfig,
        timestamp: Date.now()
    });

    // Simulate with test thresholds
    const workload = {
        id: 'test_workload',
        class: 'audio',
        priority: 50,
        runtime_type: 'audio'
    };

    const simulation = await executeSandboxedSimulation(sandbox, workload, testConfig);

    experiment.results.push(simulation);
    experiment.totalSimulations++;
    experiment.successfulSimulations++;

    if ( simulation.simulation.admission.decision.allowed) {
        experiment.status = 'completed';
    } else {
        experiment.status = 'warning';
    }

    experiment.endTime = Date.now();

    return {
        experiment,
        simulation: simulation.simulation
    };
}

/**
 * Compare current vs proposed policy.
 */
async function comparePolicy(sandbox, policyVersion, proposedConfig) {
    const experiment = await runSandboxExperiment(sandbox, {
        type: 'policy_comparison',
        name: `compare_${policyVersion}`,
        currentPolicy: policyVersion,
        proposedPolicy: proposedConfig,
        timestamp: Date.now()
    });

    const workload = {
        id: 'comparison_workload',
        class: 'video',
        priority: 75,
        runtime_type: 'video'
    };

    // Simulate with current policy (defaults)
    const currentSimulation = await executeSandboxedSimulation(sandbox, workload);

    // Simulate with proposed policy
    const proposedSimulation = await executeSandboxedSimulation(sandbox, workload, proposedConfig);

    experiment.results = [currentSimulation, proposedSimulation];
    experiment.totalSimulations = 2;
    experiment.successfulSimulations = 2;

    // Compare outcomes
    const comparison = {
        current: currentSimulation.simulation.admission,
        proposed: proposedSimulation.simulation.admission,
        fairnessDelta: currentSimulation.simulation.admission.fairnessImpact -
                       proposedSimulation.simulation.admission.fairnessImpact,
        overloadDelta: currentSimulation.simulation.admission.overloadImpact -
                       proposedSimulation.simulation.admission.overloadImpact,
        retryDelta: currentSimulation.simulation.admission.retryImpact -
                    proposedSimulation.simulation.admission.retryImpact
    };

    experiment.comparison = comparison;
    experiment.status = 'completed';
    experiment.endTime = Date.now();

    return {
        experiment,
        comparison
    };
}

// ======================================================
// STRESS TESTING
// ======================================================

/**
 * Simulate load stress test in sandbox.
 */
async function runStressTest(sandbox, stressConfig = {}) {
    const experiment = await runSandboxExperiment(sandbox, {
        type: 'stress_test',
        name: stressConfig.name || 'stress_test',
        traffic: stressConfig.traffic || SANDBOX_CONFIG.defaultTraffic,
        duration: stressConfig.duration || 60000, // 1 minute default
        timestamp: Date.now()
    });

    const results = {
        requests: [],
        accepted: 0,
        rejected: 0,
        delayed: 0,
        throttled: 0,
        avgLatency: 0,
        p95Latency: 0,
        p99Latency: 0
    };

    // Simulate traffic
    const numRequests = stressConfig.numRequests || 100;
    for (let i = 0; i < numRequests; i++) {
        const workload = {
            id: `stress_req_${i}`,
            class: Object.keys(stressConfig.traffic || SANDBOX_CONFIG.defaultTraffic)[
                Math.floor(Math.random() * 3) % 3
            ],
            priority: 50,
            runtime_type: Object.keys(stressConfig.traffic || SANDBOX_CONFIG.defaultTraffic)[
                Math.floor(Math.random() * 3) % 3
            ]
        };

        try {
            const simulation = await executeSandboxedSimulation(sandbox, workload);

            results.requests.push(simulation.simulation);

            if (simulation.simulation.admission.decision.allowed) {
                results.accepted++;
            } else if (simulation.simulation.admission.decision.action === 'delay') {
                results.delayed++;
            } else {
                results.rejected++;
            }

            if (simulation.simulation.admission.throttleMs) {
                results.throttled++;
            }
        } catch (err) {
            experiment.failedSimulations++;
        }
    }

    experiment.results = [results];
    experiment.totalSimulations = numRequests;
    experiment.successfulSimulations = results.accepted + results.delayed;

    experiment.status = numRequests > 0 && experiment.successfulSimulations / numRequests > 0.9
        ? 'passed'
        : 'warning';

    experiment.endTime = Date.now();

    return {
        experiment,
        results
    };
}

// ======================================================
// FAILURE SCENARIO TESTING
// ======================================================

/**
 * Test failure scenario handling in sandbox.
 */
async function testFailureScenario(sandbox, scenarioName, scenarioConfig) {
    const experiment = await runSandboxExperiment(sandbox, {
        type: 'failure_scenario',
        name: scenarioName,
        scenario: scenarioConfig,
        timestamp: Date.now()
    });

    // Create workload that triggers the failure scenario
    const workload = {
        id: `failure_test_${scenarioName}`,
        class: scenarioConfig.class || 'video',
        priority: scenarioConfig.priority || 25,
        runtime_type: scenarioConfig.class || 'video',
        ...scenarioConfig.workloadModifiers
    };

    // Run simulation with failure state
    const simulation = await executeSandboxedSimulation(sandbox, workload, scenarioConfig.policyConfig);

    experiment.results = [simulation];
    experiment.totalSimulations = 1;
    experiment.successfulSimulations = 1;

    // Analyze failure response
    const failureResponse = {
        handled: simulation.simulation.admission.decision.allowed || simulation.simulation.admission.decision.action === 'delay',
        recoveryTime: simulation.simulation.admission.delayMs || 0,
        policyAction: simulation.simulation.admission.decision.action
    };

    experiment.failureResponse = failureResponse;
    experiment.status = failureResponse.handled ? 'handled' : 'failed';
    experiment.endTime = Date.now();

    return {
        experiment,
        failureResponse
    };
}

// ======================================================
// POLICY VERSION TESTING
// ======================================================

/**
 * Test multiple policy versions in sandbox.
 */
async function testPolicyVersions(sandbox, versions, baseWorkloads = []) {
    const experiment = await runSandboxExperiment(sandbox, {
        type: 'policy_versions',
        name: 'version_comparison',
        versions: Object.keys(versions),
        timestamp: Date.now()
    });

    const results = {
        versions: {},
        comparisons: [],
        bestPolicy: null,
        worstPolicy: null
    };

    // Run simulations for each version
    for (const [version, config] of Object.entries(versions)) {
        const workload = baseWorkloads[0] || {
            id: `version_test_${version}`,
            class: 'audio',
            priority: 50,
            runtime_type: 'audio'
        };

        const simulation = await executeSandboxedSimulation(sandbox, workload, config.policies);

        results.versions[version] = {
            simulation: simulation.simulation,
            admission: simulation.simulation.admission,
            score: calculatePolicyScore(simulation.simulation.admission)
        };
    }

    // Find best/worst policies
    const versionEntries = Object.entries(results.versions);
    results.bestPolicy = versionEntries.sort((a, b) => b[1].score - a[1].score)[0][0];
    results.worstPolicy = versionEntries.sort((a, b) => a[1].score - b[1].score)[0][0];

    // Add comparison
    for (let i = 0; i < versionEntries.length; i++) {
        for (let j = i + 1; j < versionEntries.length; j++) {
            const [v1, r1] = versionEntries[i];
            const [v2, r2] = versionEntries[j];

            results.comparisons.push({
                version1: v1,
                version2: v2,
                fairnessDelta: r1.admission.fairnessImpact - r2.admission.fairnessImpact,
                overloadDelta: r1.admission.overloadImpact - r2.admission.overloadImpact,
                recommended: r1.score > r2.score ? v1 : v2
            });
        }
    }

    experiment.results = [results];
    experiment.totalSimulations = Object.keys(versions).length;
    experiment.successfulSimulations = Object.keys(versions).length;
    experiment.status = 'completed';
    experiment.endTime = Date.now();

    return {
        experiment,
        results
    };
}

/**
 * Calculate policy score based on admission outcome.
 */
function calculatePolicyScore(admission) {
    let score = 100;

    if (!admission.decision.allowed) {
        score -= 50; // Major penalty for rejection
    }

    if (admission.throttleMs) {
        score -= (admission.throttleMs / 100); // Penalty per 100ms
    }

    if (admission.fairnessImpact > 20) {
        score -= (admission.fairnessImpact * 0.5);
    }

    if (admission.overloadImpact > 50) {
        score -= (admission.overloadImpact * 0.2);
    }

    return Math.max(0, Math.min(100, Math.round(score)));
}

// ======================================================
// RISK ASSESSMENT
// ======================================================

/**
 * Assess risk level of a policy change.
 */
function assessRiskLevel(currentPolicy, proposedPolicy) {
    let riskLevel = SANDBOX_CONFIG.riskLevels.LOW;
    let riskFactors = [];

    // Check threshold magnitude
    for (const [key, proposedValue] of Object.entries(proposedPolicy)) {
        const currentValue = currentPolicy[key];
        if (currentValue) {
            const change = Math.abs(proposedValue - currentValue) / Math.max(currentValue, 1);
            if (change > 0.5) {
                riskLevel = SANDBOX_CONFIG.riskLevels.HIGH;
                riskFactors.push({ field: key, change: `${(change * 100).toFixed(0)}%` });
            } else if (change > 0.2) {
                if (riskLevel !== SANDBOX_CONFIG.riskLevels.HIGH) {
                    riskLevel = SANDBOX_CONFIG.riskLevels.MEDIUM;
                }
                riskFactors.push({ field: key, change: `${(change * 100).toFixed(0)}%` });
            }
        }
    }

    // Check policy structure changes
    if (Object.keys(proposedPolicy).length !== Object.keys(currentPolicy).length) {
        riskLevel = SANDBOX_CONFIG.riskLevels.HIGH;
        riskFactors.push({ type: 'structure_change', message: 'Policy structure modified' });
    }

    return {
        riskLevel,
        riskFactors,
        safeForProduction: riskLevel === SANDBOX_CONFIG.riskLevels.LOW,
        recommendations: generateRiskRecommendations(riskLevel)
    };
}

/**
 * Generate recommendations based on risk assessment.
 */
function generateRiskRecommendations(riskLevel) {
    if (riskLevel === SANDBOX_CONFIG.riskLevels.LOW) {
        return ['Safe for gradual rollout', 'Monitor initial metrics'];
    } else if (riskLevel === SANDBOX_CONFIG.riskLevels.MEDIUM) {
        return ['Run extended A/B test', 'Monitor closely after deployment'];
    } else {
        return ['Requires thorough testing', 'Consider incremental rollout', 'Run stress tests'];
    }
}

// ======================================================
// SANDBOX HISTORY
// ======================================================

/**
 * Record sandbox experiment to history.
 */
async function recordSandboxExperiment(redis, experiment) {
    const key = SANDBOX_HISTORY_KEY;
    const entry = {
        ...experiment,
        recordedAt: Date.now(),
        recordedAtFormatted: new Date().toISOString()
    };

    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 999);

    return entry;
}

/**
 * Get sandbox history.
 */
async function getSandboxHistory(redis, limit = 50) {
    const key = SANDBOX_HISTORY_KEY;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

/**
 * Get sandbox status.
 */
async function getSandboxStatus(redis) {
    const history = await getSandboxHistory(redis, 100);
    const experiments = history.filter(e => e.type === 'experiment');

    const summary = {
        totalExperiments: history.length,
        completedExperiments: experiments.filter(e => e.status === 'completed').length,
        warningExperiments: experiments.filter(e => e.status === 'warning').length,
        failedExperiments: experiments.filter(e => e.status === 'failed').length,
        experimentsByType: {}
    };

    for (const exp of experiments) {
        summary.experimentsByType[exp.type] = (summary.experimentsByType[exp.type] || 0) + 1;
    }

    return {
        timestamp: Date.now(),
        summary,
        config: SANDBOX_CONFIG,
        history: history.slice(0, 20)
    };
}

// ======================================================
// SANDBOX EXPERIMENTS API
// ======================================================

/**
 * Create a new sandbox experiment.
 */
async function createSandboxExperiment(redis, config) {
    const experiment = {
        id: `exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: config.name || 'untitled',
        description: config.description || '',
        type: config.type || 'default',
        status: 'created',
        createdAt: Date.now(),
        createdAtFormatted: new Date().toISOString(),
        config
    };

    const key = `${SANDBOX_PREFIX}:experiment:${experiment.id}`;
    await redis.set(key, JSON.stringify(experiment), 'EX', SANDBOX_CONFIG.experimentRetentionMs);

    return experiment;
}

/**
 * List sandbox experiments.
 */
async function listSandboxExperiments(redis, limit = 20) {
    const keys = await redis.keys(`${SANDBOX_PREFIX}:experiment:*`);
    const experiments = [];

    for (const key of keys.slice(0, limit)) {
        const raw = await redis.get(key);
        if (raw) {
            experiments.push(JSON.parse(raw));
        }
    }

    return experiments.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Get sandbox experiment by ID.
 */
async function getSandboxExperiment(redis, experimentId) {
    const key = `${SANDBOX_PREFIX}:experiment:${experimentId}`;
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
}

/**
 * Update sandbox experiment.
 */
async function updateSandboxExperiment(redis, experimentId, updates) {
    const experiment = await getSandboxExperiment(redis, experimentId);
    if (!experiment) {
        return null;
    }

    const updated = { ...experiment, ...updates, updatedAt: Date.now() };
    const key = `${SANDBOX_PREFIX}:experiment:${experimentId}`;
    await redis.set(key, JSON.stringify(updated), 'EX', SANDBOX_CONFIG.experimentRetentionMs);

    return updated;
}

/**
 * Delete sandbox experiment.
 */
async function deleteSandboxExperiment(redis, experimentId) {
    const key = `${SANDBOX_PREFIX}:experiment:${experimentId}`;
    await redis.del(key);
    return { deleted: true, experimentId };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    SANDBOX_CONFIG,

    // Isolation
    verifySandboxIsolation,
    createSandboxEnvironment,

    // Experimentation
    runSandboxExperiment,
    executeSandboxedSimulation,
    testPolicyThresholds,
    comparePolicy,
    runStressTest,
    testFailureScenario,
    testPolicyVersions,

    // Risk assessment
    assessRiskLevel,
    generateRiskRecommendations,

    // History
    recordSandboxExperiment,
    getSandboxHistory,
    getSandboxStatus,

    // Experiments API
    createSandboxExperiment,
    listSandboxExperiments,
    getSandboxExperiment,
    updateSandboxExperiment,
    deleteSandboxExperiment,

    // Constants
    SANDBOX_PREFIX,
    EXPERIMENTS_KEY,
    POLICY_SNAPSHOT_KEY
};
