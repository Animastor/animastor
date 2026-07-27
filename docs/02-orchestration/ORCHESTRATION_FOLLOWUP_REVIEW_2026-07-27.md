# Фоллоу-ап ревью недавних коммитов оркестрации и task-системы

> **Дата:** 27 июля 2026
> **Охват:** коммиты 25–27 июля 2026 (вчера + сегодня)
> **Метод:** git history → чтение diff'ов → сверка с фактическим кодом HEAD → запуск `npm test`
> **Принцип:** точечные замечания там, где видно реальное окно рассинхрона или регрессии.
> Не трогать то, что починилось. Без переусложнения.

---

## 1. Что происходило (контекст)

За 25–27 июля в оркестрации/task layer прошла серия крупных артефактов:

| Группа | Коммиты | Тема |
|--------|---------|------|
| **Audio recovery bugfixes** | `8bd08bc`, `84aae09`, `22ed20f`, `c1a97b3`, `4fc9e3d` | 0-segments цикл, scene_not_found бесконечный loop, placeholder-аудио не контент, stale_dispatch чанки |
| **Quotas / cleanup** | `d8a598a`, `ed1c459` | Увеличение квот 3→8/2→4/1→2, consolidated GPU hub cleanup, gen-scope TTL + startup migration |
| **Parallel F15** | `6daa5c1`, `090f279`, `0468243`, `62b5679`, `2df246a`, `06188d6`, `5a06f96`, `c6df601`, `5685704`, `5a27db9`, `21eda6b` | Independent parallel tasks, per-task таймеры/expiry, no overwrite `_activeGeneration` |
| **R audit fixes** | `fa6c039`, `5884139`, `3ae734b` | R1 validate+journal в setScene*, R3 sync после setDone, R6 invariant тесты, R7 bookDiff mandatory, W1 try/catch вокруг markDirty |
| **Task terminology** | `34862c3`, `7bd8ec4`, `c1b01bc`, `be2ca8f`, `865a38c`, `4717ac7`, `3632ae2` | WorkerUi→TaskRow, buildWorker→buildTaskRows, scopedTaskLabel, `TASK_ARCHITECTURE.md` |
| **Deps cleanup** | `7761dea`, `ed1c459` | Lazy-require → DI для scheduler/sceneWindow в routes |

**Тесты:** 598 passing (проверено `npm test` на HEAD). Регрессий нет.

---

## 2. Что починилось корректно (подтверждено кодом)

| Right action | where | verification |
|--------------|-------|--------------|
| **R1**: `validateAssetTransition` + journal во всех 4 `setScene*` | `orchestrator.js:322-435` | Все 4 функции имеют `INVALID_STATE_CALLBACK` guard и `SCENE_*` events |
| **R6**: инвариант-тесты | `backend/tests/orchestration-stabilization.test.js` (+215 строк) | Тесты запускаются, 598 passing |
| **R7**: `bookDiff` обязательный | `orchestrator.js:594` | `throw new Error` при отсутствии `bookDiff.markDirtyScenes` |
| **W1**: try/catch вокруг markDirty | `orchestrator.js:602-607` | Гарантирует `addSceneToActiveIndex` даже при ошибке markDirty |
| **R3 частично**: sync после `setDone` в MERGING→DONE recovery | `reconciliation-engine.js:1413` | `unsafeRestoreAssetState('audio', READY)` после `audioOrch.setDone` |
| **Audio bugfix**: 0 segments → DONE early | `scene-orchestrator.js:168-177` | Ломает infinite dispatch→pending→re-dispatch loop |
| **Audio bugfix**: scene_not_found → `completed:true` | `scene-orchestrator.js:65,206,278` | Все 3 executor'а возвращают `completed:true`, scheduler перестаёт re-dispatch'ить |
| **Audio bugfix**: stale recovery detect chunks before reset | `scene-orchestrator.js:118-132`, `reconciliation-engine.js:1372-1399` | `findExistingSceneChunks` + `completeChunk` вместо слепого FAILED |
| **Audio bugfix**: placeholder не считать за реальный контент | `scene-restoration.js` (`c1a97b3`) | `placeholderAudio.hasRealAudio` checkdition перед `asset.audio=READY` |
| **Audio bugfix**: stale_dispatch чанки при WAITING_CHUNKS | `4fc9e3d` | Router to task-handler, не выбрасывает delayed客家й чанк из устаревшей dispatch |
| **Quotas** 3→8/2→4/1→2 + tests aligned | `d8a598a`, `86defe5` | `happy-path.test.js` ожидает `audio=8/image=4/video=2` |
| **Consolidated `clearHubDispatches`** | `dispatch-engine.js:977`, `orchestrator.js:471` | Один helper, единая auth + error path across all callers |
| **Gen-scope TTL + migration** | `gen-scope.js` (TTL 24h, `migrateLegacyScopes`) | Вызывается на startup из `backend.cjs:290` |
| **DI для scheduler/sceneWindow** в routes | `7761dea` | Lazy-require → DI в generation-routes, легко тестировать |

Все эти точки отпали — повторных замечаний нет.

---

## 3. Что осталось воспаленным (follow-up рекомендации)

### F1. R3-патч покрыл 1 из 3 audio-orch FAILED recovery веток

`reconciliation-engine.js:recoverAudioOrchStates()` (стр. 1365+) имеет три ветки,
вызывающие `audioOrch.setFailed` напрямую (а не через `failWaitingScene`, который
сам зовёт `orchestrator.failStage`):

| Строка | Ветка | Sync asset.audio? | Journal `AUDIO_FAILED`? |
|--------|-------|-------------------|------------------------|
| 1401 | `GENERATING/WAITING_CHUNKS → FAILED` (restart_recovery) | ❌ только `markDirtyScene` ниже ставит DIRTY | ❌ нет |
| 1411 | `MERGING → DONE` | ✅ R3: `unsafeRestoreAssetState('audio', READY)` | ✅ (log only, recovery-context) |
| 1416 | `MERGING → FAILED` (restart_merge_missing) | ❌ только `markDirtyScene` ниже ставит DIRTY | ❌ нет |

R3-патч починил только ветку 1411. В ветках 1401 и 1416:
- asset.audio переводится в `DIRTY` через `markDirtyScene` (transition `GENERATING→DIRTY` валиден по `AssetTransitions`, см. `scene-state.js:54`),
- но `FAILED` никогда не пишется в asset state и нет события `AUDIO_FAILED` в journal.

**Риск для расследования:** при рестарте backend сцена из «аудио в paused генерации»
окажется в `DIRTY` без записи об `AUDIO_FAILED` в журнале. Событие `SCENE_DIRTY`/`INVALID_STATE_CALLBACK`
не скажет о причине (только `[AUDIO-ORCH] Recover ... → FAILED` warn в лог).

**Рекомендация** (минимально-инвазивная):

В `reconciliation-engine.js` сразу после `audioOrch.setFailed(...)` в строках 1401 и 1416
добавить синхронизацию asset state по аналогии с уже сделанной для `setDone`:

```js
await audioOrch.setFailed(redis, bookId, chapterId, sceneId, 'restart_recovery');
// F1: синхронизируем asset.audio — FAILED, как в R3 для setDone
await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, 'audio', state.AssetState.FAILED);
// Затем markDirtyScene → DIRTY (PENDING-redispatch path for scheduler)
if (deps.orchestrator) {
    await deps.orchestrator.markDirtyScene(redis, bookId, chapterId, sceneId, ['audio']);
}
```

Альтернатива (чище, но больше изменений): заменить тройку `setFailed + restoreFailed + markDirtyScene`
на одну `orchestrator.failStage(..., { redispatch: false })`, а затем `markDirtyScene`. `failStage`
сам ставит `asset.audio=FAILED`, пишет journal `AUDIO_FAILED`, делает `finalizeDispatch('failure')`.
Объём: 2 места × ~3 строки = 6 строк. Это **фоллоу-ап R3** для двух пропущенных веток.

### F2. Race между `setFailed` (audio-orch) и `failStage` (orchestrator) в `/gpu/task/error`

`backend/src/routes/generation-routes.cjs:1168-1185`:

```js
if (parsed.kind === 'audio_chunk') {
    try {
        const audioOrch = require('../services/audio-orchestrator');
        await audioOrch.setFailed(redis, bookId, chapterId, sceneId,
            `chunk_error:${parsed.chunkIndex}:${reason || 'unknown'}`);
    } catch (orchErr) { ... }
}

const result = await orchestrator.failStage(
    redis, bookId, chapterId, sceneId, stage, build_id, reason || 'worker_error',
    { dispatchId: dispatch_id }
);
```

`audioOrch.setFailed` (raw) сам **не** синхронизирует asset.audio — это просто
`transitionState(redis, ..., PHASES.FAILED)` в `audio-orchestrator.js:158`. Между этим вызовом и
последующим `failStage` есть окно (< 1 redis round-trip), где `audio-orch.phase == FAILED`,
а `asset.audio == GENERATING` — инвариант `audio-orch.FAILED ⇒ asset ∈ {FAILED, PENDING}` нарушен.

**Практический риск:**
- `reconcileCycle.checkStalledAudioScenes` фильтрует не-WAITING_CHUNKS → безопасно.
- Scheduler попытается re-dispatch только если lease протух — но lease живёт 15 мин для audio,
  `failStage` ниже освобождает его через `finalizeDispatch('failure')`. Корректно.
- Ок短短, но в journal пишется только `failStage`'ов `AUDIO_FAILED` с `reason='worker_error'`,
  а `chunk_error:5:network_timeout` из raw `setFailed` теряется.

**Рекомендация** (простая): убрать raw `audioOrch.setFailed` полностью — `orchestrator.failStage`
уже переводит audio-orch в FAILED сам (через `failWaitingScene` если WAITING_CHUNKS, или через
синхронизацию в `failStage` для общего случая). Проверить, что `failStage` действительно покрывает
audio-orch FAILED для(audio_chunk)** stage=audio; если нет — добавить одну строку `audioOrch.setFailed` 
внутрь `orchestrator.failStage` после `unsafeRestoreAssetState`.

Объём: ~5 строк чистки. Снижает число «двух точек правды» на error path.

### F3. Lazy-require внутри `setScene*` остаётся (cosmetic)

После `fa6c039` каждая из 4 `setScene*` функций делает по 3 `require()` inside тела:

```js
async function setScenePending(...) {
    const state = require('../state');
    const journal = require('./event-journal');
    const { log, warn } = require('./scene-utils');
    // ...
}
```

В предыдущем документе это было **R4 (low)**, аудит 27-07 (W2) подтвердил «оставить как есть,
не refactor». Поддерживаю — `state/journal/scene-utils` безопасно вынести на top-level, но
это чисто cosmetic, поведение не меняется. **Действие:** никакого, не стоит отдельного коммита.

### F4. Поле `workers` в JSON `/progress-panel` vs термин `TaskRow` — закрепить в контракте

`docs/05-frontend/TASK_ARCHITECTURE.md:200` явно фиксирует нестыковку:

> Поле `workers` в JSON ответе осталось для обратной совместимости. На фронтенде объекты
> называются `ProgressWorker` в API-моделях, но отображаются как `TaskRow`.

Риск: при следующем рефакторинге `progress-panel.cjs` кто-то назовёт переменную `workers` в
backend, думая, что это термин; на фронтенде будет `TaskRow` — двойное наименование закрепится.

**Рекомендация:** добавить в header `progress-panel.cjs` (рядом с module description) комментарий:
```js
// Contract: JSON field "workers" is legacy, retained for backward compatibility.
// In new code use `rows`/`taskRows`; rename the JSON field only in a coordinated
// frontend+backend release (see docs/05-frontend/TASK_ARCHITECTURE.md §6).
```
Объём — 4 строки. Backend change `workers → tasks` в JSON — НЕ делать, ломает установленные
версии приложения.

### F5. `gen-scope.migrateLegacyScopes` — починилось ✅

В процессе ревью подтвердилось, что `migrateLegacyScopes` вызывается на startup из
`backend.cjs:290` в `setImmediate`-блоке startup-recovery. F5 снято —宠爱 действенное.

---

## 4. Дополнительные наблюдения (не требуют действия)

### N1._transient inconsistency в `recoverAudioOrchStates`: `MERGING → FAILED` без явной записи

Строка 1416 `audioOrch.setFailed(..., 'restart_merge_missing')` → следующий if `markDirtyScene`.
Asset.audio из `GENERATING` (часть инварианта для MERGING) сразу в `DIRTY` (без `FAILED`).
`AssetTransitions[GENERATING] = [READY, FAILED, DIRTY]` — переход формально валиден, но в журнале
не пишется `AUDIO_FAILED`. Это часть F1 (см. выше).

### N2. `scene-orchestrator.js` — `audioOrch.setMerging + setDone` без проверки на наличие файла

В `scene-orchestrator.js:163-164` и `:174-175` fast-track к DONE:
```js
await audioOrch.setMerging(redis, ...);
await audioOrch.setDone(redis, ...);
```
Не проверяется, есть ли на диске merged `.mp3`. `completeStage` ниже через `handleAudioCompleted`
проверит `audio.isSceneAudioReady()` — если файла нет, вернёт `ok:false, retryable:true`, asset
останется GENERATING, completeStage не поставит READY. Корректно, но dispatchId вернётся с
` Geological Surveyed=false, completed=false` для `already_ready` — странно, ведь путь назывался
`already_ready`. **Не баг, но имена misleading.** Действия не требует.

### N3. Parallel generation: readdToActiveIndex=false path

В `orchestrator.js:612-619` добавлен путь `readdToActiveIndex: false` (сделано в `6daa5c1` для
selective generation/Navigator-flow, чтобы task registry сам управлял активацией). Если caller
забыл передать это в `options`, по умолчанию `true` — безопасно. Грепа всех callers с `false`
не делал, но docstring в `orchestrator.js:395-403` описывает контракт. OK.

---

## 5. Приоритет внедрения

| Phase | Задачи | Объём | Риск |
|-------|--------|-------|------|
| **A** | F1 (sync asset.audio в 2 ветках recoverAudioOrchStates) | ~6 строк | Низкий |
| **B** | F2 (убрать дублирующий raw `audioOrch.setFailed` в `/gpu/task/error`) | ~5 строк | Низкий (нужно проверить, что `failStage` покрывает audio-orch FAILED для(audio_chunk) stage=audio; если нет — добавить одну строку внутрь failStage) |
| **C** | F4 (comment в `progress-panel.cjs` о legacy `workers`) | ~4 строки | Greenwich |

Фоллоу-ап _не_ добавляет новых команд фасада, state-machine, очередей или сервисов.
Закрывает оставшиеся после R3 ветки рассинхрона audio-orch↔asset. Объём Phase A+B+C
суммарно — **15 строк**. Тестовое покрытие R6 уже есть (215 строк `orchestration-stabilization.test.js`),
новые тесты не требуются: достаточно добавить один `it()` на invariant после recovery-branch
FAILED (если пойдём путём F1).

---

## 6. Чего НЕ делать (консолидация)

- **Не переименовывать** JSON-поле `workers` в `/progress-panel` — ломает установленные версии.
- **Не объединять** audio-orch с orchestrator.js — отдельная фазовая машина осмысленна.
- **Не выносить** lazy-require в `setScene*` на top-level — cosmetic, без выгоды.
- **Не вводить** централизованный invariant-enforcement wrapper вокруг всех `audioOrch.*` —
  достаточно локальной синхронизации в 2 местах (F1).
- **Не мигрировать** reconciliation на 100% через facade (M5 progress: 1 из 18 мест закрыто R3) —
  это большое рефакторинговое усилие, текущей щель достаточно закрыть F1.

---

<!-- === Footer === -->
---
*Фоллоу-ап ревью коммитов 25–27 июля 2026. Все проверки — против HEAD `f5bcde0`.*
