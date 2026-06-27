// ======================================================
// ANIMASTOR BACKEND — PROGRESS PUB/SUB
// ======================================================
// Thin wrapper around Redis pub/sub for real-time GPU generation progress.
//
// The frontend opens an SSE stream (GET /api/v1/book/:bookId/progress-stream)
// which SUBSCRIBEs to the per-book channel below. Completion handlers publish
// an increment event whenever a layer advances, so the UI gets an immediate
// push instead of waiting for the next 1.5s poll. Polling remains as a
// reconcile/fallback — these events are advisory and need not be exhaustive.

function channel(bookId) {
    return `animastor:progress:${bookId}`;
}

/**
 * Publish a progress event for a book. Best-effort: never throws, so a pub/sub
 * hiccup can't break the GPU result-handling path.
 *
 * @param {RedisClient} redis      a normal (non-subscriber) Redis client
 * @param {string} bookId
 * @param {Object} event           { type?, layer, chapterId?, sceneId?, ready?, total? }
 */
async function publishProgress(redis, bookId, event) {
    if (!redis || !bookId) return;
    try {
        const payload = JSON.stringify({ type: 'progress', ...event });
        await redis.publish(channel(bookId), payload);
    } catch (err) {
        console.warn('[PROGRESS-PUBSUB] publish failed:', err.message);
    }
}

module.exports = { channel, publishProgress };
