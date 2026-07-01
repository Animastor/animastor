const CHAPTER_HEADER_RE = /^(?:глава|chapter|часть|part|пролог|prologue|эпилог|epilogue)/i;

function looksLikeChapterTitle(line) {
    const text = (line || '').trim();
    if (!text || CHAPTER_HEADER_RE.test(text) || text.length > 120) return false;

    const letters = text.match(/[A-Za-zА-Яа-яЁё]/g) || [];
    if (letters.length === 0) return false;

    const upperLetters = text.match(/[A-ZА-ЯЁ]/g) || [];
    const isAllCaps = upperLetters.length === letters.length;
    if (isAllCaps && text.split(/\s+/).length >= 2) return true;

    // Short standalone title/subtitle lines normally do not contain sentence punctuation.
    return text.length <= 80
        && !/[.!?…]$/.test(text)
        && !/[,:;—–-]/.test(text)
        && text.split(/\s+/).length <= 8;
}

function normalizeTextForCoverage(text) {
    return (text || '')
        .replace(/\r\n?/g, '\n')
        .replace(/\u00a0/g, ' ');
}

function buildCoverageIndex(text) {
    const normalizedChars = [];
    const rawStarts = [];
    const rawEnds = [];

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\r') {
            if (text[i + 1] === '\n') {
                normalizedChars.push('\n');
                rawStarts.push(i);
                rawEnds.push(i + 2);
                i++;
            } else {
                normalizedChars.push('\n');
                rawStarts.push(i);
                rawEnds.push(i + 1);
            }
            continue;
        }

        if (ch === '\u00a0') {
            normalizedChars.push(' ');
            rawStarts.push(i);
            rawEnds.push(i + 1);
            continue;
        }

        normalizedChars.push(ch);
        rawStarts.push(i);
        rawEnds.push(i + 1);
    }

    return {
        normalized: normalizedChars.join(''),
        rawStarts,
        rawEnds,
    };
}

function skipWhitespaceForward(text, index) {
    let i = index;
    while (i < text.length && /\s/.test(text[i])) i++;
    return i;
}

function rawOffsetToNormalizedIndex(index, rawOffset) {
    const { rawStarts, rawEnds } = index;
    let lo = 0;
    let hi = rawStarts.length;

    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rawEnds[mid] <= rawOffset) lo = mid + 1;
        else hi = mid;
    }

    return lo;
}

function findNarrativeStartOffset(rawText) {
    const lines = (rawText || '').split('\n');
    let skipLen = 0;
    let i = 0;

    while (i < lines.length && !lines[i].trim()) {
        skipLen += lines[i].length + 1;
        i++;
    }

    if (i >= lines.length) return skipLen;

    const first = lines[i].trim();
    if (!CHAPTER_HEADER_RE.test(first)) {
        return skipLen;
    }

    skipLen += lines[i].length + 1;
    i++;

    while (i < lines.length && !lines[i].trim()) {
        skipLen += lines[i].length + 1;
        i++;
    }

    if (i >= lines.length) return skipLen;

    const next = lines[i].trim();
    if (looksLikeChapterTitle(next)) {
        skipLen += lines[i].length + 1;
        i++;
    }

    while (i < lines.length && !lines[i].trim()) {
        skipLen += lines[i].length + 1;
        i++;
    }

    return skipLen;
}

function hasVisibleText(text) {
    return (text || '').replace(/\s+/g, '').length > 0;
}

function computeSceneCoverage(rawText, sceneTexts, options = {}) {
    const sourceOffsetBase = options.sourceOffsetBase || 0;
    const normalizedSource = normalizeTextForCoverage(rawText);
    const index = buildCoverageIndex(rawText);
    const sceneSpans = [];

    let cursor = skipWhitespaceForward(normalizedSource, 0);
    let coveredStartOffset = null;
    let coveredSceneEndOffset = null;

    for (let i = 0; i < sceneTexts.length; i++) {
        const sceneNorm = normalizeTextForCoverage(sceneTexts[i] || '').trim();
        if (!sceneNorm) {
            return {
                ok: false,
                reason: 'empty_scene_text',
                scene_index: i,
                gap_chars: 0,
                gap_preview: '',
                covered_start_offset: coveredStartOffset,
                covered_end_offset: coveredSceneEndOffset,
                next_offset: coveredSceneEndOffset,
                scene_spans: sceneSpans,
            };
        }

        const pos = normalizedSource.indexOf(sceneNorm, cursor);
        if (pos < 0) {
            return {
                ok: false,
                reason: 'scene_text_not_found',
                scene_index: i,
                gap_chars: 0,
                gap_preview: normalizedSource.slice(cursor, cursor + 160),
                covered_start_offset: coveredStartOffset,
                covered_end_offset: coveredSceneEndOffset,
                next_offset: coveredSceneEndOffset,
                scene_spans: sceneSpans,
            };
        }

        const gap = normalizedSource.slice(cursor, pos);
        if (hasVisibleText(gap)) {
            return {
                ok: false,
                reason: 'gap_in_source',
                scene_index: i,
                gap_chars: gap.replace(/\s+/g, '').length,
                gap_preview: gap.slice(0, 200),
                covered_start_offset: coveredStartOffset,
                covered_end_offset: coveredSceneEndOffset,
                next_offset: coveredSceneEndOffset,
                scene_spans: sceneSpans,
            };
        }

        const sourceStart = sourceOffsetBase + (index.rawStarts[pos] ?? rawText.length);
        const sourceEnd = sourceOffsetBase + (index.rawEnds[pos + sceneNorm.length - 1] ?? rawText.length);

        if (coveredStartOffset == null) coveredStartOffset = sourceStart;
        coveredSceneEndOffset = sourceEnd;
        sceneSpans.push({
            source_start: sourceStart,
            source_end: sourceEnd,
            normalized_start: pos,
            normalized_end: pos + sceneNorm.length,
        });

        cursor = skipWhitespaceForward(normalizedSource, pos + sceneNorm.length);
    }

    const nextRawIdx = cursor >= normalizedSource.length
        ? sourceOffsetBase + rawText.length
        : sourceOffsetBase + (index.rawStarts[cursor] ?? rawText.length);

    return {
        ok: true,
        reason: 'ok',
        scene_spans: sceneSpans,
        covered_start_offset: coveredStartOffset,
        covered_end_offset: coveredSceneEndOffset,
        next_offset: nextRawIdx,
        gap_chars: 0,
        gap_preview: '',
    };
}

module.exports = {
    normalizeTextForCoverage,
    buildCoverageIndex,
    skipWhitespaceForward,
    rawOffsetToNormalizedIndex,
    looksLikeChapterTitle,
    findNarrativeStartOffset,
    computeSceneCoverage,
};
