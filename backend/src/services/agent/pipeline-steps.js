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
    PROGRESS_STAGES, SYSTEM_PROMPTS, MAX_SCENES_PER_CHUNK,
    SCENE_TARGET_SEC, SCENE_MAX_SEC,
} = require('../agent-prompts');
const { normalizeCharacterRefs } = require('../../image/image-service');
const { extractSceneTitle, isGenericSceneTitle } = require('../../utils/scene-title-utils');

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
        .replace('%REFERENCE_EXAMPLES%', examplesSection)
        .replace(/%MAX_SCENES%/g, MAX_SCENES_PER_CHUNK);

    let repairText = '';
    if (repairHint) {
        if (repairHint.duration_preview) {
            repairText = `\n\n=== DURATION LIMIT VIOLATION (ATTENTION) ===\n\nThe previous scene split had scenes that exceeded the absolute maximum duration.\n\nHard limit: ${SCENE_MAX_SEC} seconds (absolute, must NOT exceed).\nTarget duration: ~${SCENE_TARGET_SEC} seconds (preferred).\n\nDuration breakdown of violations:\n${repairHint.duration_preview}\n\nYou MUST fix EVERY scene listed above. For each violating scene, choose one:\n  (A) SHORTEN — keep only essential narration, trim verbose description. Use this when\n      the text can convey the same meaning in fewer words.\n  (B) SPLIT — divide the single long scene into TWO OR MORE shorter scenes, each ending\n      on a complete sentence and each with estimated duration ≤ ${SCENE_MAX_SEC}s.\n      Use this when the scene contains too much essential content for one scene.\n\nRules:\n- Each resulting scene MUST have estimated duration ≤ ${SCENE_MAX_SEC}s (~${Math.round(SCENE_MAX_SEC / 0.3)} words).\n- Target ~${SCENE_TARGET_SEC}s (~${Math.round(SCENE_TARGET_SEC / 0.3)} words) per scene.\n- Every scene must begin and end on a COMPLETE sentence.\n- Do NOT lose content — use split (B) if shortening would remove essential text.\n- Do NOT create gaps or overlaps between returned scenes.\n- Return at most ${MAX_SCENES_PER_CHUNK} scenes, stop after scene ${MAX_SCENES_PER_CHUNK}; unused tail text is allowed.`;
        } else {
            repairText = `\n\nPrevious scene split failed source coverage validation.\nReason: ${repairHint.reason || 'unknown'}.\nMissing or problematic source fragment:\n\`\`\`\n${repairHint.gap_preview || ''}\n\`\`\`\nReturn a corrected split that starts at the first narrative word and covers a contiguous prefix of the provided text without gaps. Return at most ${MAX_SCENES_PER_CHUNK} scenes and stop after scene ${MAX_SCENES_PER_CHUNK}; unused tail text is allowed.`;
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

        const withTitle = scenes.filter(s => s.title).length;
        const withLoc = scenes.filter(s => s.location?.id).length;
        const missingTitle = scenes.length - withTitle;
        const missingLoc = scenes.length - withLoc;
        const s0 = scenes[0] || {};
        console.log(`[AGENT] Step 3 (scenes): ${scenes.length} created, title=${withTitle}/${scenes.length}, location.id=${withLoc}/${scenes.length}, s0.keys=[${Object.keys(s0).join(',')}], s0.title=${JSON.stringify(s0.title)}, s0.location=${JSON.stringify(s0.location)}`);
        if (missingTitle > 0) {
            console.warn(`[AGENT] Step 3: ${missingTitle} scenes MISSING title`);
        }
        if (missingLoc > 0) {
            console.warn(`[AGENT] Step 3: ${missingLoc} scenes MISSING location.id`);
        }

        await aiCaller.logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, scenes);
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
            if (enrichment.location?.id && !mergedLocation.id) {
                mergedLocation.id = enrichment.location.id;
            }
            if (enrichment.location?.environment) {
                mergedLocation.environment = enrichment.location.environment;
            }

            // Scene title from enrichment (AI generates titles; fallback to extractSceneTitle)
            let mergedTitle = scene.title;
            if (enrichment.title && !isGenericSceneTitle(enrichment.title)) {
                mergedTitle = enrichment.title;
            } else if (!mergedTitle || isGenericSceneTitle(mergedTitle)) {
                mergedTitle = extractSceneTitle(scene.text || '', si);
            }

            return {
                ...scene,
                title: mergedTitle,
                location: mergedLocation,
            };
        });

        const goodTitles = enriched.filter(s => s.title && !isGenericSceneTitle(s.title)).length;
        await aiCaller.logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, enriched);
        console.log(`[AGENT] Step enrich (scenes): ${enriched.length} enriched, titles=${goodTitles}/${enriched.length}`);
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

async function stepGenerateVoices(sessionId, text, characters, stepIndex, progress) {
    const _progress = progress || (() => {});
    _progress({ stage: 'voice_generation', message: PROGRESS_STAGES.voice_generation });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.voice_generation });

    const viableChars = (characters || []).filter(c => c.id && c.name);
    if (viableChars.length === 0) {
        console.log('[AGENT] Step voice_generation: skipped — no characters to generate voices for');
        return { voices: {} };
    }

    // Check if all characters already have meaningful voice descriptions (more than just defaults)
    // We consider a voice "meaningful" if it's longer than ~30 chars and not a generic fallback.
    const charsWithoutVoice = viableChars.filter(c => {
        const v = c.voice || '';
        // Consider a voice missing if: empty, very short, or matches known generic patterns
        return !v || v.length < 20 || /character voice|natural intonation|matching/i.test(v);
    });

    if (charsWithoutVoice.length === 0 && viableChars.every(c => c.voice && c.voice.length >= 30)) {
        console.log('[AGENT] Step voice_generation: skipped — all characters already have meaningful voice descriptions');
        return { voices: {} };
    }

    const step = await createStep(sessionId, 'generate_voices', stepIndex || 0);

    const charsContext = viableChars.map(c =>
        `- ${c.id}: ${c.name}\n` +
        `  role: ${c.role || 'unknown'}\n` +
        `  description: ${(c.description || '').substring(0, 300)}\n` +
        `  appearance: ${(c.appearance || c.passport?.base_appearance || c.passport?.detailed_appearance || '').substring(0, 400)}\n` +
        `  traits: ${(c.traits || []).slice(0, 5).join(', ') || 'none'}\n` +
        `  current_voice: ${c.voice || '(none)'}`
    ).join('\n');

    // Use full text (up to 8000 chars) for dialogue analysis
    const truncatedText = (text || '').length > 8000
        ? (text || '').substring(0, 8000) + '...'
        : (text || '');

    const prompt = SYSTEM_PROMPTS.voice_generation
        .replace('%CHARACTERS%', charsContext)
        .replace('%TEXT%', truncatedText);

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Analyze the source text and generate voice descriptions for characters who have DIALOGUE LINES (speech). Skip characters who only appear in narration and never speak. Do NOT generate narrator voice.\n\nCharacters:\n${charsContext}\n\nSource text for analysis:\n${truncatedText}` },
    ];

    try {
        const result = await aiCaller.callAI(messages, { maxTokens: 4096 });
        const voices = result.voices || {};

        // Update character voice fields ONLY for characters who needed them.
        // Characters that already had good voices are NOT overwritten —
        // this prevents voice drift across pipeline windows.
        const updateTargets = charsWithoutVoice.length > 0
            ? charsWithoutVoice
            : viableChars;
        for (const ch of updateTargets) {
            if (voices[ch.id]?.instruction) {
                ch.voice = voices[ch.id].instruction;
            }
        }

        await aiCaller.logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, { voices: Object.keys(voices).length });
        console.log(`[AGENT] Step voice_generation: ${Object.keys(voices).length}/${viableChars.length} characters got voice descriptions`);
        return { voices };
    } catch (err) {
        await failStep(step.step_id, err.message);
        console.warn(`[AGENT] Step voice_generation FAILED: ${err.message} — keeping existing character voices`);
        return { voices: {} };
    }
}

async function stepReconcilePassports(sessionId, allVisualUnits, characters, stepIndex, progress) {
    const _progress = progress || (() => {});
    _progress({ stage: 'passport_reconciliation', message: PROGRESS_STAGES.passport_reconciliation });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.passport_reconciliation });

    if (!allVisualUnits || allVisualUnits.length === 0) {
        console.log(`[AGENT] Step passport (reconciliation): skipped — no units`);
        return allVisualUnits || [];
    }

    const step = await createStep(sessionId, 'reconcile_passports', stepIndex || 0);

    // Build passport context: only characters that have actual passport data
    // Characters from the agent pipeline have `appearance` field (not passport.*),
    // while characters loaded from characters.json have `passport.*`. Handle both.
    const charsWithPassport = (characters || []).filter(c =>
        c.passport?.base_appearance || c.passport?.detailed_appearance ||
        c.passport?.clothing_base || c.passport?.clothing_details ||
        c.appearance
    );
    const charsContext = charsWithPassport.map(c => {
        const p = c.passport || {};
        // Agent-pipeline characters have `appearance` (not passport.*).
        // Map to passport-like fields so the reconciliation AI can compare.
        const baseAppearance = p.base_appearance || c.appearance || c.description || '(none)';
        const detailedAppearance = p.detailed_appearance || c.appearance || '(none)';
        const clothingBase = p.clothing_base || '(none)';
        const clothingDetails = p.clothing_details || '(none)';
        return `- ${c.id}: ${c.name || c.id}\n` +
            `  base_appearance: ${baseAppearance}\n` +
            `  detailed_appearance: ${detailedAppearance.substring(0, 200)}\n` +
            `  clothing_base: ${clothingBase}\n` +
            `  clothing_details: ${clothingDetails.substring(0, 200)}`;
    }).join('\n') || 'None';

    const unitsStr = allVisualUnits.map((u, i) =>
        `Unit ${i}: scene_index=${u.sceneIndex}, unit_index=${u.unitIndex}, scene_title="${u.sceneTitle || ''}", ` +
        `type="${u.type || 'unknown'}", shot="${u.visual?.shot || 'unknown'}", ` +
        `prompt="${(u.visual?.prompt || '').substring(0, 300)}"`
    ).join('\n');

    const prompt = SYSTEM_PROMPTS.passport_reconciliation
        .replace('%CHARACTERS%', charsContext)
        .replace('%UNITS%', unitsStr);

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Reconcile these ${allVisualUnits.length} visual units against character passports:\n\n${unitsStr}` },
    ];

    try {
        const result = await aiCaller.callAI(messages, { maxTokens: 4096 });
        const reconciled = result.units || [];

        // Merge AI results back, preserving original fields and only updating visual.prompt
        const merged = allVisualUnits.map((original, i) => {
            const rec = reconciled.find(r => r.scene_index === original.sceneIndex && r.unit_index === original.unitIndex);
            if (rec && rec.visual?.prompt) {
                const mergedVisual = {
                    ...original.visual,
                    shot: rec.visual.shot || original.visual.shot,
                    prompt: rec.visual.prompt || original.visual.prompt,
                };
                return { ...original, visual: mergedVisual };
            }
            return original;
        });

        await aiCaller.logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, { units: merged.length });

        const changedCount = merged.filter((m, i) => {
            const orig = allVisualUnits[i];
            return m.visual?.prompt !== orig.visual?.prompt;
        }).length;
        console.log(`[AGENT] Step passport (reconciliation): ${merged.length} units, ${changedCount} deduped`);

        return merged;
    } catch (err) {
        await failStep(step.step_id, `Passport reconciliation failed: ${err.message}`);
        console.warn(`[AGENT] Step passport (reconciliation) FAILED, keeping original units: ${err.message}`);
        return allVisualUnits;
    }
}

async function stepPolishStoryboard(sessionId, allVisualUnits, characters, locations, stepIndex, progress) {
    const _progress = progress || (() => {});
    _progress({ stage: 'polishing_storyboard', message: PROGRESS_STAGES.polishing_storyboard });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.polishing_storyboard });

    if (!allVisualUnits || allVisualUnits.length < 2) {
        console.log(`[AGENT] Step 6 (storyboard polish): skipped — ${allVisualUnits?.length || 0} unit(s), need >= 2`);
        return allVisualUnits || [];
    }

    const step = await createStep(sessionId, 'polish_storyboard', stepIndex || 0);

    const charsContext = (characters || []).map(c => `- ${c.id}: ${c.name} (${c.role || 'unknown'})`).join('\n') || 'None';
    const locsContext = (locations || []).map(l => `- ${l.id}: ${l.name} (${l.type || 'unknown'})`).join('\n') || 'None';

    // Build scene context: unique scenes with full text for plot understanding
    const seenScenes = new Set();
    const scenesParts = [];
    for (const u of allVisualUnits) {
        const key = `${u.sceneIndex}:${u.sceneTitle}`;
        if (!seenScenes.has(key) && u.sceneText) {
            seenScenes.add(key);
            const truncated = u.sceneText.length > 1200 ? u.sceneText.substring(0, 1200) + '...' : u.sceneText;
            scenesParts.push(`--- Scene ${u.sceneIndex}: "${u.sceneTitle || 'Untitled'}" ---\n${truncated}\n`);
        }
    }
    const scenesStr = scenesParts.join('\n');

    const unitsStr = allVisualUnits.map((u, i) =>
        `Unit ${i}: scene_index=${u.sceneIndex}, unit_index=${u.unitIndex}, scene_title="${u.sceneTitle || ''}", type="${u.type || 'unknown'}", shot="${u.visual?.shot || 'unknown'}", prompt="${(u.visual?.prompt || '').substring(0, 200)}"`
    ).join('\n');

    const prompt = SYSTEM_PROMPTS.storyboard_polish
        .replace('%CHARACTERS%', charsContext)
        .replace('%LOCATIONS%', locsContext)
        .replace('%SCENES%', scenesStr || '(no scene text available)')
        .replace('%UNITS%', unitsStr);

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Review and polish these ${allVisualUnits.length} visual units for storyboard continuity:\n\n${unitsStr}` },
    ];

    try {
        const result = await aiCaller.callAI(messages, { maxTokens: 4096 });
        const polishedUnits = result.units || [];

        // Merge AI results back, preserving original fields and only updating visual
        const merged = allVisualUnits.map((original, i) => {
            const polished = polishedUnits.find(p => p.scene_index === original.sceneIndex && p.unit_index === original.unitIndex);
            if (polished && polished.visual) {
                const mergedVisual = {
                    ...original.visual,
                    shot: polished.visual.shot || original.visual.shot,
                    prompt: polished.visual.prompt || original.visual.prompt,
                };
                return { ...original, visual: mergedVisual };
            }
            return original;
        });

        await aiCaller.logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, { units: merged.length });

        const changedCount = merged.filter((m, i) => {
            const orig = allVisualUnits[i];
            return m.visual?.prompt !== orig.visual?.prompt || m.visual?.shot !== orig.visual?.shot;
        }).length;
        console.log(`[AGENT] Step 6 (storyboard polish): ${merged.length} units reviewed, ${changedCount} modified`);

        return merged;
    } catch (err) {
        await failStep(step.step_id, `Storyboard polish failed: ${err.message}`);
        console.warn(`[AGENT] Step 6 (storyboard polish) FAILED, keeping original units: ${err.message}`);
        return allVisualUnits;
    }
}

async function stepCreateVisuals(sessionId, scene, units, sceneIndex, characters, locations, stepIndex, progress, nextScene, mentions) {
    const _progress = progress || (() => {});
    const msg = PROGRESS_STAGES.creating_visuals(sceneIndex);
    _progress({ stage: 'creating_visuals', message: msg });
    await updateSession(sessionId, { progress_msg: msg });

    const step = await createStep(sessionId, 'create_visual_prompts', stepIndex || 0, sceneIndex);

    const locName = scene.location?.id || 'the scene';
    const locObj = (locations || []).find(l => l.id === locName);
    const locDisplay = locObj?.name || locName.replace(/_/g, ' ');
    const contextParts = [`Title: ${scene.title || 'Untitled'}`, `Type: ${scene.type || 'narration'}`, `Location: ${locName}`, ''];

    const season = scene.location?.environment?.season;
    if (season) contextParts.push(`Season: ${season}`);

    function hasPassportAppearance(ch) {
        return !!(ch.passport?.base_appearance || ch.passport?.detailed_appearance ||
                  ch.passport?.clothing_base || ch.passport?.clothing_details ||
                  ch.appearance);
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
                // NOTE: passport descriptions intentionally NOT included here.
                // The passport is injected LATER by prompt-builder.js, so the AI
                // must NOT see or re-describe it. Only character_id and name are
                // shown to identify who is in the scene — nothing about appearance.
                visualChars.push(`- ${ch.id}: ${displayName(ch)}`);
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
                // NOTE: no passport description — only character_id and name.
                // Passport is injected later by the system, not by the AI.
                contextParts.push(`- ${ch.id}: ${displayName(ch)}`);
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

    // ── Lookahead context: next scene text for character name disambiguation ──
    if (nextScene && (nextScene.text || nextScene.audio?.full_text)) {
        const nextText = nextScene.audio?.full_text || nextScene.text || '';
        contextParts.push('', '## Context from next scene (character name disambiguation)');
        contextParts.push('The following text appears immediately after the current scene. It may identify by name');
        contextParts.push('characters who are described but not yet named in the current scene. Use this context');
        contextParts.push('to resolve them to their correct character_id from the Character list above.');
        contextParts.push('', `--- next scene text ---\n${nextText.substring(0, 1000)}\n---`);
    }

    // ── Role/title → character_id mappings (mentions/aliases) ──
    const knownIds = new Set((characters || []).map(c => c.id).filter(Boolean));
    if (mentions && typeof mentions === 'object' && Object.keys(mentions).length > 0) {
        const mentionLines = Object.entries(mentions)
            .filter(([, charId]) => knownIds.has(charId))
            .map(([alias, charId]) => `  "${alias}" → ${charId}`);
        if (mentionLines.length > 0) {
            contextParts.push('', '## Alias → character_id mappings');
            contextParts.push('When the scene text refers to a character by a nickname, role, or epithet, use the mapped character_id below:');
            contextParts.push(...mentionLines);
            contextParts.push('Example: if text says "Бездомный" and mapping says "бездомный" → ivan_ponyrev, write "ivan_ponyrev" in the prompt.');
        }
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
                // Participants come from scene.participants (set during scene creation).
                // Character IDs in prompt are normalized via normalizeCharacterRefs.
                let prompt = normalizeCharacterRefs(vu.visual.prompt, characters, mentions);
                return { ...u, visual: { ...vu.visual, prompt } };
            }
            return {
                ...u,
                visual: {
                    shot: u.type === 'dialogue' ? 'medium' : (u.type === 'description' ? 'wide' : 'medium'),
                    prompt: visualUtils.getFallbackVisual(u.text, characters, { ...scene, participants: scene.participants }, locDisplay),
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
                prompt: visualUtils.getFallbackVisual(u.text, characters, { ...scene, participants: scene.participants }, locDisplay),
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
    stepPolishStoryboard,
    stepReconcilePassports,
    stepGenerateVoices,
};
