// Tests for mediaCache scene/chapter-level eviction functions.
//
// Covers §7 (Web Cache API) of the Local Cache Invalidation audit:
// - evictSceneMedia: evicts only the entries for a specific scene
// - evictChapterMedia: evicts all entries for a chapter (all its scenes)
// - Ensures correct cache key format and no invalid keys (e.g. "//ch-...")
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Cache API
const mockCacheStore = new Map<string, Response>();

function mockCacheKey(url: string): { url: string } {
  return { url };
}

vi.stubGlobal('caches', {
  open: vi.fn(async () => ({
    match: vi.fn(async (req: string | { url: string }) => {
      const key = typeof req === 'string' ? req : req.url;
      return mockCacheStore.get(key) ?? undefined;
    }),
    put: vi.fn(async (key: string, response: Response) => {
      mockCacheStore.set(key, response);
    }),
    delete: vi.fn(async (key: string | { url: string }) => {
      const k = typeof key === 'string' ? key : key.url;
      return mockCacheStore.delete(k);
    }),
    keys: vi.fn(async () => {
      return [...mockCacheStore.keys()].map(mockCacheKey);
    }),
  })),
});

import { evictSceneMedia, evictChapterMedia } from './mediaCache';

describe('evictSceneMedia', () => {
  beforeEach(() => {
    mockCacheStore.clear();
  });

  it('evicts only entries for the specified scene', async () => {
    // Populate cache with entries for different scenes
    mockCacheStore.set('/build1/ch1:sc1/audio', new Response('a1'));
    mockCacheStore.set('/build1/ch1:sc1/video', new Response('v1'));
    mockCacheStore.set('/build1/ch1:sc2/audio', new Response('a2'));
    mockCacheStore.set('/build1/ch2:sc3/audio', new Response('a3'));

    const evicted = await evictSceneMedia('build1', 'ch1', 'sc1');
    expect(evicted).toBe(2);
    expect(mockCacheStore.has('/build1/ch1:sc1/audio')).toBe(false);
    expect(mockCacheStore.has('/build1/ch1:sc1/video')).toBe(false);
    expect(mockCacheStore.has('/build1/ch1:sc2/audio')).toBe(true);
    expect(mockCacheStore.has('/build1/ch2:sc3/audio')).toBe(true);
  });

  it('returns 0 when no entries match', async () => {
    mockCacheStore.set('/build1/ch1:sc1/audio', new Response('a1'));
    const evicted = await evictSceneMedia('build1', 'ch99', 'sc99');
    expect(evicted).toBe(0);
    expect(mockCacheStore.size).toBe(1);
  });

  it('does not produce invalid cache keys (no "//" prefix)', async () => {
    // Verify that the cache key format is always valid
    mockCacheStore.set('/_blank/ch1:sc1/audio', new Response('a1'));
    const evicted = await evictSceneMedia('_blank', 'ch1', 'sc1');
    expect(evicted).toBe(1);
  });
});

describe('evictChapterMedia', () => {
  beforeEach(() => {
    mockCacheStore.clear();
  });

  it('evicts all entries for scenes in the chapter', async () => {
    mockCacheStore.set('/build1/ch1:sc1/audio', new Response('a1'));
    mockCacheStore.set('/build1/ch1:sc1/video', new Response('v1'));
    mockCacheStore.set('/build1/ch1:sc2/audio', new Response('a2'));
    mockCacheStore.set('/build1/ch1:sc2/preview', new Response('p2'));
    mockCacheStore.set('/build1/ch2:sc3/audio', new Response('a3'));

    const evicted = await evictChapterMedia('build1', 'ch1');
    expect(evicted).toBe(4);
    expect(mockCacheStore.has('/build1/ch2:sc3/audio')).toBe(true);
    expect(mockCacheStore.size).toBe(1);
  });

  it('returns 0 when the chapter has no cached entries', async () => {
    mockCacheStore.set('/build1/ch2:sc3/audio', new Response('a3'));
    const evicted = await evictChapterMedia('build1', 'ch99');
    expect(evicted).toBe(0);
    expect(mockCacheStore.size).toBe(1);
  });
});
