// ======================================================
// Runtime Scheduler - v1.0.0
// ======================================================
// The ONLY authority for scene lifecycle progression.
// Decides WHEN to start stages, NOT HOW.
// Callbacks only register results - scheduler owns progression.

const state = require('../state');
const dispatchEngine = require('./dispatch-engine');

const logPrefix = '[SCHEDULER]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

function error(msg) {
    console.error(`${logPrefix} ❌ ${msg}`);
}

// ======================================================
// HELPERS
// ======================================================

/**
 * Read layer config for a book.
 */
async function getLayerConfig(redis, bookId) {
    const layerKey = `animastor:layer-config:${bookId}`;
    const layerRaw = await redis.get(layerKey);
    if (layerRaw) {
        try { return JSON.parse(layerRaw); } catch (_) {}
    }
    return { audio_enabled: true, image_enabled: true, video_enabled: true };
}

/**
 * Check if scene chunks have images marked as ready on disk.
 * Used when image worker is disabled but video needs to verify images exist.
 */
async function checkChunksHaveImages(redis, bookId, chapterId, sceneId) {
    const chunkPrefix = `animastor:chunk:${bookId}_${chapterId}_${sceneId}_`;
    let cursor = '0';
    let hasImages = false;
    do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${chunkPrefix}*`, 'COUNT', 50);
        cursor = nextCursor;
        for (const key of keys) {
            const raw = await redis.get(key);
            if (raw) {
                try {
                    const ch = JSON.parse(raw);
                    if (ch.image === true && ch.image_status === 'ready') {
                        hasImages = true;
                        break;
                    }
                } catch (_) {}
            }
        }
    } while (cursor !== '0' && !hasImages);
    return hasImages;
}

// ======================================================
// CONFIGURATION
// ======================================================

const SCHEDULER_TICK_MS = 5000; // 5 seconds

// ======================================================
// ACTIVE SCENE INDEX — T8: де-дубликация
// ======================================================
// T8: runtime-scheduler больше НЕ владеет своим API active-scenes.
// Все операции делегируются в active-scenes-index.js — единственный command API.
// addSceneToActiveIndex/removeSceneToActiveIndex оставлены как обёртки для
// обратной совместимости. Новый код должен использовать activeScenes API напрямую.

const activeScenes = require('./active-scenes-index');
const ACTIVE_SCENES_KEY = activeScenes.ACTIVE_SCENES_KEY;

/**
 * Add scene to active index. T8: делегирует в active-scenes-index.js.
 */
async function addSceneToActiveIndex(redis, bookId, chapterId, sceneId) {
    const result = await activeScenes.addActiveScene(redis, bookId, chapterId, sceneId);
    if (result.added) {
        log(`+ ACTIVE: ${result.sceneKey} added to active index`);
    }
    return result;
}

/**
 * Remove scene from active index. T8: делегирует в active-scenes-index.js.
 */
async function removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId) {
    const result = await activeScenes.removeActiveScene(redis, bookId, chapterId, sceneId);
    if (result.removed) {
        log(`- ACTIVE: ${result.sceneKey} removed from active index`);
    }
    return result;
}

// M4 (Н.9): removed dead concurrent counter functions — dispatchEngine owns quotas

// ======================================================
// STATE TO STAGE MAPPING
// ======================================================

// Re-export SceneState for convenience
const STATE_TO_STAGE = {
    'audio_pending': 'audio',
    'image_pending': 'image',
    'video_pending': 'video'
};

const STAGE_TO_STATE = {
    audio: 'audio_pending',
    image: 'image_pending',
    video: 'video_pending'
};

// ======================================================
// SCHEDULER API
// ======================================================

/**
 * Get list of all active scenes from the index.
 */
async function getActiveSceneKeys(redis) {
    return await redis.smembers(ACTIVE_SCENES_KEY);
}

/**
 * Remove all active scenes belonging to a specific book.
 * Used when cancelling generation for a book.
 */
async function clearBookFromActiveIndex(redis, bookId) {
    const activeKeys = await getActiveSceneKeys(redis);
    let removed = 0;
    for (const sceneKey of activeKeys) {
        if (sceneKey.startsWith(`${bookId}:`)) {
            await redis.srem(ACTIVE_SCENES_KEY, sceneKey);
            removed++;
        }
    }
    if (removed > 0) {
        log(`CANCEL: removed ${removed} active scenes for book ${bookId}`);
    }
    return removed;
}

/**
 * Remove specific scenes from the active index.
 * Used by regenerate to only remove dirty scenes, preserving other scenes'
 * active index entries so the scheduler continues processing them.
 *
 * @param {Array<{chapter_id:string,scene_id:string}>} scenes - scenes to remove
 */
async function removeScenesFromActiveIndex(redis, bookId, scenes) {
    if (!scenes || scenes.length === 0) return 0;
    let removed = 0;
    for (const s of scenes) {
        const sceneKey = `${bookId}:${s.chapter_id}:${s.scene_id}`;
        const result = await redis.srem(ACTIVE_SCENES_KEY, sceneKey);
        if (result > 0) removed++;
    }
    if (removed > 0) {
        log(`REMOVED: removed ${removed} specific scenes from active index for book ${bookId}`);
    }
    return removed;
}

/**
 * Parse scene key to extract bookId, chapterId, sceneId.
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
 * Determine which asset stages need scheduling for a scene.
 * Uses per-asset states as source of truth.
 * Each worker is independent:
 *   - Audio: dispatches if enabled and not ready
 *   - Image: dispatches if enabled and not ready (independent of audio)
 *   - Video: dispatches if enabled, not ready, and image=ready
 *
 * Returns { stages: string[], allDone: boolean }
 */
/**
 * Д.2: Detect PG version-staleness — PURE READ, no writes.
 *
 * R4.2: If asset_version < scene_version in PG, the scene needs regeneration
 * even if Redis per-asset states show it as 'ready' (e.g. Redis was flushed or
 * the version bump happened while Redis was offline). PG is the source of truth
 * for dirty detection; Redis per-asset states are only a runtime cache.
 *
 * @returns {Promise<boolean>} true if any 'ready' asset row is version-stale
 */
async function detectVersionStale(redis, bookId, chapterId, sceneId) {
    try {
        const { query } = require('../storage/postgres/database');
        const verResult = await query(`
            SELECT s.content_version, s.audio_config_version,
                   a.scene_content_version, a.scene_audio_config_version, a.status as asset_status
            FROM scenes s
            LEFT JOIN scene_assets a ON a.book_id = s.book_id
                AND a.chapter_id = s.chapter_id
                AND a.scene_id = s.scene_id
            WHERE s.book_id = $1 AND s.chapter_id = $2 AND s.scene_id = $3
        `, [bookId, chapterId, sceneId]);

        for (const row of verResult.rows) {
            if (row.asset_status === 'ready') {
                if (row.scene_content_version != null && row.content_version != null &&
                    row.scene_content_version < row.content_version) {
                    log(`[VERSION-DIRTY] ${bookId}/${chapterId}/${sceneId}: content_version stale (asset=${row.scene_content_version} < scene=${row.content_version})`);
                    return true;
                }
                if (row.scene_audio_config_version != null && row.audio_config_version != null &&
                    row.scene_audio_config_version < row.audio_config_version) {
                    log(`[VERSION-DIRTY] ${bookId}/${chapterId}/${sceneId}: audio_config_version stale (asset=${row.scene_audio_config_version} < scene=${row.audio_config_version})`);
                    return true;
                }
            }
        }
    } catch (err) {
        // PG query failed — fall back to Redis-only detection (no stale signal)
        warn(`[VERSION-DIRTY] PG version check failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
    }
    return false;
}

/**
 * Д.2: Apply the version-stale reset — the explicit WRITE pass.
 *
 * Resets enabled READY assets to DIRTY so the dispatch engine picks them up.
 * Separated from detection so shouldScheduleAssets stays pure (P3 in the
 * state-writers map). Returns the number of assets reset.
 */
async function markVersionStaleDirty(redis, bookId, chapterId, sceneId) {
    const layerCfg = await getLayerConfig(redis, bookId);
    const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const audioEnabled = layerCfg.audio_enabled !== false;
    const imageEnabled = layerCfg.image_enabled !== false;
    const videoEnabled = layerCfg.video_enabled !== false;

    log(`[VERSION-DIRTY] ${bookId}/${chapterId}/${sceneId}: PG version mismatch — resetting per-asset states for dispatch`);
    // T8: через фасад — единый владелец DIRTY
    const orchestrator = require('../orchestration/orchestrator');
    const dirtyAssets = [];
    if (audioEnabled && assetStates.audio === state.AssetState.READY) dirtyAssets.push('audio');
    if (imageEnabled && assetStates.image === state.AssetState.READY) dirtyAssets.push('image');
    if (videoEnabled && assetStates.video === state.AssetState.READY) dirtyAssets.push('video');
    if (dirtyAssets.length > 0) {
        await orchestrator.markDirtyScene(redis, bookId, chapterId, sceneId, dirtyAssets);
    }
    return dirtyAssets.length;
}

async function shouldScheduleAssets(redis, bookId, chapterId, sceneId) {
    // Д.2: This function is now PURE — it only reads per-asset states and layer
    // config and computes { stages, allDone }. It performs NO writes. The former
    // version-stale READY→DIRTY reset is an explicit pre-pass in attemptDispatch
    // (detectVersionStale + markVersionStaleDirty), so the decision is separated
    // from the mutation (single arbiter — see docs/STATE_WRITERS_MAP.md P3).
    const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const layerCfg = await getLayerConfig(redis, bookId);

    const audioEnabled = layerCfg.audio_enabled !== false;
    const imageEnabled = layerCfg.image_enabled !== false;
    const videoEnabled = layerCfg.video_enabled !== false;

    // Check if all enabled assets are in terminal states
    // (after potential version-stale reset above)
    const allDone = (
        (!audioEnabled || assetStates.audio === state.AssetState.READY || assetStates.audio === state.AssetState.FAILED) &&
        (!imageEnabled || assetStates.image === state.AssetState.READY || assetStates.image === state.AssetState.FAILED) &&
        (!videoEnabled || assetStates.video === state.AssetState.READY || assetStates.video === state.AssetState.FAILED)
    );
    if (allDone) return { stages: [], allDone: true };

    const stages = [];

    // Audio: independent — dispatch if not ready and not already generating
    if (audioEnabled &&
        assetStates.audio !== state.AssetState.READY &&
        assetStates.audio !== state.AssetState.FAILED &&
        assetStates.audio !== state.AssetState.GENERATING &&
        assetStates.audio !== state.AssetState.PLACEHOLDER) {
        stages.push('audio');
    }

    // Image: independent of audio — dispatch if not ready and not already generating
    if (imageEnabled &&
        assetStates.image !== state.AssetState.READY &&
        assetStates.image !== state.AssetState.FAILED &&
        assetStates.image !== state.AssetState.GENERATING) {
        stages.push('image');
    }

    // Video: requires image=ready — if images aren't ready, skip silently
    if (videoEnabled &&
        assetStates.video !== state.AssetState.READY &&
        assetStates.video !== state.AssetState.FAILED &&
        assetStates.video !== state.AssetState.GENERATING) {
        let imageReady = assetStates.image === state.AssetState.READY;
        if (!imageReady && !imageEnabled) {
            imageReady = await checkChunksHaveImages(redis, bookId, chapterId, sceneId);
        }
        if (imageReady) {
            stages.push('video');
        }
    }

    return { stages, allDone };
}

/**
 * Process all active scenes.
 * Returns summary of operations.
 */
async function tick(redis, loadedBooks = {}) {
    log('=== RUNTIME SCHEDULER TICK ===');

    // Acquire tick lock for single-flight protection
    const tickLock = await dispatchEngine.acquireSchedulerTickLock(redis);
    if (!tickLock.acquired) {
        log('TICK_SKIPPED: Another tick is still running');
        return {
            skipped: true,
            reason: 'tick_running',
            timestamp: new Date().toISOString()
        };
    }

    // T6.5: Все тело tick обёрнуто в try/finally для гарантированного
    // освобождения lock даже при исключении (не только в per-scene catch).
    try {
        const activeKeys = await getActiveSceneKeys(redis);
        const summary = {
            totalActive: activeKeys.length,
            processed: 0,
            dispatched: 0,
            throttled: 0,
            skipped: 0,
            completed: 0,
            errors: []
        };

        // Cache force-dispatch flags per book to avoid redundant Redis calls
        const forceCache = new Map();
        // Cache loaded books per tick to avoid redundant disk reads
        const bookCache = new Map();

        for (const sceneKey of activeKeys) {
            const parsed = parseSceneKey(sceneKey);
            if (!parsed) {
                summary.errors.push(`Invalid scene key: ${sceneKey}`);
                continue;
            }

            const { bookId, chapterId, sceneId } = parsed;

            // Check force-dispatch flag for recently regenerated books (cached per book)
            let force = false;
            if (forceCache.has(bookId)) {
                force = forceCache.get(bookId);
            } else {
                const forceFlag = await redis.get(`animastor:force-dispatch:${bookId}`);
                force = forceFlag === '1';
                forceCache.set(bookId, force);
            }

            // Resolve loaded book from cache or load it
            let sceneLoadedBook = loadedBooks[bookId];
            if (!sceneLoadedBook) {
                if (bookCache.has(bookId)) {
                    sceneLoadedBook = bookCache.get(bookId);
                } else {
                    try {
                        const bookModule = require('../book');
                        sceneLoadedBook = bookModule.loadBook(bookId);
                        bookCache.set(bookId, sceneLoadedBook);
                    } catch (_) {
                        sceneLoadedBook = null;
                    }
                }
            }

            try {
                const result = await attemptDispatch(redis, bookId, chapterId, sceneId, sceneLoadedBook, force);
                summary.processed++;

                if (result.completed) {
                    summary.completed++;
                } else if (result.dispatched && result.dispatched > 0) {
                    summary.dispatched += result.dispatched;
                    if (result.throttled > 0) summary.throttled += result.throttled;
                } else if (result.skip) {
                    summary.skipped++;
                } else if (result.throttled > 0) {
                    summary.throttled += result.throttled;
                } else if (result.reason === 'backpressure' || result.reason === 'throttled') {
                    summary.throttled++;
                } else if (result.success) {
                    // No action needed
                } else {
                    summary.errors.push(`${result.reason} for ${sceneKey}`);
                }
            } catch (err) {
                summary.errors.push(`Error processing ${sceneKey}: ${err.message}`);
                error(`Tick error for ${sceneKey}: ${err.message}`);
            }
        }

        log(`=== TICK COMPLETE ===`);
        log(`Active: ${summary.totalActive}, Dispatched: ${summary.dispatched}, Skipped: ${summary.skipped}, Throttled: ${summary.throttled}, Completed: ${summary.completed}`);

        if (summary.errors.length > 0) {
            log(`Errors: ${summary.errors.length}`);
            summary.errors.slice(0, 5).forEach(e => log(`  - ${e}`));
        }

        return summary;
    } finally {
        // T6.5: Гарантированное освобождение lock в finally.
        // Если исключение вылетело за пределы per-scene catch (напр. getActiveSceneKeys),
        // lock должен быть отпущен, чтобы scheduler не завис навсегда.
        try {
            await dispatchEngine.releaseSchedulerTickLock(redis, tickLock.token);
        } catch (lockErr) {
            error(`TICK_LOCK_RELEASE_FAILED: ${lockErr.message}`);
        }
    }
}

/**
 * Get runtime metrics for debugging.
 */
async function getMetrics(redis) {
    const activeCount = await redis.scard(ACTIVE_SCENES_KEY);
    
    // M4 (Н.9): quotas are owned by dispatchEngine — delegate to getQuotaStatus
    let quotaStatus = { audio: { current: 0, max: 0 }, image: { current: 0, max: 0 }, video: { current: 0, max: 0 } };
    try {
        quotaStatus = await dispatchEngine.getQuotaStatus(redis);
    } catch (e) {
        warn(`getMetrics: dispatchEngine.getQuotaStatus failed: ${e.message}`);
    }

    return {
        activeScenes: activeCount,
        concurrent: {
            audio: quotaStatus.audio.current,
            image: quotaStatus.image.current,
            video: quotaStatus.video.current
        },
        limits: {
            audio: quotaStatus.audio.max,
            image: quotaStatus.image.max,
            video: quotaStatus.video.max
        }
    };
}

// ======================================================
// ATTEMPT DISPATCH (NEW: Uses dispatch engine)
// ======================================================

/**
 * Attempt to dispatch scene stages using per-asset states.
 * Supports independent workers: dispatches ALL eligible stages in one tick.
 * When force=true, any existing lease is cleared before dispatch.
 * Returns { dispatched: number, completed: boolean, reason: string }
 */
async function attemptDispatch(redis, bookId, chapterId, sceneId, loadedBook, force = false) {
    const sceneKey = `${bookId}:${chapterId}:${sceneId}`;

    // Resolve build_id from manifest (passed from tick with book cache) or null
    const buildId = loadedBook?.manifest?.build_id || null;

    // Д.2: Version-stale pre-pass — detect (pure read) then reset (explicit write)
    // BEFORE planning, so a stale 'ready' scene is re-dispatched in the SAME tick.
    // Keeps shouldScheduleAssets pure (decision separated from mutation).
    if (await detectVersionStale(redis, bookId, chapterId, sceneId)) {
        await markVersionStaleDirty(redis, bookId, chapterId, sceneId);
    }

    // Determine which asset stages need scheduling (from per-asset states)
    const { stages, allDone } = await shouldScheduleAssets(redis, bookId, chapterId, sceneId);

    if (allDone) {
        await removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId);
        log(`COMPLETE: ${sceneKey} (all assets ready) - removed from active index`);
        return { completed: true, reason: 'all_assets_ready' };
    }

    if (stages.length === 0) {
        // Assets are in non-dispatchable states (e.g., generating, placeholder)
        // or video skipped because images not ready
        return { success: true, skip: true, reason: 'no_dispatchable_stages' };
    }

    log(`ATTEMPT_DISPATCH: ${sceneKey} -> stages=[${stages.join(', ')}]${force ? ' (force=true)' : ''}`);

    let dispatched = 0;
    let throttled = 0;

    // Dispatch ALL eligible stages in this tick.
    // Concurrency limits per stage type are handled by dispatch engine.
    for (const stage of stages) {
        const result = await dispatchEngine.dispatchStage(
            redis,
            bookId,
            chapterId,
            sceneId,
            stage,
            loadedBook,
            buildId,
            { force }
        );
        if (result.dispatched) {
            dispatched++;
        } else if (result.reason === 'backpressure' || result.reason === 'throttled') {
            throttled++;
        }
    }

    return { dispatched, throttled, stages: stages.length };
}

// ======================================================
// RESTART RECOVERY (Phase 11)
// ======================================================

const runtimePersistence = require('./runtime-persistence');

/**
 * Initialize runtime on startup.
 * Performs recovery from persisted state.
 */
async function initializeRuntime(redis) {
    log('INITIALIZING_RUNTIME');

    // 1. Initiate recovery
    const recovery = await runtimePersistence.initiateRecovery(redis);
    if (!recovery.success) {
        warn(`INITialization skipped: ${recovery.reason}`);
        return recovery;
    }

    // 2. Try to restore from snapshot
    const restoreResult = await runtimePersistence.restoreFromSnapshot(redis);
    if (restoreResult.success) {
        log(`RESTORED_RUNTIME: from snapshot timestamp=${restoreResult.snapshot.timestamp}`);
    } else {
        log('STARTUP: No snapshot available, starting fresh');
    }

    // 3. Verify recovery
    const verification = await runtimePersistence.verifyRecovery(redis);

    // 4. Finalize recovery
    await runtimePersistence.finalizeRecovery(redis, recovery.recoveryId);

    log(`RUNTIME_INITIALIZED: ${verification.activeSceneCount} active scenes restored`);

    return {
        success: true,
        recoveryId: recovery.recoveryId,
        verified: verification
    };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Configuration
    SCHEDULER_TICK_MS,

    // Active scene index
    ACTIVE_SCENES_KEY,
    addSceneToActiveIndex,
    removeSceneFromActiveIndex,
    clearBookFromActiveIndex,
    removeScenesFromActiveIndex,
    getActiveSceneKeys,
    parseSceneKey,

    // Scheduling
    shouldScheduleAssets,
    detectVersionStale,
    markVersionStaleDirty,
    getLayerConfig,
    checkChunksHaveImages,
    tick,
    getMetrics,

    // Re-exports
    AssetState: state.AssetState,
    STATE_TO_STAGE,
    STAGE_TO_STATE,

    // Phase 11: Runtime initialization
    initializeRuntime
};