# Backend Decomposition Reconnaissance — post-extraction state (c21.4+)

**Status:** RECONNAISSANCE ONLY. No files moved, no packages created, no production code changed.
**Date:** 2026-09-25
**Branch:** `c21.4-physically-extract-analysis-from-backend` (HEAD `d5cbfba9`)
**Question answered:** *После всех уже выполненных extraction осталось ли в backend что-либо, что имеет смысл физически вынести в отдельные модули?*

Method: fresh inventory of `backend/src` (192 files, ~43,058 LOC), full static require-graph scan (resolved relative requires), consumer tracing per candidate block, direct reading of every module with a plausible seam, cross-check against `backend-extraction-landscape-audit.md` (commit `958bfd7c`) — **without** assuming its verdicts still hold. Where the audit predicted movement, the current tree was re-verified.

---

## 1. What has physically left the host (verified)

The following packages exist and are consumed by `backend/src` (verified via `backend/package.json` + require sites):

| Package | Extraction status |
|---|---|
| `@animastor/contracts` | DONE — `backend/src/contracts/runtime-result.js` is a facade; `runtime/job-schema.js` facade |
| `@animastor/vbook-runtime` | DONE — `backend/src/book/**` is **100% shims** (15 files, 66 LOC total) |
| `@animastor/parser` | DONE — `services/language-detector.js` is a 4-line shim; detector port bound in composition root |
| `@animastor/player` | DONE — `createPlayerRoutes` called from `backend.cjs`; playback offset injected via port |
| `@animastor/editor` | DONE — `backend/src/editor/index.cjs` shim; editor ports bound in composition root |
| `@animastor/generation` | DONE — S-6/S-7 host ports (`dispatchTransport`, `profileStore`, `bookData`) bound in `backend.cjs:24–33`; media services consume its naming/registry/profiles |
| `@animastor/orchestration` | DONE — O-2..O-10 port adapters (`storage/*-adapter.js`, 9 files) bound in `backend.cjs` |
| `@animastor/ai-agent` | DONE — pure mechanism package (assertHostPorts + generic execute lifecycle) |
| `@animastor/ai-analysis` | DONE — tasks live in package; `backend/src/services/ai-agent/` retains a barrel + a **duplicated task copy** (see §5.1) |
| `@animastor/assistant` | DONE — `createAssistantPorts` host adapter + `createAssistantRoutes` |
| `@animastor/auth` | DONE (commit `41cc9aca`) — `backend/src/auth/` is now a **composition-root shim** (168 LOC); domain in package; PG repos stay host-side |
| `@animastor/gpu-hub` | DONE |
| `@animastor/installer` | DONE (commit `97df4b7d`) — `worker-setup-routes.cjs` imports `@animastor/installer`.setupContract |
| `animastor-worker`, `animastor-comfyui-workflow-connector`, web-* packages | DONE |

Notably: the two Top candidates of the previous audit (`installer` A-READY, `auth` B-SEAM) were **both executed** since that audit. The dependency direction discipline holds: zero `require('.../backend.cjs')` back-references found; composition root (`backend.cjs`, 995 LOC) binds all ports/adapters before package modules load.

---

## 2. Inventory of remaining `backend/src` (~43k LOC, 192 files)

| Area | LOC | Content |
|---|---|---|
| `routes/` (+book/, editor/) | 8,065 | HTTP contour (ai-connector 919, worker 814, import 985, generation 659+593, debug 578, …) |
| `services/` (flat) | ~12,600 | Book-state reconciliation, AI-provider plane, media executors, worker-auth, agent pipeline (agent/ 4,632), ai-connector/ (1,296) |
| `services/agent/` | 4,632 | Ingest/agent orchestration pipeline (runner 1,370, steps 1,340, bootstrap 804, parallel orchestrator 441) |
| `storage/` | 7,353 | 9 O-port adapters (by design), postgres/ (schema 1,809 + 16 repos), filesystem-store, asset-registry |
| `audio/` | 1,839 | TTS pipeline (segments/chunks/ffmpeg/silence/validation + generation.js) |
| `video/` + `workflows/video/` | 1,860 | LTX job building, merge (ffmpeg), timeline, workflow JSON builders |
| `image/` | 1,084 | Prompt builder (406), iu-processor, registry, preview (sharp) |
| `runtime/` | 693 | runtime-loop, gpu-dispatcher, orchestration-seams, job-schema (facade) |
| `state/` | 611 | scene-state shims → generation, scene-state-ops (PG sync), event-journal (Redis) |
| `middleware/` | 588 | auth-context, workspace-ownership, ai-book-guard, worker-auth-middleware |
| `config/` | 370 | runtime-config (env), generation-config-adapter (S-6) |
| `helpers/` | 502 | redis-helpers (factory), utils (log) |
| `auth/` | 168 | composition-root shim → `@animastor/auth` |
| `metrics/` | 274 | Prometheus registry |
| `utils/` | 227 | scene-hash, speech-estimation, string-utils + 3 shims → vbook-runtime |
| `book/`, `editor/`, `contracts/` | 96 | pure shims |
| root (`backend.cjs`, `dependency-graph.js`, `startup-resume.js`) | 1,139 | composition root + PDR-derived layer graph + startup resume |
| `scripts/` | 260 | dev-only scene-split test script |

### Dependency graph findings (measured)

**File-level SCC (only one true cycle remains):**
- `services/system-ai.js ⇄ services/workspace-ai-provider.js` — mutual **lazy** (call-time) requires; statically a real SCC. Shared crypto helpers (`encryptSecret/decryptSecret/maskKey/normalizeProviderType`) are the cycle's substance. Blocks any AI-provider-plane extraction.

**Domain-level cycles:**
- `services → video → workflows/video → services` — via `profile-override` (video-merge → profile-override; workflows → profile-override + lazy PG). The media tier is one SCC-shaped cluster.
- `storage/index.js barrel → services → storage/postgres` — the barrel re-exports 5 domain services (`bookEventLog, bookSource, bookSync, layerConfig, genScope`) that live under `storage/` and themselves require postgres+config. Synthetic cycle-maker. Exactly **one** production consumer of the barrel remains (`backend.cjs`).

**Hidden couplings (no import-graph edge):**
- `services/ai-loader.js` + `services/knowledge-base.js` read `process.env.AI_DIR` and hardcode host paths `backend/ai/**` (rules/skills/examples/profiles). This is a *filesystem-contract* coupling consumed by the whole agent/AI contour through injected `prompt()`/`getExamples()` ports — clean at the port level, host-owned at the content level.
- `profile-override.js` is the de-facto shared profile seam of the entire media tier (audio/generation, video/merge, image/iu-processor, workflows/video) — one file, 123 LOC, dependency `animastor-comfyui-workflow-connector` only.
- `utils/string-utils.js` mixes pure `escapeRegExp` with `getOutputPath → config.OUTPUT_DIR` (host config reach-in from a "utils" leaf).

**Env reads:** concentrated in `config/runtime-config.js`, backend.cjs, `workspace-ai-provider.js` (4), `system-ai.js`, `ai-service.js`, `auth/` shim (resolved into package config), `video-merge.js` (VIDEO_FPS). Candidate pure modules are env-clean.

---

## 3. Verdicts per area

Verdict vocabulary (strict, per task): READY · READY WITH SEAM WORK · ADOPT INTO EXISTING PACKAGE · HOST-BOUND · NOT WORTH EXTRACTING.

A candidate is good only if extraction yields a real physical boundary: `host → package → explicit ports/contracts → adapters`. Package must not depend on `backend/src/...`, Express, PG internals, Redis internals, `process.env`, host fs paths, host stores, or implicit singletons.

### 3.1 Pure leaves (previous hypotheses re-checked)

| Module | LOC | Deps (verified now) | Verdict |
|---|---|---|---|
| `services/prompt-dependency-registry.js` | 523 | **zero requires** — pure | **ADOPT INTO `@animastor/generation`** |
| `dependency-graph.js` (root) | 87 | PDR only | **ADOPT INTO `@animastor/generation`** (with PDR) |
| `services/source-coverage.js` | 445 | **zero requires** — pure | **ADOPT INTO `@animastor/parser`** |
| `services/encoding-detect.js` | 303 | iconv-lite only | **ADOPT INTO `@animastor/parser`** |
| `services/url-safety.js` | 280 | dns, net only — pure | **READY WITH SEAM WORK** (micro-package) — see §4.4 |
| `utils/scene-hash.js` | 103 | crypto only — pure | **ADOPT INTO `@animastor/generation`** (drives scene-state invalidation) |
| `utils/speech-estimation.js` | 42 | zero — pure | **ADOPT INTO `@animastor/generation`** (contract-coupled with agent-prompts constants) |
| `utils/cyr-latin-map.js` | 39 | zero — pure | **ADOPT INTO `@animastor/generation`** (a copy already exists in generation package — dedupe) |

Re-check of the previous audit's "adopt, don't extract" call for the A-grade pure cores: **still correct, now even stronger.** Since `@animastor/generation` already owns `sceneState` + `mediaRegistry` (the consumers of the dirty-layer grammar), PDR/scene-hash/dependency-graph have an existing canonical home. `source-coverage` + `encoding-detect` are text-analysis; parser already owns language detection and is consumed via exactly the same injection pattern.

**New finding (post-extraction opportunity):** `backend/src/services/ai-agent/tasks/{scenes,units,locations}.js` (488 LOC) are **stale first-generation copies** of tasks that now live in `@animastor/ai-analysis` in evolved form (package versions use the generic `execute()` lifecycle from `@animastor/ai-agent`; host copies still hand-roll the lifecycle and require host shims `../ports`, `../../../utils/snake-guard`). `pipeline-steps.js` consumes only the **barrel** `../ai-agent` → package. The host task copies have **zero production consumers** (only architecture tests reference the paths). This is deletion/migration bookkeeping, not extraction: **verdict ADOPT (complete) — delete host copies after re-pointing 5 architecture tests.** It is the physical remainder of c21.4 this branch was named for.

### 3.2 Storage / repository layer — HOST-BOUND (confirmed)

- `postgres/schema.js` (1,809) — host doctrine (`postgres-host-infrastructure.test.js`).
- 16 repositories (4,276 LOC) — each belongs to a consumer domain; identity repos already sit behind `@animastor/auth` ports (host adapters per that package's design). Repos are SQL-tied by doctrine; moving them would relocate host internals without a boundary gain.
- 9 O-2..O-10 adapters — **by design** the concrete legs of orchestration ports. The seams already exist; that is precisely what makes them host files.
- `filesystem-store.js` (337) — wraps `generation.artifactNaming` + `config.OUTPUT_DIR`; host fs adapter.
- `asset-registry.js` (110), `runtime-persistence-adapter.js` (233) — Redis/PG host legs.

Seam note (not extraction): dissolve `storage/index.js` barrel (single consumer `backend.cjs`) — removes the only synthetic storage→services cycle.

### 3.3 HTTP/routes + middleware — HOST-BOUND (with one rider)

Routes are the host contour. The established doctrine (player/editor/assistant precedent: extract routes **with** their domain package) has exhausted its candidates:
- `auth-routes.cjs` lost its rider — auth already extracted; the route is a thin injectable shell that stays.
- `worker-setup-routes.cjs` now projects `@animastor/installer`; the route itself stays host (Express + repos + config).
- `worker-routes.cjs` (814) + `worker-auth-middleware` + `services/worker-auth.js` (215) — the worker domain core: fail-closed Bearer→identity resolution + Redis mirror. Previous "C — CORE ONLY" re-checked: the Redis **key grammar is contractually shared with the GPU Hub** (`gpu-hub-contract.test.js`, `redis-ownership.test.js`), so extraction would require a cross-package key-family contract for ~500 LOC of policy with 4 host consumers. **Verdict: HOST-BOUND** (extraction value negative until the hub contract itself is renegotiated — not worth it now).
- `middleware/auth-context.js` (349) — policy is in the package; this file is the Express adapter. Host.
- `workspace-ownership.js`, `ai-book-guard.js` — documented host-stays.

### 3.4 AI-provider plane — HOST-BOUND (confirmed, SCC unchanged)

`ai-service.js` (656), `workspace-ai-provider.js` (754), `system-ai.js` (230), `provider-gateway.js` (174), `ai-loader.js` (252), `prompt-profile-loader.js` (107), `profile-override.js` (123) + `ai-connector/` (1,296: registry 68 in-memory session map, transport 581, discovery 215, shared-pool 432) + routes.

- The `system-ai ⇄ workspace-ai-provider` SCC persists (lazy requires). Breaking it = moving shared crypto helpers into a leaf module — feasible seam work, but the plane still has: 5 lazy PG sites, `process.env` reads (workspace secret key, OpenRouter keys), and 5 route files.
- `ai-connector/transport.js` + `registry.js` are LAC-v1 protocol machinery over an in-memory WS session map. A `@animastor/lac-transport` package (protocol + multiplexing, session registry as a port) is *technically* formable — but its only consumers are host routes and the shared pool, the protocol spec/contract tests already live host-side, and the win is a package for a single consumer. **NOT WORTH EXTRACTING** today.
- `profile-override.js` — see §3.6: it is the blocker for media-tier adoption, not a package candidate.

### 3.5 Ingest / agent orchestration — HOST-BOUND (confirmed)

`services/agent/` (4,632 LOC: pipeline-runner 1,370, pipeline-steps 1,340, bootstrap 804, parallel-analysis-orchestrator 441, unit-splitter 300, text-utils 185, image-utils 106, ai-caller 86) + `agent-session.js`/`agent-session-control.js` + `txt-importer.js` (298) + `window-generator.cjs` (182) + `source-coverage-audit.js` (147).

Re-checked whether c21/c21.1 package extractions unlocked this: no. The pipeline is the **host executor** of the AI-analysis contour: it owns PG session/step bookkeeping (`agent-session` → direct SQL), cancellation flags (PG+Redis), generation dispatch into orchestration, config-driven windowing, and prompt-content loading (`ai-loader` → host `backend/ai/**` files). Every one of these is a host capability that enters via injected ports into packages — the inversion would require porting the persistence + prompt-content contract wholesale, i.e. re-creating the orchestration/adapters layer for a single internal consumer. **HOST-BOUND.**

Minor seam worth noting: `parallel-analysis-orchestrator.js` (441 LOC) is nearly pure (only `p-limit`), but it is a strategy of the host runner — adopting it into `@animastor/ai-agent` would drag a p-limit dep into a zero-dep package for no consumer outside host. **NOT WORTH EXTRACTING.**

### 3.6 Media executors (audio/image/video/workflows) — ADOPT INTO `@animastor/generation` (phased), rest HOST-BOUND

Re-checked the previous audit's "right target is adoption into generation" — structure unchanged, but the seam is now precisely locatable:

- **Blocker = `services/profile-override.js` (123 LOC).** Consumed by `audio/generation.js`, `video/video-merge.js`, `image/iu-processor.js`, `workflows/video/video-workflows.js`, plus routes. It resolves ComfyUI workflow profiles via `animastor-comfyui-workflow-connector`. Its consumers overlap the generation package's provider/profile surface.
- Pure/mostly-pure pieces with clear package homes:
  - `image/prompt-builder.js` (406) — pure given assembly profile + character utils → **ADOPT INTO `@animastor/generation`** (prompt-profiles orbit).
  - `workflows/video/video-workflows.js` (649) — mostly pure LTX workflow JSON builders (deps: generation profiles/bookData port, 1 lazy PG fallback read, profile-override, string-utils) → **ADOPT WITH SEAM WORK** (inject the PG frame-ref fallback + profile seam).
  - `audio/` pure core (segments, chunks, silence, ffmpeg grammar, validation, helpers ≈ 860 LOC) → **ADOPT WITH SEAM WORK** (`string-utils.getOutputPath` → path port; escapeRegExp → keep host copy or contracts).
- Host-forever legs: `image/iu-processor.js` (drives orchestration dispatch engine — it *is* the executor), `video/video-merge.js` (ffmpeg driver + PG), `video/video-service.js` (Redis registry), FSM orchestrators (`audio-orchestrator`, `video-orchestrator` — already O-7/O-8 adapter legs), `placeholder-audio` (O-4), `waveform-service` (player port leg), `scene-asset-registry`, `gen-scope`, `layer-config` (O-10), `progress-pubsub`/`generation-progress` (O-5 legs), `audio-recovery`, `cleanup-service`, `entity-cleanup` (editor purge port leg).

### 3.7 Composition-root remnants — HOST-BOUND (by design)

`backend.cjs` (995), `config/*` (370), `runtime/runtime-loop.js` (351), `runtime/gpu-dispatcher.js` (224 — PW-2 routing policy + hub HTTP transport), `runtime/orchestration-seams.js` (87), `helpers/redis-helpers.cjs` (435 — book/runtime-specific Redis grammar, not generic infra), `metrics/prometheus.js` (274), `state/event-journal.js`, `startup-resume.js`, `services/book-deletion.cjs` (222 — 7-step cancellation/cleanup cascade composing host adapters), `services/task-handler.cjs` (276 — media executor composition), `services/workflow-manager.cjs` (557 — connector loader wrapper), `services/book-sync.js` (377 — SQL auditor), `services/book-diff.cjs` host half (Redis dirty-marking + FSM transitions), `scripts/`.

`book-diff.cjs` re-check: the **pure half** (`isEqual`, `diffScene`, dirty-layer derivation) already delegates to PDR; the remaining 517 LOC are Redis Lua/JS dirty-marking + chunk reset + FSM-valid transitions — host execution against the chunk grammar. Splitting the file would leave a 60-LOC shell; the grammatical home of the pure part is PDR (→ generation). **ADOPT (via PDR), no standalone package.**

### 3.8 Micro-shims — bookkeeping, not extraction

`book/**` (15 files → vbook-runtime), `editor/index.cjs`, `contracts/runtime-result.js`, `runtime/job-schema.js`, `services/language-detector.js`, `state/scene-state.js`, `utils/{snake-guard,scene-title-utils,character-identity}.js`, `auth/` (2 files). These are intentional compatibility shims (relocation-checklist §2.4 pattern). Consumer-migration + deletion is hygiene: `utils/` shims have exactly one consumer each.

---

## 4. READY / seam-work candidates — detail

Only two candidates survive the strict boundary test this pass; both are small, surgical, and follow the `@animastor/*` standard (pure, zero host imports, ports injected, tests move with code).

### 4.1 `@animastor/media-naming` — NOT recommended; folded into adoption instead

Considered and rejected: a standalone "naming/utils" package (scene-hash + speech-estimation + cyr-latin-map + escapeRegExp ≈ 215 LOC). All four have an existing canonical package (`generation`) that already contains a duplicate `cyr-latin-map`. A micro-package would add publication/boundary overhead for sub-300 LOC. **Verdict: ADOPT INTO EXISTING PACKAGE** (listed here because the previous audit floated micro-packages — re-tested and declined).

### 4.2 Candidate: adoption batch into `@animastor/generation` — "scene-state dirty grammar"

1. **Proposed package:** no new package — `@animastor/generation` (new subpath export `./dirty-grammar`).
2. **Sources:** `services/prompt-dependency-registry.js`, `dependency-graph.js`, `utils/scene-hash.js`, `utils/speech-estimation.js`, `utils/cyr-latin-map.js`, pure half of `services/book-diff.cjs` (isEqual/diffScene/layer derivation only).
3. **Public API:** `computeSceneDirtyLayers`, `getLayerDependencies`, `computeSceneHash`, `generateBuildId`, `estimateSpeechDurationSec`, `cyrToLatin`, `DEPENDENCY_GRAPH` projection.
4. **Ports:** none required — all five inputs are pure; `speech-estimation` constants are a documented contract with `agent-prompts` (S4-F guard) — keep the contract test host-side.
5. **Dependencies:** zero (generation package deps unchanged).
6. **Consumers:** host `book-diff.cjs`, `book-sync.js`, `book-source.js`, `scene-asset-registry.js`, `state/scene-state-ops.js`, `services/agent/*` (speech estimation ×4), `image/helpers.js`, `routes` (via deps), `tests/architecture/generation-media-registry.test.js`.
7. **Remains in backend:** Redis/PG dirty-marking execution (host half of book-diff), book-sync SQL auditor, all consumers' wiring.
8. **Files physically deleted from backend:** `services/prompt-dependency-registry.js`, `dependency-graph.js`, `utils/scene-hash.js`, `utils/speech-estimation.js`, `utils/cyr-latin-map.js` (host copies; consumers re-point to package or thin shims per §2.4 pattern).
9. **Architecture guards:** extend `generation-package-boundary.test.js`: package must not import host paths; host `utils/` shims pinned to package subpaths; S4-F speech-estimation contract re-pointed to package.
10. **Tests:** move `prompt-dependency-registry.test.js` (354), `scene-hash.test.js` (101) into the package; add golden cross-check `host book-diff dirty output == package computeSceneDirtyLayers output` during the transition.
11. **Complexity: LOW.** Pure code, zero deps, existing home, dedicated tests. Main risk: import-path churn (~15 files).

### 4.3 Candidate: adoption batch into `@animastor/parser` — "text-ingest analysis"

1. **Proposed package:** no new package — `@animastor/parser` (subpath exports `./source-coverage`, `./encoding-detect`).
2. **Sources:** `services/source-coverage.js` (445, zero requires), `services/encoding-detect.js` (303, iconv-lite).
3. **Public API:** `buildCoverageIndex`, coverage-check/repair-hint functions consumed by agent runner; `detectEncoding`, `decodeBuffer`.
4. **Ports:** none (pure); iconv-lite becomes a parser dependency (first dep of that package — acceptable; or inject a decode port to keep zero-dep).
5. **Dependencies:** `iconv-lite` (or decode port).
6. **Consumers:** `services/agent/pipeline-runner.js`, `services/agent/bootstrap.js`, `services/source-coverage-audit.js`, `routes/book-routes.cjs` (coverage audit), `services/txt-importer.js` (encoding).
7. **Remains in backend:** `source-coverage-audit.js` (editor-port wrapper), `txt-importer.js` (host fs/config).
8. **Files physically deleted:** `services/source-coverage.js`, `services/encoding-detect.js` (re-pointed via shims then deleted).
9. **Architecture guards:** parser-package-boundary test extended (no host requires; iconv optional-dep policy).
10. **Tests:** move `source-coverage.test.js` (82); encoding-detect currently covered indirectly — add a direct suite in the package.
11. **Complexity: LOW.**

### 4.4 Candidate: `@animastor/url-safety` — READY WITH SEAM WORK (micro-package)

1. **Proposed package:** `@animastor/url-safety` (SSRF guard).
2. **Sources:** `services/url-safety.js` (280).
3. **Public API:** `assertPublicEndpoint`, `safeFetch`.
4. **Ports:** DNS resolution + fetch injectable (currently module-level `dns`/`net`/global fetch — resolve functions become ports for deterministic tests).
5. **Dependencies:** zero (node builtins).
6. **Consumers:** `workspace-ai-provider.js`, `ai-service.js`, `assistant-ports.cjs`, `routes/settings-ai-routes.cjs`, `routes/admin-routes.cjs`.
7. **Remains in backend:** all consumers and their wiring.
8. **Files physically deleted:** `services/url-safety.js`.
9. **Architecture guards:** package-boundary test (no host requires, no env reads).
10. **Tests:** security suites (`workspace-ai-security`, `ai-shared-*`) keep running against consumers; add package-local suite for the redirect/rebind matrix (the security-critical part deserves a frozen contract).
11. **Seam changes required:** (a) inject `dnsResolver` + `fetchImpl` ports instead of module-global dns/fetch; (b) the operator exemption flag (`validatePublic=false`) becomes an explicit parameter, removing the implicit env contract; (c) decide package vs. adoption into `@animastor/ai-connector`-adjacent surface — standalone preferred because assistant package consumes it too.
12. **Complexity: MEDIUM** (security-critical; seam work is small but the test matrix must move and freeze).

**Why only these:** everything else either *is* a host adapter by design (O-ports, media executors, routes), is blocked by the last SCC (AI-provider plane), or has no consumer outside one host file (LAC transport, parallel orchestrator).

---

## 5. Post-extraction opportunities that did not exist before

1. **Stale `services/ai-agent/tasks` copies** (§3.1) — the c21.1 package evolution made the host task files dead code reachable only by tests. Deletion is now possible *because* the extraction happened. (Completes this branch's own scope.)
2. **`book/` tree is 100% shims** — vbook-runtime extraction completed; the legacy `backend/src/book` require paths can be retired consumer-by-consumer (backend.cjs itself still uses `./book`).
3. **`storage/index.js` barrel** now has exactly one consumer — dissolving it is a one-file change that removes the synthetic storage→services cycle (preparation for any future storage move, valuable in itself).
4. **Auth extraction** removed the repos' last non-SQL consumer; `postgres-host-infrastructure` doctrine is now clean of domain policy.
5. **`utils/` shims** each have a single consumer — migrate and delete.

---

## 6. Summary table

| Candidate | Area | Verdict | Main blocker | Proposed package | Complexity |
|---|---|---|---|---|---|
| prompt-dependency-registry + dependency-graph + scene-hash + speech-estimation + cyr-latin-map | book-state grammar / utils | **ADOPT INTO EXISTING PACKAGE** | none (pure; import churn) | `@animastor/generation` (`./dirty-grammar`) | LOW |
| source-coverage | ingest text analysis | **ADOPT INTO EXISTING PACKAGE** | none (pure) | `@animastor/parser` (`./source-coverage`) | LOW |
| encoding-detect | ingest text analysis | **ADOPT INTO EXISTING PACKAGE** | iconv-lite dep policy in parser | `@animastor/parser` (`./encoding-detect`) | LOW |
| stale ai-agent task copies (scenes/units/locations) | ai-agent contour | **ADOPT (complete) — delete host copies** | 5 architecture tests pin old paths | — (deletion) | LOW |
| url-safety | SSRF guard | **READY WITH SEAM WORK** | dns/fetch must become injectable ports; security test matrix freeze | `@animastor/url-safety` | MEDIUM |
| image/prompt-builder | media | **ADOPT INTO EXISTING PACKAGE** | assembly-profile import direction | `@animastor/generation` (prompt-profiles) | MEDIUM |
| workflows/video builders | media | **ADOPT INTO EXISTING PACKAGE (WITH SEAM WORK)** | profile-override seam + 1 lazy PG read | `@animastor/generation` | MEDIUM |
| audio pure core (segments/chunks/silence/ffmpeg grammar) | media | **ADOPT INTO EXISTING PACKAGE (WITH SEAM WORK)** | `getOutputPath` → config reach-in | `@animastor/generation` | MEDIUM |
| profile-override | media seam | **HOST-BOUND** (until media adoption) | shared by 4 media consumers + routes | — | — |
| ai-provider plane (ai-service, workspace-ai, system-ai, gateway, ai-loader) | AI plane | **HOST-BOUND** | system-ai⇄workspace-ai SCC, PG, env, 5 route files | — | — |
| ai-connector/ (registry, transport, discovery, shared-pool) | AI plane / LAC | **NOT WORTH EXTRACTING** | single-consumer protocol machinery; contract tests host-side | (declined `@animastor/lac-transport`) | — |
| agent pipeline (services/agent/) + agent-session + txt-importer + window-generator | ingest/agent orchestration | **HOST-BOUND** | is the host executor of the AI contour (PG sessions, cancellation, dispatch, prompt content) | — | — |
| parallel-analysis-orchestrator | ingest/agent | **NOT WORTH EXTRACTING** | would drag p-limit into zero-dep ai-agent package; host-only strategy | — | — |
| worker domain core (worker-auth + middleware + worker-routes) | worker | **HOST-BOUND** | Redis key grammar contractually shared with GPU Hub; ~500 LOC, 4 host consumers | — | — |
| storage/postgres (schema + 16 repos) | storage | **HOST-BOUND** | host doctrine; repos belong to consumer domains (identity repos already behind @animastor/auth ports) | — | — |
| O-2..O-10 storage adapters | storage | **HOST-BOUND (by design)** | they ARE the port implementations | — | — |
| storage/index.js barrel | storage | **HOST-BOUND** + seam cleanup | dissolve (1 consumer) to remove synthetic cycle | — | LOW (cleanup) |
| routes (HTTP contour) + middleware | HTTP | **HOST-BOUND** | no remaining domain packages to ride with | — | — |
| runtime loop / gpu-dispatcher / seams / config / helpers / metrics / event-journal | composition | **HOST-BOUND (deliberate)** | port-wiring + transport + policy by design | — | — |
| book-diff host half (Redis dirty-marking) | book-state | **HOST-BOUND** | Redis chunk grammar + FSM execution | — | — |
| book-sync, book-event-log, book-source, book-deletion, entity-cleanup | book-state | **HOST-BOUND** | SQL/Redis/FS composition legs | — | — |
| book/, editor/, contracts/, job-schema, language-detector, state/scene-state, utils shims, auth/ shim | shims | **HOST-BOUND (shims)** | consumer migration + deletion bookkeeping | — | LOW (hygiene) |

---

## 7. Final decomposition map

```
                    ┌──────────────────────────────────────────────┐
                    │                BACKEND HOST                  │
                    │  backend.cjs (composition root, port wiring) │
                    │  routes/ (HTTP contour) · middleware/        │
                    │  config/ · runtime/ · helpers/ · metrics/    │
                    │  storage/ (schema, repos, O-2..O-10 adapters)│
                    │  services/ agent pipeline · AI-provider plane│
                    │            media executors · book-state legs │
                    │            worker-auth · book-deletion       │
                    │  audio/ image/ video/ workflows/ (executors) │
                    └──────────────────────────────────────────────┘
                         │ ports already bound at composition root
      ┌──────────────────┼──────────────────────────────────────────┐
      ▼                  ▼                                          ▼
 ALREADY EXTRACTED   NEW: ADOPTIONS (no new packages)          READY WITH SEAM WORK
 (@animastor/*)      → @animastor/generation                   → @animastor/url-safety
  contracts            (dirty-grammar: PDR,                      (dns/fetch ports first;
  vbook-runtime         dependency-graph, scene-hash,             then physical move)
  parser                speech-estimation, cyr-latin-map,
  player                prompt-builder, video-workflow
  editor                builders, audio pure core —
  generation            phased, LOW→MEDIUM)
  orchestration      → @animastor/parser
  ai-agent             (source-coverage, encoding-detect;
  ai-analysis          delete stale services/ai-agent
  assistant            task copies)
  auth
  gpu-hub
  installer
  worker / connectors / web-*

 HOST-BOUND FOREVER (by doctrine, not by omission):
   postgres schema + repositories · O-port adapters · runtime loop / gpu-dispatcher /
   seams · config doctrine · Redis grammars (helpers, book-diff legs, gen-scope,
   event-journal) · HTTP routes · middleware shells · agent pipeline executor ·
   AI-provider plane (until SCC break + contract-first gateway) · worker-auth
   (hub key-grammar contract) · media executor legs (iu-processor, video-merge,
   FSM orchestrators, placeholder-audio, waveform) · book-deletion cascade
```

**Answer to the reconnaissance question:** yes, but little and small. After installer and auth, nothing of *domain* scale remains to extract. What remains extractable is (a) ~1,300 LOC of pure grammar/analysis code whose correct destination is adoption into `generation` and `parser`, (b) one 280-LOC security module (`url-safety`) that deserves its own frozen contract behind DNS/fetch ports, and (c) dead-code deletion of the stale ai-agent task copies. Everything else is either the host's port-adapter layer by design, the HTTP/agent/AI-provider execution plane blocked by the last remaining SCC, or shared-infrastructure doctrine that would gain no boundary by moving.
