# Architecture: Animastor

## 1. Backend Server (`backend/src/backend.cjs`)

**Ответственность:** Точка входа. Инициализация Redis/Express/PG, DI всех сервисов, монтирование роутов, запуск runtime loop.

**Входы:** HTTP-запросы (Express), сигналы от GPU Hub (callbacks через task-handler).

**Выходы:** HTTP-ответы, задачи в GPU Hub, данные в Redis/PG.

**Зависимости:** Express, ioredis, pg, multer, adm-zip, sharp, music-metadata, ws, uuid, cors.

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
**Ответственность:** AI-чат ассистент, загрузка book в AI-контекст.

### 2.4 Debug Routes (`backend/src/routes/debug-routes.cjs`)
**Ответственность:** Отладка: дампы состояния, очереди, ивент-журнал.

---

## 3. Orchestration Layer

### 3.1 Runtime Scheduler (`backend/src/runtime/runtime-scheduler.js`)

**Ответственность:** Единственный авторитет прогресса сцен. Tick-based (5s). Определяет, какие сцены нуждаются в диспетчеризации.

**Входы:** Redis (active scenes set), heartbeat worker'ов.
**Выходы:** Вызовы `dispatchEngine.dispatchStage()`.

**Зависимости:** Redis, dispatch-engine, active-scenes-index, scene-state, worker-health.
**Используют:** runtime-loop.
**Использует:** dispatch-engine, orchestrator, scene-window.

### 3.2 Dispatch Engine (`backend/src/runtime/dispatch-engine.js`)

**Ответственность:** Dispatch с lease-механизмом (предотвращение дублирования), quota-контроль (backpressure), интеграция с circuit-breaker, retry-budget, fairness-engine, policy-engine, workload-classifier, cost-estimator.

**Входы:** Запрос на dispatch (bookId, chapterId, sceneId, stage).
**Выходы:** Решение о старте/пропуске/отложении dispatch'а.

**Зависимости:** Redis, circuit-breaker, retry-budget-manager, fairness-engine, policy-engine, workload-classifier, cost-estimator, lease-manager, runtime-config.
**Используют:** runtime-scheduler.
**Использует:** orchestrator.dispatchStage().

### 3.3 Scene Orchestrator (`backend/src/orchestration/scene-orchestrator.js`)

**Ответственность:** Центральный оркестратор жизненного цикла сцены. Dispatch execution (audio/image/video), обработка callback'ов завершения.

**Входы:** Команды dispatch, callback'и от GPU Hub.
**Выходы:** Задачи в audio/image/video service, обновления состояния.

**Зависимости:** audio-service, image-service, video-service, scene-state, event-journal, active-scenes-index, layer-config, gpu-dispatcher.
**Используют:** dispatch-engine, task-handler.
**Использует:** audio/image/video services, gpu-dispatcher, event-journal, scene-state.

### 3.4 Scene Window (`backend/src/runtime/scene-window.js`)

**Ответственность:** Управление окном генерации (scope-aware). Старт/стоп/слайд окна по мере завершения сцен.

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

**Ответственность:** TTS-генерация через GPU Hub, мерж аудиочанков через ffmpeg, placeholder-аудио, silence-trimming, book-level audio merge.

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

**Ответственность:** 6-шаговый AI-пайплайн: структура → персонажи → локации → сцены → units → визуал.

**Входы:** bookId, sourceText.
**Выходы:** JSON-структура книги в PG (agent_sessions, agent_steps, agent_conversations).

**Зависимости:** ai-service, context-builder, book, postgres.

### 4.6 TXT Importer (`backend/src/services/txt-importer.js`)

**Ответственность:** Импорт TXT: декодирование (UTF-8/CP1251), валидация, создание draft, вызов agent-service, lazy-parse.

**Входы:** Buffer (TXT file) или string (AI text).
**Выходы:** Draft-книга на диске.

### 4.7 Window Generator (`backend/src/services/window-generator.cjs`)

**Ответственность:** Фоновая обработка следующего окна: вызов bootstrapNextWindow, создание чанков, placeholder audio, регистрация сцен для GPU.

### 4.8 AI Service (`backend/src/services/ai-service.js`)

**Ответственность:** Клиент внешнего AI API (OpenRouter / NVIDIA). Вызов с ретраями и парсинг JSON.

### 4.9 Context Builder (`backend/src/services/context-builder.js`)

**Ответственность:** Сборка контекста для AI из книги (персонажи, локации, сцены).

### 4.10 Task Handler (`backend/src/services/task-handler.cjs`)

**Ответственность:** Обработка callback'ов от GPU Hub. Маршрутизация в orchestrator.handle*Completed().

**Входы:** HTTP POST / callback от GPU Hub.
**Выходы:** Вызовы orchestrator.handleAudioCompleted / handleImageCompleted / handleVideoCompleted.

### 4.11 Chat Engine (`backend/src/services/chat-engine.cjs`)

**Ответственность:** AI-чат для ассистента. Управление историей диалога.

### 4.12 Gen Scope (`backend/src/services/gen-scope.js`)

**Ответственность:** Персистентность области генерации (whole_book / current_chapter / current_scene / from_current_scene).

### 4.13 Layer Config (`backend/src/services/layer-config.js`)

**Ответственность:** Профили генерации per-book (AUDIO_ONLY, IMAGE_ONLY, VIDEO_ONLY, STORYBOARD, FULL).

---

## 5. Storage Layer

### 5.1 PostgreSQL (`backend/src/storage/postgres/`)

**Ответственность:** Каноническое состояние. Схема: 15+ таблиц (books, sources, scenes, iu, scenes_assets, characters, locations, chat_sessions, chat_messages, agent_sessions, agent_steps, agent_conversations, agent_messages, book_generation_sessions, events, cache).

**Входы:** SQL-запросы от сервисов и репозиториев.
**Выходы:** Данные.

**Используют:** Все сервисы.

### 5.2 Redis (через ioredis)

**Ответственность:** Runtime-состояние: активные сцены, heartbeat воркеров, очереди задач, dispatch-аренда, перенос (lease), квоты, event journal, кэш чанков, scene state.

**Входы:** SET/GET/DEL/SCAN от всего runtime.
**Выходы:** Данные для оркестрации.

### 5.3 Filesystem (`backend/src/storage/filesystem-store.js`)

**Ответственность:** Хранение файлов: книги (JSON), аудио (MP3), изображения (PNG), видео (MP4), превью.

**Пути:** `data/books/<bookId>/`, `data/output/<buildId>/`.

### 5.4 Asset Registry (`backend/src/storage/asset-registry.js`)

**Ответственность:** Регистрация сгенерированных asset'ов (audio/image/video) в файловой системе.

---

## 6. Workflow System

### 6.1 Workflow Loader (`backend/src/workflows/workflow-loader.js`)

**Ответственность:** Загрузка JSON-шаблонов ComfyUI из `/data/workflows/`.

**Входы:** Имя workflow.
**Выходы:** Клон шаблона JSON.

**Используют:** audio/image/video-workflows.

### 6.2 Audio Workflows (`backend/src/workflows/audio/audio-workflows.js`)

**Ответственность:** Построение TTS workflow для наррации и диалогов.

### 6.3 Image Workflows (`backend/src/workflows/image/image-workflows.js`)

**Ответственность:** Построение workflow генерации изображений (img-qwen-image).

### 6.4 Video Workflows (`backend/src/workflows/video/video-workflows.js`)

**Ответственность:** Построение LTX video workflow (1p/2p/3p/4p в зависимости от количества IU).

---

## 7. GPU Infrastructure

### 7.1 GPU Hub (`gpu-hub/gpu-hub.js`)

**Ответственность:** Центральный диспетчер задач на GPU. Управление очередями (audio/image/video), дедупликация, таймауты, возврат результатов.

**API:** POST /task, GET /task/next, POST /task/result, POST /task/error, POST /beacon, GET /health, DELETE /queue/clear.

**Зависимости:** Express, ioredis.

### 7.2 Worker (`worker/worker/worker.js`)

**Ответственность:** GPU-воркер. Polling задач из GPU Hub, запуск ComfyUI, возврат base64-результата.

**Поддержка:** image (single/multi), audio (TTS), video (LTX).

---

## 8. Frontend (Android/Kotlin)

### 8.1 MainActivity (`frontend/app/.../MainActivity.kt`)
**Ответственность:** Single-activity с bottom navigation. 5 фрагментов.

### 8.2 GenerateViewModel
**Ответственность:** Запуск, мониторинг, отмена генерации, polling agent-status, функционал worker toggle.

### 8.3 PlaybackViewModel
**Ответственность:** Воспроизведение сцен: текущая сцена, список сцен, прогресс.

### 8.4 SceneAudioPlayer
**Ответственность:** Плеер аудио на ExoPlayer (Media3).

### 8.5 BackendApi (Retrofit)
**Ответственность:** Определение всех REST-endpoint'ов.

---

## 9. External Dependencies

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
                    │  :3000   │ ─── PostgreSQL
                    └──────────┘        ─── Filesystem
```

## 10. Dependency Graph (between subsystems)

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
│  └──────────────────────────┬────────────────────────────┘                │
│                             │                                              │
│  ┌──────────────────────────┴────────────────────────────┐                │
│  │                   Task Handler                         │                │
│  └────────────────────────────────────────────────────────┘                │
│                                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐                │
│  │  Context     │  │  AI Service  │  │  Chat Engine     │                │
│  │  Builder     │  │  (OpenRouter)│  │                  │                │
│  └──────────────┘  └──────────────┘  └──────────────────┘                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐                │
│  │  Gen Scope   │  │  Layer Config│  │  Placeholder     │                │
│  │              │  │              │  │  Audio           │                │
│  └──────────────┘  └──────────────┘  └──────────────────┘                │
└───────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                          Storage Layer                                      │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────────┐               │
│  │  PostgreSQL  │  │  Redis         │  │  Filesystem      │               │
│  │  (15 tables) │  │  (state/queues)│  │  (files)         │               │
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

## 11. Governance Layer (Runtime)

| Компонент | Роль |
|-----------|------|
| circuit-breaker.js | Размыкание цепи при превышении порога ошибок |
| retry-budget-manager.js | Бюджет повторных попыток per-type |
| fairness-engine.js | Предотвращение голодания сцен |
| policy-engine.js | Оценка политик диспетчеризации |
| workload-classifier.js | Классификация сложности сцены |
| cost-estimator.js | Оценка стоимости GPU-генерации |
| lease-manager.js | Управление продлением аренды |
| counter-reconciliation.js | Сверка счетчиков backpressure |
| decision-trace.js | Трассировка решений диспетчера |
| feedback-engine.js | Адаптивная обратная связь |
| governance-health.js | Мониторинг здоровья |
| governance-stability.js | Мониторинг стабильности |
| governance-metrics.js | Сбор метрик |
| governance-validator.js | Валидация политик |
| governance-sandbox.js | Песочница для политик |
| adaptation-controller.js | Адаптивное управление параметрами |
| execution-semantics.js | Семантика выполнения |

## 12. Scene State Machine

```
                              ┌──────────────────────┐
                              │         NEW          │
                              └──────────┬───────────┘
                                         │ startScene()
                                         ▼
                              ┌──────────────────────┐
                         ┌───│    AUDIO_PENDING      │◄──── (если audio disabled)
                         │   └──────────┬───────────┘       │
                         │              │ dispatch audio    │
                         │              ▼                   │
                         │   ┌──────────────────────┐       │
                         │   │   AUDIO_GENERATING   │       │
                         │   └──────────┬───────────┘       │
                         │              │ callback          │
                         │              ▼                   │
                         │   ┌──────────────────────┐       │
                         │   │    AUDIO_READY       │       │
                         │   └──────────┬───────────┘       │
                         │              │ dispatch image    │
                         │              ▼                   │
                         │   ┌──────────────────────┐       │
                         │   │   IMAGE_PENDING      │◄──────│ (если image disabled)
                         │   └──────────┬───────────┘       │
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
                         │   ┌──────────────────────┐       
                         └──►│     VIDEO_READY      │       
                             └──────────────────────┘       
```
