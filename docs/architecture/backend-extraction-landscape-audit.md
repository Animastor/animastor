# Backend Extraction Landscape Audit — Remaining `backend/src` Candidates

**Status:** AUDIT ONLY. No files moved, no packages created, no production code changed, no imports/APIs touched.
**Date:** 2026-09-14
**Scope:** everything still physically inside `backend/src/` after the completed physical extractions (Generation, Player, Editor, Orchestration, VBook Runtime, Parser, Contracts, AI Agent/Analysis, Assistant, Worker, GPU Hub, LAC/connectors, web-* frontends).
**Question answered:** *which remaining logically-cohesive domains/subsystems inside `backend/` are mature enough for physical extraction into npm packages, and which must stay host-only for now?*

Method: static require-graph scan over all 218 `backend/src/**/*.{js,cjs}` files (resolved relative requires, Tarjan SCC, domain-level edge/consumer counting), direct file reading of every major domain, consumer tracing, package-seam inspection against `packages/animastor-*`, cross-check with `docs/architecture/PHASE_NEXT_MODULE_EXTRACTION_RECONNAISSANCE.md` (the pre-VBook baseline) and the O-2..O-10 port adapter layer.

---

## 1. Current map of `backend/src`

Legend: LOC measured; "pkg seams" = dependencies already flowing through extracted `@animastor/*` packages (healthy boundary indicators).

| Domain | Files | LOC | Purpose | Infra deps | Extracted-pkg seams | HTTP contour | Domain core | Composition-root wiring |
|---|---|---|---|---|---|---|---|---|
| `backend.cjs` (root) | 1 | 995 | Composition root: port bindings (G/O1–O-10), host-module bindings, Express app, routes registration, startup/reconcile, graceful shutdown | Redis, PG, FS, Express | generation, orchestration, player, editor, assistant, parser, vbook-runtime, contracts | app-level | — | **is** the composition root |
| `services/` (flat) | 44 | 10,668 | Generation/ingest/Book-derived/AI-provider services (see §3.8 breakdown) | PG (8 files direct SQL), Redis, FS, HTTP(fetch), ffmpeg, child_process | generation, orchestration, parser, ai-analysis | via routes | partial | via backend.cjs factories |
| `installer/` | 31 | 12,699 | Private GPU Worker installer: manifests, resolver, download planner, plan, safety rules, verification, engine (io/downloader/worker/state/…), uninstaller, CLI | **none** (fs/path/crypto/os/child_process only; HTTP in downloader via injected fetch) | **none** (fully self-contained, zero `../` escapes) | CLI (`animastor-installer` bin) | **yes — pure** | `MANIFEST_ROOT` baked-in/repo fallback |
| `storage/` (flat) | 11 | 1,426 | O-2..O-10 host adapters + filesystem-store + asset-registry + persistence-adapter seams | PG, Redis, FS | generation, orchestration | no | adapters by design | bound in backend.cjs |
| `storage/postgres/` | 20 | 5,798 | `pg` pool, 1809-LOC schema, 15 repositories (user, session, guest, workspace, book, book-source, scene-assets, iu, task, gen-session, worker, chat-session, ai-connector, ai-endpoint, events, generation-cancel) | PG | generation (naming) | no | repositories | `storage.postgres.initialize()` |
| `routes/` + `routes/book/` | 27 | 8,064 | HTTP contours: ai-connector (919), worker (814), generation (593), debug (578), connector, ai-endpoint, settings-ai, worker-setup, admin, auth, book-routes registrar, users, workflow, config | PG (direct SQL in 4 files), Redis, FS, Express, ws | generation, orchestration, editor | **yes** | thin controllers | registered by backend.cjs |
| `audio/` | 11 | 1,839 | TTS chunk pipeline: segments/splitting, ffmpeg merge/trim/probe, silence, validation, generation orchestration | fs, child_process(ffmpeg), music-metadata | **generation** (naming, provider, profiles) | no | partial (segments/chunks pure-ish) | — |
| `image/` | 7 | 1,084 | IU image pipeline: prompt builder, iu-processor, registry, preview (sharp) | fs, sharp, music-metadata, PG (2 lazy) | **generation, orchestration** | no | partial (prompt-builder pure) | — |
| `video/` | 4 | 1,211 | LTX multi-image video job building, scene-video registry, merge pipeline, timeline offsets | fs, child_process(ffmpeg), PG (1 lazy), Redis | **generation** | no | small (job building) | — |
| `workflows/video/` | 1 | 649 | LTX workflow JSON builders (group DP, frames, characters, locations) | PG (1 lazy) | **generation** (heavy: profiles, bookData, provider) | no | **mostly pure builders** | — |
| `state/` | 5 | 611 | Scene state ops (PG sync), asset-state-store facade over generation.sceneState, event-journal (Redis append-only) | PG, Redis | **generation** (sceneState, mediaRegistry) | no | thin facades | — |
| `auth/` | 2 | 540 | Authentication: register/login/logout, session resolve, guest identity, cookie grammar, book-access decision, scrypt password | crypto only + PG via 4 repos | none | via `routes/auth-routes.cjs` | **yes — auth core is pure policy + repo calls** | no |
| `middleware/` | 4 | 626 | auth-context (session→req.user/guest/workspace, requireAuth/requireAdmin/requireBookAccess, checkBookAccess), ai-book-guard, workspace-ownership, worker-auth-middleware | PG via repos | none | Express middleware | mixed | mounted by backend.cjs |
| `runtime/` | 4 | 693 | runtime-loop (timer shell over orchestration runtime), gpu-dispatcher (workspace routing → hub HTTP), job-schema (contracts shim), orchestration-seams (S-5 registry) | Redis, PG (3 lazy), HTTP→hub | **orchestration, generation, contracts** | no | shims + one dispatcher | seams registered in backend.cjs |
| `config/` | 2 | 370 | runtime-config (env + constants, 15 env reads) + generation-config-adapter (S-6) | env | generation (port setter) | no | env blob | adapter bound in backend.cjs |
| `metrics/` | 1 | 274 | Prometheus registry (prom-client) | prom-client | generation (mediaRegistry) | `/metrics` | pure gauges | — |
| `helpers/` | 2 | 502 | redis-helpers (chunk Redis grammar, factory), utils (log/pad/collectScenes) | Redis, PG(lazy) | generation, orchestration | no | no | factory(redis) in backend.cjs |
| `utils/` | 7 | 227 | string-utils, scene-hash, speech-estimation + **4 shims → vbook-runtime** | crypto | **vbook-runtime** (4 of 7 files are shims) | no | pure | — |
| `book/` | 15 | 66 | **All shims** → `@animastor/vbook-runtime` (index, lazy-book/*, book-model, books-root, bundle-validator) | — | **vbook-runtime, parser** | no | extracted | configureBooksRoot + setStructureDetector in backend.cjs |
| `editor/`, `routes/editor/`, `contracts/` | 3 | 37 | Shims → `@animastor/editor`, `@animastor/contracts` | — | editor, contracts | no | extracted | — |
| `services/ai-agent/`, `services/agent/`, `services/ai-connector/` | 18 | 6,321 | See §3.8 | PG, Redis(ws), async_hooks, p-limit | ai-analysis, generation, orchestration | ai-connector WS | mixed | — |
| `scripts/` | 1 | 260 | dev test scene-split script | — | — | no | no | — |

### Already-existing extraction boundaries (host modules with GOOD package seams thanks to previous phases)

- **`book/`** — pure shim tree over `@animastor/vbook-runtime`; composition root injects `booksRoot` + structure-detector. The Book domain is DONE; nothing host-side remains except the deletion cascade (§3.4).
- **`utils/character-identity|scene-title-utils|snake-guard`** — one-line vbook-runtime re-exports. Candidate for deletion-by-migration (consumers should import the package) — bookkeeping, not extraction.
- **`contracts/runtime-result.js`, `runtime/job-schema.js`** — thin facades over `@animastor/contracts`. DONE.
- **`services/language-detector.js`, `services/structure-detector.js`** — host adapters binding `@animastor/parser`'s detector port. DONE as designed (parser owns the contract).
- **`state/asset-state-store.js`, `services/generation-progress.js`** — facades over `@animastor/generation` core (sceneState, generationProgress). DONE.
- **`storage/*-adapter.js` (9 files)** — the O-2..O-10 host adapter layer: every orchestration port's concrete leg lives here, lazily. These are *by-design host-owned* — the seams exist so the packages stay pure.
- **`routes/editor/index.cjs`, `editor/index.js`** — editor package shims. DONE.
- The Generation media services (`audio|image|video`) all already consume `@animastor/generation` naming/registry/profiles — meaning the **next natural move direction for them is INTO the generation package**, not a new package.

---

## 2. Dependency / SCC findings (measured)

**File-level SCCs (Tarjan over resolved requires):**

- `services/system-ai.js ⇄ services/workspace-ai-provider.js` — the only true file-level cycle (mutual lazy `require` at call time; documented Phase 3 seam: decryptSecret/maskKey/normalizeProviderType shared by system-ai, resolver chain uses systemAi kill-switch). Lazy requires make it runtime-acyclic, but statically it is a real SCC — any AI-provider-domain extraction must first inline/move the shared crypto helpers (encryptSecret/decryptSecret/maskKey/normalizeProviderType) into a leaf module.

**Domain-level cycles (from the domain edge graph):**

- `services → video → workflows → services` (video-merge → profile-override; video-timeline/video-service → workflows; workflows → profile-override + PG). The media-generation tier is still one SCC-shaped cluster: `services ⇄ media(audio/image/video/workflows)`.
- `services → storage → services` (storage barrel re-exports services/book-*, services/gen-scope, services/layer-config, services/book-event-log; those services require postgres + config) — the **storage barrel is a synthetic cycle-maker**. The barrel `storage/index.js` aggregates domain services (bookEventLog, bookSource, bookSync, layerConfig, genScope) that themselves sit under `storage/postgres`. Removing the barrel indirection (consumers import the concrete service) is the seam work for any persistence extraction.
- `middleware → services → middleware`-adjacent: worker-auth-middleware → services/worker-auth (fine, single direction); ai-book-guard → chat-session-repo. Not cycles.
- `helpers → state/book/runtime` (redis-helpers lazy-requires book, gpu-dispatcher) — direction is helper→domain, acceptable, but it means redis-helpers is NOT generic infra; it is book/runtime-specific.

**Other findings:**

- **No `backend.cjs` back-references** — 10 files mention backend.cjs only in comments; zero runtime `require('../backend.cjs')`. Composition-root purity holds.
- **No deep `../../../` escapes** except one legit in-package one (`services/ai-agent/tasks/scenes.js → utils/snake-guard`, which is itself a vbook-runtime shim).
- **No hidden `require()` literals** beyond analyzed statics; `audio/generation.js`, `video/video-merge.js`, `image/iu-processor.js` etc. use call-time lazy `require` for PG repos (documented adapter discipline, not hidden coupling).
- **env reads:** 27 files read `process.env`; concentrated in `config/runtime-config.js` (15), `auth/auth-service.js` (4: COOKIE_DOMAIN, GUEST_* TTLs), `services/workspace-ai-provider.js` (WORKSPACE_SECRET_KEY), `services/system-ai.js`, `backend.cjs` (PORT/HUB_URL/BUILD_TTL), `video/video-merge.js` (VIDEO_FPS). This is a healthy picture: candidate domains are already env-clean.
- **Filesystem/process-global:** installer touches fs/os/child_process by design (it IS an installer); media services touch fs+ffmpeg by design; auth touches NO fs, NO child_process — only `crypto` + repos + cookies.
- **Cross-domain cluster worth naming:** "Book-derived state services" — `services/{book-diff, book-sync, book-source, book-event-log, book-deletion, entity-cleanup, prompt-dependency-registry}` + `state/scene-state-ops` form a coherent *book-state reconciliation* subsystem spread across two directories. It is the strongest "files from multiple dirs forming one logical module" finding in this audit.
- **AI-provider/inference cluster:** `services/{ai-service, ai-loader, system-ai, workspace-ai-provider, url-safety, provider-gateway, agent-prompts, prompt-profile-loader, profile-override, knowledge-base, agent-session(-control)}` + `services/ai-connector/*` + `services/ai-agent/{ports,context,tasks}` + `routes/{ai-connector, ai-endpoint, settings-ai, admin, users}` — coherent but riddled with PG repos, the system-ai⇄workspace-ai SCC, and the Express surface.

---

## 3. Domain-by-domain audit

### 3.1 Audio (`backend/src/audio`, 1,839 LOC)

**Purpose:** TTS generation pipeline — text→segments→chunks, ffmpeg merge/trim/probe, silent placeholders, canonical merge, book audio assembly.

- Internal split is already excellent (post-monolith split: helpers/connector-utils/ffmpeg/validation/chunks/segments/pipeline/generation/silence).
- External deps: `fs`, `child_process` (ffmpeg/ffprobe), `music-metadata`, `@animastor/generation` (artifactNaming in 4 files, comfyuiProvider in barrel, promptProfiles.assemblyProfile in generation.js).
- Host deps: `services/profile-override` (generation.js:11, workflows-style profile seam), 2 lazy PG repo reads (`storage/postgres/repositories/scene-assets-repo`, lazy), `../state` (lazy, generation.js:253), `../utils/string-utils` (getOutputPath→config.OUTPUT_DIR).
- Consumers: `backend.cjs`, `services/audio-orchestrator.js` (chunks), `services/placeholder-audio.js` (silence), `services/audio-recovery.cjs`, `storage/audio-fsm-adapter.js` (O-7), routes via deps. Also `image` never requires audio — good.
- HTTP contour: none. Domain core: yes for segments/silence/chunks/validation (~700 LOC); generation.js (599) is the host-coupled part.
- **Verdict: C — DOMAIN CORE ONLY.** The pure DSP/text-splitting/ffmpeg-grammar core (segments, chunks, silence, ffmpeg, validation, helpers ≈ 860 LOC) is extraction-ready into the *generation* package's orbit, but `generation.js`'s profile-override/PG/state coupling and the profile seam belong host-side. Better framed as: audio is a *generation-package member*, not its own package. Not the next move.

### 3.2 Image (`backend/src/image`, 1,084 LOC)

**Purpose:** IU-image prompt building, workflow generation, IU processing, registry persistence, sharp previews.

- Deps: `@animastor/generation` (provider, characterUtils, assemblyProfile, artifactNaming — 8 import sites), `@animastor/orchestration` (runtime.dispatch — 6 lazy call sites in iu-processor!), `../config/runtime-config` (3), PG (iu-repo + 3 lazy `database.query`), `../services/profile-override`, `storage/filesystem-store`, sharp.
- Consumers: backend.cjs, orchestration host bindings (media.image), task-handler.
- iu-processor directly drives the orchestration dispatch engine — it is runtime-adjacent execution logic, not pure image domain.
- **Verdict: D — HOST-BOUND (for now).** The prompt-builder (406 LOC, pure given assembly+characterUtils) is package material but the right target is *moving prompt-builder into `@animastor/generation`'s promptProfiles* — a package-internal reorganization, not a standalone extraction. The iu-processor execution leg must stay host-side (it IS the generation executor).

### 3.3 Video (`backend/src/video` + `workflows/video`, 1,860 LOC)

Split as requested:

- **Pure video/domain logic:** `workflows/video/video-workflows.js` (649 LOC) — LTX workflow JSON building, group DP, frame alignment (toValidLTXFrames), character/location refs. Mostly pure builders; deps: generation promptProfiles + bookData port + 1 lazy PG read (frame-ref fallback) + `services/profile-override` + `utils/string-utils`. `video-timeline.js`'s offset math is pure but deliberately imports workflows for the LTX tax constant.
- **ffmpeg/ffprobe infrastructure:** `video-merge.js` (665 LOC — spawn/spawnSync, concat, trim, keyframe forcing), `video-timeline.js` probing half, `audio/ffmpeg.js` analog.
- **generation-specific logic:** `video-service.js` (job spec building, scene-video Redis registry, locks, availability), `video-orchestrator.js` (FSM in services/).
- **playback-specific logic:** `video-timeline.computeVideoStartMs` — *already* a host port injected into `@animastor/player` (backend.cjs:525). Deliberately host-side: the file documents why the player must not own it.
- **host-only adapters:** everything above (the whole directory is host adapters over generation/orchestration packages).

**Answer to the audit question:** No independent `video` package exists or should exist. Everything substantial already belongs to: Player (playback offsets — done via port), Generation (workflow building, naming — package exists, these files are its host executors), Orchestration (FSM — done via O-8 port), host (ffmpeg infra, Redis registries, merge driver). **Verdict: E — NOT A MODULE** (as a standalone package); the workflow-builder file is a *generation-package adoption* candidate, not a new package. `video-merge`'s profile-resolution seam (profile-override, 2 sites) blocks even that until profiles unify.

### 3.4 Book (`backend/src/book`, 66 LOC)

After VBook Runtime / Player / Editor extraction, what remains in host "book":

- **canonical model** → `@animastor/vbook-runtime` (shim). DONE.
- **persistence** → nothing book-side; books live on disk (vbook) + `book-repo`/`book-source-repo` in storage/postgres.
- **projections** → `book.findSceneRuntimeData / collectSceneUnits` are vbook-runtime functions injected into player/generation ports.
- **filesystem** → vbook-runtime (booksRoot injected).
- **mutation logic** → `@animastor/editor` (editorModel.persistBook = book.saveBookBundle).
- **deletion** → **host-only**: `services/book-deletion.cjs` (222 LOC) — the 7-step cancellation→cleanup cascade with injected ports (setCancelFlag, agentSessionControl, purgeAssistantForBook). Correctly host-side (it coordinates Redis + PG + FS + hub + agent sessions). Not extraction material; it is the composition of host adapters.
- **runtime-specific logic** → orchestration package.

**Verdict: book domain is FINISHED.** The only remaining "book" logic in host is the *book-derived state reconciliation* cluster (§3.8): book-diff/book-sync/book-source/book-event-log + prompt-dependency-registry. That cluster is about *generation state*, not book format — see Services.

### 3.5 Auth (`backend/src/auth` + middleware + routes, ~1,311 LOC total)

Can it be separated?

- **authentication domain (auth-service.js, 434 LOC):** register/login/logout/resolveSession/resolveGuest + guest identity + cookie grammar + `bookAccessDecision` policy. Deps: `crypto` (scrypt password.js — 106 LOC, zero deps), 4 PG repos via constructor-injectable requires, 4 env reads. **Pure core: username/email/password validation, cookie header grammar, TTL policy, publicUser shapes (~250 LOC) with repo + clock ports.**
- **session/identity logic:** sessionRepo (120 LOC repo) — token-hash-only storage; guestRepo. Clean separation already.
- **authorization/policy:** `bookAccessDecision` (auth-service), `checkBookAccess`/`requireBookAccess`/`requireWorkspaceMembership` (auth-context middleware, 387 LOC), `ai-book-guard` (98). Policy is *interleaved* with Express req/res semantics (410 responses, cookie setting on guest auto-provision).
- **Express middleware/routes:** auth-routes.cjs (145, thin + injectable authService), auth-context mounted globally, worker-auth-middleware (53).
- **DB/Redis adapters:** PG only (sessions, guests, users, workspaces). No Redis.

**Findings:** the domain is cohesive, low-volume, zero-external-dep (crypto only), already has 1,257 LOC of dedicated tests (auth-mvp, guest-workspace, account-workspace). Blockers: (a) authorization helpers are Express-shaped — a package would need to expose decision functions (`bookAccessDecision` style) plus thin host middleware wrappers (pattern already proven by `bookAccessDecision`); (b) repos are concrete PG implementations — package needs a 3-repo port contract (user/session/guest), same shape as assistantPorts; (c) middleware/auth-context also reaches bookRepo/workspaceRepo for guest book resolution — that's *policy*, belongs in the package behind the port. The ai-book-guard session-repo seam already demonstrates the pattern (contract in package, PG impl host-side).

**Verdict: B — EXTRACTABLE WITH SEAM WORK.** Strong candidate, but not #1: value is real (identity policy is security-critical and benefits from frozen contract + isolated tests) yet consumer count is small (4 routes + backend.cjs + player port assertBookAccess).

### 3.6 Storage (`backend/src/storage`, flat + postgres, 7,224 LOC)

Split:

- **generic infrastructure:** `postgres/database.js` (42, pool), `postgres/schema.js` (1,809 — DDL, host-owned by doctrine `postgres-host-infrastructure.test.js`).
- **Postgres repositories:** 15 repos, 4,276 LOC. Mixed domains: user/session/guest/workspace (identity), book/book-source (book), scene-assets/iu/task/gen-session/generation-cancel (generation runtime), worker (worker domain), chat-session (assistant), ai-connector/ai-endpoint (AI provider), events (audit).
- **Redis:** asset-registry (Redis grammar), event-journal (state/), progress-pubsub (services/) — Redis usage is spread across domains, correctly.
- **filesystem:** filesystem-store (337, naming wrappers over generation.artifactNaming + fs ops) — generic infra *plus* generation seam.
- **domain-specific persistence:** the O-2..O-10 adapters (runtime-persistence, scene-data, placeholder-audio, progress-events, audio-fsm, video-fsm, hub-cancel, layer-config) — these are *by-design host adapters* for orchestration ports. The barrel `storage/index.js` (31 LOC) additionally re-exports 5 domain services (bookEventLog, bookSource, bookSync, layerConfig, genScope) — a synthetic cycle-maker (§2).

**Verdict: D/E — HOST-BOUND / NOT A MODULE.** Storage as a whole is shared host infrastructure; the repos belong to their consumer domains (identity repos → auth candidate; scene-assets/iu/task → generation-runtime; worker-repo → worker). There is NO real package boundary here today. The only sensible storage-side moves are: (1) dissolving the `storage/index.js` barrel (seam work for later phases), (2) repos migrating WITH their domain packages (auth does this). The schema file staying host-side is an explicit doctrine.

### 3.7 Runtime (`backend/src/runtime`, 693 LOC)

After orchestration extraction:

- `runtime-loop.js` (351): host timer shell — tick/reconcile scheduling over `@animastor/orchestration` runtime (scheduler, counterReconciliation, reconciliation, metrics) + prometheus. Host-stay by design (§32.30).
- `gpu-dispatcher.js` (224): workspace routing policy (book→workspace→private lane→system pool) + hub HTTP send. Host-owned PW-2 policy; consumes generation.mediaRegistry, contracts jobProtocol, 3 lazy PG repos. This is the dispatch-transport host adapter — the generation package reaches it via `ports.dispatchTransport` (backend.cjs:24).
- `job-schema.js` (31): contracts shim. DONE.
- `orchestration-seams.js` (87): S-5 seam registry — the runtime→orchestration boundary. Host-stay by design.

No runtime domain, scene/window state, reconciliation, cancellation, or recovery logic remains here — all of it lives in `@animastor/orchestration` (runtime/*: scene-window, active-scenes, reconciliation-engine, dispatch-engine, runtime-result-emitter, circuit-breaker, …). What remains is intentionally host-bound: timers, routing policy, HTTP transport, port wiring.

**Verdict: D — HOST-BOUND (deliberately).** No runtime package should be formed from these files; the extraction already happened in the other direction (orchestration package took the domain). gpu-dispatcher could only move if routing resolvers were ported — currently correct as host adapter.

### 3.8 Services (`backend/src/services`, 62 files, 17,929 LOC — grouped, not one module)

Grouped by domain:

**Group A — Book-derived state reconciliation (the strongest cross-directory cluster):**
`book-diff.cjs` (517), `prompt-dependency-registry.js` (523, ZERO requires — pure), `book-sync.js` (377, read-only auditor), `book-source.js` (188, wraps vbook + scene-hash), `book-event-log.js` (212, events-repo), `dependency-graph.js` (root, 60, wraps PDR), `state/scene-state-ops.js` (190). Cohesive purpose: *scene-level change detection → dirty-layer computation → PG/Redis reconciliation*. Consumers: routes (regenerate), orchestration reconciliation (via adapters), backend.cjs. Deps: generation.mediaRegistry/artifactNaming, PG repos, Redis helpers, book (vbook). Mostly factory/DI-injectable already (bookDiff takes deps object). 
→ **Verdict: B — EXTRACTABLE WITH SEAM WORK** (see ranking; PDR is A-grade pure core today).

**Group B — Media executors (generation host legs):** `audio-orchestrator.js` (490, audio FSM — O-7 adapter owns it), `video-orchestrator.js` (526, video FSM — O-8), `placeholder-audio.js` (567, O-4), `waveform-service.js` (133, ffmpeg→player port), `audio-recovery.cjs` (303, merged into reconcile cycle), `cleanup-service.cjs` (193), `entity-cleanup.cjs` (449, editor purge port), `scene-asset-registry.js` (307, PG-backed asset registry), `gen-scope.js` (172, Redis scope + layer-config-adapter O-10), `layer-config.js` (298, O-10), `generation-progress.js` (160, generation facade), `progress-pubsub.cjs` (SSE pub/sub, O-5 adapter).
→ **Verdict: E (as a group) — host adapters for orchestration ports.** Each is already correctly framed as the concrete leg of an O-port; they were deliberately left host-side. No package here.

**Group C — AI provider/inference plane:** `ai-service.js` (656), `workspace-ai-provider.js` (754), `system-ai.js` (230), `ai-loader.js` (252), `provider-gateway.js` (174), `url-safety.js` (280 — zero-dep SSRF guard, pure), `agent-prompts.js` (179), `prompt-profile-loader.js` (107), `profile-override.js` (123), `knowledge-base.js` (75), `agent-session.js` (129) + `agent-session-control.js` (81), `ai-agent/` barrel+ports+context+tasks (611), `ai-connector/` (1,296: registry/transport/discovery/shared-pool), `agent/` pipeline (4,632).
→ Sub-verdicts: `url-safety.js` is **A-grade pure** (zero deps, dns/net only, heavily security-critical, tested by shared-pool/lac suites) but tiny; the resolver chain (`system-ai ⇄ workspace-ai` SCC + 5 lazy PG sites + shared-pool + settings routes) is **D — HOST-BOUND** (matches the previous reconnaissance's Provider Gateway verdict: "contract-first, not package-first"). The `agent/` pipeline is orchestration-adjacent host execution (PG sessions, cancellation, generation dispatch) — **D**.

**Group D — Ingest/parsing host legs:** `txt-importer.js` (298, vbook + config + encoding-detect), `structure-detector.js` (host adapter → parser), `language-detector.js` (shim → parser), `encoding-detect.js` (303, pure + iconv-lite), `source-coverage.js` (445, PURE — zero requires), `source-coverage-audit.js` (147, wraps source-coverage + editor port), `window-generator.cjs` (182, factory: redis+txtImporter+state+placeholderAudio).
→ `source-coverage.js` is **A-grade pure** (belongs with parser/vbook orbit); `encoding-detect.js` is **A-grade pure** (iconv-lite only). Rest: host adapters.

**Group E — Worker domain host legs:** `worker-auth.js` (215, fail-closed Bearer→identity + Redis mirror), `share-events.js` (74, payload contract). Consumers: worker-routes, admin-routes, middleware, gpu-hub (via Redis mirror key grammar shared with hub). 
→ **Verdict: C — DOMAIN CORE ONLY** (the fail-closed resolution policy + mirror discipline could become a worker-domain package with repo+redis ports; but the hub shares the Redis key family contractually — extraction value is modest while worker routes stay host-shaped).

**Group F — misc glue:** `assistant-ports.cjs` (163, assistant package host adapter — DONE by design), `task-handler.cjs` (276, factory over media executors), `workflow-manager.js` (557, animastor-comfyui-workflow-connector loader wrapper), `book-deletion.cjs` (222 — see §3.4), `agent-service.js`, `book-sync` covered, `metrics`… → **E.**

### 3.9 Middleware (626 LOC)

- `auth-context.js` — identity + authorization policy (see §3.5): **part of the auth candidate** (thin Express shell around decision functions).
- `ai-book-guard.js` — assistant-domain authorization guard; stays host-side per the assistant extraction doc (session-repo contract already lives in the package). **D** (deliberate host-stay, documented).
- `workspace-ownership.js` — book→workspace resolution policy (PG repos); pure resolvable function `resolveWorkspaceForBook` already injected into editor ports. Part of *identity/workspace domain*, not standalone. **D.**
- `worker-auth-middleware.js` — thin shell over services/worker-auth. **Part of worker-domain C.**

No wholesale middleware extraction; correctly split by owning domain.

### 3.10 Installer (`backend/src/installer`, 31 files, 12,699 LOC)

- Self-contained: **zero requires outside the directory**, zero npm deps beyond Node builtins (fs/path/crypto/os/child_process/readline), no Express/Redis/PG/extracted packages.
- Own `package.json` (name `animastor-installer`, v1.3.0, bin, engines) already declaring package identity *inside* backend — the only backend subdirectory with its own manifest.
- Consumers: exactly **one** production consumer — `routes/worker-setup-routes.cjs` (via `setup-contract.js` projections); plus external consumers: GPU Hub packages it into the installer tarball (docker artifacts `installer-src`), CLI bin, e2e scripts. The hub reads its `package.json` version as canonical and mirrors the bundled layout — a two-sided artifact contract.
- 16 dedicated test suites (installer-*.test.js) — the largest package-shaped test ownership in backend.
- MANIFEST_ROOT has a baked-in `/app/artifacts` vs repo fallback — the only environment coupling, already injectable.
- Content paths: reads `backend/ai/install-manifests`, `backend/ai/workflows`, repo worker bundle dir (canonical `packages/animastor-worker/worker` + legacy fallback, both existsSync-guarded, injectable fs).
- **Verdict: A — READY / HIGH CONFIDENCE.** This is a de-facto package living inside the host: package.json, bin, self-containment, own tests, external artifact contract (hub tarball), single narrow host consumer (setup-contract projections). Extraction = `git mv` + workspace wiring + keeping the artifact paths working (the hub/INSTALLER_SRC_DIR contract makes the *layout*, not the repo path, the interface — docker already ships it as `installer-src`).

### 3.11 Routes (8,064 LOC)

Routes are the HTTP contour of the host: ai-connector (WS + routes, well-tested), worker (worker domain), generation (ingestion/SSE), debug, admin, auth (thin), settings-ai, users, worker-setup (installer projection), connector/workflow (wf loader), config, book registrar + book/* sub-contours. Per the established doctrine (Player/Editor/Assistant precedent): route contours extract only *with their domain package + ports* (player/editor/assistant pattern: package exposes `createXRoutes(app, redis, deps)`). The remaining routes do not yet have domain packages to ride with — except:
- `routes/auth-routes.cjs` — thin, injectable → rides the auth candidate.
- `routes/worker-setup-routes.cjs` — pure projection over installer → rides the installer candidate trivially (it is the ONLY consumer).
- `routes/ai-connector-routes.cjs` + ai-endpoint + settings-ai + users + admin — the AI-provider control plane: D until the resolver SCC + repo seams are done (same verdict as the Provider Gateway reconnaissance).
→ Routes as such: **E** (host contour) with two named exceptions above.

### 3.12 Remaining singles

- `metrics/prometheus.js` — observability leaf, consumed by runtime-loop + `/metrics`. **E** (host infra; moving it buys nothing — orchestration already owns runtime metrics).
- `config/` — runtime-config is the host config doctrine; generation-config-adapter is the S-6 host adapter. **D/E** by design.
- `helpers/` — redis-helpers is book/runtime-specific Redis grammar (factory over redis); utils is shared logging. **E** (host glue). The 4 vbook shim utils are migration bookkeeping.
- `state/` — thin facades (asset-state-store→generation.sceneState, scene-state-ops→PG sync, event-journal→Redis append log). **E/D** — event-journal is the documented single allowed runtime→ orchestration observability sink; stays host.
- `startup-resume.js`, `dependency-graph.js`, `scripts/` — host/bookkeeping. **E.**

---

## 4. Candidate ranking

| # | Candidate | Files (dirs) | LOC | Logical cohesion | Host coupling | Seam work needed | Extraction value | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | **Worker Installer** | `installer/**` (+ rides: `routes/worker-setup-routes.cjs` optional) | 12,699 (+290) | Very high — install manifests/planner/engine/uninstaller is one product | Very low — zero code deps in/out except setup-contract projections | Tiny: repo layout for manifests/workflows/bundle paths (already injectable), hub artifact contract regression check | High — 12.7k LOC out of host, own identity already (`package.json`, bin), 16 tests move with it, docker/hub layout unchanged | **A — READY** |
| 2 | **Auth/Identity domain** | `auth/*`, `middleware/auth-context.js`, `middleware/worker-auth-middleware.js`, `services/worker-auth.js`, `routes/auth-routes.cjs`, + repos `user/session/guest/workspace` as host-side ports | ~1,900 core + 630 repo | High — one identity/session/authorization policy | Medium — PG repos concrete, Express-shaped policy helpers, 4 env reads | Medium: 3-4 repo port contracts, split decision fns vs Express wrappers, env→config injection, move 1,257 LOC tests | Medium-high — security-critical policy frozen behind contract; enables future workspaces phases | **B — SEAM** |
| 3 | **Book-derived state reconciliation core** | `services/prompt-dependency-registry.js`, `services/book-diff.cjs` (core half), `services/source-coverage.js`, `services/encoding-detect.js`, `state/scene-state-ops.js` (port), `dependency-graph.js` | ~1,500 pure core | High — scene-change→dirty-layer computation is one algorithm family | Low-medium for the pure half (PDR+source-coverage zero-requires; book-diff needs generation.mediaRegistry port + deps object already factory-injected) | Small-medium: express dirty-layer core behind generation-package port or its own package; book-sync (SQL auditor) stays host | Medium — stabilizes the diff/dirty grammar shared by editor/regenerate/reconcile; but its natural home is *inside* `@animastor/generation` (adjacent to sceneState), not necessarily standalone | **C — CORE ONLY** (strongest pure pieces are A-grade; composite is seam-bound) |
| 4 | AI-provider control plane (ai-service/workspace-ai/system-ai/url-safety/provider-gateway + ai-connector routes) | ~3,800 | Medium-high | High (PG repos, SCC, settings/admin routes, kill-switch) | Large (resolver port, SCC break, repo contracts) | Medium | **D — HOST-BOUND** |
| 5 | Media executors (audio/image/video/workflows host legs + FSM services) | ~5,800 | Medium (pipeline-shaped) | High (config.OUTPUT_DIR, PG, orchestration dispatch, profile-override) | Large | Deferred — right target is adoption INTO `@animastor/generation`, not standalone | **D — HOST-BOUND** |
| 6 | Worker-domain core (worker-auth policy) | ~500 | High | Medium (Redis mirror key grammar shared with hub) | Medium | Low-medium | **C — CORE ONLY** |
| 7 | Storage (postgres + barrel + adapters) | 7,224 | Low (mixed domains) | Very high | Large (barrel dissolution, domain split) | Negative as a unit | **D/E** |
| 8 | Runtime shells (loop, gpu-dispatcher, seams) | 693 | Medium | Very high (by design) | — | None | **D — HOST-BOUND (deliberate)** |
| 9 | `url-safety.js`, `source-coverage.js`, `encoding-detect.js`, `prompt-dependency-registry.js` as micro-packages | 1,451 | High each | Zero/near-zero | Tiny | Individually low; best folded into existing packages (parser/generation) | **A-grade cores, E as standalone packages** (adoption, not extraction) |
| 10 | Metrics/config/helpers/state singles | ~2,000 | Low | High | — | — | **E — NOT A MODULE** |

---

## 5. Top 3 next extractions

### Top 1 — `@animastor/installer` (backend/src/installer)

- **Why:** it already *is* a package in every measurable way except physical location: self-manifested (`package.json` w/ name/version/bin/engines), zero inbound/outbound code requires (verified: no `../` escapes, only node builtins), own CLI bin, 16 dedicated tests, external artifact consumers (GPU Hub tarball layout, docker `installer-src`, e2e scripts) that consume the *layout*, not the host. The single host consumer (`worker-setup-routes.cjs`) reaches it through the narrow `setup-contract.js` projection surface. 12,699 LOC — the largest remaining extraction win by an order of magnitude, at the lowest risk.
- **Files:** `installer/**` (31 files). Optional rider: `routes/worker-setup-routes.cjs` can register through a package-exported `createSetupContractRoutes` later — not required for the move.
- **Consumers:** `routes/worker-setup-routes.cjs` (setupContract.*), GPU Hub (tarball `installer-src` layout + canonical version read), docker compose/e2e scripts, `animastor-installer` bin, 16 test suites.
- **Host dependencies:** none (node builtins only).
- **Seams needed:** (1) content roots — `backend/ai/install-manifests`, `backend/ai/workflows`, `packages/animastor-worker/worker` (canonical) — become injected paths with today's defaults preserved (MANIFEST_ROOT already has the baked-in/repo fallback pattern; worker-bundle-source already takes injectable fs + canonical/legacy dir list); (2) keep `backend.package.json` bin entry or re-point it to the new location; (3) hub `INSTALLER_SRC_DIR`/tarball contract regression (docker artifact checks + phase10 suites already pin it).
- **Approx scope:** `git mv backend/src/installer packages/animastor-installer` + workspace `file:` dep + host `require('@animastor/installer')` shim for `worker-setup-routes` (one import) + move 16 test files + update `scripts/check-artifacts.sh` expectations if paths change (they read docker artifacts, likely unchanged). Small.
- **Risks:** LOW. Content-path regressions (manifests/workflows/bundle dirs) — all already injectable/guarded; hub artifact contract — pinned by existing tests; version canonicality — hub reads package.json wherever it lives via INSTALLER_SRC_DIR.
- **Architectural benefit:** removes the single largest non-host block from backend; makes the installer independently versionable/testable in lockstep with the worker package it ships; clarifies that backend is purely the runtime host.

### Top 2 — `@animastor/auth` (identity/session/authorization domain)

- **Why:** the only remaining *business domain* in host with (a) a cohesive pure core (validation, cookie grammar, session TTL policy, bookAccessDecision, scrypt password module — zero deps), (b) injectable repos, (c) dedicated tests (1,257 LOC), (d) clear consumer list. The ai-book-guard session-repo contract in `@animastor/assistant` already demonstrates the exact port pattern needed.
- **Files:** `auth/auth-service.js`, `auth/password.js`, `middleware/auth-context.js`, `middleware/worker-auth-middleware.js`, `services/worker-auth.js`, `routes/auth-routes.cjs`; host-side stays: PG repos (user/session/guest/workspace/worker) behind port contracts.
- **Consumers:** backend.cjs (global authContext + guards + playerPorts.assertBookAccess), routes (auth, generation, admin, book/import, worker, users, settings-ai via guards), player package (assertBookAccess port).
- **Host dependencies:** 4 PG repos, 4 env knobs, Express req/res in policy shells.
- **Seams:** 3–4 repo port contracts; decision-function/middleware-wrapper split (the `bookAccessDecision`/`checkBookAccess` pair is the template); env → injected config; move auth tests.
- **Scope/risk:** MEDIUM (security-sensitive; low volume; strong test coverage to port).
- **Benefit:** freezes identity policy behind a contract; prerequisite-grade work for the planned workspaces/account phases; shrinks host surface where changes carry the highest security risk.

### Top 3 — Dirty-layer/reconciliation core adoption into `@animastor/generation`

- **Why:** `prompt-dependency-registry.js` (523, zero requires), `source-coverage.js` (445, zero requires), `encoding-detect.js` (303, iconv only) are A-grade pure cores currently parked in `services/`. The dirty-layer grammar (PDR + book-diff core + dependency-graph) is consumed by editor (purge), routes (regenerate), and orchestration reconciliation — three packages/contours sharing host-resident domain logic. Rather than a new package, the natural move is *adoption*: PDR/dirty-layer math joins `@animastor/generation` (next to sceneState, which it drives), source-coverage + encoding-detect join the `@animastor/parser` orbit (they are text-analysis).
- **Files:** `services/prompt-dependency-registry.js`, `dependency-graph.js`, `services/book-diff.cjs` (pure half: isEqual/diffScene/ensureDirtyScene; PG/Redis half stays), `services/source-coverage.js`, `services/encoding-detect.js`.
- **Consumers:** book-diff.cjs (routes/regenerate, orchestration reconcile via adapters), editor purge ports, source-coverage-audit, txt-importer.
- **Seams:** book-diff factory already takes deps; split file into pure core + host orchestration; keep barrel exports for tests.
- **Risk:** LOW-MEDIUM (pure code; main risk is test-fixture moves).
- **Benefit:** completes the generation package's ownership of the scene-state grammar; removes the last cross-package knowledge duplication of "which field dirties which layer".

---

## 6. Recommended next extraction

**`backend/src/installer` → `packages/animastor-installer` (`@animastor/installer`).** Verdict A. It is the only candidate where seam work is near-zero and the physical move is the extraction.

## 7. What should NOT be extracted yet

- **Media executors** (`audio/`, `image/`, `video/`, `workflows/video/`, FSM/placeholder/waveform services) — host legs of generation/orchestration/player; the correct eventual move is partial adoption into `@animastor/generation` after profile-override seams unify. No standalone media package exists in this code.
- **AI-provider control plane** (workspace-ai/system-ai/ai-service/settings+admin+ai-connector routes, shared-pool) — blocked by the system-ai⇄workspace-ai SCC, concrete PG repos, and Express coupling; contract-first (Provider Gateway) remains the right order.
- **Storage/postgres + storage barrel + O-adapters** — shared host infrastructure; barrel dissolution is preparatory work, not a package.
- **Runtime shells** (loop, gpu-dispatcher, orchestration-seams) — deliberately host-bound (§32.30, S-5, PW-2).
- **Routes in general** — extract only with their domain packages (Player/Editor/Assistant precedent): auth-routes with auth; worker-setup-routes trivially with installer; everything else waits.
- **`book/`, `editor/`, `contracts/`, vbook-shim utils** — already done; only consumer-import migration bookkeeping remains.

## 8. Concrete next-step seam tasks for Top 1 (installer)

1. **Content-root injection audit (no move):** confirm every fs touch in `installer/` resolves through `MANIFEST_ROOT` / `worker-bundle-source` / injected `io.fs` (engine already uses `createMemoryFs`/`createDryRunIo` in tests) — list any direct `backend/ai` path literals for conversion to the existing root pattern.
2. **Consumer inventory freeze:** `routes/worker-setup-routes.cjs` imports only `setup-contract.js` (verify via guard test); add/confirm an architecture test pinning "installer has zero requires outside its directory" (a one-day mirror of `generation-package-boundary.test.js`).
3. **Hub artifact contract regression:** run `scripts/check-artifacts.sh` + phase10 installer-related suites against the docker build to re-pin the `installer-src` layout + canonical-version read (INSTALLER_SRC_DIR) before the move.
4. **Bin/workspace wiring plan:** relocate `bin.animastor-installer` entry from backend `package.json` to the package; add root `file:` dependency (`@animastor/installer`); keep a one-line host shim at `backend/src/installer/index.js` re-exporting the package (relocation-checklist §2.4 pattern) so `worker-setup-routes` and any stray test imports keep working during migration.
5. **Test move plan:** the 16 `tests/installer-*.test.js` suites move with the package (they require `../src/installer/*` — flip to package imports); decide package-local mocha config mirroring `animastor-worker`'s.
6. **Only then:** physical `git mv`, workspace symlink, delete shims at consumer leisure.

---

## Appendix A — measured domain dependency snapshot (internal requires, count of edges)

```
(root backend.cjs) → services:22 routes:14 storage:9 postgres:9 book:5 runtime:3 state:3 middleware:3 config:2 video:2 helpers:2 audio:1 image:1 metrics:1 ai-connector:1
services → postgres:14 config:7 book:6 agent:5 utils:5 ai-connector:5 audio:2 state:2 runtime:2 storage:1 video:1 helpers:1 middleware:1
services/agent → services:19 utils:7 postgres:3 config:3 book:3 ai-agent:1
routes → services:18 postgres:14 routes/book:11 config:5 ai-connector:5 middleware:4 auth:1 runtime:1 installer:1 editor-shim:1
storage → services:11 postgres:6 config:1 book:1            ← barrel-driven synthetic cluster
video → config:3 workflows:2 services:1 postgres:1 runtime:1
workflows → services:1 utils:1 postgres:1                   ← video⇄workflows⇄services cycle
middleware → postgres:6 auth:1 services:1
audio → services:1 postgres:1 state:1 utils:1
image → config:3 utils:2 postgres:2 services:1 storage:1
auth → postgres:6                                            ← only host coupling of auth
runtime → postgres:3 config:1 metrics:1
installer → (nothing; only node builtins)
```

Extracted-package consumption by host domains (healthy seams): generation (audio, image, video, state, storage, metrics, services, helpers, config-adapter, root), orchestration (runtime, image, storage, services, routes, root), vbook-runtime (book, utils, root), parser (book, services, root), editor/assistant/player/contracts/ai-analysis (root + shims).

## Appendix B — verdict legend

A READY · B SEAM WORK · C CORE ONLY · D HOST-BOUND · E NOT A MODULE
