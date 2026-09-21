// ======================================================
// AUTH HOST WIRING — composition root shim over @animastor/auth
// ======================================================
// The single host-side binding point of the auth domain. The DOMAIN lives
// in the @animastor/auth package (packages/animastor-auth — no Express, no
// PostgreSQL, no process.env inside); THIS module is the composition root:
//
//     @animastor/auth (domain)
//        ↓  createAuthService({ ports, config })
//     backend ports/adapters (PG repos, registrationTx, workspace-ownership)
//        ↓
//     compatibility API (the historical authService export shape)
//
// Every existing consumer keeps its require path and the exact method
// surface — auth-context, auth-routes and the test suites are unchanged.
//
// Env policy: the ONLY process.env reads in auth/** happen here (the host
// resolves config; the package never touches the environment).
// ======================================================

'use strict';

const { createAuthService, normalizeCookieDomain, cookies, password } = require('@animastor/auth');
const { AuthError, WorkspaceExpiredError } = require('@animastor/auth');

const userRepo = require('../storage/postgres/repositories/user-repo');
const workspaceRepo = require('../storage/postgres/repositories/workspace-repo');
const sessionRepo = require('../storage/postgres/repositories/session-repo');
const guestRepo = require('../storage/postgres/repositories/guest-repo');
const bookRepo = require('../storage/postgres/repositories/book-repo');
const registrationTx = require('../storage/postgres/repositories/registration-tx');
const workspaceOwnership = require('../middleware/workspace-ownership');

/** Host env resolution — the only process.env reads in the auth domain. */
function authConfigFromEnv(env = process.env) {
    return {
        sessionCookieName: cookies.SESSION_COOKIE_NAME,
        guestCookieName: cookies.GUEST_COOKIE_NAME,
        sessionTtlMs: cookies.SESSION_TTL_MS, // 30d — hardcoded today (audit §7)
        guestWorkspaceTtlMs: Math.max(1, Number(env.GUEST_WORKSPACE_TTL_DAYS ?? 7)) * 24 * 60 * 60 * 1000,
        guestWorkspaceGraceMs: Math.max(0, Number(env.GUEST_WORKSPACE_GRACE_PERIOD_DAYS ?? 23)) * 24 * 60 * 60 * 1000,
        guestSessionTtlMs: Math.max(1, Number(env.GUEST_SESSION_TTL_DAYS ?? 30)) * 24 * 60 * 60 * 1000,
        cookieDomain: normalizeCookieDomain(env.COOKIE_DOMAIN),
    };
}

/** The concrete PG adapters for the package ports (audit §6). */
function buildAuthPorts() {
    return {
        users: {
            findByUsernameCanonical: userRepo.findByUsernameCanonical,
            findByEmail: userRepo.findByEmail,
        },
        sessions: {
            createSession: sessionRepo.createSession,
            findByToken: sessionRepo.findByToken,
            revokeByToken: sessionRepo.revokeByToken,
        },
        guests: {
            createGuest: guestRepo.createGuest,
            findByToken: guestRepo.findByToken,
            touchWorkspaceActivity: guestRepo.touchWorkspaceActivity,
            revokeByToken: guestRepo.revokeByToken,
        },
        workspaces: {
            findById: workspaceRepo.findById,
            checkBookAccess: workspaceRepo.checkBookAccess,
            getMembership: workspaceRepo.getMembership,
            getWorkspaceIdForBook: workspaceRepo.getWorkspaceIdForBook,
            findPersonalWorkspace: workspaceRepo.findPersonalWorkspace,
            createWorkspace: workspaceRepo.createWorkspace,
            renameWorkspace: workspaceRepo.renameWorkspace,
        },
        bookOwnership: {
            // Authorization leg: workspace-ownership with allowCreate:false —
            // returns the book's workspace, self-heal-attaches NULL rows, never
            // seeds registry rows for unknown ids (historical semantics).
            resolveAccessWorkspace: (bookId, opts = {}) => workspaceOwnership.resolveWorkspaceForBook(bookId, opts),
            getWorkspaceId: bookRepo.getWorkspaceId,
        },
        registrationTx: {
            registerUserWithWorkspace: registrationTx.registerUserWithWorkspace,
        },
    };
}

/**
 * Rebuild the service (tests swap the singleton via require.cache of THIS
 * module — same discipline as any host wiring module).
 */
function buildAuthService() {
    const svc = createAuthService({ ports: buildAuthPorts(), config: authConfigFromEnv() });
    // Compatibility bridge: the historical auth-service resolved COOKIE_DOMAIN
    // at CALL time (env may change after boot; the auth-mvp cookie contract
    // suite relies on it). The package stays env-free — the host shim
    // re-resolves the cookie domain per call for the four cookie wrappers.
    // All other config (TTLs, names) remains a boot-time snapshot, matching
    // the historical module-level consts.
    const liveCookieConfig = () => ({ ...svc._config, cookieDomain: normalizeCookieDomain(process.env.COOKIE_DOMAIN) });
    svc.sessionCookieHeader = (token, opts) => cookies.sessionCookieHeader(token, opts, liveCookieConfig());
    svc.clearSessionCookieHeader = (opts) => cookies.clearSessionCookieHeader(opts, liveCookieConfig());
    svc.guestCookieHeader = (token, opts) => cookies.guestCookieHeader(token, opts, liveCookieConfig());
    svc.clearGuestCookieHeader = (opts) => cookies.clearGuestCookieHeader(opts, liveCookieConfig());
    return svc;
}

const authService = buildAuthService();
// Historical namespace properties on authService (pre-extraction auth-service
// exported `cookies` and `password` as its own module-level namespaces).
// Package rebind only — zero domain code in the host.
authService.cookies = cookies;
authService.password = password;

module.exports = authService;
// Exposed for tests + future hosts (host composes, never re-derives).
module.exports.buildAuthService = buildAuthService;
module.exports.buildAuthPorts = buildAuthPorts;
module.exports.authConfigFromEnv = authConfigFromEnv;
module.exports.AuthError = AuthError;
module.exports.WorkspaceExpiredError = WorkspaceExpiredError;
