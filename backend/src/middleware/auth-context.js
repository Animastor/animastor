// ======================================================
// Auth Context Middleware
// ======================================================
// Identity resolution for every request (Authentication MVP):
//
//   request → session cookie → sessions lookup (PG) → user → workspace
//                                                     → req.user / req.workspace
//
// Pre-auth compatibility: a request without a valid session keeps req.user =
// null and everything behaves as before (no global requireAuth). Authenticated
// requests get real identity and their book endpoints become workspace-scoped.
//
// Also provides:
// - requireAuth / requireWorkspaceMembership / requireBookAccess middleware
// - checkBookAccess helper (pre-auth: allow all; authed: membership check)

const workspaceRepo = require('../storage/postgres/repositories/workspace-repo');
const authService = require('../auth/auth-service');
const workspaceOwnership = require('./workspace-ownership');

/**
 * Authentication context middleware.
 * Resolves the HttpOnly session cookie into req.user / req.workspace.
 * Unauthenticated → null context (pre-auth behaviour preserved).
 * Session lookup failures degrade to anonymous instead of 500-ing every
 * request during a transient PG outage.
 */
async function authContext(req, res, next) {
    req.user = null;
    req.workspace = null;
    try {
        const token = authService.readCookie(req, authService.SESSION_COOKIE_NAME);
        if (token) {
            const resolved = await authService.resolveSession(token);
            if (resolved) {
                req.user = resolved.user;
                req.workspace = resolved.workspace;
            }
        }
    } catch (err) {
        console.error('[AUTH-CONTEXT] session lookup failed (anonymous for this request):', err.message);
    }
    next();
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
 * Book access authorization helper.
 * Pre-auth (no req.user): access allowed everywhere (existing behaviour).
 * Authenticated: the book must belong to a workspace the user is a member of.
 * Books with no owned row yet (created pre-ownership or during a PG outage)
 * are self-healed to the caller's workspace — never overwriting another
 * owner's workspace.
 *
 * @param {object} req - Express request
 * @param {string} bookId - Book ID to check access for
 * @returns {Promise<object|null>} Workspace if authorized, null otherwise
 */
async function checkBookAccess(req, bookId) {
    if (!req.user) {
        // Pre-auth mode: allow access to all books.
        return { id: 'anonymous', name: 'Anonymous', type: 'temporary' };
    }

    if (req.workspace && req.workspace.id) {
        const wsId = await workspaceOwnership.resolveWorkspaceForBook(bookId, {
            preferredWorkspaceId: req.workspace.id,
            // Authorization paths must not seed registry rows for unknown ids.
            allowCreate: false,
        });
        if (wsId) {
            if (wsId === req.workspace.id) {
                return req.workspace;
            }
            // Book belongs elsewhere — check for membership in that workspace
            // (collaboration-ready, though today only personal memberships
            // exist).
            const membership = await workspaceRepo.getMembership(wsId, req.user.userId);
            if (membership) return await workspaceRepo.findById(wsId);
            return null;
        }
        return null;
    }

    const workspaceId = await workspaceRepo.checkBookAccess(bookId, req.user.userId);
    if (!workspaceId) {
        return null;
    }

    const workspace = await workspaceRepo.findById(workspaceId);
    return workspace;
}

/**
 * Require book access middleware factory.
 * Sets req.bookWorkspace when authorized. 403 on ownership mismatch.
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
    if (!req.user) return { ok: true, workspace: null, mode: 'pre-auth' };
    try {
        const workspaceId = await workspaceRepo.checkBookAccess(bookId, req.user.userId);
        if (!workspaceId) return { ok: false, workspace: null, mode: 'auth' };
        const workspace = await workspaceRepo.findById(workspaceId);
        return { ok: true, workspace, mode: 'auth' };
    } catch (err) {
        console.error(`[AUTH-CONTEXT] getAccessibleBookWorkspace(${bookId}) failed:`, err.message);
        return { ok: false, workspace: null, mode: 'auth' }; // fail closed
    }
}

/**
 * Hash-dedup tenant guard for authenticated imports: re-importing the same
 * source file may only return a book the caller owns. Pre-auth keeps the
 * historical dedup behaviour.
 * @param {object} req
 * @param {string} candidateBookId
 * @returns {Promise<boolean>} true when the caller may reuse that book
 */
async function dedupOwnedByCaller(req, candidateBookId) {
    if (!req.user) return true;
    try {
        const ws = await checkBookAccess(req, candidateBookId);
        return !!ws;
    } catch (err) {
        console.error(`[AUTH-CONTEXT] dedupOwnedByCaller(${candidateBookId}) failed:`, err.message);
        return false; // fail closed
    }
}

/**
 * Book-creation authorization for authenticated imports (vbook bundles).
 * The bundle book_id is client-controlled: an authenticated re-import must
 * never touch, overwrite or reveal a book owned by a foreign workspace.
 * @param {object} req
 * @param {string} bookId
 * @param {object} [opts]
 * @param {boolean} [opts.diskCopyExists] - caller already knows a disk copy
 * @returns {Promise<{allowed:boolean, status?:number, error?:string}>}
 */
async function importBookAllowed(req, bookId, { diskCopyExists = false } = {}) {
    if (!req.user || !bookId) return { allowed: true }; // pre-auth: unchanged
    try {
        const owned = await checkBookAccess(req, bookId);
        if (owned) return { allowed: true };
        const foreignWs = await workspaceRepo.getWorkspaceIdForBook(bookId);
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
    requireWorkspaceMembership,
    checkBookAccess,
    requireBookAccess,
    getAccessibleBookWorkspace,
    dedupOwnedByCaller,
    importBookAllowed,
    getCurrentUser,
    getCurrentWorkspace,
};
