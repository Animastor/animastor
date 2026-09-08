// ======================================================
// Character Analyzer — C20 functional module boundary
// ======================================================
// AI analysis of characters / entities: extraction of stable characters
// (with visual appearance) + role/title alias → character_id mentions.
//
// Frozen contract (C18 §6 F2):
//   extractCharacters(input, ports) → { characters, mentions }
//
// Uses the generic Agent Core execute() lifecycle:
//   validate ports → progress → step → buildMessages → callAI → complete → normalize
//
// Fail: → throw (after failStep). The RUNNER owns the degradation rule.

const { execute } = require('@animastor/ai-agent');
const { generateVoices } = require('./voices');

const charactersTask = {
    requiredPorts: [
        'callAI', 'logConversation', 'updateSession', 'createStep',
        'completeStep', 'failStep', 'extractingCharactersMessage', 'prompt', 'fillLang',
    ],
    taskName: 'character-analyzer',
    stage: 'extracting_chars',
    progressMessage: (ports) => ports.extractingCharactersMessage,
    stepType: 'analyze_characters',

    buildMessages(input, ports) {
        return {
            messages: [
                { role: 'system', content: ports.fillLang(ports.prompt('characters'), input.language) },
                { role: 'user', content: `Extract all characters from this text:\n\n\`\`\`\n${input.windowText}\n\`\`\`` },
            ],
            options: { maxTokens: 4096 },
        };
    },

    normalize(result) {
        const characters = result.characters || [];
        const mentions = result.mentions || {};
        console.log(`[AGENT] Step 1 (characters): ${characters.length} extracted, ${Object.keys(mentions).length} mentions`);
        return { characters, mentions };
    },

    onError(err) {
        throw err;
    },
};

async function extractCharacters(input, ports) {
    return execute(charactersTask, input, ports);
}

module.exports = {
    extractCharacters,
    generateVoices,
    charactersTask,
};
