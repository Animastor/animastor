// ======================================================
// FAILURE TAXONOMY - MINIMAL CLASSIFIER
// ======================================================
// S1 (2026-07-19): сокращён с 424 строк до ~80.
// Избыточные pattern-matching, severity levels, retry policies,
// retry metadata, error wrappers и metrics counters удалены —
// они не использовались в production-пути.
//
// Использование:
//   - orchestrator.failStage(): classifyFailure() → failureType для journal
//   - dispatch-engine.finalizeDispatch('failure'): failureType для retry budget
//
// Контракт:
//   classifyFailure(err) → { type: 'transient'|'permanent'|'infrastructure'|'orchestration',
//                             retryable: boolean }
//
// Классификация: trans|orchestration → transient (retry), permanent/infrastructure → нет.
// Отброшенные патче HTTP-коды и stack-trace парсинг мёртвого retry-manager не нужны.

const logPrefix = '[FAILURE]';
function log(msg) { console.log(`${logPrefix} ${msg}`); }

const FailureType = {
    TRANSIENT: 'transient',
    PERMANENT: 'permanent',
    INFRASTRUCTURE: 'infrastructure',
    ORCHESTRATION: 'orchestration'
};

const FailureSeverity = {
    LOW: 'low',
    MEDIUM: 'medium',
    HIGH: 'high',
    CRITICAL: 'critical'
};

// Минимальный набор паттернов для отличия permanent (не retry) от остального.
const PERMANENT_PATTERNS = [
    /invalid.*workflow/i,
    /invalid.*asset/i,
    /corrupted/i,
    /invalid.*scene.*data/i,
    /missing.*required.*field/i,
    /unsupported.*format/i,
    /(.*)not.*found$/i
];

const INFRASTRUCTURE_PATTERNS = [
    /redis.*unavailable/i,
    /redis.*connection/i,
    /filesystem.*error/i,
    /ffmpeg.*missing/i,
    /ffmpeg.*not.*found/i,
    /disk.*full/i,
    /out.*of.*memory/i
];

function matchPattern(message, patterns) {
    if (!message) return false;
    for (const p of patterns) {
        if (p.test(message)) return true;
    }
    return false;
}

/**
 * Classify an error into a failure category.
 * Returns: { type, retryable, severity, message, code }
 *
 * Priority: infrastructure → permanent → orchestration → transient (default).
 * For 1-5 concurrent users этого достаточно — нет нужды в HTTP-кодах и severity logic.
 */
function classifyFailure(err) {
    if (!err) {
        return {
            type: FailureType.TRANSIENT,
            retryable: true,
            severity: FailureSeverity.LOW,
            message: 'Unknown error'
        };
    }

    const message = (err.message || err.toString() || '');
    const code = err.code || null;
    const lower = message.toLowerCase();

    let type = FailureType.TRANSIENT;
    let retryable = true;
    let severity = FailureSeverity.MEDIUM;

    if (matchPattern(lower, INFRASTRUCTURE_PATTERNS)) {
        type = FailureType.INFRASTRUCTURE;
        retryable = true;
        severity = FailureSeverity.HIGH;
    } else if (matchPattern(lower, PERMANENT_PATTERNS)) {
        type = FailureType.PERMANENT;
        retryable = false;
        severity = FailureSeverity.HIGH;
    } else if (/invalid.*transition|duplicate.*dispatch|stale.*lease|counter.*drift|token.*mismatch/i.test(lower)) {
        type = FailureType.ORCHESTRATION;
        retryable = false;
        severity = FailureSeverity.MEDIUM;
    } else if (code === 'EPERM' || code === 'EACCES' || code === 'ENOENT') {
        type = FailureType.PERMANENT;
        retryable = false;
        severity = FailureSeverity.HIGH;
    } else {
        type = FailureType.TRANSIENT;
        retryable = true;
        severity = FailureSeverity.LOW;
    }

    return { type, retryable, severity, message, code, classifiedAt: Date.now() };
}

function getFailureTypeKeys() {
    return ['transient', 'permanent', 'infrastructure', 'orchestration'];
}

module.exports = {
    FailureType,
    FailureSeverity,
    classifyFailure,
    getFailureTypeKeys
};
