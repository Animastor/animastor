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
//   - a private/share worker belongs to exactly one workspace
//     (FK ON DELETE CASCADE — deleting a workspace deletes its workers);
//   - only mode='system' (Animastor-operated, admin-issued) may be
//     workspace-less (workers_scope_check enforces this in PG).
// ======================================================

const crypto = require('crypto');
const { query } = require('../database');

const TOKEN_SECRET_BYTES = 32; // cryptographic randomness for the bearer part
const TOKEN_PREFIX = 'wrk';
const TOKEN_DISPLAY_PREFIX_LEN = 8; // chars of the secret shown as mask

const WORKER_TYPES = ['audio', 'image', 'video'];
// FAIL CLOSED identity model (PW-4): every worker is one of three modes —
//   private — owned by exactly one workspace, serves only that workspace;
//   share   — owned by a workspace, volunteered to the community pool;
//   system  — Animastor-operated pool (workspace-less; promo/trials/paid).
// A missing/invalid credential is NEVER any of these — it is UNAUTHORIZED.
const WORKER_MODES = ['private', 'share', 'system'];

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
 * Register a worker and issue its one-time credential.
 * workspace_id comes from the authenticated caller's workspace — never from
 * the client body (routes enforce this). mode='system' is workspace-less and
 * can only be created through the admin path (createSystemWorker).
 * @param {object} opts
 * @param {string} opts.workspaceId - owning workspace (server-resolved)
 * @param {string} opts.name - human label
 * @param {string} opts.workerType - 'audio' | 'image' | 'video'
 * @param {string} [opts.mode] - 'private' (default) | 'share'
 * @param {string} [opts.createdBy] - user_id of the registering user
 * @returns {Promise<{worker:object, token:string}>} worker row (no hash) + one-time token
 */
async function createWorker({ workspaceId, name, workerType, mode = 'private', createdBy }) {
    if (mode !== 'private' && mode !== 'share') {
        throw new Error(`mode must be 'private' or 'share' here (system is admin-only)`);
    }
    if (!workspaceId) throw new Error('workspaceId is required');
    if (!WORKER_TYPES.includes(workerType)) throw new Error(`workerType must be one of: ${WORKER_TYPES.join(', ')}`);
    const workerId = crypto.randomUUID();
    const { token, secretHash, tokenPrefix } = generateCredential(workerId);
    const { rows } = await query(`
        INSERT INTO workers (worker_id, workspace_id, name, worker_type, mode, token_hash, token_prefix, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING worker_id, workspace_id, name, worker_type, capabilities, mode, status,
                  token_prefix, created_by, revoked_at, last_seen, created_at
    `, [workerId, workspaceId, name, workerType, mode, secretHash, tokenPrefix, createdBy || null]);
    return { worker: rows[0], token };
}

/**
 * Register an Animastor-operated SYSTEM worker (admin path only). SYSTEM
 * workers are workspace-less (workers_scope_check) and serve the operator
 * pool — never created through the tenant-facing routes.
 * @returns {Promise<{worker:object, token:string}>}
 */
async function createSystemWorker({ name, workerType, createdBy }) {
    if (!WORKER_TYPES.includes(workerType)) throw new Error(`workerType must be one of: ${WORKER_TYPES.join(', ')}`);
    const workerId = crypto.randomUUID();
    const { token, secretHash, tokenPrefix } = generateCredential(workerId);
    const { rows } = await query(`
        INSERT INTO workers (worker_id, workspace_id, name, worker_type, mode, token_hash, token_prefix, created_by)
        VALUES ($1, NULL, $2, $3, 'system', $4, $5, $6)
        RETURNING worker_id, workspace_id, name, worker_type, capabilities, mode, status,
                  token_prefix, created_by, revoked_at, last_seen, created_at
    `, [workerId, name, workerType, secretHash, tokenPrefix, createdBy || null]);
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
async function listActive(now = Date.now()) {
    const { rows } = await query(`
        SELECT w.worker_id, w.workspace_id, w.name, w.worker_type, w.capabilities, w.mode, w.token_hash,
               p.policy_id, p.scope_kind, p.starts_at, p.expires_at
        FROM workers w
        LEFT JOIN share_policies p
            ON p.worker_id = w.worker_id AND p.revoked_at IS NULL
           AND p.starts_at <= $1 AND (p.expires_at IS NULL OR p.expires_at > $1)
        WHERE w.revoked_at IS NULL
    `, [now]);
    // share_policy is embedded into the mirror identity payload (SH-1 D4):
    // { policy_id, scope_kind, expires_at } | null. Expiry is RE-CHECKED on
    // read by every consumer (hub, worker-health) — a stale mirror can never
    // extend a policy (§7.2). The partial unique index guarantees the LEFT
    // JOIN can never fan out to more than one row per worker (D1).
    for (const row of rows) {
        row.share_policy = sharePolicySnapshot(row);
    }
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

/**
 * Permanently delete a REVOKED worker (hard delete — the row is removed
 * entirely). Only revoked rows are purgeable: an active worker must be
 * revoked first, which kills its credential before the identity disappears.
 * Workspace-scoped SQL can never match workspace-less SYSTEM workers.
 * Idempotent. Returns { deleted, tokenHash, workerType } — tokenHash lets the
 * caller drop the dead credential from the Redis auth mirror (defense in
 * depth: revoke already dropped it and the periodic resync rebuilds the
 * mirror from PG, which no longer contains the row).
 */
async function purgeWorker(workerId, workspaceId) {
    const { rows, rowCount } = await query(`
        DELETE FROM workers
        WHERE worker_id = $1 AND workspace_id = $2 AND revoked_at IS NOT NULL
        RETURNING token_hash, worker_type
    `, [workerId, workspaceId]);
    return {
        deleted: rowCount > 0,
        tokenHash: rows[0] ? rows[0].token_hash : null,
        workerType: rows[0] ? rows[0].worker_type : null,
    };
}

// ── SYSTEM worker administration (requireAdmin routes only) ───────────────
// SYSTEM workers are workspace-less, so the workspace-scoped helpers above
// can never match them (SQL `workspace_id = $2` is never NULL-safe). These
// variants are the ONLY unscoped mutators and must stay admin-gated.

/** List Animastor-operated SYSTEM workers (revoked included, flagged). */
async function listSystemWorkers() {
    const { rows } = await query(`
        SELECT worker_id, workspace_id, name, worker_type, capabilities, mode,
               status, token_prefix, created_by, revoked_at, last_seen, created_at
        FROM workers WHERE mode = 'system'
        ORDER BY created_at ASC
    `);
    return rows;
}

/** Rotate a SYSTEM worker credential (admin path). @see rotateCredential */
async function rotateSystemCredential(workerId) {
    const { rows: probeRows } = await query(`
        SELECT token_hash FROM workers
        WHERE worker_id = $1 AND mode = 'system' AND revoked_at IS NULL
    `, [workerId]);
    if (!probeRows[0]) return null;
    const previousTokenHash = probeRows[0].token_hash;
    const { token, secretHash, tokenPrefix } = generateCredential(workerId);
    const { rows } = await query(`
        UPDATE workers SET token_hash = $2, token_prefix = $3
        WHERE worker_id = $1 AND mode = 'system' AND revoked_at IS NULL
        RETURNING worker_id, workspace_id, name, worker_type, capabilities, mode,
                  status, token_prefix, created_by, revoked_at, last_seen, created_at
    `, [workerId, secretHash, tokenPrefix]);
    if (!rows[0]) return null;
    return { worker: rows[0], token, previousTokenHash };
}

/** Revoke a SYSTEM worker (admin path). @see revokeWorker */
async function revokeSystemWorker(workerId) {
    const { rows, rowCount } = await query(`
        UPDATE workers SET revoked_at = EXTRACT(EPOCH FROM NOW())::bigint * 1000
        WHERE worker_id = $1 AND mode = 'system' AND revoked_at IS NULL
        RETURNING token_hash
    `, [workerId]);
    return { revoked: rowCount > 0, tokenHash: rows[0] ? rows[0].token_hash : null };
}

// ── SHARE POLICIES (Experimental Beta — SH-1, worker sharing V1/V2) ───────
// A share policy is an ACCESS POLICY, not ownership: it lets a `private`
// worker's spare capacity serve an audience while the owner's private
// lane keeps strict priority. mode NEVER changes (§3 of
// worker-sharing-model-design.md). All mutators are workspace-scoped
// (`WHERE workspace_id = $2`) — system workers are workspace-less and can
// never match. V1 supported scope 'public' only; V2 (SH-2) adds 'users'
// (personal grants — the policy's audience rows live in
// share_policy_grants). Groups/projects remain V3.

const SHARE_POLICY_SCOPES = ['public', 'users'];

/**
 * Normalize a share_policies row joined next to a worker row into the
 * share_policy identity payload ({ policy_id, scope_kind, expires_at }) —
 * the exact shape that rides the auth mirror / beacon registration (D4).
 * Rows without policy columns (plain worker rows) yield null.
 */
function sharePolicySnapshot(row) {
    if (!row || !row.policy_id) return null;
    return {
        policy_id: row.policy_id,
        worker_id: row.worker_id,
        scope_kind: row.scope_kind,
        starts_at: row.starts_at != null ? Number(row.starts_at) : null,
        expires_at: row.expires_at != null ? Number(row.expires_at) : null,
    };
}

/** Public API shape of a policy row (owner view; never secrets). */
function sharePolicyPublic(row) {
    return {
        policy_id: row.policy_id,
        worker_id: row.worker_id,
        workspace_id: row.workspace_id,
        scope_kind: row.scope_kind,
        starts_at: row.starts_at != null ? Number(row.starts_at) : null,
        expires_at: row.expires_at != null ? Number(row.expires_at) : null,
        revoked_at: row.revoked_at != null ? Number(row.revoked_at) : null,
        note: row.note || null,
        created_at: row.created_at != null ? Number(row.created_at) : null,
    };
}

/**
 * Start (or refresh) sharing: create the worker's single active share policy.
 * The worker guard (owned by workspace, mode 'private', not revoked) and the
 * insert are one INSERT..SELECT statement, so a concurrent revoke/purge
 * cannot race between check and write. An active-but-EXPIRED policy is first
 * materialized (revoked_at stamped — the auto-expiry marker) to free the D1
 * unique slot. A still-active policy yields { conflict: true }.
 *
 * NOTE: the stamping runs as a SEPARATE statement — a data-modifying CTE
 * shares its snapshot with the INSERT, which would not see the stamp and
 * would trip the unique index. True concurrent starts are still safe: the
 * partial unique index arbitrates (23505 → conflict).
 *
 * All policy activity comparisons use the backend clock (JS `now`), never
 * PG NOW() — EXTRACT(EPOCH FROM NOW())::bigint ROUNDS to the nearest second
 * and would place starts_at up to ~500ms in the future, making a fresh
 * policy read as inactive.
 *
 * @param {object} opts
 * @param {string} opts.workerId
 * @param {string} opts.workspaceId - server-resolved caller workspace (never body)
 * @param {string} [opts.scope] - 'public' (V1) | 'users' (V2 personal grants)
 * @param {number|null} opts.expiresAt - epoch ms or NULL = "until stopped" (D5)
 * @param {string|null} opts.createdBy - user_id
 * @returns {Promise<{policy:object}|{conflict:true}|{notFound:true}>}
 */
async function startSharePolicy({ workerId, workspaceId, scope = 'public', expiresAt = null, createdBy = null }) {
    if (!workerId || !workspaceId) return { notFound: true };
    if (!SHARE_POLICY_SCOPES.includes(scope)) throw new Error(`scope must be one of: ${SHARE_POLICY_SCOPES.join(', ')}`);
    const now = Date.now();
    if (expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt <= now)) {
        throw new Error('expiresAt must be a future epoch-ms timestamp or null');
    }
    // Auto-expiry materialization: an expired (revoked_at IS NULL,
    // expires_at <= now) policy still occupies the unique slot — stamp it.
    await query(`
        UPDATE share_policies
        SET revoked_at = $3
        WHERE worker_id = $1 AND workspace_id = $2 AND revoked_at IS NULL
          AND expires_at IS NOT NULL AND expires_at <= $3
    `, [workerId, workspaceId, now]);
    try {
        const { rows } = await query(`
            INSERT INTO share_policies (worker_id, workspace_id, scope_kind, starts_at, expires_at, created_by)
            SELECT w.worker_id, w.workspace_id, $6, $3, $4, $5
            FROM workers w
            WHERE w.worker_id = $1 AND w.workspace_id = $2
              AND w.mode = 'private' AND w.revoked_at IS NULL
            RETURNING policy_id, worker_id, workspace_id, scope_kind, starts_at, expires_at, revoked_at, note, created_at
        `, [workerId, workspaceId, now, expiresAt, createdBy || null, scope]);
        if (!rows[0]) return { notFound: true }; // no worker matched (foreign/revoked/wrong mode)
        return { policy: sharePolicyPublic(rows[0]) };
    } catch (err) {
        // 23505 = idx_share_policies_one_active violated: a still-active
        // (non-expired) policy exists — one active policy per worker (D1).
        if (err && (err.code === '23505' || String(err.message || '').includes('idx_share_policies_one_active'))) {
            return { conflict: true };
        }
        throw err;
    }
}

/**
 * Stop sharing: soft-revoke the worker's current active policy
 * (expires_at-agnostic — an expired-but-unstamped row is stamped too).
 * Idempotent-ish: { stopped: false } when nothing was active. Workspace-
 * scoped: a foreign worker never matches. Queue cleanup is NOT required
 * for PUBLIC policies (D6): consumer jobs live in the shared system pool,
 * served by other pool workers. A USERS policy stops popping its OWN
 * policy lane, so the route layer drains that lane into the public pool
 * (workerType is returned for exactly that).
 * @returns {Promise<{policy:object, workerType:string}|{stopped:false}|{notFound:true}>}
 */
async function stopSharePolicy(workerId, workspaceId) {
    if (!workerId || !workspaceId) return { notFound: true };
    const { rows: probe } = await query(`
        SELECT worker_type FROM workers WHERE worker_id = $1 AND workspace_id = $2 LIMIT 1
    `, [workerId, workspaceId]);
    if (!probe[0]) return { notFound: true };
    const workerType = probe[0].worker_type;
    const { rows } = await query(`
        UPDATE share_policies
        SET revoked_at = EXTRACT(EPOCH FROM NOW())::bigint * 1000
        WHERE worker_id = $1 AND workspace_id = $2 AND revoked_at IS NULL
        RETURNING policy_id, worker_id, workspace_id, scope_kind, starts_at, expires_at, revoked_at, note, created_at
    `, [workerId, workspaceId]);
    if (!rows[0]) return { stopped: false, workerType };
    // SH-2 (directory semantic): the audience is NOT persistent state — the
    // grant rows die with the policy they reference (stop/restart always
    // starts a FRESH audience; §14.3 "grants are dead with their policy").
    // A dangling grant would otherwise silently reappear in the recipient's
    // directory the next time this worker starts ANY users policy.
    await query(`DELETE FROM share_policy_grants WHERE policy_id = $1`, [rows[0].policy_id]);
    return { policy: sharePolicyPublic(rows[0]), workerType };
}

/**
 * Read the worker's ACTIVE policy for the OWNER (workspace-scoped, §7.3).
 * Expiry is re-checked against the passed `now` — an expired row is not
 * active even though revoked_at may still be NULL (read-time re-check).
 * @returns {Promise<object|null>} public policy shape or null
 */
async function getActiveSharePolicy(workerId, workspaceId, now = Date.now()) {
    if (!workerId || !workspaceId) return null;
    const { rows } = await query(`
        SELECT policy_id, worker_id, workspace_id, scope_kind, starts_at, expires_at, revoked_at, note, created_at
        FROM share_policies
        WHERE worker_id = $1 AND workspace_id = $2 AND revoked_at IS NULL
          AND starts_at <= $3
          AND (expires_at IS NULL OR expires_at > $3)
        ORDER BY created_at DESC
        LIMIT 1
    `, [workerId, workspaceId, now]);
    return rows[0] ? sharePolicyPublic(rows[0]) : null;
}

/**
 * Active (expiry-checked) policy of one worker WITHOUT the workspace scope —
 * internal use only (mirror point updates), callers are trusted backend code
 * paths that already resolved the worker server-side.
 * @returns {Promise<object|null>} { policy_id, worker_id, scope_kind, starts_at, expires_at } | null
 */
async function getActiveSharePolicyForWorker(workerId, now = Date.now()) {
    if (!workerId) return null;
    const { rows } = await query(`
        SELECT policy_id, worker_id, scope_kind, starts_at, expires_at
        FROM share_policies
        WHERE worker_id = $1 AND revoked_at IS NULL
          AND starts_at <= $2
          AND (expires_at IS NULL OR expires_at > $2)
        ORDER BY created_at DESC
        LIMIT 1
    `, [workerId, now]);
    return rows[0] ? sharePolicySnapshot(rows[0]) : null;
}

// ── PERSONAL GRANTS (Experimental Beta — SH-2, worker sharing V2) ─────────
// The audience of a scope_kind='users' policy. One grant row unambiguously
// means: "this user may use this shared Worker" (§14.2). Grants exist only
// while their policy is active (FK ON DELETE CASCADE + revoked policies are
// filtered by every read). Workspace-scoped exactly like policies.

/** Public API shape of a grant row (never secrets). */
function shareGrantPublic(row) {
    return {
        grant_id: row.grant_id,
        policy_id: row.policy_id,
        user_id: row.user_id,
        username: row.username || null,
        display_name: row.display_name || null,
        created_at: row.created_at != null ? Number(row.created_at) : null,
    };
}

/**
 * Grant personal access to users under the worker's ACTIVE USERS policy
 * (SH-2). Idempotent per (policy, user) via ON CONFLICT DO NOTHING (U1).
 * The whole write is one INSERT..SELECT against the active policy, so a
 * concurrent policy stop/expiry cannot grant against a dead policy, and the
 * workspace predicate makes foreign workers structurally unreachable.
 *
 * @param {object} opts
 * @param {string} opts.workerId
 * @param {string} opts.workspaceId - server-resolved owner workspace
 * @param {string[]} opts.userIds - resolved recipient user ids
 * @param {string|null} [opts.createdBy] - granting user_id
 * @returns {Promise<{grants:object[], addedUserIds:string[]}|{notFound:true}>}
 *   grants = the policy's FULL grant list after the insert (owner view);
 *   addedUserIds = recipients whose grant row was newly created (events).
 */
async function addShareGrants({ workerId, workspaceId, userIds, createdBy = null }) {
    if (!workerId || !workspaceId || !Array.isArray(userIds) || userIds.length === 0) {
        return { notFound: true };
    }
    const now = Date.now();
    const { rows } = await query(`
        INSERT INTO share_policy_grants (policy_id, workspace_id, user_id, created_by)
        SELECT p.policy_id, p.workspace_id, u.user_id, $5
        FROM share_policies p
        JOIN users u ON u.user_id = ANY($3::uuid[])
        WHERE p.worker_id = $1 AND p.workspace_id = $2
          AND p.scope_kind = 'users' AND p.revoked_at IS NULL
          AND p.starts_at <= $4
          AND (p.expires_at IS NULL OR p.expires_at > $4)
          AND EXISTS (
              SELECT 1 FROM workers w
              WHERE w.worker_id = $1 AND w.workspace_id = $2
                AND w.mode = 'private' AND w.revoked_at IS NULL
          )
        ON CONFLICT (policy_id, user_id) DO NOTHING
        RETURNING grant_id, policy_id, user_id, created_at
    `, [workerId, workspaceId, userIds, now, createdBy || null]);
    // The EXISTS guard makes the whole statement a no-op when the worker is
    // foreign/revoked/non-private OR no users matched — the caller separates
    // those outcomes with its prior owner/policy checks.
    const grants = await listShareGrants(workerId, workspaceId);
    if (grants === null) return { notFound: true };
    return { grants, addedUserIds: rows.map((r) => r.user_id) };
}

/**
 * Revoke one personal grant (soft: the row is deleted; re-granting later
 * creates a fresh row). Workspace-scoped via the policy's worker.
 * @returns {Promise<{removed:boolean}|{notFound:true}>}
 */
async function revokeShareGrant(workerId, workspaceId, userId) {
    if (!workerId || !workspaceId || !userId) return { notFound: true };
    const { rowCount } = await query(`
        DELETE FROM share_policy_grants g
        USING share_policies p
        WHERE g.policy_id = p.policy_id
          AND p.worker_id = $1 AND p.workspace_id = $2
          AND g.user_id = $3
    `, [workerId, workspaceId, userId]);
    return { removed: rowCount > 0 };
}

/**
 * List the recipients of the worker's ACTIVE USERS policy (owner view).
 * Null when the worker is foreign/unknown (caller answers 404); [] when no
 * users policy is active.
 * @returns {Promise<object[]|null>}
 */
async function listShareGrants(workerId, workspaceId) {
    if (!workerId || !workspaceId) return null;
    const { rows: probe } = await query(`
        SELECT 1 FROM workers WHERE worker_id = $1 AND workspace_id = $2 LIMIT 1
    `, [workerId, workspaceId]);
    if (!probe[0]) return null;
    const now = Date.now();
    const { rows } = await query(`
        SELECT g.grant_id, g.policy_id, g.user_id, g.created_at,
               u.username, u.display_name
        FROM share_policy_grants g
        JOIN share_policies p ON p.policy_id = g.policy_id
        JOIN users u ON u.user_id = g.user_id
        WHERE p.worker_id = $1 AND p.workspace_id = $2
          AND p.scope_kind = 'users' AND p.revoked_at IS NULL
          AND p.starts_at <= $3
          AND (p.expires_at IS NULL OR p.expires_at > $3)
        ORDER BY g.created_at ASC
    `, [workerId, workspaceId, now]);
    return rows.map(shareGrantPublic);
}

/**
 * "Shared with me" (V2): workers the given user may use through a personal
 * grant on an ACTIVE users policy. Never includes public-pool-only workers
 * and never includes the caller's own workers unless explicitly granted
 * (grants to the owner are rejected at the route layer anyway).
 * @param {string} userId - server-resolved caller user_id
 * @returns {Promise<object[]>} entries with access reason (§14.2)
 */
async function listSharedWithMe(userId, now = Date.now()) {
    if (!userId) return [];
    const { rows } = await query(`
        SELECT w.worker_id, w.name, w.worker_type, w.capabilities, w.mode,
               w.workspace_id AS owner_workspace_id,
               w.revoked_at, w.last_seen, w.created_at,
               p.policy_id, p.starts_at AS policy_starts_at, p.expires_at AS policy_expires_at,
               g.created_at AS granted_at,
               owner_u.username AS shared_by_username,
               owner_u.display_name AS shared_by_display_name,
               owner_ws.name AS owner_workspace_name
        FROM share_policy_grants g
        JOIN share_policies p ON p.policy_id = g.policy_id
        JOIN workers w ON w.worker_id = p.worker_id
        LEFT JOIN workspaces owner_ws ON owner_ws.id = w.workspace_id
        LEFT JOIN users owner_u ON owner_u.user_id = owner_ws.owner_user_id
        WHERE g.user_id = $1
          AND p.scope_kind = 'users' AND p.revoked_at IS NULL
          AND p.starts_at <= $2
          AND (p.expires_at IS NULL OR p.expires_at > $2)
          AND w.revoked_at IS NULL
          AND w.mode = 'private'
        ORDER BY g.created_at DESC
    `, [userId, now]);
    return rows.map((row) => ({
        worker_id: row.worker_id,
        name: row.name,
        worker_type: row.worker_type,
        capabilities: row.capabilities || null,
        owner_workspace_id: row.owner_workspace_id,
        revoked_at: row.revoked_at != null ? Number(row.revoked_at) : null,
        last_seen: row.last_seen != null ? Number(row.last_seen) : null,
        created_at: row.created_at != null ? Number(row.created_at) : null,
        granted_at: row.granted_at != null ? Number(row.granted_at) : null,
        share_policy: {
            policy_id: row.policy_id,
            scope_kind: 'users',
            starts_at: row.policy_starts_at != null ? Number(row.policy_starts_at) : null,
            expires_at: row.policy_expires_at != null ? Number(row.policy_expires_at) : null,
        },
        // Access reason (§14.2): exactly why this resource is listed.
        access_reason: {
            kind: 'shared_by_user',
            shared_by: row.shared_by_username || null,
            shared_by_display_name: row.shared_by_display_name || null,
            owner_workspace_name: row.owner_workspace_name || null,
        },
    }));
}

/**
 * Does ANY active users policy of the given worker already carry a grant
 * for this user? Pure authorization check (no workspace guard — the caller
 * resolves the user's own request context).
 * @returns {Promise<boolean>}
 */
async function hasGrantForUser(workerId, userId, now = Date.now()) {
    if (!workerId || !userId) return false;
    const { rows } = await query(`
        SELECT 1
        FROM share_policy_grants g
        JOIN share_policies p ON p.policy_id = g.policy_id
        WHERE p.worker_id = $1 AND g.user_id = $2
          AND p.scope_kind = 'users' AND p.revoked_at IS NULL
          AND p.starts_at <= $3
          AND (p.expires_at IS NULL OR p.expires_at > $3)
        LIMIT 1
    `, [workerId, userId, now]);
    return rows.length > 0;
}

/**
 * V2 dispatch routing (flag-gated callers only): the active USERS policy of
 * a worker that carries a grant for this workspace's OWNER USER. The owner
 * user_id is resolved by the caller (books.workspace → workspaces.owner).
 * Returns the policy snapshot for the per-policy lane key, or null.
 * @returns {Promise<object|null>} { policy_id, scope_kind, expires_at } | null
 */
async function findGrantPolicyForRouting(workspaceId, ownerUserId, workerType, now = Date.now()) {
    if (!workspaceId || !ownerUserId || !WORKER_TYPES.includes(workerType)) return null;
    const { rows } = await query(`
        SELECT p.policy_id, p.scope_kind, p.expires_at
        FROM share_policy_grants g
        JOIN share_policies p ON p.policy_id = g.policy_id
        JOIN workers w ON w.worker_id = p.worker_id
        JOIN workspaces ws ON ws.id = $1
        WHERE g.user_id = $2
          AND ws.owner_user_id = $2
          AND w.worker_type = $3 AND w.mode = 'private' AND w.revoked_at IS NULL
          AND p.scope_kind = 'users' AND p.revoked_at IS NULL
          AND p.starts_at <= $4
          AND (p.expires_at IS NULL OR p.expires_at > $4)
        LIMIT 1
    `, [workspaceId, ownerUserId, workerType, now]);
    return rows[0] || null;
}

/**
 * Active worker row WITH its token_hash and (joined, expiry-checked) share
 * policy — the complete mirror identity for a point update after a policy
 * event. Null for revoked/unknown workers.
 */
async function findActiveByIdWithTokenHash(workerId, now = Date.now()) {
    if (!workerId) return null;
    const { rows } = await query(`
        SELECT w.worker_id, w.workspace_id, w.name, w.worker_type, w.capabilities, w.mode, w.token_hash,
               p.policy_id, p.scope_kind, p.starts_at, p.expires_at
        FROM workers w
        LEFT JOIN share_policies p
            ON p.worker_id = w.worker_id AND p.revoked_at IS NULL
           AND p.starts_at <= $2 AND (p.expires_at IS NULL OR p.expires_at > $2)
        WHERE w.worker_id = $1 AND w.revoked_at IS NULL
        LIMIT 1
    `, [workerId, now]);
    const row = rows[0];
    if (!row) return null;
    row.share_policy = sharePolicySnapshot(row);
    return row;
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
    SHARE_POLICY_SCOPES,
    parseToken,
    generateCredential,
    createWorker,
    createSystemWorker,
    findByToken,
    findById,
    listByWorkspace,
    listActive,
    listSystemWorkers,
    hasActivePrivateWorkerOfType,
    rotateCredential,
    rotateSystemCredential,
    revokeWorker,
    purgeWorker,
    revokeSystemWorker,
    touchLastSeen,
    startSharePolicy,
    stopSharePolicy,
    getActiveSharePolicy,
    getActiveSharePolicyForWorker,
    shareGrantPublic,
    addShareGrants,
    revokeShareGrant,
    listShareGrants,
    listSharedWithMe,
    hasGrantForUser,
    findGrantPolicyForRouting,
    findActiveByIdWithTokenHash,
    sharePolicyPublic,
};
