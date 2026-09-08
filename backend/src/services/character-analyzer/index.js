// ======================================================
// Character Analyzer — C20 functional module boundary
// ======================================================
// AI analysis of characters / entities: extraction of stable characters
// (with visual appearance) + role/title alias → character_id mentions.
//
// Frozen contract (docs/architecture/character-analyzer-extraction-c20.md):
//
//   extractCharacters(input, ports) → { characters, mentions }
//
//     input: {
//       windowText: string,          // the window text as produced by the
//                                    // host (markers included); passed to the
//                                    // LLM verbatim — no normalize across the
//                                    // boundary
//       language: string,            // prompt localization (%LANGUAGE% fill)
//       sessionId, stepIndex, progress,   // session/progress = ports
//     }
//
//     output: { characters: Character[], mentions: { alias → character_id } }
//       — the C18 §6 F2 shape consumed by the runner's merge contract
//         (mergeCharacterLists) and persisted by the host (window_data,
//         Book Writer). Unchanged.
//
//     fail: → throw (after failStep). The RUNNER owns the degradation rule:
//             it keeps the existing character set (empty ≠ 'unknown' — no
//             placeholder synthesis). The analyzer never writes registries.
//
//   generateVoices(input, ports) → { voices }   (F7 voice authoring, semi-final
//     seam — character-attribute authoring; mutates characters[i].voice in
//     place exactly as before, never overwrites meaningful voices)
//
// Ports (host-injected; no ambient access, no PG/Redis/fs inside):
//   callAI(messages, options) → parsed JSON — the single LLM seam.
//   logConversation(sessionId, stepId, messages, response) — conversation log.
//   updateSession / createStep / completeStep / failStep — session & step
//     persistence (agent-session impls passed by the host adapter).
//   extractingCharactersMessage / voiceGenerationMessage — user-facing
//     progress text (PROGRESS_STAGES).
//   prompt(name) → string — prompt source (SYSTEM_PROMPTS.characters /
//     SYSTEM_PROMPTS.voice_generation; ai/rules/characters.md,
//     ai/rules/voice_generation.md — content unchanged).
//   fillLang(template, language) → string — %LANGUAGE% fill.
//   buildSkill(domain, profile) → string|null — audio skill injection for
//     voice authoring (prompt-profile-loader via the host adapter).
//
// Merge/dedup contract: the PURE merge implementation
// (mergeCharacterLists / isPlaceholderCharacter / findCanonicalCharacter /
// hasRealAppearance) is owned by @animastor/vbook-runtime/character-identity
// and is SHARED with the Book Writer write barrier — it is deliberately NOT
// re-exported or duplicated here (C20 §6: no second implementation, no
// deterministic routing through the AI module). The host (pipeline-runner)
// applies it to this module's output.
//
// Replaceability: to replace Character Analysis, replace THIS module (or
// inject ports.callAI) — without touching Structure/Location/Scene analysis,
// Generation passes, the Importer, or the Book Writer. Persistence and the
// LLM transport stay host-side.
// ======================================================

const { generateVoices } = require('./voices');

async function extractCharacters(input, ports) {
    const _ports = ports || {};
    const REQUIRED_PORTS = [
        'callAI', 'logConversation', 'updateSession', 'createStep',
        'completeStep', 'failStep', 'extractingCharactersMessage', 'prompt', 'fillLang',
    ];
    const missing = REQUIRED_PORTS.filter((p) => !_ports[p]);
    if (missing.length) {
        throw new Error(`character-analyzer: missing host port(s): ${missing.join(', ')} — persistence and the LLM seam are host-injected (C20 §5)`);
    }
    const {
        callAI, logConversation, updateSession, createStep,
        completeStep, failStep, extractingCharactersMessage, prompt, fillLang,
    } = _ports;

    const _progress = input.progress || (() => {});
    _progress({ stage: 'extracting_chars', message: extractingCharactersMessage });
    await updateSession(input.sessionId, { progress_msg: extractingCharactersMessage });

    const step = await createStep(input.sessionId, 'analyze_characters', input.stepIndex || 0);

    const messages = [
        { role: 'system', content: fillLang(prompt('characters'), input.language) },
        { role: 'user', content: `Extract all characters from this text:\n\n\`\`\`\n${input.windowText}\n\`\`\`` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 4096 });
        const characters = result.characters || [];
        const mentions = result.mentions || {};
        await logConversation(input.sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, { characters, mentions });
        console.log(`[AGENT] Step 1 (characters): ${characters.length} extracted, ${Object.keys(mentions).length} mentions`);
        return { characters, mentions };
    } catch (err) {
        await failStep(step.step_id, err.message);
        throw err;
    }
}

module.exports = {
    extractCharacters,
    // F7 voice authoring lives in ./voices — re-exported so the whole
    // Character Analyzer is reachable through one module seam
    generateVoices,
};
