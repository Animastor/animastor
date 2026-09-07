// ======================================================
// Connector WS session (LAC-3/LAC-4 — hello/ready, heartbeat, discovery,
// non-streaming inference)
// ======================================================
// Outbound session against the Animastor connector endpoint:
//
//   C→S hello       { protocol_version:1, credential | reg_token }
//   S→C ready       { connector_id, heartbeat_interval_ms, server_time
//                     [, credential, credential_prefix] }  — activation only
//   C→S heartbeat   { models[], runtime_ok, runtime{type} }  — cadence from ready
//   S→C models.refresh {}                    → connector fetches locally:
//                                              GET {base}/v1/models (adapter)
//   C→S models.list  { models[] | error_code }
//   S→C chat.request { request_id, model, messages, params, timeout_ms }
//                                              → connector fetches locally:
//                                              POST {base}/v1/chat/completions
//                                                (adapter; stream:false, or
//                                                 stream:true when
//                                                 params.stream === true)
//   C→S chat.response { request_id, model, content, finish_reason, usage }
//   C→S chat.error    { request_id, code, message }
//   S→C chat.cancel   { request_id }           → abort the local fetch, free
//                                                the slot, send NOTHING
//
// Invariants:
//   - NO automatic probes (AD-7): discovery runs ONLY on explicit
//     models.refresh, plus a TTL-cached re-check for heartbeat facts
//     (default 30 s, §7). Inference runs ONLY on explicit chat.request.
//   - The runtime base URL is LOCAL CONFIG ONLY. Frames from the cloud are
//     read for `type` and their documented fields and NOTHING else —
//     there is no field a cloud could use to point the runtime call
//     elsewhere (AD-5). chat.request carries no url; any url-like extra
//     fields are dropped at the validation seam (lib/chat.cjs).
//   - Phase 4 inference is non-streaming by default; Phase 5 adds
//     params.stream === true → POST /v1/chat/completions with stream:true
//     through the dedicated adapter function → N× C→S chat.delta
//     {request_id, delta} + exactly ONE terminal chat.response
//     (or chat.error). A stream request is executed at most once, holds
//     one concurrency slot for its whole duration and cancels exactly
//     like a non-streaming one (chat.cancel aborts the local fetch).
//   - Concurrency: at most LIMITS.maxConcurrentRequests (default 2, §4)
//     local runtime requests at once; overflow answers busy immediately.
//   - request_id uniqueness: a request_id is executed at most ONCE per
//     session lifecycle (in-flight OR completed ids are rejected
//     invalid_request — no re-execution, ever). The per-session seen-id
//     store is fingerprinted and NEVER evicted; when it reaches its bound
//     the session turns fail-closed (new ids refused invalid_request)
//     instead of forgetting — bounded memory must never weaken the
//     at-most-once contract. The store dies with the session: it is
//     cleared on close/stop, so a reconnect starts a fresh lifecycle.
//   - Every limit is enforced HERE, not trusted from the cloud (§4
//     Phase-4 note); violation → sanitized chat.error, session survives.
//   - One in-flight discovery at a time; extra refreshes coalesce (no
//     fan-out against the local runtime even under a hostile server).
//   - Local logging is METADATA-ONLY (AD-6): request_id, model, status,
//     error_code, duration — never prompts, never responses.
//   - Reconnects with exponential backoff + jitter; the credential is NEVER
//     logged (logger callers only ever pass metadata).
// ======================================================

const adapters = require('./runtime-adapters/index.cjs');
const opLog = require('./log.cjs');
const chat = require('./chat.cjs');

const DEFAULTS = {
    heartbeatIntervalMs: 15 * 1000,   // fallback if ready omits the cadence
    heartbeatCacheTtlMs: 30 * 1000,   // §7: runtime facts locally cached ~30 s
    reconnectBaseMs: 1000,
    reconnectMaxMs: 30 * 1000,
    discoveryTimeoutMs: 8 * 1000,
    maxConcurrentRequests: chat.LIMITS.maxConcurrentRequests, // §4 default 2
};

function defaultWebSocketImpl() {
    try {
        // Lazy: only the CLI path needs the dependency; tests may inject.
        return require('ws').WebSocket;
    } catch (_) {
        throw new Error('ws dependency not installed (run npm install in ai-connector)');
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
 * @param {number} [opts.maxConcurrentRequests] - §4 semaphore (default 2)
 */
function createConnectorSession({
    config,
    logger = console,
    WebSocketImpl = null,
    hooks = {},
    heartbeatCacheTtlMs = null,
    maxConcurrentRequests = null,
} = {}) {
    const WS = WebSocketImpl || defaultWebSocketImpl();
    const adapter = adapters.getAdapter(config.runtimeType);
    if (!adapter) {
        throw new Error(`no runtime adapter for type ${config.runtimeType}`);
    }
    const cacheTtl = Math.max(0, Number(heartbeatCacheTtlMs) || DEFAULTS.heartbeatCacheTtlMs);
    const maxConcurrent = Math.max(1, Number(maxConcurrentRequests) || DEFAULTS.maxConcurrentRequests);

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
        // Phase 4 inference state (ephemeral, in-memory only):
        //   inflight: request_id → { controller, model, startedAt, cancelledByCloud }
        //   seenIds: fingerprints of EVERY request_id seen in THIS session
        //     lifecycle (admitted, busy-rejected, or invalid) — at-most-once
        //     execution (§4). Entries are never evicted; when the store is
        //     full the session turns fail-closed (seenStoreFull below).
        chatInflight: new Map(),
        chatSeenIds: new Set(),
        chatSeenSaturated: false,
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

    // ── Phase 4: non-streaming inference (chat.request → adapter) ──────

    /** Sanitized chat.error frame (fixed allowlist codes only, §4). */
    function sendChatError(requestId, code) {
        send({
            type: 'chat.error',
            request_id: requestId,
            code,
            message: chat.errorMessages[code] || chat.errorMessages.runtime_error,
        });
    }

    /**
     * Remember a request_id for at-most-once execution. Fingerprinted,
     * never evicted (evicting could let a replayed id execute twice —
     * §4 forbids it). Once the store reaches its bound the session is
     * permanently FAIL-CLOSED for NEW ids: duplicate checks keep working
     * (false negatives are impossible), fresh unknown ids are refused.
     * @returns {boolean} false when the store was already full (the id
     *   was NOT stored; the caller must reject the request).
     */
    function rememberRequestId(requestId) {
        if (state.chatSeenSaturated) return false;
        const fp = chat.fingerprintRequestId(requestId);
        if (!state.chatSeenIds.has(fp) && state.chatSeenIds.size >= chat.LIMITS.maxSeenRequestIds) {
            // Bound reached — refuse rather than forget (at-most-once wins).
            state.chatSeenSaturated = true;
            return false;
        }
        state.chatSeenIds.add(fp);
        return true;
    }

    /** True when the id is already spent in this session lifecycle. */
    function hasSeenRequestId(requestId) {
        return state.chatSeenIds.has(chat.fingerprintRequestId(requestId));
    }

    /**
     * One chat.request → ONE local runtime call. All limits are enforced
     * HERE (lib/chat.cjs) — never trusted from the cloud. Concurrency:
     * §4 semaphore (default 2) → busy. Duplicate request_id (in-flight or
     * already executed this session) → invalid_request, never re-executed.
     * Once the seen-id store is full the session is fail-closed: NEW ids
     * are refused invalid_request (memory bound without eviction —
     * at-most-once is never weakened). The adapter owns the inference
     * timeout; chat.cancel aborts the local fetch via the entry's
     * AbortController. params.stream === true (Phase 5) switches to the
     * streaming adapter call: N× chat.delta + ONE terminal chat.response.
     */
    function runChatRequest(msg) {
        if (state.phase !== 'ready') return;
        const v = chat.validateChatRequest(msg);
        if (!v.ok) {
            // Un-correlatable frames (bad request_id) are dropped silently;
            // correlatable ones get a sanitized chat.error. Either way the
            // id is remembered — a rejected request_id never executes later.
            if (v.requestId) {
                rememberRequestId(v.requestId);
                sendChatError(v.requestId, v.code);
            }
            return;
        }
        const { requestId, model, messages, maxTokens, temperature, timeoutMs, stream } = v.request;

        // At-most-once per session lifecycle (§4 Phase-4 note).
        if (hasSeenRequestId(requestId) || state.chatInflight.has(requestId)) {
            sendChatError(requestId, 'invalid_request');
            return;
        }
        // Memory bound reached → fail-closed for NEW ids (never evict).
        if (state.chatSeenSaturated) {
            sendChatError(requestId, 'invalid_request');
            return;
        }
        // §4 concurrency semaphore — overflow answers busy immediately.
        if (state.chatInflight.size >= maxConcurrent) {
            rememberRequestId(requestId);
            sendChatError(requestId, 'busy');
            return;
        }
        if (!rememberRequestId(requestId)) {
            // Store saturated between the checks — refuse, never evict.
            sendChatError(requestId, 'invalid_request');
            return;
        }

        const entry = {
            controller: new AbortController(),
            model,
            startedAt: Date.now(),
            cancelledByCloud: false,
            stream, // Phase 5: this request streams (chat.delta frames)
        };
        state.chatInflight.set(requestId, entry);

        /**
         * Terminal failure for this request (in-flight entry exists):
         * sanitized chat.error + metadata log. A stream that already
         * delivered deltas carries the sanitized error the same way —
         * the cloud surfaces partial text + error (§4 Phase-5 note).
         */
        const finishChatError = (code) => {
            sendChatError(requestId, code);
            opLog.recordOp({ op: 'chat_completion', model, status: 'error', error_code: code, duration_ms: Date.now() - entry.startedAt, stream });
            logger.warn(`[AI-CONNECTOR] chat failed: ${code} (${Date.now() - entry.startedAt}ms)`);
        };

        // Adapter call — the streaming variant for params.stream === true
        // (Phase 5), the plain completion otherwise (Phase 4 unchanged).
        const call = stream
            ? adapter.chatCompletionStream({
                baseUrl: config.baseUrl,
                model,
                messages,
                maxTokens,
                temperature,
                timeoutMs,
                signal: entry.controller.signal,
                maxSseEventBytes: chat.LIMITS.maxSseEventBytes,
                maxSseLineBytes: chat.LIMITS.maxSseLineBytes,
                maxDeltaChars: chat.LIMITS.maxDeltaChars,
                maxStreamedContentChars: chat.LIMITS.maxStreamedContentChars,
                onDelta: (text) => {
                    // In-order forwarding; the session-bound entry guards
                    // against a late callback after cancel/close (the
                    // entry is deleted the moment the request settles).
                    if (!state.chatInflight.has(requestId)) return;
                    send({ type: 'chat.delta', request_id: requestId, delta: text });
                },
            })
            : adapter.chatCompletion({
                baseUrl: config.baseUrl,
                model,
                messages,
                maxTokens,
                temperature,
                timeoutMs,
                signal: entry.controller.signal,
            });

        call.then((result) => {
            // Already settled (e.g. session stopped) — nothing to do.
            if (!state.chatInflight.has(requestId)) return;
            state.chatInflight.delete(requestId);
            const durationMs = Date.now() - entry.startedAt;

            if (result.ok) {
                const frame = {
                    type: 'chat.response',
                    request_id: requestId,
                    model,
                    content: result.content,
                };
                if (result.finishReason) frame.finish_reason = result.finishReason;
                if (result.usage) frame.usage = result.usage;
                const serialized = JSON.stringify(frame);
                // Frame guard: a response that would not fit the cloud's
                // inbound frame cap fails with a sanitized error instead of
                // killing the session (§4 Phase-4 note). A streamed terminal
                // response can never exceed this: the cumulative cap
                // (maxStreamedContentChars) already bounds the joined text.
                if (Buffer.byteLength(serialized) > chat.LIMITS.maxResponseFrameBytes) {
                    sendChatError(requestId, 'response_too_large');
                    opLog.recordOp({ op: 'chat_completion', model, status: 'error', error_code: 'response_too_large', duration_ms: durationMs, stream });
                    return;
                }
                send(frame);
                opLog.recordOp({ op: 'chat_completion', model, status: 'ok', duration_ms: durationMs, bytes: result.rawBytes, stream });
                logger.info(`[AI-CONNECTOR] chat ok (model ${model}, ${durationMs}ms)`);
                return;
            }

            // Failure paths — sanitized codes only, never runtime detail.
            if (result.code === 'cancelled' && entry.cancelledByCloud) {
                // Cloud-initiated cancel: the terminal state IS the cancel —
                // nothing is sent back (§5); slot freed; session stays up.
                // (For a stream: deltas already sent stay sent; no further
                // frame of any kind goes out for this id.)
                opLog.recordOp({ op: 'chat_completion', model, status: 'cancelled', duration_ms: durationMs, stream });
                logger.info(`[AI-CONNECTOR] chat cancelled (model ${model}, ${durationMs}ms)`);
                return;
            }
            finishChatError(result.code);
        }).catch(() => {
            // Safety net: the adapter resolves instead of rejecting; if it
            // ever throws, fail sanitized and free the slot.
            if (!state.chatInflight.has(requestId)) return;
            state.chatInflight.delete(requestId);
            finishChatError('runtime_error');
        });
    }

    /**
     * chat.cancel (S→C, §5): find the request by request_id, abort the
     * underlying local HTTP fetch (streaming included — the SSE read dies
     * with the same AbortController), free the slot. Unknown/finished ids
     * are ignored silently; the WS session is NEVER closed by a cancel.
     */
    function handleChatCancel(msg) {
        const requestId = chat.validateChatCancel(msg);
        if (!requestId) return; // malformed — ignore safely
        const entry = state.chatInflight.get(requestId);
        if (!entry) return; // unknown, late or already finished — ignore
        entry.cancelledByCloud = true;
        entry.controller.abort();
        // Settling happens in runChatRequest's promise chain (slot freed,
        // status cancelled in the metadata log, NO frame back).
    }

    /** Abort every in-flight inference (socket died / session stopped). */
    function abortAllInflight() {
        for (const entry of state.chatInflight.values()) {
            try { entry.controller.abort(); } catch (_) {}
        }
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
        if (msg.type === 'chat.request') {
            // Phase 4 inference. lib/chat.cjs reads request_id/model/
            // messages/params/timeout_ms and NOTHING else — any url/base_url/
            // endpoint/identity fields a hostile server attaches are dropped
            // at the seam; the runtime call always goes to the LOCAL base
            // URL, POST /v1/chat/completions, stream:false (AD-5).
            runChatRequest(msg);
            return;
        }
        if (msg.type === 'chat.cancel') {
            handleChatCancel(msg);
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
            // In-flight inference dies with the socket: abort the local
            // fetches (no frames can be sent anyway). The seen-id store,
            // its saturation flag and the inflight map are reset — the
            // request_id lifecycle is per session; a reconnect starts a
            // fresh one.
            abortAllInflight();
            state.chatInflight.clear();
            state.chatSeenIds.clear();
            state.chatSeenSaturated = false;
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
            abortAllInflight();
            state.chatInflight.clear();
            state.chatSeenIds.clear();
            state.chatSeenSaturated = false;
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
