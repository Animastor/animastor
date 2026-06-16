# LLM Audit Context: Animastor

## Назначение проекта

Animastor — AI-powered animated storytelling platform. Преобразует текстовые книги в мультимедийный контент (аудио, изображения, видео) через AI-анализ и GPU-генерацию.

**Архитектурный принцип:** Книга моделируется как процесс последовательного чтения, а не как статический текст. Система накапливает "память прочитанного" в JSON, прогрессивно обогащая мир книги.

**Tech Stack:** Node.js/Express (backend), Kotlin/Android (frontend), PostgreSQL 16 + Redis 7, ComfyUI (GPU generation), OpenRouter API (AI).

## Основные подсистемы

### 1. Backend API Server (`backend/src/backend.cjs`)
- Express-сервер на порту 3000
- DI-контейнер для ~30 сервисов
- Монтирует 4 route-модуля: books, generation, AI, debug

### 2. Orchestration Engine
Состоит из 3 ключевых компонентов:

- **Runtime Scheduler** (`runtime/runtime-scheduler.js`): Tick-based (5s), решает КОГДА запускать генерацию
- **Dispatch Engine** (`runtime/dispatch-engine.js`): Решает КАК запускать (leases, quotas, circuit breaker)
- **Scene Orchestrator** (`orchestration/scene-orchestrator.js`): Выполняет dispatch (audio/image/video)

### 3. AI Agent Pipeline (`services/agent-service.js`)
6-шаговый последовательный AI-пайплайн: структура → персонажи → локации → сцены → IU → визуал

### 4. Storage
- **PostgreSQL**: Каноническое состояние (15+ таблиц)
- **Redis**: Runtime-состояние, очереди GPU, dispatch-аренда, event journal
- **Filesystem**: Файлы книг, аудио, изображения, видео

### 5. GPU Infrastructure
- **GPU Hub** (`gpu-hub/gpu-hub.js`): Диспетчер задач, Redis-очереди, HTTP API
- **Workers** (`worker/worker/worker.js`): ComfyUI-воркеры (image/audio/video)

### 6. Android Frontend
- Kotlin, single-activity, 5 фрагментов
- Retrofit HTTP client, ExoPlayer для воспроизведения

### 7. Workflow System (`backend/src/workflows/`)
- JSON-шаблоны ComfyUI в `/data/workflows/`
- Загрузка при старте, deep clone на get
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
│  API Layer:    book-routes / generation-routes / ai-routes / debug  │
│                                                                     │
│  Orchestration: Scheduler (tick 5s) → Dispatch Engine → Orchestrator│
│                                                                     │
│  Services:     Audio / Image / Video / Agent / Chat / TXT Importer  │
│                                                                     │
│  GPU Dispatch: gpu-dispatcher.js (HTTP client)                      │
│                                                                     │
│  Governance:   circuit-breaker, retry-budget, fairness, policy      │
│                                                                     │
│  Storage:      PostgreSQL (canonical) + Redis (runtime) + FS (files)│
└───────────┬─────────────────────────────────────────────────────────┘
            │ HTTP POST /task
            │
┌───────────┴─────────────────────────────────────────────────────────┐
│                     GPU Hub (Node.js, port 5000)                    │
│  POST /task → animastor:queue:{audio,image,video}                   │
│  GET /task/next ← Worker polling                                    │
│  POST /task/result → callback forwarding to backend                 │
└───────────┬─────────────────────────────────────────────────────────┘
            │ HTTP poll
            │
┌───────────┴─────────────────────────────────────────────────────────┐
│               GPU Worker (Node.js + ComfyUI)                        │
│  image (Stable Diffusion) / audio (TTS) / video (LTX)              │
└─────────────────────────────────────────────────────────────────────┘
```

## Ключевые зависимости между компонентами

### Критические зависимости (кто от кого зависит)

| Компонент | Зависит от | Тип |
|-----------|-----------|------|
| Runtime Scheduler | Redis, Dispatch Engine, Scene Window, Active Scenes | runtime |
| Dispatch Engine | Redis, Circuit Breaker, Retry Budget, Fairness, Policy, Cost Estimator | runtime |
| Scene Orchestrator | Audio Service, Image Service, Video Service, GPU Dispatcher, Event Journal, Scene State | runtime |
| Agent Service | AI Service, Context Builder, PostgreSQL, Book Module | data |
| Audio Service | GPU Dispatcher, Workflow Loader, Audio Workflows | execution |
| Image Service | GPU Dispatcher, Workflow Loader, Image Workflows, Context Builder | execution |
| Video Service | GPU Dispatcher, Workflow Loader, Video Workflows | execution |
| GPU Hub | Redis, Express | infrastructure |
| Workers | GPU Hub (HTTP), ComfyUI (HTTP) | infrastructure |
| All Routes | Express, Redis, All Services | infrastructure |

### Типы хранилищ и их потребители

**PostgreSQL:**
- `agent_sessions` → Agent Service, Book Routes
- `agent_steps` → Agent Service
- `agent_conversations` → Agent Service
- `agent_messages` → Agent Service
- `book_generation_sessions` → Window Generator, Book Routes
- `book_sources` → Book Routes (dedup)
- `chat_sessions` + `chat_messages` → Chat Engine
- `events` → Events Repo
- `iu` → IU Repo
- `scene_assets` → Scene Assets Registry
- `cache` → Cache Repo
- `tasks` → Task Repo

**Redis (основные key patterns):**
- `animastor:active-scenes` (Set) — активные сцены
- `animastor:dispatch-lease:*` (String) — аренда dispatch
- `animastor:dispatch-meta:*` (Hash) — метаданные dispatch
- `animastor:runtime:active-{audio,image,video}` (String) — счётчики квот
- `animastor:queue:{audio,image,video}` (List) — очереди GPU Hub
- `animastor:chunk:*` (String) — чанки сцен
- `animastor:event-journal:*` (List) — журнал событий
- `animastor:circuit-breaker:*` (String) — состояние circuit breaker
- `animastor:retry-budget:*` (String) — бюджет повторных попыток
- `animastor:worker-health:*` (Hash) — heartbeat воркеров
- `animastor:scene-state:*` (String) — состояние сцены

## Workflow (жизненный цикл сцены)

### Состояния сцены (SceneState)
```
NEW → AUDIO_PENDING → AUDIO_GENERATING → AUDIO_READY
    → IMAGE_PENDING → IMAGE_GENERATING → IMAGE_READY
    → VIDEO_PENDING → VIDEO_GENERATING → VIDEO_READY
```

### Каждый asset (audio/image/video) имеет независимое состояние (AssetState)
```
NEW → DIRTY → PENDING → GENERATING → READY | FAILED | PLACEHOLDER
```

### Полный жизненный цикл от импорта до воспроизведения

```
1. TXT/текст импортируется → TXT Importer
2. AI Agent анализирует (6 шагов, окнами по 3 сцены) → книга с JSON-структурой
3. Сцены регистрируются в Active Scenes Index
4. Runtime Scheduler (tick 5s) проверяет каждую активную сцену
5. Dispatch Engine принимает решение (lease, quota, circuit breaker, budget)
6. Scene Orchestrator выполняет dispatch:
   a. Audio Service → TTS workflow → GPU Hub → Worker → MP3
   b. Image Service → image workflow → GPU Hub → Worker → PNG
   c. Video Service → video workflow → GPU Hub → Worker → MP4
7. Callback → Task Handler → Orchestrator.handle*Completed() → state update
8. Scene complete → window slide → следующая партия сцен
9. Android плеер воспроизводит сгенерированный контент
```

## Агенты (AI Pipeline)

### Единственный агент: Agent Service (agent-service.js)

6 последовательных шагов:

| Шаг | Функция | Что извлекает |
|-----|---------|---------------|
| 0 | stepAnalyzeStructure | Автор, название, главы |
| 1 | stepExtractCharacters | Персонажи (описание, внешность, голос) |
| 2 | stepExtractLocations | Локации |
| 3 | stepCreateScenes | Сцены (участники, место, время) |
| 4 | stepCreateUnits | IU (визуальные единицы) |
| 5 | stepCreateVisuals | Промпты для генерации |

**Модель:** qwen/qwen3.5-122b-a10b (OpenRouter, конфигурируемый)
**Окно:** 3 сцены / 4000 символов за раз
**Retry:** 3 попытки, timeout 180s
**Хранение:** agent_sessions + agent_steps + agent_conversations + agent_messages (PostgreSQL)

**Клиент AI:** ai-service.js — HTTP POST к OpenRouter API, парсинг JSON из ответа.

## Генераторы

Формальной абстракции "генератор" нет. Три независимых сервиса:

### Audio Service
- Интерфейс: `generateSceneAudio(redis, sceneData, loadedBook, buildId, bookId)`
- Workflow: tts-qwen-narrator (наррация), tts-qwen-dialogue (диалог, 2 голоса)
- Результат: MP3 файлы + merged audio per scene/book

### Image Service
- Интерфейс: `generateSceneIUImages(redis, sceneData, loadedBook, buildId, bookId)`
- Workflow: img-qwen-image
- Результат: PNG файлы per IU

### Video Service
- Интерфейс: `generateVideoAnimation(sceneData, loadedBook, buildId, workflows)`
- Workflow: video-ltx-{1p,2p,3p,4p} (в зависимости от кол-ва IU в группе)
- Результат: MP4 файлы (grouped + merged + muxed with audio)

**Вывод:** Замена любого генератора НЕВОЗМОЖНА без изменения остальной системы из-за жёсткой привязки к типам в orchestrator, dispatch-engine, scene-state, layer-config.

## Коннекторы

Формальной системы коннекторов нет. Интеграционные точки:

| Коннектор | Тип | Куда | Протокол |
|-----------|-----|------|----------|
| GPU Dispatcher | HTTP client | GPU Hub (post /task) | HTTP REST |
| Task Handler | HTTP server | Callback от GPU Hub | HTTP REST |
| AI Service | HTTP client | OpenRouter API | HTTP REST |
| PG Repositories | SQL client | PostgreSQL | SQL (node-postgres) |
| Redis Client | Redis client | Redis | RESP (ioredis) |
| Worker | HTTP client | GPU Hub (poll) + ComfyUI | HTTP REST |

## Ключевые файлы и их роли

| Файл | Роль | Размер |
|------|------|--------|
| backend/src/backend.cjs | Точка входа, DI | 265 строк |
| backend/src/orchestration/scene-orchestrator.js | Оркестратор сцен | 1206 строк |
| backend/src/runtime/dispatch-engine.js | Диспетчер с governance | 1031 строка |
| backend/src/runtime/runtime-scheduler.js | Tick-планировщик | 697 строк |
| backend/src/services/agent-service.js | AI-пайплайн | 1328 строк |
| backend/src/services/txt-importer.js | Импорт TXT | 298 строк |
| backend/src/services/task-handler.cjs | Callback handler | ~150 строк |
| backend/src/routes/book-routes.cjs | REST API книг | 1800+ строк |
| backend/src/audio/audio-service.js | TTS генерация | ~400 строк |
| backend/src/image/image-service.js | Image генерация | ~300 строк |
| backend/src/video/video-service.js | Video генерация | ~300 строк |
| backend/src/video/video-workflows.js | Video workflow builder | 427 строк |
| backend/src/state/scene-state.js | Машина состояний | ~300 строк |
| backend/src/config/runtime-config.js | Конфигурация | ~150 строк |
| gpu-hub/gpu-hub.js | GPU диспетчер | ~400 строк |
| worker/worker/worker.js | GPU воркер | ~500 строк |

## Основные риски

1. **Единая точка отказа — GPU Hub.** Нет failover, нет репликации. При падении — вся генерация останавливается.

2. **Единая точка отказа — OpenRouter API.** Весь AI-пайплайн зависит от одного внешнего API. Нет автоматического переключения на альтернативного провайдера.

3. **Единая точка отказа — Redis.** Всё runtime-состояние в одном Redis. Нет кластеризации.

4. **Чрезмерная связанность.** book-routes.cjs (1800+ строк), scene-orchestrator.js (1206 строк), dispatch-engine.js (1031 строка) имеют слишком много ответственности.

5. **Отсутствие unit-тестов** для критических компонентов (orchestrator, dispatch-engine, scheduler, agent-service).

6. **Циклические зависимости:** backend.cjs ↔ task-handler (через DI), orchestrator ↔ dispatch-engine (функционально).

7. **Нет graceful shutdown.** Stale dispatch leases при перезапуске (частично компенсируется очисткой при старте).

8. **База знаний AI загружается, но не используется** в промптах (мёртвый код).

9. **Хардкод AI-модели.** Модель OpenRouter захардкожена в agent-service (хотя конфигурируется через ENV). Нет абстракции AI-провайдера.

10. **Нет версионирования API** — `/api/v1/` присутствует, но механизма обратной совместимости нет.

## Вопросы для аудита

1. Какие компоненты необходимо изменить для добавления нового типа генерации (например, 3D rendering)?
2. Какую архитектурную реорганизацию следует провести для снижения связанности scene-orchestrator?
3. Как правильно ввести абстракцию AI-провайдера (OpenRouter ↔ NVIDIA ↔ local)?
4. Как обеспечить High Availability GPU Hub?
5. Нужен ли формальный event sourcing вместо append-only Redis-журнала?
6. Как обеспечить graceful shutdown и оркестрованное восстановление?
7. Какие метрики необходимо добавить для observability?
8. Стоит ли выделить dispatch-engine cross-cutting concerns в middleware-слой?
9. Какой паттерн выбрать для единого интерфейса генераторов?
10. Нужно ли вводить message queue (RabbitMQ/Kafka) вместо Redis-очередей для GPU задач?

---

## Итоговые метрики проекта (для оценки сложности)

| Метрика | Значение |
|---------|----------|
| Всего файлов (backend) | ~80 |
| Всего строк (backend) | ~18 000 |
| PostgreSQL таблиц | 15+ |
| Redis key patterns | 12+ |
| REST endpoint'ов | 40+ |
| Docker сервисов | 5 |
| Языки | JavaScript, Kotlin, SQL, Shell |
| Внешние зависимости | 10 npm + AndroidX + Retrofit + ExoPlayer |
| Тестов | 14 (все mocha) |
| Workflow шаблонов | 7 |
| AI pipeline steps | 6 |
| GPU worker типов | 3 (audio/image/video) |
