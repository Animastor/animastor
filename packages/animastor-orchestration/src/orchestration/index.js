// ======================================================
// Orchestration Module - v2.0.0
// ======================================================

// Existing contract: orchestration.dispatchStage / handle*Completed
// are consumed by dispatch-engine.js (require('../orchestration')).
// We preserve those exports and add the new Orchestrator facade alongside,
// so callers can migrate to orchestration.orchestrator.* incrementally
// without breaking the existing surface (Шаг 0, docs-claude/03_Orchestrator.md).
//
// Orchestrator facade functions (markDirtyScene, planScene, beginStage, etc.)
// are also spread to the top level so callers that receive 'orchestrator' via
// deps (reconciliation-engine, scene-asset-registry, etc.) can access them
// directly as deps.orchestrator.markDirtyScene() without the .orchestrator
// indirection. When names overlap (completeStage, failStage), the orchestrator
// facade version wins (it's the newer canonical implementation).
//
// §32.30: the FSM-writer re-exports in orchestrator.js are LAZY getters
// (they resolve the stateOps host binding on access). A literal object
// spread would fire them at require time — before the composition root
// binds host modules. Enumerate + defineProperties keeps every accessor
// lazy while preserving the exact surface and the facade-wins precedence.
const sceneOrchestrator = require('./scene-orchestrator');
const orchestratorFacade = require('./orchestrator');

const FACADE_KEYS = [
    ...new Set([...Object.keys(sceneOrchestrator), ...Object.keys(orchestratorFacade)]),
];

const LAZY_FACADE_PROPS = Object.fromEntries(FACADE_KEYS.map((key) => [key, {
    enumerable: true,
    get() {
        return key in orchestratorFacade ? orchestratorFacade[key] : sceneOrchestrator[key];
    },
}]));

module.exports = Object.defineProperties(
    { orchestrator: orchestratorFacade },
    LAZY_FACADE_PROPS,
);
