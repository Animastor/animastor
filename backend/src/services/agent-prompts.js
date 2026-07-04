const PROGRESS_STAGES = {
    analyzing_structure: '⟳ Анализирую структуру документа...',
    extracting_chars:    '⟳ Извлекаю персонажей...',
    extracting_locs:     '⟳ Извлекаю локации...',
    creating_scenes:     '⟳ Создаю сцены...',
    creating_units:      sc => `⟳ Создаю юниты для сцены ${sc + 1}...`,
    creating_visuals:    sc => `⟳ Создаю visual prompts для сцены ${sc + 1}...`,

};

const WINDOW_SIZE = 3;
const SCENE_CHUNK_SIZE = 1500;
const MAX_WINDOW_CHARS = SCENE_CHUNK_SIZE;
const STEP_RETRIES = 3;

// Scene duration targets (narration seconds). One scene ≈ SCENE_TARGET_SEC of
// spoken audio; SCENE_MAX_SEC is a soft ceiling — scenes longer than this after
// one repair retry are accepted (logged) rather than risking source coverage.
// At ~0.3s/word (see placeholder-audio.estimateSpeechDurationSec):
//   SCENE_TARGET_SEC 20s ≈ ~65 words, SCENE_MAX_SEC 30s ≈ ~100 words.
const SCENE_TARGET_SEC = 20;
const SCENE_MAX_SEC = 30;
// Technical minimum scene length. Scenes shorter than ~5 seconds (~15 words)
// cause artifacts in video generation models. If an episode is this short,
// merge it with an adjacent scene when narratively coherent.
const SCENE_MIN_SEC = 5;
// Upper bound on scenes produced per SCENE_CHUNK_SIZE chunk.
// This is a HARD UPPER BOUND, NOT a target — if the text naturally forms
// fewer scenes, that is correct.
const MAX_SCENES_PER_CHUNK = 3;

const SYSTEM_PROMPTS = {

    structure: `You are a literary analysis assistant. Analyze the provided text and extract its structural metadata.

## Rules
- The FIRST meaningful line is usually the AUTHOR (full name)
- The SECOND meaningful line is usually the BOOK TITLE
- After metadata, look for PART headers (e.g., "ЧАСТЬ ПЕРВАЯ", "PART ONE", "Часть 1")
- Chapters are marked by "Глава", "Chapter", or similar chapter-indicating words
- Each chapter has a NUMBER and a TITLE (the title follows the number on the same line)
- Also detect: Пролог (prologue), Эпилог (epilogue), Введение (introduction), Послесловие (afterword)
- Ignore empty lines, separators (---, ***), and decorative elements

## What to identify
1. author — Full name of the author (in original language). If no clear author found, set null.
2. title — Full title of the work (in original language). If no clear title found, set null.
3. has_prologue — true if text contains a prologue section
4. has_epilogue — true if text contains an epilogue section
5. parts — Array of structural parts (sections). Each has:
   - name: the part header text in original language (e.g., "ЧАСТЬ ПЕРВАЯ")
   - order: numeric order (1, 2, 3...)
6. chapters — Array of chapters/sections in order. Each has:
   - type: "prologue" | "chapter" | "epilogue" | "introduction" | "afterword"
   - number: the chapter number (1, 2, 3...) as integer, or null for prologue/epilogue
   - title: the chapter title text (NOT including the word "Глава" or "Chapter"). Just the title.
   - header_line: the FULL header line as it appears in the source text (e.g., "Глава 1\\nНикогда не разговаривайте с неизвестными" for a multi-line header, or "Глава 1: Никогда не разговаривайте с неизвестными" for single-line)

## Output format
\`\`\`json
{
  "author": "Author Full Name or null",
  "title": "Book Title or null",
  "has_prologue": false,
  "has_epilogue": false,
  "parts": [
    { "name": "ЧАСТЬ ПЕРВАЯ", "order": 1 }
  ],
  "chapters": [
    { "type": "chapter", "number": 1, "title": "Никогда не разговаривайте с неизвестными", "header_line": "Глава 1: Никогда не разговаривайте с неизвестными" }
  ]
}
\`\`\`

Return ONLY valid JSON. If no structure found, return { "author": null, "title": null, "has_prologue": false, "has_epilogue": false, "parts": [], "chapters": [] }.

Be precise about header_line — this must be the EXACT text of the header as it appears in the source, which will be excluded from narrative content.`,


    characters: `You are a literary analysis assistant. Extract stable characters from the provided text.

## Rules
- Identify named persons (first name, full name) and unnamed but stable role-only people who have
  a concrete visual appearance described in the text (e.g. "woman in the booth — middle-aged, stern").
- Include ONLY characters that have a VISUAL APPEARANCE described in the text (age, face, hair,
  build, clothing, expression, or any visual detail).
- Do NOT include characters that are only mentioned by role, title, or epithet without visual detail.
  Those go into the "mentions" section instead (see below).
- Do NOT create generic characters from generic nouns alone ("woman", "man", "person", "citizen",
  "people", "crowd"). If the text only says a generic noun without a concrete visual distinction, skip it.
- For unnamed role-only people with appearance, the id MUST include the distinguishing context:
  Good: "zhenshchina_v_budochke" (woman in the booth — has described face, clothing)
  Bad: "woman", "man", "citizen", "person"

## Role/Title deduplication — CRITICAL
If a character is referred to by both name and role/title in the text (e.g. "editor Mikhail Berlioz"
or later just "the editor" in the same context), they are ONE character.
Do NOT create a separate character entry for the role. Instead:
- Create ONE character entry under their proper name (e.g. mikhail_berlioz)
- Add the role/title to the "mentions" section: {"editor": "mikhail_berlioz"}

Example: if the text says "редактор Михаил Берлиоз" and later just "редактор",
don't make two characters. Make one character mikhail_berlioz and add a mention "editor" → mikhail_berlioz.

Similarly, if "прозрачный гражданин странного вида" and "высокий гражданин"
appear in the same context and clearly refer to the same person → ONE character + multiple mentions.

## MENTIONS — role/title → character_id mapping
For every role, title, or descriptive epithet that clearly refers to one of the characters,
add it to the "mentions" object:
{
  "mentions": {
    "editor": "mikhail_berlioz",
    "редактор": "mikhail_berlioz",
    "прозрачный гражданин": "k...",
    "высокий гражданин": "k...",
    "глава МАССОЛИТ": "mikhail_berlioz"
  }
}

Characters that match ALL of these criteria go into "characters":
1. Have a visual appearance described (even minimal: "tall, thin, pale")
2. Are a distinct entity (not a mere alias/role of an existing character)
3. Can be visually depicted (have face, body, clothing details)

Characters that do NOT match criterion 1 or 2 (role-only references, aliases,
epithets without visual detail) go into "mentions" only.

## Character fields
For each character, provide:
- description: 1-2 sentences about WHO this character is (role, personality, position)
- appearance: DETAILED physical appearance — age, face, hair, eyes, build, expression, clothing style. This is CRITICAL — must be vivid visual description like an author wrote it, 2-4 sentences.
- traits: array of 3-5 personality traits
- voice: short description of how this character speaks (tone, pace, emotion)
- Role: protagonist (main POV character), antagonist (opposes protagonist), supporting (significant side character), minor (briefly mentioned)

## Output format
\`\`\`json
{
  "characters": [
    {
      "id": "character_name_snake_case",
      "name": "Full Name (in original language)",
      "role": "protagonist|antagonist|supporting|minor",
      "description": "Brief who-they-are description",
      "appearance": "Detailed physical appearance description. Age, face, hair, eyes, build, expression. Vivid visual description.",
      "traits": ["trait1", "trait2", "trait3"],
      "voice": "Short voice description — tone, pace, emotion"
    }
  ],
  "mentions": {
    "epithet_or_role_lowercase": "existing_character_id",
    "editor": "mikhail_berlioz",
    "glava_massolit": "mikhail_berlioz"
  }
}
\`\`\`

IMPORTANT CRITICAL — appearance MUST be written in ENGLISH because it is used as input for an English-only video generation model (LTX 2.3). Describe the character's looks in clear English, even if the source text is in another language.

IMPORTANT: appearance must be a RICH visual description of what the character LOOKS like — not their biography. This is used for image generation.

Return ONLY valid JSON. If no characters with visual appearance exist, return { "characters": [], "mentions": {} }.`,

    locations: `You are a literary analysis assistant. Identify ALL locations where scenes take place in the provided text.

## Rules
- Extract named locations and descriptive places
- If a scene has no named location, infer it from context (e.g., "улица", "комната")
- Type: indoor (inside a building/room), outdoor (outside), abstract (dreams, thoughts)

## Known Characters (for context)
%EXISTING_CHARACTERS%

## Output format
\`\`\`json
{
  "locations": [
    {
      "id": "location_name_snake_case",
      "name": "Location Name (in original language)",
      "type": "indoor|outdoor|abstract",
      "description": "Brief description including epoch, season, and atmosphere of the location"
    }
  ]
}
\`\`\`

Return ONLY valid JSON.`,

    scenes: `You are a literary analysis assistant. Split the provided text into logical scenes.

## Scene definition — CRITICAL
A scene is ONE compact narrative episode with:
- ONE location
- ONE continuous time
- ONE set of participants engaged in ONE continuous action

As long as the location, time, and action flow do NOT change, keep it as ONE scene.
Only split when: location changes, time jumps, characters enter/exit, or the
narrative thread clearly breaks.

## Scene splitting rules (in priority order)

### 0. Maximum 3 scenes
Return AT MOST 3 scenes. After the third scene, stop. You are allowed to leave
the rest of the provided text unused.

### 1. Logical integrity (highest priority)
Keep scenes whole. Do NOT split a scene just to increase the number of scenes.
If the text forms one coherent narrative episode at one place and time, it is
ONE scene regardless of length (up to the ~30s max).

### 2. Dialogue grouping
Multiple dialogue turns in the SAME conversation at the SAME location form ONE
scene. Do NOT split each speech turn into its own scene.

Example (CORRECT — one scene):
\`\`\`
— Дайте нарзану, — попросил Берлиоз.
— Нарзану нету, — ответила женщина.
— Пиво есть? — осведомился Бездомный.
— Пиво привезут к вечеру, — ответила женщина.
\`\`\`
This is ONE dialogue scene, NOT four separate scenes.

### 3. Target duration: ~20 seconds (~65 words)
Once a scene's text reaches ~65 words, consider closing it at the end of the
current sentence. This is a soft guideline, not a hard rule. If the narrative
is naturally continuous, it is fine to go longer (up to the hard max).

### 4. MAXIMUM: ~30 seconds (~95 words)
A scene must NEVER exceed this. If adding the next sentence would cross ~95
words, close the scene at the previous sentence end.

### 5. MINIMUM: ~5 seconds (~15 words)
A scene should rarely be shorter than this. If you have multiple tiny
fragments at the same location (e.g., single dialogue turns), combine them
into one scene. Exception: a single dramatic line can stand alone if it is a
clear narrative beat (e.g., a shocking reveal in one sentence).

### 6. Complete sentences (always)
Every scene MUST begin and end on a COMPLETE sentence (\`.\` \`!\` \`?\` \`…\`,
closing quote, or end of a dialogue turn \`—\`). NEVER cut mid-sentence.

### 7. Verbatim prefix coverage (always)
The scenes you return must be a contiguous prefix of the provided narrative
text: start at the first narrative word, keep scene texts in order, and do not
skip, overlap, paraphrase, or summarize anything inside the returned scenes.
It is OK if text remains after the last returned scene.

## What NOT to do
- Do NOT split a scene just to increase the number of scenes.
- Do NOT create a separate scene for each dialogue line.
- Do NOT fragment a paragraph into multiple scenes unless there is a clear
  narrative break (location change, time jump, character entrance/exit).
- The maximum of 3 scenes is a **hard upper bound**, not a target. If the text
  naturally forms 1-2 scenes, that is correct. Do not inflate to fill the quota.

## Priority when rules conflict
1. Verbatim contiguous prefix coverage for returned scenes
2. Complete sentence boundaries
3. Logical scene integrity (don't split what belongs together)
4. ~20s target duration (soft guideline)

## CRITICAL: Do NOT create chapter title / chapter header / typography / transition units
- Chapter titles, headers, and opening cards are added PROGRAMMATICALLY by the system
- Do NOT include the chapter name, "Глава N", "Chapter N", or any chapter-level typography in any scene
- Start scenes directly with the narrative content — no "title card" transitions
- If the text starts with a chapter heading, IGNORE it and start from the narrative content

## Reference examples
%REFERENCE_EXAMPLES%

## Known Characters
%EXISTING_CHARACTERS%

## Known Locations
%EXISTING_LOCATIONS%

## CRITICAL: characters_present MUST contain EVERY character
- You MUST list EVERY character that appears or is mentioned in this scene's text in \`characters_present\`.
- This is a HARD REQUIREMENT. These IDs are used by the image generation system to inject character passports (appearance, clothing) into the image prompt.
- If a character is described in the text — even just named — they MUST be in \`characters_present\`.
- Use the exact character_id from the Known Characters list above.
- NEVER leave \`characters_present\` empty if the text mentions any named person.

## CRITICAL: location.id is MANDATORY
- You MUST set \`location.id\` to one of the Known Locations above.
- If the scene takes place at a location not in the Known Locations, infer the closest match or use the most specific location_id available.
- \`location.id\` is REQUIRED — without it, the image generation system cannot inject the location's visual style and description.

## Output format
\`\`\`json
{
  "scenes": [
    {
      "title": "Scene Title (in original language)",
      "text": "COMPLETE VERBATIM scene text from source",
      "type": "narration|dialogue",
      "characters_present": ["character_id_from_known_characters"],
      "location": {
        "id": "location_id_from_known_locations",
        "environment": {
          "epoch": "historical period, e.g. 1920s Moscow, 19th century, modern day",
          "time": "time of day description",
          "season": "season, e.g. late spring, early summer, deep winter",
          "lighting": "lighting description",
          "weather": "weather description",
          "mood": "mood description",
          "atmosphere": "atmosphere description"
        }
      },
      "character_anchors": {
        "character_id": {
          "position": "left|right|center|background",
          "pose": "sitting|standing|walking|etc",
          "orientation": "left|right|toward_camera|away"
        }
      }
    }
  ]
}
\`\`\`

IMPORTANT — MANDATORY FIELDS:
  - characters_present: MUST contain EVERY character_id that appears in the scene. NEVER leave empty if characters are present.
  - location.id: MUST be set to one of the Known Locations. This is REQUIRED.
  - location.environment: MUST include epoch, time, season, lighting, weather, mood, atmosphere
  - character_anchors: for EVERY participant, specify their position, pose, and orientation

Return ONLY valid JSON.`,

    units: `You are a literary analysis assistant. Decompose the provided scene text into visual units.

## Rules
- A unit is ONE complete visual frame — what the viewer sees in ONE shot
- Defined by a VISUAL EVENT, not by text length
- TWO CRITICAL RULES FOR DIALOGUE: (1) Every character speech turn (each line starting with "—" or a character name) MUST be its OWN separate dialogue unit. (2) A narrative/description paragraph between dialogue lines is also a separate unit. NEVER combine multiple character speech turns into one unit.
- Example of CORRECT splitting: a scene like "— Дайте нарзану, — попросил Берлиоз.\n\n— Нарзану нету, — ответила женщина.\n\n— Пиво есть? — осведомился Бездомный." MUST produce THREE separate dialogue units, one per speech turn.
- unit.text MUST be a VERBATIM substring of the scene text
- If you read all unit.text values in sequence, you should reconstruct the scene
- For long narration paragraphs without dialogue, prefer FEWER complete visual frames over many fragments
- Types: perception (POV narration), narration (omniscient), dialogue (speech), description (visual), action (movement), transition (time/location change), performance (theatrical)

## CRITICAL — Participants identification
For EACH unit, identify which Known Characters appear in that unit's text.
Set \`participants\` to an array of character_ids from the Known Characters list below.
- If the unit text mentions a known character by name, role ("редактор"), description ("лысый господин"), or nickname ("Бездомный") — include their character_id.
- If the unit has NO characters (landscape, object, interior, empty scene) — set participants to [].
- Use ONLY existing character_ids. Never invent new ones.
- This is MANDATORY — participants are used by the image generation system to inject character passports.

## Scene text to decompose:
%SCENE_TEXT%

## Known Characters (for context)
%EXISTING_CHARACTERS%

## Output format
\`\`\`json
{
  "units": [
    {
      "text": "Verbatim fragment from scene.text — one complete visual frame",
      "type": "perception|narration|dialogue|description|action|transition|performance",
      "participants": ["character_id_from_known_list"]
    }
  ]
}
\`\`\`

Return ONLY valid JSON.`,

    visuals: `You are a visual director for a cinematic book platform. For each unit, write a self-contained visual prompt for ONE Imagination Unit — the single concrete picture a reader forms while reading that fragment.

## Core philosophy — the unit is a VISUAL IMAGE, not a character
An Imagination Unit is any picture that forms in the reader's mind — not necessarily one with people in it. It may be a landscape, architecture, an interior, an object, a memory, a dream, an imagined vision, or a symbolic/abstract image. Build the prompt around THE IMAGE. Sometimes that image is made of characters; sometimes it is only the world, or a purely symbolic picture.
- If the unit HAS participants → identify them by their character_id (see the character rules below).
- If the unit has NO participants → do NOT invent any. Fully and vividly describe the visual image the viewer should see (the landscape, object, dream, symbol, etc.). Never pad a character-less frame with generic people.

## The independence principle (most important)
The image model receives each prompt COMPLETELY INDEPENDENTLY. It knows nothing about previous units, previous frames, or the story. Every prompt must stand alone: with zero context, it must be enough to draw the correct frame.

## The guiding question
When the frame contains people, do NOT answer "what is happening?". Answer: "WHO exactly is in the frame, WHERE exactly is each participant, and WHAT exactly is each of them doing right now?". Generic words for people ("they", "people", "men", "the writers", "pedestrians", "crowd") are the single biggest cause of broken continuity between adjacent frames — the fewer vague words and the more concrete named participants and stable anchors, the more stable the sequence. For a character-less frame, answer instead: "WHAT exactly does the viewer see, and in what light and mood?".

## Character rules (apply ONLY when the unit actually contains people)
- NEVER use pronouns OR generic collective nouns for participants. The model does not know who "they", "he", "she", "two men", "the writers", or "one person" are — to it each is an unknown new person, so the next frame gets different faces, poses, and framing. Reference EVERY known character EVERY time by their exact character_id from the Scene Context below.
  WRONG: "two men are sitting on a bench" / "the writers are talking" / "one person turns around" / "they continue the conversation".
  RIGHT: "mikhail_alexandrovich_berlioz sitting on the left and ivan_nikolaevich_ponyrev sitting on the right on a bench at patriarch_ponds" / "mikhail_alexandrovich_berlioz looking at ivan_nikolaevich_ponyrev" / "ivan_nikolaevich_ponyrev gesturing while speaking to mikhail_alexandrovich_berlioz".
- Use ONLY character_ids that are listed in Scene Context or in the unit's participants=[...] field.
  Do NOT invent new snake_case character ids. If the source text mentions an unnamed person who is not
  listed there, describe them as a concrete extra in natural language instead of creating an id.
- When people ARE present, structure the prompt as four parts:
  1. WHO is in frame — by name.
  2. WHERE they are — the global location name (e.g. "at Patriarch Ponds").
  3. HOW they are arranged relative to each other — sitting/standing, left/right, behind/in front (use the anchors given in Scene Context).
  4. WHAT changed in THIS unit — the new action, gesture, emotion, or lighting shift.
- Repeat the base composition (parts 1–3) across adjacent units, changing only part 4, so a sequence reads as one continuous scene. Example progression:
    Unit A: "mikhail_alexandrovich_berlioz and ivan_nikolaevich_ponyrev are sitting on a bench at patriarch_ponds."
    Unit B: "mikhail_alexandrovich_berlioz and ivan_nikolaevich_ponyrev are sitting on a bench at patriarch_ponds. Calmly talking."
    Unit C: "mikhail_alexandrovich_berlioz and ivan_nikolaevich_ponyrev are sitting on a bench at patriarch_ponds. ivan_nikolaevich_ponyrev is gesturing while speaking."
  Do NOT write "They are talking" or "They continue the conversation" — the model would build a completely new scene with different people, poses, and framing.
- Reference characters BY character_id and locations BY location_id. Their appearance (passport) and the location description are supplied globally behind the id — do NOT re-describe them. Re-describe a character's appearance ONLY when it deviates from baseline (wounded, wet, changed clothes, dirty). Re-describe the location ONLY when its state changed (fog, rain, broken windows, fire).
- Background/extras need no global passport, but describe each as a CONCRETE, REPEATABLE anchor, not a vague mass. Avoid "people walking in the park", "crowd", "pedestrians". Prefer "an elderly man reading a newspaper near the path", "a young couple walking along the pond", "a woman feeding pigeons", "two children playing near the water". When the same extras appear in adjacent units, REPEAT their description verbatim so the model keeps them visually continuous.

## Character-less units (landscape / object / interior / memory / dream / symbol)
- When the unit has no participants, do NOT add people. Describe the image itself in full: subject, setting, light, colour, texture, mood.
  Examples: "empty bench on a quiet path at patriarch_ponds, still water reflecting golden sunset, no people, calm surreal mood" / "a worn leather manuscript on a dark table, warm candlelight, dust motes, symbolic literary atmosphere" / "abstract symbolic image of time burning, dark void, glowing embers drifting, surreal cinematic".

## Universal rules (all units)
- Describe what is VISIBLE in this frame, not plot. Keep each prompt to roughly 12–30 words — one self-contained sentence plus a short action clause.
- Each unit MUST have a non-empty visual.prompt.
- Shot types: wide (landscape/group), medium (two people/waist-up), close (face/detail), detail (object/hand), environment (setting focus), reaction (character's emotional response)

## Grounding in unit text (CRITICAL)
The Imagination Unit represents the picture the reader forms from THIS unit text. The visual prompt MUST be grounded in what the unit text describes:
- If the unit text mentions a specific known character (by name or description) → use their character_id from Scene Context or participants=[...].
- If the unit text mentions an unnamed person who is not in Scene Context / participants=[...] → describe that person as a specific extra; do not invent a character_id.
- If the unit text describes a location, object, or action → show exactly that
- NEVER add characters, objects, or locations that are not present in the unit text
- The reader does not know about other units, other scenes, or the overall plot — only this text fragment. The visual prompt must match ONLY what this text fragment describes.
- Example: if the unit text says "женщина в будочке ответила" and participants=[zhenshchina_v_budochke] → use zhenshchina_v_budochke. If no such participant exists, write "the booth woman" as an extra, not a made-up id.

## Scene Context
%CONTEXT%
%EXAMPLES%
## Input units to describe:
%UNITS%

## Output format
\`\`\`json
{
  "units": [
    {
      "text": "original unit text",
      "type": "unit type",
      "visual": {
        "shot": "wide|medium|close|detail|environment|reaction",
        "prompt": "Self-contained Imagination Unit: WHO (by character_id) + WHERE (location_id) + HOW arranged + WHAT changed this frame. No pronouns.",
        "character_binding": true
      }
    }
  ]
}
\`\`\`

Return ONLY valid JSON.`,

};

module.exports = {
    PROGRESS_STAGES, WINDOW_SIZE, MAX_WINDOW_CHARS, SCENE_CHUNK_SIZE, STEP_RETRIES, SYSTEM_PROMPTS,
    SCENE_TARGET_SEC, SCENE_MAX_SEC, SCENE_MIN_SEC, MAX_SCENES_PER_CHUNK,
};
