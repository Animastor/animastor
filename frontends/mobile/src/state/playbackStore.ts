// PlaybackViewModel equivalent (stub, phase 0). Player engine wiring arrives at
// stage 7. Here we expose the public state shape (PlaybackUiState + scene queue)
// so the shell and Navigate/Edit can depend on the fixed API surface.
import { signal } from '@preact/signals';
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

export function seekToPosition(_chapterId: string, _sceneId: string, _unitIndex: number): void {
  // Implemented at stage 5/7 (refresh book JSON if scene missing → missingIuPosition overlay).
}

export function closeBook(): void {
  bookId.value = '';
  buildId.value = '';
  sceneQueue.value = [];
  uiState.value = { ...initial };
}
