// ======================================================
// S-6 PORT: DispatchTransport — Generation → GPU transport contract
// ======================================================
// Generation Core must not know the concrete gpu-dispatcher. The single
// Generation → GPU dispatch edge (generation/comfyui-provider.generate,
// the S-3 provider seam) consumes THIS port; the host implements it with
// runtime/gpu-dispatcher.sendUnified (Job Protocol v2 → GPU Hub POST /task),
// wired by the composition root (backend.cjs) at startup.
//
//   Generation media executor (audio / image / video / orchestrator)
//       ↓
//   generation/comfyui-provider  (semantic provider contract — S-3)
//       ↓
//   generation/ports/dispatch-transport   ← THIS PORT (Generation-owned)
//       ↑ wired by the host
//   runtime/gpu-dispatcher.sendUnified    (host adapter — Job Protocol v2)
//       ↓
//   GPU Hub / Worker (external packages)
//
// CONTRACT (frozen — result/error semantics preserved 1:1 with the former
// direct sendUnified call, S-3 payload preservation):
//   dispatch(taskSpec) → Promise<
//       { sent: true,  jobId: string, dispatchId: string }
//     | { sent: false, error: string }>
//   …or THROWS synchronously on invalid task specs (Invalid task
//   specification / Invalid job type / dispatch_id is required / invalid
//   job_id) — exactly the pre-port validation behavior.
//
// Deliberately OUT of the port (host-owned policy, stays in the adapter):
//   - workspace routing policy (PW-2/SH-2 resolvers live in gpu-dispatcher);
//   - per-type timeouts and retry/circuit semantics (registry/host engine);
//   - cancellation (lease/marker lifecycle + Hub queue clear are owned by
//     the dispatch engine — cancellation does not pass through this seam,
//     reconnaissance §9 residual).
//
// Job Protocol v2 is UNCHANGED: the taskSpec passes through verbatim.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §28

let impl = null;

/**
 * Wire the host dispatch adapter. Called once by the composition root
 * (backend.cjs) before any generation dispatch can run.
 * @param {{ dispatch: (taskSpec: object) => Promise<object> }} adapter
 */
function setDispatchTransport(adapter) {
    if (!adapter || typeof adapter.dispatch !== 'function') {
        throw new Error('dispatch-transport: adapter must implement dispatch(taskSpec)');
    }
    impl = adapter;
}

/**
 * Resolve the transport at CALL time. Fail-fast with a wiring instruction —
 * an unwired port must never degrade into a silent no-op (a lost GPU job
 * would strand the scene in GENERATING with no callback path).
 * @param {object} taskSpec — Job Protocol v2 task spec (passed through 1:1)
 */
function dispatch(taskSpec) {
    if (!impl || typeof impl.dispatch !== 'function') {
        throw new Error(
            'dispatch-transport: not wired — the composition root must call ' +
            'setDispatchTransport({ dispatch }) before generation dispatch runs (S-6)'
        );
    }
    return impl.dispatch(taskSpec);
}

function isDispatchTransportWired() {
    return !!(impl && typeof impl.dispatch === 'function');
}

/** Test hygiene: drop the wiring (mocha hooks). */
function _resetDispatchTransport() {
    impl = null;
}

module.exports = {
    setDispatchTransport,
    dispatch,
    isDispatchTransportWired,
    _resetDispatchTransport,
};
