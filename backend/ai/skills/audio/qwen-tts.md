# Qwen TTS Prompting Skill

## Core Principle

Qwen3-TTS builds voices from two inputs: a **voice_instruction** (natural-language
description) and, optionally, a reference audio sample that captures timbre and
cadence. The text input should be:

- clean, well-punctuated text
- properly formatted for natural speech rhythm
- free of phonetic annotations (the model handles pronunciation)

## Voice Instruction Authoring

The `voice_instruction` field (Qwen3TTSVoiceDesign) is the natural-language
description the model turns into a voice. Write 1–3 sentences covering:

- timbre and register (deep, warm, bright, raspy, breathy)
- pitch and volume (low/mid/high, loud/soft)
- pace and rhythm (slow and deliberate, clipped, unhurried)
- tone and emotional quality (calm authority, nervous, mocking, gentle)
- accent and pronunciation — always end with "Native <Lang> pronunciation"

Keep voices DISTINCT per character. Ground them in the character's age, build,
temperament, and any explicit speech description in the source text. Avoid
generic phrases like "a character voice", "natural intonation", or "matching the
character" — they produce flat, indistinguishable synthesis.

## Narration

For narrator/omniscient passages:

- Use standard punctuation (. , ! ? —)
- Paragraph breaks should reflect natural pause points
- Keep sentences at natural speaking length (15–30 words)
- The model will auto-determine pace from punctuation and content

## Dialogue

For character dialogue:

- Each speech turn is a separate unit
- The speaker is identified by character_id mapping in the unit's audio metadata
- Include any parenthetical delivery cues in the narrative text only
  (e.g. "he whispered" → keep in scene text, not in the dialogue audio text)

## Good Practices

✓ Clean text with correct punctuation
✓ Appropriate paragraph breaks for natural pausing
✓ Short to medium sentences (15–30 words)
✓ Proper noun capitalization (Qwen respects casing for emphasis)
✓ Concrete, distinct voice instructions per speaker

## What to Avoid

✗ Phonetic spellings or pronunciation guides
✗ Excessive punctuation (!!!, ???, ... repeated)
✗ Very long sentences (>50 words without punctuation)
✗ ALL CAPS for emphasis (use narrative description instead)
✗ Special characters or markup in the text
✗ Generic voice phrases in voice instructions
