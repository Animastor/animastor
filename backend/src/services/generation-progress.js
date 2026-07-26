// Per-worker generation scope registry.
//
// Layer config is book-wide and changes on every generation request, while
// Audio/Image/Video may run concurrently with different scopes. Store the
// original scope per worker type so progress x/y remains independent.

const KEY_PREFIX = 'animastor:generation-progress';
const TTL_SECONDS = 4 * 60 * 60;

function key(bookId) {
    return `${KEY_PREFIX}:${bookId}`;
}

async function recordScopes(redis, bookId, workerTypes, scope) {
    if (!redis || !bookId || !workerTypes || workerTypes.length === 0) return;

    const value = JSON.stringify({
        scope: scope?.scope || 'whole_book',
        chapter_id: scope?.chapterId || null,
        scene_id: scope?.sceneId || null,
        started_at: Date.now(),
    });

    for (const type of workerTypes) {
        await redis.hset(key(bookId), type, value);
    }
    await redis.expire(key(bookId), TTL_SECONDS);
}

async function getScopes(redis, bookId) {
    if (!redis || !bookId) return {};
    const raw = await redis.hgetall(key(bookId));
    const result = {};
    for (const [type, value] of Object.entries(raw || {})) {
        try {
            result[type] = JSON.parse(value);
        } catch (_) {}
    }
    return result;
}

async function removeScope(redis, bookId, type) {
    if (!redis || !bookId || !type) return;
    await redis.hdel(key(bookId), type);
}

async function clear(redis, bookId) {
    if (!redis || !bookId) return;
    await redis.del(key(bookId));
}

module.exports = {
    KEY_PREFIX,
    key,
    recordScopes,
    getScopes,
    removeScope,
    clear,
};
