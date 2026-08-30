# Dialogue TTS Pipeline

## Purpose

Automatic multi-voice dialogue voicing generation via TTS.
Dialogue scenes receive `voice='dialogue'` and route to multi-voice Qwen3-TTS workflow.

## Pipeline (actual order)

```
AI Pipeline (runPipeline):
1. stepAnalyzeStructure          — structure (bootstrap)
2. stepExtractCharacters         — characters without voice (single responsibility)
3. stepGenerateVoices            — voices for dialogue characters
   ↑ LLM just extracted characters — context fresh, full text in memory
4. stepExtractLocations          — locations
5. stepCreateScenes             — scenes (title + location.id + environment-override)
6. stepCreateUnits               — units with speaker: { type: "dialogue", speaker: "berlioz", text: "..." }
7. stepCreateVisuals             — visual prompts
8. stepReconcilePassports        — prompt cleanup
9. stepPolishStoryboard          — continuity

         ↓
create.js (save to JSON):
  narration scene →  voice='narrator',  full_text=literary text
  dialogue scene  →  voice='dialogue', full_text=literary text (with "—")
  (speaker:text script NOT saved, built at generation time)

         ↓
generateSceneAudio() → buildSegments():
  dialogue:  assembles units[].speaker + units[].text into script, chunks
  narration: takes audio.full_text, chunks by sentences

         ↓
ComfyUI / GPU Hub:
  dialogue  → tts-qwen-dialogue (Role Bank: character1 + character2)
  narration → tts-qwen-narrator (single voice)
```

## Key architectural decisions

### `audio.full_text` = literary text, not script
- `full_text` stores original text with "—" (human-readable)
- `speaker: text` script built **only in `buildSegments()`** from `units[].speaker`
- Single source of truth: `units[]`, not duplication in `full_text`
- Editing units → script rebuilds automatically

### `stepGenerateVoices` — step #3 (after characters, before scenes)
- LLM just extracted characters — context fresh
- Full text not yet split into scenes — best analysis of dialogue lines
- Created voices then available to all downstream steps

### Narrator — programmatic, not AI
- Added in `create.js` always first:
  ```js
  const voices = { narrator: { instruction: narratorVoice } };
  ```
- No AI prompt creates narrator

### `buildSegments()` — hybrid + embedded narration + fallback
- Builds TTS script from `units[].speaker`
- **Hybrid scenes:** dialogue branch of `buildSegments()` iterates over ALL units:
  - `dialogue` units → `segment_type: "dialogue"` (character voice)
  - `narration/perception/description/action/transition/performance` → `segment_type: "narration"` (narrator voice)
  - `typography` → skip
  - Segment order = unit order in scene

- **Hybrid dialogue units (embedded narration):** If AI created ONE `dialogue` unit where `unit.text` contains not only dialogue but also author attribution (Pattern A: "— Dialogue, — said he." or Pattern B: "He said: — Dialogue."), `extractNarrationFromDialogueUnit()` extracts narration and creates TWO segments:

  | Pattern | Order | Example |
  |---------|-------|---------|
  | A (post) | `[dialogue] → [narration]` | "— No narzan, — replied the woman." → character, then narrator |
  | B (pre) | `[narration] → [dialogue]` | "The woman replied: — No narzan." → narrator, then character |
  | Both | `[narration] → [dialogue] → [narration]` | "He approached: — Hello, — said he." |

  Punctuation (commas, dashes) preserved — it carries prosodic information and affects timing calculations.

- **Fallback (word-boundary guard):** If `audio.text` matches inside another word (substring collision, e.g., "да" inside "дала"), or `indexOf` doesn't find match (AI inconsistency), or `audio.text` consists only of opener characters — `extractNarrationFromDialogueUnit()` returns `null`. Entire `unit.text` goes to narrator (narration segment). Safer than character saying wrong text.

- **Multilingual:** Opener marker normalization (`—`, `"`, `«`, `„`, `'`) covers 🇷🇺 Russian, 🇬🇧 English, 🇫🇷 French, 🇩🇪 German, 🇪🇸 Spanish and others.

- Short narration texts (< 40 characters) padded (duplicated for minimum TTS duration)
- If scene has no valid units → `[]` (warning logged)

## Status

- [x] `speaker` added to `SYSTEM_PROMPTS.units`
- [x] `stepCreateUnits()` saves `speaker` from AI
- [x] `create.js` — literary `full_text`, `voice='dialogue'`
- [x] `buildSegments()` — hybrid: narration + dialogue units in same scene
- [x] `stepGenerateVoices` — at position 3 (after characters)
- [x] Examples (`ai/examples/`) aligned
- [x] `extractNarrationFromDialogueUnit()` — embedded narration from dialogue unit (Pattern A + B)
- [x] Word-boundary guard + fallback (crooked unit.text → narrator)
- [x] `{pre, post}` — correct segment order for pre/post patterns
- [x] Punctuation preserved (prosody + timing)
- [x] Multilingual opener marker normalization
- [x] 473 tests passing
