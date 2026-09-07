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

'use strict';

const config = require('../src/config/runtime-config');
const { configureBooksRoot } = require('@animastor/vbook-runtime/books-root');
const { setStructureDetector } = require('@animastor/vbook-runtime/lazy-book/parser');

configureBooksRoot(() => config.BOOKS_DIR);
setStructureDetector(require('../src/services/structure-detector'));
