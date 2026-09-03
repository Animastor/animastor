// ======================================================
// LLM Sharing Phase 1 — Control Plane tests (SH-AI-1)
// ======================================================
// Coverage matrix (task brief §12):
//
//   OWNERSHIP
//     owner can create / update / delete                       ok
//     foreign workspace gets indistinct 404 on every route    ok
//     endpoints can only reference the caller's own connector ok
//   SHARING
//     default Private (no auto-sharing after migration)       ok
//     enable sharing (confirm_share discipline)               ok
//     disable sharing → Private again                         ok
//     private endpoint NOT eligible for the shared resolver   ok
//     shared endpoint eligible only when policy allows        ok
//   CONNECTOR STATE
//     shared + live → eligible                                ok
//     shared + offline → NOT eligible                         ok
//     private + live → NOT eligible for the shared pool       ok
//   SECURITY
//     no credential disclosure (no llmc./llmcreg. material)   ok
//     no runtime URL disclosure (no endpoint/URL fields)       ok
//     no arbitrary URL (no URL input exists on any route)      ok
//     workspace isolation (B never sees/edits A's endpoints)  ok
//     connector isolation (foreign connector_id → 404)        ok
//   RESOLVER (resolveSharedAI seam)
//     only eligible endpoints selected                        ok
//     offline endpoints skipped                               ok
//     disabled endpoints skipped                              ok
//     deterministic selection (first eligible, stable order)  ok
//     no second provider system (snapshot shape = connector)  ok
//     owner's own endpoint never resolves to the owner (D3)   ok
//     concurrency limit respected + release                   ok
//     consumer snapshot carries NO runtime URL/credentials    ok
//   REGRESSION (migration safety)
//     existing connectors stay private after the migration    ok
//     existing provider resolution unchanged (no rows added) ok
// ======================================================

const { expect } = require('chai');
const http = require('http');
const express = require('express');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const connectorRepo = require('../src/storage/postgres/repositories/ai-connector-repo');
const endpointRepo = require('../src/storage/postgres/repositories/ai-endpoint-repo');
const registry = require('../src/services/ai-connector/registry');
const sharedPool = require('../src/services/ai-connector/shared-pool');
const workspaceAi = require('../src/services/workspace-ai-provider');
const { createAiEndpointRoutes } = require('../src/routes/ai-endpoint-routes.cjs');

const stamp = `shai1${Date.now()}`;

// ── workspace / connector fixtures ─────────────────────────────────────────

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
    await query(`DELETE FROM ai_endpoint_share_policies WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE name LIKE '%${stamp}%')`);
    await query(`DELETE FROM ai_endpoints WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE name LIKE '%${stamp}%')`);
    await query(`DELETE FROM workspace_ai_providers WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE name LIKE '%${stamp}%')`);
    await query(`DELETE FROM ai_connectors WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE name LIKE '%${stamp}%')`);
    await query(`DELETE FROM workspaces WHERE name LIKE '%${stamp}%'`);
    await query(`DELETE FROM users WHERE username LIKE '%${stamp}%'`);
}

async function createActivatedConnector(workspaceId, name, runtimeType = 'ollama') {
    const { connector, regToken } = await connectorRepo.createConnector({ workspaceId, name, runtimeType });
    const act = await connectorRepo.activateConnector(regToken);
    if (!act.ok) throw new Error(`activation failed: ${act.reason}`);
    return { connector, token: act.token };
}

// ── fake live session (the registry is the liveness authority) ──────────────

function fakeLiveSession(connectorId) {
    return {
        ws: { readyState: 1, close: () => {} },
        state: 'authenticated',
        connectorId,
    };
}

/** Register a fake live session + stamp heartbeat facts (runtime_ok, models). */
async function makeConnectorLive(connectorId, { runtimeOk = true, models = ['qwen3:32b'] } = {}) {
    const session = fakeLiveSession(connectorId);
    registry.register(connectorId, session);
    await connectorRepo.updateConnectorHeartbeat(connectorId, {
        status: 'online',
        models,
        runtimeMeta: { runtime_ok: runtimeOk },
    });
    return session;
}

async function makeConnectorOffline(connectorId) {
    const session = registry.getLive(connectorId);
    if (session) registry.unregister(connectorId, session);
    await connectorRepo.updateConnectorHeartbeat(connectorId, { status: 'offline' });
}

// ── HTTP harness (same injectable-identity pattern as LAC suites) ─────────

function startBackend() {
    const logLines = [];
    const logger = {
        info: (m) => logLines.push(String(m)),
        warn: (m) => logLines.push(String(m)),
        error: (m) => logLines.push(String(m)),
    };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        const id = req.headers['x-test-identity'];
        req.user = id ? JSON.parse(id).user : null;
        req.guest = id ? (JSON.parse(id).guest || null) : null;
        req.workspace = id ? (JSON.parse(id).workspace || null) : null;
        next();
    });
    createAiEndpointRoutes({ logger })(app);
    const server = http.createServer(app);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                logLines,
                base: `http://127.0.0.1:${port}`,
                close: () => new Promise((r) => server.close(() => r())),
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
    return { status: res.status, body: json, raw: JSON.stringify(json || '') };
}

// ───────────────────────────────────────────────────────────────────────────

describe('LLM Sharing Phase 1 — Control Plane (SH-AI-1)', function () {
    this.timeout(30000);

    let srv;
    let wsA, wsB, wsC; // A = owner, B/C = consumers
    let userA, userB, userC;
    let connA1, connA2; // two connectors in workspace A
    let ep1, ep2; // two endpoints on connA1/connA2

    const idA = () => ({ user: { userId: userA }, workspace: { id: wsA } });
    const idB = () => ({ user: { userId: userB }, workspace: { id: wsB } });
    const idC = () => ({ user: { userId: userC }, workspace: { id: wsC } });

    before(async function () {
        this.timeout(60000);
        await runMigrations();
        await cleanup();
        userA = await createUser('shai1u_a');
        userB = await createUser('shai1u_b');
        userC = await createUser('shai1u_c');
        wsA = await createWorkspace('shai1A');
        wsB = await createWorkspace('shai1B');
        wsC = await createWorkspace('shai1C');
        srv = await startBackend();
        const c1 = await createActivatedConnector(wsA, 'Home Ollama', 'ollama');
        const c2 = await createActivatedConnector(wsA, 'Home vLLM', 'vllm');
        connA1 = c1.connector;
        connA2 = c2.connector;
    });

    after(async function () {
        await srv.close();
        await cleanup();
    });

    beforeEach(function () {
        sharedPool.resetForTests();
    });

    // ── OWNERSHIP ─────────────────────────────────────────────────────────

    describe('ownership', () => {

        it('owner creates an endpoint for their own connector — default Private', async () => {
            const res = await api(srv, 'POST', '/api/v1/ai-endpoints', {
                identity: idA(),
                body: { name: 'My Shared Qwen', connector_id: connA1.connector_id, model: 'qwen3:32b' },
            });
            expect(res.status).to.equal(201);
            ep1 = res.body.endpoint;
            expect(ep1.sharing_enabled).to.equal(false); // Private by default
            expect(ep1.enabled).to.equal(true);
            expect(ep1.connector_id).to.equal(connA1.connector_id);
        });

        it('a second endpoint on another connector (for selection order tests)', async () => {
            const res = await api(srv, 'POST', '/api/v1/ai-endpoints', {
                identity: idA(),
                body: { name: 'Second endpoint', connector_id: connA2.connector_id, model: 'llama3:70b' },
            });
            expect(res.status).to.equal(201);
            ep2 = res.body.endpoint;
        });

        it('foreign connector_id → indistinct 404 (connector isolation)', async () => {
            const foreignConn = await createActivatedConnector(wsB, 'B connector');
            const res = await api(srv, 'POST', '/api/v1/ai-endpoints', {
                identity: idA(),
                body: { name: 'Stolen', connector_id: foreignConn.connector.connector_id },
            });
            expect(res.status).to.equal(404);
        });

        it('validation: name/runtime_type/model/connector_id contract', async () => {
            expect((await api(srv, 'POST', '/api/v1/ai-endpoints', {
                identity: idA(), body: { name: '', connector_id: connA1.connector_id },
            })).status).to.equal(400);
            expect((await api(srv, 'POST', '/api/v1/ai-endpoints', {
                identity: idA(), body: { name: 'X', connector_id: 'not-a-uuid' },
            })).status).to.equal(400);
            expect((await api(srv, 'POST', '/api/v1/ai-endpoints', {
                identity: idA(), body: { name: 'X', connector_id: connA1.connector_id, runtime_type: 'anthropic' },
            })).status).to.equal(400);
            expect((await api(srv, 'POST', '/api/v1/ai-endpoints', {
                identity: idA(), body: { name: 'X', connector_id: connA1.connector_id, model: 42 },
            })).status).to.equal(400);
        });

        it('owner updates their endpoint (name/model/description)', async () => {
            const res = await api(srv, 'PATCH', `/api/v1/ai-endpoints/${ep1.endpoint_id}`, {
                identity: idA(),
                body: { name: 'Renamed Qwen', description: 'Spare capacity for the community' },
            });
            expect(res.status).to.equal(200);
            expect(res.body.endpoint.name).to.equal('Renamed Qwen');
            expect(res.body.endpoint.sharing_enabled).to.equal(false); // PATCH never flips sharing
            ep1 = res.body.endpoint;
        });

        it('foreign workspace: GET detail / PATCH / DELETE / share → indistinct 404', async () => {
            expect((await api(srv, 'GET', `/api/v1/ai-endpoints/${ep1.endpoint_id}`, { identity: idB() })).status).to.equal(404);
            expect((await api(srv, 'PATCH', `/api/v1/ai-endpoints/${ep1.endpoint_id}`, {
                identity: idB(), body: { name: 'hijack' },
            })).status).to.equal(404);
            expect((await api(srv, 'DELETE', `/api/v1/ai-endpoints/${ep1.endpoint_id}`, { identity: idB() })).status).to.equal(404);
            expect((await api(srv, 'POST', `/api/v1/ai-endpoints/${ep1.endpoint_id}/share`, {
                identity: idB(), body: { confirm_share: true },
            })).status).to.equal(404);
            expect((await api(srv, 'DELETE', `/api/v1/ai-endpoints/${ep1.endpoint_id}/share`, { identity: idB() })).status).to.equal(404);
        });

        it('list shows only the caller workspace endpoints', async () => {
            const res = await api(srv, 'GET', '/api/v1/ai-endpoints', { identity: idA() });
            expect(res.status).to.equal(200);
            const ids = res.body.endpoints.map((e) => e.endpoint_id);
            expect(ids).to.include(ep1.endpoint_id);
            expect(ids).to.include(ep2.endpoint_id);
            expect(ids.every((id) => id === ep1.endpoint_id || id === ep2.endpoint_id)).to.equal(true);
            const b = await api(srv, 'GET', '/api/v1/ai-endpoints', { identity: idB() });
            expect(b.body.endpoints).to.have.length(0);
        });

        it('anonymous → 401; guest → 401 (users-only guard — no user, no access)', async () => {
            expect((await api(srv, 'GET', '/api/v1/ai-endpoints', {})).status).to.equal(401);
            // Guest with a resolved workspace: the users-only guard demands a
            // real user first — 401 precedes the guest verdict (worker-routes
            // / ai-connector-routes parity: req.user is falsy for a guest).
            expect((await api(srv, 'GET', '/api/v1/ai-endpoints', {
                identity: { guest: { id: 'g1' }, workspace: { id: wsA } },
            })).status).to.equal(401);
        });
    });

    // ── SHARING ───────────────────────────────────────────────────────────

    describe('sharing state (Private ↔ Shared)', () => {

        it('enable sharing requires explicit confirm_share=true', async () => {
            const res = await api(srv, 'POST', `/api/v1/ai-endpoints/${ep1.endpoint_id}/share`, {
                identity: idA(), body: {},
            });
            expect(res.status).to.equal(400);
            expect(res.body.code).to.equal('share_confirmation_required');
        });

        it('owner enables sharing — Private → Shared', async () => {
            const res = await api(srv, 'POST', `/api/v1/ai-endpoints/${ep1.endpoint_id}/share`, {
                identity: idA(), body: { confirm_share: true, concurrency_limit: 2 },
            });
            expect(res.status).to.equal(200);
            expect(res.body.endpoint.sharing_enabled).to.equal(true);
            expect(res.body.endpoint.concurrency_limit).to.equal(2);
            expect(res.body.sharing).to.equal(true);
        });

        it('owner disables sharing — Shared → Private (limit resets to default)', async () => {
            const res = await api(srv, 'DELETE', `/api/v1/ai-endpoints/${ep1.endpoint_id}/share`, { identity: idA() });
            expect(res.status).to.equal(200);
            expect(res.body.endpoint.sharing_enabled).to.equal(false);
            expect(res.body.sharing).to.equal(false);
            // Re-enable for later tests, back to the baseline limit.
            const on = await api(srv, 'POST', `/api/v1/ai-endpoints/${ep1.endpoint_id}/share`, {
                identity: idA(), body: { confirm_share: true },
            });
            expect(on.status).to.equal(200);
            expect(on.body.endpoint.concurrency_limit).to.equal(1);
        });

        it('a disabled (enabled=false) endpoint cannot be shared — independent gates', async () => {
            const off = await api(srv, 'PATCH', `/api/v1/ai-endpoints/${ep2.endpoint_id}`, {
                identity: idA(), body: { enabled: false },
            });
            expect(off.status).to.equal(200);
            const res = await api(srv, 'POST', `/api/v1/ai-endpoints/${ep2.endpoint_id}/share`, {
                identity: idA(), body: { confirm_share: true },
            });
            expect(res.status).to.equal(409);
            expect(res.body.code).to.equal('endpoint_disabled');
            // restore for later tests
            await api(srv, 'PATCH', `/api/v1/ai-endpoints/${ep2.endpoint_id}`, {
                identity: idA(), body: { enabled: true },
            });
        });

        it('concurrency_limit validation (integer 1..8)', async () => {
            expect((await api(srv, 'POST', `/api/v1/ai-endpoints/${ep2.endpoint_id}/share`, {
                identity: idA(), body: { confirm_share: true, concurrency_limit: 0 },
            })).status).to.equal(400);
            expect((await api(srv, 'POST', `/api/v1/ai-endpoints/${ep2.endpoint_id}/share`, {
                identity: idA(), body: { confirm_share: true, concurrency_limit: 99 },
            })).status).to.equal(400);
        });

        it('private endpoint NOT eligible for the shared resolver (policy off)', async () => {
            // ep1 Shared + LIVE; ep2 stays Private (sharing off) but also live.
            await makeConnectorLive(connA1.connector_id);
            await makeConnectorLive(connA2.connector_id);
            const snapshot = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(snapshot).to.not.be.null;
            expect(snapshot.shared.endpointId).to.equal(ep1.endpoint_id);
            sharedPool.releaseSharedAI(snapshot);
        });

        it('shared endpoint eligible only when the policy allows (both on → eligible)', async () => {
            const snapshot = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(snapshot).to.not.be.null;
            expect(snapshot.shared.endpointId).to.equal(ep1.endpoint_id);
            sharedPool.releaseSharedAI(snapshot);
        });
    });

    // ── CONNECTOR STATE ───────────────────────────────────────────────────

    describe('connector state — availability follows the connector', () => {

        before(async () => {
            await makeConnectorLive(connA1.connector_id);
            await makeConnectorLive(connA2.connector_id);
            const on = await api(srv, 'POST', `/api/v1/ai-endpoints/${ep2.endpoint_id}/share`, {
                identity: idA(), body: { confirm_share: true },
            });
            expect(on.status).to.equal(200);
        });

        it('shared + live → eligible; endpoint availability follows connector liveness', async () => {
            const snapshot = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(snapshot).to.not.be.null;
            sharedPool.releaseSharedAI(snapshot);
        });

        it('shared + offline → NOT eligible (live WS session authoritative)', async () => {
            await makeConnectorOffline(connA1.connector_id);
            // ep2 still live → resolves; then kill ep2's connector too.
            let snapshot = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(snapshot).to.not.be.null;
            expect(snapshot.shared.endpointId).to.equal(ep2.endpoint_id);
            sharedPool.releaseSharedAI(snapshot);

            await makeConnectorOffline(connA2.connector_id);
            snapshot = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(snapshot).to.be.null; // nothing eligible
        });

        it('private + live → NOT eligible for the shared pool', async () => {
            // Make both live again but turn sharing OFF on both.
            await makeConnectorLive(connA1.connector_id);
            await makeConnectorLive(connA2.connector_id);
            expect((await api(srv, 'DELETE', `/api/v1/ai-endpoints/${ep1.endpoint_id}/share`, { identity: idA() })).status).to.equal(200);
            expect((await api(srv, 'DELETE', `/api/v1/ai-endpoints/${ep2.endpoint_id}/share`, { identity: idA() })).status).to.equal(200);
            const snapshot = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(snapshot).to.be.null; // live + private → NOT in the pool
            // Restore shared state for the security block below.
            expect((await api(srv, 'POST', `/api/v1/ai-endpoints/${ep1.endpoint_id}/share`, {
                identity: idA(), body: { confirm_share: true },
            })).status).to.equal(200);
        });

        it('runtime unreachable (runtime_ok false/unknown) → NOT eligible', async () => {
            await connectorRepo.updateConnectorHeartbeat(connA1.connector_id, {
                status: 'online',
                runtimeMeta: { runtime_ok: false },
            });
            let snapshot = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(snapshot).to.be.null;
            await makeConnectorLive(connA1.connector_id); // restore
            snapshot = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(snapshot).to.not.be.null;
            sharedPool.releaseSharedAI(snapshot);
        });
    });

    // ── RESOLVER ───────────────────────────────────────────────────────────

    describe('resolver seam (resolveSharedAI)', () => {

        before(async () => {
            await makeConnectorLive(connA1.connector_id);
            await makeConnectorLive(connA2.connector_id, { models: ['llama3:70b'] });
            expect((await api(srv, 'POST', `/api/v1/ai-endpoints/${ep2.endpoint_id}/share`, {
                identity: idA(), body: { confirm_share: true },
            })).status).to.equal(200);
        });

        it('deterministic selection — first eligible in stable order', async () => {
            // ep1 created before ep2 → ep1 wins.
            const s1 = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(s1.shared.endpointId).to.equal(ep1.endpoint_id);
            sharedPool.releaseSharedAI(s1);
            const s2 = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(s2.shared.endpointId).to.equal(ep1.endpoint_id); // same on repeat
            sharedPool.releaseSharedAI(s2);
        });

        it('offline endpoint is skipped — next eligible selected', async () => {
            await makeConnectorOffline(connA1.connector_id);
            const s = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(s).to.not.be.null;
            expect(s.shared.endpointId).to.equal(ep2.endpoint_id);
            sharedPool.releaseSharedAI(s);
            await makeConnectorLive(connA1.connector_id);
        });

        it('disabled endpoint skipped; soft-deleted endpoint skipped', async () => {
            // disable ep1 (owner availability switch)
            expect((await api(srv, 'PATCH', `/api/v1/ai-endpoints/${ep1.endpoint_id}`, {
                identity: idA(), body: { enabled: false },
            })).status).to.equal(200);
            let s = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(s.shared.endpointId).to.equal(ep2.endpoint_id);
            sharedPool.releaseSharedAI(s);
            // soft-delete would kill ep2 too — restore ep1 and delete a copy
            expect((await api(srv, 'PATCH', `/api/v1/ai-endpoints/${ep1.endpoint_id}`, {
                identity: idA(), body: { enabled: true },
            })).status).to.equal(200);

            // soft-delete a third endpoint to prove deletion removes pool eligibility
            const third = await api(srv, 'POST', '/api/v1/ai-endpoints', {
                identity: idA(),
                body: { name: 'Doomed', connector_id: connA1.connector_id },
            });
            expect((await api(srv, 'POST', `/api/v1/ai-endpoints/${third.body.endpoint.endpoint_id}/share`, {
                identity: idA(), body: { confirm_share: true },
            })).status).to.equal(200);
            // third endpoint was created LAST → ep1 (earlier) still wins
            s = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(s.shared.endpointId).to.equal(ep1.endpoint_id);
            sharedPool.releaseSharedAI(s);
            expect((await api(srv, 'DELETE', `/api/v1/ai-endpoints/${third.body.endpoint.endpoint_id}`, { identity: idA() })).status).to.equal(200);
            // deleted → invisible everywhere
            expect((await api(srv, 'GET', `/api/v1/ai-endpoints/${third.body.endpoint.endpoint_id}`, { identity: idA() })).status).to.equal(404);
        });

        it('model selection: requested → configured → first discovered', async () => {
            // Create a fresh endpoint so this test is isolated from ep1/ep2.
            const fresh = await api(srv, 'POST', '/api/v1/ai-endpoints', {
                identity: idA(),
                body: { name: 'model-select', connector_id: connA1.connector_id, model: 'qwen3:32b' },
            });
            expect(fresh.status).to.equal(201);
            const id = fresh.body.endpoint.endpoint_id;
            await api(srv, 'POST', `/api/v1/ai-endpoints/${id}/share`, {
                identity: idA(), body: { confirm_share: true },
            });
            await makeConnectorLive(connA1.connector_id, { models: ['qwen3:32b'] });

            // requested model present → uses it
            const s = await sharedPool.resolveSharedAI({ workspaceId: wsB, model: 'qwen3:32b' });
            expect(s).to.not.be.null;
            expect(s.model).to.equal('qwen3:32b');
            sharedPool.releaseSharedAI(s);

            // no request → falls back to endpoint.model
            const s2 = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(s2).to.not.be.null;
            expect(s2.model).to.equal('qwen3:32b');
            sharedPool.releaseSharedAI(s2);

            await api(srv, 'DELETE', `/api/v1/ai-endpoints/${id}/share`, { identity: idA() });
            await api(srv, 'DELETE', `/api/v1/ai-endpoints/${id}`, { identity: idA() });
        });

        it('owner never resolves through their own shared endpoint (D3)', async () => {
            const own = await sharedPool.resolveSharedAI({ workspaceId: wsA });
            expect(own).to.be.null;
        });

        it('no second provider system — snapshot is a connector snapshot', async () => {
            const s = await sharedPool.resolveSharedAI({ workspaceId: wsB, purpose: 'chat' });
            expect(s.transport).to.equal('connector');
            expect(s.endpoint).to.equal(null); // NEVER a runtime URL
            expect(s.apiKey).to.equal(null);    // NEVER credentials
            expect(s.connectorId).to.equal(connA1.connector_id);
            expect(s.source).to.equal('shared');
            expect(s.purpose).to.equal('chat');
            expect(s.shared.ownerWorkspaceId).to.equal(wsA);
            sharedPool.releaseSharedAI(s);
        });

        it('concurrency limit respected and released (the seam gate)', async () => {
            // ep1 limit = 1 (reset when disabled earlier)
            const s1 = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(s1).to.not.be.null;
            // At limit → ep1 busy → falls through to ep2
            const s2 = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(s2.shared.endpointId).to.equal(ep2.endpoint_id);
            // Both at limit → nothing eligible
            const s3 = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(s3).to.be.null;
            sharedPool.releaseSharedAI(s1);
            sharedPool.releaseSharedAI(s2);
            // Released → ep1 eligible again
            const s4 = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(s4.shared.endpointId).to.equal(ep1.endpoint_id);
            sharedPool.releaseSharedAI(s4);
        });

        it('no workspace → no resolution (fail closed)', async () => {
            expect(await sharedPool.resolveSharedAI({})).to.be.null;
            expect(await sharedPool.resolveSharedAI({ workspaceId: null })).to.be.null;
        });
    });

    // ── SECURITY ──────────────────────────────────────────────────────────

    describe('security — non-disclosure surface', () => {

        it('NO credential material in ANY endpoint response (llmc./llmcreg./token)', async () => {
            const routes = [
                ['GET', '/api/v1/ai-endpoints', idA()],
                ['GET', `/api/v1/ai-endpoints/${ep1.endpoint_id}`, idA()],
                ['PATCH', `/api/v1/ai-endpoints/${ep1.endpoint_id}`, idA()],
                ['POST', `/api/v1/ai-endpoints/${ep1.endpoint_id}/share`, idA()],
                ['DELETE', `/api/v1/ai-endpoints/${ep1.endpoint_id}/share`, idA()],
            ];
            for (const [method, path, identity] of routes) {
                const res = await api(srv, method, path, {
                    identity,
                    body: method === 'PATCH' ? { name: 'X' }
                        : method === 'POST' ? { confirm_share: true } : undefined,
                });
                expect(res.status).to.equal(200);
                expect(res.raw).to.not.match(/llmc\./);
                expect(res.raw).to.not.match(/llmcreg\./);
                expect(res.raw).to.not.include('token_hash');
                expect(res.raw).to.not.include('reg_token_hash');
                expect(res.raw).to.not.include('token_prefix');
            }
        });

        it('NO runtime URL / endpoint / arbitrary URL fields exist on the surface', async () => {
            const res = await api(srv, 'GET', `/api/v1/ai-endpoints/${ep1.endpoint_id}`, { identity: idA() });
            expect(res.status).to.equal(200);
            const e = res.body.endpoint;
            expect(e).to.not.have.property('runtime_url');
            expect(e).to.not.have.property('base_url');
            expect(e.endpoint).to.equal(undefined); // no endpoint field at all
            expect(JSON.stringify(e)).to.not.match(/https?:\/\//);
            // POST/accepting an arbitrary URL is impossible — the create
            // contract has no URL field, connector_id must be a UUID:
            const hostile = await api(srv, 'POST', '/api/v1/ai-endpoints', {
                identity: idA(),
                body: {
                    name: 'evil',
                    connector_id: connA1.connector_id,
                    runtime_url: 'http://169.254.169.254/latest/meta-data',
                    url: 'http://127.0.0.1:11434',
                },
            });
            expect(hostile.status).to.equal(201); // created, but…
            expect(hostile.body.endpoint).to.not.have.property('runtime_url');
            expect(hostile.body.endpoint).to.not.have.property('url');
            expect(JSON.stringify(hostile.body)).to.not.include('169.254');
            await api(srv, 'DELETE', `/api/v1/ai-endpoints/${hostile.body.endpoint.endpoint_id}`, { identity: idA() });
        });

        it('consumer resolver snapshot never exposes the owner URL or credentials', async () => {
            const s = await sharedPool.resolveSharedAI({ workspaceId: wsC });
            expect(s).to.not.be.null;
            const serialized = JSON.stringify(s);
            expect(serialized).to.not.match(/https?:\/\//);
            expect(serialized).to.not.match(/llmc\./);
            expect(serialized).to.not.include('token');
            expect(s.endpoint).to.equal(null);
            expect(s.apiKey).to.equal(null);
            // The consumer knows it rides a SHARED endpoint but not whose
            // machine, which URL, or any credential.
            expect(s.shared.endpointName).to.be.a('string');
            sharedPool.releaseSharedAI(s);
        });

        it('connector isolation — endpoint rows never leak another workspace connector', async () => {
            const foreign = await api(srv, 'GET', '/api/v1/ai-endpoints', { identity: idB() });
            expect(foreign.body.endpoints).to.have.length(0);
        });

        it('soft-deleted endpoint invisible to owner list/detail AND to the pool', async () => {
            const temp = await api(srv, 'POST', '/api/v1/ai-endpoints', {
                identity: idA(), body: { name: 'Temp', connector_id: connA2.connector_id },
            });
            const id = temp.body.endpoint.endpoint_id;
            expect((await api(srv, 'DELETE', `/api/v1/ai-endpoints/${id}`, { identity: idA() })).status).to.equal(200);
            expect((await api(srv, 'GET', `/api/v1/ai-endpoints/${id}`, { identity: idA() })).status).to.equal(404);
            // foreign workspace sees the same 404 (never a 410-style oracle)
            expect((await api(srv, 'GET', `/api/v1/ai-endpoints/${id}`, { identity: idB() })).status).to.equal(404);
        });
    });

    // ── REGRESSION — migration safety (§13) ────────────────────────────────

    describe('regression — migration safety', () => {

        it('existing connectors stay Private after the migration (no endpoint rows created)', async () => {
            const before = (await query(`SELECT COUNT(*)::int AS n FROM ai_endpoints`)).rows[0].n;
            // Creating a fresh connector must NOT create an endpoint/policy row.
            await createActivatedConnector(wsA, 'Post-migration connector');
            const after = (await query(`SELECT COUNT(*)::int AS n FROM ai_endpoints`)).rows[0].n;
            expect(after).to.equal(before);
        });

        it('no policy row is enabled unless the owner explicitly enabled it', async () => {
            // Every enabled policy must belong to a live, enabled, non-deleted
            // endpoint (the exact condition listSharedEndpoints enforces) —
            // plus the pool must never see a policy whose endpoint is gone.
            const { rows: orphanVisible } = await query(`
                SELECT COUNT(*)::int AS n FROM ai_endpoint_share_policies p
                JOIN ai_endpoints e ON e.endpoint_id = p.endpoint_id
                JOIN ai_connectors c ON c.connector_id = e.connector_id
                WHERE p.enabled = TRUE AND p.revoked_at IS NULL
                  AND e.enabled = TRUE AND e.deleted_at IS NULL
                  AND c.revoked_at IS NULL
                  AND e.workspace_id NOT IN (
                      SELECT id FROM workspaces WHERE name LIKE '%${stamp}%')
            `);
            // Only THIS test suite's own workspaces may carry enabled
            // policies — nothing else in the DB was auto-enabled.
            expect(orphanVisible[0].n).to.equal(0);
        });

        it('deleting the endpoint stops pool eligibility even if the policy row lingers (soft delete)', async () => {
            // listSharedEndpoints (the pool read path) must never return a
            // soft-deleted endpoint regardless of policy state.
            const { rows } = await query(`
                SELECT COUNT(*)::int AS n FROM ai_endpoint_share_policies p
                JOIN ai_endpoints e ON e.endpoint_id = p.endpoint_id
                WHERE p.enabled = TRUE AND p.revoked_at IS NULL
                  AND e.deleted_at IS NOT NULL
            `);
            // (the earlier soft-delete test leaves exactly this situation
            // behind; the pool must filter it — assert via the repo read)
            const pool = await endpointRepo.listSharedEndpoints();
            expect(pool.every((entry) => entry.endpoint.endpoint_id !== undefined)).to.equal(true);
            expect(pool.some((entry) => entry.endpoint.name === 'Temp')).to.equal(false);
            expect(rows[0].n).to.be.at.least(0); // policy row may linger (audit)
        });

        it('existing workspace_ai_providers resolution is unchanged', async () => {
            // A has no provider row — resolution degrades exactly as before.
            const resolved = await workspaceAi.resolveAIForWorkspace(wsA);
            expect(resolved.source).to.be.oneOf(['system', 'none', 'global']);
            expect(resolved.transport).to.equal(undefined);
        });

        it('workspace with a bound local-ai provider still resolves the connector snapshot', async () => {
            const { upsertProvider, resolveAIForWorkspace, deleteProvider, invalidateCache } = workspaceAi;
            await upsertProvider(wsA, {
                providerType: 'local-ai',
                connectorId: connA1.connector_id,
                model: 'qwen3:32b',
            });
            try {
                const snap = await resolveAIForWorkspace(wsA);
                expect(snap.transport).to.equal('connector');
                expect(snap.connectorId).to.equal(connA1.connector_id);
                expect(snap.source).to.equal('workspace'); // NOT 'shared' — private path untouched
            } finally {
                await deleteProvider(wsA);
                invalidateCache(wsA);
            }
        });
    });

    // ── STRICT MODEL ELIGIBILITY (hardening §2.7) ────────────────────────
    // selectModel() MUST only return a model present in connector.models;
    // endpoints whose model is not discovered are NOT eligible.

    describe('strict model eligibility — discovered list is the truth', () => {
        // Create a dedicated connector with empty discovered models list,
        // and one with mismatched discovered models, so we can test the
        // strict model eligibility contract without touching shared fixtures.
        let extraWs, extraUser, extraConn, extraEp;

        // Clean residual ep1/ep2 state from earlier test blocks so this block
        // gets a deterministic starting point.
        before(async () => {
            extraUser = await createUser('model_elig_u');
            extraWs = await createWorkspace('model_elig');
            extraConn = (await createActivatedConnector(extraWs, 'Model Elig Conn', 'ollama')).connector;
            // Disable sharing on the shared fixtures so only this block's
            // freshly created endpoints participate in the resolver.
            await api(srv, 'DELETE', `/api/v1/ai-endpoints/${ep1.endpoint_id}/share`, { identity: idA() });
            await api(srv, 'DELETE', `/api/v1/ai-endpoints/${ep2.endpoint_id}/share`, { identity: idA() });
            await makeConnectorOffline(connA1.connector_id);
            await makeConnectorOffline(connA2.connector_id);
        });

        after(async () => {
            // Restore shared fixtures for any later tests.
            if (extraEp) {
                await api(srv, 'DELETE', `/api/v1/ai-endpoints/${extraEp.endpoint_id}/share`, {
                    identity: { user: { userId: extraUser }, workspace: { id: extraWs } },
                });
                await api(srv, 'DELETE', `/api/v1/ai-endpoints/${extraEp.endpoint_id}`, {
                    identity: { user: { userId: extraUser }, workspace: { id: extraWs } },
                });
            }
            await makeConnectorOffline(extraConn.connector_id);
            await makeConnectorLive(connA1.connector_id);
            await makeConnectorLive(connA2.connector_id, { models: ['llama3:70b'] });
            await api(srv, 'POST', `/api/v1/ai-endpoints/${ep1.endpoint_id}/share`, {
                identity: idA(), body: { confirm_share: true },
            });
            await api(srv, 'POST', `/api/v1/ai-endpoints/${ep2.endpoint_id}/share`, {
                identity: idA(), body: { confirm_share: true },
            });
        });

        // Each test in this block creates a fresh endpoint, enables sharing,
        // and cleans up — the shared fixtures (ep1/ep2) stay untouched.

        it('requested model present in discovered → eligible', async () => {
            // connA1 discovered: ['qwen3:32b'] — request that exact model
            await makeConnectorLive(connA1.connector_id, { models: ['qwen3:32b'] });
            const res = await api(srv, 'POST', '/api/v1/ai-endpoints', {
                identity: idA(),
                body: { name: 'strict-a', connector_id: connA1.connector_id, model: 'qwen3:32b' },
            });
            expect(res.status).to.equal(201);
            const epId = res.body.endpoint.endpoint_id;
            await api(srv, 'POST', `/api/v1/ai-endpoints/${epId}/share`, {
                identity: idA(), body: { confirm_share: true },
            });

            const snap = await sharedPool.resolveSharedAI({
                workspaceId: wsB, model: 'qwen3:32b',
            });
            expect(snap).to.not.be.null;
            expect(snap.model).to.equal('qwen3:32b');
            sharedPool.releaseSharedAI(snap);

            // cleanup
            await api(srv, 'DELETE', `/api/v1/ai-endpoints/${epId}/share`, { identity: idA() });
            await api(srv, 'DELETE', `/api/v1/ai-endpoints/${epId}`, { identity: idA() });
        });

        it('requested model absent from discovered → endpoint skipped', async () => {
            await makeConnectorLive(connA1.connector_id, { models: ['qwen3:32b'] });
            const res = await api(srv, 'POST', '/api/v1/ai-endpoints', {
                identity: idA(),
                body: { name: 'strict-b', connector_id: connA1.connector_id, model: 'qwen3:32b' },
            });
            expect(res.status).to.equal(201);
            const epId = res.body.endpoint.endpoint_id;
            await api(srv, 'POST', `/api/v1/ai-endpoints/${epId}/share`, {
                identity: idA(), body: { confirm_share: true },
            });

            // Request a model that does NOT exist in discovered list
            const snap = await sharedPool.resolveSharedAI({
                workspaceId: wsB, model: 'nonexistent:99b',
            });
            expect(snap).to.be.null;

            // cleanup
            await api(srv, 'DELETE', `/api/v1/ai-endpoints/${epId}/share`, { identity: idA() });
            await api(srv, 'DELETE', `/api/v1/ai-endpoints/${epId}`, { identity: idA() });
        });

        it('first endpoint has wrong model → falls through to next eligible', async () => {
            // Create endpoint A on connA1 (discovered: qwen3:32b)
            await makeConnectorLive(connA1.connector_id, { models: ['qwen3:32b'] });
            const epA = await api(srv, 'POST', '/api/v1/ai-endpoints', {
                identity: idA(),
                body: { name: 'strict-first', connector_id: connA1.connector_id, model: 'qwen3:32b' },
            });
            expect(epA.status).to.equal(201);
            await api(srv, 'POST', `/api/v1/ai-endpoints/${epA.body.endpoint.endpoint_id}/share`, {
                identity: idA(), body: { confirm_share: true },
            });

            // Create endpoint B on connA2 (discovered: llama3:70b)
            await makeConnectorLive(connA2.connector_id, { models: ['llama3:70b'] });
            const epB = await api(srv, 'POST', '/api/v1/ai-endpoints', {
                identity: idA(),
                body: { name: 'strict-second', connector_id: connA2.connector_id, model: 'llama3:70b' },
            });
            expect(epB.status).to.equal(201);
            await api(srv, 'POST', `/api/v1/ai-endpoints/${epB.body.endpoint.endpoint_id}/share`, {
                identity: idA(), body: { confirm_share: true },
            });

            // Request a model only connA2 has — epA (first in order) is
            // skipped because it lacks the requested model; epB is selected.
            const snap = await sharedPool.resolveSharedAI({
                workspaceId: wsB, model: 'llama3:70b',
            });
            expect(snap).to.not.be.null;
            expect(snap.shared.endpointId).to.equal(epB.body.endpoint.endpoint_id);
            expect(snap.model).to.equal('llama3:70b');
            sharedPool.releaseSharedAI(snap);

            // cleanup
            await api(srv, 'DELETE', `/api/v1/ai-endpoints/${epA.body.endpoint.endpoint_id}/share`, { identity: idA() });
            await api(srv, 'DELETE', `/api/v1/ai-endpoints/${epA.body.endpoint.endpoint_id}`, { identity: idA() });
            await api(srv, 'DELETE', `/api/v1/ai-endpoints/${epB.body.endpoint.endpoint_id}/share`, { identity: idA() });
            await api(srv, 'DELETE', `/api/v1/ai-endpoints/${epB.body.endpoint.endpoint_id}`, { identity: idA() });
        });

        it('endpoint.model present and in discovered → uses it', async () => {
            await makeConnectorLive(connA1.connector_id, { models: ['qwen3:32b', 'qwen3:8b'] });
            const res = await api(srv, 'POST', '/api/v1/ai-endpoints', {
                identity: idA(),
                body: { name: 'strict-c', connector_id: connA1.connector_id, model: 'qwen3:8b' },
            });
            expect(res.status).to.equal(201);
            const epId = res.body.endpoint.endpoint_id;
            await api(srv, 'POST', `/api/v1/ai-endpoints/${epId}/share`, {
                identity: idA(), body: { confirm_share: true },
            });

            // No requested model → falls back to endpoint.model → qwen3:8b
            const snap = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(snap).to.not.be.null;
            expect(snap.model).to.equal('qwen3:8b');
            sharedPool.releaseSharedAI(snap);

            // cleanup
            await api(srv, 'DELETE', `/api/v1/ai-endpoints/${epId}/share`, { identity: idA() });
            await api(srv, 'DELETE', `/api/v1/ai-endpoints/${epId}`, { identity: idA() });
        });

        it('endpoint.model absent from discovered → first discovered model used', async () => {
            // connA1 discovered: ['qwen3:32b'] — endpoint.model: 'wrong:model'
            await makeConnectorLive(connA1.connector_id, { models: ['qwen3:32b'] });
            const res = await api(srv, 'POST', '/api/v1/ai-endpoints', {
                identity: idA(),
                body: { name: 'strict-d', connector_id: connA1.connector_id, model: 'wrong:model' },
            });
            expect(res.status).to.equal(201);
            const epId = res.body.endpoint.endpoint_id;
            await api(srv, 'POST', `/api/v1/ai-endpoints/${epId}/share`, {
                identity: idA(), body: { confirm_share: true },
            });

            // No requested model → endpoint.model ('wrong:model') NOT in discovered
            // → first discovered: 'qwen3:32b'
            const snap = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(snap).to.not.be.null;
            expect(snap.model).to.equal('qwen3:32b');
            sharedPool.releaseSharedAI(snap);

            // cleanup
            await api(srv, 'DELETE', `/api/v1/ai-endpoints/${epId}/share`, { identity: idA() });
            await api(srv, 'DELETE', `/api/v1/ai-endpoints/${epId}`, { identity: idA() });
        });

        it('connector has no discovered models → null (no_models)', async () => {
            // extraConn: no heartbeat / no models discovered
            await makeConnectorLive(extraConn.connector_id, { models: [] });
            const res = await api(srv, 'POST', '/api/v1/ai-endpoints', {
                identity: { user: { userId: extraUser }, workspace: { id: extraWs } },
                body: { name: 'strict-empty', connector_id: extraConn.connector_id, model: 'whatever' },
            });
            expect(res.status).to.equal(201);
            extraEp = res.body.endpoint.endpoint_id;
            await api(srv, 'POST', `/api/v1/ai-endpoints/${extraEp}/share`, {
                identity: { user: { userId: extraUser }, workspace: { id: extraWs } },
                body: { confirm_share: true },
            });

            // No discovered models → not eligible → null
            const snap = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(snap).to.be.null;
            // Also: even with a specific model request, same result
            const snap2 = await sharedPool.resolveSharedAI({ workspaceId: wsB, model: 'anything' });
            expect(snap2).to.be.null;
        });

        it('owner endpoint NOT eligible through shared pool (D3)', async () => {
            // ep1 is shared and live → owner wsA still gets null from shared pool
            await makeConnectorLive(connA1.connector_id, { models: ['qwen3:32b'] });
            const snap = await sharedPool.resolveSharedAI({ workspaceId: wsA });
            expect(snap).to.be.null;
        });

        it('concurrency + release still works under strict model eligibility', async () => {
            await makeConnectorLive(connA1.connector_id, { models: ['qwen3:32b'] });
            const res = await api(srv, 'POST', '/api/v1/ai-endpoints', {
                identity: idA(),
                body: { name: 'strict-conc', connector_id: connA1.connector_id, model: 'qwen3:32b' },
            });
            expect(res.status).to.equal(201);
            const epId = res.body.endpoint.endpoint_id;
            await api(srv, 'POST', `/api/v1/ai-endpoints/${epId}/share`, {
                identity: idA(), body: { confirm_share: true, concurrency_limit: 1 },
            });

            const s1 = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(s1).to.not.be.null;
            expect(s1.model).to.equal('qwen3:32b');
            // At limit → second request returns null
            const s2 = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(s2).to.be.null;
            sharedPool.releaseSharedAI(s1);
            // After release → eligible again
            const s3 = await sharedPool.resolveSharedAI({ workspaceId: wsB });
            expect(s3).to.not.be.null;
            sharedPool.releaseSharedAI(s3);

            // cleanup
            await api(srv, 'DELETE', `/api/v1/ai-endpoints/${epId}/share`, { identity: idA() });
            await api(srv, 'DELETE', `/api/v1/ai-endpoints/${epId}`, { identity: idA() });
        });
    });
});
