// ======================================================
// VBOOK TEST BINDINGS — dual-location helper (worker/player/editor pattern)
// ======================================================
// This is the package-side copy of the shared host fixture. It binds the
// VBook runtime ports exactly like the production composition root
// (backend.cjs) so that plain requires of the VBook package behave like the
// wired production process.
//
// The canonical host-owned source of this fixture is
// backend/tests/vbook-test-bindings.cjs — see that file for the full header
// (booksRoot bound as a LIVE provider over config.BOOKS_DIR; the real
// services/structure-detector bound so splitIntoChapters produces the same
// maps as before the port). The package copy requires the host source
// through the repo-relative path so a change to the fixture cannot fork:
// the backend repo root is three levels up from this package directory
// (repo checkout layout — the package tests are host-run inside the
// backend workspace, same as the @animastor/player precedent).
//
// Requires the backend node_modules resolution for config/@animastor/* —
// the suite is executed from the backend workspace (cd backend && npx mocha
// ../packages/animastor-editor/test) or via the backend test suite include.

'use strict';

require('../../../backend/tests/vbook-test-bindings.cjs');
