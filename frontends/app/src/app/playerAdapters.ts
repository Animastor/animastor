// Host-owned composition of PlayerPorts
// (docs/architecture/web-player-module-extraction-audit.md, Phase 2 physical
// relocation).
//
// This file is the ONLY seam where the app's shared infrastructure meets the
// Player contract: the engine (@animastor/web-player playbackStore) and the Play
// surface (@animastor/web-player PlayPage) consume `playerPorts` and know nothing
// about the modules below. When the physical package is cut (Phase 3), this
// wiring stays in the host app and becomes the composition root for
// @animastor/web-player.
//
//   main.tsx ──wire──▶ playbackStore.wirePlaybackCoordination(playerPorts)
//   main.tsx ──render──▶ <PlayPage ports={playerPorts} />
//   PlayPage/engine
//      ↓
//   PlayerPorts (@animastor/web-player — public entry)
//      ↓
//   playerAdapters (this file — the single composition seam)
//   ├── state/generateStore      ← session identity (host singletons, never
//   │                               copied) + generation-completion event
//   ├── state/positionStore      ← shared position writes (SharedPositionManager)
//   ├── state/resourceInvalidations ← invalidation bus (pure consumer)
//   ├── api/client               ← HTTP + videoUrl (the /api/v1 base stays here)
//   ├── app/i18n / app/desktop / app/icons

import { signal } from '@preact/signals';
import { getBlob, getJson, mediaUrl, retryWithBackoff } from '../api/client';
import { t } from './i18n';
import { DESKTOP_SHELL_QUERY } from './desktop';
import {
  IconPlay, IconPause, IconVolumeUp, IconVolumeOff, IconImage, IconImageOff,
  IconVideocam, IconVideocamOff, IconSubtitles, IconSubtitlesOff,
  IconFullscreen, IconFullscreenExit,
} from './icons';
import { bookId, buildId, onPlaybackPrepared } from '../state/generateStore';
import { navigateTo } from '../state/positionStore';
import { BOOK_RESOURCE_PREFIX, onResourceInvalidated } from '../state/resourceInvalidations';
import type { PlayerPorts } from '@animastor/web-player';

// ShellModePort host implementation: the same query as useDesktopShell
// (min-width: 1180px), backed by a signal so a PlayPage rendered through the
// port still re-renders when the shell breakpoint is crossed (behavior parity
// with useDesktopShell's matchMedia listener; navigatorAdapters precedent).
const desktopShell = signal<boolean>(
  typeof window !== 'undefined' ? window.matchMedia(DESKTOP_SHELL_QUERY).matches : false,
);
if (typeof window !== 'undefined') {
  const media = window.matchMedia(DESKTOP_SHELL_QUERY);
  const update = () => { desktopShell.value = media.matches; };
  media.addEventListener('change', update);
}

export const playerPorts: PlayerPorts = {
  // Session identity — the generateStore singletons passed BY REFERENCE: the
  // engine keeps its internal projection, but the Play surface and the rest
  // of the app read the identity only here (no second source of truth).
  session: { bookId, buildId },
  // Generation completion — the full payload (scenes + coverImage + softRefresh);
  // deliberately NOT narrowed (the engine consumes all of it).
  generation: { onPlaybackPrepared },
  // Shared position — write direction: the engine advances the position on
  // every scene/unit transition.
  position: { navigateTo },
  // Invalidation bus — pure consumer; the "book:" key grammar stays host-side.
  invalidations: {
    onResourceInvalidated,
    isBookResource: (resource) => resource.startsWith(BOOK_RESOURCE_PREFIX),
  },
  // HTTP — api/client is the single /api/v1 seam; the direct <video> src goes
  // through videoUrl (mediaUrl), never a local API_BASE reach.
  http: { getJson, getBlob, retryWithBackoff, videoUrl: mediaUrl },
  shellMode: { isDesktop: () => desktopShell.value },
  i18n: { t },
  icons: {
    Play: IconPlay, Pause: IconPause, VolumeUp: IconVolumeUp, VolumeOff: IconVolumeOff,
    Image: IconImage, ImageOff: IconImageOff, Videocam: IconVideocam, VideocamOff: IconVideocamOff,
    Subtitles: IconSubtitles, SubtitlesOff: IconSubtitlesOff,
    Fullscreen: IconFullscreen, FullscreenExit: IconFullscreenExit,
  },
};
