// ======================================================
// CIRCUIT POLICY - CIRCUIT BREAKER RESPONSE
// ======================================================
// Responds to circuit breaker state changes.
// Prevents dispatching to failing services.

const circuitBreaker = require('../circuit-breaker');

const logPrefix = '[POLICY:CIRCUIT]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

// ======================================================
// CIRCUIT POLICY CONFIGURATION
// ======================================================

const CIRCUIT_POLICY_CONFIG = {
    // Circuit states
    openCooldownMs: 30000, // 30 seconds before half-open
    halfOpenTestRequests: 1,

    // Service-specific behavior
    serviceBehavior: {
        audio: { critical: false, recoveryBonus: true },
        image: { critical: false, recoveryBonus: true },
        video: { critical: true, recoveryBonus: true } // Video is critical
    },

    // Overwrite thresholds by service
    overwrites: {
        audio: { openThreshold: 5, halfOpenCount: 3 },
        image: { openThreshold: 5, halfOpenCount: 3 },
        video: { openThreshold: 3, halfOpenCount: 1 } // Video opens faster
    }
};

// ======================================================
// POLICY DECISION TYPES
// ======================================================

const CircuitDecisionType = {
    CIRCUIT_CLOSED: 'circuit_closed',
    CIRCUIT_OPEN: 'circuit_open',
    CIRCUIT_HALF_OPEN: 'circuit_half_open',
    SERVICE_UNAVAILABLE: 'service_unavailable'
};

// ======================================================
// GET CIRCUIT STATUS
// ======================================================

/**
 * Get circuit status for stage.
 */
async function getCircuitStatus(redis, stage) {
    return await circuitBreaker.checkDispatch(redis, stage);
}

/**
 * Check if any circuit is open.
 */
async function hasOpenCircuit(redis) {
    const audio = await circuitBreaker.checkDispatch(redis, 'audio');
    const image = await circuitBreaker.checkDispatch(redis, 'image');
    const video = await circuitBreaker.checkDispatch(redis, 'video');

    const openCircuits = [];
    if (!audio.allowed) openCircuits.push({ stage: 'audio', state: audio.circuitState });
    if (!image.allowed) openCircuits.push({ stage: 'image', state: image.circuitState });
    if (!video.allowed) openCircuits.push({ stage: 'video', state: video.circuitState });

    return {
        hasOpenCircuit: openCircuits.length > 0,
        openCircuits
    };
}

// ======================================================
// POLICY EVALUATION
// ======================================================

/**
 * Evaluate circuit policy for stage.
 * Returns decision based on circuit breaker state.
 */
async function evaluate(redis, stage) {
    const circuit = await getCircuitStatus(redis, stage);

    // Determine decision type
    let decisionType;
    let allowed = true;
    let reason = 'circuit_closed';
    let delayMs = 0;

    switch (circuit.circuitState) {
        case circuitBreaker.CircuitState.CLOSED:
            decisionType = CircuitDecisionType.CIRCUIT_CLOSED;
            reason = 'circuit_closed';
            break;

        case circuitBreaker.CircuitState.HALF_OPEN:
            decisionType = CircuitDecisionType.CIRCUIT_HALF_OPEN;
            reason = 'circuit_half_open_test';
            allowed = circuit.testRequest; // Only allow test request
            delayMs = 0;
            break;

        case circuitBreaker.CircuitState.OPEN:
            decisionType = CircuitDecisionType.CIRCUIT_OPEN;
            allowed = false;
            reason = 'circuit_open';
            delayMs = CIRCUIT_POLICY_CONFIG.openCooldownMs;
            break;

        default:
            decisionType = CircuitDecisionType.SERVICE_UNAVAILABLE;
            allowed = false;
            reason = 'service_unavailable';
    }

    log(`CIRCUIT_POLICY_EVAL: stage=${stage}, state=${circuit.circuitState}, allowed=${allowed}`);

    return {
        decisionType,
        allowed,
        reason,
        delayMs,
        circuitState: circuit.circuitState,
        stage,
        circuit
    };
}

// ======================================================
// CIRCUIT-AFFECTED SERVICE CHECK
// ======================================================

/**
 * Check if service is affected by circuit.
 */
async function isServiceAffected(redis, stage) {
    const circuit = await getCircuitStatus(redis, stage);
    return !circuit.allowed;
}

/**
 * Get affected services (circuits that are open/half-open).
 */
async function getAffectedServices(redis) {
    const [audio, image, video] = await Promise.all([
        circuitBreaker.checkDispatch(redis, 'audio'),
        circuitBreaker.checkDispatch(redis, 'image'),
        circuitBreaker.checkDispatch(redis, 'video')
    ]);

    return {
        audio: !audio.allowed,
        image: !image.allowed,
        video: !video.allowed,
        totalAffected: [audio, image, video].filter(c => !c.allowed).length
    };
}

// ======================================================
// WAIT UNTIL CIRCUIT RECOVERY
// ======================================================

/**
 * Wait for circuit to close (or timeout).
 * Returns: { recovered: boolean, waitedMs }
 */
async function waitForCircuitRecovery(redis, stage, timeoutMs = 60000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        const circuit = await getCircuitStatus(redis, stage);
        if (circuit.circuitState === circuitBreaker.CircuitState.CLOSED) {
            return {
                recovered: true,
                waitedMs: Date.now() - start
            };
        }
        // Wait before next check
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return {
        recovered: false,
        waitedMs: Date.now() - start,
        timeoutMs
    };
}

// ======================================================
// SERVICE RECOVERY CHECK
// ======================================================

/**
 * Check if circuit can attempt recovery (half-open test).
 */
async function canAttemptRecovery(redis, stage) {
    const circuit = await getCircuitStatus(redis, stage);

    if (circuit.circuitState !== circuitBreaker.CircuitState.HALF_OPEN) {
        return {
            canAttempt: false,
            reason: 'circuit_not_half_open',
            circuitState: circuit.circuitState
        };
    }

    return {
        canAttempt: circuit.testRequest,
        reason: circuit.testRequest ? 'test_request_allowed' : 'test_limit_reached',
        halfOpenCount: circuit.halfOpenCount,
        circuitState: circuit.circuitState
    };
}

// ======================================================
// CIRCUIT STATE TRANSITION
// ======================================================

/**
 * Record success for circuit recovery.
 */
async function recordSuccessForRecovery(redis, stage) {
    return await circuitBreaker.recordSuccess(redis, stage);
}

/**
 * Record failure for circuit tripping.
 */
async function recordFailureForTrip(redis, stage) {
    return await circuitBreaker.recordFailure(redis, stage);
}

// ======================================================
// POLICY PRECEDENCE
// ======================================================
// Circuit policy has very high precedence (second only to overload).

const CIRCUIT_PRECEDENCE = 2; // Lower = higher precedence

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    CircuitDecisionType,
    CIRCUIT_POLICY_CONFIG,

    // Circuit status
    getCircuitStatus,
    hasOpenCircuit,

    // Policy evaluation
    evaluate,

    // Service checks
    isServiceAffected,
    getAffectedServices,
    waitForCircuitRecovery,
    canAttemptRecovery,

    // Circuit state transitions
    recordSuccessForRecovery,
    recordFailureForTrip,

    // Precedence
    CIRCUIT_PRECEDENCE
};
