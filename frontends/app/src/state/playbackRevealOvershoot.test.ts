// P2-4 regression (docs/05-frontend/PLAYER_STATE_MACHINE_AUDIT_T6.md §10): the
// unit-seek reveal gate must not permanently lock the video hidden when the
// position crosses the gate already past the selected unit's end (overshoot).
// Root cause: P0-1 made the seek land once (seekLanded flip by position) and
// the guard `!videoSeekInFlight()` then bailed forever, so a tick where
// withinUnit=false could never retry. Fix: guard on `playerState.name !==
// 'SEEKING'` — every tick re-evaluates the AND-gate, and the reveal fires on
// the first tick where withinUnit becomes true.
//
// Invariant under test: SEEKING + seekLanded=true + frame ready + gate reached
// + withinUnit=true ⇒ reveal MUST happen (PLAYING when playing, VIDEO_READY
// when paused); while withinUnit=false the video must NOT reveal.
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

/** Minimal media element. readyState/currentTime/duration are driven by the test. */
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

// u1: 0..300ms, u2: 300..600ms — reveal gate for a seek to u1 (target 0) is
// min(0 + 150ms, 300ms − 40ms) = 150ms; u1's end is 300ms.
const bookA: SceneRef[] = [{ chapterId: 'ch', sceneId: 'scA1' }, { chapterId: 'ch', sceneId: 'scA2' }];

describe('P2-4 — reveal gate survives unit-end overshoot (web)', () => {
  let audios: FakeMedia[];
  let rafQueue: Array<() => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    audios = [];
    rafQueue = [];
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
    // Capture the cycling ticks instead of discarding them — the test drives
    // the "selectedUnit switches to the next unit" step through the REAL
    // startIuCycling tick (runCyclingTick below).
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

  /** External unit tap on scA2/u1 → SEEKING armed for u1 (gate 150ms). */
  async function armSeeking(): Promise<FakeMedia> {
    const video = await startBook();
    await seekToPosition('ch', 'scA2', 1, 'u1');
    checkPendingExternalSeek(); // pendingLoad → SEEKING{landed:false, paused:true}
    await vi.waitFor(() => expect(getPlayerState()).toBe('SEEKING'));
    return video;
  }

  /** Run one captured startIuCycling tick (maps the AUDIO position to a unit). */
  function runCyclingTick(): void {
    const tick = rafQueue.pop();
    if (tick) tick();
  }

  /** Fire a video timeupdate with the given position and a decodable frame. */
  function timeupdate(video: FakeMedia, posSec: number): void {
    video.currentTime = posSec;
    video.readyState = 2; // HAVE_CURRENT_DATA
    video.fire('timeupdate');
  }

  it('overshoot does NOT reveal while withinUnit=false and does NOT lock — reveal after selectedUnit advances', async () => {
    const video = await armSeeking();
    resumePlayback(); // SEEKING{landed:false, paused:false} — playing variant
    expect(getPlayerState()).toBe('SEEKING');

    // First tick: pos crosses the gate (150ms) but is already PAST u1's end
    // (300ms) — withinUnit=false. Must flip the landing but NOT reveal.
    timeupdate(video, 0.35);
    expect(getPlayerState()).toBe('SEEKING'); // no reveal on overshoot
    expect(videoVisible.value).toBe(false);

    // The audio moves into u2; the real cycling tick switches selectedUnit to u2.
    audios.at(-1)!.currentTime = 0.35;
    audios.at(-1)!.duration = 10;
    runCyclingTick();

    // Next timeupdate: withinUnit=true now → reveal MUST happen (PLAYING).
    timeupdate(video, 0.35);
    expect(getPlayerState()).toBe('PLAYING');
    expect(videoVisible.value).toBe(true);
  });

  it('negative: while withinUnit=false the video never reveals (multiple ticks)', async () => {
    const video = await armSeeking();
    resumePlayback();

    timeupdate(video, 0.35);
    expect(getPlayerState()).toBe('SEEKING');
    timeupdate(video, 0.4); // deeper into u2, but selectedUnit is still u1
    expect(getPlayerState()).toBe('SEEKING');
    timeupdate(video, 0.5);
    expect(getPlayerState()).toBe('SEEKING');
    expect(videoVisible.value).toBe(false);
  });

  it('happy path: seek → gate → withinUnit=true → reveal on the same tick', async () => {
    const video = await armSeeking();
    resumePlayback();

    timeupdate(video, 0.2); // >= gate (150ms) and inside u1 (< 300ms)
    expect(getPlayerState()).toBe('PLAYING');
    expect(videoVisible.value).toBe(true);
  });

  it('paused seek reveals as VIDEO_READY (not PLAYING)', async () => {
    const video = await armSeeking(); // SEEKING{landed:false, paused:true} (pendingLoad)
    expect(getPlayerState()).toBe('SEEKING');

    timeupdate(video, 0.2); // inside u1, past the gate
    expect(getPlayerState()).toBe('VIDEO_READY'); // paused → revealed but held
    expect(videoVisible.value).toBe(true);
  });

  it('pause before reveal keeps the gate (sticky SEEKING, §11.3) — no reveal while withinUnit=false', async () => {
    const video = await armSeeking();
    // P1 fix: a pause during an in-flight seek must NOT drop the SEEKING
    // payload — SEEKING → SEEKING{paused:true}, not PAUSED.
    pausePlayback();
    expect(getPlayerState()).toBe('SEEKING');
    expect(uiState.value.phase).toBe('PAUSED');
    expect(videoVisible.value).toBe(false);

    timeupdate(video, 0.35); // pos past gate AND past u1's end — withinUnit=false, must NOT reveal
    expect(getPlayerState()).toBe('SEEKING');
    expect(videoVisible.value).toBe(false);

    // Resume keeps the gate (never SEEKING → SHOWING_STORYBOARD with payload
    // loss): still no reveal while withinUnit=false...
    resumePlayback();
    expect(getPlayerState()).toBe('SEEKING');
    timeupdate(video, 0.35);
    expect(getPlayerState()).toBe('SEEKING');
    expect(videoVisible.value).toBe(false);

    // ...and the reveal fires once selectedUnit/position enters the unit.
    audios.at(-1)!.currentTime = 0.35;
    audios.at(-1)!.duration = 10;
    runCyclingTick();
    timeupdate(video, 0.35);
    expect(getPlayerState()).toBe('PLAYING');
    expect(videoVisible.value).toBe(true);
  });
});
