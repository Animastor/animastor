// ======================================================
// ACTIVE SCENES INDEX
// ======================================================
// Redis Set tracking active scenes (_audio_pending through video_generating).
// Enables efficient iteration without SCAN operations.

const state = require('../state');

const ACTIVE_SCENES_KEY = 'animastor:active-scenes';

/**
 * Check if a scene is in the active index.
 */
async function isActive(redis, bookId, chapterId, sceneId) {
    const sceneKey = `${bookId}:${chapterId}:${sceneId}`;
    return await redis.sismember(ACTIVE_SCENES_KEY, sceneKey);
}

/**
 * Get all active scene keys.
 */
async function getAllActiveSceneKeys(redis) {
    return await redis.smembers(ACTIVE_SCENES_KEY);
}

/**
 * Get count of active scenes.
 */
async function getActiveCount(redis) {
    return await redis.scard(ACTIVE_SCENES_KEY);
}

/**
 * Add scene to active index when it enters generating/pending state.
 */
async function addActiveScene(redis, bookId, chapterId, sceneId) {
    const sceneKey = `${bookId}:${chapterId}:${sceneId}`;
    const added = await redis.sadd(ACTIVE_SCENES_KEY, sceneKey);
    return { added: added > 0, sceneKey };
}

/**
 * Remove scene from active index when it completes or fails.
 */
async function removeActiveScene(redis, bookId, chapterId, sceneId) {
    const sceneKey = `${bookId}:${chapterId}:${sceneId}`;
    const removed = await redis.srem(ACTIVE_SCENES_KEY, sceneKey);
    return { removed: removed > 0, sceneKey };
}

/**
 * Parse scene key back to components.
 */
function parseSceneKey(sceneKey) {
    const parts = sceneKey.split(':');
    if (parts.length !== 3) {
        return null;
    }
    return {
        bookId: parts[0],
        chapterId: parts[1],
        sceneId: parts[2]
    };
}

/**
 * Get detailed info about all active scenes.
 */
async function getActiveScenesDetail(redis) {
    const activeKeys = await getAllActiveSceneKeys(redis);
    const scenes = [];

    for (const key of activeKeys) {
        const parsed = parseSceneKey(key);
        if (!parsed) continue;

        const assetStates = await state.getAssetStates(redis, parsed.bookId, parsed.chapterId, parsed.sceneId);

        scenes.push({
            ...parsed,
            currentState: 'active',
            updatedAt: null,
            buildId: null,
            assetStates
        });
    }

    return scenes;
}

/**
 * Find scenes in a specific state.
 */
async function findScenesByState(redis, targetState) {
    const allActive = await getActiveScenesDetail(redis);
    return allActive.filter(s => s.currentState === targetState);
}

/**
 * T8: Check if scene is currently generating (audio, image, or video).
 * Uses per-asset states as source of truth.
 */
async function isGenerating(redis, bookId, chapterId, sceneId) {
    const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    if (!assetStates) return false;
    return assetStates.audio === state.AssetState.GENERATING ||
           assetStates.image === state.AssetState.GENERATING ||
           assetStates.video === state.AssetState.GENERATING;
}

/**
 * T8: Check if scene is in pending state (waiting to start).
 * Uses per-asset states as source of truth.
 */
async function isPending(redis, bookId, chapterId, sceneId) {
    const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    if (!assetStates) return false;
    return assetStates.audio === state.AssetState.PENDING ||
           assetStates.image === state.AssetState.PENDING ||
           assetStates.video === state.AssetState.PENDING;
}

/**
 * T8: Check if scene is in terminal state (complete or failed).
 * Uses per-asset states as source of truth.
 */
async function isTerminal(redis, bookId, chapterId, sceneId) {
    const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    if (!assetStates) return false;
    // Terminal: all enabled assets are READY, PLACEHOLDER, or FAILED
    const allAssetsFinished = (
        (assetStates.audio === state.AssetState.READY ||
         assetStates.audio === state.AssetState.PLACEHOLDER ||
         assetStates.audio === state.AssetState.FAILED) &&
        (assetStates.image === state.AssetState.READY ||
         assetStates.image === state.AssetState.PLACEHOLDER ||
         assetStates.image === state.AssetState.FAILED) &&
        (assetStates.video === state.AssetState.READY ||
         assetStates.video === state.AssetState.PLACEHOLDER ||
         assetStates.video === state.AssetState.FAILED)
    );
    return allAssetsFinished;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    ACTIVE_SCENES_KEY,
    isActive,
    getAllActiveSceneKeys,
    getActiveCount,
    addActiveScene,
    removeActiveScene,
    parseSceneKey,
    getActiveScenesDetail,
    findScenesByState,
    isGenerating,
    isPending,
    isTerminal
};
