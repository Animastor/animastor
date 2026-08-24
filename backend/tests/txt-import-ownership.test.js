// ======================================================
// TXT Import Ownership Dedup — Regression Tests
// ======================================================
// Three scenarios that the old UNIQUE(file_hash) index broke:
//   1. sureg imports TXT → book exists → re-import dedup (same book_id);
//   2. user B imports same TXT → no owned book → NEW book_id;
//   3. guest imports same TXT → no owned book → NEW book_id (guest workspace).
//
// Disk self-heal variant (sureg): book_source row deleted (the old
// re-pointing bug) → re-import still finds the book on disk by hash +
// ownership.

// ── Redirect lazy-book to a temp dir BEFORE any lazy-book module loads ───
const _testBooksDir = require('fs').mkdtempSync(
    require('path').join(require('os').tmpdir(), 'animastor-txt-dedup-')
);
process.env.BOOKS_DIR = _testBooksDir;
// Clear cached paths.js + lazy-book barrel so draft.js picks up the temp dir
for (const key of Object.keys(require.cache)) {
    if (key.includes('/lazy-book/paths.js') || key.endsWith('/lazy-book/index.js')) {
        delete require.cache[key];
    }
}

const { expect } = require('chai');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { query } = require('../src/storage/postgres/database');
const postgres = require('../src/storage/postgres');
const registerAuthRoutes = require('../src/routes/auth-routes.cjs');
const registerImportRoutes = require('../src/routes/book/import-routes.cjs');
const { authContext } = require('../src/middleware/auth-context');
const bookSourceRepo = require('../src/storage/postgres/repositories/book-source-repo');
const lazyBook = require('../src/book/lazy-book');

// ── helpers ─────────────────────────────────────────────────────────────

const SAMPLE_TXT = Buffer.from('Тестовый текст для проверки ownership dedup.', 'utf8');
const SAMPLE_HASH = crypto.createHash('sha256').update(SAMPLE_TXT).digest('hex');
const SAMPLE_SIZE = SAMPLE_TXT.length;

function cookieOf(setCookieHeader) {
    if (!setCookieHeader) return null;
    const first = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
    return first.split(';')[0];
}

function cookieByName(setCookieHeader, name) {
    if (!setCookieHeader) return null;
    const all = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    const match = all.find((c) => c.startsWith(`${name}=`));
    return match ? match.split(';')[0] : null;
}

let _app;
let _port;

async function registerUser(username, password, email) {
    const res = await fetch(`http://127.0.0.1:${_port}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, email }),
    });
    const body = await res.json();
    return { status: res.status, body, cookie: cookieOf(res.headers.get('set-cookie')) };
}

async function importTxt(cookie, filename = 'test.txt') {
    const fd = new FormData();
    fd.append('file', new Blob([SAMPLE_TXT], { type: 'text/plain' }), filename);
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`http://127.0.0.1:${_port}/api/v1/book/import-txt`, {
        method: 'POST',
        headers,
        body: fd,
    });
    const setCookie = res.headers.get('set-cookie');
    return { status: res.status, body: await res.json(), setCookie };
}

// ── app setup ───────────────────────────────────────────────────────────

function buildApp() {
    const fakeRedis = {
        get: async () => null, set: async () => {}, del: async () => {},
        sismember: async () => 0, sadd: async () => {}, expire: async () => {},
    };

    const deps = {
        utils: { log: () => {} },
        config: {},
        state: {},
        audio: null, image: null, video: null,
        book: {
            extractBookBundle: () => { throw new Error('not vbook'); },
            buildBookFromBundle: () => ({}),
            loadBook: () => null,
            resetBook: async () => {},
            saveBookBundle: () => {},
            collectScenes: () => [],
        },
        orchestrator: null,
        storage: { postgres: { query: async () => ({ rows: [] }) } },
        txtImporter: {
            decodeTxtBuffer: (buf) => ({ text: buf.toString('utf8'), encoding: 'utf8', warnings: [], error: null }),
        },
        lazyBook,
        genSessionRepo: { markFirstWindowCompleted: async () => {} },
        bookSourceRepo,
        placeholderAudio: { ensureAllPlaceholderAudio: async () => ({ created: 0, skipped: 0 }) },
        layerConfig: null, genScope: null, activeScenes: null,
        saveChunk: async () => {}, getChunk: null, getAllChunks: async () => [],
        getBookWindowStatus: null, detectAvailableMode: null,
        recoverChunksFromDisk: async () => [], recoverAllBooksFromDisk: async () => {},
        cleanupService: null, bookDiff: null, taskHandler: null,
        windowGenerator: null, iuRepo: null, cleanBookRedisKeys: null,
    };

    const app = express();
    app.use(express.json());
    app.use(authContext);
    registerAuthRoutes(app, null, { utils: { log: () => {} } });
    registerImportRoutes(app, fakeRedis, deps);
    return app;
}

// ── cleanup ─────────────────────────────────────────────────────────────

const cleanupBookIds = new Set();
const cleanupUsernames = [];
const cleanupGuestIds = [];

async function cleanup() {
    for (const bookId of cleanupBookIds) {
        await query(`DELETE FROM book_source WHERE book_id = $1`, [bookId]).catch(() => {});
        await query(`DELETE FROM books WHERE book_id = $1`, [bookId]).catch(() => {});
        const bp = path.join(_testBooksDir, bookId);
        if (fs.existsSync(bp)) fs.rmSync(bp, { recursive: true, force: true });
    }
    for (const uname of cleanupUsernames) {
        const user = (await query(`SELECT user_id FROM users WHERE username = $1`, [uname])).rows[0];
        if (user) {
            await query(`DELETE FROM sessions WHERE user_id = $1`, [user.user_id]).catch(() => {});
            await query(`DELETE FROM workspace_members WHERE user_id = $1`, [user.user_id]).catch(() => {});
            await query(`DELETE FROM workspaces WHERE owner_user_id = $1`, [user.user_id]).catch(() => {});
            await query(`DELETE FROM users WHERE user_id = $1`, [user.user_id]).catch(() => {});
        }
    }
    for (const gid of cleanupGuestIds) {
        const guest = (await query(`SELECT workspace_id FROM guests WHERE guest_id = $1`, [gid])).rows[0];
        if (guest) {
            await query(`DELETE FROM workspaces WHERE workspace_id = $1`, [guest.workspace_id]).catch(() => {});
        }
        await query(`DELETE FROM guests WHERE guest_id = $1`, [gid]).catch(() => {});
    }
    cleanupBookIds.clear();
    cleanupUsernames.length = 0;
    cleanupGuestIds.length = 0;
}

// ── suite ───────────────────────────────────────────────────────────────

describe('TXT Import Ownership Dedup', () => {
    const stamp = Date.now();
    const suregUname = `sureg_${stamp}`;
    const userBUname = `userB_${stamp}`;
    const password = 'test-pass-42';

    let server;

    before(async () => {
        await postgres.initialize();
        const app = buildApp();
        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', () => {
                _port = server.address().port;
                _app = app;
                resolve();
            });
        });
    });

    after(async () => {
        await cleanup();
        if (server) await new Promise((r) => server.close(r));
        if (fs.existsSync(_testBooksDir)) fs.rmSync(_testBooksDir, { recursive: true, force: true });
    });

    describe('Scenario 1: sureg reuses existing owned book', () => {
        let suregCookie;
        let suregBookId;

        it('sureg imports TXT → creates new book', async () => {
            const reg = await registerUser(suregUname, password, `${suregUname}@test.com`);
            expect(reg.status).to.equal(201);
            suregCookie = reg.cookie;
            cleanupUsernames.push(suregUname);

            const result = await importTxt(suregCookie);
            expect(result.status).to.equal(200);
            expect(result.body.book_id).to.be.a('string');
            expect(result.body.dedup).to.not.equal(true);
            expect(result.body.state).to.equal('RAW_IMPORTED');
            suregBookId = result.body.book_id;
            cleanupBookIds.add(suregBookId);
        });

        it('sureg re-imports same TXT → dedup returns same book', async () => {
            const result = await importTxt(suregCookie);
            expect(result.status).to.equal(200);
            expect(result.body.book_id).to.equal(suregBookId);
            expect(result.body.dedup).to.equal(true);
        });

        it('disk self-heal: book_source row deleted → re-import still returns owned book', async () => {
            // Delete book_source row (simulates old re-pointing bug)
            await query(`DELETE FROM book_source WHERE book_id = $1`, [suregBookId]);
            const gone = await bookSourceRepo.findByBookId(suregBookId);
            expect(gone).to.be.null;

            // Re-import — should find book on disk + ownership
            const result = await importTxt(suregCookie);
            expect(result.status).to.equal(200);
            expect(result.body.book_id).to.equal(suregBookId);
            expect(result.body.dedup).to.equal(true);

            // book_source row should be re-registered
            const reindexed = await bookSourceRepo.findByBookId(suregBookId);
            expect(reindexed).to.not.be.null;
            expect(reindexed.file_hash).to.equal(SAMPLE_HASH);
        });
    });

    describe('Scenario 2: user B creates new book for same TXT', () => {
        let userBCookie;
        let userBBookId;

        it('user B imports same TXT → gets NEW book, not sureg\'s', async () => {
            const reg = await registerUser(userBUname, password, `${userBUname}@test.com`);
            expect(reg.status).to.equal(201);
            userBCookie = reg.cookie;
            cleanupUsernames.push(userBUname);

            const result = await importTxt(userBCookie);
            expect(result.status).to.equal(200);
            expect(result.body.dedup).to.not.equal(true);
            userBBookId = result.body.book_id;
            cleanupBookIds.add(userBBookId);

            // Must be a different book from sureg's
            for (const otherId of cleanupBookIds) {
                if (otherId === userBBookId) continue;
                expect(userBBookId).to.not.equal(otherId);
            }
        });

        it('user B book is in B\'s workspace, not sureg\'s', async () => {
            const wsResult = await query(
                `SELECT workspace_id FROM books WHERE book_id = $1`,
                [userBBookId]
            );
            expect(wsResult.rows.length).to.equal(1);
            const userBWs = wsResult.rows[0].workspace_id;
            expect(userBWs).to.be.a('string');

            // All book workspace IDs should be distinct
            const allBookIds = [...cleanupBookIds];
            const wsIds = [];
            for (const bid of allBookIds) {
                const r = await query(`SELECT workspace_id FROM books WHERE book_id = $1`, [bid]);
                if (r.rows.length > 0) wsIds.push(r.rows[0].workspace_id);
            }
            const uniqueWs = new Set(wsIds);
            expect(uniqueWs.size).to.equal(wsIds.length);
        });

        it('user B re-import → dedup returns own book', async () => {
            const result = await importTxt(userBCookie);
            expect(result.status).to.equal(200);
            expect(result.body.book_id).to.equal(userBBookId);
            expect(result.body.dedup).to.equal(true);
        });
    });

    describe('Scenario 3: guest creates new book for same TXT', () => {
        let guestCookie;
        let guestBookId;

        it('no cookie → auto-provisioned guest → new book', async () => {
            const result = await importTxt(null);
            expect(result.status).to.equal(200);
            expect(result.body.dedup).to.not.equal(true);
            guestBookId = result.body.book_id;
            cleanupBookIds.add(guestBookId);

            // Must be a different book from sureg's and user B's
            for (const otherId of cleanupBookIds) {
                if (otherId === guestBookId) continue;
                expect(guestBookId).to.not.equal(otherId);
            }

            // Capture guest cookie
            guestCookie = cookieByName(result.setCookie, 'animastor_gid');
            expect(guestCookie).to.be.a('string').and.to.include('animastor_gid=');

            // Guest workspace should be temporary
            const wsResult = await query(
                `SELECT workspace_id FROM books WHERE book_id = $1`,
                [guestBookId]
            );
            expect(wsResult.rows.length).to.equal(1);
            const guestWsId = wsResult.rows[0].workspace_id;

            const wsType = await query(
                `SELECT type FROM workspaces WHERE id = $1`,
                [guestWsId]
            );
            expect(wsType.rows[0]?.type).to.equal('temporary');

            // Find guest_id for cleanup
            const guestResult = await query(
                `SELECT guest_id FROM guests WHERE workspace_id = $1`,
                [guestWsId]
            );
            if (guestResult.rows.length > 0) {
                cleanupGuestIds.push(guestResult.rows[0].guest_id);
            }
        });

        it('guest re-import with cookie → dedup returns own book', async () => {
            const result = await importTxt(guestCookie);
            expect(result.status).to.equal(200);
            expect(result.body.book_id).to.equal(guestBookId);
            expect(result.body.dedup).to.equal(true);
        });
    });

    describe('Cross-identity isolation', () => {
        it('each book has a distinct workspace', async () => {
            const allBookIds = [...cleanupBookIds];
            const wsIds = [];
            for (const bid of allBookIds) {
                const r = await query(`SELECT workspace_id FROM books WHERE book_id = $1`, [bid]);
                if (r.rows.length > 0) wsIds.push(r.rows[0].workspace_id);
            }
            const uniqueWs = new Set(wsIds);
            expect(uniqueWs.size).to.equal(wsIds.length);
        });
    });
});
