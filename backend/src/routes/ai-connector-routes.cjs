const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const aiConnectorRepo = require('../storage/postgres/repositories/ai-connector-repo');
const registry = require('../services/ai-connector/registry');
const discovery = require('../services/ai-connector/discovery');

// ======================================================
// LAC — Local AI Connector V1 (Phase 1+2+2.5+3)
// (docs/04-planning/local-ai-connector-v1.md §4, §7, §8, §8.1, §10, §12,
//  AD-1..AD-5, AD-7)
// ======================================================
//
// PART A — WS Foundation (Phase 2). Endpoint:
//   GET /api/v1/ai-connector/ws
//
// Protocol (version 1) — cloud ↔ connector, JSON frames:
//   C→S hello     { protocol_version, credential }            — persistent auth
//   C→S hello     { protocol_version, reg_token }             — first activation
//   S→C ready     { connector_id, heartbeat_interval_ms, server_time,
//                   credential, credential_prefix }           — credential only
//                                                             on activation
//   C→S heartbeat { models[], capabilities{tools,vision,context},
//                   runtime_ok, latency_ms, runtime{type,version} }
//
// Phase 3 — explicit runtime discovery (the only runtime operation that
// exists; the cloud itself NEVER talks to any runtime — SSRF posture):
//   S→C models.refresh {}                       — explicit, UI-triggered only
//   C→S models.list { models[] | error_code }   — normalized model-id strings
//                                                 (same safe shape as
//                                                 heartbeat models[]); error
//                                                 codes from a fixed sanitized
//                                                 allowlist (discovery service).
// There is deliberately NO url field on any frame: the connector fetches only
// its own locally-configured base URL — a client can never point the runtime
// call anywhere else (AD-5).
//
// Identity rules (worker-auth doctrine, verbatim):
//   - connector_id / workspace_id NEVER come from the client — they are
//     derived exclusively from the credential / registration token (llmc.* /
//     llmcreg.*) resolved against PG (hash-only, timing-safe).
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
    rotated: 4001,
    serverShutdown: 1001,
};

const REASONS = {
    authFailed: 'auth_failed',
    authTimeout: 'auth_timeout',
    protocolVersionUnsupported: 'protocol_version_unsupported',
    malformedFrame: 'malformed_frame',
    revoked: 'revoked',
    replaced: 'replaced',
    rotated: 'rotated',
    heartbeatTimeout: 'heartbeat_timeout',
    serverShutdown: 'server_shutdown',
};

function safeClose(ws, code, reason) {
    try { ws.close(code, reason); } catch (_) {}
}

/**
 * Redact a ws close reason so reasons never carry secrets or structure.
 * The `ws` library delivers close reasons as Buffers — convert before
 * sanitizing, otherwise every reason (including the server's own codes like
 * heartbeat_timeout/replaced) would degrade to 'unknown' and diagnostics die.
 * Control characters (newlines included) are replaced BEFORE the length cap —
 * a client-supplied close frame reason must never be able to forge additional
 * log lines (log injection).
 */
function logReason(reason) {
    if (reason == null) return 'unknown';
    const text = typeof reason === 'string'
        ? reason
        : Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason);
    if (!text) return 'unknown';
    return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 64);
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

/**
 * Validate the hello frame shape: protocol_version must be 1 and EXACTLY ONE
 * authentication mode must be present — the persistent `credential` (llmc.*)
 * or the one-time `reg_token` (llmcreg.*, atomic activation §8.1). Presenting
 * both (or neither) is a policy violation, never "try both" (fail-closed —
 * a frame must declare its intent, so a compromised-credential fallback to
 * registration replay is structurally impossible).
 */
function validateHello(msg) {
    if (msg.protocol_version !== PROTOCOL_VERSION) {
        return { ok: false, reason: REASONS.protocolVersionUnsupported };
    }
    const hasCredential = typeof msg.credential === 'string' && msg.credential.length > 0;
    const hasRegToken = typeof msg.reg_token === 'string' && msg.reg_token.length > 0;
    if (hasCredential && !hasRegToken) {
        return { ok: true, mode: 'credential', credential: msg.credential };
    }
    if (hasRegToken && !hasCredential) {
        return { ok: true, mode: 'registration', regToken: msg.reg_token };
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
                // runtime_ok (§7: last explicit discovery outcome — never a
                // probe result) joins version/latency in runtime_meta.
                runtimeMeta: heartbeat ? {
                    latency_ms: heartbeat.latency_ms,
                    runtime_ok: heartbeat.runtime_ok,
                    ...(heartbeat.runtime || {}),
                } : undefined,
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

        // Resolve identity EXCLUSIVELY from what hello carried (never from
        // any client-supplied id — worker-auth doctrine).
        //
        //   mode 'credential'   → authenticateConnector (hash-only, timing-
        //                         safe; revoked/unknown → null → close 1008).
        //   mode 'registration' → activateConnector: the ATOMIC EXACTLY-ONCE
        //                         exchange (§8.1/AD-3) — one PG transaction
        //                         with SELECT … FOR UPDATE mints the single
        //                         persistent llmc.* credential, disclosed
        //                         exactly once, in `ready`. A replayed/used/
        //                         expired token closes with the mapped reason.
        let authRow = null;
        let minted = null;
        try {
            if (v.mode === 'credential') {
                authRow = await aiConnectorRepo.authenticateConnector(v.credential);
            } else {
                const act = await aiConnectorRepo.activateConnector(v.regToken);
                if (act.ok) {
                    authRow = act.connector;
                    minted = { token: act.token, tokenPrefix: act.tokenPrefix };
                } else {
                    logger.warn(`[AI-CONNECTOR] registration exchange rejected: ${act.reason}`);
                }
            }
        } catch (err) {
            logger.warn(`[AI-CONNECTOR] credential resolution failed (denied): ${err.message}`);
        }
        if (!authRow) {
            safeClose(session.ws, CLOSE.policyViolation, REASONS.authFailed);
            return;
        }

        // The auth window may have expired (or the peer disconnected) while
        // the credential was being resolved — a socket that is no longer
        // open must NEVER enter the live-session map (a stale entry would
        // fake liveness: isLive=true / PG online with no real peer).
        if (session.ws.readyState !== 1) {
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

        const readyPayload = {
            type: 'ready',
            connector_id: authRow.connector_id,
            heartbeat_interval_ms: cfg.heartbeatIntervalMs,
            server_time: now,
        };
        if (minted) {
            // §8.1 step 5: plaintext llmc.* disclosed EXACTLY ONCE — in this
            // frame only. Never persisted, never logged (the log hygiene test
            // asserts this; the send below is the sole egress).
            readyPayload.credential = minted.token;
            readyPayload.credential_prefix = minted.tokenPrefix;
        }
        const ready = jsonStringify(readyPayload);
        if (ready && session.ws.readyState === 1) {
            session.ws.send(ready);
        }

        // Heartbeat timeout: any message resets it; silence past the window
        // closes the socket (and the close handler marks the connector offline).
        // 1008 = Policy Violation (liveness requirement) — same semantics as
        // the auth window; 1000 "normal" would misreport a dead peer.
        resetLivenessTimer(session);
    }

    /**
     * Phase 3: an authenticated models.list frame (reply to models.refresh).
     * Delegates to the discovery service (validate → normalize → persist via
     * the existing heartbeat/state-update path). The route wrapper exists only
     * to bind the session identity (pending refreshes are keyed per session)
     * and the logger.
     */
    function handleModelsList(session, msg) {
        return discovery.handleModelsList(session.connectorId, msg, { session, logger });
    }

    async function handleHeartbeat(session, msg) {
        const hb = sanitizeHeartbeat(msg);
        session.heartbeatAt = Date.now();
        await touchRedisHb(session.connectorId);
        await maybePersist(session, hb);
        resetLivenessTimer(session);
    }

    /**
     * Liveness: any well-formed message (heartbeat OR models.list) proves the
     * peer is alive — restart the silence timer. Silence past the window is a
     * policy violation close (1008).
     */
    function resetLivenessTimer(session) {
        if (session.heartbeatTimer) clearTimeout(session.heartbeatTimer);
        session.heartbeatTimer = setTimeout(() => {
            safeClose(session.ws, CLOSE.policyViolation, REASONS.heartbeatTimeout);
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
            if (session.state !== 'authenticating') {
                // Hello is the OPENING frame only. A re-hello after
                // authentication is a protocol violation — and must never
                // re-enter the registry as a self-replacement.
                safeClose(session.ws, CLOSE.policyViolation, REASONS.authFailed);
                return;
            }
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
        if (msg.type === 'models.list') {
            // Phase 3: the reply to models.refresh. Validation +
            // normalization + persistence live in the discovery service;
            // the frame NEVER carries or sets any URL (AD-5). Any well-formed
            // message proves liveness (in-memory timer + Redis mirror); a
            // failed discovery never breaks the session — the frame is
            // consumed, the connection stays up.
            resetLivenessTimer(session);
            touchRedisHb(session.connectorId).catch(() => {});
            handleModelsList(session, msg).catch(() => {});
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
                // Phase 3: a pending refresh on a dying session must fail
                // immediately (failPendingFor is a no-op when this session
                // did not own the pending refresh).
                discovery.failPendingFor(session);
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

// ======================================================
// PART B — HTTP registration & lifecycle routes (§8, §12)
// ======================================================
// The user-facing surface of the connector registry — a verbatim clone of the
// worker-routes discipline (userWorkspaceGuard, one-time disclosure, no
// existence oracle across workspaces):
//
//   POST   /api/v1/ai-connector/registrations   — create (pending) + one-time
//                                                 llmcreg.* token
//   GET    /api/v1/ai-connector/registrations/:connectorId/token
//              — (re)issue the one-time token for a still-pending connector
//                (re-arm; the previous token dies the moment this commits)
//   GET    /api/v1/ai-connector/connectors      — list (never secrets)
//   GET    /api/v1/ai-connector/connectors/:connectorId — detail
//   POST   /api/v1/ai-connector/connectors/:connectorId/rotate
//              — new persistent credential (old dies; one-time disclosure;
//                any live session authenticated with the old credential is
//                evicted — fail-closed)
//   DELETE /api/v1/ai-connector/connectors/:connectorId — revoke (soft;
//                live session evicted, PG offline, Redis hb key cleared)
//
// Identity rules:
//   - REGISTERED USERS ONLY (worker-routes precedent: a guest workspace must
//     never own long-lived credentials that outlive the guest purge).
//   - workspace_id ALWAYS from req.workspace (authContext) — never the body.
//   - The plaintext credential / registration token is returned ONLY by the
//     create / re-arm / rotate / activate responses — everything else carries
//     at most token_prefix.
//   - The exchange itself (llmcreg.* → llmc.*) lives in the WS hello
//     (activateConnector §8.1) — there is deliberately NO HTTP exchange
//     endpoint: the connector self-locates via the token and receives its
//     persistent credential over its own authenticated WS session.
// ======================================================

const MAX_CONNECTOR_NAME_LEN = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Users-only guard; returns the caller's workspace id or answers 401/403. */
function userWorkspaceGuard(req, res) {
    if (!req.user) {
        res.status(401).json({ error: 'Authentication required', code: 'auth_required' });
        return null;
    }
    if (req.guest) {
        // A request cannot be both user and guest — defensive only.
        res.status(403).json({ error: 'Guests cannot manage Local AI connectors', code: 'guest_forbidden' });
        return null;
    }
    if (!req.workspace || !req.workspace.id) {
        res.status(401).json({ error: 'Workspace not resolved', code: 'workspace_unresolved' });
        return null;
    }
    return req.workspace.id;
}

/** Public JSON shape of a connector row (never secrets; bigints → numbers). */
function publicConnector(row) {
    if (!row) return null;
    return {
        connector_id: row.connector_id,
        workspace_id: row.workspace_id,
        name: row.name,
        runtime_type: row.runtime_type,
        status: row.status,
        token_prefix: row.token_prefix || null,
        last_seen: row.last_seen != null ? Number(row.last_seen) : null,
        models: row.models || null,
        capabilities: row.capabilities || null,
        runtime_meta: row.runtime_meta || null,
        revoked_at: row.revoked_at != null ? Number(row.revoked_at) : null,
        created_at: row.created_at != null ? Number(row.created_at) : null,
    };
}

// Phase 3 read surfaces (§12: status/models routes reading registry + PG).
// Strictly derived from PG rows + the in-process live-session registry —
// neither route ever touches a runtime, and neither exposes credentials
// (not even the token_prefix mask).
function publicConnectorStatus(row) {
    return {
        connector_id: row.connector_id,
        name: row.name,
        runtime_type: row.runtime_type,
        status: row.status,
        live: registry.isLive(row.connector_id),
        last_seen: row.last_seen != null ? Number(row.last_seen) : null,
        models_count: Array.isArray(row.models) ? row.models.length : 0,
        capabilities: row.capabilities || null,
        runtime_meta: row.runtime_meta || null,
        created_at: row.created_at != null ? Number(row.created_at) : null,
    };
}

function publicConnectorModels(row) {
    return {
        connector_id: row.connector_id,
        name: row.name,
        runtime_type: row.runtime_type,
        status: row.status,
        live: registry.isLive(row.connector_id),
        last_seen: row.last_seen != null ? Number(row.last_seen) : null,
        models: Array.isArray(row.models) ? row.models : [],
    };
}

/**
 * Create the HTTP route handlers. `redis` is optional (injectable for tests):
 * it clears the heartbeat liveness mirror on revoke.
 */
function createAiConnectorRoutes({ redis, logger = console } = {}) {
    return function registerAiConnectorRoutes(app) {
        // ── POST create registration (pending connector + one-time token) ──
        app.post('/api/v1/ai-connector/registrations', async (req, res) => {
            const workspaceId = userWorkspaceGuard(req, res);
            if (!workspaceId) return;

            const body = req.body || {};
            const name = typeof body.name === 'string' ? body.name.trim() : '';
            if (!name || name.length > MAX_CONNECTOR_NAME_LEN) {
                return res.status(400).json({ error: `name is required (max ${MAX_CONNECTOR_NAME_LEN} chars)` });
            }
            const runtimeType = typeof body.runtime_type === 'string' && body.runtime_type
                ? body.runtime_type
                : 'openai-compatible';
            if (!aiConnectorRepo.RUNTIME_TYPES.includes(runtimeType)) {
                return res.status(400).json({
                    error: `runtime_type must be one of: ${aiConnectorRepo.RUNTIME_TYPES.join(', ')}`,
                });
            }
            // workspace_id from the body is deliberately IGNORED — the
            // connector is always created in the caller's own workspace.

            try {
                const { connector, regToken, regExpiresAt } = await aiConnectorRepo.createConnector({
                    workspaceId,
                    name,
                    runtimeType,
                    createdBy: req.user.userId,
                });
                res.status(201).json({
                    connector: publicConnector(connector),
                    reg_token: regToken,     // one-time disclosure — never again
                    reg_expires_at: regExpiresAt,
                    ws_url: '/api/v1/ai-connector/ws',
                });
            } catch (err) {
                logger.error(`[AI-CONNECTOR] registration create failed: ${err.message}`);
                res.status(500).json({ error: 'Failed to create Local AI connector' });
            }
        });

        // ── GET (re)issue the one-time registration token (pending only) ───
        app.get('/api/v1/ai-connector/registrations/:connectorId/token', async (req, res) => {
            const workspaceId = userWorkspaceGuard(req, res);
            if (!workspaceId) return;
            if (!UUID_RE.test(req.params.connectorId)) {
                return res.status(404).json({ error: 'Connector not found' });
            }
            try {
                const result = await aiConnectorRepo.issueRegistrationToken(req.params.connectorId, workspaceId);
                if (!result) {
                    // Unknown id, foreign workspace, revoked or ALREADY
                    // ACTIVATED — one indistinct 404 (no existence oracle;
                    // re-arming an activated connector would mint a second
                    // credential path and is refused by the repo).
                    return res.status(404).json({ error: 'Connector not found' });
                }
                res.json({
                    connector: publicConnector(result.connector),
                    reg_token: result.regToken, // one-time disclosure
                    reg_expires_at: result.regExpiresAt,
                    ws_url: '/api/v1/ai-connector/ws',
                });
            } catch (err) {
                logger.error(`[AI-CONNECTOR] registration token re-arm failed: ${err.message}`);
                res.status(500).json({ error: 'Failed to re-issue registration token' });
            }
        });

        // ── GET list connectors of the caller's workspace ──────────────────
        app.get('/api/v1/ai-connector/connectors', async (req, res) => {
            const workspaceId = userWorkspaceGuard(req, res);
            if (!workspaceId) return;
            try {
                const rows = await aiConnectorRepo.listWorkspaceConnectors(workspaceId);
                res.json({ connectors: rows.map(publicConnector) });
            } catch (err) {
                logger.error(`[AI-CONNECTOR] list failed: ${err.message}`);
                res.status(500).json({ error: 'Failed to list Local AI connectors' });
            }
        });

        // ── GET status (Phase 3 §15: registry liveness + PG state) ─────────
        app.get('/api/v1/ai-connector/status', async (req, res) => {
            const workspaceId = userWorkspaceGuard(req, res);
            if (!workspaceId) return;
            try {
                const rows = await aiConnectorRepo.listWorkspaceConnectors(workspaceId);
                res.json({
                    connectors: rows
                        .filter((r) => r.revoked_at == null)
                        .map(publicConnectorStatus),
                });
            } catch (err) {
                logger.error(`[AI-CONNECTOR] status failed: ${err.message}`);
                res.status(500).json({ error: 'Failed to load Local AI status' });
            }
        });

        // ── GET discovered models (Phase 3 §15/§12; read-only, PG only —
        //    this route NEVER triggers a runtime fetch; use explicit
        //    discovery for fresh data) ─────────────────────────────────────
        app.get('/api/v1/ai-connector/models', async (req, res) => {
            const workspaceId = userWorkspaceGuard(req, res);
            if (!workspaceId) return;
            try {
                const rows = await aiConnectorRepo.listWorkspaceConnectors(workspaceId);
                res.json({
                    connectors: rows
                        .filter((r) => r.revoked_at == null)
                        .map(publicConnectorModels),
                });
            } catch (err) {
                logger.error(`[AI-CONNECTOR] models read failed: ${err.message}`);
                res.status(500).json({ error: 'Failed to load Local AI models' });
            }
        });

        // ── GET one connector detail ───────────────────────────────────────
        app.get('/api/v1/ai-connector/connectors/:connectorId', async (req, res) => {
            const workspaceId = userWorkspaceGuard(req, res);
            if (!workspaceId) return;
            if (!UUID_RE.test(req.params.connectorId)) {
                return res.status(404).json({ error: 'Connector not found' });
            }
            try {
                const row = await aiConnectorRepo.getConnector(req.params.connectorId);
                if (!row || row.workspace_id !== workspaceId) {
                    // Foreign/unknown — one indistinct answer.
                    return res.status(404).json({ error: 'Connector not found' });
                }
                res.json({ connector: publicConnector(row) });
            } catch (err) {
                logger.error(`[AI-CONNECTOR] detail failed: ${err.message}`);
                res.status(500).json({ error: 'Failed to load Local AI connector' });
            }
        });

        // ── POST rotate persistent credential (old dies; session evicted) ──
        app.post('/api/v1/ai-connector/connectors/:connectorId/rotate', async (req, res) => {
            const workspaceId = userWorkspaceGuard(req, res);
            if (!workspaceId) return;
            if (!UUID_RE.test(req.params.connectorId)) {
                return res.status(404).json({ error: 'Connector not found' });
            }
            try {
                const result = await aiConnectorRepo.rotateConnectorCredential(req.params.connectorId, workspaceId);
                if (!result) {
                    // Unknown id, foreign workspace, revoked or never
                    // activated — one indistinct answer.
                    return res.status(404).json({ error: 'Connector not found' });
                }
                // Fail-closed: any live session authenticated with the OLD
                // credential dies NOW (its close handler marks the connector
                // offline; the connector reconnects with the new credential).
                const evicted = registry.evict(req.params.connectorId, CLOSE.rotated, REASONS.rotated);
                if (evicted) {
                    logger.info(`[AI-CONNECTOR] rotated credential → live session evicted for ${result.connector.connector_id}`);
                }
                res.json({
                    connector: publicConnector(result.connector),
                    token: result.token, // one-time disclosure — never again
                });
            } catch (err) {
                logger.error(`[AI-CONNECTOR] rotate failed: ${err.message}`);
                res.status(500).json({ error: 'Failed to rotate Local AI connector credential' });
            }
        });

        // ── DELETE revoke (soft delete; session evicted; liveness cleared) ─
        app.delete('/api/v1/ai-connector/connectors/:connectorId', async (req, res) => {
            const workspaceId = userWorkspaceGuard(req, res);
            if (!workspaceId) return;
            if (!UUID_RE.test(req.params.connectorId)) {
                return res.status(404).json({ error: 'Connector not found' });
            }
            try {
                const { revoked } = await aiConnectorRepo.revokeConnector(req.params.connectorId, workspaceId);
                if (!revoked) {
                    return res.status(404).json({ error: 'Connector not found' });
                }
                // Kill the live session (its close handler marks PG offline);
                // clear the Redis liveness mirror directly as well — a
                // revoked connector must not look alive for up to TTL.
                const evicted = registry.evict(req.params.connectorId, CLOSE.policyViolation, REASONS.revoked);
                if (redis) {
                    try { await redis.del(REDIS_HB_KEY(req.params.connectorId)); } catch (_) {}
                }
                if (evicted) {
                    logger.info(`[AI-CONNECTOR] revoked → live session evicted for ${req.params.connectorId}`);
                }
                res.json({ revoked: true });
            } catch (err) {
                logger.error(`[AI-CONNECTOR] revoke failed: ${err.message}`);
                res.status(500).json({ error: 'Failed to revoke Local AI connector' });
            }
        });
    };
}

module.exports = {
    createWsHandler,
    createAiConnectorRoutes,
    WS_PATH,
    PROTOCOL_VERSION,
    DEFAULTS,
    CLOSE,
    REASONS,
    publicConnectorStatus,
    publicConnectorModels,
};