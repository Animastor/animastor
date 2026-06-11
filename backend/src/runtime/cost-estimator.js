// ======================================================
// COST ESTIMATOR - RUNTIME COST PREDICTION
// ======================================================
// Estimates scene execution costs for cost-aware scheduling.
// Cost factors:
// - expected video duration
// - image count
// - animation complexity
// - audio duration
// - workflow nodes
// - retry history
//
// Cost units: "GPU seconds" (approximate GPU time required)

const logPrefix = '[COST]';

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
// COST CONFIGURATION
// ======================================================

const COST_CONFIG = {
    // Base costs per unit
    baseCosts: {
        narration: 5,         // seconds per narration scene
        audio: 10,            // seconds per audio generation
        image: 15,            // seconds per image generation
        animation: 20,        // seconds per animation node
        video: 30,            // seconds per video generation
        cinematic: 50,        // seconds per cinematic transition
        videoScene: 60        // base cost for video scenes
    },

    // Multipliers by workload
    workloadMultipliers: {
        LIGHT: 1.0,
        MEDIUM: 1.5,
        HEAVY: 2.5,
        EXTREME: 5.0
    },

    // GPU costs (approximate seconds at standard GPU)
    gpuCosts: {
        audio: 8,             // seconds of GPU time
        image: 12,            // seconds of GPU time
        video: 30,            // seconds of GPU time
        caption: 2,           // seconds of GPU time
        animation: 15         // seconds per animation node
    },

    // Cost decay (older retries count less toward cost)
    retryCostDecay: 0.7,    // 70% cost for each retry attempt

    // Time-based cost inflation (runtime congestion factor)
    timeBasedInflation: {
        baseHour: 9,          // Start inflating at 9 AM
        peakHour: 17,         // Peak at 5 PM
        maxInflation: 2.0     // 2x cost at peak
    }
};

// ======================================================
// COST STORAGE KEYS
// ======================================================

/**
 * Get cost estimation cache key.
 */
function getCostCacheKey(bookId, chapterId, sceneId) {
    return `animastor:cost:cache:${bookId}:${chapterId}:${sceneId}`;
}

/**
 * Get scene cost history key (for tracking actual costs).
 */
function getCostHistoryKey(bookId, chapterId, sceneId) {
    return `animastor:cost:history:${bookId}:${chapterId}:${sceneId}`;
}

/**
 * Get cost budget key for book.
 */
function getCostBudgetKey(bookId) {
    return `animastor:cost:预算:${bookId}`;
}

// ======================================================
// ESTIMATION LOGIC
// ======================================================

/**
 * Calculate estimateSceneCost for a scene.
 * Returns EstimatedCost in GPU seconds.
 */
async function estimateSceneCost(redis, scene) {
    let totalCost = 0;
    let components = [];

    // Base cost by content type
    if (scene.content_type === 'narration') {
        const narrationCost = COST_CONFIG.baseCosts.narration * (scene.expected_duration || 10);
        totalCost += narrationCost;
        components.push({ name: 'narration', cost: narrationCost, duration: scene.expected_duration || 10 });
    } else if (scene.content_type === 'video' || scene.output_type === 'video') {
        const videoBaseCost = COST_CONFIG.baseCosts.videoScene;
        totalCost += videoBaseCost;
        components.push({ name: 'video_base', cost: videoBaseCost });
    } else {
        const baseCost = COST_CONFIG.baseCosts.audio;
        totalCost += baseCost;
        components.push({ name: 'base_audio', cost: baseCost });
    }

    // Audio generation cost
    const audioDuration = scene.audio_duration || 30;
    if (audioDuration > 0) {
        const audioCost = audioDuration * COST_CONFIG.baseCosts.audio;
        totalCost += audioCost;
        components.push({ name: 'audio', cost: audioCost, duration: audioDuration });
    }

    // Image generation cost
    const imageCount = scene.image_count || 1;
    if (imageCount > 0) {
        const imageCost = imageCount * COST_CONFIG.baseCosts.image;
        totalCost += imageCost;
        components.push({ name: 'images', cost: imageCost, count: imageCount });
    }

    // Animation complexity cost
    const animationNodes = scene.workflow_nodes || 0;
    if (animationNodes > 0) {
        const animationCost = animationNodes * COST_CONFIG.baseCosts.animation;
        totalCost += animationCost;
        components.push({ name: 'animation', cost: animationCost, nodes: animationNodes });
    }

    // Cinematic transitions
    if (scene.has_cinematic_transitions) {
        const cinematicCount = scene.cinematic_count || 3;
        const cinematicCost = cinematicCount * COST_CONFIG.baseCosts.cinematic;
        totalCost += cinematicCost;
        components.push({ name: 'cinematic', cost: cinematicCost, count: cinematicCount });
    }

    // Expected video generation cost (for video output)
    if (scene.output_type === 'video' || scene.content_type === 'video') {
        const videoDuration = scene.expected_duration || 60;
        const videoCost = videoDuration * COST_CONFIG.gpuCosts.video;
        totalCost += videoCost;
        components.push({ name: 'video_generation', cost: videoCost, duration: videoDuration });
    }

    // Retry history cost (ystered attempts add overhead)
    const retryKey = `animastor:runtime:retry:${scene.book_id}:${scene.chapter_id}:${scene.scene_id}:count`;
    const retryCount = parseInt(await redis.get(retryKey) || '0', 10);
    if (retryCount > 0) {
        // Each retry adds overhead but with decay
        let retryCost = 0;
        for (let i = 0; i < retryCount; i++) {
            retryCost += totalCost * COST_CONFIG.retryCostDecay * Math.pow(COST_CONFIG.retryCostDecay, i);
        }
        totalCost += retryCost;
        components.push({ name: 'retry_overhead', cost: Math.round(retryCost), attempts: retryCount });
    }

    // Cost estimation
    return {
        estimatedCost: Math.round(totalCost),
        estimatedGpuSeconds: Math.round(totalCost),
        estimatedDuration: Math.round(totalCost / 10), // Rough duration estimate
        components,
        estimatedAt: Date.now()
    };
}

/**
 * Estimate scene cost with workload multiplier applied.
 */
async function estimateCostWithWorkloadMultiplier(redis, scene, workload) {
    const baseEstimate = await estimateSceneCost(redis, scene);
    const multiplier = COST_CONFIG.workloadMultipliers[workload] || 1.0;

    return {
        ...baseEstimate,
        workload,
        workloadMultiplier: multiplier,
        adjustedCost: Math.round(baseEstimate.estimatedCost * multiplier),
        adjustedGpuSeconds: Math.round(baseEstimate.estimatedGpuSeconds * multiplier)
    };
}

/**
 * Get cost per stage (audio/image/video).
 */
async function getStageCosts(redis, scene) {
    const baseCosts = {
        audio: COST_CONFIG.gpuCosts.audio + (scene.audio_duration || 30),
        image: COST_CONFIG.gpuCosts.image * (scene.image_count || 1),
        video: COST_CONFIG.gpuCosts.video * (scene.expected_duration || 30) / 10
    };

    return {
        audio: Math.round(baseCosts.audio),
        image: Math.round(baseCosts.image),
        video: Math.round(baseCosts.video),
        total: Math.round(baseCosts.audio + baseCosts.image + baseCosts.video)
    };
}

// ======================================================
// BUDGET MANAGEMENT
// ======================================================

/**
 * Get remaining budget for a book.
 */
async function getBookBudget(redis, bookId) {
    const budgetKey = getCostBudgetKey(bookId);
    const raw = await redis.get(budgetKey);

    if (!raw) {
        // Default budget: 1000 GPU seconds per book
        return { total: 1000, remaining: 1000, used: 0 };
    }

    const budget = JSON.parse(raw);
    return {
        total: budget.total || 1000,
        remaining: budget.remaining || 0,
        used: budget.used || 0
    };
}

/**
 * Check if book has budget remaining.
 */
async function hasBudgetRemaining(redis, bookId) {
    const budget = await getBookBudget(redis, bookId);
    return { hasBudget: budget.remaining > 0, budget };
}

/**
 * Deduct cost from budget.
 */
async function deductCostFromBudget(redis, bookId, cost) {
    const budgetKey = getCostBudgetKey(bookId);
    const raw = await redis.get(budgetKey);

    if (!raw) {
        // Create new budget
        await redis.set(budgetKey, JSON.stringify({
            total: 1000,
            used: cost,
            remaining: 1000 - cost,
            lastUpdated: Date.now()
        }), 'EX', 3600); // 1 hour TTL

        return { deducted: true, cost, remaining: 1000 - cost, created: true };
    }

    const budget = JSON.parse(raw);
    if (budget.remaining < cost) {
        return { deducted: false, reason: 'insufficient_budget', cost, remaining: budget.remaining };
    }

    budget.used += cost;
    budget.remaining -= cost;
    budget.lastUpdated = Date.now();

    await redis.set(budgetKey, JSON.stringify(budget), 'EX', 3600);

    return { deducted: true, cost, remaining: budget.remaining, budget };
}

/**
 * Reset book budget.
 */
async function resetBookBudget(redis, bookId) {
    const budgetKey = getCostBudgetKey(bookId);
    await redis.set(budgetKey, JSON.stringify({
        total: 1000,
        used: 0,
        remaining: 1000,
        lastUpdated: Date.now()
    }), 'EX', 3600);

    return { reset: true, bookId };
}

// ======================================================
// COST TRACKING
// ======================================================

/**
 * Record actual cost for completed scene.
 */
async function recordActualCost(redis, scene, actualCost, stage = 'unknown') {
    const historyKey = getCostHistoryKey(scene.book_id, scene.chapter_id, scene.sceneId);
    const costRecord = {
        scene: {
            book_id: scene.book_id,
            chapter_id: scene.chapter_id,
            scene_id: scene.scene_id
        },
        stage,
        estimatedCost: scene.estimatedCost || 0,
        actualCost,
        timestamp: Date.now()
    };

    // Append to cost history (list)
    await redis.rpush(historyKey, JSON.stringify(costRecord));
    await redis.expire(historyKey, 604800); // 7 days TTL

    // Update budget
    await deductCostFromBudget(redis, scene.book_id, actualCost);

    return { recorded: true, cost: actualCost, historyKey };
}

/**
 * Get cost history for a scene.
 */
async function getCostHistory(redis, scene, limit = 100) {
    const historyKey = getCostHistoryKey(scene.book_id, scene.chapter_id, scene.scene_id);
    const historyRaw = await redis.lrange(historyKey, 0, limit - 1);

    return historyRaw.map(h => JSON.parse(h));
}

/**
 * Get total spent on a scene.
 */
async function getTotalSceneCost(redis, scene) {
    const history = await getCostHistory(redis, scene, 1000);
    return history.reduce((sum, h) => sum + h.actualCost, 0);
}

// ======================================================
// TIME-BASED COST ADJUSTMENT
// ======================================================

/**
 * Get time-based cost inflation factor.
 * Higher cost during peak hours.
 */
function getTimeInflationFactor() {
    const now = new Date();
    const hour = now.getHours();

    let factor = 1.0;

    if (hour >= COST_CONFIG.timeBasedInflation.baseHour && hour <= COST_CONFIG.timeBasedInflation.peakHour) {
        // Linear interpolation
        const progress = (hour - COST_CONFIG.timeBasedInflation.baseHour) /
            (COST_CONFIG.timeBasedInflation.peakHour - COST_CONFIG.timeBasedInflation.baseHour);
        factor = 1.0 + progress * (COST_CONFIG.timeBasedInflation.maxInflation - 1.0);
    }

    return factor;
}

/**
 * Apply time-based inflation to cost estimate.
 */
async function estimateCostWithTimeInflation(redis, scene) {
    const baseEstimate = await estimateSceneCost(redis, scene);
    const timeFactor = getTimeInflationFactor();

    return {
        ...baseEstimate,
        timeInflationFactor: timeFactor,
        timeAdjustedCost: Math.round(baseEstimate.estimatedCost * timeFactor),
        timeAdjustedGpuSeconds: Math.round(baseEstimate.estimatedGpuSeconds * timeFactor),
        peakHour: COST_CONFIG.timeBasedInflation.peakHour,
        baseHour: COST_CONFIG.timeBasedInflation.baseHour
    };
}

// ======================================================
// COST REPORTS
// ======================================================

/**
 * Get cost report for a book.
 */
async function getCostReport(redis, bookId) {
    const [budget, totalSpent] = await Promise.all([
        getBookBudget(redis, bookId),
        (async () => {
            // This would require scanning all cost history keys
            // Simplified: just return budget for now
            return { totalSpent: budget.used };
        })()
    ]);

    return {
        bookId,
        budget,
        totalSpent: budget.used,
        remainingBudget: budget.remaining,
        spendingRate: Math.round((budget.used / (budget.total || 1)) * 100),
        timestamp: Date.now()
    };
}

/**
 * Get runtime cost summary.
 */
async function getRuntimeCostSummary(redis) {
    // Get all book budgets
    const budgets = [];
    const pattern = getCostBudgetKey('*');
    let cursor = 0;

    do {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        const keys = result[1];

        for (const key of keys) {
            const raw = await redis.get(key);
            if (raw) {
                try {
                    const budget = JSON.parse(raw);
                    const parts = key.split(':');
                    budgets.push({
                        bookId: parts[3],
                        ...budget
                    });
                } catch (e) {
                    // Skip invalid entries
                }
            }
        }
    } while (cursor !== 0 && budgets.length < 1000);

    const totalBudget = budgets.reduce((sum, b) => sum + (b.total || 0), 0);
    const totalSpent = budgets.reduce((sum, b) => sum + (b.used || 0), 0);
    const totalRemaining = budgets.reduce((sum, b) => sum + (b.remaining || 0), 0);

    return {
        timestamp: Date.now(),
        totalBooks: budgets.length,
        totalBudget,
        totalSpent,
        totalRemaining,
        averageBudget: budgets.length > 0 ? Math.round(totalBudget / budgets.length) : 0,
        averageSpent: budgets.length > 0 ? Math.round(totalSpent / budgets.length) : 0
    };
}

// ======================================================
// COST PREDICTION FROM SCENE DATA
// ======================================================

/**
 * Predict cost before full scene loading.
 * Uses minimal scene data.
 */
function predictSceneCost(scene) {
    let baseCost = 0;
    const factors = [];

    // Content type
    if (scene.content_type === 'narration') {
        baseCost = 50;
        factors.push({ name: 'content_type', value: 'narration', cost: 50 });
    } else if (scene.content_type === 'video') {
        baseCost = 300;
        factors.push({ name: 'content_type', value: 'video', cost: 300 });
    } else {
        baseCost = 100;
        factors.push({ name: 'content_type', value: 'image/audio', cost: 100 });
    }

    // Duration factor
    if (scene.expected_duration) {
        baseCost += scene.expected_duration * 2;
        factors.push({ name: 'duration', value: scene.expected_duration, cost: scene.expected_duration * 2 });
    }

    // Image count
    if (scene.image_count) {
        baseCost += scene.image_count * 15;
        factors.push({ name: 'image_count', value: scene.image_count, cost: scene.image_count * 15 });
    }

    // Animation
    if (scene.workflow_nodes) {
        baseCost += scene.workflow_nodes * 20;
        factors.push({ name: 'workflow_nodes', value: scene.workflow_nodes, cost: scene.workflow_nodes * 20 });
    }

    return {
        estimatedCost: Math.round(baseCost),
        estimatedGpuSeconds: Math.round(baseCost * 1.5),
        factors,
        predictionConfidence: scene.content_type ? 'high' : 'medium'
    };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Config
    COST_CONFIG,

    // Cost calculation
    estimateSceneCost,
    estimateCostWithWorkloadMultiplier,
    estimateCostWithTimeInflation,
    getStageCosts,
    predictSceneCost,

    // Budgets
    getBookBudget,
    hasBudgetRemaining,
    deductCostFromBudget,
    resetBookBudget,
    getCostBudgetKey,

    // Tracking
    recordActualCost,
    getCostHistory,
    getTotalSceneCost,
    getCostHistoryKey,

    // Reports
    getCostReport,
    getRuntimeCostSummary,

    // Helpers
    getTimeInflationFactor,

    // Key patterns
    getCostCacheKey,
    getCostHistoryKey
};
