# Architecture Review: Animastor

## Что уже хорошо

### 1. Dual-storage стратегия (PostgreSQL + Redis)

Разделение ответственности верное: PostgreSQL — каноническая истина, Redis — runtime-состояние и очереди. Это даёт и consistency, и производительность. PG не забивается transient-данными, Redis не является source of truth для критических данных.

### 2. Lease-based dispatch

Механизм аренды через Redis `SET NX` + TTL (30min audio, 60min image, 120min video) — надёжная защита от дублирования dispatch'а. То, что при старте очищаются stale leases (`backend.cjs:218-245`), — правильная практика, предотвращающая DISPATCH_SKIPPED_DUPLICATE петли после рестарта.

### 3. Per-asset state machine

`AssetState` (`NEW → DIRTY → PENDING → GENERATING → READY | FAILED | PLACEHOLDER`) независимо для audio/image/video — гибче, чем монолитный FSM. Audio и image могут обрабатываться параллельно. Video правильно зависит от image=READY.

### 4. Governance слой

Circuit breaker, retry budget, fairness engine, policy engine — неожиданно зрелый набор механизмов устойчивости для проекта такого размера. Особенно fairness engine (предотвращение голодания сцен) и cost estimator (потенциал для оптимизации).

### 5. Scene window + scope-aware генерация

Оконная обработка (3 сцены за раз) + scope (`current_scene`, `current_chapter`, `from_current_scene`, `whole_book`) даёт пользователю раннюю обратную связь. Грамотный баланс между скоростью и качеством.

### 6. Workflow Loader + deep clone

Шаблоны immutable — каждый вызов `getWorkflow()` возвращает `JSON.parse(JSON.stringify(template))`. Это предотвращает случайные мутации и race conditions.

### 7. Архитектурная эссенция (`architectural-essence.md`)

Редкая и ценная практика — документ, объясняющий философию проекта (книга = процесс последовательного чтения, а не статический текст). Три источника истины (TXT, currentOffset, JSON) — чёткая и продуманная модель данных.

---

## Что стоит изменить

### 🔴 Критично (риск отказа системы)

#### 1. GPU Hub — единая точка отказа

Все GPU-задачи проходят через единственный экземпляр GPU Hub. При его падении вся генерация останавливается. Нет механизма failover, нет репликации очередей.

**Что делать:**
- Health check с auto-restart в docker-compose (уже есть — проверить)
- Добавить multi-instance GPU Hub с Redis Pub/Sub для синхронизации состояния
- Или, как минимум, задокументировать RTO/RPO

**Затрагиваемые компоненты:** `gpu-hub/gpu-hub.js`, `docker-compose.yml`

#### 2. Отсутствие graceful shutdown

`backend.cjs` не обрабатывает сигналы `SIGTERM`/`SIGINT`. При остановке контейнера:
- Dispatch leases не снимаются (очищаются только при следующем старте)
- Runtime loop обрывается принудительно
- Redis/PG соединения закрываются аварийно

**Что делать:**
```js
process.on('SIGTERM', async () => {
  log('[SHUTDOWN] Graceful shutdown initiated');
  runtime.loop.stop();
  await redis.quit();
  await storage.postgres.close();
  process.exit(0);
});
```
Это ~20 строк кода, но предотвращает проблемы при деплое и scale down.

**Затрагиваемые компоненты:** `backend/src/backend.cjs`

#### 3. Scene-orchestrator.js перегружен (1206 строк)

Смешивает:
- Dispatch execution (audio/image/video)
- Callback handling
- State machine management
- Event journal logging
- Lane management (completeWithoutVideo/Image)

**Что делать:**
Разделить на три файла без изменения логики:
- `scene-executor.js` — dispatch execution
- `scene-callbacks.js` — обработка результатов
- `scene-orchestrator.js` — только оркестрация (state decisions)

Это снизит риск регрессии при изменениях и улучшит тестируемость.

**Затрагиваемые компоненты:** `backend/src/orchestration/scene-orchestrator.js`

---

### 🟡 Высокий приоритет (качество кода)

#### 4. Нет единой абстракции генераторов

Audio, Image, Video — три независимых сервиса с разными интерфейсами. Добавление нового типа генерации требует изменений в 5+ файлах:
- `scene-orchestrator.js` (dispatch + callback)
- `dispatch-engine.js` (quota + lease)
- `scene-state.js` (AssetState enum)
- `layer-config.js`
- `runtime-scheduler.js` (shouldScheduleAssets)

**Что делать:**
Ввести интерфейс:
```js
class Generator {
  get assetType()          // 'audio' | 'image' | 'video'
  async execute(scene, book, buildId)
  async handleResult(bookId, chapterId, sceneId, buildId)
}
```
Зарегистрировать в GeneratorRegistry, заставить orchestrator работать через registry, а не прямой вызов сервисов.

**Затрагиваемые компоненты:** scene-orchestrator.js, dispatch-engine.js, scene-state.js, layer-config.js

#### 5. Отсутствие тестов на критических компонентах

Из 14 тестовых файлов ни один не покрывает:
- `scene-orchestrator.js` — центральная бизнес-логика
- `dispatch-engine.js` — механизмы устойчивости
- `runtime-scheduler.js` — планирование
- `agent-service.js` — AI-пайплайн

**Что делать:**
Начать с наиболее детерминированных и изолированных модулей:
1. `scene-state.js` — state machine (чистые функции, нет зависимостей)
2. `scene-orchestrator.js` — можно mock audio/image/video сервисы
3. `agent-service.js` — mock aiService

**Затрагиваемые компоненты:** Весь backend

#### 6. book-routes.cjs — чрезмерная ответственность (1800+ строк)

Один файл содержит ~30 endpoint'ов: CRUD, импорт TXT, bootstrap, trigger-next-window, agent-status, generation-state, chunk management, slide window, scene reorder, book diff.

**Что делать:**
- `book-routes.cjs` — только CRUD книг (GET/PUT/DELETE book)
- `import-routes.cjs` — импорт TXT/VBook, bootstrap
- `agent-routes.cjs` — agent-status, bootstrap-next-window
- `generation-routes.cjs` — уже существует, переместить оставшиеся endpoint'ы

**Затрагиваемые компоненты:** `backend/src/routes/book-routes.cjs`

---

### 🟢 Средний приоритет (долгосрочные улучшения)

#### 7. Нет абстракции AI-провайдера

OpenRouter API зашит в `ai-service.js`. Nvidia API определён как альтернатива, но механизм автоматического переключения отсутствует. При недоступности OpenRouter — AI-пайплайн и чат полностью недоступны.

**Что делать:**
```js
class AIProvider {
  async call(messages, options)  // interface
}
class OpenRouterProvider extends AIProvider { ... }
class NvidiaProvider extends AIProvider { ... }
```
Стратегия: primary → fallback → error. Конфигурация через ENV.

**Затрагиваемые компоненты:** `backend/src/services/ai-service.js`, `agent-service.js`, `chat-engine.cjs`

#### 8. Нет версионирования API

Все endpoint'ы используют `/api/v1/`, но механизма обратной совместимости нет. При изменении формата ответа — все клиенты сломаются.

**Что делать:**
Accept header (`application/vnd.animastor.v1+json`) или URL prefix (`/api/v2/`). Пока проект молодой и клиент один — сейчас лучшее время заложить версионирование.

**Затрагиваемые компоненты:** Все route-файлы, `BackendApi.kt`

#### 9. Мёртвый код: база знаний AI

`loadKnowledgeBase()` в `agent-service.js` загружает все файлы из `backend/ai/rules/` и `backend/ai/skills/`, но код содержит комментарий:
```js
// not used in prompts (line 1311)
```

**Что делать:**
Либо:
- Использовать (включить релевантные правила в system prompt)
- Или удалить загрузку и явно отметить директорию как документацию для разработчиков

Текущее состояние вводит в заблуждение новых разработчиков.

**Затрагиваемые компоненты:** `backend/src/services/agent-service.js`, `backend/src/services/ai-loader.js`

#### 10. Redis-очереди без persistence

Очереди GPU-задач в Redis (`animastor:queue:{audio,image,video}`) не имеют AOF/RDB. При падении Redis незавершённые задачи теряются.

**Что делать:**
- Если потеря задач допустима (task будет повторно отправлен scheduler'ом) — задокументировать допущение
- Если нет — включить AOF в конфигурации Redis или перейти на RabbitMQ

**Затрагиваемые компоненты:** `docker-compose.yml`, `gpu-hub/gpu-hub.js`

---

### ⚪ Низкий приоритет (опционально)

#### 11. Русские progress-сообщения

`PROGRESS_STAGES` в `agent-service.js` — на русском. Android клиент ожидает русские строки. При локализации потребуется полная переработка.

**Что делать:** Вынести в locale-файлы или хотя бы константы в отдельный модуль.

#### 12. Логи через console.log

Нет структурированного логгирования (JSON, уровни, корреляционные ID). В Docker-окружении это менее критично, но усложняет отладку.

**Что делать:** Заменить на `pino` или `winston` с форматом JSON.

#### 13. Размер окна AI-пайплайна

`WINDOW_SIZE=3`, `MAX_WINDOW_CHARS=4000` — консервативные значения. Для больших книг (>1000 страниц) это приведёт к сотням AI-вызовов и высокой стоимости.

**Что делать:** Сделать динамическим на основе размера книги или толерантности пользователя к ожиданию.

---

## Резюме

### НЕ ТРОГАТЬ
- Философию проекта (книга = процесс чтения)
- Dual-storage стратегию (PG + Redis)
- Lease-based dispatch
- Governance слой (circuit breaker, fairness, policy)
- Scene window + scope-aware generation

### СДЕЛАТЬ В ПЕРВУЮ ОЧЕРЕДЬ (дни, не недели)
1. Graceful shutdown (~20 строк)
2. Разделение scene-orchestrator (без изменения логики)
3. Тесты на state machine

### ЗАПЛАНИРОВАТЬ (спринты)
4. Единый интерфейс генераторов (Generator interface + registry)
5. Абстракция AI-провайдера (OpenRouter ↔ Nvidia ↔ local)
6. Очистка мёртвого кода (ai-loader)

### ОБСУДИТЬ
7. Версионирование API
8. Redis persistence для очередей
9. Мультиязычность
