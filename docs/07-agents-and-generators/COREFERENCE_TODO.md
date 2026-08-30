# Coreference Resolution — Simplification (v3)

## History

- **v1 (original):** regex + fuzzy matching in image-service.js
- **v2 (coarse/fine):** two-phase LLM pipeline + 5 PostgreSQL tables — ✅ implemented, then simplified
- **v3 (current — LLM-driven):** LLM returns participants directly, backend only validates IDs

## Current Architecture

LLM during unit creation (`stepCreateUnits`) returns `participants: [character_id]` for each unit.
`assignUnitParticipants` validates IDs. No database tables, regex, transliteration, or coarse/fine split.

**Pipeline:**
```
analyze_structure → analyze_characters → analyze_locations → create_scenes → create_units (+ participants) → assign_unit_participants (validation) → create_visual_prompts
```

**What remains from v2:**
- `assignUnitParticipants()` — simplified to a validator
- `applyScenePairParticipantFallback()` — fallback for "first/second/writers"
- `normalizeCharacterRefs()` in image-service.js — alias-to-ID replacement
- `buildSafeAliasIndex()` in image-service.js — safe alias index
- `shouldInjectParticipantPassports()` — smart guard

## Test Status

### coreference-image.test.js (68 tests) ✅
- `inferCharactersFromPrompt` — Cyrillic/Latin, mixed case, punctuation, partial tokens, dedup
- `normalizeCharacterRefs` — Russian→ID replacement, alias index, word boundary
- `buildSafeAliasIndex` — collisions, unsafe types, generic words
- `resolveLocationFromPrompt` — exact match, transliteration, unmatched
- `buildCharacters` — priority: unit > scene > fallback, passport building
- `buildImagePrompt` — passport injection, direct prompt, typography IU
- `isTypographyStyle` / `resolveVisualStyle` — detection, priority

### coreference-agent.test.js (35 tests) ✅
- `assignUnitParticipants` — validation, dedup, unknown ID filter, empty, multiple units
- `getFallbackVisual` — unit-level participants, no over-injection
- `applyScenePairParticipantFallback` — group references, ordinal, no override, 2-person guard
- `shouldInjectParticipantPassports` — generic people, no-people guard
- `splitIntoSentences` / `splitIntoSentencesWithOffsets` — sentence boundaries, offsets, ellipsis
- `character identity merge` — merge short IDs, skip generic chars

**Removed (v2 → v3):**
- computeHash (7 tests)
- normalizeForMatch (12 tests)
- matchMentionsToUnits (11 tests)
- coreference-cleanup.test.js (6 tests for DB tables)

**Total: 68 + 35 = 103 tests → 68 + ~30 = ~98 tests (after simplification)**

## Known Issues (minor)

### cleanup-service.cjs — legacy functions
`cleanupBookResolutions()` and `cleanupSceneResolutionRows()` remain in cleanup-service.cjs.
Not called from anywhere. Can be left for cleaning up legacy data from the database if present.

### normalizeForMatch duplicated in image-service.js
normalizeForMatch + CYR_LATIN_MAP — now only in image-service.js (no longer duplicated).
Ideally move to `backend/src/utils/normalize.js` for reuse.
