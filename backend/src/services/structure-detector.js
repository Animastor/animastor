// ======================================================
// Book Structure Detector — v2
// ======================================================
// Architecture (docs/04-planning/TXT_IMPORT_STRUCTURE_V2.md):
//   The PROGRAM finds CANDIDATES (suspicious lines) — it never decides
//   what they are. The LLM classifies them semantically. RegEx/keywords
//   are hypothesis boosters and the no-LLM fallback, never the decision.
//
//   Pipeline:
//     1. extractCandidates(sourceText)  — deterministic, language-agnostic
//     2. buildDeterministicMap(...)     — fallback chapter map (no LLM)
//     3. mergeAiDecisions(...)          — apply LLM classification, keep
//                                         deterministic result as backbone
//
//   Universality: absence of title/author/prologue/chapters is NORMAL.
//   A poem, a few sentences, a bare narrative — all valid inputs.
// ======================================================

// ── Multilingual keyword hypotheses ─────────────────────────────
// Only hypothesis boosters. The LLM stage handles unknown languages.
const STRUCTURE_KEYWORDS = {
    chapter: ['глава', 'chapter', 'kapitel', 'capitulo', 'capítulo', 'chapitre', 'раздел'],
    prologue: ['пролог', 'prologue', 'prolog', 'prologo', 'prólogo', 'préface'],
    epilogue: ['эпилог', 'epilogue', 'epilog', 'epilogo', 'epílogo'],
    part: ['часть', 'part', 'teil', 'parte'],
    introduction: ['введение', 'introduction', 'einleitung', 'вступление', 'предисловие', 'preface', 'vorwort', 'przedmowa'],
    afterword: ['послесловие', 'послеслов', 'afterword', 'nachwort', 'posłowie'],
    appendix: ['приложение', 'appendix', 'anhang', 'додаток', 'dodatek'],
};

// If the line starts with a known keyword, return { group, keyword, rest }.
// "Пролог. Мир на переломе эпох" → { group:'prologue', keyword:'Пролог',
//                                     rest:'Мир на переломе эпох' }.
// "Глава 1. Земля"              → { group:'chapter', keyword:'Глава', rest:'1. Земля' }
// NOTE: JS \b is ASCII-only and fails after Cyrillic, so we use startsWith
// + a non-letter next-char check instead of a regex boundary.
function matchKeyword(line) {
    const text = String(line || '').trim();
    if (!text) return null;
    const lower = text.toLowerCase();
    for (const [group, words] of Object.entries(STRUCTURE_KEYWORDS)) {
        const sorted = [...words].sort((a, b) => b.length - a.length);
        for (const w of sorted) {
            if (!lower.startsWith(w)) continue;
            const after = text.slice(w.length);
            const nextCh = after[0] || '';
            // Reject prefix collisions like "частица"/"разделы"/"главный".
            if (/[A-Za-zА-Яа-яЁё]/.test(nextCh)) continue;
            const rest = after.replace(/^[\s.:—–\-–,]+/, '').trim();
            return { group, keyword: text.slice(0, w.length), rest };
        }
    }
    return null;
}

// ── Line scanning ────────────────────────────────────────────────

const ROMAN_RE = /^(?:M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))[.)\s]/i;

function looksAllCaps(text) {
    if (!/[A-Za-zА-Яа-яЁё]/.test(text)) return false;
    const letters = text.match(/[A-Za-zА-Яа-яЁё]/g) || [];
    const upper = text.match(/[A-ZА-ЯЁ]/g) || [];
    return upper.length === letters.length;
}

function hasSentencePunctuation(text) {
    // Terminal punctuation or hard mid-line punctuation (comma/semicolon/colon).
    // Mid-line '.' is allowed — it appears in "Глава 1." / "Пролог." headers.
    return /[.!?…]\s*$/.test(text) || /[,;:]/.test(text);
}

const NUMBERED_RE = /^\d{1,3}[.)]?\s+[A-Za-zА-Яа-яЁё«"]/;

/**
 * Scan the raw source text and produce candidate lines plus line metadata.
 * Never decides what a candidate IS — only why it is suspicious.
 */
function extractCandidates(sourceText) {
    const raw = String(sourceText || '');
    const lines = raw.split('\n');
    const lineMeta = [];
    let offset = 0;
    let nonEmptyCount = 0;
    let firstNonEmptyIdx = -1;

    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const text = rawLine.trim();
        lineMeta.push({
            index: i,
            text,
            startOffset: offset,
            endOffset: offset + rawLine.length,
            blankLinesBefore: 0,
            blankLinesAfter: 0,
        });
        if (text) {
            nonEmptyCount++;
            if (firstNonEmptyIdx === -1) firstNonEmptyIdx = i;
        }
        offset += rawLine.length + 1;
    }

    // Blank runs before/after each non-empty line.
    for (let i = 0; i < lineMeta.length; i++) {
        if (!lineMeta[i].text) continue;
        let before = 0;
        for (let j = i - 1; j >= 0 && !lineMeta[j].text; j--) before++;
        let after = 0;
        for (let j = i + 1; j < lineMeta.length && !lineMeta[j].text; j++) after++;
        lineMeta[i].blankLinesBefore = before;
        lineMeta[i].blankLinesAfter = after;
    }

    // Following-paragraph info: length + preview (first paragraph after the line).
    for (let i = 0; i < lineMeta.length; i++) {
        const lm = lineMeta[i];
        if (!lm.text) continue;
        const para = [];
        let paraLen = 0;
        for (let j = i + 1; j < lineMeta.length; j++) {
            if (!lineMeta[j].text) {
                if (para.length === 0) continue; // blanks right after header
                break;
            }
            para.push(lineMeta[j].text);
            paraLen += lineMeta[j].text.length;
        }
        lm.nextParagraphLines = para.length;
        lm.nextParagraphLength = paraLen;
        lm.nextParagraphPreview = para.join(' ').slice(0, 160);
    }

    const candidates = [];
    let headCounter = 0;

    for (let i = 0; i < lineMeta.length; i++) {
        const lm = lineMeta[i];
        if (!lm.text) continue;

        const isFirstNonEmpty = i === firstNonEmptyIdx;
        const words = lm.text.split(/\s+/).filter(Boolean);
        const kw = matchKeyword(lm.text);
        const numbered = NUMBERED_RE.test(lm.text) || /^\d{1,3}\s*[.)]\s*$/.test(lm.text);
        const romanNumeral = ROMAN_RE.test(lm.text) && lm.text.length <= 10;
        const sentencePunct = hasSentencePunctuation(lm.text);
        const allCaps = looksAllCaps(lm.text);
        const prefixDash = /^[\u2014\u2013\u2012-]\s*/.test(lm.text);
        const followedByLongParagraph = lm.nextParagraphLines >= 3
            || lm.nextParagraphLength >= 120
            || (lm.text.length > 0 && lm.nextParagraphLength > lm.text.length * 3 && lm.nextParagraphLength >= 60);

        // Program's own (non-authoritative) suspicion score.
        let score = 0;
        if (kw) score += 0.35;
        if (isFirstNonEmpty || (lm.blankLinesBefore >= 1 && lm.blankLinesAfter >= 1)) score += 0.3;
        if (followedByLongParagraph) score += 0.3;
        if (allCaps) score += 0.25;
        if (numbered || romanNumeral) score += 0.2;
        if (lm.text.length <= 60) score += 0.15;
        if (words.length >= 1 && words.length <= 12) score += 0.1;
        if (sentencePunct) score -= 0.4;
        if (prefixDash) score -= 0.35;
        if (lm.text.length > 100) score -= 0.2;
        if (lm.text.length < 2) score -= 0.3;
        score = Math.max(0, Math.min(1, score));

        candidates.push({
            id: 'c' + candidates.length,
            lineIndex: i,
            startOffset: lm.startOffset,
            endOffset: lm.endOffset,
            text: lm.text,
            length: lm.text.length,
            wordCount: words.length,
            firstNonEmpty: isFirstNonEmpty,
            inHeadBlock: headCounter < 8,
            blankLinesBefore: lm.blankLinesBefore,
            blankLinesAfter: lm.blankLinesAfter,
            standalone: isFirstNonEmpty || (lm.blankLinesBefore >= 1 && lm.blankLinesAfter >= 1),
            allCaps,
            sentencePunctuation: sentencePunct,
            followedByLongParagraph,
            nextParagraphLength: lm.nextParagraphLength,
            nextParagraphLines: lm.nextParagraphLines,
            nextParagraphPreview: lm.nextParagraphPreview,
            keyword: kw ? kw.group : null,
            keywordWord: kw ? kw.keyword : null,
            keywordRest: kw ? kw.rest : null,
            numbered,
            romanNumeral,
            prefixDash,
            headingLikelihood: score,
        });
        headCounter++;
    }

    // Strong boundaries: likely chapter/part boundaries (not head-zone, not dialogue).
    const strong = candidates.filter(c =>
        !c.prefixDash &&
        (c.headingLikelihood >= 0.55 || (c.keyword && c.headingLikelihood >= 0.3))
    );

    return {
        candidates,
        strong,
        nonEmptyCount,
        lines,
        lineMeta,
        textLength: raw.length,
    };
}

// ── Person-name heuristics (hallucination guard) ──────────────────

const INITIAL_TOKEN_RE = /^[A-ZА-ЯЁ](?:\.[A-ZА-ЯЁ]?)+$/;  // "С.", "С.А.", "S.A."
const NAME_TOKEN_RE = /^[A-ZА-ЯЁ][a-zа-яё]{1,24}$/;       // "Хабаров", "Ivanov"

function looksLikeAuthorName(text) {
    const t = String(text || '').trim().replace(/[.!?…]+$/, '');
    if (!t || t.length > 60) return false;
    if (/\d/.test(t)) return false;
    if (/^(?:https?:|www\.)/i.test(t)) return false;
    const tokens = t.split(/\s+/).filter(Boolean);
    if (tokens.length < 2 || tokens.length > 4) return false;
    let fullWords = 0;
    let initials = 0;
    for (const tok of tokens) {
        if (INITIAL_TOKEN_RE.test(tok)) { initials++; continue; }
        if (NAME_TOKEN_RE.test(tok)) { fullWords++; continue; }
        return false; // any foreign token → not a person name
    }
    if (fullWords === 0) return false;              // need a surname-ish word
    return initials + fullWords === tokens.length;
}

// Split a first line like "За пределами алгоритмов. С.А. Хабаров."
// into { title, author }. Tries the LAST ". " / "— " / "– " / "- " separator
// whose tail looks like a person name. Returns null when no author is found.
function splitTitleAuthor(line) {
    const text = String(line || '').trim();
    if (!text || text.length > 100) return null;
    const seps = [];
    const re = /(?:\.\s+|\u2014\s+|\u2013\s+|\-\s+)/g;
    let m;
    while ((m = re.exec(text)) !== null) seps.push({ idx: m.index, len: m[0].length });
    for (let i = seps.length - 1; i >= 0; i--) {
        const s = seps[i];
        const tail = text.slice(s.idx + s.len).trim().replace(/[.!?…]+$/, '');
        if (!looksLikeAuthorName(tail)) continue;
        const head = text.slice(0, s.idx).trim().replace(/[.!?…]+$/, '');
        if (head.length < 2) continue;
        return { title: head, author: tail };
    }
    return null;
}

// ── Hallucination guard: deterministic sanity checks on LLM output ──
// RegEx here NEVER decides what a line IS — it only rejects answers that
// cannot be true ("author can't have a name like this", "title too long",
// "anchored nowhere"). Everything unanchorable is dropped.

function sanitizeTitleLike(text) {
    const t = String(text || '').trim().replace(/\s+/g, ' ');
    if (!t) return null;
    if (t.length < 1 || t.length > 120) return null;
    if (t.length > 60 && /[,;:]/.test(t)) return null;   // looks like a sentence
    if (t.split(/\s+/).length > 14) return null;
    return t;
}

function sanitizeAuthorName(text) {
    if (!looksLikeAuthorName(text)) return null;
    return String(text).trim().replace(/[.!?…]+$/, '').replace(/\s+/g, ' ');
}

function sanitizeChapterNumber(n) {
    const num = Number(n);
    if (!Number.isInteger(num) || num < 1 || num > 999) return null;
    return num;
}

/**
 * Validate/sanitize a raw LLM structure result before applying it.
 * Returns a cleaned copy or null. Drops unanchorable elements, enforces
 * shape rules, and rewrites line_text anchors to real candidate ids.
 */
function sanitizeStructure(aiResult, candidates) {
    if (!aiResult || typeof aiResult !== 'object') return null;
    const byId = new Map(candidates.map(c => [c.id, c]));
    const sanitized = { ...aiResult };

    if (sanitized.title && typeof sanitized.title === 'object' && sanitized.title.text) {
        const t = sanitizeTitleLike(sanitized.title.text);
        if (!t) delete sanitized.title;
        else sanitized.title = { ...sanitized.title, text: t };
    }
    if (sanitized.author && typeof sanitized.author === 'object' && sanitized.author.text) {
        const a = sanitizeAuthorName(sanitized.author.text);
        if (!a) delete sanitized.author;
        else sanitized.author = { ...sanitized.author, text: a };
    }
    if (sanitized.title && sanitized.author &&
        sanitized.title.text.trim().toLowerCase() === sanitized.author.text.trim().toLowerCase()) {
        delete sanitized.author; // "author" cannot equal "title"
    }

    if (Array.isArray(sanitized.elements)) {
        sanitized.elements = sanitized.elements
            .map((el) => {
                if (!el || typeof el !== 'object') return null;
                const kind = normalizeKind(el.kind);
                if (!kind) return null;
                if (kind === 'reject') return { ...el, kind: 'reject' };

                // Anchor: candidate_id, or exact line_text found verbatim.
                let cand = el.candidate_id ? byId.get(el.candidate_id) : null;
                if (!cand && el.line_text && typeof el.line_text === 'string') {
                    const lt = String(el.line_text).trim();
                    const found = candidates.find(c => c.text.trim().toLowerCase() === lt.toLowerCase());
                    if (found) cand = found;
                }
                if (!cand) return null; // unanchorable → hallucination, drop

                const conf = typeof el.confidence === 'number' ? el.confidence : 0;
                if (conf < 0.5) return null;

                const out = {
                    ...el,
                    candidate_id: cand.id,
                    confidence: conf,
                };
                if (el.title !== undefined && el.title !== null) {
                    const t = String(el.title).trim();
                    if (t === '') {
                        out.title = null;   // titleless chapter — keep the boundary
                    } else {
                        const clean = sanitizeTitleLike(t);
                        if (!clean) return null; // genuinely invalid non-empty title
                        out.title = clean;
                    }
                }
                if (el.number !== undefined && el.number !== null) {
                    const n = sanitizeChapterNumber(el.number);
                    if (!n) return null;
                    out.number = n;
                }
                return out;
            })
            .filter(Boolean);
    }

    return sanitized;
}

// ── Number extraction ────────────────────────────────────────────

function extractNumber(text) {
    const m = /^\s*(\d{1,3})\s*[.)]?\s*/.exec(text);
    if (m) return parseInt(m[1], 10);
    const rm = ROMAN_RE.exec(text);
    if (rm) return romanToInt(rm[0].trim().replace(/[.)\s]/g, ''));
    return null;
}

function romanToInt(s) {
    const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let total = 0;
    for (let i = 0; i < s.length; i++) {
        const cur = map[s[i]] || 0;
        const next = map[s[i + 1]] || 0;
        total += cur < next ? -cur : cur;
    }
    return total;
}

// ── Deterministic chapter map (no LLM) ───────────────────────────

const TYPE_LABELS = {
    chapter: 'chapter',
    prologue: 'prologue',
    epilogue: 'epilogue',
    part: 'part',
    introduction: 'introduction',
    afterword: 'afterword',
    appendix: 'appendix',
};

/**
 * Build the canonical chapter map using ONLY the deterministic detector.
 * Conservative by design: title/author are guesses, boundaries come from
 * strong candidates, and content is never lost (unstructured text becomes
 * a single 'body' segment).
 */
function buildDeterministicMap(sourceText) {
    const { candidates, strong, nonEmptyCount, lineMeta, lines } = extractCandidates(sourceText);

    // ── Title / author (head zone) ──────────────────────────────
    let title = null;
    let author = null;

    const head = candidates
        .filter(c => c.inHeadBlock)
        .sort((a, b) => a.lineIndex - b.lineIndex);

    // Title: first non-empty line if short and clean, and the doc has real content.
    const first = head[0];

    // Same-line "Title. Author" pattern (e.g. "За пределами алгоритмов. С.А. Хабаров.").
    let sameLine = null;
    if (first && !first.keyword && !first.prefixDash) sameLine = splitTitleAuthor(first.text);

    // A plain (non "Title. Author") first line is only a title when it is
    // "weighty" enough — otherwise a poem's first verse or a short fragment
    // would be swallowed as a title and dropped from the narrative.
    const firstParagraphLen = first ? (first.nextParagraphLength || 0) : 0;
    const isConfidentTitle = first && !first.sentencePunctuation &&
        (first.wordCount >= 3 || firstParagraphLen >= 60 || nonEmptyCount >= 8);

    if (first && nonEmptyCount >= 2 && first.length <= 90 && !first.keyword && !first.prefixDash) {
        if (sameLine) {
            title = { text: sameLine.title, source: 'detect', candidateId: first.id };
            author = { text: sameLine.author, source: 'detect', candidateId: first.id };
        } else if (isConfidentTitle) {
            title = { text: first.text, source: 'detect', candidateId: first.id };
        }
    }

    // Author on a separate line: short metadata-like name (initials allowed).
    // Separated from the content below by a blank line (a name glued directly
    // to the story's first paragraph is likely narrative, not metadata).
    const second = head[1];
    if (title && !author && second && second.lineIndex > first.lineIndex &&
        second.length <= 45 && !second.keyword &&
        !second.sentencePunctuation &&
        second.blankLinesAfter >= 1 &&
        looksLikeAuthorName(second.text)) {
        author = { text: second.text, source: 'detect', candidateId: second.id };
    }

    // End of the head zone: skip title/author lines (and blanks) from content.
    let headEndLine = -1;
    if (author) headEndLine = author.candidateId
        ? (candidates.find(c => c.id === author.candidateId) || {}).lineIndex
        : -1;
    else if (title) headEndLine = (candidates.find(c => c.id === title.candidateId) || {}).lineIndex;

    const headEndOffset = headEndLine >= 0
        ? lineMeta[headEndLine].endOffset
        : 0;

    // ── Boundaries ──────────────────────────────────────────────
    const isHeadLine = (c) => headEndLine >= 0 && c.lineIndex <= headEndLine;
    let boundaries = strong.filter(c => !isHeadLine(c));

    // Merge multi-line headers: two adjacent candidate lines → one header.
    // The second line becomes the title of the first.
    const merged = [];
    for (const b of boundaries) {
        const prev = merged[merged.length - 1];
        if (prev && b.lineIndex === prev.lineIndex + 1 && b.blankLinesBefore === 0) {
            prev.titleLine = b;
            prev.adjacent = true;
        } else {
            merged.push({ ...b, titleLine: null, adjacent: false });
        }
    }
    boundaries = merged;

    // ── Classify each boundary into a segment ───────────────────
    const segments = [];
    let curStart = headEndOffset;
    let nextNum = 1;

    function pushSegment(boundary) {
        const endOffset = boundary ? boundary.startOffset : sourceText.length;
        const rawStart = curStart;
        curStart = endOffset;
        return { startOffset: rawStart, endOffset };
    }

    const segmentInfos = boundaries.map(b => {
        const type = TYPE_LABELS[b.keyword] || (b.keyword === 'introduction' ? 'introduction' : null);
        let segType = type;
        // Unknown-language keywords / ALL-CAPS / numbered lines → plain chapter.
        if (!segType) segType = 'chapter';

        let titleText = null;
        if (segType === 'chapter' || segType === 'part') {
            // "Глава 1. Земля" → number 1, title "Земля"
            const rest = b.keywordRest != null ? b.keywordRest : b.text;
            const num = extractNumber(rest) || (b.numbered || b.romanNumeral ? extractNumber(b.text) : null);
            if (num != null) {
                // Strip the number from the rest to find the title.
                titleText = rest.replace(/^\d{1,3}\s*[.)]?\s*/, '').replace(/^[.:]?\s*/, '').trim() || null;
            } else {
                titleText = rest || null;
            }
        } else {
            // prologue / epilogue / introduction / afterword / appendix
            titleText = b.keywordRest || null;
        }

        // Adjacent second line is the title when the rest is empty.
        if (!titleText && b.titleLine) titleText = b.titleLine.text;
        if (titleText && titleText.length > 120) titleText = titleText.slice(0, 120).trim();

        const number = (segType === 'chapter') ? (nextNum++) : null;

        return {
            type: segType,
            label: b.keywordWord || null,
            title: titleText || null,
            number,
            headerLine: b.text,
            lineIndex: b.lineIndex,
            source: 'detect',
        };
    });

    // Unstructured leading content (e.g. prologue text with an undetected
    // prologue header, or a book that starts with prose directly).
    const firstBoundaryOffset = boundaries.length > 0 ? boundaries[0].startOffset : sourceText.length;
    const leadingText = sourceText.slice(headEndOffset, firstBoundaryOffset).trim();
    if (leadingText && leadingText.length >= 120) {
        segments.push({
            type: 'body',
            label: null,
            title: null,
            number: null,
            headerLine: null,
            startOffset: headEndOffset,
            endOffset: firstBoundaryOffset,
            source: 'detect',
        });
        curStart = firstBoundaryOffset;
    }

    for (let i = 0; i < boundaries.length; i++) {
        const info = segmentInfos[i];
        const endOffset = i + 1 < boundaries.length ? boundaries[i + 1].startOffset : sourceText.length;
        segments.push({
            type: info.type,
            label: info.label,
            title: info.title,
            number: info.number,
            headerLine: info.headerLine,
            startOffset: boundaries[i].startOffset,
            endOffset,
            source: 'detect',
        });
    }

    // No boundaries at all → single 'body' segment (poem, fragment, few sentences).
    if (segments.length === 0) {
        segments.push({
            type: 'body',
            label: null,
            title: null,
            number: null,
            headerLine: null,
            startOffset: headEndOffset,
            endOffset: sourceText.length,
            source: 'detect',
        });
    }

    // Trim: segments must be non-empty and never overlap.
    const clean = [];
    for (const s of segments) {
        if (s.endOffset <= s.startOffset) continue;
        clean.push(s);
    }

    const hasPrologue = clean.some(s => s.type === 'prologue');
    const hasEpilogue = clean.some(s => s.type === 'epilogue');
    const parts = clean.filter(s => s.type === 'part').map((s, i) => ({
        name: s.title || s.headerLine || `Часть ${i + 1}`,
        order: i + 1,
    }));

    return {
        title,
        author,
        hasPrologue,
        hasEpilogue,
        parts,
        segments: clean,
        source: 'detect',
    };
}

// ── LLM decision merge ───────────────────────────────────────────

function normalizeKind(kind) {
    const k = String(kind || '').toLowerCase().replace(/[\s_-]+/g, '_');
    if (k === 'reject' || k === 'heading' || k === 'narrative' || k === 'none' || k === 'no') return 'reject';
    if (TYPE_LABELS[k]) return k;
    if (k === 'poem') return 'poem';
    return null;
}

/**
 * Merge LLM classifications into the deterministic chapter map.
 * Anchors: candidate_id (or exact line_text found verbatim in the source).
 * Anything unanchorable is ignored — the LLM can never invent offsets.
 */
function mergeAiDecisions(sourceText, aiResult) {
    const base = buildDeterministicMap(sourceText);
    if (!aiResult || typeof aiResult !== 'object') return base;

    const { candidates, lineMeta } = extractCandidates(sourceText);
    const byId = new Map(candidates.map(c => [c.id, c]));

    // ── Hallucination guard runs BEFORE anything is applied ──
    const cleanedAi = sanitizeStructure(aiResult, candidates) || {};

    const findCandidate = (el) => {
        if (el.candidate_id && byId.has(el.candidate_id)) return byId.get(el.candidate_id);
        if (el.line_text && typeof el.line_text === 'string') {
            const t = el.line_text.trim();
            const found = candidates.find(c => c.text === t);
            if (found) return found;
            // Allow the head zone too (title/author lines are candidates as well).
            return candidates.find(c => c.text.toLowerCase() === t.toLowerCase()) || null;
        }
        return null;
    };

    // ── Title / author (confidence-gated; never erase without a decision) ──
    let title = base.title;
    let author = base.author;

    // Keep a base-derived split (e.g. "Title. Author" from one line) when the
    // LLM text matches that line; only fall back to the full line text when the
    // candidate is exactly that line and no split exists.
    function applyTextField(field, current, baseVal) {
        if (!field || typeof field !== 'object') return current;
        const conf = typeof field.confidence === 'number' ? field.confidence : 0;
        if (conf < 0.5) return current;
        const text = String(field.text || '').trim();
        if (!text) return current;
        const cand = findCandidate(field);
        if (cand) {
            if (baseVal && baseVal.candidateId === cand.id &&
                (baseVal.text === text || cand.text.includes(baseVal.text))) {
                return { ...baseVal, source: 'ai' };
            }
            return { text: cand.text, source: 'ai', candidateId: cand.id };
        }
        // Unanchored: only accept an EXACT match of the base value.
        if (baseVal && baseVal.text === text) return { ...baseVal, source: 'ai' };
        return current;
    }
    title = applyTextField(cleanedAi.title, title, base.title);
    author = applyTextField(cleanedAi.author, author, base.author);

    // ── Element decisions → boundary overrides ──────────────────
    // boundaryByLine: lineIndex → { type, title, number, label }
    const boundaryByLine = new Map();
    for (const s of base.segments) {
        if (!s.headerLine || s.type === 'body' || s.type === 'poem') continue;
        const cand = candidates.find(c => c.text === s.headerLine);
        if (cand && cand.lineIndex !== undefined) {
            boundaryByLine.set(cand.lineIndex, {
                type: s.type,
                title: s.title,
                number: s.number,
                label: s.label,
                headerLine: s.headerLine,
                source: s.source,
            });
        }
    }

    const rejectLines = new Set();
    for (const el of (cleanedAi.elements || [])) {
        if (!el || typeof el !== 'object') continue;
        const conf = typeof el.confidence === 'number' ? el.confidence : 0;
        const kind = normalizeKind(el.kind);
        if (kind === 'reject') {
            const cand = findCandidate(el);
            if (cand && cand.lineIndex !== undefined) rejectLines.add(cand.lineIndex);
            continue;
        }
        if (!kind || conf < 0.5) continue;
        const cand = findCandidate(el);
        if (!cand || cand.lineIndex === undefined) continue;
        const existing = boundaryByLine.get(cand.lineIndex);
        const titleText = typeof el.title === 'string' && el.title.trim()
            ? el.title.trim().slice(0, 120)
            : (existing && existing.title) || null;   // AI empty title → keep deterministic
        const num = typeof el.number === 'number'
            ? el.number
            : (existing && existing.number != null ? existing.number : null);
        boundaryByLine.set(cand.lineIndex, {
            type: kind,
            title: titleText,
            number: num,
            label: kind === 'chapter' ? (cand.keywordWord || 'Глава') : (cand.keywordWord || null),
            headerLine: cand.text,
            source: 'ai',
        });
    }

    // ── Rebuild segments from boundaries ────────────────────────
    const headEndLine = (() => {
        const srcId = (title && title.candidateId) ? title.candidateId : (author && author.candidateId ? author.candidateId : null);
        if (!srcId) return -1;
        const c = byId.get(srcId);
        return c ? c.lineIndex : -1;
    })();
    const headEndOffset = headEndLine >= 0 ? lineMeta[headEndLine].endOffset : 0;

    const boundaryLines = [...boundaryByLine.keys()]
        .filter(li => li > headEndLine && !rejectLines.has(li))
        .sort((a, b) => a - b);

    const rebuilt = [];
    let prevEndOffset = headEndOffset;
    let prevBoundaryLi = null;
    let isFirst = true;

    for (const li of boundaryLines) {
        const info = boundaryByLine.get(li);
        const bStart = lineMeta[li].startOffset;
        if (bStart < prevEndOffset) continue;

        // Adjacent boundary line → continuation title of the previous header
        // (multi-line headers like "Глава 1" + "Земля").
        if (prevBoundaryLi !== null && li === prevBoundaryLi + 1) {
            const last = rebuilt[rebuilt.length - 1];
            if (last && !last.title) last.title = info.title || lineMeta[li].text;
            continue;
        }

        // Leading unstructured content before the FIRST boundary (undetected
        // prologue/headless text) becomes a 'body' segment — never lost.
        if (isFirst && bStart > prevEndOffset) {
            const gapText = sourceText.slice(prevEndOffset, bStart).trim();
            if (gapText.length >= 120) {
                rebuilt.push({
                    type: 'body', label: null, title: null, number: null,
                    headerLine: null, startOffset: prevEndOffset, endOffset: bStart,
                    source: 'detect',
                });
            }
        }

        rebuilt.push({
            type: info.type,
            label: info.label,
            title: info.title,
            number: info.number,
            headerLine: info.headerLine,
            startOffset: bStart,
            endOffset: sourceText.length,
            source: info.source,
        });
        prevEndOffset = bStart;
        prevBoundaryLi = li;
        isFirst = false;
    }

    if (boundaryLines.length === 0) {
        // No boundaries survived → keep the deterministic result untouched
        // (or a single body segment when nothing structural remains).
        return {
            title, author,
            hasPrologue: base.hasPrologue,
            hasEpilogue: base.hasEpilogue,
            parts: base.parts,
            segments: base.segments,
            source: 'ai',
        };
    }

    // Assign endOffsets (next boundary start or EOF).
    for (let i = 0; i < rebuilt.length; i++) {
        const endOffset = i + 1 < rebuilt.length ? rebuilt[i + 1].startOffset : sourceText.length;
        rebuilt[i].endOffset = endOffset;
    }

    const cleanSegs = rebuilt.filter(s => s.endOffset > s.startOffset);

    // Number chapters in order if the LLM didn't provide numbers.
    let autoNum = 1;
    for (const s of cleanSegs) {
        if (s.type === 'chapter' && s.number == null) s.number = autoNum++;
    }

    const hasPrologue = cleanSegs.some(s => s.type === 'prologue');
    const hasEpilogue = cleanSegs.some(s => s.type === 'epilogue');
    const srcLower = sourceText.toLowerCase();
    const parts = Array.isArray(cleanedAi.parts)
        ? cleanedAi.parts
            .filter(p => p && typeof p.name === 'string' && p.name.trim()
                && srcLower.includes(p.name.trim().toLowerCase())) // must exist in the text
            .map((p, i) => ({ name: p.name.trim(), order: typeof p.order === 'number' ? p.order : i + 1 }))
        : cleanSegs.filter(s => s.type === 'part').map((s, i) => ({
            name: s.title || s.headerLine || `Часть ${i + 1}`, order: i + 1,
        }));

    return {
        title, author,
        hasPrologue, hasEpilogue,
        parts,
        segments: cleanSegs,
        source: 'ai',
    };
}

// ── Compatibility helpers ────────────────────────────────────────

/**
 * Convert a chapter map into the legacy AI structure.chapters shape
 * ({ type, number, title, header_line }), aligned by index with segments.
 */
function mapToStructureChapters(map) {
    return (map.segments || []).map(s => ({
        type: s.type === 'body' || s.type === 'poem' ? 'chapter' : s.type,
        number: s.number,
        title: s.title,
        label: s.label || null,
        header_line: s.headerLine || '',
    }));
}

/**
 * One-shot convenience: candidates → (optional AI) → final chapter map.
 * When aiResult is falsy, returns the deterministic fallback.
 */
function analyzeStructure(sourceText, aiResult) {
    if (aiResult && typeof aiResult === 'object') return mergeAiDecisions(sourceText, aiResult);
    return buildDeterministicMap(sourceText);
}

module.exports = {
    STRUCTURE_KEYWORDS,
    extractCandidates,
    matchKeyword,
    buildDeterministicMap,
    mergeAiDecisions,
    mapToStructureChapters,
    analyzeStructure,
    sanitizeStructure,
    // internals exposed for tests
    _extractNumber: extractNumber,
    _romanToInt: romanToInt,
};
