// ======================================================
// O-2 PORT: PersistencePort — runtime/orchestration persistence contract
// ======================================================
// The runtime and orchestration tiers must not know the persistence
// implementation. Every PG table, SQL string, repository module and the
// storage barrel stay HOST-side (backend/src/storage/**); the tiers consume
// persistence ONLY through this port, wired by the composition root
// (backend.cjs) at startup.
//
//   runtime/** + orchestration/**        (tier consumers)
//       ↓ consume state operations through
//   runtime/persistence-port             ← THIS PORT (tier-owned contract)
//       ↑ wired by the host
//   storage/runtime-persistence-adapter  (host PG/Redis adapter)
//
// This is the S-6 port convention (ports/generation-config.js): a
// zero-require contract module, a fail-fast call-time resolver, one
// set/wired/reset surface. No pg types, no SQL, no repository names and no
// "future CRUD" cross the boundary — the contract below is EXACTLY the set
// of persistence operations the two tiers use today (measured at §32.9):
//
//   tasks            — task-status completion + orphan-task checks
//                      (runtime-scheduler, reconciliation-engine); createTask
//                      is a routes-side concern and stays there
//   sceneAssets      — per-asset status truth + version gates + dirty
//                      units (orchestrator completeStage version gate,
//                      scene-orchestrator dirty reads, scene-window
//                      staleness, scene-callbacks markReady/dirty clears,
//                      scene-restoration, reconciliation rebuildWorkList);
//                      markStale is consumed by state/scene-state-ops
//                      (outside the two tiers) and stays a direct repo call
//   iu               — image-unit rows (scene-callbacks audio timing
//                      recalculation)
//   cancel           — generation cancellation tombstones
//                      (reconciliation-engine orphan/repair legs)
//   sceneVersions    — the two scenes-table version reads every tier does
//                      (scene-window, scene-restoration, orchestrator
//                      version gate, reconciliation rebuildWorkList)
//   registry         — Redis asset-registry reads/writes
//                      (reconciliation repair legs, scene-callbacks
//                      completion handlers)
//   filesystem       — canonical scene audio path composition
//                      (reconciliation orphan check, scene-callbacks
//                      audio handler)
//   listBooks         — distinct book identities from persistent truth
//                      (reconciliation rebuildWorkList)
//   (getDirtyMarkers is the two-row-set read the worklist rebuild issues:
//   unit-dirty scenes + per-asset stale/failed/pending markers)
//
// Deliberately NOT in the port: transactions, the pool, query handles,
// CRUD "for later". The host adapter owns every SQL string and every table.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.9
// ======================================================

const OPS = [
    'tasks.updateTaskStatus',
    'tasks.hasActiveTaskForScene',

    'sceneAssets.getAsset',
    'sceneAssets.markReady',
    'sceneAssets.getDirtyUnitIds',
    'sceneAssets.setDirtyUnitIds',
    'sceneAssets.clearDirtyUnitIds',
    'sceneAssets.clearDirtyFlag',
    'sceneAssets.getDirtyScenesByVersion',
    'sceneAssets.getDirtyMarkers',

    'iu.getImageUnitsForScene',
    'iu.upsertImageUnit',

    'cancel.isCancelled',
    'cancel.getAllCancelled',

    'sceneVersions.getSceneVersions',
    'sceneVersions.getAudioConfigVersions',
    'sceneVersions.getVersionStalenessRows',

    'registry.getSceneAssetsRedis',
    'registry.registerSceneAudioRedis',
    'registry.registerSceneImageRedis',
    'registry.registerSceneVideoRedis',

    'filesystem.getSceneAudioPath',

    'listBooks',
];

let impl = null;

/**
 * Wire the host persistence adapter. Called once by the composition root
 * (backend.cjs) BEFORE any runtime/orchestration persistence consumer runs.
 * @param {object} adapter — nested namespaces (tasks/sceneAssets/iu/cancel/
 *   sceneVersions/registry/filesystem) + the top-level listBooks function;
 *   every dotted op in OPS must resolve to a function.
 */
function setPersistencePort(adapter) {
    if (!adapter) {
        throw new Error('persistence-port: adapter is required');
    }
    for (const op of OPS) {
        if (typeof resolveOp(adapter, op) !== 'function') {
            throw new Error(`persistence-port: adapter must implement ${op}()`);
        }
    }
    impl = adapter;
}

/** Resolve the port at CALL time — fail-fast when unwired. */
function persistence() {
    if (!impl) {
        throw new Error(
            'persistence-port: not wired — the composition root must call ' +
            'setPersistencePort(adapter) (storage/runtime-persistence-adapter) ' +
            'before runtime/orchestration persistence consumers run (O-2)'
        );
    }
    return impl;
}

/** Dotted-path resolver over the nested adapter namespaces. */
function resolveOp(adapter, op) {
    let node = adapter;
    for (const part of op.split('.')) {
        node = node?.[part];
        if (node === undefined) return undefined;
    }
    return node;
}

/**
 * Shorthand op resolver: `persist('sceneAssets.getAsset')(...)`.
 * Fails fast when the port or the single op is missing — an op silently
 * degrading to a no-op would corrupt persistence semantics.
 * @param {string} op — dotted op name from OPS
 */
function persist(op) {
    const fn = resolveOp(persistence(), op);
    if (typeof fn !== 'function') {
        throw new Error(`persistence-port: op '${op}' is not wired (O-2)`);
    }
    return fn;
}

function isPersistencePortWired() {
    return impl !== null;
}

/** Test hygiene: drop the wiring (mocha hooks). */
function _resetPersistencePort() {
    impl = null;
}

module.exports = {
    OPS,
    setPersistencePort,
    persistence,
    persist,
    isPersistencePortWired,
    _resetPersistencePort,
};
