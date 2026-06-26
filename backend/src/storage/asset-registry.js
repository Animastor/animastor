// ======================================================
// ASSET REGISTRY - CENTRAL ASSET TRACKING
// ======================================================
// Redis-based registry for scene assets.
// NOT source of truth for lifecycle - that's the state machine.
// Source of truth for: asset existence, paths, metadata.

const storage = require('../storage/filesystem-store')
const logPrefix = '[REGISTRY]'

function log(msg) {
    console.log(`${logPrefix} ${msg}`)
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`)
}

// ======================================================
// HELPER: GET REGISTRY KEY
// ======================================================

function getAssetRegistryKey(bookId, chapterId, sceneId) {
    return `animastor:assets:${bookId}:${chapterId}:${sceneId}`
}

// ======================================================
// ASSET HELPERS
// ======================================================

/**
 * Register scene audio asset.
 */
async function registerSceneAudioRedis(redis, bookId, chapterId, sceneId, {
    canonicalPath,
    chunkPaths = [],
    duration = null,
    format = 'mp3',
    sampleRate = 24000,
    channelCount = 1,
    ready = true
} = {}) {
    const key = getAssetRegistryKey(bookId, chapterId, sceneId)
    
    const assets = await redis.hgetall(key) || {}
    
    assets.audio = JSON.stringify({
        canonical: canonicalPath,
        chunks: chunkPaths,
        duration,
        format,
        sampleRate,
        channelCount,
        ready,
        registeredAt: Date.now()
    })
    
    await redis.hset(key, assets)
    
    log(`REGISTERED audio: ${bookId}/${chapterId}/${sceneId}`)
    
    return { success: true, asset: 'audio' }
}

/**
 * Register scene image asset.
 */
async function registerSceneImageRedis(redis, bookId, chapterId, sceneId, {
    path,
    width = null,
    height = null,
    format = 'jpg',
    duration = null,
    ready = true
} = {}) {
    const key = getAssetRegistryKey(bookId, chapterId, sceneId)
    
    const assets = await redis.hgetall(key) || {}
    
    assets.image = JSON.stringify({
        path,
        width,
        height,
        format,
        duration,
        ready,
        registeredAt: Date.now()
    })
    
    await redis.hset(key, assets)
    
    log(`REGISTERED image: ${bookId}/${chapterId}/${sceneId}`)
    
    return { success: true, asset: 'image' }
}

/**
 * Register scene video asset.
 */
async function registerSceneVideoRedis(redis, bookId, chapterId, sceneId, {
    path,
    duration = null,
    width = null,
    height = null,
    format = 'mp4',
    ready = true
} = {}) {
    const key = getAssetRegistryKey(bookId, chapterId, sceneId)
    
    const assets = await redis.hgetall(key) || {}
    
    assets.video = JSON.stringify({
        path,
        duration,
        width,
        height,
        format,
        ready,
        registeredAt: Date.now()
    })
    
    await redis.hset(key, assets)
    
    log(`REGISTERED video: ${bookId}/${chapterId}/${sceneId}`)
    
    return { success: true, asset: 'video' }
}

// ======================================================
// GET ASSETS
// ======================================================

/**
 * Get all assets for a scene.
 */
async function getSceneAssetsRedis(redis, bookId, chapterId, sceneId) {
    const key = getAssetRegistryKey(bookId, chapterId, sceneId)
    
    const assetsRaw = await redis.hgetall(key)
    
    if (!assetsRaw || Object.keys(assetsRaw).length === 0) {
        return null
    }
    
    // Parse JSON values
    const assets = {}
    for (const [field, value] of Object.entries(assetsRaw)) {
        try {
            assets[field] = JSON.parse(value)
        } catch (e) {
            warn(`Failed to parse asset ${field}: ${e.message}`)
        }
    }
    
    return assets
}

/**
 * Get audio asset for scene.
 */
async function getAudioAssetRedis(redis, bookId, chapterId, sceneId) {
    const assets = await getSceneAssetsRedis(redis, bookId, chapterId, sceneId)
    return assets?.audio || null
}

/**
 * Get image asset for scene.
 */
async function getImageAssetRedis(redis, bookId, chapterId, sceneId) {
    const assets = await getSceneAssetsRedis(redis, bookId, chapterId, sceneId)
    return assets?.image || null
}

/**
 * Get video asset for scene.
 */
async function getVideoAssetRedis(redis, bookId, chapterId, sceneId) {
    const assets = await getSceneAssetsRedis(redis, bookId, chapterId, sceneId)
    return assets?.video || null
}

// ======================================================
// CHECK ASSET EXISTENCE
// ======================================================

/**
 * Check if audio exists (registry check).
 */
async function hasAudioAssetRedis(redis, bookId, chapterId, sceneId) {
    const audio = await getAudioAssetRedis(redis, bookId, chapterId, sceneId)
    return !!audio
}

/**
 * Check if image exists (registry check).
 */
async function hasImageAssetRedis(redis, bookId, chapterId, sceneId) {
    const image = await getImageAssetRedis(redis, bookId, chapterId, sceneId)
    return !!image
}

/**
 * Check if video exists (registry check).
 */
async function hasVideoAssetRedis(redis, bookId, chapterId, sceneId) {
    const video = await getVideoAssetRedis(redis, bookId, chapterId, sceneId)
    return !!video
}

/**
 * Check if scene has all required assets.
 */
async function hasAllAssetsRedis(redis, bookId, chapterId, sceneId) {
    const assets = await getSceneAssetsRedis(redis, bookId, chapterId, sceneId)
    
    if (!assets) return false
    
    return (
        assets.audio?.ready &&
        assets.image?.ready &&
        assets.video?.ready
    )
}

// ======================================================
// UPDATE ASSET METADATA
// ======================================================

/**
 * Update audio asset duration.
 */
async function updateAudioDuration(redis, bookId, chapterId, sceneId, duration) {
    const key = getAssetRegistryKey(bookId, chapterId, sceneId)
    
    const audioRaw = await redis.hget(key, 'audio')
    
    if (!audioRaw) {
        return { success: false, reason: 'audio_not_registered' }
    }
    
    const audio = JSON.parse(audioRaw)
    audio.duration = duration
    
    await redis.hset(key, 'audio', JSON.stringify(audio))
    
    return { success: true, asset: 'audio', updated: audio }
}

/**
 * Update image asset dimensions.
 */
async function updateImageDimensions(redis, bookId, chapterId, sceneId, width, height) {
    const key = getAssetRegistryKey(bookId, chapterId, sceneId)
    
    const imageRaw = await redis.hget(key, 'image')
    
    if (!imageRaw) {
        return { success: false, reason: 'image_not_registered' }
    }
    
    const image = JSON.parse(imageRaw)
    image.width = width
    image.height = height
    
    await redis.hset(key, 'image', JSON.stringify(image))
    
    return { success: true, asset: 'image', updated: image }
}

/**
 * Update video asset duration.
 */
async function updateVideoDuration(redis, bookId, chapterId, sceneId, duration) {
    const key = getAssetRegistryKey(bookId, chapterId, sceneId)
    
    const videoRaw = await redis.hget(key, 'video')
    
    if (!videoRaw) {
        return { success: false, reason: 'video_not_registered' }
    }
    
    const video = JSON.parse(videoRaw)
    video.duration = duration
    
    await redis.hset(key, 'video', JSON.stringify(video))
    
    return { success: true, asset: 'video', updated: video }
}

// ======================================================
// REGISTRY CLEANUP
// ======================================================

/**
 * Delete all assets for a scene.
 */
async function deleteSceneAssetsRedis(redis, bookId, chapterId, sceneId) {
    const key = getAssetRegistryKey(bookId, chapterId, sceneId)
    
    return await redis.del(key)
}

/**
 * Delete all assets for all scenes in a chapter.
 */
async function deleteChapterAssetsRedis(redis, bookId, chapterId) {
    const pattern = `animastor:assets:${bookId}:${chapterId}:*`
    
    const keys = await storage.scanKeys(redis, pattern)
    
    if (keys.length === 0) {
        return { deleted: 0 }
    }
    
    const result = await redis.del(keys)
    
    return { deleted: result }
}

/**
 * Delete all assets for all scenes in a book.
 */
async function deleteBookAssetsRedis(redis, bookId) {
    const pattern = `animastor:assets:${bookId}:*`
    
    const keys = await storage.scanKeys(redis, pattern)
    
    if (keys.length === 0) {
        return { deleted: 0 }
    }
    
    const result = await redis.del(keys)
    
    return { deleted: result }
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Redis-prefixed names to distinguish from PG scene-asset-registry (C3)
    registerSceneAudioRedis,
    registerSceneImageRedis,
    registerSceneVideoRedis,
    getSceneAssetsRedis,
    getImageAssetRedis,
    hasAudioAssetRedis,
    hasImageAssetRedis,
    hasVideoAssetRedis,
    hasAllAssetsRedis,
    updateAudioDuration,
    updateImageDimensions,
    updateVideoDuration,
    deleteSceneAssetsRedis,
    deleteChapterAssetsRedis,
    deleteBookAssetsRedis
}
