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

module.exports = { setDeep, findUnitInScene };
