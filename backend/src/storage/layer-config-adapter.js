// ======================================================
// HOST ADAPTER: LayerConfigAdapter — O-10 LayerConfigPort impl
// ======================================================
// Host-side implementation of the O-10 LayerConfigPort
// (runtime/layer-config-port.js). Owns the only layer-config service
// channel the runtime/orchestration tiers may use: the per-book Redis
// read + normalize/clamp pipeline and the durable book.json recovery
// scan (services/layer-config get / restoreFromBooks).
//
//   runtime/layer-config-port         (tier-owned contract)
//       ↑ wired by backend.cjs (composition root)
//   storage/layer-config-adapter      ← THIS FILE (host impl)
//       → services/layer-config.get / restoreFromBooks
//
// Lazy call-time resolver — never captures the module instance at load
// time. This keeps require.cache-based test stubbing working exactly as
// before (the O-2..O-9 adapter discipline): a harness that stubs
// ../src/services/layer-config and then (re)requires a tier consumer
// gets the stub through this adapter (the worklist-rebuild purge-list
// convention pins services/layer-config.js as a purged module — the
// purge empties require.cache so the next call-time resolution reloads
// the real service, identical to the pre-O-10 lazy requires).
//
// Behavior contract: every method is a 1:1 delegation to the pre-O-10
// call — identical module, identical arguments, identical return values
// (including the normalized config shape and the restore count) and
// identical error semantics. No layer-config behavior changed; the
// service's public API is not extended.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.27 (O-10)
// ======================================================

// Lazy call-time resolver — the host service channel every pre-O-10
// harness stubs (`require.resolve('../src/services/layer-config')`).
const layerConfigService = () => require('../services/layer-config');

function get(redis, bookId) {
    return layerConfigService().get(redis, bookId);
}

function restoreFromBooks(redis) {
    return layerConfigService().restoreFromBooks(redis);
}

module.exports = {
    get,
    restoreFromBooks,
};
