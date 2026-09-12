// ======================================================
// HOST ADAPTER: PlaceholderAudioAdapter — O-4 PlaceholderAudioPort impl
// ======================================================
// Host-side implementation of the O-4 PlaceholderAudioPort
// (runtime/placeholder-audio-port.js). Owns every concrete placeholder-audio
// detail the runtime/orchestration tiers must not know: the ffmpeg
// silence-generation child process, scene_assets upserts, OUTPUT_DIR path
// composition, the image_units/text-length duration estimation and the
// book-source fallback inside backend/src/services/placeholder-audio.js.
//
//   runtime/placeholder-audio-port    (tier-owned contract)
//       ↑ wired by backend.cjs (composition root)
//   storage/placeholder-audio-adapter ← THIS FILE (host impl)
//
// Lazy call-time resolvers — never capture the module instance at load
// time. This keeps require.cache-based test stubbing working exactly as
// before (the O-2/O-3 adapter discipline): a harness that stubs
// `../src/services/placeholder-audio` and then (re)requires a tier consumer
// gets the stub through this adapter (happy-path D.3 scene-window stub,
// Section-4 scene-callbacks mock).
//
// Behavior contract: every method is a 1:1 delegation to the pre-O-4 call
// — identical module, identical arguments, identical return values
// (including the { created, path, durationSec, reason } / { replaced,
// reason } result shapes) and identical error/catch semantics. No
// placeholder-audio behavior changed.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.7 (O-P7, O-4)
// ======================================================

// Lazy call-time resolver — the host service channel every pre-O-4 harness
// stubs (`require.resolve('../src/services/placeholder-audio')`).
const placeholderAudioService = () => require('../services/placeholder-audio');

function hasRealAudio(bookId, chapterId, sceneId, buildId) {
    return placeholderAudioService().hasRealAudio(bookId, chapterId, sceneId, buildId);
}

function ensurePlaceholderAudio(buildId, bookId, chapterId, sceneId) {
    return placeholderAudioService().ensurePlaceholderAudio(buildId, bookId, chapterId, sceneId);
}

function replacePlaceholderWithRealAudio(bookId, chapterId, sceneId, buildId, realAudioPath, realDuration) {
    return placeholderAudioService().replacePlaceholderWithRealAudio(bookId, chapterId, sceneId, buildId, realAudioPath, realDuration);
}

module.exports = {
    hasRealAudio,
    ensurePlaceholderAudio,
    replacePlaceholderWithRealAudio,
};
