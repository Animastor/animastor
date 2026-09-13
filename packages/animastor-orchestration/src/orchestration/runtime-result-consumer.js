// ======================================================
// Runtime Result Consumer — Phase 5 seam (consumer side)
// ======================================================
// Orchestration-side adapter for the Runtime Result Contract.
// Implemented in orchestration, injected into runtime's emitter from the
// composition root (backend.cjs) — runtime never imports this module
// statically (the dependency flows through the injected callback).
//
// Direction after Phase 5:
//   orchestration ▶ runtime ▶ Runtime Result Contract ▶ this consumer
//
// Phase 5 scope: the consumer OBSERVES dispatch finalizations (completed /
// failed / cancelled). Semantic reactions (state writes, re-dispatch policy)
// stay with the existing flows (task-handler → completeStage/failStage,
// reconciliation) — migrating them here is future work, see
// docs/architecture/PHASE_5_ORCHESTRATION_RUNTIME.md §7.
//
// Zero relative imports: this module must stay a leaf so that wiring it in
// cannot create a new architectural cycle (Phase 5 T8).

'use strict';

const LOG_PREFIX = '[RUNTIME-RESULT-CONSUMER]';

/**
 * @param {Object} [options]
 * @param {(msg: string) => void} [options.log] injectable logger (tests)
 * @returns {(result: object) => Promise<void>} consumer for the runtime result emitter
 */
function createRuntimeResultConsumer(options = {}) {
    const log = typeof options.log === 'function'
        ? options.log
        : (msg) => console.log(`${LOG_PREFIX} ${msg}`);

    return async function handleRuntimeResult(result) {
        if (!result || typeof result !== 'object') {
            log('received non-object runtime result — ignoring');
            return;
        }

        const where = `${result.bookId}/${result.chapterId}/${result.sceneId}`;
        const stage = result.stage ? `:${result.stage}` : '';
        const id = result.dispatchId
            ? `dispatch=${result.dispatchId.slice(0, 24)}...`
            : (result.jobId ? `job=${result.jobId}` : 'no-id');
        const cause = result.error ? ` reason=${result.error}` : '';

        log(`${result.status} ${where}${stage} ${id}${cause}`);
    };
}

module.exports = {
    createRuntimeResultConsumer,
};
