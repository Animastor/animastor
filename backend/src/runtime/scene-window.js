// ======================================================
// Scene Window Service - v2.0.0 (scope-aware)
// ======================================================
// Slides the generation window through scenes in a scope-aware way.
// - BOOK_SCENE_TOTAL(bookId)  : end index (exclusive)
// - BOOK_SCENE_NEXT(bookId)   : next scene index to start
// - BOOK_WINDOW_START(bookId) : start index of current window
//
// When /regenerate is called with scope:
//   - sets BOOK_SCENE_TOTAL = scopeBounds.endIndex
//   - sets BOOK_SCENE_NEXT  = scopeBounds.startIndex
//   - sets BOOK_WINDOW_START = scopeBounds.startIndex
//   - slideWindow then iterates within that range
//
// Auto-slide on completion (called from scene-orchestrator) reads
// the persisted scope, checks the current window, and slides forward
// if the window is complete.

const config = require('../config/runtime-config');
const book = require('../book');
const state = require('../state');
const orchestrator = require('../orchestration/orchestrator');
const activeScenes = require('./active-scenes-index');
const audio = require('../audio/audio-service');
const genScope = require('../services/gen-scope');
const sceneAssetsRepo = require('../storage/postgres/repositories/scene-assets-repo');
const { query: pgQuery } = require('../storage/postgres/database');
const placeholderAudio = require('../services/placeholder-audio');
const fs = require('fs');
const path = require('path');

const { WINDOW_SIZE, OUTPUT_DIR } = config;

const BOOK_SCENE_KEY_PREFIX = 'animastor:book-scenes';
const BOOK_SCENE_TOTAL = (bookId) => `${BOOK_SCENE_KEY_PREFIX}:${bookId}:total`;
const BOOK_SCENE_NEXT = (bookId) => `${BOOK_SCENE_KEY_PREFIX}:${bookId}:next-index`;
const BOOK_WINDOW_START = (bookId) => `${BOOK_SCENE_KEY_PREFIX}:${bookId}:window-start`;

const CANCEL_FLAG_PREFIX = 'animastor:generation:cancel';
const cancelKey = (bookId) => `${CANCEL_FLAG_PREFIX}:${bookId}`;

const logPrefix = '[WINDOW]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

function error(msg) {
    console.error(`${logPrefix} ❌ ${msg}`);
}

async function initSceneWindow(redis, scenes, loadedBook, buildId, bookId, scopeInfo) {
    const scope = scopeInfo || (await genScope.getScope(redis, bookId));
    const bounds = genScope.scopeBounds(scope, scenes);
    const totalScenes = bounds.endIndex;
    log(`Initializing window for ${scenes.length} scenes, scope=${scope?.scope || 'whole_book'} bounds=[${bounds.startIndex},${bounds.endIndex}) (window=${WINDOW_SIZE})`);

    await redis.set(BOOK_SCENE_TOTAL(bookId), totalScenes);
    await redis.set(BOOK_SCENE_NEXT(bookId), bounds.startIndex);
    await redis.set(BOOK_WINDOW_START(bookId), bounds.startIndex);

    let started = 0;
    for (let i = bounds.startIndex; i < bounds.endIndex && i < WINDOW_SIZE + bounds.startIndex && i < scenes.length; i++) {
        if (await isCancelled(redis, bookId)) {
            log(`initSceneWindow cancelled after starting ${started} scenes`);
            break;
        }
        await startScene(redis, scenes[i], buildId, bookId);
        started++;
    }
    if (started > 0) {
        const newNext = bounds.startIndex + started;
        await redis.set(BOOK_SCENE_NEXT(bookId), newNext);
        await redis.set(BOOK_WINDOW_START(bookId), bounds.startIndex);
    }

    log(`Window initialized: ${started}/${totalScenes - bounds.startIndex} scenes started`);
    return started;
}

/**
 * Set the window bounds for a scope. Call this when /regenerate is invoked
 * with a new scope, BEFORE the initial slide.
 */
async function setWindowBounds(redis, bookId, scopeInfo, allScenes) {
    const bounds = genScope.scopeBounds(scopeInfo, allScenes);
    await redis.set(BOOK_SCENE_TOTAL(bookId), bounds.endIndex);
    await redis.set(BOOK_SCENE_NEXT(bookId), bounds.startIndex);
    await redis.set(BOOK_WINDOW_START(bookId), bounds.startIndex);
    return bounds;
}

/**
 * Check if generation was cancelled for this book.
 */
/**
 * Check if a scene state is a terminal ready state (content complete).
 */
function _isTerminalState(st) {
    return st === state.SceneState.VIDEO_READY || st === state.SceneState.FAILED;
}

/**
 * Unified file status checker — single source of truth for checking
 * what files exist on disk for a given scene.
 *
 * Phase 6 (R6.2): All four consumers (checkSceneContentCache,
 * restoreChunkStatusForScene, reconcileWindowStatuses, recoverIuImagesFromDisk)
 * use this function instead of duplicating fs.* calls.
 *
 * @returns {{ audio: { exists: boolean, isReal: boolean },
 *             image: { exists: boolean },
 *             video: { exists: boolean } }}
 */
async function getSceneFilesStatus(buildDir, bookId, chapterId, sceneId) {
    const result = {
        audio: { exists: false, isReal: false },
        image: { exists: false },
        video: { exists: false }
    };

    if (!fs.existsSync(buildDir)) return result;

    // Check audio file
    const audioPath = path.join(buildDir, `${bookId}_${chapterId}_${sceneId}.mp3`);
    result.audio.exists = fs.existsSync(audioPath);

    // Check IU image files (.png)
    try {
        const files = fs.readdirSync(buildDir);
        const imagePrefix = `${bookId}_${chapterId}_${sceneId}_iu`;
        result.image.exists = files.some(f => f.startsWith(imagePrefix) && f.endsWith('.png'));
    } catch (_) {}

    // Check video file
    const videoPath = path.join(buildDir, `${bookId}_${chapterId}_${sceneId}.mp4`);
    result.video.exists = fs.existsSync(videoPath);

    return result;
}

/**
 * Check scene content cache — returns advisory info about what files
 * exist on disk and whether content is stale by version.
 *
 * Phase 3 (R3.3): This function NO LONGER makes decisions about skipping dispatch.
 * It only returns information. The caller (orchestrator) decides what to do.
 *
 * @returns {{ audioOnDisk: boolean, imageOnDisk: boolean, videoOnDisk: boolean,
 *            staleByVersion: boolean, valid: boolean }}
 */
async function checkSceneContentCache(redis, buildId, bookId, chapterId, sceneId) {
    const buildDir = path.join(OUTPUT_DIR, buildId);
    const result = {
        audioOnDisk: false,
        imageOnDisk: false,
        videoOnDisk: false,
        staleByVersion: false,
        valid: false,
    };

    if (!fs.existsSync(buildDir)) return result;

    // Read layer config
    const layerKey = `animastor:layer-config:${bookId}`;
    const layerRaw = await redis.get(layerKey);
    let audioEnabled = true;
    let imageEnabled = true;
    let videoEnabled = true;
    if (layerRaw) {
        try {
            const lc = JSON.parse(layerRaw);
            audioEnabled = lc.audio_enabled !== false;
            imageEnabled = lc.image_enabled !== false;
            videoEnabled = lc.video_enabled !== false;
        } catch (_) {}
    }

    // Use unified file status
    const fileStatus = await getSceneFilesStatus(buildDir, bookId, chapterId, sceneId);

    // Check audio file — distinguish real TTS from placeholder
    if (audioEnabled) {
        result.audioOnDisk = fileStatus.audio.exists;
        if (result.audioOnDisk) {
            try {
                const hasReal = await placeholderAudio.hasRealAudio(bookId, chapterId, sceneId, buildId);
                if (!hasReal) result.audioOnDisk = false; // placeholder doesn't count as valid content
            } catch (_) {
                result.audioOnDisk = false;
            }
        }
    } else {
        result.audioOnDisk = true;
    }

    // Check for IU image files
    if (imageEnabled) {
        result.imageOnDisk = fileStatus.image.exists;
        if (!result.imageOnDisk && videoEnabled) {
            result.imageOnDisk = fileStatus.video.exists; // video as fallback
        }
    } else {
        result.imageOnDisk = true;
    }

    // Check video file
    if (videoEnabled) {
        result.videoOnDisk = fileStatus.video.exists;
    } else {
        result.videoOnDisk = true;
    }

    // R15: Version-based staleness check
    try {
        const sceneResult = await pgQuery(`
            SELECT content_version, audio_config_version FROM scenes
            WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
        `, [bookId, chapterId, sceneId]);
        if (sceneResult.rows.length > 0) {
            const sv = sceneResult.rows[0];
            const aAsset = await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, 'audio', buildId)
                || await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, 'audio');

            if (aAsset && aAsset.scene_content_version != null && sv.content_version != null &&
                aAsset.scene_content_version < sv.content_version) {
                log(`[VERSION-STALE] ${bookId}/${chapterId}/${sceneId}: audio content_version=${aAsset.scene_content_version} < scene content_version=${sv.content_version}`);
                result.staleByVersion = true;
            }
            if (aAsset && aAsset.scene_audio_config_version != null && sv.audio_config_version != null &&
                aAsset.scene_audio_config_version < sv.audio_config_version) {
                log(`[VERSION-STALE] ${bookId}/${chapterId}/${sceneId}: audio_config_version=${aAsset.scene_audio_config_version} < scene audio_config_version=${sv.audio_config_version}`);
                result.staleByVersion = true;
            }
        }
    } catch (_) {}

    // Scene is valid if all enabled layers have content AND content is not stale by version
    result.valid = result.audioOnDisk && result.imageOnDisk && result.videoOnDisk && !result.staleByVersion;

    return result;
}

/**
 * Д.3 (M3): Check if each asset type is stale by PG version.
 * Returns { audio: boolean, image: boolean, video: boolean } where true means
 * the asset's content_version is behind the scene's current version and needs regen.
 * Used by restoreChunkStatusForScene and reconcileWindowStatuses to prevent disk-based
 * 'ready' writes from overriding a pending force-regen.
 */
async function _checkAssetVersionStale(bookId, chapterId, sceneId, buildId) {
    const stale = { audio: false, image: false, video: false };
    try {
        const sceneResult = await pgQuery(`
            SELECT content_version, audio_config_version FROM scenes
            WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
        `, [bookId, chapterId, sceneId]);
        if (sceneResult.rows.length === 0) return stale;
        const sv = sceneResult.rows[0];

        const checkAsset = async (assetType) => {
            const asset = await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, assetType, buildId)
                || await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, assetType);
            if (!asset) return false;
            if (asset.scene_content_version != null && sv.content_version != null &&
                asset.scene_content_version < sv.content_version) {
                log(`[VERSION-STALE] ${bookId}/${chapterId}/${sceneId}: ${assetType} content_version=${asset.scene_content_version} < scene=${sv.content_version}`);
                return true;
            }
            if (asset.scene_audio_config_version != null && sv.audio_config_version != null &&
                asset.scene_audio_config_version < sv.audio_config_version) {
                log(`[VERSION-STALE] ${bookId}/${chapterId}/${sceneId}: ${assetType} audio_config_version=${asset.scene_audio_config_version} < scene=${sv.audio_config_version}`);
                return true;
            }
            return false;
        };

        stale.audio = await checkAsset('audio');
        stale.image = await checkAsset('image');
        stale.video = await checkAsset('video');
    } catch (_) {}
    return stale;
}

/**
 * After markDirtyScenes resets chunk metadata, restore it based on
 * which files actually exist on disk so /assets-state reports correct counts.
 *
 * Д.3 (M3): Only writes 'ready' if the asset version in PG is current.
 * If the content_version has been bumped (force-regen), stale files on disk
 * do NOT override the pending state — the scene stays pending for regeneration.
 */
async function restoreChunkStatusForScene(redis, buildId, bookId, chapterId, sceneId) {
    const buildDir = path.join(OUTPUT_DIR, buildId);
    if (!fs.existsSync(buildDir)) return;

    // Д.3: Check PG version staleness before writing chunk statuses.
    // If the asset is stale by version, don't mark chunks as 'ready' even
    // if files exist on disk — the scene needs regeneration.
    const versionStale = await _checkAssetVersionStale(bookId, chapterId, sceneId, buildId);

    const fileStatus = await getSceneFilesStatus(buildDir, bookId, chapterId, sceneId);
    let audioIsReal = false;
    if (fileStatus.audio.exists && !versionStale.audio) {
        try { audioIsReal = await placeholderAudio.hasRealAudio(bookId, chapterId, sceneId, buildId); }
        catch (_) {}
    }

    const prefix = `animastor:chunk:${bookId}_${chapterId}_${sceneId}_`;
    let cursor = '0';
    do {
        const scan = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
        cursor = scan[0];
        for (const key of scan[1]) {
            const raw = await redis.get(key);
            if (!raw) continue;
            const data = JSON.parse(raw);

            if (fileStatus.audio.exists && !versionStale.audio) {
                data.audio = true;
                data.audio_status = audioIsReal ? 'ready' : 'placeholder';
            }
            if (fileStatus.image.exists && !versionStale.image) {
                data.image = true;
                data.image_status = 'ready';
            }
            if (fileStatus.video.exists && !versionStale.video) {
                data.video = true;
                data.video_status = 'ready';
            }
            await redis.set(key, JSON.stringify(data));
        }
    } while (cursor !== '0');
}

/**
 * Check if generation was cancelled for this book.
 */
async function isCancelled(redis, bookId) {
    const val = await redis.get(cancelKey(bookId));
    return val === 'true' || val === '1';
}

/**
 * Clear the cancel flag for this book.
 */
async function clearCancelFlag(redis, bookId) {
    await redis.del(cancelKey(bookId));
}

/**
 * Set the cancel flag for this book.
 */
async function setCancelFlag(redis, bookId) {
    await redis.set(cancelKey(bookId), 'true');
}

async function isWindowComplete(redis, bookId) {
    const nextIdx = parseInt(await redis.get(BOOK_SCENE_NEXT(bookId)) || '0', 10);
    if (nextIdx === 0) return false;
    const windowStart = parseInt(await redis.get(BOOK_WINDOW_START(bookId)) || '0', 10);
    const bookData = book.loadBook(bookId);
    if (!bookData) return false;
    const scenes = book.collectScenes(bookData);

    const workerHealth = require('./worker-health');
    const hasVideo = await workerHealth.isAvailable(redis, 'video');

    // Read layer config so we know which layers are actually enabled.
    // If a layer is disabled, we don't require it to be 'ready'.
    const layerKey = `animastor:layer-config:${bookId}`;
    const layerRaw = await redis.get(layerKey);
    let imageEnabled = true;
    let videoEnabled = true;
    if (layerRaw) {
        try {
            const lc = JSON.parse(layerRaw);
            imageEnabled = lc.image_enabled !== false;
            videoEnabled = lc.video_enabled !== false;
        } catch (_) {}
    }

    for (let i = windowStart; i < nextIdx && i < scenes.length; i++) {
        const s = scenes[i];
        // T8: используем per-asset state вместо scene-state
        const assetStates = await state.getAssetStates(redis, bookId, s.chapter_id, s.scene_id);
        if (!assetStates) {
            log(`Window incomplete: ${s.chapter_id}/${s.scene_id} has no asset states`);
            return false;
        }

        const audioOk = assetStates.audio === state.AssetState.READY ||
                        assetStates.audio === state.AssetState.PLACEHOLDER;

        // If images are disabled by layer config, skip image readiness check
        const imageOk = !imageEnabled ||
                        assetStates.image === state.AssetState.READY ||
                        assetStates.image === state.AssetState.PLACEHOLDER;

        // If video is disabled by layer config, skip video readiness check
        let videoOk = true;
        if (hasVideo && videoEnabled) {
            videoOk = assetStates.video === state.AssetState.READY;
        }

        if (!audioOk || !imageOk || !videoOk) {
            log(`Window incomplete: ${s.chapter_id}/${s.scene_id} audio=${audioOk} image=${imageOk} video=${videoOk}`);
            return false;
        }
    }
    log(`Window complete: all ${nextIdx - windowStart} scenes have audio+image${hasVideo && videoEnabled ? '+video' : ''} ready`);
    return true;
}

/**
 * Try to slide window forward if all current window scenes have audio + image complete.
 */
async function trySlideWindowOnComplete(redis, bookId, loadedBook, buildId) {
    if (await isCancelled(redis, bookId)) {
        log(`trySlideWindowOnComplete: generation cancelled for ${bookId}`);
        return { started: 0, remaining: 0, reason: 'cancelled' };
    }

    // Reconcile chunk statuses against actual files on disk before checking
    // window completeness. This catches stale 'pending' statuses that may
    // have survived from a previous Cancel→Generate cycle — allowing the
    // window to slide without waiting for the next scheduler tick.
    await reconcileWindowStatuses(redis, bookId, buildId);

    if (await isWindowComplete(redis, bookId)) {
        const result = await slideWindow(redis, bookId, loadedBook, buildId);
        // After sliding, do a final reconciliation pass so /assets-state
        // reports correct counts immediately. This catches any chunk statuses
        // that startScene reset to 'pending' even though files exist on disk.
        await reconcileWindowStatuses(redis, bookId, buildId);
        return result;
    }
    const total = parseInt(await redis.get(BOOK_SCENE_TOTAL(bookId)) || '0', 10);
    const nextIdx = parseInt(await redis.get(BOOK_SCENE_NEXT(bookId)) || '0', 10);
    return { started: 0, remaining: Math.max(0, total - nextIdx), reason: 'window_incomplete' };
}

async function slideWindow(redis, bookId, loadedBook, buildId) {
    if (await isCancelled(redis, bookId)) {
        log(`Slide skipped: generation cancelled for ${bookId}`);
        return { started: 0, remaining: 0, reason: 'cancelled' };
    }

    const total = parseInt(await redis.get(BOOK_SCENE_TOTAL(bookId)) || '0', 10);
    let nextIdx = parseInt(await redis.get(BOOK_SCENE_NEXT(bookId)) || '0', 10);

    if (nextIdx >= total) {
        log(`All ${total} scenes already started in this scope`);
        return { started: 0, remaining: 0 };
    }

    const bookData = loadedBook || book.loadBook(bookId);
    const scenes = book.collectScenes(bookData);
    let started = 0;
    const windowStart = nextIdx;

    while (nextIdx < total && started < WINDOW_SIZE) {
        if (await isCancelled(redis, bookId)) {
            log(`Slide interrupted: generation cancelled for ${bookId} after starting ${started} scenes`);
            break;
        }

        const scene = scenes[nextIdx];
        if (!scene) {
            warn(`Scene at index ${nextIdx} not found`);
            nextIdx++;
            continue;
        }

        const sceneKey = `${state.SCENE_STATE_KEY_PREFIX}:${bookId}:${scene.chapter_id}:${scene.scene_id}`;
        const raw = await redis.get(sceneKey);

        if (raw) {
            const data = JSON.parse(raw);
            const st = data.state;

            if (_isTerminalState(st)) {
                // Scene is already in a terminal state (VIDEO_READY or FAILED)
                log(`Scene ${scene.chapter_id}/${scene.scene_id} already ${st}, window slot skipped`);
                nextIdx++;
                started++;
                continue;
            }

            // Scene has non-terminal state. Check cache advisory for valid content.
            const buildIdForCheck = data.build_id || buildId;
            const cacheInfo = await checkSceneContentCache(redis, buildIdForCheck, bookId, scene.chapter_id, scene.scene_id);
            if (cacheInfo.valid) {
                log(`Scene ${scene.chapter_id}/${scene.scene_id} has valid content (state=${st}), promoting to ${state.SceneState.VIDEO_READY}`);
                // M5: Facade owns READY + syncLinearState
                await orchestrator.setSceneAllReady(redis, bookId, scene.chapter_id, scene.scene_id, buildIdForCheck);
                await restoreChunkStatusForScene(redis, buildIdForCheck, bookId, scene.chapter_id, scene.scene_id);
                nextIdx++;
                started++;
                continue;
            }

            // No valid content — reset state and restart
            log(`Scene ${scene.chapter_id}/${scene.scene_id} has stale state ${st}, resetting for restart`);
            await redis.del(sceneKey);
            const scheduler = require('../runtime/runtime-scheduler');
            await scheduler.removeSceneFromActiveIndex(redis, bookId, scene.chapter_id, scene.scene_id);
        }

        const didStart = await startScene(redis, scene, buildId, bookId);
        if (didStart) {
            started++;
        }
        nextIdx++;
    }

    await redis.set(BOOK_SCENE_NEXT(bookId), nextIdx);
    await redis.set(BOOK_WINDOW_START(bookId), windowStart);
    log(`Window slid: started ${started} more scenes (next index=${nextIdx}/${total}, windowStart=${windowStart})`);
    return { started, remaining: total - nextIdx };
}

/**
 * Reconcile chunk statuses against actual file existence for all scenes in a book.
 * Scans chunk metadata and updates 'pending' → 'ready' where files exist on disk.
 * This ensures /assets-state returns correct counts even if completion handlers
 * were missed (e.g. after Cancel→Generate cycles).
 */
async function reconcileWindowStatuses(redis, bookId, buildId) {
    const buildDir = path.join(OUTPUT_DIR, buildId);
    if (!fs.existsSync(buildDir)) return { reconciled: 0 };

    const chunkKeys = await redis.keys(`animastor:chunk:${bookId}_*`);
    let reconciled = 0;

    // Track which scenes we've already checked (avoid duplicate PG queries)
    const versionCache = new Map();

    for (const key of chunkKeys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const data = JSON.parse(raw);
        if (!data.chapter_id || !data.scene_id) continue;

        let changed = false;

        // Use unified file status
        const fileStatus = await getSceneFilesStatus(buildDir, data.book_id, data.chapter_id, data.scene_id);

        // Д.3: Check PG version staleness (cache per scene to avoid N+1 queries)
        const sceneKey = `${data.book_id}:${data.chapter_id}:${data.scene_id}`;
        if (!versionCache.has(sceneKey)) {
            versionCache.set(sceneKey, await _checkAssetVersionStale(data.book_id, data.chapter_id, data.scene_id, buildId));
        }
        const stale = versionCache.get(sceneKey);

        // Check audio file — distinguish real TTS from placeholder
        if (data.audio_status === 'pending' || data.audio_status === 'placeholder') {
            if (fileStatus.audio.exists && !stale.audio) {
                data.audio = true;
                try {
                    const hasReal = await placeholderAudio.hasRealAudio(data.book_id, data.chapter_id, data.scene_id, buildId);
                    data.audio_status = hasReal ? 'ready' : 'placeholder';
                } catch (_) {
                    data.audio_status = 'placeholder';
                }
                changed = true;
            }
        }

        // Check for IU image files
        if (data.image_status === 'pending') {
            if (fileStatus.image.exists && !stale.image) {
                data.image = true;
                data.image_status = 'ready';
                changed = true;
            }
        }

        // Check video file
        if (data.video_status === 'pending') {
            if (fileStatus.video.exists && !stale.video) {
                data.video = true;
                data.video_status = 'ready';
                changed = true;
            }
        }

        if (changed) {
            // key is the full Redis key (animastor:chunk:bookId_chapterId_sceneId_index)
            await redis.set(key, JSON.stringify(data));
            reconciled++;
        }
    }

    if (reconciled > 0) {
        log(`Reconciled ${reconciled} chunk statuses for book ${bookId}`);
    }
    return { reconciled };
}

async function startScene(redis, s, buildId, bookId) {
    if (await isCancelled(redis, bookId)) {
        log(`startScene skipped: generation cancelled for ${bookId}`);
        return false;
    }

    const chapterId = s.chapter_id;
    const sceneId = s.scene_id;

    log(`Starting scene: ${bookId}/${chapterId}/${sceneId}`);

    // Before dispatching to GPU, check cache advisory for valid content on disk.
    // The orchestrator decides whether to skip GPU dispatch based on the advisory.
    const cacheInfo = await checkSceneContentCache(redis, buildId, bookId, chapterId, sceneId);
    if (cacheInfo.valid) {
        log(`Scene ${bookId}/${chapterId}/${sceneId}: valid content on disk, skipping GPU dispatch`);
        // M5: Facade owns READY + syncLinearState
        await orchestrator.setSceneAllReady(redis, bookId, chapterId, sceneId, buildId);
        // Restore chunk metadata that was reset by markDirtyScenes so the progress
        // endpoint (/assets-state) correctly counts this scene as ready.
        await restoreChunkStatusForScene(redis, buildId, bookId, chapterId, sceneId);
        return true;
    }

    // Check layer config: if audio is disabled, skip to IMAGE_PENDING
    const layerKey = `animastor:layer-config:${bookId}`;
    const layerRaw = await redis.get(layerKey);
    let audioDisabled = false;
    if (layerRaw) {
        try {
            const layerCfg = JSON.parse(layerRaw);
            audioDisabled = layerCfg.audio_enabled === false;
        } catch (e) {
            warn(`Failed to parse layer config for ${bookId}: ${e.message}`);
        }
    }

    // T8: setScenePending через фасад — always succeeds (per-asset state write)
    if (audioDisabled) {
        await orchestrator.setScenePending(redis, bookId, chapterId, sceneId, 'image');
    } else {
        await orchestrator.setScenePending(redis, bookId, chapterId, sceneId, 'audio');
    }

    // M5: Facade owns PLACEHOLDER + syncLinearState
    if (audioDisabled) {
        await orchestrator.setScenePlaceholder(redis, bookId, chapterId, sceneId);
    }

    const stateKey = `${state.SCENE_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`;
    const raw = await redis.get(stateKey);
    if (raw) {
        const data = JSON.parse(raw);
        data.build_id = buildId;
        await redis.set(stateKey, JSON.stringify(data));
    }

    const segments = audio.buildSegments(s);
    const expectedChunkCount = segments.length;
    for (let i = 0; i < expectedChunkCount; i++) {
        const chunkIndex = i + 1;
        const chunkId = audio.makeChunkId(chapterId, sceneId, chunkIndex, bookId);
        const chunkKey = `animastor:chunk:${chunkId}`;
        const existingChunk = await redis.get(chunkKey);
        if (existingChunk) {
            const data = JSON.parse(existingChunk);
            data.audio = false;
            data.audio_status = 'pending';
            data.image = false;
            data.video = false;
            data.video_status = 'pending';
            data.build_id = buildId;
            // 🔧 FIX: Always update expected_chunk_count for existing chunks too.
            // The import creates chunk _0001 with expected_chunk_count=1, but
            // buildSegments may produce more segments (e.g. 9). Without this
            // update, chunk _0001 retains expected_chunk_count=1, causing
            // triggerAudioMerge to merge prematurely (with only 1 chunk)
            // instead of waiting for all chunks to arrive.
            data.expected_chunk_count = expectedChunkCount;
            data.padded_text = segments[i]?.padded || false;
            await redis.set(chunkKey, JSON.stringify(data));
        } else {
            const chunkData = {
                build_id: buildId,
                book_id: bookId,
                chapter_id: chapterId,
                scene_id: sceneId,
                chunk_index: String(chunkIndex).padStart(4, '0'),
                expected_chunk_count: expectedChunkCount,
                scene_type: s.scene_type || 'narration',
                scene_order: s.scene_order || 0,
                audio: false,
                audio_status: 'pending',
                image: false,
                image_status: 'pending',
                padded_text: segments[i]?.padded || false
            };
            await redis.set(chunkKey, JSON.stringify(chunkData));
            await redis.sadd(`animastor:chunks:${bookId}`, chunkId);
        }
    }

    // If audio is disabled, mark all chunks as audio-ready (placeholder timing)
    if (audioDisabled) {
        for (let i = 0; i < expectedChunkCount; i++) {
            const chunkIndex = i + 1;
            const chunkId = audio.makeChunkId(chapterId, sceneId, chunkIndex, bookId);
            const chunkKey = `animastor:chunk:${chunkId}`;
            const existingChunk = await redis.get(chunkKey);
            if (existingChunk) {
                const data = JSON.parse(existingChunk);
                data.audio = true;
                data.audio_status = 'placeholder';
                await redis.set(chunkKey, JSON.stringify(data));
            }
        }
    }

    const addResult = await activeScenes.addActiveScene(redis, bookId, chapterId, sceneId);
    log(`Scene queued: ${bookId}/${chapterId}/${sceneId}`);

    // Only when audio is enabled — if disabled, we already set chunks as ready above
    if (audioDisabled) return addResult.added;

    // Placeholder audio: создаётся синхронно (await), ДО того как сцена попадает в scheduler.
    // Задержка ~2s (ffmpeg silence generation) — не критична, но устраняет race condition
    // между setImmediate и generateSceneAudio (placeholder re-created после удаления).
    try {
        const buildEffective = buildId || 'default';
        const phResult = await placeholderAudio.ensurePlaceholderAudio(buildEffective, bookId, chapterId, sceneId);
        if (phResult.created) {
            log(`Placeholder audio created for ${bookId}/${chapterId}/${sceneId} (${phResult.durationSec.toFixed(1)}s)`);
        } else {
            log(`Placeholder audio reused for ${bookId}/${chapterId}/${sceneId} (${phResult.reason})`);
        }

        // Update chunk metadata — audio_status = 'placeholder' (not 'ready')
        for (let i = 0; i < expectedChunkCount; i++) {
            const chunkIndex = i + 1;
            const chunkId = audio.makeChunkId(chapterId, sceneId, chunkIndex, bookId);
            const chunkKey = `animastor:chunk:${chunkId}`;
            const chunk = await redis.get(chunkKey);
            if (chunk) {
                const data = JSON.parse(chunk);
                data.audio = true;
                data.audio_status = 'placeholder';
                await redis.set(chunkKey, JSON.stringify(data));
            }
        }
        // 🔧 AUDIO-ORCH: Установить phase = PLACEHOLDER_READY — единственный арбитр состояния
        const audioOrch = require('../services/audio-orchestrator');
        await audioOrch.initPlaceholderReady(redis, bookId, chapterId, sceneId, buildEffective, expectedChunkCount);
    } catch (err) {
        warn(`Placeholder audio failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
    }

    return addResult.added;
}

module.exports = {
    initSceneWindow,
    setWindowBounds,
    slideWindow,
    startScene,
    isWindowComplete,
    trySlideWindowOnComplete,
    isCancelled,
    clearCancelFlag,
    setCancelFlag,
    cancelKey,
    getSceneFilesStatus,
    checkSceneContentCache,
    restoreChunkStatusForScene,
    reconcileWindowStatuses,
    WINDOW_SIZE,
    BOOK_SCENE_TOTAL,
    BOOK_SCENE_NEXT,
    BOOK_WINDOW_START,
};
