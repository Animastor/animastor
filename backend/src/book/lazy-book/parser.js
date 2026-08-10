/**
 * Inject [ГЛАВА: TITLE] markers into text for chapters that use
 * ALL-CAPS headings WITHOUT the word "Глава" or "Chapter".
 *
 * Rules:
 * - An ALL-CAPS line (>=2 words, >10 chars, all uppercase + punctuation)
 *   after >=2 blank lines is a candidate chapter heading
 * - Skip lines that already contain Глава/Chapter/Часть/Part/Пролог/etc.
 * - Skip first 5 lines (metadata: author, title, etc.)
 * - Skip lines > 100 chars (narrative text that happens to be caps)
 *
 * @param {string} text - Raw source text
 * @returns {string} Text with [ГЛАВА: ...] markers injected
 */
function injectChapterMarkers(text) {
    const lines = text.split('\n');
    const result = [];
    let blankCount = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (!trimmed) {
            blankCount++;
            result.push(line);
            continue;
        }

        // Skip metadata lines (first 5 content lines, skip part/chapter keywords)
        const isEarlyLine = i < 5;

        // Check ALL-CAPS: only uppercase letters (Cyrillic + Latin), spaces, punctuation
        const isAllCaps = /^[A-ZА-ЯЁ\s\d\-–—.,!?;:'"«»()]+$/.test(trimmed);
        const hasChapterKeyword = /Глава|Chapter|Часть|Part|Пролог|Prologue|Эпилог|Epilogue|Введение|Introduction|Предисловие|Preface|Послесловие|Afterword/i.test(trimmed);
        const words = trimmed.split(/\s+/).filter(w => w.length > 0);
        const isLongEnough = trimmed.length > 10 && trimmed.length < 100;
        const hasEnoughWords = words.length >= 2;
        // Must contain at least one letter (excludes pure number lines like "1929 — 1940")
        const hasLetter = /[A-Za-zА-Яа-яЁё]/.test(trimmed);
        const isPotentialHeading = isAllCaps && !hasChapterKeyword && isLongEnough && hasEnoughWords && hasLetter && !isEarlyLine;

        if (isPotentialHeading && blankCount >= 2) {
            // ── DEDUP: skip if there's a "Глава N" within 10 lines above ──
            // This ALL-CAPS line is likely a chapter title that is ALREADY
            // preceded by a "Глава N" header — no need for a duplicate marker.
            const nearbyLines = lines.slice(Math.max(0, i - 10), i).join('\n');
            const hasNearbyChapterMarker = /Глава\s+\d+|Chapter\s+\d+/i.test(nearbyLines);

            if (!hasNearbyChapterMarker) {
                // Inject marker 2 lines above the heading
                result.push('');
                result.push(`[ГЛАВА: ${trimmed}]`);
                result.push('');
            }
            result.push(line);
            blankCount = 0;
            continue;
        }

        result.push(line);
        if (trimmed) blankCount = 0;
    }

    return result.join('\n');
}

// ======================================================
// Chapter splitting — v2 (structure-detector based)
// ======================================================
// splitIntoChapters now delegates to the deterministic structure map
// (docs/04-planning/TXT_IMPORT_STRUCTURE_V2.md): the program finds
// candidates, builds a canonical chapter map, and the pipeline consumes
// the same map for window slicing and chapter materialization.
//
// The legacy array contract is preserved:
//   { title, startLine, endLine, startOffset, endOffset, length }
// plus new fields: { type, label, number }.

const structureDetector = require('../../services/structure-detector');

function offsetToLine(lines, offset) {
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
        const lineEnd = acc + lines[i].length;
        if (offset < lineEnd) return i;
        acc = lineEnd + 1;
    }
    return Math.max(0, lines.length - 1);
}

function splitIntoChapters(text) {
    const map = structureDetector.buildDeterministicMap(text);
    const lines = text.split('\n');
    const chapters = [];

    for (const seg of map.segments) {
        const startOffset = seg.startOffset || 0;
        const endOffset = Math.max(startOffset, seg.endOffset || text.length);
        const startLine = offsetToLine(lines, startOffset);
        const endLine = offsetToLine(lines, Math.max(startOffset, endOffset - 1));

        // 'body'/'poem' segments become plain chapters WITHOUT a structural label.
        const isPlain = seg.type === 'body' || seg.type === 'poem';
        const type = isPlain ? 'chapter' : seg.type;
        const title = isPlain ? null : (seg.title || seg.label || null);

        chapters.push({
            title,
            type,
            label: isPlain ? null : (seg.label || null),
            number: seg.number ?? null,
            startLine,
            endLine,
            startOffset,
            endOffset,
            length: endOffset - startOffset,
        });
    }

    // Safety net: never return an empty chapter list.
    if (chapters.length === 0) {
        chapters.push({
            title: null,
            type: 'chapter',
            label: null,
            number: null,
            startLine: 0,
            endLine: Math.max(0, lines.length - 1),
            startOffset: 0,
            endOffset: text.length,
            length: text.length,
        });
    }

    return chapters;
}

function firstMeaningfulChapter(chapters, sourceText) {
    if (!chapters || chapters.length === 0) return null;
    for (const ch of chapters) {
        const text = sourceText.substring(ch.startOffset || 0, ch.endOffset || sourceText.length).trim();
        if (text.length >= 50) return ch;
    }
    return chapters[0];
}

function splitIntoScenes(chapterText) {
    const breakRe = /(?:\n\s*\n\s*\n+|^\s*[-–—]{3,}\s*$|^\s*\*{3,}\s*$|^\s*_{3,}\s*$)/gm;

    const parts = chapterText.split(breakRe).filter(s => s.trim());

    if (parts.length >= 2 && parts.length <= 20) {
        return parts.map(p => p.trim());
    }

    const paragraphs = chapterText.split(/\n\s*\n/).filter(p => p.trim());
    if (paragraphs.length >= 2) {
        const maxParas = Math.min(paragraphs.length, 30);
        const result = [];
        const perScene = Math.max(1, Math.floor(maxParas / 3));
        for (let i = 0; i < maxParas && result.length < 3; i += perScene) {
            const group = paragraphs.slice(i, i + perScene).join('\n\n');
            result.push(group);
        }
        return result;
    }

    return [chapterText.trim()];
}

function splitIntoUnits(sceneText) {
    const t = sceneText.trim();
    if (!t) return [{ type: 'narration', text: '', participants: [] }];
    return [{
        type: 'narration',
        text: t,
        participants: [],
    }];
}

function detectLanguage(text) {
    // Programmatic detection via tinyld (services/language-detector.js): pure
    // JS, no LLM, ISO 639-1 codes, unknown → 'en'. The legacy Cyrillic-vs-Latin
    // heuristic misclassified Ukrainian/Bulgarian/Serbian as Russian — replaced.
    return require('../../services/language-detector').detectLanguage(text);
}

module.exports = {
    splitIntoChapters, splitIntoScenes, splitIntoUnits,
    firstMeaningfulChapter, detectLanguage,
    injectChapterMarkers,
};
