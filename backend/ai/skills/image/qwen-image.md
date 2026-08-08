# Qwen Image Prompting Skill

## Core Principle

Qwen Image (Qwen2.5-VL) is a dense, highly compositional model. It parses
every word of the prompt. Unlike diffusion models that respond well to
keyword-style prompts, Qwen benefits from:

- natural language descriptions
- clear spatial arrangement
- explicit character positioning
- well-structured composition

## Scope of this skill

This skill governs ONLY the `image.prompt` CORE — the sentence the agent
writes. The final prompt sent to the model is assembled programmatically by
the system (see "Division of labor" below), so the core must not try to be a
complete prompt on its own.

## Writing the core

Write ONE complete, natural sentence describing the frame, composition-first:

1. **Who is in frame** — exact character_ids with their relative position
   (left, right, center, foreground, background).
2. **What is happening in THIS unit** — the action, gesture, emotion, or
   momentary detail.
3. **Frame-specific light/setting** — only what is specific to THIS frame and
   grounded in the unit text (e.g. "golden sunset", "rain").

Keep it a fluent sentence in natural language — not comma-separated tags.

## Division of labor with the system (contract)

The system appends programmatically, in the order defined by the active image
profile: country, epoch, location, time, season, weather, mood, lighting,
atmosphere, shot type, visual style, character passports, and quality.

Do NOT include any of these in the core:

- Do not re-describe character appearance (passports are appended globally).
- Do not name the setting (city, street, park) — it is set by scene.location.id.
- Do not add shot phrasing ("wide shot", "close-up") — the shot field is appended.
- Do not repeat style or quality words.
- Do not restate time/season/weather — the environment block is appended.

## Good Practices

✓ Natural language sentences (not comma-separated tags)
✓ Clear left/right positioning for multi-character frames
✓ Frame-specific light or mood woven into the description where the unit text
  implies it
✓ Keep the core short — the wrapper adds the rest

## What to Avoid

✗ Extremely long comma-separated keyword lists
✗ Negative prompting in the main prompt (use the negative_prompt field)
✗ Very short prompts (< 5 words) — Qwen needs sufficient context
✗ Contradictory instructions
✗ Meta-commentary ("this is an image of", "we see", "depicted is")
✗ Duplicating system-supplied data: passports, location, time/season/weather,
  style, shot type, quality
