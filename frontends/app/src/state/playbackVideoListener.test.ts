// P1-2 regression (docs/05-frontend/PLAYER_STATE_MACHINE_AUDIT_T6.md §8, option A):
// playVideoOverlay keeps ONE latest loadedmetadata listener slot (ref
// pendingMetaListener). Contract:
//   - a previous onMeta that never fired is removed before the new src's
//     metadata could trigger it (playVideoOverlay(A) → playVideoOverlay(B)
//     leaves ONLY listener B);
//   - a fired onMeta removes itself;
//   - detachVideo() and stopAll() clear the slot.
//
// The store is driven through its REAL public flow (preparePlayback →
// playSceneQueue → mocked fetch → handleChunk → ensureSceneVideo →
// playVideoOverlay) with a fake <video> element passed via attachVideo() and
// fake audio elements from a stubbed document — no store changes were needed
// for the test.
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
  detachVideo,
  getPlayerState,
  playSceneQueue,
  preparePlayback,
  stopAll,
  uiState,
} from './playbackStore';

/** Minimal media element with a listener registry we can inspect and fire. */
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
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
  fire(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  play(): Promise<void> { this.paused = false; return Promise.resolve(); }
  pause(): void { this.paused = true; }
  load(): void {}
  remove(): void {}
  removeAttribute(attr: string): void { if (attr === 'src') this.src = null; }
}

const sceneA: SceneRef[] = [{ chapterId: 'ch', sceneId: 'scA' }];
const twoScenes: SceneRef[] = [{ chapterId: 'ch', sceneId: 'scA' }, { chapterId: 'ch', sceneId: 'scB' }];

describe('P1-2 — single loadedmetadata listener slot', () => {
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
    // createAudio uses `new Audio()` (not document.createElement) — same fake,
    // tracked so the test can fire 'ended' on the current audio element.
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

  /** Play the first scene (video layer on → playVideoOverlay registers onMeta). */
  async function playFirstScene(scenes: SceneRef[]): Promise<FakeMedia> {
    // Normalize module state from the previous test: stopAll clears the stale
    // videoSrcUrl/currentVideoSceneKey left by the previous detachVideo —
    // otherwise attachVideo re-srcs the OLD scene's URL and handleChunk treats
    // the current scene as "video already attached" (real store quirk, out of
    // P1-2 scope). This also exercises stopAll's listener cleanup on the way.
    stopAll();
    const video = new FakeMedia();
    attachVideo(video as unknown as HTMLVideoElement);
    preparePlayback('book', 'build', scenes);
    playSceneQueue();
    await vi.waitFor(() => expect(getPlayerState()).toBe('SHOWING_STORYBOARD'));
    expect(uiState.value.phase).toBe('PLAYING');
    return video;
  }

  it('playVideoOverlay(B) removes the un-fired listener A — only B remains', async () => {
    const video = await playFirstScene(twoScenes);
    expect(video.listenerCount('loadedmetadata')).toBe(1); // onMeta A

    // Advance to scene B WITHOUT firing A's metadata: the ref-based cleanup
    // in playVideoOverlay must drop A and register B in the same slot.
    audios[0].fire('ended');
    await vi.waitFor(() => expect(video.src).toContain('scB'));

    expect(video.listenerCount('loadedmetadata')).toBe(1); // A removed, B remains
  });

  it('a fired onMeta removes itself; detachVideo clears the slot', async () => {
    const video = await playFirstScene(sceneA);
    expect(video.listenerCount('loadedmetadata')).toBe(1);

    video.fire('loadedmetadata'); // onMeta A self-removes (and clears the ref)
    expect(video.listenerCount('loadedmetadata')).toBe(0);

    detachVideo();
    expect(video.listenerCount('loadedmetadata')).toBe(0); // nothing left to clear
  });

  it('stopAll clears the slot', async () => {
    const video = await playFirstScene(twoScenes);
    expect(video.listenerCount('loadedmetadata')).toBe(1);

    audios[0].fire('ended'); // advance to B — B's listener is now in the slot
    await vi.waitFor(() => expect(video.src).toContain('scB'));
    expect(video.listenerCount('loadedmetadata')).toBe(1);

    stopAll();
    expect(video.listenerCount('loadedmetadata')).toBe(0);
  });
});
