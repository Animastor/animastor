// ======================================================
// Auth Context Middleware — HTTP adapter (Extraction Phase 1)
// ======================================================
// Identity resolution for every request (Auth MVP + Guest Workspace MVP):
//
//   request → cookies → identity → req.auth.kind = 'user' | 'guest' | 'none'
//
//   user  : `animastor_sid` → sessions → users      → req.user + req.workspace
//   guest : `animastor_gid` → guests  → workspaces  → req.guest + req.workspace
//                                                     (type 'temporary')
//   none  : no cookie at all — pre-auth reads keep the historical "everyone
//           sees everything" behaviour. A guest identity is provisioned only
//           on content-generating WRITE requests (POST/PUT/PATCH under
//           /api/v1, never on /auth) so work persists server-side the moment
//           it is created, yet plain browsing never scatters throwaway
//           workspaces. Everything outside /api/v1 stays unauthenticated.
//
// The guest is NEVER a fake user: req.user stays null, the identity lives on
// req.guest, and ownership resolution (guards) treats the guest's temporary
// workspace exactly like a personal one — same ownership chain
// `identity → workspace → book`, no second ownership system.
//
// EXTRACTION PHASE 1 (audit §8): this module is now a thin HTTP ADAPTER —
// it holds NO authorization logic of its own. Every decision delegates to
// the canonical layer (auth/book-access.js via the wired authService);
// this file only:
//   - reads identity from req (cookies), calls the domain, maps results to
//     HTTP statuses/bodies (401/403/410 semantics FROZEN);
//   - keeps the host-side policies that are path/transport-shaped: guest
//     auto-provision with its route exemptions (/auth, /worker,
//     /ai-connector, /admin) and the Secure-flag detection;
//   - requireAdmin / requireWorkspaceMembership are admin/workspace-surface
//     policies (host-owned per audit §4.2), kept here unchanged.
// ======================================================

const authService = require('../auth/auth-service');

/** True when the request carries ANY recognized identity (user or guest). */
function hasIdentity(req) {
    return !!(req && (req.user || req.guest));
}

/** Identity projection the domain layer consumes (plain objects, no req). */
function identityOf(req) {
    if (!req) return null;
    if (req.user) return { user: req.user, workspace: req.workspace };
    if (req.guest) return { guest: req.guest, workspace: req.workspace };
    return null;
}

/**
 * Authentication context middleware.
 * Resolution order: authenticated session → guest identity → (on /api/v1)
 * auto-provisioned guest. Any lookup failure degrades downward instead of
 * 500-ing every request during a transient PG outage.
 */
async function authContext(req, res, next) {
    req.user = null;
    req.guest = null;
    req.workspace = null;
    req.auth = { kind: 'none' };
    try {
        const sessionToken = authService.parseCookieHeader
            ? authService.parseCookieHeader(req.headers && req.headers.cookie, authService.SESSION_COOKIE_NAME)
            : authService.readCookie(req, authService.SESSION_COOKIE_NAME);
        if (sessionToken) {
            const resolved = await authService.resolveSession(sessionToken);
            if (resolved) {
                req.user = resolved.user;
                req.workspace = resolved.workspace;
                req.auth = { kind: 'user' };
                return next();
            }
        }

        const guestToken = authService.parseCookieHeader
            ? authService.parseCookieHeader(req.headers && req.headers.cookie, authService.GUEST_COOKIE_NAME)
            : authService.readCookie(req, authService.GUEST_COOKIE_NAME);
        if (guestToken) {
            const resolved = await authService.resolveGuest(guestToken);
            if (resolved) {
                req.guest = resolved.guest;
                req.workspace = resolved.workspace; // includes status/expiresAt
                req.auth = { kind: 'guest' };
                // Activity-based retention: every request bumps the deadline.
                if (resolved.workspace.status === 'active') {
                    await authService.touchGuestWorkspace(resolved.workspace.id);
                }
                return next();
            }
        }

        // First visit (no cookies): a WRITE under /api/v1 becomes a guest so
        // the content just created persists inside an owned temporary
        // workspace. GET/HEAD stay pre-auth (legacy "list all" behaviour, no
        // throwaway workspace on mere browsing); DELETE needs no fresh
        // identity. Outside /api/v1 (/health, /metrics, /gpu/*) stays
        // unauthenticated.
        //
        // EXEMPT: /api/v1/worker* — machine/worker-facing surface. Anonymous
        // writes there must never auto-provision guest + workspace rows (the
        // removed legacy heartbeat endpoint was exactly that DB-churn
        // vector). Worker identity uses its own credential namespace (wrk.*),
        // never guest auto-provision.
        // EXEMPT: /api/v1/ai-connector* — same doctrine for the Local AI
        // Connector (LAC): registration/lifecycle routes are users-only (a
        // guest workspace must never own long-lived llmc.* credentials), and
        // an anonymous probe must not mint a guest workspace per hit.
        const isContentWrite = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
        if (isContentWrite && req.path && req.path.startsWith('/api/v1')
            && !req.path.startsWith('/api/v1/auth')
            && !req.path.startsWith('/api/v1/worker')
            && !req.path.startsWith('/api/v1/ai-connector')
            && !req.path.startsWith('/api/v1/admin')) {
            const created = await authService.createGuest();
            req.guest = { guestId: created.guestId };
            req.workspace = { ...created.workspace, status: 'active', expiresAt: created.workspaceExpiresAt };
            req.auth = { kind: 'guest' };
            res.setHeader('Set-Cookie', authService.guestCookieHeader(created.token, { secure: isHttpsRequest(req) }));
        }
    } catch (err) {
        console.error('[AUTH-CONTEXT] identity resolution failed (anonymous for this request):', err.message);
    }
    next();
}

/** Production/HTTPS detection (transport concern — stays host-side). */
function isHttpsRequest(req) {
    if (process.env.NODE_ENV === 'production') return true;
    const proto = (req.headers && req.headers['x-forwarded-proto']) || '';
    return proto.split(',')[0].trim() === 'https';
}

/**
 * Require authentication middleware.
 * Returns 401 if no user is authenticated.
 * Use this for endpoints that require login.
 */
function requireAuth(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
}

/**
 * Require admin middleware (System AI Control / Admin Foundation).
 * Grants access when the authenticated user has role='admin' OR their
 * username is listed in the ADMIN_USERNAMES env allowlist (comma-separated,
 * case-insensitive). Guests and regular users get 403; anonymous gets 401.
 * The allowlist exists so an operator can grant admin before a password
 * login exists for the seeded account (the seeded 'developer' user has no
 * password and cannot log in yet).
 */
function requireAdmin(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    const allowlist = (process.env.ADMIN_USERNAMES || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
    const isAdminRole = req.user.role === 'admin';
    const inAllowlist = allowlist.includes(String(req.user.username || '').toLowerCase());
    if (!isAdminRole && !inAllowlist) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

/**
 * Require workspace membership middleware.
 * Checks that the authenticated user is a member of the workspace.
 * Use this for workspace-scoped endpoints.
 */
function requireWorkspaceMembership(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    const workspaceId = req.workspace?.id || req.params.workspaceId;
    if (!workspaceId) {
        return res.status(400).json({ error: 'Workspace ID required' });
    }

    next();
}

/**
 * Book access authorization helper — adapter over the canonical decision
 * layer. Same contract as the historical implementation: workspace|null,
 * throws WorkspaceExpiredError (410) for an expired guest workspace.
 * Reads identity from req and delegates; NO decision logic here.
 *
 * @returns {Promise<object|null>} Workspace if authorized, null otherwise
 */
async function checkBookAccess(req, bookId) {
    return authService.accessibleBookWorkspace(identityOf(req), bookId);
}

/**
 * Require book access middleware factory.
 * Sets req.bookWorkspace when authorized.
 * 403 on ownership mismatch, 410 for an expired guest workspace.
 *
 * @param {string} bookIdParam - Parameter name containing bookId (default: 'bookId')
 */
function requireBookAccess(bookIdParam = 'bookId') {
    return async (req, res, next) => {
        const bookId = req.params[bookIdParam];
        if (!bookId) {
            return res.status(400).json({ error: 'Book ID required' });
        }

        let workspace = null;
        try {
            workspace = await checkBookAccess(req, bookId);
        } catch (err) {
            if (err instanceof authService.WorkspaceExpiredError) {
                return res.status(410).json({ error: 'Guest workspace expired', code: 'workspace_expired' });
            }
            console.error(`[AUTH-CONTEXT] checkBookAccess(${bookId}) failed:`, err.message);
            return next();
        }
        if (!workspace) {
            return res.status(403).json({ error: 'Access denied: not a member of the book\'s workspace' });
        }

        req.bookWorkspace = workspace;
        next();
    };
}

/**
 * Async-resolving book guard for non-Express app shapes: resolves the
 * workspace the current user may access `bookId` through (or null).
 * On ownership DB failure the guard DISALLOWS for authenticated users
 * (fail closed), while pre-auth requests keep flowing.
 */
async function getAccessibleBookWorkspace(req, bookId) {
    if (!hasIdentity(req)) return { ok: true, workspace: null, mode: 'pre-auth' };
    try {
        const ws = await checkBookAccess(req, bookId);
        return ws
            ? { ok: true, workspace: ws, mode: req.guest ? 'guest' : 'auth' }
            : { ok: false, workspace: null, mode: req.guest ? 'guest' : 'auth' };
    } catch (err) {
        if (err instanceof authService.WorkspaceExpiredError) {
            return { ok: false, status: 410, workspace: null, mode: 'expired' };
        }
        console.error(`[AUTH-CONTEXT] getAccessibleBookWorkspace(${bookId}) failed:`, err.message);
        return { ok: false, workspace: null, mode: req.guest ? 'guest' : 'auth' }; // fail closed
    }
}

/**
 * Hash-dedup tenant guard for authenticated imports: re-importing the same
 * source file may only return a book the caller owns. Applies to users AND
 * guests — an identity must never receive another identity's book through
 * dedup. Pre-auth (no identity) keeps the historical dedup behaviour.
 * @param {object} req
 * @param {string} candidateBookId
 * @returns {Promise<boolean>} true when the caller may reuse that book
 */
async function dedupOwnedByCaller(req, candidateBookId) {
    if (!hasIdentity(req)) return true;
    try {
        const ws = await checkBookAccess(req, candidateBookId);
        return !!ws;
    } catch (err) {
        if (err instanceof authService.WorkspaceExpiredError) return false;
        console.error(`[AUTH-CONTEXT] dedupOwnedByCaller(${candidateBookId}) failed:`, err.message);
        return false; // fail closed
    }
}

/**
 * Book-creation authorization for authenticated imports (vbook bundles).
 * The bundle book_id is client-controlled: an authenticated (user OR guest)
 * re-import must never touch, overwrite or reveal a book owned by a foreign
 * workspace. Adapter over the canonical decision layer + the foreign-book
 * workspace lookup (workspaces port).
 * @param {object} req
 * @param {string} bookId
 * @param {object} [opts]
 * @param {boolean} [opts.diskCopyExists] - caller already knows a disk copy
 * @returns {Promise<{allowed:boolean, status?:number, error?:string}>}
 */
async function importBookAllowed(req, bookId, { diskCopyExists = false } = {}) {
    if (!hasIdentity(req) || !bookId) return { allowed: true }; // pre-auth: unchanged

    if (req.guest && req.workspace && req.workspace.status === 'expired') {
        return { allowed: false, status: 410, error: 'Guest workspace expired' };
    }
    try {
        const owned = await checkBookAccess(req, bookId);
        if (owned) return { allowed: true };
        const foreignWs = await authService.getWorkspaceIdForBook(bookId);
        if (foreignWs) {
            return { allowed: false, status: 403, error: 'Book belongs to another workspace' };
        }
        if (diskCopyExists) {
            // Copy on disk but no ownership row (PG outage / legacy gap):
            // cannot prove the caller may touch it — fail closed.
            return { allowed: false, status: 403, error: 'Book ownership could not be verified' };
        }
        return { allowed: true };
    } catch (err) {
        if (err instanceof authService.WorkspaceExpiredError) {
            return { allowed: false, status: 410, error: 'Guest workspace expired' };
        }
        console.error(`[AUTH-CONTEXT] importBookAllowed(${bookId}) failed:`, err.message);
        return { allowed: false, status: 403, error: 'Book ownership could not be verified' };
    }
}

/**
 * Get the current user from request context.
 * @param {object} req
 * @returns {object|null} User object or null
 */
function getCurrentUser(req) {
    return req.user || null;
}

/**
 * Get the current workspace from request context.
 * @param {object} req
 * @returns {object|null} Workspace object or null
 */
function getCurrentWorkspace(req) {
    return req.workspace || null;
}

module.exports = {
    authContext,
    requireAuth,
    requireAdmin,
    requireWorkspaceMembership,
    checkBookAccess,
    requireBookAccess,
    getAccessibleBookWorkspace,
    dedupOwnedByCaller,
    importBookAllowed,
    hasIdentity,
    WorkspaceExpiredError: authService.WorkspaceExpiredError,
    getCurrentUser,
    getCurrentWorkspace,
};
