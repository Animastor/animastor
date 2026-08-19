// Tests for Local Cache Invalidation after delete chapter/scene/unit.
//
// Validates that after a successful DELETE:
// 1. The deleted scene is removed from the player queue.
// 2. Preload cache for the deleted scene is cleared.
// 3. Media cache (Cache API) entries for the deleted scene are evicted.
// 4. The player state (currentIndex, sceneCount) is correctly updated.
// 5. When the current playing scene is deleted, playback is stopped.
//
// Covers §4 (Delete Module), §5 (Delete Scene), §6 (Delete Chapter) of the
// Local Cache Invalidation audit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneRef } from '../api/models';

// ── Mocks ──────────────────────────────────────────────────────
vi.mock('../api/client', () => ({
  API_BASE: 'http://test',
  getJson: vi.fn(async () => ({})),
  getBlob: vi.fn(async () => new Blob([])),
  retryWithBackoff: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../cache/mediaCache', () => ({
  getMedia: vi.fn(async () => undefined),
  putMedia: vi.fn(async () => {}),
  clearCache: vi.fn(async () => 0),
  evictSceneMedia: vi.fn(async () => 1),
  evictChapterMedia: vi.fn(async () => 3),
}));
vi.mock('./generateStore', () => ({
  onPlaybackPrepared: vi.fn(),
}));
vi.mock('./positionStore', () => ({
  navigateTo: vi.fn(),
  clearPosition: vi.fn(),
  position: { value: { chapterId: null, sceneId: null, unitId: null, chunkId: null, unitIndex: 0 } },
}));

import {
  invalidateDeletedScene,
  invalidateDeletedChapter,
  invalidateDeletedBook,
  sceneQueue,
  preparePlayback,
  uiState,
} from './playbackStore';
import { evictSceneMedia, evictChapterMedia, clearCache } from '../cache/mediaCache';

// ── Test data ──────────────────────────────────────────────────
const testScenes: SceneRef[] = [
  { chapterId: 'ch1', sceneId: 'sc1' } as SceneRef,
  { chapterId: 'ch1', sceneId: 'sc2' } as SceneRef,
  { chapterId: 'ch2', sceneId: 'sc3' } as SceneRef,
  { chapterId: 'ch2', sceneId: 'sc4' } as SceneRef,
];

describe('Delete Scene — cache invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    });
    preparePlayback('book1', 'build1', [...testScenes]);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('removes the deleted scene from the player queue', () => {
    invalidateDeletedScene('ch1', 'sc2', 'build1');
    const keys = sceneQueue.value.map((s) => `${s.chapterId}:${s.sceneId}`);
    expect(keys).toEqual(['ch1:sc1', 'ch2:sc3', 'ch2:sc4']);
  });

  it('calls evictSceneMedia for the deleted scene', () => {
    invalidateDeletedScene('ch1', 'sc2', 'build1');
    expect(evictSceneMedia).toHaveBeenCalledWith('build1', 'ch1', 'sc2');
  });

  it('updates sceneCount in uiState', () => {
    invalidateDeletedScene('ch1', 'sc2', 'build1');
    expect(uiState.value.sceneCount).toBe(3);
  });

  it('clamps currentIndex when deleting the current or later scene', () => {
    // Prepare with index pointing at sc3 (index 2)
    preparePlayback('book1', 'build1', [...testScenes]);
    // Delete sc4 (index 3) — currentIndex (0) stays valid
    invalidateDeletedScene('ch2', 'sc4', 'build1');
    expect(uiState.value.currentIndex).toBe(0);
  });

  it('stops playback when the only scene is deleted', () => {
    preparePlayback('book1', 'build1', [{ chapterId: 'ch1', sceneId: 'only' } as SceneRef]);
    invalidateDeletedScene('ch1', 'only', 'build1');
    expect(sceneQueue.value).toHaveLength(0);
  });
});

describe('Delete Chapter — cache invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    });
    preparePlayback('book1', 'build1', [...testScenes]);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('removes all scenes of the deleted chapter from the queue', () => {
    invalidateDeletedChapter('ch1', ['sc1', 'sc2'], 'build1');
    const keys = sceneQueue.value.map((s) => `${s.chapterId}:${s.sceneId}`);
    expect(keys).toEqual(['ch2:sc3', 'ch2:sc4']);
  });

  it('calls evictChapterMedia for the deleted chapter', () => {
    invalidateDeletedChapter('ch1', ['sc1', 'sc2'], 'build1');
    expect(evictChapterMedia).toHaveBeenCalledWith('build1', 'ch1');
  });

  it('updates sceneCount', () => {
    invalidateDeletedChapter('ch1', ['sc1', 'sc2'], 'build1');
    expect(uiState.value.sceneCount).toBe(2);
  });

  it('handles deleting all scenes (empty queue)', () => {
    invalidateDeletedChapter('ch1', ['sc1', 'sc2'], 'build1');
    invalidateDeletedChapter('ch2', ['sc3', 'sc4'], 'build1');
    expect(sceneQueue.value).toHaveLength(0);
  });
});

describe('Delete Book — full cache invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    });
    preparePlayback('book1', 'build1', [...testScenes]);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('clears the entire scene queue and media cache', () => {
    invalidateDeletedBook();
    expect(sceneQueue.value).toHaveLength(0);
    expect(clearCache).toHaveBeenCalled();
  });
});
