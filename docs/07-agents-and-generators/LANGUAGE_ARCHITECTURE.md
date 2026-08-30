# Language Architecture in the Project

> **Status:** accepted as project architectural rule (RFC).
> **Scope:** all modules working with book data and generation (agent, generators, editor, chat).

## 1. Rule: data language for generation

Single rule across entire project:

> **All data used as input for AI models is stored in English, even if these fields are displayed in the editor to the user.**
>
> **Only data intended exclusively for user display and not used in generation is localized.**
>
> **The `language` parameter (from `book.json`) affects ONLY user-facing fields.**

User sees AI-facing fields in English — this is a **deliberate trade-off for generation quality** (LTX 2.3 — English-only video model, Qwen TTS/Image more stable on English instructions). If needed, user translates text via any translator or built-in AI chat.

## 2. Field categories

### Category A — Content (never translated)

Verbatim source material, language of the work by definition:

- `scene.text`, `unit.text`, `audio.full_text` (TTS text — in book language!)
- source text (`source.txt` / `draft.sourceText`)

This is the book text itself. Cannot be translated, rewritten or "localized" — only used as-is.

### Category B — User-facing (localized by `language`)

Only fields **not used in generation**:

- `scene.title` (scene name)
- `character.name`, `location.name` (including "in original language" from rules — already localization)
- UI elements and labels
- other user descriptions not entering prompts

These fields enter prompts only as **context** (e.g., `Title: ${scene.title}` in `stepCreateVisuals`) — safe: localized context models understand in any language.

### Category C — AI-facing (always English, regardless of `language`)

All fields entering model prompts:

- system instructions (`ai/rules/*.md` prompts)
- `image.prompt`, `video.action`
- TTS instructions and descriptions (voice instruction) — with "Native <Lang> pronunciation" marker
- character passports (`passport.*`: `appearance`, `clothes`, `video_tokens`)
- location descriptions (`locations.json`) and `environment.*` values (`time`, `season`, `lighting`, `weather`, `mood`, `atmosphere`)
- any other fields entering model prompts

### Never translated

- identifiers: `character_id`, `location_id`, `scene_id`
- JSON key names
- snake_case values
- service technical fields

## 3. Exception: TTS

The **voicing text** (`audio.full_text`) is category A, in book language (`language=ru, en, de...`). The **voice instruction** (category C) is always English, but contains "Native <Lang> pronunciation" marker per book language.

Dual-channel model already implemented in code:
- `create.js:505-521` — `audio.full_text` separate from `scene.text`;
- `entity-schema.js:269` — `language` field in TTS workflow;
- `voice_generation.md` — English instruction + `TTS output language: %LANGUAGE%` line for "Native <Lang> pronunciation" marker.

## 4. Mechanism: `%LANGUAGE%` placeholder in rules

Prompts remain unified and language-independent — **no separate example directories per language** (KISS). Language substituted directly into `ai/rules/*.md` files via `%LANGUAGE%` placeholder, placed **pointwise — near user-facing fields**:

```
"name": "Location Name (in %LANGUAGE%)"
```

At prompt build stage, placeholder replaced with concrete value — e.g.
`"name": "Location Name (in German (de))"`. Modern LLMs (Qwen) understand such
instructions well; translations of examples not needed — examples demonstrate form, not language.
GPU fields (appearance, environment) don't get placeholder — have explicit English mandate.

### How placeholder is distributed across rules (pointwise, not global)

`%LANGUAGE%` placeholder is placed **pointwise — near specific user-facing fields**,
not as a single line for entire file. GPU fields within same files stay English and receive
explicit mandate (per `characters.md` pattern):

- **UI-facing rules** (`structure`, `characters`, `locations`, `scenes`) —
  `%LANGUAGE%` only on fields user sees:
  - `structure.md`: `author`, `title`, part and chapter names;
  - `characters.md`: `name`, `description`, `traits` (but `appearance` — `MUST be ENGLISH`);
  - `locations.md`: `name` (but `description` and `environment.*` — `MUST be ENGLISH`;
    `description` injected into image/video prompts, so also category C);
  - `scenes.md`: `title` (but `text` — verbatim, not translated; `environment` overrides — `MUST be ENGLISH`).
- **GPU-facing rules** (`visuals`, `storyboard_polish`, `video_action_reconciliation`,
  `video_action_polish`, `passport_reconciliation`) — their output (`image.prompt`,
  `video.action`, passports) feeds generative models: fixed string
  `Result language: English (en)` — no placeholder.
- **`voice_generation.md`** — dual-channel TTS: voice instruction stays English
  (`Result language: English (en)`), `TTS output language: %LANGUAGE%` line
  substitutes book language for "Native <Lang> pronunciation" marker.

### How implemented in pipeline

- **`resolveBookLanguage(draft)`** (`agent-prompts.js`) — resolves book language:
  `draft.book.language || detectLanguage(sourceText) || 'en'` (no hidden `defaults.language`
  and no old `'ru'` default).
- **`buildLangInstruction(lang)`** (`agent-prompts.js`) — returns **value** for
  placeholder, e.g., `Russian (ru)`.
- **`fillLang(template, lang)`** (`agent-prompts.js`) — replaces **all** occurrences
  of `%LANGUAGE%` in template (split/join, not `.replace` — which replaces only first,
  and `characters.md` contains placeholder 4 times, `locations.md` — 2).
- **`pipeline-steps.js`** — text steps build system prompt via `fillLang(...)`.
  If rules don't contain placeholder (GPU steps) — substitution safely changes nothing.
- **Pass-through:** `bootstrap.js` (has `draft`) → `runPipeline(options.language)` →
  `pipeline-steps.js` steps.

Visual steps don't receive language parameter — their output (`image.prompt`, `video.action`)
is always English, and their rules already have `Result language: English (en)` fixed.

### Rules in `ai/rules/*.md` already follow categories

- `characters.md`: `appearance`/`clothes`/`video_tokens` MUST be ENGLISH (for LTX 2.3) —
  mandate duplicated **inline** in each field description (not only at file end), so
  agent doesn't "infect" from neighboring user-facing fields (`name`/`description`/`traits` —
  in original language).
- `voice_generation.md`: voice instruction — ENGLISH + "Native <Lang> pronunciation".
- `locations.md`: `name` — in original language; `description` and `environment` values — English.
- `scenes.md`: title examples — form examples (2-6 words), not language;
  language set by `%LANGUAGE%` placeholder on `title` field (but `text`/`environment` — verbatim/English).

## 5. Multilingual books (future)

Instead of hard-binding to original language, uses **global `language` variable**:

- original book — Russian;
- `language = de` → output book, scenes and voicing created in German;
- `language = en` → everything created in English;
- book source text remains unchanged and stored as original (category A).

### Complexity assessment: low-medium, no architectural obstacles

Pipeline is mechanically language-agnostic — windowing, coverage, units, visuals work with any text.
Translation is a question of *where* to insert translation:

**Strategy A — translate before split (recommended):** translate text window at start of `runPipeline`,
all subsequent steps work as usual. Zero changes to coverage/units/visuals.
⚠️ Only caveat: `getWindowText` calculates offsets in **original** text,
and translation changes length → translate window by original offsets, check coverage against
translated window, take next offset from original consumed.

**Strategy B — translate after split:** scenes from original (coverage intact), then
`audio.full_text` = translation, titles translated. Original untouched (`scene.text`).
⚠️ Two languages in one scene object, visuals built from original, voicing from translation.

**Cost:** additional LLM pass ≈ +30–50% import time/tokens + supporting
character name consistency across windows.

**Foundation already laid:** `language` passthrough (section 4) — this is the single point needed
for either strategy. The translation itself is a separate feature (new step + `ai/rules/translate.md`),
implemented later when practice shows need.

### How source language is determined (`book.json.language`)

`book.json.language` is **source text** language. Determined
**programmatically** at import stage (`TXT → language detection → book.json → pipeline`),
immediately after file read and BEFORE scene/agent generation starts:

1. If `book.json.language` already explicitly set — not auto-overwritten.
2. If empty — detection runs on source TXT (`services/language-detector.js`, library
   **tinyld**: pure JS, no LLM, ISO 639-1 codes, 62 languages; Ukrainian/Bulgarian no longer
   confused with Russian, as in old "Cyrillic = ru" heuristic).
3. If detector confident — code written to `book.json` (and `defaults.language`).
4. If detector couldn't determine (empty/too short/low confidence) — `'en'`.

Old `'ru'` default removed throughout backend (draft, pipeline-runner, Postgres, prompts).
For books imported before this scheme, empty `language` lazily backfilled on draft load
from source material; explicitly set values untouched.

Future "source language / output (generation) language" split (book translation) —
separate architectural task; current decision doesn't block it, since `language`
is interpreted exactly as source language.

## 6. Convention for new modules

1. New field entering model prompts → **English** (category C) + explicit mandate in rule.
2. New field only for user display → **localized** by `language` (category B),
   `%LANGUAGE%` placeholder placed pointwise near this field.
3. New AI step generating user text → places `%LANGUAGE%` on user-facing fields
   in its `.md` and replaces placeholder via `fillLang(template, lang)` (all occurrences).
   If rule has GPU fields (category C), their EN mandate duplicated **inline**
   in field description (per `characters.md` pattern).
4. Visual/audio AI step → in `.md` fixed string `Result language: English (en)`,
   doesn't receive language parameter.
5. New languages added **without code changes** — model needs to know the language
   (language map in `langName` expanded as needed).

## 7. Future: AI translation of editor fields (architectural idea, low priority)

**Status:** future idea, not high-priority task. Separate translation service NOT needed —
uses existing project AI agent.

**Problem it solves:** users without English see AI-facing fields
(character passports, location descriptions, environment) in English (see trade-off in section 1).

**Idea:** small button next to such fields (e.g., SVG icon 🌐).

On press, **no automatic translation is performed and nothing is saved**:

1. AI agent called with current field content + target language
   (interface language or book language).
2. Agent returns translation.
3. Translation displayed in popup or separate panel — **view only**.

### Invariants

- original English text **not modified**;
- translation **not saved anywhere** and **doesn't participate in generation**;
- all AI models continue working only with English original (category C);
- single data source remains English.

### Why this is good

- editor becomes usable for users without English;
- language architecture (sections 1–3) unchanged — translation lives outside data;
- no separate translation service needed: AI agent already part of system;
- potentially implementable on both backend (agent endpoint) and frontend (chat call).
