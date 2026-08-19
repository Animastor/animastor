// ======================================================
// Workspace Ownership Resolver
// ======================================================
// Single point of resolution for "which workspace owns this book".
// Pre-auth mode: every book resolves to the seeded default (developer)
// workspace. When auth lands, this resolver swaps in per-user resolution
// without touching callers.
// ======================================================

const userRepo = require('../storage/postgres/repositories/user-repo');
const workspaceRepo = require('../storage/postgres/repositories/workspace-repo');
const bookRepo = require('../storage/postgres/repositories/book-repo');

const DEFAULT_OWNER_USERNAME = 'developer';

let _defaultWorkspace = null;

/**
 * Default workspace for pre-auth book ownership (developer personal workspace).
 * Cached after first successful lookup; retried on failure.
 * @returns {Promise<object|null>}
 */
async function defaultWorkspace() {
    if (_defaultWorkspace) return _defaultWorkspace;
    try {
        const devUser = await userRepo.findByUsername(DEFAULT_OWNER_USERNAME);
        if (!devUser) return null; // not seeded yet (fresh DB, migrations pending)
        const workspace = await workspaceRepo.findPersonalWorkspace(devUser.user_id);
        if (workspace) _defaultWorkspace = workspace;
        return workspace;
    } catch (err) {
        console.error('[WORKSPACE-OWNERSHIP] defaultWorkspace lookup failed:', err.message);
        return null;
    }
}

/**
 * Resolve (and create if needed) the books.workspace_id for a book.
 *
 * 1. Book row has a workspace → return it.
 * 2. Book row exists without workspace → attach the preferred/default
 *    workspace (never overwrites a concurrent attach).
 * 3. No book row → create the registry row bound to that workspace.
 *
 * @param {string} bookId
 * @param {object} [options]
 * @param {string} [options.bookTitle] - Title for the registry row on creation
 * @param {string} [options.preferredWorkspaceId] - Workspace to attach when the
 *   book is unowned (e.g. req.workspace.id once auth lands). Defaults to the
 *   seeded developer workspace.
 * @returns {Promise<string|null>} workspace_id (UUID) or null when unresolvable
 */
async function resolveWorkspaceForBook(bookId, options = {}) {
    const { bookTitle, preferredWorkspaceId } = options;
    if (!bookId) return null;
    try {
        const existing = await bookRepo.getWorkspaceId(bookId);
        if (existing) return existing;

        const targetId = preferredWorkspaceId || (await defaultWorkspace())?.id;
        if (!targetId) return null;

        const attached = await bookRepo.attachWorkspaceIfMissing(bookId, targetId);
        if (attached) return targetId;

        // Row may have appeared concurrently — re-check before creating.
        const rechecked = await bookRepo.getWorkspaceId(bookId);
        if (rechecked) return rechecked;

        await bookRepo.ensureBook(bookId, bookTitle || null, null, null, targetId);
        return targetId;
    } catch (err) {
        console.error(`[WORKSPACE-OWNERSHIP] resolveWorkspaceForBook(${bookId}) failed:`, err.message);
        return null;
    }
}

/** Testing helper: drop cached default workspace. */
function resetCache() {
    _defaultWorkspace = null;
}

module.exports = { defaultWorkspace, resolveWorkspaceForBook, resetCache, DEFAULT_OWNER_USERNAME };
