// ======================================================
// Character Analyzer — F7 Voice Authoring (semi-final seam)
// ======================================================
// Character-attribute authoring step: analyzes dialogue from the window text
// and writes voice instructions into characters[i].voice IN PLACE (the F7
// write-back contract, C18 §4/§6 — unchanged). This is the audio-adjacent
// half of the Character Analyzer: it consumes the MERGED character set and
// never creates characters.
//
// Skip rules (unchanged):
//   - only characters with a real described appearance (hasRealAppearance —
//     the shared @animastor/vbook-runtime/character-identity predicate);
//   - only meaningful-voice gaps; existing voices are NEVER overwritten.
//
// Fail contract (unchanged): any AI failure → failStep + warn, returns
// { voices: {} }; existing character voices are kept.
//
// Ports: see ./index.js header (buildSkill = audio skill injection from the
// host's prompt-profile loader). No PG/Redis/fs access inside.

const { hasRealAppearance } = require('@animastor/vbook-runtime/character-identity');

async function generateVoices(input, ports) {
    const _ports = ports || {};
    const REQUIRED_PORTS = [
        'callAI', 'logConversation', 'updateSession', 'createStep',
        'completeStep', 'failStep', 'voiceGenerationMessage', 'prompt', 'fillLang', 'buildSkill',
    ];
    const missing = REQUIRED_PORTS.filter((p) => !_ports[p]);
    if (missing.length) {
        throw new Error(`character-analyzer: missing host port(s): ${missing.join(', ')} — persistence and the LLM seam are host-injected (C20 §5)`);
    }
    const {
        callAI, logConversation, updateSession, createStep,
        completeStep, failStep, voiceGenerationMessage, prompt, fillLang, buildSkill,
    } = _ports;

    const _progress = input.progress || (() => {});
    _progress({ stage: 'voice_generation', message: voiceGenerationMessage });
    await updateSession(input.sessionId, { progress_msg: voiceGenerationMessage });

    const characters = input.characters;
    const promptProfiles = input.promptProfiles;

    // Only REAL characters get voice profiles. A character must have an actual
    // appearance description (the entry criterion in characters.md). A
    // dialogue-only participant without a described appearance is NOT a
    // character — no voice is invented for them; the audio pipeline assigns a
    // default voice automatically. Shared predicate (character-identity) —
    // looks at the WHOLE aggregate (passport/appearance/clothes/description),
    // not at the name alone.
    const viableChars = (characters || []).filter(c => c.id && c.name && hasRealAppearance(c));
    if (viableChars.length === 0) {
        console.log('[AGENT] Step voice_generation: skipped — no characters with described appearance to generate voices for');
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

    const step = await createStep(input.sessionId, 'generate_voices', input.stepIndex || 0);

    const charsContext = viableChars.map(c =>
        `- ${c.id}: ${c.name}\n` +
        `  role: ${c.role || 'unknown'}\n` +
        `  description: ${(c.description || '').substring(0, 300)}\n` +
        `  appearance: ${(c.appearance || c.passport?.appearance || '').substring(0, 400)}\n` +
        `  traits: ${(c.traits || []).slice(0, 5).join(', ') || 'none'}\n` +
        `  current_voice: ${c.voice || '(none)'}`
    ).join('\n');

    // Use full text (up to 8000 chars) for dialogue analysis
    const truncatedText = (input.windowText || '').length > 8000
        ? (input.windowText || '').substring(0, 8000) + '...'
        : (input.windowText || '');

    // Inject the audio/TTS skill when a profile is configured (there is no
    // 'default' skill): the voice-instruction authoring rules for the active
    // TTS model live in skills/audio/{qwen-tts,...}.md.
    let voicePrompt = prompt('voice_generation');
    const audioSkill = buildSkill('audio', promptProfiles?.audioProfile || null);
    if (audioSkill) {
        voicePrompt = `${audioSkill}\n\n${voicePrompt}`;
    }

    const systemPrompt = fillLang(
        voicePrompt
            .replace('%CHARACTERS%', charsContext)
            .replace('%TEXT%', truncatedText),
        input.language
    );

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Analyze the source text and generate voice descriptions for characters who have DIALOGUE LINES (speech). Skip characters who only appear in narration and never speak. Do NOT generate narrator voice.\n\nCharacters:\n${charsContext}\n\nSource text for analysis:\n${truncatedText}` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 4096 });
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

        await logConversation(input.sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, { voices: Object.keys(voices).length });
        console.log(`[AGENT] Step voice_generation: ${Object.keys(voices).length}/${viableChars.length} characters got voice descriptions`);
        return { voices };
    } catch (err) {
        await failStep(step.step_id, err.message);
        console.warn(`[AGENT] Step voice_generation FAILED: ${err.message} — keeping existing character voices`);
        return { voices: {} };
    }
}

module.exports = { generateVoices };
