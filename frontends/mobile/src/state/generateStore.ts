// GenerateViewModel equivalent stub (phase 0). Holds bookId/buildId, generation
// status (RUNNING/ERROR/SUCCESS/IDLE), VBookStage, and emits `playbackPrepared`
// which MainActivity.setupPlaybackCoordination() forwards to PlaybackViewModel.
import { signal } from '@preact/signals';

export type GenerationStatus = 'IDLE' | 'RUNNING' | 'ERROR' | 'SUCCESS';
export type VBookStage = 'IDLE' | 'COMPLETED' | string;

export interface SceneRef { chapterId: string; sceneId: string; sceneType?: string }
export interface PlaybackPrepared {
  bookId: string;
  buildId: string;
  scenes: SceneRef[];
  coverImage?: Blob;
  softRefresh?: boolean;
}

export const bookId = signal('');
export const buildId = signal('');
export const generationStatus = signal<GenerationStatus>('IDLE');
export const vbookProgressStage = signal<VBookStage>('IDLE');

// Replays the `playbackPrepared` SharedFlow from MainActivity coordinator.
const playbackPreparedListeners = new Set<(prep: PlaybackPrepared) => void>();

export function onPlaybackPrepared(fn: (prep: PlaybackPrepared) => void): () => void {
  playbackPreparedListeners.add(fn);
  return () => {
    playbackPreparedListeners.delete(fn);
  };
}
export function emitPlaybackPrepared(prep: PlaybackPrepared): void {
  playbackPreparedListeners.forEach((f) => f(prep));
}

export function resetGenerationStatus(): void { generationStatus.value = 'IDLE'; }
export function loadBook(id: string, build: string = ''): void {
  bookId.value = id;
  buildId.value = build;
}
