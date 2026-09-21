// ======================================================
// AUTH CORE (Auth Extraction Phase 1) — the domain, Express-free
// ======================================================
// register/login/logout/session/guest identity lifecycle over INJECTED
// ports + config (audit §4.1, §6). No Express, no process.env, no PG handle
// — the host wiring (auth/index.cjs) binds concrete adapters. Semantics are
// FROZEN: this is the historical auth-service.js behaviour, port-ified
// (audit §9 invariants), including:
//   - registration atomicity via the registrationTx unit-of-work port;
//   - guest workspace in-place conversion (zero book copying);
//   - canonical lower(username) uniqueness with 409 race mapping;
//   - stale guest token at register → hard 410 (never a silent fresh ws);
//   - resolveSession/resolveDefaultWorkspace self-heal (read-path writes
//     preserved verbatim — audit §13.3);
//   - uniform 401 login errors (no username enumeration).
// ======================================================

'use strict';

const { AuthError } = require('./auth-errors');
const { hashPassword, verifyPassword, validatePasswordPolicy } = require('./password');
const { normalizeAuthConfig } = require('./auth-config');
const { assertAuthPorts } = require('./ports');
const { decideBookAccess, authorizedWorkspace } = require('./book-access');
const cookies = require('./cookies');

const USERNAME_MIN = 2;
const USERNAME_MAX = 32;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const LEGACY_WORKSPACE_NAMES = new Set(['Personal workspace', 'Guest workspace']);

/**
 * Build the auth domain service.
 * @param {object} deps
 * @param {object} deps.ports - { users, sessions, guests, workspaces, bookOwnership, registrationTx }
 * @param {object} [deps.config] - partial auth config (host-resolved; normalized here)
 * @param {object} [deps.logger] - { log, error } (console default)
 */
function createAuthService({ ports, config = {}, logger = console }) {
    assertAuthPorts(ports);
    const cfg = normalizeAuthConfig(config);
    const log = logger;

    // ── validation helpers (pure) ───────────────────────────────────────

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
        return { id: user.user_id, username: user.username, display_name: user.display_name || null, role: user.role || 'user' };
    }

    function publicWorkspace(ws) {
        return { id: ws.id, name: ws.name, type: ws.type };
    }

    // ── workspace self-heal (historical read-path write — preserved) ────

    /**
     * Resolve (and lazily self-heal) the personal/default workspace for a
     * user. Every permanent user gets exactly one personal workspace; a
     * future workspace switcher may override this selection.
     */
    async function resolveDefaultWorkspace(userId, username) {
        let ws = await ports.workspaces.findPersonalWorkspace(userId);
        if (!ws) {
            const name = username ? personalWorkspaceName(username) : 'Personal workspace';
            ws = await ports.workspaces.createWorkspace({ name, ownerUserId: userId, type: 'personal' });
        } else if (LEGACY_WORKSPACE_NAMES.has(ws.name)) {
            // Self-heal: legacy guest→user conversions or pre-rename
            // registrations. Never overwrite a user-chosen name.
            const newName = username ? personalWorkspaceName(username) : 'Personal workspace';
            await ports.workspaces.renameWorkspace(ws.id, newName).catch(() => {});
            ws.name = newName;
        }
        return ws;
    }

    function personalWorkspaceName(username) {
        return `${username}'s Workspace`;
    }

    // ── registration ────────────────────────────────────────────────────

    /**
     * Registration: user + personal workspace + owner membership in ONE
     * atomic transaction (the registrationTx port — rollback/behaviour
     * unchanged). Guest conversion happens INSIDE the transaction.
     * Session is created after commit; the old guest token is revoked after.
     */
    async function register({ username, password, email, guestToken }) {
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
        const existing = await ports.users.findByUsernameCanonical(uname);
        if (existing) throw new AuthError(409, 'Username is already taken', 'register_username_taken');
        if (emailNorm) {
            const emailTaken = await ports.users.findByEmail(emailNorm);
            if (emailTaken) throw new AuthError(409, 'Email is already taken', 'register_email_taken');
        }

        // Resolved BEFORE the transaction: a guest token here is an intent to
        // keep that workspace; stale/expired must not silently fall through
        // to "create a fresh empty workspace" (the books would look lost).
        let guest = null;
        if (guestToken) {
            guest = await ports.guests.findByToken(guestToken);
            if (!guest) throw new AuthError(410, 'Guest session expired — start over', 'register_guest_expired');
            if (guest.workspace_expires_at != null && Date.now() > guest.workspace_expires_at) {
                throw new AuthError(410, 'Guest workspace expired — start over', 'register_guest_expired');
            }
        }

        const passwordHash = await hashPassword(password);

        let result;
        try {
            result = await ports.registrationTx.registerUserWithWorkspace({
                username: uname,
                passwordHash,
                email: emailNorm,
                displayName: uname,
                guestConversion: guest ? { workspaceId: guest.workspace_id, username: uname } : null,
            });
        } catch (err) {
            if (err instanceof AuthError) throw err;
            if (err && err.registerRace) {
                // Concurrent insert won the race (or canonical collision
                // caught DB-side) — the historical discriminator: same email
                // → email conflict, otherwise username conflict.
                const dup = await ports.users.findByUsernameCanonical(uname);
                if (dup && emailNorm && dup.email === emailNorm) {
                    throw new AuthError(409, 'Email is already taken', 'register_email_taken');
                }
                throw new AuthError(409, 'Username is already taken', 'register_username_taken');
            }
            // DB canonical uniqueness (lower(username) index) surfaces as a PG
            // error for a case-variant insert that slipped past the pre-check.
            if (err && /unique/i.test(err.message || '')) {
                throw new AuthError(409, 'Username or email is already taken', 'register_conflict');
            }
            throw err;
        }
        const { userRow, workspaceRow, converted } = result;

        const session = await ports.sessions.createSession(userRow.user_id, Date.now() + cfg.sessionTtlMs);
        if (guest) {
            // The old guest token can never open that workspace again.
            await ports.guests.revokeByToken(guestToken).catch(() => {});
            log.log(`[AUTH] register+convert ok user=${userRow.user_id} workspace=${workspaceRow.id} (guest converted)`);
        } else {
            log.log(`[AUTH] register ok user=${userRow.user_id} workspace=${workspaceRow.id}`);
        }
        return { user: publicUser(userRow), workspace: publicWorkspace(workspaceRow), session, converted: !!converted };
    }

    // ── login / logout / session ────────────────────────────────────────

    /**
     * Login. Unknown username and wrong password produce the SAME generic
     * error; verifyPassword equalizes timing when the user row is absent.
     */
    async function login({ username, password }) {
        const uname = typeof username === 'string' ? username.trim() : '';
        if (typeof password !== 'string') {
            throw new AuthError(400, 'Username and password are required', 'login_invalid_input');
        }
        const user = uname ? await ports.users.findByUsernameCanonical(uname) : null;
        const ok = await verifyPassword(password, user ? user.password_hash : null);
        if (!user || !ok) {
            // Reason category only in logs — never which part failed.
            log.log(`[AUTH] login failed reason=invalid_credentials user=${user ? user.user_id : 'unknown'} username_present=${!!user}`);
            throw new AuthError(401, 'Invalid username or password', 'login_invalid_credentials');
        }

        if (!user.password_hash) {
            // Account without a password cannot password-login (future OAuth etc.)
            throw new AuthError(401, 'Invalid username or password', 'login_no_password');
        }

        const workspace = await resolveDefaultWorkspace(user.user_id, user.username);
        const session = await ports.sessions.createSession(user.user_id, Date.now() + cfg.sessionTtlMs);
        log.log(`[AUTH] login ok user=${user.user_id}`);
        return { user: publicUser(user), workspace: publicWorkspace(workspace), session };
    }

    /** Idempotent logout: revokes the session (already-revoked/unknown = ok). */
    async function logout(token) {
        await ports.sessions.revokeByToken(token);
        return { ok: true };
    }

    /** Resolve the raw session token into { user, workspace } or null. */
    async function resolveSession(token) {
        const row = token ? await ports.sessions.findByToken(token) : null;
        if (!row) return null;
        const workspace = await resolveDefaultWorkspace(row.user_id, row.username);
        return {
            user: { userId: row.user_id, username: row.username, displayName: row.display_name, role: row.role || 'user' },
            workspace: publicWorkspace(workspace),
        };
    }

    // ── guest identities (Guest Workspace MVP) ──────────────────────────

    /** Create a brand-new guest identity + temporary workspace. */
    async function createGuest() {
        return ports.guests.createGuest({
            workspaceTtlMs: cfg.guestWorkspaceTtlMs,
            sessionTtlMs: cfg.guestSessionTtlMs,
        });
    }

    /**
     * Resolve a raw guest token into { guest, workspace } or null.
     * An expired workspace still resolves — the decision layer answers 410
     * so the frontend can show a proper "workspace expired" state.
     */
    async function resolveGuest(token) {
        const row = token ? await ports.guests.findByToken(token) : null;
        if (!row) return null;
        const status = guestWorkspaceStatus(row.workspace_expires_at);
        return {
            guest: { guestId: row.guest_id, sessionExpiresAt: row.session_expires_at },
            workspace: {
                id: row.workspace_id,
                name: row.workspace_name,
                type: row.workspace_type,
                status, // 'active' | 'expired'
                expiresAt: row.workspace_expires_at,
            },
        };
    }

    /** 'active' | 'expired' for temporary workspaces (guest-repo semantics). */
    function guestWorkspaceStatus(workspaceExpiresAt, now = Date.now()) {
        if (workspaceExpiresAt == null) return 'active';
        return now > workspaceExpiresAt ? 'expired' : 'active';
    }

    /** Bump the activity deadline for a guest workspace (best effort). */
    async function touchGuestWorkspace(workspaceId) {
        try {
            await ports.guests.touchWorkspaceActivity(workspaceId, cfg.guestWorkspaceTtlMs);
        } catch (err) {
            log.error('[AUTH] guest activity bump failed (non-fatal):', err.message);
        }
    }

    // ── authorization decision (canonical layer — book-access.js) ───────

    /**
     * THE authorization decision for a book under the current identity.
     * Single source of truth: the Express guards (auth-context) and any
     * non-Express caller (player port) consume THIS, never a private copy.
     */
    function bookAccessDecision(identity, bookId) {
        return decideBookAccess(identity, bookId, { workspaces: ports.workspaces, bookOwnership: ports.bookOwnership }, log);
    }

    /**
     * Workspace-returning variant (historical checkBookAccess contract):
     * workspace|null; throws WorkspaceExpiredError (410) for expired guests.
     */
    function accessibleBookWorkspace(identity, bookId) {
        return authorizedWorkspace(identity, bookId, { workspaces: ports.workspaces, bookOwnership: ports.bookOwnership }, log);
    }

    /**
     * Direct book→workspace ownership lookup (historical
     * workspaceRepo.getWorkspaceIdForBook — the importBookAllowed
     * foreign-book check). Does NOT perform membership checks.
     * @returns {Promise<string|null>} workspace_id or null
     */
    function getWorkspaceIdForBook(bookId) {
        return ports.workspaces.getWorkspaceIdForBook(bookId);
    }

    // ── cookie grammar (delegated to cookies.js, config-bound) ──────────

    return {
        // errors
        AuthError,
        // lifecycle
        register,
        login,
        logout,
        resolveSession,
        resolveDefaultWorkspace,
        // guest identity
        createGuest,
        resolveGuest,
        touchGuestWorkspace,
        guestWorkspaceStatus,
        // authorization (canonical)
        bookAccessDecision,
        accessibleBookWorkspace,
        getWorkspaceIdForBook,
        // cookie grammar (config-bound wrappers — same signatures as before)
        sessionCookieHeader: (token, opts) => cookies.sessionCookieHeader(token, opts, cfg),
        clearSessionCookieHeader: (opts) => cookies.clearSessionCookieHeader(opts, cfg),
        guestCookieHeader: (token, opts) => cookies.guestCookieHeader(token, opts, cfg),
        clearGuestCookieHeader: (opts) => cookies.clearGuestCookieHeader(opts, cfg),
        parseCookieHeader: cookies.parseCookieHeader,
        // req-based convenience kept for existing consumers (auth-routes,
        // auth-context) — thin wrapper over the string-level parser.
        readCookie: (req, name) => cookies.parseCookieHeader(req && req.headers && req.headers.cookie, name),
        // constants (frozen wire contract)
        SESSION_COOKIE_NAME: cfg.sessionCookieName,
        GUEST_COOKIE_NAME: cfg.guestCookieName,
        SESSION_TTL_MS: cfg.sessionTtlMs,
        GUEST_WORKSPACE_TTL_MS: cfg.guestWorkspaceTtlMs,
        GUEST_WORKSPACE_GRACE_MS: cfg.guestWorkspaceGraceMs,
        GUEST_SESSION_TTL_MS: cfg.guestSessionTtlMs,
        // internal (testing / diagnostics)
        _config: cfg,
    };
}

/** Case-insensitive canonical username lookup moved into user-repo; kept
 *  exported here for require-path stability of any future direct consumer. */
module.exports = { createAuthService, USERNAME_MIN, USERNAME_MAX };
