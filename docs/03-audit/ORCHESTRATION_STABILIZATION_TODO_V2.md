# TODO: стабилизация системы оркестрации

> **Дата:** 19 июля 2026
> **Основание:** `docs/03-audit/ORCHESTRATION_SYSTEM_AUDIT.md`
> **Опирается на:** `docs/02-orchestration/ORCHESTRATOR_ARCHITECTURE_WITH_AUDIO.md`,
> `docs/03-audit/CAPACITY_AND_COMPLEXITY.md`
> **Цель:** не усложнять систему, а сделать стабильной.
> **Принцип:** сначала удалить лишнее, потом полировать. Никаких новых подсистем.

---

## Ограничения (жёсткие)

В рамках этого TODO НЕ делать:

- Kafka, RabbitMQ, BullMQ, другой брокер.
- Workflow engine и второй state-machine поверх asset FSM.
- Перенос lifecycle в PostgreSQL одним PR.
- Rewrite audio/image/video pipeline до S1.
- Новый reconciliation service рядом с существующим.
- Расширение facade десятками методов (текущих 13 команд достаточно).
- Cluster Node.js, S3, CDN — вне scope стабилизации.

Предпочтение:

- один дефект или один контракт на коммит;
- тесты добавляются в том же коммите, что и исправление;
- после каждого этапа `pretest` (syntax-smoke) и `npm test` проходят полностью;
- один логический файл на PR, минимальный diff.

---

## Канонический инвариант (проверять на каждом этапе)

```
audio-orch.phase == DONE   ⇔   asset.audio == READY
audio-orch.phase == FAILED ⇒   asset.audio ∈ {FAILED, PENDING}
audio-orch.phase ∈ {WAITING_CHUNKS, MERGING, GENERATING}
                            ⇒   asset.audio == GENERATING
```

После каждого этапа инвариант должен сохраняться (проверять через
`reconciliation-engine.checkAudioOrchInvariants`).

---

## Этап S1 — Удалить dead-code resilience модули (−580 строк)

**Приоритет:** P1
**Цель:** убрать модули, не входящие в инварианты фасада из
`ORCHESTRATOR_ARCHITECTURE_WITH_AUDIO.md`, и dead reconciliation фазы.

### S1.1 Удалить `fairness-engine.js`

- [ ] Проверить фактические вызовы: `rg "require\('\./fairness-engine'\)" backend/src`.
- [ ] Убрать импорт из `runtime-persistence.js:12`.
- [ ] Убрать экспорт из `runtime/index.js` (если есть).
- [ ] Удалить файл `backend/src/runtime/fairness-engine.js` (605 строк).
- [ ] Удалить тест `fairness-engine.test.js`, если он есть и не запускается.
- [ ] Exact команда проверки: `cd backend && npm test` проходит, упоминаний fairness
      в `backend/src` нет.

### S1.2 Сократить `failure-taxonomy.js` до классификатора (~50 строк)

- [ ] Оставить только функцию-классификатор: `transient | worker | invalid | protocol`.
- [ ] Убрать pattern-matching на 250 строк (он не используется существенными ветками).
- [ ] Проверить callers: `retry-manager.js:7`, `orchestrator.js:280` (lazy-require),
      `runtime/index.js:65`.
- [ ] Сохранить контракт `failureType` → `consumeRetryBudget(redis, …, failureType, …)`.
- [ ] Покрыть классификатор unit-тестом на 4 типа + fallback `transient`.

### S1.3 Сократить `retry-budget-manager.js`

- [ ] Оставить ТОЛЬКО `consumeRetryBudget` (используется в
      `dispatch-engine.js:837` в `finalizeDispatch('failure')`).
- [ ] Убрать `refillBudgets` (не работает с wildcard-ключами — см.
      `ORCHESTRATION_FULL_AUDIT.md` Б6).
- [ ] Убрать сложные политики refill и приоритета — у нас один пользователь с одной книгой,
      не SaaS.
- [ ] Оставшийся бюджет: per-`(bookId, chapterId, sceneId, stage)` INCR + TTL.
- [ ] Цель: ~150 строк вместо 520.
- [ ] Тест: failure расходует budget ровно 1×; повторный failure не расходует повторно.

> ⚠️ Внимание: `CAPACITY_AND_COMPLEXITY.md` §5.2 предлагает «выкинуть retry-budget-manager
> целиком». Это НЕВЕРНО для текущего кода — `consumeRetryBudget` зашит в production
> finalization (T2). Полное удаление сломает защиту от бесконечного retry-цикла.
> Сокращаем, не удаляем.

### S1.4 Удалить dead reconciliation phases C3/C5

- [ ] Удалить Phase C3 (`iu_scan`, log-only) из `reconciliation-engine.js:1176-1183`.
- [ ] Удалить Phase C5 (`session_resume`, недостижима — deps не передаются из
      `backend.cjs`) из `reconciliation-engine.js:1194-1203`.
- [ ] Проверить Phase C4 (`counter_reconcile`): если deps PG не передаются, тоже удалить;
      иначе оставить и убедиться, что deps прокидываются.
- [ ] Оставить Phase A + B1 + C0/C1/C2 + D (audio-orch invariants check).
- [ ] Тест: reconcileCycle ещё работает, INCR `reconcileCycle` counter в метриках.

### S1.5 Проверить cleanup-service/AU-X legacy

- [ ] Проверить `audio-recovery.cjs` и `cleanup-service.cjs` на мёртвые API, которые
      дублируют `reconcileCycle`.
- [ ] Удалить окончательно то, что закрыто `reconciliation-engine.reconcileCycle` (T7).
- [ ] Проверить call sites через `rg "reconcileAll" backend/src`.

### Критерий приёмки S1

- [ ] `wc -l` пяти модулей показывает суммарное уменьшение ≥ 400 строк.
- [ ] `npm test` проходит (>= 570 passing).
- [ ] `pretest` syntax-smoke проходит.
- [ ] Инвариант `audio-orch.phase == DONE ⇔ asset.audio == READY` подтверждён существующими
      тестами `audio-orchestrator.test.js`.
- [ ] Нет упоминаний `fairness` в `backend/src`.

### Рекомендуемые коммиты

1. `refactor(runtime): remove fairness-engine (unused in production path)`
2. `refactor(runtime): shrink failure-taxonomy to classifier function`
3. `refactor(runtime): simplify retry-budget-manager to consume-only`
4. `refactor(reconciliation): remove dead phases C3/C5`

---

## Этап S2 — Упростить restore/debug state writes (40 строк)

**Приоритет:** P2
**Цель:** выполнить инвариант из `ORCHESTRATOR_ARCHITECTURE_WITH_AUDIO.md` §5 —
«модули НЕ пишут состояние напрямую, только через фасад». Текущие нарушения — это
восстановительные writes, а не lifecycle; нужно их явно пометить.

### S2.1 Переименовать raw state setters в unsafe*

- [ ] В `backend/src/state/scene-state.js` переименовать:
      - `setAssetState` → `unsafeRestoreAssetState`
      - `setAssetStates` → `unsafeRestoreAssetStateBulk`
- [ ] Оставить старые имена как тонкие deprecated-обёртки только на один переходный
      коммит, потом удалить.
- [ ] Обновить JSDoc: «use ONLY for restore from disk snapshot, NOT for lifecycle
      transitions. Lifecycle writes go through orchestrator facade.»

### S2.2 Изолировать writes внутри фасада

- [ ] В `orchestrator.js` текущие 11 вызовов `state.setAssetState` заменить на
      приватные `facade._writeAssetState` (метод модуля, не экспортируется).
- [ ] Приватный метод под капотом зовёт `state.validateAssetTransition` и потом пишет
      через `unsafeRestoreAssetState` (он же raw setter).
- [ ] Цель: из внешних модулей raw setter недоступен, lifecycle идёт только через
      `setSceneGenerating / completeStage / failStage / markDirtyScene / …`.

### S2.3 Перевести restore/debug callers на `unsafe*`

- [ ] `scene-restoration.js:87` → `await state.unsafeRestoreAssetState(..., 'audio', READY)`.
- [ ] `startup-recovery.js:323-345` → аналогично для двух restore writes.
- [ ] `debug-routes.cjs` — если есть debug writes, тоже через `unsafe*` с явным логом.
- [ ] `runtime-persistence.js:592` (`setAssetStates` для snapshot restore) — аналогично.

### S2.4 Lint-соглашение

- [ ] Добавить `eslint` rule (или просто README-нотис в `scene-state.js`):
      production modules MUST NOT use `unsafeRestoreAssetState` — only `orchestrator.*`.
- [ ] Проверка одним grep-скриптом: `rg "unsafeRestoreAssetState" backend/src` — должно
      найти только `scene-restoration.js`, `startup-recovery.js`, `runtime-persistence.js`,
      `debug-routes.cjs`, `orchestrator.js` (внутри facade). Эти файлы — явный белый список.

### Критерий приёмки S2

- [ ] `rg "state\.setAssetState" backend/src` (старое имя) — 0 совпадений.
- [ ] `rg "unsafeRestoreAssetState" backend/src` — только в whitelist файлов.
- [ ] `npm test` проходит.
- [ ] Инвариант `audio-orch.phase == DONE ⇔ asset.audio == READY` подтверждён.

### Рекомендуемые коммиты

1. `refactor(state): rename setAssetState → unsafeRestoreAssetState`
2. `refactor(orchestration): route facade writes through private _writeAssetState`
3. `refactor(restore): switch restore callers to unsafe API`
4. `chore(state): document unsafe-vs-lifecycle split`

---

## Этап S3 — Production-readiness полировка (+50 строк)

**Приоритет:** P2
**Цель:** закрыть оставшиеся пробелы из `CAPACITY_AND_COMPLEXITY.md` §5.3 без новых
подсистем. Только graceful shutdown + health endpoint + единый конфиг timeout'ов.

### S3.1 Graceful shutdown в `backend.cjs`

- [ ] Добавить `process.on('SIGTERM', gracefulShutdown)` и `process.on('SIGINT', …)`.
- [ ] `gracefulShutdown()`:
      1. `runtime.loop.stop()` (есть, корректно останавливает timer'ы).
      2. Для всех активныхleases (читать `animastor:dispatch-lease:*`) вызвать
         `cancelActiveDispatch(...)` с outcome `cancelled`.
      3. Закрыть Redis-соединение.
      4. Закрыть PG-пул.
      5. `process.exit(0)` с таймаутом 5s.
- [ ] Тест: SIGTERM во время активного dispatch'а → lease освобождён, квота возвращена.

### S3.2 Endpoint `/health`

- [ ] Добавить route `GET /health` в `backend.cjs`:
      ```js
      { status: 'ok' | 'degraded', loop: isRunning, redis: 'PONG' | 'DOWN', ts: Date.now() }
      ```
- [ ] Status 503 если `loop.isRunning() === false` ИЛИ redis не отвечает.
- [ ] Status 200 otherwise.
- [ ] Без auth (health endpoint публичный).

### S3.3 Endpoint `/readiness` (опционально)

- [ ] Аналогично `/health`, но дополнительно проверяет PG.
- [ ] Используется для docker `healthcheck` / k8s readiness probe.

### S3.4 Конфигурация GPU_TIMEOUT

- [ ] Перенести `GPU_TIMEOUT` из `gpu-hub.js:17` (hardcoded `10 min`) в
      `backend/src/config/runtime-config.js` рядом с `LEASE_TTL`.
- [ ] Прокинуть через `docker-compose.yml` как env-переменную.
- [ ] Добавить в `.env.example` placeholder с дефолтным значением.

### S3.5 Задать `GPU_HUB_API_KEY` для прод-deploy

- [ ] Обновить `.env` (production) — задать непустое значение `GPU_HUB_API_KEY`.
- [ ] Убедиться, что в `docker-compose.yml` `gpu-hub` и `backend` секции используют
      один и тот же ключ (уже сделано в T9, проверить).
- [ ] Smoke test: после рестарта с заданным ключом `/queue/clear` отдаёт 401 без
      `x-api-key` header'а.

### Критерий приёмки S3

- [ ] `npm test` покрывает SIGTERM-сценарий (fake timers).
- [ ] `curl http://localhost:3000/health` отдаёт 200 в штатном режиме.
- [ ] `curl /health` отдаёт 503 когда redis упал (.fake test).
- [ ] `pretest` + `npm test` проходят.
- [ ] `grep "GPU_TIMEOUT" gpu-hub/gpu-hub.js` — ссылка на env, не hardcoded number.

### Рекомендуемые коммиты

1. `feat(server): graceful shutdown on SIGTERM/SIGINT`
2. `feat(server): add /health endpoint`
3. `refactor(config): externalize GPU_TIMEOUT to runtime-config`
4. `chore(env): enforce GPU_HUB_API_KEY in production .env`

---

## Этап S4 — Фикс тест-моков и полировка регрессий (5 строк)

**Приоритет:** P3
**Цель:** убрать предупреждения `audioOrch.initPlaceholderReady is not a function`,
которые появляются в `npm test` логах.

### S4.1 Mock audioOrch

- [ ] Найти mock audioOrch в `backend/tests/mocks/`.
- [ ] Добавить stub `initPlaceholderReady: async () => ({ ok: true })`.
- [ ] Аналогично проверить, что все функции, вызываемые в `scene-window.js:760` и
      `scene-orchestrator.js:65`, есть в mock'е.
- [ ] Запустить `npm test` — предупреждений `audioOrch.* is not a function` нет.

### S4.2 Очистить пустые тест-файлы

- [ ] Проверить `backend/tests/coreference-cleanup.test.js` (раньше был пустой).
- [ ] Удалить или наполнить реальными тестами.

### Критерий приёмки S4

- [ ] `npm test 2>&1 | grep "is not a function"` → 0 совпадений.
- [ ] Все `.test.js` файлы содержат хотя бы один `it()`/`test()`.

### Рекомендуемые коммиты

1. `test(mocks): add initPlaceholderReady stub to audioOrch mock`
2. `chore(tests): remove empty test files`

---

## Глобальный Definition of Done

Каждый этап считается завершённым только если:

- [ ] `cd backend && npm test` проходит (≥ 570 passing).
- [ ] `pretest` (syntax-smoke) проходит для всех production `.js/.cjs` в
      `backend/src`, `gpu-hub`, `worker`.
- [ ] `git diff --check` не находит whitespace-ошибок.
- [ ] Инвариант `audio-orch.phase == DONE ⇔ asset.audio == READY` подтверждён
      существующими тестами.
- [ ] Нет новых модулей / подсистем / брокеров — только удаление и упрощение.
- [ ] Журнал событий (`event-journal.js`) для затронутых команд не теряет типы.
- [ ] Каждый коммит содержит regression test на исправленный дефект.

---

## Порядок выполнения

| Этап | Зависимости | Приоритет | Эффект |
|---|---|---|---|
| S1 | — | P1 | −580 строк, упрощение resilience |
| S2 | S1 | P2 | 40 строк refactor, 1 state owner |
| S3 | S2 | P2 | +50 строк readiness |
| S4 | — | P3 | чистые тесты |

S1 можно делать параллельно с S4 (они не пересекаются). S2 и S3 — последовательно
после S1. S4 можно выполнить в любой момент.

---

## Критерий финальной готовности системы

Система считается стабильной, когда одновременно:

1. ✅ Все production JS/CJS проходят syntax-smoke (в `pretest`).
2. ✅ `npm test` > 570 passing без warning'ов про missing mock functions.
3. ✅ `completeStage` NEVER пишет `READY` без `handler.ok` (T2 closed).
4. ✅ `failStage` NEVER пишет `recordSuccess` (T2 closed).
5. ✅ `executor` NEVER `dispatched:true` без реального job (T3 closed).
6. ✅ Renewal стартует только после `dispatched:true` (T6 closed).
7. ✅ Runtime-loop НЕ гоняет полный `reconcileAll` каждые 5s (T7 closed).
8. ✅ `active-scenes` — один API (T8 closed).
9. ✅ Прямые asset-state writes только через `unsafe*` методы (S2 closed).
10. ✅ `fairness-engine` удалён; `failure-taxonomy`/`retry-budget` сокращены (S1 closed).
11. ✅ Reconciliation C3/C5 удалены, C4 либо работает, либо удалён (S1 closed).
12. ✅ `GPU_HUB_API_KEY` задан в прод-`.env` (S3 closed).
13. ✅ Backend корректно shutdown'ится по `SIGTERM` + `/health` отдаёт 200 (S3 closed).

После этого — никаких новых подсистем. Никаких RabbitMQ, S3, cluster, workflow engine.
Стабилизация завершается удалением неоднозначности, а не добавлением новых слоёв.

---

## Ссылки

- `docs/03-audit/ORCHESTRATION_SYSTEM_AUDIT.md` — аудит, на котором основан этот TODO.
- `docs/02-orchestration/ORCHESTRATOR_ARCHITECTURE_WITH_AUDIO.md` — целевой фасад и
  инварианты.
- `docs/03-audit/CAPACITY_AND_COMPLEXITY.md` — ёмкость и список кандидатов на удаление.
- `docs/03-audit/ORCHESTRATION_STABILIZATION_TODO.md` — предыдущий TODO (T0–T10,
  завершён).

<!-- === Footer === -->
---
*Сгенерировано 19 июля 2026 на основе аудита `ORCHESTRATION_SYSTEM_AUDIT.md`.
Цель: упростить и стабилизировать, не усложняя.*
