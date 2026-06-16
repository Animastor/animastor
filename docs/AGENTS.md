# Agents: Animastor

## Общее описание

Агентная система Animastor — это **6-шаговый последовательный AI-пайплайн**, который анализирует исходный текст книги и прогрессивно обогащает его в структурированные сцены с персонажами, локациями и визуальными описаниями. Система использует **OpenRouter API** (модель по умолчанию: `qwen/qwen3.5-122b-a10b`, конфигурируется через `OPENROUTER_MODEL`).

## Архитектура агента

Агент реализован как **один монолитный сервис** (`backend/src/services/agent-service.js`, 1328 строк) без разделения на отдельные микроагенты. Все 6 шагов выполняются последовательно в рамках одного `agent_session`.

## Агенты (шаги пайплайна)

### Agent 0: Analyze Structure

**Назначение:** Извлечение метаданных книги — автор, название, части, главы.

**Зона ответственности:** Первичный анализ структуры текста.

**Инструменты:** `aiService.callAI()` с system prompt `SYSTEM_PROMPTS.structure`.

**Точки взаимодействия:** Создание/обновление структуры книги (book.json).

**Ограничения:** Требует читаемый текст; неструктурированный текст может дать неточные результаты.

**Формат входа:** Исходный текст книги (string).
**Формат выхода:** `{ author, title, language, parts: [{ title, chapters: [{ title, index }] }] }`

---

### Agent 1: Extract Characters

**Назначение:** Извлечение всех именованных персонажей с описаниями, внешностью, чертами характера, голосом.

**Зона ответственности:** Распознавание и характеристика персонажей.

**Инструменты:** `aiService.callAI()` с system prompt `SYSTEM_PROMPTS.characters`, контекст известных персонажей.

**Точки взаимодействия:** Обновление `book.characters`, мерж с существующими по ID.

**Ограничения:** Не может добавлять персонажей, не упомянутых в текущем окне текста.

**Формат входа:** Текст окна + knownCharacters.
**Формат выхода:** `{ characters: [{ id, name, description, appearance, traits, voice }] }`

---

### Agent 2: Extract Locations

**Назначение:** Извлечение локаций, информированное известными персонажами.

**Зона ответственности:** География и места действия.

**Инструменты:** `aiService.callAI()` с system prompt `SYSTEM_PROMPTS.locations`.

**Точки взаимодействия:** Обновление `book.bible.locations`, мерж с существующими.

**Ограничения:** Локации мержатся по имени; разные локации с одинаковым именем могут конфликтовать.

**Формат входа:** Текст окна + knownCharacters + knownLocations.
**Формат выхода:** `{ locations: [{ id, name, description, type, period }] }`

---

### Agent 3: Create Scenes

**Назначение:** Разбиение текста на логические сцены с участниками, локацией, окружением, временем.

**Зона ответственности:** Сегментация нарратива.

**Инструменты:** `aiService.callAI()` (maxTokens: 6144, самый большой лимит) с system prompt `SYSTEM_PROMPTS.scenes`.

**Точки взаимодействия:** Создание сцен в книге.

**Ограничения:** Максимум 3 сцены за одно окно (`WINDOW_SIZE=3`), максимум 4000 символов текста (`MAX_WINDOW_CHARS=4000`).

**Формат входа:** Текст окна + knownCharacters + knownLocations.
**Формат выхода:** `{ scenes: [{ scene_id, type, participants, location, environment, time_of_day, summary, text_ranges }] }`

---

### Agent 4: Create Units (IU - Image Units)

**Назначение:** Декомпозиция каждой сцены на визуальные единицы (кадры).

**Зона ответственности:** Раскадровка сцены.

**Инструменты:** `aiService.callAI()` с system prompt `SYSTEM_PROMPTS.units`.

**Точки взаимодействия:** Заполнение `scene.units[]`.

**Формат входа:** Сцена (текст + метаданные).
**Формат выхода:** `{ units: [{ unit_id, type, description, duration }] }`

---

### Agent 5: Create Visuals

**Назначение:** Добавление визуальных промптов (тип съёмки, текст промпта) к каждому IU.

**Зона ответственности:** Визуальный язык (camera language, composition, lighting).

**Инструменты:** `aiService.callAI()` с system prompt `SYSTEM_PROMPTS.visuals`.

**Точки взаимодействия:** Заполнение `scene.units[].visuals`.

**Формат входа:** Сцена + IU + knownCharacters + knownLocations.
**Формат выхода:** `{ visuals: [{ unit_id, shot_type, prompt, negative_prompt }] }`

---

## Динамическое построение агентов

Агенты **не строятся динамически**. Это фиксированный 6-шаговый пайплайн, определённый в исходном коде. Все шаги выполняются последовательно, каждый шаг использует результаты предыдущего.

Однако **оконная обработка** является динамической:
- Первое окно: `bootstrapWithAgent()` — включает все 6 шагов
- Последующие окна: `bootstrapNextWindow()` — шаги 1-5 (шаг 0 пропускается, т.к. структура уже извлечена)

## Используемые инструменты

- `aiService.callAI(model, messages, options)` — HTTP-вызов OpenRouter API
- `aiService.parseJsonResponse(text)` — парсинг JSON из ответа модели
- `book.loadBook(bookId)` / `book.saveBookBundle()` — чтение/запись книги
- `storage.postgres.query()` — запись в agent_sessions, agent_steps, agent_conversations, agent_messages
- `contextBuilder.buildContext()` — сборка контекста для промпта

## Точки взаимодействия

| Компонент | Как взаимодействует |
|-----------|-------------------|
| `txt-importer.js` | Вызывает `bootstrapWithAgent()` и `bootstrapNextWindow()` |
| `window-generator.cjs` | Вызывает `bootstrapNextWindow()` для фоновой обработки |
| `book-routes.cjs` | GET `/agent-status` — читает статус из `agent_sessions` |
| `book-routes.cjs` | DELETE book — удаляет `agent_sessions` для книги |
| `scene-orchestrator.js` | Не взаимодействует напрямую (агент работает до оркестрации) |

## База знаний (Knowledge Base)

Агент использует файлы из `backend/ai/`:

- `rules/` — 8 markdown-файлов (import_rules, json_schema, general, edit_mode, validation, json_rules, extraction_rules, naming)
- `skills/` — 8 markdown-файлов (camera_language, composition, continuity, directing, entity_extraction, lighting, prompt_engineering, storyboard)
- `examples/` — 6 JSON-примеров (book, character, cover, import, location, scene) + демо "Мастер и Маргарита"

**Важно:** База знаний загружается (`loadKnowledgeBase()`) но **не используется в промптах** (согласно коду: "not used in prompts").

## Формат входов и выходов

**Вход (общий):** `bookId` (string), `progress` (callback для обновления прогресса).

**Выход (общий):**
```json
{
  "bookId": "string",
  "title": "string",
  "author": "string",
  "language": "string",
  "state": "BOOTSTRAPPED|RAW_IMPORTED",
  "characters": "number",
  "locations": "number",
  "scenes": "number",
  "session_id": "uuid|null",
  "total_scenes_found": "number|null",
  "remaining_scenes": "number|null",
  "chapter": {
    "chapter": "string",
    "chapter_title": "string",
    "chapter_index": "number",
    "status": "string",
    "scenes": [{ "scene_id": "string", "type": "string", ... }]
  },
  "has_more": "boolean"
}
```

## Ограничения

- Модель фиксирована (по умолчанию `qwen/qwen3.5-122b-a10b`)
- Нет fallback на другую модель при отказе текущей
- Нет параллельного выполнения шагов
- Размер окна ограничен 4000 символов и 3 сценами
- База знаний загружается, но не используется в промптах
- timeout AI-вызова: 180s, maxTokens: 2048 (кроме scenes: 6144)
- Количество повторных попыток: 3 (`STEP_RETRIES`)
- Прогресс-сообщения на русском языке (не интернационализированы)

## Формат хранения (PostgreSQL)

| Таблица | Ключевые колонки |
|---------|-----------------|
| `agent_sessions` | session_id (PK), book_id, source_type, status (running/completed/failed), progress_msg, knowledge_base (JSONB), window_data (JSONB) |
| `agent_steps` | step_id (PK), session_id (FK), step_type, step_index, scene_index, status, result (JSONB), error |
| `agent_conversations` | conversation_id (PK), session_id (FK), step_id (FK), attempt, model |
| `agent_messages` | message_id (PK), conversation_id (FK), role (system/user/assistant), content |
