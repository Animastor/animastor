// P2-3 regression (docs/05-frontend/PLAYER_STATE_MACHINE_AUDIT_T6.md §9): a web
// book switch (preparePlayback with a different bookId) must not leak the OLD
// book's player state into the new playback — stale selectedUnit /
// currentIuBlobUrl (PlayPage renders it on SCENE_READY), still-playing audio,
// stale video attachment and one-shot intents. The fix: stopAll() + one-shot
// reset inside the existing `prevBookId !== bId` branch of preparePlayback.
//
// Tests A–D drive the REAL public flow (preparePlayback → playSceneQueue →
// mocked fetch → handleChunk) with fake media elements:
//   A: Book A PLAYING  → Book B → audio stopped, state clean, B starts.
//   B: Book A PAUSED   → Book B → no stale A state, B starts.
//   C: Book A SEEKING  → Book B → stale seek does not execute against B.
//   D: Book A selected → Book B SCENE_READY → currentIuBlobUrl === null.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneRef } from '../api/models';

// ── Mocked environment (network / Cache API / DOM are irrelevant here) ──────
vi.mock('../api/client', () => ({
  API_BASE: 'http://test',
  getJson: vi.fn(async (url: string) => {
    if (url.includes('/status')) return { audio_ready: true, video_ready: true };
    if (url.includes('/storyboard')) return { ius: [{ unit_id: 'u1', duration_ms: 500, start_ms: 0, text: null }] };
    throw new Error(`unexpected url: ${url}`);
  }),
  getBlob: vi.fn(async () => new Blob([new Uint8Array([1])])), // non-empty audio + iu image
  retryWithBackoff: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../cache/mediaCache', () => ({
  getMedia: vi.fn(async () => undefined),
  putMedia: vi.fn(async () => {}),
  clearCache: vi.fn(async () => 0),
}));
vi.mock('./generateStore', () => ({
  onPlaybackPrepared: vi.fn(),
}));
vi.mock('./positionStore', () => ({
  navigateTo: vi.fn(),
  clearPosition: vi.fn(),
  position: { value: null },
}));

import {
  attachVideo,
  checkPendingExternalSeek,
  currentIuBlobUrl,
  getPlayerState,
  pausePlayback,
  playSceneQueue,
  preparePlayback,
  seekToPosition,
  stopAll,
  uiState,
} from './playbackStore';

/** Minimal media element with a listener registry. */
class FakeMedia {
  preload = 'auto';
  src: string | null = null;
  currentTime = 0;
  duration = NaN;
  volume = 1;
  readyState = 0;
  paused = true;
  ended = false;
  buffered = { length: 0, start: () => 0, end: () => 0 };
  private listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  play(): Promise<void> { this.paused = false; return Promise.resolve(); }
  pause(): void { this.paused = true; }
  load(): void {}
  remove(): void {}
  removeAttribute(attr: string): void { if (attr === 'src') this.src = null; }
}

const bookA: SceneRef[] = [{ chapterId: 'ch', sceneId: 'scA1' }, { chapterId: 'ch', sceneId: 'scA2' }];
const bookB: SceneRef[] = [{ chapterId: 'ch', sceneId: 'scB1' }];

describe('P2-3 — book switch resets stale player state', () => {
  let audios: FakeMedia[];

  beforeEach(() => {
    vi.clearAllMocks();
    audios = [];
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        if (tag === 'audio') {
          const a = new FakeMedia();
          audios.push(a);
          return a;
        }
        return { style: {}, appendChild: () => {} };
      },
      body: { appendChild: () => {} },
    });
    const audioCtor = function (this: unknown) {
      const a = new FakeMedia();
      audios.push(a);
      return a;
    } as unknown as typeof Audio;
    vi.stubGlobal('Audio', audioCtor);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Open a book and play its first scene (video layer on → playVideoOverlay). */
  async function startBook(bId: string, buildId: string, scenes: SceneRef[]): Promise<FakeMedia> {
    stopAll(); // normalize module state across tests
    const video = new FakeMedia();
    attachVideo(video as unknown as HTMLVideoElement);
    preparePlayback(bId, buildId, scenes);
    playSceneQueue();
    await vi.waitFor(() => expect(getPlayerState()).toBe('SHOWING_STORYBOARD'));
    expect(uiState.value.phase).toBe('PLAYING');
    return video;
  }

  /** Open book B (the real book-switch path: no closeBook/stopAll in between). */
  function switchToBookB(): void {
    preparePlayback('bookB', 'buildB', bookB);
  }

  it('TEST A: Book A PLAYING → Book B: old audio stopped, state clean, B starts normally', async () => {
    const video = await startBook('bookA', 'buildA', bookA);
    const audioA = audios[0];
    expect(audioA.paused).toBe(false);        // A is playing
    expect(currentIuBlobUrl.value).toBe('blob:mock'); // A's unit image is live

    switchToBookB();

    expect(getPlayerState()).toBe('IDLE');    // no stale selection → clean state
    expect(currentIuBlobUrl.value).toBeNull(); // no stale A image
    expect(audioA.paused).toBe(true);          // old audio STOPPED
    expect(video.src).toBeNull();              // old video detached

    playSceneQueue();                          // Book B starts normally
    await vi.waitFor(() => expect(getPlayerState()).toBe('SHOWING_STORYBOARD'));
    expect(uiState.value.phase).toBe('PLAYING');
    expect(video.src).toContain('scB1');
  });

  it('TEST B: Book A PAUSED → Book B: no stale A state, B starts normally', async () => {
    await startBook('bookA', 'buildA', bookA);
    pausePlayback();
    expect(getPlayerState()).toBe('PAUSED');
    expect(uiState.value.phase).toBe('PAUSED');

    switchToBookB();

    expect(getPlayerState()).toBe('IDLE');
    expect(currentIuBlobUrl.value).toBeNull();
    expect(uiState.value.phase).toBe('SCENE_READY');

    playSceneQueue();
    await vi.waitFor(() => expect(getPlayerState()).toBe('SHOWING_STORYBOARD'));
    expect(uiState.value.phase).toBe('PLAYING');
  });

  it('TEST C: Book A SEEKING → Book B: stale seek from A does not execute against B', async () => {
    const video = await startBook('bookA', 'buildA', bookA);
    // External unit seek on book A → SEEKING armed with A's gate/target.
    await seekToPosition('ch', 'scA2', 1, 'u1');
    checkPendingExternalSeek();
    await vi.waitFor(() => expect(getPlayerState()).toBe('SEEKING'));

    switchToBookB();

    expect(getPlayerState()).toBe('IDLE');     // SEEKING + stale gate dropped
    expect(currentIuBlobUrl.value).toBeNull();
    expect(video.src).toBeNull();              // old video attachment cleared

    playSceneQueue();
    await vi.waitFor(() => expect(getPlayerState()).toBe('SHOWING_STORYBOARD'));
    expect(uiState.value.phase).toBe('PLAYING');
    expect(video.src).toContain('scB1');
    expect(audios.at(-1)!.currentTime).toBe(0); // no stale position seek from A
  });

  it('TEST D: Book A unit selected → Book B SCENE_READY before first handleChunk → currentIuBlobUrl null', async () => {
    await startBook('bookA', 'buildA', bookA);
    expect(currentIuBlobUrl.value).toBe('blob:mock'); // A's unit image is live

    switchToBookB(); // B reaches SCENE_READY without any scene delivered yet

    expect(uiState.value.phase).toBe('SCENE_READY');
    expect(getPlayerState()).toBe('IDLE');
    expect(currentIuBlobUrl.value).toBeNull(); // PlayPage must NOT render A's image
  });
});
