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

### Б5. `releaseQuota` на backpressure path (дрифт счётчика)

**Файл:** `backend/src/runtime/dispatch-engine.js:~465-467`

**Описание:** Когда Lua-скрипт возвращает 0 (quota exceeded), `acquireQuota` НЕ инкрементирует счётчик, но `releaseQuota` на этом пути всё равно вызывается:
```js
if (!quota.acquired) {
    await releaseQuota(redis, stage);  // Декремент без инкремента!
    ...
}
```

**Результат:** Дрифт активных счётчиков вниз.

**Фикс:** Убрать `releaseQuota` на этом пути:
```js
if (!quota.acquired) {
    // НЕ вызывать releaseQuota — квота не была захвачена
    return { dispatched: false, reason: 'backpressure', ... };
}
```

---

### Б7. `redis.keys()` вместо SCAN

**Файлы:**
- `backend/src/runtime/scene-window.js:533`
- `backend/src/runtime/worker-health.js:35,71`

**Описание:** `redis.keys()` блокирует весь Redis на время выполнения. На продакшене с тысячами ключей — остановка всех операций на секунды.

**Фикс:** Заменить на `redis.scan()` с итерацией.

---

### Б9. `fairness-engine.isStarving` создаёт новый Redis клиент

**Файл:** `backend/src/runtime/fairness-engine.js:~339`

**Описание:** Внутри `getAssetStates` используется новый Redis вместо переданного:
```js
const states = await assetStates.getAssetStates(
    require('ioredis').default || redis, ...
);
```
`require('ioredis').default` создаёт **новый** Redis клиент. На новом клиенте нет данных.

**Результат:** Функция всегда возвращает `{ starving: false, reason: 'no_state' }`.

**Фикс:** Убрать `require('ioredis').default` — использовать переданный `redis`:
```js
const states = await assetStates.getAssetStates(redis, ...);
```

---

## 🟢 P2 — Средняя важность

### Б6. `refillBudgets` с wildcard `*`

**Файл:** `backend/src/runtime/retry-budget-manager.js:432-436`

**Описание:** Scene stage budgets используют wildcard `*` для bookId/chapterId/sceneId:
```js
const pattern = `${getSceneStageBudgetKey('*', '*', '*', stage)}`;
const key = getSceneStageBudgetKey('*', '*', '*', stage);
```
Wildcard `*` не совпадает с реальными ключами (которые содержат конкретные bookId/chapterId/sceneId).  
**Результат:** Scene stage budgets никогда не refill-ятся — утечка ключей без TTL.

**Фикс:** Либо SCAN по паттерну, либо отказаться от per-scene budget refill (перейти на глобальные лимиты).

---

### Б8. `circuit-breaker.recordSuccess` переключает OPEN → HALF_OPEN

**Файл:** `backend/src/runtime/circuit-breaker.js:199-208`

**Описание:** `recordSuccess` при OPEN переключает в HALF_OPEN. По семантике circuit breaker, OPEN → HALF_OPEN должен делать только таймер `tryRecover`:
```js
if (currentState === CircuitState.OPEN) {
    // recordSuccess — не должен это делать!
    await setCircuitState(redis, service, CircuitState.HALF_OPEN);
```

**Фиск:** Либо а) убрать этот переход (оставить только `tryRecover`), либо б) если это осознанное решение — **задокументировать** поведение как особенность.

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

## Рекомендуемый порядок исправления

```
P0 → Б1 (ReferenceError)    : сейчас, падает прод
P0 → Б2 (sceneState)         : сейчас, падает прод
P0 → Б3 (renewLease)         : сейчас, leases никогда не продлеваются
P0 → Б4 (SQL-инъекция)       : сейчас, security дыра
P1 → Б5 (quota drift)        : счётчики дрифтуют
P1 → Б7 (keys→SCAN)          : блокировки Redis
P1 → Б9 (ioredis.default)    : isStarving всегда false
P2 → Б6 (retry budget)       : утечка ключей
P2 → Б8 (circuit OPEN)       : неконсистентность
P3 → Тесты                    : reconciliation-engine в первую очередь
P3 → Cleanup / GPU-hub       : когда будет время
```

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
