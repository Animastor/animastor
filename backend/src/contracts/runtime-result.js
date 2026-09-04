// ======================================================
// Runtime Result Contract — Phase 5 seam (data layer)
// ======================================================
// Stable shape of a runtime job/dispatch execution result, exchanged
// between runtime (producer) and orchestration (consumer).
//
// Layer position: `contracts/` sits BELOW orchestration and runtime.
// This module must require NOTHING relative — it is a leaf, so it can
// never participate in (or create) an import cycle (Phase 5 T8).
// See docs/architecture/PHASE_5_ORCHESTRATION_RUNTIME.md §3.1.
//
// Statuses are job-level and map 1:1 onto dispatch-engine finalization
// outcomes: success → completed, failure → failed, cancelled → cancelled.
// The runtime-internal outcome vocabulary never leaves the runtime layer.

'use strict';

const RUNTIME_RESULT_STATUS = Object.freeze({
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});

const RUNTIME_RESULT_STATUSES = Object.freeze(Object.values(RUNTIME_RESULT_STATUS));

// dispatch-engine.finalizeDispatch outcome → contract status
const OUTCOME_TO_STATUS = Object.freeze({
    success: RUNTIME_RESULT_STATUS.COMPLETED,
    failure: RUNTIME_RESULT_STATUS.FAILED,
    cancelled: RUNTIME_RESULT_STATUS.CANCELLED,
});

function statusFromOutcome(outcome) {
    return Object.prototype.hasOwnProperty.call(OUTCOME_TO_STATUS, outcome)
        ? OUTCOME_TO_STATUS[outcome]
        : null;
}

function requireNonEmptyString(value, field) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`runtime-result: ${field} must be a non-empty string`);
    }
    return value;
}

/**
 * Build a validated, frozen Runtime Result object.
 *
 * @param {Object} input
 * @param {string} input.bookId
 * @param {string} input.chapterId
 * @param {string} input.sceneId
 * @param {string} input.status          'completed' | 'failed' | 'cancelled'
 * @param {string|null} [input.jobId]    Job Protocol v2 job id (job-scoped results)
 * @param {string|null} [input.dispatchId] dispatch id (dispatch-scoped results)
 * @param {string|null} [input.stage]    'audio' | 'image' | 'video'
 * @param {*} [input.result]             artifact payload (reserved; artifacts stay on disk)
 * @param {string|null} [input.error]    human-readable failure reason
 * @param {Object} [input.metadata]      producer-defined extras (frozen copy)
 * @returns {Readonly<{jobId, dispatchId, bookId, chapterId, sceneId, stage, status, result, error, metadata}>}
 */
function createRuntimeResult(input = {}) {
    const {
        jobId = null,
        dispatchId = null,
        bookId,
        chapterId,
        sceneId,
        stage = null,
        status,
        result = null,
        error = null,
        metadata = {},
    } = input || {};

    requireNonEmptyString(bookId, 'bookId');
    requireNonEmptyString(chapterId, 'chapterId');
    requireNonEmptyString(sceneId, 'sceneId');

    if (!RUNTIME_RESULT_STATUSES.includes(status)) {
        throw new Error(
            `runtime-result: status must be one of ${RUNTIME_RESULT_STATUSES.join('|')}, got '${status}'`
        );
    }

    if (jobId !== null) requireNonEmptyString(jobId, 'jobId');
    if (dispatchId !== null) requireNonEmptyString(dispatchId, 'dispatchId');
    if (jobId === null && dispatchId === null) {
        throw new Error('runtime-result: jobId or dispatchId is required');
    }
    if (stage !== null) requireNonEmptyString(stage, 'stage');
    if (error !== null && typeof error !== 'string') {
        throw new Error('runtime-result: error must be a string or null');
    }
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('runtime-result: metadata must be a plain object');
    }

    return Object.freeze({
        jobId,
        dispatchId,
        bookId,
        chapterId,
        sceneId,
        stage,
        status,
        result,
        error,
        metadata: Object.freeze({ ...metadata }),
    });
}

module.exports = {
    RUNTIME_RESULT_STATUS,
    RUNTIME_RESULT_STATUSES,
    OUTCOME_TO_STATUS,
    statusFromOutcome,
    createRuntimeResult,
};
