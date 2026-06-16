// ======================================================
// Agent Service — Multi-step AI pipeline with PG memory
// ======================================================
// Each step is a small, focused AI call:
//   1. extract_characters  — identify characters from source text
//   2. extract_locations   — identify locations (knowing characters)
//   3. create_scenes       — split text into scenes (knowing chars+locs)
//   4. create_units        — per scene, decompose into visual units
//   5. create_visuals      — per scene, add visual prompts to units
//
// Results persist in PG (agent_steps table) between steps.
// No large knowledge base prompts — just focused instructions.
// ======================================================

const { query } = require('../storage/postgres/database');
const config = require('../config/runtime-config');
const lazyBook = require('../book/lazy-book');
const aiService = require('./ai-service');

// ======================================================
// WINDOW CONFIG
// ======================================================

const WINDOW_SIZE = 3;
const MAX_WINDOW_CHARS = 4000;
const STEP_RETRIES = 3;

// ======================================================
// PROGRESS STAGES (for chat display)
// ======================================================

const PROGRESS_STAGES = {
    analyzing_structure: '⟳ Анализирую структуру документа...',
    extracting_chars:    '⟳ Извлекаю персонажей...',
    extracting_locs:     '⟳ Извлекаю локации...',
    creating_scenes:     '⟳ Создаю сцены...',
    creating_units:      sc => `⟳ Создаю юниты для сцены ${sc + 1}...`,
    creating_visuals:    sc => `⟳ Создаю visual prompts для сцены ${sc + 1}...`,
};

// ======================================================
// SYSTEM PROMPTS — small, focused, no knowledge base
// ======================================================

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
   - header_line: the FULL header line as it appears in the source text (e.g., "Глава 1\nНикогда не разговаривайте с неизвестными" for a multi-line header, or "Глава 1: Никогда не разговаривайте с неизвестными" for single-line)

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
- Split EVERY logical scene — return at least 1 scene

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
      "participants": ["character_id_from_known_characters"],
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
- "Two people on a bench talking" is ONE unit even if the text is long
- Do NOT split a single visual scene into fragments by commas, sentences, or character count
- unit.text MUST be a VERBATIM substring of the scene text
- If you read all unit.text values in sequence, you should reconstruct the scene
- Prefer FEWER complete visual frames over many fragments
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

// ======================================================
// AGENT SESSION MANAGEMENT
// ======================================================

async function createSession(bookId, sourceType) {
    const result = await query(
        `INSERT INTO agent_sessions (book_id, source_type, status) VALUES ($1, $2, 'running') RETURNING *`,
        [bookId, sourceType || 'txt_import']
    );
    return result.rows[0];
}

async function updateSession(sessionId, updates) {
    const keys = Object.keys(updates);
    if (keys.length === 0) return;
    const setClauses = keys.map((key, i) => `${key} = $${i + 1}`);
    const values = keys.map(k => updates[k]);
    values.push(Math.floor(Date.now() / 1000));
    values.push(sessionId);

    await query(
        `UPDATE agent_sessions SET ${setClauses.join(', ')}, updated_at = $${keys.length + 1} WHERE session_id = $${keys.length + 2}`,
        values
    );
}

async function getSession(sessionId) {
    const result = await query(`SELECT * FROM agent_sessions WHERE session_id = $1`, [sessionId]);
    return result.rows[0] || null;
}

// ======================================================
// STEP MANAGEMENT — create and read steps in PG
// ======================================================

async function createStep(sessionId, stepType, stepIndex, sceneIndex) {
    const result = await query(
        `INSERT INTO agent_steps (session_id, step_type, step_index, scene_index, status)
         VALUES ($1, $2, $3, $4, 'running') RETURNING *`,
        [sessionId, stepType, stepIndex || 0, sceneIndex != null ? sceneIndex : null]
    );
    return result.rows[0];
}

async function completeStep(stepId, stepResult) {
    await query(
        `UPDATE agent_steps SET status = 'completed', result = $1, finished_at = $2 WHERE step_id = $3`,
        [JSON.stringify(stepResult), Math.floor(Date.now() / 1000), stepId]
    );
}

async function failStep(stepId, error) {
    await query(
        `UPDATE agent_steps SET status = 'failed', error = $1, finished_at = $2 WHERE step_id = $3`,
        [error, Math.floor(Date.now() / 1000), stepId]
    );
}

// ======================================================
// AI CALL UTILITY (no knowledge base)
// ======================================================

async function callAI(messages, options) {
    const model = options?.model || config.OPENROUTER_MODEL || 'qwen/qwen3.5-122b-a10b';

    let lastError = null;
    const attemptCount = options?.retries || STEP_RETRIES;
    for (let attempt = 1; attempt <= attemptCount; attempt++) {
        try {
            const response = await aiService.callAI(messages, {
                ...options,
                model,
                timeout: options?.timeout || 180000,
                maxTokens: options?.maxTokens || 2048,
            });
            const parsed = aiService.parseJsonResponse(response.content);
            return parsed;
        } catch (err) {
            lastError = err;
            console.warn(`[AGENT] AI call attempt ${attempt} failed: ${err.message}`);
            if (attempt < attemptCount) {
                const delay = 2000 * attempt;
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw new Error(`AI call failed after ${attemptCount} attempts: ${lastError?.message || 'unknown error'}`);
}

async function logConversation(sessionId, stepId, messages, responseContent) {
    const result = await query(
        `INSERT INTO agent_conversations (session_id, step_id, attempt) VALUES ($1, $2, 1) RETURNING *`,
        [sessionId, stepId]
    );
    const convId = result.rows[0].conversation_id;
    for (const msg of messages) {
        await query(
            `INSERT INTO agent_messages (conversation_id, role, content) VALUES ($1, $2, $3)`,
            [convId, msg.role, msg.content]
        );
    }
    if (responseContent) {
        await query(
            `INSERT INTO agent_messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)`,
            [convId, responseContent]
        );
    }
}

// ======================================================
// STEP 0: ANALYZE STRUCTURE (author, title, parts, chapters)
// ======================================================

async function stepAnalyzeStructure(sessionId, sourceText, stepIndex, progress) {
    const _progress = progress || (() => {});
    _progress({ stage: 'analyzing_structure', message: PROGRESS_STAGES.analyzing_structure });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.analyzing_structure });

    const step = await createStep(sessionId, 'analyze_structure', stepIndex || 0);

    // Send first ~50 lines for analysis
    const lines = sourceText.split('\n');
    const sampleLines = lines.slice(0, 80).join('\n');

    const messages = [
        { role: 'system', content: SYSTEM_PROMPTS.structure },
        { role: 'user', content: `Analyze the structure of this literary text. Extract author, title, parts, and chapters.\n\n\`\`\`\n${sampleLines}\n\`\`\`` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 2048 });
        // Validate structure
        const structure = {
            author: result.author || null,
            title: result.title || null,
            has_prologue: !!result.has_prologue,
            has_epilogue: !!result.has_epilogue,
            parts: Array.isArray(result.parts) ? result.parts : [],
            chapters: Array.isArray(result.chapters) ? result.chapters : [],
        };

        await logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, structure);
        console.log(`[AGENT] Step 0 (structure): author=${structure.author ? '✓' : '✗'}, title=${structure.title ? '✓' : '✗'}, ${structure.chapters.length} chapters, ${structure.parts.length} parts`);
        return structure;
    } catch (err) {
        await failStep(step.step_id, err.message);
        console.error(`[AGENT] Step 0 (structure) FAILED: ${err.message}`);
        // Return empty structure — LLM-only, no regex fallback
        return { author: null, title: null, has_prologue: false, has_epilogue: false, parts: [], chapters: [] };
    }
}

// ======================================================
// STRIP HEADER LINES from source text (for clean content)
// ======================================================
// Uses LLM-returned header_line text to find and remove metadata lines.
// Pure text matching — no regex heuristics.

function stripStructureFromText(sourceText, structure) {
    const lines = sourceText.split('\n');
    const linesToRemove = new Set();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Match author line
        if (structure.author && line === structure.author.trim()) {
            linesToRemove.add(i);
            continue;
        }

        // Match title line
        if (structure.title && line === structure.title.trim()) {
            linesToRemove.add(i);
            continue;
        }

        // Match part headers
        for (const part of structure.parts || []) {
            if (line === (part.name || '').trim()) {
                linesToRemove.add(i);
                break;
            }
        }

        // Match chapter header lines and title lines
        for (const ch of structure.chapters || []) {
            const hl = (ch.header_line || '').trim();
            if (!hl) continue;

            // header_line may contain newline (multi-line header)
            const headerParts = hl.split('\n').map(p => p.trim()).filter(Boolean);
            for (const part of headerParts) {
                if (line === part) {
                    linesToRemove.add(i);
                    break;
                }
            }

            // Also match chapter title separately (it follows the header)
            const chTitle = (ch.title || '').trim();
            if (chTitle && chTitle.length > 2 && line === chTitle && !linesToRemove.has(i)) {
                linesToRemove.add(i);
            }
        }
    }

    const cleanLines = lines.filter((_, i) => !linesToRemove.has(i));
    return cleanLines.join('\n').trim();
}

// ======================================================
// STEP 1: EXTRACT CHARACTERS
// ======================================================

async function stepExtractCharacters(sessionId, text, stepIndex, progress) {
    const _progress = progress || (() => {});
    _progress({ stage: 'extracting_chars', message: PROGRESS_STAGES.extracting_chars });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.extracting_chars });

    const step = await createStep(sessionId, 'analyze_characters', stepIndex || 0);

    const messages = [
        { role: 'system', content: SYSTEM_PROMPTS.characters },
        { role: 'user', content: `Extract all characters from this text:\n\n\`\`\`\n${text}\n\`\`\`` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 2048 });
        const characters = result.characters || [];
        await logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, characters);
        console.log(`[AGENT] Step 1 (characters): ${characters.length} extracted`);
        return characters;
    } catch (err) {
        await failStep(step.step_id, err.message);
        throw err;
    }
}

// ======================================================
// STEP 2: EXTRACT LOCATIONS
// ======================================================

async function stepExtractLocations(sessionId, text, characters, stepIndex, progress) {
    const _progress = progress || (() => {});
    _progress({ stage: 'extracting_locs', message: PROGRESS_STAGES.extracting_locs });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.extracting_locs });

    const step = await createStep(sessionId, 'analyze_locations', stepIndex || 0);

    const charsContext = (characters || []).map(c => `- ${c.id}: ${c.name} (${c.role || 'unknown'})`).join('\n') || 'No characters yet';
    const prompt = SYSTEM_PROMPTS.locations.replace('%EXISTING_CHARACTERS%', charsContext);

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Extract all locations from this text:\n\n\`\`\`\n${text}\n\`\`\`` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 1024 });
        const locations = result.locations || [];
        await logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, locations);
        console.log(`[AGENT] Step 2 (locations): ${locations.length} extracted`);
        return locations;
    } catch (err) {
        await failStep(step.step_id, err.message);
        throw err;
    }
}

// ======================================================
// STEP 3: CREATE SCENES
// ======================================================

async function stepCreateScenes(sessionId, text, characters, locations, stepIndex, progress) {
    const _progress = progress || (() => {});
    _progress({ stage: 'creating_scenes', message: PROGRESS_STAGES.creating_scenes });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.creating_scenes });

    const step = await createStep(sessionId, 'create_scenes', stepIndex || 0);

    const charsContext = (characters || []).map(c => `- ${c.id}: ${c.name}`).join('\n') || 'None';
    const locsContext = (locations || []).map(l => `- ${l.id}: ${l.name} (${l.type || 'unknown'})`).join('\n') || 'None';

    const prompt = SYSTEM_PROMPTS.scenes
        .replace('%EXISTING_CHARACTERS%', charsContext)
        .replace('%EXISTING_LOCATIONS%', locsContext);

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Split this text into scenes:\n\n\`\`\`\n${text}\n\`\`\`` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 6144 });
        const scenes = result.scenes || [];
        if (scenes.length === 0) throw new Error('AI returned no scenes');
        await logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, scenes);
        console.log(`[AGENT] Step 3 (scenes): ${scenes.length} created`);
        return scenes;
    } catch (err) {
        await failStep(step.step_id, err.message);
        throw err;
    }
}

// ======================================================
// STEP 4: CREATE UNITS (per scene)
// ======================================================

async function stepCreateUnits(sessionId, scene, sceneIndex, characters, stepIndex, progress) {
    const _progress = progress || (() => {});
    const msg = PROGRESS_STAGES.creating_units(sceneIndex);
    _progress({ stage: 'creating_units', message: msg });
    await updateSession(sessionId, { progress_msg: msg });

    const step = await createStep(sessionId, 'create_units', stepIndex || 0, sceneIndex);

    const sceneText = (scene.text || '').trim();
    const truncatedText = sceneText.length > 3000 ? sceneText.substring(0, 3000) + '...' : sceneText;
    const charsContext = (characters || []).map(c => `- ${c.id}: ${c.name}`).join('\n') || 'None';

    const prompt = SYSTEM_PROMPTS.units
        .replace('%SCENE_TEXT%', truncatedText)
        .replace('%EXISTING_CHARACTERS%', charsContext);

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Decompose this scene into visual units:\n\n\`\`\`\n${truncatedText}\n\`\`\`` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 2048 });
        const units = result.units || [];
        if (units.length === 0) {
            // Fallback: single unit with full text
            units.push({ text: sceneText, type: scene.type === 'dialogue' ? 'dialogue' : 'narration' });
        }
        await logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, units);
        console.log(`[AGENT] Step 4 (units scene ${sceneIndex}): ${units.length} units`);
        return units;
    } catch (err) {
        await failStep(step.step_id, `AI failed, using fallback: ${err.message}`);
        console.warn(`[AGENT] Step 4 (scene ${sceneIndex}) failed, using fallback: ${err.message}`);
        return [{ text: sceneText, type: scene.type === 'dialogue' ? 'dialogue' : 'perception' }];
    }
}

// ======================================================
// STEP 5: CREATE VISUAL PROMPTS (per scene)
// ======================================================

async function stepCreateVisuals(sessionId, scene, units, sceneIndex, characters, locations, stepIndex, progress) {
    const _progress = progress || (() => {});
    const msg = PROGRESS_STAGES.creating_visuals(sceneIndex);
    _progress({ stage: 'creating_visuals', message: msg });
    await updateSession(sessionId, { progress_msg: msg });

    const step = await createStep(sessionId, 'create_visual_prompts', stepIndex || 0, sceneIndex);

    // Build context for this scene
    const contextParts = [`Title: ${scene.title || 'Untitled'}`, `Type: ${scene.type || 'narration'}`, ''];
    contextParts.push('Characters in scene:');
    for (const pId of (scene.participants || [])) {
        const ch = (characters || []).find(c => c.id === pId);
        if (ch) contextParts.push(`- ${ch.id}: ${ch.name} — ${ch.description || ''}`);
    }
    if (scene.participants && scene.participants.length > 0 && contextParts.length <= 3) {
        contextParts.push('(unknown characters)');
    }
    const contextStr = contextParts.join('\n');

    const unitsStr = units.map((u, i) =>
        `Unit ${i + 1}: text="${(u.text || '').substring(0, 200)}", type="${u.type || 'perception'}"`
    ).join('\n');

    const prompt = SYSTEM_PROMPTS.visuals
        .replace('%CONTEXT%', contextStr)
        .replace('%UNITS%', unitsStr);

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Add visual prompts to each unit. Return the same units with visual fields added.\n\n${unitsStr}` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 2048 });
        const visualUnits = result.units || [];

        // Merge visual data back into original units
        const merged = units.map((u, i) => {
            const vu = visualUnits[i];
            if (vu && vu.visual) {
                return { ...u, visual: vu.visual };
            }
            // Fallback: generate a basic visual
            return {
                ...u,
                visual: {
                    shot: u.type === 'dialogue' ? 'medium' : (u.type === 'description' ? 'wide' : 'medium'),
                    prompt: getFallbackVisual(u.text, characters, scene),
                    character_binding: true,
                },
            };
        });

        await logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, merged);
        console.log(`[AGENT] Step 5 (visuals scene ${sceneIndex}): ${merged.length} units with visuals`);
        return merged;
    } catch (err) {
        await failStep(step.step_id, `AI failed, using fallback: ${err.message}`);
        console.warn(`[AGENT] Step 5 (scene ${sceneIndex}) failed, using fallback: ${err.message}`);
        return units.map((u) => ({
            ...u,
            visual: {
                shot: u.type === 'dialogue' ? 'medium' : 'wide',
                prompt: getFallbackVisual(u.text, characters, scene),
                character_binding: true,
            },
        }));
    }
}

function getFallbackVisual(text, characters, scene) {
    const charNames = (characters || []).map(c => c.name).join(', ') || 'character';
    const locationHint = scene.title || 'scene';
    const preview = (text || '').substring(0, 60).replace(/\n/g, ' ');
    return `${charNames} in ${locationHint}: ${preview}... cinematic shot`;
}

// ======================================================
// GET WINDOW TEXT — extract text for ~3 scenes
// ======================================================
// Uses currentOffset (absolute position in sourceText) as the source of truth.
// No arithmetic windowIndex-based positioning.
// Returns the next chunk of text starting from currentOffset.

function getWindowText(sourceText, existingChars, existingLocs, windowIndex, startOffset) {
    const chapters = lazyBook.splitIntoChapters(sourceText);

    // First window: compute startOffset from the first meaningful chapter
    if (startOffset === undefined || startOffset === null) {
        if (windowIndex === 0) {
            const firstChapter = lazyBook.firstMeaningfulChapter
                ? lazyBook.firstMeaningfulChapter(chapters, sourceText)
                : (chapters[0] || null);

            if (firstChapter) {
                const chStart = firstChapter.startOffset || 0;
                const chEnd = firstChapter.endOffset || sourceText.length;
                const chText = sourceText.substring(chStart, chEnd);
                const chLines = chText.split('\n');
                const chFirst = chLines[0]?.trim() || '';
                const headerLen = /^(?:глава|chapter|часть|part|пролог|prologue|эпилог|epilogue)/i.test(chFirst)
                    ? chLines[0].length + 1 : 0;
                startOffset = Math.min(chStart + headerLen, sourceText.length);
            } else {
                startOffset = 0;
            }
        } else {
            startOffset = 0;
        }
    }

    // End of text — nothing more to read
    if (startOffset >= sourceText.length) {
        const lastIdx = chapters.length > 0 ? chapters.length - 1 : 0;
        return {
            text: '',
            chapterIndex: lastIdx,
            remainingText: '',
            fullChapter: '',
            chapterTitle: chapters[lastIdx]?.title || null,
            currentOffset: startOffset,
        };
    }

    // Slice text from currentOffset
    let endPos = Math.min(startOffset + MAX_WINDOW_CHARS, sourceText.length);
    let windowText = sourceText.substring(startOffset, endPos);

    // Skip chapter header if startOffset lands at the beginning of one
    let skipLen = 0;
    const windowLines = windowText.split('\n');
    const firstLine = windowLines[0]?.trim() || '';
    if (/^(?:глава|chapter|часть|part|пролог|prologue|эпилог|epilogue)/i.test(firstLine)) {
        skipLen = windowLines[0].length + 1;
    }

    const actualStart = startOffset + skipLen;
    if (skipLen > 0 && actualStart < endPos) {
        windowText = sourceText.substring(actualStart, endPos);
    }

    // Try to break at a natural boundary if we reached the max size
    if (endPos < sourceText.length && (endPos - actualStart) >= MAX_WINDOW_CHARS) {
        const lastPeriod = windowText.lastIndexOf('.');
        const lastNewline = windowText.lastIndexOf('\n\n');
        const breakAt = Math.max(lastPeriod, lastNewline);
        if (breakAt > MAX_WINDOW_CHARS / 2) {
            windowText = windowText.substring(0, breakAt + 1).trim();
            endPos = actualStart + breakAt + 1;
        }
    }

    const newOffset = endPos;
    const remaining = sourceText.substring(newOffset).trim();

    // Find which chapter contains the actual reading position
    let chIdx = 0;
    for (let ci = 0; ci < chapters.length; ci++) {
        const chStart = chapters[ci].startOffset || 0;
        const chEnd = chapters[ci].endOffset || sourceText.length;
        if (actualStart >= chStart && actualStart < chEnd) {
            chIdx = ci;
            break;
        }
    }

    const chTitle = chapters[chIdx]?.title || null;

    console.log(`[WINDOW] getWindowText: startOffset=${startOffset}, skipLen=${skipLen}, actualStart=${actualStart}, endPos=${endPos}, newOffset=${newOffset}, chIdx=${chIdx}, chTitle="${chTitle}", textLen=${windowText.trim().length}, sourceLen=${sourceText.length}`);

    return {
        text: windowText.trim(),
        chapterIndex: chIdx,
        remainingText: remaining,
        fullChapter: windowText,
        chapterTitle: chTitle,
        currentOffset: newOffset,
    };
}

// ======================================================
// RUN FULL PIPELINE — execute all 5 steps for a text chunk
// ======================================================

async function runPipeline(sessionId, text, existingChars, existingLocs, stepIndex, progress) {
    const _progress = progress || (() => {});
    let characters = existingChars || [];
    let locations = existingLocs || [];

    // Step 1: Characters
    if (!existingChars || existingChars.length === 0) {
        characters = await stepExtractCharacters(sessionId, text, stepIndex, _progress);
        if (!characters || characters.length === 0) {
            console.warn('[AGENT] No characters extracted, continuing with empty set');
            characters = [{ id: 'unknown', name: 'Unknown', role: 'minor', description: 'Unidentified character' }];
        }
    } else {
        console.log(`[AGENT] Skipping characters step: ${existingChars.length} already known`);
    }

    // Step 2: Locations
    if (!existingLocs || existingLocs.length === 0) {
        locations = await stepExtractLocations(sessionId, text, characters, stepIndex, _progress);
        if (!locations || locations.length === 0) {
            console.warn('[AGENT] No locations extracted, continuing with empty set');
            locations = [{ id: 'unknown', name: 'Unknown', type: 'outdoor', description: 'Unspecified location' }];
        }
    } else {
        console.log(`[AGENT] Skipping locations step: ${existingLocs.length} already known`);
    }

    // Step 3: Scenes
    const scenes = await stepCreateScenes(sessionId, text, characters, locations, stepIndex, _progress);
    if (!scenes || scenes.length === 0) throw new Error('AI returned no scenes');

    // Take only WINDOW_SIZE scenes
    const windowScenes = scenes.slice(0, WINDOW_SIZE);

    // Step 4+5: Units and Visuals (per scene)
    const enrichedScenes = [];
    for (let si = 0; si < windowScenes.length; si++) {
        const scene = windowScenes[si];

        // Step 4: Units
        const units = await stepCreateUnits(sessionId, scene, si, characters, stepIndex, _progress);

        // Step 5: Visuals
        const visualUnits = await stepCreateVisuals(sessionId, scene, units, si, characters, locations, stepIndex, _progress);

        enrichedScenes.push({
            ...scene,
            units: visualUnits,
        });
    }

    return { characters, locations, scenes: enrichedScenes, allScenes: scenes };
}

// ======================================================
// BOOTSTRAP — create book with first window
// ======================================================

async function bootstrapWithAgent(bookId, progress) {
    const _progress = progress || (() => {});
    const draft = lazyBook.loadDraftBook(bookId);
    if (!draft || !draft.sourceText) throw new Error(`Book ${bookId} not found`);

    if (draft.manifest?.state === lazyBook.BookState.BOOTSTRAPPED) {
        console.log(`[AGENT] ${bookId} already BOOTSTRAPPED, skipping`);
        return { bookId, state: lazyBook.BookState.BOOTSTRAPPED };
    }

    if (!config.OPENROUTER_API_KEY) {
        throw new Error('AI assistant is not available — cannot import book');
    }

    // Create session
    const session = await createSession(bookId, 'txt_import');
    const sessionId = session.session_id;
    console.log(`[AGENT] Session ${sessionId} created for book ${bookId}`);

    try {
        // Get text for first window FIRST (before any AI calls)
        // This way stepAnalyzeStructure uses only the first window text (~4K chars),
        // not the entire source text (up to 762K+ chars).
        // Per architectural-essence.md: knowledge grows progressively as we read.
        const windowInfo = getWindowText(draft.sourceText, [], [], 0);
        console.log(`[FIRST-WINDOW] currentOffset=${windowInfo.currentOffset}, chapterIndex=${windowInfo.chapterIndex}, chapterTitle="${windowInfo.chapterTitle}", textLen=${windowInfo.text.length}`);

        // STEP 0: Analyze structure (author, title, parts, chapters) — first window only
        _progress({ stage: 'analyzing_structure', message: PROGRESS_STAGES.analyzing_structure });
        const structure = await stepAnalyzeStructure(sessionId, windowInfo.text, 0, _progress);

        // stripStructureFromText is intentionally NOT applied here.
        // Both bootstrapWithAgent and bootstrapNextWindow must use the same
        // draft.sourceText so that currentOffset stays consistent.

        // Update book metadata with author/title
        if (structure.author || structure.title) {
            _progress({ stage: 'saving', message: `⟳ Обновляю метаданные: ${structure.title ? `«${structure.title}»` : ''} ${structure.author ? `(${structure.author})` : ''}` });
            const bookDir = lazyBook.getBookDir(bookId);
            const bp = lazyBook.getBookMetaPath(bookDir);
            const fs_local = require('fs');
            if (fs_local.existsSync(bp)) {
                const bookMeta = JSON.parse(fs_local.readFileSync(bp, 'utf8'));
                if (structure.author) bookMeta.author = structure.author;
                if (structure.title) bookMeta.title = structure.title;
                if (structure.parts && structure.parts.length > 0) {
                    bookMeta.structure.has_prologue = !!structure.has_prologue;
                    bookMeta.structure.has_epilogue = !!structure.has_epilogue;
                    bookMeta.structure.parts = structure.parts;
                }
                fs_local.writeFileSync(bp, JSON.stringify(bookMeta, null, 2));
                console.log(`[AGENT] Book metadata updated: author=${structure.author}, title=${structure.title}`);
            }
        }
        if (!windowInfo.text || !windowInfo.text.trim()) {
            throw new Error('No text to analyze in first window');
        }

        _progress({ stage: 'extracting_chars', message: '⟳ Анализирую текст: извлекаю персонажей и локации...' });
        await updateSession(sessionId, {
            progress_msg: '⟳ Анализирую текст: извлекаю персонажей и локации...',
        });

        // Run all 5 steps (stepIndex = 0 for first window)
        const result = await runPipeline(sessionId, windowInfo.text, [], [], 0, _progress);

        if (result.scenes.length === 0) {
            throw new Error('AI returned no scenes — cannot create book');
        }

        const extraScenes = result.allScenes.slice(WINDOW_SIZE);

        // Store window data for next-window continuation
        // currentOffset is the absolute source text position — the single source of truth
        const windowData = {
            window_index: 0,
            chapter_title: windowInfo.chapterTitle,
            chapter_index: windowInfo.chapterIndex,
            total_scenes: result.allScenes.length,
            created_scenes: result.scenes.length,
            remaining_scenes: extraScenes,
            remaining_text: windowInfo.remainingText,
            currentOffset: windowInfo.currentOffset,
            all_characters: result.characters,
            all_locations: result.locations,
            structure: structure,
        };

        await updateSession(sessionId, {
            window_data: JSON.stringify(windowData),
            progress_msg: `Создано ${result.scenes.length} сцен, ${result.characters.length} персонажей, ${result.locations.length} локаций`,
        });

        // Build book structure
        _progress({ stage: 'saving', message: '⟳ Сохраняю структуру книги...' });

        const chapterTitle = windowInfo.chapterTitle
            ? (/^(?:глава|chapter|часть|part|пролог|prologue|эпилог|epilogue)/i.test(windowInfo.chapterTitle)
                ? windowInfo.chapterTitle
                : `Глава 1: ${windowInfo.chapterTitle}`)
            : 'Глава 1';

        const bookResult = lazyBook.createFromAnalysis(bookId, {
            characters: result.characters,
            locations: result.locations,
            scenes: result.scenes,
            chapterTitle: chapterTitle,
            maxScenes: WINDOW_SIZE,
            structure: structure,
        });

        const hasMoreText = !!windowInfo.remainingText;
        const allDone = extraScenes.length === 0 && !hasMoreText;

        _progress({ stage: 'done', message: `✓ Импорт завершён: ${result.scenes.length} сцен, ${result.characters.length} персонажей, ${result.locations.length} локаций` });

        await updateSession(sessionId, {
            status: allDone ? 'completed' : 'paused',
            progress_msg: allDone
                ? `Окно 1 готово: ${result.scenes.length} сцен. Всего найдено: ${result.allScenes.length}`
                : `⟳ Окно 1: ${result.scenes.length} сцен. Обрабатываю следующие окна...`,
        });

        return {
            ...bookResult,
            session_id: sessionId,
            total_scenes_found: result.allScenes.length,
            remaining_scenes: extraScenes.length,
            has_more: !allDone,
        };
    } catch (err) {
        console.error(`[AGENT] Bootstrap failed: ${err.message}`);
        await updateSession(sessionId, {
            status: 'failed',
            progress_msg: `Ошибка: ${err.message}`,
        }).catch(() => {});
        _progress({ stage: 'error', message: `✗ Ошибка: ${err.message}` });
        throw err;
    }
}

// ======================================================
// NEXT WINDOW — process additional scenes
// ======================================================

async function bootstrapNextWindow(bookId, progress) {
    const _progress = progress || (() => {});
    const draft = lazyBook.loadDraftBook(bookId);
    if (!draft || !draft.sourceText) throw new Error(`Book ${bookId} not found`);

    if (!config.OPENROUTER_API_KEY) {
        throw new Error('AI assistant is not available');
    }

    // Find existing session
    const sessionResult = await query(
        `SELECT * FROM agent_sessions WHERE book_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [bookId]
    );
    const session = sessionResult.rows[0];
    if (!session) throw new Error(`No session found for book ${bookId}`);

    const sessionId = session.session_id;

    try {
    let windowData = session.window_data
        ? (typeof session.window_data === 'string' ? JSON.parse(session.window_data) : session.window_data)
        : null;

    // Mark session as running so /agent-status returns active:true during processing
    await updateSession(sessionId, { status: 'running' });

    // Check if we have cached remaining scenes
    if (windowData && windowData.remaining_scenes && windowData.remaining_scenes.length > 0) {
        _progress({ stage: 'saving', message: '⟳ Добавляю сцены из кэша...' });

        const scenesToAdd = windowData.remaining_scenes.slice(0, WINDOW_SIZE);
        const newRemaining = windowData.remaining_scenes.slice(WINDOW_SIZE);
        const existingChars = windowData.all_characters || [];
        const existingLocs = windowData.all_locations || [];
        const nextWindowIndex = (windowData?.window_index || 0) + 1;

        // For cached scenes, generate units and visuals if missing
        const scenesNeedingUnits = scenesToAdd.filter(s => !s.units || s.units.length === 0);

        let enrichedScenes;
        if (scenesNeedingUnits.length > 0) {
            _progress({ stage: 'creating_units', message: '⟳ Создаю юниты и visual prompts для кэшированных сцен...' });
            enrichedScenes = [];
            for (let si = 0; si < scenesToAdd.length; si++) {
                const scene = scenesToAdd[si];
                if (!scene.units || scene.units.length === 0) {
                    const units = await stepCreateUnits(sessionId, scene, si, existingChars, nextWindowIndex, _progress);
                    const visualUnits = await stepCreateVisuals(sessionId, scene, units, si, existingChars, existingLocs, nextWindowIndex, _progress);
                    enrichedScenes.push({ ...scene, units: visualUnits });
                } else {
                    enrichedScenes.push(scene);
                }
            }
        } else {
            enrichedScenes = scenesToAdd;
        }

        const nextChapterIndex = windowData.chapter_index || 0;
        const chapterTitle = windowData.chapter_title || `Глава ${nextChapterIndex + 1}`;

        const bookResult = lazyBook.appendToBook(bookId, {
            characters: existingChars,
            locations: existingLocs,
            scenes: enrichedScenes,
            chapterTitle: chapterTitle,
            chapterIndex: nextChapterIndex,
            structure: windowData?.structure || null,
        });

        const newWindowIndex = (windowData.window_index || 0) + 1;
        const updatedWindowData = {
            ...windowData,
            window_index: newWindowIndex,
            created_scenes: (windowData.created_scenes || 0) + enrichedScenes.length,
            remaining_scenes: newRemaining,
        };

        await updateSession(sessionId, {
            window_data: JSON.stringify(updatedWindowData),
            progress_msg: `Окно ${newWindowIndex + 1}: добавлено ${enrichedScenes.length} сцен. Осталось: ${newRemaining.length} кэшированных`,
        });

        const allDone = newRemaining.length === 0 && !windowData.remaining_text;
        if (allDone) {
            await updateSession(sessionId, {
                status: 'completed',
                progress_msg: 'Импорт завершён — все сцены обработаны',
            });
            lazyBook.updateBookState(bookId, lazyBook.BookState.ACTIVE);
        } else {
            await updateSession(sessionId, { status: 'paused' });
        }

        _progress({ stage: 'done', message: `✓ Добавлено ${enrichedScenes.length} сцен из кэша. Всего: ${updatedWindowData.created_scenes}` });

        return {
            ...bookResult,
            session_id: sessionId,
            cached: true,
            added_scenes: enrichedScenes.length,
            remaining_cached: newRemaining.length,
            all_done: allDone,
        };
    }

    // Need to process more source text
    const nextWindowIndex = (windowData?.window_index || 0) + 1;
    const existingChars = windowData?.all_characters || [];
    const existingLocs = windowData?.all_locations || [];
    const readingOffset = windowData?.currentOffset;

    console.log(`[NEXT-WINDOW] windowData: window_index=${windowData?.window_index}, chapter_index=${windowData?.chapter_index}, remaining_scenes=${windowData?.remaining_scenes?.length || 0}, currentOffset=${readingOffset}, sourceText.length=${draft.sourceText.length}`);

    const windowInfo = getWindowText(draft.sourceText, existingChars, existingLocs, nextWindowIndex, readingOffset);
    if (!windowInfo.text || !windowInfo.text.trim()) {
        await updateSession(sessionId, {
            status: 'completed',
            progress_msg: 'Весь текст обработан',
        });
        lazyBook.updateBookState(bookId, lazyBook.BookState.ACTIVE);
        _progress({ stage: 'done', message: '✓ Весь текст обработан' });
        return { bookId, all_done: true, session_id: sessionId };
    }

    _progress({ stage: 'extracting_chars', message: `⟳ Анализирую следующую часть текста (окно ${nextWindowIndex + 1})...` });
    await updateSession(sessionId, {
        progress_msg: `⟳ Анализирую следующую часть текста через AI (окно ${nextWindowIndex + 1})...`,
    });

    // Run full pipeline with existing context (stepIndex = windowIndex)
    const result = await runPipeline(sessionId, windowInfo.text, existingChars, existingLocs, nextWindowIndex, _progress);

    if (result.scenes.length === 0) {
        throw new Error('AI returned no scenes for this window');
    }

    const extraScenes = result.allScenes.slice(WINDOW_SIZE);

    // Merge characters (by id)
    const existingIds = new Set(existingChars.map(c => c.id));
    const mergedChars = [...existingChars];
    for (const ch of result.characters || []) {
        if (!existingIds.has(ch.id)) {
            mergedChars.push(ch);
            existingIds.add(ch.id);
        }
    }

    // Merge locations (by id)
    const existingLocIds = new Set(existingLocs.map(l => (typeof l === 'string' ? l : l.id)));
    const mergedLocs = [...existingLocs];
    for (const loc of result.locations || []) {
        const locId = typeof loc === 'string' ? loc : loc.id;
        if (!existingLocIds.has(locId)) {
            mergedLocs.push(loc);
            existingLocIds.add(locId);
        }
    }

    // Append scenes to existing book
    _progress({ stage: 'saving', message: '⟳ Добавляю сцены в книгу...' });

    const nextChapterIndex = windowInfo.chapterIndex || 0;
    const chapterTitle = windowInfo.chapterTitle
        ? (/^(?:глава|chapter|часть|part|пролог|prologue|эпилог|epilogue)/i.test(windowInfo.chapterTitle)
            ? windowInfo.chapterTitle
            : `Глава ${nextChapterIndex + 1}: ${windowInfo.chapterTitle}`)
        : `Глава ${nextChapterIndex + 1}`;

    const bookResult = lazyBook.appendToBook(bookId, {
        characters: mergedChars,
        locations: mergedLocs,
        scenes: result.scenes,
        chapterTitle: chapterTitle,
        chapterIndex: nextChapterIndex,
        structure: windowData?.structure || null,
    });

    const updatedWindowData = {
        window_index: nextWindowIndex,
        chapter_title: windowInfo.chapterTitle,
        chapter_index: nextChapterIndex,
        total_scenes: result.allScenes.length,
        created_scenes: (windowData?.created_scenes || 0) + result.scenes.length,
        remaining_scenes: extraScenes,
        remaining_text: windowInfo.remainingText,
        currentOffset: windowInfo.currentOffset,
        all_characters: mergedChars,
        all_locations: mergedLocs,
    };

    const allDone = extraScenes.length === 0 && !windowInfo.remainingText;
    await updateSession(sessionId, {
        window_data: JSON.stringify(updatedWindowData),
        progress_msg: `Окно ${nextWindowIndex + 1}: добавлено ${result.scenes.length} сцен. Осталось: ${extraScenes.length} кэшированных`,
        status: allDone ? 'completed' : 'paused',
    });

    if (allDone) {
        lazyBook.updateBookState(bookId, lazyBook.BookState.ACTIVE);
    }

    _progress({ stage: 'done', message: `✓ Окно ${nextWindowIndex + 1}: ${result.scenes.length} сцен. Всего: ${updatedWindowData.created_scenes}` });

    return {
        ...bookResult,
        session_id: sessionId,
        cached: false,
        added_scenes: result.scenes.length,
        remaining_cached: extraScenes.length,
        all_done: allDone,
    };
    } catch (err) {
        console.error(`[AGENT] bootstrapNextWindow failed: ${err.message}`);
        await updateSession(sessionId, {
            status: 'failed',
            progress_msg: `Ошибка: ${err.message}`,
        }).catch(() => {});
        _progress({ stage: 'error', message: `✗ Ошибка: ${err.message}` });
        throw err;
    }
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    createSession,
    updateSession,
    getSession,
    loadKnowledgeBase: require('./knowledge-base').loadKnowledgeBase,
    bootstrapWithAgent,
    bootstrapNextWindow,
    PROGRESS_STAGES,
    WINDOW_SIZE,
};
