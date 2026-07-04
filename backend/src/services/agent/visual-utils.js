// ======================================================
// Agent Visual Utilities
// ======================================================
// Visual prompt helpers: exemplars, fallback visuals, passport injection logic.

function getFallbackVisual(text, characters, scene) {
    const participants = (scene.participants || []);
    const who = participants.length
        ? participants
              .map(pId => (characters || []).find(c => c.id === pId)?.id || pId)
              .join(' and ')
        : '';
    if (!who) return 'the scene at ' + (scene.location?.id || 'the scene') + ', cinematic shot';
    const locName = scene.location?.id || 'the scene';
    return `${who} at ${locName}, cinematic shot`;
}

function promptMentionsGenericPeople(prompt) {
    const value = String(prompt || '');
    if (/\b(no|without)\s+(people|persons?|men|figures?|characters?|humans?)\b/i.test(value)) {
        return false;
    }
    return /\b(two\s+)?(writers?|men|people|persons?|figures?|citizens?|poets?|editors?)\b/i.test(value);
}

function shouldInjectParticipantPassports(prompt, participantIds, characterBinding) {
    if (!participantIds?.length) return false;
    if (characterBinding !== false) return true;
    return promptMentionsGenericPeople(prompt);
}

function unitTextNeedsScenePairParticipants(text) {
    const value = String(text || '').toLowerCase();
    return /(^|[\s—,.;:!?«"(\[])(первый|второй|писател[ьяеию]|литератор[ыаоеив]*|гражданин[аеыу]*)(?=$|[\s—,.;:!?»")\]])/iu.test(value);
}

function applyScenePairParticipantFallback(units, unitParticipants, sceneParticipants) {
    const sceneIds = [...new Set(sceneParticipants || [])].filter(Boolean);
    if (sceneIds.length !== 2) return unitParticipants || {};

    const result = { ...(unitParticipants || {}) };
    for (let ui = 0; ui < (units || []).length; ui++) {
        if (result[ui]?.length) continue;
        if (unitTextNeedsScenePairParticipants(units[ui]?.text)) {
            result[ui] = sceneIds;
        }
    }
    return result;
}

function buildVisualExemplars() {
    try {
        const examples = require('../ai-loader').getExamples();
        if (!examples) return '';

        let best = null;
        for (const data of Object.values(examples)) {
            const scenes = data?.scenes || (data?.scene ? [data.scene] : []);
            for (const sc of scenes) {
                const parts = sc?.participants || [];
                if (!parts.length) continue;
                const lines = (sc.units || [])
                    .map(u => u.visual)
                    .filter(v => v && typeof v.prompt === 'string' && v.prompt.trim())
                    .map(v => ({ shot: v.shot || 'medium', prompt: v.prompt.trim() }));
                if (lines.length >= 3 && (!best || lines.length > best.lines.length)) {
                    best = { participants: parts, lines: lines.slice(0, 4) };
                }
            }
        }
        if (!best) return '';

        const rows = best.lines
            .map((l, i) => `  Unit ${i + 1} (${l.shot}): ${l.prompt}`)
            .join('\n');
        return `\n## Worked example (real doctrine-compliant sequence — note how the base composition repeats and only the action changes)\nParticipants named every time: ${best.participants.join(', ')}\n${rows}\n`;
    } catch (err) {
        console.warn(`[AGENT] Failed to build visual exemplars: ${err.message}`);
        return '';
    }
}

function formatExamplesForPrompt() {
    try {
        const examples = require('../ai-loader').getExamples();
        if (!examples || Object.keys(examples).length === 0) return '';

        const parts = [];

        for (const [name, data] of Object.entries(examples)) {
            const bookScenes = data?.result?.chapters?.[0]?.scenes;
            if (Array.isArray(bookScenes) && bookScenes.length > 0) {
                parts.push(`--- Example: "${name}" — book structure ---`);
                for (const sc of bookScenes) {
                    const textLen = (sc.text || sc.audio?.full_text || '').length;
                    const participants = (sc.participants || []).join(', ') || 'none';
                    parts.push(`  Scene "${sc.title || sc.scene_title || 'untitled'}" (${sc.type || 'unknown'}): ${textLen} chars, participants: ${participants}`);
                }
                parts.push(`  (Total: ${bookScenes.length} scenes for this chapter)\n`);
                continue;
            }

            const sceneData = data?.scene || data?.scenes?.[0];
            if (sceneData && (sceneData.units || sceneData.audio)) {
                parts.push(`--- Example: "${name}" — scene structure ---`);
                const title = sceneData.scene_title || sceneData.title || 'untitled';
                parts.push(`  Title: "${title}" (${sceneData.type || 'unknown'})`);
                if (sceneData.location?.id) {
                    parts.push(`  Location: ${sceneData.location.id}`);
                }
                if (sceneData.participants?.length) {
                    parts.push(`  Participants: ${sceneData.participants.join(', ')}`);
                }
                const textLen = (sceneData.text || sceneData.audio?.full_text || '').length;
                parts.push(`  Text length: ${textLen} chars`);
                const units = sceneData.units || [];
                if (units.length > 0) {
                    parts.push(`  Units: ${units.length} visual units`);
                }
                parts.push('');
                continue;
            }

            const keys = Object.keys(data || {});
            parts.push(`--- Example: "${name}" — ${keys.length > 0 ? `${keys.length} top-level key(s)` : 'empty'} ---`);
        }

        return parts.join('\n');
    } catch (err) {
        console.warn(`[AGENT] Failed to load examples for prompt: ${err.message}`);
        return '';
    }
}

module.exports = {
    getFallbackVisual,
    promptMentionsGenericPeople,
    shouldInjectParticipantPassports,
    unitTextNeedsScenePairParticipants,
    applyScenePairParticipantFallback,
    buildVisualExemplars,
    formatExamplesForPrompt,
};
