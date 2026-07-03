# Coreference Resolution — Architectural Review

## Контекст

Ревью относится к документам:

- `docs/07-agents-and-generators/COREFERENCE_RESOLUTION.md`
- `docs/07-agents-and-generators/COREFERENCE_TODO.md`

Цель фичи правильная: до генерации visual prompts нужно уметь разрешать
упоминания персонажей вроде "редактор", "продавщица", "он", "она" в
канонические `character_id`, не полагаясь на regex-угадывание в
`image-service.js`.

Важные архитектурные уточнения:

- Есть два разных окна, их нельзя смешивать:
  - **окно разведки / analysis window**: примерно 4000 символов, нужно для
    широкого LLM-контекста и грубого сбора кандидатов: кто потенциально
    активен в этом фрагменте, какие алиасы/роли встретились, какой nearby
    context нужен для местоимений;
  - **окно сборки / generation span**: примерно 1500 символов, текущий
    ограниченный фрагмент, из которого собираются сцены/юниты и где нужен
    точный mention-level resolution.
- Токены нужно жечь на точность только там, где результат реально попадёт в
  текущие сцены/юниты. Поэтому целевая схема: **coarse pass по 4000** строит
  candidate set, **fine pass по 1500** размечает конкретные mentions.
- Coreference-данные должны храниться **только в БД**. Не нужно добавлять
  `sentence_map` в `chapters/*.json` и раздувать book JSON производными
  данными.
- JSON книги должен оставаться творческим/авторским payload. Resolution,
  aliases, mention spans, версии и audit trail — это индексируемое
  производное состояние, его место в PostgreSQL.

## Общая оценка

Направление хорошее: вынести coreference в отдельный этап пайплайна до
visual prompts и заменить эвристики явным результатом разведки. Это снижает
случайные false positive, делает поведение проверяемым и даёт основу для
нормального аудита.

Главные проблемы текущего плана:

1. Документы смешивают sentence-level и unit-level ответственность.
2. Предложение хранить `sentence_map` в JSON создаёт второй источник истины.
3. `safeAliasIndex` в описанном виде небезопасен, потому что строится из
   предложения целиком, а не из конкретных mention spans.
4. План не использует естественное разделение coarse/fine: широкое окно нужно
   для кандидатов, а точная разметка нужна только для сборочного span.
5. Нет чёткой схемы версионирования resolution относительно source offsets,
   scene spans, unit spans и версии character registry.

## Что Хорошо

### 1. Правило "не угадывай"

Это ключевое правильное решение. Для image generation ложная привязка хуже,
чем отсутствие привязки: если модель получила паспорт не того персонажа, кадр
визуально загрязнён сильнее, чем при пропущенном паспорте.

Правило должно остаться жёстким:

- uncertain mention -> `unknown`;
- generic mention без контекста -> `unknown`;
- ambiguous alias -> не добавлять в alias index;
- pronouns никогда не становятся stable aliases.

### 2. Отдельный этап разведки

`resolve_characters` как отдельный pipeline step — хорошая граница. Это не
должно жить внутри `image-service.js`: image service должен потреблять уже
подготовленные участники кадра, а не заниматься литературным анализом.

### 3. Позиция до visual prompts

Coreference должен происходить до `create_visual_prompts`, иначе visual prompt
author продолжит получать неполный список участников и будет вынужден решать
задачу сам, без стабильного контракта.

### 4. Оконная обработка

Работа по окнам правильная. Coreference не должен анализировать всю книгу за
один вызов. Более того, не нужно делать полный дорогой resolution по всему
окну разведки. Нужно явно разделить:

- **coarse pass по analysis window ~4000**: собрать кандидатов, активных
  персонажей, видимые алиасы/роли, nearby context;
- **fine pass по generation span ~1500**: строго разметить только те
  предложения и mentions, которые реально попадут в текущие сцены/юниты.

Это экономит токены и снижает шум: широкий контекст используется для понимания,
но не превращается напрямую в участников кадра.

## Что Не Хорошо

### 1. `scene.participants` как главный результат resolution слишком грубый

Если просто собрать всех персонажей из `sentence_map` в `scene.participants`,
каждый IU сцены начнёт получать паспорта всех персонажей сцены. Для кадра,
где в тексте есть только продавщица, могут быть inject-нуты Берлиоз и
Бездомный, потому что они есть в соседних предложениях той же сцены.

Это ломает главный принцип IU: кадр должен показывать только то, что есть в
unit text.

Лучше:

- resolution работает на уровне предложений и mention spans;
- после `create_units` каждый `unit` получает свой список участников через
  пересечение `unit.source_start/source_end` с resolved sentence spans;
- `scene.participants` становится агрегатом для scene-level metadata, но не
  главным источником паспортов для каждого изображения;
- `buildCharacters()` должен предпочитать `unit.participants`, а
  `scene.participants` использовать только как fallback.

### 2. `sentence_map` в JSON — лишний "фарш"

Добавлять `sentence_map` в `chapters/*.json` не стоит. Это производный индекс,
а не авторский контент сцены.

Минусы JSON-хранения:

- раздувает book payload;
- усложняет diff и scene hash;
- создаёт риск рассинхрона с PG;
- смешивает творческое состояние книги с аналитическими индексами;
- заставляет UI/API таскать данные, которые нужны в основном backend-пайплайну.

Решение: хранить resolution только в PostgreSQL.

### 3. `safeAliasIndex` нельзя строить из слов предложения

Псевдокод `buildSafeAliasIndex(sentenceMap, text, characters)` опасен: если в
предложении есть два персонажа, а функция извлекла "значимые слова", она не
знает, какое слово относится к какому персонажу.

Пример:

> "Продавщица ответила Берлиозу, а поэт нахмурился."

Sentence-level список будет:

```json
["booth_woman", "mikhail_aleksandrovich_berlioz", "ivan_nikolaevich_ponyrev"]
```

Из этого нельзя безопасно вывести:

- "продавщица" -> `booth_woman`
- "Берлиозу" -> `mikhail_aleksandrovich_berlioz`
- "поэт" -> `ivan_nikolaevich_ponyrev`

Нужны mention-level данные.

### 4. Coreference per scene теряет контекст

Если resolution запускать отдельно на `scene.text`, местоимения в начале сцены
могут потерять antecedent из предыдущего предложения/сцены. Особенно это
важно, если сцена начинается продолжением действия: "Он повернулся..." после
предыдущей сцены, где субъект был явно назван.

Но и полный точный resolution на все 4000 символов избыточен: значительная
часть analysis window может не попасть в текущий generation span. Лучше:

- на **analysis window ~4000** запускать грубый сбор кандидатов;
- на **generation span ~1500** запускать точный mention-level resolver;
- в fine prompt передавать не весь `characters.json`, а candidate set из
  coarse pass плюс короткий surrounding context из analysis window;
- сохранять абсолютные source offsets и потом раскладывать результат по сценам
  и юнитам.

### 5. Нет версионирования resolution

Coreference зависит от:

- исходного текста и source offsets;
- текущего списка персонажей;
- версии prompt/schema;
- модели;
- правил unknown/generic aliases.

Если персонаж переименован, объединён с дублем или изменился character registry,
старые resolution rows могут стать некорректными. Нужен `resolver_version` и
`character_registry_hash`.

## Рекомендуемая Архитектура

### 1. DB-only storage

Не добавлять `sentence_map` в scene JSON.

Основные таблицы:

```sql
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

CREATE TABLE IF NOT EXISTS sentence_resolutions (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id          UUID NOT NULL REFERENCES character_resolution_runs(run_id) ON DELETE CASCADE,
    book_id         TEXT NOT NULL,
    chapter_id      TEXT,
    sentence_index  INTEGER NOT NULL,
    source_start    INTEGER NOT NULL,
    source_end      INTEGER NOT NULL,
    sentence_text   TEXT NOT NULL,
    character_ids   TEXT[] NOT NULL DEFAULT '{}',
    unknown_mentions JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    UNIQUE(run_id, sentence_index)
);

CREATE TABLE IF NOT EXISTS character_mentions (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id          UUID NOT NULL REFERENCES character_resolution_runs(run_id) ON DELETE CASCADE,
    book_id         TEXT NOT NULL,
    chapter_id      TEXT,
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

CREATE INDEX IF NOT EXISTS idx_sentence_resolutions_book_span
    ON sentence_resolutions(book_id, source_start, source_end);

CREATE INDEX IF NOT EXISTS idx_character_candidates_book_window
    ON character_window_candidates(book_id, analysis_window_index);

CREATE INDEX IF NOT EXISTS idx_character_mentions_book_char
    ON character_mentions(book_id, character_id);

CREATE INDEX IF NOT EXISTS idx_character_mentions_norm
    ON character_mentions(book_id, mention_norm);
```

Для alias index можно добавить материализованную/обычную таблицу:

```sql
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
```

### 2. Pipeline shape

Рекомендуемый порядок:

1. `analyze_structure`
2. `analyze_characters`
3. `analyze_locations`
4. `collect_character_candidates` на analysis window ~4000
5. `create_scenes` из generation span ~1500
6. `resolve_character_mentions` на generation span ~1500, используя candidates
   из шага 4 и surrounding context из analysis window
7. `create_units`
8. `assign_unit_participants` из DB mentions + unit spans
9. `create_visual_prompts`

Вариант 6 и 7 можно поменять местами, если удобнее:

1. сначала создать units;
2. затем fine mention resolution;
3. затем проставить `unit.participants`.

Критично не это, а правило: visual prompts должны видеть unit-level
participants, а не только scene-level participants.

### 3. Analysis window vs generation span

Нужно ввести явные имена в коде и документах:

- `analysisWindowStart`
- `analysisWindowEnd`
- `generationSpanStart`
- `generationSpanEnd`

Coarse/fine split:

```text
analysis window:       [source_start ... source_start + ~4000]
coarse candidates:     possible_character_ids + aliases_seen + active_context

generation span:       [source_start ... source_start + ~1500]
created scenes:        contiguous prefix внутри generation span
fine resolution:       mention-level rows только внутри generation span
unit participants:     пересечение unit spans с fine resolved mentions
```

Так resolver видит широкий контекст, но дорогая точная разметка делается только
для текста, который реально сейчас собирается. Coarse candidates нельзя
напрямую использовать как participants для scene/unit/image generation.

### 4. Coarse candidate pass

Грубый проход по 4000 должен отвечать на вопрос:

> Кто потенциально активен в этом контексте и какие алиасы/роли могут
> встретиться в ближайшем generation span?

Output должен быть маленьким:

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

Этот результат:

- сохраняется в `character_window_candidates`;
- сужает `%KNOWN_CHARACTERS%` для fine resolver;
- не попадает напрямую в `scene.participants`;
- не inject-ит паспорта.

### 5. Fine resolver output

Fine resolver получает generation span ~1500, candidate set из coarse pass и
короткий surrounding context. Он должен возвращать не только `characters: []`,
а mentions:

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

Validation rules:

- `character_id` must be in known characters;
- unknown mention has `character_id = null`, not `"unknown"` as fake character;
- sentence text must match deterministic splitter output;
- mention offsets should be computed by code after response parsing;
- duplicate mentions are deduped by `(source_start, source_end, character_id)`.

### 6. Safe aliases

Alias index строится только из `character_mentions`, не из raw sentence words.

Safe alias criteria:

- mention type is `name`, `nickname`, `profession`, `title`, or stable
  description;
- not pronoun;
- not generic word;
- maps to exactly one character in the whole book;
- appears at least N times, or is manually approved, or comes from canonical
  character name;
- no collision after normalization.

Unsafe examples:

- "он"
- "она"
- "мужчина"
- "женщина"
- "человек"
- "люди"
- "поэт", если в книге больше одного поэта
- "редактор", если есть несколько редакторов или role changes over time

### 7. Image service contract

`image-service.js` должен стать потребителем, а не resolver.

Желательное поведение:

1. `buildCharacters(scene, unit, chapter, book)`:
   - primary: `unit.participants`;
   - secondary: explicit `scene.participants`;
   - fallback: DB safe aliases / legacy prompt inference.
2. `inferCharactersFromPrompt()`:
   - оставить как fallback;
   - не считать его canonical;
   - логировать, когда fallback сработал.
3. `normalizeCharacterRefs()`:
   - использовать safe aliases из DB;
   - не заменять generic/pronouns;
   - не делать fuzzy replacement без collision check.

## Что Лучше Поправить в TODO

### P0 — Schema

Заменить:

- "миграция для `scenes` -> поле `sentence_map JSONB`"

На:

- `character_resolution_runs`
- `sentence_resolutions`
- `character_mentions`
- `character_aliases`
- добавить `resolve_characters` в `agent_steps.step_type`
- обновить purge/reconcile для удаления resolution rows при удалении сцен/книги

### P1 — Prompt

Добавить в prompt:

- output mentions, not only character arrays;
- never return `"unknown"` as character id;
- include evidence for non-name mentions;
- pronouns are resolvable only inside local context;
- generic nouns require explicit nearby antecedent.

### P2 — Agent Service

Заменить `stepResolveCharacters(sessionId, bookId, scene, characters)` на два
шага:

```js
stepCollectCharacterCandidates(sessionId, bookId, {
  analysisWindowText,
  analysisWindowStart,
  analysisWindowEnd,
  characters,
  chapterId,
  windowIndex,
})
```

И:

```js
stepResolveCharacterMentions(sessionId, bookId, {
  generationSpanText,
  generationSpanStart,
  generationSpanEnd,
  surroundingContext,
  candidateCharacters,
  chapterId,
  windowIndex,
})
```

Результат сохранять в PG, не в scene JSON.

### P3 — Unit Participants

Добавить отдельный шаг:

```js
assignUnitParticipants(bookId, chapterId, sceneId, units)
```

Он читает `character_mentions` по source span и возвращает participants для
каждого unit.

### P4 — Safe Alias Index

Строить alias table из `character_mentions`, а не из sentence text напрямую.
Нужны тесты на:

- два персонажа в одном предложении;
- collision alias;
- generic word;
- pronoun;
- profession, которая валидна только для одного персонажа.

### P5 — Storage

Заменить полностью:

- не хранить `sentence_map` в `chapters/*.json`;
- не хранить safe aliases в Redis как source of truth;
- хранить resolution и aliases в PostgreSQL;
- Redis можно использовать только как cache с TTL/version key.

### P6 — Tests

Добавить:

- coarse candidate pass validation;
- resolver output validation;
- unit participant assignment by source spans;
- alias collision across the whole book;
- stale resolution after character registry hash changes;
- scene deletion purges resolution rows;
- fallback image inference does not override DB participants.

### Token burn

Если делать точный mention-level resolution по полным 4000 символам, стоимость
растёт без пользы: не весь analysis window будет использован текущим
generation span. Если делать resolution только по 1500 без широкого контекста,
теряется качество местоимений и ролевых упоминаний.

Митигация:

- 4000 -> дешёвый coarse pass;
- 1500 -> дорогой fine pass;
- fine prompt получает только candidate characters, а не весь character registry.

## Риски

### False positives

Главный риск. Митигация:

- conservative prompt;
- unknown by default;
- mention-level confidence/evidence;
- collision-aware aliases;
- tests on ambiguous examples.

### Stale DB rows

Если source text or character registry changed, old rows must be invalidated.
Митигация:

- `source_hash`;
- `character_registry_hash`;
- `resolver_version`;
- cleanup by run;
- only latest completed run is active.

### Offset drift

Если sentence splitter и source coverage считают offsets по-разному, unit
participants будут неверными.

Митигация:

- один deterministic splitter;
- абсолютные offsets;
- tests with dialogue punctuation, quotes, ellipsis, Cyrillic.

### Over-injection of scene participants

Если оставить текущий scene-level подход, visual prompts будут получать лишние
паспорта.

Митигация:

- primary source for image passports = `unit.participants`;
- scene-level participants only fallback/metadata.

## Итог

Фича нужна и архитектурно оправдана, но её лучше строить не как
`sentence_map` внутри scene JSON, а как DB-backed coreference index.

Ключевые решения:

1. Развести **analysis window ~4000** и **generation span ~1500**.
2. Делать coarse candidate collection по 4000, а fine mention resolution по
   1500.
3. Хранить resolution только в PostgreSQL.
4. Перейти от sentence-level arrays к mention-level rows.
5. Проставлять participants на уровне unit.
6. Использовать safe aliases только как проверенный fallback, не как основной
   механизм.

Если сделать именно так, `image-service.js` станет проще: он будет брать
готовые participants и passports, а не пытаться восстанавливать смысл текста
regex-ами и fuzzy matching.
