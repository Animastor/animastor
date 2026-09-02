// ======================================================
// Runtime adapter — OpenAI-compatible (LAC-3, Phase 3; chat — LAC-4)
// ======================================================
// The runtime adapter behind the allowlist seam (AD-5, §3.4, §10.2,
// §6). All four V1 runtimes (Ollama / vLLM / llama.cpp / LM Studio) expose
// this API; `runtime_type` stays a UI label (§6).
//
// The adapter knows EXACTLY TWO operations and EXACTLY TWO paths:
//     GET  {base}/v1/models            (discovery — Phase 3)
//     POST {base}/v1/chat/completions  (non-streaming inference — Phase 4)
// The base URL comes from LOCAL CONFIG ONLY — never from the cloud, never
// from any frame (AD-5). No other path exists; no redirects are followed;
// responses are size-capped and strictly validated; nothing is ever written
// to the filesystem; nothing is executed. Phase 4 inference is ALWAYS
// non-streaming: `stream:false` is hardcoded in the request body — no
// frame field can change it (chat.delta is Phase 5).
// ======================================================

const DEFAULT_TIMEOUT_MS = 8 * 1000;
const DEFAULT_CHAT_TIMEOUT_MS = 180 * 1000; // §5: the chat window
const MAX_RESPONSE_BYTES = 512 * 1024; // discovery payloads are tiny; hard cap
const MAX_CHAT_RESPONSE_BYTES = 1024 * 1024; // inference payload cap (1 MB)
const MAX_ERROR_BODY_BYTES = 4 * 1024; // classification only, never echoed
const MAX_MODELS = 256;
const MAX_MODEL_ID_LENGTH = 512; // mirrors the cloud-side heartbeat/discovery cap
const MAX_FINISH_REASON_LENGTH = 64;
const OPENAI_MODELS_PATH = '/v1/models'; // discovery — the only GET path
const OPENAI_CHAT_PATH = '/v1/chat/completions'; // inference — the only POST path

/** True when the base URL is loopback (default posture; LAN needs --allow-lan). */
function isLoopbackBase(baseUrl) {
    try {
        const u = new URL(baseUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        return h === 'localhost' || h.endsWith('.localhost') || h === '::1'
            || h === '::ffff:127.0.0.1' || /^127(\.\d+){3}$/.test(h);
    } catch (_) {
        return false;
    }
}

/**
 * Strict validation + normalization of an OpenAI-compatible /v1/models
 * payload into the internal safe format: an array of model-id STRINGS (the
 * exact shape heartbeat models[] and `ai_connectors.models` use).
 * Unknown/unsupported fields (created, owned_by, or anything a runtime adds)
 * are DROPPED by construction — only ids survive. Malformed entries are
 * skipped; the envelope fails closed when `data` is not an array.
 * @returns {{ok:true, models:string[]}|{ok:false}}
 */
function normalizeOpenAiModels(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false };
    if (!Array.isArray(json.data)) return { ok: false };
    const models = [];
    for (const entry of json.data) {
        if (models.length >= MAX_MODELS) break;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        if (typeof entry.id !== 'string') continue;
        const id = entry.id.trim();
        if (id.length === 0 || id.length > MAX_MODEL_ID_LENGTH) continue;
        if (/[\u0000-\u001f\u007f]/.test(id)) continue; // hostile ids never cross the WS
        if (models.includes(id)) continue;
        models.push(id);
    }
    return { ok: true, models };
}

/**
 * Strict validation + normalization of an OpenAI-compatible
 * /v1/chat/completions payload into the internal safe shape. Only the
 * documented fields survive: content (string), finish_reason (short
 * string) and the three integer usage counters. Everything a runtime adds
 * (id, created, system_fingerprint, logprobs, service_tier, …) is DROPPED
 * by construction. Malformed envelopes fail closed with bad_response.
 * @returns {{ok:true, content:string, finishReason:string|undefined,
 *            usage:object|undefined}
 *           |{ok:false}}
 */
function normalizeOpenAiChatCompletion(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false };
    if (!Array.isArray(json.choices) || json.choices.length === 0) return { ok: false };
    const first = json.choices[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) return { ok: false };
    if (!first.message || typeof first.message !== 'object' || Array.isArray(first.message)) return { ok: false };
    if (typeof first.message.content !== 'string') return { ok: false };
    const out = { ok: true, content: first.message.content };
    if (typeof first.finish_reason === 'string'
        && first.finish_reason.length > 0
        && first.finish_reason.length <= MAX_FINISH_REASON_LENGTH
        && !/[\u0000-\u001f\u007f]/.test(first.finish_reason)) {
        out.finishReason = first.finish_reason;
    }
    const u = json.usage;
    if (u && typeof u === 'object' && !Array.isArray(u)) {
        const usage = {};
        let any = false;
        for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
            const v = u[key];
            if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
                usage[key] = Math.min(Math.round(v), 1e9);
                any = true;
            }
        }
        if (any) out.usage = usage;
    }
    return out;
}

/** Context-overflow markers across the V1 runtimes (classification only). */
const CONTEXT_OVERFLOW_RE = /context (length|window|size)|too many tokens|maximum context|context_length_exceed/i;

/**
 * Map a non-OK runtime HTTP answer to a sanitized code. The body (when
 * read, capped at MAX_ERROR_BODY_BYTES) is used ONLY for classification —
 * it is never returned, never logged, never echoed (§4 error discipline).
 */
async function classifyChatHttpError(res, controller) {
    if (res.status === 404) return 'model_not_found';
    if (res.status === 400) {
        // Read a small slice of the body for context-overflow detection.
        try {
            let text = '';
            if (res.body && typeof res.body.getReader === 'function') {
                const reader = res.body.getReader();
                let size = 0;
                const chunks = [];
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > MAX_ERROR_BODY_BYTES) break;
                    chunks.push(Buffer.from(value));
                }
                try { reader.cancel().catch(() => {}); } catch (_) {}
                text = Buffer.concat(chunks).toString('utf8');
            } else {
                text = await res.text();
                if (Buffer.byteLength(text) > MAX_ERROR_BODY_BYTES) text = text.slice(0, MAX_ERROR_BODY_BYTES);
            }
            if (CONTEXT_OVERFLOW_RE.test(text)) return 'context_length';
        } catch (_) {
            if (controller.signal.aborted) return 'timeout';
        }
    }
    return 'runtime_error';
}

/**
 * Size-capped body read shared by discovery and inference. Aborts the
 * fetch the moment the body exceeds `maxBytes` (never buffers unbounded).
 * @returns {Promise<string|{tooLarge:true}|{aborted:true}|{failed:true}>}
 */
async function readCappedBody(res, controller, maxBytes) {
    let text;
    try {
        let size = 0;
        const chunks = [];
        const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
        if (reader) {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > maxBytes) {
                    controller.abort();
                    return { tooLarge: true };
                }
                chunks.push(Buffer.from(value));
            }
            text = Buffer.concat(chunks).toString('utf8');
        } else {
            // Mock/injected response without a stream body.
            text = await res.text();
            if (Buffer.byteLength(text) > maxBytes) {
                return { tooLarge: true };
            }
        }
        return text;
    } catch (_) {
        if (controller.signal.aborted) return { aborted: true };
        return { failed: true };
    }
}

/**
 * Non-streaming chat completion — the ONLY V1 inference operation
 * (Phase 4). Exactly one URL is ever built here: {local base}/v1/chat/
 * completions, method POST, `stream:false` HARDCODED in the body — no
 * caller (and no frame field) can make this adapter stream, redirect,
 * or hit any other path or host (AD-5, master invariant §10.1).
 *
 * @param {object} opts
 * @param {string} opts.baseUrl - local runtime base (config-only, loopback by default)
 * @param {string} opts.model - validated model id
 * @param {Array<{role:string, content:string}>} opts.messages - validated messages
 * @param {number} [opts.maxTokens] - optional generation cap
 * @param {number} [opts.temperature] - optional generation parameter
 * @param {number} [opts.timeoutMs] - inference timeout (default 180 s)
 * @param {number} [opts.maxResponseBytes]
 * @param {Function} [opts.fetchImpl] - injectable for tests
 * @param {AbortSignal} [opts.signal] - external cancellation (chat.cancel):
 *        aborting it resolves with code 'cancelled'.
 * @returns {Promise<{ok:true, content:string, finishReason:string|undefined,
 *                    usage:object|undefined, rawBytes:number}
 *                 |{ok:false, code:string, message:string}>}
 *          Codes (fixed sanitized set): cancelled | timeout |
 *          runtime_unreachable | model_not_found | context_length |
 *          runtime_error | bad_response | response_too_large
 */
async function chatCompletion({
    baseUrl,
    model,
    messages,
    maxTokens = null,
    temperature = null,
    timeoutMs = DEFAULT_CHAT_TIMEOUT_MS,
    maxResponseBytes = MAX_CHAT_RESPONSE_BYTES,
    fetchImpl = globalThis.fetch,
    signal = null,
} = {}) {
    // Exactly one URL is ever built here — from local config, fixed path.
    let url;
    try {
        const base = new URL(String(baseUrl));
        if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('scheme');
        url = new URL(OPENAI_CHAT_PATH, base);
    } catch (_) {
        return { ok: false, code: 'runtime_error', message: 'invalid runtime base URL (local config)' };
    }

    // stream:false is enforced BY CONSTRUCTION — the caller cannot turn a
    // Phase-4 completion into a stream (chat.delta does not exist here).
    const body = { model, messages, stream: false };
    if (maxTokens != null) body.max_tokens = maxTokens;
    if (temperature != null) body.temperature = temperature;

    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    // External cancellation (chat.cancel from the session layer).
    const onExternalAbort = () => {
        cancelled = true;
        controller.abort();
    };
    if (signal) {
        if (signal.aborted) {
            cancelled = true;
            controller.abort();
        } else {
            signal.addEventListener('abort', onExternalAbort, { once: true });
        }
    }
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, Math.max(1, Number(timeoutMs) || DEFAULT_CHAT_TIMEOUT_MS));

    try {
        let res;
        try {
            // redirect:'error' — a redirecting runtime is a misbehaving
            // runtime, never a target to follow (no URL rewriting, ever).
            res = await fetchImpl(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify(body),
                redirect: 'error',
                signal: controller.signal,
            });
        } catch (err) {
            if (cancelled) return { ok: false, code: 'cancelled', message: 'request cancelled' };
            if (timedOut) return { ok: false, code: 'timeout', message: 'runtime request timed out' };
            // Node fetch surfaces connection failures (refused, DNS, reset)
            // as TypeError; anything else is treated as an unreachable runtime.
            return { ok: false, code: 'runtime_unreachable', message: 'runtime not reachable' };
        }

        if (!res.ok) {
            const code = await classifyChatHttpError(res, controller);
            return { ok: false, code, message: `runtime rejected the request (${code})` };
        }

        const text = await readCappedBody(res, controller, maxResponseBytes);
        if (text && text.tooLarge) {
            return { ok: false, code: 'response_too_large', message: 'runtime response exceeded size limit' };
        }
        if (text && text.aborted) {
            if (cancelled) return { ok: false, code: 'cancelled', message: 'request cancelled' };
            return { ok: false, code: 'timeout', message: 'runtime request timed out' };
        }
        if (text && text.failed) {
            if (cancelled) return { ok: false, code: 'cancelled', message: 'request cancelled' };
            return { ok: false, code: 'runtime_unreachable', message: 'runtime response failed' };
        }

        let json;
        try {
            json = JSON.parse(text);
        } catch (_) {
            return { ok: false, code: 'bad_response', message: 'runtime response is not valid JSON' };
        }
        const normalized = normalizeOpenAiChatCompletion(json);
        if (!normalized.ok) {
            return { ok: false, code: 'bad_response', message: 'runtime response failed validation' };
        }
        return {
            ok: true,
            content: normalized.content,
            finishReason: normalized.finishReason,
            usage: normalized.usage,
            rawBytes: Buffer.byteLength(text),
        };
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onExternalAbort);
    }
}

/**
 * Model discovery — the Phase-3 operation (explicit refresh only, AD-7).
 * @param {object} opts
 * @param {string} opts.baseUrl - local runtime base (config-only, loopback by default)
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxResponseBytes]
 * @param {Function} [opts.fetchImpl] - injectable for tests
 * @returns {Promise<{ok:true, models:string[], rawBytes:number}
 *                 |{ok:false, code:string, message:string}>}
 *          Codes (fixed sanitized set): timeout | runtime_unreachable |
 *          bad_response | runtime_error | response_too_large
 */
async function discoverModels({
    baseUrl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = MAX_RESPONSE_BYTES,
    fetchImpl = globalThis.fetch,
} = {}) {
    // Exactly one URL is ever built here — from local config, fixed path.
    let url;
    try {
        const base = new URL(String(baseUrl));
        if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('scheme');
        url = new URL(OPENAI_MODELS_PATH, base);
    } catch (_) {
        return { ok: false, code: 'runtime_error', message: 'invalid runtime base URL (local config)' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    let res;
    try {
        // redirect:'error' — a redirecting runtime is a misbehaving runtime,
        // never a target to follow (no URL rewriting, ever).
        res = await fetchImpl(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            redirect: 'error',
            signal: controller.signal,
        });
    } catch (err) {
        clearTimeout(timer);
        if (controller.signal.aborted) {
            return { ok: false, code: 'timeout', message: 'runtime request timed out' };
        }
        // Node fetch surfaces connection failures (refused, DNS, reset) as
        // TypeError; anything else is treated as an unreachable runtime.
        return { ok: false, code: 'runtime_unreachable', message: 'runtime not reachable' };
    }

    try {
        if (!res.ok) {
            return { ok: false, code: 'runtime_error', message: `runtime returned HTTP ${res.status}` };
        }
        let text;
        try {
            // Size-capped read: abort the moment the body exceeds the cap.
            let size = 0;
            const chunks = [];
            const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
            if (reader) {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > maxResponseBytes) {
                        controller.abort();
                        return { ok: false, code: 'response_too_large', message: 'runtime response exceeded size limit' };
                    }
                    chunks.push(Buffer.from(value));
                }
                text = Buffer.concat(chunks).toString('utf8');
            } else {
                // Mock/injected response without a stream body.
                text = await res.text();
                if (Buffer.byteLength(text) > maxResponseBytes) {
                    return { ok: false, code: 'response_too_large', message: 'runtime response exceeded size limit' };
                }
            }
        } catch (err) {
            clearTimeout(timer);
            if (controller.signal.aborted) {
                return { ok: false, code: 'timeout', message: 'runtime request timed out' };
            }
            return { ok: false, code: 'runtime_unreachable', message: 'runtime response failed' };
        }
        let json;
        try {
            json = JSON.parse(text);
        } catch (_) {
            return { ok: false, code: 'bad_response', message: 'runtime response is not valid JSON' };
        }
        const normalized = normalizeOpenAiModels(json);
        if (!normalized.ok) {
            return { ok: false, code: 'bad_response', message: 'runtime response failed validation' };
        }
        return { ok: true, models: normalized.models, rawBytes: Buffer.byteLength(text) };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    discoverModels,
    chatCompletion,
    normalizeOpenAiModels,
    normalizeOpenAiChatCompletion,
    isLoopbackBase,
    OPENAI_MODELS_PATH,
    OPENAI_CHAT_PATH,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_CHAT_TIMEOUT_MS,
    MAX_RESPONSE_BYTES,
    MAX_CHAT_RESPONSE_BYTES,
    MAX_MODELS,
    MAX_MODEL_ID_LENGTH,
};
