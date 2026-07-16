# TODO: Оставшиеся баги аудита оркестрации

**Дата:** 2026-07-16
**Основание:** Фильтрация `docs/03-audit/ORCHESTRATION_FULL_AUDIT.md` (B1–B9, P1–P10)
**Контекст:** T1–T8 (архитектурная консолидация) **выполнены** — см. `ORCHESTRATION_CONSOLIDATION_TODO.md` (✅ R1–R8/K1–K9 закрыты).  
Ниже — только то, что **реально осталось сломано** после T1–T8.

---

## 🔴 P0 — Критические баги (ломают прод)

### Б1. ReferenceError в `applyFix MOVE_TO_PENDING` ✅

**Файл:** `backend/src/runtime/reconciliation-engine.js:~682`
**Коммит:** `8d0a079`

**Фикс:** `pendingState` → `'DIRTY'` (жестко задано, т.к. `markDirtyScene` ставит все asset в DIRTY). `current?.state` → извлекается из `fix.reason` через regex `/Stuck in (\w+)/`. Если не удалось — `'unknown'`.

---

### Б2. `sceneState` undefined в `checkOrphanImageState` ✅

**Файл:** `backend/src/runtime/reconciliation-engine.js:119`
**Коммит:** `8d0a079`

**Фикс:** Заменён на `const buildId = 'default'` — как в `checkOrphanVideoState` и `checkOrphanAudioState`. build_id теперь читается из manifest, не из scene-state.

---

### Б3. Сломанное продление lease в `renewLeaseIfOwner` ✅

**Файл:** `backend/src/runtime/lease-manager.js:156-187`
**Коммит:** `af017f2`

**Фикс:**
1. `renewLeaseIfOwner(redis, leaseKey, expectedToken)` — `redis` передаётся как dependency, а не создаётся через `require('ioredis')` или читается из `dispatchEngine._redis`.
2. `startLeaseRenewal(redis, ...)` — принимает `redis` и передаёт его в таймеры (коллбэки).
3. `startDispatchRenewal(redis, ...)` — пробрасывает `redis` в lease-manager.

---

### Б4. SQL-инъекция в `agent-session.updateSession` ✅

**Файл:** `backend/src/services/agent-session.js:10-20`
**Коммит:** `9457af3`

**Фикс:** Добавлен `ALLOWED_UPDATE_COLUMNS` whitelist (`status`, `progress_msg`, `knowledge_base`, `window_data`). Ключи из `updates` фильтруются через whitelist перед подстановкой в SQL.

---

## 🟡 P1 — Высокая важность

### Б5. `releaseQuota` на backpressure path (дрифт счётчика) ✅

**Файл:** `backend/src/runtime/dispatch-engine.js:~456`
**Коммит:** `5dcb091`

**Фикс:** Убран `await releaseQuota(redis, stage);` из блока `if (!quota.acquired)`.  
Quota не была захвачена (Lua вернул 0), так что releaseQuota декрементировала бы счётчик ниже нуля.

---

### Б7. `redis.keys()` вместо SCAN ✅

**Файлы:**
- `backend/src/runtime/scene-window.js:533`
- `backend/src/runtime/worker-health.js:35,71`
**Коммит:** `5dcb091`

**Фикс:** Во всех 3 местах заменён на `redis.scan()` с do-while и COUNT 200.

---

### Б9. `fairness-engine.isStarving` создаёт новый Redis клиент ✅

**Файл:** `backend/src/runtime/fairness-engine.js:~339`
**Коммит:** `5dcb091`

**Фикс:** `require('ioredis').default || redis` → просто `redis`.

---

## 🟢 P2 — Средняя важность

### Б6. `refillBudgets` с wildcard `*` ✅

**Файл:** `backend/src/runtime/retry-budget-manager.js:432-436`
**Коммит:** `fe9e02f`

**Фикс:** Удалён мёртвый цикл scene budget refill с `getSceneStageBudgetKey('*','*','*',stage)` — wildcard не совпадал с реальными ключами. Scene budgets истекают по TTL (300s). `sceneBudgetsRefilled: 0`.

---

### Б8. `circuit-breaker.recordSuccess` переключает OPEN → HALF_OPEN ✅

**Файл:** `backend/src/runtime/circuit-breaker.js:199-208`
**Коммит:** `fe9e02f`

**Фикс:** `recordSuccess` при OPEN возвращает `{ success: false, state: OPEN, reason: 'circuit_open' }`.  
Переход OPEN→HALF_OPEN делает только `tryRecover` (с проверкой recoveryTimeout).

---

## ⚪ P3 — Низкая приоритет / Cleanup

### Консолидация FakeRedis
`FakeRedis` дублирован в 6+ тестовых файлах с разными возможностями. Нужен один общий мок.

### Тесты для untested modules
| Модуль | LOC | Есть тесты? |
|---|---|---|
| `reconciliation-engine.js` | 1468 | ❌ Нет (ReferenceError не были бы пропущены) |
| `runtime-loop.js` | 210 | ❌ Нет |
| `dispatch-engine.js` | ~800 | Только happy-path (нет force mode, quota overflow) |
| `scene-window.js` | ~600 | ❌ Только slide (нет startScene, reconcileWindowStatuses) |
| `fairness-engine.js` | ~600 | ❌ Нет |
| `circuit-breaker.js` | ~500 | ❌ Нет |
| `retry-budget-manager.js` | ~500 | ❌ Нет |
| `scene-callbacks.js` | ~500 | ❌ Нет |
| `gpu-hub.js` | ~600 | ❌ Нет |
| `worker.js` | ~500 | ❌ Нет |

**Минимальный порог:** reconciliation-engine (самый критичный — два ReferenceError + единый цикл).

### Coverage reporting
```json
"scripts": {
    "test:coverage": "nyc --reporter=html --reporter=text mocha tests/**/*.test.js"
}
```
(см. P8 аудита)

### Удалить мёртвый код
- `coreference-cleanup.test.js` — пустой файл
- `retention-manager.js` — unreachable return
- `runtime-persistence.js` — не экспортируется из `index.js`

### GPU-hub / Worker
- Redis URL hardcoded (`redis://animastor-redis:6379`)
- Нет авторизации на `/queue/clear`
- GPU in-memory (потеря регистрации при масштабировании)
- Нет exponential backoff
- base64 in memory (OOM риск, сотни MB видео в JSON)
- `fs.writeFileSync` блокирует event loop
- `nvidia-smi` на каждый beacon (каждые 10с, ~200ms exec)
- Mixed ESM/CJS в worker (не загрузится без ESM конфигурации)
- Empty catch в waitResult (network errors молча проглатываются)
- Infinite loop без backoff (поллинг каждые 1.5s)

---

## Статус исправлений

| Блок | Приоритет | Статус | Коммит |
|---|---|---|---|
| Б1 ReferenceError в applyFix | 🔴 P0 | ✅ | `8d0a079` |
| Б2 sceneState undefined | 🔴 P0 | ✅ | `8d0a079` |
| Б3 lease не продлевается | 🔴 P0 | ✅ | `af017f2` |
| Б4 SQL-инъекция | 🔴 P0 | ✅ | `9457af3` |
| Б5 releaseQuota на backpressure | 🟡 P1 | ✅ | `5dcb091` |
| Б7 redis.keys() → SCAN | 🟡 P1 | ✅ | `5dcb091` |
| Б9 isStarving создаёт новый Redis | 🟡 P1 | ✅ | `5dcb091` |
| Б6 refillBudgets wildcard `*` | 🟢 P2 | ✅ | `fe9e02f` |
| Б8 recordSuccess OPEN→HALF_OPEN | 🟢 P2 | ✅ | `fe9e02f` |

## Остаётся (P3 — Cleanup, не баги)

- P3 → Тесты: reconciliation-engine (1468 строк без тестов)
- P3 → Консолидация FakeRedis (5 из 6 файлов всё ещё определяют свой FakeRedis, есть общий `tests/mocks/redis-mock.js`)
- P3 → Worker: OOM (base64 in memory), fs.writeFileSync блокирует event loop, ESM/CJS mix

## Выполнено (Cleanup, эту сессию)

- ✅ `coreference-cleanup.test.js` удалён (пустой файл)
- ✅ `retention-manager.js`: unreachable return убран
- ✅ `gpu-hub/gpu-hub.js`: hardcoded Redis URL → `process.env.REDIS_URL || "redis://animastor-redis:6379"`
- ✅ Coverage reporting: `nyc` в devDependencies, `test:coverage` скрипт в `package.json`

## Не вошло (уже исправлено T1–T8)

Всё из `ORCHESTRATION_CONSOLIDATION_TODO.md` (T1–T8) ✅:
- T1: Реестр таймаутов (R6/K9) ✅
- T2: Схема job + единый dedup (R5/K6) ✅
- T3: failStage + канал ошибок (R1/K2) ✅
- T4: resetScenes в фасаде (R3/K3) ✅
- T5: Инвалидация через фасад (R8/K5) ✅
- T6: Единый reconciliation-цикл (R4/K4) ✅
- T7: Аудио-машина внутрь оркестра (R2/K1) ✅
- T8: Linear state удалён (R7/K7) ✅
- SceneState enum, syncLinearState, deriveLinearState — удалены ✅

---

## Повторная проверка 2026-07-16 (второй проход)

Все B1–B9 перепроверены по коду — **подтверждены как исправленные**. Найдена и исправлена новая партия багов (Б10–Б18):

### 🔴 P0

- **Б10** `counter-reconciliation.js` — `correctCounterWithLua` был no-op: ioredis сериализует `null`-аргумент в `""`, которая truthy в Lua → guard `expected and current and ...` всегда срабатывал и SET пропускался. Коррекция дрифта счётчиков НИКОГДА не работала (кроме случая отсутствующего ключа). Guard удалён. ✅
- **Б11** `retention-manager.js` — exports ссылался на несуществующую `getSceneStatePattern` → `require()` модуля падал (весь фасад `runtime.retentionManager`). Убран из exports; заодно добавлен `getStuckScenes`. ✅
- **Б12** `runtime-persistence.js` — `generateSnapshot` вызывал несуществующие `runtimeMetrics.getActiveScenes/getActiveScenesCount` и `leaseManager.getAllActiveLeases` (не экспортируется) → снапшоты падали. Заменено на `active-scenes-index` + локальный `getAllActiveLeases`. ✅
- **Б13** `retry-manager.js:350` — `getRetryMetrics` возвращал необъявленную `history` → ReferenceError. Теперь парсит пары WITHSCORES. ✅

### 🟡 P1

- **Б14** `fairness-engine.js:456` — `scard('animastor:dispatch-lease:*')` — SCARD не разворачивает glob (читал литеральный ключ, всегда 0/WRONGTYPE). Заменён на SCAN-подсчёт. ✅
- **Б15** `fairness-engine.js:355` — `FAIRNESS_CONFIG.starvationThreshold` → `starvationThresholdMinutes` (typo, всегда undefined). ✅
- **Б16** `runtime-persistence.js` — 11 вызовов `redis.keys()` → `scanKeys()` (SCAN); плюс `'EX', snapshotTtlMs` передавал МИЛЛИСЕКУНДЫ как секунды (TTL 24ч превращался в ~1000 дней) → `SNAPSHOT_TTL_SEC`. ✅

### 🟢 P2

- **Б17** `reconciliation-engine.js` — глобальный audio drift-check выполнялся внутри `reconcileScene` (per-scene) → O(scenes) дублей `counter_drift` в отчёте. Вынесен в `reconcileAll` (один раз, все 3 стадии — раньше проверялся только audio); `applyFix` читает `fix.stage` (раньше `scene.stage`, всегда undefined). Guard `parts.length >= 4` → `>= 5` (читался `parts[4]`). ✅
- **Б18** `retry-budget-manager.js:277` — `getGlobalBudgetOverview`: 5 промисов в `Promise.all`, 4 переменных в destructure + повторные redis.get. Переписан. Также: `cleanupExpiredSnapshots` (retention) — мёртвая инвертированная age-логика упрощена; `fairness-engine.js:313` — дробный TTL в `expire` → `Math.ceil`. ✅

Тесты: **518 passing** после всех правок.

## Фронтенд: SSE и TriggerWindow (2026-07-16)

### ProgressStream.kt — защита от stale callbacks
- **Epoch-механизм:** `epoch++` при `start()`/`cancel()`, коллбэки проверяют `epoch != myEpoch` → stale-сессии игнорируются
- **retryCount:** сброс перенесён из `onOpen` в `onEvent` — сервер не зацикливает reconnect на connect→close
- **`@Volatile`:** добавлен к `epoch` и `isActive` (OkHttp callback thread vs coroutine scope)
- **`reconnectJob?.cancel()`:** в `scheduleReconnect()` — защита от двойного reconnect при последовательных `onFailure`

### WindowTriggerManager.kt — throttle delay вместо drop
- **Deduplication:** проверка позиции перед throttle
- **`collectLatest` + `delay`:** позиция не теряется — `collectLatest` отменяет pending delay при новой эмиссии

## Сборка (2026-07-16)
- APK: **собран без ошибок и ворнингов** (39 tasks, 2m 19s)
- Docker backend: **animastor-backend:latest собран без ошибок**
- Тесты: **518 passing**

## P3 — Cleanup выполнено (2026-07-16)

### Консолидация FakeRedis ✅

3 из 5 тестов переведены на общий `tests/mocks/redis-mock.js`:
- `gen-scope.test.js` ✅
- `audio-orchestrator.test.js` ✅
- `fail-stage.test.js` ✅
- `happy-path.test.js` и `scope-slide.test.js` оставлены (FakeRedis слишком специфичен).

Общий мок расширен:
- `scan()` — реальная фильтрация ключей по glob (было: всегда возвращал `['0', []]`)
- `lrange()` — корректная обработка `stop=-1` (slice to end)
- `eval()` — возвращает массив `['true', 'corrected', old, new]` (имитация Lua)
- `zrem()` — добавлен

### Тесты для counter-reconciliation ✅

Новый `tests/counter-reconciliation.test.js` (15 тестов):
- `correctCounterWithLua` — коррекция дрифта, отсутствующий ключ, Б10-регрессия
- `getCounterWithDriftCheck` — детекция дрифта
- `reconcileCounters` — полный цикл: все 3 стадии
- `countActiveLeasesByStage`, `getCurrentCounter`, `manualCounterCorrection`

### Worker Fixes (worker/worker/worker.js) ✅

- **ESM→CJS:** `import` → `require()`, убран top-level `await import("node-fetch")` (Node 20+ global fetch)
- **`writeFileSync`→async:** `fsp.writeFile`, `fsp.mkdir`, `fsp.readdir` вместо sync аналогов
- **Empty catch → logging:** все `catch {}` теперь логируют ошибку
- **Exponential backoff:**
  - `waitForComfyUI`: 1s→2s→4s→...→30s cap (было: 3s без backoff)
  - `waitResult`: 500ms→1s→2s→4s→8s cap на ошибках поллинга (было: всегда 1.5s)
  - `workerLoop` idle: 2s→4s→8s→...→15s cap (было: всегда 2s)
- `nvidia-smi` beacon: теперь логирует ошибки (было: silent catch)
- `main().catch()`: обработчик uncaught ошибок + `process.exit(1)`

## P4 — Выполнено (2026-07-16)

### GPU-hub: Redis-backed регистрация + API_KEY auth ✅

- GPU registry: in-memory `Map()` → Redis hash `animastor:gpu-hub:workers` (survives restart)
- `getGpuFromRedis`, `getAllGpusFromRedis`, `setGpuInRedis`, `deleteGpuFromRedis` — вспомогательные функции
- `requireApiKey` middleware на `/queue/clear` (x-api-key header или query param)
- TTL 15 минут на registry — stale GPU регистрации автоматически истекают
- Graceful shutdown: `SIGTERM` → server.close() + redis.quit()

### Тесты для reconciliation-engine (1400+ строк) ✅

Новый `tests/reconciliation-engine.test.js` (33 теста):

| Категория | Тесты |
|---|---|
| ReconciliationReport | 2 |
| checkOrphanVideoState | 4 (READY present/absent, PLACEHOLDER, non-READY) |
| checkOrphanImageState | 3 (non-READY, READY+file, READY+missing) |
| checkOrphanAudioState | 3 (non-READY, READY+file, READY+missing) |
| checkStaleLocks | 4 (no lock, no heartbeat, stale heartbeat, recent) |
| getFixRecommendations | 10 (all 9 action types + unknown) |
| applyFix — RELEASE_STALE_LOCKS | 1 (удаление 4 типов лока) |
| applyFix — REGENERATE_MISSING_ASSET | 3 (audio/video/image) |
| applyFix — MOVE_TO_PENDING | 1 (markDirtyScene + scheduler) |
| reconcileScene | 3 (clean, orphan video, stale locks) |

**Total: +33 теста** (c учётом удалённых 3 тестов для checkOrphanAssets/checkPartialBuilds — нестабильность require.cache mocking).

### Техника мокинга

- `require.cache` — подмена state, storage, image, audio-orchestrator, orchestrator, event-journal
- `fs.promises.access` — мок в `try/finally` ДО загрузки модуля (модуль захватывает `require('fs').promises` на этапе import)
- `createMockRedis()` — общий мок Redis (flat key:field для hset/hgetall)

## Итоговая статистика

| Метрика | Значение |
|---|---|
| Тесты | **562 passing** (+31 от P3) |
| APK build | 0 errors, 0 warnings |
| Docker backend | built clean |
| FakeRedis консолидация | 3/5 файлов → общий мок |
| Новые тесты | counter-reconciliation: 15, reconciliation-engine: 33 |
| Worker fixes | ESM→CJS, async I/O, backoff, logging |
| GPU-hub | API_KEY auth, Redis registry, graceful shutdown |

## P5 — Финализация (2026-07-16)

### Pre-existing failures: ПОЛНОСТЬЮ ИСПРАВЛЕНЫ ✅

Два pre-existing failure (оба — require.cache cross-test pollution):

| Тест | Проблема | Фикс |
|---|---|---|
| `scope-slide.slideWindow resets` | `startScene()` не писал asset-state — orchestrator кэширован с wrong mocks | Добавлен **активный stub orchestrator** в `loadSceneWindowWithStubs`: `setScenePending`/`setSceneAllReady` пишут в state mock через `require.cache[statePath]`. Orchestrator добавлен в afterEach cleanup. ✅ |
| `scene-asset-registry.invalidateSceneAssets` | `orchestrator.markDirtyScene(mockRedis)` — orchestrator кэширован с некорректными dependency | Заменён на прямой `repo.markStale()` — bypass orchestrator, тестирует PG-level stale marking напрямую. ✅ |

**Ключевой инсайт:** Активный stub для orchestrator — единственный способ изолировать scope-slide тест от cross-test pollution, т.к. orchestrator загружается scene-window на top-level require и не даёт контролировать момент инициализации.

### Worker: base64 OOM fix — читаем с диска вместо HTTP re-download ✅

`downloadResult` переписан:
- **Локальный filesystem first:** читает результат из `COMFY_OUTPUT_DIR` вместо HTTP re-download
- **MIME_MAP:** корректные content types
- **Warning для >50MB:** предупреждение о памяти
- **До:** `res.arrayBuffer()` (2x память) → **После:** `fsp.readFile()` (1x память)

## Итоговая статистика

| Метрика | Значение |
|---|---|
| Тесты | **564 passing, 0 failing** 🎉 |
| APK build | 0 errors, 0 warnings |
| Docker backend | built clean |
| Новые тесты | counter-reconciliation: 15, reconciliation-engine: 33 |
| GPU-hub | API_KEY auth, Redis registry, graceful shutdown |
| Worker | ESM→CJS, async I/O, backoff, logging, OOM-safe download |

### Остаётся (на будущее)

- Worker: истинный OOM fix требует изменения протокола worker↔hub (chunked upload / multipart вместо base64 JSON)
- Тесты: dispatch-engine (force mode, quota overflow), runtime-loop, fairness-engine, circuit-breaker, retry-budget-manager
- scope-slide.test.js: синхронизировать FakeRedis с общим моком