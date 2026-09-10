// ======================================================
// S-6 PORT: GenerationConfig — injected Generation configuration
// ======================================================
// Generation Core must not read runtime-config (host config module).
// generation/default-registrations.js — the registration point that seeds
// the media registry with production capability values — consumes THIS
// port; the host adapter (config/generation-config-adapter.js) binds the
// canonical runtime-config slices into it at the composition root.
//
//   generation/default-registrations  (host-side registration adapter)
//       ↓ reads capability values through
//   generation/ports/generation-config   ← THIS PORT (Generation-owned)
//       ↑ wired by the host
//   config/runtime-config                (canonical numeric source of truth)
//
// CONTRACT (frozen — the exact config slices the capability registrations
// consume, passed VERBATIM from runtime-config so no value mapping can
// drift; key names are the canonical host names guarded for consistency
// by the S2-G suite):
//   {
//     leaseTtlS:       { AUDIO, IMAGE, VIDEO }                (seconds)
//     quotas:          { MAX_ACTIVE_AUDIO, MAX_ACTIVE_IMAGE,
//                        MAX_ACTIVE_VIDEO }                   (count)
//     stuckThresholds: { AUDIO_GENERATING, AUDIO_PENDING,
//                        IMAGE_GENERATING, IMAGE_PENDING,
//                        VIDEO_GENERATING, VIDEO_PENDING }    (minutes)
//   }
//
// No other runtime-config surface may be consumed through this port — the
// contract is the three capability slices above, nothing else.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §28

const CONFIG_KEYS = ['leaseTtlS', 'quotas', 'stuckThresholds'];

let impl = null;

/**
 * Wire the host config adapter. Called by the composition root
 * (backend.cjs) BEFORE generation/default-registrations is loaded
 * (registration reads the values at require time).
 * @param {{ leaseTtlS: object, quotas: object, stuckThresholds: object }} adapter
 */
function setGenerationConfig(adapter) {
    if (!adapter) {
        throw new Error('generation-config: adapter is required');
    }
    for (const key of CONFIG_KEYS) {
        if (!adapter[key] || typeof adapter[key] !== 'object') {
            throw new Error(`generation-config: adapter must provide '${key}'`);
        }
    }
    impl = adapter;
}

/**
 * Resolve the config at CALL time. Fail-fast with a wiring instruction —
 * registration must never fall back to silent defaults (that would fork
 * the canonical config values).
 */
function generationConfig() {
    if (!impl) {
        throw new Error(
            'generation-config: not wired — the composition root must call ' +
            'bindGenerationConfig() (config/generation-config-adapter) before ' +
            'generation/default-registrations loads (S-6)'
        );
    }
    return impl;
}

function isGenerationConfigWired() {
    return impl !== null;
}

/** Test hygiene: drop the wiring (mocha hooks). */
function _resetGenerationConfig() {
    impl = null;
}

module.exports = {
    CONFIG_KEYS,
    setGenerationConfig,
    generationConfig,
    isGenerationConfigWired,
    _resetGenerationConfig,
};
