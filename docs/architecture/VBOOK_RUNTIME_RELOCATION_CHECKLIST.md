# VBook Runtime Relocation Checklist — COMPLETE

**Package:** `@animastor/vbook-runtime` (`packages/animastor-vbook-runtime/`)
**Source:** `backend/src/book/` (+ audited extraction companions)
**Basis:** `docs/03-audit/VBOOK_EXTRACTION_READINESS_AUDIT.md` (baseline `7cf3f849`),
preparation commit `fb411c6`.
**Status:** `COMPLETE` — physical move landed and finalized (final
architectural verification 2026-09-07 at HEAD `4d1f6f0e`, §6 record). Shims
remain as the sanctioned host→package seam (§4 compatibility ledger).

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

**Final classification (§6):** every production import of the legacy paths is
a *legitimate host-shim edge*; no "old runtime edge" remains — `backend/src/book/`
holds exactly the 15 one-line shims (no implementation behind them, VB-T4
pinned) and the 4 companion shims are one-line re-exports as well. **Reason to
keep:** behavior-neutral zero-touch seam — ~23 pinned consumer sites migrate
to direct package imports in the Phase-D waves (audit §8), not in extraction
finalization. **Owner:** backend/architecture (VBook Phase-D follow-up).

Test-environment note (4 failures, none VBook-related — verified identical at
the preparation baseline `fb411c6`):

- `ai-endpoint-sharing` / `ai-shared-inference` (SH-AI-1/SH-AI-3): assert DB
  state seeded from `OPENROUTER_API_KEY` (system-AI fallback path); pass with
  the repo `.env` sourced, fail without it — environment artifact.
- `ai-shared-stream` (SH-AI-3 CON1): passes WITHOUT the `.env` (mock runtime
  stays eligible), fails WITH it when the real connector key makes fixture
  eligibility differ — timing/eligibility artifact of the same env coupling.
- `worker-share-policy` (D3 beacon → `/worker/counts`) and
  `private-worker-visibility` (A-vs-B `/worker/counts`): 2s default `it()`
  timeout vs a real-beacon + hub-server round trip; intermittent
  (one of the two times out per run, the other passes) — pre-existing flake
  class, untouched here.
- `guest-workspace` (test 16 "findByToken resolves only the raw token"):
  ~1/16 nondeterministic flake with the root cause in the TEST, not the
  product — the "wrong raw token" is built as `token.replace(/.$/, 'x')`,
  but base64url decoding discards the last character's 2 low bits, so when
  the random token ends in `w`, `w`→`x` decodes to the SAME secret → same
  sha256 → the lookup legitimately resolves. The product
  `guest-repo.findByToken` (hash compared in SQL) is correct. Fix belongs to
  the guest-workspace suite — outside the VBook boundary, recorded here, not
  bypassed.

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

## 6. Final verification record (2026-09-07 — "finalize runtime extraction")

Re-verified at HEAD `4d1f6f0e` (extraction `7175099d` + one unrelated
player-routes commit that touches no VBook file). All checklist questions
checked against the code, not the docs:

1. **Package boundary — CLEAN.** Every require in
   `packages/animastor-vbook-runtime/src/**` resolves to node builtins,
   `adm-zip` or `tinyld` (VB-T4; Tarjan SCC = acyclic). No `runtime-config`,
   zero `process.env` reads (VB-T2), no Redis/PG/GPU-Hub/deletion
   orchestration anywhere in the package (VB-T5).
2. **Host shims — CLEAN.** `backend/src/book/` = exactly the 15 one-line
   re-export shims + `books-root.js` shim; companions
   (`services/language-detector.js`, `utils/{character-identity,snake-guard,
   scene-title-utils}.js`) are one-line re-exports. All production imports of
   `./book/...` classified legitimate host-shim edges (§4); no old runtime
   implementation survives anywhere.
3. **structure-detector — host-owned.** Package consumes only the injected
   port (`setStructureDetector`/fail-closed getter, ChapterMap = C13 seed,
   VB-T3); no direct require from the package.
4. **booksRoot — port only.** `configureBooksRoot()` (static string or live
   provider), fail-closed getters, bound at the composition root
   (`backend.cjs`) and in test bindings; no `BOOKS_DIR`/env fallback inside
   the package (VB-T2).
5. **book-deletion — host-side.** Lives at
   `backend/src/services/book-deletion.cjs` (adapters injected;
   `HUB_URL`/`GPU_HUB_API_KEY` reads are the host-ownership markers, VB-T5);
   absent from the package tree and from the `files` allowlist (VB-T5);
   Redis/PG/HUB/snapshot ownership intact.
6. **Public API — complete.** `exports` = 20 entry points + `./schemas/*`
   wildcard, `main` = `src/index.js`, `files` allowlist (src/schemas/README/
   LICENSE/CHANGELOG); every exports target exists (VB-T1). Host reaches the
   package only through entry points/shims — zero deep imports into `src/`
   (VB-T4 deep-require ban).
7. **Dependency hygiene — DONE.** `tinyld` removed from backend
   `package.json` (package-only consumer); `adm-zip` kept (export routes +
   `backend.cjs`); package `dependencies` = {adm-zip, tinyld} = the actual
   runtime graph (VB-T1).
8. **Tests — GREEN (VBook).** Package standalone suite 19 passing; boundary +
   contract guard set 132 passing (VB-T1…T5, phase2/4/6/7,
   dependency-guardrails, bundle-schema sync); full architecture suite 379
   passing; full backend suite 2909 passing / 5 failing, all five non-VBook
   (§5 note: 3 documented SH-AI env-dependent, 1 root-caused guest-workspace
   test flake, 1 `/worker/counts` timeout flake). `npm pack --dry-run` = 24
   files, no `book-deletion.cjs`, no host paths, no tests in the tarball.
   Production boot smoke green: composition root binds both ports, full
   startup (workflows → PG → connectors → runtime loop) with zero errors.
9. **Behavior parity — PINNED.** No behavior changes in this task; parity is
   held by the green VBook-domain suites (draft lifecycle → bundle round-trip,
   lazy windows, validator C1 rules, entity-crud, txt-import, bootstrap,
   book-metadata, structure/language detectors, behavior/passport patches).
10. **Checklist — COMPLETE** (this document).

**Blockers: none** inside the VBook boundary. Out-of-boundary items recorded,
not fixed: the `guest-workspace` test-16 flake (fix belongs to that suite)
and the `/worker/counts` timeout flake class; `npm publish` remains gated on
npm auth (§5).
