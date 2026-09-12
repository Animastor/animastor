// Host-owned composition of NavigatorPorts
// (docs/architecture/navigator-module-extraction-audit.md, Phase 1 prep).
//
// This file is the ONLY seam where the app's shared infrastructure meets the
// Navigator contract: the Navigator surface consumes `navigatorPorts` and knows
// nothing about the modules below. When the physical package is cut, this wiring
// stays in the host app and becomes the composition root for @animastor/web-navigator.

import { signal } from '@preact/signals';
import { getJson, mediaUrl } from '../api/client';
import { t } from './i18n';
import { navigate } from './router';
import { DESKTOP_SHELL_QUERY } from './desktop';
import { IconImageOff, IconPlay } from './icons';
import { bookId, buildId, onPlaybackPrepared } from '../state/generateStore';
import { navigateTo, position as positionSignal } from '../state/positionStore';
import { bookResource, onResourceInvalidated } from '../state/resourceInvalidations';
import { resilientReload, sharedRecovery } from '../state/resilientReloader';
import { seekToPosition } from '@animastor/web-player';
import type { NavigatorPorts } from '@animastor/web-navigator';

// ShellModePort host implementation: the same query as useDesktopShell
// (min-width: 1180px), backed by a signal so a Navigator rendered through the
// port still re-renders when the shell breakpoint is crossed (behavior parity
// with useDesktopShell's matchMedia listener).
const desktopShell = signal<boolean>(
  typeof window !== 'undefined' ? window.matchMedia(DESKTOP_SHELL_QUERY).matches : false,
);
if (typeof window !== 'undefined') {
  const media = window.matchMedia(DESKTOP_SHELL_QUERY);
  const update = () => { desktopShell.value = media.matches; };
  media.addEventListener('change', update);
}

export const navigatorPorts: NavigatorPorts = {
  seek: { seekToPosition },
  bookSource: {
    bookId,
    buildId,
    onPlaybackPrepared: (fn) => onPlaybackPrepared((prep) => fn({ bookId: prep.bookId, buildId: prep.buildId })),
  },
  position: { position: positionSignal, navigateTo },
  invalidations: { onResourceInvalidated, bookResource },
  reload: {
    resilientReload: (opts) => resilientReload(opts),
    sharedRecovery: () => sharedRecovery(),
  },
  shellMode: { isDesktop: () => desktopShell.value },
  navigation: { navigateToPlay: () => navigate('/play') },
  http: { getJson, mediaUrl },
  i18n: { t },
  icons: { Play: IconPlay, ImageOff: IconImageOff },
};
