// ======================================================
// Agent Pipeline Steps
// ======================================================
// Individual AI pipeline steps: structure analysis, character extraction,
// location extraction, scene creation, enrichment, unit creation, visual creation.

const aiCaller = require('./ai-caller');
const visualUtils = require('./visual-utils');
const {
    createStep, completeStep, failStep, updateSession,
} = require('../agent-session');
const {
    PROGRESS_STAGES, SYSTEM_PROMPTS,
} = require('../agent-prompts');
const { normalizeCharacterRefs } = require('../../image/image-service');

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
        const result = await aiCaller.callAI(messages, { maxTokens: 4096 });
        const structure = {
            author: result.author || null,
            title: result.title || null,
            has_prologue: !!result.has_prologue,
            has_epilogue: !!result.has_epilogue,
            parts: Array.isArray(result.parts) ? result.parts : [],
            chapters: Array.isArray(result.chapters) ? result.chapters : [],
            country: result.country || null,
            epoch: result.epoch || null,
        };

        await aiCaller.logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, structure);
        console.log(`[AGENT] Step 0 (structure): author=${structure.author ? '✓' : '✗'}, title=${structure.title ? '✓' : '✗'}, ${structure.chapters.length} chapters, ${structure.parts.length} parts`);
        return structure;
    } catch (err) {
        await failStep(step.step_id, err.message);
        console.error(`[AGENT] Step 0 (structure) FAILED: ${err.message}`);
        return { author: null, title: null, country: null, epoch: null, has_prologue: false, has_epilogue: false, parts: [], chapters: [] };
    }
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
        const result = await aiCaller.callAI(messages, { maxTokens: 4096 });
        const characters = result.characters || [];
        const mentions = result.mentions || {};
        await aiCaller.logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
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
        const result = await aiCaller.callAI(messages, { maxTokens: 4096 });
        const locations = result.locations || [];
        await aiCaller.logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
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

    const examplesContext = visualUtils.formatExamplesForPrompt();
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
            repairText = `\n\nThe previous scene split was too long in places.\nReason: ${repairHint.reason || 'duration_exceeded'}.\nThese scenes exceed the ~30s (~95 word) hard limit and must be split into smaller scenes, each ending on a complete sentence and covering ~20s (~65 words):\n${repairHint.duration_preview}\nReturn a corrected split from the START of the same text, verbatim and in order, with no gaps or overlaps between returned scenes. Return at most 3 scenes and stop after scene 3; unused tail text is allowed.`;
        } else {
            repairText = `\n\nPrevious scene split failed source coverage validation.\nReason: ${repairHint.reason || 'unknown'}.\nMissing or problematic source fragment:\n\`\`\`\n${repairHint.gap_preview || ''}\n\`\`\`\nReturn a corrected split that starts at the first narrative word and covers a contiguous prefix of the provided text without gaps. Return at most 3 scenes and stop after scene 3; unused tail text is allowed.`;
        }
    }

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Split this text into scenes:\n\n\`\`\`\n${text}\n\`\`\`${repairText}` },
    ];

    try {
        const result = await aiCaller.callAI(messages, { maxTokens: 6144 });
        const scenes = result.scenes || [];
        if (scenes.length === 0) throw new Error('AI returned no scenes');
        await aiCaller.logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
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
        const result = await aiCaller.callAI(messages, { maxTokens: 4096 });
        const enrichedList = result.scenes || [];

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

        await aiCaller.logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, enriched);
        console.log(`[AGENT] Step enrich (scenes): ${enriched.length} enriched`);
        return enriched;
    } catch (err) {
        await failStep(step.step_id, `Enrichment failed: ${err.message}`);
        console.warn(`[AGENT] Scene enrichment failed, continuing with base scenes: ${err.message}`);
        return scenes;
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
        const result = await aiCaller.callAI(messages, { maxTokens: 4096 });
        const units = result.units || [];
        if (units.length === 0) {
            units.push({ text: sceneText, type: scene.type === 'dialogue' ? 'dialogue' : 'narration' });
        }
        await aiCaller.logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, units);
        console.log(`[AGENT] Step 4 (units scene ${sceneIndex}): ${units.length} units`);
        return units;
    } catch (err) {
        await failStep(step.step_id, `AI failed, using fallback: ${err.message}`);
        console.warn(`[AGENT] Step 4 (scene ${sceneIndex}) failed, using fallback: ${err.message}`);
        return [{ text: sceneText, type: scene.type === 'dialogue' ? 'dialogue' : 'perception' }];
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

    const season = scene.location?.environment?.season;
    if (season) contextParts.push(`Season: ${season}`);

    function hasPassportAppearance(ch) {
        return !!(ch.passport?.base_appearance || ch.passport?.detailed_appearance ||
                  ch.passport?.clothing_base || ch.passport?.clothing_details);
    }

    function displayName(ch) {
        let name = ch.name || ch.id || '';
        name = name.replace(/\s*\(not named\)/gi, '').trim();
        name = name.replace(/\s*\(unnamed\)/gi, '').trim();
        name = name.replace(/\s*\(not specified\)/gi, '').trim();
        return name || ch.id || '(character)';
    }

    let namedCount = 0;
    const sceneParticipantIds = new Set(scene.participants || []);

    if (scene.type === 'chapter_intro') {
        // no character section for title cards
    } else if (sceneParticipantIds.size > 0) {
        const visualChars = [];
        const facelessChars = [];
        for (const pId of sceneParticipantIds) {
            const ch = (characters || []).find(c => c.id === pId);
            if (!ch) continue;
            if (hasPassportAppearance(ch)) {
                const passportDesc = [ch.passport?.base_appearance, ch.passport?.detailed_appearance, ch.passport?.clothing_base, ch.passport?.clothing_details].filter(Boolean).join('; ');
                visualChars.push(`- ${ch.id}: ${displayName(ch)} — ${passportDesc || ch.description || ''}`);
                namedCount++;
            } else {
                facelessChars.push(displayName(ch));
            }
        }
        if (visualChars.length > 0) {
            contextParts.push('Characters in scene (use their character_id in every prompt — no pronouns, no names):');
            contextParts.push(...visualChars);
        }
        if (facelessChars.length > 0) {
            contextParts.push('Other characters (no passport — describe naturally from scene context, do NOT use character_id):');
            contextParts.push(`  ${facelessChars.join(', ')}`);
        }
        if (namedCount === 0 && facelessChars.length === 0) {
            contextParts.push('(unknown characters)');
        }
    } else if (characters?.length) {
        const visualChars = (characters || []).filter(hasPassportAppearance);
        if (visualChars.length > 0) {
            contextParts.push('Characters likely in scene (use character_id matching the scene text below — verify before using):');
            const limit = Math.min(visualChars.length, 5);
            for (let ci = 0; ci < limit; ci++) {
                const ch = visualChars[ci];
                contextParts.push(`- ${ch.id}: ${displayName(ch)} — ${ch.passport?.base_appearance || ch.description || ''}`);
                namedCount++;
            }
            if (visualChars.length > 5) {
                contextParts.push(`  ... and ${visualChars.length - 5} more characters with passports in this chapter`);
            }
        }
        const facelessCount = characters.length - visualChars.length;
        if (facelessCount > 0) {
            contextParts.push(`Other characters in this chapter (no passport — describe from scene context when they appear): ${facelessCount} un-named/generic`);
        }
    }

    const sceneFullText = scene.audio?.full_text || scene.text || units.map(u => u.text).filter(Boolean).join(' ');
    if (sceneFullText) {
        contextParts.push('', `Full scene text:\n${sceneFullText.substring(0, 1500)}`);
    }
    const contextStr = contextParts.join('\n');

    const unitsStr = units.map((u, i) =>
        `Unit ${i + 1}: text="${(u.text || '').substring(0, 300)}", type="${u.type || 'perception'}"`
    ).join('\n');

    const prompt = SYSTEM_PROMPTS.visuals
        .replace('%CONTEXT%', contextStr)
        .replace('%EXAMPLES%', visualUtils.buildVisualExemplars())
        .replace('%UNITS%', unitsStr);

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Add visual prompts to each unit. Return the same units with visual fields added.\n\n${unitsStr}` },
    ];

    try {
        const result = await aiCaller.callAI(messages, { maxTokens: 4096 });
        const visualUnits = result.units || [];

        const merged = units.map((u, i) => {
            const vu = visualUnits[i];
            if (vu && vu.visual) {
                // Participants are inferred from visual prompt text via inferCharactersFromPrompt
                let prompt = normalizeCharacterRefs(vu.visual.prompt, characters);
                return { ...u, visual: { ...vu.visual, prompt } };
            }
            return {
                ...u,
                visual: {
                    shot: u.type === 'dialogue' ? 'medium' : (u.type === 'description' ? 'wide' : 'medium'),
                    prompt: visualUtils.getFallbackVisual(u.text, characters, { ...scene, participants: scene.participants }),
                    character_binding: true,
                },
            };
        });

        await aiCaller.logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
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
                prompt: visualUtils.getFallbackVisual(u.text, characters, { ...scene, participants: scene.participants }),
                character_binding: true,
            },
        }));
    }
}

module.exports = {
    stepAnalyzeStructure,
    stepExtractCharacters,
    stepExtractLocations,
    stepCreateScenes,
    stepEnrichScenes,
    stepCreateUnits,
    stepCreateVisuals,
};
