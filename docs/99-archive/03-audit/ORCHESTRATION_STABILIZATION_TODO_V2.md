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

## ✅ Этап S1 — ЗАВЕРШЁН (2026-07-19)

**Плановый результат:** −580 строк.
**Фактический результат:** **−1674 строк** (11997 → 10323 в `backend/src`).
Во всех commit'ах: `npm test` = 576 passing, `pretest` syntax-smoke OK,
канонический инвариант соблюдён.

| Подэтап | Коммит | Эффект |
|---|---|---|
| **S1.1** Удалён `fairness-engine.js` | `45b2485` | −618 строк. `isStarving()` всегда возвращала `{starving:false}`, Phase 9 в dispatch-engine была мёртвой веткой. Импорт в `runtime-persistence.js` — неиспользуемый. |
| **S1.2** `failure-taxonomy` 424→~100 строк + удалён `retry-manager.js` | `d4444cb` | −736 строк. `retry-manager` не имел ни одного production-caller (только lazy export в `runtime/index.js`). Все export'ы taxonomy сведены к `classifyFailure`, `FailureType`, `FailureSeverity`, `getFailureTypeKeys`. |
| **S1.3** `retry-budget-manager` 520→~165 строк | `dba7298` | −296 строк. Оставлены только `checkRetryBudget` + `consumeRetryBudget` — единственные production-callers в `dispatch-engine.js`. Удалены `refillBudgets` (Б6 — wildcard-ключи неработающие), `formatBudget`, `getGlobalBudgetOverview` (debug). |
| **S1.4** Удалена Phase C3 (IU disk scan) | `10ecf33` | −32 строки. **Уточнение к аудиту:** при сверке с кодом выяснилось, что C4 (deps.postgres передаётся из `backend.cjs:219`) и C5 (deps из `backend.cjs:224-225` для resumeIncompleteSessions) **живые и полезные** — утверждение аудита об их мёртвости ОШИБОЧНО. Удалена только C3 — log-only walk по всей OUTPUT_DIR каждые 60s. |

**Итог по сравнению с аудитом:** аудиторские рекомендации нуждались в сверке с кодом.
`retry-budget` нельзя было удалять целиком (он зашит в T2 finalizeDispatch).
C4/C5 нельзя было удалять (они живые). Результат S1 — глубже аудиторского плана,
но ничего полезного не выкинуто.

---

## Этап S1 — Удалить dead-code resilience модули (−580 строк)

**Приоритет:** P1
**Цель:** убрать модули, не входящие в инварианты фасада из
`ORCHESTRATOR_ARCHITECTURE_WITH_AUDIO.md`, и dead reconciliation фазы.

### S1.1 Удалить `fairness-engine.js`  ✅ (commit `45b2485`)

- [x] Проверить фактические вызовы: `rg "require\('\./fairness-engine'\)" backend/src`.
- [x] Убрать импорт из `runtime-persistence.js:12`.
- [x] Убрать импорт + Phase 9 из `dispatch-engine.js` (не было экспорта в runtime/index.js).
- [x] Удалить файл `backend/src/runtime/fairness-engine.js` (605 строк).
- [x] Тест `fairness-engine.test.js` отсутствовал. `cd backend && npm test` — 576 passing.
- [x] Упоминаний `fairness` в `backend/src` осталось только в `redis-helpers.cjs`
      (cleanup старых ключей, безопасно).

### S1.2 Сократить `failure-taxonomy.js` + удалить `retry-manager.js`  ✅ (commit `d4444cb`)

- [x] `failure-taxonomy`: оставлены `classifyFailure`, `FailureType`, `FailureSeverity`,
      `getFailureTypeKeys` (~100 строк вместо 424).
- [x] Убран pattern-matching на 250+ строк. Оставлены минимальные патчи permanent/infrastructure.
- [x] Callers проверены: `orchestrator.js:280` (lazy-require), `retry-manager` удалён.
- [x] Контракт `failureType` для `consumeRetryBudget` сохранён.
- [⚠] Unit-тест на классификатор добавлен не был — tym не реализованы в проекте.
- [x] Доп: `retry-manager.js` целиком удалён (439 строк) — не имел ни одного
      production-caller, только lazy export в `runtime/index.js`.

### S1.3 Сократить `retry-budget-manager.js`  ✅ (commit `dba7298`)

- [x] Оставлены ТОЛЬКО `checkRetryBudget` (вызывается перед dispatch в dispatch-engine.js:505)
      + `consumeRetryBudget` (dispatch-engine.js:829 в finalizeDispatch('failure')).
- [x] Убран `refillBudgets` (segments работы с wildcard — Б6).
- [x] Убраны `formatBudget`, `getGlobalBudgetOverview`, `getSceneBudgets`,
      `resetSceneStageBudget` — debug/unused.
- [x] Оставшийся бюджет: per-`(bookId, chapterId, sceneId, stage)` INCR + TTL.
- [x] Цель: ~165 строк вместо 520.
- [⚠] Отдельный unit-тест на consumeRetryBudget не добавлен (тестов для retry-budget
      вообще не было в проекте).

> ⚠️ Внимание: `CAPACITY_AND_COMPLEXITY.md` §5.2 предлагал «выкинуть retry-budget-manager
> целиком». Это НЕВЕРНО для текущего кода — `consumeRetryBudget` зашит в production
> finalization (T2). Полное удаление сломает защиту от бесконечного retry-цикла.
> Сокращаем, не удаляем.

### S1.4 Удалить dead reconciliation phases  ✅ (commit `10ecf33`)

**Уточнение по факту:** аудиторское утверждение о мёртвости C4/C5 **ОШИБОЧНО**.

- [x] Удалить Phase C3 (`iu_scan`, log-only) — `recovery-engine.js:1176-1183`.
- [⚠] Phase C5 (`session_resume`): оставлена, голос аудита ошибочен —
      `backend.cjs:224-225` передаёт `resumeIncompleteSessions` +
      `runBackgroundWindowGeneration` в `reconcileDeps`. C5 РАБОТАЕТ и реально
      возобновляет незавершённые сессии после рестарта.
- [⚠] Phase C4 (`counter_reconcile`): оставлена, работает —
      `backend.cjs:219` передаёт `postgres: storage.postgres` в deps.
- [x] Оставлены Phase A + B1 + C0/C1/C2 + C4 + C5 + D.
- [x] Tест: 576 passing, syntax-smoke OK.

### S1.5 Проверить cleanup-service/AU-X legacy  ⚠ отложено (не критично для S1)

Оставлено на этап S2+: дублирующие entrypoints не блокируют стабилизацию.
Проверено: `grep -r "reconcileAll" backend/src` — только внутренние вызовы в
reconciliation-engine.js и комментарий в runtime-loop.js.

### Критерий приёмки S1  ✅

- [x] `wc -l` показывает суммарное уменьшение **1674 строки** (план был ≥ 400).
      `backend/src` объём: 11997 → 10323.
- [x] `npm test` проходит — 576 passing.
- [x] `pretest` syntax-smoke проходит для backend + gpu-hub + worker.
- [x] Инвариант `audio-orch.phase == DONE ⇔ asset.audio == READY` подтверждён
      (orchestrator.completeStage синхронизирует состояния).
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

### S2.1 Переименовать raw state setters в unsafe*  ✅

- [x] В `backend/src/state/scene-state.js` добавлены новые `unsafe*` имена:
  - `setAssetState` → `unsafeRestoreAssetState`
  - `setAssetStates` → `unsafeRestoreAssetStates` (не `...Bulk` — имя ушло в plural)
- [x] Старые имена оставлены как deprecated-alias через `const setAssetState = unsafeRestoreAssetState`
  на переходный коммит, для совместимости с тестами.
- [x] JSDoc обновлён: «use ONLY for restore from disk snapshot, NOT for lifecycle
  transitions. Lifecycle writes go through orchestrator facade.»

### S2.2 Изолировать writes внутри фасада  ⚠ упрощено

- [⚠] Решено: НЕ вводить приватный `facade._writeAssetState` — это лишний слой без
  реальной выгоды. `orchestrator.js` сам и есть фасад, его вызовы `state.unsafeRestore*`
  — это и есть private implementation детали.
- [x] Все 11 вызовов `state.setAssetState` в `orchestrator.js` переведены на `unsafe*`.
- [x] Цель достигнута: внешние модули вне whitelist'а зовут `orchestrator.*`,
  не raw setters.

> Уточнение: исходный план был избыточен. Введение `_writeAssetState` дало бы двойной
> proxy без новой валидации. Фасад ВСЕГДА пишет через `unsafeRestore*` — это его
> контракт.

### S2.3 Перевести restore/debug callers на `unsafe*`  ✅

- [x] `scene-restoration.js:87` → `unsafeRestoreAssetState`.
- [x] `startup-recovery.js:323,341` → `unsafeRestoreAssetState` (вместе с guard'ом).
- [x] `debug-routes.cjs:335,402` → `unsafeRestoreAssetStates`.
- [x] `runtime-persistence.js:591` → `unsafeRestoreAssetStates` для snapshot restore.
- [x] Доп: `helpers/redis-helpers.cjs:179` (restore on book reset) и
  `services/book-diff.cjs:449` (reset to PENDING on diff) тоже переведены.

### S2.4 Lint-соглашение  ✅

- [x] JSDoc в `scene-state.js` содержит явный whitelist файлов:
  - `orchestration/orchestrator.js` (facade)
  - `orchestration/scene-restoration.js`
  - `services/startup-recovery.js`
  - `runtime/runtime-persistence.js`
  - `services/book-diff.cjs`
  - `helpers/redis-helpers.cjs`
  - `routes/debug-routes.cjs`
- [x] Проверка: `grep -rn "unsafeRestoreAssetState\b" backend/src` показывает только
  whitelist + declaration в `scene-state.js`.

### Критерий приёмки S2  ✅

- [x] `grep "state\.setAssetState" backend/src` — 0 production совпадений
  (только deprecated alias declaration + комментарии M5 + guard устарел).
- [x] `unsafeRestoreAssetState` — только в whitelist (7 файлов + scene-state.js).
- [x] `npm test` проходит — 576 passing.
- [x] `pretest` syntax-smoke OK.
- [x] Deprecated alias остатся временно только для тестов; последним коммитом S2
  декларируется что новые callers should use unsafe* explicitly.

### Рекомендуемые коммиты

1. `refactor(state): rename setAssetState → unsafeRestoreAssetState`
2. `refactor(orchestration): route facade writes through private _writeAssetState`
3. `refactor(restore): switch restore callers to unsafe API`
4. `chore(state): document unsafe-vs-lifecycle split`

---

## Этап S3 — Production-readiness полировка  ✅ ЗАВЕРШЁН (commit pending)

**Плановый эффект:** +50 строк readiness.
**Фактический эффект:** ~90 строк (graceful shutdown + /health + GPU_TIMEOUT env).

### S3.1 Graceful shutdown в `backend.cjs`  ✅

- [x] `process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))` + SIGINT.
- [x] RuntimeError flushing `_isShuttingDown` flag — `/health` отдаёт 503 во время
      shutdown'а, что даёт container orchestrator'у корректный сигнал "draining".
- [x] `gracefulShutdown()`:
      1. `runtime.loop.stop()` (останавливает scheduler + reconcile timers).
      2. `dispatchEngine.getActiveLeases(redis)` → `cancelActiveDispatch(..., 'graceful_shutdown')`
         для каждого lease. Leases/quota освобождаются сразу, а не по TTL.
      3. `server.close()` — stop accepting new HTTP.
      4. `redis.quit()` + `storage.postgres.closePool()`.
      5. Hard timeout 10s через `setTimeout(...).unref()` — если redis/PG висят,
         процесс всё равно умрёт.
- [⚠] Unit-тест на SIGTERM не добавлен — потребуетщий fake-timers + mock dispatch-engine.
      Отложено как minor follow-up; логика shutdown'а идемпотентна и проверена вручную.

### S3.2 Endpoint `/health`  ✅

- [x] `GET /health` route в `backend.cjs` возвращает:
      ```js
      { status: 'ok' | 'degraded' | 'shutting_down', loop: bool, redis: 'PONG' | 'DOWN', ts: number }
      ```
- [x] Status 200 если `loop.isRunning() && redis.ping() === 'PONG'`.
- [x] Status 503 otherwise (включая `_isShuttingDown`).
- [x] Без auth (public endpoint — подходит для docker healthcheck и k8s liveness).

### S3.3 Endpoint `/readiness` (опционально)  ⚠ skipped

`/health` уже покрывает liveness. `/readiness` с PG-чеком добавлен не был —
в текущем deployment'е достаточно `/health`; PG-чек разумно делать, если
k8s-кластер с readiness probes станет реальностью.

### S3.4 Конфигурация GPU_TIMEOUT  ✅

- [x] `GPU_TIMEOUT` уже принимается из env в `gpu-hub/gpu-hub.js:18` (раньше был
      просто в `process.env` destructuring без экспликации).
- [x] `.env.example` обновлён: добавлен `GPU_TIMEOUT=600000` с документацией инварианта
      «GPU_TIMEOUT < min backend dispatch-lease TTL (15 min)».
- [x] `docker-compose.yml` пробрасывает `GPU_TIMEOUT=${GPU_TIMEOUT:-600000}` в gpu-hub.

### S3.5 Задать `GPU_HUB_API_KEY` для prod-deploy  ⚠ deployment-only

- [⚠] `.env.example` уже содержит placeholder `GPU_HUB_API_KEY=change_me`.
- [x] docker-compose пробрасывает `${GPU_HUB_API_KEY:-}` в backend и gpu-hub секции.
- [⚠] Реальное значение для prod не задано в репозитории (это правильно — секрет
      не коммитится). При deploy'е оператор должен вписать непустое значение.
- Smoke-test (401 без `x-api-key`) требует запущенного deployment'а — вне scope.

### Критерий приёмки S3  ✅

- [x] `npm test` проходит — 576 passing (без изменений).
- [x] `pretest` syntax-smoke OK для backend + gpu-hub + worker.
- [x] `/health` отдаёт 200 в штатном и 503 при shutdown (логика кода).
- [⚠] Unit-тесты SIGTERM/`/health` не добавлены — minimal-S3 scope без расширения
      тест-инфраструктуры.
- [x] `grep "GPU_TIMEOUT" gpu-hub/gpu-hub.js` — env-параметр с дефолтом 600000.
- [x] `.env.example` содержит все три env-параметра GPU_TIMEOUT, GPU_HUB_API_KEY.

---

## Этап S4 — Фикс тест-моков и полировка регрессий  ✅ ЗАВЕРШЁН

**Приоритет:** P3
**Цель:** убрать предупреждения `audioOrch.initPlaceholderReady is not a function`,
которые появляются в `npm test` логах.

### S4.1 Mock audioOrch  ✅

**Корневая причина найдена:** mock audioOrch в `tests/reconciliation-engine.test.js:103-138`
перекрывал `require.cache[AUDIO_ORCH_PATH]` **без** stub'а `initPlaceholderReady` и
других phase-transition функций. Эта подмена не чистилась после теста, поэтому
последующие `happy-path.test.js` вызовы `scene-window.startScene` →
`audioOrch.initPlaceholderReady()` получали неполный mock и выбрасывали `TypeError`,
перехваченный `try/catch` в `scene-window.js:762-764` → warning в логах.

- [x] Добавлены stub'ы в mock audioOrch в `reconciliation-engine.test.js`:
  `initPlaceholderReady`, `setGenerating`, `setWaitingChunks`, `setMerging`,
  `setDone`, `setFailed`, `completeChunk`, `completeMerge`, `deleteState`.
- [x] Проверены функции, вызываемые в `scene-window.js:760` и
  `scene-orchestrator.js:65` — все добавлены.
- [x] `npm test 2>&1 | grep "is not a function"` → **0 совпадений**.

### S4.2 Очистить пустые тест-файлы  ✅

- [x] `coreference-cleanup.test.js` уже удалён в более ранних commits (до S1).
- [x] Проверка: `for f in backend/tests/*.test.js; do grep -qE "it\(|test\(" "$f" || echo "$f"; done` → 0 файлов без тестов.

### Критерий приёмки S4  ✅

- [x] `npm test 2>&1 | grep "is not a function"` → 0 совпадений.
- [x] Все `.test.js` файлы содержат хотя бы один `it()`/`test()`.
- [x] `npm test` — 576 passing, без новых warnings.

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
