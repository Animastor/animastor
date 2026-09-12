// Web Player public entry point (Phase 2 physical relocation —
// docs/architecture/web-player-module-extraction-audit.md).
//
// The Player contour — the engine (playbackStore.ts), the pure reveal gate
// (playbackGate.ts), the media cache (mediaCache.ts) and the Play surface
// (PlayPage.tsx) — lives inside src/modules/player/ in the future
// @animastor/web-player package layout (Phase 3 cuts the package; this
// directory already enforces its boundary rules).
//
// The host consumes the contour ONLY through this entry: deep imports of
// playbackStore / playbackGate / mediaCache / models / ports are forbidden
// (architecture/player-contour.guard.test.ts).
//
// Minimal public API — exactly the host-facing symbols of audit §2.3:
//   main.tsx              — PlayPage + wirePlayback* (composition root mount)
//   app/playerAdapters.ts — PlayerPorts (the single composition seam)
//   pages/EditPage.tsx    — seekToPosition + delete invalidations
//   pages/SettingsPage.tsx — closeBook + clearMediaCache
//   app/fileAdapters.ts   — closeBook (fileStore's player release seam)
//   app/navigatorAdapters.ts — seekToPosition (the navigator seek port)
//
// Deliberately NOT exported: engine internals (state machine, queue, preload,
// buffer gate), the session identity projection (bookId/buildId — generateStore
// owns the single source of truth; the engine keeps its internal projection),
// the mediaCache key grammar, and the ports payload builders.

export { PlayPage } from './PlayPage';
export {
  wirePlaybackCoordination,
  wirePlaybackLifecycle,
  seekToPosition,
  closeBook,
  invalidateDeletedScene,
  invalidateDeletedChapter,
} from './playbackStore';
export { clearCache as clearMediaCache } from './mediaCache';
export type { PlayerPorts } from './ports';
