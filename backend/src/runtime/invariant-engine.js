// ======================================================
// Invariant Engine - v1.0.0
// ======================================================
// Formal safety guarantees for runtime operations.
// Critical rules that MUST NEVER be violated.
//
// Key idea: Safety invariants are absolute, above all adaptive policies.
//
// Phase 16: Invariants now use StateGraph as source of truth for
// valid state transitions and lifecycle semantics.

const logPrefix = '[INVARIANT]';
const Stage = require('./state-graph/stage-definitions');
const stateGraph = require('./state-graph/state-graph');
const TransitionRules = require('./state-graph/transition-rules');

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
// INVARIANT CONFIGURATION
// ======================================================

const INVARIANT_CONFIG = {
    // Invariant categories
    categories: {
        LIFECYCLE: 'lifecycle',
        LEASE: 'lease',
        DISPATCH: 'dispatch',
        FAIRNESS: 'fairness',
        RETRY: 'retry',
        GOVERNANCE: 'governance'
    },

    // Violation handling
    violationHandling: {
        soft: ['warn', 'trace', 'journal'],
        hard: ['block', 'reject', 'freeze', 'safe_mode']
    },

    // Severity levels
    severity: {
        LOW: 'low',       // Warning, trace, journal
        MEDIUM: 'medium', // Block specific action
        HIGH: 'high',     // Block dispatch, enter safe mode
        CRITICAL: 'critical' // Block policy, freeze adaptation
    }
};

// ======================================================
// INVARIANT KEY PATTERNS
// ======================================================

const INVARIANT_PREFIX = 'animastor:invariant';
const INVARIANT_VIOLATIONS_KEY = `${INVARIANT_PREFIX}:violations`;
const INVARIANT_HISTORY_KEY = `${INVARIANT_PREFIX}:history`;
const SAFE_MODE_KEY = `${INVARIANT_PREFIX}:safe_mode`;
const INVARIANT_CHECKS_KEY = `${INVARIANT_PREFIX}:checks`;

// ======================================================
// LIFECYCLE INVARIANTS
// ======================================================

/**
 * Check lifecycle invariants for a scene.
 * Examples:
 * - scene cannot skip stages
 * - VIDEO_READY requires video asset
 * - dispatch requires valid state
 */
function checkLifecycleInvariants(scene, currentStage) {
    const violations = [];

    // Cannot skip stages - must progress sequentially
    const expectedStages = ['pending', 'preparing', 'preparing_image', 'image_ready', 'preparing_video', 'video_ready', 'finalizing', 'completed'];
    const stageIndex = expectedStages.indexOf(currentStage);
    const sceneStage = scene.stage || 'pending';

    if (stageIndex > 0) {
        const prevExpectedStage = expectedStages[stageIndex - 1];
        if (sceneStage !== prevExpectedStage && sceneStage !== 'pending') {
            violations.push({
                type: 'lifecycle_skip_stage',
                currentStage,
                sceneStage,
                expectedPrevStage: prevExpectedStage,
                severity: INVARIANT_CONFIG.severity.MEDIUM,
                description: `Scene cannot skip stages: expected ${prevExpectedStage}, got ${sceneStage}`
            });
        }
    }

    // VIDEO_READY requires video asset
    if (currentStage === 'video_ready') {
        if (!scene.video_asset || scene.video_asset === '') {
            violations.push({
                type: 'lifecycle_missing_video_asset',
                stage: currentStage,
                severity: INVARIANT_CONFIG.severity.CRITICAL,
                description: 'VIDEO_READY requires video asset'
            });
        }
    }

    // Cannot dispatch from invalid state
    if (!scene.valid_state) {
        violations.push({
            type: 'lifecycle_invalid_state',
            stage: currentStage,
            state: scene.valid_state,
            severity: INVARIANT_CONFIG.severity.HIGH,
            description: 'Dispatch requires valid state'
        });
    }

    return violations;
}

// ======================================================
// LEASE INVARIANTS
// ======================================================

/**
 * Check lease invariants.
 * Examples:
 * - one active lease per stage
 * - no orphan lease without dispatch
 * - expired lease cannot own dispatch
 */
function checkLeaseInvariants(lease, activeLeases) {
    const violations = [];
    const stage = lease.stage;

    // One active lease per stage
    const stageLeases = Object.values(activeLeases || {}).filter(l =>
        l.stage === stage && l.active
    );

    if (stageLeases.length > 1) {
        violations.push({
            type: 'lease_multiple_active',
            stage,
            count: stageLeases.length,
            leases: stageLeases.map(l => l.id),
            severity: INVARIANT_CONFIG.severity.CRITICAL,
            description: 'Multiple active leases for same stage'
        });
    }

    // No orphan lease without dispatch
    if (lease.hasDispatch === false && lease.active) {
        violations.push({
            type: 'lease_orphan',
            leaseId: lease.id,
            stage,
            severity: INVARIANT_CONFIG.severity.HIGH,
            description: 'Active lease without dispatch'
        });
    }

    // Expired lease cannot own dispatch
    const leaseDuration = lease.ttl || 30 * 60 * 1000; // 30 min default
    const timeRemaining = lease.expiresAt - Date.now();
    if (timeRemaining <= 0 && lease.ownsDispatch) {
        violations.push({
            type: 'lease_expired_owns_dispatch',
            leaseId: lease.id,
            stage,
            timeRemainingMs: timeRemaining,
            severity: INVARIANT_CONFIG.severity.CRITICAL,
            description: 'Expired lease owns dispatch'
        });
    }

    return violations;
}

/**
 * Check lease counters invariant.
 */
function checkLeaseCounters(activeLeasesByType, expectedActiveCount) {
    const violations = [];
    const totalActive = Object.values(activeLeasesByType || {}).reduce((sum, v) => sum + (v.count || 0), 0);

    if (totalActive !== expectedActiveCount) {
        violations.push({
            type: 'lease_counter_mismatch',
            expected: expectedActiveCount,
            actual: totalActive,
            delta: totalActive - expectedActiveCount,
            severity: INVARIANT_CONFIG.severity.MEDIUM,
            description: `Counter mismatch: expected ${expectedActiveCount}, got ${totalActive}`
        });
    }

    return violations;
}

// ======================================================
// DISPATCH INVARIANTS
// ======================================================

/**
 * Check dispatch invariants.
 * Examples:
 * - no duplicate dispatches for same stage
 * - dispatch requires valid lease
 * - dispatch cannot exceed quota
 */
function checkDispatchInvariants(dispatch, state, quota) {
    const violations = [];

    // No duplicate dispatches
    const activeDispatches = (state.activeDispatches || []).filter(d =>
        d.bookId === dispatch.bookId &&
        d.chapterId === dispatch.chapterId &&
        d.sceneId === dispatch.sceneId &&
        d.stage === dispatch.stage
    );

    if (activeDispatches.length > 1) {
        violations.push({
            type: 'dispatch_duplicate',
            bookId: dispatch.bookId,
            chapterId: dispatch.chapterId,
            sceneId: dispatch.sceneId,
            stage: dispatch.stage,
            count: activeDispatches.length,
            severity: INVARIANT_CONFIG.severity.CRITICAL,
            description: 'Duplicate dispatch for same stage'
        });
    }

    // Dispatch requires valid lease
    if (!dispatch.validLease) {
        violations.push({
            type: 'dispatch_no_lease',
            bookId: dispatch.bookId,
            chapterId: dispatch.chapterId,
            sceneId: dispatch.sceneId,
            stage: dispatch.stage,
            severity: INVARIANT_CONFIG.severity.HIGH,
            description: 'Dispatch without valid lease'
        });
    }

    // Dispatch cannot exceed quota
    if (state.activeCount >= quota.maxActive) {
        violations.push({
            type: 'dispatch_quota_exceeded',
            activeCount: state.activeCount,
            quota: quota.maxActive,
            severity: INVARIANT_CONFIG.severity.MEDIUM,
            description: 'Dispatch would exceed quota'
        });
    }

    return violations;
}

// ======================================================
// FAIRNESS INVARIANTS
// ======================================================

/**
 * Check fairness invariants.
 * Examples:
 * - one book cannot monopolize runtime
 * - starvation boost bounded
 */
function checkFairnessInvariants(bookStats, runtimeStats, config = {}) {
    const violations = [];

    const { maxScenesPerBook = 10, maxLeasesPerBook = 5, maxTolerance = 0.4 } = config;

    // One book cannot monopolize runtime
    const totalScenes = runtimeStats.totalScenes || 1;
    const bookScenes = bookStats.sceneCount || 0;
    const bookSceneRatio = bookScenes / totalScenes;

    if (bookSceneRatio > maxTolerance) {
        violations.push({
            type: 'fairness_monopoly',
            bookId: bookStats.bookId,
            scenes: bookScenes,
            totalScenes,
            ratio: bookSceneRatio,
            maxRatio: maxTolerance,
            severity: INVARIANT_CONFIG.severity.MEDIUM,
            description: `Book monopolizes runtime: ${bookSceneRatio.toFixed(2)} > ${maxTolerance}`
        });
    }

    // Lifetime not exceed configurable limit
    if (bookScenes > maxScenesPerBook) {
        violations.push({
            type: 'fairness_too_many_scenes',
            bookId: bookStats.bookId,
            scenes: bookScenes,
            max: maxScenesPerBook,
            severity: INVARIANT_CONFIG.severity.LOW,
            description: `Book has too many scenes: ${bookScenes} > ${maxScenesPerBook}`
        });
    }

    // Starvation boost bounded
    if (bookStats.starvationBoost > 3.0) {
        violations.push({
            type: 'fairness_boost_unbounded',
            bookId: bookStats.bookId,
            boost: bookStats.starvationBoost,
            max: 3.0,
            severity: INVARIANT_CONFIG.severity.MEDIUM,
            description: `Boost exceeds bound: ${bookStats.starvationBoost} > 3.0`
        });
    }

    return violations;
}

// ======================================================
// RETRY INVARIANTS
// ======================================================

/**
 * Check retry invariants.
 * Examples:
 * - retry budget never negative
 * - retries cannot bypass circuits
 * - retries cannot bypass overload protection
 */
function checkRetryInvariants(retryState, policyState, policyConfig) {
    const violations = [];

    // Retry budget never negative
    if (retryState.budget &&
        retryState.budget < 0) {
        violations.push({
            type: 'retry_budget_negative',
            budget: retryState.budget,
            severity: INVARIANT_CONFIG.severity.HIGH,
            description: 'Retry budget is negative'
        });
    }

    // Check against policy config for retry limits
    const maxRetries = policyConfig?.retry?.maxRetries || 10;
    if (retryState.totalAttempts > maxRetries) {
        violations.push({
            type: 'retry_exceeds_max',
            attempts: retryState.totalAttempts,
            max: maxRetries,
            severity: INVARIANT_CONFIG.severity.LOW,
            description: `Retry attempts exceed max: ${retryState.totalAttempts} > ${maxRetries}`
        });
    }

    return violations;
}

// ======================================================
// GOVERNANCE INVARIANTS
// ======================================================

/**
 * Check governance invariants.
 */
function checkGovernanceInvariants(policyState, adaptationConfig, governanceConfig) {
    const violations = [];

    // Adaptive adjustment bounds
    const bounds = adaptationConfig?.ADAPTATION_CONFIG?.bounds;
    if (bounds) {
        for (const [param, boundsConfig] of Object.entries(bounds)) {
            const value = policyState[param];
            if (value !== undefined) {
                if (value < boundsConfig.min) {
                    violations.push({
                        type: 'governance_bound_violation',
                        param,
                        value,
                        min: boundsConfig.min,
                        severity: INVARIANT_CONFIG.severity.MEDIUM,
                        description: `Value below minimum: ${value} < ${boundsConfig.min}`
                    });
                }
                if (value > boundsConfig.max) {
                    violations.push({
                        type: 'governance_bound_violation',
                        param,
                        value,
                        max: boundsConfig.max,
                        severity: INVARIANT_CONFIG.severity.MEDIUM,
                        description: `Value above maximum: ${value} > ${boundsConfig.max}`
                    });
                }
            }
        }
    }

    // No runaway adaptation
    if (adaptationConfig?.lastAdjustments) {
        const recentAdjustments = adaptationConfig.lastAdjustments.slice(-5);
        const totalChange = recentAdjustments.reduce((sum, adj) => sum + Math.abs(adj.change || 0), 0);

        if (totalChange > 100) { // More than 100% total change in last 5 adjustments
            violations.push({
                type: 'governance_runaway_adaptation',
                totalChange,
                adjustmentsCount: recentAdjustments.length,
                severity: INVARIANT_CONFIG.severity.HIGH,
                description: 'Runaway adaptation detected'
            });
        }
    }

    return violations;
}

// ======================================================
// INVARIANT CHECKING ENGINE
// ======================================================

/**
 * Check all invariants for a runtime state.
 */
async function checkRuntimeInvariants(redis, runtimeState) {
    const allViolations = [];

    // Lifecycle invariants
    const lifecycleViolations = checkLifecycleInvariants(
        runtimeState.scene,
        runtimeState.currentStage
    );
    allViolations.push(...lifecycleViolations);

    // Lease invariants
    const leaseViolations = checkLeaseInvariants(
        runtimeState.lease,
        runtimeState.activeLeases
    );
    allViolations.push(...leaseViolations);

    // Lease counter invariants
    const counterViolations = checkLeaseCounters(
        runtimeState.activeLeasesByType,
        runtimeState.activeCount
    );
    allViolations.push(...counterViolations);

    // Dispatch invariants
    const dispatchViolations = checkDispatchInvariants(
        runtimeState.dispatch,
        runtimeState.dispatchState,
        runtimeState.quota
    );
    allViolations.push(...dispatchViolations);

    // Fairness invariants
    const fairnessViolations = checkFairnessInvariants(
        runtimeState.bookStats,
        runtimeState.runtimeStats,
        runtimeState.fairnessConfig
    );
    allViolations.push(...fairnessViolations);

    // Retry invariants
    const retryViolations = checkRetryInvariants(
        runtimeState.retryState,
        runtimeState.policyState,
        runtimeState.policyConfig
    );
    allViolations.push(...retryViolations);

    // Governance invariants
    const governanceViolations = checkGovernanceInvariants(
        runtimeState.policyState,
        runtimeState.adaptationConfig,
        runtimeState.governanceConfig
    );
    allViolations.push(...governanceViolations);

    return allViolations;
}

/**
 * Check specific invariant category.
 */
function checkInvariantCategory(category, ...args) {
    switch (category) {
        case INVARIANT_CONFIG.categories.LIFECYCLE:
            return checkLifecycleInvariants(...args);
        case INVARIANT_CONFIG.categories.LEASE:
            return checkLeaseInvariants(...args);
        case INVARIANT_CONFIG.categories.DISPATCH:
            return checkDispatchInvariants(...args);
        case INVARIANT_CONFIG.categories.FAIRNESS:
            return checkFairnessInvariants(...args);
        case INVARIANT_CONFIG.categories.RETRY:
            return checkRetryInvariants(...args);
        case INVARIANT_CONFIG.categories.GOVERNANCE:
            return checkGovernanceInvariants(...args);
        default:
            return [];
    }
}

/**
 * Get invariant status.
 */
async function getInvariantStatus(redis) {
    const [violations, history, checks] = await Promise.all([
        getRecentViolations(redis, 50),
        getInvariantHistory(redis, 100),
        getInvariantCheckCount(redis)
    ]);

    return {
        timestamp: Date.now(),
        violations,
        history,
        checkCount: checks,
        categories: Object.values(INVARIANT_CONFIG.categories),
        severityLevels: Object.values(INVARIANT_CONFIG.severity)
    };
}

/**
 * Record invariant violation.
 */
async function recordViolation(redis, violation) {
    const key = INVARIANT_VIOLATIONS_KEY;
    const entry = {
        ...violation,
        timestamp: Date.now(),
        timestampFormatted: new Date().toISOString()
    };

    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 999);

    // Add to history
    const historyKey = INVARIANT_HISTORY_KEY;
    await redis.lpush(historyKey, JSON.stringify({
        ...entry,
        history: true
    }));
    await redis.ltrim(historyKey, 0, 999);

    return entry;
}

/**
 * Get recent violations.
 */
async function getRecentViolations(redis, limit = 50) {
    const key = INVARIANT_VIOLATIONS_KEY;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

/**
 * Get invariant history.
 */
async function getInvariantHistory(redis, limit = 50) {
    const key = INVARIANT_HISTORY_KEY;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

/**
 * Get invariant check count.
 */
async function getInvariantCheckCount(redis) {
    const key = INVARIANT_CHECKS_KEY;
    const count = await redis.get(key);
    return parseInt(count || '0', 10);
}

/**
 * Increment invariant check count.
 */
async function incrementInvariantChecks(redis) {
    const key = INVARIANT_CHECKS_KEY;
    await redis.incr(key);
    await redis.expire(key, 86400); // 24 hour TTL
}

// ======================================================
// INVARIANT VALIDATION
// ======================================================

/**
 * Validate invariants and determine if safe to proceed.
 */
function validateInvariants(invariants, violationHandling = INVARIANT_CONFIG.violationHandling) {
    const results = {
        safeToProceed: true,
        violations: [],
        warnings: [],
        hardViolations: [],
        softViolations: []
    };

    for (const invariant of invariants) {
        // Check if hard violation
        const isHardViolation = ['block', 'reject', 'freeze', 'safe_mode'].includes(
            invariant.action || ''
        );

        if (isHardViolation) {
            results.hardViolations.push(invariant);
            results.safeToProceed = false;
        } else if (invariant.severity === INVARIANT_CONFIG.severity.CRITICAL) {
            results.hardViolations.push(invariant);
            results.safeToProceed = false;
        } else if (invariant.severity === INVARIANT_CONFIG.severity.HIGH) {
            results.hardViolations.push(invariant);
            results.safeToProceed = false;
        } else {
            results.warnings.push(invariant);
        }

        results.violations.push(invariant);
    }

    return results;
}

/**
 * Get invariant severity threshold.
 */
function getSeverityThreshold(severity) {
    const thresholds = {
        [INVARIANT_CONFIG.severity.LOW]: 1,
        [INVARIANT_CONFIG.severity.MEDIUM]: 2,
        [INVARIANT_CONFIG.severity.HIGH]: 3,
        [INVARIANT_CONFIG.severity.CRITICAL]: 4
    };

    return thresholds[severity] || 0;
}

/**
 * Get all high-severity violations.
 */
function getHighSeverityViolations(violations) {
    const highSeverity = INVARIANT_CONFIG.severity.HIGH;
    const criticalSeverity = INVARIANT_CONFIG.severity.CRITICAL;

    return violations.filter(v =>
        v.severity === highSeverity ||
        v.severity === criticalSeverity
    );
}

// ======================================================
// INVARIANT CHECK HELPERS
// ======================================================

/**
 * Check if all invariants pass.
 */
function areInvariantsValid(invariants) {
    return !getHighSeverityViolations(invariants).length;
}

/**
 * Get invariant summary.
 */
function getInvariantSummary(violations) {
    const summary = {
        total: violations.length,
        bySeverity: {
            [INVARIANT_CONFIG.severity.LOW]: 0,
            [INVARIANT_CONFIG.severity.MEDIUM]: 0,
            [INVARIANT_CONFIG.severity.HIGH]: 0,
            [INVARIANT_CONFIG.severity.CRITICAL]: 0
        },
        byCategory: {},
        byType: {}
    };

    for (const violation of violations) {
        summary.bySeverity[violation.severity]++;

        if (violation.type) {
            summary.byType[violation.type] = (summary.byType[violation.type] || 0) + 1;
        }
    }

    summary.highSeverityCount =
        summary.bySeverity[INVARIANT_CONFIG.severity.HIGH] +
        summary.bySeverity[INVARIANT_CONFIG.severity.CRITICAL];

    summary.isSafe = summary.highSeverityCount === 0;

    return summary;
}

// ======================================================
// STATE GRAPH INVARIANT CHECKERS (PHASE 16)
// ======================================================

/**
 * Check if state transition is valid per state graph.
 * Phase 16: State graph is the source of truth for transitions.
 */
function checkStateGraphTransition(fromStage, toStage) {
    const violations = [];

    // Check if source stage is valid
    if (!Stage.Stages[fromStage]) {
        violations.push({
            type: 'state_graph_invalid_source',
            from: fromStage,
            severity: INVARIANT_CONFIG.severity.HIGH,
            description: `Invalid source stage: ${fromStage}`
        });
        return violations;
    }

    // Check if target stage is valid
    if (!Stage.Stages[toStage]) {
        violations.push({
            type: 'state_graph_invalid_target',
            to: toStage,
            severity: INVARIANT_CONFIG.severity.HIGH,
            description: `Invalid target stage: ${toStage}`
        });
        return violations;
    }

    // Check if transition is allowed by state graph
    const sourceDef = Stage.Stages[fromStage];
    if (!sourceDef.validTransitions.includes(toStage)) {
        violations.push({
            type: 'state_graph_invalid_transition',
            from: fromStage,
            to: toStage,
            allowedTransitions: sourceDef.validTransitions,
            severity: INVARIANT_CONFIG.severity.HIGH,
            description: `Transition ${fromStage} → ${toStage} not allowed by state graph`
        });
    }

    // Check if source is terminal
    if (sourceDef.isTerminal) {
        violations.push({
            type: 'state_graph_terminal_transition',
            from: fromStage,
            to: toStage,
            severity: INVARIANT_CONFIG.severity.CRITICAL,
            description: `Cannot transition from terminal state: ${fromStage}`
        });
    }

    // Check sequential progression
    const isSequential = Stage.isSequentialProgression(fromStage, toStage);
    if (!isSequential && fromStage !== toStage) {
        violations.push({
            type: 'state_graph_nonsequential',
            from: fromStage,
            to: toStage,
            severity: INVARIANT_CONFIG.severity.LOW,
            description: `Non-sequential transition: ${fromStage} → ${toStage}`
        });
    }

    return violations;
}

/**
 * Check if scene state is valid per state graph.
 */
function checkSceneStateGraph(scene) {
    const violations = [];
    const stage = scene.stage || scene.currentStage || 'pending';

    // Check stage validity
    if (!Stage.Stages[stage]) {
        violations.push({
            type: 'scene_invalid_stage',
            stage,
            severity: INVARIANT_CONFIG.severity.HIGH,
            description: `Invalid scene stage: ${stage}`
        });
        return violations;
    }

    // Check terminal state consistency
    const stageDef = Stage.Stages[stage];
    if (stageDef.isTerminal && scene.isTerminal !== true) {
        violations.push({
            type: 'scene_terminal_inconsistent',
            stage,
            expectedTerminal: true,
            actualTerminal: scene.isTerminal,
            severity: INVARIANT_CONFIG.severity.MEDIUM,
            description: 'Terminal stage with non-terminal flag'
        });
    }

    // Check asset requirements for stage
    const requiredAssets = stageDef.requiresAssets || [];
    for (const asset of requiredAssets) {
        if (!scene[asset] && asset !== 'pending_audio') {
            violations.push({
                type: 'scene_missing_asset',
                stage,
                missingAsset: asset,
                severity: INVARIANT_CONFIG.severity.MEDIUM,
                description: `Missing required asset: ${asset}`
            });
        }
    }

    return violations;
}

/**
 * Check state graph transition validity against contract.
 */
function checkTransitionContract(fromStage, toStage, context = {}) {
    const violations = [];
    const contract = TransitionRules.getTransitionContract(fromStage, toStage);

    if (!contract) {
        violations.push({
            type: 'transition_no_contract',
            from: fromStage,
            to: toStage,
            severity: INVARIANT_CONFIG.severity.HIGH,
            description: 'No transition contract found'
        });
        return violations;
    }

    // Check required invariants in contract
    if (contract.invariants) {
        for (const invariant of contract.invariants) {
            if (context.invariants && context.invariants[invariant.check] === false) {
                violations.push({
                    type: 'transition_invariant_failed',
                    contractType: contract.type,
                    invariantCheck: invariant.check,
                    description: invariant.description,
                    severity: INVARIANT_CONFIG.severity.MEDIUM,
                    description: `Invariant failed: ${invariant.check}`
                });
            }
        }
    }

    return violations;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    INVARIANT_CONFIG,

    // Invariant checks by category
    checkLifecycleInvariants,
    checkLeaseInvariants,
    checkLeaseCounters,
    checkDispatchInvariants,
    checkFairnessInvariants,
    checkRetryInvariants,
    checkGovernanceInvariants,
    checkInvariantCategory,

    // State graph invariant checks (Phase 16)
    checkStateGraphTransition,
    checkSceneStateGraph,
    checkTransitionContract,
    stateGraph,
    TransitionRules,

    // Full invariant check
    checkRuntimeInvariants,

    // Validation
    validateInvariants,
    areInvariantsValid,
    getHighSeverityViolations,
    getInvariantSummary,

    // Status and history
    getInvariantStatus,
    recordViolation,
    getRecentViolations,
    getInvariantHistory,
    getInvariantCheckCount,
    incrementInvariantChecks,

    // Helper functions
    getSeverityThreshold,

    // Constants
    INVARIANT_PREFIX,
    INVARIANT_VIOLATIONS_KEY,
    INVARIANT_HISTORY_KEY,
    SAFE_MODE_KEY,
    INVARIANT_CHECKS_KEY
};
