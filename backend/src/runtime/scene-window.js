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
const activeScenes = require('./active-scenes-index');
const audio = require('../audio/audio-service');
const genScope = require('../services/gen-scope');
const sceneAssetsRepo = require('../storage/postgres/repositories/scene-assets-repo');
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
 * Check if scene has valid content on disk and can be skipped.
 * Verifies that the prerequisite files exist for each enabled layer.
 *
 * Placeholder audio IS valid content — it provides timing structure
 * for image generation and playback. Real audio can replace it later.
 */
async function sceneHasValidContent(redis, buildId, bookId, chapterId, sceneId) {
    const buildDir = path.join(OUTPUT_DIR, buildId);
    if (!fs.existsSync(buildDir)) return false;

    // Audio file must exist (real or placeholder) for timing
    const audioPath = path.join(buildDir, `${bookId}_${chapterId}_${sceneId}.mp3`);
    if (!fs.existsSync(audioPath)) return false;

    // Check for at least one IU image
    let files;
    try { files = fs.readdirSync(buildDir); } catch { return false; }
    const imagePrefix = `${bookId}_${chapterId}_${sceneId}_iu`;
    const hasImage = files.some(f => f.startsWith(imagePrefix) && f.endsWith('.png'));

    // Check for video
    const videoPath = path.join(buildDir, `${bookId}_${chapterId}_${sceneId}.mp4`);
    const hasVideo = fs.existsSync(videoPath);

    // Scene is valid if it has audio (real or placeholder) and at least one of image/video
    return hasImage || hasVideo;
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

    for (let i = windowStart; i < nextIdx && i < scenes.length; i++) {
        const s = scenes[i];
        const sceneStateKey = `${state.SCENE_STATE_KEY_PREFIX}:${bookId}:${s.chapter_id}:${s.scene_id}`;
        const raw = await redis.get(sceneStateKey);
        if (!raw) {
            log(`Window incomplete: ${s.chapter_id}/${s.scene_id} has no state`);
            return false;
        }
        const data = JSON.parse(raw);
        const st = data.state;

        const audioOk = st === state.SceneState.AUDIO_READY ||
                        st === state.SceneState.IMAGE_PENDING ||
                        st === state.SceneState.IMAGE_GENERATING ||
                        st === state.SceneState.IMAGE_READY ||
                        st === state.SceneState.VIDEO_PENDING ||
                        st === state.SceneState.VIDEO_GENERATING ||
                        st === state.SceneState.VIDEO_READY;
        const imageOk = st === state.SceneState.IMAGE_READY ||
                        st === state.SceneState.VIDEO_PENDING ||
                        st === state.SceneState.VIDEO_GENERATING ||
                        st === state.SceneState.VIDEO_READY;

        let videoOk = true;
        if (hasVideo) {
            videoOk = st === state.SceneState.VIDEO_READY;
        }

        if (!audioOk || !imageOk || !videoOk) {
            log(`Window incomplete: ${s.chapter_id}/${s.scene_id} audio=${audioOk} image=${imageOk} video=${videoOk} (state=${st})`);
            return false;
        }
    }
    log(`Window complete: all ${nextIdx - windowStart} scenes have audio+image${hasVideo ? '+video' : ''} ready`);
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
    if (await isWindowComplete(redis, bookId)) {
        return await slideWindow(redis, bookId, loadedBook, buildId);
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

            // Scene has non-terminal state. Check if valid content exists on disk.
            const buildIdForCheck = data.build_id || buildId;
            if (await sceneHasValidContent(redis, buildIdForCheck, bookId, scene.chapter_id, scene.scene_id)) {
                log(`Scene ${scene.chapter_id}/${scene.scene_id} has valid content (state=${st}), promoting to ${state.SceneState.VIDEO_READY}`);
                await state.transitionSceneState(redis, bookId, scene.chapter_id, scene.scene_id, state.SceneState.VIDEO_READY);
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

async function startScene(redis, s, buildId, bookId) {
    if (await isCancelled(redis, bookId)) {
        log(`startScene skipped: generation cancelled for ${bookId}`);
        return false;
    }

    const chapterId = s.chapter_id;
    const sceneId = s.scene_id;

    log(`Starting scene: ${bookId}/${chapterId}/${sceneId}`);

    // Before dispatching to GPU, check if valid content already exists on disk.
    // This handles the case where content was generated in a previous run and
    // is still valid — we skip the expensive GPU dispatch entirely.
    if (await sceneHasValidContent(redis, buildId, bookId, chapterId, sceneId)) {
        log(`Scene ${bookId}/${chapterId}/${sceneId}: valid content on disk, skipping GPU dispatch`);
        await state.setSceneStateWithBuildId(redis, bookId, chapterId, sceneId, state.SceneState.VIDEO_READY, buildId);
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

    const initialTarget = audioDisabled
        ? state.SceneState.IMAGE_PENDING
        : state.SceneState.AUDIO_PENDING;

    const result = await state.transitionSceneState(
        redis, bookId, chapterId, sceneId,
        initialTarget
    );

    if (!result.success) {
        if (result.reason === 'invalid_transition' || result.reason === 'lock_held') {
            log(`Force-resetting stale scene state: ${bookId}/${chapterId}/${sceneId} (${result.oldState})`);
            const stateKey = `${state.SCENE_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`;
            await redis.del(stateKey);
            const iuCleanPrefix = `animastor:iu:${bookId}_${chapterId}_${sceneId}_*`;
            let iuCursor = '0';
            do {
                const scan = await redis.scan(iuCursor, 'MATCH', iuCleanPrefix, 'COUNT', 200);
                iuCursor = scan[0];
                if (scan[1].length) await redis.del(scan[1]);
            } while (iuCursor !== '0');
            const retry = await state.transitionSceneState(
                redis, bookId, chapterId, sceneId,
                initialTarget
            );
            if (!retry.success) {
                warn(`Failed to start scene after force-reset ${bookId}/${chapterId}/${sceneId}: ${retry.reason}`);
                return false;
            }
        } else {
            warn(`Failed to start scene ${bookId}/${chapterId}/${sceneId}: ${result.reason}`);
            return false;
        }
    }

    // If audio disabled, mark asset state as placeholder
    if (audioDisabled) {
        await state.setAssetState(redis, bookId, chapterId, sceneId, 'audio', state.AssetState.PLACEHOLDER);
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

    // Generate placeholder audio for this scene (fire-and-forget, non-blocking)
    // Only when audio is enabled — if disabled, we already set chunks as ready above
    if (audioDisabled) return addResult.added;

    // Generate placeholder audio for this scene (fire-and-forget, non-blocking)
    setImmediate(async () => {
        try {
            const buildEffective = buildId || 'default';
            const result = await placeholderAudio.ensurePlaceholderAudio(buildEffective, bookId, chapterId, sceneId);
            if (result.created) {
                log(`Placeholder audio created for ${bookId}/${chapterId}/${sceneId} (${result.durationSec.toFixed(1)}s)`);
                // Update chunk metadata so frontend sees audio as ready
                for (let i = 0; i < expectedChunkCount; i++) {
                    const chunkIndex = i + 1;
                    const chunkId = audio.makeChunkId(chapterId, sceneId, chunkIndex, bookId);
                    const chunkKey = `animastor:chunk:${chunkId}`;
                    const chunk = await redis.get(chunkKey);
                    if (chunk) {
                        const data = JSON.parse(chunk);
                        data.audio = true;
                        data.audio_status = 'ready';
                        await redis.set(chunkKey, JSON.stringify(data));
                    }
                }
            }
        } catch (err) {
            warn(`Placeholder audio failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
        }
    });

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
    WINDOW_SIZE,
    BOOK_SCENE_TOTAL,
    BOOK_SCENE_NEXT,
    BOOK_WINDOW_START,
};
