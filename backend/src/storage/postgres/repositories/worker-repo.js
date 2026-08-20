// ======================================================
// Worker Repository (Experimental Beta — Private Worker Phase 1)
// ======================================================
// Private worker identity & credentials in PostgreSQL (durable source of
// truth; Redis only ever holds a rebuildable auth mirror).
//
// Credential contract — identical house pattern to sessions (`sid.*`) and
// guests (`gst.*`):
//
//   token = wrk.<worker_id_b64url>.<secret_b64url>   (secret = 32 random bytes)
//
// The DB stores ONLY the SHA-256 hash of the secret; the plaintext token is
// returned exactly once at issuance and never persisted, logged or returned
// afterwards. A worker token is NOT a user session: it resolves to a worker
// row only and can never authenticate against the user API.
//
// Identity invariants:
//   - worker_id / workspace_id are server-generated / server-resolved and
//     NEVER taken from a client request;
//   - a worker belongs to exactly one workspace (workspace_id NOT NULL,
//     FK ON DELETE CASCADE — deleting a workspace deletes its workers).
// ======================================================

const crypto = require('crypto');
const { query } = require('../database');

const TOKEN_SECRET_BYTES = 32; // cryptographic randomness for the bearer part
const TOKEN_PREFIX = 'wrk';
const TOKEN_DISPLAY_PREFIX_LEN = 8; // chars of the secret shown as mask

const WORKER_TYPES = ['audio', 'image', 'video'];
const WORKER_MODES = ['private', 'share'];

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
 * Parse a raw worker token into { workerId, secretHash }.
 * The token self-locates the row; the hash proves it. Malformed input of any
 * shape returns null (caller answers 401 — never throws).
 * @returns {object|null}
 */
function parseToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
    try {
        const workerId = b64urlDecode(parts[1]).toString('utf8');
        const secret = b64urlDecode(parts[2]);
        if (!workerId || secret.length === 0) return null;
        // worker_id must be a UUID — rejects garbage self-locators early.
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workerId)) return null;
        return { workerId, secretHash: sha256(secret) };
    } catch (_) {
        return null;
    }
}

/** Build a fresh credential for a worker row. @returns {{token, secretHash, tokenPrefix}} */
function generateCredential(workerId) {
    const secret = crypto.randomBytes(TOKEN_SECRET_BYTES);
    const token = `${TOKEN_PREFIX}.${b64url(Buffer.from(String(workerId), 'utf8'))}.${b64url(secret)}`;
    const secretB64 = b64url(secret);
    return {
        token,
        secretHash: sha256(secret),
        tokenPrefix: `${TOKEN_PREFIX}_${secretB64.slice(0, TOKEN_DISPLAY_PREFIX_LEN)}`,
    };
}

/**
 * Register a private worker and issue its one-time credential.
 * workspace_id comes from the authenticated caller's workspace — never from
 * the client body (routes enforce this).
 * @param {object} opts
 * @param {string} opts.workspaceId - owning workspace (server-resolved)
 * @param {string} opts.name - human label
 * @param {string} opts.workerType - 'audio' | 'image' | 'video'
 * @param {string} [opts.createdBy] - user_id of the registering user
 * @returns {Promise<{worker:object, token:string}>} worker row (no hash) + one-time token
 */
async function createWorker({ workspaceId, name, workerType, createdBy }) {
    if (!workspaceId) throw new Error('workspaceId is required');
    if (!WORKER_TYPES.includes(workerType)) throw new Error(`workerType must be one of: ${WORKER_TYPES.join(', ')}`);
    const workerId = crypto.randomUUID();
    const { token, secretHash, tokenPrefix } = generateCredential(workerId);
    const { rows } = await query(`
        INSERT INTO workers (worker_id, workspace_id, name, worker_type, mode, token_hash, token_prefix, created_by)
        VALUES ($1, $2, $3, $4, 'private', $5, $6, $7)
        RETURNING worker_id, workspace_id, name, worker_type, capabilities, mode, status,
                  token_prefix, created_by, revoked_at, last_seen, created_at
    `, [workerId, workspaceId, name, workerType, secretHash, tokenPrefix, createdBy || null]);
    return { worker: rows[0], token };
}

/**
 * Resolve a raw token to an ACTIVE worker identity (or null).
 * Revoked workers never resolve. This is the ONLY way a worker identity may
 * be established — worker_id/workspace_id from query/body are never trusted.
 * The hash comparison is timing-safe (row located by worker_id only).
 * @param {string} token
 * @returns {Promise<object|null>}
 */
async function findByToken(token) {
    const parsed = parseToken(token);
    if (!parsed) return null;
    const { rows } = await query(`
        SELECT worker_id, workspace_id, name, worker_type, capabilities, mode,
               status, token_prefix, last_seen, created_at, token_hash
        FROM workers
        WHERE worker_id = $1 AND revoked_at IS NULL
        LIMIT 1
    `, [parsed.workerId]);
    const row = rows[0];
    if (!row) return null;
    const stored = Buffer.from(String(row.token_hash), 'utf8');
    const provided = Buffer.from(parsed.secretHash, 'utf8');
    if (stored.length !== provided.length || !crypto.timingSafeEqual(stored, provided)) return null;
    delete row.token_hash;
    return row;
}

/** Fetch a worker row by id (management routes; membership checked by caller). */
async function findById(workerId) {
    if (!workerId) return null;
    const { rows } = await query(`
        SELECT worker_id, workspace_id, name, worker_type, capabilities, mode,
               status, token_prefix, created_by, revoked_at, last_seen, created_at
        FROM workers WHERE worker_id = $1 LIMIT 1
    `, [workerId]);
    return rows[0] || null;
}

/** List workers of a workspace (revoked included, flagged). */
async function listByWorkspace(workspaceId) {
    const { rows } = await query(`
        SELECT worker_id, workspace_id, name, worker_type, capabilities, mode,
               status, token_prefix, created_by, revoked_at, last_seen, created_at
        FROM workers WHERE workspace_id = $1
        ORDER BY created_at ASC
    `, [workspaceId]);
    return rows;
}

/** All active (non-revoked) workers — for the Redis auth mirror rebuild. */
async function listActive() {
    const { rows } = await query(`
        SELECT worker_id, workspace_id, name, worker_type, capabilities, mode, token_hash
        FROM workers WHERE revoked_at IS NULL
    `);
    return rows;
}

/**
 * PW-2 dispatch routing: does this workspace have at least one active
 * (non-revoked) PRIVATE worker of the given type? The backend uses this at
 * dispatch time to decide workspace queue vs system pool — a workspace with
 * no private worker of the type keeps flowing to the operator's system pool
 * (backward compatibility). Never client-supplied; server-resolved only.
 * @returns {Promise<boolean>}
 */
async function hasActivePrivateWorkerOfType(workspaceId, workerType) {
    if (!workspaceId || !WORKER_TYPES.includes(workerType)) return false;
    const { rows } = await query(`
        SELECT 1 FROM workers
        WHERE workspace_id = $1 AND worker_type = $2
          AND mode = 'private' AND revoked_at IS NULL
        LIMIT 1
    `, [workspaceId, workerType]);
    return rows.length > 0;
}

/**
 * Rotate a worker credential: replace the token hash (old token dies the
 * moment this commits). Returns the new one-time token or null when the
 * worker does not belong to the workspace / is revoked.
 * @returns {Promise<{worker:object, token:string, previousTokenHash:string}|null>}
 */
async function rotateCredential(workerId, workspaceId) {
    const { rows: probeRows } = await query(`
        SELECT token_hash FROM workers
        WHERE worker_id = $1 AND workspace_id = $2 AND revoked_at IS NULL
    `, [workerId, workspaceId]);
    if (!probeRows[0]) return null;
    const previousTokenHash = probeRows[0].token_hash;
    const { token, secretHash, tokenPrefix } = generateCredential(workerId);
    const { rows } = await query(`
        UPDATE workers SET token_hash = $3, token_prefix = $4
        WHERE worker_id = $1 AND workspace_id = $2 AND revoked_at IS NULL
        RETURNING worker_id, workspace_id, name, worker_type, capabilities, mode,
                  status, token_prefix, created_by, revoked_at, last_seen, created_at
    `, [workerId, workspaceId, secretHash, tokenPrefix]);
    if (!rows[0]) return null;
    return { worker: rows[0], token, previousTokenHash };
}

/**
 * Revoke a worker (soft delete — row kept for audit; credential dead).
 * Idempotent. Returns { revoked, tokenHash } — tokenHash is the dead
 * credential's hash (for auth-mirror cleanup) or null.
 */
async function revokeWorker(workerId, workspaceId) {
    const { rows, rowCount } = await query(`
        UPDATE workers SET revoked_at = EXTRACT(EPOCH FROM NOW())::bigint * 1000
        WHERE worker_id = $1 AND workspace_id = $2 AND revoked_at IS NULL
        RETURNING token_hash
    `, [workerId, workspaceId]);
    return { revoked: rowCount > 0, tokenHash: rows[0] ? rows[0].token_hash : null };
}

/** Best-effort liveness mirror from heartbeats (Settings UI). */
async function touchLastSeen(workerId) {
    try {
        await query(`UPDATE workers SET last_seen = $2 WHERE worker_id = $1`, [workerId, Date.now()]);
    } catch (_) { /* non-fatal */ }
}

module.exports = {
    TOKEN_PREFIX,
    WORKER_TYPES,
    WORKER_MODES,
    parseToken,
    generateCredential,
    createWorker,
    findByToken,
    findById,
    listByWorkspace,
    listActive,
    hasActivePrivateWorkerOfType,
    rotateCredential,
    revokeWorker,
    touchLastSeen,
};
