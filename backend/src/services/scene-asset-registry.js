// ======================================================
// Scene Asset Registry - PostgreSQL-backed
// ======================================================
// Source of truth for scene asset existence, paths, and
// metadata. Replaces the legacy Redis-backed registry
// (animastor:assets:*) that previously stored asset blobs
// as Redis hashes.
//
// API mirrors the legacy registry (registerSceneAudio/Image/Video,
// getSceneAssets, hasAudioAsset, etc.) for drop-in compatibility.

const path = require('path');
const fs = require('fs');

const sceneAssetsRepo = require('../storage/postgres/repositories/scene-assets-repo');
const { computeSceneHash, generateBuildId } = require('../utils/scene-hash');

const logPrefix = '[SCENE-ASSET-REGISTRY]';

function log(msg) { console.log(`${logPrefix} ${msg}`); }
function warn(msg) { console.warn(`${logPrefix} ⚠️  ${msg}`); }

// ======================================================
// REGISTER ASSETS
// ======================================================

async function registerSceneAudio(bookId, chapterId, sceneId, payload = {}) {
    const {
        canonicalPath, chunkPaths = [],
        duration = null, format = 'mp3',
        sampleRate = 24000, channelCount = 1,
        ready = true, buildId = null, sceneHash = null,
    } = payload;

    if (!canonicalPath && chunkPaths.length === 0) {
        warn(`registerSceneAudio: no path provided for ${bookId}/${chapterId}/${sceneId}`);
    }

    const finalStatus = ready ? 'ready' : 'pending';

    const asset = await sceneAssetsRepo.upsertAsset({
        book_id: bookId, chapter_id: chapterId, scene_id: sceneId,
        asset_type: 'audio',
        path: canonicalPath || null,
        duration_sec: duration,
        format, sample_rate: sampleRate, channel_count: channelCount,
        chunks: chunkPaths.length > 0 ? chunkPaths : null,
        build_id: buildId,
        scene_hash: sceneHash,
        status: finalStatus,
    });

    log(`REGISTERED audio: ${bookId}/${chapterId}/${sceneId} (${format}, ${duration || '?'}s)`);
    return { success: true, asset: 'audio', record: asset };
}

async function registerSceneImage(bookId, chapterId, sceneId, payload = {}) {
    const {
        path: filePath, width = null, height = null,
        format = 'jpg', duration = null,
        ready = true, buildId = null, sceneHash = null,
    } = payload;

    const finalStatus = ready ? 'ready' : 'pending';

    const asset = await sceneAssetsRepo.upsertAsset({
        book_id: bookId, chapter_id: chapterId, scene_id: sceneId,
        asset_type: 'image',
        path: filePath, duration_sec: duration,
        width, height, format,
        build_id: buildId, scene_hash: sceneHash,
        status: finalStatus,
    });

    log(`REGISTERED image: ${bookId}/${chapterId}/${sceneId} (${width}x${height})`);
    return { success: true, asset: 'image', record: asset };
}

async function registerSceneVideo(bookId, chapterId, sceneId, payload = {}) {
    const {
        path: filePath, duration = null,
        width = null, height = null, format = 'mp4',
        ready = true, buildId = null, sceneHash = null,
    } = payload;

    const finalStatus = ready ? 'ready' : 'pending';

    const asset = await sceneAssetsRepo.upsertAsset({
        book_id: bookId, chapter_id: chapterId, scene_id: sceneId,
        asset_type: 'video',
        path: filePath, duration_sec: duration,
        width, height, format,
        build_id: buildId, scene_hash: sceneHash,
        status: finalStatus,
    });

    log(`REGISTERED video: ${bookId}/${chapterId}/${sceneId} (${format}, ${duration || '?'}s)`);
    return { success: true, asset: 'video', record: asset };
}

async function registerStoryboard(bookId, chapterId, sceneId, payload = {}) {
    const { path: filePath, buildId = null, sceneHash = null, ready = true } = payload;
    const finalStatus = ready ? 'ready' : 'pending';

    const asset = await sceneAssetsRepo.upsertAsset({
        book_id: bookId, chapter_id: chapterId, scene_id: sceneId,
        asset_type: 'storyboard', path: filePath,
        build_id: buildId, scene_hash: sceneHash,
        status: finalStatus,
    });
    return { success: true, asset: 'storyboard', record: asset };
}

// ======================================================
// UPDATE METADATA
// ======================================================

async function updateAssetDuration(bookId, chapterId, sceneId, assetType, duration, buildId = null) {
    const existing = await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, assetType, buildId);
    if (!existing) return { success: false, reason: 'asset_not_found' };

    const record = await sceneAssetsRepo.upsertAsset({
        book_id: bookId, chapter_id: chapterId, scene_id: sceneId,
        asset_type: assetType, path: existing.path, build_id: existing.build_id,
        scene_hash: existing.scene_hash, status: existing.status,
        duration_sec: duration,
    });
    return { success: true, asset: assetType, record };
}

async function updateAssetDimensions(bookId, chapterId, sceneId, assetType, width, height, buildId = null) {
    const existing = await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, assetType, buildId);
    if (!existing) return { success: false, reason: 'asset_not_found' };

    const record = await sceneAssetsRepo.upsertAsset({
        book_id: bookId, chapter_id: chapterId, scene_id: sceneId,
        asset_type: assetType, path: existing.path, build_id: existing.build_id,
        scene_hash: existing.scene_hash, status: existing.status,
        width, height,
    });
    return { success: true, asset: assetType, record };
}

async function updateAssetPath(bookId, chapterId, sceneId, assetType, newPath, buildId = null) {
    return sceneAssetsRepo.upsertAsset({
        book_id: bookId, chapter_id: chapterId, scene_id: sceneId,
        asset_type: assetType, path: newPath, build_id: buildId,
        status: 'ready',
    });
}

// ======================================================
// STALE / INVALIDATE
// ======================================================

async function invalidateSceneAssets(bookId, chapterId, sceneId, buildId = null) {
    const types = ['audio', 'image', 'video', 'storyboard'];
    const results = {};
    for (const type of types) {
        results[type] = await sceneAssetsRepo.markStale(bookId, chapterId, sceneId, type, buildId);
    }
    log(`INVALIDATED ${bookId}/${chapterId}/${sceneId}`);
    return results;
}

async function markAssetStale(bookId, chapterId, sceneId, assetType, buildId = null) {
    return sceneAssetsRepo.markStale(bookId, chapterId, sceneId, assetType, buildId);
}

async function markAssetFailed(bookId, chapterId, sceneId, assetType, error, buildId = null) {
    return sceneAssetsRepo.markFailed(bookId, chapterId, sceneId, assetType, error, buildId);
}

// ======================================================
// QUERIES
// ======================================================

function toLegacyShape(asset) {
    if (!asset) return null;
    return {
        path: asset.path,
        canonical: asset.path,
        chunks: asset.chunks || [],
        duration: asset.duration_sec,
        width: asset.width,
        height: asset.height,
        format: asset.format,
        sampleRate: asset.sample_rate,
        channelCount: asset.channel_count,
        build_id: asset.build_id,
        scene_hash: asset.scene_hash,
        ready: asset.status === 'ready',
        status: asset.status,
        error: asset.error,
        metadata: asset.metadata,
        registeredAt: asset.created_at ? Number(asset.created_at) * 1000 : null,
    };
}

async function getSceneAssets(bookId, chapterId, sceneId) {
    const rows = await sceneAssetsRepo.getSceneAssets(bookId, chapterId, sceneId);
    if (!rows || rows.length === 0) return null;
    const out = {};
    for (const row of rows) {
        out[row.asset_type] = toLegacyShape(row);
    }
    return out;
}

async function getAudioAsset(bookId, chapterId, sceneId) {
    return toLegacyShape(await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, 'audio'));
}
async function getImageAsset(bookId, chapterId, sceneId) {
    return toLegacyShape(await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, 'image'));
}
async function getVideoAsset(bookId, chapterId, sceneId) {
    return toLegacyShape(await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, 'video'));
}
async function getStoryboardAsset(bookId, chapterId, sceneId) {
    return toLegacyShape(await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, 'storyboard'));
}

async function hasAudioAsset(bookId, chapterId, sceneId) {
    return sceneAssetsRepo.isSceneReady(bookId, chapterId, sceneId, 'audio');
}
async function hasImageAsset(bookId, chapterId, sceneId) {
    return sceneAssetsRepo.isSceneReady(bookId, chapterId, sceneId, 'image');
}
async function hasVideoAsset(bookId, chapterId, sceneId) {
    return sceneAssetsRepo.isSceneReady(bookId, chapterId, sceneId, 'video');
}

async function hasAllAssets(bookId, chapterId, sceneId) {
    const [a, i, v] = await Promise.all([
        hasAudioAsset(bookId, chapterId, sceneId),
        hasImageAsset(bookId, chapterId, sceneId),
        hasVideoAsset(bookId, chapterId, sceneId),
    ]);
    return a && i && v;
}

async function getBookAssetSummary(bookId) {
    return sceneAssetsRepo.getBookAssetSummary(bookId);
}

async function getStaleAssets(bookId) {
    const rows = await sceneAssetsRepo.getStaleAssets(bookId);
    return rows.map(toLegacyShape);
}

// ======================================================
// CLEANUP
// ======================================================

async function deleteSceneAssets(bookId, chapterId, sceneId) {
    return sceneAssetsRepo.deleteSceneAssets(bookId, chapterId, sceneId);
}
async function deleteBookAssets(bookId) {
    return sceneAssetsRepo.deleteBookAssets(bookId);
}
async function deleteBuildAssets(buildId) {
    return sceneAssetsRepo.deleteBuildAssets(buildId);
}

// ======================================================
// SCENE HASH INTEGRATION
// ======================================================

async function recordSceneHash(bookId, chapterId, sceneId, scene) {
    const hash = computeSceneHash(scene);
    if (!hash) return null;
    return { book_id: bookId, chapter_id: chapterId, scene_id: sceneId, scene_hash: hash };
}

module.exports = {
    registerSceneAudio,
    registerSceneImage,
    registerSceneVideo,
    registerStoryboard,
    updateAssetDuration,
    updateAssetDimensions,
    updateAssetPath,
    invalidateSceneAssets,
    markAssetStale,
    markAssetFailed,
    getSceneAssets,
    getAudioAsset,
    getImageAsset,
    getVideoAsset,
    getStoryboardAsset,
    hasAudioAsset,
    hasImageAsset,
    hasVideoAsset,
    hasAllAssets,
    getBookAssetSummary,
    getStaleAssets,
    deleteSceneAssets,
    deleteBookAssets,
    deleteBuildAssets,
    recordSceneHash,
};
