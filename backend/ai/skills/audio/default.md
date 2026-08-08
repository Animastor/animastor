# Audio / TTS Prompting Skill (default)

> Generic TTS prompting baseline, used when no model-specific audio profile is
> selected. Covers the two things an author/agent controls for TTS: the VOICE
> INSTRUCTION (the natural-language description of the desired voice) and the
> TTS INPUT TEXT hygiene.

## Voice Instruction

The TTS model synthesizes a voice from a short natural-language description.
Write 1–3 sentences describing the voice concretely:

- timbre and register (deep, warm, bright, raspy, breathy)
- pitch range and volume (low, mid, high; loud, soft, hushed)
- pace and rhythm (slow and deliberate, quick and clipped, unhurried)
- tone and emotional quality (calm authority, nervous, mocking, gentle)
- accent and pronunciation (always end with "Native <Lang> pronunciation")

Make every voice DISTINCT — no two characters should sound alike. Avoid generic
phrases like "a character voice", "natural intonation", or "matching the
character". Ground the description in the character: age, build, temperament,
and any explicit speech description in the text.

## TTS Input Text

The synthesized speech reads the text as-is, so the input must be speech-ready:

- clean, well-punctuated text (. , ! ? —)
- natural sentence length (15–30 words) — paragraph breaks reflect pause points
- proper noun capitalization (models respect casing for emphasis)
- dialogue turns separated per speaker

Avoid phonetic spellings, pronunciation guides, ALL CAPS for emphasis,
excessive punctuation, special characters, or markup.

## What to Avoid

✗ Generic voice phrases ("natural intonation", "matching the character")
✗ Internal written-out sounds or phonetic annotations
✗ Very long run-on sentences in TTS input
✗ Overlapping or contradictory voice traits
