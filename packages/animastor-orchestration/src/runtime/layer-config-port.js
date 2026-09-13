// ======================================================
// O-10 PORT: LayerConfigPort — runtime/orchestration
// per-book layer-config contract
// ======================================================
// The runtime and orchestration tiers must not know the layer-config host
// service. The Redis key grammar (`animastor:layer-config:*`), the
// normalize/clamp pipeline, the durable book.json copy (Кирпич №2) and
// the fs scanning the service performs stay HOST-side
// (backend/src/services/layer-config.js); the tiers consume the
// per-book layer-config operations they actually use ONLY through this
// port, wired by the composition root (backend.cjs) at startup.
//
//   runtime/** + orchestration/**        (tier consumers)
//       ↓ consume layer-config ops through
//   runtime/layer-config-port.js         ← THIS PORT (tier-owned contract)
//       ↑ wired by the host
//   storage/layer-config-adapter         (host service adapter)
//
// This is the O-2..O-9 port convention (runtime/persistence-port.js,
// runtime/scene-data-port.js, runtime/placeholder-audio-port.js,
// runtime/progress-events-port.js, runtime/audio-fsm-port.js,
// runtime/video-fsm-port.js, runtime/hub-cancel-port.js): a zero-require
// contract module, a fail-fast call-time resolver, one set/wired/reset
// surface. No Redis key, no fs path, no BOOKS_DIR, no normalize/clamp
// rules and no "future ops" cross the boundary — the contract below is
// EXACTLY the set of operations the two tiers use today (measured at
// O-10 reconnaissance, §32.27):
//
//   get               — read the normalized per-book layer config
//                       (scene-orchestrator executeVideoDispatch
//                       per-type timeout leg; reconciliation-engine
//                       rebuildWorkList enabled-layers read)
//   restoreFromBooks  — heal missing Redis keys from the durable book.json
//                       copy (reconciliation-engine PHASE C6)
//
// The tier-local RAW Redis reads of `animastor:layer-config:*`
// (reconciliation-engine video-stall threshold, scene-window
// isWindowComplete/isSceneWindowDone, runtime-scheduler getLayerConfig)
// are NOT part of this port: they read the key in place with their own
// bespoke fallback semantics (partial-parse, per-field defaults) that a
// normalize() call would change — moving them is its own measured
// decision, not a rider on this seam. The raw Redis channel itself is
// not a host-service edge (redis is an injected parameter).
//
// Deliberately NOT in the port: set/persistToBook (routes/import
// workflow), getChunkSize (routes + services/agent consumers),
// SCOPES/ANALYSIS_MODES/DEFAULTS vocabulary (routes/services constants),
// key/KEY_PREFIX grammar, normalize (host-internal), and any CRUD "for
// later". The host adapter owns every Redis read, the durable book.json
// scan and every clamp rule.
//
// Optional-load/error semantics are the CALLER's concern, preserved
// exactly through the port: the reconciliation PHASE C6 leg keeps its
// pre-O-10 `try { … } catch (err) { warn; summary.errors }` wrapper with
// the missing-module degrade (a require failure of the host service
// previously left `layerConfig = null` and skipped the phase silently —
// the adapter's lazy call-time resolver throws at the same point the
// pre-O-10 require did, and the caller's catch handles it identically);
// the scene-orchestrator timeout leg keeps its `try { … } catch (_) {}`
// tolerance; the rebuildWorkList read stays a plain mandatory await.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.27 (O-10)
// ======================================================

const OPS = [
    'get',
    'restoreFromBooks',
];

let impl = null;

/**
 * Wire the host layer-config adapter. Called once by the composition root
 * (backend.cjs) BEFORE any runtime/orchestration layer-config consumer
 * runs. The adapter must expose every op in OPS as a function; lazy
 * resolution of the host implementation happens at CALL time (the
 * O-2..O-9 adapter discipline), so wiring never forces a
 * services/layer-config load.
 * @param {object} adapter — flat map with every op in OPS as a function.
 */
function setLayerConfigPort(adapter) {
    if (!adapter) {
        throw new Error('layer-config-port: adapter is required');
    }
    for (const op of OPS) {
        if (typeof adapter[op] !== 'function') {
            throw new Error(`layer-config-port: adapter must implement ${op}()`);
        }
    }
    impl = adapter;
}

/** Resolve the port at CALL time — fail-fast when unwired. */
function layerConfig() {
    if (!impl) {
        throw new Error(
            'layer-config-port: not wired — the composition root must call ' +
            'setLayerConfigPort(adapter) (storage/layer-config-adapter) ' +
            'before runtime/orchestration layer-config consumers run (O-10)'
        );
    }
    return impl;
}

/**
 * Shorthand op resolver: `layerConfigOp('get')(...)`.
 * Fails fast when the port or the single op is missing — callers that
 * tolerate failure keep their own try/catch around the call (the
 * caller-owned optional-load discipline of O-7/O-9).
 * @param {string} op — op name from OPS
 */
function layerConfigOp(op) {
    const fn = impl?.[op];
    if (typeof fn !== 'function') {
        throw new Error(`layer-config-port: op '${op}' is not wired (O-10)`);
    }
    return fn;
}

function isLayerConfigPortWired() {
    return impl !== null;
}

/** Test hygiene: drop the wiring (mocha hooks). */
function _resetLayerConfigPort() {
    impl = null;
}

module.exports = {
    OPS,
    setLayerConfigPort,
    layerConfig,
    layerConfigOp,
    isLayerConfigPortWired,
    _resetLayerConfigPort,
};
