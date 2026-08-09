const CHAPTER_HEADER_RE = /^(?:глава|chapter|часть|part|пролог|prologue|эпилог|epilogue|введение|introduction|предисловие|preface|послесловие|afterword|приложение|appendix)/i;

function looksLikeChapterTitle(line) {
    const text = (line || '').trim();
    if (!text || CHAPTER_HEADER_RE.test(text) || text.length > 120) return false;

    // Strong signal: an all-caps multi-word line is a heading ("НИКОГДА НЕ
    // РАЗГОВАРИВАЙТЕ С НЕИЗВЕСТНЫМИ"). Shared with findNarrativeStartOffset
    // so the all-caps rule lives in exactly one place.
    if (isAllCapsHeading(text)) return true;

    // Weak signal: short standalone title/subtitle lines normally do not
    // contain sentence punctuation.
    return text.length <= 80
        && !/[.!?…]$/.test(text)
        && !/[,:;—–-]/.test(text)
        && text.split(/\s+/).length <= 8;
}

function normalizeTextForCoverage(text) {
    return (text || '')
        .replace(/\r\n?/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
        .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
        .replace(/[\u2013\u2014]/g, '—')
        .replace(/[ \t]+/g, ' ')
        .trim();
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

// All-caps multi-word line = a chapter/part NAME heading (e.g.
// "НИКОГДА НЕ РАЗГОВАРИВАЙТЕ С НЕИЗВЕСТНЫМИ"). Distinct from
// looksLikeChapterTitle's weak branch (short no-punctuation lines) so a real
// first narrative sentence like "Он встал и вышел" is never mistaken for a
// heading — only unambiguous all-caps titles qualify as a standalone header.
function isAllCapsHeading(line) {
    const text = (line || '').trim();
    if (!text || text.length > 120) return false;
    const letters = text.match(/[A-Za-zА-Яа-яЁё]/g) || [];
    if (letters.length === 0) return false;
    const upperLetters = text.match(/[A-ZА-ЯЁ]/g) || [];
    return upperLetters.length === letters.length && text.split(/\s+/).length >= 2;
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

    // A window may open DIRECTLY with the chapter NAME heading (the v2
    // structure map can split "Глава 1" and its all-caps name "НИКОГДА НЕ
    // РАЗГОВАРИВАЙТЕ С НЕИЗВЕСТНЫМИ" into separate segments, so the window
    // text begins at the name line). Without this, the heading stays in the
    // window, the scene AI (correctly) does not include it in any scene, and
    // coverage fails with gap_in_source — silently discarding the AI scene
    // split (and its titles) for the deterministic fallback.
    const first = lines[i].trim();
    if (!CHAPTER_HEADER_RE.test(first) && !isAllCapsHeading(first)) {
        return skipLen;
    }

    // Skip the whole header CHAIN: keyword lines ("ЧАСТЬ ПЕРВАЯ", "Глава 1")
    // and all-caps name lines ("НИКОГДА НЕ РАЗГОВАРИВАЙТЕ С НЕИЗВЕСТНЫМИ")
    // continue the chain freely. A WEAK title-like line ("Глава 1\nНазвание")
    // is consumed only ONCE right after a strong header — never several
    // consecutive short narrative sentences ("Глава 1\nОн встал\nОн вышел"
    // would otherwise eat real text as fake headings).
    skipLen += lines[i].length + 1;
    i++;
    let weakAllowed = true;
    while (i < lines.length) {
        const line = lines[i].trim();
        if (!line) {
            skipLen += lines[i].length + 1;
            i++;
            continue;
        }
        let isHeader = false;
        if (CHAPTER_HEADER_RE.test(line) || isAllCapsHeading(line)) {
            isHeader = true;
            weakAllowed = true; // a strong header re-opens the weak slot
        } else if (weakAllowed && looksLikeChapterTitle(line)) {
            isHeader = true;
            weakAllowed = false; // weak line consumed — stop after this
        }
        if (!isHeader) break;
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

function uniqueStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const text = (value || '').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        result.push(text);
    }
    return result;
}

function getLastSentenceFragment(text) {
    const t = normalizeTextForCoverage(text).trim();
    if (!t) return '';

    let end = t.length;
    while (end > 0 && /\s/.test(t[end - 1])) end--;
    while (end > 0 && '"\'»”)]'.indexOf(t[end - 1]) >= 0) end--;

    let terminal = -1;
    for (let i = end - 1; i >= 0; i--) {
        if (/[.!?…]/.test(t[i])) {
            terminal = i;
            break;
        }
    }
    if (terminal < 0) return '';

    let start = 0;
    for (let i = terminal - 1; i >= 0; i--) {
        if (/[.!?…]/.test(t[i])) {
            start = i + 1;
            break;
        }
    }

    return t.slice(start).trim();
}

function buildSceneEndNeedles(sceneText, options = {}) {
    const t = normalizeTextForCoverage(sceneText).trim();
    if (!t) return [];

    const minTailChars = options.minTailChars || 100;
    const maxTailChars = options.maxTailChars || 300;
    const lastSentence = getLastSentenceFragment(t);
    const tail = t.length <= maxTailChars
        ? t
        : t.slice(-maxTailChars).trimStart();

    const candidates = [];
    candidates.push(t);
    if (lastSentence && (lastSentence.length >= minTailChars || t.length <= maxTailChars)) {
        candidates.push(lastSentence);
    }
    candidates.push(tail);

    return uniqueStrings(candidates);
}

function findLastSceneEndOffset(rawText, sceneText, options = {}) {
    const sourceOffsetBase = options.sourceOffsetBase || 0;
    const needles = buildSceneEndNeedles(sceneText, options);
    const normalizedSource = normalizeTextForCoverage(rawText);
    const index = buildCoverageIndex(rawText);

    for (const needle of needles) {
        const normalizedNeedle = normalizeTextForCoverage(needle).trim();
        if (!normalizedNeedle) continue;

        const pos = normalizedSource.indexOf(normalizedNeedle);
        if (pos < 0) continue;

        const sourceEnd = sourceOffsetBase + (index.rawEnds[pos + normalizedNeedle.length - 1] ?? rawText.length);
        const cursor = skipWhitespaceForward(normalizedSource, pos + normalizedNeedle.length);
        const nextOffset = cursor >= normalizedSource.length
            ? sourceOffsetBase + rawText.length
            : sourceOffsetBase + (index.rawStarts[cursor] ?? rawText.length);

        return {
            ok: true,
            method: needle === sceneText.trim() ? 'full_scene_text' : 'last_scene_tail',
            needle,
            source_end: sourceEnd,
            next_offset: nextOffset,
        };
    }

    return {
        ok: false,
        method: 'last_scene_tail',
        needle: needles[0] || '',
        source_end: null,
        next_offset: null,
    };
}

/**
 * Split normalized text into sentences by terminal punctuation (. ! ? …).
 * Works on pre-normalized text (single spaces, \n preserved, no \r).
 * Used by sentence-level relaxed coverage matching.
 */
function splitTextIntoNormalizedSentences(text) {
    const t = (text || '').trim();
    if (!t) return [];
    const sentences = [];
    let start = 0;
    for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        const isTerminal = ch === '.' || ch === '!' || ch === '?' || ch === '\u2026';
        if (isTerminal) {
            let j = i + 1;
            while (j < t.length && /[.!?\u2026"'\u00bb\u201d)\]»]/.test(t[j])) j++;
            const raw = t.slice(start, j).trim();
            if (raw) sentences.push(raw);
            start = j;
            i = j - 1;
        }
    }
    const tail = t.slice(start).trim();
    if (tail) sentences.push(tail);
    return sentences;
}

/**
 * Try to match scene text at sentence level (relaxed).
 * When verbatim matching fails, split scene into sentences and find each in order.
 * Allows gaps (skipped text) between sentences within a scene.
 */
function trySentenceLevelMatch(normalizedSource, sceneNorm, cursor) {
    const sentences = splitTextIntoNormalizedSentences(sceneNorm);
    // Need at least 2 sentences to enable relaxed matching
    if (sentences.length < 2) return null;

    let sentCursor = cursor;
    let firstPos = -1;
    let lastEnd = -1;

    for (const sent of sentences) {
        const pos = normalizedSource.indexOf(sent, sentCursor);
        if (pos < 0) return null; // sentence not found
        if (firstPos < 0) firstPos = pos;
        lastEnd = pos + sent.length;
        sentCursor = pos + sent.length;
    }

    return {
        firstPos,
        lastEnd,
        sentenceCount: sentences.length,
    };
}

function computeSceneCoverage(rawText, sceneTexts, options = {}) {
    const sourceOffsetBase = options.sourceOffsetBase || 0;
    const normalizedSource = normalizeTextForCoverage(rawText);
    const index = buildCoverageIndex(rawText);
    const sceneSpans = [];

    let cursor = skipWhitespaceForward(normalizedSource, 0);
    let coveredStartOffset = null;
    let coveredSceneEndOffset = null;
    let usedRelaxedMatching = false;

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
                relaxed_matching: usedRelaxedMatching,
            };
        }

        // Try verbatim matching first (fast path)
        const pos = normalizedSource.indexOf(sceneNorm, cursor);
        let matchStart = pos;
        let matchEnd = pos >= 0 ? pos + sceneNorm.length : -1;
        let matchMethod = 'verbatim';

        if (pos < 0) {
            // Verbatim failed — try sentence-level relaxed matching
            const sentMatch = trySentenceLevelMatch(normalizedSource, sceneNorm, cursor);
            if (sentMatch) {
                matchStart = sentMatch.firstPos;
                matchEnd = sentMatch.lastEnd;
                matchMethod = `sentence_level(${sentMatch.sentenceCount}sents)`;
                usedRelaxedMatching = true;
            } else {
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
                    relaxed_matching: usedRelaxedMatching,
                };
            }
        }

        const gap = normalizedSource.slice(cursor, matchStart);
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
                relaxed_matching: usedRelaxedMatching,
            };
        }

        const sourceStart = sourceOffsetBase + (index.rawStarts[matchStart] ?? rawText.length);
        const sourceEnd = sourceOffsetBase + (index.rawEnds[matchEnd - 1] ?? rawText.length);

        if (coveredStartOffset == null) coveredStartOffset = sourceStart;
        coveredSceneEndOffset = sourceEnd;
        sceneSpans.push({
            source_start: sourceStart,
            source_end: sourceEnd,
            normalized_start: matchStart,
            normalized_end: matchEnd,
            match_method: matchMethod,
        });

        cursor = skipWhitespaceForward(normalizedSource, matchEnd);
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
        relaxed_matching: usedRelaxedMatching,
    };
}

module.exports = {
    normalizeTextForCoverage,
    buildCoverageIndex,
    skipWhitespaceForward,
    rawOffsetToNormalizedIndex,
    looksLikeChapterTitle,
    isAllCapsHeading,
    findNarrativeStartOffset,
    getLastSentenceFragment,
    buildSceneEndNeedles,
    findLastSceneEndOffset,
    splitTextIntoNormalizedSentences,
    trySentenceLevelMatch,
    computeSceneCoverage,
};
