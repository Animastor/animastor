// ======================================================
// @animastor/auth — PACKAGE ENTRYPOINT (public API)
// ======================================================
// The identity/session/authorization domain of the Animastor backend,
// physically extracted from the host (docs/architecture/
// auth-extraction-readiness-audit.md §16 — phase 3 of the migration plan).
//
// The package owns:
//   - core.js        — createAuthService: register (with guest→account
//                      in-place conversion), login/logout, session and
//                      guest-identity lifecycle, resolveDefaultWorkspace
//                      self-heal, config-bound cookie wrappers;
//   - book-access.js — THE canonical authorization decision layer
//                      (decideBookAccess / authorizedWorkspace, the
//                      consolidated checkBookAccess semantics);
//   - cookies.js     — the frozen cookie grammar (animastor_sid /
//                      animastor_gid builders + parseCookieHeader);
//   - auth-config.js — the normalized config contract
//                      (DEFAULT_AUTH_CONFIG / normalizeAuthConfig);
//   - auth-errors.js — AuthError + WorkspaceExpiredError (frozen status /
//                      reason semantics);
//   - password.js    — scrypt hash/verify/policy (timing-equalized);
//   - ports.js       — assertAuthPorts: the repository port contract
//                      validators (users/sessions/guests/workspaces/
//                      bookOwnership/registrationTx).
//
// The package imports NOTHING from the backend host: no Express, no
// PostgreSQL, no process.env, no storage repositories, no worker-auth, no
// filesystem — only node:crypto. Every persistence and platform leg arrives
// as an injected port at createAuthService() time; configuration arrives as
// a plain object (normalized in-package). The HOST composition root binds:
//   user/session/guest/workspace repositories, the registration
//   unit-of-work (registrationTx.registerUserWithWorkspace), the
//   book-ownership resolver (resolveAccessWorkspace/getWorkspaceId) and the
//   env-resolved config.
//
// Installing this package in another host requires NO PostgreSQL and NO
// Express — only adapters satisfying assertAuthPorts(ports) and a config
// object.
//
// Guards: backend/tests/architecture/auth-package-boundary.test.js
//         (APB1–APB8 — package closure, no reverse imports, env-free,
//         manifest freeze, frozen export surface).
// ======================================================

'use strict';

const { createAuthService } = require('./core');
const { decideBookAccess, authorizedWorkspace, ANONYMOUS_WORKSPACE } = require('./book-access');
const cookies = require('./cookies');
const { DEFAULT_AUTH_CONFIG, normalizeAuthConfig, normalizeCookieDomain } = require('./auth-config');
const { AuthError, WorkspaceExpiredError } = require('./auth-errors');
const password = require('./password');
const { assertAuthPorts } = require('./ports');

module.exports = {
    // factory
    createAuthService,
    // canonical authorization
    decideBookAccess,
    authorizedWorkspace,
    ANONYMOUS_WORKSPACE,
    // contracts
    AuthError,
    WorkspaceExpiredError,
    // config contract
    DEFAULT_AUTH_CONFIG,
    normalizeAuthConfig,
    normalizeCookieDomain,
    // cookie grammar
    cookies,
    // password primitives
    password,
    // port contracts
    assertAuthPorts,
};

// The frozen public API is the object above: exactly 12 named exports
// (createAuthService, decideBookAccess, authorizedWorkspace,
// ANONYMOUS_WORKSPACE, AuthError, WorkspaceExpiredError,
// DEFAULT_AUTH_CONFIG, normalizeAuthConfig, normalizeCookieDomain,
// cookies, password, assertAuthPorts). APB-G7 and the package contract
// tests pin this list — add new capabilities WITH a guard/test update.
// `REQUIRED`/`assertPort` (ports.js) stay package-internal: hosts assert
// through assertAuthPorts; direct per-port validation is not public API.
