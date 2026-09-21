// ======================================================
// AUTH ERROR CONTRACT (Auth Extraction Phase 1)
// ======================================================
// The error vocabulary of the auth domain, split out of
// auth-service/auth-context into a zero-dependency module. This is the file
// a future @animastor/auth exports as-is: no Express, no storage, no env.
//
// Semantics are FROZEN (docs/architecture/auth-extraction-readiness-audit.md
// §9 invariants 2 & 8):
//   - AuthError.status       → the HTTP status the caller maps 1:1
//   - AuthError.reason       → loggable category, never credentials; it IS
//                              part of the wire contract ({error, reason})
//   - WorkspaceExpiredError  → 410 'workspace_expired' sentinel the guards
//                              catch to answer expired guest workspaces
// ======================================================

'use strict';

/**
 * Domain error carrying its own HTTP status + loggable reason category.
 * Thrown by the auth core (register/login/...); consumed by the HTTP
 * adapter (auth-routes) via instanceof — keep it a real class, never a
 * factory returning plain Errors.
 */
class AuthError extends Error {
    constructor(status, message, reason) {
        super(message);
        this.status = status;
        this.reason = reason; // loggable category, never the credentials
    }
}

/** Sentinel thrown by access checks on an expired guest workspace. */
class WorkspaceExpiredError extends Error {
    constructor() {
        super('workspace_expired');
        this.status = 410;
        this.code = 'workspace_expired';
    }
}

module.exports = { AuthError, WorkspaceExpiredError };
