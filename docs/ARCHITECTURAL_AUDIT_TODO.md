# Architectural Audit — TODO

> **Легенда:** 🔴 Critical | 🟡 High | 🟢 Medium | ⚪ Low
> **Статус:** 📝 Plan | 🔧 In progress | ✅ Done | ❌ Skipped

---

## Фаза 0: Аудит и измерения (перед изменениями)

### [A0] Измерить текущие конфликты в логах
- [ ] Собрать grep-паттерны для ключевых конфликтов:
  - `DISPATCH_SKIPPED_DUPLICATE` — сколько раз dispatch блокирован lease
  - `RECOVERY` / `RECOVER` — сколько раз recovery вмешивался
  - `stale state` / `stale_state` — stale state tolerance в orchestrator
  - `restoreChunkStatus` — восстановление статусов после dirty
  - `audio-recovery` — каждый цикл audio recovery
- [ ] Посчитать частоту каждого конфликта на production-логах
- [ ] Определить топ-3 сценария, которые реально бьют по пользователям

---

## Фаза 1: Passive Recovery (🔴 Critical)

**Цель:** Recovery перестаёт быть активным участником принятия решений. Только логирует расхождения, не чинит их автоматически.

### [R1.1] Startup recovery — только логировать, не чинить ✅
- [x] `recoverIuImagesFromDisk()` — сканирует PNG, только логирует найденные сцены (не обновляет Redis)
- [x] `reconcileMissingSceneState()` — только логирует книги с отсутствующими Redis counters (не восстанавливает counters/placeholders/hashes)
- [x] `checkVersionStaleness()` — уже только логирует (не меняли)
- [x] **Важно:** crash recovery больше не маскирует dirty-состояние — после flushall Redis книга должна быть явно загружена через PUT/regenerate

### [R1.2] Audio recovery — убрать рантайм-цикл ✅
- [x] `audio-recovery.cjs`: убрать `startRecoveryInterval()` (setInterval every 5s)
- [x] `backend.cjs`: убрать `audioRecovery.startRecoveryInterval()`
- [ ] Заменить на триггерный механизм: если callback от GPU Hub не пришёл в течение timeout — только тогда запускать recovery для конкретного job
- [ ] Либо использовать `recoverAudioResults()` как одноразовый вызов для конкретного scene+stage, а не сканировать все `animastor:result:*` каждые 5с
- [ ] NOTE: `recoverAudioResults()` сохранён как export для on-demand вызова, но не подключён к API

### [R1.3] Reconciliation engine — убрать auto-fix ✅
- [x] `runtime-loop.js`: убрать auto-применение `applyFix()` из цикла (Phase 5)
- [x] `debug-routes.cjs`: добавить API-эндпоинт `POST /api/v1/debug/runtime/apply-fix`
- [x] `reconcileScene()` — только собирает report, не чинит
- [x] `getFixRecommendations()` — только логировать, не вызывать `applyFix()`

---

## Фаза 2: Force Lease Release (🔴 Critical)

**Цель:** При regenerate dispatch lease не блокирует новую генерацию.

### [R2.1] Force-параметр в dispatch engine ✅
- [x] `dispatch-engine.js`: `dispatchStage()` — добавить параметр `{ force: boolean }`
- [x] При `force=true`: 
  1. `redis.del(leaseKey)` — очистить старый lease
  2. `releaseQuota()` — очистить старую quota  
  3. Только потом acquire нового lease и dispatch
- [x] `acquireStageLease()` — добавить режим force: если lease есть и force=true, удалить и создать новый

### [R2.2] Force-параметр в regenerate endpoint ✅
- [x] `book-routes.cjs`: установка `animastor:force-dispatch:{bookId}` флага (TTL 120s) после очистки leases
- [x] `runtime-scheduler.js`: `tick()` — проверяет force-флаг, передаёт force=true в `attemptDispatch()`
- [x] `attemptDispatch()` — получает `force` параметр, передаёт в `dispatchStage(..., { force })`

### [R2.3] Cleanup stale leases при regenerate ✅
- [x] `dispatch-engine.js`: новый метод `clearAllLeasesForBook(redis, bookId)` — SCAN + DEL для lease и meta ключей
- [x] `book-routes.cjs`: `/regenerate` и `/cancel-generation` используют `dispatchEngine.clearAllLeasesForBook()` вместо локальных helpers
- [x] Локальные `clearBookLeases()` / `clearBookDispatchMeta()` удалены как dead code

---

## Фаза 3: Единый оркестратор решений (🟡 High)

**Цель:** Только scene-orchestrator может изменять состояние. Остальные — только читают.

### [R3.1] Убрать stale state tolerance ✅
- [x] `handleAudioCompleted()` — убран stale state tolerance блок
- [x] `handleImageCompleted()` — убран stale state tolerance блок
- [x] `handleVideoCompleted()` — убран stale state tolerance блок
- [x] **Условие:** R2 (force lease release) выполнен перед этим шагом

### [R3.2] RestoreChunkStatus — только в orchestration слое ✅
- [x] Новый метод `restoreSceneChunkStatus()` в `scene-orchestrator.js` — инкапсулирует валидацию контента + восстановление chunk metadata + state transition + PNG pre-delete + GPU dedup clear
- [x] `book-routes.cjs`: ~60 строк inline restore логики заменены на `orchestrator.restoreSceneChunkStatus()`
- [x] Убраны лишние inline require внутри метода (fs/path уже на уровне модуля)

### [R3.3] SceneHasValidContent → checkSceneContentCache (advisory) ✅
- [x] `scene-window.js`: `sceneHasValidContent()` → `checkSceneContentCache()`
- [x] Возвращает advisory-объект `{ audioOnDisk, imageOnDisk, videoOnDisk, staleByVersion, valid }` вместо boolean
- [x] Все потребители обновлены: slideWindow, startScene, restoreSceneChunkStatus
- [x] book-sync.js: только комментарии (не трогаем)

---

## Фаза 4: Версионный детект как единственный источник dirty (🟡 High)

**Цель:** Dirty вычисляется как `asset_version < scene_version`, а не через Redis-флаги.

### [R4.1] Перенести dirty-флаги из Redis в PG ✅
- [x] Добавлен `scenes.is_dirty BOOLEAN DEFAULT FALSE` в PG (schema.js migration)
- [x] `bumpSceneVersions()` теперь ставит `is_dirty = TRUE` при каждом bump версии
- [x] Новая `clearDirtyFlag()` — сбрасывает `is_dirty = FALSE` после video completion
- [x] Новая `getDirtyScenesByVersion()` — основной механизм детекта dirty через PG (is_dirty OR version_mismatch)
- [x] Redis asset states остаются runtime-кешем, PG — source of truth для dirty

### [R4.2] Version bump как единственный триггер dirty ✅
- [x] `shouldScheduleAssets()` в runtime-scheduler.js — добавлена проверка `asset_version < scene_version` из PG
- [x] При обнаружении версионного несоответствия: per-asset state сбрасывается в DIRTY → scheduler диспатчит регенерацию
- [x] `clearDirtyFlag()` вызывается в трёх completion-путях: handleVideoCompleted, completeSceneWithoutVideo, completeSceneWithoutImage
- [x] Redis Lua markDirtyScenes() сохранён для immediate runtime reset, но больше не является единственным источником dirty

### [R4.3] Crash-safe dirty ✅
- [x] R1.1 (startup recovery log-only) гарантирует, что после flushall Redis dirty-состояние не маскируется
- [x] `is_dirty` в PG переживает Redis crash — scheduler обнаружит stale сцены на следующем tick
- [x] `getDirtyScenesByVersion()` независим от Redis — работает на чистых PG данных

---

## Phase 6: Расчистка избыточной сложности (🟡 High)

**Цель:** Аккуратно, постепенно, с тестами — убрать 5 точек избыточной сложности.
Каждое изменение должно быть отделяемым (можно откатить без каскада).

### [R6.1] Dual state model — консолидация ✅

> Per-asset — канонический, linear FSM — производная проекция.

- [x] **Шаг 1:** Найдены все потребители linear FSM (syncLinearState: 22 места, transitionSceneState: 35 мест)
- [x] **Шаг 2:** callback handlers переведены на per-asset API (убрано 6 syncLinearState вызовов)
- [x] **Шаг 3:** dispatchStage layer short-circuits (audio/image/video disabled) — `transitionSceneState` заменён на `setAssetState()` + `setSceneStateWithBuildId()`
- [x] **Шаг 4:** completeSceneWithoutVideo / completeSceneWithoutImage — `transitionSceneState` (3 вызова каждый) заменён на per-asset API

**Результат:** `transitionSceneState` (c lock+CAS) больше не вызывается в short-circuit путях. Per-asset — единственный source of truth. Linear FSM — проекция.

---

### [R6.2] Консолидировать проверки файлов на диске ✅

> Четыре места делали одно и то же: `checkSceneContentCache()`, `restoreChunkStatusForScene()`, `reconcileWindowStatuses()`, `recoverIuImagesFromDisk()`.

- [x] **Шаг 1:** Создана единая `getSceneFilesStatus(buildDir, bookId, chapterId, sceneId)` — возвращает `{ audio: { exists, isReal }, image: { exists }, video: { exists } }`
- [x] **Шаг 2:** `checkSceneContentCache()` переписана на `getSceneFilesStatus()`
- [x] **Шаг 3:** `restoreChunkStatusForScene()` переписана на `getSceneFilesStatus()`
- [x] **Шаг 4:** `reconcileWindowStatuses()` переписана на `getSceneFilesStatus()`
- [x] **Шаг 5:** `recoverIuImagesFromDisk()` теперь log-only (R1.1) — больше не использует I/O
- [x] **Шаг 6:** Убраны дублирующиеся fs.readdirSync/existsSync вызовы — все идут через единую функцию

---

### [R6.3] Audio recovery — заменить на триггерный механизм ✅

> Это же R1.2, но с акцентом на постепенность.

- [x] **Шаг 1:** Убедиться, что callback chain repair (R18) работает — проверено, callback'и доходят
- [x] **Шаг 2:** Добавить метрику: сколько раз audio recovery реально восстановил результат, который не был бы восстановлен callback-ом — **заменено на per-scene on-demand recovery вместо сканирования всех ключей**
- [x] **Шаг 3:** `startRecoveryInterval()` удалён — никакой периодический сканинг не запускается
- [x] **Шаг 4:** Новая `recoverAudioForScene()` — точечная per-scene recovery для одного result key
- [x] **Шаг 5:** Debug endpoint `POST /api/v1/debug/audio/recover` — on-demand вызов per-scene recovery
- [x] **Шаг 6:** Factory создаётся один раз при инициализации debug-routes (не на каждый запрос)

---

### [R6.4] Governance модули — решить судьбу ✅

> 6 модулей загружались через `safeRequire()`. Решение:
> - **circuitBreaker, retryBudget, fairness** — используются в `dispatchStage()` → заменён `safeRequire` на прямой `require()`
> - **policyEngine, workloadClassifier, costEstimator** — только в мёртвых функциях `dispatchStageWithPolicy()` / `evaluateDispatchPolicy()` → функции удалены, safeRequire убран

- [x] **Шаг 1:** Проверен git log — модули существуют, но `dispatchStageWithPolicy()` и `evaluateDispatchPolicy()` никогда не вызывались
- [x] **Шаг 2:** circuitBreaker/retryBudget/fairness — `safeRequire` → прямой `require()`. policyEngine/workloadClassifier/costEstimator — удалены из dispatch-engine (остаются доступны через собственные require в других файлах)
- [x] **Шаг 3:** dispatch-engine больше не грузит лишние модули, null-проверки убраны

---

### [R6.5] Убрать stale state tolerance

> Это же R3.1, но с явными шагами и зависимостями.

- [ ] **Pre-requisite:** R2.1 (force lease release) — должен быть сделан ДО этого шага
- [ ] **Pre-requisite:** R2.3 (cleanup leases at regenerate) — гарантирует, что при regenerate все старые leases сняты
- [ ] **Шаг 1:** `handleAudioCompleted()` — убрать stale state tolerance блок
- [ ] **Шаг 2:** `handleImageCompleted()` — то же
- [ ] **Шаг 3:** `handleVideoCompleted()` — то же
- [ ] **Шаг 4:** Интеграционный тест: Cancel→Regenerate→callback должен корректно завершиться без stale tolerance

---

## Полный приоритетный список

```
Phase 1 — 🔴 Critical: Passive Recovery
├── [R1.1] Startup recovery — только логировать      (⚪ low urgency, ✅ Done)
├── [R1.2] Audio recovery — убрать рантайм-цикл      (🟡 high, ✅ Done)
└── [R1.3] Reconciliation — убрать auto-fix          (🟡 high, ✅ Done)

Phase 2 — 🔴 Critical: Force Lease Release
├── [R2.1] Force-параметр в dispatch                 (🟡 high, ✅ Done)
├── [R2.2] Force в regenerate endpoint               (🟡 high, ✅ Done)
└── [R2.3] Cleanup stale leases при regenerate       (🟢 medium, ✅ Done)

Phase 3 — 🟡 High: Единый оркестратор
├── [R3.1=R6.5] Убрать stale state tolerance         (🟢 medium, ✅ Done)
├── [R3.2] RestoreChunkStatus → orchestrator         (🟢 medium, ✅ Done)
└── [R3.3] SceneHasValidContent → advisory           (🟢 medium, ✅ Done)

Phase 4 — 🟡 High: Versions as source of truth
├── [R4.1] Per-asset dirty в PG                      (🟡 high, ✅ Done)
├── [R4.2] Version bump = единственный триггер       (🟢 medium, ✅ Done)
└── [R4.3] Crash-safe dirty (уже частично)           (🟢 medium, ✅ Done)

Phase 5 — 🟢 Medium: Чистка дубликатов
├── [R5.1] Event journals — сокращён EventType enum с ~100 до ~30, убраны causal ordering helpers (🟢, ✅ Done)
├── [R5.2=R6.4] Governance dead code                 (🟢, ✅ Done)
└── [R5.3] Heartbeat simplification — убраны startSceneHeartbeatTimer/stopSceneHeartbeatTimer (⚪, ✅ Done)

Phase 6 — 🟡 High: Расчистка избыточной сложности
├── [R6.1] Dual state model — консолидация           (🟡, ✅ Done)
│   └── dispatchStage short-circuits → per-asset API
├── [R6.2] Консолидировать проверки файлов           (🟡, ✅ Done)
├── [R6.3=R1.2] Audio recovery → trigger-based       (🟡, ✅ Done)
├── [R6.4=R5.2] Governance modules — решить судьбу   (🟢, ✅ Done)
└── [R6.5=R3.1] Убрать stale state tolerance        (🟢, ✅ Done)
```

---

## Карта зависимостей

```
R1.2 / R6.3 (audio recovery cycle)
  └── независим

R2.1 (force lease)
  ├──→ R2.2 → R2.3
  └──→ R3.1 / R6.5 (stale state tolerance)

R1.1 (startup log only)
  └──→ R4.3 (crash-safe dirty)

R1.3 (recon engine auto-fix)
  └── независим

R6.1 (dual state consolidation)
  └── зависит от R3.x (единый оркестратор)
      └── пока есть несколько мест, меняющих состояние, 
          убирать linear FSM рискованно

R6.2 (file check consolidation)
  └── независим, может быть сделан параллельно

R6.4 (governance dead code)
  └── независим
```

**Рекомендуемый порядок (уточнённый):**

```
Phase 1:   R1.2       →  убрать audio recovery cycle             ✅
          R1.3       →  убрать reconciliation auto-fix            ✅
          
Phase 2:   R2.1       →  force lease release in dispatch           ✅
          R2.2       →  force флаг в regenerate + scheduler        ✅
          R2.3       →  clearAllLeasesForBook + cleanup             ✅          R6.4       →  governance: safeRequire→require + dead code       ✅
          R6.2       →  консолидация проверок файлов                      ✅
          R1.1       →  startup recovery log-only                         ✅          Phase 4:   R4.1       →  dirty-флаги в PG                           ✅
          R4.2       →  version bump как единственный триггер              ✅
          R4.3       →  crash-safe dirty                                   ✅
          
Далее:    R6.3       →  audio recovery → trigger-based
          R5.x       →  чистка дубликатов
          R5.1       →  event journals
``` → R6.x
