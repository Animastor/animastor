// ======================================================
// O-7 PORT: AudioFsmPort — runtime/orchestration
// audio-FSM contract
// ======================================================
// The runtime and orchestration tiers must not know the audio-orchestrator
// host service. The Redis key grammar (`animastor:audio-orch:*`), the JSON
// state envelope, the valid-transition map and every chunk-completeness /
// merge / hub-dedup detail stay HOST-side (backend/src/services/
// audio-orchestrator.js); the tiers drive the audio scene FSM ONLY through
// this port, wired by the composition root (backend.cjs) at startup.
//
//   runtime/** + orchestration/**        (tier consumers)
//       ↓ consume audio-FSM ops through
//   runtime/audio-fsm-port.js            ← THIS PORT (tier-owned contract)
//       ↑ wired by the host
//   storage/audio-fsm-adapter             (host FSM adapter)
//
// This is the O-2/O-3/O-4/O-5 port convention (runtime/persistence-port.js,
// runtime/scene-data-port.js, runtime/placeholder-audio-port.js,
// runtime/progress-events-port.js): a zero-require contract module, a
// fail-fast call-time resolver, one set/wired/reset surface. No Redis key
// strings, no JSON state encoding, no transition-map internals and no
// "future ops" cross the boundary — the contract below is EXACTLY the set
// of operations the two tiers use today (measured at O-7 reconnaissance,
// §32.24; the O-6 audit had measured 13 ops for the combined MediaFsmPort
// audio half — the tiers' actual usage is 12 ops + the phase constants):
//
//   getState           — read the audio-FSM phase record (dispatch DONE
//                        guard, invariant checks)
//   setState           — persist a repaired record (recovery leg that
//                        re-fills expected_count before re-driving merge)
//   deleteState        — drop a stale record before re-initialization
//                        (scene-orchestrator stale-phase reset, recovery
//                        unknown-phase sweep)
//   initPlaceholderReady — create the initial PLACEHOLDER_READY record
//                        (scene-window startScene, scene-orchestrator
//                        no_state/stale-phase recovery init)
//   setGenerating     — PLACEHOLDER_READY → GENERATING before TTS dispatch
//   setWaitingChunks  — GENERATING → WAITING_CHUNKS before jobs are sent
//   setMerging        — → MERGING fast-track legs
//   setDone           — → DONE fast-track/recovery legs
//   setFailed         — → FAILED (orchestrator failStage facade sync,
//                        recovery legs)
//   completeChunk     — drive chunk-completeness + merge from a chunk
//                        callback / recovery (host-owned merge logic)
//   failWaitingScene  — WAITING_CHUNKS → FAILED with hub-dedup cleanup
//                        (stall watchdog, recovery)
//   scanAllStates     — enumerate every non-terminal record (stall
//                        watchdog, startup recovery)
//   PHASES            — the phase-name constants the tiers compare
//                        orchState.phase against (DONE, FAILED, NEW,
//                        PLACEHOLDER_READY, GENERATING, WAITING_CHUNKS,
//                        MERGING). Phase NAMES are the FSM's public
//                        vocabulary; everything about their STORAGE
//                        (key grammar, envelope, transitions) stays
//                        host-side in the adapter.
//
// Optional-load semantics are the ADAPTER's concern, not the port's: the
// reconciliation optional-load legs (try/catch → return 0 when the host
// service is absent) keep their exact pre-O-7 behavior by wrapping the
// ADAPTER's lazy require, not by relaxing this fail-fast contract.
//
// Deliberately NOT in the port: the video FSM (services/video-orchestrator
// — its own future seam step, never merged here), key()/PREFIX/createState/
// transitionState internals (Redis/storage knowledge), any combined
// MediaFsmPort surface (rejected at O-6 as a 27-member god-interface) and
// any CRUD "for later".
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.24 (O-7 DONE)
// ======================================================

const OPS = [
    'getState',
    'setState',
    'deleteState',
    'initPlaceholderReady',
    'setGenerating',
    'setWaitingChunks',
    'setMerging',
    'setDone',
    'setFailed',
    'completeChunk',
    'failWaitingScene',
    'scanAllStates',
];

// Phase names the tier consumers compare against — the FSM's public
// vocabulary (a frozen set: adding one is a contract change, not a key
// grammar change — the adapter owns the storage behind these names).
const PHASE_CONSTANTS = [
    'NEW',
    'PLACEHOLDER_READY',
    'GENERATING',
    'WAITING_CHUNKS',
    'MERGING',
    'DONE',
    'FAILED',
];

let impl = null;

/**
 * Wire the host audio-FSM adapter. Called once by the composition root
 * (backend.cjs) BEFORE any runtime/orchestration audio-FSM consumer runs.
 * The adapter must expose every op in OPS as a function; the PHASES
 * constants resolve lazily at call time (audioFsmPhases()) so wiring never
 * forces a host-service load — the O-2..O-5 lazy-resolution discipline.
 * @param {object} adapter — flat map with every op in OPS as a function
 * plus a PHASES constant object (validated on first phase read, not here).
 */
function setAudioFsmPort(adapter) {
    if (!adapter) {
        throw new Error('audio-fsm-port: adapter is required');
    }
    for (const op of OPS) {
        if (typeof adapter[op] !== 'function') {
            throw new Error(`audio-fsm-port: adapter must implement ${op}()`);
        }
    }
    if (!('PHASES' in adapter)) {
        throw new Error('audio-fsm-port: adapter must carry the PHASES constants');
    }
    impl = adapter;
}

/** Resolve the port at CALL time — fail-fast when unwired. */
function audioFsm() {
    if (!impl) {
        throw new Error(
            'audio-fsm-port: not wired — the composition root must call ' +
            'setAudioFsmPort(adapter) (storage/audio-fsm-adapter) ' +
            'before runtime/orchestration audio-FSM consumers run (O-7)'
        );
    }
    return impl;
}

/**
 * Shorthand op resolver: `audioFsmOp('getState')(...)`.
 * Fails fast when the port or the single op is missing — a missing phase
 * writer silently degrading into a no-op would corrupt the audio FSM
 * (ghost GENERATING scenes, lost recovery legs).
 * @param {string} op — op name from OPS
 */
function audioFsmOp(op) {
    const fn = impl?.[op];
    if (typeof fn !== 'function') {
        throw new Error(`audio-fsm-port: op '${op}' is not wired (O-7)`);
    }
    return fn;
}

/** Phase constants through the port (fail-fast at CALL time — never loaded
 *  during composition-root wiring, preserving the lazy-resolution parity
 *  with test stubs). */
function audioFsmPhases() {
    const phases = audioFsm().PHASES;
    if (!phases || typeof phases !== 'object') {
        throw new Error('audio-fsm-port: PHASES is not wired (O-7)');
    }
    for (const phase of PHASE_CONSTANTS) {
        if (!(phase in phases)) {
            throw new Error(`audio-fsm-port: PHASES is missing the ${phase} constant (O-7)`);
        }
    }
    return phases;
}

function isAudioFsmPortWired() {
    return impl !== null;
}

/** Test hygiene: drop the wiring (mocha hooks). */
function _resetAudioFsmPort() {
    impl = null;
}

module.exports = {
    OPS,
    PHASE_CONSTANTS,
    setAudioFsmPort,
    audioFsm,
    audioFsmOp,
    audioFsmPhases,
    isAudioFsmPortWired,
    _resetAudioFsmPort,
};
