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
- **Dual State Model:** per-asset состояния (audio/image/video) — канонический источник истины; Linear FSM — производная проекция для обратной совместимости
- **Helmet.js** — HTTP security headers (HSTS, CSP, X-Frame-Options)
- **Rate limiting** — 100 req/min на `/api/`, защита от перегрузок
- **Request ID** — каждый HTTP-запрос получает короткий ID для трассировки в логах
- **Graceful shutdown (SIGTERM)** — HTTP server → Redis → PostgreSQL последовательное завершение
- **Startup resume** — возобновление прерванных сессий генерации при старте

### Frontend (Android/Kotlin)
Мобильное приложение с bottom-навигацией: файлы, редактор, плеер, навигация, AI-ассистент.

### Orchestration Engine
Планировщик (tick-based, 5s), диспетчер (dispatch engine с lease-механизмом), оркестратор сцен (scene orchestrator). Управляет пайплайном AUDIO → IMAGE → VIDEO с независимым per-asset диспетчированием.

### Agent Service (AI Pipeline)
6-шаговый AI-пайплайн анализа текста (шаг 0 + 5 шагов): структура → персонажи → локации → сцены → units → визуальные промпты.

### GPU Hub (Node.js)
Центральный диспетчер задач на GPU. Принимает задачи от backend, ставит в Redis-очереди, распределяет по воркерам. Graceful shutdown, requeue при timeout (10 min), heartbeat, per-book queue clear.

### Workers (Node.js + ComfyUI)
GPU-воркеры (ESM-модули), выполняющие генерацию через ComfyUI: image (SD), audio (TTS), video (LTX). Поддержка multi-image assets.

### Workflow Loader
Загружает JSON-шаблоны ComfyUI из `/data/workflows/` и адаптирует их под конкретные задачи.

### Storage
- **PostgreSQL (25+ таблиц)** — каноническое состояние (книги, сцены, assets, чаты, события, сессии агентов, image_units, asset_states, cache_entries, generation_tasks, output_manifests)
- **Redis (persisted)** — runtime-состояние, очереди задач, heartbeat воркеров, dispatch-аренда, per-asset state, event journal, chunks
- **Filesystem (multi-file)** — файлы книг (JSON, multi-file format), аудио (MP3), изображения (PNG), видео (MP4)

### Services Layer
15+ сервисов: Audio/Image/Video Service, Agent Service, TXT Importer, Chat Engine, Gen Scope, Layer Config, Book Source/Sync/Integrity, Scene Asset Registry, Book Event Log, Chat Store, Cleanup Service, Audio Recovery, Placeholder Audio, AI Loader, Knowledge Base, Waveform Service, Window Generator, Startup Resume.

### AI Knowledge Base
Markdown-файлы правил, навыков и JSON-примеры для промптинга AI-моделей. **Не используются в промптах** основного пайплайна.

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
│  Agent Service  │  → 6-шаговый AI-анализ (шаг 0 + 5 шагов, окнами по 3 сцены)
│  (bootstrap)    │  → Извлечение: структура, персонажи, локации,
└────────┬────────┘    сцены, IU, визуальные промпты
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
| Scene orchestrator | `backend/src/orchestration/scene-orchestrator.js` | Центральный оркестратор сцен (layer-aware) |
| Runtime scheduler | `backend/src/runtime/runtime-scheduler.js` | Tick-based планировщик (per-asset диспетчеризация) |
| Dispatch engine | `backend/src/runtime/dispatch-engine.js` | Диспетчер с арендой/квотами (safeRequire governance) |
| GPU dispatcher | `backend/src/runtime/gpu-dispatcher.js` | HTTP-клиент для отправки задач в GPU Hub (send/sendVideo/sendUnified) |
| Scene window | `backend/src/runtime/scene-window.js` | Оконный менеджер генерации (scope-aware, cancel, recover) |
| Active scenes index | `backend/src/runtime/active-scenes-index.js` | Redis-индекс активных сцен |
| Scene state | `backend/src/state/scene-state.js` | Dual state model: per-asset (canonical) + linear FSM (legacy) |
| Audio service | `backend/src/audio/audio-service.js` | TTS-генерация, мерж аудио, padded text trimming |
| Image service | `backend/src/image/image-service.js` | Генерация изображений IU |
| Video service | `backend/src/video/video-service.js` | Видеогенерация (LTX) |
| Video merge | `backend/src/video/video-merge.js` | Мерж видео + аудио через ffmpeg |
| Agent service | `backend/src/services/agent-service.js` | AI-пайплайн (шаг 0 + 5 шагов) |
| TXT importer | `backend/src/services/txt-importer.js` | Импорт и парсинг TXT |
| Window generator | `backend/src/services/window-generator.cjs` | Фоновая оконная генерация |
| Workflow loader | `backend/src/workflows/workflow-loader.js` | Загрузчик шаблонов ComfyUI |
| Task handler | `backend/src/services/task-handler.cjs` | Обработчик результатов GPU задач (IU completion, audio merge) |
| Layer config | `backend/src/services/layer-config.js` | Профили генерации (AUDIO_ONLY, IMAGE_ONLY, VIDEO_ONLY и др.) |
| Gen scope | `backend/src/services/gen-scope.js` | Область генерации (сцена/глава/книга) |
| Scene asset registry | `backend/src/services/scene-asset-registry.js` | PostgreSQL реестр asset'ов |
| Book source | `backend/src/services/book-source.js` | Канонический индекс сцен |
| Book sync | `backend/src/services/book-sync.js` | Синхронизация JSON ↔ DB |
| Book integrity | `backend/src/services/book-integrity.js` | Проверка целостности (orphan detection) |
| Book event log | `backend/src/services/book-event-log.js` | PostgreSQL журнал событий книги |
| Chat store | `backend/src/services/chat-store.js` | Хранилище чатов (сессии, топики, поиск) |
| Chat engine | `backend/src/services/chat-engine.cjs` | AI-чат (tool-based, режимы) |
| Cleanup service | `backend/src/services/cleanup-service.cjs` | Периодическая очистка, distributed locks |
| Audio recovery | `backend/src/services/audio-recovery.cjs` | Периодическое восстановление результатов GPU |
| Placeholder audio | `backend/src/services/placeholder-audio.js` | Генерация MP3-заглушек, замена на real audio |
| Waveform service | `backend/src/services/waveform-service.js` | Вычисление waveform |
| AI loader | `backend/src/services/ai-loader.js` | Загрузка базы знаний (TTL cache) |
| Knowledge base | `backend/src/services/knowledge-base.js` | Загрузка ai/ файлов (не используется в prompts) |
| Startup resume | `backend/src/startup-resume.js` | Возобновление сессий при старте |
| Book diff | `backend/src/services/book-diff.cjs` | Diff книг, dirty scene marking |
| GPU Hub | `gpu-hub/gpu-hub.js` | Диспетчер GPU-очередей + requeue + graceful shutdown |
| Worker | `worker/worker/worker.js` | GPU-воркер ComfyUI (ESM, multi-image) |
| Database | `backend/src/storage/postgres/` | PostgreSQL (25+ таблиц) |
| Runtime config | `backend/src/config/runtime-config.js` | Централизованная конфигурация |
