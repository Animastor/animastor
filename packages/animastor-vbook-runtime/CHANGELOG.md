# Changelog

## Unreleased

### C13 Parser contract (typed, additive — no behavior change)

- `src/contracts/parser-contract.js` — canonical `ParserResult`/`ChapterMap`
  DTO + `ParserSegment` JSDoc types, `PARSER_CONTRACT_VERSION = 1`,
  `validateParserResult`/`validateParserSegment`/`validateLanguageResult`,
  `assertValidParserResult`, and the `StructureDetectorPort` shape check
  (`isValidStructureDetectorPort`/`assertStructureDetectorPort`).
- `src/contracts/legacy-projection.js` — the legacy chapter DTO defined as a
  projection of the canonical map (`segmentToLegacyChapter`,
  `mapToLegacyChapters`); `splitIntoChapters()` now delegates to it
  (behavior byte-identical, pinned by contract tests).
- `setStructureDetector()` additionally accepts the documented port alias
  `buildChapterMap`; the required method stays `buildDeterministicMap`
  (fail-closed semantics and error message unchanged).
- `lazy-book/parser` additive exports: contract validators + projection
  helpers + `PARSER_CONTRACT_VERSION`.
- New export paths: `./contracts/parser-contract`, `./contracts/legacy-projection`.
- Docs: `docs/parser-contract-c13.md`. No parser algorithm, data format,
  or AI/Importer behavior changed.

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
