# 01. System Map — Animastor

> Map of the current system layout. Description of the "as-is" state only.
> Date: 2026-07-06. Based on source code reading (not just documentation).
> Section 9 specifically notes where documentation diverges from code.
>
> **Source:** Original analysis `docs-claude/01_System_Map.md`.
> **Status:** Current as of 2026-07-06.
> Updates:
> - Agent pipeline: enrichment step removed (enrichment moved to stepCreateScenes), coreference removed, unit.participants removed.
> - Storage: locations.json, voices.json, bible.country/epoch.
> - Book structure: agent-service.js decomposed into submodules in `agent/`.

---

## 1. Project Purpose

Animastor is a platform that transforms text books into animated multimedia format: audio narration (TTS), images per frame, and video.

Full pipeline:

```
TXT / VBook  →  AI analysis (agent)  →  book structure (chapters/scenes/characters/locations/frames)
             →  asset generation (audio → image → video) on GPU
             →  playback in Android application
```

Additionally, there is an AI chat assistant (tool-based) for book editing.

The primary client is the Android application (Kotlin). Backend is the single orchestrator server. Generation is offloaded to separate GPU workers via an intermediate GPU Hub.

---

## 2. Main Subsystems

Deployment (`docker-compose.yml`): `postgres` (PG 16), `redis` (7, persisted volume), `backend`, `gpu-hub`, `nginx`. GPU workers run separately (not in compose) and communicate with GPU Hub via HTTP.

| Subsystem | Location | Role |
|---|---|---|
| **Backend / API** | `backend/src/backend.cjs` + `routes/*` | Express server, DI for all services, REST API, generation orchestration, startup-resume/recovery. |
| **Orchestration / Runtime** | `backend/src/runtime/*`, `backend/src/orchestration/*` | Tick-based scheduler (5s), dispatch engine (lease/quota), scene orchestrator + callbacks, scene window. |
| **Agent Service (AI Pipeline)** | `backend/src/services/agent-service.js` + `agent/` | Pipeline decomposed into submodules: bootstrap, pipeline-runner, pipeline-steps, coreference (stub). |
| **AI Chat** | `backend/src/services/chat-engine.cjs` | Tool-based assistant (chat/edit/director/import modes). |
| **Generators** | `backend/src/{audio,image,video}/*` | ComfyUI workflow assembly and task submission to GPU. |
| **Workflow / Connector Layer** | `backend/src/workflows/*`, `services/workflow-manager.js`, `backend/ai/workflows/`, `backend/ai/connectors/` | Loading and adapting ComfyUI JSON templates; connectors as declarative task descriptions. |
| **GPU Hub** | `gpu-hub/gpu-hub.js` | Task queues in Redis, worker distribution, requeue on timeout, result delivery to backend. |
| **GPU Worker** | `worker/worker/worker.cjs` | CJS worker (Node 20+ with global fetch): polling Hub → ComfyUI → result (base64 / filesystem fallback). PW-2: private worker mode, PW-4: FAIL CLOSED. |
| **Storage** | `backend/src/storage/*`, `book/*` | PostgreSQL (30+ tables), Redis (runtime), filesystem (multi-file books, assets). |
| **Frontend (Web)** | `frontends/app/` (Preact + Vite) | Responsive SPA: MobileShell / DesktopShell; pages: File, Generator, Player, Editor, Navigator, Settings. |
| **Frontend (Android)** | `frontends/android/` (Kotlin) | Single-activity, bottom navigation: files/library/editor/player/navigation/AI/settings. |
| **Auth & Identity** | `backend/src/auth/`, `backend/src/middleware/` | Authentication MVP: register/login/logout, session cookies, guest workspaces, workspace ownership, book access guards. |
| **Worker Auth** | `backend/src/services/worker-auth.js`, `worker-repo.js` | FAIL CLOSED credential model: `wrk.*` tokens, Redis mirror, PG authoritative. Private/Share/System modes (PW-4). |
| **Admin System** | `backend/src/routes/admin-routes.cjs`, `services/system-ai.js` | Platform-level admin: AI kill switch, system provider, requireAdmin guard. |
| **Workspace AI Provider** | `backend/src/services/workspace-ai-provider.js` | Per-workspace AI provider (AES-256-GCM encrypted keys), connection testing, fallback chain. |
| **Audio/Video Orchestrators** | `services/audio-orchestrator.js`, `services/video-orchestrator.js` | Phase machines for merge orchestration (WAITING_CHUNKS → MERGING → DONE). |
| **Entity Cleanup** | `services/entity-cleanup.cjs` | Deep cleanup across PG/Redis/FS/GPU-hub for scene/unit deletion. |
| **Metrics** | `backend/src/metrics/prometheus` | Prometheus metrics endpoint (`/metrics`). |

**Subsystems underrepresented in overview documentation but present in code:**
- **Connectors** — `connector-loader.js`, `routes/connector-routes.cjs`, `backend/ai/connectors/conn-*.json`. Declarative generation task description layer.
- **Workflow Manager** — `services/workflow-manager.js`, `routes/workflow-routes.cjs`.
- **Startup Recovery** — `services/startup-recovery.js` — State recovery from PG/disk on startup.
- **Prompt Profile Loader** — `services/prompt-profile-loader.js` — Model-specific prompting rules from `backend/ai/skills/`.
- **Profile Override** — `services/profile-override.js` — User-selected prompt profile per type (global, Redis-persisted).
- **Progress Pub/Sub** — `services/progress-pubsub.cjs` — Redis pub/sub for real-time SSE progress push.
- **Generation Progress** — `services/generation-progress.js` — Independent generation task registry (per command).
- **URL Safety** — `services/url-safety.js` — SSRF guard for workspace provider endpoints.
- **Language Detector** — `services/language-detector.js` — Text language detection.

---

## 3. Generation Lifecycle

### 3.1 Import and AI Analysis

1. **Import** — `POST /api/v1/book/import-txt`. `txt-importer` decodes the buffer (UTF-8/CP1251), `lazy-book.createDraftBook()` creates the `data/books/<bookId>/` directory and draft book; source is registered in PG (`book_source`).
2. **Bootstrap** — `POST /api/v1/book/:id/bootstrap`. `agent-service.bootstrapWithAgent()` runs:
   - **Step 0** `stepAnalyzeStructure` — extracts author, title, chapters from the first ~80 lines (separate, before pipeline).
   - **runPipeline** on the text buffer (`MAX_WINDOW_CHARS=1500`, `MAX_SCENES_PER_CHUNK=3`):
     - Step 1 `stepExtractCharacters` → characters
     - Step 2 `stepExtractLocations` → locations
     - Step 3 `stepCreateScenes` → up to 3 scenes from the beginning of the buffer
       (title + location.id + environment-override: scene overrides the global location template per field)
     - `resolveSceneProgress` → `nextOffset` from the last created scene
     - Step 4 `stepCreateUnits` (per-scene) → visual units (IU/frames)
     - Step 5 `stepCreateVisuals` (per-scene) → visual prompts for frames
   - Results are saved to PG (`agent_sessions`, `agent_steps`, `agent_conversations`, `agent_messages`) and to book files (`chapters/*.json`, `characters.json`, `bible.json`, `locations.json`, `voices.json`).
   - If a "tail" remains after `nextOffset` → session is `paused`, the next window is processed by `bootstrapNextWindow()` (background window generation, `window-generator.cjs`).

AI provider: configured via `AI_API_BASE_URL` (default: OpenRouter, in docker-compose: aicredits.in).
Default model: `qwen3-32b`. Single key: `OPENROUTER_API_KEY`.
Model JSON responses are stripped of CoT (`<think>`/`<reasoning>`) before parsing (`ai-service.parseJsonResponse`).

### 3.2 Asset Generation (Per-Asset Parallel Dispatch)

The scene's linear FSM **has been removed** (v2.1.0); the canonical source of truth is independent per-asset states `audio` / `image` / `video`:

```
NEW → DIRTY → PENDING → GENERATING → READY | FAILED | PLACEHOLDER
```

Cycle (every 5 seconds, `runtime-scheduler.SCHEDULER_TICK_MS = 5000`):

1. **Scheduler tick** — retrieves active scenes from Redis; for each scene, `shouldScheduleAssets()` decides based on per-asset state + layer-config which stages are ready:
   - audio and image are dispatched **independently** (in parallel);
   - video is added only when `image=READY` (functional dependency: video is assembled from IU images).
2. **Dispatch engine** — `dispatchStage()`: checks circuit-breaker → duplicate/lease → quota (backpressure) → retry-budget → fairness → acquires lease (NX, TTL) → calls orchestrator with `overrideStage`.
   - Quotas (`QUOTAS`): audio 3, image 2, video 1.
   - Lease TTL (actual in `dispatch-engine.js`): audio 15 min, image 20 min, video 30 min.
3. **Scene orchestrator** — `executeAudio/Image/VideoDispatch()`: per-asset validation, version-stale check against PG, builds the task in the corresponding service, `gpu.send()/sendUnified()`.
4. **GPU Hub → Worker → ComfyUI** — task is placed in Redis queue, worker picks it up, runs ComfyUI, returns the result.
5. **Callback** — GPU Hub sends `POST /gpu/task/result` → `task-handler.cjs` → routes by asset type:
   - `iu_image` — registers IU, checks PG for completeness of all scene IUs → `handleImageCompleted`;
   - `audio_chunk` — merges chunks (ffmpeg) when all are present → `handleAudioCompleted`;
   - `scene_video` → `handleVideoCompleted` (video merge + audio muxing).
6. **Completion** — per-asset state → READY; when `video=READY` the scene is removed from the active index, `trySlideWindowOnComplete()` advances the generation window to the next scenes.

### 3.3 Playback

The Android player (`PlaybackViewModel` + `SceneAudioPlayer` on ExoPlayer/Media3) fetches scene chunks/assets via REST, preloads 3 scenes ahead, and polls for video readiness.

---

## 4. Data Storage Architecture

Truth is intentionally split across three stores (this is explicitly documented in both code and documentation):

### 4.1 PostgreSQL — "what must not be lost"

30+ tables (`storage/postgres/schema.js`). Key groups:
- **Book/structure:** `books`, `book_snapshots`, `scenes`, `image_units`, `storyboard_elements`, `audio_layers`, `book_source`.
- **Generation state:** `scene_assets` (status: pending/ready/stale/failed/missing/placeholder + versions `scene_content_version`, `scene_audio_config_version`), `asset_states`, `asset_dependencies`, `generation_tasks`, `output_manifests`, `book_generation_sessions`, `workers`, `reconciliation_events`.
- **AI agent:** `agent_sessions`, `agent_steps`, `agent_conversations`, `agent_messages`.
- **Chat:** `chat_sessions`, `chat_messages`, `ai_chat_sessions`.
- **Other:** `users`, `cache_entries`, `book_events`.

### 4.2 Redis — runtime state (persisted via volume)

~30+ key families under the `animastor:` prefix. Key ones:
- GPU queues: `animastor:queue:{audio|image|video}`, `animastor:running`, `animastor:result:*`, dedup `animastor:job:*`.
- Scene state: `animastor:asset-state:*` (per-asset, canonical, HASH), `animastor:iu-progress:*`, `animastor:chunk:*`, `animastor:chunks:*`.
- Dispatch/coordination: `animastor:dispatch-lease:*`, `animastor:dispatch-completed:*`, `animastor:runtime:*`, `animastor:*-lock:*`, `animastor:worker:heartbeat:*`.
- Config/scope: `animastor:layer-config:*`, `animastor:gen-scope:*`, `animastor:active-scenes`.

### 4.3 Filesystem

- **Books (multi-file, v2.2):** `data/books/<bookId>/` → `manifest.json`, `book.json`, `bible.json`, `characters.json`, `locations.json`, `voices.json`, `chapters/<chapterId>.json` (plus `source.txt` for draft).
  - `locations.json` — all locations (separate from bible)
  - `voices.json` — all character voices (separate from bible)
  - `bible.json` — includes `country` and `epoch` for image prompts
- **Assets:** `data/output/<buildId>/` → `*.mp3`, `*.png`, `*.mp4`.
- **Templates:** `backend/ai/workflows/*.json` (ComfyUI), `backend/ai/connectors/conn-*.json` (task declarations).

### 4.4 Responsibility Model (factual)

- **PG** — facts: versions, asset statuses, dirty flags, book structure, agent/chat history.
- **Redis** — derived/fast cache: progress, queues, leases, per-asset state (mirrors `scene_assets.status`).
- **Files** — result artifacts; in some cases **also influenced decisions** — this is a known source-of-truth blurring point, addressed in M3 (disk is fact, not decision).

---

## 5. UI / Backend / GPU Worker / DB Interaction

```
┌──────────┐   HTTPS    ┌─────────┐   /api/ → backend:3000
│ Android  │──────────► │  nginx  │
│  (Kotlin)│            │ (proxy) │   /gpu/ → gpu-hub:5000
└──────────┘            └────┬────┘
                             │
              ┌──────────────┴───────────────┐
              ▼                               ▼
        ┌───────────┐  tasks (HTTP POST)  ┌─────────┐  Redis queue  ┌─────────┐
        │  Backend  │ ───────────────────► │ GPU Hub │ ────────────► │ Worker  │
        │  :3000    │ ◄─────────────────── │  :5000  │ ◄──────────── │ ComfyUI │
        └─────┬─────┘  result (callback)  └────┬────┘   poll/result └─────────┘
              │                                 │
       ┌──────┼─────────────┐                   │
       ▼      ▼             ▼                   ▼
   PostgreSQL Redis   Filesystem            Redis (shared)
   (facts)    (runtime) (artifacts)
```

---

## 6. Redis, Queues, and Background Processes

### 6.1 Redis Purpose

Redis serves three roles simultaneously:
1. **GPU Queue Broker** — `animastor:queue:{type}` lists, task dedup `animastor:job:*` (`SET NX EX 3600`), result storage `animastor:result:*`.
2. **Orchestration Runtime State** — per-asset states (HASH), leases, backpressure counters, active scenes, progress chunks, worker heartbeats.
3. **Coordination (distributed locks)** — scheduler-tick lock, cleanup lock, audio/video merge locks.

### 6.2 GPU Hub Queues

- Three independent queues: `audio`, `image`, `video`.
- `GPU_TIMEOUT = 600000` (10 min): if a worker hasn't returned a result, the task is **requeued** to its queue.
- `DELETE /queue/clear?book_id=` — targeted queue cleanup by book.

### 6.3 Backend Background Processes

- **Runtime loop / scheduler tick** — every 5 seconds; the main progress engine.
- **Cleanup service** — periodic cleanup of stale locks, build lifecycle.
- **Window generator** — background processing of the next AI analysis window.
- **Startup resume** — recovery of interrupted sessions on startup.
- **Startup recovery** — Redis state recovery from PG (now logs only, does not fix — R1.1).

---

## 7. Documentation vs. Code Discrepancies (at time of composition)

| # | Claim in `docs/` | Actual in code | Location |
|---|---|---|---|
| 7.1 | Rate limiting **100 req/min** | **500 req/min** | `backend.cjs:63-68` |
| 7.2 | Lease TTL: audio **30min**, image **60min**, video **120min** | audio **15min**, image **20min**, video **30min** | `dispatch-engine.js:43-47` |
| 7.3 | `gpu-dispatcher` has `sendVideo` | No such method | `gpu-dispatcher.js:56` |
| 7.4 | All 6 governance modules are **dead code** | 3 are alive (`circuit-breaker`, `retry-budget`, `fairness`), 3 deleted | `dispatch-engine.js` |
| 7.5 | `scene-orchestrator.js` is **~1200 lines** | **~173 lines** (facade) | `orchestration/*` |
| 7.6 | Route files: **4** | **11+**: auth, worker, admin, settings-ai, config + book/ decomposition (17 submodules) | `routes/` |
| 7.7 | Frontend in `frontend/app/...` (Kotlin) | Android in `frontends/android/`, Web in `frontends/app/` (Preact + Vite) | `frontends/` |
| 7.8 | 10 repositories | 15+ repositories: +user, workspace, session, guest, worker, generation-cancel | `repositories/` |

> **Note:** Discrepancies 7.1–7.6 have been corrected in updated document versions (June 2026).

### 7.7 Recent Changes (July–August 2026)

| # | Actual in code |
|---|---|
| 7.7.1 | Agent pipeline: separate `stepEnrichScenes` step removed — title/location.id/environment-override generated by `stepCreateScenes` |
| 7.7.2 | `unit.participants` removed from the entire system |
| 7.7.3 | `coreference.js` — stub, step removed from pipeline |
| 7.7.4 | `character_anchors` removed — positions in visual.prompt |
| 7.7.5 | agent-service.js decomposed into submodules in `backend/src/services/agent/` |
| 7.7.6 | Books store `locations.json` and `voices.json` separately from bible |
| 7.7.7 | `bible.json` includes `country` and `epoch` |
| 7.7.8 | `AI_API_BASE_URL` configurable (default: OpenRouter, model: qwen3-32b) |
| 7.7.9 | **Auth system** (August 2026): register/login/logout, session cookies, guest workspaces, workspace ownership — fully implemented |
| 7.7.10 | **Worker auth** (PW-1/2/4): `wrk.*` credential model, private/share/system modes, Redis mirror, PG authoritative |
| 7.7.11 | **Admin system** (August 2026): AI kill switch, system provider, requireAdmin guard |
| 7.7.12 | **Workspace AI provider** (August 2026): per-workspace encrypted keys, AES-256-GCM, connection testing |
| 7.7.13 | **Audio/Video orchestrators** (August 2026): phase machines for merge orchestration (WAITING_CHUNKS → MERGING → DONE) |
| 7.7.14 | **Entity cleanup** (August 2026): deep cleanup across PG/Redis/FS/GPU-hub on scene/unit deletion |
| 7.7.15 | **Book routes decomposition**: 17 submodules in `routes/book/` |
| 7.7.16 | **PW-4 (Fail-closed worker model)**: mode='system' workspace-less, workers_scope_check constraint |

---

## 8. Current Architecture Highlights

### 8.1 Per-Asset State — The Single Source of Truth (T8 + Dead Code Cleanup, July 2026)

**Linear state (`SceneState` / `animastor:scene-state:*`) has been completely removed.**
Per-asset states (`animastor:asset-state:*`, HSET with fields `audio`/`image`/`video`) are the **only** runtime source of truth.

### 8.2 Orchestrator Facade (T3–T7, June–July 2026)

All 8+ per-asset state writers have been consolidated into a single facade `orchestrator.js` (11 commands). The single arbiter of lifecycle state writes.

### 8.3 Governance

`circuit-breaker`, `retry-budget`, `fairness` — LIVE. `policy-engine`/`workload-classifier`/`cost-estimator` — deleted.

### 8.4 Auth & Identity (August 2026)

Full authentication system: register/login/logout (auth-service.js), server-side sessions in PG, guest workspaces with TTL, workspace ownership (workspace-ownership.js), book access guards (requireBookAccess). Cookie-based: `animastor_sid` (user), `animastor_gid` (guest). Cross-subdomain via COOKIE_DOMAIN.

### 8.5 Worker Identity Model (PW-1/2/4, August 2026)

Three worker modes:
- **private** — workspace-owned, serves only that workspace
- **share** — workspace-owned, volunteered to community pool
- **system** — Animastor-operated, workspace-less (admin-only creation)

FAIL CLOSED: `workers_scope_check` CHECK constraint — mode ≠ system → workspace_id NOT NULL.

### 8.6 Audio/Video Merge Orchestrators (August 2026)

Separate state machines for audio/video merge orchestration. Solves race condition issues with parallel chunk/group arrivals.

---

*End of map. Current state as of 2026-08-24 (documentation audit).*
