# Changelog

## 0.1.0 — PREPARATION (not yet published)

Package boundary preparation for the extraction of `backend/src/book/` into
`@animastor/vbook-runtime`. No physical move yet — code still lives in the
backend tree and is wired through shims.

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
