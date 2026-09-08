// ======================================================
// AI Agent task — extractLocations (F3, Location Analysis)
// ======================================================
// AI analysis of locations in a window of book text.
//
// Frozen contract (C18 §6 F3; C21 contour):
//   extractLocations(input, ports) → Location[]
//
// Uses the generic Agent Core execute() lifecycle:
//   validate ports → progress → step → buildMessages → callAI → complete → normalize
//
// Ports: callAI, logConversation, updateSession, createStep, completeStep,
//   failStep, extractingLocationsMessage, prompt, fillLang

const { execute } = require('@animastor/ai-agent');

const locationsTask = {
    requiredPorts: [
        'callAI', 'logConversation', 'updateSession', 'createStep',
        'completeStep', 'failStep', 'extractingLocationsMessage', 'prompt', 'fillLang',
    ],
    taskName: 'ai-agent/locations',
    stage: 'extracting_locs',
    progressMessage: (ports) => ports.extractingLocationsMessage,
    stepType: 'analyze_locations',

    buildMessages(input, ports) {
        const charsContext = (input.characters || []).map(c => `- ${c.id}: ${c.name} (${c.role || 'unknown'})`).join('\n') || 'No characters yet';
        const promptText = ports.fillLang(
            ports.prompt('locations').replace('%EXISTING_CHARACTERS%', charsContext),
            input.language
        );
        return {
            messages: [
                { role: 'system', content: promptText },
                { role: 'user', content: `Extract all locations from this text:\n\n\`\`\`\n${input.windowText}\n\`\`\`` },
            ],
            options: { maxTokens: 4096 },
        };
    },

    normalize(result) {
        return result.locations || [];
    },
};

/**
 * Extract locations from a window of book text.
 * @param {object} input { windowText, characters?, language, sessionId, stepIndex?, progress? }
 * @param {object} ports { callAI, logConversation, updateSession, createStep, completeStep, failStep, extractingLocationsMessage, prompt, fillLang }
 * @returns {Promise<object[]>} locations
 */
async function extractLocations(input, ports) {
    return execute(locationsTask, input, ports);
}

module.exports = { extractLocations, locationsTask };
