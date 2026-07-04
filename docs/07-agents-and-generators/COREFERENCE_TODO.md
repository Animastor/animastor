# Coreference Resolution — Упрощение (v3)

## История

- **v1 (original):** regex + fuzzy matching в image-service.js
- **v2 (coarse/fine):** двухфазный LLM-пайплайн + 5 PostgreSQL таблиц — ✅ реализовано, затем упрощено
- **v3 (current — LLM-driven):** LLM возвращает participants напрямую, backend только валидирует ID

## Текущая архитектура

LLM при создании юнитов (`stepCreateUnits`) возвращает `participants: [character_id]` для каждого unit'а.
assignUnitParticipants валидирует ID. Никаких БД-таблиц, regex, транслитерации, coarse/fine split.

**Pipeline:**
```
analyze_structure → analyze_characters → analyze_locations → create_scenes → create_units (+ participants) → assign_unit_participants (validation) → create_visual_prompts
```

**Что осталось от v2:**
- `assignUnitParticipants()` — упрощён до валидатора
- `applyScenePairParticipantFallback()` — fallback для "первый/второй/литераторы"
- `normalizeCharacterRefs()` в image-service.js — замена алиасов на ID
- `buildSafeAliasIndex()` в image-service.js — безопасный индекс алиасов
- `shouldInjectParticipantPassports()` — умный guard

## Статус тестов

### coreference-image.test.js (68 тестов) ✅
- `inferCharactersFromPrompt` — Cyrillic/Latin, mixed case, punctuation, partial tokens, dedup
- `normalizeCharacterRefs` — Russian→ID replacement, alias index, word boundary
- `buildSafeAliasIndex` — collisions, unsafe types, generic words
- `resolveLocationFromPrompt` — exact match, transliteration, unmatched
- `buildCharacters` — priority: unit > scene > fallback, passport building
- `buildImagePrompt` — passport injection, direct prompt, typography IU
- `isTypographyStyle` / `resolveVisualStyle` — detection, priority

### coreference-agent.test.js (35 тестов) ✅
- `assignUnitParticipants` — validation, dedup, unknown ID filter, empty, multiple units
- `getFallbackVisual` — unit-level participants, no over-injection
- `applyScenePairParticipantFallback` — group references, ordinal, no override, 2-person guard
- `shouldInjectParticipantPassports` — generic people, no-people guard
- `splitIntoSentences` / `splitIntoSentencesWithOffsets` — sentence boundaries, offsets, ellipsis
- `character identity merge` — merge short IDs, skip generic chars

**Удалены (v2 → v3):**
- computeHash (7 тестов)
- normalizeForMatch (12 тестов)
- matchMentionsToUnits (11 тестов)
- coreference-cleanup.test.js (6 тестов для БД-таблиц)

**Итого: 68 + 35 = 103 теста → 68 + ~30 = ~98 тестов (после упрощения)**

## Известные issues (minor)

### cleanup-service.cjs — legacy функции
`cleanupBookResolutions()` и `cleanupSceneResolutionRows()` остались в cleanup-service.cjs.
Не вызываются ниоткуда. Можно оставить для очистки legacy данных из БД, если они есть.

### normalizeForMatch дублирован в image-service.js
normalizeForMatch + CYR_LATIN_MAP — только в image-service.js теперь (не дублируется).
Желательно вынести в `backend/src/utils/normalize.js` для переиспользования.
