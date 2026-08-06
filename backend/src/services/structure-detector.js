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
        // Terminal/hard punctuation usually means prose, not a heading — BUT an
        // ALL-CAPS line ("ПОРА! ПОРА!", "ШИЗОФРЕНИЯ, КАК И БЫЛО СКАЗАНО") is the
        // classic "shouting" chapter heading of Russian editions, so the
        // penalty is much smaller there — otherwise such headers glued to the
        // "Глава N" line (no blank line) would never reach the strong set.
        if (sentencePunct) score -= allCaps ? 0.15 : 0.4;
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
    // A date range like "1929 — 1940" at the end of the book is colophon data,
    // never a chapter heading.
    const DATE_RANGE_RE = /^\d{4}\s*[\u2014\u2013-]\s*\d{4}$/;
    const strong = candidates.filter(c =>
        !c.prefixDash &&
        !DATE_RANGE_RE.test(c.text) &&
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

// ── Author surname ↔ narrative frequency check ───────────────────
// The agent answers "is there a full name?" for the very first line. The
// PROGRAM then verifies that answer against the text: if the surname from
// that name regularly appears in the narrative, it is a CHARACTER, not the
// author ("Жизнь Хабарова" is a title whose surname sits inside the title
// text — never an author line). A real author's surname virtually never
// appears in the book's own prose. This is a supplementary signal, not an
// absolute rule.
const AUTHOR_SURNAME_MIN_HITS = 2;

/**
 * "С.А. Хабаров" / "С. А. Хабаров" / "Хабаров С.А." → "Хабаров".
 * The surname is the last non-initial capitalized word. null when the name
 * has no word-like token (pure initials) or the token is not a name.
 */
function extractSurname(authorText) {
    const tokens = String(authorText || '').trim().replace(/[.!?…]+$/, '').split(/\s+/).filter(Boolean);
    let surname = null;
    for (const tok of tokens) {
        const clean = tok.replace(/[,.;:]+$/g, '');
        if (INITIAL_TOKEN_RE.test(clean)) continue;
        if (NAME_TOKEN_RE.test(clean)) surname = clean;
    }
    return surname;
}

/**
 * Count capitalized occurrences of the surname inside the narrative text,
 * allowing Russian declension endings (Хабаров → Хабарова/Хабарову/Хабаровым).
 * Case-sensitive on purpose: proper names are capitalized in prose, so common
 * lowercase words do not match. JS \b is ASCII-only, hence explicit boundaries.
 */
function countSurnameInText(text, surname) {
    if (!surname || !text) return 0;
    // Root-normalize: drop a trailing vowel so that "Хабарова" (genitive in a
    // title) matches narrative "Хабаров", and vice versa. "Булгаков" stays.
    let root = String(surname).trim();
    if (/[аяуюеоыиэ]$/i.test(root)) root = root.slice(0, -1);
    if (root.length < 2) return 0;
    const esc = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^A-Za-zА-Яа-яЁё])' + esc + '[a-zа-яё]{0,6}(?=$|[^A-Za-zА-Яа-яЁё])', 'g');
    let count = 0;
    while (re.exec(text)) count++;
    return count;
}

/**
 * True when the author candidate's surname regularly appears in the narrative
 * (the text AFTER narrativeStartOffset, i.e. after the head/title lines).
 * Offsets are exclusive of the head line itself, so the author name on the
 * title line is never counted.
 */
function isAuthorSurnameACharacter(sourceText, authorText, narrativeStartOffset) {
    const surname = extractSurname(authorText);
    if (!surname) return false;
    const narrative = String(sourceText || '').slice(narrativeStartOffset || 0);
    return countSurnameInText(narrative, surname) >= AUTHOR_SURNAME_MIN_HITS;
}

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

// Index in `tokens` where a trailing person-name suffix starts, or -1.
// A valid suffix is 2-4 trailing tokens, all initials/capitalized words, with
// >= 1 initial AND >= 1 full word, and at least one title token before it.
// The initial requirement is what keeps "Жизнь Хабарова" (a bare capitalized
// word inside the title) from being misread as an author line.
function trailingFullNameIndex(tokens) {
    let end = tokens.length;
    let initials = 0;
    let fullWords = 0;
    while (end > 0) {
        const tok = String(tokens[end - 1]);
        const clean = tok.replace(/[,.;:]+$/g, '');
        // Initials are detected on the RAW token ("А." — the period is part of
        // the initial); full words on the punctuation-stripped token.
        if (INITIAL_TOKEN_RE.test(tok)) { initials++; end--; continue; }
        if (NAME_TOKEN_RE.test(clean)) { fullWords++; end--; continue; }
        break;
    }
    const runLen = tokens.length - end;
    if (runLen < 2 || fullWords === 0 || initials === 0) return -1;
    if (end === 0) return -1; // the whole line is just a name — no title to keep
    return end;
}

// Split a first line like "За пределами алгоритмов. С.А. Хабаров." — or the
// no-separator variant "За пределами алгоритмов С. А. Хабаров" — into
// { title, author }. The name suffix must sit at the END of the line (a name
// glued inside the title text, "Жизнь Хабарова", is not an author). Returns
// null when no author is found.
function splitTitleAuthor(line) {
    const text = String(line || '').trim();
    if (!text || text.length > 100) return null;

    // (A) No-separator "Title ФИО" one-liner: "Title С. А. Хабаров".
    // The title part must be WEIGHTY (>= 3 words): a short head like "Звали
    // его" from a narrative first line "Звали его Д. И. Иванов" must not be
    // split — it is a sentence, not a title+author line.
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length >= 3) {
        const nameIdx = trailingFullNameIndex(tokens);
        if (nameIdx > 0) {
            const headTokens = tokens.slice(0, nameIdx);
            const head = headTokens.join(' ').replace(/[.!?…\s]+$/, '').trim();
            const author = tokens.slice(nameIdx).join(' ').replace(/[.!?…]+$/, '').trim();
            if (headTokens.length >= 3 && head.length >= 2 && looksLikeAuthorName(author)) {
                return { title: head, author };
            }
        }
    }

    // (B) Separator-based: "Title. Author." / "Title — Author" / "Title - Author".
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
function sanitizeStructure(aiResult, candidates, sourceText) {
    if (!aiResult || typeof aiResult !== 'object') return null;
    const byId = new Map(candidates.map(c => [c.id, c]));
    const sanitized = { ...aiResult };

    // Anchored line lookup shared by title/author: the value must be anchored
    // to a real candidate line (candidate_id or verbatim line_text) AND be
    // consistent with that line's text — "Title. Author" one-liners anchor the
    // author to the same line as the title, so containment (either direction)
    // is the consistency rule. Anything else is a hallucination.
    const anchoredLine = (field) => {
        if (!field || typeof field !== 'object') return null;
        let cand = field.candidate_id ? byId.get(field.candidate_id) : null;
        if (!cand && field.line_text && typeof field.line_text === 'string') {
            const lt = String(field.line_text).trim();
            const ltNorm = lt.replace(/[.!?…]+$/, '');
            cand = candidates.find(c => c.text.trim().toLowerCase() === lt.toLowerCase())
                // LLMs routinely drop a decorative trailing period from the line
                // they anchor to — match the punctuation-stripped forms too.
                || candidates.find(c => c.text.trim().toLowerCase().replace(/[.!?…]+$/, '') === ltNorm.toLowerCase())
                || null;
        }
        return cand;
    };
    const textConsistentWithLine = (text, lineText) => {
        if (!text || !lineText) return false;
        return text === lineText || lineText.includes(text) || text.includes(lineText);
    };

    if (sanitized.title && typeof sanitized.title === 'object' && sanitized.title.text) {
        const t = sanitizeTitleLike(sanitized.title.text);
        const line = anchoredLine(sanitized.title);
        if (!t || !line || !textConsistentWithLine(t, line.text)) delete sanitized.title;
        else sanitized.title = { ...sanitized.title, text: t };
    }
    if (sanitized.author && typeof sanitized.author === 'object' && sanitized.author.text) {
        const a = sanitizeAuthorName(sanitized.author.text);
        const line = anchoredLine(sanitized.author);
        if (!a || !line || !textConsistentWithLine(a, line.text)) delete sanitized.author;
        else if (sourceText && isAuthorSurnameACharacter(sourceText, a, line.endOffset)) {
            // The agent said "there is a full name", but the program verified the
            // surname regularly appears in the narrative — it is a character.
            delete sanitized.author;
        } else {
            sanitized.author = { ...sanitized.author, text: a };
        }
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

// ── Chapter-template learning ────────────────────────────────────
// If the first confident boundaries are keyword-headed chapters ("Глава N"),
// the remaining chapters are expected to follow the SAME template. Standalone
// strong lines WITHOUT a structural keyword are then decorative/poster text
// inside a chapter (e.g. the theatre poster "ПРОФЕССОР ВОЛАНД" in Мастер и
// Маргарита), not chapter boundaries. When the template does not fire, all
// strong candidates stay — the behavior is unchanged.
//
// The poster drop is scoped on purpose so a real unkeyworded chapter (interlude,
// "Вместо эпилога", unnumbered section in a mixed-style book) is never
// swallowed. A line is a decorative poster when it is (a) glued close below a
// keyword header, or (b) the head of a multi-line ALL-CAPS block — a theatre
// poster is several short CAPS lines in a row ("ПРОФЕССОР ВОЛАНД" followed by
// "Сеансы черной магии с полным ее разоблачением"), and in Мастер и Маргарита
// it sits 28 lines below "Глава 10", so distance alone cannot catch it.
const POSTER_DISTANCE_LINES = 4;
function learnKeywordTemplate(boundaries) {
    const anchors = boundaries.filter(b =>
        b.keyword === 'chapter' && b.keywordRest && extractNumber(b.keywordRest.trim()) != null
    ).slice(0, 3);
    return anchors.length >= 2;
}
function applyKeywordTemplate(merged, sourceText) {
    const isPoster = (b) => {
        let prevKw = null;
        for (let i = merged.indexOf(b) - 1; i >= 0; i--) {
            if (merged[i].keyword !== null) { prevKw = merged[i]; break; }
        }
        if (!prevKw) return false;                 // no keyword anchor before → real boundary
        // (a) glued close under a keyword header → decorative continuation
        if (b.lineIndex - prevKw.lineIndex <= POSTER_DISTANCE_LINES) return true;
        // (b) multi-line poster block: the very next paragraph is ONE short
        //     line that is NOT a prose sentence (no terminal period) — the
        //     poster continues ("ПРОФЕССОР ВОЛАНД" + "Сеансы черной магии...").
        //     Real posters often mix ALL-CAPS and title-case lines. The
        //     paragraph AFTER that must be long prose (>= 120 chars) — the
        //     poster block is heading + short caption + blank + prose. A real
        //     unkeyworded chapter whose first paragraph is a short period-less
        //     line is indistinguishable here (documented trade-off; the LLM
        //     merge path can still classify the line when the LLM sees it).
        if (b.nextParagraphLines === 1 && b.nextParagraphLength <= 60 &&
            !/[.!?…]$/.test(String(b.nextParagraphPreview).trim())) {
            // The caption line must be followed (after a blank) by LONG prose:
            // paras[0] = the short caption, paras[1] = the chapter prose.
            const rest = String(sourceText || '').slice(b.endOffset).trim();
            const paras = rest.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
            if (paras.length >= 2 && paras[1].length >= 120) return true;
        }
        return false;
    };
    return merged.filter(b => b.keyword !== null || !isPoster(b));
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

    // ── Inverted title page: AUTHOR on the first line, TITLE on the second ──
    // Classical Russian editions: "Михаил Афанасиевич Булгаков" then, a few
    // blank lines later, "Мастер и Маргарита". The author line is a full name
    // WITH or WITHOUT initials (name + patronymic + surname, or the equally
    // common initials + surname "С.А. Хабаров"); the title line is not a name.
    // For 2-word lines an INITIALS token is the decisive signal — a two-word
    // title like "Анна Каренина" (no initials) is never misread as an author.
    // The surname-frequency check still applies: an author whose surname
    // appears in the narrative is a character.
    //
    // TRADE-OFF (documented): an EPIGRAPH attribution at the very top
    // ("К. Симонов\n\nМоя книга") is indistinguishable from an inverted title
    // page by pure structure — both are a short name line above a non-name
    // line. The deterministic path treats it as author+title (the title is
    // recovered correctly); the LLM merge can still override the author when
    // it sees the full head block.
    const second = head[1];
    const firstWords = first ? first.text.split(/\s+/).filter(Boolean) : [];
    const firstHasInitial = firstWords.some(tok => INITIAL_TOKEN_RE.test(tok));
    const firstIsFullName = first && !first.keyword && !first.prefixDash &&
        !first.sentencePunctuation && first.length <= 45 &&
        first.blankLinesAfter >= 1 &&
        looksLikeAuthorName(first.text) &&
        (firstHasInitial || firstWords.length >= 3);
    const secondLooksLikeTitle = second && !second.keyword && !second.prefixDash &&
        second.length <= 90 && second.lineIndex > first.lineIndex &&
        !looksLikeAuthorName(second.text);
    if (firstIsFullName && secondLooksLikeTitle &&
        !isAuthorSurnameACharacter(sourceText, first.text, first.endOffset)) {
        author = { text: first.text, source: 'detect', candidateId: first.id };
        // The title line often carries a decorative trailing period in source
        // files ("За пределами алгоритмов.") — strip a terminal period just
        // like splitTitleAuthor strips the halves of a "Title. Author"
        // one-liner. Only PERIODS are stripped, never ?/!/…: «Кто виноват?»
        // keeps its question mark.
        const cleanTitle = second.text.replace(/\.+$/, '').trim() || second.text;
        title = { text: cleanTitle, source: 'detect', candidateId: second.id };
    }

    // Same-line "Title. Author" pattern (e.g. "За пределами алгоритмов. С.А. Хабаров.").
    let sameLine = null;
    if (first && !first.keyword && !first.prefixDash) sameLine = splitTitleAuthor(first.text);

    // A plain (non "Title. Author") first line is only a title when it is
    // "weighty" enough — otherwise a poem's first verse or a short fragment
    // would be swallowed as a title and dropped from the narrative.
    const firstParagraphLen = first ? (first.nextParagraphLength || 0) : 0;
    const isConfidentTitle = first && !first.sentencePunctuation &&
        (first.wordCount >= 3 || firstParagraphLen >= 60 || nonEmptyCount >= 8);

    if (!author && first && nonEmptyCount >= 2 && first.length <= 90 && !first.keyword && !first.prefixDash) {
        if (sameLine && !isAuthorSurnameACharacter(sourceText, sameLine.author, first.endOffset)) {
            title = { text: sameLine.title, source: 'detect', candidateId: first.id };
            author = { text: sameLine.author, source: 'detect', candidateId: first.id };
        } else if (sameLine && isConfidentTitle) {
            // The split name regularly appears in the narrative → it is a
            // CHARACTER, not an author ("За пределами алгоритмов С.А. Хабаров"
            // where Хабаров is a character in the story). Keep the clean split
            // title, drop only the author.
            title = { text: sameLine.title, source: 'detect', candidateId: first.id };
        } else if (!sameLine && isConfidentTitle) {
            title = { text: first.text, source: 'detect', candidateId: first.id };
        }
    }

    // Author on a separate line: short metadata-like name (initials allowed).
    // Separated from the content below by a blank line (a name glued directly
    // to the story's first paragraph is likely narrative, not metadata).
    // The surname-frequency check applies here too: a surname that regularly
    // appears in the narrative is a character, not the author.
    if (title && !author && second && second.lineIndex > first.lineIndex &&
        second.length <= 45 && !second.keyword &&
        !second.sentencePunctuation &&
        second.blankLinesAfter >= 1 &&
        looksLikeAuthorName(second.text) &&
        !isAuthorSurnameACharacter(sourceText, second.text, second.endOffset)) {
        author = { text: second.text, source: 'detect', candidateId: second.id };
    }

    // End of the head zone: skip title/author lines (and blanks) from content.
    // The head zone ends after the LAST head line — on an inverted title page
    // the title sits BELOW the author line.
    let headEndLine = -1;
    for (const candId of [title && title.candidateId, author && author.candidateId]) {
        if (!candId) continue;
        const c = candidates.find(x => x.id === candId);
        if (c && c.lineIndex > headEndLine) headEndLine = c.lineIndex;
    }

    const headEndOffset = headEndLine >= 0
        ? lineMeta[headEndLine].endOffset
        : 0;

    // ── Boundaries ──────────────────────────────────────────────
    const isHeadLine = (c) => headEndLine >= 0 && c.lineIndex <= headEndLine;
    let boundaries = strong.filter(c => !isHeadLine(c));

    // Merge multi-line headers: "Глава 1" + (blank lines) + "ЗАГОЛОВОК" is ONE
    // header — the ALL-CAPS title line becomes the title of the numbered line.
    // Classical Russian editions put a blank line between the number and the
    // title, so the continuation may sit up to 2 blank lines below. ALL-CAPS
    // lines are titles even with punctuation inside ("ШИЗОФРЕНИЯ, КАК И БЫЛО
    // СКАЗАНО", "ПОРА! ПОРА!"); only non-CAPS lines need to be punctuation-free.
    const keywordTemplate = learnKeywordTemplate(boundaries);
    const merged = [];
    for (const b of boundaries) {
        const prev = merged[merged.length - 1];
        const isContinuation = prev && !prev.titleLine &&
            b.lineIndex - prev.lineIndex <= 3 &&
            b.blankLinesBefore <= 2 &&
            b.length >= 2 && b.length <= 60 &&
            (b.allCaps || !b.sentencePunctuation) &&
            (b.allCaps || b.headingLikelihood >= 0.4) &&
            b.followedByLongParagraph &&
            prev.headingLikelihood >= 0.55;
        if (isContinuation) {
            prev.titleLine = b;
            prev.adjacent = true;
        } else {
            merged.push({ ...b, titleLine: null, adjacent: false });
        }
    }
    // Template: keyword-headed chapters → standalone non-keyword strong lines
    // (posters, decorative ALL-CAPS) are NOT boundaries. Merged titleLines are
    // already absorbed into their keyword headers and survive.
    boundaries = keywordTemplate ? applyKeywordTemplate(merged, sourceText) : merged;

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

        // Adjacent second line is the title when the rest is empty — or when the
        // header itself carried no keyword-derived title (a bare ALL-CAPS line
        // like "ПРОФЕССОР ВОЛАНД" whose title is the line below it).
        if (b.titleLine && (titleText === b.text || !titleText)) titleText = b.titleLine.text;
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
    // Part headers ("ЧАСТЬ ПЕРВАЯ") are DECORATIVE: they split the reading order
    // but are not functional chapters. No segment is created for them — the
    // header line falls between two chapters and is dropped from content.
    const clean = [];
    for (const s of segments) {
        if (s.endOffset <= s.startOffset) continue;
        if (s.type === 'part') continue;
        clean.push(s);
    }

    const hasPrologue = clean.some(s => s.type === 'prologue');
    const hasEpilogue = clean.some(s => s.type === 'epilogue');
    const parts = segmentInfos.filter(s => s.type === 'part').map((s, i) => ({
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
    // sourceText enables the surname-frequency check: the agent's "author" is
    // kept only when the surname does NOT regularly appear in the narrative.
    const cleanedAi = sanitizeStructure(aiResult, candidates, sourceText) || {};

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
            // Use the LLM-provided text (already anchored + sanitized), NOT the
            // full candidate line: for a "Title. Author" one-liner the line text
            // is the whole line, not the author.
            return { text, source: 'ai', candidateId: cand.id };
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

    // Part headers are decorative (no functional chapter): their segments are
    // dropped, but the part info is kept when the LLM reported it.
    const partSegs = rebuilt.filter(s => s.type === 'part' && s.endOffset > s.startOffset);
    const cleanSegs = rebuilt.filter(s => s.endOffset > s.startOffset && s.type !== 'part');

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
        : partSegs.map((s, i) => ({
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
    isAuthorSurnameACharacter,
    // internals exposed for tests
    _extractNumber: extractNumber,
    _romanToInt: romanToInt,
    _extractSurname: extractSurname,
    _countSurnameInText: countSurnameInText,
};
