// ======================================================
// AUTH SERVICE (Authentication MVP) — compatibility shim
// ======================================================
// The auth DOMAIN now lives in the @animastor/auth npm package
// (packages/animastor-auth): core lifecycle, the canonical book-access
// decision layer, the cookie grammar, the config/error contracts and the
// scrypt password primitives. The host binding is auth/index.cjs (PG
// repositories + registration unit-of-work + workspace-ownership + env
// config) and re-binds the historical `cookies`/`password` namespaces onto
// repositories + registration unit-of-work + workspace-ownership + env
// config); this file re-exports the wired singleton so all existing
// consumers (auth-context, auth-routes, 15+ test suites) keep their require
// path and behaviour unchanged.
//
// PostgreSQL implementations stay host-side:
//   storage/postgres/repositories/registration-tx.js  (unit-of-work port)
//   storage/postgres/repositories/user-repo.findByUsernameCanonical
//   storage/postgres/repositories/workspace-repo.renameWorkspace
// DIRECT_SQL_WHITELIST: no file in backend/src/auth holds a raw postgres
// handle (the guard's stale-entry rule enforces this).
//
// Semantics unchanged (audit §9): error/status codes, cookie attributes,
// guest lifecycle, conversion atomicity, fail-closed authorization.
// ======================================================

'use strict';

const wired = require('./index.cjs');
const { AuthError, WorkspaceExpiredError } = require('@animastor/auth');

// Re-export the wired singleton's surface (the historical authService shape).
const authService = wired;
module.exports = authService;

// Named re-exports preserved for destructuring consumers.
module.exports.AuthError = AuthError;
module.exports.WorkspaceExpiredError = WorkspaceExpiredError;
// Historical module-level namespaces (package rebinds, not copies):
// authService.cookies — the frozen cookie grammar; authService.password —
// the scrypt primitives.
module.exports.cookies = wired.cookies;
module.exports.password = wired.password;

// Testing seam: rebuild the singleton with custom ports/config (used by
// tests; production always uses the env-bound singleton).
module.exports.buildAuthService = wired.buildAuthService;
module.exports.buildAuthPorts = wired.buildAuthPorts;
module.exports.authConfigFromEnv = wired.authConfigFromEnv;
