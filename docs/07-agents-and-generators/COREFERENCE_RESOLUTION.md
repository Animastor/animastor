# Coreference Resolution — Simplification History

> **Current status (July 2026):** Coreference step removed from pipeline.
> `coreference.js` — stub. `unit.participants` removed.
> Sole mechanism: `inferCharactersFromPrompt()` scans `visual.prompt`
> for `character_id` and injects passports.
> Document preserved for refactoring history.

## Problem Statement

AI agent generating visual prompts sometimes uses natural language phrases
instead of `character_id` for character descriptions:

- *"The saleswoman poured them soda"* instead of `booth_woman`
- *"The editor turned around"* instead of `berlioz`
- *"The poet thought"* instead of `bezdomny`

## Solution: LLM determines participants itself

**Current architecture (since July 2026):**

```
Step 0: analyze_structure             — book metadata
Step 1: analyze_characters            — characters
Step 2: analyze_locations             — locations
Step 3: create_scenes                 — scenes (title + location.id + environment-override)
Step 4: create_units                  — IU (without participants — removed)
Step 5: create_visual_prompts        — inferCharactersFromPrompt
```

`unit.participants` removed from entire system. Instead `inferCharactersFromPrompt()`
scans `visual.prompt` for `character_id` and injects passports. `coreference.js` — stub.

### How it works (current version)

1. **`stepCreateVisuals()`** — AI writes `visual.prompt` with character_id (not names)
2. **`inferCharactersFromPrompt()`** — scans `visual.prompt` for `character_id` via regex
3. **`normalizeCharacterRefs()`** — replaces names with IDs in visual prompt
4. **`buildCharacters()`** — injects passports for found character_id

## Core Principle: Don't guess

**Hard rule:** if character identification isn't obvious from context — don't bind to random character.

## Integration with image-service.js

`image-service.js` — **consumer**:

```javascript
// In buildCharacters:
// 1. inferCharactersFromPrompt() — scans visual.prompt for character_id
// 2. normalizeCharacterRefs() — replaces aliases with IDs
```

## Simplification history

Initially a two-phase architecture (coarse + fine pass) was implemented with resolution stored in 5 PostgreSQL tables. After analysis, simplification was decided:

- **Removed (June 2026):** stepCollectCharacterCandidates, stepResolveCharacterMentions,
  matchMentionsToUnits, DB tables, PROGRESS_STAGES for coreference
- **Removed (July 2026):** unit.participants, assignUnitParticipants, coreference step,
  shouldInjectParticipantPassports, applyScenePairParticipantFallback, character_anchors
- **Kept:** normalizeCharacterRefs, buildSafeAliasIndex, isSafeCharacterAlias,
  inferCharactersFromPrompt
