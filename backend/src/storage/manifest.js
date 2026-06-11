// ======================================================
// Cache Manifest Service
// ======================================================
// High-level API for tracking generated assets.
// Uses PostgreSQL cache_entries as persistent layer.
// Redis remains the runtime layer for active generation.

const path = require('path');
const fs = require('fs');

const { repos } = require('./postgres');

const logPrefix = '[MANIFEST]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

/**
 * Record a generated asset in the cache manifest.
 * Call this after successful generation of any media file.
 */
async function recordAsset(bookId, chapterId, sceneId, assetType, filePath) {
    let fileSize = null;
    let contentHash = null;

    try {
        if (filePath && fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            fileSize = stat.size;
            if (fileSize > 0) {
                const crypto = require('crypto');
                const fd = fs.openSync(filePath, 'r');
                const buffer = Buffer.alloc(Math.min(fileSize, 65536));
                fs.readSync(fd, buffer, 0, buffer.length, 0);
                fs.closeSync(fd);
                contentHash = crypto.createHash('md5').update(buffer).digest('hex');
            }
        }
    } catch (err) {
        warn(`Failed to compute hash for ${filePath}: ${err.message}`);
    }

    const result = await repos.cache.markAssetReady(
        bookId, chapterId, sceneId, assetType, filePath, fileSize, contentHash
    );

    log(`Recorded ${assetType}: ${bookId}/${chapterId}/${sceneId}`);
    return result;
}

/**
 * Mark assets as stale for a scene that needs regeneration.
 */
async function invalidateSceneAssets(bookId, chapterId, sceneId) {
    const types = ['audio', 'image', 'video'];
    for (const type of types) {
        await repos.cache.markAssetStale(bookId, chapterId, sceneId, type);
    }
    log(`Invalidated ${bookId}/${chapterId}/${sceneId}`);
}

/**
 * Check if a scene's assets are fully cached and up-to-date.
 */
async function isSceneFullyCached(bookId, chapterId, sceneId) {
    const types = ['audio', 'image', 'video'];
    for (const type of types) {
        const cached = await repos.cache.isSceneCached(bookId, chapterId, sceneId, type);
        if (!cached) return false;
    }
    return true;
}

/**
 * Get cache summary for a book.
 */
async function getBookCacheSummary(bookId) {
    return await repos.cache.getCacheSummary(bookId);
}

/**
 * Get all stale assets for a book (need regeneration).
 */
async function getStaleAssets(bookId) {
    return await repos.cache.getStaleAssets(bookId);
}

/**
 * Delete all cache entries for a book.
 */
async function deleteBookCache(bookId) {
    await repos.cache.deleteBookCache(bookId);
    log(`Deleted cache for ${bookId}`);
}

module.exports = {
    recordAsset,
    invalidateSceneAssets,
    isSceneFullyCached,
    getBookCacheSummary,
    getStaleAssets,
    deleteBookCache,
};
