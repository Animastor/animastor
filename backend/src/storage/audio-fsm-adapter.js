// ======================================================
// HOST ADAPTER: AudioFsmAdapter — O-7 AudioFsmPort impl
// ======================================================
// Host-side implementation of the O-7 AudioFsmPort
// (runtime/audio-fsm-port.js). Owns every concrete audio-FSM detail the
// runtime/orchestration tiers must not know: the `animastor:audio-orch:*`
// Redis key grammar, the JSON state envelope, the valid-transition map,
// chunk-completeness validation, the merge drive and the hub-dedup
// cleanup inside backend/src/services/audio-orchestrator.js.
//
//   runtime/audio-fsm-port          (tier-owned contract)
//       ↑ wired by backend.cjs (composition root)
//   storage/audio-fsm-adapter       ← THIS FILE (host impl)
//
// Lazy call-time resolvers — never capture the module instance at load
// time. This keeps require.cache-based test stubbing working exactly as
// before (the O-2..O-5 adapter discipline): a harness that stubs
// `../src/services/audio-orchestrator` and then (re)requires a tier
// consumer gets the stub through this adapter (reconciliation-engine
// mockDeps, worklist-rebuild purge list).
//
// Behavior contract: every method is a 1:1 delegation to the pre-O-7 call
// — identical module, identical arguments, identical return values
// (including the { success, state, reason } transition results and the
// { failed, missing } failWaitingScene shape) and identical error
// semantics. No audio-FSM behavior changed; the service's public API is
// not extended.
//
// PHASES is passed through from the host service (the canonical owner of
// the phase vocabulary) via a lazy getter so a stubbed service's PHASES
// surface is also honored in tests.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.24 (O-7)
// ======================================================

// Lazy call-time resolver — the host FSM service channel every pre-O-7
// harness stubs (`require.resolve('../src/services/audio-orchestrator')`).
const audioFsmService = () => require('../services/audio-orchestrator');

function getState(redis, bookId, chapterId, sceneId) {
    return audioFsmService().getState(redis, bookId, chapterId, sceneId);
}

function setState(redis, bookId, chapterId, sceneId, state) {
    return audioFsmService().setState(redis, bookId, chapterId, sceneId, state);
}

function deleteState(redis, bookId, chapterId, sceneId) {
    return audioFsmService().deleteState(redis, bookId, chapterId, sceneId);
}

function initPlaceholderReady(redis, bookId, chapterId, sceneId, buildId, expectedCount) {
    return audioFsmService().initPlaceholderReady(redis, bookId, chapterId, sceneId, buildId, expectedCount);
}

function setGenerating(redis, bookId, chapterId, sceneId) {
    return audioFsmService().setGenerating(redis, bookId, chapterId, sceneId);
}

function setWaitingChunks(redis, bookId, chapterId, sceneId) {
    return audioFsmService().setWaitingChunks(redis, bookId, chapterId, sceneId);
}

function setMerging(redis, bookId, chapterId, sceneId) {
    return audioFsmService().setMerging(redis, bookId, chapterId, sceneId);
}

function setDone(redis, bookId, chapterId, sceneId) {
    return audioFsmService().setDone(redis, bookId, chapterId, sceneId);
}

function setFailed(redis, bookId, chapterId, sceneId, reason) {
    return audioFsmService().setFailed(redis, bookId, chapterId, sceneId, reason);
}

function completeChunk(redis, bookId, chapterId, sceneId, chunkIndex, buildId, deps = {}) {
    return audioFsmService().completeChunk(redis, bookId, chapterId, sceneId, chunkIndex, buildId, deps);
}

function failWaitingScene(redis, bookId, chapterId, sceneId, buildId, reason, deps = {}) {
    return audioFsmService().failWaitingScene(redis, bookId, chapterId, sceneId, buildId, reason, deps);
}

function scanAllStates(redis) {
    return audioFsmService().scanAllStates(redis);
}

module.exports = {
    getState,
    setState,
    deleteState,
    initPlaceholderReady,
    setGenerating,
    setWaitingChunks,
    setMerging,
    setDone,
    setFailed,
    completeChunk,
    failWaitingScene,
    scanAllStates,
    get PHASES() {
        return audioFsmService().PHASES;
    },
};
