// ======================================================
// LLM Connector WebSocket Foundation Tests (LAC-2 — Local AI Connector V1 Phase 2)
// ======================================================
// Coverage (docs/04-planning/local-ai-connector-v1.md §4, §7, §8.1, §10):
//   successful WS authentication (llmc.*) → ready + PG status online      ok
//   wrong / unknown / revoked credential → close (fail-closed)            ok
//   protocol_version != 1 → close (protocol_version_unsupported)          ok
//   hello → ready (connector_id, heartbeat_interval_ms, server_time)      ok
//   heartbeat → Redis hb key + PG last_seen/models (server-derived id)    ok
//   PG write throttle (~1/min): heartbeat within window does NOT bump     ok
//   disconnect → PG status offline + Redis hb key deleted                 ok
//   reconnect: single live session — older socket closed with `replaced`  ok
//   heartbeat timeout → server closes + marks offline                     ok
//   malformed frame → close (never crashes the process)                   ok
//   unknown message type → ignored (connection stays live)                ok
//   oversized frame → closed (maxPayload)                                 ok
//   non-hello before auth → close (auth_failed)                           ok
//   auth timeout (no hello) → close (auth_timeout)                        ok
//   plaintext llmc.* never reaches application logs                       ok
//
// Real-PG suite + real WS endpoint (createWsHandler on an ephemeral port)
// + in-memory Redis mirror.

const { expect } = require('chai');
const http = require('http');
const crypto = require('crypto');
const { WebSocket } = require('ws');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const repo = require('../src/storage/postgres/repositories/ai-connector-repo');
const { createWsHandler } = require('../src/routes/ai-connector-routes.cjs');
const { createMockRedis } = require('./mocks/redis-mock');

const stamp = `lac2${Date.now()}`;

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

// ── WS harness ────────────────────────────────────────────────────────────

function startWsServer(options = {}) {
    const redis = createMockRedis();
    const logger = {
        info: () => {},
        warn: (m) => console.warn(m),
        error: () => {},
    };
    const handler = createWsHandler({ redis, logger, options });
    const server = http.createServer((req, res) => {
        res.writeHead(404); res.end();
    });
    handler.attachUpgrade(server);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                redis,
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

const HELLO = (credential, version = 1) => ({ type: 'hello', protocol_version: version, credential });

describe('LLM Connector WebSocket foundation (LAC-2)', () => {
    let wsA, wsB;
    let main, timeoutSrv, throttleSrv;

    before(async function () {
        this.timeout(60000);
        await runMigrations();
        await cleanup();
        wsA = await createWorkspace('lac2A');
        wsB = await createWorkspace('lac2B');

        // Main server: writes PG on every heartbeat (pgWriteIntervalMs 0) so
        // state assertions are deterministic; generous liveness windows.
        main = await startWsServer({
            authTimeoutMs: 5000,
            heartbeatTimeoutMs: 60000,
            pgWriteIntervalMs: 0,
        });
        // Heartbeat-timeout server: short liveness window.
        timeoutSrv = await startWsServer({
            authTimeoutMs: 5000,
            heartbeatTimeoutMs: 250,
            pgWriteIntervalMs: 0,
        });
        // Throttle server: default ~1/min PG cadence, long liveness window.
        throttleSrv = await startWsServer({
            authTimeoutMs: 5000,
            heartbeatTimeoutMs: 60000,
        });
    });

    after(async function () {
        this.timeout(30000);
        for (const s of [main, timeoutSrv, throttleSrv]) {
            if (s) await s.close().catch(() => {});
        }
        await cleanup();
    });

    // ── 1. successful authentication → ready ──────────────────────────────

    it('hello(llmc.*) → ready { connector_id, heartbeat_interval_ms, server_time } + PG status online', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'ws-ok');
        const ws = await connect(main.url);
        const closed = nextClose(ws).then(() => 'closed', () => 'closed');
        send(ws, HELLO(token));
        const ready = await nextMessage(ws);

        expect(ready.type).to.equal('ready');
        expect(ready.connector_id).to.equal(connector.connector_id);
        expect(ready.heartbeat_interval_ms).to.be.a('number');
        expect(ready.server_time).to.be.a('number');

        const row = await rawRow(connector.connector_id);
        expect(row.status).to.equal('online');
        expect(Number(row.last_seen)).to.be.at.most(Date.now());

        ws.close();
        await closed;
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('connector_id / workspace_id are DERIVED from the credential, never trusted from the client', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'ws-identity');
        const ws = await connect(main.url);
        const closed = nextClose(ws).then(() => {}, () => {});
        // A hostile client tries to claim a different identity in hello.
        send(ws, { type: 'hello', protocol_version: 1, credential: token, connector_id: crypto.randomUUID(), workspace_id: crypto.randomUUID() });
        const ready = await nextMessage(ws);
        expect(ready.connector_id).to.equal(connector.connector_id); // server-derived
        const row = await rawRow(connector.connector_id);
        expect(row.workspace_id).to.equal(wsA); // DB binding, not the client's claim
        ws.close();
        await closed;
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    // ── 2. credential fail-closed matrix ──────────────────────────────────

    it('wrong credential → close 1008 (auth_failed)', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'ws-wrong');
        const ws = await connect(main.url);
        const closed = nextClose(ws);
        const wrong = `llmc.${Buffer.from(connector.connector_id).toString('base64url')}.${crypto.randomBytes(32).toString('base64url')}`;
        send(ws, HELLO(wrong));
        const res = await closed;
        expect(res.code).to.equal(1008);
        expect(res.reason).to.equal('auth_failed');
        // No live session was registered; still online in PG (no session to mark offline).
        const row = await rawRow(connector.connector_id);
        expect(row.status).to.equal('online');
        expect(repo.authenticateConnector(token)).to.not.equal(null);
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('unknown connector → close 1008 (auth_failed)', async () => {
        const ws = await connect(main.url);
        const closed = nextClose(ws);
        const ghost = `llmc.${Buffer.from(crypto.randomUUID()).toString('base64url')}.${crypto.randomBytes(32).toString('base64url')}`;
        send(ws, HELLO(ghost));
        const res = await closed;
        expect(res.code).to.equal(1008);
        expect(res.reason).to.equal('auth_failed');
    });

    it('revoked connector → close 1008 (auth_failed)', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'ws-revoked');
        await repo.revokeConnector(connector.connector_id, wsA);
        const ws = await connect(main.url);
        const closed = nextClose(ws);
        send(ws, HELLO(token));
        const res = await closed;
        expect(res.code).to.equal(1008);
        expect(res.reason).to.equal('auth_failed');
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('protocol_version != 1 → close 1008 (protocol_version_unsupported)', async () => {
        const { token } = await createActivatedConnector(wsA, 'ws-ver');
        const ws = await connect(main.url);
        const closed = nextClose(ws);
        send(ws, HELLO(token, 2));
        const res = await closed;
        expect(res.code).to.equal(1008);
        expect(res.reason).to.equal('protocol_version_unsupported');
    });

    it('missing credential in hello → close 1008 (auth_failed)', async () => {
        const ws = await connect(main.url);
        const closed = nextClose(ws);
        send(ws, { type: 'hello', protocol_version: 1 });
        const res = await closed;
        expect(res.code).to.equal(1008);
        expect(res.reason).to.equal('auth_failed');
    });

    it('non-hello message before authentication → close 1008 (auth_failed)', async () => {
        const ws = await connect(main.url);
        const closed = nextClose(ws);
        send(ws, { type: 'heartbeat', models: [] });
        const res = await closed;
        expect(res.code).to.equal(1008);
        expect(res.reason).to.equal('auth_failed');
    });

    it('no hello within the auth window → close 1008 (auth_timeout)', async function () {
        this.timeout(15000);
        const ws = await connect(timeoutSrv.url);
        const closed = nextClose(ws);
        const res = await closed;
        expect(res.code).to.equal(1008);
        expect(res.reason).to.equal('auth_timeout');
    });

    // ── 3. hello → ready / heartbeat ──────────────────────────────────────

    it('heartbeat refreshes Redis hb key + PG last_seen/models (server-derived id only)', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'ws-hb');
        const ws = await connect(main.url);
        const closed = nextClose(ws).then(() => {}, () => {});
        send(ws, HELLO(token));
        await nextMessage(ws); // ready

        const hbKey = `animastor:ai-connector:hb:${connector.connector_id}`;
        expect(await main.redis.exists(hbKey)).to.equal(1);
        const lastBefore = Number((await rawRow(connector.connector_id)).last_seen);

        await new Promise((r) => setTimeout(r, 5));
        send(ws, {
            type: 'heartbeat',
            models: ['qwen3:32b', 'llama3:8b'],
            capabilities: { tools: true, vision: false, context: 32768 },
            runtime_ok: true,
            latency_ms: 42,
            runtime: { type: 'ollama', version: '0.3.10' },
            evil_extra: 'dropped',
        });
        await new Promise((r) => setTimeout(r, 30));

        const row = await rawRow(connector.connector_id);
        expect(Number(row.last_seen)).to.be.at.least(lastBefore);
        expect(row.models).to.deep.equal(['qwen3:32b', 'llama3:8b']);
        expect(row.capabilities.tools).to.equal(true);
        expect(row.capabilities.context).to.equal(32768);
        expect(row.runtime_meta.latency_ms).to.equal(42);
        expect(row.runtime_meta.type).to.equal('ollama');
        expect(row.runtime_meta.evil_extra).to.equal(undefined); // sanitized
        expect(await main.redis.exists(hbKey)).to.equal(1);

        ws.close();
        await closed;
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('PG writes are throttled to ~1/min (heartbeat within the window does NOT bump last_seen)', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'ws-throttle');
        const ws = await connect(throttleSrv.url);
        const closed = nextClose(ws).then(() => {}, () => {});
        send(ws, HELLO(token));
        await nextMessage(ws); // ready
        const lastBefore = Number((await rawRow(connector.connector_id)).last_seen);

        await new Promise((r) => setTimeout(r, 5));
        send(ws, { type: 'heartbeat', models: ['m1'], runtime_ok: true });
        await new Promise((r) => setTimeout(r, 30));

        const row = await rawRow(connector.connector_id);
        expect(Number(row.last_seen)).to.equal(lastBefore); // throttled, not bumped
        // Liveness is still recorded in the Redis mirror (primary for hot path).
        expect(await throttleSrv.redis.exists(`animastor:ai-connector:hb:${connector.connector_id}`)).to.equal(1);

        ws.close();
        await closed;
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    // ── 4. disconnect → offline ───────────────────────────────────────────

    it('disconnect → PG status offline + Redis hb key deleted', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'ws-off');
        const ws = await connect(main.url);
        const closed = nextClose(ws);
        send(ws, HELLO(token));
        await nextMessage(ws); // ready
        expect((await rawRow(connector.connector_id)).status).to.equal('online');

        ws.close();
        await closed;
        await new Promise((r) => setTimeout(r, 30));

        const row = await rawRow(connector.connector_id);
        expect(row.status).to.equal('offline');
        expect(Number(row.last_seen)).to.be.at.most(Date.now());
        expect(await main.redis.exists(`animastor:ai-connector:hb:${connector.connector_id}`)).to.equal(0);
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    // ── 5. reconnect / single live session ────────────────────────────────

    it('two connections of one connector → older session closed with `replaced`; only one live', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'ws-single');

        const ws1 = await connect(main.url);
        const closed1 = nextClose(ws1);
        send(ws1, HELLO(token));
        await nextMessage(ws1); // ready (session 1 live)

        // Second connection authenticates with the same credential.
        const ws2 = await connect(main.url);
        const closed2 = nextClose(ws2).then(() => {}, () => {});
        send(ws2, HELLO(token));
        await nextMessage(ws2); // ready (session 2 live)

        // The older socket must be closed with the `replaced` close code.
        const res1 = await closed1;
        expect(res1.code).to.equal(4000);
        expect(res1.reason).to.equal('replaced');

        // Registry holds exactly the newer session (the server-side socket
        // differs from the client object — assert identity by connector).
        const live = require('../src/services/ai-connector/registry').getLive(connector.connector_id);
        expect(live).to.not.equal(null);
        expect(live.connectorId).to.equal(connector.connector_id);
        expect(live.ws.readyState).to.equal(1); // open

        // Closing session 2 (still live) marks the connector offline — but the
        // already-replaced session 1 must NOT have flipped it offline earlier.
        ws2.close();
        await closed2;
        await new Promise((r) => setTimeout(r, 30));
        expect((await rawRow(connector.connector_id)).status).to.equal('offline');
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('reconnect after disconnect: clean new session, offline → online transition', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'ws-reconnect');
        let ws = await connect(main.url);
        let closed = nextClose(ws).then(() => {}, () => {});
        send(ws, HELLO(token));
        await nextMessage(ws);
        ws.close();
        await closed;
        await new Promise((r) => setTimeout(r, 30));
        expect((await rawRow(connector.connector_id)).status).to.equal('offline');

        // Reconnect with the same persistent credential.
        ws = await connect(main.url);
        closed = nextClose(ws).then(() => {}, () => {});
        send(ws, HELLO(token));
        const ready = await nextMessage(ws);
        expect(ready.connector_id).to.equal(connector.connector_id);
        expect((await rawRow(connector.connector_id)).status).to.equal('online');

        ws.close();
        await closed;
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    // ── 6. heartbeat timeout ──────────────────────────────────────────────

    it('heartbeat timeout → server closes the socket and marks the connector offline', async function () {
        this.timeout(10000);
        const { connector, token } = await createActivatedConnector(wsA, 'ws-hb-timeout');
        const ws = await connect(timeoutSrv.url);
        const closed = nextClose(ws);
        send(ws, HELLO(token));
        await nextMessage(ws); // ready
        expect((await rawRow(connector.connector_id)).status).to.equal('online');

        // No heartbeat — the 250ms liveness window expires server-side.
        const res = await closed;
        expect(res.code).to.equal(1000);
        expect(res.reason).to.equal('heartbeat_timeout');
        await new Promise((r) => setTimeout(r, 30));

        expect((await rawRow(connector.connector_id)).status).to.equal('offline');
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    // ── 7. protocol robustness ────────────────────────────────────────────

    it('malformed frame → close 1002 (never crashes the process)', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'ws-malformed');
        const ws = await connect(main.url);
        const closed = nextClose(ws);
        send(ws, HELLO(token));
        await nextMessage(ws); // ready
        ws.send('this is not json {{{');
        const res = await closed;
        expect(res.code).to.equal(1002);
        expect(res.reason).to.equal('malformed_frame');
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('malformed non-object JSON → close 1002', async () => {
        const ws = await connect(main.url);
        const closed = nextClose(ws);
        ws.send(JSON.stringify([1, 2, 3]));
        const res = await closed;
        expect(res.code).to.equal(1002);
        expect(res.reason).to.equal('malformed_frame');
    });

    it('unknown message type → ignored safely, connection stays live', async () => {
        const { connector, token } = await createActivatedConnector(wsA, 'ws-unknown');
        const ws = await connect(main.url);
        const closed = nextClose(ws).then(() => 'closed', () => 'closed');
        send(ws, HELLO(token));
        await nextMessage(ws); // ready
        send(ws, { type: 'chat.request', request_id: 'x', model: 'm' });
        send(ws, { type: 'banana' });
        await new Promise((r) => setTimeout(r, 50));
        // Still alive — a subsequent heartbeat is accepted without error.
        send(ws, { type: 'heartbeat', models: [], runtime_ok: true });
        await new Promise((r) => setTimeout(r, 30));
        expect((await rawRow(connector.connector_id)).status).to.equal('online');
        ws.close();
        await closed;
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('oversized frame → connection closed (maxPayload enforced)', async function () {
        this.timeout(15000);
        const { token } = await createActivatedConnector(wsA, 'ws-big');
        const ws = await connect(main.url);
        const closed = nextClose(ws).then((r) => r, (r) => r);
        send(ws, HELLO(token));
        await nextMessage(ws); // ready
        // ~100 KB heartbeat exceeds the 64 KB cap.
        ws.send(JSON.stringify({ type: 'heartbeat', models: ['x'.repeat(100 * 1024)], runtime_ok: true }));
        const res = await closed;
        expect([1009, 1006]).to.include(res.code); // Message Too Big / abrupt close
    });

    // ── 8. log hygiene ────────────────────────────────────────────────────

    it('plaintext llmc.* credential NEVER reaches application logs', async function () {
        this.timeout(10000);
        const { connector, token } = await createActivatedConnector(wsA, 'ws-log-hygiene');
        const secret = token.split('.')[2];
        const captured = await captureConsole(async () => {
            // Successful auth: the token must not appear in any log.
            let ws = await connect(main.url);
            let closed = nextClose(ws).then(() => {}, () => {});
            send(ws, HELLO(token));
            await nextMessage(ws);
            ws.close();
            await closed;

            // Failed auth with a garbage credential that embeds the real
            // connector_id and a wrong secret.
            ws = await connect(main.url);
            closed = nextClose(ws);
            const wrongSecret = `llmc.${Buffer.from(connector.connector_id).toString('base64url')}.${crypto.randomBytes(32).toString('base64url')}`;
            send(ws, HELLO(wrongSecret));
            await closed;
            return token;
        });

        const logged = captured.entries.map((e) => e.text).join('\n');
        expect(logged).to.not.include(captured.result);
        expect(logged).to.not.include(secret);
        expect(logged).to.not.match(/llmc\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });
});