// P1-1 contract (docs/05-frontend/PLAYER_STATE_MACHINE_AUDIT_T6.md): the web
// pauseIfPlaying() silent-scene branch (currentPlayer == null && selectedUnit
// != null) must leave a coherent player — playerState=PAUSED AND uiState.phase=
// PAUSED — exactly like the Android autoPauseForBackground → pausePlayback()
// path. The old branch set playerState but left phase=PLAYING (forbidden PAUSED
// + PLAYING combo). (enginePaused was removed as write-only — P2-1.)
//
// The test drives the REAL public flow: preparePlayback → playSceneQueue →
// (mocked fetch) handleSilentChunk delivers a silent scene (SHOWING_STORYBOARD
// + phase PLAYING), then pauseIfPlaying() must produce the coherent pause.
// Network / Cache API / DOM are stubbed — they are irrelevant to this contract.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneRef } from '../api/models';

vi.mock('../api/client', () => ({
  API_BASE: 'http://test',
  getJson: vi.fn(async (url: string) => {
    if (url.includes('/status')) return { audio_ready: true, video_ready: false };
    if (url.includes('/storyboard')) return { ius: [{ unit_id: 'u1', duration_ms: 500, start_ms: 0, text: null }] };
    throw new Error(`unexpected url: ${url}`);
  }),
  getBlob: vi.fn(async () => new Blob([])),
  retryWithBackoff: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../cache/mediaCache', () => ({
  getMedia: vi.fn(async () => undefined),
  putMedia: vi.fn(async () => {}),
  clearCache: vi.fn(async () => 0),
}));
// Cut the runtime-only circular import (generateStore ⇄ playbackStore) and the
// position store — none of them participate in this contract.
vi.mock('./generateStore', () => ({
  onPlaybackPrepared: vi.fn(),
}));
vi.mock('./positionStore', () => ({
  navigateTo: vi.fn(),
  clearPosition: vi.fn(),
  position: { value: null },
}));

import {
  getPlayerState,
  pauseIfPlaying,
  playSceneQueue,
  preparePlayback,
  resumePlayback,
  uiState,
} from './playbackStore';

const silentScene: SceneRef[] = [{ chapterId: 'ch', sceneId: 'sc' } as SceneRef];

/** Drive the store into a playing SILENT scene (no audio player): the mocked
 *  fetch resolves to an empty-audio scene → handleSilentChunk → timer cycling
 *  (SHOWING_STORYBOARD, phase PLAYING, no currentPlayer, selectedUnit set). */
async function playSilentScene(): Promise<void> {
  preparePlayback('book', 'build', silentScene);
  playSceneQueue();
  await vi.waitFor(() => expect(getPlayerState()).toBe('SHOWING_STORYBOARD'));
  expect(uiState.value.phase).toBe('PLAYING');
}

describe('P1-1 — pauseIfPlaying() on a silent scene', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // startSilentIuCycling schedules via window.setTimeout — a no-op keeps the
    // polling loop inert in the test (it must never actually advance units).
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('silent branch → playerState=PAUSED + phase=PAUSED', async () => {
    await playSilentScene();

    // document.hidden → pauseIfPlaying: hits the silent branch
    // (currentPlayer == null && selectedUnit != null).
    pauseIfPlaying();

    expect(getPlayerState()).toBe('PAUSED');
    expect(uiState.value.phase).toBe('PAUSED');
  });

  it('resume after the silent-scene pause restores the playing state (no phase stuck in PAUSED)', async () => {
    await playSilentScene();
    pauseIfPlaying();
    expect(getPlayerState()).toBe('PAUSED');

    resumePlayback();

    // Silent scene has no video frame — the storyboard stays up while the
    // timer cycling resumes; phase returns to PLAYING.
    expect(getPlayerState()).toBe('SHOWING_STORYBOARD');
    expect(uiState.value.phase).toBe('PLAYING');
  });
});
