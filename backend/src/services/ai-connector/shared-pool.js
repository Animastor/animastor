// ======================================================
// LLM Sharing — shared pool resolver seam (SH-AI-2/SH-AI-3)
// Phase 1 Control Plane + Phase 2 Consumer Inference
// ======================================================
// The architectural seam between the AI consumer abstraction and a future
// distributed pool scheduler (docs/04-planning/llm-sharing-phase1-control-
// plane.md, docs/04-planning/llm-sharing-phase2-consumer-inference.md):
//
//   resolveSharedAI({ workspaceId, purpose, model })   (Phase 1 — acquires)
//   selectSharedAI({ workspaceId, purpose, model })    (Phase 2 — slotless)
//        ↓ eligible shared endpoints        (repo.listSharedEndpoints)
//        ↓ availability / policy filtering (THIS module)
//        ↓ selected endpoint                (deterministic V1 selector)
//        ↓ connector transport              (existing ai-connector/transport
//                                            via runSharedInference —
//                                            per-inference slot lifecycle)
//
// PHASE 2 CONSUMER FLOW (the wired resolver chain):
//
//   workspace_ai_providers → resolver → private local connector OR shared
//   endpoint → SAME connector transport
//
// resolveAIForWorkspace consults selectSharedAI() as resolver stage 2 (after
// the workspace provider, before the gated system fallback — sharing doc
// §6.2). The shared snapshot is NEVER cached (it is resolved per request);
// the concurrency slot is reserved PER INFERENCE by the transport branch
// (runSharedInference / reserveSharedInference + releaseSharedAI) — so a
// snapshot reused by an agent pipeline accounts each completion exactly.
//
// SEAM CONTRACT (the whole point of Phase 1): the consumer keeps working
// through the EXISTING AI abstraction —
//
//   workspace_ai_providers → resolver → private local connector OR shared
//   endpoint → SAME connector transport
//
// A consumer NEVER knows whether a resource is a cloud provider, a private
// local connector or a shared local connector — that difference lives HERE
// and in the transport layer. The returned snapshot is the SAME connector
// snapshot shape the private path produces (transport:'connector',
// endpoint:null, apiKey:null) plus a `shared` marker and the selected
// model — callAI / resolveChatAI / the agent pipeline need ZERO changes to
// consume it.
//
// Selection (V1): deterministic "first eligible endpoint" — ordered by
// endpoint created_at ASC, endpoint_id ASC (stable tie-break). NO load
// balancing, NO scoring, NO capability matching (deferred by design). The
// selector is ONE function so a future pool scheduler can replace it
// without touching the Connector/Provider architecture.
//
// Eligibility (ALL must hold — the brief's minimum):
//   1. sharing enabled        — policy.enabled TRUE (repo filter)
//   2. endpoint enabled       — owner availability switch TRUE (repo filter)
//   3. connector live         — registry.isLive (the AUTHORITATIVE WS
//                                liveness, LAC §7 — PG status is a stale
//                                trace and is NEVER consulted here)
//   4. connector not revoked  — (repo filter)
//   5. workspace eligibility  — V1 'public' access mode: any AUTHENTICATED
//                              workspace EXCEPT the owner's own (the owner
//                              resolves through their own provider binding —
//                              D3, owner traffic never traverses the pool)
//   6. runtime reachable      — heartbeat runtime_ok (fail-honest: unknown →
//                              treated unreachable; discovered ≠ loaded, §7)
//   7. model availability     — the selected model MUST be in the connector's
//                              discovered models list. Precedence:
//                                a) requestedModel (if present in discovered)
//                                b) endpoint.model  (if present in discovered)
//                                c) first discovered model
//                              If none of these are in discovered → 'no_models'
//   8. concurrency available  — in-process per-endpoint slot counter against
//                              policy.concurrency_limit (Phase 1 seam — a
//                              simple gate, not a scheduler)
//
// SECURITY BOUNDARY (unchanged by sharing): the snapshot carries NO runtime
// URL, NO credentials, NO registration tokens — the consumer never learns
// the owner's runtime URL or any connector secret; inference keeps riding
// Cloud → registered connector WS → local runtime (AD-5 intact).
// ======================================================

const registry = require('../../services/ai-connector/registry');
const endpointRepo = require('../../storage/postgres/repositories/ai-endpoint-repo');
// Per-endpoint in-process slot counters (endpoint_id → current in-flight
// count). Phase 1 seam: a gate, not a queue — overflow means "not eligible
// right now", never a wait. Reset when the counter would go negative; a
// backend restart clears the map (fail-safe: a leaked slot can only make
// the pool MORE conservative until restart).
const inflight = new Map();

function inflightCount(endpointId) {
    return inflight.get(endpointId) || 0;
}

function acquireSlot(endpointId) {
    inflight.set(endpointId, inflightCount(endpointId) + 1);
}

function releaseSlot(endpointId) {
    const next = inflightCount(endpointId) - 1;
    if (next <= 0) inflight.delete(endpointId);
    else inflight.set(endpointId, next);
}

/** Test/ops seam. */
function stats() {
    return { inflight: Object.fromEntries(inflight) };
}

function resetForTests() {
    inflight.clear();
}

/**
 * The deterministic V1 selector: first eligible endpoint in the repo's
 * stable (created_at ASC, endpoint_id ASC) order. ONE function to replace
 * with a pool scheduler later — everything else stays untouched.
 * @param {Array} candidates - pre-filtered eligible entries
 * @returns {object|null}
 */
function selectEndpoint(candidates) {
    return candidates.length > 0 ? candidates[0] : null;
}

/**
 * Pick the model a shared request should run on.
 *
 * STRICT eligibility (no-registry principle — §7): the selected model
 * MUST be present in the connector's discovered models list. A model
 * that is not in the discovered list is never returned — even if the
 * consumer requested it or the endpoint has it configured.
 *
 * Precedence:
 *   1. requestedModel — only if it exists in discovered
 *   2. endpoint.model — only if it exists in discovered
 *   3. first discovered model
 *
 * Returns null when no usable model exists in the discovered list.
 */
function selectModel(entry, requestedModel) {
    const discovered = Array.isArray(entry.connector.models) ? entry.connector.models : [];
    const discoveredSet = new Set(discovered.map(String));
    if (discoveredSet.size === 0) return null;

    // (a) explicitly requested model — only if present in discovered
    if (requestedModel && typeof requestedModel === 'string' && requestedModel.trim()) {
        const trimmed = requestedModel.trim();
        if (discoveredSet.has(trimmed)) return trimmed;
        // requested model NOT in discovered — fall through, but will return null
        // unless a later candidate has it. This candidate is NOT eligible for
        // this requested model.
        return null;
    }
    // (b) endpoint's configured model — only if present in discovered
    const configured = entry.endpoint.model;
    if (configured && typeof configured === 'string' && configured.trim()) {
        const trimmed = configured.trim();
        if (discoveredSet.has(trimmed)) return trimmed;
    }
    // (c) first discovered model (always safe — already in the set)
    return String(discovered[0]);
}

/**
 * Full eligibility filter for one candidate entry.
 * The repo already applied: policy.enabled, endpoint.enabled, not deleted,
 * connector not revoked. This adds the in-process gates.
 *
 * Model eligibility is STRICT: selectModel() only returns a model present in
 * connector.models; if no such model exists, the candidate is rejected with
 * 'no_models' (an endpoint whose configured model is no longer discovered is
 * NOT eligible — the consumer must not receive a model the runtime cannot load).
 *
 * @returns {{eligible:boolean, reason?:string}}
 */
function checkEligibility(entry, { workspaceId, requestedModel }) {
    // (5) V1 'public' sharing serves any authenticated workspace EXCEPT the
    // owner's own — the owner's traffic resolves through their private
    // binding (D3: owner traffic never traverses the pool).
    if (!workspaceId) return { eligible: false, reason: 'no_workspace' };
    if (entry.endpoint.workspace_id === workspaceId) {
        return { eligible: false, reason: 'own_endpoint' };
    }
    // (3) connector liveness — the AUTHORITATIVE live WS session.
    if (!registry.isLive(entry.endpoint.connector_id)) {
        return { eligible: false, reason: 'connector_offline' };
    }
    // (6) runtime reachable — heartbeat runtime_ok; unknown → unreachable
    // (fail honest, never optimistic).
    const runtimeOk = !!(entry.connector.runtime_meta
        && entry.connector.runtime_meta.runtime_ok === true);
    if (!runtimeOk) {
        return { eligible: false, reason: 'runtime_unreachable' };
    }
    // (7) model availability — at least one usable model must exist.
    const model = selectModel(entry, requestedModel);
    if (!model) {
        return { eligible: false, reason: 'no_models' };
    }
    // (8) concurrency availability against the policy limit.
    const limit = Number(entry.policy.concurrency_limit) || 1;
    if (inflightCount(entry.endpoint.endpoint_id) >= limit) {
        return { eligible: false, reason: 'busy' };
    }
    return { eligible: true };
}

/**
 * resolveSharedAI — the Phase 1 seam. Resolve one eligible shared endpoint
 * for a consumer request and return a CONSUMER-IDENTICAL connector snapshot
 * (the same shape buildConnectorProvider produces) plus sharing metadata.
 * The returned snapshot holds ONE concurrency slot; the caller MUST call
 * releaseSharedAI(snapshot) when done (or use withSharedAI below).
 *
 * Phase 2 note: the WIRED consumer flow (resolver stage → per-inference
 * reservation) uses selectSharedAI + runSharedInference instead — a
 * resolution-held slot cannot survive the 30s resolver cache or an agent
 * pipeline reusing one snapshot for many calls. The eligibility ladder is
 * SHARED between both entries (one implementation, §6 doc).
 *
 * Returns null when nothing is eligible — the CALLER decides the fallback
 * chain.
 *
 * The model in the snapshot is always present in the endpoint's discovered
 * models list — a strict contract that prevents the runtime from ever
 * receiving a model it cannot load.
 *
 * @param {{workspaceId:string, purpose?:string, model?:string|null}} request
 * @returns {Promise<{source:'shared', transport:'connector', provider:'local-ai',
 *                     shared:{endpointId:string, endpointName:string, ownerWorkspaceId:string,
 *                             concurrencyLimit:number},
 *                     connectorId:string, endpoint:null, apiKey:null,
 *                     model:string, workspaceId:string, purpose?:string}|null>}
 */
async function resolveSharedAI(request = {}) {
    const snapshot = await selectSharedAI(request);
    if (!snapshot) return null;
    acquireSlot(snapshot.shared.endpointId);
    return snapshot;
}

/** Release the concurrency slot of a resolved shared snapshot. Safe always. */
function releaseSharedAI(snapshot) {
    if (snapshot && snapshot.shared && snapshot.shared.endpointId) {
        releaseSlot(snapshot.shared.endpointId);
    }
}

// ── Phase 2 — consumer inference (SH-AI-3) ───────────────────────────────
// The consumer wiring (docs/04-planning/llm-sharing-phase2-consumer-
// inference.md) needs a PER-REQUEST selection without a lingering slot and
// a PER-INFERENCE reservation, so an agent pipeline (ONE snapshot, MANY
// sequential/parallel callAI calls) accounts every in-flight completion
// against the owner's concurrency_limit exactly.

/**
 * Select an eligible shared endpoint WITHOUT acquiring a slot. Identical
 * eligibility ladder to resolveSharedAI (sharing on, endpoint on, connector
 * live, not revoked, non-owner workspace, runtime_ok, model available in
 * discovered, concurrency slot available) — the only difference is that the
 * slot is NOT held: the returned snapshot is a selection ("plan"), and the
 * caller reserves capacity per inference via reserveSharedInference().
 *
 * @returns {Promise<object|null>} the same consumer snapshot shape
 *   resolveSharedAI produces (transport:'connector', endpoint:null,
 *   apiKey:null, shared:{endpointId, endpointName, ownerWorkspaceId,
 *   concurrencyLimit}) plus the selected model — or null.
 */
async function selectSharedAI({ workspaceId, purpose, model } = {}) {
    const candidates = await endpointRepo.listSharedEndpoints();
    for (const entry of candidates) {
        const check = checkEligibility(entry, { workspaceId, requestedModel: model });
        if (!check.eligible) continue;
        const selected = selectEndpoint([entry]);
        if (!selected) continue;
        const chosenModel = selectModel(selected, model);
        return {
            source: 'shared',
            transport: 'connector',
            provider: 'local-ai',
            shared: {
                endpointId: selected.endpoint.endpoint_id,
                endpointName: selected.endpoint.name,
                ownerWorkspaceId: selected.endpoint.workspace_id,
                // Owner policy limit — needed by reserveSharedInference so an
                // inference can re-check capacity at request time. Owner-
                // independent metadata (no secret, no URL, no credential).
                concurrencyLimit: Number(selected.policy.concurrency_limit) || 1,
            },
            connectorId: selected.endpoint.connector_id,
            endpoint: null, // NEVER a runtime URL — AD-5 boundary intact
            apiKey: null,   // NEVER credentials — consumer gets nothing secret
            model: chosenModel,
            workspaceId: workspaceId,
            ...(purpose ? { purpose } : {}),
        };
    }
    return null;
}

/**
 * Per-inference reservation over an already-selected shared snapshot
 * (selectSharedAI output). Checks the owner's concurrency limit and
 * acquires one slot — call releaseSharedAI(snapshot) in a finally to
 * release. A no-op "ok" for any NON-shared snapshot (private connector /
 * cloud provider), so the transport branches can wrap every connector
 * inference with the same reserve/release guard.
 *
 * @returns {{ok:true}|{ok:false, code:'busy'|'invalid'}}
 */
function reserveSharedInference(snapshot) {
    if (!snapshot || !snapshot.shared || !snapshot.shared.endpointId) {
        // Not a shared snapshot — nothing to reserve (private/cloud path).
        return { ok: true };
    }
    if (snapshot.transport !== 'connector' || !snapshot.connectorId) {
        return { ok: false, code: 'invalid' };
    }
    const limit = Number(snapshot.shared.concurrencyLimit) || 1;
    if (inflightCount(snapshot.shared.endpointId) >= limit) {
        return { ok: false, code: 'busy' };
    }
    acquireSlot(snapshot.shared.endpointId);
    return { ok: true };
}

/** True when the snapshot came from the shared pool (selection or reservation). */
function isSharedSnapshot(snapshot) {
    return !!(snapshot && snapshot.source === 'shared' && snapshot.shared && snapshot.shared.endpointId);
}

// Sanitized, fixed strings for the Phase 2 shared-specific codes (same
// discipline as transport.SANITIZED_MESSAGES — never raw runtime detail).
const SHARED_MESSAGES = {
    shared_unavailable: 'Shared AI is not available right now',
};

/**
 * User-facing description of a shared-inference failure code: shared-pool
 * codes first, then the connector transport codes. Sanitized by construction.
 */
function describeSharedError(code) {
    if (SHARED_MESSAGES[code]) return SHARED_MESSAGES[code];
    const { describeConnectorError } = require('./transport');
    return describeConnectorError(code);
}

/**
 * Run ONE chat completion over a connector snapshot with the correct
 * reservation lifecycle — the ONLY inference entry the connector-transport
 * consumer branches use (callAI / resolveChatAI / streaming):
 *
 *   - SHARED snapshot  → reserve the slot (busy → sanitized busy), call the
 *     connector transport, ALWAYS release — success, connector error,
 *     timeout, cancellation and session disconnect all settle connectorChat
 *     and fall through the same finally. The pool cannot leak a slot.
 *   - PRIVATE snapshot (workspace local-ai binding) → direct transport, NO
 *     pool interaction (the private path behaves exactly as before Phase 2).
 *
 * Rides the existing ai-connector/transport — no new protocol, no direct
 * cloud→runtime fetch (AD-5 intact). Streaming when opts.onDelta is present.
 *
 * @param {object} snapshot - a connector snapshot (workspace binding or
 *        selectSharedAI() output). Null/invalid → shared_unavailable.
 * @param {object} payload - { model, messages, params:{max_tokens, temperature} }
 * @param {object} [opts] - { timeoutMs, onDelta, signal, logger } passed
 *        through to transport.connectorChat (onDelta switches to streaming).
 * @returns {Promise<{ok:true, content, finishReason?, usage?, model, requestId,
 *                    shared?:{endpointId, endpointName}}
 *                  |{ok:false, code, message, partial?}>}
 */
async function runSharedInference(snapshot, payload, opts = {}) {
    const { connectorChat } = require('./transport');
    const transportOpts = {
        timeoutMs: opts.timeoutMs,
        onDelta: opts.onDelta,
        signal: opts.signal,
        logger: opts.logger,
    };
    if (!isSharedSnapshot(snapshot)) {
        if (!snapshot || !snapshot.connectorId) {
            return { ok: false, code: 'shared_unavailable', message: SHARED_MESSAGES.shared_unavailable };
        }
        // Private connector binding — unchanged Phase 1..7 behavior.
        return connectorChat(snapshot.connectorId, payload, transportOpts);
    }
    const reservation = reserveSharedInference(snapshot);
    if (!reservation.ok) {
        const code = reservation.code === 'busy' ? 'busy' : 'shared_unavailable';
        return { ok: false, code, message: describeSharedError(code) };
    }
    try {
        const result = await connectorChat(snapshot.connectorId, payload, transportOpts);
        if (result.ok) {
            // Provenance for the consumer surface: which shared endpoint
            // served (safe fields only — never a runtime URL, never
            // credential material).
            result.shared = { endpointId: snapshot.shared.endpointId, endpointName: snapshot.shared.endpointName };
        }
        return result;
    } finally {
        releaseSharedAI(snapshot);
    }
}

/**
 * Scoped helper: resolve, run `fn(snapshot)`, always release. The consumer
 * path never has to remember the release.
 */
async function withSharedAI(request, fn) {
    const snapshot = await resolveSharedAI(request);
    if (!snapshot) return null;
    try {
        return await fn(snapshot);
    } finally {
        releaseSharedAI(snapshot);
    }
}

module.exports = {
    resolveSharedAI,
    releaseSharedAI,
    withSharedAI,
    selectSharedAI,
    reserveSharedInference,
    isSharedSnapshot,
    runSharedInference,
    describeSharedError,
    SHARED_MESSAGES,
    selectEndpoint,
    selectModel,
    checkEligibility,
    stats,
    resetForTests,
};
