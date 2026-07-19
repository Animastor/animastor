# Аудит консолидации системы оркестрации

**Дата:** 2026-07-16
**Область:** `backend/src/orchestration`, `backend/src/runtime`, `backend/src/services`, `gpu-hub`, `worker`
**Контекст:** проведён после закрытия M5 (фасад оркестратора, все C1–C4 / M1–M5 закрыты, см. `docs/02-orchestration/ORCHESTRATOR_FACADE_PR.md`). Цель — зафиксировать, что **всё ещё выбивается** из единого оркестра, и наметить путь консолидации.

---

## 1. Резюме

Ядро оркестрации после M5 в хорошем состоянии: единый фасад из 11 команд (`orchestration/orchestrator.js`), атомарные per-asset состояния (HSET), version-gate перед READY, идемпотентные lease/quota. Но вокруг ядра сохранилось **три параллельных контура управления**, которые фасад не покрывает:

1. **Аудио-подсистема** живёт со своей собственной машиной фаз и собственной retry-логикой вне оркестратора.
2. **GPU-контур** (gpu-hub + worker) имеет собственный таймаут/ре-квью и **не доносит ошибки до backend** — backend узнаёт о сбое только по истечении lease TTL.
3. **Восстановление** размазано по трём несогласованным механизмам (startup-recovery, audio-recovery, cleanup-service).

Плюс ряд точечных обходов: route `/regenerate` вручную чистит Redis-ключи до вызова фасада, статус ассета существует в трёх независимых представлениях (Redis asset-state, PG `scene_assets.status`, audio-orch phase), магические таймауты разбросаны по коду.

Главный симптом фрагментации: **добавление нового типа генерации (например, музыки) потребует правок в 4–5 модулях**, а не расширения одного оркестратора.

---

## 2. Что уже консолидировано (не трогать, работает)

| Механизм | Где | Статус |
|---|---|---|
| Фасад из 11 команд (`markDirty`, `beginStage`, `completeStage`, `reconcile`, …) | `orchestration/orchestrator.js` | ✅ единственный арбитр per-asset переходов |
| Атомарный per-asset state (HSET, правила переходов) | `state/scene-state.js` | ✅ канонический источник в Redis |
| Version-gate перед READY (Д.3: диск = факт, не решение) | `orchestrator.js:88-125` | ✅ |
| Lease + quota + идемпотентный release (Д.1) | `runtime/dispatch-engine.js` | ✅ |
| Event journal (append-only, 7 дней TTL) | `orchestration/event-journal.js` | ✅ |
| Linear state как производная проекция (`deriveLinearState`) | `scene-state.js:343-386` | ✅, но см. К7 |

---

## 3. Костыли: что выбивается из оркестра

Ранжировано по влиянию на консолидацию.

### К1. Аудио-подсистема — параллельный оркестратор (критично)

Аудио управляется **второй машиной состояний**, не связанной с фасадом:

- `services/audio-orchestrator.js` — своя машина фаз `NEW → PLACEHOLDER_READY → GENERATING → WAITING_CHUNKS → MERGING → DONE/FAILED` в собственных Redis-ключах `animastor:audio-orch:*` (строки 26–44).
- `services/task-handler.cjs:195-410` (`triggerAudioMerge`) — **ад-хок оркестрация мержа** прямо в обработчике колбэка: сам читает фазу, сам решает про ретраи, сам управляет переходом в FAILED и обратным восстановлением `FAILED → WAITING_CHUNKS` при позднем чанке (строки 225–239).
- Встроенная retry-политика на магических числах: `MAX_RETRIES = 5` (строка 281), `setTimeout(…, 15000)` (строка 342), счётчик в Redis `animastor:audio-merge-retry:*:count` с TTL 180s, NX-лок на 30s.

**Почему это костыль:** фаза `DONE`/`FAILED` в audio-orch и `READY`/`FAILED` в asset-state — два независимых утверждения об одной сцене без механизма синхронизации. Логика переходов размазана между `audio-orchestrator.js` (владелец машины) и `task-handler.cjs` (фактический исполнитель переходов). Recovery для этой машины — отдельный третий модуль (`startup-recovery.recoverAudioOrchStates()`, строки 110–119).

### К2. Ошибки воркеров не доходят до backend (критично)

- Worker при сбое шлёт `POST /task/error` → **gpu-hub** (`worker/worker/worker.js:472-476`).
- gpu-hub лишь удаляет job из `animastor:running` и чистит heartbeat (`gpu-hub/gpu-hub.js:337-367`). **В backend ничего не уходит.**
- Backend узнаёт о сбое только когда истечёт dispatch-lease (15–30 минут в зависимости от stage).
- Параллельно gpu-hub имеет **собственный** watchdog: по молчанию воркера 10 минут (`GPU_TIMEOUT`, `gpu-hub.js:13, 33-104`) он сам ре-квьюит job — при этом lease backend'а всё ещё считает job закреплённым за прежним диспатчем.

**Почему это костыль:** два несогласованных retry-контура (gpu-hub requeue vs backend lease-expiry) + отсутствие в фасаде команды `failStage` — оркестратор в принципе не умеет принять событие «генерация упала», только «истёк таймаут».

### К3. `/regenerate` вручную чистит состояние до вызова фасада

`routes/book/generation-routes.cjs:254-498`:

- строка 286 — пишет флаг `animastor:force-dispatch:{bookId}` напрямую;
- строка 289 — `genScope.setScope()` (боковой канал контекста, см. К8);
- строки 434–444 — напрямую дёргает scheduler/dispatch-engine и `clearGpuHubQueues()` (чистит `animastor:job:*`, `animastor:queue:*` — ключи чужого сервиса);
- строки 468–482 — вручную удаляет `animastor:iu-progress:*` и SCAN+DEL `animastor:iu-in-flight:*`;
- и только затем (строка 485) вызывает `orchestrator.markDirty()`.

**Почему это костыль:** «отменить/сбросить сцену» — это жизненный цикл, но в фасаде нет команды `resetScene`/`cancelScene`, поэтому route собирает её вручную из низкоуровневых операций. Любой новый вызов регенерации (агент, debug-route) должен будет повторить этот ритуал, и забытый шаг = баг.

### К4. Три несогласованных механизма восстановления

| Механизм | Триггер | Что делает | Файл |
|---|---|---|---|
| `startup-recovery` | один раз на старте | чинит audio-orch фазы, version staleness (через фасад ✅), логирует потерянные Redis-счётчики | `services/startup-recovery.js` |
| `audio-recovery` | **по требованию** через debug-endpoint (`backend.cjs:135`) | сканирует `animastor:result:*`, доигрывает потерянные результаты через `taskHandler.handleTaskResult()` | `services/audio-recovery.cjs` |
| `cleanup-service` | `setInterval(…, 60000)` (`cleanup-service.cjs:172`) | снимает протухшие `animastor:audio-scene-failsafe:*` локи | `services/cleanup-service.cjs:120-174` |

Каждый видит только свой срез состояния, между собой они не координируются, и только один из трёх ходит через `orchestrator.reconcile`. При этом в `runtime/` уже есть `reconciliation-engine` — четвёртый участник той же задачи.

`audio-recovery.cjs` вдобавок содержит дублированный код: `recoverAudioResults()` (строки 17–183) и `recoverAudioForScene()` (196–298) — одна и та же логика дважды.

### К5. Три независимых представления статуса ассета

1. Redis asset-state (канон по документации) — пишет фасад.
2. PG `scene_assets.status` — пишет `services/scene-asset-registry.js` (`registerSceneAudio/Image`, `invalidateSceneAssets:156-173` ставит `stale` **мимо оркестратора**).
3. Audio-orch phase (К1).

Отдельно `services/placeholder-audio.js` (172–273, 444–456) регистрирует/инвалидирует placeholder-статус в PG самостоятельно; в Redis для этого есть `AssetState.PLACEHOLDER`. Соответствие двух записей никем не гарантируется — H.5 закрыл запись PG в hot-path `completeStage`, но обратные пути (инвалидация, placeholder) остались вне фасада.

### К6. Дублированный dedup и неформальный контракт job

- gpu-hub dedup: `animastor:job:{job_id}` SET NX, 1h TTL (`gpu-hub.js:151-157`).
- backend dedup: `animastor:result-processed:{job_id}:{build_id}` SET NX, 1h TTL (`routes/generation-routes.cjs:1045-1050`), с намеренным release-on-error.
- `job_id` — строковый формат (`{bookId}_{chapterId}_{sceneId}_{chunkIndex}:audio` и вариации для image/iu/video), парсится минимум в трёх местах (worker, gpu-hub, task-handler) без общей схемы и без версии протокола.

### К7. Linear state всё ещё жив (Д.2, известный долг)

`deriveLinearState()` — 18 ветвлений, синхронизируется при каждой записи asset-state, нужен только Android-плееру. Пока плеер не переведён на per-asset, каждый новый asset-статус придётся вплетать в проекцию.

### К8. Боковые каналы контекста: `gen-scope` и `force-dispatch`

`services/gen-scope.js` — route пишет scope в `animastor:gen-scope:{bookId}`, планировщик читает напрямую. Флаг `animastor:force-dispatch:{bookId}` (TTL 120s!) — аналогично. Это входные параметры планирования, живущие вне контракта `planScene`; их существование не видно ни в фасаде, ни в event journal.

### К9. Магические таймауты без единого конфига

| Значение | Где | Что означает |
|---|---|---|
| 15 s | `task-handler.cjs:342` | пауза перед retry мержа |
| 30 s | `task-handler.cjs:339` | NX-дедуп планирования retry |
| 180 s | `task-handler.cjs:341` | TTL счётчика ретраев |
| 60 s | `cleanup-service.cjs:172` | период чистки failsafe-локов |
| 10 min | `gpu-hub.js:13` | GPU_TIMEOUT → requeue |
| 15/20/30 min | dispatch-engine (per stage) | lease TTL |
| 30 s / 15 s | `gpu-hub.js:28-60` | heartbeat TTL + принудительный рефреш во время длинных задач (сам по себе задокументированный воркараунд) |

Ни одно значение не связано с другим, хотя они образуют цепочку (retry-мержа должен уложиться в lease; requeue gpu-hub должен быть согласован с lease TTL — сейчас 10 мин против 15–30 мин, окно рассинхрона).

---

## 4. Рекомендации по консолидации

Приоритет = влияние на «один оркестр» / стоимость.

### R1. Ввести команду `failStage` и канал ошибок worker → orchestrator (К2)

- gpu-hub `/task/error` форвардит в backend (новый endpoint `/gpu/task/error`), backend вызывает `orchestrator.failStage(scene, stage, buildId, reason)`.
- `failStage` делает: asset-state → FAILED, release lease/quota (через существующий идемпотентный `markDispatchCompleted`), событие `*_FAILED` в journal.
- Requeue-политику оставить в одном месте: либо gpu-hub перестаёт ре-квьюить сам и backend решает retry через планировщик, либо gpu-hub ре-квьюит, но **уведомляет** backend (событие в journal). Первый вариант чище: gpu-hub становится тупым транспортом.

### R2. Втянуть аудио-машину в оркестр (К1)

- `triggerAudioMerge` из `task-handler.cjs` перенести внутрь `audio-orchestrator.js` как команду `completeChunk(scene, chunkIdx)` / `completeMerge(scene)` — вся retry-политика и переходы фаз в одном владельце.
- Retry-параметры (5 попыток, 15 s, 180 s) — в `config/runtime-config.js`.
- Долгосрочно: фазы audio-orch — это суб-состояния `GENERATING` этапа audio. Свести к одному источнику: либо машина фаз публикует свой итог только через `orchestrator.completeStage`/`failStage` (минимум), либо фазы становятся полем внутри asset-state HSET (максимум).

### R3. Команда `resetScene` в фасаде (К3)

Собрать ритуал из `/regenerate` в одну команду оркестратора: очистка iu-progress/iu-in-flight, gpu-hub queues (через API gpu-hub, а не прямой доступ к его ключам), снятие lease, `markDirty`. Route оставляет себе только валидацию запроса и вызов `orchestrator.resetScene(scope)`.

### R4. Единый reconciliation-контур (К4)

Слить `startup-recovery`, `audio-recovery`, `cleanup-service` и periodic-часть `reconciliation-engine` в один сервис с одним циклом: «собрать факты (диск, PG, gpu-hub running, audio-orch) → выдать команды фасаду». Startup = первый прогон того же цикла, debug-endpoint = ручной прогон. Дубликат `recoverAudioForScene`/`recoverAudioResults` устранить попутно.

### R5. Формализовать контракт backend ↔ gpu-hub ↔ worker (К6)

- Один модуль-схема `job` (структурированные поля вместо парсинга строки `job_id`), версия протокола в payload.
- Один уровень dedup: если backend дедупит по `(job_id, build_id)` — dedup в gpu-hub можно понизить до best-effort или убрать.

### R6. Реестр таймаутов (К9)

Все значения из таблицы К9 — в `runtime-config.js` с инвариантами в комментариях (например `AUDIO_MERGE_RETRY_TOTAL < LEASE_TTL.audio`, `GPU_TIMEOUT < LEASE_TTL.*`). Дешёвая правка, сильно упрощает рассуждение о гонках.

### R7. Закрыть Д.2: перевести плеер на per-asset, удалить linear state (К7)

Уже задокументировано как follow-up фасадного PR. После этого `deriveLinearState` и `syncLinearState` удаляются (~50 ветвлений/вызовов).

### R8. Инвалидация статусов только через фасад (К5)

`scene-asset-registry.invalidateSceneAssets` и `placeholder-audio.markPlaceholderStale` должны вызывать `orchestrator.markDirtyScene` (как это уже сделали scene-restoration и reconciliation в M5 Шаг 3), а PG-запись сделать side-effect'ом фасада — по образцу Н.5.

### Сводка приоритетов

| # | Рекомендация | Закрывает | Эффект | Оценка |
|---|---|---|---|---|
| R1 | `failStage` + канал ошибок | К2 | сцены перестают висеть 15–30 мин после падения воркера | S–M |
| R2 | Аудио-машина внутрь оркестра | К1 | один владелец аудио-жизненного цикла | M–L |
| R3 | `resetScene` в фасаде | К3, К8 частично | регенерация — одна команда | S–M |
| R4 | Единый reconciliation | К4 | одно место восстановления | M |
| R5 | Схема job + один dedup | К6 | контракт вместо конвенции | S |
| R6 | Реестр таймаутов | К9 | согласованные TTL | S |
| R7 | Д.2: убрать linear state | К7 | −1 проекция состояния | M (требует frontend) |
| R8 | Инвалидация через фасад | К5 | одна правда о статусе | S |

**Рекомендуемый порядок:** R6 → R5 → R1 → R3 → R8 → R4 → R2 → R7 (от дешёвых инвариантов к структурным переносам; R2 делать после R1, т.к. `failStage` нужен аудио-машине).

---

## 5. Критерий «консолидировано»

Система оркестрации консолидирована, когда выполняются все пять инвариантов:

1. **Один арбитр:** любой переход состояния сцены/ассета (включая FAILED, stale, placeholder, reset) проходит через команду фасада.
2. **Один контур ошибок:** сбой на любом уровне (worker, gpu-hub, merge, callback) за секунды превращается в `failStage`, а не в истёкший TTL.
3. **Одно восстановление:** единый reconcile-цикл; startup и debug — его прогоны, а не отдельные реализации.
4. **Один контракт:** job — структурированная схема с версией; dedup — на одном уровне.
5. **Одна конфигурация времени:** все TTL/таймауты в `runtime-config.js` с явными инвариантами.

Практический тест: **добавление нового типа генерации** (музыка, эффекты) должно означать «новый stage в конфиге + workflow/connector + generator», без правок в task-handler, recovery-сервисах и routes.

---

## Связанные документы

- `docs/02-orchestration/ORCHESTRATOR_LIFECYCLE.md` — целевой дизайн жизненного цикла
- `docs/02-orchestration/ORCHESTRATOR_FACADE_PR.md` — что закрыто в M5
- `docs/02-orchestration/M5_COMPETING_WRITERS.md`, `STATE_WRITERS_MAP.md` — история конкурирующих писателей
- `docs/02-orchestration/AUDIO_ORCHESTRATOR.md` — машина фаз аудио
- `docs/03-audit/ARCHITECTURAL_DEBT.md` — Д.1–Д.5
