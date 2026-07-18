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
    const rawVoiceId = scene?.audio?.voice;
    // 🔧 FIX: "dialogue" — это идентификатор типа сцены, а не voice ID.
    // Если scene.audio.voice установлен в "dialogue", игнорируем его
    // и используем narrator voice по умолчанию.
    const isFakeVoiceId = rawVoiceId === 'dialogue' || rawVoiceId === 'narration';
    const voiceId = (!rawVoiceId || isFakeVoiceId)
        ? (book?.book?.defaults?.narration_voice || "narrator")
        : rawVoiceId;
    if (voiceId === "narrator") {
        return book?.voices?.narrator?.instruction || book?.bible?.narrator?.voice?.instruction || "";
    }
    return book?.voices?.[voiceId]?.instruction
        || book?.characters?.find(x => x.id === voiceId)?.voice?.instruction
        || "";
}

function padShortText(text) {
    if (text.length >= 40) return text;
    return text + " " + text;
}

/**
 * Check that a substring match is at a word boundary (not inside another word).
 * Uses Unicode letter class \p{L} for multilingual support.
 *
 * Prevents substring collisions like matching "да" inside "дала".
 */
function isAtWordBoundary(text, idx, matchLen) {
    if (idx > 0) {
        const before = text[idx - 1];
        if (/\p{L}/u.test(before)) return false;
    }
    if (idx + matchLen < text.length) {
        const after = text[idx + matchLen];
        if (/\p{L}/u.test(after)) return false;
    }
    return true;
}

/**
 * Extract embedded narration from a hybrid dialogue unit (language-agnostic).
 *
 * Handles two patterns across ALL languages:
 *
 * Pattern A — post-dialogue narration:  "— DIALOGUE, — narration."
 *   🇷🇺 «— Нарзану нету, — ответила женщина.»
 *   🇬🇧 «"Nope," said the woman.»
 *   🇫🇷 «« Non, » répondit la femme.»
 *   → narration extracted from AFTER the spoken dialogue.
 *
 * Pattern B — pre-dialogue narration:   "Narration: — DIALOGUE."
 *   🇷🇺 «Женщина ответила: — Нарзану нету.»
 *   🇬🇧 «The woman said: "Nope."»
 *   → narration extracted from BEFORE the spoken dialogue.
 *
 * Returns:
 *   null        → fallback: extraction is crooked (substring collision, AI
 *                 inconsistency, or missing data). Caller should send the
 *                 ENTIRE unit.text to the narrator voice.
 *   ''          → clean extraction: no embedded narration found.
 *                 Caller should proceed with dialogue segment only.
 *   {pre, post} → clean extraction with pre-dialogue narration (.pre) and/or
 *                 post-dialogue narration (.post). Caller should emit:
 *                 [pre-narration] → [dialogue] → [post-narration]
 */
function extractNarrationFromDialogueUnit(unit) {
    if (!unit.audio?.text || !unit.text) return null;

    const fullText = unit.text.trim();
    const dialogueText = unit.audio.text.trim();

    // Universal normalisation: strip common opening dialogue markers
    // for text-matching purposes. Covers all major languages:
    //   —  (em dash: Russian, Spanish)
    //   "  (double quote: English, many)
    //   « » (guillemets: French, Italian, Russian alt)
    //   „ „ (low-high: German, Bulgarian)
    //   ‘ ’ (single quote: English alt)
    const openers = /^["'`'«»„“\s— \-]+/;
    const normFull = fullText.replace(openers, '');
    const normDialogue = dialogueText.replace(openers, '');

    // Guard: empty normDialogue after stripping opener markers
    // (e.g. audio.text was only "— " or """ — edge case)
    if (!normDialogue) return null;

    // Find the spoken dialogue text in the full text
    const idx = normFull.indexOf(normDialogue);
    if (idx === -1) return null;

    // Word-boundary guard: reject if dialogue text matches inside another word
    // e.g. audio.text="да" matching inside "дала"
    if (!isAtWordBoundary(normFull, idx, normDialogue.length)) return null;

    // Extract prefix (Pattern B: narration BEFORE dialogue)
    const prefix = normFull.substring(0, idx).trim();

    // Extract suffix (Pattern A: narration AFTER dialogue)
    const suffix = normFull.substring(idx + normDialogue.length).trim();

    // Return pre/post separately so caller can order segments correctly.
    // Preserve ALL punctuation — it carries prosody and affects timing.
    const pre = (prefix && prefix.length >= 2) ? prefix : '';
    const post = (suffix && suffix.length >= 2) ? suffix : '';

    if (!pre && !post) return '';

    return { pre, post };
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

                // Try to extract embedded narration.
                // null → fallback (crooked), '' → pure dialogue,
                // {pre, post} → hybrid with ordering info
                const extractResult = extractNarrationFromDialogueUnit(unit);

                if (extractResult === null) {
                    // FALLBACK: crooked extraction (substring collision, AI
                    // inconsistency). Whole unit goes to narrator voice — no
                    // dialogue segment. Better safe than character says wrong text.
                    const rawText = unit.text || '';
                    if (!rawText.trim()) continue;

                    const isPadded = rawText.length < 40;
                    const fullText = isPadded ? padShortText(rawText) : rawText;
                    if (isPadded) {
                        helpers.log(`📐 buildSegments (hybrid fallback): crooked dialogue → whole unit to narrator, padded for "${rawText}"`);
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
                    continue;
                }

                // Pre-narration BEFORE dialogue
                // Pattern B: "Narration: — DIALOGUE." → narrator sets up, character speaks
                // Pad if short (< 40 chars): Qwen-TTS produces garbage for <3s audio.
                // trimPaddedSceneAudio later removes the duplicate per-chunk.
                if (extractResult && extractResult.pre) {
                    const isPadded = extractResult.pre.length < 40;
                    const fullNarration = isPadded ? padShortText(extractResult.pre) : extractResult.pre;
                    if (isPadded) {
                        helpers.log(`📐 buildSegments (hybrid unit): short embedded narration (pre ${extractResult.pre.length} chars) → padded mode ON for "${extractResult.pre}"`);
                    }
                    segmentIdx++;
                    segments.push({
                        segment_id: String(segmentIdx).padStart(4, "0"),
                        segment_type: "narration",
                        text: fullNarration,
                        padded: isPadded,
                    });
                }

                // Dialogue segment in the middle
                segmentIdx++;
                segments.push({
                    segment_id: String(segmentIdx).padStart(4, "0"),
                    segment_type: "dialogue",
                    text: `${speaker}: ${text}`,
                });

                // Post-narration AFTER dialogue
                // Pattern A: "— DIALOGUE, — narration." → character speaks, narrator describes
                // Same padding reasoning as pre-narration.
                if (extractResult && extractResult.post) {
                    const isPadded = extractResult.post.length < 40;
                    const fullNarration = isPadded ? padShortText(extractResult.post) : extractResult.post;
                    if (isPadded) {
                        helpers.log(`📐 buildSegments (hybrid unit): short embedded narration (post ${extractResult.post.length} chars) → padded mode ON for "${extractResult.post}"`);
                    }
                    segmentIdx++;
                    segments.push({
                        segment_id: String(segmentIdx).padStart(4, "0"),
                        segment_type: "narration",
                        text: fullNarration,
                        padded: isPadded,
                    });
                }
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
    extractNarrationFromDialogueUnit,
};
