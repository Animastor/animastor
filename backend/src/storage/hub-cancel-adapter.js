// ======================================================
// HOST ADAPTER: HubCancelAdapter — O-9 HubCancelPort impl
// ======================================================
// Host-side implementation of the O-9 HubCancelPort
// (runtime/hub-cancel-port.js). Owns the only hub-HTTP cleanup channel the
// runtime/orchestration tiers may use: dispatch-engine.clearHubDispatches
// (hub URL/API-key resolution from runtime-config, the DELETE
// /queue/clear endpoint shape, per-id retry/warn behavior, the
// { requested, cleared, failed } accounting).
//
//   runtime/hub-cancel-port            (tier-owned contract)
//       ↑ wired by backend.cjs (composition root)
//   storage/hub-cancel-adapter         ← THIS FILE (host impl)
//       → runtime/dispatch-engine.clearHubDispatches (the canonical
//         auth + error-handling contract every caller uses)
//
// Lazy call-time resolver — never captures the module instance at load
// time. This keeps require.cache-based test stubbing working exactly as
// before (the O-2..O-8 adapter discipline): a harness that stubs
// ../src/runtime/dispatch-engine and then (re)requires a tier consumer
// gets the stub through this adapter.
//
// Behavior contract: a 1:1 delegation to the pre-O-9 call — identical
// module, identical arguments (dispatchIds, options), identical return
// values ({ requested, cleared, failed }) and identical error semantics
// (per-id best-effort; a single id failing HTTP/network counts into
// `failed` with a warn, never throws the loop). No hub behavior changed;
// dispatch-engine's public API is not extended.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.26 (O-9)
// ======================================================

// Lazy call-time resolver — the canonical dispatch cancellation channel
// (`require.resolve('../src/runtime/dispatch-engine')` — the module every
// pre-O-9 hub-cleanup harness stubs, incl. the gpu-hub-cleanup suite).
const dispatchEngine = () => require('../runtime/dispatch-engine');

function clearHubDispatches(dispatchIds, options) {
    return dispatchEngine().clearHubDispatches(dispatchIds, options);
}

module.exports = {
    clearHubDispatches,
};
