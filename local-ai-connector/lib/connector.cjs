// ======================================================
// Connector WS session (LAC-3 — hello/ready, heartbeat, models discovery)
// ======================================================
// Outbound session against the Animastor connector endpoint:
//
//   C→S hello       { protocol_version:1, credential | reg_token }
//   S→C ready       { connector_id, heartbeat_interval_ms, server_time
//                     [, credential, credential_prefix] }  — activation only
//   C→S heartbeat   { models[], runtime_ok, runtime{type} }  — cadence from ready
//   S→C models.refresh {}                    → connector fetches locally:
//                                              GET {base}/v1/models (adapter)
//   C→S models.list { models[] | error_code }
//
// Invariants:
//   - NO automatic probes (AD-7): discovery runs ONLY on explicit
//     models.refresh, plus a TTL-cached re-check for heartbeat facts
//     (default 30 s, §7). No discovery at startup, no inference, no
//     chat/completions — the adapter surface has no such operation.
//   - The runtime base URL is LOCAL CONFIG ONLY. Frames from the cloud are
//     read for `type` (+ heartbeat facts on ready) and NOTHING else — there
//     is no field a cloud could use to point the runtime call elsewhere.
//   - One in-flight discovery at a time; extra refreshes coalesce (no
//     fan-out against the local runtime even under a hostile server).
//   - Reconnects with exponential backoff + jitter; the credential is NEVER
//     logged (logger callers only ever pass metadata).
// ======================================================

const adapters = require('./runtime-adapters/index.cjs');
const opLog = require('./log.cjs');

const DEFAULTS = {
    heartbeatIntervalMs: 15 * 1000,   // fallback if ready omits the cadence
    heartbeatCacheTtlMs: 30 * 1000,   // §7: runtime facts locally cached ~30 s
    reconnectBaseMs: 1000,
    reconnectMaxMs: 30 * 1000,
    discoveryTimeoutMs: 8 * 1000,
};

function defaultWebSocketImpl() {
    try {
        // Lazy: only the CLI path needs the dependency; tests may inject.
        return require('ws').WebSocket;
    } catch (_) {
        throw new Error('ws dependency not installed (run npm install in local-ai-connector)');
    }
}

function clampInterval(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return DEFAULTS.heartbeatIntervalMs;
    return Math.min(Math.max(Math.round(n), 250), 600000);
}

/**
 * @param {object} opts
 * @param {object} opts.config  - parsed config (config.cjs)
 * @param {object} [opts.logger] - { info, warn, error }
 * @param {Function} [opts.WebSocketImpl] - injectable ws implementation
 * @param {object} [opts.hooks] - { onReady, onModelsList } (metadata only)
 */
function createConnectorSession({
    config,
    logger = console,
    WebSocketImpl = null,
    hooks = {},
    heartbeatCacheTtlMs = null,
} = {}) {
    const WS = WebSocketImpl || defaultWebSocketImpl();
    const discover = adapters.getAdapter(config.runtimeType);
    if (!discover) {
        throw new Error(`no runtime adapter for type ${config.runtimeType}`);
    }
    const cacheTtl = Math.max(0, Number(heartbeatCacheTtlMs) || DEFAULTS.heartbeatCacheTtlMs);

    const state = {
        phase: 'idle', // idle | connecting | ready | stopped
        ws: null,
        connectorId: null,
        attempts: 0,
        heartbeatTimer: null,
        reconnectTimer: null,
        // Discovery facts cache (§7): models + last runtime reachability.
        cache: { models: [], runtimeOk: null, lastDiscoveryAt: 0 },
        discoveryInFlight: false,
        stopped: false,
    };

    function send(obj) {
        if (state.ws && state.ws.readyState === 1) {
            state.ws.send(JSON.stringify(obj));
        }
    }

    function clearTimers() {
        if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
        if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    }

    /**
     * Run one discovery through the runtime adapter. STRICT coalescing:
     * while one discovery is in flight, further refresh requests are
     * ABSORBED (the in-flight result answers everyone) — the local runtime
     * sees at most ONE /v1/models request per burst, ever, even under a
     * server spraying models.refresh frames (no fan-out).
     *
     * @param {string} trigger 'refresh' (explicit models.refresh — replies
     *   with a models.list frame) or 'heartbeat' (stale §7 cache — updates
     *   the local facts only, NEVER sends models.list).
     */
    function runDiscovery(trigger) {
        if (state.phase !== 'ready') return;
        if (state.discoveryInFlight) {
            logger.info('[AI-CONNECTOR] discovery already in flight — refresh absorbed (coalesced)');
            return;
        }
        state.discoveryInFlight = true;
        const startedAt = Date.now();
        adapters.discoverModels({
            baseUrl: config.baseUrl,
            timeoutMs: DEFAULTS.discoveryTimeoutMs,
        }).then((result) => {
            state.discoveryInFlight = false;
            const durationMs = Date.now() - startedAt;
            state.cache.lastDiscoveryAt = Date.now();
            state.cache.runtimeOk = result.ok === true;
            if (result.ok) state.cache.models = result.models.slice();
            opLog.recordOp({
                op: 'model_discovery',
                status: result.ok ? 'ok' : 'error',
                error_code: result.ok ? undefined : result.code,
                duration_ms: durationMs,
                bytes: result.ok ? result.rawBytes : undefined,
            });
            if (result.ok) {
                logger.info(`[AI-CONNECTOR] discovery ok (${result.models.length} models, ${durationMs}ms)`);
            } else {
                // Sanitized code only — never runtime bodies/URLs.
                logger.warn(`[AI-CONNECTOR] discovery failed: ${result.code}`);
            }
            // Protocol fidelity: models.list is EXCLUSIVELY the reply to an
            // explicit models.refresh. Heartbeat-driven cache refreshes are
            // reported through the next heartbeat's models[] instead (§7).
            if (trigger === 'refresh') {
                if (result.ok) {
                    send({ type: 'models.list', models: state.cache.models });
                    if (hooks.onModelsList) hooks.onModelsList({ ok: true, models: state.cache.models });
                } else {
                    send({ type: 'models.list', models: [], error_code: result.code });
                    if (hooks.onModelsList) hooks.onModelsList({ ok: false, code: result.code });
                }
            }
        }).catch((err) => {
            // Adapter resolves instead of rejecting; this is a safety net.
            state.discoveryInFlight = false;
            opLog.recordOp({ op: 'model_discovery', status: 'error', error_code: 'runtime_error', duration_ms: Date.now() - startedAt });
            logger.warn(`[AI-CONNECTOR] discovery crashed: ${err.message}`);
        });
    }

    /** Explicit server-driven refresh — always fresh (bypasses the TTL). */
    function requestDiscovery() {
        if (state.phase !== 'ready') return;
        runDiscovery('refresh');
    }

    /**
     * Heartbeat facts refresh: only when the §7 cache is stale. This is NOT
     * a probe loop — with the default 30 s TTL the runtime is asked at most
     * once per 30 s, and only while a session is live.
     */
    function maybeRefreshForHeartbeat() {
        const stale = !state.cache.lastDiscoveryAt
            || (Date.now() - state.cache.lastDiscoveryAt) >= cacheTtl;
        if (stale) runDiscovery('heartbeat');
    }

    function sendHeartbeat() {
        const hb = { type: 'heartbeat', runtime: { type: config.runtimeType } };
        // §7 honesty: model facts are reported only from real observations.
        // Before the FIRST discovery completes, `models` is OMITTED (not an
        // empty list) — an empty list would wipe the connector's last-known
        // state in PG after a restart. After a failure, the last known-good
        // list is kept and paired with runtime_ok:false (an unreachable
        // runtime is not proof that models disappeared).
        if (state.cache.lastDiscoveryAt > 0) hb.models = state.cache.models.slice();
        // runtime_ok only when actually observed — never fabricated (AD-7:
        // latency_ms is omitted entirely until real traffic exists in later
        // phases; capabilities omitted → backend assumes plain completion).
        if (typeof state.cache.runtimeOk === 'boolean') hb.runtime_ok = state.cache.runtimeOk;
        send(hb);
    }

    function startHeartbeat(intervalMs) {
        if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
        state.heartbeatTimer = setInterval(() => {
            maybeRefreshForHeartbeat();
            sendHeartbeat();
        }, clampInterval(intervalMs));
        if (state.heartbeatTimer.unref) state.heartbeatTimer.unref();
    }

    function scheduleReconnect() {
        if (state.stopped || state.reconnectTimer) return;
        const exp = Math.min(
            DEFAULTS.reconnectMaxMs,
            DEFAULTS.reconnectBaseMs * Math.pow(2, Math.min(state.attempts, 10)),
        );
        const delay = Math.round(exp + Math.random() * 250);
        state.attempts += 1;
        state.phase = 'idle';
        logger.info(`[AI-CONNECTOR] reconnecting in ${delay}ms (attempt ${state.attempts})`);
        state.reconnectTimer = setTimeout(() => {
            state.reconnectTimer = null;
            connect();
        }, delay);
        if (state.reconnectTimer.unref) state.reconnectTimer.unref();
    }

    function handleMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
        } catch (_) {
            return; // malformed server frame — ignore safely
        }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ready') {
            state.phase = 'ready';
            state.connectorId = typeof msg.connector_id === 'string' ? msg.connector_id : null;
            state.attempts = 0;
            const interval = config.heartbeatIntervalMs != null
                ? config.heartbeatIntervalMs
                : (msg.heartbeat_interval_ms || DEFAULTS.heartbeatIntervalMs);
            startHeartbeat(interval);
            // Immediate first heartbeat: the backend learns liveness + the
            // runtime type instantly (pre-discovery it carries NO models
            // field — facts stay honest, last-known PG state is preserved).
            sendHeartbeat();
            // Activation path (§8.1): the minted llmc.* arrives EXACTLY once.
            // The session never logs it — disclosure is the CLI's job.
            if (typeof msg.credential === 'string' && hooks.onCredential) {
                hooks.onCredential(msg.credential);
            }
            logger.info(`[AI-CONNECTOR] ready (connector ${state.connectorId ? 'registered' : 'unknown'})`);
            if (hooks.onReady) hooks.onReady(msg);
            return;
        }
        if (msg.type === 'models.refresh') {
            // Only `type` is read. Any url/base_url/path fields a hostile or
            // broken server attaches are structurally ignored (AD-5).
            requestDiscovery();
            return;
        }
        // Unknown types are ignored safely — the protocol surface is fixed.
    }

    function connect() {
        if (state.stopped) return;
        if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
        state.phase = 'connecting';
        let ws;
        try {
            ws = new WS(config.url);
        } catch (err) {
            logger.warn(`[AI-CONNECTOR] connect failed: ${err.message}`);
            scheduleReconnect();
            return;
        }
        state.ws = ws;
        ws.on('open', () => {
            const hello = { type: 'hello', protocol_version: 1 };
            if (config.token.startsWith('llmcreg.')) hello.reg_token = config.token;
            else hello.credential = config.token;
            send(hello);
        });
        ws.on('message', (data, isBinary) => {
            if (isBinary) return;
            handleMessage(data.toString());
        });
        ws.on('error', (err) => {
            logger.warn(`[AI-CONNECTOR] socket error: ${err.message}`);
        });
        ws.on('close', () => {
            if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
            if (!state.stopped) scheduleReconnect();
        });
    }

    return {
        start() {
            if (state.stopped) throw new Error('session stopped');
            connect();
        },
        stop() {
            state.stopped = true;
            state.phase = 'stopped';
            clearTimers();
            if (state.ws) {
                try { state.ws.close(1000, 'client_stop'); } catch (_) {}
            }
        },
        /** Metadata snapshot (models, liveness facts) — no secrets. */
        getSnapshot() {
            return {
                phase: state.phase,
                connectorId: state.connectorId,
                models: state.cache.models.slice(),
                runtimeOk: state.cache.runtimeOk,
                lastDiscoveryAt: state.cache.lastDiscoveryAt || null,
            };
        },
        // Test seam: feed one inbound frame through the session exactly as
        // the socket would (unit-level driving without a real server).
        _handleMessage: handleMessage,
        /** Test seam: one explicit heartbeat emission (§7 cadence). */
        _sendHeartbeat: sendHeartbeat,
    };
}

module.exports = { createConnectorSession, DEFAULTS };
