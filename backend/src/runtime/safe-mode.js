// ======================================================
// Safe Mode - v1.0.0
// ======================================================
// Decenter runtime into safe conservative mode when unstable.
// Ensures runtime correctness even under high stress.
//
// Key idea: Degrade gracefully rather than fail.

const logPrefix = '[SAFE-MODE]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function debug(msg) {
    console.debug(`${logPrefix} • ${msg}`);
}

// ======================================================
// SAFE MODE CONFIGURATION
// ======================================================

const SAFE_MODE_CONFIG = {
    // Trigger conditions
    triggers: {
        highInvariantViolations: 5,      // >5 invariant violations
        lowGovernanceScore: 50,          // Governance score < 50
        highOverloadScore: 95,           // Overload score > 95
        highAdaptationRate: 100,         // >100% total adaptation in last 10
        policyValidationFailures: 2      // 2+ policy validations failed
    },

    // Safe mode settings
    settings: {
        // Quotas - much more conservative
        maxConcurrentAudio: 1,           // Min 1
        maxConcurrentImage: 1,           // Min 1
        maxConcurrentVideo: 1,           // Min 1

        // Admission - stricter
        admissionThreshold: 0.3,         // 30% acceptance
        maxAdmissionDelayMs: 60000,      // 1 min max

        // Retry - minimal
        maxRetryAttempts: 1,             // Only 1 retry
        retryDelayMs: 5000,              // 5 seconds

        // Load - very conservative
        overloadThreshold: 0.8,          // Trigger at 80%
        overloadQuotaUtilization: 0.7,   //enforce at 70%

        // Circuit - aggressive
        circuitFailureThreshold: 3,      // Open after 3 failures
        circuitResetTimeoutMs: 10000,    // 10 second reset

        // Starvation - minimal boost
        starvationThresholdMinutes: 30,  // 30 min before boost
        starvationBoostFactor: 1.5,      // 1.5x boost
        maxStarvationBoost: 2.0,         // Max 2x

        // Adaptation disabled in safe mode
        enableAdaptation: false,
        maxAdaptationStep: 0.05,         // Only 5% changes
        cooldownMultiplier: 2            // Double cooldowns
    },

    // Exit conditions
    exitConditions: {
        lowInvariantViolations: 1,       // <1 violation
        highGovernanceScore: 80,         // Governance score > 80
        lowOverloadScore: 60,            // Overload score < 60
        stableOperation: true            // Stable operation for 5 minutes
    }
};

// ======================================================
// SAFE MODE KEY PATTERNS
// ======================================================

const SAFE_MODE_PREFIX = 'animastor:safe_mode';
const SAFE_MODE_STATE_KEY = `${SAFE_MODE_PREFIX}:state`;
const SAFE_MODE_HISTORY_KEY = `${SAFE_MODE_PREFIX}:history`;
const SAFE_MODE_TRIGGER_KEY = `${SAFE_MODE_PREFIX}:trigger`;
const SAFE_MODE_DELAY_KEY = `${SAFE_MODE_PREFIX}:delay`;

// ======================================================
// SAFE MODE STATE
// ======================================================

/**
 * Create safe mode state.
 */
function createSafeModeState(reason = {}) {
    return {
        active: true,
        reason,
        enteredAt: Date.now(),
        enteredAtFormatted: new Date().toISOString(),
        settings: { ...SAFE_MODE_CONFIG.settings },
        activeAt: Date.now(),
        lastEvacuationAttempt: null
    };
}

/**
 * Check if safe mode is active.
 */
async function isSafeModeActive(redis) {
    const key = SAFE_MODE_STATE_KEY;
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw).active : false;
}

/**
 * Enter safe mode.
 */
async function enterSafeMode(redis, reason = {}) {
    const state = createSafeModeState(reason);

    // Save state
    const key = SAFE_MODE_STATE_KEY;
    await redis.set(key, JSON.stringify(state), 'EX', 3600); // 1 hour max

    // Record to history
    const historyKey = SAFE_MODE_HISTORY_KEY;
    await redis.lpush(historyKey, JSON.stringify({
        ...state,
        action: 'ENTERED',
        timestamp: Date.now(),
        timestampFormatted: new Date().toISOString()
    }));
    await redis.ltrim(historyKey, 0, 999);

    log(`SAFE_MODE_ENTERED: reason=${reason.type || 'unknown'}`);

    return {
        entered: true,
        state,
        configuredSettings: state.settings
    };
}

/**
 * Exit safe mode.
 */
async function exitSafeMode(redis) {
    const key = SAFE_MODE_STATE_KEY;
    const raw = await redis.get(key);

    if (!raw) {
        return {
            exited: false,
            reason: 'safe_mode_not_active'
        };
    }

    const state = JSON.parse(raw);
    const newState = {
        ...state,
        active: false,
        exitedAt: Date.now(),
        exitedAtFormatted: new Date().toISOString(),
        action: 'EXITED'
    };

    // Update state
    await redis.set(key, JSON.stringify(newState), 'EX', 3600);

    // Record to history
    const historyKey = SAFE_MODE_HISTORY_KEY;
    await redis.lpush(historyKey, JSON.stringify(newState));
    await redis.ltrim(historyKey, 0, 999);

    log('SAFE_MODE_EXITED: restored normal operation');

    return {
        exited: true,
        state: newState
    };
}

/**
 * Check if safe mode should be triggered.
 */
async function shouldEnterSafeMode(redis, runtimeState, governanceScore, invariantViolations) {
    const triggers = SAFE_MODE_CONFIG.triggers;

    // Check invariant violations
    if (invariantViolations && invariantViolations.length >= triggers.highInvariantViolations) {
        return {
            shouldEnter: true,
            reason: {
                type: 'high_invariant_violations',
                count: invariantViolations.length,
                threshold: triggers.highInvariantViolations
            }
        };
    }

    // Check governance score
    if (governanceScore !== undefined && governanceScore < triggers.lowGovernanceScore) {
        return {
            shouldEnter: true,
            reason: {
                type: 'low_governance_score',
                score: governanceScore,
                threshold: triggers.lowGovernanceScore
            }
        };
    }

    // Check overload score
    const overloadScore = runtimeState.overloadScore || 0;
    if (overloadScore > triggers.highOverloadScore) {
        return {
            shouldEnter: true,
            reason: {
                type: 'high_overload',
                score: overloadScore,
                threshold: triggers.highOverloadScore
            }
        };
    }

    // Check adaptation rate
    if (runtimeState.adaptationConfig) {
        const totalChange = runtimeState.adaptationConfig.lastAdjustments
            .slice(-10)
            .reduce((sum, adj) => sum + Math.abs(adj.change || 0), 0);

        if (totalChange > triggers.highAdaptationRate) {
            return {
                shouldEnter: true,
                reason: {
                    type: 'high_adaptation_rate',
                    totalChange,
                    threshold: triggers.highAdaptationRate
                }
            };
        }
    }

    return { shouldEnter: false, reason: null };
}

// ======================================================
// SAFE MODE SETTINGS
// ======================================================

/**
 * Get current safe mode settings.
 */
async function getSafeModeSettings(redis) {
    const key = SAFE_MODE_STATE_KEY;
    const raw = await redis.get(key);

    if (!raw) {
        return {
            active: false,
            settings: SAFE_MODE_CONFIG.settings,
            isSafeMode: false
        };
    }

    const state = JSON.parse(raw);
    return {
        active: state.active,
        settings: state.settings,
        isSafeMode: state.active,
        state
    };
}

/**
 * Get safe mode quota settings.
 */
function getSafeModeQuotas() {
    return {
        audio: SAFE_MODE_CONFIG.settings.maxConcurrentAudio,
        image: SAFE_MODE_CONFIG.settings.maxConcurrentImage,
        video: SAFE_MODE_CONFIG.settings.maxConcurrentVideo
    };
}

/**
 * Get safe mode admission settings.
 */
function getSafeModeAdmissionSettings() {
    return {
        threshold: SAFE_MODE_CONFIG.settings.admissionThreshold,
        maxDelayMs: SAFE_MODE_CONFIG.settings.maxAdmissionDelayMs
    };
}

/**
 * Get safe mode retry settings.
 */
function getSafeModeRetrySettings() {
    return {
        maxAttempts: SAFE_MODE_CONFIG.settings.maxRetryAttempts,
        delayMs: SAFE_MODE_CONFIG.settings.retryDelayMs
    };
}

// ======================================================
// SAFE MODE ENFORCEMENT
// ======================================================

/**
 * Apply safe mode rules to policy state.
 */
function applySafeModeRules(policyState, safeModeState) {
    if (!safeModeState.active) {
        return policyState;
    }

    const safeSettings = safeModeState.settings || SAFE_MODE_CONFIG.settings;

    return {
        ...policyState,
        // Quotas - conservative
        maxConcurrentAudio: safeSettings.maxConcurrentAudio,
        maxConcurrentImage: safeSettings.maxConcurrentImage,
        maxConcurrentVideo: safeSettings.maxConcurrentVideo,

        // Admission - stricter
        admissionThreshold: safeSettings.admissionThreshold,
        maxAdmissionDelayMs: safeSettings.maxAdmissionDelayMs,

        // Retry - minimal
        maxRetryAttempts: safeSettings.maxRetryAttempts,
        retryDelayMs: safeSettings.retryDelayMs,

        // Overload - more sensitive
        overloadThreshold: safeSettings.overloadThreshold,
        overloadQuotaUtilization: safeSettings.overloadQuotaUtilization,

        // Circuit - aggressive
        circuitFailureThreshold: safeSettings.circuitFailureThreshold,
        circuitResetTimeoutMs: safeSettings.circuitResetTimeoutMs,

        // Starvation - minimal
        starvationThresholdMinutes: safeSettings.starvationThresholdMinutes,
        starvationBoostFactor: safeSettings.starvationBoostFactor,
        maxStarvationBoost: safeSettings.maxStarvationBoost,

        // Adaptation disabled
        enableAdaptation: safeSettings.enableAdaptation,
        maxAdaptationStep: safeSettings.maxAdaptationStep,
        cooldownMultiplier: safeSettings.cooldownMultiplier
    };
}

/**
 * Check if dispatch should be allowed in safe mode.
 */
function checkDispatchAllowedInSafeMode(workload, dispatchState, safeModeState) {
    if (!safeModeState.active) {
        return { allowed: true, reason: 'normal_mode' };
    }

    const safeSettings = safeModeState.settings || SAFE_MODE_CONFIG.settings;

    // In safe mode, very strict admission
    if (dispatchState.currentActive >= safeSettings.maxConcurrentAudio) {
        return {
            allowed: false,
            reason: 'safe_mode_quota_limit',
            quota: safeSettings.maxConcurrentAudio
        };
    }

    return { allowed: true, reason: 'within_safe_mode_limits' };
}

/**
 * Get safe mode enforcement status.
 */
async function getSafeModeEnforcementStatus(redis) {
    const safeMode = await getSafeModeSettings(redis);
    const quotas = getSafeModeQuotas();

    return {
        active: safeMode.active,
        quotas,
        admission: getSafeModeAdmissionSettings(),
        retry: getSafeModeRetrySettings(),
        settings: safeMode.settings,
        activeSince: safeMode.active ? safeMode.state.enteredAt : null
    };
}

// ======================================================
// SAFE MODE HISTORY
// ======================================================

/**
 * Get safe mode history.
 */
async function getSafeModeHistory(redis, limit = 50) {
    const key = SAFE_MODE_HISTORY_KEY;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

/**
 * Get recent safe mode transitions.
 */
async function getSafeModeTransitions(redis, limit = 20) {
    const history = await getSafeModeHistory(redis, limit);
    return history.filter(e => e.action && (e.action === 'ENTERED' || e.action === 'EXITED'));
}

/**
 * Get safe mode statistics.
 */
async function getSafeModeStats(redis) {
    const history = await getSafeModeHistory(redis, 200);
    const transitions = getSafeModeTransitions(redis, 100);

    const stats = {
        totalTransitions: transitions.length,
        entries: transitions.filter(t => t.action === 'ENTERED').length,
        exits: transitions.filter(t => t.action === 'EXITED').length,
        activeSinceEntry: null,
        activeReasons: {}
    };

    // Count reasons
    for (const entry of history) {
        if (entry.action === 'ENTERED' && entry.reason && entry.reason.type) {
            stats.activeReasons[entry.reason.type] = (stats.activeReasons[entry.reason.type] || 0) + 1;
        }
    }

    // Find current active entry
    const current = history.find(e => e.active);
    if (current) {
        stats.activeSinceEntry = current.enteredAt;
    }

    return stats;
}

// ======================================================
// SAFE MODE CHECK HELPERS
// ======================================================

/**
 * Get current safe mode status for debugging.
 */
async function getSafeModeStatus(redis) {
    const [safemode, history, stats, transitions] = await Promise.all([
        getSafeModeSettings(redis),
        getSafeModeHistory(redis, 20),
        getSafeModeStats(redis),
        getSafeModeTransitions(redis, 20)
    ]);

    return {
        timestamp: Date.now(),
        safemode,
        history,
        stats,
        transitions,
        triggers: SAFE_MODE_CONFIG.triggers,
        exitConditions: SAFE_MODE_CONFIG.exitConditions,
        config: SAFE_MODE_CONFIG
    };
}

/**
 * Check multiple conditions for safe mode.
 */
async function checkSafeModeConditions(redis, conditions) {
    const results = {
        safeModeActive: false,
        triggerMatches: [],
        shouldTrigger: false
    };

    // Check if already in safe mode
    results.safeModeActive = await isSafeModeActive(redis);

    if (results.safeModeActive) {
        return results;
    }

    // Check each condition
    for (const condition of conditions) {
        const matches = await checkCondition(redis, condition);

        if (matches) {
            results.triggerMatches.push(condition);
        }
    }

    results.shouldTrigger = results.triggerMatches.length > 0;

    return results;
}

/**
 * Check single condition.
 */
async function checkCondition(redis, condition) {
    const { type, runtimeState, governanceScore, invariantViolations } = condition;

    switch (type) {
        case 'high_invariant_violations':
            return invariantViolations && invariantViolations.length >= SAFE_MODE_CONFIG.triggers.highInvariantViolations;

        case 'low_governance_score':
            return governanceScore !== undefined && governanceScore < SAFE_MODE_CONFIG.triggers.lowGovernanceScore;

        case 'high_overload':
            return runtimeState.overloadScore > SAFE_MODE_CONFIG.triggers.highOverloadScore;

        case 'high_adaptation_rate':
            if (!runtimeState.adaptationConfig) return false;
            const totalChange = runtimeState.adaptationConfig.lastAdjustments
                .slice(-10)
                .reduce((sum, adj) => sum + Math.abs(adj.change || 0), 0);
            return totalChange > SAFE_MODE_CONFIG.triggers.highAdaptationRate;

        default:
            return false;
    }
}

// ======================================================
// SAFE MODE TRIGGER RECORDING
// ======================================================

/**
 * Record safe mode trigger.
 */
async function recordSafeModeTrigger(redis, trigger) {
    const key = SAFE_MODE_TRIGGER_KEY;
    const entry = {
        ...trigger,
        timestamp: Date.now(),
        timestampFormatted: new Date().toISOString()
    };

    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 999);

    return entry;
}

/**
 * Get safe mode triggers.
 */
async function getSafeModeTriggers(redis, limit = 50) {
    const key = SAFE_MODE_TRIGGER_KEY;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e));
}

// ======================================================
// SAFE MODE EVENTS
// ======================================================

/**
 * Get safe mode events.
 */
async function getSafeModeEvents(redis, limit = 50) {
    const key = SAFE_MODE_HISTORY_KEY;
    const entries = await redis.lrange(key, 0, limit - 1);

    return entries
        .map(e => JSON.parse(e))
        .filter(e => e.action === 'ENTERED' || e.action === 'EXITED');
}

/**
 * Record safe mode entered event.
 */
async function recordSafeModeEntered(redis, reason) {
    const event = {
        timestamp: Date.now(),
        type: 'SAFE_MODE_ENTERED',
        reason,
        recordedAt: new Date().toISOString()
    };

    await recordSafeModeTrigger(redis, reason);

    return event;
}

/**
 * Record safe mode exited event.
 */
async function recordSafeModeExited(redis, state) {
    const event = {
        timestamp: Date.now(),
        type: 'SAFE_MODE_EXITED',
        state,
        recordedAt: new Date().toISOString()
    };

    return event;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    SAFE_MODE_CONFIG,

    // State management
    createSafeModeState,
    isSafeModeActive,
    enterSafeMode,
    exitSafeMode,
    shouldEnterSafeMode,

    // Settings
    getSafeModeSettings,
    getSafeModeQuotas,
    getSafeModeAdmissionSettings,
    getSafeModeRetrySettings,
    applySafeModeRules,
    checkDispatchAllowedInSafeMode,
    getSafeModeEnforcementStatus,

    // History
    getSafeModeHistory,
    getSafeModeTransitions,
    getSafeModeStats,
    getSafeModeStatus,

    // Check helpers
    checkSafeModeConditions,
    checkCondition,
    getSafeModeTriggers,

    // Trigger recording
    recordSafeModeTrigger,
    getSafeModeTriggers,

    // Events
    getSafeModeEvents,
    recordSafeModeEntered,
    recordSafeModeExited,

    // Constants
    SAFE_MODE_PREFIX,
    SAFE_MODE_STATE_KEY,
    SAFE_MODE_HISTORY_KEY,
    SAFE_MODE_TRIGGER_KEY,
    SAFE_MODE_DELAY_KEY
};
