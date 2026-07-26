# Рекомендации по стабилизации системы оркестрации

> **Дата:** 26 июля 2026
> **Основание:** анализ `backend/src/orchestration/*`, `backend/src/runtime/*`, `backend/src/state/scene-state.js`
> **Принцип:** хирургические точечные правки без переусложнения. Никаких новых state-machine'ов,
> очередей, сервисов. Текущая архитектура (фасад + dispatch-engine + per-asset state) — корректна,
> нужно лишь закрыть несколько щелей на стыках.

---

## TL;DR — что не так

| # | Проблема | Серьёзность | Объём |
|---|---------|------------|------|
| R1 | `setScene*` в фасаде пишут state без `validateAssetTransition` и без journal events | **Высокая** | ~30 строк |
| R2 | Deprec­ated aliases `setAssetState`/`setAssetStates` висят в экспортах `scene-state.js` | Низкая | −2 строки |
| R3 | `reconciliation-engine.js` и `scene-window.js` напрямую зовут `audioOrch.*` в обход фасада | Средняя | Рефакторинг по местам |
| R4 | `completeStage`/`failStage` на каждый вызов делают 4–6 lazy `require()` внутри тел | Низкая | ~10 строк |
| R5 | `resetScenes` смешивает 10 слоёв ответственности (journal + fs + redis + lua-итд) в одном теле | Средняя | Вынести в 2 helper'а |
| R6 | Нет тестов на invariant `audio-orch.phase == DONE ⇔ asset.audio == READY` | Средняя | 1 тест |
| R7 | Fallback по `bookDiff = null` в `resetScenes` дублирует логику `markDirtyScene` | Низкая | Унифицировать |
| R8 | `completeStage` совершает inline PG-запрос вместо `sceneAssetsRepo` метода | Низкая | Вынести в repo |

Все рекомендации укладываются в существующий контур из 13 команд фасада — расширять фасад не нужно.

---

## R1. setScene* терминалы в фасаде без валидации и журнала

### Что наблюдается

В `orchestrator.js`:
- `completeStage` → `validateAssetTransition` (косвенно через `unsafeRestoreAssetState` после gate) + journal event ✓
- `failStage` → `state.validateAssetTransition(current, FAILED)` + journal ✓
- `markDirtyScene` → direct write, journal event ✓ (через PG markStale)

НО:
- `setScenePending` (стр. 328) — голый `unsafeRestoreAssetState(..., PENDING)`, без `validateAssetTransition` и **без journal event**
- `setSceneGenerating` (стр. 349) — то же самое для `GENERATING`
- `setSceneAllReady` (стр. 337) — все три ассета в `READY` без journal
- `setScenePlaceholder` (стр. 357) — голый write

### Чем это опасно

`AssetTransitions` в `scene-state.js:50` существует именно для того, чтобы отсекать невалидные
переходы (например, `READY → PENDING` напрямую, без `DIRTY`). Сейчас это соблюдается только в
двух «тяжёлых» командах. Любой race condition или ошибочный вызов `setScenePending` на уже `READY`
ассете молча запишет `PENDING` — scheduler подхватит и запустит повторную генерацию готового контента.
Это именно тот класс багов, который «не проявляется в тестах, но стреляет в проде».

Журнал событий (`event-journal.js`, TTL 7 дней) — единственный способ расследовать
«как сцена оказалась в PENDING в 03:14 ночи». Сейчас переходы через `setScene*` невидимы.

### Предлагаемое исправление

Не добавлять новые команды. Внутри существующих `setScene*` дописать:

1. Прочитать текущее состояние `getAssetStates`.
2. `validateAssetTransition(current, target)` — если `valid:false`, warn + journal `INVALID_STATE_*` + вернуть `{ changed: false, reason }`.
3. После `unsafeRestoreAssetState` вызывать `journal.appendSceneEvent` с подходящим типом
   (`SCENE_PENDING`, `SCENE_GENERATING`, `SCENE_ALL_READY` — типы уже есть в `event-journal.js`,
   либо переиспользовать `INVALID_STATE_CALLBACK`/`SCENE_RESET` по смыслу).

Шаблон (для `setScenePending`):

```js
async function setScenePending(redis, bookId, chapterId, sceneId, asset, buildId = null) {
    const state = require('../state');
    const journal = require('./event-journal');
    const { log, warn } = require('./scene-utils');
    const states = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const check = state.validateAssetTransition(states?.[asset], state.AssetState.PENDING);
    if (!check.valid && states?.[asset] !== state.AssetState.PENDING) {
        warn(`[SET-PENDING] ${bookId}/${chapterId}/${sceneId} ${asset}: ${states?.[asset]}→pending rejected (${check.reason})`);
        await journal.appendSceneEvent(redis, bookId, chapterId, sceneId,
            journal.EventType.INVALID_STATE_CALLBACK, states?.[asset],
            { asset, attempted: 'pending', ignored: true }).catch(() => {});
        return { changed: false, reason: check.reason };
    }
    await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, asset, state.AssetState.PENDING);
    await journal.appendSceneEvent(redis, bookId, chapterId, sceneId,
        journal.EventType.SCENE_PENDING, state.AssetState.PENDING,
        { asset, buildId }).catch(() => {});
    return { changed: true };
}
```

Это **точечная** правка в 4 функциях — около 30 строк суммарно, без изменения контракта.
Callers продолжают звать те же методы, теперь просто нечем «протолкнуть» невалидный переход.

**Не делать:** вводить middleware/hook-систему для всех writes. Только явная валидация в терминальных
функциях, где её сейчас нет.

---

## R2. Удалить deprecated aliases из scene-state.js

`scene-state.js:196-197` оставляет:
```js
const setAssetState = unsafeRestoreAssetState;
const setAssetStates = unsafeRestoreAssetStates;
```
с комментарием «REMOVE after S2.3 migration». Согласно `ORCHESTRATION_TODO.md` S2.3 завершён.
grep по коду показывает, что **0 вызвов** `state.setAssetState` / `state.setAssetStates` вне
самого `scene-state.js` (в codebase остались только `unsafeRestoreAsset*`).

**Действие:** удалить alias-экспорты и упоминание в JSDoc. Это −2 строки + одно место меньше для
ошибочного вызова в новых файлах. Никакой миграции не требуется.

---

## R3. Reconciliation/window идут в audioOrch мимо фасада

`reconciliation-engine.js` содержит **18 прямых вызовов** `audioOrch.*` (`scanAllStates`,
`failWaitingScene`, `completeChunk`, `setState`, `setFailed`, `setDone`, `deleteState`).
`scene-window.js:766` зовёт `audioOrch.initPlaceholderReady` напрямую.

Это перечит инварианту, провозглашённому в `ORCHESTRATION.md` §2.1: «Никто не вызывает
`audioOrch.*()` напрямую — только через фасад». Соответственно фазы 7–9 в TODO отмечены 🔴
как невыполненные.

### Почему это важно

Аудио-инвариант `audio-orch.phase == DONE ⇔ asset.audio == READY` поддерживается **только**
ручной синхронизацией в `completeStage`/`failStage`. Если reconciliation меняет `audioOrch.phase`
на `DONE` (например, `setDone` после recovery), а asset state при этом остаётся `GENERATING`,
следующий tick scheduler'а увидит `GENERATING` и попытается снова диспатчить готовое аудио —
получим цикл.

### Что предлагается (без reflow)

Не переносить весь reconciliation на фасад — это большая работа и явное усложнение. Вместо этого:

1. Ввести **одну** новую операцию фасада: `reconcileAudioPhase(redis, bookId, chapterId, sceneId, action, payload)`
   с actions: `{ setDone, setFailed, completeChunkRecovery, deleteStateIfNeeded }`. Это **не** 13-я
   команда жизненного цикла — это **recovery-helper**, который:
   - вызывает `audioOrch.*` 
   -kraftvoll синхронизирует `asset.audio` (`unsafeRestoreAssetState`) сразу же
   - пишет journal event `AUDIO_RECONCILED`

   **Контроверсия:** это нарушает «не расширять фасад». Контраргумент — это не lifecycle-команда,
   а атомарная единица reconciliation. Сейчас reconciliation уже дёргает audioOrch +
   unsafeRestoreAssetState через фасад в одном месте (`line 869`), просто раскидано.
   
   **Альтернатива без новой команды:** в `reconciliation-engine.js` сразу после каждого
   `audioOrch.setDone/setFailed/completeChunk` вызывать `orchestrator.completeStage`/
   `failStage` (уже сделано в части мест, нужно протащить везде одинаково).

**Рекомендация:** пойти альтернативным путём — выровнять все 18 мест под единый паттерн
`audioOrch.X() → orchestrator.completeStage/failStage/markDirtyScene()`. Это не добавляет
новых команд, а только замыкает существующий контракт. Объём: ~30 строк правок в
`reconciliation-engine.js`, без нового API.

---

## R4. Lazy require внутри функций — переусложнение

В `orchestrator.js` (`completeStage`, `failStage`, `markDirtyScene`, `resetScenes`) каждый
вызов делает 4–6 lazy `require()` внутри тела:

```js
async function completeStage(...) {
    const callbacks = require('./scene-callbacks');
    const dispatchEngine = require('../runtime/dispatch-engine');
    const state = require('../state');
    const { log, warn, error } = require('./scene-utils');
    const sceneAssetsRepo = require('../storage/postgres/repositories/scene-assets-repo');
    // ...
}
```

Это сознательный компромисс Шага 0 (комментарий в `orchestrator.js:16-19`) для разрыва цикла
`orchestration ↔ runtime`. Проблема: цикл уже разорван паттерном lazy-require в
`dispatch-engine.js` и `runtime-scheduler.js` (которые тоже require'ят orchestrator внутри функций).
То есть lazy-require здесь **работает только в одну сторону** — facade ≠ cycle break.
Модульная система Node кэширует require после первого вызова, поэтому runtime-cost нулевой,
но readability страдает.

### Что предлагается

Топ-level require для неучаствующих в цикле модулей:
- `scene-callbacks`, `scene-utils`, `state`, `scene-assets-repo`, `event-journal`,
  `audio-orchestrator`, `failure-taxonomy` — безопасно, циклов нет.
- `dispatch-engine`, `runtime-scheduler`, `reconciliation-engine`, `runtime-config` (если он
  require'ит что-то из orchestration) — оставить lazy, они действительно циклические.

Объём: ~10 строк перемещается вверх, тело функций становится чище на 4-5 строк.
Без изменения поведения, чисто читаемость +1.

---

## R5. resetScenes — слоёный пирог из 10 шагов

`orchestrator.js:413-549` — одна функция на 136 строк делает:
1. force-dispatch flag in Redis
2. journal event SCENE_RESET
3. removeScenesFromActiveIndex (scheduler)
4. clearLeasesForScenes (dispatch-engine)
5. clearHubDispatches (HTTP DELETE /queue/clear)
6. fs.unlinkSync stale PNGs (цикл по scene×units)
7. redis.scan + redis.del iu-progress + iu-in-flight
8. markDirty через bookDiff или fallback
9. addSceneToActiveIndex (scheduler)
10. journal event SCENE_RESET_COMPLETED

Шаги 1, 6, 7 — это **gather/cleanup** инфраструктурных артефактов (force flags, файлы, счётчики).
Шаги 3, 4, 5, 9 — **scheduler/dispatch contract**. Шаги 2, 10 — наблюдаемость.
Шаг 8 — сам lifecycle write (через `markDirty`, который уже фасад).

### Что предлагается (без разбиения на 5 файлов)

Вынести в два локальных helper'а в том же файле `orchestrator.js`:

- `_cleanupRegenerationArtifacts(redis, bookId, buildId, scenes, cleanPngUnitIds)` — шаги 6+7
  (файлы + iu-progress/in-flight). Это чистая платформенная операция, не касается lifecycle.
- `_emitResetLifecycleEvents(redis, bookId, chapterId, sceneId, scope, scenesCount, marked)` —
  шаги 2+10. Просто чтобы убрать дублирование формата journal events в начале и конце.

`resetScenes` останется оркестратором шагов, но тело сократится с 136 → ~70 строк, и каждое
действие будет явно поименовано helper'ом. Контракт не меняется.

**Не делать:** создавать класс `RegenerationFlow` или middleware pipeline. Это переусложнение.
Достаточно двух локальных функций.

---

## R6. Тест на audio-orch инвариант

В `backend/tests/orchestration-stabilization.test.js` есть тесты на dispatch ownership
(lease token mismatch, stale dispatch, duplicate finalization) — это хорошо. Но нет теста на
**основной инвариант** системы:

```
audio-orch.phase == DONE   ⇔   asset.audio == READY
audio-orch.phase == FAILED ⇒   asset.audio ∈ {FAILED, PENDING}
```

Без него любое изменение в `completeStage`/`failStage` рискует молча нарушить синхронизацию.

### Что предлагается

Один `describe('audio-orch invariant')` с тремя `it`:
1. `completeStage('audio')` переводит asset в READY **и** audio-orch.phase в DONE.
2. `failStage('audio')` переводит asset в FAILED→PENDING **и** audio-orch.phase в FAILED.
3. `completeStage('audio')` с `handler.ok:false` НЕ трогает ни asset, ни audio-orch (NEVER READY).

Моки для audio-orch и sceneAssetsRepo в `mocks/` уже есть (S4 завершён). Объём — ~80 строк теста,
в один файл. Это единственная рекомендация, которая **создаёт** код, а не перерабатывает существующий —
но без неё остальные правки не защищены регрессией.

---

## R7. Двойной путь markDirty в resetScenes

`orchestrator.js:518-529`:

```js
if (bookDiff && typeof bookDiff.markDirtyScenes === 'function') {
    marked = await markDirty({ bookDiff }, redis, bookId, buildId, scenes, layerCfg);
} else {
    log('[RESET-SCENES] No bookDiff provided — using markDirtyScene fallback');
    for (const ds of scenes) {
        for (const layer of (ds.dirty_layers || ['audio', 'image', 'video'])) {
            await markDirtyScene(redis, bookId, ds.chapter_id, ds.scene_id, [layer]);
        }
    }
}
```

Эти два пути **семантически разные**:
- `bookDiff.markDirtyScenes` — Lua-атомарная операция, пишет chunks + state + active index одним
  скриптом (см. ORCHESTRATION.md §2.8 R7).
- Fallback — поэлементный `markDirtyScene`, который НЕ пишет chunks и не активирует index атомарно.

Если в проде кто-то забудет передать `bookDiff` (DI от route), система молча откатится на
неатомарный путь — и при конкурентной regenerate появится race. Внутренние контракты нельзя
держать на «опциональной» DI.

### Предложение

Сделать `bookDiff` обязательным: `if (!bookDiff) throw new Error('resetScenes: bookDiff is required')`.
Все caller'ы уже его передают (через DI из route). Fallback удалить.

Альтернатива — сохранить fallback, но логировать как `ERROR` (не `log`), и добавить метрику в
Prometheus: `reset_scenes_fallback_total`. Это позволит увидеть, если fallback всё же стреляет.
Второй вариант мягче, на случай если есть редкий caller без bookDiff.

**Рекомендация:** первый вариант (throw). Это явный контракт. grep callers подскажет, если
что-то пропущено — лучше упасть в start, чем тихо разъезжаться.

---

## R8. PG-запрос inline в completeStage

`orchestrator.js:132-154` — встроенный SQL в теле функции:

```js
const sceneResult = await pgQuery(`
    SELECT content_version, audio_config_version FROM scenes
    WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
`, [bookId, chapterId, sceneId]);
```

Это делает фасад зависимым от структуры PG-схемы. Любой рефакторинг `scenes` ломает `orchestrator`.

### Что предлагается

Добавить метод `scene-assets-repo.getSceneVersions(bookId, chapterId, sceneId)` (или
`scenes-repo`, если он есть), возвращающий `{ content_version, audio_config_version }`.
Вынести туда этот SELECT. Фасад зовёт repo.

Объём — 1 метод в repo, замена inline SQL на вызов. Никаких новых абстракций.

---

## Чего НЕ делать (дополнение к существующему списку)

- Не вводить event-sourcing для asset state. Redis hash + PG canonical — достаточно.
- Не добавлять централизованный `validateTransition` interceptor для всего facade — достаточно точечно в `setScene*`.
- Не расщеплять `orchestrator.js` на 3 файла (markDirty/complete/fail). 13 команд помещаются в одном файле ~600 строк.
- Не делать circuit-breaker для PG (сейчас fail-closed на PG error — корректно).
- Не мигрировать `audioOrch.*` вызовы из reconciliation одним PR — медленно, по 2-3 места за раз.

---

## Приоритеты и порядок внедрения

| Этап | Задачи | Объём | Риск |
|------|--------|------|------|
| **Phase A (сутки)** | R2 (удалить alias), R6 (тест инварианта), R4 (top-level require) | ~120 строк | Низкий |
| **Phase B (неделя)** | R1 (validate+journal в setScene*), R7 (bookDiff required), R8 (вынести SQL в repo) | ~80 строк | Средний |
| **Phase C (2 недели)** | R3 (выровнять 18 audioOrch вызовов), R5 (split resetScenes на 2 helper'а) | ~150 строк | Средний |

Все три фазы **суммарно меньше**, чем один `reconciliation-engine.js` (1541 строка).
Новая функциональность не добавляется, новая сложность не вводится.

---

## Контрольные критерии «стабильно»

| Критерий | Сейчас | После |
|----------|-------|------|
| `validateAssetTransition` вызывается во всех 13 lifecycle writes фасада | 2 из 13 | 13 из 13 |
|journal event пишется на каждое изменение asset state | ~5 мест | все терминальные |
| Deprec­ated API в `state.js` | 2 alias | 0 |
| Прямой `audioOrch.*` вне `orchestrator.js` и `scene-orchestrator.js` | 18 вызовов | 0 |
| Тест на audio-orch инвариант | нет | 3 кейса |
| Inline SQL в `orchestrator.js` | 1 SELECT | 0 |

После выполнения Phase A+B+C система остаётся в **тех же границах сложности**, что и сейчас:
один Node-процесс, Redis, PG, те же 13 команд фасада, тот же dispatch-engine. Только щели
между ними становятся наблюдаемыми и валидируемыми.

<!-- === Footer === -->
---
*Рекомендации по стабилизации. 26 июля 2026. Основание: кодовый ревизия `2026-07-26`.*
