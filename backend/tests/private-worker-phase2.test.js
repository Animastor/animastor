// ======================================================
// Private Worker — Phase 2 Tests (Workspace-Aware Job Ownership)
// ======================================================
// Security regression matrix for the Experimental Beta — Private Worker
// milestone, Phase 2:
//
//   Hub authentication boundary (Bearer via Redis mirror, fail closed)
//     missing credential on legacy lane → legacy behaviour kept          ok
//     invalid / revoked / unknown credential → 401 on beacon/next/result/error
//     identity is token-derived: body id/type ignored                    ok
//
//   Workspace queue isolation
//     /task with workspace_id enqueues to queue:{type}:ws:{ws}           ok
//     /task without workspace_id enqueues to the system pool             ok
//     malformed workspace_id → 400; missing api key → 401                ok
//     worker A1 pops ONLY workspace A queue (never B, never system)      ok
//     worker B1 never sees workspace A jobs                              task:null
//     uncredentialed worker pops ONLY the system pool                    ok
//     poison write (wrong workspace in own queue) → dead-lettered        ok
//
//   Claimer-only result/error
//     same-workspace worker B cannot complete worker A's task            403
//     cross-workspace worker cannot complete the task                    403
//     uncredentialed submitter cannot complete a workspace job           403
//     the claimer completes its own task                                 ok
//     wrong dispatch_id → 409                                            ok
//     error submission is symmetric                                      403/ok
//
//   Processing orphan recovery
//     orphaned processing entry requeued to ITS OWN queue after grace    ok
//     requeue cap → dead-letter + backend error (orphaned_task)          ok
//     poison processing entry → dead-lettered, never requeued            ok
//     actively claimed entry untouched                                   ok
//
//   Backend hardening
//     dispatch_id is crypto.randomBytes-backed (128-bit hex)             ok
//     dispatcher resolves workspace server-side; client value overwritten
//     routing: private worker exists → workspace queue, else system pool
//     /gpu/task/result|error re-verify job→book→workspace (403 mismatch)
//     callback hop key-gated when GPU_HUB_API_KEY configured             401
//     generation_tasks.workspace_id migration + backfill (PW-2)          ok
//     generation_tasks claimer persistence (worker_id/workspace_id)      ok
//     Redis mirror loss → hub fails closed; mirror rebuild heals         401/ok
//     workspace-scoped /queue/clear leaves other workspaces intact       ok

const { expect } = require('chai');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const dispatchEngine = require('../src/runtime/dispatch-engine');
const workerAuth = require('../src/services/worker-auth');
const workerRepo = require('../src/storage/postgres/repositories/worker-repo');
const taskRepo = require('../src/storage/postgres/repositories/task-repo');
const { createMockRedis } = require('./mocks/redis-mock');

const hub = require('../../gpu-hub/gpu-hub');
const { buildHubApp, WORKER_AUTH_MIRROR_KEY, ORPHAN_GRACE_MS } = hub;

const stamp = `pwphase2${Date.now()}`;

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

async function seedWorker(redis, { workerId, workspaceId, workerType, mode = 'private' }) {
    const { token, hash } = makeToken(workerId);
    await redis.hset(WORKER_AUTH_MIRROR_KEY, hash, JSON.stringify({
        worker_id: workerId,
        workspace_id: mode === 'system' ? null : workspaceId,
        worker_type: workerType,
        mode,
        name: 'test-worker',
    }));
    return token;
}

function makeTask(overrides = {}) {
    return {
        job_id: 'bookA_ch1_sc1_0001:audio',
        params: { prompt: true },
        job_type: 'audio',
        assets: null,
        build_id: 'build-1',
        protocol_version: 2,
        book_id: 'bookA',
        chapter_id: 'ch1',
        scene_id: 'sc1',
        stage: 'audio',
        dispatch_id: 'dispatch-test-1',
        workspace_id: null,
        timeout_ms: null,
        ...overrides,
    };
}

async function startHub({ apiKey = 'hub-key', fetchImpl } = {}) {
    const redis = createMockRedis();
    const calls = [];
    const app = buildHubApp({
        redis,
        config: {
            BACKEND_URL: 'http://backend.test',
            GPU_TIMEOUT_MS: 600000,
            GPU_HUB_API_KEY: apiKey,
        },
        fetchImpl: fetchImpl || (async (url, options) => {
            calls.push({ url, options });
            return { ok: true, status: 200 };
        }),
        intervals: false,
    });
    const server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    const port = server.address().port;
    return {
        redis, app, server, calls,
        base: `http://127.0.0.1:${port}`,
        stop: () => new Promise((r) => server.close(r)),
    };
}

function authHeaders(token, extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

async function beacon(base, token, body = {}) {
    return fetch(`${base}/beacon`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ protocol_version: 2, ...body }),
    });
}

async function postTask(base, apiKey, task) {
    return fetch(`${base}/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify(task),
    });
}

async function nextTask(base, token, params = {}) {
    const qs = new URLSearchParams(params).toString();
    return fetch(`${base}/task/next${qs ? `?${qs}` : ''}`, {
        headers: authHeaders(token),
    });
}

// ══════════════════════════════════════════════════════════════════════════
// HUB: authentication, isolation, claimer checks, orphan recovery
// ══════════════════════════════════════════════════════════════════════════

describe('Private worker Phase 2 — GPU hub ownership boundary', () => {
    const WS_A = '11111111-1111-4111-8111-111111111111';
    const WS_B = '22222222-2222-4222-8222-222222222222';
    const WORKER_A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const WORKER_A2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const WORKER_B1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    let h;
    let tokenA1, tokenA2, tokenB1;

    beforeEach(async () => {
        h = await startHub();
        tokenA1 = await seedWorker(h.redis, { workerId: WORKER_A1, workspaceId: WS_A, workerType: 'audio' });
        tokenA2 = await seedWorker(h.redis, { workerId: WORKER_A2, workspaceId: WS_A, workerType: 'audio' });
        tokenB1 = await seedWorker(h.redis, { workerId: WORKER_B1, workspaceId: WS_B, workerType: 'audio' });
    });

    afterEach(async () => {
        if (h) await h.stop();
    });

    // ── authentication boundary ───────────────────────────────────────────

    describe('authentication boundary (fail closed)', () => {
        it('rejects an invalid credential on /beacon, /task/next, /task/result, /task/error', async () => {
            const bad = 'wrk.bm90LWEtdXVpZA.bogus';
            const b = await beacon(h.base, bad, { id: 'x', type: 'audio' });
            expect(b.status).to.equal(401);

            const n = await nextTask(h.base, bad, { worker: 'x', type: 'audio' });
            expect(n.status).to.equal(401);

            const r = await fetch(`${h.base}/task/result`, {
                method: 'POST',
                headers: authHeaders(bad),
                body: JSON.stringify({ job_id: 'j', build_id: 'b', dispatch_id: 'd', protocol_version: 2, result_base64: 'x' }),
            });
            expect(r.status).to.equal(401);

            const e = await fetch(`${h.base}/task/error`, {
                method: 'POST',
                headers: authHeaders(bad),
                body: JSON.stringify({ job_id: 'j', build_id: 'b', dispatch_id: 'd', protocol_version: 2 }),
            });
            expect(e.status).to.equal(401);
        });

        it('rejects a well-formed token missing from the mirror (revoked/unknown)', async () => {
            const ghost = makeToken('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
            const b = await beacon(h.base, ghost.token, { id: 'x', type: 'audio' });
            expect(b.status).to.equal(401);
        });

        it('PW-4 FAIL CLOSED: rejects requests WITHOUT a credential — there is no legacy lane', async () => {
            const b = await beacon(h.base, null, { id: 'system-1', type: 'audio' });
            expect(b.status).to.equal(401);
            expect((await b.json()).error).to.equal('worker_authentication_failed');
            const n = await nextTask(h.base, null, { worker: 'system-1', type: 'audio' });
            expect(n.status).to.equal(401);
            // No registration, no heartbeat — the uncredentialed worker
            // became NOTHING, never SYSTEM.
            expect(await h.redis.hget('animastor:gpu-hub:workers', 'system-1')).to.equal(null);
        });

        it('derives beacon identity from the token — body id/type are ignored', async () => {
            const b = await beacon(h.base, tokenA1, { id: 'forged-id', type: 'video', gpu: 'x', vram: '1' });
            expect(b.status).to.equal(200);
            const registered = JSON.parse(await h.redis.hget('animastor:gpu-hub:workers', WORKER_A1));
            expect(registered).to.exist;
            expect(registered.id).to.equal(WORKER_A1);
            expect(registered.type).to.equal('audio');
            expect(registered.workspace_id).to.equal(WS_A);
            expect(await h.redis.hget('animastor:gpu-hub:workers', 'forged-id')).to.equal(null);
        });
    });

    // ── workspace queue isolation ─────────────────────────────────────────

    describe('workspace queue isolation', () => {
        it('/task is key-gated and validates workspace_id shape', async () => {
            const noKey = await fetch(`${h.base}/task`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(makeTask()),
            });
            expect(noKey.status).to.equal(401);

            const badWs = await postTask(h.base, 'hub-key', makeTask({ workspace_id: 'not-a-uuid' }));
            expect(badWs.status).to.equal(400);
        });

        it('routes workspace jobs to queue:{type}:ws:{ws} and others to the system pool', async () => {
            const wsTask = await postTask(h.base, 'hub-key', makeTask({ workspace_id: WS_A, dispatch_id: 'd-ws' }));
            expect(wsTask.status).to.equal(200);
            const sysTask = await postTask(h.base, 'hub-key', makeTask({ job_id: 'bookA_ch1_sc2_0001:audio', dispatch_id: 'd-sys' }));
            expect(sysTask.status).to.equal(200);

            expect(await h.redis.llen(`animastor:queue:audio:ws:${WS_A}`)).to.equal(1);
            expect(await h.redis.llen('animastor:queue:audio')).to.equal(1);
            const queued = JSON.parse((await h.redis.lrange(`animastor:queue:audio:ws:${WS_A}`, 0, -1))[0]);
            expect(queued.workspace_id).to.equal(WS_A);
        });

        it('worker A1 pops ONLY workspace A jobs — never B, never the system pool', async () => {
            await beacon(h.base, tokenA1, { id: WORKER_A1, type: 'audio' });
            await postTask(h.base, 'hub-key', makeTask({ workspace_id: WS_B, job_id: 'bookB_ch1_sc1_0001:audio', book_id: 'bookB', dispatch_id: 'd-b' }));
            await postTask(h.base, 'hub-key', makeTask({ job_id: 'bookA_ch1_sc2_0001:audio', dispatch_id: 'd-sys' }));

            const res = await nextTask(h.base, tokenA1, { worker: 'ignored', type: 'audio' });
            expect(res.status).to.equal(200);
            expect((await res.json()).task).to.equal(null);

            expect(await h.redis.llen(`animastor:queue:audio:ws:${WS_B}`)).to.equal(1);
            expect(await h.redis.llen('animastor:queue:audio')).to.equal(1);
        });

        it('worker A1 claims a workspace A job and the claim is bound to worker + workspace', async () => {
            await beacon(h.base, tokenA1, { id: WORKER_A1, type: 'audio' });
            await postTask(h.base, 'hub-key', makeTask({ workspace_id: WS_A }));

            const res = await nextTask(h.base, tokenA1, { worker: 'ignored', type: 'audio' });
            const body = await res.json();
            expect(res.status).to.equal(200);
            expect(body.task.job_id).to.equal('bookA_ch1_sc1_0001:audio');

            const running = JSON.parse(await h.redis.hget('animastor:running', body.task.job_id));
            expect(running.worker).to.equal(WORKER_A1);
            expect(running.workspace_id).to.equal(WS_A);
            expect(await h.redis.llen('animastor:processing')).to.equal(1);
        });

        it('a private worker cannot pop a type it is not registered for', async () => {
            await beacon(h.base, tokenA1, { id: WORKER_A1, type: 'audio' });
            const res = await nextTask(h.base, tokenA1, { worker: WORKER_A1, type: 'image' });
            expect(res.status).to.equal(409);
            expect((await res.json()).error).to.equal('worker_type_mismatch');
        });

        it('a SYSTEM-credentialed worker pops ONLY the system pool (never workspace queues)', async () => {
            const SYS_W = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
            const sysToken = await seedWorker(h.redis, { workerId: SYS_W, workerType: 'audio', mode: 'system' });
            await beacon(h.base, sysToken, {});
            await postTask(h.base, 'hub-key', makeTask({ workspace_id: WS_A }));
            await postTask(h.base, 'hub-key', makeTask({ job_id: 'bookA_ch1_sc2_0001:audio', dispatch_id: 'd-sys' }));

            const res = await nextTask(h.base, sysToken, { type: 'audio' });
            const body = await res.json();
            expect(body.task.job_id).to.equal('bookA_ch1_sc2_0001:audio');
            expect(body.task.workspace_id).to.equal(null);
            expect(await h.redis.llen(`animastor:queue:audio:ws:${WS_A}`)).to.equal(1);
        });

        it('a SHARE-credentialed worker serves the community/system pool too', async () => {
            const SHARE_W = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
            const shareToken = await seedWorker(h.redis, { workerId: SHARE_W, workspaceId: WS_B, workerType: 'audio', mode: 'share' });
            await beacon(h.base, shareToken, {});
            await postTask(h.base, 'hub-key', makeTask({ workspace_id: WS_A }));
            await postTask(h.base, 'hub-key', makeTask({ job_id: 'bookA_ch1_sc3_0001:audio', dispatch_id: 'd-sys2' }));

            const res = await nextTask(h.base, shareToken, { type: 'audio' });
            const body = await res.json();
            // Share worker gets the workspace-less pool job, never WS_A's private one.
            expect(body.task.job_id).to.equal('bookA_ch1_sc3_0001:audio');
            expect(body.task.workspace_id).to.equal(null);
            expect(await h.redis.llen(`animastor:queue:audio:ws:${WS_A}`)).to.equal(1);
        });

        it('poison write: an item with a foreign workspace in the own queue is dead-lettered, never handed out', async () => {
            await beacon(h.base, tokenA1, { id: WORKER_A1, type: 'audio' });
            const poison = JSON.stringify(makeTask({ workspace_id: WS_B }));
            await h.redis.lpush(`animastor:queue:audio:ws:${WS_A}`, poison);

            const res = await nextTask(h.base, tokenA1, { worker: WORKER_A1, type: 'audio' });
            expect((await res.json()).task).to.equal(null);

            expect(await h.redis.llen('animastor:processing')).to.equal(0);
            expect(await h.redis.llen('animastor:dead-letter')).to.equal(1);
            expect(await h.redis.hget('animastor:running', 'bookA_ch1_sc1_0001:audio')).to.equal(null);
        });
    });

    // ── claimer-only result/error ─────────────────────────────────────────

    describe('claimer-only result/error', () => {
        let claimedJob;

        beforeEach(async () => {
            await beacon(h.base, tokenA1, { id: WORKER_A1, type: 'audio' });
            await beacon(h.base, tokenA2, { id: WORKER_A2, type: 'audio' });
            await beacon(h.base, tokenB1, { id: WORKER_B1, type: 'audio' });
            await postTask(h.base, 'hub-key', makeTask({ workspace_id: WS_A }));
            const res = await nextTask(h.base, tokenA1, { worker: WORKER_A1, type: 'audio' });
            claimedJob = (await res.json()).task;
            expect(claimedJob).to.exist;
        });

        function resultBody(overrides = {}) {
            return {
                job_id: claimedJob.job_id,
                build_id: claimedJob.build_id,
                dispatch_id: claimedJob.dispatch_id,
                protocol_version: 2,
                result_base64: 'data:audio/mp3;base64,QUJD',
                ...overrides,
            };
        }

        it('same-workspace worker A2 cannot complete worker A1\'s task (403)', async () => {
            const res = await fetch(`${h.base}/task/result`, {
                method: 'POST',
                headers: authHeaders(tokenA2),
                body: JSON.stringify(resultBody()),
            });
            expect(res.status).to.equal(403);
            expect((await res.json()).error).to.equal('not_task_claimer');
            expect(await h.redis.hget('animastor:running', claimedJob.job_id)).to.not.equal(null);
        });

        it('cross-workspace worker B1 cannot complete the task (403)', async () => {
            const res = await fetch(`${h.base}/task/result`, {
                method: 'POST',
                headers: authHeaders(tokenB1),
                body: JSON.stringify(resultBody()),
            });
            expect(res.status).to.equal(403);
        });

        it('PW-4 FAIL CLOSED: an uncredentialed submitter is rejected (401, never a claimer)', async () => {
            const res = await fetch(`${h.base}/task/result`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(resultBody()),
            });
            expect(res.status).to.equal(401);
            expect((await res.json()).error).to.equal('worker_authentication_failed');
            expect(await h.redis.hget('animastor:running', claimedJob.job_id)).to.not.equal(null);
        });

        it('a wrong dispatch_id is rejected (409) even from the claimer', async () => {
            const res = await fetch(`${h.base}/task/result`, {
                method: 'POST',
                headers: authHeaders(tokenA1),
                body: JSON.stringify(resultBody({ dispatch_id: 'dispatch-forged' })),
            });
            expect(res.status).to.equal(409);
        });

        it('the claimer completes its own task and the backend hop carries claimer identity', async () => {
            const res = await fetch(`${h.base}/task/result`, {
                method: 'POST',
                headers: authHeaders(tokenA1),
                body: JSON.stringify(resultBody()),
            });
            expect(res.status).to.equal(200);
            expect(await h.redis.hget('animastor:running', claimedJob.job_id)).to.equal(null);
            expect(await h.redis.llen('animastor:processing')).to.equal(0);

            const hop = h.calls.find(c => c.url.includes('/gpu/task/result'));
            expect(hop).to.exist;
            const sent = JSON.parse(hop.options.body);
            expect(sent.worker_id).to.equal(WORKER_A1);
            expect(sent.workspace_id).to.equal(WS_A);
            expect(hop.options.headers['x-api-key']).to.equal('hub-key');
        });

        it('error submission is symmetric: A2 rejected (403), claimer A1 accepted', async () => {
            const errBody = {
                job_id: claimedJob.job_id,
                build_id: claimedJob.build_id,
                dispatch_id: claimedJob.dispatch_id,
                protocol_version: 2,
                reason: 'worker_error',
            };
            const denied = await fetch(`${h.base}/task/error`, {
                method: 'POST',
                headers: authHeaders(tokenA2),
                body: JSON.stringify(errBody),
            });
            expect(denied.status).to.equal(403);

            const ok = await fetch(`${h.base}/task/error`, {
                method: 'POST',
                headers: authHeaders(tokenA1),
                body: JSON.stringify(errBody),
            });
            expect(ok.status).to.equal(200);
            expect(await h.redis.hget('animastor:running', claimedJob.job_id)).to.equal(null);
        });

        it('a SYSTEM-credentialed worker can claim and complete a system-pool job', async () => {
            const SYS_W = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
            const sysToken = await seedWorker(h.redis, { workerId: SYS_W, workerType: 'audio', mode: 'system' });
            await beacon(h.base, sysToken, {});
            await postTask(h.base, 'hub-key', makeTask({ job_id: 'bookA_ch1_sc9_0001:audio', dispatch_id: 'd-sys9' }));
            const res = await nextTask(h.base, sysToken, { type: 'audio' });
            const sysJob = (await res.json()).task;
            expect(sysJob).to.exist;
            expect(sysJob.workspace_id).to.equal(null);

            const done = await fetch(`${h.base}/task/result`, {
                method: 'POST',
                headers: authHeaders(sysToken),
                body: JSON.stringify({
                    job_id: sysJob.job_id,
                    build_id: sysJob.build_id,
                    dispatch_id: sysJob.dispatch_id,
                    protocol_version: 2,
                    result_base64: 'data:audio/mp3;base64,QUJD',
                }),
            });
            expect(done.status).to.equal(200);
        });
    });

    // ── processing orphan recovery ────────────────────────────────────────

    describe('processing orphan recovery sweep', () => {
        it('requeues an orphaned claim to ITS OWN workspace queue after the grace period', async () => {
            const task = makeTask({ workspace_id: WS_A });
            const raw = JSON.stringify(task);
            await h.redis.lpush('animastor:processing', raw);

            const t0 = Date.now();
            await h.app.__hub.sweepProcessingOrphans(t0);
            expect(await h.redis.llen('animastor:processing')).to.equal(1);
            expect(await h.redis.llen(`animastor:queue:audio:ws:${WS_A}`)).to.equal(0);

            await h.app.__hub.sweepProcessingOrphans(t0 + ORPHAN_GRACE_MS + 1000);
            expect(await h.redis.llen('animastor:processing')).to.equal(0);
            const requeued = JSON.parse((await h.redis.lrange(`animastor:queue:audio:ws:${WS_A}`, 0, -1))[0]);
            expect(requeued.job_id).to.equal(task.job_id);
            expect(requeued.orphan_requeues).to.equal(1);
        });

        it('requeues a system-pool orphan back to the system pool', async () => {
            const task = makeTask({ workspace_id: null });
            await h.redis.lpush('animastor:processing', JSON.stringify(task));
            const t0 = Date.now();
            await h.app.__hub.sweepProcessingOrphans(t0);
            await h.app.__hub.sweepProcessingOrphans(t0 + ORPHAN_GRACE_MS + 1000);
            expect(await h.redis.llen('animastor:queue:audio')).to.equal(1);
        });

        it('dead-letters an orphan after the requeue cap and notifies the backend', async () => {
            const task = makeTask({ workspace_id: WS_A, orphan_requeues: 3 });
            await h.redis.lpush('animastor:processing', JSON.stringify(task));
            const t0 = Date.now();
            await h.app.__hub.sweepProcessingOrphans(t0);
            await h.app.__hub.sweepProcessingOrphans(t0 + ORPHAN_GRACE_MS + 1000);

            expect(await h.redis.llen('animastor:processing')).to.equal(0);
            expect(await h.redis.llen(`animastor:queue:audio:ws:${WS_A}`)).to.equal(0);
            expect(await h.redis.llen('animastor:dead-letter')).to.equal(1);

            const hop = h.calls.find(c => c.url.includes('/gpu/task/error'));
            expect(hop).to.exist;
            expect(JSON.parse(hop.options.body).reason).to.equal('orphaned_task');
        });

        it('dead-letters poison processing entries without ever requeueing them', async () => {
            await h.redis.lpush('animastor:processing', '{not-json');
            const t0 = Date.now();
            await h.app.__hub.sweepProcessingOrphans(t0);
            expect(await h.redis.llen('animastor:processing')).to.equal(0);
            expect(await h.redis.llen('animastor:dead-letter')).to.equal(1);
            expect(h.calls).to.have.length(0);
        });

        it('leaves actively claimed entries untouched', async () => {
            const task = makeTask({ workspace_id: WS_A });
            const raw = JSON.stringify(task);
            await h.redis.lpush('animastor:processing', raw);
            await h.redis.hset('animastor:running', task.job_id, JSON.stringify({ worker: WORKER_A1, task_raw: raw }));

            const t0 = Date.now();
            await h.app.__hub.sweepProcessingOrphans(t0);
            await h.app.__hub.sweepProcessingOrphans(t0 + ORPHAN_GRACE_MS * 10);

            expect(await h.redis.llen('animastor:processing')).to.equal(1);
            expect(await h.redis.llen('animastor:dead-letter')).to.equal(0);
            expect(await h.redis.llen(`animastor:queue:audio:ws:${WS_A}`)).to.equal(0);
        });
    });

    // ── workspace-scoped queue/clear + health ─────────────────────────────

    describe('workspace-scoped queue/clear and health', () => {
        it('clears ONLY the given workspace, leaving others and the system pool intact', async () => {
            await postTask(h.base, 'hub-key', makeTask({ workspace_id: WS_A, dispatch_id: 'd-a' }));
            await postTask(h.base, 'hub-key', makeTask({ workspace_id: WS_B, job_id: 'bookB_ch1_sc1_0001:audio', book_id: 'bookB', dispatch_id: 'd-b' }));
            await postTask(h.base, 'hub-key', makeTask({ job_id: 'bookA_ch1_sc2_0001:audio', dispatch_id: 'd-sys' }));

            const res = await fetch(`${h.base}/queue/clear?workspace_id=${WS_A}`, {
                method: 'DELETE',
                headers: { 'x-api-key': 'hub-key' },
            });
            expect(res.status).to.equal(200);
            const body = await res.json();
            expect(body.removed.queued).to.equal(1);

            expect(await h.redis.llen(`animastor:queue:audio:ws:${WS_A}`)).to.equal(0);
            expect(await h.redis.llen(`animastor:queue:audio:ws:${WS_B}`)).to.equal(1);
            expect(await h.redis.llen('animastor:queue:audio')).to.equal(1);
        });

        it('/health reports workspace queue depths', async () => {
            await postTask(h.base, 'hub-key', makeTask({ workspace_id: WS_A }));
            const res = await fetch(`${h.base}/health`);
            const body = await res.json();
            expect(body.workspace_queues[`animastor:queue:audio:ws:${WS_A}`]).to.equal(1);
            expect(body.queues.audio).to.equal(0);
        });
    });
});

// ══════════════════════════════════════════════════════════════════════════
// BACKEND: dispatch hardening, routing, callback re-verification, migration
// ══════════════════════════════════════════════════════════════════════════

describe('Private worker Phase 2 — backend dispatch & callback hardening', () => {

    describe('dispatch_id entropy (crypto hardening)', () => {
        it('generates 128-bit hex randomness and never collides', () => {
            const seen = new Set();
            for (let i = 0; i < 1000; i++) {
                const token = dispatchEngine.generateDispatchToken();
                expect(token).to.match(/^dispatch-\d+-[0-9a-f]{32}$/);
                seen.add(token);
            }
            expect(seen.size).to.equal(1000);
        });
    });

    describe('server-derived workspace routing (gpu-dispatcher)', () => {
        const WS_A = '11111111-1111-4111-8111-111111111111';
        const WS_B = '22222222-2222-4222-8222-222222222222';
        const repoPaths = [
            '../src/storage/postgres/repositories/book-repo',
            '../src/storage/postgres/repositories/worker-repo',
        ];
        const savedCache = new Map();
        let gpuDispatcher;
        let sentBodies;
        let originalFetch;

        function stub(request, exports) {
            const resolved = require.resolve(request);
            require.cache[resolved] = { exports, id: resolved, filename: resolved, loaded: true };
        }

        beforeEach(() => {
            savedCache.clear();
            for (const request of repoPaths) {
                const resolved = require.resolve(request);
                savedCache.set(resolved, require.cache[resolved]);
                delete require.cache[resolved];
            }
            const dispatcherPath = require.resolve('../src/runtime/gpu-dispatcher');
            savedCache.set(dispatcherPath, require.cache[dispatcherPath]);
            delete require.cache[dispatcherPath];
            gpuDispatcher = require('../src/runtime/gpu-dispatcher');
            gpuDispatcher.clearRoutingCaches();

            sentBodies = [];
            originalFetch = global.fetch;
            global.fetch = async (url, options) => {
                sentBodies.push(JSON.parse(options.body));
                return { ok: true, status: 200 };
            };
        });

        afterEach(() => {
            global.fetch = originalFetch;
            for (const [resolved, saved] of savedCache) {
                if (saved) require.cache[resolved] = saved;
                else delete require.cache[resolved];
            }
        });

        function stubRepos({ bookWorkspace, hasPrivateWorker }) {
            stub('../src/storage/postgres/repositories/book-repo', {
                getWorkspaceId: async () => bookWorkspace,
            });
            stub('../src/storage/postgres/repositories/worker-repo', {
                hasActivePrivateWorkerOfType: async () => hasPrivateWorker,
            });
        }

        it('routes to the workspace queue when the workspace has an active private worker', async () => {
            stubRepos({ bookWorkspace: WS_A, hasPrivateWorker: true });
            const result = await gpuDispatcher.sendUnified({
                job_id: 'bookA_ch1_sc1_0001:audio',
                params: {},
                job_type: 'audio',
                build_id: 'b1',
                dispatch_id: 'dispatch-x',
            });
            expect(result.sent).to.equal(true);
            expect(sentBodies[0].workspace_id).to.equal(WS_A);
        });

        it('keeps the system pool when the workspace has NO private worker of the type', async () => {
            stubRepos({ bookWorkspace: WS_A, hasPrivateWorker: false });
            await gpuDispatcher.sendUnified({
                job_id: 'bookA_ch1_sc1_0001:audio',
                params: {},
                job_type: 'audio',
                build_id: 'b1',
                dispatch_id: 'dispatch-x',
            });
            expect(sentBodies[0].workspace_id).to.equal(null);
        });

        it('keeps the system pool for unattached books', async () => {
            stubRepos({ bookWorkspace: null, hasPrivateWorker: true });
            await gpuDispatcher.sendUnified({
                job_id: 'bookA_ch1_sc1_0001:audio',
                params: {},
                job_type: 'audio',
                build_id: 'b1',
                dispatch_id: 'dispatch-x',
            });
            expect(sentBodies[0].workspace_id).to.equal(null);
        });

        it('OVERWRITES any client-supplied workspace_id — it is never trusted', async () => {
            stubRepos({ bookWorkspace: WS_A, hasPrivateWorker: true });
            await gpuDispatcher.sendUnified({
                job_id: 'bookA_ch1_sc1_0001:audio',
                params: {},
                job_type: 'audio',
                build_id: 'b1',
                dispatch_id: 'dispatch-x',
                workspace_id: WS_B,
            });
            expect(sentBodies[0].workspace_id).to.equal(WS_A);
        });

        it('degrades to the system pool when workspace resolution throws', async () => {
            stub('../src/storage/postgres/repositories/book-repo', {
                getWorkspaceId: async () => { throw new Error('pg down'); },
            });
            stub('../src/storage/postgres/repositories/worker-repo', {
                hasActivePrivateWorkerOfType: async () => true,
            });
            const result = await gpuDispatcher.sendUnified({
                job_id: 'bookA_ch1_sc1_0001:audio',
                params: {},
                job_type: 'audio',
                build_id: 'b1',
                dispatch_id: 'dispatch-x',
            });
            expect(result.sent).to.equal(true);
            expect(sentBodies[0].workspace_id).to.equal(null);
        });
    });

    describe('worker.cjs Bearer support (source contract)', () => {
        it('sends the credential on every hub call when ANIMASTOR_WORKER_TOKEN is set', () => {
            const workerSource = fs.readFileSync(
                path.join(__dirname, '../../worker/worker/worker.cjs'), 'utf8'
            );
            expect(workerSource).to.match(/ANIMASTOR_WORKER_TOKEN/);
            expect(workerSource).to.match(/Bearer \$\{ANIMASTOR_WORKER_TOKEN\}/);
            expect(workerSource.match(/headers: hubHeaders\(\)/g)).to.have.length.at.least(4);
        });
    });
});

describe('Private worker Phase 2 — PG persistence & callback re-verification', () => {
    const WS_NAME_A = `pwphase2_ws_a_${stamp}`;
    const WS_NAME_B = `pwphase2_ws_b_${stamp}`;
    const BOOK_A = `pwphase2_book_a_${stamp}`;
    let wsA, wsB;
    let redis;
    let server, base;

    async function cleanup() {
        await query(`DELETE FROM generation_tasks WHERE book_id = $1`, [BOOK_A]);
        await query(`DELETE FROM books WHERE book_id = $1`, [BOOK_A]);
        await query(`DELETE FROM workspaces WHERE name IN ($1, $2)`, [WS_NAME_A, WS_NAME_B]);
    }

    before(async function () {
        this.timeout(60000);
        await runMigrations();
        await cleanup();

        const wsRows = await query(
            `INSERT INTO workspaces (name) VALUES ($1), ($2) RETURNING id, name`,
            [WS_NAME_A, WS_NAME_B]
        );
        for (const row of wsRows.rows) {
            if (row.name === WS_NAME_A) wsA = row.id;
            else wsB = row.id;
        }
        await query(
            `INSERT INTO books (book_id, workspace_id, title) VALUES ($1, $2, 'pw2 test book')`,
            [BOOK_A, wsA]
        );

        redis = createMockRedis();
        const app = express();
        app.use(express.json({ limit: '50mb' }));
        const registerGenerationRoutes = require('../src/routes/generation-routes.cjs');
        registerGenerationRoutes(app, redis, {
            config: {
                GPU_HUB_API_KEY: 'cb-key',
                OUTPUT_DIR: '/tmp/pw2-test-output',
                HUB_URL: 'http://gpu-hub.invalid',
            },
            utils: { log: () => {} },
            orchestrator: { failStage: async () => ({ failed: true }) },
            taskHandler: { handleTaskResult: async () => {} },
            book: { loadBook: () => null },
        });
        await new Promise((resolve) => {
            server = app.listen(0, () => {
                app.__port = server.address().port;
                base = `http://127.0.0.1:${app.__port}`;
                resolve();
            });
        });
    });

    after(async function () {
        this.timeout(30000);
        if (server) server.close();
        await cleanup();
    });

    function callbackBody(overrides = {}) {
        return {
            job_id: `${BOOK_A}_ch1_sc1_0001:audio`,
            build_id: 'build-1',
            dispatch_id: 'dispatch-cb-1',
            protocol_version: 2,
            result_base64: 'data:audio/mp3;base64,QUJD',
            ...overrides,
        };
    }

    async function seedDispatchMeta() {
        await dispatchEngine.setDispatchMetadata(redis, BOOK_A, 'ch1', 'sc1', 'audio', {
            dispatch_id: 'dispatch-cb-1',
            stage: 'audio',
            started_at: Date.now(),
            worker: 'scheduler',
            retry_attempt: 0,
            status: 'dispatched',
        });
    }

    it('PW-2 migration: generation_tasks.workspace_id exists and backfills from books', async () => {
        const { rows } = await query(`
            SELECT data_type FROM information_schema.columns
            WHERE table_name = 'generation_tasks' AND column_name = 'workspace_id'
        `);
        expect(rows).to.have.length(1);
        expect(rows[0].data_type).to.equal('uuid');

        const taskId = `pw2-backfill-${stamp}`;
        await query(`
            INSERT INTO generation_tasks (task_id, book_id, task_type)
            VALUES ($1, $2, 'audio')
        `, [taskId, BOOK_A]);
        await runMigrations();
        const { rows: taskRows } = await query(
            `SELECT workspace_id FROM generation_tasks WHERE task_id = $1`, [taskId]
        );
        expect(taskRows[0].workspace_id).to.equal(wsA);
        await query(`DELETE FROM generation_tasks WHERE task_id = $1`, [taskId]);
    });

    it('createTask persists the server-derived workspace_id; recordTaskClaim records the claimer', async () => {
        const taskId = `pw2-claim-${stamp}`;
        await taskRepo.createTask(taskId, BOOK_A, 'ch1', 'sc1', 'audio', null, wsA);
        await taskRepo.updateTaskStatus(taskId, 'running');

        const updated = await taskRepo.recordTaskClaim(BOOK_A, 'ch1', 'sc1', 'audio', 'worker-xyz', wsA);
        expect(updated).to.equal(1);

        const { rows } = await query(
            `SELECT worker_id, workspace_id FROM generation_tasks WHERE task_id = $1`, [taskId]
        );
        expect(rows[0].worker_id).to.equal('worker-xyz');
        expect(rows[0].workspace_id).to.equal(wsA);
        await query(`DELETE FROM generation_tasks WHERE task_id = $1`, [taskId]);
    });

    it('callback hop is key-gated when GPU_HUB_API_KEY is configured', async () => {
        const res = await fetch(`${base}/gpu/task/result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(callbackBody()),
        });
        expect(res.status).to.equal(401);
    });

    it('/gpu/task/result rejects a forwarded workspace that does not own the book (403)', async () => {
        const res = await fetch(`${base}/gpu/task/result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': 'cb-key' },
            body: JSON.stringify(callbackBody({ workspace_id: wsB, worker_id: 'attacker' })),
        });
        expect(res.status).to.equal(403);
        expect((await res.json()).error).to.equal('workspace_mismatch');
    });

    it('/gpu/task/error rejects a workspace mismatch too (403)', async () => {
        const res = await fetch(`${base}/gpu/task/error`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': 'cb-key' },
            body: JSON.stringify({
                job_id: `${BOOK_A}_ch1_sc1_0001:audio`,
                build_id: 'build-1',
                dispatch_id: 'dispatch-cb-1',
                protocol_version: 2,
                reason: 'worker_error',
                workspace_id: wsB,
            }),
        });
        expect(res.status).to.equal(403);
    });

    it('/gpu/task/result accepts the owning workspace and persists the claimer', async () => {
        const taskId = `pw2-cb-${stamp}`;
        await taskRepo.createTask(taskId, BOOK_A, 'ch1', 'sc1', 'audio', null, wsA);
        await taskRepo.updateTaskStatus(taskId, 'running');
        await seedDispatchMeta();

        const res = await fetch(`${base}/gpu/task/result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': 'cb-key' },
            body: JSON.stringify(callbackBody({ workspace_id: wsA, worker_id: 'worker-claim-1' })),
        });
        expect(res.status).to.equal(200);
        expect((await res.json()).ok).to.equal(true);

        const { rows } = await query(
            `SELECT worker_id FROM generation_tasks WHERE task_id = $1`, [taskId]
        );
        expect(rows[0].worker_id).to.equal('worker-claim-1');
        await query(`DELETE FROM generation_tasks WHERE task_id = $1`, [taskId]);
    });

    it('system-lane callback (no workspace forwarded) stays accepted for attached books', async () => {
        await seedDispatchMeta();
        const res = await fetch(`${base}/gpu/task/error`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': 'cb-key' },
            body: JSON.stringify({
                job_id: `${BOOK_A}_ch1_sc1_0001:audio`,
                build_id: 'build-1',
                dispatch_id: 'dispatch-cb-1',
                protocol_version: 2,
                reason: 'worker_error',
            }),
        });
        expect(res.status).to.equal(200);
        expect((await res.json()).ok).to.equal(true);
    });
});

describe('Private worker Phase 2 — mirror loss fails closed and heals', () => {
    const stamp2 = `pwphase2mirror${Date.now()}`;
    let redis, app, server, base;
    let token, workerId, workspaceId;

    before(async function () {
        this.timeout(60000);
        await runMigrations();
    });

    after(async function () {
        this.timeout(30000);
        if (server) server.close();
        if (workspaceId) {
            await query(`DELETE FROM workers WHERE workspace_id = $1`, [workspaceId]);
            await query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
        }
    });

    it('hub denies a valid credential when the mirror is lost, and heals on rebuild', async () => {
        const wsRow = await query(
            `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`pwphase2_mirror_${stamp2}`]
        );
        workspaceId = wsRow.rows[0].id;
        const created = await workerRepo.createWorker({
            workspaceId,
            name: 'mirror-test',
            workerType: 'audio',
        });
        token = created.token;
        workerId = created.worker.worker_id;

        redis = createMockRedis();
        await workerAuth.syncWorkerAuthMirror(redis);

        app = buildHubApp({
            redis,
            config: { BACKEND_URL: 'http://backend.test', GPU_HUB_API_KEY: null },
            fetchImpl: async () => ({ ok: true, status: 200 }),
            intervals: false,
        });
        await new Promise((resolve) => {
            server = app.listen(0, () => {
                base = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });

        const okBeacon = await beacon(base, token, { id: workerId, type: 'audio' });
        expect(okBeacon.status).to.equal(200);

        // Simulate Redis loss of the mirror hash (the mock stores hash fields
        // as flat `key:field` entries — drop them all).
        const scan = await redis.scan('0', 'MATCH', `${WORKER_AUTH_MIRROR_KEY}:*`);
        if (scan[1].length) await redis.del(...scan[1]);
        const denied = await beacon(base, token, { id: workerId, type: 'audio' });
        expect(denied.status).to.equal(401);
        const deniedNext = await nextTask(base, token, { worker: workerId, type: 'audio' });
        expect(deniedNext.status).to.equal(401);

        await workerAuth.syncWorkerAuthMirror(redis);
        const healed = await beacon(base, token, { id: workerId, type: 'audio' });
        expect(healed.status).to.equal(200);
    });
});
