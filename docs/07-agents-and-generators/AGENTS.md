# Agents: Animastor

## Общее описание

Агентная система Animastor — это **6-шаговый последовательный AI-пайплайн** (шаг 0 + 5 шагов в pipeline), который анализирует исходный текст книги и прогрессивно обогащает его в структурированные сцены с персонажами, локациями и визуальными описаниями. Система использует **OpenRouter API** (модель по умолчанию: `qwen/qwen3.5-122b-a10b`, конфигурируется через `OPENROUTER_MODEL`; в docker-compose используется `qwen/qwen3-32b`).

## Архитектура агента

Агент реализован как **один монолитный сервис** (`backend/src/services/agent-service.js`) без разделения на отдельные микроагенты. Шаги выполняются последовательно в рамках одного `agent_session`.

### Структура пайплайна

```
bootstrapWithAgent():
  Шаг 0: stepAnalyzeStructure() — отдельно, до runPipeline()
  runPipeline():
    Шаг 1: stepExtractCharacters() — персонажи
    Шаг 2: stepExtractLocations() — локации
    Шаг 3: stepCreateScenes() — сцены (до 8 сцен / 1500 символов на сцену)
    Шаг 4: stepCreateUnits() — IU (визуальные единицы), per-scene
    Шаг 5: stepCreateVisuals() — промпты, per-scene
```

**Важно:** В отличие от документации AGENTS.md, pipeline состоит из 5 шагов (не 6). Шаг 0 (analyze_structure) выполняется отдельно до `runPipeline()` — он извлекает автора, название, главы из первых ~80 строк текста.

## Шаги пайплайна

### Шаг 0: Analyze Structure

**Назначение:** Извлечение метаданных книги — автор, название, части, главы.

**Зона ответственности:** Первичный анализ структуры текста (первые 80 строк).

**Инструменты:** `aiService.callAI()` с system prompt `SYSTEM_PROMPTS.structure`.

**Формат входа:** Первые 80 строк исходного текста (string).
**Формат выхода:** `{ author, title, has_prologue, has_epilogue, parts: [{ name, order }], chapters: [{ type, number, title, header_line }] }`

**Хранение в БД:** `agent_steps` с `step_type: 'analyze_structure'`

### Шаг 1: Extract Characters

**Назначение:** Извлечение всех именованных персонажей с описаниями, внешностью, чертами характера, голосом.

**Зона ответственности:** Распознавание и характеристика персонажей.

**Инструменты:** `aiService.callAI()` с system prompt `SYSTEM_PROMPTS.characters` (требует appearance на английском для LTX).

**Формат выхода:** `{ characters: [{ id, name, description, appearance, traits, voice }] }`

### Шаг 2: Extract Locations

**Назначение:** Извлечение локаций с учётом известных персонажей.

**Формат выхода:** `{ locations: [{ id, name, type, description }] }`

### Шаг 3: Create Scenes

**Назначение:** Разбиение текста на логические сцены с участниками, локацией, окружением, временем.

**Ограничения:** До 8 сцен за одно окно (`MAX_SCENES_PER_CHUNK=8`), текст сцены берётся
из первых `SCENE_CHUNK_SIZE=1500` символов окна (reconnaissance использует все 4000).

**Промпт:** AI получает инструкцию создавать **~65 слов на сцену** (≈20 сек аудио)
с хард-лимитом **~95 слов** (≈30 сек). Сцены заканчиваются на полном предложении.
Предпочтение: МНОГО коротких ~20сек сцен вместо нескольких длинных.
Количество сцен не ограничено (кроме `MAX_SCENES_PER_CHUNK` как guard).
Заголовки глав в сцены не включаются — они добавляются програмно.

**Валидация после AI:**
1. **Coverage (жёстко)** — `computeSceneCoverage()` проверяет, что все сцены покрывают
   исходный текст без пропусков и перекрытий. Если нет → повтор AI с фидбеком,
   затем детерминированный fallback `buildFallbackScenes()`.
2. **Duration (мягко)** — `estimateSpeechDurationSec()` оценивает длительность каждой
   сцены. Сцены >30 сек логируются, но не блокируют импорт.
3. **Retry** — один повтор AI с duration-фидбеком, если coverage ОК но сцены слишком длинные.

**Детерминированный fallback:** `buildFallbackScenes()` нарезает текст по границам
предложений (`splitIntoSentences`) в группы ~20 сек (≈65 слов), не превышая ~30 сек
на сцену. Если предложений нет — резерв `splitTextEvenlyByParagraphs()`.
Гарантирует 100% coverage по построению.

**Оценка длительности:** `estimateSpeechDurationSec(text)` — чистая функция
(0.3 сек/слово, минимум 2 сек). Используется и при валидации сцен, и при генерации
placeholder-аудио.

**Формат выхода:** `{ scenes: [{ title, text, type, participants, location, character_anchors }] }`

### Шаг 4: Create Units (IU)

**Назначение:** Декомпозиция каждой сцены на визуальные единицы (кадры). Правило: одна визуальная единица = один кадр (НЕ фрагментация по длине текста).

**Формат выхода:** `{ units: [{ text, type }] }`

### Шаг 5: Create Visuals

**Назначение:** Добавление визуальных промптов (тип съёмки, текст промпта) к каждому IU.

**Формат выхода:** `{ units: [{ text, type, visual: { shot, prompt, character_binding } }] }`

## Оконная обработка

- **Первое окно:** `bootstrapWithAgent()` — шаг 0 (structure) + шаги 1-5 (pipeline)
- **Последующие окна:** `bootstrapNextWindow()` — шаги 1-5 (шаг 0 пропускается)
- **currentOffset** — абсолютная позиция в sourceText, единственный источник истины

## Используемые инструменты

- `aiService.callAI(messages, options)` — HTTP-вызов OpenRouter API
- `aiService.parseJsonResponse(text)` — парсинг JSON из ответа модели
- `book.loadBook(bookId)` / `book.saveBookBundle()` — чтение/запись книги
- `storage.postgres.query()` — запись в agent_sessions, agent_steps, agent_conversations, agent_messages
- `lazyBook.createFromAnalysis()` / `lazyBook.appendToBook()` — создание/дополнение структуры книги

## Хранение в PostgreSQL

| Таблица | Ключевые колонки |
|---------|-----------------|
| `agent_sessions` | session_id (PK), book_id, source_type, status (running/completed/failed/paused), progress_msg, knowledge_base (JSONB), window_data (JSONB) |
| `agent_steps` | step_id (PK), session_id (FK), step_type (analyze_structure, analyze_characters, analyze_locations, create_scenes, create_units, create_visual_prompts), step_index, scene_index, status, result (JSONB), error |
| `agent_conversations` | conversation_id (PK), session_id (FK), step_id (FK — nullable), attempt, model |
| `agent_messages` | message_id (PK), conversation_id (FK), role (system/user/assistant), content |

## База знаний (Knowledge Base)

Файлы в `backend/ai/`:
- `rules/` — 8 markdown-файлов (import_rules, json_schema, general, edit_mode, validation, json_rules, extraction_rules, naming)
- `skills/` — 8 markdown-файлов (camera_language, composition, continuity, directing, entity_extraction, lighting, prompt_engineering, storyboard)
- `examples/` — 6 JSON-примеров (book, character, cover, import, location, scene) + демо "Мастер и Маргарита"

**Важно:** База знаний загружается через `knowledge-base.js` и `ai-loader.js` (с TTL-кэшем 1 мин), но НЕ используется в промптах agent-service. Исключение: `refineDraft()` в `ai-service.js` загружает примеры из `ai/examples/` и включает их в промпт.

## Ограничения

- Модель конфигурируется через `OPENROUTER_MODEL` (умолчание: `qwen/qwen3.5-122b-a10b`)
- AI_API_BASE_URL по умолчанию: `https://integrate.api.nvidia.com/v1` (Nvidia). В docker-compose: `https://api.aicredits.in/v1`
- Нет fallback на другую модель при отказе текущей
- Нет параллельного выполнения шагов
- Размер окна: reconnaissance 4000 символов, scene chunk 1500 символов (`SCENE_CHUNK_SIZE`), до 8 сцен (`MAX_SCENES_PER_CHUNK`)
- timeout AI-вызова: 180s, maxTokens: 2048 (кроме scenes: 6144)
- Количество повторных попыток: 3 (`STEP_RETRIES`)
- Прогресс-сообщения на русском языке (не интернационализированы)
