// ======================================================
// O-9 PORT: HubCancelPort — runtime/orchestration
// hub-queue cleanup contract
// ======================================================
// The runtime and orchestration tiers must not own GPU Hub HTTP cleanup.
// The hub URL/API-key resolution, the DELETE /queue/clear endpoint shape,
// per-dispatch retry/warn behavior and the { requested, cleared, failed }
// result accounting stay HOST-side (backend/src/runtime/dispatch-engine.js
// clearHubDispatches — the same auth and error-handling contract every
// caller uses); the tiers purge cancelled dispatches from the hub queue
// ONLY through this port, wired by the composition root (backend.cjs) at
// startup.
//
//   runtime/** + orchestration/**        (tier consumers)
//       ↓ consume hub-cancel ops through
//   runtime/hub-cancel-port.js           ← THIS PORT (tier-owned contract)
//       ↑ wired by the host
//   storage/hub-cancel-adapter            (host adapter → dispatch-engine)
//
// This is the O-2/O-3/O-4/O-5/O-7/O-8 port convention (runtime/persistence-
// port.js, runtime/scene-data-port.js, runtime/placeholder-audio-port.js,
// runtime/progress-events-port.js, runtime/audio-fsm-port.js,
// runtime/video-fsm-port.js): a zero-require contract module, a fail-fast
// call-time resolver, one set/wired/reset surface. No hub URL, no API key,
// no fetch, no HTTP method/endpoint knowledge and no "future ops" cross
// the boundary — the contract below is EXACTLY the set of operations the
// two tiers use today (measured at O-9 reconnaissance, §32.26):
//
//   clearHubDispatches  — best-effort removal of the queue/running copies
//                        a cancelled dispatch still owns on the GPU Hub
//                        (orchestrator resetScenes cancel leg,
//                        reconciliation RELEASE_STALE_LEASE recovery leg).
//                        Returns { requested, cleared, failed }; hub
//                        unavailability is non-fatal per-id (warn + count),
//                        never throws for a single failed id.
//
// Optional-load/error semantics are the CALLER's concern, preserved
// exactly through the port: the reconciliation RELEASE_STALE_LEASE leg
// keeps its pre-O-9 `try { … } catch (hubErr) { warn }` best-effort
// wrapper around the port call (hub cleanup failure must not block state
// recovery); the orchestrator resetScenes leg keeps its plain await.
//
// Deliberately NOT in the port: lease cancellation itself (cancelActive-
// Dispatch / clearLeasesForScenes / clearLeasesForBookByStage / clearAll-
// LeasesForBook stay direct dispatch-engine calls — they are Redis-key
// domain operations, not hub HTTP), job dispatch (the S-3/S-6 Dispatch-
// Transport seam owns it), any combined "cancel everything" surface and
// any CRUD "for later".
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.26 (O-9)
// ======================================================

const OPS = [
    'clearHubDispatches',
];

let impl = null;

/**
 * Wire the host hub-cancel adapter. Called once by the composition root
 * (backend.cjs) BEFORE any runtime/orchestration hub-cancel consumer runs.
 * The adapter must expose every op in OPS as a function; lazy resolution
 * of the host implementation happens at CALL time (the O-2..O-8 adapter
 * discipline), so wiring never forces a dispatch-engine load.
 * @param {object} adapter — map with every op in OPS as a function
 */
function setHubCancelPort(adapter) {
    if (!adapter) {
        throw new Error('hub-cancel-port: adapter is required');
    }
    for (const op of OPS) {
        if (typeof adapter[op] !== 'function') {
            throw new Error(`hub-cancel-port: adapter must implement ${op}()`);
        }
    }
    impl = adapter;
}

/** Resolve the port at CALL time — fail-fast when unwired. */
function hubCancel() {
    if (!impl) {
        throw new Error(
            'hub-cancel-port: not wired — the composition root must call ' +
            'setHubCancelPort(adapter) (storage/hub-cancel-adapter) ' +
            'before runtime/orchestration hub-cancel consumers run (O-9)'
        );
    }
    return impl;
}

/**
 * Shorthand op resolver: `hubCancelOp('clearHubDispatches')(...)`.
 * Fails fast when the port or the single op is missing — a missing hub
 * cleanup silently degrading into a no-op would accumulate duplicate job
 * copies a worker would later drain (audit c8b79f6).
 * @param {string} op — op name from OPS
 */
function hubCancelOp(op) {
    const fn = impl?.[op];
    if (typeof fn !== 'function') {
        throw new Error(`hub-cancel-port: op '${op}' is not wired (O-9)`);
    }
    return fn;
}

function isHubCancelPortWired() {
    return impl !== null;
}

/** Test hygiene: drop the wiring (mocha hooks). */
function _resetHubCancelPort() {
    impl = null;
}

module.exports = {
    OPS,
    setHubCancelPort,
    hubCancel,
    hubCancelOp,
    isHubCancelPortWired,
    _resetHubCancelPort,
};
