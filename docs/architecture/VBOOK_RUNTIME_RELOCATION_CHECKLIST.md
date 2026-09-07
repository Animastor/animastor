# VBook Runtime Relocation Checklist — PREPARATION → PHYSICAL MOVE

**Package:** `@animastor/vbook-runtime` (`packages/animastor-vbook-runtime/`)
**Source:** `backend/src/book/` (+ audited extraction companions)
**Basis:** `docs/03-audit/VBOOK_EXTRACTION_READINESS_AUDIT.md` (baseline `7cf3f849`), re-verified against current HEAD.
**Status:** `PREPARATION COMPLETE` → next task: `PHYSICAL MOVE`.

## 0. Audit re-verification (done at HEAD)

- All 15 book-domain files unchanged since the audit baseline; all 7 outward
  require edges still match audit §1 exactly.
- `book-deletion.cjs` still reads `HUB_URL`/`GPU_HUB_API_KEY` at `:184,186`
  (host-owned; stays out of the package allowlist).
- `bundle-validator.cjs` still self-contained; book domain still in no SCC.
- Audit verdict unchanged: **READY AFTER PREPARATION**.

## 1. PREPARATION COMPLETE (this commit)

| Step (audit plan) | What landed | Where |
|---|---|---|
| A1 | `vbook-bundle-3.1.schema.json` + validator↔schema sync test (rule-by-rule, documented strictness deltas D1/D2/D3) | `packages/animastor-vbook-runtime/schemas/`, `backend/tests/architecture/vbook-bundle-schema.test.js` |
| A2 | `booksRoot` port — `configureBooksRoot()` (static string or live `() => config.BOOKS_DIR` provider), fail-closed getters; composition root + test bindings wired; `runtime-config` require removed from `book/index.js` + `lazy-book/paths.js`; env-pre-require tests migrated | `backend/src/book/books-root.js`, `backend/src/backend.cjs`, `backend/tests/vbook-test-bindings.cjs`, `backend/.mocharc.json` |
| A3 | `structure-detector` port — `setStructureDetector()` binding, fail-closed getter, ChapterMap contract documented (C13 seed); host binds the real detector; no direct require left in `book/` | `backend/src/book/lazy-book/parser.js`, `backend/src/backend.cjs` |
| A4 | Placement decisions: `book-deletion.cjs` stays host; snapshot paths + hub env = host conventions; ownership map frozen | `packages/animastor-vbook-runtime/README.md` (ownership table) |
| A5 | Public API freeze list (audit §4.1 surface) in the package README | `packages/animastor-vbook-runtime/README.md` |
| B1/B2 (prep scope) | Package skeleton: `package.json` (`@animastor/vbook-runtime@0.1.0`, deps = adm-zip + tinyld, `files` allowlist without `book-deletion.cjs`), README, CHANGELOG, LICENSE | `packages/animastor-vbook-runtime/` |
| Guards | `VB-T1…T5` boundary guards + `BOOK_ALLOWLIST` shrunk (runtime-config and structure-detector entries removed — those edges are now forbidden) | `backend/tests/architecture/vbook-package-boundary.test.js`, `dependency-guardrails.test.js` |

Wiring compatibility (behavior-neutral):

- Composition root (`backend.cjs`) binds both ports before any book operation.
- Tests: `.mocharc.json` `--require` binds ports globally; any test file that
  requires book-domain modules directly also `require('./vbook-test-bindings')`
  first (10 files updated; the two env-pre-require hacks removed).
- The booksRoot live provider keeps the read-per-call semantics of
  `config.BOOKS_DIR` — tests that re-point it at temp dirs are untouched.

## 2. PHYSICAL MOVE (next task — do NOT start in this phase)

1. `git mv backend/src/book/{index.js,book-model.cjs,bundle-validator.cjs,books-root.js,lazy-book/}` →
   `packages/animastor-vbook-runtime/src/` (minus `book-deletion.cjs`, which
   moves to `backend/src/services/book-deletion.cjs` or stays host-side —
   decide at move time; it must not enter `src/`).
2. Move the companions with the same commit:
   `services/language-detector.js` → `src/language-detector.js`,
   `utils/character-identity.js` → `src/character-identity.js`,
   `utils/snake-guard.js` → `src/snake-guard.js`,
   `utils/scene-title-utils.js` → `src/scene-title-utils.js`.
3. Rewrite intra-package relative requires; keep module exports identical.
4. Host shims (one line each, behavior-compatible):
   `backend/src/book/index.js` → `require('@animastor/vbook-runtime')` re-export;
   same for `book-model.cjs`, `lazy-book/*`, `bundle-validator.cjs`,
   `language-detector`, `character-identity`, `snake-guard`, `scene-title-utils`.
5. Backend `package.json`: add `@animastor/vbook-runtime` as a dependency (file:
   or workspace link); remove `tinyld` (only the detector uses it) — keep
   `adm-zip` (backend uses it for exports too).
6. Composition root: switch port bindings to the package entry points.
7. `.mocharc.json`/`vbook-test-bindings.cjs`: re-point to package paths.
8. Guard migration (audit C2):
   - `BOOK_ALLOWLIST` in `dependency-guardrails.test.js` → delete (rule becomes
     "no relative requires out of the package" — already enforced by VB-T4);
   - re-point `phase7-extraction-readiness.test.js` P7-T4 `RAW_BOOK_BASELINE`
     paths to the shim files or remove entries as consumers migrate;
   - `workflows/video` violation baseline re-point (ADR note, audit D5);
   - add the reverse isolation guard: nothing in the package requires anything
     outside itself except builtins + `adm-zip` + `tinyld` (VB-T1/T4 extend).
9. Package-owned test suite (`npm test` inside the package, audit E1): move the
   portable halves listed in audit §5 (bundle round-trip, validator units,
   paths/layout, draft lifecycle, parse windows via stub detector, id grammar,
   doctrine units, booksRoot fail-closed, schema conformance).
10. `npm pack --dry-run` allowlist review: no `book-deletion.cjs`, no host paths,
    no tests. Then audit E2–E5 (standalone boot smoke, dependency guard, metadata,
    npm auth gate).

## 3. Do-not-break invariants (checked at every step)

- Full backend suite stays at the pre-move baseline (2 known pre-existing
  failures in `ai-endpoint-sharing` / `ai-shared-inference` are unrelated).
- P7-T4 consumer baseline changes only consciously, entry per entry.
- No new SCC membership (P7-T7 stays green — the package is a DAG sink).
- Package never reads `process.env`, never imports `runtime-config`,
  `services/*` (except its companions), routes, orchestration, runtime.
