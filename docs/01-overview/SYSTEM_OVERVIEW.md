# System Overview: Animastor

## Project Purpose

Animastor is an AI-powered animated storytelling platform. The system transforms text books into a multimedia experience with audio narration, images, and video. The project implements a pipeline from text import to animated video generation.

## Main Use Cases

1. **Book Import** — User uploads a TXT file or enters text; the system uses AI agents to analyze structure, extract characters, locations, and scenes.
2. **Viewing and Editing** — User views the book structure (chapters, scenes), edits metadata, characters, locations.
3. **Multimedia Generation** — The system sequentially generates audio (TTS), images, and video for each scene.
4. **Playback** — Android application plays back generated content (audio + video) with scene navigation.
5. **AI Assistant** — Chat with an AI model for help with writing and editing.

## Problems Solved by the System

- Extracting structure from unformatted text (chapters, scenes).
- Identifying and characterizing characters and locations via AI.
- Splitting narrative into visual units (frames/IU).
- Generating TTS audio with dialog support (different voices).
- Generating images for each visual unit.
- Generating video by animating image sequences (LTX).
- Orchestrating the generation pipeline with state control, queues, and retries.
- Managing book lifecycle: import → AI analysis → generation → playback.

## Key Subsystems

### Backend (Node.js/Express)
Central API server + orchestrator. Manages book state, scenes, and GPU task dispatching.
- **State Model (Per-Asset):** per-asset states (audio/image/video) — the canonical source of truth. Linear FSM and SceneState enum were removed in v2.2.0/T8 (blocked parallel dispatch). Per-asset states stored as Redis HASH (HSET/HGETALL) — atomic per-field operations, no RMW race.
- **Orchestrator Facade (M5):** Single arbiter of state — 11 commands (markDirty, markDirtyScene, planScene, beginStage, completeStage, completeStageWithoutVideo, completeStageWithoutImage, setScenePending, setSceneAllReady, setScenePlaceholder, reconcile). All lifecycle state writers go through the facade.
- **Version Gate:** `completeStage` checks PG version before READY — stale GPU callbacks don't cancel force-regen.
- **Atomic Quotas:** Lua EVAL for atomic quota acquire — eliminates race condition between checkQuota (GET) and incrementActiveCounter (INCR).
- **Idempotent Completion:** markDispatchCompleted protected by SET NX on dispatch-token — duplicate callbacks are harmless.
- **Governance:** circuit-breaker, retry-budget-manager, fairness-engine — LIVE, directly require()'d in dispatch engine. Policy-engine/workload-classifier/cost-estimator — removed from exports (dead code).
- **Helmet.js** — HTTP security headers (HSTS, CSP, X-Frame-Options)
- **Rate limiting** — 500 req/min on `/api/`, overload protection
- **Request ID** — each HTTP request gets a short ID for log tracing
- **Graceful shutdown (SIGTERM)** — HTTP server → Redis → PostgreSQL sequential shutdown
- **Startup resume** — recovery of interrupted generation sessions on startup

### Frontend (Web + Android)
- **Web (Preact + Vite):** Responsive SPA (`frontends/app/`): MobileShell (<1180px) / DesktopShell (≥1180px). Pages: File, Generator, Player, Editor, Navigator, Settings.
- **Android (Kotlin):** Single-activity with bottom navigation: files/library/editor/player/navigation/AI/settings (`frontends/android/`).

### Auth & Identity (August 2026)
- **Authentication MVP:** register/login/logout (auth-service.js), server-side sessions in PG (token-hash-only), scrypt passwords.
- **Guest Workspace:** anonymous user → temporary workspace (TTL 7 + grace 23 days). Cookie `animastor_gid`.
- **Session cookie:** `animastor_sid` (HttpOnly, 30 days). Cross-subdomain via COOKIE_DOMAIN=animastor.in.
- **Workspace ownership:** `resolveWorkspaceForBook` — single point of resolution. Books linked to workspace via books.workspace_id.
- **Book access guards:** `requireBookAccess` — workspace membership check on all book-keyed endpoints.
- **Guest→User conversion:** on register with live guest cookie — workspace conversion in-place.

### Worker Auth (PW-1/2/4, August 2026)
- **FAIL CLOSED credential model:** `wrk.<worker_id>.<secret>` → worker identity. Malformed/unknown/revoked → 401.
- **PG authoritative:** `workers` table — durable source of truth. Redis mirror `animastor:worker-auth` — hot path for GPU Hub.
- **Three modes:** private (workspace-owned), share (workspace-owned, community pool), system (Animastor-operated, workspace-less).
- **workers_scope_check:** CHECK constraint — mode ≠ system → workspace_id NOT NULL.
- **Worker routes:** POST /api/v1/worker/verify, POST/GET/GET/:id/POST/:id/rotate/DELETE /api/v1/workers (user-only, workspace-scoped). PW-4: mode support (private/share), confirm_share for share.
- **GPU Hub auth:** Bearer token via Redis mirror; workspace-scoped queues.

### Admin System (August 2026)
- **Admin routes:** /api/v1/admin/system-ai (kill switch + system provider) + /api/v1/admin/workers/system (SYSTEM worker registry: create/list/rotate/revoke).
- **Guard:** requireAdmin (role='admin' OR ADMIN_USERNAMES allowlist). Second layer: nginx Basic Auth on admin.animastor.in.
- **System AI control:** kill switch + system provider (admin-configured endpoint/key/model).

### Workspace AI Provider (August 2026)
- **Per-workspace AI provider:** one active provider per workspace.
- **AES-256-GCM encryption:** API keys stored in PG encrypted (WORKSPACE_SECRET_KEY).
- **Resolver chain:** workspace row → system fallback (kill switch enforced) → noProvider().
- **Connection testing:** /api/v1/settings/ai/test (does not persist key).
- **SSRF guard:** endpoint validation (safeFetch) on all user-controlled endpoints.

### Orchestration Layer
Five components:
1. **Runtime Scheduler** (tick-based, 5s) — pure function `shouldScheduleAssets()`, decides what to generate but does NOT write state (D.2). Version-stale reset — explicit pre-pass in `attemptDispatch()`.
2. **Dispatch Engine** — lease mechanism (NX TTL), quota control (Lua-atomic), governance (circuit-breaker/retry-budget/fairness).
3. **Orchestrator Facade** (`orchestrator.js`) — single API for lifecycle state writes. 11 commands, all write per-asset state. syncLinearState removed (T8) — per-asset is the only source of truth.
4. **Scene Orchestrator** (`scene-orchestrator.js`) — dispatch execution (audio/image/video), pure executor without state decisions.
5. **Scene Window** — window manager, scope-aware, all writes through facade.

### Agent Service (AI Pipeline)
6-step AI text analysis pipeline (step 0 + 5 steps):
structure → characters → locations → scenes (title + location.id + environment-override) → units → visual prompts.

Key behavior (2026-07-02):
- Backend takes a 1500-character text buffer from `currentOffset`.
- AI creates up to 3 scenes from the beginning of the buffer and may leave a tail unused.
- Backend validates literal continuous coverage of the created prefix.
- `currentOffset` advances to `nextOffset` of the last created scene, not the buffer end.
- Scene duration: target ~20s, soft ceiling ~30s with one repair retry.

### GPU Hub (Node.js)
Central GPU task dispatcher. Receives tasks from backend, queues in Redis, distributes to workers. Graceful shutdown, requeue on timeout (10 min), heartbeat, per-book queue clear.

### Workers (Node.js + ComfyUI)
GPU workers (CJS module `worker.cjs`, Node 20+ with global fetch) performing generation via ComfyUI: image (SD), audio (TTS), video (LTX). Multi-image asset support. PW-2: private worker mode (`ANIMASTOR_WORKER_TOKEN=wrk.*` → Bearer credential), workspace-scoped queues. PW-4: FAIL CLOSED — missing credential → 401, no uncredentialed lane.

### Workflow Loader + Connector System
- **Workflow Loader** — loads ComfyUI JSON templates from `/app/ai/workflows/`
- **Connector System** — declarative abstraction layer, external nodeId → entity map. Files in `/app/ai/connectors/`. Eliminates hardcoded node IDs from backend code.
- **Entity Schema** (`entity-schema.js`) — all data types exchanged between backend and ComfyUI

### Storage
- **PostgreSQL (30+ tables)** — canonical state (books, scenes, assets, chats, events, agent sessions, image_units, scene_assets, cache_entries, generation_tasks, output_manifests, workers). Repositories: `storage/postgres/repositories/` (15+ repositories: book, cache, task, iu, sceneAssets, chat, chatSession, events, genSession, bookSource, user, workspace, session, guest, worker, generation-cancel).
- **Redis (persisted)** — runtime state: asset-state (HASH — canonical per-asset state), worker-auth (HASH — auth mirror for GPU Hub), worker heartbeat (STRING JSON — liveness + scope), active-scenes (SET), GPU queues (LIST: system pool + workspace-scoped), dispatch lease (SET NX TTL), dispatch-completed marker (NX), quotas (counter), event journal (List, TTL 7d), chunks, iu-progress, iu-in-flight.
- **Filesystem (multi-file)** — book files (JSON, multi-file format), audio (MP3), images (PNG), video (MP4)

### Services Layer
15+ services: Audio/Image/Video Service, Agent Service, TXT Importer, Chat Engine, Gen Scope, Layer Config, Book Source/Sync/Integrity, Scene Asset Registry, Book Event Log, Chat Store, Cleanup Service, Audio Recovery, Placeholder Audio, AI Loader, Knowledge Base, Waveform Service, Window Generator, Startup Resume, Book Diff, Workflow Manager.

### AI Knowledge Base
Markdown rule files, skills, and JSON examples for AI model prompting. **Not used in prompts** of the main pipeline (except refineDraft, which uses examples).

## Data Flow: From Input to Result

```
TXT / VBook
  │
  ▼
┌─────────────────┐
│  TXT Importer   │  → Decoding, draft book creation (RAW_IMPORTED)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Agent Service  │  → 6-step AI analysis (1500-char buffer, up to 3 scenes)
│  (bootstrap)    │  → Extraction: structure, characters, locations,
└────────┬────────┘    scenes (title + environment-override), IU, visual prompts
         │
         ▼
┌─────────────────┐
│  Book Module    │  → Save in multi-file format
│  (lazy-book)    │  → manifest.json, book.json, chapters/*.json
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Scene State    │  → Initialize per-asset states
│  Orchestrator   │  → Add to active-scenes index
└────────┬────────┘
         │
    ╔══════════════════════════════════════════╗
    ║      Runtime Scheduler (tick 5s)         ║
    ║  ┌──────────┐  ┌─────────────┐          ║
    ║  │ Dispatch  │→│  Orchestrator│          ║
    ║  │ Engine    │  │  dispatch   │          ║
    ║  └─────┬────┘  └──────┬──────┘          ║
    ║        │              │                  ║
    ║  ┌─────┴──────────────┴──────────┐       ║
    ║  │    GPU Dispatcher              │       ║
    ║  └──────────────┬─────────────────┘       ║
    ╚═════════════════╪═════════════════════════╝
                      │ HTTP POST /task
                      ▼
              ┌──────────────┐
              │   GPU Hub    │ → Redis Queue
              │   (5 retries │
              │   on result) │
              └──────┬───────┘
                     │ poll
              ┌──────┴───────┐
              │   Worker     │ → ComfyUI → Result (base64)
              └──────┬───────┘
                     │ POST /task/result
                     ▼
              ┌──────────────┐
              │ Task Handler │ → orchestrator.handle*Completed()
              │ (IU check,   │
              │  audio merge,│
              │  video)      │
              └──────┬───────┘
                     │
              ┌──────┴───────┐
              │ Save Asset   │ → Filesystem (MP3, PNG, MP4)
              │ Register     │ → Registry (PostgreSQL scene_assets)
              │ Update State │ → Per-Asset State → READY
              └──────────────┘
```

## Key Components and Their Roles

| Component | File | Role |
|-----------|------|------|
| Backend entry | `backend/src/backend.cjs` | Server initialization, DI, route mounting, helmet/rate-limit, graceful shutdown, startup resume |
| Book routes | `backend/src/routes/book-routes.cjs` | REST API for books, import, status |
| AI routes | `backend/src/routes/ai-routes.cjs` | REST API for AI assistant |
| Generation routes | `backend/src/routes/generation-routes.cjs` | REST API for generation triggers |
| Orchestrator facade | `backend/src/orchestration/orchestrator.js` | Single arbiter of state — 11 lifecycle commands, version gate on READY |
| Scene orchestrator | `backend/src/orchestration/scene-orchestrator.js` | Dispatch execution (audio/image/video), pure executor |
| Scene callbacks | `backend/src/orchestration/scene-callbacks.js` | handleAudioCompleted, handleImageCompleted, handleVideoCompleted |
| Scene restoration | `backend/src/orchestration/scene-restoration.js` | Chunk/scene status restoration on regeneration |
| Event journal | `backend/src/orchestration/event-journal.js` | Append-only scene event log in Redis (TTL 7d) |
| Runtime scheduler | `backend/src/runtime/runtime-scheduler.js` | Tick-based scheduler (5s), per-asset dispatch, pure decision (D.2) |
| Runtime loop | `backend/src/runtime/runtime-loop.js` | Runtime heartbeat: tick + reconciliation + counter-reconciliation + metrics |
| Dispatch engine | `backend/src/runtime/dispatch-engine.js` | Lease (NX TTL), atomic quotas (Lua EVAL), idempotent completion (NX), governance (circuit-breaker/retry-budget/fairness) |
| GPU dispatcher | `backend/src/runtime/gpu-dispatcher.js` | HTTP client for GPU Hub task submission (send/sendVideo/sendUnified) |
| Scene window | `backend/src/runtime/scene-window.js` | Generation window manager (scope-aware, cancel, recover, all writes through facade) |
