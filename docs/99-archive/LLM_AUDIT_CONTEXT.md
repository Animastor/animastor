# LLM Audit Context: Animastor

## Назначение проекта

Animastor — AI-powered animated storytelling platform. Преобразует текстовые книги в мультимедийный контент (аудио, изображения, видео) через AI-анализ и GPU-генерацию.

**Архитектурный принцип:** Книга моделируется как процесс последовательного чтения, а не как статический текст. Система накапливает "память прочитанного" в JSON, прогрессивно обогащая мир книги.

**Tech Stack:** Node.js/Express (backend), Kotlin/Android (frontend), PostgreSQL 16 + Redis 7 (persisted), ComfyUI (GPU generation), OpenRouter API / Nvidia API (AI).

## Основные подсистемы

### 1. Backend API Server (`backend/src/backend.cjs`)
- Express-сервер на порту 3000
- DI-контейнер для ~30 сервисов
- Монтирует 6 route-модулей: books, generation, AI, debug, connector, workflow
- Helmet.js (security headers), express-rate-limit (500 req/min на /api/)
- Request ID middleware (crypto.randomUUID() для трассировки)
- Graceful shutdown (SIGTERM → server.close → redis.quit → pg.closePool)
- Startup resume (возобновление прерванных сессий генерации)

> **UPD 2026-06-26:** Исправлен rate limit (500, не 100). Аудит: `02_Claude_Audit.md §C1-C4`, `05_Documentation_Audit.md §LLM_AUDIT_CONTEXT`.

### 2. Orchestration Engine
Состоит из 3 ключевых компонентов:

- **Runtime Scheduler** (`runtime/runtime-scheduler.js`): Tick-based (5s), per-asset диспетчеризация (audio/image/video независимо)
- **Dispatch Engine** (`runtime/dispatch-engine.js`): Leases, quotas, backpressure + lazy governance modules
- **Scene Orchestrator** (`orchestration/scene-orchestrator.js`): Layer-aware dispatch (audio_enabled/image_enabled/video_enabled) — **~173 строки** (фасад, логика вынесена в scene-callbacks.js/scene-restoration.js/scene-utils.js)

### 3. AI Agent Pipeline (`services/agent-service.js`)
6-шаговый последовательный AI-пайплайн: structure (шаг 0) → characters → locations → scenes → IU → visuals

### 4. Storage
- **PostgreSQL (25+ таблиц)**: Каноническое состояние. Таблицы: users, books, book_snapshots, scenes, asset_states, cache_entries, asset_dependencies, generation_tasks, workers, reconciliation_events, output_manifests, image_units, storyboard_elements, audio_layers, scene_assets, ai_chat_sessions, chat_sessions, chat_messages, book_events, agent_sessions, agent_steps, agent_conversations, agent_messages, book_source, book_generation_sessions
- **Redis (persisted)**: Runtime-состояние, очереди GPU, dispatch-аренда, event journal, per-asset state, chunks
- **Filesystem (multi-file)**: Файлы книг (multi-file format v2.1), аудио, изображения, видео

### 5. GPU Infrastructure
- **GPU Hub** (`gpu-hub/gpu-hub.js`): Диспетчер задач, Redis-очереди, requeue при timeout (10 min), 5 retries на result forwarding
- **Workers** (`worker/worker/worker.js`): ESM-модули, ComfyUI-воркеры (image/audio/video), multi-image support

### 6. Android Frontend
- Kotlin, compileSdk=35, minSdk=24, targetSdk=35
- Retrofit/OkHttp HTTP client, ExoPlayer (Media3) для воспроизведения
- LruCache (50MB) + SimpleDiskCache (256MB)
- PreloadAhead=3 сцены

### 7. Workflow System (`backend/src/workflows/`)
- JSON-шаблоны ComfyUI в `/data/workflows/`
- Типы: tts-qwen-narrator, tts-qwen-dialogue, img-qwen-image, video-ltx-{1p,2p,3p,4p}

## Архитектурная схема

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

## Ключевые зависимости между компонентами

### Критические зависимости

| Компонент | Зависит от | Тип |
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

### Типы хранилищ и их потребители

**PostgreSQL (25+ таблиц):**
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

**Redis (основные key patterns):**
- `animastor:active-scenes` (Set) — активные сцены
- `animastor:dispatch-lease:*` (String) — аренда dispatch
- `animastor:dispatch-meta:*` (Hash) — метаданные dispatch
- `animastor:asset-state:*` (String) — per-asset состояния (NEW)
- `animastor:runtime:active-*` (String) — счётчики квот
- `animastor:queue:*` (List) — очереди GPU Hub
- `animastor:chunk:*` (String) — чанки сцен
- `animastor:event-journal:*` (List) — журнал событий (TTL 7 дней)
- `animastor:scene-state:*` (String) — linear FSM состояние сцены
- `animastor:layer-config:*` (String) — профили генерации

## Workflow (жизненный цикл сцены)

### DUAL STATE MODEL

**Per-Asset States (CANONICAL — для нового кода):**
```
audio: NEW → DIRTY → PENDING → GENERATING → READY | FAILED | PLACEHOLDER
image: NEW → DIRTY → PENDING → GENERATING → READY | FAILED
video: NEW → DIRTY → PENDING → GENERATING → READY | FAILED
```

**Linear FSM (LEGACY — производная проекция):**
```
NEW → AUDIO_PENDING → AUDIO_GENERATING → AUDIO_READY
    → IMAGE_PENDING → IMAGE_GENERATING → IMAGE_READY
    → VIDEO_PENDING → VIDEO_GENERATING → VIDEO_READY
```

### Полный жизненный цикл

```
1. TXT/текст импортируется → TXT Importer → RAW_IMPORTED
2. Agent Service (шаг 0 + 5 шагов, окнами по 3 сцены) → BOOTSTRAPPED
3. Сцены регистрируются в Active Scenes Index
4. Runtime Scheduler (tick 5s) проверяет per-asset состояния
5. Dispatch Engine принимает решение (lease, quota, circuit breaker)
6. Scene Orchestrator выполняет dispatch (layer-aware):
   a. Audio Service → TTS → GPU Hub → Worker → MP3
   b. Image Service → image → GPU Hub → Worker → PNG (независимо от audio!)
   c. Video Service → video → GPU Hub → Worker → MP4 (требует image=READY)
7. Callback → Task Handler → orchestrator → per-asset state update (syncLinearState убран из callback'ов в R6.1)
8. Scene complete → remove from active → window slide → следующая партия
9. Android плеер воспроизводит сгенерированный контент
```

## Агенты (AI Pipeline)

### 6-шаговый пайплайн

| Шаг | Функция | Что извлекает | Хранится в |
|-----|---------|---------------|------------|
| 0 | stepAnalyzeStructure | Автор, название, главы (первые 80 строк) | agent_steps (step_type: analyze_structure) |
| 1 | stepExtractCharacters | Персонажи (описание, внешность на EN для LTX) | agent_steps + characters.json |
| 2 | stepExtractLocations | Локации | agent_steps + bible.json |
| 3 | stepCreateScenes | Сцены (участники, место, время; окно=3) | agent_steps + chapters/*.json |
| 4 | stepCreateUnits | IU (визуальные единицы per scene) | agent_steps + chapter scenes |
| 5 | stepCreateVisuals | Промпты для генерации (shot, prompt) | agent_steps + chapter scenes |

**Модель:** qwen/qwen3.5-122b-a10b (default), qwen/qwen3-32b (docker-compose)
**API Base URL:** https://integrate.api.nvidia.com/v1 (default), https://api.aicredits.in/v1 (docker-compose)
**Окно:** 3 сцены / 4000 символов за раз
**Retry:** 3 попытки, timeout 180s (60s default)
**Хранение:** agent_sessions + agent_steps + agent_conversations + agent_messages (PostgreSQL)

## Генераторы

Формальной абстракции "генератор" нет. Три независимых сервиса.

## Коннекторы

Формальной системы коннекторов нет. GPU Dispatcher (send/sendUnified с 3 retries, 30s timeout), Task Handler (IU completion + audio merge). GPU Hub (10 min timeout, requeue, 5 retries result forward).

> **UPD 2026-06-26:** `sendVideo` не существует — только `send` и `sendUnified`.

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

## Основные риски

1. **Единая точка отказа — GPU Hub.** Нет failover, но есть requeue и дедупликация.
2. **Единая точка отказа — внешний AI API.** Нет автоматического переключения между OpenRouter и Nvidia.
3. **Dual State Model.** Per-asset + linear FSM добавляет сложность синхронизации.
4. **Чрезмерная связанность.** book-routes.cjs, scene-orchestrator.js, dispatch-engine.js.
5. **Отсутствие unit-тестов** для критических компонентов.
6. **Governance модули — часть LIVE, часть DEBUG.** circuit-breaker, retry-budget, fairness реально вызываются; policy-engine/workload-classifier/cost-estimator — мёртвые.
7. **Graceful shutdown — ИСПРАВЛЕНО.** SIGTERM в backend.cjs и gpu-hub.js.
8. **База знаний AI загружается, но не используется** в промптах (мёртвый код, кроме refineDraft).
9. **Два event-журнала:** Redis + PostgreSQL.
10. **Multi-file формат книг + legacy single-file поддержка.**

## Итоговые метрики проекта

| Метрика | Значение |
|---------|----------|
| Всего файлов (backend) | ~100 |
| Всего строк (backend) | ~20 000 |
| PostgreSQL таблиц | 25+ |
| Redis key patterns | 15+ |
| REST endpoint'ов | 40+ |
| Docker сервисов | 5 (postgres, redis, backend, gpu-hub, nginx) |
| Языки | JavaScript, Kotlin, SQL, Shell |
| Внешние зависимости | 10 npm + AndroidX + Retrofit + ExoPlayer |
| Тестов | 14 (все mocha) |
| Workflow шаблонов | 7 |
| AI pipeline steps | 6 (шаг 0 + 5) |
| GPU worker типов | 3 (audio/image/video) |
| Governance модулей (debug) | 15+ |
