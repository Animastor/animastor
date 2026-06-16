# Dependency Analysis: Animastor

## Метод анализа

Анализ выполнен на основе статического анализа кода: `require()`/`import` зависимостей, архитектурных паттернов вызовов, и логических связей между модулями.

---

## 1. Циклические зависимости

### 1.1 backend.cjs ↔ task-handler.cjs

- `backend.cjs` импортирует `task-handler.cjs` (строка 123)
- `task-handler.cjs` получает `backend.cjs` через DI (объект deps на строке 118-122) и использует экспортированные модули

**Тип:** Косвенная циклическая зависимость через DI-контейнер. backend.cjs создает taskHandler, который зависит от модулей, импортированных в backend.cjs.

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

### 2.2 scene-orchestrator.js (1206 строк)

**Проблема:** Содержит логику диспетчеризации, обработки callback'ов, state management, и интеграции со всеми тремя сервисами (audio/image/video).

**Связность:** Очень высокая. Зависит от:
- audio/index.js, image/index.js, video/index.js
- scene-state.js
- event-journal.js
- active-scenes-index.js
- layer-config.js
- gpu-dispatcher.js
- asset-registry.js

### 2.3 book-routes.cjs (1800+ строк)

**Проблема:** Содержит все endpoints для книг, включая импорт, bootstrap, trigger-next-window, agent-status, generation-state, и десятки других. Один файл отвечает за ~30+ endpoint'ов.

**Связность:** Чрезвычайно высокая. Зависит от ~20+ сервисов.

---

## 3. Потенциальные архитектурные узкие места

### 3.1 GPU Hub (единая точка отказа)

**Проблема:** Все GPU-задачи проходят через единственный GPU Hub. При его недоступности вся генерация останавливается.

**Статус:** Нет механизма failover, нет репликации.

### 3.2 Redis (единая точка отказа для runtime)

**Проблема:** Runtime-состояние (active scenes, dispatch leases, quotas, event journal, worker health, очереди) полностью зависит от Redis.

**Статус:** Нет Redis Sentinel/Cluster конфигурации в docker-compose.

### 3.3 OpenRouter API (единая точка отказа для AI)

**Проблема:** Весь AI-пайплайн (agent-service, chat-engine) зависит от OpenRouter API. При недоступности — импорт книг и AI-чат невозможны.

**Статус:** Nvidia API определён как альтернатива, но механизм автоматического переключения не обнаружен.

### 3.4 Runtime Scheduler (единственный планировщик)

**Проблема:** Весь прогресс генерации зависит от одного tick-планировщика. При его остановке — генерация сцен прекращается.

---

## 4. Компоненты с чрезмерной ответственностью

### 4.1 scene-orchestrator.js

**Ответственность:**
- Dispatch execution для audio/image/video
- Callback handling для всех трёх типов
- State machine management
- Event journal logging
- Quota management (decide/release)
- Lane management (completeWithoutVideo/Image)

**Оценка:** Нарушение Single Responsibility Principle.

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

### 4.3 dispatch-engine.js (1031 строка)

**Ответственность:**
- Lease management
- Quota management
- Circuit breaker integration
- Retry budget integration
- Fairness engine integration
- Policy engine integration
- Decision tracing
- Counter reconciliation

**Оценка:** Интегрирует слишком много cross-cutting concerns.

### 4.4 scene-state.js

**Ответственность:**
- Определение состояний сцены (SceneState enum)
- Определение состояний asset'ов (AssetState enum)
- State transitions
- Heartbeat management
- Redis read/write

---

## 5. Компоненты, через которые проходит слишком много логики

### 5.1 backend.cjs

**Поток логики:**
- Инициализация → подключение Redis/PG
- Загрузка workflow
- DI всех сервисов
- Монтирование всех роутов
- Запуск runtime loop
- Запуск cleanup/audio-recovery
- Startup recovery

**Оценка:** ~265 строк для ~30 зависимостей. Каждая новая функциональность требует изменения этого файла.

### 5.2 task-handler.cjs

**Поток логики:**
- Callback от GPU Hub (audio, image, video)
- Валидация результатов
- Вызов orchestrator.handle*Completed()
- Регистрация asset'ов

**Оценка:** Единственный вход для всех результатов GPU, но логика диспетчеризации простая.

### 5.3 scene-orchestrator.js

**Поток логики:**
- dispatching → выполнение → callback → state update → window slide
- Проходит через orchestrator практически вся бизнес-логика

**Оценка:** Является центральным "мозгом" системы, вся логика сходится в нём.

---

## Визуализация графа зависимостей (критические пути)

```
                    ┌─────────────┐
                    │  backend.cjs│◄─── Центральный DI (30+ зависимостей)
                    └──────┬──────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                  ▼
   ┌──────────┐    ┌──────────────┐   ┌────────────┐
   │ Routes   │    │  Runtime     │   │  Services  │
   │ (4 файла)│    │  Scheduler   │   │  (15+)     │
   └──────────┘    └──────┬───────┘   └────────────┘
                          │
                    ┌─────┴──────┐
                    │  Dispatch  │
                    │  Engine    │
                    └─────┬──────┘
                          │
                    ┌─────┴──────┐
                    │  Scene     │◄─── Чрезмерная ответственность
                    │  Orchestr. │
                    └─────┬──────┘
                          │
         ┌────────────────┼────────────────┐
         ▼                ▼                ▼
   ┌──────────┐    ┌───────────┐    ┌──────────┐
   │  Audio   │    │   Image   │    │  Video   │
   │  Service │    │  Service  │    │  Service │
   └──────────┘    └───────────┘    └──────────┘
         │                │                │
         └────────────────┼────────────────┘
                          ▼
                    ┌──────────────┐
                    │GPU Dispatcher│
                    └──────┬───────┘
                           │
                    ┌──────┴───────┐
                    │   GPU Hub    │◄─── Единая точка отказа
                    └──────────────┘
```
