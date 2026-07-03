# Imagination Unit (iu) — the `visual.prompt` doctrine

## What an Imagination Unit is

An **Imagination Unit (IU)** is *not* a chunk of book text. It is one **elementary act
of the reader's imagination** — the single concrete visual picture that forms in a
reader's head as they read a fragment.

The image prompt (`unit.visual.prompt`) must therefore describe **the visual scene**,
not the text. It describes the picture the model should draw.

## Core philosophy — the system is built around the IMAGE, not the character

The unit is a **visual image**, not necessarily a character. We do not build the system
around heroes; we build it around the picture that forms in the reader's mind. Sometimes
that picture is made of characters — sometimes it is only the surrounding world, or even
a purely symbolic image. A unit may be:

- a landscape
- architecture
- an interior
- an object
- a memory
- a dream
- an imagined vision
- a symbolic or abstract image

The rule, stated plainly:

- **If participants are present** → name them as concretely as possible (see below).
- **If there are no participants** → do **not** invent any. Fully describe the visual
  image the viewer should see.

The character rules that follow apply **only to units that actually contain people**. A
character-less frame (landscape, object, dream, symbol) should never be padded with
generic people just to have someone in it.

## The independence principle

The image-generation model receives **each request completely independently**. It knows
nothing about previous units, previous frames, or the story so far. Every request is, for
the model, the first request it has ever seen.

Consequence: **every `visual.prompt` must be self-contained.** With zero context, the
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

In each Imagination Unit, do not answer *"what is happening?"*. Answer:

> **Who exactly is in the frame, where exactly is each participant, and what exactly is
> each of them doing right now?**

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

When a unit has **no participants**, do not add people. Describe the image itself in
full: subject, setting, light, colour, texture, mood.

- ✓ `empty bench on a quiet path at patriarch_ponds, still water reflecting golden sunset, no people, calm surreal mood`
- ✓ `a worn leather manuscript on a dark table, warm candlelight, dust motes, symbolic literary atmosphere`
- ✓ `abstract symbolic image of time burning, dark void, glowing embers drifting, surreal cinematic`

The independence, self-containment, and location-by-name rules still apply — only the
character rules are dropped, because there are no characters to name.

## Where this lives in the code

- **Authoring instruction** — `SYSTEM_PROMPTS.visuals` in
  `backend/src/services/agent-prompts.js`. This is the meta-prompt that tells the LLM how
  to write each `visual.prompt`. The doctrine above is encoded here.
- **Context fed to the author** — `stepCreateVisuals` in
  `backend/src/services/agent-service.js` builds `%CONTEXT%`, passing each participant's
  name and their `character_anchors` (position/pose/orientation) so the author can write
  part 3 (arrangement) and repeat it across units.
- **Assembler** — `buildImagePrompt()` / `buildCharacters()` in
  `backend/src/image/image-service.js` still auto-injects the character passports and
  location description behind the names. The doctrine's "name only" refers to what the
  *prompt author* writes; the assembler complements it by supplying the appearance the
  name stands for. Keep the two consistent when editing either side.
- **Fallback** — `getFallbackVisual` in `agent-service.js` produces a pronoun-free,
  named, location-anchored prompt when the LLM step is unavailable.
