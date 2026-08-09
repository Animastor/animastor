# Fantasy Snake-Case ID Repair

A previous model wrote visual prompts that reference snake_case ids which are NOT in the
known character/location lists below. Such an id is a HALLUCINATION: the person it stands
for is actually an unnamed episodic participant (or, sometimes, an object) designated
naturally in the source text — e.g. «женщина в будочке» was mangled into "zhenshchina_v_budochke".

Your job: REASSEMBLE each flagged unit so the fantasy id is replaced by the person's natural
designation, derived from the unit's source text. Never keep or invent a snake_case id.

## Rules
- The ONLY valid ids are the ones listed in "Known character ids" and "Known location ids" below.
  Every other snake_case token (latin word with underscores) is fantasy and must be removed.
- To recover the designation, read the unit's `text` (the original book fragment, in the
  book's language). The person is named or described there naturally — use exactly that
  person as they appear: e.g. "the kiosk saleswoman", "the woman in the booth", "старик
  в очках", "der Verkäufer am Kiosk". Do not invent new names, traits, or ids.
- If the token is actually an object / location / camera term (e.g. "park_bench",
  "close_up", "street_lamp"), rewrite it as natural words ("park bench", "close-up").
- Keep everything else in the prompt exactly as-is: composition, setting, light, mood,
  the valid character ids, shot type, length. Do not add new content or characters.
- Result language: English (en) for image.prompt and video.action, as always. Derive the
  natural designation FROM the book text (e.g. «женщина в будочке» → "the kiosk saleswoman")
  and output it in English. Never paste raw book-language text into the prompt.
- If the unit carries an `audio.speaker` that is a fantasy id, reassemble it the same way:
  the natural designation of the speaker ("the kiosk saleswoman").

## Mandatory completeness (IMPORTANT)
A flagged unit is reassembled ONLY when EVERY field is returned. A partial unit —
with `image.prompt` but WITHOUT `video.action` — is a FAILURE and is discarded
entirely: the fantasy id that hides in the omitted field would otherwise stay in
final video prompts.
- Return a FULL object for EVERY input unit: `image.prompt`, `video.action` AND
  `audio.speaker` (when the unit has audio).
- Scan EVERY field for the fantasy ids listed in `fantasy_ids` — they can be
  present in any of the three fields, not only in the prompt.
- Fields that need no change are copied VERBATIM from the input (still include
  them in the output object — never omit a field).

## Output format
Return ONLY valid JSON — one entry per input unit:
```json
{
  "units": [
    {
      "scene_index": 0,
      "unit_index": 1,
      "image": { "prompt": "reassembled image.prompt" },
      "video": { "action": "reassembled video.action" },
      "audio": { "speaker": "reassembled speaker designation" }
    }
  ]
}
```
ALWAYS include all three fields (`image.prompt`, `video.action`, `audio.speaker` when the unit
has audio) for every unit, copying unchanged ones verbatim. Never change scene_index / unit_index.

## Known character ids
%CHARACTERS%

## Known location ids
%LOCATIONS%

## Units to reassemble
%UNITS%
