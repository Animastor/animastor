// ======================================================
// LLM Connector Inference Tests (LAC-4 — Local AI Connector V1 Phase 4)
// ======================================================
// Coverage (docs/04-planning/local-ai-connector-v1.md §4 Phase-4 note, §5,
// §9, §10, §15-Phase-4, AD-5, AD-6, AD-12):
//
//   ADAPTER (connector-side seam, openai-compatible):
//     successful non-streaming completion; correct /v1/chat/completions
//     path; POST only; stream:false hardcoded; model/messages/params
//     forwarded; usage/finish_reason extracted; runtime 404 →
//     model_not_found; 400 context → context_length; 500 → runtime_error
//     (body never surfaced); connection refused → runtime_unreachable;
//     timeout; malformed JSON → bad_response; malformed OpenAI shape →
//     bad_response; oversized response → response_too_large; redirect
//     refused; arbitrary URL impossible; external signal → cancelled.
//   CONNECTOR SESSION (chat.request/chat.cancel over a scripted socket):
//     valid request → chat.response (request_id correlation); malformed
//     request / unknown fields / unknown message type; limit matrix
//     (messages count/size, prompt size, max_tokens, temperature,
//     oversized frame); model validation (missing/bad shape); concurrency
//     (cap 2 → busy, parallel independent requests, duplicate request_id
//     in-flight + after completion, slot release after success/error/
//     timeout/cancel); chat.cancel (abort + no frame back + session
//     survives; unknown id ignored); connector timeout → chat.error;
//     runtime model_not_found; no raw runtime error leakage; metadata-only
//     local logging (no prompt/response content).
//   CLOUD (transport service + WS route, real PG + real WS server):
//     end-to-end happy path through a REAL connector session against a
//     REAL fake runtime; request_id correlation; offline → fail-closed
//     explicit (AD-12); cloud-side validation (no frame sent on invalid
//     payload); sanitized error passthrough (unknown code degrades);
//     unsolicited/late chat frames ignored; cross-session settle refused;
//     reconnect: pending fails fast (session_closed) + works after;
//     authoritative cloud timeout → chat.cancel sent + connector aborts +
//     slot freed + session survives; unauthenticated inference attempt →
//     close; connector cannot send chat.request/chat.cancel (ignored);
//     no credential/Authorization/prompt/response leakage in logs.
// ======================================================

const { expect } = require('chai');
const http = require('http');
const crypto = require('crypto');
const { WebSocket } = require('ws');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const repo = require('../src/storage/postgres/repositories/ai-connector-repo');
const registry = require('../src/services/ai-connector/registry');
const transport = require('../src/services/ai-connector/transport');
const { createWsHandler } = require('../src/routes/ai-connector-routes.cjs');
const { createMockRedis } = require('./mocks/redis-mock');

// Connector-side modules (the distributable) — exercised against REAL HTTP
// runtimes and the REAL session code. (.cjs files must be required with
// their explicit extension.)
const {
    chatCompletion,
    normalizeOpenAiChatCompletion,
} = require('../../local-ai-connector/lib/runtime-adapters/index.cjs');
const chatLib = require('../../local-ai-connector/lib/chat.cjs');
const { createConnectorSession } = require('../../local-ai-connector/lib/connector.cjs');
const opLog = require('../../local-ai-connector/lib/log.cjs');

const stamp = `lac4${Date.now()}`;

// ── shared helpers ────────────────────────────────────────────────────────

async function createWorkspace(name) {
    const { rows } = await query(
        `INSERT INTO workspaces (name, type) VALUES ($1, 'personal') RETURNING id`,
        [`${name}-${stamp}`]
    );
    return rows[0].id;
}

async function cleanup() {
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

// ── fake local runtime (OpenAI-compatible, chat-aware) ────────────────────

/**
 * Scriptable fake runtime. Records every request (method, path, parsed
 * body); supports delayed responses and in-flight abort observation.
 */
function startFakeRuntime(handler, { hangMs = null } = {}) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            server.requests.push({ method: req.method, path: req.url, at: Date.now() });
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('close', () => { server.abortedCount += req.aborted ? 1 : 0; });
            req.on('end', () => {
                try { server.lastBody = body ? JSON.parse(body) : null; } catch (_) { server.lastBody = body; }
                if (hangMs != null) {
                    // Hang: never answer; the caller must abort. Mark that
                    // we saw the request then wait for the socket to drop.
                    server.hung.push({ path: req.url });
                    return; // deliberate no-response
                }
                handler(req, res, server);
            });
        });
        server.requests = [];
        server.hung = [];
        server.abortedCount = 0;
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

const openAiChat = (content, extra = {}) => ({
    id: 'cmpl-1',
    object: 'chat.completion',
    created: 1700000000,
    model: 'qwen3:32b',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    service_tier: 'free', // unknown field — must be dropped
    ...extra,
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

function nextClose(ws) {
    return new Promise((resolve) => {
        ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
}

function send(ws, obj) {
    ws.send(JSON.stringify(obj));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const HELLO = (credential) => ({ type: 'hello', protocol_version: 1, credential });

async function openSession(srv, token) {
    const ws = await connect(srv.url);
    send(ws, HELLO(token));
    const ready = await nextMessage(ws);
    return { ws, ready };
}

/** Scriptable in-process socket for unit-driving the connector session. */
function makeScriptedSocket() {
    const handlers = {};
    const sent = [];
    return {
        readyState: 1, // open — the session's send() requires it
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

/** Fresh connector session bound to a fake runtime via a scripted socket. */
function makeSession(runtimeBase) {
    const socket = makeScriptedSocket();
    const sent = socket.sent;
    const session = createConnectorSession({
        config: { url: 'ws://127.0.0.1:1/ws', token: 'llmc.a.b', baseUrl: runtimeBase, runtimeType: 'ollama' },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        WebSocketImpl: function Stub() { return socket; },
    });
    session.start();
    session._handleMessage(JSON.stringify({ type: 'ready', connector_id: 'c', heartbeat_interval_ms: 600000 }));
    return { session, sent, socket };
}

const CHAT_REQ = (requestId, overrides = {}) => ({
    type: 'chat.request',
    request_id: requestId,
    model: 'qwen3:32b',
    messages: [{ role: 'user', content: 'Hello there' }],
    params: { max_tokens: 128, temperature: 0.5 },
    timeout_ms: 5000,
    ...overrides,
});

// ══════════════════════════════════════════════════════════════════════════
// 1. Runtime adapter — POST /v1/chat/completions matrix (connector side)
// ══════════════════════════════════════════════════════════════════════════

describe('LAC-4 adapter: openai-compatible POST /v1/chat/completions', function () {
    this.timeout(20000);

    const MSGS = [{ role: 'user', content: 'Hi' }];

    it('successful completion → content, finish_reason, usage; POST + fixed path; stream:false hardcoded', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiChat('Local answer')));
        });
        try {
            const res = await chatCompletion({
                baseUrl: rt.baseUrl,
                model: 'qwen3:32b',
                messages: MSGS,
                maxTokens: 128,
                temperature: 0.5,
                timeoutMs: 3000,
            });
            expect(res.ok).to.equal(true);
            expect(res.content).to.equal('Local answer');
            expect(res.finishReason).to.equal('stop');
            expect(res.usage).to.deep.equal({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
            expect(res.rawBytes).to.be.a('number');

            expect(rt.requests).to.have.lengthOf(1);
            expect(rt.requests[0].method).to.equal('POST');
            expect(rt.requests[0].path).to.equal('/v1/chat/completions');
            expect(rt.lastBody.model).to.equal('qwen3:32b');
            expect(rt.lastBody.messages).to.deep.equal(MSGS);
            expect(rt.lastBody.max_tokens).to.equal(128);
            expect(rt.lastBody.temperature).to.equal(0.5);
            expect(rt.lastBody.stream).to.equal(false); // FORCED, always
        } finally {
            await rt.closeServer();
        }
    });

    it('omitted generation params are NOT sent in the body', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiChat('x')));
        });
        try {
            const res = await chatCompletion({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS });
            expect(res.ok).to.equal(true);
            expect(rt.lastBody).to.deep.equal({ model: 'm', messages: MSGS, stream: false });
        } finally {
            await rt.closeServer();
        }
    });

    it('no other path/method exists: GET /v1/chat/completions or POST /v1/models are never attempted', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiChat('x')));
        });
        try {
            await chatCompletion({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS });
            expect(rt.requests.map((r) => `${r.method} ${r.path}`)).to.deep.equal(['POST /v1/chat/completions']);
        } finally {
            await rt.closeServer();
        }
    });

    it('hostile caller options cannot redirect the target (arbitrary URL impossible)', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiChat('x')));
        });
        try {
            // A bogus url/endpoint option is not part of the API — it must
            // change nothing: the call still hits {base}/v1/chat/completions.
            await chatCompletion({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS, url: 'http://10.9.9.9/x', endpoint: 'http://evil.example' });
            expect(rt.requests[0].path).to.equal('/v1/chat/completions');
            expect(rt.baseUrl).to.contain('127.0.0.1');
        } finally {
            await rt.closeServer();
        }
    });

    it('runtime 404 → model_not_found (no infra detail)', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: "model 'nope' not found, installed models: [secret-list]" } }));
        });
        try {
            const res = await chatCompletion({ baseUrl: rt.baseUrl, model: 'nope', messages: MSGS });
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('model_not_found');
            expect(JSON.stringify(res)).to.not.include('secret-list');
        } finally {
            await rt.closeServer();
        }
    });

    it('runtime 400 context-overflow body → context_length (body classified, never echoed)', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Input length 99999 exceeds context window of 8192 SECRETDETAIL' } }));
        });
        try {
            const res = await chatCompletion({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS });
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('context_length');
            expect(JSON.stringify(res)).to.not.include('SECRETDETAIL');
        } finally {
            await rt.closeServer();
        }
    });

    it('runtime 400 (other) and 500 → runtime_error, body never surfaced', async () => {
        for (const [status, body] of [
            [400, { error: { message: 'bad request SECRET' } }],
            [500, { error: { message: 'CUDA OOM SECRET' } }],
            [503, 'plain text overload SECRET'],
        ]) {
            const rt = await startFakeRuntime((req, res) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(typeof body === 'string' ? body : JSON.stringify(body));
            });
            try {
                const res = await chatCompletion({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS });
                expect(res.ok).to.equal(false);
                expect(res.code).to.equal('runtime_error');
                expect(JSON.stringify(res)).to.not.include('SECRET');
            } finally {
                await rt.closeServer();
            }
        }
    });

    it('connection refused → runtime_unreachable', async () => {
        const dead = await startFakeRuntime(() => {});
        const deadBase = dead.baseUrl;
        await dead.closeServer();
        const res = await chatCompletion({ baseUrl: deadBase, model: 'm', messages: MSGS });
        expect(res.ok).to.equal(false);
        expect(res.code).to.equal('runtime_unreachable');
    });

    it('runtime timeout → sanitized timeout code', async function () {
        this.timeout(10000);
        const rt = await startFakeRuntime(null, { hangMs: true });
        try {
            const res = await chatCompletion({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS, timeoutMs: 200 });
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('timeout');
        } finally {
            await rt.closeServer();
        }
    });

    it('external abort signal → cancelled (chat.cancel path)', async function () {
        this.timeout(10000);
        const rt = await startFakeRuntime(null, { hangMs: true });
        try {
            const ac = new AbortController();
            const p = chatCompletion({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS, timeoutMs: 5000, signal: ac.signal });
            setTimeout(() => ac.abort(), 150);
            const res = await p;
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('cancelled');
        } finally {
            await rt.closeServer();
        }
    });

    it('malformed JSON → bad_response', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('not json {{{');
        });
        try {
            const res = await chatCompletion({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS });
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('bad_response');
        } finally {
            await rt.closeServer();
        }
    });

    it('malformed OpenAI completion (no choices / null content / usage junk) → bad_response', async () => {
        const payloads = [
            { choices: [] },
            { choices: [{ message: {} }] },
            { choices: [{ message: { content: null } }] },
            { choices: 'nope' },
            { no_choices: true },
            [1, 2, 3],
            null,
        ];
        for (const payload of payloads) {
            const rt = await startFakeRuntime((req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(payload));
            });
            try {
                const res = await chatCompletion({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS });
                expect(res.ok).to.equal(false, JSON.stringify(payload));
                expect(res.code).to.equal('bad_response');
            } finally {
                await rt.closeServer();
            }
        }
    });

    it('normalizeOpenAiChatCompletion drops unknown fields and junk usage', () => {
        const good = normalizeOpenAiChatCompletion(openAiChat('x', { usage: { prompt_tokens: 5, junk: 'a', completion_tokens: -3, total_tokens: 1e12 } }));
        expect(good.ok).to.equal(true);
        expect(good.usage).to.deep.equal({ prompt_tokens: 5, total_tokens: 1e9 }); // junk/bound applied
        expect(normalizeOpenAiChatCompletion(openAiChat('x', { usage: { junk: 1 } })).usage).to.equal(undefined);
        expect(normalizeOpenAiChatCompletion({})).to.deep.equal({ ok: false });
    });

    it('oversized response → response_too_large (stream aborted, not buffered)', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write('{"choices":[{"message":{"content":"');
            const pad = 'x'.repeat(64 * 1024);
            for (let i = 0; i < 40; i++) res.write(pad); // ~2.5 MB > 1 MB cap
            res.write('"}}]}');
            res.end();
        });
        try {
            const res = await chatCompletion({
                baseUrl: rt.baseUrl, model: 'm', messages: MSGS,
                maxResponseBytes: 1024 * 1024,
            });
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('response_too_large');
        } finally {
            await rt.closeServer();
        }
    });

    it('redirect is REFUSED (redirect: error discipline)', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(302, { Location: 'http://127.0.0.1:9/evil' });
            res.end();
        });
        try {
            const res = await chatCompletion({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS });
            expect(res.ok).to.equal(false);
            expect(['runtime_unreachable', 'runtime_error']).to.include(res.code);
            expect(rt.requests.map((r) => r.path)).to.deep.equal(['/v1/chat/completions']);
        } finally {
            await rt.closeServer();
        }
    });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. Connector session — chat.request / chat.cancel (scripted socket + real runtime)
// ══════════════════════════════════════════════════════════════════════════

describe('LAC-4 session: chat.request → chat.response/chat.error (connector side)', function () {
    this.timeout(20000);

    beforeEach(() => { opLog.reset(); });

    it('valid chat.request → chat.response with request_id correlation + usage', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiChat('Answer from local')));
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('req-1')));
            await wait(120);
            const resp = sent.find((f) => f.type === 'chat.response');
            expect(resp).to.exist;
            expect(resp.request_id).to.equal('req-1');
            expect(resp.model).to.equal('qwen3:32b');
            expect(resp.content).to.equal('Answer from local');
            expect(resp.finish_reason).to.equal('stop');
            expect(resp.usage).to.deep.equal({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
            expect(rt.requests).to.have.lengthOf(1); // exactly one runtime call
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('malformed / invalid requests → sanitized chat.error; runtime untouched', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiChat('x')));
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            const cases = [
                [CHAT_REQ('r-bad-model', { model: 42 }), 'invalid_request'],
                [CHAT_REQ('r-empty-model', { model: '   ' }), 'invalid_request'],
                [CHAT_REQ('r-ctrl-model', { model: 'bad\nmodel' }), 'invalid_request'],
                [CHAT_REQ('r-no-messages', { messages: [] }), 'invalid_request'],
                [CHAT_REQ('r-msgs-str', { messages: 'nope' }), 'invalid_request'],
                [CHAT_REQ('r-bad-role', { messages: [{ role: 'tool', content: 'x' }] }), 'invalid_request'],
                [CHAT_REQ('r-content-num', { messages: [{ role: 'user', content: 5 }] }), 'invalid_request'],
                [CHAT_REQ('r-empty-content', { messages: [{ role: 'user', content: '' }] }), 'invalid_request'],
                [CHAT_REQ('r-bad-temp', { params: { temperature: 'hot' } }), 'invalid_request'],
                [CHAT_REQ('r-temp-range', { params: { temperature: 9 } }), 'invalid_request'],
                [CHAT_REQ('r-tokens-str', { params: { max_tokens: 'lots' } }), 'invalid_request'],
                [CHAT_REQ('r-tokens-zero', { params: { max_tokens: 0 } }), 'invalid_request'],
                [CHAT_REQ('r-tokens-huge', { params: { max_tokens: 999999 } }), 'request_too_large'],
                [CHAT_REQ('r-many-msgs', { messages: Array.from({ length: 65 }, () => ({ role: 'user', content: 'x' })) }), 'request_too_large'],
                [CHAT_REQ('r-big-msg', { messages: [{ role: 'user', content: 'x'.repeat(33 * 1024) }] }), 'request_too_large'],
                [CHAT_REQ('r-big-total', { messages: Array.from({ length: 8 }, () => ({ role: 'user', content: 'y'.repeat(17 * 1024) })) }), 'request_too_large'],
            ];
            for (const [frame, code] of cases) {
                session._handleMessage(JSON.stringify(frame));
            }
            await wait(80);
            const errors = sent.filter((f) => f.type === 'chat.error');
            expect(errors).to.have.lengthOf(cases.length);
            for (const [i, [frame, code]] of cases.entries()) {
                expect(errors[i].request_id).to.equal(frame.request_id);
                expect(errors[i].code).to.equal(code, `case ${frame.request_id}`);
            }
            // No runtime call was ever made.
            expect(rt.requests).to.have.lengthOf(0);
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('uncorrelatable request_id → no reply at all (dropped silently)', async () => {
        const { session, sent } = makeSession('http://127.0.0.1:1');
        session._handleMessage(JSON.stringify({ type: 'chat.request', model: 'm', messages: [{ role: 'user', content: 'x' }] }));
        session._handleMessage(JSON.stringify({ type: 'chat.request', request_id: '', model: 'm', messages: [{ role: 'user', content: 'x' }] }));
        session._handleMessage(JSON.stringify({ type: 'chat.request', request_id: 'x'.repeat(200), model: 'm', messages: [{ role: 'user', content: 'x' }] }));
        await wait(60);
        expect(sent.filter((f) => f.type !== 'heartbeat')).to.have.lengthOf(0);
        session.stop();
    });

    it('unknown frame fields (url/base_url/endpoint/identity) are ignored — runtime target is local config', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiChat('ok')));
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('req-url', {
                url: 'http://10.9.9.9:11434/v1/chat/completions',
                base_url: 'http://10.9.9.9:11434',
                endpoint: 'http://evil.example',
                workspace_id: '00000000-0000-0000-0000-000000000000',
                connector_id: '00000000-0000-0000-0000-000000000000',
                params: { max_tokens: 32, temperature: 0.1, stream: true, bogus: 'x' },
            })));
            await wait(120);
            const resp = sent.find((f) => f.type === 'chat.response');
            expect(resp).to.exist;
            // Runtime hit the LOCAL fake runtime with the fixed path — the
            // hostile url fields changed nothing.
            expect(rt.requests).to.have.lengthOf(1);
            expect(rt.requests[0].path).to.equal('/v1/chat/completions');
            expect(rt.lastBody.stream).to.equal(false); // stream:true ignored — forced false
            expect(rt.lastBody.bogus).to.equal(undefined); // unknown params dropped
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('oversized frame → request_too_large (hostile-frame guard)', async () => {
        const rt = await startFakeRuntime((req, res) => { res.writeHead(200); res.end('{}'); });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            const big = CHAT_REQ('req-huge', { messages: [{ role: 'user', content: 'z'.repeat(2 * 1024 * 1024) }] });
            const raw = JSON.stringify(big);
            // Message-char limit (32K) fires before the 1 MB frame guard —
            // either way the code must be request_too_large and NO runtime
            // call happens.
            session._handleMessage(raw);
            await wait(60);
            const err = sent.find((f) => f.type === 'chat.error');
            expect(err).to.exist;
            expect(err.code).to.equal('request_too_large');
            expect(rt.requests).to.have.lengthOf(0);
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('chat.request before ready is ignored', async () => {
        const rt = await startFakeRuntime((req, res) => { res.writeHead(200); res.end('{}'); });
        try {
            const socket = makeScriptedSocket();
            const session = createConnectorSession({
                config: { url: 'ws://127.0.0.1:1/ws', token: 'llmc.a.b', baseUrl: rt.baseUrl, runtimeType: 'ollama' },
                logger: { info: () => {}, warn: () => {}, error: () => {} },
                WebSocketImpl: function Stub() { return socket; },
            });
            session.start();
            // NO ready yet — chat.request must be dropped.
            session._handleMessage(JSON.stringify(CHAT_REQ('req-early')));
            await wait(60);
            expect(socket.sent.filter((f) => f.type.startsWith('chat.'))).to.have.lengthOf(0);
            expect(rt.requests).to.have.lengthOf(0);
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('runtime model_not_found (404) → chat.error model_not_found', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'model not found SECRET-INTERNAL' }));
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('req-404', { model: 'ghost' })));
            await wait(120);
            const err = sent.find((f) => f.type === 'chat.error');
            expect(err).to.exist;
            expect(err.code).to.equal('model_not_found');
            expect(err.request_id).to.equal('req-404');
            expect(JSON.stringify(err)).to.not.include('SECRET-INTERNAL');
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('no raw runtime error leakage: 500 body → sanitized code only', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('CUDA error OOM SECRET_TRACE /var/lib/ollama');
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('req-500')));
            await wait(120);
            const err = sent.find((f) => f.type === 'chat.error');
            expect(err.code).to.equal('runtime_error');
            expect(JSON.stringify(err)).to.not.include('CUDA');
            expect(JSON.stringify(err)).to.not.include('/var/lib');
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    // ── concurrency & request_id lifecycle ───────────────────────────────

    it('concurrency cap: third concurrent request → busy; slots free on completion', async function () {
        this.timeout(15000);
        const rt = await startFakeRuntime(null, { hangMs: true });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('c-1')));
            session._handleMessage(JSON.stringify(CHAT_REQ('c-2')));
            await wait(60);
            expect(rt.requests).to.have.lengthOf(2);
            session._handleMessage(JSON.stringify(CHAT_REQ('c-3')));
            await wait(60);
            const busy = sent.find((f) => f.type === 'chat.error' && f.request_id === 'c-3');
            expect(busy).to.exist;
            expect(busy.code).to.equal('busy');
            // The two in-flight requests were NOT rejected.
            expect(sent.filter((f) => f.type === 'chat.error' && ['c-1', 'c-2'].includes(f.request_id))).to.have.lengthOf(0);
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('parallel independent requests both answer (multiplexing works)', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiChat(`answer-${rt.requests.length}`)));
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('p-1')));
            session._handleMessage(JSON.stringify(CHAT_REQ('p-2')));
            await wait(200);
            const resps = sent.filter((f) => f.type === 'chat.response');
            expect(resps.map((r) => r.request_id).sort()).to.deep.equal(['p-1', 'p-2']);
            expect(rt.requests).to.have.lengthOf(2);
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('duplicate request_id while in-flight → invalid_request, executed ONCE', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiChat('once')));
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('d-1')));
            session._handleMessage(JSON.stringify(CHAT_REQ('d-1'))); // duplicate, in-flight
            await wait(150);
            const dup = sent.find((f) => f.type === 'chat.error' && f.request_id === 'd-1');
            expect(dup).to.exist;
            expect(dup.code).to.equal('invalid_request');
            expect(rt.requests).to.have.lengthOf(1); // executed exactly once
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('duplicate request_id AFTER completion → invalid_request, not re-executed', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiChat('once')));
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('d-2')));
            await wait(150);
            expect(rt.requests).to.have.lengthOf(1);
            session._handleMessage(JSON.stringify(CHAT_REQ('d-2'))); // duplicate, completed
            await wait(100);
            const dup = sent.filter((f) => f.type === 'chat.error' && f.request_id === 'd-2').pop();
            expect(dup).to.exist;
            expect(dup.code).to.equal('invalid_request');
            expect(rt.requests).to.have.lengthOf(1); // NOT re-executed
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('slot released after error: request after a failure succeeds', async () => {
        const rt = await startFakeRuntime((req, res) => {
            if (rt.requests.length === 1) {
                res.writeHead(500);
                res.end('boom');
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(openAiChat('second works')));
            }
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('s-err')));
            await wait(150);
            expect(sent.find((f) => f.type === 'chat.error' && f.request_id === 's-err')).to.exist;
            session._handleMessage(JSON.stringify(CHAT_REQ('s-ok')));
            await wait(150);
            const resp = sent.find((f) => f.type === 'chat.response' && f.request_id === 's-ok');
            expect(resp).to.exist;
            expect(resp.content).to.equal('second works');
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('slot released after timeout: chat.error timeout, next request succeeds, session survives', async function () {
        this.timeout(15000);
        let fail = true;
        const rt = await startFakeRuntime((req, res) => {
            if (fail) return; // first request hangs → timeout
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiChat('after timeout')));
        });
        try {
            const { session, sent, socket } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('t-1', { timeout_ms: 1000 })));
            await wait(1300);
            const err = sent.find((f) => f.type === 'chat.error' && f.request_id === 't-1');
            expect(err).to.exist;
            expect(err.code).to.equal('timeout');
            fail = false;
            session._handleMessage(JSON.stringify(CHAT_REQ('t-2')));
            await wait(150);
            const resp = sent.find((f) => f.type === 'chat.response' && f.request_id === 't-2');
            expect(resp).to.exist;
            // The session (socket) survived the timeout.
            expect(socket.readyState).to.not.equal(3);
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    // ── cancellation ─────────────────────────────────────────────────────

    it('chat.cancel aborts the in-flight runtime request; NO frame back; slot freed; session survives', async function () {
        this.timeout(15000);
        const rt = await startFakeRuntime(null, { hangMs: true });
        try {
            const { session, sent, socket } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('x-1')));
            await wait(80);
            expect(rt.requests).to.have.lengthOf(1);
            session._handleMessage(JSON.stringify({ type: 'chat.cancel', request_id: 'x-1' }));
            await wait(150);
            // No chat.response AND no chat.error for the cancelled id.
            expect(sent.filter((f) => (f.type === 'chat.response' || f.type === 'chat.error') && f.request_id === 'x-1')).to.have.lengthOf(0);
            // Slot freed → a new request reaches the (hung) runtime.
            const before = rt.requests.length;
            session._handleMessage(JSON.stringify(CHAT_REQ('x-2')));
            await wait(100);
            expect(rt.requests.length).to.equal(before + 1); // slot was freed
            // Session alive.
            expect(socket.readyState).to.not.equal(3);
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('chat.cancel for unknown / already-finished id → ignored, session survives', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiChat('done')));
        });
        try {
            const { session, sent, socket } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify({ type: 'chat.cancel', request_id: 'never-existed' }));
            session._handleMessage(JSON.stringify(CHAT_REQ('x-3')));
            await wait(150);
            session._handleMessage(JSON.stringify({ type: 'chat.cancel', request_id: 'x-3' })); // already finished
            await wait(100);
            // Finished request answered normally; late cancel changed nothing.
            const resp = sent.find((f) => f.type === 'chat.response' && f.request_id === 'x-3');
            expect(resp).to.exist;
            expect(socket.readyState).to.not.equal(3);
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    // ── logging discipline (AD-6) ────────────────────────────────────────

    it('metadata-only local log: no prompt, no response content, no error internals', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiChat('TOP-SECRET-RESPONSE')));
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('L-1', { messages: [{ role: 'user', content: 'TOP-SECRET-PROMPT' }] })));
            await wait(150);
            expect(sent.find((f) => f.type === 'chat.response')).to.exist;
            const ops = opLog.list().filter((r) => r.op === 'chat_completion');
            expect(ops).to.have.lengthOf(1);
            expect(ops[0].status).to.equal('ok');
            expect(ops[0].model).to.equal('qwen3:32b');
            expect(ops[0].duration_ms).to.be.a('number');
            // AD-6: content never enters the log.
            const logged = JSON.stringify(ops);
            expect(logged).to.not.include('TOP-SECRET-PROMPT');
            expect(logged).to.not.include('TOP-SECRET-RESPONSE');
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('cancelled + failed requests are logged as metadata (status/error_code only)', async function () {
        this.timeout(15000);
        const rt = await startFakeRuntime(null, { hangMs: true });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            // cancelled path
            session._handleMessage(JSON.stringify(CHAT_REQ('L-2', { timeout_ms: 3000 })));
            await wait(60);
            session._handleMessage(JSON.stringify({ type: 'chat.cancel', request_id: 'L-2' }));
            await wait(150);
            const cancelled = opLog.list().filter((r) => r.op === 'chat_completion' && r.status === 'cancelled');
            expect(cancelled).to.have.lengthOf(1);
            // timeout path
            session._handleMessage(JSON.stringify(CHAT_REQ('L-3', { timeout_ms: 1000 })));
            await wait(1300);
            const timedOut = opLog.list().filter((r) => r.op === 'chat_completion' && r.error_code === 'timeout');
            expect(timedOut).to.have.lengthOf(1);
            expect(sent.find((f) => f.type === 'chat.error' && f.request_id === 'L-3')).to.exist;
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. Cloud side — transport service over the real WS route (real PG)
// ══════════════════════════════════════════════════════════════════════════

describe('LAC-4 cloud: transport + WS route (non-streaming inference)', function () {
    this.timeout(60000);

    let srv;
    let wsA, wsB;

    before(async function () {
        this.timeout(60000);
        await runMigrations();
        await cleanup();
        wsA = await createWorkspace('lac4A');
        wsB = await createWorkspace('lac4B');
        srv = await startWsServer({
            authTimeoutMs: 5000,
            heartbeatTimeoutMs: 30000,
            pgWriteIntervalMs: 0,
        });
    });

    after(async function () {
        this.timeout(30000);
        if (srv) await srv.close().catch(() => {});
        await cleanup();
    });

    const CHAT = (model = 'qwen3:32b') => ({
        model,
        messages: [{ role: 'user', content: 'Cloud says hi' }],
        params: { max_tokens: 64, temperature: 0.3 },
    });

    /** A real connector session (the distributable) against the test WS server + a fake runtime. */
    async function startConnector(connectorId, token, runtimeUrl) {
        const session = createConnectorSession({
            config: { url: srv.url, token, baseUrl: runtimeUrl, runtimeType: 'ollama' },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
        });
        session.start();
        // Wait for hello/ready + the live-session registration of THIS
        // connector (other tests' sessions may still linger in the map).
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !registry.isLive(connectorId)) {
            await wait(50);
        }
        if (!registry.isLive(connectorId)) throw new Error('connector session did not become live');
        return session;
    }

    it('END-TO-END: cloud transport → WS chat.request → connector → local runtime → chat.response → cloud', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'inf-e2e');
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiChat('E2E answer')));
        });
        let session;
        try {
            session = await startConnector(connector.connector_id, token, rt.baseUrl);
            const res = await transport.connectorChat(connector.connector_id, CHAT(), { timeoutMs: 8000 });
            expect(res.ok).to.equal(true);
            expect(res.content).to.equal('E2E answer');
            expect(res.finishReason).to.equal('stop');
            expect(res.usage).to.deep.equal({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
            expect(res.model).to.equal('qwen3:32b');
            expect(res.requestId).to.be.a('string');
            // Exactly one runtime call: fixed path, POST, stream:false.
            expect(rt.requests).to.have.lengthOf(1);
            expect(rt.requests[0]).to.deep.equal({ method: 'POST', path: '/v1/chat/completions', at: rt.requests[0].at });
            expect(rt.lastBody.model).to.equal('qwen3:32b');
            expect(rt.lastBody.messages).to.deep.equal([{ role: 'user', content: 'Cloud says hi' }]);
            expect(rt.lastBody.stream).to.equal(false);
            expect(rt.lastBody.max_tokens).to.equal(64);
            expect(rt.lastBody.temperature).to.equal(0.3);
            session.stop();
        } finally {
            if (session) session.stop();
            await rt.closeServer();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('offline connector → fail-closed explicit connector_offline (no fallback, no frames)', async () => {
        const { connector } = await createActivatedConnector(wsA, 'inf-off');
        try {
            const res = await transport.connectorChat(connector.connector_id, CHAT());
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('connector_offline');
        } finally {
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('cloud-side validation rejects invalid payloads BEFORE any frame is sent', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'inf-invalid');
        const rt = await startFakeRuntime((req, res) => { res.writeHead(200); res.end('{}'); });
        let session;
        try {
            session = await startConnector(connector.connector_id, token, rt.baseUrl);
            const cases = [
                [{ ...CHAT(), model: '' }, 'invalid_request'],
                [{ ...CHAT(), model: 'x'.repeat(600) }, 'invalid_request'],
                [{ ...CHAT(), messages: [] }, 'invalid_request'],
                [{ ...CHAT(), messages: [{ role: 'root', content: 'x' }] }, 'invalid_request'],
                [{ ...CHAT(), messages: [{ role: 'user', content: 'z'.repeat(33 * 1024) }] }, 'request_too_large'],
                [{ ...CHAT(), messages: Array.from({ length: 65 }, () => ({ role: 'user', content: 'x' })) }, 'request_too_large'],
                [{ ...CHAT(), params: { max_tokens: 1e9 } }, 'request_too_large'],
                [{ ...CHAT(), params: { temperature: 99 } }, 'invalid_request'],
            ];
            for (const [payload, code] of cases) {
                const res = await transport.connectorChat(connector.connector_id, payload);
                expect(res.ok).to.equal(false, JSON.stringify(payload).slice(0, 80));
                expect(res.code).to.equal(code);
            }
            // No chat.request frame ever left the cloud and no runtime call.
            expect(transport.stats().pending).to.equal(0);
            expect(rt.requests).to.have.lengthOf(0);
            session.stop();
        } finally {
            if (session) session.stop();
            await rt.closeServer();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('chat.error passthrough: allowlisted code + sanitized message; unknown code degrades to runtime_error', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'inf-err');
        const { ws } = await openSession(srv, token);
        try {
            // Script a manual connector: answer the transport's request with
            // an error frame. Two variants: allowlisted and hostile.
            const p1 = transport.connectorChat(connector.connector_id, CHAT(), { timeoutMs: 5000 });
            const req1 = await nextMessage(ws);
            expect(req1.type).to.equal('chat.request');
            send(ws, { type: 'chat.error', request_id: req1.request_id, code: 'runtime_unreachable', message: `Evil\n${'x'.repeat(400)}` });
            const r1 = await p1;
            expect(r1.ok).to.equal(false);
            expect(r1.code).to.equal('runtime_unreachable');
            // Sanitized: control char → space, capped at 256 chars total.
            expect(r1.message).to.equal(`Evil ${'x'.repeat(251)}`);

            const p2 = transport.connectorChat(connector.connector_id, CHAT(), { timeoutMs: 5000 });
            const req2 = await nextMessage(ws);
            send(ws, { type: 'chat.error', request_id: req2.request_id, code: 'SQL: DROP TABLE users;--', message: 'hostile' });
            const r2 = await p2;
            expect(r2.ok).to.equal(false);
            expect(r2.code).to.equal('runtime_error'); // degraded
            expect(r2.message).to.equal('Local runtime error'); // sanitized, not the hostile text
        } finally {
            ws.close();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('oversized chat.response content → response_too_large (never the raw content)', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'inf-big');
        const { ws } = await openSession(srv, token);
        try {
            const p = transport.connectorChat(connector.connector_id, CHAT(), { timeoutMs: 5000 });
            const req = await nextMessage(ws);
            // Over the 32K content cap, under the 64KB frame cap — the
            // transport must reject it sanitized, never forward the content.
            send(ws, { type: 'chat.response', request_id: req.request_id, model: 'm', content: 'X'.repeat(33 * 1024) });
            const res = await p;
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('response_too_large');
            expect(JSON.stringify(res)).to.not.include('XXXX'); // content never surfaced
        } finally {
            ws.close();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('unsolicited / late / malformed chat frames are ignored at zero cost', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'inf-unsol');
        const { ws } = await openSession(srv, token);
        try {
            const closed = new Promise((resolve) => ws.once('close', resolve));
            send(ws, { type: 'chat.response', request_id: 'ghost-id', content: 'unsolicited' });
            send(ws, { type: 'chat.error', request_id: 'ghost-id', code: 'busy' });
            send(ws, { type: 'chat.response', content: 'no request_id at all' });
            send(ws, { type: 'chat.response', request_id: 42, content: 'typed wrong' });
            await wait(80);
            // Session survived everything.
            const race = await Promise.race([closed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('open'), 150))]);
            expect(race).to.equal('open');
            expect(transport.stats().pending).to.equal(0);
        } finally {
            ws.close();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('late terminal frame for a timed-out request is dropped (correlation settled once)', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'inf-late');
        const { ws } = await openSession(srv, token);
        try {
            const p = transport.connectorChat(connector.connector_id, CHAT(), { timeoutMs: 250 });
            const req = await nextMessage(ws);
            const res = await p;
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('timeout');
            // The late reply arrives AFTER settlement — must be ignored.
            send(ws, { type: 'chat.response', request_id: req.request_id, content: 'too late' });
            await wait(80);
            expect(transport.stats().pending).to.equal(0);
        } finally {
            ws.close();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('socket dying mid-request fails the pending request FAST (session_closed, not timeout)', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'inf-dead');
        const { ws } = await openSession(srv, token);
        try {
            const p = transport.connectorChat(connector.connector_id, CHAT(), { timeoutMs: 10000 });
            await nextMessage(ws); // chat.request went out
            ws.close();
            const res = await p;
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('session_closed');
        } finally {
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('inference after reconnect: a REPLACED session cannot settle the old request; new session serves new requests', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'inf-recon');
        const { ws: ws1 } = await openSession(srv, token);
        try {
            const p = transport.connectorChat(connector.connector_id, CHAT(), { timeoutMs: 8000 });
            const req = await nextMessage(ws1);
            // A second session authenticates → the first is replaced (closed
            // 4000) → pending fails fast with session_closed.
            const { ws: ws2 } = await openSession(srv, token);
            const r1 = await p;
            expect(r1.ok).to.equal(false);
            expect(r1.code).to.equal('session_closed');

            // A hostile reply from the NEW session for the OLD request_id
            // is dropped (session-bound pending).
            send(ws2, { type: 'chat.response', request_id: req.request_id, content: 'hijack' });
            await wait(80);
            // Drop the manual session — the connector reconnects below.
            ws2.close();
            await wait(100);

            // Fresh inference on a reconnected (real) session works normally.
            const rt = await startFakeRuntime((reqq, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(openAiChat('after reconnect')));
            });
            try {
                const cs = await startConnector(connector.connector_id, token, rt.baseUrl);
                const r2 = await transport.connectorChat(connector.connector_id, CHAT(), { timeoutMs: 8000 });
                expect(r2.ok).to.equal(true);
                expect(r2.content).to.equal('after reconnect');
                cs.stop();
            } finally {
                await rt.closeServer();
            }
        } finally {
            ws1.close();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('authoritative cloud timeout → chat.cancel sent, connector aborts the local fetch, slot freed, session survives', async function () {
        this.timeout(20000);
        const { connector, token } = await createActivatedConnector(wsA, 'inf-cancel');
        const rt = await startFakeRuntime(null, { hangMs: true });
        let session;
        try {
            session = await startConnector(connector.connector_id, token, rt.baseUrl);
            const p1 = transport.connectorChat(connector.connector_id, CHAT(), { timeoutMs: 600 });
            const r1 = await p1;
            expect(r1.ok).to.equal(false);
            expect(r1.code).to.equal('timeout');
            expect(transport.stats().pending).to.equal(0);
            // Give the connector a moment to process chat.cancel.
            await wait(200);
            expect(registry.isLive(connector.connector_id)).to.equal(true); // session alive

            // The cancelled slot must be free: a fresh request reaches the
            // runtime (the hung server records the new request too).
            const before = rt.requests.length;
            const p2 = transport.connectorChat(connector.connector_id, CHAT(), { timeoutMs: 4000 });
            await wait(300);
            expect(rt.requests.length).to.equal(before + 1); // runtime was hit — slot freed
            // And it still times out cleanly (hung runtime).
            const r2 = await p2;
            expect(r2.ok).to.equal(false);
            expect(r2.code).to.equal('timeout');
        } finally {
            if (session) session.stop();
            await rt.closeServer();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('connector busy is surfaced as the sanitized busy code (concurrency across the wire)', async function () {
        this.timeout(20000);
        const { connector, token } = await createActivatedConnector(wsA, 'inf-busy');
        const rt = await startFakeRuntime(null, { hangMs: true });
        let session;
        try {
            session = await startConnector(connector.connector_id, token, rt.baseUrl);
            // Fill the connector's 2 slots, then push a third.
            const p1 = transport.connectorChat(connector.connector_id, CHAT(), { timeoutMs: 8000 });
            const p2 = transport.connectorChat(connector.connector_id, CHAT(), { timeoutMs: 8000 });
            await wait(150);
            expect(rt.requests).to.have.lengthOf(2);
            const p3 = transport.connectorChat(connector.connector_id, CHAT(), { timeoutMs: 8000 });
            const r3 = await p3;
            expect(r3.ok).to.equal(false);
            expect(r3.code).to.equal('busy');
            // The first two are still pending; clean them up via timeout.
            const [r1, r2] = await Promise.all([p1, p2]);
            expect(r1.code).to.equal('timeout');
            expect(r2.code).to.equal('timeout');
        } finally {
            if (session) session.stop();
            await rt.closeServer();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('unauthenticated inference frames → fail-closed close (no inference before hello)', async () => {
        const ws = await connect(srv.url);
        const closed = nextClose(ws);
        send(ws, { type: 'chat.response', request_id: 'r', content: 'early' });
        const res = await closed;
        expect(res.code).to.equal(1008);
        expect(res.reason).to.equal('auth_failed');
    });

    it('chat.request / chat.cancel FROM the connector are ignored (C→S surface does not include them)', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'inf-noreq');
        const { ws } = await openSession(srv, token);
        try {
            const closed = new Promise((resolve) => ws.once('close', resolve));
            send(ws, { type: 'chat.request', request_id: 'x', model: 'm', messages: [{ role: 'user', content: 'x' }] });
            send(ws, { type: 'chat.cancel', request_id: 'x' });
            await wait(100);
            const race = await Promise.race([closed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('open'), 150))]);
            expect(race).to.equal('open');
            expect(transport.stats().pending).to.equal(0);
        } finally {
            ws.close();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('workspace/session identity cannot be spoofed: transport resolves the connector by id, frames never carry identity', async () => {
        const { connector: cA, token: tA } = await createActivatedConnector(wsA, 'inf-idA');
        const { connector: cB, token: tB } = await createActivatedConnector(wsB, 'inf-idB');
        try {
            const rt = await startFakeRuntime((req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(openAiChat('B-runtime')));
            });
            // Only connector B is live.
            const sessionB = await startConnector(cB.connector_id, tB, rt.baseUrl);
            try {
                // Asking for A (offline) fails closed — no cross routing.
                const rA = await transport.connectorChat(cA.connector_id, CHAT());
                expect(rA.ok).to.equal(false);
                expect(rA.code).to.equal('connector_offline');
                // Asking for B works and hits B's runtime.
                const rB = await transport.connectorChat(cB.connector_id, CHAT(), { timeoutMs: 8000 });
                expect(rB.ok).to.equal(true);
                expect(rB.content).to.equal('B-runtime');
                sessionB.stop();
            } finally {
                await rt.closeServer();
            }
        } finally {
            await query(`DELETE FROM ai_connectors WHERE connector_id IN ($1,$2)`, [cA.connector_id, cB.connector_id]);
        }
    });

    it('no secret/credential/prompt/response leakage in server logs during inference', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'inf-logs');
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiChat('LOG-SECRET-RESPONSE')));
        });
        let session;
        try {
            srv.logLines.length = 0;
            session = await startConnector(connector.connector_id, token, rt.baseUrl);
            const res = await transport.connectorChat(connector.connector_id, {
                ...CHAT(),
                messages: [{ role: 'user', content: 'LOG-SECRET-PROMPT' }],
            }, { timeoutMs: 8000 });
            expect(res.ok).to.equal(true);
            await wait(100);
            const logs = srv.logLines.join('\n');
            expect(logs).to.not.include(token);
            expect(logs).to.not.include('llmc.');
            expect(logs).to.not.include('llmcreg.');
            expect(logs).to.not.include('Authorization');
            expect(logs).to.not.include('LOG-SECRET-PROMPT');
            expect(logs).to.not.include('LOG-SECRET-RESPONSE');
            session.stop();
        } finally {
            if (session) session.stop();
            await rt.closeServer();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });
});
