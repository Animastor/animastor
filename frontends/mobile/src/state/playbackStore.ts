// PlaybackViewModel equivalent (stub, phases 0/4). Player engine wiring arrives at
// stage 7. Here we expose the public state shape (PlaybackUiState + scene queue)
// and the playback coordinator (MainActivity.setupPlaybackCoordination) so the
// shell and Navigate/Edit/Generate can depend on the fixed API surface.
import { signal } from '@preact/signals';
import type { SceneRef } from './generateStore';
import { onPlaybackPrepared } from './generateStore';

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

export function seekToPosition(_chapterId: string, _sceneId: string, _unitIndex: number): void {
  // Implemented at stage 5/7 (refresh book JSON if scene missing → missingIuPosition overlay).
}

export function closeBook(): void {
  bookId.value = '';
  buildId.value = '';
  sceneQueue.value = [];
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
