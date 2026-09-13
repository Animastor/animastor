// ======================================================
// O-5 PORT: ProgressEventsPort — runtime/orchestration
// progress-observer contract
// ======================================================
// The runtime and orchestration tiers must not know the progress host
// services. The Redis pub/sub channel bytes (`animastor:progress:*`), the
// task-registry hash key namespace (`animastor:generation-progress:*`),
// their TTLs and their retention rules stay HOST-side
// (backend/src/services/progress-pubsub.cjs, backend/src/services/
// generation-progress.js); the tiers consume progress ONLY through this
// port, wired by the composition root (backend.cjs) at startup.
//
//   runtime/** + orchestration/**        (tier consumers)
//       ↓ consume progress ops through
//   runtime/progress-events-port.js      ← THIS PORT (tier-owned contract)
//       ↑ wired by the host
//   storage/progress-events-adapter      (host progress adapter)
//
// This is the O-2/O-3/O-4 port convention (runtime/persistence-port.js,
// runtime/scene-data-port.js, runtime/placeholder-audio-port.js): a
// zero-require contract module, a fail-fast call-time resolver, one
// set/wired/reset surface. No Redis key strings, no pub/sub transport, no
// TTL arithmetic, no SSE knowledge and no "future ops" cross the boundary
// — the contract below is EXACTLY the set of progress operations the two
// tiers use today (measured at O-5 reconnaissance, §32.7 O-P4):
//
//   publishProgress        — best-effort per-book progress event (layer
//                           advance / generation_complete) consumed by the
//                           SSE poller (scene-callbacks ×5 call sites)
//   getSceneTaskState     — per-scene selective-task read: which worker
//                           types a task-managed scene must run
//                           (runtime-scheduler shouldScheduleAssets +
//                           markVersionStaleDirty)
//   hasActiveTasks        — does the book still have an active
//                           generation task (scene-window
//                           trySlideWindowOnComplete task_managed gate)
//   reconcileCompletedTasks — mark task records completed once every
//                           target asset is ready (runtime-scheduler tick
//                           pre-pass; the getAssetStates callback arrives
//                           as an argument exactly as pre-O-5)
//
// Deliberately NOT in the port: createTasks/listTasks/getTask/updateTask/
// markCompleted/markCancelled/removeTask/clear (routes-side task CRUD —
// the HTTP contour owns task lifecycle), getActiveTasksByType,
// reconcileCompletedTasks' siblings and any CRUD "for later". The host
// adapter owns every Redis key, every TTL and the pub/sub channel.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.7 (O-P4, O-5 DONE)
// ======================================================

const OPS = [
    'publishProgress',
    'getSceneTaskState',
    'hasActiveTasks',
    'reconcileCompletedTasks',
];

let impl = null;

/**
 * Wire the host progress-events adapter. Called once by the composition
 * root (backend.cjs) BEFORE any runtime/orchestration progress consumer
 * runs.
 * @param {object} adapter — flat map with every op in OPS as a function.
 */
function setProgressEventsPort(adapter) {
    if (!adapter) {
        throw new Error('progress-events-port: adapter is required');
    }
    for (const op of OPS) {
        if (typeof adapter[op] !== 'function') {
            throw new Error(`progress-events-port: adapter must implement ${op}()`);
        }
    }
    impl = adapter;
}

/** Resolve the port at CALL time — fail-fast when unwired. */
function progressEvents() {
    if (!impl) {
        throw new Error(
            'progress-events-port: not wired — the composition root must call ' +
            'setProgressEventsPort(adapter) (storage/progress-events-adapter) ' +
            'before runtime/orchestration progress consumers run (O-5)'
        );
    }
    return impl;
}

/**
 * Shorthand op resolver: `progressEventsOp('publishProgress')(...)`.
 * Fails fast when the port or the single op is missing — a progress event
 * or task read silently degrading to a no-op would corrupt window-slide
 * and dispatch decisions.
 * @param {string} op — op name from OPS
 */
function progressEventsOp(op) {
    const fn = impl?.[op];
    if (typeof fn !== 'function') {
        throw new Error(`progress-events-port: op '${op}' is not wired (O-5)`);
    }
    return fn;
}

function isProgressEventsPortWired() {
    return impl !== null;
}

/** Test hygiene: drop the wiring (mocha hooks). */
function _resetProgressEventsPort() {
    impl = null;
}

module.exports = {
    OPS,
    setProgressEventsPort,
    progressEvents,
    progressEventsOp,
    isProgressEventsPortWired,
    _resetProgressEventsPort,
};
