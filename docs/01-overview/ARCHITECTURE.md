# Architecture: Animastor

## 1. Backend Server (`backend/src/backend.cjs`)

**Ответственность:** Точка входа. Инициализация Redis/Express/PG, DI всех сервисов, монтирование роутов, запуск runtime loop.

**Входы:** HTTP-запросы (Express), сигналы от GPU Hub (callbacks через task-handler).

**Выходы:** HTTP-ответы, задачи в GPU Hub, данные в Redis/PG.

**Зависимости:** Express, ioredis, pg, multer, adm-zip, sharp, music-metadata, ws, uuid, cors, helmet, express-rate-limit.

**Встроенные улучшения:**
- **Helmet.js** — HTTP security headers (HSTS, CSP, X-Frame-Options, XSS-Protection)
- **Rate limiting** — 500 req/min на `/api/`, защита от перегрузок

> **UPD 2026-06-26:** Исправлен rate limit (500, не 100). Код: `backend.cjs:64-65`.
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

### 2.5 Connector Routes (`backend/src/routes/connector-routes.cjs`)
**Ответственность:** Управление коннекторами (13 эндпоинтов).

### 2.6 Workflow Routes (`backend/src/routes/workflow-routes.cjs`)
**Ответственность:** Управление workflow (4 эндпоинта).

> **UPD 2026-06-26:** Добавлены connector-routes и workflow-routes (всего 6, не 4). Код: `routes/`.

## 3. Orchestration Layer

### 3.0 Orchestrator Facade (`backend/src/orchestration/orchestrator.js`) — Единый арбитр состояния

**Ответственность:** Единственный владелец lifecycle-состояния сцены. Фасад из 11 команд, через которые проходят ВСЕ писатели состояния (M5).

**Команды:**
- `markDirty(deps, redis, bookId, buildId, dirtyScenes, layerCfg)` — через bookDiff.markDirtyScenes (Lua-атомарный reset)
- `markDirtyScene(redis, bookId, chapterId, sceneId, assets)` — прямой per-scene DIRTY (для recovery)
- `planScene(redis, bookId, chapterId, sceneId)` — чистая функция, читает per-asset состояния, НЕ пишет
- `beginStage(redis, scene, loadedBook, buildId, stage)` — dispatch + syncLinearState (GENERATING/PENDING)
- `completeStage(redis, bookId, chapterId, sceneId, stage, buildId)` — callback + version gate + READY + release + syncLinearState
- `completeStageWithoutVideo(redis, loadedBook, bookId, chapterId, sceneId, buildId)` — video disabled
- `completeStageWithoutImage(redis, loadedBook, bookId, chapterId, sceneId, buildId)` — image disabled
- `setScenePending(redis, bookId, chapterId, sceneId, asset, buildId)` — PENDING + syncLinearState
- `setSceneAllReady(redis, bookId, chapterId, sceneId, buildId)` — cache hit: все ассеты READY
- `setScenePlaceholder(redis, bookId, chapterId, sceneId, buildId)` — audio PLACEHOLDER
- `reconcile(redis, bookId, chapterId, sceneId)` — сверка фактов через reconciliation-engine

**Версионный гейт (M5 Шаг 5):** `completeStage` проверяет `scene_assets.scene_content_version < scenes.content_version` в PG перед READY. Если версия устарела → DIRTY вместо READY. Graceful fallback при недоступности PG.

> **UPD 2026-06-28:** M5 шаги 1-5 завершены. Все 8+ писателей per-asset состояния сведены к фасаду. syncLinearState — автоматический побочный эффект каждой facade-команды.

### 3.1 Runtime Scheduler (`backend/src/runtime/runtime-scheduler.js`)

**Ответственность:** Tick-based (5s) планировщик. **Чистая функция решения** — `shouldScheduleAssets()` только читает per-asset состояния и layer-config, ничего не пишет (Д.2). Version-stale reset — явный пред-проход в `attemptDispatch()` через `detectVersionStale()` + `markVersionStaleDirty()`.

**Входы:** Redis (active scenes set), heartbeat воркеров.
**Выходы:** Вызовы `dispatchEngine.dispatchStage()`.

**Зависимости:** Redis, dispatch-engine, active-scenes-index, scene-state, worker-health.
**Используют:** runtime-loop.
**Использует:** dispatch-engine, orchestrator, scene-window.

### 3.2 Dispatch Engine (`backend/src/runtime/dispatch-engine.js`)

**Ответственность:** Dispatch с lease-механизмом (NX TTL, предотвращение дублирования), quota-контроль (backpressure с **атомарным Lua EVAL** для acquire), idempotent completion (NX marker). Интеграция с governance-модулями: circuit-breaker, retry-budget, fairness-engine — напрямую через `require()` (LIVE, не lazy).

**Ключевые изменения:**
- **Атомарные квоты (M2):** `ATOMIC_ACQUIRE_SCRIPT` (Lua EVAL) — проверка лимита и INCR в одной Redis-операции. Устранён race между GET и INCR.
- **Idempotent completion (C4):** `markDispatchCompleted` защищён `SET NX` по ключу `animastor:dispatch-completed:*`. Повторный колбэк безвреден.
- **Д.1 (C1):** Единственный владелец release квоты — `markDispatchCompleted`. Из scene-callbacks releaseQuota убран.
- **Force dispatch:** Поддержка `force=true` — очистка существующего lease + quota + metadata перед повторным dispatch.

**Зависимости:** Redis, lease-manager, runtime-config, counter-reconciliation, runtime-metrics, **circuit-breaker (LIVE)**, **retry-budget-manager (LIVE)**, **fairness-engine (LIVE)**.
**Удалены из core:** policy-engine, workload-classifier, cost-estimator (мёртвый код, Phase 6).

**Используют:** runtime-scheduler.
**Использует:** orchestrator.dispatchStage().

**Lease TTL (актуальные):** audio 15min, image 20min, video 30min.

### 3.3 Scene Orchestrator (`backend/src/orchestration/scene-orchestrator.js`)

**Ответственность:** Dispatch execution (audio/image/video). Чистый исполнитель — НЕ принимает решений о состоянии. Отвечает за старт сцены, выполнение dispatch для audio/image/video, обработку dirty-unit IDs для image.

Логика вынесена в:
- `scene-callbacks.js` (~17 КБ) — handle*Completed, completeSceneWithoutVideo/Image
- `scene-restoration.js` — восстановление чанков, pre-delete stale PNG при dirty units, version gate
- `scene-utils.js` — утилиты/логирование
- `event-journal.js` — журнал событий

### 3.4 Scene Window (`backend/src/runtime/scene-window.js`)

**Ответственность:** Управление окном генерации (scope-aware). Старт/стоп/слайд окна по мере завершения сцен.

**Ключевые изменения:**
- **Все записи состояния через facade (M5 Шаг 2):** `setScenePending`, `setSceneAllReady`, `setScenePlaceholder` — 7 прямых вызовов `state.setAssetState/setAssetStates/syncLinearState` заменены на `orchestrator.*`
- **Cache advisory (Phase 3/R3.3):** `checkSceneContentCache` — только информация, решение принимает facade. Version-based staleness check.
- **Единый источник статусов файлов:** `getSceneFilesStatus()` — четырежды используемая функция для проверки наличия файлов на диске.
- **Version gate (Д.3/M3):** `restoreChunkStatusForScene` и `reconcileWindowStatuses` проверяют PG версию перед записью 'ready'. Stale файлы не отменяют force-regen.

### 3.5 Event Journal (`backend/src/orchestration/event-journal.js`) v1.1.0

**Ответственность:** Append-only журнал событий сцены в Redis (List). Аудит жизненного цикла. TTL 7 дней. Core scene lifecycle типы (R5.1) — governance/phase-specific типы удалены.

**API:** appendSceneEvent, getSceneEvents, getSceneEventsByTime, getLastEvents, getEventsByType, getEventCount, getFirstEventTime, getLastEventTime, getEventTimeRange, deleteSceneEvents.

**Event types:** SCENE_STARTED, AUDIO_DISPATCHED, AUDIO_COMPLETED, AUDIO_FAILED, IMAGE_DISPATCHED, IMAGE_FAILED, VIDEO_DISPATCHED, VIDEO_COMPLETED, VIDEO_FAILED, RECOVERY_*, DUPLICATE_CALLBACK, INVALID_STATE_CALLBACK, LOCK_*, DISPATCH_BLOCKED_CIRCUIT, RETRY_BUDGET_EXCEEDED, STARVATION_DETECTED, OVERLOAD_PROTECTION_ENABLED и др.

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

### 4.5 Agent Service (`backend/src/services/agent/`)
**Ответственность:** AI-пайплайн разбит на подмодули в `backend/src/services/agent/`:
- `pipeline-steps.js` — 6 шагов (шаг 0 + 5 шагов пайплайна)
- `pipeline-runner.js` — запуск пайплайна с валидацией
- `bootstrap.js` — первое окно (`bootstrapWithAgent`)
- `coreference.js` — сведён к заглушке (удалён из пайплайна)
- `ai-caller.js` — вызов AI с ретраями
- `text-utils.js` / `visual-utils.js` — утилиты
- `agent-prompts.js` — все system prompt'ы (в `services/agent-prompts.js`)
- `agent-service.js` — barrel-экспорт и window-generation

**Шаги пайплайна (упрощённый, без coreference):**
```
Шаг 0: stepAnalyzeStructure       — метаданные книги (отдельно, до pipeline)
Шаг 1: stepExtractCharacters      — персонажи
Шаг 2: stepExtractLocations       — локации
Шаг 3: stepCreateScenes           — сцены (до 3, из буфера ~1500 символов)
  ↓ Enrichment
Шаг 4: stepCreateUnits            — IU (визуальные единицы), per-scene
Шаг 5: stepCreateVisuals          — visual-промпты, per-scene
```

**Ключевые изменения (июнь–июль 2026):**
- **Enrichment-шаг отделён от создания сцен** — `stepEnrichScenes()` до-заполняет
  поля сцены (title, location, participants) из контекста, снижая нагрузку на AI-промпт
  создания сцен.
- **`unit.participants` удалён из всей системы** — LLM больше не генерирует
  participants для IU. `inferCharactersFromPrompt()` — единственный метод
  определения участников визуала (сканирует `visual.prompt` на character_id).
- **Coreference resolution удалён из пайплайна** — `coreference.js` сведён к заглушке.
  Валидация character_id теперь только через `normalizeCharacterRefs()`.
- **`character_anchors` удалён** — позиции персонажей пишутся напрямую в
  `visual.prompt`, без отдельного поля.

**Ключевое поведение (2026-07-02):**
- Backend хранит `currentOffset` в `agent_sessions.window_data` и берёт от него
  текстовый буфер `MAX_WINDOW_CHARS=1500`.
- AI создаёт **до 3 сцен** (`MAX_SCENES_PER_CHUNK=3`) из начала буфера и может
  оставить хвост буфера неиспользованным.
- `computeSceneCoverage()` проверяет, что созданные сцены являются дословным
  непрерывным префиксом буфера.
- `resolveSceneProgress()` вычисляет `nextOffset` по окончанию последней
  созданной сцены; `currentOffset` обновляется именно в эту позицию, а не в
  конец буфера.
- Длительность сцены: цель ~20s, soft ceiling ~30s с одним repair retry.

**Входы:** bookId, sourceText.
**Выходы:** JSON-структура книги в PG (agent_sessions, agent_steps, agent_conversations).

**Зависимости:** ai-service, context-builder, book, postgres, agent-prompts.

**Хранение книги (multi-file, v2.2):** Помимо `bible.json` и `characters.json`,
система теперь хранит:
- `locations.json` — все локации (отдельно от bible, доступ через `book.locations`)
- `voices.json` — все голоса персонажей (отдельно от bible, доступ через `book.voices`)
- `bible.json` — теперь включает `country` и `epoch` для инъекции в image-промпты

**AI-провайдер:**
- Единый ключ: `OPENROUTER_API_KEY`
- Базовый URL: `AI_API_BASE_URL` (конфигурируемый, по умолчанию OpenRouter)
- Модель по умолчанию: `qwen3-32b`
- JSON-ответы очищаются от CoT (`<think>`/`<reasoning>`) перед парсингом

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

## 5. State Layer

### Per-Asset States (CANONICAL)
Каждый asset (audio/image/video) имеет независимое состояние (AssetState):
```
NEW → DIRTY → PENDING → GENERATING → READY | FAILED | PLACEHOLDER
```

**Ключевое изменение (v2.1.0):** Per-asset состояния — канонический источник истины. Линейная FSM была **удалена** — её валидация переходов (SceneTransitions) блокировала параллельный диспатч. Теперь `transitionSceneState` — прямой `setSceneStateWithBuildId` без проверок.

Линейный `SceneState` (константы: `AUDIO_PENDING`, `IMAGE_GENERATING` и т.д.) сохранён как производная проекция для backward compatibility — `deriveLinearState()` вычисляет его из per-asset состояний на лету. Другие Redis-потребители (плеер, debug-энпоинты) всё ещё читают эти ключи.

---

## 6. Storage Layer

### 6.1 PostgreSQL (`backend/src/storage/postgres/`)
**Ответственность:** Каноническое состояние. Схема: 25+ таблиц (users, books, book_snapshots, scenes, asset_states, cache_entries, asset_dependencies, generation_tasks, workers, reconciliation_events, output_manifests, image_units, storyboard_elements, audio_layers, scene_assets, ai_chat_sessions, chat_sessions, chat_messages, book_events, agent_sessions, agent_steps, agent_conversations, agent_messages, book_source, book_generation_sessions).

**Репозитории** (`backend/src/storage/postgres/repositories/`):
- `book-repo.js` — CRUD операций с книгами
- `scene-assets-repo.js` — scene_assets: markReady, getAsset, getDirtyUnitIds, clearDirtyUnitIds, setDirtyUnitIds, clearDirtyFlag
- `iu-repo.js` — image_units
- `task-repo.js` — generation_tasks
- `cache-repo.js` — cache_entries
- `chat-repo.js` / `chat-session-repo.js` — чаты AI-ассистента
- `events-repo.js` — book_events
- `gen-session-repo.js` — agent_sessions
- `book-source-repo.js` — book_source

**Входы:** SQL-запросы от сервисов и репозиториев.
**Выходы:** Данные.

**Используют:** Все сервисы.

### 6.2 Redis (через ioredis)
**Ответственность:** Runtime-состояние: активные сцены, heartbeat воркеров, очереди задач, dispatch-аренда, dispatch-completed markers, квоты (counter), event journal (List), кэш чанков, scene state (JSON), per-asset state (HASH — HSET/HGETALL для атомарности), iu-progress (counter TTL 4h), iu-in-flight (EX 1200).

**Ключевые структуры:**
- `animastor:asset-state:<bookId>:<ch>:<sc>` — HASH с полями audio/image/video
- `animastor:scene-state:<bookId>:<ch>:<sc>` — JSON { state, build_id, updated_at }
- `animastor:dispatch-lease:*` — SET NX EX (15/20/30 min)
- `animastor:dispatch-completed:*` — SET NX EX (idempotency marker)
- `animastor:runtime:active-{audio,image,video}` — counter (backpressure quota)
- `animastor:event-journal:*` — List (append-only, TTL 7d)
- `animastor:chunk:*` — JSON metadata per chunk
- `animastor:iu-progress:*` — counter TTL 14400s
- `animastor:iu-in-flight:*` — marker EX 1200

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
- `transitionSceneState` — теперь прямой `setSceneStateWithBuildId` без валидации
- Линейный `SceneState` — производная проекция (`deriveLinearState()`) для backward compat
- **Per-asset state хранится как Redis HASH** (`animastor:asset-state:<scene>`) для атомарного HSET/HGETALL — устранён RMW race между GET+merge+SET
- **syncLinearState** — автоматический побочный эффект каждой facade-команды (M5 Шаг 3)
- **Version gate** — `completeStage` проверяет PG-версию перед READY: stale GPU callback → DIRTY, не READY (M5 Шаг 5)
