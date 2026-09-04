// ======================================================
// Runtime Result Emitter — Phase 5 seam (producer side)
// ======================================================
// Runtime reports job/dispatch execution outcomes to orchestration
// through an INJECTED consumer callback — never by requiring
// orchestration modules directly (Phase 5 main architectural contract:
// runtime → result contract/callback, NOT runtime → orchestration).
//
// The consumer is registered once at the composition root
// (backend.cjs): runtimeResultEmitter.setConsumer(consumerFn).
// Default (unset consumer): emit is a no-op returning { delivered: false }.
//
// Delivery guarantees:
//   - at most one consumer (last registration wins);
//   - emitRuntimeResult NEVER throws — consumer errors are logged and
//     swallowed so dispatch finalization semantics cannot change;
//   - notification-only: the consumer receives the frozen result object
//     and must not throw on slow paths (it is awaited if it returns a
//     promise, but rejections are contained).

'use strict';

const { createRuntimeResult, statusFromOutcome } = require('../contracts/runtime-result');

const logPrefix = '[RUNTIME-RESULT]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

let consumer = null;

/**
 * Register the runtime result consumer (orchestration adapter).
 * Injected from the composition root; runtime never imports it.
 *
 * @param {(result: object) => (void|Promise<void>)} fn
 */
function setConsumer(fn) {
    if (typeof fn !== 'function') {
        throw new Error('runtime-result-emitter: consumer must be a function');
    }
    consumer = fn;
}

/** Test/multi-instance helper: drop the registered consumer. */
function resetConsumer() {
    consumer = null;
}

/**
 * Normalize a dispatch finalization into the Runtime Result contract
 * and deliver it to the registered consumer (if any).
 *
 * Never throws: contract-construction or consumer errors are logged and
 * contained so callers (finalizeDispatch) keep their exact semantics.
 *
 * @param {Object} params
 * @param {string} params.bookId
 * @param {string} params.chapterId
 * @param {string} params.sceneId
 * @param {'success'|'failure'|'cancelled'} params.outcome dispatch-internal outcome
 * @param {string|null} [params.jobId] Job Protocol v2 job id, when known
 * @param {string|null} [params.dispatchId]
 * @param {string|null} [params.stage]
 * @param {string|null} [params.error] reason string
 * @param {Object} [params.metadata]
 * @returns {Promise<{delivered: boolean, reason?: string}>}
 */
async function emitRuntimeResult(params = {}) {
    const { bookId, chapterId, sceneId, outcome, jobId = null, dispatchId = null, stage = null, error = null, metadata = {} } = params;

    const status = statusFromOutcome(outcome);
    if (!status) {
        warn(`emit skipped: unknown outcome '${outcome}' (${bookId}/${chapterId}/${sceneId})`);
        return { delivered: false, reason: 'unknown_outcome' };
    }
    if (!consumer) {
        // Composition root has not registered a consumer — legal state
        // (tests, tooling). Not an error.
        return { delivered: false, reason: 'no_consumer' };
    }

    let result;
    try {
        result = createRuntimeResult({
            bookId,
            chapterId,
            sceneId,
            jobId,
            dispatchId,
            stage,
            status,
            error,
            metadata,
        });
    } catch (contractErr) {
        warn(`emit skipped: invalid result for ${bookId}/${chapterId}/${sceneId}: ${contractErr.message}`);
        return { delivered: false, reason: 'invalid_result' };
    }

    try {
        await consumer(result);
    } catch (consumerErr) {
        // Contained: a failing consumer must never break dispatch finalization.
        warn(`consumer failed for ${bookId}/${chapterId}/${sceneId} ${status}: ${consumerErr.message}`);
        return { delivered: false, reason: 'consumer_error' };
    }

    log(`${status}: ${bookId}/${chapterId}/${sceneId}${stage ? ':' + stage : ''} dispatch=${dispatchId ? dispatchId.slice(0, 24) + '...' : 'n/a'}`);
    return { delivered: true };
}

module.exports = {
    setConsumer,
    resetConsumer,
    emitRuntimeResult,
};
