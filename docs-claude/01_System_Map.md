# 01. System Map — Animastor

> Карта текущего устройства системы. Только описание «как есть».
> Дата составления: 2026-06-25. Основано на чтении исходного кода (не только документации).
> Раздел 9 отдельно фиксирует места, где документация в `docs/` расходится с кодом.

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

**Подсистемы, недопредставленные в обзорной документации, но реально присутствующие в коде** (подробнее в §9):
- **Connectors** — `connector-loader.js`, `routes/connector-routes.cjs` (13 эндпоинтов), `data/connectors/conn-*.json`. Отдельный декларативный слой описания задач генерации.
- **Workflow Manager** — `services/workflow-manager.js` (~19 КБ), `routes/workflow-routes.cjs` (4 эндпоинта).
- **Startup Recovery** — `services/startup-recovery.js` (~12 КБ) — отдельный от `startup-resume.js` модуль восстановления состояния из PG/диска на старте.

---

## 3. Жизненный цикл генерации

### 3.1 Импорт и AI-анализ

1. **Импорт** — `POST /api/v1/book/import-txt`. `txt-importer` декодирует буфер (UTF-8/CP1251), `lazy-book.createDraftBook()` создаёт каталог `data/books/<bookId>/` и draft-книгу; источник регистрируется в PG (`book_source`).
2. **Bootstrap** — `POST /api/v1/book/:id/bootstrap`. Запускается `agent-service.bootstrapWithAgent()`:
   - **Шаг 0** `stepAnalyzeStructure` — из первых ~80 строк извлекаются автор, заголовок, главы (отдельно, до pipeline).
   - **runPipeline** по окну текста (`WINDOW_SIZE=3` сцены, `MAX_WINDOW_CHARS=4000`):
     - Шаг 1 `stepExtractCharacters` → персонажи
     - Шаг 2 `stepExtractLocations` → локации
     - Шаг 3 `stepCreateScenes` → сцены
     - Шаг 4 `stepCreateUnits` (per-scene) → визуальные единицы (IU/кадры)
     - Шаг 5 `stepCreateVisuals` (per-scene) → визуальные промпты к кадрам
   - Результаты сохраняются в PG (`agent_sessions`, `agent_steps`, `agent_conversations`, `agent_messages`) и в файлы книги (`chapters/*.json`, `characters.json`, `bible.json`).
   - Если в тексте остаётся «хвост» → сессия `paused`, следующее окно обрабатывает `bootstrapNextWindow()` (фоновая оконная генерация, `window-generator.cjs`).

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

Истина намеренно разделена на три хранилища (это явно зафиксировано и в коде, и в `docs/`):

### 4.1 PostgreSQL — «то, что нельзя потерять»

25 таблиц (`storage/postgres/schema.js`). Ключевые группы:
- **Книга/структура:** `books`, `book_snapshots`, `scenes`, `image_units`, `storyboard_elements`, `audio_layers`, `book_source`.
- **Состояние генерации:** `scene_assets` (status: pending/ready/stale/failed/missing/placeholder + версии `scene_content_version`, `scene_audio_config_version`), `asset_states`, `asset_dependencies`, `generation_tasks`, `output_manifests`, `book_generation_sessions`, `workers`, `reconciliation_events`.
- **AI-агент:** `agent_sessions`, `agent_steps`, `agent_conversations`, `agent_messages`.
- **Чат:** `chat_sessions`, `chat_messages`, `ai_chat_sessions`.
- **Прочее:** `users`, `cache_entries`, `book_events`.

### 4.2 Redis — runtime-состояние (persisted через volume)

~30+ семейств ключей под префиксом `animastor:`. Основные:
- Очереди GPU: `animastor:queue:{audio|image|video}`, `animastor:running`, `animastor:processing`, `animastor:result:*`, дедуп `animastor:job:*`.
- Состояние сцен: `animastor:scene-state:*` (linear, производное), `animastor:asset-state:*` (per-asset, канон), `animastor:iu-progress:*`, `animastor:chunk:*`, `animastor:chunks:*`.
- Диспатч/координация: `animastor:dispatch-lease:*`, `animastor:dispatch-meta:*`, `animastor:runtime:*`, `animastor:*-lock:*` (audio/video merge locks), `animastor:worker:heartbeat:*`.
- Конфиг/scope: `animastor:layer-config:*`, `animastor:gen-scope:*`, `animastor:active-scenes`.
- Governance/legacy ключи (`circuit`, `fairness`, `retry-budget`, `priority`, `cost`, `trace`, `assets:*`) — часть из них относится к незадействованным/legacy модулям.

### 4.3 Файловая система

- **Книги (multi-file, v2.1):** `data/books/<bookId>/` → `manifest.json`, `book.json`, `bible.json`, `characters.json`, `chapters/<chapterId>.json` (плюс `source.txt` для draft). Loader в `book/index.js` поддерживает и **legacy single-file** `data/books/<bookId>.json` (для миграции).
- **Ассеты:** `data/output/<buildId>/` → `*.mp3`, `*.png`, `*.mp4`.
- **Шаблоны:** `data/workflows/*.json` (ComfyUI), `data/connectors/conn-*.json` (декларации задач).

### 4.4 Кто за что отвечает (фактическая модель)

- **PG** — факты: версии, статусы ассетов, dirty-флаги, структура книги, история агента/чата.
- **Redis** — производное/быстрый кэш: прогресс, очереди, leases, per-asset state (дублирует `scene_assets.status`).
- **Файлы** — артефакты результата; местами **тоже влияют на решения** (`sceneHasValidContent()` пропускает GPU, если файлы есть) — это известная точка размывания источника истины (см. §9 и аудит-доки).

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

**Потоки:**
- **UI → Backend:** REST (`/api/v1/...`) через Retrofit. Эндпоинтов по группам: book ~30, generation ~16, ai ~9, debug ~23, connector ~13, workflow ~4 (всего ~95).
- **Backend → GPU Hub:** `gpu-dispatcher.send()` / `sendUnified()` шлют задачу в `POST /gpu/task`. Hub кладёт в Redis-очередь.
- **Worker → GPU Hub:** воркер делает `GET /task/next` (polling раз в ~2с), выполняет ComfyUI, шлёт `POST /task/result` (или `/task/error`), периодически `POST /beacon` (heartbeat).
- **GPU Hub → Backend:** возврат результата ретраится до 5 раз (`POST /gpu/task/result` → `task-handler`), который дергает соответствующий `handle*Completed` оркестратора.
- **Backend ↔ БД:** PG через репозитории (`storage/postgres/repositories/*`), Redis через `ioredis` (единый инстанс, инжектируется в сервисы фабриками).

**Важно:** воркеры и backend общаются **только косвенно** — через GPU Hub и общий Redis. Прямого канала backend↔worker нет.

---

## 6. Redis, очереди и фоновые процессы

### 6.1 Назначение Redis

Redis выполняет три роли одновременно:
1. **Брокер очередей GPU** — списки `animastor:queue:{type}` (RPOPLPUSH в `processing`), дедуп задач `animastor:job:*` (`SET NX EX 3600`), хранение результата `animastor:result:*` (`EX 3600`).
2. **Runtime-состояние оркестрации** — per-asset states, leases, счётчики backpressure, активные сцены, прогресс-чанки, heartbeat воркеров (`EX 30`).
3. **Координация (distributed locks)** — scheduler-tick lock, cleanup lock, audio/video merge locks.

Redis персистится через volume `redis-data:/data` — состояние переживает рестарт. Однако канон (факты) дублируется в PG, поэтому теоретически Redis восстановим (на практике восстановление частично завязано на файлы на диске — см. аудит §9).

### 6.2 Очереди GPU Hub

- Три независимые очереди: `audio`, `image`, `video`.
- `GPU_TIMEOUT = 600000` (10 мин): если воркер не вернул результат — задача **requeue** в свою очередь.
- Heartbeat-цикл Hub раз в 10 сек обновляет TTL по выполняемым задачам.
- `DELETE /queue/clear?book_id=` — точечная очистка очередей по книге.

### 6.3 Фоновые процессы backend

- **Runtime loop / scheduler tick** — каждые 5 сек; главный двигатель прогресса (`runtime-loop.js` → `runtime-scheduler.tick()`), держит историю последних ~100 тиков.
- **Cleanup service** (`cleanup-service.cjs`) — периодическая очистка stale-локов аудио, lifecycle сборок, distributed locks.
- **Window generator** (`window-generator.cjs`) — фоновая обработка следующего окна AI-анализа (создание чанков, placeholder-аудио, регистрация сцен на GPU).
- **Startup resume** (`startup-resume.js`) — на старте поднимает прерванные generating/pending сессии генерации (`gen_session_repo.getActiveSessions()` → перезапуск фоновой оконной генерации).
- **Startup recovery** (`startup-recovery.js`) — на старте восстанавливает Redis-состояние из PG и файлов (в т.ч. ставит `image_status=ready` по найденным на диске PNG).

> Примечание: согласно `ARCHITECTURAL_AUDIT_*`, активный 5-секундный цикл audio-recovery был **убран** (R1.2) и auto-fix reconciliation-engine вынесен в ручной эндпоинт (R1.3); `recoverAudioResults()` оставлен для вызова по запросу. Это подтверждается тем, что в `backend.cjs` рантайм-цикл recovery не стартует, но сам код восстановления присутствует.

---

## 7. Особенности текущего устройства (как есть, без оценки)

### 7.1 Dual state model

Per-asset состояния — канон. Linear `SceneState` (`AUDIO_PENDING`, `IMAGE_GENERATING`, ...) сохранён как **производная проекция**: `deriveLinearState()` вычисляет его, `syncLinearState()` вызывается после изменений per-asset, потому что linear-ключи всё ещё читают плеер и debug-эндпоинты. `transitionSceneState()` — прямая запись без валидации/локов (FSM-проверки удалены в v2.1.0).

### 7.2 Несколько подсистем могут влиять на состояние

Кроме оркестратора, на состояние генерации фактически влияют:
- **scene-window** (`sceneHasValidContent`, `restoreChunkStatusForScene`) — может вернуть `ready` по файлам на диске сразу после того, как dirty-система выставила `pending`;
- **startup-recovery** — на старте ставит `ready` по найденным файлам;
- **reconciliation-engine** — умеет `applyFix` (сейчас — только по ручному эндпоинту);
- **dispatch-engine** — lease может заблокировать повторный диспатч (force-regen).

Это многократно описано в `ARCHITECTURAL_AUDIT_CONFLICTING_SUBSYSTEMS.md` как «четыре центра принятия решений». Код подтверждает наличие этих путей. Здесь фиксируется только факт — рекомендации в этом файле не даются.

### 7.3 Governance-модули диспатчера

В `dispatch-engine.js` **реально вызываются**: `circuit-breaker` (блокирует диспатч при открытой цепи), `retry-budget`, `fairness` (анти-голодание). Модули `policy-engine`, `workload-classifier`, `cost-estimator` — **не подключены** к production-пути (помечены как удалённые в Phase 6, лежат в `runtime.index.debug`, лениво грузятся через `safeRequire`). То есть «всё governance мёртвое» — неверно; мёртвая только часть.

### 7.4 Рефакторинг оркестратора уже произошёл

`scene-orchestrator.js` сейчас ~173 строки (фасад) и разнесён на `scene-callbacks.js` (~17 КБ), `scene-restoration.js`, `scene-utils.js`, `event-journal.js`. Это важно для §9 (часть `ARCHITECTURAL_DEBT.md` про «~1200 строк» устарела).

### 7.5 Frontend (кратко)

Single-activity (`MainActivity`) + фрагменты (Play/Edit/Library/File/Navigate/Settings/AiAssistant). Сеть — Retrofit/OkHttp, кэш (LruCache 50 МБ + дисковый 256 МБ). Плеер — ExoPlayer/Media3 с предзагрузкой 3 сцен. Прогресс-сообщения от агента приходят с backend на русском (i18n нет).

---

## 8. Противоречия документации и кода

Проверено чтением исходников. Перечислены только реальные расхождения.

| # | Утверждение в `docs/` | Факт в коде | Где |
|---|---|---|---|
| 8.1 | Rate limiting **100 req/min** на `/api/` | Фактически **500 req/min** (`max: 500`, `windowMs: 60_000`) | `backend.cjs:63-68`; неверно в `ARCHITECTURE.md:15`, `SYSTEM_OVERVIEW.md:32`, `LLM_AUDIT_CONTEXT.md:17`, `ARCHITECTURAL_DEBT.md:200` |
| 8.2 | Lease TTL: audio **30 мин**, image **60 мин**, video **120 мин** (`DATA_FLOW.md`) | Фактически audio **15 мин**, image **20 мин**, video **30 мин** | `dispatch-engine.js:43-47` vs `DATA_FLOW.md:113` |
| 8.3 | `gpu-dispatcher` имеет методы `send`/**`sendVideo`**/`sendUnified` | Метода `sendVideo` **нет**; экспортируются только `send` и `sendUnified` | `gpu-dispatcher.js:56`; неверно в `SYSTEM_OVERVIEW.md:144`, `ARCHITECTURE.md` |
| 8.4 | Все 6 governance-модулей — **мёртвый код** через `safeRequire` | `circuit-breaker`, `retry-budget`, `fairness` **реально вызываются** и влияют на диспатч; мёртвы только `policy-engine`/`workload-classifier`/`cost-estimator` | `dispatch-engine.js:399,448,473` vs `ARCHITECTURE.md:59`, `ARCHITECTURAL_DEBT.md §7.4` |
| 8.5 | `scene-orchestrator.js` **~1200 строк** | Сейчас **~173 строки** (фасад), логика вынесена в `scene-callbacks.js`/`scene-restoration.js` | `orchestration/*` vs `ARCHITECTURAL_DEBT.md:48-50` |
| 8.6 | Route-файлов **4** (book/generation/ai/debug) | Их **6**: добавлены `connector-routes.cjs` (~13 эндпоинтов) и `workflow-routes.cjs` (~4) | `routes/` vs `ARCHITECTURE.md §2`, `PROJECT_STRUCTURE.md` |
| 8.7 | Перечень сервисов в `PROJECT_STRUCTURE.md` | Не упомянуты реально существующие `workflow-manager.js`, `startup-recovery.js`, `connector-loader.js`, `entity-schema.js` | `services/`, `workflows/` |
| 8.8 | AI base URL «по умолчанию **Nvidia**» | Дефолт в коде действительно Nvidia (`integrate.api.nvidia.com`), но в `docker-compose.yml` реально задан **`https://api.aicredits.in/v1`** (ни Nvidia, ни OpenRouter) | `ai-service.js` + `docker-compose.yml:58` |
| 8.9 | Модель по умолчанию `qwen/qwen3.5-122b-a10b` | Так в `runtime-config.js`, но фактический деплой использует `qwen/qwen3-32b` (override в compose) — это **отмечено** в `AGENTS.md`, но не в `SYSTEM_OVERVIEW.md` | `runtime-config.js:142` vs `docker-compose.yml:60` |
| 8.10 | «5/6 шагов» агента | Несогласованность между доками: `SYSTEM_OVERVIEW` пишет «6 шагов», `ARCHITECTURE.md:131` — «5-шаговый». Код: шаг 0 + 5 шагов pipeline (т.е. 6 AI-вызовов-этапов). `AGENTS.md` это уже корректно поясняет. | `agent-service.js` |

### 8.11 Замечание по безопасности (факт, не рекомендация)

В `docker-compose.yml` в открытом виде закоммичены боевой API-ключ AI (`OPENROUTER_API_KEY=sk-live-...`) и пароль PostgreSQL. Это фиксируется как факт текущего состояния репозитория.

---

## 9. Краткая честная оценка (без рекомендаций)

Что сделано хорошо и оправданно:
- **Разделение «факт / производное»** между PG, Redis и файлами — концептуально правильное и явно отрефлексированное в самой команде (есть отдельный аудит). PG как канон, Redis как persisted-кэш и брокер — разумный выбор для одного сервера.
- **Per-asset параллельный диспатч** вместо линейной FSM — оправданное решение: оно прямо снимало блокировку параллельной генерации audio/image. Удаление FSM-валидации (v2.1.0) — осознанный размен «строгость → пропускная способность».
- **GPU Hub как развязка** backend↔worker через очереди с requeue по таймауту и дедупом — простая и устойчивая к падению воркеров схема.
- **Документация необычно самокритична**: аудит-доки честно перечисляют конфликты подсистем и dead code. Это сильная сторона проекта.

Спорные, но объяснимые места:
- **Dual state model + `syncLinearState` после каждого изменения** — оправдано как переходный слой совместимости (плеер/debug читают старые ключи), но это источник рассинхронизации.
- **Несколько подсистем, влияющих на состояние** (window/recovery/reconciliation) — исторически выросли как «лечение симптомов»; команда это осознаёт и поэтапно сворачивает (R1.2/R1.3 уже применены).

Объективные риски текущего состояния (фиксируются, без предложений):
- **Документация местами отстаёт от кода** (см. §8) — обзорные доки опаснее точечных, т.к. на них опираются при онбординге.
- **Размывание источника истины файлами на диске** — `sceneHasValidContent()` способно переопределить намерение пользователя на force-regen.
- **Dead code соседствует с живым** (часть governance, knowledge-base) — повышает когнитивную нагрузку.
- **Секреты в `docker-compose.yml`** — закоммичены в репозиторий.

Размер ключевых файлов (для ориентира): `book-routes.cjs` ~2122 стр., `dispatch-engine.js` ~876, `runtime-scheduler.js` ~598, `scene-window.js` ~748, `agent-service.js` ~847.

---

*Конец карты. Это описание текущего состояния; решения и приоритеты — предмет следующих этапов.*
