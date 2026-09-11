# Generation Module Extraction — Architectural Reconnaissance

**Status:** READ-ONLY reconnaissance (reconnaissance / audit only). No production code changed, no files moved, no `packages/animastor-generation` created, no runtime behavior touched. — **Update (S-1, same date):** the seam step S-1 (§19.1) has since LANDED as a behavior-neutral follow-up commit ("arch(generation): isolate vbook session control from generation routes"): VBook session SQL was removed from the Generation route layer behind the `AgentSessionControl` port (`backend/src/services/agent-session-control.js`); guards added (`backend/tests/architecture/generation-vbook-boundary.test.js`, S1-A..S1-E). HTTP surface untouched. Details: §12 update, §13 update, §19 S-1 status, §22 checklist. — **Update (S-2):** the seam step S-2 (§19.2) has since LANDED as a behavior-neutral follow-up commit ("arch(generation): registry media capabilities"): media registry created (`generation/media-registry.js`); audio/image/video registered via `generation/default-registrations.js`; dispatch branching in scene-orchestrator uses EXECUTORS map; route validation derives from registry; guards S2-A..S2-F added (`tests/architecture/generation-media-registry.test.js`). §22 checklist updated, §22.1–§22.8 added. — **Update (S-3):** the seam step S-3 (§19.3, §24) has since LANDED as a behavior-neutral follow-up commit ("arch(generation): close provider transport seam"): all 5 direct `gpu.send`/`sendUnified` dispatch sites routed through the single provider seam `generation/comfyui-provider.generate` (payload/timeout/error/retry semantics preserved 1:1); `image/connector-utils.js` folded into the provider (deleted; barrel shims keep the public surface); hardcoded ComfyUI node-id fallbacks deleted (dead — connectors mandatory at startup) and the live merged-dialogue node patching isolated behind `provider.assembleMergedDialogueWorkflow`; the last direct workflow-connector import left the media pipeline (video-workflows → provider bindings); gpu-dispatcher require set frozen at 4 files (S3-F); guards S3-A..S3-H added (`tests/architecture/s3-provider-seam.test.js`) plus 15 provider regression tests (`tests/generation-provider-seam.test.js`). Job Protocol, Redis FSM, HTTP API, GPU Hub/Worker untouched. §24 documents the full S-3 result. — **Update (S-4):** the seam step S-4 (§19.4, §25) has since LANDED as a behavior-neutral follow-up commit ("arch(generation): move shared core infrastructure"): confirmed Generation Core shared components physically moved into the intermediate `backend/src/generation/` area (assembly-profile + character-utils → `generation/prompt-profiles/`, task registry `services/generation-progress` → `generation/`, asset FSM `state/scene-state` → `generation/`, pure prompt-text helpers extracted from `image/helpers.js`); NEW canonical artifact grammar owner `generation/artifact-naming.js` (all ~30 inline filename-grammar sites converted, bytes unchanged); `estimateSpeechDurationSec` → `utils/speech-estimation.js` (Book/authoring shared util); `audio→image` and `video→image` cross-media import edges are GONE; guards S4-A..S4-H added (`backend/tests/architecture/s4-shared-infra-moves.test.js`). No npm package created, no Redis keys/FSM/HTTP/Job Protocol changes. §25 documents the full S-4 result. — **Update (S-2 Completion Pass):** full hardcoded-media sweep completed (§22.9): core capability knowledge centralized through the registry across runtime/orchestration/metrics/storage/services; duplicate canonical configuration eliminated (registry reads runtime-config; stale prometheus/runtime-metrics quota/TTL drift removed); registry self-bootstraps; error semantics frozen by new guards S2-G..S2-J; the 5 `completeStage` facade tests broken by the original S-2 commit fixed (backward-compat handler resolution). — **Update (S-5):** the seam step S-5 (§19.5, §27) has since LANDED as a behavior-neutral follow-up commit ("arch(generation): reduce runtime orchestration cycle"): all 7 frozen R5 runtime→orchestration edges eliminated — composition-root function seams (`backend/src/runtime/orchestration-seams.js`, six ops wired in backend.cjs); event journal moved to `state/event-journal.js` (orchestration shim kept); the five pure FSM writers moved verbatim to `state/scene-state-ops.js` (facade re-exports, byte-identical keys/FSM/log bytes); services bridge (placeholder-audio, scene-restoration) re-pointed to the state-layer owner — **the 14-module orchestration⇄runtime⇄services⇄image SCC is DISSOLVED** (only the two pre-existing 2-module pairs remain); guards S5-A..S5-G added (`tests/architecture/s5-runtime-orchestration-cycle.test.js`) plus updated R5/Phase-5-T2/T10/Phase-7-P7-T7 baselines. No S-6 ports, no packages, no Redis/FSM/HTTP/Job-Protocol changes. Full-suite regression: 2429 passing / 13 failing — failure set byte-identical to the untouched baseline. §27 documents the full S-5 result; verdict READY. — **Update (S-6):** the seam step S-6 (§19.6, §28) has since LANDED as a behavior-neutral follow-up commit ("arch(generation): introduce host ports"): four Generation-owned port modules introduced (`generation/ports/{dispatch-transport,generation-config,profile-store,book-data}.js`); host config adapter added (`config/generation-config-adapter.js`); five consumers migrated (`comfyui-provider.js`, `default-registrations.js`, `assembly-profile.js`, `workflows/video/video-workflows.js`); composition root wiring added at top of `backend.cjs`; test bindings mirror production wiring; 14 new architecture guards added (`tests/architecture/s6-generation-host-ports.test.js`); 6 pre-existing guard baselines updated (S3-F, S3-H, S4-D, S2-G, R4, P7-T8); R4 frozen violation killed (workflows→book edges eliminated via BookDataPort). Phase 9C facade convention preserved (contracts import through job-schema facade). Full architecture suite: 802 passing, 0 failing. §28 documents the full S-6 result; verdict READY. — **Update (S-7):** the physical extraction step S-7 (§19.7) has since LANDED as a behavior-neutral commit ("arch(generation): physically extract generation package"): the prepared Generation Core (all 13 `backend/src/generation/**` files — registry, registrations, task domain, FSM, artifact grammar, provider seam, prompt profiles, four ports) moved to the npm package `@animastor/generation` (`packages/animastor-generation`); `backend/src/generation` deleted with ZERO compatibility shims (all consumers re-pointed to the public API root); Job Protocol now imported from `@animastor/contracts` directly; the dead config-adapter fallback removed; 13 new guards (G7-A..G7-M) + re-pointed S2..S6 suites → 830 arch tests green; full-suite failure set byte-identical to a pristine worktree baseline. §29 documents the full S-7 result; §29.12/13 record the runtime-tier blockers + S-8 plan.
**Date:** 2026-09-09
**Baseline:** HEAD `2172fac5` ("arch(ai): physically extract analysis from backend")
**Method:** static require-graph tracing over `backend/src/**`, route registration audit (`backend.cjs`), Redis key-family audit (`tests/architecture/redis-registry.js`), PG repository/table audit, frontend store/page tracing (`frontends/app/src`), cross-checked against existing architecture docs (`PHASE_NEXT_MODULE_EXTRACTION_RECONNAISSANCE.md`, `MODULAR_PRODUCT_ARCHITECTURE.md` §C8/C9/C12, `PHASE_5_ORCHESTRATION_RUNTIME.md`, `COMFYUI_WORKFLOW_CONNECTOR_RECONNAISSANCE.md`). Where documentation and code disagree, **the code wins** and the discrepancy is flagged.

---

## 1. Executive Summary

Generation in Animastor is **not a module — it is a vertically-integrated runtime** spanning HTTP routes, a Redis FSM, a dispatch engine with leases/quotas/circuit breaker, a scheduler loop, three media-type executors (audio/image/video), two per-scene merge orchestrators, PG persistence, SSE progress, and a ComfyUI/GPU-Hub transport. The code lives in 8 backend directories (`audio/`, `image/`, `video/`, `workflows/`, `generation/`, `runtime/`, `orchestration/`, `state/`) plus ~10 services, and forms a **documented ~14-module SCC** (orchestration ⇄ runtime ⇄ services ⇄ image) whose cycle edge set is *frozen by guard test* (`tests/architecture/dependency-guardrails.test.js` R5 baseline of 7 runtime→orchestration edges).

Key measured findings:

1. **The wire boundary is already contract-owned** (Job Protocol v2 via `@animastor/contracts`; GPU Hub and Worker are physically extracted packages), but the *in-process* seam between media executors and dispatch is still bypassed: 5 direct `gpu.send(...)` call sites (`audio/generation.js:351,550`, `image/iu-processor.js:278`, `video/video-service.js` via jobSpecs, `orchestration/scene-orchestrator.js:469`) instead of the documented `comfyui-provider.js` seam.
2. **Audio/image/video are NOT mutually independent today** — but their interdependencies are narrow, enumerable, and *pipeline/artifact-shaped*, not domain-shaped: `video → image` (reads IU PNG artifacts + `image/assembly-profile` + `image/character-utils` tokens), `audio → image` (`image/assembly-profile` only). Image is the pivot because the shared prompt-assembly profile resolver was physically placed in `image/` and is consumed by all three.
3. **VBook generation is a separate application workflow** (LLM scene-authoring: `services/agent/**`, `txt-importer`, `window-generator`, `agent_sessions`/`book_generation_sessions` PG tables) that *consumes* the GPU generation runtime (chunk registration, placeholder audio, active-scene registration) but does **not** call audio/image/video executors directly. The only edges are (a) shared progress pubsub, (b) `window-generator.cjs` creating chunks + registering scenes, (c) `agent/pipeline-steps.js:24` importing `image/image-service.normalizeCharacterRefs` (a pure text utility living in the wrong directory), (d) `placeholder-audio.estimateSpeechDurationSec` imported by the agent pipeline for scene sizing.
4. **The frontend Generate page is orchestration UI only** — it talks HTTP/SSE and has zero imports from player/editor store internals except one runtime-only circular import (`generateStore.ts:16` → `playbackStore.closeBook`) documented as an Android-parity coordinator, not a generation→player domain edge.
5. **The single biggest boundary violation is the route layer**: `routes/generation-routes.cjs` (585 LOC, post-Player-split) mixes generation-command routes, VBook agent-session SQL, worker counts (workspace/private-worker policy logic!), SSE, and GPU Hub callback ingestion.

**Verdict (short):** Generation is a *real domain* with a *contract-shaped future*, but it is **NOT READY** for physical package extraction today. The recommended target is a **single `@animastor/generation` package with internal media-type namespaces behind one frozen `generation contract/runtime`** (Option B — hybrid: one package, internally decomposed audio/image/video providers around a shared lifecycle/dispatch core), preceded by a mandatory **seam phase** (dispatch port, workflow-adapter port, PG/Redis ports, route split). Full verdict in §23.

---

## 2. Current Generator Frontend Contour

### 2.1 Location and composition

- **Page:** `frontends/app/src/pages/GeneratePage.tsx` (720 LOC). 1:1 port of Android `GenerateFragment` + `fragment_generate.xml`. Composition: position bar, desktop header (active-jobs summary + Generate/Stop All), and **four worker-section cards**: VBook, Audio, Image, Video (`WorkerSection` component, lines 461–529; row rendering `WorkerRow`, lines 535–594).
- **State store:** `frontends/app/src/state/generateStore.ts` (1504 LOC) — the `GenerateViewModel` equivalent. Owns: `bookId`/`buildId`, `generationStatus` (IDLE/RUNNING/ERROR/SUCCESS), `vbookProgress` (VBookStage: IDLE/ANALYZING/CREATING_SCENES/COMPLETED), layer toggles (`audioEnabled`/`imageEnabled`/`videoEnabled`/`vbookEnabled`), task-aware progress panel state (`computeProgressRows`), generation timer, SSE progress-stream subscription (`startProgressStream`, reconnect w/ backoff at :940–948), and import flow.
- **API client:** all network calls flow through `frontends/app/src/api/client.ts` (`getJson`/`postJson`/`postJsonLong`/`sse`) — enforced by guardrail R6 (`tests/architecture/dependency-guardrails.test.js` "frontend fetch() stays inside api/client.ts"). Types in `api/models.ts` (incl. `RegenerateResponse`:658, `WorkerCounts`, `ProgressPanelResponse`, `LayerConfigResponse`).
- **Android twin:** `frontends/android/.../GenerateViewModel.kt` + `GenerateFragment.kt` — the web page is declared parity ("1:1 with GenerateFragment", GeneratePage.tsx:26).

### 2.2 Generation-type switching

There is no "mode" object in the web client — `mode = 'full'` is hard-coded (GeneratePage.tsx:187) and per-layer generation is driven by:

- **Layer toggles** — `audioEnabled`/`imageEnabled`/`videoEnabled`/`vbookEnabled` signals, persisted via `PUT /book/:id/layer-config` (SettingsPage.tsx:540–587, `layer-config` is a generation-adjacent config contract, NOT VBook).
- **Scope dialog** — `ScopeDialog` (GeneratePage.tsx:660–720): `whole_book | current_chapter | current_scene | from_current_scene`.
- **Start actions** — `startGeneration({workerTypes, scope, chapterId, sceneId})` → `POST /book/:id/regenerate` (generateStore.ts:1012–1038) for audio/image/video; `startVBookGeneration()` → `POST /book/:id/bootstrap` or `/bootstrap-next-window` + poll `/agent-status` (generateStore.ts:1043–1095).

### 2.3 What is common orchestration UI vs media-type-specific

| Frontend element | Owner |
|---|---|
| Worker counts poll (5s) `GET /worker/counts` | worker/infra visibility — **mixed**: returns GPU worker counts AND `vbook` AI-agent health AND private-worker policy buckets |
| Progress panel poll (1.5s) `GET /book/:id/progress-panel` | common generation task list (task rows typed `audio|image|video|cover|vbook`) |
| SSE `/book/:id/progress-stream` | common (Redis pubsub `animastor:progress:{bookId}`) |
| `cancelGeneration` → `POST /book/:id/cancel-generation` | common |
| `cancelTask(type, taskId)` → `POST /book/:id/cancel-worker` | common command surface; `type` covers `audio|image|video|cover|vbook` |
| VBook section + `AnalysisProgressPanel` + agent-status polling | **VBook application workflow**, rendered inside the Generate page |
| `onPlaybackPrepared` → playbackStore soft refresh | generation-completion → Player consumer (event, not import) |

**Audio/Image/Video frontend code is not decomposed per media type** — the page is a single orchestrating component where each section differs only by icon/label/store toggle. That is fine: the frontend talks the *generation command surface* (regenerate/cancel/progress), not media-type internals.

### 2.4 Is VBook part of the frontend Generation domain?

No. The frontend merely *co-renders* the VBook workflow (a UI composition choice mirroring Android). `startVBookGeneration`, `checkVBookAgentStatus`, `vbookProgress` are the VBook workflow's client, sharing only the generation session chrome (timer, status, SSE channel). A future Generation frontend package would own: Generate page skeleton, worker sections for media types, progress panel, scope dialog, layer-config settings, worker counts for GPU types. VBook keeps its own section/store but subscribes to the same *progress contract*.

### 2.5 Frontend dependency directions (measured)

- `GeneratePage → generateStore → api/client` ✔ (single network seam).
- `generateStore → playbackStore` (`closeBook`, generateStore.ts:16) — **runtime-only circular import**, documented Android-parity (`MainActivity.closeBook` resets both ViewModels). Not a Generation→Player knowledge leak; should become a host-level event (port candidate P-2).
- `EditPage → POST /book/:id/... (editor routes)`; regeneration initiated from Editor flows through the same `/regenerate` contract (EditPage refreshes book JSON after AI Assistant patches — `onResourceInvalidated` listener in GeneratePage.tsx:87–94 consumes editor-side invalidation events).

---

## 3. Current Backend Generation Contour

### 3.1 Directory inventory (measured LOC)

| Directory / file | LOC | Role |
|---|---|---|
| `backend/src/runtime/` (18 modules) | 12,735 | dispatch engine (1,734), reconciliation (2,326), scheduler (662), lease-manager (600), circuit-breaker (586), scene-window (801), runtime-loop (347), gpu-dispatcher (239), worker-health (268), job-schema (31, facade→`@animastor/contracts`), runtime-result-emitter (122), counters/metrics/retention/retry-budget |
| `backend/src/orchestration/` (8 modules) | 2,272 | orchestrator.js facade (750, five-command lifecycle: markDirty/planScene/beginStage/completeStage/reconcile + failStage/resetScenes/rollback), scene-orchestrator.js (558, per-stage executors), scene-callbacks.js (499, completion handlers), event-journal.js (248), scene-restoration.js (114), runtime-result-consumer.js (54), scene-utils.js |
| `backend/src/state/` | ~600 | per-asset FSM (`scene-state.js`): `animastor:asset-state:*`, states NEW→DIRTY→PENDING→GENERATING→READY/FAILED/PLACEHOLDER, validated transition map |
| `backend/src/audio/` (11 modules) | ~1,700 | generation.js (643: segment split, dialogue/narrator workflows, chunk dispatch), ffmpeg.js, pipeline.js (merge), chunks.js, segments.js, validation.js, silence.js, connector-utils.js |
| `backend/src/image/` (9 modules) | ~2,000 | iu-processor.js (IU dispatch, in-flight markers, PG metadata), prompt-builder.js (prompt assembly), assembly-profile.js (**shared across audio+video**), registry.js, connector-utils.js, character-utils.js, preview.js, helpers.js |
| `backend/src/video/` (4 modules) | ~1,100 | video-service.js (214, group jobSpecs), video-merge.js (ffprobe/merge/mux, reads `image/assembly-profile`), video-timeline.js (ffprobe alignment, consumed by **Player** as injected port), index.js |
| `backend/src/workflows/video/` | 658 | video-workflows.js — multi-image LTX workflow builder; **frozen violation**: requires `../../book` + `../../book/lazy-book/appearance` (pinned by dependency-guardrails R4) |
| `backend/src/generation/` | 95 | **comfyui-provider.js** — the Phase-3 provider seam (loadWorkflow/getConnector/generate/buildJobId); the only file in the dir |
| `backend/src/services/` (generation-relevant) | ~4,500 | audio-orchestrator.js (488, Redis FSM per scene), video-orchestrator.js (523, group FSM), generation-progress.js (234, task registry `animastor:generation-progress:*`), task-handler.cjs (274, GPU result ingestion→artifact routing), scene-window dep, layer-config.js, gen-scope.js, placeholder-audio.js (~570, silent MP3 + `estimateSpeechDurationSec`), progress-pubsub.cjs (34), book-diff.cjs, prompt-dependency-registry.js (523), workflow-manager.js (557), profile-override.js, cleanup-service.cjs (asset path resolution `resolveAssetPath`:125) |
| `backend/src/routes/generation-routes.cjs` | 585 | `/api/v1/generate` (legacy full-book), `/worker/status`, `/worker/counts`, SSE `/book/:id/progress-stream`, GPU Hub callbacks `/gpu/task/result|error` |
| `backend/src/routes/book/generation-routes.cjs` | 654 | `/book/:id/generate-next`, layer-config GET/PUT, `/cancel-worker`, `/cancel-generation`, `/regenerate` |
| `backend/src/routes/book/progress-panel.cjs` | ~450 | task-row aggregation (state + chunks + IU progress) |
| `backend/src/routes/book/agent-routes.cjs` | 184 | `/agent-status` (VBook agent + window session status) |
| `backend/src/routes/book/import-routes.cjs` (part) | ~500 relevant | `/bootstrap`, `/bootstrap-next-window`, `/trigger-next-window`, `/resume-bootstrap` (VBook workflow) |
| `backend/src/storage/postgres/repositories/` | — | `task-repo.js` (`generation_tasks`), `scene-assets-repo.js` (`scene_assets`, dirty units), `iu-repo.js` (`image_units`), `gen-session-repo.js` (`book_generation_sessions` — **VBook-owned**), `generation-cancel-repo.js` (`generation_cancel` tombstone) |
| `backend/src/startup-resume.js` | ~60 | resume of VBook window sessions (reads gen-session-repo + cancel tombstone) |
| `backend/src/contracts/runtime-result.js` | 119 | Runtime Result Contract (C9) — leaf, zero requires |
| `backend/src/dependency-graph.js` | ~100 | **asset-layer dependency graph** for selective regeneration (image→video cascade; derived from `prompt-dependency-registry.js`) |

### 3.2 The real execution chain (traced end-to-end)

```
POST /book/:id/regenerate                    routes/book/generation-routes.cjs:337
  ├─ redis lock, clear cancel tombstone
  ├─ bookDiff.filterDirtyScenesByScope       services/book-diff.cjs (+ PG dirty-unit fallback :453)
  ├─ orchestrator.resetScenes                orchestration/orchestrator.js (frees leases, marks per-asset DIRTY→PENDING, clears iu-in-flight)
  ├─ generationProgress.createTasks          services/generation-progress.js (Redis task registry)
  ├─ taskRepo.createTask × targets           storage/postgres/repositories/task-repo.js (`generation_tasks`)
  └─ runtime.scheduler.addSceneToActiveIndex × scenes   runtime/active-scenes-index.js

runtime-loop tick (5s)                       runtime/runtime-loop.js
  └─ per active scene: attemptDispatch       runtime/runtime-scheduler.js:530
       ├─ detectVersionStale → markVersionStaleDirty
       ├─ shouldScheduleAssets (pure plan)  runtime-scheduler.js:282 (+ layer-config, chunk-image check :342)
       └─ dispatchEngine.dispatchStage       runtime/dispatch-engine.js:692
            ├─ circuitBreaker.checkDispatchWithRecovery
            ├─ lease + quota (acquireStageLease, QUOTAS per media type)
            ├─ journal STARTED               orchestration/event-journal.js
            └─ orchestrator.dispatchStage    orchestration/scene-orchestrator.js:490  ← cycle edge (frozen R5)
                 ├─ executeAudioDispatch :74  → audio-orch FSM (setGenerating→setWaitingChunks)
                 │    └─ audio.generateSceneAudio  audio/generation.js:223
                 │         ├─ segments.buildSegments / chunks cache-hit scan
                 │         ├─ wfLoader.getWorkflow(tts-qwen-narrator|dialogue)   ← ComfyUI workflow JSON
                 │         ├─ connector cl.setValue(dialogueScript/voices/…)    ← connector entity keys
                 │         └─ gpu.send(jobId, wf, 'audio', …)  ← BYPASS of comfyui-provider :351,550
                 ├─ executeImageDispatch :223 → PG dirty units → image.generateSceneIUImages
                 │    └─ iu-processor.processSingleIU  image/iu-processor.js
                 │         ├─ promptBuilder.buildImagePrompt (assembly profile)
                 │         ├─ iu-in-flight marker (dispatch-engine.registerInFlightMarker)
                 │         ├─ iu.upsertImageUnit (PG `image_units`)
                 │         └─ gpu.send(jobId iu_image, wf, 'image', …) ← BYPASS :278
                 └─ executeVideoDispatch :300 → video.generateVideoAnimation
                      ├─ wfBuilder.buildVideoWorkflows  workflows/video/video-workflows.js (LTX groups)
                      │    (reads IU PNGs from disk as base64 → pipeline dependency video→image artifacts)
                      ├─ videoOrch.initState (groups map)
                      └─ gpu-dispatcher.sendUnified per group  ← (via video-service jobSpecs)

GPU Hub → POST /gpu/task/result              routes/generation-routes.cjs:412
  ├─ jobSchema.parseJobId (contracts C4) + workspace re-verify (PW-2)
  ├─ dispatchEngine.verifyDispatchIdentity  (stale-dispatch accept for audio/video in WAITING_CHUNKS/MERGING)
  ├─ redis dedup NX
  └─ taskHandler.handleTaskResult            services/task-handler.cjs:20
       ├─ cleanupService.resolveAssetPath → fs write artifact (naming grammar: book_ch_scene(_iu|_gN).ext)
       ├─ iu_image → IU progress counter + SSE publish + maybe orchestrator.completeStage('image')
       ├─ audio_chunk → chunk metadata + audioOrch.completeChunk → merge → completeStage('audio')
       └─ scene_video → videoOrch.completeGroup → merge groups → completeStage('video')

orchestrator.completeStage                   orchestration/orchestrator.js:72
  ├─ verifyDispatchIdentity → stage handler (scene-callbacks: validation, artifact check, PG markReady)
  └─ dispatchEngine.markDispatchCompleted (lease release, quota, circuit breaker record, C9 result emit)

progress: publishProgress (Redis `animastor:progress:{book}`) → SSE /progress-stream → frontend
reconcile: runtime-loop every 60s → reconciliation-engine.reconcileCycle (orphan GENERATING repair, chunk recovery, placeholder repair, counter reconciliation, session resume C5)
cancel: /cancel-worker (per-task/targeted) & /cancel-generation (book-wide: cancel flag, tombstone, leases, hub queue clear via HTTP `DELETE {HUB_URL}/queue/clear`, agent_sessions SQL)
```

### 3.3 The orchestration ⇄ runtime cycle (frozen debt)

`dependency-guardrails.test.js` pins **7 runtime→orchestration edges** (R5 baseline): dispatch-engine → orchestrator + `../orchestration` + event-journal; reconciliation-engine → orchestrator + event-journal; scene-window → orchestrator; runtime-scheduler → orchestrator. And orchestration → runtime edges: scene-orchestrator requires `runtime-scheduler`, `gpu-dispatcher`, `job-schema` (top) plus `dispatch-engine` (lazy); orchestrator.js lazy-requires dispatch-engine/state. This SCC is the single largest structural blocker for extraction — documented as "documented debt" with Phase 5's Runtime Result Contract (C9) as the direction to break it (only *observes* finalizations today; semantic reactions still flow through task-handler→completeStage/failStage).

### 3.4 Redis keyspace owned by the generation contour

Measured from `tests/architecture/redis-registry.js` (backend-owned families): `animastor:asset-state:*`, `animastor:dispatch-lease/meta/completed:*`, `animastor:iu-in-flight(-index)`, `animastor:iu-registry/progress`, `animastor:result(-processed)`, `animastor:scene-heartbeat`, `animastor:layer-config`, `animastor:gen-scope`, `animastor:generation-progress`, `animastor:audio-orch:*`, `animastor:video-orch:*`, `animastor:audio-scene-lock`, `animastor:active-scenes`, `animastor:chunk(s)`, `animastor:circuit:*`, `animastor:lease-heartbeat`, `animastor:force-dispatch`, `animastor:generation:cancel`, `animastor:progress:{book}`. Hub-owned: `animastor:queue/processing/...` (contractual coupling, not code coupling).

### 3.5 PG tables owned/used by generation

- `generation_tasks` (task-repo; claims/status via PW-2)
- `scene_assets` (per-asset status, versions, dirty_unit_ids)
- `image_units` (IU metadata/durations — written by image stage, read by video + player)
- `generation_cancel` (cancellation tombstone)
- **VBook-owned, read adjacent:** `agent_sessions`, `book_generation_sessions`, `agent_steps` (SQL appears inside `routes/generation-routes.cjs:294`, `routes/book/generation-routes.cjs:149,300`, `routes/book/agent-routes.cjs` — raw `storage.postgres.query` calls, not repos). — **✅ S-1 UPDATE:** the generation-route sites above are GONE (moved behind `services/agent-session-control.js`); the remaining raw-SQL route sites are VBook-owned routes only (`book/agent-routes.cjs`, `book/import-routes.cjs`, `book/cache-routes.cjs` — correct ownership, repo-ization optional later).

---

## 4. Audio Contour

**Routes feeding it:** `/regenerate` (worker_types=['audio']), `/cancel-worker`, `/cancel-generation`, cover-cancellation (audio+image stages, generation-routes.cjs:167–171).

**Executor chain:** `scene-orchestrator.executeAudioDispatch` → `audioOrch` FSM (`services/audio-orchestrator.js`: NEW→PLACEHOLDER_READY→GENERATING→WAITING_CHUNKS→MERGING→DONE/FAILED, Redis key `animastor:audio-orch:*`) → `audio/generation.js.generateSceneAudio` → segments (`segments.buildSegments`, pure) → workflow JSON via `wfLoader` (`tts-qwen-narrator` / `tts-qwen-dialogue`) + connector `cl.setValue` (entity keys `dialogueScript`, `narrationText`, `character1Voice`, …) → `gpu.send` per chunk (jobId `..._000N` kind `audio_chunk`; pure-dialogue scenes collapse to one merged workflow).

**Result path:** task-handler `audio_chunk` → chunk metadata update → `audioOrch.completeChunk` → `audio.mergeSceneAudioChunks` (ffmpeg) → `completeStage('audio')` → `scene-callbacks.handleAudioCompleted` (music-metadata validation, duration, PG markReady).

**Outward dependencies (measured requires from `src/audio/**`):**
- `runtime/gpu-dispatcher`, `runtime/job-schema` (transport — legit seam candidate)
- **`image/assembly-profile`** (`audio/generation.js:10` `resolveAssembly('audio')`) — shared prompt/profile resolver physically located in image/. Nature: **shared infrastructure misplaced**, not audio→image domain knowledge. The audio defaults (`defaultInstruct`) come from `ai/profiles/audio/*.json` via the same resolver.
- `services/profile-override`, `services/ai-loader` (transitively) — config/prompt infra.
- `storage/postgres/repositories/scene-assets-repo` (placeholder-status check), `state` (asset states) — lifecycle, fine.
- External npm: `music-metadata` (duration probing in callbacks; audio itself uses ffmpeg via child process).

**Artifacts:** `{book}_{ch}_{scene}.mp3` (merged), `{book}_{ch}_{scene}_{000N}.mp3` (chunks), placeholder silence MP3s. Naming grammar mirrored byte-identically in `@animastor/player/src/artifact-naming.cjs` (guarded pin).

**Queue/state/progress/cancel:** dispatch-lease + quota `maxActiveAudio`; lease TTL from `runtime-config`; progress via iu-progress-style counters only indirectly (audio progress comes from chunk counts in progress-panel); cancellation via lease clear + hub queue clear + task rows.

**Tests:** `audio-orchestrator.test.js`, `audio-profile.test.js`, `audio-segments.test.js`, plus integration coverage in `happy-path`, `generation-routes.test.js`, `cancellation-recovery.integration.test.js`, `stage-dispatch-lifecycle.test.js`, `fail-stage.test.js`.

**Configuration:** `runtime-config` (LEASE_TTL_S.AUDIO, MAX_ACTIVE_AUDIO, GPU timeouts), layer-config (`audio_enabled`, `audio_timeout_minutes`), profile-override + `ai/profiles/audio/qwen-tts.json`.

**Independence assessment:** audio is *nearly* self-contained. Its only non-transport cross-media edge is `image/assembly-profile` (movable) and the shared `gpu`/`jobSchema` seams. Audio does not read image or video artifacts.

---

## 5. Image Contour

**Executor chain:** `executeImageDispatch` → PG `getDirtyUnitIds` → `image.generateSceneIUImages` → per unit `processSingleIU` (`image/iu-processor.js`): prompt assembly (`prompt-builder.buildImagePrompt` via `assembly-profile`), stale-PNG cleanup for dirty units, IU metadata upsert (`iu-repo`), in-flight marker registration in dispatch-engine, `gpu.send` (kind `iu_image`, jobId `{book}_{ch}_{scene}_{unitId}_iu`... actually `..._iu{N}` grammar via jobSchema).

**Result path:** task-handler `iu_image` → iu-registry + progress counter + SSE increment → all-IU-complete check (PG `image_units` count vs disk PNGs) → `completeStage('image')` → `handleImageCompleted` (canonical scene image resolution, preview creation, PG markReady).

**Outward dependencies (from `src/image/**`):**
- `runtime/dispatch-engine` (lazy, in-flight marker CAS), `runtime/gpu-dispatcher`, `runtime/job-schema`, `runtime/runtime-metrics` — dispatch/lifecycle (legit).
- `storage/postgres` (iu repo, scene-assets, 3 raw `database.query` sites in iu-processor) — persistence (port candidate).
- `animastor-comfyui-workflow-connector` (workflow/connector loaders) — workflow adapter seam.
- `utils/cyr-latin-map`, `utils/string-utils` — pure utils.
- `services/profile-override`, `services/ai-loader` — profile infra.
- **Consumers crossing in:** `workflows/video/video-workflows.js` imports `image/assembly-profile`, `image/character-utils`, `image/helpers`; `audio/generation.js` imports `image/assembly-profile`; `services/agent/pipeline-steps.js:24` imports `image/image-service.normalizeCharacterRefs`.

**Artifacts:** `{book}_{ch}_{scene}_iu{N}.png`, preview `..._pr{N}.png`, canonical scene image. Also feeds **video** (base64 payloads into LTX workflows) and **Player** (read).

**Tests:** `image-ghost-no-jobs-sent.test.js`, `image-orphan-generating-repair.test.js`, `iu-progress-utils.test.js`, `assembly-profile.test.js`, `coreference-image.test.js`, scene-asset-registry tests.

**Independence assessment:** image is the *most* coupled media module — but only as a **provider of shared prompt/profile utilities and artifacts**, not as a caller of audio/video. All inbound edges are (a) `assembly-profile` (infra, should move to a shared prompt domain or the generation core), (b) artifacts (pipeline), (c) `normalizeCharacterRefs` (pure text util in the wrong directory — should live in a utils/prompt layer).

---

## 6. Video Contour

**Executor chain:** `executeVideoDispatch` → `video.generateVideoAnimation` (`video/video-service.js`): `wfBuilder.buildVideoWorkflows` (`workflows/video/video-workflows.js`, 658 LOC — multi-image LTX, group splitting `_g1.._gN`) → reads per-group IU PNGs **from disk as base64** (pipeline dependency on image artifacts, video-service.js:78–95) → `videoOrch.initState(groups)` → `gpu.sendUnified` per group (kind `scene_video`, jobId `{...}_gN`).

**Result path:** task-handler `scene_video` → `videoOrch.completeGroup` (per-group file validation ≥10KB, source bitrate cap) → all groups present → `video-merge.mergeSceneVideoGroups` (player-facing merged `scene.mp4`; group files kept for dirty re-gen) → `completeStage('video')` → `handleVideoCompleted` (ffprobe/merge validation, PG markReady).

**Outward dependencies:**
- `workflows/video/video-workflows.js` → **`../../book` + `../../book/lazy-book/appearance`** — the FROZEN R4 violation (pinned baseline of exactly 2 edges, dependency-guardrails.test.js). Nature: scene/appearance data needed for storyboard tokens — an artifact/payload dependency on the Book Model, not generation logic.
- `video/video-merge.js` → `image/assembly-profile` (`resolveAssembly('video')`).
- `video-timeline.js` → `workflows/video/video-workflows.toValidLTXFrames` (and is itself consumed by the **Player** as an injected port `computeVideoStartMs` — backend.cjs:291; the player never imports it, guarded).
- PG: `iu-repo` (durations for group planning), `image_units` reads.
- ffmpeg (merge/mux/probe), jobSchema, gpu-dispatcher.

**Artifacts:** `{book}_{ch}_{scene}_g{N}.mp4` (groups) + `{book}_{ch}_{scene}.mp4` (player merge). Export route muxes book audio onto merged video (`export-routes.cjs:134–148`) — a **consumer** of both audio and video artifacts (read-only).

**Tests:** `video-orchestrator.test.js`, `video-workflows.test.js`, `video-timeline.test.js`, `video-tokens.test.js`, `video-action-polish/reconciliation.test.js`.

**Independence assessment:** video depends on image **as pipeline input** (PNG artifacts + IU metadata) and on the Book Model for storyboard payloads. These are *data* dependencies expressible through a semantic request (see §8), not code-level domain coupling. Video does not call image code at runtime except the misplaced `assembly-profile`/`character-utils` utilities.

**Cross-media dependency nature summary:**

| Edge | Nature | Verdict |
|---|---|---|
| video → image PNGs/IU metadata | **pipeline dependency** (artifact input) | stays; expressed via artifact contract, not module merge |
| video/audio → `image/assembly-profile` | **shared infra misplacement** | move resolver to generation core (or shared prompt-profile domain) |
| video-workflows → book (frozen) | **payload dependency** on Book Model | port as `scene-data` input (already pinned; unwraps through VBook-runtime shims) |
| audio → nothing in image/video | clean | — |
| image → nothing in audio/video | clean (only outbound consumers) | — |

Conclusion: **pipeline dependency ≠ module coupling.** audio/image/video can be independently extractable once (1) assembly-profile moves to the shared core, (2) each media type's disk artifacts are accessed via a declared artifact contract (naming grammar), (3) video's image-input goes through an `ImageArtifactSource` port instead of direct fs reads.

---

## 7. VBook Generation Contour

### 7.1 What VBook generation actually is

VBook "generation" (the VBook card on the Generate page) is the **LLM authoring workflow** that turns source text into structured scenes/units/visuals:

```
POST /book/:id/bootstrap | /bootstrap-next-window     routes/book/import-routes.cjs:646,723
  └─ txtImporter.bootstrapImportedText/bootstrapNextWindow  services/txt-importer.js:150,217
       └─ agentService.bootstrapWithAgent              services/agent/bootstrap.js
            └─ agent pipeline: structure→characters→locations→scenes→units→visuals
               services/agent/pipeline-steps.js + pipeline-runner.js (windowed, cancellable,
               parallel-analysis-orchestrator for characters/locations/voices)
                 ├─ providerGateway.agent.callAI       (LLM transport — AI domain)
                 ├─ lazyBook draft updates              (Book Model)
                 ├─ agent_sessions/agent_steps PG      (session/step bookkeeping)
                 └─ progress via publishProgress (type:'vbook' SSE events)
```

Then the **bridge into GPU generation** is `window-generator.cjs` (`runBackgroundWindowGeneration`, wired in backend.cjs:213): creates Redis chunks for each new scene (`audio_status:'placeholder'`), generates placeholder audio (`placeholderAudio.ensureAllPlaceholderAudio`), registers scenes into the active-scene index (→ the GPU scheduler picks them up), updates scene counters. `/trigger-next-window` and `/resume-bootstrap` do the same for subsequent windows. `startup-resume.js` + reconciliation C5 resume incomplete `book_generation_sessions` after restarts (tombstone-gated).

### 7.2 Answers to the six mandated questions

1. **Is VBook generation a standalone domain/application workflow?** Yes. Its state lives in `agent_sessions`/`book_generation_sessions`, its inputs are source text + LLM, its outputs are Book-Model scene structures. It is an *authoring* workflow, not media generation. The Generate-page VBook section is a UI co-location.
2. **Does it use audio/image/video generators as dependencies?** It does not call the executors (`generateSceneAudio`/`generateSceneIUImages`/`generateVideoAnimation` are never referenced from the agent pipeline). It consumes the generation **runtime indirectly**: chunk records (its own writes into `animastor:chunk:*`, a shared registry), `placeholder-audio` (silence generation via `audio.silence.generateSilentAudio`), and the active-scene index (scheduler trigger). It imports two pure helpers that physically live in media-type dirs: `image/image-service.normalizeCharacterRefs` (pipeline-steps.js:24) and `placeholder-audio.estimateSpeechDurationSec` (pipeline-steps/text-utils/unit-splitter) — both are *text heuristics*, not generation logic.
3. **Does the current implementation contain its own generation misattributed as VBook?** No. The reverse risk exists and is bounded: VBook cancel/counts logic (`agent_sessions` UPDATE SQL) leaked INTO generation routes (`routes/generation-routes.cjs` worker/counts `vbook` fields, `routes/book/generation-routes.cjs:142–166,296–307`) — i.e., **Generation currently knows VBook internals** (direction `Generation → VBook internals` at the route layer, through raw SQL). **✅ S-1 UPDATE:** this leak is closed — both routes now consume the `AgentSessionControl` port (`services/agent-session-control.js`); the only remaining `agent_sessions`/`book_generation_sessions` SQL in the route layer lives in VBook-owned routes (`book/agent-routes.cjs`, `book/import-routes.cjs`, `book/cache-routes.cjs`), which is correct ownership.
4. **What parts must stay in VBook?** bootstrap/next-window routes, agent pipeline + prompts/skills (backend/ai/skills, rules), agent_sessions/window session PG repos, window-generator's *session* bookkeeping, agent-status route, VBook SSE event semantics (`type:'vbook'`), its frontend section and poller.
5. **What parts should call Generation?** chunk/placeholder/registration legs should go through a narrow **Generation contract** (e.g. `generation.scenes.registerForGeneration({bookId, scenes, layers})` + `generation.ensurePlaceholders(scenes)`) instead of writing `animastor:chunk:*` keys and calling `activeScenes.addActiveScene` directly. Cancel should go through `generation.cancel` (which already exists) plus a *VBook-owned* session-cancel, instead of Generation routes executing `agent_sessions` SQL.
6. **Can VBook use new generation capabilities later without touching Generation core?** Yes, if the contract is capability-oriented: today's `worker_types: audio|image|video` + `layer-config` + task registry are already a capability surface; a new capability registers a new executor + task type, and VBook simply passes a new type string / subscribes to the progress contract. No Generation→VBook knowledge needed.

**Recommended dependency direction:** strictly **VBook → Generation contracts** (register scenes, request placeholder, observe progress, cancel) and **VBook owns its own workflow state**. All current `Generation → VBook internals` edges are route-layer SQL leaks enumerated in §12 and are removable without behavior change.

---

## 8. Workflow / ComfyUI Boundary

### 8.1 Current state

- The `animastor-comfyui-workflow-connector` package is extracted (zero-dep, node builtins only, guarded by `comfyui-connector-core-boundary.test.js`) and owns: workflow JSON loading + SHA-256 hashing, connector JSON (entity-key → nodeId/field mapping), compatibility validation, `createWorkflowConnector(...).build()`. Its public API explicitly promises "ComfyUI node ids … NOT part of this API".
- The backend consumes it via **module-level requires in 8 files** (measured): `image/connector-utils.js`, `image/iu-processor.js`, `audio/connector-utils.js`, `audio/generation.js`, `workflows/video/video-workflows.js`, `generation/comfyui-provider.js`, `services/workflow-manager.js`, `services/profile-override.js`, `backend.cjs` (startup configure+load, :472).
- **Seam violations (node-id leakage into generation domain):**
  - `audio/generation.js` — **hard-coded ComfyUI node ids as fallbacks** when no connector exists (verified set: `wfAudio["108"]`, `["71"]`, `["74"]`, `["80"]`, `["82"]` — 13 reference sites across the dialogue/narrator branches, lines ~488–537). This is exactly the "Animastor domain code bound to concrete ComfyUI workflow/node IDs" the architecture idea forbids — a legacy fallback path that bypasses the connector abstraction (dead in practice: connectors are mandatory at startup — backend exits without workflows, backend.cjs:472–481).
  - `image/connector-utils.js` — `getImageNodeId`/`applyImageValue` are thin re-wrappers of the package's loader (duplication of the `comfyui-provider` seam; the WORKFLOW_NAME `img-qwen-image` constant lives here AND in `comfyui-provider.WORKFLOW_NAMES.image`).
  - `video` — workflows are built directly against `wfLoader` JSON (multi-image LTX), with node mutation happening inside `video-workflows.js` rather than through connector bindings; the workflow name family `video-ltx-*` (`1p/2p/3p/4p` variants) is resolved by name in backend code.
- `generation/comfyui-provider.js` (95 LOC) is the **documented Phase-3 seam**: `loadWorkflow/getConnector/getWorkflowHash/generate (→gpu-dispatcher.sendUnified)/buildJobId`, `WORKFLOW_NAMES` registry. But per the Phase-Next audit (and re-confirmed at this HEAD), **the 5 production dispatch call sites bypass it** (`audio/generation.js:351,550`, `image/iu-processor.js:278`, `video/video-service.js` via direct `gpu.send` on jobSpecs, `scene-orchestrator.js:469` sendUnified). Its only production consumer is `services/provider-gateway.js` (`generation.comfyui`), whose own consumers are ai-routes (demo) — i.e., the seam exists but the traffic flows around it.

### 8.2 The required seam (target)

```
semantic generation request (unit prompt, voice instruction, storyboard tokens — media-agnostic)
   → media executor (audio/image/video — owns prompt assembly + workflow selection by name)
   → provider adapter port (comfyui-provider.loadWorkflow/applyBindings/generate)   ← ONLY node-id knowledge
   → dispatch transport port (gpu-dispatcher.sendUnified — Job Protocol v2)
   → GPU Hub / Worker (packages — external boundary)
```

Today the seam is broken in two places: executors patch workflow JSON directly (with node-id fallbacks), and dispatch bypasses the provider seam. **Where it must not be broken further:** none of audio/image/video may learn *new* node ids; the `108/71/74/80` literals must die; `image/connector-utils` should collapse into `comfyui-provider`; workflow *selection* (which workflow JSON + which profile) belongs to the media executor behind the adapter, per the MODULAR_PRODUCT_ARCHITECTURE §C12 plan (media provider contract — **still missing**).

---

## 9. GPU Hub / Worker Boundary

Already external packages: `packages/animastor-gpu-hub` (HTTP service; Redis queues `animastor:queue:*`, claim/lease/timeout sweep, worker auth mirror; **no code deps on backend** — guarded R2), `packages/animastor-worker` (zero-dep self-contained bundle; HTTP-to-hub only — guarded R1), `packages/animastor-contracts` (Job Protocol v2 canonical; backend consumes via `runtime/job-schema.js` facade → `@animastor/contracts`).

Generation's remaining coupling to the Hub is **contractual + transport**:
- `runtime/gpu-dispatcher.js` (239 LOC): POST `{HUB_URL}/task` with the v2 envelope; server-derived workspace routing (book→workspace→private worker / policy lane / system pool — PG reads via lazy book-repo/worker-repo/workspace-repo); per-type timeouts. This is **routing policy living in the transport** (documented PW-2 design) — for extraction it must become an injected `DispatchTransport` port with injected resolvers.
- `runtime/dispatch-engine.clearHubDispatches` (:1332): HTTP `DELETE {hubUrl}/queue/clear?dispatch_id=…` — cross-boundary *write* from backend to hub queues on cancel (injectable fetch, already parameterized).
- `routes/generation-routes.cjs /gpu/task/result|error` — the Hub→backend callback ingestion (dedup, identity verify, workspace re-verify).
- Hub residual: inline `PROTOCOL_VERSION=2` literal (noted in Phase-Next audit; hub-side issue, out of Generation scope).

No generation-domain code imports hub/worker internals (verified by R1/R2 guards + grep). The boundary to keep: **Generation → (Job Protocol envelope + HTTP transport port) → GPU Hub → Worker**, with zero Redis-sharing on job lanes (hub-owned families only).

---

## 10. Dependency Graph (measured, code-level)

### 10.1 Backend generation contour — internal edges

```
routes/generation-routes.cjs ─────┐
routes/book/generation-routes.cjs ├─→ taskHandler, dispatchEngine, generationProgress,
routes/book/progress-panel.cjs ───┘    layerConfig, genScope, sceneWindow(scheduler),
                                       taskRepo, sceneAssetsRepo, bookRepo,
                                       generationCancelRepo, progressPubsub, orchestrator
backend.cjs (composition root) ──→ everything (DI wiring: routeDeps incl. audio/image/video)

runtime-scheduler → state, dispatch-engine, generation-progress, task-repo
dispatch-engine   → state, event-journal, lease-manager, circuit-breaker, retry-budget,
                    counter-reconciliation, runtime-metrics, storage, runtime-result-emitter,
                    orchestration (lazy cycle: orchestrator.dispatchStage)   ← R5 frozen
runtime-loop      → scheduler, reconciliation-engine, metrics, dispatch-engine, prometheus
reconciliation    → orchestration (lazy), event-journal, audio-orchestrator, video-orchestrator,
                    image (lazy :136), audio (lazy :431,1874), chunks, placeholder-audio (lazy :2112)
scene-window      → book, state, orchestrator, active-scenes, audio/audio-service, gen-scope,
                    scene-assets-repo, pg, placeholder-audio, audio-orchestrator (lazy)
orchestrator.js   → scene-callbacks (→ audio/image/video + storage + repos), dispatch-engine (lazy),
                    scene-restoration (→ placeholder-audio), book-diff, scene-assets-repo, iu-repo
scene-orchestrator→ audio, image, video, gpu-dispatcher, runtime-scheduler, book, layer-config,
                    audio-orchestrator, video-orchestrator, scene-callbacks, orchestrator, scene-assets-repo
task-handler.cjs  → job-schema, dispatch-engine (lazy), audio-orchestrator, video-orchestrator
audio/**          → gpu-dispatcher, job-schema, image/assembly-profile, profile-override,
                    scene-assets-repo, state, comfyui-workflow-connector
image/**          → gpu-dispatcher, job-schema, dispatch-engine (lazy), runtime-metrics,
                    pg (iu-repo, scene-assets, raw query), comfyui-workflow-connector, utils
video/**          → gpu-dispatcher, job-schema, workflows/video (→ book, image utils), pg (iu-repo), image/assembly-profile
workflows/video   → book (FROZEN R4), image/{assembly-profile, character-utils, helpers}
state             → (leaf; writes asset-state; referenced by everything)
contracts/runtime-result.js → (leaf, zero requires; C9)
generation/comfyui-provider → comfyui-workflow-connector, gpu-dispatcher, job-schema
services/provider-gateway → gpu-dispatcher, comfyui-provider, ai-service, workspace-ai-provider
```

### 10.2 The SCC (documented, frozen)

`{runtime-scheduler, dispatch-engine, runtime-loop, reconciliation-engine, scene-window, lease-manager, circuit-breaker, counter-reconciliation, retry-budget, runtime-metrics, orchestrator, scene-orchestrator, scene-callbacks, iu-processor/image-service}` — 14-module strongly-connected core (Phase 7 §2.1, re-verified: R5 pins the runtime→orchestration half; the orchestration→runtime half is top-level/lazy requires listed above).

### 10.3 Cross-module dependency directions (mandated checks)

| Direction | Exists? | Evidence / nature | Proposed seam |
|---|---|---|---|
| VBook → Generation | **YES (indirect)** | window-generator writes chunks + placeholder-audio + active-scene registration; agent pipeline imports `estimateSpeechDurationSec`, `normalizeCharacterRefs` | generation contract: `registerScenes`, `ensurePlaceholders`; move 2 pure helpers to shared utils |
| Generation → VBook internals | **YES (route layer only)** | generation-routes.cjs:294 (`agent_sessions` count), book/generation-routes.cjs:149,300 (`agent_sessions` UPDATE) | move VBook session cancel/counts to VBook-owned module; Generation exposes `cancel hooks` / capability counters |
| Player → Generation | **NO** (clean) | player package gets artifacts via naming grammar + injected ports (`computeVideoStartMs`, waveform, book projections) | keep; artifact naming stays a frozen shared contract (already pinned byte-identity) |
| Generation → Player | **NO** (clean) | zero requires of `@animastor/player` from generation dirs (grep-verified); only frontend event `playbackPrepared` | keep guard |
| Editor → Generation | **indirect, thin** | editor contour reads placeholder-audio recovery + `dirty_unit_ids` persistence (scene-assets-repo shared), triggers regeneration through HTTP contract | scene-assets/dirty-units repo becomes a shared persistence port owned by Generation; editor consumes the repo contract, not generation internals |
| Generation → Editor | **NO** (clean) | only historical note image/helpers.js:7 (cyr-latin map moved OUT of editor to shared utils in Phase 4.1) | keep guard |
| Generation → GPU Hub | **transport only** | gpu-dispatcher HTTP POST /task; dispatch-engine DELETE /queue/clear; config HUB_URL | `DispatchTransport` port (already injectable fetch/options); no new edges allowed (R2) |
| GPU Hub → Generation | **callback contract only** | `/gpu/task/result|error` HTTP + Job Protocol v2 (+ shared Redis queue families owned by hub) | keep; protocol via @animastor/contracts |
| Generation → Worker | **none** (R1 guard) | worker bundle has zero backend refs | keep |
| Generation → Workflow Connector | **YES (8 require sites)** | §8.1 | collapse into `comfyui-provider` adapter port |
| Frontend → Generation | HTTP/SSE contract only | api/client + generateStore → /regenerate, /cancel-*, /progress-*, /worker/counts, /layer-config | freeze route surface as the public generation API |

---

## 11. Dependency Matrix

Legend: D=direct, I=indirect; R=read, W=write; seam = proposed interface; M/P/S = MOVE / PORT / STAY.

| Contour ↓ depends on → | Generation core (orch/runtime/state) | VBook (agent pipeline) | Player | Editor | GPU Hub | Worker | Workflow Connector | Redis | PG |
|---|---|---|---|---|---|---|---|---|---|
| **Generation routes** (`routes/generation-routes.cjs`, `routes/book/*`) | D-RW (dispatch, tasks, cancel, layer-config) | **D-W (SQL agent_sessions — LEAK)** :149,294,300 | none | none | D-W (HTTP callbacks in; queue-clear out) | I (via hub) | I (via services) | D-RW (tasks, progress, leases) | D-RW (tasks, tombstones, VBook SQL) |
| **Audio media module** | D-RW (gpu-dispatcher, dispatch-engine markers, state) | none | none | none | I (transport) | I (executes jobs) | D-R (workflow/connector) | D-RW (chunks, locks, orch state) | D-RW (scene-assets, iu-repo) |
| **Image media module** | D-RW (dispatch-engine, metrics, state) | none | none | none | I (transport) | I | D-R | D-RW (iu-registry/progress/in-flight) | D-RW (iu-repo, scene-assets, raw query) |
| **Video media module** | D-RW (dispatch, state) + D-R (image artifacts) | none | I (naming grammar; timeline port inverse) | none | I (transport) | I | D-R (wfLoader) + **D-R book (frozen)** | D-RW (video-orch, scene locks) | D-RW (iu-repo) |
| **VBook workflow** (agent/bootstrap/window-gen) | **I-W (chunks, placeholder, active index — via contract candidate)** + D-R (estimateSpeechDuration, normalizeCharacterRefs) | self | none | none | none | none | none | D-RW (session/chunk keys, progress) | D-RW (agent_sessions, book_generation_sessions) |
| **Player package** | none (naming contract + injected ports only) | none | self | none | none | none | none | none (per package guard) | none (ports injected) |
| **Editor package** | I-R (placeholder recovery port, scene-assets via editor-ports) | none | none | self | none | none | none | none (ports injected) | I-RW via injected sceneAssetsRepo port |
| **GPU Hub** | none (HTTP+Redis contract only — R2 guard) | none | none | none | self | D (auth/claim) | none | D-RW (queue/processing families it owns) | none (mirror in Redis) |
| **Worker** | none (R1 guard) | none | none | none | D (HTTP) | self | none | none | none |

Per-edge dispositions (the ones that matter for the future package):

1. **Generation routes → VBook SQL** — D-W, reason: cancel + worker-counts co-rendering; seam: VBook-owned `AgentSessionControl` port; disposition: **PORT** (move SQL to VBook module, Generation calls a cancel/counts interface). **✅ DONE (S-1):** implemented as `services/agent-session-control.js` (`cancelSessions`/`getActiveSessionCount`/`getSessionStatus`); `routes/generation-routes.cjs` and `routes/book/generation-routes.cjs` now consume the port only — zero VBook-session SQL left in the Generation route layer (guarded by `generation-vbook-boundary.test.js`).
2. **VBook → generation runtime keys** — I-W, reason: chunk/placeholder/registration bootstrap; seam: `GenerationContract.registerScenes/ensurePlaceholders`; disposition: **PORT**.
3. **audio/video → image/assembly-profile** — D-R, reason: shared prompt-profile resolver misplaced; seam: move resolver into generation core; disposition: **MOVE** the file, then internal.
4. **video-workflows → book** — D-R (frozen, 2 edges); reason: scene/appearance payload for storyboard; seam: inject scene/appearance data (already shims into VBook-runtime package API); disposition: **PORT** (unchanged short-term — pinned baseline).
5. **audio/generation.js node-id literals (108/71/74/80)** — no seam today; reason: legacy no-connector fallback; disposition: **DELETE** in the seam phase (connector is mandatory at startup — backend exits without workflows, backend.cjs:472–481, so the fallback path is dead in practice).
6. **Executors → gpu-dispatcher direct** (5 sites) — reason: seam exists but bypassed; disposition: **PORT** via `comfyui-provider.generate` / `providerGateway.generation.sendJob` (P7-T8 already enumerates this).

---

## 12. Hidden Dependencies (found by tracing, not names)

1. **`/api/v1/generate` (legacy full-book) is a generation *and* import *and* ownership route** — routes/generation-routes.cjs:88 mixes bundle extraction, workspace ownership attach, cancel tombstone, gen-scope, and scene-window sliding. The modern flow is `/regenerate`; this endpoint survives as the Android import leg. It belongs to Import/Book, not Generation core. **S-1 follow-up status:** endpoint left AS IS (frozen contract, Android parity constraint R-7) — the import/ownership legs of the handler are interwoven with the gen-scope/scene-window legs through shared chunk state; separating them cleanly is a route-handler move that belongs in its own PR (candidate for S-7/S-8 route-ownership pass). No behavior changed; flagged, not scheduled. Its VBook-surface exposure is zero (no session SQL) — S-1 does not require touching it.
2. **Worker counts endpoint carries private-worker sharing policy** — routes/generation-routes.cjs:250–344 (system pool ∪ own private workers, dedup semantics D3, plus **vbook agent health + `agent_sessions` count**). Three domains in one route (infra visibility, AI-agent health, VBook sessions). **S-1 follow-up status:** the VBook leg (`agent_sessions` running-count → `active_vbook`) now flows through the `AgentSessionControl.getActiveSessionCount()` port; the AI-provider health leg (`checkAIHealth` + workspace provider resolution) remains in the route — it is AI-domain, not VBook-session, knowledge and is out of S-1 scope. External HTTP response shape unchanged.
3. **Cover is a hidden 4th media target** — `cancel-worker` treats `cover` as audio+image stages (:167–171); progress rows type `cover` map to the Image section in the frontend (GeneratePage.tsx:267). The "cover" concept spans scene structure + two media types.
4. **`image_units` PG table is a cross-media timing contract** — written by image stage (durations), read by video (group planning, video-workflows.js `readIUMetadata`), read by player (timeline), read by placeholder-audio (estimates). Not owned by any single media type.
5. **Scene-window + gen-scope is a second, legacy orchestration flow** — `BOOK_SCENE_TOTAL/NEXT` counters + sliding window (routes/generation-routes.cjs /generate, book/generation-routes.cjs /generate-next) coexists with the task-registry flow (generation-progress). Two command models for the same domain (documented in gen-scope.js header).
6. **`startup-resume` + reconciliation C5 call `runBackgroundWindowGeneration`** — the *runtime* (generation core) invokes the *VBook* window generator on restart (backend.cjs:581, reconciliation-engine.js:1595). This is a **Generation → VBook** direction edge hidden inside the runtime loop's injected deps. **S-1 status:** frozen as-is — the edge is composition-root-injected (backend.cjs wires `runBackgroundWindowGeneration` into reconcileDeps), no code-level require of VBook internals was added or removed; collapse belongs to the runtime↔orchestration SCC work (S-5) per risk R-4.
7. **`placeholder-audio.estimateSpeechDurationSec` is a domain-shared text heuristic** — used by the VBook agent pipeline for scene sizing *before* any generation exists. It is "generation-flavored" (0.3s/word narration heuristic) but is really a shared Book/authoring utility.
8. **`services/cleanup-service.cjs.resolveAssetPath` owns the artifact naming grammar** for result ingestion (task-handler depends on it) while `storage/filesystem-store.js` + `@animastor/player/src/artifact-naming.cjs` mirror it — three copies of the grammar, byte-pinned.
9. **Progress-panel depends on IU progress util + asset states + chunks** — routes/book/progress-panel.cjs imports `iu-progress-utils.cjs` (shared with player contour) and generation-progress; the route is the aggregation seam between three state systems.
10. **Circuit breaker / retry-budget / lease TTLs are per-media-type configured** (`LEASE_TTL_S.{AUDIO,IMAGE,VIDEO}`, `MAX_ACTIVE_*`, `DEFAULT_TYPE_TIMEOUT_MS` in gpu-dispatcher) — media-type knowledge embedded in the *shared* dispatch core via config keys (acceptable; it is a registry pattern, not code coupling).
11. **`image` module reachability from `agent` domain** — pipeline-steps.js:24 `normalizeCharacterRefs` (pure util) + `services/agent/image-utils.js` fallback prompts (`getFallbackImage`) — the VBook authoring pipeline carries image-prompt fallback knowledge (its own, not the image executor's — fine, but should not import from `src/image/`).
12. **`music-metadata` required lazily inside scene-callbacks** (:71,106) — audio validation dependency living in orchestration; on extraction it must be a port of the audio module.

---

## 13. Cross-Module Dependencies — who must own which contract

| Contract | Today's owner | Proposed owner | Consumers |
|---|---|---|---|
| Job Protocol v2 (envelope, job_id grammar) | `@animastor/contracts` (C4) | same | Generation, GPU Hub, Worker — keep |
| Artifact naming grammar | filesystem-store + player twin + cleanup-service | **Generation package** (writer side) + frozen read-contract for Player | Player, Editor (read), export |
| Per-asset state FSM (`asset-state`) | `src/state` | **Generation core** | Editor (dirty marks write *into* it via scene-assets), Player (reads via assets-state) — reads/writes via ports |
| Layer-config (per-book generation prefs) | `services/layer-config` | **Generation core** | Frontend settings, VBook (chunk size) |
| Generation task registry / progress SSE | `services/generation-progress` + `progress-pubsub` | **Generation core** | Frontend, VBook UI section |
| Cancellation (task/worker/book + tombstone) | dispatch-engine + generation-cancel-repo + routes | **Generation core** (with hooks for VBook session cancel) | Frontend, VBook |
| Agent/VBook session control (cancel/counts/status) | ~~raw SQL in generation routes~~ → `services/agent-session-control.js` (**✅ S-1 DONE**) | **VBook module** | Generation routes call the port |
| Image/IU metadata (image_units) | iu-repo | **Generation core** (written by image; read by video/player via repo port) | video, player, export |
| Workflow/connector loading | comfyui-workflow-connector package | same package; generation consumes ONLY via comfyui-provider adapter | generation media executors |
| Dispatch transport (HUB_URL POST, routing resolvers) | `runtime/gpu-dispatcher` | **host-side port** injected into Generation (routing policy = host, envelope = contracts) | Generation |

---

## 14. Candidate Module Boundaries (Options A/B/C evaluated)

### Option A — one module `@animastor/generation` with internal audio/image/video

- Pros: matches the single SCC reality (the FSM, dispatch, leases, quotas, reconciliation are one state machine — splitting the machine across packages would require cross-package Redis FSM coordination); one Redis keyspace; one task registry; one cancel surface; cheapest extraction (single move + composition-root wiring, same pattern as Player/Editor).
- Cons: package would carry ~20k LOC and PG/Redis/host config inside if done naively; media types not independently deployable; a new media type still requires editing the package (though *inside* one place).
- Verdict on A: **directionally right, underspecified.** A naive A (move everything) would create a second monolith — explicitly rejected.

### Option B — `@animastor/generation` with a common core + media-type submodules behind internal seams

- Structure: `generation-core` (lifecycle commands, dispatch engine, lease/quota/circuit-breaker, scheduler, reconciliation, state FSM, task registry, progress, cancel, artifact naming, placeholder) + `generation-audio`, `generation-image`, `generation-video` as **internal namespaces** (sub-entry points of ONE package) exposing per-type executors + workflow selection, registered into the core via a capability registry (`STAGE_EXECUTORS` map — the seam already exists de facto as the `{audio, image, video}` handler map in orchestrator.completeStage:80–83 and `VALID_TRANSITIONS` per asset in scene-state).
- Pros: frozen public API independent of media-type count; a new media type = new internal module + registry entry + layer-config flag, no core edits; keeps the FSM atomic; extraction remains a single physical move (no cross-package cycles); aligns with the existing `comfyui-provider`/provider-gateway seam plan and future C12 provider contract.
- Cons: internal seams must be enforced by guards (otherwise it rots into A-naive); media types still share one release train (acceptable — they share the runtime anyway).
- Verdict: **recommended** (see §15).

### Option C — fully independent `@animastor/{audio,image,video}-generator` packages + shared infra

- Pros: maximal independence for providers; matches "new image generator without touching video".
- Cons (measured): (a) the three media types share the *same* per-asset FSM, scheduler, lease/quota machinery, task registry, cancel, progress and reconciliation — extracting these into a 4th "generation-runtime" package makes audio/image/video *consumers* of a runtime package while they are also its *state owners* (asset-state keys are per media type but the transition map and scheduling loop are one machine); (b) reconciliation crosses all three (reconcileCycle repairs audio + video + image states together, reconciliation-engine.js:1838–1934); (c) PG `image_units` is written by image and read by video — a cross-package table; (d) the artifact pipeline video←image crosses package boundaries; (e) 3+ release trains for what is one operational unit; (f) the frontend command surface (`/regenerate` worker_types, progress panel, layer toggles) is inherently multi-type — a new capability would require touching a *coordinator* package anyway, reintroducing the core.
- Verdict on C: **rejected for now.** The only real independence requirement (new provider/backend per media type) is satisfied by B's capability registry + provider adapter port, without splitting the runtime. C becomes viable later *if* a media type genuinely needs an independent release (e.g., a cloud video provider with its own SLA) — B's internal seams are designed to be promotable.

---

## 15. Recommended Target Architecture

**Option B.** One package `packages/animastor-generation/` with:

```
@animastor/generation
├── core/        lifecycle commands (orchestrator facade), per-asset state FSM,
│                dispatch engine (lease/quota/circuit-breaker), scheduler loop API,
│                reconciliation, task registry, progress pubsub, cancel + tombstone,
│                scene-window, placeholder-audio, artifact naming (writer side),
│                layer-config, gen-scope, assembly/profile resolver (moved from image/)
├── audio/       segments, TTS workflow selection (narrator/dialogue), merge pipeline,
│                audio-orch FSM
├── image/       IU prompt building, IU dispatch, iu-registry/progress, image completion
├── video/       LTX group workflow building, group FSM, merge/mux (player-facing merge
│                stays a *port* — see P-4)
└── providers/   comfyui adapter (today) — the ONLY place that knows workflow JSON
                 loading via animastor-comfyui-workflow-connector; future providers
                 plug here (C12)
```

with **host-injected ports** (composition root, mirroring the proven Player/Editor pattern):

- P-1 `DispatchTransport` — `sendJob(envelope)` (today's gpu-dispatcher.sendUnified, incl. routing resolvers — host keeps workspace/policy PG reads)
- P-2 `GenerationEvents` — `onGenerationComplete(bookId, scenes)` replacing the frontend runtime edge and the scene-window→slideWindow/auto-advance coupling where host-specific
- P-3 `GenerationPersistence` — PG repos (task-repo, scene-assets, iu-repo, generation-cancel) injected; package owns the *schema usage*, host owns the DB
- P-4 `MediaPostprocessing` — ffprobe/merge/timeline helpers that Player also needs (today's video-merge/video-timeline stay host-side or in a shared media-utils package, injected)
- P-5 `BookDataPort` — scene/appearance payloads (kills the frozen `workflows→book` edge)
- P-6 `AgentSessionControl` (VBook-owned, injected *into routes*, not into core) — cancel/counts; Generation core never knows `agent_sessions`
- P-7 `SsePublisher` — Redis pubsub handle (thin; Redis client itself injected like Player/Editor do)

**Why not "fewer packages"**: the criterion is direction of change. Media types change for *new generators/models/workflows*; the core changes for *lifecycle/reliability semantics*. B separates those axes inside one deployable, keeps the FSM atomic, and gives VBook/Player/Editor stable contracts instead of internals.

**Future extensibility check (mandated scenarios):**

- **New image backend (e.g., cloud API instead of ComfyUI):** add a provider adapter in `providers/` + register in image's workflow-selection; zero changes to core, VBook, Player, Editor, Worker, Hub. ✔
- **New media type (e.g., "3D"):** add `generation-3d/` namespace: stage executor + asset-state key registration (state FSM `ASSETS` array — today hard-coded `['audio','image','video']` in scene-state.js:12 — must become a registry, listed as seam work) + layer-config field + task type; routes already parameterized (`worker_types` validated set in book/generation-routes.cjs:386 — must become registry-driven); progress panel needs a new row label. VBook/Player/Editor untouched. ✔ (after registry-ization)
- **New provider (external API):** same as new image backend — provider port only; Generation domain untouched. ✔
- **New workflow backend (non-ComfyUI):** provider adapter contract is backend-agnostic (semantic request → job envelope); the workflow-connector package stays ComfyUI-only. ✔

---

## 16. Proposed Package Boundary (physical target)

**Target:** `packages/animastor-generation/` (npm name `@animastor/generation` — consistent with `@animastor/player`, `@animastor/editor`, `@animastor/vbook-runtime`). Resolution in docker via read-only mount (same as existing packages; docker-compose backend volume block already shows the pattern for contracts/vbook/player).

**MOVE** (files whose home is the Generation domain):

- `src/audio/**` (generation-facing: generation.js, pipeline.js, segments.js, chunks.js, ffmpeg.js, validation.js, silence.js, connector-utils.js, helpers.js)
- `src/image/{iu-processor,prompt-builder,registry,connector-utils,character-utils,preview,helpers,assembly-profile}.js` (assembly-profile moves *first* — it is shared by audio+video)
- `src/video/{video-service,video-merge}.js` (video-merge is generation-owned post-processing; video-timeline stays host-side — Player port)
- `src/workflows/video/**` (LTX builder; loses the book edge via P-5)
- `src/generation/comfyui-provider.js` → `providers/comfyui.js`
- `src/state/**` (asset-state FSM)
- `src/runtime/**` (dispatch-engine, lease-manager, circuit-breaker, retry-budget, runtime-scheduler, runtime-loop, reconciliation-engine, scene-window, active-scenes-index, counter-reconciliation, runtime-metrics, worker-health, gpu-dispatcher, job-schema facade, runtime-result-emitter)
- `src/orchestration/**` (orchestrator, scene-orchestrator, scene-callbacks, scene-restoration, event-journal, scene-utils; runtime-result-consumer moves to core)
- `src/contracts/runtime-result.js` (C9 leaf — moves into the package or into `@animastor/contracts`; contracts is cleaner)
- `src/dependency-graph.js` + `src/services/prompt-dependency-registry.js` (layer-cascade semantics — generation's own)
- services: `audio-orchestrator.js`, `video-orchestrator.js`, `generation-progress.js`, `task-handler.cjs`, `layer-config.js`, `gen-scope.js`, `placeholder-audio.js`, `progress-pubsub.cjs`, `book-diff.cjs` (markDirtyScenes is lifecycle; its diff *reading* of Book Model is a port), `cleanup-service.cjs` (asset-path resolution half), `profile-override.js`, `ai-loader.js` (profile file loading only)
- routes: `routes/book/generation-routes.cjs` (regenerate/cancel/generate-next/layer-config), the generation+callback+SSE parts of `routes/generation-routes.cjs`, `routes/book/progress-panel.cjs` (+ `iu-progress-utils.cjs` shared with player — duplicated or contractized), `startup-resume.js`'s tombstone logic
- PG repos: `task-repo.js`, `scene-assets-repo.js`, `iu-repo.js`, `generation-cancel-repo.js` (move; schema ownership follows the package, DB stays host)

**PORT** (stays host-side, injected):

- `gpu-dispatcher`'s routing resolvers (workspace/policy lanes — host infra), HUB_URL config, API keys
- `middleware/auth-context`, `workspace-ownership` (route guards — host)
- `music-metadata`/ffmpeg executables availability (P-4 media utils)
- `video-timeline.js` (Player-facing; host keeps, injects into both)
- `services/ai-service`/`workspace-ai-provider` (AI domain — never enters Generation; only profile *files* are read via P-profile loader)
- Redis client instance, PG pool (injected, per Player/Editor precedent)
- VBook `AgentSessionControl` (cancel/counts) — VBook module implements; generation routes consume
- Book data payloads (P-5) via `bookModel` facade — Generation must not require `@animastor/vbook-runtime` internals

**STAY** (not Generation):

- VBook agent pipeline: `services/txt-importer.js`, `services/agent*/**`, `services/agent-session.js`, `services/knowledge-base.js`, `window-generator.cjs`, `routes/book/agent-routes.cjs`, `routes/book/import-routes.cjs` (bootstrap family), `gen-session-repo.js`, `startup-resume.js` session-resume core, `services/ai-agent/**` (analysis)
- Player package, Editor package, export routes (consumer), `waveform-service`, book deletion, auth/workspace/admin/worker-setup routes, installer, metrics endpoint
- `services/workflow-manager.js` + `routes/workflow-routes.cjs` + `routes/connector-routes.cjs` (admin/workflow management UI domain — consumer of the connector package, not generation)
- `services/provider-gateway.js` chat/agent halves (AI domain); its `generation` direction becomes redundant once the package owns the provider seam — keep as a thin re-export during transition, then **DELETE**
- `services/scene-asset-registry.js`, `services/waveform-service.js` (player/infra)

**DELETE** (after migration):

- Node-id fallback literals in `audio/generation.js` (:509,527,537 `wfAudio["108"|"71"|"74"|"80"]`)
- `image/connector-utils.js` duplication of provider seam (fold into providers/comfyui)
- Legacy `/api/v1/generate` endpoint after Android parity migration to import+regenerate (separate decision; flagged, not scheduled)
- `provider-gateway.generation` facade leg (post-migration)
- Duplicate naming-grammar copies in cleanup-service (single writer-side grammar in package; reader twin stays in Player, pinned)
- The 7-entry R5 baseline freeze itself (the cycle pins are the *debt marker*; successful extraction replaces the freeze with package-internal edges)

---

## 17. Proposed Public API (of the future package — consequence of the audit, not invention)

Every entry below is backed by an existing call site (route/OS-level contract already consumed):

```js
// Composition (host):
createGeneration({ redis, pg, config, ports })  // ports: dispatchTransport, bookData,
                                                 // mediaUtils, events, agentSessionControl?
// Route registration (mirrors createPlayerRoutes/createEditorRoutes):
createGenerationRoutes(app, { generation, deps })

// Command surface (today's /regenerate|/cancel-* semantics, callable in-process):
generation.request({ bookId, buildId, scope, layerTypes, chapterId?, sceneId? })
  → { tasks: [{ taskId, type, targets }], dirtyScenes }        // = resetScenes+createTasks+register
generation.cancel({ bookId, type?, taskId?, scope })            // = cancel-worker / cancel-generation
generation.cancelAll({ bookId })

// Scene ingestion (today's window-generator legs):
generation.registerScenes({ bookId, buildId, scenes, layers })  // chunk records + placeholder + active index
generation.ensurePlaceholders({ bookId, buildId, scenes })

// Capability registry (future media types/providers):
generation.capabilities.list() → [{ type: 'audio'|'image'|'video'|..., provider }]
generation.capabilities.register({ type, executor, providerAdapter })   // internal seam, host-exposed only for tooling

// Lifecycle/status (today's progress-panel, agent-independent):
generation.progress({ bookId }) → task rows / assets state
generation.events(bookId) → SSE channel contract (subscribe handle)   // progress pubsub

// Cancellation durability (tombstone):
generation.markCancelled({ bookId, reason }) / generation.clearCancel(bookId)

// Workflow/provider seam (used by media namespaces only — NOT exported to VBook/Player/Editor):
providerAdapter.loadWorkflow(name) / applyBindings / generate(jobRequest)
```

Explicitly **not** exported: dispatch-engine internals, lease keys, asset-state key grammar, reconciliation internals, workflow JSON mutation helpers, `normalizeCharacterRefs` (goes to shared utils), `estimateSpeechDurationSec` (goes to Book/authoring utils), VBook session state.

---

## 18. Proposed Architecture Guards (mirroring Player/Editor audits)

1. **G-1 Generation route surface freeze** — a test pinning the exact HTTP route list owned by generation (regenerate, cancel-worker, cancel-generation, generate-next, layer-config, progress-panel, progress-stream, worker/status|counts(generation fields), /gpu/task/*) — new routes require ADR (analogue: player-route-split.test.js).
2. **G-2 require/import isolation** — package requires allowlist: node builtins + `@animastor/contracts` + `animastor-comfyui-workflow-connector` (providers/ only) + zero host paths (analogue: editor-package-boundary.test.js PB series).
3. **G-3 no Generation → Player** and **G-4 no Generation → Editor** — package-level import bans (grep-based, like existing package-boundary suites). Today: clean; keep it clean.
4. **G-5 no Generation → VBook internals** — ban `agent_sessions|book_generation_sessions|@animastor/vbook-runtime` requires inside the package; VBook legs go through the AgentSessionControl port.
5. **G-6 no Generation → GPU Hub implementation** — no requires of `packages/animastor-gpu-hub`; HUB interaction only via injected transport port (extends existing R2 hub-side guard with a backend-side mirror).
6. **G-7 no Generation → ComfyUI internals** — only `providers/*` may require the connector package; a grep guard pins the require sites to the providers directory; node-id numeric literals (`["\d+"]` pattern on workflow objects) banned package-wide.
7. **G-8 public API freeze** — deep-equal pin of the package entry exports (API surface snapshot test).
8. **G-9 port shape freeze** — ports (dispatchTransport, bookData, mediaUtils, events) validated by contract tests; fail-closed assertions like `assertHostPorts` (ai-agent precedent).
9. **G-10 reverse dependency protection** — VBook/Player/Editor packages must not require generation internals (they consume routes/contracts); one guard per extracted package listing allowed `@animastor/generation` surface (entrypoint only).
10. **G-11 no legacy duplicate implementation** — after migration: exactly one asset-naming grammar writer, one dispatch transport, one task registry; the moved host files must become one-line shims (book-shim precedent, R4 test).
11. **G-12 package closure** — package test suite runnable standalone (`npm test` in package dir; graduation checklist §26.5).
12. **G-13 no config/Redis/PG leakage** — no `process.env`/config reads except injected config object; no `ioredis`/`pg` requires inside the package (clients injected) — mirrors sql-boundary + editor-ports discipline.
13. **G-14 media-type registry integrity** — `ASSETS`/`WORKER_TYPES`/stage sets derived from one registry module (kills the 4 hard-coded arrays found in scene-state.js:12, generation-progress.js:19, book/generation-routes.cjs:386, gpu-dispatcher DEFAULT_TYPE_TIMEOUT_MS).

---

## 19. Extraction Sequence (proposed; each step behavior-neutral)

1. **S-1 Route split (no package yet):** move VBook session SQL out of generation routes into an `agent-session-control` host module; split `/api/v1/generate` (import leg) from generation routes; extract `worker/counts` VBook fields behind the same module. Pure moves; guards updated. — **✅ DONE (route-SQL half):** `AgentSessionControl` port landed (`services/agent-session-control.js`); `routes/generation-routes.cjs` (`/worker/counts` `active_vbook` leg) and `routes/book/generation-routes.cjs` (`cancel-worker`/`cancel-generation` VBook session-cancel legs) consume the port; `routes/book/generation-routes.cjs` removed from the sql-boundary direct-handle whitelist; new guard suite `tests/architecture/generation-vbook-boundary.test.js` (S1-A..S1-E) pins the boundary. **Remaining (deferred, separate PR):** the `/api/v1/generate` import-leg split — handler stays physically in generation-routes.cjs with its external contract frozen (Android parity R-7); its separation is a route-ownership move requiring its own regression pass.
2. **S-2 Registry-ization:** one media-type registry module (assets, stages, worker types, quotas/TTLs); replace 4 hard-coded arrays. — **✅ DONE:** `generation/media-registry.js` + `generation/default-registrations.js` landed; dispatch branching in `scene-orchestrator.js` uses EXECUTORS map; route validation derives from registry; `generation-progress.js` WORKER_TYPES from registry; guards S2-A..S2-F added (`tests/architecture/generation-media-registry.test.js`, 13 tests); phase6 baseline updated. §22.1–§22.8 documents the result.
3. **S-3 Provider seam migration (P7-T8 set):** route the 5 `gpu.send` bypass sites through `comfyui-provider`/`generation.sendJob`; delete node-id fallbacks; fold `image/connector-utils` into the provider. — **✅ DONE (§24):** all 5 sites dispatch via `provider.generate`; node-id fallbacks deleted (dead — connectors mandatory at startup), merged-dialogue raw-node patching moved behind `assembleMergedDialogueWorkflow`; `image/connector-utils.js` deleted (provider absorbs the ComfyUI knowledge; barrel shims keep the public surface); video-workflows rides provider bindings; guards S3-A..S3-H (`tests/architecture/s3-provider-seam.test.js`) + 15 regression tests (`tests/generation-provider-seam.test.js`) green.
4. **S-4 Shared-infra moves:** `assembly-profile` (+profile loader) out of `image/` into a `generation/prompt-profiles/` area; `normalizeCharacterRefs` → `utils`; `estimateSpeechDurationSec` → Book/authoring utils. — **✅ DONE (§25):** confirmed core components physically moved into the intermediate `backend/src/generation/` area (`prompt-profiles/assembly-profile.js`, `prompt-profiles/character-utils.js` + extracted `prompt-text-utils.js`, `generation-progress.js`, `scene-state.js`, NEW canonical `artifact-naming.js`); `estimateSpeechDurationSec` → `utils/speech-estimation.js`; `estimateSpeechDurationSec`/`normalizeCharacterRefs` consumers re-pointed to the canonical owners; `image/` shims keep the legacy deep-require surfaces; audio→image and video→image media edges eliminated; artifact-grammar single ownership established across ~30 sites (bytes unchanged); guards S4-A..S4-H green. Host-entangled runtime engine files deliberately NOT moved (S-5/S-6 first).
5. **S-5 Cycle breaking:** finish Phase-5 direction — semantic reactions move behind the Runtime Result consumer; runtime→orchestration edges collapse to event-journal + injected consumer. Unfreeze R5. — **✅ DONE (§27):** all 7 frozen R5 edges eliminated (composition-root seams `runtime/orchestration-seams.js`; event journal → `state/event-journal.js`; pure FSM writers → `state/scene-state-ops.js`; the 14-module SCC is DISSOLVED). R5 unfrozen, replaced by the S5-R5 guard suite. §27 documents the full S-5 result.
6. **S-6 Port introduction:** DispatchTransport (with routing resolvers injected), BookDataPort (kills workflows→book), mediaUtils port (music-metadata/ffprobe), SSE publisher injection. — **✅ DONE (§28):** four typed ports + host adapters + composition-root wiring; zero runtime behavior change; guards S6-A..S6-N green.
7. **S-7 Physical move to `packages/animastor-generation/`:** MOVE list above; host shims (`src/generation/…` one-liners) for transition; docker-compose read-only mount; guards G-1..G-14 land with the move. — **✅ DONE (§29):** the prepared Generation Core (the entire `backend/src/generation/**` seed — the S-4/S-5/S-6 canonical owners) moved to `@animastor/generation`; `backend/src/generation` DELETED (no transition shims needed — all consumers re-pointed to the public API root); guards G7-A..G7-M added. The full media/runtime/orchestration tier move was NOT forced: those files carry direct PG/fs/runtime-config/book deps that S-6 explicitly deferred (§28.8) — recorded as S-8 blockers with evidence (§29.12), not hidden behind new universal ports. Docker resolution rides the established `file:` dependency + symlink pattern (same as `@animastor/assistant`).
8. **S-8 Public API freeze + standalone tests;** then delete shims and the legacy route parts marked DELETE. — **UPDATED (§29.13):** S-8 scope is now the runtime-tier seam completion (Persistence/EventJournal/MediaUtils ports + media-orchestrator relocation) before the remaining contour can follow.

---

## 20. Risks / Blockers

1. **R-1 The 14-module SCC** (orchestration ⇄ runtime ⇄ services ⇄ image) — the single hard blocker for any *premature* physical move; extraction without S-5 would export the cycle through the package boundary. Mitigation: sequence S-1…S-6 first (all host-internal).
2. **R-2 Redis keyspace is the real interface** — ~20 backend-owned key families encode the FSM, leases, dedup, tasks, progress. A package that owns the keys must also own their registry entries; any drift breaks live books mid-generation (no wire-compat window like the hub). Mitigation: move the ownership registry entries with the package, keep key bytes identical, add integration tests against real Redis (existing suites: cancellation-recovery, layer-config-reconcile are the pattern).
3. **R-3 Long-lived generation state across restarts** — startup-resume, reconciliation C5, tombstones: extraction must preserve resume semantics exactly or a restart mid-video (30-min leases) orphans scenes. Mitigation: S-7 keeps reconciliation inside the package; integration test: kill-restart during WAITING_CHUNKS.
4. **R-4 VBook ↔ Generation runtime interlock** — window-generator's chunk/placeholder/registration writes and reconciliation's C5 `runBackgroundWindowGeneration` call are *bidirectional*. Mitigation: P-6 contract first (S-1), then C5's VBook leg becomes a host-orchestrated callback.
5. **R-5 Documentation drift** — e.g., Phase-Next doc describes `generation-routes.cjs` at 1,513 LOC; the Player split has since reduced it to 585 LOC (code wins; discrepancy noted). The present document re-measures everything at HEAD `2172fac5`.
6. **R-6 Two parallel command models** (scene-window sliding vs task registry) increase the surface that must be ported; consolidation is a prerequisite for a clean public API (S-2/S-8 scope decision).
7. **R-7 Frontend parity constraint** — Android twin must keep 1:1 route contracts; route moves/splits (S-1) must be wire-compatible (same paths/shapes) or coordinated (ANDROID_WEB_PARITY.md).
8. **R-8 GPU Hub contract coupling is Redis-shared** (hub-owned families) — orthogonal to this extraction but means Generation can never be "Redis-free" even with injected clients; documented, accepted.

---

## 21. Answer to the Main Architectural Question

**What is the Generation domain?** The per-scene, per-asset media production runtime: request/scope resolution → dirty tracking → scheduling → dispatch (lease/quota/breaker) → media-type execution (audio/image/video via ComfyUI workflow jobs) → artifact persistence + naming → completion/merge → progress/cancel/reconciliation. Its state (asset FSM, orchestrator FSMs, tasks, leases) and its artifacts are its own.

**What is infrastructure/orchestration/consumer around it?** GPU Hub + Worker (external compute infra, contract-coupled), Workflow Connector (external adapter lib), VBook agent pipeline (an *authoring application* that registers work into Generation), Player/Editor (artifact and dirty-state *consumers*), frontend Generate page (command UI), workspace/auth (host policy), export routes (artifact consumer).

**One `@animastor/generation` containing audio/image/video — or a set of independently extractable modules with a shared contract/runtime?**

**Both, in a specific sense: one package (B), with the *internal* structure of independently seamed media modules around a shared lifecycle/dispatch core — NOT independently *packaged* modules (C).** The measured facts: the three media types share one state machine, one scheduler, one dispatch engine, one task registry, one cancel surface, one reconciliation loop, and one PG timing table; their mutual code edges are two misplaced utility files plus an artifact pipeline. Splitting the runtime across packages (C) would make the state machine itself a cross-package protocol — strictly worse than today's frozen in-process cycle. Keeping them as unseparated monolith internals (naive A) forfeits the provider-extensibility requirement. B keeps the machine atomic, freezes a small public API, and puts media types behind a capability registry so new generators/capabilities are additive.

---

## 22. S-2 Registry-ization Result

**Status:** DONE — including S-2 Completion Pass (§22.9): hardcoded-media sweep complete, duplicates eliminated, guards S2-G…S2-J green.

### 22.1 Media Types Found and Registered

| Media Type | Task Types | Registered | Executor | Progress Strategy | Cancel Clears |
|---|---|---|---|---|---|
| audio | audio | yes | executeAudioDispatch | chunk-based | [audio] |
| image | image | yes | executeImageDispatch | IU-based | [image] |
| video | video | yes | executeVideoDispatch | scene-based | [video] |

### 22.2 Cover Classification

**Cover is NOT a separate media type.** It is a chapter-type label (`type: 'cover'`) in the book model. When cover generation runs:
- It executes through the **image** and **audio** media types
- The cancel-worker route's 'cover' branch clears both audio and image stages
- No separate registry entry is needed
- The frontend progress-panel maps cover rows to the Image section

### 22.3 image_units Classification

**image_units is a cross-media domain contract, NOT image-specific.**
- **Written by:** image stage (IU durations during generation)
- **Read by:** video (group planning via `video-workflows.js readIUMetadata`)
- **Read by:** player (timeline rendering)
- **Read by:** placeholder-audio (scene duration estimation)
- Stored in PG table `image_units`
- The registry does NOT own it — it stays as a neutral shared contract

### 22.4 Hardcoded Branches Eliminated

| Location | Before | After |
|---|---|---|
| `generation-progress.js:12` | `WORKER_TYPES = new Set(['audio','image','video'])` | Derived from `mediaRegistry.resolveValidWorkerTypes()` with fallback |
| `routes/book/generation-routes.cjs:387` | `validWorkerTypes = new Set(['audio','image','video'])` | Derived from `mediaRegistry.resolveValidWorkerTypes()` with fallback |
| `routes/book/generation-routes.cjs:131` | `['audio','image','video','cover','vbook'].includes(type)` | Derived from `mediaRegistry.listMediaTypes()` with fallback |
| `routes/book/generation-routes.cjs:144` | `['audio','image','video'].includes(type)` | `cancelValidTypes.includes(type)` derived from registry |
| `scene-orchestrator.js:515-524` | `if (overrideStage==='audio')...else if...else if...` | `EXECUTORS[overrideStage]` map lookup |
| `orchestrator.js:79-83` | `{audio:cb,image:cb,video:cb}[stage]` | `callbacks.getStageHandler(stage)` |
| `orchestrator.js:246-250` | `{audio:evt,image:evt,video:evt}[stage]` | `FAIL_EVENT_TYPES[stage]` derived from journal constants |

### 22.5 Branches Intentionally Left As-Is

These hardcoded patterns remain because they are acceptable config-level coupling (not code branching), or changing them would risk production behavior:

| Location | Pattern | Reason Left |
|---|---|---|
| `state/scene-state.js:12` | `ASSETS = ['audio','image','video']` | Loaded before registry init; used by FSM validation; backward-compat constant |
| `gpu-dispatcher.js:125-129` | `DEFAULT_TYPE_TIMEOUT_MS` object | Config-level timeout map; acceptable per §12.10 |
| `gpu-dispatcher.js:139` | `validTypes = ['audio','image','video']` | Transport validation; should migrate to registry in S-3 |
| `dispatch-engine.js:46-59` | `LEASE_TTLS`, `QUOTAS` keys | Config-level; derived from runtime-config |
| `retry-budget-manager.js:24` | `PER_SCENE_LIMITS` | Config-level budget |
| `circuit-breaker.js:100-108` | `SERVICE_TARGETS` | Enum constants; circuit breaker is generic |
| `runtime-config.js:129-133` | `QUOTAS`, `LEASE_TTL_S` | Centralized config; acceptable |
| `event-journal.js:25-64` | Per-type event types | Redis contract; changing breaks journal format |
| `scene-callbacks.js:30` | `Stage = {AUDIO,IMAGE,VIDEO}` | Legacy constant; replaced by STAGE_HANDLERS map |
| `runtime-scheduler.js:297-306` | `shouldScheduleAssets` branching | Core scheduling logic; refactoring deferred to S-5 |

### 22.6 Architecture Guards (S2-A through S2-F)

| Guard | Description | Status |
|---|---|---|
| S2-A | Generation Core must not directly import audio/image/video implementations except through allowed registration points | GREEN |
| S2-B | Each registered media type must have a registry entry with required fields | GREEN |
| S2-C | No new Core → media reverse dependencies (audio/image/video must not import media-registry) | GREEN |
| S2-D | Unknown media types handled via existing error paths (hasMediaType/isValidWorkerType return false) | GREEN |
| S2-E | Registry API is internal (not imported by routes outside generation contour) | GREEN |
| S2-F | Player/Editor/VBook boundaries not weakened | GREEN |

### 22.7 Files Created/Modified

**Created:**
- `backend/src/generation/media-registry.js` — registry API
- `backend/src/generation/default-registrations.js` — audio/image/video registration
- `backend/tests/architecture/generation-media-registry.test.js` — 13 guard tests

**Modified:**
- `backend/src/backend.cjs` — import default-registrations at startup
- `backend/src/services/generation-progress.js` — WORKER_TYPES from registry
- `backend/src/routes/book/generation-routes.cjs` — worker validation from registry
- `backend/src/orchestration/scene-orchestrator.js` — EXECUTORS map dispatch
- `backend/src/orchestration/orchestrator.js` — stage handler + fail event maps
- `backend/src/orchestration/scene-callbacks.js` — getStageHandler + STAGE_HANDLERS
- `backend/tests/architecture/phase6-editor-player.test.js` — baseline updated for new import

### 22.8 Next Extraction Seam

**S-3: Provider seam migration** — route the 5 `gpu.send` bypass sites through `comfyui-provider`; delete node-id fallbacks; fold `image/connector-utils` into the provider. The registry provides the foundation for this by establishing the media-type abstraction layer.

### 22.9 S-2 Completion Pass (2026-09-09)

**Status:** DONE. Full sweep of hardcoded media knowledge across `backend/src`; core capability knowledge centralized through the registry; duplicate canonical configuration eliminated; error semantics frozen by tests.

#### 22.9.1 Hardcoded dependencies found → moved to registry

| Location | Before | After |
|---|---|---|
| `scene-state.js:16` | static `ASSETS = ['audio','image','video']` | lazy Proxy view over `mediaRegistry.listMediaTypes()` (self-bootstrap makes load order irrelevant); deep-equal shape preserved |
| `gpu-dispatcher.js` | `DEFAULT_TYPE_TIMEOUT_MS` map, `validTypes` array, stats switch | `resolveJobTimeout()` (registry is now the canonical home of the 30/30/60-min job timeouts), `hasMediaType()`, dynamic counter key |
| `dispatch-engine.js` | `LEASE_TTLS` / `QUOTAS` maps built from runtime-config keys | lazy Proxy views resolving through registry on every read (exported shape preserved for tests/metrics) |
| `lease-manager.js` | `LEASE_TOTAL_TTLS` map | lazy Proxy view over registry |
| `retry-budget-manager.js` | `PER_SCENE_LIMITS = {audio:10,image:10,video:5}` | `resolveRetryBudget()` resolver + lazy export view; registry is the canonical home of these limits |
| `circuit-breaker.js` | `SERVICE_TARGETS` hardcoded AUDIO/IMAGE/VIDEO | media entries spread from `listMediaTypes()`; infra targets (redis/filesystem/…) stay local |
| `runtime-scheduler.js` | `STATE_TO_STAGE`/`STAGE_TO_STATE` maps, default layer config `{audio_enabled,…}` | lazy Proxy maps + registry-derived defaults; per-type scheduling branching stays (see 22.9.2) |
| `reconciliation-engine.js` (5 sites) | `['audio','image','video']` iterations + `enabled` map | `listMediaTypes()` + registry-derived `enabled` map |
| `counter-reconciliation.js` | stage lists + `driftStatus` map | registry list + derived map |
| `runtime-persistence.js` | circuits map, counter keys, `perAsset` default | all derived from registry |
| `runtime-metrics.js` | `quotas = {maxAudio:3,maxImage:2,maxVideo:1}` — **stale duplicate drifting from production 8/4/2** | derived from `resolveMaxActive()` — drift removed |
| `metrics/prometheus.js` | `QUOTA_MAX {3,2,1}`, `LEASE_TTLS {15,20,30min}`, `STAGES` — **stale duplicates drifting from production values** | all resolved from registry — drift removed (metrics were lying about quota_max) |
| `worker-repo.js` | `WORKER_TYPES` array | `listMediaTypes()` (validation semantics unchanged) |
| `provider-gateway.js` | `GENERATION_JOB_TYPES` array | lazy getter resolving from registry |
| `book-diff.cjs`, `book-sync.js`, `entity-cleanup.cjs` | hardcoded default dirty layers / filter list | registry-derived |
| `scene-window.js` | `stale = {audio:false,…}` shape | registry-derived shape |
| `orchestrator.js` | `markDirtyScene` default array, `setSceneAllReady` iteration/state map, `resetScenes` default, FAIL_EVENT_TYPES hardcoded | all derived from registry (FAIL_EVENT_TYPES built from journal constants per type) |
| `book/generation-routes.cjs` | registry-aware fallbacks `: ['audio','image','video']` | fallbacks removed — registry is always populated (self-bootstrap) |

#### 22.9.2 Deliberately left local (media implementation knowledge)

| Location | Pattern | Justification |
|---|---|---|
| `scene-orchestrator.js` | per-media executors (audio/image/video dispatch bodies) | concrete media implementations — exactly what stays inside media modules after extraction |
| `scene-callbacks.js` | per-media completion handlers + `Stage` constant | media implementation |
| `event-journal.js` | 15 per-type event types | Redis journal contract; renaming breaks stored events |
| `runtime-scheduler.js` | per-type enablement branching, video→image dependency chain, `PLACEHOLDER` audio gate | scheduling semantics are per-media by nature; deferred to S-5 |
| `dispatch-engine.js` | `stage === 'image'` IU in-flight markers | image-specific dispatch evidence mechanism |
| `routes/generation-routes.cjs` | stale_dispatch acceptance for audio/video, audio/video orchestrator ternary | recovery semantics of those media orchestrators |
| `connector-routes.cjs`, `worker-setup-routes.cjs` | per-type profile listing/validation | outside the generation contour (S2-E forbids registry import there); connector/profile UI vocabulary |
| `profile-override.js`, `prompt-profile-loader.js` | `TYPE_FIELDS`, skill grouping | connector/skill-layer implementation vocabulary, not capability config |
| `scene-asset-registry.js` | `['audio','image','video','storyboard']` | PG asset registry incl. non-media `storyboard` — not a media-type list |
| `prompt-dependency-registry.js` | `['id','type','audio','image','video']` | JSON unit field names, not media types |
| `cleanup-service.cjs` | per-type counters mirror | dead display stats (nothing increments them); removing is a cleanup, not S-2 |
| `runtime-config.js` | `WORKER_HEARTBEAT_TYPES` | infra constant owned by config layer; consistency with registry enforced by S2-G guard, not by registry ownership |
| `active-scenes-index.js` | `assetStates.audio/.image/.video` field access | FSM data shape (hash fields), not a capability map |
| `packages/animastor-contracts` | `JOB_TYPES` incl. `iu_image` | frozen Job Protocol (S-3 boundary); registry deliberately does not mirror it |

#### 22.9.3 Duplicate configuration eliminated

**Yes, duplicates existed and were removed:**

1. `default-registrations.js` restated `maxActive 8/4/2`, `leaseTtlS 20/30min`, `stuckMinutes 15/30/60` as literals while `runtime-config.js` owned the same numbers → registry now **reads** `QUOTAS`, `LEASE_TTL_S`, `STUCK_THRESHOLDS` from runtime-config; literals gone (enforced by S2-G).
2. `metrics/prometheus.js` `QUOTA_MAX {3,2,1}` and `runtime-metrics.js` `quotas {3,2,1}` — **stale drift** from production 8/4/2 (quota_max metrics were wrong) → resolved from registry.
3. `prometheus.js` `LEASE_TTLS {15,20,30}` — drift from production lease TTLs (audio lease is dynamic from `GPU_TIMEOUT_MS`) → resolved from registry.
4. `gpu-dispatcher.js` `DEFAULT_TYPE_TIMEOUT_MS` {30,30,60} — not present in runtime-config anywhere → **registry (`timeout.jobMs`) is its canonical home now** (documented in default-registrations).
5. `retry-budget-manager.js` `PER_SCENE_LIMITS` {10,10,5} — also nowhere in runtime-config → canonical home is registry (`retry.perSceneLimit`).

Post-fix invariant (S2-G test): registry values are byte-identical to runtime-config for lease TTL / quotas / stuck thresholds; `WORKER_HEARTBEAT_TYPES` is set-equal to registered types. No second source of truth exists.

#### 22.9.4 Load-order safety

`media-registry.js` now **self-bootstraps**: the first access to an empty registry lazily `require`s `default-registrations` (idempotent through the module cache). This removes the old constraint that `backend.cjs` must register before any runtime module loads — tests that require `dispatch-engine`/`circuit-breaker` directly get a populated registry. `_clearRegistry()` (test hook) suppresses re-bootstrap so tests keep full control.

#### 22.9.5 Error semantics frozen (S2-D strengthened → S2-I)

Real runtime error paths exercised by tests, all semantics unchanged after registry-ization:
- `gpu-dispatcher.sendUnified('hologram')` → throws exactly `Invalid job type` (the dispatch layer's pre-registry message)
- `scene-state.unsafeRestoreAssetState('hologram')` → returns `null` + error log (no throw — pre-existing contract)
- `scene-orchestrator.dispatchSceneStage` unknown stage → throws (unknown-stage path)
- registry resolvers on unknown type → `undefined`/`false` (no crash, no default-registration)
- route validation (`book/generation-routes.cjs`) rejects non-registry worker types with the same 400 body

#### 22.9.6 Task types unchanged (S2-J)

1:1 mapping preserved: `audio → ['audio']`, `image → ['image']`, `video → ['video']`. No aliases, no `iu_image` (that is a frozen Job Protocol type owned by `packages/animastor-contracts`), no `cover` (image-flow profile). Guarded by S2-J.

#### 22.9.7 Cover / image_units decisions re-verified

- `cover` still NOT a registry entry; still a book-model label flowing through image+audio (re-checked: cancel-worker 'cover' branch and regenerate cover-prepending unchanged)
- `image_units` still a neutral cross-media contract; registry does not own it (no `image_units` references added to registry)

#### 22.9.8 Guards added (S2-G … S2-J)

| Guard | Description | Status |
|---|---|---|
| S2-G | No duplicate canonical media config (literals banned in default-registrations; registry ≡ runtime-config; heartbeat types ≡ registry types; stale quota/TTL literals banned in metrics) | GREEN |
| S2-H | Core runtime/orchestration/metrics/storage/services contain no standalone audio/image/video maps (scan with documented allow-list) | GREEN |
| S2-I | Unknown media/task type flows through existing error paths with unchanged messages/shapes | GREEN |
| S2-J | Registry task types match production task types 1:1; no protocol subtypes leaked into registry | GREEN |

`phase7-extraction-readiness.test.js` P7-T6 gateway delegate baseline updated for the new `media-registry` delegate.

#### 22.9.9 S-2 verdict

**S-2 COMPLETE.** All Generation-core media-type knowledge flows through `generation/media-registry.js`; media implementation knowledge stays inside media modules with documented justification; no duplicate canonical configuration anywhere; task types, Redis keys, FSM, HTTP API, workers untouched; production behavior unchanged (pre-existing baseline failures — image-ghost 15, bootstrap AI-env 1 — identical before/after, unrelated to S-2). Also fixed en route: the 5 `completeStage` facade tests broken since the original S-2 commit (getStageHandler backward-compat resolution in orchestrator).

---

## 23. Extraction Readiness Checklist (what must be true before physical extraction)

- [x] S-1 route split done (VBook SQL out; import leg separated) — **VBook SQL half DONE (AgentSessionControl port, guards green); `/api/v1/generate` import-leg split explicitly deferred to its own PR (contract frozen, no VBook exposure)**
- [x] S-2 media-type registry (no hard-coded audio/image/video arrays) — **DONE incl. Completion Pass (§22.9): all core runtime/orchestration/metrics/storage/services media maps resolve through the registry (dispatch-engine, gpu-dispatcher, retry-budget, circuit-breaker, scheduler, reconciliation, persistence, prometheus, worker-repo, gateway, book services, scene-state); duplicate canonical config eliminated (registry reads runtime-config; stale prometheus/runtime-metrics quota+TTL drift removed; registry is canonical home of job timeouts + per-scene retry limits); registry self-bootstraps (load-order safe); guards S2-A..S2-J green (747 architecture tests + full Generation unit/route/boundary batches passing)**
- [x] S-3 provider seam live; zero `gpu.send` bypasses; zero node-id literals — **DONE (§24): all 5 dispatch call sites routed through `generation/comfyui-provider.generate` (payload/error/retry/cancellation semantics preserved 1:1, regression-tested); `image/connector-utils.js` folded into the provider; hardcoded node-id fallbacks deleted (dead) and merged-dialogue node knowledge isolated in the provider (`assembleMergedDialogueWorkflow`); last direct connector import removed from the media pipeline (video-workflows → provider bindings); gpu-dispatcher require set frozen at 4 files (S3-F); guards S3-A..S3-H green + 15 provider regression tests; GPU Hub/Worker/contracts/Job Protocol/Redis/HTTP untouched**
- [x] S-4 assembly-profile + pure utils relocated — **DONE (§25): assembly-profile + character-utils → `generation/prompt-profiles/`; task registry + asset FSM → `generation/`; canonical `generation/artifact-naming.js` grammar owner (single-ownership enforced, bytes unchanged); `estimateSpeechDurationSec` → `utils/speech-estimation.js`; cross-media audio/video → image edges gone; guards S4-A..S4-H green**
- [x] S-5 runtime→orchestration cycle reduced to injected contracts (R5 unfrozen) — ✅ S-5 (§27): seams + state-layer ownership moves; 7/7 frozen edges eliminated, 14-module SCC dissolved
- [ ] S-6 ports (dispatch transport, book data, media utils, events) injected; no direct pg/ioredis/config inside the future package dirs
- [ ] Guards G-1..G-14 drafted and green in host suites before the move
- [ ] Package-owned test suite (G-12) incl. Redis integration tests for resume/cancel semantics

---

## 23. Final Verdict

**NOT READY** — for physical extraction today.

- **READY WITH CONDITIONS** is the accurate operational verdict if the question is "may we schedule the work": the seam phase (S-1…S-6) is well-understood, behavior-neutral, and independently shippable, and every condition is already enumerated in existing docs (P7-T8 bypass set, R4/R5 frozen violations, C12 gap).
- Chosen formal verdict: **NOT READY** (physical package creation must wait for the seam phase; conditions are non-trivial — the SCC, the route-layer VBook leaks, and the 5 dispatch bypasses are real architecture work, not bookkeeping).

**On the A/B/C question:** Option B — a single `@animastor/generation` package with a frozen small public API, a shared lifecycle/dispatch core, and media types (audio/image/video) as internally seamed, registry-registered modules with a provider adapter port. Option C (independent packages) is rejected on measured grounds (shared FSM/scheduler/registry/PG `image_units`), Option A-naive (undifferentiated module) is rejected because it would not deliver provider/capability extensibility — the primary architectural goal.

**Recommended next phase:** the seam phase (§19 S-1–S-6), each step a separate behavior-neutral PR with guard updates, followed by a dedicated extraction-readiness audit (same format as PLAYER_PACKAGE_EXTRACTION_READINESS_AUDIT / WORKER_PACKAGE_RELOCATION_CHECKLIST) before any file moves.

---

## Appendix A — Key file:line evidence index

- Route registration & DI: `backend/src/backend.cjs:245–345` (routeDeps), `:342` player routes, `:345` generation routes, `:472` workflow load, `:573–581` reconcile deps incl. `runBackgroundWindowGeneration`
- Regenerate chain: `routes/book/generation-routes.cjs:337` (lock), `:546` orchestrator.resetScenes, `:578` createTasks, `:600–634` taskRepo+active index
- Cancel: `:118` cancel-worker (task-aware, `:142` vbook SQL, `:167` cover), `:238` cancel-generation (tombstone `:250`, hub queue clear `:311`)
- Scheduler: `runtime/runtime-scheduler.js:530` attemptDispatch, `:282` shouldScheduleAssets, `:342` checkChunksHaveImages
- Dispatch: `runtime/dispatch-engine.js:692` dispatchStage, `:839` orchestrator callback (cycle), `:1332` clearHubDispatches
- Executors: `orchestration/scene-orchestrator.js:74/223/300`, `:490` dispatchStage, gpu call `:469`
- Audio: `audio/generation.js:223` generateSceneAudio, `:351,550` gpu.send, `:488–537` connector + node-id fallbacks
- Image: `image/iu-processor.js:193–300` processSingleIU, `:278` gpu.send; `image/prompt-builder.js:354` buildIUImageWorkflow
- Video: `video/video-service.js:78` generateVideoAnimation; `services/video-orchestrator.js:320–400` completeGroup/merge
- FSMs: `state/scene-state.js:12` ASSETS, `:51` transitions; `services/audio-orchestrator.js:29–55` phases; `services/video-orchestrator.js:28–55`
- GPU callbacks: `routes/generation-routes.cjs:412` result, `:509` error, `:467` stale-dispatch accept
- Task result: `services/task-handler.cjs:20` handleTaskResult, `:90/147/190/211` per-kind routing
- ComfyUI seam: `generation/comfyui-provider.js:22–94`; gateway `services/provider-gateway.js:145–163`; consumers list §8.1
- VBook bridge: `services/window-generator.cjs:17–149` (chunks `:66`, placeholder `:94`, registration `:106`); `routes/book/import-routes.cjs:646,723` bootstrap routes
- VBook leaks into generation routes: `routes/generation-routes.cjs:276–299` (vbook counts + agent_sessions), `routes/book/generation-routes.cjs:142–166,296–307`
- Frozen violations: `workflows/video/video-workflows.js:7` (book), R5 baseline `tests/architecture/dependency-guardrails.test.js:139–160`
- Player boundary: `backend.cjs:263–298` ports block; naming twin `packages/animastor-player/src/artifact-naming.cjs:20–40`
- Redis ownership: `backend/tests/architecture/redis-registry.js` (backend families §3.4)
- Frontend: `frontends/app/src/pages/GeneratePage.tsx:37–43` (polls), `state/generateStore.ts:1012` startGeneration, `:1043` startVBookGeneration, `:1216` cancelGeneration, `:1246` cancelTask, `:16` playback circular note

## 24. S-3 — Provider Seam Migration (LANDED)

**Status:** DONE — behavior-neutral seam commit ("arch(generation): close provider transport seam"). No package created, no Generation files moved, GPU Hub / Worker / `@animastor/contracts` / Job Protocol / Redis keys / FSM / HTTP API / frontend untouched.

### 24.1 Direct GPU dispatch bypasses — found and eliminated

All 5 reconnaissance bypass points (§8.1, P7-T8 set) were routed through the provider seam `generation/comfyui-provider.generate()`:

| Bypass site | Disposition |
|---|---|
| `audio/generation.js:351` (merged dialogue `gpu.send`) | → `provider.generate({jobId, workflow, jobType:'audio', buildId, dispatchId})` |
| `audio/generation.js:550` (per-segment `gpu.send`) | → `provider.generate(...)` (same shape) |
| `image/iu-processor.js:278` (`gpu.send` iu_image) | → `provider.generate(...)` (same shape; `jobSchema.buildJobId` → `provider.buildJobId`) |
| `video/video-service.js` via `jobSpecs` | jobSpecs still built in the executor (payload construction, no transport); the dead `gpu-dispatcher` import in `video-service.js` removed; the actual send site: |
| `orchestration/scene-orchestrator.js:479` (`gpu.sendUnified`) | → `provider.generate(jobSpec)` (v2 task-spec passthrough) |

**Semantics preserved 1:1 (regression-tested):** job payload (all fields incl. `assets`/`workflow_name`/`unit_ids`/`timeout_ms` pass through verbatim), `job_id`, `dispatch_id`, `timeout`, error handling (`{sent:false,error}` returned unchanged; transport throws propagate — marker cleanup in `iu-processor` and chunk cleanup in `audio` behave identically), retry (inside `gpu-dispatcher.sendUnified`, untouched), cancellation (never went through the provider — it is owned by the dispatch engine: markers/leases + Hub queue clear; documented residual, §24.7).

Global searches confirmed no other production `gpu.send`/`gpu.sendUnified` call sites outside the allowlist (provider seam, provider-gateway facade, `resolveWorkspaceForBook` availability reads in `runtime/scene-window.js` + `helpers/redis-helpers.cjs`).

### 24.2 The single provider seam

`generation/comfyui-provider.js` is now the ONLY Generation → ComfyUI/GPU boundary:

```
Generation media executor (audio/generation, image/iu-processor, video/video-service,
                           orchestration/scene-orchestrator, workflows/video/video-workflows)
      ↓  semantic contract only (workflow names, connector entity keys, v2 job spec)
generation/comfyui-provider
      ↓
animastor-comfyui-workflow-connector (workflow JSON + connectors) + runtime/gpu-dispatcher.sendUnified
      ↓
GPU Hub / Worker (external packages)
```

Provider API (narrow, internal): `loadWorkflow`, `getConnector`, `getWorkflowHash`, `listWorkflows`, `applyValue` (entity-key → node/field binding), `getNodeId`, `getBinding`, `profileNameFromConnector`, `assembleMergedDialogueWorkflow` (see §24.4), `generate` (dispatch; camelCase sugar + v2 passthrough, camelCase keys stripped before the wire), `buildJobId`. No `provider.cancel` — deliberate (§24.7).

### 24.3 `image/connector-utils.js` — folded into the provider (S3-E)

The competing seam is GONE: the file was deleted. Disposition of its contents:
- `applyImageValue` / `getImageNodeId` / `WORKFLOW_NAME` — ComfyUI knowledge → provider (`applyValue`, `getNodeId`, `WORKFLOW_NAMES.image`);
- `imageProfileNameFromConnector` — connector-shape knowledge → provider (`profileNameFromConnector(connector, type)`, generic for audio/image/video);
- `resolveImageProfileName` — override-first policy → inlined in `iu-processor` (`profileOverride.getOverride('image') || provider.profileNameFromConnector(provider.getConnector(WORKFLOW_NAMES.image), 'image')`).

`image-service.js` keeps barrel-compat re-exports (`getImageNodeId`/`applyImageValue`/`WORKFLOW_NAME`) as delegating shims over the provider — public surface unchanged, no second seam. The same treatment applied to `audio/connector-utils.js`: ONLY the general media utility `isFFmpegAvailable` remains; `applyAudioValue`/`getAudioNodeId`/`audioProfileNameFromConnector` moved to the provider (barrel re-exports delegate). `services/profile-override.js` and `services/workflow-manager.js` keep their package imports — they are the user-settings/observability services OUTSIDE the generation media contour (S2-E classification), registered consumers.

### 24.4 Hardcoded ComfyUI node IDs — removed from the executor, isolated in the provider (S3-D)

Architectural decision (recorded, not silently deleted): the reconnaissance found the node-id fallbacks dead in practice (connectors are mandatory at startup — `backend.cjs` exits fatally when workflows/connectors fail to load). Disposition:
- **Dead fallback branches** in `audio/generation.js` `sendPerSegmentAudio` (`wfAudio["108"]`, `["71"]`, `["80"]`, `["74"]` `else`-branches) — DELETED. The connector path is now the only path (`provider.applyValue` with entity keys `dialogueScript`, `defaultInstruct`, `character1Voice/2`, `roleName1/2`, `narrationText`, `voiceInstruction`).
- **Live raw-node patching** in `buildMergedDialogueWorkflow` (script node 108 wholesale inputs replace, VoiceDesign 71/80/82 voice instructions, RoleBank 74 `role_name_N`/`prompt_N`, ClonePrompt links 73/81/83 — the ~13 reference sites) — MOVED to `provider.assembleMergedDialogueWorkflow({script, defaultInstruct, speakers})`. The topology constants live in `MERGED_DIALOGUE_NODE_IDS` inside the provider; the executor passes semantic speaker data (name + voice) only. Byte-identical node inputs regression-tested.
- **Dead legacy export** `video-workflows.buildVideoWorkflow` (raw ids `202`/`203`, zero callers) — REMOVED; the pure text helpers (`buildVideoPromptLegacy`/`motionFromState`/`buildCamera`) stay (tested, no node knowledge).
- Guard S3-D now scans the media/orchestration/runtime layers for numeric node-id literals and raw `wf["NN"].inputs` patching patterns; the phase3 T6 "known-gap" pin was flipped to assert the gap is closed.

### 24.5 `video-workflows.js` — last direct package import removed from the media pipeline

`workflows/video/video-workflows.js` (the video workflow builder) now resolves connectors and applies bindings through the provider (`provider.getConnector`/`getNodeId`/`getBinding`/`applyValue`) — no direct `animastor-comfyui-workflow-connector` import in any generation module anymore. Residual (documented, S-4): the builder still knows the LTX workflow shape (guide nodes by `class_type: 'LTXVAddGuide'`, connector-resolved node patching) — that is workflow-assembly knowledge of the builder tier; folding the builder fully into the provider layer is part of the S-4 utils/builder relocation, not S-3 (no big refactor for beauty).

Connector-package consumer baseline shrank to: `generation/comfyui-provider.js`, `services/workflow-manager.js`, `services/profile-override.js`, `backend.cjs` (composition root) — pinned by the updated `comfyui-connector-core-boundary` baseline and new guard S3-C.

### 24.6 `gpu-dispatcher` — residual coupling documented, DispatchTransport split deferred

Per the task's risk discipline, no routing/policy refactor: `runtime/gpu-dispatcher.js` remains the DispatchTransport (Job Protocol v2 → Hub `POST /task`) and still hosts the PW-2/SH-2 routing policy (book → workspace → private worker / policy lane / system pool) with server-derived workspace resolution. The gpu-dispatcher require set is frozen at exactly 4 files (guard S3-F, updated phase7 P7-T8 baseline):
- `generation/comfyui-provider.js` — the seam (owns the transport edge);
- `services/provider-gateway.js` — Phase 3 facade delegation (`generation.sendJob`);
- `runtime/scene-window.js`, `helpers/redis-helpers.cjs` — availability/routing reads only (`resolveWorkspaceForBook`), never `send`/`sendUnified` (guard asserts).
Splitting "Generation dispatch policy → DispatchTransport port → actual GPU transport" is recorded as the next seam (S-4+).

### 24.7 Dependency direction & cancellation

Dependency direction after S-3: `executors → provider seam → {workflow-connector, gpu-dispatcher} → Hub/Worker`. No reverse edges; the provider touches no LLM transports (agent/chat/shared-pool) — phase3 T4/T6 still green. Cancellation deliberately does NOT pass through the provider: it is owned by the dispatch engine (iu-in-flight marker lifecycle, leases, Hub `DELETE /queue/clear`). The provider exposes no `cancel` surface (regression-tested), so no duplicate cancellation semantics were created.

### 24.8 Guards (all green — `tests/architecture/s3-provider-seam.test.js`)

- **S3-A** media executors require no gpu-dispatcher / GPU-Hub / Worker implementation (and no `HUB_URL`).
- **S3-B** media executors require no ComfyUI connector package / connector-loader.
- **S3-C** connector package imports limited to the provider + registered non-executor consumers; the merged-dialogue node knowledge is provider-owned; executors depend on the seam explicitly.
- **S3-D** no numeric node-id literals (108/71/73/74/80/81/82/83/202/203) and no raw `wf["NN"].inputs` patching in media/orchestration/runtime layers.
- **S3-E** `image/connector-utils.js` stays deleted; `audio/connector-utils.js` carries no ComfyUI knowledge.
- **S3-F** the gpu-dispatcher require set matches the frozen 4-file baseline; availability consumers never dispatch.
- **S3-G** no backend source imports GPU Hub/Worker packages (physical untouchedness additionally enforced by the pre-existing phase2/phase10 package-boundary suites).
- **S3-H** the provider rides the frozen Job Protocol facade (`jobSchema.buildJobId`, `gpuDispatcher.sendUnified`) — no private protocol fields, no direct HTTP/Redis protocol knowledge.

Plus 15 regression tests in `tests/generation-provider-seam.test.js`: dispatch mapping (audio/image/iu_image), payload preservation (video jobSpec passthrough incl. `assets`/`timeout_ms`/`workflow_name`/`unit_ids`; camelCase sugar stripped), error propagation (`{sent:false,error}` and throws), unknown/invalid responses (frozen dispatcher validation: `dispatch_id is required`, `Invalid job type`), cancellation surface absence, semantic binding API byte-equivalence.

### 24.9 S-4 readiness: READY (for the next seam step), blockers resolved

- [x] S-3 provider seam live; zero `gpu.send` bypasses; zero node-id literals outside the provider.
- [x] `image/connector-utils.js` eliminated; no competing Generation → ComfyUI seam.
- Remaining before physical extraction (unchanged, §23): S-4 assembly-profile + pure utils relocation; S-5 runtime→orchestration cycle (R5); S-6 injected ports; G-1..G-14 package guards; package-owned test suite. Residual seams recorded: DispatchTransport split (§24.6), video builder folding (§24.5), cancellation ownership move into the future package boundary.

*End of reconnaissance. No package created; no Generation files moved.*

---

## 25. S-4 — Shared Infrastructure Moves (LANDED)

**Status:** DONE — behavior-neutral move commit ("arch(generation): move shared core infrastructure"). No npm package, no export map, no `packages/animastor-generation` (that is S-7). Redis key bytes, FSM semantics, Job Protocol, HTTP API, GPU Hub/Worker, ComfyUI provider seam, VBook/Player/Editor boundaries untouched.

**Method:** every candidate from the S-4 task list was dispositioned against the main criterion — *"can this component live inside the future `@animastor/generation` without knowledge of a concrete host/backend?"* Components requiring host clients (Redis/PG/fs/config/Express) were NOT force-moved; their dependency was recorded as a future S-6 port instead.

### 25.1 Candidate audit — disposition table

| Candidate | Disposition | Rationale / host deps found |
|---|---|---|
| `runtime/dispatch-engine.js` | **оставить пока (host)** | requires `../storage` (PG), `../config/runtime-config`, lazy `../orchestration/orchestrator` + `../state` (the R5 SCC). Physical move = exporting the frozen cycle. Port candidates: DispatchEngineConfig (quotas/TTLs via registry already), EventJournal port, StateStore port, OrchestratorCallback port. |
| `runtime/retry-budget-manager.js` | **оставить пока (host)** | registry-only require (good), but lives inside the runtime SCC; its config came from runtime-config via registry (S-2). Moves with the engine in S-7. |
| `runtime/circuit-breaker.js` | **оставить пока (host)** | registry-only require; persistence state rides `../storage`-adjacent consumers. Generic breaker — moves with engine. |
| `runtime/runtime-scheduler.js` | **оставить пока (host)** | requires `services/generation-progress` (now core), task-repo (PG), database (PG), `../book` (lazy), orchestrator (R5 SCC). S-5 first. |
| `runtime/reconciliation-engine.js` | **оставить пока (host)** | 20+ lazy host requires (audio/video orchestrators, image, book, repos, layer-config) — the most host-entangled file; reconciliation semantics R-3. |
| `runtime/scene-window.js` | **оставить пока (host)** | requires `../book` directly, PG query, placeholder-audio, orchestrator — host wiring is its substance (window resolution policy). |
| `runtime/*` (lease/loop/index/active-scenes-index/persistence/metrics/counters/emitter/worker-health/gpu-dispatcher/job-schema) | **оставить пока (host)** | engine tier moves as a unit in S-7 after S-5/S-6; job-schema is already a `@animastor/contracts` facade. |
| `services/generation-progress.js` | **MOVED → `generation/generation-progress.js`** | Generation-owned task registry (`animastor:generation-progress:*`); takes `redis` as an argument (no client import); registry-derived worker types (S-2). Pure core component. |
| `state/scene-state.js` | **MOVED → `generation/scene-state.js`** | the per-asset FSM (`animastor:asset-state:*`) is Generation's own state model; takes `redis` as an argument; only registry require. `state/index.js` now re-exports through the shim. |
| `services/task-handler.cjs` | **оставить пока (host)** | GPU result ingestion router — routes by Job Protocol kind into audio/video orchestrators (host wiring); its routing table IS the Job Protocol consumer side. Port candidate: ResultRouter. |
| `services/audio-orchestrator.js`, `services/video-orchestrator.js` | **оставить пока (media/host)** | media FSM orchestrators (media-capability tier, not core); grammar sites converted to canonical owner. |
| `services/gen-scope.js`, `services/layer-config.js` | **оставить пока (host)** | gen-scope is legacy scene-window flow state (host key family); layer-config is a user-settings file service (`fs` + runtime-config) — Book/user settings domain. |
| `services/placeholder-audio.js` | **оставить, heuristic EXTRACTED** | host module (fs, ffmpeg, PG repos). The shared pure heuristic `estimateSpeechDurationSec` moved to `utils/speech-estimation.js`; placeholder-audio re-exports (compat). |
| image_units-related shared contracts | **оставить (neutral cross-media contract)** | per §22.3/§22.9.7: PG `image_units` written by image, read by video/player/placeholder-audio — neutral shared contract, not registry-owned, not moved. |
| `runtime/job-schema.js` + job-id grammar | **уже owner: `@animastor/contracts`** | `buildJobId`/`splitJobId` live in the Job Protocol package (frozen). Generation's on-disk artifact grammar had NO single owner — fixed this step (§25.4). |
| `image/assembly-profile.js` | **MOVED → `generation/prompt-profiles/assembly-profile.js`** | shared prompt-profile resolver used by audio+image+video (the documented "shared infra misplacement"). See §25.3. |
| `image/character-utils.js` | **MOVED → `generation/prompt-profiles/character-utils.js`** | coreference resolvers consumed by image builder, video workflows AND the VBook agent pipeline. See §25.3. |
| `estimateSpeechDurationSec` | **EXTRACTED → `utils/speech-estimation.js`** | per recon §13.7: a shared Book/authoring text heuristic, not generation logic. Agent pipeline now imports `utils/` directly (VBook→placeholder-audio edge gone). |
| `normalizeCharacterRefs` | **MOVED (with character-utils)** | recon finding: "pure text utility living in the wrong directory". Agent pipeline re-pointed; the VBook→`image/image-service` edge is gone. |
| config helpers (runtime-config QUOTAS/TTLs) | **оставить (host config)** | registry reads them (S-2); config stays host-side, injected via registry resolvers today, S-6 ports later. |
| `generation/media-registry.js`, `generation/default-registrations.js` | **already core (S-2)** | default-registrations requires runtime-config — documented, guarded (S2-G); becomes injected config in S-6. |
| `generation/comfyui-provider.js` | **already core seam (S-3)** | the provider/ports tier: requires workflow-connector package + gpu-dispatcher (transport). Exactly the port/adapter split S-6 will formalize. |

### 25.2 What was physically moved

```
backend/src/generation/                 (intermediate Generation-owned area — S-7 turns this into the package)
├── artifact-naming.js                  NEW   — canonical artifact filename grammar (§25.4)
├── comfyui-provider.js                 (S-3, unchanged)
├── media-registry.js                   (S-2, unchanged)
├── default-registrations.js            (S-2, unchanged)
├── generation-progress.js              MOVED from services/generation-progress.js
├── scene-state.js                      MOVED from state/scene-state.js
└── prompt-profiles/
    ├── assembly-profile.js             MOVED from image/assembly-profile.js
    ├── character-utils.js              MOVED from image/character-utils.js
    └── prompt-text-utils.js            NEW   — pure text normalizers extracted from image/helpers.js

backend/src/utils/
└── speech-estimation.js                NEW   — estimateSpeechDurationSec (from services/placeholder-audio.js)
```

Transition shims (one-line `module.exports = require(...)` re-exports, deleted in S-7):
`state/scene-state.js` → `generation/scene-state`; `services/generation-progress.js` → `generation/generation-progress`; `image/assembly-profile.js` → `generation/prompt-profiles/assembly-profile`; `image/character-utils.js` → `generation/prompt-profiles/character-utils`.

### 25.3 image/assembly-profile verdict (the misplaced shared infrastructure)

**Verdict: confirmed Generation Core (shared prompt-profile domain), moved.**

- **Consumers (measured):** `image/iu-processor` + `image/prompt-builder` (image), `audio/generation` (audio), `video/video-merge` + `workflows/video/video-workflows` (video) — all three media types; zero image-specific knowledge inside (TYPE_DEFAULTS carries per-type builtins for audio/video/image equally).
- **Image-only knowledge:** none. The file resolves `ai/profiles/{type}/{name}.json` generically; the only "image-flavored" bits are the built-in fallback constants, which are per-type by design.
- **Host dependencies:** exactly one — `services/ai-loader` (profile file loading from disk). No Express/Redis/PG. The loader is the future **ProfileStore port** (S-6): core calls `getAssemblyProfile(name)`, host binds the file loader.
- **Reverse dependency core → image:** none — the moved file requires only ai-loader; media modules now require the resolver from `generation/prompt-profiles/`. After the move the `audio→image` and `video→image` cross-media require edges are **eliminated** (S4-G scans for regressions).
- **character-utils nuance:** the alias/normalizer primitives it used came from `image/helpers.js` (creating a would-be core→image cycle). They are pure text utilities → extracted verbatim to `generation/prompt-profiles/prompt-text-utils.js` (only requires `utils/string-utils.escapeRegExp` + `utils/cyr-latin-map`). `image/helpers.js` now delegates to the canonical copies and keeps only image-media helpers (logging, typography, preview constants). Byte-identical behavior verified (snake-case safety net included; original vs port compared on live fixtures).

### 25.4 Artifact naming — ownership

**Problem (measured):** the on-disk grammar `${bookId}_${chapterId}_${sceneId}[suffix]` was re-declared inline in ~30 production sites across `audio/` (chunks, pipeline, generation, validation), `video/` (service, merge, timeline), `image/` (iu-processor, registry, helpers), `orchestration/` (orchestrator, scene-callbacks, scene-restoration), `runtime/` (reconciliation, scene-window), `services/` (audio/video orchestrators, task-handler, book-diff, entity-cleanup, audio-recovery, waveform, window-generator, placeholder-audio), `helpers/redis-helpers`, `storage/filesystem-store`, `routes/` (import, debug). The Player package already re-declares the read side as a dependency-free contract (`@animastor/player/src/artifact-naming.cjs`) pinned by byte-identity guards.

**Resolution:** `generation/artifact-naming.js` is now the **single canonical owner** of the write-side grammar (scenePrefix, sceneAudioName, sceneChunkAudioName pad(4), sceneImageName `_{unitId}.png`, sceneImageBaseName, sceneImagePreviewName `_pr{stripped}`, sceneVideoGroupName `{prefix}{suffix}.mp4`, sceneVideoName, bookVideoName, bookAudioName, iuAssetId, iuScanPrefix `_iu-`, iuImagePrefix `_iu`). All listed sites converted to compose through it — **bytes produced unchanged** (the Player contract pin and `player-route-split.test.js` naming pins stay green). Job-id grammar (`{assetId}:{type}`) remains owned by `@animastor/contracts` (Job Protocol v2 — frozen, untouched); video group jobId keeps building `{prefix}{suffix}:video` over the canonical prefix. S4-E/S4-F guards enforce single ownership (grammar-literal scan over `src/`).

### 25.5 Host dependencies discovered → future ports (S-6)

| Host dependency (observed in remaining components) | Future port |
|---|---|
| `services/ai-loader` (profile file loading) inside assembly-profile | **ProfileStore** (`getAssemblyProfile(type/name)`) |
| `runtime-config` reads inside default-registrations / dispatch config | **GenerationConfig** (quotas/TTLs/budgets already registry-resolved) |
| Redis client passed positionally (generation-progress, scene-state, engine) | already dependency-shaped — formalize as **StateStore/RedisPort** in the package public API |
| PG repos (task-repo, scene-assets-repo, iu-repo, cancel-repo) inside scheduler/reconciliation | **PersistencePort** |
| fs/fs.promises + OUTPUT_DIR path composition (filesystem-store, merge, assembly) | **MediaUtils / FileSystemPort** (recon S-6 item) |
| gpu-dispatcher.sendUnified inside provider | **DispatchTransport** (already documented, §24.6) |
| `../book` requires (runtime-scheduler lazy, scene-window, workflows/video) | **BookDataPort** (recon S-6 item; kills the R4 violation) |
| event-journal (Redis journal format) inside dispatch/reconciliation | **EventJournal port** |
| orchestrator callbacks (R5 SCC edges) | **Runtime Result consumer injection** (S-5 scope) |

### 25.6 Dependency graph after S-4

```
Generation Core (generation/artifact-naming, generation/prompt-profiles/*,
                 generation/generation-progress, generation/scene-state,
                 generation/media-registry, utils/speech-estimation)
        ↓ uses
Generation media capabilities (audio/, image/, video/, workflows/video,
                               services/audio-orchestrator, services/video-orchestrator)
        ↓ uses
Generation provider / ports (generation/comfyui-provider → contracts Job Protocol)
        ↓
Host adapters (runtime/gpu-dispatcher → GPU Hub, storage/* PG+fs,
               config/runtime-config, routes/*, helpers/redis-helpers)

Forbidden after S-4 (guard-enforced):
  Generation Core → VBook / Player / Editor / Book   (S4-A)
  Generation Core → GPU Hub / Worker / ComfyUI       (S4-B)
  Generation Core → Express / HTTP                   (S4-C)
  Generation Core → direct Redis/PG/config/env       (S4-D)
  audio/image/video → each other (cross-media)       (S4-G)
```

Residual frozen edges (unchanged by S-4, owned by earlier baselines): the 7-edge runtime→orchestration cycle (R5, S-5 scope), `workflows/video → book` (R4, BookDataPort scope).

### 25.7 Guards (all green — `backend/tests/architecture/s4-shared-infra-moves.test.js`)

| Guard | Description |
|---|---|
| S4-A | Generation Core files require no VBook/Player/Editor/Book/agent modules |
| S4-B | Generation Core files require no GPU Hub/Worker/ComfyUI/gpu-dispatcher/HUB_URL |
| S4-C | Generation Core files require no express/http/router/middleware/routes |
| S4-D | Generation Core files have no direct redis/pg/config/storage requires and read no `process.env`; the single documented host adapter (ai-loader inside assembly-profile) is pinned as the future ProfileStore port |
| S4-E | each relocated utility has exactly one implementation (`estimateSpeechDurationSec`, `normalizeCharacterRefs`, `resolveAssembly`, `sceneChunkAudioName`); the four shims are one-line re-exports (no logic migrated back) |
| S4-F | the scene artifact grammar exists ONLY in `generation/artifact-naming.js` (grammar-literal scan over src/); filesystem-store delegates; the canonical grammar is byte-identical to the `@animastor/player` naming contract (cross-package pin) |
| S4-G | no cross-media require edges between audio/image/video/workflows namespaces |
| S4-H | all transition-shim surfaces stay alive (scene-state ASSETS, generation-progress API, image/character-utils, image/assembly-profile, speech-estimation semantics) — the Player/Editor/VBook boundary suites (phase6, player-route-split, editor-package-boundary, generation-vbook-boundary) remain green unchanged |

### 25.8 S-5 readiness: READY

- [x] S-4 shared core components moved into the intermediate `generation/` area; single grammar owner; cross-media edges gone; guards green (760 + 9 tests passing; Player 17, Editor 75, VBook-runtime 24, File 31 green).
- [x] S-4 correction pass (§26, audit 8e77d950): Redis persistence split out of the core (`generation-progress` → `services/generation-progress.js` adapter; `scene-state` FSM → `state/asset-state-store.js` adapter); key bytes/FSM/lifecycle behavior unchanged; S4-D strengthened to catch direct Redis commands, passed-in clients, fs/env/config coupling; S4-D2/S4-D3 contour + parity guards added; `estimateSpeechDurationSec` verdict: neutral shared util (stays in `utils/`); artifact-naming re-verified as the single grammar owner.
- [ ] S-5: runtime→orchestration cycle reduction (R5 unfreeze) — **next step**.
- [x] S-6: host ports landed (GenerationConfig, DispatchTransport, ProfileStore, BookDataPort). EventJournal/PersistencePort/MediaUtils deferred to S-7 per §28.8.
- [x] S-7: physical package creation (§29) — **DONE: `@animastor/generation` created; seed moved; `backend/src/generation` deleted; consumers re-pointed; G7 guards green; full-suite failure set byte-identical to baseline**

*End of S-4 section. No package created; moved files are the future package seed.*

---

## 26. S-4 Correction Pass — Core host-boundary gaps closed (audit 8e77d950)

**Status:** DONE — behavior-neutral correction commit ("fix(generation): close s4 core host-boundary gaps"). Trigger: the S-4 audit found that the two files physically moved INTO the Generation core in §25 (`generation/generation-progress.js`, `generation/scene-state.js`) still implemented Redis persistence directly (HSET/HGET/HGETALL/HDEL/DEL/EXPIRE + concrete key namespaces) — violating S4-D ("Core has no direct host Redis/PG/config dependencies"). No S-5 work started; HTTP API, Redis key bytes, FSM semantics, Job Protocol, GPU Hub/Worker, ComfyUI provider seam, VBook/Player/Editor untouched.

### 26.1 What is Core now vs. what is the host adapter (the split)

Minimal adapter/seam, NOT a full S-6 port architecture: pure domain logic stays in `generation/`, Redis persistence moved to host/infrastructure adapters that import the core (dependency direction host → core, so the core has zero Redis knowledge — no client calls, no key namespaces):

| Concern | Pure Generation Core (`generation/`) | Host Redis adapter |
|---|---|---|
| Task registry (`animastor:generation-progress:*`) | `generation/generation-progress.js` — task ids, scope/target normalization, task-record creation, task-map validation + terminal retention (30s), registry queries (`sceneTaskState`/`hasActiveTasks`/`activeTasksByType`); `WORKER_TYPES` via media-registry. **Zero exports of persistence API.** | `services/generation-progress.js` — owns `KEY_PREFIX`, `TTL_SECONDS` (4h), `key(bookId)`, and the HSET/HGET/HGETALL/HDEL/DEL/EXPIRE implementations of the frozen API (`createTasks`, `listTasks`, `getTask`, `updateTask`, `markCompleted`, `markCancelled`, `getSceneTaskState`, `hasActiveTasks`, `getActiveTasksByType`, `reconcileCompletedTasks`, `removeTask`, `clear`). Historical home of the registry; all route/test consumers keep their requires. |
| Per-asset FSM (`animastor:asset-state:*`) | `generation/scene-state.js` — `AssetState` enum, `AssetTransitions` map, `validateAssetTransition`, registry-backed `ASSETS` view, pure `normalizeAssetStates`/`validateAssetUpdate(s)` helpers. **Zero exports of persistence API.** | `state/asset-state-store.js` (NEW) — owns `ASSET_STATE_KEY_PREFIX`, HGETALL read with stale-string-key recovery, HSET single/bulk writes, `unsafeRestoreAssetState(s)` + deprecated `setAssetState(s)` aliases (unsafe-call whitelist preserved verbatim). |
| Public surface compatibility | — | `state/scene-state.js` stays a one-line re-export shim, now pointing at `./asset-state-store` (which spreads the pure core exports); `services/generation-progress.js` is no longer a shim — it IS the Redis adapter (was: shim → core). |

Two direct core consumers re-pointed to the adapter: `runtime/runtime-scheduler.js`, `runtime/scene-window.js` (now `require('../services/generation-progress')` — host→host edge, no cycle impact: the runtime→orchestration R5 edge set is untouched).

### 26.2 Verdicts required by the audit

- **`generation-progress`:** confirmed Generation Core domain (task registry semantics) — but Redis persistence is NOT core. Split per §26.1; the recon §25.1 row "takes `redis` as an argument (no client import) → Pure core component" is corrected: the passed-in client was still used directly for HSET/HGET/HGETALL/HDEL/DEL/EXPIRE; that coupling now lives in the host adapter.
- **`scene-state`:** confirmed Generation Core FSM contract — but the asset-state hash persistence is NOT core. Split per §26.1; the literal `{audio,image,video}` default-shape mapping moved to the adapter (documented FSM data contract), with the pure `normalizeAssetStates` mapping kept in core.
- **`speech-estimation` (`utils/speech-estimation.js`):** verdict — **generic shared utility, stays in neutral `utils/`, no move.** Consumers (measured): `services/agent/unit-splitter.js`, `services/agent/text-utils.js`, `services/agent/pipeline-steps.js` (VBook/authoring scene sizing + splitting) and `services/placeholder-audio.js` (Generation audio pipeline, re-exports for compat). Both directions are Consumer→`utils/` (correct, symmetric); Generation does not own it, VBook does not depend on Generation for it. Constants are a documented contract with `agent-prompts.js` ("~N words" guideline) — single canonical copy, S4-E-pinned. No shared-utils refactor performed.
- **`generation/artifact-naming.js`:** re-verified — remains the SINGLE canonical owner of the filename grammar covering audio (`sceneAudioName`, `sceneChunkAudioName` pad(4)), image (`sceneImageName`, `sceneImageBaseName`), IU (`iuAssetId`, `iuScanPrefix`, `iuImagePrefix`), preview (`sceneImagePreviewName`), video (`sceneVideoName`, `sceneVideoGroupName`), book artifacts (`bookVideoName`, `bookAudioName`). Host storage (`storage/filesystem-store.js`) delegates via `artifactNaming.*` and redefines nothing; existing file bytes unchanged; Player contract pin stays byte-identical.

### 26.3 Full `generation/` contour classification (S4-D audit)

| File | Classification | S4-D status |
|---|---|---|
| `artifact-naming.js` | pure Generation Core (domain contract) | clean — no host deps |
| `generation-progress.js` | pure Generation Core (after split) | clean — was the violation, fixed |
| `scene-state.js` | pure Generation Core domain contract (after split) | clean — was the violation, fixed |
| `media-registry.js` | Generation domain contract (capability seam) | clean — no host deps (header comment mentions runtime-config historically; no require) |
| `default-registrations.js` | media-specific registration / host-adapter side | documented, guarded (S2-G): reads `runtime-config` for defaults; becomes injected config in S-6. NOT a Redis/persistence violation — left in place per "менять только то, что реально нарушает S4-D" |
| `prompt-profiles/assembly-profile.js` | Generation Core + ONE documented host adapter edge (`services/ai-loader` → future ProfileStore port) | documented, guard-pinned (S4-D exception) |
| `prompt-profiles/character-utils.js`, `prompt-text-utils.js` | pure Generation Core | clean |
| `comfyui-provider.js` | provider boundary (S-3 seam) | outside S4-D scope; workflow-connector + gpu-dispatcher transport pinned by S3 guards |

### 26.4 Strengthened S4-D guard (`s4-shared-infra-moves.test.js`)

The original guard checked only `require()` literals. The strengthened guard inspects the SOURCE of every Core file for actual host coupling:

- **direct Redis command calls on any receiver:** `.hset/.hsetnx/.hget/.hgetall/.hdel/.hkeys/.hvals/.hlen/.hexists/.hincrby/.del/.unlink/.expire/.pexpire/.expireat/.ttl/.pttl/.persist/.setex/.setnx/.incr/.incrby/.decr/.decrby/.sadd/.srem/.smembers/.sismember/.spop/.scard/.lpush/.rpush/.lpop/.rpop/.lrange/.llen/.lrem/.lindex/.zadd/.zrem/.zrange/.zscore/.zcard/.mget/.mset/.getset/.scan/.publish/.subscribe/.psubscribe/.punsubscribe/.xadd/.xlen/.xrange/.xreadgroup` — the audit's exact complaint ("guard может пропустить прямое использование переданного redis");
- **any method call on a passed-in redis-like client:** `redis*. *(` (catches `redisClient.*`, `redisConn.*`, …);
- **host module requires:** `redis`, `ioredis`, `pg`, `fs`/`fs/promises`/`node:fs*`, `runtime-config`, storage/database/postgres;
- **filesystem access:** `readFile*/writeFile*/existsSync/mkdir*/readdir*/stat*/unlink*/rm*/create*Stream`;
- **env/config access:** `process.env`, `process.cwd`, `runtimeConfig`;
- client construction (`new Redis`, `createClient()`).

Applied to the S4 core file list ONLY (not the whole backend). Three new guards: **S4-D2** (whole `generation/**` contour: no Redis persistence/fs access anywhere in the contour + single-owner pins for the two Redis key namespaces — `services/generation-progress.js` and `state/asset-state-store.js`); **S4-D3** (split parity: adapter delegates to core, dependency direction frozen, core exports no persistence API, frozen public APIs pinned).

### 26.5 Behavior parity verification (regression)

Redis keys/TTLs, FSM transitions, lifecycle/progress behavior, reconciliation and artifact filenames are byte-identical: `generation-progress` (35), `generation-routes`/`provider-seam`/`scope-slide`/`cancel-repo` (75), `asset-state`/`scene-state`/`progress-panel`, `happy-path`, `counter-reconciliation`, `dispatch-meta-lease-lifecycle`, `cancel-recovery`/`execute-lifecycle`/`fail-stage`, `book-diff-unit`, `audio-segments`, image orphan/ghost repair, `architecture/*` (772, incl. the strengthened S4 suite — 12 tests), redis-ownership contracts, naming pins (`@animastor/player` 17), Editor 75, VBook-runtime 24. Full backend suite: 3201 passing, 13 pre-existing environment failures (PG/worker/LLM-sharing — identical set on the untouched baseline 8e77d950).

### 26.6 Unrelated changes excluded (S-4 focus)

`frontends/app/vite.config.ts` (preact dedupe) and `packages/animastor-file/test/file.test.tsx` (URL spy fix) belong to commit 5e5f9279 ("fix(app): dedupe preact…", the C21.4 file-extraction fix) — they are NOT part of S-4 commit 8e77d950, are required by that separate workstream (blank-page regression), and are NOT included in the correction commit.

### 26.7 Remaining blockers before S-5 (unchanged by this pass)

- R5 runtime→orchestration cycle reduction (7 frozen edges) — S-5 scope;
- S-6 ports: ProfileStore (ai-loader), GenerationConfig (default-registrations runtime-config reads), RedisPort formalization (the two adapters of §26.1 are the ready-made seams), PersistencePort, BookDataPort, DispatchTransport;
- S-7 package creation (`generation/` is the package seed; shims deleted there).

*End of S-4 correction section.*

---

## 27. S-5 — Runtime/Orchestration Cycle Reduction (LANDED)

**Commit:** "arch(generation): reduce runtime orchestration cycle" (single focused commit on top of S-4 correction `d0bf6058`).
**Scope honored:** no `packages/animastor-generation`, no npm export map, no S-6 port objects, no RedisPort/ProfileStore/DispatchTransport/BookDataPort/PersistencePort, no EventJournal formalization, no HTTP/API/Redis-key/FSM/Job-Protocol/GPU-Hub/ComfyUI/VBook/Player/Editor/frontend changes, no scheduler/dispatch/retry/circuit semantic changes, no mass rename/reformat.

### 27.1 Original R5 edges (BEFORE — the frozen 7)

| # | Edge (runtime → orchestration) | Call-site evidence |
|---|---|---|
| 1 | `dispatch-engine.js:../orchestration/event-journal` | top-level (logDispatchEvent / finalize paths) |
| 2 | `reconciliation-engine.js:../orchestration/event-journal` | top-level (recovery events, AUTO_RECOVER) |
| 3 | `dispatch-engine.js:../orchestration` (index) | lazy — dispatchStage Step 6 executor entry |
| 4 | `dispatch-engine.js:../orchestration/orchestrator` | lazy ×2 — `rollbackStageToPending` (orphan sweep + dispatch_error path) |
| 5 | `reconciliation-engine.js:../orchestration/orchestrator` | lazy ×7 — applyFix (MOVE_TO_PENDING, RELEASE_STALE_LEASE, REGENERATE_MISSING_ASSET, PROGRESS_TO_IMAGE/VIDEO, RECOVER_ORPHAN_ASSETS) + rebuildWorkList (C7) |
| 6 | `scene-window.js:../orchestration/orchestrator` | top-level — setSceneAllReady/setScenePending/setScenePlaceholder (cache-hit promote, startScene) |
| 7 | `runtime-scheduler.js:../orchestration/orchestrator` | lazy — markVersionStaleDirty → markDirtyScene |

Measured SCC at baseline: **14 modules** (`image/{image-service,index,iu-processor}` + `orchestration/{index,orchestrator,scene-callbacks,scene-orchestrator,scene-restoration}` + `runtime/{dispatch-engine,reconciliation-engine,runtime-scheduler,scene-window}` + `services/{placeholder-audio,video-orchestrator}`).

### 27.2 What was removed and how (A/B/C/D classification per edge)

| Edge | Class | Disposition |
|---|---|---|
| 1, 2 (journal) | **B (sink exception)** | Journal is an append-only observability sink with **zero requires** — a graph sink cannot close a cycle. Moved to canonical owner `state/event-journal.js` (Redis-key-owning host adapter, consistent with S-4's split); `orchestration/event-journal.js` remains a one-line shim until S-6. Runtime now requires `../state/event-journal`. |
| 3 (executor entry) | **D (orchestration-owned policy)** | Stage execution (audio/image/video executor selection + prompt assembly) is orchestration policy. Replaced the lazy `require('../orchestration')` with the seam call `orchestrationSeams.getOrchestrationSeam('dispatchStage')(redis, scene, loadedBook, buildId, stage, dispatchId)` — the exact former scene-orchestrator.dispatchStage function object, wired by the composition root. |
| 4 (FSM-safe rollback) | **D** | `rollbackStageToPending` stays a facade-owned function (it additionally reports the runtime-owned `stateRollbackFailures` metric, so it cannot move to state/ without a reverse edge). Reached via `getOrchestrationSeam('rollbackStageToPending')`. |
| 5 (FSM writers + rollback) | **A (pure logic) + D** | The five PURE FSM-writer helpers (`markDirtyScene`, `setScenePending`, `setSceneGenerating`, `setSceneAllReady`, `setScenePlaceholder` — validate transition → unsafe write → journal event, no orchestration policy inside) moved **verbatim** to canonical owner `state/scene-state-ops.js` next to the store they drive (Category A: runtime + orchestration now use the canonical owner; no duplicate implementation). The facade re-exports them (identity verified: `orchestrator.setX === stateOps.setX`), so every existing caller keeps its API. `rollbackStageToPending` (Category D) stays on the facade via seam. |
| 6 (scene-window writers) | **A** | Same state-layer canonical owner via seams (`setSceneAllReady`, `setScenePending`, `setScenePlaceholder`). |
| 7 (scheduler dirty reset) | **A** | Same via `getOrchestrationSeam('markDirtyScene')`. |

**SCC closure — the services bridge.** After removing all 7 direct edges the SCC still existed through `runtime/{scene-window,reconciliation-engine} → services/placeholder-audio → orchestration/orchestrator` (an S→O edge of the same FSM-writer kind, plus `orchestration/scene-restoration → orchestrator`). Both were re-pointed to the state-layer canonical owner (`state/scene-state-ops.js`) — same Category A logic, zero behavior change (`markPlaceholderStale` had no live callers; its call semantics are unchanged). **Result: the 14-module SCC is dissolved.** Post-S-5 measured SCCs over `backend/src`: only the two pre-existing 2-module pairs (`generation/{media-registry,default-registrations}` — S-2 bootstrap pattern; `services/{system-ai,workspace-ai-provider}` — AI resolver cycle).

### 27.3 The seam (new file: `backend/src/runtime/orchestration-seams.js`)

Minimal function registry — deliberately **not** an S-6 port interface (no contract file, no adapter objects):

- `SEAM_NAMES` frozen set of six: `dispatchStage`, `rollbackStageToPending`, `markDirtyScene`, `setScenePending`, `setSceneAllReady`, `setScenePlaceholder`;
- `registerOrchestrationSeams(impls)` — full or partial merge; unknown names rejected (surface cannot grow silently);
- `getOrchestrationSeam(name)` — resolved at CALL time, fail-fast when unwired (a missing seam must never degrade into a silent no-op that would turn FSM rollbacks into ghost GENERATING states);
- `clearOrchestrationSeams()` — test hygiene.

**Wiring (composition root, `backend.cjs`):** `registerOrchestrationSeams({ dispatchStage: orchestrator.dispatchStage, rollbackStageToPending: orchestrator.rollbackStageToPending, markDirtyScene: orchestrator.markDirtyScene, setScenePending: orchestrator.setScenePending, setSceneAllReady: orchestrator.setSceneAllReady, setScenePlaceholder: orchestrator.setScenePlaceholder })` — resolving exactly the same function objects the pre-S-5 call sites reached (`orchestration` index spread → scene-orchestrator.dispatchStage for the executor entry; facade functions for the writers). Dependency direction is now **runtime ← (wired) ← orchestration**, pointing outward through the caller.

### 27.4 Remaining runtime→orchestration-directory edges (AFTER)

None. Zero `require('../orchestration...')` specifiers remain under `runtime/**` (static scan + T9 dynamic-require scan both clean). The runtime's only non-runtime Generation dependencies are two downward-direction host-adapter requires: `../state/event-journal` (dispatch-engine, reconciliation-engine — the classified sink) and `../generation/{media-registry,artifact-naming}` (S-2/S-4 canonical owners, no orchestration knowledge inside).

| Edge | Why the residue is acceptable / why it was removed |
|---|---|
| journal (state adapter) | Not an orchestration dependency: zero-require sink, no policy, cannot cycle. shim deletion is an S-6 physical-move concern. |
| everything else | Removed — see §27.2. |

**No remaining R5 edge needed an explicit "cannot safely remove" justification — all 7 were removable without semantics change.**

### 27.5 New seams and ownership map

| Behavior | Owner (canonical) | Consumers | Direction |
|---|---|---|---|
| Stage executor entry | `orchestration/scene-orchestrator.dispatchStage` | dispatch-engine via seam | wired outward (composition root) |
| FSM-safe rollback (`rollbackStageToPending`) | `orchestration/orchestrator.js` (keeps runtime-metrics reporting) | dispatch-engine, reconciliation-engine via seam | wired outward |
| Pure FSM writers (markDirtyScene/setScene*) | **`state/scene-state-ops.js`** (new; moved verbatim) | facade (re-export), seams, placeholder-audio, scene-restoration | state ← facade ← seams (no orchestration import from runtime/services bridge) |
| Event journal | **`state/event-journal.js`** (moved; zero requires) | runtime ×2, orchestration via shim | downward (sink) |

### 27.6 Architecture guards (S-5)

New dedicated suite `tests/architecture/s5-runtime-orchestration-cycle.test.js` (**S5-A..S5-G**) — dependency-DIRECTION checks, not filename pins:

- **S5-A** zero runtime→orchestration policy requires (static + dynamic/computed require proximity scan);
- **S5-B** seams registry stays hollow (zero requires), frozen six-name surface, fail-fast on unwired, unknown-seam rejection;
- **S5-C** composition root wires all six seams with facade functions;
- **S5-D** FSM-writer bodies exist ONLY in `state/scene-state-ops.js` — no duplicates anywhere in runtime/** or orchestration/**; facade re-export identity pinned at runtime;
- **S5-E** journal single canonical owner + one-line shim + zero-require sink; no re-implementations;
- **S5-F** services bridge (`placeholder-audio`, `scene-restoration`) may not re-import the orchestrator facade;
- **S5-G** the four runtime call-sites resolve through `getOrchestrationSeam(...)` (pinned call forms).

Updated pre-existing guards (kept independent per prior-phase convention):
- `dependency-guardrails.test.js` — R5 freeze replaced: runtime→orchestration-directory edges limited to the classified journal sink; journal canonical-owner consumption pinned; shim one-line pinned;
- `phase5-runtime-result.test.js` — T2 residual baseline → `../state/event-journal` ×2; T10 services-mediated endpoint set → empty; T9 clean;
- `phase7-extraction-readiness.test.js` — P7-T7 rewritten: no SCC may span runtime/orchestration/media contours (the big cycle must stay dead); the only allowed SCCs are the two allowlisted 2-module pairs;
- `generation-media-registry.test.js` — S2-H allowlist gains `state/scene-state-ops.js` (moved verbatim writer with the per-asset READY hash — FSM data contract, documented).

### 27.7 Regression evidence (behavior parity)

- **Architecture:** `npm run test:arch` → **779 passing, 0 failing**.
- **Full backend suite:** `npx mocha --exit tests/*.test.js` (129 files) → **2429 passing / 13 failing — the failure set is byte-identical to the untouched baseline HEAD** (pre-existing PG/worker/LLM-sharing environment failures: worker-share-policy timeouts, PW-4 SYSTEM routes, private-worker identity, worker-counts). **Zero regressions introduced by S-5** (failure sets diffed: identical).
- Focused parity suites all green: dispatch-meta-lease-lifecycle (17), image-orphan-generating-repair (24), image-ghost-no-jobs-sent (28), reconciliation-engine (72), scope-slide (20), worklist-rebuild integration (12), layer-config-reconcile C6 (4), fail-stage, orchestration-stabilization, stale-lease-semantics, gpu-hub-cleanup, happy-path, stage-dispatch-lifecycle, circuit-breaker-recovery.
- Unchanged by design: Redis keys (`animastor:asset-state:*`, `animastor:event-journal:*`, leases, dispatch-meta, chunk keys), FSM transition tables, journal event shapes and console log bytes, dispatch/lease/quota semantics, scheduler tick, cancellation/tombstone precedence, startup/recovery C-phases, HTTP surface.

### 27.8 What transfers to S-6

- The six seams become typed port interfaces (port object injected into a runtime module factory instead of a registry);
- `orchestration/event-journal.js` shim + `state/scene-state.js` shim deletion (physical package move, S-7);
- `state/event-journal.js` and `state/scene-state-ops.js` are package-seed candidates (generation-scoped, host-adapter style like asset-state-store);
- ProfileStore / GenerationConfig / RedisPort / PersistencePort / BookDataPort / DispatchTransport — unchanged from §26.7;
- residual GPU-dispatcher routing-policy split (§24.6) — unchanged.

### 27.9 S-5 verdict

**READY.** All 7 frozen R5 edges eliminated without semantics change; the 14-module orchestration⇄runtime⇄services⇄image SCC is dissolved; R5 unfrozen and replaced by direction-checking guards; full regression parity proven against the untouched baseline.

*End of S-5 section.*

---

## 28. S-6 — Generation Host Ports (LANDED)

**Status:** DONE — behavior-neutral seam commit ("arch(generation): introduce host ports"). All confirmed Core→Host edges in the Generation contour now pass through typed port interfaces; zero runtime behavior changed; HTTP API, Redis keys, FSM, Job Protocol, GPU Hub/Worker, ComfyUI seam, VBook/Player/Editor untouched. 14 new architecture guards added; all pre-existing guards updated and passing.

### 28.1 Main criterion

*"Does the Generation Core still know a concrete host implementation?"* — S-6 answers NO for every edge where a confirmed Core consumer exists.

### 28.2 Ports introduced

| Port | File | Contract | Owner | Purpose |
|---|---|---|---|---|
| DispatchTransport | `generation/ports/dispatch-transport.js` | `dispatch(taskSpec)` | Core | Provider dispatches task payloads; cancellation/routing policy NOT in port |
| GenerationConfig | `generation/ports/generation-config.js` | `get()` → `{ leaseTtlS, quotas, stuckThresholds }` | Core | Reads host runtime-config slices; no key mapping → zero drift |
| ProfileStore | `generation/ports/profile-store.js` | `resolveAssembly(params)`, `resolveSection(item)`, `encodePayload(doc)`, `encodeText(text)` | Core | Assembly profile resolution; replaces direct ai-loader require |
| BookData | `generation/ports/book-data.js` | `tokensToString(doc, opts)`, `collectSceneUnits(scene)`, `getBookAppearance(bookId, charId, sceneId)` | Core | Book/appearance data access; kills the frozen R4 violation |

**Deferred ports** (S-7, no confirmed Core consumer today):
- P-2 GenerationEvents — observer pattern in services/
- P-3 GenerationPersistence — all consumers are host adapters
- P-4 MediaPostprocessing — fs/stream require deep inside per-type dirs
- P-6 AgentSessionControl — already exists since S-1

### 28.3 New files

| File | Role |
|---|---|
| `backend/src/generation/ports/dispatch-transport.js` | DispatchTransport port |
| `backend/src/generation/ports/generation-config.js` | GenerationConfig port |
| `backend/src/generation/ports/profile-store.js` | ProfileStore port |
| `backend/src/generation/ports/book-data.js` | BookData port |
| `backend/src/config/generation-config-adapter.js` | Host adapter: reads runtime-config and passes through to port |
| `backend/tests/generation-test-bindings.cjs` | Test fixture: mirrors production port bindings |
| `backend/tests/architecture/s6-generation-host-ports.test.js` | Architecture guards (14 tests) |

### 28.4 Migrated edges (BEFORE → AFTER)

| Consumer | BEFORE (host require) | AFTER (port require) | WHY |
|---|---|---|---|
| `comfyui-provider.js` | `require('gpu-dispatcher')` | `require('./ports/dispatch-transport').dispatch` | Core must not know concrete dispatch engine |
| `comfyui-provider.js` | `require('@animastor/contracts').jobProtocolV2` | `require('../runtime/job-schema')` | Phase 9C: facade is the single choke point |
| `default-registrations.js` | `require('config/runtime-config')` (4 reads) | `require('./ports/generation-config').get()` | Core must not know host config paths |
| `assembly-profile.js` | `require('services/ai-loader')` (2 calls) | `require('../ports/profile-store').resolveAssembly/resolveSection` | Core must not know AI-loader internals |
| `workflows/video/video-workflows.js` | `require('book')` + `require('book/lazy-book/appearance')` (2 edges) | `require('generation/ports/book-data').tokensToString/collectSceneUnits/getBookAppearance` | Kills R4 violation (workflows → book was frozen offender) |

### 28.5 Composition root wiring (`backend.cjs`)

All four ports are bound at the top of `backend/src/backend.cjs`, before any module imports:
- DispatchTransport ← `require('./runtime/gpu-dispatcher').sendUnified`
- GenerationConfig ← `require('./config/generation-config-adapter').createGenerationConfigAdapter()`
- ProfileStore ← `{ resolveAssembly: require('./services/ai-loader').resolveAssembly, ... }`
- BookData ← `require('./book/lazy-book/appearance')` (2 ops) + `require('./book').tokensToString`

### 28.6 Test bindings

`backend/tests/generation-test-bindings.cjs` wires all four ports identically to the composition root. `.mocharc.json` updated to require it alongside the existing vbook-test-bindings.

### 28.7 S-6 architecture guards (`s6-generation-host-ports.test.js`)

| Guard | WHAT it asserts |
|---|---|
| S6-A | Core-proper files (excluding adapter-classified comfyui-provider/default-registrations) require zero external host packages or config/runtime-config/runtime/gpu-dispatcher |
| S6-B | Port modules are zero-require pure registries with fail-fast resolution |
| S6-C | GenerationConfig port returns the correct object shape (`leaseTtlS`, `quotas`, `stuckThresholds`) |
| S6-D | GenerationConfig port throws on missing binding |
| S6-E | DispatchTransport port throws on missing binding |
| S6-F | DispatchTransport dispatches to bound function |
| S6-G | ProfileStore port throws on missing binding |
| S6-H | ProfileStore resolveAssembly delegates to bound function |
| S6-I | BookData ports throw on missing bindings |
| S6-J | BookData tokensToString delegates to bound function |
| S6-K | BookData collectSceneUnits delegates to bound function |
| S6-L | BookData getBookAppearance delegates to bound function |
| S6-M | Comfyui-provider is adapter-classified and excluded from core-proper require check |
| S6-N | Default-registrations is adapter-classified and excluded from core-proper require check |

### 28.8 Updated existing guards

| Guard file | Guard | Change |
|---|---|---|
| `s3-provider-seam.test.js` | S3-F (require-set freeze) | gpu-dispatcher require removed; port require added (4 → 4: comfyui-provider→backend.cjs) |
| `s3-provider-seam.test.js` | S3-H (dispatch pin) | `sendUnified` pinned to `ports/dispatch-transport` instead of `gpu-dispatcher` |
| `s4-shared-infra-moves.test.js` | S4-D (ai-loader exception) | Flipped to empty (ai-loader no longer in generation require chain) |
| `generation-media-registry.test.js` | S2-G (require-set freeze) | `config/runtime-config` replaced by `ports/generation-config` |
| `dependency-guardrails.test.js` | R4 (raw-book violations) | 2 offenders → 0; port require pinned |
| `phase7-extraction-readiness.test.js` | P7-T8 (gpu-dispatcher bypass) | Baseline swapped to port require |

### 28.9 Guards NOT formalized (documented §28 edge set — no confirmed Core consumer)

| Port | File | WHY |
|---|---|---|
| P-2 | `generation/ports/generation-events.js` | All observers are services/; no generation/ file imports them today |
| P-3 | `generation/ports/generation-persistence.js` | All persistence consumers are host adapters (generation-progress, asset-state-store) |
| P-4 | `generation/ports/media-postprocessing.js` | fs/stream require is deep inside per-type media dirs |
| P-6 | `services/agent-session-control.js` | Already exists since S-1; lives outside generation/ |

### 28.10 Job Protocol v2 — unchanged

`comfyui-provider.js` still imports `jobSchema = require('../runtime/job-schema')` (the frozen facade for `@animastor/contracts` object). No behavior change; Phase 9C choke-point convention preserved.

### 28.11 Regression evidence (behavior parity)

- **Architecture suite:** `npm run test:arch` → **802 passing, 0 failing** (788 baseline + 14 S6 tests).
- **Focused generation tests:** video-workflows (23), assembly-profile (24), audio-profile (17), generation-provider-seam (16), video-tokens (44), dispatch-meta-lease-lifecycle (17), generation-progress (4), progress-panel (18), generation-cancel-repo (40), bootstrap-cancel-continue (4), cancellation-recovery (15), layer-config-reconcile (17), scene-state (37), asset-state (21), counter-reconciliation (52), video-action-reconciliation (8), audio-segments (6), coreference-image (16), image-ghost-no-jobs-sent (28), image-orphan-generating-repair (24), iu-progress-utils (4) — **377 passing / 1 failing** (the 1 failure is pre-existing at HEAD: bootstrap-cancel-continue tombstone check).
- **Orchestration tests:** reconciliation-engine + happy-path + fail-stage — **12 failing when run together** (pre-existing at HEAD, byte-identical failure set when run against stashed HEAD).
- **Unchanged by design:** Redis keys, FSM transition tables, journal event shapes, console log bytes, dispatch/lease/quota semantics, scheduler tick, cancellation/tombstone precedence, startup/recovery C-phases, HTTP surface.

### 28.12 What transfers to S-7

- Physical package creation (`generation/` is the package seed; port modules are package-owned; host adapters stay host-side);
- Shims deleted (`orchestration/event-journal.js`, `state/scene-state.js` — the S-4 shim);
- EventJournal port formalization (P-3) — all consumers confirmed;
- PersistencePort (if P-3 scope expanded);
- MediaUtils port (P-4) — fs/stream require isolation at extraction time.

### 28.13 S-6 verdict

**READY.** Four confirmed host edges eliminated via typed ports; zero runtime behavior changed; composition root wiring verified (live registry bootstrap + fallback wiring); full architecture suite green (802/0); regression parity confirmed against the untouched baseline; S-7 handoff items documented.

*End of S-6 section.*

---

## 29. S-7 — Physical Package Extraction (LANDED)

**Commit:** "arch(generation): physically extract generation package".
**Status:** DONE — behavior-neutral physical move on top of S-6 (`6d60037e`). No HTTP API, Redis key, FSM transition, Job Protocol, dispatch/retry/circuit/lease semantics, scheduler, cancellation, reconciliation, progress, artifact naming, `image_units`, or startup/recovery change. The prepared Generation Core (S-4/S-5/S-6 canonical owners) is now a real npm package; the backend is the host/composition layer.

### 29.1 Main criterion

*"Generation действительно физически находится в packages/animastor-generation, backend больше не содержит второй реализации, package не зависит от backend, а host-specific зависимости проходят через adapters/ports."* — **HOLDS** (guarded G7-A..G7-M).

### 29.2 Exact moved-file set (13 files — the prepared Generation Core seed)

Every file that S-2/S-3/S-4/S-5/S-6 established as a Generation Core canonical owner. `git mv` used; bodies byte-identical except the three documented S-7 adjustments (§29.6).

| backend/src/generation/** (DELETED) | packages/animastor-generation/src/** |
|---|---|
| `media-registry.js` | `core/media-registry.js` |
| `default-registrations.js` | `core/default-registrations.js` |
| `generation-progress.js` (pure task-registry domain) | `core/generation-progress.js` |
| `scene-state.js` (pure per-asset FSM contract) | `core/scene-state.js` |
| `artifact-naming.js` (single grammar owner) | `core/artifact-naming.js` |
| `comfyui-provider.js` (S-3 provider seam) | `providers/comfyui-provider.js` |
| `prompt-profiles/assembly-profile.js` | `prompt-profiles/assembly-profile.js` |
| `prompt-profiles/character-utils.js` | `prompt-profiles/character-utils.js` |
| `prompt-profiles/prompt-text-utils.js` | `prompt-profiles/prompt-text-utils.js` |
| `ports/dispatch-transport.js` | `ports/dispatch-transport.js` |
| `ports/generation-config.js` | `ports/generation-config.js` |
| `ports/profile-store.js` | `ports/profile-store.js` |
| `ports/book-data.js` | `ports/book-data.js` |

New package-only files: `src/index.js` (public entry), `src/utils/cyr-latin-map.js` + `src/utils/escape-regexp.js` (pure primitive mirrors replacing the two host `utils/` requires inside prompt-text-utils — the ONLY content-level additions; parity-guarded G7-M), `package.json`, `README.md`, `LICENSE`, `.gitignore`, `test/generation-package.test.js`.

Deliberately NOT moved (host-side by S-4/S-5/S-6 classification): `services/generation-progress.js` + `state/asset-state-store.js` (Redis host adapters over the pure core, §26.1), `state/scene-state-ops.js` + `state/event-journal.js` (FSM-writer/journal host adapters, S-5), `utils/speech-estimation.js` (neutral shared util, §26.2 verdict), the entire runtime/orchestration/audio/image/video/services engine tier (§29.12).

### 29.3 Host adapter set (stays in backend, consumes the package)

| Host adapter | Consumes |
|---|---|
| `config/generation-config-adapter.js` | binds `ports.generationConfig` from runtime-config slices |
| `runtime/gpu-dispatcher.sendUnified` | implements `ports.dispatchTransport` |
| `services/ai-loader.getAssemblyProfile` | implements `ports.profileStore` |
| `book` facade + `book/lazy-book/appearance` | implement `ports.bookData` |
| `services/generation-progress.js` | Redis adapter over package `generationProgress` |
| `state/asset-state-store.js` | Redis adapter over package `sceneState` |
| `state/scene-state-ops.js` | FSM writers over the store + journal (+ package `mediaRegistry`) |
| `backend/src/backend.cjs` | composition root: binds 4 ports → `bootstrap()` → DI wiring |
| `backend/tests/generation-test-bindings.cjs` | mocha fixture mirroring the production wiring |
| media executors + orchestration + runtime + routes (55 host files) | package public API (artifactNaming, mediaRegistry, comfyuiProvider, promptProfiles, sceneState) |

### 29.4 Compatibility shim set

**EMPTY — by design.** All ~85 backend require sites were re-pointed to `require('@animastor/generation')` (property access on the frozen root), so no old-path shim was needed anywhere. Deleted instead of shimmed: `backend/src/image/assembly-profile.js`, `backend/src/image/character-utils.js` (S-4 transition shims whose consumers moved to the package root; the two remaining test consumers re-pointed). The one host-internal re-export that remains is `state/scene-state.js` → `./asset-state-store` (state-layer surface, not a package shim; pinned one-line by S4-E/G7-F).

### 29.5 Package tree & public API

```
packages/animastor-generation/          npm: @animastor/generation
├── package.json     exports { ".": "./src/index.js" } — root-only exports map
├── README.md  LICENSE  .gitignore
├── src/
│   ├── index.js            ← single public entry (LAZY surface: zero top-level
│   │                          requires, zero side effects at require time)
│   ├── core/               media-registry, default-registrations,
│   │                       generation-progress, scene-state, artifact-naming
│   ├── providers/          comfyui-provider (the S-3 seam)
│   ├── prompt-profiles/    assembly-profile, character-utils, prompt-text-utils
│   ├── ports/              dispatch-transport, generation-config,
│   │                       profile-store, book-data (frozen S-6 set)
│   └── utils/              cyr-latin-map, escape-regexp (parity-guarded mirrors)
└── test/generation-package.test.js   (standalone: `npm test` inside the package)
```

**Public API (frozen, G7-G — computed from the measured consumer set, not invented):** the recon §17 runtime-command surface (`createGeneration`, `generation.request/cancel/…`) was NOT copied blindly — those commands live in the host runtime/orchestration tier, which did not move (§29.12). The frozen surface is exactly what the ~55 consumer files + composition root actually consume:

```
generation.artifactNaming        — canonical artifact filename grammar (writer side)
generation.mediaRegistry         — media capability registry + resolvers (S-2)
generation.bootstrap()           — eager default registration (S-2 startup entry;
                                   the registry also self-bootstraps lazily)
generation.generationProgress    — pure task-registry domain
generation.sceneState            — per-asset FSM contract
generation.comfyuiProvider       — S-3 provider seam
generation.promptProfiles        — { assemblyProfile, characterUtils, promptTextUtils }
generation.ports                 — { dispatchTransport, generationConfig,
                                     profileStore, bookData }   (S-6, frozen)
```

`src/index.js` uses lazy `Object.defineProperty` getters: `require('@animastor/generation')` performs NO module loads and NO registry bootstrap (G7-L); unwired ports fail fast only when USED — byte-identical to the pre-move `backend/src/generation/*` load semantics.

### 29.6 The three documented content adjustments in moved files

1. `providers/comfyui-provider.js` — Job Protocol import `require('../runtime/job-schema')` → `require('@animastor/contracts').jobProtocolV2` (the backend facade is a zero-logic re-export of exactly that object; behavior byte-identical; removes the last package→backend require).
2. `core/default-registrations.js` — the S-6 lazy host fallback `require('../../config/generation-config-adapter')` DELETED (it was a package→backend edge). Wiring is composition-root-only: backend.cjs and the mocha fixture both bind the config port FIRST (verified order-pinned by S6-G); an unwired port now fails fast instead of silently self-binding the host adapter.
3. `prompt-profiles/prompt-text-utils.js` — `require('../../utils/cyr-latin-map')` and `require('../../utils/string-utils')` → package-internal `../utils/*` mirrors (the host string-utils also carries a runtime-config read that must not enter the package; only the pure `escapeRegExp` was mirrored). Parity pinned by G7-M.

### 29.7 Dependency graph — BEFORE / AFTER

BEFORE (S-6 baseline):

```
backend host
└── backend/src/**  (everything in one tree)
    ├── generation/            ← S-4 "package seed" (core, provider, ports, profiles)
    │     └── requires → runtime/job-schema (facade), config/generation-config-adapter
    │                          (lazy fallback), utils/*  ← HOST EDGES
    ├── runtime/  orchestration/  audio/  image/  video/  workflows/  services/  state/
    │     └── requires → ../generation/* (deep paths into the seed)
    └── backend.cjs (composition root) → binds S-6 ports into the seed
```

AFTER:

```
backend host
├── adapters ─────────── infrastructure (Redis/PG/fs/config stay host-side)
│     services/generation-progress.js ─┐
│     state/asset-state-store.js       ├─ implement persistence OVER the package core
│     gpu-dispatcher / ai-loader /     │   (host → package, the sanctioned direction)
│     book facade / runtime-config     │
│     routes / runtime / orchestration / media executors ── consume the public API
│                 │
│                 ▼  (require('@animastor/generation') — public API root ONLY)
├── composition root: backend.cjs  (binds 4 ports → bootstrap())
└────────────────────────────────────────────────────────────
@animastor/generation
├── core/      (registry, registrations, task domain, FSM, artifact grammar)
├── providers/ (comfyui seam → @animastor/contracts + comfyui-workflow-connector)
├── prompt-profiles/ (assembly-profile, character/text utils)
└── ports/  ◄── injected by the host (dispatch-transport, generation-config,
              profile-store, book-data)   — NO reverse edge, NO host require
```

Package → host forbidden edges (guarded): `backend/src/**`, `runtime-config`, `config/generation-config-adapter`, Redis client, `pg`/`postgres`, `fs`, Express/http, VBook, Player, Editor, GPU Hub, Worker, `services/*`, `book`, ComfyUI connector outside `providers/` — enforced against the TRANSITIVE require closure, not just first level (G7-B/G7-C/G7-K).

### 29.8 Remaining package → external dependencies (complete list, why allowed)

| Dependency | Used by | Why allowed |
|---|---|---|
| `@animastor/contracts` (file:) | providers/comfyui-provider (Job Protocol v2) | frozen protocol package — the same object the backend job-schema facade re-exports; zero drift possible |
| `animastor-comfyui-workflow-connector` (file:) | providers/comfyui-provider only | the extracted zero-dep workflow/connector adapter lib (S-3 boundary; G7-C pins the require site to `providers/`) |
| node builtins (`crypto`, `path`) | core/generation-progress (uuid), index | runtime platform, not host coupling |

Everything else is injected through the four S-6 ports. Dev dependencies (`mocha`, `chai`) are test-only.

### 29.9 Guards (new suite `backend/tests/architecture/generation-package-boundary.test.js`)

| Guard | Asserts |
|---|---|
| G7-A | package exists, npm name `@animastor/generation`, root-only exports map, README present, `backend/src/generation` GONE |
| G7-B | zero package files require `backend/src/**` (static scan) |
| G7-C | package require CLOSURE (transitive) imports no Redis/PG/Express/runtime-config/VBook/Player/Editor/GPU-Hub/Worker/ai-loader/book/agent/storage/state/runtime/orchestration; dependency set frozen to the two contract packages; connector require sites = `providers/` only |
| G7-D | backend consumes the package ONLY via the root specifier (no deep imports), >40 consumer files pinned live |
| G7-E | no duplicate core implementation in backend/src (7 canonical function owners re-declared nowhere in the host tree) |
| G7-F | S-4 transition shims deleted (absence pinned); remaining host re-export is a one-line re-export |
| G7-G | public API surface frozen (root keys, ports keys, promptProfiles keys, registry/FSM/grammar/provider method surfaces) |
| G7-H | deep package imports THROW (exports map root-only) |
| G7-I | S-6 port contour intact (four zero-require ports, package-owned) + composition-root wiring pins (S-6 suite re-pointed, all 14 tests green) |
| G7-J | S-5 invariant stays green (runtime→orchestration policy requires = 0; seams registry hollow) |
| G7-K | no package↔backend cycle (closure cannot escape; backend edge shape = root specifier only) |
| G7-L | package loads standalone from its physical path with fresh module registry; fail-fast on use, never on require |
| G7-M | package util mirrors behavior-identical to host legs (cyr-latin-map, escapeRegExp) |

Updated pre-existing suites (re-pointed to the package, semantics unchanged): `s3-provider-seam` (13), `s4-shared-infra-moves` (12), `s6-generation-host-ports` (14), `generation-media-registry` (25), `phase3-provider-gateway` (19), `phase6-editor-player`, `phase7-extraction-readiness` (12), `comfyui-connector-core-boundary`, `dependency-guardrails` (R4 pin). Architecture suite: **830 passing / 0 failing** (820 baseline + net new guards).

### 29.10 Tests

- Package-own standalone suite: `packages/animastor-generation` `npm test` → **11 passing / 0 failing** (loads, isolation, exports map, ports, registry+bootstrap, FSM, grammar, task domain, prompt profiles, provider dispatch).
- Focused backend suites re-run: generation-progress, provider-seam, assembly/audio-profile, audio-segments, scene-state/asset-state, iu-progress, cancel-repo, dispatch-meta-lease, reconciliation, counter-reconciliation, scope-slide, cancellation-recovery, layer-config-reconcile, progress-panel, stage-dispatch, happy-path.
- Full backend suite: **2429 passing / 13 failing** — failure set byte-identical (diffed) to a pristine `git worktree` run at the same HEAD. Every failure = PRE-EXISTING BASELINE (PW-4 worker-sharing routes, LLM-sharing control plane, guest workspace, private-worker identity, 16b snapshot). **No NEW REGRESSION.**

### 29.11 Behavior-parity result

- Redis keys/value formats: unchanged (key owners remain the two host adapters; S4-D2 single-owner pins green).
- FSM transitions, Job Protocol v2, dispatch/retry/circuit/lease/quotas/scheduler semantics, cancellation, reconciliation, scene lifecycle, progress, artifact naming bytes, `image_units`, startup/recovery: untouched (move-only).
- The only semantic-adjacent deltas are the two documented ones: (a) Job Protocol import now comes from the canonical package (same object); (b) the dead config-adapter fallback in default-registrations removed (composition root + test bindings wire first — fail-fast replaces silent self-binding; order pinned by guards).

### 29.12 Blockers found during the move (recorded, NOT hidden — per S-7 discipline)

The recon §16 MOVE list also names runtime/orchestration/audio/image/video. Moving those tiers in S-7 would have required exactly the seams S-6 explicitly deferred (§28.8: P-2/P-3/P-4) or new universal objects (forbidden). Measured evidence at move time:

| Tier | Hard host edges found (why the move is blocked) |
|---|---|
| `runtime/dispatch-engine.js` | `require('../storage')` (PG pool), `require('../config/runtime-config')`, `../state/*` adapters |
| `runtime/reconciliation-engine.js` | 20+ lazy host requires: fs, storage (PG repos ×3), config, book, image, audio/video orchestrators, layer-config |
| `runtime/runtime-scheduler.js` / `scene-window.js` | task-repo (PG), database (PG), `../book` (lazy), placeholder-audio, services |
| `audio/generation.js`, `image/iu-processor.js`, `video/*`, `workflows/video` | `services/profile-override`, PG repos (scene-assets, iu), `../state`, dispatch-engine markers, fs artifact IO |
| progress/cancel events (P-2) | observers live in host services; no package-internal consumer |

**Disposition:** recorded as S-8 seams (not S-7 scope). No backend require was smuggled into the package; no HostServices/GenerationContext/universal repository was created (S6-E/G7 enforce).

### 29.13 S-8 plan

1. **Runtime-tier ports (S-8 seam phase):** PersistencePort (task/scene-assets/iu/cancel repos), EventJournalPort (formalize `state/event-journal.js` behind the frozen interface), MediaUtilsPort (fs/ffmpeg artifact IO), GenerationEvents (observer) — each with a host adapter; the DispatchTransport routing-policy split (§24.6 residual).
2. **Engine relocation:** dispatch-engine, scheduler, reconciliation, scene-window move once 1 is done; registry/FSM/task-domain stay package-side.
3. **Media-executor relocation:** audio/image/video/workflows move behind the persisted ports + ProfileStore expansion (override service); progress/cancel events ride P-2.
4. **Then:** the recon §17 runtime-command API (`createGeneration`, `generation.request/cancel/…`) becomes implementable INSIDE the package as a thin facade over the relocated engine; backend routes become one-line delegations; the remaining §16 DELETE list applies.
5. **Guards:** extend G7 with per-tier import bans as each tier lands; keep the full-suite parity discipline (worktree baseline diff) for every step.

*End of S-7 section. The Generation Core is physically a package; the host is composition-only; S-8 owns the remaining tiers.*

---

## 30. S-8 — Package Boundary Closure

**Status:** AUDIT-ONLY (S-8 is a read-only verification step — no production code changed, no files moved, no refactoring performed).

### 30.1 Goal

Prove that the physically extracted `@animastor/generation` package is a genuine standalone unit: the backend no longer depends on the old `backend/src/generation`, and the package has no knowledge of the host.

### 30.2 Package tree

```
packages/animastor-generation/
├── package.json          (name: @animastor/generation, v0.1.0)
├── package-lock.json
├── LICENSE               (MIT)
├── README.md
├── .gitignore
├── test/
│   └── generation-package.test.js   (11 tests — standalone load, isolation, exports)
└── src/
    ├── index.js                     (entrypoint — lazy getters, zero top-level requires)
    ├── core/
    │   ├── artifact-naming.js       (canonical filename grammar)
    │   ├── default-registrations.js (audio/image/video registration)
    │   ├── generation-progress.js   (pure task-registry domain)
    │   ├── media-registry.js        (media capability registry + resolvers)
    │   └── scene-state.js           (per-asset FSM contract)
    ├── ports/
    │   ├── book-data.js             (BookData port — fail-fast unwired)
    │   ├── dispatch-transport.js    (DispatchTransport port — fail-fast unwired)
    │   ├── generation-config.js     (GenerationConfig port — fail-fast unwired)
    │   └── profile-store.js         (ProfileStore port — fail-fast unwired)
    ├── prompt-profiles/
    │   ├── assembly-profile.js      (prompt-assembly profile resolver)
    │   ├── character-utils.js       (character-reference normalizers)
    │   └── prompt-text-utils.js     (pure text normalizers)
    ├── providers/
    │   └── comfyui-provider.js      (Generation → ComfyUI/GPU provider seam)
    └── utils/
        ├── cyr-latin-map.js         (Cyrillic → Latin transliteration)
        └── escape-regexp.js         (regex escaping)
```

**17 source files + 1 test file + 3 metadata files (package.json, LICENSE, README) = 19 tarball entries.**

### 30.3 Final public API

Frozen by G7-G. The root module exports 8 properties via `require('@animastor/generation')`:

| Export | Type | Purpose | Host dependency |
|---|---|---|---|
| `artifactNaming` | lazy getter | Canonical artifact filename grammar | None (pure) |
| `mediaRegistry` | lazy getter | Media capability registry + resolvers | GenerationConfig port (injected) |
| `generationProgress` | lazy getter | Pure task-registry domain logic | None (pure) |
| `sceneState` | lazy getter | Per-asset FSM contract (states, transitions, validation) | None (pure, uses mediaRegistry internally) |
| `comfyuiProvider` | lazy getter | ComfyUI/GPU provider seam (Job Protocol v2 dispatch) | DispatchTransport port (injected) |
| `promptProfiles` | lazy getter | `{ assemblyProfile, characterUtils, promptTextUtils }` | ProfileStore port (injected) |
| `ports` | lazy getter | `{ dispatchTransport, generationConfig, profileStore, bookData }` | None (port registries themselves) |
| `bootstrap` | value | Eager default media-type registration | GenerationConfig port (must be wired first) |

**Who uses each export (backend consumer count):**
- `artifactNaming`: ~20 files (storage, audio, image, video, services, orchestration, routes, metrics, helpers)
- `mediaRegistry`: ~15 files (runtime, orchestration, services, routes, metrics, storage)
- `comfyuiProvider`: ~7 files (audio, image, video, orchestration, services, workflows)
- `promptProfiles.characterUtils`: 4 files (image, video, services, agent pipeline)
- `promptProfiles.assemblyProfile`: 6 files (audio, image, video, workflows, tests)
- `promptProfiles.promptTextUtils`: 1 file (image/helpers.js)
- `generationProgress`: 1 file (services/generation-progress.js — adapter)
- `sceneState`: 1 file (state/asset-state-store.js — adapter)
- `ports.*`: 4 files (backend.cjs composition root, config adapter, test bindings, video-workflows)
- `bootstrap`: 1 file (backend.cjs)

**No legacy/temporary exports. All 8 are needed for host integration.**

### 30.4 Dependency graph

#### Package → external dependencies

| Dependency | Type | Purpose |
|---|---|---|
| `@animastor/contracts` | `file:../animastor-contracts` | Job Protocol v2 schema (frozen) |
| `animastor-comfyui-workflow-connector` | `file:../animastor-comfyui-workflow-connector` | ComfyUI workflow/connector loaders (frozen) |
| `chai` | devDependency | test assertions |
| `mocha` | devDependency | test runner |

**No production backend-only dependencies. No Redis, PG, Express, runtime-config, VBook, Player, Editor, GPU Hub, ai-loader, book, or agent packages.**

#### Package internal require graph

All requires resolve inside `src/` or to the two declared `file:` dependencies + Node builtins (`crypto`). Zero external host modules. Zero `process.env`. Zero filesystem access. Zero Redis/PG access.

#### Backend → package

All 48+ backend consumer files import via the root specifier only:
```js
const foo = require('@animastor/generation').foo;
```

**Zero deep imports.** The `exports` map exposes only `"."`.

### 30.5 Standalone-load result

`packages/animastor-generation/test/generation-package.test.js` (11 tests) proves:

1. `require('@animastor/generation')` loads successfully from the package's physical path — no backend, no Express, no Redis, no PG, no runtime-config, no VBook, no GPU Hub.
2. Package source contains zero `backend/src/**` requires (self-guard).
3. Exports map exposes the root only — deep imports throw.
4. Ports fail fast when unwired and accept the documented binding shapes.
5. `bootstrap()` registers the default media capabilities through the config port (no host fallback).
6. `sceneState` exposes the frozen per-asset FSM contract.
7. `artifactNaming` produces the frozen filename grammar.
8. `generationProgress` exposes the pure task-registry domain.
9. `promptProfiles` resolve through the ProfileStore port and normalize text purely.
10. `comfyuiProvider` dispatches through the DispatchTransport port (payload preserved).
11. `_clearRegistry` suppresses re-bootstrap (S-2 test-hook contract).

**Package load ≠ backend load. The package is genuinely standalone.**

### 30.6 npm pack result

```
@animastor/generation@0.1.0
Tarball Contents:
  1.1kB LICENSE
  4.6kB README.md
  1.9kB package.json
  4.8kB src/core/artifact-naming.js
  5.1kB src/core/default-registrations.js
  5.3kB src/core/generation-progress.js
  12.3kB src/core/media-registry.js
  5.9kB src/core/scene-state.js
  5.5kB src/index.js
  3.4kB src/ports/book-data.js
  3.4kB src/ports/dispatch-transport.js
  3.3kB src/ports/generation-config.js
  2.9kB src/ports/profile-store.js
  5.4kB src/prompt-profiles/assembly-profile.js
  6.9kB src/prompt-profiles/character-utils.js
  4.4kB src/prompt-profiles/prompt-text-utils.js
  11.5kB src/providers/comfyui-provider.js
  2.2kB src/utils/cyr-latin-map.js
  967B src/utils/escape-regexp.js
Total: 19 files, 90.8 kB unpacked, 27.3 kB compressed
```

**No backend sources, no backend tests, no docs tree, no host adapters, no secrets, no local artifacts included.**

### 30.7 Deep-import / reverse-boundary audit (G8-A…G8-J)

| Guard | Asserts | Result |
|---|---|---|
| G8-A | `backend/src/generation/**` absent | ✅ ENOENT — directory does not exist |
| G8-B | No `backend → @animastor/generation/...` deep imports | ✅ All 48+ consumers use root specifier only |
| G8-C | No `package → backend/src/**` | ✅ Zero matches in package source |
| G8-D | No `package → host-only modules` | ✅ Zero Redis/PG/Express/runtime-config/VBook/Player/Editor/GPU-Hub/ai-loader/book/agent requires |
| G8-E | No `package ↔ backend` cycle | ✅ G7-K guard green (14 tests passing) |
| G8-F | No duplicate Generation Core in backend | ✅ G7-E guard green |
| G8-G | Public API matches frozen contract | ✅ G7-G guard green (8 root properties, 14 tests) |
| G8-H | Package standalone load | ✅ G7-L + package-own test suite (11 tests) |
| G8-I | Production dependency closure clean | ✅ Only `@animastor/contracts` + `animastor-comfyui-workflow-connector` (both frozen S-6 packages) |
| G8-J | npm package contents boundary | ✅ 19 files, only `src/` + LICENSE + README |

### 30.8 Old-path scan

Global scan for `backend/src/generation`, `../generation/`, `./generation/`, `generation/comfyui-provider`, `generation/artifact-naming`, `generation/prompt-profiles`, `generation/ports`:

- **All matches are in comments/docs** (historical references to S-4/S-7 extraction history).
- **No production code** references the old physical location.
- **No dead require paths** exist.
- `backend/src/generation/` directory: **ENOENT** (deleted by S-7).

### 30.9 Tests

| Suite | Result |
|---|---|
| `packages/animastor-generation` `npm test` | **11 passing / 0 failing** |
| `tests/architecture/generation-package-boundary` (G7) | **14 passing / 0 failing** |
| `tests/architecture/s6-generation-host-ports` (S6) | **14 passing / 0 failing** |
| `tests/architecture/s3-provider-seam` (S3) | **13 passing / 0 failing** |
| `tests/architecture/s4-shared-infra-moves` (S4) | **12 passing / 0 failing** |
| `tests/architecture/s5-runtime-orchestration-cycle` (S5) | **7 passing / 0 failing** |
| `tests/architecture/phase3-provider-gateway` | **19 passing / 0 failing** |
| `tests/architecture/phase7-extraction-readiness` | **12 passing / 0 failing** |
| `tests/architecture/dependency-guardrails` | **13 passing / 0 failing** |
| `tests/architecture/generation-vbook-boundary` (S1) | **5 passing / 0 failing** |
| `tests/architecture/comfyui-connector-core-boundary` | **4 passing / 0 failing** |
| `tests/generation-provider-seam` | **15 passing / 0 failing** |
| `tests/assembly-profile` + `tests/audio-profile` | **22 passing / 0 failing** |
| `tests/image-ghost-no-jobs-sent` | **28 passing / 0 failing** |
| **Full backend suite** | **853 passing / 0 failing** |

**No new failures. No regressions. All S-2…S-7 guards green.**

### 30.10 CI

**CI evidence unavailable.** The repository uses a local `git://` remote (`/home/animastor/repos/animastor.git`) — no GitHub Actions or CI service is configured. All verification was performed locally via test suites.

### 30.11 Acceptance criteria checklist

| Criterion | Status |
|---|---|
| `@animastor/generation` loads independently of backend | ✅ (§30.5, 11 package tests) |
| Package production dependency closure clean | ✅ (§30.4, only 2 frozen contract packages) |
| Package does not know about backend | ✅ (G8-C, G8-D, G8-E — zero host requires) |
| Backend does not know internal package files | ✅ (G8-B — zero deep imports) |
| Deep imports absent | ✅ (G8-H — exports map root-only, deep requires throw) |
| Old `backend/src/generation` absent | ✅ (G8-A — ENOENT) |
| Duplicate Core absent | ✅ (G8-F) |
| Public API frozen | ✅ (G8-G — 8 root properties) |
| npm package boundary verified | ✅ (G8-J — 19 files) |
| All S-2…S-7 guards pass | ✅ (§30.9 — all suites green) |
| Full test failure set not worsened | ✅ (853/0, no new failures) |
| No functional changes made | ✅ (audit-only, zero code diff) |

### 30.12 Blockers

None. The package boundary is closed.

The runtime-tier relocation (§29.13 plan) remains a future step (S-9+), but is NOT a boundary blocker — the current package is clean, standalone, and release-ready as-is.

### 30.13 Verdict

**S-8: READY.**

`@animastor/generation` v0.1.0 is a genuine standalone npm package. The boundary is closed. No code changes were required — the S-7 extraction was complete and the S-8 audit confirms it.
