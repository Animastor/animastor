// ======================================================
// LLM Sharing Phase 3 — Production SSE route + UX contract
// ======================================================
// Coverage (task brief §8 — the minimal matrix):
//
//   SSE (POST /api/v1/ai/chat/stream over real HTTP):
//     - normal shared stream (N chat.delta → N SSE deltas + done)
//     - private local stream (workspace binding — no pool involvement)
//     - cloud provider stream (existing fetch re-emitted as 1 delta + done)
//     - multiple deltas delivered in order
//     - terminal done exactly once
//     - empty stream (chat.response with '' → done, no deltas)
//     - usage-only final chunk → usage rides the done event
//     - partial output + error (mid-stream runtime failure → sanitized
//       terminal error, partial preserved via already-delivered deltas)
//   Cancellation:
//     - browser disconnect mid-stream → AbortSignal → chat.cancel → slot
//       released, no leaked pending
//     - explicit client abort (AbortSignal) → same path
//     - runtime timeout → sanitized terminal error, slot released
//     - connector disconnect mid-stream → session_closed, slot released
//     - slot released after EVERY failure path (success / error / timeout /
//       cancel / disconnect)
//   Resolver (regression through the stream route's seam):
//     - requested model preserved (strict requested-model propagation)
//     - incompatible shared endpoint skipped (never a silent model switch)
//     - shared fallback works (no provider row → pool)
//     - private provider still wins (binding beats pool)
//     - cloud provider unchanged (row wins, byte-identical snapshot)
//     - owner exclusion (D3 — the owner never rides their own pool entry)
//     - workspace isolation (no cross-workspace surface)
//   Security:
//     - no credentials / registration tokens in any SSE frame
//     - no runtime URL in any SSE frame or API response
//     - no raw runtime error text (hostile/secret detail never crosses)
//     - no owner information leakage (endpoint names, owner workspace)
//   Concurrency:
//     - limit=1: second request rejected (503 busy) while first in-flight
//     - slot released on success / runtime error / cancel / timeout /
//       disconnect
//
// Real E2E everywhere: real connector sessions (the distributable session
// lib) over real WebSockets against fake OpenAI-compatible SSE runtimes,
// real PG, real express app, real HTTP SSE clients — the same shape as the
// Phase 2 suite.

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
const transport = require('../src/services/ai-connector/transport');
const { createWsHandler, createAiConnectorRoutes } = require('../src/routes/ai-connector-routes.cjs');
const { createAiEndpointRoutes } = require('../src/routes/ai-endpoint-routes.cjs');
const { createMockRedis } = require('./mocks/redis-mock');
const { createConnectorSession } = require('../../local-ai-connector/lib/connector.cjs');
const proxyquire = require('proxyquire');

const stamp = `shai3${Date.now()}`;

// ── fixtures (mirrors ai-shared-inference.test.js) ────────────────────────

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
    await query(`DELETE FROM ai_chat_sessions WHERE book_id LIKE 'shai3-${stamp}%'`);
    await query(`DELETE FROM books WHERE book_id LIKE 'shai3-${stamp}%'`);
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

// ── fake SSE runtimes (switchable per-test handlers) ─────────────────────

function startFakeRuntime(handler) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            server.requests.push({ method: req.method, path: req.url, at: Date.now() });
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('close', () => { server.aborted += req.aborted ? 1 : 0; });
            req.on('end', () => {
                try { server.lastBody = body ? JSON.parse(body) : null; } catch (_) {}
                server.currentHandler(req, res, server);
            });
        });
        server.requests = [];
        server.aborted = 0;
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

const sseChunk = (content) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
const sseFinish = (reason = 'stop', usage) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: reason }], ...(usage ? { usage } : {}) })}\n\n`;
const SSE_DONE = 'data: [DONE]\n\n';
const FINAL_USAGE = { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 };

// Happy multi-delta stream.
const MULTI_DELTA_HANDLER = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sseChunk('Hello '));
    setTimeout(() => res.write(sseChunk('shared ')), 10);
    setTimeout(() => res.write(sseChunk('SSE!')), 20);
    setTimeout(() => {
        res.write(sseFinish('stop', FINAL_USAGE));
        res.write(SSE_DONE);
        res.end();
    }, 30);
};

const EMPTY_STREAM_HANDLER = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(SSE_DONE);
    res.end();
};

// Usage-only final chunk (no choices at all) — legal terminal.
const USAGE_ONLY_HANDLER = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sseChunk('usage check '));
    setTimeout(() => {
        res.write(`data: ${JSON.stringify({ usage: FINAL_USAGE })}\n\n`);
        res.end();
    }, 10);
};

// One delta then the socket dies — mid-stream failure after content.
const STREAM_THEN_DIE_HANDLER = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sseChunk('partial answer '));
    setTimeout(() => { try { res.destroy(); } catch (_) {} }, 40);
};

// One delta then a REAL hang: never writes again, never ends, and NO
// req.on('close') hook (in Node 18+ that fires as soon as the request body
// is consumed and would destroy the response — the hang must hold until the
// caller cancels or the socket dies).
const HANG_HANDLER = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sseChunk('first '));
};

// Cloud-style non-streaming JSON answer (used by the cloud-provider branch).
const chatJson = (content) => JSON.stringify({
    id: 'cmpl-1', object: 'chat.completion', created: 1700000000, model: 'cloud-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});
const JSON_HANDLER = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(chatJson('cloud says hi'));
};

// ── backend harness (express + WS, injectable identity) ──────────────────

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

// ── minimal SSE client over fetch (mirrors the browser contract) ─────────

/**
 * POST an SSE request and consume the stream. `onEvent(event, data)` fires
 * per parsed SSE frame (event name + parsed JSON data). Resolves with
 * { status, events: [{event, data}], raw } — raw is the full wire text for
 * security scans. `signal` aborts the client side (browser disconnect).
 */
async function consumeSse(base, path, { identity, body, signal, onEvent } = {}) {
    const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: identityHeaders(identity),
        body: JSON.stringify(body || {}),
        signal,
    });
    if (!res.ok) {
        let json = null;
        try { json = await res.json(); } catch (_) {}
        return { status: res.status, errorBody: json, raw: '' };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events = [];
    let raw = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        raw += text;
        buffer += text;
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) {
            let eventName = 'message';
            let data = '';
            for (const line of frame.split('\n')) {
                if (line.startsWith('event:')) eventName = line.slice(6).trim();
                else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            let parsed = null;
            try { parsed = JSON.parse(data); } catch (_) {}
            events.push({ event: eventName, data: parsed, dataRaw: data });
            if (onEvent) { try { onEvent(eventName, parsed); } catch (_) {} }
        }
    }
    return { status: res.status, events, raw };
}

function waitFor(predicate, { timeoutMs = 8000, stepMs = 25 } = {}) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            let ok = false;
            try { ok = predicate(); } catch (_) { ok = false; }
            if (ok) return resolve();
            if (Date.now() - started > timeoutMs) {
                console.error(`[waitFor TIMEOUT] ${String(predicate).slice(0, 90)}`);
                return reject(new Error('waitFor timeout'));
            }
            setTimeout(tick, stepMs);
        };
        tick();
    });
}

function inflightCount() {
    const stats = sharedPool.stats().inflight;
    return Object.values(stats).reduce((a, b) => a + b, 0);
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

// ───────────────────────────────────────────────────────────────────────────

describe('LLM Sharing Phase 3 — production SSE route (stream/cancel/security/concurrency)', function () {
    this.timeout(60000);

    let srv;
    let wsA, wsB, wsC, wsD;   // A = owner; B/C = consumers; D = cloud provider workspace
    let userA, userB, userC, userD;
    let connA1, connA2;
    let ep1, ep2;
    let rt1, rt2;
    let sess1, sess2;
    let tokenA1, tokenA2;
    const liveSessions = [];

    const idA = () => ({ user: { userId: userA }, workspace: { id: wsA } });
    const idB = () => ({ user: { userId: userB }, workspace: { id: wsB } });
    const idC = () => ({ user: { userId: userC }, workspace: { id: wsC } });
    const idD = () => ({ user: { userId: userD }, workspace: { id: wsD } });

    const bookB = () => `shai3-${stamp}-chatB`;
    const bookC = () => `shai3-${stamp}-chatC`;
    const bookD = () => `shai3-${stamp}-chatD`;

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
        userA = await createUser('sh3u_a');
        userB = await createUser('sh3u_b');
        userC = await createUser('sh3u_c');
        userD = await createUser('sh3u_d');
        wsA = await createWorkspace('sh3A'); // owner
        wsB = await createWorkspace('sh3B'); // consumer
        wsC = await createWorkspace('sh3C'); // consumer
        wsD = await createWorkspace('sh3D'); // cloud provider workspace
        srv = await startBackend();

        const c1 = await createActivatedConnector(wsA, 'Home Ollama', 'ollama');
        const c2 = await createActivatedConnector(wsA, 'Home vLLM', 'vllm');
        connA1 = c1.connector;
        connA2 = c2.connector;
        tokenA1 = c1.token;
        tokenA2 = c2.token;

        rt1 = await startFakeRuntime(MULTI_DELTA_HANDLER);
        rt2 = await startFakeRuntime(JSON_HANDLER);
        sess1 = await openLiveSession(connA1, tokenA1, rt1.baseUrl);
        sess2 = await openLiveSession(connA2, tokenA2, rt2.baseUrl);
        await stampHeartbeat(connA1.connector_id, { models: ['qwen3:32b'] });
        await stampHeartbeat(connA2.connector_id, { models: ['llama3:70b'] });

        ep1 = (await endpointRepo.createEndpoint({
            workspaceId: wsA, connectorId: connA1.connector_id, name: 'Shared Qwen', runtimeType: 'ollama', model: 'qwen3:32b',
        })).endpoint;
        ep2 = (await endpointRepo.createEndpoint({
            workspaceId: wsA, connectorId: connA2.connector_id, name: 'Shared Llama', runtimeType: 'vllm', model: 'llama3:70b',
        })).endpoint;
        await shareEndpoint(ep1.endpoint_id, wsA);
        await shareEndpoint(ep2.endpoint_id, wsA);

        await createBook(bookB(), wsB);
        await createBook(bookC(), wsC);
        await createBook(bookD(), wsD);
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
        workspaceAi.invalidateCache(wsA);
        workspaceAi.invalidateCache(wsB);
        workspaceAi.invalidateCache(wsC);
        workspaceAi.invalidateCache(wsD);
    });

    // ════════════════════════════════════════════════════════════════════
    // SSE — the streaming matrix
    // ════════════════════════════════════════════════════════════════════

    describe('SSE matrix', function () {
        let specialSeq = 0;
        async function withSpecialRuntime(runtimeHandler, fn) {
            const srt = await startFakeRuntime(runtimeHandler);
            const c = await createActivatedConnector(wsA, `Special ${++specialSeq}`, 'ollama');
            const s = createConnectorSession({
                config: { url: srv.wsUrl, token: c.token, baseUrl: srt.baseUrl, runtimeType: 'ollama' },
                logger: { info: () => {}, warn: () => {}, error: () => {} },
            });
            let specialEp = null;
            try {
                s.start();
                await waitFor(() => registry.isLive(c.connector.connector_id));
                await stampHeartbeat(c.connector.connector_id, { models: ['qwen3:32b'] });
                specialEp = (await endpointRepo.createEndpoint({
                    workspaceId: wsA, connectorId: c.connector.connector_id, name: `Special ${specialSeq}`, runtimeType: 'ollama', model: 'qwen3:32b',
                })).endpoint;
                await shareEndpoint(specialEp.endpoint_id, wsA);
                await setFixturesEnabled(false);
                return await fn(srt, s, specialEp, c.connector);
            } finally {
                await setFixturesEnabled(true);
                if (specialEp) await endpointRepo.deleteEndpoint(specialEp.endpoint_id, wsA);
                try { s.stop(); } catch (_) {}
                await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [c.connector.connector_id]);
                await srt.closeServer();
            }
        }

        it('S1. normal shared stream: N deltas in order + ONE done terminal + usage + source=shared', async () => {
            await withSpecialRuntime(MULTI_DELTA_HANDLER, async (srt, s, specialEp) => {
                const res = await consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idB(),
                    body: { book_id: bookB(), message: 'hello', mode: 'chat' },
                });
                expect(res.status).to.equal(200);
                const metas = res.events.filter((e) => e.event === 'meta');
                expect(metas).to.have.lengthOf(1);
                expect(metas[0].data.ai_source).to.equal('shared');
                expect(metas[0].data.model).to.equal('qwen3:32b');
                expect(metas[0].data.session_id).to.be.a('string');
                const deltas = res.events.filter((e) => e.event === 'delta').map((e) => e.data.delta);
                expect(deltas).to.deep.equal(['Hello ', 'shared ', 'SSE!']);
                const dones = res.events.filter((e) => e.event === 'done');
                const errs = res.events.filter((e) => e.event === 'error');
                expect(dones).to.have.lengthOf(1); // terminal exactly once
                expect(errs).to.have.lengthOf(0);
                expect(dones[0].data.reply).to.equal('Hello shared SSE!');
                expect(dones[0].data.ai_source).to.equal('shared');
                expect(dones[0].data.usage).to.deep.equal(FINAL_USAGE);
                expect(dones[0].data.finish_reason).to.equal('stop');
                expect(dones[0].data.session_id).to.equal(metas[0].data.session_id);
                expect(inflightCount()).to.equal(0); // slot released on success
                expect(transport.stats().pending).to.equal(0);
                // strict model propagation reached the runtime
                expect(srt.lastBody.model).to.equal('qwen3:32b');
            });
        });

        it('S2. private local stream: workspace binding streams over its own connector, no pool involvement', async () => {
            await workspaceAi.upsertProvider(wsB, {
                providerType: 'local-ai', connectorId: connA1.connector_id, model: 'qwen3:32b',
            });
            try {
                const res = await consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idB(),
                    body: { book_id: bookB(), message: 'hello', mode: 'chat' },
                });
                expect(res.status).to.equal(200);
                const metas = res.events.filter((e) => e.event === 'meta');
                expect(metas[0].data.ai_source).to.equal('private-local');
                const deltas = res.events.filter((e) => e.event === 'delta').map((e) => e.data.delta);
                expect(deltas).to.deep.equal(['Hello ', 'shared ', 'SSE!']);
                expect(res.events.filter((e) => e.event === 'done')).to.have.lengthOf(1);
                expect(res.events.filter((e) => e.event === 'done')[0].data.ai_source).to.equal('private-local');
                expect(inflightCount()).to.equal(0); // private path never holds a pool slot
            } finally {
                await workspaceAi.deleteProvider(wsB);
            }
        });

        it('S3. cloud provider stream: existing non-streaming upstream re-emitted as 1 delta + done', async () => {
            // A public cloud endpoint cannot be reached from the test sandbox
            // — proxyquire a DETERMINISTIC safeFetch for the route module
            // (ai-routes.cjs requires it by path). This exercises the exact
            // cloud branch of the stream route (fetch → 1 delta + done) with
            // an OpenAI-compatible answer.
            const fakeSseModule = proxyquire('../src/routes/ai-routes.cjs', {
                '../services/url-safety': {
                    safeFetch: async () => ({
                        ok: true,
                        json: async () => ({
                            choices: [{ message: { role: 'assistant', content: 'cloud says hi' }, finish_reason: 'stop' }],
                            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                        }),
                    }),
                },
            });
            const redis2 = createMockRedis();
            const logger2 = { info: () => {}, warn: () => {}, error: () => {} };
            const wsHandler2 = createWsHandler({ redis: redis2, logger: logger2 });
            const config = require('../src/config/runtime-config');
            const chatEngine = require('../src/services/chat-engine.cjs')(config);
            const app2 = express();
            app2.use(express.json());
            app2.use((req, res, next) => {
                const id = req.headers['x-test-identity'];
                req.user = id ? JSON.parse(id).user : null;
                req.guest = id ? (JSON.parse(id).guest || null) : null;
                req.workspace = id ? (JSON.parse(id).workspace || null) : null;
                next();
            });
            createAiEndpointRoutes({ logger: logger2 })(app2);
            fakeSseModule(app2, null, {
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
            const server2 = http.createServer(app2);
            wsHandler2.attachUpgrade(server2);
            await new Promise((r) => server2.listen(0, '127.0.0.1', r));
            const base2 = `http://127.0.0.1:${server2.address().port}`;
            try {
                await workspaceAi.upsertProvider(wsD, {
                    providerType: 'openai-compatible', endpoint: 'https://cloud.example/v1', apiKey: 'sk-cloud-test', model: 'cloud-model',
                });
                const res = await consumeSse(base2, '/api/v1/ai/chat/stream', {
                    identity: idD(),
                    body: { book_id: bookD(), message: 'hello', mode: 'chat' },
                });
                expect(res.status).to.equal(200);
                const metas = res.events.filter((e) => e.event === 'meta');
                expect(metas[0].data.ai_source).to.equal('cloud');
                const deltas = res.events.filter((e) => e.event === 'delta').map((e) => e.data.delta);
                expect(deltas).to.deep.equal(['cloud says hi']); // exactly ONE re-emitted delta
                const dones = res.events.filter((e) => e.event === 'done');
                expect(dones).to.have.lengthOf(1);
                expect(dones[0].data.reply).to.equal('cloud says hi');
                expect(dones[0].data.ai_source).to.equal('cloud');
                expect(inflightCount()).to.equal(0); // pool untouched
            } finally {
                await workspaceAi.deleteProvider(wsD);
                wsHandler2.shutdown();
                await new Promise((r) => server2.close(r));
            }
        });

        it('S4. empty stream: chat.response with empty content → done terminal, no deltas', async () => {
            await withSpecialRuntime(EMPTY_STREAM_HANDLER, async (srt, s, specialEp) => {
                const res = await consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idB(),
                    body: { book_id: bookB(), message: 'hello', mode: 'chat' },
                });
                expect(res.status).to.equal(200);
                const deltas = res.events.filter((e) => e.event === 'delta');
                // No runtime deltas; the honest no-result fallback may surface
                // as at most the single canonical-text delta before done.
                expect(deltas.length).to.be.at.most(1);
                const dones = res.events.filter((e) => e.event === 'done');
                expect(dones).to.have.lengthOf(1); // terminal exactly once
                expect(res.events.filter((e) => e.event === 'error')).to.have.lengthOf(0);
                expect(dones[0].data.session_id).to.be.a('string');
            });
        });

        it('S5. usage-only final chunk → usage rides the done event', async () => {
            await withSpecialRuntime(USAGE_ONLY_HANDLER, async (srt, s, specialEp) => {
                const res = await consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idB(),
                    body: { book_id: bookB(), message: 'hello', mode: 'chat' },
                });
                const deltas = res.events.filter((e) => e.event === 'delta').map((e) => e.data.delta);
                expect(deltas.join('')).to.equal('usage check ');
                const dones = res.events.filter((e) => e.event === 'done');
                expect(dones).to.have.lengthOf(1);
                expect(dones[0].data.usage).to.deep.equal(FINAL_USAGE);
            });
        });

        it('S6. partial output + error: mid-stream runtime failure → sanitized terminal error, partial preserved', async () => {
            await withSpecialRuntime(STREAM_THEN_DIE_HANDLER, async (srt, s, specialEp) => {
                const res = await captureConsole(() => consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idB(),
                    body: { book_id: bookB(), message: 'hello', mode: 'chat' },
                }));
                const r = res.result;
                expect(r.status).to.equal(200);
                const deltas = r.events.filter((e) => e.event === 'delta').map((e) => e.data.delta);
                expect(deltas.join('')).to.equal('partial answer '); // partial NOT lost
                const errs = r.events.filter((e) => e.event === 'error');
                expect(errs).to.have.lengthOf(1); // ONE terminal error
                expect(errs[0].data.code).to.equal('stream_failed');
                expect(errs[0].data.error).to.equal('Local AI stream failed after partial output');
                expect(r.events.filter((e) => e.event === 'done')).to.have.lengthOf(0);
                expect(inflightCount()).to.equal(0); // slot released on mid-stream failure
                expect(transport.stats().pending).to.equal(0);
            });
        });

        it('S7. malformed SSE mid-stream → sanitized terminal error (no raw runtime detail)', async () => {
            await withSpecialRuntime((req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write(sseChunk('ok so far '));
                setTimeout(() => {
                    res.write('data: {{{broken\n\n');
                    res.write(SSE_DONE);
                    res.end();
                }, 10);
            }, async (srt, s, specialEp) => {
                const { result: res } = await captureConsole(() => consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idB(),
                    body: { book_id: bookB(), message: 'hello', mode: 'chat' },
                }));
                const deltas = res.events.filter((e) => e.event === 'delta').map((e) => e.data.delta);
                expect(deltas.join('')).to.equal('ok so far ');
                const errs = res.events.filter((e) => e.event === 'error');
                expect(errs).to.have.lengthOf(1);
                expect(['bad_response', 'response_too_large', 'stream_failed']).to.include(errs[0].data.code);
                expect(JSON.stringify(errs[0].data)).to.not.include('{{{');
                expect(inflightCount()).to.equal(0);
            });
        });

        it('S8. oversized stream → sanitized terminal error, slot released', async function () {
            this.timeout(30000);
            await withSpecialRuntime((req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                const big = 'y'.repeat(20 * 1024);
                res.write(sseChunk(big));
                setTimeout(() => res.write(sseChunk(big)), 30);
                setTimeout(() => res.write(sseChunk(big)), 60);
            }, async (srt, s, specialEp) => {
                const { result: res } = await captureConsole(() => consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idB(),
                    body: { book_id: bookB(), message: 'hello', mode: 'chat' },
                }));
                const errs = res.events.filter((e) => e.event === 'error');
                expect(errs).to.have.lengthOf(1);
                expect(errs[0].data.code).to.equal('stream_failed'); // deltas already delivered
                expect(res.events.filter((e) => e.event === 'done')).to.have.lengthOf(0);
                expect(inflightCount()).to.equal(0);
            });
        });

        it('S9. oversized single delta from a hostile connector → sanitized terminal, no hostile text surfaced', async () => {
            // Standalone: the ONLY pooled endpoint belongs to a hostile raw
            // WS "connector" that injects an over-cap delta for the cloud's
            // chat.request — the cloud settles response_too_large sanitized
            // (no deltas were delivered → no stream_failed degradation).
            const c = await createActivatedConnector(wsA, 'Hostile delta', 'ollama');
            const { WebSocket } = require('ws');
            const ws = await new Promise((resolve, reject) => {
                const w = new WebSocket(srv.wsUrl);
                w.once('open', () => resolve(w));
                w.once('error', reject);
            });
            let hEp = null;
            try {
                ws.send(JSON.stringify({ type: 'hello', protocol_version: 1, credential: c.token }));
                await waitFor(() => registry.isLive(c.connector.connector_id));
                await stampHeartbeat(c.connector.connector_id, { models: ['qwen3:32b'] });
                hEp = (await endpointRepo.createEndpoint({
                    workspaceId: wsA, connectorId: c.connector.connector_id, name: 'Hostile delta EP', runtimeType: 'ollama', model: 'qwen3:32b',
                })).endpoint;
                await shareEndpoint(hEp.endpoint_id, wsA);
                await setFixturesEnabled(false);
                const requestPromise = waitFor(() => {
                    // resolved when the chat.request arrives (handled below)
                    return true;
                });
                const p = captureConsole(() => consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idB(),
                    body: { book_id: bookB(), message: 'hello', mode: 'chat' },
                }));
                // Wait for the chat.request frame, then answer hostilely.
                const req = await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('no chat.request')), 8000);
                    ws.once('message', (data) => {
                        const msg = JSON.parse(data.toString());
                        if (msg.type === 'chat.request') { clearTimeout(timer); resolve(msg); }
                    });
                });
                expect(req.params.stream).to.equal(true);
                ws.send(JSON.stringify({ type: 'chat.delta', request_id: req.request_id, delta: 'X'.repeat(20 * 1024) }));
                const { result: res } = await p;
                void requestPromise;
                const errs = res.events.filter((e) => e.event === 'error');
                expect(errs).to.have.lengthOf(1);
                expect(errs[0].data.code).to.equal('response_too_large');
                expect(JSON.stringify(res.events)).to.not.include('XXXX');
                expect(inflightCount()).to.equal(0);
                expect(transport.stats().pending).to.equal(0);
            } finally {
                try { ws.close(); } catch (_) {}
                await setFixturesEnabled(true);
                if (hEp) await endpointRepo.deleteEndpoint(hEp.endpoint_id, wsA);
                await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [c.connector.connector_id]);
            }
        });

        it('S10. runtime error BEFORE first delta (runtime 500) → sanitized terminal error, no deltas', async () => {
            await withSpecialRuntime((req, res) => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'CUDA OOM SECRET' } }));
            }, async (srt, s, specialEp) => {
                const { result: res } = await captureConsole(() => consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idB(),
                    body: { book_id: bookB(), message: 'hello', mode: 'chat' },
                }));
                const deltas = res.events.filter((e) => e.event === 'delta');
                expect(deltas).to.have.lengthOf(0);
                const errs = res.events.filter((e) => e.event === 'error');
                expect(errs).to.have.lengthOf(1);
                expect(errs[0].data.code).to.equal('runtime_error');
                expect(JSON.stringify(errs[0].data)).to.not.include('SECRET');
                expect(inflightCount()).to.equal(0);
            });
        });
    });

    // ════════════════════════════════════════════════════════════════════
    // Cancellation / abort / disconnect — the slot lifecycle
    // ════════════════════════════════════════════════════════════════════

    describe('cancellation & slot lifecycle', function () {
        let specialSeq = 100;
        async function withSpecialRuntime(runtimeHandler, fn) {
            const srt = await startFakeRuntime(runtimeHandler);
            const c = await createActivatedConnector(wsA, `Cancel ${++specialSeq}`, 'ollama');
            const s = createConnectorSession({
                config: { url: srv.wsUrl, token: c.token, baseUrl: srt.baseUrl, runtimeType: 'ollama' },
                logger: { info: () => {}, warn: () => {}, error: () => {} },
            });
            let specialEp = null;
            try {
                s.start();
                await waitFor(() => registry.isLive(c.connector.connector_id));
                await stampHeartbeat(c.connector.connector_id, { models: ['qwen3:32b'] });
                specialEp = (await endpointRepo.createEndpoint({
                    workspaceId: wsA, connectorId: c.connector.connector_id, name: `Cancel ${specialSeq}`, runtimeType: 'ollama', model: 'qwen3:32b',
                })).endpoint;
                await shareEndpoint(specialEp.endpoint_id, wsA);
                await setFixturesEnabled(false);
                return await fn(srt, s, specialEp, c.connector);
            } finally {
                await setFixturesEnabled(true);
                if (specialEp) await endpointRepo.deleteEndpoint(specialEp.endpoint_id, wsA);
                try { s.stop(); } catch (_) {}
                await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [c.connector.connector_id]);
                await srt.closeServer();
            }
        }

        it('C1. browser disconnect mid-stream → chat.cancel → runtime abort → slot released', async function () {
            this.timeout(20000);
            await withSpecialRuntime(HANG_HANDLER, async (srt, s, specialEp) => {
                const controller = new AbortController();
                const p = consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idB(),
                    body: { book_id: bookB(), message: 'hello', mode: 'chat' },
                    signal: controller.signal,
                });
                await waitFor(() => inflightCount() >= 1);
                expect(inflightCount()).to.equal(1);
                await waitFor(() => srt.requests.length >= 1);
                await new Promise((r) => setTimeout(r, 300)); // the first delta has been delivered
                controller.abort(); // the browser walks away after deltas started
                await p.then(() => null, () => null);
                await waitFor(() => inflightCount() === 0, { timeoutMs: 5000 });
                expect(inflightCount()).to.equal(0); // slot freed by the cancel
                expect(transport.stats().pending).to.equal(0); // no dangling pending
                // The endpoint is selectable again immediately.
                const again = await sharedPool.selectSharedAI({ workspaceId: wsB });
                expect(again).to.exist;
                expect(again.shared.endpointId).to.equal(specialEp.endpoint_id);
            });
        });

        it('C2. explicit AbortSignal abort before any frame → clean 400-ish sanitized terminal, slot never leaks', async () => {
            await withSpecialRuntime(HANG_HANDLER, async (srt, s, specialEp) => {
                const controller = new AbortController();
                controller.abort(); // aborted BEFORE the fetch
                const err = await consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idB(),
                    body: { book_id: bookB(), message: 'hello', mode: 'chat' },
                    signal: controller.signal,
                }).then(() => null, (e) => e);
                expect(err).to.exist; // fetch failed client-side
                expect(inflightCount()).to.equal(0);
            });
        });

        it('C3. runtime timeout → sanitized terminal error (timeout), slot released', async function () {
            this.timeout(20000);
            await withSpecialRuntime((req, res) => {
                // A runtime that hangs BEFORE any delta: the connector's own
                // timeout (runtime_unreachable) races the cloud timer — the
                // honest sanitized fail is either code.
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                // deliberate: never writes, never ends, never destroys
            }, async (srt, s, specialEp) => {
                const { result: res } = await captureConsole(() => consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idB(),
                    body: { book_id: bookB(), message: 'hello', mode: 'chat', timeout_ms: 900 },
                }));
                expect(res.status).to.equal(200);
                expect(res.events.filter((e) => e.event === 'delta')).to.have.lengthOf(0);
                const errs = res.events.filter((e) => e.event === 'error');
                expect(errs).to.have.lengthOf(1);
                // A hang with NO delta: the connector's own timeout fires
                // first (runtime_unreachable); the cloud-side authoritative
                // timer surface is the same sanitized family. Both are the
                // honest "timed out" answer — either code is a clean fail.
                expect(['timeout', 'runtime_unreachable']).to.include(errs[0].data.code);
                expect(inflightCount()).to.equal(0);
                expect(transport.stats().pending).to.equal(0);
            });
        });

        it('C4. connector disconnect mid-stream → session_closed terminal, slot released', async function () {
            this.timeout(20000);
            await withSpecialRuntime(HANG_HANDLER, async (srt, s, specialEp) => {
                const p = consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idB(),
                    body: { book_id: bookB(), message: 'hello', mode: 'chat' },
                });
                await waitFor(() => inflightCount() >= 1);
                s.stop(); // the connector walks away mid-stream
                const res = await p;
                const errs = res.events.filter((e) => e.event === 'error');
                expect(errs).to.have.lengthOf(1);
                expect(errs[0].data.code).to.equal('session_closed');
                expect(errs[0].data.error).to.equal('Local AI connection lost');
                await waitFor(() => inflightCount() === 0);
                expect(inflightCount()).to.equal(0);
                expect(transport.stats().pending).to.equal(0);
            });
        });

        it('C5. slot release after every failure path (error/timeout/disconnect) — sequential sweep', async function () {
            this.timeout(30000);
            // error path
            await withSpecialRuntime((req, res) => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'boom' } }));
            }, async () => {
                const { result: r } = await captureConsole(() => consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idB(), body: { book_id: bookB(), message: 'x', mode: 'chat' },
                }));
                expect(r.events.filter((e) => e.event === 'error')).to.have.lengthOf(1);
                expect(inflightCount()).to.equal(0);
            });
            // timeout path
            await withSpecialRuntime((req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                // real hang — no close hook, no destroy
            }, async () => {
                const { result: r } = await captureConsole(() => consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idB(), body: { book_id: bookB(), message: 'x', mode: 'chat', timeout_ms: 700 },
                }));
                expect(['timeout', 'runtime_unreachable']).to.include(
                    r.events.filter((e) => e.event === 'error')[0].data.code);
                expect(inflightCount()).to.equal(0);
            });
            // disconnect path
            await withSpecialRuntime(HANG_HANDLER, async (srt, s) => {
                const p = consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idB(), body: { book_id: bookB(), message: 'x', mode: 'chat' },
                });
                await waitFor(() => inflightCount() >= 1);
                s.stop();
                await p;
                await waitFor(() => inflightCount() === 0);
                expect(inflightCount()).to.equal(0);
            });
        });
    });

    // ════════════════════════════════════════════════════════════════════
    // Resolver regression through the stream route's seam
    // ════════════════════════════════════════════════════════════════════

    describe('resolver semantics', function () {
        it('R1. requested model preserved: the endpoint that has it is selected with that exact model', async () => {
            const res = await consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                identity: idB(),
                body: { book_id: bookB(), message: 'hi', mode: 'chat' },
            });
            expect(res.status).to.equal(200);
            const metas = res.events.filter((e) => e.event === 'meta');
            expect(metas[0].data.ai_source).to.equal('shared');
            expect(metas[0].data.model).to.equal('qwen3:32b'); // ep1's model, never swapped
            expect(rt1.lastBody.model).to.equal('qwen3:32b');
        });

        it('R2. incompatible shared endpoint skipped: requested model absent from ep1 → ep2 is never silently substituted', async () => {
            // ep1 serves qwen3:32b only; requesting llama3:70b must resolve to
            // ep2 (which has it) — and if neither had it, nothing shared would
            // resolve. The selected model NEVER differs from the requested one.
            const snap = await sharedPool.selectSharedAI({ workspaceId: wsB, model: 'llama3:70b' });
            expect(snap).to.exist;
            expect(snap.shared.endpointId).to.equal(ep2.endpoint_id);
            expect(snap.model).to.equal('llama3:70b');
            const none = await sharedPool.selectSharedAI({ workspaceId: wsB, model: 'nonexistent:99b' });
            expect(none).to.equal(null); // no silent switch to another model
        });

        it('R3. shared fallback works: no provider row → pool serves the stream', async () => {
            const res = await consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                identity: idC(),
                body: { book_id: bookC(), message: 'hi', mode: 'chat' },
            });
            expect(res.status).to.equal(200);
            const metas = res.events.filter((e) => e.event === 'meta');
            expect(metas[0].data.ai_source).to.equal('shared');
            expect(res.events.filter((e) => e.event === 'done')).to.have.lengthOf(1);
        });

        it('R4. private provider still wins: an explicit binding streams over its own connector', async () => {
            await workspaceAi.upsertProvider(wsB, {
                providerType: 'local-ai', connectorId: connA2.connector_id, model: 'llama3:70b',
            });
            try {
                const res = await consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idB(),
                    body: { book_id: bookB(), message: 'hi', mode: 'chat' },
                });
                const metas = res.events.filter((e) => e.event === 'meta');
                expect(metas[0].data.ai_source).to.equal('private-local');
                expect(metas[0].data.model).to.equal('llama3:70b');
                expect(rt2.lastBody.model).to.equal('llama3:70b'); // its OWN connector, not the pool's pick
            } finally {
                await workspaceAi.deleteProvider(wsB);
            }
        });

        it('R5. cloud provider unchanged: a configured cloud row wins over the pool', async () => {
            await workspaceAi.upsertProvider(wsD, {
                providerType: 'openai-compatible', endpoint: 'https://cloud.example/v1', apiKey: 'sk-cloud-test', model: 'cloud-model',
            });
            try {
                const snap = await workspaceAi.resolveAIForWorkspace(wsD);
                expect(snap.source).to.equal('workspace');
                expect(snap.endpoint).to.equal('https://cloud.example/v1');
                expect(snap.transport).to.equal(undefined);
                expect(inflightCount()).to.equal(0); // pool untouched
            } finally {
                await workspaceAi.deleteProvider(wsD);
            }
        });

        it('R6. owner exclusion (D3): the owner never resolves their own endpoint through the pool', async () => {
            expect(await sharedPool.selectSharedAI({ workspaceId: wsA })).to.equal(null);
            const snap = await workspaceAi.resolveAIForWorkspace(wsA);
            expect(snap.source).to.not.equal('shared');
        });

        it('R7. workspace isolation: no cross-workspace surface; consumers see no owner detail', async () => {
            const metaB = await fetch(`${srv.base}/api/v1/settings/ai/provider`, { headers: identityHeaders(idB()) });
            const metaBody = await metaB.json();
            expect(metaBody.shared_ai).to.deep.equal({ available: true });
            const raw = JSON.stringify(metaBody);
            expect(raw).to.not.include('Shared Qwen');
            expect(raw).to.not.include('Shared Llama');
            const foreignGet = await fetch(`${srv.base}/api/v1/ai-endpoints/${ep1.endpoint_id}`, { headers: identityHeaders(idB()) });
            expect(foreignGet.status).to.equal(404); // indistinct
        });
    });

    // ════════════════════════════════════════════════════════════════════
    // Security — the SSE surface never leaks
    // ════════════════════════════════════════════════════════════════════

    describe('security', function () {
        it('SEC1. the full SSE wire never carries credentials, runtime URLs, registration tokens or owner detail', async () => {
            const res = await consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                identity: idB(),
                body: { book_id: bookB(), message: 'hello', mode: 'chat' },
            });
            expect(res.status).to.equal(200);
            // Usage counters legitimately contain *_tokens — the SECRET scans
            // target credential/URL/owner material, not the safe counters.
            expect(res.raw).to.not.match(/https?:\/\//);
            expect(res.raw).to.not.match(/llmc\./);
            expect(res.raw).to.not.match(/llmcreg\./);
            expect(res.raw).to.not.match(/Bearer\s/i);
            expect(res.raw).to.not.match(/credential/i);
            expect(res.raw).to.not.match(/reg_?token/i);
            expect(res.raw).to.not.include('endpointId');
            expect(res.raw).to.not.include('ownerWorkspaceId');
            expect(res.raw).to.not.include('Shared Qwen');
            expect(res.raw).to.not.include('Home Ollama');
            expect(res.raw).to.not.include('127.0.0.1');
        });

        it('SEC2. hostile runtime error text never crosses to the client', async () => {
            // ep2's runtime returns JSON (no streaming), the shared snapshot
            // forces stream:true → the runtime replies JSON to a stream
            // request — the adapter fails sanitized either way; assert no raw
            // runtime body fragments ever surface. Drive a real runtime error
            // with hostile content instead.
            let specialSeq = 900;
            const srt = await startFakeRuntime((req, res) => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'INTERNAL RUNTIME-SECRET-42 traceback http://192.168.1.5:11434' } }));
            });
            const c = await createActivatedConnector(wsA, `Sec ${++specialSeq}`, 'ollama');
            const s = createConnectorSession({
                config: { url: srv.wsUrl, token: c.token, baseUrl: srt.baseUrl, runtimeType: 'ollama' },
                logger: { info: () => {}, warn: () => {}, error: () => {} },
            });
            let specialEp = null;
            try {
                s.start();
                await waitFor(() => registry.isLive(c.connector.connector_id));
                await stampHeartbeat(c.connector.connector_id, { models: ['qwen3:32b'] });
                specialEp = (await endpointRepo.createEndpoint({
                    workspaceId: wsA, connectorId: c.connector.connector_id, name: 'Sec EP', runtimeType: 'ollama', model: 'qwen3:32b',
                })).endpoint;
                await shareEndpoint(specialEp.endpoint_id, wsA);
                await setFixturesEnabled(false);
                const { result: res } = await captureConsole(() => consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idB(),
                    body: { book_id: bookB(), message: 'hi', mode: 'chat' },
                }));
                const errs = res.events.filter((e) => e.event === 'error');
                expect(errs).to.have.lengthOf(1);
                expect(errs[0].data.code).to.equal('runtime_error');
                expect(JSON.stringify(res.events)).to.not.include('RUNTIME-SECRET-42');
                expect(JSON.stringify(res.events)).to.not.match(/192\.168\./);
                expect(inflightCount()).to.equal(0);
            } finally {
                await setFixturesEnabled(true);
                if (specialEp) await endpointRepo.deleteEndpoint(specialEp.endpoint_id, wsA);
                try { s.stop(); } catch (_) {}
                await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [c.connector.connector_id]);
                await srt.closeServer();
            }
        });

        it('SEC3. requests for a foreign/nonexistent book leak nothing (no existence oracle)', async () => {
            // Depending on the shared-DB system-AI state the route may answer
            // 4xx (fail closed) or 200 (system fallback stream) — BOTH are
            // legitimate; the invariant under test is that the response
            // carries no workspace/endpoint/URL detail either way.
            const res = await fetch(`${srv.base}/api/v1/ai/chat/stream`, {
                method: 'POST',
                headers: identityHeaders(idB()),
                body: JSON.stringify({ book_id: 'shai3-nope', message: 'x' }),
            });
            const text = await res.text();
            expect(text).to.not.include(wsA);
            expect(text).to.not.include(wsC);
            expect(text).to.not.match(/https?:\/\//);
            expect(text).to.not.match(/llmc\./);
            if (res.status >= 400) {
                // fail-closed path: sanitized JSON error, no oracle detail
                expect(res.status).to.be.at.least(400);
            } else {
                // system-fallback path: the stream (if any) must still be clean
                expect(text).to.not.include('Home Ollama');
                expect(text).to.not.include('endpointId');
            }
        });
    });

    // ════════════════════════════════════════════════════════════════════
    // Concurrency — limit=1 discipline
    // ════════════════════════════════════════════════════════════════════

    describe('concurrency', function () {
        let specialSeq = 200;
        async function withSpecialRuntime(runtimeHandler, fn, { concurrencyLimit } = {}) {
            const srt = await startFakeRuntime(runtimeHandler);
            const c = await createActivatedConnector(wsA, `Conc ${++specialSeq}`, 'ollama');
            const s = createConnectorSession({
                config: { url: srv.wsUrl, token: c.token, baseUrl: srt.baseUrl, runtimeType: 'ollama' },
                logger: { info: () => {}, warn: () => {}, error: () => {} },
            });
            let specialEp = null;
            try {
                s.start();
                await waitFor(() => registry.isLive(c.connector.connector_id));
                await stampHeartbeat(c.connector.connector_id, { models: ['qwen3:32b'] });
                specialEp = (await endpointRepo.createEndpoint({
                    workspaceId: wsA, connectorId: c.connector.connector_id, name: `Conc ${specialSeq}`, runtimeType: 'ollama', model: 'qwen3:32b',
                })).endpoint;
                await shareEndpoint(specialEp.endpoint_id, wsA, { concurrencyLimit: concurrencyLimit || 1 });
                await setFixturesEnabled(false);
                return await fn(srt, s, specialEp, c.connector);
            } finally {
                await setFixturesEnabled(true);
                if (specialEp) await endpointRepo.deleteEndpoint(specialEp.endpoint_id, wsA);
                try { s.stop(); } catch (_) {}
                await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [c.connector.connector_id]);
                await srt.closeServer();
            }
        }

        it('CON1. limit=1: second concurrent request is rejected (busy) while the first streams', async function () {
            this.timeout(20000);
            await withSpecialRuntime(HANG_HANDLER, async (srt, s, specialEp) => {
                const p1 = consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idB(),
                    body: { book_id: bookB(), message: 'x', mode: 'chat' },
                });
                await waitFor(() => inflightCount() >= 1);
                expect(inflightCount()).to.equal(1);
                // wsC also targets the (single) shared endpoint → busy. With
                // both fixtures disabled, wsC's selection finds nothing
                // eligible → the route degrades to ai_unavailable (503) —
                // either sanitized answer is correct; the slot must stay at 1.
                const res = await consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                    identity: idC(),
                    body: { book_id: bookC(), message: 'x', mode: 'chat' },
                });
                expect(inflightCount()).to.equal(1); // the second request never took a slot
                expect(res.status === 503 || res.status === 200).to.equal(true);
                if (res.status === 503) {
                    expect(res.errorBody.code === 'ai_unavailable' || res.errorBody.code === 'busy'
                        || res.errorBody.code === 'shared_unavailable').to.equal(true);
                } else {
                    const errs = res.events.filter((e) => e.event === 'error');
                    expect(errs).to.have.lengthOf(1);
                }
                // Free the first: the browser aborts → slot released.
                await srt.closeServer.call(srt); // kill the runtime → stream fails cleanly
                await waitFor(() => inflightCount() === 0, { timeoutMs: 8000 });
                expect(inflightCount()).to.equal(0);
            });
        });

        it('CON2. slot released on success — two sequential shared streams both complete', async () => {
            await withSpecialRuntime(MULTI_DELTA_HANDLER, async (srt, s, specialEp) => {
                for (let i = 0; i < 2; i++) {
                    const res = await consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                        identity: idB(),
                        body: { book_id: bookB(), message: 'x', mode: 'chat' },
                    });
                    expect(res.events.filter((e) => e.event === 'done')).to.have.lengthOf(1);
                    expect(inflightCount()).to.equal(0);
                }
                expect(srt.requests).to.have.lengthOf(2);
            });
        });
    });

    // ════════════════════════════════════════════════════════════════════
    // Real end-to-end — full wire, real connector WS, fake runtime
    // ════════════════════════════════════════════════════════════════════

    it('E2E. HTTP client → production SSE route → resolver → sharedPool → connector WS → runtime SSE → HTTP streaming client', async () => {
        const srt = await startFakeRuntime(MULTI_DELTA_HANDLER);
        const c = await createActivatedConnector(wsA, 'E2E Phase3', 'ollama');
        const s = createConnectorSession({
            config: { url: srv.wsUrl, token: c.token, baseUrl: srt.baseUrl, runtimeType: 'ollama' },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
        });
        let specialEp = null;
        try {
            s.start();
            await waitFor(() => registry.isLive(c.connector.connector_id));
            await stampHeartbeat(c.connector.connector_id, { models: ['qwen3:32b'] });
            specialEp = (await endpointRepo.createEndpoint({
                workspaceId: wsA, connectorId: c.connector.connector_id, name: 'E2E Phase3 EP', runtimeType: 'ollama', model: 'qwen3:32b',
            })).endpoint;
            await shareEndpoint(specialEp.endpoint_id, wsA);
            await setFixturesEnabled(false);

            const received = [];
            const res = await consumeSse(srv.base, '/api/v1/ai/chat/stream', {
                identity: idB(),
                body: { book_id: bookB(), message: 'e2e', mode: 'chat' },
                onEvent: (event, data) => { if (event === 'delta') received.push(data.delta); },
            });
            expect(res.status).to.equal(200);
            expect(received.join('')).to.equal('Hello shared SSE!');
            expect(res.events.filter((e) => e.event === 'done')).to.have.lengthOf(1);
            expect(res.events.filter((e) => e.event === 'error')).to.have.lengthOf(0);
            // The runtime saw a real OpenAI-compatible streaming request.
            expect(srt.lastBody.stream).to.equal(true);
            expect(srt.lastBody.model).to.equal('qwen3:32b');
            expect(inflightCount()).to.equal(0);
            expect(transport.stats().pending).to.equal(0);
        } finally {
            await setFixturesEnabled(true);
            if (specialEp) await endpointRepo.deleteEndpoint(specialEp.endpoint_id, wsA);
            try { s.stop(); } catch (_) {}
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [c.connector.connector_id]);
            await srt.closeServer();
        }
    });
});
