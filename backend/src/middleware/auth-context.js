// ======================================================
// Auth Context Middleware
// ======================================================
// Minimal foundation for future authentication system.
// Currently provides:
// - Identity context (req.user, req.workspace)
// - Book access authorization helper
// - Ownership resolution
//
// Future phases will add:
// - Session/cookie management
// - Password verification
// - Token refresh
// - OAuth integration

const workspaceRepo = require('../storage/postgres/repositories/workspace-repo');
const userRepo = require('../storage/postgres/repositories/user-repo');

/**
 * Authentication context middleware.
 * Sets req.user and req.workspace for authenticated requests.
 * Currently operates in "no-auth" mode (all requests are anonymous).
 *
 * When auth is implemented, this middleware will:
 * 1. Extract session/token from request
 * 2. Validate and resolve user
 * 3. Set req.user = { userId, username, role, ... }
 * 4. Set req.workspace = { id, name, type, ... }
 */
function authContext(req, res, next) {
    // TODO: In future phases, extract auth from cookie/header
    // For now, set empty context
    req.user = null;
    req.workspace = null;
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

    // For now, allow access (pre-auth mode)
    // When auth is implemented, check workspace_members table
    next();
}

/**
 * Book access authorization helper.
 * Checks that the authenticated user has access to the specified book.
 * This is the primary ownership check for book-related endpoints.
 *
 * @param {object} req - Express request
 * @param {string} bookId - Book ID to check access for
 * @returns {Promise<object|null>} Workspace if authorized, null otherwise
 */
async function checkBookAccess(req, bookId) {
    if (!req.user) {
        // Pre-auth mode: allow access to all books
        // When auth is implemented, return null for unauthenticated requests
        return { id: 'anonymous', name: 'Anonymous', type: 'temporary' };
    }

    const workspaceId = await workspaceRepo.checkBookAccess(bookId, req.user.userId);
    if (!workspaceId) {
        return null;
    }

    const workspace = await workspaceRepo.findById(workspaceId);
    return workspace;
}

/**
 * Require book access middleware.
 * Verifies that the authenticated user has access to the book.
 * Sets req.bookWorkspace if authorized.
 *
 * @param {string} bookIdParam - Parameter name containing bookId (default: 'bookId')
 */
function requireBookAccess(bookIdParam = 'bookId') {
    return async (req, res, next) => {
        const bookId = req.params[bookIdParam];
        if (!bookId) {
            return res.status(400).json({ error: 'Book ID required' });
        }

        const workspace = await checkBookAccess(req, bookId);
        if (!workspace) {
            return res.status(403).json({ error: 'Access denied: not a member of the book\'s workspace' });
        }

        req.bookWorkspace = workspace;
        next();
    };
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
    getCurrentUser,
    getCurrentWorkspace,
};
