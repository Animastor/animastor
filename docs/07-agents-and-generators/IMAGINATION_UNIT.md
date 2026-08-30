# Imagination Unit (iu) — the `image.prompt` doctrine

## What an Imagination Unit is

An **Imagination Unit (IU)** is *not* a chunk of book text. It is one **elementary act
of the reader's imagination** — the single concrete visual picture that forms in a
reader's head as they read a fragment.

The image prompt (`unit.image.prompt`) must therefore describe **the visual scene**,
not the text. It describes the picture the model should draw.

## Core philosophy — the unit is a VISUAL IMAGE

An Imagination Unit is the complete visual image a reader forms in their mind while
reading the unit text. It may depict characters, groups of people, landscapes,
architecture, interiors, objects, memories, dreams, imagined visions, symbolic scenes, or
any other visual moment suggested by the narrative.

Build the prompt around this complete image, preserving its atmosphere, composition, and
the important visual details of the text.

The rule, stated plainly:

- **When the unit has participants** → identify them by `character_id`, as concretely as
  possible (see below).
- **When the unit has no participants** → describe the visual image itself in full — its
  subject, setting, light, colour, texture, and mood.

The character rules that follow apply **only to units that actually contain people**. A
character-less frame (landscape, object, dream, symbol) is described on its own terms,
without padding it with generic people.

## The independence principle

The image-generation model receives **each request completely independently**. It knows
nothing about previous units, previous frames, or the story so far. Every request is, for
the model, the first request it has ever seen.

Consequence: **every `image.prompt` must be self-contained.** With zero context, the
prompt alone must be enough to draw the correct frame.

## The most important rule (when people are present) — never use pronouns or generic nouns

*This rule applies only to units that actually contain people.* The model does not know
who "they", "he", "she", "two men", "the writers", or "one person" are. To it, each is an unknown new person — so the next frame gets different
faces, poses, and framing. Generic collective nouns are just as destructive as pronouns.

- ✗ `They are sitting on a bench.`
- ✗ `two men are sitting on a bench`
- ✗ `the writers are talking`
- ✗ `one person turns around`
- ✓ `berlioz sitting on the left and bezdomny sitting on the right on a bench at patriarch_ponds`
- ✓ `berlioz looking at bezdomny`
- ✓ `bezdomny gesturing while speaking to berlioz`

Name **every** known character **every** time — even if the same characters appeared in
the previous unit.

## The guiding question

In each Imagination Unit, describe the **visible frame, not the plot**. When the frame
contains people, answer:

> **Who exactly is in the frame by `character_id`, and what exactly is each of them doing
> right now?**

For a character-less frame, answer instead: **what exactly does the viewer see, and in
what light and mood?**

The fewer vague words ("they", "people", "men", "the writers", "pedestrians", "crowd")
and the more concrete named participants and stable visual anchors, the more stable and
coherent the image sequence. Vague, generalizing words are the single biggest cause of
broken visual continuity between adjacent frames.

## The four parts of every prompt

1. **WHO** is in the frame — by name.
2. **WHERE** they are — the global location name.
3. **HOW** they are arranged relative to each other — sitting/standing, left/right,
   behind/in front.
4. **WHAT** changed in *this* unit — the new action, gesture, emotion, or lighting shift.

## Repeat the base composition

To make adjacent frames read as one continuous scene, repeat parts 1–3 and change only
part 4. With a fixed seed this keeps characters in the same places, poses, and framing.

```
Unit A: Berlioz and Ivan Bezdomny are sitting on a bench at Patriarch Ponds.
Unit B: Berlioz and Ivan Bezdomny are sitting on a bench at Patriarch Ponds. Calmly talking.
Unit C: Berlioz and Ivan Bezdomny are sitting on a bench at Patriarch Ponds. Ivan Bezdomny is gesturing while speaking.
```

Writing `They are talking.` or `They continue the conversation.` instead makes the model
build a completely new scene: different people, different poses (standing instead of
sitting), different composition — or different participants entirely.

## Globals: passports and locations by name

- **Characters** have global passports. Reference a character **by name only** — the
  appearance is pulled in automatically behind the name. Re-describe appearance **only**
  when it deviates from baseline: wounded, wet, changed clothes, dirty.
  - **Scene-level overrides** (`scene.passport[charId]`): if character in specific
    scene changed something from passport (clothes, details etc.), can override only
    these fields at scene level — e.g. `scene.passport.hero.clothes =
    "long grey coat"`. During generation `resolvePassport()` takes scene override
    with highest priority, remaining fields stay from global passport;
    cleared field (`'' → null`) falls back to global again. Same principle
    as locations (`locations.json` environment vs `scene.location.environment`).
- **Locations** are defined globally. Reference a location **by name only** (e.g.
  `Patriarch Ponds`). Re-describe the location **only** when its state changed: fog,
  rain, broken windows, fire.

## Extras / crowd

Secondary characters need no global passport, but describe each as a **concrete,
repeatable anchor** — not a vague mass. Avoid generalizing words like `crowd`,
`pedestrians`, `people walking in the park`.

- ✗ `people walking in the park` / `crowd` / `pedestrians`
- ✓ `an elderly man reading a newspaper near the path`
- ✓ `a young couple walking along the pond`
- ✓ `a woman feeding pigeons`
- ✓ `two children playing near the water`

When the same extras appear across **adjacent** Imagination Units, **repeat their
description verbatim**. This raises the chance the model keeps them visually continuous,
exactly as with the named participants' base composition.

## Character-less units — landscape, object, interior, memory, dream, symbol

When a unit has **no participants**, describe the image itself in full: subject, setting,
light, colour, texture, mood.

- ✓ `empty bench on a quiet path at patriarch_ponds, still water reflecting golden sunset, no people, calm surreal mood`
- ✓ `a worn leather manuscript on a dark table, warm candlelight, dust motes, symbolic literary atmosphere`
- ✓ `abstract symbolic image of time burning, dark void, glowing embers drifting, surreal cinematic`

The independence, self-containment, and location-by-name rules still apply — only the
character rules are dropped, because there are no characters to name.

## Where this lives in the code  - **Authoring instruction** — `SYSTEM_PROMPTS.visuals` in
  `backend/src/services/agent-prompts.js`. This is the meta-prompt that tells the LLM how
  to write each `image.prompt`. The doctrine above is encoded here.
  - Also `SYSTEM_PROMPTS.scenes` — requires `characters_present` (mandatory for each
    character), `location.id` (mandatory), `environment.epoch` + `environment.season`.
  - AI no longer writes `location` in `image.prompt` — only writes `character_id`.
    Location injected automatically in buildImagePrompt.
- **Context fed to the author** — `stepCreateVisuals` builds `%CONTEXT%`, passing each participant's
  name so the author can write part 3 (arrangement) and repeat it across units.
  `character_anchors` **removed** (July 2026) — positions written directly to prompt.
  Also passes `epoch` and `season` if present in `scene.location.environment`.
- **Assembler** — `buildImagePrompt()` / `buildCharacters()` in
  `backend/src/image/image-service.js` still auto-injects the character passports and
  location description behind the names. The doctrine's "name only" refers to what the
  *prompt author* writes; the assembler complements it by supplying the appearance the
  name stands for. Keep the two consistent when editing either side.
  - **New:** `resolveVisualStyle()` — fallback chain for visual style,
    with typographic style filtering (`soviet_book_page` only for cover/chapter_intro).
  - **New:** `inferCharactersFromPrompt()` — **sole method** for determining
    participants (since July 2026; `unit.participants` removed). Scans `image.prompt`
    for `character_id` and injects their passports.
  - **New:** `resolveLocationFromPrompt()` — if scene has no `location`,
    matches prompt text against `bible.locations` via Cyr→Lat transliteration
    and prefix matching (threshold 0.25).
  - **New:** support for `epoch`, `season`, `atmosphere` from environment.
- **Scene style fix** — `lazy-book/index.js` no longer sets `style: 'soviet_book_page'`
  on narrative scenes. This style remains only for typographic scenes
  (`cover`, `chapter_intro` with `typography` type units).
- **Fallback** — `getFallbackImage` in `agent-service.js` produces a pronoun-free,
  named, location-anchored prompt when the LLM step is unavailable.
