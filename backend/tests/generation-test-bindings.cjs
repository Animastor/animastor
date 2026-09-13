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
require('@animastor/generation').ports.dispatchTransport.setDispatchTransport({
    dispatch: (taskSpec) => require('../src/runtime/gpu-dispatcher').sendUnified(taskSpec),
});
require('@animastor/generation').ports.profileStore.setProfileStore({
    getAssemblyProfile: require('../src/services/ai-loader').getAssemblyProfile,
});
require('@animastor/generation').ports.bookData.setBookData({
    collectSceneUnits: require('../src/book').collectSceneUnits,
    tokensToString: require('../src/book/lazy-book/appearance').tokensToString,
});
// O-2: PersistencePort — mirrors the production composition root: binds the
// host persistence adapter so tier consumers (runtime/orchestration) resolve
// persistence at call time exactly like the wired production process. Call
// time resolution (lazy requires inside the adapter) keeps require.cache
// repo/barrel stubs in individual harnesses fully effective.
require('../src/runtime/persistence-port').setPersistencePort(
    require('../src/storage/runtime-persistence-adapter')
);
// O-3: SceneDataPort — same convention: binds the host scene-data adapter so
// tier consumers resolve loadBook/findSceneRuntimeData/collectScenes at call
// time through the '../src/book' shim channel (stubbing it keeps working).
require('../src/runtime/scene-data-port').setSceneDataPort(
    require('../src/storage/scene-data-adapter')
);
// O-4: PlaceholderAudioPort — same convention: binds the host placeholder-
// audio adapter so tier consumers resolve hasRealAudio/ensurePlaceholder-
// Audio/replacePlaceholderWithRealAudio at call time through the
// '../src/services/placeholder-audio' channel (stubbing it keeps working).
require('../src/runtime/placeholder-audio-port').setPlaceholderAudioPort(
    require('../src/storage/placeholder-audio-adapter')
);
// O-5: ProgressEventsPort — same convention: binds the host progress-events
// adapter so tier consumers resolve publishProgress/getSceneTaskState/
// hasActiveTasks/reconcileCompletedTasks at call time through the
// '../src/services/progress-pubsub.cjs' and '../src/services/generation-
// progress' channels (stubbing them keeps working).
require('../src/runtime/progress-events-port').setProgressEventsPort(
    require('../src/storage/progress-events-adapter')
);
// O-7: AudioFsmPort — same convention: binds the host audio-FSM adapter so
// tier consumers resolve the audio-FSM operations at call time through the
// '../src/services/audio-orchestrator' channel (stubbing it keeps working
// — the reconciliation/worklist harnesses replace exactly that module).
require('../src/runtime/audio-fsm-port').setAudioFsmPort(
    require('../src/storage/audio-fsm-adapter')
);
// O-8: VideoFsmPort — same convention: binds the host video-FSM adapter so
// tier consumers resolve the video-FSM operations at call time through the
// '../src/services/video-orchestrator' channel (stubbing it keeps working
// — the orchestration-stabilization harness replaces exactly that module).
require('../src/runtime/video-fsm-port').setVideoFsmPort(
    require('../src/storage/video-fsm-adapter')
);
// O-9: HubCancelPort — same convention: binds the host hub-cancel adapter
// so tier consumers resolve clearHubDispatches at call time through the
// '../src/runtime/dispatch-engine' channel (stubbing it keeps working —
// the gpu-hub-cleanup and reconciliation harnesses replace exactly that
// module).
require('../src/runtime/hub-cancel-port').setHubCancelPort(
    require('../src/storage/hub-cancel-adapter')
);
