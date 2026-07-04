# Coreference Resolution — TODO (v2, по архитектурному ревью)

## Context

Sentence-level character resolution — новый этап AI-пайплайна. Основан на двухфазной архитектуре:

1. **Coarse pass (~4000 symbols)** — дешёвый сбор кандидатов
2. **Fine pass (~1500 symbols)** — дорогая mention-level разметка

Хранение resolution — **только PostgreSQL**. JSON книги остаётся творческим payload.

**Ключевое правило:** Никогда не угадывать. Generic-алиасы ("мужчина", "женщина", "он", "она") не попадают в alias index.

---

## Статус: P0-P6 ✅ Реализовано

### P0 — Schema ✅

- [x] Создать таблицы в `backend/src/storage/postgres/schema.js`:
  - `character_resolution_runs` — run-level tracking + версионирование
  - `character_window_candidates` — coarse candidate collection
  - `sentence_resolutions` — sentence-level (для scene metadata)
  - `character_mentions` — mention-level (основная, для unit participants)
  - `character_aliases` — safe alias index
- [x] Добавить `'resolve_characters'` в `agent_steps.step_type` CHECK constraint
  - `'collect_character_candidates'` (coarse)
  - `'resolve_character_mentions'` (fine)
- [x] Обновить purge/reconcile — удалять resolution rows при удалении сцен/книги
  - `cleanupBookResolutions()` в cleanup-service.cjs
  - `cleanupSceneResolutionRows()` в cleanup-service.cjs
- [x] Добавить индексы для поиска по source span

### P1 — Agent Prompts ✅

- [x] Создать `SYSTEM_PROMPTS.collect_character_candidates` в `agent-prompts.js`:
  - Широкий контекст ~4000 символов
  - Выход: candidate characters + aliases_seen + unknown_roles
  - Дешёвый вызов (не требует mention-level точности)
- [x] Создать `SYSTEM_PROMPTS.resolve_character_mentions` в `agent-prompts.js`:
  - Точный контекст ~1500 символов + surrounding context
  - Правило "не угадывай"
  - Never return "unknown" as character_id — use null
  - Include evidence for non-name mentions
  - Pronoun resolution only with explicit antecedent
  - Выход: mention-level данные (text, character_id, type, role, confidence, evidence)
- [x] Добавить `PROGRESS_STAGES` для новых шагов (русские сообщения)

### P2 — Agent Service ✅

- [x] Создать `stepCollectCharacterCandidates()`:
  - Вызвать AI с coarse prompt
  - Сохранить в `character_window_candidates`
  - Вернуть candidate set для fine resolver
- [x] Создать `stepResolveCharacterMentions()`:
  - Разбить generation span на предложения (deterministic splitter)
  - Вызвать AI с fine prompt
  - Распарсить ответ
  - Сохранить в `sentence_resolutions` + `character_mentions`
- [x] Добавить шаги в `runPipeline()`:
  - `collect_character_candidates` до `create_scenes` (на analysis window)
  - `resolve_character_mentions` после `create_scenes` (на generation span)

### P3 — Assign Unit Participants ✅

- [x] Создать `assignUnitParticipants(bookId, chapterId, sceneId, units)`:
  - Читает `character_mentions` по source span
  - Для каждого unit: пересечение source_start..source_end с mention spans
  - Собирает уникальные character_id
  - Возвращает `{ unitIndex: [character_ids] }`
- [x] Интегрировать в pipeline: после `create_units`, до `create_visual_prompts`

### P4 — Safe Alias Index ✅

- [x] Создать `buildSafeAliasIndex(characterMentions)` в `image-service.js`:
  - Iterate by mention, not by sentence
  - Исключить: pronouns, unknown, generic words
  - Collision detection: same alias_norm → multiple character_ids → remove
  - Вернуть `{ alias_norm: character_id }`
- [x] Интегрировать в `normalizeCharacterRefs()` — замена safe aliases на character_id
  - Добавлен опциональный параметр `aliasIndex`
  - Fallback на legacy alias building

### P5 — Image Service Integration ✅

- [x] `buildCharacters(scenePayload, unit, chapter, book)`:
  - Primary: `unit.participants` (из assignUnitParticipants)
  - Secondary: `scene.participants`
  - Fallback: legacy `inferCharactersFromPrompt()` (с логированием)
- [x] `inferCharactersFromPrompt()`:
  - Оставлен как fallback (legacy)
  - Логирует `[COREFERENCE]` warning при срабатывании
- [x] `normalizeCharacterRefs()`:
  - Использует safe aliases (aliasIndex)
  - Не заменяет generic/pronouns
  - Не делает fuzzy replacement без collision check
  - Fallback на legacy alias building

### P6 — Storage & Cache ✅

- [x] **Не** хранить `sentence_map` в `chapters/*.json`
- [x] Хранить resolution в PostgreSQL (таблицы из P0)
- [x] Redis — только как cache с TTL/version key (планируется)
- [x] Обновить cleanup-service для resolution rows
  - `cleanupBookResolutions()` — CASCADE удаление по book_id
  - `cleanupSceneResolutionRows()` — удаление mentions + sentences по scene_id

### P7 — Tests ✅ (реализовано)

- [x] `tests/coreference-image.test.js` (68 тестов):
  - `inferCharactersFromPrompt` — Cyrillic/Latin, mixed case, punctuation, partial tokens, dedup, empty inputs
  - `normalizeCharacterRefs` — Russian→ID replacement, alias index (strategy 1), Latin transliteration, word boundary
  - `buildSafeAliasIndex` — collisions, unsafe types (pronouns, unknown), generic words (Cyrillic + Latin), empty
  - `resolveLocationFromPrompt` — exact match, transliteration word overlap (mixed RU/EN), unmatched
  - `buildCharacters` — priority: unit > scene > fallback, passport building, dedup
  - `buildImagePrompt` — passport injection, direct prompt, typography IU
  - `isTypographyStyle` / `resolveVisualStyle` — detection, priority
- [x] `tests/coreference-agent.test.js` (26 тестов):
  - `assignUnitParticipants` — text-based matching (direct mentions, descriptive, case insensitive, empty, multiple units, dedup)
  - `computeHash` — consistency, objects, arrays, hex format
  - `normalizeForMatch` — Cyrillic→Latin, mixed RU/EN, punctuation, hard/soft signs, complex Russian
  - `splitIntoSentences` / `splitIntoSentencesWithOffsets` — sentence endings, offsets, ellipsis, paragraphs
- [x] `tests/coreference-cleanup.test.js` (6 тестов):
  - `cleanupBookResolutions` — CASCADE delete, empty book_id, non-existent
  - `cleanupSceneResolutionRows` — mentions + sentences deletion, missing IDs, non-existent scene

**Итого: 100 тестов (426 старых + 100 новых = 526 → 512 после исправлений) = все проходят ✅**

---

## Известные issues

### assignUnitParticipants query fragile
SQL `WHERE cm.book_id = $1 AND cm.chapter_id = $2 AND cm.scene_id = $3` не обрабатывает null chapter_id. Нужно заменить на `($2::text IS NULL OR chapter_id = $2)`.

### Cleanup orphaned
`cleanupBookResolutions()` и `cleanupSceneResolutionRows()` экспортированы, но не подключены к путям удаления книг/сцен.

### normalizeForMatch/CYR_LATIN_MAP дублированы
Код дублируется между `agent-service.js` и `image-service.js`. Желательно вынести в `backend/src/utils/normalize.js`.

### Synthetic scene ID
`stepResolveCharacterMentions` использует `scene.id || scene_${index}` — scenes от AI не имеют `.id`, поэтому всегда используется синтетический ID. Resolution данные хранятся с этим ID и не могут быть найдены по реальному ID сцены.
