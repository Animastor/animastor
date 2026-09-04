// ======================================================
// LLM Sharing Phase 2 — Consumer Resolver & Shared Inference (SH-AI-3)
// ======================================================
// Coverage matrix (task brief §6):
//
//   1.  Private Local AI → inference (workspace binding, unchanged)    ok
//   2.  Shared AI → inference (non-streaming consumer flow)            ok
//   3.  Private unavailable → Shared fallback (no row / disabled row)  ok
//       + explicit private binding stays fail-closed (AD-12 — NO shared
//       substitution for a chosen-but-offline connector)               ok
//   4.  Shared endpoint unavailable → next eligible endpoint           ok
//   5.  Requested model absent → endpoint skipped                      ok
//   6.  Requested model found → correct endpoint/model                 ok
//   7.  Streaming Shared AI (callAIStream over the pool)               ok
//   8.  Non-streaming Shared AI (= #2 via the shared snapshot)         ok
//   9.  Cancel releases the slot (AbortSignal → chat.cancel)           ok
//   10. Timeout releases the slot                                      ok
//   11. Runtime error releases the slot                                ok
//   12. Connector disconnect releases/invalidates the reservation      ok
//   13. Owner never gets their own endpoint through the pool (D3)      ok
//   14. Workspace isolation (B/C consumers, no cross-workspace data)   ok
//   15. No credentials/runtime URL leakage on any surface              ok
//   16. Existing cloud-provider flow unchanged (row wins over pool)    ok
//   17. Resolver caching discipline: shared snapshots are NEVER cached ok
//
// Real inference everywhere: real connector sessions (the distributable
// session lib) over real WebSockets against fake OpenAI-compatible local
// runtimes — the same E2E shape as the LAC suites. Endpoint fixtures stay
// stable for the whole suite: per-test behavior switches mutate the fake
// runtime handler or temporarily DISABLE an endpoint (never the registry
// session), so later tests always find a healthy pool again.

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
const { createConnectorSession } = require('../../local-ai-connector/lib/connector.cjs');

const stamp = `shai2${Date.now()}`;

// ── fixtures ──────────────────────────────────────────────────────────────

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
    await query(`DELETE FROM ai_chat_sessions WHERE book_id LIKE 'shai2-${stamp}%'`);
    await query(`DELETE FROM books WHERE book_id LIKE 'shai2-${stamp}%'`);
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

/** Stamp heartbeat facts (models + runtime_ok) so the eligibility ladder sees them. */
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
// ── fake local runtimes (OpenAI-compatible, switchable behavior) ──────────

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

const chatJson = (content) => JSON.stringify({
    id: 'cmpl-1', object: 'chat.completion', created: 1700000000,
    model: 'qwen3:32b',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
});

const CHAT_HANDLER = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(chatJson('hello from shared runtime'));
};

const HANG_HANDLER = (req, res) => {
    // Deliberately never answers — the caller must cancel/abort.
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    req.on('close', () => { try { res.destroy(); } catch (_) {} });
};

const DELAYED_HANDLER = (delayMs, content = 'slow answer') => (req, res) => {
    setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(chatJson(content));
    }, delayMs);
};

const ERROR_HANDLER = (req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'internal runtime explosion (secret detail)' } }));
};

const STREAM_HANDLER = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (content) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
    res.write(chunk('Hello '));
    setTimeout(() => res.write(chunk('shared ')), 10);
    setTimeout(() => res.write(chunk('stream!')), 20);
    setTimeout(() => {
        res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    }, 30);
};

// Streams deltas, then dies mid-stream (socket destroyed, no terminal
// frame) — the runtime error AFTER content already surfaced.
const STREAM_THEN_ERROR_HANDLER = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (content) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
    res.write(chunk('partial '));
    setTimeout(() => res.write(chunk('output ')), 10);
    setTimeout(() => { try { res.destroy(); } catch (_) {} }, 30);
};

// ── backend harness (WS + routes, injectable identity) ────────────────────

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

// ───────────────────────────────────────────────────────────────────────────

describe('LLM Sharing Phase 2 — consumer resolver & shared inference (SH-AI-3)', function () {
    this.timeout(40000);

    let srv;
    let wsA, wsB, wsC, wsD; // A = owner; B/C = consumers; D = cloud-provider workspace
    let userA, userB, userC, userD;
    let connA1, connA2;      // two owner connectors
    let ep1, ep2;            // endpoints on connA1/connA2
    let rt1, rt2;            // fake runtimes
    let sess1, sess2;        // real connector sessions
    let tokenA1, tokenA2;
    const liveSessions = [];

    const idA = () => ({ user: { userId: userA }, workspace: { id: wsA } });
    const idB = () => ({ user: { userId: userB }, workspace: { id: wsB } });
    const idC = () => ({ user: { userId: userC }, workspace: { id: wsC } });
    const idD = () => ({ user: { userId: userD }, workspace: { id: wsD } });

    /** Temporarily take ep1/ep2 out of the pool (endpoint switch, NOT the session). */
    async function setFixturesEnabled(enabled) {
        await endpointRepo.updateEndpoint(ep1.endpoint_id, wsA, { enabled });
        await endpointRepo.updateEndpoint(ep2.endpoint_id, wsA, { enabled });
    }

    /**
     * Open a REAL connector session (distributable session lib over a real
     * WS) against a fake runtime — the live session is authoritative.
     */
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
        userA = await createUser('sh2u_a');
        userB = await createUser('sh2u_b');
        userC = await createUser('sh2u_c');
        userD = await createUser('sh2u_d');
        wsA = await createWorkspace('sh2A'); // owner
        wsB = await createWorkspace('sh2B'); // consumer
        wsC = await createWorkspace('sh2C'); // consumer
        wsD = await createWorkspace('sh2D'); // cloud provider workspace
        srv = await startBackend();

        const c1 = await createActivatedConnector(wsA, 'Home Ollama', 'ollama');
        const c2 = await createActivatedConnector(wsA, 'Home vLLM', 'vllm');
        connA1 = c1.connector;
        connA2 = c2.connector;
        tokenA1 = c1.token;
        tokenA2 = c2.token;

        rt1 = await startFakeRuntime(CHAT_HANDLER);
        rt2 = await startFakeRuntime(CHAT_HANDLER);
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

        await createBook(`shai2-${stamp}-chatB`, wsB);
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

    // ── 1. Private Local AI → inference (unchanged path) ──────────────────

    it('1. private local AI binding resolves + infers over its own connector (no pool involvement)', async () => {
        await workspaceAi.upsertProvider(wsB, {
            providerType: 'local-ai', connectorId: connA2.connector_id, model: 'llama3:70b',
        });
        try {
            const snap = await workspaceAi.resolveAIForWorkspace(wsB);
            expect(snap.source).to.equal('workspace');
            expect(snap.transport).to.equal('connector');
            expect(snap.shared).to.equal(undefined);
            expect(inflightCount()).to.equal(0); // selection held NO pool slot

            const result = await aiService.callAI([{ role: 'user', content: 'hi' }], { maxTokens: 32 }, snap);
            expect(result.content).to.equal('hello from shared runtime');
            expect(rt2.lastBody.model).to.equal('llama3:70b');
            expect(rt2.requests.length).to.be.at.least(1);
        } finally {
            await workspaceAi.deleteProvider(wsB);
        }
    });

    // ── 2/8. Shared AI → inference (non-streaming consumer flow) ──────────

    it('2. consumer with no provider resolves a SHARED snapshot and infers over the pool', async () => {
        const snap = await workspaceAi.resolveAIForWorkspace(wsB);
        expect(snap.source).to.equal('shared');
        expect(snap.transport).to.equal('connector');
        expect(snap.endpoint).to.equal(null);
        expect(snap.apiKey).to.equal(null);
        expect(snap.model).to.equal('qwen3:32b'); // endpoint ep1's model
        expect(snap.connectorId).to.equal(connA1.connector_id);
        expect(snap.shared.endpointName).to.equal('Shared Qwen');
        expect(snap.shared.concurrencyLimit).to.be.a('number');
        expect(inflightCount()).to.equal(0); // slotless selection

        const result = await aiService.callAI([{ role: 'user', content: 'hi' }], { maxTokens: 32 }, snap);
        expect(result.content).to.equal('hello from shared runtime');
        expect(rt1.lastBody.model).to.equal('qwen3:32b');
        expect(inflightCount()).to.equal(0); // released on success
    });

    it('2b. shared slot is held DURING inference — a busy endpoint is not double-booked', async () => {
        const saved = rt1.currentHandler;
        rt1.currentHandler = DELAYED_HANDLER(400);
        try {
            const snap = await workspaceAi.resolveAIForWorkspace(wsB); // ep1 (limit 1)
            const first = aiService.callAI([{ role: 'user', content: 'x' }], { maxTokens: 8, timeout: 8000 }, snap);
            await waitFor(() => inflightCount() >= 1);
            expect(inflightCount()).to.equal(1);
            // While ep1 is busy, a second consumer's selection skips to ep2 —
            // the owner's concurrency_limit is never exceeded.
            const snap2 = await workspaceAi.resolveAIForWorkspace(wsC);
            expect(snap2.shared.endpointId).to.equal(ep2.endpoint_id);
            const result = await first;
            expect(result.content).to.equal('slow answer');
            expect(inflightCount()).to.equal(0); // released after completion
        } finally {
            rt1.currentHandler = saved;
        }
    });

    // ── 3. Private unavailable → Shared fallback ──────────────────────────

    it('3a. no provider row → shared fallback', async () => {
        const snap = await workspaceAi.resolveAIForWorkspace(wsB);
        expect(snap.source).to.equal('shared');
    });

    it('3b. disabled provider row → shared fallback', async () => {
        await workspaceAi.upsertProvider(wsB, { providerType: 'local-ai', connectorId: connA2.connector_id, enabled: false });
        try {
            const snap = await workspaceAi.resolveAIForWorkspace(wsB);
            expect(snap.source).to.equal('shared');
        } finally {
            await workspaceAi.deleteProvider(wsB);
        }
    });

    it('3c. an EXPLICIT private binding whose connector is offline stays fail-closed (AD-12 — no silent shared substitution)', async () => {
        await workspaceAi.upsertProvider(wsB, {
            providerType: 'local-ai', connectorId: connA1.connector_id, model: 'qwen3:32b',
        });
        try {
            sess1.stop();
            await waitFor(() => !registry.isLive(connA1.connector_id));
            const snap = await workspaceAi.resolveAIForWorkspace(wsB);
            expect(snap.source).to.equal('workspace'); // binding wins, unchanged
            let threw = null;
            await captureConsole(async () => {
                try {
                    await aiService.callAI([{ role: 'user', content: 'x' }], { maxTokens: 8 }, snap);
                } catch (err) { threw = err; }
            });
            expect(threw).to.exist;
            expect(threw.message).to.equal('Local AI is offline');
        } finally {
            await workspaceAi.deleteProvider(wsB);
            workspaceAi.invalidateCache(wsB);
            sess1 = await openLiveSession(connA1, tokenA1, rt1.baseUrl); // restore
        }
    });

    // ── 4. Shared endpoint unavailable → next eligible endpoint ───────────

    it('4. offline shared endpoint is skipped — the next eligible serves', async () => {
        sess1.stop();
        await waitFor(() => !registry.isLive(connA1.connector_id));
        try {
            const snap = await workspaceAi.resolveAIForWorkspace(wsB);
            expect(snap.source).to.equal('shared');
            expect(snap.shared.endpointId).to.equal(ep2.endpoint_id);
            expect(snap.model).to.equal('llama3:70b');
            const result = await aiService.callAI([{ role: 'user', content: 'hi' }], { maxTokens: 32 }, snap);
            expect(result.content).to.equal('hello from shared runtime');
            expect(rt2.lastBody.model).to.equal('llama3:70b');
            expect(inflightCount()).to.equal(0);
        } finally {
            sess1 = await openLiveSession(connA1, tokenA1, rt1.baseUrl); // restore
        }
    });

    // ── 5/6. Requested model eligibility ──────────────────────────────────

    it('5. requested model absent from every discovered list → nothing shared is resolved', async () => {
        const snap = await workspaceAi.resolveAIForWorkspace(wsB, { model: 'nonexistent:99b' });
        expect(snap.source).to.not.equal('shared'); // degraded to the next stage
        expect(await sharedPool.selectSharedAI({ workspaceId: wsB, model: 'nonexistent:99b' })).to.equal(null);
    });

    it('6. requested model found → the endpoint that has it is selected with that model', async () => {
        const snap = await workspaceAi.resolveAIForWorkspace(wsB, { model: 'llama3:70b' });
        expect(snap.source).to.equal('shared');
        expect(snap.shared.endpointId).to.equal(ep2.endpoint_id);
        expect(snap.model).to.equal('llama3:70b');
    });

    // ── 7–12. Streaming + slot lifecycle over a dedicated endpoint ────────
    // Each test runs against its own endpoint/runtime so the failure mode is
    // fully controlled; ep1/ep2 are only temporarily disabled (endpoint
    // switch) and always restored in finally.

    let specialSeq = 0;
    async function withSpecialEndpoint(runtimeHandler, fn) {
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
            // Only the special endpoint is in the pool for this test.
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

    it('7. streaming shared AI rides the pool reservation and delivers deltas', async () => {
        await withSpecialEndpoint(STREAM_HANDLER, async (srt, s, specialEp) => {
            const deltas = [];
            const snap = await workspaceAi.resolveAIForWorkspace(wsB);
            expect(snap.shared.endpointId).to.equal(specialEp.endpoint_id);
            const result = await aiService.callAIStream(
                [{ role: 'user', content: 'hi' }], { maxTokens: 64 }, snap, { onDelta: (d) => deltas.push(d) }
            );
            expect(deltas.join('')).to.equal('Hello shared stream!');
            expect(result.content).to.equal('Hello shared stream!');
            expect(result.finishReason).to.equal('stop');
            expect(inflightCount()).to.equal(0); // released after the terminal frame
        });
    });

    it('7b. runtime error AFTER delivered deltas → stream_failed sanitized, slot released', async () => {
        await withSpecialEndpoint(STREAM_THEN_ERROR_HANDLER, async (srt, s, specialEp) => {
            const deltas = [];
            const snap = await workspaceAi.resolveAIForWorkspace(wsB);
            expect(snap.shared.endpointId).to.equal(specialEp.endpoint_id);
            let threw = null;
            await captureConsole(async () => {
                try {
                    await aiService.callAIStream(
                        [{ role: 'user', content: 'hi' }], { maxTokens: 64 }, snap,
                        { onDelta: (d) => deltas.push(d) }
                    );
                } catch (err) { threw = err; }
            });
            expect(deltas.join('')).to.equal('partial output '); // deltas stayed delivered
            expect(threw).to.exist;
            expect(threw.message).to.equal('Local AI stream failed after partial output'); // stream_failed
            expect(inflightCount()).to.equal(0); // released after the failed stream
            // The endpoint is selectable again immediately.
            const again = await sharedPool.selectSharedAI({ workspaceId: wsB });
            expect(again.shared.endpointId).to.equal(specialEp.endpoint_id);
        });
    });

    it('9. consumer cancellation (AbortSignal) sends chat.cancel downstream and releases the slot', async () => {
        await withSpecialEndpoint(HANG_HANDLER, async (srt, s, specialEp) => {
            const snap = await workspaceAi.resolveAIForWorkspace(wsB);
            const controller = new AbortController();
            const call = captureConsole(() => aiService.callAI(
                [{ role: 'user', content: 'x' }], { maxTokens: 8, signal: controller.signal }, snap
            ));
            await waitFor(() => inflightCount() >= 1);
            controller.abort();
            const thrown = await call.then(() => null, (err) => err);
            expect(thrown).to.exist;
            expect(thrown.message).to.equal('Request cancelled');
            expect(inflightCount()).to.equal(0); // released on cancel
            // The endpoint is selectable again immediately.
            const again = await sharedPool.selectSharedAI({ workspaceId: wsB });
            expect(again.shared.endpointId).to.equal(specialEp.endpoint_id);
        });
    });

    it('10. timeout releases the slot', async () => {
        await withSpecialEndpoint(DELAYED_HANDLER(4000), async (srt, s, specialEp) => {
            const snap = await workspaceAi.resolveAIForWorkspace(wsB);
            let threw = null;
            await captureConsole(async () => {
                try {
                    await aiService.callAI([{ role: 'user', content: 'x' }], { maxTokens: 8, timeout: 700 }, snap);
                } catch (err) { threw = err; }
            });
            expect(threw).to.exist;
            expect(threw.message).to.equal('Local AI request timed out');
            expect(inflightCount()).to.equal(0); // released on timeout
        });
    });

    it('11. runtime error surfaces sanitized and releases the slot', async () => {
        await withSpecialEndpoint(ERROR_HANDLER, async (srt, s, specialEp) => {
            const snap = await workspaceAi.resolveAIForWorkspace(wsB);
            let threw = null;
            await captureConsole(async () => {
                try {
                    await aiService.callAI([{ role: 'user', content: 'x' }], { maxTokens: 8 }, snap);
                } catch (err) { threw = err; }
            });
            expect(threw).to.exist;
            expect(threw.message).to.equal('Local runtime error'); // sanitized — no runtime detail
            expect(inflightCount()).to.equal(0); // released on runtime error
        });
    });

    it('12. connector disconnect mid-inference fails the request and releases the slot', async () => {
        await withSpecialEndpoint(HANG_HANDLER, async (srt, s, specialEp) => {
            const snap = await workspaceAi.resolveAIForWorkspace(wsB);
            const call = captureConsole(() => aiService.callAI(
                [{ role: 'user', content: 'x' }], { maxTokens: 8, timeout: 15000 }, snap
            ));
            await waitFor(() => inflightCount() >= 1);
            s.stop(); // connector walks away mid-inference
            const thrown = await call.then(() => null, (err) => err);
            expect(thrown).to.exist;
            expect(thrown.message).to.equal('Local AI connection lost'); // session_closed
            expect(inflightCount()).to.equal(0); // reservation invalidated
            // The dead connector depools instantly.
            expect(await sharedPool.selectSharedAI({ workspaceId: wsB })).to.equal(null);
        });
    });

    // ── 13. Owner exclusion (D3) ──────────────────────────────────────────

    it('12b. consumer HTTP client walks away mid-inference → chat route aborts the shared call, slot released', async () => {
        // Full route-level E2E: POST /api/v1/ai/chat over the shared pool,
        // the HTTP client disconnects before the reply — the route's
        // res.on('close') abort must settle the inference and free the
        // slot (reserve → request → client disconnect → abort → release).
        // Uses the existing ep1/ep2 fixtures (no withSpecialEndpoint) and
        // DELAYED_HANDLER so inference is in-flight long enough to abort.
        const saved = rt1.currentHandler;
        rt1.currentHandler = DELAYED_HANDLER(5000);
        try {
            const controller = new AbortController();
            const fetchPromise = fetch(`${srv.base}/api/v1/ai/chat`, {
                method: 'POST',
                headers: identityHeaders(idB()),
                body: JSON.stringify({ book_id: `shai2-${stamp}-chatB`, message: 'hello', mode: 'chat' }),
                signal: controller.signal,
            }).then(() => null, (err) => err);
            await waitFor(() => inflightCount() >= 1, { timeoutMs: 5000 });
            expect(inflightCount()).to.equal(1);
            controller.abort(); // the consumer walks away
            const err = await fetchPromise;
            expect(err).to.exist; // fetch failed (aborted client-side)
            await waitFor(() => inflightCount() === 0, { timeoutMs: 3000 });
            expect(inflightCount()).to.equal(0); // slot released on client disconnect
        } finally {
            rt1.currentHandler = saved;
        }
    });

    it('13. the owner never resolves their own endpoint through the pool', async () => {
        expect(await sharedPool.selectSharedAI({ workspaceId: wsA })).to.equal(null);
        expect(await sharedPool.resolveSharedAI({ workspaceId: wsA })).to.equal(null);
        const snap = await workspaceAi.resolveAIForWorkspace(wsA);
        expect(snap.source).to.not.equal('shared'); // degraded to system/none
    });

    // ── 14. Workspace isolation ───────────────────────────────────────────

    it('14. workspace isolation — consumers share the pool, never each other or the owner surface', async () => {
        const snapB = await workspaceAi.resolveAIForWorkspace(wsB);
        expect(snapB.workspaceId).to.equal(wsB);
        const snapC = await workspaceAi.resolveAIForWorkspace(wsC);
        expect(snapC.workspaceId).to.equal(wsC);
        const bMeta = await workspaceAi.getProviderMeta(wsB);
        expect(bMeta).to.equal(null); // no phantom provider row
        const cMeta = await workspaceAi.getProviderMeta(wsC);
        expect(cMeta).to.equal(null);
        // Endpoint management surface stays owner-only (B/C see nothing).
        const listB = await api(srv, 'GET', '/api/v1/ai-endpoints', { identity: idB() });
        expect(listB.status).to.equal(200);
        expect(listB.body.endpoints).to.have.length(0);
        const foreignGet = await api(srv, 'GET', `/api/v1/ai-endpoints/${ep1.endpoint_id}`, { identity: idB() });
        expect(foreignGet.status).to.equal(404); // indistinct — no oracle
    });

    // ── 15. Security — no credentials/runtime URL leakage ─────────────────

    it('15. consumer snapshot, chat API response and settings response never carry runtime URLs or credential material', async () => {
        const snap = await workspaceAi.resolveAIForWorkspace(wsB);
        const snapJson = JSON.stringify(snap);
        expect(snapJson).to.not.match(/https?:\/\//);
        expect(snapJson).to.not.match(/llmc\./);
        expect(snapJson).to.not.match(/llmcreg\./);
        expect(snapJson).to.not.include('token');
        expect(snap.endpoint).to.equal(null);
        expect(snap.apiKey).to.equal(null);

        // Full chat E2E over the shared pool — the API response carries the
        // reply + a SAFE source token only.
        const res = await api(srv, 'POST', '/api/v1/ai/chat', {
            identity: idB(),
            body: { book_id: `shai2-${stamp}-chatB`, message: 'hello', mode: 'chat' },
        });
        expect(res.status).to.equal(200);
        expect(res.body.reply).to.equal('hello from shared runtime');
        expect(res.body.ai_source).to.equal('shared');
        expect(res.raw).to.not.match(/https?:\/\//);
        expect(res.raw).to.not.match(/llmc\./);
        expect(res.raw).to.not.include('endpointId');

        // Settings meta: availability hint only (no endpoint names/owners).
        const meta = await api(srv, 'GET', '/api/v1/settings/ai/provider', { identity: idC() });
        expect(meta.status).to.equal(200);
        expect(meta.body.shared_ai).to.deep.equal({ available: true });
        expect(meta.raw).to.not.match(/https?:\/\//);
        expect(meta.raw).to.not.include('Shared Qwen');
        expect(meta.raw).to.not.match(/llmc\./);
    });

    // ── 16. Existing cloud-provider flow unchanged ────────────────────────

    it('16. a configured cloud provider wins over the pool and behaves byte-identically', async () => {
        await workspaceAi.upsertProvider(wsD, {
            providerType: 'openai-compatible', endpoint: 'https://cloud.example/v1', apiKey: 'sk-cloud-test', model: 'cloud-model',
        });
        try {
            const snap = await workspaceAi.resolveAIForWorkspace(wsD);
            expect(snap.source).to.equal('workspace'); // NOT shared
            expect(snap.endpoint).to.equal('https://cloud.example/v1');
            expect(snap.apiKey).to.equal('sk-cloud-test');
            expect(snap.transport).to.equal(undefined);
            expect(inflightCount()).to.equal(0); // pool untouched
        } finally {
            await workspaceAi.deleteProvider(wsD);
        }
    });

    it('16b. shared snapshot is safe for health checks (no crash, no fetch)', async () => {
        const snap = await workspaceAi.resolveAIForWorkspace(wsB);
        const n = await aiService.checkAIHealth({}, snap);
        expect(n).to.equal(0); // connector snapshots carry no HTTP credential
    });

    // ── 17. Resolver caching discipline (Phase 2 regression) ──────────────

    it('17. shared snapshots are never cached — revocation applies within one request', async () => {
        // Two resolutions return DISTINCT snapshots (no 30s cache reuse).
        const s1 = await workspaceAi.resolveAIForWorkspace(wsB);
        const s2 = await workspaceAi.resolveAIForWorkspace(wsB);
        expect(s1 === s2).to.equal(false);

        // Owner revokes sharing → the VERY NEXT resolution degrades to the
        // system fallback (no stale-cache window for a revoked shared
        // snapshot — the security-critical direction).
        await endpointRepo.setSharing(ep1.endpoint_id, wsA, { enabled: false });
        await endpointRepo.setSharing(ep2.endpoint_id, wsA, { enabled: false });
        try {
            const after = await workspaceAi.resolveAIForWorkspace(wsB);
            expect(after.source).to.not.equal('shared');
        } finally {
            await endpointRepo.setSharing(ep1.endpoint_id, wsA, { enabled: true });
            await endpointRepo.setSharing(ep2.endpoint_id, wsA, { enabled: true });
        }
        // Re-enable direction: the empty-pool SYSTEM fallback result is
        // cached with the usual ≤30s resolver TTL (established discipline —
        // the consumer keeps being served by system AI, a valid tier, until
        // the cache expires; a stale cache can never EXTEND sharing).
        const withinTtl = await workspaceAi.resolveAIForWorkspace(wsB);
        expect(withinTtl.source).to.not.equal('shared');
        workspaceAi.invalidateCache(wsB);
        const afterTtl = await workspaceAi.resolveAIForWorkspace(wsB);
        expect(afterTtl.source).to.equal('shared');
    });

    it('17b. resolveAIProvider purpose tag does not re-tag shared snapshots as unconfigured', async () => {
        const tagged = await workspaceAi.resolveAIProvider(wsB, 'chat');
        expect(tagged.source).to.equal('shared');
        expect(tagged.transport).to.equal('connector');
        expect(tagged.purpose).to.equal('chat');
    });
});
