// ======================================================
// Image Helpers
// ======================================================
// getOutputPath and escapeRegExp imported from shared utils/string-utils.

const { getOutputPath, escapeRegExp } = require('../utils/string-utils');
// cyr-latin-map moved into @animastor/editor (Phase 4 physical move) —
// this remains the canonical import for host image-domain consumers.
const { CYR_LATIN_MAP, cyrToLatin } = require('@animastor/editor/cyr-latin-map.js');

const logPrefix = '[IMAGE]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

function error(msg) {
    console.error(`${logPrefix} ❌ ${msg}`);
}

function cleanJoin(parts) {
    return parts.filter(Boolean).join(", ");
}

function isPlaceholder(text) {
    return /unspecified|not specified|unknown|tbd|to be determined|as described/i.test(text);
}

const TYPOGRAPHY_STYLES = new Set(['soviet_book_page', 'book_style', 'typography_only', 'chapter_title', 'cover']);

function isTypographyStyle(style) {
    if (!style) return false;
    return TYPOGRAPHY_STYLES.has(style.toLowerCase().replace(/[\s_-]+/g, '_'));
}

const UNSAFE_CHARACTER_ALIAS_WORDS = new Set([
    'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'from', 'with', 'and', 'or',
    'by', 'for', 'near', 'inside', 'left', 'right', 'center',
    'v', 'vo', 'na', 'u', 'iz', 's', 'so', 'k', 'ko', 'ot', 'pod', 'pri', 'za',
    'po', 'i',
    'man', 'woman', 'person', 'people', 'human', 'citizen', 'stranger',
    'male', 'female', 'boy', 'girl', 'child', 'children', 'crowd',
    'muzhchina', 'zhenshchina', 'chelovek', 'lyudi', 'grazhdanin',
    'grazhdanka', 'neznakomets', 'neznakomka', 'malchik', 'devochka',
    'rebenok', 'tolpa',
]);

function isSafeCharacterAlias(alias) {
    const norm = cyrToLatin(String(alias || '').toLowerCase())
        .replace(/[^a-z0-9]+/g, '');
    return norm.length >= 3 && !UNSAFE_CHARACTER_ALIAS_WORDS.has(norm);
}

/**
 * Normalize a string for comparison: lowercase, transliterate Cyrillic to Latin,
 * replace underscores/hyphens with spaces, strip punctuation.
 */
function normalizeForMatch(text) {
    if (!text) return '';
    let result = text.toLowerCase().trim();
    result = result.split('').map(ch => CYR_LATIN_MAP[ch] || ch).join('');
    result = result.replace(/[_\-]+/g, ' ');
    result = result.replace(/[^a-z0-9\s]/g, '');
    result = result.replace(/\s+/g, ' ').trim();
    return result;
}

/**
 * Compute word overlap score between two normalized strings.
 */
function wordOverlapScore(sourceWords, candidateWords) {
    if (!candidateWords.length) return 0;
    let matched = 0;
    for (const cw of candidateWords) {
        if (cw.length < 3) continue;
        if (sourceWords.includes(cw)) {
            matched++;
        } else if (cw.length >= 4) {
            const hasPrefix = sourceWords.some(sw =>
                sw.length >= 4 &&
                (sw.startsWith(cw.slice(0, 4)) || cw.startsWith(sw.slice(0, 4)))
            );
            if (hasPrefix) matched += 0.5;
        }
    }
    return matched / candidateWords.length;
}

const GENERIC_WORDS = new Set([
    'on', 'ona', 'ono', 'oni', 'yego', 'yeyo', 'ikh', 'yemu', 'yey', 'nim',
    'muzhchina', 'zhenshchina', 'chelovek', 'lyudi', 'tolpa',
    'gospodin', 'gospozha', 'tovarishch', 'grazhdanin',
    'kto-to', 'nekto', 'kto-nibud', 'vse',
    'он', 'она', 'оно', 'они', 'его', 'её', 'их', 'ему', 'ей', 'ним',
    'мужчина', 'женщина', 'человек', 'люди', 'толпа',
    'господин', 'госпожа', 'товарищ', 'гражданин',
    'кто-то', 'некто', 'кто-нибудь', 'все',
]);

const UNSAFE_MENTION_TYPES = new Set(['pronoun', 'unknown']);

const PREVIEW_WIDTH = 240;

module.exports = {
    log, warn, error,
    getOutputPath,
    cleanJoin,
    isPlaceholder,
    isTypographyStyle,
    escapeRegExp,
    CYR_LATIN_MAP,
    cyrToLatin,
    isSafeCharacterAlias,
    normalizeForMatch,
    wordOverlapScore,
    GENERIC_WORDS,
    UNSAFE_MENTION_TYPES,
    PREVIEW_WIDTH,
};
