// ======================================================
// HOST ADAPTER: VideoFsmAdapter — O-8 VideoFsmPort impl
// ======================================================
// Host-side implementation of the O-8 VideoFsmPort
// (runtime/video-fsm-port.js). Owns every concrete video-FSM detail the
// runtime/orchestration tiers must not know: the `animastor:video-orch:*`
// Redis key grammar, the JSON state envelope, the valid-transition map,
// the group-file validation threshold and the merge/source-cap pipeline
// inside backend/src/services/video-orchestrator.js.
//
//   runtime/video-fsm-port           (tier-owned contract)
//       ↑ wired by backend.cjs (composition root)
//   storage/video-fsm-adapter         ← THIS FILE (host impl)
//
// Lazy call-time resolvers — never capture the module instance at load
// time. This keeps require.cache-based test stubbing working exactly as
// before (the O-2..O-7 adapter discipline): a harness that stubs
// `../src/services/video-orchestrator` and then (re)requires a tier
// consumer gets the stub through this adapter (orchestration-
// stabilization purge list).
//
// Behavior contract: every method is a 1:1 delegation to the pre-O-8 call
// — identical module, identical arguments, identical return values
// (including the { success, state, reason } transition results, the
// { completed, reason, missing } completeGroup shape and the
// { failed, missing } failWaitingScene shape) and identical error
// semantics. No video-FSM behavior changed; the service's public API is
// not extended.
//
// PHASES is passed through from the host service (the canonical owner of
// the phase vocabulary) via a lazy getter so a stubbed service's PHASES
// surface is also honored in tests.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.25 (O-8 DONE)
// ======================================================

// Lazy call-time resolver — the host FSM service channel every pre-O-8
// harness stubs (`require.resolve('../src/services/video-orchestrator')`).
const videoFsmService = () => require('../services/video-orchestrator');

function getState(redis, bookId, chapterId, sceneId) {
    return videoFsmService().getState(redis, bookId, chapterId, sceneId);
}

function initState(redis, bookId, chapterId, sceneId, buildId, groups) {
    return videoFsmService().initState(redis, bookId, chapterId, sceneId, buildId, groups);
}

function setWaitingChunks(redis, bookId, chapterId, sceneId) {
    return videoFsmService().setWaitingChunks(redis, bookId, chapterId, sceneId);
}

function setDone(redis, bookId, chapterId, sceneId) {
    return videoFsmService().setDone(redis, bookId, chapterId, sceneId);
}

function setFailed(redis, bookId, chapterId, sceneId, reason) {
    return videoFsmService().setFailed(redis, bookId, chapterId, sceneId, reason);
}

function deleteState(redis, bookId, chapterId, sceneId) {
    return videoFsmService().deleteState(redis, bookId, chapterId, sceneId);
}

function markGroupDone(redis, bookId, chapterId, sceneId, groupSuffix) {
    return videoFsmService().markGroupDone(redis, bookId, chapterId, sceneId, groupSuffix);
}

function groupSuffixes(state) {
    return videoFsmService().groupSuffixes(state);
}

function groupFilePath(buildId, bookId, chapterId, sceneId, suffix) {
    return videoFsmService().groupFilePath(buildId, bookId, chapterId, sceneId, suffix);
}

function isGroupFileValid(buildId, bookId, chapterId, sceneId, suffix) {
    return videoFsmService().isGroupFileValid(buildId, bookId, chapterId, sceneId, suffix);
}

function completeGroup(redis, bookId, chapterId, sceneId, groupSuffix, buildId, deps = {}) {
    return videoFsmService().completeGroup(redis, bookId, chapterId, sceneId, groupSuffix, buildId, deps);
}

function failWaitingScene(redis, bookId, chapterId, sceneId, buildId, reason, deps = {}) {
    return videoFsmService().failWaitingScene(redis, bookId, chapterId, sceneId, buildId, reason, deps);
}

function scanAllStates(redis) {
    return videoFsmService().scanAllStates(redis);
}

module.exports = {
    getState,
    initState,
    setWaitingChunks,
    setDone,
    setFailed,
    deleteState,
    markGroupDone,
    groupSuffixes,
    groupFilePath,
    isGroupFileValid,
    completeGroup,
    failWaitingScene,
    scanAllStates,
    get PHASES() {
        return videoFsmService().PHASES;
    },
};
