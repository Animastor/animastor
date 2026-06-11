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
// Used by:
//   - POST /api/v1/book/:bookId/regenerate   (writes scope on start)
//   - /api/v1/book/:bookId/slide-window      (reads scope)
//   - /api/v1/book/:bookId/assets-state      (reads scope via query params)
//   - scene-orchestrator auto-slide          (reads scope)

const KEY_PREFIX = 'animastor:gen-scope:';
const key = (bookId) => `${KEY_PREFIX}${bookId}`;

async function setScope(redis, bookId, scope, chapterId, sceneId) {
    if (!redis || !bookId) return null;
    const data = {
        scope: scope || 'whole_book',
        chapter_id: chapterId || null,
        scene_id: sceneId || null,
        set_at: new Date().toISOString(),
    };
    await redis.set(key(bookId), JSON.stringify(data));
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
    inScope,
    scopeBounds,
    key,
};
