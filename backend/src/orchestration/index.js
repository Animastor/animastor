// ======================================================
// Orchestration Module - v1.0.0
// ======================================================

// Existing contract: orchestration.dispatchStage / handle*Completed
// are consumed by dispatch-engine.js (require('../orchestration')).
// We preserve those exports and add the new Orchestrator facade alongside,
// so callers can migrate to orchestration.orchestrator.* incrementally
// without breaking the existing surface (Шаг 0, docs-claude/03_Orchestrator.md).
const sceneOrchestrator = require('./scene-orchestrator');

module.exports = {
    ...sceneOrchestrator,
    orchestrator: require('./orchestrator'),
};
