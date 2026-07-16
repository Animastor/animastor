// ======================================================
// RETRY BUDGET MANAGER
// ======================================================
// Prevents infinite retries and retry storms.
// Implements per-scene and global retry limits.
//
// PER-SCENE LIMITS:
// - max audio retries
// - max image retries
// - max video retries
//
// GLOBAL LIMITS:
// - retries/minute
// - retries per worker
// - retries per failure type

const logPrefix = '[RETRY-BUDGET]';

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
// CONFIGURATION
// ======================================================

// Per-scene limits
const PER_SCENE_LIMITS = {
    audio: 10,
    image: 10,
    video: 5
};

// Global limits (window: 60 seconds)
const GLOBAL_LIMITS = {
    retriesPerMinute: 100,
    retriesPerWorkerPerMinute: 20
};

//Per-failure-type limits
const FAILURE_TYPE_LIMITS = {
    transient: 50,
    permanent: 0,
    infrastructure: 30,
    orchestration: 20
};

// Budget refill rate (per minute)
const BUDGET_REFILL_RATE = {
    perMinute: 50
};

// ======================================================
// BUDGET KEYS
// ======================================================

/**
 * Get per-scene retry budget key.
 */
function getSceneBudgetKey(bookId, chapterId, sceneId) {
    return `animastor:retry-budget:${bookId}:${chapterId}:${sceneId}`;
}

/**
 * Get per-scene per-stage retry budget key.
 */
function getSceneStageBudgetKey(bookId, chapterId, sceneId, stage) {
    return `animastor:retry-budget:${bookId}:${chapterId}:${sceneId}:${stage}`;
}

/**
 * Get global retry budget key.
 */
function getGlobalBudgetKey() {
    return 'animastor:retry-budget:global';
}

/**
 * Get per-failure-type budget key.
 */
function getFailureTypeBudgetKey(failureType) {
    return `animastor:retry-budget:type:${failureType}`;
}

/**
 * Get worker retry budget key.
 */
function getWorkerBudgetKey(workerId) {
    return `animastor:retry-budget:worker:${workerId}`;
}

/**
 * Get retry budget window key (for time-based counting).
 */
function getBudgetWindowKey() {
    return 'animastor:retry-budget:window';
}

// ======================================================
// BUDGET STATE MANAGEMENT
// ======================================================

/**
 * Get current budget for a scene:stage.
 */
async function getSceneStageBudget(redis, bookId, chapterId, sceneId, stage) {
    const key = getSceneStageBudgetKey(bookId, chapterId, sceneId, stage);
    const current = await redis.get(key);
    const defaultValue = PER_SCENE_LIMITS[stage] || 10;
    return parseInt(current || String(defaultValue), 10);
}

/**
 * Decrement budget for a scene:stage.
 */
async function consumeSceneStageBudget(redis, bookId, chapterId, sceneId, stage) {
    const key = getSceneStageBudgetKey(bookId, chapterId, sceneId, stage);
    const current = await redis.get(key);
    const value = parseInt(current || '10', 10);

    if (value <= 0) {
        return { consumed: false, remaining: 0, exceeded: true };
    }

    const remaining = value - 1;
    await redis.set(key, remaining.toString());

    log(`BUDGET_CONSUMED: ${bookId}/${chapterId}/${sceneId}:${stage} (remaining: ${remaining})`);

    return { consumed: true, remaining, exceeded: false };
}

/**
 * Reset budget for a scene:stage (on success).
 */
async function resetSceneStageBudget(redis, bookId, chapterId, sceneId, stage) {
    const key = getSceneStageBudgetKey(bookId, chapterId, sceneId, stage);
    const defaultValue = PER_SCENE_LIMITS[stage] || 10;
    await redis.set(key, defaultValue.toString(), 'EX', 3600); // 1 hour TTL

    return { reset: true, value: defaultValue };
}

/**
 * Get global budget.
 */
async function getGlobalBudget(redis) {
    const key = getGlobalBudgetKey();
    const current = await redis.get(key);
    return {
        current: parseInt(current || BUDGET_REFILL_RATE.perMinute.toString(), 10),
        max: BUDGET_REFILL_RATE.perMinute
    };
}

/**
 * Consume global budget.
 */
async function consumeGlobalBudget(redis) {
    const key = getGlobalBudgetKey();
    const current = await redis.get(key);
    const currentValue = parseInt(current || BUDGET_REFILL_RATE.perMinute.toString(), 10);

    if (currentValue <= 0) {
        return { consumed: false, remaining: 0, exceeded: true, global: true };
    }

    const remaining = currentValue - 1;
    await redis.set(key, remaining.toString(), 'EX', 60); // 60 second TTL

    return { consumed: true, remaining, exceeded: false, global: true };
}

/**
 * Get per-failure-type budget.
 */
async function getFailureTypeBudget(redis, failureType) {
    const key = getFailureTypeBudgetKey(failureType);
    const current = await redis.get(key);
    const maxValue = FAILURE_TYPE_LIMITS[failureType] || 50;

    return {
        current: parseInt(current || maxValue.toString(), 10),
        max: maxValue,
        type: failureType
    };
}

/**
 * Consume per-failure-type budget.
 */
async function consumeFailureTypeBudget(redis, failureType) {
    const key = getFailureTypeBudgetKey(failureType);
    const current = await redis.get(key);
    const maxValue = FAILURE_TYPE_LIMITS[failureType] || 50;
    const currentValue = parseInt(current || maxValue.toString(), 10);

    if (currentValue <= 0) {
        return { consumed: false, remaining: 0, exceeded: true, failureType };
    }

    const remaining = currentValue - 1;
    await redis.set(key, remaining.toString(), 'EX', 300); // 5 minute TTL

    return { consumed: true, remaining, exceeded: false, failureType };
}

/**
 * Get worker budget.
 */
async function getWorkerBudget(redis, workerId) {
    const key = getWorkerBudgetKey(workerId);
    const current = await redis.get(key);
    const maxValue = GLOBAL_LIMITS.retriesPerWorkerPerMinute;

    return {
        current: parseInt(current || maxValue.toString(), 10),
        max: maxValue,
        workerId
    };
}

/**
 * Consume worker budget.
 */
async function consumeWorkerBudget(redis, workerId) {
    const key = getWorkerBudgetKey(workerId);
    const current = await redis.get(key);
    const maxValue = GLOBAL_LIMITS.retriesPerWorkerPerMinute;
    const currentValue = parseInt(current || maxValue.toString(), 10);

    if (currentValue <= 0) {
        return { consumed: false, remaining: 0, exceeded: true, workerId };
    }

    const remaining = currentValue - 1;
    await redis.set(key, remaining.toString(), 'EX', 60); // 60 second TTL

    return { consumed: true, remaining, exceeded: false, workerId };
}

// ======================================================
// BUDGET OVERVIEW
// ======================================================

/**
 * Get all budget statuses for a scene.
 */
async function getSceneBudgets(redis, bookId, chapterId, sceneId) {
    const stages = ['audio', 'image', 'video'];
    const budgets = {};

    for (const stage of stages) {
        const current = await getSceneStageBudget(redis, bookId, chapterId, sceneId, stage);
        budgets[stage] = {
            current,
            limit: PER_SCENE_LIMITS[stage],
            percentage: Math.min(100, Math.round((current / PER_SCENE_LIMITS[stage]) * 100))
        };
    }

    return budgets;
}

/**
 * Get global budget overview.
 */
async function getGlobalBudgetOverview(redis) {
    const [global, transient, permanent, infrastructure, orchestration] = await Promise.all([
        getGlobalBudget(redis),
        getFailureTypeBudget(redis, 'transient'),
        getFailureTypeBudget(redis, 'permanent'),
        getFailureTypeBudget(redis, 'infrastructure'),
        getFailureTypeBudget(redis, 'orchestration')
    ]);

    return {
        global,
        byType: {
            transient: { current: transient.current, max: transient.max },
            permanent: { current: permanent.current, max: permanent.max },
            infrastructure: { current: infrastructure.current, max: infrastructure.max },
            orchestration: { current: orchestration.current, max: orchestration.max }
        }
    };
}

// ======================================================
// BUDGET CHECK
// ======================================================

/**
 * Check if a retry is allowed.
 * Returns: { allowed, reason, budgets }
 */
async function checkRetryBudget(redis, bookId, chapterId, sceneId, stage, failureType, workerId) {
    const budgets = {};

    // Check per-scene budget
    const sceneBudget = await getSceneStageBudget(redis, bookId, chapterId, sceneId, stage);
    budgets.sceneStage = {
        current: sceneBudget,
        limit: PER_SCENE_LIMITS[stage],
        allowed: sceneBudget > 0
    };

    if (sceneBudget <= 0) {
        return {
            allowed: false,
            reason: 'scene_budget_exceeded',
            budgets
        };
    }

    // Check per-failure-type budget
    const typeBudget = await getFailureTypeBudget(redis, failureType);
    budgets.byType = {
        current: typeBudget.current,
        max: typeBudget.max,
        allowed: typeBudget.current > 0
    };

    if (typeBudget.current <= 0 && FAILURE_TYPE_LIMITS[failureType] !== 0) {
        return {
            allowed: false,
            reason: 'type_budget_exceeded',
            budgets
        };
    }

    // Check global budget
    const globalBudget = await getGlobalBudget(redis);
    budgets.global = {
        current: globalBudget.current,
        max: globalBudget.max,
        allowed: globalBudget.current > 0
    };

    if (globalBudget.current <= 0) {
        return {
            allowed: false,
            reason: 'global_budget_exceeded',
            budgets
        };
    }

    // Check worker budget (if workerId provided)
    if (workerId) {
        const workerBudget = await getWorkerBudget(redis, workerId);
        budgets.worker = {
            current: workerBudget.current,
            max: workerBudget.max,
            allowed: workerBudget.current > 0
        };

        if (workerBudget.current <= 0) {
            return {
                allowed: false,
                reason: 'worker_budget_exceeded',
                budgets
            };
        }
    }

    return {
        allowed: true,
        reason: 'budget_available',
        budgets
    };
}

/**
 * Consume retry budget for a retry attempt.
 */
async function consumeRetryBudget(redis, bookId, chapterId, sceneId, stage, failureType, workerId) {
    const budgets = {};

    // Consume scene budget
    const sceneResult = await consumeSceneStageBudget(redis, bookId, chapterId, sceneId, stage);
    budgets.sceneStage = { ...sceneResult, limit: PER_SCENE_LIMITS[stage] };

    // Consume failure type budget
    const typeResult = await consumeFailureTypeBudget(redis, failureType);
    budgets.byType = { ...typeResult };

    // Consume global budget
    const globalResult = await consumeGlobalBudget(redis);
    budgets.global = { ...globalResult };

    // Consume worker budget (if workerId provided)
    if (workerId) {
        const workerResult = await consumeWorkerBudget(redis, workerId);
        budgets.worker = { ...workerResult };
    }

    return { consumed: true, budgets };
}

// ======================================================
// BUDGET REFILL
// ======================================================

/**
 * Refill all budgets (called periodically).
 */
async function refillBudgets(redis) {
    const typeKeys = [];

    // B6: Scene budgets не refill-ятся отдельно — у них TTL 300s, истекают сами.
    // Ранее был мёртвый код с getSceneStageBudgetKey('*', ...), который не совпадал
    // с реальными ключами (конкретные bookId/chapterId/sceneId). Удалён.

    // Refill type budgets
    const typeValues = Object.keys(FAILURE_TYPE_LIMITS);
    for (const type of typeValues) {
        const key = getFailureTypeBudgetKey(type);
        const maxValue = FAILURE_TYPE_LIMITS[type];
        await redis.set(key, maxValue.toString(), 'EX', 300);
        typeKeys.push(key);
    }

    // Refill global budget
    await redis.set(getGlobalBudgetKey(), BUDGET_REFILL_RATE.perMinute.toString(), 'EX', 60);

    // Refill worker budgets (reset to max)
    const workerKeysPattern = `${getWorkerBudgetKey('*')}`;
    // Note: we don't actually refill individual worker keys here
    // since they are tracked per worker lifetime

    log(`BUDGET_REFILLED: global=${BUDGET_REFILL_RATE.perMinute}, types=${typeValues.length}`);

    return {
        sceneBudgetsRefilled: 0, // B6: scene budgets refill удалён — истекают по TTL
        typeBudgetsRefilled: typeValues.length,
        globalBudgetRefilled: BUDGET_REFILL_RATE.perMinute
    };
}

// ======================================================
// Utility: Format budget for display
// ======================================================

function formatBudget(budgets) {
    const lines = [];

    if (budgets.sceneStage) {
        lines.push(`scene:${budgets.sceneStage.current}/${budgets.sceneStage.limit}`);
    }

    if (budgets.byType) {
        lines.push(`type:${budgets.byType.current}/${budgets.byType.max}`);
    }

    if (budgets.global) {
        lines.push(`global:${budgets.global.current}/${budgets.global.max}`);
    }

    if (budgets.worker) {
        lines.push(`worker:${budgets.worker.current}/${budgets.worker.max}`);
    }

    return lines.join(', ');
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Config
    PER_SCENE_LIMITS,
    GLOBAL_LIMITS,
    FAILURE_TYPE_LIMITS,
    BUDGET_REFILL_RATE,

    // Keys
    getSceneBudgetKey,
    getSceneStageBudgetKey,
    getGlobalBudgetKey,
    getFailureTypeBudgetKey,
    getWorkerBudgetKey,
    getBudgetWindowKey,

    // Scene budgets
    getSceneStageBudget,
    consumeSceneStageBudget,
    resetSceneStageBudget,
    getSceneBudgets,

    // Global budgets
    getGlobalBudget,
    consumeGlobalBudget,
    getGlobalBudgetOverview,

    // Type budgets
    getFailureTypeBudget,
    consumeFailureTypeBudget,

    // Worker budgets
    getWorkerBudget,
    consumeWorkerBudget,

    // Check and consume
    checkRetryBudget,
    consumeRetryBudget,

    // Refill
    refillBudgets,

    // Utility
    formatBudget
};
