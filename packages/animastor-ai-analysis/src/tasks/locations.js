// ======================================================
// AI Agent task — extractLocations (F3, Location Analysis)
// ======================================================
// AI analysis of locations in a window of book text.
//
// Frozen contract (C18 §6 F3; C21 contour):
//
//   extractLocations(input, ports) → Location[]
//
//     input: {
//       windowText: string,          // window text as produced by the host
//                                    // (markers included); passed to the LLM
//                                    // verbatim
//       characters: Character[],     // EXISTING character set — prompt context
//                                    // only (never mutated here)
//       language: string,            // prompt localization (%LANGUAGE% fill)
//       sessionId, stepIndex, progress,   // session/progress = ports
//     }
//
//     output: Location[] { id, name, type, description, environment? }
//       — consumed by the runner's merge contract (by-id merge, longer
//         description wins, environment sanitized host-side). Unchanged.
//
//     fail: → failStep + throw (after failStep). The RUNNER owns the
//             degradation rule: it keeps the existing location set
//             (no info ≠ 'unknown'). The task never writes registries.
//
// Ports (host-injected; no ambient access, no PG/Redis/fs inside):
//   callAI(messages, options) → parsed JSON — the single LLM seam.
//   logConversation(sessionId, stepId, messages, response) — conversation log.
//   updateSession / createStep / completeStep / failStep — session & step
//     persistence (agent-session impls passed by the host adapter).
//   extractingLocationsMessage — user-facing progress text
//     (PROGRESS_STAGES.extracting_locs).
//   prompt(name) → string — prompt source (SYSTEM_PROMPTS.locations;
//     ai/rules/locations.md — content unchanged).
//   fillLang(template, language) → string — %LANGUAGE% fill.
//
// Own prompt: the task assembles its own prompt (existing-characters context
// block + window text) — prompt/rules stay task-local (C21 §4: each
// operation keeps its own prompt/rules/input contract/output contract).

const { assertHostPorts } = require('@animastor/ai-agent');

/**
 * Extract locations from a window of book text.
 *
 * @param {object} input { windowText, characters?, language,
 *                         sessionId, stepIndex?, progress? }
 * @param {object} ports { callAI, logConversation, updateSession, createStep,
 *                         completeStep, failStep, extractingLocationsMessage,
 *                         prompt, fillLang }
 * @returns {Promise<object[]>} locations (C18 §6 F3 shape)
 */
async function extractLocations(input, ports) {
    const {
        callAI, logConversation, updateSession, createStep, completeStep, failStep,
        extractingLocationsMessage, prompt, fillLang,
    } = assertHostPorts(ports, [
        'callAI', 'logConversation', 'updateSession', 'createStep',
        'completeStep', 'failStep', 'extractingLocationsMessage', 'prompt', 'fillLang',
    ], 'ai-agent/locations');

    const _progress = input.progress || (() => {});
    _progress({ stage: 'extracting_locs', message: extractingLocationsMessage });
    await updateSession(input.sessionId, { progress_msg: extractingLocationsMessage });

    const step = await createStep(input.sessionId, 'analyze_locations', input.stepIndex || 0);

    const charsContext = (input.characters || []).map(c => `- ${c.id}: ${c.name} (${c.role || 'unknown'})`).join('\n') || 'No characters yet';
    const promptText = fillLang(
        prompt('locations').replace('%EXISTING_CHARACTERS%', charsContext),
        input.language
    );

    const messages = [
        { role: 'system', content: promptText },
        { role: 'user', content: `Extract all locations from this text:\n\n\`\`\`\n${input.windowText}\n\`\`\`` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 4096 });
        const locations = result.locations || [];
        await logConversation(input.sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, locations);
        console.log(`[AGENT] Step 2 (locations): ${locations.length} extracted`);
        return locations;
    } catch (err) {
        await failStep(step.step_id, err.message);
        throw err;
    }
}

module.exports = { extractLocations };
