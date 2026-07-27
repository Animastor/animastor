# Аудит системы оркестрации — 27 июля 2026

> **Автор:** Buffy (AI review)
> **Основание:** полный код-ревью `backend/src/orchestration/*`, `backend/src/runtime/*`,
> `backend/src/state/scene-state.js`, `backend/src/services/audio-orchestrator.js`,
> тесты, документация.
> **Принцип:** без переусложнения. Система уже рабочая. Нужно найти узкие места,
> которые реально стреляют, и ничего не трогать, что работает.

---

## Общая архитектура (что есть)

```
                   ┌──────────────────────┐
                   │   Orchestrator Facade │  ← orchestrator.js (14 команд)
                   │   (единственный       │
                   │    lifecycle writer)  │
                   └──────┬───────┬───────┘
                          │       │
              ┌───────────┘       └───────────┐
              ▼                               ▼
   ┌──────────────────┐           ┌──────────────────────┐
   │ Dispatch Engine   │           │ Reconciliation Engine│ ← ~1.5k строк
   │ (leases, quotas,  │           │ (self-healing, 6 фаз)│
   │  circuit-breaker) │           └──────────────────────┘
   └────────┬─────────┘
            │
            ▼
   ┌──────────────────┐
   │ Scene Orchestrator│ ← per-stage dispatch (audio/image/video)
   │ + callbacks       │
   └──────────────────┘
```

**14 команд фасада:** `markDirty`, `markDirtyScene`, `planScene`, `beginStage`,
`completeStage`, `failStage`, `completeStageWithoutVideo`, `completeStageWithoutImage`,
`setScenePending`, `setSceneGenerating`, `setSceneAllReady`, `setScenePlaceholder`,
`reconcile`, `resetScenes`.

---

## 🟢 Сильные стороны

### 1. Единый фасад работает
Все lifecycle writes действительно проходят через orchestrator.js. После S2 (переименование
`setAssetState` → `unsafeRestoreAssetState`) и M5 (миграция прямых вызовов через фасад)
в production коде **нет** прямых `state.setAssetState` вне whitelist'а.

### 2. Per-asset state — правильное решение
Трёхмерная система (`audio/image/video`) вместо линейной `SceneState` была правильным
выбором. После T8 (удаление `syncLinearState`) source of truth один: Redis hash
`animastor:asset-state:{book}:{chapter}:{scene}`.

### 3. Event journal есть и работает
События пишутся во все lifecycle-команды. С R1 добавлены journal events для `setScene*`.
TTL 7 дней позволяет расследовать инциденты.

### 4. Reconciliation engine с distributed lock
`reconcileCycle()` имеет `CLEANUP_LOCK` — два экземпляра backend не конкурируют.
Фазы A–D покрывают все классы recovery: result keys, stalled audio, version staleness,
scene reconciliation + auto-fix.

### 5. Dispatch identity protocol (+ тесты)
`verifyDispatchIdentity` + `finalizeDispatch` — lease token, dispatch ID, protocol version.
Есть unit-тесты на stale/missing/duplicate dispatch. Это закрыло класс race conditions
(M5).

---

## 🟡 Слабые стороны (критично)

### W1. Сложность orchestration слоя — 11k строк в 26 файлах

| Компонент | Строк |
|-----------|-------|
| `reconciliation-engine.js` | 1,543 |
| `dispatch-engine.js` | 1,369 |
| `runtime-persistence.js` | 840 |
| `scene-window.js` | 793 |
| `runtime-scheduler.js` | 662 |
| `orchestrator.js` | 634 |
| `retention-manager.js` | 570 |
| `lease-manager.js` | 521 |
| `audio-orchestrator.js` | 498 |
| `circuit-breaker.js` | 497 |
| ... | ... |
| **Total** | **~11,387** |

**Проблема:** 11k строк в оркестрации — это много для одного Node-процесса.
Особенно `reconciliation-engine.js` (1.5k) и `dispatch-engine.js` (1.4k).
Они содержат несколько слабо связанных логик в одном файле.

**Что делать:** НЕ рефакторить сейчас. Файлы большие, но self-contained и стабильные.
Только если будете добавлять новую фазу в reconciliation — вынести в отдельный файл.

### W2. Lazy-require как постоянный костыль

В `orchestrator.js` каждая функция делает 4–6 `require()` внутри тела:

```js
async function completeStage(...) {
    const callbacks = require('./scene-callbacks');
    const dispatchEngine = require('../runtime/dispatch-engine');
    const state = require('../state');
    // ... ещё 5 requires
```

**Почему это слабость:** не читаемость (Node кэширует), а то, что циклические зависимости
между `orchestration/` и `runtime/` НИКОГДА не будут явными. Lazy-require скрывает
реальный граф зависимостей. При добавлении новой команды легко создать неявный цикл.

**Что делать:** оставить как есть. Рефакторинг циклических зависимостей — отдельный
крупный проект (interface extraction + DI). Только следить, чтобы новые зависимости
не создавали новые циклы.

### W3. `resetScenes` — 10 шагов без транзакции

Функция делает: force-dispatch → journal → remove from index → clear leases →
clear hub queues → delete PNGs → clear IU progress → markDirty → add to index →
journal. Между шагами 3 и 9 система в несогласованном состоянии.

**Проблема:** сбой между шагами 5-8 (очистка очередей → markDirty) оставляет сцены
без lease, без dispatch, без dirty-статуса. Scheduler не подхватит, сцена зависнет.

**Что делать:** добавить try/catch с восстановлением active index. Если markDirty
упал — addSceneToActiveIndex всё равно должен быть вызван (сцена хотя бы будет
видна scheduler'у, даже если не dirty).

### W4. Тесты на reconciliation — почти нет

`reconciliation-engine.js` = 1,543 строк. Тестов: `reconciliation-engine.test.js`
(~600 строк, в основном моки). Проверяется только, что `setScenePending` вызывается,
но не реальная логика reconciliation (orphan detection, stale locks, invariant checks).

**Риск:** любое изменение в `reconcileScene()` или `reconcileCycle()` непроверяемо.

**Что делать:** **не** писать тесты на всю 1.5k строку сейчас. Вместо этого:
- Если меняете конкретную фазу (A/B/C/D) — добавьте 1 тест на эту фазу.
- `checkAudioOrchInvariants()` уже есть — тест на неё написан (R6).

### W5. Audio-orch и asset state — ручная синхронизация

Инвариант `audio-orch.phase == DONE ⇔ asset.audio == READY` поддерживается
в 3+ местах: `completeStage` (через handler callback), `failStage` (прямая запись),
`recoverAudioOrchStates` (R3 — теперь sync после setDone). Любое новое место,
меняющее audio-orch, должно не забыть синхронизировать asset state.

**Что делать:** ввести проверку инварианта после КАЖДОГО изменения audio-orch
через единый wrapper. Альтернатива — `checkAudioOrchInvariants()` вызывается
в `reconcileScene()` и исправляет расхождение. Достаточно для production.

---

## 🟢 Что НЕ трогать (работает и не требует изменений)

| Компонент | Почему не трогать |
|-----------|------------------|
| **Per-asset state machine** (scene-state.js) | 219 строк, стабильна, атомарные HSET, validateAssetTransition покрыт тестами |
| **Event journal** (event-journal.js) | 248 строк, append-only, 7-day TTL, все типы событий есть |
| **Dispatch engine** (dispatch-engine.js) | Большой (1.4k), но стабильный. Lease/identity logic проверена тестами |
| **Failure taxonomy** (failure-taxonomy.js) | 125 строк, enum-based, не меняется |
| **Circuit breaker** (circuit-breaker.js) | 497 строк, но не меняется месяцами |
| **Scene callbacks** (scene-callbacks.js) | 435 строк, handler chain audio→image→video, стабильно |

---

## 🎯 Что я бы сделал прямо сейчас (без переусложнения)

### Приоритет 1: try/catch в resetScenes для восстановления active index

```js
// После markDirty — гарантировать addSceneToActiveIndex
try {
    const { computed, marked } = await markDirty(...);
    // ...
} catch (err) {
    warn(`[RESET-SCENES] markDirty failed: ${err.message}`);
    // Не бросаем — scenes должны быть хотя бы видны scheduler'у
} finally {
    if (readdToActiveIndex) {
        for (const ds of scenes) {
            await scheduler.addSceneToActiveIndex(redis, bookId, ds.chapter_id, ds.scene_id);
        }
    }
}
```

Сейчас `markDirty` вызывается без try, и если он упал — `addSceneToActiveIndex`
(шаг 9) не выполняется. Объём: ~10 строк.

### Приоритет 2: Удалить deprecated aliases `setAssetState`/`setAssetStates`

Да, они используются в тестах. Миграция: заменить все вызовы в тестовых файлах
на `unsafeRestoreAssetState`/`unsafeRestoreAssetStates`. Это ~10 файлов, 5 минут
search+replace.

### Приоритет 3: Вынести inline SQL из completeStage (R8)

Добавить `sceneAssetsRepo.getSceneVersions(bookId, chapterId, sceneId)` и заменить
inline `SELECT content_version, audio_config_version FROM scenes`. Объём: ~15 строк.

### Приоритет 4: Добавить try/catch в resetScenes вокруг очистки PNG/IU

Сейчас `fs.unlinkSync` (шаг 6) и `redis.del` (шаг 7) не имеют общего try.
Если очистка PNG упала (например, permission denied) — `markDirty` не вызовется.
Объём: ~5 строк (обернуть шаги 6-7 в try/catch, логировать ошибку).

---

## Резюме

| Аспект | Оценка |
|--------|--------|
| **Архитектура** | ✅ Правильная (facade + dispatch + per-asset) |
| **Надёжность** | 🟡 Есть щели (resetScenes без try, lazy-require) |
| **Тесты** | 🟡 598 тестов + new 3 (R6), но reconciliation не покрыт |
| **Наблюдаемость** | ✅ Journal events, audio-orch invariant checks |
| **Сложность** | 🟡 11k строк, но стабильно |

**Главный риск:** `resetScenes` — единственное место в системе, где последовательность
из 10 шагов может прерваться на середине. Это самый вероятный источник production-инцидента.
Всё остальное — косметика или уже защищено тестами.
