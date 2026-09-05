// ======================================================
// Streaming adapter + session tests — migrated from backend
// tests/ai-connector-streaming.test.js (adapter + session blocks).
// Package-owned copy: identical logic, autonomous runner.
// ======================================================

const http = require('http');
const { it, describe, expect } = require('./harness.cjs');
const { chatCompletionStream, normalizeOpenAiStreamChunk } = require('../lib/runtime-adapters/index.cjs');
const { createConnectorSession } = require('../lib/connector.cjs');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function startFakeRuntime(handler) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            server.requests.push({ method: req.method, path: req.url });
            handler(req, res, server);
        });
        server.requests = [];
        server.listen(0, '127.0.0.1', () => {
            server.baseUrl = `http://127.0.0.1:${server.address().port}`;
            server.closeServer = () => new Promise((r) => server.close(() => r()));
            resolve(server);
        });
    });
}

function sse(res, chunks) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
}

const chunk = (text, extra = {}) => ({
    id: 'x', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: text != null ? { content: text } : {}, finish_reason: null }],
    ...extra,
});

describe('streaming adapter: chatCompletionStream', () => {
    it('normal stream: deltas in order → joined content + finish + usage + [DONE]', async () => {
        const rt = await startFakeRuntime((req, res) => {
            sse(res, [
                chunk('Hel'), chunk('lo '), chunk('world'),
                { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
            ]);
        });
        try {
            const deltas = [];
            const res = await chatCompletionStream({
                baseUrl: rt.baseUrl, model: 'm', messages: [{ role: 'user', content: 'x' }],
                onDelta: (t) => deltas.push(t),
            });
            expect.equal(res.ok, true);
            expect.deepEqual(deltas, ['Hel', 'lo ', 'world']);
            expect.equal(res.content, 'Hello world');
            expect.equal(res.finishReason, 'stop');
            expect.deepEqual(res.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
        } finally { await rt.closeServer(); }
    });

    it('empty stream ([DONE] first) → ok with empty content', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: [DONE]\n\n');
            res.end();
        });
        try {
            const res = await chatCompletionStream({
                baseUrl: rt.baseUrl, model: 'm', messages: [{ role: 'user', content: 'x' }], onDelta: () => {},
            });
            expect.equal(res.ok, true);
            expect.equal(res.content, '');
        } finally { await rt.closeServer(); }
    });

    it('malformed SSE → bad_response; after partial content the partial is carried', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: {"choices":[{"delta":{"content":"par"}}]}\n\n');
            res.write('data: this is not json\n\n');
            res.end();
        });
        try {
            const res = await chatCompletionStream({
                baseUrl: rt.baseUrl, model: 'm', messages: [{ role: 'user', content: 'x' }], onDelta: () => {},
            });
            expect.equal(res.ok, false);
            expect.equal(res.code, 'bad_response');
            expect.equal(res.partial, 'par');
        } finally { await rt.closeServer(); }
    });

    it('oversized cumulative stream → response_too_large; huge single chunk split ≤ maxDeltaChars', async () => {
        const rt = await startFakeRuntime((req, res) => {
            sse(res, [chunk('x'.repeat(17 * 1024))]);
        });
        try {
            const res = await chatCompletionStream({
                baseUrl: rt.baseUrl, model: 'm', messages: [{ role: 'user', content: 'x' }], onDelta: () => {},
                maxStreamedContentChars: 16 * 1024,
            });
            expect.equal(res.ok, false);
            expect.equal(res.code, 'response_too_large');
        } finally { await rt.closeServer(); }

        const rt2 = await startFakeRuntime((req, res) => {
            sse(res, [chunk('y'.repeat(20 * 1024))]);
        });
        try {
            const deltas = [];
            const res = await chatCompletionStream({
                baseUrl: rt2.baseUrl, model: 'm', messages: [{ role: 'user', content: 'x' }],
                onDelta: (t) => deltas.push(t),
            });
            expect.equal(res.ok, true);
            expect.lengthOf(deltas, 2);
            expect.equal(deltas[0].length, 16 * 1024);
            expect.equal(deltas[1].length, 4 * 1024);
        } finally { await rt2.closeServer(); }
    });

    it('external abort mid-stream → cancelled, no further deltas', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const rt = await startFakeRuntime(async (req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify(chunk('first'))}\n\n`);
            await gate;
            res.write(`data: ${JSON.stringify(chunk('never'))}\n\n`);
            res.end();
        });
        const ac = new AbortController();
        const deltas = [];
        try {
            const p = chatCompletionStream({
                baseUrl: rt.baseUrl, model: 'm', messages: [{ role: 'user', content: 'x' }],
                signal: ac.signal, onDelta: (t) => deltas.push(t),
            });
            await wait(60);
            ac.abort();
            release();
            const res = await p;
            expect.equal(res.ok, false);
            expect.equal(res.code, 'cancelled');
            expect.deepEqual(deltas, ['first']);
        } finally {
            ac.abort();
            await rt.closeServer();
        }
    });

    it('normalizeOpenAiStreamChunk: drops unknown fields, keeps delta/finish/usage; role-only ok', () => {
        const ok = normalizeOpenAiStreamChunk(chunk('hi', { service_tier: 'free', evil: 1 }));
        expect.equal(ok.ok, true);
        expect.equal(ok.text, 'hi');
        const roleOnly = normalizeOpenAiStreamChunk({ choices: [{ index: 0, delta: { role: 'assistant' } }] });
        expect.equal(roleOnly.ok, true);
        expect.equal(roleOnly.text, null);
        const usageOnly = normalizeOpenAiStreamChunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        expect.equal(usageOnly.ok, true);
        expect.equal(usageOnly.text, null);
        expect.deepEqual(usageOnly.usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
        expect.equal(normalizeOpenAiStreamChunk({ choices: 'nope' }).ok, false);
        expect.equal(normalizeOpenAiStreamChunk(null).ok, false);
    });
});

describe('streaming session: stream:true → N× chat.delta + ONE terminal frame', () => {
    function makeSession(runtimeBase) {
        const sent = [];
        const handlers = {};
        const socket = {
            readyState: 1,
            on(event, fn) { (handlers[event] = handlers[event] || []).push(fn); },
            send: (raw) => sent.push(JSON.parse(raw)),
            close() { this.readyState = 3; (handlers.close || []).forEach((f) => f()); },
        };
        const session = createConnectorSession({
            config: { url: 'ws://127.0.0.1:1/ws', token: 'llmc.a.b', baseUrl: runtimeBase, runtimeType: 'ollama' },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
            WebSocketImpl: function Stub() { return socket; },
        });
        session.start();
        session._handleMessage(JSON.stringify({ type: 'ready', connector_id: 'c', heartbeat_interval_ms: 600000 }));
        return { session, sent };
    }

    const STREAM_REQ = (requestId) => ({
        type: 'chat.request', request_id: requestId, model: 'qwen3:32b',
        messages: [{ role: 'user', content: 'hi' }],
        params: { stream: true }, timeout_ms: 5000,
    });

    it('normal stream: deltas in order, then ONE chat.response with joined content', async () => {
        const rt = await startFakeRuntime((req, res) => {
            sse(res, [chunk('Hel'), chunk('lo')]);
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(STREAM_REQ('s-1')));
            await wait(100);
            const deltas = sent.filter((f) => f.type === 'chat.delta');
            expect.lengthOf(deltas, 2);
            expect.equal(deltas[0].delta, 'Hel');
            expect.equal(deltas[1].delta, 'lo');
            const terminal = sent.filter((f) => f.type === 'chat.response');
            expect.lengthOf(terminal, 1);
            expect.equal(terminal[0].content, 'Hello');
            expect.equal(sent.filter((f) => f.type === 'chat.error').length, 0);
            session.stop();
        } finally { await rt.closeServer(); }
    });

    it('non-stream request still answers chat.response with NO deltas (Phase 4 unchanged)', async () => {
        const rt = await startFakeRuntime((req, res) => {
            let b = '';
            req.on('data', (c) => { b += c; });
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'plain' }, finish_reason: 'stop' }] }));
            });
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify({
                type: 'chat.request', request_id: 'n-1', model: 'qwen3:32b',
                messages: [{ role: 'user', content: 'hi' }], params: {},
            }));
            await wait(100);
            expect.lengthOf(sent.filter((f) => f.type === 'chat.delta'), 0);
            const resp = sent.find((f) => f.type === 'chat.response');
            expect.equal(resp.content, 'plain');
            session.stop();
        } finally { await rt.closeServer(); }
    });

    it('oversized cumulative stream → chat.error response_too_large; session survives', async () => {
        const rt = await startFakeRuntime((req, res) => {
            sse(res, [chunk('z'.repeat(30 * 1024)), chunk('z'.repeat(30 * 1024))]);
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(STREAM_REQ('s-big')));
            await wait(200);
            const err = sent.find((f) => f.type === 'chat.error' && f.request_id === 's-big');
            expect.exist(err);
            expect.equal(err.code, 'response_too_large');
            expect.equal(session.getSnapshot().phase, 'ready');
            session.stop();
        } finally { await rt.closeServer(); }
    });

    it('duplicate stream request_id after completion → invalid_request, never re-executed', async () => {
        const rt = await startFakeRuntime((req, res) => {
            sse(res, [chunk('ok')]);
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(STREAM_REQ('s-dup')));
            await wait(100);
            session._handleMessage(JSON.stringify(STREAM_REQ('s-dup')));
            await wait(60);
            expect.lengthOf(rt.requests, 1);
            const err = sent.find((f) => f.type === 'chat.error' && f.request_id === 's-dup');
            expect.equal(err.code, 'invalid_request');
            session.stop();
        } finally { await rt.closeServer(); }
    });

    it('remote URL injection impossible: hostile frame fields never reach the runtime call', async () => {
        const rt = await startFakeRuntime((req, res) => { sse(res, [chunk('ok')]); });
        const attacker = await startFakeRuntime((req, res) => { sse(res, [chunk('hijacked')]); });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify({
                ...STREAM_REQ('s-sec'), url: attacker.baseUrl, base_url: attacker.baseUrl, endpoint: '/evil',
            }));
            await wait(100);
            expect.lengthOf(attacker.requests, 0);
            expect.equal(rt.requests[0].path, '/v1/chat/completions');
            expect.equal(sent.find((f) => f.type === 'chat.response').content, 'ok');
            session.stop();
        } finally {
            await rt.closeServer();
            await attacker.closeServer();
        }
    });
});
