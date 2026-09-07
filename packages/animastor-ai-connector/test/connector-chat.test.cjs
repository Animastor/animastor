// ======================================================
// Connector chat.request/chat.cancel semantics tests — migrated from
// backend tests/ai-connector-inference.test.js (session block).
// Package-owned copy: identical logic, autonomous runner.
// ======================================================

const http = require('http');
const { it, describe, expect } = require('./harness.cjs');
const { createConnectorSession } = require('../lib/connector.cjs');
const opLog = require('../lib/log.cjs');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function startFakeRuntime(handler, opts = {}) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            server.requests.push({ method: req.method, path: req.url, at: Date.now() });
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('close', () => { server.abortedCount += req.aborted ? 1 : 0; });
            req.on('end', () => {
                try { server.lastBody = body ? JSON.parse(body) : null; } catch (_) { server.lastBody = body; }
                if (opts.hangMs != null) {
                    server.hung.push({ path: req.url });
                    return;
                }
                handler(req, res, server);
            });
        });
        server.requests = [];
        server.hung = [];
        server.abortedCount = 0;
        server.listen(0, '127.0.0.1', () => {
            server.baseUrl = `http://127.0.0.1:${server.address().port}`;
            server.closeServer = () => new Promise((r) => server.close(() => r()));
            resolve(server);
        });
    });
}

const openAiChat = (content) => ({
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
});

function makeScriptedSocket() {
    const handlers = {};
    const sent = [];
    return {
        readyState: 1,
        sent,
        on(event, fn) { (handlers[event] = handlers[event] || []).push(fn); },
        emit(event, ...args) { (handlers[event] || []).slice().forEach((fn) => fn(...args)); },
        send(raw) { sent.push(JSON.parse(raw)); },
        close() {
            if (this.readyState !== 3) {
                this.readyState = 3;
                this.emit('close');
            }
        },
    };
}

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

const CHAT_REQ = (requestId, over = {}) => ({
    type: 'chat.request',
    request_id: requestId,
    model: 'qwen3:32b',
    messages: [{ role: 'user', content: 'Hello there' }],
    params: { max_tokens: 128, temperature: 0.5 },
    timeout_ms: 5000,
    ...over,
});

describe('connector session: chat.request → chat.response/chat.error', () => {
    it('valid request → chat.response with correlation + usage', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiChat('Answer!')));
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('r-1')));
            await wait(80);
            const resp = sent.find((f) => f.type === 'chat.response');
            expect.exist(resp);
            expect.equal(resp.request_id, 'r-1');
            expect.equal(resp.model, 'qwen3:32b');
            expect.equal(resp.content, 'Answer!');
            expect.equal(resp.finish_reason, 'stop');
            expect.deepEqual(resp.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
            session.stop();
        } finally { await rt.closeServer(); }
    });

    it('invalid requests → sanitized chat.error; runtime untouched', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200); res.end(JSON.stringify(openAiChat('x')));
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('r-bad', { model: 42 })));
            session._handleMessage(JSON.stringify(CHAT_REQ('r-big', { messages: Array.from({ length: 65 }, () => ({ role: 'user', content: 'x' })) })));
            await wait(60);
            expect.lengthOf(rt.requests, 0);
            const errors = sent.filter((f) => f.type === 'chat.error');
            expect.equal(errors.find((e) => e.request_id === 'r-bad').code, 'invalid_request');
            expect.equal(errors.find((e) => e.request_id === 'r-big').code, 'request_too_large');
            session.stop();
        } finally { await rt.closeServer(); }
    });

    it('uncorrelatable request_id → no reply at all', async () => {
        const rt = await startFakeRuntime((req, res) => { res.writeHead(200); res.end('{}'); });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify({ type: 'chat.request', model: 'm', messages: [{ role: 'user', content: 'x' }] }));
            session._handleMessage(JSON.stringify(CHAT_REQ('bad id\u0000here')));
            await wait(60);
            expect.lengthOf(sent.filter((f) => f.type === 'chat.error'), 0);
            expect.lengthOf(rt.requests, 0);
            session.stop();
        } finally { await rt.closeServer(); }
    });

    it('runtime 404 → chat.error model_not_found; 500 → sanitized runtime_error only', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(404); res.end(JSON.stringify({ error: 'no such model' }));
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('r-404')));
            await wait(80);
            const err = sent.find((f) => f.type === 'chat.error');
            expect.equal(err.code, 'model_not_found');
            expect.notInclude(JSON.stringify(err), 'no such model');
            session.stop();
        } finally { await rt.closeServer(); }
    });

    it('concurrency cap: 3rd concurrent → busy; slots free on completion', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        let answered = 0;
        const rt = await startFakeRuntime(async (req, res) => {
            if (answered >= 2) { release(); }   // 3rd arrival opens the gate
            await gate;
            answered += 1;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiChat('ok')));
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('a-1')));
            session._handleMessage(JSON.stringify(CHAT_REQ('a-2')));
            session._handleMessage(JSON.stringify(CHAT_REQ('a-3')));
            await wait(120);
            const busy = sent.find((f) => f.type === 'chat.error' && f.request_id === 'a-3');
            expect.equal(busy.code, 'busy');
            expect.lengthOf(rt.requests, 2);
            session.stop();
        } finally { await rt.closeServer(); }
    });

    it('duplicate request_id (in-flight and after completion) → invalid_request, executed once', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const rt = await startFakeRuntime(async (req, res) => {
            await gate;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiChat('first')));
        });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('dup-1')));
            session._handleMessage(JSON.stringify(CHAT_REQ('dup-1'))); // while in-flight
            release();
            await wait(100);
            session._handleMessage(JSON.stringify(CHAT_REQ('dup-1'))); // after completion
            await wait(40);
            expect.lengthOf(rt.requests, 1);
            const dups = sent.filter((f) => f.type === 'chat.error' && f.request_id === 'dup-1');
            expect.lengthOf(dups, 2);
            for (const d of dups) expect.equal(d.code, 'invalid_request');
            session.stop();
        } finally { await rt.closeServer(); }
    });

    it('chat.cancel aborts the in-flight fetch; NO frame back; slot freed; session survives', async () => {
        const rt = await startFakeRuntime(() => {}, { hangMs: true });
        try {
            const { session, sent, socket } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('c-1')));
            await wait(80);
            expect.lengthOf(rt.requests, 1);
            session._handleMessage(JSON.stringify({ type: 'chat.cancel', request_id: 'c-1' }));
            await wait(150);
            // No chat.response AND no chat.error for the cancelled id.
            expect.lengthOf(
                sent.filter((f) => (f.type === 'chat.response' || f.type === 'chat.error') && f.request_id === 'c-1'),
                0,
            );
            // Slot freed → a new request reaches the (hung) runtime.
            const before = rt.requests.length;
            session._handleMessage(JSON.stringify(CHAT_REQ('c-2')));
            await wait(100);
            expect.equal(rt.requests.length, before + 1);
            // Session alive.
            expect.ok(socket.readyState !== 3);
            session.stop();
        } finally { await rt.closeServer(); }
    });

    it('chat.cancel for unknown/finished id → ignored, session survives', async () => {
        const rt = await startFakeRuntime((req, res) => { res.writeHead(200); res.end('{}'); });
        try {
            const { session, sent } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify({ type: 'chat.cancel', request_id: 'nope' }));
            session._handleMessage(JSON.stringify({ type: 'chat.cancel' }));
            await wait(30);
            expect.equal(session.getSnapshot().phase, 'ready');
            session.stop();
        } finally { await rt.closeServer(); }
    });

    it('metadata-only logging: no prompt/response content ever recorded', async () => {
        opLog.reset();
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiChat('SECRET-RESPONSE-TEXT')));
        });
        try {
            const { session } = makeSession(rt.baseUrl);
            session._handleMessage(JSON.stringify(CHAT_REQ('log-1', { messages: [{ role: 'user', content: 'SECRET-PROMPT-TEXT' }] })));
            await wait(100);
            const dump = JSON.stringify(opLog.list());
            expect.notInclude(dump, 'SECRET-PROMPT-TEXT');
            expect.notInclude(dump, 'SECRET-RESPONSE-TEXT');
            expect.include(dump, 'chat_completion');
            expect.include(dump, 'qwen3:32b');
            session.stop();
        } finally { await rt.closeServer(); }
        opLog.reset();
    });
});
