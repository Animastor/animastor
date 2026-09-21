// ======================================================
// AUTH REPOSITORY PORT CONTRACTS (Auth Extraction Phase 1)
// ======================================================
// The runtime contract checks for the auth domain's injected ports — the
// `assertSessionRepo` pattern from @animastor/assistant (packages/
// animastor-assistant/src/session-repo-contract.cjs). The composition root
// (auth/index.cjs) fails fast on a bad adapter instead of failing at
// request time.
//
// Method lists are the EXACT historical usage of the auth domain (audit §6)
// — nothing speculative. Concrete PostgreSQL implementations stay host-side:
//   storage/postgres/repositories/{user,session,guest,workspace}-repo.js
//   + the registration unit-of-work (registration-tx.js)
//   + workspace-ownership (the bookOwnership.resolveAccessWorkspace leg)
// ======================================================

'use strict';

const REQUIRED = {
    users: [
        'findByUsernameCanonical', // lower(username) unique lookup (register/login pre-checks)
        'findByEmail', // register email-uniqueness pre-check
    ],
    sessions: [
        'createSession', // (userId, expiresAtMs) → { sessionId, token, expiresAt }
        'findByToken', // raw token → live joined session row | null
        'revokeByToken', // idempotent revoke → boolean
    ],
    guests: [
        'createGuest', // ({ workspaceTtlMs, sessionTtlMs }) → identity + workspace + deadlines
        'findByToken', // raw token → guest + temporary workspace row | null
        'touchWorkspaceActivity', // (workspaceId, workspaceTtlMs) — extend-only deadline bump
        'revokeByToken', // idempotent revoke → boolean
    ],
    workspaces: [
        'findById', // workspace row by id
        'checkBookAccess', // (bookId, userId) → workspaceId|null (membership chain)
        'getMembership', // (workspaceId, userId) → membership row|null
        'getWorkspaceIdForBook', // (bookId) → workspaceId|null (foreign-book check)
        'findPersonalWorkspace', // (userId) → personal workspace row|null
    ],
    bookOwnership: [
        // (bookId, { preferredWorkspaceId, allowCreate:false }) → workspaceId|null
        // Host-implemented over middleware/workspace-ownership: existing attach,
        // self-heal attach for NULL-workspace rows, never seeds unknown ids.
        'resolveAccessWorkspace',
        // (bookId) → workspaceId|null — guest decision path (book-repo.getWorkspaceId)
        'getWorkspaceId',
    ],
    registrationTx: [
        // ONE PG transaction (host unit-of-work, storage/postgres/repositories/
        // registration-tx.js): INSERT users (ON CONFLICT lower(username) DO
        // NOTHING) + INSERT workspaces | in-place guest conversion (type→
        // 'personal', expires_at→NULL, owner→user, guests revoked) +
        // workspace_members owner row. Rolls back atomically on failure;
        // canonical-race surfaces as err unique violation → caller 409.
        'registerUserWithWorkspace',
    ],
};

/** Validate one port; returns the port for chaining. Throws with the missing names. */
function assertPort(port, names, label) {
    const missing = names.filter((m) => typeof port?.[m] !== 'function');
    if (missing.length > 0) {
        throw new Error(`${label}: missing required method(s): ${missing.join(', ')}`);
    }
    return port;
}

function assertAuthPorts(ports) {
    for (const [name, methods] of Object.entries(REQUIRED)) {
        assertPort(ports[name], methods, `authPorts.${name}`);
    }
    return ports;
}

module.exports = { REQUIRED, assertPort, assertAuthPorts };
