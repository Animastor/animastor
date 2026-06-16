# Connectors: Animastor

## Общее описание

В проекте Animastor термин "коннектор" как формальная абстракция (интерфейс, базовый класс, registry) **не обнаружен**. Система использует прямые HTTP-вызовы и Redis-очереди для интеграции между компонентами.

Ниже описаны интеграционные точки, выполняющие роль коннекторов.

---

## 1. GPU Dispatcher (`backend/src/runtime/gpu-dispatcher.js`)

### Назначение
HTTP-клиент для отправки задач генерации в GPU Hub. Единственный компонент, который напрямую communicates с GPU Hub.

### Подключаемая система
GPU Hub (Node.js-сервер, `gpu-hub:5000`).

### Входные параметры
```
send(job_id, workflow, type, build_id)
  job_id: string (уникальный ID задачи)
  workflow: object (JSON workflow для ComfyUI)
  type: 'audio' | 'image' | 'video'
  build_id: string

sendVideo(job_id, workflow, imageBase64, build_id)
  job_id: string
  workflow: object
  imageBase64: string (base64 изображения для видео)
  build_id: string

sendUnified(taskSpec)
  taskSpec: { job_id, job_type, params, assets, build_id }
```

### Выходные параметры
HTTP POST `{HUB_URL}/task` с телом:
```json
{
  "job_id": "string",
  "params": { "workflow": {...} },
  "job_type": "audio|image|video",
  "assets": {},
  "build_id": "string"
}
```

### Механизм вызова
Прямой HTTP-вызов через `fetch()` или `node-fetch`. Отправляет POST-запрос с JSON-телом.

### Ошибки и ограничения
- Нет встроенного retry в gpu-dispatcher (retry-логика выше — в dispatch-engine)
- timeout запроса: не задан (по умолчанию)
- Нет fallback при недоступности GPU Hub

---

## 2. GPU Hub (`gpu-hub/gpu-hub.js`)

### Назначение
Центральный диспетчер GPU-задач. Принимает задачи от backend, управляет Redis-очередями, дедуплицирует, возвращает результаты.

### API endpoints

| Endpoint | Метод | Назначение | Вход | Выход |
|----------|-------|------------|------|-------|
| `/task` | POST | Создать задачу | `{ job_id, params, job_type, assets, build_id }` | `{ accepted, job_id }` |
| `/task/next` | GET | Получить следующую задачу (воркер) | — | `{ job_id, params, job_type, assets, build_id }` |
| `/task/result` | POST | Отправить результат | `{ job_id, build_id, result_base64 }` | `{ forwarded }` |
| `/task/error` | POST | Сообщить об ошибке | `{ job_id }` | `{ accepted }` |
| `/beacon` | POST | Heartbeat воркера | `{ id, type, gpu, vram, build_id }` | `{ ok }` |
| `/health` | GET | Статус очередей | — | JSON со статистикой очередей |
| `/queue/clear` | DELETE | Очистить очереди | query: `?type=...&book_id=...` | `{ cleared }` |

### Механизм регистрации
Не требует регистрации. Воркеры подключаются через beacon-запросы.

### Ошибки и ограничения
- Таймаут задачи: 300s (по умолчанию)
- Дедупликация: по `job_id` исп. SET NX
- Результат форвардится в backend через callback URL (не обнаружено единой конфигурации — `callbackUrl` передаётся в задаче, не обнаружено хранения)

---

## 3. GPU Workers (`worker/worker/worker.js`)

### Назначение
Выполнение ComfyUI workflow для генерации изображений, аудио и видео.

### Подключаемая система
- GPU Hub (REST API)
- ComfyUI (REST API на localhost)

### Входные параметры (от GPU Hub)
```json
{
  "job_id": "string",
  "params": { "workflow": {...} },
  "job_type": "image|audio|video",
  "assets": { "images": ["base64..."] },
  "build_id": "string"
}
```

### Выходные параметры (в GPU Hub)
`POST /task/result { job_id, build_id, result_base64 }`

### Механизм вызова
Polling: GET `/task/next` каждые N секунд.

### Ошибки и ограничения
- Поддерживает только ComfyUI
- Нет поддержки других GPU-платформ
- Результат передаётся как base64 (ограничение по размеру)
- Нет graceful shutdown

---

## 4. Redis Queues (backend → GPU Hub)

### Назначение
Асинхронная очередь задач между backend и GPU Hub.

### Подключаемая система
Redis (общий инстанс, используемый backend и GPU Hub).

### Механизм
- Backend отправляет задачу через HTTP POST на GPU Hub
- GPU Hub помещает задачу в Redis-список `animastor:queue:type`
- Worker забирает задачу через HTTP GET от GPU Hub

**Важно:** Очередь реализована через Redis, но доступ к Redis из GPU Hub — прямой. Worker'ы общаются с GPU Hub через HTTP, не через Redis напрямую.

---

## 5. PostgreSQL (backend → БД)

### Назначение
Каноническое хранение всех данных.

### Подключаемая система
PostgreSQL 16.

### Механизм
Прямые SQL-запросы через `pg` (node-postgres). Репозитории в `backend/src/storage/postgres/repositories/`.

---

## 6. OpenRouter API (backend → внешний AI)

### Назначение
Вызов внешних AI-моделей (Qwen, GPT, Claude) для анализа текста и чата.

### Подключаемая система
OpenRouter API (внешний REST API).

### Аутентификация
Единый ключ: `OPENROUTER_API_KEY` (env), доступен через `config.OPENROUTER_API_KEY`.
Если не задан — AI-ассистент недоступен (предупреждение на `console.debug`).

### Входные параметры
```json
{
  "model": "qwen/qwen3.5-122b-a10b",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "max_tokens": 2048,
  "temperature": 0.3
}
```

### Выходные параметры
JSON-ответ OpenRouter сгенерированным текстом.

### Механизм вызова
`aiService.callAI()` — HTTP POST к OpenRouter API.

### Ошибки и ограничения
- retry: 3 попытки
- timeout: 180s
- Нет fallback на другого провайдера
- Nvidia API как альтернатива (не обнаружено переключения в runtime)

---

## Процесс добавления нового коннектора

Поскольку формальной системы коннекторов нет, добавление новой интеграции требует:

1. **Создания HTTP-клиента** (или использования существующего `fetch`)
2. **Интеграции на уровне сервиса** (например, новый `gpu-dispatcher` для другого GPU-провайдера)
3. **Регистрации в DI backend.cjs** (пропустить зависимости через routeDeps)
4. **Обновления обработчиков callback** (task-handler)
5. **Документирования ошибок** в failure-taxonomy

Для нового типа GPU-воркера:
1. Обновить GPU Hub: новый `job_type` и queue
2. Создать worker с поддержкой нового типа
3. Обновить workflow-loader с новыми шаблонами
4. Обновить orchestrator и dispatch-engine для нового asset-типа

---

## Диаграмма связей коннекторов

```
                    ┌───────────┐
                    │  Backend  │
                    └─────┬─────┘
                          │
    ┌─────────────────────┼─────────────────────┐
    │                     │                     │
    ▼                     ▼                     ▼
┌────────┐         ┌──────────┐          ┌──────────┐
│ Redis  │◄────────│ GPU Hub  │◄─────────│OpenRouter│
│ Queues │  HTTP   └────┬─────┘  HTTP    │   API    │
└────────┘              │                 └──────────┘
                        │ HTTP poll
                        ▼
                   ┌────────┐
                   │ Worker │───HTTP──► ComfyUI
                   └────────┘

                    ┌──────────┐
                    │PostgreSQL│
                    └──────────┘
                         ▲
                         │ SQL
                    ┌────┴─────┐
                    │  Backend │
                    └──────────┘
```
