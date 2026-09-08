// ======================================================
// AI Agent task — createScenes (F4, Scene Analysis)
// ======================================================
// AI analysis splitting a window of book text into scenes.
//
// Frozen contract (C18 §6 F4; C21 contour):
//   createScenes(input, ports) → Scene[]
//
// Uses the generic Agent Core execute() lifecycle:
//   validate ports → progress → step → buildMessages → callAI → complete → normalize
//
// Ports: callAI, logConversation, updateSession, createStep, completeStep,
//   failStep, creatingScenesMessage, prompt, fillLang

const { sanitizeEnvironment } = require('@animastor/vbook-runtime/snake-guard');
const { execute } = require('@animastor/ai-agent');
const { buildLocationsContext } = require('../context');

const SCENE_ENV_FIELDS = ['time', 'season', 'lighting', 'weather', 'mood', 'atmosphere', 'country', 'epoch'];

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
    const sanitized = sanitizeEnvironment(clean);
    if (Object.keys(sanitized).length === 0) {
        const newLoc = { ...loc };
        delete newLoc.environment;
        return { ...scene, location: newLoc };
    }
    return { ...scene, location: { ...loc, environment: sanitized } };
}

const scenesTask = {
    requiredPorts: [
        'callAI', 'logConversation', 'updateSession', 'createStep',
        'completeStep', 'failStep', 'creatingScenesMessage', 'prompt', 'fillLang',
    ],
    taskName: 'ai-agent/scenes',
    stage: 'creating_scenes',
    progressMessage: (ports) => ports.creatingScenesMessage,
    stepType: 'create_scenes',

    buildMessages(input, ports) {
        const charsContext = (input.characters || []).map(c => `- ${c.id}: ${c.name}`).join('\n') || 'None';
        const locsContext = buildLocationsContext(input.locations);

        const bookDefaultParts = [];
        if (input.bookDefault?.country) bookDefaultParts.push(`country: ${input.bookDefault.country}`);
        if (input.bookDefault?.epoch) bookDefaultParts.push(`epoch: ${input.bookDefault.epoch}`);
        const bookDefaultStr = bookDefaultParts.length > 0
            ? bookDefaultParts.join('\n')
            : 'not specified — infer the book\'s default country/epoch from the text itself';

        const promptText = ports.fillLang(
            ports.prompt('scenes')
                .replace('%EXISTING_CHARACTERS%', charsContext)
                .replace('%EXISTING_LOCATIONS%', locsContext)
                .replace('%BOOK_DEFAULT%', bookDefaultStr),
            input.language
        );

        let repairText = '';
        if (input.repairHint) {
            repairText = `\n\nPrevious scene split failed source coverage validation.\nReason: ${input.repairHint.reason || 'unknown'}.\nMissing or problematic source fragment:\n\`\`\`\n${input.repairHint.gap_preview || ''}\n\`\`\`\nReturn a corrected split that starts at the first narrative word and covers a contiguous prefix of the provided text without gaps. Do not skip, overlap, paraphrase, or summarize anything inside the returned scenes. Unused tail text is allowed.`;
        }

        return {
            messages: [
                { role: 'system', content: promptText },
                { role: 'user', content: `Split this text into scenes:\n\n\`\`\`\n${input.sceneText}\n\`\`\`${repairText}` },
            ],
            options: { maxTokens: 6144 },
        };
    },

    normalize(result) {
        const scenes = (result.scenes || []).map(normalizeSceneEnvironment);
        if (scenes.length === 0) throw new Error('AI returned no scenes');

        const withTitle = scenes.filter(s => s.title).length;
        const withLoc = scenes.filter(s => s.location?.id).length;
        const withEnv = scenes.filter(s => s.location?.environment && Object.keys(s.location.environment).length > 0).length;
        const missingTitle = scenes.length - withTitle;
        const missingLoc = scenes.length - withLoc;
        const s0 = scenes[0] || {};
        console.log(`[AGENT] Step 3 (scenes): ${scenes.length} created, title=${withTitle}/${scenes.length}, location.id=${withLoc}/${scenes.length}, env.override=${withEnv}/${scenes.length}, s0.keys=[${Object.keys(s0).join(',')}], s0.title=${JSON.stringify(s0.title)}, s0.location=${JSON.stringify(s0.location)}`);
        if (missingTitle > 0) console.warn(`[AGENT] Step 3: ${missingTitle} scenes MISSING title`);
        if (missingLoc > 0) console.warn(`[AGENT] Step 3: ${missingLoc} scenes MISSING location.id`);

        return scenes;
    },
};

/**
 * Split a window of book text into scenes.
 * @param {object} input { sceneText, characters?, locations?, bookDefault?, repairHint?, chunkSize?, language, sessionId, stepIndex?, progress? }
 * @param {object} ports { callAI, logConversation, updateSession, createStep, completeStep, failStep, creatingScenesMessage, prompt, fillLang }
 * @returns {Promise<object[]>} scenes
 */
async function createScenes(input, ports) {
    return execute(scenesTask, input, ports);
}

module.exports = { createScenes, normalizeSceneEnvironment, scenesTask };
