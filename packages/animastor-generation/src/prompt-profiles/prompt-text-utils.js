// ======================================================
// Prompt Text Utilities (pure) — S-4
// ======================================================
// Zero-host-dependency text normalizers shared by the character-reference
// resolvers (character-utils.js), the image prompt builder and the VBook
// agent pipeline. Previously these lived inline in image/helpers.js; the
// canonical copies now live here (Generation prompt-profiles layer) and
// image/helpers.js delegates.
//
// This module must stay host-free (no fs, no config, no redis/pg, no media
// modules) — guarded by tests/architecture/s4-shared-infra-moves.test.js.

// Package-internal pure text primitives (S-7): cyr-latin-map and escapeRegExp
// are pure data/functions with zero host dependencies. They live inside the
// package (src/utils/) so the package has no backend require; byte parity
// with the host legs (backend/src/utils/cyr-latin-map.js, escapeRegExp in
// backend/src/utils/string-utils.js) is guarded by the G7 suite
// (tests/architecture/generation-package-boundary.test.js).

const { CYR_LATIN_MAP, cyrToLatin } = require('../utils/cyr-latin-map');
const { escapeRegExp } = require('../utils/escape-regexp');

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

function replaceAliasWithCharacterId(text, alias, characterId) {
    const re = new RegExp('(?<![\\p{L}\\p{N}_])' + escapeRegExp(alias) + '(?![\\p{L}\\p{N}_])', 'giu');
    return text.replace(re, characterId);
}

module.exports = {
    // shared text primitives (re-exported for the moved consumers)
    escapeRegExp,
    cyrToLatin,
    CYR_LATIN_MAP,

    // character alias / mention normalizers (canonical)
    UNSAFE_CHARACTER_ALIAS_WORDS,
    isSafeCharacterAlias,
    normalizeForMatch,
    wordOverlapScore,
    GENERIC_WORDS,
    UNSAFE_MENTION_TYPES,
    replaceAliasWithCharacterId,
};
