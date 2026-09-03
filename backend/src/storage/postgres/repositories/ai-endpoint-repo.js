// ======================================================
// AI Endpoint Repository (SH-AI-1 — LLM Sharing Phase 1 Control Plane)
// ======================================================
// Durable storage for the shareable-resource control plane
// (docs/04-planning/llm-sharing-phase1-control-plane.md):
//
//   ai_endpoints              — the first-class inference-endpoint record.
//                               References an ai_connectors row (FK ON DELETE
//                               CASCADE). NEVER stores credentials, runtime
//                               URLs, API keys or GPU secrets — the Connector
//                               stays the ONLY transport to the local machine.
//   ai_endpoint_share_policies — the V1 share policy (enabled + access mode
//                               + concurrency limit + optional request/token
//                               limits). NO billing/credits/cost_risk fields.
//
// Invariants (task brief §2–§6, sharing doc §6.3):
//   - workspace_id / connector_id ownership is validated by the CALLER
//     (routes resolve workspace from req.workspace; foreign/unknown →
//     one indistinct 404, never an existence oracle);
//   - every endpoint starts Private (a policy row, when created, has
//     enabled=false until the owner explicitly enables sharing);
//   - sharing is a POLICY, never an ownership event — the owner's own
//     resolution path is untouched (D3);
//   - lifecycle states stay SEPARATE: row exists / policy.enabled /
//     connector live (registry, never stored here) / runtime reachable
//     (heartbeat runtime_ok) / models discovered (connector models[]).
// ======================================================

const crypto = require('crypto');
const { query, getPool } = require('../database');

const RUNTIME_TYPES = ['ollama', 'vllm', 'llamacpp', 'lmstudio', 'openai-compatible'];
const ACCESS_MODES = ['public']; // V1: public only (worker share_policies D2 discipline)
const MAX_NAME_LEN = 120;
const MAX_MODEL_LEN = 512;
const MAX_DESCRIPTION_LEN = 500;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;

const ENDPOINT_COLUMNS = `
    endpoint_id, workspace_id, connector_id, name, runtime_type, model,
    description, enabled, deleted_at, created_by, created_at, updated_at
`;

const POLICY_COLUMNS = `
    policy_id, endpoint_id, workspace_id, enabled, access_mode,
    concurrency_limit, request_limit, token_limit, revoked_at,
    created_by, created_at, updated_at
`;

// ── endpoints ─────────────────────────────────────────────────────────────

/**
 * Create an endpoint for a connector the CALLER's workspace owns.
 * Starts Private: enabled=true (available to the owner) but NO policy row —
 * sharing does not exist until the owner explicitly enables it.
 * @returns {Promise<{endpoint:object, policy:object}>} (policy is the
 *          created default-Private policy row)
 */
async function createEndpoint({ workspaceId, connectorId, name, runtimeType, model, description, createdBy, now = Date.now() }) {
    if (!workspaceId) throw new Error('workspaceId is required');
    if (!connectorId) throw new Error('connectorId is required');
    if (!name || typeof name !== 'string' || !name.trim() || name.trim().length > MAX_NAME_LEN) {
        throw new Error(`name is required (max ${MAX_NAME_LEN} chars)`);
    }
    if (!RUNTIME_TYPES.includes(runtimeType)) {
        throw new Error(`runtimeType must be one of: ${RUNTIME_TYPES.join(', ')}`);
    }
    if (model != null && (typeof model !== 'string' || model.length > MAX_MODEL_LEN)) {
        throw new Error(`model must be a short string (max ${MAX_MODEL_LEN} chars)`);
    }
    if (description != null && (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LEN)) {
        throw new Error(`description must be a short string (max ${MAX_DESCRIPTION_LEN} chars)`);
    }
    const endpointId = crypto.randomUUID();
    // Single transaction: endpoint row + its default-Private policy row land
    // together, so an endpoint NEVER exists without a policy state.
    const poolClient = await getPool().connect();
    try {
        await poolClient.query('BEGIN');
        // Connector must exist, belong to the caller's workspace and not be
        // revoked — validated INSIDE the transaction (fail-closed).
        const { rows: connRows } = await poolClient.query(`
            SELECT connector_id FROM ai_connectors
            WHERE connector_id = $1 AND workspace_id = $2 AND revoked_at IS NULL
            FOR UPDATE
        `, [connectorId, workspaceId]);
        if (!connRows[0]) {
            await poolClient.query('COMMIT');
            return null;
        }
        const { rows: epRows } = await poolClient.query(`
            INSERT INTO ai_endpoints
                (endpoint_id, workspace_id, connector_id, name, runtime_type,
                 model, description, enabled, created_by, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $9, $9)
            RETURNING ${ENDPOINT_COLUMNS}
        `, [endpointId, workspaceId, connectorId, name.trim(), runtimeType,
            model ? String(model).trim() : null,
            description ? String(description).trim() : null,
            createdBy || null, now]);
        const { rows: polRows } = await poolClient.query(`
            INSERT INTO ai_endpoint_share_policies
                (endpoint_id, workspace_id, enabled, access_mode, concurrency_limit,
                 created_by, created_at, updated_at)
            VALUES ($1, $2, FALSE, 'public', $3, $4, $5, $5)
            RETURNING ${POLICY_COLUMNS}
        `, [endpointId, workspaceId, MIN_CONCURRENCY, createdBy || null, now]);
        await poolClient.query('COMMIT');
        return { endpoint: epRows[0], policy: polRows[0] };
    } catch (err) {
        await poolClient.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        poolClient.release();
    }
}

/**
 * Get one endpoint row (management routes; workspace membership is checked
 * by the caller — never returns secrets because there are none).
 * Soft-deleted rows (deleted_at set) return null.
 * @returns {Promise<object|null>}
 */
async function getEndpoint(endpointId) {
    if (!endpointId) return null;
    const { rows } = await query(`
        SELECT ${ENDPOINT_COLUMNS} FROM ai_endpoints
        WHERE endpoint_id = $1 AND deleted_at IS NULL
        LIMIT 1
    `, [endpointId]);
    return rows[0] || null;
}

/**
 * Get the live (non-revoked) policy row of an endpoint.
 * @returns {Promise<object|null>}
 */
async function getSharePolicy(endpointId) {
    if (!endpointId) return null;
    const { rows } = await query(`
        SELECT ${POLICY_COLUMNS} FROM ai_endpoint_share_policies
        WHERE endpoint_id = $1 AND revoked_at IS NULL
        LIMIT 1
    `, [endpointId]);
    return rows[0] || null;
}

/** List endpoints of a workspace (soft-deleted excluded). */
async function listWorkspaceEndpoints(workspaceId) {
    if (!workspaceId) return [];
    const { rows } = await query(`
        SELECT ${ENDPOINT_COLUMNS} FROM ai_endpoints
        WHERE workspace_id = $1 AND deleted_at IS NULL
        ORDER BY created_at ASC
    `, [workspaceId]);
    return rows;
}

/**
 * Update an endpoint's owner-editable fields (name / model / description /
 * enabled). Never touches the policy (sharing state) — a separate operation
 * by design. Returns the updated row or null (unknown / wrong workspace).
 * @returns {Promise<object|null>}
 */
async function updateEndpoint(endpointId, workspaceId, { name, model, description, enabled }, now = Date.now()) {
    const sets = [];
    const params = [endpointId, workspaceId];
    let n = 3;
    if (name !== undefined) {
        if (!name || typeof name !== 'string' || !name.trim() || name.trim().length > MAX_NAME_LEN) {
            throw new Error(`name must be a non-empty string (max ${MAX_NAME_LEN} chars)`);
        }
        sets.push(`name = $${n++}`);
        params.push(name.trim());
    }
    if (model !== undefined) {
        if (model != null && (typeof model !== 'string' || model.length > MAX_MODEL_LEN)) {
            throw new Error(`model must be a short string (max ${MAX_MODEL_LEN} chars)`);
        }
        sets.push(`model = $${n++}`);
        params.push(model ? String(model).trim() : null);
    }
    if (description !== undefined) {
        if (description != null && (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LEN)) {
            throw new Error(`description must be a short string (max ${MAX_DESCRIPTION_LEN} chars)`);
        }
        sets.push(`description = $${n++}`);
        params.push(description ? String(description).trim() : null);
    }
    if (enabled !== undefined) {
        if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
        sets.push(`enabled = $${n++}`);
        params.push(enabled);
    }
    if (sets.length === 0) return await getEndpoint(endpointId);
    sets.push(`updated_at = $${n++}`);
    params.push(now);
    const { rows } = await query(`
        UPDATE ai_endpoints SET ${sets.join(', ')}
        WHERE endpoint_id = $1 AND workspace_id = $2 AND deleted_at IS NULL
        RETURNING ${ENDPOINT_COLUMNS}
    `, params);
    return rows[0] || null;
}

/**
 * Soft-delete an endpoint (audit-friendly; the FK cascade stays for hard
 * deletes). Sharing stops immediately for the pool: listSharedEndpoints /
 * eligibility filters drop soft-deleted rows. Returns true when deleted.
 */
async function deleteEndpoint(endpointId, workspaceId, now = Date.now()) {
    const { rowCount } = await query(`
        UPDATE ai_endpoints SET deleted_at = $3, updated_at = $3
        WHERE endpoint_id = $1 AND workspace_id = $2 AND deleted_at IS NULL
    `, [endpointId, workspaceId, now]);
    return (rowCount || 0) > 0;
}

// ── share policy transitions (Private ↔ Shared) ──────────────────────────

/**
 * Set the sharing state of an endpoint's live policy: enabled=true means
 * Shared (the endpoint's spare capacity joins the shared pool), false means
 * Private. Optionally update concurrency/request/token limits in the same
 * transition. Creates a fresh policy row when none is live (an endpoint
 * created by an earlier path, or after a revoke). NEVER changes ownership.
 *
 * A disabled (enabled=false) endpoint row cannot be shared — the transition
 * fails closed with 'endpoint_disabled'.
 *
 * @returns {Promise<{ok:true, policy:object}
 *                 |{ok:false, reason:'endpoint_not_found'|'endpoint_disabled'}>}
 */
async function setSharing(endpointId, workspaceId, { enabled, concurrencyLimit, requestLimit, tokenLimit }, now = Date.now()) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
    if (concurrencyLimit !== undefined && concurrencyLimit !== null) {
        if (typeof concurrencyLimit !== 'number' || !Number.isInteger(concurrencyLimit)
            || concurrencyLimit < MIN_CONCURRENCY || concurrencyLimit > MAX_CONCURRENCY) {
            throw new Error(`concurrencyLimit must be an integer ${MIN_CONCURRENCY}..${MAX_CONCURRENCY}`);
        }
    }
    for (const [label, limit] of [['requestLimit', requestLimit], ['tokenLimit', tokenLimit]]) {
        if (limit !== undefined && limit !== null) {
            if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
                throw new Error(`${label} must be a positive integer`);
            }
        }
    }
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const { rows: epRows } = await client.query(`
            SELECT endpoint_id, workspace_id, enabled FROM ai_endpoints
            WHERE endpoint_id = $1 AND workspace_id = $2 AND deleted_at IS NULL
            FOR UPDATE
        `, [endpointId, workspaceId]);
        const ep = epRows[0];
        if (!ep) {
            await client.query('COMMIT');
            return { ok: false, reason: 'endpoint_not_found' };
        }
        if (enabled && ep.enabled !== true) {
            // An owner-disabled endpoint must never enter the shared pool —
            // the availability switch and the sharing switch are independent
            // gates, BOTH must be on for sharing.
            await client.query('COMMIT');
            return { ok: false, reason: 'endpoint_disabled' };
        }
        const { rows: polRows } = await client.query(`
            SELECT policy_id FROM ai_endpoint_share_policies
            WHERE endpoint_id = $1 AND revoked_at IS NULL
            FOR UPDATE
        `, [endpointId]);
        const existing = polRows[0];
        let result;
        if (existing) {
            const sets = ['enabled = $3', `updated_at = $4`];
            const params = [endpointId, workspaceId, enabled, now];
            let n = 5;
            if (concurrencyLimit !== undefined && concurrencyLimit !== null) {
                sets.push(`concurrency_limit = $${n++}`);
                params.push(concurrencyLimit);
            } else if (enabled === false) {
                // Disabling resets the concurrency limit to the default so a
                // re-enable starts from the documented baseline.
                sets.push(`concurrency_limit = $${n++}`);
                params.push(MIN_CONCURRENCY);
            }
            if (requestLimit !== undefined) {
                sets.push(`request_limit = $${n++}`);
                params.push(requestLimit);
            }
            if (tokenLimit !== undefined) {
                sets.push(`token_limit = $${n++}`);
                params.push(tokenLimit);
            }
            const { rows } = await client.query(`
                UPDATE ai_endpoint_share_policies SET ${sets.join(', ')}
                WHERE endpoint_id = $1 AND workspace_id = $2 AND revoked_at IS NULL
                RETURNING ${POLICY_COLUMNS}
            `, params);
            result = rows[0];
        } else {
            const { rows } = await client.query(`
                INSERT INTO ai_endpoint_share_policies
                    (endpoint_id, workspace_id, enabled, access_mode,
                     concurrency_limit, request_limit, token_limit,
                     created_at, updated_at)
                VALUES ($1, $2, $3, 'public', $4, $5, $6, $7, $7)
                RETURNING ${POLICY_COLUMNS}
            `, [endpointId, workspaceId, enabled,
                concurrencyLimit != null ? concurrencyLimit : MIN_CONCURRENCY,
                requestLimit != null ? requestLimit : null,
                tokenLimit != null ? tokenLimit : null,
                now]);
            result = rows[0];
        }
        await client.query('COMMIT');
        return { ok: true, policy: result };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

// ── shared-pool read path (resolver seam) ─────────────────────────────────

/**
 * List the SHARED endpoints of the pool with everything the resolver seam
 * needs to filter and select — policy, endpoint row and connector state in
 * ONE query. Liveness of the connector is NOT stored here: the caller
 * (resolver) checks the in-process WS registry (`registry.isLive`) — the
 * live WS session is the AUTHORITATIVE connector availability (LAC §7).
 * Connector facts (revoked, models, runtime_meta) are joined read-only.
 *
 * Filters applied here (the cheap, PG-side ones):
 *   - policy.enabled = TRUE (sharing on) and not revoked;
 *   - endpoint.enabled = TRUE and not soft-deleted;
 *   - connector not revoked.
 * Registry liveness + workspace eligibility + concurrency are checked by
 * the resolver service (needs in-process state).
 *
 * @returns {Promise<Array<{endpoint:object, policy:object, connector:object}>>}
 */
async function listSharedEndpoints() {
    const { rows } = await query(`
        SELECT e.endpoint_id        AS endpoint_endpoint_id,
               e.workspace_id       AS endpoint_workspace_id,
               e.connector_id       AS endpoint_connector_id,
               e.name               AS endpoint_name,
               e.runtime_type       AS endpoint_runtime_type,
               e.model              AS endpoint_model,
               p.policy_id          AS policy_policy_id,
               p.access_mode       AS policy_access_mode,
               p.concurrency_limit AS policy_concurrency_limit,
               p.request_limit     AS policy_request_limit,
               p.token_limit       AS policy_token_limit,
               c.status            AS connector_status,
               c.runtime_meta      AS connector_runtime_meta,
               c.models            AS connector_models
        FROM ai_endpoint_share_policies p
        JOIN ai_endpoints e ON e.endpoint_id = p.endpoint_id
        JOIN ai_connectors c ON c.connector_id = e.connector_id
        WHERE p.enabled = TRUE
          AND p.revoked_at IS NULL
          AND e.enabled = TRUE
          AND e.deleted_at IS NULL
          AND c.revoked_at IS NULL
        ORDER BY e.created_at ASC, e.endpoint_id ASC
    `);
    return rows.map((r) => ({
        endpoint: {
            endpoint_id: r.endpoint_endpoint_id,
            workspace_id: r.endpoint_workspace_id,
            connector_id: r.endpoint_connector_id,
            name: r.endpoint_name,
            runtime_type: r.endpoint_runtime_type,
            model: r.endpoint_model,
        },
        policy: {
            policy_id: r.policy_policy_id,
            access_mode: r.policy_access_mode,
            concurrency_limit: r.policy_concurrency_limit,
            request_limit: r.policy_request_limit,
            token_limit: r.policy_token_limit,
        },
        connector: {
            status: r.connector_status,
            runtime_meta: r.connector_runtime_meta,
            models: r.connector_models,
        },
    }));
}

module.exports = {
    RUNTIME_TYPES,
    ACCESS_MODES,
    MAX_NAME_LEN,
    MAX_CONCURRENCY,
    MIN_CONCURRENCY,
    createEndpoint,
    getEndpoint,
    getSharePolicy,
    listWorkspaceEndpoints,
    updateEndpoint,
    deleteEndpoint,
    setSharing,
    listSharedEndpoints,
};
