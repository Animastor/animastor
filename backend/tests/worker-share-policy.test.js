// ======================================================
// Worker Share Policy Tests (Experimental Beta — SH-1, V1)
// ======================================================
// Test matrix mandated by worker-sharing-model-design.md §13.1 (item 6):
//
//   share_policies schema & one-active-policy invariant (D1)              ok
//   policy CRUD authz matrix: owner yes                                   ok
//   foreign worker → 404 (indistinct, no existence oracle)                ok
//   system worker unreachable through user sharing routes                 ok
//   share-mode worker cannot carry a policy (409)                         ok
//   expires_at validation (past → 400)                                    ok
//   expiry re-checked on read (PG source of truth)                        ok
//   auto-expiry materialization frees the one-active slot                 ok
//   stop sharing needs NO queue cleanup (D6)                              ok
//   kill-switch OFF → routes 404, hub unchanged, counts unchanged         ok
//   hub pop precedence: owner's private lane STRICT priority              ok
//   hub pop: system pool ONLY after the private lane drains               ok
//   hub: no policy / kill-switch off / expired policy → no borrow         ok
//   stale mirror can never extend sharing (expiry re-check on read)       ok
//   mirror staleness: hub follows the mirror, not PG                      ok
//   borrowed claim finishes normally (claim ≠ policy, §6)                 ok
//   counts follow D3: policy-active private = private_* + global          ok
//   mirror carries share_policy (D4 transport)                            ok

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
const { buildHubApp, PROTOCOL_VERSION, WORKER_AUTH_MIRROR_KEY } = hub;

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';

/** Write a heartbeat exactly as the GPU hub does (scope fields included). */
function writeHeartbeat(redis, type, workerId, {
    workspaceId = null, mode = null, currentJobId = null, sharePolicy = undefined, ts = Date.now(),
} = {}) {
    const payload = {
        type,
        worker_id: workerId,
        ts,
        current_job_id: currentJobId,
        workspace_id: workspaceId,
        mode,
    };
    if (sharePolicy !== undefined) payload.share_policy = sharePolicy;
    return redis.set(config.WORKER_HEARTBEAT_KEY(type, workerId), JSON.stringify(payload), 'EX', config.WORKER_HEARTBEAT_TTL);
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

/** Mirror identity for a worker (what syncWorkerAuthMirror would write). */
function mirrorIdentity(workerId, { workspaceId, workerType = 'audio', mode = 'private', sharePolicy = null } = {}) {
    return {
        worker_id: workerId,
        workspace_id: workspaceId ?? null,
        worker_type: workerType,
        mode,
        name: 'mirror-worker',
        share_policy: sharePolicy,
    };
}

// ══════════════════════════════════════════════════════════════════════════
// Schema + repo: share_policies invariants (PG)
// ══════════════════════════════════════════════════════════════════════════

describe('Share policies — schema & repo invariants', () => {
    const stamp = `pwsh_repo_${Date.now()}`;
    let wsId, workerId;

    before(async function () {
        this.timeout(60000);
        await runMigrations();
        const ws = await query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [stamp]);
        wsId = ws.rows[0].id;
        workerId = (await workerRepo.createWorker({ workspaceId: wsId, name: `${stamp}-w`, workerType: 'audio' })).worker.worker_id;
    });

    after(async function () {
        this.timeout(30000);
        await query(`DELETE FROM share_policies WHERE worker_id = $1`, [workerId]);
        await query(`DELETE FROM workers WHERE worker_id = $1`, [workerId]);
        await query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
    });

    it('share_policies table exists with the partial unique (one active) index', async () => {
        const cols = await query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'share_policies'
            ORDER BY column_name
        `);
        const names = cols.rows.map((r) => r.column_name).sort();
        for (const required of ['policy_id', 'worker_id', 'workspace_id', 'scope_kind', 'starts_at', 'expires_at', 'revoked_at', 'created_by', 'created_at']) {
            expect(names, `missing column ${required}`).to.include(required);
        }
        const idx = await query(`
            SELECT indexdef FROM pg_indexes
            WHERE indexname = 'idx_share_policies_one_active'
        `);
        expect(idx.rows[0].indexdef).to.include('UNIQUE');
        expect(idx.rows[0].indexdef).to.include('revoked_at IS NULL');
    });

    it('scope CHECK (V2): accepts public and users; rejects anything else', async () => {
        // V2 widened the enum to ('public','users') — the planned one-line
        // migration (§14.1). Anything else (groups = V3) still fails closed.
        const ok = await query(`
            INSERT INTO share_policies (worker_id, workspace_id, scope_kind)
            VALUES ($1, $2, 'users')
        `, [workerId, wsId]).then(() => true, () => false);
        expect(ok).to.equal(true);
        // Clean up the users row so the one-active-policy invariant stays
        // intact for the rest of this describe.
        await query(`DELETE FROM share_policies WHERE worker_id = $1 AND scope_kind = 'users'`, [workerId]);
        const err = await query(`
            INSERT INTO share_policies (worker_id, workspace_id, scope_kind)
            VALUES ($1, $2, 'groups')
        `, [workerId, wsId]).then(() => null, (e) => e);
        expect(err).to.exist;
        expect(err.message).to.include('scope_kind');
    });

    it('startSharePolicy creates the single active policy', async () => {
        const result = await workerRepo.startSharePolicy({ workerId, workspaceId: wsId });
        expect(result.policy).to.exist;
        expect(result.policy.scope_kind).to.equal('public');
        expect(result.policy.revoked_at).to.equal(null);
        expect(result.policy.expires_at).to.equal(null);
        const active = await workerRepo.getActiveSharePolicy(workerId, wsId);
        expect(active.policy_id).to.equal(result.policy.policy_id);
    });

    it('D1: a second start while active → conflict (partial unique index)', async () => {
        const result = await workerRepo.startSharePolicy({ workerId, workspaceId: wsId });
        expect(result.conflict).to.equal(true);
    });

    it('stopSharePolicy revokes the active policy (workspace-scoped)', async () => {
        const other = await workerRepo.stopSharePolicy(workerId, WS_B);
        expect(other.notFound).to.equal(true); // foreign workspace cannot touch it
        const own = await workerRepo.stopSharePolicy(workerId, wsId);
        expect(own.policy).to.exist;
        expect(own.policy.revoked_at).to.be.a('number');
        const again = await workerRepo.stopSharePolicy(workerId, wsId);
        expect(again.stopped).to.equal(false);
        expect(await workerRepo.getActiveSharePolicy(workerId, wsId)).to.equal(null);
    });

    it('expiry is re-checked on read: expired row is not active although revoked_at IS NULL', async () => {
        await workerRepo.startSharePolicy({ workerId, workspaceId: wsId });
        // Simulate a policy that expired on the wall clock without being stamped.
        await query(`UPDATE share_policies SET expires_at = $2 WHERE worker_id = $1 AND revoked_at IS NULL`,
            [workerId, Date.now() - 5000]);
        expect(await workerRepo.getActiveSharePolicy(workerId, wsId)).to.equal(null);
        expect(await workerRepo.getActiveSharePolicyForWorker(workerId)).to.equal(null);
        // Mirror transport sees no active policy either.
        const mirrorRow = await workerRepo.findActiveByIdWithTokenHash(workerId);
        expect(mirrorRow.share_policy).to.equal(null);
    });

    it('auto-expiry materialization frees the one-active slot for a new policy', async () => {
        const active = await query(`SELECT policy_id, revoked_at FROM share_policies WHERE worker_id = $1 AND revoked_at IS NULL`, [workerId]);
        expect(active.rows).to.have.lengthOf(1); // still occupying the unique slot (expired but unstamped)
        const expiredPolicyId = active.rows[0].policy_id;
        const result = await workerRepo.startSharePolicy({ workerId, workspaceId: wsId, expiresAt: Date.now() + 3600_000 });
        expect(result.policy).to.exist;
        // The expired row is now stamped (auto-expiry marker) and the ONLY
        // active policy is the fresh one.
        const rows = await query(`SELECT policy_id, revoked_at FROM share_policies WHERE worker_id = $1`, [workerId]);
        const stamped = rows.rows.find((r) => r.policy_id === expiredPolicyId);
        expect(stamped.revoked_at).to.not.equal(null); // auto-expiry marker stamped
        const stillActive = rows.rows.filter((r) => r.revoked_at === null);
        expect(stillActive).to.have.lengthOf(1);
        expect(stillActive[0].policy_id).to.equal(result.policy.policy_id);
    });

    it('guards: foreign worker / non-private mode are not startable', async () => {
        expect((await workerRepo.startSharePolicy({ workerId: '00000000-0000-4000-8000-000000000000', workspaceId: wsId })).notFound).to.equal(true);
        const shareWorker = (await workerRepo.createWorker({ workspaceId: wsId, name: `${stamp}-share`, workerType: 'image', mode: 'share' })).worker.worker_id;
        const result = await workerRepo.startSharePolicy({ workerId: shareWorker, workspaceId: wsId });
        expect(result.notFound).to.equal(true); // INSERT...SELECT matched no private worker row
    });
});

// ══════════════════════════════════════════════════════════════════════════
// Routes: POST/DELETE/GET /workers/:workerId/share — authz matrix
// ══════════════════════════════════════════════════════════════════════════

describe('Share policy routes — authz matrix & kill-switch', () => {
    let server, base, redis;
    let alice, bob, aliceWorkerId;

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

    async function shareRequest(method, cookie, workerId, body) {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        };
        if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
            opts.body = JSON.stringify(body);
        }
        return fetch(`${base}/api/v1/workers/${workerId}/share`, opts);
    }

    async function cleanup() {
        await query(`DELETE FROM share_policies WHERE worker_id IN (
            SELECT worker_id FROM workers WHERE workspace_id IN (
                SELECT id FROM workspaces WHERE owner_user_id IN (
                    SELECT user_id FROM users WHERE username LIKE 'pwshare%')))`);
        await query(`DELETE FROM workers WHERE worker_id IN (
            SELECT worker_id FROM workers WHERE workspace_id IN (
                SELECT id FROM workspaces WHERE owner_user_id IN (
                    SELECT user_id FROM users WHERE username LIKE 'pwshare%')))`);
        await query(`DELETE FROM workers WHERE mode = 'system' AND name LIKE 'pwshare-sys%'`);
        await query(`DELETE FROM workspace_members WHERE workspace_id IN (
            SELECT id FROM workspaces WHERE owner_user_id IN (
                SELECT user_id FROM users WHERE username LIKE 'pwshare%'))`);
        await query(`DELETE FROM sessions WHERE user_id IN (
            SELECT user_id FROM users WHERE username LIKE 'pwshare%')`);
        await query(`DELETE FROM workspaces WHERE owner_user_id IN (
            SELECT user_id FROM users WHERE username LIKE 'pwshare%')`);
        await query(`DELETE FROM users WHERE username LIKE 'pwshare%'`);
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
        await new Promise((resolve) => {
            server = app.listen(0, () => {
                base = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });

        alice = await register(`pwshare_alice_${Date.now()}`);
        bob = await register(`pwshare_bob_${Date.now() + 1}`);

        const cw = await fetch(`${base}/api/v1/workers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
            body: JSON.stringify({ name: 'alice-gpu', worker_type: 'audio' }),
        });
        expect(cw.status).to.equal(201);
        aliceWorkerId = (await cw.json()).worker.worker_id;
    });

    before(function () {
        delete process.env.SHARE_FEATURES_ENABLED;
    });

    after(async function () {
        this.timeout(30000);
        if (server) server.close();
        await cleanup();
        delete process.env.SHARE_FEATURES_ENABLED;
    });

    afterEach(function () {
        delete process.env.SHARE_FEATURES_ENABLED;
    });

    it('kill-switch OFF (default): all three endpoints answer 404 — bit-for-bit today', async () => {
        for (const method of ['POST', 'GET', 'DELETE']) {
            const res = await shareRequest(method, alice.cookie, aliceWorkerId);
            expect(res.status, method).to.equal(404);
        }
        // Nothing leaked into PG for THIS attempt. (Scoped to the test
        // worker: the shared deployment runs tests against the same PG as
        // production, so a GLOBAL count would see real workers' policies —
        // e.g. a live public policy on a production worker.)
        const rows = await query(`SELECT COUNT(*)::int AS n FROM share_policies WHERE worker_id = $1`, [aliceWorkerId]);
        expect(rows.rows[0].n).to.equal(0);
    });

    it('kill-switch OFF: even unauthenticated callers see the dead endpoint (404)', async () => {
        const res = await shareRequest('GET', null, aliceWorkerId);
        expect(res.status).to.equal(404);
    });

    context('with SHARE_FEATURES_ENABLED=1', () => {
        beforeEach(function () {
            process.env.SHARE_FEATURES_ENABLED = '1';
        });

        it('unauthenticated → 401; guests are rejected by the users-only guard', async () => {
            const res = await shareRequest('POST', null, aliceWorkerId, {});
            expect(res.status).to.equal(401);
        });

        it('owner authorization: POST starts sharing, GET reads it, DELETE stops it', async () => {
            const started = await shareRequest('POST', alice.cookie, aliceWorkerId, {});
            expect(started.status).to.equal(201);
            const startedBody = await started.json();
            expect(startedBody.sharing).to.equal(true);
            expect(startedBody.policy.scope_kind).to.equal('public');
            expect(startedBody.policy.expires_at).to.equal(null);
            expect(startedBody.policy.policy_id).to.be.a('string');
            expect(JSON.stringify(startedBody)).to.not.include('token');

            const read = await shareRequest('GET', alice.cookie, aliceWorkerId);
            expect(read.status).to.equal(200);
            const readBody = await read.json();
            expect(readBody.sharing).to.equal(true);
            expect(readBody.policy.policy_id).to.equal(startedBody.policy.policy_id);

            // D1: a second start while active → 409
            const again = await shareRequest('POST', alice.cookie, aliceWorkerId, {});
            expect(again.status).to.equal(409);
            expect((await again.json()).code).to.equal('share_already_active');

            const stopped = await shareRequest('DELETE', alice.cookie, aliceWorkerId);
            expect(stopped.status).to.equal(200);
            const stoppedBody = await stopped.json();
            expect(stoppedBody.sharing).to.equal(false);
            expect(stoppedBody.stopped).to.equal(true);

            const readAfter = await shareRequest('GET', alice.cookie, aliceWorkerId);
            expect((await readAfter.json()).sharing).to.equal(false);

            // Idempotent-ish stop with nothing active → still the end state.
            const stoppedAgain = await shareRequest('DELETE', alice.cookie, aliceWorkerId);
            expect(stoppedAgain.status).to.equal(200);
            expect((await stoppedAgain.json()).stopped).to.equal(false);
        });

        it('foreign worker → 404 indistinctly for every verb (no existence oracle)', async () => {
            for (const method of ['POST', 'GET', 'DELETE']) {
                const res = await shareRequest(method, bob.cookie, aliceWorkerId, {});
                expect(res.status, method).to.equal(404);
                expect((await res.json()).error).to.equal('Worker not found');
            }
        });

        it('malformed worker id → 404', async () => {
            const res = await shareRequest('POST', alice.cookie, 'not-a-uuid', {});
            expect(res.status).to.equal(404);
        });

        it('system worker is unreachable through the user sharing routes (404)', async () => {
            const sys = await workerRepo.createSystemWorker({ name: `pwshare-sys-${Date.now()}`, workerType: 'audio' });
            try {
                for (const method of ['POST', 'GET', 'DELETE']) {
                    const res = await shareRequest(method, alice.cookie, sys.worker.worker_id, {});
                    expect(res.status, method).to.equal(404);
                }
            } finally {
                await query(`DELETE FROM workers WHERE worker_id = $1`, [sys.worker.worker_id]);
            }
        });

        it("mode='share' worker cannot carry a policy (404 — only private workers are addressable)", async () => {
            const cw = await fetch(`${base}/api/v1/workers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
                body: JSON.stringify({ name: 'alice-share', worker_type: 'image', mode: 'share', confirm_share: true }),
            });
            expect(cw.status).to.equal(201);
            const shareWorkerId = (await cw.json()).worker.worker_id;
            const res = await shareRequest('POST', alice.cookie, shareWorkerId, {});
            // The INSERT..SELECT guard matches no private worker row → the
            // indistinct 404 (the row exists but is not policy-addressable).
            expect(res.status).to.equal(404);
        });

        it('expires_at validation: past → 400, non-integer → 400', async () => {
            const past = await shareRequest('POST', alice.cookie, aliceWorkerId, { expires_at: Date.now() - 1000 });
            expect(past.status).to.equal(400);
            expect((await past.json()).code).to.equal('expires_at_in_past');

            const bad = await shareRequest('POST', alice.cookie, aliceWorkerId, { expires_at: 'tomorrow' });
            expect(bad.status).to.equal(400);
            expect((await bad.json()).code).to.equal('invalid_expires_at');

            // Scoped to the test worker (same-PG-as-production deployment:
            // a global "no active policies" would see real shared workers).
            const rows = await query(`SELECT COUNT(*)::int AS n FROM share_policies WHERE worker_id = $1 AND revoked_at IS NULL`, [aliceWorkerId]);
            expect(rows.rows[0].n).to.equal(0);
        });

        it('expiry: after expires_at passes, GET reports not sharing (re-checked on read)', async function () {
            this.timeout(10000);
            const started = await shareRequest('POST', alice.cookie, aliceWorkerId, { expires_at: Date.now() + 800 });
            expect(started.status).to.equal(201);

            const before = await shareRequest('GET', alice.cookie, aliceWorkerId);
            expect((await before.json()).sharing).to.equal(true);

            await new Promise((r) => setTimeout(r, 1100));

            const after = await shareRequest('GET', alice.cookie, aliceWorkerId);
            const body = await after.json();
            expect(body.sharing).to.equal(false);
            expect(body.policy).to.equal(null);
        });

        it('auto-expiry: POST after an expired policy creates a NEW one (old row stamped revoked)', async function () {
            this.timeout(10000);
            const first = await shareRequest('POST', alice.cookie, aliceWorkerId, { expires_at: Date.now() + 500 });
            expect(first.status).to.equal(201);
            const firstPolicy = (await first.json()).policy;
            await new Promise((r) => setTimeout(r, 800));

            const second = await shareRequest('POST', alice.cookie, aliceWorkerId, {});
            expect(second.status).to.equal(201);
            const secondPolicy = (await second.json()).policy;
            expect(secondPolicy.policy_id).to.not.equal(firstPolicy.policy_id);

            const rows = await query(`SELECT policy_id, revoked_at FROM share_policies WHERE worker_id = $1`, [aliceWorkerId]);
            const firstRow = rows.rows.find((r) => r.policy_id === firstPolicy.policy_id);
            expect(firstRow.revoked_at).to.not.equal(null); // auto-expiry marker stamped
            const stillActive = rows.rows.filter((r) => r.revoked_at === null);
            expect(stillActive).to.have.lengthOf(1);
            expect(stillActive[0].policy_id).to.equal(secondPolicy.policy_id);

            // The worker's mirror identity gained the fresh policy (D4 point update).
            const mirrorRow = await workerRepo.findActiveByIdWithTokenHash(aliceWorkerId);
            expect(mirrorRow.share_policy.policy_id).to.equal(secondPolicy.policy_id);
        });
    });
});

// ══════════════════════════════════════════════════════════════════════════
// GPU hub: lane priority pop, borrow gate, stale mirror, claim finish
// ══════════════════════════════════════════════════════════════════════════

describe('Share policies — gpu-hub lane priority & borrow gate', () => {
    const WORKER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const WS_QUEUE = `animastor:queue:audio:ws:${WS_A}`;
    const SYSTEM_QUEUE = 'animastor:queue:audio';

    function hubTask(jobId, workspaceId) {
        return {
            job_id: jobId,
            params: {},
            job_type: 'audio',
            build_id: 'b1',
            protocol_version: PROTOCOL_VERSION,
            dispatch_id: `d-${jobId}`,
            book_id: 'bookA',
            chapter_id: 'ch1',
            scene_id: 'sc1',
            stage: 'audio',
            workspace_id: workspaceId ?? null,
        };
    }

    async function startHub({ shareEnabled = true } = {}) {
        const redis = createMockRedis();
        const app = buildHubApp({
            redis,
            config: {
                BACKEND_URL: 'http://backend.test',
                GPU_HUB_API_KEY: 'hub-key',
                SHARE_FEATURES_ENABLED: shareEnabled,
            },
            fetchImpl: async () => ({ ok: true, status: 200 }),
            intervals: false,
        });
        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        return {
            redis,
            base: `http://127.0.0.1:${server.address().port}`,
            stop: () => new Promise((r) => server.close(r)),
        };
    }

    async function registerWorker(h, { workerId = WORKER_A, sharePolicy = null } = {}) {
        const { token, hash } = makeToken(workerId);
        h.token = token;
        await h.redis.hset(WORKER_AUTH_MIRROR_KEY, hash, JSON.stringify(mirrorIdentity(workerId, {
            workspaceId: WS_A, mode: 'private', sharePolicy,
        })));
        await h.redis.hset('animastor:gpu-hub:workers', workerId, JSON.stringify({
            id: workerId, type: 'audio', protocol_version: PROTOCOL_VERSION, last_seen: Date.now(),
        }));
    }

    async function popNext(h) {
        const res = await fetch(`${h.base}/task/next?worker=${WORKER_A}&type=audio`, {
            headers: { Authorization: `Bearer ${h.token}` },
        });
        expect(res.status).to.equal(200);
        return res.json();
    }

    afterEach(async function () {
        if (this.currentTest && this.currentTest.h) await this.currentTest.h.stop();
    });

    it('owner lane has STRICT priority: ws queue drains before the system pool', async function () {
        const h = this.h = await startHub();
        await registerWorker(h, { sharePolicy: { policy_id: 'pol-1', scope_kind: 'public', expires_at: null } });

        await h.redis.lpush(WS_QUEUE, JSON.stringify(hubTask('owner-job-1', WS_A)));
        await h.redis.lpush(WS_QUEUE, JSON.stringify(hubTask('owner-job-2', WS_A)));
        await h.redis.lpush(SYSTEM_QUEUE, JSON.stringify(hubTask('consumer-job-1', null)));

        // 1st & 2nd pops come from the OWNER's lane even though the system
        // pool also has work (FIFO within each lane).
        expect((await popNext(h)).task.job_id).to.equal('owner-job-1');
        expect((await popNext(h)).task.job_id).to.equal('owner-job-2');
        // 3rd pop — private lane drained → spare capacity serves the pool.
        expect((await popNext(h)).task.job_id).to.equal('consumer-job-1');
        // 4th pop — everything drained.
        expect(await popNext(h)).to.deep.equal({ task: null });

        // The borrowed claim carries the claim-time policy snapshot + the
        // WORKER's own workspace scope.
        const running = JSON.parse(await h.redis.hget('animastor:running', 'consumer-job-1'));
        expect(running.worker_mode).to.equal('private');
        expect(running.workspace_id).to.equal(null);
        expect(running.worker_workspace_id).to.equal(WS_A);
        expect(running.worker_share_policy).to.deep.equal({ policy_id: 'pol-1', scope_kind: 'public', expires_at: null });
    });

    it('no active policy → the private worker never touches the system pool', async function () {
        const h = this.h = await startHub();
        await registerWorker(h, { sharePolicy: null });
        await h.redis.lpush(SYSTEM_QUEUE, JSON.stringify(hubTask('consumer-job-1', null)));
        expect(await popNext(h)).to.deep.equal({ task: null });
        expect(await h.redis.llen(SYSTEM_QUEUE)).to.equal(1); // job untouched
    });

    it('kill-switch OFF → bit-for-bit today: policy in the mirror is ignored', async function () {
        const h = this.h = await startHub({ shareEnabled: false });
        await registerWorker(h, { sharePolicy: { policy_id: 'pol-1', scope_kind: 'public', expires_at: null } });
        await h.redis.lpush(SYSTEM_QUEUE, JSON.stringify(hubTask('consumer-job-1', null)));
        expect(await popNext(h)).to.deep.equal({ task: null });
        expect(await h.redis.llen(SYSTEM_QUEUE)).to.equal(1);

        // Beacon with the flag off writes a heartbeat WITHOUT the marker.
        await fetch(`${h.base}/beacon`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
            body: JSON.stringify({ protocol_version: PROTOCOL_VERSION }),
        });
        const hb = JSON.parse(await h.redis.get(config.WORKER_HEARTBEAT_KEY('audio', WORKER_A)));
        expect(hb.share_policy).to.equal(undefined);
        expect(hb.workspace_id).to.equal(WS_A);
        expect(hb.mode).to.equal('private');
    });

    it('STALE MIRROR can never extend sharing: expired policy in the mirror → no borrow', async function () {
        const h = this.h = await startHub();
        await registerWorker(h, { sharePolicy: { policy_id: 'pol-1', scope_kind: 'public', expires_at: Date.now() - 1000 } });
        await h.redis.lpush(SYSTEM_QUEUE, JSON.stringify(hubTask('consumer-job-1', null)));
        expect(await popNext(h)).to.deep.equal({ task: null });
        expect(await h.redis.llen(SYSTEM_QUEUE)).to.equal(1);

        // The mirror auth itself drops the expired policy (re-check on read).
        const identity = await hub.authenticateWorkerMirror(h.redis, h.token);
        expect(identity.share_policy).to.equal(null);
    });

    it('malformed policy payload in the mirror fails closed (no borrow)', async function () {
        const h = this.h = await startHub();
        // Garbage scope (groups = V3) is sanitized to "no policy" — fail closed.
        await registerWorker(h, { sharePolicy: { policy_id: 'pol-1', scope_kind: 'groups', expires_at: null } });
        await h.redis.lpush(SYSTEM_QUEUE, JSON.stringify(hubTask('consumer-job-1', null)));
        expect(await popNext(h)).to.deep.equal({ task: null });
        expect(await h.redis.llen(SYSTEM_QUEUE)).to.equal(1);
        // A users-scope policy (V2) is VALID identity — but it must NEVER
        // borrow from the public system pool either (its audience lane is
        // separate; covered by worker-share-grants.test.js).
        const identity = await hub.authenticateWorkerMirror(h.redis, h.token);
        expect(identity.share_policy).to.equal(null);
    });

    it('mirror staleness: the hub follows the MIRROR, not PG — borrow starts only after the mirror update (D4)', async function () {
        const h = this.h = await startHub();
        // Mirror says NO policy (stale), even though sharing was "just started" in PG.
        await registerWorker(h, { sharePolicy: null });
        await h.redis.lpush(SYSTEM_QUEUE, JSON.stringify(hubTask('consumer-job-1', null)));
        expect(await popNext(h)).to.deep.equal({ task: null });
        expect(await h.redis.llen(SYSTEM_QUEUE)).to.equal(1);

        // The backend's point update (mirrorPutWorkerById) refreshes the
        // mirror — only then does the worker start serving the pool.
        await h.redis.hset(WORKER_AUTH_MIRROR_KEY, Object.keys(await h.redis.hgetall(WORKER_AUTH_MIRROR_KEY))[0],
            JSON.stringify(mirrorIdentity(WORKER_A, { workspaceId: WS_A, sharePolicy: { policy_id: 'pol-1', scope_kind: 'public', expires_at: null } })));
        expect((await popNext(h)).task.job_id).to.equal('consumer-job-1');
    });

    it('poison-write guard holds per lane: a borrowed pop of a workspace-stamped pool entry is dead-lettered', async function () {
        const h = this.h = await startHub();
        await registerWorker(h, { sharePolicy: { policy_id: 'pol-1', scope_kind: 'public', expires_at: null } });
        // A POISON write: a workspace-stamped task inside the system pool.
        await h.redis.lpush(SYSTEM_QUEUE, JSON.stringify(hubTask('poison-job', WS_B)));
        expect(await popNext(h)).to.deep.equal({ task: null });
        const dead = (await h.redis.lrange(hub.DEAD_LETTER_KEY, 0, -1)).map((s) => JSON.parse(s));
        expect(dead).to.have.lengthOf(1);
        expect(dead[0].reason).to.equal('poison_workspace_mismatch');
    });

    it('borrowed claim finishes normally — even after sharing was stopped mid-job (claim ≠ policy)', async function () {
        const h = this.h = await startHub();
        await registerWorker(h, { sharePolicy: { policy_id: 'pol-1', scope_kind: 'public', expires_at: null } });
        await h.redis.lpush(SYSTEM_QUEUE, JSON.stringify(hubTask('consumer-job-1', null)));
        expect((await popNext(h)).task.job_id).to.equal('consumer-job-1');

        // Owner stops sharing → the mirror loses the policy (point update).
        await h.redis.hset(WORKER_AUTH_MIRROR_KEY, Object.keys(await h.redis.hgetall(WORKER_AUTH_MIRROR_KEY))[0],
            JSON.stringify(mirrorIdentity(WORKER_A, { workspaceId: WS_A, sharePolicy: null })));

        // The running claim is still finishable by the same credential.
        const res = await fetch(`${h.base}/task/result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
            body: JSON.stringify({
                job_id: 'consumer-job-1',
                build_id: 'b1',
                result_base64: 'aGk=',
                dispatch_id: 'd-consumer-job-1',
                protocol_version: PROTOCOL_VERSION,
            }),
        });
        expect(res.status).to.equal(200);
        expect(await h.redis.hget('animastor:running', 'consumer-job-1')).to.equal(null);
    });

    it('D6: stop sharing requires NO queue cleanup — consumer jobs stay servable by other pool workers', async function () {
        const h = this.h = await startHub();
        await registerWorker(h, { sharePolicy: { policy_id: 'pol-1', scope_kind: 'public', expires_at: null } });
        await h.redis.lpush(SYSTEM_QUEUE, JSON.stringify(hubTask('consumer-job-1', null)));
        await h.redis.lpush(SYSTEM_QUEUE, JSON.stringify(hubTask('consumer-job-2', null)));

        // A share-mode pool worker exists alongside.
        const shareWorkerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        const { token: shareToken, hash: shareHash } = makeToken(shareWorkerId);
        await h.redis.hset(WORKER_AUTH_MIRROR_KEY, shareHash, JSON.stringify(mirrorIdentity(shareWorkerId, {
            workspaceId: WS_A, mode: 'share', sharePolicy: null,
        })));
        await h.redis.hset('animastor:gpu-hub:workers', shareWorkerId, JSON.stringify({
            id: shareWorkerId, type: 'audio', protocol_version: PROTOCOL_VERSION, last_seen: Date.now(),
        }));

        // The policy-active private worker stops popping the pool (mirror
        // updated by the backend's point update on DELETE /share).
        await h.redis.hset(WORKER_AUTH_MIRROR_KEY, Object.keys(await h.redis.hgetall(WORKER_AUTH_MIRROR_KEY))[0],
            JSON.stringify(mirrorIdentity(WORKER_A, { workspaceId: WS_A, sharePolicy: null })));

        // The queued consumer jobs were NEVER cleaned up — the share worker
        // simply continues serving the pool.
        const next = await fetch(`${h.base}/task/next?worker=${shareWorkerId}&type=audio`, {
            headers: { Authorization: `Bearer ${shareToken}` },
        });
        expect(next.status).to.equal(200);
        expect((await next.json()).task.job_id).to.equal('consumer-job-1');
        expect(await h.redis.llen(SYSTEM_QUEUE)).to.equal(1);
    });
});

// ══════════════════════════════════════════════════════════════════════════
// worker-health: D3 counting (double count, expiry re-check)
// ══════════════════════════════════════════════════════════════════════════

describe('Share policies — worker-health counts follow decision D3', () => {
    let redis;

    beforeEach(() => {
        redis = createMockRedis();
        delete process.env.SHARE_FEATURES_ENABLED;
    });

    afterEach(() => {
        delete process.env.SHARE_FEATURES_ENABLED;
    });

    it('policy-active private worker counts in BOTH the owner private bucket and the global pool (D3)', async () => {
        process.env.SHARE_FEATURES_ENABLED = '1';
        await writeHeartbeat(redis, 'audio', 'shared-priv-a', {
            workspaceId: WS_A, mode: 'private',
            sharePolicy: { policy_id: 'pol-1', scope_kind: 'public', expires_at: null },
        });
        expect(await workerHealth.getAliveCount(redis, 'audio')).to.equal(1);      // global capacity
        expect(await workerHealth.getPrivateAliveCount(redis, 'audio', WS_A)).to.equal(1); // owner bucket
        expect(await workerHealth.getPrivateAliveCount(redis, 'audio', WS_B)).to.equal(0); // foreign private

        const forB = await workerHealth.getAvailability(redis, WS_B);
        expect(forB.system.audio).to.equal(1); // B may submit into the pool
        expect(forB.private.audio).to.equal(0);
    });

    it('a private worker WITHOUT a policy is never in the global count (invariant preserved)', async () => {
        process.env.SHARE_FEATURES_ENABLED = '1';
        await writeHeartbeat(redis, 'audio', 'plain-priv-a', { workspaceId: WS_A, mode: 'private' });
        expect(await workerHealth.getAliveCount(redis, 'audio')).to.equal(0);
        expect(await workerHealth.getPrivateAliveCount(redis, 'audio', WS_A)).to.equal(1);
    });

    it('an EXPIRED policy marker is re-checked on read and never extends the global count', async () => {
        process.env.SHARE_FEATURES_ENABLED = '1';
        await writeHeartbeat(redis, 'audio', 'expired-priv-a', {
            workspaceId: WS_A, mode: 'private',
            sharePolicy: { policy_id: 'pol-1', scope_kind: 'public', expires_at: Date.now() - 1000 },
        });
        expect(await workerHealth.getAliveCount(redis, 'audio')).to.equal(0);
        expect(await workerHealth.getPrivateAliveCount(redis, 'audio', WS_A)).to.equal(1);
    });

    it('busy policy-active private worker pulses in both busy buckets (D3)', async () => {
        process.env.SHARE_FEATURES_ENABLED = '1';
        await writeHeartbeat(redis, 'audio', 'busy-priv-a', {
            workspaceId: WS_A, mode: 'private', currentJobId: 'job-1',
            sharePolicy: { policy_id: 'pol-1', scope_kind: 'public', expires_at: null },
        });
        expect(await workerHealth.getBusyCount(redis, 'audio')).to.equal(1);
        expect(await workerHealth.getPrivateBusyCount(redis, 'audio', WS_A)).to.equal(1);
    });

    it('kill-switch OFF: a heartbeat carrying a marker is ignored — counts are today\'s, bit-for-bit', async () => {
        delete process.env.SHARE_FEATURES_ENABLED; // default OFF
        await writeHeartbeat(redis, 'audio', 'stale-shared-priv-a', {
            workspaceId: WS_A, mode: 'private',
            sharePolicy: { policy_id: 'pol-1', scope_kind: 'public', expires_at: null },
        });
        expect(await workerHealth.getAliveCount(redis, 'audio')).to.equal(0);
        expect(await workerHealth.getPrivateAliveCount(redis, 'audio', WS_A)).to.equal(1);
    });

    it('isAvailable: a policy-active private worker serves every book (capacity indicator, D3)', async () => {
        process.env.SHARE_FEATURES_ENABLED = '1';
        await writeHeartbeat(redis, 'video', 'shared-priv-a', {
            workspaceId: WS_A, mode: 'private',
            sharePolicy: { policy_id: 'pol-1', scope_kind: 'public', expires_at: null },
        });
        expect(await workerHealth.isAvailable(redis, 'video', WS_B)).to.equal(true);
        expect(await workerHealth.isAvailable(redis, 'video')).to.equal(true);
    });
});

// ══════════════════════════════════════════════════════════════════════════
// worker-health: available.* — PHYSICAL union (UI counters)
// ══════════════════════════════════════════════════════════════════════════
// The user-facing "Audio Workers: N" chip must never double-count an own
// worker that carries an active public share policy: sharing grants ACCESS
// to an existing worker, it does not create a second one. D3 stays intact —
// system.*/private.* capacity buckets still overlap by design; available.*
// is the deduplicated union of what this caller can physically use.
describe('Share policies — available.* physical union (UI counters, D3-safe)', () => {
    let redis;

    beforeEach(() => {
        redis = createMockRedis();
        delete process.env.SHARE_FEATURES_ENABLED;
    });

    afterEach(() => {
        delete process.env.SHARE_FEATURES_ENABLED;
    });

    it('scenarios 1-2: private → My=1; enabling Public keeps owner available=1 (D3 buckets overlap by design)', async () => {
        process.env.SHARE_FEATURES_ENABLED = '1';
        await writeHeartbeat(redis, 'audio', 'union-priv-a', { workspaceId: WS_A, mode: 'private' });
        let avail = await workerHealth.getAvailability(redis, WS_A);
        expect(avail.available.audio).to.equal(1); // My audio Workers = 1
        expect(avail.private.audio).to.equal(1);
        expect(avail.system.audio).to.equal(0);    // not in community yet

        await writeHeartbeat(redis, 'audio', 'union-priv-a', {
            workspaceId: WS_A, mode: 'private',
            sharePolicy: { policy_id: 'pol-1', scope_kind: 'public', expires_at: null },
        });
        avail = await workerHealth.getAvailability(redis, WS_A);
        // Owner: physical union is STILL 1 — one worker, not two.
        expect(avail.available.audio).to.equal(1);
        // D3 capacity buckets keep their semantics (both = 1 by design).
        expect(avail.private.audio).to.equal(1);
        expect(avail.system.audio).to.equal(1);
        // Another user: community capacity = 1, owns nothing.
        const forB = await workerHealth.getAvailability(redis, WS_B);
        expect(forB.available.audio).to.equal(1);
        expect(forB.private.audio).to.equal(0);
    });

    it('scenarios 3+7: Public → Off (revoke) keeps owner union at 1; community drops it (1→1→1, never 1→2→1)', async () => {
        process.env.SHARE_FEATURES_ENABLED = '1';
        await writeHeartbeat(redis, 'audio', 'union-priv-a', {
            workspaceId: WS_A, mode: 'private',
            sharePolicy: { policy_id: 'pol-1', scope_kind: 'public', expires_at: null },
        });
        // Sharing stopped: the mirror point-update removes the marker.
        await writeHeartbeat(redis, 'audio', 'union-priv-a', { workspaceId: WS_A, mode: 'private' });
        const avail = await workerHealth.getAvailability(redis, WS_A);
        expect(avail.available.audio).to.equal(1);
        expect(avail.system.audio).to.equal(0);
        const forB = await workerHealth.getAvailability(redis, WS_B);
        expect(forB.available.audio).to.equal(0); // no longer available to others
    });

    it('scenario 6: EXPIRED public policy → owner union unchanged at 1; worker leaves community capacity', async () => {
        process.env.SHARE_FEATURES_ENABLED = '1';
        await writeHeartbeat(redis, 'audio', 'union-priv-a', {
            workspaceId: WS_A, mode: 'private',
            sharePolicy: { policy_id: 'pol-1', scope_kind: 'public', expires_at: Date.now() - 1000 },
        });
        const avail = await workerHealth.getAvailability(redis, WS_A);
        expect(avail.available.audio).to.equal(1); // owner count unchanged
        expect(avail.system.audio).to.equal(0);    // expiry re-checked on read
        const forB = await workerHealth.getAvailability(redis, WS_B);
        expect(forB.available.audio).to.equal(0);
    });

    it('scenario 8: two private workers, one public — owner union = 2 (the old sum would show 3)', async () => {
        process.env.SHARE_FEATURES_ENABLED = '1';
        await writeHeartbeat(redis, 'audio', 'union-priv-a2', { workspaceId: WS_A, mode: 'private' });
        await writeHeartbeat(redis, 'audio', 'union-priv-a3', {
            workspaceId: WS_A, mode: 'private',
            sharePolicy: { policy_id: 'pol-1', scope_kind: 'public', expires_at: null },
        });
        const avail = await workerHealth.getAvailability(redis, WS_A);
        expect(avail.available.audio).to.equal(2); // 2 physical units
        expect(avail.private.audio).to.equal(2);
        expect(avail.system.audio).to.equal(1);    // only the public one
    });

    it('scenario 4: anonymous (null workspace) sees the physical community union only — own private = 0', async () => {
        process.env.SHARE_FEATURES_ENABLED = '1';
        await writeHeartbeat(redis, 'image', 'union-priv-a4', {
            workspaceId: WS_A, mode: 'private',
            sharePolicy: { policy_id: 'pol-1', scope_kind: 'public', expires_at: null },
        });
        await writeHeartbeat(redis, 'image', 'union-sys-b', { mode: 'system' });
        const anon = await workerHealth.getAvailability(redis, null);
        expect(anon.available.image).to.equal(2); // shared private + system worker
        expect(anon.private.image).to.equal(0);
        // The reported bug's exact shape: ONE shared private audio worker.
        await writeHeartbeat(redis, 'audio', 'union-priv-a5', {
            workspaceId: WS_A, mode: 'private',
            sharePolicy: { policy_id: 'pol-2', scope_kind: 'public', expires_at: null },
        });
        expect((await workerHealth.getAvailability(redis, null)).available.audio).to.equal(1);
    });

    it('scenario 5: users-scope (personal grants) never enters community capacity — union stays owner-only', async () => {
        process.env.SHARE_FEATURES_ENABLED = '1';
        await writeHeartbeat(redis, 'audio', 'union-priv-a7', {
            workspaceId: WS_A, mode: 'private',
            sharePolicy: { policy_id: 'pol-3', scope_kind: 'users', expires_at: null },
        });
        const avail = await workerHealth.getAvailability(redis, WS_A);
        expect(avail.available.audio).to.equal(1); // owner: one physical unit
        expect(avail.system.audio).to.equal(0);    // users-scope is NOT community capacity
        const forB = await workerHealth.getAvailability(redis, WS_B);
        expect(forB.available.audio).to.equal(0);  // routing goes through policy lanes, not counts
    });

    it('kill-switch OFF: available.* degrades to private-only for the owner; no community capacity', async () => {
        delete process.env.SHARE_FEATURES_ENABLED; // default OFF
        await writeHeartbeat(redis, 'audio', 'union-priv-a6', {
            workspaceId: WS_A, mode: 'private',
            sharePolicy: { policy_id: 'pol-1', scope_kind: 'public', expires_at: null },
        });
        const avail = await workerHealth.getAvailability(redis, WS_A);
        expect(avail.available.audio).to.equal(1); // own worker still counted
        expect(avail.system.audio).to.equal(0);    // marker ignored (pre-sharing behavior)
        expect((await workerHealth.getAvailability(redis, WS_B)).available.audio).to.equal(0);
    });
});

// ══════════════════════════════════════════════════════════════════════════
// Mirror transport (D4): policy rides the auth mirror
// ══════════════════════════════════════════════════════════════════════════

describe('Share policies — auth mirror transport (D4)', () => {
    const stamp = `pwsh_mirror_${Date.now()}`;
    let wsId, workerId, token, hash, redis;

    before(async function () {
        this.timeout(60000);
        await runMigrations();
        const ws = await query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [stamp]);
        wsId = ws.rows[0].id;
        const created = await workerRepo.createWorker({ workspaceId: wsId, name: `${stamp}-w`, workerType: 'image' });
        workerId = created.worker.worker_id;
        ({ token, hash } = { token: created.token, hash: workerRepo.parseToken(created.token).secretHash });
        redis = createMockRedis();
    });

    after(async function () {
        this.timeout(30000);
        await query(`DELETE FROM share_policies WHERE worker_id = $1`, [workerId]);
        await query(`DELETE FROM workers WHERE worker_id = $1`, [workerId]);
        await query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
    });

    it('start/stop sharing point-updates the mirror identity with the policy (and null after stop)', async () => {
        await workerAuth.mirrorPut(redis, { ...(await workerRepo.findActiveByIdWithTokenHash(workerId)) });
        let identity = JSON.parse(await redis.hget(WORKER_AUTH_MIRROR_KEY, hash));
        expect(identity.share_policy).to.equal(null);

        const { policy } = await workerRepo.startSharePolicy({ workerId, workspaceId: wsId, expiresAt: Date.now() + 3600_000 });
        await workerAuth.mirrorPutWorkerById(redis, workerId);
        identity = JSON.parse(await redis.hget(WORKER_AUTH_MIRROR_KEY, hash));
        expect(identity.share_policy).to.deep.equal({
            policy_id: policy.policy_id, scope_kind: 'public', expires_at: policy.expires_at,
        });

        await workerRepo.stopSharePolicy(workerId, wsId);
        await workerAuth.mirrorPutWorkerById(redis, workerId);
        identity = JSON.parse(await redis.hget(WORKER_AUTH_MIRROR_KEY, hash));
        expect(identity.share_policy).to.equal(null);
    });

    it('syncWorkerAuthMirror (periodic resync) rebuilds entries WITH active policies from PG', async () => {
        const { policy } = await workerRepo.startSharePolicy({ workerId, workspaceId: wsId });
        await workerAuth.syncWorkerAuthMirror(redis);
        const identity = JSON.parse(await redis.hget(WORKER_AUTH_MIRROR_KEY, hash));
        expect(identity.worker_id).to.equal(workerId);
        expect(identity.mode).to.equal('private');
        expect(identity.share_policy).to.deep.equal({
            policy_id: policy.policy_id, scope_kind: 'public', expires_at: null,
        });
        await workerRepo.stopSharePolicy(workerId, wsId);
    });

    it('expired policies do not enter the mirror even when revoked_at is still NULL', async () => {
        await workerRepo.startSharePolicy({ workerId, workspaceId: wsId });
        await query(`UPDATE share_policies SET expires_at = $2 WHERE worker_id = $1 AND revoked_at IS NULL`,
            [workerId, Date.now() - 1000]);
        await workerAuth.syncWorkerAuthMirror(redis);
        const identity = JSON.parse(await redis.hget(WORKER_AUTH_MIRROR_KEY, hash));
        expect(identity.share_policy).to.equal(null);
        await workerRepo.stopSharePolicy(workerId, wsId);
    });
});

// ══════════════════════════════════════════════════════════════════════════
// End-to-end: /worker/counts with a policy-active private worker (D3)
// ══════════════════════════════════════════════════════════════════════════

describe('Share policies — /worker/counts acceptance (D3)', () => {
    let server, base, redis, hubServer, hubBase;
    let alice, bob, aliceToken, aliceWorkerId;

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
        await query(`DELETE FROM share_policies WHERE worker_id IN (
            SELECT worker_id FROM workers WHERE workspace_id IN (
                SELECT id FROM workspaces WHERE owner_user_id IN (
                    SELECT user_id FROM users WHERE username LIKE 'pwsharec%')))`);
        await query(`DELETE FROM workers WHERE worker_id IN (
            SELECT worker_id FROM workers WHERE workspace_id IN (
                SELECT id FROM workspaces WHERE owner_user_id IN (
                    SELECT user_id FROM users WHERE username LIKE 'pwsharec%')))`);
        await query(`DELETE FROM workspace_members WHERE workspace_id IN (
            SELECT id FROM workspaces WHERE owner_user_id IN (
                SELECT user_id FROM users WHERE username LIKE 'pwsharec%'))`);
        await query(`DELETE FROM sessions WHERE user_id IN (
            SELECT user_id FROM users WHERE username LIKE 'pwsharec%')`);
        await query(`DELETE FROM workspaces WHERE owner_user_id IN (
            SELECT user_id FROM users WHERE username LIKE 'pwsharec%')`);
        await query(`DELETE FROM users WHERE username LIKE 'pwsharec%'`);
    }

    before(async function () {
        this.timeout(60000);
        process.env.SHARE_FEATURES_ENABLED = '1';
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

        const hubApp = buildHubApp({
            redis,
            config: { BACKEND_URL: 'http://backend.test', GPU_HUB_API_KEY: null, SHARE_FEATURES_ENABLED: true },
            fetchImpl: async () => ({ ok: true, status: 200 }),
            intervals: false,
        });
        await new Promise((resolve) => {
            hubServer = hubApp.listen(0, () => {
                hubBase = `http://127.0.0.1:${hubServer.address().port}`;
                resolve();
            });
        });

        alice = await register(`pwsharec_alice_${Date.now()}`);
        bob = await register(`pwsharec_bob_${Date.now() + 1}`);

        const cw = await fetch(`${base}/api/v1/workers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
            body: JSON.stringify({ name: 'alice-gpu', worker_type: 'audio' }),
        });
        const cwBody = await cw.json();
        aliceWorkerId = cwBody.worker.worker_id;
        aliceToken = cwBody.token;

        // Start sharing through the API (owner authorization, D4 point update).
        const share = await fetch(`${base}/api/v1/workers/${aliceWorkerId}/share`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
            body: '{}',
        });
        expect(share.status).to.equal(201);
    });

    after(async function () {
        this.timeout(30000);
        delete process.env.SHARE_FEATURES_ENABLED;
        if (server) server.close();
        if (hubServer) hubServer.close();
        await cleanup();
    });

    it('policy-active private worker ONLINE: counted in owner private AND global pool for everyone (D3)', async () => {
        const beacon = await fetch(`${hubBase}/beacon`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
            body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, gpu: 'RTX4090', vram: '24' }),
        });
        expect(beacon.status).to.equal(200);

        // The beacon heartbeat carries the share_policy marker.
        const hb = JSON.parse(await redis.get(config.WORKER_HEARTBEAT_KEY('audio', aliceWorkerId)));
        expect(hb.mode).to.equal('private');
        expect(hb.workspace_id).to.equal(alice.workspaceId);
        expect(hb.share_policy).to.be.an('object');
        expect(hb.share_policy.scope_kind).to.equal('public');

        async function getCounts(cookie) {
            const res = await fetch(`${base}/api/v1/worker/counts`, {
                headers: cookie ? { Cookie: cookie } : {},
            });
            expect(res.status).to.equal(200);
            return res.json();
        }

        const a = await getCounts(alice.cookie);
        expect(a.private_audio).to.equal(1); // "what do I own"
        expect(a.audio).to.equal(1);         // "what can I submit jobs to" — D3 double count

        const b = await getCounts(bob.cookie);
        expect(b.audio).to.equal(1);         // the pool grew for other users too
        expect(b.private_audio).to.equal(0);

        const anon = await getCounts(null);
        expect(anon.audio).to.equal(1);
        expect(anon.private_audio).to.equal(0);
    });
});
