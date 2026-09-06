# PHASE NEXT — Module Extraction Reconnaissance (next standalone module candidate)

**Status:** READ-ONLY reconnaissance. No production code changed, no files moved, no package created, no extraction started.
**Date:** 2026-09-06
**Baseline:** HEAD `acafe15e` ("feat(worker): prepare animastor-worker@2.1.0 for public npm release")
**Context:** Worker physically extracted (Phase 9D, `animastor-worker@2.1.0`, npm-public-ready per Phase 9E, publish blocked only on npm auth). GPU Hub extraction audit is being conducted in parallel by a separate coder. This document identifies the NEXT best standalone-module candidate and measures it against the actual code, not only the documentation.

**Inputs:**

- `MODULAR_PRODUCT_ARCHITECTURE.md` (§1–§30, incl. Part II contract registry C1–C14, graduation checklist §26, transition plan §30)
- `PHASE_1_GUARDRAILS.md` … `PHASE_9E_*.md` (execution reports)
- `MODULAR_PRODUCT_ARCHITECTURE_FINAL_REVIEW.md`, `MODULAR_PRODUCT_ARCHITECTURE_RECONNAISSANCE*.md`
- `docs/03-audit/DEPENDENCY_ANALYSIS.md`, `docs/03-audit/ARCHITECTURAL_AUDIT.md`
- Direct measurement of `backend/src/**`, `gpu-hub/`, `worker/worker/`, `contracts/`, `ai-connector/`, `frontends/app/src` at HEAD: require-graph scans, SCC knowledge from Phase 5/7, Redis key-literal scans, guard-test inspection (`backend/tests/architecture/` — 22 suites).

---

## Executive summary

- **Best next candidate: VBook Runtime / Canonical Book Model (`backend/src/book/`) → `@animastor/vbook-runtime` (L1→L3 path).** It is the only remaining contour that is simultaneously (a) structurally clean (zero cycles, no Redis, SQL only behind an injected adapter), (b) already carrying two frozen contracts (C1 VBook bundle 3.1, C2 Book Model API) pinned by guards, and (c) the dependency root of the two highest-product-value contours (Player, Editor) — extracting it unblocks them; nothing unblocks it except three small, behavior-neutral items already enumerated in Phase 7 §4.4.
- **Top 3 blockers:** (1) `services/language-detector` + `services/structure-detector` parsing-domain code required from inside the book domain (allowlist edges, structure-detector is 1231 LOC shared with the agent pipeline); (2) `config/runtime-config.BOOKS_DIR` path constants baked into `book/index.js` and `book/lazy-book/paths.js`; (3) ~20 book-facing tests live in `backend/tests/`, not in a package-owned suite (graduation checklist §26.5 requires standalone `npm test`).
- **Extraction risk: LOW-MEDIUM (2/5)** — comparable to LAC (Phase 8), lower than Worker (Phase 9): no live deployment channels, no wire protocol consumers outside the host, no Redis/PG coupling in the canonical layer.
- **Next coder should run a dedicated extraction-readiness phase** (audit + contract JSON Schema + dependency decoupling plan; still no physical move): close the C1 open item (JSON Schema for VBook bundle 3.1), design the detector port, define path/ownership injection, then package.

---

## 1. Method

Same discipline as Phase 7: static require-graph scans over `backend/src`, per-contour measurement of entry points, allowed/forbidden dependencies, cycles, DB/Redis/FS coupling, runtime coupling, contract presence, test ownership, and behavior-change risk. All claims below are measured at HEAD `acafe15e`, cross-checked against Phase 7 §2–§3 and Phase 9 §1–§3 (which were measured at earlier commits — drift is reported in §8 where found).

---

## 2. Current packaging state (measured at HEAD)

| Package | Directory | Version | State |
|---|---|---|---|
| `animastor-ai-connector` | `ai-connector/` | 0.1.0 | 🟢 extracted (Phase 8); publish blocked on npm auth only |
| `animastor-worker` | `worker/worker/` | 2.1.0 | 🟢 extracted (Phase 9D); npm-public-ready (Phase 9E); publish blocked on npm auth |
| `@animastor/contracts` | `contracts/` | 0.1.0 | 🟢 extracted (Phase 9C); Job Protocol v2 canonical + 37 tests; **consumed via repo-root node_modules symlink, no npm linking yet** |
| `gpu-hub` | `gpu-hub/` | 0.1.0 | 🟡 physically standalone service; **audit in flight (parallel coder)** |
| `animastor-backend` | `backend/` | 0.1.0 | host / composition root; **no `private: true` yet** (§29 housekeeping item) |
| `animastor-app` | `frontends/app/` | — | private web app |
| — | root | — | **no root `package.json`, no npm workspaces yet** (Phase 9-of-§30 pending) |

Executed roadmap so far: Phase 1–7 (guardrails/contracts/facades/seams/audit), Phase 8 (LAC), Phase 9A–9E (worker). Of the §30 plan, **Phase 10 is partially executed early** (contracts package exists for Job Protocol v2; VBook JSON Schema — the C1 open item — is still pending), Phases 9/11/12/13 (workspaces foundation, CI, compute publishing, plugin foundation) are not started.

---

## 3. The Generation → Provider Gateway → Compute/GPU Hub → Worker boundary: where it really passes

Measured call path at HEAD (one job, e.g. video):

```
orchestration/scene-orchestrator.js:469   gpu.sendUnified(jobSpec)      ← BYPASS of the gateway seam
image/iu-processor.js:278                 gpu.send(...)                 ← BYPASS
audio/generation.js:351,550               gpu.send(...)                 ← BYPASS (×2)
        │
        ▼
runtime/gpu-dispatcher.js (sendUnified)  — routing (book→workspace→private lane /
        │                                  users-policy lane / system pool), timeouts,
        │                                  PG lookups via lazy requires (book-repo,
        │                                  worker-repo, workspace-repo)
        ▼  POST {HUB_URL}/task — Job Protocol v2 envelope (contracts package canonical;
        │    backend resolves via job-schema.js facade re-export)
gpu-hub/gpu-hub.js — Redis queues, claim/lease/timeout sweep, auth mirror
        │  ⚠ PROTOCOL_VERSION inline literal at gpu-hub.js:33 (SYNC comment),
        │    NOT yet imported from @animastor/contracts — hub was never migrated in 9C
        ▼  GET /task/next (Bearer wrk.…)
worker/worker/worker.cjs — ComfyUI execution
        │  ✓ worker.cjs:18 requires ./job-protocol-v2.cjs (generated byte-copy of contracts)
        ▼  POST /task/result | /task/error
gpu-hub → backend routes/generation-routes.cjs:1340,1437 (dedup + failStage)
```

**Findings on hidden responsibility mixing:**

1. **Provider Gateway is a facade, not a boundary yet.** `services/provider-gateway.js` (171 LOC, delegation-only) has exactly **two** production consumers (`routes/ai-routes.cjs`, `generation/comfyui-provider.js`). The generation domain still dispatches through **4 direct bypass call sites** (pinned by P7-T8). The gateway's `generation.sendJob` is a documented seam the callers have not migrated to.
2. **`generation-routes.cjs` (1513 LOC) mixes three responsibilities** — playback/media serving (Player contour, 15 direct `OUTPUT_DIR` hits), generation result ingestion (`/gpu/task/result|error`), and generation-state reads (runtime `scene-window`, `worker-health`). This is the single largest route-layer mixing point on the whole boundary.
3. **The wire boundary itself is clean and now contract-owned** (Job Protocol v2 via `@animastor/contracts`), with one gap: **hub still carries an inline `PROTOCOL_VERSION = 2` literal** (gpu-hub.js:33,758) instead of importing the package — a Phase 9C migration residue that belongs in the running GPU Hub audit.
4. **`gpu-dispatcher.js` embeds backend-internal routing policy** (workspace resolution, private-worker checks, grant-policy lanes — PG reads at :52,:73,:100). This is orchestration-domain logic living in the dispatch transport — correct per PW-2 design (server-derived routing), but it means the "gateway → hub" edge carries host DB state, which is why Provider Gateway can never be extracted before this logic is expressed as injected resolvers.
5. **No hidden cross-package requires exist** — 0 inbound requires into `worker/worker/` (P7-T2), 0 into `gpu-hub/` (P7-T3), 0 into `ai-connector/` (P7-T1). The remaining coupling on this boundary is contractual (Redis key families, envelope identity fields), not code-level.

**Conclusion:** the vertical is *contractually* integrated but *behaviorally* not yet funneled: Provider Gateway owns the contract surface, the actual traffic still flows around it. Any Provider Gateway extraction is premature; the seam work (P7-T8 migration) is a precondition, not the extraction itself.

---

## 4. Candidate inventory

### 4.1 VBook Runtime / Canonical Book Model (`backend/src/book/`) — 🟢🟡 primary candidate

- **Responsibility:** the `.vbook`/canonical book bundle format: manifest identity (3.1), bundle CRUD on disk, validation, lazy/draft representation, deletion cascade seam. ~5,564 LOC including `lazy-book/` (12 files) and the two detector services it consumes.
- **Entry points (measured):** `book-model.cjs` facade (`loadBook(id,{mode})`, `getBookIdentity`, `getBookManifest`, `BookModelError`, `MODE_FULL/MODE_LAZY` — 165 LOC); `book/index.js` canonical CRUD surface (`loadBook`, `saveBookBundle`, `resetBook`, `extractBookBundle`, `buildBookFromBundle`, `collectScenes/collectSceneList` — 848 LOC); `bundle-validator.cjs` (284 LOC); `book-deletion.cjs` (`deleteBook` — 201 LOC); `lazy-book/index.js` (draft/parse/status/create/appearance/metadata modules).
- **Public API that already exists as contracts:**
  - **C1** — VBook bundle format 3.1 (`phase2-vbook-contract.test.js`: manifest-required, round-trip parity, identity semantics; JSON Schema **pending** — the Phase 1 open item);
  - **C2** — Canonical Book Model API (`phase4-book-model.test.js` T1–T6; P7-T5 facade-edge freeze).
- **Who depends on it (measured, 15 files outside `src/book/`):** `editor/index.cjs`, `player/index.cjs`, `backend.cjs` (DI wiring), `routes/book/entity-crud-routes.cjs`, `services/agent/{bootstrap,pipeline-runner,pipeline-steps}.js`, `services/agent-prompts.js`, `services/book-source.js`, `services/placeholder-audio.js`, `services/source-coverage-audit.js`, `services/txt-importer.js`, `utils/scene-title-utils.js`, `utils/snake-guard.js`, `workflows/video/video-workflows.js` (frozen Phase 1 R4 violation, pinned baseline of exactly 2 edges).
- **What it depends on (measured, BOOK_ALLOWLIST at dependency-guardrails.test.js:127):** `adm-zip` (npm), `config/runtime-config` — `BOOKS_DIR` in `book/index.js:48,92` and `lazy-book/paths.js:3`; `services/language-detector` (`lazy-book/draft.js:15`, `lazy-book/parser.js:186`; wraps npm `tinyld`); `services/structure-detector` (`lazy-book/parser.js:80`; 1231 LOC, shared with `services/agent/{pipeline-steps,bootstrap}.js`); `utils/character-identity`, `utils/scene-title-utils`, `utils/snake-guard` (pure helpers; snake-guard → character-identity only).
- **Cycles:** **none.** The book domain is not a member of any SCC (Phase 7 §2.1; re-verified by guard suite presence — P7-T7 pins the orchestration↔runtime↔services↔image SCC, book is not in it).
- **DB/Redis/FS:** FS-canonical (disk bundle is the store); **zero direct Redis**; the only SQL text lives in `book-deletion.cjs` and executes through an **injected** storage adapter (T4 guard: no pg/ioredis in the layer).
- **Backend-runtime coupling:** 2 config-constant files (paths) + the PG `books` ownership handshake (host-provided by design — identity/ownership is PG-only, content is bundle-canonical).
- **Tests:** dedicated suites exist (`book-diff-unit`, `book-source`, `book-sync`, `book-metadata-patch`, `scene-list`, `structure-detector`, `language-detector`, `behavior-crud`, `entity-crud-routes`, + `phase2-vbook-contract`, `phase4-book-model`) — but all live in `backend/tests/`, **none package-owned** (§26.5 gap).
- **Boundary ease:** trivially physical — one directory, frozen import allowlist, no inbound deep-import consumers outside facades except the pinned workflows edge and `book/lazy-book/**` consumer freeze (P7-T4).
- **Behavior risk on extraction:** low — pure FS logic, no runtime state, no protocols; risk concentrates in the detector/config seams (§7 below).

### 4.2 Provider Gateway (`backend/src/services/provider-gateway.js`) — 🟡 contract-first, not package-first

- **Responsibility:** the three-direction provider contract surface (resolve/agent/chat/generation; C8, internal v1).
- **Entry points:** the facade module (171 LOC); consumers: `routes/ai-routes.cjs` (demo consumer), `generation/comfyui-provider.js`.
- **Public API:** `resolve.*`, `agent.callAI/callForPipeline/parseJsonResponse/checkAIHealth/runWithProvider`, `chat.resolveProvider/sourceToken/runSharedInference/describeSharedError/SSE_EVENTS/SOURCE_TOKENS`, `generation.sendJob/JOB_TYPES/comfyui`.
- **Depends on:** exactly 5 delegates — `ai-service`, `agent/ai-caller`, `workspace-ai-provider`, `runtime/gpu-dispatcher`, `generation/comfyui-provider`. The delegates are deeply host-bound: `workspace-ai-provider` does direct PG `query` (5 lazy sites), forms a 2-module SCC with `system-ai` (mutual lazy requires), touches `ai-connector/shared-pool`, `middleware/workspace-ownership`, PG repos.
- **Cycles:** `workspace-ai-provider ⇄ system-ai` (documented seam, Phase 3 §6); the delegates also sit adjacent to the 14-module SCC.
- **Extraction verdict:** as a *contract* it is near-ready; as an *independent package* it is blocked by (a) the 4 direct dispatch bypasses (scene-orchestrator:469, iu-processor:278, audio/generation:351,550 — P7-T8 set), (b) the resolver's PG/shared-pool/system-ai coupling, (c) `gpu-dispatcher` needing to become an injected transport port. **Sequence: migrate bypasses → interface the resolver → only then package.** Not the next extraction.

### 4.3 GPU Hub / Compute (`gpu-hub/`) — 🟡 in audit (parallel)

- Physically a standalone express/ioredis service; zero code deps on backend/worker. Publish blockers: unscoped generic npm name (`gpu-hub@0.1.0` → rename per §22.2), shared Redis key families with backend (`animastor:queue/result/error/job/worker/worker-auth/heartbeat/...` — 12+ families measured at HEAD; cross-owner writes from `routes/worker-routes.cjs:146` `drainPolicyLane` + registry `hdel`), envelope book-identity fields, and the inline `PROTOCOL_VERSION` literal (:33) not yet fed from `@animastor/contracts`. **Assigned to the parallel audit — excluded from this ranking to avoid duplication.**

### 4.4 Generation (`generation/`, `audio/`, `image/`, `video/`, `workflows/`) — 🔴 not ready

- Inside the 14-module orchestration↔runtime↔services↔image SCC (`iu-processor`, `image-service` are members); direct PG repos, Redis chunk/IU keys, `OUTPUT_DIR` writes; `workflows → book` frozen violation. Phase 7 §2.10 verdict unchanged at HEAD. Not a candidate.

### 4.5 Orchestration / Runtime — 🔴 not ready

- 14-module SCC (P7-T7 pins membership), runtime→orchestration edges frozen as debt (R5, Phase 5 §7 residual list: journal/executor/scheduler/window write ports). `reconciliation-engine.js` (2326 LOC) untouched. Extraction would first require the Phase 5 §7 port list. Not a candidate.

### 4.6 Player — 🟠 blocked two levels down

- Facade `player/index.cjs` is 🟢 (requires only `book-model.cjs`; 51 LOC). The contour is not: `generation-routes.cjs` (1513 LOC) mixes the playback media serving with the generation leg; `chunks-routes.cjs` merges PG-derived progress. Extraction sequence is forced: **Book Model → route split → Player**. High product value (§18/§5.1 standalone product), wrong time.

### 4.7 Editor — 🟠 same shape as Player

- Facade `editor/index.cjs` 🟢 (50 LOC; read/commit with injected writer; sole consumer `core-routes.cjs`). Post-commit derived-state fan-out (scene-restoration, entity-cleanup, source-coverage-audit) still lives in routes. Same forced sequence as Player; additionally blocked on the post-commit hook port.

### 4.8 Parser / Import (`services/txt-importer.js` + detectors) — 🟡 greenfield contract, not a code extraction

- Contract **C13 is missing** (§24: `import(source) → DraftBook` has no spec). Today: TXT importer (298 LOC) + agent pipeline + detectors; draft semantics unified via Phase 4 `lazy` mode. Per §29 this is best designed as a plugin contract from scratch (Phase 13 sequencing). It is a *contract-design* work item, not a physical extraction candidate — but note: **its natural implementation home becomes the extracted VBook package** (detectors + draft book = the parse half of the pair "Parser understands how to import; VBook understands how to store").

### 4.9 Cache — 🔴 not a module (unchanged from Phase 7 §2.9)

---

## 5. Scoring matrix (0–5)

| Candidate | Extraction readiness | Risk (lower=better) | Dependency coupling (lower=better) | Contract maturity | Product value |
|---|---|---|---|---|---|
| **VBook Runtime / Book Model** | **4** | **2** | **2** | **4** | **5** |
| GPU Hub (parallel audit) | 3 | 4 | 3 | 3 | 4 |
| Player | 2 | 3 | 4 | 3 | 5 |
| Provider Gateway | 2 | 3 | 4 | 3 | 3 |
| Editor | 2 | 3 | 4 | 3 | 4 |
| Parser/Import (C13) | 1 | 2 | 2 | 0 | 3 |
| Generation | 0 | 5 | 5 | 1 | 3 |
| Orchestration/Runtime | 0 | 5 | 5 | 2 | 2 |
| Cache | 0 | 5 | 5 | 0 | 0 |
| *(reference: Worker — done)* | 5 | — | 0 | 5 | 4 |
| *(reference: LAC — done)* | 5 | — | 0 | 5 | 4 |

Scoring rationale for #1: readiness 4 (facade + CRUD + validator + deletion seam all contracted and guarded; only detector/config/tests items remain), risk 2 (no wire protocol, no live deployment channels, no cross-service Redis — unlike Worker/Hub), coupling 2 (one frozen allowlist of 7 edges, no cycles), contract maturity 4 (C1+C2 frozen with guards; −1 for the missing C1 JSON Schema), product value 5 (the format is the ecosystem root: Player, Editor, third-party `.vbook` consumers per §5/§13/§18).

---

## 6. Ranking

1. **VBook Runtime / Canonical Book Model** — best next standalone module (`@animastor/vbook-runtime`).
2. **GPU Hub** — second, but already owned by the parallel audit; its output (Redis-ownership + rename decisions) also feeds #1's environment.
3. **Player** — highest product value after #1; strictly sequenced behind it (needs Book Model + the `generation-routes.cjs` split).
4. **Provider Gateway** — contract stabilization work (C8 + bypass migration) rather than an extraction; packages only after resolver interfacing.
5. **Editor** — after Player (shares the post-commit-hook port problem).
6. **Parser/Import (C13)** — greenfield contract design; implementation lands inside the #1 package.
7. **Generation / Orchestration / Runtime** — explicitly not candidates (SCC + state ownership; unchanged from Phase 7).
8. **Cache** — not a module; indefinitely out of scope.

---

## 7. Candidate #1 in detail: VBook Runtime / Book Model

### CURRENT (existing structure)

```
backend/src/book/
├── index.js               (848)  canonical bundle CRUD: loadBook, saveBookBundle,
│                                 resetBook, extractBookBundle, buildBookFromBundle,
│                                 collectScenes/collectSceneList; adm-zip; config.BOOKS_DIR
├── book-model.cjs         (165)  Phase 4 facade: loadBook(id,{mode}), getBookIdentity,
│                                 getBookManifest, BookModelError — consumers' entry point
├── book-deletion.cjs      (201)  deleteBook cascade; SQL via INJECTED storage adapter
├── bundle-validator.cjs   (284)  post-mutation/pre-write contract guard (C1)
└── lazy-book/             (12 files, ~2,100)
    ├── index.js, constants.js, paths.js          paths.js → config.BOOKS_DIR
    ├── draft.js           (171)  → services/language-detector
    ├── parser.js, parser/ (419)  → services/structure-detector (v2 chapter splitting),
    │                              services/language-detector (tinyld)
    ├── create.js          (720)  → utils/character-identity, utils/snake-guard
    ├── chapter-utils.js   (222)  → utils/scene-title-utils
    ├── appearance.js, metadata.js, parse.js, status.js
```

Consumers today: player/editor facades → `book-model.cjs`; services & routes → mix of facade and `book/index.js` CRUD; `workflows/video/video-workflows.js` → 2 pinned direct edges (Phase 1 R4 violation, frozen baseline).

### TARGET (proposed module boundary)

```
packages/vbook-runtime/            (@animastor/vbook-runtime, L1 → L3)
├── src/
│   ├── index.js                   public entry: CRUD surface + validator + errors
│   ├── model.js                   Book Model facade (loadBook/getBookIdentity/getBookManifest)
│   ├── bundle/…                   bundle CRUD, manifest identity 3.1, zip I/O (adm-zip)
│   ├── draft/…                    lazy/draft representation
│   ├── parse/                     detector PORT (interface) + default impls:
│   │                              language (tinyld), structure (moved from services/)
│   └── schema/vbook-bundle-3.1.schema.json   ← closes C1 open item (Phase 10)
├── test/                          package-owned suite (moved from backend/tests)
└── package.json                   zero-dep policy relaxed to: adm-zip, tinyld only

backend/src/book/book-model.cjs    → thin re-export facade (transition, like job-schema.js)
backend/src/book/book-deletion.cjs → stays host-side? NO — moves as "deletion cascade"
                                     with the storage adapter as a required injected port
```

Physical location stays `backend/src/book/` until the workspace/Phase-11 moment (the Phase 9D precedent: keep the path all consumers pin; make the boundary real first). The repo-root convention "one package = one top-level directory" (Phase 9C §1) suggests the final home is a top-level `packages/` or sibling directory — decided by the extraction ADR.

### PUBLIC API (what must remain visible outside)

- `loadBook(bookId, { mode: 'full' | 'lazy' })` — unified loader semantics (identity = `manifest.book_id`; lazy = canonical-first, draft fallback; `null` when absent).
- `getBookIdentity(bookId)`, `getBookManifest(bookId)`, `BookModelError` (`INVALID_BOOK_ID`, `INVALID_MODE`).
- `saveBookBundle`, `resetBook`, `extractBookBundle`, `buildBookFromBundle`, `collectScenes/collectSceneList`, `validateBundleFile` (C1 CRUD surface).
- `deleteBook(bookId, options)` — with the storage/Redis runtime-cleanup adapters as **required injection** (never auto-wired).
- Detector port: `detectLanguage(text)`, `splitChapters(...)` (or equivalent) — interface owned by the package, implementations injectable.
- Path root: `booksRoot` as a constructor/module option (replaces `config.BOOKS_DIR` reads).
- JSON Schema `vbook-bundle-3.1.schema.json` as the published C1 artifact.

### PRIVATE (what goes inside)

- All of `lazy-book/**` internals (create/parse/appearance/metadata/status/chapter-utils), `bundle-validator` implementation, manifest parsing details, zip handling, scene-id/unit-id grammars, `BookState/SceneStatus` enums (exported only as data, if needed by contracts later).
- The moved detector implementations (`language-detector`, `structure-detector`) become package-internal default implementations behind the port — `services/agent/*` keeps working via the port or via a host-side re-export shim during transition.

### DEPENDENCIES (module → outside)

| Direction | Dependency | Disposition |
|---|---|---|
| package → npm | `adm-zip` (bundle I/O), `tinyld` (language detect) | declared in package.json; both pure, no infra |
| package → host | **none after decoupling**; during transition: `BOOKS_DIR` injected, detectors injected/defaulted, storage adapter injected for `deleteBook` |
| host → package | editor facade, player facade, backend.cjs DI, services (agent/bootstrap, pipeline-*, book-source, placeholder-audio, source-coverage-audit, txt-importer), `entity-crud-routes.cjs`, `workflows/video/video-workflows.js` (pinned violation) — all through the public entry |
| Forbidden (guard-extendable from BOOK_ALLOWLIST) | orchestration, runtime, routes, raw `pg`/`ioredis`, Redis keys |

### EXTRACTION BLOCKERS (concrete, measured)

1. **Detector coupling.** `lazy-book/parser.js:80` (`structure-detector`, 1231 LOC) and `lazy-book/parser.js:186` + `draft.js:15` (`language-detector`/`tinyld`). Structure-detector is also consumed by `services/agent/pipeline-steps.js` + `services/agent/bootstrap.js` — a shared parsing-domain module, currently owned by "services". Needs: either move into the package (making the agent a consumer of the package) or define a parser port. Decision required in the readiness phase; Phase 7 §4.4 lists this as blocker #1.
2. **Config path constants.** `book/index.js:48,92` and `lazy-book/paths.js:3` read `config.BOOKS_DIR` from `config/runtime-config` (env-derived, default `/data/books`). Needs: path-root injection with the current value as default (behavior-neutral).
3. **Tests are host-owned.** ~20 suites in `backend/tests/` require book internals directly (`book-diff-unit`, `book-source`, `scene-list`, `structure-detector`, `language-detector`, `behavior-crud`, `entity-crud-routes`, plus arch guards reading sources by path: `phase2-vbook-contract.test.js`, `phase4-book-model.test.js`, P7-T4/T5, BOOK_ALLOWLIST in `dependency-guardrails.test.js`). §26.5 graduation requires a package-owned standalone suite; guards need path updates (the Phase 9D pattern).
4. **C1 JSON Schema still pending** (Phase 1 open item; §22.5 rule 1 names VBook 3.1 as the first canonical schema). Should land *before* the package is published, not after.
5. **Pinned inbound violation:** `workflows/video/video-workflows.js: ../../book` + `../../book/lazy-book/appearance` — frozen baseline; at packaging time these edges must be re-pointed at the public entry (baseline update = ADR per §27.2.3).
6. **Ownership handshake is PG-only** (book identity/ownership in the `books` table, content canonical on disk — Phase 2 §12 Final Review open design decision). For L1 workspace extraction this is fine (host keeps ownership); it becomes material only for a standalone `.vbook` product (L5). Document, don't solve.
7. **Housekeeping prerequisite:** no root workspaces yet, backend lacks `private: true` (§29). Package resolution will initially use the same repo-root symlink mechanism Phase 9C established (`node_modules/@animastor/contracts` precedent; note the docker build-context caveat documented in `job-schema.js` header).

---

## 8. Documentation vs. code: discrepancies found

1. **Phase 10 partially executed early.** §30 sequences the contracts package as Phase 10 after a workspaces foundation (Phase 9); reality: `@animastor/contracts` was extracted inside Phase 9C, before workspaces, via a repo-root symlink. The §30 numbering is now shifted: "Phase 10" content exists (for Job Protocol only), while "Phase 9" (root workspaces) does not.
2. **Hub did not receive the 9C migration.** §24 C4 names the contracts package canonical for backend/hub/worker; measured: worker consumes a generated byte-copy (`worker/worker/job-protocol-v2.cjs`), backend consumes the facade re-export, but **gpu-hub.js:33 still carries an inline `PROTOCOL_VERSION = 2` literal** with only a SYNC comment. The registry row overstates hub-side completion. → belongs in the running GPU Hub audit.
3. **§29 says VBook runtime is "🟡 needs detector decoupling, config-path injection, ownership-handshake interface (Phase 7 §4.4 list)"** — measured state matches exactly (the three items are still the complete blocker list), i.e. no drift here; but §30 sequences the VBook package at Phase 14+, *after* Phases 12–13. Given Worker is extracted and Hub is in audit, the practical critical path has moved: VBook is now the highest-readiness unextracted contour, and its C1-schema work *is* the remaining Phase 10 content. **The doc order (VBook last) and the code order (VBook next) diverge** — this document resolves it in favor of the measured state.
4. **Provider Gateway consumer count** — Phase 7 §2.5 recorded "only `routes/ai-routes.cjs`"; today there are two (`ai-routes.cjs` + `generation/comfyui-provider.js` — the gateway itself re-exports comfyui, and the provider is required by the gateway). Minor drift, direction is still "consumers ≤ 2".
5. **`generation-routes.cjs` split (Phase 7 §4.6 precondition for Player)** has not started; the file grew into the single largest mixing point (1513 LOC) — the Player blocker is *stronger* today than when Phase 7 was written.

---

## 9. Can an extraction-readiness phase start for #1 now?

**Yes — immediately, without any preparatory refactor of production code.** The correct shape (Phase 7/9 precedent: audit + contracts first, movement later):

1. **Contract freeze (doc + schema, zero runtime change):** author `vbook-bundle-3.1.schema.json` (closes C1 / the remaining Phase 10 item), pin it with a package-side contract test + host-side sync test (the `lac-contract-sync` pattern).
2. **Decoupling design (ADR, not code):** detector port vs. detector move; `booksRoot` injection; `deleteBook` adapter port signature; the `workflows → book` baseline-update plan.
3. **Test inventory:** enumerate the ~20 host-owned suites; define the package-owned set and the cross-side contract set (Phase 9 §7 pattern).
4. **Only then** physical packaging (workspace-aware), guarded by an updated BOOK_ALLOWLIST → package-isolation guard (P7-T1 analog).

No behavior change is required at any step; every blocker is a seam or a metadata item, not a rewrite. Risk assessment: **LOW-MEDIUM (2/5)** — below Worker (which had live GPU deployment channels and a tri-party wire protocol) and far below Hub (Redis ownership). The main cost is test migration and the structure-detector ownership decision.

---

## 10. What the next coder should do

1. Read this document + Phase 7 §2.1/§4.4 + Phase 2 §2–§4 + Phase 4; verify the three blockers against HEAD (they are small; expect ≤ 1 day of verification).
2. Run the extraction-readiness phase per §9: C1 JSON Schema + detector/config/deletion-port ADRs + test inventory. **No file moves, no package.json creation, no production edits.**
3. Deliverable: a `PHASE_10B_VBOOK_EXTRACTION_READINESS.md` (or similarly named) with the schema, the ADR drafts, and the green-light/blocker verdict for physical packaging.
4. Coordinate with the GPU Hub audit coder: the repo-root symlink mechanism and the `private: true` housekeeping item are shared prerequisites; avoid both coders editing `backend/package.json` / root scripts simultaneously.

---

## Verification (read-only commands executed during this recon)

- Require-graph scans: `grep -rn "require(" backend/src/book/**` (all edges enumerated in §7), consumer scans for `book-model.cjs` / `book/index` / `lazy-book` (15 files), `provider-gateway` (2 consumers), `gpu.send|sendUnified` (4 bypass sites), Redis key literals in `gpu-hub.js` vs `backend/src/{routes/worker-routes.cjs, services/worker-auth.js}`.
- Guard-suite inspection: `backend/tests/architecture/` (22 suites; BOOK_ALLOWLIST at `dependency-guardrails.test.js:127`; P7-T4/T5/T7/T8; `phase2-vbook-contract.test.js`; `phase4-book-model.test.js` T1–T6; `phase9c-contracts.test.js`; `phase9d-worker-package.test.js`).
- Packaging state: `contracts/package.json`, `worker/worker/package.json` (2.1.0, files allowlist), `ai-connector/package.json` (0.1.0), `gpu-hub/package.json` (unscoped 0.1.0), `backend/package.json` (no `private: true`), root (`package.json` absent).
- git log cross-check: Phase 9A→9E commits (`019bd843`…`acafe15e`).

Nothing in the repository was modified by this reconnaissance.
