# Architecture: Animastor

## 1. Backend Server (`backend/src/backend.cjs`)

**Responsibility:** Entry point. Redis/Express/PG initialization, DI of all services, route mounting, runtime loop startup.

**Inputs:** HTTP requests (Express), GPU Hub signals (callbacks via task-handler).

**Outputs:** HTTP responses, tasks to GPU Hub, data to Redis/PG.

**Dependencies:** Express, ioredis, pg, multer, adm-zip, sharp, music-metadata, ws, uuid, cors, helmet, express-rate-limit.

**Built-in improvements:**
- **Helmet.js** — HTTP security headers (HSTS, CSP, X-Frame-Options, XSS-Protection)
- **Rate limiting** — 500 req/min on `/api/`, overload protection

> **UPDATE 2026-06-26:** Fixed rate limit (500, not 100). Code: `backend.cjs:64-65`.
- **Request ID** — every HTTP request gets short ID (`crypto.randomUUID().slice(0,8)`) for tracing
- **Graceful shutdown (SIGTERM)** — sequential shutdown: server.close() → redis.quit() → postgres.closePool()

**Used by:** All external clients (Android, curl, browser).

**Uses:** All backend modules (`state`, `audio`, `image`, `video`, `workflows`, `orchestration`, `storage`, `runtime`, `book`, `services/*`).

---

## 2. API Layer (Routes)

### 2.1 Book Routes (`backend/src/routes/book-routes.cjs`)
**Responsibility:** Book management: CRUD, TXT import, bootstrap, trigger-next-window, status, agent-status, generation, chunks, sliding window, scene reorder.

**Inputs:** HTTP `GET/POST/PUT/PATCH/DELETE /api/v1/book/*`
**Outputs:** JSON responses

### 2.2 Generation Routes (`backend/src/routes/generation-routes.cjs`)
**Responsibility:** Generation start/cancel, gen-scope, layer-config, worker counts, progress.

**GPU Hub cleanup (July 2026):** Added `clearGpuHubQueues()` — centralized cleanup of stale tasks from Redis GPU hub (dedup keys, queues, running, result cache). Supports optional sceneFilter for targeted cleanup. Used in regenerate and cancel-generation.

**See also:** `docs/02-orchestration/GPU_HUB_CLEANUP.md`

### 2.3 AI Routes (`backend/src/routes/ai-routes.cjs`)
**Responsibility:** AI assistant chat, book loading into AI context, chat session management.

### 2.4 Debug Routes (`backend/src/routes/debug-routes.cjs`)
**Responsibility:** Debugging: state dumps, queues, event journal.

### 2.5 Connector Routes (`backend/src/routes/connector-routes.cjs`)
**Responsibility:** Connector management (13 endpoints).

### 2.6 Workflow Routes (`backend/src/routes/workflow-routes.cjs`)
**Responsibility:** Workflow management (4 endpoints).

### 2.7 Auth Routes (`backend/src/routes/auth-routes.cjs`)
**Responsibility:** Authentication: register, login, logout, me. Public/pre-auth endpoints.

**API:**
- `POST /api/v1/auth/register` — account creation (+ workspace + session); when called with guest cookie — in-place guest workspace conversion.
- `POST /api/v1/auth/login` — username/password → session cookie (HttpOnly).
- `POST /api/v1/auth/logout` — session/guest identity invalidation.
- `GET /api/v1/auth/me` — current identity: user | guest | none.

**Sessions:** Server-side in PG (`sessions` table), cookie `animastor_sid`. Cross-subdomain via `COOKIE_DOMAIN=animastor.in`.

### 2.8 Worker Routes (`backend/src/routes/worker-routes.cjs`)
**Responsibility:** Workspace worker registration and lifecycle (PW-4 fail-closed model).

**API:**
- `POST /api/v1/worker/verify` — credential check (worker CLI first-run). FAIL CLOSED: missing/invalid/revoked → 401. Returns identity + mode from PG (authoritative).
- `POST /api/v1/workers` — create worker + issue credential (one-time). Mode: `private` (default) or `share` (with `confirm_share=true`). `system` — admin-only, rejected.
- `GET /api/v1/workers` — workspace worker list (no secrets).
- `GET /api/v1/workers/:workerId` — single worker details.
- `POST /api/v1/workers/:workerId/rotate` — credential rotation (old dies).
- `DELETE /api/v1/workers/:workerId` — worker revoke (soft delete).

**Invariants:** workspace_id always from `req.workspace` (never from body/guest). Only registered users (guests get 401/403).

### 2.9 Admin Routes (`backend/src/routes/admin-routes.cjs`)
**Responsibility:** Platform admin level: system AI kill switch + system provider + SYSTEM worker registry.

**API — System AI:**
- `GET /api/v1/admin/system-ai` — kill switch state + provider meta.
- `PUT /api/v1/admin/system-ai` — toggle enabled/upsert provider.
- `POST /api/v1/admin/system-ai/test` — connection test (doesn't save key).

**API — SYSTEM Worker Registry (PW-4):**
- `POST /api/v1/admin/workers/system` — create SYSTEM worker (Animastor-operated pool). Token issued ONCE.
- `GET /api/v1/admin/workers/system` — SYSTEM worker list.
- `POST /api/v1/admin/workers/system/:workerId/rotate` — credential rotation (old dies, new ONCE).
  `DELETE /api/v1/admin/workers/system/:workerId` — revoke (immediate soft delete).

SYSTEM workers workspace-less (workers_scope_check), created ONLY here. Tenant routes reject mode='system'.

**Guard:** `requireAdmin` (role='admin' OR ADMIN_USERNAMES allowlist). Second layer: nginx Basic Auth on `admin.animastor.in`.

**Note:** admin-routes receives `redis` (for worker auth mirror updates on create/rotate/revoke).

### 2.10 Settings AI Routes (`backend/src/routes/settings-ai-routes.cjs`)
**Responsibility:** Workspace AI provider — one active provider per workspace.

**API:**
- `GET/PUT/DELETE /api/v1/settings/ai/provider` — CRUD workspace провайдера.
- `POST /api/v1/settings/ai/test` — тест соединения.

**Identity:** user OR guest с workspace; anonymous → 401.

### 2.11 Config Routes (`backend/src/routes/config-routes.cjs`)
**Responsibility:** Client-side editor limits (image_prompt_max_chars).

### 2.12 Book Sub-Routes (`backend/src/routes/book/`)
**Responsibility:** Book routes decomposed into 17 sub-modules:

| Module | Role |
|---|---|
| `core-routes.cjs` | GET/PUT/PATCH book, DELETE, source-coverage, cover |
| `import-routes.cjs` | load-vbook, import-txt, bootstrap, resume-bootstrap, bootstrap-next-window |
| `export-routes.cjs` | Vbook, storyboard, audio, video export |
| `generation-routes.cjs` | regenerate, cancel-generation, generate-next |
| `chunks-routes.cjs` | GET chunks, GET assets-state |
| `agent-routes.cjs` | GET agent-status |
| `progress-panel.cjs` | Progress panel (pre-computed worker list) |
| `recovery-routes.cjs` | recover-placeholders |
| `versions-routes.cjs` | Scene versions |
| `recent-books-routes.cjs` | Recent books (session restore) |
| `entity-crud-routes.cjs` | Add/delete characters/locations/voices |
| `status-routes.cjs` | Status/read-only endpoints |
| `parse-routes.cjs` | Parse/source/snapshot |
| `cache-routes.cjs` | Cache inspection + teardown |

## 3. Orchestration Layer

### 3.0 Orchestrator Facade (`backend/src/orchestration/orchestrator.js`) — Single State Arbiter

**Responsibility:** Single owner of scene lifecycle state. Facade of 11 commands, through which ALL state writers pass (M5).

**Commands:**
- `markDirty(deps, redis, bookId, buildId, dirtyScenes, layerCfg)` — via bookDiff.markDirtyScenes (Lua atomic reset)
- `markDirtyScene(redis, bookId, chapterId, sceneId, assets)` — direct per-scene DIRTY (for recovery)
- `planScene(redis, bookId, chapterId, sceneId)` — pure function, reads per-asset states, writes nothing
- `beginStage(redis, scene, loadedBook, buildId, stage)` — dispatch + per-asset GENERATING/PENDING
- `completeStage(redis, bookId, chapterId, sceneId, stage, buildId)` — callback + version gate + READY + release
- `completeStageWithoutVideo(redis, loadedBook, bookId, chapterId, sceneId, buildId)` — video disabled
- `completeStageWithoutImage(redis, loadedBook, bookId, chapterId, sceneId, buildId)` — image disabled
- `setScenePending(redis, bookId, chapterId, sceneId, asset, buildId)` — per-asset PENDING
- `setSceneAllReady(redis, bookId, chapterId, sceneId, buildId)` — cache hit: all assets READY
- `setScenePlaceholder(redis, bookId, chapterId, sceneId, buildId)` — audio PLACEHOLDER
- `reconcile(redis, bookId, chapterId, sceneId)` — fact verification via reconciliation-engine

**Version gate (M5 Step 5):** `completeStage` checks `scene_assets.scene_content_version < scenes.content_version` in PG before READY. If version stale → DIRTY instead of READY. Graceful fallback when PG unavailable.

> **UPDATE 2026-07-16 (T8):** syncLinearState removed, SceneState enum removed. Per-asset — sole source of truth.

### 3.1 Runtime Scheduler (`backend/src/runtime/runtime-scheduler.js`)

**Responsibility:** Tick-based (5s) planner. **Pure decision function** — `shouldScheduleAssets()` only reads per-asset states and layer-config, writes nothing (D.2). Version-stale reset — explicit pre-pass in `attemptDispatch()` via `detectVersionStale()` + `markVersionStaleDirty()`.

**Scene-specific active index cleanup (July 2026):** Added `removeScenesFromActiveIndex()` — removes only specified scenes from `animastor:active-scenes` (via SREM), not all book scenes. Used in regenerate for targeted dirty scene cleanup.

**Inputs:** Redis (active scenes set), worker heartbeat.
**Outputs:** `dispatchEngine.dispatchStage()` calls.

**Dependencies:** Redis, dispatch-engine, active-scenes-index, scene-state, worker-health.
**Used by:** runtime-loop.
**Uses:** dispatch-engine, orchestrator, scene-window.

### 3.2 Dispatch Engine (`backend/src/runtime/dispatch-engine.js`)

**Responsibility:** Dispatch with lease mechanism (NX TTL, duplication prevention), quota control (backpressure with **atomic Lua EVAL** for acquire), idempotent completion (NX marker). Integration with governance modules: circuit-breaker, retry-budget, fairness-engine — direct via `require()` (LIVE, not lazy).

**Key changes:**
- **Atomic quotas (M2):** `ATOMIC_ACQUIRE_SCRIPT` (Lua EVAL) — limit check and INCR in single Redis operation. Race between GET and INCR eliminated.
- **Idempotent completion (C4):** `markDispatchCompleted` protected by `SET NX` on key `animastor:dispatch-completed:*`. Duplicate callback harmless.
- **D.1 (C1):** Single owner of quota release — `markDispatchCompleted`. releaseQuota removed from scene-callbacks.
- **Force dispatch:** `force=true` support — clears existing lease + quota + metadata before re-dispatch.
- **Scene-specific cleanup (July 2026):** Added `clearLeasesForScenes()` — batch DELETE lease/meta/completed keys for specified scenes (no SCAN, by known keys). Used in regenerate for targeted dirty scene cleanup.

**Dependencies:** Redis, lease-manager, runtime-config, counter-reconciliation, runtime-metrics, **circuit-breaker (LIVE)**, **retry-budget-manager (LIVE)**, **fairness-engine (LIVE)**.
**Removed from core:** policy-engine, workload-classifier, cost-estimator (dead code, Phase 6).

**Used by:** runtime-scheduler.
**Uses:** orchestrator.dispatchStage().

**Lease TTL (current):** audio 15min, image 20min, video 30min.

**Exports:** `clearLeasesForScenes`, `clearAllLeasesForBook`, `getQuotaStatus`, `LEASE_TTLS`, `QUOTAS`, `SCHEDULER_TICK_LOCK`, `SCHEDULER_TICK_LOCK_TTL`.

### 3.3 Scene Orchestrator (`backend/src/orchestration/scene-orchestrator.js`)

**Ответственность:** Dispatch execution (audio/image/video). Чистый исполнитель — НЕ принимает решений о состоянии. Отвечает за старт сцены, выполнение dispatch для audio/image/video, обработку dirty-unit IDs для image.

Логика вынесена в:
- `scene-callbacks.js` (~17 КБ) — handle*Completed, completeSceneWithoutVideo/Image
- `scene-restoration.js` — восстановление чанков, pre-delete stale PNG при dirty units, version gate
- `scene-utils.js` — утилиты/логирование
- `event-journal.js` — журнал событий

### 3.4 Scene Window (`backend/src/runtime/scene-window.js`)

**Responsibility:** Generation window management (scope-aware). Window start/stop/slide as scenes complete.

**Key changes:**
- **All state writes via facade (M5 Step 2):** `setScenePending`, `setSceneAllReady`, `setScenePlaceholder` — 7 direct `state.setAssetState/setAssetStates` calls replaced by `orchestrator.*` (commit d4bda21: syncLinearState removed)
- **Cache advisory (Phase 3/R3.3):** `checkSceneContentCache` — informational only, decision made by facade. Version-based staleness check.
- **Single source of file statuses:** `getSceneFilesStatus()` — quadruply used function for checking file existence on disk.
- **Version gate (D.3/M3):** `restoreChunkStatusForScene` and `reconcileWindowStatuses` check PG version before writing 'ready'. Stale files don't cancel force-regen.

### 3.5 Event Journal (`backend/src/orchestration/event-journal.js`) v1.1.0

**Responsibility:** Append-only scene event journal in Redis (List). Lifecycle audit. TTL 7 days. Core scene lifecycle types (R5.1) — governance/phase-specific types removed.

**API:** appendSceneEvent, getSceneEvents, getSceneEventsByTime, getLastEvents, getEventsByType, getEventCount, getFirstEventTime, getLastEventTime, getEventTimeRange, deleteSceneEvents.

**Event types:** SCENE_STARTED, AUDIO_DISPATCHED, AUDIO_COMPLETED, AUDIO_FAILED, IMAGE_DISPATCHED, IMAGE_FAILED, VIDEO_DISPATCHED, VIDEO_COMPLETED, VIDEO_FAILED, RECOVERY_*, DUPLICATE_CALLBACK, INVALID_STATE_CALLBACK, LOCK_*, DISPATCH_BLOCKED_CIRCUIT, RETRY_BUDGET_EXCEEDED, STARVATION_DETECTED, OVERLOAD_PROTECTION_ENABLED etc.

### 3.6 Active Scenes Index (`backend/src/runtime/active-scenes-index.js`)

**Responsibility:** Redis set `animastor:active-scenes` for tracking scenes in processing.

---

## 4. Service Layer

### 4.1 Audio Service (`backend/src/audio/audio-service.js`)
**Responsibility:** TTS generation via GPU Hub, audio chunk merging via ffmpeg, placeholder audio, silence-trimming, book-level audio merge, padded text trimming.

**Inputs:** sceneData, loadedBook, buildId, bookId.
**Outputs:** Audio files (MP3), gpu.send() calls.

**Dependencies:** gpu-dispatcher, workflow-loader, audio-workflows.

### 4.2 Image Service (`backend/src/image/image-service.js`)
**Responsibility:** IU image generation via GPU Hub, prompt building (characters, locations, environment), caching, preview.

**Inputs:** sceneData, loadedBook, buildId, bookId.
**Outputs:** PNG files, gpu.send() calls.

**Dependencies:** gpu-dispatcher, workflow-loader, image-workflows.

### 4.3 Video Service (`backend/src/video/video-service.js`)
**Responsibility:** Video generation via LTX models (multi-image), image reading for GPU assets.

**Inputs:** sceneData, loadedBook, buildId.
**Outputs:** MP4 files, gpu.sendVideo() calls.

**Dependencies:** gpu-dispatcher, workflow-loader, video-workflows.

### 4.4 Video Merge (`backend/src/video/video-merge.js`)
**Responsibility:** Multi-group video merging into scene, book-level merge, video+audio muxing.

### 4.5 Agent Service (`backend/src/services/agent/`)
**Responsibility:** AI pipeline decomposed into sub-modules in `backend/src/services/agent/`:
- `pipeline-steps.js` — 6 steps (step 0 + 5 pipeline steps)
- `pipeline-runner.js` — pipeline execution with validation
- `bootstrap.js` — first window (`bootstrapWithAgent`)
- `coreference.js` — reduced to stub (removed from pipeline)
- `ai-caller.js` — AI call with retries
- `text-utils.js` / `image-utils.js` — utilities
- `agent-prompts.js` — all system prompts (in `services/agent-prompts.js`)
- `agent-service.js` — barrel export and window-generation

**Pipeline steps (simplified, without coreference):**
```
Step 0: stepAnalyzeStructure       — book metadata (separate, before pipeline)
Step 1: stepExtractCharacters      — characters
Step 2: stepExtractLocations       — locations
Step 3: stepCreateScenes           — scenes (up to 3, from ~1500 char buffer)
                                      + title, location.id, environment-override
Step 4: stepCreateUnits            — IU (visual units), per-scene
Step 5: stepCreateVisuals          — visual prompts, per-scene
```

**Key changes (June–July 2026):**
- **Separate Enrichment step removed** — title, location.id and environment-override
  generated by `stepCreateScenes()` itself: agent compares each scene with global
  location template and writes `location.environment` only for differing fields
  ("overrides only" rule, same as in `enrich_scenes.md`).
  Extra LLM pass over 500-char fragments eliminated.
- **`unit.participants` removed from entire system** — LLM no longer generates
  participants for IU. `inferCharactersFromPrompt()` — sole method
  for determining visual participants (scans `visual.prompt` for character_id).
- **Coreference resolution removed from pipeline** — `coreference.js` reduced to stub.
  character_id validation now only via `normalizeCharacterRefs()`.
- **`character_anchors` removed** — character positions written directly to
  `visual.prompt`, no separate field.

**Key behavior (2026-07-02):**
- Backend stores `currentOffset` in `agent_sessions.window_data` and takes from it
  text buffer `MAX_WINDOW_CHARS=1500`.
- AI creates **up to 3 scenes** (`MAX_SCENES_PER_CHUNK=3`) from buffer start and may
  leave buffer tail unused.
- `computeSceneCoverage()` verifies created scenes are verbatim
  continuous prefix of buffer.
- `resolveSceneProgress()` computes `nextOffset` by end of last
  created scene; `currentOffset` updated to this position, not to
  buffer end.
- Scene duration: target ~20s, soft ceiling ~30s with one repair retry.

**Inputs:** bookId, sourceText.
**Outputs:** Book JSON structure in PG (agent_sessions, agent_steps, agent_conversations).

**Dependencies:** ai-service, book, postgres, agent-prompts.

**Book storage (multi-file, v2.2):** In addition to `bible.json` and `characters.json`,
system now stores:
- `locations.json` — all locations (separate from bible, accessible via `book.locations`)
  `voices.json` — all character voices (separate from bible, accessible via `book.voices`)
- `bible.json` — includes `country` and `epoch` for image prompt injection

**AI provider:**
- Single key: `OPENROUTER_API_KEY`
- Base URL: `AI_API_BASE_URL` (configurable, default OpenRouter)
- Default model: `qwen3-32b`
- JSON responses cleaned of CoT (`<think>`/`<reasoning>`) before parsing

### 4.6 TXT Importer (`backend/src/services/txt-importer.js`)
**Responsibility:** TXT import: decoding (UTF-8/CP1251), validation, draft creation, agent-service call.

**Inputs:** Buffer (TXT file) or string (AI text).
**Outputs:** Draft book on disk.

### 4.7 Window Generator (`backend/src/services/window-generator.cjs`)
**Responsibility:** Background processing of next window: bootstrapNextWindow call, chunk creation, placeholder audio, scene registration for GPU.

### 4.8 AI Service (`backend/src/services/ai-service.js`)
**Responsibility:** External AI API client (OpenRouter + Nvidia). Call with retries and JSON parsing. Single key: `OPENROUTER_API_KEY`. Includes `refineDraft()` function with example loading from `ai/examples/`.

### 4.9 Task Handler (`backend/src/services/task-handler.cjs`)
**Responsibility:** GPU Hub callback processing. Supports IU image completion with PG verification, audio merge with padded text trimming, video dispatch.

**Inputs:** HTTP POST / callback from GPU Hub.
**Outputs:** orchestrator.handleAudioCompleted / handleImageCompleted / handleVideoCompleted calls.

### 4.10 Chat Engine (`backend/src/services/chat-engine.cjs`)
**Responsibility:** AI assistant chat. Dialog history management. Supports modes (chat, edit, director, import, analyze, validate) with tool-based architecture (edit_book, write_storyboard, import_book, extract_entities, validate_book).

### 4.11 Gen Scope (`backend/src/services/gen-scope.js`)
**Responsibility:** Generation scope persistence (whole_book / current_chapter / current_scene / from_current_scene).

### 4.12 Layer Config (`backend/src/services/layer-config.js`)
**Responsibility:** Per-book generation profiles (AUDIO_ONLY, IMAGE_ONLY, VIDEO_ONLY, STORYBOARD, FULL).

### 4.13 Scene Asset Registry (`backend/src/services/scene-asset-registry.js`)
**Responsibility:** PostgreSQL scene asset registry (audio/image/video/storyboard). Replaces Redis registry.

### 4.14 Book Event Log (`backend/src/services/book-event-log.js`)
**Responsibility:** PostgreSQL book event journal (replaces Redis event journal). 30+ event types.

### 4.15 Book Source (`backend/src/services/book-source.js`)
**Responsibility:** Canonical scene index from Book JSON. Scene existence validation, fingerprinting.

### 4.16 Book Sync (`backend/src/services/book-sync.js`)
**Responsibility:** Book JSON synchronization with derived DB state. Detection of added/modified/deleted scenes via scene_hash.

### 4.17 Cleanup Service (`backend/src/services/cleanup-service.cjs`)
**Responsibility:** Build lifecycle management, distributed cleanup locks, periodic stale audio scene lock cleanup.

### 4.18 GPU Hub Cleanup
**Responsibility:** GPU Hub stale task cleanup on regenerate/cancel (in `routes/book/generation-routes.cjs`).

**Function `clearGpuHubQueues(redis, bookId, sceneFilter?)`:**
- Clears dedup keys `animastor:job:*` and `animastor:result-processed:*`
- Filters queues `animastor:queue:audio|image|video`
- Removes running tasks from `animastor:running`
- Clears result cache `animastor:result:*`
- sceneFilter allows cleaning only tasks for specific scenes

### 4.19 Audio Orchestrator (`backend/src/services/audio-orchestrator.js`)
**Responsibility:** Unified state machine for scene audio generation.

**Phase machine:** `NEW → PLACEHOLDER_READY → GENERATING → WAITING_CHUNKS → MERGING → FAILED/DONE`

**Role:** Sole owner of merge orchestration. All components (startScene, executeAudioDispatch, completeChunk, completeMerge) read phase from Redis key `animastor:audio-orch:{bookId}:{chapterId}:{sceneId}` and make decisions ONLY based on phase.

**Invariants:** phase=DONE ⇔ asset.audio=READY; phase=FAILED ⇒ asset.audio=FAILED.

**Functions:** `completeChunk` (chunk acceptance, completeness check, retry logic, merge), `failWaitingScene` (sole owner of WAITING_CHUNKS → FAILED), `scanAllStates` (for recovery).

### 4.20 Video Orchestrator (`backend/src/services/video-orchestrator.js`)
**Responsibility:** State machine for scene video generation (mirror of audio-orchestrator).

**Phase machine:** `NEW → GENERATING → WAITING_CHUNKS → MERGING → FAILED/DONE`

**Problem solved (2026-08-11):** Scene video split into N groups (`_g1`..`_gN`), but first result called completeStage → finalizeDispatch deleted metadata/lease, remaining groups rejected. Solution — state machine modeled on audio-orchestrator.

**Difference from audio:** Video groups NOT merged into mandatory single file — chunks remain separate (`_gN.mp4`). Merging `_g1.._gN → scene.mp4` only performed for player.

### 4.21 Entity Cleanup (`backend/src/services/entity-cleanup.cjs`)
**Responsibility:** Deep cleanup on manual scene / unit (entity) deletion. Derived state deletion across all layers:

- **PostgreSQL** — scene_assets, generation_tasks, image_units, storyboard_elements, audio_layers, asset_states, cache_entries, scenes
- **Redis** — chunks, per-asset states, active index, audio/video orchestrators, dispatch leases, retry counters, GPU dedup keys
- **Filesystem** — audio/chunks/IU/preview/video scene files
- **In-flight** — GPU dispatch lease + hub job cancellation
  **Invalidation** — parent scene marked dirty for regeneration

**Safety:** Each step reports ok/error. Incomplete cleanups written to `animastor:pending-purge` set; periodic reconcileCycle retries (max 5 attempts).

### 4.22 Audio Recovery (`backend/src/services/audio-recovery.cjs`)
**Responsibility:** Periodic (5s) Redis scanning for lost audio/image result recovery.

### 4.20 Placeholder Audio (`backend/src/services/placeholder-audio.js`)
**Ответственность:** Генерация MP3-тишины для тайминга, замена placeholder → real audio при завершении TTS.

### 4.21 Waveform Service (`backend/src/services/waveform-service.js`)
**Ответственность:** Вычисление waveform для плеера.

### 4.22 AI Loader (`backend/src/services/ai-loader.js`)
**Ответственность:** Загрузка базы знаний AI с TTL-кэшированием (1 минута).

### 4.23 Knowledge Base (`backend/src/services/knowledge-base.js`)
**Ответственность:** Загрузка примеров/rules/skills из `backend/ai/`. **Важно:** Загружается, но НЕ включается в промпты agent-service (мёртвый код).

### 4.24 Auth Service (`backend/src/auth/auth-service.js`)
**Ответственность:** Аутентификация: register / login / logout / current-identity. Server-side sessions в PG, scrypt хеширование паролей.

**Ключевые модели:**
- **Guest Workspace MVP:** анонимный пользователь получает временный workspace (TTL 7 + grace 23 дня). Cookie `animastor_gid`.
- **Registered User:** username/password → session cookie `animastor_sid` (30 дней). Personal workspace привязан к пользователю.
- **Кросс-поддоменные сессии:** `COOKIE_DOMAIN=animastor.in` — одна сессия для animastor.in + app.animastor.in.
- **Guest→User conversion:** при register с live guest cookie — конвертация workspace in-place.

### 4.25 Auth Middleware (`backend/src/middleware/`)
**Ответственность:** Express middleware для разделения идентичности:

- **`auth-context.js`** — `authContext`: session/guest cookie → `req.user`/`req.workspace`; `requireAuth`: registered users only; `requireBookAccess`: workspace membership guard.
- **`ai-book-guard.js`** — `aiBookGuard`: AI chat endpoints book-scoped, resolve `req.scopedBookId`.
- **`workspace-ownership.js`** — `resolveWorkspaceForBook`: single point of resolution «кто владеет книгой».
- **`worker-auth-middleware.js`** — `requireWorkerAuth`: Bearer `wrk.*` token → `req.authenticatedWorker` (FAIL CLOSED).

### 4.26 Worker Auth Service (`backend/src/services/worker-auth.js`)
**Ответственность:** Единая граница аутентификации воркеров. FAIL CLOSED: missing/malformed/unknown/revoked credential → null (caller 401).

**Роль:**
- PG `workers` таблица — durable source of truth.
- Redis mirror `animastor:worker-auth` (hash: token_hash → identity JSON) — hot path для GPU Hub.
- Mirror поддерживается через startup rebuild + periodic resync (5 мин) + point updates на create/rotate/revoke.

**API:** `authenticateWorker`, `extractBearerToken`, `syncWorkerAuthMirror`, `mirrorPut`, `mirrorDrop`, `startWorkerAuthMirrorSync`.

### 4.27 Workspace AI Provider (`backend/src/services/workspace-ai-provider.js`)
**Ответственность:** Один активный AI провайдер на workspace. API key хранится в PG в AES-256-GCM (WORKSPACE_SECRET_KEY).

**Резолвер:** workspace row first → system fallback (admin kill switch enforced) → noProvider(). Кэш 30 сек, invalidated on write.

**Функции:** `resolveAIForWorkspace`, `resolveAIForBook`, `resolveAIProvider(workspaceId, purpose)`, `testConnection`, `upsertProvider`, `deleteProvider`.

### 4.28 System AI Control (`backend/src/services/system-ai.js`)
**Ответственность:** Platform-level AI kill switch + admin-configured system provider.

- **Kill switch:** `system_settings.system_ai` → `{enabled: boolean}`. Default ON.
- **System provider:** `system_ai_providers` row id='default'. Admin-configured endpoint/key/model.
- **Кэш:** enabled flag ~5 сек. `invalidateAll()` сбрасывает и workspace resolver cache.

### 4.29 Startup Resume (`backend/src/startup-resume.js`)
**Ответственность:** Возобновление прерванных сессий генерации при старте сервера.

### 4.30 Book Diff (`backend/src/services/book-diff.cjs`)
**Ответственность:** Сравнение сцен, вычисление diff, пометка dirty-сцен, применение profiles к layer config.

---

## 5. State Layer

### Per-Asset States (CANONICAL)
Каждый asset (audio/image/video) имеет независимое состояние (AssetState):
```
NEW → DIRTY → PENDING → GENERATING → READY | FAILED | PLACEHOLDER
```

**Ключевое изменение (v2.1.0):** Per-asset состояния — канонический источник истины. Линейная FSM **удалена**.

**T8 + Dead code cleanup (июль 2026):** `SceneState` enum, `syncLinearState()`, `deriveLinearState()`, `getSceneState()`, `setSceneState()`, `transitionSceneState()` — удалены. Ключи `animastor:scene-state:*` больше не пишутся; TTL cleanup удалён из backend.cjs. Все потребители мигрированы на per-asset `getAssetStates()`.

---

## 6. Storage Layer

### 6.1 PostgreSQL (`backend/src/storage/postgres/`)
**Ответственность:** Каноническое состояние. Схема: 30+ таблиц.

**Ключевые группы таблиц:**
- **Книга/структура:** books, book_snapshots, scenes, image_units, storyboard_elements, audio_layers, book_source
- **Состояние генерации:** scene_assets, asset_states, asset_dependencies, generation_tasks, output_manifests, book_generation_sessions, workers, reconciliation_events
- **AI-агент:** agent_sessions, agent_steps, agent_conversations, agent_messages
- **Чат:** chat_sessions, chat_messages, ai_chat_sessions
- **Аутентификация:** users, workspaces, workspace_members, sessions, guest_identities
- **AI провайдеры:** workspace_ai_providers, system_ai_providers, system_settings
- **Прочее:** users, cache_entries, book_events

**Репозитории** (`backend/src/storage/postgres/repositories/`) — 15 репозиториев:

| Репозиторий | Таблица | Роль |
|---|---|
| `book-repo.js` | books | CRUD книг, workspace ownership |
| `scene-assets-repo.js` | scene_assets | markReady, dirty flags, version bump |
| `iu-repo.js` | image_units | Image unit registry |
| `task-repo.js` | generation_tasks | Task tracking |
| `cache-repo.js` | cache_entries | Cache registry |
| `chat-repo.js` | chat_messages | AI chat messages |
| `chat-session-repo.js` | ai_chat_sessions | AI chat sessions |
| `events-repo.js` | book_events | Book event log |
| `gen-session-repo.js` | agent_sessions | Agent sessions |
| `book-source-repo.js` | book_source | Source dedup registry |
| `user-repo.js` | users | User CRUD, case-insensitive lookup |
| `workspace-repo.js` | workspaces + workspace_members | Workspace management |
| `session-repo.js` | sessions | Server-side sessions (token-hash only) |
| `guest-repo.js` | guest_identities | Guest workspace TTL + purge |
| `worker-repo.js` | workers | Worker registration, credential lifecycle |
| `generation-cancel-repo.js` | — | Generation cancellation tracking |

**Входы:** SQL-запросы от сервисов и репозиториев.
**Выходы:** Данные.

**Используют:** Все сервисы.

### 6.2 Redis (через ioredis)
**Ответственность:** Runtime-состояние: активные сцены, heartbeat воркеров, очереди задач, dispatch-аренда, dispatch-completed markers, квоты (counter), event journal (List), кэш чанков, scene state (JSON), per-asset state (HASH — HSET/HGETALL для атомарности), iu-progress (counter TTL 4h), iu-in-flight (EX 1200).

**Ключевые структуры:**
- `animastor:asset-state:<bookId>:<ch>:<sc>` — HASH с полями audio/image/video
- `animastor:dispatch-lease:*` — SET NX EX (15/20/30 min)
- `animastor:dispatch-completed:*` — SET NX EX (idempotency marker)
- `animastor:runtime:active-{audio,image,video}` — counter (backpressure quota)
- `animastor:event-journal:*` — List (append-only, TTL 7d)
- `animastor:chunk:*` — JSON metadata per chunk
- `animastor:iu-progress:*` — counter TTL 14400s
- `animastor:iu-in-flight:*` — marker EX 1200
- `animastor:worker-auth` — HASH (token_hash → identity JSON) — hot path для GPU Hub worker auth mirror
- `animastor:worker:heartbeat:<type>:<worker_id>` — JSON payload (liveness + scope: mode, workspace_id)
- `animastor:active-scenes` — SET активных сцен
- `animastor:queue:{type}[:ws:{workspaceId}]` — LIST очередей GPU Hub (system pool + workspace-scoped)
- `animastor:running` — HASH job_id → claim JSON (running tasks)
- `animastor:processing` — LIST (rpoplpush source)
- `animastor:job:*` — SET NX EX (dedup)
- `animastor:result:*` — STRING JSON (GPU results, TTL 1h)

**Персистентность:** Redis-данные сохраняются через docker volume `redis-data:/data`.

### 6.3 Filesystem (`backend/src/storage/filesystem-store.js`)
**Ответственность:** Хранение файлов: книги (JSON, multi-file format), аудио (MP3), изображения (PNG), видео (MP4), превью.

**Формат хранения книг (v2.1 multi-file):**
```
/data/books/<bookId>/
  manifest.json      # метаданные книги
  book.json          # структура (chapters_order)
  bible.json         # библеистика (опционально)
  characters.json    # персонажи (опционально)
  chapters/
    ch-XXXXXXXX.json # главы (Cover — первая)
```

**Пути данных:** `data/books/<bookId>/`, `data/output/<buildId>/`.

### 6.4 Asset Registry (`backend/src/storage/asset-registry.js`)
**Ответственность:** Redis-реестр asset'ов (используется в боевых колбэках через `storage.registry.*`).

**Важно:** Существует также `services/scene-asset-registry.js` (PostgreSQL-backed) с **теми же именами функций**, но он вызывается только из тестов и placeholder-audio — не из боевого пути. Это известная ловушка (см. `02_Claude_Audit.md §C3`).

> **UPD 2026-06-26:** Два registry с одинаковыми именами — C3. `scene_assets.status='ready'` не пишется в боевом пути — C2.

---

## 7. Workflow System

### 7.1 Workflow Loader (`backend/src/workflows/workflow-loader.js`)
**Ответственность:** Загрузка JSON-шаблонов ComfyUI из `/app/ai/workflows/`.

**Входы:** Имя workflow.
**Выходы:** Клон шаблона JSON.

**Используют:** audio/image/video-workflows.

### 7.2 Audio Workflows (`backend/src/workflows/audio/audio-workflows.js`)
**Ответственность:** Построение TTS workflow для наррации и диалогов.

### 7.3 Image Workflows (`backend/src/workflows/image/image-workflows.js`)
**Ответственность:** Построение workflow генерации изображений (img-qwen-image).

### 7.4 Video Workflows (`backend/src/workflows/video/video-workflows.js`)
**Ответственность:** Построение LTX video workflow (1p/2p/3p/4p в зависимости от количества IU).

---

## 8. GPU Infrastructure

### 8.1 GPU Hub (`gpu-hub/gpu-hub.js`)
**Ответственность:** Центральный диспетчер задач на GPU. Workspace-scoped очереди, дедупликация, таймауты (10 min), error delivery в backend, orphan sweep, dead letter.

**Ключевые особенности (PW-2/4):**
- **Workspace-scoped queues:** `queue:{type}:ws:{workspaceId}` для приватных воркеров; system pool `queue:{type}` для legacy/system.
- **Worker auth:** Bearer token через Redis mirror `animastor:worker-auth`. Identity derivable ONLY from credential.
- **Claimer-only:** /task/result и /task/error проверяют, что submitter = claimer (worker + workspace match).
- **Orphan sweep:** Processing entries без running record → requeue после grace (60s); max 3 requeues → dead letter.
- **Error delivery:** ошибки задач доставляются в backend → orchestrator.failStage (5 retries, fallback в Redis key).
- **Per-job timeout:** прокидывается из backend через layer-config (video может быть 20-60+ мин).
- **Worker source:** GET /worker-source отдаёт worker.cjs для onboarding.
- **API key auth:** GPU_HUB_API_KEY (header-only, FAIL CLOSED). GPU_HUB_ALLOW_OPEN=1 для dev.

**API:** POST /task, GET /task/next, POST /task/result, POST /task/error, POST /beacon, GET /health, GET /worker-source, DELETE /queue/clear.

**Зависимости:** Express, ioredis.

**Graceful shutdown:** SIGTERM → stopIntervals → server.close() → redis.quit()

### 8.2 Worker (`worker/worker/worker.cjs`)
**Ответственность:** GPU-воркер. CJS-модуль (Node 20+ с global fetch). Polling задач из GPU Hub, запуск ComfyUI, возврат base64-результата.

**Ключевые особенности (PW-2/4):**
- **Private worker mode:** `ANIMASTOR_WORKER_TOKEN=wrk.*` → Bearer credential на все hub calls. Workspace-scoped.
- **FAIL CLOSED (PW-4):** missing/invalid credential → 401 на всех worker-facing endpoints Hub'а. Нет uncredentialed lane.
- **Mode-scoped pop:** private → workspace queue ONLY; share/system → system pool ONLY. Cross-workspace access structurally impossible.
- **Per-job timeout:** `task.timeout_ms` пробрасывается из backend → hub → worker. Video fallback: 2 часа.
- **OOM-safe:** результаты читаются с диска (ComfyUI output), не через HTTP re-download.
- **Filesystem fallback:** видео-результаты ищутся в COMFY_OUTPUT_DIR если ComfyUI history не вернул.

**Поддержка:** image (single/multi), audio (TTS), video (LTX).

**Protocol:** PROTOCOL_VERSION=2. Несовместимые задачи отклоняются с `protocol_version_mismatch`.

---

## 9. Runtime Module (slim, v2.0.0)

Модуль `backend/src/runtime/index.js` экспортирует только активно используемые компоненты:

**Core pipeline:** scheduler, loop, activeScenes, reconciliation, dispatch, leaseManager, counterReconciliation, metrics, gpuDispatcher, workerHealth, sceneWindow.

**Error handling:** failureTaxonomy, retryManager, retentionManager.

**Debug (ленивая загрузка, не core):** snapshotManager, circuitBreaker, priorityManager, fairness, retryBudget, policyEngine, workloadClassifier, costEstimator, decisionTrace, feedback, governanceMetrics, adaptationController, governanceStability, governanceHealth, executionSemantics.

**Experimental (debug):** policySimulator, sandbox, failureReplay, validator.

---

## 10. Frontend (Android/Kotlin)

### 10.1 MainActivity (`frontend/app/.../MainActivity.kt`)
**Ответственность:** Single-activity с bottom navigation. 5 фрагментов.

### 10.2 GenerateViewModel
**Ответственность:** Запуск, мониторинг, отмена генерации, polling agent-status, функционал worker toggle.

**VBook progress (2026-07-02):**
- SSE `type="vbook"` использует backend-owned 1-based `scene_index`.
- Backend отдаёт точные счётчики текущего блока:
  `window_scene_index`, `window_total_scenes`, `window_start_scene`.
- `window_size` остаётся только fallback/cap для старых событий и не означает
  границу продвижения по исходному тексту.
- Frontend нормализует прогресс в 0-based `VBookProgress` и может показывать
  `0/N`, пока backend ещё только режет сцены.
- `MainActivity` запускает progress stream и для VBook-only работы; завершение
  VBook вызывает soft-refresh через `applyGenerationResults()`.
- `WindowTriggerManager` запускает следующее окно у хвоста уже загруженного
  контента, а не по каждому фиксированному третьему номеру сцены.

### 10.3 PlaybackViewModel
**Ответственность:** Воспроизведение сцен: текущая сцена, список сцен, прогресс, предзагрузка (preloadAhead=3).

### 10.4 SceneAudioPlayer
**Ответственность:** Плеер аудио на ExoPlayer (Media3).

### 10.5 BackendApi (Retrofit)
**Ответственность:** Определение всех REST-endpoint'ов.

---

## 11. External Dependencies

```
                    ┌──────────┐
                    │  Client  │
                    │ (Android)│
                    └────┬─────┘
                         │ HTTP
                    ┌────┴─────┐
                    │  Nginx   │ (proxy/conf/default.conf)
                    └────┬─────┘
                         │ /api/ → backend:3000
                         │ /gpu/ → gpu-hub:5000
                    ┌────┴─────┐
                    │  Backend │ ─── Redis ─── GPU Hub ─── Workers ─── ComfyUI
                    │  :3000   │ ─── PostgreSQL (25+ tables)
                    └──────────┘     ─── Filesystem (multi-file book format)
```

## 12. Dependency Graph (between subsystems)

```
┌───────────────────────────────────────────────────────────────────────────┐
│                            API Layer (Routes)                              │
│  book-routes ── generation-routes ── ai-routes ── debug-routes            │
└────────┬──────────────┬──────────────┬──────────────┬──────────────────────┘
         │              │              │              │
         ▼              ▼              ▼              ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                         Orchestration Layer                                 │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────────┐               │
│  │  Runtime     │→│  Dispatch      │→│  Scene            │               │
│  │  Scheduler   │  │  Engine        │  │  Orchestrator     │               │
│  │  (per-asset) │  │  (optional     │  │  (layer-aware)   │               │
│  │              │  │   governance)  │  │                   │               │
│  └──────────────┘  └────────────────┘  └────────┬─────────┘               │
│       │                                          │                         │
│       ▼                                          ▼                         │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────────┐               │
│  │  Scene       │  │  Active Scenes │  │  Event Journal   │               │
│  │  Window      │  │  Index         │  │  (Redis)         │               │
│  └──────────────┘  └────────────────┘  └──────────────────┘               │
└───────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                          Service Layer                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐                │
│  │  Audio   │  │  Image   │  │  Video   │  │  Agent      │                │
│  │  Service │  │  Service │  │  Service │  │  Service    │                │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬──────┘                │
│       │              │              │               │                      │
│  ┌────┴──────────────┴──────────────┴───────────────┴────┐                │
│  │                   GPU Dispatcher                       │                │
│  │              (send/sendVideo/sendUnified)              │                │
│  └──────────────────────────┬────────────────────────────┘                │
│                             │                                              │
│  ┌──────────────────────────┴────────────────────────────┐                │
│  │                   Task Handler                         │                │
│  │  (IU completion, audio merge, video dispatch)         │                │
│  └────────────────────────────────────────────────────────┘                │
│                                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐                │
│  │  AI Service │  │  Chat Engine │  │  (tool-based)   │                │
│  │  Builder     │  │(OpenRouter/  │  │  (tool-based)    │                │
│  │              │  │  Nvidia)     │  │                   │                │
│  └──────────────┘  └──────────────┘  └──────────────────┘                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐                │
│  │  Gen Scope   │  │  Layer Config│  │  Placeholder     │                │
│  │              │  │  (profiles)  │  │  Audio           │                │
│  ├──────────────┤  ├──────────────┤  ├──────────────────┤                │
│  │  Book Source │  │  Book Sync   │  │  Book Event    │                │
│  │  (canonical  │  │  (scene hash │  │  Log (PG)      │                │
│  │   scene idx) │  │  reconcile)  │  │                │                │
│  └──────────────┘  └──────────────┘  └──────────────────┘                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐                │
│  │  Gen Scope   │  │  Layer Config│  │  Cleanup/Audio   │                │
│  │              │  │  (profiles)  │  │  Recovery        │                │
│  │              │  │              │  │  (periodic)      │                │
│  └──────────────┘  └──────────────┘  └──────────────────┘                │
└───────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    State Layer (PER-ASSET — единственный source of truth)      │
│  ┌────────────────────────────────────────────────┐                         │
│  │  Per-Asset States (CANONICAL)                  │                         │
│  │  AssetState: NEW→DIRTY→PENDING→GENERATING→     │                         │
│  │              →READY/FAILED/PLACEHOLDER          │                         │
│  │  Redis: animastor:asset-state:<scene> (HASH)    │                         │
│  │  SceneState enum — удалён (T8, июль 2026)      │                         │
│  └──────────────────────┘  └──────────────────────────┘                    │
└───────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                          Storage Layer                                      │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────────┐               │
│  │  PostgreSQL  │  │  Redis         │  │  Filesystem      │               │
│  │  (25+ tables)│  │  (state/queues)│  │  (multi-file)    │               │
│  │              │  │  (persisted)   │  │                   │               │
│  └──────────────┘  └────────────────┘  └──────────────────┘               │
└───────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                     Workflow System / GPU Infrastructure                   │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────────┐               │
│  │  Workflow    │  │  Audio/Image/  │  │  GPU Hub →       │               │
│  │  Loader      │→│  Video         │→│  Workers →        │               │
│  │  (/data/     │  │  Workflow      │  │  ComfyUI          │               │
│  │   workflows/)│  │  Builders      │  │                   │               │
│  └──────────────┘  └────────────────┘  └──────────────────┘               │
└───────────────────────────────────────────────────────────────────────────┘
```

## 13. Governance Layer (Runtime)

| Компонент | Роль | Статус |
|-----------|------|--------|
| circuit-breaker.js | Размыкание цепи при превышении порога ошибок | **LIVE** (прямой require в dispatch-engine) |
| retry-budget-manager.js | Бюджет повторных попыток per-type | **LIVE** (прямой require в dispatch-engine) |
| fairness-engine.js | Предотвращение голодания сцен | **LIVE** (прямой require в dispatch-engine) |
| lease-manager.js | Управление продлением аренды | **CORE** |
| counter-reconciliation.js | Сверка счетчиков backpressure | **CORE** |

**Удалены из exports runtime/index.js (D.3/L1):**
- policy-engine, workload-classifier, cost-estimator — мёртвый код, safeRequire убран (Phase 6)
- decision-trace, feedback-engine, governance-*, adaptation-controller, execution-semantics — не в core pipeline
- snapshot-manager, runtime-persistence — удалены из exports (файлы на диске сохранены)
- policy-simulator, governance-sandbox, failure-replay, governance-validator — experimental, не экспортируются

> **UPD 2026-06-28:** `runtime/index.js` экспортирует только 11 модулей (против 37+ ранее). Governance facade (debug: {}) удалён. circuit-breaker/retry-budget/fairness — LIVE, напрямую require().

## 14. State Model (Per-Asset, Canonical)

### Единая модель состояний — Per-Asset

Линейная FSM **удалена** в v2.1.0. Валидация последовательных переходов (SceneTransitions) блокировала параллельный диспатч аудио и изображений.

Каждый asset (audio/image/video) имеет **независимое** состояние:

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  audio: NEW ──► DIRTY ──► PENDING ──► GENERATING ──► READY    │
│                 │                        │            │        │
│                 │                        ▼            │        │
│                 └───────────────────► FAILED          │        │
│                                                       │        │
│  image: NEW ──► DIRTY ──► PENDING ──► GENERATING ──► READY    │
│                 │                        │            │        │
│                 └───────────────────► FAILED          │        │
│                                                       │        │
│  video: NEW ──► DIRTY ──► PENDING ──► GENERATING ──► READY    │
│                 │                        │            │        │
│                 └───────────────────► FAILED          │        │
│                                                       │        │
└─────────────────────────────────────────────────────────────────┘

**Ключевые правила:**
- Audio, Image диспатчатся **НЕЗАВИСИМО** (параллельно)
- Video требует `image=READY` для старта (функциональная зависимость — видео собирается из IU-картинок)
- `SceneState` enum, `syncLinearState`, `deriveLinearState`, `getSceneState`, `setSceneState`, `transitionSceneState` — **удалены** (T8 + dead code cleanup, июль 2026). Per-asset — единственный source of truth.
- **Per-asset state хранится как Redis HASH** (`animastor:asset-state:<scene>`) для атомарного HSET/HGETALL — устранён RMW race между GET+merge+SET
- **Version gate** — `completeStage` проверяет PG-версию перед READY: stale GPU callback → DIRTY, не READY (M5 Шаг 5)
