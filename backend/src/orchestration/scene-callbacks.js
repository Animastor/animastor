const state = require('../state');
const audio = require('../audio');
const image = require('../image');
const video = require('../video');
const storage = require('../storage');
const runtimeScheduler = require('../runtime/runtime-scheduler');
const dispatchEngine = require('../runtime/dispatch-engine');
const book = require('../book');
const placeholderAudio = require('../services/placeholder-audio');
const { log, warn, error, logEvent } = require('./scene-utils');
const { Stage } = require('./scene-state-machine');

async function updateSceneChunks(redis, bookId, chapterId, sceneId, updates) {
    const prefix = `animastor:chunk:${bookId}_${chapterId}_${sceneId}_`;
    let cursor = '0';
    do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 50);
        cursor = nextCursor;
        for (const key of keys) {
            try {
                const raw = await redis.get(key);
                if (raw) {
                    const chunk = JSON.parse(raw);
                    Object.assign(chunk, updates);
                    await redis.set(key, JSON.stringify(chunk));
                }
            } catch (e) {
                warn(`Failed to update chunk ${key}: ${e.message}`);
            }
        }
    } while (cursor !== '0');
}

async function handleAudioCompleted(redis, bookId, chapterId, sceneId, buildId) {
    log(`AUDIO_CALLBACK: ${bookId}/${chapterId}/${sceneId}`);

    const currentState = await state.getSceneState(redis, bookId, chapterId, sceneId);

    if (!currentState || currentState.state !== state.SceneState.AUDIO_GENERATING) {
        warn(`AUDIO_CALLBACK: Invalid state: ${currentState?.state || 'no_state'} (expected AUDIO_GENERATING)`);
        await dispatchEngine.releaseQuota(redis, 'audio');
        log(`🔻 AUDIO quota released (invalid state): ${bookId}/${chapterId}/${sceneId}`);
        return { handled: false, nextStage: null, reason: 'invalid_state' };
    }

    const isReady = await audio.isSceneAudioReady(buildId, bookId, chapterId, sceneId, require('music-metadata'));
    if (!isReady) {
        error(`Audio not ready after completion: ${bookId}/${chapterId}/${sceneId}`);
        const scene = { book_id: bookId, chapter_id: chapterId, scene_id: sceneId };
        await logEvent(redis, scene, 'AUDIO_FAILED', state.SceneState.AUDIO_READY, {
            reason: 'not_ready_validation'
        });
        await dispatchEngine.releaseQuota(redis, 'audio');
        log(`🔻 AUDIO quota released (not ready fallback): ${bookId}/${chapterId}/${sceneId}`);
        return { handled: true, nextStage: null, reason: 'audio_not_ready' };
    }

    const scene = { book_id: bookId, chapter_id: chapterId, scene_id: sceneId };
    await logEvent(redis, scene, 'AUDIO_COMPLETED', state.SceneState.AUDIO_READY, {
        buildId
    });

    try {
        const audioPath = storage.filesystem.getSceneAudioPath(
            process.env.OUTPUT_DIR || '/data/output', buildId, bookId, chapterId, sceneId
        );
        await storage.registry.registerSceneAudio(redis, bookId, chapterId, sceneId, {
            canonicalPath: audioPath,
            ready: true
        });
        storage.manifest.recordAsset(bookId, chapterId, sceneId, 'audio', audioPath);
        log(`CACHE-MANIFEST: audio recorded for ${bookId}/${chapterId}/${sceneId}`);
    } catch (err) {
        warn(`Failed to register audio asset: ${err.message}`);
    }

    try {
        const audioPath = storage.filesystem.getSceneAudioPath(
            process.env.OUTPUT_DIR || '/data/output', buildId, bookId, chapterId, sceneId
        );
        const mm = require('music-metadata');
        let realDuration = 0;
        try {
            const metadata = await mm.parseFile(audioPath);
            realDuration = metadata.format.duration || 0;
        } catch {}
        await placeholderAudio.replacePlaceholderWithRealAudio(
            bookId, chapterId, sceneId, buildId, audioPath, realDuration
        );
    } catch (err) {
        warn(`Failed to replace placeholder audio: ${err.message}`);
    }

    await state.setAssetState(redis, bookId, chapterId, sceneId, 'audio', state.AssetState.READY);

    await dispatchEngine.releaseQuota(redis, 'audio');
    log(`🔻 AUDIO quota released (completed): ${bookId}/${chapterId}/${sceneId}`);

    log(`AUDIO_CALLBACK: ${bookId}/${chapterId}/${sceneId} -> AUDIO_READY`);

    return { 
        handled: true, 
        nextStage: Stage.IMAGE,
        completed: false 
    };
}

async function handleImageCompleted(redis, bookId, chapterId, sceneId, buildId) {
    log(`IMAGE_CALLBACK: ${bookId}/${chapterId}/${sceneId}`);

    const currentState = await state.getSceneState(redis, bookId, chapterId, sceneId);

    const sceneImage = image.resolveCanonicalSceneImage(
        '/data/output', buildId, bookId, chapterId, sceneId
    );

    if (!currentState || currentState.state !== state.SceneState.IMAGE_GENERATING) {
        warn(`IMAGE_CALLBACK: Invalid state: ${currentState?.state || 'no_state'} (expected IMAGE_GENERATING)`);
        await dispatchEngine.releaseQuota(redis, 'image');
        log(`🔻 IMAGE quota released (invalid state): ${bookId}/${chapterId}/${sceneId}`);
        return { handled: false, nextStage: null, reason: 'invalid_state' };
    }

    if (!sceneImage) {
        error(`Scene image not found after completion: ${bookId}/${chapterId}/${sceneId}`);
        const scene = { book_id: bookId, chapter_id: chapterId, scene_id: sceneId };
        await logEvent(redis, scene, 'IMAGE_FAILED', state.SceneState.IMAGE_GENERATING, {
            reason: 'not_found'
        });
        await dispatchEngine.releaseQuota(redis, 'image');
        log(`🔻 IMAGE quota released (not found fallback): ${bookId}/${chapterId}/${sceneId}`);
        return { handled: true, nextStage: null, reason: 'image_not_found' };
    }

    const imageInfo = await image.getImageMetadata(sceneImage);

    try {
        await storage.registry.registerSceneImage(redis, bookId, chapterId, sceneId, {
            path: sceneImage,
            width: imageInfo?.width || null,
            height: imageInfo?.height || null,
            ready: true
        });
        storage.manifest.recordAsset(bookId, chapterId, sceneId, 'image', sceneImage);
        log(`CACHE-MANIFEST: image recorded for ${bookId}/${chapterId}/${sceneId}`);
    } catch (err) {
        warn(`Failed to register image asset: ${err.message}`);
    }

    const scene = { book_id: bookId, chapter_id: chapterId, scene_id: sceneId };
    await logEvent(redis, scene, 'IMAGE_COMPLETED', state.SceneState.IMAGE_READY, {
        buildId,
        path: sceneImage
    });

    try {
        const sceneAssetsRepo = require('../storage/postgres/repositories/scene-assets-repo');
        await sceneAssetsRepo.clearDirtyUnitIds(bookId, chapterId, sceneId);
        log(`[DIRTY-UNITS-CLEARED] ${bookId}/${chapterId}/${sceneId}: cleared dirty_unit_ids on completion`);
    } catch (e) {
        warn(`Failed to clear dirty_unit_ids in IMAGE_CALLBACK: ${e.message}`);
    }

    try {
        const scenePrefix = `${bookId}_${chapterId}_${sceneId}_iu-`;
        let cursor = '0';
        do {
            const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `animastor:iu-in-flight:${scenePrefix}*`, 'COUNT', 50);
            cursor = nextCursor;
            if (keys.length > 0) {
                await redis.del(...keys);
                log(`[IU-IN-FLIGHT-CLEARED] ${bookId}/${chapterId}/${sceneId}: cleared ${keys.length} in-flight markers`);
            }
        } while (cursor !== '0');
    } catch (e) {
        warn(`Failed to clear in-flight markers in IMAGE_CALLBACK: ${e.message}`);
    }

    await state.setAssetState(redis, bookId, chapterId, sceneId, 'image', state.AssetState.READY);

    await updateSceneChunks(redis, bookId, chapterId, sceneId, { image: true, image_status: 'ready' });

    await dispatchEngine.releaseQuota(redis, 'image');
    log(`🔻 IMAGE quota released (completed): ${bookId}/${chapterId}/${sceneId}`);

    log(`IMAGE_CALLBACK: ${bookId}/${chapterId}/${sceneId} -> IMAGE_READY`);

    return { 
        handled: true, 
        nextStage: Stage.VIDEO,
        completed: false 
    };
}

async function handleVideoCompleted(redis, bookId, chapterId, sceneId, buildId) {
    log(`VIDEO_CALLBACK: ${bookId}/${chapterId}/${sceneId}`);

    const currentState = await state.getSceneState(redis, bookId, chapterId, sceneId);

    const videoPath = `/data/output/${buildId}/${bookId}_${chapterId}_${sceneId}.mp4`;
    const { valid, duration, metadata } = video.validateVideoFile(videoPath);

    if (!currentState || currentState.state !== state.SceneState.VIDEO_GENERATING) {
        warn(`VIDEO_CALLBACK: Invalid state: ${currentState?.state || 'no_state'} (expected VIDEO_GENERATING)`);
        await dispatchEngine.releaseQuota(redis, 'video');
        log(`🔻 VIDEO quota released (invalid state): ${bookId}/${chapterId}/${sceneId}`);
        return { handled: false, nextStage: null, reason: 'invalid_state' };
    }

    if (!valid) {
        error(`Video not valid after completion: ${bookId}/${chapterId}/${sceneId}`);
        const scene = { book_id: bookId, chapter_id: chapterId, scene_id: sceneId };
        await logEvent(redis, scene, 'VIDEO_FAILED', state.SceneState.VIDEO_GENERATING, {
            reason: 'invalid'
        });
        await dispatchEngine.releaseQuota(redis, 'video');
        log(`🔻 VIDEO quota released (invalid fallback): ${bookId}/${chapterId}/${sceneId}`);
        return { handled: true, nextStage: null, reason: 'video_invalid' };
    }

    try {
        await storage.registry.registerSceneVideo(redis, bookId, chapterId, sceneId, {
            path: videoPath,
            duration: duration || null,
            width: metadata?.width || null,
            height: metadata?.height || null,
            ready: true
        });
        storage.manifest.recordAsset(bookId, chapterId, sceneId, 'video', videoPath);
        log(`CACHE-MANIFEST: video recorded for ${bookId}/${chapterId}/${sceneId}`);
    } catch (err) {
        warn(`Failed to register video asset: ${err.message}`);
    }

    const scene = { book_id: bookId, chapter_id: chapterId, scene_id: sceneId };
    await logEvent(redis, scene, 'VIDEO_COMPLETED', state.SceneState.VIDEO_READY, {
        buildId,
        path: videoPath,
        duration: duration || 0
    });

    await video.updateSceneVideoStatus(redis, bookId, chapterId, sceneId, 'ready');

    await updateSceneChunks(redis, bookId, chapterId, sceneId, { video: true, video_status: 'ready' });

    await state.setAssetState(redis, bookId, chapterId, sceneId, 'video', state.AssetState.READY);

    await dispatchEngine.releaseQuota(redis, 'video');
    log(`🔻 VIDEO quota released (completed): ${bookId}/${chapterId}/${sceneId}`);

    try {
        const sceneAssetsRepo = require('../storage/postgres/repositories/scene-assets-repo');
        await sceneAssetsRepo.clearDirtyFlag(bookId, chapterId, sceneId);
        log(`[DIRTY-FLAG-CLEARED] ${bookId}/${chapterId}/${sceneId}: is_dirty=FALSE`);
    } catch (e) {
        warn(`Failed to clear dirty flag: ${e.message}`);
    }

    await runtimeScheduler.removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId);
    log(`SCENE COMPLETE: ${bookId}/${chapterId}/${sceneId} - removed from active index`);

    try {
        const bookData = book.loadBook(bookId);
        const sceneWindow = require('../runtime/scene-window');
        const slide = await sceneWindow.trySlideWindowOnComplete(redis, bookId, bookData, buildId);
        if (slide && slide.started > 0) {
            log(`SCENE-COMPLETE auto-slide: started=${slide.started} remaining=${slide.remaining}`);
        } else if (slide && slide.remaining === 0 && slide.started === 0) {
            log(`SCENE-COMPLETE auto-slide: scope fully complete`);
        }
    } catch (e) {
        warn(`SCENE-COMPLETE auto-slide failed: ${e.message}`);
    }

    return {
        handled: true,
        nextStage: null,
        completed: true
    };
}

async function completeSceneWithoutVideo(redis, loadedBook, bookId, chapterId, sceneId, buildId) {
    log(`Completing scene without video: ${bookId}/${chapterId}/${sceneId}`);

    await state.setAssetState(redis, bookId, chapterId, sceneId, 'video', state.AssetState.READY);
    await state.setSceneStateWithBuildId(redis, bookId, chapterId, sceneId, state.SceneState.VIDEO_READY, buildId);

    try {
        const sceneAssetsRepo = require('../storage/postgres/repositories/scene-assets-repo');
        await sceneAssetsRepo.clearDirtyFlag(bookId, chapterId, sceneId);
    } catch (e) {
        warn(`Failed to clear dirty flag in completeSceneWithoutVideo: ${e.message}`);
    }

    await runtimeScheduler.removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId);
    log(`Scene complete (no video): ${bookId}/${chapterId}/${sceneId} - removed from active index`);

    try {
        const sceneWindow = require('../runtime/scene-window');
        const slide = await sceneWindow.trySlideWindowOnComplete(redis, bookId, loadedBook, buildId);
        if (slide && slide.started > 0) {
            log(`SCENE-COMPLETE auto-slide: started=${slide.started} remaining=${slide.remaining}`);
        }
    } catch (e) {
        warn(`SCENE-COMPLETE auto-slide failed: ${e.message}`);
    }
}

async function completeSceneWithoutImage(redis, loadedBook, bookId, chapterId, sceneId, buildId) {
    log(`Completing scene without image: ${bookId}/${chapterId}/${sceneId}`);
    await state.setAssetState(redis, bookId, chapterId, sceneId, 'image', state.AssetState.READY);
    await state.setSceneStateWithBuildId(redis, bookId, chapterId, sceneId, state.SceneState.IMAGE_READY, buildId);
    log(`Scene complete (no image): ${bookId}/${chapterId}/${sceneId}`);

    try {
        const sceneAssetsRepo = require('../storage/postgres/repositories/scene-assets-repo');
        await sceneAssetsRepo.clearDirtyFlag(bookId, chapterId, sceneId);
    } catch (e) {
        warn(`Failed to clear dirty flag in completeSceneWithoutImage: ${e.message}`);
    }

    await runtimeScheduler.removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId);

    try {
        const sceneWindow = require('../runtime/scene-window');
        const slide = await sceneWindow.trySlideWindowOnComplete(redis, bookId, loadedBook, buildId);
        if (slide && slide.started > 0) {
            log(`SCENE-COMPLETE auto-slide: started=${slide.started} remaining=${slide.remaining}`);
        }
    } catch (e) {
        warn(`SCENE-COMPLETE auto-slide failed: ${e.message}`);
    }
}

module.exports = {
    updateSceneChunks,
    handleAudioCompleted,
    handleImageCompleted,
    handleVideoCompleted,
    completeSceneWithoutVideo,
    completeSceneWithoutImage,
};
