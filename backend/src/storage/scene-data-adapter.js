// ======================================================
// HOST ADAPTER: SceneDataAdapter — O-3 SceneDataPort impl
// ======================================================
// Host-side implementation of the O-3 SceneDataPort
// (runtime/scene-data-port.js). Owns every concrete VBook detail the
// runtime/orchestration tiers must not know: the book facade shim
// (backend/src/book → @animastor/vbook-runtime) and its three read
// operations.
//
//   runtime/scene-data-port    (tier-owned contract)
//       ↑ wired by backend.cjs (composition root)
//   storage/scene-data-adapter ← THIS FILE (host impl)
//
// Lazy call-time resolvers — never capture the module instance at load
// time. This keeps require.cache-based test stubbing working exactly as
// before: a harness that stubs `../src/book` and then requires the tier
// consumer gets the stub through this adapter, and a module reload after
// require.cache manipulation re-resolves correctly (orchestration-
// stabilization, dispatch-meta-lease-lifecycle, image-orphan-generating-
// repair harness conventions).
//
// Behavior contract: every method is a 1:1 delegation to the pre-O-3 call —
// identical module, identical arguments, identical return values (including
// `null` for a missing book.json) and errors. No VBook behavior changed.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.11
// ======================================================

// Lazy call-time resolver — the host book shim re-exports the VBook
// runtime package; the shim path is the channel every pre-O-3 harness
// stubs (`require.resolve('../src/book')`).
const bookFacade = () => require('../book');

function loadBook(bookId) {
    return bookFacade().loadBook(bookId);
}

function findSceneRuntimeData(loadedBook, chapterId, sceneId) {
    return bookFacade().findSceneRuntimeData(loadedBook, chapterId, sceneId);
}

function collectScenes(loadedBook) {
    return bookFacade().collectScenes(loadedBook);
}

module.exports = {
    loadBook,
    findSceneRuntimeData,
    collectScenes,
};
