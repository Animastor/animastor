// ======================================================
// Session Repository
// ======================================================
// Server-side sessions in PostgreSQL (source of truth per the account
// architecture — never Redis-only).
//
// The cookie carries the full token:  sid.<session_id_b64url>.<secret_b64url>
// The DB stores ONLY a SHA-256 hash of the secret; a leaked DB never yields
// usable session tokens.
// ======================================================

const crypto = require('crypto');
const { query } = require('../database');

const TOKEN_SECRET_BYTES = 32; // cryptographic randomness for the bearer part

/** Encode a buffer as URL-safe base64 without padding. */
function b64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build a new session token for the given session id. */
function generateToken(sessionId) {
    const secret = crypto.randomBytes(TOKEN_SECRET_BYTES);
    const token = `sid.${b64url(Buffer.from(String(sessionId), 'utf8'))}.${b64url(secret)}`;
    return { token, secretHash: hashSecret(secret) };
}

function hashSecret(secret) {
    return crypto.createHash('sha256').update(secret).digest('hex');
}

/**
 * Parse a raw cookie token into { sessionId, secretHash }.
 * @returns {object|null}
 */
function parseToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'sid') return null;
    try {
        const sessionId = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        const secret = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        if (!sessionId || secret.length === 0) return null;
        return { sessionId, secretHash: hashSecret(secret) };
    } catch (_) {
        return null;
    }
}

/**
 * Create a session for a user (single INSERT — token never exists without hash).
 * @param {string} userId
 * @param {number} expiresAtMs - epoch milliseconds
 * @returns {Promise<{sessionId:string, token:string, expiresAt:number}>}
 */
async function createSession(userId, expiresAtMs) {
    const sessionId = crypto.randomUUID();
    const { token, secretHash } = generateToken(sessionId);
    const { rows } = await query(`
        INSERT INTO sessions (session_id, user_id, token_hash, expires_at)
        VALUES ($1, $2, $3, $4)
        RETURNING session_id
    `, [sessionId, userId, secretHash, expiresAtMs]);
    return { sessionId: rows[0].session_id, token, expiresAt: expiresAtMs };
}

/**
 * Find a live, unexpired session by raw token.
 * @param {string} token
 * @returns {Promise<object|null>} { session_id, user_id, expires_at, username, display_name, email, role }
 */
async function findByToken(token) {
    const parsed = parseToken(token);
    if (!parsed) return null;
    const { rows } = await query(`
        SELECT s.session_id, s.user_id, s.expires_at,
               u.username, u.display_name, u.email, u.role
        FROM sessions s
        JOIN users u ON u.user_id = s.user_id
        WHERE s.session_id = $1 AND s.token_hash = $2 AND s.revoked_at IS NULL AND s.expires_at > $3
        LIMIT 1
    `, [parsed.sessionId, parsed.secretHash, Date.now()]);
    return rows[0] || null;
}

/**
 * Revoke a session (idempotent — revoking twice is a no-op).
 * @param {string} token - raw cookie token
 * @returns {Promise<boolean>} true when a session was newly revoked
 */
async function revokeByToken(token) {
    const parsed = parseToken(token);
    if (!parsed) return false;
    const { rowCount } = await query(`
        UPDATE sessions SET revoked_at = EXTRACT(EPOCH FROM NOW())::bigint * 1000
        WHERE session_id = $1 AND token_hash = $2 AND revoked_at IS NULL
    `, [parsed.sessionId, parsed.secretHash]);
    return rowCount > 0;
}

/** Revoke all sessions of a user (e.g. password change). */
async function revokeAllForUser(userId) {
    if (!userId) return 0;
    const { rowCount } = await query(`
        UPDATE sessions SET revoked_at = EXTRACT(EPOCH FROM NOW())::bigint * 1000
        WHERE user_id = $1 AND revoked_at IS NULL
    `, [userId]);
    return rowCount;
}

/** Housekeeping: drop expired/long-revoked sessions (safe to call anytime). */
async function purgeExpired() {
    const { rowCount } = await query(`
        DELETE FROM sessions WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $1)
    `, [Date.now()]);
    return rowCount;
}

module.exports = { createSession, findByToken, revokeByToken, revokeAllForUser, purgeExpired, parseToken, generateToken };
