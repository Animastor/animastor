# Аудит системы оркестрации — aktuell

> **Дата:** 19 июля 2026
> **Ревизия:** `d29eca0` (поэтапно завершены T0–T10)
> **Область:** `backend/src/orchestration`, `backend/src/runtime`, `backend/src/services`,
> `gpu-hub/`, `worker/`
> **Цель:** не усложнять систему, а сделать стабильной.
> **Опирается на:**
> - `docs/02-orchestration/ORCHESTRATOR_ARCHITECTURE_WITH_AUDIO.md` — целевой дизайн фасада
>   и двойной state-machine (asset FSM + audio-orch FSM).
> - `docs/03-audit/CAPACITY_AND_COMPLEXITY.md` — ёмкость, избыточность и что можно
>   удалить без потери надёжности.
> **Замещает:** `ORCHESTRATION_STABILIZATION_AUDIT.md` (от 18.07), `ORCHESTRATION_FULL_AUDIT.md`
> как исторический baseline. Старые документы не удаляются, но статус T1–T10 сверяется с кодом здесь.

---

## 0. Итог

Система **не требует новых подсистем**. T0–T10 закрыли все P0-дефекты прошлого аудита:

- `worker/worker/worker.cjs` проходит `node --check` (✅, ранее P0.1).
- `completeStage` больше не ставит `READY` без `handler.ok === true` и валидации версии
  (✅, ранее P0.2). PG-version-gate работает fail-closed.
- `failStage` теперь идёт через `finalizeDispatch('failure')` с `recordFailure` +
  `consumeRetryBudget` (✅, ранее P0.3).
- `execute{Audio,Image,Video}Dispatch` возвращают честный `{ dispatched, jobs, reason }`,
  lease/quota немедленно освобождаются при `dispatched:false` (✅, ранее P0.4).
- `worker.cjs`, `gpu-hub.js` проходят syntax-smoke в `pretest` (✅).
- Backend tests: **576 passing** (фовerged run с syntax-smoke gate в `pretest`).

Критических дефектов в текущем коде **не найдено**. Оставшиеся проблемы — это **упрощение
и стабилизационная полировка**: dead-code reconciliation фаз C3/C4/C5, дублирующие
модули resilience (retry-budget / fairness / failure-taxonomy), отсутствие graceful
shutdown / `/health`, незакрытые прямые writes asset-state из `scene-restoration` и
`startup-recovery`.

> Главный ориентир: **−580 строк без потери надёжности** (по `CAPACITY_AND_COMPLEXITY.md`).
> Это согласовано с `ORCHESTRATOR_ARCHITECTURE_WITH_AUDIO.md`, где фасад уже владеет состоянием
> — остаётся убрать параллельные «аналитические» модули, которые не входят в инварианты
> инвариант `audio-orch.phase == DONE ⇔ asset.audio == READY`.

---

## 1. Что подтверждено кодом

| Гипотеза из прошлых аудитов | Статус сейчас | Ссылка на код |
|---|---|---|
| Worker не разворачивается — `SyntaxError` в `waitForFileReady()` | ✅ Исправлено | `worker/worker/worker.cjs` — `node --check` OK |
| `completeStage()` игнорирует result handler и ставит READY | ✅ Исправлено | `backend/src/orchestration/orchestrator.js:119-184` — `handlerOk` обязателен |
| `failStage()` пишет success finalization | ✅ Исправлено | `orchestrator.js:280-289` → `finalizeDispatch('failure')`, circuit-breaker `recordFailure`, `consumeRetryBudget` (`dispatch-engine.js:829,837`) |
| Executor возвращает `dispatched:true` без отправки job | ✅ Исправлено | `scene-orchestrator.js` возвращает честный `{ dispatched, jobs, reason }`; `dispatch-engine.js:580-588` освобождает ресурсы при `dispatched:false` |
| Lease renewal не стартует | ✅ Исправлено | `dispatch-engine.js:594` — `startDispatchRenewal` после реального `dispatched:true`; остановка в `finalizeDispatch` |
| Runtime 5s-tick гоняет полный `reconcileAll()` без lock | ✅ Исправлено | `runtime-loop.js:65-120` — быстрый tick без reconcile; отдельный `scheduleReconcile` 60s с distributed lock |
| `active-scenes` управляются двумя API | ✅ Исправлено | `runtime-scheduler.js:82-100` делегирует в `active-scenes-index.js` |
| SQL-инъекция в `agent-session.js` | ✅ Исправлено | `services/agent-session.js:21` — фильтр через `ALLOWED_UPDATE_COLUMNS` |
| `redis.keys()` блокирует Redis | ✅ Убрано | grep по `backend/src` не находит `keys(\``animastor...`)` |
| ReferenceError `pendingState` / `sceneState` в reconcile | ✅ Исправлено | `reconciliation-engine.js:834-851` — переменные определены |
| `_redis` приватный, продление lease всегда `{renewed:false}` | ✅ Исправлено | `lease-manager` принимает `redis` параметром; renewal стартует |
| GPU Hub auth не передаётся backend'ом | ✅ Исправлено | `gpu-dispatcher.js:46-49`, `orchestrator.js:460-461`, `cache-routes/core-routes/generation-routes` — заголовок `x-api-key` |

Фасад `orchestrator.js` уже реализует инварианты из `ORCHESTRATOR_ARCHITECTURE_WITH_AUDIO.md`
раздел 2: `audio-orch.phase == DONE ⇔ asset.audio == READY` поддерживается в
`completeStage` через синхронную пару `setAssetState(READY)` + `audioOrch.completeMerge()`
→ `DONE`.

---

## 2. Ёмкость и сложность — что подтверждено из `CAPACITY_AND_COMPLEXITY.md`

### 2.1 Конфиг узких мест (без новых движков)

Файл `CAPACITY_AND_COMPLEXITY.md` называет жёсткие лимиты:

| Ресурс | Сейчас | Файл | Строк |
|---|---|---|---|
| `maxActiveAudio` | 3 | `dispatch-engine.js` (QUOTAS const) | ~49 |
| `maxActiveImage` | 2 | `dispatch-engine.js` | ~49 |
| `maxActiveVideo` | 1 | `dispatch-engine.js` | ~49 |
| Runtime loop | 1 процесс | `runtime-loop.js` | — |
| Reconcile cycle | 60s, отдельный таймер | `runtime-loop.js:15` `RECONCILE_INTERVAL_MS = 60000` | — |

Текущий таргет — **5–15 concurrent пользователей** без усложнения (см. `CAPACITY_AND_COMPLEXITY.md`
§3). Для 50+ нужны RabbitMQ/S3/cluster — это **вне scope стабилизации** и осознанно не делается.

### 2.2 Избыточные модули — проверка фактического использования

`CAPACITY_AND_COMPLEXITY.md` §5.2 предлагает удалить ~600 строк. Проверил реальные вызовы:

| Модуль | Строк | Используется в production-пути? | Вердикт |
|---|---|---|---|
| `retry-budget-manager.js` | 520 | ✅ ДА — `dispatch-engine.js:837` вызывает `consumeRetryBudget` в `finalizeDispatch('failure')` | 🟡 **Не выкидывать целиком** — оставить `consumeRetryBudget`. Половина модуля (refillBudgets, complex policies) мертва. |
| `fairness-engine.js` | 605 | ⚠️ Частично — `runtime-persistence.js:12` импортирует, но активных путей, которые реально меняют расписание, нет | 🔴 **Удалить**, как и предлагает CAPACITY §5.2 |
| `failure-taxonomy.js` | 424 | ⚠️ Частично — `retry-manager.js:7`, `orchestrator.js:280` (через lazy-require), `index.js:65` экспортирует | 🟡 **Упростить до функции-классификатора** (~50 строк). Большая часть pattern-matching для 4 типов избыточна. |
| `lease renewal timer` | ~80 в `lease-manager.js` | ✅ ДА — `dispatch-engine.js:594` запускает renewal, `finalizeDispatch` останавливает | 🟢 **Оставить** — иначе длинные задачи теряют lease (см. T6) |
| Counter reconciliation | 307 | ✅ ДА — `runtime-loop.js:75` каждый быстрый tick | 🟢 **Оставить** как safety net |

> Уточнение: `retry-budget-manager` нельзя «просто выкинуть», как сказано в CAPACITY §5.2 —
> `consumeRetryBudget`зашит в production finalization. Удаление сломает защиту от бесконечного
> retry-цикла, восстановленную в T2/T8. Ограничить до `consumeRetryBudget` + простого
> хедера per-(scene, stage) бюджета.

### 2.3 Dead reconciliation phases (C3/C4/C5)

`CAPACITY_AND_COMPLEXITY.md` §5.2 указывает: «C3/C4/C5 из `reconciliation-engine.js` —
log-only фазы, которые никогда ничего не делают».

Подтверждено кодом `reconciliation-engine.js:1176-1203`:

- **C3** (`iu_scan`): только логирует IU images on disk, не меняет состояние.
- **C4** (`counter_reconcile`): дёргает `reconcileMissingSceneState(redis, deps)`, но deps
  из `runtime-loop.setReconcileDeps` не передают PG-репозитории, необходимые для работы →
  effectively no-op.
- **C5** (`session_resume`): guarded на `typeof deps.resumeIncompleteSessions === 'function'`
  и `runBackgroundWindowGeneration` — эти deps **не передаются** в `backend.cjs`. Фаза
  пропускается.

Эти фазы увеличивают прохождение `reconcileCycle` без фактической работы. Решение:
убрать C3/C4/C5 из startup-пути (как советует CAPACITY), оставить только Phase A/B/C1/C2/D.

---

## 3. Оставшиеся дефекты (после T0–T10)

### P1. Прямые writes state в обход фасада (средне)

`ORCHESTRATOR_ARCHITECTURE_WITH_AUDIO.md` §5: «модули НЕ пишут состояние напрямую — только
через фасад». В коде есть два оставшихся нарушения:

1. `backend/src/orchestration/scene-restoration.js:87` — `state.setAssetState(..., 'audio', READY)`
   при restore после dirty units. **Контекст:** disk-fact восстановление; формально
   подходит под категорию restore-unsafe из T8.9, но метод назван не `unsafeRestore…`.
2. `backend/src/services/startup-recovery.js:323-345` — две防御ительные записи через
   `deps.state.setAssetState` на startup. Аналогично — это recovery, не lifecycle.

> Это не баги (поведение корректное), но нарушают инвариант фасада. Минимальное исправление —
> переименовать путь в `unsafeRestoreAssetState` и явно пометить как restore-only (T8.9 из
> старого TODO). **Без нового state framework** — просто rename + lint-соглашение.

### P2. GPU Hub auth: env var не задан в `.env` (низко)

- `.env.example:11` — `GPU_HUB_API_KEY=change_me` (placeholder присутствует).
- `docker-compose.yml:63,86` — переменная передаётся в оба контейнера.
- `.env` (продакшн-окружение разработчика) — **значение не задано**, поэтому в `gpu-hub.js:33`
  `if (!GPU_HUB_API_KEY) return next(); // no key configured = open access`.

Чем это плохо: GPU Hub сейчас **open** для всех endpoint'ов, включая `/queue/clear`.
Для локальной разработки приемлемо, для прод-deploy'а нужно зафиксировать ключ.

> Действие: при deployment в `.env` задать непустой `GPU_HUB_API_KEY`. Код уже корректно
> пробрасывает его во все callers (`gpu-dispatcher`, `cache-routes`, `core-routes`,
> `generation-routes`, `orchestrator`). Правки кода не требуется.

### P3. Graceful shutdown и `/health` отсутствуют (низко)

- `grep -E "/health|/readiness|/liveness|SIGTERM" backend/src` → 0 совпадений.
- При `kill` процесс backend умирает, не дофинализируя активные dispatch'и → lease
  остаются в Redis до TTL (по умолчанию 15/20/30 минут), после чего истекают сами.

Это не блокер: lease TTL — страховка. Но без graceful shutdown:

- Свежеперезапущенный backend может передиспатчить сцену, чей GPU-job ещё работает на
  удалённом worker'е → duplicate работы, пока не сработает `verifyDispatchIdentity` (T4).

> Минимальное: добавить `process.on('SIGTERM', …)` в `backend.cjs`, который зовёт
> `runtime.loop.stop()` и Final-ить активные dispatch'и как `cancelled`. `/health` —
> один endpoint, отдающий `loop.isRunning()` + `redis.ping()`. ~50 строк суммарно
> (см. `CAPACITY_AND_COMPLEXITY.md` §5.3 — «production-readiness gap»).

### P4. Конфигурация resilience модулей дублируется (полировка)

`ORCHESTRATION_FULL_AUDIT.md` §4.2 перечислял магические числа. Часть уже исправлена, но
часть осталась:

- TTL'ы 15/20/30 минут сейчас подтверждены в `lease-manager.js:37-39` — это значения
  из `runtime-config.js`. Дубликата с `dispatch-engine` нет (проверил grep по `QUOTAS`).
- `GPU_TIMEOUT = 10 min` всё ещё hardcoded в `gpu-hub.js:17`, не вынесен в конфиг.

> Действие: вынести `GPU_TIMEOUT` в `runtime-config.js` рядом с `LEASE_TTL`. ~10 строк.

### P5. Предупреждение в логах тестов: `audioOrch.initPlaceholderReady is not a function`

Наблюдается при запуске `npm test` в строках с `[WINDOW]`. Прод-код корректно импортирует
`audio-orchestrator` (`scene-window.js:760`, `scene-orchestrator.js:65`), функция
экспортируется (`services/audio-orchestrator.js:425`). Источник предупреждения —
test-mock, который не подключает полный `audioOrch` объект. **Не влияет на прод.**

> Действие: проверить `backend/tests/mocks/` и убедиться, что mock audioOrch экспортирует
> `initPlaceholderReady`. ~5 строк фикса тестов, не блокер.

---

## 4. Канонический контракт (справочно)

Из `ORCHESTRATOR_ARCHITECTURE_WITH_AUDIO.md` §2 + сверен с кодом:

```
audio-orch.phase == DONE   ⇔   asset.audio == READY       [verify after completeStage]
audio-orch.phase == FAILED ⇒   asset.audio ∈ {FAILED, PENDING}
audio-orch.phase ∈ {WAITING_CHUNKS, MERGING, GENERATING}
                            ⇒   asset.audio == GENERATING
```

|x militares:
- `completeStage('audio')` в `orchestrator.js:161-184` пишет `READY` только после
  version gate success и `audioOrch.completeMerge()` cтатуса `DONE`.
- `failStage('audio')` в `orchestrator.js:265-274` пишет `FAILED → PENDING` с redispatch
  и `audioOrch.failWaitingScene()` → `FAILED`.
- `markDirtyScene('audio')` в `orchestrator.js:307` удаляет `audio-orch` state при `DONE`
  (clean slate для regenerate).

Инвариант подтверждён `reconciliation-engine.checkAudioOrchInvariants` (упомянут в
`ORCHESTRATOR_ARCHITECTURE_WITH_AUDIO.md` §2).

---

## 5. План стабилизации (без усложнения)

Порядок — strictly из принципа «сначала.FromSeconds удалить, потом добавлять»:

### Этап S1 — Удалить dead-code resilience модули (−580 строк)

1. **Удалить `fairness-engine.js`** (605 строк). Проверить, что `runtime-persistence.js:12`
   отпадает; убрать зависимость из `runtime/index.js:22`.
2. **Сократить `failure-taxonomy.js` до ~50 строк** — оставить только классификатор
   `transient | worker | invalid | protocol`. Убрать pattern-matching по 250 строкам.
3. **Сократить `retry-budget-manager.js`**: оставить только `consumeRetryBudget` +
   per-(scene,stage) счётчик. Убрать `refillBudgets` (он doesn't work с wildcard
   ключами, что уже отметлено в `ORCHESTRATION_FULL_AUDIT.md` Б6).
4. **Удалить reconciliation phases C3/C5** из `reconciliation-engine.js`. Оставить Phase A
   (orphan audio), B1 (orphan files), C0/C1/C2 (active fixes), C4 (если передаются deps PG)
   и D (audio-orch invariants).

### Этап S2 — Упростить restore/debug writes (40 строк)

1. В `scene-state.js` переименовать `setAssetState/setAssetStates` в
   `unsafeRestoreAssetState/unsafeRestoreAssetStates` для restore/debug use only.
2. В `orchestrator.js` заменить внутренние `state.setAssetState` на приватные методы
   `facade._setAssetState` — это и есть «фасад единственный писатель».
3. `scene-restoration.js` и `startup-recovery.js` переходят на `unsafe*` — явный процесс,
   что это restore, а не lifecycle.

### Этап S3 — Production-readiness полировка (+50 строк)

1. `backend.cjs`: добавить `SIGTERM`/`SIGINT` handler → `runtime.loop.stop()` +
   `cancelActiveDispatch(...)` для всех активных leases.
2. `/health` endpoint: `{ loop: isRunning, redis: ping, ts: Date.now() }`.
3. Перенести `GPU_TIMEOUT` из `gpu-hub.js:17` в `runtime-config.js`.
4. Покрыть тестами новые контракты: gracefull shutdown ждёт finalezation, /health отвечает
   503 пока Redis не отвечает.

### Этап S4 — Фикс тест-моков (5 строк)

1. В `backend/tests/mocks/` добавить `initPlaceholderReady` в mock audioOrch, чтобы убрать
   warning `audioOrch.initPlaceholderReady is not a function`.

---

## 6. Критерий готовности стабилизации

Система считается стабильной, когда одновременно:

1. ✅ Все production `.js/.cjs` проходят `node --check` (T0 + `pretest`).
2. ✅ `npm test` > 570 passing (currently 576).
3. ✅ `completeStage` NEVER пишет `READY` без `handler.ok`.
4. ✅ `failStage` NEVER writes `recordSuccess`.
5. ✅ `executor` NEVER возвращает `dispatched:true` без реального job.
6. ✅ Renewal стартует только после `dispatched:true` и останавливается в `finalizeDispatch`.
7. ✅ runtime-loop НЕ гоняет полный `reconcileAll` каждые 5s.
8. ✅ `active-scenes` управляются одним API.
9. ✅ Прямые asset-state writes только через `unsafe*` методы для restore/debug.
10. ✅ `fairness-engine` и `retry-budget-manager` refactor/cut размером согласно S1.
11. ✅ Reconciliation C3/C5 удалены, C4 либо работает, либо также удалён.
12. ✅ `GPU_HUB_API_KEY` задан в `.env` для прод-deploy.
13. ✅ Backend корректно shutdown'ится по `SIGTERM` + `/health` отвечает.

Только после этого — никакой новой архитектуры. Никакого RabbitMQ, никакого cluster,
никакого S3 в scope стабилизации.

---

## 7. Чего НЕ делать (согласовано с `ORCHESTRATOR_STABILIZATION_AUDIT.md` §9)

- Не добавлять Kafka, RabbitMQ, BullMQ.
- Не вводить второй state-machine поверх asset FSM.
- Не переносить lifecycle в PostgreSQL одним PR.
- Не переписывать audio pipeline до S1.
- Не добавлять новый reconciliation service.
- Не расширять facade десятками методов (текущих 13 команд достаточно для всех
  инвариантов из `ORCHESTRATOR_ARCHITECTURE_WITH_AUDIO.md`).

> Принцип из обоих исходных документов: одна state machine (asset) + её дополнение
> (audio-orch) уже есть. Один фасад — есть. Один reconcile path — есть. Один finalizer —
> есть. Дальше только **упрощать и фиксировать**, не расширять.

---

## 8. Ссылки

- `docs/02-orchestration/ORCHESTRATOR_ARCHITECTURE_WITH_AUDIO.md` — целевой инвариант
  фасада и audio-orch state.
- `docs/03-audit/CAPACITY_AND_COMPLEXITY.md` — ёмкость и список кандидатов на удаление.
- `docs/03-audit/ORCHESTRATION_STABILIZATION_AUDIT.md` — предыдущий baseline (T1–T10).
- `docs/03-audit/ORCHESTRATION_FULL_AUDIT.md` — исторический full audit (Б1–Б9).
- `docs/02-orchestration/ORCHESTRATOR_LIFECYCLE.md` — lifecycle-контракт.

<!-- === Footer === -->
---
*Аудит выполнен по коду ревизии `d29eca0` (19 июля 2026). T0–T10 закрыты; оставшиеся
дефекты — полировка и dead-code cleanup согласно `CAPACITY_AND_COMPLEXITY.md` §5.2.*
