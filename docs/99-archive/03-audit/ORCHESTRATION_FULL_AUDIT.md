# Full Orchestration System Audit

**Date:** 2026-07-16
**Scope:** `backend/src/orchestration`, `backend/src/runtime`, `backend/src/state`, `gpu-hub/`, `worker/`, `backend/tests/`
**Context:** GPU scene generation orchestration system (audio, image, video) for animated books. After M5 (orchestrator facade) — audit of architecture, logic, code quality, tests, and bugs.

---

## Summary

Система оркестрации имеет **крепкое ядро** (фасад из 13 команд, per-asset FSM, version-gate, lease/quota/идемпотентность) и **серьёзные проблемы** на периферии: 3 критических бага (ReferenceError, сломанное продление lease, SQL-инъекция), размазанная логика recovery, дублирование кода и пробелы в тестах.

| Аспект | Оценка |
|--------|--------|
| Архитектура ядра | 80% — продумано, фасад есть, контракты чёткие |
| Критичные баги | 3 ошибки времени выполнения |
| Качество кода | 60% — дублирование, неконсистентные паттерны |
| Тесты | 55% — много, но с пробелами в критических модулях |

---

## 1. Architecture: What's Good

### 1.1. Per-asset FSM — канонический ✅

`scene-state.js` — чистая реализация FSM:
- 7 состояний (NEW → DIRTY → PENDING → GENERATING → READY/FAILED, PLACEHOLDER)
- `AssetTransitions` — декларативная карта разрешённых переходов
- Атомарные HSET-операции в Redis
- Лучшая часть системы

### 1.2. Фасад оркестратора — единая точка входа ✅

`orchestration/orchestrator.js` экспортирует 13 команд:
- `markDirty` / `markDirtyScene` — dirty для регенерации / восстановления
- `planScene` — чистая функция (только читает, не пишет)
- `beginStage` → `completeStage` → `failStage` — полный lifecycle
- `resetScenes` — 11-шаговый ритуал регенерации (force-dispatch, gen-scope, journal, leases, GPU queues, PNG, iu-progress, markDirty, active index)

### 1.3. Dispatch-lease + quota — детерминизм ✅

- Lua `ATOMIC_ACQUIRE_SCRIPT` — атомарная проверка лимита + INCR
- Д.1: dispatch-completed маркер SET NX — идемпотентный release
- Force mode с pre-clear
- Scheduler tick lock

### 1.4. Version-gate перед READY ✅

`orchestrator.completeStage:86-131` проверяет PG content_version. Если asset старее scene → DIRTY вместо READY. Graceful fallback при недоступности PG. Это Д.3 — диск как ФАКТ, не РЕШЕНИЕ.

### 1.5. IU timing recalculation ✅

`scene-callbacks.js:119-160` — пропорциональный пересчёт start_ms/end_ms когда реальный аудио заменяет placeholder.

### 1.6. Event journal ✅

29 типов событий. RPush, TTL 7 дней. Полная история каждой сцены.

### 1.7. T3: failStage + канал ошибок worker → backend ✅

`worker → gpu-hub /task/error → backend /gpu/task/error → orchestrator.failStage` — работает. gpu-hub делает 5 retries, fallback в `animastor:error:{job_id}`. Reconciliation Phase A подхватывает.

### 1.8. T6: Единый reconciliation-цикл ✅

`reconciliation-engine.reconcileCycle()` — 4 фазы (A-D), distributed lock, journal events. Заменяет 4 старых механизма.

---

## 2. Critical Bugs (CRITICAL)

### Б1. ReferenceError в reconciliation-engine.js

**Файл:** `reconciliation-engine.js:682-684`
```js
case 'MOVE_TO_PENDING': {
    await journal.appendSceneEvent(redis, scene.bookId, scene.chapterId, scene.sceneId,
        'AUTO_RECOVER', pendingState,   // undefined!
        { fromState: current?.state, ... }   // undefined!
    );
```

Переменные `pendingState` и `current` не определены в этом scope. **ReferenceError при каждом вызове applyFix с action MOVE_TO_PENDING.**

### Б2. Неопределённая переменная в checkOrphanImageState

**Файл:** `reconciliation-engine.js:117-119`
```js
const imageInfo = imageModule.resolveCanonicalSceneImage(
    '/data/output',
    (sceneState && sceneState.build_id) || 'default',  // sceneState undefined!
    bookId, chapterId, sceneId,
);
```

Переменная `sceneState` не определена в scope функции. **ReferenceError при каждом запуске orphan image check.**

### Б3. lease-manager.js: сломанное продление lease

**Файл:** `lease-manager.js:156-157, 182-183`
```js
async function renewLeaseIfOwner(leaseKey, expectedToken) {
    const redis = require('ioredis');  // Создаёт НОВЫЙ клиент (бесполезно)
    ...
    const dispatchEngine = require('./dispatch-engine');
    const redis = dispatchEngine._redis;  // _redis не экспортируется → undefined
```

`_redis` — приватное свойство, не экспортируется из `dispatch-engine.js`. **Продление lease всегда возвращает `{ renewed: false, reason: 'no_redis' }`.** Leases живут только начальный TTL, никогда не продлеваются.

### Б4. SQL-инъекция в agent-session.js

**Файл:** `services/agent-session.js`
```js
const setClauses = Object.keys(updates)
    .map(col => `${col} = ...`)  // колонки напрямую из ключей объекта
```

`Object.keys(updates)` передаётся напрямую в SQL-строку. Если caller передаст ключ типа `status; DROP TABLE agent_sessions--`, будет SQL-инъекция.

---

## 3. Medium Severity Bugs (HIGH)

### Б5. Не-атомарный releaseQuota на backpressure path

**Файл:** `dispatch-engine.js:465-467`
```js
if (!quota.acquired) {
    await releaseQuota(redis, stage);  // квота не была захвачена!
```

Когда Lua-скрипт возвращает 0 (quota exceeded), `acquireQuota` уже НЕ инкрементировал счётчик. `releaseQuota` на этом пути декрементирует счётчик ниже нуля. Дрифт активных счётчиков.

### Б6. retry-budget-manager: неверный refillBudget

**Файл:** `retry-budget-manager.js:432-436`
```js
refillBudgets() — getSceneStageBudgetKey('*', '*', '*', stage)
```

Wildcard "*" не совпадает с реальными ключами (которые содержат конкретные bookId/chapterId/sceneId). Scene stage budgets никогда не refill-ятся — утечка ключей без TTL (установлен на строке 133).

### Б7. scene-window: keys() вместо SCAN

**Файл:** `scene-window.js:533`
```js
const chunkKeys = await redis.keys(`animastor:chunk:${bookId}_*`);
```

`redis.keys()` блокирует весь Redis на время выполнения. На продакшене с тысячами ключей — остановка всех операций на секунды. Должен быть SCAN.

### Б8. circuit-breaker: recordSuccess переключает OPEN → HALF_OPEN

**Файл:** `circuit-breaker.js:199-208`
```js
if (currentState === CircuitState.OPEN) {
    await setCircuitState(redis, service, CircuitState.HALF_OPEN);
```

`recordSuccess` никогда не должен переключать OPEN в HALF_OPEN — это должен делать таймер `tryRecover`. OPEN → HALF_OPEN по success означает, что одна удачная операция пробивает circuit breaker.

### Б9. fairness-engine.isStarving: создаёт новый Redis

**Файл:** `fairness-engine.js:339`
```js
const states = await assetStates.getAssetStates(
    require('ioredis').default || redis, ...
);
```

`require('ioredis').default` создаёт **новый** Redis клиент. Функция всегда возвращает `{ starving: false, reason: 'no_state' }` на этом новом клиенте.

---

## 4. Code Quality

### 4.1. Дублирование кода

| Что дублируется | Где |
|---|---|
| Leak key generators | `dispatch-engine.js` + `lease-manager.js` |
| Active index management | `runtime-scheduler.js` + `active-scenes-index.js` |
| Lua scripts для release lease | 3 копии (dispatch-engine, lease-manager safe/with-token) |
| `generateDispatchToken` | dispatch-engine + lease-manager |
| Scene callback handler pattern | 3 копии: audio/image/video (497 строк) |
| Version staleness check | `runtime-scheduler.js` + `scene-window.js` + `reconciliation-engine.js` |

### 4.2. Магические числа и разбросанные константы

| Значение | Файл | Проблема |
|---|---|---|
| 10 min (GPU_TIMEOUT) | gpu-hub.js:17 | hardcoded env default |
| 15/30/3 s | lease-manager.js:29-40 | разбросано RENEWAL vs TTL |
| 5 retries, 500ms | gpu-hub.js:39-55 | нет exponential backoff |
| 3 max audio / 2 image / 1 video | dispatch-engine.js:49-52 | в коде, не в конфиге |
| 15 min / 20 min / 30 min | lease-manager.js:37-39 | дубликат из dispatch-engine |
| 4h TTL | scene-callbacks.js:278 | iu-progress TTL |

### 4.3. Смешение ESM и CommonJS

`worker/worker.js` использует:
```js
import { execSync } from "child_process"  // ESM
const fetch = global.fetch || (await import("node-fetch")).default  // top-level await
```

При этом весь проект на CommonJS (`require`). Этот файл **не может быть загружен** в текущем окружении.

### 4.4. Проблемы стиля и паттернов

- `console.*` вместо структурированного логгера (везде)
- `.catch(() => {})` — пустые catch (scene-state.js:96, worker:292, gpu-hub:103-105 и др.)
- require() внутри функций (lazy require) — норм для архитектуры, но 15+ мест
- Variable shadowing: `redis` объявляется дважды в `lease-manager.js:157,183`
- Отсутствие JSDoc почти везде
- Инлайн FakeRedis в 6 тестовых файлах (вместо общего мока)

---

## 5. Test Quality

### 5.1. Статистика

| Метрика | Значение |
|---|---|
| Файлов тестов | 26 (+ 1 мок) |
| Пустых/заглушек | 1 (coreference-cleanup.test.js) |
| Всего тестов | ~275 |
| Unit-тестов (чистые) | ~15 |
| Интеграционных (PG) | 4 |
| С FakeRedis | ~8 |
| С require.cache | 3 |

### 5.2. Что тестируется хорошо

- **prompt-dependency-registry.test.js** (28 тестов) — deep equality, null/undefined, все поля
- **audio-segments.test.js** (25 тестов) — языки, границы слов, padding, all edge cases
- **happy-path.test.js** (50+ тестов, 2017 строк) — dispatch, lease, quota, dedup, version-stale
- **book-diff-unit.test.js** (20 тестов) — dirty layers, cross-cutting deps, полный coverage
- **audio-orchestrator.test.js** (19 тестов) — phases, transitions, lifecycle

### 5.3. Критические пробелы

| Модуль | Есть тесты? | Проблема |
|---|---|---|
| `reconciliation-engine.js` | ❌ Нет | 1468 строк СОВСЕМ без тестов. Два ReferenceError не были бы пропущены |
| `runtime-loop.js` | ❌ Нет | 210 строк основной heartbeat без тестов |
| `dispatch-engine.js` | Только happy-path | Нет тестов force mode, quota overflow, circuit breaker interaction |
| `scene-window.js` | scope-slide.test.js | Только slide, НЕТ startScene, НЕТ reconcileWindowStatuses |
| `fairness-engine.js` | ❌ Нет | 598 строк — никогда не тестировался |
| `circuit-breaker.js` | ❌ Нет | 505 строк — никогда не тестировался |
| `retry-budget-manager.js` | ❌ Нет | 537 строк — никогда не тестировался |
| `orchestration/scene-callbacks.js` | ❌ Нет | 497 строк коллбэков без тестов |
| `orchestration/orchestrator.js` | только failStage | completeStage, resetScenes, setScene* без тестов |
| `gpu-hub/gpu-hub.js` | ❌ Нет | 573 строк |
| `worker/worker.js` | ❌ Нет | 500 строк |

### 5.4. Проблемы инфраструктуры тестов

- **FakeRedis дублирован** в 6+ файлах с разными возможностями
- **require.cache manipulation** fragile (happy-path, scope-slide, book-diff-unit)
- **PG integration tests** не изолированы — `before/afterEach` синхронный, сломается при `--parallel`
- **No coverage** — нет nyc/c8 в package.json
- **No .mocharc** — все флаги в package.json script
- **Смесь chai.expect и assert** — scene-patch-utils и iu-progress-utils используют assert вместо expect
- **Перекрытие тестов**: `asset-state.test.js` и `scene-state.test.js` тестируют одно и то же

---

## 6. GPU Hub and Worker Issues

### 6.1. GPU Hub

- **Redis URL hardcoded** — `redis://animastor-redis:6379` (не конфигурируется)
- **Нет авторизации** на `/queue/clear` — любой может стереть все очереди
- **gpus in-memory** — при масштабировании до нескольких hub-инстансов потеря регистрации
- **No exponential backoff** — 5 retries по 500ms, backend может быть перегружен
- **Parse job_id вручную** — копия логики из job-schema.js, рассинхронизация

### 6.2. Worker

- **base64 in memory** — video файлы (сотни MB) целиком base64, потом в JSON — OOM risk
- **fs.writeFileSync** — блокирует event loop
- **nvidia-smi на каждый beacon** — каждые 10 секунд, пустая трата (~200ms exec)
- **mixed ESM/CJS** — не загрузится без ESM конфигурации
- **empty catch** в waitResult — все network error молча проглатываются
- **infinite loop without backoff** — waitResult: поллинг каждые 1.5s

---

## 7. Recommendations

### P1 (CRITICAL): Исправить ReferenceError в reconciliation-engine.js

- `applyFix MOVE_TO_PENDING`: определить `pendingState` (из `item.state`) и `current` (лог)
- `checkOrphanImageState`: читать `sceneState` или передавать build_id из параметра
- Написать тесты на `applyFix` и `checkOrphanState`

### P2 (CRITICAL): Починить продление lease

- Экспортировать `redis` из dispatch-engine или передавать как dependency
- Либо: в `startLeaseRenewal` принимать redis как аргумент
- Либо: убрать `dispatchEngine._redis` и передавать redis через замыкание

### P3 (HIGH): Фикс SQL-инъекции в agent-session

```js
const ALLOWED_COLUMNS = ['status', 'result_summary', ...];
const safeColumns = Object.keys(updates).filter(c => ALLOWED_COLUMNS.includes(c));
```

### P4 (HIGH): Убрать releaseQuota на backpressure path

```js
if (!quota.acquired) {
    // НЕ вызывать releaseQuota — квота не была захвачена
    return { dispatched: false, reason: 'backpressure', ... };
}
```

### P5 (MEDIUM): Консолидировать FakeRedis

- Один общий мок с поддержкой: HSET/HGET/HGETALL, INCR/DECR, EVAL (Lua), SCAN, SADD/SREM, RPUSH/LRANGE/LPOP, ZADD/ZRANGE
- Добавить TTL симуляцию (таймер для EX/PX)

### P6 (MEDIUM): Написать тесты для untested modules

- reconciliation-engine (reconcileScene, reconcileCycle, applyFix)
- dispatch-engine (force mode, quota overflow, circuit breaker)
- circuit-breaker (state transitions, recovery)
- fairness-engine (all functions)
- scene-callbacks (all three handlers)
- scene-window (startScene, reconcileWindowStatuses)

### P7 (MEDIUM): Убрать keys() — заменить на SCAN

- `scene-window.js:533`
- `worker-health.js:34,70`

### P8 (MEDIUM): Добавить coverage reporting

```json
"scripts": {
    "test:coverage": "nyc --reporter=html --reporter=text mocha tests/**/*.test.js"
}
```

### P9 (LOW): Консолидация таймаутов в runtime-config.js

- GPU_TIMEOUT, LEASE_TTL, retry-параметры, heartbeat TTL — в один файл с инвариантами

### P10 (LOW): Удалить мёртвый код

- `coreference-cleanup.test.js` — пустой файл
- `retention-manager.js:391-394` — unreachable return
- `runtime-persistence.js` — не экспортируется из index.js

---

## 8. Invariants After Fixes

1. Per-asset FSM — единственный источник истины
2. Любой переход через команду фасада
3. Сбой worker → failStage за секунды, не за TTL
4. Единый reconciliation-цикл с distributed lock
5. Все TTL/таймауты в одном конфиге
6. Каждый Lua-скрипт — в одном месте

---

## Связанные документы

- `docs/03-audit/ORCHESTRATION_CONSOLIDATION_AUDIT.md` — аудит консолидации (K1-K9, R1-R8)
- `docs/02-orchestration/ORCHESTRATOR_LIFECYCLE.md` — целевой дизайн lifecycle
- `docs/02-orchestration/ORCHESTRATOR_FACADE_PR.md` — что закрыто в M5
- `docs/02-orchestration/M5_COMPETING_WRITERS.md` — история писателей
- `docs/03-audit/ARCHITECTURAL_DEBT.md` — Д.1-Д.5
