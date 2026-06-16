// ======================================================
// Dependency Graph — Asset Layer Dependencies
// ======================================================
// Defines what depends on what during selective regeneration.
//
// Structure:
//   layer → { regenerate: [affected layers], invalidates: [chunks/state keys] }
//
// When a layer changes, all layers in its "regenerate" array
// must also be regenerated due to data dependencies.

const DEPENDENCY_GRAPH = {
    // IU (image unit) visual changes → image + video must be regenerated
    image: {
        label: 'Image / IU',
        regenerate: ['image', 'video'],
        invalidates: ['scene_image', 'scene_video'],
        description: 'IU prompt, visual config, location, participants → regen image + video'
    },
    // Audio text/voice changes → audio + video must be regenerated
    audio: {
        label: 'Audio',
        regenerate: ['audio', 'video'],
        invalidates: ['scene_audio', 'scene_video'],
        description: 'full_text, voice → regen audio + video'
    },
    // Video-only changes (timing, transitions) → only video
    video: {
        label: 'Video',
        regenerate: ['video'],
        invalidates: ['scene_video'],
        description: 'timing, transitions → regen video only'
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
