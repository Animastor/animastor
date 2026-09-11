// ======================================================
// Image Character Utilities — S-4 relocation
// ======================================================
// Moved from image/character-utils.js (S-4): the `normalizeCharacterRefs`
// coreference resolver is a cross-media prompt-text utility (image prompt
// builder, video workflow builder and the VBook agent pipeline all consume
// it), so it lives in the Generation prompt-profiles layer, not in the image
// media module.
//
// Character reference normalization, alias building, prompt-based character inference.

const textUtils = require('./prompt-text-utils');
const { escapeRegExp } = textUtils;
const { replaceAliasWithCharacterId } = textUtils;

function buildCharacterAliases(c) {
    const aliases = new Set();
    const idParts = (c.id || '').split('_');
    const surname = idParts[idParts.length - 1];
    if (surname && surname.length >= 3) {
        aliases.add(surname.charAt(0).toUpperCase() + surname.slice(1));
    }
    const paren = c.name?.match(/\(([^)]+)\)/);
    if (paren) {
        for (const w of paren[1].split(/[\s,]+/).filter(Boolean)) {
            if (textUtils.isSafeCharacterAlias(w)) {
                aliases.add(w);
                const latin = textUtils.cyrToLatin(w)
                    .replace(/yy$/i, 'y')
                    .replace(/yi$/i, 'y');
                if (latin !== w && textUtils.isSafeCharacterAlias(latin)) aliases.add(latin);
            }
        }
    }
    for (const w of (c.name || '').split(/[\s,()]+/).filter(Boolean)) {
        if (textUtils.isSafeCharacterAlias(w)) {
            aliases.add(w);
            const latin = textUtils.cyrToLatin(w)
                .replace(/yy$/i, 'y')
                .replace(/yi$/i, 'y');
            if (latin !== w && textUtils.isSafeCharacterAlias(latin)) aliases.add(latin);
        }
    }
    return [...aliases].sort((a, b) => b.length - a.length);
}

function normalizeCharacterRefs(text, characters, aliasIndex) {
    if (!text) return text;

    if (aliasIndex && typeof aliasIndex === 'object' && Object.keys(aliasIndex).length > 0) {
        let result = text;
        // Build extended alias index: original aliases + Latin transliterations of Cyrillic aliases
        const extended = new Map();
        for (const [alias, charId] of Object.entries(aliasIndex)) {
            if (!textUtils.isSafeCharacterAlias(alias)) continue;
            extended.set(alias.toLowerCase(), charId);
            // Add Latin transliteration (catches "bezdomny" when alias is "бездомный")
            const latin = textUtils.cyrToLatin(alias.toLowerCase())
                .replace(/yy$/i, 'y')
                .replace(/yi$/i, 'y');
            if (latin !== alias.toLowerCase() && textUtils.isSafeCharacterAlias(latin)) {
                extended.set(latin, charId);
            }
        }
        for (const [alias, charId] of extended) {
            result = replaceAliasWithCharacterId(result, alias, charId);
        }
        return result;
    }

    if (!characters?.length) return text;
    let result = text;
    for (const c of characters) {
        const aliases = buildCharacterAliases(c);
        for (const alias of aliases) {
            result = replaceAliasWithCharacterId(result, alias, c.id);
        }
    }

    // Safety net: replace snake_case tokens that contain a character_id as suffix.
    // When the AI generates "mikhail_alexandrovich_berlioz" (inventing a new ID from
    // the display name) instead of using the correct "mikhail_berlioz", this catches it.
    result = normalizeSnakeCaseSuffix(result, characters);

    return result;
}

/**
 * Replace snake_case tokens that contain a character_id as a suffix.
 * E.g. "mikhail_alexandrovich_berlioz" → "mikhail_berlioz" when character has id "mikhail_berlioz".
 */
function normalizeSnakeCaseSuffix(text, characters) {
    if (!text || !characters?.length) return text;

    // Find all snake_case tokens (words containing underscore)
    const snakeTokens = new Set();
    const tokenRe = /[a-zа-яё][a-zа-яё0-9]*_[a-zа-яё0-9_]+/gi;
    let match;
    while ((match = tokenRe.exec(text)) !== null) {
        snakeTokens.add(match[0]);
    }

    if (snakeTokens.size === 0) return text;

    let result = text;

    for (const c of characters) {
        if (!c.id) continue;
        const charId = c.id.toLowerCase();
        const idParts = charId.split('_');
        if (idParts.length < 2) continue;
        const lastPart = idParts[idParts.length - 1];
        if (lastPart.length < 3) continue;

        for (const token of snakeTokens) {
            if (token.toLowerCase() === charId) continue; // already correct
            const tokenParts = token.toLowerCase().split('_');
            if (tokenParts.length <= idParts.length) continue;

            // Check if the character_id's parts appear in order at the END of the token's parts
            // AND the last parts match
            let matchesSuffix = true;
            const tokenEnd = tokenParts.slice(-idParts.length);
            for (let i = 0; i < idParts.length; i++) {
                if (tokenEnd[i] !== idParts[i]) {
                    matchesSuffix = false;
                    break;
                }
            }

            if (matchesSuffix) {
                // Verify with word boundary: replace the whole token with character_id
                const escaped = escapeRegExp(token);
                const re = new RegExp('(?<![\\p{L}\\p{N}_])' + escaped + '(?![\\p{L}\\p{N}_])', 'gi');
                result = result.replace(re, c.id);
            }
        }
    }

    return result;
}

/**
 * Build a safe alias index from character_mentions rows.
 */
function buildSafeAliasIndex(characterMentions) {
    if (!Array.isArray(characterMentions) || characterMentions.length === 0) return {};

    const aliasMap = new Map();
    const collisions = new Set();

    for (const m of characterMentions) {
        if (textUtils.UNSAFE_MENTION_TYPES.has(m.mention_type)) continue;
        const norm = m.mention_norm || textUtils.normalizeForMatch(m.mention_text || '');
        if (!norm || norm.length < 2) continue;
        if (textUtils.GENERIC_WORDS.has(norm)) continue;
        if (!m.character_id) continue;

        const existing = aliasMap.get(norm) || new Set();
        existing.add(m.character_id);
        aliasMap.set(norm, existing);

        if (existing.size > 1) {
            collisions.add(norm);
        }
    }

    for (const alias of collisions) {
        aliasMap.delete(alias);
    }

    const result = {};
    for (const [alias, ids] of aliasMap.entries()) {
        if (ids.size === 1) {
            result[alias] = [...ids][0];
        }
    }

    return result;
}

module.exports = {
    replaceAliasWithCharacterId,
    buildCharacterAliases,
    normalizeCharacterRefs,

    buildSafeAliasIndex,
};
