// Host-owned composition of FilePorts
// (docs/architecture/file-module-extraction-audit.md, Phase 1 prep + B1 split).
//
// This file is the ONLY seam where the app's shared infrastructure meets the
// File contract: the File surface consumes `filePorts` and knows nothing about
// the modules below. When the physical package is cut, this wiring stays in the
// host app and becomes the composition root for @animastor/file.
//
// Since the B1 split the File STATE itself is host-owned in
// `state/fileStore.ts`; this root binds it to the shared session identity and
// the generation/player seams:
//
//   FilePage
//      ↓
//   FilePorts (modules/file/ports.ts)
//      ↓
//   fileAdapters (this file — the single composition seam)
//      ├── state/fileStore          ← File-owned state + flows
//      ├── state/generateStore      ← shared session identity + status (B6)
//      ├── state/playbackStore      ← player release port (former cycle leg)
//      ├── api/client / router / i18n / lib/ui / icons
//
// `wireFileStore` runs once at module load, BEFORE any File flow can run
// (main.tsx imports this module before calling restoreBookSession).

import { getBlob } from '../api/client';
import { t, tf } from './i18n';
import { navigate } from './router';
import { toast } from '../lib/ui';
import { IconFolder, IconAdd, IconLibrary, IconDownload, IconImage, IconVolumeUp, IconVideo } from './icons';
import {
  bookId, buildId, phase, errorMessage, dirtySummary, blankBookJustCreated,
  loadBook, emitPlaybackPrepared,
  resetProgressState, clearVBookProgress, setRegenerating, bumpVBookPollToken,
  markImportIncomplete, stopGenerationSession,
} from '../state/generateStore';
// Player release port — the former generateStore ⇄ playbackStore cycle leg
// (closeBook's closePlayerBook), now an injected call through fileStore.
import { closeBook as closePlayerBook } from '../state/playbackStore';
import {
  importMessages, isExporting, navigationEvent,
  importBookFromFile, openBookById, closeBook, createBlankBook, setExporting, setExportProgress,
  wireFileStore,
} from '../state/fileStore';
import type { FilePorts, FileRoute } from '@animastor/file';

// ── Bind the File store to the shared seams (host-owned single wiring) ──
wireFileStore({
  generationReset: {
    resetProgressState, clearVBookProgress, setRegenerating,
    bumpVBookPollToken, markImportIncomplete, stopGenerationSession,
  },
  playbackPrepared: { emit: emitPlaybackPrepared },
  player: { closeBook: closePlayerBook },
  session: { bookId, buildId, phase, errorMessage, dirtySummary, blankBookJustCreated, loadBook },
});

// The desktop shell's "Open" action (AppShell DesktopStartState) reaches the
// always-mounted File panel via this window CustomEvent — the frozen form of
// the AppShell ↔ File hidden contract (audit hidden dep #1).
export const OPEN_FILE_EVENT = 'animastor:open-file';

// Deep-link URL grammar (?book=<id> / ?open=<id>) — read + strip, exactly as
// FilePage did inline before the boundary prep (audit hidden dep #3).
function takeBookParam(): string | null {
  const params = new URLSearchParams(location.search);
  const bookParam = params.get('book') ?? params.get('open');
  if (bookParam) {
    history.replaceState(null, '', location.pathname + location.hash);
  }
  return bookParam;
}

export const filePorts: FilePorts = {
  session: { bookId, buildId, phase, errorMessage, importMessages, isExporting, navigationEvent },
  actions: { importBookFromFile, openBookById, closeBook, createBlankBook, setExporting, setExportProgress },
  http: {
    getBlob: (path, onProgress) => getBlob(path, undefined, onProgress),
  },
  i18n: { t, tf },
  toast: { toast },
  navigation: { navigate: (route: FileRoute) => navigate(route) },
  openRequests: {
    onOpenRequest: (fn) => {
      const handler = () => fn();
      window.addEventListener(OPEN_FILE_EVENT, handler);
      return () => window.removeEventListener(OPEN_FILE_EVENT, handler);
    },
  },
  deepLink: { takeBookParam },
  icons: { Folder: IconFolder, Add: IconAdd, Library: IconLibrary, Download: IconDownload, Image: IconImage, VolumeUp: IconVolumeUp, Video: IconVideo },
};
