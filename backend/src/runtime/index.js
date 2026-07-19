// ======================================================
// Runtime Module - v2.0.0 (slim)
// ======================================================
// Only exports modules that are actively used in the runtime pipeline.
// Speculative/over-engineered modules removed from exports (files remain on disk).
//
// Core pipeline modules:
//   scheduler + loop → tick execution
//   activeScenes → scene tracking
//   reconciliation → self-healing
//   dispatch + leaseManager → job dispatch
//   counterReconciliation + metrics → observability
//   workerHealth → worker monitoring
//   gpuDispatcher → GPU HUB communication
//   sceneWindow → scene window management
//
// Phase 8 modules (error handling):
//   failureTaxonomy, retryManager, retentionManager
//
// The following are REMOVED from runtime exports (files preserved on disk):
//   priority-manager, policy-engine, workload-classifier,
//   cost-estimator, admission-control,
//   decision-trace, feedback-engine, governance-*, adaptation-controller,
//   execution-semantics,
//   trace-compactor, invariant-engine, safe-mode,
//   state-graph/, subsystems/, policies/
//   snapshot-manager, runtime-persistence
//   policy-simulator, governance-sandbox, failure-replay,
//   governance-validator, policy-engine
//
// S1 (2026-07-19): fairness-engine removed entirely — isStarving() always
//   returned {starving:false}; Phase 9 in dispatch-engine was dead code.

const lazyRequire = (modulePath) => {
    let module = null;
    const loader = () => {
        if (!module) module = require(modulePath);
        return module;
    };
    return new Proxy(loader, {
        get(target, prop) {
            if (prop === 'then') return undefined;
            return target()[prop];
        },
        apply(target, _thisArg, args) {
            return target();
        }
    });
};

module.exports = {
    // Core runtime
    scheduler: lazyRequire('./runtime-scheduler'),
    loop: lazyRequire('./runtime-loop'),
    activeScenes: lazyRequire('./active-scenes-index'),
    reconciliation: lazyRequire('./reconciliation-engine'),
    dispatch: lazyRequire('./dispatch-engine'),
    leaseManager: lazyRequire('./lease-manager'),
    counterReconciliation: lazyRequire('./counter-reconciliation'),
    metrics: lazyRequire('./runtime-metrics'),

    // GPU & worker
    gpuDispatcher: lazyRequire('./gpu-dispatcher'),
    workerHealth: lazyRequire('./worker-health'),
    sceneWindow: lazyRequire('./scene-window'),

    // Error handling & retry
    failureTaxonomy: lazyRequire('./failure-taxonomy'),
    retryManager: lazyRequire('./retry-manager'),
    retentionManager: lazyRequire('./retention-manager'),

    // NOTE: the former `debug: { ... }` governance facade (D.3/L1) was removed —
    // its only consumer was the unreferenced src/api/runtime.js, and several of
    // its modules require()'d files that no longer exist (debug-endpoint 500s).
    // Live resilience modules: circuit-breaker, retry-budget-manager
    // require()'d directly by dispatch-engine and remain.
    // S1 (2026-07-19): fairness-engine removed — dead code (isStarving always false).
};
