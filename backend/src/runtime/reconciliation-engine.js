// ======================================================
// Reconciliation Engine - v1.0.0
// ======================================================
// Self-healing engine that detects and fixes inconsistencies
// between state machine and actual assets on disk/registry.

const fs = require('fs').promises;

const state = require('../state');
const storage = require('../storage');
const config = require('../config/runtime-config');
const journal = require('../orchestration/event-journal');
const runtimeScheduler = require('./runtime-scheduler');
const counterReconciliation = require('./counter-reconciliation');

const logPrefix = '[RECONCILE]';

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
// RECONCILIATION REPORT
// ======================================================

class ReconciliationReport {
    constructor() {
        this.orphanStates = [];
        this.orphanAssets = [];
        this.partialBuilds = [];
        this.staleLocks = [];
        this.inconsistentScenes = [];
    }

    toSummary() {
        return {
            totalOrphanStates: this.orphanStates.length,
            totalOrphanAssets: this.orphanAssets.length,
            totalPartialBuilds: this.partialBuilds.length,
            totalStaleLocks: this.staleLocks.length,
            totalInconsistent: this.inconsistentScenes.length,
            orphanStates: this.orphanStates,
            orphanAssets: this.orphanAssets,
            partialBuilds: this.partialBuilds,
            staleLocks: this.staleLocks,
            inconsistentScenes: this.inconsistentScenes
        };
    }
}

// ======================================================
// ORPHAN STATE CHECKS
// ======================================================

/**
 * Check for VIDEO_READY state but no video file.
 */
async function checkOrphanVideoState(redis, bookId, chapterId, sceneId) {
    const sceneState = await state.getSceneState(redis, bookId, chapterId, sceneId);

    if (!sceneState || sceneState.state !== state.SceneState.VIDEO_READY) {
        return null;
    }

    const buildId = sceneState.build_id;
    const videoPath = `/data/output/${buildId}/${bookId}_${chapterId}_${sceneId}.mp4`;

    try {
        await fs.access(videoPath);
        return null; // File exists, state is valid
    } catch (err) {
        return {
            type: 'orphan_video_state',
            scene: { bookId, chapterId, sceneId },
            state: state.SceneState.VIDEO_READY,
            missingFile: videoPath,
            recommendation: 'regenerate_video'
        };
    }
}

/**
 * Check for IMAGE_READY state but no image file.
 */
async function checkOrphanImageState(redis, bookId, chapterId, sceneId) {
    const sceneState = await state.getSceneState(redis, bookId, chapterId, sceneId);

    if (!sceneState || sceneState.state !== state.SceneState.IMAGE_READY) {
        return null;
    }

    const imageModule = require('../image');
    const imageInfo = imageModule.resolveCanonicalSceneImage(
        '/data/output',
        sceneState.build_id,
        bookId,
        chapterId,
        sceneId,
    );

    if (!imageInfo) {
        return {
            type: 'orphan_image_state',
            scene: { bookId, chapterId, sceneId },
            state: state.SceneState.IMAGE_READY,
            missingFile: 'image_not_found',
            recommendation: 'regenerate_image'
        };
    }

    return null;
}

/**
 * Check for AUDIO_READY state but no audio file.
 */
async function checkOrphanAudioState(redis, bookId, chapterId, sceneId) {
    const sceneState = await state.getSceneState(redis, bookId, chapterId, sceneId);

    if (!sceneState || sceneState.state !== state.SceneState.AUDIO_READY) {
        return null;
    }

    // Guard: build_id must be present to check audio file
    if (!sceneState.build_id) {
        // Scene is in AUDIO_READY but has no build_id — this is an inconsistency
        // that should be flagged but not crash. Return a warning rather than an
        // orphan state so the auto-fix engine can address it.
        return {
            type: 'orphan_audio_state',
            scene: { bookId, chapterId, sceneId },
            state: state.SceneState.AUDIO_READY,
            missingFile: 'build_id_missing',
            recommendation: 'regenerate_audio'
        };
    }

    const audioModule = require('../audio');
    const storage = require('../storage');
    const audioPath = storage.filesystem.getSceneAudioPath(
        config.OUTPUT_DIR,
        sceneState.build_id,
        bookId,
        chapterId,
        sceneId
    );

    try {
        await fs.access(audioPath);
        return null; // File exists, state is valid
    } catch (err) {
        return {
            type: 'orphan_audio_state',
            scene: { bookId, chapterId, sceneId },
            state: state.SceneState.AUDIO_READY,
            missingFile: audioPath,
            recommendation: 'regenerate_audio'
        };
    }
}

// ======================================================
// ORPHAN ASSET CHECKS
// ======================================================

/**
 * Check for assets in registry but no files.
 */
async function checkOrphanAssets(redis, bookId, chapterId, sceneId) {
    const assets = await storage.registry.getSceneAssetsRedis(redis, bookId, chapterId, sceneId);

    if (!assets) {
        return null;
    }

    const orphanAssets = [];

    if (assets.audio?.canonical && assets.audio.ready) {
        try {
            await fs.access(assets.audio.canonical);
        } catch (err) {
            orphanAssets.push({
                type: 'missing_audio_file',
                scene: { bookId, chapterId, sceneId },
                path: assets.audio.canonical
            });
        }
    }

    if (assets.image?.path && assets.image.ready) {
        try {
            await fs.access(assets.image.path);
        } catch (err) {
            orphanAssets.push({
                type: 'missing_image_file',
                scene: { bookId, chapterId, sceneId },
                path: assets.image.path
            });
        }
    }

    if (assets.video?.path && assets.video.ready) {
        try {
            await fs.access(assets.video.path);
        } catch (err) {
            orphanAssets.push({
                type: 'missing_video_file',
                scene: { bookId, chapterId, sceneId },
                path: assets.video.path
            });
        }
    }

    return orphanAssets.length > 0 ? orphanAssets : null;
}

// ======================================================
// PARTIAL BUILD CHECKS
// ======================================================

/**
 * Check for partially built scenes.
 */
async function checkPartialBuilds(redis, bookId, chapterId, sceneId) {
    const sceneState = await state.getSceneState(redis, bookId, chapterId, sceneId);

    if (!sceneState) {
        return null;
    }

    const stateName = sceneState.state;
    const assets = await storage.registry.getSceneAssetsRedis(redis, bookId, chapterId, sceneId);

    // AUDIO_READY but no image asset
    if (stateName === state.SceneState.AUDIO_READY && !assets?.image) {
        return {
            type: 'partial_audio_only',
            scene: { bookId, chapterId, sceneId },
            currentStage: 'audio_ready',
            missingStage: 'image',
            recommendation: 'progress_to_image'
        };
    }

    // IMAGE_READY but no video asset
    if (stateName === state.SceneState.IMAGE_READY && !assets?.video) {
        return {
            type: 'partial_image_video_missing',
            scene: { bookId, chapterId, sceneId },
            currentStage: 'image_ready',
            missingStage: 'video',
            recommendation: 'progress_to_video'
        };
    }

    return null;
}

// ======================================================
// STALE LOCK CHECKS
// ======================================================

const LOCK_KEYS = [
    'animastor:audio-scene-lock',
    'animastor:video-lock',
    'animastor:audio-merge-lock',
    'animastor:scene-transition-lock'
];

/**
 * Check for stale locks (lock exists but no heartbeat).
 */
async function checkStaleLocks(redis, bookId, chapterId, sceneId) {
    const staleLocks = [];

    for (const lockPrefix of LOCK_KEYS) {
        const lockKey = `${lockPrefix}:${bookId}:${chapterId}:${sceneId}`;
        const lockData = await redis.get(lockKey);

        if (lockData) {
            // Check heartbeat
            const heartbeatKey = `animastor:scene-heartbeat:${bookId}:${chapterId}:${sceneId}`;
            const heartbeatTime = await redis.get(heartbeatKey);

            if (!heartbeatTime) {
                staleLocks.push({
                    type: 'lock_without_heartbeat',
                    lockKey,
                    scene: { bookId, chapterId, sceneId },
                    lockData: JSON.parse(lockData),
                    recommendation: 'release_lock'
                });
            } else {
                // Check if heartbeat is stale (> 5 minutes)
                const now = Date.now();
                const lastHeartbeat = parseInt(heartbeatTime, 10);
                if (now - lastHeartbeat > 5 * 60 * 1000) {
                    staleLocks.push({
                        type: 'stale_heartbeat',
                        lockKey,
                        scene: { bookId, chapterId, sceneId },
                        lastHeartbeat,
                        recommendation: 'clear_heartbeat'
                    });
                }
            }
        }
    }

    return staleLocks.length > 0 ? staleLocks : null;
}

// ======================================================
// DISPATCH LEASE CHECKS
// ======================================================

const dispatchEngine = require('./dispatch-engine');

/**
 * Check for stale dispatch leases.
 */
async function checkStaleDispatchLeases(redis, bookId, chapterId, sceneId) {
    const staleLeases = [];

    // Check all stages for lease existence
    const stages = ['audio', 'image', 'video'];
    const now = Date.now();

    for (const stage of stages) {
        const leaseKey = dispatchEngine.getLeaseKey(bookId, chapterId, sceneId, stage);
        const token = await redis.get(leaseKey);

        if (token) {
            // Check dispatch metadata for age
            const metaKey = dispatchEngine.getDispatchMetaKey(bookId, chapterId, sceneId, stage);
            const metadata = await redis.get(metaKey);

            if (metadata) {
                const data = JSON.parse(metadata);
                const ageSeconds = (now - data.started_at) / 1000;
                const ttl = dispatchEngine.LEASE_TTLS[stage];
                const threshold = ttl * 0.9; // 90% of TTL

                if (ageSeconds > threshold) {
                    staleLeases.push({
                        type: 'stale_dispatch_lease',
                        stage,
                        leaseKey,
                        scene: { bookId, chapterId, sceneId },
                        ageSeconds,
                        threshold: threshold,
                        token,
                        recommendation: 'release_lease_and_move_to_pending'
                    });
                }
            } else {
                // Lease exists but no metadata - might be orphaned
                staleLeases.push({
                    type: 'orphan_dispatch_lease',
                    stage,
                    leaseKey,
                    scene: { bookId, chapterId, sceneId },
                    token,
                    recommendation: 'release_lease_and_move_to_pending'
                });
            }
        }
    }

    return staleLeases.length > 0 ? staleLeases : null;
}

// ======================================================
// SCENE RECONCILIATION
// ======================================================

/**
 * Reconcile a single scene.
 */
async function reconcileScene(redis, bookId, chapterId, sceneId) {
    const report = new ReconciliationReport();

    try {
        // Check orphan states
        const orphanVideo = await checkOrphanVideoState(redis, bookId, chapterId, sceneId);
        if (orphanVideo) {
            report.orphanStates.push(orphanVideo);
            report.inconsistentScenes.push({
                scene: { bookId, chapterId, sceneId },
                issue: orphanVideo.type
            });
        }

        const orphanImage = await checkOrphanImageState(redis, bookId, chapterId, sceneId);
        if (orphanImage) {
            report.orphanStates.push(orphanImage);
            if (!report.inconsistentScenes.find(s => s.scene.sceneId === sceneId)) {
                report.inconsistentScenes.push({
                    scene: { bookId, chapterId, sceneId },
                    issue: orphanImage.type
                });
            }
        }

        const orphanAudio = await checkOrphanAudioState(redis, bookId, chapterId, sceneId);
        if (orphanAudio) {
            report.orphanStates.push(orphanAudio);
            if (!report.inconsistentScenes.find(s => s.scene.sceneId === sceneId)) {
                report.inconsistentScenes.push({
                    scene: { bookId, chapterId, sceneId },
                    issue: orphanAudio.type
                });
            }
        }

        // Check orphan assets
        const orphanAssets = await checkOrphanAssets(redis, bookId, chapterId, sceneId);
        if (orphanAssets) {
            report.orphanAssets.push(...orphanAssets);
            if (!report.inconsistentScenes.find(s => s.scene.sceneId === sceneId)) {
                report.inconsistentScenes.push({
                    scene: { bookId, chapterId, sceneId },
                    issue: 'orphan_assets'
                });
            }
        }

        // Check partial builds
        const partial = await checkPartialBuilds(redis, bookId, chapterId, sceneId);
        if (partial) {
            report.partialBuilds.push(partial);
            if (!report.inconsistentScenes.find(s => s.scene.sceneId === sceneId)) {
                report.inconsistentScenes.push({
                    scene: { bookId, chapterId, sceneId },
                    issue: partial.type
                });
            }
        }

        // Check stale locks
        const staleLocks = await checkStaleLocks(redis, bookId, chapterId, sceneId);
        if (staleLocks) {
            report.staleLocks.push(...staleLocks);
            if (!report.inconsistentScenes.find(s => s.scene.sceneId === sceneId)) {
                report.inconsistentScenes.push({
                    scene: { bookId, chapterId, sceneId },
                    issue: 'stale_locks'
                });
            }
        }

        // Check counter reconciliation (drift between leases and counters)
        const driftCheck = await counterReconciliation.getCounterWithDriftCheck(redis, 'audio');
        if (driftCheck && !driftCheck.correct) {
            const counterDriftIssue = {
                scene: { bookId, chapterId, sceneId },
                stage: 'audio',
                drift: driftCheck.drift,
                leaseCount: driftCheck.leaseCount,
                counterValue: driftCheck.counterValue,
                issue: 'counter_drift'
            };
            report.inconsistentScenes.push(counterDriftIssue);
        }

        // Check stale dispatch leases
        const staleLeases = await checkStaleDispatchLeases(redis, bookId, chapterId, sceneId);
        if (staleLeases) {
            report.staleLocks.push(...staleLeases);
            for (const lease of staleLeases) {
                if (!report.inconsistentScenes.find(s => s.scene.sceneId === sceneId && s.issue === 'stale_dispatch_lease')) {
                    report.inconsistentScenes.push({
                        scene: { bookId, chapterId, sceneId },
                        issue: 'stale_dispatch_lease'
                    });
                }
            }
        }

        return report;
    } catch (err) {
        error(`Reconciliation error for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
        return report;
    }
}

// ======================================================
// RECOMMENDATIONS & AUTO-FIXES
// ======================================================

/**
 * Get recommendations for fixing inconsistencies.
 */
function getFixRecommendations(inconsistentScenes) {
    return inconsistentScenes.map(item => {
        const { scene, issue } = item;

        switch (issue) {
            case 'orphan_video_state':
                return {
                    scene,
                    action: 'REGENERATE_MISSING_ASSET',
                    reason: 'VIDEO_READY but no video file',
                    safeToExecute: true
                };
            case 'orphan_image_state':
                return {
                    scene,
                    action: 'REGENERATE_MISSING_ASSET',
                    reason: 'IMAGE_READY but no image file',
                    safeToExecute: true
                };
            case 'orphan_audio_state':
                return {
                    scene,
                    action: 'REGENERATE_MISSING_ASSET',
                    reason: 'AUDIO_READY but no audio file',
                    safeToExecute: true
                };
            case 'partial_audio_only':
                return {
                    scene,
                    action: 'PROGRESS_TO_IMAGE',
                    reason: 'Audio ready but image not started',
                    safeToExecute: true
                };
            case 'partial_image_video_missing':
                return {
                    scene,
                    action: 'PROGRESS_TO_VIDEO',
                    reason: 'Image ready but video not started',
                    safeToExecute: true
                };
            case 'stale_locks':
                return {
                    scene,
                    action: 'RELEASE_STALE_LOCKS',
                    reason: 'Locks exist without heartbeat',
                    safeToExecute: true
                };
            case 'orphan_assets':
                return {
                    scene,
                    action: 'RECOVER_ORPHAN_ASSETS',
                    reason: 'Registry has assets but files are missing',
                    safeToExecute: true
                };
            case 'stuck_state':
                return {
                    scene,
                    action: 'MOVE_TO_PENDING',
                    reason: `Stuck in ${item.state} for ${item.ageMinutes} minutes`,
                    safeToExecute: true
                };
            case 'counter_drift':
                return {
                    scene,
                    action: 'RECONCILE_COUNTER_DRIFT',
                    reason: `Counter drift: ${item.drift} (leases=${item.leaseCount}, counter=${item.counterValue})`,
                    safeToExecute: true
                };
            case 'stale_dispatch_lease':
                return {
                    scene,
                    action: 'RELEASE_STALE_LEASE',
                    reason: `Stale dispatch lease detected`,
                    safeToExecute: true
                };
            default:
                return {
                    scene,
                    action: 'REVIEW_MANUALLY',
                    reason: issue,
                    safeToExecute: false
                };
        }
    });
}

/**
 * Apply a fix recommendation.
 * Returns { success: boolean, action, scene, details }
 */
async function applyFix(redis, fix) {
    const { scene, action } = fix;

    try {
        switch (action) {
            case 'MOVE_TO_PENDING': {
                const current = await state.getSceneState(redis, scene.bookId, scene.chapterId, scene.sceneId);

                // Derive pending state from current linear state (heuristic)
                const s = current?.state || '';
                const pendingState = s.includes('audio') ? state.SceneState.AUDIO_PENDING
                    : s.includes('image') ? state.SceneState.IMAGE_PENDING
                    : s.includes('video') ? state.SceneState.VIDEO_PENDING
                    : state.SceneState.AUDIO_PENDING;

                await state.transitionSceneState(redis, scene.bookId, scene.chapterId, scene.sceneId, pendingState);

                // Mark all per-asset states as DIRTY for redispatch
                // M5: Route through orchestrator.markDirtyScene instead of direct state.setAssetState
                const orchestrator = require('../orchestration/orchestrator');
                await orchestrator.markDirtyScene(redis, scene.bookId, scene.chapterId, scene.sceneId);

                // Remove from active index to avoid immediate re-scheduling
                await runtimeScheduler.removeSceneFromActiveIndex(redis, scene.bookId, scene.chapterId, scene.sceneId);

                // Log to journal
                await journal.appendSceneEvent(redis, scene.bookId, scene.chapterId, scene.sceneId,
                    'AUTO_RECOVER', pendingState,
                    { fromState: current?.state, recoveredBy: 'reconciliation-engine' }
                );

                return { success: true, action, scene, details: `moved to ${pendingState} + assets DIRTY` };
            }

            case 'RELEASE_STALE_LOCKS': {
                let removedCount = 0;
                for (const lockPrefix of LOCK_KEYS) {
                    const lockKey = `${lockPrefix}:${scene.bookId}:${scene.chapterId}:${scene.sceneId}`;
                    const removed = await redis.del(lockKey);
                    removedCount += removed;
                }

                return { success: removedCount > 0, action, scene, details: `removed ${removedCount} locks` };
            }

            case 'RELEASE_STALE_LEASE': {
                const dispatchEngine = require('./dispatch-engine');
                let removedCount = 0;

                // Release all dispatch leases for this scene
                for (const stage of ['audio', 'image', 'video']) {
                    const leaseKey = dispatchEngine.getLeaseKey(scene.bookId, scene.chapterId, scene.sceneId, stage);
                    const token = await redis.get(leaseKey);

                    if (token) {
                        await redis.del(leaseKey);
                        removedCount++;

                        // Release quota if leaked
                        const counterKey = dispatchEngine.getActiveCounterKey(stage);
                        await redis.decr(counterKey);
                    }

                    // Delete dispatch metadata
                    const metaKey = dispatchEngine.getDispatchMetaKey(scene.bookId, scene.chapterId, scene.sceneId, stage);
                    await redis.del(metaKey);
                }

                // Move to pending state
                const current = await state.getSceneState(redis, scene.bookId, scene.chapterId, scene.sceneId);
                if (current) {
                    const s = current.state || '';
                    const pendingState = s.includes('audio') ? state.SceneState.AUDIO_PENDING
                        : s.includes('image') ? state.SceneState.IMAGE_PENDING
                        : s.includes('video') ? state.SceneState.VIDEO_PENDING
                        : state.SceneState.AUDIO_PENDING;

                    await state.transitionSceneState(redis, scene.bookId, scene.chapterId, scene.sceneId, pendingState);

                    // Mark per-asset states as DIRTY for redispatch
                    // M5: Route through orchestrator.markDirtyScene instead of direct state.setAssetState
                    const orchestrator = require('../orchestration/orchestrator');
                    await orchestrator.markDirtyScene(redis, scene.bookId, scene.chapterId, scene.sceneId);

                    // Add back to active index
                    await runtimeScheduler.addSceneToActiveIndex(redis, scene.bookId, scene.chapterId, scene.sceneId);
                }

                return { success: removedCount > 0, action, scene, details: `released ${removedCount} stale leases` };
            }

            case 'REGENERATE_MISSING_ASSET': {
                // Mark as pending for regeneration
                const current = await state.getSceneState(redis, scene.bookId, scene.chapterId, scene.sceneId);

                // Derive asset type from action reason or issue field
                const reasons = (fix.reason + ' ' + (fix.issue || '')).toLowerCase();
                const pendingState =
                    reasons.includes('audio') || reasons.includes('tts')
                        ? state.SceneState.AUDIO_PENDING
                        : reasons.includes('video')
                        ? state.SceneState.VIDEO_PENDING
                        : reasons.includes('image') || reasons.includes('iu')
                        ? state.SceneState.IMAGE_PENDING
                        : null;

                if (!pendingState) {
                    return { success: false, action, scene, details: `unknown asset type (reason: ${fix.reason})` };
                }

                await state.transitionSceneState(
                    redis,
                    scene.bookId,
                    scene.chapterId,
                    scene.sceneId,
                    pendingState
                );

                await runtimeScheduler.addSceneToActiveIndex(
                    redis,
                    scene.bookId,
                    scene.chapterId,
                    scene.sceneId
                );

                return { success: true, action, scene, details: `marked as ${pendingState}` };
            }

            case 'PROGRESS_TO_IMAGE': {
                await state.transitionSceneState(
                    redis,
                    scene.bookId,
                    scene.chapterId,
                    scene.sceneId,
                    state.SceneState.IMAGE_PENDING
                );

                await runtimeScheduler.addSceneToActiveIndex(
                    redis,
                    scene.bookId,
                    scene.chapterId,
                    scene.sceneId
                );

                return { success: true, action, scene, details: 'progressed to IMAGE_PENDING' };
            }

            case 'RECONCILE_COUNTER_DRIFT': {
                // Get the current lease count and fix counter
                const stage = scene.stage || 'audio';
                const leaseCount = await counterReconciliation.countActiveLeasesByStage(redis, stage);
                
                await counterReconciliation.correctCounterWithLua(redis, stage, leaseCount);
                
                return { success: true, action, scene, details: `counter corrected to ${leaseCount}` };
            }

            case 'PROGRESS_TO_VIDEO': {
                await state.transitionSceneState(
                    redis,
                    scene.bookId,
                    scene.chapterId,
                    scene.sceneId,
                    state.SceneState.VIDEO_PENDING
                );

                await runtimeScheduler.addSceneToActiveIndex(
                    redis,
                    scene.bookId,
                    scene.chapterId,
                    scene.sceneId
                );

                return { success: true, action, scene, details: 'progressed to VIDEO_PENDING' };
            }

            case 'RECOVER_ORPHAN_ASSETS': {
                // Clear registry entries for missing assets
                const assets = await storage.registry.getSceneAssetsRedis(redis, scene.bookId, scene.chapterId, scene.sceneId);
                if (assets) {
                    if (assets.audio && assets.audio.canonical) {
                        await storage.registry.registerSceneAudioRedis(redis, scene.bookId, scene.chapterId, scene.sceneId, {
                            canonicalPath: assets.audio.canonical,
                            ready: false
                        });
                    }
                    if (assets.image && assets.image.path) {
                        await storage.registry.registerSceneImageRedis(redis, scene.bookId, scene.chapterId, scene.sceneId, {
                            path: assets.image.path,
                            ready: false
                        });
                    }
                    if (assets.video && assets.video.path) {
                        await storage.registry.registerSceneVideoRedis(redis, scene.bookId, scene.chapterId, scene.sceneId, {
                            path: assets.video.path,
                            ready: false
                        });
                    }
                }

                // Mark scene as pending for regeneration
                await state.transitionSceneState(
                    redis,
                    scene.bookId,
                    scene.chapterId,
                    scene.sceneId,
                    state.SceneState.AUDIO_PENDING
                );

                return { success: true, action, scene, details: 'registry marked for recovery' };
            }

            default:
                return { success: false, action, scene, details: 'unknown_action' };
        }
    } catch (err) {
        error(`Fix execution error for ${scene.bookId}/${scene.chapterId}/${scene.sceneId}: ${err.message}`);
        return { success: false, action, scene, details: err.message };
    }
}

// ======================================================
// BULK RECONCILIATION
// ======================================================

/**
 * Reconcile all scenes for a specific book.
 */
async function reconcileBook(redis, bookId) {
    log(`Starting book reconciliation: ${bookId}`);

    const report = new ReconciliationReport();
    let scanned = 0;

    // Scan event journals for scenes
    const journalPattern = `animastor:event-journal:${bookId}:*`;
    let cursor = 0;

    do {
        const result = await redis.scan(cursor, 'MATCH', journalPattern, 'COUNT', 200);
        cursor = parseInt(result[0], 10);
        const keys = result[1];

        for (const key of keys) {
            const parts = key.split(':');
            if (parts.length >= 4) {
                const chapterId = parts[3];
                const sceneId = parts[4];

                const sceneReport = await reconcileScene(redis, bookId, chapterId, sceneId);

                report.orphanStates.push(...sceneReport.orphanStates);
                report.orphanAssets.push(...sceneReport.orphanAssets);
                report.partialBuilds.push(...sceneReport.partialBuilds);
                report.staleLocks.push(...sceneReport.staleLocks);
                report.inconsistentScenes.push(...sceneReport.inconsistentScenes);

                scanned++;
            }
        }
    } while (cursor !== 0);

    log(`Reconciliation complete: ${scanned} scenes scanned, ${report.inconsistentScenes.length} inconsistencies found`);

    return report;
}

/**
 * Reconcile all scenes across all books.
 */
async function reconcileAll(redis) {
    log('Starting full system reconciliation');

    const report = new ReconciliationReport();
    let scanned = 0;

    // Find all scenes via event journal
    const journalPattern = 'animastor:event-journal:*';
    let cursor = 0;

    do {
        const result = await redis.scan(cursor, 'MATCH', journalPattern, 'COUNT', 500);
        cursor = parseInt(result[0], 10);
        const keys = result[1];

        for (const key of keys) {
            const parts = key.split(':');
            if (parts.length >= 4) {
                const bookId = parts[2];
                const chapterId = parts[3];
                const sceneId = parts[4];

                const sceneReport = await reconcileScene(redis, bookId, chapterId, sceneId);

                report.orphanStates.push(...sceneReport.orphanStates);
                report.orphanAssets.push(...sceneReport.orphanAssets);
                report.partialBuilds.push(...sceneReport.partialBuilds);
                report.staleLocks.push(...sceneReport.staleLocks);
                report.inconsistentScenes.push(...sceneReport.inconsistentScenes);

                scanned++;
            }
        }
    } while (cursor !== 0);

    log(`Full reconciliation complete: ${scanned} scenes scanned, ${report.inconsistentScenes.length} inconsistencies found`);

    return report;
}

/**
 * Get current metrics from reconciliation engine.
 */
async function getMetrics(redis) {
    return {
        activeChecks: 'all_scenes_via_journal_scan'
    };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    reconcileScene,
    reconcileBook,
    reconcileAll,
    checkOrphanVideoState,
    checkOrphanImageState,
    checkOrphanAudioState,
    checkOrphanAssets,
    checkPartialBuilds,
    checkStaleLocks,

    getFixRecommendations,
    applyFix,
    getMetrics,
    ReconciliationReport
};
