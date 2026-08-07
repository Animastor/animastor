const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registerRecentBooksRoutes = require('../src/routes/book/recent-books-routes.cjs');
const { collectRecentBooks } = registerRecentBooksRoutes;

describe('Recent Books (GET /api/v1/books)', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animastor-recent-books-'));
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    });

    function makeDeps({ pgRows = [], onDisk = [] } = {}) {
        const diskIds = new Set(onDisk);
        // The route's disk-scan phase reads real directories via fs, so create a
        // real subdir per book (mirrors data/books/<bookId>/ on the server).
        for (const bookId of onDisk) {
            fs.mkdirSync(path.join(tmpDir, bookId), { recursive: true });
        }
        const lazyBook = {
            getBooksDir: () => tmpDir,
            getBookStatus: (bookId) => {
                if (!diskIds.has(bookId)) return null;
                return {
                    bookId,
                    state: bookId.startsWith('ready-') ? 'BOOTSTRAPPED' : 'RAW_IMPORTED',
                    title: `Title ${bookId}`,
                    parsedChapters: bookId.startsWith('ready-') ? 2 : 0,
                    parsedScenes: bookId.startsWith('ready-') ? 5 : 0,
                    updatedAt: Number(bookId.split('-').pop() || 0),
                };
            },
            loadDraftBook: (bookId) => ({ manifest: { build_id: `build-${bookId}` } }),
        };
        const bookSourceRepo = {
            listRecent: async () => pgRows,
        };
        return { bookSourceRepo, lazyBook };
    }

    it('returns nothing when PG and disk are both empty', async () => {
        const books = await collectRecentBooks(makeDeps());
        expect(books).to.deep.equal([]);
    });

    it('lists PG-registered books that still exist on disk, newest first', async () => {
        const deps = makeDeps({
            pgRows: [
                { book_id: 'ready-100', file_hash: 'h1', source_type: 'txt', created_at: 100 },
                { book_id: 'ready-200', file_hash: 'h2', source_type: 'txt', created_at: 200 },
            ],
            onDisk: ['ready-100', 'ready-200'],
        });
        const books = await collectRecentBooks(deps);
        expect(books).to.have.length(2);
        expect(books[0].book_id).to.equal('ready-200'); // 200 > 100
        expect(books[0]).to.include({
            build_id: 'build-ready-200',
            state: 'BOOTSTRAPPED',
            source_type: 'txt',
            file_hash: 'h2',
            parsed_chapters: 2,
            total_scenes: 5,
        });
        expect(books[1].book_id).to.equal('ready-100');
    });

    it('skips PG rows whose book is no longer on disk', async () => {
        const deps = makeDeps({
            pgRows: [
                { book_id: 'gone-book', file_hash: 'h1', source_type: 'txt', created_at: 300 },
                { book_id: 'ready-ok', file_hash: 'h2', source_type: 'txt', created_at: 100 },
            ],
            onDisk: ['ready-ok'],
        });
        const books = await collectRecentBooks(deps);
        expect(books).to.have.length(1);
        expect(books[0].book_id).to.equal('ready-ok');
    });

    it('falls back to a disk scan for books not registered in PG', async () => {
        const deps = makeDeps({
            pgRows: [],
            onDisk: ['ready-100'],
        });
        const books = await collectRecentBooks(deps);
        expect(books).to.have.length(1);
        expect(books[0]).to.include({
            book_id: 'ready-100',
            source_type: 'disk',
            build_id: 'build-ready-100',
            state: 'BOOTSTRAPPED',
        });
    });

    it('sorts merged list by updated_at (newest first) and applies limit', async () => {
        const deps = makeDeps({
            pgRows: [
                { book_id: 'ready-100', file_hash: 'h1', source_type: 'txt', created_at: 0 },
                { book_id: 'ready-900', file_hash: 'h2', source_type: 'txt', created_at: 0 },
            ],
            onDisk: ['ready-100', 'ready-900', 'raw-500'],
        });
        const books = await collectRecentBooks({ ...deps, limit: 2 });
        expect(books.map((b) => b.book_id)).to.deep.equal(['ready-900', 'raw-500']);
    });

    it('tolerates a PG failure by falling back to disk only', async () => {
        const deps = makeDeps({ onDisk: ['ready-42'] });
        deps.bookSourceRepo.listRecent = async () => { throw new Error('PG down'); };
        const books = await collectRecentBooks(deps);
        expect(books).to.have.length(1);
        expect(books[0].book_id).to.equal('ready-42');
    });
});

describe('Recent Books route registration (production-shaped deps)', () => {
    // Regression: the route used to crash the container at startup with
    // `TypeError: log is not a function` because `log` lives in `deps.utils.log`,
    // not at the root of `deps`. These tests mirror the real deps shape from
    // backend.cjs routeDeps so the crash is caught by CI, not by docker.
    function makeRegistrationDeps({ withUtils = true } = {}) {
        const deps = {
            bookSourceRepo: { listRecent: async () => [] },
            lazyBook: {
                getBooksDir: () => '/tmp/animastor-no-books-dir',
                getBookStatus: () => null,
                loadDraftBook: () => null,
            },
        };
        if (withUtils) deps.utils = { log: () => {} };
        return deps;
    }

    it('registers /api/v1/books without throwing when log is in deps.utils', () => {
        const registered = [];
        const app = { get: (p) => { registered.push(p); } };
        expect(() => registerRecentBooksRoutes(app, {}, makeRegistrationDeps())).not.to.throw();
        expect(registered).to.include('/api/v1/books');
    });

    it('does not throw even when deps.utils is absent (defensive log fallback)', () => {
        const registered = [];
        const app = { get: (p) => { registered.push(p); } };
        expect(() => registerRecentBooksRoutes(app, {}, makeRegistrationDeps({ withUtils: false })))
            .not.to.throw();
        expect(registered).to.include('/api/v1/books');
    });

    it('serves GET /api/v1/books over HTTP with the production-shaped deps', async () => {
        const express = require('express');
        const app = express();
        registerRecentBooksRoutes(app, {}, makeRegistrationDeps());

        const server = app.listen(0);
        const { port } = server.address();
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/v1/books`);
            expect(res.status).to.equal(200);
            const body = await res.json();
            expect(body.books).to.deep.equal([]);
        } finally {
            server.close();
        }
    });
});
