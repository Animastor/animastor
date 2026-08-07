// Pure helpers for the PATCH /book/:bookId/scene/:chapterId/:sceneId handler.
//
// Extracted from book-routes.cjs (Architectural Debt #3). These close over no
// request state or deps, so they live as plain exported functions.

// Set a value at a dotted path inside an object, creating intermediate objects.
function setDeep(obj, path, value) {
    const keys = path.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        if (current[keys[i]] === undefined || current[keys[i]] === null) {
            current[keys[i]] = {};
        }
        current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
}

// Normalize a dotted-path PATCH value before setDeep(). The editors (web + Android)
// render video_tokens as one comma-joined text field, but the agent scheme stores
// them as an ARRAY of features (characters.json / scene.passport). Split the string
// back into an array so the format never degrades on save. Empty string → null
// (delete field, matching the value === '' ? null pattern elsewhere).
function normalizeFieldValue(key, value) {
    if (value === '') return null;
    if (value !== null && value !== undefined
        && typeof value === 'string'
        && key.endsWith('video_tokens')) {
        const parts = value.split(',').map(s => s.trim()).filter(s => s.length > 0);
        return parts.length > 0 ? parts : null;
    }
    return value;
}

// Find a unit by id within a scene (searches scene.units and dialogue_blocks[].units).
function findUnitInScene(scene, unitId) {
    const search = (units) => {
        for (const u of units) {
            if (u && u.id === unitId) return u;
        }
        return null;
    };
    if (scene.units) {
        const found = search(scene.units);
        if (found) return found;
    }
    if (scene.dialogue_blocks) {
        for (const block of scene.dialogue_blocks) {
            if (block.units) {
                const found = search(block.units);
                if (found) return found;
            }
        }
    }
    return null;
}

module.exports = { setDeep, findUnitInScene, normalizeFieldValue };
