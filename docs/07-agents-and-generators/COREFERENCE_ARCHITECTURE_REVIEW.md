# Coreference Resolution — Architectural Review

## Context

This review relates to the following documents:

- `docs/07-agents-and-generators/COREFERENCE_RESOLUTION.md`
- `docs/07-agents-and-generators/COREFERENCE_TODO.md`

The feature goal is correct: before generating visual prompts, the system must be
able to resolve character mentions like "editor", "saleswoman", "he", "she" into
canonical `character_id` values, without relying on regex guessing in
`image-service.js`.

Important architectural clarifications:

- There are two distinct windows that must not be mixed:
  - **Analysis window**: approximately 4000 characters, used for broad LLM context
    and coarse candidate collection: who is potentially active in this fragment,
    what aliases/roles were encountered, what nearby context is needed for pronouns;
  - **Generation span**: approximately 1500 characters, the current bounded fragment
    from which scenes/units are built and where precise mention-level resolution is needed.
- Tokens should be spent on accuracy only where the result will actually appear in
  current scenes/units. Therefore the target scheme: **coarse pass over 4000** builds
  a candidate set, **fine pass over 1500** marks specific mentions.
- Coreference data must be stored **only in the database**. There is no need to add
  `sentence_map` to `chapters/*.json` and inflate book JSON with derived data.
- Book JSON must remain the creative/author payload. Resolution, aliases, mention
  spans, versions, and audit trail are indexable derived state — their place is in
  PostgreSQL.

## Overall Assessment

The direction is sound: extract coreference into a separate pipeline stage before
visual prompts and replace heuristics with an explicit resolution result. This
reduces random false positives, makes behavior testable, and provides a basis for
proper auditing.

Main issues with the current plan:

1. Documents mix sentence-level and unit-level responsibilities.
2. The proposal to store `sentence_map` in JSON creates a second source of truth.
3. `safeAliasIndex` as described is unsafe because it is built from entire sentences
   rather than specific mention spans.
4. The plan does not leverage the natural coarse/fine split: a wide window is needed
   for candidates, but precise annotation is only needed for the generation span.
5. There is no clear versioning scheme for resolution relative to source offsets,
   scene spans, unit spans, and character registry versions.

## What's Good

### 1. The "don't guess" rule

This is the key correct decision. For image generation, a false binding is worse
than no binding: if the model received the wrong character's passport, the frame
is visually corrupted more than with a missing passport.

The rule must remain strict:

- uncertain mention → `unknown`;
- generic mention without context → `unknown`;
- ambiguous alias → do not add to alias index;
- pronouns never become stable aliases.

### 2. Separate resolution stage

`resolve_characters` as a separate pipeline step is a good boundary. It should
not live inside `image-service.js`: the image service should consume already-prepared
frame participants rather than performing literary analysis.

### 3. Position before visual prompts

Coreference must happen before `create_visual_prompts`; otherwise the visual prompt
author will continue receiving an incomplete participant list and will be forced to
solve the task without a stable contract.

### 4. Windowed processing

Working by windows is correct. Coreference should not analyze the entire book in a
single call. Moreover, a full expensive resolution across the entire analysis window
is not needed. The following should be explicitly separated:

- **Coarse pass over analysis window ~4000**: collect candidates, active characters,
  visible aliases/roles, nearby context;
- **Fine pass over generation span ~1500**: strictly annotate only those sentences
  and mentions that will actually appear in current scenes/units.

This saves tokens and reduces noise: the wide context is used for understanding
but is not directly turned into frame participants.

## What's Not Good

### 1. `scene.participants` as the main resolution output is too coarse

If all characters from `sentence_map` are simply collected into `scene.participants`,
every IU in the scene will receive passports for all scene characters. For a frame
where the text only has the saleswoman, Berlioz and Bezdomny may be injected
because they appear in adjacent sentences of the same scene.

This breaks the main IU principle: a frame should show only what is in the unit text.

Better approach:

- Resolution works at the sentence and mention span level;
- After `create_units`, each `unit` gets its own participant list by intersecting
  `unit.source_start/source_end` with resolved sentence spans;
- `scene.participants` becomes an aggregate for scene-level metadata but is not
  the main source of passports for each image;
- `buildCharacters()` should prefer `unit.participants`, using `scene.participants`
  only as a fallback.

### 2. `sentence_map` in JSON — unnecessary "padding"

Adding `sentence_map` to `chapters/*.json` is not worthwhile. It is a derived
index, not creative scene content.

Drawbacks of JSON storage:

- inflates book payload;
- complicates diff and scene hash;
- creates risk of desync with PG;
- mixes creative book state with analytical indexes;
- forces UI/API to carry data that is mainly needed by the backend pipeline.

Solution: store resolution only in PostgreSQL.

### 3. `safeAliasIndex` cannot be built from sentence words

The pseudocode `buildSafeAliasIndex(sentenceMap, text, characters)` is dangerous:
if a sentence contains two characters and the function extracted "significant words",
it has no way to know which word belongs to which character.

Example:

> "Продавщица ответила Берлиозу, а поэт нахмурился."

The sentence-level list would be:

```json
["booth_woman", "mikhail_aleksandrovich_berlioz", "ivan_nikolaevich_ponyrev"]
```

From this it is impossible to safely derive:

- "продавщица" → `booth_woman`
- "Берлиозу" → `mikhail_aleksandrovich_berlioz`
- "поэт" → `ivan_nikolaevich_ponyrev`

Mention-level data is needed.

### 4. Coreference per scene loses context

If resolution is run separately on `scene.text`, pronouns at the beginning of a
scene may lose their antecedent from the previous sentence/scene. This is especially
important if a scene starts as a continuation of action: "He turned around..." after
a previous scene where the subject was explicitly named.

However, a full precise resolution across all 4000 characters is also excessive:
a significant portion of the analysis window may not appear in the current generation
span. Better approach:

- On the **analysis window ~4000**: run coarse candidate collection;
- On the **generation span ~1500**: run fine mention-level resolution;
- In the fine prompt, pass only candidate characters from the coarse pass plus short
  surrounding context from the analysis window, not the entire `characters.json`;
- Preserve absolute source offsets and then distribute results across scenes and units.

### 5. No resolution versioning

Coreference depends on:

- source text and source offsets;
- current character list;
- prompt/schema version;
- model;
- unknown/generic alias rules.

If a character is renamed, merged with a duplicate, or the character registry changes,
old resolution rows may become invalid. A `resolver_version` and
`character_registry_hash` are needed.

## Recommended Architecture

### 1. DB-only storage

Do not add `sentence_map` to scene JSON.

Core tables:

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

For the alias index, a materialized/regular table can be added:

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

Recommended order:

1. `analyze_structure`
2. `analyze_characters`
3. `analyze_locations`
4. `collect_character_candidates` on analysis window ~4000
5. `create_scenes` from generation span ~1500
6. `resolve_character_mentions` on generation span ~1500, using candidates
   from step 4 and surrounding context from analysis window
7. `create_units`
8. `assign_unit_participants` from DB mentions + unit spans
9. `create_visual_prompts`

Steps 6 and 7 can be swapped if more convenient:

1. First create units;
2. Then fine mention resolution;
3. Then set `unit.participants`.

The critical point is not the order but the rule: visual prompts must see
unit-level participants, not only scene-level participants.

### 3. Analysis window vs generation span

Clear names must be introduced in code and documentation:

- `analysisWindowStart`
- `analysisWindowEnd`
- `generationSpanStart`
- `generationSpanEnd`

Coarse/fine split:

```text
analysis window:       [source_start ... source_start + ~4000]
coarse candidates:     possible_character_ids + aliases_seen + active_context

generation span:       [source_start ... source_start + ~1500]
created scenes:        contiguous prefix within generation span
fine resolution:       mention-level rows only within generation span
unit participants:     intersection of unit spans with fine resolved mentions
```

This way the resolver sees wide context, but expensive precise annotation is done
only for text that is actually being assembled right now. Coarse candidates cannot
be directly used as participants for scene/unit/image generation.

### 4. Coarse candidate pass

The coarse pass over 4000 should answer:

> Who is potentially active in this context, and what aliases/roles might appear
> in the nearest generation span?

Output should be small:

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

This result:

- is saved in `character_window_candidates`;
- narrows `%KNOWN_CHARACTERS%` for the fine resolver;
- does not directly enter `scene.participants`;
- does not inject passports.

### 5. Fine resolver output

The fine resolver receives generation span ~1500, candidate set from coarse pass,
and short surrounding context. It must return not only `characters: []` but mentions:

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

Alias index is built only from `character_mentions`, not from raw sentence words.

Safe alias criteria:

- mention type is `name`, `nickname`, `profession`, `title`, or stable description;
- not pronoun;
- not generic word;
- maps to exactly one character in the whole book;
- appears at least N times, or is manually approved, or comes from canonical character name;
- no collision after normalization.

Unsafe examples:

- "он"
- "она"
- "мужчина"
- "женщина"
- "человек"
- "люди"
- "поэт" (if the book has more than one poet)
- "редактор" (if there are multiple editors or role changes over time)

### 7. Image service contract

`image-service.js` must become a consumer, not a resolver.

Desired behavior:

1. `buildCharacters(scene, unit, chapter, book)`:
   - primary: `unit.participants`;
   - secondary: explicit `scene.participants`;
   - fallback: DB safe aliases / legacy prompt inference.
2. `inferCharactersFromPrompt()`:
   - keep as fallback;
   - do not treat as canonical;
   - log when fallback is triggered.
3. `normalizeCharacterRefs()`:
   - use safe aliases from DB;
   - do not replace generic/pronouns;
   - no fuzzy replacement without collision check.

## Recommended TODO Fixes

### P0 — Schema

Replace:

- "migration for `scenes` → field `sentence_map JSONB`"

With:

- `character_resolution_runs`
- `sentence_resolutions`
- `character_mentions`
- `character_aliases`
- add `resolve_characters` to `agent_steps.step_type`
- update purge/reconcile to delete resolution rows when scenes/book are deleted

### P1 — Prompt

Add to prompt:

- output mentions, not only character arrays;
- never return `"unknown"` as character id;
- include evidence for non-name mentions;
- pronouns are resolvable only inside local context;
- generic nouns require explicit nearby antecedent.

### P2 — Agent Service

Replace `stepResolveCharacters(sessionId, bookId, scene, characters)` with two steps:

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

And:

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

Save result to PG, not to scene JSON.

### P3 — Unit Participants

Add a separate step:

```js
assignUnitParticipants(bookId, chapterId, sceneId, units)
```

It reads `character_mentions` by source span and returns participants for each unit.

### P4 — Safe Alias Index

Build alias table from `character_mentions`, not directly from sentence text.
Tests needed for:

- two characters in one sentence;
- collision alias;
- generic word;
- pronoun;
- profession valid for only one character.

### P5 — Storage

Replace entirely:

- do not store `sentence_map` in `chapters/*.json`;
- do not store safe aliases in Redis as source of truth;
- store resolution and aliases in PostgreSQL;
- Redis may only be used as cache with TTL/version key.

### P6 — Tests

Add:

- coarse candidate pass validation;
- resolver output validation;
- unit participant assignment by source spans;
- alias collision across the whole book;
- stale resolution after character registry hash changes;
- scene deletion purges resolution rows;
- fallback image inference does not override DB participants.

### Token burn

If precise mention-level resolution is done across full 4000 characters, the cost
grows without benefit: not all of the analysis window will be used by the current
generation span. If resolution is done only over 1500 without wide context, pronoun
and role mention quality is lost.

Mitigation:

- 4000 → cheap coarse pass;
- 1500 → expensive fine pass;
- fine prompt receives only candidate characters, not the entire character registry.

## Risks

### False positives

Main risk. Mitigation:

- conservative prompt;
- unknown by default;
- mention-level confidence/evidence;
- collision-aware aliases;
- tests on ambiguous examples.

### Stale DB rows

If source text or character registry changed, old rows must be invalidated.
Mitigation:

- `source_hash`;
- `character_registry_hash`;
- `resolver_version`;
- cleanup by run;
- only latest completed run is active.

### Offset drift

If sentence splitter and source coverage compute offsets differently, unit
participants will be incorrect.

Mitigation:

- one deterministic splitter;
- absolute offsets;
- tests with dialogue punctuation, quotes, ellipsis, Cyrillic.

### Over-injection of scene participants

If the current scene-level approach is kept, visual prompts will receive extra passports.

Mitigation:

- primary source for image passports = `unit.participants`;
- scene-level participants only as fallback/metadata.

## Summary

This feature is needed and architecturally justified, but it should be built not
as `sentence_map` inside scene JSON but as a DB-backed coreference index.

Key decisions:

1. Separate **analysis window ~4000** and **generation span ~1500**.
2. Coarse candidate collection over 4000, fine mention resolution over 1500.
3. Store resolution only in PostgreSQL.
4. Move from sentence-level arrays to mention-level rows.
5. Set participants at the unit level.
6. Use safe aliases only as a verified fallback, not as the primary mechanism.

If implemented this way, `image-service.js` becomes simpler: it takes ready-made
participants and passports instead of trying to reconstruct meaning from text
using regex and fuzzy matching.
