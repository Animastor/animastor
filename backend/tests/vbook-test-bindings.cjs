// ======================================================
// VBOOK PACKAGE BOUNDARY — host-side test bindings
// ======================================================
// Mirrors the production composition root (backend.cjs): binds the
// booksRoot provider and the real structure-detector so that plain
// requires of the VBook package (which is what most backend tests do)
// behave exactly like the wired production process.
//
// Any test file that requires the book domain loads this module FIRST:
//   require('./vbook-test-bindings');
//
// Behavior compatibility:
//   - booksRoot is bound as a LIVE provider over config.BOOKS_DIR —
//     tests that re-point config.BOOKS_DIR at a temp dir keep working
//     unchanged (same read-per-call semantics as the pre-port code);
//   - the real services/structure-detector is bound, so
//     splitIntoChapters produces the same maps as before the port.
//
// The VBook runtime physically lives in packages/animastor-vbook-runtime
// (@animastor/vbook-runtime); this file binds its ports through the
// package entry points:
//   docs/architecture/VBOOK_RUNTIME_RELOCATION_CHECKLIST.md
//
// Dual-location note (worker/player/editor pattern): the extracted
// packages carry a thin wrapper copy of this fixture in their own
// test/ directory (packages/*/test/vbook-test-bindings.cjs) that simply
// requires THIS file — the canonical host-owned source stays here, so a
// change to the fixture cannot fork between host and package suites.

'use strict';

const config = require('../src/config/runtime-config');
const { configureBooksRoot } = require('@animastor/vbook-runtime/books-root');
const { setStructureDetector } = require('@animastor/parser');

configureBooksRoot(() => config.BOOKS_DIR);
setStructureDetector(require('../src/services/structure-detector'));

// PRE-SPLIT DUAL-WIRING: pre-decoupling the npm specifiers above resolved to
// ONE module instance with packages/** through the workspaces symlink, so the
// binding below served both worlds. With registry copies in node_modules the
// architecture suites that require packages/** sources directly read a
// SEPARATE module instance — wire that instance too. The try-blocks become
// no-ops after the physical split (packages/** in their own repo checkout).
try {
    require('../../packages/animastor-vbook-runtime/src/books-root.js')
        .configureBooksRoot(() => config.BOOKS_DIR);
} catch (_) { /* post-split: monorepo checkout not present */ }
try {
    require('../../packages/animastor-parser/src/index.js')
        .setStructureDetector(require('../src/services/structure-detector'));
} catch (_) { /* post-split: monorepo checkout both fixtures — idempotent rebind */ }
