// P1 regression (docs/05-frontend/PLAYER_STATE_MACHINE_AUDIT_T6.md §11.3): a
// pause (user / tab-hide) or the buffer gate during an in-flight unit seek must
// NOT destroy the SEEKING payload. Before the fix, pausePlayback /
// enterVideoBuffering transitioned SEEKING → PAUSED, so resume landed in
// SHOWING_STORYBOARD with an already-seeked video and no reveal path left
// (video permanently hidden). Fix: SEEKING is sticky — pause/buffer mark
// `paused:true` keeping gate + seekLanded; resume/buffer-exit clear it.
//
// Invariant under test: SEEKING → pause → SEEKING{paused:true} (payload kept) →
// resume → SEEKING{paused:false} → reveal (PLAYING / VIDEO_READY); plain PAUSED
// keeps its old semantics; a buffered seek resumes into the same SEEKING, not
// SHOWING_STORYBOARD.
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
  getPlayerState,
  pausePlayback,
  playSceneQueue,
  preparePlayback,
  resumePlayback,
  seekToPosition,
  stopAll,
  uiState,
  videoVisible,
} from './playbackStore';

/** Minimal media element. currentTime assignments are counted (a seek to the
 *  SAME position — e.g. the unconsumed pendingVideoTargetSec re-apply on
 *  resume — must not count as a new seek, mirroring the browser no-op). */
class FakeMedia {
  preload = 'auto';
  src: string | null = null;
  duration = NaN;
  volume = 1;
  readyState = 0;
  paused = true;
  ended = false;
  buffered = { length: 0, start: () => 0, end: () => 0 };
  seekCount = 0;
  private _currentTime = 0;
  get currentTime(): number { return this._currentTime; }
  set currentTime(v: number) {
    if (v !== this._currentTime) { this._currentTime = v; this.seekCount++; }
  }
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
// u2: 300..600ms (gate for target 300ms: min(300+150, 600−40) = 450ms).
const bookA: SceneRef[] = [{ chapterId: 'ch', sceneId: 'scA1' }, { chapterId: 'ch', sceneId: 'scA2' }];

describe('P1 — sticky SEEKING (pause / buffer must keep the gate)', () => {
  let audios: FakeMedia[];
  let rafQueue: Array<() => void>;
  let intervals: Array<() => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    audios = [];
    rafQueue = [];
    intervals = [];
    // window.setTimeout fires IMMEDIATELY (the 'waiting' debounce lands straight
    // in enterVideoBuffering); window.setInterval is captured — the buffering
    // monitor tick is driven manually. globalThis timers are untouched, so
    // vi.waitFor keeps working.
    vi.stubGlobal('window', {
      setTimeout: (fn: () => void) => { fn(); return 1; },
      clearTimeout: () => {},
      setInterval: (fn: () => void) => { intervals.push(fn); return intervals.length; },
      clearInterval: () => {},
    });
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

  /** External unit tap → SEEKING armed (pendingLoad path → paused:true). */
  async function armSeeking(unitIndex: number, unitId: string): Promise<FakeMedia> {
    const video = await startBook();
    await seekToPosition('ch', 'scA2', unitIndex, unitId);
    checkPendingExternalSeek(); // pendingLoad → SEEKING{landed:false, paused:true}
    await vi.waitFor(() => expect(getPlayerState()).toBe('SEEKING'));
    return video;
  }

  /** Fire a video timeupdate with the given position and a decodable frame. */
  function timeupdate(video: FakeMedia, posSec: number): void {
    video.currentTime = posSec;
    video.readyState = 2; // HAVE_CURRENT_DATA
    video.fire('timeupdate');
  }

  it('TEST A — PLAYING seek → pause before landing keeps SEEKING{paused:true}; resume reveals', async () => {
    const video = await armSeeking(1, 'u1');
    resumePlayback(); // SEEKING{paused:false} — playing variant
    expect(getPlayerState()).toBe('SEEKING');

    pausePlayback(); // SEEKING → SEEKING{paused:true} — payload KEPT (not PAUSED)
    expect(getPlayerState()).toBe('SEEKING');
    expect(uiState.value.phase).toBe('PAUSED');
    expect(videoVisible.value).toBe(false);

    resumePlayback(); // must NOT go SEEKING → SHOWING_STORYBOARD (payload loss)
    expect(getPlayerState()).toBe('SEEKING');

    timeupdate(video, 0.2); // inside u1, past the gate → reveal
    expect(getPlayerState()).toBe('PLAYING');
    expect(videoVisible.value).toBe(true);
  });

  it('TEST B — paused seek → resume keeps the gate; paused reveal stays VIDEO_READY', async () => {
    const video = await armSeeking(1, 'u1'); // SEEKING{landed:false, paused:true}
    // Positioned-pause reveal without resume: VIDEO_READY per contract.
    timeupdate(video, 0.2);
    expect(getPlayerState()).toBe('VIDEO_READY');
    expect(videoVisible.value).toBe(true);

    // Fresh seek → resume keeps the gate (SEEKING, not SHOWING_STORYBOARD) → reveal.
    stopAll();
    const video2 = await armSeeking(1, 'u1');
    resumePlayback();
    expect(getPlayerState()).toBe('SEEKING');
    timeupdate(video2, 0.2);
    expect(getPlayerState()).toBe('PLAYING');
    expect(videoVisible.value).toBe(true);
  });

  it('TEST C — buffer gate during SEEKING keeps the gate; resumeFromBuffering reveals', async () => {
    const video = await armSeeking(1, 'u1');
    resumePlayback(); // SEEKING{paused:false}, phase PLAYING

    video.fire('waiting'); // → (debounce fires immediately) → enterVideoBuffering
    expect(getPlayerState()).toBe('SEEKING'); // gate kept — NOT PAUSED
    expect(uiState.value.phase).toBe('BUFFERING');
    expect(videoVisible.value).toBe(false);

    // Enough data buffered → the monitor resumes: still SEEKING (not
    // SHOWING_STORYBOARD — the payload survived the gate).
    video.buffered = { length: 1, start: () => 0, end: () => video.currentTime + 10 };
    intervals.pop()!();
    expect(getPlayerState()).toBe('SEEKING');
    expect(uiState.value.phase).toBe('PLAYING');

    timeupdate(video, 0.2); // inside u1, past the gate → reveal
    expect(getPlayerState()).toBe('PLAYING');
    expect(videoVisible.value).toBe(true);
  });

  it('TEST D — plain PAUSED (not from SEEKING) keeps its old semantics', async () => {
    const video = await startBook(); // SHOWING_STORYBOARD (no frame yet)
    pausePlayback();
    expect(getPlayerState()).toBe('PAUSED'); // NOT SEEKING — no gate involved
    expect(uiState.value.phase).toBe('PAUSED');

    timeupdate(video, 0.2); // negative: no reveal from plain PAUSED
    expect(getPlayerState()).toBe('PAUSED');
    expect(videoVisible.value).toBe(false);

    resumePlayback(); // storyboard until the first frame (no gate to keep)
    expect(getPlayerState()).toBe('SHOWING_STORYBOARD');
    expect(uiState.value.phase).toBe('PLAYING');
  });

  it('TEST E — pause → resume does not re-seek a video already at its target', async () => {
    const video = await armSeeking(2, 'u2'); // target 300ms, gate 450ms
    expect(video.currentTime).toBeCloseTo(0.3);
    const seeksBeforePause = video.seekCount;
    expect(seeksBeforePause).toBeGreaterThanOrEqual(1);

    pausePlayback(); // sticky: SEEKING{paused:true}
    expect(getPlayerState()).toBe('SEEKING');
    resumePlayback(); // re-applies pendingVideoTargetSec=0.3 → same value → no-op seek
    expect(getPlayerState()).toBe('SEEKING');
    expect(video.currentTime).toBeCloseTo(0.3);
    expect(video.seekCount).toBe(seeksBeforePause); // no second seek

    timeupdate(video, 0.5); // inside u2, past the gate → reveal
    expect(getPlayerState()).toBe('PLAYING');
    expect(videoVisible.value).toBe(true);
    // (no further seekCount check — timeupdate() moves currentTime by design;
    // the "no re-seek on resume" assertion above is the one that matters)
  });
});
