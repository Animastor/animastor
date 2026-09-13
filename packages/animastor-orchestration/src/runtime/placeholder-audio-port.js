// ======================================================
// O-4 PORT: PlaceholderAudioPort — runtime/orchestration
// placeholder-audio contract
// ======================================================
// The runtime and orchestration tiers must not know the placeholder-audio
// host service. Every ffmpeg/child-process detail, scene_assets upsert,
// OUTPUT_DIR path composition and book fallback the service performs stays
// HOST-side (backend/src/services/placeholder-audio.js); the tiers consume
// the three placeholder-audio operations they actually use ONLY through
// this port, wired by the composition root (backend.cjs) at startup.
//
//   runtime/** + orchestration/**        (tier consumers)
//       ↓ consume placeholder-audio ops through
//   runtime/placeholder-audio-port.js    ← THIS PORT (tier-owned contract)
//       ↑ wired by the host
//   storage/placeholder-audio-adapter    (host service adapter)
//
// This is the O-2/O-3 port convention (runtime/persistence-port.js,
// runtime/scene-data-port.js): a zero-require contract module, a fail-fast
// call-time resolver, one set/wired/reset surface. No ffmpeg, no fs, no
// SQL, no scene_assets knowledge and no "future ops" cross the boundary —
// the contract below is EXACTLY the set of operations the two tiers use
// today (measured at O-4 reconnaissance, §32.7 O-P7):
//
//   hasRealAudio            — distinguish real TTS from a placeholder on
//                             completion/restore/rebuild reads
//                             (scene-window ×3 call sites,
//                             scene-restoration restore probe,
//                             reconciliation rebuildWorkList)
//   ensurePlaceholderAudio  — synchronously materialize the silent-MP3
//                             placeholder before a scene enters the
//                             scheduler (scene-window addToWindow)
//   replacePlaceholderWithRealAudio — register real audio over the
//                             placeholder when the audio stage completes
//                             (scene-callbacks handleAudioCompleted)
//
// Deliberately NOT in the port: estimateSpeechDurationSec (pure text
// heuristic with its own canonical owner utils/speech-estimation —
// consumed by the VBook agent pipeline, not by these tiers),
// ensureAllPlaceholderAudio/getScenesNeedingPlaceholder (routes/import
// workflow), markPlaceholderStale (state-layer FSM writer),
// recoverMissingPlaceholders (host recovery routes), and any CRUD "for
// later". The host adapter owns every ffmpeg call, every path and every
// scene_assets write.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.7 (O-P7, O-4 DONE)
// ======================================================

const OPS = [
    'hasRealAudio',
    'ensurePlaceholderAudio',
    'replacePlaceholderWithRealAudio',
];

let impl = null;

/**
 * Wire the host placeholder-audio adapter. Called once by the composition
 * root (backend.cjs) BEFORE any runtime/orchestration placeholder-audio
 * consumer runs.
 * @param {object} adapter — flat map with every op in OPS as a function.
 */
function setPlaceholderAudioPort(adapter) {
    if (!adapter) {
        throw new Error('placeholder-audio-port: adapter is required');
    }
    for (const op of OPS) {
        if (typeof adapter[op] !== 'function') {
            throw new Error(`placeholder-audio-port: adapter must implement ${op}()`);
        }
    }
    impl = adapter;
}

/** Resolve the port at CALL time — fail-fast when unwired. */
function placeholderAudio() {
    if (!impl) {
        throw new Error(
            'placeholder-audio-port: not wired — the composition root must call ' +
            'setPlaceholderAudioPort(adapter) (storage/placeholder-audio-adapter) ' +
            'before runtime/orchestration placeholder-audio consumers run (O-4)'
        );
    }
    return impl;
}

/**
 * Shorthand op resolver: `placeholderAudioOp('hasRealAudio')(...)`.
 * Fails fast when the port or the single op is missing — a missing
 * placeholder probe must never silently degrade into `false`.
 * @param {string} op — op name from OPS
 */
function placeholderAudioOp(op) {
    const fn = impl?.[op];
    if (typeof fn !== 'function') {
        throw new Error(`placeholder-audio-port: op '${op}' is not wired (O-4)`);
    }
    return fn;
}

function isPlaceholderAudioPortWired() {
    return impl !== null;
}

/** Test hygiene: drop the wiring (mocha hooks). */
function _resetPlaceholderAudioPort() {
    impl = null;
}

module.exports = {
    OPS,
    setPlaceholderAudioPort,
    placeholderAudio,
    placeholderAudioOp,
    isPlaceholderAudioPortWired,
    _resetPlaceholderAudioPort,
};
