// ======================================================
// FAILURE TAXONOMY - CLASSIFY RUNTIME FAILURES
// ======================================================
// Formal failure categories for operational visibility.
// This is NOT business logic - it's runtime operational classification.
//
// FAILURE TYPES:
// - TRANSIENT: timeout, network, rate limit, temporary unavailable
// - PERMANENT: invalid workflow, invalid asset, corrupted media, invalid data
// - INFRASTRUCTURE: redis unavailable, filesystem failure, ffmpeg missing, worker crash
// - ORCHESTRATION: invalid transition, duplicate dispatch, stale lease, counter drift

const logPrefix = '[FAILURE]';

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
// FAILURE TYPES
// ======================================================

/**
 * Failure type constants.
 */
const FailureType = {
    // Transient - temporary issues, retry immediately
    TRANSIENT: 'transient',

    // Permanent - will not succeed on retry, do not retry
    PERMANENT: 'permanent',

    // Infrastructure - systemic issues, delayed retry
    INFRASTRUCTURE: 'infrastructure',

    // Orchestration - system state issues, reconcile first
    ORCHESTRATION: 'orchestration'
};

/**
 * Severity levels for failures.
 */
const FailureSeverity = {
    LOW: 'low',
    MEDIUM: 'medium',
    HIGH: 'high',
    CRITICAL: 'critical'
};

// ======================================================
// CLASSIFICATION PATTERNS
// ======================================================

/**
 * Transient failure patterns (retryable).
 */
const TRANSIENT_PATTERNS = [
    /timeout/i,
    /connection.*refused/i,
    /connection.*reset/i,
    /network.*error/i,
    /rate.*limit/i,
    /too.*many.*requests/i,
    /temporary.*unavailable/i,
    /worker.*unavailable/i,
    /service.*unavailable/i,
    /gateway.*timeout/i,
    /dns.*timeout/i,
    /socket.* hang up/i,
    /connection.*closed/i
];

/**
 * Permanent failure patterns (non-retryable).
 */
const PERMANENT_PATTERNS = [
    /invalid.*workflow/i,
    /invalid.*asset/i,
    /corrupted.*media/i,
    /corrupted.*file/i,
    /invalid.*scene.*data/i,
    /missing.*required.*field/i,
    /invalid.*parameter/i,
    /unsupported.*format/i,
    /file.*not.*found/i,
    /asset.*not.*found/i,
    /scene.*not.*found/i,
    /workflow.*not.*found/i
];

/**
 * Infrastructure failure patterns.
 */
const INFRASTRUCTURE_PATTERNS = [
    /redis.*unavailable/i,
    /redis.*connection.*refused/i,
    /redis.*timeout/i,
    /file.*system.*failure/i,
    /filesystem.*error/i,
    /ffmpeg.*missing/i,
    /ffmpeg.*not.*found/i,
    /ffmpeg.*exec.*error/i,
    /worker.*crash/i,
    /worker.*exit/i,
    /worker.*timeout/i,
    /disk.*full/i,
    /out.*of.*memory/i
];

/**
 * Orchestration failure patterns.
 */
const ORCHESTRATION_PATTERNS = [
    /invalid.*transition/i,
    /duplicate.*dispatch/i,
    /stale.*lease/i,
    /counter.*drift/i,
    /lease.*mismatch/i,
    /token.*mismatch/i,
    /state.*conflict/i,
    /parallel.*transition/i,
    /lock.* acquisition/i
];

// ======================================================
// CLASSIFICATION LOGIC
// ======================================================

/**
 * Match error message against patterns.
 */
function matchPattern(message, patterns) {
    if (!message) return false;
    for (const pattern of patterns) {
        if (pattern.test(message)) {
            return true;
        }
    }
    return false;
}

/**
 * Extract location from error stack.
 */
function extractLocation(error) {
    if (!error || !error.stack) return null;

    const lines = error.stack.split('\n');
    for (const line of lines) {
        // Match typical stack trace line: "    at FunctionName (file.js:123:45)"
        const match = line.match(/at\s+(?:\w+\s+)?\(([^):]+):(\d+):(\d+)\)/);
        if (match) {
            return {
                file: match[1],
                line: parseInt(match[2], 10),
                column: parseInt(match[3], 10)
            };
        }
    }
    return null;
}

/**
 * Classify an error into a failure category.
 * Returns: { type, retryable, severity, message, location, code }
 */
function classifyFailure(error) {
    if (!error) {
        return {
            type: FailureType.TRANSIENT,
            retryable: true,
            severity: FailureSeverity.LOW,
            message: 'Unknown error - empty error object',
            location: null
        };
    }

    const message = (error.message || error.toString() || '').toLowerCase();
    const code = error.code || null;
    const stackLocation = extractLocation(error);

    // Check patterns in priority order
    let type = FailureType.TRANSIENT;
    let retryable = true;
    let severity = FailureSeverity.MEDIUM;

    if (matchPattern(message, PERMANENT_PATTERNS)) {
        type = FailureType.PERMANENT;
        retryable = false;
        severity = FailureSeverity.HIGH;
    } else if (matchPattern(message, INFRASTRUCTURE_PATTERNS)) {
        type = FailureType.INFRASTRUCTURE;
        retryable = true; // Delayed retry for infra issues
        severity = FailureSeverity.CRITICAL;
    } else if (matchPattern(message, ORCHESTRATION_PATTERNS)) {
        type = FailureType.ORCHESTRATION;
        retryable = false; // Must reconcile first, then retry
        severity = FailureSeverity.MEDIUM;
    } else if (matchPattern(message, TRANSIENT_PATTERNS)) {
        type = FailureType.TRANSIENT;
        retryable = true;
        severity = FailureSeverity.LOW;
    } else {
        // Default based on code or generic handling
        if (code) {
            // HTTP status codes
            if (code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ECONNRESET') {
                type = FailureType.TRANSIENT;
                retryable = true;
                severity = FailureSeverity.LOW;
            } else if (code === 'EPERM' || code === 'EACCES' || code === 'ENOENT') {
                type = FailureType.PERMANENT;
                retryable = false;
                severity = FailureSeverity.HIGH;
            } else if (code.startsWith('E')) {
                type = FailureType.TRANSIENT;
                retryable = true;
                severity = FailureSeverity.LOW;
            }
        }
    }

    log(`FAILURE_CLASSIFIED: ${type} (retryable=${retryable}, severity=${severity}): ${message.slice(0, 80)}`);

    return {
        type,
        retryable,
        severity,
        message,
        code,
        location: stackLocation,
        classifiedAt: Date.now()
    };
}

// ======================================================
// RETRY POLICIES
// ======================================================

/**
 * Get retry policy for a failure type.
 */
function getRetryPolicy(failureType) {
    const policies = {
        [FailureType.TRANSIENT]: {
            immediate: true,
            maxRetries: 5,
            backoffMs: 1000, // Start at 1s
            backoffMultiplier: 2,
            maxBackoffMs: 30000, // Cap at 30s
            description: 'Retry immediately with exponential backoff'
        },
        [FailureType.PERMANENT]: {
            immediate: false,
            maxRetries: 0,
            backoffMs: 0,
            backoffMultiplier: 0,
            maxBackoffMs: 0,
            description: 'Do not retry - permanent failure'
        },
        [FailureType.INFRASTRUCTURE]: {
            immediate: false,
            maxRetries: 10,
            backoffMs: 5000, // Start at 5s
            backoffMultiplier: 1.5,
            maxBackoffMs: 120000, // Cap at 2min
            description: 'Retry with delay - infrastructure issue'
        },
        [FailureType.ORCHESTRATION]: {
            immediate: false,
            maxRetries: 3,
            backoffMs: 2000, // Start at 2s
            backoffMultiplier: 2,
            maxBackoffMs: 15000, // Cap at 15s
            requiresReconciliation: true,
            description: 'Run reconciliation before retry'
        }
    };

    return policies[failureType] || policies[FailureType.TRANSIENT];
}

/**
 * Calculate backoff delay for retry attempt.
 */
function calculateBackoff(policy, attempt) {
    if (!policy.immediate || policy.maxRetries === 0) {
        return 0;
    }

    const delay = Math.min(
        policy.backoffMs * Math.pow(policy.backoffMultiplier, attempt),
        policy.maxBackoffMs
    );

    return Math.round(delay);
}

// ======================================================
// RETRY METADATA
// ======================================================

/**
 * Create retry metadata for a failure.
 */
function createRetryMetadata(error, failureClass, attempt = 0) {
    const classification = failureClass || classifyFailure(error);

    return {
        retry_count: attempt,
        retry_reason: classification.message.slice(0, 200), // Truncate for storage
        last_retry_at: classification.classifiedAt,
        failure_type: classification.type,
        failure_code: classification.code,
        severity: classification.severity,
        should_retry: classification.retryable,
        next_backoff_ms: classification.retryable ? calculateBackoff(getRetryPolicy(classification.type), attempt) : 0
    };
}

// ======================================================
// HELPER: Error wrappers
// ======================================================

/**
 * Wrap an error with failure classification.
 */
function wrapWithFailureInfo(error, classification) {
    const wrapped = new Error(error.message);
    wrapped.name = error.name;
    wrapped.stack = error.stack;
    wrapped.failureInfo = {
        ...classification,
        wrappedAt: Date.now()
    };
    return wrapped;
}

/**
 * Extract failure info from an error.
 */
function getFailureInfo(error) {
    return error && error.failureInfo;
}

// ======================================================
// METRICS
// ======================================================

/**
 * Get failure types for metrics.
 */
function getFailureTypeKeys() {
    return [
        'transient',
        'permanent',
        'infrastructure',
        'orchestration'
    ];
}

/**
 * Increment failure counter in Redis.
 */
async function incrementFailureCounter(redis, failureType, severity) {
    const key = `animastor:runtime:metrics:failures:${failureType}`;
    await redis.incr(key);

    const severityKey = `animastor:runtime:metrics:failures:${failureType}:${severity}`;
    await redis.incr(severityKey);
}

/**
 * Get failure metrics from Redis.
 */
async function getFailureMetrics(redis) {
    const keys = getFailureTypeKeys();
    const metrics = {};

    for (const key of keys) {
        const count = await redis.get(`animastor:runtime:metrics:failures:${key}`);
        metrics[key] = parseInt(count || '0', 10);
    }

    return metrics;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    FailureType,
    FailureSeverity,

    // Classification
    classifyFailure,
    getFailureInfo,
    wrapWithFailureInfo,

    // Retry policies
    getRetryPolicy,
    calculateBackoff,
    createRetryMetadata,

    // Patterns (for testing)
    TRANSIENT_PATTERNS,
    PERMANENT_PATTERNS,
    INFRASTRUCTURE_PATTERNS,
    ORCHESTRATION_PATTERNS,

    // Metrics
    incrementFailureCounter,
    getFailureMetrics,
    getFailureTypeKeys
};
