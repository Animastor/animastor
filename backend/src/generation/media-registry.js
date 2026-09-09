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
// COVERAGE — where media-type knowledge is centralized (S-2 completion):
//   state/scene-state.js         ASSETS — lazy view over registry
//   services/generation-progress.js  WORKER_TYPES — registry (no fallback)
//   runtime/gpu-dispatcher.js     validTypes → hasMediaType, DEFAULT_TYPE_TIMEOUT_MS → resolveJobTimeout
//   runtime/dispatch-engine.js    LEASE_TTLS/QUOTAS — lazy views over registry
//   runtime/lease-manager.js      LEASE_TOTAL_TTLS — lazy view over registry
//   runtime/retry-budget-manager.js  PER_SCENE_LIMITS — registry resolver
//   runtime/circuit-breaker.js    SERVICE_TARGETS media entries — registry
//   runtime/runtime-scheduler.js  STATE_TO_STAGE/STAGE_TO_STATE, layer defaults
//   runtime/reconciliation-engine.js / counter-reconciliation.js / runtime-persistence.js
//                                stage lists — registry
//   runtime/runtime-metrics.js    quotas — registry (stale {3,2,1} duplicate removed)
//   metrics/prometheus.js         QUOTA_MAX/LEASE_TTLS/STAGES — registry
//                                (stale {3,2,1}/{15,20,30} duplicates removed)
//   storage worker-repo.js        WORKER_TYPES — registry
//   services/provider-gateway.js GENERATION_JOB_TYPES — registry
//   services/book-diff.cjs / book-sync.js / entity-cleanup.cjs — registry
//   orchestration/orchestrator.js  stage lists, fail-event map — registry
//   routes/book/generation-routes.cjs  validWorkerTypes — registry (no fallback)
//
// DELIBERATELY LOCAL (media implementation knowledge, documented in
// docs/architecture/generation-module-extraction-reconnaissance.md §22):
//   orchestration/scene-orchestrator.js  per-media executors (audio/image/video)
//   orchestration/scene-callbacks.js     per-media completion handlers
//   orchestration/event-journal.js        per-media event types (workflow contract)
//   runtime/runtime-scheduler.js          video→image dependency chain, per-type branching
//   dispatch-engine.js                    image IU in-flight markers
//   routes/connector-routes.cjs           connector profiles (outside generation contour, S2-E)
//   routes/worker-setup-routes.cjs        worker setup profiles (outside contour)
//   config/runtime-config.js              WORKER_HEARTBEAT_TYPES (infra constant;
//                                        consistency guarded by S2-G, not registry-owned)
//   packages/animastor-contracts           Job Protocol JOB_TYPES incl. iu_image (frozen, S-3 boundary)

const logPrefix = '[MEDIA-REGISTRY]';
function log(msg) { console.log(`${logPrefix} ${msg}`); }

// ======================================================
// REGISTRY STATE
// ======================================================

/** @type {Map<string, MediaCapability>} */
const registry = new Map();

// ======================================================
// SELF-BOOTSTRAP (S-2 completion)
// ======================================================
// backend.cjs populates the registry at startup (require of
// default-registrations). But runtime modules are also loaded directly by
// tests — possibly BEFORE any explicit registration. To make the registry
// order-independent, the first access to an empty registry lazily loads the
// default registrations. _clearRegistry() (test hook) suppresses re-bootstrap
// so tests keep full control over registry contents.

let bootstrapped = false;

function _ensureBootstrapped() {
    if (bootstrapped || registry.size > 0) return;
    bootstrapped = true;
    try {
        // Module cache makes this idempotent for the startup require.
        require('./default-registrations');
    } catch (err) {
        console.error(`${logPrefix} bootstrap failed: ${err.message}`);
    }
}

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
    bootstrapped = true;
}

/**
 * Get a media type capability by name.
 * @param {string} mediaType
 * @returns {MediaCapability | undefined}
 */
function getMediaType(mediaType) {
    _ensureBootstrapped();
    return registry.get(mediaType);
}

/**
 * Check if a media type is registered.
 * @param {string} mediaType
 * @returns {boolean}
 */
function hasMediaType(mediaType) {
    _ensureBootstrapped();
    return registry.has(mediaType);
}

/**
 * List all registered media types.
 * @returns {string[]}
 */
function listMediaTypes() {
    _ensureBootstrapped();
    return [...registry.keys()];
}

/**
 * Get all registered capabilities.
 * @returns {MediaCapability[]}
 */
function listCapabilities() {
    _ensureBootstrapped();
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
    _ensureBootstrapped();
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
    _ensureBootstrapped();
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
    _ensureBootstrapped();
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

/** Clear all registrations (test isolation). Suppresses lazy re-bootstrap. */
function _clearRegistry() {
    registry.clear();
    bootstrapped = true;
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
