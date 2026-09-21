// ======================================================
// BOOK ACCESS DECISION — canonical authorization layer (Extraction Phase 1)
// ======================================================
// The ONE decision layer for "may this identity access this book?".
// audit blocker §13.1 resolved: the previously divergent
// `auth-service.bookAccessDecision` (req-free but semantically weak, zero
// consumers) and `auth-context.checkBookAccess` (the real semantics, but
// Express-coupled) are consolidated HERE, identity-based, over injected
// ports. The Express middleware (auth-context) becomes a thin adapter.
//
// Semantics FROZEN — behaviour identical to the historical paths:
//   pre-auth (no identity)        → ok, mode 'pre-auth', anonymous sentinel
//   user:  ownership via the
//          bookOwnership port
//          (resolveWorkspaceForBook semantics: existing attach, self-heal
//          attach for NULL-workspace rows, allowCreate:false) → own ws | ok
//          cross-workspace membership fallback (getMembership + findById) → ok
//          legacy direct membership chain (checkBookAccess port) fallback → ok
//          none → 403 'denied'; port error → 403 'denied' (FAIL CLOSED)
//   guest: workspace expired     → 410 'expired'
//          book in guest ws      → ok 'guest'
//          otherwise             → 403 'denied'; port error → 410 'expired'
//          (FAIL CLOSED, historical guest-path behaviour)
//
// Result shape (frozen contract): { ok, status?, mode, workspace? }
//   mode ∈ 'pre-auth' | 'user' | 'guest' | 'expired' | 'denied'
// ======================================================

'use strict';

const { WorkspaceExpiredError } = require('./auth-errors');

/** Historical pre-auth sentinel (consumers pin {id:'anonymous'}). */
const ANONYMOUS_WORKSPACE = Object.freeze({ id: 'anonymous', name: 'Anonymous', type: 'temporary' });

/**
 * @param {object|null} identity - { user } | { guest, workspace } | null —
 *   plain objects, NEVER an Express req.
 * @param {string} bookId
 * @param {object} ports - { workspaces, bookOwnership } (see auth/index.cjs)
 * @param {object} [log] - { error } logger
 * @returns {Promise<{ok:boolean, status?:number, mode:string, workspace?:object|null}>}
 */
async function decideBookAccess(identity, bookId, ports, log = console) {
    if (!identity || (!identity.user && !identity.guest)) {
        // Pre-auth mode: allow access to all books (unchanged legacy behaviour;
        // the book LIST filters workspace-owned books for anonymous visitors).
        return { ok: true, mode: 'pre-auth', workspace: ANONYMOUS_WORKSPACE };
    }

    if (identity.user) {
        return decideUserBookAccess(identity.user, identity.workspace, bookId, ports, log);
    }

    // ── guest path ──
    const gws = identity.workspace;
    if (gws && gws.status === 'expired') {
        return { ok: false, status: 410, mode: 'expired', workspace: null };
    }
    try {
        const bookWsId = await ports.bookOwnership.getWorkspaceId(bookId);
        if (bookWsId !== gws.id) {
            return { ok: false, status: 403, mode: 'denied', workspace: null };
        }
        return { ok: true, mode: 'guest', workspace: gws };
    } catch (err) {
        log.error(`[AUTH] guest bookAccessDecision(${bookId}) failed:`, err.message);
        return { ok: false, status: 410, mode: 'expired', workspace: null }; // fail closed
    }
}

/**
 * User path — the exact historical checkBookAccess user semantics:
 *   1. req.workspace known → resolveWorkspaceForBook(allowCreate:false) —
 *      returns the book's existing workspace, self-heal-attaches a workspace
 *      to NULL-workspace rows, never creates registry rows. Own ws → allow.
 *      Foreign ws → membership in THAT workspace may still allow
 *      (collaboration-ready).
 *   2. Legacy fallback: direct membership chain checkBookAccess(bookId,userId).
 * Fail-closed on any port error for authenticated users.
 */
async function decideUserBookAccess(user, reqWorkspace, bookId, ports, log = console) {
    try {
        if (reqWorkspace && reqWorkspace.id) {
            const wsId = await ports.bookOwnership.resolveAccessWorkspace(bookId, {
                preferredWorkspaceId: reqWorkspace.id,
                // Authorization paths must not seed registry rows for unknown ids.
                allowCreate: false,
            });
            if (wsId) {
                if (wsId === reqWorkspace.id) {
                    return { ok: true, mode: 'user', workspace: reqWorkspace };
                }
                // Book belongs elsewhere — membership in that workspace could
                // still allow access (collaboration-ready).
                const membership = await ports.workspaces.getMembership(wsId, user.userId);
                if (membership) {
                    return { ok: true, mode: 'user', workspace: await ports.workspaces.findById(wsId) };
                }
                return { ok: false, status: 403, mode: 'denied', workspace: null };
            }
            // Ownership unresolvable via the resolver — legacy direct chain.
            const workspaceId = await ports.workspaces.checkBookAccess(bookId, user.userId);
            if (!workspaceId) {
                return { ok: false, status: 403, mode: 'denied', workspace: null };
            }
            return { ok: true, mode: 'user', workspace: await ports.workspaces.findById(workspaceId) };
        }

        // No workspace on the identity — straight to the legacy chain.
        const workspaceId = await ports.workspaces.checkBookAccess(bookId, user.userId);
        if (!workspaceId) {
            return { ok: false, status: 403, mode: 'denied', workspace: null };
        }
        return { ok: true, mode: 'user', workspace: await ports.workspaces.findById(workspaceId) };
    } catch (err) {
        log.error(`[AUTH] bookAccessDecision(${bookId}) failed:`, err.message);
        return { ok: false, status: 403, mode: 'denied', workspace: null }; // fail closed
    }
}

/**
 * Convenience for the workspace-returning consumers (checkBookAccess
 * adapters, player assertBookAccess port): decision → workspace|null.
 * @returns {Promise<object|null>} workspace when authorized
 * @throws {WorkspaceExpiredError} on an expired guest workspace (410 semantics)
 */
async function authorizedWorkspace(identity, bookId, ports, log = console) {
    if (identity && identity.guest && identity.workspace && identity.workspace.status === 'expired') {
        // Historical behaviour: throw BEFORE any port call so unknown books
        // under an expired workspace still surface 410 (guest-workspace.test
        // §12 pins this exact ordering).
        throw new WorkspaceExpiredError();
    }
    const decision = await decideBookAccess(identity, bookId, ports, log);
    if (decision.ok) return decision.workspace;
    if (decision.status === 410) throw new WorkspaceExpiredError();
    return null;
}

module.exports = { decideBookAccess, decideUserBookAccess, authorizedWorkspace, ANONYMOUS_WORKSPACE };
