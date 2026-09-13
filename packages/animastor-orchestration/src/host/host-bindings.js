// ======================================================
// HOST BINDINGS — the package↔host seam (S-6 convention)
// ======================================================
// The moved runtime/orchestration files reach the HOST-OWNED modules they
// were allowed to touch (§32.29 host-stays allowlist) ONLY through this
// surface. It is the same zero-require contract + fail-fast call-time
// resolver + one set/wired/reset shape as the ports in ../runtime/*-port.js,
// but for the host composition instead of one adapter: the composition root
// (backend/src/backend.cjs) binds the real host modules once at startup and
// the moved files resolve them lazily at call time.
//
// What crosses here (exactly the measured §32.29 host-stays, nothing more):
//   config        — backend/src/config/runtime-config (runtime slices)
//   state         — backend/src/state (Redis-domain state layer facade)
//   stateOps      — backend/src/state/scene-state-ops (pure FSM writers)
//   journal       — backend/src/state/event-journal (append-only sink)
//   media         — { audio, image, video } host media facades
//   genScope      — backend/src/services/gen-scope (single-consumer edge)
//   seams         — backend/src/runtime/orchestration-seams (S-5 registry)
//   artifactRoot  — the artifact output root (former process.env.OUTPUT_DIR
//                   read — the §32.29 step-4a closure of the O-G9 leak)
//   resolveWorkspaceForBook — the PW-2 workspace routing resolver (former
//                   scene-window → gpu-dispatcher lazy call — the §32.29
//                   step-4b closure; optional-load semantics preserved by
//                   the injected wrapper host-side)
//
// Deliberately NOT reachable through here: storage/**, book/**, routes/**,
// PG clients, Redis clients, Express, gpu-dispatcher internals. The host
// binds adapters; the package never requires backend/src.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md
//       §32.29 (gate) · §32.30 (physical extraction landed)

const BINDING_NAMES = [
    'config',
    'state',
    'stateOps',
    'journal',
    'media',
    'genScope',
    'seams',
    'artifactRoot',
    'resolveWorkspaceForBook',
];

const bindings = new Map();

/**
 * Wire the host-side implementations. Accepts a partial merge (tests may
 * rebind individual bindings); unknown binding names are rejected — the
 * surface cannot grow silently.
 *
 * RESOLVER SEMANTICS (§32.30): every binding is a ZERO-ARG FUNCTION that
 * returns the host module/value. It is invoked at RESOLUTION time (i.e. when
 * a moved file actually touches the host), not at binding time — the same
 * deferral the former lazy host-module require call sites had, so host
 * modules can be stubbed via require.cache after binding and stay visible
 * to the moved code (test-binding parity).
 */
function bindHostModules(impls = {}) {
    for (const [name, value] of Object.entries(impls)) {
        if (!BINDING_NAMES.includes(name)) {
            throw new Error(`host-bindings: unknown binding '${name}' (allowed: ${BINDING_NAMES.join(', ')})`);
        }
        if (typeof value !== 'function') {
            throw new Error(`host-bindings: binding '${name}' must be a resolver function (zero-arg), got ${typeof value}`);
        }
        bindings.set(name, value);
    }
}

/** Test hygiene: drop all bindings (mocha afterEach hooks). */
function clearHostBindings() {
    bindings.clear();
}

/**
 * Resolve a binding at CALL time (invokes the resolver). Fail-fast with a
 * wiring instruction — a missing binding must never degrade into a silent
 * no-op.
 */
function hostBinding(name) {
    const value = bindings.get(name);
    if (typeof value !== 'function') {
        throw new Error(
            `host-bindings: '${name}' is not wired — the composition root must call ` +
            `bindHostModules({ ${name}, ... }) before orchestration runs (§32.30)`
        );
    }
    return value();
}

function isHostBindingWired(name) {
    return bindings.has(name);
}

/**
 * Lazy host-module accessor: returns a proxy that resolves the binding (and
 * optional sub-path) at PROPERTY-ACCESS time. Lets a moved file keep its
 * original identifier usage verbatim (`state.getAssetStates(...)`,
 * `audio.segments.buildSegments(...)`) while the underlying host module is
 * only resolved when actually used — same deferral the former lazy
 * `require(...)` call sites had, but through the binding seam.
 */
function lazyHostBinding(name) {
    const [root, ...rest] = name.split('.');
    return new Proxy({}, {
        get(_, prop) {
            let target = hostBinding(root);
            for (const key of rest) target = target[key];
            return target[prop];
        },
    });
}

/**
 * Direct call-time host access for non-member callables (the PW-2 resolver,
 * the artifact root): `hostCall('resolveWorkspaceForBook')(bookId)`.
 */
function hostCall(name) {
    return hostBinding(name);
}

/** All names the composition root is expected to wire. */
function requiredHostBindings() {
    return [...BINDING_NAMES];
}

module.exports = {
    BINDING_NAMES,
    bindHostModules,
    clearHostBindings,
    hostBinding,
    hostCall,
    isHostBindingWired,
    lazyHostBinding,
    requiredHostBindings,
};
