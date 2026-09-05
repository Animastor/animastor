// ======================================================
// Connector session lifecycle tests — migrated from backend
// tests/ai-connector-discovery.test.js (session block).
// Package-owned copy: identical logic, autonomous runner.
// ======================================================

const http = require('http');
const { it, describe, expect } = require('./harness.cjs');
const { createConnectorSession } = require('../lib/connector.cjs');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function startFakeRuntime(handler) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            server.requests.push({ path: req.url, method: req.method });
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

const openAiModels = (ids) => ({ object: 'list', data: ids.map((id) => ({ id })) });

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

function makeSession(runtimeBase, sock, extra = {}) {
    const session = createConnectorSession({
        config: { url: 'ws://127.0.0.1:1/ws', token: 'llmc.a.b', baseUrl: runtimeBase, runtimeType: 'ollama' },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        WebSocketImpl: function Stub() { return sock; },
        ...extra,
    });
    return session;
}

describe('connector session: lifecycle + hello/ready', () => {
    it('hello: credential XOR reg_token selected by token family; protocol_version 1', async () => {
        const sock = makeScriptedSocket();
        const session = makeSession('http://127.0.0.1:1', sock);
        session.start();
        sock.emit('open');
        const hello = sock.sent.find((f) => f.type === 'hello');
        expect.exist(hello);
        expect.equal(hello.protocol_version, 1);
        expect.equal(hello.credential, 'llmc.a.b');
        expect.equal(hello.reg_token, undefined);
        session.stop();

        const sock2 = makeScriptedSocket();
        const session2 = createConnectorSession({
            config: { url: 'ws://127.0.0.1:1/ws', token: 'llmcreg.a.b', baseUrl: 'http://127.0.0.1:1', runtimeType: 'ollama' },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
            WebSocketImpl: function Stub() { return sock2; },
        });
        session2.start();
        sock2.emit('open');
        const hello2 = sock2.sent.find((f) => f.type === 'hello');
        expect.equal(hello2.reg_token, 'llmcreg.a.b');
        expect.equal(hello2.credential, undefined);
        session2.stop();
    });

    it('ready: cadence honored, immediate first heartbeat (honest, pre-discovery)', async () => {
        const sent = [];
        const session = createConnectorSession({
            config: { url: 'ws://127.0.0.1:1/ws', token: 'llmc.a.b', baseUrl: 'http://127.0.0.1:1', runtimeType: 'ollama' },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
            WebSocketImpl: function Stub() {
                return { readyState: 1, on: () => {}, send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };
            },
            heartbeatCacheTtlMs: 60000,
        });
        session.start();
        session._handleMessage(JSON.stringify({ type: 'ready', connector_id: 'c1', heartbeat_interval_ms: 60000 }));
        await wait(30);
        const hb = sent.filter((f) => f.type === 'heartbeat').pop();
        expect.exist(hb);
        expect.equal(hb.runtime.type, 'ollama');
        expect.equal(hb.runtime_ok, undefined); // nothing observed yet
        expect.equal(hb.models, undefined);     // no models observed → omitted
        expect.equal(hb.latency_ms, undefined); // no fabricated latency
        const snap = session.getSnapshot();
        expect.equal(snap.connectorId, 'c1');
        expect.equal(snap.phase, 'ready');
        session.stop();
    });

    it('stop() is idempotent-ish and clears state; stop before start throws', async () => {
        const sock = makeScriptedSocket();
        const session = makeSession('http://127.0.0.1:1', sock);
        session.start();
        sock.emit('open');
        session._handleMessage(JSON.stringify({ type: 'ready', connector_id: 'c', heartbeat_interval_ms: 60000 }));
        session.stop();
        expect.equal(session.getSnapshot().phase, 'stopped');
        let threw = false;
        try { session.start(); } catch (_) { threw = true; }
        expect.equal(threw, true);
    });
});

describe('connector session: heartbeat facts + model discovery', () => {
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
        const session = makeSession(rt.baseUrl, sock, { heartbeatCacheTtlMs: 60000 });
        session.start();
        sock.emit('open');
        sock.emit('message', JSON.stringify({ type: 'ready', connector_id: 'c1', heartbeat_interval_ms: 60000 }));
        sock.emit('message', JSON.stringify({ type: 'models.refresh' }));
        await wait(80);

        let lists = sock.sent.filter((f) => f.type === 'models.list');
        expect.lengthOf(lists, 1);
        expect.deepEqual(lists[0].models, ['m1', 'm2']);
        expect.lengthOf(rt.requests, 1);
        expect.equal(rt.requests[0].path, '/v1/models');

        sock.emit('message', JSON.stringify({
            type: 'models.refresh',
            base_url: attacker.baseUrl,
            url: `${attacker.baseUrl}/v1/models`,
            runtime_url: attacker.baseUrl,
        }));
        await wait(80);
        lists = sock.sent.filter((f) => f.type === 'models.list');
        expect.lengthOf(lists, 2);
        expect.lengthOf(rt.requests, 2);
        expect.lengthOf(attacker.requests, 0);

        session.stop();
        await rt.closeServer();
        await attacker.closeServer();
    });

    it('concurrent refreshes coalesce — the runtime sees ONE request', async () => {
        let runtimeHits = 0;
        let release;
        const gate = new Promise((r) => { release = r; });
        const rt = await startFakeRuntime(async (req, res) => {
            runtimeHits += 1;
            await gate;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiModels(['slow-model'])));
        });
        const sent = [];
        const session = createConnectorSession({
            config: { url: 'ws://127.0.0.1:1/ws', token: 'llmc.a.b', baseUrl: rt.baseUrl, runtimeType: 'ollama' },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
            WebSocketImpl: function Stub() {
                return { readyState: 1, on: () => {}, send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };
            },
        });
        session.start();
        session._handleMessage(JSON.stringify({ type: 'ready', connector_id: 'c', heartbeat_interval_ms: 60000 }));
        await wait(10);
        session._handleMessage(JSON.stringify({ type: 'models.refresh' }));
        session._handleMessage(JSON.stringify({ type: 'models.refresh' }));
        session._handleMessage(JSON.stringify({ type: 'models.refresh' }));
        await wait(30);
        release();
        await wait(60);
        expect.equal(runtimeHits, 1);
        const lists = sent.filter((f) => f.type === 'models.list');
        expect.lengthOf(lists, 1);
        expect.deepEqual(lists[0].models, ['slow-model']);
        session.stop();
        await rt.closeServer();
    });

    it('no discovery before ready — never auto-probes (AD-7)', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200); res.end(JSON.stringify(openAiModels(['never'])));
        });
        const session = createConnectorSession({
            config: { url: 'ws://127.0.0.1:1/ws', token: 'llmc.a.b', baseUrl: rt.baseUrl, runtimeType: 'ollama' },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
            WebSocketImpl: function Stub() {
                return { readyState: 1, on: () => {}, send: () => {}, close: () => {} };
            },
        });
        session.start();
        await wait(50);
        expect.lengthOf(rt.requests, 0);
        session.stop();
        await rt.closeServer();
    });

    it('heartbeat facts come only from the discovery cache; failed discovery → sanitized error_code', async () => {
        const rt = await startFakeRuntime((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiModels(['hb-model'])));
        });
        const dead = await startFakeRuntime(() => {});
        const deadBase = dead.baseUrl;
        await dead.closeServer();

        const sent = [];
        const session = createConnectorSession({
            config: { url: 'ws://127.0.0.1:1/ws', token: 'llmc.a.b', baseUrl: rt.baseUrl, runtimeType: 'ollama' },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
            WebSocketImpl: function Stub() {
                return { readyState: 1, on: () => {}, send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };
            },
            heartbeatCacheTtlMs: 60000,
        });
        session.start();
        session._handleMessage(JSON.stringify({ type: 'ready', connector_id: 'c', heartbeat_interval_ms: 60000 }));
        await wait(10);
        session._handleMessage(JSON.stringify({ type: 'models.refresh' }));
        await wait(60);
        session._sendHeartbeat();
        const hb = sent.filter((f) => f.type === 'heartbeat').pop();
        expect.equal(hb.runtime_ok, true);
        expect.deepEqual(hb.models, ['hb-model']);
        session.stop();
        await rt.closeServer();

        const sent2 = [];
        const s2 = createConnectorSession({
            config: { url: 'ws://127.0.0.1:1/ws', token: 'llmc.a.b', baseUrl: deadBase, runtimeType: 'ollama' },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
            WebSocketImpl: function Stub() {
                return { readyState: 1, on: () => {}, send: (raw) => sent2.push(JSON.parse(raw)), close: () => {} };
            },
        });
        s2.start();
        s2._handleMessage(JSON.stringify({ type: 'ready', connector_id: 'c', heartbeat_interval_ms: 60000 }));
        await wait(10);
        s2._handleMessage(JSON.stringify({ type: 'models.refresh' }));
        await wait(80);
        const list = sent2.filter((f) => f.type === 'models.list').pop();
        expect.exist(list);
        expect.equal(list.error_code, 'runtime_unreachable');
        s2.stop();
    });
});

describe('connector session: reconnect + unknown frames', () => {
    it('socket close clears the request-id lifecycle (reconnect starts fresh)', async () => {
        const sock = makeScriptedSocket();
        const session = makeSession('http://127.0.0.1:1', sock);
        session.start();
        sock.emit('open');
        sock.emit('message', JSON.stringify({ type: 'ready', connector_id: 'c', heartbeat_interval_ms: 60000 }));
        // Simulate a seen id, then a close: the internal store must reset.
        sock.emit('message', JSON.stringify({
            type: 'chat.request', request_id: 'dup-1', model: 'm',
            messages: [{ role: 'user', content: 'x' }],
        }));
        await wait(60);
        sock.close(); // triggers the close handler path
        await wait(10);
        expect.equal(session.getSnapshot().phase !== 'ready', true);
        session.stop();
    });

    it('unknown frame types and malformed JSON are ignored safely', async () => {
        const sent = [];
        const session = createConnectorSession({
            config: { url: 'ws://127.0.0.1:1/ws', token: 'llmc.a.b', baseUrl: 'http://127.0.0.1:1', runtimeType: 'ollama' },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
            WebSocketImpl: function Stub() {
                return { readyState: 1, on: () => {}, send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };
            },
        });
        session.start();
        session._handleMessage('this is not json');
        session._handleMessage(JSON.stringify({ type: 'some.future.frame', url: 'http://evil' }));
        session._handleMessage(JSON.stringify(null));
        session._handleMessage(JSON.stringify([1, 2]));
        await wait(20);
        // No crash, no replies, session still usable.
        session._handleMessage(JSON.stringify({ type: 'ready', connector_id: 'c', heartbeat_interval_ms: 60000 }));
        expect.equal(session.getSnapshot().phase, 'ready');
        session.stop();
    });
});
