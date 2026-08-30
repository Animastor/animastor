# Orchestration System Stabilization Audit

**Date:** 2026-07-18
**Revision:** `35d8760` (T10 + final T9/T10 fixes)
**Scope:** `backend/src/orchestration`, `backend/src/runtime`, `backend/src/services`,
`gpu-hub`, `worker`
**Goal:** stabilize and consolidate the current system without a new platform,
new task broker, or major rewrite.

> Worker verification limited to deploy artifact and repository protocol.
> Running process on remote GPU server was not inspected.

---

## 1. Summary

Система уже имеет правильный каркас:

```text
scheduler
  -> dispatch-engine
    -> scene-orchestrator
      -> gpu-hub
        -> worker
          -> callback
            -> orchestrator.completeStage / failStage
```

Главная проблема сейчас не в отсутствии архитектуры, а в том, что несколько ключевых
инвариантов только объявлены в комментариях, но не обеспечены кодом.

Обнаружены четыре блокирующие ошибки:

1. Репозиторный deploy-артефакт GPU worker не проходит синтаксическую проверку.
2. `completeStage()` игнорирует результат callback handler и может поставить `READY`
   после неуспешной проверки файла.
3. `failStage()` завершает dispatch через успешный путь, поэтому ошибка записывается как
   `DISPATCH_COMPLETED`, circuit breaker получает `recordSuccess`, а retry budget не расходуется.
4. Нижний уровень может вернуть `dispatched: true`, даже когда ни одна задача не была
   отправлена в GPU Hub. Lease и quota после этого остаются заняты до timeout/reconcile.

Backend unit/integration suite проходит: **571 passing**. Это не подтверждает работоспособность
полного контура, потому что `worker` и `gpu-hub` не входят в этот test command, а фактически
запущенная версия удалённого GPU worker в рамках аудита не проверялась.

Текущий вывод: архитектуру не нужно расширять. Сначала необходимо сделать детерминированными
четыре операции:

- старт dispatch;
- успешное завершение;
- неуспешное завершение;
- reset/re-dispatch.

После этого можно убрать дубли и привести документацию в соответствие с кодом.

---

## 2. What Was Verified

- чтение текущих orchestration/runtime модулей и критических callback путей;
- карта прямых записей asset state и active-scenes;
- error delivery `worker -> gpu-hub -> backend`;
- quota, lease, retry budget и circuit breaker;
- startup/runtime reconciliation;
- reset/regenerate;
- конфигурация Docker Compose и GPU Hub auth;
- `npm test` в `backend`;
- `node --check` для JS/CJS в `backend`, `gpu-hub`, `worker`.

Результаты проверки:

| Проверка | Результат |
|---|---|
| `backend/npm test` | 564 passing |
| `gpu-hub/gpu-hub.js` syntax | OK |
| backend critical modules syntax | OK |
| репозиторный `worker/worker/worker.js` syntax | FAIL |
| Docker/integration smoke | не выполнялся |

---

## 3. Critical Bugs

### P0.1 Репозиторный worker нельзя воспроизводимо развернуть

**Файл:** `worker/worker/worker.js:193-202`

В `waitForFileReady()` вложенный `try` не имеет собственного `catch` или `finally`:

```js
try {
  try {
    await fsp.access(filePath);
    // ...
  }
} catch (err) {
```

`node --check worker/worker/worker.js` завершается с:

```text
SyntaxError: Missing catch or finally after try
```

Worker обычно запускается на отдельном GPU сервере. Поэтому эта находка не доказывает,
что уже работающий удалённый экземпляр сейчас остановлен: на нём может быть другая ревизия
файла. Она доказывает, что текущую ревизию из репозитория нельзя корректно развернуть или
перезапустить без ручного исправления.

**Минимальное исправление:** удалить лишний внутренний `try`. Добавить syntax-smoke в CI,
чтобы проверять все production JS/CJS, а не только backend tests. При деплое worker логировать
commit SHA или image tag, чтобы remote runtime можно было сопоставить с репозиторием.

---

### P0.2 Неуспешный callback превращается в READY

**Файлы:**

- `backend/src/orchestration/orchestrator.js:76-126`
- `backend/src/orchestration/scene-callbacks.js:41-68`
- `backend/src/orchestration/scene-callbacks.js:324-353`

`completeStage()` вызывает handler, но не проверяет его результат:

```js
await handler(...);
// затем asset безусловно переводится в READY или DIRTY по version gate
```

При этом handlers используют мягкий возврат:

- audio validation failed -> `{ handled: true, reason: 'audio_not_ready' }`;
- video validation failed -> `{ handled: true, reason: 'video_invalid' }`;
- invalid asset state -> `{ handled: false, reason: 'invalid_asset_state' }`.

Во всех этих случаях фасад продолжает выполнение и может поставить asset в `READY`.
В `finally` dispatch также фиксируется как успешно завершённый.

Дополнительный риск: `task-handler.cjs:98-102` при ошибке PostgreSQL запускает
`completeStage(image)` без подтверждения, что пришли все IU.

**Последствие:** Redis может показать `READY`, когда итогового файла нет или callback
относится к неподходящему состоянию. Lease и quota при этом освобождаются как после успеха.

**Минимальное исправление:**

1. Ввести единый результат handler:

```js
{ ok: true }
{ ok: false, retryable: true, reason: 'video_invalid' }
```

2. `completeStage()` пишет `READY` только при `ok: true`.
3. Любой `ok: false` направляется в `failStage()` или возвращает ошибку без success finalization.
4. Убрать fallback "complete despite PG error"; при недоступности PG оставить сцену
   `GENERATING/PENDING` и повторить проверку позже.

---

### P0.3 Failure path записывается как success

**Файлы:**

- `backend/src/orchestration/orchestrator.js:145-192`
- `backend/src/runtime/dispatch-engine.js:572-669`
- `backend/src/runtime/retry-budget-manager.js:304-405`

`failStage()` в `finally` вызывает:

```js
dispatchEngine.markDispatchCompleted(...)
```

`markDispatchCompleted()`:

- вызывает `circuitBreaker.recordSuccess()`;
- пишет `DISPATCH_COMPLETED`;
- освобождает lease и quota.

Отдельный `markDispatchFailed()` существует и вызывает `recordFailure()`, но production
путь `failStage()` его не использует.

Кроме того, `retryBudget.consumeRetryBudget()` не вызывается нигде вне собственного модуля.
Dispatch только проверяет budget, который практически не уменьшается.

**Последствие:** постоянная ошибка worker может приводить к бесконечному циклу:

```text
GENERATING -> FAILED -> PENDING -> dispatch -> error -> PENDING -> ...
```

Circuit breaker не накапливает failures, retry budget не останавливает повторные попытки.

**Минимальное исправление:** заменить два расходящихся метода одним:

```js
finalizeDispatch(redis, scene, stage, {
  outcome: 'success' | 'failure',
  dispatchId,
  reason
})
```

Одна функция должна идемпотентно:

- проверить identity текущего dispatch;
- остановить renewal;
- освободить lease и quota ровно один раз;
- вызвать `recordSuccess` или `recordFailure`;
- при failure расходовать retry budget;
- записать одно корректное journal событие.

Не нужно сохранять параллельные `markDispatchCompleted` и `markDispatchFailed`.

---

### P0.4 Dispatch считается отправленным, когда job не создан

**Файлы:**

- `backend/src/orchestration/scene-orchestrator.js:39-206`
- `backend/src/runtime/dispatch-engine.js:533-556`

`executeAudioDispatch`, `executeImageDispatch`, `executeVideoDispatch` могут закончиться без
отправки job:

- нет `sceneData`;
- audio phase transition отклонён;
- audio generator вернул `locked`;
- video generator вернул `success: false`;
- image generator ничего не отправил.

Эти функции не возвращают явный результат. Верхний `dispatchStage()` после их вызова всегда
возвращает:

```js
{ dispatched: true, stage, reason: 'override' }
```

Dispatch engine считает quota и lease занятыми, хотя GPU Hub не получил задачу.

**Минимальное исправление:** каждый executor обязан вернуть:

```js
{ dispatched: true, jobs: 1 }
{ dispatched: false, reason: 'scene_not_found' }
```

`scene-orchestrator.dispatchStage()` должен только пробросить этот результат. При
`dispatched: false` dispatch engine сразу освобождает lease/quota и не ставит debounce.

---

## 4. High Risks

### P1.1 Force regeneration повреждает quota accounting

**Файлы:**

- `backend/src/runtime/dispatch-engine.js:410-424`
- `backend/src/runtime/dispatch-engine.js:737-760`
- `backend/src/orchestration/orchestrator.js:353-355`

В force mode `releaseQuota(stage)` вызывается безусловно, даже если у этой сцены не было
lease. Это может декрементировать глобальный counter, занятый другой сценой.

Одновременно `clearLeasesForScenes()` удаляет lease keys, metadata и completion markers, но
не освобождает соответствующие quota slots.

Counter reconciliation позже исправляет drift, но внутри текущего тика система может
превысить лимиты.

**Исправление:**

- quota освобождается только владельцем реально существующего lease;
- `clearLeasesForScenes()` сначала читает существующие leases и финализирует каждый как
  `cancelled`, затем удаляет остаточные metadata;
- убрать безусловный `releaseQuota()` из force pre-clear.

---

### P1.2 Callback не привязан к конкретному dispatch

**Файлы:**

- `backend/src/runtime/dispatch-engine.js:50-63`
- `backend/src/runtime/dispatch-engine.js:517-524`
- `backend/src/runtime/dispatch-engine.js:572-585`
- `backend/src/orchestration/orchestrator.js:62-130`

Completion marker имеет ключ только:

```text
book:chapter:scene:stage
```

В нём нет `dispatchId`, lease token или `buildId`. Marker удаляется при новом dispatch.
Старый callback, пришедший после нового запуска, может:

- обработать старый файл;
- claim-нуть marker нового dispatch;
- освободить новый lease/quota;
- поставить текущий asset в `READY`.

HTTP dedup по `(job_id, build_id)` защищает только от повтора одного callback, но не от
конфликта старого и нового dispatch.

**Исправление:** добавить `dispatch_id` в task payload, metadata и callback. Finalization
принимается только если callback identity совпадает с текущей metadata. `buildId` оставить
дополнительной проверкой, но не использовать вместо dispatch identity.

---

### P1.3 Lease renewal существует, но не включён

**Файлы:**

- `backend/src/runtime/lease-manager.js`
- `backend/src/runtime/dispatch-engine.js:887-888`

`startDispatchRenewal()` экспортируется, но production вызовов нет. После успешной отправки
job renewal timer не стартует.

**Последствие:** задача дольше 15/20/30 минут теряет lease и может быть отправлена повторно.

**Исправление:** после подтверждённого `dispatched: true` запускать renewal с lease token.
Finalization любого outcome должна останавливать timer. Добавить тест с fake timers.

---

### P1.4 Scheduler lock не освобождается через finally

**Файл:** `backend/src/runtime/runtime-scheduler.js:334-436`

После захвата lock операции до конца функции не обёрнуты в `try/finally`. Ошибка Redis при
чтении active scenes или force flag оставляет lock до TTL 30 секунд.

**Исправление:** весь tick после acquire поместить в `try/finally`, release выполнять в
`finally` с compare-and-delete.

---

### P1.5 Version gate не является надёжной защитой stale callback

**Файлы:**

- `backend/src/orchestration/scene-callbacks.js:75-92,213-232,355-376`
- `backend/src/orchestration/orchestrator.js:82-113`
- `backend/src/storage/postgres/repositories/scene-assets-repo.js:85-89`

Callbacks вызывают `markReady()` без `build_id` и без явного stamp текущих
`scene_content_version` / `scene_audio_config_version`. Version gate считает asset stale
только если сохранённая версия не `null` и меньше версии сцены.

Если version fields отсутствуют, callback разрешается как `READY`. При ошибке PG gate также
явно разрешает `READY`.

**Исправление:**

- передавать `buildId` и версии в один вызов `completeStage`;
- PG `ready` и Redis `READY` писать только после validation и identity check;
- callback handler не должен самостоятельно писать PG `ready`;
- отсутствие версии трактовать как "не подтверждено", а не как "актуально".

---

### P1.6 Runtime reconciliation фактически не консолидирован

**Файлы:**

- `backend/src/runtime/runtime-loop.js:52-59`
- `backend/src/runtime/reconciliation-engine.js:892-945`
- `backend/src/runtime/reconciliation-engine.js:982-1120`
- `backend/src/backend.cjs:214-236`

Заявлен единый `reconcileCycle()` с distributed lock. На старте он используется.
Но каждые 5 секунд runtime loop отдельно вызывает legacy `reconcileAll()` без этого lock,
а затем отдельно `counterReconciliation.reconcileCounters()`.

Дополнительно `setInterval(async ...)` допускает перекрытие полных runtime ticks, если
reconcile занимает дольше интервала. Scheduler защищён своим lock, но остальные фазы нет.

**Минимальная консолидация:**

- основной 5-секундный tick: scheduler + лёгкие counters/metrics;
- `reconcileCycle()` запускать одним отдельным интервалом, например раз в 60 секунд;
- удалить прямой вызов `reconcileAll()` из runtime loop;
- использовать non-overlapping loop через последовательный `setTimeout` или общий
  `isTickRunning`.

---

## 5. Medium Priority and Polish

### P2.1 State owner объявлен, но не обеспечен

`state.setAssetState()` и `setAssetStates()`:

- не валидируют переход;
- не валидируют значение status;
- доступны всем модулям;
- вызываются напрямую из scheduler, scene-orchestrator, book-diff, startup recovery,
  runtime persistence, restoration, helpers и debug routes.

Поэтому `validateAssetTransition()` сейчас является рекомендацией, а не инвариантом.

**Упрощение:** оставить raw setters только для restore/debug под явным именем
`unsafeRestoreAssetState`. Все runtime переходы провести через короткие команды фасада:

```text
markPending
markGenerating
complete
fail
markDirty
reset
```

Новый state-machine framework не нужен.

---

### P2.2 Два API active-scenes

Один Redis set `animastor:active-scenes` обслуживают два модуля:

- `runtime/runtime-scheduler.js`;
- `runtime/active-scenes-index.js`.

Callers используют оба API. Это лишняя поверхность и источник расхождения поведения.

**Упрощение:** оставить `active-scenes-index.js`; scheduler должен использовать его, а не
реализовывать SADD/SREM/SMEMBERS повторно.

---

### P2.3 Reconciliation использует `buildId = default`

**Файл:** `backend/src/runtime/reconciliation-engine.js:77-176`

Orphan checks для audio/image/video ищут файлы в build `default`, хотя реальные callbacks
работают с manifest/build-specific paths. Это создаёт ложные orphan reports.

**Исправление:** получать build id из PG asset row или manifest. Если build неизвестен,
возвращать `unknown_build`, а не `missing_file`.

---

### P2.4 Cleanup expired audio locks является мёртвым

**Файл:** `backend/src/runtime/reconciliation-engine.js:1248-1279`

Функция сканирует существующие `audio-scene-failsafe:*`, затем сразу проверяет
`exists(failsafeKey)` и делает `continue`. Ветка удаления lock недостижима для найденного key.

При этом production audio lock уже имеет TTL 600 секунд, а создание failsafe key в активном
audio generation path не найдено.

**Упрощение:** удалить phase B и старый cleanup-service код, если TTL lock достаточен.
Не нужно чинить механизм, который больше не участвует в lifecycle.

---

### P2.5 GPU Hub auth и queue clear не завершены

**Файлы:**

- `gpu-hub/gpu-hub.js:26-38,498-590`
- `backend/src/orchestration/orchestrator.js:357-367`
- `docker-compose.yml:76-81`
- `.env.example`

Проблемы:

- `API_KEY` не задан в Compose, поэтому auth фактически выключен;
- backend не передаёт `x-api-key`, поэтому включение ключа сломает reset;
- другие backend routes также вызывают `/queue/clear` без ключа;
- filtered cleanup ищет result keys по `animastor:result:${book_id}_*`, но текущий формат
  ключа: `animastor:result:<buildId>:<bookId>:...`;
- matching через `job_id.startsWith(book_id + '_')` допускает конфликт book id prefix.

**Исправление:** один `GPU_HUB_API_KEY` в `.env.example`, Compose, backend config и запросах.
Для queue records передавать структурированный `book_id`, не извлекать ownership по prefix.

---

### P2.6 Документация преждевременно отмечает систему завершённой

`ORCHESTRATION_AUDIT_TODO.md` и связанные документы фиксируют T1-T8 и P5 как полностью
завершённые. Текущий код этому не соответствует:

- репозиторный worker не проходит syntax check;
- failure path не использует failure finalization;
- retry budget не расходуется;
- renewal не стартует;
- direct state writers остаются;
- runtime использует второй reconcile path.

**Исправление:** этот документ считать актуальным baseline. Старые аудиты оставить как
историю, но добавить в их шапки ссылку на текущий статус.

---

## 6. Minimal Target Schema

Новая архитектура не требуется. Достаточно закрепить текущие роли.

| Компонент | Единственная ответственность |
|---|---|
| Scheduler | выбрать следующий stage |
| Orchestrator facade | принять lifecycle command и изменить asset state |
| Dispatch engine | lease, quota, dispatch identity, finalization |
| Scene executors | построить и реально отправить job |
| GPU Hub | очередь, worker registry, доставка result/error |
| Worker | выполнить job и вернуть result/error |
| Reconcile cycle | собрать факты и предложить/выполнить безопасное восстановление |

Ключевой контракт:

```text
beginDispatch
  -> { dispatchId, leaseToken }

executor
  -> { dispatched, jobs, reason }

finalizeDispatch
  -> success | failure | cancelled
  -> ровно один release
  -> проверка dispatchId
```

Asset transition выполняет только facade. Callback handler возвращает факт, но не принимает
финальное lifecycle решение.

---

## 7. Fix Order

### Phase A. Restore Correctness

1. Исправить syntax репозиторного worker.
2. Сделать callback result обязательным для `completeStage`.
3. Объединить success/failure release в `finalizeDispatch(outcome)`.
4. Подключить `recordFailure` и `consumeRetryBudget`.
5. Пробросить реальный `{ dispatched }` из stage executors.

После этого система перестанет ложно завершать и бесконечно повторять задачи.

### Phase B. Eliminate Races

1. Добавить `dispatchId` в task/result/error contract.
2. Исправить force reset и quota ownership.
3. Запустить lease renewal после реальной отправки job.
4. Освобождать scheduler lock в `finally`.
5. Сделать runtime loop неперекрывающимся.

### Phase C. Consolidate and Remove Duplicates

1. Оставить один active-scenes API.
2. Оставить один periodic `reconcileCycle`.
3. Перевести production state writes в facade.
4. Удалить dead cleanup/failsafe path и deprecated recovery wrappers.
5. Исправить GPU Hub auth/config и queue cleanup.
6. Обновить старые audit/TODO статусы.

---

## 8. Required Tests

### Static smoke

```bash
find backend/src gpu-hub worker \
  -path '*/node_modules' -prune -o \
  \( -name '*.js' -o -name '*.cjs' \) -type f -print0 |
while IFS= read -r -d '' f; do
  node --check "$f"
done
```

### Unit tests

- audio/video callback validation failed -> asset не становится `READY`;
- failure -> `recordFailure`, budget уменьшен, `DISPATCH_FAILED`, один release;
- executor без job -> `dispatched:false`, quota/lease освобождены;
- force reset одной сцены не меняет quota другой сцены;
- stale callback старого `dispatchId` игнорируется;
- scheduler lock освобождается после исключения;
- renewal вызывается после реального dispatch и останавливается при finalization.

### Integration smoke

1. Удалённый worker с зафиксированным commit/image tag получает job и возвращает result.
2. Удалённый worker возвращает error, backend делает ограниченный retry.
3. Старый callback приходит после regenerate и не завершает новый dispatch.
4. Regenerate одной книги не удаляет jobs другой книги.
5. Задача дольше базового lease TTL не получает duplicate dispatch.
6. После idle: quota counters равны числу активных leases и возвращаются к нулю.

---

## 9. What NOT to Do

- Не добавлять Kafka, RabbitMQ, BullMQ или отдельный workflow engine.
- Не вводить ещё одну state machine поверх asset state.
- Не переносить lifecycle целиком в PostgreSQL одним большим PR.
- Не переписывать audio pipeline до исправления общей finalization.
- Не добавлять новый reconciliation service рядом с существующим.
- Не расширять facade десятками узких методов.

Стабилизация достигается не новым слоем, а удалением неоднозначности в текущем:
один dispatch identity, один finalizer, один state owner, один reconcile cycle.

---

## 10. Readiness Criteria

Система считается стабилизированной, когда одновременно выполняются условия:

1. Все production JS/CJS проходят syntax check.
2. Любой dispatch имеет identity, lease и один final outcome.
3. Failure никогда не записывается как success.
4. Callback без подтверждённого результата не ставит `READY`.
5. Retry budget реально ограничивает повторы.
6. Force reset не создаёт quota drift.
7. Нет production state writes в обход facade, кроме явно именованного restore/debug API.
8. Runtime использует один periodic reconciliation path.
9. Backend, GPU Hub и worker проходят один сквозной smoke test.
