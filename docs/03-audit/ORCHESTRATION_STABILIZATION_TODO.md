# TODO: стабилизация системы оркестрации

**Дата:** 2026-07-17  
**Статус:** T0 ✓ — в работе (T1)  
**Основание:** `docs/03-audit/ORCHESTRATION_STABILIZATION_AUDIT.md`  
**Область:** `backend/src/orchestration`, `backend/src/runtime`,
`backend/src/services`, `gpu-hub`, `worker`  
**Цель:** исправить подтверждённые ошибки, закрепить один жизненный цикл dispatch,
убрать дубли и отполировать текущую реализацию без новой платформы оркестрации.

> Worker обычно запускается на удалённом GPU сервере. Локальный TODO покрывает
> репозиторный deploy-артефакт и протокол. Проверка фактически запущенного worker
> выполняется отдельно в T0 и T10 после фиксации его commit SHA или image tag.

---

## 1. Ограничения

В рамках этого плана:

- не добавлять Kafka, RabbitMQ, BullMQ или другой брокер;
- не добавлять workflow engine;
- не вводить вторую state machine поверх текущего asset state;
- не переносить весь lifecycle в PostgreSQL одним большим изменением;
- не переписывать целиком audio, image или video pipeline;
- не создавать второй reconciliation service;
- не смешивать исправление поведения с несвязанными рефакторингами;
- не считать удалённый worker проверенным только потому, что локальный файл проходит
  `node --check`.

Предпочтительный размер изменения:

- один логический дефект или один контракт на коммит;
- тесты добавляются в том же коммите, что и исправление;
- после каждого этапа система должна запускаться и проходить предыдущие проверки;
- временная совместимость допустима только для rollout удалённого worker и должна быть
  удалена до закрытия соответствующего этапа.

---

## 2. Целевые инварианты

После выполнения TODO должны одновременно выполняться следующие условия:

1. Каждый принятый dispatch имеет `dispatchId`, lease token и metadata.
2. Executor сообщает `dispatched: true` только после фактической отправки хотя бы одного job.
3. Каждый dispatch имеет ровно один итог: `success`, `failure` или `cancelled`.
4. Lease и quota освобождаются одним finalizer и не более одного раза.
5. `failure` никогда не вызывает `recordSuccess` и не пишет `DISPATCH_COMPLETED`.
6. Retry budget расходуется ровно один раз на принятый failure.
7. Callback может завершить только тот dispatch, из которого он был создан.
8. Невалидный, неполный или stale callback не пишет файл, PG `ready` или Redis `READY`.
9. Lease продлевается только для реально принятого job и останавливается при любом финале.
10. Force reset освобождает только ресурсы reset-нутых dispatch.
11. Runtime использует один periodic reconciliation path без перекрывающихся циклов.
12. Production asset transitions выполняются через orchestration facade.
13. Backend, GPU Hub и удалённый worker используют один проверяемый протокол.

Минимальный целевой контракт:

```text
beginDispatch
  -> { dispatchId, leaseToken }

executor
  -> { dispatched, jobs, reason }

callback
  -> { dispatchId, jobId, buildId, result | error }

finalizeDispatch
  -> success | failure | cancelled
  -> identity check
  -> one release
```

---

## 3. Порядок выполнения

| Этап | Приоритет | Результат | Зависит от |
|---|---|---|---|
| T0 | P0 | Валидный worker и воспроизводимая проверка версии | - |
| T1 | P0 | Callback не может ложно поставить `READY` | T0 |
| T2 | P0 | Один корректный finalization path | T1 |
| T3 | P0 | Честный результат executor и отсутствие пустых dispatch | T2 |
| T4 | P1 | Сквозной `dispatchId` и защита от stale callback | T2, T3 |
| T5 | P1 | Корректный force reset и quota ownership | T2, T4 |
| T6 | P1 | Renewal, lock safety и non-overlapping runtime loop | T2, T3 |
| T7 | P1 | Один periodic reconciliation path | T6 |
| T8 | P2 | Один владелец asset state и active-scenes | T1, T2, T7 |
| T9 | P2 | Завершённый GPU Hub contract, auth и queue cleanup | T4, T5 |
| T10 | Gate | Полная локальная и удалённая проверка | T0-T9 |

Не начинать T8 как массовую миграцию state writers до закрытия T1-T3. Сначала необходимо
исправить семантику lifecycle, затем консолидировать точки записи.

---

## 4. Общий Definition of Done

Каждый этап считается завершённым только если:

- [ ] Реализация покрывает все перечисленные ветки success, failure и early return.
- [ ] Нет нового параллельного API, оставленного рядом со старым без плана удаления.
- [ ] Добавлены regression tests для исправленного дефекта.
- [ ] `node --check` проходит для изменённых JS/CJS файлов.
- [ ] `cd backend && npm test` проходит полностью.
- [ ] `git diff --check` не находит whitespace ошибок.
- [ ] События journal и логи используют фактический outcome.
- [ ] Ошибка внешнего сервиса не маскируется как success.
- [ ] Изменения конфигурации отражены в `.env.example` и Compose, если применимо.
- [ ] Для изменения протокола проверены backend, GPU Hub и worker.

---

## T0. Worker и статические проверки

**Приоритет:** P0  
**Цель:** сделать репозиторный worker валидным deploy-артефактом и связать удалённый
runtime с конкретной ревизией кода.  
**Основные файлы:**

- `worker/worker/worker.js`
- `worker/worker/package.json`
- `gpu-hub/gpu-hub.js`
- существующий CI или общий test script проекта

### Реализация

- [x] **T0.1 Исправить синтаксис `waitForFileReady()`.** Удалить лишний вложенный `try`
  около текущих строк 193-202, не меняя retry и timeout поведение функции.
- [x] **T0.2 Проверить весь worker после исправления.** Выполнить
  `node --check worker/worker/worker.js`, затем запустить worker в режиме, который не
  требует реальной GPU задачи, если такой режим уже существует.
- [x] **T0.3 Добавить единый syntax-smoke.** Проверять все production `.js` и `.cjs`
  в `backend/src`, `gpu-hub` и `worker`, исключая `node_modules`.
- [x] **T0.4 Подключить syntax-smoke к существующему test/CI entrypoint.** Не создавать
  отдельную CI-систему. Достаточно одного скрипта, который можно одинаково вызвать локально
  и в CI.
- [x] **T0.5 Добавить идентификатор версии worker.** Worker должен брать commit SHA или
  image tag из environment и передавать его в beacon. Допустимые имена должны быть
  едиными, например `WORKER_VERSION` и `WORKER_IMAGE_TAG`.
- [x] **T0.6 Сохранить версию в GPU Hub heartbeat record.** Поле версии должно быть видно
  в диагностике worker вместе с `worker_id`, типом и текущим job.
- [x] **T0.7 Логировать версию при старте worker.** В первой группе startup-логов должны
  быть версия, тип worker, Hub URL и protocol version без вывода секретов.
- [ ] **T0.8 Зафиксировать процедуру удалённой проверки.** Перед smoke записать:
  hostname/worker id, commit SHA или image tag, время запуска и ожидаемый protocol version.

### Тесты

- [x] Syntax-smoke падает на синтаксически невалидном временном fixture.
- [x] Syntax-smoke проходит для текущих production JS/CJS.
- [x] Beacon без optional version остаётся понятным на переходном этапе.
- [x] Beacon с version сохраняет и возвращает это поле без изменения.

### Критерий приёмки

- [x] Текущий `worker/worker/worker.js` проходит `node --check`.
- [x] Один локальный command проверяет backend, GPU Hub и worker.
- [x] Для запущенного удалённого worker можно однозначно назвать ревизию кода.
- [ ] Удалённый runtime не объявляется проверенным, если его версия неизвестна.

### Рекомендуемые коммиты

1. `fix(worker): repair waitForFileReady syntax`
2. `test(orchestration): add production javascript syntax smoke`
3. `chore(worker): report deployed worker version`

---

## T1. Контракт callback completion

**Приоритет:** P0  
**Цель:** запретить переход в `READY`, если handler не подтвердил корректный результат.  
**Основные файлы:**

- `backend/src/orchestration/orchestrator.js`
- `backend/src/orchestration/scene-callbacks.js`
- `backend/src/services/task-handler.cjs`
- `backend/src/services/audio-orchestrator.js`
- `backend/src/storage/postgres/repositories/scene-assets-repo.js`
- `backend/tests/happy-path.test.js`
- новые focused callback tests

### Контракт

Все stage handlers должны возвращать один формат:

```js
{
  ok: true,
  retryable: false,
  reason: null,
  artifact: {
    buildId,
    path
  }
}
```

или:

```js
{
  ok: false,
  retryable: true,
  reason: 'video_invalid',
  artifact: null
}
```

`handled`, `success`, отсутствие return и thrown error не должны одновременно использоваться
как разные способы сообщить один и тот же результат.

### Реализация

- [ ] **T1.1 Описать callback result рядом с facade.** Добавить короткий JSDoc/type
  contract без новой библиотеки типов.
- [ ] **T1.2 Мигрировать `handleAudioCompleted()`.** Успех возвращается только после
  подтверждения готового итогового audio artifact.
- [ ] **T1.3 Мигрировать `handleImageCompleted()`.** Успех возвращается только после
  подтверждения полного набора требуемых IU и валидных файлов.
- [ ] **T1.4 Мигрировать `handleVideoCompleted()`.** Успех возвращается только после
  проверки итогового video artifact.
- [ ] **T1.5 Удалить мягкие неявные результаты.** Ветки `audio_not_ready`,
  `video_invalid`, `invalid_asset_state` и аналогичные должны явно вернуть `ok: false`.
- [ ] **T1.6 Проверять result в `completeStage()`.** Переход к version check и `READY`
  разрешён только при `result.ok === true`.
- [ ] **T1.7 Не считать thrown handler успешным completion.** Исключение handler должно
  попасть в failure path с исходной причиной и не вызывать success finalization.
- [ ] **T1.8 Разделить retryable и terminal rejection.** Retryable result направляется
  в `failStage()` после T2; terminal/stale rejection журналируется и не переводит asset
  в `READY`.
- [ ] **T1.9 Убрать completion при ошибке PostgreSQL из `task-handler.cjs`.** Если нельзя
  подтвердить количество IU или актуальность результата, оставить stage незавершённым
  и позволить reconciliation повторить проверку.
- [ ] **T1.10 Перенести PG `ready` после validation.** Callback handler не должен заранее
  писать `scene_assets.status='ready'`, если facade ещё не подтвердил artifact и version gate.
- [ ] **T1.11 Сделать version gate fail-closed.** Ошибка PG, отсутствующая asset version
  или отсутствие ожидаемой scene version не должны автоматически разрешать `READY`.
- [ ] **T1.12 Сохранить cache-hit поведение явно.** Валидный artifact, найденный без GPU
  dispatch, должен завершаться отдельной подтверждённой веткой, а не через неявный return.

### Тесты

- [ ] Audio handler `ok: false` не пишет Redis `READY`.
- [ ] Image handler при неполном наборе IU не пишет Redis или PG `ready`.
- [ ] Video handler при невалидном файле не пишет Redis или PG `ready`.
- [ ] Исключение handler не вызывает success finalization.
- [ ] Ошибка PG в проверке количества IU не вызывает `completeStage(image)`.
- [ ] Ошибка PG в version gate не разрешает `READY`.
- [ ] Отсутствующая asset version не разрешает `READY`.
- [ ] Валидный callback пишет PG и Redis `ready` в согласованном порядке.
- [ ] Повтор валидного callback не создаёт второй lifecycle transition.

### Критерий приёмки

- [ ] В `completeStage()` нет безусловного перехода в `READY` после вызова handler.
- [ ] У каждого callback handler есть явный return contract.
- [ ] Ни один error fallback не вызывает completion "на всякий случай".
- [ ] PG `ready` и Redis `READY` означают подтверждённый artifact.

### Рекомендуемые коммиты

1. `refactor(orchestration): define callback completion result`
2. `fix(orchestration): reject unvalidated callback completion`
3. `fix(image): stop completing stage when postgres validation fails`
4. `test(orchestration): cover rejected callback completion`

---

## T2. Единая finalization

**Приоритет:** P0  
**Цель:** заменить расходящиеся success/failure paths одной идемпотентной операцией.  
**Основные файлы:**

- `backend/src/runtime/dispatch-engine.js`
- `backend/src/runtime/retry-budget-manager.js`
- `backend/src/runtime/circuit-breaker.js`
- `backend/src/runtime/failure-taxonomy.js`
- `backend/src/orchestration/orchestrator.js`
- `backend/src/orchestration/event-journal.js`
- `backend/tests/fail-stage.test.js`
- `backend/tests/happy-path.test.js`

### Целевой API

```js
finalizeDispatch(redis, bookId, chapterId, sceneId, stage, {
  outcome: 'success' | 'failure' | 'cancelled',
  dispatchId,
  reason,
  failureType,
  workerId
})
```

T2 использует `dispatch_id`, уже сохранённый в dispatch metadata. T4 сделает входящий
`dispatchId` обязательным для callback и добавит строгую проверку identity.

### Реализация

- [ ] **T2.1 Добавить `finalizeDispatch()`.** Вся логика stop renewal, release lease,
  release quota, circuit breaker, retry budget, metadata cleanup и journal должна находиться
  в одной функции.
- [ ] **T2.2 Зафиксировать допустимые outcomes.** Не принимать произвольную строку и не
  сводить `cancelled` к success или failure.
- [ ] **T2.3 Сделать claim идемпотентным.** Один dispatch может быть финализирован только
  один раз. Marker должен быть связан с текущим metadata `dispatch_id`, а не только со
  сценой и stage.
- [ ] **T2.4 Сохранить ownership в metadata.** Metadata должна позволять понять, были ли
  получены lease и quota, и какой lease token принадлежит dispatch.
- [ ] **T2.5 Освобождать lease только по token.** Token mismatch означает stale owner и
  не должен удалять чужой lease.
- [ ] **T2.6 Освобождать quota только после успешного finalization claim.** Повторный
  callback не должен повторно декрементировать counter.
- [ ] **T2.7 Обработать `success`.** Вызвать `circuitBreaker.recordSuccess()`, не расходовать
  retry budget, записать `DISPATCH_COMPLETED`.
- [ ] **T2.8 Обработать `failure`.** Вызвать `circuitBreaker.recordFailure()`, расходовать
  retry budget ровно один раз, записать `DISPATCH_FAILED`.
- [ ] **T2.9 Обработать `cancelled`.** Освободить ресурсы, не записывать worker success,
  не штрафовать retry budget, записать `DISPATCH_CANCELLED`.
- [ ] **T2.10 Использовать `failure-taxonomy`.** Причина worker error, timeout, invalid
  artifact и internal dispatch error должна получать существующую классификацию, а не
  всегда `transient`.
- [ ] **T2.11 Перевести `completeStage()` на finalizer success.** Success вызывается только
  после успешного T1 result и state transition.
- [ ] **T2.12 Перевести `failStage()` на finalizer failure.** Удалить вызов
  `markDispatchCompleted()` из failure path.
- [ ] **T2.13 Перевести dispatch exception path.** Ошибка после создания metadata должна
  проходить через finalizer failure или cancelled в зависимости от того, был ли job принят.
- [ ] **T2.14 Удалить старые public finalizers.** После миграции всех callers удалить
  `markDispatchCompleted()` и `markDispatchFailed()` либо оставить только private wrapper
  на один короткий переходный коммит.
- [ ] **T2.15 Не маскировать primary error.** Ошибка освобождения ресурсов логируется и
  попадает в reconciliation, но не заменяет исходную callback/worker причину.

### Порядок finalization

- [ ] Получить текущую metadata и определить текущий `dispatch_id`.
- [ ] Claim-нуть finalization marker для этого `dispatch_id`.
- [ ] Если marker уже claim-нут, вернуть `{ finalized: false, reason: 'already_finalized' }`.
- [ ] Остановить renewal.
- [ ] Освободить lease только при совпадении token.
- [ ] Освободить quota только если metadata подтверждает ownership.
- [ ] Обновить circuit breaker согласно outcome.
- [ ] Расходовать retry budget только для первого failure claim.
- [ ] Записать одно итоговое journal event.
- [ ] Удалить активную metadata или заменить её короткоживущей final record.

### Тесты

- [ ] Success вызывает один `recordSuccess`, ноль `recordFailure`.
- [ ] Failure вызывает один `recordFailure`, ноль `recordSuccess`.
- [ ] Failure расходует retry budget ровно один раз.
- [ ] Повторный failure не расходует budget повторно.
- [ ] Повторный success не освобождает quota повторно.
- [ ] Success после уже принятого failure отклоняется.
- [ ] Failure после уже принятого success отклоняется.
- [ ] Cancelled не влияет на circuit breaker и retry budget.
- [ ] Lease token mismatch не удаляет новый lease.
- [ ] Ошибка release не меняет outcome с failure на success.
- [ ] Journal содержит один итоговый event с правильной причиной.

### Критерий приёмки

- [ ] В production нет вызова `markDispatchCompleted()` из failure path.
- [ ] `consumeRetryBudget()` вызывается из production finalization.
- [ ] Success, failure и cancelled используют одну реализацию release.
- [ ] Counter reconciliation остаётся страховкой, а не штатным способом освободить quota.

### Рекомендуемые коммиты

1. `refactor(dispatch): add outcome-aware dispatch finalizer`
2. `fix(orchestration): finalize failed stages as failure`
3. `fix(retry): consume retry budget on dispatch failure`
4. `refactor(dispatch): remove legacy completion finalizers`

---

## T3. Честный executor result

**Приоритет:** P0  
**Цель:** не удерживать lease/quota и не оставлять `GENERATING`, если job не создан.  
**Основные файлы:**

- `backend/src/orchestration/scene-orchestrator.js`
- `backend/src/runtime/dispatch-engine.js`
- `backend/src/audio`
- `backend/src/image`
- `backend/src/video`
- `backend/src/runtime/gpu-dispatcher.js`
- focused executor tests

### Контракт

Каждый stage executor возвращает:

```js
{ dispatched: true, jobs: 1, reason: null }
```

или:

```js
{ dispatched: false, jobs: 0, reason: 'scene_not_found' }
```

`dispatched: true` означает, что GPU Hub подтвердил приём хотя бы одного job. Лог
`*_DISPATCHED`, построенный workflow или созданный job spec сами по себе не являются
подтверждением dispatch.

### Реализация

- [ ] **T3.1 Вернуть result из `executeAudioDispatch()`.** Учесть `sceneData` missing,
  rejected audio phase transition, `locked`, `already_ready`, ноль созданных chunks и
  реальную отправку chunks.
- [ ] **T3.2 Вернуть result из `executeImageDispatch()`.** Нижний image generator должен
  вернуть количество реально отправленных IU jobs и отдельный cache-hit результат.
- [ ] **T3.3 Вернуть result из `executeVideoDispatch()`.** `success: false`, пустой
  `jobSpecs` и ошибка `sendUnified()` не должны превращаться в dispatch success.
- [ ] **T3.4 Пробросить result из `scene-orchestrator.dispatchStage()`.** Удалить
  безусловный `{ dispatched: true, reason: 'override' }`.
- [ ] **T3.5 Подтвердить приём job в `gpu-dispatcher`.** `sendUnified()` должен возвращать
  структурированный результат успешного HTTP enqueue, а не только отсутствие exception.
- [ ] **T3.6 Не ставить debounce при `dispatched: false`.**
- [ ] **T3.7 Немедленно финализировать пустой dispatch.** Освободить lease/quota,
  удалить metadata и вернуть stage в состояние, соответствующее причине.
- [ ] **T3.8 Не оставлять ложный `GENERATING`.** Запись `GENERATING` должна происходить
  после подтверждённого enqueue либо компенсироваться до возврата `dispatched: false`.
- [ ] **T3.9 Обработать cache hit отдельно.** Валидный готовый artifact проходит T1
  completion без GPU job; это не считается активным dispatch.
- [ ] **T3.10 Зафиксировать multi-job семантику.** `jobs` равен числу принятых job.
  Finalization stage остаётся один, после подтверждения полного stage результата.

### Тесты

- [ ] Нет `sceneData` -> `dispatched: false`, lease/quota освобождены.
- [ ] Audio phase transition rejected -> `dispatched: false`.
- [ ] Audio generator `locked` -> `dispatched: false`.
- [ ] Image generator создал ноль jobs -> `dispatched: false`.
- [ ] Video generator вернул `success: false` -> `dispatched: false`.
- [ ] Video generator вернул пустой `jobSpecs` -> `dispatched: false`.
- [ ] Ошибка enqueue одного job не сообщает полный success.
- [ ] Реально принятый job -> `dispatched: true`, `jobs >= 1`.
- [ ] `last-active` debounce создаётся только после принятого job.
- [ ] Early return не оставляет asset в `GENERATING`.

### Критерий приёмки

- [ ] Все три executor имеют одинаковую форму результата.
- [ ] `scene-orchestrator` не генерирует success самостоятельно.
- [ ] Dispatch engine удерживает ресурсы только для принятого GPU job.
- [ ] В тестах есть каждая известная ветка "job не создан".

### Рекомендуемые коммиты

1. `refactor(audio): return explicit dispatch result`
2. `refactor(image): report accepted image jobs`
3. `refactor(video): report accepted video jobs`
4. `fix(dispatch): release resources when executor sends no job`

---

## T4. Сквозной dispatch identity

**Приоритет:** P1  
**Цель:** старый callback не может завершить новый dispatch той же сцены и stage.  
**Основные файлы:**

- `backend/src/runtime/dispatch-engine.js`
- `backend/src/runtime/job-schema.js`
- `backend/src/runtime/gpu-dispatcher.js`
- `backend/src/routes/generation-routes.cjs`
- `backend/src/services/task-handler.cjs`
- `gpu-hub/gpu-hub.js`
- `worker/worker/worker.js`

### Протокол

`dispatch_id` является отдельным обязательным полем. Не кодировать его только внутри
`job_id` и не заменять им `build_id`.

```text
backend enqueue
  -> gpu-hub queue/running
    -> worker task
      -> worker result/error
        -> gpu-hub backend callback
          -> completeStage/failStage
```

На каждом переходе должны сохраняться:

- `dispatch_id`;
- `job_id`;
- `build_id`;
- `book_id`, `chapter_id`, `scene_id`;
- `stage`;
- `protocol_version`.

### Реализация

- [ ] **T4.1 Добавить `dispatch_id` в job schema.** Валидировать непустое значение и
  не генерировать новый id в промежуточных компонентах.
- [ ] **T4.2 Передать `dispatchId` из dispatch engine в executor.**
- [ ] **T4.3 Добавить `dispatch_id` во все audio/image/video job specs.** Все jobs одного
  stage dispatch используют один dispatch id.
- [ ] **T4.4 Сохранить identity в GPU Hub queue record.**
- [ ] **T4.5 Сохранить identity в `animastor:running`.**
- [ ] **T4.6 Передать identity удалённому worker.**
- [ ] **T4.7 Вернуть identity из worker `/task/result` и `/task/error`.**
- [ ] **T4.8 Форвардить identity из GPU Hub в backend result/error endpoints.**
- [ ] **T4.9 Проверять identity до обработки payload.** Backend должен сравнить
  `dispatch_id` с текущей dispatch metadata до base64 decode, записи файла, PG update,
  Redis asset transition и finalization.
- [ ] **T4.10 Отклонять stale callback явно.** Вернуть идемпотентный ответ с причиной
  `stale_dispatch`, записать диагностическое journal event, не менять текущий dispatch.
- [ ] **T4.11 Привязать dedup к identity.** Dedup result/error должен включать
  `dispatch_id`, `job_id` и `build_id`.
- [ ] **T4.12 Привязать finalization marker к identity.**
- [ ] **T4.13 Не использовать version gate вместо identity.** Version check остаётся
  дополнительной проверкой artifact, но не определяет владельца lease.
- [ ] **T4.14 Добавить protocol version rollout.** Изменение формата должно повысить
  `protocol_version` и давать понятную ошибку при несовместимом worker.

### Rollout удалённого worker

- [ ] Backend и GPU Hub сначала умеют передавать и логировать `dispatch_id`.
- [ ] Обновлённый worker развёрнут на GPU сервере с известным commit/image tag.
- [ ] Beacon подтверждает новую worker version и protocol version.
- [ ] Старые queued/running jobs завершены или контролируемо отменены.
- [ ] Выполнен один result smoke и один error smoke с новым `dispatch_id`.
- [ ] После smoke backend начинает отклонять callbacks без `dispatch_id`.
- [ ] Временная ветка совместимости удалена в рамках T4, а не оставлена навсегда.

### Тесты

- [ ] Roundtrip job schema сохраняет `dispatch_id`.
- [ ] GPU Hub queue -> worker сохраняет identity.
- [ ] Worker result сохраняет identity.
- [ ] Worker error сохраняет identity.
- [ ] Callback текущего dispatch принимается.
- [ ] Callback предыдущего dispatch отклоняется до записи artifact.
- [ ] Старый callback не освобождает новый lease/quota.
- [ ] Старый callback не claim-ит finalization marker нового dispatch.
- [ ] Одинаковый `job_id` в двух dispatch не конфликтует в dedup.
- [ ] Callback без identity отклоняется после завершения rollout.

### Критерий приёмки

- [ ] В production callback path нет fallback на "текущий dispatch" при отсутствии id.
- [ ] По одному логу можно связать enqueue, worker execution и final outcome.
- [ ] Stale callback тест воспроизводит regenerate race и проходит.
- [ ] Удалённый worker подтверждён как совместимый с новым protocol version.

### Рекомендуемые коммиты

1. `feat(protocol): carry dispatch id in gpu jobs`
2. `feat(worker): return dispatch id with result and error`
3. `fix(orchestration): reject stale dispatch callbacks`
4. `test(protocol): cover dispatch identity roundtrip`

---

## T5. Force reset и quota ownership

**Приоритет:** P1  
**Цель:** reset/regenerate одной сцены не изменяет ресурсы другого dispatch.  
**Основные файлы:**

- `backend/src/orchestration/orchestrator.js`
- `backend/src/runtime/dispatch-engine.js`
- `backend/src/runtime/runtime-scheduler.js`
- `backend/src/routes/book/generation-routes.cjs`
- `gpu-hub/gpu-hub.js`

### Реализация

- [ ] **T5.1 Удалить безусловный `releaseQuota()` из force pre-clear.**
- [ ] **T5.2 Финализировать существующий dispatch как `cancelled`.** Перед reset прочитать
  metadata и lease каждой выбранной сцены/stage.
- [ ] **T5.3 Освобождать quota только владельцу metadata.** Отсутствие lease/metadata
  означает отсутствие права декрементировать counter.
- [ ] **T5.4 Переписать `clearLeasesForScenes()`.** Сначала вызвать controlled
  cancellation для реально существующих dispatch, затем удалить только остаточные keys.
- [ ] **T5.5 Переписать `clearAllLeasesForBook()` по тому же правилу.**
- [ ] **T5.6 Сохранить final records отменённых dispatch.** Поздний callback должен
  определяться как stale/cancelled, а не как callback нового запуска.
- [ ] **T5.7 Ограничить reset выбранными scenes/stages.** Не очищать unrelated jobs,
  leases или metadata книги.
- [ ] **T5.8 Удалить book-wide `force-dispatch` TTL, если корректной cancellation достаточно.**
  Scheduler после reset должен использовать обычный dispatch path.
- [ ] **T5.9 Если force marker временно нужен, сделать его scene/stage scoped.** Удалить
  marker сразу после первого принятого dispatch, не ждать TTL.
- [ ] **T5.10 Согласовать GPU queue cancellation с dispatch identity.** Queue clear должен
  удалять jobs отменённого dispatch, а не все job с похожим строковым prefix.
- [ ] **T5.11 После reset выставлять state через facade.** Не смешивать удаление lease
  и прямую запись asset state в route.

### Тесты

- [ ] Force dispatch без существующего lease не уменьшает quota.
- [ ] Reset сцены A не изменяет quota активной сцены B.
- [ ] Reset image не отменяет audio/video той же сцены без явного выбора.
- [ ] Cancelled dispatch освобождает lease/quota ровно один раз.
- [ ] Поздний callback cancelled dispatch отклоняется.
- [ ] Новый normal dispatch после reset успешно получает lease.
- [ ] Повторный reset идемпотентен.
- [ ] Prefix-похожая книга не теряет jobs при reset другой книги.

### Критерий приёмки

- [ ] В force/reset path нет release без подтверждённого ownership.
- [ ] Counter drift не возникает после серии reset/regenerate.
- [ ] Book-wide force flag удалён либо имеет документированное короткое scoped поведение.
- [ ] Queue cancellation использует структурированную identity.

### Рекомендуемые коммиты

1. `fix(dispatch): stop releasing unowned quota in force mode`
2. `refactor(orchestration): cancel active dispatches during reset`
3. `fix(scheduler): remove book-wide force dispatch`
4. `test(orchestration): isolate reset resource ownership`

---

## T6. Lease renewal и runtime loop

**Приоритет:** P1  
**Цель:** долгие задачи не дублируются, lock и ticks не остаются подвешенными.  
**Основные файлы:**

- `backend/src/runtime/lease-manager.js`
- `backend/src/runtime/dispatch-engine.js`
- `backend/src/runtime/runtime-scheduler.js`
- `backend/src/runtime/runtime-loop.js`
- `backend/src/config/runtime-config.js`

### Реализация

- [ ] **T6.1 Запускать `startDispatchRenewal()` только после `dispatched: true`.**
- [ ] **T6.2 Передавать точный lease key и token текущего dispatch.**
- [ ] **T6.3 Не запускать renewal для cache hit, backpressure, duplicate или empty executor.**
- [ ] **T6.4 Останавливать renewal из единого finalizer.** Покрыть success, failure,
  cancelled и dispatch rollback.
- [ ] **T6.5 Сделать stop идемпотентным.** Повторный callback или cleanup не должен
  оставлять timer либо выбрасывать ошибку.
- [ ] **T6.6 Логировать token mismatch без продления чужого lease.**
- [ ] **T6.7 Обернуть scheduler tick после lock acquire в `try/finally`.**
- [ ] **T6.8 Освобождать scheduler lock compare-and-delete в `finally`.**
- [ ] **T6.9 Сделать runtime loop неперекрывающимся.** Использовать последовательный
  `setTimeout` после завершения tick либо явный single-flight guard.
- [ ] **T6.10 Корректно остановить loop.** `stop()` не должен планировать следующий timeout
  после завершения текущего tick.
- [ ] **T6.11 Разделить tick errors по фазам.** Ошибка scheduler не должна выглядеть как
  успешный tick; метрики должны содержать error outcome.
- [ ] **T6.12 Оставить TTL страховкой.** Renewal не должен превращать lease в бессрочный;
  при потере owner или остановке backend lease обязан истечь.

### Тесты

- [ ] Принятый job запускает renewal.
- [ ] `dispatched: false` не запускает renewal.
- [ ] Fake timers подтверждают продление до завершения долгой задачи.
- [ ] Success останавливает renewal.
- [ ] Failure останавливает renewal.
- [ ] Cancelled останавливает renewal.
- [ ] Token mismatch не продлевает новый lease.
- [ ] Исключение внутри scheduler tick освобождает lock.
- [ ] Tick дольше interval не запускается параллельно.
- [ ] `stop()` во время tick предотвращает следующий запуск.

### Критерий приёмки

- [ ] В production есть вызов `startDispatchRenewal()` после принятого job.
- [ ] Все final outcomes проходят через один stop renewal.
- [ ] Scheduler lock освобождается через `finally`.
- [ ] Runtime tick не может выполняться параллельно сам с собой в одном процессе.

### Рекомендуемые коммиты

1. `fix(dispatch): renew leases for accepted gpu jobs`
2. `fix(scheduler): always release tick lock`
3. `refactor(runtime): prevent overlapping loop ticks`
4. `test(runtime): cover renewal and tick single flight`

---

## T7. Один reconciliation path

**Приоритет:** P1  
**Цель:** убрать параллельный legacy reconciliation и оставить один контролируемый цикл.  
**Основные файлы:**

- `backend/src/runtime/runtime-loop.js`
- `backend/src/runtime/reconciliation-engine.js`
- `backend/src/backend.cjs`
- `backend/src/services/startup-recovery.js`
- `backend/src/services/audio-recovery.cjs`
- `backend/src/services/cleanup-service.cjs`

### Реализация

- [ ] **T7.1 Удалить `reconcileAll()` из 5-секундного runtime tick.**
- [ ] **T7.2 Оставить в быстром tick scheduler и лёгкие metrics/counters.** Не выполнять
  полный filesystem/PG scan каждые 5 секунд.
- [ ] **T7.3 Запускать один periodic `reconcileCycle()`.** Использовать отдельный
  настраиваемый interval, например 60 секунд, и существующий distributed lock.
- [ ] **T7.4 Сделать periodic reconciliation неперекрывающимся.**
- [ ] **T7.5 Передавать в periodic cycle тот же набор dependencies, что и на startup.**
- [ ] **T7.6 Не запускать второй periodic cleanup из `cleanup-service.cjs`.**
- [ ] **T7.7 Проверить callers `startup-recovery.js`.** После подтверждения отсутствия
  production callers удалить deprecated wrapper либо оставить только startup adapter
  с явным назначением.
- [ ] **T7.8 Проверить callers `audio-recovery.cjs`.** Debug endpoint может вызывать
  scoped `reconcileCycle`, а не параллельную реализацию recovery.
- [ ] **T7.9 Удалить мёртвый failsafe lock cleanup.** Сначала подтвердить, что production
  audio path не создаёт `audio-scene-failsafe:*` и обычный lock имеет TTL.
- [ ] **T7.10 Получать реальный build id.** Orphan checks должны читать build из PG asset
  row или manifest.
- [ ] **T7.11 Не подменять неизвестный build значением `default`.** Возвращать
  `unknown_build` и не выполнять destructive autofix.
- [ ] **T7.12 Разделить observation и autofix.** Safe fix остаётся явно перечисленным;
  неизвестные состояния только журналируются.
- [ ] **T7.13 Обновить runtime metrics.** Метрики должны отдельно показывать быстрый tick
  и последний полный reconciliation cycle.

### Тесты

- [ ] Runtime tick не вызывает `reconcileAll()`.
- [ ] Periodic path вызывает только `reconcileCycle()`.
- [ ] Два periodic запуска не выполняются одновременно.
- [ ] Startup cycle и periodic cycle используют один lock.
- [ ] Неизвестный build не проверяется в каталоге `default`.
- [ ] Известный build проверяет правильный artifact path.
- [ ] Dead failsafe phase удалена без изменения обычного lock TTL поведения.
- [ ] Scoped debug recovery не запускает второй глобальный цикл.

### Критерий приёмки

- [ ] В production существует ровно один periodic full reconciliation entrypoint.
- [ ] `reconcileAll()` является внутренней фазой `reconcileCycle`, а не отдельным loop.
- [ ] Runtime tick не выполняет тяжёлый полный scan каждые 5 секунд.
- [ ] Reconciliation не делает destructive fix при неизвестном build.

### Рекомендуемые коммиты

1. `refactor(runtime): separate scheduler and reconciliation cadence`
2. `fix(reconciliation): resolve actual artifact build id`
3. `refactor(recovery): remove duplicate recovery entrypoints`
4. `refactor(reconciliation): remove unused failsafe cleanup`

---

## T8. State ownership и active-scenes

**Приоритет:** P2  
**Цель:** оставить один API transitions и один API active-scenes без новой state machine.  
**Основные файлы:**

- `backend/src/orchestration/orchestrator.js`
- `backend/src/orchestration/scene-orchestrator.js`
- `backend/src/orchestration/scene-restoration.js`
- `backend/src/state/scene-state.js`
- `backend/src/runtime/active-scenes-index.js`
- `backend/src/runtime/runtime-scheduler.js`
- `backend/src/runtime/reconciliation-engine.js`
- `backend/src/runtime/runtime-persistence.js`
- `backend/src/services/book-diff.cjs`
- `backend/src/services/startup-recovery.js`
- `backend/src/routes/debug-routes.cjs`

### Целевые команды facade

Не расширять facade десятками методов. Достаточны команды уровня lifecycle:

```text
markPending
markGenerating
complete
fail
markDirty
reset
restoreUnsafe
```

### Реализация asset state

- [ ] **T8.1 Составить актуальную карту production writers.** Использовать `rg` для
  `setAssetState` и `setAssetStates`, разделить lifecycle, restore, debug и tests.
- [ ] **T8.2 Валидировать asset name.** Runtime setter не принимает неизвестный asset.
- [ ] **T8.3 Валидировать status.** Runtime setter не принимает произвольную строку.
- [ ] **T8.4 Валидировать transition.** Lifecycle command использует
  `validateAssetTransition()` до записи.
- [ ] **T8.5 Перевести `scene-orchestrator` на facade.** Убрать прямые `GENERATING`
  writes для image/video.
- [ ] **T8.6 Перевести scheduler version-stale writes на `markDirty`.**
- [ ] **T8.7 Перевести reconciliation safe fixes на facade.**
- [ ] **T8.8 Перевести `book-diff` runtime transitions на facade.**
- [ ] **T8.9 Отделить restore API.** Прямой restore должен называться явно, например
  `unsafeRestoreAssetState`, и использоваться только snapshot/disk recovery.
- [ ] **T8.10 Отделить debug API.** Debug route не должен случайно использовать
  production lifecycle setter без явного unsafe intent и validation входа.
- [ ] **T8.11 Ограничить raw setters.** Не экспортировать их через общий production index,
  если restore/debug могут импортировать узкий internal module.
- [ ] **T8.12 Не добавлять новый state framework.** Текущих enum, validator и facade
  достаточно.

### Реализация active-scenes

- [ ] **T8.13 Оставить `active-scenes-index.js` единственным command API.**
- [ ] **T8.14 Удалить дубли `addSceneToActiveIndex` и `removeSceneFromActiveIndex` из
  `runtime-scheduler.js`.**
- [ ] **T8.15 Перевести orchestration, scheduler и reconciliation на
  `active-scenes-index.js`.**
- [ ] **T8.16 Оставить прямой `SCARD` только для read-only metrics, если это действительно
  проще и не дублирует parsing/transition logic.
- [ ] **T8.17 Перевести cleanup helpers на active-scenes API.**
- [ ] **T8.18 Зафиксировать формат scene key в одном модуле.**

### Тесты

- [ ] Неизвестный asset отклоняется.
- [ ] Неизвестный status отклоняется.
- [ ] Невалидный transition не записывается.
- [ ] Валидные lifecycle commands сохраняют текущее поведение.
- [ ] Restore API может восстановить snapshot с явно разрешённым unsafe path.
- [ ] Production modules не импортируют raw setters.
- [ ] Все add/remove active scene используют один API.
- [ ] Parsing active scene key одинаков для scheduler и reconciliation.

### Критерий приёмки

- [ ] `rg` не находит production state writes вне facade и явно названного restore/debug API.
- [ ] `runtime-scheduler.js` не владеет вторым active-scenes API.
- [ ] Валидация transition стала обязательной для runtime commands.
- [ ] Количество facade commands осталось небольшим и соответствует lifecycle.

### Рекомендуемые коммиты

1. `refactor(state): validate orchestration lifecycle transitions`
2. `refactor(orchestration): route production state writes through facade`
3. `refactor(state): isolate unsafe restore writes`
4. `refactor(runtime): consolidate active scenes index`

---

## T9. GPU Hub contract, auth и queue cleanup

**Приоритет:** P2  
**Цель:** закончить текущий HTTP/Redis contract без замены GPU Hub.  
**Основные файлы:**

- `.env.example`
- `docker-compose.yml`
- backend config и HTTP callers GPU Hub
- `backend/src/runtime/gpu-dispatcher.js`
- `backend/src/orchestration/orchestrator.js`
- `backend/src/routes/book/generation-routes.cjs`
- `gpu-hub/gpu-hub.js`

### Реализация auth

- [ ] **T9.1 Выбрать одно имя секрета: `GPU_HUB_API_KEY`.**
- [ ] **T9.2 Добавить placeholder в `.env.example`.**
- [ ] **T9.3 Передать key в backend container.**
- [ ] **T9.4 Передать тот же key в GPU Hub container.**
- [ ] **T9.5 Заменить внутреннее `API_KEY` env чтение GPU Hub на
  `GPU_HUB_API_KEY` либо сделать явный короткий migration.**
- [ ] **T9.6 Добавить `x-api-key` во все backend requests к защищённым GPU Hub routes.**
- [ ] **T9.7 Найти все `/queue/clear` callers и перевести их одновременно.**
- [ ] **T9.8 Не передавать key в query string.** Использовать только header и не логировать
  значение.
- [ ] **T9.9 При заданном key fail closed.** Неверный или отсутствующий header возвращает
  401/403 и не изменяет очередь.

### Реализация queue ownership

- [ ] **T9.10 Добавить структурированные ownership fields в queue record.** Минимум:
  `book_id`, `chapter_id`, `scene_id`, `stage`, `dispatch_id`.
- [ ] **T9.11 Не извлекать `book_id` через `job_id.startsWith()`.**
- [ ] **T9.12 Фильтровать queued jobs по точному `book_id` или `dispatch_id`.**
- [ ] **T9.13 Фильтровать running jobs по тем же structured fields.**
- [ ] **T9.14 Исправить cleanup result keys.** Учитывать реальный формат
  `animastor:result:<buildId>:<bookId>:...`.
- [ ] **T9.15 Использовать SCAN вместо KEYS для result cleanup.**
- [ ] **T9.16 Не удалять result другого build или похожего book id.**
- [ ] **T9.17 Возвращать structured cleanup summary.** Количество удалённых queued,
  running, result и dedup records.
- [ ] **T9.18 Согласовать cancellation с T5.** Предпочтительно удалять по `dispatch_id`;
  очистка всей книги остаётся явной administrative operation.

### Тесты

- [ ] Queue clear без key отклоняется при включённой auth.
- [ ] Queue clear с неверным key отклоняется.
- [ ] Queue clear с правильным key выполняется.
- [ ] Backend отправляет key header.
- [ ] Book `abc` cleanup не удаляет book `abc2`.
- [ ] Dispatch cleanup не удаляет другой dispatch той же сцены.
- [ ] Result key текущего build удаляется.
- [ ] Result key другого build остаётся.
- [ ] Cleanup summary соответствует фактически удалённым records.

### Критерий приёмки

- [ ] Compose не запускает открытый administrative `/queue/clear`.
- [ ] Backend и GPU Hub используют одно имя env.
- [ ] Ownership queue records является структурированным.
- [ ] Prefix collision и неверный result pattern покрыты regression tests.

### Рекомендуемые коммиты

1. `chore(gpu-hub): configure shared api key`
2. `fix(backend): authenticate gpu hub administrative calls`
3. `refactor(gpu-hub): store structured queue ownership`
4. `fix(gpu-hub): clear exact dispatch and result records`

---

## T10. Финальная проверка и полировка

**Приоритет:** release gate  
**Цель:** доказать, что локальный контур и удалённый worker работают по одному контракту.  
**Зависит от:** T0-T9.

### Статические проверки

- [ ] Выполнить syntax-smoke для всех production JS/CJS.
- [ ] Выполнить `git diff --check`.
- [ ] Проверить отсутствие legacy finalizer callers:

```bash
rg -n "markDispatchCompleted|markDispatchFailed" backend/src
```

- [ ] Проверить единственный periodic reconciliation entrypoint:

```bash
rg -n "reconcileAll|reconcileCycle" backend/src
```

- [ ] Проверить production state writers:

```bash
rg -n "setAssetState\(|setAssetStates\(" backend/src
```

- [ ] Проверить active-scenes writers:

```bash
rg -n "sadd\(.*active-scenes|srem\(.*active-scenes|addSceneToActiveIndex|removeSceneFromActiveIndex" backend/src
```

### Локальные тесты

- [ ] `cd backend && npm test`.
- [ ] Callback validation regression suite.
- [ ] Dispatch finalization regression suite.
- [ ] Executor result regression suite.
- [ ] Dispatch identity roundtrip suite.
- [ ] Force reset/quota ownership suite.
- [ ] Lease renewal fake-timer suite.
- [ ] Runtime lock/single-flight suite.
- [ ] Reconciliation cadence suite.
- [ ] GPU Hub auth/queue cleanup suite.

### Локальный integration smoke

- [ ] Backend enqueue создаёт queue record с полной identity.
- [ ] GPU Hub выдаёт task совместимому test worker.
- [ ] Result проходит identity check и завершает stage как success.
- [ ] Error проходит identity check и завершает stage как failure.
- [ ] Retry budget уменьшается после failure.
- [ ] Quota и lease возвращаются к исходному значению после обоих outcomes.

### Удалённый GPU smoke

Перед запуском записать:

```text
worker_id:
worker_version:
worker_protocol_version:
gpu_hub_version:
backend_version:
started_at:
```

- [ ] Удалённый worker виден в beacon с ожидаемой версией.
- [ ] Отправить одну небольшую реальную задачу.
- [ ] Проверить одинаковый `dispatch_id` в backend, GPU Hub и worker логах.
- [ ] Проверить success callback и готовый artifact.
- [ ] Отправить контролируемую ошибочную задачу.
- [ ] Проверить failure callback, `recordFailure` и расход retry budget.
- [ ] Проверить, что worker error не записан как `DISPATCH_COMPLETED`.
- [ ] Проверить отсутствие оставшегося lease и quota drift.

### Обязательные race/long-running сценарии

- [ ] **Stale callback:** dispatch A отменён, создан dispatch B, callback A отклонён,
  callback B принят.
- [ ] **Duplicate callback:** повтор result одного dispatch не повторяет release.
- [ ] **Result/error race:** принимается только первый final outcome.
- [ ] **Force reset isolation:** reset одной сцены не влияет на другую.
- [ ] **Long lease:** задача работает дольше базового lease TTL без duplicate dispatch.
- [ ] **Backend tick delay:** tick дольше interval не создаёт второй параллельный tick.
- [ ] **Reconcile delay:** полный cycle не запускается повторно до завершения первого.
- [ ] **GPU Hub auth:** administrative cleanup без key не выполняется.
- [ ] **Prefix collision:** очистка книги не затрагивает похожий book id.

### Наблюдаемость

- [ ] Логи enqueue/result/error/finalization содержат `dispatch_id`, `job_id`, stage и
  worker id.
- [ ] Логи не содержат API keys или полный base64 payload.
- [ ] Метрики различают success, failure, cancelled и stale callback.
- [ ] Есть счётчик rejected stale callbacks.
- [ ] Есть видимое расхождение active counter и active leases.
- [ ] Версия удалённого worker доступна без SSH-разбора файлов.

### Документация

- [ ] Добавить в старые orchestration audit/TODO документы заметную ссылку на
  `ORCHESTRATION_STABILIZATION_AUDIT.md` и этот TODO как актуальный baseline.
- [ ] Не переписывать историю старых документов и не менять их выполненные пункты задним
  числом.
- [ ] Обновить lifecycle/system map только после фактического завершения T0-T9.
- [ ] Зафиксировать production rollout order backend -> GPU Hub -> worker или иной
  проверенный порядок с compatibility window.
- [ ] Зафиксировать rollback: какой protocol version и worker image возвращаются при
  проблеме.

### Финальный критерий готовности

- [ ] Все production JS/CJS проходят syntax check.
- [ ] Backend unit/integration suite проходит полностью.
- [ ] Удалённый worker имеет подтверждённую версию и protocol compatibility.
- [ ] Любой dispatch имеет identity и один final outcome.
- [ ] Failure не записывается как success.
- [ ] Retry budget реально ограничивает повторы.
- [ ] Stale callback не пишет artifact и не завершает новый dispatch.
- [ ] Force reset не создаёт quota drift.
- [ ] Долгая задача не получает duplicate dispatch из-за истечения lease.
- [ ] Runtime использует один periodic reconciliation path.
- [ ] Production state writes проходят через facade.
- [ ] GPU Hub administrative routes защищены.
- [ ] После idle active counters равны числу активных leases и возвращаются к нулю.

---

## 5. Матрица обязательных regression tests

| Сценарий | Ожидаемый asset state | Outcome | Quota/lease | Budget |
|---|---|---|---|---|
| Валидный result | `READY` | `success` | освобождены один раз | без изменения |
| Невалидный artifact | не `READY` | `failure` | освобождены один раз | уменьшен один раз |
| Worker error | `FAILED`/`PENDING` по policy | `failure` | освобождены один раз | уменьшен один раз |
| Worker timeout | `FAILED`/`PENDING` по policy | `failure` | освобождены один раз | уменьшен один раз |
| Cache hit | `READY` | completion без GPU job | не удерживаются | без изменения |
| Executor без job | не ложный `GENERATING` | rollback/cancelled | освобождены | без изменения |
| Force reset | `DIRTY`/`PENDING` по reset | `cancelled` | только свои | без изменения |
| Duplicate result | без повторного transition | already finalized | без повторного release | без изменения |
| Stale result | без изменения нового dispatch | rejected | ресурсы нового сохранены | без изменения |
| Stale error | без изменения нового dispatch | rejected | ресурсы нового сохранены | без изменения |
| Result/error race | итог первого принятого callback | один итог | один release | максимум один failure consume |
| Long-running job | `GENERATING` до callback | active | lease продлевается | без изменения |

---

## 6. Что считать блокером

Следующий этап не начинать, если:

- T0: worker всё ещё не проходит syntax-smoke;
- T1: handler может вернуть неявный результат и facade всё равно пишет `READY`;
- T2: failure всё ещё вызывает success finalization;
- T3: любой executor может вернуть `dispatched: true` при нуле принятых jobs;
- T4: удалённый worker не возвращает `dispatch_id`;
- T5: reset может декрементировать quota без ownership;
- T6: renewal не стартует или runtime ticks перекрываются;
- T7: `reconcileAll()` продолжает выполняться параллельно `reconcileCycle()`;
- T8: raw setters остаются обычным production API без явного назначения;
- T9: включение GPU Hub auth ломает backend cleanup callers;
- T10: неизвестна версия worker, на котором выполнен smoke.

---

## 7. Итоговая последовательность rollout

1. Исправить и статически проверить worker.
2. Исправить callback result и единый finalization локально.
3. Сделать executors честными и закрыть unit tests.
4. Добавить `dispatch_id` в backend и GPU Hub с переходной поддержкой.
5. Развернуть совместимый worker на удалённом GPU сервере.
6. Подтвердить worker/protocol version через beacon.
7. Выполнить result/error smoke и включить строгую identity validation.
8. Исправить reset, renewal и runtime loops.
9. Удалить дубли reconciliation/state/active-scenes.
10. Включить GPU Hub auth и проверить administrative operations.
11. Выполнить полный T10 gate.
12. Только после успешного gate обновить старые документы как исторические.

План завершён, когда система стала предсказуемой на текущих компонентах. Наличие новых
слоёв, сервисов или абстракций само по себе не является результатом этого TODO.
