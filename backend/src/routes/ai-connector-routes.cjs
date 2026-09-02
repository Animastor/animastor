const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const aiConnectorRepo = require('../storage/postgres/repositories/ai-connector-repo');
const registry = require('../services/ai-connector/registry');

// ======================================================
// LAC — Local AI Connector V1 Phase 2: WebSocket Foundation
// (docs/04-planning/local-ai-connector-v1.md §4, §7, §8.1, §10, AD-1..AD-3)
// ======================================================
// The backend monolith is the SOLE WS terminator (AD-8). Endpoint:
//   GET /api/v1/ai-connector/ws
//
// Protocol (version 1) — cloud ↔ connector, JSON frames:
//   C→S hello     { protocol_version, credential }
//   S→C ready     { connector_id, heartbeat_interval_ms, server_time }
//   C→S heartbeat { models[], capabilities{tools,vision,context},
//                   runtime_ok, latency_ms, runtime{type,version} }
//
// Phase 2 authenticates with the persistent llmc.* credential only (the
// one-time llmcreg.* activation exchange lands with the registration phase).
//
// Identity rules (worker-auth doctrine, verbatim):
//   - connector_id / workspace_id NEVER come from the client — they are
//     derived exclusively from the credential (llmc.*) resolved against PG
//     (hash-only, timing-safe).
//   - A revoked connector never authenticates.
//   - Single live session per connector (AD-3/§8.1.5): a newer
//     authentication REPLACES the older session (older socket gets a
//     `replaced` close code 4000).
//
// Server-side state (PG `ai_connectors` is the durable truth; Redis is a
// liveness mirror only, never identity — §7):
//   - status online while a live session is registered; last_seen refreshed
//     by heartbeat (throttled to ~1/min writes).
//   - Redis TTL key `animastor:ai-connector:hb:<id>` (TTL 45s) refreshed on
//     every heartbeat; deleted on disconnect.
//   - disconnect → status offline (+ last_seen), Redis key deleted.
//
// Security (§10): never log plaintext llmc.*/llmcreg.*; never echo message
// bodies to logs (hello carries a credential); malformed frames close the
// socket (never crash the process); unknown message types are ignored; the
// endpoint accepts ONLY hello / heartbeat — it is not a universal proxy.
// ======================================================

const PROTOCOL_VERSION = 1;
const WS_PATH = '/api/v1/ai-connector/ws';

// Frame / liveness tuning. Injectable for tests via createWsHandler options.
const DEFAULTS = {
    maxPayloadBytes: 64 * 1024,          // 64 KB incoming frame cap
    authTimeoutMs: 10 * 1000,            // hello must arrive + auth within this window
    heartbeatIntervalMs: 15 * 1000,      // advertised to the connector in ready
    heartbeatTimeoutMs: 45 * 1000,       // no message for this long → close + offline
    pgWriteIntervalMs: 60 * 1000,        // throttle PG last_seen/status writes
    redisHtKeyTtlSec: 45,                // Redis liveness mirror TTL
};

const REDIS_HB_KEY = (id) => `animastor:ai-connector:hb:${id}`;

// App-reserved close codes (4000-4999) + standard policy codes.
const CLOSE = {
    normal: 1000,
    protocolError: 1002,
    policyViolation: 1008,
    replaced: registry.CLOSE_REPLACED, // 4000
    serverShutdown: 1001,
};

const REASONS = {
    authFailed: 'auth_failed',
    authTimeout: 'auth_timeout',
    protocolVersionUnsupported: 'protocol_version_unsupported',
    malformedFrame: 'malformed_frame',
    revoked: 'revoked',
    replaced: 'replaced',
    heartbeatTimeout: 'heartbeat_timeout',
    serverShutdown: 'server_shutdown',
};

function safeClose(ws, code, reason) {
    try { ws.close(code, reason); } catch (_) {}
}

/** Redact a ws close reason so reasons never carry secrets. */
function logReason(reason) {
    if (!reason || typeof reason !== 'string') return 'unknown';
    return reason.slice(0, 64);
}

function jsonStringify(obj) {
    try { return JSON.stringify(obj); } catch (_) { return null; }
}

/**
 * Strict (fail-closed) parse of an incoming frame. Never throws.
 * @returns {{ok:true, msg:object}|{ok:false, reason:string, note:string}}
 */
function parseFrame(raw) {
    if (typeof raw !== 'string') return { ok: false, reason: REASONS.malformedFrame, note: 'non-text' };
    let msg;
    try {
        msg = JSON.parse(raw);
    } catch (_) {
        return { ok: false, reason: REASONS.malformedFrame, note: 'json' };
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        return { ok: false, reason: REASONS.malformedFrame, note: 'shape' };
    }
    if (typeof msg.type !== 'string' || msg.type.length === 0 || msg.type.length > 64) {
        return { ok: false, reason: REASONS.malformedFrame, note: 'type' };
    }
    return { ok: true, msg };
}

function validateHello(msg) {
    if (msg.protocol_version !== PROTOCOL_VERSION) {
        return { ok: false, reason: REASONS.protocolVersionUnsupported };
    }
    // Phase 2 authenticates with the persistent llmc.* credential only. The
    // one-time llmcreg.* registration exchange (atomic activation, AD-3) is
    // wired in the registration phase (§4 hello `reg_token`) — presenting a
    // reg_token here is an authentication failure.
    if (typeof msg.credential === 'string' && msg.credential.length > 0) {
        return { ok: true, credential: msg.credential };
    }
    return { ok: false, reason: REASONS.authFailed };
}

/**
 * Sanitize a heartbeat payload to the exact documented shape. Unknown fields
 * are dropped (never stored); wrong types are dropped field-by-field — a
 * malformed heartbeat never fails the connection (liveness outlives bad
 * metadata), but never poisons PG.
 */
function sanitizeHeartbeat(msg) {
    const out = {};
    if (Array.isArray(msg.models)) {
        const models = [];
        for (const m of msg.models) {
            if (typeof m === 'string' && m.length > 0 && m.length <= 512 && models.length < 256) {
                models.push(m);
            }
        }
        out.models = models;
    }
    const caps = {};
    if (msg.capabilities && typeof msg.capabilities === 'object' && !Array.isArray(msg.capabilities)) {
        if (typeof msg.capabilities.tools === 'boolean') caps.tools = msg.capabilities.tools;
        if (typeof msg.capabilities.vision === 'boolean') caps.vision = msg.capabilities.vision;
        if (typeof msg.capabilities.context === 'number') caps.context = msg.capabilities.context;
        if (Object.keys(caps).length > 0) out.capabilities = caps;
    }
    if (typeof msg.runtime_ok === 'boolean') out.runtime_ok = msg.runtime_ok;
    if (typeof msg.latency_ms === 'number' && msg.latency_ms >= 0) out.latency_ms = msg.latency_ms;
    if (msg.runtime && typeof msg.runtime === 'object' && !Array.isArray(msg.runtime)) {
        const rt = {};
        if (typeof msg.runtime.type === 'string' && msg.runtime.type.length <= 64) rt.type = msg.runtime.type;
        if (typeof msg.runtime.version === 'string' && msg.runtime.version.length <= 128) rt.version = msg.runtime.version;
        if (Object.keys(rt).length > 0) out.runtime = rt;
    }
    return out;
}

function createWsHandler({ redis, logger = console, options = {} } = {}) {
    const cfg = { ...DEFAULTS, ...options };

    const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxPayloadBytes });

    function heartbeatKey(connectorId) {
        return REDIS_HB_KEY(connectorId);
    }

    async function touchRedisHb(connectorId) {
        if (!redis) return;
        try {
            await redis.set(heartbeatKey(connectorId), JSON.stringify({ ts: Date.now() }), 'EX', cfg.redisHtKeyTtlSec);
        } catch (err) {
            logger.warn(`[AI-CONNECTOR] redis hb touch failed (non-fatal): ${err.message}`);
        }
    }

    async function clearRedisHb(connectorId) {
        if (!redis) return;
        try {
            await redis.del(heartbeatKey(connectorId));
        } catch (err) {
            logger.warn(`[AI-CONNECTOR] redis hb clear failed (non-fatal): ${err.message}`);
        }
    }

    async function markOffline(session) {
        if (!session || session.closed) return;
        session.closed = true;
        try {
            await aiConnectorRepo.updateConnectorHeartbeat(session.connectorId, { status: 'offline' });
        } catch (err) {
            logger.warn(`[AI-CONNECTOR] offline mark failed (non-fatal): ${err.message}`);
        }
        await clearRedisHb(session.connectorId);
    }

    /**
     * Persist PG state after auth / on heartbeat. Throttled: at most one write
     * per cfg.pgWriteIntervalMs, except the mandatory first write right after
     * authentication (status online must land immediately).
     */
    async function maybePersist(session, heartbeat) {
        const now = Date.now();
        const shouldWrite = !session.lastPgWriteAt
            || now - session.lastPgWriteAt >= cfg.pgWriteIntervalMs;
        if (!shouldWrite) return;
        session.lastPgWriteAt = now;
        try {
            await aiConnectorRepo.updateConnectorHeartbeat(session.connectorId, {
                status: 'online',
                models: heartbeat ? heartbeat.models : undefined,
                capabilities: heartbeat ? heartbeat.capabilities : undefined,
                runtimeMeta: heartbeat ? { latency_ms: heartbeat.latency_ms, ...(heartbeat.runtime || {}) } : undefined,
            });
        } catch (err) {
            logger.warn(`[AI-CONNECTOR] PG heartbeat update failed (non-fatal): ${err.message}`);
        }
    }

    async function handleHello(session, msg) {
        const v = validateHello(msg);
        if (!v.ok) {
            safeClose(session.ws, CLOSE.policyViolation, v.reason);
            return;
        }

        let authRow = null;
        try {
            authRow = await aiConnectorRepo.authenticateConnector(v.credential);
        } catch (err) {
            logger.warn(`[AI-CONNECTOR] credential resolution failed (denied): ${err.message}`);
        }
        if (!authRow) {
            safeClose(session.ws, CLOSE.policyViolation, REASONS.authFailed);
            return;
        }

        session.connectorId = authRow.connector_id;
        session.workspaceId = authRow.workspace_id;

        // Single live session per connector (AD-3 §8.1.5): the older session,
        // if any, is closed with a `replaced` close code by the registry.
        const reg = registry.register(authRow.connector_id, session);
        if (reg.status === 'replaced') {
            logger.info(`[AI-CONNECTOR] session replaced for connector ${authRow.connector_id}`);
        }

        session.state = 'authenticated';
        clearTimeout(session.authTimer);
        session.authTimer = null;

        const now = Date.now();
        await maybePersist(session, null);
        await touchRedisHb(authRow.connector_id);

        const ready = jsonStringify({
            type: 'ready',
            connector_id: authRow.connector_id,
            heartbeat_interval_ms: cfg.heartbeatIntervalMs,
            server_time: now,
        });
        if (ready && session.ws.readyState === 1) {
            session.ws.send(ready);
        }

        // Heartbeat timeout: any message resets it; silence past the window
        // closes the socket (and the close handler marks the connector offline).
        session.heartbeatTimer = setTimeout(() => {
            safeClose(session.ws, CLOSE.normal, REASONS.heartbeatTimeout);
        }, cfg.heartbeatTimeoutMs);
        if (session.heartbeatTimer && session.heartbeatTimer.unref) session.heartbeatTimer.unref();
    }

    async function handleHeartbeat(session, msg) {
        const hb = sanitizeHeartbeat(msg);
        session.heartbeatAt = Date.now();
        await touchRedisHb(session.connectorId);
        await maybePersist(session, hb);
        // Reset the liveness timer — any well-formed message proves liveness.
        if (session.heartbeatTimer) clearTimeout(session.heartbeatTimer);
        session.heartbeatTimer = setTimeout(() => {
            safeClose(session.ws, CLOSE.normal, REASONS.heartbeatTimeout);
        }, cfg.heartbeatTimeoutMs);
        if (session.heartbeatTimer && session.heartbeatTimer.unref) session.heartbeatTimer.unref();
    }

    function handleMessage(session, raw) {
        if (session.state === 'closed') return;
        const parsed = parseFrame(raw);
        if (!parsed.ok) {
            // Malformed frame → protocol violation. Close (never crash); do
            // NOT log the raw body (hello may carry a credential).
            logger.warn(`[AI-CONNECTOR] malformed frame (${parsed.note}) → closing`);
            safeClose(session.ws, CLOSE.protocolError, REASONS.malformedFrame);
            return;
        }
        const { msg } = parsed;
        if (msg.type === 'hello') {
            handleHello(session, msg).catch(() => {
                safeClose(session.ws, CLOSE.protocolError, REASONS.authFailed);
            });
            return;
        }
        if (session.state !== 'authenticated') {
            // Any non-hello message before authentication is a protocol
            // violation — fail closed.
            safeClose(session.ws, CLOSE.policyViolation, REASONS.authFailed);
            return;
        }
        if (msg.type === 'heartbeat') {
            handleHeartbeat(session, msg).catch(() => {});
            return;
        }
        // Unknown message type: ignore safely. The endpoint is not a proxy —
        // anything outside the documented surface simply does not exist.
        // The type value is client-controlled and never logged (a credential
        // must never be echoed into logs).
        logger.info('[AI-CONNECTOR] ignored unknown message type');
    }

    function handleConnection(ws) {
        const session = {
            ws,
            state: 'authenticating',
            connectorId: null,
            workspaceId: null,
            connectedAt: Date.now(),
            heartbeatAt: null,
            lastPgWriteAt: null,
            heartbeatTimer: null,
            authTimer: null,
            closed: false,
        };

        // hello must arrive and authenticate within the auth window.
        session.authTimer = setTimeout(() => {
            if (session.state === 'authenticating') {
                safeClose(ws, CLOSE.policyViolation, REASONS.authTimeout);
            }
        }, cfg.authTimeoutMs);
        if (session.authTimer && session.authTimer.unref) session.authTimer.unref();

        ws.on('message', (data, isBinary) => {
            const raw = isBinary ? null : data.toString();
            handleMessage(session, raw);
        });

        ws.on('close', (code, reason) => {
            if (session.state === 'closed') return;
            session.state = 'closed';
            if (session.authTimer) clearTimeout(session.authTimer);
            if (session.heartbeatTimer) clearTimeout(session.heartbeatTimer);
            if (session.connectorId) {
                const wasActive = registry.unregister(session.connectorId, session);
                // Mark offline only if this session was STILL the registered live
                // session (a replacement session must not be clobbered offline).
                if (wasActive) {
                    markOffline(session).catch(() => {});
                }
            }
            logger.info(`[AI-CONNECTOR] session closed (${logReason(reason)}, code ${code})`);
        });

        ws.on('error', (err) => {
            logger.warn(`[AI-CONNECTOR] socket error: ${err.message}`);
        });
    }

    function attachUpgrade(server) {
        server.on('upgrade', (req, socket, head) => {
            let pathname = '';
            try {
                pathname = (req.url || '').split('?')[0];
            } catch (_) {}
            if (pathname !== WS_PATH) {
                socket.destroy();
                return;
            }
            wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit('connection', ws, req);
            });
        });
        wss.on('connection', handleConnection);
    }

    function shutdown() {
        registry.disconnectAll();
        try { wss.close(); } catch (_) {}
    }

    return { attachUpgrade, shutdown, wss, WS_PATH, PROTOCOL_VERSION, cfg };
}

module.exports = { createWsHandler, WS_PATH, PROTOCOL_VERSION, DEFAULTS, CLOSE, REASONS };