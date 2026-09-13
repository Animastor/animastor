// ======================================================
// ORCHESTRATION PACKAGE TEST BINDINGS
// ======================================================
// The package self-containedness fixture: wires ONLY what package-local
// (pure-policy) tests need and what the package itself cannot own:
//
//   1. @animastor/generation GenerationConfig port — the media-registry
//      self-bootstrap (default-registrations) reads the canonical config
//      slices through this port. In the host it is bound by the host adapter
//      (backend/src/config/generation-config-adapter.js) from runtime-config.
//      Package tests have no host, so this fixture binds the SAME canonical
//      slice VALUES frozen here (the host S2-G drift guards still compare
//      the registry against runtime-config directly, so any divergence of
//      these literals fails there first).
//
//   2. @animastor/orchestration host-bindings — package files fail fast at
//      call time unless the composition root wires the host surfaces. Tests
//      that exercise only pure-policy modules (no host touch) need nothing;
//      tests that stub host modules install their stubs directly here via
//      `bindHostModules` (same discipline as the host composition root).
//
// Loaded for EVERY package mocha run via `npm test` (see package.json).
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.30
// ======================================================

// 1) GenerationConfig port (canonical host slice values, frozen)
const { setGenerationConfig } = require('@animastor/generation').ports.generationConfig;

setGenerationConfig({
    leaseTtlS: {
        AUDIO: 1860,   // = ceil(STALL_FAILSAFE_MS/1000) + 60 (GPU_TIMEOUT_MS=600_000)
        IMAGE: 1200,   // = 20 * 60
        VIDEO: 1800,   // = 30 * 60
    },
    quotas: {
        MAX_ACTIVE_AUDIO: 8,
        MAX_ACTIVE_IMAGE: 4,
        MAX_ACTIVE_VIDEO: 2,
    },
    stuckThresholds: {
        AUDIO_GENERATING: 15,
        AUDIO_PENDING: 15,
        IMAGE_GENERATING: 30,
        IMAGE_PENDING: 30,
        VIDEO_GENERATING: 60,
        VIDEO_PENDING: 60,
    },
});

// 2) host-bindings default: a fail-fast stub set — any host touch that a
// package test does not explicitly re-wire must throw, never silently no-op
// (matches the production unwired-seam semantics).
const { bindHostModules } = require('../src/host/host-bindings');

bindHostModules({
    journal: () => {
        throw new Error('[ORCH-TEST-BINDINGS] host journal not wired — wire it in the test that asserts journal behavior');
    },
});
