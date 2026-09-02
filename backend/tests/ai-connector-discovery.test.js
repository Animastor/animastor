// ======================================================
// LLM Connector Runtime Discovery Tests (LAC-3 — Local AI Connector V1 Phase 3)
// ======================================================
// Coverage (docs/04-planning/local-ai-connector-v1.md §3.4, §4, §6, §7, §10,
// §15-Phase-3, AD-5, AD-6, AD-7):
//
//   ADAPTER (connector-side seam, local-ai-connector/lib):
//     successful /v1/models; several models; empty list; unknown fields
//     dropped; malformed JSON; wrong structure; oversized response;
//     runtime timeout; connection refused; runtime HTTP error; hostile
//     redirect refused; fixed single path; multi-runtime mapping.
//   CONFIG (connector side):
//     loopback default enforced; --allow-lan opt-in; runtime-type allowlist;
//     ws:// off-loopback refused; token shape validated (no echo).
//   SESSION (connector side):
//     models.refresh → exactly ONE /v1/models fetch → models.list reply;
//     concurrent refreshes coalesce (no local fan-out); heartbeat models
//     only after discovery; no discovery before ready (no auto probes).
//   CLOUD (backend WS + discovery service + HTTP):
//     models.refresh → models.list → PG models updated + last_seen;
//     failure codes sanitized (no frame echo); unknown/unsolicited
//     models.list ignored; discovery error does NOT break the WS session;
//     models.refresh does NOT close or destabilize the session (heartbeats
//     still flow after); concurrent refresh coalescing server-side;
//     refresh on dead session fails fast; models.list as liveness proof;
//     GET /models + GET /status (workspace-scoped, no secrets);
//     cross-workspace isolation (401/no leakage); plaintext credentials
//     never in logs; chat.* frames still unknown/ignored (no inference);
//     client-supplied url fields on frames are ignored (no URL substitution).
// ======================================================

const { expect } = require('chai');
const http = require('http');
const crypto = require('crypto');
const { WebSocket } = require('ws');
const express = require('express');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const repo = require('../src/storage/postgres/repositories/ai-connector-repo');
const registry = require('../src/services/ai-connector/registry');
const discovery = require('../src/services/ai-connector/discovery');
const { createWsHandler, createAiConnectorRoutes } = require('../src/routes/ai-connector-routes.cjs');
const { createMockRedis } = require('./mocks/redis-mock');

// Connector-side modules (the distributable) — tested directly here so the
// runtime adapter seam is exercised against REAL HTTP servers. (.cjs files
// must be required with their explicit extension.)
const {
    discoverModels,
    normalizeOpenAiModels,
    getAdapter,
} = require('../../local-ai-connector/lib/runtime-adapters/index.cjs');
const { parseConfig } = require('../../local-ai-connector/lib/config.cjs');
const { createConnectorSession } = require('../../local-ai-connector/lib/connector.cjs');

const stamp = `lac3${Date.now()}`;

// ── shared helpers ────────────────────────────────────────────────────────

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

async function rawRow(connectorId) {
    const { rows } = await query(`SELECT * FROM ai_connectors WHERE connector_id = $1`, [connectorId]);
    return rows[0] || null;
}

async function createActivatedConnector(workspaceId, name, runtimeType = 'ollama') {
    const { connector, regToken } = await repo.createConnector({ workspaceId, name, runtimeType });
    const act = await repo.activateConnector(regToken);
    if (!act.ok) throw new Error(`activation failed: ${act.reason}`);
    return { connector, token: act.token };
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

// ── fake local runtime (OpenAI-compatible) ────────────────────────────────

function startFakeRuntime(handler, { port } = {}) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            // Request accounting: path + query for the no-arbitrary-paths and
            // no-inference assertions. Body is never read (GET only).
            server.requests.push({ path: req.url, method: req.method });
            handler(req, res);
        });
        server.requests = [];
        server.listen(port || 0, '127.0.0.1', () => {
            server.port = server.address().port;
            server.baseUrl = `http://127.0.0.1:${server.port}`;
            server.close = (() => {
                const orig = server.close.bind(server);
                return () => new Promise((r) => orig(r));
            })();
            resolve(server);
        });
    });
}

const openAiModels = (ids, extra = {}) => ({
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model', created: 1700000000, owned_by: 'library', ...extra })),
});

// ── backend WS harness ────────────────────────────────────────────────────

function startWsServer(options = {}) {
    const redis = createMockRedis();
    const logLines = [];
    const logger = {
        info: (m) => logLines.push(String(m)),
        warn: (m) => logLines.push(String(m)),
        error: (m) => logLines.push(String(m)),
    };
    const handler = createWsHandler({ redis, logger, options });
    const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    handler.attachUpgrade(server);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                redis,
                logLines,
                handler,
                server,
                url: `ws://127.0.0.1:${port}/api/v1/ai-connector/ws`,
                close: () => new Promise((r) => {
                    handler.shutdown();
                    server.close(() => r());
                }),
            });
        });
    });
}

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

function send(ws, obj) {
    ws.send(JSON.stringify(obj));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Scriptable in-process socket for unit-driving the connector session. */
function makeScriptedSocket() {
    const handlers = {};
    const sent = [];
    return {
        readyState: 0,
        sent,
        on(event, fn) { (handlers[event] = handlers[event] || []).push(fn); },
        emit(event, ...args) {
            (handlers[event] || []).slice().forEach((fn) => fn(...args));
        },
        send(raw) { sent.push(JSON.parse(raw)); },
        close() {
            if (this.readyState !== 3) {
                this.readyState = 3;
                this.emit('close');
            }
        },
    };
}

const HELLO = (credential) => ({ type: 'hello', protocol_version: 1, credential });

/** Authenticated live session on the given server; returns { ws, ready } */
async function openSession(srv, token) {
    const ws = await connect(srv.url);
    send(ws, HELLO(token));
    const ready = await nextMessage(ws);
    return { ws, ready };
}

// ══════════════════════════════════════════════════════════════════════════
// 1. Runtime adapter (connector-side seam) — the /v1/models matrix
// ══════════════════════════════════════════════════════════════════════════

describe('LAC-3 adapter: openai-compatible /v1/models (connector side)', function () {
    this.timeout(20000);

    it('successful discovery → normalized string[] of model ids', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiModels(['qwen3:32b', 'llama3:8b'])));
        });
        try {
            const res = await discoverModels({ baseUrl: rt.baseUrl });
            expect(res.ok).to.equal(true);
            expect(res.models).to.deep.equal(['qwen3:32b', 'llama3:8b']);
            expect(rt.requests).to.have.lengthOf(1);
            expect(rt.requests[0].path).to.equal('/v1/models');
            expect(rt.requests[0].method).to.equal('GET');
        } finally {
            await rt.close();
        }
    });

    it('several models → order preserved, all ids carried', async () => {
        const ids = ['m1', 'm2', 'm3', 'm4', 'm5'];
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiModels(ids)));
        });
        try {
            const res = await discoverModels({ baseUrl: rt.baseUrl });
            expect(res.models).to.deep.equal(ids);
        } finally {
            await rt.close();
        }
    });

    it('empty list → ok with [] (honest empty runtime state)', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: [] }));
        });
        try {
            const res = await discoverModels({ baseUrl: rt.baseUrl });
            expect(res.ok).to.equal(true);
            expect(res.models).to.deep.equal([]);
        } finally {
            await rt.close();
        }
    });

    it('unknown/unsupported fields are DROPPED at the seam', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                object: 'list',
                data: [{ id: 'm1', object: 'model', created: 1, owned_by: 'x', evil: 'payload', nested: { a: 1 } }],
                hostile_top: 'field',
            }));
        });
        try {
            const res = await discoverModels({ baseUrl: rt.baseUrl });
            expect(res.ok).to.equal(true);
            expect(res.models).to.deep.equal(['m1']); // ids only — nothing else
        } finally {
            await rt.close();
        }
    });

    it('malformed JSON → bad_response', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('this is not json {{{');
        });
        try {
            const res = await discoverModels({ baseUrl: rt.baseUrl });
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('bad_response');
        } finally {
            await rt.close();
        }
    });

    it('wrong structure (data not an array / non-object) → bad_response', async () => {
        for (const payload of [{ models: ['a'] }, [1, 2, 3], null, { data: 'nope' }]) {
            const rt = await startFakeRuntime((req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(payload));
            });
            try {
                const res = await discoverModels({ baseUrl: rt.baseUrl });
                expect(res.ok).to.equal(false, JSON.stringify(payload));
                expect(res.code).to.equal('bad_response');
            } finally {
                await rt.close();
            }
        }
    });

    it('oversized response → response_too_large (stream aborted, not buffered)', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write('{"data":[');
            const pad = 'x'.repeat(64 * 1024);
            // ~10 MB — far beyond the 512 KB cap.
            for (let i = 0; i < 160; i++) res.write(`"${pad}",`);
            res.end('"end"]}');
        });
        try {
            const res = await discoverModels({ baseUrl: rt.baseUrl, maxResponseBytes: 512 * 1024 });
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('response_too_large');
        } finally {
            await rt.close();
        }
    });

    it('runtime timeout → sanitized timeout code', async function () {
        this.timeout(10000);
        const rt = await startFakeRuntime((req, res) => {
            // Never respond within the window.
        });
        try {
            const res = await discoverModels({ baseUrl: rt.baseUrl, timeoutMs: 200 });
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('timeout');
        } finally {
            await rt.close();
        }
    });

    it('connection refused → runtime_unreachable (no infra detail)', async () => {
        // Grab a free port then close the server → nothing listens there.
        const dead = await startFakeRuntime(() => {});
        const deadBase = dead.baseUrl;
        await dead.close();
        const res = await discoverModels({ baseUrl: deadBase });
        expect(res.ok).to.equal(false);
        expect(res.code).to.equal('runtime_unreachable');
    });

    it('runtime HTTP error (500 / 404) → sanitized runtime_error, body never read', async () => {
        for (const status of [404, 500, 503]) {
            const rt = await startFakeRuntime((req, res) => {
                res.writeHead(status, { 'Content-Type': 'text/plain' });
                res.end(`internal detail for status ${status} — must never surface`);
            });
            try {
                const res = await discoverModels({ baseUrl: rt.baseUrl });
                expect(res.ok).to.equal(false);
                expect(res.code).to.equal('runtime_error');
                expect(JSON.stringify(res)).to.not.include('internal detail');
            } finally {
                await rt.close();
            }
        }
    });

    it('redirect following is REFUSED (redirect: error discipline)', async () => {
        const target = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiModels(['redirected'])));
        });
        const redirector = await startFakeRuntime((req, res) => {
            res.writeHead(302, { Location: `${target.baseUrl}/v1/models` });
            res.end();
        });
        try {
            const res = await discoverModels({ baseUrl: redirector.baseUrl });
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('runtime_unreachable'); // redirect → fetch error family
            expect(target.requests).to.have.lengthOf(0); // never followed
        } finally {
            await redirector.close();
            await target.close();
        }
    });

    it('the adapter requests ONLY the fixed path — never anything else', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [] }));
        });
        try {
            await discoverModels({ baseUrl: rt.baseUrl });
            expect(rt.requests).to.have.lengthOf(1);
            expect(rt.requests[0].path).to.equal('/v1/models');
        } finally {
            await rt.close();
        }
    });

    it('normalizeOpenAiModels: dedupe, control-char ids, length caps, wrong types', () => {
        expect(normalizeOpenAiModels({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] }).models).to.deep.equal(['a', 'b']);
        expect(normalizeOpenAiModels({ data: [{ id: 'x\u0000y' }, { id: 'ok' }] }).models).to.deep.equal(['ok']);
        expect(normalizeOpenAiModels({ data: [{ id: 'x'.repeat(600) }, { id: 'ok' }] }).models).to.deep.equal(['ok']);
        expect(normalizeOpenAiModels({ data: [{ id: 42 }, { id: null }, 'str', { id: 'ok' }] }).models).to.deep.equal(['ok']);
        expect(normalizeOpenAiModels({ data: [] }).models).to.deep.equal([]);
        expect(normalizeOpenAiModels({ data: [{ id: 'a' }] }).ok).to.equal(true);
        expect(normalizeOpenAiModels(null).ok).to.equal(false);
        expect(normalizeOpenAiModels({}).ok).to.equal(false);
        const many = { data: Array.from({ length: 400 }, (_, i) => ({ id: `m${i}` })) };
        expect(normalizeOpenAiModels(many).models).to.have.lengthOf(256);
    });

    it('runtime adapter registry: every V1 runtime type maps to the seam; unknown → null', () => {
        for (const rt of ['ollama', 'vllm', 'llamacpp', 'lmstudio', 'openai-compatible']) {
            expect(getAdapter(rt)).to.not.equal(null);
        }
        expect(getAdapter('gpu-hub')).to.equal(null);
        expect(getAdapter(undefined)).to.equal(null);
    });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. Connector config — loopback enforcement, no URL from outside
// ══════════════════════════════════════════════════════════════════════════

describe('LAC-3 connector config (local-ai-connector/lib/config)', () => {
    const baseArgs = ['--url', 'wss://animastor.example/api/v1/ai-connector/ws', '--token', 'llmc.aGVsbG8.aGVsbG8'];

    it('default base URL is loopback Ollama', () => {
        const res = parseConfig(baseArgs);
        expect(res.ok).to.equal(true);
        expect(res.config.baseUrl).to.equal('http://127.0.0.1:11434');
    });

    it('non-loopback base URL refused without --allow-lan', () => {
        const res = parseConfig([...baseArgs, '--base-url', 'http://192.168.1.50:11434']);
        expect(res.ok).to.equal(false);
        expect(res.errors.join(' ')).to.include('loopback');
    });

    it('non-loopback base URL allowed ONLY with explicit --allow-lan', () => {
        const res = parseConfig([...baseArgs, '--base-url', 'http://192.168.1.50:11434', '--allow-lan']);
        expect(res.ok).to.equal(true);
        expect(res.config.allowLan).to.equal(true);
    });

    it('runtime-type allowlist enforced; unknown type refused', () => {
        expect(parseConfig([...baseArgs, '--runtime-type', 'ollama']).ok).to.equal(true);
        expect(parseConfig([...baseArgs, '--runtime-type', 'gpu-hub']).ok).to.equal(false);
    });

    it('plain ws:// refused off-loopback (wss mandatory)', () => {
        const bad = ['--url', 'ws://animastor.example/api/v1/ai-connector/ws', '--token', 'llmc.a.a'];
        expect(parseConfig(bad).ok).to.equal(false);
        const okLoop = ['--url', 'ws://127.0.0.1:8080/api/v1/ai-connector/ws', '--token', 'llmc.a.a'];
        expect(parseConfig(okLoop).ok).to.equal(true);
    });

    it('token must match the llmc.*/llmcreg.* shape; garbage refused', () => {
        expect(parseConfig([...baseArgs, '--token', 'not-a-token']).ok).to.equal(false);
        expect(parseConfig(baseArgs).ok).to.equal(true);
        const reg = parseConfig(['--url', baseArgs[1], '--token', 'llmcreg.aGVsbG8.aGVsbG8']);
        expect(reg.ok).to.equal(true);
    });

    it('token material is never echoed in validation errors', () => {
        const secret = 'llmc.aGVsbG8.T1VSU0VDUkVUU0VDUkVU';
        const res = parseConfig(['--url', 'wss://x.example/ws', '--token', 'nope-'.repeat(10)]);
        expect(res.ok).to.equal(false);
        expect(JSON.stringify(res)).to.not.include('T1VSU0VDUkVU');
        expect(JSON.stringify(res)).to.not.include(secret);
    });

    it('unknown CLI flags rejected (no hidden surface)', () => {
        expect(parseConfig([...baseArgs, '--execute', 'rm -rf /']).ok).to.equal(false);
        expect(parseConfig([...baseArgs, '--proxy-url', 'http://evil']).ok).to.equal(false);
    });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. Connector session — refresh → ONE local fetch; no auto probes
// ══════════════════════════════════════════════════════════════════════════

describe('LAC-3 connector session (local-ai-connector/lib/connector)', function () {
    this.timeout(20000);

    it('models.refresh → exactly ONE /v1/models fetch → models.list; hostile URL fields ignored', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiModels(['m1', 'm2'])));
        });
        const attacker = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiModels(['hijacked'])));
        });
        const sock = makeScriptedSocket();
        const session = createConnectorSession({
            config: { url: 'ws://127.0.0.1:1/ws', token: 'llmc.aGVsbG8.aGVsbG8', baseUrl: rt.baseUrl, runtimeType: 'ollama' },
            WebSocketImpl: function Stub() { return sock; },
            heartbeatCacheTtlMs: 60000, // long TTL: heartbeat ticks do NOT re-probe
        });
        session.start();
        sock.readyState = 1;
        sock.emit('open'); // session sends hello
        const hello = sock.sent.find((f) => f.type === 'hello');
        expect(hello).to.exist;
        expect(hello.credential).to.equal('llmc.aGVsbG8.aGVsbG8');

        sock.emit('message', JSON.stringify({ type: 'ready', connector_id: 'c1', heartbeat_interval_ms: 60000 }));
        sock.emit('message', JSON.stringify({ type: 'models.refresh' }));
        await wait(80);

        let lists = sock.sent.filter((f) => f.type === 'models.list');
        expect(lists).to.have.lengthOf(1);
        expect(lists[0].models).to.deep.equal(['m1', 'm2']);
        // Exactly one local runtime fetch for one explicit refresh.
        expect(rt.requests).to.have.lengthOf(1);
        expect(rt.requests[0].path).to.equal('/v1/models');

        // A hostile/broken server attaching URL fields changes NOTHING: the
        // session reads `type` only (AD-5 — no URL ever crosses the protocol).
        sock.emit('message', JSON.stringify({
            type: 'models.refresh',
            base_url: attacker.baseUrl,
            url: `${attacker.baseUrl}/v1/models`,
            runtime_url: attacker.baseUrl,
        }));
        await wait(80);
        lists = sock.sent.filter((f) => f.type === 'models.list');
        expect(lists).to.have.lengthOf(2);
        expect(rt.requests).to.have.lengthOf(2);
        for (const req of rt.requests) expect(req.path).to.equal('/v1/models');
        expect(attacker.requests).to.have.lengthOf(0); // the attacker got nothing

        session.stop();
        await rt.close();
        await attacker.close();
    });

    it('concurrent refreshes coalesce — the local runtime sees ONE request', async () => {
        let runtimeHits = 0;
        let release = null;
        const gate = new Promise((r) => { release = r; });
        const rt = await startFakeRuntime(async (req, res) => {
            runtimeHits += 1;
            await gate; // hold the response until the burst has been issued
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiModels(['slow-model'])));
        });

        const sent = [];
        const session = createConnectorSession({
            config: { url: 'ws://127.0.0.1:1/ws', token: 'llmc.a.b', baseUrl: rt.baseUrl, runtimeType: 'ollama' },
            WebSocketImpl: function Stub() {
                return {
                    readyState: 1,
                    on: () => {},
                    send: (raw) => sent.push(JSON.parse(raw)),
                    close: () => {},
                };
            },
        });
        session.start();
        // Unit-level drive: scripted ready, then a burst of refreshes while
        // the runtime response is held back by the gate.
        session._handleMessage(JSON.stringify({ type: 'ready', connector_id: 'c', heartbeat_interval_ms: 60000 }));
        await new Promise((r) => setTimeout(r, 10));
        session._handleMessage(JSON.stringify({ type: 'models.refresh' }));
        session._handleMessage(JSON.stringify({ type: 'models.refresh' }));
        session._handleMessage(JSON.stringify({ type: 'models.refresh' }));
        await new Promise((r) => setTimeout(r, 30));
        release();
        await new Promise((r) => setTimeout(r, 50));

        expect(runtimeHits).to.equal(1); // coalesced — no fan-out
        const lists = sent.filter((f) => f.type === 'models.list');
        expect(lists.length).to.equal(1);
        expect(lists[0].models).to.deep.equal(['slow-model']);
        session.stop();
        await rt.close();
    });

    it('no discovery before ready — the connector never auto-probes (AD-7)', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiModels(['never'])));
        });
        const session = createConnectorSession({
            config: { url: 'ws://127.0.0.1:1/ws', token: 'llmc.a.b', baseUrl: rt.baseUrl, runtimeType: 'ollama' },
            WebSocketImpl: function Stub() {
                return { readyState: 1, on: () => {}, send: () => {}, close: () => {} };
            },
        });
        session.start();
        // Session connects but receives NO ready — no discovery may happen.
        await new Promise((r) => setTimeout(r, 50));
        expect(rt.requests).to.have.lengthOf(0);
        session.stop();
        await rt.close();
    });

    it('heartbeat facts come only from the discovery cache; runtime_ok reflects reality', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiModels(['hb-model'])));
        });
        const sent = [];
        const session = createConnectorSession({
            config: { url: 'ws://127.0.0.1:1/ws', token: 'llmc.a.b', baseUrl: rt.baseUrl, runtimeType: 'ollama' },
            WebSocketImpl: function Stub() {
                return { readyState: 1, on: () => {}, send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };
            },
            heartbeatCacheTtlMs: 60000,
        });
        session.start();
        session._handleMessage(JSON.stringify({ type: 'ready', connector_id: 'c', heartbeat_interval_ms: 60000 }));
        // First heartbeat fires immediately after ready (pre-discovery).
        await new Promise((r) => setTimeout(r, 10));
        let hb = sent.filter((f) => f.type === 'heartbeat').pop();
        expect(hb).to.exist;
        expect(hb.runtime_ok).to.be.undefined; // nothing observed yet — honest
        expect(hb.models).to.be.undefined;     // no models observed → field omitted (no PG wipe)

        // Explicit refresh fills the cache…
        session._handleMessage(JSON.stringify({ type: 'models.refresh' }));
        await new Promise((r) => setTimeout(r, 60));
        // …then the next heartbeat carries the observed facts.
        session._sendHeartbeat();
        hb = sent.filter((f) => f.type === 'heartbeat').pop();
        expect(hb.runtime_ok).to.equal(true);
        expect(hb.models).to.deep.equal(['hb-model']);
        expect(hb.latency_ms).to.be.undefined; // AD-7: no latency without traffic
        session.stop();
        await rt.close();
    });

    it('failed discovery → models.list carries the sanitized allowlisted code', async () => {
        const dead = await startFakeRuntime(() => {});
        const deadBase = dead.baseUrl;
        await dead.close();
        const sent = [];
        const session = createConnectorSession({
            config: { url: 'ws://127.0.0.1:1/ws', token: 'llmc.a.b', baseUrl: deadBase, runtimeType: 'ollama' },
            WebSocketImpl: function Stub() {
                return { readyState: 1, on: () => {}, send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };
            },
        });
        session.start();
        session._handleMessage(JSON.stringify({ type: 'ready', connector_id: 'c', heartbeat_interval_ms: 60000 }));
        await new Promise((r) => setTimeout(r, 10));
        session._handleMessage(JSON.stringify({ type: 'models.refresh' }));
        await new Promise((r) => setTimeout(r, 60));
        const list = sent.filter((f) => f.type === 'models.list').pop();
        expect(list).to.exist;
        expect(list.error_code).to.equal('runtime_unreachable');
        session.stop();
    });
});

// ══════════════════════════════════════════════════════════════════════════
// 4. Cloud side — discovery service + WS route + HTTP surfaces (real PG)
// ══════════════════════════════════════════════════════════════════════════

describe('LAC-3 cloud: discovery over WS + state + HTTP (LAC-3 integration)', function () {
    this.timeout(60000);

    let srv;
    let wsA, wsB;
    let userA, userB;
    let httpSrv;

    before(async function () {
        await runMigrations();
        await cleanup();
        wsA = await createWorkspace('lac3A');
        wsB = await createWorkspace('lac3B');
        userA = await createUser('lac3U_a');
        userB = await createUser('lac3U_b');
        srv = await startWsServer({
            authTimeoutMs: 5000,
            heartbeatTimeoutMs: 30000,
            pgWriteIntervalMs: 0,
        });
        // HTTP surface (status/models) on an ephemeral express app.
        const redis = createMockRedis();
        const app = express();
        app.use(express.json());
        app.use((req, res, next) => {
            const id = req.headers['x-test-identity'];
            req.user = id ? JSON.parse(id).user : null;
            req.guest = id ? (JSON.parse(id).guest || null) : null;
            req.workspace = id ? (JSON.parse(id).workspace || null) : null;
            next();
        });
        createAiConnectorRoutes({ redis })(app);
        httpSrv = await new Promise((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve({
                base: `http://127.0.0.1:${s.address().port}`,
                close: () => new Promise((r) => s.close(r)),
            }));
        });
    });

    after(async function () {
        if (srv) await srv.close().catch(() => {});
        if (httpSrv) await httpSrv.close().catch(() => {});
        await cleanup();
    });

    async function api(method, path, { identity } = {}) {
        const res = await fetch(`${httpSrv.base}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'x-test-identity': JSON.stringify(identity || {}),
            },
        });
        let json = null;
        try { json = await res.json(); } catch (_) {}
        return { status: res.status, body: json };
    }
    const idA = () => ({ user: { userId: userA }, workspace: { id: wsA } });
    const idB = () => ({ user: { userId: userB }, workspace: { id: wsB } });

    it('successful refresh: models.refresh → models.list → PG models replaced + last_seen stamped', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'disc-ok');
        const { ws, ready } = await openSession(srv, token);
        expect(ready.type).to.equal('ready');

        const p = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 5000 });
        const refresh = await nextMessage(ws);
        expect(refresh.type).to.equal('models.refresh');
        expect(Object.keys(refresh)).to.deep.equal(['type']); // NO payload, NO url

        send(ws, { type: 'models.list', models: ['qwen3:32b', 'llama3:8b'], whatever: 'dropped' });
        const res = await p;

        expect(res.ok).to.equal(true);
        expect(res.models).to.deep.equal(['qwen3:32b', 'llama3:8b']);
        const row = await rawRow(connector.connector_id);
        expect(row.models).to.deep.equal(['qwen3:32b', 'llama3:8b']);
        expect(row.status).to.equal('online');
        expect(Number(row.last_seen)).to.be.at.most(Date.now());

        ws.close();
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('repeat refresh correctly REPLACES the stored state (no stale merge)', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'disc-repeat');
        const { ws } = await openSession(srv, token);

        const p1 = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 5000 });
        const r1 = await nextMessage(ws);
        expect(r1.type).to.equal('models.refresh');
        send(ws, { type: 'models.list', models: ['a', 'b'] });
        const res1 = await p1;
        expect(res1.models).to.deep.equal(['a', 'b']);

        const p2 = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 5000 });
        await nextMessage(ws);
        send(ws, { type: 'models.list', models: ['c'] });
        const res2 = await p2;
        expect(res2.models).to.deep.equal(['c']);

        const row = await rawRow(connector.connector_id);
        expect(row.models).to.deep.equal(['c']); // replaced, not merged
        ws.close();
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('empty models list persists [] — honest empty runtime state', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'disc-empty');
        const { ws } = await openSession(srv, token);
        const p = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 5000 });
        await nextMessage(ws);
        send(ws, { type: 'models.list', models: [] });
        const res = await p;
        expect(res.ok).to.equal(true);
        expect(res.models).to.deep.equal([]);
        expect((await rawRow(connector.connector_id)).models).to.deep.equal([]);
        ws.close();
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('discovery error → sanitized allowlisted code; previously stored models NOT wiped', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'disc-err');
        const { ws } = await openSession(srv, token);
        // Seed state via heartbeat first.
        send(ws, { type: 'heartbeat', models: ['keep-me'], runtime_ok: true });
        await new Promise((r) => setTimeout(r, 40));

        const p = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 5000 });
        await nextMessage(ws);
        send(ws, { type: 'models.list', models: [], error_code: 'runtime_unreachable' });
        const res = await p;
        expect(res.ok).to.equal(false);
        expect(res.code).to.equal('runtime_unreachable');
        const row = await rawRow(connector.connector_id);
        expect(row.models).to.deep.equal(['keep-me']); // untouched by the failure
        ws.close();
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('non-allowlisted error_code degrades to the generic sanitized code (no echo)', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'disc-echo');
        const { ws } = await openSession(srv, token);
        const p = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 5000 });
        await nextMessage(ws);
        const hostile = 'SECRET-HOSTILE-PAYLOAD-'.repeat(5);
        send(ws, { type: 'models.list', models: [], error_code: hostile });
        const res = await p;
        expect(res.ok).to.equal(false);
        expect(res.code).to.equal('discovery_failed');
        expect(JSON.stringify(res)).to.not.include('SECRET-HOSTILE-PAYLOAD');
        ws.close();
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('malformed models.list (wrong structure) → invalid_models_list; session survives', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'disc-malformed');
        const { ws } = await openSession(srv, token);
        const closed = new Promise((resolve) => ws.once('close', resolve));

        const p = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 5000 });
        await nextMessage(ws);
        send(ws, { type: 'models.list', models: 'not-an-array' });
        const res = await p;
        expect(res.ok).to.equal(false);
        expect(res.code).to.equal('invalid_models_list');

        // The authenticated session MUST still be alive.
        await new Promise((r) => setTimeout(r, 30));
        const race = await Promise.race([closed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('open'), 100))]);
        expect(race).to.equal('open');
        send(ws, { type: 'heartbeat', runtime_ok: true });
        await new Promise((r) => setTimeout(r, 30));
        expect((await rawRow(connector.connector_id)).status).to.equal('online');
        ws.close();
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('discovery failure does NOT break the authenticated WS session; heartbeats keep flowing after', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'disc-no-break');
        const { ws } = await openSession(srv, token);
        const closed = new Promise((resolve) => ws.once('close', resolve));

        // Timeout variant: no reply at all.
        const p1 = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 150 });
        const r1 = await p1;
        expect(r1).to.deep.equal({ ok: false, code: 'timeout' });
        await new Promise((r) => setTimeout(r, 30));

        // Session still alive → heartbeat works, PG online.
        send(ws, { type: 'heartbeat', models: ['after'], runtime_ok: true });
        await new Promise((r) => setTimeout(r, 40));
        const row = await rawRow(connector.connector_id);
        expect(row.status).to.equal('online');
        expect(row.models).to.deep.equal(['after']);

        // Error variant: session STILL alive.
        const p2 = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 5000 });
        await nextMessage(ws);
        send(ws, { type: 'models.list', error_code: 'timeout' });
        const r2 = await p2;
        expect(r2.ok).to.equal(false);
        send(ws, { type: 'heartbeat', models: ['after2'], runtime_ok: true });
        await new Promise((r) => setTimeout(r, 40));
        expect((await rawRow(connector.connector_id)).models).to.deep.equal(['after2']);

        const race = await Promise.race([closed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('open'), 100))]);
        expect(race).to.equal('open');
        ws.close();
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('concurrent refresh callers COALESCE onto one in-flight refresh (no fan-out)', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'disc-coalesce');
        const { ws } = await openSession(srv, token);

        const p1 = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 5000 });
        const p2 = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 5000 });
        const p3 = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 5000 });

        const r1 = await nextMessage(ws);
        expect(r1.type).to.equal('models.refresh');
        // Let any (wrong) extra frames surface.
        await new Promise((r) => setTimeout(r, 50));
        send(ws, { type: 'models.list', models: ['one', 'two'] });
        const results = await Promise.all([p1, p2, p3]);
        for (const res of results) {
            expect(res.ok).to.equal(true);
            expect(res.models).to.deep.equal(['one', 'two']);
        }
        ws.close();
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('refresh on an OFFLINE connector → connector_offline, no frame anywhere', async () => {
        const { connector } = await createActivatedConnector(wsA, 'disc-offline');
        const res = await discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 1000 });
        expect(res.ok).to.equal(false);
        expect(res.code).to.equal('connector_offline');
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('socket dying mid-refresh fails the pending refresh FAST (session_closed, not timeout)', async function () {
        this.timeout(15000);
        const { connector, token } = await createActivatedConnector(wsA, 'disc-dead');
        const { ws } = await openSession(srv, token);
        const p = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 10000 });
        await nextMessage(ws); // refresh frame went out
        ws.close();
        const res = await p;
        expect(res.ok).to.equal(false);
        expect(res.code).to.equal('session_closed');
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('UNSOLICITED models.list (no pending refresh) is ignored — never persisted', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'disc-unsolicited');
        const { ws } = await openSession(srv, token);
        send(ws, { type: 'heartbeat', models: ['legit'], runtime_ok: true });
        await new Promise((r) => setTimeout(r, 40));
        send(ws, { type: 'models.list', models: ['injected-by-connector'] });
        await new Promise((r) => setTimeout(r, 60));
        const row = await rawRow(connector.connector_id);
        expect(row.models).to.deep.equal(['legit']); // injection dropped
        ws.close();
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('hostile client CANNOT substitute the runtime URL — frames carry no URL field and extras are ignored', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'disc-url');
        const { ws } = await openSession(srv, token);
        const p = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 5000 });
        await nextMessage(ws);
        // The client tries everything: URL fields, extra fields, wrong ids.
        send(ws, {
            type: 'models.list',
            models: ['a', 5, { url: 'http://10.9.9.9/x' }, null],
            base_url: 'http://10.9.9.9:11434',
            url: 'http://10.9.9.9:11434/v1/models',
            endpoint: 'http://evil.example',
            target: 'file:///etc/passwd',
        });
        const res = await p;
        expect(res.ok).to.equal(true);
        expect(res.models).to.deep.equal(['a']); // only the string id survives
        ws.close();
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('model entries are normalized: dedupe, caps, non-string entries dropped', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'disc-norm');
        const { ws } = await openSession(srv, token);
        const p = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 5000 });
        await nextMessage(ws);
        send(ws, { type: 'models.list', models: ['dup', 'dup', '', 'x'.repeat(600), '   spaced   ', 42, { id: 'obj' }, 'ok'] });
        const res = await p;
        expect(res.ok).to.equal(true);
        expect(res.models).to.deep.equal(['dup', 'spaced', 'ok']);
        const row = await rawRow(connector.connector_id);
        expect(row.models).to.deep.equal(['dup', 'spaced', 'ok']);
        ws.close();
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('discovery refresh doubles as liveness proof (models.list resets the heartbeat timer)', async function () {
        this.timeout(15000);
        const { connector, token } = await createActivatedConnector(wsA, 'disc-liveness');
        const { ws } = await openSession(srv, token);
        const hbKey = `animastor:ai-connector:hb:${connector.connector_id}`;
        const before = await srv.redis.get(hbKey);
        expect(before).to.not.be.null;
        await new Promise((r) => setTimeout(r, 20));
        const p = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 5000 });
        await nextMessage(ws);
        send(ws, { type: 'models.list', models: ['x'] });
        await p;
        const after = await srv.redis.get(hbKey);
        expect(after).to.not.be.null;
        expect(JSON.parse(after).ts).to.be.at.least(JSON.parse(before).ts);
        ws.close();
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('discovery refresh NEVER sends inference frames — protocol has no chat.*', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'disc-noinfer');
        const { ws } = await openSession(srv, token);
        // Record every SERVER→CLIENT frame during the discovery flow.
        const incoming = [];
        ws.on('message', (data) => incoming.push(JSON.parse(data.toString())));

        const p = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 5000 });
        await nextMessage(ws);
        send(ws, { type: 'models.list', models: ['m'] });
        await p;
        await new Promise((r) => setTimeout(r, 50));

        // The ONLY server→client frame of discovery is models.refresh —
        // no payload, no request multiplexing, no message history, no URL.
        expect(incoming.length).to.be.at.least(1);
        for (const frame of incoming) {
            expect(frame.type).to.equal('models.refresh');
            expect(frame.request_id).to.be.undefined;
            expect(frame.messages).to.be.undefined;
            expect(frame.url).to.be.undefined;
            expect(frame.base_url).to.be.undefined;
        }
        // Chat message types are still unknown → ignored, no crash.
        send(ws, { type: 'chat.request', request_id: 'x', messages: [{ role: 'user', content: 'hi' }] });
        await new Promise((r) => setTimeout(r, 30));
        expect((await rawRow(connector.connector_id)).status).to.equal('online');
        ws.close();
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('plaintext credentials NEVER reach logs during discovery flows', async function () {
        this.timeout(15000);
        const { connector, token } = await createActivatedConnector(wsA, 'disc-loghyg');
        const secret = token.split('.')[2];
        const captured = await captureConsole(async () => {
            const { ws } = await openSession(srv, token);
            const p = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 5000 });
            await nextMessage(ws);
            send(ws, { type: 'models.list', error_code: 'timeout' });
            await p;
            // Malformed discovery reply too.
            const p2 = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 5000 });
            await nextMessage(ws);
            send(ws, 'garbage-not-json');
            const r2 = await p2;
            expect(r2.ok).to.equal(false);
            ws.close();
            await new Promise((r) => setTimeout(r, 30));
            return { token, secret };
        });
        const logged = captured.entries.map((e) => e.text).join('\n');
        expect(logged).to.not.include(captured.result.token);
        expect(logged).to.not.include(captured.result.secret);
        expect(logged).to.not.match(/llmc\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('discovery service has no HTTP surface of its own — PG-only truth', async () => {
        // The service module must not export any fetch/HTTP capability.
        const exportedFns = Object.entries(discovery).filter(([, v]) => typeof v === 'function').map(([k]) => k);
        for (const name of exportedFns) {
            const fn = discovery[name];
            expect(fn.toString()).to.not.match(/\bfetch\s*\(/);
        }
    });

    // ── HTTP surfaces ─────────────────────────────────────────────────────

    it('GET /status: workspace-scoped liveness+PG state, no secrets', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'http-status');
        const { ws } = await openSession(srv, token);
        send(ws, { type: 'heartbeat', models: ['s1'], runtime_ok: true });
        await new Promise((r) => setTimeout(r, 40));

        const ok = await api('GET', '/api/v1/ai-connector/status', { identity: idA() });
        expect(ok.status).to.equal(200);
        const row = ok.body.connectors.find((c) => c.connector_id === connector.connector_id);
        expect(row).to.exist;
        expect(row.live).to.equal(true);
        expect(row.status).to.equal('online');
        expect(row.models_count).to.equal(1);
        expect(JSON.stringify(ok.body)).to.not.include('token');
        expect(JSON.stringify(ok.body)).to.not.include('hash');

        const foreign = await api('GET', '/api/v1/ai-connector/status', { identity: idB() });
        expect(foreign.status).to.equal(200);
        expect(foreign.body.connectors.find((c) => c.connector_id === connector.connector_id)).to.be.undefined;

        const anon = await api('GET', '/api/v1/ai-connector/status');
        expect(anon.status).to.equal(401);
        ws.close();
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('GET /models: read-only PG surface — never triggers a runtime fetch, never secrets', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'http-models');
        const { ws } = await openSession(srv, token);
        const p = discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 5000 });
        await nextMessage(ws);
        send(ws, { type: 'models.list', models: ['m1', 'm2'] });
        await p;
        ws.close();
        await new Promise((r) => setTimeout(r, 30));

        const ok = await api('GET', '/api/v1/ai-connector/models', { identity: idA() });
        expect(ok.status).to.equal(200);
        const row = ok.body.connectors.find((c) => c.connector_id === connector.connector_id);
        expect(row).to.exist;
        expect(row.models).to.deep.equal(['m1', 'm2']);
        expect(row.live).to.equal(false); // session closed
        const flat = JSON.stringify(ok.body);
        expect(flat).to.not.include('token_prefix');
        expect(flat).to.not.include('llmc');

        const foreign = await api('GET', '/api/v1/ai-connector/models', { identity: idB() });
        expect(foreign.body.connectors.find((c) => c.connector_id === connector.connector_id)).to.be.undefined;
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('guest cannot read discovery surfaces (403)', async () => {
        const res = await api('GET', '/api/v1/ai-connector/models', {
            identity: { user: { userId: userA }, guest: { guestId: 'g' }, workspace: { id: wsA } },
        });
        expect(res.status).to.equal(403);
    });

    it('E2E: REAL connector distributable against the REAL backend WS + a REAL local runtime', async function () {
        this.timeout(30000);
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiModels(['qwen3:32b', 'nomic-embed-text'])));
        });
        const { connector, token } = await createActivatedConnector(wsA, 'e2e-full');
        const captured = await captureConsole(async () => {
            const session = createConnectorSession({
                config: {
                    url: srv.url,
                    token,
                    baseUrl: rt.baseUrl,
                    runtimeType: 'ollama',
                },
                WebSocketImpl: WebSocket,
                heartbeatCacheTtlMs: 10 * 60 * 1000, // keep the test deterministic
            });
            session.start();
            // Wait for ready + the immediate first heartbeat.
            await new Promise((r) => setTimeout(r, 400));

            // Explicit discovery via the real cloud service.
            const res = await discovery.requestModelsRefresh(connector.connector_id, { timeoutMs: 10000 });
            expect(res.ok).to.equal(true);
            expect(res.models).to.deep.equal(['qwen3:32b', 'nomic-embed-text']);

            // PG state updated by the cloud through the existing state path.
            const row = await rawRow(connector.connector_id);
            expect(row.models).to.deep.equal(['qwen3:32b', 'nomic-embed-text']);
            expect(row.status).to.equal('online');

            // NO automatic probes: the runtime saw exactly ONE fetch — the
            // explicit refresh (the immediate first heartbeat carried no
            // models and triggered no discovery, AD-7).
            expect(rt.requests.length).to.equal(1);
            expect(rt.requests[0].path).to.equal('/v1/models');
            expect(rt.requests[0].method).to.equal('GET');

            session.stop();
            return { token, secret: token.split('.')[2] };
        });
        const logged = captured.entries.map((e) => e.text).join('\n');
        expect(logged).to.not.include(captured.result.token);
        expect(logged).to.not.include(captured.result.secret);
        expect(logged).to.not.match(/llmc\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
        await rt.close();
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });
});
