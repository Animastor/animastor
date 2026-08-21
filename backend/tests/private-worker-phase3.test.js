// ======================================================
// Private Worker Management Tests (Experimental Beta — Phase 3)
// ======================================================
// Regression matrix for the worker MANAGEMENT surface (the Phase 1 auth
// boundary is exercised by private-worker-auth.test.js; this suite focuses
// on the Phase 3 list/detail/lifecycle authorization + the OPERATIONAL
// STATUS derivation that turns the backend into a usable capability):
//
//   List
//     authenticated user lists own workers                       200 + own only
//     list never carries credentials / token_hash / secrets      none
//     cannot list another workspace's workers (cross-isolation) own only
//     anonymous list → 401, no guest auto-provision              none
//
//   Create
//     create worker in CALLER's workspace (workspace_id ignored) own
//     one-time credential returned on create, never again        token×once
//     invalid worker_type / missing name                         400
//
//   Detail
//     GET own worker → 200, safe shape, no secrets                ok
//     GET foreign worker → 404 (no existence oracle)             404
//     GET own revoked worker → REVOKED status + no secrets      ok
//
//   Rotate
//     rotate own worker: old credential dies, new works         200 + 401
//     new credential returned ONCE, never in list/get           none
//     cannot rotate another workspace's worker → 404            404
//
//   Revoke
//     revoke own worker: immediately cannot authenticate         401 after
//     cannot revoke another workspace's worker → 404            404
//     revoked worker remains visible (soft delete) in list       ok
//
//   Operational status (derived, never authoritative)
//     no heartbeat → OFFLINE                                     OFFLINE
//     live heartbeat key → ONLINE                                ONLINE
//     revoked → REVOKED (status regardless of heartbeat)         REVOKED
//     status derivation never exposes token_hash                 none

const { expect } = require('chai');
const express = require('express');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const { authContext } = require('../src/middleware/auth-context');
const { requireWorkerAuth } = require('../src/middleware/worker-auth-middleware');
const config = require('../src/config/runtime-config');
const { createMockRedis } = require('./mocks/redis-mock');

const stamp = `pwphase3${Date.now()}`;

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

    // Worker-facing boundary (same shape the hub uses) — to assert that a
    // revoked credential cannot authenticate after revoke.
    app.get('/gpu/__test/whoami', requireWorkerAuth(redis), (req, res) => {
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
        body: JSON.stringify({ name: 'phase3-worker', worker_type: 'audio', ...overrides }),
    });
    return { res, body: await res.json() };
}

async function listWorkers(base, cookie) {
    const res = await fetch(`${base}/api/v1/workers`, { headers: { Cookie: cookie } });
    return { res, body: await res.json() };
}

async function getWorker(base, cookie, workerId) {
    const res = await fetch(`${base}/api/v1/workers/${workerId}`, { headers: { Cookie: cookie } });
    return { res, body: await res.json() };
}

async function destroy(base, cookie, workerId) {
    const res = await fetch(`${base}/api/v1/workers/${workerId}`, { method: 'DELETE', headers: { Cookie: cookie } });
    return { res, body: await res.json() };
}

async function cleanup() {
    await query(`DELETE FROM workers WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE owner_user_id IN (
            SELECT user_id FROM users WHERE username LIKE 'pwphase3%'))`);
    await query(`DELETE FROM workspace_members WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE owner_user_id IN (
            SELECT user_id FROM users WHERE username LIKE 'pwphase3%'))`);
    await query(`DELETE FROM sessions WHERE user_id IN (
        SELECT user_id FROM users WHERE username LIKE 'pwphase3%')`);
    await query(`DELETE FROM workspaces WHERE owner_user_id IN (
        SELECT user_id FROM users WHERE username LIKE 'pwphase3%')`);
    await query(`DELETE FROM users WHERE username LIKE 'pwphase3%'`);
}

/** Write the live heartbeat key (animastor:worker:heartbeat:<type>:<id>)
 *  exactly as the GPU hub's /beacon handler does. */
function writeHeartbeat(redis, workerType, workerId, ts = Date.now()) {
    const key = config.WORKER_HEARTBEAT_KEY(workerType, workerId);
    const payload = JSON.stringify({ type: workerType, worker_id: workerId, ts });
    return redis.set(key, payload, 'EX', config.WORKER_HEARTBEAT_TTL);
}

async function countRows(table) {
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM ${table}`);
    return rows[0].n;
}

describe('Private worker management (Phase 3)', () => {
    let server;
    let base;
    let redis;
    let alice;    // workspace A
    let bob;      // workspace B
    let aliceWorker; // a worker created in alice's workspace
    let aliceToken;  // its one-time credential

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

        alice = await register(app, `pwphase3_alice_${Date.now()}`);
        bob = await register(app, `pwphase3_bob_${Date.now() + 1}`);

        const cw = await createWorker(base, alice.cookie, { name: 'alice-audio' });
        expect(cw.res.status).to.equal(201);
        aliceWorker = cw.body.worker;
        aliceToken = cw.body.token;
    });

    after(async function() {
        this.timeout(30000);
        if (server) server.close();
        await cleanup();
    });

    // ══════════════════════════════════════════════════════════════════
    // List
    // ══════════════════════════════════════════════════════════════════

    describe('list', () => {
        it('lists own workers and never leaks credentials/secrets', async () => {
            const { res, body } = await listWorkers(base, alice.cookie);
            expect(res.status).to.equal(200);
            const ids = body.workers.map((w) => w.worker_id);
            expect(ids).to.contain(aliceWorker.worker_id);
            const json = JSON.stringify(body);
            expect(json).to.not.contain(aliceToken);
            for (const w of body.workers) {
                expect(w).to.not.have.property('token_hash');
                expect(w).to.not.have.property('token');
                // safe metadata only
                expect(w).to.have.property('worker_id');
                expect(w).to.have.property('name');
                expect(w).to.have.property('worker_type');
                expect(w).to.have.property('mode');
                expect(w).to.have.property('status');
                expect(w).to.have.property('created_at');
            }
        });

        it('cannot list another workspace workers (cross-isolation)', async () => {
            const [{ body: a }, { body: b }] = await Promise.all([
                listWorkers(base, alice.cookie),
                listWorkers(base, bob.cookie),
            ]);
            const aIds = new Set(a.workers.map((w) => w.worker_id));
            for (const w of b.workers) {
                expect(aIds.has(w.worker_id)).to.equal(false);
            }
            expect(b.workers.map((w) => w.worker_id)).to.not.contain(aliceWorker.worker_id);
        });

        it('anonymous list → 401 and no guest auto-provision', async () => {
            const guestsBefore = await countRows('guests');
            const res = await fetch(`${base}/api/v1/workers`);
            expect(res.status).to.equal(401);
            expect(await countRows('guests')).to.equal(guestsBefore);
        });

        it('worker Bearer token is NOT a user session (list → 401)', async () => {
            const res = await fetch(`${base}/api/v1/workers`, {
                headers: { Authorization: `Bearer ${aliceToken}` },
            });
            expect(res.status).to.equal(401);
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Create
    // ══════════════════════════════════════════════════════════════════

    describe('create', () => {
        it('creates in the CALLER workspace (workspace_id in body ignored)', async () => {
            const cw = await createWorker(base, alice.cookie, {
                name: 'forced-ws', worker_type: 'image', workspace_id: bob.workspaceId,
            });
            expect(cw.res.status).to.equal(201);
            expect(cw.body.worker.workspace_id).to.equal(alice.workspaceId);
            expect(cw.body.worker.workspace_id).to.not.equal(bob.workspaceId);
        });

        it('returns the credential exactly ONCE (never again by list/get)', async () => {
            const cw = await createWorker(base, alice.cookie, { name: 'once-token', worker_type: 'video' });
            expect(cw.res.status).to.equal(201);
            const token = cw.body.token;
            expect(token).to.match(/^wrk\./);
            const list = await (await fetch(`${base}/api/v1/workers`, { headers: { Cookie: alice.cookie } })).text();
            expect(list).to.not.contain(token);
            const detail = await getWorker(base, alice.cookie, cw.body.worker.worker_id);
            expect(JSON.stringify(detail.body)).to.not.contain(token);
        });

        it('rejects invalid worker_type / missing name', async () => {
            let cw = await createWorker(base, alice.cookie, { worker_type: 'quantum' });
            expect(cw.res.status).to.equal(400);
            cw = await createWorker(base, alice.cookie, { name: '' });
            expect(cw.res.status).to.equal(400);
       });
    });

    // ══════════════════════════════════════════════════════════════════
    // Detail
    // ══════════════════════════════════════════════════════════════════

    describe('detail', () => {
        it('GET own worker → safe shape, no secrets', async () => {
            const { res, body } = await getWorker(base, alice.cookie, aliceWorker.worker_id);
            expect(res.status).to.equal(200);
            const w = body.worker;
            expect(w.worker_id).to.equal(aliceWorker.worker_id);
            expect(w.workspace_id).to.equal(alice.workspaceId);
            expect(w).to.not.have.property('token_hash');
            expect(w).to.not.have.property('token');
            expect(w.name).to.equal('alice-audio');
            expect(w.worker_type).to.equal('audio');
            expect(w.mode).to.equal('private');
        });

        it('GET foreign worker → 404 (no existence oracle)', async () => {
            const own = await getWorker(base, alice.cookie, aliceWorker.worker_id);
            expect(own.res.status).to.equal(200);
            const foreign = await getWorker(base, bob.cookie, aliceWorker.worker_id);
            expect(foreign.res.status).to.equal(404);
        });

        it('non-UUID worker id → 404 (no 500)', async () => {
            const { res } = await getWorker(base, alice.cookie, 'not-a-uuid');
            expect(res.status).to.equal(404);
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Rotate
    // ══════════════════════════════════════════════════════════════════

    describe('rotate', () => {
        it('rotate own worker: old credential dies, new works, new shown once', async () => {
            const cw = await createWorker(base, alice.cookie, { name: 'rotate-x', worker_type: 'audio' });
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

            const detail = await getWorker(base, alice.cookie, workerId);
            expect(JSON.stringify(detail.body)).to.not.contain(newToken);
            expect(JSON.stringify(detail.body)).to.not.contain(oldToken);
        });

        it('cannot rotate another workspace worker → 404', async () => {
            const cw = await createWorker(base, bob.cookie, { name: 'bob-rotate', worker_type: 'image' });
            const workerId = cw.body.worker.worker_id;
            const rot = await fetch(`${base}/api/v1/workers/${workerId}/rotate`, {
                method: 'POST',
                headers: { Cookie: alice.cookie },
            });
            expect(rot.status).to.equal(404);
            // bob's own worker STILL works after alice's failed rotate attempt
            const verified = await redis.hget('animastor:worker-auth',
                require('../src/storage/postgres/repositories/worker-repo').parseToken(cw.body.token).secretHash);
            expect(verified).to.be.a('string');
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Revoke
    // ══════════════════════════════════════════════════════════════════

    describe('revoke', () => {
        it('revoke own worker: credential immediately cannot authenticate', async () => {
            const cw = await createWorker(base, alice.cookie, { name: 'revoke-me', worker_type: 'audio' });
            const token = cw.body.token;
            const workerId = cw.body.worker.worker_id;

            const before = await fetch(`${base}/gpu/__test/whoami`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(before.status).to.equal(200);

            const { res, body } = await destroy(base, alice.cookie, workerId);
            expect(res.status).to.equal(200);
            expect(body.revoked).to.equal(true);

            const after = await fetch(`${base}/gpu/__test/whoami`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(after.status).to.equal(401);
        });

        it('cannot revoke another workspace worker → 404', async () => {
            const cw = await createWorker(base, bob.cookie, { name: 'bob-revoke', worker_type: 'image' });
            const workerId = cw.body.worker.worker_id;
            const { res } = await destroy(base, alice.cookie, workerId);
            expect(res.status).to.equal(404);
            // bob's worker is still alive
            const bobDetail = await getWorker(base, bob.cookie, workerId);
            expect(bobDetail.res.status).to.equal(200);
            expect(bobDetail.body.worker.revoked_at).to.equal(null);
        });

        it('revoked worker remains visible (soft delete) with REVOKED status', async () => {
            const cw = await createWorker(base, alice.cookie, { name: 'soft-delete', worker_type: 'video' });
            const workerId = cw.body.worker.worker_id;
            const { res } = await destroy(base, alice.cookie, workerId);
            expect(res.status).to.equal(200);

            const list = await listWorkers(base, alice.cookie);
            const w = list.body.workers.find((x) => x.worker_id === workerId);
            expect(w).to.exist;
            expect(w.status).to.equal('REVOKED');
            expect(w.revoked_at).to.be.a('number');
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Operational status (derived, never authoritative)
    // ══════════════════════════════════════════════════════════════════

    describe('operational status derivation', () => {
        it('no heartbeat → OFFLINE', async () => {
            const cw = await createWorker(base, alice.cookie, { name: 'cold', worker_type: 'audio' });
            const detail = await getWorker(base, alice.cookie, cw.body.worker.worker_id);
            expect(detail.body.worker.status).to.equal('OFFLINE');
        });

        it('live heartbeat key → ONLINE', async () => {
            const cw = await createWorker(base, alice.cookie, { name: 'hot', worker_type: 'image' });
            const workerId = cw.body.worker.worker_id;
            await writeHeartbeat(redis, 'image', workerId);
            const detail = await getWorker(base, alice.cookie, workerId);
            expect(detail.body.worker.status).to.equal('ONLINE');
            expect(detail.body.worker.last_seen).to.be.a('number');
        });

        it('expired/missing heartbeat → OFFLINE', async () => {
            const cw = await createWorker(base, alice.cookie, { name: 'expired', worker_type: 'audio' });
            const workerId = cw.body.worker.worker_id;
            await writeHeartbeat(redis, 'audio', workerId);
            await redis.del(config.WORKER_HEARTBEAT_KEY('audio', workerId));
            const detail = await getWorker(base, alice.cookie, workerId);
            expect(detail.body.worker.status).to.equal('OFFLINE');
        });

        it('revoked → REVOKED regardless of heartbeat', async () => {
            const cw = await createWorker(base, alice.cookie, { name: 'rev-then-hb', worker_type: 'video' });
            const workerId = cw.body.worker.worker_id;
            await writeHeartbeat(redis, 'video', workerId);
            const live = await getWorker(base, alice.cookie, workerId);
            expect(live.body.worker.status).to.equal('ONLINE');
            await destroy(base, alice.cookie, workerId);
            const after = await getWorker(base, alice.cookie, workerId);
            expect(after.body.worker.status).to.equal('REVOKED');
        });

        it('list carries the derived status too', async () => {
            const cw = await createWorker(base, alice.cookie, { name: 'list-status', worker_type: 'audio' });
            await writeHeartbeat(redis, 'audio', cw.body.worker.worker_id);
            const list = await listWorkers(base, alice.cookie);
            const w = list.body.workers.find((x) => x.worker_id === cw.body.worker.worker_id);
            expect(w.status).to.equal('ONLINE');
        });

        it('status derivation never exposes token_hash', async () => {
            const cw = await createWorker(base, alice.cookie, { name: 'no-leak', worker_type: 'audio' });
            const detail = await getWorker(base, alice.cookie, cw.body.worker.worker_id);
            expect(detail.body.worker).to.not.have.property('token_hash');
        });
    });
});
