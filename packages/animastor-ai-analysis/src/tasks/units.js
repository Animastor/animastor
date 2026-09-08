// ======================================================
// AI Agent task — createUnits (F5, Unit Analysis)
// ======================================================
// AI analysis decomposing one scene into visual units (verbatim text
// fragments typed narration/dialogue/perception, optional audio.speaker for
// dialogue). The long-unit duration splitting (unit-splitter, AI-first with
// deterministic emergency chain) remains a separate host-wired step — the
// C21 contour owns the scene→units AI analysis step.
//
// Frozen contract (C18 §6 F5; C21 contour):
//
//   createUnits(input, ports) → Unit[]
//
//     input: {
//       scene: { text, type, ... },  // the scene being decomposed
//       sceneIndex: number,          // global scene index (step bookkeeping:
//                                    // agent_steps.scene_index + progress msg)
//       characters: Character[],     // registry context (%EXISTING_CHARACTERS%)
//       mentions?: { alias → character_id },  // role/title alias context
//       sessionId, stepIndex, progress,
//     }
//
//     output: Unit[] { text (verbatim from scene), type, audio? { speaker? } }
//       — consumed by the runner (splitLongUnits → stepCreateVisuals).
//         Unchanged.
//
//     fail: → failStep + warn + single fallback unit (whole scene text,
//             'dialogue' when the scene is dialogue, 'perception' otherwise).
//             NEVER throws — the scene phase must not crash a window
//             (C18 §6 F5 fail contract, unchanged).
//
// Ports (host-injected; no ambient access, no PG/Redis/fs inside):
//   callAI / logConversation / updateSession / createStep / completeStep /
//     failStep — the shared host seam (see @animastor/ai-agent).
//   creatingUnitsMessage(sceneIndex) → string — user-facing progress text
//     (PROGRESS_STAGES.creating_units).
//   prompt(name) → string — prompt source (SYSTEM_PROMPTS.units;
//     ai/rules/units.md — content unchanged). NOTE: the units prompt is NOT
//     language-filled (pre-existing behavior, preserved verbatim).
//
// Own prompt: the task assembles its own prompt (scene text preview,
// known-characters + role/title mentions context) — prompt/rules stay
// task-local (C21 §4).

const { assertHostPorts } = require('@animastor/ai-agent');

/**
 * Decompose one scene into visual units.
 *
 * @param {object} input { scene, sceneIndex, characters?, mentions?,
 *                         sessionId, stepIndex?, progress? }
 * @param {object} ports { callAI, logConversation, updateSession, createStep,
 *                         completeStep, failStep, creatingUnitsMessage, prompt }
 * @returns {Promise<object[]>} units (C18 §6 F5 shape)
 */
async function createUnits(input, ports) {
    const {
        callAI, logConversation, updateSession, createStep, completeStep, failStep,
        creatingUnitsMessage, prompt,
    } = assertHostPorts(ports, [
        'callAI', 'logConversation', 'updateSession', 'createStep',
        'completeStep', 'failStep', 'creatingUnitsMessage', 'prompt',
    ], 'ai-agent/units');

    const _progress = input.progress || (() => {});
    const msg = creatingUnitsMessage(input.sceneIndex);
    _progress({ stage: 'creating_units', message: msg });
    await updateSession(input.sessionId, { progress_msg: msg });

    const step = await createStep(input.sessionId, 'create_units', input.stepIndex || 0, input.sceneIndex);

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

    const promptText = prompt('units')
        .replace('%SCENE_TEXT%', truncatedText)
        .replace('%EXISTING_CHARACTERS%', charsContext + mentionsContext);

    const messages = [
        { role: 'system', content: promptText },
        { role: 'user', content: `Decompose this scene into visual units:\n\n\`\`\`\n${truncatedText}\n\`\`\`` },
    ];        try {
        const result = await callAI(messages, { maxTokens: 4096 });
        const units = result.units || [];
        if (units.length === 0) {
            const fallbackUnit = { text: sceneText, type: input.scene.type === 'dialogue' ? 'dialogue' : 'narration' };
            if (fallbackUnit.type === 'dialogue') {
                fallbackUnit.audio = { text: sceneText };
            }
            units.push(fallbackUnit);
        }
        // Log speaker presence for dialogue units
        const dialogueUnits = units.filter(u => u.type === 'dialogue');
        const withSpeaker = dialogueUnits.filter(u => u.audio?.speaker);
        if (dialogueUnits.length > 0) {
            console.log(`[AGENT] Step 4 (units scene ${input.sceneIndex}): ${dialogueUnits.length} dialogue units, ${withSpeaker.length} with audio.speaker`);
        }
        await logConversation(input.sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, units);
        console.log(`[AGENT] Step 4 (units scene ${input.sceneIndex}): ${units.length} units`);
        return units;
    } catch (err) {
        await failStep(step.step_id, `AI failed, using fallback: ${err.message}`);
        console.warn(`[AGENT] Step 4 (scene ${input.sceneIndex}) failed, using fallback: ${err.message}`);
        return [{ text: sceneText, type: input.scene.type === 'dialogue' ? 'dialogue' : 'perception' }];
    }
}

module.exports = { createUnits };
