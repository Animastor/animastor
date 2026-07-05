// ======================================================
// Agent Text Utilities
// ======================================================
// Text splitting, scene title extraction, fallback scene building.

const { estimateSpeechDurationSec } = require('../placeholder-audio');
const { extractSceneTitle, isGenericSceneTitle } = require('../../utils/scene-title-utils');
const {
    MAX_SCENES_PER_CHUNK, SCENE_TARGET_SEC, SCENE_MAX_SEC, SCENE_MIN_SEC,
} = require('../agent-prompts');

function stripStructureFromText(sourceText, structure) {
    const lines = sourceText.split('\n');
    const linesToRemove = new Set();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        if (structure.author && line === structure.author.trim()) {
            linesToRemove.add(i);
            continue;
        }

        if (structure.title && line === structure.title.trim()) {
            linesToRemove.add(i);
            continue;
        }

        for (const part of structure.parts || []) {
            if (line === (part.name || '').trim()) {
                linesToRemove.add(i);
                break;
            }
        }

        for (const ch of structure.chapters || []) {
            const hl = (ch.header_line || '').trim();
            if (!hl) continue;

            const headerParts = hl.split('\n').map(p => p.trim()).filter(Boolean);
            for (const part of headerParts) {
                if (line === part) {
                    linesToRemove.add(i);
                    break;
                }
            }

            const chTitle = (ch.title || '').trim();
            if (chTitle && chTitle.length > 2 && line === chTitle && !linesToRemove.has(i)) {
                linesToRemove.add(i);
            }
        }
    }

    const cleanLines = lines.filter((_, i) => !linesToRemove.has(i));
    return cleanLines.join('\n').trim();
}

function splitIntoSentences(text) {
    return splitIntoSentencesWithOffsets(text).map(s => s.text);
}

function splitIntoSentencesWithOffsets(text) {
    const t = String(text || '');
    const sentences = [];
    let start = 0;
    for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        const isTerminal = ch === '.' || ch === '!' || ch === '?' || ch === '\u2026';
        const isHardBreak = ch === '\n' && t[i + 1] === '\n';
        if (isTerminal) {
            let j = i + 1;
            while (j < t.length && /[.!?\u2026"'\u00bb\u201d)\]]/.test(t[j])) j++;
            const raw = t.slice(start, j);
            if (raw.trim()) sentences.push({ text: raw.trim(), start, end: j });
            start = j;
            i = j - 1;
        } else if (isHardBreak) {
            const raw = t.slice(start, i);
            if (raw.trim()) sentences.push({ text: raw.trim(), start, end: i });
            start = i + 1;
        }
    }
    const tail = t.slice(start);
    if (tail.trim()) sentences.push({ text: tail.trim(), start, end: t.length });
    return sentences;
}

function splitTextEvenlyByParagraphs(text, maxScenes) {
    const paragraphRe = /\S[\s\S]*?(?=\n\s*\n|$)/g;
    const paragraphs = [];
    let match;
    while ((match = paragraphRe.exec(text || '')) !== null) {
        const raw = match[0];
        const start = match.index + (raw.match(/^\s*/)?.[0].length || 0);
        const trimmed = raw.trim();
        if (trimmed) {
            paragraphs.push({
                start,
                end: start + trimmed.length,
            });
        }
        if (match.index === paragraphRe.lastIndex) paragraphRe.lastIndex++;
    }

    if (paragraphs.length === 0) return [];
    if (paragraphs.length <= maxScenes) {
        return paragraphs.map(p => text.slice(p.start, p.end));
    }

    const scenes = [];
    let current = [];
    const targetChars = Math.ceil(text.length / maxScenes);

    for (const p of paragraphs) {
        const currentStart = current[0]?.start ?? p.start;
        const currentEnd = current[current.length - 1]?.end ?? p.end;
        const currentLen = currentEnd - currentStart;
        if (current.length > 0 && scenes.length < maxScenes - 1 && currentLen + (p.end - p.start) > targetChars) {
            scenes.push(text.slice(currentStart, currentEnd).trim());
            current = [p];
        } else {
            current.push(p);
        }
    }

    if (current.length > 0) {
        scenes.push(text.slice(current[0].start, current[current.length - 1].end).trim());
    }
    return scenes;
}

function buildFallbackScenes(sceneText) {
    const sentences = splitIntoSentencesWithOffsets(sceneText);

    if (sentences.length === 0) {
        const parts = splitTextEvenlyByParagraphs(sceneText, MAX_SCENES_PER_CHUNK);
        return parts.map((text, i) => ({
            title: extractSceneTitle(text, i), text, type: 'narration',
            participants: [], location: null,
        }));
    }

    const groups = [];
    let current = [];
    for (const s of sentences) {
        if (current.length === 0) { current.push(s); continue; }
        const currentDur = estimateSpeechDurationSec(
            sceneText.slice(current[0].start, current[current.length - 1].end)
        );
        const withNext = estimateSpeechDurationSec(
            sceneText.slice(current[0].start, s.end)
        );
        if (currentDur >= SCENE_TARGET_SEC || withNext > SCENE_MAX_SEC) {
            groups.push(current);
            current = [s];
        } else {
            current.push(s);
        }
    }
    if (current.length > 0) groups.push(current);

    return groups.map((g, i) => {
        const text = sceneText.slice(g[0].start, g[g.length - 1].end);
        const dur = estimateSpeechDurationSec(text);
        if (dur > SCENE_MAX_SEC) {
            console.warn(`[AGENT] fallback scene ${i} is ${dur}s (> ${SCENE_MAX_SEC}s) — single sentence exceeds max, kept whole`);
        }
        return {
            title: extractSceneTitle(text, i), text, type: 'narration',
            participants: [], location: null,
        };
    });
}

module.exports = {
    stripStructureFromText,
    splitIntoSentences,
    splitIntoSentencesWithOffsets,
    splitTextEvenlyByParagraphs,
    buildFallbackScenes,
};
