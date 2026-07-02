# 01. System Map — Animastor

> Карта текущего устройства системы. Только описание «как есть».
> Дата составления: 2026-06-25. Основано на чтении исходного кода (не только документации).
> Раздел 9 отдельно фиксирует места, где документация расходится с кодом.
>
> **Источник:** Оригинальный анализ `docs-claude/01_System_Map.md`.
> **Статус:** Актуален. Сквозные противоречия с документацией (rate limit, lease TTL, etc.) исправлены в обновлённых версиях `ARCHITECTURE.md`, `DATA_FLOW.md` и др.

---

## 1. Назначение проекта

Animastor — платформа, превращающая текстовую книгу в мультимедийный «анимированный» формат: аудионаррация (TTS), изображения по кадрам и видео.

Конвейер целиком:

```
TXT / VBook  →  AI-анализ (агент)  →  структура книги (главы/сцены/персонажи/локации/кадры)
             →  генерация ассетов (audio → image → video) на GPU
             →  воспроизведение в Android-приложении
```

Дополнительно есть AI-чат-ассистент (tool-based) для редактирования книги.

Целевой клиент — Android-приложение (Kotlin). Backend — единственный сервер-оркестратор. Генерация вынесена на отдельные GPU-воркеры через промежуточный GPU Hub.

---

## 2. Основные подсистемы

Развёртывание (`docker-compose.yml`): `postgres` (PG 16), `redis` (7, persisted volume), `backend`, `gpu-hub`, `nginx`. GPU-воркеры запускаются отдельно (не в compose) и ходят в GPU Hub по HTTP.

| Подсистема | Где живёт | Роль |
|---|---|---|
| **Backend / API** | `backend/src/backend.cjs` + `routes/*` | Express-сервер, DI всех сервисов, REST API, оркестрация генерации, startup-resume/recovery. |
| **Orchestration / Runtime** | `backend/src/runtime/*`, `backend/src/orchestration/*` | Tick-планировщик (5s), dispatch-engine (lease/quota), scene-orchestrator + callbacks, scene-window. |
| **Agent Service (AI-пайплайн)** | `backend/src/services/agent-service.js` | Монолитный 6-шаговый анализ текста (шаг 0 + 5 шагов pipeline). |
| **AI-чат** | `backend/src/services/chat-engine.cjs` | Tool-based ассистент (режимы chat/edit/director/import/...). |
| **Генераторы** | `backend/src/{audio,image,video}/*` | Сборка ComfyUI-workflow и отправка задач на GPU. |
| **Workflow / Connector слой** | `backend/src/workflows/*`, `services/workflow-manager.js`, `data/workflows/`, `data/connectors/` | Загрузка и адаптация JSON-шаблонов ComfyUI; коннекторы как декларативные описания задач. |
| **GPU Hub** | `gpu-hub/gpu-hub.js` | Очереди задач в Redis, раздача воркерам, requeue по таймауту, возврат результата в backend. |
| **GPU Worker** | `worker/worker/worker.js` | ESM-воркер: polling Hub → ComfyUI → результат (base64 / fallback с диска). |
| **Storage** | `backend/src/storage/*`, `book/*` | PostgreSQL (25 таблиц), Redis (runtime), файловая система (книги multi-file, ассеты). |
| **Frontend** | `frontend/app/...` (Kotlin) | Single-activity, фрагменты: файлы/библиотека/редактор/плеер/навигация/AI/настройки. |

**Подсистемы, недопредставленные в обзорной документации, но реально присутствующие в коде:**
- **Connectors** — `connector-loader.js`, `routes/connector-routes.cjs` (13 эндпоинтов), `data/connectors/conn-*.json`. Отдельный декларативный слой описания задач генерации.
- **Workflow Manager** — `services/workflow-manager.js` (~19 КБ), `routes/workflow-routes.cjs` (4 эндпоинта).
- **Startup Recovery** — `services/startup-recovery.js` (~12 КБ) — отдельный от `startup-resume.js` модуль восстановления состояния из PG/диска на старте.

---

## 3. Жизненный цикл генерации

### 3.1 Импорт и AI-анализ

1. **Импорт** — `POST /api/v1/book/import-txt`. `txt-importer` декодирует буфер (UTF-8/CP1251), `lazy-book.createDraftBook()` создаёт каталог `data/books/<bookId>/` и draft-книгу; источник регистрируется в PG (`book_source`).
2. **Bootstrap** — `POST /api/v1/book/:id/bootstrap`. Запускается `agent-service.bootstrapWithAgent()`:
   - **Шаг 0** `stepAnalyzeStructure` — из первых ~80 строк извлекаются автор, заголовок, главы (отдельно, до pipeline).
   - **runPipeline** по текстовому буферу (`MAX_WINDOW_CHARS=1500`,
     `MAX_SCENES_PER_CHUNK=3`):
     - Шаг 1 `stepExtractCharacters` → персонажи
     - Шаг 2 `stepExtractLocations` → локации
     - Шаг 3 `stepCreateScenes` → до 3 сцен из начала буфера
     - `resolveSceneProgress` → `nextOffset` по последней созданной сцене
     - Шаг 4 `stepCreateUnits` (per-scene) → визуальные единицы (IU/кадры)
     - Шаг 5 `stepCreateVisuals` (per-scene) → визуальные промпты к кадрам
   - Результаты сохраняются в PG (`agent_sessions`, `agent_steps`, `agent_conversations`, `agent_messages`) и в файлы книги (`chapters/*.json`, `characters.json`, `bible.json`).
   - Если после `nextOffset` остаётся «хвост» → сессия `paused`, следующее
     окно обрабатывает `bootstrapNextWindow()` (фоновая оконная генерация,
     `window-generator.cjs`).

AI-провайдер: единый ключ `OPENROUTER_API_KEY`, базовый URL `AI_API_BASE_URL`. JSON-ответы модели очищаются от CoT (`<think>`/`<reasoning>`) перед парсингом (`ai-service.parseJsonResponse`).

### 3.2 Генерация ассетов (per-asset параллельный диспатч)

Линейная FSM сцены **удалена** (v2.1.0); канонический источник истины — независимые per-asset состояния `audio` / `image` / `video`:

```
NEW → DIRTY → PENDING → GENERATING → READY | FAILED | PLACEHOLDER
```

Цикл (раз в 5 сек, `runtime-scheduler.SCHEDULER_TICK_MS = 5000`):

1. **Scheduler tick** — берёт активные сцены из Redis, для каждой `shouldScheduleAssets()` решает по per-asset состоянию + layer-config, какие stage готовы:
   - audio и image диспатчатся **независимо** (параллельно);
   - video добавляется только если `image=READY` (functional dependency: видео собирается из IU-картинок).
2. **Dispatch engine** — `dispatchStage()`: проверяет circuit-breaker → дубликат/lease → quota (backpressure) → retry-budget → fairness → берёт lease (NX, TTL) → вызывает orchestrator с `overrideStage`.
   - Квоты (`QUOTAS`): audio 3, image 2, video 1.
   - Lease TTL (фактические в `dispatch-engine.js`): audio 15 мин, image 20 мин, video 30 мин.
3. **Scene orchestrator** — `executeAudio/Image/VideoDispatch()`: per-asset валидация, version-stale check по PG, сборка задачи в соответствующем сервисе, `gpu.send()/sendUnified()`.
4. **GPU Hub → Worker → ComfyUI** — задача кладётся в Redis-очередь, воркер забирает, гоняет ComfyUI, возвращает результат.
5. **Callback** — GPU Hub шлёт `POST /gpu/task/result` → `task-handler.cjs` → разбор по типу ассета:
   - `iu_image` — регистрирует IU, по PG проверяет завершённость всех IU сцены → `handleImageCompleted`;
   - `audio_chunk` — мерж чанков (ffmpeg) при наличии всех → `handleAudioCompleted`;
   - `scene_video` → `handleVideoCompleted` (video merge + mux аудио).
6. **Завершение** — per-asset state → READY; при `video=READY` сцена убирается из активного индекса, `trySlideWindowOnComplete()` сдвигает окно генерации на следующие сцены.

### 3.3 Воспроизведение

Android-плеер (`PlaybackViewModel` + `SceneAudioPlayer` на ExoPlayer/Media3) тянет чанки/ассеты сцены через REST, предзагружает 3 сцены вперёд, опрашивает готовность видео.

---

## 4. Архитектура хранения данных

Истина намеренно разделена на три хранилища (это явно зафиксировано и в коде, и в документации):

### 4.1 PostgreSQL — «то, что нельзя потерять»

25 таблиц (`storage/postgres/schema.js`). Ключевые группы:
- **Книга/структура:** `books`, `book_snapshots`, `scenes`, `image_units`, `storyboard_elements`, `audio_layers`, `book_source`.
- **Состояние генерации:** `scene_assets` (status: pending/ready/stale/failed/missing/placeholder + версии `scene_content_version`, `scene_audio_config_version`), `asset_states`, `asset_dependencies`, `generation_tasks`, `output_manifests`, `book_generation_sessions`, `workers`, `reconciliation_events`.
- **AI-агент:** `agent_sessions`, `agent_steps`, `agent_conversations`, `agent_messages`.
- **Чат:** `chat_sessions`, `chat_messages`, `ai_chat_sessions`.
- **Прочее:** `users`, `cache_entries`, `book_events`.

### 4.2 Redis — runtime-состояние (persisted через volume)

~30+ семейств ключей под префиксом `animastor:`. Основные:
- Очереди GPU: `animastor:queue:{audio|image|video}`, `animastor:running`, `animastor:result:*`, дедуп `animastor:job:*`.
- Состояние сцен: `animastor:scene-state:*` (linear, производное), `animastor:asset-state:*` (per-asset, канон, HASH), `animastor:iu-progress:*`, `animastor:chunk:*`, `animastor:chunks:*`.
- Диспатч/координация: `animastor:dispatch-lease:*`, `animastor:dispatch-completed:*`, `animastor:runtime:*`, `animastor:*-lock:*`, `animastor:worker:heartbeat:*`.
- Конфиг/scope: `animastor:layer-config:*`, `animastor:gen-scope:*`, `animastor:active-scenes`.

### 4.3 Файловая система

- **Книги (multi-file, v2.1):** `data/books/<bookId>/` → `manifest.json`, `book.json`, `bible.json`, `characters.json`, `chapters/<chapterId>.json` (плюс `source.txt` для draft).
- **Ассеты:** `data/output/<buildId>/` → `*.mp3`, `*.png`, `*.mp4`.
- **Шаблоны:** `data/workflows/*.json` (ComfyUI), `data/connectors/conn-*.json` (декларации задач).

### 4.4 Кто за что отвечает (фактическая модель)

- **PG** — факты: версии, статусы ассетов, dirty-флаги, структура книги, история агента/чата.
- **Redis** — производное/быстрый кэш: прогресс, очереди, leases, per-asset state (дублирует `scene_assets.status`).
- **Файлы** — артефакты результата; местами **тоже влияли на решения** — это известная точка размывания источника истины, закрытая в M3 (диск — факт, не решение).

---

## 5. Взаимодействие UI / Backend / GPU Worker / БД

```
┌──────────┐   HTTPS    ┌─────────┐   /api/ → backend:3000
│ Android  │──────────► │  nginx  │
│  (Kotlin)│            │ (proxy) │   /gpu/ → gpu-hub:5000
└──────────┘            └────┬────┘
                             │
              ┌──────────────┴───────────────┐
              ▼                               ▼
        ┌───────────┐  задачи (HTTP POST)  ┌─────────┐  Redis-очередь  ┌─────────┐
        │  Backend  │ ───────────────────► │ GPU Hub │ ──────────────► │ Worker  │
        │  :3000    │ ◄─────────────────── │  :5000  │ ◄────────────── │ ComfyUI │
        └─────┬─────┘  результат (callback)└────┬────┘   polling/result└─────────┘
              │                                 │
       ┌──────┼─────────────┐                   │
       ▼      ▼             ▼                   ▼
   PostgreSQL Redis   Filesystem            Redis (общий)
   (факты)   (runtime) (артефакты)
```

---

## 6. Redis, очереди и фоновые процессы

### 6.1 Назначение Redis

Redis выполняет три роли одновременно:
1. **Брокер очередей GPU** — списки `animastor:queue:{type}`, дедуп задач `animastor:job:*` (`SET NX EX 3600`), хранение результата `animastor:result:*`.
2. **Runtime-состояние оркестрации** — per-asset states (HASH), leases, счётчики backpressure, активные сцены, прогресс-чанки, heartbeat воркеров.
3. **Координация (distributed locks)** — scheduler-tick lock, cleanup lock, audio/video merge locks.

### 6.2 Очереди GPU Hub

- Три независимые очереди: `audio`, `image`, `video`.
- `GPU_TIMEOUT = 600000` (10 мин): если воркер не вернул результат — задача **requeue** в свою очередь.
- `DELETE /queue/clear?book_id=` — точечная очистка очередей по книге.

### 6.3 Фоновые процессы backend

- **Runtime loop / scheduler tick** — каждые 5 сек; главный двигатель прогресса.
- **Cleanup service** — периодическая очистка stale-локов, lifecycle сборок.
- **Window generator** — фоновая обработка следующего окна AI-анализа.
- **Startup resume** — возобновление прерванных сессий на старте.
- **Startup recovery** — восстановление Redis-состояния из PG (теперь только логирует, не чинит — R1.1).

---

## 7. Противоречия документации и кода (на момент составления)

| # | Утверждение в `docs/` | Факт в коде | Где |
|---|---|---|---|
| 7.1 | Rate limiting **100 req/min** | **500 req/min** | `backend.cjs:63-68` |
| 7.2 | Lease TTL: audio **30min**, image **60min**, video **120min** | audio **15min**, image **20min**, video **30min** | `dispatch-engine.js:43-47` |
| 7.3 | `gpu-dispatcher` имеет `sendVideo` | Нет такого метода | `gpu-dispatcher.js:56` |
| 7.4 | Все 6 governance-модулей — **мёртвый код** | 3 живут (`circuit-breaker`, `retry-budget`, `fairness`), 3 удалены | `dispatch-engine.js` |
| 7.5 | `scene-orchestrator.js` **~1200 строк** | **~173 строки** (фасад) | `orchestration/*` |
| 7.6 | Route-файлов **4** | **6**: +connector, +workflow | `routes/` |

> **Примечание:** Эти противоречия исправлены в обновлённых версиях документов (июнь 2026).

---

## 8. Особенности текущего устройства

### 8.1 Dual state model

Per-asset состояния — канон. Linear `SceneState` — производная проекция, поддерживаемая для совместимости с плеером.

### 8.2 Orchestrator-фасад (M5, июнь 2026)

Все 8+ писателей per-asset состояния сведены к единому фасаду `orchestrator.js` (11 команд). Единственный арбитр записи lifecycle-состояния.

### 8.3 Governance

`circuit-breaker`, `retry-budget`, `fairness` — LIVE. `policy-engine`/`workload-classifier`/`cost-estimator` — удалены.

---

*Конец карты. Описание текущего состояния на 2026-06-25 с обновлениями по состоянию на 2026-06-28.*
