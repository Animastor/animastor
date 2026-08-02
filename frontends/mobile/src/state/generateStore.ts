// GenerateViewModel equivalent (stages 0/3). Holds bookId/buildId, generation
// status (RUNNING/ERROR/SUCCESS/IDLE), VBookStage, and emits `playbackPrepared`
// which MainActivity.setupPlaybackCoordination() forwards to PlaybackViewModel.
// Stage 3 adds the File-screen slice of GenUiState (phase, importMessages,
// errorMessage), isExporting/exportProgress, and the unified import flow
// (importBookFromFile / openBookById / closeBook) with one-shot navigation events.
import { signal } from '@preact/signals';
import { getJson, postJson, postMultipart } from '../api/client';
import type { AssetsStateResponse, BookData, ImportResponse } from '../api/models';
import { sceneRefs } from '../api/models';
import type { SceneRef } from '../api/models';
import { navigateTo, clearPosition } from './positionStore';

export type GenerationStatus = 'IDLE' | 'RUNNING' | 'ERROR' | 'SUCCESS';
export type VBookStage = 'IDLE' | 'COMPLETED' | string;

// Re-export (playbackStore imports SceneRef from this module; single source of
// truth lives in api/models.ts).
export type { SceneRef };
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

// ═══════════════════════════════════════════════════════════════
//  FILE SCREEN STATE (stage 3) — 1:1 with the GenUiState slice
//  FileFragment consumes + GenerateViewModel.isExporting/exportProgress
// ═══════════════════════════════════════════════════════════════

export type PlayerPhase =
  | 'IDLE' | 'LOADING_BOOK' | 'GENERATING' | 'DOWNLOADING'
  | 'SCENE_READY' | 'PLAYING' | 'PAUSED' | 'IMPORTING_TXT';

export const phase = signal<PlayerPhase>('IDLE');
export const importMessages = signal<string[]>([]);
export const errorMessage = signal<string | null>(null);
export const isExporting = signal(false);
export const exportProgress = signal(0);

/** One-shot navigation request emitted by the import/deep-link flow
 *  (GenerateViewModel.NavigationEvent equivalent). Consumed by FilePage,
 *  which resets it — so a new import never double-navigates. */
export const navigationEvent = signal<'play' | 'generate' | null>(null);

export function setExporting(v: boolean): void {
  isExporting.value = v;
  if (!v) exportProgress.value = 0;
}
export function setExportProgress(v: number): void {
  exportProgress.value = v;
}

/** closeBook() — GenerateViewModel.closeBook equivalent (Create New Book card). */
export function closeBook(): void {
  loadBook('', '');
  phase.value = 'IDLE';
  errorMessage.value = null;
  importMessages.value = [];
  navigationEvent.value = null;
  clearPosition();
}

// ═══════════════════════════════════════════════════════════════
//  UNIFIED IMPORT — POST /book/import (server-side format detection)
//  Mirrors GenerateViewModel.importBookFromFile: loads the book, emits
//  playbackPrepared, and requests navigation to Play/Generate depending on
//  format + scene list + asset availability.
// ═══════════════════════════════════════════════════════════════

export async function importBookFromFile(file: File): Promise<void> {
  phase.value = 'LOADING_BOOK';
  errorMessage.value = null;
  importMessages.value = [];
  navigationEvent.value = null;
  try {
    const res = await postMultipart<ImportResponse>('/book/import', file, 'file', file.name);
    const bId = res.book_id;
    loadBook(bId, res.build_id ?? '');
    const bookData = await getJson<BookData>(`/book/${encodeURIComponent(bId)}`).catch(() => null);
    const scenes = bookData ? sceneRefs(bookData) : [];
    const first = scenes.find((s) => s.sceneType === 'cover') ?? scenes[0] ?? null;
    navigateTo({ chapterId: first?.chapterId ?? null, sceneId: first?.sceneId ?? null, unitIndex: 0 });

    if (res.format === 'vbook') {
      // snapshot is a server-side convenience — non-fatal if it fails
      void postJson(`/book/${encodeURIComponent(bId)}/snapshot`).catch(() => {});
      emitPlaybackPrepared({ bookId: bId, buildId: buildId.value, scenes });
      phase.value = scenes.length ? 'SCENE_READY' : 'IDLE';
      navigationEvent.value = scenes.length ? 'play' : 'generate';
    } else {
      // TXT path — technical steps shown on the File screen (take(4))
      importMessages.value = ['✓ File selected', '✓ TXT read', '✓ Encoding detected', '✓ VBook structure created'];
      phase.value = 'IMPORTING_TXT';
      emitPlaybackPrepared({ bookId: bId, buildId: buildId.value, scenes });
      const assets = await getJson<AssetsStateResponse>(`/book/${encodeURIComponent(bId)}/assets-state`).catch(() => null);
      phase.value = scenes.length ? 'SCENE_READY' : 'IDLE';
      navigationEvent.value = scenes.length && assets?.has_assets ? 'play' : 'generate';
    }
  } catch (e) {
    phase.value = 'IDLE';
    errorMessage.value = (e as Error).message || 'Import failed';
  }
}

// ═══════════════════════════════════════════════════════════════
//  DEEP LINK — /file?book=<id> (or ?open=<id>)
//  Web equivalent of the .vbook ACTION_VIEW intent: the linked file is already
//  on the server, so we load it by id (GET /book/{id}) instead of uploading
//  bytes, then follow the same importBookFromFile navigation logic. §12.
// ═══════════════════════════════════════════════════════════════

export async function openBookById(param: string): Promise<void> {
  let id = decodeURIComponent(param).trim();
  // tolerate copy-pasted download URLs (…/book/<id>/download → last segment)
  if (id.includes('/')) id = id.split('/').filter(Boolean).pop() ?? id;
  if (!id) return;
  phase.value = 'LOADING_BOOK';
  errorMessage.value = null;
  importMessages.value = [];
  navigationEvent.value = null;
  try {
    const bookData = await getJson<BookData>(`/book/${encodeURIComponent(id)}`);
    const bId = bookData.manifest?.book_id || id;
    loadBook(bId, bookData.manifest?.build_id || '');
    const scenes = sceneRefs(bookData);
    const first = scenes.find((s) => s.sceneType === 'cover') ?? scenes[0] ?? null;
    navigateTo({ chapterId: first?.chapterId ?? null, sceneId: first?.sceneId ?? null, unitIndex: 0 });
    emitPlaybackPrepared({ bookId: bId, buildId: buildId.value, scenes });
    const assets = await getJson<AssetsStateResponse>(`/book/${encodeURIComponent(bId)}/assets-state`).catch(() => null);
    phase.value = scenes.length ? 'SCENE_READY' : 'IDLE';
    navigationEvent.value = scenes.length && assets?.has_assets ? 'play' : 'generate';
  } catch (e) {
    phase.value = 'IDLE';
    errorMessage.value = (e as Error).message || 'Book not found';
  }
}
