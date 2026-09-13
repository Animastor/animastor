// ======================================================
// O-3 PORT: SceneDataPort — runtime/orchestration scene-content contract
// ======================================================
// The runtime and orchestration tiers must not know the Book Model facade.
// Every book-module require — backend/src/book → @animastor/vbook-runtime —
// stays HOST-side; the tiers consume scene content ONLY through this port,
// wired by the composition root (backend.cjs) at startup.
//
//   runtime/** + orchestration/**        (tier consumers)
//       ↓ consume scene reads through
//   runtime/scene-data-port.js           ← THIS PORT (tier-owned contract)
//       ↑ wired by the host
//   storage/scene-data-adapter.js        (host VBook adapter)
//
// This is the O-2 PersistencePort convention (runtime/persistence-port.js):
// a zero-require contract module, a fail-fast call-time resolver, one
// set/wired/reset surface. No Book Model surface, no lazy-book internals,
// no VBook deep specifiers and no "future reads" cross the boundary — the
// contract below is EXACTLY the set of scene-data operations the two tiers
// use today (measured §32.11, O-3 reconnaissance):
//
//   loadBook            — load the canonical book.json bundle by bookId
//                         (dispatch fallback ×3 in scene-orchestrator,
//                         auto-slide in scene-callbacks, window-complete
//                         + trySlideWindowOnComplete in scene-window,
//                         scheduler tick cache-miss leg, reconciliation
//                         resolveBookBuildId + rebuildWorkList)
//   findSceneRuntimeData — resolve the scene payload inside a loaded book
//                         (scene-orchestrator per-stage dispatch legs ×3)
//   collectScenes       — enumerate a book's scenes in canonical order
//                         (scene-window isWindowComplete + trySlide, 
//                         reconciliation rebuildWorkList)
//
// No SQL, no VBook implementation knowledge. The `loadedBook` argument of
// findSceneRuntimeData/collectScenes stays the same opaque loaded-book value
// the tiers already pass around (injected by the caller or produced by
// loadBook) — the tiers never construct one themselves.
//
// Deliberately NOT in the port: the rest of the VBook facade (save/delete/
// import/sessions), lazy-book deep modules, book-model internals, and CRUD
// "for later". The host adapter owns the VBook wiring (booksRoot config,
// structure detector).
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.11 (O-3 DONE)
// ======================================================

const OPS = [
    'loadBook',
    'findSceneRuntimeData',
    'collectScenes',
];

let impl = null;

/**
 * Wire the host scene-data adapter. Called once by the composition root
 * (backend.cjs) BEFORE any runtime/orchestration scene-data consumer runs.
 * @param {object} adapter — flat map with every op in OPS as a function.
 */
function setSceneDataPort(adapter) {
    if (!adapter) {
        throw new Error('scene-data-port: adapter is required');
    }
    for (const op of OPS) {
        if (typeof adapter[op] !== 'function') {
            throw new Error(`scene-data-port: adapter must implement ${op}()`);
        }
    }
    impl = adapter;
}

/** Resolve the port at CALL time — fail-fast when unwired. */
function sceneData() {
    if (!impl) {
        throw new Error(
            'scene-data-port: not wired — the composition root must call ' +
            'setSceneDataPort(adapter) (storage/scene-data-adapter) ' +
            'before runtime/orchestration scene-data consumers run (O-3)'
        );
    }
    return impl;
}

/**
 * Shorthand op resolver: `sceneData('loadBook')(...)`.
 * Fails fast when the port or the single op is missing — a missing read
 * must never degrade into a silent undefined.
 * @param {string} op — op name from OPS
 */
function sceneDataOp(op) {
    const fn = impl?.[op];
    if (typeof fn !== 'function') {
        throw new Error(`scene-data-port: op '${op}' is not wired (O-3)`);
    }
    return fn;
}

function isSceneDataPortWired() {
    return impl !== null;
}

/** Test hygiene: drop the wiring (mocha hooks). */
function _resetSceneDataPort() {
    impl = null;
}

module.exports = {
    OPS,
    setSceneDataPort,
    sceneData,
    sceneDataOp,
    isSceneDataPortWired,
    _resetSceneDataPort,
};
