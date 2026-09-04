// ======================================================
// PHASE 4 — Canonical Book Model (architecture tests)
// ======================================================
// Guards the unified Book Model facade contract:
//   bookModel.loadBook(bookId, { mode: 'full' | 'lazy' })
//   bookModel.getBookIdentity(bookId)
//   bookModel.getBookManifest(bookId)
// and the book deletion/purge boundary (bookDeletion.deleteBook).
//
// T1 — unified loader exists with a stable contract
// T2 — lazy mode uses the lazy path and does not require a full load
// T3 — full and lazy share the same Book identity semantics
// T4 — Redis/runtime state is NOT part of canonical book data
// T5 — consumers do not pick between independent book loaders
// T6 — route/controller does not implement the deletion cascade; deletion
//      sends the cancellation signal before any canonical reset (cancel < reset)
// T7 — no new Book Model → Player/Editor/Generation/Provider Gateway deps
//
// Static checks follow the Phase 1 helpers (pure source scan, CI-safe).
// Behavioral checks override config.BOOKS_DIR with a temp directory
// (same pattern as tests/ai-editor-mode.test.js).

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { readSource, rel, REPO_ROOT, BACKEND_SRC, listSourceFiles, requireSpecifiers, resolveSpecifier } = require('./helpers');

const config = require('../../src/config/runtime-config');
const bookModel = require('../../src/book/book-model.cjs');
const { createBookDeletion } = require('../../src/book/book-deletion.cjs');

const bookModelPath = path.join(BACKEND_SRC, 'book', 'book-model.cjs');
const bookDeletionPath = path.join(BACKEND_SRC, 'book', 'book-deletion.cjs');
const aiRoutesPath = path.join(BACKEND_SRC, 'routes', 'ai-routes.cjs');
const coreRoutesPath = path.join(BACKEND_SRC, 'routes', 'book', 'core-routes.cjs');

// ── Fixture helpers ──────────────────────────────────────────────────────
let tmpDir;
let ORIG_BOOKS_DIR;

function writeBookFile(bookId, relPath, content) {
    const full = path.join(config.BOOKS_DIR, bookId, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

// Canonical bundle: manifest.json + book.json + chapters per chapters_order.
function createCanonicalBook(bookId) {
    writeBookFile(bookId, 'manifest.json', JSON.stringify({
        vbook_version: '3.1',
        book_id: bookId,
        state: 'READY',
    }));
    writeBookFile(bookId, 'book.json', JSON.stringify({
        book_id: bookId,
        title: 'Full Book',
        language: 'en',
        structure: { has_prologue: false, chapters_order: ['ch-aaaa0001.json'] },
    }));
    writeBookFile(bookId, path.join('chapters', 'ch-aaaa0001.json'), JSON.stringify({
        chapter_id: 'ch-aaaa0001',
        chapter_title: 'Chapter One',
        scenes: [{ scene_id: 'sc-bbbb0001', type: 'narration' }],
    }));
}

// Draft-only book: manifest + book.json + source.txt, no canonical chapter set.
function createDraftBook(bookId) {
    writeBookFile(bookId, 'manifest.json', JSON.stringify({
        vbook_version: '3.1',
        book_id: bookId,
        state: 'RAW_IMPORTED',
    }));
    writeBookFile(bookId, 'book.json', JSON.stringify({
        book_id: bookId,
        title: 'Draft Book',
        language: null,
        structure: { has_prologue: false, chapters_order: [] },
    }));
    writeBookFile(bookId, 'source.txt', 'Some source text for the lazy pipeline.');
}

// Book whose canonical load FAILS (corrupt chapter in chapters_order) while
// the lazy/draft load still succeeds (draft loader skips bad chapter files).
function createCorruptCanonicalBook(bookId) {
    writeBookFile(bookId, 'manifest.json', JSON.stringify({
        vbook_version: '3.1',
        book_id: bookId,
        state: 'PARSING',
    }));
    writeBookFile(bookId, 'book.json', JSON.stringify({
        book_id: bookId,
        title: 'Broken Book',
        language: 'en',
        structure: { has_prologue: false, chapters_order: ['ch-bad.json'] },
    }));
    writeBookFile(bookId, path.join('chapters', 'ch-bad.json'), '{ not valid json');
    writeBookFile(bookId, 'source.txt', 'Recoverable source text.');
}

before(() => {
    ORIG_BOOKS_DIR = config.BOOKS_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-book-model-'));
    config.BOOKS_DIR = tmpDir;
});

after(() => {
    config.BOOKS_DIR = ORIG_BOOKS_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── T1 — Unified loader ──────────────────────────────────────────────────
describe('T1: unified loader loadBook(id, { mode })', () => {
    it('full mode returns the canonical/full representation', () => {
        const bookId = 'book-full-test';
        createCanonicalBook(bookId);

        const book = bookModel.loadBook(bookId, { mode: 'full' });
        expect(book, 'full load should find the canonical bundle').to.not.be.null;
        expect(book.manifest.book_id).to.equal(bookId);
        expect(book.book.title).to.equal('Full Book');
        expect(book.chapters).to.have.lengthOf(1);
        expect(book.chapters[0].chapter_id).to.equal('ch-aaaa0001');
    });

    it('facade exists with the stable loadBook(bookId, options) surface', () => {
        const src = readSource(bookModelPath);
        expect(src).to.match(/function loadBook\(bookId, options/);
        expect(src).to.match(/MODE_LAZY \? loadLazy/);
        expect(bookModel.loadBook).to.be.a('function');
        expect(bookModel.getBookIdentity).to.be.a('function');
        expect(bookModel.getBookManifest).to.be.a('function');
    });

    it('error contract: invalid input throws BookModelError with stable codes', () => {
        expect(() => bookModel.loadBook('')).to.throw(/bookId/);
        expect(() => bookModel.loadBook(null)).to.throw(/bookId/);
        try {
            bookModel.loadBook('x', { mode: 'fast' });
            expect.fail('should have thrown');
        } catch (e) {
            expect(e.code).to.equal('INVALID_MODE');
        }
        // Missing book is null, never a throw.
        expect(bookModel.loadBook('no-such-book-xyz', { mode: 'full' })).to.be.null;
        expect(bookModel.loadBook('no-such-book-xyz', { mode: 'lazy' })).to.be.null;
    });
});

// ── T2 — Lazy mode ───────────────────────────────────────────────────────
describe('T2: lazy mode uses the lazy path without a full load', () => {
    it('lazy mode falls back to the draft state when the canonical load fails', () => {
        const bookId = 'book-corrupt-test';
        createCorruptCanonicalBook(bookId);

        // Canonical path fails (corrupt chapter in chapters_order)…
        expect(bookModel.loadBook(bookId, { mode: 'full' })).to.be.null;
        // …lazy path still serves the book from the draft state.
        const lazy = bookModel.loadBook(bookId, { mode: 'lazy' });
        expect(lazy, 'lazy load must not require a clean full load').to.not.be.null;
        expect(lazy.manifest.book_id).to.equal(bookId);
        expect(lazy.sourceText).to.include('Recoverable source text');
    });

    it('lazy mode prefers the canonical bundle when it loads (canonical-first)', () => {
        const bookId = 'book-lazy-canonical-test';
        createCanonicalBook(bookId);
        const lazy = bookModel.loadBook(bookId, { mode: 'lazy' });
        expect(lazy).to.not.be.null;
        expect(lazy.chapters).to.have.lengthOf(1);
    });
});

// ── T3 — Identity consistency ────────────────────────────────────────────
describe('T3: full and lazy share the same identity semantics', () => {
    it('both modes resolve identity from the one canonical manifest', () => {
        const bookId = 'book-identity-test';
        createCanonicalBook(bookId);

        const full = bookModel.loadBook(bookId, { mode: 'full' });
        const lazy = bookModel.loadBook(bookId, { mode: 'lazy' });
        const identity = bookModel.getBookIdentity(bookId);
        const manifest = bookModel.getBookManifest(bookId);

        expect(identity).to.not.be.null;
        expect(identity.canonicalBookId).to.equal(bookId);
        expect(identity.state).to.equal('READY');
        expect(manifest.book_id).to.equal(bookId);
        expect(full.manifest.book_id).to.equal(bookId);
        expect(lazy.manifest.book_id).to.equal(bookId);
        // Same manifest object semantics for both modes.
        expect(full.manifest.book_id).to.equal(lazy.manifest.book_id);
    });

    it('getBookIdentity reads only the manifest (no content load) and is null when absent', () => {
        const bookId = 'book-identity-only-test';
        createDraftBook(bookId);
        const identity = bookModel.getBookIdentity(bookId);
        expect(identity.canonicalBookId).to.equal(bookId);
        expect(identity.state).to.equal('RAW_IMPORTED');
        expect(bookModel.getBookIdentity('no-such-book-xyz')).to.be.null;
        expect(bookModel.getBookManifest('no-such-book-xyz')).to.be.null;
    });
});

// ── T4 — Canonical boundary: no Redis/runtime state in the model ─────────
describe('T4: Book Model excludes Redis/runtime state', () => {
    it('book-model.cjs has no Redis/runtime-state dependencies or keys', () => {
        const src = readSource(bookModelPath);
        const specs = requireSpecifiers(src);
        for (const spec of specs) {
            expect(spec, `book-model must not depend on ${spec}`).to.not.match(/redis|ioredis|storage|runtime/i);
        }
        expect(src).to.not.match(/active-audio|active-image|active-video|runtime:/);
        // The boundary must be documented in the source itself.
        expect(src).to.match(/Runtime \/ ephemeral/);
        expect(src).to.match(/Redis/);
    });

    it('book-deletion owns runtime cleanup; the model layer stays canonical-only', () => {
        // Deletion boundary is where runtime-state cleanup belongs.
        const del = readSource(bookDeletionPath);
        expect(del).to.match(/animastor:runtime:active-audio/);
        expect(del).to.match(/cleanBookRedisKeys/);
    });
});

// ── T5 — Loader isolation ────────────────────────────────────────────────
describe('T5: consumers do not pick between independent book loaders', () => {
    it('AI/chat routes use the unified facade instead of the raw loader chain', () => {
        const ai = readSource(aiRoutesPath);
        expect(ai).to.match(/bookModel\.loadBook\(bookId,\s*\{\s*mode:\s*'lazy'\s*\}\)/);
        expect(ai).to.not.match(/book\.loadBook\([^)]*\)\s*\|\|\s*lazyBook\.loadDraftBook\(/);
    });

    it('no route file implements a canonical||draft loader fallback chain', () => {
        const routesDir = path.join(BACKEND_SRC, 'routes');
        for (const file of listSourceFiles(routesDir)) {
            const src = readSource(file);
            expect(src, `${rel(file)} must use bookModel.loadBook instead of a loader fallback chain`)
                .to.not.match(/book\.loadBook\([^)]*\)\s*\|\|\s*lazyBook\.loadDraftBook\(/);
        }
    });
});

// ── T6 — Delete boundary ─────────────────────────────────────────────────
describe('T6: route/controller does not implement the book deletion cascade', () => {
    it('bookDeletion.deleteBook is the single deletion seam', () => {
        const del = readSource(bookDeletionPath);
        expect(del).to.include('createBookDeletion');
        expect(del).to.match(/async function deleteBook\(bookId, options/);
        // Cascade details live here: canonical bundle removal, PG tables,
        // runtime Redis cleanup — not in the route.
        expect(del).to.match(/resetBook/);
        expect(del).to.match(/DELETE FROM/);
        expect(del).to.match(/animastor:cancelled-workers/);
    });

    it('core book route delegates DELETE to the boundary (no inline cascade)', () => {
        const route = readSource(coreRoutesPath);
        expect(route).to.match(/bookDeletion\.deleteBook\(bookId\)/);
        expect(route).to.not.match(/DELETE FROM/);
        expect(route).to.not.match(/rmSync/);
        expect(route).to.not.match(/cleanBookRedisKeys/);
        expect(route).to.not.match(/cancelled-workers/);
    });

    it('deleteBook is wired through dependency injection (no hidden singleton)', () => {
        const backend = readSource(path.join(BACKEND_SRC, 'backend.cjs'));
        expect(backend).to.match(/createBookDeletion\(/);
        expect(backend).to.match(/bookDeletion:/);
    });

    it('cancellation signal is sent BEFORE canonical reset (book.resetBook)', async () => {
        // Architectural contract regression: deleteBook() must deliver the
        // cancellation signal — Redis cancelled-workers set + PG
        // agent-session cancel — before it removes ANY canonical book state
        // (book.resetBook). A running worker/agent must observe the cancel on
        // its next checkCancelled() even if a later cleanup step fails.
        const order = [];
        const bookId = 'book-deletion-order';
        const fakeRedis = {
            sadd: async (key) => { order.push(`sadd:${key}`); return 1; },
            del: async (...keys) => { order.push(`del:${keys.join(',')}`); return keys.length; },
        };
        const fakeStorage = {
            postgres: {
                query: async (sql) => {
                    order.push(/UPDATE agent_sessions/.test(sql) ? 'cancel-agent-sessions' : 'pg-cleanup');
                },
            },
        };
        const fakeBook = {
            resetBook: async (id) => { order.push(`resetBook:${id}`); },
        };
        const originalOutputDir = config.OUTPUT_DIR;
        config.OUTPUT_DIR = path.join(tmpDir, 'deletion-output-nonexistent');
        try {
            const { deleteBook } = createBookDeletion({
                book: fakeBook,
                redis: fakeRedis,
                storage: fakeStorage,
                config,
                getAllChunks: async () => [],
                getChunk: async () => null,
                cleanBookRedisKeys: async () => {},
                log: () => {},
                setCancelFlag: async () => { order.push('set-cancel-flag'); },
            });

            const result = await deleteBook(bookId);
            expect(result.deleted).to.be.true;

            const cancelIdx = order.findIndex((e) => e === `sadd:animastor:cancelled-workers:${bookId}`);
            const pgCancelIdx = order.findIndex((e) => e === 'cancel-agent-sessions');
            const resetIdx = order.findIndex((e) => e === `resetBook:${bookId}`);
            expect(cancelIdx, 'cancelled-workers signal must be sent').to.be.gte(0);
            expect(pgCancelIdx, 'agent-session cancel must be sent').to.be.gte(0);
            expect(resetIdx, 'book.resetBook must be invoked').to.be.gte(0);
            // Contract: cancellation < canonical reset.
            expect(cancelIdx, 'cancelled-workers must be set BEFORE book.resetBook()')
                .to.be.below(resetIdx);
            expect(pgCancelIdx, 'agent-session cancel must precede book.resetBook()')
                .to.be.below(resetIdx);
        } finally {
            config.OUTPUT_DIR = originalOutputDir;
        }
    });
});

// ── T7 — No architectural regression ─────────────────────────────────────
describe('T7: no new Book Model → Player/Editor/Generation/Provider Gateway deps', () => {
    const FORBIDDEN = /routes\/|provider-gateway|generation|orchestration|player|editor|workflows|ai-/i;

    function assertAllowedDeps(file, allowed) {
        const src = readSource(file);
        for (const spec of requireSpecifiers(src)) {
            if (!spec.startsWith('.')) continue; // node builtins / bare deps checked separately
            const resolved = resolveSpecifier(file, spec);
            expect(resolved, `${rel(file)} requires ${spec}`).to.not.be.null;
            const relPath = rel(resolved);
            const isBookLayer = /^backend\/src\/book\//.test(relPath);
            const isAllowed = allowed.some((re) => re.test(relPath));
            expect(isBookLayer || isAllowed,
                `${rel(file)} must not depend on ${relPath} (Book Model layer boundary)`).to.be.true;
            expect(relPath).to.not.match(FORBIDDEN);
        }
    }

    it('book-model.cjs depends only on the book layer', () => {
        assertAllowedDeps(bookModelPath, []);
        const src = readSource(bookModelPath);
        expect(src).to.not.match(/require\(['"](?:ioredis|pg)['"]\)/);
    });

    it('book-deletion.cjs depends on book layer + injected adapters only', () => {
        assertAllowedDeps(bookDeletionPath, []);
        // setCancelFlag is injected, never required from the runtime layer.
        const del = readSource(bookDeletionPath);
        expect(del).to.not.match(/require\([^)]*scene-window/);
    });
});
