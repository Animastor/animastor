// ======================================================
// Private Worker Identity & Authentication Tests (Phase 1)
// ======================================================
// Security regression matrix for the Experimental Beta — Private Worker
// milestone, Phase 1 (Worker Identity & Authentication):
//
//   Registration
//     authenticated user can create a worker + one-time credential   201
//     credential never returned again (list/get)                     no token
//     duplicate registration → two distinct workers                  ok
//     invalid worker_type / missing name                             400
//     anonymous POST /api/v1/workers → 401, NO guest auto-provision  none
//     guests cannot create workers                                   401
//
//   Authentication boundary (requireWorkerAuth)
//     valid credential                                               200
//     missing credential                                              401
//     invalid credential (wrong secret)                               401
//     malformed / non-wrk token                                       401
//     revoked credential                                              401
//     forged worker_id in query/body → ignored (resolves from token) 200
//     forged workspace_id in body → ignored (server-resolved)       200
//     worker A's credential cannot authenticate as worker B           401
//     worker token is NOT a user session                             401 on user API
//     user session cookie is NOT a worker credential                  401
//
//   Lifecycle
//     revoke → immediate 401, idempotent (second revoke 404)         404
//     rotate → old token dies, new token works                       401/200
//     cross-workspace revoke/rotate → 404 (no existence oracle)      404
//     list is workspace-scoped (A never sees B's workers)             ok
//
//   Durability / hardening
//     token_hash is SHA-256 of the secret (64 hex), never the token
//     secret entropy ≥ 256 bits (32-byte decode)
//     deleting a workspace cascades its workers                       gone
//     Redis mirror: created cred present, revoked cred removed        ok
//
//   Legacy heartbeat safety
//     POST /api/v1/worker/heartbeat removed → 404, no DB churn       none

const { expect } = require('chai');
const express = require('express');
const crypto = require('crypto');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const { authContext } = require('../src/middleware/auth-context');
const { requireWorkerAuth } = require('../src/middleware/worker-auth-middleware');
const workerAuth = require('../src/services/worker-auth');
const workerRepo = require('../src/storage/postgres/repositories/worker-repo');
const { createMockRedis } = require('./mocks/redis-mock');

const stamp = `pwphase1${Date.now()}`;

function cookieOf(res) {
    const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const sid = set.find((c) => c.startsWith('animastor_sid='));
    return sid ? sid.split(';')[0] : null;
}

function buildApp(redis) {
    const registerAuthRoutes = require('../src/routes/auth-routes.cjs');
    const registerWorkerRoutes = require('../src/routes/worker-routes.cjs');

    const app = express();
    app.use(express.json());
    app.use(authContext);
    registerAuthRoutes(app, null, { utils: { log: () => {} } });
    registerWorkerRoutes(app, redis);

    // Worker-facing boundary under test (hub-facing shape, Phase 2 mounts the
    // same middleware). Outside /api/v1 so no guest auto-provision interferes.
    app.get('/gpu/__test/whoami', requireWorkerAuth(redis), (req, res) => {
        res.json({ worker: req.authenticatedWorker });
    });
    app.post('/gpu/__test/whoami', requireWorkerAuth(redis), (req, res) => {
        // Echo what the middleware resolved — the handler must NEVER use the
        // body/query identity, so this asserts the boundary ignores them.
        res.json({ worker: req.authenticatedWorker });
    });

    return app;
}

async function register(app, username) {
    const res = await fetch(`http://127.0.0.1:${app.__port}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'correct-horse-42', email: `${username}@test.local` }),
    });
    const body = await res.json();
    expect(res.status).to.equal(201);
    return { cookie: cookieOf(res), workspaceId: body.workspace.id };
}

async function createWorker(base, cookie, overrides = {}) {
    const res = await fetch(`${base}/api/v1/workers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'test-worker', worker_type: 'audio', ...overrides }),
    });
    return { res, body: await res.json() };
}

async function cleanup() {
    await query(`DELETE FROM workers WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE name LIKE '%${stamp}%' OR owner_user_id IN (
            SELECT user_id FROM users WHERE username LIKE 'pwphase1%'))`);
    await query(`DELETE FROM workspace_members WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE name LIKE '%${stamp}%' OR owner_user_id IN (
            SELECT user_id FROM users WHERE username LIKE 'pwphase1%'))`);
    await query(`DELETE FROM sessions WHERE user_id IN (
        SELECT user_id FROM users WHERE username LIKE 'pwphase1%')`);
    await query(`DELETE FROM workspaces WHERE name LIKE '%${stamp}%'`);
    await query(`DELETE FROM workspaces WHERE owner_user_id IN (
        SELECT user_id FROM users WHERE username LIKE 'pwphase1%')`);
    await query(`DELETE FROM users WHERE username LIKE 'pwphase1%'`);
}

async function countRows(table) {
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM ${table}`);
    return rows[0].n;
}

describe('Private worker identity & authentication (Phase 1)', () => {
    let server;
    let base;
    let redis;
    let alice; // workspace A
    let bob;   // workspace B
    let tokenA;
    let tokenB;

    before(async function() {
        this.timeout(60000);
        await runMigrations();
        await cleanup();
        redis = createMockRedis();

        const app = buildApp(redis);
        await new Promise((resolve) => {
            server = app.listen(0, () => {
                app.__port = server.address().port;
                base = `http://127.0.0.1:${app.__port}`;
                resolve();
            });
        });

        alice = await register(app, `pwphase1_alice_${Date.now()}`);
        bob = await register(app, `pwphase1_bob_${Date.now()}`);

        const cw = await createWorker(base, alice.cookie);
        expect(cw.res.status).to.equal(201);
        tokenA = cw.body.token;
        const cwB = await createWorker(base, bob.cookie);
        expect(cwB.res.status).to.equal(201);
        tokenB = cwB.body.token;
    });

    after(async function() {
        this.timeout(30000);
        if (server) server.close();
        await cleanup();
    });

    // ══════════════════════════════════════════════════════════════════
    // Registration & credential issuance
    // ══════════════════════════════════════════════════════════════════

    describe('registration', () => {
        it('issues a one-time credential and stores only its hash', async function() {
            const cw = await createWorker(base, alice.cookie, { name: 'entropy-check' });
            expect(cw.res.status).to.equal(201);
            const { worker, token } = cw.body;
            expect(worker.worker_id).to.be.a('string');
            expect(worker.workspace_id).to.equal(alice.workspaceId);
            expect(worker.mode).to.equal('private');
            expect(token).to.match(/^wrk\./);

            const { rows } = await query(`SELECT token_hash, token_prefix FROM workers WHERE worker_id = $1`, [worker.worker_id]);
            expect(rows).to.have.length(1);
            const storedHash = rows[0].token_hash;
            // hash-only storage: never the raw token
            expect(storedHash).to.not.equal(token);
            expect(storedHash).to.match(/^[0-9a-f]{64}$/); // sha256 hex

            // entropy: the secret part decodes to ≥32 bytes
            const parts = token.split('.');
            const secret = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
            expect(secret.length).to.be.gte(32);

            // display prefix never reveals the secret
            expect(rows[0].token_prefix).to.match(/^wrk_[A-Za-z0-9_-]{8}$/);
            expect(rows[0].token_prefix).to.not.equal(token);
        });

        it('rejects invalid worker_type and missing name', async () => {
            let cw = await createWorker(base, alice.cookie, { worker_type: 'upscale' });
            expect(cw.res.status).to.equal(400);
            cw = await createWorker(base, alice.cookie, { name: '' });
            expect(cw.res.status).to.equal(400);
        });

        it('duplicate registrations are distinct (two workers, two hashes)', async function() {
            const a = await createWorker(base, alice.cookie, { name: 'dup-a' });
            const b = await createWorker(base, alice.cookie, { name: 'dup-b' });
            expect(a.res.status).to.equal(201);
            expect(b.res.status).to.equal(201);
            expect(a.body.worker.worker_id).to.not.equal(b.body.worker.worker_id);
            expect(a.body.token).to.not.equal(b.body.token);
            const { rows } = await query(
                `SELECT token_hash FROM workers WHERE worker_id IN ($1, $2)`,
                [a.body.worker.worker_id, b.body.worker.worker_id]);
            expect(rows[0].token_hash).to.not.equal(rows[1].token_hash);
        });

        it('never returns the credential again (list)', async () => {
            const res = await fetch(`${base}/api/v1/workers`, { headers: { Cookie: alice.cookie } });
            expect(res.status).to.equal(200);
            const body = await res.json();
            const json = JSON.stringify(body);
            expect(json).to.not.contain(tokenA);
            for (const w of body.workers) {
                expect(w).to.not.have.property('token_hash');
                expect(w).to.not.have.property('token');
            }
        });

        it('anonymous POST does NOT auto-provision a guest/workspace (401)', async () => {
            const guestsBefore = await countRows('guests');
            const wsBefore = await countRows('workspaces');
            const res = await fetch(`${base}/api/v1/workers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'anon', worker_type: 'audio' }),
            });
            expect(res.status).to.equal(401);
            expect(await countRows('guests')).to.equal(guestsBefore);
            expect(await countRows('workspaces')).to.equal(wsBefore);
        });

        it('guests cannot create workers (401)', async () => {
            // Anonymous content write elsewhere provisions a guest cookie.
            const gres = await fetch(`${base}/api/v1/ai/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: 'none' }),
            });
            const gSet = typeof gres.headers.getSetCookie === 'function' ? gres.headers.getSetCookie() : [];
            const gCookie = gSet.find((c) => c.startsWith('animastor_gid='));
            expect(gCookie).to.be.a('string');
            const res = await fetch(`${base}/api/v1/workers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: gCookie },
                body: JSON.stringify({ name: 'guest-worker', worker_type: 'audio' }),
            });
            expect(res.status).to.equal(401);
        });

        it('forged workspace_id in the body is IGNORED (server-resolved)', async function() {
            const cw = await createWorker(base, alice.cookie, { workspace_id: bob.workspaceId });
            expect(cw.res.status).to.equal(201);
            expect(cw.body.worker.workspace_id).to.equal(alice.workspaceId);
            expect(cw.body.worker.workspace_id).to.not.equal(bob.workspaceId);
        });

        it('list is workspace-scoped (B never sees A workers)', async () => {
            const a = await (await fetch(`${base}/api/v1/workers`, { headers: { Cookie: alice.cookie } })).json();
            const b = await (await fetch(`${base}/api/v1/workers`, { headers: { Cookie: bob.cookie } })).json();
            const aIds = new Set(a.workers.map((w) => w.worker_id));
            for (const w of b.workers) {
                expect(aIds.has(w.worker_id)).to.equal(false);
            }
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Authentication boundary
    // ══════════════════════════════════════════════════════════════════

    describe('authentication boundary', () => {
        it('valid credential → ALLOW (identity carries workspace)', async () => {
            const res = await fetch(`${base}/gpu/__test/whoami`, {
                headers: { Authorization: `Bearer ${tokenA}` },
            });
            expect(res.status).to.equal(200);
            const { worker } = await res.json();
            expect(worker.id).to.be.a('string');
            expect(worker.workspace_id).to.equal(alice.workspaceId);
            expect(worker.mode).to.equal('private');
            expect(worker.worker_type).to.equal('audio');
        });

        it('missing credential → DENY 401', async () => {
            const res = await fetch(`${base}/gpu/__test/whoami`);
            expect(res.status).to.equal(401);
        });

        it('invalid credential (wrong secret) → DENY 401', async () => {
            const [p, id, ] = tokenA.split('.');
            const forged = `${p}.${id}.${Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef').toString('base64')}`;
            const res = await fetch(`${base}/gpu/__test/whoami`, {
                headers: { Authorization: `Bearer ${forged}` },
            });
            expect(res.status).to.equal(401);
        });

        it('non-wrk tokens (session/guest/garbage) → DENY 401', async () => {
            for (const tok of ['garbage', 'sid.abc.def', 'gst.abc.def', 'wrk.bad', 'wrk.notb64!.zz']) {
                const res = await fetch(`${base}/gpu/__test/whoami`, {
                    headers: { Authorization: `Bearer ${tok}` },
                });
                expect(res.status, `token ${tok}`).to.equal(401);
            }
        });

        it('revoked credential → DENY 401 (and revoke is idempotent-ish)', async function() {
            const cw = await createWorker(base, alice.cookie, { name: 'doomed' });
            const doomedToken = cw.body.token;
            const workerId = cw.body.worker.worker_id;

            const del = await fetch(`${base}/api/v1/workers/${workerId}`, {
                method: 'DELETE',
                headers: { Cookie: alice.cookie },
            });
            expect(del.status).to.equal(200);
            expect((await del.json()).revoked).to.equal(true);

            const res = await fetch(`${base}/gpu/__test/whoami`, {
                headers: { Authorization: `Bearer ${doomedToken}` },
            });
            expect(res.status).to.equal(401);

            // second revoke → 404 (unknown/revoked worker, no oracle)
            const again = await fetch(`${base}/api/v1/workers/${workerId}`, {
                method: 'DELETE',
                headers: { Cookie: alice.cookie },
            });
            expect(again.status).to.equal(404);
        });

        it('forged worker_id in query is IGNORED (identity from token only)', async () => {
            const cw = await createWorker(base, alice.cookie, { name: 'boundary' });
            const otherId = cw.body.worker.worker_id;
            const res = await fetch(`${base}/gpu/__test/whoami?worker_id=${otherId}`, {
                headers: { Authorization: `Bearer ${tokenA}` },
            });
            expect(res.status).to.equal(200);
            const { worker } = await res.json();
            expect(worker.id).to.not.equal(otherId);
        });

        it('forged worker_id / workspace_id in BODY are IGNORED', async () => {
            const cw = await createWorker(base, bob.cookie, { name: 'victim' });
            const victimId = cw.body.worker.worker_id;
            const res = await fetch(`${base}/gpu/__test/whoami`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
                body: JSON.stringify({ worker_id: victimId, workspace_id: bob.workspaceId }),
            });
            expect(res.status).to.equal(200);
            const { worker } = await res.json();
            expect(worker.id).to.not.equal(victimId);
            expect(worker.workspace_id).to.equal(alice.workspaceId);
            expect(worker.workspace_id).to.not.equal(bob.workspaceId);
        });

        it("worker A's credential cannot authenticate as worker B", async () => {
            // Self-locator points at B's worker_id, secret belongs to A:
            // the DB stores B's hash → secret mismatch → DENY.
            const bList = await (await fetch(`${base}/api/v1/workers`, { headers: { Cookie: bob.cookie } })).json();
            const bobWorkerId = bList.workers[0].worker_id;
            const [, , aSecret] = tokenA.split('.');
            const b64 = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            const forged = `wrk.${b64(Buffer.from(bobWorkerId, 'utf8'))}.${aSecret}`;
            const res = await fetch(`${base}/gpu/__test/whoami`, {
                headers: { Authorization: `Bearer ${forged}` },
            });
            expect(res.status).to.equal(401);
        });

        it('worker token is NOT a user session (user API → 401)', async () => {
            // A worker token on a user-only endpoint must never authenticate.
            const res = await fetch(`${base}/api/v1/workers`, {
                headers: { Authorization: `Bearer ${tokenA}` },
            });
            expect(res.status).to.equal(401);
        });

        it('user session cookie is NOT a worker credential (worker API → 401)', async () => {
            const res = await fetch(`${base}/gpu/__test/whoami`, {
                headers: { Cookie: alice.cookie },
            });
            expect(res.status).to.equal(401);
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Lifecycle: rotate / revoke / ownership
    // ══════════════════════════════════════════════════════════════════

    describe('lifecycle', () => {
        it('rotate: old token dies, new token works, returned once', async function() {
            const cw = await createWorker(base, alice.cookie, { name: 'rotator' });
            const oldToken = cw.body.token;
            const workerId = cw.body.worker.worker_id;

            const rot = await fetch(`${base}/api/v1/workers/${workerId}/rotate`, {
                method: 'POST',
                headers: { Cookie: alice.cookie },
            });
            expect(rot.status).to.equal(200);
            const { token: newToken } = await rot.json();
            expect(newToken).to.not.equal(oldToken);

            const oldRes = await fetch(`${base}/gpu/__test/whoami`, {
                headers: { Authorization: `Bearer ${oldToken}` },
            });
            expect(oldRes.status).to.equal(401);
            const newRes = await fetch(`${base}/gpu/__test/whoami`, {
                headers: { Authorization: `Bearer ${newToken}` },
            });
            expect(newRes.status).to.equal(200);
            expect((await newRes.json()).worker.id).to.equal(workerId);

            // new token appears once — never in list
            const list = await (await fetch(`${base}/api/v1/workers`, { headers: { Cookie: alice.cookie } })).text();
            expect(list).to.not.contain(newToken);
        });

        it('cross-workspace revoke/rotate → 404 (no existence oracle)', async () => {
            const cw = await createWorker(base, bob.cookie, { name: 'bob-private' });
            const workerId = cw.body.worker.worker_id;
            const del = await fetch(`${base}/api/v1/workers/${workerId}`, {
                method: 'DELETE',
                headers: { Cookie: alice.cookie },
            });
            expect(del.status).to.equal(404);
            const rot = await fetch(`${base}/api/v1/workers/${workerId}/rotate`, {
                method: 'POST',
                headers: { Cookie: alice.cookie },
            });
            expect(rot.status).to.equal(404);
        });

        it('non-UUID worker id → 404 (no 500)', async () => {
            const del = await fetch(`${base}/api/v1/workers/not-a-uuid`, {
                method: 'DELETE',
                headers: { Cookie: alice.cookie },
            });
            expect(del.status).to.equal(404);
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Durability & mirror
    // ══════════════════════════════════════════════════════════════════

    describe('durability & Redis auth mirror', () => {
        it('workspace deletion cascades workers', async function() {
            const { rows: wsRows } = await query(`SELECT id FROM workspaces WHERE id = $1`, [bob.workspaceId]);
            if (wsRows[0]) {
                // bob's workers must disappear when his workspace goes.
                const { rows: before } = await query(`SELECT worker_id FROM workers WHERE workspace_id = $1`, [bob.workspaceId]);
                await query(`DELETE FROM workspaces WHERE id = $1`, [bob.workspaceId]);
                const { rows: after } = await query(`SELECT worker_id FROM workers WHERE workspace_id = $1`, [bob.workspaceId]);
                expect(before.length).to.be.gte(1);
                expect(after.length).to.equal(0);
            }
        });

        it('mirror: created credential present, revoked credential removed', async () => {
            // rebuild from PG first (idempotent baseline)
            const { synced } = await workerAuth.syncWorkerAuthMirror(redis);
            expect(synced).to.be.a('number');
            const cw = await createWorker(base, alice.cookie, { name: 'mirror-w' });
            const workerId = cw.body.worker.worker_id;
            const hash = workerRepo.parseToken(cw.body.token).secretHash;
            const raw = await redis.hget(workerAuth.WORKER_AUTH_MIRROR_KEY, hash);
            expect(raw).to.be.a('string');
            const parsed = JSON.parse(raw);
            expect(parsed.worker_id).to.equal(workerId);

            await fetch(`${base}/api/v1/workers/${workerId}`, { method: 'DELETE', headers: { Cookie: alice.cookie } });
            const gone = await redis.hget(workerAuth.WORKER_AUTH_MIRROR_KEY, hash);
            expect(gone).to.equal(null);
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Legacy heartbeat safety
    // ══════════════════════════════════════════════════════════════════

    describe('legacy heartbeat safety', () => {
        it('POST /api/v1/worker/heartbeat is GONE (404) and creates no rows', async () => {
            const guestsBefore = await countRows('guests');
            const wsBefore = await countRows('workspaces');
            const res = await fetch(`${base}/api/v1/worker/heartbeat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'audio', worker_id: 'legacy-x' }),
            });
            expect(res.status).to.equal(404);
            expect(await countRows('guests')).to.equal(guestsBefore);
            expect(await countRows('workspaces')).to.equal(wsBefore);
        });

        it('legacy status/counts endpoints remain mounted in the real app', async () => {
            // The test harness mounts only auth + worker routes (generation
            // routes are not part of this boundary), so assert route removal
            // coverage differently: the heartbeat POST must 404; the read-only
            // status/counts endpoints are preserved in generation-routes.cjs.
            const genRoutes = require('../src/routes/generation-routes.cjs').toString();
            expect(genRoutes).to.contain("app.get('/api/v1/worker/status'");
            expect(genRoutes).to.contain("app.get('/api/v1/worker/counts'");
            expect(genRoutes).to.not.contain("app.post('/api/v1/worker/heartbeat'");
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Token construction internals
    // ══════════════════════════════════════════════════════════════════

    describe('token internals', () => {
        it('parseToken rejects malformed / wrong-prefix tokens', () => {
            expect(workerRepo.parseToken('wrk')).to.equal(null);
            expect(workerRepo.parseToken('sid.aa.bb')).to.equal(null);
            expect(workerRepo.parseToken('wrk.aa')).to.equal(null);
            expect(workerRepo.parseToken('wrk.aa.bb.cc')).to.equal(null);
            expect(workerRepo.parseToken('wrk.notb64.!')).to.equal(null);
            expect(workerRepo.parseToken(123)).to.equal(null);
            expect(workerRepo.parseToken(null)).to.equal(null);
        });

        it('authenticateWorker fails closed without PG reachability issues exposed', async () => {
            // Valid token must resolve; an unknown token must not.
            const who = await workerAuth.authenticateWorker(null, tokenA);
            expect(who).to.be.an('object');
            expect(who.workspace_id).to.equal(alice.workspaceId);
            const nobody = await workerAuth.authenticateWorker(null, 'wrk.abc.def');
            expect(nobody).to.equal(null);
        });
    });
});