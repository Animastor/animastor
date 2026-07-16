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

## T6. Единый reconciliation-контур (R4, закрывает К4) — M

**Цель:** одно место восстановления вместо четырёх (`startup-recovery`, `audio-recovery`, `cleanup-service`, periodic-часть `reconciliation-engine`).

- [ ] Спроектировать единый цикл в `runtime/reconciliation-engine.js` (он уже «факты → команды фасаду», M5 Шаг 4 — использовать как основу):
  - фазы цикла: собрать факты (диск, PG, `animastor:result:*`, `animastor:error:*` из T3, audio-orch фазы, failsafe-локи) → сравнить с asset-state → выдать команды фасада (`markDirtyScene`, `failStage`, `completeStage`, снятие локов)
- [ ] Влить `services/audio-recovery.cjs`:
  - [ ] логика скана `animastor:result:*` → шаг цикла reconcile
  - [ ] устранить дубликат `recoverAudioResults()` (17–183) / `recoverAudioForScene()` (196–298) — одна функция с параметром scope
  - [ ] debug-endpoint (`backend.cjs:135`, `routes/debug-routes.cjs`) остаётся, но вызывает ручной прогон цикла с scope
- [ ] Влить `services/cleanup-service.cjs:120-174` (`cleanupExpiredAudioSceneLocks`): шаг цикла; `setInterval` в `cleanup-service.cjs:172` удалить — периодичность задаёт единый цикл (интервал в `TIMEOUTS` из T1).
- [ ] `services/startup-recovery.js`: `recoverAll` (вызов в `backend.cjs:234`) = первый прогон того же цикла с флагом `startup: true` (доп. шаги: audio-orch фазы 110–119, version staleness 240–318). Не дублировать логику — параметризовать.
- [ ] Каждый прогон пишет `RECOVERY_STARTED`/`RECOVERY_COMPLETED` в event-journal со сводкой (сколько фактов, сколько команд).
- [ ] Один лок на цикл (`CLEANUP_LOCK` уже есть в конфиге) — прогоны не пересекаются.
- [ ] Тесты: startup-прогон на пустом Redis + живом PG восстанавливает состояние без массовой регенерации (smoke №5 из `ORCHESTRATOR_FACADE_PR.md`); ручной прогон идемпотентен.

**Готово, когда:** `audio-recovery.cjs` и recovery-часть `cleanup-service.cjs` удалены; в `backend.cjs` один сервис восстановления.

---

## T7. Аудио-машина внутрь оркестра (R2, закрывает К1) — L

**Цель:** один владелец аудио-жизненного цикла. Делать после T3 (нужен `failStage`) и желательно после T6.

### 7.1 Перенос merge-оркестрации (основной шаг)

- [ ] Вынести из `services/task-handler.cjs:195-410` (`triggerAudioMerge`) в `services/audio-orchestrator.js`:
  - [ ] `completeChunk(scene, chunkIdx, buildId)` — приём чанка, проверка комплектности, решение о мерже
  - [ ] `completeMerge(scene, buildId)` — фактический мерж + переход `MERGING → DONE`
  - [ ] retry-политика (счётчики `animastor:audio-merge-retry:*`, задержки) — внутри audio-orchestrator, константы из `TIMEOUTS` (T1)
  - [ ] recovery позднего чанка `FAILED → WAITING_CHUNKS` (`task-handler.cjs:225-239`) — внутрь машины как легальный переход (он уже разрешён в `PHASES`-карте, строка 43)
- [ ] `task-handler.cjs` после переноса: только маршрутизация результата по типу → вызов `audioOrchestrator.completeChunk(...)` / `orchestrator.completeStage(...)`. Целевой размер файла — вдвое меньше.
- [ ] Итог машины публикуется **только** через фасад: `DONE` → `orchestrator.completeStage(audio)`, `FAILED` (ретраи исчерпаны) → `orchestrator.failStage(audio, reason)`. Убрать прямые `state.setAssetState` из аудио-путей (пересекается с T5).

### 7.2 Синхронизация двух машин

- [ ] Задокументировать (в `AUDIO_ORCHESTRATOR.md`) инвариант соответствия: `phase=DONE ⇔ asset.audio=READY`, `phase=FAILED ⇒ asset.audio=FAILED`, промежуточные фазы ⇒ `GENERATING`.
- [ ] Добавить проверку инварианта в reconcile-цикл (T6): расхождение фазы и asset-state → лог + автопочинка через фасад.
- [ ] (Максимум, отдельным решением) фазы как суб-состояние в asset-state HSET (поле `audio_phase` рядом с `audio`) — оценить после стабилизации 7.1, не тянуть в этот этап.

### 7.3 Файловые сигналы

- [ ] `audio/audio-generation.js:102-115` («удалить stale merged-файл, чтобы merge не вышел рано») — файловая синхронизация. После 7.1 решение «мержить или нет» принимает машина по фазе и комплектности чанков, не по наличию файла на диске (принцип Д.3: диск = факт). Убрать удаление-как-сигнал, заменить проверкой фазы.

**Готово, когда:** grep по `audio-orch|PHASES|transitionState` вне `audio-orchestrator.js` и reconcile-цикла пуст; тест «поздний чанк после FAILED» и существующий `tests/audio-orchestrator.test.js` проходят.

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
