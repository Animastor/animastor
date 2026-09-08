// ======================================================
// AI Agent task — createUnits (F5, Unit Analysis)
// ======================================================
// AI analysis decomposing one scene into visual units.
//
// Frozen contract (C18 §6 F5; C21 contour):
//   createUnits(input, ports) → Unit[]
//
// Uses the generic Agent Core execute() lifecycle:
//   validate ports → progress → step → buildMessages → callAI → complete → normalize
//
// Degradation: AI failure → single fallback unit (never throws).
// The scene phase must not crash a window (C18 §6 F5 fail contract).
//
// Ports: callAI, logConversation, updateSession, createStep, completeStep,
//   failStep, creatingUnitsMessage, prompt

const { execute } = require('@animastor/ai-agent');

const unitsTask = {
    requiredPorts: [
        'callAI', 'logConversation', 'updateSession', 'createStep',
        'completeStep', 'failStep', 'creatingUnitsMessage', 'prompt',
    ],
    taskName: 'ai-agent/units',
    stage: 'creating_units',
    progressMessage: (ports) => ports.creatingUnitsMessage,
    stepType: 'create_units',

    buildMessages(input, ports) {
        const sceneText = (input.scene.text || '').trim();
        const truncatedText = sceneText.length > 3000 ? sceneText.substring(0, 3000) + '...' : sceneText;
        const charsContext = (input.characters || []).map(c => `- ${c.id}: ${c.name}`).join('\n') || 'None';

        const knownIds = new Set((input.characters || []).map(c => c.id).filter(Boolean));
        const mentionsContext = (input.mentions && typeof input.mentions === 'object' && Object.keys(input.mentions).length > 0)
            ? '\n## Role/title → character_id mappings\n' +
              'When the text refers to a character by role or title (e.g. "редактор", "глава журнала", "незнакомец в плаще"),\n' +
              'use the mapped character_id below. If a role references an id NOT in the Known Characters list,\n' +
              'describe the character literarily in natural language instead:\n' +
              Object.entries(input.mentions)
                .filter(([, charId]) => knownIds.has(charId))
                .map(([alias, charId]) => `  "${alias}" → ${charId}`).join('\n')
            : '';

        const promptText = ports.prompt('units')
            .replace('%SCENE_TEXT%', truncatedText)
            .replace('%EXISTING_CHARACTERS%', charsContext + mentionsContext);

        return {
            messages: [
                { role: 'system', content: promptText },
                { role: 'user', content: `Decompose this scene into visual units:\n\n\`\`\`\n${truncatedText}\n\`\`\`` },
            ],
            options: { maxTokens: 4096 },
        };
    },

    normalize(result, input) {
        const units = result.units || [];
        if (units.length === 0) {
            const fallbackUnit = { text: (input.scene.text || '').trim(), type: input.scene.type === 'dialogue' ? 'dialogue' : 'narration' };
            if (fallbackUnit.type === 'dialogue') {
                fallbackUnit.audio = { text: (input.scene.text || '').trim() };
            }
            units.push(fallbackUnit);
        }
        const dialogueUnits = units.filter(u => u.type === 'dialogue');
        const withSpeaker = dialogueUnits.filter(u => u.audio?.speaker);
        if (dialogueUnits.length > 0) {
            console.log(`[AGENT] Step 4 (units scene ${input.sceneIndex}): ${dialogueUnits.length} dialogue units, ${withSpeaker.length} with audio.speaker`);
        }
        return units;
    },

    failMessage(err) {
        return `AI failed, using fallback: ${err.message}`;
    },

    onError(err, step, ports, input) {
        const sceneText = (input.scene.text || '').trim();
        console.warn(`[AGENT] Step 4 (scene ${input.sceneIndex}) failed, using fallback: ${err.message}`);
        return [{ text: sceneText, type: input.scene.type === 'dialogue' ? 'dialogue' : 'perception' }];
    },
};

/**
 * Decompose one scene into visual units.
 * @param {object} input { scene, sceneIndex, characters?, mentions?, sessionId, stepIndex?, progress? }
 * @param {object} ports { callAI, logConversation, updateSession, createStep, completeStep, failStep, creatingUnitsMessage, prompt }
 * @returns {Promise<object[]>} units
 */
async function createUnits(input, ports) {
    return execute(unitsTask, input, ports);
}

module.exports = { createUnits, unitsTask };
