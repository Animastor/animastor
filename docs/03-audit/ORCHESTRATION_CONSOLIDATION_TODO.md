# TODO: консолидация системы оркестрации

**Дата:** 2026-07-16
**Основание:** `docs/03-audit/ORCHESTRATION_CONSOLIDATION_AUDIT.md` (К1–К9, R1–R8)
**Порядок выполнения:** T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 (от дешёвых инвариантов к структурным переносам). Каждый этап самодостаточен — можно останавливаться после любого.

Обозначения оценки: **S** — до полудня, **M** — 1–2 дня, **L** — 3+ дней.

---

## ✅ T1. Реестр таймаутов в runtime-config (R6, закрывает К9) — S

**Статус: ВЫПОЛНЕНО**

- ✅ `config/runtime-config.js` — секция `TIMEOUTS` со значениями + `LEASE_TTL_S`
- ✅ Литералы заменены: `task-handler.cjs` импортирует `AUDIO_MERGE_RETRY_*`, `cleanup-service.cjs` использует `CLEANUP_INTERVAL_MS`
- ✅ Инварианты задокументированы рядом с секцией `TIMEOUTS`
- ✅ Unit-тест в `tests/runtime-timeouts.test.js`
- ✅ `gpu-hub/gpu-hub.js` — `GPU_TIMEOUT` в env с якорем инварианта

---

## ✅ T2. Схема job и единый dedup (R5, закрывает К6) — S–M

**Статус: ВЫПОЛНЕНО**

- ✅ `runtime/job-schema.js` — `buildJobId`, `parseJobId`, `splitJobId`, `PROTOCOL_VERSION = 1`
- ✅ `gpu-dispatcher.js` шлёт `protocol_version` в payload
- ✅ `task-handler.cjs` использует `jobSchema.parseJobId()` для разбора job_id
- ✅ `gpu-hub/gpu-hub.js` — SYNC-копия разбора + проверка protocol_version
- ✅ Dedup: gpu-hub dedup (`animastor:job:*`) помечен как best-effort
- ✅ Тесты: `tests/job-schema.test.js` (roundtrip для всех типов)

---

## ✅ T3. Команда `failStage` + канал ошибок worker → orchestrator (R1, закрывает К2) — M

**Статус: ВЫПОЛНЕНО**

### 3.1 Фасад

- ✅ `orchestration/orchestrator.js` — команда `failStage(redis, bookId, chapterId, sceneId, stage, buildId, reason, {redispatch})`
  - ✅ version-gate (игнор устаревших buildId, `DUPLICATE_CALLBACK`/`INVALID_STATE_CALLBACK`)
  - ✅ `setAssetState(FAILED)` + `FAILED → PENDING` (redispatch) + `syncLinearState`
  - ✅ release lease+quota через идемпотентный `markDispatchCompleted`
  - ✅ событие `AUDIO_FAILED|IMAGE_FAILED|VIDEO_FAILED` в journal
  - ✅ retry-решение НЕ в failStage (планировщик подбирает сам)

### 3.2 Транспорт ошибки

- ✅ `routes/generation-routes.cjs` — endpoint `POST /gpu/task/error`
  - ✅ парсинг через `job-schema.js`
  - ✅ dedup по `(job_id, build_id)` как у result
  - ✅ audio_chunk — дополнительно `audioOrch.setFailed`
- ✅ `gpu-hub/gpu-hub.js` — `notifyBackendError()` форвардит ошибку в backend с retry 5×500мс + фолбэк `animastor:error:{job_id}` TTL 1h
- ✅ `POST /task/error` чистит running, dedup, heartbeat → notifyBackendError

### 3.3 Согласование requeue

- ✅ Авто-requeue из watchdog'а убран — по таймауту воркера gpu-hub шлёт `POST /gpu/task/error` с `reason: 'worker_timeout'`
- ✅ Backend по `failStage` освобождает lease → планировщик передиспатчит
- ✅ Heartbeat-refresh во время длинных задач (каждые 10с) предотвращает ложный timeout
- ✅ Тесты: `tests/fail-stage.test.js` (идемпотентность, version-gate, переходы)

---

## ✅ T4. Команда `resetScenes` в фасаде (R3, закрывает К3, частично К8) — M

**Статус: ВЫПОЛНЕНО**

- ✅ `orchestration/orchestrator.js`: команда `resetScenes(redis, bookId, buildId, scenes, layerCfg, options)`
  - ✅ force-dispatch флаг (TTL из `TIMEOUTS.FORCE_DISPATCH_TTL_S`)
  - ✅ gen-scope (`genScope.setScope` внутри фасада)
  - ✅ событие `SCENE_RESET`/`SCENE_RESET_COMPLETED` в event-journal
  - ✅ удаление из active-index (`scheduler.removeScenesFromActiveIndex`)
  - ✅ снятие lease (`dispatchEngine.clearLeasesForScenes`)
  - ✅ очистка очередей gpu-hub через HTTP `DELETE /queue/clear?book_id=`
  - ✅ pre-delete stale PNG для указанных unit_id
  - ✅ очистка `iu-progress` + SCAN+DEL `iu-in-flight`
  - ✅ `markDirty` через bookDiff (с fallback на `markDirtyScene`)
  - ✅ добавление сцен обратно в active-index
- ✅ `/regenerate` роут сокращён: бизнес-логика (scope, diff, cover) остаётся, state management — через `resetScenes`
- ✅ `force-dispatch` и `gen-scope` убраны из route (единственный владелец — `resetScenes`)
- ✅ `cancel-generation`: переведён на HTTP-эндпоинт gpu-hub
- ✅ 574 тестов проходят

---

## ✅ T5. Инвалидация статусов только через фасад (R8, закрывает К5) — S

**Статус: ВЫПОЛНЕНО**

- ✅ `orchestration/orchestrator.js` — `markDirtyScene` теперь пишет PG `status='stale'` как side-effect (graceful failure при недоступности PG).
- ✅ `services/scene-asset-registry.js`: `invalidateSceneAssets` и `markAssetStale` переведены на вызов `orchestrator.markDirtyScene(redis, ...)` (сигнатура изменена: добавлен `redis`).
- ✅ `services/placeholder-audio.js`: `markPlaceholderStale` переведён на вызов `orchestrator.markDirtyScene(redis, ...)`.
- ✅ `services/task-handler.cjs`: ручной `state.setAssetState(PENDING)` + очистка lease заменён на `orchestrator.failStage()` (с сохранением `audioOrch.setFailed()` для отдельной phase-машины).
- ✅ Найдены все прямые писатели PG-статуса — переведены через фасад или задокументированы.
- ✅ `STATE_WRITERS_MAP.md` обновлён: PG статусы пишутся через `completeStage` (ready), `markDirtyScene` (stale), `failStage` (failed).
- ✅ `tests/mocks/redis-mock.js` — создан минимальный Redis mock для тестов фасада.
- ✅ 574 теста проходят.

---

## ✅ T6. Единый reconciliation-контур (R4, закрывает К4) — M

**Статус: ВЫПОЛНЕНО**

- ✅ `runtime/reconciliation-engine.js`: единый `reconcileCycle()` с 4 фазами (A–D):
  - **A**: result/error key recovery (из audio-recovery.cjs)
  - **B**: cleanup expired locks (из cleanup-service.cjs)
  - **C**: startup-specific (version staleness, audio-orch, chunk recovery, session resume)
  - **D**: full scene reconciliation с auto-fix
  - Распределённый `CLEANUP_LOCK` — прогоны не пересекаются
  - Журналирование `RECOVERY_STARTED`/`RECOVERY_COMPLETED` в event-journal
- ✅ `backend.cjs`: `startupRecovery.recoverAll()` → `reconcileCycle({startup: true})` с полным набором deps
- ✅ `startup-recovery.js`: `recoverAll()` делегирует в `reconcileCycle()` (обратная совместимость)
- ✅ `cleanup-service.cjs`: `startCleanupInterval` — no-op (очистка теперь в Phase B цикла)
- ✅ `audio-recovery.cjs` сохранён для debug-endpoint, core logic — в Phase A
- ✅ 574 теста проходят

---

## ✅ T7. Аудио-машина внутрь оркестра (R2, закрывает К1) — L

**Статус: ВЫПОЛНЕНО**

### 7.1 Перенос merge-оркестрации (основной шаг)

- ✅ `services/audio-orchestrator.js`: добавлены `completeChunk()` и `completeMerge()`:
  - `completeChunk` — приём чанка, проверка комплектности, решение о мерже, retry-логика (константы из `TIMEOUTS`)
  - recovery позднего чанка `FAILED → WAITING_CHUNKS` как легальный переход
  - `MERGING → DONE` → `orchestrator.completeStage(audio)`
  - `WAITING_CHUNKS → FAILED` (retry exhausted) → `orchestrator.failStage(audio)` + `audioOrch.setFailed()`
- ✅ `task-handler.cjs`: удалён мёртвый `triggerAudioMerge` — теперь только маршрутизация результата по типу → вызов `audioOrch.completeChunk(...)` / `orchestrator.completeStage(...)`
- ✅ `orchestration/orchestrator.js`: добавлена функция `setSceneGenerating()`
- ✅ `scene-orchestrator.js`: прямые `state.setAssetState(audio, PENDING/GENERATING)` заменены на `orchestrator.setScenePending()` / `orchestrator.setSceneGenerating()`

### 7.2 Синхронизация двух машин

- ✅ Инварианты задокументированы в `AUDIO_ORCHESTRATOR.md` (DONE⇔READY, FAILED⇒FAILED/PENDING, промежуточные⇒не READY)
- ✅ `runtime/reconciliation-engine.js`: функция `checkAudioOrchInvariants()` вызывается из `reconcileScene()`, проверяет расхождение фазы и asset-state

### 7.3 Файловые сигналы

- ✅ `scene-orchestrator.js`: удалён блок `delete placeholder merged audio before TTS` — `completeChunk` проверяет phase, а не файл на диске
- ✅ `audio/generation.js`: файловый сигнал `isSceneAudioReady` сохранён (для cache-hit detection), сигнал для `triggerAudioMerge` заменён на проверку фазы
- ✅ 574 теста проходят

---

## T8. Убрать linear state (R7 / Д.2, закрывает К7) — M, требует frontend

**Цель:** одна модель состояния — per-asset; плеер перестаёт зависеть от линейной проекции.

- [ ] Backend: API-эндпоинт(ы) состояния сцены отдают per-asset (`{audio, image, video}`) рядом с linear (совместимость, один релиз).
- [ ] Frontend (Android): перевести `PlaybackViewModel`/поллинг состояния на per-asset. **Внимание на `docs/DONT_DO.md`** — не трогать sliding window preload и stall/retry-логику плеера (запреты №1–3).
- [ ] После релиза фронта: удалить `deriveLinearState()` (`state/scene-state.js:343-386`, 18 ветвлений) и `syncLinearState` из всех команд фасада; удалить ключи `scene-state:*` (миграция: просто перестать писать, TTL/чистка).
- [ ] Обновить `ORCHESTRATOR_LIFECYCLE.md` и `SYSTEM_MAP.md`.

**Готово, когда:** grep по `deriveLinearState|syncLinearState|SCENE_STATE_KEY_PREFIX` находит только историю в docs.

---

## Вне рамок (зафиксировать, не делать сейчас)

- Интеграция `gen-scope` как параметра `planScene` (сейчас — боковой Redis-канал; после T4 хотя бы пишется через фасад).
- Перенос audio-orch фаз в asset-state HSET (T7.2 «максимум»).
- Д.4 — циркулярные зависимости (lazy-require в `scene-callbacks.js`) — чинится естественно по мере T3–T7, отдельно не трогать.
- Ротация `OPENROUTER_API_KEY` + PG password (S.1 из фасадного PR) — **не забыто? проверить, сделана ли** — это security-долг вне оркестрации, но висит с июня.

## Сквозные правила для всех этапов

1. Каждый этап — отдельная ветка/PR с прогоном полного тестового набора (400+ тестов) + smoke-тесты №1–5 из `ORCHESTRATOR_FACADE_PR.md`.
2. Новые команды фасада получают события в event-journal — это контракт наблюдаемости.
3. После каждого этапа обновлять: `STATE_WRITERS_MAP.md` (T5), `AUDIO_ORCHESTRATOR.md` (T7), `ORCHESTRATOR_LIFECYCLE.md` (T3, T4, T8), `CHANGELOG.md` (все).
4. Сверяться с `docs/DONT_DO.md` перед правками в плеере (T8) и graceful shutdown (T6: не звать `redis.quit()` без проверки активных операций — запрет №8).

## Карта соответствия

| TODO | Рекомендация аудита | Костыль | Оценка | Зависит от |
|---|---|---|---|---|
| T1 | R6 реестр таймаутов | К9 | S | — |
| T2 | R5 схема job + dedup | К6 | S–M | — |
| T3 | R1 failStage + канал ошибок | К2 | M | T2 (парсинг job) |
| T4 | R3 resetScene | К3, К8 | M | T1 (TTL) |
| T5 | R8 инвалидация через фасад | К5 | S | T3 (failStage для task-handler) |
| T6 | R4 единый reconcile | К4 | M | T3 (error-ключи), T5 |
| T7 | R2 аудио-машина в оркестр | К1 | L | T3, T6, T1 |
| T8 | R7 убрать linear state | К7 | M + frontend | независим, но делать последним |
