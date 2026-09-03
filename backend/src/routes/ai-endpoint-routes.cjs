// ======================================================
// ANIMASTOR BACKEND — AI ENDPOINT (SHARING CONTROL PLANE) ROUTES
// ======================================================
// LLM Sharing Phase 1 — Control Plane (SH-AI-1)
// (docs/04-planning/llm-sharing-phase1-control-plane.md)
//
// Workspace-OWNER API for the lifecycle of shareable inference endpoints:
//
//   POST   /api/v1/ai-endpoints                 — create (Private by default)
//   GET    /api/v1/ai-endpoints                 — list own endpoints
//   GET    /api/v1/ai-endpoints/:endpointId     — own detail (404 otherwise)
//   PATCH  /api/v1/ai-endpoints/:endpointId     — update name/model/desc/enabled
//   DELETE /api/v1/ai-endpoints/:endpointId     — soft delete
//   POST   /api/v1/ai-endpoints/:endpointId/share  — enable sharing (Shared)
//   DELETE /api/v1/ai-endpoints/:endpointId/share  — disable sharing (Private)
//
// Identity rules (worker-routes / ai-connector-routes discipline verbatim):
//   - REGISTERED USERS ONLY (guest workspaces are ephemeral and must never
//     own shareable long-lived resources);
//   - workspace_id ALWAYS from req.workspace — never from the body;
//   - foreign/unknown/revoked/soft-deleted ids → ONE INDISTINGUISHABLE 404
//     (no cross-workspace existence oracle);
//   - NEVER returns credentials, registration tokens, runtime URLs, internal
//     connector secrets (token_prefix included) or the connector's local
//     network detail — there is nothing secret on an endpoint row, and the
//     joined connector facts are limited to label/status/models.
//
// Sharing state is a SEPARATE resource pair (share endpoints above) so the
// state transition is explicit and auditable — the existing PATCH surface
// cannot silently flip sharing.
// ======================================================

const endpointRepo = require('../storage/postgres/repositories/ai-endpoint-repo');
const { isLive } = require('../services/ai-connector/registry');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_ID_RE = UUID_RE; // users.user_id is a UUID; anything else is not persisted

/** Users-only guard; returns the caller's workspace id or answers 401/403. */
function userWorkspaceGuard(req, res) {
    if (!req.user) {
        res.status(401).json({ error: 'Authentication required', code: 'auth_required' });
        return null;
    }
    if (req.guest) {
        res.status(403).json({ error: 'Guests cannot manage shared AI endpoints', code: 'guest_forbidden' });
        return null;
    }
    if (!req.workspace || !req.workspace.id) {
        res.status(401).json({ error: 'Workspace not resolved', code: 'workspace_unresolved' });
        return null;
    }
    return req.workspace.id;
}

/**
 * Public JSON shape of an endpoint row + its live policy + derived
 * availability. NEVER secrets. Availability is DERIVED per request:
 *   sharing: policy.enabled (Private/Shared state)
 *   connector_live: the in-process WS registry (authoritative, LAC §7)
 *   runtime_reachable: heartbeat runtime_ok (unknown → false — honest)
 * Lifecycle states stay separate, never collapsed into one enum.
 */
function publicEndpoint(endpoint, policy, connectorRow) {
    if (!endpoint) return null;
    const live = connectorRow ? isLive(endpoint.connector_id) : false;
    const runtimeMeta = connectorRow && connectorRow.runtime_meta ? connectorRow.runtime_meta : null;
    return {
        endpoint_id: endpoint.endpoint_id,
        workspace_id: endpoint.workspace_id,
        connector_id: endpoint.connector_id,
        name: endpoint.name,
        runtime_type: endpoint.runtime_type,
        model: endpoint.model || null,
        description: endpoint.description || null,
        enabled: endpoint.enabled !== false,
        // ── lifecycle states (deliberately separate fields) ──
        sharing_enabled: !!(policy && policy.enabled === true),
        connector_live: live,
        runtime_reachable: !!(runtimeMeta && runtimeMeta.runtime_ok === true),
        models_discovered: Array.isArray(connectorRow && connectorRow.models)
            ? connectorRow.models.length : 0,
        // ── policy facts the owner may see ──
        concurrency_limit: policy ? Number(policy.concurrency_limit) : 1,
        request_limit: policy ? (policy.request_limit != null ? Number(policy.request_limit) : null) : null,
        token_limit: policy ? (policy.token_limit != null ? Number(policy.token_limit) : null) : null,
        created_at: endpoint.created_at != null ? Number(endpoint.created_at) : null,
        updated_at: endpoint.updated_at != null ? Number(endpoint.updated_at) : null,
    };
}

function notFound(res) {
    // One indistinct answer for foreign / unknown / revoked / deleted.
    return res.status(404).json({ error: 'Endpoint not found' });
}

function createAiEndpointRoutes({ logger = console } = {}) {
    return function registerAiEndpointRoutes(app) {

        // ── POST create — an endpoint is ALWAYS Private at creation ──────
        app.post('/api/v1/ai-endpoints', async (req, res) => {
            const workspaceId = userWorkspaceGuard(req, res);
            if (!workspaceId) return;
            const body = req.body || {};
            const name = typeof body.name === 'string' ? body.name.trim() : '';
            if (!name || name.length > endpointRepo.MAX_NAME_LEN) {
                return res.status(400).json({
                    error: `name is required (max ${endpointRepo.MAX_NAME_LEN} chars)`,
                });
            }
            const connectorId = typeof body.connector_id === 'string' ? body.connector_id.trim() : '';
            if (!UUID_RE.test(connectorId)) {
                return res.status(400).json({ error: 'connector_id must be a valid connector id' });
            }
            const runtimeType = typeof body.runtime_type === 'string' && body.runtime_type
                ? body.runtime_type
                : 'openai-compatible';
            if (!endpointRepo.RUNTIME_TYPES.includes(runtimeType)) {
                return res.status(400).json({
                    error: `runtime_type must be one of: ${endpointRepo.RUNTIME_TYPES.join(', ')}`,
                });
            }
            if (body.model != null && (typeof body.model !== 'string' || body.model.length > 512)) {
                return res.status(400).json({ error: 'model must be a short string' });
            }
            if (body.description != null && (typeof body.description !== 'string' || body.description.length > 500)) {
                return res.status(400).json({ error: 'description must be a short string' });
            }
            // workspace_id from the body is deliberately IGNORED — an
            // endpoint is always created in the caller's own workspace, and
            // only for the caller's OWN connector.
            try {
                const created = await endpointRepo.createEndpoint({
                    workspaceId,
                    connectorId,
                    name,
                    runtimeType,
                    model: body.model != null ? String(body.model).trim() : null,
                    description: body.description != null ? String(body.description).trim() : null,
                    // createdBy is optional provenance — a non-UUID user id
                    // (impossible via real auth) is dropped, never a 500.
                    createdBy: USER_ID_RE.test(req.user.userId) ? req.user.userId : null,
                });
                if (!created) {
                    // Connector unknown / foreign workspace / revoked — one
                    // indistinct 404 (no cross-workspace oracle).
                    return notFound(res);
                }
                res.status(201).json({ endpoint: publicEndpoint(created.endpoint, created.policy, null) });
            } catch (err) {
                logger.error(`[AI-ENDPOINT] create failed: ${err.message}`);
                res.status(500).json({ error: 'Failed to create AI endpoint' });
            }
        });

        // ── GET list own endpoints ────────────────────────────────────────
        app.get('/api/v1/ai-endpoints', async (req, res) => {
            const workspaceId = userWorkspaceGuard(req, res);
            if (!workspaceId) return;
            try {
                const { query } = require('../storage/postgres/database');
                const rows = await endpointRepo.listWorkspaceEndpoints(workspaceId);
                const out = [];
                for (const ep of rows) {
                    const policy = await endpointRepo.getSharePolicy(ep.endpoint_id);
                    const { rows: connRows } = await query(`
                        SELECT models, runtime_meta FROM ai_connectors
                        WHERE connector_id = $1 LIMIT 1
                    `, [ep.connector_id]);
                    out.push(publicEndpoint(ep, policy, connRows[0] || null));
                }
                res.json({ endpoints: out });
            } catch (err) {
                logger.error(`[AI-ENDPOINT] list failed: ${err.message}`);
                res.status(500).json({ error: 'Failed to list AI endpoints' });
            }
        });

        // ── GET one own endpoint detail ───────────────────────────────────
        app.get('/api/v1/ai-endpoints/:endpointId', async (req, res) => {
            const workspaceId = userWorkspaceGuard(req, res);
            if (!workspaceId) return;
            if (!UUID_RE.test(req.params.endpointId)) return notFound(res);
            try {
                const ep = await endpointRepo.getEndpoint(req.params.endpointId);
                if (!ep || ep.workspace_id !== workspaceId) return notFound(res);
                const policy = await endpointRepo.getSharePolicy(ep.endpoint_id);
                const { query } = require('../storage/postgres/database');
                const { rows: connRows } = await query(`
                    SELECT models, runtime_meta FROM ai_connectors
                    WHERE connector_id = $1 LIMIT 1
                `, [ep.connector_id]);
                res.json({ endpoint: publicEndpoint(ep, policy, connRows[0] || null) });
            } catch (err) {
                logger.error(`[AI-ENDPOINT] detail failed: ${err.message}`);
                res.status(500).json({ error: 'Failed to load AI endpoint' });
            }
        });

        // ── PATCH update (owner fields only — never sharing state) ───────
        app.patch('/api/v1/ai-endpoints/:endpointId', async (req, res) => {
            const workspaceId = userWorkspaceGuard(req, res);
            if (!workspaceId) return;
            if (!UUID_RE.test(req.params.endpointId)) return notFound(res);
            const body = req.body || {};
            const update = {};
            if (body.name !== undefined) update.name = body.name;
            if (body.model !== undefined) update.model = body.model;
            if (body.description !== undefined) update.description = body.description;
            if (body.enabled !== undefined) {
                if (typeof body.enabled !== 'boolean') {
                    return res.status(400).json({ error: 'enabled must be a boolean' });
                }
                update.enabled = body.enabled;
            }
            try {
                const ep = await endpointRepo.updateEndpoint(req.params.endpointId, workspaceId, update);
                if (!ep) return notFound(res);
                const policy = await endpointRepo.getSharePolicy(ep.endpoint_id);
                const { query } = require('../storage/postgres/database');
                const { rows: connRows } = await query(`
                    SELECT models, runtime_meta FROM ai_connectors
                    WHERE connector_id = $1 LIMIT 1
                `, [ep.connector_id]);
                res.json({ endpoint: publicEndpoint(ep, policy, connRows[0] || null) });
            } catch (err) {
                if (err.message && (err.message.includes('must be') || err.message.includes('required'))) {
                    return res.status(400).json({ error: err.message });
                }
                logger.error(`[AI-ENDPOINT] update failed: ${err.message}`);
                res.status(500).json({ error: 'Failed to update AI endpoint' });
            }
        });

        // ── DELETE soft delete (sharing stops immediately for the pool) ─
        app.delete('/api/v1/ai-endpoints/:endpointId', async (req, res) => {
            const workspaceId = userWorkspaceGuard(req, res);
            if (!workspaceId) return;
            if (!UUID_RE.test(req.params.endpointId)) return notFound(res);
            try {
                const deleted = await endpointRepo.deleteEndpoint(req.params.endpointId, workspaceId);
                if (!deleted) return notFound(res);
                res.json({ deleted: true });
            } catch (err) {
                logger.error(`[AI-ENDPOINT] delete failed: ${err.message}`);
                res.status(500).json({ error: 'Failed to delete AI endpoint' });
            }
        });

        // ── POST enable sharing (Private → Shared) ────────────────────────
        // Explicit confirmation discipline (worker share precedent): the
        // body must carry confirm_share=true so enabling is never accidental.
        app.post('/api/v1/ai-endpoints/:endpointId/share', async (req, res) => {
            const workspaceId = userWorkspaceGuard(req, res);
            if (!workspaceId) return;
            if (!UUID_RE.test(req.params.endpointId)) return notFound(res);
            const body = req.body || {};
            if (body.confirm_share !== true) {
                return res.status(400).json({
                    error: 'share requires confirm_share=true — a shared endpoint may be used by other Animastor users',
                    code: 'share_confirmation_required',
                });
            }
            try {
                const result = await endpointRepo.setSharing(req.params.endpointId, workspaceId, {
                    enabled: true,
                    concurrencyLimit: body.concurrency_limit,
                    requestLimit: body.request_limit,
                    tokenLimit: body.token_limit,
                });
                if (!result.ok) {
                    if (result.reason === 'endpoint_disabled') {
                        return res.status(409).json({
                            error: 'Endpoint is disabled — enable it before sharing',
                            code: 'endpoint_disabled',
                        });
                    }
                    return notFound(res);
                }
                const ep = await endpointRepo.getEndpoint(req.params.endpointId);
                res.json({ endpoint: publicEndpoint(ep, result.policy, null), sharing: true });
            } catch (err) {
                if (err.message && (err.message.includes('must be') || err.message.includes('required'))) {
                    return res.status(400).json({ error: err.message });
                }
                logger.error(`[AI-ENDPOINT] share enable failed: ${err.message}`);
                res.status(500).json({ error: 'Failed to enable sharing' });
            }
        });

        // ── DELETE disable sharing (Shared → Private) ────────────────────
        app.delete('/api/v1/ai-endpoints/:endpointId/share', async (req, res) => {
            const workspaceId = userWorkspaceGuard(req, res);
            if (!workspaceId) return;
            if (!UUID_RE.test(req.params.endpointId)) return notFound(res);
            try {
                const result = await endpointRepo.setSharing(req.params.endpointId, workspaceId, {
                    enabled: false,
                });
                if (!result.ok) return notFound(res);
                const ep = await endpointRepo.getEndpoint(req.params.endpointId);
                res.json({ endpoint: publicEndpoint(ep, result.policy, null), sharing: false });
            } catch (err) {
                logger.error(`[AI-ENDPOINT] share disable failed: ${err.message}`);
                res.status(500).json({ error: 'Failed to disable sharing' });
            }
        });
    };
}

module.exports = { createAiEndpointRoutes };
