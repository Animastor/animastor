# Backend Extraction Audit — Remaining Host After the c21.x Extraction Series

**Status:** AUDIT / RECONNAISSANCE ONLY. No files moved, no packages created, no imports changed, no production code touched.
**Date:** 2026-09-20
**Branch:** `c21.4-physically-extract-analysis-from-backend`
**Baseline commit:** `39d5caed` ("npm(packages): publish @animastor/installer@0.1.0 as a public scoped package")
**Scope:** everything still physically inside `backend/src/**` and host-level parts, AFTER the completed extraction series.
**Question answered:** *which remaining parts of the backend host have already formed independent domains and can now be physically extracted into npm packages?*

**Inputs (measured, not assumed):**

- require-graph scans over all 191 `backend/src/**/*.{js,cjs}` files (43,339 LOC total) — relative requires, `@animastor/*` package requires, per-domain consumer counts;
- previous landscape audit `backend-extraction-landscape-audit.md` (2026-09-14) and its disposition (see §2: its Top 1 and part of Top 3 are already DONE);
- `ai-agent-analysis-boundary-c21.1.md` (analysis physically extracted), `installer-extraction-audit.md` (Top 1 executed), `web-generator-extraction-audit.md` (the intentional host-owned web boundaries);
- package inventory: 28 packages under `packages/`, of which 11 are consumed by backend via `file:` deps (`@animastor/{ai-agent, ai-analysis, assistant, editor, generation, installer, orchestration, parser, player, vbook-runtime}` + `animastor-comfyui-workflow-connector`).

---

## 1. Executive summary

After the c21.x series the backend host no longer contains any large pre-formed domain with an A-grade "just move it" boundary. The installer (12.7k LOC, the previous audit's Top 1) is physically extracted and published; the semantic analyzers are in `@animastor/ai-analysis`; chat is in `@animastor/assistant`; book/contracts/orchestration/generation/player/editor are packages. What remains — 43k LOC — is dominated by things the previous audits deliberately classified host-owned, and this audit **confirms those verdicts**: the composition root, the O-2..O-10 adapter layer, media executors, the routes contour, storage/postgres, runtime shells.

**One new genuine candidate emerged and one prior B-candidate survived re-measurement:**

1. **`@animastor/auth` (identity/session/authorization domain)** — **B (NEAR READY)**. `auth/auth-service.js` + `auth/password.js` + the policy halves of `middleware/auth-context.js` remain a cohesive, crypto-only, repo-injectable core with 1,257 LOC of dedicated tests. The seams needed are known and precedented (`bookAccessDecision` decision-function pattern; the assistant `sessionRepo` port pattern). Nothing about the c21.x work invalidated it; the host around it only got thinner.
2. **`@animastor/worker-domain` core (worker credential lifecycle + fail-closed auth)** — **C (NEAR READY, core only)**. `services/worker-auth.js` (fail-closed resolution + Redis mirror discipline) is a tight, well-documented single-responsibility module, but its value as a package is capped while `worker-routes.cjs` (814 LOC) and the hub's Redis key-family contract stay host-shaped.
3. **Pure-leaf adoption into existing packages** — not new packages, but bookkeeping-grade moves: `source-coverage.js` (445, zero requires) + `encoding-detect.js` (303, iconv-lite only) → parser orbit; `prompt-dependency-registry.js` (523, zero requires) + the pure half of `book-diff.cjs` → generation orbit.

Everything else measured this pass lands in **C/D**: the AI-provider plane (workspace-ai/system-ai SCC + PG + routes), the ingest/agent pipeline (the last big genuinely-host cluster, 4,632 LOC, woven through import routes, window generation, SSE and cancellation), storage, runtime, middleware, helpers, metrics, state facades.

**No new A — READY candidate exists at this baseline.** The natural reading is that the extraction program has consumed the easy surface: what is left in `backend/src` is, with the two exceptions above, *host by architecture, not host by history*.

**Recommended next step:** run a dedicated extraction-readiness audit for **`@animastor/auth`** (contract freeze + repo port ADR + test move plan). It is the only remaining candidate where the domain, the contract seam and the test ownership all already exist and the only work is declaring the boundary.

---

## 2. What is already extracted; which host-owned boundaries are intentional

### 2.1 Packages already extracted (do NOT re-propose)

| Package | Status |
|---|---|
| `@animastor/contracts` (Job Protocol v2) | extracted, 37 tests |
| `@animastor/generation` (sceneState, mediaRegistry, promptProfiles, artifactNaming, generationProgress core, ports) | extracted; host consumes via 56 require sites through ports (S-6/S-7) |
| `@animastor/orchestration` (dispatch/reconciliation/scene-window/scheduler/leases/circuit-breaker/runtime-result) | extracted; O-2..O-10 host adapter layer owns every concrete leg |
| `@animastor/vbook-runtime` (canonical book model, lazy-book, bundle-validator) | extracted; `backend/src/book/` is a pure shim tree (66 LOC) |
| `@animastor/parser` (language/structure detector ports) | extracted; host injects `setStructureDetector` |
| `@animastor/ai-agent` (core execute() lifecycle, zero-dep) | extracted (C21.2/21.3) |
| `@animastor/ai-analysis` (structure/character analyzers, deterministic detector) | **physically extracted in C21.4** (`2172fac5`); backend barrel `services/structure-detector.js` re-exports from the package |
| `@animastor/assistant` (chat engine + /api/v1/ai routes + ports contract) | extracted; host adapter `services/assistant-ports.cjs` binds the concrete legs |
| `@animastor/player`, `@animastor/editor` | extracted; player ports (`assertBookAccess`, `computeVideoStartMs`, `computeWaveform`) injected in composition root |
| `@animastor/installer` (12.7k LOC, 31 files, own bin, 17 test suites) | **physically extracted on this branch** (`97df4b7d`, `ea810931`), published as 0.1.0 (`39d5caed`); the only host consumer reaches it via `require('@animastor/installer').setupContract` |
| `animastor-worker`, `animastor-gpu-hub`, `animastor-ai-connector`, `animastor-comfyui-workflow-connector` | independent services/packages |
| `@animastor/web-*` (14 frontend packages) | out of backend scope, listed for completeness |

### 2.2 Intentionally host-owned boundaries (confirmed deliberate — do NOT count as candidates)

Per the previous audits and re-verified in code this pass:

- **`phase` / generation status / navigation pulse (web host)** — `generateStore` identity + status signals, guarded by `generation-progress-contour.guard.test.ts`; web-generator verdict stays NOT READY (identity/auth/phase blockers, Steps 3–5 pending).
- **playback/file seams** — `video-timeline.computeVideoStartMs` is deliberately host-side and injected into the player package as a port; the player must not own the workflows alignment tax.
- **`applyGenerationResults`** — bridges generation → navigation → playback across 3 host boundaries; web-audit §12.3.3 explicitly marks it NOT moveable without major refactor.
- **cancel / teardown** — `book-deletion.cjs` (222 LOC) is the 7-step cancellation→cleanup cascade composing Redis + PG + FS + hub + agent-session ports; it IS host orchestration by definition.
- **state restoration** — `unsafeRestore*` whitelist discipline in `state/asset-state-store.js`; the pure FSM already lives in `@animastor/generation`.sceneState, only the Redis adapter remains host-side (correct).
- **SSE glue** — `progress-pubsub.cjs` (34 LOC) + `storage/progress-events-adapter.js` are the O-5 adapter legs; the web SSE orchestration already moved to `@animastor/web-generator-sse`.
- **identity re-exports** — `services/language-detector.js` (4 LOC) and `services/structure-detector.js` (46 LOC barrel) are compatibility shims over `@animastor/parser` / `@animastor/ai-analysis`; migration bookkeeping, not a module.
- **explicit state objects** — `ProgressTrackingState`/`GenerationTimerState` are host-owned by design (web-audit §9.2).
- **host orchestration** — `backend.cjs` (995 LOC) is the composition root: it binds generation ports (dispatchTransport, profileStore, bookData), all O-2..O-10 orchestration ports, orchestration `bindHostModules`, VBook `configureBooksRoot`, parser `setStructureDetector`, assistant/player/editor seams, routes, startup reconcile, graceful shutdown. Zero `require('../backend.cjs')` back-references exist anywhere (re-verified). This is exactly the "host = orchestration + runtime + integration" target shape.

---

## 3. Map of the remaining backend host by domain

191 files / 43,339 LOC. "Seams" = consumption of extracted `@animastor/*` packages (70 files, 148 require sites; generation ×56, orchestration ×37 dominate — a healthy package-facing picture).

| Domain | Files | LOC | Purpose | Infra deps | Package seams | Own API/contract | Own state | HTTP/SSE/session | Host orchestration coupling |
|---|---|---|---|---|---|---|---|---|---|
| `backend.cjs` + root | 3 | 1,139 | Composition root, startup-resume, dependency-graph | Redis, PG, Express | all | is the composition root | app-level | is the app | **is** the host |
| `services/` flat | 44 | 11,513 | Mixed: AI-provider plane, ingest/agent host legs, media executors, book-state services, worker-auth, misc glue (see §4) | PG, Redis, fs, ffmpeg, fetch | generation, orchestration, ai-analysis, parser, vbook | mixed | mixed | SSE (progress-pubsub) | heavy |
| `services/agent/` | 8 | 4,632 | Ingest/analysis pipeline (bootstrap, pipeline-runner/steps, window splitting, parallel analysis) | PG, Redis, p-limit | ai-analysis, generation, vbook | session/window contract via agent-session | PG sessions | SSE progress, cancel flags | heavy |
| `routes/` (+`book/`) | 27 | 8,065 | HTTP contour: import (985), ai-connector (919), worker (814), generation (593+659), debug (578), settings/admin/users, worker-setup (291) | PG, Redis, Express, ws | installer (setupContract), editor shim | route contracts | — | **is** the HTTP surface | mounts host services |
| `storage/` flat | 11 | ~1,426 | O-2..O-10 host adapters + filesystem-store + asset-registry (Redis) + barrel | PG, Redis, fs | generation, orchestration | port adapters by design | Redis keys | no | bound in backend.cjs |
| `storage/postgres/` | 20 | 5,798 | Pool + 1,809-LOC schema + 15 repositories | PG | generation (naming) | repos | tables | no | `storage.postgres.initialize()` |
| `audio/` | 11 | 1,839 | TTS pipeline (segments/chunks/ffmpeg/merge/generation) | fs, ffmpeg, music-metadata | generation | partial (pure core ~860) | Redis via services | no | drives FSM via O-7 |
| `image/` | 7 | 1,084 | IU image pipeline (prompt-builder, iu-processor, registry, sharp previews) | fs, sharp, PG | generation, orchestration | partial (prompt-builder pure) | PG/Redis | no | iu-processor drives dispatch |
| `video/` + `workflows/video/` | 5 | 1,860 | LTX job building, merge (ffmpeg), timeline offsets, workflow JSON builders | fs, ffmpeg, PG, Redis | generation | partial | Redis registries | no | FSM via O-8; timeline → player port |
| `middleware/` | 4 | 626 | auth-context (identity+book access), ai-book-guard, workspace-ownership, worker-auth-middleware | PG via repos | — | policy functions | — | **Express-shaped** | mounted in backend.cjs |
| `auth/` | 2 | 540 | register/login/logout/session/guest identity, cookie grammar, bookAccessDecision, scrypt | **crypto only** + 4 PG repos | — | **yes — AuthError, decision fns, cookie headers** | PG (via repos) | decision fns are req-free | no |
| `runtime/` | 4 | 693 | runtime-loop (timer shell), gpu-dispatcher (PW-2 routing + hub HTTP), job-schema shim, orchestration-seams (S-5) | Redis, PG lazy, HTTP→hub | orchestration, generation, contracts | seam registry | routing caches | HTTP→hub | deliberate host-stay (§32.30, S-5, PW-2) |
| `state/` | 5 | 611 | asset-state-store (Redis adapter over generation.sceneState), scene-state-ops (PG sync), event-journal (Redis append-only) | PG, Redis | generation | facades | Redis | no | O-port legs |
| `config/` | 2 | 370 | runtime-config (env blob, 15 reads) + generation-config-adapter (S-6) | env | generation | env blob | — | no | adapter |
| `helpers/` | 2 | 502 | redis-helpers (book/runtime-specific chunk grammar, factory), utils (log) | Redis, PG lazy | generation, orchestration | no | Redis | no | factory in backend.cjs |
| `metrics/` | 1 | 274 | prom-client registry | prom-client | generation | gauges | in-proc | `/metrics` | no |
| `utils/` | 7 | 227 | scene-hash, speech-estimation, string-utils + 4 vbook shims | crypto | vbook-runtime (4/7 shims) | pure | no | no | no |
| `book/`, `editor/`, `contracts/` | 17 | 96 | **all shims** → vbook-runtime / editor / contracts | — | extracted | — | — | — | — |
| `scripts/` | 1 | 260 | dev scene-split script | — | — | no | no | no | no |

**Measured internal edge picture (domain → domain, require counts):**

```
(root backend.cjs) → services:22 routes:14 storage:9 postgres:9 book:5 runtime:3 state:3 middleware:3 config:2 …
services → postgres:14 config:7 book:6 agent:5 utils:5 ai-connector:5 audio:2 state:2 …
routes → services:18 postgres:14 routes/book:11 config:5 ai-connector:5 middleware:4 …
middleware → postgres:6 auth:1 services:1
auth → postgres:6                          ← the ONLY host coupling of the auth domain
runtime → postgres:3 config:1 metrics:1
installer → (physically gone from backend; only the package require remains)
```

The only file-level SCC left in the host is the documented `system-ai ⇄ workspace-ai-provider` mutual lazy require (shared crypto helpers `encryptSecret/decryptSecret/maskKey/normalizeProviderType`). The old `services → video → workflows → services` and `storage → services` synthetic cycles from the previous audit persist unchanged (barrel `storage/index.js` still re-exports 5 domain services; workflows still import `profile-override` + PG).

---

## 4. Candidate table

| # | Candidate | Location | LOC | Consumers | Category (A/B/C/D) | One-line rationale |
|---|---|---|---|---|---|---|
| 1 | **Auth / Identity domain** | `auth/*`, `middleware/auth-context.js` (policy half), `routes/auth-routes.cjs`, repos as host ports | ~980 core + 630 repo tests 1,257 | auth-routes, backend.cjs (guards), player port `assertBookAccess`, import/ai/admin routes via guards | **B — NEAR READY** | pure policy core, crypto-only, repo-injectable; needs repo port contract + decision/middleware split |
| 2 | **Worker domain core** (worker-auth + credential lifecycle) | `services/worker-auth.js`, `middleware/worker-auth-middleware.js`, `services/share-events.js` | ~360 | worker-routes, admin-routes, backend.cjs (mirror sync), hub (Redis mirror key contract) | **C — HOST-BOUND (core-only)** | fail-closed policy + mirror discipline is package-grade, but routes + hub key-family keep the domain host-shaped |
| 3 | **Dirty-layer / coverage pure cores** (adoption, not new package) | `services/prompt-dependency-registry.js` (523, zero requires), `services/source-coverage.js` (445, zero requires), `services/encoding-detect.js` (303, iconv only), pure half of `book-diff.cjs` | ~1,500 pure | book-diff → backend.cjs; source-coverage → agent pipeline + audit; encoding-detect → txt-importer | **B- (adoption into generation / parser orbit)** | A-grade pure files; right home is inside existing packages, not standalone npm modules |
| 4 | **AI-provider plane** (ai-service, workspace-ai-provider, system-ai, ai-loader, provider-gateway, agent-prompts, prompt/knowledge loaders) | `services/*` | ~2,900 | routes (ai-endpoint, settings-ai, admin, generation), agent pipeline, assistant ports, shared-pool | **D — HOST-BOUND** | system-ai⇄workspace-ai SCC, 5 lazy PG sites, Express settings/admin surface, kill-switch wiring |
| 5 | **ai-connector host half** (transport 581, shared-pool 432, discovery 215, registry 68) | `services/ai-connector/` | 1,296 | ai-service, workspace-ai, provider-gateway, ai-connector-routes, assistant ports | **D — HOST-BOUND** | note: npm `animastor-ai-connector` package is the LAC *client* (outbound WS bridge), NOT this code — the host half owns WS registry state, PG repos, eligibility policy |
| 6 | **Ingest / agent pipeline host contour** | `services/agent/` (4,632), `services/txt-importer.js` (298), `services/agent-session.js` (129), `services/agent-service.js` (59), `services/window-generator.cjs` (182), `services/knowledge-base.js`, `services/agent-prompts.js` (179), `routes/book/import-routes.cjs` (985) | ~6,500 | import routes, backend.cjs (windowGenerator → reconcile loop), agent-routes, gen-session-repo | **D — HOST-BOUND** | woven through Express import routes, SSE publish, PG sessions, cancellation flags, layer-config, lazy-book — the pipeline IS the host's ingest orchestration |
| 7 | **Media executors** (audio/, image/, video/, workflows/video/, audio-orchestrator, video-orchestrator, placeholder-audio, task-handler, waveform) | as listed | ~5,900 | backend.cjs (media binding), orchestration (O-4/O-7/O-8 adapters), task-handler | **D — HOST-BOUND** | host legs of the generation/orchestration packages; eventual direction is partial adoption INTO `@animastor/generation`, not a new package (unchanged verdict) |
| 8 | **Book-state reconciliation services** (book-sync, book-source, book-event-log, entity-cleanup, cleanup-service, book-deletion, scene-asset-registry) | `services/*` | ~1,700 | backend.cjs, storage barrel, editor purge port, tests | **D — HOST-BOUND** | PG/Redis reconciliation legs of editor/book-deletion flows; scene-asset-registry additionally has **zero production consumers** (tests only — dead-code candidate, see §6) |
| 9 | **Storage (postgres + adapters + barrel)** | `storage/**` | 7,224 | everything | **D — NOT A MODULE** | shared host infrastructure; repos travel with their domains (auth does this); schema is host doctrine |
| 10 | **Runtime shells** (loop, gpu-dispatcher, seams, job-schema) | `runtime/` | 693 | backend.cjs, orchestration S-5 | **D — deliberate host-stay** | timers, PW-2 routing, hub transport, seam registry — orchestration package already owns the domain |
| 11 | **Config / helpers / metrics / state / utils / scripts** | as listed | ~2,630 | host-wide | **D — NOT A MODULE** | glue; the 4 vbook shim utils are migration bookkeeping |
| 12 | **Routes as a whole** | `routes/**` | 8,065 | backend.cjs | **D — host contour** | extract only with their domain packages (player/editor/assistant precedent); `auth-routes.cjs` rides candidate #1 |

---

## 5. Candidate details

### 5.1 Auth / Identity domain — **B (NEAR READY)**

- **Files:** `auth/auth-service.js` (434), `auth/password.js` (106); `middleware/auth-context.js` (387, policy half — `checkBookAccess`/`requireBookAccess`/`importBookAllowed` are decision logic; Express shells stay host-side); `routes/auth-routes.cjs` (145, thin + injectable authService). Repos (`user/session/guest/workspace`) remain host-side PG implementations behind port contracts.
- **LOC:** ~980 core + 630 repo + 1,257 dedicated tests (`auth-mvp`, `guest-workspace`, `account-workspace`).
- **Consumers (measured):** `middleware/auth-context.js`, `routes/auth-routes.cjs` (direct); `backend.cjs` (global `authContext` mount, `requireBookAccess` guards on 4 route families, login/register rate limits); `@animastor/player` via `playerPorts.assertBookAccess`; import routes (`importBookAllowed`), admin/worker/ai routes via guards; `services/worker-auth.js` shares the identity vocabulary but is a separate boundary.
- **Dependencies:** `crypto` (scrypt) only — no fs, no child_process, no Redis, no Express in the core; 4 PG repos via constructor-injectable requires; 4 env reads (COOKIE_DOMAIN, GUEST_* TTLs) that map 1:1 to injected config.
- **Contract boundary:** already exists in embryo — `AuthError(status, message, reason)`, `bookAccessDecision(identity, bookId) → {ok, status, mode, workspace}` (explicitly documented as "the single authorization contract usable by non-Express callers"), cookie header builders, `publicUser`/`publicWorkspace` shapes.
- **Own state:** none in-process (stateless policy); PG is the store.
- **HTTP/session coupling:** `auth-context.js` interleaves policy with req/res (401/403/410 responses, guest auto-provision cookie writes). The `bookAccessDecision` function is the proven template for the decision/middleware split.
- **Host orchestration coupling:** none — auth never calls orchestrator/media/hub.
- **What extraction requires:** (1) 3–4 repo port contracts (user/session/guest/workspace) — the `@animastor/assistant` `sessionRepo` port pattern is the precedent; (2) split decision functions from Express wrappers (the `bookAccessDecision`/`checkBookAccess` pair is already that split in miniature); (3) env → injected config; (4) move the 3 test suites + add a package-boundary guard (the `installer-package-boundary.test.js` pattern). `auth-routes.cjs` moves as `createAuthRoutes(app, deps)` (player precedent).
- **Why B, not A:** the seam work is small but real (ports + wrappers + test moves), and the domain is security-critical enough that the contract freeze deserves its own audit phase, not a ride-along move.
- **Argumentation:** the previous landscape audit graded this B and nothing since has changed the picture — the host got thinner around it, its own tests are intact, and its only inbound edges (postgres:6, per the measured graph) are exactly the repos a port contract replaces. It is now the only remaining *business domain* in the host with a pure core, injectable deps, dedicated tests, and a small consumer list.

### 5.2 Worker domain core (worker-auth + credential lifecycle) — **C (HOST-BOUND; core-only candidate)**

- **Files:** `services/worker-auth.js` (215), `middleware/worker-auth-middleware.js` (53), `services/share-events.js` (74). Route surface (`worker-routes.cjs`, 814) and repo (`worker-repo.js`, 791 — token grammar, grants, policy lanes) stay host-side today.
- **LOC:** ~360 core.
- **Consumers:** worker-routes, admin-routes, backend.cjs (`startWorkerAuthMirrorSync` at startup), GPU Hub (consumer of the `animastor:worker-auth` Redis mirror — a *contractual* cross-service key family, not a code require).
- **Dependencies:** `worker-repo` (PG) + Redis mirror. The module is exemplary: fail-closed by construction, PG as sole source of truth, mirror never authoritative, share_policy rides the mirror with expiry re-check on read.
- **Contract boundary:** `authenticateWorker(redis, token) → identity|null`, `extractBearerToken`, mirror maintenance API, `toAuthenticatedWorker` shape — a clean package surface already.
- **Coupling:** the hub shares the Redis key family (documented in `redis-failure-model.md` + phase2-redis-ownership-contract guard); the routing half of the domain lives in `gpu-dispatcher` (PW-2/SH-2 lanes) which is deliberate host-stay.
- **What extraction requires:** repo port (worker credential store), Redis mirror port, decision to either move the hub-facing key grammar into the package or keep it contractually shared; worker-routes stay host-shaped until the worker domain gets its own contour.
- **Why C:** a package of ~360 LOC whose main external consumer integrates via a shared Redis key family buys little isolation now. Re-visit when (a) `worker-repo` lifecycle (create/rotate/revoke/grant) is pulled out of `routes/worker-routes.cjs`, or (b) the hub begins importing worker-domain contracts directly.
- **Argumentation:** real domain, real boundary, low extraction value at current size — exactly the "do not extract for LOC's sake" case.

### 5.3 Pure-leaf adoption: dirty-layer + text-analysis cores — **B- (adoption into existing packages, NOT new packages)**

- **Files (all re-measured):**
  - `services/prompt-dependency-registry.js` — 523 LOC, **zero requires**. The single source of truth for "which field dirties which layer" (SCENE_FIELDS/CROSS_FIELDS, computeSceneDirtyLayers, getLayerDependencies).
  - `services/source-coverage.js` — 445 LOC, **zero requires**. Sentence-level coverage matching, chapter-header chains, offset math.
  - `services/encoding-detect.js` — 303 LOC, iconv-lite only. BOM/encoding heuristics.
  - `services/book-diff.cjs` — 517 LOC; pure half (isEqual/diffScene/dirty computation over PDR) vs host half (Redis/PG/state/activeScenes via factory deps).
  - `dependency-graph.js` (root, 87) — wraps PDR.
- **Consumers:** PDR → book-diff + dependency-graph; source-coverage → `agent/pipeline-runner`, `agent/bootstrap`, `source-coverage-audit` (editor port); encoding-detect → `txt-importer`.
- **Proposed destination:** PDR + book-diff pure half → **`@animastor/generation`** (next to `sceneState`, whose dirty semantics PDR drives); source-coverage + encoding-detect → **`@animastor/parser`** orbit (text analysis). This mirrors what the previous audit called "adoption, not extraction" and remains correct: no consumer outside the Animastor ecosystem needs these as standalone npm modules.
- **What it requires:** split `book-diff.cjs` into core + host orchestration (its factory already takes a deps object — the split is mechanical); re-point barrel imports; move the diff/coverage test fixtures.
- **Why B-:** the code is A-grade pure, but the *action* is a package-internal reorganization with barrel/re-export bookkeeping — lower ceremony than a new package, and it removes the last place where "which field dirties which layer" knowledge sits outside the generation package.
- **Argumentation:** strongest cross-directory cohesion finding remaining in the host, but the architecture target ("domain/package = own responsibility + contract + minimal deps") is served by adoption into packages that already own the adjacent domain, not by npm sprawl.

### 5.4 AI-provider plane — **D (HOST-BOUND)**

`ai-service.js` (656), `workspace-ai-provider.js` (754), `system-ai.js` (230), `ai-loader.js` (252), `provider-gateway.js` (174 — one production consumer: backend.cjs, which hands it to assistant ports), `agent-prompts.js` (179), `prompt-profile-loader.js` (107), `profile-override.js` (123 — consumed by audio/generation, workflows, bootstrap — the shared profile seam), `knowledge-base.js` (75), `url-safety.js` (280 — pure, see below), plus settings/admin/ai-endpoint/users routes. Measured blockers unchanged from two audits ago: `system-ai ⇄ workspace-ai-provider` mutual lazy requires (the shared crypto helpers `encryptSecret/decryptSecret/maskKey/normalizeProviderType` are the SCC's spine), 5 lazy PG `query` sites in workspace-ai-provider, `WORKSPACE_SECRET_KEY` env coupling, admin/settings Express surface, the shared-pool resolver chain. **Sequence stays: contract-first (Provider Gateway), SCC break (extract the crypto helpers to a leaf), repo ports — then package.** Not the next extraction.

*Sub-note:* `url-safety.js` is A-grade pure (dns/net only, SSRF guard with per-hop re-validation, security-critical, consumed by ai-service + workspace-ai + assistant ports). At 280 LOC it is not a package; its natural home is wherever the AI-provider plane eventually lands (or `@animastor/contracts`-adjacent security utils), decided together with 5.4.

### 5.5 ai-connector host half — **D (HOST-BOUND)**

`services/ai-connector/{transport 581, shared-pool 432, discovery 215, registry 68}` = 1,296 LOC. **Important disambiguation verified:** the npm package `animastor-ai-connector` (Phase 8) is the LAC *client* — the outbound-WS bridge to local runtimes; **no file in `backend/src` requires it** (only an i18n string reference in the frontend). The host half is the *server side*: in-process WS registry (`isLive` liveness is authoritative), PG connector/endpoint repos, shared-pool eligibility ladder (8-point gate, deterministic V1 selector, per-inference slot reservation), transport with per-inference slot lifecycle. This is runtime state + PG + policy in service of the AI-provider plane — host-bound with it. Extraction would only make sense as part of 5.4, after its seams.

### 5.6 Ingest / agent pipeline host contour — **D (HOST-BOUND)**

`services/agent/` (pipeline-runner 1,370, pipeline-steps 1,340, bootstrap 804, parallel-analysis-orchestrator 441, unit-splitter 300, text-utils 185, image-utils 106, ai-caller 86) + txt-importer (298) + agent-session (129, raw PG) + agent-session-control (81) + window-generator (182) + knowledge-base (75) + agent-prompts (179) + agent-service barrel (59) + `routes/book/import-routes.cjs` (985). ~6,500 LOC — the largest remaining coherent block, and the clearest case of "looks like a module but is host orchestration":

- every entry point is driven from Express routes (bootstrap / bootstrap-next-window / trigger-next-window / resume-bootstrap with cooldowns, dedup sets, in-flight guards in Redis);
- sessions/cancellation are PG rows + Redis cancelled-workers sets checked at every step (the cancel/teardown seam the audit brief calls host-owned);
- SSE progress publishing rides through the O-5 progress-events port;
- it consumes lazy-book (vbook package), layer-config (O-10), agent-session, profile-override, source-coverage, and the AI-provider plane simultaneously;
- `windowGenerator.runBackgroundWindowGeneration` is a reconcile-loop dependency wired in the composition root.

Extracting this would move the host's ingest orchestration into a package while leaving every leg (routes, sessions, SSE, cancellation, windows) behind — a boundary inversion. The realistic future slice is the opposite of extraction: **inline the pure text/window math (`text-utils`, `unit-splitter`) into `@animastor/parser`/ai-analysis** and let the pipeline shrink. Not a candidate.

### 5.7 Media executors — **D (HOST-BOUND)** (unchanged verdict, re-verified)

audio/ (1,839), image/ (1,084), video/ + workflows/video/ (1,860), audio-orchestrator (490), video-orchestrator (526), placeholder-audio (567), task-handler (276), waveform-service (133). All consume `@animastor/generation` (naming/profiles/registry), drive orchestration FSMs through the O-4/O-7/O-8 adapters, and touch config.OUTPUT_DIR / PG / ffmpeg. The prompt-builder (406, pure given profiles) remains a package-internal adoption candidate into `@animastor/generation`'s promptProfiles; the iu-processor execution leg IS the generation executor and stays. No standalone media package exists in this code.

### 5.8 Book-state reconciliation services — **D (HOST-BOUND)**

book-sync (377, read-only SQL auditor), book-source (188), book-event-log (212), entity-cleanup (449, editor purge port), cleanup-service (193), book-deletion (222, host cascade — §2.2), scene-asset-registry (307). Two findings: (1) they are the PG/Redis reconciliation legs of editor/book-deletion/reconcile flows — composition of host adapters; (2) **`services/scene-asset-registry.js` has zero production consumers** (grep-verified: required only by `tests/scene-asset-registry.test.js` and `tests/book-sync.test.js`; production writes go through `scene-assets-repo`/SQL per `docs/03-audit/audit.md` H-note). That file is a **dead-code deletion candidate**, not an extraction candidate (listed in §6 because "looks extractable, actually deletable" is the classic false candidate).

### 5.9–5.12 Storage / Runtime shells / Config-helpers-metrics-state-utils / Routes — **D (NOT A MODULE / deliberate host-stay)**

Re-verified unchanged from the landscape audit: storage is shared host infrastructure (repos travel with domains; schema is doctrine; the barrel `storage/index.js` re-exporting 5 domain services remains the synthetic cycle-maker — dissolving it is preparatory seam work, not a package); runtime/ is the deliberate host shell (loop timers, PW-2 routing in gpu-dispatcher with its 3 lazy PG resolvers, S-5 seam registry, contracts shim); config/helpers/metrics/state/utils are glue, with the 4 vbook shim utils in `utils/` being one-line re-exports awaiting consumer migration; routes extract only with their domain packages — the only ride-alongs today are `auth-routes.cjs` (candidate 1).

---

## 6. False Candidates — what looks like a module but should not be extracted

| Looks like | Why not |
|---|---|
| **`services/scene-asset-registry.js`** (307 LOC, "PG asset registry") | **Dead code, not a domain.** Zero production consumers (tests only); production writes go through `scene-assets-repo`. Extract = publishing dead code. Delete instead (behind its own cleanup pass + guard update). |
| **`services/provider-gateway.js`** (174 LOC, "the gateway") | A delegation facade with exactly **one** production consumer (backend.cjs → assistant ports). Extracting a facade without its delegates extracts nothing. It is the *contract surface* for the future AI-provider package, not a package. |
| **`services/agent-service.js`** (59 LOC) | Pure backward-compatibility barrel over `services/agent/*`. Nothing to extract; a candidate for in-repo deletion-by-migration. |
| **`services/language-detector.js` / `structure-detector.js` / `book/*` / `editor/` / `contracts/` / 4 `utils` shims** | Already extracted domains' compatibility shims (identity re-exports from the audit brief). Move = delete-after-consumer-migration bookkeeping. |
| **`middleware/`** as "middleware package" | Each file belongs to a different domain: auth-context → auth candidate; ai-book-guard → assistant contract (documented host-stay); workspace-ownership → identity/workspace policy; worker-auth-middleware → worker candidate. A "middleware" package would be a random assortment. |
| **`helpers/redis-helpers.cjs`** (486 LOC) | Named like generic infra, but it is book/runtime-specific chunk grammar (requires `../book`, orchestration runtime, gpu-dispatcher at call sites). It is host glue by content, not by location. |
| **`metrics/prometheus.js`** (274) | Observability leaf consumed by runtime-loop + `/metrics`. Orchestration already owns runtime metrics; moving buys nothing. |
| **`services/profile-override.js`** (123) | Small, but it is the shared profile seam consumed by audio + video workflows + agent bootstrap — it is *coupling itself* made into a file. It should dissolve into `@animastor/generation` profiles when the profile seams unify (the media-executor adoption precondition), not become a package. |
| **`storage/` as "storage package"** | The classic false boundary: mixed-domain repos + host doctrine schema + by-design O-port adapters. Repos migrate WITH their domains (auth first). |
| **Ingest/agent pipeline** (§5.6) | Biggest coherent block left, and still a false candidate: it is the host's ingest orchestration — routes, sessions, cancellation, SSE, windows. Extraction would invert the boundary. |
| **`window-generator.cjs` / `task-handler.cjs`** | Factory-shaped but each wires 7–10 host legs; they are composition, extractable only with everything they compose. |

---

## 7. Recommended Extraction Order

Only two real candidates (plus adoption bookkeeping) survive measurement, so the order is short and dependency-driven, not preference-driven:

1. **`@animastor/auth` (B)** — first because: it depends on nothing but its repo ports (measured inbound edges: postgres only); every other remaining candidate either consumes auth vocabulary (worker-auth shares identity policy; import routes consume `importBookAllowed`) or is blocked on seams auth does not touch; and its seam work is precedented on three sides (assistant sessionRepo port, bookAccessDecision split, installer guard pattern). Extraction sequence: contract freeze (AuthError + decision fns + cookie grammar + repo ports) → repo port ADR → test move (3 suites) → physical move + shim → guard.
2. **Adoption of the pure leaves (B-)** — PDR + book-diff core → `@animastor/generation`; source-coverage + encoding-detect → `@animastor/parser`. Independent of #1, cheap, and best done while no other phase is mid-flight in those packages. Can run in parallel with #1 (disjoint files/packages).
3. **`@animastor/worker-domain` core (C)** — only after either `worker-routes.cjs` yields the credential-lifecycle repo surface or the hub starts consuming worker-domain contracts. Not scheduled now; blocked by value, not by risk.

Everything else: explicitly out of order until the AI-provider SCC break (crypto helpers → leaf module) and the storage-barrel dissolution land — those are prerequisites for any future AI-plane or persistence move and are seam work, not extractions.

---

## 8. Final conclusion

**Top candidates:** (1) `@animastor/auth` — B; (2) pure-leaf adoption into generation/parser — B-; (3) worker-domain core — C, parked.

**Best candidate for the next dedicated extraction audit:** **`@animastor/auth`** — the only remaining domain where the core, the contract embryo, the port precedent and the test ownership all already exist, and where the audit's output would be a short list of ADRs (repo ports, env injection, decision/middleware split) rather than a discovery exercise.

**Otherwise, the current host boundary is architecturally justified.** With installer gone and analysis extracted, `backend/src` now reads as the target architecture prescribes: a composition root (995 LOC, zero inbound requires), the O-2..O-10 adapter ring, media executors and the ingest pipeline as host legs of already-extracted packages, the AI-provider plane awaiting its contract-first sequence, storage/runtime as shared infrastructure, and two genuinely under-formed domains (auth, worker) of which one is ready to move. Reducing the LOC count further by force would move orchestration into packages and make the architecture worse, not better.

---

## Appendix A — verdict legend

**A** READY · **B** NEAR READY (small seam work first) · **C** HOST-BOUND (domain exists, coupling too strong today) · **D** NOT A MODULE / deliberate host-stay (orchestration/runtime seam, shared infra, or false candidate)

## Appendix B — measured facts this audit rests on

- 191 files / 43,339 LOC in `backend/src/**/*.{js,cjs}`; 70 files (148 require sites) consume extracted `@animastor/*` packages.
- `backend.cjs`: zero inbound `require('../backend.cjs')` anywhere in the repo.
- Auth: 434+106 LOC, requires = postgres repos + `./password` only; 3 test suites = 1,257 LOC.
- `worker-auth.js`: 215 LOC; mirror key `animastor:worker-auth`; consumers = worker-routes, admin-routes, backend.cjs, hub (contractual).
- PDR 523 / source-coverage 445 / encoding-detect 303 — zero (or iconv-only) requires.
- `system-ai.js` ⇄ `workspace-ai-provider.js`: 4 + 2 mutual lazy require sites (SCC).
- `services/scene-asset-registry.js`: zero production requires (tests only).
- npm `animastor-ai-connector`: zero requires from `backend/src` (LAC client package ≠ host `services/ai-connector/`).
- `storage/index.js` barrel re-exports 5 domain services (synthetic cycle-maker, persists).
