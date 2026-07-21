# Qwen Image Prompting Skill

## Core Principle

Qwen Image (Qwen2.5-VL) is a dense, highly compositional model. It parses
every word of the prompt. Unlike diffusion models that respond well to
keyword-style prompts, Qwen benefits from:

- natural language descriptions
- clear spatial arrangement
- explicit character positioning
- well-structured composition

## Prompt Structure

Write a complete, natural sentence describing the frame.

### Composition-first ordering:

1. **Subject & position** — who is in frame, where are they
2. **Background & environment** — what surrounds them
3. **Lighting & color** — light quality, palette
4. **Mood & atmosphere** — emotional tone
5. **Style** — visual style (cinematic, illustration, etc.)
6. **Shot type** — wide, medium, close-up

### Example:

"mikhail_berlioz and ivan_ponyrev sitting on a park bench at sunset, warm golden
light, calm intellectual atmosphere, cinematic medium shot"

## Character References

- Use EXACT character_ids from the character list
- Be specific about where each character is (left, right, center, foreground, background)
- Characters should be described in natural language within the sentence

## Good Practices

✓ Natural language sentences (not comma-separated tags)
✓ Clear left/right positioning for multi-character frames
✓ Specific lighting description (golden hour, candlelight, overcast)
✓ Mood words integrated into the description

## What to Avoid

✗ Extremely long comma-separated keyword lists
✗ Negative prompting in the main prompt (use negative_prompt field)
✗ Very short prompts (< 5 words) — Qwen needs sufficient context
✗ Contradictory style instructions
✗ Meta-commentary ("this is an image of", "we see", "depicted is")
