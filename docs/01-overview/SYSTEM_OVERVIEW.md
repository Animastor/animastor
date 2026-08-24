# System Overview: Animastor

## Назначение проекта

Animastor — AI-powered animated storytelling platform. Система преобразует текстовые книги в мультимедийный опыт с аудионаррацией, изображениями и видео. Проект реализует конвейер от импорта текста до генерации анимационного видеоряда.

## Основные сценарии использования

1. **Импорт книги** — пользователь загружает TXT-файл или вводит текст; система через AI-агентов анализирует структуру, извлекает персонажей, локации, сцены.
2. **Просмотр и редактирование** — пользователь просматривает структуру книги (главы, сцены), редактирует метаданные, персонажей, локации.
3. **Генерация мультимедиа** — система последовательно генерирует аудио (TTS), изображения, видео для каждой сцены.
4. **Воспроизведение** — Android-приложение воспроизводит сгенерированный контент (аудио + видео) с навигацией по сценам.
5. **AI-ассистент** — чат с AI-моделью для помощи в написании и редактировании.

## Задачи, решаемые системой

- Извлечение структуры из неформатированного текста (главы, сцены).
- Идентификация и характеристика персонажей и локаций через AI.
- Разбиение повествования на визуальные единицы (кадры/IU).
- Генерация TTS-аудио с поддержкой диалогов (разные голоса).
- Генерация изображений для каждой визуальной единицы.
- Генерация видео через анимацию последовательностей изображений (LTX).
- Оркестрация пайплайна генерации с контролем состояния, очередями, повторными попытками.
- Управление жизненным циклом книги: импорт → AI-анализ → генерация → воспроизведение.

## Ключевые подсистемы

### Backend (Node.js/Express)
Центральный сервер API + оркестратор. Управляет состоянием книги, сценами, dispatching задач на GPU.
- **State Model (Per-Asset):** per-asset состояния (audio/image/video) — канонический источник истины. Линейная FSM и SceneState enum удалены в v2.2.0/T8 (блокировала параллельный диспатч). Per-asset состояния хранятся как Redis HASH (HSET/HGETALL) — атомарные per-field операции, без RMW race.
- **Orchestrator Facade (M5):** Единый арбитр состояния — 11 команд (markDirty, markDirtyScene, planScene, beginStage, completeStage, completeStageWithoutVideo, completeStageWithoutImage, setScenePending, setSceneAllReady, setScenePlaceholder, reconcile). Все писатели lifecycle-состояния проходят через фасад.
- **Version Gate:** `completeStage` проверяет PG-версию перед READY — stale GPU callback не отменяет force-regen.
- **Atomic Quotas:** Lua EVAL для атомарного acquire квоты — устранён race condition между checkQuota (GET) и incrementActiveCounter (INCR).
- **Idempotent Completion:** markDispatchCompleted защищён SET NX по dispatch-token — повторный колбэк безвреден.
- **Governance:** circuit-breaker, retry-budget-manager, fairness-engine — LIVE, напрямую require() в dispatch-engine. Policy-engine/workload-classifier/cost-estimator — удалены из exports (мёртвый код).
- **Helmet.js** — HTTP security headers (HSTS, CSP, X-Frame-Options)
- **Rate limiting** — 500 req/min на `/api/`, защита от перегрузок
- **Request ID** — каждый HTTP-запрос получает короткий ID для трассировки в логах
- **Graceful shutdown (SIGTERM)** — HTTP server → Redis → PostgreSQL последовательное завершение
- **Startup resume** — возобновление прерванных сессий генерации при старте

### Frontend (Web + Android)
- **Web (Preact + Vite):** Responsive SPA (`frontends/app/`): MobileShell (<1180px) / DesktopShell (≥1180px). Pages: File, Generator, Player, Editor, Navigator, Settings.
- **Android (Kotlin):** Single-activity с bottom-навигацией: файлы/библиотека/редактор/плеер/навигация/AI/настройки (`frontends/android/`).

### Auth & Identity (август 2026)
- **Authentication MVP:** register/login/logout (auth-service.js), server-side sessions в PG (token-hash-only), scrypt пароли.
- **Guest Workspace:** анонимный пользователь → временный workspace (TTL 7 + grace 23 дня). Cookie `animastor_gid`.
- **Session cookie:** `animastor_sid` (HttpOnly, 30 дней). Кросс-поддоменные через COOKIE_DOMAIN=animastor.in.
- **Workspace ownership:** `resolveWorkspaceForBook` — single point of resolution. Книги привязаны к workspace через books.workspace_id.
- **Book access guards:** `requireBookAccess` — workspace membership check на всех book-keyed endpoints.
- **Guest→User conversion:** при register с live guest cookie — конвертация workspace in-place.

### Worker Auth (PW-1/2/4, август 2026)
- **FAIL CLOSED credential model:** `wrk.<worker_id>.<secret>` → worker identity. Malformed/unknown/revoked → 401.
- **PG authoritative:** `workers` таблица — durable source of truth. Redis mirror `animastor:worker-auth` — hot path для GPU Hub.
- **Three modes:** private (workspace-owned), share (workspace-owned, community pool), system (Animastor-operated, workspace-less).
- **workers_scope_check:** CHECK constraint — mode ≠ system → workspace_id NOT NULL.
- **Worker routes:** POST /api/v1/worker/verify, POST/GET/GET/:id/POST/:id/rotate/DELETE /api/v1/workers (user-only, workspace-scoped). PW-4: mode support (private/share), confirm_share for share.
- **GPU Hub auth:** Bearer token через Redis mirror; workspace-scoped queues.

### Admin System (август 2026)
- **Admin routes:** /api/v1/admin/system-ai (kill switch + system provider) + /api/v1/admin/workers/system (SYSTEM worker registry: create/list/rotate/revoke).
- **Guard:** requireAdmin (role='admin' OR ADMIN_USERNAMES allowlist). Второй слой: nginx Basic Auth на admin.animastor.in.
- **System AI control:** kill switch + system provider (admin-configured endpoint/key/model).

### Workspace AI Provider (август 2026)
- **Per-workspace AI provider:** один активный провайдер на workspace.
- **AES-256-GCM encryption:** API keys хранятся в PG encrypted (WORKSPACE_SECRET_KEY).
- **Resolver chain:** workspace row → system fallback (kill switch enforced) → noProvider().
- **Connection testing:** /api/v1/settings/ai/test (не сохраняет ключ).
- **SSRF guard:** endpoint validation (safeFetch) на всех user-controlled endpoints.

### Orchestration Layer
Пять компонентов:
1. **Runtime Scheduler** (tick-based, 5s) — чистая функция `shouldScheduleAssets()`, решает что генерировать, но НЕ пишет состояние (Д.2). Version-stale reset — явный пред-проход в `attemptDispatch()`.
2. **Dispatch Engine** — lease-механизм (NX TTL), quota-контроль (Lua-атомарный), governance (circuit-breaker/retry-budget/fairness).
3. **Orchestrator Facade** (`orchestrator.js`) — единственный API записи lifecycle-состояния. 11 команд, все пишут per-asset state. syncLinearState удалён (T8) — per-asset единственный source of truth.
4. **Scene Orchestrator** (`scene-orchestrator.js`) — dispatch execution (audio/image/video), чистый исполнитель без принятия решений о состоянии.
5. **Scene Window** — оконный менеджер, scope-aware, все записи через facade.

### Agent Service (AI Pipeline)
6-шаговый AI-пайплайн анализа текста (шаг 0 + 5 шагов):
структура → персонажи → локации → сцены (title + location.id + environment-override) → units → визуальные промпты.

Ключевое поведение (2026-07-02):
- Backend берёт от `currentOffset` текстовый буфер 1500 символов.
- AI создаёт до 3 сцен из начала буфера и может оставить хвост неиспользованным.
- Backend валидирует дословное непрерывное покрытие созданного префикса.
- `currentOffset` продвигается по `nextOffset` последней созданной сцены, а не
  по размеру буфера.
- Длительность сцены: цель ~20s, soft ceiling ~30s с одним repair retry.

### GPU Hub (Node.js)
Центральный диспетчер задач на GPU. Принимает задачи от backend, ставит в Redis-очереди, распределяет по воркерам. Graceful shutdown, requeue при timeout (10 min), heartbeat, per-book queue clear.

### Workers (Node.js + ComfyUI)
GPU-воркеры (CJS-модуль `worker.cjs`, Node 20+ с global fetch), выполняющие генерацию через ComfyUI: image (SD), audio (TTS), video (LTX). Поддержка multi-image assets. PW-2: private worker mode (`ANIMASTOR_WORKER_TOKEN=wrk.*` → Bearer credential), workspace-scoped queues. PW-4: FAIL CLOSED — missing credential → 401, нет uncredentialed lane.

### Workflow Loader + Connector System
- **Workflow Loader** — загружает JSON-шаблоны ComfyUI из `/app/ai/workflows/`
- **Connector System** — декларативный слой абстракции, внешняя карта nodeId → entity. Файлы в `/app/ai/connectors/`. Устраняет hardcoded node ID из кода бэкенда.
- **Entity Schema** (`entity-schema.js`) — все типы данных, которыми обмениваются backend и ComfyUI

### Storage
- **PostgreSQL (30+ таблиц)** — каноническое состояние (книги, сцены, assets, чаты, события, сессии агентов, image_units, scene_assets, cache_entries, generation_tasks, output_manifests, workers). Репозитории: `storage/postgres/repositories/` (15+ репозиториев: book, cache, task, iu, sceneAssets, chat, chatSession, events, genSession, bookSource, user, workspace, session, guest, worker, generation-cancel).
- **Redis (persisted)** — runtime-состояние: asset-state (HASH — канон per-asset state), worker-auth (HASH — auth mirror для GPU Hub), worker heartbeat (STRING JSON — liveness + scope), active-scenes (SET), очереди GPU (LIST: system pool + workspace-scoped), dispatch-аренда (SET NX TTL), dispatch-completed marker (NX), квоты (counter), event journal (List, TTL 7d), chunks, iu-progress, iu-in-flight.
- **Filesystem (multi-file)** — файлы книг (JSON, multi-file format), аудио (MP3), изображения (PNG), видео (MP4)

### Services Layer
15+ сервисов: Audio/Image/Video Service, Agent Service, TXT Importer, Chat Engine, Gen Scope, Layer Config, Book Source/Sync/Integrity, Scene Asset Registry, Book Event Log, Chat Store, Cleanup Service, Audio Recovery, Placeholder Audio, AI Loader, Knowledge Base, Waveform Service, Window Generator, Startup Resume, Book Diff, Workflow Manager.

### AI Knowledge Base
Markdown-файлы правил, навыков и JSON-примеры для промптинга AI-моделей. **Не используются в промптах** основного пайплайна (кроме refineDraft, который использует examples).

## Поток данных: от входа до результата

```
TXT / VBook
  │
  ▼
┌─────────────────┐
│  TXT Importer   │  → Декодирование, создание draft-книги (RAW_IMPORTED)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Agent Service  │  → 6-шаговый AI-анализ (буфер 1500 символов, до 3 сцен)
│  (bootstrap)    │  → Извлечение: структура, персонажи, локации,
└────────┬────────┘    сцены (title + environment-override), IU, визуальные промпты
         │
         ▼
┌─────────────────┐
│  Book Module    │  → Сохранение в multi-file format
│  (lazy-book)    │  → manifest.json, book.json, chapters/*.json
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Scene State    │  → Инициализация per-asset состояний
│  Orchestrator   │  → Добавление в active-scenes index
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
              │   Worker     │ → ComfyUI → Результат (base64)
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
              │ Sync Linear  │ → Linear FSM (derived)
              └──────────────┘
```

## Список основных компонентов и их роли

| Компонент | Файл | Роль |
|-----------|------|------|
| Backend entry | `backend/src/backend.cjs` | Инициализация сервера, DI, монтирование роутов, helmet/rate-limit, graceful shutdown, startup resume |
| Book routes | `backend/src/routes/book-routes.cjs` | REST API для книг, импорт, статус |
| AI routes | `backend/src/routes/ai-routes.cjs` | REST API для AI-ассистента |
| Generation routes | `backend/src/routes/generation-routes.cjs` | REST API для запуска генерации |
| Orchestrator facade | `backend/src/orchestration/orchestrator.js` | Единый арбитр состояния — 11 команд lifecycle, version gate на READY |
| Scene orchestrator | `backend/src/orchestration/scene-orchestrator.js` | Dispatch execution (audio/image/video), чистый исполнитель |
| Scene callbacks | `backend/src/orchestration/scene-callbacks.js` | handleAudioCompleted, handleImageCompleted, handleVideoCompleted |
| Scene restoration | `backend/src/orchestration/scene-restoration.js` | Восстановление статусов чанков/сцен при регенерации |
| Event journal | `backend/src/orchestration/event-journal.js` | Append-only журнал событий сцены в Redis (TTL 7d) |
| Runtime scheduler | `backend/src/runtime/runtime-scheduler.js` | Tick-based планировщик (5s), per-asset диспетчеризация, чистое решение (Д.2) |
| Runtime loop | `backend/src/runtime/runtime-loop.js` | Heartbeat runtime: тик + reconciliation + counter-reconciliation + метрики |
| Dispatch engine | `backend/src/runtime/dispatch-engine.js` | Lease (NX TTL), атомарные квоты (Lua EVAL), idempotent completion (NX), governance (circuit-breaker/retry-budget/fairness) |
| GPU dispatcher | `backend/src/runtime/gpu-dispatcher.js` | HTTP-клиент для отправки задач в GPU Hub (send/sendVideo/sendUnified) |
| Scene window | `backend/src/runtime/scene-window.js` | Оконный менеджер генерации (scope-aware, cancel, recover, все записи через facade) |
| Active scenes index | `backend/src/runtime/active-scenes-index.js` | Redis-индекс активных сцен |
| Scene state | `backend/src/state/scene-state.js` | Per-asset state (canonical, Redis HASH). SceneState enum удалён (T8). |
| Lease manager | `backend/src/runtime/lease-manager.js` | Продление аренды dispatch (TTL refresh) |
| Counter reconciliation | `backend/src/runtime/counter-reconciliation.js` | Сверка счётчиков backpressure |
| Reconciliation engine | `backend/src/runtime/reconciliation-engine.js` | Self-healing: auto-fix рассинхрона PG↔Redis |
| Circuit breaker | `backend/src/runtime/circuit-breaker.js` | LIVE: размыкание цепи при превышении порога ошибок |
| Retry budget manager | `backend/src/runtime/retry-budget-manager.js` | LIVE: бюджет повторных попыток per-type |
| Fairness engine | `backend/src/runtime/fairness-engine.js` | LIVE: предотвращение голодания сцен |
| Audio service | `backend/src/audio/audio-service.js` | TTS-генерация, мерж аудио, padded text trimming |
| Image service | `backend/src/image/image-service.js` | Генерация изображений IU (через connector) |
| Video service | `backend/src/video/video-service.js` | Видеогенерация (LTX), multi-image |
| Video merge | `backend/src/video/video-merge.js` | Мерж видео + аудио через ffmpeg |
| Agent service | `backend/src/services/agent-service.js` | AI-пайплайн (шаг 0 + 5 шагов, без отдельного enrichment). Буфер 1500 символов, до 3 сцен, продвижение по `nextOffset` |
| TXT importer | `backend/src/services/txt-importer.js` | Импорт и парсинг TXT |
| Window generator | `backend/src/services/window-generator.cjs` | Фоновая оконная генерация |
| Workflow loader | `backend/src/workflows/workflow-loader.js` | Загрузчик шаблонов ComfyUI + connector loader |
| Connector loader | `backend/src/workflows/connector-loader.js` | Декларативная карта nodeId → entity, валидация совместимости |
| Entity schema | `backend/src/workflows/entity-schema.js` | Все типы данных backend↔ComfyUI |
| Task handler | `backend/src/services/task-handler.cjs` | Обработчик результатов GPU задач (IU completion, audio merge, через facade) |
| Layer config | `backend/src/services/layer-config.js` | Профили генерации (AUDIO_ONLY, IMAGE_ONLY, VIDEO_ONLY и др.) |
| Gen scope | `backend/src/services/gen-scope.js` | Область генерации (сцена/глава/книга) |
| Scene asset registry (PG) | `backend/src/services/scene-asset-registry.js` | PostgreSQL реестр asset'ов (markReady, getDirtyUnitIds, dirty_flag) |
| PG repositories | `backend/src/storage/postgres/repositories/` | 15+ репозиториев: book, cache, task, iu, sceneAssets, chat, chatSession, events, genSession, bookSource, user, workspace, session, guest, worker |
| Book diff | `backend/src/services/book-diff.cjs` | Diff книг, dirty scene marking (через orchestrator.markDirty) |
| Book source | `backend/src/services/book-source.js` | Канонический индекс сцен из Book JSON |
| Book sync | `backend/src/services/book-sync.js` | Синхронизация JSON ↔ DB через scene_hash |
| Book event log | `backend/src/services/book-event-log.js` | PostgreSQL журнал событий книги (30+ типов) |
| Chat engine | `backend/src/services/chat-engine.cjs` | AI-чат (tool-based, режимы) |
| Cleanup service | `backend/src/services/cleanup-service.cjs` | Периодическая очистка, distributed locks |
| Audio recovery | `backend/src/services/audio-recovery.cjs` | Периодическое восстановление результатов GPU |
| Placeholder audio | `backend/src/services/placeholder-audio.js` | Генерация MP3-заглушек, замена на real audio |
| Waveform service | `backend/src/services/waveform-service.js` | Вычисление waveform |
| AI loader | `backend/src/services/ai-loader.js` | Загрузка базы знаний (TTL cache) |
| Knowledge base | `backend/src/services/knowledge-base.js` | Загрузка ai/ файлов (не используется в prompts) |
| Startup resume | `backend/src/startup-resume.js` | Возобновление сессий при старте |
| Workflow manager | `backend/src/services/workflow-manager.js` | Управление workflow и connector routes |
| Auth service | `backend/src/auth/auth-service.js` | Регистрация/вход/выход, server-side sessions, guest workspaces |
| Worker auth | `backend/src/services/worker-auth.js` | FAIL CLOSED credential model, Redis mirror, PG authoritative |
| Audio orchestrator | `backend/src/services/audio-orchestrator.js` | Phase machine для аудио-merge (WAITING_CHUNKS → MERGING → DONE) |
| Video orchestrator | `backend/src/services/video-orchestrator.js` | Phase machine для видео-merge (зеркало audio) |
| Entity cleanup | `backend/src/services/entity-cleanup.cjs` | Deep cleanup при удалении scene/unit (PG/Redis/FS/GPU-hub) |
| Workspace AI provider | `backend/src/services/workspace-ai-provider.js` | Per-workspace encrypted AI provider, resolver chain |
| System AI | `backend/src/services/system-ai.js` | AI kill switch + system provider (admin) |
| Progress pub/sub | `backend/src/services/progress-pubsub.cjs` | Redis pub/sub для real-time SSE progress |
| Generation progress | `backend/src/services/generation-progress.js` | Independent generation task registry |
| GPU Hub | `gpu-hub/gpu-hub.js` | Workspace-scoped queues, auth, orphan sweep, error delivery, dead letter |
| Worker | `worker/worker/worker.cjs` | GPU-воркер ComfyUI (CJS, private worker mode, PW-2) |
| Database | `backend/src/storage/postgres/` | PostgreSQL (30+ таблиц, 15+ репозиториев) |
| Runtime config | `backend/src/config/runtime-config.js` | Централизованная конфигурация |
