// ======================================================
// Runtime adapter — OpenAI-compatible (LAC-3, Phase 3)
// ======================================================
// The FIRST runtime adapter behind the allowlist seam (AD-5, §3.4, §10.2,
// §6). All four V1 runtimes (Ollama / vLLM / llama.cpp / LM Studio) expose
// this API; `runtime_type` stays a UI label (§6).
//
// The adapter knows EXACTLY ONE operation and EXACTLY ONE path:
//     GET {base}/v1/models
// The base URL comes from LOCAL CONFIG ONLY — never from the cloud, never
// from any frame (AD-5). No other path exists; no redirects are followed;
// responses are size-capped and strictly validated; nothing is ever written
// to the filesystem; nothing is executed. This adapter performs NO inference
// and never touches /v1/chat/completions (AD-7).
// ======================================================

const DEFAULT_TIMEOUT_MS = 8 * 1000;
const MAX_RESPONSE_BYTES = 512 * 1024; // discovery payloads are tiny; hard cap
const MAX_MODELS = 256;
const MAX_MODEL_ID_LENGTH = 512; // mirrors the cloud-side heartbeat/discovery cap
const OPENAI_MODELS_PATH = '/v1/models'; // the only path this adapter ever requests

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
 * Model discovery — the ONLY V1 runtime operation.
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
    normalizeOpenAiModels,
    isLoopbackBase,
    OPENAI_MODELS_PATH,
    DEFAULT_TIMEOUT_MS,
    MAX_RESPONSE_BYTES,
    MAX_MODELS,
    MAX_MODEL_ID_LENGTH,
};
