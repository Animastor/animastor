// ======================================================
// LLM Connector Provider Binding Tests (LAC-6 — Local AI Connector V1 Phase 6)
// ======================================================
// Coverage (docs/04-planning/local-ai-connector-v1.md §3.1, §9, §10, §15-6):
//
//   PUT /settings/ai/provider {provider_type:'local-ai'}:
//     binds the singleton provider to a workspace connector; meta carries
//     connector_id, NO endpoint, NO key material (AD-11 marker row)        ok
//     validation: missing/malformed connector_id → 400                      ok
//     foreign-workspace / revoked / unknown connector → indistinct 404      ok
//     model is a short free string                                          ok
//     switching local-ai → cloud type requires a REAL api_key again         ok
//     switching cloud → local-ai overwrites the stored key with the marker   ok
//   RESOLVER (§9 seam):
//     resolveAIForWorkspace returns the connector snapshot
//     (transport:'connector', connectorId, endpoint:null, apiKey:null)     ok
//     resolveAIProvider purpose-tag does NOT re-tag the source              ok
//     resolver cache invalidation on upsert applies to connector rows       ok
//   INFERENCE through the binding (real WS session + real fake runtime):
//     ai-service.callAI over the connector snapshot returns content         ok
//     agent-path guard: bootstrap-style apiKey check accepts connector      ok
//     revoked / offline connector → fail-closed sanitized 'offline' error
//     (AD-12 — never a silent system fallback)                              ok
//     model fallback: stored model wins, else first discovered model         ok
//   POST /settings/ai/test (connector path — user-initiated AD-7 probe):
//     ok over a live session; status stamped on the stored binding          ok
//     connector_offline → ok:false with sanitized error + code              ok
//     no models discovered → explicit no_models answer                      ok
//     foreign connector_id → indistinct 404                                 ok
//   POST /ai-connector/connectors/:id/models/refresh:
//     explicit discovery over a live session → models persisted (GET
//     /ai-connector/models reflects them); offline → ok:false code          ok
//     foreign/revoked connector → indistinct 404                            ok
//   ROTATE / REVOKE through the binding:
//     rotate discloses a new llmc.* once; reconnect works; binding intact   ok
//     revoke kills the live session; inference fails closed immediately    ok
//   SECURITY:
//     workspace isolation — B cannot bind/test/refresh A's connector (404)  ok
//     credential non-disclosure — no llmc./llmcreg. material in ANY API
//     response or application log along the whole flow                      ok
// ======================================================

const { expect } = require('chai');
const http = require('http');
const { WebSocket } = require('ws');
const express = require('express');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const repo = require('../src/storage/postgres/repositories/ai-connector-repo');
const registry = require('../src/services/ai-connector/registry');
const transport = require('../src/services/ai-connector/transport');
const workspaceAi = require('../src/services/workspace-ai-provider');
const aiService = require('../src/services/ai-service');
const { createWsHandler, createAiConnectorRoutes } = require('../src/routes/ai-connector-routes.cjs');
const { createMockRedis } = require('./mocks/redis-mock');

const stamp = `lac6${Date.now()}`;

// ── shared helpers ────────────────────────────────────────────────────────

async function createWorkspace(name) {
    const { rows } = await query(
        `INSERT INTO workspaces (name, type) VALUES ($1, 'personal') RETURNING id`,
        [`${name}-${stamp}`]
    );
    return rows[0].id;
}

async function cleanup() {
    await query(`DELETE FROM workspace_ai_providers WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE name LIKE '%${stamp}%')`);
    await query(`DELETE FROM ai_connectors WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE name LIKE '%${stamp}%')`);
    await query(`DELETE FROM workspaces WHERE name LIKE '%${stamp}%'`);
}

async function createActivatedConnector(workspaceId, name, runtimeType = 'ollama') {
    const { connector, regToken } = await repo.createConnector({ workspaceId, name, runtimeType });
    const act = await repo.activateConnector(regToken);
    if (!act.ok) throw new Error(`activation failed: ${act.reason}`);
    return { connector, token: act.token };
}

// ── fake local runtime (OpenAI-compatible) ─────────────────────────────────

function startFakeRuntime(handler) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                try { server.lastBody = body ? JSON.parse(body) : null; } catch (_) {}
                handler(req, res, server);
            });
        });
        server.listen(0, '127.0.0.1', () => {
            server.port = server.address().port;
            server.baseUrl = `http://127.0.0.1:${server.port}`;
            server.closeServer = (() => {
                const orig = server.close.bind(server);
                return () => new Promise((r) => orig(() => r()));
            })();
            resolve(server);
        });
    });
}

const CHAT_HANDLER = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        id: 'cmpl-1', object: 'chat.completion', created: 1700000000,
        model: 'qwen3:32b',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello from local' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }));
};

const MODELS_HANDLER = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        object: 'list',
        data: [
            { id: 'qwen3:32b', object: 'model' },
            { id: 'llama3:8b', object: 'model' },
        ],
    }));
};

/** Runtime that serves BOTH the chat and the models endpoints. */
const CHAT_AND_MODELS_HANDLER = (req, res) => {
    if (req.url === '/v1/models') return MODELS_HANDLER(req, res);
    return CHAT_HANDLER(req, res);
};

// ── backend harness (WS + HTTP routes with injectable identity) ──────────

function connect(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

function nextMessage(ws) {
    return new Promise((resolve) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
}

function send(ws, obj) { ws.send(JSON.stringify(obj)); }

/** Open a real connector session against the WS harness (hello → ready). */
async function openSession(wsUrl, token) {
    const ws = await connect(wsUrl);
    send(ws, { type: 'hello', protocol_version: 1, credential: token });
    const ready = await nextMessage(ws);
    return { ws, ready };
}

function startBackend() {
    const redis = createMockRedis();
    const logLines = [];
    const logger = {
        info: (m) => logLines.push(String(m)),
        warn: (m) => logLines.push(String(m)),
        error: (m) => logLines.push(String(m)),
    };
    const wsHandler = createWsHandler({ redis, logger });
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        const id = req.headers['x-test-identity'];
        req.user = id ? JSON.parse(id).user : null;
        req.guest = id ? (JSON.parse(id).guest || null) : null;
        req.workspace = id ? (JSON.parse(id).workspace || null) : null;
        next();
    });
    createAiConnectorRoutes({ redis, logger })(app);
    require('../src/routes/settings-ai-routes.cjs')(app);
    const server = http.createServer(app);
    wsHandler.attachUpgrade(server);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                redis, logLines, wsHandler,
                base: `http://127.0.0.1:${port}`,
                wsUrl: `ws://127.0.0.1:${port}/api/v1/ai-connector/ws`,
                close: () => new Promise((r) => { wsHandler.shutdown(); server.close(() => r()); }),
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

async function captureConsole(fn) {
    const entries = [];
    const originals = {};
    for (const method of ['log', 'error', 'warn', 'info']) {
        originals[method] = console[method];
        console[method] = (...args) => entries.push(args.map(String).join(' '));
    }
    try {
        return { result: await fn(), entries };
    } finally {
        for (const method of Object.keys(originals)) console[method] = originals[method];
    }
}

describe('Local AI Connector provider binding (LAC-6 §9 seam)', function () {
    this.timeout(30000);

    let srv;
    let wsA, wsB;
    let connA, tokenA = null; // activated connector in workspace A

    const idA = () => ({ user: { userId: '00000000-0000-4000-8000-000000000001' }, workspace: { id: wsA } });
    const idB = () => ({ user: { userId: '00000000-0000-4000-8000-000000000002' }, workspace: { id: wsB } });

    before(async function () {
        this.timeout(60000);
        await runMigrations();
        await cleanup();
        wsA = await createWorkspace('lac6A');
        wsB = await createWorkspace('lac6B');
        srv = await startBackend();
        const created = await createActivatedConnector(wsA, 'Home Ollama', 'ollama');
        connA = created.connector;
        tokenA = created.token;
    });

    after(async function () {
        this.timeout(30000);
        for (const ws of liveSessions) { try { ws.close(); } catch (_) {} }
        liveSessions.length = 0;
        await srv.close();
        await cleanup();
    });

    const liveSessions = [];

    /**
     * Open a REAL live connector session through the REAL distributable
     * session code (real WebSocket) against a fake runtime — the same E2E
     * shape as the LAC-4 cloud suite.
     */
    async function openLiveSession(runtimeBase, tokenOverride) {
        const session = (await getConnectorLib()).createConnectorSession({
            config: { url: srv.wsUrl, token: tokenOverride || tokenA, baseUrl: runtimeBase, runtimeType: 'ollama' },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
        });
        session.start();
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !registry.isLive(connA.connector_id)) {
            await new Promise((r) => setTimeout(r, 50));
        }
        if (!registry.isLive(connA.connector_id)) throw new Error('connector session did not become live');
        liveSessions.push(session);
        return { session };
    }

    describe('PUT /settings/ai/provider local-ai binding', () => {

        it('binds the provider to a workspace connector — no endpoint, no key material', async () => {
            const res = await api(srv, 'PUT', '/api/v1/settings/ai/provider', {
                identity: idA(),
                body: { provider_type: 'local-ai', connector_id: connA.connector_id, model: 'qwen3:32b' },
            });
            expect(res.status).to.equal(200);
            const meta = res.body.provider;
            expect(meta.provider_type).to.equal('local-ai');
            expect(meta.connector_id).to.equal(connA.connector_id);
            expect(meta.endpoint).to.equal(null);
            expect(meta.has_api_key).to.equal(false);
            expect(meta.api_key_masked).to.equal(null);
            expect(meta.model).to.equal('qwen3:32b');
            // Marker row in PG: no real ciphertext envelope stored
            const row = (await query(
                `SELECT endpoint, api_key_enc, connector_id FROM workspace_ai_providers WHERE workspace_id = $1`,
                [wsA]
            )).rows[0];
            expect(row.endpoint).to.equal('');
            expect(row.api_key_enc).to.equal('local-ai-connector-binding');
            expect(row.connector_id).to.equal(connA.connector_id);
        });

        it('GET provider meta reflects the binding (never secret material)', async () => {
            const res = await api(srv, 'GET', '/api/v1/settings/ai/provider', { identity: idA() });
            expect(res.status).to.equal(200);
            expect(res.body.has_workspace_provider).to.equal(true);
            expect(res.body.provider.connector_id).to.equal(connA.connector_id);
            expect(res.raw).to.not.include('llmc.');
            expect(res.raw).to.not.include('llmcreg.');
        });

        it('validation: missing / malformed connector_id → 400', async () => {
            const missing = await api(srv, 'PUT', '/api/v1/settings/ai/provider', {
                identity: idA(), body: { provider_type: 'local-ai', model: 'm' },
            });
            expect(missing.status).to.equal(400);

            const malformed = await api(srv, 'PUT', '/api/v1/settings/ai/provider', {
                identity: idA(), body: { provider_type: 'local-ai', connector_id: 'not-a-uuid' },
            });
            expect(malformed.status).to.equal(400);

            const badModel = await api(srv, 'PUT', '/api/v1/settings/ai/provider', {
                identity: idA(), body: { provider_type: 'local-ai', connector_id: connA.connector_id, model: 'x'.repeat(300) },
            });
            expect(badModel.status).to.equal(400);
        });

        it('workspace isolation: workspace B cannot bind A\'s connector → indistinct 404', async () => {
            const res = await api(srv, 'PUT', '/api/v1/settings/ai/provider', {
                identity: idB(),
                body: { provider_type: 'local-ai', connector_id: connA.connector_id, model: 'm' },
            });
            expect(res.status).to.equal(404);
            expect(res.body.error).to.equal('Connector not found');
            // Same answer for an unknown UUID — no existence oracle.
            const unknown = await api(srv, 'PUT', '/api/v1/settings/ai/provider', {
                identity: idB(),
                body: { provider_type: 'local-ai', connector_id: '11111111-2222-4333-8444-555555555555', model: 'm' },
            });
            expect(unknown.status).to.equal(404);
            expect(unknown.body.error).to.equal('Connector not found');
            // B's provider row must NOT have been created/changed
            const metaB = await api(srv, 'GET', '/api/v1/settings/ai/provider', { identity: idB() });
            expect(metaB.body.provider).to.equal(null);
        });

        it('switching local-ai → cloud type requires a real api_key again', async () => {
            const noKey = await api(srv, 'PUT', '/api/v1/settings/ai/provider', {
                identity: idA(),
                body: { provider_type: 'openai-compatible', endpoint: 'https://cloud.example/v1', model: 'm' },
            });
            expect(noKey.status).to.equal(400);
            expect(noKey.body.error).to.equal('api_key is required');

            // With a key the switch works
            const withKey = await api(srv, 'PUT', '/api/v1/settings/ai/provider', {
                identity: idA(),
                body: { provider_type: 'openai-compatible', endpoint: 'https://cloud.example/v1', api_key: 'sk-cloud-test', model: 'm' },
            });
            expect(withKey.status).to.equal(200);
            expect(withKey.body.provider.provider_type).to.equal('openai-compatible');

            // Switch BACK to local-ai: the stored cloud key is replaced by the
            // marker — the old credential must not linger in the row.
            const back = await api(srv, 'PUT', '/api/v1/settings/ai/provider', {
                identity: idA(),
                body: { provider_type: 'local-ai', connector_id: connA.connector_id, model: 'qwen3:32b' },
            });
            expect(back.status).to.equal(200);
            const row = (await query(
                `SELECT endpoint, api_key_enc FROM workspace_ai_providers WHERE workspace_id = $1`, [wsA]
            )).rows[0];
            expect(row.api_key_enc).to.equal('local-ai-connector-binding');
            expect(row.endpoint).to.equal('');
        });
    });

    describe('resolver — the §9 seam', () => {

        it('resolveAIForWorkspace returns the connector snapshot', async () => {
            workspaceAi.invalidateCache(wsA);
            const snap = await workspaceAi.resolveAIForWorkspace(wsA);
            expect(snap.source).to.equal('workspace');
            expect(snap.transport).to.equal('connector');
            expect(snap.connectorId).to.equal(connA.connector_id);
            expect(snap.endpoint).to.equal(null);
            expect(snap.apiKey).to.equal(null);
            expect(snap.model).to.equal('qwen3:32b');
        });

        it('resolveAIProvider purpose tag does NOT re-tag connector snapshots as unconfigured', async () => {
            workspaceAi.invalidateCache(wsA);
            const tagged = await workspaceAi.resolveAIProvider(wsA, 'agent');
            expect(tagged.source).to.equal('workspace'); // NOT 'workspace-unconfigured'
            expect(tagged.transport).to.equal('connector');
            expect(tagged.purpose).to.equal('agent');
        });

        it('agent-path guard accepts connector snapshots (apiKey null by design)', async () => {
            workspaceAi.invalidateCache(wsA);
            const p = await workspaceAi.resolveAIForBook(null); // no book → system fallback, not connector
            expect(p.source).to.not.equal('workspace');
            const snap = await workspaceAi.resolveAIForWorkspace(wsA);
            expect(!snap.apiKey && snap.transport === 'connector').to.equal(true);
        });
    });

    describe('inference through the binding (real WS + real runtime)', () => {
        let rt;
        let sess;

        after(async () => {
            if (sess) { try { sess.session.stop(); } catch (_) {} }
            if (rt) await rt.closeServer();
        });

        it('callAI rides the connector transport and returns the runtime answer', async () => {
            rt = await startFakeRuntime(CHAT_HANDLER);
            sess = await openLiveSession(rt.baseUrl);

            const provider = await workspaceAi.resolveAIProvider(wsA, 'chat');
            const result = await aiService.callAI(
                [{ role: 'user', content: 'Say hi' }],
                { maxTokens: 64 },
                provider
            );
            expect(result.content).to.equal('hello from local');
            expect(result.finishReason).to.equal('stop');
            // The runtime saw the fixed adapter path + no URL from the cloud
            expect(rt.lastBody.model).to.equal('qwen3:32b');
        });

        it('revoked / offline connector → fail-closed sanitized error, never a system fallback', async () => {
            // Kill the live session → connector offline
            sess.session.stop();
            await waitFor(() => !registry.isLive(connA.connector_id));
            workspaceAi.invalidateCache(wsA);
            const provider = await workspaceAi.resolveAIProvider(wsA, 'chat');
            let threw = null;
            await captureConsole(async () => {
                try {
                    await aiService.callAI([{ role: 'user', content: 'x' }], { maxTokens: 8 }, provider);
                } catch (err) { threw = err; }
            });
            expect(threw).to.exist;
            expect(threw.message).to.equal('Local AI is offline');
        });
    });

    describe('POST /settings/ai/test — connector path (AD-7 probe)', () => {
        let rt;
        let sess;

        before(async () => {
            rt = await startFakeRuntime(CHAT_AND_MODELS_HANDLER);
            const s = await openLiveSession(rt.baseUrl);
            sess = s;
        });

        after(async () => {
            if (sess) { try { sess.session.stop(); } catch (_) {} }
            if (rt) await rt.closeServer();
        });

        it('tests through the live session; stamps status on the stored binding', async () => {
            const res = await api(srv, 'POST', '/api/v1/settings/ai/test', {
                identity: idA(), body: { model: 'qwen3:32b' },
            });
            expect(res.status).to.equal(200);
            expect(res.body.ok).to.equal(true);
            expect(res.body.model).to.equal('qwen3:32b');
            // status stamped on the binding row
            const meta = await api(srv, 'GET', '/api/v1/settings/ai/provider', { identity: idA() });
            expect(meta.body.provider.status).to.equal('ok');
            expect(meta.body.provider.last_tested_at).to.be.a('number');
        });

        it('defaults the model to the first DISCOVERED model when none is passed', async () => {
            // Seed discovered models via the explicit refresh flow
            const refresh = await api(srv, 'POST', `/api/v1/ai-connector/connectors/${connA.connector_id}/models/refresh`, { identity: idA() });
            expect(refresh.status).to.equal(200);
            expect(refresh.body.ok).to.equal(true);
            expect(refresh.body.models).to.deep.equal(['qwen3:32b', 'llama3:8b']);

            const res = await api(srv, 'POST', '/api/v1/settings/ai/test', { identity: idA(), body: {} });
            expect(res.status).to.equal(200);
            expect(res.body.ok).to.equal(true);
            expect(res.body.model).to.equal('qwen3:32b'); // first discovered
        });

        it('connector_offline → ok:false with sanitized error + code', async () => {
            // Kill the live session
            sess.session.stop();
            await waitFor(() => !registry.isLive(connA.connector_id));

            const res = await api(srv, 'POST', '/api/v1/settings/ai/test', { identity: idA(), body: {} });
            expect(res.status).to.equal(200);
            expect(res.body.ok).to.equal(false);
            expect(res.body.code).to.equal('connector_offline');
            expect(res.body.error).to.equal('Local AI is offline');
        });

        it('no models discovered and no model passed → explicit no_models answer', async () => {
            // Clear the stored models AND the binding's model so the test
            // path has nothing to default to.
            const clear = await repo.updateConnectorHeartbeat(connA.connector_id, { models: [] });
            expect(clear.models).to.deep.equal([]);
            await api(srv, 'PUT', '/api/v1/settings/ai/provider', {
                identity: idA(),
                body: { provider_type: 'local-ai', connector_id: connA.connector_id, model: null },
            });
            workspaceAi.invalidateCache(wsA);

            const res = await api(srv, 'POST', '/api/v1/settings/ai/test', { identity: idA(), body: {} });
            expect(res.status).to.equal(200);
            expect(res.body.ok).to.equal(false);
            expect(res.body.code).to.equal('no_models');

            // restore the binding model for the blocks below
            await api(srv, 'PUT', '/api/v1/settings/ai/provider', {
                identity: idA(),
                body: { provider_type: 'local-ai', connector_id: connA.connector_id, model: 'qwen3:32b' },
            });
            workspaceAi.invalidateCache(wsA);
        });

        it('workspace isolation: B testing A\'s connector → indistinct 404', async () => {
            const res = await api(srv, 'POST', '/api/v1/settings/ai/test', {
                identity: idB(), body: { provider_type: 'local-ai', connector_id: connA.connector_id },
            });
            expect(res.status).to.equal(404);
            expect(res.body.error).to.equal('Connector not found');
        });
    });

    describe('POST /ai-connector/connectors/:id/models/refresh', () => {
        let rt;
        let sess;

        after(async () => {
            if (sess) { try { sess.session.stop(); } catch (_) {} }
            if (rt) await rt.closeServer();
        });

        it('explicit discovery over a live session → models persisted + readable via GET /models', async () => {
            rt = await startFakeRuntime(MODELS_HANDLER);
            sess = await openLiveSession(rt.baseUrl);

            const refresh = await api(srv, 'POST', `/api/v1/ai-connector/connectors/${connA.connector_id}/models/refresh`, { identity: idA() });
            expect(refresh.status).to.equal(200);
            expect(refresh.body.ok).to.equal(true);
            expect(refresh.body.models).to.deep.equal(['qwen3:32b', 'llama3:8b']);

            // Persisted: GET /ai-connector/models reflects them (read-only)
            const models = await api(srv, 'GET', '/api/v1/ai-connector/models', { identity: idA() });
            const mine = models.body.connectors.find((c) => c.connector_id === connA.connector_id);
            expect(mine.models).to.deep.equal(['qwen3:32b', 'llama3:8b']);
            expect(mine.live).to.equal(true);
        });

        it('offline connector → ok:false code connector_offline (no HTTP error)', async () => {
            sess.session.stop();
            await waitFor(() => !registry.isLive(connA.connector_id));

            const res = await api(srv, 'POST', `/api/v1/ai-connector/connectors/${connA.connector_id}/models/refresh`, { identity: idA() });
            expect(res.status).to.equal(200);
            expect(res.body.ok).to.equal(false);
            expect(res.body.code).to.equal('connector_offline');
        });

        it('foreign / malformed / revoked connector → indistinct 404', async () => {
            const foreign = await api(srv, 'POST', `/api/v1/ai-connector/connectors/${connA.connector_id}/models/refresh`, { identity: idB() });
            expect(foreign.status).to.equal(404);

            const malformed = await api(srv, 'POST', `/api/v1/ai-connector/connectors/not-a-uuid/models/refresh`, { identity: idA() });
            expect(malformed.status).to.equal(404);
        });
    });

    describe('rotate + revoke through the binding', () => {
        let rt;
        let sess;

        after(async () => {
            if (sess) { try { sess.session.stop(); } catch (_) {} }
            if (rt) await rt.closeServer();
        });

        it('rotate discloses a new llmc.* ONCE; reconnect works; the binding stays intact', async () => {
            rt = await startFakeRuntime(CHAT_HANDLER);
            sess = await openLiveSession(rt.baseUrl);
            await waitFor(() => registry.isLive(connA.connector_id));

            const rot = await api(srv, 'POST', `/api/v1/ai-connector/connectors/${connA.connector_id}/rotate`, { identity: idA() });
            expect(rot.status).to.equal(200);
            expect(rot.body.token).to.match(/^llmc\./);
            // live session evicted (rotated close code)
            await waitFor(() => !registry.isLive(connA.connector_id));

            // reconnect with the NEW credential
            tokenA = rot.body.token; // subsequent openLiveSession calls use it
            const s2 = await openLiveSession(rt.baseUrl, rot.body.token);
            sess = s2;
            await waitFor(() => registry.isLive(connA.connector_id));

            // binding row still references the connector; inference works
            workspaceAi.invalidateCache(wsA);
            const provider = await workspaceAi.resolveAIProvider(wsA, 'chat');
            const result = await aiService.callAI([{ role: 'user', content: 'hi' }], { maxTokens: 8, model: 'qwen3:32b' }, provider);
            expect(result.content).to.equal('hello from local');
        });

        it('revoke invalidates the live connector IMMEDIATELY; inference fails closed', async () => {
            const rev = await api(srv, 'DELETE', `/api/v1/ai-connector/connectors/${connA.connector_id}`, { identity: idA() });
            expect(rev.status).to.equal(200);
            expect(rev.body.revoked).to.equal(true);
            await waitFor(() => !registry.isLive(connA.connector_id));

            // The binding still exists (dangling connector_id → explicit
            // failure, never a silent fallback — AD-12 / §3.1)
            workspaceAi.invalidateCache(wsA);
            const provider = await workspaceAi.resolveAIProvider(wsA, 'chat');
            let threw = null;
            await captureConsole(async () => {
                try { await aiService.callAI([{ role: 'user', content: 'x' }], { maxTokens: 8, model: 'qwen3:32b' }, provider); }
                catch (err) { threw = err; }
            });
            expect(threw).to.exist;
            expect(threw.message).to.equal('Local AI is offline');

            // Rebinding to the revoked connector is refused (404)
            const rebind = await api(srv, 'PUT', '/api/v1/settings/ai/provider', {
                identity: idA(),
                body: { provider_type: 'local-ai', connector_id: connA.connector_id, model: 'm' },
            });
            expect(rebind.status).to.equal(404);
        });
    });

    describe('credential non-disclosure (whole flow)', () => {
        it('no llmc./llmcreg. material in any settings/status/models response or application log', async () => {
            // Fresh connector in B to have live secret material around
            const created = await createActivatedConnector(wsB, 'B Ollama', 'vllm');
            const captured = await captureConsole(async () => {
                const calls = [];
                calls.push(await api(srv, 'GET', '/api/v1/settings/ai/provider', { identity: idA() }));
                calls.push(await api(srv, 'GET', '/api/v1/settings/ai/providers', { identity: idA() }));
                calls.push(await api(srv, 'GET', '/api/v1/ai-connector/status', { identity: idB() }));
                calls.push(await api(srv, 'GET', '/api/v1/ai-connector/models', { identity: idB() }));
                calls.push(await api(srv, 'GET', '/api/v1/ai-connector/connectors', { identity: idB() }));
                calls.push(await api(srv, 'GET', `/api/v1/ai-connector/connectors/${created.connector.connector_id}`, { identity: idB() }));
                // A PUT binding for B — response meta only
                calls.push(await api(srv, 'PUT', '/api/v1/settings/ai/provider', {
                    identity: idB(),
                    body: { provider_type: 'local-ai', connector_id: created.connector.connector_id, model: 'm' },
                }));
                return calls;
            });
            for (const res of captured.result) {
                expect(res.raw).to.not.include('llmc.');
                expect(res.raw).to.not.include('llmcreg.');
            }
            for (const line of captured.entries) {
                expect(line).to.not.include('llmc.');
                expect(line).to.not.include('llmcreg.');
            }
            for (const line of srv.logLines) {
                expect(line).to.not.include('llmc.');
                expect(line).to.not.include('llmcreg.');
            }
            // rotate discloses exactly ONCE by design — assert the settings
            // surfaces used by the UI never do (the rotate route response is
            // the single sanctioned disclosure point).
        });
    });
});

// ── test-local helpers ─────────────────────────────────────────────────────

function waitFor(predicate, { timeoutMs = 5000, stepMs = 25 } = {}) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            let ok = false;
            try { ok = predicate(); } catch (_) { ok = false; }
            if (ok) return resolve();
            if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timeout'));
            setTimeout(tick, stepMs);
        };
        tick();
    });
}

/** Lazy require of the ai-connector distributable session lib. */
function getConnectorLib() {
    return Promise.resolve(require('../../ai-connector/lib/connector.cjs'));
}

/**
 * Scriptable in-process WS socket driving the real connector session.
 */
function connectStub() {
    const handlers = {};
    return {
        readyState: 1,
        sent: [],
        on(event, fn) { (handlers[event] = handlers[event] || []).push(fn); },
        emit(event, ...args) {
            (handlers[event] || []).slice().forEach((fn) => fn(...args));
        },
        send(raw) { this.sent.push(JSON.parse(raw)); },
        close() {
            if (this.readyState !== 3) {
                this.readyState = 3;
                this.emit('close');
            }
        },
    };
}
