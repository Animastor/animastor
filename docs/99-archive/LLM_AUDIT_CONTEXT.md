# LLM Audit Context: Animastor

## Project Purpose

Animastor — AI-powered animated storytelling platform. Transforms text books into multimedia content (audio, images, video) through AI analysis and GPU generation.

**Architectural Principle:** Book is modeled as a sequential reading process, not static text. The system accumulates "reading memory" in JSON, progressively enriching the book's world.

**Tech Stack:** Node.js/Express (backend), Kotlin/Android (frontend), PostgreSQL 16 + Redis 7 (persisted), ComfyUI (GPU generation), OpenRouter API / Nvidia API (AI).

## Major Subsystems

### 1. Backend API Server (`backend/src/backend.cjs`)
- Express server on port 3000
- DI container for ~30 services
- Mounts 6 route modules: books, generation, AI, debug, connector, workflow
- Helmet.js (security headers), express-rate-limit (500 req/min on /api/)
- Request ID middleware (crypto.randomUUID() for tracing)
- Graceful shutdown (SIGTERM → server.close → redis.quit → pg.closePool)
- Startup resume (resumes interrupted generation sessions)

> **UPDATE 2026-06-26:** Rate limit fixed (500, not 100). Audit: `02_Claude_Audit.md §C1-C4`, `05_Documentation_Audit.md §LLM_AUDIT_CONTEXT`.

### 2. Orchestration Engine
Consists of 3 key components:

- **Runtime Scheduler** (`runtime/runtime-scheduler.js`): Tick-based (5s), per-asset dispatching (audio/image/video independent)
- **Dispatch Engine** (`runtime/dispatch-engine.js`): Leases, quotas, backpressure + lazy governance modules
- **Scene Orchestrator** (`orchestration/scene-orchestrator.js`): Layer-aware dispatch (audio_enabled/image_enabled/video_enabled) — **~173 lines** (facade, logic extracted to scene-callbacks.js/scene-restoration.js/scene-utils.js)

### 3. AI Agent Pipeline (`services/agent-service.js`)
6-step sequential AI pipeline: structure (step 0) → characters → locations → scenes → IU → visuals

### 4. Storage
- **PostgreSQL (25+ tables)**: Canonical state. Tables: users, books, book_snapshots, scenes, asset_states, cache_entries, asset_dependencies, generation_tasks, workers, reconciliation_events, output_manifests, image_units, storyboard_elements, audio_layers, scene_assets, ai_chat_sessions, chat_sessions, chat_messages, book_events, agent_sessions, agent_steps, agent_conversations, agent_messages, book_source, book_generation_sessions
- **Redis (persisted)**: Runtime state, GPU queues, dispatch leases, event journal, per-asset state, chunks
- **Filesystem (multi-file)**: Book files (multi-file format v2.1), audio, images, video

### 5. GPU Infrastructure
- **GPU Hub** (`gpu-hub/gpu-hub.js`): Task dispatcher, Redis queues, requeue on timeout (10 min), 5 retries on result forwarding
- **Workers** (`worker/worker/worker.js`): ESM modules, ComfyUI workers (image/audio/video), multi-image support

### 6. Android Frontend
- Kotlin, compileSdk=35, minSdk=24, targetSdk=35
- Retrofit/OkHttp HTTP client, ExoPlayer (Media3) for playback
- LruCache (50MB) + SimpleDiskCache (256MB)
- PreloadAhead=3 scenes

### 7. Workflow System (`backend/src/workflows/`)
- ComfyUI JSON templates in `/data/workflows/`
- Types: tts-qwen-narrator, tts-qwen-dialogue, img-qwen-image, video-ltx-{1p,2p,3p,4p}

## Architecture Diagram

```
Client (Android)
    │ HTTP REST
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Nginx Reverse Proxy                          │
│  /api/ → backend:3000  |  /gpu/ → gpu-hub:5000                     │
└───────────┬─────────────────────────────────────────────────────────┘
            │
┌───────────┴─────────────────────────────────────────────────────────┐
│                     Backend (Node.js, port 3000)                     │
│                                                                     │
│  API Layer:    book-routes / generation-routes / ai-routes / debug /  │
│                connector / workflow                                  │
│                                                                     │
│  Orchestration: Scheduler (tick 5s, per-asset) → Dispatch Engine    │
│                 → Scene Orchestrator (layer-aware)                   │
│                                                                     │
│  Services:     Audio / Image / Video / Agent / Chat (tool-based)    │
│                TXT Importer / Window Gen / Gen Scope / Layer Config │
│                Book Source/Sync/Integrity / Scene Asset Registry    │
│                Book Event Log / Chat Store / Cleanup / Startup Rec. │
│                Placeholder Audio / AI Loader / Workflow Manager     │
│                Waveform Service / Connector Loader                   │
│                                                                     ││  State:        DUAL MODEL — Per-Asset (CANONICAL) + Linear FSM     │
│                (syncLinearState убран из callback'ов R6.1;         │
│                 per-asset storage: HSET/HGETALL (Н.6/M1);         │
│                 GENERATING выставляется при диспатче (Н.7/§5.1))   │
│                                                                     │
│  GPU Dispatch: gpu-dispatcher.js (send/sendUnified)                │
│                                                                     │
│  Governance (LIVE): circuit-breaker, retry-budget, fairness         │
│  Governance (DEBUG/мёртвые): policy-engine, workload-classifier,   │
│                cost-estimator, decision-trace, feedback,            │
│                governance-*, adaptation-controller, exec-semantics  │
│                                                                     │
│  Storage:      PostgreSQL (canonical, 25+ tables)                   │
│                Redis (runtime, persisted) + FS (multi-file books)   │
└───────────┬─────────────────────────────────────────────────────────┘
            │ HTTP POST /task
            │
┌───────────┴─────────────────────────────────────────────────────────┐
│                     GPU Hub (Node.js, port 5000)                    │
│  POST /task → animastor:queue:{audio,image,video}                   │
│  GET /task/next ← Worker polling                                    │
│  POST /task/result → 5 retries to backend                           │
│  GPU_TIMEOUT: 10 min → requeue                                      │
└───────────┬─────────────────────────────────────────────────────────┘
            │ HTTP poll
            │
┌───────────┴─────────────────────────────────────────────────────────┐
│               GPU Worker (ESM Node.js + ComfyUI)                    │
│  image (SD) / audio (TTS) / video (LTX) — multi-image support      │
└─────────────────────────────────────────────────────────────────────┘
```

## Key Component Dependencies

### Critical Dependencies

| Component | Depends On | Type |
|-----------|-----------|------|
| Runtime Scheduler | Redis, Dispatch Engine, Scene Window, Active Scenes | runtime |
| Dispatch Engine | Redis, Lease Manager, Counter Reconciliation | runtime (core) |
| Scene Orchestrator | Audio/Image/Video Service, GPU Dispatcher, Scene State (dual), Event Journal, Layer Config | runtime |
| Agent Service | AI Service, Context Builder, PostgreSQL, Book Module | data |
| Audio Service | GPU Dispatcher, Workflow Loader, Audio Workflows | execution |
| Image Service | GPU Dispatcher, Workflow Loader, Image Workflows | execution |
| Video Service | GPU Dispatcher, Workflow Loader, Video Workflows | execution |
| GPU Hub | Redis, Express | infrastructure |
| Workers | GPU Hub (HTTP), ComfyUI (HTTP) | infrastructure |
| Scene Asset Registry | PostgreSQL scene_assets table | data |
| Book Source | Book JSON (filesystem) | data |
| Book Sync | PostgreSQL scenes + book JSON | data |
| Book Integrity | PostgreSQL all scene-keyed tables | data |

### Storage Types and Their Consumers

**PostgreSQL (25+ tables):**
- `agent_sessions/agent_steps/agent_conversations/agent_messages` → Agent Service
- `scenes` → Scene Asset Registry, Book Routes
- `scene_assets` → Scene Asset Registry
- `image_units` → IU Repo, Placeholder Audio
- `asset_states` → Layers
- `cache_entries` → Cache Repo
- `generation_tasks` → Task Repo
- `chat_sessions/chat_messages` → Chat Engine, Chat Store
- `book_events` → Book Event Log
- `book_sources` → Book Source Repo
- `book_generation_sessions` → Gen Session Repo

**Redis (key patterns):**
- `animastor:active-scenes` (Set) — active scenes
- `animastor:dispatch-lease:*` (String) — dispatch lease
- `animastor:dispatch-meta:*` (Hash) — dispatch metadata
- `animastor:asset-state:*` (String) — per-asset states (NEW)
- `animastor:runtime:active-*` (String) — quota counters
- `animastor:queue:*` (List) — GPU Hub queues
- `animastor:chunk:*` (String) — scene chunks
- `animastor:event-journal:*` (List) — event journal (TTL 7 days)
- `animastor:scene-state:*` (String) — linear FSM scene state
- `animastor:layer-config:*` (String) — generation profiles

## Workflow (Scene Lifecycle)

### DUAL STATE MODEL

**Per-Asset States (CANONICAL — for new code):**
```
audio: NEW → DIRTY → PENDING → GENERATING → READY | FAILED | PLACEHOLDER
image: NEW → DIRTY → PENDING → GENERATING → READY | FAILED
video: NEW → DIRTY → PENDING → GENERATING → READY | FAILED
```

**Linear FSM (LEGACY — derived projection):**
```
NEW → AUDIO_PENDING → AUDIO_GENERATING → AUDIO_READY
    → IMAGE_PENDING → IMAGE_GENERATING → IMAGE_READY
    → VIDEO_PENDING → VIDEO_GENERATING → VIDEO_READY
```

### Full Lifecycle

```
1. TXT/text imported → TXT Importer → RAW_IMPORTED
2. Agent Service (step 0 + 5 steps, windows of 3 scenes) → BOOTSTRAPPED
3. Scenes registered in Active Scenes Index
4. Runtime Scheduler (tick 5s) checks per-asset states
5. Dispatch Engine makes decision (lease, quota, circuit breaker)
6. Scene Orchestrator executes dispatch (layer-aware):
   a. Audio Service → TTS → GPU Hub → Worker → MP3
   b. Image Service → image → GPU Hub → Worker → PNG (independent of audio!)
   c. Video Service → video → GPU Hub → Worker → MP4 (requires image=READY)
7. Callback → Task Handler → orchestrator → per-asset state update (syncLinearState removed from callbacks in R6.1)
8. Scene complete → remove from active → window slide → next batch
9. Android player plays generated content
```

## Agents (AI Pipeline)

### 6-step Pipeline

| Step | Function | What It Extracts | Stored In |
|-----|---------|-----------------|------------|
| 0 | stepAnalyzeStructure | Author, title, chapters (first 80 lines) | agent_steps (step_type: analyze_structure) |
| 1 | stepExtractCharacters | Characters (description, appearance in EN for LTX) | agent_steps + characters.json |
| 2 | stepExtractLocations | Locations | agent_steps + bible.json |
| 3 | stepCreateScenes | Scenes (participants, location, time; window=3) | agent_steps + chapters/*.json |
| 4 | stepCreateUnits | IU (visual units per scene) | agent_steps + chapter scenes |
| 5 | stepCreateVisuals | Generation prompts (shot, prompt) | agent_steps + chapter scenes |

**Model:** qwen/qwen3.5-122b-a10b (default), qwen/qwen3-32b (docker-compose)
**API Base URL:** https://integrate.api.nvidia.com/v1 (default), https://api.aicredits.in/v1 (docker-compose)
**Window:** 3 scenes / 4000 characters per batch
**Retry:** 3 attempts, timeout 180s (60s default)
**Storage:** agent_sessions + agent_steps + agent_conversations + agent_messages (PostgreSQL)

## Generators

No formal "generator" abstraction exists. Three independent services.

## Connectors

No formal connector system exists. GPU Dispatcher (send/sendUnified with 3 retries, 30s timeout), Task Handler (IU completion + audio merge). GPU Hub (10 min timeout, requeue, 5 retries result forward).

> **UPDATE 2026-06-26:** `sendVideo` does not exist — only `send` and `sendUnified`.

## Runtime Module (slim v2.0.0)

**Core:** scheduler, loop, activeScenes, reconciliation, dispatch, leaseManager, counterReconciliation, metrics, gpuDispatcher, workerHealth, sceneWindow
**Error:** failureTaxonomy, retryManager, retentionManager
**Debug (lazy):** circuitBreaker, priorityManager, fairness, retryBudget, policyEngine, workloadClassifier, costEstimator, decisionTrace, feedback, governance*
**Debug/Exp:** policySimulator, sandbox, failureReplay, validator

## Ключевые файлы и их роли

| Файл | Роль | Размер |
|------|------|--------|
| backend/src/backend.cjs | Точка входа, DI, graceful shutdown | ~265 строк |
| backend/src/orchestration/scene-orchestrator.js | Оркестратор сцен (layer-aware, фасад) | ~173 строки |
| backend/src/runtime/dispatch-engine.js | Диспетчер с governance (lazy) | ~1000 строк |
| backend/src/runtime/runtime-scheduler.js | Tick-планировщик (per-asset) | ~700 строк |
| backend/src/services/agent-service.js | AI-пайплайн (6 шагов) | ~1328 строк |
| backend/src/services/txt-importer.js | Импорт TXT (v3.0) | ~298 строк |
| backend/src/services/task-handler.cjs | Callback handler (IU+audio) | ~400 строк |
| backend/src/routes/book-routes.cjs | REST API книг | ~1800+ строк |
| backend/src/audio/audio-service.js | TTS генерация | ~400 строк |
| backend/src/image/image-service.js | Image генерация | ~300 строк |
| backend/src/video/video-service.js | Video генерация | ~300 строк |
| backend/src/state/scene-state.js | Dual state model (v2.0) | ~500 строк |
| backend/src/book/lazy-book.js | Lazy book (v2.0) | ~800 строк |
| backend/src/runtime/scene-window.js | Scene window (v2.0, scope-aware) | ~500 строк |
| gpu-hub/gpu-hub.js | GPU диспетчер (+ requeue) | ~400 строк |
| worker/worker/worker.js | GPU воркер (ESM) | ~500 строк |

## Key Risks

1. **Single point of failure — GPU Hub.** No failover, but has requeue and deduplication.
2. **Single point of failure — external AI API.** No automatic switching between OpenRouter and Nvidia.
3. **Dual State Model.** Per-asset + linear FSM adds synchronization complexity.
4. **Excessive coupling.** book-routes.cjs, scene-orchestrator.js, dispatch-engine.js.
5. **Missing unit tests** for critical components.
6. **Governance modules — partly LIVE, partly DEBUG.** circuit-breaker, retry-budget, fairness are actually called; policy-engine/workload-classifier/cost-estimator are dead.
7. **Graceful shutdown — FIXED.** SIGTERM in backend.cjs and gpu-hub.js.
8. **AI knowledge base loads but is not used** in prompts (dead code, except refineDraft).
9. **Two event journals:** Redis + PostgreSQL.
10. **Multi-file book format + legacy single-file support.**

## Project Metrics Summary

| Metric | Value |
|---------|----------|
| Total files (backend) | ~100 |
| Total lines (backend) | ~20,000 |
| PostgreSQL tables | 25+ |
| Redis key patterns | 15+ |
| REST endpoints | 40+ |
| Docker services | 5 (postgres, redis, backend, gpu-hub, nginx) |
| Languages | JavaScript, Kotlin, SQL, Shell |
| External dependencies | 10 npm + AndroidX + Retrofit + ExoPlayer |
| Tests | 14 (all mocha) |
| Workflow templates | 7 |
| AI pipeline steps | 6 (step 0 + 5) |
| GPU worker types | 3 (audio/image/video) |
| Governance modules (debug) | 15+ |
