// ======================================================
// WORKLOAD CLASSIFIER - RUNTIME WORKLOAD ANALYSIS
// ======================================================
// Classifies scenes by computational cost.
// Workload classes:
// - LIGHT: narration only, small image, short audio
// - MEDIUM: standard scene
// - HEAVY: long animation, multiple characters, cinematic transitions
// - EXTREME: long video, multi-stage GPU-heavy scene
//
// Classification factors:
// - expected video duration
// - image count
// - animation complexity
// - audio duration
// - workflow nodes
// - retry history
// - ADAPTIVE: historical runtime observations

const logPrefix = '[WORKLOAD]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function debug(msg) {
    console.debug(`${logPrefix} • ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

function error(msg) {
    console.error(`${logPrefix} ❌ ${msg}`);
}

const feedbackEngine = require('./feedback-engine');

// ======================================================
// WORKLOAD CLASSES
// ======================================================

const WorkloadClass = {
    LIGHT: 'LIGHT',
    MEDIUM: 'MEDIUM',
    HEAVY: 'HEAVY',
    EXTREME: 'EXTREME'
};

// ======================================================
// WORKLOAD CONFIGURATION
// ======================================================

const WORKLOAD_CONFIG = {
    // Duration thresholds (seconds)
    duration: {
        lightMax: 15,
        mediumMax: 60,
        heavyMax: 180
    },

    // Image count thresholds
    imageCount: {
        lightMax: 3,
        mediumMax: 10,
        heavyMax: 30
    },

    // Animation complexity factors
    animation: {
        lightMaxNodes: 5,
        mediumMaxNodes: 20,
        heavyMaxNodes: 50
    },

    // Audio duration thresholds (seconds)
    audio: {
        lightMax: 10,
        mediumMax: 30,
        heavyMax: 60
    },

    // Cost weights for scoring
    weights: {
        videoDuration: 0.3,
        imageCount: 0.2,
        audioDuration: 0.2,
        workflowNodes: 0.15,
        retryHistory: 0.15
    },

    // Cost thresholds for classification
    costThresholds: {
        lightMax: 30,
        mediumMax: 70,
        heavyMax: 120
    }
};

// ======================================================
// WORKLOAD KEY PATTERNS
// ======================================================

/**
 * Get workload cache key for scene.
 */
function getWorkloadCacheKey(bookId, chapterId, sceneId) {
    return `animastor:workload:cache:${bookId}:${chapterId}:${sceneId}`;
}

// ======================================================
// WORKLOAD SCORING
// ======================================================

/**
 * Score a scene based on multiple factors.
 * Higher score = heavier workload.
 */
async function scoreScene(redis, scene, loadedBook) {
    let totalScore = 0;
    let factors = [];

    // 1. Video Duration (if applicable)
    if (scene.expected_duration) {
        const duration = scene.expected_duration;
        const durationScore = Math.min(100, (duration / 60) * 100); // Normalize to 100
        totalScore += durationScore * WORKLOAD_CONFIG.weights.videoDuration;
        factors.push({ name: 'video_duration', value: duration, score: Math.round(durationScore) });
    }

    // 2. Image count
    const imageCount = scene.image_count || 0;
    const imageScore = Math.min(100, (imageCount / 10) * 100);
    totalScore += imageScore * WORKLOAD_CONFIG.weights.imageCount;
    factors.push({ name: 'image_count', value: imageCount, score: Math.round(imageScore) });

    // 3. Animation complexity (nodes in workflow)
    const workflowNodes = scene.workflow_nodes || 0;
    const workflowScore = Math.min(100, (workflowNodes / 20) * 100);
    totalScore += workflowScore * WORKLOAD_CONFIG.weights.workflowNodes;
    factors.push({ name: 'workflow_nodes', value: workflowNodes, score: Math.round(workflowScore) });

    // 4. Audio duration (if not narration-only)
    if (scene.audio_duration) {
        const audioScore = Math.min(100, (scene.audio_duration / 30) * 100);
        totalScore += audioScore * WORKLOAD_CONFIG.weights.audioDuration;
        factors.push({ name: 'audio_duration', value: scene.audio_duration, score: Math.round(audioScore) });
    }

    // 5. Retry history (more retries = heavier due to complexity)
    const retryKey = `animastor:runtime:retry:${scene.book_id}:${scene.chapter_id}:${scene.scene_id}:count`;
    const retryCount = parseInt(await redis.get(retryKey) || '0', 10);
    const retryScore = Math.min(100, Math.min(retryCount, 10) * 10);
    totalScore += retryScore * WORKLOAD_CONFIG.weights.retryHistory;
    factors.push({ name: 'retry_history', value: retryCount, score: Math.round(retryScore) });

    return {
        totalScore: Math.round(totalScore),
        factors,
        rawScore: totalScore
    };
}

// ======================================================
// CLASSIFICATION LOGIC
// ======================================================

/**
 * Classify scene by workload.
 * Returns: { workload, score, factors, classificationThresholds }
 */
async function classifyScene(redis, scene, loadedBook) {
    const result = await scoreScene(redis, scene, loadedBook);
    const score = result.totalScore;

    let workload;
    if (score <= WORKLOAD_CONFIG.costThresholds.lightMax) {
        workload = WorkloadClass.LIGHT;
    } else if (score <= WORKLOAD_CONFIG.costThresholds.mediumMax) {
        workload = WorkloadClass.MEDIUM;
    } else if (score <= WORKLOAD_CONFIG.costThresholds.heavyMax) {
        workload = WorkloadClass.HEAVY;
    } else {
        workload = WorkloadClass.EXTREME;
    }

    log(`WORKLOAD_CLASSIFIED: ${scene.book_id}/${scene.chapter_id}/${scene.scene_id} = ${workload} (score=${score})`);

    return {
        workload,
        score,
        factors: result.factors,
        classificationThresholds: WORKLOAD_CONFIG.costThresholds,
        classifiedAt: Date.now()
    };
}

/**
 * Classify a scene and cache the result.
 */
async function classifyAndCache(redis, scene, loadedBook) {
    const result = await classifyScene(redis, scene, loadedBook);

    const cacheKey = getWorkloadCacheKey(scene.book_id, scene.chapter_id, scene.scene_id);
    await redis.set(cacheKey, JSON.stringify(result), 'EX', 300); // 5 minute cache

    return result;
}

/**
 * Estimate scene cost using adaptive cost model.
 * Uses historical runtime observations to adjust estimates.
 */
async function estimateSceneCost(redis, scene, loadedBook) {
    const baselineCost = await calculateBaselineCost(scene, loadedBook);

    // Check if we have adaptive cost data
    const workload = scene.workload || WorkloadClass.MEDIUM;
    const adaptiveEstimate = await feedbackEngine.getAdaptiveCostEstimate(redis, workload);

    if (adaptiveEstimate.reason === 'adaptive' && adaptiveEstimate.estimated) {
        const adjustedCost = baselineCost * adaptiveEstimate.ratio;
        debug(`ADAPTIVE_COST: workload=${workload}, ratio=${adaptiveEstimate.ratio.toFixed(2)}, estimated=${adjustedCost.toFixed(1)}`);

        return {
            estimatedCost: adjustedCost,
            estimatedGpuSeconds: adjustedCost / 100, // Rough GPU-seconds estimate
            workload,
            confidence: Math.max(0.5, adaptiveEstimate.ratio),
            reason: 'adaptive_cost_model',
            baseline: baselineCost,
            adaptiveRatio: adaptiveEstimate.ratio
        };
    }

    return {
        estimatedCost: baselineCost,
        estimatedGpuSeconds: baselineCost / 100,
        workload,
        confidence: 0.5,
        reason: 'baseline_cost',
        baseline: baselineCost
    };
}

/**
 * Get cached workload classification.
 */
async function getCachedClassification(redis, scene) {
    const cacheKey = getWorkloadCacheKey(scene.book_id, scene.chapter_id, scene.scene_id);
    const cached = await redis.get(cacheKey);

    if (!cached) {
        return null;
    }

    try {
        return JSON.parse(cached);
    } catch (e) {
        return null;
    }
}

/**
 * Get workload classification (use cache if available).
 */
async function getClassification(redis, scene, loadedBook) {
    const cached = await getCachedClassification(redis, scene);

    if (cached) {
        return { ...cached, cached: true };
    }

    return await classifyAndCache(redis, scene, loadedBook);
}

// ======================================================
// WORKLOAD HELPERS
// ======================================================

/**
 * Check if scene is heavy workload.
 */
function isHeavyWorkload(workload) {
    return workload === WorkloadClass.HEAVY || workload === WorkloadClass.EXTREME;
}

/**
 * Check if scene is extreme workload.
 */
function isExtremeWorkload(workload) {
    return workload === WorkloadClass.EXTREME;
}

/**
 * Get workload multiplier for throttling.
 */
function getWorkloadMultiplier(workload) {
    switch (workload) {
        case WorkloadClass.LIGHT:
            return 1.0;
        case WorkloadClass.MEDIUM:
            return 0.8;
        case WorkloadClass.HEAVY:
            return 0.5;
        case WorkloadClass.EXTREME:
            return 0.2;
        default:
            return 1.0;
    }
}

/**
 * Get recommended concurrency for workload.
 */
function getRecommendedConcurrency(workload) {
    switch (workload) {
        case WorkloadClass.LIGHT:
            return 5;
        case WorkloadClass.MEDIUM:
            return 3;
        case WorkloadClass.HEAVY:
            return 2;
        case WorkloadClass.EXTREME:
            return 1;
        default:
            return 2;
    }
}

// ======================================================
// WORKLOAD REPORTS
// ======================================================

/**
 * Get workload distribution across scenes.
 */
async function getWorkloadDistribution(redis, scenes) {
    const distribution = {
        [WorkloadClass.LIGHT]: 0,
        [WorkloadClass.MEDIUM]: 0,
        [WorkloadClass.HEAVY]: 0,
        [WorkloadClass.EXTREME]: 0
    };

    for (const scene of scenes) {
        const cached = await getCachedClassification(redis, scene);
        if (cached) {
            distribution[cached.workload]++;
        }
    }

    const total = scenes.length;
    return {
        total,
        distribution,
        percentages: {
            [WorkloadClass.LIGHT]: Math.round((distribution[WorkloadClass.LIGHT] / total) * 100),
            [WorkloadClass.MEDIUM]: Math.round((distribution[WorkloadClass.MEDIUM] / total) * 100),
            [WorkloadClass.HEAVY]: Math.round((distribution[WorkloadClass.HEAVY] / total) * 100),
            [WorkloadClass.EXTREME]: Math.round((distribution[WorkloadClass.EXTREME] / total) * 100)
        }
    };
}

/**
 * Get workload statistics for all pending scenes.
 */
async function getPendingWorkloadStats(redis) {
    const pendingScenes = [];

    // Scan for pending states
    const pattern = 'animastor:scene-state:*';
    let cursor = 0;

    do {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        const keys = result[1];

        for (const key of keys) {
            const raw = await redis.get(key);
            if (!raw) continue;

            try {
                const state = JSON.parse(raw);
                if (state.state === 'pending' || state.state === 'queued') {
                    const parts = key.split(':');
                    pendingScenes.push({
                        book_id: parts[2],
                        chapter_id: parts[3],
                        scene_id: parts[4]
                    });
                }
            } catch (e) {
                // Skip invalid entries
            }
        }
    } while (cursor !== 0 && pendingScenes.length < 1000);

    return await getWorkloadDistribution(redis, pendingScenes);
}

/**
 * Get workload prediction for a scene based on content.
 * (Simplified prediction without full processing)
 */
function predictWorkloadFromContent(scene) {
    // Predict based on scene content characteristics
    let score = 0;
    const factors = [];

    // Narration-only is lightweight
    if (scene.content_type === 'narration') {
        return {
            predicted: WorkloadClass.LIGHT,
            score: 10,
            factors: [{ name: 'content_type', value: 'narration', impact: 'light' }]
        };
    }

    // Video content is heavy
    if (scene.content_type === 'video' || scene.output_type === 'video') {
        score += 50;
        factors.push({ name: 'content_type', value: 'video', impact: 'heavy' });
    }

    // Animation adds complexity
    if (scene.has_animation) {
        score += 20;
        factors.push({ name: 'has_animation', value: true, impact: 'medium' });
    }

    // Multiple characters
    if (scene.character_count > 3) {
        score += 30;
        factors.push({ name: 'character_count', value: scene.character_count, impact: 'heavy' });
    }

    // Long scenes
    if (scene.expected_duration > 120) {
        score += 40;
        factors.push({ name: 'expected_duration', value: scene.expected_duration, impact: 'heavy' });
    }

    if (score < 30) {
        return { predicted: WorkloadClass.LIGHT, score, factors };
    } else if (score < 70) {
        return { predicted: WorkloadClass.MEDIUM, score, factors };
    } else if (score < 120) {
        return { predicted: WorkloadClass.HEAVY, score, factors };
    }
    return { predicted: WorkloadClass.EXTREME, score, factors };
}

// ======================================================
// DEBUG: Get workload status
// ======================================================

/**
 * Get detailed workload status for a scene.
 */
async function getWorkloadStatus(redis, scene, loadedBook) {
    const classification = await getClassification(redis, scene, loadedBook);
    const prediction = predictWorkloadFromContent(scene);

    return {
        scene: {
            book_id: scene.book_id,
            chapter_id: scene.chapter_id,
            scene_id: scene.scene_id
        },
        classification,
        prediction,
        cached: classification.cached || false,
        throttlingMultiplier: getWorkloadMultiplier(classification.workload),
        recommendedConcurrency: getRecommendedConcurrency(classification.workload),
        feedbackStatus: {
            renderRecords: await feedbackEngine.getRecentSamples(redis, 'render_duration', 10).then(s => s.length),
            costHistory: await feedbackEngine.getCostModelStatus(redis)
        }
    };
}

/**
 * Record actual render duration for cost model adaptation.
 */
async function recordRenderDurationFeedback(redis, scene, durationMs, workload) {
    await feedbackEngine.recordRenderDuration(redis, scene, durationMs);
    return { recorded: true, durationMs, workload };
}

/**
 * Record cost estimation feedback.
 */
async function recordCostFeedback(redis, scene, estimatedCost, actualCost, workload) {
    await feedbackEngine.updateCostModel(redis, estimatedCost, actualCost, workload);
    return { recorded: true, estimatedCost, actualCost, workload };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    WorkloadClass,
    WORKLOAD_CLASS: WorkloadClass,
    WORKLOAD_CLASSES: Object.values(WorkloadClass),

    WORKLOAD_CONFIG,

    // Classification
    classifyScene,
    classifyAndCache,
    getClassification,
    getCachedClassification,
    predictWorkloadFromContent,

    // Helpers
    isHeavyWorkload,
    isExtremeWorkload,
    getWorkloadMultiplier,
    getRecommendedConcurrency,

    // Reports
    getWorkloadDistribution,
    getPendingWorkloadStats,

    // Cost estimation (adaptive)
    estimateSceneCost,

    // Feedback recording
    recordRenderDurationFeedback,
    recordCostFeedback,

    // Debug
    getWorkloadStatus,

    // Key patterns
    getWorkloadCacheKey
};
