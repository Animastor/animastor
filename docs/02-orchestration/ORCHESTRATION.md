# Animastor — Система оркестрации

> **Единый документ.** Актуальное состояние на **19 июля 2026**, ревизия `d29eca0`.
> Замещает: `ORCHESTRATOR_LIFECYCLE.md`, `ORCHESTRATOR_ARCHITECTURE_WITH_AUDIO.md`,
> `AUDIO_ORCHESTRATOR.md`, `REGENERATION_SYSTEM.md`, `ORCHESTRATION_SYSTEM_AUDIT.md`,
> `CAPACITY_AND_COMPLEXITY.md`. Все ответы на вопросы об оркестрации — здесь.

---

## 1. Общая архитектура

```
                   ┌──────────────────────────────────────────┐
                   │         runtime-loop (tick 5s)           │
                   │  reconcile-цикл (60s) ←── CLEANUP_LOCK   │
                   └────┬───────────┬──────────────┬──────────┘
                        │           │              │
                   ┌────▼───┐  ┌───▼─────┐  ┌─────▼────────┐
                   │Scheduler│  │Counter  │  │Prometheus    │
                   │(tick()) │  │Reconcil.│  │Metrics       │
                   └────┬───┘  └─────────┘  └──────────────┘
                        │
              ┌─────────▼──────────────────────┐
              │     dispatch-engine.js          │
              │  lease + quota + circuit-break  │
              │  + retry-budget + dispatch      │
              └─────────┬──────────────────────┘
                        │
         ┌──────────────▼──────────────────┐
         │    orchestrator.js (FACADE)     │
         │  markDirty / setSceneGenerating │
         │  completeStage / failStage      │
         │  reconcile / resetScenes        │
         └──────┬──────────────┬──────────┘
                │              │
         ┌──────▼──┐    ┌─────▼──────────┐
         │ state.js │    │ audio-orch.js │
         │(per-asset)    │(phase machine)│
         └─────────┘    └────────────────┘
                │              │
         ┌──────▼──────────────▼──────────┐
         │   scene-orchestrator.js        │
         │   executeAudio/Image/Video     │
         └───────────────────────────────┘

    GPU Hub (gpu-hub.js) ←─── backend
      └── Worker (worker.cjs) ←──→ ComfyUI
```

### Ключевые решения

| Решение | Обоснование |
|---------|------------|
| **Один процесс Node.js** | Нет кластеризации. Всё: API, tick, reconcile, SSE — в одном event loop. |
| **Redis** | Runtime-состояние: очереди, блокировки, asset states, lease, квоты. |
| **PostgreSQL** | Канон: сцены, версии, scene_assets (status), book JSON. |
| **Файловая система** | OUTPUT_DIR — байты результата (.mp3, .png, .mp4). |

---

## 2. Компоненты системы

### 2.1 Orchestrator Facade (`orchestrator.js`)

Единственный модуль, который пишет lifecycle-состояние. **Никто не вызывает `state.setAssetState()` или `audioOrch.*()` напрямую** — только через фасад.

```
  Команда                | asset state       | audio-orch
  ───────────────────────|───────────────────|──────────────────────────
  setScenePending        | → PENDING         | если DONE → deleteState
  setSceneGenerating     | → GENERATING      | DONE? → skip; иначе → GENERATING
  setScenePlaceholder    | → PLACEHOLDER     | —
  completeStage          | → READY           | → DONE (синхронно)
  failStage              | → FAILED → PENDING | → FAILED
  markDirtyScene         | → DIRTY           | если DONE → deleteState
  setSceneAllReady       | все → READY       | все → DONE
  resetScenes            | все → DIRTY       | все → deleteState/FAILED
```

### 2.2 Dispatch Engine (`dispatch-engine.js`)

- **Lease** (`SET NX` + TTL): защита от двойного dispatch. TTL: audio 15min, image 20min, video 30min.
- **Quota** (`INCR` + check): backpressure. Лимиты: audio 3, image 2, video 1.
- **Circuit breaker**: 5 failures → open → 30s cooldown → half-open.
- **Retry budget**: per-(scene, stage) счётчик INCR + TTL. `consumeRetryBudget` в `finalizeDispatch('failure')`.
- **Dispatch ID**: UUID v4, `verifyDispatchIdentity` в колбэке.

### 2.3 Audio Orchestrator (`audio-orchestrator.js`)

Детальная state machine для аудио-пайплайна:

```
NEW ──→ PLACEHOLDER_READY ──→ GENERATING ──→ WAITING_CHUNKS ──→ MERGING ──→ DONE
                                  │                                │
                                  └──→ FAILED ←────────────────────┘
```

- Key: `animastor:audio-orch:{bookId}:{chapterId}:{sceneId}`
- Хранит: `phase, expected_count, chunks_received, last_chunk_at, started_at, build_id`
- Watchdog в reconcileCycle: `checkStalledAudioScenes()` — проверяет `last_chunk_at || started_at`
- Recovery: если чанки на диске без last_chunk_at → доиграть merge
- Инвариант: `phase == DONE ⇔ asset.audio == READY`

### 2.4 Asset State (`state.js`)

High-level per-asset состояния:

```
NEW → PENDING → GENERATING → READY
              ↘ FAILED → PENDING
  DIRTY → PENDING
```

- Key: `animastor:scene-assets-state:{bookId}:{chapterId}:{sceneId}`
- Поля: `{ audio, image, video }` ∈ {NEW, PENDING, GENERATING, READY, FAILED, DIRTY, PLACEHOLDER}
- **Единственный источник истины** для lifecycle с точки зрения scheduler'а.
- `syncLinearState()` — производная проекция для плеера (legacy, будет удалена).

### 2.5 Runtime Loop (`runtime-loop.js`)

- **Tick** (каждые 5s): быстрый цикл — сбор active-scenes, вызов scheduler.tick(), counter-reconciliation.
- **Reconcile** (каждые 60s): полный цикл самовосстановления с distributed lock.
  - Phase A: orphan audio state cleanup
  - Phase B1: orphan file reconciliation
  - Phase C0/C1/C2: active state fixes
  - Phase C4: counter reconciliation (с PG deps)
  - Phase C5: session resume
  - Phase D: audio-orch invariants check

### 2.6 Scene Orchestrator (`scene-orchestrator.js`)

Выполняет dispatch по типу: `executeAudioDispatch()`, `executeImageDispatch()`, `executeVideoDispatch()`.
Каждый:
1. Вызывает `orchestrator.setSceneGenerating(stage)` через фасад
2. Готовит данные (segments для audio, IU для image, frames для video)
3. Отправляет задачу в GPU Hub через `gpu.send()`
4. Возвращает `{ dispatched, jobs, reason }`

### 2.7 GPU Hub (`gpu-hub/gpu-hub.js`)

Прокси между backend и удалёнными GPU worker'ами:
- Принимает задачи в Redis-очереди `animastor:queue:{audio|image|video}`
- Дедуплицирует (`animastor:job:{job_id}`, SET NX EX 3600)
- Отслеживает heartbeat worker'ов (обновление каждые 10s)
- Re-queue при timeout (10 min)
- Callback: POST /gpu/task/result
- **GPU_HUB_API_KEY** — опциональная аутентификация (env, не задан → open access)

### 2.8 Regeneration System

```
Edit → Save → PUT /api/v1/book/:bookId → disk
  → Regenerate → POST /api/v1/book/:bookId/regenerate
    → computeBookDiff(oldBook, newBook)
    → filterDirtyScenesByScope(scope)
    → removeScenesFromActiveIndex() (только dirty)
    → clearLeasesForScenes() (только dirty)
    → clearGpuHubQueues() (только dirty)
    → markDirtyScenes() (Lua atomic: chunks + state + active index)
    → restoreChunkStatusForScene()
    → Scheduler picks up dirty scenes
```

**Dependency Graph (версионный):**
```
SceneText ──┬──► Audio (mp3)
            └──► UnitText ──► ImagePrompt ──► Image (png) ──► Video (mp4)
                                              └──► Video НЕ зависит от Audio
```
- Audio + Image независимы, параллельны.
- Video зависит ТОЛЬКО от Image.
- Audio change НЕ делает Video dirty (видео без звука, mux на экспорте).
- Cross-cutting: Character.appearance → Image, Character.voice → Audio, Location → Image.

**Data Provenance — как собирается Image Prompt** (`image-service.js` `buildImagePrompt()`):

```
Final Image Prompt = [renderMode] + [style] + [location_visual_style] + [location_description]
  + [env_epoch/time/season/weather/mood/atmosphere/lighting] ← scene.location.environment
  + [shot_type] ← unit.visual.shot
  + [character_passport] ← book.characters[id].passport (via inferCharactersFromPrompt())
  + [character_state] ← scene.state[id] || chapter.state[id]
  + [visual_prompt] ← unit.visual.prompt
  + [quality] ← unit.visual.quality || scene.visual.quality
```

Персонажи определяются **только** через `inferCharactersFromPrompt()`, сканирующий `visual.prompt` на `character_id`. `unit.participants` удалён (июль 2026).

`resolveVisualStyle()` fallback: `unit.visual.style → scene.visual.style → scene.style → bible.render_rules.style`.

**Prompt Dependency Registry** (`prompt-dependency-registry.js`):
Единый реестр полей → dirty layers. `diffScene()` и `buildImagePrompt()` читают из одного registry.
---

## 3. Dual State Machine (Design)

### 3.1 Зачем две машины

| Аспект | Asset State | Audio-Orch |
|--------|------------|------------|
| Key | `scene-assets-state:{bid}:{cid}:{sid}` | `audio-orch:{bid}:{cid}:{sid}` |
| Фазы | NEW, PENDING, GENERATING, READY, FAILED, DIRTY, PLACEHOLDER | NEW, PLACEHOLDER_READY, GENERATING, WAITING_CHUNKS, MERGING, DONE, FAILED |
| Семантика | Высокоуровневый статус ассета | Детальный статус аудио-пайплайна |
| Кто читает | Scheduler (что диспатчить), плеер | watchdogs, recovery, merge |

**Asset state** — для scheduler'а: «нужно ли диспатчить» (PENDING/DIRTY → да, READY → нет).  
**Audio-orch** — для пайплайна: «сколько чанков пришло, не пора ли мержить, не застряло ли».

### 3.2 Инвариант

```
audio-orch.phase == DONE   ⇔   asset.audio == READY       [always true]
audio-orch.phase == FAILED ⇒   asset.audio ∈ {FAILED, PENDING}
audio-orch.phase ∈ {WAITING_CHUNKS, MERGING, GENERATING}
                            ⇒   asset.audio == GENERATING
```

Проверяется в `reconcileCycle` → `checkAudioOrchInvariants()`.

---

## 4. Call Flows

### 4.1 Штатная генерация аудио

```
Scheduler tick → attemptDispatch()
  → shouldScheduleAssets(): asset=PENDING → stages=['audio']
  → dispatchStage('audio')
    → acquireLease(), acquireQuota()
    → scene-orchestrator.executeAudioDispatch()
      └─ orchestrator.setSceneGenerating('audio')
        → asset.audio = GENERATING
        → audioOrch.setGenerating() (PLACEHOLDER_READY → GENERATING)
      → audioOrch.setWaitingChunks()
      → audio.generateSceneAudio() → GPU hub (9 chunks)
      → return { dispatched: true }

Chunks 0001-0008 arrive
  → /gpu/task/result → handleTaskResult()
    → save to disk
    → audioOrch.completeChunk() (WAITING_CHUNKS, chunks_received++)

Chunk 0009 arrives
  → audioOrch.completeChunk()
    → WAITING_CHUNKS → MERGING (all 9 present)
    → ffmpeg merge → MERGING → DONE
    → orchestrator.completeStage('audio')
      → handleAudioCompleted()
      → version gate (PG)
      → asset.audio = READY  (синхронно с audio-orch DONE)
      → finalizeDispatch(success)
```

### 4.2 Watchdog (timeout)

```
reconcileCycle → checkStalledAudioScenes()
  → audioOrch state: WAITING_CHUNKS, last_chunk_at + 5min < now
  → audioOrch.failWaitingScene()
    └─ orchestrator.failStage('audio')
      → asset.audio = FAILED
      → audio-orch = FAILED (синхронно)
      → finalizeDispatch(failure)

Scheduler tick (next)
  → asset.audio = FAILED → PENDING (re-dispatch)
  → dispatchStage('audio')
    └─ orchestrator.setSceneGenerating('audio')
      → audio-orch FAILED → GENERATING (valid)
      → dispatch заново
```

### 4.3 Regenerate

```
User edits → POST /regenerate
  → orchestrator.resetScenes()
    → clearLeases, clear queues (только dirty)
    → orchestrator.markDirtyScene('audio')
      → audio-orch DONE? → deleteState
      → asset.audio = DIRTY
  → scheduler.addSceneToActiveIndex()

Scheduler tick
  → asset.audio = DIRTY → stages=['audio']
  → dispatchStage('audio')
    → orchestrator.setSceneGenerating('audio')
      → audio-orch: no state → initPlaceholderReady → setGenerating
      → asset.audio = GENERATING
      → dispatch to GPU
```

### 4.4 Stale recovery (DONE guard)

```
После рестарта: audio-orch в WAITING_CHUNKS (старая генерация)
  → Scheduler видит asset.audio = GENERATING
  → dispatchStage('audio')
    → orchestrator.setSceneGenerating('audio')
      → setGenerating() → FAILS (WAITING_CHUNKS → GENERATING invalid)
      → stale-phase recovery:
        → deleteState (только WAITING_CHUNKS/GENERATING/FAILED — НЕ DONE)
        → initPlaceholderReady → setGenerating ✅
      → dispatch to GPU (свежая генерация)
```

---

## 5. Ёмкость и производительность

### Текущие лимиты

| Ресурс | Максимум | Описание |
|--------|----------|---------|
| Audio генерация | 3 одновременно | quota `maxActiveAudio: 3` |
| Image генерация | 2 одновременно | quota `maxActiveImage: 2` |
| Video генерация | 1 одновременно | quota `maxActiveVideo: 1` |
| Scheduler tick | 1 экземпляр | distributed lock |
| Node.js процесс | 1 (single-threaded) | без кластеризации |
| Redis | 1 инстанс | Lua-скрипты |
| GPU Hub | 1 прокси | без шардирования |

**Система рассчитана на 1–5 concurrent пользователей.** Дизайн под одного пользователя с одной книгой.

### Без усложнения (твик конфигов)

| Изменение | Результат |
|-----------|-----------|
| `maxActiveAudio: 3 → 10` | 3× больше аудио |
| `maxActiveImage: 2 → 6` | 3× больше image |
| `maxActiveVideo: 1 → 3` | 3× больше видео |
| GPU Hub → +1 инстанс | отказоустойчивость |

→ **10–15 concurrent пользователей** без нового кода.

### Для 50+ пользователей

Нужны: очередь задач (RabbitMQ/Redis Streams), кластеризация Node.js, S3-хранилище, балансировка GPU Hub.

---

## 6. Current Status (verified against code, 19 July 2026)

### ✅ Что работает (проверено по коду)

| Гипотеза | Статус | Ссылка |
|----------|--------|--------|
| Worker syntax error в `waitForFileReady()` | ✅ Исправлено | `worker.cjs` — `node --check` OK |
| `completeStage()` игнорирует result handler | ✅ Исправлено | `orchestrator.js:119-184` — `handlerOk` обязателен |
| `failStage()` пишет success finalization | ✅ Исправлено | `orchestrator.js:280-289` → `finalizeDispatch('failure')` |
| Executor возвращает `dispatched:true` без отправки job | ✅ Исправлено | `scene-orchestrator.js` возвращает `{ dispatched, jobs, reason }` |
| Lease renewal не стартует | ✅ Исправлено | `dispatch-engine.js:594` — после `dispatched:true` |
| Runtime tick гоняет полный reconcile без lock | ✅ Исправлено | `runtime-loop.js:65-120` — tick без reconcile |
| `active-scenes` управляются двумя API | ✅ Исправлено | `runtime-scheduler.js:82-100` → `active-scenes-index.js` |
| SQL-инъекция в `agent-session.js` | ✅ Исправлено | `services/agent-session.js:21` — `ALLOWED_UPDATE_COLUMNS` |
| `redis.keys()` блокирует Redis | ✅ Убрано | grep не находит `keys('animastor...')` |
| ReferenceError `pendingState` в reconcile | ✅ Исправлено | `reconciliation-engine.js:834-851` |
| GPU Hub auth не передаётся | ✅ Исправлено | `gpu-dispatcher.js:46-49` — `x-api-key` |

Дополнительно:
- `completeStage` НЕ пишет `READY` без `handler.ok === true` + version gate (PG)
- `failStage` НЕ пишет `recordSuccess` — идёт через `finalizeDispatch('failure')`
- Lease/quota освобождаются при `dispatched:false`
- Все production JS проходят `node --check` (syntax-smoke в pretest)
- **576 тестов passing**, zero warnings про missing mock functions
- Graceful shutdown (SIGTERM/SIGINT) + `/health` endpoint
- DONE guard в `scene-orchestrator.js`: не перезапускает готовое аудио
- Stale phase recovery: WAITING_CHUNKS/GENERATING/FAILED → reset; DONE — не трогать
- Прямые asset-state writes только через `unsafe*` методы (restore-only)
- `fairness-engine.js` удалён (−618 строк)
- `failure-taxonomy.js` сокращён с 424 до ~100 строк
- `retry-budget-manager.js` сокращён с 520 до ~165 строк (только check/consume)
- Phase C3 удалена из reconciliation (−32 строки)
- S4: фикс тест-моков — zero warnings

### ⚠️ Оставшиеся дефекти

| # | Проблема | Серьёзность | Статус |
|---|---------|------------|--------|
| P1 | Прямые writes state в обход фасада (`scene-restoration.js`, `startup-recovery.js`) | Средняя | Используют `unsafe*` методы → приемлемо |
| P2 | GPU Hub auth: env var не задан в `.env` | Низкая | Код корректный, нужен deploy-секрет |
| P3 | Counter reconciliation — safety net (нужен) | Средняя | Оставлен, полезен |
| P4 | Нет единого теста на force-regen + stale файлы | Средняя | Coverage gap |

### 🔴 Чего НЕ делать (согласовано)

- Не добавлять Kafka, RabbitMQ, BullMQ
- Не вводить второй state-machine поверх asset FSM
- Не переносить lifecycle в PostgreSQL одним PR
- Не переписывать audio pipeline
- Не добавлять новый reconciliation service
- Не расширять facade десятками методов (текущих 13 команд достаточно)

---

## 7. Интеграции

### 7.1 GPU Hub → Backend callback

`POST /gpu/task/result` — поток:
1. Валидация: `job_id, result_base64, build_id, dispatch_id, protocol_version`
2. `parseJobId` → определение stage (audio_chunk/image/video)
3. `verifyDispatchIdentity` — проверка dispatch-token
4. Дедуп: `animastor:result-processed:{job_id}:{build_id}` SET NX
5. `handleTaskResult()` → сохранение файла + завершение stage

### 7.2 Frontend (Android)

- `Repository.kt`: кэш чанков по `${id}_${buildId}` — stale cache invalidation
- `GenerateViewModel.kt`: `regenerateFromSnapshot()`, `snapshotCurrentBook()`
- `EditFragment.kt`: редактор сцены → PUT /api/v1/book/:bookId

### 7.3 Storage

| Хранилище | Роль | Кто пишет |
|-----------|------|-----------|
| **PG** `scene_assets` | Канон lifecycle | только `orchestrator.*` |
| **Redis** `asset-state:*` | Кэш для scheduler | только `orchestrator.*` |
| **Redis** lease/quota | Координация | dispatch-engine |
| **Redis** chunks | Метаданные чанков | audio-orch |
| **Файлы** OUTPUT_DIR | Байты | worker → fs |

---

## 8. Redis Key Space

```
# Runtime state
animastor:scene-assets-state:{bid}:{cid}:{sid}    # per-asset states (JSON)
animastor:audio-orch:{bid}:{cid}:{sid}            # audio-orch phase (JSON)
animastor:dispatch-lease:{bid}:{cid}:{sid}:{type}  # lease (SET NX)
animastor:dispatch-meta:{bid}:{cid}:{sid}:{type}   # dispatch metadata
animastor:active-scenes                            # SMEMBERS

# Quota
animastor:runtime:active-{audio|image|video}      # INCR counters

# Chunks
animastor:chunk:{bid}_{cid}_{sid}_{idx}            # chunk metadata
animastor:iu-progress:{bid}:{cid}:{sid}:image      # IU counter

# GPU Hub
animastor:queue:{audio|image|video}                # LPUSH/BRPOP queues
animastor:job:{job_id}                             # dedup (SET NX)
animastor:result-processed:{job_id}:{build_id}     # result dedup
animastor:iu-in-flight:{imageIUId}                 # in-flight marker
animastor:worker:heartbeat:{type}:{id}              # heartbeat

# Coordination
animastor:regenerate-lock:{bookId}                 # lock (SET NX)
animastor:force-dispatch:{bookId}                  # force flag (EX 120)
animastor:scheduler-tick-lock                      # tick lock
animastor:cleanup-lock                             # reconcile lock
```

---

## 9. Configuration

| Параметр | Файл | Значение |
|----------|------|----------|
| `maxActiveAudio` | `dispatch-engine.js` | 3 |
| `maxActiveImage` | `dispatch-engine.js` | 2 |
| `maxActiveVideo` | `dispatch-engine.js` | 1 |
| `LEASE_TTL_audio` | `lease-manager.js` | 15 min |
| `LEASE_TTL_image` | `lease-manager.js` | 20 min |
| `LEASE_TTL_video` | `lease-manager.js` | 30 min |
| `GPU_TIMEOUT` | `gpu-hub.js` (env `GPU_TIMEOUT`) | 600000 ms (10 min) |
| `SCHEDULER_TICK_INTERVAL` | `runtime-loop.js` | 5000 ms |
| `RECONCILE_INTERVAL_MS` | `runtime-loop.js` | 60000 ms |
| `AUDIO_CHUNK_STALL_MS` | `runtime-config.js` | 300000 ms |

---

## 10. Files

| Файл | Строк | Роль |
|------|-------|------|
| `backend/src/orchestration/orchestrator.js` | ~500 | Facade — единый владелец состояния |
| `backend/src/orchestration/scene-orchestrator.js` | ~300 | Выполнение dispatch по типу |
| `backend/src/orchestration/event-journal.js` | ~100 | Журнал событий (TTL 7d) |
| `backend/src/runtime/dispatch-engine.js` | ~960 | Lease, quota, governance |
| `backend/src/runtime/reconciliation-engine.js` | ~1200 | Самовосстановление (6 фаз) |
| `backend/src/runtime/runtime-loop.js` | ~150 | Tick (5s) + reconcile (60s) |
| `backend/src/runtime/runtime-scheduler.js` | ~320 | Tick dispatch |
| `backend/src/runtime/lease-manager.js` | ~200 | Redis lease (SET NX + TTL + renewal) |
| `backend/src/runtime/counter-reconciliation.js` | ~200 | Фикс дрейфа квот |
| `backend/src/runtime/job-schema.js` | ~100 | Формат job_id |
| `backend/src/runtime/failure-taxonomy.js` | ~100 | Классификация ошибок |
| `backend/src/runtime/retry-budget-manager.js` | ~165 | Per-scene retry budget |
| `backend/src/state/scene-state.js` | ~250 | Per-asset state (unsafe* методы) |
| `backend/src/services/audio-orchestrator.js` | ~450 | Audio phase machine |
| `backend/src/services/task-handler.cjs` | ~300 | Callback обработка |
| `backend/src/services/gen-scope.js` | ~130 | Scope management |
| `backend/src/services/layer-config.js` | ~120 | Profile management |
| `backend/src/services/book-diff.cjs` | ~360 | Diff scenes, mark dirty |
| `backend/src/services/prompt-dependency-registry.js` | ~200 | Prompt field → dirty layer |
| `backend/src/services/startup-recovery.js` | ~300 | 5-step recovery на старте |
| `backend/src/runtime/scene-window.js` | ~680 | Window slide, cache check |
| `gpu-hub/gpu-hub.js` | ~400 | GPU прокси |
| `worker/worker/worker.cjs` | ~250 | GPU worker |

<!-- === Footer === -->
---
*Единый документ оркестрации. Ревизия `d29eca0`. 19 июля 2026.*
