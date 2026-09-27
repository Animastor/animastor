# Changelog

## 0.2.0 (2026-09-26)

Parser Core physically moved out of this package into the standalone
[`@animastor/parser`](https://www.npmjs.com/package/@animastor/parser)
package (C13–C15 extraction). This is a breaking release for consumers of the
removed subpath exports; the book-model surface is unchanged.

### Breaking

- Removed `src/parser-core.js`, `src/language-detector.js`,
  `src/contracts/parser-contract.js`, `src/contracts/legacy-projection.js`
  and `src/lazy-book/parser.js` — the parser implementation now lives in
  `@animastor/parser`.
- Removed subpath exports `./language-detector` and `./lazy-book/parser`.
  Migrate to `@animastor/parser` (root) or
  `@animastor/parser/language-detector` — the re-exported API is identical.
- Dependency change: `tinyld` removed (moved with the language detector);
  `@animastor/parser ^0.1.0` added (registry dependency, replaces the
  monorepo `file:` link).

### Unchanged

- The canonical Book Model facade (`./book-model.cjs`), bundle CRUD,
  lazy-book lifecycle, bundle validation, snake-guard / character-identity /
  scene-title-utils and the JSON schemas are untouched; the parser contract
  DTOs keep flowing through the same call signatures (now re-exported from
  `@animastor/parser`).

### C13 Parser contract (pre-release state, superseded by the move above)

- The contract work that first landed here (canonical `ParserResult`/
  `ChapterMap` DTO + validators, legacy chapter projection,
  `buildChapterMap` port alias) moved with the parser into
  `@animastor/parser` 0.1.0.

## 0.1.0 — 2026-09-07

### Physical extraction (relocation checklist §2 COMPLETE)

- The runtime physically moved from `backend/src/book/` into `src/` of this
  package: bundle CRUD (`index.js`), Book Model facade (`book-model.cjs`),
  validator (`bundle-validator.cjs`), booksRoot port (`books-root.js`),
  lazy-book runtime (`lazy-book/`), and the extraction companions
  (`language-detector.js`, `character-identity.js`, `snake-guard.js`,
  `scene-title-utils.js`) — audit §1.1.
- `exports` map for every legacy host entry point; dependencies:
  `adm-zip` + `tinyld` only (guarded by `backend/tests/architecture/vbook-package-boundary.test.js`).
- The host keeps one-line re-export shims at the legacy paths
  (`backend/src/book/**`, `backend/src/services/language-detector.js`,
  `backend/src/utils/{character-identity,snake-guard,scene-title-utils}.js`).
- `backend/src/book/book-deletion.cjs` moved to host services
  (`backend/src/services/book-deletion.cjs`) — deletion orchestration is
  host doctrine, outside the package scope.
- Package-owned standalone test suite (`npm test`): booksRoot fail-closed
  port, id grammar, draft lifecycle → bundle round-trip, Book Model facade,
  validator C1 rules, doctrine companions (audit E1/E2).

### Preparation (previous commit)

- `booksRoot` port — `configureBooksRoot()` (static string or live
  `() => config.BOOKS_DIR` provider), fail-closed getters; the package
  never imports host config nor reads `process.env`.
- `structureDetector` port — `setStructureDetector()` injectable binding
  (Parser ≠ VBook); the ChapterMap contract is the seed of C13.
- `schemas/vbook-bundle-3.1.schema.json` mirroring the validator rule by
  rule; public-API freeze + ownership map in the README.

## 0.1.0-rc1 — PREPARATION (superseded by 0.1.0)

Package boundary preparation for the extraction of `backend/src/book/` into
`@animastor/vbook-runtime`. No physical move in that commit — the code lived
in the backend tree, wired through the ports.

- Package manifest (`package.json`) with the frozen dependency surface:
  `adm-zip` + `tinyld` only.
- Public API freeze list (README, audit §4.1).
- `booksRoot` port: `configureBooksRoot()` / fail-closed getters; host
  composition root binds `config.BOOKS_DIR`; `runtime-config` require removed
  from the book domain.
- `structureDetector` port: `setStructureDetector()` / fail-closed getter;
  host composition root binds the real `services/structure-detector`.
- `schemas/vbook-bundle-3.1.schema.json` — canonical bundle contract mirroring
  `bundle-validator.cjs` (audit A1), pinned by the validator↔schema sync test.
- Ownership map frozen: bundle/book canonical state → package; snapshots,
  deletion orchestration, Redis/PG/GPU Hub → host.
- Boundary guards: `backend/tests/architecture/vbook-package-boundary.test.js`,
  `backend/tests/architecture/vbook-bundle-schema.test.js`.
