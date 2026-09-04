// ======================================================
// Player boundary — facade over the Canonical Book Model (Phase 6)
// ======================================================
// The Player (playback media serving + playback data reads) must reach book
// content ONLY through this seam: Player → Player Model → Canonical Book
// Model. It must never load books directly from backend implementation
// details (raw book loaders, PostgreSQL, Redis, runtime/orchestration
// internals, provider implementations).
//
// ── Allowed dependencies ────────────────────────────────────────────────
//   - Canonical Book Model facade (../book/book-model.cjs)
//   - node builtins
// Everything else (orchestration, runtime, Redis, PG/storage, providers,
// services) is FORBIDDEN — enforced by
// tests/architecture/phase6-editor-player.test.js.
//
// ── Contract (read-only) ────────────────────────────────────────────────
//   loadBook(bookId, { mode })  — playback book content; 'full' (canonical
//                                 bundle) by default, 'lazy' (canonical-
//                                 first, draft fallback) for in-progress
//                                 books. Delegates 1:1 to the Book Model.
//   getBookIdentity(bookId)     — identity-only read (manifest), no content.
//   getBookManifest(bookId)     — manifest.json only.
//
// The Player is read-only by design: it never mutates the canonical model
// (that is the Editor boundary) and never writes runtime state (that is the
// runtime/orchestration layer).

const bookModel = require('../book/book-model.cjs');

/**
 * Create the Player model facade.
 * @param {{ bookModel?: object }} deps - Book Model injection (defaults to the canonical facade)
 */
function createPlayerModel(deps = {}) {
    const model = deps.bookModel || bookModel;

    return {
        loadBook(bookId, options) {
            return model.loadBook(bookId, options);
        },
        getBookIdentity(bookId) {
            return model.getBookIdentity(bookId);
        },
        getBookManifest(bookId) {
            return model.getBookManifest(bookId);
        },
    };
}

module.exports = { createPlayerModel };
