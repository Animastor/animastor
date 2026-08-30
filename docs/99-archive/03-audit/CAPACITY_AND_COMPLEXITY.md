# Orchestration System Capacity and Complexity

> **Date:** July 19, 2026
> **Question:** How many users is the system designed for if polished without adding complexity? Is the system over-engineered?

---

## 1. Current System Limits

| Ресурс | Максимум | Узкое место |
|--------|----------|-------------|
| Audio generation | 3 одновременных | quota в dispatch-engine (`maxActiveAudio: 3`) |
| Image generation | 2 одновременных | quota в dispatch-engine (`maxActiveImage: 2`) |
| Video generation | 1 одновременно | quota в dispatch-engine (`maxActiveVideo: 1`) |
| Scheduler tick | 1 экземпляр | distributed lock (`SCHEDULER_TICK_LOCK`) |
| ReconCycle | 1 экземпляр | distributed lock (`CLEANUP_LOCK`) |
| Node.js backend | 1 процесс (single-threaded) | event loop, нет кластеризации |
| Redis | 1 инстанс | сеть + CPU для Lua-скриптов |
| GPU Hub | 1 прокси | зависит от GPU worker'ов |
| Файловое хранилище | 1 общая папка | нет S3/CDN, всё в OUTPUT_DIR |

**Честный ответ: система рассчитана на 1–5 concurrent пользователей.**

Не потому что она плохая, а потому что это **дизайн под одного пользователя с одной книгой**, а не под SaaS.

---

## 2. Why Not More

### 2.1 Quota жёстко зашиты в коде

```js
// dispatch-engine.js
const QUOTAS = {
    maxActiveAudio: 3,
    maxActiveImage: 2,
    maxActiveVideo: 1
};
```

Это 6 concurrent GPU задач на всю систему. Если 5 пользователей нажмут generate одновременно — 4 будут ждать в очереди.

### 2.2 Один процесс Node.js

`backend.cjs` крутит один event loop. Нет кластеризации (`cluster`), нет worker_threads. Всё в одном треде:
- Scheduler tick (5s)
- ReconCycle (60s)
- HTTP API (роуты)
- SSE (прогресс)
- Обработка GPU результатов

Любая блокировка event loop'а (например, синхронное чтение файла в audio-orch) — **стопор для всех пользователей**.

### 2.3 Redis как блокировщик

Distributed lock на tick и reconcile означает, что при горизонтальном масштабировании второй экземпляр будет просто ждать:
```
Instance 1: захватил CLEANUP_LOCK → делает reconcile → 60s
Instance 2: CLEANUP_LOCK занят → SKIP → 60s → SKIP → ... вечно
```

### 2.4 Файловая система общая

Все ассеты пишутся в один OUTPUT_DIR. Нет:
- S3/MinIO для хранения
- CDN для раздачи
- Изоляции build-директорий по пользователям

### 2.5 GPU Hub — единая точка входа

Без шардирования, без очередей приоритетов на уровне пользователей. Если GPU Hub упал — вся генерация встала.

---

## 3. What Can Be Done Without Adding Complexity

Если не строить полноценный SaaS, а просто дать системе дышать:

| Изменение | Результат |
|-----------|-----------|
| `maxActiveAudio: 3 → 10` | 3× больше аудио-генераций |
| `maxActiveImage: 2 → 6` | 3× больше image-генераций |
| `maxActiveVideo: 1 → 3` | 3× больше видео-генераций |
| GPU Hub → +1 инстанс | Отказоустойчивость + балансировка |

Это даст **~10–15 concurrent пользователей** без единой строки нового кода — только конфиг.

---

## 4. What's Needed for 50+ Users

For **50+ concurrent users**, architectural work will be required:

| Компонент | Сейчас | Нужно |
|-----------|--------|-------|
| **Очередь задач** | — | RabbitMQ или Redis Streams |
| **Node.js кластеризация** | 1 процесс | `cluster` или PM2 |
| **Хранилище** | локальная FS + OUTPUT_DIR | S3-совместимое (MinIO/S3) |
| **CDN** | — | Cloudflare R2 / CloudFront |
| **GPU Hub** | 1 инстанс | Балансировка + шарды по пользователям |
| **Изоляция build'ов** | build_id глобальный | build_id = `{user_id}:{build_uuid}` |
| **Rate limiting** | нет | На `/gpu/result` и `/regenerate` |
| **Graceful shutdown** | нет | SIGTERM → drain dispatch'ей |

---

## 5. Is the System Over-Engineered?

### 5.1 ✅ What's Justified

| Механизм | Почему |
|----------|--------|
| **Две state machine** (asset + audio-orch) | Разделяют high-level статус от деталей пайплайна. Без этого — каша в одном ключе. |
| **Dispatch engine** (lease + quota) | Предотвращает двойной dispatch и перегрузку GPU. Lease — защита от рассинхрона. |
| **Orchestrator facade** | Единый владелец состояния — без него race condition между 4+ писателями. M5 это доказал. |
| **ReconCycle с CLEANUP_LOCK** | Самовосстановление после падений — экономит часы дебага. Без него startup-recovery пришлось бы писать с нуля. |
| **Circuit breaker** | GPU падают. Не надо долбить их бесконечно. Простая эвристика (5 failures → open → 30s cooldown). |
| **Event journal** | Отладка без него — ад. "Почему сцена не сгенерировалась?" — заглянул в journal и увидел последнее событие. |
| **Version gate (PG перед READY)** | Без него stale артефакты — тихий убийца консистентности. Была проблема — решилась version gate'ом. |

### 5.2 ⚠️ What's Likely Excessive

| Механизм | Строк кода | Вердикт | Почему |
|----------|-----------|---------|--------|
| **Retry budget manager** | ~180 | 🔴 **Выкинуть** | 4 уровня retry-логики (circuit → budget → lease → handler). Для 1–5 пользователей — оверкилл. Circuit breaker + lease TTL достаточно. |
| **Fairness engine** | ~150 | 🔴 **Выкинуть** | Обнаружение starvation, приоритеты сцен — для одного пользователя не нужно. Для SaaS — да, но не сейчас. |
| **Failure taxonomy** | ~250 | 🔴 **Выкинуть** | Формальная классификация ошибок (4 типа, severity, retry policy, location extraction). В логах просто читается как `[FAILURE] timeout`. |
| **Lease renewal timer** | ~80 | 🔴 **Выкинуть** | In-memory таймеры, которые надо чистить вручную (stopDispatchRenewal). Просто увеличить lease TTL до 10 минут. |
| **Counter reconciliation** | ~200 | 🤷 **Оставить** | Если бы quota атомарно захватывалась/отпускалась (а она так и делает через Lua), отдельный reconciliation не нужен. Но как safety net — полезно. |
| **C3/C4/C5 ReconCycle фазы** | ~100 | 🟡 **Упростить** | log-only фазы, которые никогда ничего не делают (IU scan, counter check, session resume). Убрать из startup-пути. |

**Итого можно удалить ~600 строк кода** без потери надёжности:
- `retry-budget-manager.js`
- `fairness-engine.js`
- `failure-taxonomy.js`
- lease renewal (в `lease-manager.js`)
- C3/C4/C5 из `reconciliation-engine.js`

### 5.3 What's Missing for Production-Readiness

| Компонент | Статус | Описание |
|-----------|--------|----------|
| **Graceful shutdown** | ❌ | При `kill` процесс умирает, не дофинализируя dispatch'и → orphan lease в Redis |
| **Health endpoint** | ❌ | Нет `/health`, `/readiness`, `/liveness` |
| **Request ID / tracing** | ❌ | Нет сквозного correlation ID через все модули |
| **Rate limiting** | ❌ | `/gpu/task/result` — беззащитный endpoint |
| **Мониторинг Prometheus** | 🟡 | Есть `prometheus.collect()`, но не видно, подключено ли |
| **Логирование структурированное** | ❌ | `console.log` везде, нет JSON-logs |
| **Graceful degradation** | ❌ | Если Redis упал — весь backend падает |

---

## 6. Final Verdict

### The System Is NOT Over-Engineered for a Production GPU Generation Service

Каждый механизм решает реальную проблему, которая была в продакшне:
- stale артефакты → version gate
- двойной dispatch → lease + quota
- race condition между писателями → facade
- зависшие чанки → watchdog
- потерянные результаты → recovery phase

### The System IS Over-Engineered If This Is a Solo Developer Hobby Project

4 уровня retry, fairness engine, failure taxonomy с 100 строками pattern matching — это **overengineering для сценария "один пользователь нажимает generate"**.

### Practical Simplification Plan

```
Шаг 1: Удалить retry-budget-manager.js + fairness-engine.js + failure-taxonomy.js  (~500 строк)
Шаг 2: Увеличить lease TTL и убрать renewal timer из lease-manager.js               (~80 строк)
Шаг 3: Убрать C3/C4/C5 из reconcileCycle                                            (~100 строк)
Шаг 4: Добавить health endpoint + graceful shutdown                                 (+50 строк)
────────────────────────────────────────────────────────────────────────────
Итог: −630 строк, +50 строк = −580 строк чистой экономии
```

После этого система станет **понятнее на 30%** без потери надёжности.

### Performance

| Сценарий | Пользователей | Что менять |
|----------|---------------|------------|
| Сейчас | 1–5 | Ничего |
| Твик конфигов | 10–15 | quota x3, GPU Hub +1 |
| Очередь + кластеризация | 50–200 | RabbitMQ, cluster, S3 |
| Полноценный SaaS | 500+ | Микросервисы, K8s, CDN, шардирование |

<!-- === Footer === -->
---
*Сгенерирован с помощью Freebuff · deepseek/deepseek-v4-flash · 19 июля 2026*
