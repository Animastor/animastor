# AI-агент в Animastor: архитектура и промты

## 1. Общая архитектура

В системе существует **два независимых AI-пайплайна**:

| Пайплайн | Сервис | Назначение |
|----------|--------|------------|
| Импорт TXT | `agent-service.js` | Пошаговый разбор текста → персонажи, сцены, юниты, визуалы |
| Чат/редактирование | `chat-engine.cjs` + `context-builder.js` | Интерактивная работа с книгой через режимы |

Оба пайплайна используют общий `ai-service.js` для вызова LLM (OpenRouter, модель `qwen/qwen3.5-122b-a10b` по умолчанию).

---

## 2. Пайплайн импорта TXT

### 2.1 Общая схема

```
TXT-файл → decodeTxtBuffer() → createDraftBook() [RAW_IMPORTED]
                                         ↓
                              bootstrapImportedText()
                                         ↓
                           agent-service.bootstrapWithAgent()
                                         ↓
                    ┌─────── Agent Session (PG) ───────┐
                    │  agent_sessions, agent_steps,     │
                    │  agent_conversations, agent_messages │
                    └──────────────────────────────────┘
                                         ↓
                    ┌── Шаг 0: analyze_structure ──────┐
                    │  (автор, название, части, главы)  │
                    └──────────────────────────────────┘
                                         ↓
                    ┌── Шаг 1: extract_characters ─────┐
                    └──────────────────────────────────┘
                                         ↓
                    ┌── Шаг 2: extract_locations ──────┐
                    └──────────────────────────────────┘
                                         ↓
                    ┌── Шаг 3: create_scenes ──────────┐
                    └──────────────────────────────────┘
                                         ↓
                    ┌── Шаг 4: create_units (на сцену) ┐
                    └──────────────────────────────────┘
                                         ↓
                    ┌── Шаг 5: create_visuals (на сцену)┐
                    └──────────────────────────────────┘
                                         ↓
                     createFromAnalysis() → [BOOTSTRAPPED]
                                         ↓
                     bootstrapNextWindow() → [ACTIVE]
```

### 2.2 Промты агента (определены в `SYSTEM_PROMPTS` в `agent-service.js`)

#### Шаг 0: Анализ структуры (`structure`)
**System prompt:**
```markdown
You are a literary analysis assistant. Analyze the provided text and extract its structural metadata.

## Rules
- The FIRST meaningful line is usually the AUTHOR (full name)
- The SECOND meaningful line is usually the BOOK TITLE
- After metadata, look for PART headers (e.g., "ЧАСТЬ ПЕРВАЯ")
- Chapters are marked by "Глава", "Chapter", etc.
- Also detect: Пролог, Эпилог, Введение, Послесловие

## What to identify
1. author — Full name of the author
2. title — Full title of the work
3. has_prologue — true if text contains a prologue
4. has_epilogue — true if text contains an epilogue
5. parts — Array of structural parts
6. chapters — Array of chapters with type, number, title, header_line

## Output format
{ "author": ..., "title": ..., "has_prologue": ..., "has_epilogue": ..., "parts": [...], "chapters": [...] }
```

**User prompt:** Отправляет первые ~80 строк исходного текста для анализа.

#### Шаг 1: Извлечение персонажей (`characters`)
**System prompt:**
```markdown
You are a literary analysis assistant. Extract ALL named characters from the provided text.

## Rules
- Identify every named person
- Role: protagonist, antagonist, supporting, minor

For each character:
- description: 1-2 sentences about WHO this character is
- appearance: DETAILED physical appearance — CRITICAL, must be in ENGLISH for LTX 2.3
- traits: array of 3-5 personality traits
- voice: short description of how this character speaks

## Output format
{ "characters": [{ "id", "name", "role", "description", "appearance", "traits": [], "voice" }] }
```

#### Шаг 2: Извлечение локаций (`locations`)
**System prompt:**
```markdown
You are a literary analysis assistant. Identify ALL locations where scenes take place.

## Rules
- Extract named locations and descriptive places
- Type: indoor, outdoor, abstract

## Known Characters (for context)
%EXISTING_CHARACTERS%

## Output format
{ "locations": [{ "id", "name", "type", "description" }] }
```

**User prompt:** Текст для анализа. В `locations` подставляется список уже найденных персонажей.

#### Шаг 3: Создание сцен (`scenes`)
**System prompt:**
```markdown
You are a literary analysis assistant. Split the provided text into logical scenes.

## Rules
- A scene is ONE compact narrative episode with ONE location, ONE continuous time, ONE set of participants
- Scene boundaries: location change, time jump, character entrance/exit, narrative break
- Each scene.text must contain the COMPLETE VERBATIM original text
- Scene texts are used for TTS audio narration — must be verbatim

## Known Characters
%EXISTING_CHARACTERS%

## Known Locations
%EXISTING_LOCATIONS%

## Output format
{ "scenes": [{ "title", "text", "type", "participants": [], "location": { "id", "environment": { "time", "lighting", "weather", "mood", "atmosphere" } }, "character_anchors": { ... } }] }
```

#### Шаг 4: Декомпозиция сцены на юниты (`units`)
**System prompt:**
```markdown
You are a literary analysis assistant. Decompose the provided scene text into visual units.

## Rules
- A unit is ONE complete visual frame — what the viewer sees in ONE shot
- Defined by a VISUAL EVENT, not by text length
- "Two people on a bench talking" is ONE unit even if the text is long
- Do NOT split a single visual scene into fragments by commas, sentences, or character count
- unit.text MUST be a VERBATIM substring of the scene text
- Prefer FEWER complete visual frames over many fragments

## Scene text to decompose:
%SCENE_TEXT%

## Known Characters (for context)
%EXISTING_CHARACTERS%

## Output format
{ "units": [{ "text", "type": "perception|narration|dialogue|description|action|transition|performance" }] }
```

#### Шаг 5: Создание визуальных промтов (`visuals`)
**System prompt:**
```markdown
You are a visual director for a cinematic book platform. For each unit, create a brief visual prompt.

## Rules
- Describe ONLY what is visible in this specific frame — NOT a plot summary
- Camera framing, character position, lighting, environment, mood
- 5-15 words, in English
- Each unit MUST have a non-empty visual.prompt

## Scene Context
%CONTEXT%

## Input units to describe:
%UNITS%

## Output format
{ "units": [{ "text", "type", "visual": { "shot": "wide|medium|close|detail|environment|reaction", "prompt": "...", "character_binding": true } }] }
```

### 2.3 Окна (windows)

Текст обрабатывается окнами по **~4000 символов** (константа `MAX_WINDOW_CHARS`). Первое окно создаёт структуру книги, последующие окна добавляют сцены. Система поддерживает кэширование оставшихся сцен после AI-обработки.

### 2.4 Состояния книги

```
RAW_IMPORTED → (агент анализирует) → BOOTSTRAPPED → (все окна) → ACTIVE
```

---

## 3. Чат-режимы и интерактивное создание книги

### 3.1 Общая схема

```
Пользователь → Выбор режима (chat/edit/director/extraction/import/validation)
                                         ↓
                    ┌── context-builder.js ──────────────┐
                    │  - Загружает правила (ai/rules/*.md)│
                    │  - Загружает навыки (ai/skills/*.md)│
                    │  - Загружает примеры (ai/examples/) │
                    │  - Добавляет контекст книги         │
                    └────────────────────────────────────┘
                                         ↓
                              chat-engine.cjs
                    ┌── Формирование system prompt ──────┐
                    │  + регистрация tools для режима     │
                    └────────────────────────────────────┘
                                         ↓
                              ai-routes.cjs
                         API вызов к OpenRouter
                                         ↓
                    Парсинг ответа → поиск patches
                         Применение patches к книге
```

### 3.2 Маппинг режимов (context-builder.js)

```javascript
conversation: { rules: ['general'],          skills: [],      examples: [] }
edit:         { rules: ['json_rules', 'edit_mode'], skills: [],       examples: ['scene_example'] }
director:     { rules: [],                    skills: [composition, camera_language, lighting, directing],
                                                               examples: ['scene_example'] }
extraction:   { rules: ['extraction_rules'],  skills: ['entity_extraction'], examples: [] }
import:       { rules: ['import_rules', 'json_rules'], skills: [], examples: ['import_example', 'book_example'] }
validation:   { rules: ['json_schema', 'validation'], skills: [], examples: [] }
```

### 3.3 Промты для режимов (frontend AssistantMode.kt)

**Conversation:**
```
You are a creative assistant in Conversational mode. Answer questions, discuss ideas,
explain concepts, and brainstorm. Do NOT make any changes to the book — this is a read-only discussion.
```

**Import:**
```
You are an Import specialist. Convert arbitrary text into Animastor book structure.
Analyze the text and automatically determine chapters, scenes, and units.
If a book is already open, decide whether the text is a new chapter, continuation of
current chapter, or extension of current scene. If no book is open, create a new book
with manifest, metadata, chapters, scenes, and units.
```

**Edit:**
```
You are an Editor. You can modify scenes, characters, locations, objects, and book structure.
Use the `edit_book` tool to apply changes. Always confirm changes with the user before applying.
```

**Director:**
```
You are a Film Director. Advise on camera angles, composition, lighting, mood, and atmosphere
for scenes. You can write into storyboard_elements for the current scene. Think visually and cinematically.
```

**Extraction:**
```
You are an Extraction specialist. Extract structured entities from the text such as characters,
objects, locations, and key terms.
```

**Validation:**
```
You are a Validation specialist. Check book JSON for correctness, completeness, and integrity.
Verify required fields, cross-references, scene links, and data consistency.
Return a list of violations with severity levels.
```

### 3.4 Инструменты (tools) по режимам (chat-engine.cjs)

| Режим | Доступные инструменты |
|-------|----------------------|
| `chat` | `edit_book`, `write_storyboard`, `extract_entities`, `validate_book` |
| `edit` | `edit_book` (если книга не заблокирована) |
| `director` | `write_storyboard` |
| `import` | `import_book` |
| `extraction` | `extract_entities` |
| `validate` | `validate_book` |

Если книга заблокирована (`manifest.locked === true`), в режиме `edit` инструменты отключаются.

### 3.5 Формирование полного system prompt (context-builder.js)

```
# Mode: <mode>

## Rules
<содержимое ai/rules/<mode>.md>

## Skills
<содержимое ai/skills/<skill>.md>

## Examples
<примеры из ai/examples/>

## Project Context
- Book: "<title>" (id: ...)
- Total characters: N
- Total scenes: N
- Total chapters: N
- Locked: true/false

## Full Book JSON
{ ... }
```

### 3.6 Файл профиля ассистента (`/data/ai-assistant-profile.md`)

Если файл существует, он используется как базовый system prompt (переопределяет встроенный в `chat-engine.cjs`). Встроенный профиль по умолчанию:

```markdown
# AI Assistant Profile: Анимастор

## Identity
Ты — Анимастор, умный помощник для создания интерактивных историй и книг на платформе Animastor.

## Rules
- Всегда представляешься как Анимастор
- Не выдаёшь себя за человека
- Отвечаешь на том же языке, на котором к тебе обратились
```

---

## 4. Старый пайплайн (refineDraft в ai-service.js)

Используется как запасной вариант и для первого окна в `ai-service.refineDraft()`.

Отличия от нового агентного пайплайна:
- **Один вызов LLM** вместо 5-6 последовательных шагов
- **Огромный system prompt** (~10K+ символов) со всеми правилами, инструкциями и примерами, встроенными прямо в промт
- **Загрузка примеров** из `ai/examples/` в тело промта как блок `Reference Examples`
- **Встроенная самопроверка** (self-verification): 8 пунктов, которые AI должен проверить перед ответом
- **Обработка ошибок**: при неудаче up to 3 retries с экспоненциальной задержкой

System prompt содержит детальные инструкции по:
- Трёхуровневой иерархии: Scene → Unit → Visual Prompt
- Правилам декомпозиции сцен на юниты (verbatim, по визуальным событиям)
- Правилам визуальных промтов (только видимое в кадре, без биографии персонажей)
- Приоритетам: качество сцен > качество юнитов > точность персонажей > полнота локаций

---

## 5. Сводная таблица промтов

| Контекст | Откуда берётся | Системный промт | Размер |
|----------|---------------|-----------------|--------|
| Импорт: структура | agent-service.js | `structure` | ~600 слов |
| Импорт: персонажи | agent-service.js | `characters` | ~400 слов |
| Импорт: локации | agent-service.js | `locations` | ~300 слов |
| Импорт: сцены | agent-service.js | `scenes` | ~500 слов |
| Импорт: юниты | agent-service.js | `units` | ~300 слов |
| Импорт: визуалы | agent-service.js | `visuals` | ~350 слов |
| Старый импорт (всё сразу) | ai-service.js | `refineDraft()` | ~10K+ символов |
| Чат: conversation | AssistantMode.kt | mode prompt | ~50 слов |
| Чат: import | AssistantMode.kt | mode prompt | ~150 слов |
| Чат: edit | AssistantMode.kt | mode prompt | ~50 слов |
| Чат: director | AssistantMode.kt | mode prompt | ~50 слов |
| Чат: extraction | AssistantMode.kt | mode prompt | ~50 слов |
| Чат: validation | AssistantMode.kt | mode prompt | ~50 слов |
| Чат: правила режима | ai/rules/*.md | зависит от режима | ~200-500 слов |
| Чат: навыки | ai/skills/*.md | entity_extraction, composition, camera_language, lighting, directing, storyboard, continuity | ~200-500 слов каждый |
| Чат: примеры | ai/examples/*.json | import_example, book_example, scene_example | ~100-300 строк JSON |
| Чат: профиль | /data/ai-assistant-profile.md | или встроенный в chat-engine.cjs | ~200 слов |
| Чат: контекст книги | context-builder.js | Project Context + Full Book JSON | переменный |

---

## 6. Хранение данных агента

Результаты работы агента сохраняются в PostgreSQL:

- **`agent_sessions`** — сессия агента (book_id, source_type, status, progress_msg, window_data)
- **`agent_steps`** — каждый шаг пайплайна (step_type, status, result JSON, error)
- **`agent_conversations`** — записи разговоров с LLM
- **`agent_messages`** — конкретные сообщения (system, user, assistant)

Это позволяет возобновлять прерванный импорт и отслеживать прогресс через `/agent-status`.

---

## 7. Хранение Book Index для больших книг (100k–1M+ слов)

### 7.1 Проблема

При импорте книг объёмом 100k–1M+ слов полный текст не влезает в контекст LLM (типичное ограничение 8K–128K токенов). Оконная обработка решает проблему объёма, но создаёт другую: **агент теряет глобальный контекст произведения между окнами**.

### 7.2 Решение: двухуровневая память (Structured Index, не векторный RAG)

Ключевое архитектурное решение — **не векторный RAG**, а **структурированный глобальный индекс**. Разница принципиальна:

| Подход | Что хранит | Как достаётся | Размер в контексте |
|--------|-----------|---------------|-------------------|
| Векторный RAG | Embeddings текста | Semantic similarity search | Зависит от количества retrieved chunks |
| **Structured Index** | Извлечённые факты (главы, персонажи, места) | Анализ всего текста за один проход | **~2–5K токенов** — всегда влезает |

Для книжной архитектуры Structured Index выигрывает, потому что:
- Главы имеют чёткие текстовые границы, не требующие семантического поиска
- Персонажи — дискретные сущности, а не векторные окрестности
- Сюжетные линии развиваются линейно, а не по сходству
- Offset-based навигация по тексту дешевле и точнее векторного поиска

### 7.3 Уровень 1: Book Index (глобальный, ~2–5K токенов в каждом запросе)

Строится однократно на этапе **Book Analysis Pass** (отдельный вызов LLM на первой стадии импорта).

```json
{
  "book_id": "master_and_margarita",
  "metadata": {
    "title": "Мастер и Маргарита",
    "author": "Михаил Булгаков",
    "language": "ru",
    "total_word_count": 120000,
    "total_chapters": 32
  },
  "structure": {
    "has_prologue": false,
    "has_epilogue": false,
    "parts": [
      { "name": "Часть первая", "order": 1, "chapters": [0, 1, 2, 3, ...12] },
      { "name": "Часть вторая", "order": 2, "chapters": [13, 14, ...31] }
    ]
  },
  "chapters": [
    {
      "id": "ch-001",
      "index": 0,
      "title": "Никогда не разговаривайте с неизвестными",
      "type": "chapter",
      "start_offset": 1234,
      "end_offset": 23450,
      "word_count": 4500,
      "summary": "Воланд появляется на Патриарших прудах, предсказывает смерть Берлиоза",
      "key_locations": ["patriarch_ponds"],
      "key_characters": ["berlioz", "bezdomny", "woland"]
    }
  ],
  "characters": [
    {
      "id": "woland",
      "name": "Воланд",
      "role": "protagonist",
      "chapter_presence": [0, 1, 2, 5, 10, ...],
      "first_appearance_offset": 1234,
      "summary": "Таинственный иностранец, сатана"
    }
  ],
  "locations": [
    {
      "id": "patriarch_ponds",
      "name": "Патриаршие пруды",
      "type": "outdoor",
      "chapter_presence": [0, 31]
    }
  ],
  "narrative_threads": [
    {
      "id": "woland_in_moscow",
      "name": "Пребывание Воланда в Москве",
      "chapters": [0, 1, 2, 4, 7, 10, 12, ...],
      "pov_characters": ["woland", "bezdomny"]
    },
    {
      "id": "master_and_margarita",
      "name": "История Мастера и Маргариты",
      "chapters": [5, 11, 13, 19, 20, ...],
      "pov_characters": ["master", "margarita"]
    }
  ],
  "timeline_markers": [
    { "offset": 1000, "type": "time_reference", "description": "Весенний вечер", "relates_to": "chapter_0" },
    { "offset": 50000, "type": "time_jump", "description": "Полнолуние", "relates_to": "chapter_13" }
  ]
}
```

### 7.4 Уровень 2: Window Context (локальный, ~2–4K токенов)

Каждое окно получает актуальный кусок текста плюс состояние сессии:

```json
{
  "current_window": 7,
  "current_chapter": {
    "id": "ch-008",
    "index": 7,
    "title": "Бой между Воландом и Коровьевым",
    "summary": "..."
  },
  "previous_window_summary": "Коровьев показывает фокусы в Варьете, публика в панике",
  "active_characters": ["koroviev", "woland", "begemot"],
  "active_location": "variety_theatre",
  "window_text": "..."
}
```

### 7.5 Как это выглядит в промте агента

```
# Mode: Import

## Book Index (всегда присутствует — занимает ~3K токенов)
<сериализованный Book Index>

## Current Position
Глава 8: "Бой между Воландом и Коровьевым" (глава 8 из 32)
Предыдущее окно: "Коровьев показывает фокусы в Варьете, публика в панике"
Активные персонажи: koroviev, woland, begemot
Текущая локация: variety_theatre

## Window Text to Process
<текст окна, ~4K символов>

## Instructions
Разбей текст на сцены и юниты. Используй Book Index для:
- Привязки персонажей к их описаниям из index.characters
- Привязки локаций к index.locations
- Понимания, в какой части книги мы находимся
- Ссылок на сюжетные линии из index.narrative_threads
```

### 7.6 Отличие от классического RAG

| | Классический RAG | Structured Index (наш подход) |
|---|---|---|
| Источник данных | Все чанки текста, проиндексированные векторами | Только извлечённые факты (сущности + структура) |
| Retrieval | Cosine similarity по эмбеддингам | Offset-based lookup (быстрее, дешевле) |
| Детерминизм | Нет — зависит от качества эмбеддингов | Да — чёткие границы глав, персонажи — факты |
| Размер в контексте | N чанков × 500 токенов | ~3K токенов (фиксировано) |
| Когда нужен | Нет чёткой структуры (новости, web) | Есть иерархия (главы, части) |
| Стоимость | Embedding каждого чанка + reranking | Один LLM-запрос на анализ всей книги |

### 7.7 Почему это не RAG

Этот подход принципиально **не является RAG**. RAG решает задачу «найди релевантный кусок текста по смыслу». Наша задача — «дай модели стабильную карту произведения, чтобы она знала структуру и могла ссылаться на установленные факты».

Structured Index — это **память фактов**, а не **поиск по тексту**. Модели не нужно искать «похожие места в книге» — ей нужно знать, что «глава 8 находится после главы 7, в ней участвуют такие-то персонажи, и вот их описание». Это больше похоже на **семантический кэш** или **knowledge graph**, чем на RAG.

### 7.8 Сравнение: текущая архитектура vs предлагаемая

| Аспект | Сейчас (окна) | С Book Index |
|--------|--------------|-------------|
| Персонажи | Извлекаются заново в каждом окне, мержатся по ID | Берутся из глобального индекса |
| Главы | Определяются по offset-эвристике (`splitIntoChapters`) | Берутся из индекса — точные границы |
| Сюжетные линии | Не отслеживаются | Хранятся в narrative_threads |
| Контекст между окнами | Нулевой — каждое окно независимо | Передаётся previous_window_summary |
| Chapter page | Создаётся на каждом окне | Только при фактическом переходе между главами |
| Размер промта | Только текущее окно | Индекс (~3K) + окно (~4K) = ~7K токенов |

### 7.9 Когда может понадобиться классический RAG

Для книг 500k+ слов с **нелинейным повествованием** (множественные флешбеки, переплетённые сюжетные линии) имеет смысл добавить третий уровень памяти:

- **Уровень 3: Semantic Retrieval** — векторный поиск по сценам для ответов на вопросы вида «а что было в сцене, где Воланд впервые встретился с Маргаритой?»

Но для основной задачи импорта (разбить текст на сцены, извлечь персонажей, создать визуальные промты) двух уровней более чем достаточно.
