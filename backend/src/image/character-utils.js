// ======================================================
// Image Character Utilities
// ======================================================
// Character reference normalization, alias building, prompt-based character inference.

const helpers = require('./helpers');

function replaceAliasWithCharacterId(text, alias, characterId) {
    const re = new RegExp('(?<![\\p{L}\\p{N}_])' + helpers.escapeRegExp(alias) + '(?![\\p{L}\\p{N}_])', 'giu');
    return text.replace(re, characterId);
}

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
            if (helpers.isSafeCharacterAlias(w)) {
                aliases.add(w);
                const latin = helpers.cyrToLatin(w)
                    .replace(/yy$/i, 'y')
                    .replace(/yi$/i, 'y');
                if (latin !== w && helpers.isSafeCharacterAlias(latin)) aliases.add(latin);
            }
        }
    }
    for (const w of (c.name || '').split(/[\s,()]+/).filter(Boolean)) {
        if (helpers.isSafeCharacterAlias(w)) {
            aliases.add(w);
            const latin = helpers.cyrToLatin(w)
                .replace(/yy$/i, 'y')
                .replace(/yi$/i, 'y');
            if (latin !== w && helpers.isSafeCharacterAlias(latin)) aliases.add(latin);
        }
    }
    return [...aliases].sort((a, b) => b.length - a.length);
}

function normalizeCharacterRefs(text, characters, aliasIndex) {
    if (!text) return text;

    if (aliasIndex && typeof aliasIndex === 'object' && Object.keys(aliasIndex).length > 0) {
        let result = text;
        for (const [alias, charId] of Object.entries(aliasIndex)) {
            if (!helpers.isSafeCharacterAlias(alias)) continue;
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
    return result;
}

/**
 * Build character passport strings by scanning the direct prompt for character_ids
 * when scene/unit participants is empty.
 */
function inferCharactersFromPrompt(directPrompt, book, contextInfo) {
    if (!directPrompt || !book?.characters?.length) return [];
    helpers.warn(`[COREFERENCE] inferCharactersFromPrompt fallback used${contextInfo ? ' (' + contextInfo + ')' : ''}`);
    const matched = [];
    const promptL = directPrompt.toLowerCase();
    const normalizedPrompt = helpers.normalizeForMatch(directPrompt);
    const promptTokens = normalizedPrompt.split(/\s+/).filter(Boolean);

    for (const c of book.characters) {
        let found = false;

        const separators = '[-_]';
        const idParts = c.id.split(/[_]+/);
        const pattern = idParts.join(separators);
        const boundary = '[\\s.,;!?"\'\\`()\\[\\]{}]';
        const re = new RegExp('(?:^|' + boundary + ')' + pattern + '(?=$|' + boundary + ')', 'i');
        if (re.test(promptL)) found = true;

        if (!found && c.name) {
            const nameLower = c.name.toLowerCase();
            const nameNorm = helpers.normalizeForMatch(c.name);
            if (nameLower.length >= 3) {
                const nameRe = new RegExp('(?<!\\w)' + nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\w)', 'i');
                if (nameRe.test(promptL)) found = true;
            }
            if (!found) {
                const nameTokens = nameNorm.split(/\s+/).filter(Boolean);
                for (const nt of nameTokens) {
                    if (nt.length < 3) continue;
                    if (promptTokens.includes(nt)) { found = true; break; }
                    if (nt.length >= 4 && promptTokens.some(pt =>
                        pt.startsWith(nt.slice(0, 4)) || nt.startsWith(pt.slice(0, 4))
                    )) { found = true; break; }
                }
            }
        }

        if (!found) {
            const idPartsSet = new Set(c.id.split(/[_]+/).filter(p => p.length >= 3));
            if (idPartsSet.size > 0) {
                for (const token of promptTokens) {
                    const tokenParts = token.split(/[-_]+/);
                    if (tokenParts.some(tp => idPartsSet.has(tp))) {
                        found = true;
                        break;
                    }
                }
            }
        }

        if (found) {
            matched.push(c);
        }
    }

    const deduped = [];
    const contained = new Set();
    for (let i = 0; i < matched.length; i++) {
        for (let j = 0; j < matched.length; j++) {
            if (i === j) continue;
            const aTokens = new Set(matched[i].id.split('_'));
            const bTokens = new Set(matched[j].id.split('_'));
            if (bTokens.size < aTokens.size && [...bTokens].every(t => aTokens.has(t))) {
                contained.add(j);
            }
        }
    }
    for (let i = 0; i < matched.length; i++) {
        if (!contained.has(i)) deduped.push(matched[i]);
    }

    return deduped;
}

/**
 * Build a safe alias index from character_mentions rows.
 */
function buildSafeAliasIndex(characterMentions) {
    if (!Array.isArray(characterMentions) || characterMentions.length === 0) return {};

    const aliasMap = new Map();
    const collisions = new Set();

    for (const m of characterMentions) {
        if (helpers.UNSAFE_MENTION_TYPES.has(m.mention_type)) continue;
        const norm = m.mention_norm || helpers.normalizeForMatch(m.mention_text || '');
        if (!norm || norm.length < 2) continue;
        if (helpers.GENERIC_WORDS.has(norm)) continue;
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
    inferCharactersFromPrompt,
    buildSafeAliasIndex,
};
