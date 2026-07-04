# Coreference Resolution — Sentence-Level Character Map

## Problem Statement

AI-агент генерации visual prompts иногда использует для описания персонажей не их `character_id`, а естественные языковые обороты:

- *"Продавщица налила им газировки"* вместо `booth_woman`
- *"Редактор обернулся"* вместо `berlioz`
- *"Поэт задумался"* вместо `bezdomny`
- *"Он посмотрел на неё"* — местоимения, требующие разрешения

Текущий подход (`inferCharactersFromPrompt()`) пытается матчить эти упоминания через regex по `character.id` и `character.name` — **это ненадёжно**, потому что:

| Проблема | Пример | Исход |
|---|---|---|
| Профессия вместо ID | "продавщица" ≠ `booth_woman` | ❌ Не найдено |
| Местоимение | "он", "ему" — generic | ❌ Не найдено / false positive |
| Нестандартное имя | "Миша", "Мишечка" ≠ `mikhail_aleksandrovich_berlioz` | ❌ Не найдено |
| Описание | "лысый господин в очках" — не имя | ❌ Не найдено |
| Generic alias | "женщина" — может относиться к любой женщине | ❌ False positive |

## Core Principle: Не угадывай

**Жёсткое правило:** если идентификация персонажа неочевидна из контекста — `unknown`, а не привязывай к случайному персонажу.

Одна ложная привязка = модель генерации изображения inject-нет паспорт НЕ того персонажа → визуал получит внешность продавщицы для персонажа, который ей не является.

## Архитектура: Две фазы вместо одной

### Ключевое архитектурное решение: Coarse/Fine Split

Есть два разных окна, их нельзя смешивать:

| Окно | Размер | Назначение | Стоимость |
|---|---|---|---|
| **Analysis window** (окно разведки) | ~4000 символов | Грубый сбор кандидатов: кто потенциально активен, какие алиасы/роли встретились | Дешёвый LLM-вызов |
| **Generation span** (окно сборки) | ~1500 символов | Точная mention-level разметка только для текста, который реально попадёт в текущие сцены/юниты | Дорогой LLM-вызов |

**Почему это важно:** дешёвый coarse pass по 4000 строит candidate set, дорогой fine pass по 1500 размечает конкретные mentions. Не весь analysis window будет использован текущим generation span — нет смысла жечь токены на точную разметку текста, который не собирается в сцены.

```
analysis window:       [source_start ... source_start + ~4000]
                                ↓
coarse candidates:     possible_character_ids + aliases_seen + active_context
                                ↓
generation span:       [source_start ... source_start + ~1500]
                                ↓
fine resolution:       mention-level rows только внутри generation span
                                ↓
unit participants:     пересечение unit spans с fine resolved mentions
```

### Pipeline

```
Шаг 0: analyze_structure                 — метаданные книги (один раз)
Шаг 1: analyze_characters                — персонажи
Шаг 2: analyze_locations                 — локации
Шаг 3: collect_character_candidates      — coarse pass по analysis window ~4000
Шаг 4: create_scenes                     — сцены из generation span ~1500
Шаг 5: resolve_character_mentions        — fine pass по generation span ~1500
Шаг 6: create_units                      — IU с известными source spans
Шаг 7: assign_unit_participants          — пересечение unit spans с resolved mentions
Шаг 8: create_visual_prompts             — паспорта из unit.participants
```

Ключевое правило: visual prompts видят unit-level participants, а не только scene-level.

---

## Фаза 1: Coarse Candidate Pass

Грубый проход по analysis window (~4000 символов). Отвечает на вопрос:

> Кто потенциально активен в этом контексте и какие алиасы/роли могут встретиться в ближайшем generation span?

**Вход:**
- Текст окна (`source_text[analysisWindowStart..analysisWindowEnd]`)
- Список всех персонажей (`characters.json`)
- `chapter_id`, `window_index`

**Выход — маленький JSON:**

```json
{
  "candidate_characters": [
    {
      "character_id": "mikhail_aleksandrovich_berlioz",
      "aliases_seen": ["Берлиоз", "редактор"],
      "evidence": "named in the opening paragraph and remains active in dialogue",
      "confidence": 0.95
    }
  ],
  "unknown_roles": ["женщина в будочке"],
  "context_notes": "Dialogue at the drinks booth; pronouns likely refer to Berlioz and Bezdomny unless booth woman is locally active."
}
```

**Этот результат:**
- Сохраняется в БД (`character_window_candidates`)
- Сужает `%KNOWN_CHARACTERS%` для fine resolver
- **НЕ** попадает напрямую в `scene.participants`
- **НЕ** inject-ит паспорта

---

## Фаза 2: Fine Mention Resolution

Точный проход по generation span (~1500 символов). Получает candidate set из coarse pass и короткий surrounding context из analysis window.

**Вход:**
- Текст generation span
- Candidate characters из coarse pass
- Surrounding context (несколько предложений до/после из analysis window)

**Выход — mention-level данные:**

```json
{
  "sentences": [
    {
      "index": 0,
      "text": "Продавщица ответила Берлиозу.",
      "characters": ["booth_woman", "mikhail_aleksandrovich_berlioz"],
      "mentions": [
        {
          "text": "Продавщица",
          "character_id": "booth_woman",
          "type": "profession",
          "role": "subject",
          "confidence": 0.92,
          "evidence": "same booth woman from previous sentence"
        },
        {
          "text": "Берлиозу",
          "character_id": "mikhail_aleksandrovich_berlioz",
          "type": "name",
          "role": "object",
          "confidence": 0.99
        }
      ],
      "unknown_mentions": []
    }
  ]
}
```

**Validation rules:**
- `character_id` должен быть в known characters
- unknown mention имеет `character_id: null`, не `"unknown"` как fake character
- mention offsets вычисляются кодом после парсинга ответа
- Дубликаты dedup-ятся по `(source_start, source_end, character_id)`

### Промпт агента

```javascript
SYSTEM_PROMPTS.resolve_characters: `You are a literary analysis assistant.
Identify which KNOWN characters are present in each sentence of the provided text.
Return mention-level data for each resolved character reference.

## Rules (strict priority)
1. Use ONLY character_ids from the Known Characters list
2. NEVER return "unknown" as a character_id — use null for unresolvable mentions
3. If the same person is referred to by pronoun ("он", "она", "ему", "его"),
   profession ("редактор", "продавщица"), description ("лысый господин"),
   or nickname ("Бездомный") — resolve to their canonical character_id
4. If a mention could refer to MULTIPLE characters — mark character_id as null
5. NEVER guess. If identification is uncertain → null
6. Generic words ("мужчина", "женщина", "человек", "люди", "толпа")
   are ONLY resolvable with adjacent context. If the context window
   (2 sentences before, 2 after) clearly identifies who it is → resolve.
   Otherwise → null.
7. Pronouns are resolvable ONLY inside local context with explicit antecedent
8. Include evidence text for non-name mentions (profession, description, pronoun)

## Context window
For each sentence, you receive:
- 2 sentences BEFORE (or start of text)
- The CURRENT sentence
- 2 sentences AFTER (or end of text)

## Candidate Characters
%KNOWN_CHARACTERS%

## Output format
{
  "sentences": [
    {
      "index": 0,
      "text": "original sentence text",
      "characters": ["known_character_id", "known_character_id"],
      "mentions": [
        {
          "text": "the exact mention text",
          "character_id": "known_character_id",
          "type": "name|profession|description|pronoun|nickname|title",
          "role": "subject|object|possessive|passive",
          "confidence": 0.0-1.0,
          "evidence": "why this resolution was made"
        }
      ],
      "unknown_mentions": ["word that could not be resolved"]
    }
  ]
}

Return ONLY valid JSON.`
```

---

## Фаза 3: Assign Unit Participants

После `create_units` каждый unit имеет `source_start`/`source_end`. Читаем `character_mentions` из БД по пересечению source span и получаем participants для каждого unit.

```javascript
function assignUnitParticipants(bookId, chapterId, sceneId, units) {
    // 1. Загрузить character_mentions для данного generation span
    // 2. Для каждого unit: найти mentions, где
    //    mention.source_start >= unit.source_start AND
    //    mention.source_end   <= unit.source_end
    // 3. Собрать уникальные character_id
    // 4. Вернуть { unitId: [character_ids] }
}
```

**Правила:**
- Primary source: `unit.participants` (из пересечения spans)
- Secondary: `scene.participants` (как fallback для scene-level metadata)
- Fallback: legacy `inferCharactersFromPrompt()` (логировать, когда сработал)

### Текущие implementation guards

В текущей реализации `unit.participants` уже используется как основной ограничитель для visual prompts:

- visual context включает union `scene.participants` и `unit.participants`, чтобы агент видел паспорта только известных релевантных персонажей;
- каждый IU передаётся в prompt как `participants=[...]`;
- passport injection строится по `unit.participants`, а если они пустые — по `scene.participants`;
- fallback visual больше не добавляет всех персонажей книги, когда participants пустые;
- text fallback для `assign_unit_participants` не матчит `mention_type='pronoun'`, потому что подстроки вроде "он" / "она" дают false positive;
- unresolved mentions с `character_id: null` не попадают в participants;
- ответы fine resolver валидируются по known character ids: неизвестные/выдуманные id сохраняются как `null`, а не как новый персонаж.

Пока source spans у IU появляются позднее visual шага, `assignUnitParticipants()` использует консервативный text fallback по `mention_text`. После переноса span assignment до visual generation этот шаг должен перейти на span intersection, описанный выше.

---

## Safe Alias Index

### Строится ТОЛЬКО из character_mentions, НЕ из raw sentence words

```javascript
function buildSafeAliasIndex(characterMentions) {
    // characterMentions — массив из БД: { mention_text, mention_norm, character_id, mention_type }
    const aliasMap = new Map() // alias_norm → Set<character_id>
    const collisions = new Set()

    for (const m of characterMentions) {
        if (UNSAFE_TYPES.has(m.mention_type)) continue // pronoun, unknown
        if (isGenericWord(m.mention_norm)) continue

        const existing = aliasMap.get(m.mention_norm) || new Set()
        existing.add(m.character_id)
        aliasMap.set(m.mention_norm, existing)

        if (existing.size > 1) {
            // Same word maps to multiple characters → collision
            collisions.add(m.mention_norm)
        }
    }

    // Collision check: если alias → несколько character_id → удаляем
    for (const alias of collisions) {
        aliasMap.delete(alias)
    }

    // Результат: alias_norm → character_id (только unambiguous)
    return Object.fromEntries(
        [...aliasMap.entries()]
            .filter(([_, ids]) => ids.size === 1)
            .map(([alias, ids]) => [alias, [...ids][0]])
    )
}
```

### Безопасные алиасы

| Тип | Безопасно? | Пример |
|---|---|---|
| `name` | ✅ | "Берлиоз" → berlioz |
| `nickname` | ✅ | "Бездомный" → bezdomny |
| `profession` | ✅ (если ≤1 персонаж с этой ролью) | "редактор" → berlioz |
| `title` | ✅ (если ≤1 персонаж) | "председатель" → berlioz |
| `description` | ❌ (только если known unique) | "лысый господин" |
| `pronoun` | ❌ (никогда) | "он", "она" |
| `unknown` | ❌ | — |

### Generic-слова, которые НЕ попадают в индекс

```
он, она, оно, они, его, её, их, ему, ей, ним,
мужчина, женщина, человек, люди, толпа,
господин, госпожа, товарищ, гражданин,
кто-то, некто, кто-нибудь, все
```

---

## Схема данных (PostgreSQL — единственный источник истины)

**Решение: хранить resolution ТОЛЬКО в БД.** Не добавлять `sentence_map` в `chapters/*.json`.

- JSON книги должен оставаться творческим/авторским payload
- Resolution, aliases, mention spans — индексируемое производное состояние
- Раздувание JSON усложняет diff, scene hash, sync с PG

```sql
-- Run-level tracking (для версионирования и инвалидации)
CREATE TABLE IF NOT EXISTS character_resolution_runs (
    run_id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    book_id                 TEXT NOT NULL,
    chapter_id              TEXT,
    analysis_window_index   INTEGER NOT NULL,
    run_type                TEXT NOT NULL CHECK(run_type IN ('coarse_candidates','fine_mentions')),
    source_start            INTEGER NOT NULL,
    source_end              INTEGER NOT NULL,
    generation_start        INTEGER,
    generation_end          INTEGER,
    resolver_version        TEXT NOT NULL,
    model                   TEXT,
    character_registry_hash TEXT NOT NULL,
    source_hash             TEXT NOT NULL,
    status                  TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
    error                   TEXT,
    created_at              BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    completed_at            BIGINT
);

-- Coarse candidate collection
CREATE TABLE IF NOT EXISTS character_window_candidates (
    id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id                  UUID NOT NULL REFERENCES character_resolution_runs(run_id) ON DELETE CASCADE,
    book_id                 TEXT NOT NULL,
    chapter_id              TEXT,
    analysis_window_index   INTEGER NOT NULL,
    source_start            INTEGER NOT NULL,
    source_end              INTEGER NOT NULL,
    character_id            TEXT NOT NULL,
    alias_texts             TEXT[] NOT NULL DEFAULT '{}',
    evidence                TEXT,
    confidence              REAL,
    created_at              BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    UNIQUE(run_id, character_id)
);

-- Sentence-level resolution (для scene-level metadata)
CREATE TABLE IF NOT EXISTS sentence_resolutions (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id          UUID NOT NULL REFERENCES character_resolution_runs(run_id) ON DELETE CASCADE,
    book_id         TEXT NOT NULL,
    chapter_id      TEXT,
    scene_id        TEXT NOT NULL,
    sentence_index  INTEGER NOT NULL,
    source_start    INTEGER NOT NULL,
    source_end      INTEGER NOT NULL,
    sentence_text   TEXT NOT NULL,
    character_ids   TEXT[] NOT NULL DEFAULT '{}',
    unknown_mentions JSONB NOT NULL DEFAULT '[]'::jsonb,
    resolved_by     TEXT NOT NULL DEFAULT 'agent' CHECK(resolved_by IN ('agent','fallback')),
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    UNIQUE(run_id, scene_id, sentence_index)
);

-- Mention-level data (основная таблица — для unit participants)
CREATE TABLE IF NOT EXISTS character_mentions (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id          UUID NOT NULL REFERENCES character_resolution_runs(run_id) ON DELETE CASCADE,
    book_id         TEXT NOT NULL,
    chapter_id      TEXT,
    scene_id        TEXT,
    sentence_index  INTEGER NOT NULL,
    source_start    INTEGER NOT NULL,
    source_end      INTEGER NOT NULL,
    mention_text    TEXT NOT NULL,
    mention_norm    TEXT NOT NULL,
    character_id    TEXT,
    mention_type    TEXT NOT NULL CHECK(mention_type IN (
                        'name','profession','description','pronoun','nickname','title','unknown'
                    )),
    role            TEXT CHECK(role IN ('subject','object','possessive','passive','unknown')),
    confidence      REAL,
    evidence        TEXT,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);

-- Alias index (материализованный из mentions)
CREATE TABLE IF NOT EXISTS character_aliases (
    book_id         TEXT NOT NULL,
    alias_norm      TEXT NOT NULL,
    alias_text      TEXT NOT NULL,
    character_id    TEXT NOT NULL,
    source          TEXT NOT NULL CHECK(source IN ('character_name','mention_resolution','manual')),
    evidence_count  INTEGER NOT NULL DEFAULT 1,
    is_safe         BOOLEAN NOT NULL DEFAULT FALSE,
    reason          TEXT,
    updated_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    PRIMARY KEY(book_id, alias_norm, character_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sentence_resolutions_book_span
    ON sentence_resolutions(book_id, source_start, source_end);
CREATE INDEX IF NOT EXISTS idx_character_candidates_book_window
    ON character_window_candidates(book_id, analysis_window_index);
CREATE INDEX IF NOT EXISTS idx_character_mentions_book_span
    ON character_mentions(book_id, source_start, source_end);
CREATE INDEX IF NOT EXISTS idx_character_mentions_book_char
    ON character_mentions(book_id, character_id);
CREATE INDEX IF NOT EXISTS idx_character_aliases_book
    ON character_aliases(book_id, alias_norm);
```

### Версионирование

Каждый resolution run хранит:
- `resolver_version` — версия промпта/схемы
- `character_registry_hash` — хеш списка персонажей на момент resolution
- `source_hash` — хеш исходного текста

**Причина:** если персонаж переименован, объединён с дублем или изменился character registry, старые resolution rows могут стать некорректными. Только latest completed run считается активным.

---

## Интеграция с image-service.js

`image-service.js` должен стать **потребителем**, а не resolver.

```javascript
function buildCharacters(scenePayload, unit, chapter, book) {
    // 1. Primary: unit.participants (из assignUnitParticipants)
    if (unit?.participants?.length) {
        return buildFromParticipants({ participants: unit.participants }, unit, chapter, book)
    }
    // 2. Secondary: scene.participants
    if (scenePayload?.participants?.length) {
        return buildFromParticipants(scenePayload, unit, chapter, book)
    }
    // 3. Fallback: infer from prompt (legacy — логировать!)
    const inferred = inferCharactersFromPrompt(unit.visual?.prompt, book)
    if (inferred.length) {
        console.warn(`[COREFERENCE] Fallback infer for unit ${unit.id} — resolution not available`)
    }
    return buildFromCharactersList(inferred, unit, chapter, book)
}

function normalizeCharacterRefs(prompt, book, aliasIndex) {
    // Использовать safe aliases из БД (character_aliases table)
    // Не заменять generic/pronouns
    // Не делать fuzzy replacement без collision check
    if (!aliasIndex) return prompt

    let result = prompt
    for (const [alias, charId] of Object.entries(aliasIndex)) {
        const re = new RegExp(`\\b${escapeRegex(alias)}\\b`, 'gi')
        result = result.replace(re, charId)
    }
    return result
}
```

---

## Сравнение: было vs стало

| Аспект | Было (regex + fuzzy) | Стало (LLM resolution) |
|---|---|---|
| **Coreference** | Нет | Coarse + Fine двухфазный |
| **"Продавщица" → booth_woman** | ❌ | ✅ |
| **"Он" → berlioz** | ❌ | ✅ (только с контекстом) |
| **Token burn** | Не учитывалась | Coarse ~4000 (дёшево), Fine ~1500 (дорого) |
| **Хранение** | JSONB в chapters | Только PostgreSQL |
| **Уровень данных** | Sentence-level | Mention-level (текст, offset, type, role) |
| **Passports injection** | Всем IU сцены | Только relevant IU (по span intersection) |
| **Ложные срабатывания** | Возможны | Нет (правило "не угадывай") |
| **Версионирование** | Нет | resolver_version + hashes |
| **SafeAliasIndex** | Из слов предложения | Из mention-level rows |

## Token Burn — митигация

| Подход | Tokens | Результат |
|---|---|---|
| Полный resolution на 4000 | ~8000 токенов | Избыточно — не весь текст идёт в сцены |
| Resolution только на 1500 | ~3000 токенов | Теряется контекст для местоимений |
| **Coarse 4000 + Fine 1500** | ~2000 + ~3000 = ~5000 | Оптимально — контекст есть, точность высокая |

## Риски

| Риск | Митигация |
|---|---|
| **False positives** | Conservative prompt + unknown by default + mention-level confidence |
| **Stale DB rows** | source_hash + character_registry_hash + per-run invalidation |
| **Offset drift** | Один deterministic splitter + абсолютные offsets + тесты |
| **Over-injection** | Primary = unit.participants, не scene.participants |
