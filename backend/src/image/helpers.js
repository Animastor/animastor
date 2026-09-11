// ======================================================
// Image Helpers — image-media-only helpers (S-4)
// ======================================================
// S-4: the media-agnostic text/alias normalizers (isSafeCharacterAlias,
// normalizeForMatch, wordOverlapScore, GENERIC_WORDS, UNSAFE_MENTION_TYPES,
// replaceAliasWithCharacterId) and the character-reference resolvers
// (normalizeCharacterRefs, buildCharacterAliases, buildSafeAliasIndex) moved
// to the Generation prompt-profiles layer:
//   generation/prompt-profiles/prompt-text-utils.js  (pure normalizers)
//   generation/prompt-profiles/character-utils.js    (coreference resolvers)
// This module keeps ONLY image-media helpers (logging, typography, preview
// constants) and delegates the relocated surface for compatibility.
//
// getOutputPath and escapeRegExp imported from shared utils/string-utils.

const { getOutputPath, escapeRegExp } = require('../utils/string-utils');
// Phase 4.1: the cyr-latin map no longer comes from the @animastor/editor
// package (host must not deep-import package internals — package root only).
// The Editor keeps its own canonical copy; this host leg is a byte-parity
// twin (guarded by editor-package-boundary.test.js PB5), restored at the
// pre-move host location.
const { CYR_LATIN_MAP, cyrToLatin } = require('../utils/cyr-latin-map');
// S-4: canonical implementations live in the generation prompt-profiles layer.
const textUtils = require('@animastor/generation').promptProfiles.promptTextUtils;
const characterUtils = require('@animastor/generation').promptProfiles.characterUtils;

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
    PREVIEW_WIDTH,

    // S-4 relocated (delegating shims — public surface unchanged)
    isSafeCharacterAlias: textUtils.isSafeCharacterAlias,
    normalizeForMatch: textUtils.normalizeForMatch,
    wordOverlapScore: textUtils.wordOverlapScore,
    GENERIC_WORDS: textUtils.GENERIC_WORDS,
    UNSAFE_MENTION_TYPES: textUtils.UNSAFE_MENTION_TYPES,
    replaceAliasWithCharacterId: characterUtils.replaceAliasWithCharacterId,
    buildCharacterAliases: characterUtils.buildCharacterAliases,
    normalizeCharacterRefs: characterUtils.normalizeCharacterRefs,
    buildSafeAliasIndex: characterUtils.buildSafeAliasIndex,
};
