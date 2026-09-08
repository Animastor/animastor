// ======================================================
// Agent Pipeline Steps
// ======================================================
// Individual AI pipeline step functions. Since C21 the AI ANALYSIS tasks
// (structure/characters/voices/locations/scenes/units) physically live in
// the ai-agent contour (services/ai-agent + the C19/C20 analyzer modules);
// the analysis steps below are THIN HOST ADAPTERS that inject the host
// ports into the contour seam (services/ai-agent) — composition only.
// The generation/post-processing steps (visuals, reconciliation, polish,
// fantasy repair) stay host-side and reach the LLM via ai-caller.

const aiCaller = require('./ai-caller');
const imageUtils = require('./image-utils');
const promptProfileLoader = require('../prompt-profile-loader');
const {
    createStep, completeStep, failStep, updateSession,
} = require('../agent-session');
const { estimateSpeechDurationSec } = require('../placeholder-audio');
const {
    PROGRESS_STAGES, SYSTEM_PROMPTS,
    IMAGE_PROMPT_MAX_CHARS, UNIT_TEXT_MAX_CHARS, SCENE_TEXT_MAX_CHARS,
    fillLang,
} = require('../agent-prompts');
const { normalizeCharacterRefs } = require('../../image/image-service');
const { sanitizeVideoTokens, tokensToString } = require('../../book/lazy-book/appearance');
const { findUnverifiedSnakeTokens, canonicalizeText, desnakeifyText, findCrossPromptGaps, participantFieldIds } = require('../../utils/snake-guard');
// Shared pure prompt-context builder lives in the ai-agent contour (C21):
// the location registry context block is consumed by contour tasks (scenes)
// AND by the host-side polish steps below — one implementation, no copies.
const { buildLocationsContext } = require('../ai-agent');

/**
 * Normalize names/aliases → character_id in an AI-written visual text.
 * Two passes: (1) character-name aliases (incl. Latin transliterations, so
 * "Mikhail's glasses" → "mikhail_berlioz's glasses"), (2) role/title mention
 * aliases (the mentions map) when present. Applied at EVERY AI merge point so
 * a later pass can never re-introduce display names into stored fields.
 */
function normalizeVisualText(text, characters, mentions) {
    if (!text) return text;
    let out = normalizeCharacterRefs(text, characters);
    if (mentions && typeof mentions === 'object' && Object.keys(mentions).length > 0) {
        out = normalizeCharacterRefs(out, characters, mentions);
    }
    return out;
}

/**
 * Shared host-port block for the analysis adapters: the SAME wiring for
 * every contour task (C21 §3 — one host seam, injected per call).
 */
function analysisHostPorts(extra = {}) {
    return {
        callAI: aiCaller.callAI,
        logConversation: aiCaller.logConversation,
        updateSession,
        createStep,
        completeStep,
        failStep,
        prompt: (name) => SYSTEM_PROMPTS[name],
        fillLang,
        ...extra,
    };
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

// ── Static-copy guard for video.action ───────────────────────────────
// The visuals step falls back to image.prompt when the agent omits
// video.action, and the passport/storyboard passes re-use the prompt when the
// action is empty. Such units are STATIC COPIES — a video model fed the static
// composition would just re-render a still frame. Detection is deliberately
// strict (normalized equality OR full containment): a substantially reworded
// action is treated as an independent agent result and is NEVER touched.
function normalizeForCompare(s) {
    return (s || '')
        .toLowerCase()
        .replace(/[^a-z0-9\u0400-\u04ff\s]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isStaticActionCopy(imagePrompt, action) {
    const p = normalizeForCompare(imagePrompt);
    const a = normalizeForCompare(action);
    if (!p || !a) return false;
    if (p === a) return true;
    if (p.length < 15 || a.length < 15) return false;
    return p.includes(a) || a.includes(p);
}

// Units that Video Reconciliation MUST process: actions that are empty (rule:
// "Empty → GENERATE from unit text + type") or static copies of image.prompt.
// Anything else is an independent agent result and must stay untouched.
function needsVideoActionReconciliation(u) {
    const action = (u.video?.action || '').trim();
    if (!action) return true; // empty — rule: "Empty → GENERATE from unit text + type"
    return isStaticActionCopy(u.image?.prompt || '', action);
}

// Format one unit for reconciliation/polish agents. JSON encoding keeps the row
// unambiguous when unit text / prompts contain quotes or newlines.
// estimated_duration_sec = the module's play time — a pre-TTS speech estimate
// (same heuristic the unit-splitter and video chunking use; real audio refines
// it later). Lets the polish agents pace actions to plausibly fill the time.
function unitRow(u) {
    return JSON.stringify({
        scene_index: u.sceneIndex,
        unit_index: u.unitIndex,
        scene_title: u.sceneTitle || '',
        type: u.type || 'unknown',
        text: (u.text || '').substring(0, UNIT_TEXT_MAX_CHARS),
        estimated_duration_sec: estimateSpeechDurationSec(u.text),
        participants: u.participants || [],
        shot: u.image?.shot || 'unknown',
        prompt: u.image?.prompt || '',
        action: u.video?.action || '',
    });
}

/**
 * Cross-prompt consistency hints for storyboard polish. ASYMMETRIC: only the
 * HARD direction is actionable — participants video.action names by id must be
 * concretized in image.prompt (video IDs ⊆ image IDs). The reverse direction
 * (image IDs ⊄ video IDs) is a soft heuristic, never an error: a video may
 * animate only a subset of the people shown in the still.
 * @param {Object[]} allVisualUnits
 * @param {Object[]} characters
 * @returns {Object[]} hint rows { scene_index, unit_index, generic_terms, missing_ids, ids_in_other_field }
 */
function buildCrossPromptHints(allVisualUnits, characters) {
    const knownIds = (characters || []).map(c => c.id).filter(Boolean);
    const hints = [];
    for (const u of allVisualUnits || []) {
        for (const g of findCrossPromptGaps(u, u.participants || [], knownIds)) {
            if (g.direction !== 'prompt' || g.severity !== 'hard') continue;
            hints.push({
                scene_index: u.sceneIndex,
                unit_index: u.unitIndex,
                generic_terms: g.generic_terms,
                missing_ids: g.missing_ids,
                ids_in_other_field: g.ids_in_other,
            });
        }
    }
    return hints;
}

/**
 * Post-polish re-validation: are the participant ids the OTHER field names still
 * absent from the field this step polishes? Stronger than the generic-term check
 * — the agent was told to add EXACT ids, so their absence means the fix did not
 * land, even when the generic term was removed.
 * @param {Object} unit
 * @param {string[]} participants - scene.participants
 * @param {Iterable<string>} knownIds - registry ids
 * @param {'prompt'|'action'} direction - field this step polishes
 * @returns {string[]} participant ids still missing from the polished field
 */
function stillMissingIds(unit, participants, knownIds, direction) {
    const { idsInPrompt, idsInAction } = participantFieldIds(unit, participants, knownIds);
    if (direction === 'prompt') return idsInAction.filter(id => !idsInPrompt.includes(id));
    return idsInPrompt.filter(id => !idsInAction.includes(id));
}

// ======================================================
// Agent Pipeline Step — Structure Analysis (host adapter, C19/C21)
// ======================================================
// The Structure Analyzer functional module lives in
// services/structure-analyzer (C19 physical extraction) and is reachable
// through the shared ai-agent contour seam (C21). It reaches the
// LLM ONLY through an injected callAI port and owns no persistence; the
// host-side wiring (PG session/steps, conversation log, prompts, provider
// context) is passed in here — this adapter is the composition point.
// Replacing the Structure Analysis algorithm means replacing
// structure-analyzer, not touching this adapter's siblings
// (characters/locations/scenes/units/visuals).

async function stepAnalyzeStructure(sessionId, sourceText, stepIndex, progress, language, options = {}) {
    const aiAgent = require('../ai-agent');
    return aiAgent.analyzeBookStructure(
        {
            sourceText,
            candidates: options.candidates,
            language,
            sessionId,
            stepIndex,
            progress,
        },
        analysisHostPorts({ analyzingStructureMessage: PROGRESS_STAGES.analyzing_structure })
    );
}

// ======================================================
// Agent Pipeline Step — Character Extraction (host adapter, C20/C21)
// ======================================================
// The Character Analyzer functional module lives in
// services/character-analyzer (C20 physical extraction), reachable through
// the shared ai-agent contour seam (C21). It reaches the LLM ONLY through
// an injected callAI port and owns no persistence; the host-side wiring is
// passed in here — this adapter is the composition point. Replacing
// Character Analysis means replacing character-analyzer, not touching this
// adapter's siblings (structure/locations/scenes/units/visuals).

async function stepExtractCharacters(sessionId, text, stepIndex, progress, language) {
    const aiAgent = require('../ai-agent');
    return aiAgent.extractCharacters(
        {
            windowText: text,
            language,
            sessionId,
            stepIndex,
            progress,
        },
        analysisHostPorts({ extractingCharactersMessage: PROGRESS_STAGES.extracting_chars })
    );
}

// ======================================================
// Agent Pipeline Step — Location Extraction (host adapter, C21)
// ======================================================
// Location Analysis (F3) moved from this file into the ai-agent contour
// (services/ai-agent/tasks/locations.js). Same pattern as C19/C20: the task
// owns prompt + JSON contract; the LLM seam and persistence are injected
// ports; degradation (throw → runner keeps the existing set) is unchanged.

async function stepExtractLocations(sessionId, text, characters, stepIndex, progress, language) {
    const aiAgent = require('../ai-agent');
    return aiAgent.extractLocations(
        {
            windowText: text,
            characters,
            language,
            sessionId,
            stepIndex,
            progress,
        },
        analysisHostPorts({ extractingLocationsMessage: PROGRESS_STAGES.extracting_locs })
    );
}

// ======================================================
// Agent Pipeline Step — Scene Analysis (host adapter, C21)
// ======================================================
// Scene Analysis (F4) moved from this file into the ai-agent contour
// (services/ai-agent/tasks/scenes.js, with the deterministic
// normalizeSceneEnvironment output guard). Coverage validation, the repair
// retry and the deterministic fallback remain runner-owned — unchanged.

async function stepCreateScenes(sessionId, text, characters, locations, stepIndex, progress, repairHint, chunkSize, language, bookDefault) {
    const aiAgent = require('../ai-agent');
    return aiAgent.createScenes(
        {
            sceneText: text,
            characters,
            locations,
            bookDefault,
            repairHint,
            chunkSize,
            language,
            sessionId,
            stepIndex,
            progress,
        },
        analysisHostPorts({ creatingScenesMessage: PROGRESS_STAGES.creating_scenes })
    );
}

// ======================================================
// Agent Pipeline Step — Unit Analysis (host adapter, C21)
// ======================================================
// Unit Analysis (F5) moved from this file into the ai-agent contour
// (services/ai-agent/tasks/units.js). The failure degradation (fallback unit
// instead of throw) stays inside the task — unchanged. The long-unit
// duration splitter (unit-splitter) remains a host-wired post-processor.

async function stepCreateUnits(sessionId, scene, sceneIndex, characters, stepIndex, progress, mentions) {
    const aiAgent = require('../ai-agent');
    return aiAgent.createUnits(
        {
            scene,
            sceneIndex,
            characters,
            mentions,
            sessionId,
            stepIndex,
            progress,
        },
        analysisHostPorts({ creatingUnitsMessage: PROGRESS_STAGES.creating_units })
    );
}

// ======================================================
// Agent Pipeline Step — Voice Generation (host adapter, C20/C21)
// ======================================================
// F7 voice authoring lives in character-analyzer/voices.js (the audio-
// adjacent half of the Character Analyzer), reachable through the shared
// ai-agent contour seam (C21). It is AI ANALYSIS/AUTHORING — voice
// DESCRIPTIONS for TTS, not audio generation. It still mutates
// characters[i].voice in place — the write-back contract is unchanged.

async function stepGenerateVoices(sessionId, text, characters, stepIndex, progress, language, promptProfiles) {
    const aiAgent = require('../ai-agent');
    return aiAgent.generateVoices(
        {
            windowText: text,
            characters,
            promptProfiles,
            language,
            sessionId,
            stepIndex,
            progress,
        },
        analysisHostPorts({
            voiceGenerationMessage: PROGRESS_STAGES.voice_generation,
            buildSkill: promptProfileLoader.buildSkillSection,
        })
    );
}

/**
 * Resolve the effective video tokens for a character in a scene: the scene-level
 * override (scene.passport[charId].video_tokens) wins, then the global passport
 * token, then the top-level agent field. Returns the raw value (array | string).
 */
function effectiveSceneTokens(scene, c) {
    const sceneTok = scene?.passport?.[c.id]?.video_tokens;
    if (sceneTok) return sceneTok;
    return c.passport?.video_tokens || c.video_tokens || null;
}

/**
 * Build the per-scene participants block for the passport-reconciliation prompt
 * (stage 2 of the video_tokens scheme). Only scenes with 2+ participants that
 * HAVE tokens are listed — cross-character uniqueness matters only there.
 * The agent sees each participant's current tokens + passport so it can
 * re-pick colliding features and keep the rest.
 */
function buildSceneTokensContext(scenes, characters) {
    const charMap = new Map((characters || []).map(c => [c.id, c]));
    const parts = [];
    (scenes || []).forEach((scene, si) => {
        const rows = (scene.participants || [])
            .map(id => ({ id, ch: charMap.get(id), tokens: charMap.has(id) ? effectiveSceneTokens(scene, charMap.get(id)) : null }))
            .filter(r => r.ch && r.tokens && tokensToString(r.tokens));
        if (rows.length < 2) return;
        const lines = rows.map(r => {
            const p = r.ch.passport || {};
            const appearance = (p.appearance || r.ch.appearance || '').substring(0, 180);
            const clothes = (p.clothes || r.ch.clothes || '').substring(0, 120);
            const ref = [];
            if (appearance) ref.push(`appearance="${appearance}"`);
            if (clothes) ref.push(`clothes="${clothes}"`);
            const refStr = ref.length > 0 ? ` ${ref.join(' ')}` : '';
            return `  - ${r.id} (${r.ch.name || r.id}): current_tokens="${tokensToString(r.tokens)}"${refStr}`;
        });
        parts.push(`Scene ${si}${scene.title ? ` "${scene.title}"` : ''}:`);
        parts.push(...lines);
    });
    return parts.join('\n') || 'None';
}

/**
 * Parse the agent's `video_tokens` response rows into a sanitized list.
 * Accepts scene_index as number OR numeric string (LLMs frequently emit
 * strings); drops rows with unusable tokens or unknown scenes.
 * @param {*} rawRows - result.video_tokens from the reconciliation agent
 * @returns {{scene_index: number, tokens: Object<string, string[]>}[]}
 */
function parseSceneVideoTokens(rawRows) {
    if (!Array.isArray(rawRows)) return [];
    return rawRows
        .filter(r => r && r.tokens && typeof r.tokens === 'object' && !Array.isArray(r.tokens) && Number.isInteger(Number(r.scene_index)))
        .map(r => {
            const tokens = {};
            for (const [charId, t] of Object.entries(r.tokens)) {
                const cleaned = sanitizeVideoTokens(t);
                if (cleaned) tokens[charId] = cleaned;
            }
            return { scene_index: Number(r.scene_index), tokens };
        })
        .filter(r => Object.keys(r.tokens).length > 0);
}

async function stepReconcilePassports(sessionId, allVisualUnits, characters, stepIndex, progress, scenes) {
    const _progress = progress || (() => {});
    _progress({ stage: 'passport_reconciliation', message: PROGRESS_STAGES.passport_reconciliation });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.passport_reconciliation });

    if (!allVisualUnits || allVisualUnits.length === 0) {
        console.log(`[AGENT] Step passport (reconciliation): skipped — no units`);
        return { units: allVisualUnits || [], videoTokens: [] };
    }

    // Exclude out-of-format prompts (legacy values / stray pastes) — see inPromptRange.
    const polishable = allVisualUnits.filter(inPromptRange);
    const excludedCount = allVisualUnits.length - polishable.length;
    if (polishable.length === 0) {
        console.log(`[AGENT] Step passport (reconciliation): skipped — all ${allVisualUnits.length} unit(s) have out-of-format prompts (>${IMAGE_PROMPT_MAX_CHARS} chars)`);
        return { units: allVisualUnits, videoTokens: [] };
    }

    const step = await createStep(sessionId, 'reconcile_passports', stepIndex || 0);

    // Build passport context: only characters that have actual passport data
    // Characters from the agent pipeline have `appearance`/`clothes` fields (not
    // passport.*), while characters loaded from characters.json have `passport.*`.
    // Handle both shapes.
    const charsWithPassport = (characters || []).filter(c =>
        c.passport?.appearance || c.passport?.clothes || c.appearance || c.clothes
    );
    const charsContext = charsWithPassport.map(c => {
        const p = c.passport || {};
        // Agent-pipeline characters have `appearance`/`clothes` (not passport.*).
        // Map to passport-like fields so the reconciliation AI can compare.
        const appearance = p.appearance || c.appearance || c.description || '(none)';
        const clothes = p.clothes || c.clothes || '(none)';
        return `- ${c.id}: ${c.name || c.id}\n` +
            `  appearance: ${appearance.substring(0, 400)}\n` +
            `  clothes: ${clothes.substring(0, 200)}`;
    }).join('\n') || 'None';

    const unitsStr = polishable.map(unitRow).join('\n');

    // Stage 2 of the video_tokens scheme: per-scene participants with their
    // current tokens + passports, so the agent can re-pick colliding features
    // and make tokens maximally distinct within each scene.
    const sceneTokensContext = buildSceneTokensContext(scenes, characters);

    const prompt = SYSTEM_PROMPTS.passport_reconciliation
        .replace('%CHARACTERS%', charsContext)
        .replace('%SCENE_VIDEO_TOKENS%', sceneTokensContext)
        .replace('%UNITS%', unitsStr);

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Reconcile these ${polishable.length} visual units against character passports:\n\n${unitsStr}` },
    ];

    try {
        const result = await aiCaller.callAI(messages, { maxTokens: 4096 });
        const reconciled = result.units || [];

        // Stage 2 output: per-scene adjusted video tokens. Sanitize: keep only
        // integer scene indexes, string-array tokens (1-4 short features).
        const videoTokens = parseSceneVideoTokens(result.video_tokens);

        // Merge AI results back, preserving original fields and only updating visual.prompt
        const merged = allVisualUnits.map((original, i) => {
            const rec = reconciled.find(r => r.scene_index === original.sceneIndex && r.unit_index === original.unitIndex);
            if (rec && rec.image?.prompt && inPromptRange(original)) {
                const mergedPrompt = normalizeVisualText(rec.image.prompt || original.image?.prompt, characters);
                return {
                    ...original,
                    image: {
                        shot: rec.image.shot || original.image?.shot || 'wide',
                        prompt: mergedPrompt,
                        style: rec.image?.style || original.image?.style,
                        negative: rec.image?.negative || original.image?.negative,
                    },
                    video: {
                        action: normalizeVisualText(original.video?.action || mergedPrompt, characters),
                    },
                };
            }
            return original;
        });

        await aiCaller.logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, { units: merged.length, video_tokens: videoTokens.length });

        const changedCount = merged.filter((m, i) => {
            const orig = allVisualUnits[i];
            return m.image?.prompt !== orig.image?.prompt;
        }).length;
        console.log(`[AGENT] Step passport (reconciliation): ${polishable.length} units reviewed, ${excludedCount} excluded (prompt >${IMAGE_PROMPT_MAX_CHARS} chars), ${changedCount} changed, ${videoTokens.length} scene(s) got video tokens`);

        return { units: merged, videoTokens };
    } catch (err) {
        await failStep(step.step_id, `Passport reconciliation failed: ${err.message}`);
        console.warn(`[AGENT] Step passport (reconciliation) FAILED, keeping original units: ${err.message}`);
        return { units: allVisualUnits, videoTokens: [] };
    }
}

async function stepReconcileVideoActions(sessionId, allVisualUnits, characters, stepIndex, progress, promptProfiles) {
    const _progress = progress || (() => {});

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

    // Reconcile ONLY units whose action is not an independent agent result:
    // empty actions (rule: "Empty → GENERATE") and static copies of
    // image.prompt (created by the fallbacks in stepCreateVisuals and the
    // passport/storyboard passes). Actions that differ from the prompt are
    // agent-authored — leave them untouched and spend no LLM call on them.
    const candidates = polishable.filter(needsVideoActionReconciliation);
    const keptAuthored = polishable.length - candidates.length;
    if (candidates.length === 0) {
        console.log(`[AGENT] Step video_action_reconciliation: skipped — all ${polishable.length} video.actions are agent-authored (distinct from image.prompt)`);
        return allVisualUnits;
    }

    _progress({ stage: 'video_action_reconciliation', message: PROGRESS_STAGES.video_action_reconciliation });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.video_action_reconciliation });

    const step = await createStep(sessionId, 'reconcile_video_actions', stepIndex || 0);

    const unitsStr = candidates.map(unitRow).join('\n');

    // Identity context: the characters list (id: name) so the reconciliation
    // agent can anchor its actions to exact character_ids instead of generic
    // nouns ("the two men", "woman", "Mikhail's").
    const charsContext = (characters || []).map(c => `- ${c.id}: ${c.name} (${c.role || 'unknown'})`).join('\n') || 'None';

    // Inject the video skill when a profile is configured (there is no
    // 'default' skill): the motion-first rules for the active video model live
    // in skills/video/{ltx-2.3,...}.md.
    let videoReconPrompt = SYSTEM_PROMPTS.video_action_reconciliation;
    if (videoReconPrompt.includes('%CHARACTERS%')) {
        videoReconPrompt = videoReconPrompt.replace('%CHARACTERS%', charsContext);
    }
    const videoSkill = promptProfileLoader.buildSkillSection('video', promptProfiles?.videoProfile || null);
    if (videoSkill) {
        videoReconPrompt = `${videoSkill}\n\n${videoReconPrompt}`;
    }

    const messages = [
        { role: 'system', content: videoReconPrompt },
        { role: 'user', content: `Fix video.action for these ${candidates.length} units — ensure each describes temporal/dynamic change only, not static composition:\n\n${unitsStr}` },
    ];

    try {
        const result = await aiCaller.callAI(messages, { maxTokens: 4096 });
        const reconciled = result.units || [];

        // Merge AI results back ONLY for the units that were sent. Agent-authored
        // actions never enter the merge — even if the model hallucinates extra
        // units, they cannot overwrite untouched actions.
        const sentKeys = new Set(candidates.map(u => `${u.sceneIndex}:${u.unitIndex}`));
        const merged = allVisualUnits.map((original) => {
            if (!sentKeys.has(`${original.sceneIndex}:${original.unitIndex}`)) return original;
            const rec = reconciled.find(r => r.scene_index === original.sceneIndex && r.unit_index === original.unitIndex);
            if (rec && rec.video?.action && inActionRange(original)) {
                return {
                    ...original,
                    video: {
                        action: normalizeVisualText(rec.video.action, characters),
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
        console.log(`[AGENT] Step video_action_reconciliation: ${candidates.length} units reviewed, ${keptAuthored} agent-authored kept, ${excludedCount} excluded (action >${IMAGE_PROMPT_MAX_CHARS} chars), ${changedCount} actions fixed`);

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

    // Inject the image prompt profile when one is configured.
    const imageSkill = promptProfileLoader.buildSkillSection('image', promptProfiles?.imageProfile || null);
    if (imageSkill) {
        polishPrompt = `${imageSkill}\n\n${polishPrompt}`;
    }

    const prompt = polishPrompt
        .replace('%CHARACTERS%', charsContext)
        .replace('%LOCATIONS%', locsContext)
        .replace('%SCENES%', scenesStr || '(no scene text available)')
        .replace('%UNITS%', unitsStr);

    // Cross-prompt consistency hints (HARD direction only): units whose
    // video.action names participants by id while image.prompt does not
    // concretely identify them (generic term like "two citizens", or simply
    // omitted). The polish agent re-anchors image.prompt to the ids — the only
    // field this step may change. Only in-range units are hinted — out-of-format
    // prompts can never be merged back, so listing them would only produce
    // unresolved noise.
    const promptHints = buildCrossPromptHints(polishable, characters);
    const crossHintsBlock = promptHints.length > 0
        ? '\n\n## Cross-prompt consistency — image.prompt must use character_ids\n' +
          `These ${promptHints.length} unit(s) name scene participants by character_id in their video.action, but image.prompt does not concretely identify them (a generic term like \"two citizens\", or simply omitted). For each listed unit rewrite image.prompt to use the EXACT character_ids from the missing_ids field (all from the Known Characters list) — keep the same composition, shot and scene meaning, only re-anchor identity to the ids. Do NOT invent ids; do NOT change video.action.\n` +
          JSON.stringify(promptHints)
        : '';

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Review and polish these ${polishable.length} visual units for storyboard continuity:\n\n${unitsStr}${crossHintsBlock}` },
    ];

    try {
        const result = await aiCaller.callAI(messages, { maxTokens: 4096 });
        const polishedUnits = result.units || [];

        // Merge AI results back, preserving original fields and only updating visual
        const merged = allVisualUnits.map((original, i) => {
            const polished = polishedUnits.find(p => p.scene_index === original.sceneIndex && p.unit_index === original.unitIndex);
            if (polished && polished.image?.prompt && inPromptRange(original)) {
                const mergedPrompt = normalizeVisualText(polished.image.prompt || original.image?.prompt, characters);
                return {
                    ...original,
                    image: {
                        shot: polished.image.shot || original.image?.shot || 'wide',
                        prompt: mergedPrompt,
                        style: polished.image?.style || original.image?.style,
                        negative: polished.image?.negative || original.image?.negative,
                    },
                    video: {
                        action: normalizeVisualText(original.video?.action || mergedPrompt, characters),
                    },
                };
            }
            return original;
        });

        // Cross-prompt re-validation: flagged units must now NAME the missing ids
        // in image.prompt (the agent was told the exact ids — their absence means
        // the fix did not land, even if the generic term was removed). Unresolved
        // units are counted + logged (they stay in the book, visible as WARN in
        // the audit) — never silently treated as fixed.
        const flaggedKeys = new Set(promptHints.map(h => `${h.scene_index}:${h.unit_index}`));
        const hintByKey = new Map(promptHints.map(h => [`${h.scene_index}:${h.unit_index}`, h]));
        const knownIds = (characters || []).map(c => c.id).filter(Boolean);
        let unresolved = 0;
        for (const m of merged) {
            if (!flaggedKeys.has(`${m.sceneIndex}:${m.unitIndex}`)) continue;
            const stillMissing = stillMissingIds(m, m.participants || [], knownIds, 'prompt');
            if (stillMissing.length > 0) {
                unresolved++;
                const wasGeneric = hintByKey.get(`${m.sceneIndex}:${m.unitIndex}`)?.generic_terms.join(', ') || '';
                console.warn(`[AGENT] Step 6 (storyboard polish): cross-prompt gap UNRESOLVED for unit ${m.sceneIndex}:${m.unitIndex} — image.prompt still lacks ids (${stillMissing.join(', ')}) named in video.action${wasGeneric ? ` (was generic: ${wasGeneric})` : ''}`);
            }
        }

        await aiCaller.logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, { units: merged.length });

        const changedCount = merged.filter((m, i) => {
            const orig = allVisualUnits[i];
            return m.image?.prompt !== orig.image?.prompt || m.image?.shot !== orig.image?.shot;
        }).length;
        console.log(`[AGENT] Step 6 (storyboard polish): ${polishable.length} units reviewed, ${excludedCount} excluded (prompt >${IMAGE_PROMPT_MAX_CHARS} chars), ${changedCount} modified${unresolved > 0 ? `, ${unresolved} cross-prompt gap(s) unresolved` : ''}`);

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

    // Inject the video skill when a profile is configured — motion rules,
    // camera vocabulary (skills/video/{ltx-2.3,...}.md).
    const videoSkill = promptProfileLoader.buildSkillSection('video', promptProfiles?.videoProfile || null);
    if (videoSkill) {
        polishPrompt = `${videoSkill}\n\n${polishPrompt}`;
    }

    const prompt = polishPrompt
        .replace('%CHARACTERS%', charsContext)
        .replace('%LOCATIONS%', locsContext)
        .replace('%SCENES%', scenesStr || '(no scene text available)')
        .replace('%UNITS%', unitsStr);

    // NOTE: no cross-prompt hints here by design — the check is ASYMMETRIC.
    // Only "video IDs ⊆ image IDs" is a hard rule (handled by storyboard
    // polish). The reverse (image.prompt names participants that video.action
    // does not animate) is normal — a video may animate only a subset of the
    // frame; the rest stay passive/background.
    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Review and polish video.actions for continuity, narrative consistency, and timing realism across these ${polishable.length} units. Each unit's estimated_duration_sec is the module's play time — the action must plausibly fill it:\n\n${unitsStr}` },
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
                        action: normalizeVisualText(polished.video.action, characters),
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
        return !!(ch.passport?.appearance || ch.passport?.clothes || ch.appearance || ch.clothes);
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
            contextParts.push('Example: if text says "редактор" and mapping says "редактор" → anna_smirnova, write "anna_smirnova" in the prompt.');
        }
    }

    const contextStr = contextParts.join('\n');

    // estimated_duration_sec — the module's play time (speech-duration heuristic)
    // — lets the visuals agent align video.action with the available time.
    const unitsStr = units.map((u, i) =>
        `Unit ${i + 1}: text="${(u.text || '').substring(0, 300)}", type="${u.type || 'perception'}", estimated_duration_sec=${estimateSpeechDurationSec(u.text)}`
    ).join('\n');

    // Inject prompt profile skills — model-specific rules for image & video.
    // Skills resolve only when their profile is configured (there is no
    // 'default' skill): the image composition rules live in
    // skills/image/{qwen-image,...}.md and the video motion rules in
    // skills/video/{ltx-2.3,...}.md — not duplicated in visuals.md.
    let visualsPrompt = SYSTEM_PROMPTS.visuals;
    const imageProfileName = promptProfiles?.imageProfile || null;
    const imageSkill = promptProfileLoader.buildSkillSection('image', imageProfileName);
    const videoSkill = promptProfileLoader.buildSkillSection('video', promptProfiles?.videoProfile || null);
    const skillBlock = [imageSkill, videoSkill].filter(Boolean).join('\n');
    if (skillBlock) {
        visualsPrompt = `${skillBlock}\n\n${visualsPrompt}`;
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
                let prompt = normalizeVisualText(imageSection.prompt, characters, mentions);
                const action = normalizeVisualText(vu.video?.action || prompt, characters, mentions);                    const result = { ...u };
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

// ── Fantasy snake_case id repair (hybrid barrier) ───────────────────
// Detection is deterministic (snake-guard): a snake_case token in
// image.prompt / video.action that is NOT a known character/location id is a
// hallucination. Recovery is LLM-based: the flagged unit (with its source text)
// is sent to the agent, which reassembles the prompt using the person's natural
// designation from the book text — language-aware, never transliterated.
// Runs as the FINAL visual step so no later polish pass can re-introduce a
// fantasy id. Out-of-format prompts (user-edited/legacy) are never touched.

function repairRow(u, tokens) {
    return JSON.stringify({
        scene_index: u.sceneIndex,
        unit_index: u.unitIndex,
        type: u.type || 'unknown',
        text: (u.text || '').substring(0, UNIT_TEXT_MAX_CHARS),
        prompt: u.image?.prompt || '',
        action: u.video?.action || '',
        speaker: u.audio?.speaker || null,
        fantasy_ids: tokens,
    });
}

/**
 * Pure merge of repair-agent results back into the unit list. Exported for tests.
 * Only flagged units can change; only fields the agent actually reassembled are
 * applied (each clean per-field). Then a WHOLE-UNIT residual scan runs (in-range
 * fields only): if ANY unverified snake token remains — a partial fix, where the
 * agent fixed one field but left the other — the residual fields fall through to
 * the deterministic desnakeify fallback (the LLM draft is kept and its invented
 * ids exploded into plain words). Only a unit that even the fallback cannot
 * clean is reverted entirely and counted as stillBad.
 * @param {Object[]} allVisualUnits
 * @param {{unit: Object, tokens: string[]}[]} flagged
 * @param {Object[]} repaired - agent rows { scene_index, unit_index, image?, video?, audio? }
 * @param {Object[]} characters
 * @param {Iterable<string>} knownIds
 * @returns {{units: Object[], changed: number, stillBad: number, fallbackFixed: number}}
 */
function mergeRepairResults(allVisualUnits, flagged, repaired, characters, knownIds) {
    const flaggedKeys = new Set(flagged.map(f => `${f.unit.sceneIndex}:${f.unit.unitIndex}`));
    let changed = 0;
    let stillBad = 0;
    let fallbackFixed = 0;
    const units = allVisualUnits.map(original => {
        if (!flaggedKeys.has(`${original.sceneIndex}:${original.unitIndex}`)) return original;
        const rec = repaired.find(r =>
            Number(r?.scene_index) === original.sceneIndex && Number(r?.unit_index) === original.unitIndex
        );
        if (!rec) {
            // Flagged unit got no repair row (truncated/partial agent response) —
            // make the gap visible instead of silently leaving the unit bad.
            stillBad++;
            console.warn(`[AGENT] fantasy_snake_repair: unit ${original.sceneIndex}:${original.unitIndex} flagged but the agent returned no repair row — keeping original`);
            return original;
        }
        const next = { ...original };
        let unitChanged = false;

        // Apply each returned field ONLY when the agent's fix itself is clean
        // (and non-empty — a whitespace draft must not wipe a real field).
        if (rec.image?.prompt && inPromptRange(original)) {
            const p = normalizeVisualText(rec.image.prompt, characters);
            if (p.trim() && findUnverifiedSnakeTokens(p, knownIds).length === 0) {
                next.image = { ...(original.image || {}), prompt: p };
                unitChanged = true;
            }
        }
        if (rec.video?.action && inActionRange(original)) {
            const a = normalizeVisualText(rec.video.action, characters);
            if (a.trim() && findUnverifiedSnakeTokens(a, knownIds).length === 0) {
                next.video = { ...(original.video || {}), action: a };
                unitChanged = true;
            }
        }
        // Speaker fix is applied only when the unit originally HAD audio — a
        // narration unit must never gain an audio.speaker by accident.
        if (rec.audio?.speaker && original.audio) {
            const sp = String(rec.audio.speaker).trim();
            if (sp && findUnverifiedSnakeTokens(sp, knownIds).length === 0) {
                next.audio = { ...original.audio, speaker: sp };
                unitChanged = true;
            }
        }

        // Whole-unit residual scan — a partially-fixed unit is NOT reverted;
        // residual fields fall through to the deterministic desnakeify below.
        // Out-of-format fields are never scanned (they were never touched).
        const residual = [];
        if (inPromptRange(original) && findUnverifiedSnakeTokens(next.image?.prompt || '', knownIds).length > 0) residual.push('prompt');
        if (inActionRange(original) && findUnverifiedSnakeTokens(next.video?.action || '', knownIds).length > 0) residual.push('action');
        if (next.audio?.speaker && findUnverifiedSnakeTokens(next.audio.speaker, knownIds).length > 0) residual.push('speaker');

        if (residual.length > 0) {
            // Last-resort deterministic fallback: the LLM's draft (even if dirty)
            // carries the model's best rewrite — take its field content and
            // explode any remaining invented snake token into plain words
            // ("kiosk_saleswoman" → "kiosk saleswoman") instead of reverting to
            // the original. A fantasy id must never reach the book, and the
            // model's plain-word designation ("kiosk saleswoman") is always
            // better than both the hallucinated id and a raw transliteration of
            // the original. Only the residual fields are touched; every other
            // field keeps the LLM's fix. Reverts only if even this cannot clean
            // the field (unlikely — desnakeifyText removes every invented token).
            const fb = { ...next };
            let fallbackChanged = false;
            if (residual.includes('prompt') && fb.image) {
                const base = rec.image?.prompt || fb.image.prompt || '';
                const p = normalizeVisualText(desnakeifyText(base, knownIds), characters);
                // non-empty guard: a draft that desnakeifies to an empty field
                // must not replace a real (if imperfect) original
                if (p.trim() && findUnverifiedSnakeTokens(p, knownIds).length === 0) {
                    fb.image = { ...fb.image, prompt: p };
                    fallbackChanged = true;
                }
            }
            if (residual.includes('action') && fb.video) {
                const base = rec.video?.action || fb.video.action || '';
                const a = normalizeVisualText(desnakeifyText(base, knownIds), characters);
                if (a.trim() && findUnverifiedSnakeTokens(a, knownIds).length === 0) {
                    fb.video = { ...fb.video, action: a };
                    fallbackChanged = true;
                }
            }
            if (residual.includes('speaker') && fb.audio) {
                const base = rec.audio?.speaker || fb.audio.speaker || '';
                const sp = String(desnakeifyText(base, knownIds)).trim();
                if (sp && findUnverifiedSnakeTokens(sp, knownIds).length === 0) {
                    fb.audio = { ...fb.audio, speaker: sp };
                    fallbackChanged = true;
                }
            }
            if (fallbackChanged) {
                const fixed = [];
                if (residual.includes('prompt') && fb.image && fb.image.prompt !== next.image?.prompt) fixed.push('prompt');
                if (residual.includes('action') && fb.video && fb.video.action !== next.video?.action) fixed.push('action');
                if (residual.includes('speaker') && fb.audio && fb.audio.speaker !== next.audio?.speaker) fixed.push('speaker');
                fallbackFixed++;
                changed++;
                console.warn(`[AGENT] fantasy_snake_repair: unit ${original.sceneIndex}:${original.unitIndex} fallback-desnakeified ${fixed.join(', ')} — kept (plain words instead of fantasy id)`);
                return fb;
            }
            // Belt-and-suspenders: desnakeifyText removes EVERY invented token
            // deterministically, so this branch is near-unreachable — kept as a
            // defensive safety net (e.g. a draft that desnakeifies to empty).
            // If it ever fires, it is unexpected: investigate, do not ignore.
            stillBad++;
            console.warn(`[AGENT] fantasy_snake_repair: UNEXPECTED — unit ${original.sceneIndex}:${original.unitIndex} still has unverified ids in ${residual.join(', ')} after fallback — reverting to original (investigate)`);
            return original;
        }
        if (unitChanged) changed++;
        return next;
    });
    return { units, changed, stillBad, fallbackFixed };
}

/**
 * Deterministically align chimera snake tokens (mixed-script / typo /
 * transliteration variant / noise suffix of a known id) to the canonical
 * registry id — in-range fields only (out-of-format prompts are never touched).
 * Pure, exported for tests. Returns { unit, changed }.
 */
function canonicalizeVisualUnit(u, knownIds) {
    const next = { ...u };
    let changed = false;
    if (inPromptRange(u) && u.image?.prompt) {
        const p = canonicalizeText(u.image.prompt, knownIds);
        if (p !== u.image.prompt) { next.image = { ...u.image, prompt: p }; changed = true; }
    }
    if (inActionRange(u) && u.video?.action) {
        const a = canonicalizeText(u.video.action, knownIds);
        if (a !== u.video.action) { next.video = { ...u.video, action: a }; changed = true; }
    }
    if (u.audio?.speaker) {
        const sp = canonicalizeText(u.audio.speaker, knownIds);
        if (sp !== u.audio.speaker) { next.audio = { ...u.audio, speaker: sp }; changed = true; }
    }
    return changed ? { unit: next, changed: true } : { unit: u, changed: false };
}

/**
 * Write repair-step results back into enriched scenes (in place). Covers
 * image.prompt, video.action AND audio.speaker — a reassembled speaker must
 * reach the book, not only the step's return value.
 * @param {Object[]} enrichedScenes
 * @param {Object[]} repaired - merged units from stepRepairFantasyIds
 */
function applyRepairToScenes(enrichedScenes, repaired) {
    for (const ru of (repaired || [])) {
        const scene = enrichedScenes?.[ru.sceneIndex];
        if (scene && scene.units[ru.unitIndex]) {
            const unit = scene.units[ru.unitIndex];
            if (ru.image?.prompt) {
                unit.image = unit.image || {};
                unit.image.prompt = ru.image.prompt;
                if (ru.image?.shot) unit.image.shot = ru.image.shot;
            }
            if (ru.video?.action) {
                unit.video = unit.video || {};
                unit.video.action = ru.video.action;
            }
            if (ru.audio?.speaker && unit.audio) {
                unit.audio.speaker = ru.audio.speaker;
            }
        }
    }
}

async function stepRepairFantasyIds(sessionId, allVisualUnits, characters, locations, stepIndex, progress) {
    const _progress = progress || (() => {});
    if (!allVisualUnits || allVisualUnits.length === 0) {
        console.log('[AGENT] Step fantasy_snake_repair: skipped — no units');
        return allVisualUnits || [];
    }

    const knownIds = [
        ...(characters || []).map(c => c.id).filter(Boolean),
        ...(locations || []).map(l => l.id).filter(Boolean),
    ];

    // Deterministic canonicalization FIRST: a chimera snake token (mixed-script,
    // wrong transliteration, trailing underscore, 1-2 char typo, noise suffix)
    // is aligned to the CANONICAL registry id WITHOUT any LLM call. Only tokens
    // with NO confident match are flagged for LLM reassembly below.
    const prepared = allVisualUnits.map(u => canonicalizeVisualUnit(u, knownIds));
    const autoFixed = prepared.filter(c => c.changed).length;
    const baseUnits = prepared.map(c => c.unit);

    // Deterministic scan of in-range prompts/actions only (out-of-format
    // prompts are user-edited/legacy and never touched — see inPromptRange).
    const flagged = [];
    for (const u of baseUnits) {
        const tokens = [];
        if (inPromptRange(u)) tokens.push(...findUnverifiedSnakeTokens(u.image?.prompt || '', knownIds));
        if (inActionRange(u)) tokens.push(...findUnverifiedSnakeTokens(u.video?.action || '', knownIds));
        if (u.audio?.speaker) tokens.push(...findUnverifiedSnakeTokens(u.audio.speaker, knownIds));
        const unique = [...new Set(tokens.map(t => t.toLowerCase()))];
        if (unique.length > 0) flagged.push({ unit: u, tokens: unique });
    }

    if (flagged.length === 0) {
        if (autoFixed === 0) {
            console.log(`[AGENT] Step fantasy_snake_repair: skipped — no unverified snake_case ids in ${allVisualUnits.length} units`);
            return allVisualUnits;
        }
        console.log(`[AGENT] Step fantasy_snake_repair: ${autoFixed} unit(s) auto-canonicalized, none need LLM repair`);
        return baseUnits;
    }

    _progress({ stage: 'fantasy_snake_repair', message: PROGRESS_STAGES.fantasy_snake_repair });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.fantasy_snake_repair });

    const step = await createStep(sessionId, 'repair_fantasy_snakes', stepIndex || 0);

    const charsContext = (characters || []).map(c => `- ${c.id}: ${c.name || c.id}`).join('\n') || 'None';
    const locsContext = (locations || []).map(l => `- ${l.id}: ${l.name || l.id}`).join('\n') || 'None';
    const unitsStr = flagged.map(f => repairRow(f.unit, f.tokens)).join('\n');

    const prompt = SYSTEM_PROMPTS.fantasy_snake_repair
        .replace('%CHARACTERS%', charsContext)
        .replace('%LOCATIONS%', locsContext)
        .replace('%UNITS%', unitsStr);

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Reassemble the ${flagged.length} unit(s) that reference fantasy snake_case ids:\n\n${unitsStr}` },
    ];

    try {
        const result = await aiCaller.callAI(messages, { maxTokens: 4096 });
        const repaired = result.units || [];
        const { units: merged, changed, stillBad, fallbackFixed } = mergeRepairResults(baseUnits, flagged, repaired, characters, knownIds);

        await aiCaller.logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, { units: merged.length });
        console.log(`[AGENT] Step fantasy_snake_repair: ${autoFixed} auto-canonicalized, ${flagged.length} unit(s) flagged (${flagged.reduce((n, f) => n + f.tokens.length, 0)} fantasy ids), ${changed} reassembled, ${fallbackFixed} fallback-desnakeified, ${stillBad} still unverified (kept original)`);
        return merged;
    } catch (err) {
        await failStep(step.step_id, err.message);
        console.warn(`[AGENT] Step fantasy_snake_repair FAILED, keeping original units: ${err.message}`);
        return allVisualUnits;
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
    stepRepairFantasyIds,
    stepGenerateVoices,
    // Video-token helpers (stage 2) — exported for tests
    effectiveSceneTokens,
    buildSceneTokensContext,
    parseSceneVideoTokens,
    // Deterministic static-copy guards (used by pipeline-runner's final sweep)
    isStaticActionCopy,
    needsVideoActionReconciliation,
    // Fantasy snake repair helpers (pure — exported for tests)
    repairRow,
    mergeRepairResults,
    applyRepairToScenes,
    canonicalizeVisualUnit,
    // Cross-prompt consistency helpers (pure — exported for tests)
    buildCrossPromptHints,
    stillMissingIds,
};
