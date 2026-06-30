# Architecture Review: Animastor

## Что уже хорошо

### 1. Dual-storage стратегия (PostgreSQL + Redis)

Разделение ответственности верное: PostgreSQL — каноническая истина, Redis — runtime-состояние и очереди. Redis-персистентность через docker volume `redis-data:/data` — дополнительная защита.

### 2. Lease-based dispatch

Механизм аренды через Redis `SET NX` + TTL (30min audio, 60min image, 120min video) — надёжная защита от дублирования dispatch'а. Очистка stale leases при старте — правильная практика.

### 3. Per-asset state machine (DUAL MODEL)

Внедрена Dual State Model: per-asset состояния (NEW → DIRTY → PENDING → GENERATING → READY | FAILED | PLACEHOLDER) стали каноническим источником истины. Linear FSM сохранён как производная проекция для обратной совместимости. Audio и image могут диспатчиться независимо (параллельно). Video правильно зависит от image=READY.

### 4. Governance слой (хотя в DEBUG)

Circuit breaker, retry budget, fairness engine, policy engine — зрелый набор механизмов, загружаемых лениво. Не в core pipeline, но готовы к активации.

### 5. Scene window + scope-aware генерация

Оконная обработка (3 сцены за раз) + scope (`current_scene`, `current_chapter`, `from_current_scene`, `whole_book`). Добавлена проверка контента на диске (`sceneHasValidContent`), восстановление статусов чанков (`reconcileWindowStatuses`, `restoreChunkStatusForScene`), cancel-флаг.

### 6. Workflow Loader + deep clone

Шаблоны immutable — каждый вызов `getWorkflow()` возвращает `JSON.parse(JSON.stringify(template))`.

### 7. Архитектурная эссенция (`architectural-essence.md`)

Философия проекта (книга = процесс последовательного чтения) — чёткая и продуманная модель.

### 8. Graceful shutdown — ИСПРАВЛЕНО

Добавлены SIGTERM-обработчики в backend.cjs И gpu-hub.js. Последовательное завершение: HTTP → Redis → PostgreSQL.

### 9. Startup resume

Добавлен механизм возобновления прерванных сессий генерации при старте (startup-resume.js). PostgreSQL запрос active sessions → перезапуск.

### 10. Book Source / Sync / Integrity

Внедрены три новых сервиса для поддержания консистентности Book JSON ↔ PostgreSQL:
- **Book Source** — канонический индекс сцен
- **Book Sync** — синхронизация через scene_hash (added/changed/removed detection)
- **Book Integrity** — orphan detection во всех scene-keyed таблицах

---

## Что стоит изменить

### 🔴 Критично (риск отказа системы)

#### 1. GPU Hub — единая точка отказа

Все GPU-задачи проходят через единственный экземпляр GPU Hub.

**Улучшено:** Health check с auto-restart, requeue при timeout (10 min), дедупликация, graceful shutdown.

**Что делать:**
- Добавить multi-instance GPU Hub с Redis Pub/Pub для синхронизации состояния
- Или, как минимум, задокументировать RTO/RPO

**Затрагиваемые компоненты:** `gpu-hub/gpu-hub.js`, `docker-compose.yml`

#### 2. Dual State Model — избыточная сложность

Per-asset + linear FSM. Per-asset — канонический, linear — производная проекция. Требует `syncLinearState()` после каждого `setAssetState()`.

**Что делать:** После полного перехода на per-asset модель — удалить linear FSM и все `syncLinearState` вызовы.

**Затрагиваемые компоненты:** `scene-state.js`, `scene-orchestrator.js`

#### 3. Два event-журнала (Redis + PostgreSQL)

Redis event-journal.js (TTL 7 дней) дублирует функциональность book-event-log.js (PostgreSQL).

**Что делать:** Удалить Redis event journal, оставить только PostgreSQL.

**Затрагиваемые компоненты:** `event-journal.js`, `book-event-log.js`

---

### 🟡 Высокий приоритет (качество кода)

#### 4. Нет единой абстракции генераторов

Audio, Image, Video — три независимых сервиса с разными интерфейсами. Добавление нового типа генерации требует изменений в 5+ файлах.

**Что делать:** Ввести интерфейс Generator с registry, заставить orchestrator работать через registry.

#### 5. Отсутствие тестов на критических компонентах

Из 14 тестовых файлов ни один не покрывает scene-orchestrator, dispatch-engine, runtime-scheduler, agent-service.

**Что делать:** scene-state.js (dual model) — чистые функции, с них и начать.

#### 6. book-routes.cjs — чрезмерная ответственность (~1800+ строк)

~30 endpoint'ов в одном файле.

**Что делать:** Разделить на import-routes, agent-routes, book-routes.

---

### 🟢 Средний приоритет (долгосрочные улучшения)

#### 7. Нет абстракции AI-провайдера

OpenRouter API и Nvidia API — оба поддерживаются, но механизм автоматического переключения отсутствует.

**Что делать:** `class AIProvider` с `call()` → OpenRouterProvider, NvidiaProvider. Стратегия: primary → fallback → error.

#### 8. Governance модули в DEBUG

15+ модулей на диске, загружаются через safeRequire (могут быть не загружены). Мёртвый код.

**Что делать:** Либо интегрировать в core pipeline, либо удалить с диска.

#### 9. База знаний AI не используется

knowledge-base.js + ai-loader.js загружают rules/skills, но не используют в промптах. (Исключение: refineDraft использует examples.)

**Что делать:** Либо использовать, либо удалить.

#### 10. Нет версионирования API

Все `/api/v1/`, но механизма обратной совместимости нет.

---

### ⚪ Низкий приоритет (опционально)

#### 11. Русские progress-сообщения
PROGRESS_STAGES на русском. Вынести в locale-файлы.

#### 12. Логи через console.log
Заменить на pino/winston с JSON-форматом.

#### 13. Размер окна AI-пайплайна
WINDOW_SIZE=3, MAX_WINDOW_CHARS=4000 — консервативно. Сделать динамическим.

---

## Резюме

### НЕ ТРОГАТЬ
- Философию проекта (книга = процесс чтения)
- Dual-storage стратегию (PG + Redis)
- Lease-based dispatch
- Scene window + scope-aware generation
- Multi-file book format (v2.1)

### СДЕЛАТЬ В ПЕРВУЮ ОЧЕРЕДЬ (дни, не недели)
1. Очистить мёртвый код: governance modules из DEBUG (либо интегрировать, либо удалить)
2. Очистить дублирующиеся event-журналы
3. Тесты на state machine (dual model)

### ЗАПЛАНИРОВАТЬ (спринты)
4. Единый интерфейс генераторов (Generator interface + registry)
5. Абстракция AI-провайдера (OpenRouter ↔ Nvidia ↔ local)
6. Полный переход на per-asset модель (удаление linear FSM)

### ОБСУДИТЬ
7. Версионирование API
8. Redis persistence для очередей
9. Мультиязычность
