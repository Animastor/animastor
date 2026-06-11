// ======================================================
// POLICY ENGINE - CENTRAL RUNTIME POLICY AUTHORITY
// ======================================================
// Single authority for all runtime decisions.
// Unifies:
// - dispatch allowed?
// - retry allowed?
// - quota available?
// - fairness violation?
// - overload active?
// - circuit open?
// - priority boost?
// - starvation recovery?
//
// Architecture:
//   scheduler
//      ↓
//   policy-engine (COMPOSABLE POLICY AGGREGATOR)
//      ↓
//   dispatch-engine (EXECUTION)
//      ↓
//   services

const circuitBreaker = require('./circuit-breaker');
const retryBudget = require('./retry-budget-manager');
const fairness = require('./fairness-engine');
const priorityManager = require('./priority-manager');
const workloadClassifier = require('./workload-classifier');

// Phase 11: Policy composition - modular policy modules
const policies = require('./policies');

const logPrefix = '[POLICY]';

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
// POLICY CONFIGURATION
// ======================================================

const POLICY_CONFIG = {
    // Overload thresholds
    overloadActiveScenesThreshold: 100,
    overloadQuotaUtilization: 0.9, // 90% quota used = overload

    // Throttling
    maxDelayMs: 30000, // 30 seconds max delay
    baseDelayMs: 1000, // 1 second base delay

    // Cost-based throttling
    heavyWorkloadDispatchThrottle: 0.5, // 50% rate for heavy workloads
    extremeWorkloadDispatchThrottle: 0.2, // 20% rate for extreme workloads

    // Fairness thresholds
    fairnessViolationThreshold: 20, // score deviation

    // Priority normalization range
    normalizedPriorityMin: 0,
    normalizedPriorityMax: 100,

    // Policy precedence order (lower = higher precedence)
    policyPrecedence: [
        'overload',      // 1 - System protection first
        'circuit',       // 2 - Service availability
        'retry',         // 3 - Retry storm prevention
        'workload',      // 4 - Computational cost routing
        'fairness',      // 5 - Starvation prevention
        'priority'       // 6 - Priority normalization
    ]
};

// ======================================================
// POLICY DECISION TYPES
// ======================================================

const PolicyDecision = {
    ALLOWED: 'allowed',
    BLOCKED: 'blocked',
    DELAYED: 'delayed',
    THROTTLED: 'throttled'
};

// ======================================================
// COST ESTIMATION (injected at runtime)
// ======================================================

let costEstimator = null;

function setCostEstimator(estimator) {
    costEstimator = estimator;
    log(`COST_ESTIMATOR_SET: ${estimator ? 'configured' : 'removed'}`);
}

// ======================================================
// POLICY INPUT VALIDATION
// ======================================================

function validatePolicyInput(input) {
    const errors = [];

    if (!input.scene) errors.push('scene required');
    if (!input.state) errors.push('state required');
    if (!input.workload) errors.push('workload required');
    if (!input.priority) errors.push('priority required');
    if (!input.retryBudget) errors.push('retryBudget required');
    if (!input.quotas) errors.push('quotas required');
    if (!input.circuits) errors.push('circuits required');
    if (!input.runtimeMetrics) errors.push('runtimeMetrics required');
    if (!input.fairnessState) errors.push('fairnessState required');

    return {
        valid: errors.length === 0,
        errors
    };
}

// ======================================================
// POLICY CONSTRAINTS
// ======================================================

/**
 * Get constraints from circuit breaker.
 */
async function getCircuitConstraints(redis, stage) {
    const status = await circuitBreaker.checkDispatch(redis, stage);

    if (!status.allowed) {
        return {
            type: 'circuit',
            allowed: false,
            reason: status.reason,
            state: status.circuitState,
            priority: 0,
            delayMs: 0,
            throttle: 0
        };
    }

    return {
        type: 'circuit',
        allowed: true,
        reason: status.reason,
        state: status.circuitState,
        priority: 1.0,
        delayMs: 0,
        throttle: 1.0
    };
}

/**
 * Get constraints from retry budget.
 */
async function getRetryConstraints(redis, scene, stage) {
    const check = await retryBudget.checkRetryBudget(
        redis,
        scene.bookId,
        scene.chapterId,
        scene.sceneId,
        stage,
        'transient',
        'policy-engine'
    );

    if (!check.allowed) {
        return {
            type: 'retry_budget',
            allowed: false,
            reason: check.reason,
            sceneBudgets: check.budgets,
            priority: 0,
            delayMs: 0,
            throttle: 0
        };
    }

    return {
        type: 'retry_budget',
        allowed: true,
        reason: 'budget_available',
        sceneBudgets: check.budgets,
        priority: 1.0,
        delayMs: 0,
        throttle: 1.0
    };
}

/**
 * Get constraints from fairness engine.
 */
async function getFairnessConstraints(redis, scene) {
    const fairnessStatus = await fairness.isStarving(redis, scene.bookId, scene.chapterId, scene.sceneId);

    if (fairnessStatus.starving) {
        return {
            type: 'fairness',
            allowed: true,
            reason: 'starvation_detected',
            boosting: true,
            priority: 1.5, // Boost priority for starving scenes
            delayMs: 0,
            throttle: 1.0
        };
    }

    return {
        type: 'fairness',
        allowed: true,
        reason: 'no_fairness_issue',
        boosting: false,
        priority: 1.0,
        delayMs: 0,
        throttle: 1.0
    };
}

/**
 * Get constraints from runtime overload detection.
 */
function getOverloadConstraints(runtimeMetrics, quotas, workload) {
    const activeTotal = Object.values(runtimeMetrics.active).reduce((a, b) => a + b, 0);
    const overloaded = activeTotal >= POLICY_CONFIG.overloadActiveScenesThreshold;

    if (overloaded) {
        // Calculate throttling based on workload
        let throttle = 1.0;
        if (workload === 'EXTREME') {
            throttle = POLICY_CONFIG.extremeWorkloadDispatchThrottle;
        } else if (workload === 'HEAVY') {
            throttle = POLICY_CONFIG.heavyWorkloadDispatchThrottle;
        }

        const quotaAvg = Object.values(quotas).reduce((a, b) => a + b, 0) / 3;
        const quotaUtilization = 1 - (quotaAvg / 10);

        let delayMs = 0;
        if (quotaUtilization > POLICY_CONFIG.overloadQuotaUtilization) {
            delayMs = Math.min(
                POLICY_CONFIG.maxDelayMs,
                Math.floor(POLICY_CONFIG.baseDelayMs * (1 / (1 - quotaUtilization)))
            );
        }

        return {
            type: 'overload',
            allowed: throttle > 0,
            reason: 'overload_active',
            overloaded,
            throttle,
            delayMs,
            activeTotal
        };
    }

    return {
        type: 'overload',
        allowed: true,
        reason: 'healthy_runtime',
        overloaded: false,
        throttle: 1.0,
        delayMs: 0,
        activeTotal
    };
}

/**
 * Get constraints from quota availability.
 */
async function getQuotaConstraints(redis, stage) {
    const quotaStatus = await fairness.checkStageQuota(redis, stage);
    const used = quotaStatus.used;
    const quota = quotaStatus.quota;
    const utilization = used / quota;

    if (utilization >= 1.0) {
        return {
            type: 'quota',
            allowed: false,
            reason: 'quota_exceeded',
            used,
            quota,
            utilization,
            delayMs: POLICY_CONFIG.baseDelayMs
        };
    }

    // Partial quota reduction for high utilization
    let throttle = 1.0;
    if (utilization > 0.8) {
        throttle = 1.0 - (utilization - 0.8) * 2; // Reduce to 0 at 100%
    }

    return {
        type: 'quota',
        allowed: true,
        reason: 'quota_available',
        used,
        quota,
        utilization,
        throttle,
        delayMs: 0
    };
}

/**
 * Get constraints from workload classification.
 */
function getWorkloadConstraints(workload, estimation) {
    if (!estimation || !estimation.cost) {
        return {
            type: 'workload',
            allowed: true,
            reason: 'cost_unknown',
            workload,
            throttle: 1.0,
            delayMs: 0
        };
    }

    let throttle = 1.0;
    let delayMs = 0;

    if (workload === 'EXTREME') {
        throttle = POLICY_CONFIG.extremeWorkloadDispatchThrottle;
        delayMs = POLICY_CONFIG.baseDelayMs * 2;
    } else if (workload === 'HEAVY') {
        throttle = POLICY_CONFIG.heavyWorkloadDispatchThrottle;
        delayMs = POLICY_CONFIG.baseDelayMs;
    }

    return {
        type: 'workload',
        allowed: true,
        reason: 'workload_classified',
        workload,
        cost: estimation.cost,
        throttle,
        delayMs
    };
}

// ======================================================
// PRIORITY NORMALIZATION
// ======================================================

/**
 * Normalize priority within configured range.
 */
function normalizePriority(score, config = {}) {
    const min = config.min ?? POLICY_CONFIG.normalizedPriorityMin;
    const max = config.max ?? POLICY_CONFIG.normalizedPriorityMax;

    // Clamp score to reasonable range first
    let clamped = Math.max(0, Math.min(200, score));

    // Linear normalization
    const normalized = Math.round((clamped / 200) * (max - min) + min);

    return {
        normalized,
        original: score,
        min,
        max,
        clamped
    };
}

/**
 * Getnormalized priority for scene.
 */
async function getNormalizedPriority(redis, scene) {
    const score = await priorityManager.calculatePriorityScore(
        redis,
        scene.bookId,
        scene.chapterId,
        scene.sceneId,
        scene
    );

    return normalizePriority(score);
}

// ======================================================
// COST ESTIMATION
// ======================================================

/**
 * Estimate scene cost using injected cost estimator.
 */
async function estimateSceneCost(redis, scene) {
    if (!costEstimator) {
        return { cost: 10, workload: 'MEDIUM', reason: 'no_estimator' };
    }

    return await costEstimator.estimateSceneCost(redis, scene);
}

// ======================================================
// MAIN POLICY ENGINE
// ======================================================

/**
 * Evaluate all policies and return unified decision.
 */
async function evaluatePolicy(redis, params) {
    const validation = validatePolicyInput(params);
    if (!validation.valid) {
        return {
            allowed: false,
            reason: 'invalid_input',
            errors: validation.errors
        };
    }

    const {
        scene,
        state,
        workload,
        priority,
        retryBudget: retryBudgetParams,
        quotas,
        circuits,
        runtimeMetrics,
        fairnessState
    } = params;

    log(`EVALUATION_START: ${scene.bookId}/${scene.chapterId}/${scene.sceneId}`);

    // Collect all constraints
    const constraints = [];

    // 1. Circuit breaker check
    const circuitConstraint = await getCircuitConstraints(redis, state.stage);
    constraints.push(circuitConstraint);

    if (!circuitConstraint.allowed) {
        warn(`POLICY_BLOCKED: Circuit ${circuitConstraint.reason}`);
        return {
            allowed: false,
            reason: 'circuit_open',
            decisionType: PolicyDecision.BLOCKED,
            constraints
        };
    }

    // 2. Retry budget check
    const retryConstraint = await getRetryConstraints(redis, scene, state.stage);
    constraints.push(retryConstraint);

    if (!retryConstraint.allowed) {
        warn(`POLICY_BLOCKED: Retry budget ${retryConstraint.reason}`);
        return {
            allowed: false,
            reason: retryConstraint.reason,
            decisionType: PolicyDecision.BLOCKED,
            constraints
        };
    }

    // 3. Fairness check
    const fairnessConstraint = await getFairnessConstraints(redis, scene);
    constraints.push(fairnessConstraint);

    // 4. Overload check
    const overloadConstraint = getOverloadConstraints(runtimeMetrics, quotas, workload);
    constraints.push(overloadConstraint);

    // 5. Quota check
    const quotaConstraint = await getQuotaConstraints(redis, state.stage);
    constraints.push(quotaConstraint);

    if (!quotaConstraint.allowed) {
        warn(`POLICY_BLOCKED: Quota ${quotaConstraint.reason}`);
        return {
            allowed: false,
            reason: quotaConstraint.reason,
            decisionType: PolicyDecision.BLOCKED,
            constraints
        };
    }

    // 6. Workload check
    const costEstimation = await estimateSceneCost(redis, scene);
    const workloadConstraint = getWorkloadConstraints(workload, costEstimation);
    constraints.push(workloadConstraint);

    // ======================================================
    // UNIFIED DECISION CALCULATION
    // ======================================================

    // Calculate minimum throttle across all constraints
    const minThrottle = Math.min(...constraints.map(c => c.throttle || 1));
    const totalDelay = Math.max(...constraints.map(c => c.delayMs || 0));

    // Calculate effective priority with boosts
    let effectivePriority = priority;
    constraints.forEach(c => {
        if (c.priority) {
            effectivePriority = Math.max(effectivePriority, c.priority * priority);
        }
    });

    // Normalize effective priority
    const normalized = normalizePriority(effectivePriority);
    effectivePriority = normalized.normalized;

    // Determine final decision type
    let decisionType = PolicyDecision.ALLOWED;
    let reason = 'all_policies_satisfied';

    if (overloadConstraint.overloaded) {
        if (minThrottle === 0) {
            decisionType = PolicyDecision.BLOCKED;
            reason = 'overload_zero_throttle';
        } else if (minThrottle < 1.0) {
            decisionType = PolicyDecision.THROTTLED;
            reason = `overload_throttled_throttle=${minThrottle.toFixed(2)}`;
        } else if (totalDelay > 0) {
            decisionType = PolicyDecision.DELAYED;
            reason = `overload_delayed_delay=${totalDelay}ms`;
        }
    } else if (minThrottle === 0) {
        decisionType = PolicyDecision.BLOCKED;
        reason = 'zero_throttle_from_constraints';
    } else if (minThrottle < 1.0) {
        decisionType = PolicyDecision.THROTTLED;
        reason = `throttled_throttle=${minThrottle.toFixed(2)}`;
    }

    const decision = {
        allowed: decisionType !== PolicyDecision.BLOCKED,
        reason,
        decisionType,
        priority: effectivePriority,
        normalizedPriority: normalized,
        delayMs: totalDelay,
        throttle: minThrottle,
        constraints,
        costEstimation,
        workload,
        retryAllowed: retryConstraint.allowed,
        quotas: quotaConstraint,
        overloads: overloadConstraint.overloaded
    };

    log(`POLICY_EVALUATED: ${decisionType} (priority=${effectivePriority}, throttle=${minThrottle})`);

    // Log specific events
    switch (decisionType) {
        case PolicyDecision.ALLOWED:
            decision.eventType = 'POLICY_ALLOWED';
            break;
        case PolicyDecision.DELAYED:
            decision.eventType = 'POLICY_DELAYED';
            break;
        case PolicyDecision.THROTTLED:
            decision.eventType = 'POLICY_THROTTLED';
            break;
        case PolicyDecision.BLOCKED:
            decision.eventType = 'POLICY_BLOCKED';
            break;
    }

    return decision;
}

/**
 * Helper: Evaluate dispatch-specific policy.
 */
async function evaluateDispatch(redis, scene, stage, runtimeState) {
    const workload = await workloadClassifier.classifyScene(redis, scene);
    const priorityScore = await priorityManager.calculatePriorityScore(
        redis,
        scene.bookId,
        scene.chapterId,
        scene.sceneId,
        scene
    );

    return await evaluatePolicy(redis, {
        scene,
        state: { stage },
        workload,
        priority: priorityScore,
        retryBudget: {},
        quotas: runtimeState.quotas || {},
        circuits: {},
        runtimeMetrics: runtimeState.metrics || {},
        fairnessState: {}
    });
}

/**
 * Helper: Check if dispatch is allowed without full evaluation.
 */
async function isDispatchAllowed(redis, scene, stage, runtimeState) {
    const decision = await evaluateDispatch(redis, scene, stage, runtimeState);
    return decision.allowed;
}

/**
 * Helper: Get the delay if dispatch is delayed.
 */
async function getDispatchDelay(redis, scene, stage, runtimeState) {
    const decision = await evaluateDispatch(redis, scene, stage, runtimeState);
    return decision.allowed ? 0 : decision.delayMs;
}

// ======================================================
// DEBUG: Policy status
// ======================================================

/**
 * Get current policy status.
 */
async function getPolicyStatus(redis, scene) {
    const workload = await workloadClassifier.classifyScene(redis, scene);
    const cost = await estimateSceneCost(redis, scene);
    const priorityScore = await priorityManager.calculatePriorityScore(
        redis,
        scene.bookId,
        scene.chapterId,
        scene.sceneId,
        scene
    );
    const normalized = normalizePriority(priorityScore);

    return {
        scene,
        workload,
        costEstimation: cost,
        priorityScore,
        normalizedPriority: normalized,
        config: POLICY_CONFIG
    };
}

// ======================================================
// POLICY COMPOSITION EVALUATION (Phase 11)
// ======================================================
// Evaluates policies in precedence order and aggregates results.
// Each policy returns a decision with constraints.

/**
 * Get policy module by name.
 */
function getPolicyModule(policyName) {
    const modules = {
        overload: policies.overload,
        circuit: policies.circuit,
        retry: policies.retry,
        workload: policies.workload,
        fairness: policies.fairness,
        priority: policies.priority
    };
    return modules[policyName];
}

/**
 * Get all policies in precedence order.
 */
function getPoliciesInPrecedenceOrder() {
    return POLICY_CONFIG.policyPrecedence;
}

/**
 * Evaluate all policies using composition pattern.
 * Each policy module returns a decision that can:
 * - allow: proceed to next policy
 * - block: return immediate decision
 * - delay: record delay and continue
 * - throttle: record throttle and continue
 */
async function evaluatePolicyComposition(redis, scene, stage, runtimeState) {
    const decisions = [];
    const policiesToEvaluate = getPoliciesInPrecedenceOrder();

    // Prepare context for each policy
    const context = {
        scene,
        stage,
        runtimeState,
        workload: runtimeState?.workload,
        priority: runtimeState?.priority
    };

    // Evaluate policies in precedence order
    for (const policyName of policiesToEvaluate) {
        const module = getPolicyModule(policyName);
        if (!module) {
            continue;
        }

        try {
            // Get policy decision (method name varies by policy type)
            let policyDecision;

            if (policyName === 'overload') {
                policyDecision = await module.evaluate(redis, scene, stage, context.workload || 'MEDIUM');
            } else if (policyName === 'circuit') {
                policyDecision = await module.evaluate(redis, stage);
            } else if (policyName === 'retry') {
                policyDecision = await module.evaluate(redis, scene, stage);
            } else if (policyName === 'workload') {
                const loadedBook = await loadBookForScene(redis, scene.bookId, scene.chapterId);
                policyDecision = await module.evaluate(redis, scene, loadedBook, runtimeState);
            } else if (policyName === 'fairness') {
                policyDecision = await module.evaluate(redis, scene);
            } else if (policyName === 'priority') {
                policyDecision = await module.evaluate(redis, scene);
            } else {
                // Default: try to use generic evaluate method
                if (typeof module.evaluate === 'function') {
                    policyDecision = await module.evaluate(redis, context);
                }
            }

            if (policyDecision) {
                decisions.push({
                    policy: policyName,
                    precedence: policiesToEvaluate.indexOf(policyName) + 1,
                    ...policyDecision
                });

                // Check if policy blocked
                if (!policyDecision.allowed && policyDecision.decisionType !== policies.overload.OverloadDecisionType.CRITICAL) {
                    // Block immediately for hard rejections
                    if (policyDecision.decisionType === 'blocked') {
                        log(`POLICY_BLOCKED: ${policyName} (${policyDecision.reason})`);
                        return {
                            allowed: false,
                            decisionType: PolicyDecision.BLOCKED,
                            reason: policyDecision.reason,
                            policyResults: decisions,
                            blockPolicy: policyName
                        };
                    }
                }
            }
        } catch (err) {
            warn(`POLICY_ERROR: ${policyName}: ${err.message}`);
            decisions.push({
                policy: policyName,
                error: err.message,
                allowed: true // Don't block on policy errors
            });
        }
    }

    // Aggregate final decision
    let minThrottle = 1.0;
    let maxDelay = 0;
    let effectivePriority = context.priority || 50;
    let blockingReason = null;

    decisions.forEach(d => {
        if (d.throttle !== undefined && d.throttle < minThrottle) {
            minThrottle = d.throttle;
        }
        if (d.delayMs !== undefined && d.delayMs > maxDelay) {
            maxDelay = d.delayMs;
        }
        if (d.adjustedPriority !== undefined) {
            effectivePriority = Math.max(effectivePriority, d.adjustedPriority);
        }
        if (!d.allowed && !blockingReason) {
            blockingReason = `${d.policy}:${d.reason}`;
        }
    });

    // Determine final decision type
    let decisionType = PolicyDecision.ALLOWED;
    let reason = 'all_policies_passed';

    if (blockingReason) {
        decisionType = PolicyDecision.BLOCKED;
        reason = blockingReason;
    } else if (minThrottle < 1.0) {
        decisionType = PolicyDecision.THROTTLED;
        reason = `throttled_by_overload`;
    } else if (maxDelay > 0) {
        decisionType = PolicyDecision.DELAYED;
        reason = `delayed_by_retry_storm`;
    }

    log(`POLICY_COMPOSED: ${decisionType} (throttle=${minThrottle.toFixed(2)}, delay=${maxDelay}ms)`);

    return {
        allowed: decisionType !== PolicyDecision.BLOCKED,
        decisionType,
        reason,
        priority: effectivePriority,
        delayMs: maxDelay,
        throttle: minThrottle,
        policyResults: decisions,
        composedAt: Date.now()
    };
}

/**
 * Load book for scene (helper for workload policy).
 */
async function loadBookForScene(redis, bookId, chapterId) {
    // This would load the book from storage
    // For now, return null - actual implementation would fetch from Redis/file
    return null;
}

/**
 * Get composed policy status for debugging.
 */
async function getComposedPolicyStatus(redis, scene, stage) {
    const runtimeState = {
        workload: 'MEDIUM',
        priority: 50
    };

    const result = await evaluatePolicyComposition(redis, scene, stage, runtimeState);

    return {
        scene,
        stage,
        result,
        precedenceOrder: POLICY_CONFIG.policyPrecedence,
        policies: GetPoliciesInPrecedenceOrder().map(p => ({
            name: p,
            module: getPolicyModule(p)?.name || 'unknown'
        }))
    };
}

// ======================================================
// COST ESTIMATOR REGISTRATION
// ======================================================

/**
 * Register cost estimator.
 */
function registerCostEstimator(estimator) {
    if (typeof estimator.estimateSceneCost !== 'function') {
        throw new Error('Cost estimator must have estimateSceneCost() method');
    }
    setCostEstimator(estimator);
    log('COST_ESTIMATOR_REGISTERED');
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Policy decision types
    PolicyDecision,

    // Policy config
    POLICY_CONFIG,

    // Cost estimator
    setCostEstimator,
    registerCostEstimator,
    estimateSceneCost,

    // Priority normalization
    normalizePriority,
    getNormalizedPriority,

    // Main evaluation
    evaluatePolicy,
    evaluateDispatch,
    isDispatchAllowed,
    getDispatchDelay,

    // Helpers
    validatePolicyInput,

    // Debug
    getPolicyStatus,
    getComposedPolicyStatus,

    // Composition
    evaluatePolicyComposition,

    // exported for testing
    getCircuitConstraints,
    getRetryConstraints,
    getFairnessConstraints,
    getOverloadConstraints,
    getQuotaConstraints,
    getWorkloadConstraints,
    getPolicyModule,
    getPoliciesInPrecedenceOrder
};
