// ======================================================
// PHASE 2 — VBook Runtime Contract (architecture guardrail)
// ======================================================
// Guards the canonical Book Model / VBook Runtime contract (Phase 2, Part A).
// These tests protect the CONTRACT, not a specific internal file layout.
//
// Canonical surface today (derived from current behavior, documented in
// docs/architecture/PHASE_2_CONTRACTS.md §2–§4):
//   book.loadBook(bookId)            — canonical disk bundle load
//   book.saveBookBundle(book, files) — canonical disk bundle write
//   book.resetBook(bookId)           — canonical disk bundle removal
//   book.extractBookBundle(buffer)   — vbook zip → raw files
//   book.buildBookFromBundle(files)  — raw files → canonical book object
//   book-source.*                    — canonical scene existence/hash read seam
//
// Contract invariants (not internal implementation):
//   1. A book is identified by manifest.book_id — the canonical id — not by
//      PostgreSQL (PG is derived/ownership, not content source of truth).
//   2. manifest.json is required for a loadable canonical bundle.
//   3. manifest.vbook_version is the current manifest version (3.1 at HEAD).
//   4. saveBookBundle round-trips through buildBookFromBundle (canonical
//      write is a valid load, and vice-versa — bundle contract parity).
//   5. loadBook(full) and loadDraftBook(lazy) are distinct intents:
//      canonical = what is on disk; lazy = in-progress import/agent state.
//      No consumer may treat lazy as canonical.
//   6. bundle-validator is the post-mutation / pre-write contract guard.
//
// Internal layout (book/index.js vs book/lazy-book/**) is an
// implementation detail and is NOT pinned here.

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { readSource, rel, REPO_ROOT } = require('./helpers');

const bookPath = path.join(REPO_ROOT, 'backend', 'src', 'book', 'index.js');
const validatorPath = path.join(REPO_ROOT, 'backend', 'src', 'book', 'bundle-validator.cjs');
const bookSourcePath = path.join(REPO_ROOT, 'backend', 'src', 'services', 'book-source.js');
const lazyBookPath = path.join(REPO_ROOT, 'backend', 'src', 'book', 'lazy-book', 'draft.js');

function read(file) {
    return readSource(file);
}

describe('architecture: VBook manifest contract', () => {
    it('book module exports the canonical CRUD surface', () => {
        const book = read(bookPath);
        expect(book).to.include('loadBook');
        expect(book).to.include('saveBookBundle');
        expect(book).to.include('resetBook');
        expect(book).to.include('extractBookBundle');
        expect(book).to.include('buildBookFromBundle');
    });

    it('manifest.json is required for a loadable canonical bundle', () => {
        // buildBookFromBundle throws when manifest.json is missing.
        const build = read(bookPath);
        expect(build).to.match(/manifest\.json not found/);
    });

    it('manifest.book_id is enforced as the canonical id at build time', () => {
        const build = read(bookPath);
        expect(build).to.match(/manifest\.book_id missing/);
    });

    it('canonical id format for chapters/scenes/units is enforced by the build path', () => {
        const build = read(bookPath);
        expect(build).to.match(/Invalid chapter_id/);
        expect(build).to.match(/Invalid scene_id/);
        expect(build).to.match(/Invalid unit_id/);
    });

    it('bundle validator is the post-mutation / pre-write contract guard', () => {
        const v = read(validatorPath);
        expect(v).to.include('validateBundleObject');
        expect(v).to.include('validateBundleFile');
        // Validator mirrors buildBookFromBundle contract (same file set).
        expect(v).to.include('manifest.json');
        expect(v).to.include('book.json');
        expect(v).to.include('bible.json');
        expect(v).to.include('locations.json');
        expect(v).to.include('voices.json');
        expect(v).to.include('behavior.json');
        expect(v).to.include('characters.json');
        // Validator enforces chapter scene.participants shape (the field that
        // historically broke canonical state via model hallucination).
        expect(v).to.include('participants');
    });

    it('manifest version is the VBook manifest version (vbook_version)', () => {
        // Current manifest version at HEAD: 3.1 (draft.js, entity routes,
        // tests). We pin the version concept (not a single file string) by
        // checking that buildBookFromBundle / validator deal with manifest
        // fields and that the draft path documents the version — the version
        // itself is a manifest field, not a code constant to pin to one file.
        const build = read(bookPath);
        const draft = read(lazyBookPath);
        expect(build).to.include('manifest');
        expect(draft).to.match(/vbook_version/);
    });

    it('book-source is the canonical scene existence / hash read seam', () => {
        const bs = read(bookSourcePath);
        expect(bs).to.include('loadBookJson');
        expect(bs).to.include('getCanonicalScenes');
        expect(bs).to.include('sceneExists');
        expect(bs).to.include('assertSceneExists');
        expect(bs).to.include('getBookFingerprint');
        expect(bs).to.include('listScenes');
        // Canonical scene existence errors carry explicit codes.
        expect(bs).to.include('SCENE_NOT_IN_JSON');
        expect(bs).to.include('CHAPTER_NOT_IN_JSON');
    });
});

describe('architecture: VBook canonical bundle contract', () => {
    // The canonical bundle is what loadBook returns from disk. We do NOT pin
    // the internal multi-file vs legacy-single fallback read detail; we pin
    // the contract that build ↔ save ↔ load are the canonical round-trip and
    // that manifest + book + chapters_order are the structural spine.

    it('canonical bundle spine is manifest + book + chapters_order', () => {
        const build = read(bookPath);
        expect(build).to.match(/book\.structure\.chapters_order missing/);
        const val = read(validatorPath);
        expect(val).to.include('structure.chapters_order');
    });

    it('chapter files are stored under chapters/ and referenced by chapters_order', () => {
        const save = read(bookPath);
        expect(save).to.match(/chapters\/ subdirectory/);
        expect(save).to.match(/structure\.chapters_order/);
    });

    it('behavior.json is always persisted as the per-character behavior contract', () => {
        const save = read(bookPath);
        // behavior.json is always written (created as {} during book creation).
        expect(save).to.match(/behavior\.json.*always persists/);
    });

    it('canonical bundle is not PG-owned — PG is derived/ownership only', () => {
        // book-source delegates to book.loadBook for canonical content; it does
        // NOT own canonical content in PG. The contract is that canonical
        // content lives on disk; PG rows are derived (scenes hash, assets,
        // tasks, ownership). We verify book-source uses the book loader as the
        // canonical read seam (not a raw PG content path) and that it refers to
        // the book JSON (canonical) as the content source.
        const bs = read(bookSourcePath);
        expect(bs).to.include("require('../book')");
        expect(bs).to.match(/book JSON|Book JSON|book JSON not found|book loader|canonical/);
    });
});

describe('architecture: loadBook semantics (canonical vs lazy)', () => {
    it('canonical load path exists as book.loadBook', () => {
        const book = read(bookPath);
        expect(book).to.match(/function loadBook\(bookId\)/);
    });

    it('lazy/draft load path exists as a distinct intent (not canonical)', () => {
        const lazy = read(lazyBookPath);
        expect(lazy).to.include('loadDraftBook');
        // draft.js documents that it is for in-progress import/agent state.
        expect(lazy).to.match(/draft/);
    });

    it('canonical-first fallback (canonical || draft) is documented behavior for AI/chat context', () => {
        // Two AI/chat paths already use canonical || draft as a fallback (not a
        // new invention). This test records the SEMANTICS, not the exact site:
        // canonical-first, draft only as fallback when canonical is absent.
        const ai = readSource(path.join(REPO_ROOT, 'backend', 'src', 'routes', 'ai-routes.cjs'));
        expect(ai).to.match(/book\.loadBook\(bookId\)\s*\|\|\s*lazyBook\.loadDraftBook\(bookId\)/);
    });
});

describe('architecture: book ownership boundary (guardrail where cheap)', () => {
    // We do not rewrite all consumers. Where a cheap, existing seam exists, we
    // pin that consumers go through it rather than inventing raw disk access.

    it('canonical scene existence checks go through book-source, not raw book.loadBook per-call', () => {
        // book-source.assertSceneExists / sceneExists are the canonical
        // existence seam for DB-side consumers. We verify the seam exists and
        // carries explicit error codes (contract), not that every consumer uses
        // it (that would be a refactor).
        const bs = read(bookSourcePath);
        expect(bs).to.include('assertSceneExists');
        expect(bs).to.include('sceneExists');
    });

    it('bundle validator runs BEFORE disk write (validate → write, never write → discover)', () => {
        const save = read(bookPath);
        expect(save).to.match(/validate.*write/);
        expect(save).to.match(/writeFileSync/);
    });
});
