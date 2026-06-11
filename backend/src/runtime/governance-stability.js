// ======================================================
// GOVERNANCE STABILITY - CONVERGENCE RULES + OSCILLATION DETECTION
// ======================================================
// Prevents policy oscillation and ensures stable long-term governance.
//
// Key idea: Governance must converge, not oscillate.

const adaptationController = require('./adaptation-controller');
const logPrefix = '[STABILITY]';

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
// GOVERNANCE STABILITY CONFIGURATION
// ======================================================

const GOVERNANCE_STABILITY_CONFIG = {
    // Oscillation detection
    oscillationThreshold: 0.3, // 30% change threshold
    oscillationWindow: 5, // Look at last 5 decisions

    // Convergence settings
    convergenceThreshold: 0.1, // 10% change = converged
    convergenceWindow: 10, // 10 consecutive stable decisions

    // Stability arbitration
    stabilityPriority: {
        overload: 1, // Highest priority - system protection
        circuit: 2,  // High priority - service availability
        retry: 3,    // Medium priority - retry control
        workload: 4, // Medium priority - cost routing
        fairness: 5, // Lower priority - fairness
        priority: 6  // Lowest priority - normalization
    },

    // Conflict detection thresholds
    conflictingAdjustmentThreshold: 0.3, // 30% conflicting change
    oscillationRecoveryCooldown: 300000, // 5 minutes before recovery helps

    // History for stability analysis
    historyLimit: 100,
    aggregationWindowMs: 3600000 // 1 hour for aggregations
};

// ======================================================
// STABILITY KEY PATTERNS
// ======================================================

const STABILITY_PREFIX = 'animastor:governance:stability';
const OSCILLATION_KEY = `${STABILITY_PREFIX}:oscillation`;
const CONVERGENCE_KEY = `${STABILITY_PREFIX}:convergence`;
const GOVERNANCE_HISTORY_KEY = `${STABILITY_PREFIX}:history`;
const CONFLICT_KEY = `${STABILITY_PREFIX}:conflict`;
const STABILITY_SCORE_KEY = `${STABILITY_PREFIX}:score`;

// ======================================================
// OSCILLATION DETECTION
// ======================================================

/**
 * Detect oscillation in governance decisions.
 */
async function detectOscillation(redis, policy = null, window = GOVERNANCE_STABILITY_CONFIG.oscillationWindow) {
    const key = policy ? `${OSCILLATION_KEY}:${policy}` : OSCILLATION_KEY;
    const entries = await redis.lrange(key, 0, window - 1);

    if (entries.length < 3) return { oscillation: false, count: entries.length };

    const decisions = entries.map(e => JSON.parse(e));
    const values = decisions.map(d => d.value || 1);

    // Check for rapid sign changes
    let signChanges = 0;
    for (let i = 1; i < values.length; i++) {
        if (values[i] > 1 && values[i - 1] < 1) signChanges++;
        if (values[i] < 1 && values[i - 1] > 1) signChanges++;
    }

    const oscillationRate = signChanges / (values.length - 1);
    const isOscillating = oscillationRate > GOVERNANCE_STABILITY_CONFIG.oscillationThreshold;

    if (isOscillating) {
        warn(`OSCILLATION_DETECTED: ${policy || 'all'} (${oscillationRate.toFixed(2)} rate)`);
    }

    return {
        oscillation: isOscillating,
        signChanges,
        oscillationRate,
        decisions,
        count: entries.length
    };
}

/**
 * Record decision for oscillation tracking.
 */
async function recordDecision(redis, policy, decision) {
    const key = `${OSCILLATION_KEY}:${policy}`;
    const entry = {
        timestamp: Date.now(),
        decision,
        recordedAt: new Date().toISOString()
    };

    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, GOVERNANCE_STABILITY_CONFIG.oscillationWindow - 1);

    // Also add to global history
    const historyKey = GOVERNANCE_HISTORY_KEY;
    await redis.lpush(historyKey, JSON.stringify({
        ...entry,
        policy,
        history: true
    }));
    await redis.ltrim(historyKey, 0, GOVERNANCE_STABILITY_CONFIG.historyLimit - 1);

    return entry;
}

/**
 * Check if oscillation recovery cooldown is active.
 */
async function isOscillationCooldownActive(redis, policy) {
    const key = `${STABILITY_PREFIX}:cooldown:${policy}`;
    const deadline = await redis.get(key);

    if (!deadline) return false;

    const remaining = parseInt(deadline, 10) - Date.now();
    if (remaining <= 0) {
        await redis.del(key);
        return false;
    }

    return {
        active: true,
        remainingMs: remaining,
        remainingMinutes: (remaining / 60000).toFixed(1)
    };
}

/**
 * Set oscillation recovery cooldown.
 */
async function setOscillationCooldown(redis, policy) {
    const key = `${STABILITY_PREFIX}:cooldown:${policy}`;
    await redis.set(key, (Date.now() + GOVERNANCE_STABILITY_CONFIG.oscillationRecoveryCooldown).toString(), 'EX', 400);
    return { cooldownSet: true, policy, durationMs: GOVERNANCE_STABILITY_CONFIG.oscillationRecoveryCooldown };
}

// ======================================================
// CONVERGENCE TRACKING
// ======================================================

/**
 * Check if governance has converged (stable).
 */
async function hasConverged(redis, policy = null, window = GOVERNANCE_STABILITY_CONFIG.convergenceWindow) {
    const key = policy ? `${CONVERGENCE_KEY}:${policy}` : CONVERGENCE_KEY;
    const entries = await redis.lrange(key, 0, window - 1);

    if (entries.length < window) return { converged: false, count: entries.length };

    const values = entries.map(e => {
        const parsed = JSON.parse(e);
        return parsed.value || 1;
    });

    // Calculate variance
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / values.length;
    const cv = Math.sqrt(variance) / Math.max(1, avg);

    const hasConverged = cv < GOVERNANCE_STABILITY_CONFIG.convergenceThreshold;

    return {
        converged: hasConverged,
        cv,
        avg,
        values,
        count: entries.length,
        window
    };
}

/**
 * Record convergence value.
 */
async function recordConvergenceValue(redis, policy, value) {
    const key = `${CONVERGENCE_KEY}:${policy}`;
    const entry = {
        timestamp: Date.now(),
        value,
        recordedAt: new Date().toISOString()
    };

    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, GOVERNANCE_STABILITY_CONFIG.convergenceWindow - 1);

    return entry;
}

// ======================================================
// POLICY CONFLICT DETECTION
// ======================================================

/**
 * Check if policies are conflicting.
 */
async function checkPolicyConflict(redis, currentPolicy, currentDecision, recentPolicies) {
    if (recentPolicies.length < 2) return { conflict: false, reason: 'insufficient_history' };

    // Find recent conflicting decisions
    for (const prev of recentPolicies) {
        if (prev.policy === currentPolicy) continue;

        // Check if policies are in conflict (opposite directions)
        const currentDir = currentDecision.direction || 1;
        const prevDir = prev.decision.direction || 1;

        if (currentDir !== prevDir && Math.abs(currentDir - prevDir) > GOVERNANCE_STABILITY_CONFIG.conflictingAdjustmentThreshold) {
            return {
                conflict: true,
                policies: [currentPolicy, prev.policy],
                currentDirection: currentDir,
                previousDirection: prevDir,
                timestamp: prev.timestamp
            };
        }
    }

    return { conflict: false, reason: 'no_conflict' };
}

/**
 * Record policy conflict.
 */
async function recordPolicyConflict(redis, policies, currentDecision, prevDecision) {
    const key = CONFLICT_KEY;
    const entry = {
        timestamp: Date.now(),
        policies,
        currentDecision,
        prevDecision,
        conflictType: 'direction_opposite',
        resolved: false,
        recordedAt: new Date().toISOString()
    };

    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 999); // Keep last 1000

    return entry;
}

/**
 * Resolve policy conflict.
 */
async function resolvePolicyConflict(redis, policies, resolution) {
    const key = CONFLICT_KEY;
    const entries = await redis.lrange(key, 0, -1);

    let resolved = 0;
    for (const raw of entries) {
        const entry = JSON.parse(raw);
        if (entry.policies.sort().join(',') === policies.sort().join(',') && !entry.resolved) {
            await redis.lset(key, 0, JSON.stringify({ ...entry, resolved: true, resolution }));
            resolved++;
            break;
        }
    }

    return { resolved, resolution };
}

// ======================================================
// GOVERNANCE STABILITY ARBITRATION
// ======================================================

/**
 * Resolve governance conflicts using stability arbitration.
 */
function resolveGovernanceConflict(policies, decisions, config = GOVERNANCE_STABILITY_CONFIG) {
    // Sort policies by priority (lower = higher priority)
    const sortedPolicies = policies
        .map(p => ({
            policy: p,
            priority: config.stabilityPriority[p] || 10,
            decision: decisions[p]
        }))
        .sort((a, b) => a.priority - b.priority);

    // Apply winner-takes-all for conflicting policies
    const winner = sortedPolicies[0];
    const runnerUp = sortedPolicies[1];

    return {
        winner: winner.policy,
        winnerDecision: winner.decision,
        priority: winner.priority,
        runnerUp: runnerUp.policy,
        runnerUpDecision: runnerUp.decision,
        reason: 'stability_arbitration',
        priorityOrder: sortedPolicies.map(p => p.policy)
    };
}

/**
 * Apply stability arbitration to decision set.
 */
async function applyStabilityArbitration(redis, decisions) {
    const policies = Object.keys(decisions);

    if (policies.length <= 1) return { decision: decisions, arbitrator: 'none_needed' };

    const { winner, winnerDecision, priorityOrder } = resolveGovernanceConflict(policies, decisions);

    // Record arbitration decision
    await recordDecision(redis, 'arbitration', {
        winner,
        priorityOrder,
        timestamp: Date.now()
    });

    return {
        decision: winnerDecision,
        arbitrator: 'stability_arbitration',
        winnerPolicy: winner,
        priorityOrder,
        resolvedConflicts: true
    };
}

// ======================================================
// STABILITY SCORE CALCULATION
// ======================================================

/**
 * Calculate governance stability score.
 * Score: 0-100, higher = more stable.
 */
async function calculateStabilityScore(redis) {
    const policies = Object.keys(adaptationController.ADAPTATION_CONFIG.bounds);

    const scores = {
        oscillation: {},
        convergence: {},
        conflicts: {}
    };

    let totalConflicts = 0;
    let totalOscillations = 0;

    for (const policy of policies) {
        // Check oscillation
        const oscillation = await detectOscillation(redis, policy);
        scores.oscillation[policy] = oscillation.oscillation ? 0 : 100;

        // Check convergence
        const convergence = await hasConverged(redis, policy);
        scores.convergence[policy] = convergence.converged ? 100 : Math.max(0, 100 - convergence.cv * 1000);

        // Check conflicts
        const conflicts = await redis.llen(`${CONFLICT_KEY}:${policy}`);
        scores.conflicts[policy] = Math.max(0, 100 - conflicts * 20);

        totalConflicts += conflicts;
        if (oscillation.oscillation) totalOscillations++;
    }

    // Calculate weighted average
    const weights = {
        oscillation: 0.4,
        convergence: 0.4,
        conflicts: 0.2
    };

    const oscAvg = Object.values(scores.oscillation).reduce((a, b) => a + b, 0) / Object.keys(scores.oscillation).length || 0;
    const convAvg = Object.values(scores.convergence).reduce((a, b) => a + b, 0) / Object.keys(scores.convergence).length || 0;
    const confAvg = Object.values(scores.conflicts).reduce((a, b) => a + b, 0) / Object.keys(scores.conflicts).length || 0;

    const stabilityScore = Math.round(
        oscAvg * weights.oscillation +
        convAvg * weights.convergence +
        confAvg * weights.conflicts
    );

    const status = stabilityScore >= 80 ? 'stable' : stabilityScore >= 60 ? 'moderate' : 'unstable';

    return {
        stabilityScore,
        status,
        details: {
            oscillation: scores.oscillation,
            convergence: scores.convergence,
            conflicts: scores.conflicts,
            totalOscillations,
            totalConflicts,
            policies,
            weights
        }
    };
}

/**
 * Record stability score.
 */
async function recordStabilityScore(redis, score) {
    const key = STABILITY_SCORE_KEY;
    const entry = {
        timestamp: Date.now(),
        stabilityScore: score.stabilityScore,
        status: score.status,
        recordedAt: new Date().toISOString()
    };

    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, GOVERNANCE_STABILITY_CONFIG.historyLimit - 1);

    return entry;
}

// ======================================================
// STABILITY HISTORY
// ======================================================

/**
 * Get governance stability history.
 */
async function getStabilityHistory(redis, limit = 50) {
    const key = STABILITY_SCORE_KEY;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

/**
 * Get recent oscillations.
 */
async function getRecentOscillations(redis, limit = 20) {
    const historyKey = GOVERNANCE_HISTORY_KEY;
    const entries = await redis.lrange(historyKey, 0, limit - 1);

    return entries
        .map(e => JSON.parse(e))
        .filter(e => e.decision && e.decision.type === 'oscillation')
        .slice(0, limit);
}

/**
 * Get recent conflicts.
 */
async function getRecentConflicts(redis, limit = 20) {
    const entries = await redis.lrange(CONFLICT_KEY, 0, limit - 1);

    return entries
        .map(e => JSON.parse(e))
        .filter(e => !e.resolved)
        .slice(0, limit);
}

// ======================================================
// STABILITY EVENTS (for journal)
// ======================================================

/**
 * Record oscillation detected event.
 */
async function recordOscillationDetected(redis, policy, details) {
    const entry = await recordDecision(redis, policy, {
        type: 'oscillation',
        detected: true,
        details,
        timestamp: Date.now()
    });

    await setOscillationCooldown(redis, policy);

    log(`OSCILLATION_DETECTED: ${policy} - setting cooldown`);

    return entry;
}

/**
 * Record convergence achieved event.
 */
async function recordConvergenceAchieved(redis, policy, details) {
    const entry = await recordDecision(redis, policy, {
        type: 'convergence',
        achieved: true,
        details,
        timestamp: Date.now()
    });

    return entry;
}

/**
 * Record stability arbitration event.
 */
async function recordStabilityArbitration(redis, winnerPolicy, policies, decisions) {
    const key = `${STABILITY_PREFIX}:arbitration`;
    const entry = {
        timestamp: Date.now(),
        winnerPolicy,
        policies,
        decisions,
        resolution: 'stability_arbitration',
        recordedAt: new Date().toISOString()
    };

    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 99);

    log(`STABILITY_ARBITRATION: ${winnerPolicy} won compared to ${policies.filter(p => p !== winnerPolicy).join(', ')}`);

    return entry;
}

/**
 * Record conflict resolved event.
 */
async function recordConflictResolved(redis, policies, resolution) {
    const key = `${STABILITY_PREFIX}:conflict_resolved`;
    const entry = {
        timestamp: Date.now(),
        policies,
        resolution,
        recordedAt: new Date().toISOString()
    };

    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 99);

    return entry;
}

// ======================================================
// STABILITY RECOVERY
// ======================================================

/**
 * Attempt to recover from unstable state.
 */
async function attemptStabilityRecovery(redis, policy) {
    // Check if oscillation cooldown is active
    const cooldown = await isOscillationCooldownActive(redis, policy);
    if (cooldown && cooldown.active) {
        debug(`STABILITY_RECOVERY_BLOCKED: ${policy}: cooldown active (${cooldown.remainingMinutes}m remaining)`);
        return { recoveryAttempted: false, reason: 'cooldown_active', cooldown };
    }

    // Try to reset or dampen
    const history = await getAdjustmentHistory(redis, policy, 10);
    if (history.length < 3) {
        return { recoveryAttempted: false, reason: 'insufficient_history' };
    }

    // Calculate dampened value
    const values = history.map(h => h.finalValue);
    const avg = adaptationController.calculateMovingAverage(values);
    const stdDev = adaptationController.calculateMovingStdDev(values);

    // Suggest dampened recovery value
    const dampenedValue = avg + stdDev * 0.5; // Half standard deviation back

    const bounded = adaptationController.createBoundedAdjustment({
        parameter: policy,
        currentValue: values[values.length - 1],
        targetValue: dampenedValue
    });

    if (!bounded) {
        return { recoveryAttempted: false, reason: 'invalid_parameter' };
    }

    log(`STABILITY_RECOVERY_SUGGESTED: ${policy}: ${bounded.currentValue} → ${bounded.finalValue}`);

    return {
        recoveryAttempted: true,
        suggestedValue: bounded.finalValue,
        dampened: true,
        original: bounded.currentValue,
        target: bounded.targetValue,
        bounds: bounded.bounds
    };
}

/**
 * Apply stability recovery.
 */
async function applyStabilityRecovery(redis, policy) {
    const recovery = await attemptStabilityRecovery(redis, policy);

    if (!recovery.recoveryAttempted) {
        return { applied: false, reason: recovery.reason };
    }

    // Apply bounded adjustment
    const adjustment = await adaptationController.applyAdjustment(
        redis,
        policy,
        recovery.suggestedValue,
        'stability_recovery'
    );

    if (adjustment.applied) {
        await recordConflictResolved(redis, [policy], {
            recoveryApplied: true,
            suggestedValue: recovery.suggestedValue,
            adjustment
        });
    }

    return adjustment;
}

// ======================================================
// STABILITY STATUS
// ======================================================

/**
 * Get governance stability status for debugging.
 */
async function getStabilityStatus(redis) {
    const stabilityScore = await calculateStabilityScore(redis);
    const histories = {};
    const conflicts = await getRecentConflicts(redis, 10);
    const oscillations = await getRecentOscillations(redis, 10);

    const policies = Object.keys(adaptationController.ADAPTATION_CONFIG.bounds);
    for (const policy of policies) {
        histories[policy] = {
            oscillation: await detectOscillation(redis, policy),
            convergence: await hasConverged(redis, policy)
        };
    }

    return {
        timestamp: Date.now(),
        stabilityScore,
        histories,
        conflicts,
        oscillations,
        cooldowns: await getOscillationCooldowns(redis),
        config: GOVERNANCE_STABILITY_CONFIG
    };
}

/**
 * Get oscillation cooldowns for all policies.
 */
async function getOscillationCooldowns(redis) {
    const policies = Object.keys(adaptationController.ADAPTATION_CONFIG.bounds);
    const cooldowns = {};

    for (const policy of policies) {
        cooldowns[policy] = await isOscillationCooldownActive(redis, policy);
    }

    return cooldowns;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    GOVERNANCE_STABILITY_CONFIG,

    // Oscillation detection
    detectOscillation,
    recordDecision,
    isOscillationCooldownActive,
    setOscillationCooldown,
    recordOscillationDetected,
    getRecentOscillations,

    // Convergence tracking
    hasConverged,
    recordConvergenceValue,
    recordConvergenceAchieved,

    // Conflict detection
    checkPolicyConflict,
    recordPolicyConflict,
    resolvePolicyConflict,
    resolveGovernanceConflict,
    applyStabilityArbitration,

    // Stability arbitration
    resolveGovernanceConflict,
    recordStabilityArbitration,

    // Stability scoring
    calculateStabilityScore,
    recordStabilityScore,
    getStabilityHistory,

    // Recovery
    attemptStabilityRecovery,
    applyStabilityRecovery,

    // Status
    getStabilityStatus,
    getOscillationCooldowns,
    getRecentConflicts
};
