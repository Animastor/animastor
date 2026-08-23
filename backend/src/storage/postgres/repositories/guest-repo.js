// ======================================================
// Guest Repository
// ======================================================
// Temporary identities for visitors without accounts (Guest Workspace MVP).
// One guest identity ↔ one temporary workspace. Same model as sessions:
// cryptographically random token in the cookie, SHA-256 hash in the DB
// (raw tokens are never persisted or logged).
//
// Guest identity is NOT a user row, NOT an IP, NOT a fingerprint and never
// derived from book ids/hashes — loss or guessing of any of those must not
// grant access.
// ======================================================

const crypto = require('crypto');
const { getPool, query } = require('../database');

const TOKEN_SECRET_BYTES = 32;

function b64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Parse a raw guest token into { guestId, secretHash }.
 * @returns {object|null}
 */
function parseToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'gst') return null;
    try {
        const guestId = b64urlDecode(parts[1]).toString('utf8');
        const secret = b64urlDecode(parts[2]);
        if (!guestId || secret.length === 0) return null;
        return { guestId, secretHash: sha256(secret) };
    } catch (_) {
        return null;
    }
}

/**
 * Create a guest identity + its temporary workspace in ONE transaction
 * (a guest without a workspace can never exist).
 * @param {object} opts
 * @param {number} opts.workspaceTtlMs - activity-based workspace deadline
 * @param {number} opts.sessionTtlMs - how long the cookie token authenticates
 * @returns {Promise<object>} { guestId, token, workspace, workspaceExpiresAt, sessionExpiresAt }
 */
async function createGuest({ workspaceTtlMs, sessionTtlMs }, now = Date.now()) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const { rows: wsRows } = await client.query(`
            INSERT INTO workspaces (name, type, expires_at)
            VALUES ('Guest workspace', 'temporary', $1)
            RETURNING *
        `, [now + workspaceTtlMs]);
        const workspace = wsRows[0];

        const guestId = crypto.randomUUID();
        const secret = crypto.randomBytes(TOKEN_SECRET_BYTES);
        const token = `gst.${b64url(Buffer.from(guestId, 'utf8'))}.${b64url(secret)}`;
        await client.query(`
            INSERT INTO guests (guest_id, token_hash, workspace_id, expires_at)
            VALUES ($1, $2, $3, $4)
        `, [guestId, sha256(secret), workspace.id, now + sessionTtlMs]);
        await client.query('COMMIT');
        return {
            guestId,
            token,
            workspace: { id: workspace.id, name: workspace.name, type: workspace.type },
            workspaceExpiresAt: now + workspaceTtlMs,
            sessionExpiresAt: now + sessionTtlMs,
        };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Resolve a raw guest token to identity + workspace (or null).
 * A returned row may still point at an EXPIRED workspace — callers must
 * check `workspaceStatus(now)`; the guest token itself only gates identity.
 */
async function findByToken(token, now = Date.now()) {
    const parsed = parseToken(token);
    if (!parsed) return null;
    const { rows } = await query(`
        SELECT g.guest_id,
               g.expires_at       AS session_expires_at,
               w.id               AS workspace_id,
               w.name             AS workspace_name,
               w.type             AS workspace_type,
               w.expires_at       AS workspace_expires_at
        FROM guests g
        JOIN workspaces w ON w.id = g.workspace_id
        WHERE g.guest_id = $1 AND g.token_hash = $2
          AND g.revoked_at IS NULL AND g.expires_at > $3
        LIMIT 1
    `, [parsed.guestId, parsed.secretHash, now]);
    return rows[0] || null;
}

/** 'active' | 'expired' for temporary workspaces; null workspace = unknown. */
function workspaceStatus(workspaceExpiresAt, now = Date.now()) {
    if (workspaceExpiresAt == null) return 'active';
    return now > workspaceExpiresAt ? 'expired' : 'active';
}

/**
 * Activity-based retention: bump the deadline forward for temporary
 * workspaces. Written only when the stored deadline already sits under the
 * new one (keeps idle read traffic from rewriting rows every request).
 */
async function touchWorkspaceActivity(workspaceId, workspaceTtlMs, now = Date.now()) {
    if (!workspaceId) return 0;
    const newExpiry = now + workspaceTtlMs;
    const { rowCount } = await query(`
        UPDATE workspaces
        SET expires_at = $2, updated_at = EXTRACT(EPOCH FROM NOW())::bigint
        WHERE id = $1 AND type = 'temporary' AND (expires_at IS NULL OR expires_at < $2)
    `, [workspaceId, newExpiry]);
    return rowCount;
}

/** Revoke a guest identity by raw token (idempotent). */
async function revokeByToken(token) {
    const parsed = parseToken(token);
    if (!parsed) return false;
    const { rowCount } = await query(`
        UPDATE guests SET revoked_at = EXTRACT(EPOCH FROM NOW())::bigint * 1000
        WHERE guest_id = $1 AND token_hash = $2 AND revoked_at IS NULL
    `, [parsed.guestId, parsed.secretHash]);
    return rowCount > 0;
}

/**
 * Workspace conversion (guest → personal account). Runs INSIDE the caller's
 * transaction (register): the temporary workspace becomes the user's
 * personal workspace in place — books keep their workspace_id untouched.
 * @param {object} client - pooled PG client with an open transaction
 */
async function convertTemporaryWorkspace(client, workspaceId, ownerUserId, username, now = Date.now()) {
    const wsName = username ? username + "'s Workspace" : 'Personal workspace';
    const { rows } = await client.query(`
        UPDATE workspaces
        SET owner_user_id = $2, type = 'personal', name = $3,
            expires_at = NULL, updated_at = EXTRACT(EPOCH FROM NOW())::bigint
        WHERE id = $1 AND type = 'temporary'
        RETURNING *
    `, [workspaceId, ownerUserId, wsName]);
    const workspace = rows[0];
    if (!workspace) {
        throw new Error(`workspace ${workspaceId} is not a convertible temporary workspace`);
    }
    // Every guest identity bound to that workspace can no longer authenticate.
    await client.query(`
        UPDATE guests SET revoked_at = EXTRACT(EPOCH FROM NOW())::bigint * 1000
        WHERE workspace_id = $1 AND revoked_at IS NULL
    `, [workspaceId]);
    return workspace;
}

/** Housekeeping (safe to call from a periodic job): drop expired/revoked
 *  guests and hard-delete temporary workspaces past TTL+grace.
 *  Order matters: `books.workspace_id` is a plain FK, so a workspace's books
 *  are deleted BEFORE the workspace itself (child tables cascade off books). */
async function purgeExpired({ graceMs } = {}, now = Date.now()) {
    const grace = typeof graceMs === 'number' ? graceMs : 23 * 24 * 60 * 60 * 1000;
    // 1. Identities whose cookie token may no longer resolve.
    const guestRows = await query(
        `DELETE FROM guests WHERE expires_at < $1 OR revoked_at IS NOT NULL RETURNING guest_id`,
        [now]
    );
    // 2. Temporary workspaces past TTL+grace → hard delete (books + workspace
    //    in one tx so either both go or neither does).
    const { rows: expiring } = await query(`
        SELECT id FROM workspaces
        WHERE type = 'temporary' AND expires_at IS NOT NULL AND expires_at < $1
    `, [now - grace]);

    let workspaces = 0;
    let books = 0;
    const client = await getPool().connect();
    try {
        for (const ws of expiring) {
            await client.query('BEGIN');
            try {
                const deletedBooks = await client.query(
                    `DELETE FROM books WHERE workspace_id = $1 RETURNING book_id`,
                    [ws.id]
                );
                await client.query(`DELETE FROM workspaces WHERE id = $1`, [ws.id]);
                await client.query('COMMIT');
                workspaces += 1;
                books += deletedBooks.rowCount;
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {});
                console.error(`[GUESTS] purge workspace ${ws.id} failed (skipped): ${err.message}`);
            }
        }
    } finally {
        client.release();
    }
    return { guests: guestRows.rowCount, workspaces, books };
}

module.exports = {
    createGuest,
    findByToken,
    workspaceStatus,
    touchWorkspaceActivity,
    revokeByToken,
    convertTemporaryWorkspace,
    purgeExpired,
    parseToken,
};
