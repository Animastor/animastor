// ======================================================
// Prompt Dependency Registry
// ======================================================
// Central registry of all data sources used by
// buildImagePrompt() and buildCharacters() in image-service.js.
//
// Every field that contributes to the Final Image Prompt
// is annotated here with:
//   scope   — how to find affected scenes (scene|cross)
//   layers  — which generation layers become dirty
//   extract — how to get the value for comparison
//
// This is the SINGLE SOURCE OF TRUTH for what changes
// trigger regeneration. If buildImagePrompt() starts
// reading a new field, add it here — diffScene and
// computeBookDiff will pick it up automatically.
//
// Usage:
//   const registry = require('./prompt-dependency-registry');
//   const dirty = registry.computeSceneDirtyLayers(oldScene, newScene);
//
// ======================================================

// ── Deep equality helper (not using lodash to keep it zero-dep) ──
function isEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== typeof b) return false;
    if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') return a === b;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!isEqual(a[i], b[i])) return false;
        }
        return true;
    }
    if (typeof a === 'object') {
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length) return false;
        for (const key of keysA) {
            if (!isEqual(a[key], b[key])) return false;
        }
        return true;
    }
    return a === b;
}

// ======================================================
// REGISTRY: Scene-level fields
// ======================================================
// These fields live inside a scene payload (oldScene vs newScene).
// diffScene() iterates over this list to determine dirty layers.
// ======================================================

const SCENE_FIELDS = [
    // ── Audio ─────────────────────────────────────
    // full_text is the SceneText. When it changes, ALL layers are dirty
    // because the visual context (derived from SceneText) also changed.
    {
        key: 'audio.full_text',
        layers: ['audio'],
        // SceneText changed → visual content also needs regeneration
        cascadingLayers: ['image', 'video'],
        extract: (scene) => scene?.audio?.full_text,
        label: 'Full scene text (TTS source)',
        usedBy: 'buildImagePrompt → audio.full_text',
    },
    // voice change affects ONLY audio — video is mute, no dependency
    {
        key: 'audio.voice',
        layers: ['audio'],
        extract: (scene) => scene?.audio?.voice,
        label: 'Voice settings (model, pitch, speed)',
        usedBy: 'buildImagePrompt → audio.voice',
    },

    // ── Scene-level visual style ──────────────────
    // scene.visual.style is used as a global style fallback
    // for all units when unit.visual.style is not set
    {
        key: 'scene.visual.style',
        layers: ['image', 'video'],
        extract: (scene) => scene?.visual?.style,
        label: 'Scene-level visual style fallback',
        usedBy: 'buildImagePrompt → scene.visual.style',
    },
    {
        key: 'scene.visual.lighting',
        layers: ['image', 'video'],
        extract: (scene) => scene?.visual?.lighting,
        label: 'Scene-level lighting instruction',
        usedBy: 'buildImagePrompt → scene.visual.lighting',
    },
    {
        key: 'scene.visual.quality',
        layers: ['image', 'video'],
        extract: (scene) => scene?.visual?.quality,
        label: 'Scene-level image quality',
        usedBy: 'buildImagePrompt → scene.visual.quality',
    },
    {
        key: 'scene.visual.render',
        layers: ['image', 'video'],
        extract: (scene) => scene?.visual?.render,
        label: 'Scene-level render mode override',
        usedBy: 'buildImagePrompt → renderMode',
    },

    // ── Scene location & participants ─────────────
    // location.id determines which bible.locations entry is used
    // participants determines which character passports are injected
    {
        key: 'scene.location',
        layers: ['image', 'video'],
        extract: (scene) => scene?.location,
        label: 'Scene location reference (→ bible.json)',
        usedBy: 'buildImagePrompt → bible.locations[locationId]',
    },
    {
        key: 'scene.participants',
        layers: ['image', 'video'],
        extract: (scene) => scene?.participants,
        label: 'Scene-level character participants',
        usedBy: 'buildCharacters → book.characters[id].passport',
    },

    // ── Scene style ───────────────────────────────
    {
        key: 'scene.style',
        layers: ['image', 'video'],
        extract: (scene) => scene?.style,
        label: 'Scene narrative style',
        usedBy: 'buildImagePrompt → scene.style',
    },

    // ── Scene character state ─────────────────────
    // scene.state[charId] is used as character state override
    // in buildCharacters() — affects the passport text
    {
        key: 'scene.state',
        layers: ['image', 'video'],
        extract: (scene) => scene?.state,
        label: 'Per-scene character state overrides',
        usedBy: 'buildCharacters → resolveState()',
    },
];

// ======================================================
// REGISTRY: Cross-cutting fields
// ======================================================
// These fields live outside individual scenes (characters.json,
// bible.json) and affect ALL scenes that reference the entity.
// computeBookDiff() uses this list for entity-level comparison.
// ======================================================

const CROSS_FIELDS = [
    // ── Character passport ─────────────────────────
    // passport.base_appearance, detailed_appearance,
    // clothing_base, clothing_details → ALL merged into
    // "consistent character appearance: ..." in prompt
    {
        key: 'characters.passport',
        layers: ['image', 'video'],
        entitySource: (book) => book.characters || [],
        entityId: (char) => char.id,
        isChanged: (oldEntity, newEntity) => {
            // Compare passport fields only (not voice, not metadata)
            return !isEqual(
                extractPassport(oldEntity),
                extractPassport(newEntity)
            );
        },
        findAffectedScenes: (allScenes, entityId) => {
            return allScenes.filter(s => sceneReferencesCharacter(s, entityId));
        },
        label: 'Character passport (appearance, clothing)',
        usedBy: 'buildCharacters → resolvePassport()',
    },
    // ── Character voice ───────────────────────────
    // voice settings affect TTS only — no visual impact
    {
        key: 'characters.voice',
        layers: ['audio'],
        entitySource: (book) => book.characters || [],
        entityId: (char) => char.id,
        isChanged: (oldEntity, newEntity) => {
            return !isEqual(oldEntity?.voice, newEntity?.voice);
        },
        findAffectedScenes: (allScenes, entityId) => {
            return allScenes.filter(s => sceneReferencesCharacter(s, entityId));
        },
        label: 'Character voice settings (TTS)',
        usedBy: 'audio-service → character voice mapping',
    },
    // Note: No 'characters.any' catch-all — passport and voice
    // entries above cover all generation-relevant character fields.
    // Passport changes → image+video; voice changes → audio.
    // Other fields (name, role, metadata) don't affect generation.
    // ── Location from bible.json ──────────────────
    // bible.locations[locId].visual_style + description
    // are injected into the final prompt
    {
        key: 'bible.locations',
        layers: ['image', 'video'],
        entitySource: (book) => {
            const locs = book?.locations || {};
            return Object.entries(locs).map(([id, data]) => ({ id, ...data }));
        },
        entityId: (loc) => loc.id,
        isChanged: (oldEntity, newEntity) => !isEqual(oldEntity, newEntity),
        findAffectedScenes: (allScenes, entityId) => {
            return allScenes.filter(s => s.location && s.location.id === entityId);
        },
        label: 'Location description + visual style (bible.json)',
        usedBy: 'buildImagePrompt → bible.locations[locationId]',
    },
];

// ======================================================
// HELPERS
// ======================================================

/**
 * Extract passport fields from a character entity.
 */
function extractPassport(char) {
    if (!char) return null;
    const p = char.passport || {};
    return {
        base_appearance: p.base_appearance,
        detailed_appearance: p.detailed_appearance,
        clothing_base: p.clothing_base,
        clothing_details: p.clothing_details,
    };
}

/**
 * Check if a scene entry references a character at scene or unit level.
 * @param {Object} sceneEntry - Runtime scene entry from collectScenes()
 * @param {string} characterId
 * @returns {boolean}
 */
function sceneReferencesCharacter(sceneEntry, characterId) {
    if (!sceneEntry) return false;
    // unit.participants removed — only scene-level participants are used
    if (sceneEntry.participants && sceneEntry.participants.includes(characterId)) return true;
    return false;
}

// ======================================================
// PUBLIC API
// ======================================================

/**
 * Compute dirty layers by comparing old and new scene payloads.
 * Iterates over all SCENE_FIELDS and returns the merged set of
 * dirty layers, plus a changes map.
 *
 * @param {Object} oldScene - Old scene payload
 * @param {Object} newScene - New scene payload
 * @returns {{ dirtyLayers: string[], changes: Object }}
 */
function computeSceneDirtyLayers(oldScene, newScene) {
    const dirtyLayers = [];
    const changes = {};

    // ── Units comparison (special: aggregates units + dialogue_blocks) ──
    const oldUnits = (oldScene?.units || []).concat(
        (oldScene?.dialogue_blocks || []).flatMap(db => db.units || [])
    );
    const newUnits = (newScene?.units || []).concat(
        (newScene?.dialogue_blocks || []).flatMap(db => db.units || [])
    );
    if (!isEqual(oldUnits, newUnits)) {
        const unitChanges = { audio: false, image: false, video: false };
        const changedUnitIds = [];

        // Build ID-based maps for field-level comparison
        const oldMap = new Map();
        for (const u of oldUnits) {
            if (u && u.id != null) oldMap.set(String(u.id), u);
        }
        const newMap = new Map();
        for (const u of newUnits) {
            if (u && u.id != null) newMap.set(String(u.id), u);
        }

        // If units are anonymous (no IDs), we can't do field-level matching.
        // Conservatively regenerate all layers.
        const oldHasIds = oldUnits.some(u => u && u.id != null);
        const newHasIds = newUnits.some(u => u && u.id != null);
        if (!oldHasIds || !newHasIds) {
            unitChanges.audio = true;
            unitChanges.image = true;
            unitChanges.video = true;
        } else {
            // Field-level analysis: determine WHICH layers are affected by unit changes.
            // Only mark a layer dirty if its specific fields actually changed.

            // Check unit order changes (sequence matters for both audio and visual context)
            const oldIds = oldUnits.filter(u => u && u.id != null).map(u => String(u.id));
            const newIds = newUnits.filter(u => u && u.id != null).map(u => String(u.id));
            const orderChanged = !isEqual(oldIds, newIds);
            if (orderChanged) {
                unitChanges.audio = true;
                unitChanges.image = true;
                unitChanges.video = true;
            }

            // New units (added) — affect all layers
            for (const u of newUnits) {
                if (u && u.id != null && !oldMap.has(String(u.id))) {
                    unitChanges.audio = true;
                    unitChanges.image = true;
                    unitChanges.video = true;
                    changedUnitIds.push(String(u.id));
                }
            }

            // Removed units — affect all layers
            for (const u of oldUnits) {
                if (u && u.id != null && !newMap.has(String(u.id))) {
                    unitChanges.audio = true;
                    unitChanges.image = true;
                    unitChanges.video = true;
                }
            }

            // Changed units — field-level analysis per unit
            for (const u of newUnits) {
                if (u && u.id != null) {
                    const oldU = oldMap.get(String(u.id));
                    if (!oldU || isEqual(oldU, u)) continue;

                    changedUnitIds.push(String(u.id));

                    // content / text / audio changed → audio only
                    if (!isEqual(oldU.content, u.content) || !isEqual(oldU.text, u.text) || !isEqual(oldU.audio, u.audio)) {
                        unitChanges.audio = true;
                    }

                    // type changed (narration ↔ dialogue) → audio only
                    if (!isEqual(oldU.type, u.type)) {
                        unitChanges.audio = true;
                    }

                    // visual or image changed → image + video (video depends on images)
                    if (!isEqual(oldU.visual, u.visual) || !isEqual(oldU.image, u.image)) {
                        unitChanges.image = true;
                        unitChanges.video = true;
                    }

                    // video.action changed → video only (no image regen needed)
                    if (!isEqual(oldU.video, u.video)) {
                        unitChanges.video = true;
                    }

                    // Unknown fields — conservative, mark all layers
                    const knownUnitKeys = new Set(['id', 'type', 'content', 'text', 'visual', 'audio', 'image', 'video']);
                    for (const key of Object.keys(u)) {
                        if (knownUnitKeys.has(key)) continue;
                        if (!isEqual(oldU[key], u[key])) {
                            unitChanges.audio = true;
                            unitChanges.image = true;
                            unitChanges.video = true;
                            break;
                        }
                    }
                }
            }
        }

        // Apply collected layer changes
        for (const [layer, dirty] of Object.entries(unitChanges)) {
            if (dirty && !dirtyLayers.includes(layer)) {
                dirtyLayers.push(layer);
            }
        }

        changes.units = {
            old_count: oldUnits.length,
            new_count: newUnits.length,
            unit_ids: changedUnitIds,
        };
    }

    // ── Scene fields comparison ──
    for (const field of SCENE_FIELDS) {
        const oldVal = field.extract(oldScene);
        const newVal = field.extract(newScene);
        if (!isEqual(oldVal, newVal)) {
            // Push primary layers
            for (const layer of field.layers) {
                if (!dirtyLayers.includes(layer)) dirtyLayers.push(layer);
            }
            // Push cascading layers (e.g. full_text → image+video)
            if (field.cascadingLayers) {
                for (const layer of field.cascadingLayers) {
                    if (!dirtyLayers.includes(layer)) dirtyLayers.push(layer);
                }
            }
            // Track change details
            const changeKey = field.key.replace(/\./g, '_');
            changes[changeKey] = { changed: true };
        }
    }

    return {
        dirtyLayers: [...new Set(dirtyLayers)],
        changes: Object.keys(changes).length > 0 ? changes : null,
    };
}

/**
 * Get all scene-level fields for a given layer.
 * Used by dependency-graph.js to describe layer dependencies.
 *
 * @param {string} layer - 'audio' | 'image' | 'video'
 * @returns {Array} Fields that can make this layer dirty
 */
function getFieldsForLayer(layer) {
    const result = [];
    for (const field of SCENE_FIELDS) {
        if (field.layers.includes(layer) || (field.cascadingLayers && field.cascadingLayers.includes(layer))) {
            result.push(field);
        }
    }
    return result;
}

/**
 * Get cross-cutting fields for entity-level comparison.
 *
 * @returns {Array}
 */
function getCrossFields() {
    return CROSS_FIELDS;
}

/**
 * Get the dependency graph mapping layer → [affected layers].
 * Derived from SCENE_FIELDS + known pipeline (image→video).
 *
 * @returns {Object}
 */
function getLayerDependencies() {
    return {
        image: {
            label: 'Image / IU',
            // Image layer is triggered by scene fields AND
            // causes video regeneration (pipeline dependency)
            regenerate: ['image', 'video'],
            triggeredBy: SCENE_FIELDS
                .filter(f => f.layers.includes('image') || (f.cascadingLayers && f.cascadingLayers.includes('image')))
                .map(f => f.key),
        },
        audio: {
            label: 'Audio',
            regenerate: ['audio'],
            triggeredBy: SCENE_FIELDS
                .filter(f => f.layers.includes('audio'))
                .map(f => f.key),
        },
        video: {
            label: 'Video',
            regenerate: ['video'],
            // Video triggered by image/unit changes, NOT by audio
            triggeredBy: SCENE_FIELDS
                .filter(f => f.layers.includes('video') || (f.cascadingLayers && f.cascadingLayers.includes('video')))
                .filter(f => !f.key.startsWith('audio.'))  // audio changes don't trigger video
                .map(f => f.key),
        },
    };
}

module.exports = {
    // Registry data
    SCENE_FIELDS,
    CROSS_FIELDS,

    // Helpers
    computeSceneDirtyLayers,
    getFieldsForLayer,
    getCrossFields,
    getLayerDependencies,
    sceneReferencesCharacter,

    // Exposed for testing
    isEqual,
    extractPassport,
};
