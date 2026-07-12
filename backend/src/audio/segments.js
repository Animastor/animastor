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
        // Build TTS segments from ALL units in order, preserving interleaving.
        //   dialogue units → dialogue TTS (character voice)
        //   narration/perception/description/action/transition units → narration TTS (narrator voice)
        //   typography units → skipped (chapter intro screens, no spoken audio)
        // units[].audio.speaker is the character_id, units[].audio.text is the dialogue line.
        const units = runtimeEntry.payload?.units || [];
        const segments = [];
        let segmentIdx = 0;

        for (const unit of units) {
            if (unit.type === 'typography') continue;

            if (unit.type === 'dialogue') {
                const speaker = unit.audio?.speaker;
                const text = unit.audio?.text;
                if (!speaker || !text) continue;

                segmentIdx++;
                segments.push({
                    segment_id: String(segmentIdx).padStart(4, "0"),
                    segment_type: "dialogue",
                    text: `${speaker}: ${text}`,
                });
            } else {
                // narration, perception, description, action, transition, performance — all read by narrator
                const rawText = unit.text || '';
                if (!rawText.trim()) continue;

                const isPadded = rawText.length < 40;
                const fullText = isPadded ? padShortText(rawText) : rawText;
                if (isPadded) {
                    helpers.log(`📐 buildSegments (hybrid): short narration text (${rawText.length} chars) → padded mode ON for "${rawText}"`);
                }
                const chunks = splitTextIntoChunks(fullText);
                for (const chunk of chunks) {
                    segmentIdx++;
                    segments.push({
                        segment_id: String(segmentIdx).padStart(4, "0"),
                        segment_type: "narration",
                        text: chunk,
                        padded: isPadded,
                    });
                }
            }
        }

        if (segments.length === 0) {
            helpers.warn('buildSegments: dialogue scene has no valid units — no TTS segments generated');
            return [];
        }

        return segments;
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
