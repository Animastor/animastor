# Architectural Debt: Animastor

## ✅ Resolved Bugs (Н.0–Н.9, 2026-06-26)

Нижеперечисленные баги закрыты в рамках спринта Н.0–Н.9. Подробности — в `docs/TODO_IMMEDIATE.md`.

| Код | Проблема | Статус | Коммит |
|---|---|---|---|
| **C1** | Двойной release квоты (markDispatchCompleted + callback) | ✅ | `4e007e2` |
| **C2** | PG `status='ready'` не пишется в колбэках | ✅ | `cf0a48a` |
| **C3** | Два registry с одинаковыми именами | ✅ | `5182455` |
| **C4** | Неидемпотентность /gpu/task/result (двойная обработка) | ✅ | `d804a77` |
| **M1** | Неатомарный RMW в per-asset state (GET+merge+SET) | ✅ | `1a0867d` |
| **M2** | Check-then-incr race в quota | ✅ | `636da04` |
| **M4** | Две системы лимитов (MAX_CONCURRENT + dispatch quotas) | ✅ | `0adc930` |
| **§5.1** | GENERATING не выставляется в per-asset при диспатче | ✅ | `f0b81de` |

---

## 1. Отсутствие формальной абстракции коннекторов

**Описание проблемы:** В проекте нет формального интерфейса или абстракции для коннекторов/адаптеров. Интеграция с GPU Hub, OpenRouter, PostgreSQL, Redis — прямые вызовы через HTTP и SQL.

**Причина возникновения:** Эволюционное развитие. Изначально проект создавался как монолит без планирования сменяемости внешних систем.

**Возможные последствия:** 
- Замена OpenRouter на другой AI-провайдер потребует изменений во всех сервисах, вызывающих aiService
- Замена ComfyUI на другую GPU-платформу потребует нового workflow-движка
- Невозможность A/B тестирования разных провайдеров

**Затрагиваемые компоненты:** ai-service.js, gpu-dispatcher.js, gpu-hub.js, worker.js, workflow-loader.js

---

## 2. Отсутствие абстрактного слоя генераторов

**Описание проблемы:** Audio, Image, Video сервисы имеют разные интерфейсы и не наследуют общий базовый класс. Невозможно добавить новый тип генерации без изменения orchestrator, dispatch-engine, scene-state.

**Причина возникновения:** Изначально была только audio-генерация, image и video добавлены позже как копия с модификациями.

**Возможные последствия:**
- Каждый новый тип генерации требует изменений в 5+ файлах
- Высокая вероятность несоответствия поведения нового типа существующим
- Дублирование кода в dispatch-engine (audio/image/video секции)

**Затрагиваемые компоненты:** scene-orchestrator.js, dispatch-engine.js, scene-state.js, runtime-scheduler.js, layer-config.js

---

## 3. Чрезмерная ответственность book-routes.cjs

**Описание проблемы:** Один файл содержит ~1800+ строк и ~30+ REST endpoint'ов. Смешивает CRUD, импорт, AI-пайплайн, управление генерацией, отладку.

**Причина возникновения:** Итеративное добавление endpoint'ов в существующий файл для простоты.

**Возможные последствия:**
- Сложность поддержки и тестирования
- Высокая вероятность конфликтов при параллельной разработке
- Нарушение Single Responsibility Principle

**Затрагиваемые компоненты:** book-routes.cjs

---

## 4. Чрезмерная ответственность scene-orchestrator.js (ЧАСТИЧНО ИСПРАВЛЕНО)

**Описание проблемы (было):** ~1200 строк, смешивающих dispatch execution, callback handling, state management, layer config, padded text trimming.

**Что сделано:** Логика вынесена в `scene-callbacks.js` (~17 КБ), `scene-restoration.js`, `scene-utils.js`. Сейчас `scene-orchestrator.js` — фасад **~173 строки**. stale state tolerance убран (R3.1/R6.5).

**Остаётся:** inline require() внутри scene-callbacks.js (8+ мест) — скрытые циклические зависимости.

> **UPD 2026-06-26:** Размер orchestrator исправлен (~173, не ~1200). Код: `orchestration/*`.

---

## 5. Смешение runtime и бизнес-логики в dispatch-engine.js

**Описание проблемы:** ~1000 строк, содержащая lease management, quota, circuit breaker, retry budget, fairness, policy, decision trace — все cross-cutting concerns в одном файле.

**Причина возникновения:** Постепенное добавление механизмов устойчивости без выделения слоёв.

**Возможные последствия:**
- При изменении одного механизма (например, retry budget) есть риск сломать другие
- Невозможность переиспользовать отдельные механизмы в других контекстах

**Затрагиваемые компоненты:** dispatch-engine.js

---

## 6. Знание о AI-модели захардкожено

**Описание проблемы:** Модель по умолчанию (`qwen/qwen3.5-122b-a10b`) задаётся в runtime-config.js. docker-compose использует другую модель (`qwen/qwen3-32b`). Нет абстракции "модель AI" с интерфейсом и разными реализациями.

**Текущее состояние (частично исправлено):**
- ✅ `OPENROUTER_API_KEY` унифицирован как единый источник ключа во всех AI-вызовах
- ✅ AI-роуты используют `config.OPENROUTER_API_KEY` вместо `process.env.AI_API_KEY`
- ✅ AI_API_BASE_URL конфигурируется через env (по умолчанию Nvidia)
- ❌ По-прежнему нет абстракции AI-провайдера
- ❌ Нет fallback цепочки между OpenRouter и Nvidia
- ❌ Провайдер-специфичный код размазан по ai-service.js

**Затрагиваемые компоненты:** agent-service.js, ai-service.js, chat-engine.cjs

---

## 7. Отсутствие unit-тестов для критических компонентов

**Описание проблемы:** Из 14 тестовых файлов большинство тестируют изолированные утилиты. Критические компоненты (scene-orchestrator, dispatch-engine, runtime-scheduler, agent-service) не имеют тестов.

**Причина возникновения:** Тесты писались post-factum для наиболее стабильных или простых модулей.

**Возможные последствия:**
- Высокий риск регрессии при изменениях в orchestrator, dispatch-engine
- Невозможность безопасного рефакторинга
- Ручное тестирование как единственный метод верификации

**Затрагиваемые компоненты:** scene-orchestrator.js (refactored to ~173 lines), dispatch-engine.js, runtime-scheduler.js, agent-service.js

---

## 8. GPU Hub как единая точка отказа

**Описание проблемы:** Все GPU-задачи проходят через один экземпляр GPU Hub. При его падении — вся генерация останавливается.

**Текущее состояние (улучшено):**
- ✅ REQUEUE при timeout воркера (10 min)
- ✅ Дедупликация задач (NX EX 3600)
- ✅ Graceful shutdown (SIGTERM)
- ❌ Нет multi-instance GPU Hub
- ❌ Нет репликации очередей Redis

**Затрагиваемые компоненты:** gpu-hub.js, gpu-dispatcher.js, dispatch-engine.js

---

## 9. Отсутствие интернационализации прогресс-сообщений

**Описание проблемы:** Прогресс-сообщения в agent-service.js (PROGRESS_STAGES) на русском языке. Android-приложение ожидает русские сообщения.

**Причина возникновения:** Проект ориентирован на русскоязычных пользователей.

**Возможные последствия:**
- Невозможность локализации без изменения backend
- Смешение языка кода (английский) и данных (русский)

**Затрагиваемые компоненты:** agent-service.js, GenerateViewModel.kt

---

## 10. Отсутствие версионирования API

**Описание проблемы:** Все endpoint'ы используют `/api/v1/`, но нет механизма версионирования (заголовки, нейминг, compatibility layer).

**Причина возникновения:** Проект на ранней стадии развития.

**Возможные последствия:**
- Невозможность обратно совместимых изменений API
- При изменении формата ответа — сломаются все клиенты

**Затрагиваемые компоненты:** Все route-файлы, BackendApi.kt

---

## 11. База знаний AI загружается, но не используется

**Описание проблемы:** `knowledge-base.js` загружает все правила/навыки из `backend/ai/`, но код не использует их в промптах. `ai-loader.js` также загружает их с TTL-кэшем. Это мёртвый код.

**Исключение:** `refineDraft()` в `ai-service.js` загружает примеры из `ai/examples/` и включает их в промпт.

**Причина возникновения:** Вероятно, база знаний была подготовлена для будущего использования или использовалась на ранних этапах.

**Возможные последствия:**
- Избыточная загрузка данных при старте
- Вводящая в заблуждение структура (разработчик может думать, что правила используются)

**Затрагиваемые компоненты:** agent-service.js, ai-loader.js, knowledge-base.js

---

## 12. Размер окна и ограничения AI-пайплайна

**Описание проблемы:** WINDOW_SIZE=3, MAX_WINDOW_CHARS=4000 могут быть недостаточны для больших книг, вызывая большое количество окон и соответственно AI-вызовов.

**Причина возникновения:** Выбраны консервативные значения для стабильности.

**Возможные последствия:**
- Высокая стоимость AI-вызовов для больших книг
- Долгое время импорта
- Потеря контекста между окнами

**Затрагиваемые компоненты:** agent-service.js

---

## 13. Нет graceful shutdown *(ИСПРАВЛЕНО)*

**Описание проблемы (было):** backend.cjs не обрабатывает сигналы SIGTERM/SIGINT для корректного завершения процессов, снятия аренд (leases), сохранения состояния.

**Исправлено:** Добавлены SIGTERM-обработчики:
- `backend.cjs`: server.close() → redis.quit() → postgres.closePool()
- `gpu-hub.js`: server.close() → redis.quit()

**Затрагиваемые компоненты:** backend.cjs, gpu-hub.js

---

## 14. Отсутствие метрик и мониторинга

**Описание проблемы:** Нет системы сбора метрик (Prometheus, OpenTelemetry, etc.).

**Текущее состояние (частично исправлено):**
- ✅ Добавлены security headers (Helmet.js)
- ✅ Добавлен rate limiting (500 req/min)

> **UPD 2026-06-26:** Исправлен rate limit (500, не 100). Код: `backend.cjs:64-65`.
- ✅ Добавлена трассировка запросов через requestId
- ✅ Добавлены runtime metrics (runtime-metrics.js)
- ✅ Добавлен runtime loop с history (100 ticks)
- ❌ По-прежнему нет метрик CPU/memory/GPU
- ❌ Нет внешнего мониторинга (Prometheus/Grafana)

**Затрагиваемые компоненты:** Все модули (используют console.log/warn/error)

---

## 15. Slim runtime — governance модули в debug (ЧАСТИЧНО ИСПРАВЛЕНО)

**Описание проблемы (было):** В v2.0.0 runtime/index.js был "slim"-нут: governance-модули (circuit-breaker, fairness, policy-engine и др.) вынесены из core pipeline в debug-секцию и загружаются лениво. Файлы сохранены на диске, но не входят в основной цикл.

**Что сделано (Phase 6, R6.4):**
- circuitBreaker, retryBudget, fairness — переведены с safeRequire на прямой require() и реально вызываются в dispatch-engine
- policyEngine, workloadClassifier, costEstimator — удалены из dispatch-engine (safeRequire убран), файлы сохранены как архив
- Убраны мёртвые функции `dispatchStageWithPolicy()` и `evaluateDispatchPolicy()`

**Остаётся:** 18 из 36 модулей runtime/ — debug-only, 5 из них имеют require на несуществующие файлы (мина для debug-эндпоинтов).

> **UPD 2026-06-26:** 3 governance-модуля LIVE, 3 мёртвых удалены из dispatch-engine.

---

## 16. Dual state model — избыточная сложность *(ЧАСТИЧНО ИСПРАВЛЕНО в v2.1.0, Н.6+Н.7)*

**Описание проблемы (было):** Dual State Model (per-asset + linear FSM) с валидацией последовательных переходов, которая блокировала параллельный диспатч.

**Что сделано (v2.1.0):**
- ✅ Удалена валидация переходов (`SceneTransitions`, `transitionSceneState` c locks/CAS)
- ✅ Удалён `scene-state-machine.js` (`Stage`, `determineNextStage`) — мёртвый код
- ✅ Удалён `decideStage` из оркестратора — dispatch-engine всегда передаёт `overrideStage`
- ✅ Удалены `shouldScheduleScene`, `registerScene`, `progressScene` из scheduler — legacy
- ✅ Удалены `sceneHeartbeat`, `isSceneStuck`, `getRecoveryPendingState` — не нужны без FSM
- ✅ All callbacks (`handleAudioCompleted`, `handleImageCompleted`, `handleVideoCompleted`) проверяют per-asset state вместо линейного

**Что сделано (Н.6, М1 — `1a0867d`):**
- ✅ Per-asset storage: JSON (GET+merge+SET) → Redis Hash (HSET/HGETALL) — устранён неатомарный RMW

**Что сделано (Н.7, §5.1 — `f0b81de`):**
- ✅ `executeAudioDispatch/ImageDispatch/VideoDispatch` → `setAssetState(..., AssetState.GENERATING)`

**Остаётся:**
- ❌ `SceneState` константы сохранены для backward compat (их читают плеер и debug endpoint'ы)
- ❌ `deriveLinearState` / `syncLinearState` сохранены для поддержки старых Redis-ключей

Зависимость от `SceneState` констант в роутах и реконсилейшне — не блокирует, но загрязняет код. Можно убрать в будущем, когда плеер перестанет читать `scene-state` ключи.

---

## 17. Два журнала событий (Redis + PostgreSQL)

**Описание проблемы:** Система имеет два event-журнала: Redis (event-journal.js, TTL 7 дней) и PostgreSQL (book-event-log.js, 30+ типов событий). Они не синхронизированы и дублируют функциональность.

**Затрагиваемые компоненты:** event-journal.js, book-event-log.js

---

## 18. Multi-file формат книг vs. legacy single-file

**Описание проблемы:** Книги переведены на multi-file формат (v2.1), но код book/index.js всё ещё поддерживает legacy single-file формат для миграции. Это добавляет сложность при загрузке.

**Затрагиваемые компоненты:** book/index.js, lazy-book.js
