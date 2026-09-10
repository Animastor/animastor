// ======================================================
// S-5 test helper — production seam wiring for test harnesses
// ======================================================
// Mirrors the composition-root wiring in backend.cjs: registers the REAL
// orchestration facade functions into the runtime seam registry. Use in
// before/beforeEach hooks AFTER require.cache manipulations so the resolved
// module instances match the ones the test stubbed.
//
// For stub-based harnesses (reconciliation-engine, scope-slide) register the
// stub functions directly via require('../../src/runtime/orchestration-seams')
// instead, and call clearOrchestrationSeams() in afterEach to avoid leaking
// stubs into other test files.

const seams = require('../../src/runtime/orchestration-seams');

function wireProductionSeams() {
    // The orchestration index spread captures its exports at load time —
    // earlier suites may have replaced/reloaded the facade modules, leaving a
    // stale spread (partial stubs) in cache. Purge the facade pair so the
    // seams always bind to the REAL implementations.
    delete require.cache[require.resolve('../../src/orchestration/index.js')];
    delete require.cache[require.resolve('../../src/orchestration/orchestrator.js')];
    const orchestration = require('../../src/orchestration');
    seams.registerOrchestrationSeams({
        dispatchStage: orchestration.dispatchStage,
        rollbackStageToPending: orchestration.rollbackStageToPending,
        markDirtyScene: orchestration.markDirtyScene,
        setScenePending: orchestration.setScenePending,
        setSceneAllReady: orchestration.setSceneAllReady,
        setScenePlaceholder: orchestration.setScenePlaceholder,
    });
}

module.exports = { wireProductionSeams, seams };
