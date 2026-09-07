# VBook Runtime Relocation Checklist — COMPLETE

**Package:** `@animastor/vbook-runtime` (`packages/animastor-vbook-runtime/`)
**Source:** `backend/src/book/` (+ audited extraction companions)
**Basis:** `docs/03-audit/VBOOK_EXTRACTION_READINESS_AUDIT.md` (baseline `7cf3f849`),
preparation commit `fb411c6`.
**Status:** `PHYSICAL MOVE COMPLETE` — all §2 items landed; shims remain as the
sanctioned host→package seam (see §4 compatibility ledger).

## 0. Audit re-verification (done at HEAD)

- All 15 book-domain files unchanged since the audit baseline; all 7 outward
  require edges still match audit §1 exactly.
- `book-deletion.cjs` still reads `HUB_URL`/`GPU_HUB_API_KEY` at `:184,186`
  (host-owned; stays out of the package allowlist).
- `bundle-validator.cjs` still self-contained; book domain still in no SCC.
- Audit verdict unchanged: **READY AFTER PREPARATION**.

## 1. PREPARATION COMPLETE (commit `fb411c6`)

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

## 2. PHYSICAL MOVE (this task — COMPLETE)

| Step | What landed | Where |
|---|---|---|
| 2.1 | `git mv` of the runtime: `index.js`, `book-model.cjs`, `bundle-validator.cjs`, `books-root.js`, `lazy-book/` (11 files) → `packages/animastor-vbook-runtime/src/`. `book-deletion.cjs` moved host-side → `backend/src/services/book-deletion.cjs` (never entered the package) | package `src/`, host `services/` |
| 2.2 | Companions moved with the same commit: `services/language-detector.js` → `src/language-detector.js`, `utils/character-identity.js` → `src/character-identity.js`, `utils/snake-guard.js` → `src/snake-guard.js`, `utils/scene-title-utils.js` → `src/scene-title-utils.js` | package `src/` |
| 2.3 | Intra-package requires rewritten (`../../services/language-detector` → `../language-detector`, `../../utils/*` → `../<name>`); module exports identical (probe: 19 shim entry points, key-set parity) | package `src/` |
| 2.4 | Host shims (one-line re-exports, pinned by VB-T4): `backend/src/book/index.js` + `book-model.cjs` + `bundle-validator.cjs` + `books-root.js` + `lazy-book/{index,parser,paths,constants,draft,parse,create,status,metadata,chapter-utils,appearance}.js`, `services/language-detector.js`, `utils/{character-identity,snake-guard,scene-title-utils}.js` | host tree |
| 2.5 | Backend `package.json`: `@animastor/vbook-runtime` added as `file:../packages/animastor-vbook-runtime`; `tinyld` removed (only the detector uses it; resolves via the package's own node_modules / repo-root escalation); `adm-zip` kept (export routes) | `backend/package.json`, `backend/package-lock.json` |
| 2.6 | Composition root switched to the package entry points: `require('@animastor/vbook-runtime/books-root')` + `require('@animastor/vbook-runtime/lazy-book/parser')` for the port bindings; book-deletion import → `./services/book-deletion.cjs` | `backend/src/backend.cjs` |
| 2.7 | `.mocharc.json` stays global (`vbook-test-bindings.cjs` now binds through the package entry points); direct book-domain test requires re-pointed | `backend/tests/vbook-test-bindings.cjs`, `structure-detector.test.js`, `txt-import-ownership.test.js`, `worklist-rebuild.integration.test.js` |
| 2.8 | Guard migration (audit C2): `BOOK_ALLOWLIST` in `dependency-guardrails.test.js` deleted (replaced by the shim-purity check — shims must stay one-line re-exports); P7-T4 `RAW_BOOK_BASELINE` re-pointed (book-deletion edge removed from backend.cjs set, port-binding edges removed from the allowed set — they now go through the package specifier); P7-T5 facade freeze re-pointed to the package path; workflows→book violation baseline unchanged (edges now traverse shims into the package public API, ADR note audit §6); reverse isolation guard = VB-T4 (package requires only builtins + adm-zip + tinyld; host reaches the package only through entry points/shims) | `dependency-guardrails.test.js`, `phase7-extraction-readiness.test.js`, `vbook-package-boundary.test.js` |
| 2.9 | Package-owned standalone suite (`npm test` in the package, audit E1/E2): booksRoot fail-closed port, id grammar, draft lifecycle → bundle round-trip smoke, Book Model facade, validator C1 rules, doctrine companions — 19 assertions, no host/PG/Redis, structureDetector bound to an in-file stub | `packages/animastor-vbook-runtime/test/package-suite.test.js` |
| 2.10 | `npm pack --dry-run` reviewed: 24 files, no `book-deletion.cjs`, no host paths, no tests in the tarball | package |

Docker/manifests: `docker-compose.yml` backend mounts
`./packages/animastor-vbook-runtime:/app/node_modules/@animastor/vbook-runtime:ro`
(same pattern as `animastor-contracts` / the ComfyUI connector — the backend
image builds from `./backend`, so the `file:` dependency is resolved by the
read-only mount in-container). No Dockerfile or script referenced
`backend/src/book` (verified). `scripts/syntax-smoke.sh` covers the package
sources automatically (repo-wide walk) — green.

## 3. Do-not-break invariants — final verification

- Full backend suite at the pre-move baseline: **2910 passing / 2
  pre-existing unrelated failures** (`ai-endpoint-sharing`,
  `ai-shared-inference` — LLM sharing env-dependent, reproducible at
  `fb411c6`; see "Test-environment note" below).
- Package isolation verified by guards (all green):
  - VBook → backend runtime dependency = **0** (VB-T4: every require inside
    `src/` resolves within the package; externals = node builtins + `adm-zip`
    + `tinyld`);
  - no `runtime-config` imports (VB-T2);
  - no `process.env` reads (VB-T2);
  - no `structure-detector` dependency — port only (VB-T3);
  - no deletion/HUB/Redis/PG access; hub env markers live host-side in
    `services/book-deletion.cjs` (VB-T5);
  - no cycles in the package require graph — Tarjan SCC (VB-T4);
  - host → package edges go only through the package entry points/shims
    (VB-T4 deep-require ban).
- Architecture suite: **379 passing** (incl. VB-T1…T5, phase2/4/6/7,
  dependency-guardrails, bundle-schema sync).
- P7-T7 SCC baselines unaffected (the package is a DAG sink; host-side scan
  scope unchanged).

## 4. Compatibility ledger (shims kept intentionally)

Thin one-line re-export shims remain at the legacy paths (pinned one-line by
VB-T4/dependency-guardrails; every consumer still requires the old specifiers,
so Phase-D consumer migration to direct package imports stays a separate,
wave-based task per audit §8):

- `backend/src/book/index.js` → `@animastor/vbook-runtime`
- `backend/src/book/book-model.cjs` → `@animastor/vbook-runtime/book-model.cjs`
- `backend/src/book/bundle-validator.cjs` → `@animastor/vbook-runtime/bundle-validator.cjs`
- `backend/src/book/books-root.js` → `@animastor/vbook-runtime/books-root`
- `backend/src/book/lazy-book/*.js` (11 files) → `@animastor/vbook-runtime/lazy-book/*`
- `backend/src/services/language-detector.js` → `@animastor/vbook-runtime/language-detector`
- `backend/src/utils/{character-identity,snake-guard,scene-title-utils}.js` → package roots

Test-environment note (4 failures, none VBook-related — verified identical at
the preparation baseline `fb411c6`):

- `ai-endpoint-sharing` / `ai-shared-inference` (SH-AI-1/SH-AI-3): assert DB
  state seeded from `OPENROUTER_API_KEY` (system-AI fallback path); pass with
  the repo `.env` sourced, fail without it — environment artifact.
- `ai-shared-stream` (SH-AI-3 CON1): passes WITHOUT the `.env` (mock runtime
  stays eligible), fails WITH it when the real connector key makes fixture
  eligibility differ — timing/eligibility artifact of the same env coupling.
- `worker-share-policy` (D3 beacon → `/worker/counts`): 2s default `it()`
  timeout vs a real-beacon + hub-server round trip; deterministically times
  out at HEAD and at `fb411c6` alike — pre-existing flake, untouched here.

In all four the failure signature is identical before and after the move; the
VBook-domain suites (VBook, entity-crud, txt-import, bootstrap, behavior/
passport patches, structure-detector, language-detector, book-metadata,
phase2/4/6/7, VB-guards, bundle-schema) are fully green.

## 5. Remaining (out of scope here)

- Phase D consumer waves (audit §8): migrate consumers from shims to direct
  package imports, then delete the shims (single-owner, wave by wave).
- Phase E: `npm publish` readiness blocked on npm auth (same gate as
  `animastor-ai-connector@0.1.0` / `animastor-worker@2.1.0`).
- C13 Parser contract: `structure-detector` stays host-side; the ChapterMap
  port in this package is its seed.
