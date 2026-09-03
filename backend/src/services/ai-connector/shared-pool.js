// ======================================================
// LLM Sharing — shared pool resolver seam (SH-AI-2 — Phase 1 Control Plane)
// ======================================================
// The architectural seam between the AI consumer abstraction and a future
// distributed pool scheduler (docs/04-planning/llm-sharing-phase1-control-plane.md):
//
//   resolveSharedAI({ workspaceId, purpose, model })
//        ↓ eligible shared endpoints        (repo.listSharedEndpoints)
//        ↓ availability / policy filtering (THIS module)
//        ↓ selected endpoint                (deterministic V1 selector)
//        ↓ connector transport              (existing ai-connector/transport)
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
//   7. model availability     — the requested model is in the connector's
//                              DISCOVERED models list (fallback: endpoint's
//                              configured model, else first discovered)
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
 * Pick the model a shared request should run on (the no-registry principle:
 * model stays a free string — discovered ids are only a hint, §7).
 * Precedence: explicitly requested model → endpoint's configured model →
 * first discovered model. Returns null when nothing usable exists.
 */
function selectModel(entry, requestedModel) {
    if (requestedModel && typeof requestedModel === 'string' && requestedModel.trim()) {
        return requestedModel.trim();
    }
    const configured = entry.endpoint.model;
    if (configured && typeof configured === 'string' && configured.trim()) {
        return configured.trim();
    }
    const discovered = Array.isArray(entry.connector.models) ? entry.connector.models : [];
    return discovered.length > 0 ? String(discovered[0]) : null;
}

/**
 * Full eligibility filter for one candidate entry.
 * The repo already applied: policy.enabled, endpoint.enabled, not deleted,
 * connector not revoked. This adds the in-process gates.
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
 *
 * Returns null when nothing is eligible — the CALLER decides the fallback
 * chain (Phase 1 does NOT wire this into resolveAIForWorkspace yet; the
 * consumer-side shared discovery is a later phase by design).
 *
 * The returned snapshot acquires one concurrency slot; the caller MUST call
 * releaseSharedAI(snapshot) when done (or use withSharedAI below). Failing
 * to release only makes the pool conservative, never broken.
 *
 * @param {{workspaceId:string, purpose?:string, model?:string|null}} request
 * @returns {Promise<{source:'shared', transport:'connector', provider:'local-ai',
 *                     shared:{endpointId:string, endpointName:string, ownerWorkspaceId:string},
 *                     connectorId:string, endpoint:null, apiKey:null,
 *                     model:string, workspaceId:string, purpose?:string}|null>}
 */
async function resolveSharedAI({ workspaceId, purpose, model } = {}) {
    const candidates = await endpointRepo.listSharedEndpoints();
    for (const entry of candidates) {
        const check = checkEligibility(entry, { workspaceId, requestedModel: model });
        if (!check.eligible) continue;
        const selected = selectEndpoint([entry]);
        if (!selected) continue;
        const chosenModel = selectModel(selected, model);
        acquireSlot(selected.endpoint.endpoint_id);
        return {
            source: 'shared',
            transport: 'connector',
            provider: 'local-ai',
            shared: {
                endpointId: selected.endpoint.endpoint_id,
                endpointName: selected.endpoint.name,
                ownerWorkspaceId: selected.endpoint.workspace_id,
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

/** Release the concurrency slot of a resolved shared snapshot. Safe always. */
function releaseSharedAI(snapshot) {
    if (snapshot && snapshot.shared && snapshot.shared.endpointId) {
        releaseSlot(snapshot.shared.endpointId);
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
    selectEndpoint,
    selectModel,
    checkEligibility,
    stats,
    resetForTests,
};
