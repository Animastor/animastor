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
const { normalizeCharacterRefs } = require('../image/image-service');
const { mergeCharacterLists } = require('../utils/character-identity');

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
        const mentions = result.mentions || {};
        await logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, { characters, mentions });
        console.log(`[AGENT] Step 1 (characters): ${characters.length} extracted, ${Object.keys(mentions).length} mentions`);
        return { characters, mentions };
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

async function stepEnrichScenes(sessionId, scenes, characters, locations, stepIndex, progress) {
    const _progress = progress || (() => {});
    _progress({ stage: 'enriching_scenes', message: PROGRESS_STAGES.enriching_scenes });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.enriching_scenes });

    if (!scenes || scenes.length === 0) return scenes;

    const step = await createStep(sessionId, 'enrich_scenes', stepIndex || 0);

    const charsContext = (characters || []).map(c => `- ${c.id}: ${c.name}`).join('\n') || 'None';
    const locsContext = (locations || []).map(l => `- ${l.id}: ${l.name} (${l.type || 'unknown'})`).join('\n') || 'None';

    const scenesStr = scenes.map((s, i) =>
        `Scene ${i}: title="${s.title || 'Untitled'}", type="${s.type || 'narration'}", ` +
        `location_id="${s.location?.id || '?'}", ` +
        `participants=[${(s.characters_present || s.participants || []).join(', ')}], ` +
        `text="${(s.text || '').substring(0, 500)}..."`
    ).join('\n');

    const enrichmentPrompt = SYSTEM_PROMPTS.enrich_scenes
        .replace('%EXISTING_CHARACTERS%', charsContext)
        .replace('%EXISTING_LOCATIONS%', locsContext)
        .replace('%SCENES_TO_ENRICH%', scenesStr);

    const messages = [
        { role: 'system', content: enrichmentPrompt },
        { role: 'user', content: `Enrich these scenes:\n${scenesStr}` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 4096 });
        const enrichedList = result.scenes || [];

        // Merge enrichment back into original scenes
        const enriched = scenes.map((scene, si) => {
            const enrichment = enrichedList.find(e => e.scene_index === si);
            if (!enrichment) return scene;

            const mergedLocation = scene.location ? { ...scene.location } : {};
            if (enrichment.location?.environment) {
                mergedLocation.environment = enrichment.location.environment;
            }
            return {
                ...scene,
                location: mergedLocation,
            };
        });

        await logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, enriched);
        console.log(`[AGENT] Step enrich (scenes): ${enriched.length} enriched`);
        return enriched;
    } catch (err) {
        await failStep(step.step_id, `Enrichment failed: ${err.message}`);
        console.warn(`[AGENT] Scene enrichment failed, continuing with base scenes: ${err.message}`);
        return scenes;  // Graceful degradation: return un-enriched scenes
    }
}

function formatExamplesForPrompt() {
    try {
        const examples = require('./ai-loader').getExamples();
        if (!examples || Object.keys(examples).length === 0) return '';

        const parts = [];

        for (const [name, data] of Object.entries(examples)) {
            const bookScenes = data?.result?.chapters?.[0]?.scenes;
            if (Array.isArray(bookScenes) && bookScenes.length > 0) {
                parts.push(`--- Example: "${name}" — book structure ---`);
                for (const sc of bookScenes) {
                    const textLen = (sc.text || sc.audio?.full_text || '').length;
                    const participants = (sc.participants || []).join(', ') || 'none';
                    parts.push(`  Scene "${sc.title || sc.scene_title || 'untitled'}" (${sc.type || 'unknown'}): ${textLen} chars, participants: ${participants}`);
                }
                parts.push(`  (Total: ${bookScenes.length} scenes for this chapter)\n`);
                continue;
            }

            const sceneData = data?.scene || data?.scenes?.[0];
            if (sceneData && (sceneData.units || sceneData.audio)) {
                parts.push(`--- Example: "${name}" — scene structure ---`);
                const title = sceneData.scene_title || sceneData.title || 'untitled';
                parts.push(`  Title: "${title}" (${sceneData.type || 'unknown'})`);
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

            const keys = Object.keys(data || {});
            parts.push(`--- Example: "${name}" — ${keys.length > 0 ? `${keys.length} top-level key(s)` : 'empty'} ---`);
        }

        return parts.join('\n');
    } catch (err) {
        console.warn(`[AGENT] Failed to load examples for prompt: ${err.message}`);
        return '';
    }
}

async function stepCreateUnits(sessionId, scene, sceneIndex, characters, stepIndex, progress, mentions) {
    const _progress = progress || (() => {});
    const msg = PROGRESS_STAGES.creating_units(sceneIndex);
    _progress({ stage: 'creating_units', message: msg });
    await updateSession(sessionId, { progress_msg: msg });

    const step = await createStep(sessionId, 'create_units', stepIndex || 0, sceneIndex);

    const sceneText = (scene.text || '').trim();
    const truncatedText = sceneText.length > 3000 ? sceneText.substring(0, 3000) + '...' : sceneText;
    const charsContext = (characters || []).map(c => `- ${c.id}: ${c.name}`).join('\n') || 'None';

    // Add mentions context: role/title → character_id mappings
    // Only show mentions that resolve to characters IN the known characters list
    const knownIds = new Set((characters || []).map(c => c.id).filter(Boolean));
    const mentionsContext = (mentions && typeof mentions === 'object' && Object.keys(mentions).length > 0)
        ? '\n## Role/title → character_id mappings\n' +
          'When the text refers to a character by role or title (e.g. "редактор", "глава МАССОЛИТ", "прозрачный гражданин"),\n' +
          'use the mapped character_id below. If a role references an id NOT in the Known Characters list,\n' +
          'describe the character literarily in natural language instead:\n' +
          Object.entries(mentions)
            .filter(([, charId]) => knownIds.has(charId))
            .map(([alias, charId]) => `  "${alias}" → ${charId}`).join('\n')
        : '';

    const prompt = SYSTEM_PROMPTS.units
        .replace('%SCENE_TEXT%', truncatedText)
        .replace('%EXISTING_CHARACTERS%', charsContext + mentionsContext);

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

function buildVisualExemplars() {
    try {
        const examples = require('./ai-loader').getExamples();
        if (!examples) return '';

        let best = null;
        for (const data of Object.values(examples)) {
            const scenes = data?.scenes || (data?.scene ? [data.scene] : []);
            for (const sc of scenes) {
                const parts = sc?.participants || [];
                if (!parts.length) continue;
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

    const locName = scene.location?.id || 'the scene';
    const contextParts = [`Title: ${scene.title || 'Untitled'}`, `Type: ${scene.type || 'narration'}`, `Location (name to use in prompts): ${locName}`, ''];

    const epoch = scene.location?.environment?.epoch;
    if (epoch) {
        contextParts.push(`Epoch/period: ${epoch}`);
    }
    const season = scene.location?.environment?.season;
    if (season) {
        contextParts.push(`Season: ${season}`);
    }

    let namedCount = 0;
    const sceneParticipantIds = new Set(scene.participants || []);
    for (const unit of (units || [])) {
        for (const pId of (unit.participants || [])) {
            sceneParticipantIds.add(pId);
        }
    }
    // For chapter_intro scenes (title cards), skip character section entirely.
    // Title cards should focus on location/atmosphere, not character portraits.
    if (scene.type === 'chapter_intro') {
        // no character section for title cards
    } else if (sceneParticipantIds.size > 0) {
        // Normal case: participants known from scene or units
        contextParts.push('Characters in scene (use their character_id in every prompt — no pronouns, no names):');
        for (const pId of sceneParticipantIds) {
            const ch = (characters || []).find(c => c.id === pId);
            if (!ch) continue;
            const passportDesc = [ch.passport?.base_appearance, ch.passport?.detailed_appearance, ch.passport?.clothing_base, ch.passport?.clothing_details].filter(Boolean).join('; ')
            contextParts.push(`- ${ch.id}: ${ch.name} — ${passportDesc || ch.description || ''}`);
            namedCount++;
        }
        if (namedCount === 0) {
            contextParts.push('(unknown characters)');
        }
    } else if (characters?.length) {
        // Fallback for narration/dialogue scenes with no participants:
        // Include a limited set of known characters so the AI can map
        // textual references (e.g. "two citizens") to character IDs.
        contextParts.push('Characters likely in scene (use character_id matching the scene text below — verify before using):');
        const limit = Math.min(characters.length, 5);
        for (let ci = 0; ci < limit; ci++) {
            const ch = characters[ci];
            contextParts.push(`- ${ch.id}: ${ch.name} — ${ch.passport?.base_appearance || ch.description || ''}`);
            namedCount++;
        }
        if (characters.length > 5) {
            contextParts.push(`  ... and ${characters.length - 5} more characters in this chapter`);
        }
    }
    const sceneFullText = scene.audio?.full_text || scene.text || units.map(u => u.text).filter(Boolean).join(' ')
    if (sceneFullText) {
        contextParts.push('', `Full scene text:\n${sceneFullText.substring(0, 1500)}`)
    }
    const contextStr = contextParts.join('\n');

    const unitsStr = units.map((u, i) =>
        `Unit ${i + 1}: text="${(u.text || '').substring(0, 300)}", type="${u.type || 'perception'}", participants=[${(u.participants || []).join(', ')}]`
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

        const passportPartsFor = (ids) => {
            const parts = [];
            for (const pId of (ids || [])) {
                const ch = (characters || []).find(c => c.id === pId);
                if (!ch) continue;
                const desc = [ch.passport?.base_appearance, ch.passport?.detailed_appearance,
                              ch.passport?.clothing_base, ch.passport?.clothing_details]
                    .filter(Boolean).join('; ');
                parts.push(`${ch.id}: ${desc || ch.description || ch.name}`);
            }
            return parts;
        };

        const merged = units.map((u, i) => {
            const vu = visualUnits[i];
            if (vu && vu.visual) {
                const unitParticipantIds = (u.participants && u.participants.length > 0)
                    ? u.participants
                    : (scene.participants || []);
                const scopedCharacters = (characters || []).filter(c => unitParticipantIds.includes(c.id));
                let prompt = normalizeCharacterRefs(vu.visual.prompt, scopedCharacters);
                const passportParts = passportPartsFor(unitParticipantIds);
                // Inject character passports into the prompt text
                if (shouldInjectParticipantPassports(prompt, unitParticipantIds, vu.visual.character_binding) && passportParts.length > 0) {
                    // Only inject if NO character_id from scene participants is already in the prompt
                    const anyCharIdPresent = unitParticipantIds.some(
                        pId => pId && (prompt.includes(pId + ':') || prompt.includes(pId))
                    );
                    if (!anyCharIdPresent) {
                        prompt = prompt + ', ' + passportParts.join(', ');
                    }
                }
                return { ...u, visual: { ...vu.visual, prompt } };
            }
            return {
                ...u,
                visual: {
                    shot: u.type === 'dialogue' ? 'medium' : (u.type === 'description' ? 'wide' : 'medium'),
                    prompt: getFallbackVisual(u.text, characters, { ...scene, participants: u.participants?.length ? u.participants : scene.participants }),
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
                prompt: getFallbackVisual(u.text, characters, { ...scene, participants: u.participants?.length ? u.participants : scene.participants }),
                character_binding: true,
            },
        }));
    }
}

function getFallbackVisual(text, characters, scene) {
    const participants = (scene.participants || []);
    const who = participants.length
        ? participants
              .map(pId => (characters || []).find(c => c.id === pId)?.id || pId)
              .join(' and ')
        : '';
    if (!who) return 'the scene at ' + (scene.location?.id || 'the scene') + ', cinematic shot';
    const locName = scene.location?.id || 'the scene';
    return `${who} at ${locName}, cinematic shot`;
}

function promptMentionsGenericPeople(prompt) {
    const value = String(prompt || '');
    if (/\b(no|without)\s+(people|persons?|men|figures?|characters?|humans?)\b/i.test(value)) {
        return false;
    }
    return /\b(two\s+)?(writers?|men|people|persons?|figures?|citizens?|poets?|editors?)\b/i.test(value);
}

function shouldInjectParticipantPassports(prompt, participantIds, characterBinding) {
    if (!participantIds?.length) return false;
    if (characterBinding !== false) return true;
    return promptMentionsGenericPeople(prompt);
}

function unitTextNeedsScenePairParticipants(text) {
    const value = String(text || '').toLowerCase();
    return /(^|[\s—,.;:!?«"(\[])(первый|второй|писател[ьяеию]|литератор[ыаоеив]*|гражданин[аеыу]*)(?=$|[\s—,.;:!?»")\]])/iu.test(value);
}

function applyScenePairParticipantFallback(units, unitParticipants, sceneParticipants) {
    const sceneIds = [...new Set(sceneParticipants || [])].filter(Boolean);
    if (sceneIds.length !== 2) return unitParticipants || {};

    const result = { ...(unitParticipants || {}) };
    for (let ui = 0; ui < (units || []).length; ui++) {
        if (result[ui]?.length) continue;
        if (unitTextNeedsScenePairParticipants(units[ui]?.text)) {
            result[ui] = sceneIds;
        }
    }
    return result;
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

function splitIntoSentences(text) {
    return splitIntoSentencesWithOffsets(text).map(s => s.text);
}

function splitIntoSentencesWithOffsets(text) {
    const t = String(text || '');
    const sentences = [];
    let start = 0;
    for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        const isTerminal = ch === '.' || ch === '!' || ch === '?' || ch === '\u2026';
        const isHardBreak = ch === '\n' && t[i + 1] === '\n';
        if (isTerminal) {
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

function extractSceneTitle(sceneText, fallbackIndex) {
    const t = (sceneText || '').trim();
    if (!t) return `Scene ${fallbackIndex + 1}`;

    let title = t;

    if (/^[—–\-]/.test(t)) {
        const newlinePos = t.indexOf('\n');
        const firstLine = newlinePos > 0 ? t.substring(0, newlinePos) : t;
        title = firstLine.replace(/^[—–\-\s"]+/, '').replace(/["»]+$/, '').trim();
    } else {
        const dotEnd = t.search(/[.!?](?:\s|$)/);
        const sentenceEnd = dotEnd >= 0 ? dotEnd : t.search(/…(?:\s|$)/);
        if (sentenceEnd > 3) {
            title = t.substring(0, sentenceEnd + 1);
        }
        title = title.replace(/^[—–\-\s"]+/, '').replace(/[.!?…]+$/, '').trim();
    }

    const words = title.split(/\s+/).filter(Boolean);
    if (words.length > 8) {
        title = words.slice(0, 8).join(' ');
        if (title.length < t.length) title += '…';
    }

    title = title.charAt(0).toUpperCase() + title.slice(1);

    return title || `Scene ${fallbackIndex + 1}`;
}

function isGenericSceneTitle(title) {
    if (!title) return true;
    const trimmed = title.trim();
    if (trimmed.length < 3) return true;
    if (/^(Scene|Сцена|Chapter|Глава|Part|Часть)\s*\d*$/i.test(trimmed)) return true;
    return false;
}

function buildFallbackScenes(sceneText) {
    const sentences = splitIntoSentencesWithOffsets(sceneText);

    if (sentences.length === 0) {
        const parts = splitTextEvenlyByParagraphs(sceneText, WINDOW_SIZE);
        return parts.map((text, i) => ({
            title: extractSceneTitle(text, i), text, type: 'narration',
            participants: [], location: null,
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
            participants: [], location: null,
        };
    });
}

/* ======================================================
 * Coreference Resolution — Simplified
 * Participants are now returned directly by LLM in stepCreateUnits.
 * assignUnitParticipants validates character IDs from the LLM response.
 * ====================================================== */

/**
 * Assign unit participants by validating character IDs directly from LLM output.
 * The LLM in stepCreateUnits returns participants for each unit.
 * This function validates that the returned character IDs exist in the known characters list.
 */
function assignUnitParticipants(units, characters, mentions) {
    if (!units || units.length === 0) return {};

    const knownIds = new Set((characters || []).map(c => c.id).filter(Boolean));
    const result = {};

    for (let ui = 0; ui < units.length; ui++) {
        const participants = units[ui]?.participants || [];
        if (participants.length === 0) continue;

        // Resolve each participant: first try direct ID match, then mentions
        const resolved = [];
        for (const id of participants) {
            if (knownIds.has(id)) {
                resolved.push(id);
            } else if (mentions && mentions[id] && knownIds.has(mentions[id])) {
                // Role/title reference resolved through mentions — only if target is a known character
                resolved.push(mentions[id]);
            }
            // If neither: ID is a literary reference without a passport character,
            // drop it — the visual prompt should describe this character literarily
        }
        if (resolved.length > 0) {
            result[ui] = [...new Set(resolved)];
        }
    }

    return result;
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

    publishVBook({ stage: 'extracting_chars', scene_index: 0, total_scenes: 0, window_size: WINDOW_SIZE, message: PROGRESS_STAGES.extracting_chars });

    const sceneText = rawWindowText.trimEnd();

    publishVBook({ stage: 'analyzing', scene_index: 0, total_scenes: 0, window_size: WINDOW_SIZE, message: PROGRESS_STAGES.analyzing_structure });

    // Reconnaissance: extract chars/locs from the same bounded window.
    const charResult = await stepExtractCharacters(sessionId, text, stepIndex, _progress);
    let mentions = options.existingMentions || {};
    if (!charResult || !charResult.characters || charResult.characters.length === 0) {
        console.warn('[AGENT] No characters extracted from window, keeping existing set');
        characters = existingChars.length > 0
            ? existingChars
            : [{ id: 'unknown', name: 'Unknown', role: 'minor', description: 'Unidentified character' }];
    } else {
        const newCharacters = charResult.characters;
        const mergeResult = mergeCharacterLists(existingChars || [], newCharacters || [], { skipGeneric: true });
        characters = mergeResult.characters;
        // Merge mentions across windows
        if (charResult.mentions && typeof charResult.mentions === 'object') {
            for (const [alias, charId] of Object.entries(charResult.mentions)) {
                if (!mentions[alias]) mentions[alias] = charId;
            }
        }
        console.log(`[AGENT] Characters: ${existingChars.length} existing + ${mergeResult.added} new + ${mergeResult.enriched} enriched + ${mergeResult.skippedGeneric} generic skipped = ${characters.length} total, mentions: ${Object.keys(mentions).length}`);
    }

    publishVBook({ stage: 'extracting_chars', scene_index: 0, total_scenes: 0, window_size: WINDOW_SIZE, message: PROGRESS_STAGES.extracting_chars });

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
    const capScenes = (arr) => (arr || []).slice(0, MAX_SCENES_PER_CHUNK);

    const findOversized = (arr) => arr
        .map((s, i) => ({ i, dur: estimateSpeechDurationSec(s.text || '') }))
        .filter(o => o.dur > SCENE_MAX_SEC);

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
    publishVBook({ stage: 'creating_scenes', scene_index: 0, total_scenes: totalScenesEstimate, window_size: WINDOW_SIZE, message: PROGRESS_STAGES.creating_scenes });

    let scenes = capScenes(await stepCreateScenes(sessionId, sceneText, characters, locations, stepIndex, _progress));
    if (!scenes || scenes.length === 0) throw new Error('AI returned no scenes');

    let windowScenes = scenes;
    let { progressInfo, cov: coverage, oversized, undersized } = evaluate(windowScenes);
    let coverageRetryCount = 0;

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

    if (!coverage.ok) {
        console.warn(`[AGENT] scene coverage retry failed: ${coverage.reason}; using deterministic fallback`);
        coverageRetryCount += 1;
        windowScenes = capScenes(buildFallbackScenes(sceneText));
        ({ progressInfo, cov: coverage, oversized, undersized } = evaluate(windowScenes));
        if (!coverage.ok) {
            throw new Error(`Scene coverage failed after fallback: ${coverage.reason}`);
        }
    }

    if (oversized.length > 0) {
        console.warn(JSON.stringify({
            event: 'scene_duration_over_max',
            step_index: stepIndex,
            max_sec: SCENE_MAX_SEC,
            oversized: oversized.map(o => ({ scene_index: o.i, est_sec: o.dur })),
        }));
    }

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

    // ── Scene enrichment (separate pass: add environment) ──
    windowScenes = await stepEnrichScenes(sessionId, windowScenes, characters, locations, stepIndex, _progress);

    const enrichedScenes = [];
    for (let si = 0; si < windowScenes.length; si++) {
        const scene = windowScenes[si];
        const globalSceneIndex = sceneOffset + si;

        const windowSceneIndex = si + 1;
        const windowTotalScenes = windowScenes.length;
        const windowStartScene = sceneOffset + 1;
        const unitMsg = PROGRESS_STAGES.creating_units(globalSceneIndex);
        publishVBook({
            stage: 'creating_units',
            scene_index: globalSceneIndex + 1,
            total_scenes: sceneOffset + windowTotalScenes,
            window_size: WINDOW_SIZE,
            window_scene_index: windowSceneIndex,
            window_total_scenes: windowTotalScenes,
            window_start_scene: windowStartScene,
            message: unitMsg,
        });
 
        const units = await stepCreateUnits(sessionId, scene, globalSceneIndex, characters, stepIndex, _progress, mentions);

        // ── Coreference Resolution: Assign unit participants ──
        // The LLM already returned participants in stepCreateUnits.
        // Validate character IDs exist in the known characters list.
        const unitParticipants = assignUnitParticipants(units, characters, mentions);
        const resolvedUnitParticipants = applyScenePairParticipantFallback(
            units,
            unitParticipants,
            scene.participants || []
        );
        const unitsWithParticipants = units.map((u, ui) => ({
            ...u,
            participants: resolvedUnitParticipants[ui] || u.participants || [],
        }));
        const visualMsg = PROGRESS_STAGES.creating_visuals(globalSceneIndex);
        publishVBook({
            stage: 'creating_visuals',
            scene_index: globalSceneIndex + 1,
            total_scenes: sceneOffset + windowTotalScenes,
            window_size: WINDOW_SIZE,
            window_scene_index: windowSceneIndex,
            window_total_scenes: windowTotalScenes,
            window_start_scene: windowStartScene,
            message: visualMsg,
        });
 
        const visualUnits = await stepCreateVisuals(sessionId, scene, unitsWithParticipants, globalSceneIndex, characters, locations, stepIndex, _progress);
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
        mentions,
        scenes: enrichedScenes,
        allScenes: windowScenes,
        sceneConsumedLength: (progressInfo.nextOffset ?? coverage.next_offset) - sourceOffsetBase,
        nextOffset: progressInfo.nextOffset ?? coverage.next_offset,
        coverage,
    };
}

// Forward-declare for bootstrapNextWindow

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
            all_mentions: result.mentions,
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
            mentions: result.mentions,
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

            if (prevStatus === 'completed') {
                console.log(`[AGENT] bootstrapNextWindow: previous session completed, all done`);
                return { session_id: null, cached: false, added_scenes: 0, all_done: true };
            }

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

    const windowInfo = getWindowText(draft.sourceText, existingChars, existingLocs, 1, currentOffset);

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
            existingMentions: windowData?.all_mentions || {},
        });

        const extraScenes = [];

        const sceneConsumedOffset = result.nextOffset ?? result.coverage?.next_offset;
        if (!Number.isFinite(sceneConsumedOffset) || sceneConsumedOffset <= windowInfo.windowStartOffset) {
            throw new Error('Scene progress did not advance from current source position');
        }
        const actualRemaining = draft.sourceText.substring(sceneConsumedOffset).trim();

        const bookResult = lazyBook.appendToBook(bookId, {
            characters: result.characters,
            locations: result.locations,
            mentions: result.mentions,
            scenes: result.scenes,
            maxScenes: MAX_SCENES_PER_CHUNK,
            chapterTitle: windowInfo.chapterTitle || `Глава ${nextChapterIndex + 1}`,
            chapterIndex: nextChapterIndex,
            structure: structure,
        });

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
            all_mentions: result.mentions,
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
    // Coreference resolution exports (simplified)
    assignUnitParticipants,
    applyScenePairParticipantFallback,
    unitTextNeedsScenePairParticipants,
    promptMentionsGenericPeople,
    shouldInjectParticipantPassports,
    getFallbackVisual,
};
