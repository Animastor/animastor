const { query } = require('../storage/postgres/database');
const config = require('../config/runtime-config');
const lazyBook = require('../book/lazy-book');
const aiService = require('./ai-service');
const {
    createSession, updateSession, getSession,
    createStep, completeStep, failStep,
} = require('./agent-session');
const {
    PROGRESS_STAGES, WINDOW_SIZE, MAX_WINDOW_CHARS, STEP_RETRIES, SYSTEM_PROMPTS,
    SCENE_TARGET_SEC, SCENE_MAX_SEC, SCENE_MIN_SEC, MAX_SCENES_PER_CHUNK,
} = require('./agent-prompts');
const sourceCoverage = require('./source-coverage');
const { estimateSpeechDurationSec } = require('./placeholder-audio');

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

async function stepAnalyzeStructure(sessionId, sourceText, stepIndex, progress) {
    const _progress = progress || (() => {});
    _progress({ stage: 'analyzing_structure', message: PROGRESS_STAGES.analyzing_structure });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.analyzing_structure });

    const step = await createStep(sessionId, 'analyze_structure', stepIndex || 0);

    const lines = sourceText.split('\n');
    const sampleLines = lines.slice(0, 80).join('\n');

    const messages = [
        { role: 'system', content: SYSTEM_PROMPTS.structure },
        { role: 'user', content: `Analyze the structure of this literary text. Extract author, title, parts, and chapters.\n\n\`\`\`\n${sampleLines}\n\`\`\`` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 4096 });
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
        return { author: null, title: null, has_prologue: false, has_epilogue: false, parts: [], chapters: [] };
    }
}

function stripStructureFromText(sourceText, structure) {
    const lines = sourceText.split('\n');
    const linesToRemove = new Set();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        if (structure.author && line === structure.author.trim()) {
            linesToRemove.add(i);
            continue;
        }

        if (structure.title && line === structure.title.trim()) {
            linesToRemove.add(i);
            continue;
        }

        for (const part of structure.parts || []) {
            if (line === (part.name || '').trim()) {
                linesToRemove.add(i);
                break;
            }
        }

        for (const ch of structure.chapters || []) {
            const hl = (ch.header_line || '').trim();
            if (!hl) continue;

            const headerParts = hl.split('\n').map(p => p.trim()).filter(Boolean);
            for (const part of headerParts) {
                if (line === part) {
                    linesToRemove.add(i);
                    break;
                }
            }

            const chTitle = (ch.title || '').trim();
            if (chTitle && chTitle.length > 2 && line === chTitle && !linesToRemove.has(i)) {
                linesToRemove.add(i);
            }
        }
    }

    const cleanLines = lines.filter((_, i) => !linesToRemove.has(i));
    return cleanLines.join('\n').trim();
}

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
        const result = await callAI(messages, { maxTokens: 4096 });
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
        const result = await callAI(messages, { maxTokens: 4096 });
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

async function stepCreateScenes(sessionId, text, characters, locations, stepIndex, progress, repairHint) {
    const _progress = progress || (() => {});
    _progress({ stage: 'creating_scenes', message: PROGRESS_STAGES.creating_scenes });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.creating_scenes });

    const step = await createStep(sessionId, 'create_scenes', stepIndex || 0);

    const charsContext = (characters || []).map(c => `- ${c.id}: ${c.name}`).join('\n') || 'None';
    const locsContext = (locations || []).map(l => `- ${l.id}: ${l.name} (${l.type || 'unknown'})`).join('\n') || 'None';

    // Include reference examples from knowledge base to guide scene splitting
    const examplesContext = formatExamplesForPrompt();
    const examplesSection = examplesContext
        ? `\n## Reference examples\n${examplesContext}\n`
        : '';

    const prompt = SYSTEM_PROMPTS.scenes
        .replace('%EXISTING_CHARACTERS%', charsContext)
        .replace('%EXISTING_LOCATIONS%', locsContext)
        .replace('%REFERENCE_EXAMPLES%', examplesSection);

    let repairText = '';
    if (repairHint) {
        if (repairHint.duration_preview) {
            // Duration repair: coverage was OK but some scenes are too long.
            repairText = `\n\nThe previous scene split was too long in places.\nReason: ${repairHint.reason || 'duration_exceeded'}.\nThese scenes exceed the ~30s (~95 word) hard limit and must be split into smaller scenes, each ending on a complete sentence and covering ~20s (~65 words):\n${repairHint.duration_preview}\nReturn a corrected split from the START of the same text, verbatim and in order, with no gaps or overlaps between returned scenes. Return at most 3 scenes and stop after scene 3; unused tail text is allowed.`;
        } else {
            // Coverage repair: scenes did not cover the source without gaps.
            repairText = `\n\nPrevious scene split failed source coverage validation.\nReason: ${repairHint.reason || 'unknown'}.\nMissing or problematic source fragment:\n\`\`\`\n${repairHint.gap_preview || ''}\n\`\`\`\nReturn a corrected split that starts at the first narrative word and covers a contiguous prefix of the provided text without gaps. Return at most 3 scenes and stop after scene 3; unused tail text is allowed.`;
        }
    }

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Split this text into scenes:\n\n\`\`\`\n${text}\n\`\`\`${repairText}` },
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

/**
 * Load ALL examples from ai/examples/ and return as a formatted string
 * suitable for inclusion in system prompts. Dynamically detects each
 * example's structure — no hardcoded filenames required.
 *
 * Detected structures:
 *   - Book-like (has .result.chapters[].scenes): shows scene splitting
 *   - Scene-like (has .scene with .units): shows single scene breakdown
 *   - Generic: shows a JSON summary
 */
function formatExamplesForPrompt() {
    try {
        const examples = require('./ai-loader').getExamples();
        if (!examples || Object.keys(examples).length === 0) return '';

        const parts = [];

        for (const [name, data] of Object.entries(examples)) {
            // Book-like structure: { result: { chapters: [{ scenes: [...] }] } }
            const bookScenes = data?.result?.chapters?.[0]?.scenes;
            if (Array.isArray(bookScenes) && bookScenes.length > 0) {
                parts.push(`--- Example: \"${name}\" — book structure ---`);
                for (const sc of bookScenes) {
                    const textLen = (sc.text || sc.audio?.full_text || '').length;
                    const participants = (sc.participants || []).join(', ') || 'none';
                    parts.push(`  Scene "${sc.title || sc.scene_title || 'untitled'}" (${sc.type || 'unknown'}): ${textLen} chars, participants: ${participants}`);
                }
                parts.push(`  (Total: ${bookScenes.length} scenes for this chapter)\n`);
                continue;
            }

            // Scene-like structure: has .scene or .scenes array with units
            const sceneData = data?.scene || data?.scenes?.[0];
            if (sceneData && (sceneData.units || sceneData.audio)) {
                parts.push(`--- Example: \"${name}\" — scene structure ---`);
                const title = sceneData.scene_title || sceneData.title || 'untitled';
                parts.push(`  Title: \"${title}\" (${sceneData.type || 'unknown'})`);
                if (sceneData.location?.id) {
                    parts.push(`  Location: ${sceneData.location.id}`);
                }
                if (sceneData.participants?.length) {
                    parts.push(`  Participants: ${sceneData.participants.join(', ')}`);
                }
                const textLen = (sceneData.text || sceneData.audio?.full_text || '').length;
                parts.push(`  Text length: ${textLen} chars`);
                const units = sceneData.units || [];
                if (units.length > 0) {
                    parts.push(`  Units: ${units.length} visual units`);
                }
                parts.push('');
                continue;
            }

            // Generic fallback: just mention the file exists
            const keys = Object.keys(data || {});
            parts.push(`--- Example: \"${name}\" — ${keys.length > 0 ? `${keys.length} top-level key(s)` : 'empty'} ---`);
        }

        return parts.join('\n');
    } catch (err) {
        console.warn(`[AGENT] Failed to load examples for prompt: ${err.message}`);
        return '';
    }
}

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
        const result = await callAI(messages, { maxTokens: 4096 });
        const units = result.units || [];
        if (units.length === 0) {
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

/**
 * Build a compact few-shot block of REAL doctrine-compliant visual prompts, drawn
 * from ai/examples. Shows the model a sequence of adjacent units where the base
 * composition (who + where + arrangement) is repeated and only the action changes.
 * Single source of truth: the examples folder — no hardcoded exemplars to drift.
 * Returns '' if no suitable multi-unit narration scene with named participants exists.
 */
function buildVisualExemplars() {
    try {
        const examples = require('./ai-loader').getExamples();
        if (!examples) return '';

        let best = null; // { participants:[], lines:[{shot,prompt}] }
        for (const data of Object.values(examples)) {
            const scenes = data?.scenes || (data?.scene ? [data.scene] : []);
            for (const sc of scenes) {
                const parts = sc?.participants || [];
                if (!parts.length) continue; // want NAMED participants, skip typography/cover
                const lines = (sc.units || [])
                    .map(u => u.visual)
                    .filter(v => v && typeof v.prompt === 'string' && v.prompt.trim())
                    .map(v => ({ shot: v.shot || 'medium', prompt: v.prompt.trim() }));
                if (lines.length >= 3 && (!best || lines.length > best.lines.length)) {
                    best = { participants: parts, lines: lines.slice(0, 4) };
                }
            }
        }
        if (!best) return '';

        const rows = best.lines
            .map((l, i) => `  Unit ${i + 1} (${l.shot}): ${l.prompt}`)
            .join('\n');
        return `\n## Worked example (real doctrine-compliant sequence — note how the base composition repeats and only the action changes)\nParticipants named every time: ${best.participants.join(', ')}\n${rows}\n`;
    } catch (err) {
        console.warn(`[AGENT] Failed to build visual exemplars: ${err.message}`);
        return '';
    }
}

async function stepCreateVisuals(sessionId, scene, units, sceneIndex, characters, locations, stepIndex, progress) {
    const _progress = progress || (() => {});
    const msg = PROGRESS_STAGES.creating_visuals(sceneIndex);
    _progress({ stage: 'creating_visuals', message: msg });
    await updateSession(sessionId, { progress_msg: msg });

    const step = await createStep(sessionId, 'create_visual_prompts', stepIndex || 0, sceneIndex);

    const locName = scene.location?.id || scene.title || 'the scene location';
    const contextParts = [`Title: ${scene.title || 'Untitled'}`, `Type: ${scene.type || 'narration'}`, `Location (name to use in prompts): ${locName}`, ''];
    contextParts.push('Characters in scene (name them explicitly in every prompt — no pronouns):');
    const anchors = scene.character_anchors || {};
    let namedCount = 0;
    for (const pId of (scene.participants || [])) {
        const ch = (characters || []).find(c => c.id === pId);
        if (!ch) continue;
        const a = anchors[pId];
        const arrangement = a
            ? ` [position: ${a.position || '?'}, pose: ${a.pose || '?'}, orientation: ${a.orientation || '?'}]`
            : '';
        contextParts.push(`- ${ch.id}: ${ch.name} — ${ch.description || ''}${arrangement}`);
        namedCount++;
    }
    if (scene.participants && scene.participants.length > 0 && namedCount === 0) {
        contextParts.push('(unknown characters)');
    }
    const contextStr = contextParts.join('\n');

    const unitsStr = units.map((u, i) =>
        `Unit ${i + 1}: text="${(u.text || '').substring(0, 200)}", type="${u.type || 'perception'}"`
    ).join('\n');

    const prompt = SYSTEM_PROMPTS.visuals
        .replace('%CONTEXT%', contextStr)
        .replace('%EXAMPLES%', buildVisualExemplars())
        .replace('%UNITS%', unitsStr);

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Add visual prompts to each unit. Return the same units with visual fields added.\n\n${unitsStr}` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 4096 });
        const visualUnits = result.units || [];

        const merged = units.map((u, i) => {
            const vu = visualUnits[i];
            if (vu && vu.visual) {
                return { ...u, visual: vu.visual };
            }
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
    // Self-contained Imagination Unit fallback: name every participant explicitly
    // (no pronouns) and anchor them to the global location. Deliberately omits the
    // raw text preview, which can carry pronouns and plot the model cannot draw.
    const participants = (scene.participants || []);
    const named = participants.length
        ? participants
              .map(pId => (characters || []).find(c => c.id === pId)?.name || pId)
              .join(' and ')
        : ((characters || []).map(c => c.name).join(' and '));
    const who = named || 'the scene';
    const locName = scene.location?.id || scene.title || 'the scene location';
    return `${who} at ${locName}, cinematic shot`;
}

function splitTextEvenlyByParagraphs(text, maxScenes) {
    const paragraphRe = /\S[\s\S]*?(?=\n\s*\n|$)/g;
    const paragraphs = [];
    let match;
    while ((match = paragraphRe.exec(text || '')) !== null) {
        const raw = match[0];
        const start = match.index + (raw.match(/^\s*/)?.[0].length || 0);
        const trimmed = raw.trim();
        if (trimmed) {
            paragraphs.push({
                start,
                end: start + trimmed.length,
            });
        }
        if (match.index === paragraphRe.lastIndex) paragraphRe.lastIndex++;
    }

    if (paragraphs.length === 0) return [];
    if (paragraphs.length <= maxScenes) {
        return paragraphs.map(p => text.slice(p.start, p.end));
    }

    const scenes = [];
    let current = [];
    const targetChars = Math.ceil(text.length / maxScenes);

    for (const p of paragraphs) {
        const currentStart = current[0]?.start ?? p.start;
        const currentEnd = current[current.length - 1]?.end ?? p.end;
        const currentLen = currentEnd - currentStart;
        if (current.length > 0 && scenes.length < maxScenes - 1 && currentLen + (p.end - p.start) > targetChars) {
            scenes.push(text.slice(currentStart, currentEnd).trim());
            current = [p];
        } else {
            current.push(p);
        }
    }

    if (current.length > 0) {
        scenes.push(text.slice(current[0].start, current[current.length - 1].end).trim());
    }
    return scenes;
}

// Split text into sentences, preserving trailing terminal punctuation and any
// closing quote/bracket. Hard paragraph breaks (\n\n) also end a sentence.
// Returns verbatim sentence chunks (whitespace between them is dropped but is
// re-tolerated by coverage, which ignores inter-scene whitespace).
function splitIntoSentences(text) {
    return splitIntoSentencesWithOffsets(text).map(s => s.text);
}

// Like splitIntoSentences but preserves original character offsets, enabling
// the caller to reconstruct verbatim slices of the original text.
// Returns [{ text, start, end }] where start/end are positions in the input.
function splitIntoSentencesWithOffsets(text) {
    const t = String(text || '');
    const sentences = [];
    let start = 0;
    for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        const isTerminal = ch === '.' || ch === '!' || ch === '?' || ch === '\u2026';
        const isHardBreak = ch === '\n' && t[i + 1] === '\n';
        if (isTerminal) {
            // Consume any run of terminal punctuation + trailing closing quotes.
            let j = i + 1;
            while (j < t.length && /[.!?\u2026"'»\u201d)\]]/.test(t[j])) j++;
            const raw = t.slice(start, j);
            if (raw.trim()) sentences.push({ text: raw.trim(), start, end: j });
            start = j;
            i = j - 1;
        } else if (isHardBreak) {
            const raw = t.slice(start, i);
            if (raw.trim()) sentences.push({ text: raw.trim(), start, end: i });
            start = i + 1;
        }
    }
    const tail = t.slice(start);
    if (tail.trim()) sentences.push({ text: tail.trim(), start, end: t.length });
    return sentences;
}

/**
 * Extract a meaningful scene title from the scene's text content.
 * Used as a fallback when the AI doesn't provide a proper title or when
 * deterministic fallback splitting is used (buildFallbackScenes).
 *
 * Strategy:
 *   1. Take the first sentence of the scene text
 *   2. Clean leading dialogue markers / quotes
 *   3. Limit to ~8 words for a concise, readable title
 *
 * @param {string} sceneText - The full text of the scene
 * @param {number} fallbackIndex - 0-based index used if text is empty
 * @returns {string} A readable scene title
 */
function extractSceneTitle(sceneText, fallbackIndex) {
    const t = (sceneText || '').trim();
    if (!t) return `Scene ${fallbackIndex + 1}`;

    let title = t;

    // For dialogue-starting scenes, use the first speech line
    if (/^[—–\-]/.test(t)) {
        const newlinePos = t.indexOf('\n');
        const firstLine = newlinePos > 0 ? t.substring(0, newlinePos) : t;
        title = firstLine.replace(/^[—–\-\s"]+/, '').replace(/["»]+$/, '').trim();
    } else {
        // For narration, take first sentence
        // Prefer . ! ? over … to avoid mid-sentence ellipsis splits.
        const dotEnd = t.search(/[.!?](?:\s|$)/);
        const sentenceEnd = dotEnd >= 0 ? dotEnd : t.search(/…(?:\s|$)/);
        if (sentenceEnd > 3) {
            title = t.substring(0, sentenceEnd + 1);
        }
        title = title.replace(/^[—–\-\s"]+/, '').replace(/[.!?…]+$/, '').trim();
    }

    // Limit to ~8 words for a concise title
    const words = title.split(/\s+/).filter(Boolean);
    if (words.length > 8) {
        title = words.slice(0, 8).join(' ');
        if (title.length < t.length) title += '…';
    }

    // Capitalise first letter
    title = title.charAt(0).toUpperCase() + title.slice(1);

    return title || `Scene ${fallbackIndex + 1}`;
}

/**
 * Check whether a scene title is generic / auto-generated (e.g. "Scene 1", "Scene 2")
 * and should be replaced with a proper extracted title.
 * Also catches empty titles or very short placeholder strings.
 */
function isGenericSceneTitle(title) {
    if (!title) return true;
    const trimmed = title.trim();
    if (trimmed.length < 3) return true;
    // Match patterns like "Scene 1", "Сцена 1", "Scene", "Сцена"
    if (/^(Scene|Сцена|Chapter|Глава|Part|Часть)\s*\d*$/i.test(trimmed)) return true;
    return false;
}

// Deterministic fallback splitter used only when the LLM split fails source
// coverage. Groups whole sentences into ~SCENE_TARGET_SEC scenes, never
// exceeding ~SCENE_MAX_SEC unless a single sentence alone is longer (then it
// becomes its own scene). Every scene ends on a complete sentence, and the
// scenes are consecutive verbatim slices → source coverage passes by
// construction. Falls back to paragraph-even splitting only if no sentence
// boundaries are found at all.
function buildFallbackScenes(sceneText) {
    // Use offset-annotated sentences so each scene's text is a verbatim slice
    // of the original sceneText (preserving all original whitespace between
    // sentences, including paragraph breaks \n\n). This is required for
    // source coverage, which does exact substring matching.
    const sentences = splitIntoSentencesWithOffsets(sceneText);

    if (sentences.length === 0) {
        const parts = splitTextEvenlyByParagraphs(sceneText, WINDOW_SIZE);
        return parts.map((text, i) => ({
            title: extractSceneTitle(text, i), text, type: 'narration',
            participants: [], location: null, character_anchors: {},
        }));
    }

    const groups = [];
    let current = [];
    for (const s of sentences) {
        if (current.length === 0) { current.push(s); continue; }
        const currentDur = estimateSpeechDurationSec(
            sceneText.slice(current[0].start, current[current.length - 1].end)
        );
        const withNext = estimateSpeechDurationSec(
            sceneText.slice(current[0].start, s.end)
        );
        // Close the current scene if it already meets the target, or if adding
        // the next sentence would push it past the hard max.
        if (currentDur >= SCENE_TARGET_SEC || withNext > SCENE_MAX_SEC) {
            groups.push(current);
            current = [s];
        } else {
            current.push(s);
        }
    }
    if (current.length > 0) groups.push(current);

    return groups.map((g, i) => {
        const text = sceneText.slice(g[0].start, g[g.length - 1].end);
        const dur = estimateSpeechDurationSec(text);
        if (dur > SCENE_MAX_SEC) {
            console.warn(`[AGENT] fallback scene ${i} is ${dur}s (> ${SCENE_MAX_SEC}s) — single sentence exceeds max, kept whole`);
        }
        return {
            title: extractSceneTitle(text, i), text, type: 'narration',
            participants: [], location: null, character_anchors: {},
        };
    });
}

function getWindowText(sourceText, existingChars, existingLocs, windowIndex, startOffset) {
    const chapters = lazyBook.splitIntoChapters(sourceText);

    if (startOffset === undefined || startOffset === null) {
        if (windowIndex === 0) {
            const firstChapter = lazyBook.firstMeaningfulChapter
                ? lazyBook.firstMeaningfulChapter(chapters, sourceText)
                : (chapters[0] || null);

            if (firstChapter) {
                const chStart = firstChapter.startOffset || 0;
                const chEnd = firstChapter.endOffset || sourceText.length;
                const chText = sourceText.substring(chStart, chEnd);
                const headerLen = sourceCoverage.findNarrativeStartOffset(chText);
                startOffset = Math.min(chStart + headerLen, sourceText.length);
            } else {
                startOffset = 0;
            }
        } else {
            startOffset = 0;
        }
    }

    if (startOffset >= sourceText.length) {
        const lastIdx = chapters.length > 0 ? chapters.length - 1 : 0;
        return {
            text: '',
            chapterIndex: lastIdx,
            remainingText: '',
            fullChapter: '',
            chapterTitle: chapters[lastIdx]?.title || null,
            currentOffset: startOffset,
            windowStartOffset: startOffset,
        };
    }

    let endPos = Math.min(startOffset + MAX_WINDOW_CHARS, sourceText.length);
    let windowText = sourceText.substring(startOffset, endPos);

    const skipLen = sourceCoverage.findNarrativeStartOffset(windowText);

    const actualStart = startOffset + skipLen;
    if (skipLen > 0 && actualStart < endPos) {
        windowText = sourceText.substring(actualStart, endPos);
    }

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

    // Inject [ГЛАВА: TITLE] markers for ALL-CAPS chapter headings without
    // explicit "Глава"/"Chapter" — so the AI always sees chapter boundaries
    const aiText = lazyBook.injectChapterMarkers(windowText.trim());

    console.log(`[WINDOW] getWindowText: startOffset=${startOffset}, skipLen=${skipLen}, actualStart=${actualStart}, endPos=${endPos}, newOffset=${newOffset}, chIdx=${chIdx}, chTitle="${chTitle}", textLen=${windowText.trim().length}, sourceLen=${sourceText.length}`);

    return {
        text: aiText,
        chapterIndex: chIdx,
        remainingText: remaining,
        fullChapter: windowText,
        chapterTitle: chTitle,
        currentOffset: newOffset,
        windowStartOffset: actualStart,
    };
}

function resolveSceneProgress(sceneText, scenes, sourceOffsetBase) {
    const sceneTexts = (scenes || []).map(s => s?.text || '');
    const coverage = sourceCoverage.computeSceneCoverage(sceneText, sceneTexts, { sourceOffsetBase });

    if (!coverage.ok) {
        return {
            coverage,
            nextOffset: null,
            progressMethod: 'coverage_failed',
        };
    }

    const lastSceneText = sceneTexts[sceneTexts.length - 1] || '';
    const tailProgress = sourceCoverage.findLastSceneEndOffset(sceneText, lastSceneText, { sourceOffsetBase });
    const tailMatchesCoverage = tailProgress.ok && tailProgress.source_end === coverage.covered_end_offset;
    if (tailProgress.ok && !tailMatchesCoverage) {
        console.warn(JSON.stringify({
            event: 'last_scene_tail_offset_mismatch',
            source_offset_base: sourceOffsetBase,
            coverage_end: coverage.covered_end_offset,
            tail_end: tailProgress.source_end,
            tail_method: tailProgress.method,
        }));
    }

    return {
        coverage: {
            ...coverage,
            progress_method: tailMatchesCoverage ? `coverage:${tailProgress.method}` : 'coverage',
            last_scene_end_offset: coverage.covered_end_offset,
        },
        nextOffset: coverage.next_offset,
        progressMethod: tailMatchesCoverage ? `coverage:${tailProgress.method}` : 'coverage',
    };
}

async function runPipeline(sessionId, text, existingChars, existingLocs, stepIndex, progress, baseSceneCount, options = {}) {
    const _progress = progress || (() => {});
    const { publishProgress, bookId } = options;
    const sceneOffset = baseSceneCount || 0;
    let characters = existingChars || [];
    let locations = existingLocs || [];
    const rawWindowText = options.rawWindowText || text;
    const sourceOffsetBase = options.sourceOffsetBase || 0;

    // Helper to publish VBook progress events to Redis pub/sub (for SSE stream)
    const publishVBook = (event) => {
        if (publishProgress && bookId) {
            try {
                publishProgress(bookId, { type: 'vbook', ...event });
            } catch (_) { /* best-effort */ }
        }
    };

    // Publish an initial progress event with the scene cap as advisory metadata.
    publishVBook({ stage: 'extracting_chars', scene_index: 0, total_scenes: 0, window_size: WINDOW_SIZE });

    // The window is only a token budget buffer. The agent may use any
    // contiguous prefix of it, up to MAX_SCENES_PER_CHUNK scenes.
    const sceneText = rawWindowText.trimEnd();

    // Publish event after character extraction
    publishVBook({ stage: 'analyzing', scene_index: 0, total_scenes: 0, window_size: WINDOW_SIZE });

    // Reconnaissance: extract chars/locs from the same bounded window.
    // New characters added, existing ones enriched with more detail
    const newCharacters = await stepExtractCharacters(sessionId, text, stepIndex, _progress);
    if (!newCharacters || newCharacters.length === 0) {
        console.warn('[AGENT] No characters extracted from window, keeping existing set');
        characters = existingChars.length > 0
            ? existingChars
            : [{ id: 'unknown', name: 'Unknown', role: 'minor', description: 'Unidentified character' }];
    } else {
        const mergedMap = new Map((existingChars || []).map(c => [c.id, c]));
        let enriched = 0;
        let added = 0;
        for (const ch of newCharacters) {
            if (mergedMap.has(ch.id)) {
                // Enrich existing character with new info
                const existing = mergedMap.get(ch.id);
                const enrichedCh = { ...existing };
                if (ch.description && ch.description.length > (existing.description || '').length) {
                    enrichedCh.description = existing.description
                        ? existing.description + ' ' + ch.description
                        : ch.description;
                }
                if (ch.appearance && ch.appearance.length > (existing.appearance || '').length) {
                    enrichedCh.appearance = existing.appearance
                        ? existing.appearance + ' ' + ch.appearance
                        : ch.appearance;
                }
                if (ch.traits && Array.isArray(ch.traits)) {
                    const existingTraits = new Set(existing.traits || []);
                    for (const t of ch.traits) {
                        if (!existingTraits.has(t)) {
                            enrichedCh.traits = enrichedCh.traits || [];
                            enrichedCh.traits.push(t);
                            existingTraits.add(t);
                        }
                    }
                }
                if (ch.voice && ch.voice.length > (existing.voice || '').length) {
                    enrichedCh.voice = ch.voice;
                }
                mergedMap.set(ch.id, enrichedCh);
                enriched++;
            } else {
                mergedMap.set(ch.id, ch);
                added++;
            }
        }
        characters = Array.from(mergedMap.values());
        console.log(`[AGENT] Characters: ${existingChars.length} existing + ${added} new + ${enriched} enriched = ${characters.length} total`);
    }

    publishVBook({ stage: 'analyzing', scene_index: 0, total_scenes: 0, window_size: WINDOW_SIZE });

    // Always extract locations from each window, merge with enrichment
    const newLocations = await stepExtractLocations(sessionId, text, characters, stepIndex, _progress);
    if (!newLocations || newLocations.length === 0) {
        console.warn('[AGENT] No locations extracted from window, keeping existing set');
        locations = existingLocs.length > 0
            ? existingLocs
            : [{ id: 'unknown', name: 'Unknown', type: 'outdoor', description: 'Unspecified location' }];
    } else {
        const mergedMap = new Map((existingLocs || []).map(l => [l.id, l]));
        let enriched = 0;
        let added = 0;
        for (const loc of newLocations) {
            if (mergedMap.has(loc.id)) {
                const existing = mergedMap.get(loc.id);
                if (loc.description && loc.description.length > (existing.description || '').length) {
                    mergedMap.set(loc.id, {
                        ...existing,
                        description: existing.description
                            ? existing.description + ' ' + loc.description
                            : loc.description,
                    });
                    enriched++;
                }
            } else {
                mergedMap.set(loc.id, loc);
                added++;
            }
        }
        locations = Array.from(mergedMap.values());
        console.log(`[AGENT] Locations: ${existingLocs.length} existing + ${added} new + ${enriched} enriched = ${locations.length} total`);
    }

    // ── Scene split with unified validation (coverage = hard, duration = soft) ──
    // capScenes is purely a safety guard (hard upper bound, NOT a target).
    const capScenes = (arr) => (arr || []).slice(0, MAX_SCENES_PER_CHUNK);

    // Find scenes longer than the soft max (only meaningful once coverage is OK).
    const findOversized = (arr) => arr
        .map((s, i) => ({ i, dur: estimateSpeechDurationSec(s.text || '') }))
        .filter(o => o.dur > SCENE_MAX_SEC);

    // Find scenes shorter than the min threshold (only meaningful once coverage is OK).
    const findUndersized = (arr) => arr
        .map((s, i) => ({ i, dur: estimateSpeechDurationSec(s.text || '') }))
        .filter(o => o.dur < SCENE_MIN_SEC);

    const evaluate = (arr) => {
        const progressInfo = resolveSceneProgress(sceneText, arr, sourceOffsetBase);
        const oversized = progressInfo.coverage.ok ? findOversized(arr) : [];
        const undersized = progressInfo.coverage.ok ? findUndersized(arr) : [];
        return { progressInfo, cov: progressInfo.coverage, oversized, undersized };
    };

    const totalScenesEstimate = Math.min(MAX_SCENES_PER_CHUNK, Math.ceil(sceneText.length / 200) || 1);
    publishVBook({ stage: 'creating_scenes', scene_index: 0, total_scenes: totalScenesEstimate, window_size: WINDOW_SIZE });

    let scenes = capScenes(await stepCreateScenes(sessionId, sceneText, characters, locations, stepIndex, _progress));
    if (!scenes || scenes.length === 0) throw new Error('AI returned no scenes');

    let windowScenes = scenes;
    let { progressInfo, cov: coverage, oversized, undersized } = evaluate(windowScenes);
    let coverageRetryCount = 0;

    // Single repair retry: coverage failure (highest priority) → gap fix;
    // oversized scenes → duration-split repair. Undersized scenes are logged
    // but NOT retried — they are accepted to avoid breaking coverage.
    // In a future version, undersized scenes could be merged post-hoc.
    if (!coverage.ok || oversized.length > 0) {
        let repairHint;
        if (!coverage.ok) {
            console.warn(`[AGENT] scene coverage failed: ${coverage.reason} scene=${coverage.scene_index} gap=${coverage.gap_chars || 0}; retrying scene split`);
            repairHint = coverage;
        } else {
            const preview = oversized
                .map(o => `- scene ${o.i + 1}: ~${o.dur}s, "${(windowScenes[o.i].text || '').slice(0, 80).replace(/\n/g, ' ')}..."`)
                .join('\n');
            console.warn(`[AGENT] ${oversized.length} scene(s) exceed ${SCENE_MAX_SEC}s; retrying scene split for shorter scenes`);
            repairHint = { reason: 'duration_exceeded', duration_preview: preview };
        }
        coverageRetryCount += 1;
        windowScenes = capScenes(await stepCreateScenes(sessionId, sceneText, characters, locations, stepIndex, _progress, repairHint));
        ({ progressInfo, cov: coverage, oversized, undersized } = evaluate(windowScenes));
    }

    // Coverage is the only hard trigger for the deterministic fallback.
    if (!coverage.ok) {
        console.warn(`[AGENT] scene coverage retry failed: ${coverage.reason}; using deterministic fallback`);
        coverageRetryCount += 1;
        windowScenes = capScenes(buildFallbackScenes(sceneText));
        ({ progressInfo, cov: coverage, oversized, undersized } = evaluate(windowScenes));
        if (!coverage.ok) {
            throw new Error(`Scene coverage failed after fallback: ${coverage.reason}`);
        }
    }

    // Duration is soft: if scenes remain oversized after the retry (coverage OK),
    // accept them rather than risk a coverage gap. Log for auditing.
    if (oversized.length > 0) {
        console.warn(JSON.stringify({
            event: 'scene_duration_over_max',
            step_index: stepIndex,
            max_sec: SCENE_MAX_SEC,
            oversized: oversized.map(o => ({ scene_index: o.i, est_sec: o.dur })),
        }));
    }

    // Log undersized scenes (below MIN_SEC) for monitoring.
    if (undersized.length > 0) {
        console.warn(JSON.stringify({
            event: 'scene_duration_below_min',
            step_index: stepIndex,
            min_sec: SCENE_MIN_SEC,
            undersized: undersized.map(o => ({ scene_index: o.i, est_sec: o.dur })),
        }));
    }

    console.log(JSON.stringify({
        event: 'agent_window_coverage',
        step_index: stepIndex,
        planned_start: sourceOffsetBase,
        planned_end: sourceOffsetBase + sceneText.length,
        covered_start: coverage.covered_start_offset ?? null,
        covered_end: coverage.covered_end_offset ?? null,
        next_offset: progressInfo.nextOffset ?? null,
        progress_method: progressInfo.progressMethod,
        gap_chars: coverage.gap_chars || 0,
        retry_count: coverageRetryCount,
    }));

    const enrichedScenes = [];
    for (let si = 0; si < windowScenes.length; si++) {
        const scene = windowScenes[si];
        const globalSceneIndex = sceneOffset + si;

        const windowSceneIndex = si + 1;
        const windowTotalScenes = windowScenes.length;
        const windowStartScene = sceneOffset + 1;

        // Publish per-scene progress with both cumulative and current-block
        // counters. The block can contain fewer than WINDOW_SIZE scenes.
        publishVBook({
            stage: 'creating_units',
            scene_index: globalSceneIndex + 1,
            total_scenes: sceneOffset + windowTotalScenes,
            window_size: WINDOW_SIZE,
            window_scene_index: windowSceneIndex,
            window_total_scenes: windowTotalScenes,
            window_start_scene: windowStartScene,
        });

        const units = await stepCreateUnits(sessionId, scene, globalSceneIndex, characters, stepIndex, _progress);

        publishVBook({
            stage: 'creating_visuals',
            scene_index: globalSceneIndex + 1,
            total_scenes: sceneOffset + windowTotalScenes,
            window_size: WINDOW_SIZE,
            window_scene_index: windowSceneIndex,
            window_total_scenes: windowTotalScenes,
            window_start_scene: windowStartScene,
        });

        const visualUnits = await stepCreateVisuals(sessionId, scene, units, globalSceneIndex, characters, locations, stepIndex, _progress);
        const sceneSpan = coverage.scene_spans[si] || null;
        let annotatedUnits = visualUnits;

        if (sceneSpan) {
            const unitCoverage = sourceCoverage.computeSceneCoverage(
                scene.text || '',
                visualUnits.map(u => u.text || ''),
                { sourceOffsetBase: sceneSpan.source_start }
            );
            if (unitCoverage.ok) {
                annotatedUnits = visualUnits.map((u, ui) => ({
                    ...u,
                    source_start: unitCoverage.scene_spans[ui]?.source_start ?? sceneSpan.source_start,
                    source_end: unitCoverage.scene_spans[ui]?.source_end ?? sceneSpan.source_end,
                }));
            } else {
                console.warn(`[AGENT] unit coverage failed scene ${globalSceneIndex}: ${unitCoverage.reason}`);
                annotatedUnits = visualUnits.map(u => ({
                    ...u,
                    source_start: sceneSpan.source_start,
                    source_end: sceneSpan.source_end,
                }));
            }
        }

        enrichedScenes.push({
            ...scene,
            source_start: sceneSpan?.source_start ?? null,
            source_end: sceneSpan?.source_end ?? null,
            units: annotatedUnits,
        });
    }

    return {
        characters,
        locations,
        scenes: enrichedScenes,
        allScenes: windowScenes,
        sceneConsumedLength: (progressInfo.nextOffset ?? coverage.next_offset) - sourceOffsetBase,
        nextOffset: progressInfo.nextOffset ?? coverage.next_offset,
        coverage,
    };
}

// Forward-declare for bootstrapNextWindow (it references the same publish progress pattern)

async function bootstrapWithAgent(bookId, progress, publishProgress) {
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

    const session = await createSession(bookId, 'txt_import');
    const sessionId = session.session_id;
    console.log(`[AGENT] Session ${sessionId} created for book ${bookId}`);

    try {
        const windowInfo = getWindowText(draft.sourceText, [], [], 0);
        console.log(`[FIRST-WINDOW] currentOffset=${windowInfo.currentOffset}, chapterIndex=${windowInfo.chapterIndex}, chapterTitle="${windowInfo.chapterTitle}", textLen=${windowInfo.text.length}`);

        _progress({ stage: 'analyzing_structure', message: PROGRESS_STAGES.analyzing_structure });
        const structure = await stepAnalyzeStructure(sessionId, windowInfo.text, 0, _progress);

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

        const result = await runPipeline(sessionId, windowInfo.text, [], [], 0, _progress, 0, {
            rawWindowText: windowInfo.fullChapter,
            sourceOffsetBase: windowInfo.windowStartOffset,
            publishProgress,
            bookId,
        });

        if (result.scenes.length === 0) {
            throw new Error('AI returned no scenes — cannot create book');
        }

        // All scenes for this chunk are processed and saved — no cached "extra"
        // scenes carried to the next window (the offset advances past covered text).
        const extraScenes = [];

        const sceneConsumedOffset = result.nextOffset ?? result.coverage?.next_offset;
        if (!Number.isFinite(sceneConsumedOffset) || sceneConsumedOffset <= windowInfo.windowStartOffset) {
            throw new Error('Scene progress did not advance from current source position');
        }
        const actualRemaining = draft.sourceText.substring(sceneConsumedOffset).trim();

        const windowData = {
            window_index: 0,
            chapter_title: windowInfo.chapterTitle,
            chapter_index: windowInfo.chapterIndex,
            total_scenes: result.allScenes.length,
            created_scenes: result.scenes.length,
            remaining_scenes: extraScenes,
            remaining_text: actualRemaining,
            currentOffset: sceneConsumedOffset,
            windowStartOffset: windowInfo.windowStartOffset,
            plannedEndOffset: windowInfo.currentOffset,
            coveredStartOffset: result.coverage?.covered_start_offset ?? null,
            coveredEndOffset: result.coverage?.covered_end_offset ?? null,
            lastSceneEndOffset: result.coverage?.last_scene_end_offset ?? null,
            progressMethod: result.coverage?.progress_method || null,
            coverageStatus: result.coverage?.ok ? 'ok' : 'failed',
            coverageGapChars: result.coverage?.gap_chars || 0,
            all_characters: result.characters,
            all_locations: result.locations,
            structure: structure,
        };

        await updateSession(sessionId, {
            window_data: JSON.stringify(windowData),
            progress_msg: `Создано ${result.scenes.length} сцен, ${result.characters.length} персонажей, ${result.locations.length} локаций`,
        });

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
            maxScenes: MAX_SCENES_PER_CHUNK,
            structure: structure,
        });

        const hasMoreText = actualRemaining.length > 0;
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

async function bootstrapNextWindow(bookId, progress, publishProgress) {
    const _progress = progress || (() => {});
    const draft = lazyBook.loadDraftBook(bookId);
    if (!draft || !draft.sourceText) throw new Error(`Book ${bookId} not found`);

    // ── Dedup: check if the CURRENT offset has already been processed ──
    // If there's a recent 'paused' or 'completed' session whose window_data
    // has the same currentOffset as we'd compute, skip processing to avoid
    // re-processing the same text window (infinite loop).
    let windowData = null;
    try {
        const prevResult = await query(
            `SELECT status, window_data FROM agent_sessions WHERE book_id = $1 AND window_data IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
            [bookId]
        );
        if (prevResult?.rows?.[0]?.window_data) {
            const raw = prevResult.rows[0].window_data;
            windowData = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const prevStatus = prevResult.rows[0].status;
            console.log(`[AGENT] bootstrapNextWindow: prev session status=${prevStatus}, currentOffset=${windowData?.currentOffset}`);

            // If the previous session was 'completed' and had the same
            // currentOffset remaining_text is empty, then all windows are done.
            if (prevStatus === 'completed') {
                console.log(`[AGENT] bootstrapNextWindow: previous session completed, all done`);
                return { session_id: null, cached: false, added_scenes: 0, all_done: true };
            }

            // If previous session is 'paused' with no remaining text and no
            // remaining scenes, it's also done.
            if (prevStatus === 'paused' &&
                (!windowData.remaining_text || windowData.remaining_text.length === 0) &&
                (!windowData.remaining_scenes || windowData.remaining_scenes.length === 0)) {
                console.log(`[AGENT] bootstrapNextWindow: paused with no remaining text/scenes, all done`);
                return { session_id: null, cached: false, added_scenes: 0, all_done: true };
            }
        }
    } catch (lookupErr) {
        console.warn(`[AGENT] bootstrapNextWindow: failed to look up previous window_data: ${lookupErr.message}`);
    }

    const currentOffset = windowData?.currentOffset || 0;
    const existingChars = windowData?.all_characters || [];
    const existingLocs = windowData?.all_locations || [];

    // ── Final dedup: if we already have a session for THIS windowStartOffset, skip ──
    // Use windowStartOffset (start of AI-processed text) rather than currentOffset
    // (end of previous window) to avoid matching the previous session itself.
    const windowInfo = getWindowText(draft.sourceText, existingChars, existingLocs, 1, currentOffset);

    // ── Seam diagnostic: verify no VISIBLE (non-whitespace, non-header) source
    // text is dropped between the previous window's covered end and this
    // window's narrative start. getWindowText re-applies findNarrativeStartOffset
    // which should only skip chapter headers / blank lines, never prose.
    const prevCoveredEnd = windowData?.coveredEndOffset;
    if (typeof prevCoveredEnd === 'number' && windowInfo.windowStartOffset > prevCoveredEnd) {
        const seam = draft.sourceText.substring(prevCoveredEnd, windowInfo.windowStartOffset);
        const seamHeaderStripped = seam
            .split('\n')
            .filter(line => !sourceCoverage.looksLikeChapterTitle(line) && !/^\s*(?:глава|chapter|часть|part|пролог|prologue|эпилог|epilogue)/i.test(line))
            .join('');
        const droppedVisible = seamHeaderStripped.replace(/\s+/g, '').length;
        if (droppedVisible > 0) {
            console.warn(JSON.stringify({
                event: 'window_seam_visible_text_dropped',
                book_id: bookId,
                prev_covered_end: prevCoveredEnd,
                next_window_start: windowInfo.windowStartOffset,
                dropped_visible_chars: droppedVisible,
                seam_preview: seam.slice(0, 200),
            }));
        }
    }

    const dedupKey = String(windowInfo.windowStartOffset);
    try {
        const dupCheck = await query(
            `SELECT COUNT(*) as cnt FROM agent_sessions WHERE book_id = $1 AND window_data IS NOT NULL AND window_data->>'windowStartOffset' = $2 AND status IN ('paused','completed')`,
            [bookId, dedupKey]
        );
        if (parseInt(dupCheck.rows[0]?.cnt || '0', 10) > 0) {
            console.log(`[AGENT] bootstrapNextWindow: offset ${dedupKey} already processed, skipping`);
            return { session_id: null, cached: true, added_scenes: 0, all_done: true };
        }
    } catch (dupErr) {
        console.warn(`[AGENT] bootstrapNextWindow: dedup check failed: ${dupErr.message}`);
    }

    const session = await createSession(bookId, 'txt_import');
    const sessionId = session.session_id;

    try {
        const bookDir = lazyBook.getBookDir(bookId);
        const bp = lazyBook.getBookMetaPath(bookDir);
        const fs_local = require('fs');
        if (!fs_local.existsSync(bp)) throw new Error(`Book metadata not found: ${bookId}`);
        const existingChars = windowData?.all_characters || [];
        const existingLocs = windowData?.all_locations || [];

        console.log(`[AGENT] bootstrapNextWindow: currentOffset=${currentOffset}, existingChars=${existingChars.length}, existingLocs=${existingLocs.length}`);

        if (!windowInfo.text || !windowInfo.text.trim()) {
            await updateSession(sessionId, {
                status: 'completed',
                progress_msg: 'Нет текста для анализа — импорт завершён',
            });
            _progress({ stage: 'done', message: '✓ Нет текста для анализа — импорт завершён' });
            return { session_id: sessionId, cached: false, added_scenes: 0, all_done: true };
        }

        const nextWindowIndex = (windowData?.window_index || 0) + 1;
        const nextChapterIndex = windowInfo.chapterIndex;

        const structure = (windowData?.structure && windowData.structure.chapters) ? {
            chapters: windowData.structure.chapters,
            author: windowData.structure.author,
            title: windowData.structure.title,
            has_prologue: windowData.structure.has_prologue,
            has_epilogue: windowData.structure.has_epilogue,
            parts: windowData.structure.parts,
        } : null;

        const result = await runPipeline(sessionId, windowInfo.text, existingChars, existingLocs, nextWindowIndex, _progress, (windowData?.created_scenes || 0), {
            rawWindowText: windowInfo.fullChapter,
            sourceOffsetBase: windowInfo.windowStartOffset,
            publishProgress,
            bookId,
        });

        // All scenes for this chunk are processed and saved — no cached "extra".
        const extraScenes = [];

        const sceneConsumedOffset = result.nextOffset ?? result.coverage?.next_offset;
        if (!Number.isFinite(sceneConsumedOffset) || sceneConsumedOffset <= windowInfo.windowStartOffset) {
            throw new Error('Scene progress did not advance from current source position');
        }
        const actualRemaining = draft.sourceText.substring(sceneConsumedOffset).trim();

        const bookResult = lazyBook.appendToBook(bookId, {
            characters: result.characters,
            locations: result.locations,
            scenes: result.scenes,
            maxScenes: MAX_SCENES_PER_CHUNK,
            chapterTitle: windowInfo.chapterTitle || `Глава ${nextChapterIndex + 1}`,
            chapterIndex: nextChapterIndex,
            structure: structure,
        });

        // runPipeline returns already-merged set (chars enriched, new added)
        const updatedWindowData = {
            window_index: nextWindowIndex,
            chapter_title: windowInfo.chapterTitle,
            chapter_index: nextChapterIndex,
            total_scenes: result.allScenes.length,
            created_scenes: (windowData?.created_scenes || 0) + result.scenes.length,
            remaining_scenes: extraScenes,
            remaining_text: actualRemaining,
            currentOffset: sceneConsumedOffset,
            windowStartOffset: windowInfo.windowStartOffset,
            plannedEndOffset: windowInfo.currentOffset,
            coveredStartOffset: result.coverage?.covered_start_offset ?? null,
            coveredEndOffset: result.coverage?.covered_end_offset ?? null,
            lastSceneEndOffset: result.coverage?.last_scene_end_offset ?? null,
            progressMethod: result.coverage?.progress_method || null,
            coverageStatus: result.coverage?.ok ? 'ok' : 'failed',
            coverageGapChars: result.coverage?.gap_chars || 0,
            all_characters: result.characters,
            all_locations: result.locations,
        };

        const allDone = extraScenes.length === 0 && actualRemaining.length === 0;
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

module.exports = {
    createSession,
    updateSession,
    getSession,
    loadKnowledgeBase: require('./knowledge-base').loadKnowledgeBase,
    bootstrapWithAgent,
    bootstrapNextWindow,
    PROGRESS_STAGES,
    WINDOW_SIZE,
    MAX_WINDOW_CHARS,
    SCENE_TARGET_SEC,
    SCENE_MAX_SEC,
    SCENE_MIN_SEC,
    MAX_SCENES_PER_CHUNK,
    // Exported for unit testing
    splitIntoSentences,
    splitIntoSentencesWithOffsets,
    buildFallbackScenes,
    splitTextEvenlyByParagraphs,
    extractSceneTitle,
    isGenericSceneTitle,
    resolveSceneProgress,
    buildVisualExemplars,
};
