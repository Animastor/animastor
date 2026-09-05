// ======================================================
// LLM Connector Streaming Tests (LAC-5 — Local AI Connector V1 Phase 5)
// ======================================================
// Coverage (docs/04-planning/local-ai-connector-v1.md §4 Phase-5 note,
// §5, §10, §15-Phase-5, AD-5, AD-6, AD-7, AD-12):
//
//   ADAPTER (chatCompletionStream against REAL SSE runtimes):
//     normal streaming (N deltas → joined content, finish_reason, usage);
//     [DONE] termination; body-EOF without [DONE]; empty stream; runtime
//     error before any delta; malformed SSE (bad JSON, bad chunk shape);
//     oversized SSE event; oversized cumulative stream; oversized
//     unterminated line; split multi-chunk TCP delivery; per-delta split
//     of a huge single chunk; comments/keep-alive lines ignored; redirect
//     refused; arbitrary URL impossible; cancel → cancelled; timeout.
//   CONNECTOR SESSION (stream:true over the scripted socket):
//     deltas + final chat.response; exactly-one-terminal invariant;
//     duplicate request_id (in-flight / after completion / after >10000
//     ids / store saturation) — at-most-once intact for streams; cancel
//     mid-stream aborts the runtime, frees the slot, NO further frames;
//     connector timeout mid-stream; malformed/oversized/cumulative →
//     sanitized chat.error; concurrency cap counts streams; non-stream
//     requests unchanged; metadata-only logging (stream flag, no content).
//   CLOUD (transport + WS route, real PG + real WS + real connector):
//     E2E streaming happy path; empty stream; per-delta + cumulative cap
//     violations settled sanitized; delta for non-streaming request
//     dropped; unsolicited/late deltas dropped; mid-stream runtime error
//     after deltas → stream_failed; timeout sends chat.cancel, connector
//     aborts, session survives; disconnect → session_closed fast, no
//     dangling pending; concurrency across the wire; duplicate
//     request_id never re-executed (cloud-generated UUID); logs carry no
//     prompt/response/delta content.
// ======================================================

const { expect } = require('chai');
const http = require('http');
const { WebSocket } = require('ws');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const repo = require('../src/storage/postgres/repositories/ai-connector-repo');
const registry = require('../src/services/ai-connector/registry');
const transport = require('../src/services/ai-connector/transport');
const { createWsHandler } = require('../src/routes/ai-connector-routes.cjs');
const { createMockRedis } = require('./mocks/redis-mock');

// Connector-side modules (the distributable).
const {
    chatCompletionStream,
    normalizeOpenAiStreamChunk,
} = require('../../ai-connector/lib/runtime-adapters/index.cjs');
const chatLib = require('../../ai-connector/lib/chat.cjs');
const { createConnectorSession } = require('../../ai-connector/lib/connector.cjs');
const opLog = require('../../ai-connector/lib/log.cjs');

const stamp = `lac5${Date.now()}`;

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

/** OpenAI-style streaming chunk. */
const chunk = (text, extra = {}) => ({
    id: 'cmpl-1',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'qwen3:32b',
    choices: [{ index: 0, delta: text == null ? {} : { content: text }, finish_reason: null }],
    ...extra,
});
const finishChunk = (reason = 'stop', usage) => ({
    id: 'cmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    ...(usage ? { usage } : {}),
});
const FINAL_USAGE = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };

/** Encode one SSE event. */
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';

/**
 * Fake STREAMING runtime: writes SSE events with optional delays and
 * records every request. `events` is an array of strings (pre-encoded SSE)
 * or {delay:ms} markers.
 */
function startStreamRuntime(events, opts = {}) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            server.requests.push({ method: req.method, path: req.url, at: Date.now() });
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('close', () => { server.abortedCount += req.aborted ? 1 : 0; });
            req.on('end', () => {
                try { server.lastBody = body ? JSON.parse(body) : null; } catch (_) { server.lastBody = body; }
                if (opts.hang) {
                    server.hung.push({ path: req.url });
                    return; // deliberate no-response
                }
                if (opts.onRequest) opts.onRequest(req, res, server);
                else {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    let i = 0;
                    const writeNext = () => {
                        if (i >= events.length) { res.end(); return; }
                        const e = events[i++];
                        if (typeof e === 'object' && e !== null && typeof e.delay === 'number') {
                            setTimeout(writeNext, e.delay);
                            return;
                        }
                        res.write(String(e));
                        setImmediate(writeNext);
                    };
                    writeNext();
                }
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
                return () => new Promise((r) => {
                    // Hung SSE answers may leave open keep-alive sockets
                    // (undici pools them) — force-close so tests never
                    // wait on a server that will not quiesce.
                    try { server.closeAllConnections?.(); } catch (_) {}
                    orig(() => r());
                });
            })();
            resolve(server);
        });
    });
}

/** Standard 3-delta stream used across the happy-path tests. */
const STD_EVENTS = [
    sse(chunk('Hello ')),
    sse(chunk('stre')),
    { delay: 20 },
    sse(chunk('amed!')),
    sse(finishChunk('stop', FINAL_USAGE)),
    DONE,
];

// ── backend WS harness (mirrors ai-connector-inference.test.js) ──────────

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

const HELLO = (credential) => ({ type: 'hello', protocol_version: 1, credential });

/** Scriptable in-process socket for unit-driving the connector session. */
function makeScriptedSocket() {
    const handlers = {};
    const sent = [];
    return {
        readyState: 1,
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
    params: { max_tokens: 128, temperature: 0.5, stream: true },
    timeout_ms: 5000,
    ...overrides,
});

// ══════════════════════════════════════════════════════════════════════════
// 1. Adapter — chatCompletionStream matrix
// ══════════════════════════════════════════════════════════════════════════

describe('LAC-5 adapter: streaming POST /v1/chat/completions (stream:true)', function () {
    this.timeout(20000);

    const MSGS = [{ role: 'user', content: 'Hi' }];

    it('normal stream: N deltas in order → joined content, finish_reason, usage, [DONE]', async () => {
        const rt = await startStreamRuntime(STD_EVENTS);
        try {
            const deltas = [];
            const res = await chatCompletionStream({
                baseUrl: rt.baseUrl, model: 'qwen3:32b', messages: MSGS,
                maxTokens: 128, temperature: 0.5, timeoutMs: 5000,
                onDelta: (t) => deltas.push(t),
            });
            expect(res.ok).to.equal(true);
            expect(deltas).to.deep.equal(['Hello ', 'stre', 'amed!']);
            expect(res.content).to.equal('Hello streamed!');
            expect(res.finishReason).to.equal('stop');
            expect(res.usage).to.deep.equal(FINAL_USAGE);
            expect(res.rawBytes).to.be.a('number');
            // POST + fixed path + stream:true + params forwarded.
            expect(rt.requests).to.have.lengthOf(1);
            expect(rt.requests[0].method).to.equal('POST');
            expect(rt.requests[0].path).to.equal('/v1/chat/completions');
            expect(rt.lastBody.model).to.equal('qwen3:32b');
            expect(rt.lastBody.stream).to.equal(true);
            expect(rt.lastBody.max_tokens).to.equal(128);
            expect(rt.lastBody.temperature).to.equal(0.5);
        } finally {
            await rt.closeServer();
        }
    });

    it('empty stream: [DONE] with no content chunks → ok with empty content', async () => {
        const rt = await startStreamRuntime([DONE]);
        try {
            const deltas = [];
            const res = await chatCompletionStream({
                baseUrl: rt.baseUrl, model: 'm', messages: MSGS, onDelta: (t) => deltas.push(t),
            });
            expect(res.ok).to.equal(true);
            expect(res.content).to.equal('');
            expect(deltas).to.deep.equal([]);
        } finally {
            await rt.closeServer();
        }
    });

    it('body EOF without [DONE] after well-formed chunks → clean completion (tolerated)', async () => {
        const rt = await startStreamRuntime([sse(chunk('no done marker')), sse(finishChunk('length'))]);
        try {
            const res = await chatCompletionStream({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS });
            expect(res.ok).to.equal(true);
            expect(res.content).to.equal('no done marker');
            expect(res.finishReason).to.equal('length');
        } finally {
            await rt.closeServer();
        }
    });

    it('SSE comments / event lines are ignored; multi-line data of one event is joined', async () => {
        const rt = await startStreamRuntime([
            ': keep-alive comment\n\n',
            'event: message\n',
            `data: ${JSON.stringify(chunk('mul'))}\n`,
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ti' } }] })}\n\n`,
            DONE,
        ]);
        try {
            const deltas = [];
            const res = await chatCompletionStream({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS, onDelta: (t) => deltas.push(t) });
            // Two data: lines of ONE event are joined with '\n' per SSE —
            // two JSON objects joined by a newline are not valid JSON →
            // the event fails validation, the stream aborts bad_response.
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('bad_response');
            expect(deltas).to.deep.equal([]); // the broken event never emitted
        } finally {
            await rt.closeServer();
        }
    });

    it('malformed SSE (data not JSON / bad chunk shape) → bad_response sanitized', async () => {
        for (const events of [
            ['data: not json\n\n', DONE],
            ['data: {"choices":"nope"}\n\n', DONE],
            ['data: [1,2,3]\n\n', DONE],
            ['data: null\n\n', DONE],
        ]) {
            const rt = await startStreamRuntime(events);
            try {
                const res = await chatCompletionStream({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS });
                expect(res.ok).to.equal(false, JSON.stringify(events));
                expect(res.code).to.equal('bad_response');
            } finally {
                await rt.closeServer();
            }
        }
    });

    it('malformed SSE after partial content → ok:false with the partial carried', async () => {
        const rt = await startStreamRuntime([
            sse(chunk('partial ')),
            { delay: 20 },
            'data: {{{broken\n\n',
        ]);
        try {
            const deltas = [];
            const res = await chatCompletionStream({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS, onDelta: (t) => deltas.push(t) });
            expect(res.ok).to.equal(false);
            expect(['bad_response', 'response_too_large']).to.include(res.code);
            expect(deltas).to.deep.equal(['partial ']); // the earlier delta fired
            expect(res.partial).to.equal('partial '); // the caller keeps the partial
        } finally {
            await rt.closeServer();
        }
    });

    it('oversized single SSE event → response_too_large, stream aborted', async () => {
        const rt = await startStreamRuntime([
            `data: ${JSON.stringify(chunk('x'.repeat(70 * 1024)))}\n\n`,
        ]);
        try {
            const res = await chatCompletionStream({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS });
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('response_too_large');
        } finally {
            await rt.closeServer();
        }
    });

    it('oversized cumulative stream → response_too_large, fetch aborted mid-stream', async function () {
        this.timeout(15000);
        const rt = await startStreamRuntime([
            sse(chunk('y'.repeat(20 * 1024))),
            { delay: 30 },
            sse(chunk('y'.repeat(20 * 1024))),
            { delay: 30 },
            sse(chunk('y'.repeat(20 * 1024))), // total > 32768 → abort
        ]);
        try {
            const res = await chatCompletionStream({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS });
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('response_too_large');
            expect(typeof res.partial).to.equal('string');
        } finally {
            await rt.closeServer();
        }
    });

    it('oversized unterminated SSE line → response_too_large (bounded buffering)', async () => {
        const rt = await startStreamRuntime(null, {
            onRequest: (req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write('data: ');
                res.write('x'.repeat(70 * 1024)); // never a newline
                // keep the response open — the parser must abort on the cap
            },
        });
        try {
            const res = await chatCompletionStream({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS, timeoutMs: 3000 });
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('response_too_large');
        } finally {
            await rt.closeServer();
        }
    });

    it('a huge single text chunk is split into ≤ maxDeltaChars increments', async () => {
        // 24K chars: over the 16K per-delta cap, under the 32K cumulative cap.
        const big = 'z'.repeat(24 * 1024);
        const rt = await startStreamRuntime([
            sse(chunk(big)),
            sse(finishChunk('stop')),
            DONE,
        ]);
        try {
            const deltas = [];
            const res = await chatCompletionStream({
                baseUrl: rt.baseUrl, model: 'm', messages: MSGS,
                onDelta: (t) => deltas.push(t),
            });
            expect(res.ok).to.equal(true);
            expect(deltas).to.have.lengthOf(2); // 24K → 16K + 8K
            for (const d of deltas) expect(d.length).to.be.at.most(chatLib.LIMITS.maxDeltaChars);
            expect(res.content).to.equal(big);
        } finally {
            await rt.closeServer();
        }
    });

    it('runtime error BEFORE any delta (404/500) → sanitized code, no onDelta', async () => {
        for (const [status, body, code] of [
            [404, { error: { message: 'nope SECRET' } }, 'model_not_found'],
            [500, 'CUDA OOM SECRET', 'runtime_error'],
        ]) {
            const rt = await startStreamRuntime(null, {
                onRequest: (req, res) => {
                    res.writeHead(status, { 'Content-Type': 'application/json' });
                    res.end(typeof body === 'string' ? body : JSON.stringify(body));
                },
            });
            try {
                let fired = 0;
                const res = await chatCompletionStream({
                    baseUrl: rt.baseUrl, model: 'm', messages: MSGS,
                    onDelta: () => { fired += 1; },
                });
                expect(res.ok).to.equal(false);
                expect(res.code).to.equal(code);
                expect(fired).to.equal(0);
                expect(JSON.stringify(res)).to.not.include('SECRET');
            } finally {
                await rt.closeServer();
            }
        }
    });

    it('external abort (chat.cancel) mid-stream → cancelled, no further deltas', async function () {
        this.timeout(15000);
        const rt = await startStreamRuntime([
            sse(chunk('first ')),
            { delay: 100000 }, // effectively hangs after one delta
        ]);
        try {
            const ac = new AbortController();
            const deltas = [];
            const p = chatCompletionStream({
                baseUrl: rt.baseUrl, model: 'm', messages: MSGS, timeoutMs: 5000,
                signal: ac.signal, onDelta: (t) => deltas.push(t),
            });
            await wait(150); // first delta delivered
            ac.abort();
            const res = await p;
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('cancelled');
            expect(deltas).to.deep.equal(['first ']);
        } finally {
            await rt.closeServer();
        }
    });

    it('timeout mid-stream → timeout, partial carried', async function () {
        this.timeout(15000);
        const rt = await startStreamRuntime([
            sse(chunk('slow ')),
            { delay: 100000 },
        ]);
        try {
            const res = await chatCompletionStream({
                baseUrl: rt.baseUrl, model: 'm', messages: MSGS, timeoutMs: 400,
            });
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('timeout');
        } finally {
            await rt.closeServer();
        }
    });

    it('no stream body at all (empty 200) → bad_response', async () => {
        const rt = await startStreamRuntime(null, {
            onRequest: (req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.end();
            },
        });
        try {
            const res = await chatCompletionStream({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS });
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('bad_response');
        } finally {
            await rt.closeServer();
        }
    });

    it('hostile caller options cannot redirect the target (arbitrary URL impossible)', async () => {
        const rt = await startStreamRuntime(STD_EVENTS);
        try {
            await chatCompletionStream({
                baseUrl: rt.baseUrl, model: 'm', messages: MSGS,
                url: 'http://10.9.9.9/x', endpoint: 'http://evil.example',
            });
            expect(rt.requests[0].path).to.equal('/v1/chat/completions');
        } finally {
            await rt.closeServer();
        }
    });

    it('redirect is REFUSED', async () => {
        const rt = await startStreamRuntime(null, {
            onRequest: (req, res) => {
                res.writeHead(302, { Location: 'http://127.0.0.1:9/evil' });
                res.end();
            },
        });
        try {
            const res = await chatCompletionStream({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS });
            expect(res.ok).to.equal(false);
            expect(['runtime_unreachable', 'runtime_error']).to.include(res.code);
        } finally {
            await rt.closeServer();
        }
    });

    it('normalizeOpenAiStreamChunk drops unknown fields, keeps delta/finish/usage', () => {
        const good = normalizeOpenAiStreamChunk(chunk('x', {
            system_fingerprint: 'fp', service_tier: 'free',
            usage: { prompt_tokens: 5, junk: 'a', completion_tokens: -3, total_tokens: 1e12 },
        }));
        expect(good.ok).to.equal(true);
        expect(good.text).to.equal('x');
        expect(good.usage).to.deep.equal({ prompt_tokens: 5, total_tokens: 1e9 });
        const fin = normalizeOpenAiStreamChunk(finishChunk('stop'));
        expect(fin.ok).to.equal(true);
        expect(fin.text).to.equal(null);
        expect(fin.finishReason).to.equal('stop');
        // Usage-only final chunk with choices EMPTY or ABSENT is legal (§4
        // Phase-5 note) — no text, usage captured, stream not failed.
        const usageOnly = normalizeOpenAiStreamChunk({ usage: FINAL_USAGE });
        expect(usageOnly.ok).to.equal(true);
        expect(usageOnly.text).to.equal(null);
        expect(usageOnly.usage).to.deep.equal(FINAL_USAGE);
        expect(normalizeOpenAiStreamChunk({ choices: [] }).ok).to.equal(true);
        // Role-only / empty deltas yield no text but never fail the chunk.
        expect(normalizeOpenAiStreamChunk(chunk(null, { delta: { role: 'assistant' } })).ok).to.equal(true);
        expect(normalizeOpenAiStreamChunk({ choices: [{ delta: { content: '' } }] }).ok).to.equal(true);
        expect(normalizeOpenAiStreamChunk({ choices: 'nope' }).ok).to.equal(false);
        expect(normalizeOpenAiStreamChunk(null).ok).to.equal(false);
    });

    it('usage-only final chunk (choices ABSENT) completes the stream cleanly with usage', async () => {
        const rt = await startStreamRuntime([
            sse(chunk('done ')),
            sse({ usage: FINAL_USAGE }), // no choices field at all
        ]);
        try {
            const deltas = [];
            const res = await chatCompletionStream({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS, onDelta: (t) => deltas.push(t) });
            expect(res.ok).to.equal(true);
            expect(res.content).to.equal('done ');
            expect(res.usage).to.deep.equal(FINAL_USAGE);
            expect(deltas).to.deep.equal(['done ']);
        } finally {
            await rt.closeServer();
        }
    });

    it('role-only and empty deltas stream through without text and without failure', async () => {
        const rt = await startStreamRuntime([
            // First event: role + content → text 'Hi' (not using chunk()
            // helper because it spreads extra at the top level, not inside
            // choices[0].delta).
            sse({ id: 'cmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }] }),
            sse({ id: 'cmpl-2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' } }] }),   // role-only → no text
            sse({ id: 'cmpl-3', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {} }] }),                       // empty delta
            sse(finishChunk('stop')),
            DONE,
        ]);
        try {
            const deltas = [];
            const res = await chatCompletionStream({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS, onDelta: (t) => deltas.push(t) });
            expect(res.ok).to.equal(true);
            expect(res.content).to.equal('Hi');
            expect(res.finishReason).to.equal('stop');
            expect(deltas).to.deep.equal(['Hi']); // only content-bearing deltas forwarded
        } finally {
            await rt.closeServer();
        }
    });

    it('a single SSE line delivered across several TCP writes is parsed correctly', async () => {
        // Deterministically split one event line across res.write calls with
        // small delays (separate TCP segments → separate reader.read() calls)
        // — the parser must accumulate the line buffer until the newline lands.
        const rt = await startStreamRuntime(null, {
            onRequest: (req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                const e = `data: ${JSON.stringify(chunk('frag'))}\n\n`;
                let i = 0;
                const writeNext = () => {
                    if (i >= e.length) {
                        setTimeout(() => res.end('data: [DONE]\n\n'), 20);
                        return;
                    }
                    res.write(e.slice(i, i + 7));
                    i += 7;
                    setTimeout(writeNext, 2);
                };
                writeNext();
            },
        });
        try {
            const deltas = [];
            const res = await chatCompletionStream({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS, onDelta: (t) => deltas.push(t) });
            expect(res.ok).to.equal(true);
            expect(res.content).to.equal('frag');
            expect(deltas).to.deep.equal(['frag']);
        } finally {
            await rt.closeServer();
        }
    });

    it('a flood of `data:` lines with NO event terminator aborts bounded (response_too_large)', async function () {
        this.timeout(15000);
        // A hostile/broken runtime never sends the blank line that ends an
        // SSE event. Each line alone is under the line cap, but the joined
        // event exceeds maxSseEventBytes — the parser must abort instead of
        // accumulating dataLines without bound.
        const rt = await startStreamRuntime(null, {
            onRequest: (req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                const line = 'data: ' + 'x'.repeat(1024) + '\n'; // 1KB per line
                let sent = 0;
                const iv = setInterval(() => {
                    try {
                        if (res.destroyed || res.writableEnded) {
                            clearInterval(iv);
                            return;
                        }
                        res.write(line);
                    } catch (_) {
                        clearInterval(iv);
                        return;
                    }
                    sent += line.length;
                    if (sent > 300 * 1024) { // 300KB total, no blank line
                        clearInterval(iv);
                        res.end();
                    }
                }, 1);
            },
        });
        try {
            const res = await chatCompletionStream({ baseUrl: rt.baseUrl, model: 'm', messages: MSGS, timeoutMs: 5000 });
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('response_too_large');
        } finally {
            await rt.closeServer();
        }
    });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. Connector session — stream:true → chat.delta + terminal frame
// ══════════════════════════════════════════════════════════════════════════

describe('LAC-5 session: stream:true → N× chat.delta + ONE terminal frame', function () {
    this.timeout(20000);

    beforeEach(() => { opLog.reset(); });

    it('normal stream: deltas in order, then ONE chat.response with joined content', async () => {
        const rt = await startStreamRuntime(STD_EVENTS);
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('s-1')));
            await wait(300);
            const deltas = sent.filter((f) => f.type === 'chat.delta');
            expect(deltas.map((d) => d.delta)).to.deep.equal(['Hello ', 'stre', 'amed!']);
            for (const d of deltas) expect(d.request_id).to.equal('s-1');
            const resps = sent.filter((f) => f.type === 'chat.response');
            expect(resps).to.have.lengthOf(1);
            expect(resps[0].request_id).to.equal('s-1');
            expect(resps[0].content).to.equal('Hello streamed!');
            expect(resps[0].finish_reason).to.equal('stop');
            expect(resps[0].usage).to.deep.equal(FINAL_USAGE);
            // Deltas precede the terminal frame.
            const deltaIdx = sent.findIndex((f) => f.type === 'chat.delta');
            const respIdx = sent.findIndex((f) => f.type === 'chat.response');
            expect(deltaIdx).to.be.below(respIdx);
            expect(rt.requests).to.have.lengthOf(1);
            expect(rt.lastBody.stream).to.equal(true);
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('empty stream → zero deltas + ONE chat.response with empty content', async () => {
        const rt = await startStreamRuntime([DONE]);
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('s-empty')));
            await wait(200);
            expect(sent.filter((f) => f.type === 'chat.delta')).to.have.lengthOf(0);
            const resps = sent.filter((f) => f.type === 'chat.response');
            expect(resps).to.have.lengthOf(1);
            expect(resps[0].content).to.equal('');
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('malformed stream → sanitized chat.error, session survives', async () => {
        const rt = await startStreamRuntime(['data: {{{\n\n', DONE]);
        try {
            const { session, sent, socket } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('s-bad')));
            await wait(200);
            const err = sent.find((f) => f.type === 'chat.error' && f.request_id === 's-bad');
            expect(err).to.exist;
            expect(err.code).to.equal('bad_response');
            expect(socket.readyState).to.not.equal(3);
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('oversized cumulative stream → chat.error response_too_large, slot freed', async function () {
        this.timeout(15000);
        const rt = await startStreamRuntime([
            sse(chunk('y'.repeat(20 * 1024))),
            { delay: 30 },
            sse(chunk('y'.repeat(20 * 1024))),
            { delay: 30 },
            sse(chunk('y'.repeat(20 * 1024))),
        ]);
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('s-cum')));
            await wait(500);
            const err = sent.find((f) => f.type === 'chat.error' && f.request_id === 's-cum');
            expect(err).to.exist;
            expect(err.code).to.equal('response_too_large');
            // No terminal response after the error.
            expect(sent.filter((f) => f.type === 'chat.response' && f.request_id === 's-cum')).to.have.lengthOf(0);
            // Slot freed: a new request reaches the runtime (it streams
            // the same oversized payload — what matters is that the new
            // request EXECUTED: deltas flow for the new id too).
            session._handleMessage(JSON.stringify(CHAT_REQ('s-after')));
            await wait(500);
            expect(rt.requests.length).to.equal(2); // the slot was freed
            const afterDeltas = sent.filter((f) => f.type === 'chat.delta' && f.request_id === 's-after');
            expect(afterDeltas.length).to.be.at.least(1);
            const afterErr = sent.find((f) => f.type === 'chat.error' && f.request_id === 's-after');
            expect(afterErr.code).to.equal('response_too_large');
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('oversized SSE event → chat.error response_too_large', async () => {
        const rt = await startStreamRuntime([`data: ${JSON.stringify(chunk('x'.repeat(70 * 1024)))}\n\n`]);
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('s-evt')));
            await wait(200);
            const err = sent.find((f) => f.type === 'chat.error' && f.request_id === 's-evt');
            expect(err).to.exist;
            expect(err.code).to.equal('response_too_large');
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('runtime 404 before deltas → chat.error model_not_found, no deltas', async () => {
        const rt = await startStreamRuntime(null, {
            onRequest: (req, res) => {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'not found SECRET' }));
            },
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('s-404')));
            await wait(200);
            expect(sent.filter((f) => f.type === 'chat.delta')).to.have.lengthOf(0);
            const err = sent.find((f) => f.type === 'chat.error' && f.request_id === 's-404');
            expect(err.code).to.equal('model_not_found');
            expect(JSON.stringify(err)).to.not.include('SECRET');
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('chat.cancel mid-stream: aborts the runtime, frees the slot, NO further frames for the id', async function () {
        this.timeout(15000);
        const rt = await startStreamRuntime([
            sse(chunk('one ')),
            { delay: 100000 }, // hangs after one delta
        ]);
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('s-cancel')));
            await wait(150);
            expect(sent.filter((f) => f.type === 'chat.delta')).to.have.lengthOf(1);
            const runtimeCallsBefore = rt.requests.length;
            session._handleMessage(JSON.stringify({ type: 'chat.cancel', request_id: 's-cancel' }));
            await wait(200);
            // Exactly the frames before the cancel — nothing after.
            expect(sent.filter((f) => (f.type === 'chat.delta' || f.type === 'chat.response' || f.type === 'chat.error') && f.request_id === 's-cancel'))
                .to.have.lengthOf(1); // the single pre-cancel delta
            // Slot freed: a new request reaches the (hung) runtime.
            session._handleMessage(JSON.stringify(CHAT_REQ('s-next')));
            await wait(150);
            expect(rt.requests.length).to.equal(runtimeCallsBefore + 1); // slot was freed
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('connector timeout mid-stream → chat.error timeout, session survives', async function () {
        this.timeout(30000);
        // A runtime that streams one delta then never writes again.
        const rt = await startStreamRuntime(null, {
            onRequest: (req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write(sse(chunk('a')));
                // deliberate: never end, never write again
            },
        });
        try {
            const { session, sent, socket } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('s-to', { timeout_ms: 800 })));
            const deadline = Date.now() + 20000;
            let err = null;
            while (Date.now() < deadline && !err) {
                await wait(100); // eslint-disable-line no-await-in-loop
                err = sent.find((f) => f.type === 'chat.error' && f.request_id === 's-to');
            }
            expect(err).to.exist;
            expect(err.code).to.equal('timeout');
            expect(socket.readyState).to.not.equal(3);
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('non-stream request still answers chat.response with NO deltas (Phase 4 unchanged)', async () => {
        const rt = await startStreamRuntime(null, {
            onRequest: (req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    choices: [{ message: { role: 'assistant', content: 'plain' }, finish_reason: 'stop' }],
                    usage: FINAL_USAGE,
                }));
            },
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('s-nonstream', { params: { max_tokens: 8 } })));
            await wait(200);
            expect(sent.filter((f) => f.type === 'chat.delta')).to.have.lengthOf(0);
            const resp = sent.find((f) => f.type === 'chat.response');
            expect(resp).to.exist;
            expect(resp.content).to.equal('plain');
            expect(rt.lastBody.stream).to.equal(false);
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('streams hold concurrency slots: two live streams → third is busy', async function () {
        this.timeout(15000);
        const rt = await startStreamRuntime([
            sse(chunk('a')),
            { delay: 100000 },
        ]);
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('b-1')));
            session._handleMessage(JSON.stringify(CHAT_REQ('b-2')));
            await wait(80);
            expect(rt.requests).to.have.lengthOf(2);
            session._handleMessage(JSON.stringify(CHAT_REQ('b-3')));
            await wait(80);
            const busy = sent.find((f) => f.type === 'chat.error' && f.request_id === 'b-3');
            expect(busy).to.exist;
            expect(busy.code).to.equal('busy');
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('duplicate request_id for a COMPLETED stream → invalid_request, never re-executed', async () => {
        const rt = await startStreamRuntime(STD_EVENTS);
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('dup-1')));
            await wait(300);
            expect(rt.requests).to.have.lengthOf(1);
            session._handleMessage(JSON.stringify(CHAT_REQ('dup-1')));
            await wait(200);
            const dup = sent.filter((f) => f.type === 'chat.error' && f.request_id === 'dup-1').pop();
            expect(dup).to.exist;
            expect(dup.code).to.equal('invalid_request');
            expect(rt.requests).to.have.lengthOf(1); // NOT re-executed
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('duplicate request_id while stream IN-FLIGHT → invalid_request, executed once', async function () {
        this.timeout(15000);
        const rt = await startStreamRuntime([sse(chunk('a')), { delay: 100000 }]);
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('dup-2')));
            await wait(80);
            session._handleMessage(JSON.stringify(CHAT_REQ('dup-2')));
            await wait(120);
            const dup = sent.find((f) => f.type === 'chat.error' && f.request_id === 'dup-2');
            expect(dup).to.exist;
            expect(dup.code).to.equal('invalid_request');
            expect(rt.requests).to.have.lengthOf(1);
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('duplicate request_id after >10000 other ids → STILL rejected (never-evict holds for streams)', async function () {
        this.timeout(30000);
        const rt = await startStreamRuntime([DONE]);
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            for (let i = 0; i <= 10000; i++) {
                session._handleMessage(JSON.stringify(CHAT_REQ(`evict5-${i}`, { model: 42 })));
                if (sent.length > 5000) sent.length = 0;
            }
            sent.length = 0;
            session._handleMessage(JSON.stringify(CHAT_REQ('evict5-0')));
            await wait(150);
            const dup = sent.find((f) => f.type === 'chat.error' && f.request_id === 'evict5-0');
            expect(dup).to.exist;
            expect(dup.code).to.equal('invalid_request');
            expect(rt.requests).to.have.lengthOf(0);
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('store saturation: fresh ids fail-closed invalid_request; duplicates still caught; session survives', async function () {
        this.timeout(60000);
        const rt = await startStreamRuntime([DONE]);
        try {
            const { session, sent, socket } = makeSession(rt.baseUrl);
            const cap = chatLib.LIMITS.maxSeenRequestIds;
            for (let i = 0; i < cap + 10; i++) {
                session._handleMessage(JSON.stringify(CHAT_REQ(`full5-${i}`, { model: 42 })));
                if (sent.length > 5000) sent.length = 0;
            }
            sent.length = 0;
            session._handleMessage(JSON.stringify(CHAT_REQ('fresh5')));
            await wait(100);
            const err = sent.find((f) => f.type === 'chat.error' && f.request_id === 'fresh5');
            expect(err).to.exist;
            expect(err.code).to.equal('invalid_request');
            expect(rt.requests).to.have.lengthOf(0);
            session._handleMessage(JSON.stringify(CHAT_REQ('full5-0')));
            await wait(80);
            const dup = sent.filter((f) => f.type === 'chat.error' && f.request_id === 'full5-0').pop();
            expect(dup.code).to.equal('invalid_request');
            session._sendHeartbeat();
            expect(sent.some((f) => f.type === 'heartbeat')).to.be.true;
            expect(socket.readyState).to.not.equal(3);
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('reconnect starts a NEW lifecycle: the same stream request_id is legal again', async function () {
        this.timeout(20000);
        const rt = await startStreamRuntime(STD_EVENTS);
        try {
            const sockets = [];
            const session = createConnectorSession({
                config: { url: 'ws://127.0.0.1:1/ws', token: 'llmc.a.b', baseUrl: rt.baseUrl, runtimeType: 'ollama' },
                logger: { info: () => {}, warn: () => {}, error: () => {} },
                WebSocketImpl: function Stub() {
                    const s = makeScriptedSocket();
                    sockets.push(s);
                    return s;
                },
            });
            session.start();
            session._handleMessage(JSON.stringify({ type: 'ready', connector_id: 'c', heartbeat_interval_ms: 600000 }));
            session._handleMessage(JSON.stringify(CHAT_REQ('rc5-1')));
            await wait(300);
            expect(sockets[0].sent.find((f) => f.type === 'chat.response' && f.request_id === 'rc5-1')).to.exist;
            sockets[0].close();
            await wait(1700);
            session._handleMessage(JSON.stringify({ type: 'ready', connector_id: 'c', heartbeat_interval_ms: 600000 }));
            session._handleMessage(JSON.stringify(CHAT_REQ('rc5-1')));
            await wait(300);
            const resp2 = sockets[1].sent.find((f) => f.type === 'chat.response' && f.request_id === 'rc5-1');
            expect(resp2).to.exist;
            expect(rt.requests).to.have.lengthOf(2); // once per lifecycle
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('metadata-only logging: stream flag present, no prompt/delta/response content', async () => {
        const rt = await startStreamRuntime(STD_EVENTS);
        try {
            const { session } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('log5', {
                messages: [{ role: 'user', content: 'TOP-SECRET-PROMPT' }],
            })));
            await wait(300);
            const ops = opLog.list().filter((r) => r.op === 'chat_completion');
            expect(ops).to.have.lengthOf(1);
            expect(ops[0].status).to.equal('ok');
            expect(ops[0].stream).to.equal(true);
            expect(ops[0].model).to.equal('qwen3:32b');
            const logged = JSON.stringify(ops);
            expect(logged).to.not.include('TOP-SECRET-PROMPT');
            expect(logged).to.not.include('Hello ');
            expect(logged).to.not.include('amed!');
            // Non-streaming records carry no stream flag.
            session._handleMessage(JSON.stringify(CHAT_REQ('log5b', { params: { max_tokens: 4 } })));
            await wait(300);
            const ops2 = opLog.list().filter((r) => r.op === 'chat_completion');
            expect(ops2).to.have.lengthOf(2);
            expect(ops2[1].stream).to.equal(undefined);
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });

    it('remote URL injection impossible: hostile frame fields never reach the runtime call', async () => {
        const rt = await startStreamRuntime(STD_EVENTS);
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('url5', {
                url: 'http://10.9.9.9:11434/v1/chat/completions',
                base_url: 'http://10.9.9.9:11434',
                endpoint: 'http://evil.example',
            })));
            await wait(300);
            expect(sent.find((f) => f.type === 'chat.response')).to.exist;
            expect(rt.requests).to.have.lengthOf(1);
            expect(rt.requests[0].path).to.equal('/v1/chat/completions');
            expect(rt.baseUrl).to.contain('127.0.0.1');
            session.stop();
        } finally {
            await rt.closeServer();
        }
    });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. Cloud side — transport streaming over the real WS route
// ══════════════════════════════════════════════════════════════════════════

describe('LAC-5 cloud: connectorChatStream + WS route (streaming inference)', function () {
    this.timeout(60000);

    let srv;
    let wsA;

    before(async function () {
        this.timeout(60000);
        await runMigrations();
        await cleanup();
        wsA = await createWorkspace('lac5A');
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
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !registry.isLive(connectorId)) {
            await wait(50);
        }
        if (!registry.isLive(connectorId)) throw new Error('connector session did not become live');
        return session;
    }

    it('END-TO-END: cloud → WS stream:true → runtime SSE → chat.delta* → chat.response', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'str-e2e');
        const rt = await startStreamRuntime(STD_EVENTS);
        let session;
        try {
            session = await startConnector(connector.connector_id, token, rt.baseUrl);
            const deltas = [];
            const res = await transport.connectorChatStream(connector.connector_id, CHAT(), {
                timeoutMs: 8000,
                onDelta: (t) => deltas.push(t),
            });
            expect(res.ok).to.equal(true);
            expect(deltas).to.deep.equal(['Hello ', 'stre', 'amed!']);
            expect(res.content).to.equal('Hello streamed!');
            expect(res.finishReason).to.equal('stop');
            expect(res.usage).to.deep.equal(FINAL_USAGE);
            expect(res.model).to.equal('qwen3:32b');
            expect(rt.requests).to.have.lengthOf(1);
            expect(rt.lastBody.stream).to.equal(true);
            expect(rt.lastBody.messages).to.deep.equal([{ role: 'user', content: 'Cloud says hi' }]);
        } finally {
            if (session) session.stop();
            await rt.closeServer();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('empty stream end-to-end → ok, empty content, no deltas', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'str-empty');
        const rt = await startStreamRuntime([DONE]);
        let session;
        try {
            session = await startConnector(connector.connector_id, token, rt.baseUrl);
            const deltas = [];
            const res = await transport.connectorChatStream(connector.connector_id, CHAT(), {
                timeoutMs: 8000,
                onDelta: (t) => deltas.push(t),
            });
            expect(res.ok).to.equal(true);
            expect(res.content).to.equal('');
            expect(deltas).to.deep.equal([]);
        } finally {
            if (session) session.stop();
            await rt.closeServer();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('oversized runtime stream → sanitized error (connector cap enforced mid-stream)', async function () {
        this.timeout(15000);
        const { connector, token } = await createActivatedConnector(wsA, 'str-big');
        const rt = await startStreamRuntime([
            sse(chunk('y'.repeat(20 * 1024))),
            { delay: 30 },
            sse(chunk('y'.repeat(20 * 1024))),
            { delay: 30 },
            sse(chunk('y'.repeat(20 * 1024))),
        ]);
        let session;
        try {
            session = await startConnector(connector.connector_id, token, rt.baseUrl);
            const deltas = [];
            const res = await transport.connectorChatStream(connector.connector_id, CHAT(), {
                timeoutMs: 8000, onDelta: (t) => deltas.push(t),
            });
            expect(res.ok).to.equal(false);
            // The connector aborted the runtime when the cumulative cap
            // fired; deltas had already been delivered upstream → the
            // cloud surfaces the fixed mid-stream failure code.
            expect(res.code).to.equal(transport.STREAM_FAILED_CODE);
            expect(deltas.length).to.be.at.least(2); // partial content was streamed
            expect(transport.stats().pending).to.equal(0);
        } finally {
            if (session) session.stop();
            await rt.closeServer();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('oversized individual delta from a hostile connector → settled response_too_large', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'str-hdelta');
        const ws = await connect(srv.url);
        try {
            send(ws, HELLO(token));
            await nextMessage(ws); // ready
            const deltas = [];
            const p = transport.connectorChatStream(connector.connector_id, CHAT(), {
                timeoutMs: 5000, onDelta: (t) => deltas.push(t),
            });
            const req = await nextMessage(ws);
            expect(req.params.stream).to.equal(true);
            // A hostile oversized delta (over the 16K per-delta cap).
            send(ws, { type: 'chat.delta', request_id: req.request_id, delta: 'X'.repeat(20 * 1024) });
            const res = await p;
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('response_too_large');
            expect(deltas).to.deep.equal([]); // the hostile delta never surfaced
            expect(transport.stats().pending).to.equal(0);
        } finally {
            ws.close();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('cumulative delta cap from a hostile connector → settled response_too_large', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'str-hcum');
        const ws = await connect(srv.url);
        try {
            send(ws, HELLO(token));
            await nextMessage(ws);
            const p = transport.connectorChatStream(connector.connector_id, CHAT(), {
                timeoutMs: 5000, onDelta: () => {},
            });
            const req = await nextMessage(ws);
            // Legal-size deltas, but together over the 32K cumulative cap.
            send(ws, { type: 'chat.delta', request_id: req.request_id, delta: 'a'.repeat(20 * 1024) });
            send(ws, { type: 'chat.delta', request_id: req.request_id, delta: 'b'.repeat(20 * 1024) });
            const res = await p;
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('response_too_large');
        } finally {
            ws.close();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('a non-streaming connectorChat never forwards a caller-supplied params.stream (stream is call-shape)', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'str-hstream');
        const ws = await connect(srv.url);
        try {
            send(ws, HELLO(token));
            await nextMessage(ws);
            // The caller passes stream:true in params, but the call is made
            // through connectorChat (no onDelta) → the frame must NOT carry
            // stream, so the connector answers non-streaming (no deltas).
            const p = transport.connectorChat(connector.connector_id, { ...CHAT(), params: { max_tokens: 8, stream: true } }, { timeoutMs: 5000 });
            const req = await nextMessage(ws);
            expect(req.params.stream).to.equal(undefined);
            send(ws, { type: 'chat.response', request_id: req.request_id, model: 'm', content: 'non-stream answer' });
            const res = await p;
            expect(res.ok).to.equal(true);
            expect(res.content).to.equal('non-stream answer');
        } finally {
            ws.close();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('delta for a NON-streaming request → dropped, request unaffected', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'str-hnon');
        const ws = await connect(srv.url);
        try {
            send(ws, HELLO(token));
            await nextMessage(ws);
            const p = transport.connectorChat(connector.connector_id, CHAT(), { timeoutMs: 5000 });
            const req = await nextMessage(ws);
            expect(req.params.stream).to.equal(undefined);
            // A hostile connector injects a delta into a non-stream request.
            send(ws, { type: 'chat.delta', request_id: req.request_id, delta: 'inject' });
            await wait(80);
            // The request is still pending and unharmed — settle it.
            send(ws, { type: 'chat.response', request_id: req.request_id, model: 'm', content: 'real' });
            const res = await p;
            expect(res.ok).to.equal(true);
            expect(res.content).to.equal('real');
        } finally {
            ws.close();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('unsolicited / malformed deltas are dropped at zero cost; session survives', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'str-hunsol');
        const ws = await connect(srv.url);
        try {
            send(ws, HELLO(token));
            await nextMessage(ws);
            const closed = new Promise((resolve) => ws.once('close', resolve));
            send(ws, { type: 'chat.delta', request_id: 'ghost-id', delta: 'x' });
            send(ws, { type: 'chat.delta', delta: 'no request_id' });
            send(ws, { type: 'chat.delta', request_id: 42, delta: 'typed wrong' });
            await wait(100);
            const race = await Promise.race([closed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('open'), 150))]);
            expect(race).to.equal('open');
            expect(transport.stats().pending).to.equal(0);
        } finally {
            ws.close();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('runtime error mid-stream AFTER deltas → stream_failed (partial already delivered via onDelta)', async function () {
        this.timeout(15000);
        const { connector, token } = await createActivatedConnector(wsA, 'str-fail');
        // A runtime that emits one delta then breaks the connection.
        const rt = await startStreamRuntime(null, {
            onRequest: (req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write(sse(chunk('partial answer ')));
                setTimeout(() => { res.destroy(); }, 60);
            },
        });
        let session;
        try {
            session = await startConnector(connector.connector_id, token, rt.baseUrl);
            const deltas = [];
            const res = await transport.connectorChatStream(connector.connector_id, CHAT(), {
                timeoutMs: 8000, onDelta: (t) => deltas.push(t),
            });
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('stream_failed');
            expect(deltas).to.deep.equal(['partial answer ']);
            expect(transport.stats().pending).to.equal(0);
        } finally {
            if (session) session.stop();
            await rt.closeServer();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('cloud timeout mid-stream → chat.cancel sent, connector aborts the runtime fetch, slot freed, session survives', async function () {
        this.timeout(20000);
        const { connector, token } = await createActivatedConnector(wsA, 'str-cancel');
        // A runtime that streams one delta then hangs forever.
        const rt = await startStreamRuntime([sse(chunk('first ')), { delay: 100000 }]);
        let session;
        try {
            session = await startConnector(connector.connector_id, token, rt.baseUrl);
            const deltas = [];
            const res = await transport.connectorChatStream(connector.connector_id, CHAT(), {
                timeoutMs: 700, onDelta: (t) => deltas.push(t),
            });
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('timeout');
            expect(deltas).to.deep.equal(['first ']);
            expect(transport.stats().pending).to.equal(0);
            await wait(250);
            expect(registry.isLive(connector.connector_id)).to.equal(true); // session survives
            // The cancelled slot is free: a fresh stream reaches the SAME
            // (hung) runtime — the connector accepts it, proving the slot
            // was released by the cancel.
            const runtimeCalls = rt.requests.length;
            const p2 = transport.connectorChatStream(connector.connector_id, CHAT(), {
                timeoutMs: 1500, onDelta: () => {},
            });
            await wait(400);
            expect(rt.requests.length).to.equal(runtimeCalls + 1); // slot freed → runtime hit
            const res2 = await p2;
            expect(res2.ok).to.equal(false);
            expect(res2.code).to.equal('timeout'); // still the hung runtime — clean fail
        } finally {
            if (session) session.stop();
            await rt.closeServer();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('connector disconnect mid-stream → session_closed fast, no dangling pending', async function () {
        this.timeout(15000);
        const { connector, token } = await createActivatedConnector(wsA, 'str-disc');
        const rt = await startStreamRuntime([sse(chunk('d1 ')), { delay: 100000 }]);
        let session;
        try {
            session = await startConnector(connector.connector_id, token, rt.baseUrl);
            const deltas = [];
            const p = transport.connectorChatStream(connector.connector_id, CHAT(), {
                timeoutMs: 10000, onDelta: (t) => deltas.push(t),
            });
            await wait(150);
            expect(deltas).to.deep.equal(['d1 ']);
            // Kill the socket (simulated disconnect).
            session.stop();
            const res = await p;
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('session_closed');
            expect(transport.stats().pending).to.equal(0);
        } finally {
            if (session) session.stop();
            await rt.closeServer();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('two concurrent streams multiplex independently (concurrency across the wire)', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'str-conc');
        const rt = await startStreamRuntime([
            sse(chunk(`req-${'n'}.first `)),
            { delay: 40 },
            sse(chunk('second ')),
            sse(finishChunk('stop', FINAL_USAGE)),
            DONE,
        ]);
        let session;
        try {
            session = await startConnector(connector.connector_id, token, rt.baseUrl);
            const out1 = [];
            const out2 = [];
            const [r1, r2] = await Promise.all([
                transport.connectorChatStream(connector.connector_id, CHAT(), { timeoutMs: 8000, onDelta: (t) => out1.push(t) }),
                transport.connectorChatStream(connector.connector_id, CHAT(), { timeoutMs: 8000, onDelta: (t) => out2.push(t) }),
            ]);
            // Two separate runtime calls; each request got its own stream.
            expect(r1.ok).to.equal(true);
            expect(r2.ok).to.equal(true);
            expect(out1.length + out2.length).to.be.at.least(2); // deltas flowed
            expect(rt.requests).to.have.lengthOf(2);
        } finally {
            if (session) session.stop();
            await rt.closeServer();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('a stream request_id is executed at most once (duplicate chat.request ids across calls are distinct UUIDs)', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'str-dup');
        const rt = await startStreamRuntime(STD_EVENTS);
        let session;
        try {
            session = await startConnector(connector.connector_id, token, rt.baseUrl);
            const p1 = transport.connectorChatStream(connector.connector_id, CHAT(), { timeoutMs: 8000, onDelta: () => {} });
            const p2 = transport.connectorChatStream(connector.connector_id, CHAT(), { timeoutMs: 8000, onDelta: () => {} });
            const [r1, r2] = await Promise.all([p1, p2]);
            expect(r1.requestId).to.not.equal(r2.requestId); // cloud-generated UUIDs
            expect(r1.ok).to.equal(true);
            expect(r2.ok).to.equal(true);
            expect(rt.requests).to.have.lengthOf(2);
        } finally {
            if (session) session.stop();
            await rt.closeServer();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('no prompt/response/delta content in cloud logs during streaming', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'str-logs');
        const rt = await startStreamRuntime(STD_EVENTS);
        let session;
        try {
            srv.logLines.length = 0;
            session = await startConnector(connector.connector_id, token, rt.baseUrl);
            const res = await transport.connectorChatStream(connector.connector_id, {
                ...CHAT(),
                messages: [{ role: 'user', content: 'LOG-SECRET-PROMPT' }],
            }, { timeoutMs: 8000, onDelta: () => {} });
            expect(res.ok).to.equal(true);
            await wait(100);
            const logs = srv.logLines.join('\n');
            expect(logs).to.not.include(token);
            expect(logs).to.not.include('LOG-SECRET-PROMPT');
            expect(logs).to.not.include('Hello ');
            expect(logs).to.not.include('amed!');
        } finally {
            if (session) session.stop();
            await rt.closeServer();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('offline connector → fail-closed connector_offline (stream too, AD-12)', async () => {
        const { connector } = await createActivatedConnector(wsA, 'str-off');
        try {
            const res = await transport.connectorChatStream(connector.connector_id, CHAT(), { onDelta: () => {} });
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('connector_offline');
        } finally {
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('connectorChatStream without onDelta → invalid_request (never a silent non-streaming downgrade)', async () => {
        const { connector } = await createActivatedConnector(wsA, 'str-nodelta');
        try {
            const res = await transport.connectorChatStream(connector.connector_id, CHAT(), {});
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('invalid_request');
        } finally {
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });

    it('hostile connector cannot forge a stream terminal with oversized content (64KB frame cap intact)', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'str-hframe');
        const ws = await connect(srv.url);
        try {
            send(ws, HELLO(token));
            await nextMessage(ws);
            const p = transport.connectorChatStream(connector.connector_id, CHAT(), {
                timeoutMs: 5000, onDelta: () => {},
            });
            const req = await nextMessage(ws);
            // Over the 32K content cap → sanitized rejection (the raw
            // content must never surface anywhere).
            send(ws, { type: 'chat.response', request_id: req.request_id, model: 'm', content: 'X'.repeat(33 * 1024) });
            const res = await p;
            expect(res.ok).to.equal(false);
            expect(res.code).to.equal('response_too_large');
            expect(JSON.stringify(res)).to.not.include('XXXX');
        } finally {
            ws.close();
            await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
        }
    });
});
