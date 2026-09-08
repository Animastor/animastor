// ======================================================
// C13 Parser Contract — legacy chapter DTO projection
// ======================================================
// The host callers (pipeline-runner, status-routes, txt-importer,
// source-coverage-audit, import-routes trigger-next-window) consume the
// LEGACY chapter DTO:
//   { title, type, label, number, startLine, endLine, startOffset, endOffset, length }
// splitIntoChapters() produces it by projecting canonical ParserSegments.
// This module extracts that projection as the single documented definition;
// lazy-book/parser.js delegates to it, so behavior cannot drift.
//
// PROJECTION SEMANTICS:
//   body|poem → type 'chapter', title null, label null  (plain chapters)
//   otherwise → type as-is, title = title||label||null, label as-is
//   startLine = line index of startOffset; endLine = line index of
//   endOffset-1 (exclusive→inclusive conversion), 0-based.
//   Empty projection → safety net: one full-text plain chapter
//   (splitIntoChapters never returns an empty list).
//
// Text is a string by contract (offsets anchor the exact instance);
// a non-string input throws naturally, same as splitIntoChapters always did.
// ======================================================

/**
 * Line index (0-based) for a char offset within `text.split('\n')`.
 * Shared definition used by splitIntoChapters and its projections.
 * @param {string[]} lines
 * @param {number} offset
 * @returns {number}
 */
function offsetToLine(lines, offset) {
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
        const lineEnd = acc + lines[i].length;
        if (offset < lineEnd) return i;
        acc = lineEnd + 1;
    }
    return Math.max(0, lines.length - 1);
}

/**
 * Project ONE canonical ParserSegment to the legacy chapter DTO.
 * Pure: returns a fresh object, never mutates the segment.
 * @param {import('./parser-contract').ParserSegment} seg
 * @param {string} sourceText  The EXACT text instance the offsets anchor to.
 * @returns {import('./parser-contract').ParserChapter}
 */
function segmentToLegacyChapter(seg, sourceText) {
    const startOffset = seg.startOffset || 0;
    const endOffset = Math.max(startOffset, seg.endOffset || sourceText.length);
    const lines = sourceText.split('\n');
    const startLine = offsetToLine(lines, startOffset);
    const endLine = offsetToLine(lines, Math.max(startOffset, endOffset - 1));

    const isPlain = seg.type === 'body' || seg.type === 'poem';
    return {
        title: isPlain ? null : (seg.title || seg.label || null),
        type: isPlain ? 'chapter' : seg.type,
        label: isPlain ? null : (seg.label || null),
        number: seg.number ?? null,
        startLine,
        endLine,
        startOffset,
        endOffset,
        length: endOffset - startOffset,
    };
}

/**
 * Project a canonical ParserResult (ChapterMap) to the legacy chapter array.
 * Mirrors splitIntoChapters() including the empty-map safety net: never
 * returns an empty list — a degenerate map yields one full-text plain chapter.
 * @param {import('./parser-contract').ParserResult} map
 * @param {string} sourceText
 * @returns {import('./parser-contract').ParserChapter[]}
 */
function mapToLegacyChapters(map, sourceText) {
    const segments = Array.isArray(map && map.segments) ? map.segments : [];
    const chapters = segments.map(seg => segmentToLegacyChapter(seg, sourceText));

    if (chapters.length === 0) {
        const lines = sourceText.split('\n');
        chapters.push({
            title: null,
            type: 'chapter',
            label: null,
            number: null,
            startLine: 0,
            endLine: Math.max(0, lines.length - 1),
            startOffset: 0,
            endOffset: sourceText.length,
            length: sourceText.length,
        });
    }
    return chapters;
}

module.exports = { offsetToLine, segmentToLegacyChapter, mapToLegacyChapters };
