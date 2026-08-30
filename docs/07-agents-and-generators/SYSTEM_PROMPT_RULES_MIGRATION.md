# Migration: Hardcoded SYSTEM_PROMPTS → `ai/rules/`

## Goal

Move all 12 universal system prompts from `backend/src/services/agent-prompts.js`
into separate `.md` files in `backend/ai/rules/` so that:

- Edit prompts without modifying JS code
- Each prompt — separate file, independently version-controlled
- Single source of truth for agent instructions
- Model-dependent rules already separated (skills/)

## Status

**✅ Migration completed.**

`agent-prompts.js` loads all 12 prompts from `backend/ai/rules/*.md` via `ai-loader.js`.
Placeholders replaced via `.replace()` in `pipeline-steps.js`.

## Structure

```
backend/ai/rules/
├── structure.md                 # Structure analysis (author, title, chapters)
├── characters.md                # Character extraction
├── locations.md                 # Location extraction
├── scenes.md                    # Text split into scenes + environment-override
├── units.md                     # Scene decomposition into units
├── visuals.md                   # Visual prompt creation (image.prompt + video.action)
├── storyboard_polish.md         # Storyboard polishing (continuity, 180° rule)
├── voice_generation.md          # Character voice generation
├── passport_reconciliation.md   # image.prompt vs passport verification
├── video_action_reconciliation.md # video.action correction (temporal only)
├── video_action_polish.md       # video.action polishing (gesture continuity + timing realism)
```

> 8 old `-*.md` files (dead code) removed.

## What changed in .md vs original JS

### 1. JS expressions → placeholders

In `scenes.md` replaced:

| JS expression | Placeholder |
|---|---|
| `${SCENE_MAX_SEC}` | `%SCENE_MAX_SEC%` |
| `${SCENE_TARGET_SEC}` | `%SCENE_TARGET_SEC%` |
| `${SCENE_MIN_SEC}` | `%SCENE_MIN_SEC%` |
| `${Math.round(SCENE_MAX_SEC / 0.3)}` | `%SCENE_MAX_WORDS%` |
| `${Math.round(SCENE_TARGET_SEC / 0.3)}` | `%SCENE_TARGET_WORDS%` |
| `${Math.round(SCENE_MIN_SEC / 0.3)}` | `%SCENE_MIN_WORDS%` |
| `%MAX_SCENES%` (already existed) | `%MAX_SCENES%` |

During JS migration need to add `.replace()` for new placeholders.

### 2. Model-dependent "moles" removed

| File | Removed |
|---|---|
| `characters.md` | "IMPORTANT CRITICAL — appearance MUST be written in ENGLISH because it is used as input for an English-only video generation model (LTX 2.3)" |
| `voice_generation.md` | "Voice descriptions must be in ENGLISH (they feed into an English-only TTS model)" |

These rules should live in corresponding skills:
- `skills/image/qwen-image.md` — which language to write prompts in
- `skills/audio/qwen-tts.md` — which language to write voice instructions in

### 3. video_action_reconciliation and video_action_polish

Already cleaned during Prompt Profiles refactoring. .md files received final versions
(without LTX-specific examples, camera vocabulary, motion vocabulary — all in
`skills/video/ltx-2.3.md`).

## Completed steps

### ✅ Step 1: agent-prompts.js → loader
`agent-prompts.js` rewritten: configuration (constants) stays inline, 12 SYSTEM_PROMPTS loaded from `.md` via `ai-loader.js`.

### ✅ Step 2: Placeholders → .replace()
In `pipeline-steps.js` added 6 `.replace()` for new scene duration placeholders (`%SCENE_MAX_SEC%`, `%SCENE_TARGET_SEC%`, `%SCENE_MIN_SEC%`, `%SCENE_MAX_WORDS%`, `%SCENE_TARGET_WORDS%`, `%SCENE_MIN_WORDS%`).

### ✅ Step 3: Audit .replace() in callers
All placeholders in all 12 .md files have corresponding `.replace()` in JS:

| Placeholder | Where replaced | File |
|---|---|---|
| `%EXISTING_CHARACTERS%` | stepExtractLocations, stepCreateScenes | pipeline-steps.js |
| `%EXISTING_LOCATIONS%` | stepCreateScenes | pipeline-steps.js |
| `%BOOK_DEFAULT%` | stepCreateScenes | pipeline-steps.js |
| `%MAX_SCENES%` | stepCreateScenes | pipeline-steps.js |
| `%REFERENCE_EXAMPLES%` | stepCreateScenes | pipeline-steps.js |
| `%SCENE_TEXT%` | stepCreateUnits | pipeline-steps.js |
| `%CONTEXT%` | stepCreateVisuals | pipeline-steps.js |
| `%EXAMPLES%` | stepCreateVisuals | pipeline-steps.js |
| `%UNITS%` | stepCreateVisuals, passport, video steps | pipeline-steps.js |
| `%CHARACTERS%` | stepPolishStoryboard, stepPolishVideoActions | pipeline-steps.js |
| `%LOCATIONS%` | stepPolishStoryboard, stepPolishVideoActions | pipeline-steps.js |
| `%SCENES%` | stepPolishStoryboard, stepPolishVideoActions | pipeline-steps.js |
| `%SCENE_MAX_SEC%` | stepCreateScenes | pipeline-steps.js |
| `%SCENE_TARGET_SEC%` | stepCreateScenes | pipeline-steps.js |
