// PlaybackViewModel equivalent (stub, phases 0/4/5). Player engine wiring arrives at
// stage 7. Here we expose the public state shape (PlaybackUiState + scene queue)
// and the playback coordinator (MainActivity.setupPlaybackCoordination) so the
// shell and Navigate/Edit/Generate can depend on the fixed API surface.
// Stage 5 adds seekToPosition (refresh book JSON when the scene is missing →
// missingIuPosition overlay) consumed by Navigate/Edit and shown by PlayPage.
import { signal } from '@preact/signals';
import { getJson } from '../api/client';
import type { BookData } from '../api/models';
import { sceneRefs } from '../api/models';
import { navigateTo } from './positionStore';
import type { ActivePosition } from './positionStore';
import { onPlaybackPrepared } from './generateStore';
import type { SceneRef } from './generateStore';

export type PlayerPhase =
  | 'IDLE' | 'LOADING_BOOK' | 'GENERATING' | 'DOWNLOADING'
  | 'SCENE_READY' | 'PLAYING' | 'PAUSED' | 'IMPORTING_TXT';

export interface PlaybackUiState {
  phase: PlayerPhase;
  errorMessage: string | null;
  sceneCount: number;
  currentIndex: number;
  currentUnitIndex: number;
}

const initial: PlaybackUiState = {
  phase: 'IDLE', errorMessage: null, sceneCount: 0, currentIndex: 0, currentUnitIndex: 0
};

export const uiState = signal<PlaybackUiState>(initial);
export const bookId = signal('');
export const buildId = signal('');
export const sceneQueue = signal<SceneRef[]>([]);

// ── External seek (PlaybackViewModel.pendingExternalSeek / missingIuPosition) ──
// Stage 5: Navigate/Edit set these; PlayFragment (stage 7) executes the seek and
// the Play screen shows the missing-IU overlay while missingIuPosition is set.
export const missingIuPosition = signal<ActivePosition | null>(null);
export const pendingExternalSeek = signal<ActivePosition | null>(null);
export const layerAudio = signal(true);
export const layerImage = signal(true);
export const layerVideo = signal(true);
export const layerSubtitles = signal(true);

export function preparePlayback(bId: string, bBuild: string, scenes: SceneRef[]): void {
  bookId.value = bId;
  buildId.value = bBuild;
  sceneQueue.value = scenes;
  uiState.value = {
    ...uiState.value,
    phase: scenes.length ? 'SCENE_READY' : 'IDLE',
    sceneCount: scenes.length,
    currentIndex: 0,
    currentUnitIndex: 0
  };
}

// Soft refresh after generation completes (PlaybackViewModel.refreshContent):
// same book, potentially new scenes/build — keep current playback position.
// Stage 7 expands this into the full soft-refresh pipeline.
export function refreshContent(bId: string, bBuild: string, scenes: SceneRef[]): void {
  bookId.value = bId;
  buildId.value = bBuild;
  sceneQueue.value = scenes;
  uiState.value = { ...uiState.value, sceneCount: scenes.length };
}

/**
 * External seek from Navigate/Edit — 1:1 with PlaybackViewModel.seekToPosition:
 *  - scene in queue → set pendingExternalSeek + move currentIndex (player runs it).
 *  - scene NOT in queue → refresh the queue from book JSON (generation may have
 *    changed the book since the queue was built); if still missing → set
 *    missingIuPosition so Play shows the "not generated" overlay.
 *  - no book at all → missingIuPosition directly.
 */
export async function seekToPosition(chapterId: string, sceneId: string, unitIndex: number, unitId: string | null = null): Promise<void> {
  const sceneKey = `${chapterId}:${sceneId}`;
  const idx = sceneQueue.value.findIndex((s) => `${s.chapterId}:${s.sceneId}` === sceneKey);
  if (idx >= 0) {
    missingIuPosition.value = null;
    pendingExternalSeek.value = { chapterId, sceneId, unitId, chunkId: sceneKey, unitIndex };
    uiState.value = { ...uiState.value, currentIndex: idx };
    return;
  }

  const bId = bookId.value;
  if (!bId) {
    missingIuPosition.value = { chapterId, sceneId, unitId, chunkId: null, unitIndex };
    pendingExternalSeek.value = null;
    return;
  }

  // Refresh scene queue from book JSON (PlaybackViewModel.kt:449 path).
  try {
    const bookData = await getJson<BookData>(`/book/${encodeURIComponent(bId)}`);
    const allScenes = sceneRefs(bookData);
    const allKeys = allScenes.map((s) => `${s.chapterId}:${s.sceneId}`);
    const newIdx = allKeys.indexOf(sceneKey);
    if (newIdx >= 0) {
      sceneQueue.value = allScenes;
      missingIuPosition.value = null;
      pendingExternalSeek.value = { chapterId, sceneId, unitId, chunkId: sceneKey, unitIndex };
      uiState.value = { ...uiState.value, currentIndex: newIdx, sceneCount: allScenes.length };
    } else {
      missingIuPosition.value = { chapterId, sceneId, unitId, chunkId: null, unitIndex };
      pendingExternalSeek.value = null;
    }
  } catch {
    missingIuPosition.value = { chapterId, sceneId, unitId, chunkId: null, unitIndex };
    pendingExternalSeek.value = null;
  }
}

/** Execute the pending external seek (PlaybackViewModel.executePendingSeek).
 *  Stage 5 applies position + state only; the audio engine (stage 7) fills in
 *  the actual DOWNLOADING→PLAYING pipeline. */
export function executePendingSeek(): void {
  const seek = pendingExternalSeek.value;
  if (!seek) return;
  pendingExternalSeek.value = null;
  if (seek.chapterId && seek.sceneId) {
    navigateTo({ ...seek });
  }
  missingIuPosition.value = null;
  uiState.value = { ...uiState.value, currentUnitIndex: seek.unitIndex, phase: 'SCENE_READY' };
}

export function clearMissingIu(): void {
  missingIuPosition.value = null;
}

export function closeBook(): void {
  bookId.value = '';
  buildId.value = '';
  sceneQueue.value = [];
  missingIuPosition.value = null;
  pendingExternalSeek.value = null;
  uiState.value = { ...initial };
}

// ── Playback coordinator (MainActivity.setupPlaybackCoordination) ──
// Observes generateStore.playbackPrepared and forwards to preparePlayback or
// refreshContent depending on softRefresh. Wired once from main.tsx.
let wired = false;
export function wirePlaybackCoordination(): void {
  if (wired) return;
  wired = true;
  onPlaybackPrepared((prep) => {
    if (prep.softRefresh) {
      refreshContent(prep.bookId, prep.buildId, prep.scenes);
    } else {
      preparePlayback(prep.bookId, prep.buildId, prep.scenes);
    }
    if (prep.coverImage != null) {
      // stage 7: setCoverImage(prep.coverImage)
    }
  });
}
