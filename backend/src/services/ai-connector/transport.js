// ======================================================
// LLM Connector inference transport (LAC-4 — Local AI Connector V1 Phase 4)
// ======================================================
// The callAI-shaped seam for inference over an established connector WS
// session (§4 Phase-4/Phase-5 notes, §5, §9):
//
//   caller → connectorChat(connectorId, {model, messages, params})
//       → registry live-session lookup (offline → fail-closed explicit
//         `connector_offline`, NEVER a silent fallback — AD-12)
//       → S→C chat.request { request_id, model, messages, params,
//                            timeout_ms }   (validated against the same
//         limits the connector enforces — defense in depth)
//       → C→S chat.response | chat.error  (correlated by request_id)
//       → caller gets { ok, content, finish_reason, usage } or a sanitized
//         { ok:false, code } — never a runtime detail, never a raw error.
//
//   caller → connectorChatStream(connectorId, {model, messages, params},
//                                 { onDelta })            — Phase 5:
//       → S→C chat.request { …, params.stream:true }
//       → C→S N× chat.delta { request_id, delta }
//       → C→S ONE terminal chat.response (or chat.error)
//       → the caller's onDelta fires per increment; the final result
//         carries the full content (deltas are echoed only through
//         onDelta — nothing else is stored, §10.3).
//
// Multiplexing & lifecycle (§4/§5):
//   - request_id is a cloud-generated UUID — unique by construction;
//   - the cloud timer is AUTHORITATIVE: on expiry the transport sends
//     chat.cancel downstream and fails the caller with `timeout`; the
//     connector aborts the local fetch (late terminal frames for settled
//     ids are dropped here);
//   - pending entries are SESSION-BOUND: a reply is accepted only from
//     the session the request was sent on; a dying socket fails its own
//     pending requests fast (`session_closed`), a replacement session can
//     never settle the old session's requests;
//   - unsolicited frames (no matching pending entry) are ignored at zero
//     cost — a hostile connector cannot inject responses into other
//     requests or fabricate completion for ids it was never given;
//   - inference state is EPHEMERAL (in-memory map only) — no persistence,
//     no queue, nothing durable (§8 untouched).
//
// Security (§10):
//   - the frame carries NO url/base_url/endpoint/identity field — the
//     runtime call always goes to the connector's LOCAL config (AD-5);
//   - logging is metadata-only: request_id, connector id, model, duration,
//     status, sanitized code — never prompts, never responses, never
//     credentials/Authorization material;
//   - incoming chat.response/chat.error frames are validated and
//     sanitized field-by-field; an unknown chat.error code degrades to the
//     generic `runtime_error` (no echo of hostile content).
// ======================================================

const crypto = require('crypto');
const registry = require('./registry');

const DEFAULTS = {
    requestTimeoutMs: 180 * 1000, // §5: the chat window (AI_FETCH_TIMEOUT_MS)
};

// Mirror of the connector-side limits (local-ai-connector/lib/chat.cjs).
// Both sides enforce the SAME contract — the cloud validates before
// sending, the connector re-validates defensively (§4 Phase-4 note).
const LIMITS = {
    maxModelChars: 512,
    maxMessages: 64,
    maxMessageChars: 32 * 1024,
    maxTotalPromptChars: 128 * 1024,
    maxMaxTokens: 8192,
    minTemperature: 0,
    maxTemperature: 2,
    maxResponseChars: 32 * 1024, // content cap in chat.response
    maxFinishReasonChars: 64,
    maxErrorFrameMessageChars: 256,
    // Phase 5 streaming (mirror of the connector-side limits):
    maxDeltaChars: 16 * 1024, // one chat.delta increment
    maxStreamedContentChars: 32 * 1024, // cumulative streamed text
};

// The chat.error code allowlist (§4 Phase-4 note) + the cloud-side
// transport codes (never come from the wire).
const CONNECTOR_CHAT_ERROR_CODES = new Set([
    'invalid_request',
    'request_too_large',
    'model_not_found',
    'busy',
    'timeout',
    'runtime_unreachable',
    'context_length',
    'bad_response',
    'runtime_error',
    'response_too_large',
    'cancelled',
]);
const GENERIC_CHAT_ERROR = 'runtime_error';
// Connector-side codes that may arrive for a stream that ALREADY delivered
// deltas (adapter §4 Phase-5 note: any mid-stream failure after content
// surfaced resolves stream_failed upstream; before content the original
// sanitized code is kept).
const STREAM_FAILED_CODE = 'stream_failed';

const CHAT_ROLES = new Set(['system', 'user', 'assistant']);

// request_id is cloud-generated — printable, log-safe.
const REQUEST_ID_RE = /^[\x21-\x7e]{1,128}$/;
const MODEL_CTRL_RE = /[\u0000-\u001f\u007f]/;

// Sanitized per-code messages surfaced to callers (§4 error discipline).
const SANITIZED_MESSAGES = {
    invalid_request: 'Request rejected by connector validation',
    request_too_large: 'Request exceeds connector size limits',
    model_not_found: 'Model not found on the local runtime',
    busy: 'Local connector is at its concurrency limit',
    timeout: 'Local inference timed out',
    runtime_unreachable: 'Local runtime is not reachable',
    context_length: 'Prompt exceeds the model context window',
    bad_response: 'Local runtime returned an unreadable response',
    runtime_error: 'Local runtime error',
    response_too_large: 'Local response exceeded the size limit',
    cancelled: 'Request cancelled',
    stream_failed: 'Local runtime stream failed after partial output',
    connector_offline: 'Local AI connector is offline',
    session_closed: 'Connector session closed before completion',
};

// One outstanding request per request_id: { session, connectorId, model,
// resolve, timer, settled }.
const pending = new Map();

function sanitizeMessage(text) {
    if (typeof text !== 'string') return null;
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, LIMITS.maxErrorFrameMessageChars);
    return clean.length > 0 ? clean : null;
}

/** Settle (once) the pending entry for a request_id. */
function settle(requestId, result) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
    }
    entry.resolve(result);
    return true;
}

/**
 * Validate the caller-supplied payload against the SAME limits the
 * connector enforces (defense in depth — the cloud never sends a frame
 * that would be rejected downstream). Mirrors lib/chat.cjs semantics:
 * size violations → request_too_large, shape violations → invalid_request.
 */
function validatePayload({ model, messages, params = {} } = {}) {
    if (typeof model !== 'string') return { ok: false, code: 'invalid_request' };
    const trimmed = model.trim();
    if (trimmed.length === 0 || trimmed.length > LIMITS.maxModelChars || MODEL_CTRL_RE.test(trimmed)) {
        return { ok: false, code: 'invalid_request' };
    }
    if (!Array.isArray(messages) || messages.length === 0) {
        return { ok: false, code: 'invalid_request' };
    }
    if (messages.length > LIMITS.maxMessages) {
        return { ok: false, code: 'request_too_large' };
    }
    const cleanMessages = [];
    let total = 0;
    for (const entry of messages) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return { ok: false, code: 'invalid_request' };
        }
        if (!CHAT_ROLES.has(entry.role)) return { ok: false, code: 'invalid_request' };
        if (typeof entry.content !== 'string' || entry.content.length === 0) {
            return { ok: false, code: 'invalid_request' };
        }
        if (entry.content.length > LIMITS.maxMessageChars) {
            return { ok: false, code: 'request_too_large' };
        }
        total += entry.content.length;
        if (total > LIMITS.maxTotalPromptChars) {
            return { ok: false, code: 'request_too_large' };
        }
        cleanMessages.push({ role: entry.role, content: entry.content });
    }
    const cleanParams = {};
    if (params.max_tokens != null) {
        if (typeof params.max_tokens !== 'number' || !Number.isInteger(params.max_tokens) || params.max_tokens < 1) {
            return { ok: false, code: 'invalid_request' };
        }
        if (params.max_tokens > LIMITS.maxMaxTokens) {
            return { ok: false, code: 'request_too_large' };
        }
        cleanParams.max_tokens = params.max_tokens;
    }
    if (params.temperature != null) {
        if (typeof params.temperature !== 'number' || !Number.isFinite(params.temperature)
            || params.temperature < LIMITS.minTemperature || params.temperature > LIMITS.maxTemperature) {
            return { ok: false, code: 'invalid_request' };
        }
        cleanParams.temperature = params.temperature;
    }
    // Unknown param keys are dropped — never forwarded (§4). `stream` is
    // call-shape: connectorChat never sets it, connectorChatStream always
    // sets it true (mirrors the connector-side strict-boolean contract).
    if (params.stream === true) cleanParams.stream = true;
    return { ok: true, model: trimmed, messages: cleanMessages, params: cleanParams };
}

/**
 * Send one (streaming when opts.onDelta is present) chat request to a LIVE
 * connector over its WS session and resolve on the correlated terminal
 * chat.response / chat.error.
 *
 * Streaming (Phase 5): params.stream:true is added to the frame; incoming
 * chat.delta frames fire opts.onDelta(delta) in order; the terminal
 * chat.response settles the promise with the FULL content (the joined
 * text — the terminal frame always carries it, including the empty-string
 * clean completion of a stream that produced no text). All limits are
 * enforced HERE, never trusted from the connector: each delta ≤
 * maxDeltaChars, cumulative text ≤ maxStreamedContentChars, per-frame JSON
 * stays under the 64 KB inbound cap — violations settle the request
 * response_too_large / invalid_request sanitized, and late frames for the
 * settled id are dropped.
 *
 * @param {string} connectorId
 * @param {object} payload - { model, messages, params:{max_tokens, temperature} }
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] - the authoritative cloud timer
 *        (§5; default 180 s). On expiry: chat.cancel downstream + the
 *        caller fails with `timeout`.
 * @param {Function} [opts.onDelta] - (delta:string) => void — presence
 *        switches the request to streaming (chat.delta).
 * @param {object} [opts.logger]
 * @returns {Promise<{ok:true, content:string, finishReason:string|undefined,
 *                    usage:object|undefined, model:string, requestId:string}
 *                 |{ok:false, code:string, message:string, partial?:string}>}
 *          Never rejects — callers render sanitized codes only. For a
 *          stream that delivered deltas before failing, `partial` carries
 *          the accumulated text (connector-side failures) — cloud-side
 *          failures surface partial through onDelta having already fired.
 */
async function connectorChat(connectorId, payload, { timeoutMs = DEFAULTS.requestTimeoutMs, onDelta = null, logger = console } = {}) {
    const v = validatePayload(payload);
    if (!v.ok) {
        return { ok: false, code: v.code, message: SANITIZED_MESSAGES[v.code] };
    }
    const streaming = typeof onDelta === 'function';
    if (streaming) v.params.stream = true;

    const session = registry.getLive(connectorId);
    if (!session || !session.ws || session.ws.readyState !== 1) {
        // AD-12: fail-closed explicit "Local AI is offline" — never a
        // silent fallback to another provider.
        return { ok: false, code: 'connector_offline', message: SANITIZED_MESSAGES.connector_offline };
    }

    const requestId = crypto.randomUUID();
    const effectiveTimeout = Math.max(1, Math.min(Number(timeoutMs) || DEFAULTS.requestTimeoutMs, DEFAULTS.requestTimeoutMs));

    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    const entry = {
        session,
        connectorId,
        model: v.model,
        resolve,
        timer: null,
        settled: false,
        // Phase 5 streaming state:
        stream: streaming,
        onDelta: streaming ? onDelta : null,
        received: 0, // cumulative validated delta chars
    };
    pending.set(requestId, entry);

    // §5: the cloud timer is authoritative — expiry cancels downstream and
    // fails the caller (the connector aborts its local fetch; any late
    // delta/terminal frame for this id is dropped by handleConnectorFrame).
    entry.timer = setTimeout(() => {
        if (entry.settled) return;
        entry.settled = true;
        try {
            session.ws.send(JSON.stringify({ type: 'chat.cancel', request_id: requestId }));
        } catch (_) { /* dead socket — failPendingFor owns the state */ }
        settle(requestId, { ok: false, code: 'timeout', message: SANITIZED_MESSAGES.timeout });
        logger.warn(`[AI-CONNECTOR] chat timeout (connector ${connectorId}, request ${requestId})`);
    }, effectiveTimeout);
    if (entry.timer.unref) entry.timer.unref();

    const frame = {
        type: 'chat.request',
        request_id: requestId,
        model: v.model,
        messages: v.messages,
        params: v.params,
        timeout_ms: effectiveTimeout,
    };
    try {
        session.ws.send(JSON.stringify(frame));
    } catch (_) {
        settle(requestId, { ok: false, code: 'connector_offline', message: SANITIZED_MESSAGES.connector_offline });
        return promise;
    }

    // Micro-optimization for readability: attach logging at settle time via
    // a wrapper so durations include the full round trip.
    const startedAt = Date.now();
    promise.then((result) => {
        // Metadata-only log line (§10.3): ids, model, duration, status.
        const durationMs = Date.now() - startedAt;
        const code = result.ok ? 'ok' : result.code;
        if (result.ok) {
            logger.info(`[AI-CONNECTOR] chat ok (connector ${connectorId}, model ${v.model}, ${durationMs}ms)`);
        } else {
            logger.warn(`[AI-CONNECTOR] chat failed: ${code} (connector ${connectorId}, ${durationMs}ms)`);
        }
    });
    return promise;
}

/**
 * Send one STREAMING chat request (Phase 5): chat.request with
 * params.stream:true → N× chat.delta → ONE terminal chat.response
 * (or chat.error). Thin wrapper over connectorChat — see its contract.
 */
function connectorChatStream(connectorId, payload, { timeoutMs, onDelta, logger } = {}) {
    if (typeof onDelta !== 'function') {
        // Programming error on the caller side — fail sanitized, never
        // a non-streaming silent downgrade.
        return Promise.resolve({ ok: false, code: 'invalid_request', message: SANITIZED_MESSAGES.invalid_request });
    }
    return connectorChat(connectorId, payload, { timeoutMs, onDelta, logger });
}

/**
 * Sanitize the usage block of a chat.response: only the three documented
 * integer counters survive, each bounded; anything else is dropped.
 */
function sanitizeUsage(u) {
    if (!u || typeof u !== 'object' || Array.isArray(u)) return undefined;
    const out = {};
    let any = false;
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
        const val = u[key];
        if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
            out[key] = Math.min(Math.round(val), 1e9);
            any = true;
        }
    }
    return any ? out : undefined;
}

/**
 * Handle an authenticated `chat.response` / `chat.error` frame arriving on
 * a live session (called from the WS route). Only frames answering a
 * PENDING request bound to THIS session are processed — everything else is
 * dropped safely (unsolicited, late, settled, or cross-session).
 * Every field is sanitized; unknown chat.error codes degrade to the
 * generic runtime_error (no echo of hostile content).
 *
 * @returns {{handled:boolean, result:object|null}}
 */
function handleConnectorFrame(session, msg, { logger = console } = {}) {
    if (!msg || typeof msg !== 'object') return { handled: false, result: null };
    const requestId = typeof msg.request_id === 'string' ? msg.request_id : null;
    if (!requestId || !REQUEST_ID_RE.test(requestId)) {
        logger.warn('[AI-CONNECTOR] chat frame without correlatable request_id — dropped');
        return { handled: false, result: null };
    }
    const entry = pending.get(requestId);
    if (!entry) {
        // Unsolicited or late (already settled/cancelled) — zero cost drop.
        return { handled: false, result: null };
    }
    if (entry.session !== session) {
        // A reply may settle ONLY the request sent on the SAME session —
        // a replacement session can never hijack the old session's ids.
        logger.warn(`[AI-CONNECTOR] chat frame for ${requestId} arrived on the wrong session — dropped`);
        return { handled: false, result: null };
    }

    if (msg.type === 'chat.delta') {
        // Phase 5: an incremental TEXT frame for a PENDING STREAMING
        // request on THIS session. Strictly validated: string delta within
        // the per-delta cap; the cumulative sum stays within the streamed-
        // content cap. Any violation settles the request response_too_large
        // (never echoes the delta); deltas for a non-streaming request or
        // after settlement are dropped at zero cost.
        if (!entry.stream) {
            logger.warn(`[AI-CONNECTOR] chat.delta for non-streaming ${requestId} — dropped`);
            return { handled: false, result: null };
        }
        if (typeof msg.delta !== 'string') {
            settle(requestId, { ok: false, code: 'invalid_request', message: SANITIZED_MESSAGES.invalid_request });
            return { handled: true, result: null };
        }
        if (msg.delta.length > LIMITS.maxDeltaChars) {
            settle(requestId, { ok: false, code: 'response_too_large', message: SANITIZED_MESSAGES.response_too_large });
            return { handled: true, result: null };
        }
        if (entry.received + msg.delta.length > LIMITS.maxStreamedContentChars) {
            settle(requestId, { ok: false, code: 'response_too_large', message: SANITIZED_MESSAGES.response_too_large });
            return { handled: true, result: null };
        }
        entry.received += msg.delta.length;
        try {
            entry.onDelta(msg.delta);
        } catch (_) { /* a consumer error never breaks the transport */ }
        return { handled: true, result: null };
    }

    if (msg.type === 'chat.response') {
        // content: required string within the response cap; over-limit →
        // sanitized response_too_large (never the raw content). For a
        // streaming request an empty string is a valid terminal (a stream
        // that produced no text completes cleanly with empty content —
        // §4 Phase-5 note); a non-streaming request keeps requiring text
        // only through its own caller semantics (the connector always
        // sends the full text; empty is passed through as-is either way).
        if (typeof msg.content !== 'string') {
            settle(requestId, { ok: false, code: 'bad_response', message: SANITIZED_MESSAGES.bad_response });
            return { handled: true, result: null };
        }
        if (msg.content.length > LIMITS.maxResponseChars) {
            settle(requestId, { ok: false, code: 'response_too_large', message: SANITIZED_MESSAGES.response_too_large });
            return { handled: true, result: null };
        }
        const finishReason = (typeof msg.finish_reason === 'string'
            && msg.finish_reason.length > 0
            && msg.finish_reason.length <= LIMITS.maxFinishReasonChars
            && !MODEL_CTRL_RE.test(msg.finish_reason))
            ? msg.finish_reason : undefined;
        settle(requestId, {
            ok: true,
            content: msg.content,
            finishReason,
            usage: sanitizeUsage(msg.usage),
            model: entry.model,
            requestId,
        });
        return { handled: true, result: null };
    }

    if (msg.type === 'chat.error') {
        // Allowlisted codes only; anything else degrades to the generic
        // error — a hostile or non-allowlisted code's message is discarded
        // entirely (only allowlisted codes may carry a sanitized message).
        const isAllowlisted = typeof msg.code === 'string' && CONNECTOR_CHAT_ERROR_CODES.has(msg.code);
        let code = isAllowlisted ? msg.code : GENERIC_CHAT_ERROR;
        let message = isAllowlisted
            ? (sanitizeMessage(msg.message) || SANITIZED_MESSAGES[code])
            : SANITIZED_MESSAGES[code];
        // §4 Phase-5 note: an error for a stream that ALREADY delivered
        // deltas degrades to the fixed stream_failed (the caller already
        // holds the partial text through onDelta) — before any delta the
        // original sanitized code is kept (Phase 4 behavior unchanged).
        if (entry.stream && entry.received > 0 && code !== 'timeout' && code !== 'cancelled') {
            code = STREAM_FAILED_CODE;
            message = SANITIZED_MESSAGES[code];
        }
        settle(requestId, { ok: false, code, message });
        return { handled: true, result: null };
    }

    return { handled: false, result: null };
}

/**
 * Fail every pending request bound to THIS session immediately (socket
 * closed / session replaced / evicted) — a dead session must never leave
 * callers waiting for the timeout. Safe to call unconditionally.
 * @returns {number} how many pending requests were failed.
 */
function failPendingFor(session) {
    if (!session) return 0;
    let count = 0;
    for (const [requestId, entry] of pending) {
        if (entry.session === session) {
            entry.settled = true;
            if (entry.timer) clearTimeout(entry.timer);
            pending.delete(requestId);
            entry.resolve({ ok: false, code: 'session_closed', message: SANITIZED_MESSAGES.session_closed });
            count += 1;
        }
    }
    return count;
}

/** Test/ops seam: number of outstanding requests. */
function stats() {
    return { pending: pending.size };
}

module.exports = {
    connectorChat,
    connectorChatStream,
    handleConnectorFrame,
    failPendingFor,
    validatePayload,
    sanitizeUsage,
    stats,
    DEFAULTS,
    LIMITS,
    CONNECTOR_CHAT_ERROR_CODES,
    SANITIZED_MESSAGES,
    STREAM_FAILED_CODE,
};
