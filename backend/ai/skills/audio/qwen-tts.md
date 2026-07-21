# Qwen TTS Prompting Skill

## Core Principle

Qwen TTS uses a reference audio sample to capture voice characteristics
(timbre, pitch, cadence). The text input should be:

- clean, well-punctuated text
- properly formatted for natural speech rhythm
- free of phonetic annotations (the model handles pronunciation)

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

## What to Avoid

✗ Phonetic spellings or pronunciation guides
✗ Excessive punctuation (!!!, ???, ... repeated)
✗ Very long sentences (>50 words without punctuation)
✗ ALL CAPS for emphasis (use narrative description instead)
✗ Special characters or markup in the text
