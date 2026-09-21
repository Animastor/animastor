// ======================================================
// AUTH SERVICE (Authentication MVP) — Extraction Phase 1 shim
// ======================================================
// This file is now the COMPATIBILITY SHIM over the auth domain core
// (audit §12 phase 2): the domain lives in auth/core.js (Express-free,
// ports-injected) and the host binding is auth/index.cjs (env + PG
// adapters). Every export below is re-exported from the wired singleton so
// all existing consumers (auth-context, auth-routes, 15+ test suites) keep
// their require path and behaviour unchanged.
//
// The former inline SQL (register transaction, canonical username lookup,
// workspace self-heal UPDATE) moved to:
//   storage/postgres/repositories/registration-tx.js  (unit-of-work)
//   storage/postgres/repositories/user-repo.findByUsernameCanonical
//   storage/postgres/repositories/workspace-repo.renameWorkspace
// DIRECT_SQL_WHITELIST: this file no longer holds a raw postgres handle —
// the whitelist entry is REMOVED (sql-boundary guard's stale-entry rule).
//
// Semantics unchanged (audit §9): error/status codes, cookie attributes,
// guest lifecycle, conversion atomicity, fail-closed authorization.
// ======================================================

'use strict';

const wired = require('./index.cjs');
const cookies = require('./cookies');
const { AuthError, WorkspaceExpiredError } = require('./auth-errors');
const password = require('./password');

// Re-export the wired singleton's surface (the historical authService shape).
const authService = wired;
module.exports = authService;

// Named re-exports preserved for destructuring consumers.
module.exports.AuthError = AuthError;
module.exports.WorkspaceExpiredError = WorkspaceExpiredError;

// Static cookie grammar surface (constants were also reachable via the
// singleton; the modules are exported for direct consumers/tests).
module.exports.cookies = cookies;
module.exports.password = password;

// Testing seam: rebuild the singleton with custom ports/config (used by the
// contract suite; production always uses the env-bound singleton).
module.exports.buildAuthService = wired.buildAuthService;
module.exports.buildAuthPorts = wired.buildAuthPorts;
module.exports.authConfigFromEnv = wired.authConfigFromEnv;
