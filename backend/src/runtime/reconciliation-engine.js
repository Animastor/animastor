// ======================================================
// Reconciliation Engine - v1.0.0
// ======================================================
// Self-healing engine that detects and fixes inconsistencies
// between state machine and actual assets on disk/registry.
//
// T6: Единый reconciliation-контур (R4/К4). Включает:
//   — startup-recovery (version staleness, audio-orch, chunk recovery)
//   — audio-recovery (scan animastor:result:* keys)
//   — cleanup-service (expired audio scene locks)
//   — reconciliation-engine (orphan states, stale leases, drift)
// Все фазы — через единый цикл reconcileCycle() с распределённым локом.

const fs = require('fs').promises;
const syncFs = require('fs');
const syncPath = require('path');

const state = require('../state');
const storage = require('../storage');
const config = require('../config/runtime-config');
const journal = require('../orchestration/event-journal');
const runtimeScheduler = require('./runtime-scheduler');
const counterReconciliation = require('./counter-reconciliation');
const dispatchEngine = require('./dispatch-engine');

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
 * T8: использует per-asset state (video=ready) вместо линейного.
 */
async function checkOrphanVideoState(redis, bookId, chapterId, sceneId) {
    const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const isVideoReady = assetStates && assetStates.video &&
        (assetStates.video === state.AssetState.READY || assetStates.video === state.AssetState.PLACEHOLDER);

    if (!isVideoReady) {
        return null;
    }

    const buildId = 'default';
    const videoPath = `/data/output/${buildId}/${bookId}_${chapterId}_${sceneId}.mp4`;

    try {
        await fs.access(videoPath);
        return null; // File exists, state is valid
    } catch (err) {
        return {
            type: 'orphan_video_state',
            scene: { bookId, chapterId, sceneId },
            state: 'video_ready',
            missingFile: videoPath,
            recommendation: 'regenerate_video'
        };
    }
}

/**
 * Check for IMAGE_READY state but no image file.
 * T8: использует per-asset state (image=ready) вместо линейного.
 */
async function checkOrphanImageState(redis, bookId, chapterId, sceneId) {
    const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const isImageReady = assetStates && assetStates.image &&
        (assetStates.image === state.AssetState.READY || assetStates.image === state.AssetState.PLACEHOLDER);

    if (!isImageReady) {
        return null;
    }

    // Note: build_id is read from manifest, not from scene-state (which no longer exists after T8).
    // Default is used here as the orphan-check is advisory/diagnostic only.
    const buildId = 'default';
    const imageModule = require('../image');
    const imageInfo = imageModule.resolveCanonicalSceneImage(
        '/data/output',
        buildId,
        bookId,
        chapterId,
        sceneId,
    );

    if (!imageInfo) {
        return {
            type: 'orphan_image_state',
            scene: { bookId, chapterId, sceneId },
            state: 'image_ready',
            missingFile: 'image_not_found',
            recommendation: 'regenerate_image'
        };
    }

    return null;
}

/**
 * Check for AUDIO_READY state but no audio file.
 * T8: использует per-asset state (audio=ready) вместо линейного.
 */
async function checkOrphanAudioState(redis, bookId, chapterId, sceneId) {
    const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const isAudioReady = assetStates && assetStates.audio &&
        (assetStates.audio === state.AssetState.READY || assetStates.audio === state.AssetState.PLACEHOLDER);

    if (!isAudioReady) {
        return null;
    }

    // Get build_id from scene state (stale is OK for read-only diagnostic)
    const buildId = 'default';

    const audioPath = storage.filesystem.getSceneAudioPath(
        config.OUTPUT_DIR,
        buildId,
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
            state: 'audio_ready',
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
 * T8: использует per-asset state вместо линейного.
 */
async function checkPartialBuilds(redis, bookId, chapterId, sceneId) {
    const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const assets = await storage.registry.getSceneAssetsRedis(redis, bookId, chapterId, sceneId);

    // Audio READY/PLACEHOLDER but no image asset
    const audioReady = assetStates && assetStates.audio &&
        (assetStates.audio === state.AssetState.READY || assetStates.audio === state.AssetState.PLACEHOLDER);
    if (audioReady && !assets?.image) {
        return {
            type: 'partial_audio_only',
            scene: { bookId, chapterId, sceneId },
            currentStage: 'audio_ready',
            missingStage: 'image',
            recommendation: 'progress_to_image'
        };
    }

    // Image READY but no video asset
    const imageReady = assetStates && assetStates.image &&
        (assetStates.image === state.AssetState.READY || assetStates.image === state.AssetState.PLACEHOLDER);
    if (imageReady && !assets?.video) {
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
// B1: STALLED AUDIO CHUNKS WATCHDOG
// ======================================================
// Сканирует audio-orch state машины в фазе WAITING_CHUNKS.
// Если last_chunk_at + AUDIO_CHUNK_STALL_MS < Date.now() —
// сцена зависла: вызываем failWaitingScene(), которая чистит
// hub-dedup, сбрасывает metadata и публикует failStage.
//
// Важно: watchdog НЕ конкурирует с gpu-hub timeout — они ловят
// разные сценарии (стоп прогресса vs мёртвый воркер).

async function checkStalledAudioScenes(redis, deps) {
    let audioOrch;
    try {
        audioOrch = require('../services/audio-orchestrator');
    } catch (_) {
        return 0;
    }

    const { AUDIO_CHUNK_STALL_MS } = config.TIMEOUTS;
    const allStates = await audioOrch.scanAllStates(redis);
    if (allStates.length === 0) return 0;

    let stalled = 0;
    for (const entry of allStates) {
        const { bookId, chapterId, sceneId, state: orchState } = entry;
        if (orchState.phase !== audioOrch.PHASES.WAITING_CHUNKS) continue;

        const buildId = orchState.build_id || 'default';

        // ── LAST_CHUNK_AT || STARTED_AT ──
        // Если completeChunk ни разу не был вызван (HTTP 500 на всех чанках),
        // last_chunk_at = null, но started_at есть. Используем started_at как
        // точку отсчёта застоя. Если и started_at нет — проверяем чанки на диске.
        const lastChunkAt = orchState.last_chunk_at;
        const startedAt = orchState.started_at;
        const threshold = lastChunkAt || startedAt;

        if (threshold) {
            const age = Date.now() - threshold;
            if (age < AUDIO_CHUNK_STALL_MS) continue;

            const reason = `chunk_stall_timeout:${Math.round(age / 1000)}s`;
            warn(`[STALLED-AUDIO] ${bookId}/${chapterId}/${sceneId} — ${reason} (last_chunk_at=${!!lastChunkAt} started_at=${!!startedAt})`);

            try {
                await audioOrch.failWaitingScene(redis, bookId, chapterId, sceneId, buildId, reason, {
                    orchestrator: deps.orchestrator
                });
                stalled++;
            } catch (err) {
                warn(`[STALLED-AUDIO] failWaitingScene error: ${err.message}`);
            }
        } else {
            // ── НЕТ НИ LAST_CHUNK_AT, НИ STARTED_AT ──
            // Проверяем чанки на диске. Если все на месте — доигрываем merge.
            // Если ни одного чанка нет — это fresh state без dispatch, не трогаем.
            const expectedCount = parseInt(orchState.expected_count || '1', 10);
            const pad = (n) => String(n).padStart(4, '0');
            const OUTPUT_DIR = config.OUTPUT_DIR;
            const buildDir = syncPath.join(OUTPUT_DIR, buildId);
            let presentCount = 0;
            for (let i = 1; i <= expectedCount; i++) {
                const chunkPath = syncPath.join(buildDir, `${bookId}_${chapterId}_${sceneId}_${pad(i)}.mp3`);
                if (syncFs.existsSync(chunkPath)) presentCount++;
            }

            if (presentCount === expectedCount) {
                log(`[STALLED-AUDIO] ${bookId}/${chapterId}/${sceneId} — ALL ${presentCount} chunks on disk, no last_chunk_at. Calling completeChunk to trigger merge.`);
                try {
                    await audioOrch.completeChunk(redis, bookId, chapterId, sceneId, 'recovery', buildId, {
                        audio: deps.audio || require('../audio'),
                        orchestrator: deps.orchestrator,
                        dispatchId: 'recovery-reconcile',
                    });
                    stalled++;
                } catch (err) {
                    warn(`[STALLED-AUDIO] completeChunk recovery failed: ${err.message}`);
                    try {
                        await audioOrch.failWaitingScene(redis, bookId, chapterId, sceneId, buildId,
                            `recovery_fallback:${err.message}`, { orchestrator: deps.orchestrator });
                        stalled++;
                    } catch (fsErr) {
                        warn(`[STALLED-AUDIO] failWaitingScene fallback failed: ${fsErr.message}`);
                    }
                }
            } else if (presentCount > 0) {
                warn(`[STALLED-AUDIO] ${bookId}/${chapterId}/${sceneId} — ${presentCount}/${expectedCount} on disk, no last_chunk_at. Partial chunks, failing scene.`);
                try {
                    await audioOrch.failWaitingScene(redis, bookId, chapterId, sceneId, buildId,
                        `partial_chunks:${presentCount}/${expectedCount}_no_timestamps`, { orchestrator: deps.orchestrator });
                    stalled++;
                } catch (err) {
                    warn(`[STALLED-AUDIO] failWaitingScene failed: ${err.message}`);
                }
            }
            // Если presentCount === 0 — это fresh state, ничего не делаем
        }
    }

    if (stalled > 0) log(`[STALLED-AUDIO] ${stalled} stalled audio scenes recovered`);
    return stalled;
}

// ======================================================
// B2: STALLED VIDEO GROUPS WATCHDOG
// ======================================================
// Сканирует video-orch state машины в фазе WAITING_CHUNKS.
// Если last_group_at/started_at + VIDEO_CHUNK_STALL_MS < Date.now() —
// сцена зависла: вызываем failWaitingScene(), которая чистит hub-dedup
// недостающих групп и публикует failStage (→ re-dispatch).

async function checkStalledVideoScenes(redis, deps) {
    let videoOrch;
    try {
        videoOrch = require('../services/video-orchestrator');
    } catch (_) {
        return 0;
    }

    const { VIDEO_CHUNK_STALL_MS } = config.TIMEOUTS;
    const allStates = await videoOrch.scanAllStates(redis);
    if (allStates.length === 0) return 0;

    let stalled = 0;
    for (const entry of allStates) {
        const { bookId, chapterId, sceneId, state: orchState } = entry;
        if (orchState.phase !== videoOrch.PHASES.WAITING_CHUNKS) continue;

        // ── ПЕРЕСМОТР ПОРОГА ЗАСТОЯ ──
        // Видео-генерация долгая по природе (LTX 5-10 мин на группу, на слабом
        // GPU — 20-30+ мин). Жёсткий константный порог мог бы убить нормальную
        // долгую генерацию. Порог застоя СТРОГО БОЛЬШЕ per-job timeout из
        // layer-config (video_timeout_minutes): hub затаймливает воркера раньше,
        // watchdog срабатывает только если hub/worker НЕ объявили ни результат,
        // ни ошибку за весь интервал.
        let stallThreshold = VIDEO_CHUNK_STALL_MS;
        try {
            const layerRaw = await redis.get(`animastor:layer-config:${bookId}`);
            if (layerRaw) {
                const lc = JSON.parse(layerRaw);
                const perJobMs = (Number(lc.video_timeout_minutes) || 60) * 60 * 1000;
                stallThreshold = Math.max(stallThreshold, perJobMs + 5 * 60 * 1000);
            }
        } catch (_) {}

        const buildId = orchState.build_id || 'default';
        const lastGroupAt = orchState.last_group_at;
        const startedAt = orchState.started_at;
        const threshold = lastGroupAt || startedAt;

        if (threshold) {
            const age = Date.now() - threshold;
            if (age < stallThreshold) continue;

            const reason = `video_group_stall_timeout:${Math.round(age / 1000)}s`;
            warn(`[STALLED-VIDEO] ${bookId}/${chapterId}/${sceneId} — ${reason} (threshold=${Math.round(stallThreshold / 60000)}min, last_group_at=${!!lastGroupAt} started_at=${!!startedAt})`);
            try {
                await videoOrch.failWaitingScene(redis, bookId, chapterId, sceneId, buildId, reason, {
                    orchestrator: deps.orchestrator,
                });
                stalled++;
            } catch (err) {
                warn(`[STALLED-VIDEO] failWaitingScene error: ${err.message}`);
            }
        } else {
            // Нет ни last_group_at, ни started_at — свежий state без dispatch.
            // Если все группы на диске — доигрываем merge.
            const suffixes = videoOrch.groupSuffixes(orchState);
            const presentCount = suffixes.filter(s => videoOrch.isGroupFileValid(buildId, bookId, chapterId, sceneId, s)).length;
            if (presentCount === suffixes.length && suffixes.length > 0) {
                log(`[STALLED-VIDEO] ${bookId}/${chapterId}/${sceneId} — ALL ${presentCount} groups on disk, no last_group_at. Calling completeGroup to trigger merge.`);
                try {
                    await videoOrch.completeGroup(redis, bookId, chapterId, sceneId, '', buildId, {
                        orchestrator: deps.orchestrator,
                        dispatchId: 'recovery-reconcile',
                    });
                    stalled++;
                } catch (err) {
                    warn(`[STALLED-VIDEO] completeGroup recovery failed: ${err.message}`);
                    try {
                        await videoOrch.failWaitingScene(redis, bookId, chapterId, sceneId, buildId,
                            `recovery_fallback:${err.message}`, { orchestrator: deps.orchestrator });
                        stalled++;
                    } catch (fsErr) {
                        warn(`[STALLED-VIDEO] failWaitingScene fallback failed: ${fsErr.message}`);
                    }
                }
            } else if (presentCount > 0) {
                warn(`[STALLED-VIDEO] ${bookId}/${chapterId}/${sceneId} — ${presentCount}/${suffixes.length} on disk, no last_group_at. Partial groups, failing scene.`);
                try {
                    await videoOrch.failWaitingScene(redis, bookId, chapterId, sceneId, buildId,
                        `partial_groups:${presentCount}/${suffixes.length}_no_timestamps`, { orchestrator: deps.orchestrator });
                    stalled++;
                } catch (err) {
                    warn(`[STALLED-VIDEO] failWaitingScene failed: ${err.message}`);
                }
            }
        }
    }

    if (stalled > 0) log(`[STALLED-VIDEO] ${stalled} stalled video scenes recovered`);
    return stalled;
}

// ======================================================
// T7.6: AUDIO-ORCH INVARIANT CHECKS
// ======================================================
// Проверяет соответствие между audio-orch phase и asset state:
//   phase=DONE     ⇔ asset.audio = READY
//   phase=FAILED   ⇒ asset.audio = FAILED (или PENDING — после re-dispatch)
//   промежуточные  ⇒ asset.audio ∈ {PENDING, GENERATING, DIRTY}

async function checkAudioOrchInvariants(redis, bookId, chapterId, sceneId) {
    const audioOrch = require('../services/audio-orchestrator');
    const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const orchState = await audioOrch.getState(redis, bookId, chapterId, sceneId);

    if (!orchState || !assetStates) return null;

    const phase = orchState.phase;
    const audioState = assetStates.audio;
    const violations = [];

    if (phase === audioOrch.PHASES.DONE) {
        if (audioState !== state.AssetState.READY && audioState !== state.AssetState.PLACEHOLDER) {
            violations.push({
                type: 'audio_orch_invariant_done',
                scene: { bookId, chapterId, sceneId },
                phase,
                audioState,
                expected: 'READY or PLACEHOLDER',
                recommendation: 'run_completeStage'
            });
        }
    } else if (phase === audioOrch.PHASES.FAILED) {
        if (audioState !== state.AssetState.FAILED && audioState !== state.AssetState.PENDING) {
            violations.push({
                type: 'audio_orch_invariant_failed',
                scene: { bookId, chapterId, sceneId },
                phase,
                audioState,
                expected: 'FAILED or PENDING',
                recommendation: 'mark_dirty'
            });
        }
    } else if (phase !== audioOrch.PHASES.NEW && phase !== audioOrch.PHASES.PLACEHOLDER_READY) {
        // Intermediate phases: GENERATING, WAITING_CHUNKS, MERGING
        if (audioState === state.AssetState.READY) {
            violations.push({
                type: 'audio_orch_invariant_intermediate',
                scene: { bookId, chapterId, sceneId },
                phase,
                audioState,
                expected: 'PENDING|GENERATING|DIRTY',
                recommendation: 'mark_dirty_or_set_done'
            });
        }
    }

    return violations.length > 0 ? violations : null;
}

// ======================================================
// VIDEO-ORCH INVARIANT CHECKS (зеркало checkAudioOrchInvariants)
// ======================================================
//   phase=DONE     ⇒ asset.video = READY (или PLACEHOLDER)
//   phase=FAILED   ⇒ asset.video = FAILED (или PENDING — после re-dispatch)
//   промежуточные  ⇒ asset.video = PENDING|GENERATING|DIRTY

async function checkVideoOrchInvariants(redis, bookId, chapterId, sceneId) {
    const videoOrch = require('../services/video-orchestrator');
    const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const orchState = await videoOrch.getState(redis, bookId, chapterId, sceneId);

    if (!orchState || !assetStates) return null;

    const phase = orchState.phase;
    const videoState = assetStates.video;
    const violations = [];

    if (phase === videoOrch.PHASES.DONE) {
        if (videoState !== state.AssetState.READY && videoState !== state.AssetState.PLACEHOLDER) {
            violations.push({
                type: 'video_orch_invariant_done',
                scene: { bookId, chapterId, sceneId },
                phase,
                videoState,
                expected: 'READY or PLACEHOLDER',
                recommendation: 'run_completeStage'
            });
        }
    } else if (phase === videoOrch.PHASES.FAILED) {
        if (videoState !== state.AssetState.FAILED && videoState !== state.AssetState.PENDING) {
            violations.push({
                type: 'video_orch_invariant_failed',
                scene: { bookId, chapterId, sceneId },
                phase,
                videoState,
                expected: 'FAILED or PENDING',
                recommendation: 'mark_dirty'
            });
        }
    } else if (phase !== videoOrch.PHASES.NEW && phase !== videoOrch.PHASES.GENERATING) {
        // WAITING_CHUNKS, MERGING — ассет не должен быть READY
        if (videoState === state.AssetState.READY) {
            violations.push({
                type: 'video_orch_invariant_intermediate',
                scene: { bookId, chapterId, sceneId },
                phase,
                videoState,
                expected: 'PENDING|GENERATING|DIRTY',
                recommendation: 'mark_dirty_or_set_done'
            });
        }
    }

    return violations.length > 0 ? violations : null;
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

        // T7.6: Check audio-orch invariants
        const audioOrchViolations = await checkAudioOrchInvariants(redis, bookId, chapterId, sceneId);
        if (audioOrchViolations) {
            for (const v of audioOrchViolations) {
                report.inconsistentScenes.push({
                    scene: v.scene,
                    issue: v.type
                });
            }
            log(`[INVARIANT] ${bookId}/${chapterId}/${sceneId}: ${audioOrchViolations.length} audio-orch violations`);
        }

        // Video-orch invariants (зеркало аудио)
        const videoOrchViolations = await checkVideoOrchInvariants(redis, bookId, chapterId, sceneId);
        if (videoOrchViolations) {
            for (const v of videoOrchViolations) {
                report.inconsistentScenes.push({
                    scene: v.scene,
                    issue: v.type
                });
            }
            log(`[INVARIANT] ${bookId}/${chapterId}/${sceneId}: ${videoOrchViolations.length} video-orch violations`);
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
                    stage: item.stage,
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
                // Mark all per-asset states as DIRTY for redispatch
                // M5: Route through orchestrator.markDirtyScene instead of direct state.setAssetState
                const orchestrator = require('../orchestration/orchestrator');
                await orchestrator.markDirtyScene(redis, scene.bookId, scene.chapterId, scene.sceneId);

                // Remove from active index to avoid immediate re-scheduling
                await runtimeScheduler.removeSceneFromActiveIndex(redis, scene.bookId, scene.chapterId, scene.sceneId);

                // Extract previous state from fix reason (format: "Stuck in <state> for <n> minutes")
                const fromState = fix.reason?.match(/Stuck in (\w+)/)?.[1] || 'unknown';

                // Log to journal
                await journal.appendSceneEvent(redis, scene.bookId, scene.chapterId, scene.sceneId,
                    'AUTO_RECOVER', 'DIRTY',
                    { fromState, recoveredBy: 'reconciliation-engine' }
                );

                return { success: true, action, scene, details: 'moved to DIRTY + assets DIRTY' };
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

                // Mark per-asset states as DIRTY for redispatch
                // M5: Route through orchestrator.markDirtyScene instead of direct state.setAssetState
                // M5 Шаг 3: syncLinearState уже внутри markDirtyScene
                const orchestrator = require('../orchestration/orchestrator');
                await orchestrator.markDirtyScene(redis, scene.bookId, scene.chapterId, scene.sceneId);

                // Add back to active index
                await runtimeScheduler.addSceneToActiveIndex(redis, scene.bookId, scene.chapterId, scene.sceneId);

                return { success: removedCount > 0, action, scene, details: `released ${removedCount} stale leases` };
            }

            case 'REGENERATE_MISSING_ASSET': {
                // Derive asset type from action reason or issue field
                const reasons = (fix.reason + ' ' + (fix.issue || '')).toLowerCase();
                const pendingState =
                    reasons.includes('audio') || reasons.includes('tts')
                        ? 'audio_pending'
                        : reasons.includes('video')
                        ? 'video_pending'
                        : reasons.includes('image') || reasons.includes('iu')
                        ? 'image_pending'
                        : null;

                if (!pendingState) {
                    return { success: false, action, scene, details: `unknown asset type (reason: ${fix.reason})` };
                }

                // M5 Шаг 4: Route through orchestrator.setScenePending (which includes syncLinearState)
                const orchestrator = require('../orchestration/orchestrator');
                const assetType = pendingState === 'audio_pending' ? 'audio'
                    : pendingState === 'image_pending' ? 'image'
                    : pendingState === 'video_pending' ? 'video'
                    : null;
                if (assetType) {
                    await orchestrator.setScenePending(redis, scene.bookId, scene.chapterId, scene.sceneId, assetType);
                }

                await runtimeScheduler.addSceneToActiveIndex(
                    redis,
                    scene.bookId,
                    scene.chapterId,
                    scene.sceneId
                );

                return { success: true, action, scene, details: `marked as ${pendingState}` };
            }

            case 'PROGRESS_TO_IMAGE': {
                // M5 Шаг 4: Route through orchestrator.setScenePending (includes syncLinearState)
                const orchestrator = require('../orchestration/orchestrator');
                await orchestrator.setScenePending(redis, scene.bookId, scene.chapterId, scene.sceneId, 'image');

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
                const stage = fix.stage || 'audio';
                const leaseCount = await counterReconciliation.countActiveLeasesByStage(redis, stage);

                await counterReconciliation.correctCounterWithLua(redis, stage, leaseCount);

                return { success: true, action, scene, details: `counter corrected to ${leaseCount}` };
            }

            case 'PROGRESS_TO_VIDEO': {
                // M5 Шаг 4: Route through orchestrator.setScenePending (includes syncLinearState)
                const orchestrator = require('../orchestration/orchestrator');
                await orchestrator.setScenePending(redis, scene.bookId, scene.chapterId, scene.sceneId, 'video');

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

                // M5 Шаг 4: Route through orchestrator.setScenePending (includes syncLinearState)
                const orchestrator = require('../orchestration/orchestrator');
                await orchestrator.setScenePending(redis, scene.bookId, scene.chapterId, scene.sceneId, 'audio');

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
            if (parts.length >= 5) {
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
            if (parts.length >= 5) {
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

    // Check counter drift once globally (leases vs counters are system-wide, not per-scene)
    for (const stage of ['audio', 'image', 'video']) {
        const driftCheck = await counterReconciliation.getCounterWithDriftCheck(redis, stage);
        if (driftCheck && !driftCheck.correct) {
            report.inconsistentScenes.push({
                scene: { bookId: '*', chapterId: '*', sceneId: '*' },
                stage,
                drift: driftCheck.drift,
                leaseCount: driftCheck.leaseCount,
                counterValue: driftCheck.counterValue,
                issue: 'counter_drift'
            });
        }
    }

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
// T6: ЕДИНЫЙ RECONCILIATION-ЦИКЛ
// ======================================================
// Заменяет 4 несогласованных механизма восстановления:
//   startup-recovery, audio-recovery, cleanup-service, reconcileAll
//
// Фазы:
//   A. Result/error key recovery (из audio-recovery.cjs)
//   B. Cleanup expired locks (из cleanup-service.cjs)
//   C. Startup-specific (из startup-recovery.js) — только при startup:true
//   D. Full scene reconciliation (из reconciliation-engine)
//
// Каждый прогон пишет RECOVERY_STARTED/RECOVERY_COMPLETED в event-journal.
// Один распределённый CLEANUP_LOCK на цикл — прогоны не пересекаются.

/**
 * Единый reconciliation-цикл. Выполняет все фазы восстановления.
 *
 * @param {Object} redis
 * @param {Object} deps — зависимости { state, config, postgres, orchestrator, taskHandler, ... }
 * @param {Object} [options]
 * @param {boolean} [options.startup=false] — первый прогон при старте (доп. шаги C)
 * @param {string} [options.scope] — если указан, обработать только одну книгу/сцену
 *   Формат: "bookId" (книга), "bookId:chapterId:sceneId" (одна сцена)
 * @returns {Promise<{ok:boolean, phases:string[], summary:object}>}
 */
async function reconcileCycle(redis, deps = {}, options = {}) {
    const { startup = false, scope = null } = options;
    const startTime = Date.now();
    const phases = [];
    const summary = { totalScanned: 0, itemsRecovered: 0, staleLocks: 0, errors: [] };

    // ── Acquire distributed CLEANUP_LOCK ──
    const lockKey = config.REDIS.CLEANUP_LOCK || 'animastor:cleanup-lock';
    const lockToken = `reconcile-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const lockAcquired = await redis.set(lockKey, lockToken, 'NX', 'EX', 120);
    if (!lockAcquired) {
        log('Cycle skipped — CLEANUP_LOCK held by another instance');
        return { ok: false, reason: 'lock_held', phases: ['lock_skipped'], summary };
    }

    const releaseLock = async () => {
        try {
            const current = await redis.get(lockKey);
            if (current === lockToken) await redis.del(lockKey);
        } catch (_) {}
    };

    try {
        // ── Journal: RECOVERY_STARTED ──
        try {
            await journal.appendSceneEvent(redis, '_system', '_recovery', '_cycle',
                journal.EventType.RECOVERY_STARTED, 'INITIATED',
                { startup, scope, phases: [] }
            );
        } catch (_) {}

        // ══════════════════════════════════════════════
        // PHASE A: Result/error key recovery (audio-recovery)
        // ══════════════════════════════════════════════
        if (deps.taskHandler) {
            try {
                const aCount = await recoverResultKeys(redis, deps, scope);
                summary.itemsRecovered += aCount;
                phases.push(`result_recovery:${aCount}`);
            } catch (err) {
                warn(`Phase A failed: ${err.message}`);
                summary.errors.push(`result_recovery: ${err.message}`);
            }
        }

        // ══════════════════════════════════════════════
        // PHASE B1: Stalled audio chunks watchdog
        // ══════════════════════════════════════════════
        try {
            const b1Count = await checkStalledAudioScenes(redis, deps);
            if (b1Count > 0) phases.push(`stalled_audio:${b1Count}`);
        } catch (err) {
            warn(`Phase B1 failed: ${err.message}`);
            summary.errors.push(`stalled_audio: ${err.message}`);
        }

        // ══════════════════════════════════════════════
        // PHASE B2: Stalled video groups watchdog
        // ══════════════════════════════════════════════
        try {
            const b2Count = await checkStalledVideoScenes(redis, deps);
            if (b2Count > 0) phases.push(`stalled_video:${b2Count}`);
        } catch (err) {
            warn(`Phase B2 failed: ${err.message}`);
            summary.errors.push(`stalled_video: ${err.message}`);
        }

        // ══════════════════════════════════════════════
        // PHASE C: Startup-specific (startup-recovery)
        // ══════════════════════════════════════════════
        if (startup) {
            // C0: Recover Redis chunks from disk
            if (typeof deps.recoverAllBooksFromDisk === 'function') {
                try {
                    await deps.recoverAllBooksFromDisk();
                    phases.push('chunk_recovery:ok');
                } catch (err) {
                    warn(`Phase C0 failed: ${err.message}`);
                    summary.errors.push(`chunk_recovery: ${err.message}`);
                }
            }

            // C1: Audio-orch state recovery
            try {
                const c1Count = await recoverAudioOrchStates(redis, deps);
                summary.itemsRecovered += c1Count;
                phases.push(`audio_orch:${c1Count}`);
            } catch (err) {
                warn(`Phase C1 failed: ${err.message}`);
                summary.errors.push(`audio_orch: ${err.message}`);
            }

            // C1b: Video-orch state recovery
            try {
                const c1bCount = await recoverVideoOrchStates(redis, deps);
                summary.itemsRecovered += c1bCount;
                phases.push(`video_orch:${c1bCount}`);
            } catch (err) {
                warn(`Phase C1b failed: ${err.message}`);
                summary.errors.push(`video_orch: ${err.message}`);
            }

            // C2: Version staleness check
            try {
                const c2Count = await checkVersionStaleness(redis, deps);
                if (c2Count > 0) phases.push(`version_stale:${c2Count}`);
            } catch (err) {
                warn(`Phase C2 failed: ${err.message}`);
                summary.errors.push(`version_stale: ${err.message}`);
            }

            // C3 removed (S1.4): was log-only PNG scan, no state mutation.
            // recoverIuImagesFromDisk() too expensive for every 60s cycle without value.

            // C4: Reconcile missing scene counters from PG
            try {
                const c4Count = await reconcileMissingSceneState(redis, deps);
                if (c4Count > 0) phases.push(`counter_reconcile:${c4Count}`);
            } catch (err) {
                warn(`Phase C4 failed: ${err.message}`);
                summary.errors.push(`counter_reconcile: ${err.message}`);
            }

            // C5: Resume incomplete sessions (optional — requires runBackgroundWindowGeneration)
            if (typeof deps.resumeIncompleteSessions === 'function' && typeof deps.runBackgroundWindowGeneration === 'function') {
                try {
                    await deps.resumeIncompleteSessions(log, deps.runBackgroundWindowGeneration);
                    phases.push('session_resume');
                } catch (err) {
                    warn(`Phase C5 failed: ${err.message}`);
                    summary.errors.push(`session_resume: ${err.message}`);
                }
            }
        }

        // ══════════════════════════════════════════════
        // PHASE C6: Restore durable layer-config from book.json (Кирпич №2)
        // ══════════════════════════════════════════════
        // Сервис layer-config владеет форматом: заполняет ТОЛЬКО отсутствующие
        // Redis-ключи из durable-копии (нормализуя значения). В норме — no-op.
        // Запускается каждый цикл (не только startup), чтобы heal удалений
        // ключа cleanBookRedisKeys на cache-clear / import / recovery, пока
        // книга существует — конфиг не пропадает из Redis до рестарта.

        if (!scope) {
            try {
                let layerConfig;
                try { layerConfig = require('../services/layer-config'); } catch (_) { layerConfig = null; }
                if (layerConfig && typeof layerConfig.restoreFromBooks === 'function') {
                    const c6Count = await layerConfig.restoreFromBooks(redis);
                    if (c6Count > 0) phases.push(`layer_config_restore:${c6Count}`);
                }
            } catch (err) {
                warn(`Phase C6 failed: ${err.message}`);
                summary.errors.push(`layer_config_restore: ${err.message}`);
            }
        }

        // ══════════════════════════════════════════════
        // PHASE D: Full scene reconciliation
        // ══════════════════════════════════════════════
        if (!scope || scope.includes(':')) {
            try {
                const dReport = await reconcileAll(redis);
                summary.totalScanned = dReport.orphanStates.length + dReport.orphanAssets.length;
                phases.push(`reconcile:${dReport.inconsistentScenes.length}_issues`);
                // Auto-fix safe issues
                const fixes = getFixRecommendations(dReport.inconsistentScenes);
                for (const fix of fixes.filter(f => f.safeToExecute)) {
                    try {
                        await applyFix(redis, fix);
                    } catch (fixErr) {
                        warn(`Auto-fix failed for ${fix.scene.sceneId}: ${fixErr.message}`);
                    }
                }
            } catch (err) {
                warn(`Phase D failed: ${err.message}`);
                summary.errors.push(`reconcile: ${err.message}`);
            }
        }

        // ── Journal: RECOVERY_COMPLETED ──
        try {
            await journal.appendSceneEvent(redis, '_system', '_recovery', '_cycle',
                journal.EventType.RECOVERY_COMPLETED, 'DONE',
                { startup, scope, phases, summary, elapsedMs: Date.now() - startTime }
            );
        } catch (_) {}

        log(`Cycle complete [${phases.join(', ')}] in ${Date.now() - startTime}ms`);
        return { ok: true, phases, summary };

    } finally {
        await releaseLock();
    }
}

// ── PHASE A: Recover result/error keys ─────────────────
// Из audio-recovery.cjs: сканирует animastor:result:* и animastor:error:*,
// доигрывает потерянные результаты через taskHandler.handleTaskResult.
// Для error-ключей вызывает orchestrator.failStage.
async function recoverResultKeys(redis, deps, scope) {
    const taskHandler = deps.taskHandler;
    if (!taskHandler || typeof taskHandler.handleTaskResult !== 'function') return 0;

    let recovered = 0;

    // Отклонения dispatch-identity — терминальные для результата: dispatch
    // уже финализирован/отменён, файл писать нельзя. Ключ удаляем, чтобы
    // recovery не ретраил его каждые 60 сек до истечения 1-часового TTL
    // (бывший бесконечный цикл по _g2.._g5 после no_active_dispatch).
    const TERMINAL_REJECTIONS = new Set([
        'no_active_dispatch',
        'stale_dispatch',
        'missing_dispatch_id',
        'metadata_missing_dispatch_id',
        'dispatch_metadata_changed',
        'lease_token_mismatch',
    ]);

    // Scan animastor:result:*
    let cursor = '0';
    do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'animastor:result:*', 'COUNT', 200);
        cursor = nextCursor;
        for (const key of keys) {
            try {
                const raw = await redis.get(key);
                if (!raw) continue;

                let job_id, result_base64, buildId, dispatchId;

                // Try JSON (new format: { job_id, result_base64, build_id })
                if (raw.startsWith('{')) {
                    try {
                        const data = JSON.parse(raw);
                        job_id = data.job_id;
                        result_base64 = data.result_base64;
                        buildId = data.build_id;
                        dispatchId = data.dispatch_id;
                    } catch (_) {
                        await redis.del(key);
                        continue;
                    }
                } else {
                    // Data URL fallback (old format)
                    result_base64 = raw;
                    const keyParts = key.split(':');
                    const buildPart = keyParts[2] || '';
                    const combinedId = `${keyParts[3] || ''}_${keyParts[4] || ''}_${keyParts[5] || ''}`;
                    job_id = `${combinedId}:${keyParts[6] || 'audio'}`;
                    buildId = buildPart;
                }

                if (!job_id || !result_base64) continue;

                // Scope filter
                if (scope && !job_id.startsWith(scope)) continue;

                if (!buildId || !dispatchId) {
                    warn(`Skipping legacy result without build/dispatch identity: ${job_id}`);
                    continue;
                }
                try {
                    await taskHandler.handleTaskResult(job_id, result_base64, buildId, dispatchId);
                } catch (rejectErr) {
                    if (rejectErr && TERMINAL_REJECTIONS.has(rejectErr.code)) {
                        warn(`Result ${job_id} terminally rejected (${rejectErr.code}) — dropping result key, no infinite retry`);
                        await redis.del(key);
                    } else {
                        throw rejectErr;
                    }
                    continue;
                }
                await redis.del(key);
                recovered++;
            } catch (itemErr) {
                warn(`Result recovery item failed: ${itemErr.message}`);
            }
        }
    } while (cursor !== '0');

    // Scan animastor:error:* (T3: форвард ошибок, которые не дошли до backend)
    cursor = '0';
    do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'animastor:error:*', 'COUNT', 200);
        cursor = nextCursor;
        for (const key of keys) {
            try {
                const raw = await redis.get(key);
                if (!raw) continue;

                let job_id, buildId, reason, dispatchId;
                try {
                    const data = JSON.parse(raw);
                    job_id = data.job_id;
                    buildId = data.build_id;
                    reason = data.reason;
                    dispatchId = data.dispatch_id;
                } catch (_) {
                    await redis.del(key);
                    continue;
                }

                if (!job_id) continue;
                if (scope && !job_id.startsWith(scope)) continue;

                // Parse job_id to get stage and scene info
                const jobSchema = require('./job-schema');
                const parsed = jobSchema.parseJobId(job_id);
                if (parsed) {
                    const stageMap = { audio_chunk: 'audio', iu_image: 'image', scene_image: 'image', scene_video: 'video' };
                    const stage = stageMap[parsed.kind];
                    if (stage && deps.orchestrator) {
                        await deps.orchestrator.failStage(redis, parsed.bookId, parsed.chapterId, parsed.sceneId,
                            stage, buildId, reason || 'recovered_error', { dispatchId });
                        recovered++;
                    }
                }
                await redis.del(key);
            } catch (itemErr) {
                warn(`Error recovery item failed: ${itemErr.message}`);
            }
        }
    } while (cursor !== '0');

    return recovered;
}

// ── PHASE C1: Recover audio-orch states ────────────────
// Из startup-recovery.js: не-терминальные фазы → FAILED,
// MERGING → DONE если файл есть, иначе FAILED.
async function recoverAudioOrchStates(redis, deps) {
    let audioOrch;
    try {
        audioOrch = require('../services/audio-orchestrator');
    } catch (_) {
        return 0;
    }

    const allStates = await audioOrch.scanAllStates(redis);
    if (allStates.length === 0) return 0;

    let recovered = 0;
    const OUTPUT_DIR = config.OUTPUT_DIR;

    for (const entry of allStates) {
        const { bookId, chapterId, sceneId, state: orchState } = entry;
        const phase = orchState.phase;
        const buildId = orchState.build_id || 'default';
        const mergedPath = syncPath.join(OUTPUT_DIR, buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);

        switch (phase) {
            case 'GENERATING':
            case 'WAITING_CHUNKS':
                // ── RECOVERY: сначала проверяем, все ли чанки на диске ──
                // Если все чанки на месте — доигрываем merge, не FAIL'им.
                // Иначе FAILED → re-dispatch.
                const expectedChunkCount = parseInt(orchState.expected_count || '0', 10);
                const chunks = require('../audio/chunks');
                const presentChunks = chunks.findExistingSceneChunks(bookId, chapterId, sceneId, buildId, expectedChunkCount > 0 ? expectedChunkCount : null);
                if (presentChunks.length > 0) {
                    const actualCount = expectedChunkCount > 0 ? expectedChunkCount : presentChunks.length;
                    log(`[AUDIO-ORCH] Recover ${bookId}/${chapterId}/${sceneId}: ${phase} — ${presentChunks.length}/${actualCount} chunks on disk, driving merge`);
                    // Восстанавливаем expected_count если он был 0
                    if (expectedChunkCount === 0 && presentChunks.length > 0) {
                        orchState.expected_count = presentChunks.length;
                        await audioOrch.setState(redis, bookId, chapterId, sceneId, orchState);
                    }
                    try {
                        await audioOrch.completeChunk(redis, bookId, chapterId, sceneId, 'recovery', buildId, {
                            audio: deps.audio || require('../audio'),
                            orchestrator: deps.orchestrator,
                            dispatchId: 'startup-recovery',
                        });
                        recovered++;
                        break;
                    } catch (mergeErr) {
                        warn(`[AUDIO-ORCH] Recover merge failed for ${bookId}/${chapterId}/${sceneId}: ${mergeErr.message} — falling through to FAILED`);
                    }
                }
                log(`[AUDIO-ORCH] Recover ${bookId}/${chapterId}/${sceneId}: ${phase} → FAILED (${presentChunks.length}/${expectedChunkCount || '?'} chunks on disk)`);
                await audioOrch.setFailed(redis, bookId, chapterId, sceneId, 'restart_recovery');
                // F1: sync asset.audio → FAILED after audioOrch.setFailed (R3 follow-up)
                await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, 'audio', state.AssetState.FAILED);
                // T6: Также сбрасываем asset state, чтобы scheduler передиспатчил
                if (deps.orchestrator) {
                    await deps.orchestrator.markDirtyScene(redis, bookId, chapterId, sceneId, ['audio']);
                }
                recovered++;
                break;
            case 'MERGING':
                if (syncFs.existsSync(mergedPath)) {
                    log(`[AUDIO-ORCH] Recover ${bookId}/${chapterId}/${sceneId}: MERGING → DONE`);
                    await audioOrch.setDone(redis, bookId, chapterId, sceneId);
                    // R3: sync asset state after audioOrch.setDone — asset.audio → READY
                    await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, 'audio', state.AssetState.READY);
                } else {
                    log(`[AUDIO-ORCH] Recover ${bookId}/${chapterId}/${sceneId}: MERGING → FAILED`);
                    await audioOrch.setFailed(redis, bookId, chapterId, sceneId, 'restart_merge_missing');
                    // F1: sync asset.audio → FAILED after audioOrch.setFailed (R3 follow-up)
                    await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, 'audio', state.AssetState.FAILED);
                    if (deps.orchestrator) {
                        await deps.orchestrator.markDirtyScene(redis, bookId, chapterId, sceneId, ['audio']);
                    }
                }
                recovered++;
                break;
            case 'PLACEHOLDER_READY':
                // Leave as is, scheduler will dispatch
                break;
            case 'DONE':
            case 'FAILED':
                // Terminal, leave as is
                break;
            default:
                await audioOrch.deleteState(redis, bookId, chapterId, sceneId);
                break;
        }
    }

    if (recovered > 0) log(`[AUDIO-ORCH] ${recovered} non-terminal states recovered`);
    return recovered;
}

// ── PHASE C1b: Recover video-orch states ───────────────
// Зеркало recoverAudioOrchStates: не-терминальные фазы → FAILED (re-dispatch),
// MERGING/WAITING_CHUNKS с полным набором групп → доигрываем merge.
async function recoverVideoOrchStates(redis, deps) {
    let videoOrch;
    try {
        videoOrch = require('../services/video-orchestrator');
    } catch (_) {
        return 0;
    }

    const allStates = await videoOrch.scanAllStates(redis);
    if (allStates.length === 0) return 0;

    let recovered = 0;
    const OUTPUT_DIR = config.OUTPUT_DIR;

    for (const entry of allStates) {
        const { bookId, chapterId, sceneId, state: orchState } = entry;
        const phase = orchState.phase;
        const buildId = orchState.build_id || 'default';
        const suffixes = videoOrch.groupSuffixes(orchState);
        const mergedPath = syncPath.join(OUTPUT_DIR, buildId, `${bookId}_${chapterId}_${sceneId}.mp4`);

        switch (phase) {
            case 'GENERATING':
            case 'WAITING_CHUNKS':
                // ── RECOVERY: сначала проверяем, все ли группы на диске ──
                const presentCount = suffixes.filter(s => videoOrch.isGroupFileValid(buildId, bookId, chapterId, sceneId, s)).length;
                if (presentCount === suffixes.length && suffixes.length > 0) {
                    log(`[VIDEO-ORCH] Recover ${bookId}/${chapterId}/${sceneId}: ${phase} — ${presentCount}/${suffixes.length} groups on disk, driving merge`);
                    try {
                        await videoOrch.completeGroup(redis, bookId, chapterId, sceneId, '', buildId, {
                            orchestrator: deps.orchestrator,
                            dispatchId: 'startup-recovery',
                        });
                        recovered++;
                        break;
                    } catch (mergeErr) {
                        warn(`[VIDEO-ORCH] Recover merge failed for ${bookId}/${chapterId}/${sceneId}: ${mergeErr.message} — falling through to FAILED`);
                    }
                }
                log(`[VIDEO-ORCH] Recover ${bookId}/${chapterId}/${sceneId}: ${phase} → FAILED (${presentCount}/${suffixes.length} groups on disk)`);
                await videoOrch.setFailed(redis, bookId, chapterId, sceneId, 'restart_recovery');
                // F1: sync asset.video → FAILED после videoOrch.setFailed
                await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, 'video', state.AssetState.FAILED);
                if (deps.orchestrator) {
                    await deps.orchestrator.markDirtyScene(redis, bookId, chapterId, sceneId, ['video']);
                }
                recovered++;
                break;
            case 'MERGING':
                if (syncFs.existsSync(mergedPath)) {
                    log(`[VIDEO-ORCH] Recover ${bookId}/${chapterId}/${sceneId}: MERGING → DONE`);
                    await videoOrch.setDone(redis, bookId, chapterId, sceneId);
                    await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, 'video', state.AssetState.READY);
                } else {
                    log(`[VIDEO-ORCH] Recover ${bookId}/${chapterId}/${sceneId}: MERGING → FAILED`);
                    await videoOrch.setFailed(redis, bookId, chapterId, sceneId, 'restart_merge_missing');
                    await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, 'video', state.AssetState.FAILED);
                    if (deps.orchestrator) {
                        await deps.orchestrator.markDirtyScene(redis, bookId, chapterId, sceneId, ['video']);
                    }
                }
                recovered++;
                break;
            case 'DONE':
            case 'FAILED':
                // Terminal — leave as is
                break;
            default:
                await videoOrch.deleteState(redis, bookId, chapterId, sceneId);
                break;
        }
    }

    if (recovered > 0) log(`[VIDEO-ORCH] ${recovered} non-terminal states recovered`);
    return recovered;
}

// ── PHASE C2: Version staleness check ───────────────────
// Из startup-recovery.js: для stale-ассетов → markDirtyScene
async function checkVersionStaleness(redis, deps) {
    const { postgres, orchestrator } = deps;
    if (!postgres || !postgres.query || !orchestrator) return 0;

    try {
        const result = await postgres.query(`
            SELECT s.book_id, s.chapter_id, s.scene_id, s.content_version, s.audio_config_version,
                   a.asset_type, a.scene_content_version, a.scene_audio_config_version
            FROM scenes s
            LEFT JOIN scene_assets a ON a.book_id = s.book_id
                AND a.chapter_id = s.chapter_id
                AND a.scene_id = s.scene_id
            WHERE s.content_version > 1 OR s.audio_config_version > 1
        `);

        const sceneMap = new Map();
        for (const row of result.rows) {
            const key = `${row.book_id}|${row.chapter_id}|${row.scene_id}`;
            if (!sceneMap.has(key)) {
                sceneMap.set(key, { bookId: row.book_id, chapterId: row.chapter_id, sceneId: row.scene_id, stale: false });
            }
            const entry = sceneMap.get(key);
            if ((row.scene_content_version != null && row.content_version != null && row.scene_content_version < row.content_version) ||
                (row.scene_audio_config_version != null && row.audio_config_version != null && row.scene_audio_config_version < row.audio_config_version)) {
                entry.stale = true;
            }
        }

        let outdated = 0;
        for (const entry of sceneMap.values()) {
            if (entry.stale) {
                log(`[VERSION-STALE] ${entry.bookId}/${entry.chapterId}/${entry.sceneId}`);
                await orchestrator.markDirtyScene(redis, entry.bookId, entry.chapterId, entry.sceneId);
                outdated++;
            }
        }
        return outdated;
    } catch (err) {
        warn(`Version staleness check failed: ${err.message}`);
        return 0;
    }
}

// ── PHASE C3: REMOVED in S1.4 (2026-07-19) ─────────────
// Был log-only PNG scan, сканировал всю OUTPUT_DIR по 60s. Не мутировал состояние,
// только логировал счётчик сцен с IU images. Полная walks FS без пользы для reconcile.
// Аналогичная функция recoverIuImagesFromDisk осталась в services/startup-recovery.js
// (вызывается явно, не на каждый reconcile-цикл).

// ── PHASE C4: Reconcile missing scene counters from PG ─
// Из startup-recovery.js: логирует книги с PG записями без Redis-счётчиков.
async function reconcileMissingSceneState(redis, deps) {
    const { postgres } = deps;
    if (!postgres || !postgres.query) return 0;

    try {
        const bookResult = await postgres.query(`SELECT DISTINCT book_id FROM scenes`);
        let count = 0;
        for (const row of bookResult.rows) {
            const totalKey = `animastor:book-scenes:${row.book_id}:total`;
            const totalRaw = await redis.get(totalKey);
            if (!totalRaw || parseInt(totalRaw, 10) === 0) {
                log(`[COUNTER-LOG-ONLY] Book ${row.book_id} has PG records but no Redis counters`);
                count++;
            }
        }
        return count;
    } catch (err) {
        warn(`Missing scene state check failed: ${err.message}`);
        return 0;
    }
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    reconcileScene,
    reconcileBook,
    reconcileAll,
    reconcileCycle,
    recoverResultKeys,
    recoverAudioOrchStates,
    recoverVideoOrchStates,
    checkVersionStaleness,
    reconcileMissingSceneState,
    checkStalledAudioScenes,
    checkStalledVideoScenes,

    checkAudioOrchInvariants,
    checkVideoOrchInvariants,

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
