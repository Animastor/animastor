// ======================================================
// Audio Segments
// ======================================================

const helpers = require('./helpers');

function splitTextIntoChunks(text, maxChars = 250) {
    if (!text?.trim()) return [];
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const chunks = [];
    let current = "";
    for (const sentence of sentences) {
        const test = current ? current + " " + sentence : sentence;
        if (test.length > maxChars) {
            if (current.trim()) chunks.push(current.trim());
            current = sentence;
        } else {
            current = test;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
}

function splitDialogueIntoChunks(text, maxChars = 250) {
    if (!text?.trim()) return [];
    text = text.replace(/\r/g, "").trim();
    const lines = text.match(/[a-z0-9_]+:\s.*?(?=\n[a-z0-9_]+:|$)/gis) || [text];
    const chunks = [];
    let current = "";
    for (const rawLine of lines) {
        const line = rawLine.trim();
        const test = current ? current + "\n" + line : line;
        if (test.length > maxChars) {
            if (current.trim()) chunks.push(current.trim());
            current = line;
        } else {
            current = test;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
}

function narratorVoice(scene, book) {
    const voiceId = scene?.audio?.voice || book?.book?.defaults?.narration_voice || "narrator";
    if (voiceId === "narrator") {
        return book?.voices?.narrator?.instruction || book?.bible?.narrator?.voice?.instruction || "";
    }
    return book?.voices?.[voiceId]?.instruction
        || book?.characters?.find(x => x.id === voiceId)?.voice?.instruction
        || "";
}

function padShortText(text) {
    if (text.length >= 40) return text;
    helpers.log(`📐 Short text detected (${text.length} chars) — duplicating: "${text}" → "${text} ${text}"`);
    return text + " " + text;
}

function buildSegments(runtimeEntry) {
    if (runtimeEntry.runtime_type === "scene" && (runtimeEntry.scene_type === "narration" || runtimeEntry.scene_type === "chapter_intro" || runtimeEntry.scene_type === "cover")) {
        const rawText = runtimeEntry.payload?.audio?.full_text || "";
        const isPadded = rawText.length < 40;
        const fullText = isPadded ? padShortText(rawText) : rawText;
        if (isPadded) {
            helpers.log(`📐 buildSegments: short text (${rawText.length} chars) → padded mode ON for "${rawText}"`);
        }
        const chunks = splitTextIntoChunks(fullText);
        return chunks.map((text, i) => ({
            segment_id: String(i + 1).padStart(4, "0"),
            segment_type: "narration",
            text,
            padded: isPadded
        }));
    }
    if (runtimeEntry.runtime_type === "scene" && runtimeEntry.scene_type === "dialogue") {
        // Build TTS script from units with speaker field.
        // units[].speaker is the character_id, units[].text is the dialogue line.
        const units = runtimeEntry.payload?.units || [];
        const dialogueLines = units
            .filter(u => u.type === 'dialogue' && u.speaker && u.text)
            .map(u => `${u.speaker}: ${u.text}`);

        if (dialogueLines.length === 0) {
            // Fallback: try parsing audio.full_text as script (for backward compat)
            const fullText = runtimeEntry.payload?.audio?.full_text || "";
            const chunks = splitDialogueIntoChunks(fullText);
            if (chunks.length > 0) {
                return chunks.map((text, i) => ({
                    segment_id: String(i + 1).padStart(4, "0"),
                    segment_type: "dialogue",
                    text
                }));
            }
            return [];
        }

        const script = dialogueLines.join('\n');
        const chunks = splitDialogueIntoChunks(script);
        return chunks.map((text, i) => ({
            segment_id: String(i + 1).padStart(4, "0"),
            segment_type: "dialogue",
            text
        }));
    }
    return [];
}

module.exports = {
    splitTextIntoChunks,
    splitDialogueIntoChunks,
    narratorVoice,
    padShortText,
    buildSegments,
};
