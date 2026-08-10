const CYR_LATIN_MAP = {
    'А':'A','а':'a','Б':'B','б':'b','В':'V','в':'v','Г':'G','г':'g','Д':'D','д':'d',
    'Е':'Ye','е':'e','Ё':'Yo','ё':'yo','Ж':'Zh','ж':'zh','З':'Z','з':'z','И':'I','и':'i',
    'Й':'Y','й':'y','К':'K','к':'k','Л':'L','л':'l','М':'M','м':'m','Н':'N','н':'n',
    'О':'O','о':'o','П':'P','п':'p','Р':'R','р':'r','С':'S','с':'s','Т':'T','т':'t',
    'У':'U','у':'u','Ф':'F','ф':'f','Х':'Kh','х':'kh','Ц':'Ts','ц':'ts','Ч':'Ch','ч':'ch',
    'Ш':'Sh','ш':'sh','Щ':'Shch','щ':'shch','Ъ':'','ъ':'','Ы':'Y','ы':'y','Ь':'','ь':'',
    'Э':'E','э':'e','Ю':'Yu','ю':'yu','Я':'Ya','я':'ya',
};

const GENERIC_CHARACTER_WORDS = new Set([
    'man', 'woman', 'person', 'people', 'human', 'citizen', 'stranger',
    'male', 'female', 'boy', 'girl', 'child', 'children', 'crowd',
    'muzhchina', 'zhenshchina', 'chelovek', 'lyudi', 'grazhdanin',
    'grazhdanka', 'neznakomets', 'neznakomka', 'malchik', 'devochka',
    'rebenok', 'tolpa',
]);

const CONNECTOR_WORDS = new Set([
    'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'from', 'with',
    'and', 'or', 'by', 'for', 'near', 'inside',
    'v', 'vo', 'na', 'u', 'iz', 's', 'so', 'k', 'ko', 'ot', 'pod',
    'pri', 'za', 'po', 'i',
]);

function normalizeForMatch(text) {
    if (!text) return '';
    let result = String(text).toLowerCase().trim();
    result = result.split('').map(ch => CYR_LATIN_MAP[ch] || ch).join('');
    result = result.replace(/[_\-]+/g, ' ');
    result = result.replace(/[^a-z0-9\s]/g, '');
    result = result.replace(/\s+/g, ' ').trim();
    return result;
}

function meaningfulTokensFromText(text) {
    return normalizeForMatch(text)
        .split(/\s+/)
        .filter(Boolean)
        .filter(t => t.length >= 3)
        .filter(t => !GENERIC_CHARACTER_WORDS.has(t))
        .filter(t => !CONNECTOR_WORDS.has(t));
}

function allIdentityTexts(character) {
    if (!character) return [];
    return [
        character.id,
        character.name,
        character.alias,
        ...(Array.isArray(character.aliases) ? character.aliases : []),
    ].filter(Boolean);
}

function characterTokens(character) {
    const tokens = new Set();
    for (const text of allIdentityTexts(character)) {
        for (const token of meaningfulTokensFromText(text)) {
            tokens.add(token);
        }
    }
    return tokens;
}

function hasDistinctiveOverlap(aTokens, bTokens) {
    for (const token of aTokens) {
        if (token.length >= 5 && bTokens.has(token)) return true;
    }
    return false;
}

function isSubset(small, large) {
    if (small.size === 0 || large.size === 0) return false;
    for (const token of small) {
        if (!large.has(token)) return false;
    }
    return true;
}

function isGenericCharacter(character) {
    const texts = allIdentityTexts(character);
    if (texts.length === 0) return false;

    const rawTokens = texts
        .flatMap(t => normalizeForMatch(t).split(/\s+/).filter(Boolean))
        .filter(t => t.length >= 3)
        .filter(t => !CONNECTOR_WORDS.has(t));

    if (rawTokens.length === 0) return false;
    const meaningful = rawTokens.filter(t => !GENERIC_CHARACTER_WORDS.has(t));
    return meaningful.length === 0 && rawTokens.some(t => GENERIC_CHARACTER_WORDS.has(t));
}

// ── Placeholder ids ───────────────────────────────────────────────────
// Ids/names that mean "no information about this person" ("unknown",
// "unnamed", "Unidentified", "неизвестный"). They are NEVER real characters:
// absence of information ≠ a fictitious 'unknown' character. A placeholder
// would otherwise leak into scene.participants and be treated as a real
// on-screen person. Normalized comparison (Cyrillic→Latin, punctuation
// stripped) so 'Unidentified' and 'неизвестный' are both caught.
// NOTE: entries are LOWERCASED NORMALIZED forms — normalizeForMatch turns
// underscores into spaces AND transliterates Cyrillic with UPPERCASE map
// values ('й' → 'Y'), so every candidate is lowercased before the lookup
// ('not_named' matches via 'not named', 'неизвестный' via 'neizvestnyy').
const PLACEHOLDER_CHARACTER_IDS = new Set([
    'unknown', 'unnamed', 'unidentified', 'not named', 'no name',
    'unspecified', 'not specified', 'not identified', 'unidentified character',
    'neizvestnyy', 'neizvesten', 'bezymyannyy', // неизвестный / безымянный
]);

function isPlaceholderCharacterId(value) {
    const norm = normalizeForMatch(value);
    return !!norm && PLACEHOLDER_CHARACTER_IDS.has(norm.toLowerCase());
}

// Tokens that carry NO visual information about a person when they are the
// only "description" left: explicit no-info markers (unknown, unidentified,
// …), meta-words (character, story, described) and their Russian
// transliterations. A REAL appearance must leave at least one token outside
// this set. Token-based (not substring regex): "tall man, age unknown" keeps
// 'tall' and is a real appearance; "Unidentified character" / "не описан"
// leaves nothing meaningful and is a placeholder.
const NO_INFORMATION_TOKENS = new Set([
    'unknown', 'unidentified', 'unnamed', 'unclear', 'unspecified',
    'character', 'story', 'described', 'description', 'descr',
    'information', 'appearance', 'period', 'appropriate', 'age', 'net',
    // Russian (transliterated): неизвестный / безымянный / описан / не указан /
    // персонаж / внешность / возраст / нет описания
    'neizvestnyy', 'neizvesten', 'neizvestno', 'bezymyannyy', 'opisan',
    'opisana', 'opisaniya', 'ukazan', 'ukazana', 'personazh', 'vneshnost',
    'vozrast',
]);

/**
 * Does the character carry a REAL appearance/description? Looks at the WHOLE
 * aggregate (passport.appearance / appearance / clothes / description), not at
 * the name alone. Empty or placeholder-only boilerplate ("as described in the
 * story", "Unidentified character", "не описан") means there is no actual
 * info about how the person looks — absence of information, not a real
 * description. A single meaningful visual token ("седой", "tall man, age
 * unknown") makes it real.
 * @param {object} character
 * @returns {boolean}
 */
function hasRealAppearance(character) {
    if (!character) return false;
    const app = (character.passport?.appearance || character.appearance || character.clothes || character.description || '').trim();
    if (!app) return false;
    const tokens = meaningfulTokensFromText(app).filter(t => !NO_INFORMATION_TOKENS.has(t));
    return tokens.length > 0;
}

/**
 * Is this a fictitious placeholder character ('unknown', 'unnamed', …)?
 * Requires BOTH a placeholder id/name AND the absence of a real appearance:
 * a character named "Неизвестный" (the mysterious stranger) WITH a described
 * appearance is a REAL character and must survive — only a placeholder name
 * with NO information is a phantom. Absence of information ≠ fictitious
 * character.
 * @param {object|null} character
 * @returns {boolean}
 */
function isPlaceholderCharacter(character) {
    if (!character) return true;
    const placeholderName = isPlaceholderCharacterId(character.id) || isPlaceholderCharacterId(character.name);
    if (!placeholderName) return false;
    return !hasRealAppearance(character);
}

function findCanonicalCharacter(character, existingCharacters) {
    if (!character || !Array.isArray(existingCharacters) || existingCharacters.length === 0) {
        return null;
    }

    if (character.id) {
        const exact = existingCharacters.find(c => c.id === character.id);
        if (exact) return exact;
    }

    if (isGenericCharacter(character)) return null;

    const incomingTokens = characterTokens(character);
    if (incomingTokens.size === 0) return null;

    const candidates = [];
    for (const existing of existingCharacters) {
        if (isGenericCharacter(existing)) continue;

        const existingTokens = characterTokens(existing);
        if (existingTokens.size === 0) continue;

        const clearAlias =
            (isSubset(incomingTokens, existingTokens) || isSubset(existingTokens, incomingTokens)) &&
            hasDistinctiveOverlap(incomingTokens, existingTokens);

        if (clearAlias) candidates.push(existing);
    }

    return candidates.length === 1 ? candidates[0] : null;
}

function mergeCharacterData(existing, incoming) {
    if (!existing || !incoming) return existing || incoming;
    const merged = { ...existing };

    for (const key of ['description', 'appearance']) {
        const oldValue = existing[key] || '';
        const newValue = incoming[key] || '';
        if (newValue && !oldValue.includes(newValue)) {
            merged[key] = oldValue
                ? `${oldValue} ${newValue}`
                : newValue;
        }
    }

    if (Array.isArray(incoming.traits)) {
        const traits = new Set(existing.traits || []);
        for (const trait of incoming.traits) {
            if (trait) traits.add(trait);
        }
        merged.traits = [...traits];
    }

    if (incoming.voice && (!existing.voice || String(incoming.voice).length > String(existing.voice).length)) {
        merged.voice = incoming.voice;
    }

    if (!merged.role && incoming.role) merged.role = incoming.role;
    if (!merged.name && incoming.name) merged.name = incoming.name;

    return merged;
}

function mergeCharacterLists(existingCharacters, newCharacters, { skipGeneric = true } = {}) {
    // Load-time placeholder filter on the EXISTING set too: a legacy
    // 'unknown'/'unnamed' that older code once wrote into characters.json has
    // no real information and must never stay in the registry or leak into
    // scene.participants. A character with a REAL appearance keeps its id even
    // when it looks like a placeholder word ('neizvestnyy' — the mysterious
    // stranger is a real literary character). One guard, all callers.
    const merged = (existingCharacters || []).filter(c => !isPlaceholderCharacter(c));
    let added = 0;
    let enriched = 0;
    let skippedGeneric = 0;

    for (const character of (newCharacters || [])) {
        if (!character || (!character.id && !character.name)) continue;
        // Placeholders ('unknown', 'unnamed', …) are NEVER real characters —
        // absent information about a person ≠ a fictitious 'unknown' character.
        // Dropped unconditionally (no 'skipGeneric' flag): a placeholder must
        // never enter characters.json or leak into scene.participants.
        if (isPlaceholderCharacter(character)) {
            continue;
        }
        if (skipGeneric && isGenericCharacter(character)) {
            skippedGeneric++;
            continue;
        }

        const canonical = findCanonicalCharacter(character, merged);
        if (canonical) {
            if (canonical.id === character.id) {
                const idx = merged.findIndex(c => c.id === canonical.id);
                merged[idx] = mergeCharacterData(merged[idx], character);
            }
            enriched++;
            continue;
        }

        if (character.id && merged.some(c => c.id === character.id)) {
            const idx = merged.findIndex(c => c.id === character.id);
            merged[idx] = mergeCharacterData(merged[idx], character);
            enriched++;
            continue;
        }

        merged.push(character);
        added++;
    }

    return { characters: merged, added, enriched, skippedGeneric };
}

module.exports = {
    normalizeForMatch,
    isGenericCharacter,
    isPlaceholderCharacterId,
    isPlaceholderCharacter,
    PLACEHOLDER_CHARACTER_IDS,
    findCanonicalCharacter,
    mergeCharacterData,
    mergeCharacterLists,
};
