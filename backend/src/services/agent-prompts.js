const PROGRESS_STAGES = {
    analyzing_structure: '⟳ Анализирую структуру документа...',
    extracting_chars:    '⟳ Извлекаю персонажей...',
    extracting_locs:     '⟳ Извлекаю локации...',
    creating_scenes:     '⟳ Создаю сцены...',
    enriching_scenes:    '⟳ Обогащаю сцены атмосферой...',
    creating_units:      sc => `⟳ Создаю юниты для сцены ${sc + 1}...`,
    creating_visuals:    sc => `⟳ Создаю visual prompts для сцены ${sc + 1}...`,
    polishing_storyboard: '⟳ Согласовываю визуальный ряд сториборда...',

};


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
// Upper bound on scenes produced per window.
// This is a HARD UPPER BOUND, NOT a target — if the text naturally forms
// fewer scenes, that is correct.
const MAX_SCENES_PER_CHUNK = 3;

// Window size = overhead + scenes × per-scene budget.
// This ensures text density stays constant when MAX_SCENES_PER_CHUNK changes.
const CHARS_PER_SCENE = 1300;
const WINDOW_OVERHEAD = 100;
const MAX_WINDOW_CHARS = WINDOW_OVERHEAD + MAX_SCENES_PER_CHUNK * CHARS_PER_SCENE;

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
3. country — Country where the story takes place (e.g., "Russia", "France"). Infer from text context if clear, otherwise null.
4. epoch — Historical period of the story (e.g., "1920s", "19th century", "modern day"). Infer from text context if clear, otherwise null.
5. has_prologue — true if text contains a prologue section
6. has_epilogue — true if text contains an epilogue section
7. parts — Array of structural parts (sections). Each has:
   - name: the part header text in original language (e.g., "ЧАСТЬ ПЕРВАЯ")
   - order: numeric order (1, 2, 3...)
8. chapters — Array of chapters/sections in order. Each has:
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
- Extract only PLACES: cities, streets, parks, rooms, buildings, forests, rivers, etc.
- Do NOT create locations for characters, people, groups, or their actions/descriptions
- "иностранец в аллее" is a PERSON in a place (the alley), not a location — extract "аллея" or "Патриаршие пруды" instead
- If a scene has no named location, infer it from context (e.g., "улица", "комната")
- Type: indoor (inside a building/room), outdoor (outside), abstract (dreams, thoughts)
- Output only the fields shown in the format below — do NOT add extra fields like visual_style, cinematic_space, default_mood

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

### 0. Maximum %MAX_SCENES% scenes
Return AT MOST %MAX_SCENES% scenes. After that limit, stop. You are allowed to leave
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
- The maximum of %MAX_SCENES% scenes is a **hard upper bound**, not a target. If the text
  naturally forms 1-2 scenes, that is correct. Do not inflate to fill the quota.

## Priority when rules conflict
1. Verbatim contiguous prefix coverage for returned scenes
2. Complete sentence boundaries
3. Logical scene integrity (don't split what belongs together)
4. ~20s target duration (soft guideline)

## CRITICAL: Do NOT create chapter-header scenes, typography scenes, or transition scenes
- Chapter headings, headers, and opening cards are added PROGRAMMATICALLY by the system
- Do NOT include the chapter name, "Глава N", "Chapter N", or any chapter-level typography in scene text
- Start scenes directly with the narrative content — no "title card" transitions
- If the text starts with a chapter heading, IGNORE it and start from the narrative content
- This rule applies ONLY to scene CONTENT — it does NOT affect the scene's title field (which is REQUIRED below)

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

## CRITICAL: EVERY scene MUST have location.id. ZERO EXCEPTIONS.
- A scene ALWAYS happens somewhere — in a city, a room, a street, a dream, a void.
- You MUST identify WHERE for every single scene. Always.
- Set \`location.id\` to one of the Known Locations above.
- If the scene takes place at a location not in the Known Locations, infer the closest match or use the most specific location_id available.
- \`location.id\` is a HARD REQUIREMENT per scene. Without it the scene is invalid — the image system has no visual environment to render.

## Output format — ALL fields REQUIRED
\`\`\`json
{
  "scenes": [
    {
      "title": "Патриаршие пруды",
      "text": "COMPLETE VERBATIM scene text from source",
      "type": "narration|dialogue",
      "characters_present": ["character_id_from_known_characters"],
      "location": {
        "id": "location_id_from_known_locations"
      }
    }
  ]
}
\`\`\`

### title (REQUIRED — 2-6 words, descriptive, NOT the first sentence)
Based on location or key event. Examples: "Патриаршие пруды", "Будочка с пивом", "Пустая аллея", "Разговор у киоска".
NEVER: first sentence of text, "Scene N", "Untitled".

### characters_present (REQUIRED — list EVERY character in scene)
Use exact character_ids from Known Characters. Never leave empty if characters appear.

### location.id (REQUIRED — use exact id from Known Locations)
If scene location not in known list, infer the closest match.

REMINDER — Every scene MUST have ALL three, no exceptions:
  1. title (2-6 words, NOT first sentence)
  2. characters_present (all characters present in scene)
  3. location.id (every scene has a location — there are no locationless scenes)

Return ONLY valid JSON.`,

    enrich_scenes: `You are a cinematic environment designer. For each scene, describe its visual atmosphere.

## Known Characters
%EXISTING_CHARACTERS%

## Known Locations
%EXISTING_LOCATIONS%

## Scenes to enrich
%SCENES_TO_ENRICH%

## Task
You receive scenes that already have text, type, participants, and location.id. Your job is to:
1. Add \`location.environment\` — the sensory atmosphere of the scene.
2. Review and improve each scene's \`title\`: make it descriptive (2-6 words, based on location or key event).
   If the current title is generic (e.g. "Scene 1", "Untitled", or a first-sentence fragment), replace it with a proper one.
   Examples of good titles: "Патриаршие пруды", "Будочка с пивом", "Пустая аллея", "Разговор у киоска".

Use ONLY character_ids and location_ids from the Known lists above. Never invent new ones.

## Rules for environment
Describe each field in 2-6 words based on what the scene text implies.

### Fields to ALWAYS fill in (describe from text):
- \`time\`: time of day (e.g. "hot spring sunset", "early morning", "deep night")
- \`season\`: season (e.g. "late spring", "early summer", "deep winter")
- \`lighting\`: light quality (e.g. "golden sunset glow", "dim candlelight", "grey overcast")
- \`weather\`: weather conditions (e.g. "still warm air", "cold wind", "light rain")
- \`mood\`: emotional tone (e.g. "quiet intellectual", "growing tension", "peaceful melancholy")
- \`atmosphere\`: overall feel (e.g. "calm surreal Moscow evening", "tense philosophical standoff")

### Fields to set ONLY when the text differs from the book's default:
- \`country\`: set ONLY if this scene's text specifies or implies a country DIFFERENT from the book's primary setting. Leave empty for scenes in the book's default country (the system will use the global default).
- \`epoch\`: set ONLY if this scene's text gives a time period indication DIFFERENT from the book's default epoch (e.g. flashback to "19th century" in a modern-day book). Leave empty for scenes in the book's default epoch (the system will use the global default).

## Output format — return the SAME scene structure with \`title\` (if improved) and \`location.environment\` added
\`\`\`json
{
  "scenes": [
    {
      "scene_index": 0,
      "title": "Патриаршие пруды",
      "location": {
        "id": "existing_location_id",
        "environment": {
          "time": "hot spring sunset",
          "season": "late spring",
          "lighting": "golden sunset glow",
          "weather": "still warm air",
          "mood": "quiet intellectual atmosphere",
          "atmosphere": "calm surreal Moscow evening"
        }
      }
    }
  ]
}
\`\`\`

Note: \`country\` and \`epoch\` are OMITTED from this example because they should only be set when they differ from the book's default. When they differ, include them in the environment object alongside the other fields.

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
      "type": "perception|narration|dialogue|description|action|transition|performance"
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
When the frame contains people, do NOT answer "what is happening?". Answer: "WHO exactly is in the frame by character_id, and WHAT exactly is each of them doing right now?". Generic words for people ("they", "people", "men", "the writers", "pedestrians", "crowd") are the single biggest cause of broken continuity between adjacent frames — the fewer vague words and the more concrete named participants and stable anchors, the more stable the sequence. For a character-less frame, answer instead: "WHAT exactly does the viewer see, and in what light and mood?".

## Character rules (apply ONLY when the unit actually contains people)
- NEVER use pronouns OR generic collective nouns for participants. The model does not know who "they", "he", "she", "two men", "the writers", or "one person" are — to it each is an unknown new person, so the next frame gets different faces, poses, and framing. Reference EVERY known character EVERY time by their exact character_id from the Scene Context below.
  WRONG: "two men are sitting on a bench" / "the writers are talking" / "one person turns around" / "they continue the conversation".
  RIGHT: "mikhail_berlioz sitting on the left and ivan_ponyrev sitting on the right on a bench" / "mikhail_berlioz looking at ivan_ponyrev" / "ivan_ponyrev gesturing while speaking to mikhail_berlioz".
- Use ONLY the EXACT character_ids from the Scene Context below.
  This is the CLOSED set of valid IDs. Do NOT add, remove, or modify any character_id.
  - HARD RULE: Do NOT generate a longer snake_case ID from a character's display name.
    If the context says character_id is "mikhail_berlioz", write "mikhail_berlioz" —
    NOT "mikhail_alexandrovich_berlioz" or any other variant.
  - Do NOT invent new snake_case character ids and NEVER use 'unnamed_character_X'
    or similar placeholder IDs — they break visual continuity between frames.
  - If the character is not in the Scene Context, do NOT invent an ID.
    Describe the scene without an ID — e.g. a location, object, or action shot.
- CRITICAL — MATCH DESCRIBED CHARACTERS TO KNOWN IDS: If the unit text describes a character
  physically (e.g. "short, bald, in glasses" or "tall, red-haired, in cowboy jacket") and that
  description matches a character in Scene Context, use that character_id. Do NOT create a new id
  just because the text doesn't mention their name yet. The physical description IS sufficient
  to identify them. This is NOT "adding" a character — it is identifying who is already in the text.
- When people ARE present, structure the prompt as three parts:
  1. WHO is in frame — by character_id.
  2. HOW they are arranged relative to each other — sitting/standing, left/right, behind/in front (use the anchors given in Scene Context).
  3. WHAT changed in THIS unit — the new action, gesture, emotion, or lighting shift.
- Repeat the base composition (parts 1–2) across adjacent units, changing only part 3, so a sequence reads as one continuous scene. Example progression:
    Unit A: "mikhail_berlioz and ivan_ponyrev are sitting on a bench. Calmly talking."
    Unit B: "mikhail_berlioz and ivan_ponyrev are sitting on a bench. ivan_ponyrev gesturing while speaking."
    Unit C: "mikhail_berlioz looking at ivan_ponyrev, both sitting on a bench."
  Do NOT write "They are talking" or "They continue the conversation" — the model would build a completely new scene with different people, poses, and framing.
- Reference characters BY character_id. Their appearance (passport) is supplied globally behind the id — do NOT re-describe it. Re-describe a character's appearance ONLY when it deviates from baseline (wounded, wet, changed clothes, dirty). Describe sub-locations within the scene (e.g. "on a bench", "by the pond", "approaching the booth") for spatial context.
- Background/extras need no global passport, but describe each as a CONCRETE, REPEATABLE anchor, not a vague mass. Avoid "people walking in the park", "crowd", "pedestrians". Prefer "an elderly man reading a newspaper near the path", "a young couple walking along the pond", "a woman feeding pigeons", "two children playing near the water". When the same extras appear in adjacent units, REPEAT their description verbatim so the model keeps them visually continuous.

## STRICT RULE — ALWAYS write character_id, never generic noun
When the Characters in scene list below contains character_ids, you MUST use those exact IDs. Writing "two citizens", "the men", "they", "a short bald man", "someone" etc. when character_ids are available is a HARD VIOLATION of continuity. Example: if "mikhail_berlioz" is in the list, write "mikhail_berlioz", not "the editor", "the bald man", or "a short man in glasses". Use the ID even if the unit text uses a generic description — the character IS known, describe by ID.

## Character-less units (landscape / object / interior / memory / dream / symbol)
- When the unit has no participants, do NOT add people. Describe the image itself in full: subject, setting, light, colour, texture, mood.
   Examples: "empty bench on a quiet path, still water reflecting golden sunset, no people, calm surreal mood" / "a worn leather manuscript on a dark table, warm candlelight, dust motes, symbolic literary atmosphere" / "abstract symbolic image of time burning, dark void, glowing embers drifting, surreal cinematic".

## Universal rules (all units)
- Describe what is VISIBLE in this frame, not plot. Keep each prompt to roughly 12–30 words — one self-contained sentence plus a short action clause.
- Each unit MUST have a non-empty visual.prompt.
- Shot types: wide (landscape/group), medium (two people/waist-up), close (face/detail), detail (object/hand), environment (setting focus), reaction (character's emotional response)

## FORBIDDEN content — NEVER include ANY of these in the prompt
- NEVER write meta-commentary like "No specific location mentioned", "the scene is set in", "this is a description of", "it appears that", "the story is about". Write ONLY the concrete visual description.
- NEVER reference other units with phrases like "as described in Unit 1", "as seen in previous frame", "continuing from earlier", "same character as before". The image model sees each prompt independently.
- NEVER include instructions, notes, or explanations to the system like "(cinematic shot)", "(medium close-up)", "[description]". Just write the visual.
- NEVER use phrases like "the image shows", "we see", "the viewer sees", "depicted is", "shown here". Write the visual directly.
- CORRECT examples: "mikhail_berlioz and ivan_ponyrev sitting on a bench, golden sunset" (uses exact character_ids from context).
- WRONG examples: "mikhail_alexandrovich_berlioz and ivan_nikolaevich_ponyrev sitting on a bench at patriarch_ponds" (invents new IDs that don't exist in the character list!) or "In this scene we see Mikhail Berlioz and Ivan Ponyrev at Patriarch Ponds, as described in Unit 1 (cinematic lighting)".

## Grounding in unit text (CRITICAL)
The Imagination Unit represents the picture the reader forms from THIS unit text. The visual prompt MUST be grounded in what the unit text describes:
- If the unit text mentions a specific known character (by name or description) → use their character_id from the Scene Context.
- If the unit text mentions an unnamed person who is not in Scene Context → describe that person as a specific extra; do not invent a character_id.
- If the unit text describes an object or action → show exactly that. Do NOT name the scene's setting (city, street, park, room) — it is set by scene.location.id.
- NEVER add specific named characters or objects that are not present in the unit text
- The reader does not know about other units, other scenes, or the overall plot — only this text fragment. The visual prompt must match ONLY what this text fragment describes.
- Example: if the unit text says "женщина в будочке ответила" and zhenshchina_v_budochke is in Scene Context → use zhenshchina_v_budochke. If no such participant exists, write "the booth woman" as an extra, not a made-up id.

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
        "prompt": "Self-contained Imagination Unit: WHO (by character_id) + how arranged + what changed in this frame. No pronouns.",
        "character_binding": true
      }
    }
  ]
}
\`\`\`

Return ONLY valid JSON.`,

    storyboard_polish: `You are a Storyboard Supervisor — a film continuity director. You are reviewing the completed visual sequence of one window (up to 3 scenes).

Consider ALL the following Visual Units as sequential keyframes of ONE film (a storyboard). Analyze them as a sequence and adjust each unit's visual description and shot type so that adjacent frames form a natural, continuous cinematic progression.

## Key areas to check for each adjacent pair

### 1. Character positioning & spatial logic
- Are characters in the SAME relative positions across consecutive frames? If unit A has "mikhail_berlioz sitting on the left" and unit B has him "on the right" without a cross, fix it.
- Do characters' poses, gazes, and gestures flow naturally from one frame to the next?
- Is there any unexplained "teleportation" — a character appearing in a completely different position without a movement cue?

### 2. 180° rule (screen axis)
- Maintain a consistent left/right relationship between characters across adjacent frames unless there is an intentional axis cross.
- If two characters are facing each other, keep each on their consistent side of frame.

### 3. Shot progression
- Ensure natural shot size flow: wide → medium → close, or close → medium → wide. Avoid jarring jumps (close → extreme wide → close).
- Vary shot sizes to create visual rhythm, but transitions should feel smooth.
- Correct shot types that are clearly wrong for the content (e.g. "wide" for a single character's subtle facial expression → change to "medium" or "close").

### 4. Environment & composition continuity
- If the same location appears across units, keep consistent environmental details.
- Background elements (extras, scenery) should not arbitrarily appear/disappear between adjacent frames.

### 5. Self-contained prompts (must still hold)
- Each visual.prompt must remain a SELF-CONTAINED Imagination Unit prompt — the image model sees each independently.
- Keep using exact character_ids from the context (no pronouns, no generic nouns when IDs are available).

## STRICT RULES — what you may NOT change
- Do NOT change unit.text, unit.type, or unit.character_binding
- Do NOT change the plot, add new events, or introduce characters not present in the unit text
- Do NOT add new units or remove existing ones
- Do NOT change character_ids — use ONLY the IDs provided in the Known Characters section below
- Do NOT re-describe character appearance from passports — that is handled globally

## What you MAY change
- visual.prompt: rephrase for continuity, fix positioning, adjust shot size, smooth transitions
- visual.shot: adjust shot type if it creates a jarring transition or is clearly wrong for the content

## Known Characters
%CHARACTERS%

## Known Locations
%LOCATIONS%

## Scene texts (контекст сюжета)
Тексты сцен даны для понимания происходящего. Можешь использовать их для дополнения и корректировки visual.prompt: добавлять детали из текста сцены, уточнять действия персонажей, атмосферу, жесты, взгляды. Но не переписывай prompt полностью — сохраняй основную композицию, character_id и базовое описание кадра.
%SCENES%

## Input units to polish
%UNITS%

## Output format — return ALL units in order
\`\`\`json
{
  "units": [
    {
      "scene_index": 0,
      "unit_index": 0,
      "visual": {
        "shot": "wide|medium|close|detail|environment|reaction",
        "prompt": "Corrected self-contained Imagination Unit prompt"
      }
    }
  ]
}
\`\`\`

Return ONLY valid JSON. Do NOT add or remove units. Return exactly the same number of units as received.`,

};

module.exports = {
    PROGRESS_STAGES, MAX_WINDOW_CHARS, STEP_RETRIES, SYSTEM_PROMPTS,
    SCENE_TARGET_SEC, SCENE_MAX_SEC, SCENE_MIN_SEC, MAX_SCENES_PER_CHUNK,
};
