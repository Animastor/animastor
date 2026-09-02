// ======================================================
// LLM Connector discovery service (LAC-3 — Local AI Connector V1 Phase 3)
// ======================================================
// Explicit model discovery over the established WS session (§4):
//
//   S→C  models.refresh {}        — cloud asks the LIVE connector to inspect
//                                   its local runtime (the connector — never
//                                   the cloud — fetches GET {base}/v1/models
//                                   through its runtime adapter, AD-5).
//   C→S  models.list { models[] } — normalized model-id strings; the same
//                                   safe shape heartbeat models[] uses. An
//                                   optional sanitized `error_code` (fixed
//                                   allowlist) reports a failed discovery.
//
// Guarantees (Phase 3):
//   - explicit refresh only: no polling, no automatic runtime requests;
//   - concurrent refresh callers COALESCE onto one in-flight refresh per
//     live session — no fan-out to the connector or the local runtime;
//   - no response → sanitized timeout; late or unsolicited models.list
//     frames are ignored safely (never persisted, never crash);
//   - pending state is keyed by the live SESSION (not the connector id):
//     a dying socket settles only its own refresh, so a replacement
//     session's in-flight refresh can never be clobbered by the old
//     socket's close event;
//   - persistence goes through the EXISTING heartbeat/state-update path
//     (updateConnectorHeartbeat — models + last_seen/status semantics per
//     §7); a failed discovery never wipes previously stored models and
//     never breaks the authenticated session;
//   - this service is a validation/normalization/persistence layer ONLY —
//     it never issues HTTP requests itself, so nothing on the WS can turn
//     the cloud into a proxy (SSRF posture untouched, §10.2).
// ======================================================

const registry = require('./registry');
const aiConnectorRepo = require('../../storage/postgres/repositories/ai-connector-repo');

const DEFAULTS = {
    refreshTimeoutMs: 10 * 1000, // explicit UI action must not hang long
};

// Sanitized discovery error codes the connector may report (§4 error-surface
// discipline). Anything else — or a malformed frame — degrades to a
// fixed generic code; frame contents are NEVER echoed into logs.
const DISCOVERY_ERROR_CODES = [
    'timeout',
    'runtime_unreachable',
    'bad_response',
    'runtime_error',
    'response_too_large',
];
const GENERIC_DISCOVERY_ERROR = 'discovery_failed';
const SESSION_CLOSED_ERROR = 'session_closed';

// Model normalization limits — identical to the heartbeat sanitizer so both
// paths produce the exact same `ai_connectors.models` shape (string[]).
const MAX_MODELS = 256;
const MAX_MODEL_ID_LENGTH = 512;

// One outstanding refresh per live session: { resolve, timer }.
const pending = new Map(); // Map<session, entry>

function clearTimer(entry) {
    if (entry && entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
    }
}

/** Settle (once) the pending refresh owned by THIS session, if any. */
function settleSession(session, result) {
    const entry = pending.get(session);
    if (!entry) return false;
    pending.delete(session);
    clearTimer(entry);
    entry.resolve(result);
    return true;
}

/**
 * Normalize a models.list frame to the internal safe format (string[] of
 * model ids — the same shape heartbeat models[] uses). Strict per-field,
 * tolerant per-entry: only reasonable strings become model ids; unknown or
 * wrong-typed entries are dropped; the result is capped and de-duplicated.
 * Everything else on the frame — including any url-like field a hostile
 * client might attach — is ignored: this layer reads `models` and
 * `error_code` and NOTHING else (AD-5: no URL ever crosses the protocol).
 * @returns {{ok:true, models:string[]}|{ok:false, code:string}}
 */
function normalizeModelsList(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        return { ok: false, code: 'invalid_models_list' };
    }
    if (typeof msg.error_code === 'string' && msg.error_code.length > 0) {
        return {
            ok: false,
            code: DISCOVERY_ERROR_CODES.includes(msg.error_code) ? msg.error_code : GENERIC_DISCOVERY_ERROR,
        };
    }
    if (!Array.isArray(msg.models)) {
        return { ok: false, code: 'invalid_models_list' };
    }
    const models = [];
    for (const raw of msg.models) {
        if (typeof raw !== 'string') continue;
        const id = raw.trim();
        if (id.length === 0 || id.length > MAX_MODEL_ID_LENGTH) continue;
        if (models.includes(id)) continue; // dedupe — first occurrence wins
        models.push(id);
        if (models.length >= MAX_MODELS) break;
    }
    return { ok: true, models };
}

/**
 * Explicit, user-initiated model discovery for ONE connector (Phase 3 — the
 * only refresh mechanism that exists; never scheduled, never polled).
 *
 * Concurrent callers on the same live session coalesce onto ONE in-flight
 * refresh: exactly one `models.refresh` frame is sent, exactly one local
 * runtime fetch happens, and every caller receives the same result.
 *
 * @returns {Promise<{ok:true, models:string[]}
 *                 |{ok:false, code:'connector_offline'|'timeout'
 *                                |'session_closed'|'invalid_models_list'
 *                                |'persist_failed'|<sanitized discovery code>}>}
 *          Never rejects — callers render sanitized codes.
 */
async function requestModelsRefresh(connectorId, { timeoutMs = DEFAULTS.refreshTimeoutMs } = {}) {
    const session = registry.getLive(connectorId);
    if (!session || !session.ws || session.ws.readyState !== 1) {
        return { ok: false, code: 'connector_offline' };
    }
    const existing = pending.get(session);
    if (existing) return existing.promise; // coalesce — no fan-out

    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    const entry = { promise, resolve, timer: null };
    pending.set(session, entry);
    entry.timer = setTimeout(() => {
        settleSession(session, { ok: false, code: 'timeout' });
    }, Math.max(1, Number(timeoutMs) || DEFAULTS.refreshTimeoutMs));
    if (entry.timer.unref) entry.timer.unref();

    try {
        // The frame carries NO url and NO payload (§4): the connector fetches
        // only its own locally-configured base URL — there is no field a
        // client could set to redirect the runtime call.
        session.ws.send(JSON.stringify({ type: 'models.refresh' }));
    } catch (_) {
        settleSession(session, { ok: false, code: 'connector_offline' });
    }
    return promise;
}

/**
 * Handle an authenticated `models.list` frame arriving on a live session
 * (called from the WS route). Only frames answering a pending refresh on
 * THAT session are processed; everything else is dropped safely. On success
 * the normalized models are persisted via the existing heartbeat/state-update
 * path (models replaced, last_seen stamped — §7 semantics). Discovery
 * failure is reported as a sanitized code and leaves PG state untouched.
 *
 * @returns {Promise<{handled:boolean, result:object}>}
 */
async function handleModelsList(connectorId, msg, { session = null, logger = console } = {}) {
    const entry = session ? pending.get(session) : null;
    if (!entry) {
        // Unsolicited or late reply — no pending refresh: ignore at zero cost.
        return { handled: false, result: null };
    }
    const normalized = normalizeModelsList(msg);
    let result;
    if (normalized.ok) {
        try {
            // Existing heartbeat/state-update path: models replaced,
            // last_seen stamped, status online — identical semantics to a
            // heartbeat carrying models (§7). Explicit user action, so no
            // throttle applies here.
            await aiConnectorRepo.updateConnectorHeartbeat(connectorId, { models: normalized.models });
            result = { ok: true, models: normalized.models };
        } catch (err) {
            logger.warn(`[AI-CONNECTOR] models persist failed (non-fatal): ${err.message}`);
            result = { ok: false, code: 'persist_failed' };
        }
    } else {
        // Sanitized code only — never echo frame contents into logs.
        logger.warn(`[AI-CONNECTOR] discovery failed on connector ${connectorId}: ${normalized.code}`);
        result = normalized;
    }
    const handled = settleSession(session, result);
    return { handled, result };
}

/**
 * Fail any refresh pending on THIS session immediately (socket closed,
 * session replaced, evicted, rotated, revoked) — a dead session must never
 * leave callers waiting for the timeout. Safe to call unconditionally.
 */
function failPendingFor(session) {
    if (!session) return false;
    return settleSession(session, { ok: false, code: SESSION_CLOSED_ERROR });
}

module.exports = {
    requestModelsRefresh,
    handleModelsList,
    failPendingFor,
    normalizeModelsList,
    DISCOVERY_ERROR_CODES,
    GENERIC_DISCOVERY_ERROR,
    DEFAULTS,
    MAX_MODELS,
    MAX_MODEL_ID_LENGTH,
};
