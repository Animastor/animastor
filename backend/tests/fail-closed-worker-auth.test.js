// ======================================================
// Fail-Closed Worker Authorization Tests (PW-4)
// ======================================================
// The iron rule of the system:
//
//   "A missing or invalid credential NEVER means SYSTEM or SHARE.
//    Such a worker is UNAUTHORIZED/OFFLINE and takes no part in
//    counters or dispatch."
//
// Matrix:
//   hub boundary (fail-closed)
//     no credential on beacon/task-next/result/error → 401              ok
//     invalid credential → 401 invalid_worker_credential                ok
//     SYSTEM credential → beacon ok, heartbeat mode='system'            ok
//     SYSTEM credential pops ONLY the system pool                       ok
//     SHARE credential pops the community/system pool                   ok
//     SYSTEM worker cannot complete a workspace job (403)               ok
//     requireApiKey fail-closed: unset key → 503 (never open)           ok
//     requireApiKey dev opt-out GPU_HUB_ALLOW_OPEN=1                    ok
//
//   registry (PG) fail-closed ownership
//     createSystemWorker → workspace_id NULL, mode='system'             ok
//     PG constraint: private worker without workspace is rejected       ok
//     repo createWorker refuses mode='system' (admin-only)              ok
//
//   admin SYSTEM worker management
//     anonymous → 401, regular user → 403                               ok
//     admin create → 201 + one-time token                               ok
//     admin list/rotate/revoke lifecycle                                ok
//     tenant route: mode='system' → 400                                 ok
//     tenant route: share requires confirm_share=true                   ok
//
//   /api/v1/worker/verify (CLI first-run confirmation)
//     valid private credential → identity + workspace_name + mode       ok
//     valid system credential → workspace null                          ok
//     missing/invalid credential → 401                                  ok

const { expect } = require('chai');
const crypto = require('crypto');
const express = require('express');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const { authContext } = require('../src/middleware/auth-context');
const config = require('../src/config/runtime-config');
const workerRepo = require('../src/storage/postgres/repositories/worker-repo');
const { createMockRedis } = require('./mocks/redis-mock');

const hub = require('../../gpu-hub/gpu-hub');
const { buildHubApp, WORKER_AUTH_MIRROR_KEY, PROTOCOL_VERSION } = hub;

const stamp = `fcwa${Date.now()}`;

// ── token helpers (mirror the worker-repo credential contract) ────────────

function b64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeToken(workerId) {
    const secret = crypto.randomBytes(32);
    const token = `wrk.${b64url(Buffer.from(String(workerId), 'utf8'))}.${b64url(secret)}`;
    const hash = crypto.createHash('sha256').update(secret).digest('hex');
    return { token, hash };
}

async function seedWorker(redis, { workerId, workspaceId, workerType, mode }) {
    const { token, hash } = makeToken(workerId);
    await redis.hset(WORKER_AUTH_MIRROR_KEY, hash, JSON.stringify({
        worker_id: workerId,
        workspace_id: mode === 'system' ? null : workspaceId,
        worker_type: workerType,
        mode,
        name: 'fc-test-worker',
    }));
    return token;
}

function makeTask(overrides = {}) {
    return {
        job_id: 'bookFC_ch1_sc1_0001:audio',
        params: { prompt: true },
        job_type: 'audio',
        assets: null,
        build_id: 'build-fc',
        protocol_version: PROTOCOL_VERSION,
        book_id: 'bookFC',
        chapter_id: 'ch1',
        scene_id: 'sc1',
        stage: 'audio',
        dispatch_id: 'dispatch-fc-1',
        workspace_id: null,
        timeout_ms: null,
        ...overrides,
    };
}

async function startHub({ apiKey = 'fc-hub-key', allowOpen = null } = {}) {
    const redis = createMockRedis();
    const app = buildHubApp({
        redis,
        config: {
            BACKEND_URL: 'http://backend.test',
            GPU_TIMEOUT_MS: 600000,
            GPU_HUB_API_KEY: apiKey,
            GPU_HUB_ALLOW_OPEN: allowOpen,
        },
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

function authHeaders(token, extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

// ══════════════════════════════════════════════════════════════════════════
// HUB BOUNDARY — no credential means NOTHING
// ══════════════════════════════════════════════════════════════════════════

describe('PW-4 fail-closed — hub boundary', () => {
    const WS_A = '11111111-1111-4111-8111-111111111111';
    const SYS_W = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const SHARE_W = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

    let h, sysToken, shareToken;

    beforeEach(async () => {
        h = await startHub();
        sysToken = await seedWorker(h.redis, { workerId: SYS_W, workerType: 'audio', mode: 'system' });
        shareToken = await seedWorker(h.redis, { workerId: SHARE_W, workspaceId: WS_A, workerType: 'audio', mode: 'share' });
    });

    afterEach(async () => {
        if (h) await h.stop();
    });

    it('no credential → 401 worker_authentication_failed on ALL worker-facing endpoints', async () => {
        const beacon = await fetch(`${h.base}/beacon`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 'rogue', type: 'audio', protocol_version: PROTOCOL_VERSION }),
        });
        expect(beacon.status).to.equal(401);
        const bBody = await beacon.json();
        expect(bBody.error).to.equal('worker_authentication_failed');
        expect(bBody.message).to.include('ANIMASTOR_WORKER_TOKEN');

        const next = await fetch(`${h.base}/task/next?worker=rogue&type=audio`);
        expect(next.status).to.equal(401);
        expect((await next.json()).error).to.equal('worker_authentication_failed');

        const result = await fetch(`${h.base}/task/result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_id: 'j', build_id: 'b', dispatch_id: 'd', protocol_version: PROTOCOL_VERSION, result_base64: 'x' }),
        });
        expect(result.status).to.equal(401);

        const err = await fetch(`${h.base}/task/error`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_id: 'j', build_id: 'b', dispatch_id: 'd', protocol_version: PROTOCOL_VERSION }),
        });
        expect(err.status).to.equal(401);

        // The rogue worker left NO trace: no registration, no heartbeat.
        expect(await h.redis.hget('animastor:gpu-hub:workers', 'rogue')).to.equal(null);
        expect(await h.redis.get(`animastor:worker:heartbeat:audio:rogue`)).to.equal(null);
    });

    it('invalid credential → 401 invalid_worker_credential', async () => {
        const ghost = makeToken('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
        const beacon = await fetch(`${h.base}/beacon`, {
            method: 'POST',
            headers: authHeaders(ghost.token),
            body: JSON.stringify({ protocol_version: PROTOCOL_VERSION }),
        });
        expect(beacon.status).to.equal(401);
        expect((await beacon.json()).error).to.equal('invalid_worker_credential');
    });

    it('SYSTEM credential beacons and the heartbeat carries mode=system', async () => {
        const res = await fetch(`${h.base}/beacon`, {
            method: 'POST',
            headers: authHeaders(sysToken),
            body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, gpu: 'A100', vram: '40' }),
        });
        expect(res.status).to.equal(200);

        const hb = JSON.parse(await h.redis.get(`animastor:worker:heartbeat:audio:${SYS_W}`));
        expect(hb.mode).to.equal('system');
        expect(hb.workspace_id).to.equal(null);

        const registered = JSON.parse(await h.redis.hget('animastor:gpu-hub:workers', SYS_W));
        expect(registered.id).to.equal(SYS_W);
        expect(registered.workspace_id).to.equal(null);
    });

    it('SYSTEM worker pops ONLY the system pool — never workspace queues', async () => {
        await fetch(`${h.base}/beacon`, {
            method: 'POST',
            headers: authHeaders(sysToken),
            body: JSON.stringify({ protocol_version: PROTOCOL_VERSION }),
        });
        // Enqueue one workspace job + one system-pool job.
        for (const t of [
            makeTask({ workspace_id: WS_A, dispatch_id: 'd-ws' }),
            makeTask({ job_id: 'bookFC_ch1_sc2_0001:audio', dispatch_id: 'd-sys' }),
        ]) {
            const r = await fetch(`${h.base}/task`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': 'fc-hub-key' },
                body: JSON.stringify(t),
            });
            expect(r.status).to.equal(200);
        }

        const res = await fetch(`${h.base}/task/next?type=audio`, { headers: authHeaders(sysToken) });
        const body = await res.json();
        expect(body.task.job_id).to.equal('bookFC_ch1_sc2_0001:audio');
        expect(body.task.workspace_id).to.equal(null);
        // The workspace job stays untouched in the workspace queue.
        expect(await h.redis.llen(`animastor:queue:audio:ws:${WS_A}`)).to.equal(1);
    });

    it('SHARE worker pops the community/system pool', async () => {
        await fetch(`${h.base}/beacon`, {
            method: 'POST',
            headers: authHeaders(shareToken),
            body: JSON.stringify({ protocol_version: PROTOCOL_VERSION }),
        });
        await fetch(`${h.base}/task`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': 'fc-hub-key' },
            body: JSON.stringify(makeTask({ job_id: 'bookFC_ch1_sc3_0001:audio', dispatch_id: 'd-share' })),
        });

        const res = await fetch(`${h.base}/task/next?type=audio`, { headers: authHeaders(shareToken) });
        const body = await res.json();
        expect(body.task.job_id).to.equal('bookFC_ch1_sc3_0001:audio');
    });

    it('SYSTEM worker cannot complete a workspace job (claimer check, 403)', async () => {
        // A private worker claims a workspace job first.
        const PRIV_W = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const privToken = await seedWorker(h.redis, { workerId: PRIV_W, workspaceId: WS_A, workerType: 'audio', mode: 'private' });
        await fetch(`${h.base}/beacon`, {
            method: 'POST', headers: authHeaders(privToken),
            body: JSON.stringify({ protocol_version: PROTOCOL_VERSION }),
        });
        await fetch(`${h.base}/task`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': 'fc-hub-key' },
            body: JSON.stringify(makeTask({ workspace_id: WS_A })),
        });
        const claimed = await (await fetch(`${h.base}/task/next?type=audio`, { headers: authHeaders(privToken) })).json();
        expect(claimed.task).to.exist;

        // The SYSTEM worker tries to complete it — same pool, different lane.
        const res = await fetch(`${h.base}/task/result`, {
            method: 'POST',
            headers: authHeaders(sysToken),
            body: JSON.stringify({
                job_id: claimed.task.job_id,
                build_id: claimed.task.build_id,
                dispatch_id: claimed.task.dispatch_id,
                protocol_version: PROTOCOL_VERSION,
                result_base64: 'data:audio/mp3;base64,QUJD',
            }),
        });
        expect(res.status).to.equal(403);
        expect((await res.json()).error).to.equal('not_task_claimer');
    });

    it('requireApiKey FAIL CLOSED: unset key → 503 on /task and /queue/clear (never open)', async () => {
        const open = await startHub({ apiKey: null });
        try {
            const res = await fetch(`${open.base}/task`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(makeTask()),
            });
            expect(res.status).to.equal(503);
            expect((await res.json()).error).to.equal('hub_api_key_not_configured');

            const clear = await fetch(`${open.base}/queue/clear`, { method: 'DELETE' });
            expect(clear.status).to.equal(503);
        } finally {
            await open.stop();
        }
    });

    it('requireApiKey dev opt-out: GPU_HUB_ALLOW_OPEN=1 reopens keyless endpoints', async () => {
        const dev = await startHub({ apiKey: null, allowOpen: '1' });
        try {
            const res = await fetch(`${dev.base}/task`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(makeTask()),
            });
            expect(res.status).to.equal(200);
        } finally {
            await dev.stop();
        }
    });
});

// ══════════════════════════════════════════════════════════════════════════
// REGISTRY — fail-closed ownership in PG
// ══════════════════════════════════════════════════════════════════════════

describe('PW-4 fail-closed — registry ownership (PG)', () => {
    before(async function () {
        this.timeout(60000);
        await runMigrations();
    });

    it('createSystemWorker creates a workspace-less mode=system worker', async () => {
        const { worker, token } = await workerRepo.createSystemWorker({
            name: `fc-sys-${stamp}`, workerType: 'video',
        });
        try {
            expect(worker.workspace_id).to.equal(null);
            expect(worker.mode).to.equal('system');
            expect(token).to.match(/^wrk\./);
            // The credential resolves to the identity (auth path).
            const row = await workerRepo.findByToken(token);
            expect(row.worker_id).to.equal(worker.worker_id);
            expect(row.mode).to.equal('system');
        } finally {
            await query(`DELETE FROM workers WHERE worker_id = $1`, [worker.worker_id]);
        }
    });

    it('PG constraint: a private worker without workspace is rejected', async () => {
        let rejected = false;
        try {
            await query(`
                INSERT INTO workers (workspace_id, name, worker_type, mode, token_hash)
                VALUES (NULL, $1, 'audio', 'private', $2)
            `, [`fc-bad-${stamp}`, `hash-${stamp}`]);
        } catch (err) {
            rejected = true;
            expect(err.message).to.match(/workers_scope_check/i);
        }
        expect(rejected).to.equal(true);
    });

    it('repo createWorker refuses mode=system (admin-only path)', async () => {
        let rejected = false;
        try {
            await workerRepo.createWorker({
                workspaceId: '11111111-1111-4111-8111-111111111111',
                name: 'x', workerType: 'audio', mode: 'system',
            });
        } catch (err) {
            rejected = true;
        }
        expect(rejected).to.equal(true);
    });
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN SYSTEM worker management + tenant mode seams + /worker/verify
// ══════════════════════════════════════════════════════════════════════════

describe('PW-4 fail-closed — admin SYSTEM routes, share seam, verify', () => {
    let server, base, redis;
    let admin, user;

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
        expect(res.status).to.equal(201);
        const body = await res.json();
        return { cookie: cookieOf(res), workspaceId: body.workspace.id, userId: body.user ? body.user.id : null };
    }

    async function cleanup() {
        await query(`DELETE FROM workers WHERE mode = 'system' AND name LIKE 'fcadm%'`);
        await query(`DELETE FROM workers WHERE workspace_id IN (
            SELECT id FROM workspaces WHERE owner_user_id IN (
                SELECT user_id FROM users WHERE username LIKE 'fcadm%'))`);
        await query(`DELETE FROM workspace_members WHERE workspace_id IN (
            SELECT id FROM workspaces WHERE owner_user_id IN (
                SELECT user_id FROM users WHERE username LIKE 'fcadm%'))`);
        await query(`DELETE FROM sessions WHERE user_id IN (
            SELECT user_id FROM users WHERE username LIKE 'fcadm%')`);
        await query(`DELETE FROM workspaces WHERE owner_user_id IN (
            SELECT user_id FROM users WHERE username LIKE 'fcadm%')`);
        await query(`DELETE FROM users WHERE username LIKE 'fcadm%'`);
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
        require('../src/routes/admin-routes.cjs')(app, redis);
        await new Promise((resolve) => {
            server = app.listen(0, () => {
                base = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });

        admin = await register(`fcadm_admin_${Date.now()}`);
        user = await register(`fcadm_user_${Date.now() + 1}`);
        // Session lookups JOIN users.role per request — the promotion is
        // effective immediately, no re-login required.
        await query(`UPDATE users SET role = 'admin' WHERE username LIKE $1`, [`fcadm_admin_%`]);
    });

    after(async function () {
        this.timeout(30000);
        if (server) server.close();
        await cleanup();
    });

    // ── admin gating ──────────────────────────────────────────────────────

    it('anonymous → 401 and regular user → 403 on admin SYSTEM routes', async () => {
        const anon = await fetch(`${base}/api/v1/admin/workers/system`);
        expect(anon.status).to.equal(401);

        const regular = await fetch(`${base}/api/v1/admin/workers/system`, {
            headers: { Cookie: user.cookie },
        });
        expect(regular.status).to.equal(403);
    });

    it('admin creates a SYSTEM worker — credential disclosed exactly once', async () => {
        const res = await fetch(`${base}/api/v1/admin/workers/system`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
            body: JSON.stringify({ name: `fcadm-sys-${Date.now()}`, worker_type: 'audio' }),
        });
        expect(res.status).to.equal(201);
        const body = await res.json();
        expect(body.token).to.match(/^wrk\./);
        expect(body.worker.mode).to.equal('system');
        expect(body.worker.workspace_id).to.equal(null);

        // List never discloses the credential.
        const list = await (await fetch(`${base}/api/v1/admin/workers/system`, {
            headers: { Cookie: admin.cookie },
        })).json();
        const w = list.workers.find((x) => x.worker_id === body.worker.worker_id);
        expect(w).to.exist;
        expect(w.token).to.equal(undefined);
        expect(w.mode).to.equal('system');

        // Rotate: old credential dies, new one works.
        const rot = await fetch(`${base}/api/v1/admin/workers/system/${body.worker.worker_id}/rotate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
        });
        expect(rot.status).to.equal(200);
        const rotBody = await rot.json();
        expect(rotBody.token).to.match(/^wrk\./);
        expect(await workerRepo.findByToken(body.token)).to.equal(null); // old dead
        expect((await workerRepo.findByToken(rotBody.token)).worker_id).to.equal(body.worker.worker_id);

        // Revoke: credential dead immediately.
        const del = await fetch(`${base}/api/v1/admin/workers/system/${body.worker.worker_id}`, {
            method: 'DELETE',
            headers: { Cookie: admin.cookie },
        });
        expect(del.status).to.equal(200);
        expect(await workerRepo.findByToken(rotBody.token)).to.equal(null);
    });

    // ── tenant mode seams ─────────────────────────────────────────────────

    it('tenant route rejects mode=system (admin-only)', async () => {
        const res = await fetch(`${base}/api/v1/workers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: user.cookie },
            body: JSON.stringify({ name: 'sneaky', worker_type: 'audio', mode: 'system' }),
        });
        expect(res.status).to.equal(400);
    });

    it('tenant share worker requires explicit confirm_share', async () => {
        const noConfirm = await fetch(`${base}/api/v1/workers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: user.cookie },
            body: JSON.stringify({ name: 'share-attempt', worker_type: 'audio', mode: 'share' }),
        });
        expect(noConfirm.status).to.equal(400);
        expect((await noConfirm.json()).code).to.equal('share_confirmation_required');

        const confirmed = await fetch(`${base}/api/v1/workers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: user.cookie },
            body: JSON.stringify({ name: 'share-ok', worker_type: 'audio', mode: 'share', confirm_share: true }),
        });
        expect(confirmed.status).to.equal(201);
        const body = await confirmed.json();
        expect(body.worker.mode).to.equal('share');
        expect(body.worker.workspace_id).to.equal(user.workspaceId);
    });

    // ── /api/v1/worker/verify ─────────────────────────────────────────────

    it('verify: valid private credential → identity + workspace_name + mode', async () => {
        const created = await (await fetch(`${base}/api/v1/workers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: user.cookie },
            body: JSON.stringify({ name: 'verify-me', worker_type: 'image' }),
        })).json();

        const res = await fetch(`${base}/api/v1/worker/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.token}` },
            body: JSON.stringify({}),
        });
        expect(res.status).to.equal(200);
        const body = await res.json();
        expect(body.verified).to.equal(true);
        expect(body.worker_id).to.equal(created.worker.worker_id);
        expect(body.mode).to.equal('private');
        expect(body.worker_type).to.equal('image');
        expect(body.workspace_id).to.equal(user.workspaceId);
        expect(body.workspace_name).to.be.a('string').and.not.empty;
    });

    it('verify: valid SYSTEM credential → workspace null', async () => {
        const created = await workerRepo.createSystemWorker({
            name: `fcadm-sys-verify-${Date.now()}`, workerType: 'audio',
        });
        const res = await fetch(`${base}/api/v1/worker/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.token}` },
            body: JSON.stringify({}),
        });
        expect(res.status).to.equal(200);
        const body = await res.json();
        expect(body.mode).to.equal('system');
        expect(body.workspace_id).to.equal(null);
        expect(body.workspace_name).to.equal(null);
    });

    it('verify: missing credential → 401, invalid credential → 401', async () => {
        const missing = await fetch(`${base}/api/v1/worker/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(missing.status).to.equal(401);

        const ghost = makeToken('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
        const invalid = await fetch(`${base}/api/v1/worker/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ghost.token}` },
            body: JSON.stringify({}),
        });
        expect(invalid.status).to.equal(401);
    });
});
