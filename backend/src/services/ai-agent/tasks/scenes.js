// ======================================================
// AI Agent task — createScenes (F4, Scene Analysis)
// ======================================================
// AI analysis splitting a window of book text into scenes
// (title + text verbatim + participants + location reference + optional
// per-scene environment override against the location's global template).
//
// Frozen contract (C18 §6 F4; C21 contour):
//
//   createScenes(input, ports) → Scene[]
//
//     input: {
//       sceneText: string,           // window text to split (verbatim input)
//       characters: Character[],     // registry context (%EXISTING_CHARACTERS%)
//       locations: Location[],       // registry context (%EXISTING_LOCATIONS%,
//                                    // rendered by the shared context builder)
//       bookDefault?: { country, epoch },  // book-level default setting
//                                           // (%BOOK_DEFAULT%)
//       repairHint?: { reason, gap_preview },  // coverage-failure retry payload
//       chunkSize: number,           // scenes-per-window budget (reserved by
//                                    // the contract; the cap is applied by the
//                                    // runner, not by the AI)
//       language, sessionId, stepIndex, progress,
//     }
//
//     output: Scene[] { title, text (verbatim), type,
//                       participants|characters_present,
//                       location { id, environment? } }
//       — coverage validation, the repair retry and the deterministic
//         buildFallbackScenes degradation stay RUNNER-owned (unchanged).
//
//     fail: → failStep + throw. The runner retries with the coverage repair
//             hint, then falls back to deterministic scenes (unchanged).
//
// Ports (host-injected; no ambient access, no PG/Redis/fs inside):
//   callAI / logConversation / updateSession / createStep / completeStep /
//     failStep — the shared host seam (see ../ports.js).
//   creatingScenesMessage — user-facing progress text
//     (PROGRESS_STAGES.creating_scenes).
//   prompt(name) → string — prompt source (SYSTEM_PROMPTS.scenes;
//     ai/rules/scenes.md — content unchanged).
//   fillLang(template, language) → string — %LANGUAGE% fill.
//
// Deterministic output guard: normalizeSceneEnvironment keeps ONLY known
// environment fields with non-empty values and drops placeholder values —
// a hallucinated field must never reach the image prompt. It consumes the
// shared PURE sanitizeEnvironment predicate from utils/snake-guard (same
// sharing pattern as the Book Writer write barrier; C21 §3: pure utils may
// be consumed, host infrastructure may not).

const { sanitizeEnvironment } = require('../../../utils/snake-guard');
const { assertHostPorts } = require('../ports');
const { buildLocationsContext } = require('../context');

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
    // Keep only known fields, then drop placeholder values ("not applicable",
    // "n/a", "unknown", "—", …): an agent that cannot answer must leave the
    // field absent — a placeholder would be injected into the image prompt.
    const clean = {};
    for (const key of SCENE_ENV_FIELDS) {
        const v = raw[key];
        if (typeof v === 'string' && v.trim()) clean[key] = v.trim();
    }
    const sanitized = sanitizeEnvironment(clean);
    if (Object.keys(sanitized).length === 0) {
        // Nothing valid remained — drop the environment entirely (removes
        // hallucinated junk fields and lets the location template be the
        // fallback at prompt build time).
        const newLoc = { ...loc };
        delete newLoc.environment;
        return { ...scene, location: newLoc };
    }
    return { ...scene, location: { ...loc, environment: sanitized } };
}

/**
 * Split a window of book text into scenes.
 *
 * @param {object} input { sceneText, characters?, locations?, bookDefault?,
 *                         repairHint?, chunkSize?, language,
 *                         sessionId, stepIndex?, progress? }
 * @param {object} ports { callAI, logConversation, updateSession, createStep,
 *                         completeStep, failStep, creatingScenesMessage,
 *                         prompt, fillLang }
 * @returns {Promise<object[]>} scenes (C18 §6 F4 shape)
 */
async function createScenes(input, ports) {
    const {
        callAI, logConversation, updateSession, createStep, completeStep, failStep,
        creatingScenesMessage, prompt, fillLang,
    } = assertHostPorts(ports, [
        'callAI', 'logConversation', 'updateSession', 'createStep',
        'completeStep', 'failStep', 'creatingScenesMessage', 'prompt', 'fillLang',
    ], 'ai-agent/scenes');

    // No artificial limit — AI creates natural narrative episodes.
    // The pipeline caps to chunkSize later and caches extras.
    const _progress = input.progress || (() => {});
    _progress({ stage: 'creating_scenes', message: creatingScenesMessage });
    await updateSession(input.sessionId, { progress_msg: creatingScenesMessage });

    const step = await createStep(input.sessionId, 'create_scenes', input.stepIndex || 0);

    const charsContext = (input.characters || []).map(c => `- ${c.id}: ${c.name}`).join('\n') || 'None';
    const locsContext = buildLocationsContext(input.locations);

    // Book-level default country/epoch (from stepAnalyzeStructure) — tells the
    // scene split agent what the book's default setting is, so it can write
    // country/epoch overrides ONLY for scenes that genuinely deviate (flashbacks,
    // travel to another country, etc.). When absent, tell the agent to infer.
    const bookDefaultParts = [];
    if (input.bookDefault?.country) bookDefaultParts.push(`country: ${input.bookDefault.country}`);
    if (input.bookDefault?.epoch) bookDefaultParts.push(`epoch: ${input.bookDefault.epoch}`);
    const bookDefaultStr = bookDefaultParts.length > 0
        ? bookDefaultParts.join('\n')
        : 'not specified — infer the book\'s default country/epoch from the text itself';

    const promptText = fillLang(
        prompt('scenes')
            .replace('%EXISTING_CHARACTERS%', charsContext)
            .replace('%EXISTING_LOCATIONS%', locsContext)
            .replace('%BOOK_DEFAULT%', bookDefaultStr),
        input.language
    );

    let repairText = '';
    if (input.repairHint) {
        repairText = `\n\nPrevious scene split failed source coverage validation.\nReason: ${input.repairHint.reason || 'unknown'}.\nMissing or problematic source fragment:\n\`\`\`\n${input.repairHint.gap_preview || ''}\n\`\`\`\nReturn a corrected split that starts at the first narrative word and covers a contiguous prefix of the provided text without gaps. Do not skip, overlap, paraphrase, or summarize anything inside the returned scenes. Unused tail text is allowed.`;
    }

    const messages = [
        { role: 'system', content: promptText },
        { role: 'user', content: `Split this text into scenes:\n\n\`\`\`\n${input.sceneText}\n\`\`\`${repairText}` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 6144 });
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

        await logConversation(input.sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, scenes);
        return scenes;
    } catch (err) {
        await failStep(step.step_id, err.message);
        throw err;
    }
}

module.exports = { createScenes, normalizeSceneEnvironment };
