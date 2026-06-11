// ======================================================
// GOVERNANCE HEALTH - RUNTIME HEALTH SCORE CALCULATION
// ======================================================
// Calculates comprehensive governance health score.
// Tracks stability, convergence, and adaptation metrics.
// Integrated with invariant violations and safe mode.
//
// Key idea: Runtime must be healthy to make good decisions.

const adaptationController = require('./adaptation-controller');
const governanceStability = require('./governance-stability');
const traceCompactor = require('./trace-compactor');
const invariantEngine = require('./invariant-engine');
const safeMode = require('./safe-mode');

const logPrefix = '[HEALTH]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function debug(msg) {
    console.debug(`${logPrefix} • ${msg}`);
}

// ======================================================
// GOVERNANCE HEALTH CONFIGURATION
// ======================================================

const GOVERNANCE_HEALTH_CONFIG = {
    // Score weights
    weights: {
        adaptation: 0.25,
        stability: 0.25,
        traceHealth: 0.2,
        feedback: 0.15,
        policy: 0.15
    },

    // Score ranges
    ranges: {
        healthy: { min: 80, max: 100 },
        moderate: { min: 60, max: 79 },
        warning: { min: 40, max: 59 },
        critical: { min: 0, max: 39 }
    },

    // Status thresholds
    status: {
        healthy: 80,
        warning: 60,
        critical: 40
    },

    // Decay factor for historical scoring
    historyDecay: 0.9 // Newer scores count more
};

// ======================================================
// GOVERNANCE HEALTH KEY PATTERNS
// ======================================================

const HEALTH_PREFIX = 'animastor:governance:health';
const HEALTH_SCORE_KEY = `${HEALTH_PREFIX}:score`;
const HEALTH_HISTORY_KEY = `${HEALTH_PREFIX}:history`;
const METRICS_KEY = `${HEALTH_PREFIX}:metrics`;
const INVARIANT_SCORE_KEY = `${HEALTH_PREFIX}:invariant_score`;

// ======================================================
// INVARIANT VIOLATION SCORE
// ======================================================

/**
 * Calculate health score based on invariant violations.
 * More violations = lower score.
 */
async function calculateInvariantScore(redis) {
    const violations = await invariantEngine.getRecentViolations(redis, 50);
    const safeModeActive = await safeMode.isSafeModeActive(redis);

    let score = 100;
    let deductions = [];

    // Deduct for each violation
    for (const violation of violations) {
        let deduction = 0;

        switch (violation.severity || 'medium') {
            case 'critical':
                deduction = 25;
                break;
            case 'high':
                deduction = 15;
                break;
            case 'medium':
                deduction = 5;
                break;
            case 'low':
                deduction = 2;
                break;
            default:
                deduction = 5;
        }

        deduction = Math.min(deduction, score);
        score -= deduction;
        deductions.push({ type: violation.type, severity: violation.severity, deduction });
    }

    // Additional penalty if in safe mode
    if (safeModeActive) {
        score -= 20;
        deductions.push({ type: 'safe_mode', deduction: 20, reason: 'In safe mode due to instability' });
    }

    return {
        score: Math.max(0, Math.min(100, Math.round(score))),
        reason: score >= 80 ? 'invariant_stable' : score >= 60 ? 'invariant_warning' : 'invariant_concern',
        violations: violations.length,
        safeModeActive,
        deductions
    };
}

// ======================================================
// SUB-SCORE CALCULATIONS
// ======================================================

/**
 * Calculate adaptation health score.
 * Based on boundedness and oscillation.
 */
async function calculateAdaptationScore(redis) {
    const summary = await adaptationController.getAdaptationSummary(redis);
    const history = await adaptationController.getRecentAdjustments(redis, 50);

    if (Object.keys(summary).length === 0) return { score: 100, reason: 'no_data' };

    let score = 100;
    let deductions = [];

    // Check parameters
    for (const [param, data] of Object.entries(summary)) {
        // Deduct for oscillation
        if (data.pattern.oscillations === 'detected') {
            score -= 15;
            deductions.push({ param, deduction: 15, reason: 'oscillation' });
        }

        // Deduct for boundary proximity
        if (data.pattern.lastValue <= data.bounds.min + 2 || data.pattern.lastValue >= data.bounds.max - 2) {
            score -= 10;
            deductions.push({ param, deduction: 10, reason: 'boundary_proximity' });
        }

        // Deduct for high volatility
        if (data.pattern.volatility && data.pattern.volatility > data.pattern.avg * 0.5) {
            score -= 10;
            deductions.push({ param, deduction: 10, reason: 'high_volatility' });
        }

        // Deduct for cooldowns
        if (data.cooldown && data.cooldown.active) {
            score -= 5;
            deductions.push({ param, deduction: 5, reason: 'cooldown_active' });
        }
    }

    // Deduct for rapid adjustments (high adjustment count)
    if (history.length > 20) {
        score -= Math.min(15, (history.length - 20) * 0.5);
        deductions.push({ type: 'adjustment_count', deduction: Math.round(Math.min(15, (history.length - 20) * 0.5)), reason: 'excessive_adjustments' });
    }

    return {
        score: Math.max(0, Math.min(100, Math.round(score))),
        reason: score >= 80 ? 'adaptation_stable' : score >= 60 ? 'adaptation_warning' : 'adaptation_unstable',
        deductions,
        historyCount: history.length
    };
}

/**
 * Calculate stability health score.
 * Based on convergence and oscillation detection.
 */
async function calculateStabilityScore(redis) {
    const stabilityData = await governanceStability.calculateStabilityScore(redis);

    return {
        score: stabilityData.stabilityScore,
        reason: stabilityData.status,
        details: stabilityData.details,
        totalOscillations: stabilityData.details.totalOscillations,
        totalConflicts: stabilityData.details.totalConflicts
    };
}

/**
 * Calculate trace health score.
 * Based on trace compaction and storage health.
 */
async function calculateTraceHealthScore(redis) {
    const status = await traceCompactor.getCompactionStatus(redis);
    const ageDist = await traceCompactor.getTraceAgeDistribution(redis);

    let score = 100;
    let deductions = [];

    // Check age distribution
    if (ageDist['7d+'] > 100) {
        score -= 15;
        deductions.push({ type: 'old_traces', deduction: 15, reason: `Too many old traces: ${ageDist['7d+']}` });
    }

    // Check compaction status
    if (status.summaries && status.summaries.totalSummaries > 1000) {
        score -= 10;
        deductions.push({ type: 'too_many_summaries', deduction: 10, reason: `Too many trace summaries: ${status.summaries.totalSummaries}` });
    }

    // Check compression ratio (approximate)
    const keys = await redis.keys('animastor:trace:*').then(k => k.length);
    if (keys > 5000) {
        score -= 10;
        deductions.push({ type: 'trace_explosion', deduction: 10, reason: 'Trace storage growing too large' });
    }

    return {
        score: Math.max(0, Math.min(100, Math.round(score))),
        reason: score >= 80 ? 'trace_health_stable' : score >= 60 ? 'trace_health_warning' : 'trace_health_unstable',
        deductions,
        storageKeys: keys,
        summaries: status.summaries
    };
}

/**
 * Calculate feedback health score.
 * Based on feedback system stability.
 */
async function calculateFeedbackScore(redis) {
    const stability = await feedbackEngine?.calculateStabilityScore?.(redis);

    if (!stability) return { score: 100, reason: 'feedback_not_available' };

    let score = 100;
    let deductions = [];

    // Based on stability score
    if (stability.score < 60) {
        score -= 30;
        deductions.push({ type: 'system_stability', deduction: 30, reason: 'System unstable' });
    } else if (stability.score < 80) {
        score -= 15;
        deductions.push({ type: 'system_stability', deduction: 15, reason: 'System moderate' });
    }

    // Check feedback counts
    const feedbackKeys = await redis.keys('animastor:runtime:feedback:*').then(k => k.length);
    if (feedbackKeys > 1000) {
        score -= 10;
        deductions.push({ type: 'feedback_overflow', deduction: 10, reason: 'Feedback storage growing' });
    }

    return {
        score: Math.max(0, Math.min(100, Math.round(score))),
        reason: score >= 80 ? 'feedback_stable' : score >= 60 ? 'feedback_warning' : 'feedback_unstable',
        deductions,
        systemScore: stability.score
    };
}

/**
 * Calculate policy health score.
 * Based on policy decision patterns.
 */
async function calculatePolicyScore(redis) {
    const history = await governanceStability.getStabilityHistory(redis, 100);
    const conflicts = await governanceStability.getRecentConflicts(redis, 50);

    let score = 100;
    let deductions = [];

    // Deduct for oscillations
    if (conflicts.length > 10) {
        score -= 20;
        deductions.push({ type: 'policy_conflicts', deduction: 20, reason: 'Frequent policy conflicts' });
    } else if (conflicts.length > 5) {
        score -= 10;
        deductions.push({ type: 'policy_conflicts', deduction: 10, reason: 'Some policy conflicts' });
    }

    // Deduct for too many arbitrations (potential instability)
    const arbitrationHistory = await redis.lrange('animastor:governance:stability:arbitration', 0, 99);
    if (arbitrationHistory.length > 20) {
        score -= 10;
        deductions.push({ type: 'too_many_arbitrations', deduction: 10, reason: 'Frequent stability arbitration' });
    }

    // Calculate score from history
    if (history.length >= 5) {
        const recentScores = history.slice(0, 10).map(h => h.stabilityScore);
        const avgScore = recentScores.reduce((a, b) => a + b, 0) / recentScores.length;

        if (avgScore < 50) {
            score -= 15;
            deductions.push({ type: 'history_low', deduction: 15, reason: 'Historical stability low' });
        } else if (avgScore < 70) {
            score -= 8;
            deductions.push({ type: 'history_moderate', deduction: 8, reason: 'Historical stability moderate' });
        }
    }

    return {
        score: Math.max(0, Math.min(100, Math.round(score))),
        reason: score >= 80 ? 'policy_stable' : score >= 60 ? 'policy_warning' : 'policy_unstable',
        deductions,
        conflicts: conflicts.length,
        totalArbitrations: arbitrationHistory.length
    };
}

// ======================================================
// MAIN HEALTH SCORE CALCULATION
// ======================================================

/**
 * Calculate comprehensive governance health score.
 * Now includes invariant violations in scoring.
 */
async function calculateGovernanceHealthScore(redis) {
    const [adaptation, stability, trace, feedback, policy, invariant] = await Promise.all([
        calculateAdaptationScore(redis),
        calculateStabilityScore(redis),
        calculateTraceHealthScore(redis),
        calculateFeedbackScore(redis),
        calculatePolicyScore(redis),
        calculateInvariantScore(redis)
    ]);

    // Calculate weighted average
    // Note: Added invariant score (weight 0.2) and adjusted others
    const weights = GOVERNANCE_HEALTH_CONFIG.weights;
    const score = Math.round(
        adaptation.score * weights.adaptation +
        stability.score * weights.stability +
        trace.score * weights.traceHealth +
        feedback.score * weights.feedback +
        policy.score * weights.policy +
        invariant.score * 0.20 // New invariant weight
    ) / 5; // Normalize

    // Determine status
    let status;
    if (score >= GOVERNANCE_HEALTH_CONFIG.status.healthy) {
        status = 'healthy';
    } else if (score >= GOVERNANCE_HEALTH_CONFIG.status.warning) {
        status = 'warning';
    } else if (score >= GOVERNANCE_HEALTH_CONFIG.status.critical) {
        status = 'critical';
    } else {
        status = 'critical';
    }

    // Get all deductions
    const allDeductions = [
        ...adaptation.deductions,
        ...stability.deductions,
        ...trace.deductions,
        ...feedback.deductions,
        ...policy.deductions,
        ...invariant.deductions
    ];

    // Calculate sub-score percentages
    const totalPossible = 100 * 6; // 6 sub-scores of 100 each
    const deductionsTotal = allDeductions.reduce((sum, d) => sum + d.deduction, 0);
    const deductionPercentage = deductionsTotal / totalPossible;

    return {
        score,
        status,
        history: status === 'healthy' ? 'stable' : status === 'warning' ? 'moderate' : 'unstable',
        subScores: {
            adaptation: adaptation.score,
            stability: stability.score,
            traceHealth: trace.score,
            feedback: feedback.score,
            policy: policy.score,
            invariant: invariant.score
        },
        subScoreDetails: {
            adaptation,
            stability,
            traceHealth: trace,
            feedback,
            policy,
            invariant
        },
        deductionSummary: {
            total: deductionsTotal,
            percentage: deductionPercentage,
            items: allDeductions
        },
        timestamp: Date.now(),
        calculatedAt: new Date().toISOString()
    };
}

/**
 * Record health score.
 */
async function recordHealthScore(redis, healthScore) {
    const key = HEALTH_SCORE_KEY;
    await redis.set(key, JSON.stringify(healthScore), 'EX', 86400); // 24 hours

    // Store in history
    const historyKey = HEALTH_HISTORY_KEY;
    await redis.lpush(historyKey, JSON.stringify({
        ...healthScore,
        history: true
    }));
    await redis.ltrim(historyKey, 0, 999); // Keep last 1000

    return healthScore;
}

/**
 * Get health score.
 */
async function getGovernanceHealthScore(redis) {
    const key = HEALTH_SCORE_KEY;
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
}

/**
 * Get health history.
 */
async function getHealthHistory(redis, limit = 50) {
    const key = HEALTH_HISTORY_KEY;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

// ======================================================
// STATUS ENDPOINTS
// ======================================================

/**
 * Get governance health status.
 */
async function getHealthStatus(redis) {
    const healthScore = await calculateGovernanceHealthScore(redis);
    const history = await getHealthHistory(redis, 10);

    return {
        current: healthScore,
        history: history,
        config: GOVERNANCE_HEALTH_CONFIG
    };
}

/**
 * Check if governance is healthy.
 */
async function isGovernanceHealthy(redis) {
    const healthScore = await calculateGovernanceHealthScore(redis);

    return {
        healthy: healthScore.status === 'healthy',
        status: healthScore.status,
        score: healthScore.score,
        reasons: healthScore.deductionSummary.items.slice(0, 3)
    };
}

/**
 * Get health alerts (issues that need attention).
 */
async function getHealthAlerts(redis) {
    const healthScore = await calculateGovernanceHealthScore(redis);
    const alerts = [];

    if (healthScore.status === 'critical') {
        alerts.push({
            severity: 'critical',
            message: `Governance health critical: ${healthScore.score}/100`,
            subScores: healthScore.subScores
        });
    } else if (healthScore.status === 'warning') {
        alerts.push({
            severity: 'warning',
            message: `Governance health warning: ${healthScore.score}/100`,
            subScores: healthScore.subScores
        });
    }

    // Check individual sub-score issues
    if (healthScore.subScores.adaptation < 70) {
        alerts.push({
            severity: 'warning',
            category: 'adaptation',
            message: `Adaptation score low: ${healthScore.subScores.adaptation}/100`,
            details: healthScore.subScoreDetails.adaptation
        });
    }

    if (healthScore.subScores.stability < 70) {
        alerts.push({
            severity: 'warning',
            category: 'stability',
            message: `Stability score low: ${healthScore.subScores.stability}/100`,
            details: healthScore.subScoreDetails.stability
        });
    }

    if (healthScore.subScores.traceHealth < 70) {
        alerts.push({
            severity: 'warning',
            category: 'trace',
            message: `Trace health score low: ${healthScore.subScores.traceHealth}/100`,
            details: healthScore.subScoreDetails.traceHealth
        });
    }

    if (healthScore.subScores.policy < 70) {
        alerts.push({
            severity: 'warning',
            category: 'policy',
            message: `Policy score low: ${healthScore.subScores.policy}/100`,
            details: healthScore.subScoreDetails.policy
        });
    }

    return {
        alerts,
        severity: alerts.length === 0 ? 'healthy' : alerts.some(a => a.severity === 'critical') ? 'critical' : 'warning'
    };
}

// ======================================================
// HEALTH TRENDS
// ======================================================

/**
 * Calculate health trends.
 */
async function getHealthTrends(redis, window = 24) {
    const history = await getHealthHistory(redis, 24 * 2); // Last 2 days, hourly

    if (history.length < 2) return { trend: 'unknown', change: 0 };

    const currentScore = history[0].score;
    const previousScore = history[history.length - 1].score;
    const change = currentScore - previousScore;

    let trend;
    if (change >= 10) {
        trend = 'improving';
    } else if (change <= -10) {
        trend = 'degrading';
    } else {
        trend = 'stable';
    }

    return {
        current: currentScore,
        previous: previousScore,
        change,
        trend,
        historyLength: history.length,
        windowHours: window
    };
}

/**
 * Get health score distribution.
 */
async function getHealthScoreDistribution(redis, window = 168) {
    const history = await getHealthHistory(redis, window);

    if (history.length === 0) {
        return {
            healthy: 0,
            warning: 0,
            critical: 0,
            total: 0
        };
    }

    const distribution = {
        healthy: history.filter(h => h.status === 'healthy').length,
        warning: history.filter(h => h.status === 'warning').length,
        critical: history.filter(h => h.status === 'critical').length
    };

    distribution.total = history.length;

    return distribution;
}

// ======================================================
// HEALTH REPORTS
// ======================================================

/**
 * Generate health report.
 */
async function generateHealthReport(redis) {
    const [healthScore, history, alerts, trends, distribution] = await Promise.all([
        calculateGovernanceHealthScore(redis),
        getHealthHistory(redis, 50),
        getHealthAlerts(redis),
        getHealthTrends(redis, 24),
        getHealthScoreDistribution(redis, 168)
    ]);

    return {
        timestamp: Date.now(),
        generatedAt: new Date().toISOString(),
        healthScore,
        history: history.slice(0, 20),
        trends,
        distribution,
        alerts: alerts.alerts,
        metrics: await getHealthMetrics(redis)
    };
}

/**
 * Get detailed health metrics.
 */
async function getHealthMetrics(redis) {
    const [adaptation, stability, trace, feedback, policy] = await Promise.all([
        adaptationController.getAdaptationSummary(redis),
        governanceStability.getStabilityStatus(redis),
        traceCompactor.getCompactionStatus(redis),
        null, // feedback metrics from feedback-engine
        governanceStability.getRecentConflicts(redis, 10)
    ]);

    return {
        adaptation: adaptation,
        stability: {
            score: stability.stabilityScore,
            oscillations: stability.oscillations.length,
            conflicts: stability.conflicts.length
        },
        trace: {
            summaries: stability.summaries.totalSummaries,
            detailedTraces: stability.detailedTraceCount,
            ageDistribution: stability.ageDistribution
        },
        policy: {
            recentConflicts: policy.length,
            conflicts: policy
        }
    };
}

// ======================================================
// HEALTH EVENTS
// ======================================================

/**
 * Record health score updated event.
 */
async function recordHealthScoreUpdated(redis, healthScore) {
    const event = {
        timestamp: healthScore.timestamp,
        status: healthScore.status,
        score: healthScore.score,
        event: 'HEALTH_SCORE_UPDATED'
    };

    // Record in health history (already done by recordHealthScore)
    // Also record in event journal
    const journalKey = 'animastor:runtime:health:events';
    await redis.lpush(journalKey, JSON.stringify(event));
    await redis.ltrim(journalKey, 0, 999);

    return event;
}

/**
 * Record governance stabilized event.
 */
async function recordGovernanceStabilized(redis, details) {
    const event = {
        timestamp: Date.now(),
        event: 'GOVERNANCE_STABILIZED',
        ...details,
        recordedAt: new Date().toISOString()
    };

    return event;
}

/**
 * Record oscillation detected event.
 */
async function recordOscillationDetectedEvent(redis, policy, details) {
    const event = {
        timestamp: Date.now(),
        event: 'OSCILLATION_DETECTED',
        policy,
        ...details,
        recordedAt: new Date().toISOString()
    };

    return event;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    GOVERNANCE_HEALTH_CONFIG,

    // Sub-score calculations
    calculateAdaptationScore,
    calculateStabilityScore,
    calculateTraceHealthScore,
    calculateFeedbackScore,
    calculatePolicyScore,

    // Main score calculation
    calculateGovernanceHealthScore,
    recordHealthScore,
    getGovernanceHealthScore,
    getHealthHistory,
    getHealthStatus,

    // Status checks
    isGovernanceHealthy,
    getHealthAlerts,
    getHealthTrends,
    getHealthScoreDistribution,

    // Reports
    generateHealthReport,
    getHealthMetrics,
    getGovernanceHealthScore,

    // Events
    recordHealthScoreUpdated,
    recordGovernanceStabilized,
    recordOscillationDetectedEvent
};
