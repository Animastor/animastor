// ======================================================
// O-8 PORT: VideoFsmPort — runtime/orchestration
// video-FSM contract
// ======================================================
// The runtime and orchestration tiers must not know the video-orchestrator
// host service. The Redis key grammar (`animastor:video-orch:*`), the JSON
// state envelope, the valid-transition map, the group-file validation
// threshold and the merge/source-cap pipeline details stay HOST-side
// (backend/src/services/video-orchestrator.js); the tiers drive the video
// scene FSM ONLY through this port, wired by the composition root
// (backend.cjs) at startup.
//
//   runtime/** + orchestration/**        (tier consumers)
//       ↓ consume video-FSM ops through
//   runtime/video-fsm-port.js           ← THIS PORT (tier-owned contract)
//       ↑ wired by the host
//   storage/video-fsm-adapter            (host FSM adapter)
//
// This is the O-2/O-3/O-4/O-5/O-7 port convention (runtime/persistence-
// port.js, runtime/scene-data-port.js, runtime/placeholder-audio-port.js,
// runtime/progress-events-port.js, runtime/audio-fsm-port.js): a zero-
// require contract module, a fail-fast call-time resolver, one set/wired/
// reset surface. No Redis key strings, no JSON state encoding, no
// transition-map internals and no "future ops" cross the boundary — the
// contract below is EXACTLY the set of operations the two tiers use today
// (measured at O-8 reconnaissance, §32.25; the O-6 audit had measured
// "14 ops" for the combined MediaFsmPort video half — the tiers' actual
// usage is 13 ops + the phase constants; setMerging/allGroupsDone are
// host-only internals the tiers never touch):
//
//   getState            — read the video-FSM phase record (dispatch
//                         cache-hit snapshot, invariant checks)
//   initState           — create/replace the per-dispatch group state
//                         (scene-orchestrator executeVideoDispatch)
//   setWaitingChunks   — GENERATING → WAITING_CHUNKS before jobs are sent
//   setDone            — → DONE recovery leg (MERGING with merged file)
//   setFailed          — → FAILED (orchestrator failStage facade sync,
//                         recovery legs)
//   deleteState        — drop a stale/unknown-phase record (recovery
//                         unknown-phase sweep)
//   markGroupDone      — mark a cache-hit group done in state
//   groupSuffixes      — list group suffixes from a state record
//   groupFilePath      — resolve a group file path (stale-file unlink
//                         before re-dispatch)
//   isGroupFileValid   — validate a group file on disk (cache-hit check,
//                         recovery completeness)
//   completeGroup      — drive group-completeness + merge from a group
//                         result / recovery (host-owned merge logic)
//   failWaitingScene   — WAITING_CHUNKS → FAILED with hub-dedup cleanup
//                         (stall watchdog, recovery)
//   scanAllStates      — enumerate every non-terminal record (stall
//                         watchdog, startup recovery)
//   PHASES             — the phase-name constants the tiers compare
//                         orchState.phase against (NEW, GENERATING,
//                         WAITING_CHUNKS, MERGING, DONE, FAILED). Phase
//                         NAMES are the FSM's public vocabulary; everything
//                         about their STORAGE (key grammar, envelope,
//                         transitions) stays host-side in the adapter.
//
// Optional-load semantics are the ADAPTER's concern, not the port's: the
// reconciliation optional-load legs (try/catch → return 0 when the host
// service is absent) keep their exact pre-O-8 behavior by wrapping the
// ADAPTER's lazy require, not by relaxing this fail-fast contract.
//
// Deliberately NOT in the port: the audio FSM (runtime/audio-fsm-port —
// the O-7 seam; two independent FSMs never merge, the O-6 MediaFsmPort
// rejection stands), key()/PREFIX/createState/transitionState/setMerging/
// allGroupsDone internals (Redis/storage knowledge), any combined
// MediaFsmPort surface and any CRUD "for later".
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.25 (O-8 DONE)
// ======================================================

const OPS = [
    'getState',
    'initState',
    'setWaitingChunks',
    'setDone',
    'setFailed',
    'deleteState',
    'markGroupDone',
    'groupSuffixes',
    'groupFilePath',
    'isGroupFileValid',
    'completeGroup',
    'failWaitingScene',
    'scanAllStates',
];

// Phase names the tier consumers compare against — the FSM's public
// vocabulary (a frozen set: adding one is a contract change, not a key
// grammar change — the adapter owns the storage behind these names).
const PHASE_CONSTANTS = [
    'NEW',
    'GENERATING',
    'WAITING_CHUNKS',
    'MERGING',
    'DONE',
    'FAILED',
];

let impl = null;

/**
 * Wire the host video-FSM adapter. Called once by the composition root
 * (backend.cjs) BEFORE any runtime/orchestration video-FSM consumer runs.
 * The adapter must expose every op in OPS as a function; the PHASES
 * constants resolve lazily at call time (videoFsmPhases()) so wiring never
 * forces a host-service load — the O-2..O-7 lazy-resolution discipline.
 * @param {object} adapter — flat map with every op in OPS as a function
 * plus a PHASES constant object (validated on first phase read, not here).
 */
function setVideoFsmPort(adapter) {
    if (!adapter) {
        throw new Error('video-fsm-port: adapter is required');
    }
    for (const op of OPS) {
        if (typeof adapter[op] !== 'function') {
            throw new Error(`video-fsm-port: adapter must implement ${op}()`);
        }
    }
    if (!('PHASES' in adapter)) {
        throw new Error('video-fsm-port: adapter must carry the PHASES constants');
    }
    impl = adapter;
}

/** Resolve the port at CALL time — fail-fast when unwired. */
function videoFsm() {
    if (!impl) {
        throw new Error(
            'video-fsm-port: not wired — the composition root must call ' +
            'setVideoFsmPort(adapter) (storage/video-fsm-adapter) ' +
            'before runtime/orchestration video-FSM consumers run (O-8)'
        );
    }
    return impl;
}

/**
 * Shorthand op resolver: `videoFsmOp('getState')(...)`.
 * Fails fast when the port or the single op is missing — a missing phase
 * writer silently degrading into a no-op would corrupt the video FSM
 * (ghost WAITING_CHUNKS scenes, lost recovery legs).
 * @param {string} op — op name from OPS
 */
function videoFsmOp(op) {
    const fn = impl?.[op];
    if (typeof fn !== 'function') {
        throw new Error(`video-fsm-port: op '${op}' is not wired (O-8)`);
    }
    return fn;
}

/** Phase constants through the port (fail-fast at CALL time — never loaded
 *  during composition-root wiring, preserving the lazy-resolution parity
 *  with test stubs). */
function videoFsmPhases() {
    const phases = videoFsm().PHASES;
    if (!phases || typeof phases !== 'object') {
        throw new Error('video-fsm-port: PHASES is not wired (O-8)');
    }
    for (const phase of PHASE_CONSTANTS) {
        if (!(phase in phases)) {
            throw new Error(`video-fsm-port: PHASES is missing the ${phase} constant (O-8)`);
        }
    }
    return phases;
}

function isVideoFsmPortWired() {
    return impl !== null;
}

/** Test hygiene: drop the wiring (mocha hooks). */
function _resetVideoFsmPort() {
    impl = null;
}

module.exports = {
    OPS,
    PHASE_CONSTANTS,
    setVideoFsmPort,
    videoFsm,
    videoFsmOp,
    videoFsmPhases,
    isVideoFsmPortWired,
    _resetVideoFsmPort,
};
