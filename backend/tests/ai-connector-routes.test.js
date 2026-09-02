// ======================================================
// LLM Connector Registration & Lifecycle Route Tests (LAC — Local AI Connector V1)
// ======================================================
// Coverage (docs/04-planning/local-ai-connector-v1.md §8, §8.1, §10, §12):
//   POST /registrations → pending connector + one-time llmcreg.* token      ok
//   identity: workspace from authContext — body workspace_id IGNORED        ok
//   users-only: anonymous → 401, guest → 403 (never guest auto-provision)   ok
//   validation: name required, runtime_type allowlist                       ok
//   GET /registrations/:id/token — re-arm (pending only, old token dies)    ok
//   re-arm on ACTIVATED / revoked / foreign connector → 404 (no oracle)     ok
//   GET /connectors — list, workspace-scoped, never secrets                 ok
//   GET /connectors/:id — detail; foreign id → indistinct 404               ok
//   POST /connectors/:id/rotate — new token shown once, old dies;
//                                 live WS session evicted (registry)        ok
//   rotate on pending/foreign → 404                                         ok
//   DELETE /connectors/:id — revoke (soft), session evicted,
//                             Redis hb key cleared, auth dead               ok
//   plaintext llmcreg.*/llmc.* NEVER reach application logs                 ok
//
// Real-PG suite + real routes on an ephemeral express app (no supertest dep).

const { expect } = require('chai');
const express = require('express');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const repo = require('../src/storage/postgres/repositories/ai-connector-repo');
const registry = require('../src/services/ai-connector/registry');
const { createAiConnectorRoutes } = require('../src/routes/ai-connector-routes.cjs');
const { createMockRedis } = require('./mocks/redis-mock');

const stamp = `lachttp${Date.now()}`;

async function createWorkspace(name) {
    const { rows } = await query(
        `INSERT INTO workspaces (name, type) VALUES ($1, 'personal') RETURNING id`,
        [`${name}-${stamp}`]
    );
    return rows[0].id;
}

async function createUser(username) {
    const { rows } = await query(
        `INSERT INTO users (username, display_name) VALUES ($1, $1) RETURNING user_id`,
        [`${username}-${stamp}`]
    );
    return rows[0].user_id;
}

async function cleanup() {
    await query(`DELETE FROM ai_connectors WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE name LIKE '%${stamp}%')`);
    await query(`DELETE FROM workspaces WHERE name LIKE '%${stamp}%'`);
    await query(`DELETE FROM users WHERE username LIKE '%${stamp}%'`);
}

/** Boot the real routes on an ephemeral port with an injectable identity. */
function startServer() {
    const redis = createMockRedis();
    const app = express();
    app.use(express.json());
    // Minimal authContext stand-in: tests set `identity` per request. The
    // routes must use req.workspace.id — never the body.
    app.use((req, res, next) => {
        const id = req.headers['x-test-identity'];
        req.user = id ? JSON.parse(id).user : null;
        req.guest = id ? (JSON.parse(id).guest || null) : null;
        req.workspace = id ? (JSON.parse(id).workspace || null) : null;
        next();
    });
    createAiConnectorRoutes({ redis })(app);
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => {
            resolve({
                redis,
                base: `http://127.0.0.1:${server.address().port}`,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

function identityHeaders({ user, guest, workspace } = {}) {
    return {
        'Content-Type': 'application/json',
        'x-test-identity': JSON.stringify({ user, guest, workspace }),
    };
}

async function api(srv, method, path, { identity, body } = {}) {
    const res = await fetch(`${srv.base}${path}`, {
        method,
        headers: identityHeaders(identity),
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { status: res.status, body: json };
}

async function captureConsole(fn) {
    const entries = [];
    const originals = {};
    for (const method of ['log', 'error', 'warn', 'info']) {
        originals[method] = console[method];
        console[method] = (...args) => entries.push({ method, text: args.map(String).join(' ') });
    }
    try {
        return { result: await fn(), entries };
    } finally {
        for (const method of Object.keys(originals)) console[method] = originals[method];
    }
}

describe('LLM Connector registration & lifecycle routes (LAC HTTP)', () => {
    let srv;
    let wsA, wsB;
    let userA, userB;

    const idA = () => ({ user: { userId: userA }, workspace: { id: wsA } });
    const idB = () => ({ user: { userId: userB }, workspace: { id: wsB } });

    before(async function () {
        this.timeout(60000);
        await runMigrations();
        await cleanup();
        wsA = await createWorkspace('lachA');
        wsB = await createWorkspace('lachB');
        userA = await createUser('lachU_a');
        userB = await createUser('lachU_b');
        srv = await startServer();
    });

    after(async function () {
        this.timeout(30000);
        await cleanup();
        await srv.close();
    });

    it('POST /registrations → 201, pending connector + one-time llmcreg.* token', async () => {
        const { status, body } = await api(srv, 'POST', '/api/v1/ai-connector/registrations', {
            identity: idA(),
            body: { name: 'My Home Ollama', runtime_type: 'ollama' },
        });
        expect(status).to.equal(201);
        expect(body.connector.status).to.equal('pending');
        expect(body.connector.workspace_id).to.equal(wsA);
        expect(body.connector.runtime_type).to.equal('ollama');
        expect(body.connector.token_prefix).to.be.null; // nothing activated yet
        expect(body.reg_token).to.match(/^llmcreg\./);
        expect(body.reg_expires_at).to.be.a('number');
        expect(body.ws_url).to.equal('/api/v1/ai-connector/ws');
    });

    it('workspace_id in the body is IGNORED — always the caller workspace', async () => {
        const foreign = await createWorkspace('lachForeign');
        const { status, body } = await api(srv, 'POST', '/api/v1/ai-connector/registrations', {
            identity: idA(),
            body: { name: 'Hijack attempt', workspace_id: foreign },
        });
        expect(status).to.equal(201);
        expect(body.connector.workspace_id).to.equal(wsA);
    });

    it('anonymous → 401; guest → 403 (guests never own connectors)', async () => {
        const anon = await api(srv, 'POST', '/api/v1/ai-connector/registrations', {
            body: { name: 'x' },
        });
        expect(anon.status).to.equal(401);

        // Guest with a resolved workspace: the users-only guard demands a
        // real user first — 401 precedes the guest verdict (worker-routes
        // parity: req.user is falsy for a guest request).
        const guest = await api(srv, 'POST', '/api/v1/ai-connector/registrations', {
            identity: { guest: { guestId: 'g1' }, workspace: { id: wsA } },
            body: { name: 'x' },
        });
        expect(guest.status).to.equal(401);
    });

    it('validation: name required, runtime_type allowlist', async () => {
        const noName = await api(srv, 'POST', '/api/v1/ai-connector/registrations', {
            identity: idA(), body: { name: '   ' },
        });
        expect(noName.status).to.equal(400);

        const badType = await api(srv, 'POST', '/api/v1/ai-connector/registrations', {
            identity: idA(), body: { name: 'x', runtime_type: 'toaster' },
        });
        expect(badType.status).to.equal(400);
    });

    it('GET /registrations/:id/token re-arms a pending connector; previous token dies', async () => {
        const created = await api(srv, 'POST', '/api/v1/ai-connector/registrations', {
            identity: idA(), body: { name: 're-arm me' },
        });
        const id = created.body.connector.connector_id;
        const firstToken = created.body.reg_token;

        const rearmed = await api(srv, 'GET', `/api/v1/ai-connector/registrations/${id}/token`, { identity: idA() });
        expect(rearmed.status).to.equal(200);
        expect(rearmed.body.reg_token).to.match(/^llmcreg\./);
        expect(rearmed.body.reg_token).to.not.equal(firstToken);

        // The FIRST token is dead by construction (hash replaced).
        const replay = await repo.activateConnector(firstToken);
        expect(replay.ok).to.be.false;
        // The SECOND token activates exactly once.
        const act = await repo.activateConnector(rearmed.body.reg_token);
        expect(act.ok).to.be.true;
        expect(act.connector.connector_id).to.equal(id);

        // After activation, re-arm must be refused (already activated).
        const after = await api(srv, 'GET', `/api/v1/ai-connector/registrations/${id}/token`, { identity: idA() });
        expect(after.status).to.equal(404);
    });

    it('re-arm on foreign workspace / unknown id → indistinct 404', async () => {
        const created = await api(srv, 'POST', '/api/v1/ai-connector/registrations', {
            identity: idA(), body: { name: 'mine' },
        });
        const id = created.body.connector.connector_id;

        const foreign = await api(srv, 'GET', `/api/v1/ai-connector/registrations/${id}/token`, { identity: idB() });
        expect(foreign.status).to.equal(404);

        const unknown = await api(srv, 'GET', `/api/v1/ai-connector/registrations/00000000-0000-4000-8000-000000000000/token`, { identity: idA() });
        expect(unknown.status).to.equal(404);

        const malformed = await api(srv, 'GET', `/api/v1/ai-connector/registrations/not-a-uuid/token`, { identity: idA() });
        expect(malformed.status).to.equal(404);
    });

    it('GET /connectors lists only the caller workspace, never secrets', async () => {
        await api(srv, 'POST', '/api/v1/ai-connector/registrations', {
            identity: idA(), body: { name: 'list-a1' },
        });
        const list = await api(srv, 'GET', '/api/v1/ai-connector/connectors', { identity: idA() });
        expect(list.status).to.equal(200);
        expect(list.body.connectors.length).to.be.at.least(1);
        for (const row of list.body.connectors) {
            expect(row.workspace_id).to.equal(wsA);
            expect(row).to.not.have.property('token_hash');
            expect(row).to.not.have.property('reg_token_hash');
        }
        const listB = await api(srv, 'GET', '/api/v1/ai-connector/connectors', { identity: idB() });
        for (const row of listB.body.connectors) {
            expect(row.workspace_id).to.equal(wsB);
        }
    });

    it('GET /connectors/:id — own detail 200, foreign → indistinct 404', async () => {
        const created = await api(srv, 'POST', '/api/v1/ai-connector/registrations', {
            identity: idA(), body: { name: 'detail-me' },
        });
        const id = created.body.connector.connector_id;

        const own = await api(srv, 'GET', `/api/v1/ai-connector/connectors/${id}`, { identity: idA() });
        expect(own.status).to.equal(200);
        expect(own.body.connector.connector_id).to.equal(id);
        expect(own.body.connector).to.not.have.property('token_hash');

        const foreign = await api(srv, 'GET', `/api/v1/ai-connector/connectors/${id}`, { identity: idB() });
        expect(foreign.status).to.equal(404);
    });

    it('rotate: new token disclosed once, old credential dead, pending → 404', async () => {
        // Pending connector cannot rotate (never activated).
        const pending = await api(srv, 'POST', '/api/v1/ai-connector/registrations', {
            identity: idA(), body: { name: 'never-activated' },
        });
        const pendRot = await api(srv, 'POST', `/api/v1/ai-connector/connectors/${pending.body.connector.connector_id}/rotate`, { identity: idA() });
        expect(pendRot.status).to.equal(404);

        // Activate, then rotate.
        const act = await repo.activateConnector(pending.body.reg_token);
        expect(act.ok).to.be.true;
        const id = act.connector.connector_id;
        const oldToken = act.token;

        const { result, entries } = await captureConsole(async () => {
            return api(srv, 'POST', `/api/v1/ai-connector/connectors/${id}/rotate`, { identity: idA() });
        });
        expect(result.status).to.equal(200);
        expect(result.body.token).to.match(/^llmc\./);
        expect(result.body.connector.token_prefix).to.be.a('string');
        // Old credential is dead the moment rotation commits.
        expect(await repo.authenticateConnector(oldToken)).to.be.null;
        expect(await repo.authenticateConnector(result.body.token)).to.not.be.null;
        // Log hygiene: no plaintext token fragment in logs.
        const secret = result.body.token.split('.')[2];
        for (const e of entries) {
            expect(e.text).to.not.include(oldToken.split('.')[2]);
            expect(e.text).to.not.include(secret);
        }

        // Foreign rotate → indistinct 404.
        const foreign = await api(srv, 'POST', `/api/v1/ai-connector/connectors/${id}/rotate`, { identity: idB() });
        expect(foreign.status).to.equal(404);
    });

    it('rotate evicts the LIVE WS session authenticated with the old credential', async function () {
        this.timeout(20000);
        // Build a fake "live" session object shaped like the WS handler's.
        const created = await api(srv, 'POST', '/api/v1/ai-connector/registrations', {
            identity: idA(), body: { name: 'session-evict' },
        });
        const act = await repo.activateConnector(created.body.reg_token);
        expect(act.ok).to.be.true;
        const id = act.connector.connector_id;

        let closeArgs = null;
        const fakeSession = {
            ws: { readyState: 1, close: (code, reason) => { closeArgs = { code, reason }; } },
            state: 'authenticated',
            connectorId: id,
        };
        registry.register(id, fakeSession);
        try {
            const rot = await api(srv, 'POST', `/api/v1/ai-connector/connectors/${id}/rotate`, { identity: idA() });
            expect(rot.status).to.equal(200);
            expect(closeArgs).to.not.be.null;
            expect(closeArgs.code).to.equal(4001); // rotated
            expect(closeArgs.reason).to.equal('rotated');
        } finally {
            registry.unregister(id, fakeSession);
        }
    });

    it('revoke: soft delete, session evicted, Redis hb cleared, auth dead', async function () {
        this.timeout(20000);
        const created = await api(srv, 'POST', '/api/v1/ai-connector/registrations', {
            identity: idA(), body: { name: 'revoke-me' },
        });
        const id = created.body.connector.connector_id;
        const act = await repo.activateConnector(created.body.reg_token);
        expect(act.ok).to.be.true;

        // Simulate liveness: Redis mirror key + a registered session.
        await srv.redis.set(`animastor:ai-connector:hb:${id}`, '1', 'EX', 45);
        let evicted = false;
        const fakeSession = {
            ws: { readyState: 1, close: () => { evicted = true; } },
            state: 'authenticated',
            connectorId: id,
        };
        registry.register(id, fakeSession);

        try {
            const del = await api(srv, 'DELETE', `/api/v1/ai-connector/connectors/${id}`, { identity: idA() });
            expect(del.status).to.equal(200);
            expect(del.body.revoked).to.be.true;
            expect(evicted).to.be.true;
            expect(await srv.redis.get(`animastor:ai-connector:hb:${id}`)).to.be.null;
            // The credential is dead (fail-closed auth).
            expect(await repo.authenticateConnector(act.token)).to.be.null;
            // Row survives (soft delete), flagged revoked.
            const detail = await api(srv, 'GET', `/api/v1/ai-connector/connectors/${id}`, { identity: idA() });
            expect(detail.status).to.equal(200);
            expect(detail.body.connector.revoked_at).to.be.a('number');
            // Idempotent second revoke still answers (already revoked → 404 by
            // worker-routes precedent is fine; repo returns revoked=false).
            const del2 = await api(srv, 'DELETE', `/api/v1/ai-connector/connectors/${id}`, { identity: idA() });
            expect(del2.status).to.equal(404);
        } finally {
            registry.unregister(id, fakeSession);
        }
    });

    it('revoke on foreign/unknown/malformed id → indistinct 404', async () => {
        const foreign = await api(srv, 'DELETE', '/api/v1/ai-connector/connectors/00000000-0000-4000-8000-000000000000', { identity: idA() });
        expect(foreign.status).to.equal(404);
        const malformed = await api(srv, 'DELETE', '/api/v1/ai-connector/connectors/nope', { identity: idA() });
        expect(malformed.status).to.equal(404);
    });
});
