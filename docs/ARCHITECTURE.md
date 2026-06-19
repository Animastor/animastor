# Architecture: Animastor

## 1. Backend Server (`backend/src/backend.cjs`)

**Ответственность:** Точка входа. Инициализация Redis/Express/PG, DI всех сервисов, монтирование роутов, запуск runtime loop.

**Входы:** HTTP-запросы (Express), сигналы от GPU Hub (callbacks через task-handler).

**Выходы:** HTTP-ответы, задачи в GPU Hub, данные в Redis/PG.

**Зависимости:** Express, ioredis, pg, multer, adm-zip, sharp, music-metadata, ws, uuid, cors, helmet, express-rate-limit.

**Встроенные улучшения:**
- **Helmet.js** — HTTP security headers (HSTS, CSP, X-Frame-Options, XSS-Protection)
- **Rate limiting** — 100 req/min на `/api/`, защита от перегрузок
- **Request ID** — каждый HTTP-запрос получает короткий ID (`crypto.randomUUID().slice(0,8)`) для трассировки
- **Graceful shutdown (SIGTERM)** — последовательное завершение: server.close() → redis.quit() → postgres.closePool()

**Используют:** Все внешние клиенты (Android, curl, браузер).

**Использует:** Все модули backend (`state`, `audio`, `image`, `video`, `workflows`, `orchestration`, `storage`, `runtime`, `book`, `services/*`).

---

## 2. API Layer (Routes)

### 2.1 Book Routes (`backend/src/routes/book-routes.cjs`)
**Ответственность:** Управление книгами: CRUD, импорт TXT, bootstrap, trigger-next-window, статус, agent-status, генерация, чанки, слайд-окно, реордер сцен.

**Входы:** HTTP `GET/POST/PUT/PATCH/DELETE /api/v1/book/*`
**Выходы:** JSON-ответы

### 2.2 Generation Routes (`backend/src/routes/generation-routes.cjs`)
**Ответственность:** Запуск/отмена генерации, gen-scope, layer-config, worker counts, прогресс.

### 2.3 AI Routes (`backend/src/routes/ai-routes.cjs`)
**Ответственность:** AI-чат ассистент, загрузка book в AI-контекст, управление сессиями чата.

### 2.4 Debug Routes (`backend/src/routes/debug-routes.cjs`)
**Ответственность:** Отладка: дампы состояния, очереди, ивент-журнал.

---

## 3. Orchestration Layer

### 3.1 Runtime Scheduler (`backend/src/runtime/runtime-scheduler.js`)

**Ответственность:** Единственный авторитет прогресса сцен. Tick-based (5s). Определяет, какие сцены нуждаются в диспетчеризации. Поддерживает независимые per-asset состояния (audio/image/video могут диспатчиться параллельно).

**Входы:** Redis (active scenes set), heartbeat worker'ов.
**Выходы:** Вызовы `dispatchEngine.dispatchStage()`.

**Зависимости:** Redis, dispatch-engine, active-scenes-index, scene-state, worker-health.
**Используют:** runtime-loop.
**Использует:** dispatch-engine, orchestrator, scene-window.

### 3.2 Dispatch Engine (`backend/src/runtime/dispatch-engine.js`)

**Ответственность:** Dispatch с lease-механизмом (предотвращение дублирования), quota-контроль (backpressure). Интеграция с governance-модулями (circuit-breaker, retry-budget, fairness-engine, policy-engine) — эти модули загружаются лениво через `safeRequire()` и находятся в `runtime.index.debug` (не входят в core pipeline).

**Входы:** Запрос на dispatch (bookId, chapterId, sceneId, stage).
**Выходы:** Решение о старте/пропуске/отложении dispatch'а.

**Зависимости:** Redis, lease-manager, runtime-config, counter-reconciliation, runtime-metrics.
**Опционально:** circuit-breaker, retry-budget-manager, fairness-engine, policy-engine, workload-classifier, cost-estimator.

**Используют:** runtime-scheduler.
**Использует:** orchestrator.dispatchStage().

### 3.3 Scene Orchestrator (`backend/src/orchestration/scene-orchestrator.js`)

**Ответственность:** Центральный оркестратор жизненного цикла сцены. Dispatch execution (audio/image/video), обработка callback'ов завершения, layer config checks (audio_enabled/image_enabled/video_enabled), stale state tolerance, padded text trimming.

**Входы:** Команды dispatch (с overrideStage для per-asset диспетчеризации), callback'и от GPU Hub.
**Выходы:** Задачи в audio/image/video service, обновления состояния.

**Зависимости:** audio-service, image-service, video-service, scene-state, event-journal, active-scenes-index, layer-config, gpu-dispatcher.
**Используют:** dispatch-engine, task-handler.
**Использует:** audio/image/video services, gpu-dispatcher, event-journal, scene-state.

### 3.4 Scene Window (`backend/src/runtime/scene-window.js`)

**Ответственность:** Управление окном генерации (scope-aware). Старт/стоп/слайд окна по мере завершения сцен. Включает проверку наличия контента на диске (`sceneHasValidContent`), восстановление статусов чанков (`reconcileWindowStatuses`, `restoreChunkStatusForScene`), поддержку cancel-флага.

**Входы:** Команды start/stop/slide.
**Выходы:** Регистрация сцен в active-scenes, dispatch задач.

### 3.5 Event Journal (`backend/src/orchestration/event-journal.js`)

**Ответственность:** Append-only журнал событий сцены в Redis. Аудит жизненного цикла. TTL 7 дней.

**Входы:** События (SCENE_STARTED, AUDIO_STARTED, и т.д.).
**Выходы:** Ничего (только запись).

### 3.6 Active Scenes Index (`backend/src/runtime/active-scenes-index.js`)

**Ответственность:** Redis-набор `animastor:active-scenes` для отслеживания сцен в обработке.

---

## 4. Service Layer

### 4.1 Audio Service (`backend/src/audio/audio-service.js`)
**Ответственность:** TTS-генерация через GPU Hub, мерж аудиочанков через ffmpeg, placeholder-аудио, silence-trimming, book-level audio merge, padded text trimming.

**Входы:** sceneData, loadedBook, buildId, bookId.
**Выходы:** Аудиофайлы (MP3), вызовы gpu.send().

**Зависимости:** gpu-dispatcher, workflow-loader, audio-workflows.

### 4.2 Image Service (`backend/src/image/image-service.js`)
**Ответственность:** Генерация изображений IU через GPU Hub, построение промптов (персонажи, локации, окружение), кэширование, превью.

**Входы:** sceneData, loadedBook, buildId, bookId.
**Выходы:** PNG-файлы, вызовы gpu.send().

**Зависимости:** gpu-dispatcher, workflow-loader, image-workflows, context-builder.

### 4.3 Video Service (`backend/src/video/video-service.js`)
**Ответственность:** Генерация видео через LTX-модели (multi-image), чтение изображений для GPU assets.

**Входы:** sceneData, loadedBook, buildId.
**Выходы:** MP4-файлы, вызовы gpu.sendVideo().

**Зависимости:** gpu-dispatcher, workflow-loader, video-workflows.

### 4.4 Video Merge (`backend/src/video/video-merge.js`)
**Ответственность:** Мерж мультигрупповых видео в сцену, book-level merge, muxing видео+аудио.

### 4.5 Agent Service (`backend/src/services/agent-service.js`)
**Ответственность:** 5-шаговый AI-пайплайн (структура извлекается отдельно): персонажи → локации → сцены → units → визуал.

**Входы:** bookId, sourceText.
**Выходы:** JSON-структура книги в PG (agent_sessions, agent_steps, agent_conversations).

**Зависимости:** ai-service, context-builder, book, postgres.

### 4.6 TXT Importer (`backend/src/services/txt-importer.js`)
**Ответственность:** Импорт TXT: декодирование (UTF-8/CP1251), валидация, создание draft, вызов agent-service.

**Входы:** Buffer (TXT file) или string (AI text).
**Выходы:** Draft-книга на диске.

### 4.7 Window Generator (`backend/src/services/window-generator.cjs`)
**Ответственность:** Фоновая обработка следующего окна: вызов bootstrapNextWindow, создание чанков, placeholder audio, регистрация сцен для GPU.

### 4.8 AI Service (`backend/src/services/ai-service.js`)
**Ответственность:** Клиент внешнего AI API (OpenRouter + Nvidia). Вызов с ретраями и парсинг JSON. Единый ключ: `OPENROUTER_API_KEY`. Включает функцию `refineDraft()` с загрузкой примеров из `ai/examples/`.

### 4.9 Context Builder (`backend/src/services/context-builder.js`)
**Ответственность:** Сборка контекста для AI из книги (персонажи, локации, сцены).

### 4.10 Task Handler (`backend/src/services/task-handler.cjs`)
**Ответственность:** Обработка callback'ов от GPU Hub. Поддерживает IU image completion с проверкой PG, аудио-мерж с padded text trimming, video dispatch.

**Входы:** HTTP POST / callback от GPU Hub.
**Выходы:** Вызовы orchestrator.handleAudioCompleted / handleImageCompleted / handleVideoCompleted.

### 4.11 Chat Engine (`backend/src/services/chat-engine.cjs`)
**Ответственность:** AI-чат для ассистента. Управление историей диалога. Поддерживает режимы (chat, edit, director, import, analyze, validate) с tool-based архитектурой (edit_book, write_storyboard, import_book, extract_entities, validate_book).

### 4.12 Gen Scope (`backend/src/services/gen-scope.js`)
**Ответственность:** Персистентность области генерации (whole_book / current_chapter / current_scene / from_current_scene).

### 4.13 Layer Config (`backend/src/services/layer-config.js`)
**Ответственность:** Профили генерации per-book (AUDIO_ONLY, IMAGE_ONLY, VIDEO_ONLY, STORYBOARD, FULL).

### 4.14 Scene Asset Registry (`backend/src/services/scene-asset-registry.js`)
**Ответственность:** PostgreSQL-реестр asset'ов сцены (audio/image/video/storyboard). Замена Redis-реестра.

### 4.15 Book Event Log (`backend/src/services/book-event-log.js`)
**Ответственность:** PostgreSQL-журнал событий книги (замена Redis event journal). 30+ типов событий.

### 4.16 Book Source (`backend/src/services/book-source.js`)
**Ответственность:** Канонический индекс сцен из Book JSON. Валидация существования сцен, fingerprinting.

### 4.17 Book Sync (`backend/src/services/book-sync.js`)
**Ответственность:** Синхронизация Book JSON с производным состоянием БД. Обнаружение добавленных/изменённых/удалённых сцен через scene_hash.

### 4.18 Book Integrity (`backend/src/services/book-integrity.js`)
**Ответственность:** Проверка целостности: обнаружение orphan-записей в таблицах, привязанных к сценам.

### 4.19 Chat Store (`backend/src/services/chat-store.js`)
**Ответственность:** Полноценное хранилище чатов с поддержкой сессий, топиков, поиска.

### 4.20 Cleanup Service (`backend/src/services/cleanup-service.cjs`)
**Ответственность:** Управление жизненным циклом сборок, распределённые блокировки очистки, периодическая очистка stale audio scene locks.

### 4.21 Audio Recovery (`backend/src/services/audio-recovery.cjs`)
**Ответственность:** Периодическое (5s) сканирование Redis для восстановления потерянных audio/image результатов.

### 4.22 Placeholder Audio (`backend/src/services/placeholder-audio.js`)
**Ответственность:** Генерация MP3-тишины для тайминга, замена placeholder → real audio при завершении TTS.

### 4.23 Waveform Service (`backend/src/services/waveform-service.js`)
**Ответственность:** Вычисление waveform для плеера.

### 4.24 AI Loader (`backend/src/services/ai-loader.js`)
**Ответственность:** Загрузка базы знаний AI с TTL-кэшированием (1 минута).

### 4.25 Knowledge Base (`backend/src/services/knowledge-base.js`)
**Ответственность:** Загрузка примеров/rules/skills из `backend/ai/`. **Важно:** Загружается, но НЕ включается в промпты agent-service (мёртвый код).

### 4.26 Startup Resume (`backend/src/startup-resume.js`)
**Ответственность:** Возобновление прерванных сессий генерации при старте сервера.

### 4.27 Book Diff (`backend/src/services/book-diff.cjs`)
**Ответственность:** Сравнение сцен, вычисление diff, пометка dirty-сцен, применение profiles к layer config.

---

## 5. State Layer (Dual State Model)

### 5.1 Linear FSM (legacy)
Состояния сцены (SceneState):
```
NEW → AUDIO_PENDING → AUDIO_GENERATING → AUDIO_READY
    → IMAGE_PENDING → IMAGE_GENERATING → IMAGE_READY
    → VIDEO_PENDING → VIDEO_GENERATING → VIDEO_READY
```

### 5.2 Per-Asset States (CANONICAL — новый стандарт)
Каждый asset (audio/image/video) имеет независимое состояние (AssetState):
```
NEW → DIRTY → PENDING → GENERATING → READY | FAILED | PLACEHOLDER
```

**Ключевое изменение:** per-asset состояния — канонический источник истины. Linear FSM — производная проекция для обратной совместимости.

---

## 6. Storage Layer

### 6.1 PostgreSQL (`backend/src/storage/postgres/`)
**Ответственность:** Каноническое состояние. Схема: 25+ таблиц (users, books, book_snapshots, scenes, asset_states, cache_entries, asset_dependencies, generation_tasks, workers, reconciliation_events, output_manifests, image_units, storyboard_elements, audio_layers, scene_assets, ai_chat_sessions, chat_sessions, chat_messages, book_events, agent_sessions, agent_steps, agent_conversations, agent_messages, book_source, book_generation_sessions).

**Входы:** SQL-запросы от сервисов и репозиториев.
**Выходы:** Данные.

**Используют:** Все сервисы.

### 6.2 Redis (через ioredis)
**Ответственность:** Runtime-состояние: активные сцены, heartbeat воркеров, очереди задач, dispatch-аренда, квоты, event journal, кэш чанков, scene state, per-asset state.

**Входы:** SET/GET/DEL/SCAN от всего runtime.
**Выходы:** Данные для оркестрации.

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
**Ответственность:** Устаревший Redis-реестр asset'ов. Заменён на PostgreSQL-backed scene-asset-registry.

---

## 7. Workflow System

### 7.1 Workflow Loader (`backend/src/workflows/workflow-loader.js`)
**Ответственность:** Загрузка JSON-шаблонов ComfyUI из `/data/workflows/`.

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
**Ответственность:** Центральный диспетчер задач на GPU. Управление очередями (audio/image/video), дедупликация, таймауты (10 min), requeue при timeout, возврат результатов (с ретраем 5 попыток), heartbeat воркеров, очистка очередей per-book.

**API:** POST /task, GET /task/next, POST /task/result, POST /task/error, POST /beacon, GET /health, DELETE /queue/clear.

**Зависимости:** Express, ioredis.

**Graceful shutdown:** SIGTERM → server.close() → redis.quit()

### 8.2 Worker (`worker/worker/worker.js`)
**Ответственность:** GPU-воркер. ESM-модуль. Polling задач из GPU Hub, запуск ComfyUI, возврат base64-результата. Поддержка multi-image assets, filesystem fallback для видео.

**Поддержка:** image (single/multi), audio (TTS), video (LTX).

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
│  │  Context     │  │  AI Service  │  │  Chat Engine     │                │
│  │  Builder     │  │(OpenRouter/  │  │  (tool-based)    │                │
│  │              │  │  Nvidia)     │  │                   │                │
│  └──────────────┘  └──────────────┘  └──────────────────┘                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐                │
│  │  Gen Scope   │  │  Layer Config│  │  Placeholder     │                │
│  │              │  │  (profiles)  │  │  Audio           │                │
│  ├──────────────┤  ├──────────────┤  ├──────────────────┤                │
│  │  Book Source │  │  Book Sync   │  │  Book Integrity  │                │
│  │  (canonical  │  │  (scene hash │  │  (orphan detect) │                │
│  │   scene idx) │  │  reconcile)  │  │                   │                │
│  └──────────────┘  └──────────────┘  └──────────────────┘                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐                │
│  │  Chat Store  │  │  Book Event  │  │  Cleanup/Audio   │                │
│  │  (sessions,  │  │  Log (PG)    │  │  Recovery        │                │
│  │   topics)    │  │              │  │  (periodic)      │                │
│  └──────────────┘  └──────────────┘  └──────────────────┘                │
└───────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                       State Layer (DUAL MODEL)                             │
│  ┌──────────────────────┐  ┌──────────────────────────┐                    │
│  │  Linear FSM (legacy) │  │  Per-Asset States (NEW)  │                    │
│  │  SceneState:         │  │  AssetState:             │                    │
│  │  NEW→AUDIO→IMAGE→    │  │  NEW→DIRTY→PENDING→     │                    │
│  │  →VIDEO→READY        │  │  →GENERATING→READY/FAILED│                   │
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

## 13. Governance Layer (Runtime — Debug/Lazy)

| Компонент | Роль | Статус |
|-----------|------|--------|
| circuit-breaker.js | Размыкание цепи при превышении порога ошибок | DEBUG (ленивая загрузка) |
| retry-budget-manager.js | Бюджет повторных попыток per-type | DEBUG (ленивая загрузка) |
| fairness-engine.js | Предотвращение голодания сцен | DEBUG (ленивая загрузка) |
| policy-engine.js | Оценка политик диспетчеризации | DEBUG (ленивая загрузка) |
| workload-classifier.js | Классификация сложности сцены | DEBUG (ленивая загрузка) |
| cost-estimator.js | Оценка стоимости GPU-генерации | DEBUG (ленивая загрузка) |
| lease-manager.js | Управление продлением аренды | CORE |
| counter-reconciliation.js | Сверка счетчиков backpressure | CORE |
| decision-trace.js | Трассировка решений диспетчера | DEBUG |
| feedback-engine.js | Адаптивная обратная связь | DEBUG |
| governance-health.js | Мониторинг здоровья | DEBUG |
| governance-stability.js | Мониторинг стабильности | DEBUG |
| governance-metrics.js | Сбор метрик | DEBUG |
| governance-validator.js | Валидация политик | DEBUG/Experimental |
| governance-sandbox.js | Песочница для политик | DEBUG/Experimental |
| adaptation-controller.js | Адаптивное управление параметрами | DEBUG |
| execution-semantics.js | Семантика выполнения | DEBUG |
| policy-simulator.js | Симулятор политик | DEBUG/Experimental |
| failure-replay.js | Воспроизведение ошибок | DEBUG/Experimental |
| snapshot-manager.js | Менеджер снепшотов | DEBUG |

**Важно:** Governance-модули загружаются через `safeRequire()` и находятся в `runtime.index.debug` (не core pipeline).

## 14. Scene State Machine (Dual Model)

### 14.1 Linear FSM (Legacy)
```
                              ┌──────────────────────┐
                              │         NEW          │
                              └──────────┬───────────┘
                                         │ startScene()
                                         ▼
                              ┌──────────────────────┐
                         ┌───│    AUDIO_PENDING      │◄──── (если audio disabled)
                         │   └──────────┬───────────┘
                         │              │ dispatch audio
                         │              ▼
                         │   ┌──────────────────────┐
                         │   │   AUDIO_GENERATING   │
                         │   └──────────┬───────────┘
                         │              │ callback
                         │              ▼
                         │   ┌──────────────────────┐
                         │   │    AUDIO_READY       │
                         │   └──────────┬───────────┘
                         │              │ dispatch image
                         │              ▼
                         │   ┌──────────────────────┐
                         │   │   IMAGE_PENDING      │
                         │   └──────────┬───────────┘
                         │              │
                         │              ▼
                         │   ┌──────────────────────┐
                         │   │  IMAGE_GENERATING    │
                         │   └──────────┬───────────┘
                         │              │ callback
                         │              ▼
                         │   ┌──────────────────────┐
                         │   │    IMAGE_READY       │
                         │   └──────────┬───────────┘
                         │              │ dispatch video
                         │              ▼
                         │   ┌──────────────────────┐
                         │   │   VIDEO_PENDING      │
                         │   └──────────┬───────────┘
                         │              │
                         │              ▼
                         │   ┌──────────────────────┐
                         │   │  VIDEO_GENERATING    │
                         │   └──────────┬───────────┘
                         │              │ callback
                         │              ▼
                         └──►│     VIDEO_READY      │
                             └──────────────────────┘
```

### 14.2 Per-Asset States (Canonical)
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

Audio, Image, Video диспатчатся НЕЗАВИСИМО (параллельно).
Video требует image=READY для старта.
```
