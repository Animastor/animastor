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

---

## Аддитивная часть — прод-фиксы после E2E (тот же день)

Реальное использование сразу наткнулось на инцидент №3 (полный JSON книги в system-сообщении).
Пайплайн был жив (connector online, WS/heartbeat/discovery OK), падение — строго на шве
размера. Потребовались два минимальных фикса, архитектура не менялась.

### Фикс 1 — `64ec1f33` (fix(ai): connector transport falls back to compact book context)

- **Причина:** `buildBookContext()` вкладывает полный JSON книги (BA ≈ 53 KB) в system-сообщение;
  лимит connector — 32 KB/сообщение (`lib/chat.cjs maxMessageChars`, зеркалится транспортом)
  → `request_too_large` на каждом запросе к реальной книге. Для облачного провайдера работало —
  для Private AI падало всё.
- **Фикс:** `chat-engine.cjs` — новый `buildCompactBookContext()` (структурная сводка:
  книга/глава [id]/сцена [id]/персонажи, ~1.4 KB вместо 53 KB, ограничена по главам/сценам);
  оба chat-роута (`ai-routes.cjs`) — при `transport === 'connector'` и размере контекста
  > 24 KB бюджет (`CONNECTOR_BOOK_CONTEXT_BUDGET`) отдают компактную сводку вместо полного
  JSON. Для облачных провайдеров поведение не изменилось.

### Фикс 2 — `4ccccd21` (fix(ai): drop empty-content history entries at chat routes)

- **Причина (второе падение, `invalid_request` за 15 ms):** после ответа «Ассистент не вернул
  результат» фронтенд добавляет в историю assistant-сообщение с **пустым content**
  (`content: res?.reply || streamedText || ''`). Transport/connector жёстко отвергают пустые
  строки контента → сессия «отравлена», каждый следующий запрос падает до перезагрузки страницы.
- **Фикс:** оба chat-роута отбрасывают записи истории с пустым/не-строковым content на шве
  (`hasNonEmptyContent`) — одна пустая трансакция больше не ломает остаток сессии; UI остаётся
  рабочим без перезагрузки и без пересборки SPA.

### Верификация (реальный путь, книга BA, streaming, `ai_source: private-local`)

- «Привет! Сколько глав в нашей книге?» → «В вашей книге 5 глав» ✅
- Отравленная история (assistant с пустым content) + вопрос → «5 глав, 17 сцен (1+4+4+3+5)» ✅
- Тесты: `ai-shared-stream` (28) и `ai-shared-inference` (23) — зелёные.
- Backend-контейнер перезапущен с фиксами; connector переподключился штатно (online).

### Замечания в бэклог

- Бейдж **«Private AI»** для локального connector — корректен по дизайну (private-local против
  shared/cloud). Если хочется слова «Local» — одна строка в i18n (`ai_source_private`).
- Qwen3 thinking до ~60 s перед первым delta — ограничение модели на CPU, не пайплайна.
- Пустой ответ модели (все токены в reasoning) всё ещё даёт честное «не вернул результат» —
  фронтовый push пустого content остался (фиксится на бэке, но для чистоты стоит убрать и в
  `AiAssistantPage.tsx` при следующей сборке SPA).
