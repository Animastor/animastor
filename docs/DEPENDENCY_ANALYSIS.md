# Dependency Analysis: Animastor

## Метод анализа

Анализ выполнен на основе статического анализа кода: `require()`/`import` зависимостей, архитектурных паттернов вызовов, и логических связей между модулями.

---

## 1. Циклические зависимости

### 1.1 backend.cjs ↔ task-handler.cjs

- `backend.cjs` импортирует `task-handler.cjs`
- `task-handler.cjs` получает `backend.cjs` через DI (объект deps) и использует экспортированные модули

**Тип:** Косвенная циклическая зависимость через DI-контейнер.

### 1.2 scene-orchestrator.js ↔ dispatch-engine.js

- `scene-orchestrator.js` вызывается `dispatch-engine.js` для выполнения dispatch'а
- `dispatch-engine.js` является частью runtime, который импортируется `scene-orchestrator.js` через цепочку вызовов

**Тип:** Функциональная циклическая зависимость. Orchestrator вызывает dispatch-engine (через runtime-scheduler), dispatch-engine вызывает orchestrator.

---

## 2. Сильные связности

### 2.1 backend.cjs (центральная точка связывания)

**Проблема:** `backend.cjs` является **единственной точкой** DI всех зависимостей. Он импортирует ~30 модулей и передаёт зависимости в 4 route-модуля.

**Связность:** Высокая. Любая новая зависимость требует изменений в backend.cjs.

**Затрагиваемые компоненты:**
- Все 4 route-модуля (book-routes, generation-routes, ai-routes, debug-routes)
- task-handler.cjs (получает deps)
- book-diff.cjs (получает deps)
- audio-recovery.cjs (получает deps)

### 2.2 scene-orchestrator.js (~173 строки, фасад)

**Проблема (было):** Содержал логику диспетчеризации, обработки callback'ов, state management, layer config checks, padded text trimming.

**Исправлено:** Логика вынесена в `scene-callbacks.js`, `scene-restoration.js`, `scene-utils.js`. Сейчас `scene-orchestrator.js` — фасад **~173 строки**.

**Связность (историческая):** Зависит от:
- audio/index.js, image/index.js, video/index.js
- scene-state.js (dual model: per-asset + linear FSM)
- event-journal.js
- active-scenes-index.js
- layer-config.js
- gpu-dispatcher.js
- asset-registry.js
- placeholder-audio.js
- dispatch-engine.js
- runtime-scheduler.js
- scene-window.js
- worker-health.js

### 2.3 book-routes.cjs (~1800+ строк)

**Проблема:** Содержит все endpoints для книг, включая импорт, bootstrap, trigger-next-window, agent-status, generation-state, и десятки других.

**Связность:** Чрезвычайно высокая. Зависит от ~20+ сервисов.

---

## 3. Потенциальные архитектурные узкие места

### 3.1 GPU Hub (единая точка отказа)

**Проблема:** Все GPU-задачи проходят через единственный GPU Hub.

**Текущее состояние (улучшено):**
- ✅ REQUEUE при timeout воркера (10 min)
- ✅ Дедупликация задач
- ✅ Graceful shutdown
- ❌ Нет failover, нет репликации

### 3.2 Redis (единая точка отказа для runtime)

**Проблема:** Runtime-состояние (active scenes, dispatch leases, quotas, event journal, worker health, очереди) полностью зависит от Redis.

**Текущее состояние:**
- ✅ Redis persistence через docker volume (redis-data:/data)
- ❌ Нет Redis Sentinel/Cluster конфигурации в docker-compose

### 3.3 OpenRouter API / Nvidia API (единая точка отказа для AI)

**Проблема:** Весь AI-пайплайн (agent-service, chat-engine) зависит от внешнего API.

**Текущее состояние:**
- ✅ AI_API_BASE_URL конфигурируется (OpenRouter, Nvidia, custom)
- ❌ Нет автоматического переключения между провайдерами
- ❌ Нет fallback цепочки

### 3.4 Runtime Scheduler (единственный планировщик)

**Проблема:** Весь прогресс генерации зависит от одного tick-планировщика (5s). При его остановке — генерация сцен прекращается.

---

## 4. Компоненты с чрезмерной ответственностью

### 4.1 scene-orchestrator.js

> **UPD 2026-06-26:** Логика callback'ов вынесена в `scene-callbacks.js` (R3). Сейчас orchestrator — фасад ~173 строки.
> stale state tolerance убран (R3.1 = R6.5).
> GENERATING per-asset добавлен при диспатче (Н.7/§5.1).

**Текущая ответственность:**
- Dispatch execution для audio/image/video
- Layer config checks (audio_enabled/image_enabled/video_enabled)
- Lane management (completeWithoutVideo/Image)
- Event journal logging

**Ответственность (ВЫНЕСЕНА в scene-callbacks.js):**
- Callback handling для всех трёх типов
- State machine management (per-asset state)

**Убрано:**
- stale state tolerance (R6.5)
- padded text trimming (в audio-service, передаётся через DI)
- syncLinearState вызовы (→ per-asset API, R6.1)

**Оценка:** Существенно уменьшена, но всё ещё фасад с несколькими обязанностями.

### 4.2 book-routes.cjs

**Ответственность:**
- CRUD книг
- Импорт TXT (декодирование, дедупликация)
- Bootstrap (запуск AI-пайплайна)
- Trigger next window
- Agent status
- Generation state
- Chunk management
- Slide window
- Scene reorder
- Book diff/apply

**Оценка:** Слишком много ответственности для одного файла.

### 4.3 dispatch-engine.js (~1000 строк)

**Ответственность:**
- Lease management
- Quota management
- Circuit breaker integration (safeRequire)
- Retry budget integration (safeRequire)
- Fairness engine integration (safeRequire)
- Policy engine integration (safeRequire)
- Decision tracing
- Counter reconciliation

**Оценка:** Интегрирует слишком много cross-cutting concerns. Однако governance-модули загружаются лениво (safeRequire).

### 4.4 scene-state.js

**Ответственность:**
- Dual state model (per-asset + linear FSM)
- State transitions для обоих моделей
- Heartbeat management
- Stuck detection
- Redis read/write

---

## 5. Компоненты, через которые проходит слишком много логики

### 5.1 backend.cjs

**Поток логики:**
- Инициализация → подключение Redis/PG
- Загрузка workflow
- DI всех сервисов (30+)
- Монтирование всех роутов
- Запуск runtime loop
- Запуск cleanup/audio-recovery/startup-resume
- Graceful shutdown

**Оценка:** ~265 строк для ~30 зависимостей.

### 5.2 task-handler.cjs

**Поток логики:**
- Callback от GPU Hub (audio, image, video)
- IU image completion с проверкой PG
- Аудио-мерж с padded text trimming
- Регистрация asset'ов

### 5.3 scene-orchestrator.js

**Поток логики:**
- dispatching → выполнение → callback → state update → window slide
- Проходит через orchestrator практически вся бизнес-логика

**Оценка:** Является центральным "мозгом" системы.

---

## 6. Slim runtime (v2.0.0)

Модуль `runtime/index.js` экспортирует только core pipeline. Governance-модули загружаются лениво через `runtime.index.debug`.

**Core (всегда загружены):**
- scheduler, loop, activeScenes, reconciliation, dispatch, leaseManager, counterReconciliation, metrics, gpuDispatcher, workerHealth, sceneWindow

**Error handling (загружены):**
- failureTaxonomy, retryManager, retentionManager

**Debug (ленивая загрузка):**
- snapshotManager, circuitBreaker, priorityManager, fairness, retryBudget, policyEngine, workloadClassifier, costEstimator, decisionTrace, feedback, governanceMetrics, adaptationController, governanceStability, governanceHealth, executionSemantics

**Debug/Experimental (ленивая загрузка):**
- policySimulator, sandbox, failureReplay, validator

---

## Визуализация графа зависимостей (критические пути)

```
                    ┌──────────────────────┐
                    │     backend.cjs      │◄─── Центральный DI (30+ зависимостей)
                    └──────────┬───────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         ▼                     ▼                      ▼
   ┌──────────┐       ┌──────────────┐       ┌──────────────┐
   │ Routes   │       │  Runtime     │       │  Services    │
   │ (4 файла)│       │  Scheduler   │       │  (20+)       │
   └──────────┘       └──────┬───────┘       └──────────────┘
                             │
                    ┌────────┴────────┐
                    │  Dispatch       │
                    │  Engine         │
                    │  (lazy gov.)    │
                    └────────┬────────┘
                             │
                    ┌────────┴────────┐
                    │  Scene          │◄─── Чрезмерная ответственность
                    │  Orchestrator   │     (1200 строк, layer-aware)
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                    ▼
   ┌──────────┐      ┌───────────┐       ┌──────────┐
   │  Audio   │      │   Image   │       │  Video   │
   │  Service │      │  Service  │       │  Service │
   └──────────┘      └───────────┘       └──────────┘
         │                  │                   │
         └──────────────────┼───────────────────┘
                            ▼
                    ┌──────────────┐
                    │GPU Dispatcher│
                    │  (3 retries) │
                    └──────┬───────┘
                           │
                    ┌──────┴───────┐
                    │   GPU Hub    │◄─── Единая точка отказа
                    │ (10min t/o)  │     (+ requeue)
                    └──────────────┘
```
