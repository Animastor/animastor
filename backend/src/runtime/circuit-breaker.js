// ======================================================
// Circuit Breaker - v1.0.0
// ======================================================
// Implements circuit breaker pattern for resilient runtime.
// Prevents cascading failures and retry storms.
//
// STATES:
// - CLOSED: normal operation, dispatches allowed
// - OPEN: dispatches blocked, circuit tripped
// - HALF_OPEN: test dispatches allowed, limited recovery
//
// TARGETS:
// - audio generation
// - image generation
// - video generation
// - Redis connection
// - filesystem operations
// - external worker callbacks

const logPrefix = '[CIRCUIT]';

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
// CIRCUIT STATES
// ======================================================

const CircuitState = {
    CLOSED: 'closed',
    OPEN: 'open',
    HALF_OPEN: 'half_open'
};

// ======================================================
// CIRCUIT CONFIGURATION
// ======================================================

const CIRCUIT_CONFIG = {
    // Failure thresholds
    failureThreshold: 5,      // 5 failures triggers OPEN
    failureWindowMs: 2 * 60 * 1000,  // 2 minutes window

    // Recovery
    recoveryTimeoutMs: 60 * 1000,  // 60 seconds cooldown before HALF_OPEN

    // Half-open limits
    halfOpenMaxRequests: 2,  // Allow 2 test dispatches in HALF_OPEN

    // Satiety config (to recover from failure)
    saturationThreshold: 8,  // 8 failures triggers saturation (more aggressive)
    saturationRecoveryMs: 5 * 60 * 1000,  // 5 minutes saturation recovery
};

// ======================================================
// CIRCUIT KEYS
// ======================================================

/**
 * Get circuit state key for service.
 */
function getCircuitStateKey(service) {
    return `animastor:circuit:${service}`;
}

/**
 * Get circuit failure count key.
 */
function getCircuitFailureKey(service) {
    return `animastor:circuit:${service}:failures`;
}

/**
 * Get circuit last failure timestamp key.
 */
function getCircuitLastFailureKey(service) {
    return `animastor:circuit:${service}:last-failure`;
}

/**
 * Get circuit half-open requests key.
 */
function getCircuitHalfOpenKey(service) {
    return `animastor:circuit:${service}:half-open`;
}

// ======================================================
// SERVICE TARGETS
// ======================================================

const SERVICE_TARGETS = {
    AUDIO: 'audio',
    IMAGE: 'image',
    VIDEO: 'video',
    REDIS: 'redis',
    FILESYSTEM: 'filesystem',
    WORKER_CALLBACK: 'worker_callback',
    SCHEDULER: 'scheduler'
};

// ======================================================
// CIRCUIT STATE MANAGEMENT
// ======================================================

/**
 * Get current circuit state for a service.
 */
async function getCircuitState(redis, service) {
    const stateKey = getCircuitStateKey(service);
    const rawState = await redis.get(stateKey);

    if (!rawState) {
        // Default to CLOSED if not set
        return CircuitState.CLOSED;
    }

    return rawState;
}

/**
 * Set circuit state for a service.
 */
async function setCircuitState(redis, service, state) {
    const stateKey = getCircuitStateKey(service);
    await redis.set(stateKey, state, 'EX', 24 * 60 * 60); // 24 hour TTL

    log(`CIRCUIT_${state.toUpperCase()}: ${service}`);
    return { state, setAt: Date.now() };
}

/**
 * Check if circuit is open for a service.
 */
async function isCircuitOpen(redis, service) {
    const state = await getCircuitState(redis, service);
    return state === CircuitState.OPEN;
}

/**
 * Check if circuit is in half-open state.
 */
async function isCircuitHalfOpen(redis, service) {
    const state = await getCircuitState(redis, service);
    return state === CircuitState.HALF_OPEN;
}

// ======================================================
// FAILURE TRACKING
// ======================================================

/**
 * Record a failure for a service.
 * Returns: { circuitState, isTripped, newCount }
 */
async function recordFailure(redis, service) {
    const failureKey = getCircuitFailureKey(service);
    const lastFailureKey = getCircuitLastFailureKey(service);

    // Increment failure count
    const newCount = await redis.incr(failureKey);
    await redis.set(lastFailureKey, Date.now().toString());

    // Check if threshold exceeded
    const isTripped = newCount >= CIRCUIT_CONFIG.failureThreshold;

    // If tripped, open the circuit
    if (isTripped) {
        const oldState = await setCircuitState(redis, service, CircuitState.OPEN);
        log(`CIRCUIT_TRIPPED: ${service} (failures: ${newCount})`);
    }

    // Set expiry on failure count (auto-cleanup after failure window)
    await redis.expire(failureKey, Math.ceil(CIRCUIT_CONFIG.failureWindowMs / 1000));

    return {
        circuitState: await getCircuitState(redis, service),
        isTripped,
        newCount,
        service
    };
}

/**
 * Record a successful operation.
 * Resets failure count for closed circuits.
 */
async function recordSuccess(redis, service) {
    const failureKey = getCircuitFailureKey(service);

    // B8: recordSuccess НЕ переключает OPEN → HALF_OPEN.
    // Этот переход делает только tryRecover с проверкой recoveryTimeout.
    // Если circuit OPEN — успех не должен пробивать защиту.
    const currentState = await getCircuitState(redis, service);
    if (currentState === CircuitState.OPEN) {
        // Circuit is open — success calls should not happen through normal flow
        // But if they do (e.g., test request passed the guard), just log and return
        return { success: false, state: CircuitState.OPEN, reason: 'circuit_open' };
    }

    // Reset failure count if circuit is closed
    if (currentState === CircuitState.CLOSED) {
        await redis.set(failureKey, '0', 'EX', Math.ceil(CIRCUIT_CONFIG.failureWindowMs / 1000));
        return { success: true, state: CircuitState.CLOSED, reset: true };
    }

    return { success: true, state: currentState };
}

/**
 * Check if circuit has failed recently.
 */
async function hasRecentFailures(redis, service) {
    const failureKey = getCircuitFailureKey(service);
    const lastFailureKey = getCircuitLastFailureKey(service);

    const failureCount = await redis.get(failureKey);
    const lastFailure = await redis.get(lastFailureKey);

    if (!failureCount || !lastFailure) {
        return { recent: false, count: 0 };
    }

    const count = parseInt(failureCount, 10);
    const lastFailureTime = parseInt(lastFailure, 10);
    const now = Date.now();
    const elapsed = now - lastFailureTime;

    const recent = elapsed < CIRCUIT_CONFIG.failureWindowMs;

    return {
        recent,
        count,
        elapsedMs: elapsed,
        withinWindow: elapsed < CIRCUIT_CONFIG.failureWindowMs
    };
}

// ======================================================
// DISPATCH CHECK
// ======================================================

/**
 * Check if dispatch should be allowed.
 * Returns: { allowed, reason, circuitState }
 */
async function checkDispatch(redis, service) {
    const currentState = await getCircuitState(redis, service);

    switch (currentState) {
        case CircuitState.CLOSED:
            return { allowed: true, reason: 'circuit_closed', circuitState: currentState };

        case CircuitState.OPEN:
            return { allowed: false, reason: 'circuit_open', circuitState: currentState };

        case CircuitState.HALF_OPEN:
            const halfOpenKey = getCircuitHalfOpenKey(service);
            const halfOpenCount = await redis.get(halfOpenKey);
            const count = parseInt(halfOpenCount || '0', 10);

            if (count >= CIRCUIT_CONFIG.halfOpenMaxRequests) {
                // Too many test requests, go back to open
                return { allowed: false, reason: 'half_open_limit_reached', circuitState: currentState };
            }

            return { allowed: true, reason: 'half_open_test', circuitState: currentState, isTestRequest: true };

        default:
            return { allowed: false, reason: 'unknown_state', circuitState: currentState };
    }
}

/**
 * Check dispatch and increment test counter if half-open.
 */
async function checkAndIncrementTestRequest(redis, service) {
    const result = await checkDispatch(redis, service);

    if (result.allowed && result.isTestRequest) {
        const halfOpenKey = getCircuitHalfOpenKey(service);
        await redis.incr(halfOpenKey);
    }

    return result;
}

// ======================================================
// RECOVERY LOGIC
// ======================================================

/**
 * Try to recover a circuit from OPEN to HALF_OPEN.
 * Only allowed after recovery timeout.
 */
async function tryRecover(redis, service) {
    const stateKey = getCircuitStateKey(service);
    const state = await getCircuitState(redis, service);

    if (state !== CircuitState.OPEN) {
        return { recoverable: false, reason: 'not_open', state };
    }

    // Check if enough time has passed
    const lastFailureKey = getCircuitLastFailureKey(service);
    const lastFailure = await redis.get(lastFailureKey);

    if (!lastFailure) {
        // No failures recorded, safe to recover
        const result = await setCircuitState(redis, service, CircuitState.HALF_OPEN);
        return { recoverable: true, reason: 'no_failures', state, ...result };
    }

    const lastFailureTime = parseInt(lastFailure, 10);
    const elapsed = Date.now() - lastFailureTime;

    if (elapsed < CIRCUIT_CONFIG.recoveryTimeoutMs) {
        return {
            recoverable: false,
            reason: 'timeout_not_met',
            state,
            elapsedMs: elapsed,
            timeoutRemainingMs: CIRCUIT_CONFIG.recoveryTimeoutMs - elapsed
        };
    }

    // Recover to half-open
    const halfOpenKey = getCircuitHalfOpenKey(service);
    await redis.set(halfOpenKey, '0', 'EX', Math.ceil(CIRCUIT_CONFIG.recoveryTimeoutMs / 1000));

    const result = await setCircuitState(redis, service, CircuitState.HALF_OPEN);
    log(`CIRCUIT_RECOVERED: ${service} (elapsed: ${Math.floor(elapsed / 1000)}s)`);

    return { recoverable: true, reason: 'timeout_met', state, ...result };
}

/**
 * Force open a circuit (emergency stop).
 */
async function forceOpen(redis, service, reason) {
    const result = await setCircuitState(redis, service, CircuitState.OPEN);
    log(`CIRCUIT_FORCED_OPEN: ${service} (reason: ${reason})`);
    return result;
}

/**
 * Force close a circuit (manual recovery).
 */
async function forceClose(redis, service, reason) {
    const failureKey = getCircuitFailureKey(service);
    await redis.set(failureKey, '0');

    const result = await setCircuitState(redis, service, CircuitState.CLOSED);
    log(`CIRCUIT_FORCED_CLOSED: ${service} (reason: ${reason})`);
    return result;
}

// ======================================================
// CIRCUIT METRICS
// ======================================================

/**
 * Get all circuit states.
 */
async function getCircuitsStatus(redis) {
    const circuits = {};
    const services = Object.values(SERVICE_TARGETS);

    for (const service of services) {
        circuits[service] = {
            state: await getCircuitState(redis, service),
            failures: await redis.get(getCircuitFailureKey(service)),
            lastFailure: await redis.get(getCircuitLastFailureKey(service)),
            halfOpenCount: await redis.get(getCircuitHalfOpenKey(service))
        };
    }

    return circuits;
}

/**
 * Get circuit metrics for a specific service.
 */
async function getCircuitMetrics(redis, service) {
    const stateKey = getCircuitStateKey(service);
    const state = await getCircuitState(redis, service);

    const failureCount = await redis.get(getCircuitFailureKey(service));
    const lastFailure = await redis.get(getCircuitLastFailureKey(service));
    const halfOpenCount = await redis.get(getCircuitHalfOpenKey(service));

    let lastFailureTime = null;
    let timeSinceLastFailure = null;
    if (lastFailure) {
        lastFailureTime = parseInt(lastFailure, 10);
        timeSinceLastFailure = Date.now() - lastFailureTime;
    }

    let halfOpenValue = null;
    if (halfOpenCount) {
        halfOpenValue = parseInt(halfOpenCount, 10);
    }

    return {
        service,
        state,
        failureCount: parseInt(failureCount || '0', 10),
        halfOpenCount: halfOpenValue,
        lastFailureTime,
        timeSinceLastFailure,
        config: {
            failureThreshold: CIRCUIT_CONFIG.failureThreshold,
            failureWindowMs: CIRCUIT_CONFIG.failureWindowMs,
            recoveryTimeoutMs: CIRCUIT_CONFIG.recoveryTimeoutMs
        }
    };
}

// ======================================================
// HELPER: Check all circuit breakers at once
// ======================================================

/**
 * Check if any circuit is open (overall runtime health).
 */
async function hasAnyOpenCircuit(redis) {
    const services = Object.values(SERVICE_TARGETS);
    const openCircuits = [];

    for (const service of services) {
        const state = await getCircuitState(redis, service);
        if (state === CircuitState.OPEN) {
            openCircuits.push(service);
        }
    }

    return {
        hasOpen: openCircuits.length > 0,
        openCircuits
    };
}

/**
 * Check if runtime is healthy (all circuits closed).
 */
async function isRuntimeHealthy(redis) {
    const status = await getCircuitsStatus(redis);
    return Object.values(status).every(c => c.state === CircuitState.CLOSED);
}

// ======================================================
// exported
// ======================================================

module.exports = {
    // Constants
    CircuitState,
    SERVICE_TARGETS,

    // Config
    CIRCUIT_CONFIG,

    // State management
    getCircuitStateKey,
    getCircuitState,
    setCircuitState,
    isCircuitOpen,
    isCircuitHalfOpen,

    // Failure tracking
    recordFailure,
    recordSuccess,
    hasRecentFailures,

    // Dispatch check
    checkDispatch,
    checkAndIncrementTestRequest,

    // Recovery
    tryRecover,
    forceOpen,
    forceClose,

    // Metrics
    getCircuitsStatus,
    getCircuitMetrics,
    hasAnyOpenCircuit,
    isRuntimeHealthy
};
