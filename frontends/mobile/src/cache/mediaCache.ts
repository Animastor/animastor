// Media cache — equivalent of util/SimpleDiskCache.kt (audio/video/image/preview/iu blobs).
// Uses Cache API keyed by `${buildId}_${sceneKey}_${kind}`; supports clearCache(buildId?).
// Mirrors Android behavior in PlaybackViewModel: clearCache() when buildId changes
// in preparePlayback; clearCache() on refreshContent (backend updates in-place).

const CACHE_NAME = 'animastor-media';

async function openCache(): Promise<Cache> {
  return await caches.open(CACHE_NAME);
}

function key(buildId: string, sceneKey: string, kind: 'audio' | 'video' | 'image' | 'preview' | 'iu'): string {
  return `/${buildId}/${sceneKey}/${kind}`;
}

export async function getMedia(
  buildId: string, sceneKey: string,
  kind: 'audio' | 'video' | 'image' | 'preview' | 'iu'
): Promise<Blob | undefined> {
  const cache = await openCache();
  const match = await cache.match(key(buildId, sceneKey, kind));
  return match ? await match.blob() : undefined;
}

export async function putMedia(
  buildId: string, sceneKey: string,
  kind: 'audio' | 'video' | 'image' | 'preview' | 'iu',
  blob: Blob
): Promise<void> {
  const cache = await openCache();
  const res = new Response(blob);
  await cache.put(key(buildId, sceneKey, kind), res);
}

// Mirrors Repository.clearCache() / PlaybackViewModel clearCache on buildId change.
// When buildId is omitted, wipes the entire media cache (matches Repository.clearCache()).
export async function clearCache(buildId?: string): Promise<void> {
  const cache = await openCache();
  if (!buildId) {
    const keys = await cache.keys();
    await Promise.all(keys.map((k) => cache.delete(k)));
    return;
  }
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((k) => k.url.includes(`/${buildId}/`))
      .map((k) => cache.delete(k))
  );
}
