# TODO: консолидация системы оркестрации

**Дата:** 2026-07-16
**Основание:** `docs/03-audit/ORCHESTRATION_CONSOLIDATION_AUDIT.md` (К1–К9, R1–R8)
**Порядок выполнения:** T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 (от дешёвых инвариантов к структурным переносам). Каждый этап самодостаточен — можно останавливаться после любого.

Обозначения оценки: **S** — до полудня, **M** — 1–2 дня, **L** — 3+ дней.

---

## T1. Реестр таймаутов в runtime-config (R6, закрывает К9) — S

**Цель:** все временные константы в одном месте, с явными инвариантами между ними.

`config/runtime-config.js` уже централизует ключи Redis, QUOTAS, STUCK_THRESHOLDS и heartbeat — но retry/merge/cleanup-таймауты живут в коде.

- [ ] Добавить в `config/runtime-config.js` секцию `TIMEOUTS`:
  - [ ] `AUDIO_MERGE_RETRY_DELAY_MS = 15_000` (сейчас литерал в `task-handler.cjs:342`)
  - [ ] `AUDIO_MERGE_RETRY_MAX = 5` (сейчас `MAX_RETRIES` в `task-handler.cjs:281`)
  - [ ] `AUDIO_MERGE_RETRY_DEDUP_TTL_S = 30` (`task-handler.cjs:339`)
  - [ ] `AUDIO_MERGE_RETRY_COUNTER_TTL_S = 180` (`task-handler.cjs:341`)
  - [ ] `CLEANUP_INTERVAL_MS = 60_000` (`cleanup-service.cjs:172`)
  - [ ] `LEASE_TTL` — если TTL 15/20/30 мин зашиты в `dispatch-engine.js`, вынести сюда (typedef `LeaseConfig` в конфиге уже есть — проверить, используется ли)
- [ ] Заменить литералы в `task-handler.cjs` и `cleanup-service.cjs` на импорт из конфига.
- [ ] Рядом с секцией `TIMEOUTS` — комментарий с инвариантами:
  - `AUDIO_MERGE_RETRY_MAX * AUDIO_MERGE_RETRY_DELAY_MS < LEASE_TTL.AUDIO`
  - `GPU_TIMEOUT (gpu-hub, 10 мин) < min(LEASE_TTL.*)` — сейчас нарушен для audio? проверить фактические TTL
  - `AUDIO_MERGE_RETRY_COUNTER_TTL_S > AUDIO_MERGE_RETRY_MAX * AUDIO_MERGE_RETRY_DELAY_MS / 1000`
- [ ] (Опционально) unit-тест, который assert'ит инварианты на самих значениях конфига — дешёвая страховка от будущих правок.
- [ ] `gpu-hub/gpu-hub.js:13` (`GPU_TIMEOUT`) — вынести в env-переменную, задокументировать связь с lease TTL в комментарии (gpu-hub не импортирует backend-конфиг, но должен ссылаться на инвариант).

**Готово, когда:** grep по `setTimeout(`/`setInterval(`/`'EX', <литерал>` в `services/` не находит магических чисел, относящихся к оркестрации.

---

## T2. Схема job и единый dedup (R5, закрывает К6) — S–M

**Цель:** контракт backend ↔ gpu-hub ↔ worker вместо строковой конвенции `job_id`.

- [ ] Создать `backend/src/runtime/job-schema.js`:
  - [ ] `buildJobId({bookId, chapterId, sceneId, chunkIndex?, iuId?, type})` — единственное место сборки
  - [ ] `parseJobId(jobId)` — единственное место разбора; сейчас парсинг дублируется в `worker/worker/worker.js`, `gpu-hub/gpu-hub.js` и `services/task-handler.cjs`
  - [ ] `PROTOCOL_VERSION = 1` — добавить в payload `POST /gpu/task` (`runtime/gpu-dispatcher.js:15-57`); gpu-hub и worker логируют предупреждение при несовпадении
- [ ] Перевести на `job-schema.js`: `gpu-dispatcher.js`, `task-handler.cjs`, генераторы job_id в `workflows/audio|image|video`.
- [ ] Worker и gpu-hub — отдельные процессы без общего пакета: скопировать `parseJobId` с комментарием-якорем `SYNC: backend/src/runtime/job-schema.js` в обе стороны (или вынести в общий файл, если появится shared-пакет).
- [ ] Dedup оставить один авторитетный — backend `animastor:result-processed:{job_id}:{build_id}` (`routes/generation-routes.cjs:1045-1050`):
  - [ ] gpu-hub dedup `animastor:job:{job_id}` (`gpu-hub.js:151-157`) пометить как best-effort защиту очереди от двойного enqueue — задокументировать в комментарии, что он НЕ гарантия и не должен блокировать retry
  - [ ] Проверить сценарий из аудита: «gpu-hub dedup прошёл, backend dedup упал» — убедиться, что release-on-error (`generation-routes.cjs:1056-1061`) действительно перекрывает все ветки ошибок (включая throw до установки ключа)

**Готово, когда:** формат job_id меняется правкой одного файла + двух SYNC-копий; тест на roundtrip `parseJobId(buildJobId(x)) === x` для всех типов.

---

## T3. Команда `failStage` + канал ошибок worker → orchestrator (R1, закрывает К2) — M

**Цель:** сбой генерации становится событием оркестратора за секунды, а не истёкшим TTL через 15–30 минут.

### 3.1 Фасад

- [ ] `orchestration/orchestrator.js`: добавить команду `failStage(scene, stage, buildId, reason)`:
  - [ ] version-gate как в `completeStage` (устаревший buildId → игнор, событие `DUPLICATE_CALLBACK`)
  - [ ] `setAssetState(stage → FAILED)` + автоматический `syncLinearState` (как у остальных команд)
  - [ ] release lease + quota через существующий идемпотентный `dispatch-engine.markDispatchCompleted` (`dispatch-engine.js:573`) — не изобретать второй механизм release
  - [ ] событие `AUDIO_FAILED|IMAGE_FAILED|VIDEO_FAILED` в event-journal с `reason`
  - [ ] retry-решение НЕ здесь: FAILED-сцену подбирает планировщик/reconcile по существующей политике `RetryConfig` — `failStage` только фиксирует факт
- [ ] Тесты: идемпотентность (двойной вызов = один release), version-gate, переход GENERATING→FAILED валиден, READY→FAILED отклоняется.

### 3.2 Транспорт ошибки

- [ ] Backend: endpoint `POST /gpu/task/error` (рядом с `/gpu/task/result` в `routes/generation-routes.cjs:1039+`):
  - [ ] payload `{job_id, build_id?, reason?}`; парсинг через `job-schema.js` из T2
  - [ ] dedup по `(job_id, build_id)` — тот же паттерн, что у result
  - [ ] вызывает `orchestrator.failStage(...)`; для audio-чанков — прокидывает в audio-orchestrator (до T7 — минимально: перевод фазы в FAILED через существующий `transitionState`)
- [ ] gpu-hub `POST /task/error` (`gpu-hub.js:337-367`): после очистки `running`/heartbeat — форвард в backend `POST /gpu/task/error` с retry (тот же паттерн 5×500 мс, что у result-relay `gpu-hub.js:303-330`); при неудаче — фолбэк-ключ `animastor:error:{job_id}` с TTL 1h (симметрично `animastor:result:*`).

### 3.3 Согласование requeue

Сейчас два несогласованных retry-контура: gpu-hub сам ре-квьюит по `GPU_TIMEOUT` 10 мин, backend ждёт lease TTL.

- [ ] Решение (принято в аудите): gpu-hub становится тупым транспортом — **убрать авто-requeue** из watchdog'а (`gpu-hub.js:33-104`); вместо этого по таймауту воркера gpu-hub шлёт тот же `POST /gpu/task/error` с `reason: 'worker_timeout'`.
- [ ] Backend по `failStage` освобождает lease → планировщик на следующем тике сам передиспатчит (существующий механизм retry/backoff).
- [ ] Проверить: не сломается ли сценарий «воркер жив, но задача длиннее 10 мин» — heartbeat-refresh во время длинных задач (`gpu-hub.js:28-60`) должен предотвращать ложный timeout; добавить тест/лог.

**Готово, когда:** kill воркера посреди job → сцена в FAILED и передиспатчена в течение одного GPU_TIMEOUT + одного тика планировщика, без ожидания lease TTL. Smoke-тест обязателен.

---

## T4. Команда `resetScene` в фасаде (R3, закрывает К3, частично К8) — M

**Цель:** регенерация = одна команда оркестратора; route не знает про низкоуровневые ключи.

- [ ] `orchestration/orchestrator.js`: команда `resetScenes(bookId, scenes[], {layers, force})`, внутри — весь ритуал из `routes/book/generation-routes.cjs:254-498`:
  - [ ] очистка `animastor:iu-progress:*` и SCAN+DEL `animastor:iu-in-flight:*` (строки 468–482)
  - [ ] снятие сцен из scheduler/active-index и dispatch-engine (строки 434–438)
  - [ ] очистка очередей gpu-hub — **не прямым доступом к ключам** `animastor:job:*`/`animastor:queue:*`, а через новый HTTP endpoint gpu-hub `POST /queue/clear {bookId, scenes?}` (логика из `clearGpuHubQueues`, `generation-routes.cjs:34-100`, переезжает в gpu-hub — владелец ключей чистит их сам)
  - [ ] снятие активных lease через dispatch-engine
  - [ ] `markDirty(...)` последним шагом
  - [ ] событие `RECOVERY_STARTED`/`SCENE_RESET` в journal
- [ ] `force`-режим: запись `animastor:force-dispatch:{bookId}` (сейчас route, строка 286) — внутрь `resetScenes`; TTL 120 s вынести в `TIMEOUTS` (T1).
- [ ] `gen-scope` (`services/gen-scope.js`): scope передаётся параметром в `resetScenes`, который сам вызывает `genScope.setScope()` — route больше не трогает его напрямую. (Полная интеграция scope в `planScene` — вне рамок, зафиксировать как follow-up.)
- [ ] Route `/regenerate` сокращается до: валидация запроса → `orchestrator.resetScenes(...)` → ответ.
- [ ] Проверить второй вызов `clearGpuHubQueues` на строке 241 (другой route?) — перевести на тот же механизм.
- [ ] Тесты: повторный `resetScenes` идемпотентен; reset во время активной генерации не оставляет висячих lease/quota; smoke-тест force-regen из `ORCHESTRATOR_FACADE_PR.md` (№4) проходит.

**Готово, когда:** grep по `iu-in-flight|iu-progress|force-dispatch|animastor:queue|animastor:job` в `routes/` пуст.

---

## T5. Инвалидация статусов только через фасад (R8, закрывает К5) — S

**Цель:** одна правда о статусе ассета; PG-записи — side-effect команд фасада (по образцу Н.5).

- [ ] `services/scene-asset-registry.js:156-173` (`invalidateSceneAssets`): вместо прямого `markStale()` → вызов `orchestrator.markDirtyScene(scene, layers, reason)`; PG-запись `status='stale'` перенести внутрь `markDirtyScene` как side-effect (симметрично тому, как `completeStage` пишет `status='ready'`).
- [ ] `services/placeholder-audio.js:444-456` (`markPlaceholderStale`): аналогично — через фасад.
- [ ] `services/placeholder-audio.js:172-273` (`ensurePlaceholderAudio`): регистрация placeholder в PG должна сопровождаться `orchestrator.setScenePlaceholder(...)` (команда уже существует) — проверить все точки вызова, что Redis- и PG-статусы ставятся парой в одном месте.
- [ ] Найти остальных прямых писателей PG-статуса: `grep -rn "status.*=.*'stale'\|upsertAsset\|markStale" backend/src --include='*.js' --include='*.cjs'` — каждый вызов либо внутри фасада, либо получает комментарий-обоснование.
- [ ] `task-handler.cjs:331,382` — прямые `state.setAssetState(PENDING)` после исчерпания ретраев: заменить на команду фасада (после T3 это `failStage`, либо `setScenePending` — выбрать по семантике: исчерпаны ретраи мержа = FAILED, а не PENDING).
- [ ] Тест: после `markDirtyScene` Redis asset-state = DIRTY **и** PG `scene_assets.status = 'stale'` — одно утверждение, один вызов.

**Готово, когда:** таблица «кто пишет статус» в `STATE_WRITERS_MAP.md` обновлена и в ней один писатель — фасад (обновить документ).

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
