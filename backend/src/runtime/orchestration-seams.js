// ======================================================
// S-5: ORCHESTRATION SEAMS — runtime → orchestration injection point
// ======================================================
// Phase-5/S-5 boundary: runtime modules must NOT require orchestration
// implementation (../orchestration/orchestrator, ../orchestration index,
// scene-*). Behavior that is orchestration-owned (stage executor entry,
// FSM-safe asset-state facade writers) reaches runtime ONLY through this
// seam registry, wired by the composition root (backend.cjs) at startup —
// the dependency points OUTWARD through the caller.
//
// This is deliberately NOT an S-6 port interface: no contract file, no
// adapter objects — a minimal function registry with fail-fast getters.
// The ONLY runtime→orchestration require allowed after S-5 is the
// event-journal sink (zero-require observability leaf, no orchestration
// policy inside — see s5-runtime-orchestration-cycle.test.js S5-A).
//
// Seams (all resolved at call time, fail-fast when unwired):
//   dispatchStage           — stage executor entry (scene-orchestrator.dispatchStage)
//   rollbackStageToPending  — FSM-safe GENERATING/PLACEHOLDER → DIRTY → PENDING rollback
//   markDirtyScene          — per-asset DIRTY writer (Redis FSM + PG stale sync)
//   setScenePending         — per-asset PENDING writer (validated transition + journal)
//   setSceneAllReady        — all-assets READY writer (validated transitions + journal)
//   setScenePlaceholder     — audio PLACEHOLDER writer (validated transition + journal)
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §26

const SEAM_NAMES = [
    'dispatchStage',
    'rollbackStageToPending',
    'markDirtyScene',
    'setScenePending',
    'setSceneAllReady',
    'setScenePlaceholder',
];

const registered = new Map();

/**
 * Wire orchestration implementations into the runtime seams.
 * Accepts a FULL set (all six) or a partial merge (tests may re-register
 * individual seams, e.g. a throwing executor for error-path coverage).
 * Unknown seam names are rejected — the surface cannot grow silently.
 */
function registerOrchestrationSeams(impls = {}) {
    for (const [name, fn] of Object.entries(impls)) {
        if (!SEAM_NAMES.includes(name)) {
            throw new Error(`orchestration-seams: unknown seam '${name}' (allowed: ${SEAM_NAMES.join(', ')})`);
        }
        if (typeof fn !== 'function') {
            throw new Error(`orchestration-seams: seam '${name}' must be a function`);
        }
        registered.set(name, fn);
    }
}

/** Test hygiene: drop all registrations (mocha afterEach hooks). */
function clearOrchestrationSeams() {
    registered.clear();
}

/**
 * Resolve a seam at CALL time. Fail-fast with a wiring instruction —
 * a missing seam must never degrade into a silent no-op (that would turn
 * FSM rollbacks into ghost GENERATING states).
 */
function getOrchestrationSeam(name) {
    const fn = registered.get(name);
    if (typeof fn !== 'function') {
        throw new Error(
            `orchestration-seams: '${name}' is not wired — the composition root must call ` +
            `registerOrchestrationSeams({ ${name}, ... }) before runtime dispatch runs (S-5)`
        );
    }
    return fn;
}

function isOrchestrationSeamWired(name) {
    return registered.has(name);
}

module.exports = {
    SEAM_NAMES,
    registerOrchestrationSeams,
    clearOrchestrationSeams,
    getOrchestrationSeam,
    isOrchestrationSeamWired,
};
