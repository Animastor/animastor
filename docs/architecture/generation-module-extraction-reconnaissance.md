# Generation Module Extraction — Architectural Reconnaissance

**Status:** READ-ONLY reconnaissance (reconnaissance / audit only). No production code changed, no files moved, no `packages/animastor-generation` created, no runtime behavior touched. — **Update (S-1, same date):** the seam step S-1 (§19.1) has since LANDED as a behavior-neutral follow-up commit ("arch(generation): isolate vbook session control from generation routes"): VBook session SQL was removed from the Generation route layer behind the `AgentSessionControl` port (`backend/src/services/agent-session-control.js`); guards added (`backend/tests/architecture/generation-vbook-boundary.test.js`, S1-A..S1-E). HTTP surface untouched. Details: §12 update, §13 update, §19 S-1 status, §22 checklist.
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
2. **S-2 Registry-ization:** one media-type registry module (assets, stages, worker types, quotas/TTLs); replace 4 hard-coded arrays.
3. **S-3 Provider seam migration (P7-T8 set):** route the 5 `gpu.send` bypass sites through `comfyui-provider`/`generation.sendJob`; delete node-id fallbacks; fold `image/connector-utils` into the provider.
4. **S-4 Shared-infra moves:** `assembly-profile` (+profile loader) out of `image/` into a `generation/prompt-profiles/` area; `normalizeCharacterRefs` → `utils`; `estimateSpeechDurationSec` → Book/authoring utils.
5. **S-5 Cycle breaking:** finish Phase-5 direction — semantic reactions move behind the Runtime Result consumer; runtime→orchestration edges collapse to event-journal + injected consumer. Unfreeze R5.
6. **S-6 Port introduction:** DispatchTransport (with routing resolvers injected), BookDataPort (kills workflows→book), mediaUtils port (music-metadata/ffprobe), SSE publisher injection.
7. **S-7 Physical move to `packages/animastor-generation/`:** MOVE list above; host shims (`src/generation/…` one-liners) for transition; docker-compose read-only mount; guards G-1..G-14 land with the move.
8. **S-8 Public API freeze + standalone tests;** then delete shims and the legacy route parts marked DELETE.

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

## 22. Extraction Readiness Checklist (what must be true before physical extraction)

- [x] S-1 route split done (VBook SQL out; import leg separated) — **VBook SQL half DONE (AgentSessionControl port, guards green); `/api/v1/generate` import-leg split explicitly deferred to its own PR (contract frozen, no VBook exposure)**
- [ ] S-2 media-type registry (no hard-coded audio/image/video arrays)
- [ ] S-3 provider seam live; zero `gpu.send` bypasses; zero node-id literals
- [ ] S-4 assembly-profile + pure utils relocated
- [ ] S-5 runtime→orchestration cycle reduced to injected contracts (R5 unfrozen)
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

*End of reconnaissance. No code changed, no files moved, no package created.*
