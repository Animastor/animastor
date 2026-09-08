// ======================================================
// Language Detector Service — programmatic detection of the SOURCE language
// ======================================================
// Rule (docs task): `book.json.language` = language of the source text.
//   - If the field is already set explicitly — never overwrite it automatically.
//   - If it is empty — detect programmatically from the raw TXT, right after the
//     file is read and BEFORE any scene/agent generation starts:
//         TXT → language detection → book.json → pipeline
//   - If detection fails / confidence is low / text is too short — fall back to
//     'en'. The old hardcoded 'ru' default is REMOVED project-wide (a Cyrillic
//     text may equally be Russian, Ukrainian, Bulgarian, Serbian...).
//
// Detector: tinyld (pure JS, zero dependencies, CommonJS, ISO 639-1 codes,
// 62 languages). No LLM/agent is used for ordinary detection — it would add
// cost and latency for a task a deterministic library solves reliably.
//
// Future-proofing: `language` stays the SOURCE language; a future
// "translate to another language" feature will add a separate concept
// (output/generation language) without repurposing this field.

const { detectAll } = require('tinyld');

// First ~5k chars of the narrative are more than enough for reliable detection.
const SAMPLE_CHARS = 5000;
// Below this top-1 accuracy the result is treated as unknown → fallback 'en'.
// Measured on real-length samples: ru ≈ 0.84, en ≈ 0.94, de ≈ 0.93, bg ≈ 0.72.
const MIN_CONFIDENCE = 0.5;
// Short texts (< this many chars) yield low absolute accuracy even when the
// top-1 language is correct (e.g. 'Привет, как дела?' → ru at 0.23) — for them
// the top-1 is accepted when it clearly beats the runner-up (margin rule).
const SHORT_TEXT_CHARS = 300;
const SHORT_TEXT_MARGIN = 1.5;
const FALLBACK_LANG = 'en';

// Boilerplate headers that must not skew the sample (Gutenberg / Flibusta-style
// export preambles). Skipped line-by-line until the first real content line.
const BOILERPLATE_RE = [
    /^the project gutenberg ebook/i,
    /^project gutenberg/i,
    /^this ebook is for the use of anyone/i,
    /^most other parts of the world/i,
    /^you may copy it/i,
    /^copyright/i,
    /^produced by/i,
    /^title:/i,
    /^author:/i,
    /^release date:/i,
    /^language:/i,
    /^издано на флибусте/i,
    /^флибуста/i,
    /^lib\.rus\.ec/i,
];
// Gutenberg-style content delimiter — everything before it is preamble.
const CONTENT_MARKER_RE = /^\*{3,}\s*(start|end)\s+of/i;

/**
 * Extract a clean detection sample: strip BOM, leading blank lines and
 * boilerplate headers, then take the first SAMPLE_CHARS of real content.
 * @param {string|null|undefined} text
 * @returns {string}
 */
function extractSample(text) {
    if (!text || typeof text !== 'string') return '';
    const body = text.replace(/^\uFEFF/, '').trimStart();
    const lines = body.split('\n');

    // 1. Skip everything before the Gutenberg content delimiter
    //    ("*** START OF THE PROJECT GUTENBERG EBOOK ... ***") when present.
    let start = 0;
    for (let i = 0; i < Math.min(lines.length, 60); i++) {
        if (CONTENT_MARKER_RE.test(lines[i].trim())) {
            start = i + 1;
            break;
        }
    }

    // 2. Skip remaining boilerplate/blank header lines until real content.
    const tail = lines.slice(start);
    let tailStart = 0;
    for (let i = 0; i < Math.min(tail.length, 40); i++) {
        const line = tail[i].trim();
        if (!line) { tailStart = i + 1; continue; }
        if (BOILERPLATE_RE.some(re => re.test(line))) { tailStart = i + 1; continue; }
        break;
    }

    return tail.slice(tailStart).join('\n').slice(0, SAMPLE_CHARS);
}

/**
 * Decide whether the top-1 detection is reliable enough to write into book.json.
 * Long samples: absolute confidence threshold. Short samples: top-1 must clearly
 * beat the runner-up (tinyld's absolute accuracy is low for short texts even
 * when the top-1 language is correct).
 */
function isReliableResult(results, sampleLen) {
    const top = results && results[0];
    if (!top || !top.lang || typeof top.accuracy !== 'number') return false;
    if (sampleLen < SHORT_TEXT_CHARS) {
        const second = results[1];
        // A lone candidate (e.g. symbol-only input ranking 'en' with no
        // runner-up) is safe to accept: it resolves to FALLBACK_LANG anyway.
        if (!second || typeof second.accuracy !== 'number') return true;
        return top.accuracy >= second.accuracy * SHORT_TEXT_MARGIN;
    }
    return top.accuracy >= MIN_CONFIDENCE;
}

/**
 * Programmatic detection with confidence. Returns null when the text is empty,
 * the detector fails, or the top-1 accuracy is below MIN_CONFIDENCE.
 * @param {string|null|undefined} text - raw source text of the book
 * @returns {{code: string, confidence: number}|null} ISO 639-1 code
 */
function detectLanguageWithConfidence(text) {
    const sample = extractSample(text);
    if (!sample.trim()) return null;
    try {
        const results = detectAll(sample);
        const top = results && results[0];
        if (!top || !top.lang || typeof top.accuracy !== 'number') return null;
        if (!isReliableResult(results, sample.length)) return null;
        return { code: top.lang, confidence: top.accuracy };
    } catch (err) {
        console.warn(`[LANG-DETECT] detector failed: ${err.message}`);
        return null;
    }
}

/**
 * Detect the source language of a book text. Never returns null — unknown or
 * undetectable input falls back to 'en' (never 'ru').
 * @param {string|null|undefined} text
 * @returns {string} ISO 639-1 language code
 */
function detectLanguage(text) {
    const result = detectLanguageWithConfidence(text);
    return result ? result.code : FALLBACK_LANG;
}

module.exports = {
    detectLanguage,
    detectLanguageWithConfidence,
    extractSample,
    SAMPLE_CHARS,
    MIN_CONFIDENCE,
    FALLBACK_LANG,
};
