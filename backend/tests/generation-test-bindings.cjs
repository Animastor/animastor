// ======================================================
// GENERATION PORTS — host-side test bindings (S-6)
// ======================================================
// Mirrors the production composition root (backend.cjs): binds the four
// Generation host ports (DispatchTransport, GenerationConfig, ProfileStore,
// BookData) so that plain requires of generation modules — which is what
// most backend tests do — behave exactly like the wired production process.
// Loaded for EVERY mocha run via .mocharc.json `require` (runs before any
// test module), so lazy registry self-bootstrap and call-time port
// resolution always find a wired port.
//
// Behavior compatibility:
//   - DispatchTransport adapts runtime/gpu-dispatcher.sendUnified through a
//     call-time property lookup — tests that stub gpuDispatcher.sendUnified
//     on the module object (generation-provider-seam.test.js) keep working;
//   - GenerationConfig binds the canonical runtime-config slices verbatim
//     (config/generation-config-adapter) — the S2-G drift guard still
//     compares registry values against runtime-config directly;
//   - ProfileStore binds services/ai-loader.getAssemblyProfile (real file
//     loading, same cache semantics);
//   - BookData binds the book facade's collectSceneUnits + appearance
//     tokensToString (pure vbook-runtime functions).
//
// Any test that resets a port (e.g. _resetDispatchTransport for fail-fast
// coverage) must re-wire it — same discipline as clearOrchestrationSeams.
//
// Dual-location note (vbook-test-bindings pattern): the canonical host-owned
// wiring stays in backend.cjs; this fixture only mirrors it for tests.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §28

'use strict';

require('../src/config/generation-config-adapter').bindGenerationConfig();
require('../src/generation/ports/dispatch-transport').setDispatchTransport({
    dispatch: (taskSpec) => require('../src/runtime/gpu-dispatcher').sendUnified(taskSpec),
});
require('../src/generation/ports/profile-store').setProfileStore({
    getAssemblyProfile: require('../src/services/ai-loader').getAssemblyProfile,
});
require('../src/generation/ports/book-data').setBookData({
    collectSceneUnits: require('../src/book').collectSceneUnits,
    tokensToString: require('../src/book/lazy-book/appearance').tokensToString,
});
