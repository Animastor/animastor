// ======================================================
// Structure Analyzer — AI DECISION MERGE (F1/F6, C19)
// ======================================================
// Physical home of the AI half of the former dual-role
// structure-detector.js (C18 H7). The deterministic half stayed
// host-side as the Parser adapter
// (../structure-detector-deterministic.js, bound into @animastor/parser
// via setStructureDetector); this module owns the AI decision merge:
//
//   sanitizeStructure   — hallucination guard on raw LLM output
//   mergeAiDecisions    — deterministic backbone + guarded LLM merge
//   analyzeStructure    — one-shot: candidates → (optional AI) → map
//
// The LLM call itself does NOT happen here — the step entry point
// (./index.js) reaches the model exclusively through the injected
// ai-caller port (C17 guard 5 / C18 §8).
// ======================================================

const {
    TYPE_LABELS,
    extractCandidates,
    buildDeterministicMap,
    isAuthorSurnameACharacter,
    looksLikeAuthorName,
} = require('../structure-detector-deterministic');

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

// A chapter title that is just the bare number ("Глава 1" → title "1",
// number 1) is the parser/LLM echoing the number as the title — NOT a real
// title. Used by sanitizeStructure and the AI-header-continuation merge so
// the real (deterministic) title wins over the number echo.
function isBareNumberTitle(title, number) {
    if (number == null) return false;
    const t = String(title || '').trim();
    return /^\d{1,3}$/.test(t) && parseInt(t, 10) === number;
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
                if (el.number !== undefined && el.number !== null) {
                    const n = sanitizeChapterNumber(el.number);
                    if (!n) return null;
                    out.number = n;
                }
                if (el.title !== undefined && el.title !== null) {
                    const t = String(el.title).trim();
                    // A chapter title that is just the bare number ("Глава 1" →
                    // title "1", number 1) is the LLM echoing the number as the
                    // title — NOT a real title. Null it so the deterministic
                    // backbone title ("НИКОГДА...") survives for the same line
                    // (import_1786345731767 → intro unit text "Глава 1\n1").
                    const bareNumberTitle = isBareNumberTitle(t, out.number);
                    if (t === '' || bareNumberTitle) {
                        out.title = null;   // titleless chapter — keep the boundary
                    } else {
                        const clean = sanitizeTitleLike(t);
                        if (!clean) return null; // genuinely invalid non-empty title
                        out.title = clean;
                    }
                }
                return out;
            })
            .filter(Boolean);
    }

    return sanitized;
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

    const byLine = new Map(candidates.map(c => [c.lineIndex, c]));

    for (const li of boundaryLines) {
        const info = boundaryByLine.get(li);
        const bStart = lineMeta[li].startOffset;
        if (bStart < prevEndOffset) continue;

        // ── Multi-line header continuation (AI merge path) ──
        // "Глава 1" + (blank lines) + "ЗАГОЛОВОК" is ONE header — the ALL-CAPS
        // title line becomes the title of the numbered line. The LLM routinely
        // classifies BOTH lines as separate chapters (import_1786345731767 →
        // duplicate "Глава 1" / "НИКОГДА..." segments and the intro unit text
        // "Глава 1\n1"). Mirror the deterministic map's merge: a title-like
        // line within a few lines below a keyword-headed boundary is that
        // boundary's TITLE, not a new segment.
        const prevCand = prevBoundaryLi !== null ? byLine.get(prevBoundaryLi) : null;
        const curCand = byLine.get(li);
        const prevInfo = prevBoundaryLi !== null ? boundaryByLine.get(prevBoundaryLi) : null;
        const isHeaderContinuation = prevBoundaryLi !== null && prevCand && curCand && prevInfo &&
            li - prevBoundaryLi <= 3 &&
            curCand.blankLinesBefore <= 2 &&
            curCand.length >= 2 && curCand.length <= 60 &&
            (curCand.allCaps || !curCand.sentencePunctuation) &&
            curCand.followedByLongParagraph &&
            prevCand.headingLikelihood >= 0.55 &&
            !!prevInfo.label; // previous boundary is keyword-headed (Глава/Пролог/…)
        if (isHeaderContinuation) {
            const last = rebuilt[rebuilt.length - 1];
            if (last) {
                const contTitle = info.title || curCand.text;
                const prevTitle = last.title ? String(last.title).trim() : '';
                const prevIsBareNumber = isBareNumberTitle(prevTitle, last.number);
                const contIsBareNumber = isBareNumberTitle(contTitle, info.number);
                if (!prevTitle || prevIsBareNumber) {
                    // The ALL-CAPS line is the REAL title — it wins over the
                    // header's own empty or bare-number title ("Глава 1" + title
                    // "1" → "НИКОГДА...").
                    last.title = contIsBareNumber ? curCand.text : contTitle;
                }
                // else: the header already carries a real title — keep it and
                // drop the duplicate segment.
            }
            // The continuation line is absorbed as the header's title: it gets
            // NO new segment and its own LLM number (if any) is intentionally
            // discarded — the header's number is the chapter number.
            continue;
        }

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

    // ── Chapter numbering ──────────────────────────────────────
    // Renumber chapters in reading order unless the LLM's numbers are already
    // a clean 1..N sequence. Absorption of ALL-CAPS title lines drops their
    // duplicate numbers — but when the LLM numbered EVERY line sequentially
    // (1,2,3,4...) instead of pairing "Глава N" with its title, the surviving
    // headers keep gaps (1,3,5...). Renumber like the deterministic map does
    // (nextNum), so chapter numbers always match reading order. This also
    // fills null numbers, preserving the legacy behavior.
    const chapterNums = cleanSegs.filter(s => s.type === 'chapter').map(s => s.number);
    const isCleanSequence = chapterNums.every((n, i) => n === i + 1);
    if (!isCleanSequence) {
        let autoNum = 1;
        for (const s of cleanSegs) {
            if (s.type === 'chapter') s.number = autoNum++;
        }
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

// ── Public seam ──────────────────────────────────────────────────

/**
 * One-shot convenience: candidates → (optional AI) → final chapter map.
 * When aiResult is falsy, returns the deterministic fallback.
 */
function analyzeStructure(sourceText, aiResult) {
    if (aiResult && typeof aiResult === 'object') return mergeAiDecisions(sourceText, aiResult);
    return buildDeterministicMap(sourceText);
}

module.exports = {
    analyzeStructure,
    mergeAiDecisions,
    sanitizeStructure,
};
