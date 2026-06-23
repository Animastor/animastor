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

### [R1.1] Startup recovery — только логировать, не чинить ⚪
- [ ] `startup-recovery.js`: Step 2 (`recoverIuImagesFromDisk`) — убрать auto-fix chunk metadata. Только логировать: "найдено N PNG без Redis-статуса"
- [ ] Step 3 (`reconcileMissingSceneState`) — убрать установку counters и scene_hashes. Только логировать
- [ ] Step 4 (`checkVersionStaleness`) — уже только логирует, оставить
- [ ] **Важно:** crash recovery должен гарантировать, что dirty-состояние не теряется. Если книга была изменена (content_version поднят), startup recovery не должен это маскировать.

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

### [R2.1] Force-параметр в dispatch engine 🟡
- [ ] `dispatch-engine.js`: `dispatchStage()` — добавить параметр `{ force: boolean }`
- [ ] При `force=true`: 
  1. `redis.del(leaseKey)` — очистить старый lease
  2. `releaseQuota()` — очистить старую quota  
  3. Только потом acquire нового lease и dispatch
- [ ] `acquireStageLease()` — добавить режим force: если lease есть и force=true, удалить и создать новый

### [R2.2] Force-параметр в regenerate endpoint 🟡
- [ ] `book-routes.cjs`: в `/regenerate` передавать `force: true` в dispatch
- [ ] В цепочку вызовов: `markDirtyScenes()` → `reconcileFromDiff()` → `dispatchEngine.dispatchStage(force=true)`
- [ ] `runtime-scheduler.js`: `attemptDispatch()` — передавать force=true для сцен, которые были только что помечены dirty

### [R2.3] Cleanup stale leases при regenerate 🟢
- [ ] `book-routes.cjs`: в `/regenerate`, до markDirtyScenes — очистить все dispatch leases для этой книги
- [ ] `dispatch-engine.js`: новый метод `clearAllLeasesForBook(redis, bookId)`
- [ ] SCAN `animastor:dispatch-lease:{bookId}:*` → DEL each

---

## Фаза 3: Единый оркестратор решений (🟡 High)

**Цель:** Только scene-orchestrator может изменять состояние. Остальные — только читают.

### [R3.1] Убрать stale state tolerance 🟢
- [ ] `scene-orchestrator.js`: `handleAudioCompleted()` — убрать stale state tolerance (блок кода "stale state but audio is real — completing anyway")
- [ ] `handleImageCompleted()` — то же
- [ ] `handleVideoCompleted()` — то же
- [ ] **Условие:** должно быть сделано после R2 (force lease release), иначе Cancel→Regenerate снова будет ломаться

### [R3.2] RestoreChunkStatus — только в orchestration слое 🟢
- [ ] `scene-window.js`: `restoreChunkStatusForScene()` — вызывается из `markDirtyScenes` (через `/regenerate`). Перенести вызов в orchestrator
- [ ] Идея: только orchestrator может восстанавливать chunk status после dirty

### [R3.3] SceneHasValidContent — переименовать в advisory 🟢
- [ ] `scene-window.js:sceneHasValidContent()`:
  - Переименовать в `checkSceneContentCache(redis, ...)` — возвращает advisory-информацию
  - Не принимает решений (не пропускает dispatch)
  - Только возвращает: `{ audioOnDisk, imageOnDisk, videoOnDisk, staleByVersion }`
- [ ] Решение о пропуске dispatch принимает orchestrator

---

## Фаза 4: Версионный детект как единственный источник dirty (🟡 High)

**Цель:** Dirty вычисляется как `asset_version < scene_version`, а не через Redis-флаги.

### [R4.1] Перенести dirty-флаги из Redis в PG 🟡
- [ ] Добавить `scenes.is_dirty BOOLEAN DEFAULT FALSE` в PG
- [ ] `markDirtyScenes()` — обновлять не только Redis, но и PG
- [ ] `getOutdatedByVersions()` — переименовать/расширить до основного механизма детекта dirty
- [ ] Убрать Redis asset states как источник истины для dirty (оставить только как runtime-кеш)

### [R4.2] Version bump как единственный триггер dirty 🟢
- [ ] Убрать `markDirtyScenes()` из Redis (Lua-скрипт). Заменить на: bump version в PG + runtime scheduler замечает несоответствие версий
- [ ] Runtime scheduler: `shouldScheduleAssets()` — добавить проверку `asset_version < scene_version` для определения dirty

### [R4.3] Crash-safe dirty ✅ (уже частично)
- [ ] R13-R16 уже сделали version-based подход в PG
- [ ] R17: startup-recovery восстанавливает scene_hashes
- [ ] **Но:** startup recovery до сих пор может восстановить ready-статус на основе файлов на диске, игнорируя версии

---

## Phase 6: Расчистка избыточной сложности (🟡 High)

**Цель:** Аккуратно, постепенно, с тестами — убрать 5 точек избыточной сложности.
Каждое изменение должно быть отделяемым (можно откатить без каскада).

### [R6.1] Dual state model — консолидация

> Per-asset — канонический, linear FSM — производная проекция. syncLinearState() после каждого изменения.

- [ ] **Шаг 1:** Найти всех потребителей linear FSM
  - `grep -r "SceneState\." --include="*.js" --include="*.cjs"` — кто читает linear state?
  - `grep -r "syncLinearState" --include="*.js" --include="*.cjs"` — кто вызывает?
  - `grep -r "transitionSceneState" --include="*.js" --include="*.cjs"` — кто использует linear transitions?
- [ ] **Шаг 2:** Перевести каждого потребителя на per-asset API
  - `getAssetStates()` вместо `getSceneState()`
  - `setAssetState()` вместо `transitionSceneState()`
  - `deriveLinearState()` — только для совместимости с external API
- [ ] **Шаг 3:** Убрать `syncLinearState()` вызовы (кроме мест, где linear state нужен для внешних клиентов)
- [ ] **Шаг 4:** (Опционально) Удалить linear FSM полностью

**Риски:**
- External API может зависеть от linear state (frontend?)
- Нужно проверить `/api/v1/book/:bookId/status` и подобные эндпоинты

---

### [R6.2] Консолидировать проверки файлов на диске

> Четыре места делают одно и то же: `sceneHasValidContent()`, `restoreChunkStatusForScene()`, `reconcileWindowStatuses()`, `recoverIuImagesFromDisk()`.

- [ ] **Шаг 1:** Выделить единую функцию `getSceneFilesStatus(buildDir, bookId, chapterId, sceneId)`:
  ```javascript
  // Возвращает:
  // { audio: { exists: bool, isReal: bool },
  //   image: { exists: bool },
  //   video: { exists: bool } }
  ```
- [ ] **Шаг 2:** Переписать `sceneHasValidContent()` на `getSceneFilesStatus()`
- [ ] **Шаг 3:** Переписать `restoreChunkStatusForScene()` на `getSceneFilesStatus()`
- [ ] **Шаг 4:** Переписать `reconcileWindowStatuses()` на `getSceneFilesStatus()`
- [ ] **Шаг 5:** Переписать `recoverIuImagesFromDisk()` на `getSceneFilesStatus()`
- [ ] **Шаг 6:** Убрать дублирующиеся fs.readdirSync/existsSync вызовы

**Риски:**
- Каждое место сейчас имеет slightly разную логику (например, `sceneHasValidContent` проверяет placeholder audio, а `reconcileWindowStatuses` — нет). Нужно сохранить все различия при консолидации.

---

### [R6.3] Audio recovery — заменить на триггерный механизм

> Это же R1.2, но с акцентом на постепенность.

- [ ] **Шаг 1:** Убедиться, что callback chain repair (R18) работает — проверить, что GPU hub callback'и доходят до `handleAudioCompleted()`
- [ ] **Шаг 2:** Добавить метрику: сколько раз audio recovery реально восстановил результат, который не был бы восстановлен callback-ом
- [ ] **Шаг 3:** Если метрика ≈ 0 — убрать `startRecoveryInterval()`
- [ ] **Шаг 4:** Если метрика > 0 — заменить цикл на per-job timeout recovery

---

### [R6.4] Governance модули — решить судьбу

> 6 модулей загружаются через `safeRequire()`, не используются в production.

- [ ] **Шаг 1:** Проверить git log — были ли эти модули хоть раз включены?
- [ ] **Шаг 2:** Решить: нужны или нет
  - Если нужны — добавить в core pipeline dispatch-engine.js (убрать safeRequire)
  - Если не нужны — удалить файлы с диска
- [ ] **Шаг 3:** Обновить `runtime/index.js` если нужно

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
├── [R1.1] Startup recovery — только логировать      (⚪ low urgency, after R2)
├── [R1.2] Audio recovery — убрать рантайм-цикл      (🟡 high, ✅ Done)
└── [R1.3] Reconciliation — убрать auto-fix          (🟡 high, ✅ Done)

Phase 2 — 🔴 Critical: Force Lease Release
├── [R2.1] Force-параметр в dispatch                 (🟡 high, блокирует R3.1)
├── [R2.2] Force в regenerate endpoint               (🟡 high, после R2.1)
└── [R2.3] Cleanup stale leases при regenerate       (🟢 medium, после R2.1)

Phase 3 — 🟡 High: Единый оркестратор
├── [R3.1=R6.5] Убрать stale state tolerance         (🟢 medium, после R2.x)
├── [R3.2] RestoreChunkStatus → orchestrator         (🟢 medium)
└── [R3.3] SceneHasValidContent → advisory           (🟢 medium)

Phase 4 — 🟡 High: Versions as source of truth
├── [R4.1] Per-asset dirty в PG                      (🟡 high)
├── [R4.2] Version bump = единственный триггер       (🟢 medium, после R4.1)
└── [R4.3] Crash-safe dirty (уже частично)           (🟢 medium, после R1.1)

Phase 5 — 🟢 Medium: Чистка дубликатов
├── [R5.1] Event journals                            (🟢)
├── [R5.2=R6.4] Governance dead code                 (🟢)
└── [R5.3] Heartbeat simplification                  (⚪)

Phase 6 — 🟡 High: Расчистка избыточной сложности
├── [R6.1] Dual state model — консолидация           (🟡, долгосрочно)
├── [R6.2] Консолидировать проверки файлов           (🟡, среднесрочно)
├── [R6.3=R1.2] Audio recovery → trigger-based       (🟡, можно сейчас)
├── [R6.4=R5.2] Governance modules — решить судьбу   (🟢, можно сейчас)
└── [R6.5=R3.1] Убрать stale state tolerance        (🟢, после R2.x)
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
          
Сейчас:   R6.4       →  решить судьбу governance модулей
          
Затем:    R2.1       →  force lease release
          R2.2+R2.3  →  force в regenerate + cleanup
          
Потом:    R3.1/R6.5 →  убрать stale state tolerance
          R1.1       →  startup recovery только логировать
          R1.3       →  reconciliation engine только аудит
          
Далее:    R3.2+R3.3 →  единый оркестратор
          R6.2       →  консолидация проверок файлов
          
В конце:  R4.x      →  версии как source of truth
          R6.1       →  консолидация dual state model
          R5.x       →  чистка дубликатов
``` → R6.x
