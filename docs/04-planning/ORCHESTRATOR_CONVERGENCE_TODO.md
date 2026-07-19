# Orchestrator Convergence TODO

> **Цель:** Втянуть audio-orch в единый фасад `orchestrator.js`, синхронизировать
> обе state machine, устранить рассинхронизацию (DONE guard, stale recovery).
>
> **Статус:** 🔴 не начато / 🟡 в работе / 🟢 готово / ✅ протестировано

---

## Фаза 1: DONE guard в фасаде (сейчас 🔴→🟢)

**Задача:** `orchestrator.setSceneGenerating()` проверяет audio-orch DONE и не позволяет
поставить GENERATING для готовой сцены.

**Файлы:**
- `backend/src/orchestration/orchestrator.js` — `setSceneGenerating()`
- `backend/src/orchestration/scene-orchestrator.js` — DONE guard в `executeAudioDispatch()` (сделано)

| Шаг | Описание | Статус |
|-----|----------|--------|
| 1.1 | Добавить DONE guard в `executeAudioDispatch()` перед `setSceneGenerating` | 🟢 |
| 1.2 | Добавить safety net в stale-phase recovery (не чистить DONE) | 🟢 |
| 1.3 | Перенести guard из `scene-orchestrator.js` в `orchestrator.setSceneGenerating()` | 🔴 |
| 1.4 | Тест: setSceneGenerating при DONE → skipped, state не меняется | 🔴 |

---

## Фаза 2: completeStage синхронизирует audio-orch (🔴)

**Задача:** `orchestrator.completeStage('audio')` ставит DONE синхронно с asset READY.

**Файлы:**
- `backend/src/orchestration/orchestrator.js` — `completeStage()`
- `backend/src/services/audio-orchestrator.js` — `setDone()`

| Шаг | Описание | Статус |
|-----|----------|--------|
| 2.1 | В `completeStage` → handlerOk → shouldWriteReady → READY: также `audioOrch.setDone()` | 🔴 |
| 2.2 | В `completeStage` → version gate stale → DIRTY: `audioOrch.deleteState()` (сброс для re-dispatch) | 🔴 |
| 2.3 | Убрать прямой `setDone()` из `audioOrch.completeChunk()` — делегировать фасаду | 🔴 |
| 2.4 | Тест: completeStage → READY + DONE синхронно | 🔴 |
| 2.5 | Тест: completeStage → stale → DIRTY + аудио-орх сброшен | 🔴 |

---

## Фаза 3: failStage синхронизирует audio-orch (🔴)

**Задача:** `orchestrator.failStage('audio')` ставит FAILED в audio-orch синхронно с asset FAILED.

**Файлы:**
- `backend/src/orchestration/orchestrator.js` — `failStage()`
- `backend/src/services/audio-orchestrator.js` — `setFailed()`

| Шаг | Описание | Статус |
|-----|----------|--------|
| 3.1 | В `failStage` → после asset FAILED: `audioOrch.setFailed()` | 🔴 |
| 3.2 | Убрать прямой `setFailed()` из `audioOrch.failWaitingScene()` — делегировать фасаду | 🔴 |
| 3.3 | Тест: failStage → FAILED + audio-orch FAILED | 🔴 |

---

## Фаза 4: markDirtyScene чистит audio-orch (🔴)

**Задача:** При пометке сцены как DIRTY audio-orch state сбрасывается (чтобы не блокировать
re-dispatch).

**Файлы:**
- `backend/src/orchestration/orchestrator.js` — `markDirtyScene()`

| Шаг | Описание | Статус |
|-----|----------|--------|
| 4.1 | В `markDirtyScene` → если `audio` в assets: `audioOrch.getState()` → DONE? `deleteState()` | 🔴 |
| 4.2 | Тест: markDirtyScene → DIRTY + audio-orch удалён | 🔴 |
| 4.3 | Тест: markDirtyScene без audio → audio-orch не тронут | 🔴 |

---

## Фаза 5: setScenePending чистит audio-orch (🔴)

**Задача:** При PENDING audio-orch сбрасывается только если он в DONE (другие фазы
сохраняются — re-dispatch через FAILED → GENERATING).

**Файлы:**
- `backend/src/orchestration/orchestrator.js` — `setScenePending()`

| Шаг | Описание | Статус |
|-----|----------|--------|
| 5.1 | В `setScenePending` → если audio и DONE: `audioOrch.deleteState()` | 🔴 |
| 5.2 | Тест: setScenePending(audio) при DONE → audio-orch удалён | 🔴 |
| 5.3 | Тест: setScenePending(audio) при WAITING_CHUNKS → audio-orch не тронут | 🔴 |

---

## Фаза 6: setSceneAllReady ставит DONE (🔴)

**Задача:** При cache hit все три asset → READY, audio-orch → DONE.

**Файлы:**
- `backend/src/orchestration/orchestrator.js` — `setSceneAllReady()`

| Шаг | Описание | Статус |
|-----|----------|--------|
| 6.1 | В `setSceneAllReady` → если audio в assets: `audioOrch.initPlaceholderReady()` + `setDone()` | 🔴 |
| 6.2 | Тест: setSceneAllReady → audio-orch DONE | 🔴 |

---

## Фаза 7: Reconciliation — enforce audio-orch invariants (🟡→🔴)

**Задача:** `reconcileCycle` проверяет и исправляет рассинхронизацию asset ↔ audio-orch.

**Файлы:**
- `backend/src/runtime/reconciliation-engine.js` — `checkStalledAudioScenes()`, `checkAudioOrchInvariants()`

| Шаг | Описание | Статус |
|-----|----------|--------|
| 7.1 | `checkStalledAudioScenes`: usar `last_chunk_at \|\| started_at` | 🟢 |
| 7.2 | Phase B2: если чанки на диске без last_chunk_at → доиграть merge | 🟢 |
| 7.3 | `checkAudioOrchInvariants` → auto-fix: DONE + не-READY → reset | 🔴 |
| 7.4 | `checkAudioOrchInvariants` → auto-fix: WAITING_CHUNKS + READY → done | 🔴 |
| 7.5 | Тест: инварианты проверяются и auto-fix работают | 🔴 |

---

## Фаза 8: Убрать прямые вызовы audio-orch из task-handler (🔴)

**Задача:** `task-handler.cjs` вызывает `audioOrch.completeChunk()` напрямую.
Фасад должен предоставить обёртку.

**Файлы:**
- `backend/src/services/task-handler.cjs`
- `backend/src/orchestration/orchestrator.js`

| Шаг | Описание | Статус |
|-----|----------|--------|
| 8.1 | Добавить `orchestrator.processAudioChunk()` (save file + completeChunk) | 🔴 |
| 8.2 | Переписать `handleTaskResult(audio_chunk)` через фасад | 🔴 |
| 8.3 | Тест: интеграционный тест task-handler → фасад → audio-orch | 🔴 |

---

## Фаза 9: Убрать прямые вызовы audio-orch из reconciliation (🔴)

**Задача:** `reconciliation-engine.js` вызывает `audioOrch.*()` напрямую.
Фасад должен предоставить обёртки для recovery.

**Файлы:**
- `backend/src/runtime/reconciliation-engine.js`
- `backend/src/orchestration/orchestrator.js`

| Шаг | Описание | Статус |
|-----|----------|--------|
| 9.1 | Добавить `orchestrator.recoverAudioOrchScene()` (recovery логика) | 🔴 |
| 9.2 | Переписать Phase C1 через фасад | 🔴 |
| 9.3 | Переписать Phase B1/B2 через фасад | 🔴 |
| 9.4 | Тест: recovery через фасад | 🔴 |

---

## Фаза 10: Убрать прямые вызовы audio-orch из scene-orchestrator (🟡)

**Задача:** `scene-orchestrator.js` вызывает `audioOrch.*()` напрямую.
Всё через фасад.

**Файлы:**
- `backend/src/orchestration/scene-orchestrator.js`
- `backend/src/orchestration/orchestrator.js`

| Шаг | Описание | Статус |
|-----|----------|--------|
| 10.1 | `setSceneGenerating` уже через фасад после Фазы 1 | 🔴 |
| 10.2 | `setWaitingChunks` → фасад | 🔴 |
| 10.3 | Stale recovery (no_state, WAITING_CHUNKS) → фасад | 🟡 (частично) |
| 10.4 | already_ready fast-track → фасад | 🔴 |

---

## Фаза 11: Debug-логи (🟢→🔴)

**Задача:** Добавить логи во все точки входа для диагностики рассинхронизации.

**Файлы:**
- `backend/src/routes/generation-routes.cjs` — `/gpu/task/result`
- `backend/src/services/task-handler.cjs` — `handleTaskResult`
- `backend/src/services/audio-orchestrator.js` — `completeChunk()`, `transitionState()`

| Шаг | Описание | Статус |
|-----|----------|--------|
| 11.1 | `/gpu/task/result`: логировать каждый шаг (received, valid, dedup, handle) | 🟢 |
| 11.2 | `handleTaskResult`: логировать job_id, build_id, stage | 🔴 |
| 11.3 | `completeChunk`: логировать chunks_received, missingIndices | 🔴 |
| 11.4 | `transitionState`: логировать каждое изменение фазы | 🔴 |

---

## Итоговый план выполнения

```
Фаза 1  (DONE guard в фасаде)        — приоритет: HIGH   — 1 день
Фаза 2  (completeStage + audio-orch) — приоритет: HIGH   — 1 день
Фаза 3  (failStage + audio-orch)     — приоритет: HIGH   — 0.5 дня
Фаза 4  (markDirtyScene + audio-orch) — приоритет: HIGH  — 0.5 дня
Фаза 5  (setScenePending + audio-orch) — приоритет: MED  — 0.5 дня
Фаза 6  (setSceneAllReady + audio-orch) — приоритет: LOW — 0.5 дня
Фаза 7  (reconciliation invariants)  — приоритет: MED    — 1 день
Фаза 8  (task-handler через фасад)    — приоритет: MED    — 1 день
Фаза 9  (reconciliation через фасад)  — приоритет: LOW    — 1 день
Фаза 10 (scene-orchestrator через фасад) — приоритет: MED — 0.5 дня
Фаза 11 (debug-логи)                 — приоритет: LOW    — 0.5 дня
```

**Итого:** ~7 дней на полный рефакторинг с тестами.

Первые 3 фазы (HIGH) — 2.5 дня. После них рассинхронизация asset ↔ audio-orch
невозможна в штатных сценариях. Остальное — чистка и тесты.
