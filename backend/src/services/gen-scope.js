// ======================================================
// Generation Scope Service
// ======================================================
// Persists the active generation scope per book so background
// orchestration (auto slide-window, progress reporting) knows
// which scenes are in-scope.
//
// Storage:
//   Redis key: animastor:gen-scope:<bookId>
//   Value:     JSON { scope, chapter_id, scene_id, set_at }
//
// Used by the legacy/initial scene-window generation flow. Selective Navigator
// commands use generation-progress tasks instead.

const KEY_PREFIX = 'animastor:gen-scope:';
const SCOPE_TTL_SECONDS = 24 * 60 * 60;
const key = (bookId) => `${KEY_PREFIX}${bookId}`;

async function setScope(redis, bookId, scope, chapterId, sceneId) {
    if (!redis || !bookId) return null;
    const data = {
        scope: scope || 'whole_book',
        chapter_id: chapterId || null,
        scene_id: sceneId || null,
        set_at: new Date().toISOString(),
    };
    await redis.set(key(bookId), JSON.stringify(data), 'EX', SCOPE_TTL_SECONDS);
    return data;
}

async function getScope(redis, bookId) {
    if (!redis || !bookId) return null;
    const raw = await redis.get(key(bookId));
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function clearScope(redis, bookId) {
    if (!redis || !bookId) return;
    await redis.del(key(bookId));
}

/**
 * Add expiry to scope records created before TTL enforcement. Invalid records
 * are removed. This is intentionally non-destructive for valid active window
 * generation: legacy scopes remain usable for the full retention period.
 */
async function migrateLegacyScopes(redis) {
    if (!redis) return { scanned: 0, expiry_added: 0, invalid_removed: 0 };

    let cursor = '0';
    let scanned = 0;
    let expiryAdded = 0;
    let invalidRemoved = 0;

    do {
        const [nextCursor, keys] = await redis.scan(
            cursor,
            'MATCH',
            `${KEY_PREFIX}*`,
            'COUNT',
            200
        );
        cursor = nextCursor;

        for (const scopeKey of keys || []) {
            scanned++;
            const raw = await redis.get(scopeKey);
            try {
                const parsed = JSON.parse(raw);
                if (!parsed || typeof parsed !== 'object' || typeof parsed.scope !== 'string') {
                    throw new Error('invalid scope');
                }
            } catch (_) {
                await redis.del(scopeKey);
                invalidRemoved++;
                continue;
            }

            const ttl = typeof redis.ttl === 'function' ? await redis.ttl(scopeKey) : -1;
            if (ttl < 0) {
                await redis.expire(scopeKey, SCOPE_TTL_SECONDS);
                expiryAdded++;
            }
        }
    } while (cursor !== '0');

    return {
        scanned,
        expiry_added: expiryAdded,
        invalid_removed: invalidRemoved,
    };
}

function inScope(scopeInfo, chapterId, sceneId) {
    if (!scopeInfo || !scopeInfo.scope || scopeInfo.scope === 'whole_book') {
        return true;
    }
    if (scopeInfo.scope === 'current_scene') {
        return scopeInfo.chapter_id === chapterId && scopeInfo.scene_id === sceneId;
    }
    if (scopeInfo.scope === 'current_chapter') {
        return scopeInfo.chapter_id === chapterId;
    }
    if (scopeInfo.scope === 'from_current_scene') {
        if (scopeInfo.chapter_id === chapterId && scopeInfo.scene_id === sceneId) return true;
        // Without knowing the full scene order we can only match the exact scene.
        // For tail semantics, callers should use scopeBounds() with allScenes.
        return false;
    }
    return true;
}

/**
 * Compute the [startIndex, endIndex) of scenes that fall within scope.
 * If scope is whole_book or missing, returns [0, totalScenes).
 * If scope is current_scene, returns the index of that scene as a single-element range.
 * If scope is current_chapter, returns the range of scenes belonging to that chapter.
 * If scope is from_current_scene, returns [sceneIdx, totalScenes).
 */
function scopeBounds(scopeInfo, allScenes) {
    const total = (allScenes || []).length;
    if (!scopeInfo || !scopeInfo.scope || scopeInfo.scope === 'whole_book') {
        return { startIndex: 0, endIndex: total };
    }
    if (scopeInfo.scope === 'current_scene') {
        const idx = (allScenes || []).findIndex(
            s => s.chapter_id === scopeInfo.chapter_id && s.scene_id === scopeInfo.scene_id
        );
        if (idx < 0) return { startIndex: 0, endIndex: 0 };
        return { startIndex: idx, endIndex: idx + 1 };
    }
    if (scopeInfo.scope === 'current_chapter') {
        const scenes = allScenes || [];
        let start = -1;
        let end = scenes.length;
        for (let i = 0; i < scenes.length; i++) {
            if (scenes[i].chapter_id === scopeInfo.chapter_id) {
                if (start < 0) start = i;
                end = i + 1;
            } else if (start >= 0) {
                break;
            }
        }
        if (start < 0) return { startIndex: 0, endIndex: 0 };
        return { startIndex: start, endIndex: end };
    }
    if (scopeInfo.scope === 'from_current_scene') {
        const idx = (allScenes || []).findIndex(
            s => s.chapter_id === scopeInfo.chapter_id && s.scene_id === scopeInfo.scene_id
        );
        if (idx < 0) return { startIndex: 0, endIndex: 0 };
        return { startIndex: idx, endIndex: total };
    }
    return { startIndex: 0, endIndex: total };
}

module.exports = {
    setScope,
    getScope,
    clearScope,
    migrateLegacyScopes,
    inScope,
    scopeBounds,
    key,
    KEY_PREFIX,
    SCOPE_TTL_SECONDS,
};
