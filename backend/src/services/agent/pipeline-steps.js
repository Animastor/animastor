// ======================================================
// Agent Pipeline Steps
// ======================================================
// Individual AI pipeline steps: structure analysis, character extraction,
// location extraction, scene creation (title + location + environment-override),
// unit creation, visual creation.

const aiCaller = require('./ai-caller');
const imageUtils = require('./image-utils');
const promptProfileLoader = require('../prompt-profile-loader');
const {
    createStep, completeStep, failStep, updateSession,
} = require('../agent-session');
const {
    PROGRESS_STAGES, SYSTEM_PROMPTS, MAX_SCENES_PER_CHUNK,
    IMAGE_PROMPT_MAX_CHARS, UNIT_TEXT_MAX_CHARS, SCENE_TEXT_MAX_CHARS,
    buildLangInstruction,
} = require('../agent-prompts');
const { normalizeCharacterRefs } = require('../../image/image-service');

/**
 * Build the location context block for agent prompts.
 * Includes each location's GLOBAL environment template so the scene split step
 * can check the scene against it and write only per-scene overrides.
 */
function buildLocationsContext(locations) {
    return (locations || []).map(l => {
        const env = l.environment || {};
        const envParts = ['time', 'season', 'lighting', 'weather', 'mood', 'atmosphere']
            .filter(k => env[k])
            .map(k => `${k}: ${env[k]}`);
        const envStr = envParts.length > 0 ? ` (default environment: ${envParts.join(', ')})` : '';
        return `- ${l.id}: ${l.name || l.id} (${l.type || 'unknown'})${envStr}`;
    }).join('\n') || 'None';
}

// ── Out-of-format prompt guard ──────────────────────────────────────
// Work items (image.prompt / video.action) longer than IMAGE_PROMPT_MAX_CHARS are
// excluded from reconciliation/polish passes AND never overwritten by their
// results: a model that only sees a fragment would silently rewrite the unseen
// part. See agent-prompts.js for the policy.
function inPromptRange(u) {
    return (u.image?.prompt || '').length <= IMAGE_PROMPT_MAX_CHARS;
}
function inActionRange(u) {
    return (u.video?.action || '').length <= IMAGE_PROMPT_MAX_CHARS;
}

// Format one unit for reconciliation/polish agents. JSON encoding keeps the row
// unambiguous when unit text / prompts contain quotes or newlines.
function unitRow(u) {
    return JSON.stringify({
        scene_index: u.sceneIndex,
        unit_index: u.unitIndex,
        scene_title: u.sceneTitle || '',
        type: u.type || 'unknown',
        text: (u.text || '').substring(0, UNIT_TEXT_MAX_CHARS),
        shot: u.image?.shot || 'unknown',
        prompt: u.image?.prompt || '',
        action: u.video?.action || '',
    });
}

// Allowed per-scene environment override fields (subset of the location template
// + country/epoch for deviations from the book's default setting).
const SCENE_ENV_FIELDS = ['time', 'season', 'lighting', 'weather', 'mood', 'atmosphere', 'country', 'epoch'];

/**
 * Normalize a scene's location.environment: keep ONLY known fields with
 * non-empty string values; drop the environment object entirely if empty
 * (including when the AI returned only hallucinated/unknown fields).
 * Guards against hallucinated fields from the scene split step.
 */
function normalizeSceneEnvironment(scene) {
    const loc = scene.location;
    if (!loc || typeof loc !== 'object') return scene;
    const raw = loc.environment;
    if (!raw || typeof raw !== 'object') return scene;
    const clean = {};
    for (const key of SCENE_ENV_FIELDS) {
        const v = raw[key];
        if (typeof v === 'string' && v.trim()) clean[key] = v.trim();
    }
    if (Object.keys(clean).length === 0) {
        // Nothing valid remained — drop the environment entirely (removes
        // hallucinated junk fields and lets the location template be the
        // fallback at prompt build time).
        const newLoc = { ...loc };
        delete newLoc.environment;
        return { ...scene, location: newLoc };
    }
    return { ...scene, location: { ...loc, environment: clean } };
}

async function stepAnalyzeStructure(sessionId, sourceText, stepIndex, progress, language) {
    const _progress = progress || (() => {});
    _progress({ stage: 'analyzing_structure', message: PROGRESS_STAGES.analyzing_structure });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.analyzing_structure });

    const step = await createStep(sessionId, 'analyze_structure', stepIndex || 0);

    const lines = sourceText.split('\n');
    const sampleLines = lines.slice(0, 80).join('\n');

    const messages = [
        { role: 'system', content: SYSTEM_PROMPTS.structure.replace('%LANGUAGE%', buildLangInstruction(language)) },
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

async function stepExtractCharacters(sessionId, text, stepIndex, progress, language) {
    const _progress = progress || (() => {});
    _progress({ stage: 'extracting_chars', message: PROGRESS_STAGES.extracting_chars });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.extracting_chars });

    const step = await createStep(sessionId, 'analyze_characters', stepIndex || 0);

    const messages = [
        { role: 'system', content: SYSTEM_PROMPTS.characters.replace('%LANGUAGE%', buildLangInstruction(language)) },
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

async function stepExtractLocations(sessionId, text, characters, stepIndex, progress, language) {
    const _progress = progress || (() => {});
    _progress({ stage: 'extracting_locs', message: PROGRESS_STAGES.extracting_locs });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.extracting_locs });

    const step = await createStep(sessionId, 'analyze_locations', stepIndex || 0);

    const charsContext = (characters || []).map(c => `- ${c.id}: ${c.name} (${c.role || 'unknown'})`).join('\n') || 'No characters yet';
    const prompt = SYSTEM_PROMPTS.locations
        .replace('%EXISTING_CHARACTERS%', charsContext)
        .replace('%LANGUAGE%', buildLangInstruction(language));

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

async function stepCreateScenes(sessionId, text, characters, locations, stepIndex, progress, repairHint, chunkSize, language, bookDefault) {
    // No artificial limit — AI creates natural narrative episodes.
    // The pipeline caps to chunkSize later and caches extras.
    const _progress = progress || (() => {});
    _progress({ stage: 'creating_scenes', message: PROGRESS_STAGES.creating_scenes });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.creating_scenes });

    const step = await createStep(sessionId, 'create_scenes', stepIndex || 0);

    const charsContext = (characters || []).map(c => `- ${c.id}: ${c.name}`).join('\n') || 'None';
    const locsContext = buildLocationsContext(locations);

    // Book-level default country/epoch (from stepAnalyzeStructure) — tells the
    // scene split agent what the book's default setting is, so it can write
    // country/epoch overrides ONLY for scenes that genuinely deviate (flashbacks,
    // travel to another country, etc.). When absent, tell the agent to infer.
    const bookDefaultParts = [];
    if (bookDefault?.country) bookDefaultParts.push(`country: ${bookDefault.country}`);
    if (bookDefault?.epoch) bookDefaultParts.push(`epoch: ${bookDefault.epoch}`);
    const bookDefaultStr = bookDefaultParts.length > 0
        ? bookDefaultParts.join('\n')
        : 'not specified — infer the book\'s default country/epoch from the text itself';

    const prompt = SYSTEM_PROMPTS.scenes
        .replace('%EXISTING_CHARACTERS%', charsContext)
        .replace('%EXISTING_LOCATIONS%', locsContext)
        .replace('%BOOK_DEFAULT%', bookDefaultStr)
        .replace('%LANGUAGE%', buildLangInstruction(language));

    let repairText = '';
    if (repairHint) {
        repairText = `\n\nPrevious scene split failed source coverage validation.\nReason: ${repairHint.reason || 'unknown'}.\nMissing or problematic source fragment:\n\`\`\`\n${repairHint.gap_preview || ''}\n\`\`\`\nReturn a corrected split that starts at the first narrative word and covers a contiguous prefix of the provided text without gaps. Do not skip, overlap, paraphrase, or summarize anything inside the returned scenes. Unused tail text is allowed.`;
    }

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Split this text into scenes:\n\n\`\`\`\n${text}\n\`\`\`${repairText}` },
    ];

    try {
        const result = await aiCaller.callAI(messages, { maxTokens: 6144 });
        const scenes = (result.scenes || []).map(normalizeSceneEnvironment);
        if (scenes.length === 0) throw new Error('AI returned no scenes');

        const withTitle = scenes.filter(s => s.title).length;
        const withLoc = scenes.filter(s => s.location?.id).length;
        const withEnv = scenes.filter(s => s.location?.environment && Object.keys(s.location.environment).length > 0).length;
        const missingTitle = scenes.length - withTitle;
        const missingLoc = scenes.length - withLoc;
        const s0 = scenes[0] || {};
        console.log(`[AGENT] Step 3 (scenes): ${scenes.length} created, title=${withTitle}/${scenes.length}, location.id=${withLoc}/${scenes.length}, env.override=${withEnv}/${scenes.length}, s0.keys=[${Object.keys(s0).join(',')}], s0.title=${JSON.stringify(s0.title)}, s0.location=${JSON.stringify(s0.location)}`);
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
    ];        try {
        const result = await aiCaller.callAI(messages, { maxTokens: 4096 });
        const units = result.units || [];
        if (units.length === 0) {
            const fallbackUnit = { text: sceneText, type: scene.type === 'dialogue' ? 'dialogue' : 'narration' };
            if (fallbackUnit.type === 'dialogue') {
                fallbackUnit.audio = { text: sceneText };
            }
            units.push(fallbackUnit);
        }
        // Log speaker presence for dialogue units
        const dialogueUnits = units.filter(u => u.type === 'dialogue');
        const withSpeaker = dialogueUnits.filter(u => u.audio?.speaker);
        if (dialogueUnits.length > 0) {
            console.log(`[AGENT] Step 4 (units scene ${sceneIndex}): ${dialogueUnits.length} dialogue units, ${withSpeaker.length} with audio.speaker`);
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

async function stepGenerateVoices(sessionId, text, characters, stepIndex, progress, language) {
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
        .replace('%TEXT%', truncatedText)
        .replace('%LANGUAGE%', buildLangInstruction(language));

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

    // Exclude out-of-format prompts (legacy values / stray pastes) — see inPromptRange.
    const polishable = allVisualUnits.filter(inPromptRange);
    const excludedCount = allVisualUnits.length - polishable.length;
    if (polishable.length === 0) {
        console.log(`[AGENT] Step passport (reconciliation): skipped — all ${allVisualUnits.length} unit(s) have out-of-format prompts (>${IMAGE_PROMPT_MAX_CHARS} chars)`);
        return allVisualUnits;
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

    const unitsStr = polishable.map(unitRow).join('\n');

    const prompt = SYSTEM_PROMPTS.passport_reconciliation
        .replace('%CHARACTERS%', charsContext)
        .replace('%UNITS%', unitsStr);

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Reconcile these ${polishable.length} visual units against character passports:\n\n${unitsStr}` },
    ];

    try {
        const result = await aiCaller.callAI(messages, { maxTokens: 4096 });
        const reconciled = result.units || [];

        // Merge AI results back, preserving original fields and only updating visual.prompt
        const merged = allVisualUnits.map((original, i) => {
            const rec = reconciled.find(r => r.scene_index === original.sceneIndex && r.unit_index === original.unitIndex);
            if (rec && rec.image?.prompt && inPromptRange(original)) {
                const mergedPrompt = rec.image.prompt || original.image?.prompt;
                return {
                    ...original,
                    image: {
                        shot: rec.image.shot || original.image?.shot || 'wide',
                        prompt: mergedPrompt,
                        style: rec.image?.style || original.image?.style,
                        negative: rec.image?.negative || original.image?.negative,
                    },
                    video: {
                        action: original.video?.action || mergedPrompt,
                    },
                };
            }
            return original;
        });

        await aiCaller.logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, { units: merged.length });

        const changedCount = merged.filter((m, i) => {
            const orig = allVisualUnits[i];
            return m.image?.prompt !== orig.image?.prompt;
        }).length;
        console.log(`[AGENT] Step passport (reconciliation): ${polishable.length} units reviewed, ${excludedCount} excluded (prompt >${IMAGE_PROMPT_MAX_CHARS} chars), ${changedCount} changed`);

        return merged;
    } catch (err) {
        await failStep(step.step_id, `Passport reconciliation failed: ${err.message}`);
        console.warn(`[AGENT] Step passport (reconciliation) FAILED, keeping original units: ${err.message}`);
        return allVisualUnits;
    }
}

async function stepReconcileVideoActions(sessionId, allVisualUnits, characters, stepIndex, progress, promptProfiles) {
    const _progress = progress || (() => {});
    _progress({ stage: 'video_action_reconciliation', message: PROGRESS_STAGES.video_action_reconciliation });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.video_action_reconciliation });

    if (!allVisualUnits || allVisualUnits.length === 0) {
        console.log(`[AGENT] Step video_action_reconciliation: skipped — no units`);
        return allVisualUnits || [];
    }

    // Exclude out-of-format video actions (legacy values / stray pastes) — see inActionRange.
    const polishable = allVisualUnits.filter(inActionRange);
    const excludedCount = allVisualUnits.length - polishable.length;
    if (polishable.length === 0) {
        console.log(`[AGENT] Step video_action_reconciliation: skipped — all ${allVisualUnits.length} unit(s) have out-of-format actions (>${IMAGE_PROMPT_MAX_CHARS} chars)`);
        return allVisualUnits;
    }

    const step = await createStep(sessionId, 'reconcile_video_actions', stepIndex || 0);

    const unitsStr = polishable.map(unitRow).join('\n');

    // Inject video prompt profile if available
    let videoReconPrompt = SYSTEM_PROMPTS.video_action_reconciliation;
    if (promptProfiles?.videoProfile) {
        const skillSection = promptProfileLoader.buildSkillSection('video', promptProfiles.videoProfile);
        if (skillSection) {
            videoReconPrompt = `${skillSection}\n\n${videoReconPrompt}`;
        }
    }

    const messages = [
        { role: 'system', content: videoReconPrompt },
        { role: 'user', content: `Fix video.action for these ${polishable.length} units — ensure each describes temporal/dynamic change only, not static composition:\n\n${unitsStr}` },
    ];

    try {
        const result = await aiCaller.callAI(messages, { maxTokens: 4096 });
        const reconciled = result.units || [];

        // Merge AI results back, preserving original fields and only updating video.action
        const merged = allVisualUnits.map((original, i) => {
            const rec = reconciled.find(r => r.scene_index === original.sceneIndex && r.unit_index === original.unitIndex);
            if (rec && rec.video?.action && inActionRange(original)) {
                return {
                    ...original,
                    video: {
                        action: rec.video.action,
                    },
                };
            }
            return original;
        });

        await aiCaller.logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, { units: merged.length });

        const changedCount = merged.filter((m, i) => {
            const orig = allVisualUnits[i];
            return m.video?.action !== orig.video?.action;
        }).length;
        console.log(`[AGENT] Step video_action_reconciliation: ${polishable.length} units reviewed, ${excludedCount} excluded (action >${IMAGE_PROMPT_MAX_CHARS} chars), ${changedCount} actions fixed`);

        return merged;
    } catch (err) {
        await failStep(step.step_id, `Video action reconciliation failed: ${err.message}`);
        console.warn(`[AGENT] Step video_action_reconciliation FAILED, keeping original units: ${err.message}`);
        return allVisualUnits;
    }
}

async function stepPolishStoryboard(sessionId, allVisualUnits, characters, locations, stepIndex, progress, promptProfiles) {
    const _progress = progress || (() => {});
    _progress({ stage: 'polishing_storyboard', message: PROGRESS_STAGES.polishing_storyboard });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.polishing_storyboard });

    if (!allVisualUnits || allVisualUnits.length < 2) {
        console.log(`[AGENT] Step 6 (storyboard polish): skipped — ${allVisualUnits?.length || 0} unit(s), need >= 2`);
        return allVisualUnits || [];
    }

    // Exclude out-of-format prompts (legacy values / stray pastes) — see inPromptRange.
    const polishable = allVisualUnits.filter(inPromptRange);
    const excludedCount = allVisualUnits.length - polishable.length;
    if (polishable.length < 2) {
        console.log(`[AGENT] Step 6 (storyboard polish): skipped — ${polishable.length} in-format unit(s) remain after excluding ${excludedCount} with prompt >${IMAGE_PROMPT_MAX_CHARS} chars, need >= 2`);
        return allVisualUnits;
    }

    const step = await createStep(sessionId, 'polish_storyboard', stepIndex || 0);

    const charsContext = (characters || []).map(c => `- ${c.id}: ${c.name} (${c.role || 'unknown'})`).join('\n') || 'None';
    const locsContext = buildLocationsContext(locations);

    // Build scene context: unique scenes with full text for plot understanding
    const seenScenes = new Set();
    const scenesParts = [];
    for (const u of allVisualUnits) {
        const key = `${u.sceneIndex}:${u.sceneTitle}`;
        if (!seenScenes.has(key) && u.sceneText) {
            seenScenes.add(key);
            const truncated = u.sceneText.length > SCENE_TEXT_MAX_CHARS ? u.sceneText.substring(0, SCENE_TEXT_MAX_CHARS) + '...' : u.sceneText;
            scenesParts.push(`--- Scene ${u.sceneIndex}: "${u.sceneTitle || 'Untitled'}" ---\n${truncated}\n`);
        }
    }
    const scenesStr = scenesParts.join('\n');

    const unitsStr = polishable.map(unitRow).join('\n');

    let polishPrompt = SYSTEM_PROMPTS.storyboard_polish;

    // Inject image prompt profile if available (for shot type, style rules)
    if (promptProfiles?.imageProfile) {
        const skillSection = promptProfileLoader.buildSkillSection('image', promptProfiles.imageProfile);
        if (skillSection) {
            polishPrompt = `${skillSection}\n\n${polishPrompt}`;
        }
    }

    const prompt = polishPrompt
        .replace('%CHARACTERS%', charsContext)
        .replace('%LOCATIONS%', locsContext)
        .replace('%SCENES%', scenesStr || '(no scene text available)')
        .replace('%UNITS%', unitsStr);

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Review and polish these ${polishable.length} visual units for storyboard continuity:\n\n${unitsStr}` },
    ];

    try {
        const result = await aiCaller.callAI(messages, { maxTokens: 4096 });
        const polishedUnits = result.units || [];

        // Merge AI results back, preserving original fields and only updating visual
        const merged = allVisualUnits.map((original, i) => {
            const polished = polishedUnits.find(p => p.scene_index === original.sceneIndex && p.unit_index === original.unitIndex);
            if (polished && polished.image?.prompt && inPromptRange(original)) {
                const mergedPrompt = polished.image.prompt || original.image?.prompt;
                return {
                    ...original,
                    image: {
                        shot: polished.image.shot || original.image?.shot || 'wide',
                        prompt: mergedPrompt,
                        style: polished.image?.style || original.image?.style,
                        negative: polished.image?.negative || original.image?.negative,
                    },
                    video: {
                        action: original.video?.action || mergedPrompt,
                    },
                };
            }
            return original;
        });

        await aiCaller.logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, { units: merged.length });

        const changedCount = merged.filter((m, i) => {
            const orig = allVisualUnits[i];
            return m.image?.prompt !== orig.image?.prompt || m.image?.shot !== orig.image?.shot;
        }).length;
        console.log(`[AGENT] Step 6 (storyboard polish): ${polishable.length} units reviewed, ${excludedCount} excluded (prompt >${IMAGE_PROMPT_MAX_CHARS} chars), ${changedCount} modified`);

        return merged;
    } catch (err) {
        await failStep(step.step_id, `Storyboard polish failed: ${err.message}`);
        console.warn(`[AGENT] Step 6 (storyboard polish) FAILED, keeping original units: ${err.message}`);
        return allVisualUnits;
    }
}

async function stepPolishVideoActions(sessionId, allVisualUnits, characters, locations, stepIndex, progress, promptProfiles) {
    const _progress = progress || (() => {});
    _progress({ stage: 'video_action_polish', message: PROGRESS_STAGES.video_action_polish });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.video_action_polish });

    if (!allVisualUnits || allVisualUnits.length < 2) {
        console.log(`[AGENT] Step video_action_polish: skipped — ${allVisualUnits?.length || 0} unit(s), need >= 2`);
        return allVisualUnits || [];
    }

    // Exclude out-of-format video actions (legacy values / stray pastes) — see inActionRange.
    const polishable = allVisualUnits.filter(inActionRange);
    const excludedCount = allVisualUnits.length - polishable.length;
    if (polishable.length < 2) {
        console.log(`[AGENT] Step video_action_polish: skipped — ${polishable.length} in-format unit(s) remain after excluding ${excludedCount} with action >${IMAGE_PROMPT_MAX_CHARS} chars, need >= 2`);
        return allVisualUnits;
    }

    const step = await createStep(sessionId, 'polish_video_actions', stepIndex || 0);

    const charsContext = (characters || []).map(c => `- ${c.id}: ${c.name} (${c.role || 'unknown'})`).join('\n') || 'None';
    const locsContext = buildLocationsContext(locations);

    // Build scene context: unique scenes with full text for plot understanding
    const seenScenes = new Set();
    const scenesParts = [];
    for (const u of allVisualUnits) {
        const key = `${u.sceneIndex}:${u.sceneTitle}`;
        if (!seenScenes.has(key) && u.sceneText) {
            seenScenes.add(key);
            const truncated = u.sceneText.length > SCENE_TEXT_MAX_CHARS ? u.sceneText.substring(0, SCENE_TEXT_MAX_CHARS) + '...' : u.sceneText;
            scenesParts.push(`--- Scene ${u.sceneIndex}: "${u.sceneTitle || 'Untitled'}" ---\n${truncated}\n`);
        }
    }
    const scenesStr = scenesParts.join('\n');

    const unitsStr = polishable.map(unitRow).join('\n');

    let polishPrompt = SYSTEM_PROMPTS.video_action_polish;

    // Inject video prompt profile if available (for motion rules, camera vocabulary)
    if (promptProfiles?.videoProfile) {
        const skillSection = promptProfileLoader.buildSkillSection('video', promptProfiles.videoProfile);
        if (skillSection) {
            polishPrompt = `${skillSection}\n\n${polishPrompt}`;
        }
    }

    const prompt = polishPrompt
        .replace('%CHARACTERS%', charsContext)
        .replace('%LOCATIONS%', locsContext)
        .replace('%SCENES%', scenesStr || '(no scene text available)')
        .replace('%UNITS%', unitsStr);

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Review and polish video.actions for continuity and narrative consistency across these ${polishable.length} units:\n\n${unitsStr}` },
    ];

    try {
        const result = await aiCaller.callAI(messages, { maxTokens: 4096 });
        const polishedUnits = result.units || [];

        // Merge AI results back, preserving original fields and only updating video.action
        const merged = allVisualUnits.map((original, i) => {
            const polished = polishedUnits.find(p => p.scene_index === original.sceneIndex && p.unit_index === original.unitIndex);
            if (polished && polished.video?.action && inActionRange(original)) {
                return {
                    ...original,
                    video: {
                        action: polished.video.action,
                    },
                };
            }
            return original;
        });

        await aiCaller.logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, { units: merged.length });

        const changedCount = merged.filter((m, i) => {
            const orig = allVisualUnits[i];
            return m.video?.action !== orig.video?.action;
        }).length;
        console.log(`[AGENT] Step video_action_polish: ${polishable.length} units reviewed, ${excludedCount} excluded (action >${IMAGE_PROMPT_MAX_CHARS} chars), ${changedCount} actions polished`);

        return merged;
    } catch (err) {
        await failStep(step.step_id, `Video action polish failed: ${err.message}`);
        console.warn(`[AGENT] Step video_action_polish FAILED, keeping original units: ${err.message}`);
        return allVisualUnits;
    }
}

async function stepCreateVisuals(sessionId, scene, units, sceneIndex, characters, locations, stepIndex, progress, nextScene, mentions, promptProfiles) {
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

    // Inject prompt profiles if available — model-specific rules for image & video
    let visualsPrompt = SYSTEM_PROMPTS.visuals;
    if (promptProfiles) {
        const imageSkill = promptProfiles.imageProfile
            ? promptProfileLoader.buildSkillSection('image', promptProfiles.imageProfile)
            : '';
        const videoSkill = promptProfiles.videoProfile
            ? promptProfileLoader.buildSkillSection('video', promptProfiles.videoProfile)
            : '';
        const skillBlock = [imageSkill, videoSkill].filter(Boolean).join('\n');
        if (skillBlock) {
            visualsPrompt = `${skillBlock}\n\n${visualsPrompt}`;
        }
    }

    const prompt = visualsPrompt
        .replace('%CONTEXT%', contextStr)
        .replace('%EXAMPLES%', imageUtils.buildImageExemplars())
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
            // Read from image/video
            const imageSection = vu?.image;
            if (vu && imageSection) {
                // Participants come from scene.participants (set during scene creation).
                // Character IDs in prompt are normalized via normalizeCharacterRefs.
                let prompt = normalizeCharacterRefs(imageSection.prompt, characters, mentions);
                const action = vu.video?.action || prompt;                    const result = { ...u };
                result.image = {
                    shot: imageSection.shot || (u.type === 'dialogue' ? 'medium' : 'wide'),
                    prompt,
                    style: imageSection?.style,
                    negative: imageSection?.negative,
                };
                result.video = {
                    action,
                };
                return result;
            }            const fallbackPrompt = imageUtils.getFallbackImage(u.text, characters, { ...scene, participants: scene.participants }, locDisplay);
                return {
                ...u,
                image: {
                    shot: u.type === 'dialogue' ? 'medium' : 'wide',
                    prompt: fallbackPrompt,
                },
                video: {
                    action: fallbackPrompt,
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
        return units.map((u) => {
            const fallbackPrompt = imageUtils.getFallbackImage(u.text, characters, { ...scene, participants: scene.participants }, locDisplay);
            return {
                ...u,
                image: {
                    shot: u.type === 'dialogue' ? 'medium' : 'wide',
                    prompt: fallbackPrompt,
                },
                video: {
                    action: fallbackPrompt,
                },
            };
        });
    }
}

module.exports = {
    stepAnalyzeStructure,
    stepExtractCharacters,
    stepExtractLocations,
    stepCreateScenes,
    stepCreateUnits,
    stepCreateVisuals,
    stepPolishStoryboard,
    stepReconcilePassports,
    stepReconcileVideoActions,
    stepPolishVideoActions,
    stepGenerateVoices,
};
