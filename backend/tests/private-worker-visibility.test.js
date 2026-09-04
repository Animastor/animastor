// ======================================================
// Private Worker Visibility & Isolation Tests (Experimental Beta)
// ======================================================
// Regression matrix for the visibility invariant:
//
//   "A heartbeat alone NEVER makes a worker available to the current user."
//
// Every worker has two independent characteristics:
//   1. liveness     — ONLINE/OFFLINE (fresh heartbeat key);
//   2. access scope — SYSTEM / PRIVATE / SHARE (hub-authored heartbeat payload:
//      workspace_id + mode).
//
//   worker-health classification (PW-4 fail-closed)
//     heartbeat without mode → UNAUTHORIZED, counted NOWHERE             ok
//     system-mode heartbeat → global capacity                            ok
//     private heartbeat w/o workspace → UNAUTHORIZED, counted NOWHERE    ok
//     private heartbeat → NEVER in global count                          ok
//     private heartbeat → counted ONLY for its owning workspace          ok
//     foreign workspace private heartbeat → invisible everywhere else    ok
//     share-mode heartbeat → global pool (community capacity)            ok
//     busy counts follow the same scope split                            ok
//     stale/corrupt heartbeats ignored                                   ok
//     isAvailable: system serves everyone, private only the owner        ok
//
//   gpu-hub authored scope (PW-4 fail-closed)
//     credentialed beacon → heartbeat carries workspace_id + mode        ok
//     beacon WITHOUT credential → 401, no heartbeat, no registration     ok
//     claim binds worker_mode; busy heartbeat keeps scope                ok
//
//   /worker/counts acceptance (User A vs User B)
//     A's private worker ONLINE → NOT in B's global count                ok
//     A's private worker ONLINE → NOT in anonymous/global count          ok
//     A sees own private worker separately (private_audio)               ok
//     system worker counts for everyone                                  ok
//     B's worker list never contains A's worker                          ok
//     B's dispatch routing never selects A's private worker              ok
//     worker stop → OFFLINE only for A; system pool unchanged            ok
//
//   workspace-aware availability gating
//     detectAvailableMode: owner's private workers count for the book,
//     foreign private workers do NOT                                     ok

const { expect } = require('chai');
const express = require('express');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const { authContext } = require('../src/middleware/auth-context');
const config = require('../src/config/runtime-config');
const workerHealth = require('../src/runtime/worker-health');
const workerAuth = require('../src/services/worker-auth');
const workerRepo = require('../src/storage/postgres/repositories/worker-repo');
const { createMockRedis } = require('./mocks/redis-mock');

const hub = require('../../gpu-hub/gpu-hub');
const { buildHubApp, PROTOCOL_VERSION } = hub;

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';

/** Write a heartbeat exactly as the GPU hub does (scope fields included). */
function writeHeartbeat(redis, type, workerId, { workspaceId = null, mode = null, currentJobId = null, ts = Date.now() } = {}) {
    const payload = JSON.stringify({
        type,
        worker_id: workerId,
        ts,
        current_job_id: currentJobId,
        workspace_id: workspaceId,
        mode,
    });
    return redis.set(config.WORKER_HEARTBEAT_KEY(type, workerId), payload, 'EX', config.WORKER_HEARTBEAT_TTL);
}

// ══════════════════════════════════════════════════════════════════════════
// worker-health: scope classification
// ══════════════════════════════════════════════════════════════════════════

describe('Worker visibility — worker-health scope classification', () => {
    let redis;

    beforeEach(() => {
        redis = createMockRedis();
    });

    it('PW-4 FAIL CLOSED: a heartbeat without mode is UNAUTHORIZED — counted nowhere', async () => {
        // The old legacy payload shape — no workspace_id/mode keys at all.
        // Defense-in-depth: even if such a heartbeat ever appears again, it
        // must never become SYSTEM or SHARE capacity.
        await redis.set(
            config.WORKER_HEARTBEAT_KEY('audio', 'gpu-legacy-1'),
            JSON.stringify({ type: 'audio', worker_id: 'gpu-legacy-1', ts: Date.now() }),
            'EX', config.WORKER_HEARTBEAT_TTL
        );
        expect(await workerHealth.getAliveCount(redis, 'audio')).to.equal(0);
        expect(await workerHealth.getPrivateAliveCount(redis, 'audio', WS_A)).to.equal(0);
        expect(await workerHealth.isAvailable(redis, 'audio')).to.equal(false);
        expect(await workerHealth.isAvailable(redis, 'audio', WS_A)).to.equal(false);
    });

    it('counts a system-mode heartbeat as global capacity', async () => {
        await writeHeartbeat(redis, 'audio', 'sys-op-1', { mode: 'system' });
        expect(await workerHealth.getAliveCount(redis, 'audio')).to.equal(1);
        expect(await workerHealth.getPrivateAliveCount(redis, 'audio', WS_A)).to.equal(0);
        expect(await workerHealth.isAvailable(redis, 'audio')).to.equal(true);
    });

    it('a private heartbeat without workspace_id is UNAUTHORIZED — counted nowhere', async () => {
        await writeHeartbeat(redis, 'audio', 'broken-priv', { mode: 'private' });
        expect(await workerHealth.getAliveCount(redis, 'audio')).to.equal(0);
        expect(await workerHealth.getPrivateAliveCount(redis, 'audio', WS_A)).to.equal(0);
    });

    it('NEVER counts a private heartbeat in the global count', async () => {
        await writeHeartbeat(redis, 'audio', 'worker-a', { workspaceId: WS_A, mode: 'private' });
        expect(await workerHealth.getAliveCount(redis, 'audio')).to.equal(0);
        const status = await workerHealth.getStatus(redis);
        expect(status.audio).to.equal(0);
        expect(status.image).to.equal(0);
        expect(status.video).to.equal(0);
    });

    it('counts a private heartbeat ONLY for its owning workspace', async () => {
        await writeHeartbeat(redis, 'audio', 'worker-a', { workspaceId: WS_A, mode: 'private' });
        expect(await workerHealth.getPrivateAliveCount(redis, 'audio', WS_A)).to.equal(1);
        expect(await workerHealth.getPrivateAliveCount(redis, 'audio', WS_B)).to.equal(0);
        expect(await workerHealth.getPrivateAliveCount(redis, 'audio', null)).to.equal(0);
    });

    it('counts a share-mode heartbeat in the global pool (future share seam)', async () => {
        await writeHeartbeat(redis, 'image', 'worker-share', { workspaceId: WS_A, mode: 'share' });
        expect(await workerHealth.getAliveCount(redis, 'image')).to.equal(1);
        // Share is never "private" — not even for the owner workspace.
        expect(await workerHealth.getPrivateAliveCount(redis, 'image', WS_A)).to.equal(0);
    });

    it('busy counts follow the same scope split', async () => {
        await writeHeartbeat(redis, 'audio', 'sys-1', { mode: 'system', currentJobId: 'job-1' });
        await writeHeartbeat(redis, 'audio', 'priv-a', { workspaceId: WS_A, mode: 'private', currentJobId: 'job-2' });
        await writeHeartbeat(redis, 'audio', 'priv-a-idle', { workspaceId: WS_A, mode: 'private' });

        expect(await workerHealth.getBusyCount(redis, 'audio')).to.equal(1);
        expect(await workerHealth.getPrivateBusyCount(redis, 'audio', WS_A)).to.equal(1);
        expect(await workerHealth.getPrivateBusyCount(redis, 'audio', WS_B)).to.equal(0);
    });

    it('getAvailability returns system + own-private buckets in one pass', async () => {
        await writeHeartbeat(redis, 'audio', 'sys-1', { mode: 'system' });
        await writeHeartbeat(redis, 'audio', 'priv-a', { workspaceId: WS_A, mode: 'private' });
        await writeHeartbeat(redis, 'video', 'priv-a-v', { workspaceId: WS_A, mode: 'private' });

        const forA = await workerHealth.getAvailability(redis, WS_A);
        expect(forA.system.audio).to.equal(1);
        expect(forA.private.audio).to.equal(1);
        expect(forA.private.video).to.equal(1);
        expect(forA.private.image).to.equal(0);

        const forB = await workerHealth.getAvailability(redis, WS_B);
        expect(forB.system.audio).to.equal(1);
        expect(forB.private.audio).to.equal(0);
        expect(forB.private.video).to.equal(0);

        const anon = await workerHealth.getAvailability(redis, null);
        expect(anon.system.audio).to.equal(1);
        expect(anon.private.audio).to.equal(0);
    });

    it('ignores stale and corrupt heartbeats', async () => {
        const staleTs = Date.now() - (config.WORKER_HEARTBEAT_TTL + 5) * 1000;
        await writeHeartbeat(redis, 'audio', 'stale-sys', { ts: staleTs });
        await writeHeartbeat(redis, 'audio', 'stale-priv', { workspaceId: WS_A, mode: 'private', ts: staleTs });
        await redis.set(config.WORKER_HEARTBEAT_KEY('audio', 'corrupt'), '{not-json', 'EX', config.WORKER_HEARTBEAT_TTL);

        expect(await workerHealth.getAliveCount(redis, 'audio')).to.equal(0);
        expect(await workerHealth.getPrivateAliveCount(redis, 'audio', WS_A)).to.equal(0);
    });

    it('isAvailable: system serves everyone; private only the owner', async () => {
        await writeHeartbeat(redis, 'video', 'priv-a', { workspaceId: WS_A, mode: 'private' });

        // No system worker: anonymous and foreign workspaces see NOTHING.
        expect(await workerHealth.isAvailable(redis, 'video')).to.equal(false);
        expect(await workerHealth.isAvailable(redis, 'video', WS_B)).to.equal(false);
        // The owner's own private worker IS available to the owner.
        expect(await workerHealth.isAvailable(redis, 'video', WS_A)).to.equal(true);

        // A system worker becomes available to everyone (owner included).
        await writeHeartbeat(redis, 'video', 'sys-1', { mode: 'system' });
        expect(await workerHealth.isAvailable(redis, 'video')).to.equal(true);
        expect(await workerHealth.isAvailable(redis, 'video', WS_B)).to.equal(true);
        expect(await workerHealth.isAvailable(redis, 'video', WS_A)).to.equal(true);
    });
});

// ══════════════════════════════════════════════════════════════════════════
// gpu-hub: heartbeats carry the token-derived scope
// ══════════════════════════════════════════════════════════════════════════

describe('Worker visibility — gpu-hub authored heartbeat scope', () => {
    const WORKER_A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    let h;
    let tokenA1;

    async function startHub() {
        const redis = createMockRedis();
        const app = buildHubApp({
            redis,
            config: { BACKEND_URL: 'http://backend.test', GPU_HUB_API_KEY: 'hub-key' },
            fetchImpl: async () => ({ ok: true, status: 200 }),
            intervals: false,
        });
        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        return {
            redis, app, server,
            base: `http://127.0.0.1:${server.address().port}`,
            stop: () => new Promise((r) => server.close(r)),
        };
    }

    function makeToken(workerId) {
        const crypto = require('crypto');
        const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const secret = crypto.randomBytes(32);
        return {
            token: `wrk.${b64url(Buffer.from(String(workerId), 'utf8'))}.${b64url(secret)}`,
            hash: crypto.createHash('sha256').update(secret).digest('hex'),
        };
    }

    beforeEach(async () => {
        h = await startHub();
        const { token, hash } = makeToken(WORKER_A1);
        tokenA1 = token;
        await h.redis.hset('animastor:worker-auth', hash, JSON.stringify({
            worker_id: WORKER_A1,
            workspace_id: WS_A,
            worker_type: 'audio',
            mode: 'private',
            name: 'scoped-worker',
        }));
    });

    afterEach(async () => {
        if (h) await h.stop();
    });

    it('credentialed beacon writes a heartbeat WITH workspace_id + mode', async () => {
        const res = await fetch(`${h.base}/beacon`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA1}` },
            body: JSON.stringify({ id: 'forged', type: 'video', protocol_version: PROTOCOL_VERSION }),
        });
        expect(res.status).to.equal(200);

        const raw = await h.redis.get(config.WORKER_HEARTBEAT_KEY('audio', WORKER_A1));
        expect(raw).to.be.a('string');
        const hb = JSON.parse(raw);
        expect(hb.workspace_id).to.equal(WS_A);
        expect(hb.mode).to.equal('private');
    });

    it('PW-4 FAIL CLOSED: beacon without credential → 401, no heartbeat, no registration', async () => {
        const res = await fetch(`${h.base}/beacon`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 'gpu-legacy-1', type: 'audio', protocol_version: PROTOCOL_VERSION }),
        });
        expect(res.status).to.equal(401);
        expect((await res.json()).error).to.equal('worker_authentication_failed');

        // Nothing was written — the uncredentialed worker is UNAUTHORIZED,
        // never SYSTEM.
        expect(await h.redis.get(config.WORKER_HEARTBEAT_KEY('audio', 'gpu-legacy-1'))).to.equal(null);
        expect(await h.redis.hget('animastor:gpu-hub:workers', 'gpu-legacy-1')).to.equal(null);
        expect(await workerHealth.getAliveCount(h.redis, 'audio')).to.equal(0);
    });

    it('claim keeps scope: running record carries worker_mode, busy heartbeat keeps scope', async () => {
        await fetch(`${h.base}/beacon`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA1}` },
            body: JSON.stringify({ protocol_version: PROTOCOL_VERSION }),
        });
        await fetch(`${h.base}/task`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': 'hub-key' },
            body: JSON.stringify({
                job_id: 'bookA_ch1_sc1_0001:audio',
                params: {},
                job_type: 'audio',
                build_id: 'b1',
                protocol_version: PROTOCOL_VERSION,
                dispatch_id: 'd-vis-1',
                book_id: 'bookA',
                chapter_id: 'ch1',
                scene_id: 'sc1',
                stage: 'audio',
                workspace_id: WS_A,
            }),
        });

        const next = await fetch(`${h.base}/task/next?worker=${WORKER_A1}&type=audio`, {
            headers: { Authorization: `Bearer ${tokenA1}` },
        });
        expect(next.status).to.equal(200);
        expect((await next.json()).task.job_id).to.equal('bookA_ch1_sc1_0001:audio');

        const running = JSON.parse(await h.redis.hget('animastor:running', 'bookA_ch1_sc1_0001:audio'));
        expect(running.worker_mode).to.equal('private');
        expect(running.workspace_id).to.equal(WS_A);

        const hb = JSON.parse(await h.redis.get(config.WORKER_HEARTBEAT_KEY('audio', WORKER_A1)));
        expect(hb.current_job_id).to.equal('bookA_ch1_sc1_0001:audio');
        expect(hb.workspace_id).to.equal(WS_A);
        expect(hb.mode).to.equal('private');

        // The busy private worker must NOT inflate the global count.
        expect(await workerHealth.getAliveCount(h.redis, 'audio')).to.equal(0);
        expect(await workerHealth.getPrivateAliveCount(h.redis, 'audio', WS_A)).to.equal(1);
        expect(await workerHealth.getPrivateBusyCount(h.redis, 'audio', WS_A)).to.equal(1);
    });
});

// ══════════════════════════════════════════════════════════════════════════
// /worker/counts acceptance — User A vs User B
// ══════════════════════════════════════════════════════════════════════════

describe('Worker visibility — /worker/counts acceptance (A vs B)', () => {
    let server, base, redis, hubServer, hubBase;
    let alice, bob;
    let aliceWorker, aliceToken;
    let systemWorker, systemToken;

    function cookieOf(res) {
        const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        const sid = set.find((c) => c.startsWith('animastor_sid='));
        return sid ? sid.split(';')[0] : null;
    }

    async function register(username) {
        const res = await fetch(`${base}/api/v1/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password: 'correct-horse-42', email: `${username}@test.local` }),
        });
        const body = await res.json();
        expect(res.status).to.equal(201);
        return { cookie: cookieOf(res), workspaceId: body.workspace.id };
    }

    async function cleanup() {
        await query(`DELETE FROM workers WHERE workspace_id IN (
            SELECT id FROM workspaces WHERE owner_user_id IN (
                SELECT user_id FROM users WHERE username LIKE 'pwvis%'))`);
        await query(`DELETE FROM workers WHERE mode = 'system' AND name LIKE 'pwvis-sys%'`);
        await query(`DELETE FROM workspace_members WHERE workspace_id IN (
            SELECT id FROM workspaces WHERE owner_user_id IN (
                SELECT user_id FROM users WHERE username LIKE 'pwvis%'))`);
        await query(`DELETE FROM sessions WHERE user_id IN (
            SELECT user_id FROM users WHERE username LIKE 'pwvis%')`);
        await query(`DELETE FROM workspaces WHERE owner_user_id IN (
            SELECT user_id FROM users WHERE username LIKE 'pwvis%')`);
        await query(`DELETE FROM users WHERE username LIKE 'pwvis%'`);
    }

    async function getCounts(cookie) {
        const res = await fetch(`${base}/api/v1/worker/counts`, {
            headers: cookie ? { Cookie: cookie } : {},
        });
        expect(res.status).to.equal(200);
        return res.json();
    }

    before(async function () {
        this.timeout(60000);
        await runMigrations();
        await cleanup();
        redis = createMockRedis();

        const app = express();
        app.use(express.json());
        app.use(authContext);
        require('../src/routes/auth-routes.cjs')(app, null, { utils: { log: () => {} } });
        require('../src/routes/worker-routes.cjs')(app, redis);
        require('../src/routes/generation-routes.cjs')(app, redis, {
            config,
            utils: { log: () => {} },
            storage: { postgres: { query } },
            orchestrator: { failStage: async () => ({ failed: true }) },
            taskHandler: { handleTaskResult: async () => {} },
            book: { loadBook: () => null },
            playerModel: { loadBook: () => null },
        });
        await new Promise((resolve) => {
            server = app.listen(0, () => {
                base = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });

        // The GPU hub shares the SAME redis (mirror + heartbeats), exactly as
        // in production.
        const hubApp = buildHubApp({
            redis,
            config: { BACKEND_URL: 'http://backend.test', GPU_HUB_API_KEY: null },
            fetchImpl: async () => ({ ok: true, status: 200 }),
            intervals: false,
        });
        await new Promise((resolve) => {
            hubServer = hubApp.listen(0, () => {
                hubBase = `http://127.0.0.1:${hubServer.address().port}`;
                resolve();
            });
        });

        alice = await register(`pwvis_alice_${Date.now()}`);
        bob = await register(`pwvis_bob_${Date.now() + 1}`);

        // PW-4: the global pool is served by a SYSTEM worker with a registry
        // credential (admin-issued) — never by an uncredentialed beacon.
        const sysCreated = await workerRepo.createSystemWorker({
            name: `pwvis-sys-${Date.now()}`,
            workerType: 'audio',
        });
        systemWorker = sysCreated.worker;
        systemToken = sysCreated.token;
        await workerAuth.mirrorPut(redis, {
            ...systemWorker,
            token_hash: workerRepo.parseToken(systemToken).secretHash,
        });

        // User A creates a Private Audio Worker (management API).
        const cw = await fetch(`${base}/api/v1/workers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
            body: JSON.stringify({ name: 'alice-gpu', worker_type: 'audio' }),
        });
        expect(cw.status).to.equal(201);
        const cwBody = await cw.json();
        aliceWorker = cwBody.worker;
        aliceToken = cwBody.token;
        expect(aliceWorker.mode).to.equal('private');
        expect(aliceWorker.workspace_id).to.equal(alice.workspaceId);
    });

    after(async function () {
        this.timeout(30000);
        if (server) server.close();
        if (hubServer) hubServer.close();
        await cleanup();
    });

    it('baseline: no workers online — all counts zero for everyone', async () => {
        const [a, b, anon] = await Promise.all([
            getCounts(alice.cookie), getCounts(bob.cookie), getCounts(null),
        ]);
        for (const c of [a, b, anon]) {
            expect(c.audio).to.equal(0);
            expect(c.private_audio).to.equal(0);
        }
    });

    it('a SYSTEM-credentialed worker online counts for everyone (global pool)', async () => {
        const beacon = await fetch(`${hubBase}/beacon`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${systemToken}` },
            body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, gpu: 'A100', vram: '40' }),
        });
        expect(beacon.status).to.equal(200);

        const [a, b, anon] = await Promise.all([
            getCounts(alice.cookie), getCounts(bob.cookie), getCounts(null),
        ]);
        for (const c of [a, b, anon]) {
            expect(c.audio).to.equal(1);
        }
    });

    it('PW-4: an UNcredentialed beacon is rejected and never becomes capacity', async () => {
        const beacon = await fetch(`${hubBase}/beacon`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 'rogue-gpu', type: 'audio', protocol_version: PROTOCOL_VERSION }),
        });
        expect(beacon.status).to.equal(401);
        // Global capacity unchanged — the rogue worker counted nowhere.
        const anon = await getCounts(null);
        expect(anon.audio).to.equal(1);
    });

    it('User A private worker ONLINE — visible to A only, never in global count', async () => {
        // Worker A starts on an external GPU: beacon with its wrk.* credential.
        const beacon = await fetch(`${hubBase}/beacon`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
            body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, gpu: 'RTX4090', vram: '24' }),
        });
        expect(beacon.status).to.equal(200);

        // A sees: system pool unchanged (1) + own private worker (1).
        const a = await getCounts(alice.cookie);
        expect(a.audio).to.equal(1);
        expect(a.private_audio).to.equal(1);

        // B sees: system pool only. A's private worker is invisible.
        const b = await getCounts(bob.cookie);
        expect(b.audio).to.equal(1);
        expect(b.private_audio).to.equal(0);

        // Anonymous/global view: the private worker did NOT inflate capacity.
        const anon = await getCounts(null);
        expect(anon.audio).to.equal(1);
        expect(anon.private_audio).to.equal(0);

        // /worker/status (operational view) is system-only too.
        const st = await (await fetch(`${base}/api/v1/worker/status`)).json();
        expect(st.workers.audio).to.equal(1);
    });

    it('A sees its worker ONLINE; the worker list stays workspace-scoped', async () => {
        const listA = await (await fetch(`${base}/api/v1/workers`, { headers: { Cookie: alice.cookie } })).json();
        const wa = listA.workers.find((w) => w.worker_id === aliceWorker.worker_id);
        expect(wa).to.exist;
        expect(wa.status).to.equal('ONLINE');

        const listB = await (await fetch(`${base}/api/v1/workers`, { headers: { Cookie: bob.cookie } })).json();
        expect(listB.workers.map((w) => w.worker_id)).to.not.contain(aliceWorker.worker_id);
    });

    it('busy private worker: busy pulses only in the owner private fields', async () => {
        // Simulate the hub claim refresh: the private worker runs a job.
        await writeHeartbeat(redis, 'audio', aliceWorker.worker_id, {
            workspaceId: alice.workspaceId, mode: 'private', currentJobId: 'job-a-1',
        });

        const a = await getCounts(alice.cookie);
        expect(a.private_active_audio).to.equal(1);
        expect(a.active_audio).to.equal(0); // system pool not busy

        const b = await getCounts(bob.cookie);
        expect(b.private_active_audio).to.equal(0);
        expect(b.active_audio).to.equal(0);
    });

    it('dispatch routing: B can never route to A private worker', async () => {
        // The dispatcher's routing predicate is the PW-2 gate: only the OWNING
        // workspace's active private workers route jobs to a workspace queue.
        expect(await workerRepo.hasActivePrivateWorkerOfType(alice.workspaceId, 'audio')).to.equal(true);
        expect(await workerRepo.hasActivePrivateWorkerOfType(bob.workspaceId, 'audio')).to.equal(false);
    });

    it('worker stop: OFFLINE only for A; the system pool is unchanged', async () => {
        await redis.del(config.WORKER_HEARTBEAT_KEY('audio', aliceWorker.worker_id));

        const a = await getCounts(alice.cookie);
        expect(a.private_audio).to.equal(0);
        expect(a.audio).to.equal(1); // system worker still there

        const listA = await (await fetch(`${base}/api/v1/workers`, { headers: { Cookie: alice.cookie } })).json();
        const wa = listA.workers.find((w) => w.worker_id === aliceWorker.worker_id);
        expect(wa.status).to.equal('OFFLINE');

        const b = await getCounts(bob.cookie);
        expect(b.audio).to.equal(1);
        expect(b.private_audio).to.equal(0);
    });
});

// ══════════════════════════════════════════════════════════════════════════
// Workspace-aware availability gating (detectAvailableMode)
// ══════════════════════════════════════════════════════════════════════════

describe('Worker visibility — workspace-aware mode detection', () => {
    const stamp = `pwvismode${Date.now()}`;
    const BOOK_A = `pwvis_book_a_${stamp}`;
    const BOOK_B = `pwvis_book_b_${stamp}`;
    let redis, wsA, wsB, detectAvailableMode;

    before(async function () {
        this.timeout(60000);
        await runMigrations();
        const wsRows = await query(
            `INSERT INTO workspaces (name) VALUES ($1), ($2) RETURNING id, name`,
            [`pwvis_mode_a_${stamp}`, `pwvis_mode_b_${stamp}`]
        );
        for (const row of wsRows.rows) {
            if (row.name === `pwvis_mode_a_${stamp}`) wsA = row.id;
            else wsB = row.id;
        }
        await query(
            `INSERT INTO books (book_id, workspace_id, title) VALUES ($1, $2, 'a'), ($3, $4, 'b')`,
            [BOOK_A, wsA, BOOK_B, wsB]
        );
        redis = createMockRedis();
        detectAvailableMode = require('../src/helpers/redis-helpers.cjs')(redis).detectAvailableMode;
    });

    after(async function () {
        this.timeout(30000);
        await query(`DELETE FROM books WHERE book_id IN ($1, $2)`, [BOOK_A, BOOK_B]);
        await query(`DELETE FROM workspaces WHERE id IN ($1, $2)`, [wsA, wsB]);
    });

    it('owner private workers serve the owner book; foreign books see nothing', async () => {
        // Only workspace A's private image+video workers are online — NO
        // system workers at all.
        await writeHeartbeat(redis, 'image', 'priv-img-a', { workspaceId: wsA, mode: 'private' });
        await writeHeartbeat(redis, 'video', 'priv-vid-a', { workspaceId: wsA, mode: 'private' });

        // A's book: full mode (its own private workers count).
        expect(await detectAvailableMode(redis, BOOK_A)).to.equal('full');
        // B's book: foreign private workers must NOT look available.
        expect(await detectAvailableMode(redis, BOOK_B)).to.equal('need_audio_worker');
    });

    it('a system worker serves every book regardless of workspace', async () => {
        await writeHeartbeat(redis, 'image', 'sys-img', { mode: 'system' });
        await writeHeartbeat(redis, 'video', 'sys-vid', { mode: 'system' });
        expect(await detectAvailableMode(redis, BOOK_A)).to.equal('full');
        expect(await detectAvailableMode(redis, BOOK_B)).to.equal('full');
    });
});
