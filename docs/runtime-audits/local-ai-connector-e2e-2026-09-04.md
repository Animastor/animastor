# Local AI Connector — E2E на VPS (2026-09-04)

Цель: физически поднять Ollama на прод-VPS, подключить лёгкую локальную модель и проверить
полный путь **Animastor Cloud → Local AI Connector (WS) → Runtime Adapter → Ollama → LLM → ответ**,
ничего не переделывая в архитектуре. Код по ходу теста не менялся.

---

## Окружение

| Компонент | Значение |
|---|---|
| VPS | 2 vCPU (AMD EPYC 9J14, shared), 3.8 GB RAM (+4 GB swap), 23 GB свободно |
| GPU | нет (Virtio GPU) — чистый CPU inference |
| ОС | Ubuntu 22.04.5 LTS |
| Ollama | 0.33.3, Docker-контейнер (`--restart unless-stopped`) |
| Публикация порта | **только 127.0.0.1:11434** — с внешнего интерфейса и из интернета недоступен (проверено) |
| Модель | `qwen3:1.7b` (Q4_K_M, ~1.4 GB) |
| Connector | локальный checkout `local-ai-connector/` (`node index.cjs`); в npm пакета нет |
| Cloud endpoint | `wss://app.animastor.in/api/v1/ai-connector/ws` |

Выбор модели: приоритет был Qwen 1.5–3B. 3B не влезал в свободную RAM без риска для
прод-контейнеров (backend/PG/redis/proxy уже занимают ~1.5 GB), поэтому взят `qwen3:1.7b` —
нижняя граница запрошенного диапазона, стабильно работает на 2 vCPU CPU-only.

---

## Результаты E2E

| Проверка | Результат |
|---|---|
| Регистрация (`llmcreg.*` → `llmc.*`, exactly-once disclosure) | ✅ PASS |
| WS-соединение + `ready` | ✅ PASS |
| Heartbeat (15 s, PG online + Redis TTL-зеркало) | ✅ PASS |
| Runtime detection (`runtime_ok`, type=ollama) | ✅ PASS |
| `models.refresh` → `models.list` | ✅ PASS → `["qwen3:1.7b"]` |
| Модель в `models.list` / PG | ✅ PASS |
| Non-streaming chat через облако | ✅ PASS → `"hello"`, `ai_source: private-local` |
| Streaming chat (Phase 3 SSE) | ✅ PASS: `meta` → N×`delta` → `done` |
| Реальная задача («что такое анимация?») | ✅ PASS — связное одно предложение |

## Замеры

| Метрика | Значение |
|---|---|
| Первый ответ (non-streaming, cold cache) | ~18.3 s |
| Первый delta (streaming) | ~29 s (текст длиннее) |
| Повторные простые ответы (warm) | 7.9–10.2 s |
| Throughput | ~1–6 tok/s на 2 vCPU CPU-only; Ollama кэширует prompt — повторные быстрее |
| Direct Ollama (без connector, `think:false`, короткий ответ) | ~1.1 s |

Поведение при медленном CPU inference: connector стабильно держит долгие запросы,
heartbeat/discovery не деградируют, статус в PG корректно online → offline при остановке → online после рестарта.

---

## Инциденты по пути (код не менялся)

1. **nginx держал устаревший конфиг в памяти** — WS `/api/v1/ai-connector/ws` отдавал 404
   снаружи при рабочем конфиге на диске (конфиг обновили 2 сент 10:38, контейнер не
   перезагружали с 05:16; новый `location /api/v1/ai-connector/` с Upgrade-заголовками
   не был активирован). Фикс: `nginx -s reload`. Единственная реальная поломка пути.
   **Вывод:** после правки `proxy/conf/default.conf` нужен reload — кандидат в чеклист деплоя.
2. **Registration token истёк** во время диагностики nginx. Продлён TTL в PG на 30 мин
   (`reg_expires_at`); одноразовая семантика сохранена — после активации хэш затёрт.
3. **`request_too_large` на реальной книге**: `buildBookContext` вкладывает полный JSON книги
   в system-сообщение (книга BA ≈ 50 KB > лимита connector 32 KB/сообщение).
   Лимиты сработали правильно (fail-closed, 502). Для теста создана малая книга.
   **Рекомендация:** для connector-транспорта ограничивать book context
   (релевантные сцены/окно) — иначе реальные книги будут стабильно падать.
4. **Ложный tool-call на JSON-ответе**: `{"name":"Оля","age":34}` был распознан
   `extractToolCallsFromContent` как вызов инструмента → ответ превратился в
   «🤖 Processed 1 tool call(s)». Не блокер, но эвристику стоит докрутить.
5. **Qwen3 thinking-режим**: на коротких запросах иногда «думает» вслух и оставляет
   `/think`-хвосты, тратит токены на reasoning. Для прод-чата лучше non-thinking модель
   или `think=false` (адаптер пока передаёт только max_tokens/temperature).

## Безопасность

- Токены (`llmcreg.*`/`llmc.*`) не попали в Git, логи connector (metadata-only, проверено
  grep'ом) и этот документ; постоянный credential хранится в `/tmp/opencode` с 0600.
- Ollama недоступна извне (bind только loopback; извне порта нет).
- Никаких изменений worker / gpu-hub / provider / resolver / sharing architecture;
  `git status` чист, commit не создавался.

## Изменения на VPS

- Docker-контейнер `ollama` (0.33.3, loopback-only) + volume `ollama-data`.
- Продление TTL одного истёкшего reg-токена в PG (одноразово).
- Временный тест-бук в `data/books` (создан для обхода #3, удалён после теста вместе с чат-сессиями).

## Итог

**E2E PASS.** CPU VPS тянет 1.7B-модель и пригоден как **Private AI endpoint** (медленно:
секунды на простой ответ — для чата приемлемо, для больших контекстов нужен book-context
менеджмент из п.3). Как **Shared AI endpoint** — рискованно на текущих 2 vCPU / 3.8 GB RAM
при 2–3 параллельных инференсах; перед sharing-фазой нужен запас ресурсов или очередность.
