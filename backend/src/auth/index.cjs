// ======================================================
// AUTH HOST WIRING (Auth Extraction Phase 1) — composition root + shim
// ======================================================
// The ONE host-side binding point of the auth domain (audit §12 phase 2):
// resolves env once, binds the concrete PG adapters to the domain ports,
// and exposes the historical `authService` module.exports shape so every
// existing consumer keeps working unchanged.
//
// AFTER the physical extraction this file remains the host shim: the domain
// (auth/core.js + book-access.js + cookies.js + auth-errors.js +
// auth-config.js + password.js) moves to packages/animastor/auth and this
// module becomes `createAuthService({ ports: boundHostRepos, config:
// fromEnv() })` — zero consumer churn.
//
// Domain-side env policy (audit §7): NO module under auth/** reads
// process.env except THIS wiring — the domain receives the ready config.
// ======================================================

'use strict';

const { createAuthService } = require('./core');
const { normalizeCookieDomain, DAY_MS } = require('./auth-config');
const cookies = require('./cookies');
const { AuthError, WorkspaceExpiredError } = require('./auth-errors');
const password = require('./password');

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
        guestWorkspaceTtlMs: Math.max(1, Number(env.GUEST_WORKSPACE_TTL_DAYS ?? 7)) * DAY_MS,
        guestWorkspaceGraceMs: Math.max(0, Number(env.GUEST_WORKSPACE_GRACE_PERIOD_DAYS ?? 23)) * DAY_MS,
        guestSessionTtlMs: Math.max(1, Number(env.GUEST_SESSION_TTL_DAYS ?? 30)) * DAY_MS,
        cookieDomain: normalizeCookieDomain(env.COOKIE_DOMAIN),
    };
}

/** The concrete PG adapters for the domain ports (audit §6). */
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
    // suite relies on it). The domain core stays env-free — the host bridge
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

module.exports = authService;
// Exposed for tests + the future physical move (host composes, never re-derives).
module.exports.buildAuthService = buildAuthService;
module.exports.buildAuthPorts = buildAuthPorts;
module.exports.authConfigFromEnv = authConfigFromEnv;
module.exports.AuthError = AuthError;
module.exports.WorkspaceExpiredError = WorkspaceExpiredError;
module.exports.password = password;
