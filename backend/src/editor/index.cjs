// ======================================================
// Editor boundary — facade over the Canonical Book Model (Phase 6)
// ======================================================
// The Editor (book content editing routes) must work with the canonical
// book model through this seam only, with the three edit phases explicit:
//
//   1. READ    — read(bookId, { mode }): loads the model via the Canonical
//                Book Model facade ('full' by default; 'lazy' for draft/
//                in-progress books). null when the book does not exist.
//   2. MODIFY  — NOT a facade operation: route handlers transform the plain
//                model object they received from read(). The model is a
//                plain JSON-shaped structure; modification stays explicit
//                at the call site instead of being hidden in the seam.
//   3. COMMIT  — commit(book, files): persists the model through the ONE
//                canonical bundle writer (book.saveBookBundle), injected at
//                the composition root. No parallel storage path, no new
//                format, no new DB.
//
// ── Allowed dependencies ────────────────────────────────────────────────
//   - Canonical Book Model facade (../book/book-model.cjs)
//   - node builtins
// Everything else (orchestration, runtime, Redis, PG/storage, providers,
// services) is FORBIDDEN — enforced by
// tests/architecture/phase6-editor-player.test.js.

const bookModel = require('../book/book-model.cjs');

/**
 * Create the Editor model facade.
 * @param {{ bookModel?: object, persistBook: (book: object, files?: object|null) => object }} deps
 *        persistBook — the canonical bundle writer (book.saveBookBundle).
 */
function createEditorModel(deps = {}) {
    const model = deps.bookModel || bookModel;
    const persist = deps.persistBook;
    if (typeof persist !== 'function') {
        throw new Error('createEditorModel requires persistBook (the canonical bundle writer)');
    }

    return {
        read(bookId, options) {
            return model.loadBook(bookId, options);
        },
        commit(book, files = null) {
            return persist(book, files);
        },
    };
}

module.exports = { createEditorModel };
