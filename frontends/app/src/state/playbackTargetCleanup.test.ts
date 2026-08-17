// P2 regression (docs/05-frontend/PLAYER_STATE_MACHINE_AUDIT_T6.md §12): the
// explicit video-timeline target (pendingVideoTargetSec) is stale after a
// successful reveal — the video is already positioned inside the unit (the
// gate is target + tolerance), so the value must be cleared. Before the fix a
// later resumePlayback re-applied the stale target (seek back to the unit
// start when the video had moved on) and attachVideo re-armed a needless
// SEEKING. Fix: one line in the onVideoTimeUpdate reveal branch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneRef } from '../api/models';

// ── Mocked environment (network / Cache API / DOM are irrelevant here) ──────
vi.mock('../api/client', () => ({
  API_BASE: 'http://test',
  getJson: vi.fn(async (url: string) => {
    if (url.includes('/status')) return { audio_ready: true, video_ready: true };
    // Two units on the audio master timeline: u1 0..300ms, u2 300..600ms.
    if (url.includes('/storyboard')) return {
      ius: [
        { unit_id: 'u1', duration_ms: 300, start_ms: 0, text: null },
        { unit_id: 'u2', duration_ms: 300, start_ms: 300, text: null },
      ],
    };
    throw new Error(`unexpected url: ${url}`);
  }),
  getBlob: vi.fn(async () => new Blob([new Uint8Array([1])])),
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
  detachVideo,
  getPendingVideoTargetSec,
  getPlayerState,
  pausePlayback,
  playSceneQueue,
  preparePlayback,
  resumePlayback,
  seekToPosition,
  stopAll,
  videoVisible,
} from './playbackStore';

/** Minimal media element (position driven by the test). */
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
  fire(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  play(): Promise<void> { this.paused = false; return Promise.resolve(); }
  pause(): void { this.paused = true; }
  load(): void {}
  remove(): void {}
  removeAttribute(attr: string): void { if (attr === 'src') this.src = null; }
}

// u1: 0..300ms (gate for target 0: min(0+150, 300−40) = 150ms; end 300ms).
const bookA: SceneRef[] = [{ chapterId: 'ch', sceneId: 'scA1' }, { chapterId: 'ch', sceneId: 'scA2' }];

describe('P2 — pendingVideoTargetSec cleared on successful reveal', () => {
  let audios: FakeMedia[];
  let rafQueue: Array<() => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    audios = [];
    rafQueue = [];
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
      rafQueue.push(fn);
      return rafQueue.length;
    });
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

  /** Open the book and play the first scene (video attached, layer on). */
  async function startBook(): Promise<FakeMedia> {
    stopAll();
    const video = new FakeMedia();
    attachVideo(video as unknown as HTMLVideoElement);
    preparePlayback('bookA', 'buildA', bookA);
    playSceneQueue();
    await vi.waitFor(() => expect(getPlayerState()).toBe('SHOWING_STORYBOARD'));
    return video;
  }

  /** External unit tap on u1 → SEEKING{landed:false, paused:true}, target 0. */
  async function armSeeking(): Promise<FakeMedia> {
    const video = await startBook();
    await seekToPosition('ch', 'scA2', 1, 'u1');
    checkPendingExternalSeek();
    await vi.waitFor(() => expect(getPlayerState()).toBe('SEEKING'));
    return video;
  }

  /** Fire a video timeupdate with the given position and a decodable frame. */
  function timeupdate(video: FakeMedia, posSec: number): void {
    video.currentTime = posSec;
    video.readyState = 2; // HAVE_CURRENT_DATA
    video.fire('timeupdate');
  }

  it('TEST A — direct seek → reveal clears the target', async () => {
    const video = await armSeeking();
    expect(getPendingVideoTargetSec()).toBe(0); // armed, alive before reveal

    timeupdate(video, 0.2); // inside u1, past the gate → paused reveal (VIDEO_READY)
    expect(getPlayerState()).toBe('VIDEO_READY');
    expect(getPendingVideoTargetSec()).toBe(-1); // cleared by the reveal
    expect(videoVisible.value).toBe(true);
  });

  it('TEST B — seek → pause → resume → reveal: target lives until consumed, -1 after', async () => {
    const video = await armSeeking();
    expect(getPendingVideoTargetSec()).toBe(0); // alive before pause

    pausePlayback(); // sticky — target NOT touched by the pause
    expect(getPlayerState()).toBe('SEEKING');
    expect(getPendingVideoTargetSec()).toBe(0);

    resumePlayback(); // consumes the target (applies it) — still before reveal
    expect(getPlayerState()).toBe('SEEKING');
    expect(getPendingVideoTargetSec()).toBe(-1);

    timeupdate(video, 0.2); // reveal
    expect(getPlayerState()).toBe('PLAYING');
    expect(getPendingVideoTargetSec()).toBe(-1);
  });

  it('TEST C — attachVideo after a reveal must NOT re-arm SEEKING from a stale target', async () => {
    const video = await armSeeking();
    timeupdate(video, 0.2); // reveal → VIDEO_READY, target cleared
    expect(getPlayerState()).toBe('VIDEO_READY');
    expect(getPendingVideoTargetSec()).toBe(-1);

    detachVideo();
    expect(getPlayerState()).toBe('PAUSED');
    const video2 = new FakeMedia();
    attachVideo(video2 as unknown as HTMLVideoElement);
    // No stale target → no SEEKING re-armed (audio-sync branch, storyboard up).
    expect(getPlayerState()).toBe('PAUSED');
    expect(getPendingVideoTargetSec()).toBe(-1);
  });

  it('TEST D — resumePlayback after a reveal must NOT re-apply a stale target', async () => {
    const video = await armSeeking();
    timeupdate(video, 0.2); // reveal — the video has moved ON from the target (0)
    expect(getPlayerState()).toBe('VIDEO_READY');
    expect(video.currentTime).toBeCloseTo(0.2);

    pausePlayback(); // VIDEO_READY → stays revealed (target already -1)
    expect(getPlayerState()).toBe('VIDEO_READY');

    resumePlayback(); // must NOT seek the video back to the stale target (0)
    expect(getPlayerState()).toBe('PLAYING');
    expect(video.currentTime).toBeCloseTo(0.2); // position preserved — no jump back
    expect(getPendingVideoTargetSec()).toBe(-1);
  });

  it('plain playback without any seek never arms a target', async () => {
    await startBook();
    expect(getPlayerState()).toBe('SHOWING_STORYBOARD');
    expect(getPendingVideoTargetSec()).toBe(-1);
  });
});
