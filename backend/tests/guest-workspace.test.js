// ======================================================
// Guest Workspace MVP Tests
// ======================================================
// Anonymous temporary identities + temporary workspaces:
//   1.  guest provisioning happens only on WRITE (POST/PUT/PATCH /api/v1),
//       never on GET — pre-auth reads keep listing everything;
//   2.  guest cookie `animastor_gid` is HttpOnly; the `animastor_sid`
//       session cookie is untouched for guests;
//   3.  books created by a guest belong to the guest's temporary workspace;
//   4.  a guest can see ONLY its own book (workspace scoping);
//   5.  expired guest workspace → 410 "Guest workspace expired";
//   6.  register with a live guest cookie CONVERTS the workspace in place
//       (same workspace_id, zero book copying, no fresh empty workspace);
//   7.  after conversion the guest token is revoked and `/auth/me` is user;
//   8.  register without a guest cookie still creates a fresh personal
//       workspace (unchanged behaviour);
//   9.  /auth/me shapes: user | guest | none.
//
// HTTP-level: a real Express app with the production authContext middleware +
// auth routes against real PG (books rows inserted directly so ownership has
// real workspace targets).

const { expect } = require('chai');
const express = require('express');

const { query } = require('../src/storage/postgres/database');
const authService = require('../src/auth/auth-service');
const guestRepo = require('../src/storage/postgres/repositories/guest-repo');
const registerAuthRoutes = require('../src/routes/auth-routes.cjs');
const registerRecentBooksRoutes = require('../src/routes/book/recent-books-routes.cjs');
const { authContext, checkBookAccess, requireBookAccess, WorkspaceExpiredError } = require('../src/middleware/auth-context');

// ── helpers ─────────────────────────────────────────────────────────────

function cookieOf(setCookieHeader) {
    if (!setCookieHeader) return null;
    const first = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
    return first.split(';')[0]; // "name=value"
}

function cookieByName(res, name) {
    const header = res.headers.get('set-cookie');
    if (!header) return null;
    const all = Array.isArray(header) ? header : [header];
    const match = all.find((c) => c.startsWith(`${name}=`));
    return match ? match.split(';')[0] : null;
}

/** Build the guest-workspace HTTP app: real authContext + auth routes + /books. */
function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(authContext);
    registerAuthRoutes(app, null, {});
    registerRecentBooksRoutes(app, null, {
        bookSourceRepo: {
            listRecent: async (limit) => [], // books come from the registry merge below
        },
        lazyBook: {
            getBooksDir: () => '/tmp/guest-mvp-nonexistent',
            loadBook: () => null,
        },
        utils: { log: () => {} },
    });

    // WRITE probe under /api/v1: mirrors the path any mutation takes
    // (POST /api/v1/book/* under the real server); lets the tests assert the
    // provisioning contract without dragging the heavy route modules.
    app.post('/api/v1/probe-write', (req, res) => {
        res.json({
            kind: req.auth.kind,
            workspace_id: req.workspace ? req.workspace.id : null,
        });
    });
    // GET probe: provisioning must NOT fire on reads.
    app.get('/api/v1/probe-read', (req, res) => {
        res.json({ kind: req.auth.kind, workspace_id: req.workspace ? req.workspace.id : null });
    });
    app.use('/api/v1/book/:bookId', requireBookAccess('bookId'));
    app.get('/api/v1/book/:bookId', (req, res) => res.json({ ok: true, workspace: req.bookWorkspace }));

    return app;
}

function listen(app) {
    return new Promise((resolve) => {
        const server = app.listen(0, () => resolve({ server, port: server.address().port }));
    });
}

async function cleanup(stamp) {
    // Books → workspaces → users (FK order: books→workspaces, workspaces.owner→users).
    await query(`DELETE FROM books WHERE workspace_id IN (SELECT id FROM workspaces WHERE name LIKE '%${stamp}%' OR owner_user_id IN (SELECT user_id FROM users WHERE username LIKE 'gwtest%'))`);
    await query(`DELETE FROM guests WHERE workspace_id IN (SELECT id FROM workspaces WHERE name LIKE '%${stamp}%')`);
    await query(`DELETE FROM workspaces WHERE name LIKE '%${stamp}%'`);
    await query(`DELETE FROM workspaces WHERE owner_user_id IN (SELECT user_id FROM users WHERE username LIKE 'gwtest%')`);
    await query(`DELETE FROM users WHERE username LIKE 'gwtest%'`);
}

// Remove temporary guest workspaces auto-provisioned during the run
// (they are all named 'Guest workspace', so scope by creation time).
async function cleanupGuestWorkspaces(startSec) {
    const { rows } = await query(
        `SELECT id FROM workspaces WHERE name = 'Guest workspace' AND type = 'temporary' AND created_at >= $1`,
        [startSec]
    );
    if (!rows.length) return;
    const ids = rows.map(r => r.id);
    await query(`DELETE FROM books WHERE workspace_id = ANY($1)`, [ids]);
    await query(`DELETE FROM workspaces WHERE id = ANY($1)`, [ids]);
}

// ── suite ───────────────────────────────────────────────────────────────

describe('Guest Workspace MVP', () => {
    const stamp = `gwmvp${Date.now()}`;
    let server;
    let port;
    let base;
    let suiteStart;

    before(async () => {
        await cleanup(stamp);
        const app = buildApp();
        const up = await listen(app);
        server = up.server;
        port = up.port;
        base = `http://127.0.0.1:${port}`;
        suiteStart = Math.floor(Date.now() / 1000) - 2;
    });

    after(async () => {
        server.close();
        await cleanup(stamp);
        await cleanupGuestWorkspaces(suiteStart);
    });

    // ── provisioning contract ───────────────────────────────────────────

    describe('provisioning', () => {
        it('1. GET /api/v1 (no cookies) stays pre-auth — no guest created', async () => {
            const res = await fetch(`${base}/api/v1/probe-read`);
            const body = await res.json();
            expect(res.status).to.equal(200);
            expect(body.kind).to.equal('none');
            expect(body.workspace_id).to.equal(null);
            expect(cookieByName(res, 'animastor_gid')).to.equal(null);
        });

        it('2. POST /api/v1 (no cookies) provisions a guest with HttpOnly cookie', async () => {
            const res = await fetch(`${base}/api/v1/probe-write`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const body = await res.json();
            expect(res.status).to.equal(200);
            expect(body.kind).to.equal('guest');
            expect(body.workspace_id).to.be.a('string');

            const raw = res.headers.get('set-cookie');
            expect(raw).to.be.a('string');
            expect(raw.toLowerCase()).to.contain('httponly');
            expect(raw).to.contain('animastor_gid=');
            // Session cookie must not be set for a guest.
            expect(raw).to.not.contain('animastor_sid=');
        });

        it('3. /api/v1/auth/* is exempt — register/login never become guests here', async () => {
            const before = await query('SELECT COUNT(*)::int AS n FROM guests');
            const res = await fetch(`${base}/api/v1/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: `${stamp}-nope`, password: 'x' }),
            });
            expect(res.status).to.equal(401);
            expect(cookieByName(res, 'animastor_gid')).to.equal(null);
            const after = await query('SELECT COUNT(*)::int AS n FROM guests');
            expect(after.rows[0].n).to.equal(before.rows[0].n);
        });
    });

    // ── guest workspace lifecycle ───────────────────────────────────────

    describe('temporary workspace lifecycle', () => {
        let guestCookie;
        let guestWorkspaceId;

        it('4. fresh guest workspace is type=temporary with a deadline', async () => {
            const res = await fetch(`${base}/api/v1/probe-write`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            guestCookie = cookieByName(res, 'animastor_gid');
            expect(guestCookie).to.be.a('string');
            guestWorkspaceId = (await res.json()).workspace_id;

            const { rows } = await query(`SELECT type, expires_at, owner_user_id FROM workspaces WHERE id = $1`, [guestWorkspaceId]);
            expect(rows).to.have.length(1);
            expect(rows[0].type).to.equal('temporary');
            expect(rows[0].owner_user_id).to.equal(null);
            expect(Number(rows[0].expires_at)).to.be.greaterThan(Date.now());
        });

        it('5. /auth/me with a guest cookie reports guest + workspace status', async () => {
            const res = await fetch(`${base}/api/v1/auth/me`, { headers: { Cookie: guestCookie } });
            const body = await res.json();
            expect(res.status).to.equal(200);
            expect(body.authenticated).to.equal(false);
            expect(body.identity).to.equal('guest');
            expect(body.user).to.equal(null);
            expect(body.workspace).to.include({ id: guestWorkspaceId, type: 'temporary', status: 'active' });
        });

        it('6. guest can access a book inside its own workspace', async () => {
            const bookId = `${stamp}-book-own`;
            await query(`INSERT INTO books (book_id, title, workspace_id) VALUES ($1, $2, $3)
                         ON CONFLICT (book_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id`, [bookId, 'own', guestWorkspaceId]);
            const res = await fetch(`${base}/api/v1/book/${bookId}`, { headers: { Cookie: guestCookie } });
            expect(res.status).to.equal(200);
            await query('DELETE FROM books WHERE book_id = $1', [bookId]);
        });

        it('7. guest is denied a book in a foreign workspace (fail closed)', async () => {
            const { rows } = await query(`INSERT INTO workspaces (name, type) VALUES ($1, 'temporary') RETURNING id`, [`${stamp}-foreign`]);
            const foreignId = rows[0].id;
            const bookId = `${stamp}-book-foreign`;
            await query(`INSERT INTO books (book_id, title, workspace_id) VALUES ($1, $2, $3)`, [bookId, 'foreign', foreignId]);
            const res = await fetch(`${base}/api/v1/book/${bookId}`, { headers: { Cookie: guestCookie } });
            expect(res.status).to.equal(403);
            await query('DELETE FROM books WHERE book_id = $1', [bookId]);
            await query('DELETE FROM workspaces WHERE id = $1', [foreignId]);
        });

        it('8. expired guest workspace answers 410 "Guest workspace expired"', async () => {
            // Backdate the deadline past TTL+grace so the workspace resolves expired.
            await query(`UPDATE workspaces SET expires_at = $2 WHERE id = $1`, [guestWorkspaceId, Date.now() - 60_000]);
            const res = await fetch(`${base}/api/v1/auth/me`, { headers: { Cookie: guestCookie } });
            const body = await res.json();
            expect(body.workspace.status).to.equal('expired');

            const bookId = `${stamp}-book-expired`;
            await query(`INSERT INTO books (book_id, title, workspace_id) VALUES ($1, $2, $3)
                         ON CONFLICT (book_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id`, [bookId, 'in expired ws', guestWorkspaceId]);
            const guard = await fetch(`${base}/api/v1/book/${bookId}`, { headers: { Cookie: guestCookie } });
            expect(guard.status).to.equal(410);
            const guardBody = await guard.json();
            expect(guardBody.error).to.match(/expired/i);
            await query('DELETE FROM books WHERE book_id = $1', [bookId]);
        });
    });

    // ── conversion to account ───────────────────────────────────────────

    describe('register conversion', () => {
        it('9. register with a live guest cookie converts the workspace in place', async () => {
            // Fresh guest + one book in its workspace.
            const provision = await fetch(`${base}/api/v1/probe-write`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const cookie = cookieByName(provision, 'animastor_gid');
            const workspaceId = (await provision.json()).workspace_id;
            const bookId = `${stamp}-convert-book`;
            await query(`INSERT INTO books (book_id, title, workspace_id) VALUES ($1, $2, $3)`, [bookId, 'kept', workspaceId]);

            const username = `gwtest${Date.now()}`;
            const res = await fetch(`${base}/api/v1/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({ username, password: 'password123' }),
            });
            const body = await res.json();
            expect(res.status).to.equal(201);
            expect(body.authenticated).to.equal(true);
            expect(body.converted).to.equal(true);
            expect(body.workspace.id).to.equal(workspaceId); // SAME workspace — nothing copied

            // Workspace became personal and unexpired; book kept its row.
            const { rows } = await query(`SELECT type, expires_at, owner_user_id FROM workspaces WHERE id = $1`, [workspaceId]);
            expect(rows[0].type).to.equal('personal');
            expect(rows[0].expires_at).to.equal(null);
            expect(rows[0].owner_user_id).to.equal(body.user.id);
            const book = await query(`SELECT workspace_id FROM books WHERE book_id = $1`, [bookId]);
            expect(book.rows[0].workspace_id).to.equal(workspaceId);

            // Old guest token is revoked: /auth/me no longer resolves guest.
            const me = await fetch(`${base}/api/v1/auth/me`, { headers: { Cookie: cookie } });
            const meBody = await me.json();
            expect(meBody.identity).to.not.equal('guest');

            // Session cookie was set for the new account; guest cookie cleared.
            const setCookie = res.headers.get('set-cookie');
            expect(setCookie).to.contain('animastor_sid=');
            expect(setCookie).to.match(/animastor_gid=;/); // cleared

            await query('DELETE FROM books WHERE book_id = $1', [bookId]);
            await query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
            await query('DELETE FROM users WHERE username = $1', [username]);
        });

        it('10. register without a guest cookie still creates a fresh personal workspace', async () => {
            const username = `gwtestfresh${Date.now()}`;
            const res = await fetch(`${base}/api/v1/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password: 'password123' }),
            });
            const body = await res.json();
            expect(res.status).to.equal(201);
            expect(body.authenticated).to.equal(true);
            expect(body.converted).to.equal(false);
            expect(body.workspace.type).to.equal('personal');

            const { rows } = await query(`SELECT owner_user_id FROM workspaces WHERE id = $1`, [body.workspace.id]);
            expect(rows[0].owner_user_id).to.equal(body.user.id);

            await query('DELETE FROM workspaces WHERE id = $1', [body.workspace.id]);
            await query('DELETE FROM users WHERE username = $1', [username]);
        });
    });

    // ── middleware-level contracts ──────────────────────────────────────

    describe('checkBookAccess contracts', () => {
        it('11. pre-auth (no identity) keeps full access', async () => {
            const ws = await checkBookAccess({}, `anything-${stamp}`);
            expect(ws).to.include({ id: 'anonymous' });
        });

        it('12. guest with expired workspace throws WorkspaceExpiredError', async () => {
            const req = {
                guest: { guestId: 'x' },
                workspace: { id: 'ws', type: 'temporary', status: 'expired' },
            };
            let threw = null;
            try {
                await checkBookAccess(req, `any-${stamp}`);
            } catch (e) {
                threw = e;
            }
            expect(threw).to.be.instanceOf(WorkspaceExpiredError);
            expect(threw.status).to.equal(410);
        });
    });

    // ── purge ───────────────────────────────────────────────────────────

    describe('purge', () => {
        it('13. purgeExpired removes stale guests + temporary workspaces past grace only', async () => {
            const { rows } = await query(`INSERT INTO workspaces (name, type) VALUES ($1, 'temporary') RETURNING id`, [`${stamp}-purge`]);
            const wsId = rows[0].id;
            // Force the deadline well past TTL+grace.
            await query(`UPDATE workspaces SET expires_at = $2 WHERE id = $1`, [wsId, Date.now() - 60 * 24 * 60 * 60 * 1000]);
            const before = await query('SELECT COUNT(*)::int AS n FROM guests');
            const report = await guestRepo.purgeExpired();
            expect(report.workspaces).to.be.greaterThanOrEqual(1);
            const after = await query('SELECT COUNT(*)::int AS n FROM workspaces WHERE id = $1', [wsId]);
            expect(after.rows[0].n).to.equal(0);
            expect((await query('SELECT COUNT(*)::int AS n FROM guests')).rows[0].n).to.be.at.most(before.rows[0].n);
        });

        it('14. purgeExpired keeps personal workspaces and fresh temporary ones', async () => {
            const { rows } = await query(`INSERT INTO workspaces (name, type) VALUES ($1, 'personal') RETURNING id`, [`${stamp}-keep-personal`]);
            const { rows: wt } = await query(`INSERT INTO workspaces (name, type, expires_at) VALUES ($1, 'temporary', $2) RETURNING id`, [`${stamp}-keep-temp`, Date.now() + 24 * 60 * 60 * 1000]);
            await guestRepo.purgeExpired();
            const alive = await query('SELECT id FROM workspaces WHERE id = ANY($1)', [[rows[0].id, wt[0].id]]);
            expect(alive.rows).to.have.length(2);
            await query('DELETE FROM workspaces WHERE id = ANY($1)', [[rows[0].id, wt[0].id]]);
        });
    });

    // ── guest helpers unit contract ─────────────────────────────────────

    describe('guestRepo primitives', () => {
        it('15. createGuest returns token + workspace + deadlines', async () => {
            const created = await guestRepo.createGuest({ workspaceTtlMs: 60_000, sessionTtlMs: 60_000 });
            expect(created.guestId).to.be.a('string');
            expect(created.token).to.be.a('string');
            expect(created.workspace.id).to.be.a('string');
            expect(created.workspace.type).to.equal('temporary');
            expect(created.workspaceExpiresAt).to.be.greaterThan(Date.now());
            expect(created.sessionExpiresAt).to.be.greaterThan(Date.now());
            await query('DELETE FROM guests WHERE guest_id = $1', [created.guestId]);
            await query('DELETE FROM workspaces WHERE id = $1', [created.workspace.id]);
        });

        it('16. findByToken resolves only the raw token (hash-only storage)', async () => {
            const created = await guestRepo.createGuest({ workspaceTtlMs: 60_000, sessionTtlMs: 60_000 });
            const found = await guestRepo.findByToken(created.token);
            expect(found).to.not.equal(null);
            expect(found.guest_id).to.equal(created.guestId);
            // A wrong raw token must not match (sha256 hash comparison).
            const wrong = await guestRepo.findByToken(created.token.replace(/.$/, 'x'));
            expect(wrong).to.equal(null);
            await query('DELETE FROM guests WHERE guest_id = $1', [created.guestId]);
            await query('DELETE FROM workspaces WHERE id = $1', [created.workspace.id]);
        });

        it('17. revokeByToken marks the guest unusable', async () => {
            const created = await guestRepo.createGuest({ workspaceTtlMs: 60_000, sessionTtlMs: 60_000 });
            await guestRepo.revokeByToken(created.token);
            const found = await guestRepo.findByToken(created.token);
            expect(found).to.equal(null); // revoked tokens never resolve
            await query('DELETE FROM workspaces WHERE id = $1', [created.workspace.id]);
        });
    });
});
