// ======================================================
// LLM Sharing Phase 2 - Model Propagation Hardening
// ======================================================
// Proves the "requested model" contract is preserved across the FULL consumer
// flow:  chat request -> resolveChatAI -> resolveAIForWorkspace -> selectSharedAI
//        -> shared-pool -> transport -> connector -> runtime.
//
// Coverage matrix (task brief 3):
//   1.  Consumer requests model-A; ep1 has model-B, ep2 has model-A -> ep2 selected
//   2.  Consumer requests model-A; no endpoint has it -> shared not used
//   3.  Consumer omits model -> endpoint.model -> first discovered (precedence)
//   4.  Selected model arrives at runtime (non-streaming)
//   5.  Streaming request preserves model through the full path
//   6.  Private Local AI flow unchanged
//   7.  Cloud provider flow unchanged
//   8.  Shared fallback: private unavailable -> shared; requested model preserved
//   9.  Workspace isolation / owner exclusion intact
//  10.  Credentials / runtime URL never leak on any surface
//  11.  Slot lifecycle: model propagation doesn't break reserve/release
//  12.  Concurrency: model propagates correctly under concurrent load
//
// No production code changes - only regression tests.
// Real connector sessions (distributable session lib) over real WebSockets
// against fake OpenAI-compatible local runtimes (same E2E shape as LAC suites).

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
const aiService = require('../src/services/ai-service');
const { createWsHandler, createAiConnectorRoutes } = require('../src/routes/ai-connector-routes.cjs');
const { createAiEndpointRoutes } = require('../src/routes/ai-endpoint-routes.cjs');
const { createMockRedis } = require('./mocks/redis-mock');
const { createConnectorSession } = require('../../ai-connector/lib/connector.cjs');

const stamp = `mprop${Date.now()}`;

//  fixtures 

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

async function createBook(bookId, workspaceId) {
    await query(`INSERT INTO books (book_id, workspace_id) VALUES ($1, $2)`, [bookId, workspaceId]);
}

async function cleanup() {
    await query(`DELETE FROM ai_chat_sessions WHERE book_id LIKE 'mprop-${stamp}%'`);
    await query(`DELETE FROM books WHERE book_id LIKE 'mprop-${stamp}%'`);
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

async function stampHeartbeat(connectorId, { runtimeOk = true, models = ['qwen3:32b'] } = {}) {
    await connectorRepo.updateConnectorHeartbeat(connectorId, {
        status: 'online',
        models,
        runtimeMeta: { runtime_ok: runtimeOk },
    });
}

async function shareEndpoint(endpointId, workspaceId, { concurrencyLimit } = {}) {
    const res = await endpointRepo.setSharing(endpointId, workspaceId, {
        enabled: true,
        ...(concurrencyLimit ? { concurrencyLimit } : {}),
    });
    if (!res.ok) throw new Error(`share failed: ${res.reason}`);
}

//  fake local runtimes 

function startFakeRuntime(handler) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            server.requests.push({ method: req.method, path: req.url, at: Date.now() });
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                try { server.lastBody = body ? JSON.parse(body) : null; } catch (_) {}
                server.currentHandler(req, res, server);
            });
        });
        server.requests = [];
        server.currentHandler = handler;
        server.listen(0, '127.0.0.1', () => {
            server.port = server.address().port;
            server.baseUrl = `http://127.0.0.1:${server.port}`;
            server.closeServer = (() => {
                const orig = server.close.bind(server);
                return () => new Promise((r) => {
                    try { server.closeAllConnections?.(); } catch (_) {}
                    orig(() => r());
                });
            })();
            resolve(server);
        });
    });
}

const chatJson = (content, model = 'test-model') => JSON.stringify({
    id: 'cmpl-1', object: 'chat.completion', created: 1700000000,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
});

const CHAT_HANDLER = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(chatJson('ok'));
};

const STREAM_HANDLER = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (content) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
    res.write(chunk('Hello '));
    setTimeout(() => res.write(chunk('shared ')), 10);
    setTimeout(() => {
        res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    }, 20);
};

const DELAYED_HANDLER = (delayMs, content = 'slow') => (req, res) => {
    setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(chatJson(content));
    }, delayMs);
};

//  backend harness 

function startBackend() {
    const redis = createMockRedis();
    const logLines = [];
    const logger = {
        info: (m) => logLines.push(String(m)),
        warn: (m) => logLines.push(String(m)),
        error: (m) => logLines.push(String(m)),
    };
    const wsHandler = createWsHandler({ redis, logger });
    const config = require('../src/config/runtime-config');
    const chatEngine = require('../src/services/chat-engine.cjs')(config);
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
    createAiEndpointRoutes({ logger })(app);
    require('../src/routes/settings-ai-routes.cjs')(app);
    require('../src/routes/ai-routes.cjs')(app, null, {
        config,
        state: {}, audio: {}, image: {}, video: {},
        book: { loadBook: () => null },
        orchestrator: {}, storage: { postgres: { query } },
        layerConfig: {}, genScope: {}, activeScenes: {}, placeholderAudio: {},
        utils: { log: () => {} },
        saveChunk: async () => {}, getChunk: async () => null, getAllChunks: async () => [],
        getBookWindowStatus: () => null,
        detectAvailableMode: async () => 'chat',
        recoverChunksFromDisk: async () => {}, recoverAllBooksFromDisk: async () => {},
        cleanupService: {}, bookDiff: {}, taskHandler: {},
        chatEngine,
        iuRepo: {}, genSessionRepo: null,
        lazyBook: { loadDraftBook: () => null },
        txtImporter: {}, bookSourceRepo: {},
    });
    const server = http.createServer(app);
    wsHandler.attachUpgrade(server);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                redis, logLines,
                base: `http://127.0.0.1:${port}`,
                wsUrl: `ws://127.0.0.1:${port}/api/v1/ai-connector/ws`,
                close: () => new Promise((r) => { wsHandler.shutdown(); server.close(() => r()); }),
            });
        });
    });
}

function identityHeaders({ user, workspace } = {}) {
    return {
        'Content-Type': 'application/json',
        'x-test-identity': JSON.stringify({ user, workspace }),
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

function waitFor(predicate, { timeoutMs = 8000, stepMs = 25 } = {}) {
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

function inflightCount() {
    const stats = sharedPool.stats().inflight;
    return Object.values(stats).reduce((a, b) => a + b, 0);
}

// 

describe('LLM Sharing Phase 2 - model propagation hardening', function () {
    this.timeout(40000);

    let srv;
    let wsA, wsB, wsC;
    let userA, userB, userC;
    let connA1, connA2;
    let ep1, ep2;
    let rt1, rt2;
    let sess1, sess2;
    let tokenA1, tokenA2;
    const liveSessions = [];

    const idB = () => ({ user: { userId: userB }, workspace: { id: wsB } });
    const idC = () => ({ user: { userId: userC }, workspace: { id: wsC } });

    async function setFixturesEnabled(enabled) {
        await endpointRepo.updateEndpoint(ep1.endpoint_id, wsA, { enabled });
        await endpointRepo.updateEndpoint(ep2.endpoint_id, wsA, { enabled });
    }

    async function openLiveSession(connector, token, runtimeBase) {
        const session = createConnectorSession({
            config: { url: srv.wsUrl, token, baseUrl: runtimeBase, runtimeType: 'ollama' },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
        });
        session.start();
        await waitFor(() => registry.isLive(connector.connector_id));
        liveSessions.push(session);
        return session;
    }

    before(async function () {
        this.timeout(90000);
        await runMigrations();
        await cleanup();
        userA = await createUser('mpu_a');
        userB = await createUser('mpu_b');
        userC = await createUser('mpu_c');
        wsA = await createWorkspace('mpA'); // owner
        wsB = await createWorkspace('mpB'); // consumer
        wsC = await createWorkspace('mpC'); // consumer
        srv = await startBackend();

        const c1 = await createActivatedConnector(wsA, 'Home Qwen', 'ollama');
        const c2 = await createActivatedConnector(wsA, 'Home Llama', 'vllm');
        connA1 = c1.connector;
        connA2 = c2.connector;
        tokenA1 = c1.token;
        tokenA2 = c2.token;

        rt1 = await startFakeRuntime(CHAT_HANDLER);
        rt2 = await startFakeRuntime(CHAT_HANDLER);
        sess1 = await openLiveSession(connA1, tokenA1, rt1.baseUrl);
        sess2 = await openLiveSession(connA2, tokenA2, rt2.baseUrl);
        // ep1 connector has qwen3:32b; ep2 connector has llama3:70b
        await stampHeartbeat(connA1.connector_id, { models: ['qwen3:32b'] });
        await stampHeartbeat(connA2.connector_id, { models: ['llama3:70b'] });

        // ep1 configured model = qwen3:32b; ep2 configured model = llama3:70b
        ep1 = (await endpointRepo.createEndpoint({
            workspaceId: wsA, connectorId: connA1.connector_id,
            name: 'Qwen Endpoint', runtimeType: 'ollama', model: 'qwen3:32b',
        })).endpoint;
        ep2 = (await endpointRepo.createEndpoint({
            workspaceId: wsA, connectorId: connA2.connector_id,
            name: 'Llama Endpoint', runtimeType: 'vllm', model: 'llama3:70b',
        })).endpoint;
        await shareEndpoint(ep1.endpoint_id, wsA);
        await shareEndpoint(ep2.endpoint_id, wsA);
    });

    after(async function () {
        this.timeout(30000);
        for (const s of liveSessions) { try { s.stop(); } catch (_) {} }
        liveSessions.length = 0;
        sharedPool.resetForTests();
        if (rt1) await rt1.closeServer();
        if (rt2) await rt2.closeServer();
        await srv.close();
        await cleanup();
    });

    beforeEach(function () {
        sharedPool.resetForTests();
        workspaceAi.invalidateCache(wsB);
        workspaceAi.invalidateCache(wsC);
    });

    //  1. Requested model -> correct endpoint 

    it('1. consumer requests model-A; ep1 has model-B, ep2 has model-A -> ep2 selected', async () => {
        // ep1 connector discovered: qwen3:32b (configured model: qwen3:32b)
        // ep2 connector discovered: llama3:70b (configured model: llama3:70b)
        // Consumer requests llama3:70b -> ep2 is the only eligible endpoint.
        const snap = await workspaceAi.resolveAIForWorkspace(wsB, { model: 'llama3:70b' });
        expect(snap.source).to.equal('shared');
        expect(snap.shared.endpointId).to.equal(ep2.endpoint_id);
        expect(snap.model).to.equal('llama3:70b');
    });

    it('1b. consumer requests qwen3:32b -> ep1 selected', async () => {
        const snap = await workspaceAi.resolveAIForWorkspace(wsB, { model: 'qwen3:32b' });
        expect(snap.source).to.equal('shared');
        expect(snap.shared.endpointId).to.equal(ep1.endpoint_id);
        expect(snap.model).to.equal('qwen3:32b');
    });

    //  2. Requested model absent -> shared not used 

    it('2. consumer requests model not in any discovered list -> shared AI not used', async () => {
        const snap = await workspaceAi.resolveAIForWorkspace(wsB, { model: 'nonexistent:99b' });
        expect(snap.source).to.not.equal('shared');
        // Direct pool check: selectSharedAI returns null.
        const poolResult = await sharedPool.selectSharedAI({ workspaceId: wsB, model: 'nonexistent:99b' });
        expect(poolResult).to.equal(null);
    });

    //  3. No model requested -> endpoint.model -> first discovered 

    it('3. consumer omits model -> endpoint.model wins (qwen3:32b from ep1, the first eligible)', async () => {
        const snap = await workspaceAi.resolveAIForWorkspace(wsB);
        expect(snap.source).to.equal('shared');
        // ep1 is first in stable order (created_at ASC, endpoint_id ASC).
        // ep1 configured model = qwen3:32b, which IS in its discovered list.
        expect(snap.shared.endpointId).to.equal(ep1.endpoint_id);
        expect(snap.model).to.equal('qwen3:32b');
    });

    //  4. Selected model arrives at runtime (non-streaming) 

    it('4. selected model reaches the runtime HTTP request (non-streaming path)', async () => {
        // Use rt2 which has a CHAT_HANDLER - it receives the model in the body.
        const saved = rt2.currentHandler;
        rt2.currentHandler = (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(chatJson('model-check-ok', rt2.lastBody?.model || 'unknown'));
        };
        try {
            const snap = await workspaceAi.resolveAIForWorkspace(wsB, { model: 'llama3:70b' });
            expect(snap.model).to.equal('llama3:70b');
            expect(snap.shared.endpointId).to.equal(ep2.endpoint_id);

            const result = await aiService.callAI(
                [{ role: 'user', content: 'hi' }], { maxTokens: 32, model: 'llama3:70b' }, snap
            );
            expect(result.content).to.equal('model-check-ok');
            // rt2 serves ep2 (llama3:70b) - the model in the HTTP body must match.
            expect(rt2.lastBody.model).to.equal('llama3:70b');
        } finally {
            rt2.currentHandler = saved;
        }
    });

    it('4b. wrong model never reaches the runtime - qwen request does not go to llama endpoint', async () => {
        // Request qwen3:32b -> ep1 selected, rt1 serves ep1.
        rt2.requests.length = 0; // clear requests from prior test
        const saved = rt1.currentHandler;
        rt1.currentHandler = (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(chatJson('qwen-ok', rt1.lastBody?.model || 'unknown'));
        };
        try {
            const snap = await workspaceAi.resolveAIForWorkspace(wsB, { model: 'qwen3:32b' });
            expect(snap.shared.endpointId).to.equal(ep1.endpoint_id);
            expect(snap.model).to.equal('qwen3:32b');

            await aiService.callAI(
                [{ role: 'user', content: 'hi' }], { maxTokens: 32, model: 'qwen3:32b' }, snap
            );
            expect(rt1.lastBody.model).to.equal('qwen3:32b');
            // rt2 (llama endpoint) was never touched.
            expect(rt2.requests.length).to.equal(0);
        } finally {
            rt1.currentHandler = saved;
        }
    });

    //  5. Streaming preserves model 

    it('5. streaming request with model-A preserves model-A through the full path', async () => {
        const saved = rt1.currentHandler;
        rt1.currentHandler = STREAM_HANDLER;
        try {
            const snap = await workspaceAi.resolveAIForWorkspace(wsB, { model: 'qwen3:32b' });
            expect(snap.model).to.equal('qwen3:32b');
            expect(snap.shared.endpointId).to.equal(ep1.endpoint_id);

            const deltas = [];
            const result = await aiService.callAIStream(
                [{ role: 'user', content: 'hi' }],
                { maxTokens: 64, model: 'qwen3:32b' },
                snap,
                { onDelta: (d) => deltas.push(d) }
            );
            expect(result.content).to.equal('Hello shared ');
            expect(deltas.length).to.be.greaterThan(0);
            // Model propagates through the snapshot - the streaming path
            // uses the same runSharedInference -> connectorChat -> frame.model.
            // The connector sends the model to the runtime; rt1.lastBody
            // captures the runtime's HTTP request body.
            expect(rt1.lastBody.model).to.equal('qwen3:32b');
        } finally {
            rt1.currentHandler = saved;
        }
    });

    //  6. Private Local AI flow unchanged 

    it('6. private local AI binding uses its own model - pool is not involved', async () => {
        await workspaceAi.upsertProvider(wsB, {
            providerType: 'local-ai', connectorId: connA2.connector_id, model: 'llama3:70b',
        });
        try {
            const snap = await workspaceAi.resolveAIForWorkspace(wsB);
            expect(snap.source).to.equal('workspace');
            expect(snap.transport).to.equal('connector');
            expect(snap.model).to.equal('llama3:70b');
            expect(snap.shared).to.equal(undefined); // no pool involvement

            const saved = rt2.currentHandler;
            rt2.currentHandler = (req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(chatJson('private-ok', rt2.lastBody?.model || 'unknown'));
            };
            try {
                const result = await aiService.callAI(
                    [{ role: 'user', content: 'hi' }], { maxTokens: 32 }, snap
                );
                expect(result.content).to.equal('private-ok');
                expect(rt2.lastBody.model).to.equal('llama3:70b');
            } finally {
                rt2.currentHandler = saved;
            }
        } finally {
            await workspaceAi.deleteProvider(wsB);
        }
    });

    //  7. Cloud provider flow unchanged 

    it('7. cloud provider snapshot carries its own model - pool is not consulted', async () => {
        await workspaceAi.upsertProvider(wsC, {
            providerType: 'openai-compatible',
            endpoint: 'https://cloud.example/v1',
            apiKey: 'sk-test',
            model: 'cloud-model-v2',
        });
        try {
            const snap = await workspaceAi.resolveAIForWorkspace(wsC);
            expect(snap.source).to.equal('workspace');
            expect(snap.model).to.equal('cloud-model-v2');
            expect(snap.endpoint).to.equal('https://cloud.example/v1');
            expect(snap.shared).to.equal(undefined);
            expect(inflightCount()).to.equal(0);
        } finally {
            await workspaceAi.deleteProvider(wsC);
        }
    });

    //  8. Shared fallback: private unavailable -> shared; model preserved 

    it('8. private provider unavailable -> shared fallback; requested model preserved', async () => {
        // wsB has no provider row -> shared pool selected.
        // Consumer requests llama3:70b -> ep2 (llama3:70b) is selected.
        const snap = await workspaceAi.resolveAIForWorkspace(wsB, { model: 'llama3:70b' });
        expect(snap.source).to.equal('shared');
        expect(snap.model).to.equal('llama3:70b');
        expect(snap.shared.endpointId).to.equal(ep2.endpoint_id);

        // Verify the model reaches the runtime through callAI.
        const saved = rt2.currentHandler;
        rt2.currentHandler = (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(chatJson('fallback-ok', rt2.lastBody?.model || 'unknown'));
        };
        try {
            const result = await aiService.callAI(
                [{ role: 'user', content: 'hi' }], { maxTokens: 32, model: 'llama3:70b' }, snap
            );
            expect(result.content).to.equal('fallback-ok');
            expect(rt2.lastBody.model).to.equal('llama3:70b');
        } finally {
            rt2.currentHandler = saved;
        }
    });

    //  9. Workspace isolation / owner exclusion 

    it('9. workspace isolation - owner excluded from own pool; consumers see correct workspaceId', async () => {
        // Owner never gets their own endpoint through the pool.
        const ownerSnap = await sharedPool.selectSharedAI({ workspaceId: wsA });
        expect(ownerSnap).to.equal(null);
        const ownerResolver = await workspaceAi.resolveAIForWorkspace(wsA);
        expect(ownerResolver.source).to.not.equal('shared');

        // Consumer B gets its own workspaceId stamped on the snapshot.
        const snapB = await workspaceAi.resolveAIForWorkspace(wsB);
        expect(snapB.workspaceId).to.equal(wsB);
        expect(snapB.source).to.equal('shared');

        // Consumer C gets its own workspaceId.
        const snapC = await workspaceAi.resolveAIForWorkspace(wsC);
        expect(snapC.workspaceId).to.equal(wsC);
        expect(snapC.source).to.equal('shared');

        // B and C never see each other's provider metadata.
        expect(await workspaceAi.getProviderMeta(wsB)).to.equal(null);
        expect(await workspaceAi.getProviderMeta(wsC)).to.equal(null);
    });

    //  10. No credentials / runtime URL leakage 

    it('10. consumer snapshot, chat API response and settings response never leak secrets', async () => {
        const snap = await workspaceAi.resolveAIForWorkspace(wsB);
        const snapJson = JSON.stringify(snap);
        expect(snapJson).to.not.match(/https?:\/\//);
        expect(snapJson).to.not.match(/llmc\./);
        expect(snapJson).to.not.match(/llmcreg\./);
        expect(snapJson).to.not.include('token');
        expect(snap.endpoint).to.equal(null);
        expect(snap.apiKey).to.equal(null);

        // Chat API response carries source badge only - no endpoint/owner detail.
        const bookId = `mprop-${stamp}-chatB`;
        await createBook(bookId, wsB);
        const res = await api(srv, 'POST', '/api/v1/ai/chat', {
            identity: idB(),
            body: { book_id: bookId, message: 'hello', mode: 'chat' },
        });
        expect(res.status).to.equal(200);
        expect(res.body.ai_source).to.equal('shared');
        expect(res.raw).to.not.match(/https?:\/\//);
        expect(res.raw).to.not.match(/llmc\./);
        expect(res.raw).to.not.include('endpointId');

        // Settings response: availability hint only.
        const meta = await api(srv, 'GET', '/api/v1/settings/ai/provider', { identity: idC() });
        expect(meta.status).to.equal(200);
        expect(meta.body.shared_ai).to.deep.equal({ available: true });
        expect(meta.raw).to.not.include('Shared Qwen');
        expect(meta.raw).to.not.match(/llmc\./);
    });

    //  11. Slot lifecycle: model propagation doesn't break reserve/release 

    it('11. model propagation does not break the slot lifecycle - slot released on success', async () => {
        const snap = await workspaceAi.resolveAIForWorkspace(wsB, { model: 'qwen3:32b' });
        expect(snap.model).to.equal('qwen3:32b');
        expect(inflightCount()).to.equal(0);

        const saved = rt1.currentHandler;
        rt1.currentHandler = (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(chatJson('slot-ok', rt1.lastBody?.model || 'unknown'));
        };
        try {
            const result = await aiService.callAI(
                [{ role: 'user', content: 'x' }], { maxTokens: 8, model: 'qwen3:32b' }, snap
            );
            expect(result.content).to.equal('slot-ok');
            expect(rt1.lastBody.model).to.equal('qwen3:32b');
            expect(inflightCount()).to.equal(0); // slot released
        } finally {
            rt1.currentHandler = saved;
        }
    });

    //  12. Concurrency: model propagates correctly under concurrent load 

    it('12. concurrent requests with different models select correct endpoints and release slots', async () => {
        const saved1 = rt1.currentHandler;
        const saved2 = rt2.currentHandler;
        rt1.currentHandler = DELAYED_HANDLER(300, 'qwen-reply');
        rt2.currentHandler = DELAYED_HANDLER(300, 'llama-reply');
        try {
            // Launch two concurrent requests with different models.
            const snapQwen = await workspaceAi.resolveAIForWorkspace(wsB, { model: 'qwen3:32b' });
            const snapLlama = await workspaceAi.resolveAIForWorkspace(wsC, { model: 'llama3:70b' });
            expect(snapQwen.model).to.equal('qwen3:32b');
            expect(snapQwen.shared.endpointId).to.equal(ep1.endpoint_id);
            expect(snapLlama.model).to.equal('llama3:70b');
            expect(snapLlama.shared.endpointId).to.equal(ep2.endpoint_id);

            const [r1, r2] = await Promise.all([
                aiService.callAI([{ role: 'user', content: 'a' }], { maxTokens: 8, model: 'qwen3:32b' }, snapQwen),
                aiService.callAI([{ role: 'user', content: 'b' }], { maxTokens: 8, model: 'llama3:70b' }, snapLlama),
            ]);
            expect(r1.content).to.equal('qwen-reply');
            expect(r2.content).to.equal('llama-reply');
            expect(rt1.lastBody.model).to.equal('qwen3:32b');
            expect(rt2.lastBody.model).to.equal('llama3:70b');
            expect(inflightCount()).to.equal(0); // all slots released
        } finally {
            rt1.currentHandler = saved1;
            rt2.currentHandler = saved2;
        }
    });
});
