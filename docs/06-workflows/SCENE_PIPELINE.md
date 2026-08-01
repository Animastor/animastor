# Scene Pipeline Architecture

## Core Principle

**AI делает литературную работу. Код делает техническую работу.**

```
┌─────────────────────────────────────────────────────────┐
│                      LLM (AI Agent)                      │
│                                                         │
│  Задача: "Прочитай текст и разбей на естественные        │
│           нарративные эпизоды (сцены)"                   │
│                                                         │
│  НЕ ЗНАЕТ про: лимиты, окна, кэш, количество сцен       │
└──────────────────────┬──────────────────────────────────┘
                       │ возвращает N сцен
                       ▼
┌─────────────────────────────────────────────────────────┐
│                   Pipeline (код)                         │
│                                                         │
│  1. Берёт первые K сцен (chunk_size из настроек)         │
│  2. Отправляет их на юниты + визуалы                     │
│  3. Остальные (N − K) → cached_scenes в БД               │
│  4. На следующем шаге: если есть cached_scenes →         │
│     обрабатывает их без вызова AI                        │
│  5. Когда кэш пуст → новый вызов AI со следующим         │
│     участком текста                                      │
└─────────────────────────────────────────────────────────┘
```

## Разделение ответственности

### LLM (агент) — только литературная задача

- Читает фрагмент исходного текста (обычно ~5500 символов)
- Разбивает на **естественные нарративные эпизоды**
- Критерии сцены: одно место, одно время, одни участники, один coherent episode
- **Не имеет никаких ограничений** на количество сцен
- Не знает про chunk_size, кэш, окна, video чанки — ничего

### Pipeline (код) — управление данными

| Этап | Что происходит |
|------|---------------|
| **Scene creation** | Вызов AI → получение N сцен |
| **Capping** | Берём первые `chunkSize` (обычно 2) для немедленной обработки |
| **Caching** | Остальные N−k сцен → `window_data.cached_scenes` в PostgreSQL |
| **Processing** | Для каждой сцены: title/location.id/environment-override (в шаге создания) → units → split long units → visuals → reconciliation |
| **Cache drain** | На следующем шаге: если есть `cached_scenes`, обрабатываем их без AI |
| **Next window** | Когда кэш пуст и есть ещё текст → новый вызов AI |

## Поток данных

```
Window 1:
  Исходный текст (5500 chars)
       │
       ▼
  AI → 5 natural scenes
       │
       ├── [scene 1, scene 2] → units → visuals → save to book
       │
       └── [scene 3, scene 4, scene 5] → cached_scenes в БД

Window 2:
  cached_scenes = [scene 3, scene 4, scene 5]
       │
       ├── [scene 3, scene 4] → units → visuals → save to book
       │
       └── [scene 5] → cached_scenes в БД

Window 3:
  cached_scenes = [scene 5]
       │
       └── [scene 5] → units → visuals → save to book

Window 4:
  cached_scenes = []
  remaining_text = есть ещё
       │
       ▼
  AI → следующий участок текста → ...
```

## Экономия токенов

Без кэша: каждое окно = 1 AI вызов на сцены.
С кэшем: 1 AI вызов порождает несколько окон обработки.

```
Пример: книга 30 000 символов, chunk_size=2, AI делает ~5 сцен/окно

Без кэша:  5 окон × 1 AI = 5 AI вызовов
С кэшем:   2 AI вызова + 3 processCachedScenes (0 AI)
Экономия:  ~60% AI вызовов
```

## Ключевые файлы

| Файл | Роль |
|------|------|
| `ai/rules/scenes.md` | Промпт для AI — чисто литературный, без лимитов |
| `services/agent/pipeline-steps.js` | `stepCreateScenes()` — вызывает AI |
| `services/agent/pipeline-runner.js` | `runPipeline()` — оркестратор, `processCachedScenes()` — кэш |
| `services/agent/bootstrap.js` | `bootstrapWithAgent()` и `bootstrapNextWindow()` — управление окнами |
| `services/agent-prompts.js` | `MAX_SCENES_PER_CHUNK`, `CHARS_PER_SCENE`, `MAX_WINDOW_CHARS` |

## Структура cached_scenes в БД

Сохраняется в `agent_sessions.window_data` как JSON-поле `cached_scenes`:

```json
{
  "window_index": 0,
  "cached_scenes": [
    {
      "title": "Странное видение Берлиоза",
      "text": "И тут знойный воздух сгустился перед ним...",
      "type": "narration",
      "characters_present": ["mikhail_berlioz"],
      "location": { "id": "patriarch_ponds" }
    }
  ],
  "created_scenes": 2,
  "remaining_text": "...",
  "currentOffset": 5500
}
```

## Технические константы (не влияют на AI)

Эти константы определяют размер окна текста для LLM и количество сцен,
обрабатываемых за один проход. Они **не влияют** на то, как AI делит сцены.
Размер сцены определяется агентом исходя из литературной логики, а не
фиксированным количеством символов.

| Константа | Значение | Зачем |
|-----------|----------|-------|
| `MAX_SCENES_PER_CHUNK` | 2 | Сколько готовых сцен одновременно передаётся на дальнейшую обработку |
| `CHARS_PER_SCENE` | 2700 | Технический множитель для расчёта `MAX_WINDOW_CHARS` |
| `MAX_WINDOW_CHARS` | 5500 | Размер текстового окна, передаваемого LLM за один вызов |
| лимит сцен | нет | AI создаёт столько сцен, сколько естественно вытекает из текста |

## История изменений

- **2026-07-29**: Убран последний искусственный лимит из промпта AI. AI не знает про `%MAX_SCENES%`. Добавлен `processCachedScenes()` для обработки кэшированных сцен без вызова AI. `cached_scenes` сохраняется в `window_data` PostgreSQL.
