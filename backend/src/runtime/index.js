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
//   fairness-engine, priority-manager, policy-engine, workload-classifier,
//   cost-estimator, circuit-breaker, retry-budget-manager, admission-control,
//   decision-trace, feedback-engine, governance-*, adaptation-controller,
//   execution-semantics,
//   trace-compactor, invariant-engine, safe-mode,
//   state-graph/, subsystems/, policies/
//   snapshot-manager, runtime-persistence
//   policy-simulator, governance-sandbox, failure-replay,
//   governance-validator, policy-engine

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

    // DEBUG/ADMIN endpoints only — not part of core pipeline
    // These are loaded ONLY when the debug API is accessed.
    // Files are preserved on disk for git history.
    debug: {
        snapshotManager: lazyRequire('./snapshot-manager'),
        circuitBreaker: lazyRequire('./circuit-breaker'),
        priorityManager: lazyRequire('./priority-manager'),
        fairness: lazyRequire('./fairness-engine'),
        retryBudget: lazyRequire('./retry-budget-manager'),
        policyEngine: lazyRequire('./policy-engine'),
        workloadClassifier: lazyRequire('./workload-classifier'),
        costEstimator: lazyRequire('./cost-estimator'),
        decisionTrace: lazyRequire('./decision-trace'),
        feedback: lazyRequire('./feedback-engine'),
        governanceMetrics: lazyRequire('./governance-metrics'),
        adaptationController: lazyRequire('./adaptation-controller'),
        governanceStability: lazyRequire('./governance-stability'),
        governanceHealth: lazyRequire('./governance-health'),
        executionSemantics: lazyRequire('./execution-semantics'),
        experimental: {
            policySimulator: lazyRequire('./policy-simulator'),
            sandbox: lazyRequire('./governance-sandbox'),
            failureReplay: lazyRequire('./failure-replay'),
            validator: lazyRequire('./governance-validator'),
        }
    }
};
