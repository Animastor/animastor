const PROGRESS_STAGES = {
    analyzing_structure: '⟳ Анализирую структуру документа...',
    extracting_chars:    '⟳ Извлекаю персонажей...',
    extracting_locs:     '⟳ Извлекаю локации...',
    creating_scenes:     '⟳ Создаю сцены...',
    creating_units:      sc => `⟳ Создаю юниты для сцены ${sc + 1}...`,
    creating_visuals:    sc => `⟳ Создаю visual prompts для сцены ${sc + 1}...`,
};

const WINDOW_SIZE = 3;
const MAX_WINDOW_CHARS = 4000;
const SCENE_CHUNK_SIZE = 1500;
const STEP_RETRIES = 3;

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


    characters: `You are a literary analysis assistant. Extract ALL named characters from the provided text.

## Rules
- Identify every named person (first name, full name, or unique title)
- Include only real character names from the text, not objects or abstract concepts
- Role: protagonist (main POV character), antagonist (opposes protagonist), supporting (significant side character), minor (briefly mentioned)

For each character, provide:
- description: 1-2 sentences about WHO this character is (role, personality, position)
- appearance: DETAILED physical appearance — age, face, hair, eyes, build, expression, clothing style. This is CRITICAL — must be vivid visual description like an author wrote it, 2-4 sentences.
- traits: array of 3-5 personality traits
- voice: short description of how this character speaks (tone, pace, emotion)

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
  ]
}
\`\`\`


IMPORTANT CRITICAL — appearance MUST be written in ENGLISH because it is used as input for an English-only video generation model (LTX 2.3). Describe the character's looks in clear English, even if the source text is in another language.

IMPORTANT: appearance must be a RICH visual description of what the character LOOKS like — not their biography. This is used for image generation.

Return ONLY valid JSON.`,

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
      "description": "Brief description"
    }
  ]
}
\`\`\`

Return ONLY valid JSON.`,

    scenes: `You are a literary analysis assistant. Split the provided text into logical scenes.

## Rules
- A scene is ONE compact narrative episode with ONE location, ONE continuous time, ONE set of participants
- Scene boundaries: location change, time jump, character entrance/exit, narrative break
- Each scene.text must contain the COMPLETE VERBATIM original text for that episode
- Scene texts are used for TTS audio narration — must be verbatim, not summarized
- **Split the text into up to 3 scenes**
- **Word guideline: ~65 words per scene** (≈20s audio at Russian speech rate). If a sentence ends slightly over ~65 words, that's OK — finish the sentence. Do NOT cut mid-sentence.
- If a scene at a natural boundary far exceeds ~65 words, choose an earlier natural break point (paragraph end, sentence end). Prefer natural narrative boundaries over equal-length chunks. A shorter scene is better than an overly long one.
- Scene order must preserve the original narrative sequence.
- Do NOT use ellipsis (...) or any form of truncation or summarization. Every word from the provided text must appear in exactly one scene, verbatim, without gaps.
- Full source coverage is more important than the 65-word guideline or producing exactly 3 scenes.

## CRITICAL: Do NOT create chapter title / chapter header / typography / transition units
- Chapter titles, headers, and opening cards are added PROGRAMMATICALLY by the system
- Do NOT include the chapter name, "Глава N", "Chapter N", or any chapter-level typography in any scene
- Start scenes directly with the narrative content — no "title card" transitions
- If the text starts with a chapter heading, IGNORE it and start from the narrative content

## Known Characters
%EXISTING_CHARACTERS%

## Known Locations
%EXISTING_LOCATIONS%

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
          "time": "time description",
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

IMPORTANT: For each scene, you MUST include:
  - location.id: one of the Known Locations above
  - location.environment: atmospheric description of time, lighting, weather, mood, atmosphere
  - character_anchors: for EVERY participant, specify their position, pose, and orientation in the scene

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

    visuals: `You are a visual director for a cinematic book platform. For each unit, create a brief visual prompt describing what the viewer sees in that specific frame.

## Rules
- Describe ONLY what is visible in this specific frame — NOT a plot summary
- Camera framing, character position, lighting, environment, mood
- 5-15 words, in English
- Do NOT include character biography, location metadata, or plot summary
- Each unit MUST have a non-empty visual.prompt
- Shot types: wide (landscape/group), medium (two people/waist-up), close (face/detail), detail (object/hand), environment (setting focus), reaction (character's emotional response)

## Scene Context
%CONTEXT%

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
        "prompt": "Short visual description of this ONE frame (5-15 words)",
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
};
