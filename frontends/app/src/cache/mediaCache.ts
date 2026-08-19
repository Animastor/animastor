// Media cache — equivalent of util/SimpleDiskCache.kt (audio/video/image/preview/iu blobs).
// Uses Cache API keyed by `${buildId}_${sceneKey}_${kind}`; supports clearCache(buildId?).
// Mirrors Android behavior in PlaybackViewModel: clearCache() when buildId changes
// in preparePlayback; clearCache() on refreshContent (backend updates in-place).

const CACHE_NAME = 'animastor-media';

async function openCache(): Promise<Cache> {
  return await caches.open(CACHE_NAME);
}

function key(buildId: string, sceneKey: string, kind: 'audio' | 'video' | 'image' | 'preview' | 'iu'): string {
  // buildId is empty for blank/manual books — never emit a leading "//"
  // (scheme-relative) URL, which Cache API match/put would reject.
  const build = buildId || '_blank';
  return `/${build}/${sceneKey}/${kind}`;
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
// Returns the number of entries deleted (SettingsFragment toast "Cleared N cached files").
export async function clearCache(buildId?: string): Promise<number> {
  const cache = await openCache();
  const keys = await cache.keys();
  const targets = buildId
    ? keys.filter((k) => k.url.includes(`/${buildId}/`))
    : keys;
  await Promise.all(targets.map((k) => cache.delete(k)));
  return targets.length;
}

// ── Scene-level cache invalidation (delete chapter/scene/unit) ──
// Evicts all media cache entries whose URL path contains the scene key
// "${chapterId}:${sceneId}". Safe for partial eviction: a unit delete
// clears only that scene's cached blobs (audio/video/IU/etc.).
export async function evictSceneMedia(buildId: string, chapterId: string, sceneId: string): Promise<number> {
  const cache = await openCache();
  const keys = await cache.keys();
  // Scene key format in URL path: /${buildId}/${chapterId}:${sceneId}/...
  const sceneSegment = `${chapterId}:${sceneId}`;
  const targets = keys.filter((k) => {
    const url = k.url;
    return url.includes(`/${buildId}/`) && url.includes(sceneSegment);
  });
  await Promise.all(targets.map((k) => cache.delete(k)));
  return targets.length;
}

// ── Chapter-level cache invalidation (delete chapter) ──
// Evicts all media cache entries for every scene belonging to the chapter.
// Since scene keys are "${chapterId}:${sceneId}", matching on the chapter
// prefix is sufficient — every scene in the chapter has the same prefix.
export async function evictChapterMedia(buildId: string, chapterId: string): Promise<number> {
  const cache = await openCache();
  const keys = await cache.keys();
  // Match any URL containing "chapterId:" followed by anything (the scene part)
  const prefix = `${chapterId}:`;
  const targets = keys.filter((k) => {
    const url = k.url;
    return url.includes(`/${buildId}/`) && url.includes(prefix);
  });
  await Promise.all(targets.map((k) => cache.delete(k)));
  return targets.length;
}
