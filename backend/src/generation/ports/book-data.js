// ======================================================
// S-6 PORT: BookDataPort — Generation's minimal Book-model reads
// ======================================================
// Generation must not know the Book/VBook implementation. The only
// Generation-contour module that reads the Book Model is the video
// workflow builder (workflows/video/video-workflows.js) — previously via
// direct `../../book` + `../../book/lazy-book/appearance` requires (the
// frozen R4 violation). It consumes THIS port; the host binds the two
// operations from the Book Model at the composition root.
//
//   workflows/video/video-workflows.js  (Generation video pipeline)
//       ↓ reads scene data through
//   generation/ports/book-data          ← THIS PORT (Generation-owned)
//       ↑ wired by the host
//   Book Model (book facade → @animastor/vbook-runtime)
//
// CONTRACT (frozen — exactly the two operations Generation actually uses;
// NOT a universal BookRepository, NOT the Book domain):
//   collectSceneUnits(scene) → unit[]
//     - scene: a loaded book scene object (domain data passed by the
//       caller — payload, not a host handle); returns the scene's IU units
//     - the adapter returns []-shaped results for unitless scenes exactly
//       as the facade did (callers guard on empty)
//   tokensToString(tokens) → string
//     - renders video passport tokens (array | legacy string) to the
//       "token one, token two." prompt line; pure renderer
//
// Book ownership is unchanged: the Book Model stays Book/VBook-owned;
// Generation receives scene DATA, not the module.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §28

const OPERATIONS = ['collectSceneUnits', 'tokensToString'];

let impl = null;

/**
 * Wire the host book-data adapter. Called once by the composition root
 * (backend.cjs) before any video workflow build can run.
 * @param {{ collectSceneUnits: Function, tokensToString: Function }} adapter
 */
function setBookData(adapter) {
    if (!adapter) {
        throw new Error('book-data: adapter is required');
    }
    for (const op of OPERATIONS) {
        if (typeof adapter[op] !== 'function') {
            throw new Error(`book-data: adapter must implement ${op}()`);
        }
    }
    impl = adapter;
}

/** Resolve the port at CALL time — fail-fast when unwired. */
function bookData() {
    if (!impl) {
        throw new Error(
            'book-data: not wired — the composition root must call ' +
            'setBookData({ collectSceneUnits, tokensToString }) before ' +
            'video workflow builds run (S-6)'
        );
    }
    return impl;
}

/**
 * Collect the IU units of a scene (delegating, fail-fast).
 * @param {object} scene — loaded book scene object (domain data)
 */
function collectSceneUnits(scene) {
    return bookData().collectSceneUnits(scene);
}

/**
 * Render video passport tokens to a prompt string (delegating, fail-fast).
 * @param {string[]|string|null} tokens
 */
function tokensToString(tokens) {
    return bookData().tokensToString(tokens);
}

function isBookDataWired() {
    return impl !== null;
}

/** Test hygiene: drop the wiring (mocha hooks). */
function _resetBookData() {
    impl = null;
}

module.exports = {
    OPERATIONS,
    setBookData,
    collectSceneUnits,
    tokensToString,
    isBookDataWired,
    _resetBookData,
};
