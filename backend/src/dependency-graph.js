// ======================================================
// Dependency Graph — Asset Layer Dependencies
// ======================================================
// Defines what depends on what during selective regeneration.
//
// DERIVED FROM: prompt-dependency-registry.js
// The Prompt Dependency Registry is the single source of truth
// for which scene-level fields affect which generation layers.
// This file translates that into layer→layer dependencies.
//
// Structure:
//   layer → { regenerate: [affected layers], invalidates: [chunks/state keys] }
//
// When a layer changes, all layers in its "regenerate" array
// must also be regenerated due to data dependencies.

const registry = require('./services/prompt-dependency-registry');
const layerDeps = registry.getLayerDependencies();

const DEPENDENCY_GRAPH = {
    // Image layer — triggered by scene visual fields + unit changes
    // Image regeneration cascades to video (pipeline dependency)
    image: {
        label: layerDeps.image.label,
        regenerate: layerDeps.image.regenerate,
        invalidates: ['scene_image', 'scene_video'],
        description: `IU prompt, visual config, location, participants → regen image + video (${layerDeps.image.triggeredBy.length} triggers)`
    },
    // Audio layer — triggered by text/voice changes only.
    // Video is generated WITHOUT audio track (mute .mp4), so audio changes
    // do NOT cascade to video. The final Audio+Video mux happens at export time.
    audio: {
        label: layerDeps.audio.label,
        regenerate: layerDeps.audio.regenerate,
        invalidates: ['scene_audio'],
        description: `full_text, voice → regen audio only (${layerDeps.audio.triggeredBy.length} triggers, video is mute)`
    },
    // Video layer — only triggers from image cascade, NOT from audio
    video: {
        label: layerDeps.video.label,
        regenerate: layerDeps.video.regenerate,
        invalidates: ['scene_video'],
        description: `Visual changes only (${layerDeps.video.triggeredBy.length} triggers) → regen video`
    },
    // Filesystem/order changes → reindex only
    filesystem: {
        label: 'Filesystem / Order',
        regenerate: ['filesystem'],
        invalidates: ['manifest', 'cache_index'],
        description: 'scene add/remove/reorder → reindex filesystem, update manifests'
    }
};

// Reverse map: for a given affected layer, what source layers could trigger it?
const REVERSE_DEPENDENCIES = {};
for (const [layer, deps] of Object.entries(DEPENDENCY_GRAPH)) {
    for (const affected of deps.regenerate) {
        if (!REVERSE_DEPENDENCIES[affected]) REVERSE_DEPENDENCIES[affected] = [];
        REVERSE_DEPENDENCIES[affected].push(layer);
    }
}

/**
 * Resolve all layers that need regeneration given a set of dirty input layers.
 * Includes transitive dependencies.
 * Example: dirty=['image'] → resolved=['image', 'video']
 */
function resolveDirtyLayers(dirtyLayers) {
    const result = new Set();
    const queue = [...dirtyLayers];
    while (queue.length > 0) {
        const layer = queue.shift();
        if (result.has(layer)) continue;
        result.add(layer);
        const deps = DEPENDENCY_GRAPH[layer];
        if (deps) {
            for (const affected of deps.regenerate) {
                if (!result.has(affected)) queue.push(affected);
            }
        }
    }
    return [...result];
}

module.exports = {
    resolveDirtyLayers
};
