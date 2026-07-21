# Agents: Animastor

## Общее описание

Агентная система Animastor — это **последовательный AI-пайплайн** (шаг 0 + 5 шагов + enrichment), который анализирует исходный текст книги и прогрессивно обогащает его в структурированные сцены с персонажами, локациями и визуальными описаниями.

Система использует **OpenRouter API** (конфигурируется через `AI_API_BASE_URL`).
Модель по умолчанию: `qwen3-32b`. Единый ключ: `OPENROUTER_API_KEY`.

## Архитектура агента

Агент разбит на подмодули в `backend/src/services/agent/`, без разделения на отдельные микроагенты. Шаги выполняются последовательно в рамках одного `agent_session`.

### Файловая структура

| Файл | Роль |
|------|------|
| `backend/src/services/agent/pipeline-steps.js` | 6 шагов пайплайна (шаг 0 + 5) + enrichment |
| `backend/src/services/agent/pipeline-runner.js` | Запуск пайплайна с валидацией coverage/duration |
| `backend/src/services/agent/bootstrap.js` | Первое окно (`bootstrapWithAgent`) |
| `backend/src/services/agent/coreference.js` | Заглушка (удалён из пайплайна) |
| `backend/src/services/agent/ai-caller.js` | Вызов AI с ретраями и парсингом JSON |
| `backend/src/services/agent/text-utils.js` | Текстовые утилиты |
| `backend/src/services/agent/visual-utils.js` | Утилиты визуалов |
| `backend/src/services/agent-service.js` | Barrel-экспорт + window-generation |
| `backend/src/services/agent-prompts.js` | Все system prompt'ы |

### Структура пайплайна

```
bootstrapWithAgent():
  Шаг 0: stepAnalyzeStructure() — отдельно, до runPipeline()
  runPipeline():
    Шаг 1: stepExtractCharacters()  — персонажи (без голосов)
    Шаг 1b: stepGenerateVoices()    — голоса персонажей (выделенный шаг)
    Шаг 2: stepExtractLocations()   — локации
    Шаг 3: stepCreateScenes()       — сцены (до 3, из буфера 1500 символов)
    stepEnrichScenes()              — обогащение сцен (title, location, env)
    Шаг 4: stepCreateUnits()        — IU (визуальные единицы), per-scene
    Шаг 5: stepCreateVisuals()      — промпты (image + video), per-scene
    ── Post-processing (window-level) ──
    Шаг 6a: stepReconcilePassports   — сверка image.prompt с паспортами
    Шаг 6b: stepReconcileVideoActions — фикс video.action (temporal only)
    Шаг 7a: stepPolishStoryboard     — полировка image.prompt (continuity)
    Шаг 7b: stepPolishVideoActions   — полировка video.action (сюжет+ряд)
```

**Важно:** `runPipeline()` состоит из 5 шагов + enrichment + voice generation + 4 post-processing шага.

**Удалено из пайплайна:**
- `stepResolveCoreferences` — coreference-резолюция удалена из пайплайна (июль 2026)
- `unit.participants` — LLM больше не генерирует participants для IU
- `character_anchors` — позиции пишутся напрямую в visual.prompt

## Шаги пайплайна

### Шаг 0: Analyze Structure

**Назначение:** Извлечение метаданных книги — автор, название, части, главы.

**Зона ответственности:** Первичный анализ структуры текста (первые 80 строк).

**Инструменты:** `aiService.callAI()` с system prompt `SYSTEM_PROMPTS.structure`.

**Формат входа:** Первые 80 строк исходного текста (string).
**Формат выхода:** `{ author, title, has_prologue, has_epilogue, parts: [{ name, order }], chapters: [{ type, number, title, header_line }] }`

**Хранение в БД:** `agent_steps` с `step_type: 'analyze_structure'`

### Шаг 1: Extract Characters

**Назначение:** Извлечение всех именованных персонажей с описаниями, внешностью и чертами характера.

**Зона ответственности:** Распознавание и характеристика персонажей. Голоса НЕ являются частью этого шага — они генерируются отдельным выделенным шагом `stepGenerateVoices()`.

**Инструменты:** `aiService.callAI()` с system prompt `SYSTEM_PROMPTS.characters` (требует appearance на английском для LTX).

**Формат выхода:** `{ characters: [{ id, name, description, appearance, traits }] }`

### Шаг 2: Extract Locations

**Назначение:** Извлечение локаций с учётом известных персонажей.

**Формат выхода:** `{ locations: [{ id, name, type, description }] }`

### Шаг 3: Create Scenes

**Назначение:** Разбиение текста на логические сцены с участниками, локацией, окружением, временем.

**Ограничения:** До 3 сцен за один вызов (`MAX_SCENES_PER_CHUNK=3` — **жёсткий верхний предел, не целевое количество**).
Текст для разбиения берётся из буфера `MAX_WINDOW_CHARS=1500` символов.
Буфер ограничивает токены, но не является границей прогресса по книге.

LLM отвечает только за смысловое разбиение полученного буфера на сцены.
Агент может вернуть 1-3 сцены и не обязан использовать весь буфер;
неиспользованный хвост будет передан в следующем окне после программного
пересчёта `currentOffset`.

### Приоритеты промпта (по убыванию важности)

1. **Логическая целостность** — сцена = одно место, одно время, один эпизод.
   Не дробить сцену только ради увеличения количества.
2. **Группировка диалогов** — несколько реплик в одном разговоре = одна сцена.
3. **~20 сек (~65 слов)** — целевая длительность (мягкий ориентир).
4. **~30 сек (~95 слов)** — soft ceiling; один repair retry.
5. **~5 сек (~15 слов)** — технический минимум (видео-артефакты).
6. **Полные предложения** — каждая сцена начинается/заканчивается на полном предложении.
7. **Verbatim prefix coverage** — сцены = дословный непрерывный префикс буфера.

**Константы длительности:** `SCENE_TARGET_SEC=20`, `SCENE_MAX_SEC=30`,
`SCENE_MIN_SEC=5`. Оценка: `estimateSpeechDurationSec(text)` — 0.3 сек/слово,
минимум 2 сек.

### Валидация после AI

1. **Coverage (жёстко)** — `computeSceneCoverage()` проверяет непрерывный префикс.
   Если нет → repair retry с gap-fix, затем `buildFallbackScenes()`.
2. **Duration (мягко)** — сцены >30 сек логируются (`scene_duration_over_max`),
   но не блокируют импорт.
3. **Min-duration (логирование)** — сцены <5 сек логируются без retry.
4. **Retry** — один повтор: gap-fix или duration-split.

### Детерминированный fallback

`buildFallbackScenes()` нарезает текст по границам предложений
(`splitIntoSentences()`) в группы ~20 сек (≈65 слов), не превышая ~30 сек.
Если предложений нет — резерв `splitTextEvenlyByParagraphs()`.

### Enrichment (stepEnrichScenes)

После создания сцен запускается `stepEnrichScenes()`, который до-заполняет:
- `title` — извлекается из контекста (не из scene-creation prompt)
- `location.id` — сопоставляется с известными локациями
- `environment` — epoch, season, atmosphere

### Формат выхода

`{ scenes: [{ title, text, type, participants, location, environment }] }`

Перед выполнением задачи в промпт загружаются reference examples из
`backend/ai/examples/` через `formatExamplesForPrompt()`.

**Валидация после AI:**
1. **Coverage (жёстко)** — `computeSceneCoverage()` проверяет непрерывный префикс.
   При неудаче → repair retry → fallback `buildFallbackScenes()`.
2. **Duration (мягко)** — `estimateSpeechDurationSec()` (0.3 сек/слово).
   Сцены >30 сек логируются, но не блокируют импорт.
3. **Min-duration (логирование)** — сцены <5 сек логируются без retry.
4. **Retry** — один повтор: gap-fix или duration-split.

**Детерминированный fallback:** `buildFallbackScenes()` нарезает текст
по границам предложений (`splitIntoSentences`) в группы ~20 сек.

**Enrichment (stepEnrichScenes):** После создания сцен запускается
`stepEnrichScenes()`, который до-заполняет поля:
- `title` — извлекается из контекста, а не из scene-creation prompt
- `location.id` — сопоставляется с известными локациями
- `environment` — атмосферные поля (epoch, season, atmosphere)

**Формат выхода (сцен):** `{ scenes: [{ title, text, type, participants, location, environment }] }`

### Шаг 4: Create Units (IU)

**Назначение:** Декомпозиция каждой сцены на визуальные единицы (кадры). Правило: одна визуальная единица = один кадр (НЕ фрагментация по длине текста).

**Формат выхода:** `{ units: [{ text, type }] }`

### Шаг 5: Create Visuals

**Назначение:** Добавление визуальных промптов (тип съёмки, текст промпта, video action) к каждому IU.

**Важные изменения (июль 2026):**
- **`unit.participants` удалён** — LLM больше не генерирует participants для IU.
  Участники определяются через `inferCharactersFromPrompt()` — сканирование
  `visual.prompt` на наличие `character_id`.
- **`character_anchors` удалён** — позиции персонажей пишутся напрямую в
  `visual.prompt`, без отдельного поля.

**Формат выхода:** `{ units: [{ text, type, image: { shot, prompt }, video: { action } }] }`

**Разделение ответственности:**
- `image.prompt` — статическая композиция (кто где, как расположены)
- `video.action` — динамическое изменение (жесты, движения, camera motion)

### Шаг 6a: Reconcile Passports

**Назначение:** Удаление семантических дубликатов из `image.prompt`,
конфликтующих с автоматически инжектируемыми паспортами персонажей.
Не трогает `video.action`.

### Шаг 6b: Reconcile Video Actions

**Назначение:** Исправление `video.action` — удаление static composition
(которая должна быть только в `image.prompt`), оставление только temporal/dynamic
описаний (жесты, движение, camera motion, delivery cues).

### Шаг 7a: Polish Storyboard

**Назначение:** Согласование визуального ряда сториборда — правило 180°,
прогрессия крупности планов, непрерывность позиционирования персонажей.
Меняет только `image.prompt` и `image.shot`. Не трогает `video.action`.

### Шаг 7b: Polish Video Actions

**Назначение:** Согласование последовательности `video.action`:
- Непрерывность жестов между смежными юнитами
- Соответствие сюжету (проверка по scene text)
- Эмоциональная дуга (gradual escalation)
- Кросс-сценные переходы

Итоговый поток:
```
stepCreateVisuals
  → stepReconcilePassports (image.prompt только)
  → stepReconcileVideoActions (video.action только)
  → stepPolishStoryboard (image.prompt только)
  → stepPolishVideoActions (video.action только)
```

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
- `ai-loader.js` загружает все файлы из
  `ai/examples/` если в MODE_MAPPING не указан конкретный список.
- `refineDraft()` в `ai-service.js` загружает полные примеры из `ai/examples/`
  и включает их в промпты финальной доработки

## Ограничения

- Модель конфигурируется через `AI_API_BASE_URL` и `OPENROUTER_MODEL`
  (по умолчанию: `qwen3-32b` через OpenRouter).
- Нет fallback на другую модель при отказе текущей.
- Нет параллельного выполнения шагов.
- Размер буфера: 1500 символов (`MAX_WINDOW_CHARS`),
  до 3 сцен (`MAX_SCENES_PER_CHUNK`).
- timeout AI-вызова: 180s, maxTokens: 2048 (кроме scenes: 6144).
- Количество повторных попыток: 3 (`STEP_RETRIES`).
- Прогресс-сообщения на русском языке (не интернационализированы).
