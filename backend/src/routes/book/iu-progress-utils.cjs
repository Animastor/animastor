// Pure + async helpers for computing image-unit (IU) generation progress used
// by the GET /assets-state endpoint.
//
// Background (Architectural Debt — progress determinism):
// The previous inline computation mixed THREE sources — a Redis confirmed
// counter, the PG dirty-unit count, and a filesystem PNG listing via
// fs.readdirSync with Math.max/Math.min. The disk listing made `ready`
// non-monotonic: a partially-written or stale PNG could bump the count up,
// and clearing dirty_unit_ids mid-regen flipped the formula between branches,
// causing the frontend progress to jump backwards.
//
// The Redis counter (animastor:iu-progress:{book}:{ch}:{sc}:image) is the
// single source of truth. It is INCR-ed once per confirmed IU in
// task-handler.cjs and reset (DEL) at the start of a regen cycle in
// book-routes.cjs, so it is monotonic within one generation. We never touch
// the disk on the hot polling path.

/**
 * Deterministic IU-ready count from raw counters. No IO — unit-testable.
 *
 * @param {number} total          total IUs for the scene
 * @param {number} dirtyCount     number of IUs marked dirty (being regenerated)
 * @param {number} confirmedCount value of the Redis iu-progress counter
 * @returns {number} ready count, clamped to [0, total]
 */
function iuReadyFromCounters(total, dirtyCount, confirmedCount) {
    const t = Math.max(0, total | 0);
    const dirty = Math.max(0, Math.min(dirtyCount | 0, t));
    const confirmed = Math.max(0, confirmedCount | 0);

    // Regeneration: non-dirty IUs are already on disk and ready; the dirty
    // ones become ready as the GPU confirms them (capped by dirtyCount).
    // Fresh generation (dirty=0): all confirmed IUs are ready, capped by total.
    const ready = dirty > 0
        ? (t - dirty) + Math.min(confirmed, dirty)
        : Math.min(confirmed, t);

    return Math.max(0, Math.min(ready, t));
}

/**
 * Read the dirty-unit count and Redis confirmed counter for a scene and return
 * the deterministic ready count. Used for both scene IUs and cover IUs.
 *
 * @param {RedisClient} redis
 * @param {Object} sceneAssetsRepo  repo exposing getDirtyUnitIds()
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {number} total            total IUs for the scene
 * @returns {Promise<number>}
 */
async function computeIuReady(redis, sceneAssetsRepo, bookId, chapterId, sceneId, total) {
    let dirtyCount = 0;
    try {
        const dirtyIds = await sceneAssetsRepo.getDirtyUnitIds(bookId, chapterId, sceneId);
        dirtyCount = dirtyIds ? dirtyIds.length : 0;
    } catch (_) {}

    let confirmedCount = 0;
    try {
        const progKey = `animastor:iu-progress:${bookId}:${chapterId}:${sceneId}:image`;
        const val = await redis.get(progKey);
        if (val) confirmedCount = parseInt(val, 10) || 0;
    } catch (_) {}

    return iuReadyFromCounters(total, dirtyCount, confirmedCount);
}

module.exports = { iuReadyFromCounters, computeIuReady };
