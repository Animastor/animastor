// ======================================================
// Entity ID Utilities — manual entity add (characters /
// locations / voices from the Editor).
// The transliteration itself reuses cyrToLatin from
// image/helpers.js — the project's single Cyrillic→Latin
// map — never duplicated here. This module only folds the
// transliterated text into the project's snake_case id
// standard (the same shape normalizeForMatch /
// canonicalizeMixedScriptId produce).
// ======================================================

const { cyrToLatin } = require('../image/helpers');

/** Canonical id format: lowercase latin snake (a-z, 0-9, single _ separators). */
const CANONICAL_ID_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

function isCanonicalEntityId(id) {
    return CANONICAL_ID_RE.test(String(id || ''));
}

/**
 * Normalize a user-entered entity id to the project's snake_case standard:
 *   - already canonical (latin snake) → returned unchanged;
 *   - anything else (Cyrillic, spaces, mixed case, stray punctuation) →
 *     transliterated via the existing cyrToLatin map and folded into
 *     lowercase snake_case.
 * Empty input → '' (the caller decides whether to fall back to the name).
 */
function toEntityId(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (isCanonicalEntityId(s)) return s;
    const latin = cyrToLatin(s.toLowerCase());
    return latin
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
}

module.exports = { toEntityId, isCanonicalEntityId, CANONICAL_ID_RE };
