// ======================================================
// Canonical Book Model — facade (Phase 4)
// ======================================================
// Single stable entry point for accessing a book, regardless of the
// internal loader implementation:
//
//   bookModel.loadBook(bookId, { mode: 'full' }) — canonical bundle representation
//   bookModel.loadBook(bookId, { mode: 'lazy' }) — lazy representation (canonical-first, draft fallback)
//   bookModel.getBookIdentity(bookId)            — identity read without loading content
//   bookModel.getBookManifest(bookId)            — manifest.json read without loading content
//
// ── Canonical boundaries ─────────────────────────────────────────────────
// The Book Model covers ONLY canonical book content. Everything else is
// explicitly out of scope and owned by other layers:
//
//   Canonical (this facade reads/writes it via the book module):
//     - Book bundle / VBook content on disk: manifest.json, book.json,
//       bible.json, locations.json, voices.json, behavior.json,
//       characters.json, chapters/*.json (chapters, scenes, assets
//       references and other canonical book data).
//
//   Identity / ownership (PostgreSQL — primary, NOT part of the model):
//     - book identity as an owned resource, ownership, workspace relation,
//       source relation. Managed by storage/postgres repositories.
//
//   Derived (PostgreSQL — rebuildable, NOT canonical):
//     - search/content indexes, scenes rows, asset states, generation
//       tasks, snapshots — derived representations of canonical content.
//
//   Runtime / ephemeral (Redis — NEVER part of the Book Model):
//     - active audio/image/video, queues, dispatch leases, chunk caches,
//       temporary and runtime execution state. Not canonical, not loaded
//       or returned by this facade.
//
// ── Contract ─────────────────────────────────────────────────────────────
//   loadBook(bookId, { mode })
//     - 'full': canonical/full representation from the disk bundle
//       (book.loadBook). What is canonically on disk; null when absent.
//     - 'lazy': lazy representation that does not require a full canonical
//       load: canonical bundle when it exists, otherwise the draft/import
//       state (loadDraftBook). This is the unified semantics previously
//       inlined by consumers as
//       `book.loadBook(bookId) || lazyBook.loadDraftBook(bookId)`.
//     - Both modes use the SAME bookId and the SAME identity semantics:
//       identity = manifest.book_id from the one canonical manifest.json.
//     - Errors: BookModelError with a stable `code` for invalid input
//       (INVALID_BOOK_ID, INVALID_MODE); `null` when the book does not
//       exist; loader-internal failures resolve to null (never throw),
//       matching the historical behavior of both loaders.

const fs = require('fs');

const bookCore = require('./index');
const lazyBook = require('./lazy-book');
const { getBookDir, getManifestPath } = require('./lazy-book/paths');

const MODE_FULL = 'full';
const MODE_LAZY = 'lazy';

class BookModelError extends Error {
    /**
     * @param {string} code - stable machine-readable code (INVALID_BOOK_ID | INVALID_MODE)
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.name = 'BookModelError';
        this.code = code;
    }
}

function assertBookId(bookId) {
    if (typeof bookId !== 'string' || bookId.trim() === '') {
        throw new BookModelError('INVALID_BOOK_ID', 'bookId must be a non-empty string');
    }
}

function assertMode(mode) {
    if (mode !== MODE_FULL && mode !== MODE_LAZY) {
        throw new BookModelError('INVALID_MODE', `mode must be '${MODE_FULL}' or '${MODE_LAZY}'`);
    }
}

// Canonical/full representation: the disk bundle as-is (what is canonically
// on disk). Returns null when the book is absent — same as book.loadBook.
function loadFull(bookId) {
    return bookCore.loadBook(bookId);
}

// Lazy representation: does not require a full canonical load. Canonical
// bundle first; draft/import state as fallback (in-progress books). Errors
// from the canonical load fall through to the draft path — identical to the
// historical consumer-side fallback chain this facade replaces.
function loadLazy(bookId) {
    let canonical = null;
    try {
        canonical = bookCore.loadBook(bookId);
    } catch (_) {
        canonical = null;
    }
    if (canonical) return canonical;
    return lazyBook.loadDraftBook(bookId);
}

/**
 * Unified book loader — the single stable Book Model contract.
 * @param {string} bookId - canonical book id
 * @param {{ mode?: 'full'|'lazy' }} [options] - defaults to { mode: 'full' }
 * @returns {Object|null} book representation, or null when not found
 * @throws {BookModelError} INVALID_BOOK_ID / INVALID_MODE
 */
function loadBook(bookId, options = {}) {
    assertBookId(bookId);
    const mode = options.mode === undefined ? MODE_FULL : options.mode;
    assertMode(mode);
    return mode === MODE_LAZY ? loadLazy(bookId) : loadFull(bookId);
}

/**
 * Read only the book identity without loading any content.
 * Identity semantics: the requested bookId is resolved against the one
 * canonical manifest.json — manifest.book_id is the canonical identity for
 * both full and lazy modes.
 * @param {string} bookId
 * @returns {Object|null} { bookId, canonicalBookId, vbookVersion, state } or null when manifest is absent/invalid
 * @throws {BookModelError} INVALID_BOOK_ID
 */
function getBookIdentity(bookId) {
    assertBookId(bookId);
    const manifest = getBookManifest(bookId);
    if (!manifest) return null;
    return {
        bookId,
        canonicalBookId: manifest.book_id,
        vbookVersion: manifest.vbook_version ?? null,
        state: manifest.state ?? null,
    };
}

/**
 * Read only manifest.json — the canonical identity/manifest source shared by
 * full and lazy modes. No chapters, bible or other content is loaded.
 * @param {string} bookId
 * @returns {Object|null} parsed manifest, or null when absent/invalid
 * @throws {BookModelError} INVALID_BOOK_ID
 */
function getBookManifest(bookId) {
    assertBookId(bookId);
    const manifestPath = getManifestPath(getBookDir(bookId));
    if (!fs.existsSync(manifestPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (_) {
        return null;
    }
}

module.exports = {
    MODE_FULL,
    MODE_LAZY,
    BookModelError,
    loadBook,
    getBookIdentity,
    getBookManifest,
};
