// ======================================================
// Media Registry — S-2 Registry-ization seam
// ======================================================
// Internal registry for Generation media-type capabilities.
// Centralizes the hardcoded audio/image/video branching that
// was previously scattered across runtime, orchestration, and
// route modules.
//
// S-2 DESIGN PRINCIPLES:
//   - Registry is a THIN capability description, not a dispatcher
//   - Production behavior is unchanged
//   - HTTP API is unchanged
//   - Redis keys are unchanged
//   - FSM is unchanged
//   - Task types are unchanged
//   - Workers/GPU Hub/ComfyUI are untouched
//
// COVERAGE — where media-type knowledge is now centralized:
//   state/scene-state.js         ASSETS array (line 12)
//   generation-progress.js       WORKER_TYPES set (line 12)
//   gpu-dispatcher.js            validTypes (line 139), DEFAULT_TYPE_TIMEOUT_MS
//   dispatch-engine.js           LEASE_TTLS, QUOTAS keys
//   retry-budget-manager.js      PER_SCENE_LIMITS
//   circuit-breaker.js           SERVICE_TARGETS
//   runtime-config.js            QUOTAS, LEASE_TTL_S, WORKER_HEARTBEAT_TYPES
//   routes/book/generation-routes.cjs  validWorkerTypes, layer-config fields
//   orchestration/scene-orchestrator.js dispatch branching
//   orchestration/orchestrator.js       stage handler/fail maps
//   orchestration/event-journal.js      per-type event types
//   orchestration/scene-callbacks.js    Stage constants
//   runtime/runtime-scheduler.js        shouldScheduleAssets branching

const logPrefix = '[MEDIA-REGISTRY]';
function log(msg) { console.log(`${logPrefix} ${msg}`); }

// ======================================================
// REGISTRY STATE
// ======================================================

/** @type {Map<string, MediaCapability>} */
const registry = new Map();

// ======================================================
// MEDIA CAPABILITY CONTRACT
// ======================================================

/**
 * @typedef {object} MediaCapability
 * @property {string} mediaType — canonical name ('audio', 'image', 'video')
 * @property {string[]} taskTypes — valid task type strings for this media
 * @property {object} timeout — per-type timeout defaults
 * @property {number} timeout.jobMs — default GPU job timeout (ms)
 * @property {number} timeout.leaseTtlS — dispatch lease TTL (seconds)
 * @property {object} quota — concurrent execution limits
 * @property {number} quota.maxActive — max concurrent active jobs
 * @property {object} retry — retry budget per (scene, stage)
 * @property {number} retry.perSceneLimit — max retries per scene
 * @property {object} circuit — circuit breaker config (service target name)
 * @property {string} circuit.serviceName — circuit breaker target key
 * @property {object} stuck — stuck detection thresholds (minutes)
 * @property {number} stuck.generatingMinutes — GENERATING→stale threshold
 * @property {number} stuck.pendingMinutes — PENDING→stale threshold
 * @property {object} progress — progress counting strategy
 * @property {string} progress.strategy — 'chunk' | 'iu' | 'scene'
 * @property {object} cancel — cancellation behavior
 * @property {string[]} cancel.clearsStages — stages cleared on cancel of this type
 * @property {object} artifact — artifact naming conventions
 * @property {string} artifact.suffix — file suffix pattern
 */

// ======================================================
// CORE API
// ======================================================

/**
 * Register a media type capability.
 * @param {MediaCapability} capability
 */
function registerMediaType(capability) {
    if (!capability || !capability.mediaType) {
        throw new Error('registerMediaType: mediaType is required');
    }
    if (registry.has(capability.mediaType)) {
        log(`WARNING: overwriting existing registration for '${capability.mediaType}'`);
    }
    registry.set(capability.mediaType, capability);
    log(`Registered: ${capability.mediaType} (taskTypes=${JSON.stringify(capability.taskTypes)}, timeout=${capability.timeout?.jobMs}ms)`);
}

/**
 * Get a media type capability by name.
 * @param {string} mediaType
 * @returns {MediaCapability | undefined}
 */
function getMediaType(mediaType) {
    return registry.get(mediaType);
}

/**
 * Check if a media type is registered.
 * @param {string} mediaType
 * @returns {boolean}
 */
function hasMediaType(mediaType) {
    return registry.has(mediaType);
}

/**
 * List all registered media types.
 * @returns {string[]}
 */
function listMediaTypes() {
    return [...registry.keys()];
}

/**
 * Get all registered capabilities.
 * @returns {MediaCapability[]}
 */
function listCapabilities() {
    return [...registry.values()];
}

// ======================================================
// RESOLVER HELPERS
// ======================================================

/**
 * Resolve the set of valid worker/task types from all registered media types.
 * Replaces hardcoded: new Set(['audio', 'image', 'video'])
 * @returns {Set<string>}
 */
function resolveValidWorkerTypes() {
    const types = new Set();
    for (const cap of registry.values()) {
        for (const t of cap.taskTypes) {
            types.add(t);
        }
    }
    return types;
}

/**
 * Resolve the ASSETS array (used by state/scene-state.js).
 * Replaces hardcoded: ['audio', 'image', 'video']
 * @returns {string[]}
 */
function resolveAssets() {
    return [...registry.keys()];
}

/**
 * Resolve default job timeout for a media type.
 * @param {string} mediaType
 * @param {number} [fallback] — fallback if type not found
 * @returns {number | undefined}
 */
function resolveJobTimeout(mediaType, fallback) {
    const cap = registry.get(mediaType);
    return cap?.timeout?.jobMs ?? fallback;
}

/**
 * Resolve default lease TTL for a media type.
 * @param {string} mediaType
 * @param {number} [fallback]
 * @returns {number | undefined}
 */
function resolveLeaseTtl(mediaType, fallback) {
    const cap = registry.get(mediaType);
    return cap?.timeout?.leaseTtlS ?? fallback;
}

/**
 * Resolve max active quota for a media type.
 * @param {string} mediaType
 * @param {number} [fallback]
 * @returns {number | undefined}
 */
function resolveMaxActive(mediaType, fallback) {
    const cap = registry.get(mediaType);
    return cap?.quota?.maxActive ?? fallback;
}

/**
 * Resolve retry budget per scene for a media type.
 * @param {string} mediaType
 * @param {number} [fallback]
 * @returns {number | undefined}
 */
function resolveRetryBudget(mediaType, fallback) {
    const cap = registry.get(mediaType);
    return cap?.retry?.perSceneLimit ?? fallback;
}

/**
 * Resolve circuit breaker service name for a media type.
 * @param {string} mediaType
 * @returns {string | undefined}
 */
function resolveCircuitService(mediaType) {
    const cap = registry.get(mediaType);
    return cap?.circuit?.serviceName;
}

/**
 * Resolve stuck detection thresholds for a media type.
 * @param {string} mediaType
 * @returns {{ generatingMinutes: number, pendingMinutes: number } | undefined}
 */
function resolveStuckThresholds(mediaType) {
    const cap = registry.get(mediaType);
    return cap?.stuck;
}

/**
 * Resolve the progress counting strategy for a media type.
 * @param {string} mediaType
 * @returns {{ strategy: string } | undefined}
 */
function resolveProgressStrategy(mediaType) {
    const cap = registry.get(mediaType);
    return cap?.progress;
}

/**
 * Resolve which stages are cleared when cancelling this media type.
 * @param {string} mediaType
 * @returns {string[]}
 */
function resolveCancelStages(mediaType) {
    const cap = registry.get(mediaType);
    return cap?.cancel?.clearsStages || [mediaType];
}

/**
 * Validate that a worker type string is registered.
 * @param {string} workerType
 * @returns {boolean}
 */
function isValidWorkerType(workerType) {
    return registry.has(workerType);
}

/**
 * Get the layer-config key name for a media type.
 * Convention: {mediaType}_enabled
 * @param {string} mediaType
 * @returns {string}
 */
function layerConfigKey(mediaType) {
    return `${mediaType}_enabled`;
}

/**
 * Get the timeout config key name for a media type.
 * Convention: {mediaType}_timeout_minutes
 * @param {string} mediaType
 * @returns {string}
 */
function timeoutConfigKey(mediaType) {
    return `${mediaType}_timeout_minutes`;
}

// ======================================================
// TEST HOOKS
// ======================================================

/** Clear all registrations (test isolation). */
function _clearRegistry() {
    registry.clear();
}

/** Get raw registry (test inspection). */
function _getRegistry() {
    return registry;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Core API
    registerMediaType,
    getMediaType,
    hasMediaType,
    listMediaTypes,
    listCapabilities,

    // Resolvers
    resolveValidWorkerTypes,
    resolveAssets,
    resolveJobTimeout,
    resolveLeaseTtl,
    resolveMaxActive,
    resolveRetryBudget,
    resolveCircuitService,
    resolveStuckThresholds,
    resolveProgressStrategy,
    resolveCancelStages,

    // Validators
    isValidWorkerType,

    // Convention helpers
    layerConfigKey,
    timeoutConfigKey,

    // Test hooks
    _clearRegistry,
    _getRegistry,
};
