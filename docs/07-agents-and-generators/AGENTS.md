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
    Шаг 3: stepCreateScenes() — сцены (до 3 сцен из буфера 1500 символов)
    Шаг 4: stepCreateUnits() — IU (визуальные единицы), per-scene
    Шаг 5: stepCreateVisuals() — промпты, per-scene
```

**Важно:** `runPipeline()` состоит из 5 шагов. Шаг 0 (`analyze_structure`)
выполняется отдельно до `runPipeline()` — он извлекает автора, название и главы
из первых ~80 строк текста.

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

**Ограничения:** До 3 сцен за один вызов (`MAX_SCENES_PER_CHUNK=3` — **жёсткий верхний предел, не целевое количество**).
Текст для разбиения берётся из буфера `SCENE_CHUNK_SIZE=1500` символов
(`MAX_WINDOW_CHARS=1500`). Буфер ограничивает токены, но не является
границей прогресса по книге.

LLM отвечает только за смысловое разбиение полученного буфера на сцены.
Она не хранит и не вычисляет позицию в книге. Агент может вернуть 1-3 сцены
и не обязан использовать весь буфер; неиспользованный хвост будет передан в
следующем окне после программного пересчёта `currentOffset`.

**Промпт:** Приоритеты в порядке убывания важности:

1. **Логическая целостность сцены (высший приоритет)** — сцена = одно место, одно время,
   один непрерывный эпизод. Пока location, time и action flow не меняются — это одна сцена.
   Не дробить сцену только ради увеличения количества.

2. **Группировка диалогов** — несколько реплик в одном разговоре = одна сцена.
   Каждая отдельная реплика НЕ является отдельной сценой.

3. **Целевая длительность: ~20 секунд (~65 слов)** — мягкий ориентир.
   Когда текст сцены достигает ~65 слов, можно закрыть сцену в конце предложения.

4. **Максимум: ~30 секунд (~95 слов)** — строгий ориентир для промпта и
   soft ceiling в коде. Если добавление следующего предложения превысит ~95
   слов, модель должна закрыть сцену на предыдущем предложении; после одного
   repair retry backend может принять более длинную сцену, чтобы не потерять
   покрытие текста.

5. **Минимум: ~5 секунд (~15 слов)** — технический минимум (ограничение моделей
   генерации видео). Короткие фрагменты (<5с) объединять с соседними сценами,
   если это не нарушает логику повествования.

6. **Полные предложения** — каждая сцена начинается и заканчивается на полном
   предложении. Никогда не резать посередине.

7. **Verbatim prefix coverage** — возвращённые сцены должны быть дословным
   непрерывным префиксом буфера без пропусков и перекрытий между сценами.
   Полное покрытие всего буфера не требуется.

**ВАЖНО:** `MAX_SCENES_PER_CHUNK=3` — это жёсткий верхний предел, а не целевое
количество. Если текст естественно укладывается в 1-2 сцены, это правильно.
Не нужно заполнять все 3 сцены.

Перед выполнением задачи в промпт загружаются reference examples из
`backend/ai/examples/` (import_example, scene_example) через
`formatExamplesForPrompt()`, чтобы модель видела образцы правильного разбиения.

**Валидация после AI:**
1. **Coverage (жёстко)** — `computeSceneCoverage()` проверяет, что сцены
   покрывают непрерывный префикс буфера без пропусков и перекрытий. Если нет →
   повтор AI с фидбеком, затем детерминированный fallback `buildFallbackScenes()`.
2. **Duration (мягко)** — `estimateSpeechDurationSec()` оценивает длительность каждой
   сцены. Сцены >30 сек логируются (event: `scene_duration_over_max`), но не блокируют импорт.
3. **Min-duration (логирование)** — сцены <5 сек логируются (event: `scene_duration_below_min`),
   но не вызывают retry, чтобы не ломать coverage.
4. **Retry** — один повтор AI: если coverage failed → gap-fix repair; если coverage OK
   но есть oversized scenes → duration-split repair.

**Детерминированный fallback:** `buildFallbackScenes()` нарезает текст по границам
предложений (`splitIntoSentences`) в группы ~20 сек (≈65 слов), не превышая ~30 сек
на сцену. Если предложений нет — резерв `splitTextEvenlyByParagraphs()`.
Fallback также проходит coverage-валидацию и сохраняет правило непрерывного
префикса; он не должен искусственно потреблять весь буфер, если это привело бы
к превышению лимита сцен.

**Оценка длительности:** `estimateSpeechDurationSec(text)` — чистая функция
(0.3 сек/слово, минимум 2 сек). Используется и при валидации сцен, и при генерации
placeholder-аудио.

**Константы длительности:**
- `SCENE_TARGET_SEC = 20` — желаемая длительность сцены
- `SCENE_MAX_SEC = 30` — максимальная длительность сцены
- `SCENE_MIN_SEC = 5` — технический минимум (видео-артефакты при меньшей длине)

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
- **currentOffset** — абсолютная позиция в `sourceText`, единственный источник
  истины для следующего буфера
- **plannedEndOffset** — конец взятого текстового буфера; это не граница прогресса
- **coveredEndOffset / lastSceneEndOffset / next_offset** — фактический конец
  обработанного текста, вычисленный из последней созданной сцены
- **progressMethod** — способ определения следующей позиции (`coverage`,
  `coverage:full_scene_text`, `coverage:last_scene_tail`)

Алгоритм продвижения:
1. `getWindowText()` берёт буфер от `currentOffset`.
2. `stepCreateScenes()` создаёт максимум 3 сцены из начала буфера.
3. `resolveSceneProgress()` сверяет `scene.text` с исходным буфером и вычисляет
   `nextOffset`.
4. `agent_sessions.window_data.currentOffset` обновляется в `nextOffset`.
5. Следующий вызов начинается с этой позиции, даже если предыдущий буфер был
   длиннее фактически созданных сцен.

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
- `examples/` — все `.json` файлы в папке (загружаются динамически, без привязки к именам)

**Использование в промптах:**
- База знаний загружается через `knowledge-base.js` и `ai-loader.js` (с TTL-кэшем 1 мин)
- `formatExamplesForPrompt()` в `agent-service.js` загружает **все** файлы из
  `backend/ai/examples/`, динамически определяет структуру каждого и включает
  краткое описание в system prompt шага **Create Scenes** (через плейсхолдер
  `%REFERENCE_EXAMPLES%`). Нет жёстких привязок к именам файлов.
- `context-builder.js` (`buildExamplesSection()`) загружает все файлы из
  `ai/examples/` если в MODE_MAPPING не указан конкретный список.
- `refineDraft()` в `ai-service.js` загружает полные примеры из `ai/examples/`
  и включает их в промпты финальной доработки

## Ограничения

- Модель конфигурируется через `OPENROUTER_MODEL` (умолчание: `qwen/qwen3.5-122b-a10b`)
- AI_API_BASE_URL по умолчанию: `https://integrate.api.nvidia.com/v1` (Nvidia). В docker-compose: `https://api.aicredits.in/v1`
- Нет fallback на другую модель при отказе текущей
- Нет параллельного выполнения шагов
- Размер буфера: 1500 символов (`SCENE_CHUNK_SIZE`, `MAX_WINDOW_CHARS`),
  до 3 сцен (`MAX_SCENES_PER_CHUNK`)
- timeout AI-вызова: 180s, maxTokens: 2048 (кроме scenes: 6144)
- Количество повторных попыток: 3 (`STEP_RETRIES`)
- Прогресс-сообщения на русском языке (не интернационализированы)
