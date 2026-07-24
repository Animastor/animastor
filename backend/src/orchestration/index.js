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
const sceneOrchestrator = require('./scene-orchestrator');
const orchestratorFacade = require('./orchestrator');

module.exports = {
    ...sceneOrchestrator,
    ...orchestratorFacade,
    orchestrator: orchestratorFacade,
};
