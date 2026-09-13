// ======================================================
// @animastor/orchestration — package root (public API)
// ======================================================
// The orchestration/runtime contour physically extracted from the backend
// host (§32.30; gate: §32.29 — READY FOR PHYSICAL MOVE). This root exports
// EXACTLY the measured host consumption surface — nothing "just in case":
//
//   1. The orchestration facade (former backend/src/orchestration/index.js,
//      moved verbatim) — the stage executor + FSM-safe scene writers the
//      host and the S-5 seam registry consume.
//   2. createRuntimeResultConsumer — the Phase-5 result-reporting consumer
//      the composition root registers via runtimeResultEmitter.setConsumer.
//   3. The eight O-2..O-10 port CONTRACT modules (tier-owned, moved with
//      the contour) — the host storage adapters bind these at startup.
//   4. bindHostModules / hostBinding — the composition-root binding surface
//      that wires the host-owned modules the moved files consume
//      (config/state/media/seams/artifact root/PW-2 resolver).
//
// §32.30: the facade exports are LAZY getters (the FSM-writer re-exports
// resolve the stateOps host binding on access), so the root itself builds
// its export object with defineProperties — a literal spread would fire
// those getters at require time, before the composition root binds host
// modules. The surface (names + facade-wins precedence) is unchanged.
//
// Everything else in the package (dispatch-engine, reconciliation-engine,
// scene-window, scheduler, lease/circuit/retry managers, worker-health,
// metrics) is INTERNAL: no host module and no host test may deep-import it.
//
// Dependency direction after the move (guarded by backend PM-G suite):
//   backend host → @animastor/orchestration → ports/host-bindings/contracts
// The package requires @animastor/generation (root specifier only) and
// @animastor/contracts; it never requires backend/src, storage, book,
// routes, services, Redis or PG clients.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md
//       §32.29 (frozen API) · §32.30 (physical extraction landed)

const orchestrationFacade = require('./orchestration');
const { createRuntimeResultConsumer } = require('./orchestration/runtime-result-consumer');
const hostBindings = require('./host/host-bindings');

// 1 — orchestration facade (lazy accessors over the moved facade modules)
const FACADE_KEYS = Object.keys(orchestrationFacade);
const LAZY_FACADE_PROPS = Object.fromEntries(FACADE_KEYS.map((key) => [key, {
    enumerable: true,
    get() { return orchestrationFacade[key]; },
}]));

// 2 + 3 + 4 — eager values (no binding resolution at require time)
const EAGER_EXPORTS = {
    createRuntimeResultConsumer,
    ports: {
        persistence: require('./runtime/persistence-port'),
        sceneData: require('./runtime/scene-data-port'),
        placeholderAudio: require('./runtime/placeholder-audio-port'),
        progressEvents: require('./runtime/progress-events-port'),
        audioFsm: require('./runtime/audio-fsm-port'),
        videoFsm: require('./runtime/video-fsm-port'),
        hubCancel: require('./runtime/hub-cancel-port'),
        layerConfig: require('./runtime/layer-config-port'),
    },
    bindHostModules: hostBindings.bindHostModules,
    clearHostBindings: hostBindings.clearHostBindings,
    hostBinding: hostBindings.hostBinding,
    isHostBindingWired: hostBindings.isHostBindingWired,
    lazyHostBinding: hostBindings.lazyHostBinding,
    requiredHostBindings: hostBindings.requiredHostBindings,
    BINDING_NAMES: hostBindings.BINDING_NAMES,
};

// 5 — the host-facing runtime namespace: the measured routes/services/helpers
// consumption surface (the former backend/src/runtime/index.js barrel minus
// its host-stay members loop/gpuDispatcher/retentionManager). Lazy getters —
// no eager module loads at require time.
const RUNTIME_NS = {
    scheduler: './runtime/runtime-scheduler',
    activeScenes: './runtime/active-scenes-index',
    reconciliation: './runtime/reconciliation-engine',
    dispatch: './runtime/dispatch-engine',
    leaseManager: './runtime/lease-manager',
    counterReconciliation: './runtime/counter-reconciliation',
    metrics: './runtime/runtime-metrics',
    workerHealth: './runtime/worker-health',
    sceneWindow: './runtime/scene-window',
    failureTaxonomy: './runtime/failure-taxonomy',
    runtimeResultEmitter: './runtime/runtime-result-emitter',
};
const LAZY_RUNTIME_PROPS = Object.fromEntries(Object.entries(RUNTIME_NS).map(([key, target]) => [key, {
    enumerable: true,
    get() { return require(target); },
}]));

const base = { ...EAGER_EXPORTS };
Object.defineProperties(base, LAZY_FACADE_PROPS);
Object.defineProperties(base, {
    runtime: { enumerable: true, value: Object.defineProperties({}, LAZY_RUNTIME_PROPS) },
});

module.exports = base;
