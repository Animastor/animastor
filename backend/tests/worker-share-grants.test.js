// ======================================================
// Worker Share Grants Tests (Experimental Beta — SH-2, worker sharing V2)
// ======================================================
// Test matrix for personal sharing (worker-sharing-model-design.md §15):
//
//   share_policy_grants schema (table, unique pair, indexes)              ✓
//   grant CRUD authz: owner yes / foreign worker → indistinct 404         ✓
//   no active users policy → 409 (POST /share/users)                      ✓
//   unknown username → 400 with unknown_users (no policy created)         ✓
//   self-grant forbidden (owner ≠ recipient)                              ✓
//   duplicate grant is idempotent (ON CONFLICT) + one event only          ✓
//   grant survives worker restart; dies with policy (stop → hard delete)  ✓
//   expiry of the policy removes "shared with me"                         ✓
//   stop sharing drains the policy lane into the public pool              ✓
//   hub: users-policy worker pops its OWN policy lane (never system pool)  ✓
//   hub: pop precedence ws lane → policy lane; system pool NEVER          ✓
//   hub: foreign policy task in policy lane = poison → dead-letter        ✓
//   hub: users claim finishes (taskLaneMatch V2) + heartbeat marker        ✓
//   hub: orphan policy-lane task requeues to its own policy lane           ✓
//   kill-switch OFF → whole V2 surface 404; routing to system pool         ✓
//   shared-with-me route precedes /:workerId (no param capture)            ✓
//   user lookup: exact match, guests forbidden, no sensitive fields        ✓
//   share events: payload contract + one event per new recipient           ✓

const { expect } = require('chai');
const express = require('express');
const crypto = require('crypto');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const { authContext } = require('../src/middleware/auth-context');
const config = require('../src/config/runtime-config');
const workerRepo = require('../src/storage/postgres/repositories/worker-repo');
const userRepo = require('../src/storage/postgres/repositories/user-repo');
const shareEvents = require('../src/services/share-events');
const { createMockRedis } = require('./mocks/redis-mock');

const hub = require('../../gpu-hub/gpu-hub');
const { buildHubApp, PROTOCOL_VERSION, WORKER_AUTH_MIRROR_KEY } = hub;

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const POLICY_A = '33333333-3333-4333-8333-333333333333';
const POLICY_B = '44444444-4444-4444-8444-444444444444';

// ══════════════════════════════════════════════════════════════════════════
// Shared helpers
// ══════════════════════════════════════════════════════════════════════════

function makeToken(workerId) {
    const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const secret = crypto.randomBytes(32);
    return {
        token: `wrk.${b64url(Buffer.from(String(workerId), 'utf8'))}.${b64url(secret)}`,
        hash: crypto.createHash('sha256').update(secret).digest('hex'),
    };
}

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

function hubTask(jobId, { workspaceId = null, policyId = null, type = 'audio' } = {}) {
    return {
        job_id: jobId,
        params: {},
        job_type: type,
        build_id: 'b1',
        protocol_version: PROTOCOL_VERSION,
        dispatch_id: `d-${jobId}`,
        book_id: 'bookA',
        chapter_id: 'ch1',
        scene_id: 'sc1',
        stage: type,
        workspace_id: workspaceId,
        policy_id: policyId,
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
        app,
        base: `http://127.0.0.1:${server.address().port}`,
        stop: () => new Promise((r) => server.close(r)),
    };
}

async function registerWorker(h, { workerId, sharePolicy = null, workspaceId = WS_A } = {}) {
    const { token, hash } = makeToken(workerId);
    h.token = token;
    await h.redis.hset(WORKER_AUTH_MIRROR_KEY, hash, JSON.stringify(mirrorIdentity(workerId, {
        workspaceId, mode: 'private', sharePolicy,
    })));
    await h.redis.hset('animastor:gpu-hub:workers', workerId, JSON.stringify({
        id: workerId, type: 'audio', protocol_version: PROTOCOL_VERSION, last_seen: Date.now(),
    }));
}

async function popNext(h) {
    const res = await fetch(`${h.base}/task/next?worker=${h.workerId}&type=audio`, {
        headers: { Authorization: `Bearer ${h.token}` },
    });
    expect(res.status).to.equal(200);
    return res.json();
}

// HTTP helpers (registered-user surface) ------------------------------------

function cookieOf(res) {
    const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const sid = set.find((c) => c.startsWith('animastor_sid='));
    return sid ? sid.split(';')[0] : null;
}

async function registerUser(base, username) {
    const res = await fetch(`${base}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'correct-horse-42', email: `${username}@test.local` }),
    });
    const body = await res.json();
    expect(res.status).to.equal(201);
    return {
        cookie: cookieOf(res),
        userId: body.user.id,
        username: body.user.username,
        workspaceId: body.workspace.id,
    };
}

// ══════════════════════════════════════════════════════════════════════════
// Schema + repo: share_policy_grants invariants (PG)
// ══════════════════════════════════════════════════════════════════════════

describe('Share grants — schema & repo invariants', () => {
    const stamp = `pwgr_repo_${Date.now()}`;
    let wsId, otherWsId, workerId, ownerId, userId;

    before(async function () {
        this.timeout(60000);
        await runMigrations();
        const ws = await query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [stamp]);
        wsId = ws.rows[0].id;
        const otherWs = await query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`${stamp}_other`]);
        otherWsId = otherWs.rows[0].id;
        const owner = await userRepo.createUser({ username: `${stamp}_owner`, passwordHash: 'x'.repeat(60), email: `${stamp}_owner@test.local`, displayName: `${stamp}_owner` });
        ownerId = owner.user_id;
        await query(`UPDATE workspaces SET owner_user_id = $1 WHERE id = $2`, [ownerId, wsId]);
        const user = await userRepo.createUser({ username: `${stamp}_user`, passwordHash: 'x'.repeat(60), email: `${stamp}_user@test.local`, displayName: `${stamp}_user` });
        userId = user.user_id;
        workerId = (await workerRepo.createWorker({ workspaceId: wsId, name: `${stamp}-w`, workerType: 'audio' })).worker.worker_id;
    });

    after(async function () {
        this.timeout(30000);
        await query(`DELETE FROM share_policy_grants WHERE policy_id IN (SELECT policy_id FROM share_policies WHERE worker_id = $1)`, [workerId]);
        await query(`DELETE FROM share_policies WHERE worker_id = $1`, [workerId]);
        await query(`DELETE FROM workers WHERE worker_id = $1`, [workerId]);
        await query(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [[otherWsId, wsId]]);
        await query(`DELETE FROM users WHERE username LIKE '${stamp}%'`);
    });

    it('share_policy_grants table exists with the unique pair index', async () => {
        const cols = await query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'share_policy_grants'
            ORDER BY column_name
        `);
        const names = cols.rows.map((r) => r.column_name).sort();
        for (const required of ['grant_id', 'policy_id', 'user_id', 'workspace_id', 'created_by', 'created_at']) {
            expect(names, `missing column ${required}`).to.include(required);
        }
        const idx = await query(`
            SELECT indexdef FROM pg_indexes
            WHERE indexname = 'idx_share_policy_grants_unique'
        `);
        expect(idx.rows[0].indexdef).to.include('UNIQUE');
        expect(idx.rows[0].indexdef).to.include('policy_id');
        expect(idx.rows[0].indexdef).to.include('user_id');
    });

    it('startSharePolicy with scope users + grant lifecycle (add / duplicate idempotent / revoke / stop deletes)', async function () {
        // Start a users policy through the repo (the route path is covered
        // separately); the grants API must be scoped to the active policy.
        const start = await workerRepo.startSharePolicy({
            workerId, workspaceId: wsId, scope: 'users', expiresAt: null, createdBy: ownerId,
        });
        expect(start.policy).to.exist;
        expect(start.policy.scope_kind).to.equal('users');

        const grant1 = await workerRepo.addShareGrants({
            workerId, workspaceId: wsId, userIds: [userId], createdBy: ownerId,
        });
        expect(grant1.addedUserIds).to.deep.equal([userId]);
        expect(grant1.grants).to.have.lengthOf(1);
        expect(grant1.grants[0].username).to.equal(`${stamp}_user`);
        expect(grant1.grants[0].policy_id).to.equal(start.policy.policy_id);

        // Duplicate grant → idempotent (no second row, nothing "added").
        const grant2 = await workerRepo.addShareGrants({
            workerId, workspaceId: wsId, userIds: [userId], createdBy: ownerId,
        });
        expect(grant2.addedUserIds).to.deep.equal([]);
        const listed = await workerRepo.listShareGrants(workerId, wsId);
        expect(listed).to.have.lengthOf(1);

        // Grant rows die with the policy: stop = hard DELETE (directory
        // semantic). Stop/restart is a FRESH audience by design.
        await workerRepo.stopSharePolicy(workerId, wsId);
        const after = await query(`SELECT count(*)::int AS n FROM share_policy_grants WHERE policy_id = $1`, [start.policy.policy_id]);
        expect(after.rows[0].n).to.equal(0);
    });

    it('grant workspace guard: a foreign workspace cannot extend a foreign policy', async () => {
        // Cross-workspace insert guard — addShareGrants with a mismatched
        // workspace returns notFound (fail closed).
        const start = await workerRepo.startSharePolicy({
            workerId, workspaceId: wsId, scope: 'users', expiresAt: null, createdBy: ownerId,
        });
        const result = await workerRepo.addShareGrants({
            workerId, workspaceId: otherWsId, userIds: [userId], createdBy: ownerId,
        });
        expect(result.notFound).to.equal(true);
        const rows = await query(`SELECT count(*)::int AS n FROM share_policy_grants WHERE policy_id = $1`, [start.policy.policy_id]);
        expect(rows.rows[0].n).to.equal(0);
        await workerRepo.stopSharePolicy(workerId, wsId);
    });

    it('hasGrantForUser + findGrantPolicyForRouting follow the active users policy only', async () => {
        const start = await workerRepo.startSharePolicy({
            workerId, workspaceId: wsId, scope: 'users', expiresAt: null, createdBy: ownerId,
        });
        await workerRepo.addShareGrants({ workerId, workspaceId: wsId, userIds: [userId], createdBy: ownerId });

        expect(await workerRepo.hasGrantForUser(workerId, userId)).to.equal(true);
        expect(await workerRepo.hasGrantForUser(workerId, ownerId)).to.equal(false);

        // Routing: a user dispatches from THEIR OWN workspace (book → ws →
        // ws owner = the dispatching user). The grantee's workspace gets the
        // policy lane; the grantor (worker owner, self-grant impossible)
        // never does.
        await query(`UPDATE workspaces SET owner_user_id = $1 WHERE id = $2`, [userId, otherWsId]);
        const lane = await workerRepo.findGrantPolicyForRouting(wsId, ownerId, 'audio');
        expect(lane).to.equal(null); // owner has no grant (self-grant impossible)
        const laneUser = await workerRepo.findGrantPolicyForRouting(otherWsId, userId, 'audio');
        expect(laneUser.policy_id).to.equal(start.policy.policy_id);

        // A workspace whose owner holds no grant → no lane (no grant leak).
        const ws3 = await query(`INSERT INTO workspaces (name, owner_user_id) VALUES ($1, $2) RETURNING id`, [`${stamp}_ws3`, ownerId]);
        expect(await workerRepo.findGrantPolicyForRouting(ws3.rows[0].id, ownerId, 'audio')).to.equal(null);

        // Wrong type → no lane.
        expect(await workerRepo.findGrantPolicyForRouting(otherWsId, userId, 'video')).to.equal(null);

        // Policy expired → no lane, no access.
        await query(`UPDATE share_policies SET expires_at = $2 WHERE policy_id = $1`, [start.policy.policy_id, Date.now() - 1000]);
        expect(await workerRepo.findGrantPolicyForRouting(otherWsId, userId, 'audio')).to.equal(null);
        expect(await workerRepo.listSharedWithMe(userId)).to.have.lengthOf(0);
        expect(await workerRepo.hasGrantForUser(workerId, userId)).to.equal(false);
        await query(`DELETE FROM workspaces WHERE id = $1`, [ws3.rows[0].id]);
        await query(`UPDATE workspaces SET owner_user_id = NULL WHERE id = $1`, [otherWsId]);
        await workerRepo.stopSharePolicy(workerId, wsId);
    });

    it('listSharedWithMe: access_reason carries the owner (Shared by …)', async function () {
        const start = await workerRepo.startSharePolicy({
            workerId, workspaceId: wsId, scope: 'users', expiresAt: null, createdBy: ownerId,
        });
        await workerRepo.addShareGrants({ workerId, workspaceId: wsId, userIds: [userId], createdBy: ownerId });
        const mine = await workerRepo.listSharedWithMe(userId);
        expect(mine).to.have.lengthOf(1);
        expect(mine[0].worker_id).to.equal(workerId);
        expect(mine[0].share_policy.scope_kind).to.equal('users');
        expect(mine[0].access_reason.kind).to.equal('shared_by_user');
        expect(mine[0].access_reason.shared_by).to.equal(`${stamp}_owner`);
        // Owner themselves sees nothing (no grant to the owning workspace).
        expect(await workerRepo.listSharedWithMe(ownerId)).to.have.lengthOf(0);
        await workerRepo.stopSharePolicy(workerId, wsId);
    });
});

// ══════════════════════════════════════════════════════════════════════════
// Routes: grants authz matrix, lookup, shared-with-me, kill-switch
// ══════════════════════════════════════════════════════════════════════════

describe('Share grants — routes authz & lifecycle', () => {
    let server, base, redis;
    let alice, bob, carol, aliceWorkerId, usersPolicyId;

    function cookieOf2(res) { return cookieOf(res); }

    async function req(method, path, { cookie, body } = {}) {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        };
        if (body !== undefined && method !== 'GET') opts.body = JSON.stringify(body);
        const res = await fetch(`${base}${path}`, opts);
        let json = null;
        try { json = await res.json(); } catch (_) { /* 204/404 html */ }
        return { status: res.status, body: json };
    }

    async function cleanup() {
        await query(`DELETE FROM share_policy_grants WHERE policy_id IN (
            SELECT policy_id FROM share_policies WHERE worker_id IN (
                SELECT worker_id FROM workers WHERE workspace_id IN (
                    SELECT id FROM workspaces WHERE owner_user_id IN (
                        SELECT user_id FROM users WHERE username LIKE 'pwgr%'))))`);
        await query(`DELETE FROM share_policies WHERE worker_id IN (
            SELECT worker_id FROM workers WHERE workspace_id IN (
                SELECT id FROM workspaces WHERE owner_user_id IN (
                    SELECT user_id FROM users WHERE username LIKE 'pwgr%')))` );
        await query(`DELETE FROM workers WHERE worker_id IN (
            SELECT worker_id FROM workers WHERE workspace_id IN (
                SELECT id FROM workspaces WHERE owner_user_id IN (
                    SELECT user_id FROM users WHERE username LIKE 'pwgr%')))` );
        await query(`DELETE FROM workspace_members WHERE workspace_id IN (
            SELECT id FROM workspaces WHERE owner_user_id IN (
                SELECT user_id FROM users WHERE username LIKE 'pwgr%'))`);
        await query(`DELETE FROM sessions WHERE user_id IN (
            SELECT user_id FROM users WHERE username LIKE 'pwgr%')`);
        await query(`DELETE FROM workspaces WHERE owner_user_id IN (
            SELECT user_id FROM users WHERE username LIKE 'pwgr%')`);
        await query(`DELETE FROM users WHERE username LIKE 'pwgr%'`);
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
        require('../src/routes/users-routes.cjs')(app);
        await new Promise((resolve) => {
            server = app.listen(0, () => {
                base = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });

        alice = await registerUser(base, `pwgr_alice_${Date.now()}`);
        bob = await registerUser(base, `pwgr_bob_${Date.now() + 1}`);
        carol = await registerUser(base, `pwgr_carol_${Date.now() + 2}`);

        const cw = await req('POST', '/api/v1/workers', { cookie: alice.cookie, body: { name: 'alice-gpu', worker_type: 'audio' } });
        expect(cw.status).to.equal(201);
        aliceWorkerId = cw.body.worker.worker_id;
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

    it('kill-switch OFF: lookup, shared-with-me and grant routes all 404 (dormant surface)', async () => {
        const lookup = await req('GET', `/api/v1/users/lookup?username=pwgr_x`, { cookie: bob.cookie });
        expect(lookup.status).to.equal(404);
        const mine = await req('GET', '/api/v1/workers/shared-with-me', { cookie: bob.cookie });
        expect(mine.status).to.equal(404);
        const grants = await req('GET', `/api/v1/workers/${aliceWorkerId}/share/users`, { cookie: alice.cookie });
        expect(grants.status).to.equal(404);
        expect(await req('POST', `/api/v1/workers/${aliceWorkerId}/share/users`, { cookie: alice.cookie, body: { users: ['x'] } })).to.have.property('status', 404);
    });

    it('user lookup: authenticated user finds an exact username — public projection only', async () => {
        process.env.SHARE_FEATURES_ENABLED = 'true';
        const hit = await req('GET', `/api/v1/users/lookup?username=${encodeURIComponent(bob.username)}`, { cookie: alice.cookie });
        expect(hit.status).to.equal(200);
        expect(hit.body.user).to.deep.equal({
            user_id: bob.userId,
            username: bob.username,
            display_name: bob.username,
        });
        // no email / password / settings leakage
        expect(JSON.stringify(hit.body)).to.not.include('@test.local');

        // prefix / fuzzy is NOT a directory: a partial name does not match
        const prefix = await req('GET', `/api/v1/users/lookup?username=pwgr_bob_`, { cookie: alice.cookie });
        expect(prefix.status).to.equal(404);

        // missing param → 400
        expect((await req('GET', `/api/v1/users/lookup`, { cookie: alice.cookie })).status).to.equal(400);
    });

    it('user lookup: unauthenticated → 401', async () => {
        process.env.SHARE_FEATURES_ENABLED = 'true';
        expect((await req('GET', `/api/v1/users/lookup?username=${encodeURIComponent(bob.username)}`, {})).status).to.equal(401);
    });

    it('share start (scope users) + grants list + shared-with-me happy path', async () => {
        process.env.SHARE_FEATURES_ENABLED = 'true';

        // start sharing with bob
        const start = await req('POST', `/api/v1/workers/${aliceWorkerId}/share`, {
            cookie: alice.cookie,
            body: { scope: 'users', users: [bob.username], expires_at: null },
        });
        expect(start.status).to.equal(201);
        expect(start.body.policy.scope_kind).to.equal('users');
        expect(start.body.grants).to.have.lengthOf(1);
        expect(start.body.grants[0].username).to.equal(bob.username);
        usersPolicyId = start.body.policy.policy_id;

        // owner sees the grant
        const list = await req('GET', `/api/v1/workers/${aliceWorkerId}/share/users`, { cookie: alice.cookie });
        expect(list.status).to.equal(200);
        expect(list.body.grants).to.have.lengthOf(1);
        expect(list.body.grants[0].user_id).to.equal(bob.userId);

        // bob sees the worker in "Shared with me"
        const mine = await req('GET', '/api/v1/workers/shared-with-me', { cookie: bob.cookie });
        expect(mine.status).to.equal(200);
        const entry = mine.body.workers.find((w) => w.worker_id === aliceWorkerId);
        expect(entry).to.exist;
        expect(entry.access_reason.shared_by).to.equal(alice.username);
        // alice (owner) does not see her own worker via grants
        const mineOwner = await req('GET', '/api/v1/workers/shared-with-me', { cookie: alice.cookie });
        expect(mineOwner.body.workers.find((w) => w.worker_id === aliceWorkerId)).to.not.exist;
    });

    it('grant authz: foreign worker → indistinct 404 on all grant routes', async () => {
        process.env.SHARE_FEATURES_ENABLED = 'true';
        const foreign = crypto.randomUUID();
        expect((await req('GET', `/api/v1/workers/${foreign}/share/users`, { cookie: bob.cookie })).status).to.equal(404);
        expect((await req('POST', `/api/v1/workers/${foreign}/share/users`, { cookie: bob.cookie, body: { users: [carol.username] } })).status).to.equal(404);
        expect((await req('DELETE', `/api/v1/workers/${foreign}/share/users`, { cookie: bob.cookie, body: { username: carol.username } })).status).to.equal(404);
        // Not a UUID → 404 too.
        expect((await req('GET', `/api/v1/workers/not-a-uuid/share/users`, { cookie: bob.cookie })).status).to.equal(404);
    });

    it('POST /share/users requires an ACTIVE users policy (409 otherwise)', async () => {
        process.env.SHARE_FEATURES_ENABLED = 'true';
        // A worker without sharing at all.
        const cw = await req('POST', '/api/v1/workers', { cookie: carol.cookie, body: { name: 'carol-gpu', worker_type: 'audio' } });
        expect(cw.status).to.equal(201);
        const carolWorkerId = cw.body.worker.worker_id;

        const res = await req('POST', `/api/v1/workers/${carolWorkerId}/share/users`, {
            cookie: carol.cookie, body: { users: [bob.username] },
        });
        expect(res.status).to.equal(409);
        expect(res.body.code).to.equal('no_active_users_policy');
    });

    it('unknown username → 400 unknown_user; self-grant → 400; duplicate grant → 201 idempotent, one event', async () => {
        process.env.SHARE_FEATURES_ENABLED = 'true';
        const events = [];
        const detach = shareEvents.setSink((e) => events.push(e));

        // unknown recipient — no grant, no event
        const unknown = await req('POST', `/api/v1/workers/${aliceWorkerId}/share/users`, {
            cookie: alice.cookie, body: { users: ['pwgr_nosuchuser_zz'] },
        });
        expect(unknown.status).to.equal(400);
        expect(unknown.body.code).to.equal('unknown_user');
        expect(unknown.body.unknown_users).to.deep.equal(['pwgr_nosuchuser_zz']);

        // self-grant
        const self = await req('POST', `/api/v1/workers/${aliceWorkerId}/share/users`, {
            cookie: alice.cookie, body: { users: [alice.username] },
        });
        expect(self.status).to.equal(400);
        expect(self.body.code).to.equal('self_grant_forbidden');

        // duplicate grant for bob — still 201, but NO new event
        const before = events.length;
        const dup = await req('POST', `/api/v1/workers/${aliceWorkerId}/share/users`, {
            cookie: alice.cookie, body: { users: [bob.username, bob.username] },
        });
        expect(dup.status).to.equal(201);
        expect(events.slice(before)).to.have.lengthOf(0); // already granted — no new access

        // add carol — exactly ONE new event with the full contract
        const addCarol = await req('POST', `/api/v1/workers/${aliceWorkerId}/share/users`, {
            cookie: alice.cookie, body: { users: [carol.username] },
        });
        expect(addCarol.status).to.equal(201);
        expect(events.slice(before)).to.have.lengthOf(1);
        const ev = events[events.length - 1];
        expect(ev.event).to.equal('worker.shared_with_user');
        expect(ev.resource).to.deep.equal({ kind: 'worker', id: aliceWorkerId, name: 'alice-gpu' });
        expect(ev.recipient.username).to.equal(carol.username);
        expect(ev.actor.username).to.equal(alice.username);
        expect(ev.reason).to.equal('shared_by_user');
        expect(ev.ts).to.be.a('number');

        detach();
    });

    it('revoke one recipient (DELETE /share/users) removes access; expiry kills shared-with-me', async function () {
        process.env.SHARE_FEATURES_ENABLED = 'true';
        this.timeout(10000);

        // revoke carol
        const rev = await req('DELETE', `/api/v1/workers/${aliceWorkerId}/share/users`, {
            cookie: alice.cookie, body: { username: carol.username },
        });
        expect(rev.status).to.equal(200);
        expect(rev.body.revoked).to.equal(true);
        const mineCarol = await req('GET', '/api/v1/workers/shared-with-me', { cookie: carol.cookie });
        expect(mineCarol.body.workers.find((w) => w.worker_id === aliceWorkerId)).to.not.exist;

        // unknown target → 404
        expect((await req('DELETE', `/api/v1/workers/${aliceWorkerId}/share/users`, { cookie: alice.cookie, body: { username: 'pwgr_nosuchuser_zz' } })).status).to.equal(404);

        // expiry of the policy → bob loses access (PG re-check on read)
        const list = await req('GET', `/api/v1/workers/${aliceWorkerId}/share/users`, { cookie: alice.cookie });
        expect(list.body.grants).to.have.lengthOf(1); // bob remains
        await query(`UPDATE share_policies SET expires_at = $2 WHERE policy_id = $1`, [usersPolicyId, Date.now() - 1000]);
        const mineBob = await req('GET', '/api/v1/workers/shared-with-me', { cookie: bob.cookie });
        expect(mineBob.body.workers.find((w) => w.worker_id === aliceWorkerId)).to.not.exist;

        // stop sharing — grants hard-deleted, restart starts a FRESH audience
        const stop = await req('DELETE', `/api/v1/workers/${aliceWorkerId}/share`, { cookie: alice.cookie });
        expect(stop.status).to.equal(200);
        expect(stop.body.stopped).to.equal(true);
        const grantsAfter = await query(`SELECT count(*)::int AS n FROM share_policy_grants WHERE policy_id = $1`, [usersPolicyId]);
        expect(grantsAfter.rows[0].n).to.equal(0);
    });

    it('GET /workers/shared-with-me precedes /:workerId — no param capture', async () => {
        process.env.SHARE_FEATURES_ENABLED = 'false';
        const res = await req('GET', '/api/v1/workers/shared-with-me', { cookie: bob.cookie });
        // If the parametrized route captured this, the answer would be a
        // worker-shaped 404 from the detail route — the dedicated route
        // answers (kill-switch 404) instead.
        expect(res.status).to.equal(404);
        expect(res.body.error).to.equal('Not found');
    });
});

// ══════════════════════════════════════════════════════════════════════════
// GPU hub: policy lane pop, poison guards, claims, orphan requeue
// ══════════════════════════════════════════════════════════════════════════

describe('Share grants — gpu-hub policy lane routing', () => {
    const WORKER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const WS_QUEUE = `animastor:queue:audio:ws:${WS_A}`;
    const SYSTEM_QUEUE = 'animastor:queue:audio';
    const POLICY_QUEUE = `animastor:queue:audio:policy:${POLICY_A}`;

    afterEach(async function () {
        if (this.currentTest && this.currentTest.h) await this.currentTest.h.stop();
    });

    it('users-policy worker pops ONLY its own policy lane as spare capacity — never the system pool', async function () {
        const h = this.h = await startHub();
        h.workerId = WORKER_A;
        await registerWorker(h, { workerId: WORKER_A, sharePolicy: { policy_id: POLICY_A, scope_kind: 'users', expires_at: null } });

        await h.redis.lpush(SYSTEM_QUEUE, JSON.stringify(hubTask('sys-job-1')));
        await h.redis.lpush(POLICY_QUEUE, JSON.stringify(hubTask('grant-job-1', { policyId: POLICY_A })));

        // Owner ws lane is empty → spare capacity → policy lane (granted audience).
        const popped = await popNext(h);
        expect(popped.task.job_id).to.equal('grant-job-1');
        expect(popped.task.policy_id).to.equal(POLICY_A);
        expect(popped.task.workspace_id).to.equal(null);

        // Policy lane drained → the next pop must NOT fall through to the
        // system pool (a users worker never serves the public pool).
        expect(await popNext(h)).to.deep.equal({ task: null });
        expect(await h.redis.llen(SYSTEM_QUEUE)).to.equal(1);

        // The running claim carries the snapshot + the WORKER's workspace.
        const running = JSON.parse(await h.redis.hget('animastor:running', 'grant-job-1'));
        expect(running.worker_share_policy).to.deep.equal({ policy_id: POLICY_A, scope_kind: 'users', expires_at: null });
        expect(running.worker_workspace_id).to.equal(WS_A);
        expect(running.workspace_id).to.equal(null);
    });

    it('owner lane STRICT priority over the policy lane', async function () {
        const h = this.h = await startHub();
        h.workerId = WORKER_A;
        await registerWorker(h, { workerId: WORKER_A, sharePolicy: { policy_id: POLICY_A, scope_kind: 'users', expires_at: null } });

        await h.redis.lpush(WS_QUEUE, JSON.stringify(hubTask('owner-job-1', { workspaceId: WS_A })));
        await h.redis.lpush(POLICY_QUEUE, JSON.stringify(hubTask('grant-job-1', { policyId: POLICY_A })));

        expect((await popNext(h)).task.job_id).to.equal('owner-job-1');
        expect((await popNext(h)).task.job_id).to.equal('grant-job-1');
    });

    it('kill-switch OFF: the policy in the mirror is ignored — no policy-lane pop, system pool untouched', async function () {
        const h = this.h = await startHub({ shareEnabled: false });
        h.workerId = WORKER_A;
        await registerWorker(h, { workerId: WORKER_A, sharePolicy: { policy_id: POLICY_A, scope_kind: 'users', expires_at: null } });

        await h.redis.lpush(SYSTEM_QUEUE, JSON.stringify(hubTask('sys-job-1')));
        await h.redis.lpush(POLICY_QUEUE, JSON.stringify(hubTask('grant-job-1', { policyId: POLICY_A })));

        expect(await popNext(h)).to.deep.equal({ task: null });
        expect(await h.redis.llen(SYSTEM_QUEUE)).to.equal(1);
        expect(await h.redis.llen(POLICY_QUEUE)).to.equal(1);
    });

    it('poison guard: a foreign policy task in the policy lane is dead-lettered, never handed out', async function () {
        const h = this.h = await startHub();
        h.workerId = WORKER_A;
        await registerWorker(h, { workerId: WORKER_A, sharePolicy: { policy_id: POLICY_A, scope_kind: 'users', expires_at: null } });

        await h.redis.lpush(POLICY_QUEUE, JSON.stringify(hubTask('poison-job', { policyId: POLICY_B })));
        expect(await popNext(h)).to.deep.equal({ task: null });
        // Dead-lettered, not left in the processing list.
        expect(await h.redis.llen('animastor:processing')).to.equal(0);
        const dl = await h.redis.lrange('animastor:dead-letter', 0, -1);
        expect(dl).to.have.lengthOf(1);
        const entry = JSON.parse(dl[0]);
        expect(entry.reason).to.equal('poison_policy_mismatch');
        expect(JSON.parse(entry.entry).job_id).to.equal('poison-job');
    });

    it('poison guard: a workspace-stamped task in the policy lane is dead-lettered', async function () {
        const h = this.h = await startHub();
        h.workerId = WORKER_A;
        await registerWorker(h, { workerId: WORKER_A, sharePolicy: { policy_id: POLICY_A, scope_kind: 'users', expires_at: null } });

        await h.redis.lpush(POLICY_QUEUE, JSON.stringify(hubTask('poison-job', { workspaceId: WS_A })));
        expect(await popNext(h)).to.deep.equal({ task: null });
        const dl = await h.redis.lrange('animastor:dead-letter', 0, -1);
        expect(dl).to.have.lengthOf(1);
    });

    it('POST /task accepts a policy_id stamp and enqueues into the policy lane; ws+policy together → 400', async function () {
        const h = this.h = await startHub();
        const post = async (body) => {
            const res = await fetch(`${h.base}/task`, {
                method: 'POST',
                headers: { 'x-api-key': 'hub-key', 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            return { status: res.status, body: await res.json() };
        };

        // policy-lane dispatch → its own queue
        const ok = await post(hubTask('policy-job-1', { policyId: POLICY_A }));
        expect(ok.status).to.equal(200);
        expect(await h.redis.llen(POLICY_QUEUE)).to.equal(1);
        expect(await h.redis.llen(SYSTEM_QUEUE)).to.equal(0);

        // system-pool dispatch unchanged
        const sys = await post(hubTask('sys-job-1', {}));
        expect(sys.status).to.equal(200);
        expect(await h.redis.llen(SYSTEM_QUEUE)).to.equal(1);

        // malformed policy id → 400
        expect((await post({ ...hubTask('x', { policyId: 'not-a-uuid' }) })).status).to.equal(400);

        // workspace_id + policy_id together → 400
        expect((await post(hubTask('x', { workspaceId: WS_A, policyId: POLICY_A }))).status).to.equal(400);

        // the persisted task carries the marker
        const stored = JSON.parse((await h.redis.lrange(POLICY_QUEUE, 0, -1))[0]);
        expect(stored.policy_id).to.equal(POLICY_A);
        expect(stored.workspace_id).to.equal(null);
    });

    it('users-scope borrowed claim finishes normally (taskLaneMatch V2) and re-stamps the users heartbeat marker', async function () {
        const h = this.h = await startHub();
        h.workerId = WORKER_A;
        await registerWorker(h, { workerId: WORKER_A, sharePolicy: { policy_id: POLICY_A, scope_kind: 'users', expires_at: null } });

        await h.redis.lpush(POLICY_QUEUE, JSON.stringify(hubTask('grant-job-1', { policyId: POLICY_A })));
        expect((await popNext(h)).task.job_id).to.equal('grant-job-1');

        const done = await fetch(`${h.base}/task/result`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${h.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                job_id: 'grant-job-1',
                build_id: 'b1',
                result_base64: 'aGk=',
                dispatch_id: 'd-grant-job-1',
                protocol_version: PROTOCOL_VERSION,
            }),
        });
        expect(done.status).to.equal(200);
        // The running claim is consumed and NOT re-queued anywhere.
        expect(await h.redis.hget('animastor:running', 'grant-job-1')).to.equal(null);
        expect(await h.redis.llen(SYSTEM_QUEUE)).to.equal(0);
    });

    it('orphan policy-lane task requeues into ITS OWN policy lane (not the system pool)', async function () {
        const h = this.h = await startHub();
        h.workerId = WORKER_A;
        await registerWorker(h, { workerId: WORKER_A, sharePolicy: { policy_id: POLICY_A, scope_kind: 'users', expires_at: null } });

        // Simulate a crashed claim: the entry sits in animastor:processing
        // with NO running claim. First sighting starts the grace window;
        // a sweep past ORPHAN_GRACE_MS requeues it into its own lane.
        const orphan = hubTask('orphan-job', { policyId: POLICY_A });
        await h.redis.lpush('animastor:processing', JSON.stringify(orphan));

        await h.app.__hub.sweepProcessingOrphans(Date.now());          // sighting — grace window starts
        await h.app.__hub.sweepProcessingOrphans(Date.now() + 10 * 60 * 1000); // grace elapsed

        expect(await h.redis.llen(POLICY_QUEUE)).to.equal(1);
        expect(await h.redis.llen(SYSTEM_QUEUE)).to.equal(0);
        const requeued = JSON.parse((await h.redis.lrange(POLICY_QUEUE, 0, -1))[0]);
        expect(requeued.policy_id).to.equal(POLICY_A);
    });
});

// ══════════════════════════════════════════════════════════════════════════
// Backend dispatcher: grant routing → policy lane + payload stamping
// ══════════════════════════════════════════════════════════════════════════

describe('Share grants — backend dispatch routing (sendUnified)', () => {
    const repoPaths = [
        '../src/storage/postgres/repositories/book-repo',
        '../src/storage/postgres/repositories/worker-repo',
        '../src/storage/postgres/repositories/workspace-repo',
    ];
    const savedCache = new Map();
    let gpuDispatcher;
    let sentBodies;
    let originalFetch;
    let originalShareFeatures;

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
        // Drop the config singleton too: other suites in this repo swap the
        // runtime-config require.cache entry; a fresh gpu-dispatcher must
        // capture the SAME instance this suite overrides, otherwise the
        // kill-switch override below silently misses (order-dependent flake).
        const configPath = require.resolve('../src/config/runtime-config');
        savedCache.set(configPath, require.cache[configPath]);
        delete require.cache[configPath];
        gpuDispatcher = require('../src/runtime/gpu-dispatcher');
        gpuDispatcher.clearRoutingCaches();
        const activeConfig = require('../src/config/runtime-config');
        originalShareFeatures = activeConfig.shareFeaturesEnabled;
        activeConfig.shareFeaturesEnabled = () => true;

        sentBodies = [];
        originalFetch = global.fetch;
        global.fetch = async (url, options) => {
            sentBodies.push({ url, body: JSON.parse(options.body) });
            return { ok: true, status: 200 };
        };
    });

    afterEach(() => {
        global.fetch = originalFetch;
        require('../src/config/runtime-config').shareFeaturesEnabled = originalShareFeatures;
        for (const [resolved, saved] of savedCache) {
            if (saved) require.cache[resolved] = saved;
            else delete require.cache[resolved];
        }
    });

    const BOOK_WS = '55555555-5555-4555-8555-555555555555';
    const OWNER_ID = '66666666-6666-4666-8666-666666666666';
    const POLICY_LANE = '77777777-7777-4777-8777-777777777777';

    function stubRepos({ bookWorkspace, hasPrivateWorker, lane }) {
        stub('../src/storage/postgres/repositories/book-repo', {
            getWorkspaceId: async () => bookWorkspace,
        });
        stub('../src/storage/postgres/repositories/worker-repo', {
            hasActivePrivateWorkerOfType: async () => hasPrivateWorker,
            findGrantPolicyForRouting: async (wsId, userId, type) => lane || null,
        });
        stub('../src/storage/postgres/repositories/workspace-repo', {
            findById: async () => ({ id: BOOK_WS, owner_user_id: OWNER_ID }),
        });
    }


    // The dispatch mock is GLOBAL fetch for the whole process; a leaked async
    // from a prior hub-suite (same file, parallel-ish awaits) can push an
    // extra body into sentBodies. Assert on OUR dispatch (dispatch-x) —
    // the last one recorded — instead of index [0] (order-dependent flake).
    function lastBody() {
        const ours = sentBodies.filter((b) => b.body && b.body.dispatch_id === 'dispatch-x');
        const last = (ours.length ? ours : sentBodies)[sentBodies.length - 1];
        return last ? last.body : {};
    }

    function dispatcherTask() {
        return {
            job_id: `bookA_ch1_sc1_0001:audio`,
            params: {},
            job_type: 'audio',
            build_id: 'b1',
            dispatch_id: 'dispatch-x',
        };
    }

    it('no grant → system pool (workspace_id null, no policy stamp)', async () => {
        stubRepos({ bookWorkspace: BOOK_WS, hasPrivateWorker: false, lane: null });
        await gpuDispatcher.sendUnified(dispatcherTask());
        expect(lastBody().workspace_id).to.equal(null);
        expect(lastBody().policy_id).to.equal(undefined);
    });

    it('grant → policy lane: workspace_id null, policy_id stamped from server-side routing', async () => {
        stubRepos({ bookWorkspace: BOOK_WS, hasPrivateWorker: false, lane: { policy_id: POLICY_LANE, scope_kind: 'users', expires_at: null } });
        await gpuDispatcher.sendUnified(dispatcherTask());
        expect(lastBody().workspace_id).to.equal(null);
        expect(lastBody().policy_id).to.equal(POLICY_LANE);
    });

    it('kill-switch OFF → grant routing dormant: system pool, no stamp (bit-for-bit V1-off)', async () => {
        const activeConfig = require('../src/config/runtime-config');
        activeConfig.shareFeaturesEnabled = () => false;
        stubRepos({ bookWorkspace: BOOK_WS, hasPrivateWorker: false, lane: { policy_id: POLICY_LANE, scope_kind: 'users', expires_at: null } });
        await gpuDispatcher.sendUnified(dispatcherTask());
        expect(lastBody().workspace_id).to.equal(null);
        expect(lastBody().policy_id).to.equal(undefined);
    });

    it('private-worker routing WINS over grant routing (owner lane precedence)', async () => {
        stubRepos({ bookWorkspace: BOOK_WS, hasPrivateWorker: true, lane: { policy_id: POLICY_LANE, scope_kind: 'users', expires_at: null } });
        await gpuDispatcher.sendUnified(dispatcherTask());
        expect(lastBody().workspace_id).to.equal(BOOK_WS);
        expect(lastBody().policy_id).to.equal(undefined);
    });

    it('overwrites any client-supplied policy_id — the stamp is backend-authored only', async () => {
        stubRepos({ bookWorkspace: BOOK_WS, hasPrivateWorker: false, lane: null });
        await gpuDispatcher.sendUnified({ ...dispatcherTask(), policy_id: 'forged-policy' });
        expect(lastBody().policy_id).to.equal(undefined);
    });
});
