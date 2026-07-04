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
    const merged = [...(existingCharacters || [])];
    let added = 0;
    let enriched = 0;
    let skippedGeneric = 0;

    for (const character of (newCharacters || [])) {
        if (!character || (!character.id && !character.name)) continue;
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
    findCanonicalCharacter,
    mergeCharacterData,
    mergeCharacterLists,
};
