# M5: Устранение конкуренции за состояние сцены

> **Дата:** 2026-06-28
> **Цель:** Свести все 8 точек записи per-asset состояния к единому фасаду (Orchestrator), устранив конкуренцию между dirty-системой, window-системой, recovery и reconciliation engine.
> **Основание:** `docs/ARCHITECTURAL_AUDIT_CONFLICTING_SUBSYSTEMS.md`, `docs/STATE_WRITERS_MAP.md`

---

## 1. Проблема

Четыре независимых механизма могут устанавливать per-asset состояние сцены, не зная о намерениях друг друга:

| # | Подсистема | Что пишет | Когда |
|---|---|---|---|
| **P2** | `scene-callbacks.js` | ✅ `orchestrator.completeStage` | GPU callback завершения — READY через facade |
| **P4** | `reconciliation-engine.js` | `setAssetState(..., DIRTY/PENDING)` | auto-fix (applyFix) |
| **P5** | `startup-recovery.js` | `orchestrator.markDirtyScene(...)` | старт сервера |
| **P6** | `scene-restoration.js` | `orchestrator.markDirtyScene(...)` | /regenerate |
| **D1** | `scene-window.js` | `setAssetStates(..., READY/PENDING)` | window slide + cache check |
| **L** | `runtime-persistence.js` | `setAssetStates(...)` | snapshot restore |
| **L** | `debug-routes.cjs` | `setAssetStates(...)` | ручной debug |
| **L** | `redis-helpers.cjs` | `setAssetStates(...)` | хелпер |

**Ключевой конфликт:** P4, P5, P6, D1 могут переопределить DIRTY/PENDING обратно в READY, если на диске есть файлы от предыдущей генерации. Это приводит к тому, что force-regen не срабатывает.

---

## 2. Текущее состояние миграции

### ✅ Уже за фасадом (orchestrator.markDirtyScene / orchestrator.markDirty)

| Writer | Файл | Строка | Статус |
|---|---|---|---|
| P1 | `scene-orchestrator.js` | 52, 80, 124 | ✅ GENERATING через beginStage path |
| P3 | `runtime-scheduler.js` | 237-245 | ✅ markVersionStaleDirty — explicit pre-pass (Д.2) |
| P4 | `reconciliation-engine.js` | 610, 673 | ✅ orchestrator.markDirtyScene |
| P5 | `startup-recovery.js` | 289 | ✅ orchestrator.markDirtyScene |
| P6 | `scene-restoration.js` | 103 | ✅ orchestrator.markDirtyScene (только image) |
| P8 | `book-routes.cjs` | 1649 | ✅ orchestrator.markDirty |

### ✅ Шаг 1 выполнен: P2 за фасадом

| Writer | Файл | Статус |
|---|---|---|
| P2 | `scene-callbacks.js` | ✅ `orchestrator.completeStage` (READY) |

### ✅ Шаг 2 выполнен: D1 за фасадом

| Writer | Файл | Статус |
|---|---|---|
| D1 | `scene-window.js` | ✅ 7 прямых вызовов → `orchestrator.*` |

### ❌ Ещё пишут напрямую через state.setAssetState

| Writer | Файл | Что пишет |
|---|---|---|
| L | `runtime-persistence.js` | `setAssetStates(...)` — snapshot restore |
| L | `debug-routes.cjs` | `setAssetStates(...)` — ручной debug |
| L | `redis-helpers.cjs` | `setAssetStates(...)` — хелпер |
| L | `scene-restoration.js` | `setAssetState(audio, READY)` (Д.3: с version gate) |

### ❌ syncLinearState вызывается вручную (L1-L7)

| Writer | Файл | Строки |
|---|---|---|
| L1 | `scene-orchestrator.js` | 30, 48, 76, 120 |
| L2 | `scene-callbacks.js` | 362, 388, 540, 558 |
| L3 | `reconciliation-engine.js` | 711, 727, 752, 790 |
| L4 | `scene-window.js` | 457, 569, 593, 610 |
| L5 | `book-routes.cjs`, `window-generator.cjs`, `redis-helpers.cjs` | по 1 |
| L6 | `runtime-persistence.js` | 604 |
| L7 | `debug-routes.cjs` | 381, 443 |

---

## 3. План миграции (5 шагов)

### ✅ Шаг 1 выполнен: completeStage — единый владелец перехода в READY

**Коммит:** (будет добавлен после push)

**Что сделано:**
- `orchestrator.completeStage` — добавлен `setAssetState(READY)` + `syncLinearState` после handler
- `scene-callbacks.js` — убраны `setAssetState(READY)` из 3-х callback-ов (audio/image/video)
- `scene-callbacks.js` — убраны `setAssetState` + `syncLinearState` из `completeSceneWithoutVideo`/`Image` (dead code)
- `orchestrator.js` — добавлены `completeStageWithoutVideo`/`Image` facade-методы
- `happy-path.test.js` — 3 теста обновлены: проверяют, что handler НЕ ставит READY, а facade ставит

**Тесты:** 400/400 passing

---

### ✅ Шаг 2 выполнен: scene-window → facade

**Цель достигнута:** Все прямые вызовы `state.setAssetState/setAssetStates/syncLinearState` в `scene-window.js` заменены на facade-методы.

**Что сделано:**
- `orchestrator.js` — добавлены `setScenePending`, `setSceneAllReady`, `setScenePlaceholder` (каждый делает setAssetState + syncLinearState)
- `orchestrator.js` — добавлен `syncLinearState` в `markDirtyScene` (Шаг 3 prep)
- `scene-window.js` — 7 прямых вызовов заменены на `orchestrator.*`
- `scene-window.js` — `const resultState` → `let resultState` для if/else assignment

**Файлы:** `orchestrator.js`, `scene-window.js`

**Тесты:** 400/400 passing. Без циклических зависимостей (facade использует lazy require).

---

### ✅ Шаг 3 выполнен: syncLinearState — автоматический побочный эффект facade

**Цель достигнута:** syncLinearState вызывается автоматически внутри каждой facade-команды, ручные вызовы из callers удалены.

**Что сделано:**
- `orchestrator.beginStage` — добавлен `syncLinearState` после `dispatchStage` (PENDING/GENERATING)
- `scene-orchestrator.js` — удалены 4 вызова `syncLinearState` из `startScene`, `executeAudioDispatch`, `executeImageDispatch`, `executeVideoDispatch`
- `reconciliation-engine.js` — удалены 2 редундантных `syncLinearState` после `orchestrator.markDirtyScene`
- `scene-restoration.js` — удалён 1 редундантный `syncLinearState` после `orchestrator.markDirtyScene`

**Оставшиеся ручные вызовы (легитимные):**
- `reconciliation-engine.js` — 4 вызова после прямых `state.setAssetState` (ждёт Шага 4)
- `runtime-persistence.js` — 1 вызов (snapshot restore, вне facade)
- `debug-routes.cjs` — 2 вызова (debug, вне facade)
- `scene-restoration.js` — 1 вызов после `restoreChunkStatusForScene` (только chunk metadata, не per-asset)

**Файлы:** `orchestrator.js`, `scene-orchestrator.js`, `reconciliation-engine.js`, `scene-restoration.js`

**Тесты:** 400/400 passing

---

### Шаг 4: Reconciliation — только аудит, auto-fix через facade

**Цель:** Убрать auto-fix из runtime-loop (уже R1.2 — только логирует), оставить applyFix только через явный POST /debug.

**Изменения:**

#### 4a. runtime-loop.js — убрать reconcileAll (уже log-only)

```javascript
// Было (строка 56):
const reconcileReport = await reconciliationEngine.reconcileAll(redis);
// Стало: убрать или закомментировать
```

#### 4b. reconciliation-engine.js applyFix — route через orchestrator

Уже сделано для `MOVE_TO_PENDING` (строка 610) и `RELEASE_STALE_LEASE` (строка 673). Остальные кейсы (`REGENERATE_MISSING_ASSET`, `PROGRESS_TO_IMAGE`, `PROGRESS_TO_VIDEO`, `RECOVER_ORPHAN_ASSETS`) всё ещё используют прямой `state.setAssetState`. Их нужно перевести на `orchestrator.markDirtyScene` / `orchestrator.setScenePending`.

**Файлы:** `runtime-loop.js`, `reconciliation-engine.js`

---

### Шаг 5: Version gate — обязательная проверка перед любым READY

**Цель:** Любой переход в READY через facade проверяет PG версию. Если `asset_version < scene_version` — READY → DIRTY.

**Изменения:**

#### 5a. Добавить version check в `orchestrator.completeStage`

```javascript
async function completeStage(redis, bookId, chapterId, sceneId, stage, buildId) {
    const state = require('../state');
    const { query: pgQuery } = require('../storage/postgres/database');

    // ... handler ...

    // ⛔ Version gate: если asset stale, не пишем READY, пишем DIRTY
    const sceneResult = await pgQuery(`
        SELECT content_version, audio_config_version FROM scenes
        WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
    `, [bookId, chapterId, sceneId]);

    if (sceneResult.rows.length > 0) {
        const sv = sceneResult.rows[0];
        // Проверка для каждого stage
        const assetVer = await getAssetVersion(bookId, chapterId, sceneId, stage, buildId);
        if (assetVer != null && sv.content_version != null && assetVer < sv.content_version) {
            log(`[VERSION-GATE] ${bookId}/${chapterId}/${sceneId}: ${stage} stale (ver ${assetVer} < ${sv.content_version}) — DIRTY вместо READY`);
            await orchestrator.markDirtyScene(redis, bookId, chapterId, sceneId, [stage]);
            return; // skip READY
        }
    }

    await state.setAssetState(redis, bookId, chapterId, sceneId, stage, state.AssetState.READY);
    // ...
}
```

**Файлы:** `orchestrator.js`, `scene-callbacks.js` (удалить version-gate из restoreSceneChunkStatus — теперь он в едином месте)

**Риск:** Высокий. Version gate может заблокировать легитимные READY, если PG версии не синхронизированы. Требует тщательного тестирования.

---

## 4. График выполнения

```
Шаг 1 (completeStage → READY) ──────── ✅ ВЫПОЛНЕН
   4 файла, 400/400 тестов
   Риск: низкий

Шаг 2 (scene-window → facade) ──────── ◐ В ПРОЦЕССЕ
   2 файла, ~15 строк
   Риск: средний

Шаг 3 (auto syncLinearState) ──────── ✅ ВЫПОЛНЕН
   4 файла, 400/400 тестов
   Риск: средний — syncLinearState критичен, но изменения безопасны (call chain verified)

Шаг 4 (reconciliation → audit-only) ── □ ОЧЕРЕДЬ
   2 файла, ~5 строк
   Риск: низкий

Шаг 5 (version gate на READY) ──────── □ ОЧЕРЕДЬ
   2 файла, ~20 строк
   Риск: высокий
```

---

## 5. Тестирование

### 5.1 Существующие тесты

```bash
npm test
```
**Текущее состояние: 400 passing** (после Шага 1).

### 5.2 Новые тесты для каждого шага

**Шаг 1:**
- `completeStage` пишет `setAssetState(READY)` после handler → проверить Redis
- `completeStage` не пишет READY, если handler упал → проверить Redis
- Callback без `setAssetState` внутри → callback возвращает корректный результат

**Шаг 2:**
- `orchestrator.reconcileWithFacts` принимает diskFacts и принимает решение
- stale file на диске не приводит к READY (version gate)

**Шаг 3:**
- После `orchestrator.markDirtyScene` → linear state = AUDIO_PENDING
- После `orchestrator.completeStage` → linear state корректный

**Шаг 5:**
- Asset_version < scene_version → DIRTY, не READY
- Asset_version === scene_version → READY
- Нет PG записи → READY (fallback)

### 5.3 Интеграционный тест

```javascript
// Сценарий: force-regen не отменяется stale файлами
// 1. Создать scene с image=READY, PG content_version=1
// 2. Записать stale PNG на диск
// 3. Bump content_version → 2
// 4. Вызвать completeStage(image)
// 5. Проверить: image_state = DIRTY, не READY
```

---

## 6. Критерии завершения

Система достигла цели, когда:

1. **Нет прямых вызовов `state.setAssetState`** вне facade-команд (orchestrator.js), за исключением:
   - `state.getAssetState` / `state.getAssetStates` — только чтение
   - `debug-routes.cjs` — debug (явное исключение)
   - `runtime-persistence.js` — snapshot restore (явное исключение)
   - `state.syncLinearState` не вызывается вручную вне facade

2. **После `redis flushall`:**
   - Startup recovery логирует расхождения, не меняет состояние
   - Scheduler проверяет PG версии при dispatch
   - stale файлы на диске не приводят к READY

3. **Все тесты проходят** (381+ → 400+)

---

## 7. Риски и mitigation

| Риск | Mitigation |
|---|---|
| syncLinearState не вызван → stale linear state для плеера | На Шаге 3 проверять, что facade всегда вызывает syncLinearState. unit-тест на каждую facade-команду |
| Version gate блокирует READY при рассинхронизации PG/REDIS | Graceful fallback: если PG query упал, пропустить gate (log warning). Gate включается постепенно — сначала логировать, потом блокировать |
| completeStageWithoutVideo/Image вызываются не через facade | Перенаправить через `orchestrator.completeStageWithoutVideo` |
| Регрессия в task-handler.cjs (6 вызовов completeStage) | Проверить, что все 6 вызовов идут через `orchestrator.completeStage` (уже так) |

---

## 8. Приложение: полная карта вызовов state.setAssetState

### ✅ За фасадом (orchestrator facade — Шаги 0-2)

| Writer | Назначение | Через facade |
|---|---|---|
| P1 | scene-orchestrator: GENERATING | `beginStage` → `dispatchStage` |
| P2 | scene-callbacks: READY | `completeStage` (✅ Шаг 1) |
| P3 | runtime-scheduler: DIRTY | `markVersionStaleDirty` → `markDirtyScene` |
| P4 | reconciliation-engine: DIRTY | `markDirtyScene` |
| P5 | startup-recovery: DIRTY | `markDirtyScene` |
| P6 | scene-restoration: DIRTY | `markDirtyScene` |
| P8 | book-routes: PENDING | `markDirty` → `bookDiff.markDirtyScenes` |
| D1 | scene-window: PENDING/READY/PLACEHOLDER | `setScenePending`/`setSceneAllReady`/`setScenePlaceholder` (✅ Шаг 2) |

### ❌ Ещё НЕ за фасадом

| Writer | Файл | Что пишет |
|---|---|---|
| L | `runtime-persistence.js` | `setAssetStates(...)` — snapshot restore |
| L | `debug-routes.cjs` | `setAssetStates(...)` — ручной debug |
| L | `redis-helpers.cjs` | `setAssetStates(...)` — хелпер |
| L | `scene-restoration.js` | `setAssetState(audio, READY)` (Д.3: с version gate) |
