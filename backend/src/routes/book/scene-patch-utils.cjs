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

// ── Audio full_text rebuild ──────────────────────────────────────────
// After a unit is added, deleted, reordered, or its text changed, the
// scene's audio.full_text must reflect the current units. For narration
// scenes the full_text IS the TTS source (buildSegments reads it
// directly); for dialogue scenes it serves as a reference/preview.
//
// This function is idempotent: calling it when full_text already matches
// is a harmless no-op.
function rebuildFullText(scene) {
    if (!scene) return;
    const units = scene.units || [];
    // Only rebuild for narration-type scenes. Dialogue scenes derive audio
    // from individual units[].audio.text — full_text is a preview, not the
    // TTS source. But we still sync it so the Audio tab shows current text.
    const isNarration = !scene.type || scene.type === 'narration'
        || scene.type === 'chapter_intro' || scene.type === 'cover'
        || scene.type === 'perception' || scene.type === 'description'
        || scene.type === 'action' || scene.type === 'transition';
    if (!isNarration) return; // dialogue scenes: full_text is preview-only, don't overwrite
    const joined = units
        .map(u => (u.text || '').trim())
        .filter(t => t.length > 0)
        .join(' ');
    if (!scene.audio) scene.audio = {};
    // Only update if the joined text differs — preserve manual edits to
    // full_text that intentionally diverge from unit texts (edge case).
    const current = (scene.audio.full_text || '').trim();
    if (joined && current !== joined) {
        scene.audio.full_text = joined;
    } else if (!joined && current) {
        // All units have empty text — clear full_text to match.
        scene.audio.full_text = '';
    }
}

module.exports = { setDeep, findUnitInScene, normalizeFieldValue, rebuildFullText };
