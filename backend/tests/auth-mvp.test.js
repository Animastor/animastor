// ======================================================
// Authentication MVP Tests
// ======================================================
// Registration, login, session lifecycle, authorization integration and
// pre-auth compatibility (items 1–20 of the auth task).
//
// HTTP-level: a real Express app with the production authContext middleware
// + real PG sessions. Book rows are inserted directly with workspace
// ownership so the workspace-filtered list + ownership guards are exercised
// against real data.

const { expect } = require('chai');
const express = require('express');

const { query } = require('../src/storage/postgres/database');
const authService = require('../src/auth/auth-service');
const sessionRepo = require('../src/storage/postgres/repositories/session-repo');
const { hashPassword, verifyPassword } = require('../src/auth/password');
const registerAuthRoutes = require('../src/routes/auth-routes.cjs');
const registerRecentBooksRoutes = require('../src/routes/book/recent-books-routes.cjs');
const { authContext, requireBookAccess, checkBookAccess, dedupOwnedByCaller, importBookAllowed } = require('../src/middleware/auth-context');

// ── helpers ─────────────────────────────────────────────────────────────

/** Minimal req/res pair for middleware-level assertions. */
function fakeReqRes(req = {}) {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    return { req: { params: {}, ...req }, res };
}

function cookieOf(setCookieHeader) {
    if (!setCookieHeader) return null;
    const first = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
    return first.split(';')[0]; // "name=value"
}

async function registerUser(app, username, password, email) {
    const res = await fetch(`http://127.0.0.1:${app.__port}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, email }),
    });
    const body = await res.json();
    return { status: res.status, body, cookie: cookieOf(res.headers.get('set-cookie')) };
}

async function loginUser(app, username, password) {
    const res = await fetch(`http://127.0.0.1:${app.__port}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    const body = await res.json();
    return { status: res.status, body, cookie: cookieOf(res.headers.get('set-cookie')) };
}

/** Build the auth HTTP app (real authContext + auth routes + /api/v1/books). */
function buildApp({ pgRows = [], onDisk = [] } = {}) {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animastor-auth-'));
    for (const bookId of onDisk) fs.mkdirSync(path.join(tmpDir, bookId), { recursive: true });

    const app = express();
    app.use(express.json());
    app.use(authContext);
    registerAuthRoutes(app, null, { utils: { log: () => {} } });

    // Book lookup endpoint behind the ownership guard (production wiring
    // mounts requireBookAccess on every /api/v1/book/:bookId route).
    app.get('/api/v1/book/:bookId/meta', requireBookAccess('bookId'), (req, res) => {
        res.json({ ok: true, bookId: req.params.bookId, workspace: req.bookWorkspace || null });
    });

    registerRecentBooksRoutes(app, null, {
        bookSourceRepo: {
            listRecent: async (_limit, { workspaceId = null } = {}) => {
                if (!workspaceId) return pgRows;
                return pgRows.filter((r) => r.workspace_id == null || r.workspace_id === workspaceId);
            },
        },
        lazyBook: {
            getBooksDir: () => tmpDir,
            getBookStatus: (bookId) => {
                if (!onDisk.includes(bookId)) return null;
                return { bookId, state: 'READY', title: `T ${bookId}`, parsedChapters: 1, parsedScenes: 2, updatedAt: 100 };
            },
            loadDraftBook: (bookId) => ({ manifest: { build_id: `build-${bookId}` } }),
        },
        utils: { log: () => {} },
    });

    return { app, tmpDir };
}

async function cleanupUser(userIds, bookIds) {
    for (const id of bookIds) await query(`DELETE FROM books WHERE book_id = $1`, [id]);
    for (const uid of userIds) {
        await query(`DELETE FROM sessions WHERE user_id = $1`, [uid]);
        await query(`DELETE FROM workspaces WHERE owner_user_id = $1`, [uid]);
        await query(`DELETE FROM users WHERE user_id = $1`, [uid]);
    }
}

// ── suite ───────────────────────────────────────────────────────────────

describe('Authentication MVP', () => {
    const stamp = Date.now();
    const aliceUname = `alice_${stamp}`;
    const bobUname = `bob_${stamp}`;
    const password = 'correct-horse-42';

    let server;
    let app;
    let aliceCookie;
    let bobCookie;
    let alice;
    let bob;
    let aliceBookId;
    let bobBookId;
    const userIds = [];
    const bookIds = [];
    const wsIds = [];

    before(async () => {
        aliceBookId = `auth-alice-book-${stamp}`;
        bobBookId = `auth-bob-book-${stamp}`;
        const built = buildApp({ onDisk: [aliceBookId, bobBookId] });
        app = built.app;
        server = app.listen(0);
        app.__port = server.address().port;

        const a = await registerUser(app, aliceUname, password, `alice_${stamp}@example.com`);
        alice = a.body.user;
        alice.ws_id = a.body.workspace.id;
        aliceCookie = a.cookie;
        userIds.push(alice.id);
        wsIds.push(alice.ws_id);

        const b = await registerUser(app, bobUname, password);
        bob = b.body.user;
        bob.ws_id = b.body.workspace.id;
        bobCookie = b.cookie;
        userIds.push(bob.id);
        wsIds.push(bob.ws_id);

        // One book per user (direct insert — canonical workspace ownership).
        await query(`INSERT INTO books (book_id, workspace_id, title) VALUES ($1, $2, 'Alice Book')`, [aliceBookId, alice.ws_id]);
        await query(`INSERT INTO books (book_id, workspace_id, title) VALUES ($1, $2, 'Bob Book')`, [bobBookId, bob.ws_id]);
        bookIds.push(aliceBookId, bobBookId);
    });

    after(async () => {
        if (server) server.close();
        for (const id of bookIds) {
            await query(`DELETE FROM book_source WHERE book_id = $1`, [id]);
            await query(`DELETE FROM books WHERE book_id = $1`, [id]);
        }
        for (const ws of wsIds) {
            await query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [ws]);
            await query(`DELETE FROM workspaces WHERE id = $1`, [ws]);
        }
        for (const uid of userIds) {
            // sessions cascade to user deletion; workspace_members cascade too
            await query(`DELETE FROM users WHERE user_id = $1`, [uid]);
        }
    });

    // ── Registration ────────────────────────────────────────────────────

    describe('Registration', () => {
        it('1. successful registration returns user + personal workspace + session cookie', async () => {
            const u = `fresh_${Date.now()}`;
            const res = await fetch(`http://127.0.0.1:${app.__port}/api/v1/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: u, password: 'valid-pass-123', email: `${u}@example.com` }),
            });
            const body = await res.json();
            userIds.push(body.user.id);
            wsIds.push(body.workspace.id);
            expect(res.status).to.equal(201);
            expect(body.authenticated).to.equal(true);
            expect(body.user).to.include({ username: u });
            expect(body.workspace).to.include({ type: 'personal' });
            expect(cookieOf(res.headers.get('set-cookie'))).to.match(/^animastor_sid=/);
            // The cookie must be HttpOnly + SameSite and never leak the token elsewhere.
            const sc = res.headers.get('set-cookie');
            expect(sc).to.match(/HttpOnly/);
            expect(sc).to.match(/SameSite=Lax/);
            expect(JSON.stringify(body)).to.not.match(/token/i);
        });

        it('2. duplicate username rejected (exact and case-variant)', async () => {
            const dup1 = await registerUser(app, aliceUname, password);
            expect(dup1.status).to.equal(409);
            const dup2 = await registerUser(app, aliceUname.toUpperCase(), password);
            expect(dup2.status).to.equal(409);
        });

        it('3. invalid input rejected (short password, blank username)', async () => {
            const shortPwd = await registerUser(app, `short_${Date.now()}`, 'short');
            expect(shortPwd.status).to.equal(400);
            const blank = await registerUser(app, '  ', 'valid-pass-123');
            expect(blank.status).to.equal(400);
            const badEmail = await registerUser(app, `bad_${Date.now()}`, 'valid-pass-123', 'not-an-email');
            expect(badEmail.status).to.equal(400);
        });

        it('4. password is never stored in plaintext', async () => {
            const { rows } = await query(`SELECT password_hash FROM users WHERE username = $1`, [aliceUname]);
            expect(rows[0].password_hash).to.be.a('string');
            expect(rows[0].password_hash).to.match(/^scrypt\$/);
            expect(rows[0].password_hash).to.not.include(password);
            expect(await verifyPassword(password, rows[0].password_hash)).to.equal(true);
            expect(await verifyPassword('nope', rows[0].password_hash)).to.equal(false);
        });

        it('5. user + workspace + owner membership created atomically', async () => {
            for (const uid of [alice.id, bob.id]) {
                const { rows: ws } = await query(`SELECT * FROM workspaces WHERE owner_user_id = $1 AND type = 'personal'`, [uid]);
                expect(ws).to.have.length(1);
                const { rows: mem } = await query(`SELECT * FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [ws[0].id, uid]);
                expect(mem).to.have.length(1);
                expect(mem[0].role).to.equal('owner');
                // Workspace without an owner membership must never exist.
                const { rows: orphan } = await query(`
                    SELECT 1 FROM workspaces w
                    WHERE w.owner_user_id = $1
                      AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.user_id = $1)`, [uid]);
                expect(orphan).to.have.length(0);
            }
        });
    });

    // ── Login ───────────────────────────────────────────────────────────

    describe('Login', () => {
        it('6. correct password succeeds', async () => {
            const res = await loginUser(app, aliceUname, password);
            expect(res.status).to.equal(200);
            expect(res.body.authenticated).to.equal(true);
            expect(res.body.user.username).to.equal(aliceUname);
            expect(res.cookie).to.match(/^animastor_sid=/);
        });

        it('7. wrong password fails with 401', async () => {
            const res = await loginUser(app, aliceUname, 'totally-wrong-99');
            expect(res.status).to.equal(401);
            expect(res.body).to.have.property('error');
        });

        it('8. unknown username returns the SAME generic error (no enumeration)', async () => {
            const wrongUser = await loginUser(app, `ghost_${stamp}`, password);
            const wrongPwd = await loginUser(app, aliceUname, 'totally-wrong-99');
            expect(wrongUser.status).to.equal(401);
            expect(wrongPwd.status).to.equal(401);
            expect(wrongUser.body.error).to.equal(wrongPwd.body.error);
            // The reason category must not reveal which half of the pair failed.
            expect(wrongUser.body.reason).to.equal('login_invalid_credentials');
        });

        it('9. authenticated request gets req.user', async () => {
            const res = await fetch(`http://127.0.0.1:${app.__port}/api/v1/auth/me`, {
                headers: { Cookie: aliceCookie },
            });
            const body = await res.json();
            expect(body.authenticated).to.equal(true);
            expect(body.user).to.include({ id: alice.id, username: aliceUname });
        });

        it('10. authenticated request gets req.workspace (personal)', async () => {
            const res = await fetch(`http://127.0.0.1:${app.__port}/api/v1/auth/me`, {
                headers: { Cookie: bobCookie },
            });
            const body = await res.json();
            expect(body.workspace).to.include({ id: bob.ws_id, type: 'personal' });
        });
    });

    // ── Session ─────────────────────────────────────────────────────────

    describe('Session', () => {
        it('11. valid session authenticates across requests', async () => {
            for (let i = 0; i < 3; i++) {
                const res = await fetch(`http://127.0.0.1:${app.__port}/api/v1/auth/me`, {
                    headers: { Cookie: aliceCookie },
                });
                const body = await res.json();
                expect(body.authenticated).to.equal(true);
            }
        });

        it('12a. expired session is rejected', async () => {
            // A session created already-in-the-past never authenticates.
            const { rows } = await query(`SELECT user_id FROM users WHERE username = $1`, [aliceUname]);
            const expired = await sessionRepo.createSession(rows[0].user_id, Date.now() - 1000);
            const res = await fetch(`http://127.0.0.1:${app.__port}/api/v1/auth/me`, {
                headers: { Cookie: `animastor_sid=${expired.token}` },
            });
            expect((await res.json()).authenticated).to.equal(false);
        });

        it('12b. invalid/tampered tokens are rejected', async () => {
            for (const bad of ['garbage', 'sid.bogus.bogus', aliceCookie.slice(0, -2) + 'xx']) {
                const res = await fetch(`http://127.0.0.1:${app.__port}/api/v1/auth/me`, {
                    headers: { Cookie: `animastor_sid=${bad}` },
                });
                expect((await res.json()).authenticated).to.equal(false);
            }
            // Raw tokens are never persisted server-side (hash only) + never
            // appear in API responses: the /me body has no session/token.
            const meRes = await fetch(`http://127.0.0.1:${app.__port}/api/v1/auth/me`, { headers: { Cookie: aliceCookie } });
            expect(JSON.stringify(await meRes.json())).to.not.match(/sid\.|token|password/i);
            const { rows } = await query(`SELECT token_hash FROM sessions WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1`, [alice.id]);
            expect(rows[0].token_hash).to.match(/^[0-9a-f]{64}$/); // sha256 hex
        });

        it('13. logout invalidates the session and clears the cookie', async () => {
            const login = await loginUser(app, bobUname, password);
            const res = await fetch(`http://127.0.0.1:${app.__port}/api/v1/auth/logout`, {
                method: 'POST',
                headers: { Cookie: login.cookie },
            });
            expect(res.status).to.equal(200);
            expect((await res.json()).ok).to.equal(true);
            const sc = res.headers.get('set-cookie');
            expect(sc).to.match(/animastor_sid=;/); // cleared
            expect(sc).to.match(/Max-Age=0/);
            // Session no longer authenticates.
            const me = await fetch(`http://127.0.0.1:${app.__port}/api/v1/auth/me`, { headers: { Cookie: login.cookie } });
            expect((await me.json()).authenticated).to.equal(false);
        });

        it('14. repeated logout is safe (idempotent) and pre-auth me is anonymous', async () => {
            const res = await fetch(`http://127.0.0.1:${app.__port}/api/v1/auth/logout`, { method: 'POST' });
            expect(res.status).to.equal(200);
            const again = await fetch(`http://127.0.0.1:${app.__port}/api/v1/auth/logout`, { method: 'POST' });
            expect(again.status).to.equal(200);
            const me = await fetch(`http://127.0.0.1:${app.__port}/api/v1/auth/me`);
            const body = await me.json();
            expect(body.authenticated).to.equal(false);
            expect(body.user).to.equal(null);
            expect(body.workspace).to.equal(null);
        });
    });

    // ── Authorization ───────────────────────────────────────────────────

    describe('Authorization (book ownership)', () => {
        it('15. user A can access own book', async () => {
            const res = await fetch(`http://127.0.0.1:${app.__port}/api/v1/book/${aliceBookId}/meta`, {
                headers: { Cookie: aliceCookie },
            });
            expect(res.status).to.equal(200);
            expect((await res.json()).ok).to.equal(true);
        });

        it('16. user B CANNOT access user A book', async () => {
            const res = await fetch(`http://127.0.0.1:${app.__port}/api/v1/book/${aliceBookId}/meta`, {
                headers: { Cookie: bobCookie },
            });
            expect(res.status).to.equal(403);
        });

        it('17. user B sees their own book', async () => {
            const res = await fetch(`http://127.0.0.1:${app.__port}/api/v1/book/${bobBookId}/meta`, {
                headers: { Cookie: bobCookie },
            });
            expect(res.status).to.equal(200);
            expect((await res.json()).ok).to.equal(true);
        });

        it('18. /api/v1/books is workspace-filtered for authenticated users', async () => {
            // The real route + real PG: books are pre-existing registry rows in
            // personal workspaces; the route filters by req.workspace.id.
            const mine = await fetch(`http://127.0.0.1:${app.__port}/api/v1/books`, { headers: { Cookie: aliceCookie } });
            const mineBody = await mine.json();
            const ids = mineBody.books.map((b) => b.book_id);
            expect(ids).to.include(aliceBookId);
            expect(ids).to.not.include(bobBookId);

            const theirs = await fetch(`http://127.0.0.1:${app.__port}/api/v1/books`, { headers: { Cookie: bobCookie } });
            const theirsIds = (await theirs.json()).books.map((b) => b.book_id);
            expect(theirsIds).to.include(bobBookId);
            expect(theirsIds).to.not.include(aliceBookId);
        });
    });

    // ── Middleware-level checkBookAccess contract ───────────────────────

    describe('checkBookAccess contract', () => {
        it('pre-auth requests keep full access (compatibility)', async () => {
            const ws = await checkBookAccess({ user: null }, aliceBookId);
            expect(ws).to.include({ id: 'anonymous' });
        });

        it('authenticated owner resolves the owning workspace', async () => {
            const req = { user: { userId: alice.id, username: aliceUname }, workspace: { id: alice.ws_id, type: 'personal' } };
            const ws = await checkBookAccess(req, aliceBookId);
            expect(ws).to.include({ id: alice.ws_id });
        });

        it('authenticated stranger is denied', async () => {
            const req = { user: { userId: bob.id, username: bobUname }, workspace: { id: bob.workspace_id, type: 'personal' } };
            const ws = await checkBookAccess(req, aliceBookId);
            expect(ws).to.equal(null);
        });

        it('unknown book is denied for authenticated users (fail closed)', async () => {
            const req = { user: { userId: bob.id, username: bobUname }, workspace: { id: bob.workspace_id, type: 'personal' } };
            const ws = await checkBookAccess(req, `ghost-book-${stamp}`);
            expect(ws).to.equal(null);
        });
    });

    // ── Cross-tenant import guards ──────────────────────────────────────

    describe('Import tenant guards (dedup + bundle re-import)', () => {
        const aliceReq = () => ({ user: { userId: alice.id, username: aliceUname }, workspace: { id: alice.ws_id, type: 'personal' } });
        const bobReq = () => ({ user: { userId: bob.id, username: bobUname }, workspace: { id: bob.ws_id, type: 'personal' } });

        it('pre-auth dedup stays enabled for any candidate', async () => {
            expect(await dedupOwnedByCaller({}, aliceBookId)).to.equal(true);
        });

        it('authenticated dedup only for own books', async () => {
            expect(await dedupOwnedByCaller(aliceReq(), aliceBookId)).to.equal(true);
            expect(await dedupOwnedByCaller(bobReq(), aliceBookId)).to.equal(false);
            expect(await dedupOwnedByCaller(bobReq(), bobBookId)).to.equal(true);
        });

        it('importBookAllowed: pre-auth and owner pass, foreign denied', async () => {
            expect((await importBookAllowed({}, aliceBookId)).allowed).to.equal(true);
            expect((await importBookAllowed(aliceReq(), aliceBookId)).allowed).to.equal(true);
            const denied = await importBookAllowed(bobReq(), aliceBookId);
            expect(denied.allowed).to.equal(false);
            expect(denied.status).to.equal(403);
        });

        it('importBookAllowed: disk copy without ownership fails CLOSED for authed', async () => {
            const ghostId = `ghost-disk-${stamp}`;
            expect((await importBookAllowed(aliceReq(), ghostId, { diskCopyExists: true })).allowed).to.equal(false);
            // pre-auth keeps the historical open behaviour (no identity yet)
            expect((await importBookAllowed({}, ghostId, { diskCopyExists: true })).allowed).to.equal(true);
        });
    });

    // ── Password hashing unit contract ───────────────────────────────────

    describe('Password storage primitives', () => {
        it('hashPassword output is verifiable and non-deterministic (random salt)', async () => {
            const h1 = await hashPassword('same-password');
            const h2 = await hashPassword('same-password');
            expect(h1).to.not.equal(h2); // per-hash salt
            expect(await verifyPassword('same-password', h1)).to.equal(true);
            expect(await verifyPassword('same-password', h2)).to.equal(true);
            expect(await verifyPassword('other', h1)).to.equal(false);
        });

        it('verifyPassword is safe with NULL/legacy hashes (no exception)', async () => {
            expect(await verifyPassword('anything', null)).to.equal(false);
            expect(await verifyPassword('anything', undefined)).to.equal(false);
            expect(await verifyPassword(null, await hashPassword('x'))).to.equal(false);
        });
    });

    // ── Cross-subdomain cookie domain (public website + app on one parent) ─

    describe('Cookie domain (COOKIE_DOMAIN)', () => {
        const saved = process.env.COOKIE_DOMAIN;
        afterEach(() => {
            if (saved === undefined) delete process.env.COOKIE_DOMAIN;
            else process.env.COOKIE_DOMAIN = saved;
        });

        it('unset → host-only cookies (no Domain attribute)', () => {
            delete process.env.COOKIE_DOMAIN;
            const v = authService.sessionCookieHeader('tok', { secure: true });
            expect(v).to.not.contain('Domain=');
            expect(v).to.contain('HttpOnly');
            expect(v).to.contain('SameSite=Lax');
        });

        it('set → session, guest and clear cookies carry the Domain suffix', () => {
            process.env.COOKIE_DOMAIN = 'animastor.in';
            expect(authService.sessionCookieHeader('tok', { secure: true })).to.contain('; Domain=animastor.in');
            expect(authService.clearSessionCookieHeader({ secure: true })).to.contain('; Domain=animastor.in');
            expect(authService.guestCookieHeader('tok', { secure: false })).to.contain('; Domain=animastor.in');
            expect(authService.clearGuestCookieHeader({ secure: false })).to.contain('; Domain=animastor.in');
        });

        it('leading dot is normalized; invalid values fall back to host-only', () => {
            process.env.COOKIE_DOMAIN = '.animastor.in';
            expect(authService.sessionCookieHeader('tok', { secure: true })).to.contain('; Domain=animastor.in');
            for (const bad of ['animastor.in; Path=/x', 'evil com', 'a b', '']) {
                process.env.COOKIE_DOMAIN = bad;
                expect(authService.sessionCookieHeader('tok', { secure: true })).to.not.contain('Domain=');
            }
        });
    });
});

describe('Authentication MVP — pre-auth regression (dev books)', () => {
    // 19. Existing development books keep working exactly as before: they
    // belong to the seeded developer workspace and GET /api/v1/books without
    // authentication lists them all (pre-auth mode preserved).
    it('lists seeded developer books to anonymous clients', async () => {
        const { rows } = await query(`
            SELECT b.book_id FROM books b
            JOIN workspaces w ON w.id = b.workspace_id
            JOIN users u ON u.user_id = w.owner_user_id
            WHERE u.username = 'developer' LIMIT 5`);
        const onDisk = rows.map((r) => r.book_id);
        const { app } = buildApp({ pgRows: onDisk.map((book_id, i) => ({ book_id, file_hash: `h${i}`, source_type: 'txt', created_at: 100 + i, workspace_id: null })), onDisk });
        const server = app.listen(0);
        try {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/books`);
            const body = await res.json();
            expect(res.status).to.equal(200);
            for (const id of onDisk) {
                expect(body.books.map((b) => b.book_id)).to.include(id);
            }
        } finally {
            server.close();
        }
    });
});
