# Animastor — Architecture Map

> **Reconnaissance #1** · August 2026 · Compiled from actual source code (`backend/src`, `gpu-hub`, `worker`, `frontends/app`), Redis/PG access patterns, and git history. Where documentation contradicts code, code wins (divergences are marked).
>
> No behavior was changed to produce this document.

---

## 1. System Overview

Animastor is a visual-book (vBook) generation platform. A source text book is imported, converted by an AI agent pipeline into scenes/units, then three media layers are generated on remote GPU workers and assembled into a playable multimedia book.

```
┌──────────────┐   HTTP/JSON    ┌───────────────────┐   HTTP/JSON   ┌───────────────┐
│ Frontends    │ ─────────────▶ │ Backend (Node.js) │ ────────────▶ │ GPU Hub       │
│  web app     │  /api/v1/*     │  port 3000        │  /task        │  (Express)    │
│  Android     │                │                   │               │  port 5000    │
└──────────────┘                └──────┬──────┬─────┘               └───────┬───────┘
                                       │      │                            │  /task/next
                              ┌────────▼───┐  ┌──────────▼─────────┐        │  /task/result
                              │ PostgreSQL │  │ Redis (shared)     │   ┌────▼───────────┐
                              │ canonical  │  │ runtime transport  │   │ GPU Workers    │
                              │ persistent │  │ queues/leases/...  │   │ (ComfyUI)      │
                              │ state      │  └──────────┬─────────┘   └───────────────┘
                              └────────────┘             │
                                               ┌─────────▼─────────┐
                                               │ Filesystem         │
                                               │ /data/output/...   │  artifacts
                                               │ /data/books/...    │  book JSON
                                               └───────────────────┘
```

- **Backend** — single Express process. All services constructed with a dependency-injection style `deps` object (`backend/src/backend.cjs`).
- **GPU Hub** — thin transport between backend and workers (queues + timeouts + error forwarding). It is deliberately *not* a scheduler.
- **Workers** — poll the hub, run ComfyUI workflows, return base64 results.
- **Redis** — shared between backend and GPU Hub (same Redis instance per `docker-compose.yml`), used as runtime transport + coordination.
- **PostgreSQL** — canonical persistent state (books, scenes versions, asset metadata, agent pipeline, events).
- **Filesystem** — immutable artifacts keyed by `buildId`/`bookId`/`chapterId`/`sceneId`.

---

## 2. Frontend

Three production frontends + test harnesses:

| Target | Location | Stack |
|---|---|---|
| Mobile web (primary) | `frontends/app/` | Vite + React/Preact signals + TS |
| Android | `frontends/android/` | Kotlin, Material 3 (1:1 mirror of the web app) |
| Public website / library | `frontends/website/` | static pages |
| Test harnesses | `tools/mobile-web-tester/`, `tools/desktop-web-tester/` | Android WebView emulators |

Web state layer (`frontends/app/src/state/`):
- `generateStore.ts` (1147 LOC) — book session, generation status/nav icon, layer config, worker progress panel computation, SSE progress stream, VBook agent poll, import flow, session restore.
- `playbackStore.ts` (1261 LOC) — full player engine (queue, preload-ahead 3, gapless dual `<audio>`, IU cycling, position save/restore).
- `positionStore.ts` — chapter/scene/unit position.
- `api/client.ts` + `api/models.ts` — typed REST + SSE client.

Frontend ↔ backend boundary: `GET/POST /api/v1/...` and `SSE /api/v1/book/:bookId/progress-stream`. The frontend never writes Redis/PG directly; it computes *UI-derived* state (timer, done-rows windows, stale-row gating) locally (see `audit.md` §11).

---

## 3. Backend Module Map

### 3.1 Wiring (`backend/src/backend.cjs`, 429 LOC)

Everything is composed in one place:
- Redis client (`ioredis`, host `redis`), Express app, helmet, rate-limit (500 req/min), request logging.
- Service factories: `cleanupService`, `chatEngine`, `windowGenerator`, `taskHandler`, `bookDiff`.
- Route modules mounted with a shared `routeDeps` object (`book-routes`, `generation-routes`, `ai-routes`, `debug-routes`, `connector-routes`, `workflow-routes`, `config-routes`).
- Startup sequence (post-listen):
  1. load workflows (failure = **fatal**), `storage.postgres.initialize()` (failure = **non-fatal**);
  2. `runtime.loop.start(redis)` (fast tick 5 s);
  3. `reconcileCycle(redis, deps, { startup: true })` — unified startup recovery;
  4. genScope migration, reset of active counters, **deletion of all stale dispatch leases**, counter reconciliation.
- Graceful shutdown: stop loop → cancel active dispatches (`cancelActiveDispatch`) → close HTTP → close Redis/PG.

### 3.2 Orchestration (`backend/src/orchestration/`)

| Module | Role |
|---|---|
| `orchestrator.js` (665) | **Facade** — the single owner of lifecycle state writes (per-asset Redis state + PG `scene_assets.status`). Commands: `markDirty`, `markDirtyScene`, `planScene`, `beginStage`, `completeStage`, `failStage`, `setScenePending/Generating/AllReady/Placeholder`, `completeStageWithoutVideo/Image`, `reconcile`, `resetScenes`. |
| `scene-orchestrator.js` (497) | **Executors** — pure dispatch execution (`executeAudioDispatch/ImageDispatch/VideoDispatch`). No stage decisions. |
| `scene-callbacks.js` | **Handlers** — validate artifacts, update registries, update chunk metadata, trigger window slide. Never write PG `status='ready'` (contract T1). |
| `scene-restoration.js` | Disk→Redis chunk status restore (`restoreChunkStatusForScene`). |
| `event-journal.js` | Append-only Redis journal `animastor:event-journal:*` (7-day TTL). |
| `scene-utils.js` | Logging helpers. |

### 3.3 Runtime (`backend/src/runtime/`)

| Module | Role |
|---|---|
| `runtime-loop.js` | Heartbeat: fast tick every 5 s + separate reconcile cycle every 60 s (recursive `setTimeout`, non-overlapping). |
| `runtime-scheduler.js` (662) | **The only authority for scene progression.** `tick()` → `attemptDispatch` per active scene → `dispatchEngine.dispatchStage`. `shouldScheduleAssets` is pure (decision) + `detectVersionStale`/`markVersionStaleDirty` (PG version pre-pass). |
| `dispatch-engine.js` (1368) | Single dispatch authority: circuit breaker → duplicate/lease check → quota (Lua-atomic) → retry budget → lease (NX EX, renewable) → metadata → executor; `finalizeDispatch` (Lua-atomic claim + idempotency marker) on completion/failure/cancel. |
| `lease-manager.js` | In-memory renewal timers for active leases. |
| `reconciliation-engine.js` (1844) | Unified self-healing: `reconcileCycle` (phases A–D, distributed `CLEANUP_LOCK`). |
| `active-scenes-index.js` | `animastor:active-scenes` set — the scheduler's work list. |
| `scene-window.js` (793) | Windowed generation (`initSceneWindow`, `startScene`, `trySlideWindowOnComplete`), chunk metadata restore. |
| `counter-reconciliation.js` | Active-counter drift detection/fix (Lua). |
| `circuit-breaker.js`, `retry-budget-manager.js` | Resilience, called by dispatch-engine. |
| `worker-health.js` | `animastor:worker:heartbeat:*` → worker counts/status. |
| `gpu-dispatcher.js` (106) | `sendUnified` — backend→hub task POST. |
| `failure-taxonomy.js`, `retention-manager.js` | Error classification; journal trimming. |
| `runtime-persistence.js` (840) | **Dead code** — explicitly removed from `runtime/index.js` exports; snapshot/recovery (`initializeRuntime`) has **no production callers** (see `audit.md` §13). |

`runtime/index.js` uses a `lazyRequire` Proxy to delay module loading.

### 3.4 Storage (`backend/src/storage/`)

- `postgres/` — pool (`database.js`), `schema.js` (idempotent migrations), repositories (`scene-assets-repo`, `task-repo`, `iu-repo`, `book-repo`, `gen-session-repo`, `events-repo`, `chat-repo`, `book-source-repo`).
- `asset-registry.js` — **Redis** scene asset registry (`animastor:assets:{book}:{ch}:{sc}`).
- `filesystem-store.js` — path helpers for artifacts under `OUTPUT_DIR`.
- `services/scene-asset-registry.js` — **PG** scene asset registry (wraps `scene-assets-repo`).
- `services/book-sync.js` — PG↔filesystem consistency sync (marks stale, purges).
- `services/layer-config.js`, `services/gen-scope.js` — book layer config / generation scope (Redis).

### 3.5 Services (`backend/src/services/`)

AI agent pipeline (`agent/` — `pipeline-runner`, `pipeline-steps`, `bootstrap`, `unit-splitter`, `ai-caller`), `txt-importer`, `book-diff` (diff + dirty marking), `audio-orchestrator` + `video-orchestrator` (per-layer state machines), `placeholder-audio`, `generation-progress`, `progress-pubsub` (SSE), `cleanup-service`, `book-event-log`, `workflow-manager`, `ai-service`, `knowledge-base`, etc.

---

## 4. State Ownership

### 4.1 The three status layers — summary

There are **three independent status representations** for one scene asset, with different owners and semantics:

| # | Status | Store | Written by | Meaning | Verdict |
|---|---|---|---|---|---|
| 1 | `animastor:asset-state:*` (audio/image/video: `new|dirty|pending|generating|ready|failed|placeholder`) | Redis hash | **Orchestrator facade only** (+ whitelisted restore paths) | Runtime lifecycle state — *the* source of truth for the scheduler | **LIVE — canonical** |
| 2 | `scene_assets.status` (`pending|ready|stale|failed|missing|placeholder`) | PG | `scene-assets-repo` (via `completeStage`→`markReady`, `markDirtyScene`→`markStale`, `book-sync`) | Persistent file/metadata record ("path of truth for asset files") | **LIVE — persistent mirror** |
| 3 | `scenes.status` (`pending|generating|ready|failed|dirty`) | PG | **Nobody** — no `UPDATE scenes SET status` exists in the codebase | — | **FOSSIL** |
| 4 | `asset_states.status` (`clean|dirty|queued|generating|ready|failed`) | PG | **Nobody** — table is created but never written (only purged on book delete) | — | **FOSSIL** |

**Answer to the audit question "can they contradict each other?":** yes, by design and in practice — `scene_assets.status` and Redis asset-state can diverge after a crash between two writes (Redis write and PG write are not transactional). The system tolerates this: Redis state drives scheduling, PG `scene_assets` drives cache/versions, and reconciliation + the version-gate bridge them. `scenes.status`/`asset_states` cannot contradict anything because nobody writes them.

Detailed answers to the 10 questions: `audit.md` §7.

### 4.2 State ownership table

| State | Where | Writer | Reader | Source of truth | Recovery | Risk |
|---|---|---|---|---|---|---|
| Per-asset lifecycle (`audio/image/video`) | Redis `animastor:asset-state:{b}:{ch}:{sc}` | `orchestrator.*` (facade); restore whitelist (reconcile, scene-restoration, book-diff, redis-helpers, debug) | scheduler, dispatch-engine, callbacks, reconcile, routes | Redis (runtime) | startup reconcile C1/C1b, C2, D; version-gate | Low — single facade |
| Scene content/audio versions | PG `scenes.content_version`, `audio_config_version` | `book-diff` → `scene-assets-repo.bumpSceneVersions` | scheduler (`detectVersionStale`), `completeStage` version-gate, `getOutdatedByVersions` | PG | — (survives restart) | Low |
| Persistent dirty flag | PG `scenes.is_dirty` | `bumpSceneVersions` (TRUE), `clearDirtyFlag` (video callback / complete w/o video) | `getDirtyScenesByVersion` (book-sync) | PG | — | Low |
| Dirty units | PG `scenes.dirty_unit_ids` | `setDirtyUnitIds` | `executeImageDispatch`/`executeVideoDispatch` (`getDirtyUnitIds`) | PG | — | Low |
| Asset file record | PG `scene_assets` | `scene-assets-repo` (markReady/markStale/markFailed/upsert) | iu-processor (durations), versions-routes, book-sync, player-serving? | PG | markStale on dirty | Medium — mirror may lag |
| Asset registry (runtime) | Redis `animastor:assets:{b}:{ch}:{sc}` | callbacks (`registerScene*Redis`), reconcile | reconcile, routes | Redis | rebuilt from callbacks | Low |
| Active scenes (work list) | Redis `animastor:active-scenes` (set) | scheduler, orchestrator.resetScenes, scene-window, callbacks (remove on complete) | scheduler tick | Redis | startup: cleared by `initiateRecovery` (dead code); reconcile re-adds | **Medium** — if set is lost, generation stalls |
| Dispatch lease | Redis `animastor:dispatch-lease:{b}:{ch}:{sc}:{stage}` | dispatch-engine (NX EX, renewable) | dispatch-engine, reconcile | Redis | startup: **all leases deleted**; reconcile stale-lease check | Low — TTL bounds |
| Dispatch metadata + idempotency | Redis `dispatch-meta`, `dispatch-completed:{dispatchId}` | dispatch-engine | callbacks (`verifyDispatchIdentity`), finalize | Redis | TTL | Low |
| Active counters (quota) | Redis `animastor:runtime:active-{stage}` | dispatch-engine (Lua incr/decr) | dispatch-engine, runtime-metrics | Redis | startup reset to 0; counter-reconciliation | Low |
| Chunk metadata | Redis `animastor:chunk:{b}_{ch}_{sc}_{i}` | book-diff, task-handler, scene-window, callbacks | scheduler (`checkChunksHaveImages`), iu-processor, player | Redis | startup C0 (`recoverAllBooksFromDisk`), scene-restoration | Medium — Redis loss ⇒ chunk flags re-derived from disk |
| Audio-orch phase | Redis `animastor:audio-orch:{b}:{ch}:{sc}` | audio-orchestrator | executors, completeChunk, reconcile | Redis | startup C1, B1 watchdog | Low |
| Video-orch phase + groups | Redis `animastor:video-orch:{b}:{ch}:{sc}` | video-orchestrator | executors, completeGroup, reconcile | Redis | startup C1b, B2 watchdog | Low |
| Generation window progress | Redis `animastor:book-scenes:{b}:{total,next-index,window-start}` | scene-window | scene-window (slide) | Redis | derived from book scope | Medium |
| Generation cancel flag | Redis `animastor:generation:cancel:{b}` | cancel routes | scene-window, pipeline-runner | Redis | TTL | Low |
| GPU queue/processing/running | Redis `animastor:queue:{type}`, `animastor:processing`, `animastor:running` | gpu-hub | gpu-hub | Redis | hub timeout cleanup; `/queue/clear` | Low |
| Result/error transport | Redis `animastor:result:*`, `animastor:error:*` | gpu-hub | reconcileCycle Phase A | Redis (1 h TTL) | Phase A replay | Low |
| Worker registry | Redis `animastor:gpu-hub:workers`, `animastor:worker:heartbeat:*` | gpu-hub (beacon) | backend worker routes, hub | Redis | heartbeats (30 s) | Low |
| Event journal | Redis `animastor:event-journal:*` | journal (append) | debug, reconcile | Redis | TTL 7 d | Low |
| Book events | PG `book_events` | `events-repo` via `book-event-log` | routes, audit | PG | — | Low |
| Generation tasks (selective) | PG `generation_tasks` | `task-repo` (create/update/cancel) | scheduler (complete persist), routes | PG | — | Low |
| In-memory: lease renewal timers | process memory (`lease-manager`) | lease-manager | dispatch-engine | — | lost on restart (leases re-derived) | Low |
| In-memory: book cache / metrics history | process memory | runtime-loop | debug routes | — | — | Low |
| Frontend UI state | browser (signals + localStorage + sessionStorage + Cache API) | stores | components | backend (via API) | `restoreBookSession`, position restore | Low |

---

## 5. PostgreSQL — live vs fossil tables

### 5.1 Live (written/read by code)

| Table | Used for |
|---|---|
| `books` | Book registry (recent books, auth), `book-source-repo` |
| `book_snapshots` | Diff baseline (book-repo save/load history) |
| `scenes` | **Versions** (`content_version`, `audio_config_version`), `is_dirty`, `dirty_unit_ids`, build/scene_hash — *not* `status` |
| `scene_assets` | Asset file metadata + `status` (ready/stale/failed/placeholder), version columns |
| `generation_tasks` | Selective generation task registry + history |
| `image_units` | Per-IU metadata/timings (iu-repo) |
| `agent_sessions`, `agent_steps`, `agent_conversations`, `agent_messages` | Agent pipeline (bootstrap, agent-session) |
| `book_generation_sessions` | Window generation sessions (gen-session-repo, startup resume) |
| `book_events` | Persistent event log (events-repo) |
| `book_source` | TXT source hash → book_id |
| `chat_sessions`, `chat_messages`, `ai_chat_sessions` | AI chat |
| `character_resolution_runs`, `character_window_candidates`, `sentence_resolutions`, `character_mentions`, `character_aliases` | Coreference resolution |
| `users` | Schema only so far (auth surface minimal) |

### 5.2 Fossils (schema-defined, never written)

| Table | Evidence |
|---|---|
| `asset_states` | Only in `schema.js` + purge lists (`cache-routes.cjs`, `core-routes.cjs`); **0 INSERT/UPDATE** |
| `scenes.status` column | Constraint exists; **never explicitly set** — inserts (`ensureSceneRow`, `book-sync.js`) omit the column, so rows always carry only the DEFAULT `'pending'`; no code SELECTs it |
| `workers` | **0 INSERT/UPDATE/SELECT FROM workers** — worker state lives in Redis |
| `cache_entries` | Schema + purge only |
| `output_manifests` | Schema + purge only |
| `reconciliation_events` | Schema + purge only |
| `asset_dependencies` | Schema + purge only |
| `storyboard_elements` | Schema + purge + a mention in a chat prompt only |
| `audio_layers` | Schema + purge only |

---

## 6. Redis Key Inventory (verified)

Prefixes below were found via code search (`hget/hset/scan/get/set/incr/publish...`).

**State / lifecycle**
- `animastor:asset-state:{book}:{ch}:{sc}` — per-asset hash (SOURCE OF TRUTH)
- `animastor:active-scenes` — scheduler work set
- `animastor:chunk:{book}_{ch}_{sc}_{i}` + `animastor:chunks:{book}` — chunk metadata
- `animastor:audio-orch:{book}:{ch}:{sc}`, `animastor:video-orch:{book}:{ch}:{sc}` — layer state machines
- `animastor:assets:{book}:{ch}:{sc}` — Redis asset registry
- `animastor:layer-config:{book}` — layer toggles
- `animastor:book-scenes:{book}:total|next-index|window-start` — window progress
- `animastor:generation:cancel:{book}`, `animastor:force-dispatch:{book}`, `animastor:cancelled-workers:{book}`, `animastor:trigger_dedup:{book}`
- `animastor:iu-progress:{book}:{ch}:{sc}:image`, `animastor:iu-in-flight:*` — IU progress

**Dispatch**
- `animastor:dispatch-lease:{book}:{ch}:{sc}:{stage}` (NX EX, renewable)
- `animastor:dispatch-meta:{book}:{ch}:{sc}:{stage}`
- `animastor:dispatch-completed:{book}:{ch}:{sc}:{stage}:{dispatchId}` (idempotency marker)
- `animastor:runtime:active-{audio|image|video}` — quota counters
- `animastor:runtime:scheduler-lock`, `animastor:runtime:last-active:{stage}`
- `animastor:runtime:retry:*:count`, `animastor:runtime:retry:*` — retry budgets
- `animastor:cleanup-lock`, `animastor:regenerate-lock:{book}` — distributed locks

**GPU transport (hub)**
- `animastor:queue:{type}`, `animastor:processing`, `animastor:running`
- `animastor:job:{dispatch_id}:{job_id}` — enqueue dedup (1 h)
- `animastor:result:{build}:{book}:{ch}:{sc}:{type}` — 1 h result mailbox
- `animastor:error:{job_id}` — 1 h error mailbox
- `animastor:result-processed:{dispatch_id}:{job_id}:{build}` (backend, 1 h), `animastor:error-processed:...` (60 s)
- `animastor:gpu-hub:workers` (15 min), `animastor:worker:heartbeat:{type}:{worker}` (30 s)

**Observability**
- `animastor:event-journal:{book}:{ch}:{sc}` (7 d), `animastor:runtime:metrics:current`

**Legacy / fossils**
- `animastor:priority:queue` — only touched by dead `runtime-persistence` snapshot/restore; nothing enqueues
- `animastor:scene-transition-lock` — in config + reconcile LOCK_KEYS, no longer set anywhere
- `animastor:video-lock` — set only from the debug path (`debug-routes.cjs`); main path uses dispatch leases
- `animastor:audio-scene-lock` / `animastor:audio-merge-lock` — **still live** (audio generation / pipeline)
- `animastor:scene-heartbeat:*` — legacy heartbeat, only checked by reconcile stale-lock logic

---

## 7. Filesystem Layout

```
OUTPUT_DIR (/data/output)
└── {build_id}/
    ├── {book}_{ch}_{sc}.mp3                  merged scene audio
    ├── {book}_{ch}_{sc}_{0001..N}.mp3        audio chunks
    ├── {book}_{ch}_{sc}.mp4                  merged scene video (player)
    ├── {book}_{ch}_{sc}_g1..gN.mp4           video groups (kept for dirty regen)
    ├── {book}_{ch}_{sc}_{unitId}.png         IU images
    ├── {book}_{ch}_{sc}_pr{unitId}.png       previews
    └── ...

BOOKS_DIR (/data/books)
├── {book_id}/                                lazy-book multi-file JSON
└── {book_id}.snapshot.json
```

- **Who creates artifacts:** workers (via ComfyUI), then backend `task-handler` writes the base64 result to `OUTPUT_DIR/{build}`.
- **Who validates an artifact:** callbacks — `audio.isSceneAudioReady` (music-metadata), `image.resolveCanonicalSceneImage` + `getImageMetadata`, `video.validateVideoFile` (min 10 KB); video groups via `video-orchestrator.isGroupFileValid`.
- **Who deletes artifacts:** `orchestrator.resetScenes` (stale PNGs), `completeChunk` (empty <100 B chunks), video group re-gen (stale group files), `cleanup-service` (build dirs, TTL).
- **How FS participates in recovery:** `recoverAllBooksFromDisk` (startup C0), `scene-restoration.restoreChunkStatusForScene` (disk → Redis chunk flags), orphan checks in reconcile (READY state vs missing file), stalled-watchdog chunk/group counting.

---

## 8. Workers & GPU Hub

**Worker** (`worker/worker/worker.cjs`, 559 LOC): beacon every 10 s → poll `/task/next` → save input assets to ComfyUI input dir → `POST /prompt` → poll `/history` until output (per-job `timeout_ms` with video default 2 h) → read file from disk (OOM-safe) → `POST /task/result` (base64 data URL). Protocol v2 requires `dispatch_id`.

**GPU Hub** (`gpu-hub/gpu-hub.js`, 829 LOC):
- Registries/queues in Redis (see §6).
- 10 s interval: refresh heartbeats for running jobs; **per-job timeout** and **per-GPU timeout** → `notifyBackendError` (5 retries → fallback `animastor:error:{job}`).
- Result flow: store `animastor:result:*` → forward to backend `/gpu/task/result` with 5 retries (if backend down, result stays in Redis; reconcile Phase A replays).
- `DELETE /queue/clear` — scoped by `book_id`/`dispatch_id` (used by `resetScenes`).
- Hub is deliberately dumb: **no requeue** (backend scheduler owns retries).

---

## 9. Generation Lifecycle

### 9.1 Happy path (per layer)

```
Edit → PUT/POST → bookDiff.computeBookDiff → dirty_scenes[{dirty_layers}]
  → POST /regenerate → orchestrator.resetScenes
      (force-dispatch flag, clear leases, clear hub queues, delete stale PNGs,
       clear iu-progress, bookDiff.markDirtyScenes →
         bumpSceneVersions(PG) + Lua chunk reset + per-asset → PENDING,
       re-add to active-scenes)
  → runtime-loop tick (5 s)
  → runtime-scheduler.tick → attemptDispatch
      → detectVersionStale (PG) → markVersionStaleDirty (PG stale → DIRTY)
      → shouldScheduleAssets (pure decision; video waits for image=READY)
      → dispatch-engine.dispatchStage
          circuit-breaker → lease/duplicate check → quota (Lua) → retry budget
          → lease NX EX → dispatch-meta → orchestrator.dispatchStage(executor)
  → scene-orchestrator executor:
      per-asset → GENERATING (via facade), orch state machine transitions,
      gpu.sendUnified → hub POST /task (dedup) → queue → worker → ComfyUI
  → result → hub /task/result → (running check, result key) → backend /gpu/task/result
      (result-processed dedup) → taskHandler.handleTaskResult
      → verifyDispatchIdentity → write file → route by kind:
          audio_chunk → audioOrch.completeChunk (WAITING_CHUNKS → MERGING → DONE)
          scene_video → videoOrch.completeGroup (all groups → merge → DONE)
          iu_image → iu-progress incr → all IUs? → completeStage
  → orchestrator.completeStage:
      verifyDispatchIdentity → handler (artifact validation) → VERSION-GATE
      → PG scene_assets markReady → Redis asset-state READY → finalizeDispatch
  → video callback → clearDirtyFlag(PG) → remove from active index
  → trySlideWindowOnComplete (next window or generation_complete)
```

### 9.2 Failure path

```
worker error / hub timeout → hub notifyBackendError → backend /gpu/task/error
  (error-processed dedup) → orchestrator.failStage:
  validateAssetTransition(current→FAILED) → Redis FAILED → audio/video-orch FAILED
  → journal → finalizeDispatch('failure') → consumeRetryBudget
  → PENDING (redispatch, default)
  → scheduler re-dispatches (under circuit-breaker + retry budget)
```

### 9.3 Guards (all code-verified)

- **Duplicate prevention:** hub `animastor:job:{dispatch_id}:{job_id}` NX; backend `result-processed` NX; dispatch lease NX; `verifyDispatchIdentity` (stale/late callback rejection — with a deliberate exception: audio/video chunks accepted while scene is WAITING_CHUNKS/MERGING, see `task-handler.cjs`).
- **Idempotency:** `finalizeDispatch` Lua claim + `dispatch-completed` marker; `completeStage` returns early on rejected identity.
- **Retries:** dispatch-level retry budget (`retry-budget-manager`); failStage → PENDING re-dispatch; merge retries inside `completeChunk`/`completeGroup` (stale-accept of late chunks/groups).
- **Cancellation:** `/cancel-generation`, `/cancel-worker`; `clearLeasesForScenes` + `clearHubDispatches`; `animastor:generation:cancel:*` honored by scene-window and pipeline-runner.
- **Dirty regeneration:** per-unit via PG `dirty_unit_ids` (image + video groups), per-layer via `markDirtyScene`, version-stale via PG versions.

---

## 10. Recovery

Two execution contexts must not be confused:

### 10.1 Startup (backend.cjs + `reconcileCycle(startup: true)`)

1. `runtime.loop.start` → first tick;
2. reconcileCycle with phases:
   - **A** — replay `animastor:result:*`/`animastor:error:*` mailboxes (callbacks that never reached the backend);
   - **B1/B2** — stalled audio-chunk / video-group watchdogs;
   - **C0** — `recoverAllBooksFromDisk` (rebuild chunk flags from disk);
   - **C1/C1b** — audio-orch/video-orch non-terminal states → FAILED (or drive merge when chunks/groups are complete on disk);
   - **C2** — PG version staleness;
   - **C4** — missing scene counters; **C5** — `resumeIncompleteSessions` (PG `book_generation_sessions`);
   - **D** — full scene reconcile + auto-fix of safe issues;
3. standalone: genScope migration, reset active counters, **delete all dispatch leases**, counter reconciliation.

### 10.2 Periodic (every 60 s)

`reconcileCycle(startup: false)` under distributed `animastor:cleanup-lock` — phases A, B1/B2, D. Non-overlapping (lock + `reconcileInProgress` flag).

### 10.3 Auto-fix actions (Phase D, `safeToExecute`)

`MOVE_TO_PENDING` (→ `markDirtyScene`), `RELEASE_STALE_LOCKS`, `RELEASE_STALE_LEASE`, `REGENERATE_MISSING_ASSET` (→ `setScenePending`), `PROGRESS_TO_IMAGE/VIDEO`, `RECONCILE_COUNTER_DRIFT`, `RECOVER_ORPHAN_ASSETS`.

### 10.4 Can recovery conflict with normal execution?

Mostly **no**, by construction:
- All writes go through the orchestrator facade (`markDirtyScene`, `setScenePending`, `failStage`) — the same path as normal execution; `validateAssetTransition` guards invalid transitions (a late error after READY is logged, not applied).
- `finalizeDispatch` claim is atomic (Lua) — recovery and callback cannot both finalize.
- **Residual risk:** `recoverAudioOrchStates`/`recoverVideoOrchStates` call `state.unsafeRestoreAssetState` directly (whitelisted), and Phase D auto-fix runs while the scheduler may be dispatching the same scene — mitigated by per-asset transition validation, but both can race within a tick window (low probability, bounded harm: a re-dispatch is at worst wasted).

### 10.5 Crash-between-two-writes

Example: callback → PG `markReady` succeeded → Redis `READY` write failed. Result: PG says ready, Redis says generating. Consequences: scheduler may re-dispatch (duplicate work) or `shouldScheduleAssets` sees GENERATING and waits; reconcile D checks `scene_assets`/disk and version-gate on next completion resolves. No corruption — at worst wasted GPU work. The inverse (Redis READY but PG stale) is caught by `detectVersionStale` → re-dirty.

---

## 11. Dependency Directions

```
routes ──▶ services / orchestration / runtime / storage
backend.cjs ──▶ everything (DI composition)
runtime-scheduler ──▶ dispatch-engine ──▶ orchestration (executors)
orchestration ──(lazy)──▶ runtime-scheduler / dispatch-engine   ◀── CYCLE (mitigated by lazy require)
callbacks ──▶ orchestrator facade ──▶ state + scene-assets-repo
audio-orchestrator / video-orchestrator ──▶ orchestrator facade
reconciliation-engine ──▶ orchestrator facade, dispatch-engine, storage
storage ──▶ postgres repositories / redis helpers  (no upward deps)
```

**Known cycles** (verified): `dispatch-engine ⇄ orchestration` and `runtime-scheduler ⇄ orchestration` — all crossings are **function-body lazy `require()`** (see `orchestrator.js` header comment), so the cycles are harmless at load time but are real architectural coupling at runtime. Full details in `audit.md` §9.

---

## 12. Confirmed strengths (do not break)

1. **Orchestrator facade** — a single owner of lifecycle state writes; the rest of the system (callbacks, watchdogs, reconcile) routes through it.
2. **Pure decision vs mutation split** — `shouldScheduleAssets` is pure; version-stale reset is a separate explicit pre-pass (`detectVersionStale`/`markVersionStaleDirty`).
3. **Per-asset state machine with transition validation** — invalid transitions are rejected with journal entries.
4. **Atomic Redis primitives** — Lua quota acquire, Lua finalization claim, NX leases, HSET per-field updates (replaced the former GET+merge+SET RMW).
5. **Dispatch identity + idempotency markers** — stale/late callbacks are rejected; double-finalize is impossible.
6. **Separation of GPU transport (hub) from scheduling (backend)** — hub is dumb, scheduler owns retries.
7. **Audio/video orchestration state machines** — `WAITING_CHUNKS → MERGING → DONE` with late-chunk recovery and stalled watchdogs; video groups preserved for granular dirty regen.
8. **Unified reconciliation cycle** — one `reconcileCycle` replaced four competing recovery mechanisms (startup-recovery, audio-recovery, cleanup-service, reconcileAll), with a distributed lock.
9. **Version-based staleness in PG** — `content_version`/`audio_config_version` survive Redis loss; version-gate fail-closed before `READY`.
10. **Persistent dirty flags** (`scenes.is_dirty`, `dirty_unit_ids`) — survive Redis crashes.
11. **Graceful shutdown** — cancels active dispatches so leases/quota don't leak.
