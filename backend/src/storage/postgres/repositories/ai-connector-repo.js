// ======================================================
// LLM Connector Repository (LAC-1 — Local AI Connector V1 Phase 1)
// ======================================================
// Durable source of truth for local AI connector identity & credentials
// (docs/04-planning/local-ai-connector-v1.md §8, §8.1). V1 = PRIVATE LOCAL
// AI ONLY — no sharing, no pool, no gpu-hub involvement (AD-9/AD-10).
//
// Credential contract — the worker `wrk.*` house pattern, namespace
// reconciled with the sharing doc §13/§17 (AD-1):
//
//   persistent credential   llmc.<connector_id_b64url>.<secret_b64url>
//   registration token      llmcreg.<connector_id_b64url>.<secret_b64url>
//
// `llmcreg.*` is NOT a second persistent credential namespace — it is a
// one-time, workspace-bound, TTL-bounded bootstrap token. The exchange
// (activateConnector) is ATOMIC and EXACTLY-ONCE (AD-3): a single PG
// transaction with SELECT … FOR UPDATE serializes racing activations so
// exactly one persistent `llmc.*` credential can ever exist. PG is the ONLY
// source of truth for this lifecycle — Redis is never authoritative.
//
// Identity invariants (worker pattern verbatim):
//   - connector_id / workspace_id are server-generated / server-resolved and
//     NEVER taken from a client request;
//   - a connector belongs to exactly one workspace (FK ON DELETE CASCADE);
//   - the DB stores ONLY SHA-256 hashes; plaintext is disclosed exactly
//     once (create / activate / rotate) and never persisted or logged.
// ======================================================

const crypto = require('crypto');
const { query, getPool } = require('../database');

const TOKEN_SECRET_BYTES = 32; // cryptographic randomness for the bearer part
const TOKEN_PREFIX = 'llmc'; // persistent connector credential family (AD-1)
const REG_TOKEN_PREFIX = 'llmcreg'; // one-time registration/bootstrap token
const TOKEN_DISPLAY_PREFIX_LEN = 8; // chars of the secret shown as mask
const REG_TOKEN_TTL_MS = 15 * 60 * 1000; // TTL ≤ 15 min (§3.3)

const RUNTIME_TYPES = ['ollama', 'vllm', 'llamacpp', 'lmstudio', 'openai-compatible'];
const CONNECTOR_STATUSES = ['pending', 'online', 'offline'];

function b64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
    return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Parse a raw llmc.* credential into { connectorId, secretHash }.
 * Malformed input of any shape returns null (caller answers 401 — never
 * throws). The token self-locates the row; the hash proves it.
 * @returns {object|null}
 */
function parseToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
    return parseSelfLocator(parts);
}

/**
 * Parse a raw llmcreg.* registration token into { connectorId, secretHash }.
 * @returns {object|null}
 */
function parseRegToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== REG_TOKEN_PREFIX) return null;
    return parseSelfLocator(parts);
}

function parseSelfLocator(parts) {
    try {
        const connectorId = b64urlDecode(parts[1]).toString('utf8');
        const secret = b64urlDecode(parts[2]);
        if (!connectorId || secret.length === 0) return null;
        // connector_id must be a UUID — rejects garbage self-locators early.
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectorId)) return null;
        return { connectorId, secretHash: sha256(secret) };
    } catch (_) {
        return null;
    }
}

/** Build a fresh persistent llmc.* credential for a connector row. */
function generateCredential(connectorId) {
    const secret = crypto.randomBytes(TOKEN_SECRET_BYTES);
    const token = `${TOKEN_PREFIX}.${b64url(Buffer.from(String(connectorId), 'utf8'))}.${b64url(secret)}`;
    const secretB64 = b64url(secret);
    return {
        token,
        secretHash: sha256(secret),
        tokenPrefix: `${TOKEN_PREFIX}_${secretB64.slice(0, TOKEN_DISPLAY_PREFIX_LEN)}`,
    };
}

/** Build a fresh one-time llmcreg.* registration token. */
function generateRegToken(connectorId) {
    const secret = crypto.randomBytes(TOKEN_SECRET_BYTES);
    const token = `${REG_TOKEN_PREFIX}.${b64url(Buffer.from(String(connectorId), 'utf8'))}.${b64url(secret)}`;
    return { token, secretHash: sha256(secret) };
}

/** Timing-safe hash comparison (row located by id only — never by hash). */
function hashMatches(storedHash, providedHash) {
    const stored = Buffer.from(String(storedHash), 'utf8');
    const provided = Buffer.from(String(providedHash), 'utf8');
    return stored.length === provided.length && crypto.timingSafeEqual(stored, provided);
}

const PUBLIC_COLUMNS = `
    connector_id, workspace_id, name, runtime_type, status, token_prefix,
    last_seen, models, capabilities, runtime_meta, revoked_at, created_by, created_at
`;

/**
 * Create a connector (PENDING state) and issue its one-time registration
 * token. workspace_id comes from the authenticated caller's workspace —
 * never from the client body (routes enforce this). No persistent
 * credential exists yet: activation mints it exactly once (AD-3).
 * @param {object} opts
 * @param {string} opts.workspaceId - owning workspace (server-resolved)
 * @param {string} opts.name - human label
 * @param {string} [opts.runtimeType] - UI label only (§6)
 * @param {string} [opts.createdBy] - user_id of the registering user
 * @param {number} [opts.now] - backend clock (epoch ms)
 * @returns {Promise<{connector:object, regToken:string, regExpiresAt:number}>}
 */
async function createConnector({ workspaceId, name, runtimeType = 'openai-compatible', createdBy, now = Date.now() }) {
    if (!workspaceId) throw new Error('workspaceId is required');
    if (!RUNTIME_TYPES.includes(runtimeType)) {
        throw new Error(`runtimeType must be one of: ${RUNTIME_TYPES.join(', ')}`);
    }
    const connectorId = crypto.randomUUID();
    const { token, secretHash } = generateRegToken(connectorId);
    const regExpiresAt = now + REG_TOKEN_TTL_MS;
    const { rows } = await query(`
        INSERT INTO ai_connectors (connector_id, workspace_id, name, runtime_type, status, reg_token_hash, reg_expires_at, created_by)
        VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
        RETURNING ${PUBLIC_COLUMNS}
    `, [connectorId, workspaceId, name, runtimeType, secretHash, regExpiresAt, createdBy || null]);
    return { connector: rows[0], regToken: token, regExpiresAt };
}

/**
 * (Re)issue the one-time registration token for a still-PENDING connector.
 * A previously issued token dies the moment this commits (hash replaced) —
 * after any re-arm there is EXACTLY ONE live registration token (the last
 * committed). Serialized with SELECT … FOR UPDATE, so two concurrent re-arms
 * cannot interleave: the loser blocks on the row lock, re-validates
 * (pending, not revoked) and replaces the winner's hash — last-writer-wins,
 * no torn state. Revoked/activated connectors cannot be re-armed (validated
 * INSIDE the lock, fail-closed order like activateConnector §8.1).
 * @returns {Promise<{connector:object, regToken:string, regExpiresAt:number}|null>}
 */
async function issueRegistrationToken(connectorId, workspaceId, now = Date.now()) {
    if (!connectorId || !workspaceId) return null;
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        // Row-level lock — the serialization point for concurrent re-arms.
        const { rows } = await client.query(`
            SELECT connector_id, workspace_id, status, revoked_at
            FROM ai_connectors
            WHERE connector_id = $1 AND workspace_id = $2
            FOR UPDATE
        `, [connectorId, workspaceId]);
        const row = rows[0];
        if (!row || row.revoked_at != null || row.status !== 'pending') {
            await client.query('COMMIT');
            return null;
        }
        const { token, secretHash } = generateRegToken(connectorId);
        const regExpiresAt = now + REG_TOKEN_TTL_MS;
        const { rows: updated } = await client.query(`
            UPDATE ai_connectors SET reg_token_hash = $2, reg_expires_at = $3
            WHERE connector_id = $1
            RETURNING ${PUBLIC_COLUMNS}
        `, [connectorId, secretHash, regExpiresAt]);
        await client.query('COMMIT');
        return { connector: updated[0], regToken: token, regExpiresAt };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Fetch a connector row by id (management routes; workspace membership is
 * checked by the caller — never returns secrets).
 * @returns {Promise<object|null>}
 */
async function getConnector(connectorId) {
    if (!connectorId) return null;
    const { rows } = await query(`
        SELECT ${PUBLIC_COLUMNS} FROM ai_connectors WHERE connector_id = $1 LIMIT 1
    `, [connectorId]);
    return rows[0] || null;
}

/** List connectors of a workspace (revoked included, flagged). */
async function listWorkspaceConnectors(workspaceId) {
    if (!workspaceId) return [];
    const { rows } = await query(`
        SELECT ${PUBLIC_COLUMNS} FROM ai_connectors
        WHERE workspace_id = $1
        ORDER BY created_at ASC
    `, [workspaceId]);
    return rows;
}

/**
 * ATOMIC EXACTLY-ONCE activation (AD-3, §8.1). Exchange a one-time
 * registration token for the persistent llmc.* credential.
 *
 * Single serialized PG transaction:
 *   1. lock the row (SELECT … FOR UPDATE — the cross-process primitive);
 *   2. validate INSIDE the lock (fail-closed order): reg hash present and
 *      timing-equal, not expired, not revoked, still 'pending';
 *   3. invalidate the registration token (hash nulled);
 *   4. mint the persistent credential (hash stored, plaintext returned once);
 *   5. commit.
 *
 * Two processes racing with the same token: the second blocks on the row
 * lock, re-reads after the first commits and finds reg_token_hash NULL →
 * { ok:false, reason:'registration_already_used' }. Exactly one persistent
 * credential can ever exist. Redis is not consulted — PG-only truth.
 *
 * The connector self-locates via the token's own connector_id; the caller
 * NEVER supplies one (identity comes from the credential, worker invariant).
 *
 * @returns {Promise<{ok:true, connector:object, token:string, tokenPrefix:string}
 *                 |{ok:false, reason:'invalid_registration_token'
 *                                |'registration_expired'
 *                                |'registration_already_used'
 *                                |'connector_revoked'
 *                                |'connector_not_pending'}>}
 */
async function activateConnector(regToken, now = Date.now()) {
    const parsed = parseRegToken(regToken);
    if (!parsed) return { ok: false, reason: 'invalid_registration_token' };
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        // (1) Row-level lock — serializes concurrent exchanges.
        const { rows } = await client.query(`
            SELECT connector_id, workspace_id, status, revoked_at, reg_token_hash, reg_expires_at
            FROM ai_connectors
            WHERE connector_id = $1
            FOR UPDATE
        `, [parsed.connectorId]);
        const row = rows[0];
        if (!row || !row.reg_token_hash
            || !hashMatches(row.reg_token_hash, parsed.secretHash)) {
            // Unknown connector, garbage token, or an already-consumed token
            // (hash nulled by the winner) — replay after activation lands here.
            await client.query('COMMIT');
            return { ok: false, reason: 'registration_already_used' };
        }
        // (2) Fail-closed validation INSIDE the lock (§8.1.2) — a token
        // expiring mid-race cannot be revived by the loser.
        if (row.revoked_at != null) {
            await client.query('COMMIT');
            return { ok: false, reason: 'connector_revoked' };
        }
        if (row.status !== 'pending') {
            await client.query('COMMIT');
            return { ok: false, reason: 'connector_not_pending' };
        }
        if (row.reg_expires_at == null || now > Number(row.reg_expires_at)) {
            await client.query('COMMIT');
            return { ok: false, reason: 'registration_expired' };
        }
        // (3+4) Invalidate the bootstrap token and mint the persistent
        // credential in the SAME transaction — no intermediate state exists.
        const { token, secretHash, tokenPrefix } = generateCredential(row.connector_id);
        const { rows: updated } = await client.query(`
            UPDATE ai_connectors
            SET reg_token_hash = NULL,
                reg_expires_at = NULL,
                token_hash = $2,
                token_prefix = $3,
                status = 'online',
                last_seen = $4
            WHERE connector_id = $1
            RETURNING ${PUBLIC_COLUMNS}
        `, [row.connector_id, secretHash, tokenPrefix, now]);
        await client.query('COMMIT');
        // (5) Plaintext disclosed exactly once.
        return { ok: true, connector: updated[0], token, tokenPrefix };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Resolve a raw llmc.* credential to an ACTIVE connector identity (or null).
 * Revoked connectors never resolve. This is the ONLY way a connector
 * identity may be established — connector_id/workspace_id from query/body
 * are never trusted (fail-closed, worker-auth pattern verbatim). The hash
 * comparison is timing-safe; the row is located by connector_id only.
 * @param {string} token
 * @returns {Promise<object|null>}
 */
async function authenticateConnector(token) {
    const parsed = parseToken(token);
    if (!parsed) return null;
    const { rows } = await query(`
        SELECT ${PUBLIC_COLUMNS}, token_hash
        FROM ai_connectors
        WHERE connector_id = $1 AND revoked_at IS NULL
        LIMIT 1
    `, [parsed.connectorId]);
    const row = rows[0];
    if (!row || !row.token_hash) return null; // not activated → no credential
    if (!hashMatches(row.token_hash, parsed.secretHash)) return null;
    delete row.token_hash;
    return row;
}

/**
 * Rotate the persistent credential: replace the token hash (the old token
 * dies the moment this commits). Single serialized PG transaction with a
 * row-level lock, so concurrent rotations cannot interleave: each commits
 * from a fresh locked read, exactly one persistent credential exists at any
 * time, and the LAST committed rotation wins (earlier plaintext tokens are
 * dead the moment their hash is overwritten — authentication always checks
 * the current row state). Returns the new one-time token, or null when the
 * connector does not belong to the workspace / is revoked / was never
 * activated. The previous credential hash is NOT returned — hashes are
 * internal state, callers verify outcomes through authenticateConnector.
 * @returns {Promise<{connector:object, token:string, tokenPrefix:string}|null>}
 */
async function rotateConnectorCredential(connectorId, workspaceId) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        // Row-level lock — validates state under the lock, never stale.
        const { rows: locked } = await client.query(`
            SELECT connector_id, workspace_id, revoked_at, token_hash
            FROM ai_connectors
            WHERE connector_id = $1 AND workspace_id = $2
            FOR UPDATE
        `, [connectorId, workspaceId]);
        const row = locked[0];
        if (!row || row.revoked_at != null || row.token_hash == null) {
            await client.query('COMMIT');
            return null;
        }
        const { token, secretHash, tokenPrefix } = generateCredential(connectorId);
        const { rows: updated } = await client.query(`
            UPDATE ai_connectors SET token_hash = $2, token_prefix = $3
            WHERE connector_id = $1
            RETURNING ${PUBLIC_COLUMNS}
        `, [connectorId, secretHash, tokenPrefix]);
        await client.query('COMMIT');
        return { connector: updated[0], token, tokenPrefix };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Revoke a connector (soft delete — row kept for audit; both credentials
 * die: authenticateConnector filters revoked_at, activateConnector refuses
 * revoked rows). Idempotent. Returns { revoked, tokenHash } — tokenHash is
 * the dead persistent credential's hash (for a future live-session registry
 * cleanup) or null.
 */
async function revokeConnector(connectorId, workspaceId) {
    const { rows, rowCount } = await query(`
        UPDATE ai_connectors
        SET revoked_at = $3, status = 'offline'
        WHERE connector_id = $1 AND workspace_id = $2 AND revoked_at IS NULL
        RETURNING token_hash
    `, [connectorId, workspaceId, Date.now()]);
    return { revoked: rowCount > 0, tokenHash: rows[0] ? rows[0].token_hash : null };
}

/**
 * Heartbeat / state update from an authenticated connector: stamp last_seen,
 * set status, replace models/capabilities/runtime_meta. Server-resolved
 * connector_id only (identity came from the credential). Status transitions
 * stay within the registry: a revoked connector never matches.
 * @returns {Promise<object|null>} updated public row or null (unknown/revoked)
 */
async function updateConnectorHeartbeat(connectorId, { status, models, capabilities, runtimeMeta } = {}, now = Date.now()) {
    const nextStatus = status || 'online';
    if (!CONNECTOR_STATUSES.includes(nextStatus)) {
        throw new Error(`status must be one of: ${CONNECTOR_STATUSES.join(', ')}`);
    }
    const { rows } = await query(`
        UPDATE ai_connectors
        SET last_seen = $2,
            status = $3,
            models = COALESCE($4::jsonb, models),
            capabilities = COALESCE($5::jsonb, capabilities),
            runtime_meta = COALESCE($6::jsonb, runtime_meta)
        WHERE connector_id = $1 AND revoked_at IS NULL
        RETURNING ${PUBLIC_COLUMNS}
    `, [connectorId, now, nextStatus,
        models == null ? null : JSON.stringify(models),
        capabilities == null ? null : JSON.stringify(capabilities),
        runtimeMeta == null ? null : JSON.stringify(runtimeMeta)]);
    return rows[0] || null;
}

module.exports = {
    TOKEN_PREFIX,
    REG_TOKEN_PREFIX,
    REG_TOKEN_TTL_MS,
    RUNTIME_TYPES,
    CONNECTOR_STATUSES,
    parseToken,
    parseRegToken,
    generateCredential,
    generateRegToken,
    createConnector,
    issueRegistrationToken,
    getConnector,
    listWorkspaceConnectors,
    activateConnector,
    authenticateConnector,
    rotateConnectorCredential,
    revokeConnector,
    updateConnectorHeartbeat,
};
