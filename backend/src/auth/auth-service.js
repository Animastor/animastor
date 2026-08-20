// ======================================================
// Auth Service (Authentication MVP)
// ======================================================
// register / login / logout / current-identity logic on top of:
//   - users / workspaces / workspace_members (pre-existing foundation)
//   - sessions repository (server-side, token-hash-only storage)
//   - password.js (scrypt hashing)
//
// Username policy: trimmed, case preserved for display, compared
// case-insensitively (lower(username) unique — enforced DB-side).
// No hash suffixes at this stage.
// ======================================================

const { getPool, query } = require('../storage/postgres/database');
const userRepo = require('../storage/postgres/repositories/user-repo');
const workspaceRepo = require('../storage/postgres/repositories/workspace-repo');
const sessionRepo = require('../storage/postgres/repositories/session-repo');
const { hashPassword, verifyPassword, validatePasswordPolicy } = require('./password');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_COOKIE_NAME = 'animastor_sid';

const USERNAME_MIN = 2;
const USERNAME_MAX = 32;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class AuthError extends Error {
    constructor(status, message, reason) {
        super(message);
        this.status = status;
        this.reason = reason; // loggable category, never the credentials
    }
}

/** Case-insensitive canonical username lookup (lower() unique index). */
async function findByUsernameCanonical(username) {
    if (!username) return null;
    const result = await query(
        `SELECT * FROM users WHERE lower(username) = lower($1) LIMIT 1`,
        [username]
    );
    return result.rows[0] || null;
}

function validateUsername(username) {
    if (typeof username !== 'string' || !username.trim()) return 'Username is required';
    const u = username.trim();
    if (u.length < USERNAME_MIN || u.length > USERNAME_MAX) {
        return `Username must be ${USERNAME_MIN}-${USERNAME_MAX} characters`;
    }
    if (/\s/.test(u)) return 'Username must not contain whitespace';
    return null;
}

function validateEmail(email) {
    if (email == null || email === '') return null; // optional field
    if (typeof email !== 'string') return 'Invalid email';
    return EMAIL_RE.test(email.trim().toLowerCase()) ? null : 'Invalid email';
}

/** Safe public shape — never include password_hash / recovery_key_hash / settings. */
function publicUser(user) {
    return { id: user.user_id, username: user.username, display_name: user.display_name || null };
}
function publicWorkspace(ws) {
    return { id: ws.id, name: ws.name, type: ws.type };
}

/**
 * Resolve (and lazily self-heal) the personal/default workspace for a user.
 * Every permanent user gets exactly one personal workspace; it is selected as
 * the active workspace for authenticated requests. A future workspace
 * switcher may override this selection without touching req.user resolution.
 */
async function resolveDefaultWorkspace(userId) {
    let ws = await workspaceRepo.findPersonalWorkspace(userId);
    if (!ws) {
        ws = await workspaceRepo.createWorkspace({ name: 'Personal workspace', ownerUserId: userId, type: 'personal' });
    }
    return ws;
}

/**
 * Registration: user + personal workspace + owner membership in ONE
 * transaction (atomic — a failure never leaves a user without a workspace or
 * a workspace without its owner). Session is created after commit.
 */
async function register({ username, password, email }) {
    const unameRaw = typeof username === 'string' ? username.trim() : '';
    const unameErr = validateUsername(unameRaw);
    if (unameErr) throw new AuthError(400, unameErr, 'register_invalid_username');
    const pwErr = validatePasswordPolicy(password);
    if (pwErr) throw new AuthError(400, pwErr, 'register_weak_password');
    const emErr = validateEmail(email);
    if (emErr) throw new AuthError(400, emErr, 'register_invalid_email');

    const uname = unameRaw;
    const emailNorm = email ? String(email).trim().toLowerCase() : null;

    // Application-level uniqueness pre-check (DB remains authoritative).
    const existing = await findByUsernameCanonical(uname);
    if (existing) throw new AuthError(409, 'Username is already taken', 'register_username_taken');
    if (emailNorm) {
        const emailTaken = await userRepo.findByEmail(emailNorm);
        if (emailTaken) throw new AuthError(409, 'Email is already taken', 'register_email_taken');
    }

    const passwordHash = await hashPassword(password);

    const client = await getPool().connect();
    let userRow;
    let workspaceRow;
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(`
            INSERT INTO users (username, password_hash, email, display_name)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (lower(username)) DO NOTHING
            RETURNING *
        `, [uname, passwordHash, emailNorm, uname]);
        userRow = rows[0];
        if (!userRow) {
            // Concurrent insert won the race (or canonical collision caught DB-side)
            await client.query('ROLLBACK');
            const dup = await findByUsernameCanonical(uname);
            if (dup && emailNorm && dup.email === emailNorm) {
                throw new AuthError(409, 'Email is already taken', 'register_email_taken');
            }
            throw new AuthError(409, 'Username is already taken', 'register_username_taken');
        }
        const { rows: wsRows } = await client.query(`
            INSERT INTO workspaces (name, owner_user_id, type)
            VALUES ($1, $2, 'personal')
            RETURNING *
        `, ['Personal workspace', userRow.user_id]);
        workspaceRow = wsRows[0];
        await client.query(`
            INSERT INTO workspace_members (workspace_id, user_id, role)
            VALUES ($1, $2, 'owner')
            ON CONFLICT (workspace_id, user_id) DO NOTHING
        `, [workspaceRow.id, userRow.user_id]);
        await client.query('COMMIT');
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        if (err instanceof AuthError) throw err;
        // DB canonical uniqueness (lower(username) index) surfaces as a PG error
        // for a case-variant insert that slipped past the pre-check.
        if (err && /unique/i.test(err.message || '')) {
            throw new AuthError(409, 'Username or email is already taken', 'register_conflict');
        }
        throw err;
    } finally {
        client.release();
    }

    const session = await sessionRepo.createSession(userRow.user_id, Date.now() + SESSION_TTL_MS);
    console.log(`[AUTH] register ok user=${userRow.user_id} workspace=${workspaceRow.id}`);
    return { user: publicUser(userRow), workspace: publicWorkspace(workspaceRow), session };
}

/**
 * Login. Unknown username and wrong password produce the SAME generic error;
 * verifyPassword equalizes timing when the user row is absent.
 */
async function login({ username, password }) {
    const uname = typeof username === 'string' ? username.trim() : '';
    if (typeof password !== 'string') {
        throw new AuthError(400, 'Username and password are required', 'login_invalid_input');
    }
    const user = uname ? await findByUsernameCanonical(uname) : null;
    const ok = await verifyPassword(password, user ? user.password_hash : null);
    if (!user || !ok) {
        // Reason category only in logs — never which part failed.
        console.log(`[AUTH] login failed reason=invalid_credentials user=${user ? user.user_id : 'unknown'} username_present=${!!user}`);
        throw new AuthError(401, 'Invalid username or password', 'login_invalid_credentials');
    }

    if (!user.password_hash) {
        // Account without a password cannot password-login (future OAuth etc.)
        throw new AuthError(401, 'Invalid username or password', 'login_no_password');
    }

    const workspace = await resolveDefaultWorkspace(user.user_id);
    const session = await sessionRepo.createSession(user.user_id, Date.now() + SESSION_TTL_MS);
    console.log(`[AUTH] login ok user=${user.user_id}`);
    return { user: publicUser(user), workspace: publicWorkspace(workspace), session };
}

/** Idempotent logout: revokes the session (already-revoked/unknown = ok). */
async function logout(token) {
    await sessionRepo.revokeByToken(token);
    return { ok: true };
}

/** Resolve the raw session token into { user, workspace } or null. */
async function resolveSession(token) {
    const row = token ? await sessionRepo.findByToken(token) : null;
    if (!row) return null;
    const workspace = await resolveDefaultWorkspace(row.user_id);
    return {
        user: { userId: row.user_id, username: row.username, displayName: row.display_name },
        workspace: publicWorkspace(workspace),
    };
}

/** Build the Set-Cookie value for a session token. */
function sessionCookieHeader(token, { secure }) {
    const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
    let v = `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax`;
    if (secure) v += '; Secure';
    return v;
}

/** Build the Set-Cookie value that clears the session cookie. */
function clearSessionCookieHeader({ secure }) {
    let v = `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
    if (secure) v += '; Secure';
    return v;
}

/** Minimal cookie parsing (no cookie-parser dependency). */
function readCookie(req, name) {
    const header = req.headers && req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() === name) {
            try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch (_) { return part.slice(eq + 1).trim(); }
        }
    }
    return null;
}

module.exports = {
    AuthError,
    register,
    login,
    logout,
    resolveSession,
    resolveDefaultWorkspace,
    findByUsernameCanonical,
    sessionCookieHeader,
    clearSessionCookieHeader,
    readCookie,
    SESSION_COOKIE_NAME,
    SESSION_TTL_MS,
};
