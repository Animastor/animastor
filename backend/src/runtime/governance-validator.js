// ======================================================
// Governance Validator - v1.0.0
// ======================================================
// Validates new policies before they affect production.
// Ensures policies meet safety guarantees and constraints.
//
// Key idea: Validate before apply.

const invariantEngine = require('./invariant-engine');
const policySimulator = require('./policy-simulator');
const failureReplay = require('./failure-replay');
const governanceHealth = require('./governance-health');

const logPrefix = '[VALIDATION]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function debug(msg) {
    console.debug(`${logPrefix} • ${msg}`);
}

// ======================================================
// VALIDATION CONFIGURATION
// ======================================================

const VALIDATION_CONFIG = {
    // Validation modes
    modes: {
        STATIC: 'static',          // Static policy structure check
        REPLAY: 'replay',          // Replay historical failures
        SIMULATION: 'simulation',  // Simulation against workload
        GOVERNANCE: 'governance'   // Full governance validation
    },

    // Validation thresholds
    thresholds: {
        maxViolationCount: 0,        // Zero violations allowed
        maxWarningCount: 3,          // Up to 3 warnings allowed
        minRecoveryRate: 0.8,        // Minimum 80% recovery rate
        maxPerformanceDegradation: 1.2, // Max 20% worse
        maxInvariantViolations: 0
    },

    // Risk levels
    riskLevels: {
        SAFE: 'safe',        // All checks pass
        WARNING: 'warning',  // Some warnings, proceed with caution
        RISKY: 'risky',      // Some violations, review required
        BLOCKED: 'blocked'   // Critical violations, do not apply
    }
};

// ======================================================
// POLICY VALIDATION KEY PATTERNS
// ======================================================

const VALIDATION_PREFIX = 'animastor:governance:validator';
const POLICY_HISTORY_KEY = `${VALIDATION_PREFIX}:history`;
const POLICY_CERTIFIED_KEY = `${VALIDATION_PREFIX}:certified`;
const VALIDATION_RESULTS_KEY = `${VALIDATION_PREFIX}:results`;

// ======================================================
// POLICY SAFETY CONTRACTS
// ======================================================

/**
 * Define safety contract for a policy.
 */
function definePolicyContract(policyName, contract) {
    return {
        policyName,
        guarantees: contract.guarantees || [],
        constraints: contract.constraints || [],
        maxImpact: contract.maxImpact || 0.3, // 30% default max impact
        allowedOverrides: contract.allowedOverrides || [],
        validatedAt: Date.now(),
        validatedAtFormatted: new Date().toISOString()
    };
}

// Policy safety contracts
const POLICY_CONTRACTS = {
    overload: definePolicyContract('overload', {
        guarantees: [
            'overload protection enabled',
            'capacity limits respected',
            'no dispatch quota exceeded'
        ],
        constraints: [
            'max overload score 100',
            'min active scenes 10',
            'quota utilization < 0.98'
        ],
        maxImpact: 0.2, // 20% max adaptation
        allowedOverrides: ['priority', 'fairness']
    }),

    retry: definePolicyContract('retry', {
        guarantees: [
            'retry budget never negative',
            'retries cannot bypass circuits',
            'retries cannot bypass overload'
        ],
        constraints: [
            'max retries per workload 10',
            'min retry delay 1000ms',
            'max retry delay 3600000ms'
        ],
        maxImpact: 0.25,
        allowedOverrides: ['priority']
    }),

    circuit: definePolicyContract('circuit', {
        guarantees: [
            'open circuit blocks dispatch',
            'half-open allows试探',
            'closed allows normal dispatch'
        ],
        constraints: [
            'min failure threshold 5',
            'max failure threshold 100',
            'reset timeout 30000ms'
        ],
        maxImpact: 0.15,
        allowedOverrides: []
    }),

    fairness: definePolicyContract('fairness', {
        guarantees: [
            'no book monopolization',
            'starvation boost bounded',
            'queue fairness maintained'
        ],
        constraints: [
            'max scenes per book 10',
            'max boost multiplier 3.0',
            'starvation threshold min 5 min'
        ],
        maxImpact: 0.1,
        allowedOverrides: ['priority']
    }),

    priority: definePolicyContract('priority', {
        guarantees: [
            'higher priority jobs dispatched first',
            'queue order maintained',
            'starvation prevented'
        ],
        constraints: [
            'min priority 0',
            'max priority 100',
            'boost multiplier max 3.0'
        ],
        maxImpact: 0.1,
        allowedOverrides: []
    }),

    workload: definePolicyContract('workload', {
        guarantees: [
            'workload classified correctly',
            'cost estimated accurately',
            'routing optimized'
        ],
        constraints: [
            'class audio image,video',
            'max_concurrent appropriate per class'
        ],
        maxImpact: 0.05,
        allowedOverrides: []
    })
};

// ======================================================
// STATIC VALIDATION
// ======================================================

/**
 * Validate policy structure and constraints statically.
 */
function validateStaticPolicy(policyConfig, policyName) {
    const contract = POLICY_CONTRACTS[policyName];
    const violations = [];
    const warnings = [];

    if (!contract) {
        violations.push({
            type: 'missing_contract',
            policyName,
            severity: 'critical',
            description: `No safety contract defined for policy: ${policyName}`
        });

        return {
            validated: false,
            violations: [ ...violations ],
            warnings: [ ...warnings ],
            riskLevel: VALIDATION_CONFIG.riskLevels.BLOCKED
        };
    }

    // Check constraints
    for (const constraint of contract.constraints) {
        const parsed = parseConstraint(constraint);

        if (!parsed) continue;

        const violation = checkConstraint(policyConfig, parsed);

        if (violation) {
            violations.push(violation);
        }
    }

    // Check max impact
    if (contract.maxImpact < 1) {
        // Policy can only change by maxImpact
        if (policyConfig.max_adaptation && policyConfig.max_adaptation > contract.maxImpact) {
            warnings.push({
                type: 'impact_exceeded',
                policyName,
                current: policyConfig.max_adaptation,
                max: contract.maxImpact,
                description: `Adaptation exceeds allowed max: ${policyConfig.max_adaptation} > ${contract.maxImpact}`
            });
        }
    }

    // Check allowed overrides
    if (policyConfig.allowed_overrides) {
        for (const override of policyConfig.allowed_overrides) {
            if (!contract.allowedOverrides.includes(override)) {
                warnings.push({
                    type: 'disallowed_override',
                    policyName,
                    override,
                    allowed: contract.allowedOverrides,
                    description: `Override ${override} not allowed for ${policyName}`
                });
            }
        }
    }

    const riskLevel = determineRiskLevel(violations, warnings);

    return {
        validated: riskLevel !== VALIDATION_CONFIG.riskLevels.BLOCKED,
        violations,
        warnings,
        riskLevel,
        contract
    };
}

/**
 * Parse constraint string.
 */
function parseConstraint(constraint) {
    // Format: "key operator value"
    // e.g., "max overload score 100"
    // e.g., "min failure threshold 5"
    const parts = constraint.split(' ');

    if (parts.length >= 3) {
        const operator = parts[1];
        const value = parseFloat(parts[2]);

        if (['min', 'max', 'equals', 'lt', 'gt'].includes(operator)) {
            return {
                field: parts.slice(0, 2).join('_'), // e.g., "max_overload_score"
                operator,
                value
            };
        }
    }

    return null;
}

/**
 * Check constraint against policy config.
 */
function checkConstraint(policyConfig, parsed) {
    if (!parsed) return null;

    const { field, operator, value } = parsed;

    // Find field in policy config
    let actualValue;
    for (const [key, val] of Object.entries(policyConfig)) {
        if (key.toLowerCase().includes(field.toLowerCase())) {
            actualValue = val;
            break;
        }
    }

    if (actualValue === undefined) {
        return null; // Field not found, skip
    }

    // Check constraint
    let violated = false;
    let message;

    switch (operator) {
        case 'min':
            if (actualValue < value) {
                violated = true;
                message = `${field} below min ${value}: ${actualValue}`;
            }
            break;
        case 'max':
            if (actualValue > value) {
                violated = true;
                message = `${field} above max ${value}: ${actualValue}`;
            }
            break;
        case 'equals':
            if (actualValue !== value) {
                violated = true;
                message = `${field} not equals ${value}: ${actualValue}`;
            }
            break;
        case 'lt':
            if (actualValue >= value) {
                violated = true;
                message = `${field} not lt ${value}: ${actualValue}`;
            }
            break;
        case 'gt':
            if (actualValue <= value) {
                violated = true;
                message = `${field} not gt ${value}: ${actualValue}`;
            }
            break;
    }

    if (violated) {
        return {
            type: 'constraint_violated',
            constraint,
            actualValue,
            rule: message,
            severity: 'high'
        };
    }

    return null;
}

/**
 * Determine risk level based on violations and warnings.
 */
function determineRiskLevel(violations, warnings) {
    const criticalViolations = violations.filter(v => v.severity === 'critical').length;
    const highViolations = violations.filter(v => v.severity === 'high').length;
    const mediumViolations = violations.filter(v => v.severity === 'medium').length;

    if (criticalViolations > 0 || highViolations > 0 || violations.length > 0) {
        return VALIDATION_CONFIG.riskLevels.BLOCKED;
    }

    if (warnings.length > VALIDATION_CONFIG.thresholds.maxWarningCount) {
        return VALIDATION_CONFIG.riskLevels.RISKY;
    }

    if (warnings.length > 0) {
        return VALIDATION_CONFIG.riskLevels.WARNING;
    }

    return VALIDATION_CONFIG.riskLevels.SAFE;
}

// ======================================================
// REPLAY VALIDATION
// ======================================================

/**
 * Validate policy using failure replay.
 */
async function validateWithReplay(redis, policyConfig, testEvents) {
    const violations = [];
    const warnings = [];

    // Run deterministic replay
    const session = await failureReplay.createReplaySession(redis, {
        mode: failureReplay.FAILURE_REPLAY_CONFIG.modes.DETERMINISTIC,
        name: 'policy_validation_replay',
        events: testEvents
    });

    const result = await failureReplay.executeReplay(redis, session, testEvents);

    // Check recovery rate
    const recoveryRate = result.summary.recoveryRate;
    const minRecoveryRate = VALIDATION_CONFIG.thresholds.minRecoveryRate;

    if (recoveryRate < minRecoveryRate) {
        violations.push({
            type: 'recovery_rate_insufficient',
            recoveryRate,
            minRequired: minRecoveryRate,
            scenario: 'failure_replay',
            severity: 'high',
            description: `Recovery rate below threshold: ${recoveryRate}% < ${minRecoveryRate * 100}%`
        });
    }

    // Check count of failures
    const totalEvents = result.summary.totalEvents;
    const failedEvents = result.summary.totalEvents - result.summary.successful - result.summary.delayed;

    if (failedEvents > 0 && failedEvents > totalEvents * 0.2) {
        warnings.push({
            type: 'high_failure_count',
            failedEvents,
            totalEvents,
            failureRate: (failedEvents / totalEvents * 100).toFixed(1),
            severity: 'medium',
            description: `High failure count: ${failedEvents}/${totalEvents}`
        });
    }

    return {
        validated: violations.length === 0,
        violations,
        warnings,
        riskLevel: determineRiskLevel(violations, warnings),
        replayResults: result
    };
}

// ======================================================
// SIMULATION VALIDATION
// ======================================================

/**
 * Validate policy using simulation.
 */
async function validateWithSimulation(redis, policyConfig, workload) {
    const violations = [];
    const warnings = [];

    // Get current policy state
    const currentPolicyState = await policyEngine.getPolicyState(redis);

    // Build simulation state
    const simulationState = {
        activeScenes: await runtime.activeScenes.getActiveCount(redis),
        overloadScore: await runtime.overload.getOverloadScore(redis),
        retryState: await runtime.retryBudget.getRuntimeRetryState(redis),
        policyState: currentPolicyState
    };

    // Simulate with current policy
    const currentSimulation = await policySimulator.simulateDispatch(simulationState, workload);

    // Simulate with proposed policy
    const proposedSimulation = await policySimulator.simulateDispatch(simulationState, workload, policyConfig);

    // Compare outcomes
    const comparison = comparePolicyOutcomes(
        currentSimulation.admission,
        proposedSimulation.admission
    );

    // Check for degradation
    if (comparison.recoveryRateChange < -VALIDATION_CONFIG.thresholds.maxPerformanceDegradation + 1) {
        violations.push({
            type: 'recovery_rate_degraded',
            currentRate: comparison.currentRate,
            proposedRate: comparison.proposedRate,
            change: comparison.recoveryRateChange,
            severity: 'high',
            description: 'Policy would reduce recovery rate'
        });
    }

    if (comparison.avgDelayIncrease > 1000) {
        warnings.push({
            type: 'delay_increased',
            currentDelay: comparison.currentDelay,
            proposedDelay: comparison.proposedDelay,
            increase: comparison.avgDelayIncrease,
            severity: 'medium',
            description: 'Policy would increase average delay'
        });
    }

    return {
        validated: violations.length === 0,
        violations,
        warnings,
        riskLevel: determineRiskLevel(violations, warnings),
        comparison
    };
}

/**
 * Compare policy outcomes.
 */
function comparePolicyOutcomes(currentOutcome, proposedOutcome) {
    const currentRate = currentOutcome.decision.allowed ? 1 : 0;
    const proposedRate = proposedOutcome.decision.allowed ? 1 : 0;
    const delayDiff = (proposedOutcome.delayMs || 0) - (currentOutcome.delayMs || 0);

    return {
        currentRate,
        proposedRate,
        recoveryRateChange: proposedRate - currentRate,
        currentDelay: currentOutcome.delayMs || 0,
        proposedDelay: proposedOutcome.delayMs || 0,
        avgDelayIncrease: delayDiff
    };
}

// ======================================================
// GOVERNANCE VALIDATION
// ======================================================

/**
 * Full governance validation combining all modes.
 */
async function validateGovernance(redis, policyConfig, testEvents, workload, policyName = 'unknown') {
    const results = {
        policyName,
        timestamp: Date.now(),
        modes: {}
    };

    // Static validation
    results.modes.static = validateStaticPolicy(policyConfig, policyName);

    // Replay validation (if events available)
    if (testEvents && testEvents.length > 0) {
        results.modes.replay = await validateWithReplay(redis, policyConfig, testEvents);
    }

    // Simulation validation (if workload available)
    if (workload) {
        results.modes.simulation = await validateWithSimulation(redis, policyConfig, workload);
    }

    // Governance health check
    try {
        const health = await governanceHealth.getGovernanceHealthScore(redis);
        const status = health.status;

        if (status === 'critical') {
            results.modes.health = {
                validated: false,
                violations: [{
                    type: 'unhealthy_runtime',
                    score: health.score,
                    status,
                    severity: 'high'
                }],
                warnings: [],
                riskLevel: VALIDATION_CONFIG.riskLevels.BLOCKED
            };
        } else {
            results.modes.health = {
                validated: true,
                violations: [],
                warnings: [],
                riskLevel: health.score >= 80 ? VALIDATION_CONFIG.riskLevels.SAFE :
                            health.score >= 60 ? VALIDATION_CONFIG.riskLevels.WARNING :
                            VALIDATION_CONFIG.riskLevels.RISKY
            };
        }
    } catch (e) {
        results.modes.health = {
            validated: false,
            violations: [{
                type: 'health_check_failed',
                error: e.message,
                severity: 'high'
            }],
            warnings: [],
            riskLevel: VALIDATION_CONFIG.riskLevels.BLOCKED
        };
    }

    // Overall validation
    const allViolations = [];
    const allWarnings = [];

    for (const [mode, modeResults] of Object.entries(results.modes)) {
        allViolations.push(...(modeResults.violations || []));
        allWarnings.push(...(modeResults.warnings || []));
    }

    const riskLevel = determineRiskLevel(allViolations, allWarnings);

    results.violations = allViolations;
    results.warnings = allWarnings;
    results.riskLevel = riskLevel;
    results.validated = riskLevel === VALIDATION_CONFIG.riskLevels.SAFE;
    results.certified = riskLevel === VALIDATION_CONFIG.riskLevels.SAFE;

    return results;
}

// ======================================================
// GET CERTIFICATION STATUS
// ======================================================

/**
 * Get certification status for a policy version.
 */
async function getPolicyCertification(redis, policyVersion) {
    const key = `${POLICY_CERTIFIED_KEY}:${policyVersion}`;
    const raw = await redis.get(key);

    if (!raw) {
        return {
            certified: false,
            reason: 'version_not_certified',
            policyVersion
        };
    }

    return JSON.parse(raw);
}

/**
 *_certify policy version.
 */
async function certifyPolicyVersion(redis, policyVersion, certification) {
    const key = `${POLICY_CERTIFIED_KEY}:${policyVersion}`;
    const entry = {
        policyVersion,
        ...certification,
        certifiedAt: Date.now(),
        certifiedAtFormatted: new Date().toISOString()
    };

    await redis.set(key, JSON.stringify(entry), 'EX', 86400 * 30); // 30 days

    // Record to history
    const historyKey = POLICY_HISTORY_KEY;
    await redis.lpush(historyKey, JSON.stringify({
        ...entry,
        history: true
    }));
    await redis.ltrim(historyKey, 0, 999);

    return entry;
}

/**
 * Record policy rejection.
 */
async function recordPolicyRejected(redis, policyVersion, rejectionReason) {
    const key = `${VALIDATION_PREFIX}:rejected`;
    const entry = {
        policyVersion,
        rejectionReason,
        rejectedAt: Date.now(),
        rejectedAtFormatted: new Date().toISOString()
    };

    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 999);

    return entry;
}

// ======================================================
// VALIDATION HISTORY
// ======================================================

/**
 * Get validation history.
 */
async function getValidationHistory(redis, limit = 50) {
    const key = POLICY_HISTORY_KEY;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

/**
 * Get recent validations.
 */
async function getRecentValidations(redis, limit = 20) {
    const history = await getValidationHistory(redis, limit);
    return history.sort((a, b) => b.certifiedAt - a.certifiedAt);
}

/**
 * Get validation statistics.
 */
async function getValidationStats(redis) {
    const history = await getValidationHistory(redis, 200);

    const stats = {
        totalValidations: history.length,
        certified: history.filter(h => h.certified).length,
        rejected: history.filter(h => h.certified === false).length,
        byRiskLevel: {
            safe: 0,
            warning: 0,
            risky: 0,
            blocked: 0
        }
    };

    for (const v of history) {
        stats.byRiskLevel[v.riskLevel || 'unknown'] = (stats.byRiskLevel[v.riskLevel || 'unknown'] || 0) + 1;
    }

    return stats;
}

// ======================================================
// VALIDATION RESULTS
// ======================================================

/**
 * Record validation results.
 */
async function recordValidationResults(redis, results) {
    const key = VALIDATION_RESULTS_KEY;
    const entry = {
        ...results,
        timestamp: Date.now(),
        timestampFormatted: new Date().toISOString()
    };

    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 999);

    return entry;
}

/**
 * Get validation results.
 */
async function getValidationResults(redis, limit = 50) {
    const key = VALIDATION_RESULTS_KEY;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

// ======================================================
// VALIDATION HELPERS
// ======================================================

/**
 * Check invariant violations in policy.
 */
async function checkPolicyInvariants(policyConfig) {
    // Use invariant engine to check policy behavior
    const simulationState = {
        policyState: policyConfig,
        currentStage: 'image_ready'
    };

    // Check governance invariants
    const violations = invariantEngine.checkGovernanceInvariants(
        policyConfig,
        {}, // adaptation config
        {} // governance config
    );

    return {
        invariantViolations: violations,
        isValid: violations.length === 0
    };
}

/**
 * Generate safety contract summary.
 */
function generateSafetyContractSummary(policyName, policyConfig) {
    const contract = POLICY_CONTRACTS[policyName];

    if (!contract) {
        return {
            policyName,
            hasContract: false,
            reason: 'No safety contract defined'
        };
    }

    return {
        policyName,
        hasContract: true,
        guarantees: contract.guarantees,
        constraints: contract.constraints,
        maxImpact: contract.maxImpact,
        allowedOverrides: contract.allowedOverrides,
        policyConfig
    };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    VALIDATION_CONFIG,

    // Policy contracts
    POLICY_CONTRACTS,
    definePolicyContract,
    generateSafetyContractSummary,

    // Static validation
    validateStaticPolicy,
    parseConstraint,
    checkConstraint,
    determineRiskLevel,

    // Replay validation
    validateWithReplay,

    // Simulation validation
    validateWithSimulation,
    comparePolicyOutcomes,

    // Governance validation
    validateGovernance,
    getPolicyCertification,
    certifyPolicyVersion,
    recordPolicyRejected,

    // History
    getValidationHistory,
    getRecentValidations,
    getValidationStats,
    recordValidationResults,
    getValidationResults,

    // Helpers
    checkPolicyInvariants,

    // Constants
    VALIDATION_PREFIX,
    POLICY_HISTORY_KEY,
    POLICY_CERTIFIED_KEY,
    VALIDATION_RESULTS_KEY
};
