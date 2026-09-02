// ======================================================
// Connector chat request validation + limits (LAC-4 — Phase 4)
// ======================================================
// Defensive validation of an inbound `chat.request` frame (S→C). The
// cloud is the peer, but the connector still enforces EVERY limit itself
// (server-side enforcement — §4 Phase-4 note): a hostile or broken server
// must never be able to push oversized prompts, unbounded generation,
// arbitrary runtimes or duplicate request_ids through this connector.
//
// The runtime base URL NEVER comes from the frame — a hostile server
// attaching url/base_url/endpoint fields changes NOTHING (AD-5): this
// module reads request_id/model/messages/params/timeout_ms and NOTHING
// else.
//
// Phase 4 = non-streaming ONLY: `stream` is not a settable parameter —
// the adapter hardcodes stream:false (chat.delta is Phase 5).
// ======================================================

const LIMITS = {
    maxRequestIdChars: 128,
    maxModelChars: 512,            // mirrors the cloud-side model-id cap
    maxMessages: 64,
    maxMessageChars: 32 * 1024,    // per message content
    maxTotalPromptChars: 128 * 1024,
    maxMaxTokens: 8192,
    minTemperature: 0,
    maxTemperature: 2,
    minTimeoutMs: 1000,
    maxTimeoutMs: 180 * 1000,      // §5: the chat window — never larger here
    maxChatFrameBytes: 1024 * 1024, // hostile-frame guard (prompt caps bind first)
    maxConcurrentRequests: 2,      // §4: connector-side semaphore default
    maxSeenRequestIds: 10000,      // per-session duplicate protection bound
    // Serialized chat.response frame cap — fits under the cloud's 64 KB
    // inbound frame cap with margin (an ordinary long completion must fail
    // with a sanitized error, never kill the session; §4 Phase-4 note).
    maxResponseFrameBytes: 60 * 1024,
};

// Fixed sanitized error messages (allowlisted codes only — a raw runtime
// error text NEVER crosses the WS; the cloud truncates to 256 chars).
const errorMessages = {
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
};

// The full chat.error code allowlist (§4 Phase-4 note).
const CHAT_ERROR_CODES = Object.keys(errorMessages);

const CHAT_ROLES = ['system', 'user', 'assistant'];

// request_id is cloud-generated (UUID) — printable, no control characters
// (it is the one chat field that reaches the metadata log; §10.3).
const REQUEST_ID_RE = /^[\x21-\x7e]{1,128}$/;
// Model ids must never carry control characters (log-injection guard).
const MODEL_ID_RE = /^[\s\S]{1,512}$/;
const MODEL_CTRL_RE = /[\u0000-\u001f\u007f]/;

/**
 * Validate one chat.request frame.
 * @returns {{ok:true, request:{requestId, model, messages, maxTokens,
 *                               temperature, timeoutMs}}
 *           |{ok:false, code:'invalid_request'|'request_too_large',
 *             requestId:string|null}}
 *          Size violations → request_too_large; shape/type/range
 *          violations → invalid_request. `requestId` is non-null only
 *          when it is a valid correlatable string (error replies are
 *          possible only then; otherwise the frame is dropped silently).
 */
function validateChatRequest(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        return { ok: false, code: 'invalid_request', requestId: null };
    }
    const requestId = typeof msg.request_id === 'string' ? msg.request_id : null;
    if (requestId === null || !REQUEST_ID_RE.test(requestId)) {
        // No correlatable request_id → no reply is possible. Drop.
        return { ok: false, code: 'invalid_request', requestId: null };
    }

    // model: present, string, sane size, no control characters.
    if (typeof msg.model !== 'string') {
        return { ok: false, code: 'invalid_request', requestId };
    }
    const model = msg.model.trim();
    if (model.length === 0 || !MODEL_ID_RE.test(model) || MODEL_CTRL_RE.test(model)) {
        return { ok: false, code: 'invalid_request', requestId };
    }

    // messages: non-empty array, bounded count, strict entries.
    if (!Array.isArray(msg.messages) || msg.messages.length === 0) {
        return { ok: false, code: 'invalid_request', requestId };
    }
    if (msg.messages.length > LIMITS.maxMessages) {
        return { ok: false, code: 'request_too_large', requestId };
    }
    const messages = [];
    let total = 0;
    for (const entry of msg.messages) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return { ok: false, code: 'invalid_request', requestId };
        }
        if (!CHAT_ROLES.includes(entry.role)) {
            return { ok: false, code: 'invalid_request', requestId };
        }
        if (typeof entry.content !== 'string' || entry.content.length === 0) {
            return { ok: false, code: 'invalid_request', requestId };
        }
        if (entry.content.length > LIMITS.maxMessageChars) {
            return { ok: false, code: 'request_too_large', requestId };
        }
        total += entry.content.length;
        if (total > LIMITS.maxTotalPromptChars) {
            return { ok: false, code: 'request_too_large', requestId };
        }
        // Only role + content survive — a hostile entry's extra fields
        // (name, tool_calls, url, …) are dropped at the seam.
        messages.push({ role: entry.role, content: entry.content });
    }

    // params: only max_tokens and temperature are contractual; unknown
    // keys are dropped (never forwarded to the runtime).
    const params = (msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params))
        ? msg.params : {};
    let maxTokens = null;
    let temperature = null;
    if (params.max_tokens != null) {
        if (typeof params.max_tokens !== 'number' || !Number.isInteger(params.max_tokens) || params.max_tokens < 1) {
            return { ok: false, code: 'invalid_request', requestId };
        }
        if (params.max_tokens > LIMITS.maxMaxTokens) {
            return { ok: false, code: 'request_too_large', requestId };
        }
        maxTokens = params.max_tokens;
    }
    if (params.temperature != null) {
        if (typeof params.temperature !== 'number' || !Number.isFinite(params.temperature)
            || params.temperature < LIMITS.minTemperature || params.temperature > LIMITS.maxTemperature) {
            return { ok: false, code: 'invalid_request', requestId };
        }
        temperature = params.temperature;
    }

    // timeout_ms: cloud-controlled — clamped defensively, never trusted.
    let timeoutMs = LIMITS.maxTimeoutMs;
    if (msg.timeout_ms != null) {
        const t = Number(msg.timeout_ms);
        if (Number.isFinite(t)) {
            timeoutMs = Math.min(Math.max(Math.round(t), LIMITS.minTimeoutMs), LIMITS.maxTimeoutMs);
        }
    }

    return {
        ok: true,
        request: { requestId, model, messages, maxTokens, temperature, timeoutMs },
    };
}

/**
 * Validate a chat.cancel frame (S→C). Reads request_id and NOTHING else.
 * @returns {string|null} the request_id, or null when not correlatable.
 */
function validateChatCancel(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
    const id = typeof msg.request_id === 'string' ? msg.request_id : null;
    if (id === null || !REQUEST_ID_RE.test(id)) return null;
    return id;
}

module.exports = {
    LIMITS,
    CHAT_ROLES,
    CHAT_ERROR_CODES,
    errorMessages,
    validateChatRequest,
    validateChatCancel,
};
