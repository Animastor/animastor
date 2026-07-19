// ======================================================
// RETRY BUDGET MANAGER (MINIMAL)
// ======================================================
// S1.3 (2026-07-19): сокращён с 520 до ~140 строк.
// Удалены: refillBudgets (мёртвый wildcard-код, Б6), formatBudget,
// getGlobalBudgetOverview, getSceneBudgets (read-only debug), resetSceneStageBudget,
// избыточные export'ы.
//
// Production usage (dispatch-engine.js):
//   checkRetryBudget()  — перед dispatch'ем, решает можно ли попробовать
//   consumeRetryBudget() — после finalizeDispatch('failure')
//
// Логика: per-(scene,stage) budget → 0 = stop retry.
// Глобальный, по-worker, по-type — оставлены как soft caps (TTL, без сложных policies).
// Этого достаточно для 1–15 concurrent пользователей (см. CAPACITY_AND_COMPLEXITY.md).

const logPrefix = '[RETRY-BUDGET]';
function log(msg) { console.log(`${logPrefix} ${msg}`); }

// ======================================================
// CONFIGURATION
// ======================================================

const PER_SCENE_LIMITS = { audio: 10, image: 10, video: 5 };
const GLOBAL_LIMITS = { retriesPerMinute: 100, retriesPerWorkerPerMinute: 20 };
const FAILURE_TYPE_LIMITS = { transient: 50, permanent: 0, infrastructure: 30, orchestration: 20 };

// ======================================================
// KEYS
// ======================================================

function getSceneStageBudgetKey(bookId, chapterId, sceneId, stage) {
    return `animastor:retry-budget:${bookId}:${chapterId}:${sceneId}:${stage}`;
}

function getGlobalBudgetKey() {
    return 'animastor:retry-budget:global';
}

function getFailureTypeBudgetKey(failureType) {
    return `animastor:retry-budget:type:${failureType}`;
}

function getWorkerBudgetKey(workerId) {
    return `animastor:retry-budget:worker:${workerId}`;
}

// ======================================================
// BUDGET GETTERS (read current budget value)
// ======================================================

async function getSceneStageBudget(redis, bookId, chapterId, sceneId, stage) {
    const key = getSceneStageBudgetKey(bookId, chapterId, sceneId, stage);
    const current = await redis.get(key);
    const defaultValue = PER_SCENE_LIMITS[stage] || 10;
    return parseInt(current || String(defaultValue), 10);
}

async function getGlobalBudget(redis) {
    const key = getGlobalBudgetKey();
    const current = await redis.get(key);
    return {
        current: parseInt(current || String(GLOBAL_LIMITS.retriesPerMinute), 10),
        max: GLOBAL_LIMITS.retriesPerMinute
    };
}

async function getFailureTypeBudget(redis, failureType) {
    const key = getFailureTypeBudgetKey(failureType);
    const current = await redis.get(key);
    const maxValue = FAILURE_TYPE_LIMITS[failureType] || 50;
    return {
        current: parseInt(current || String(maxValue), 10),
        max: maxValue,
        type: failureType
    };
}

async function getWorkerBudget(redis, workerId) {
    const key = getWorkerBudgetKey(workerId);
    const current = await redis.get(key);
    const maxValue = GLOBAL_LIMITS.retriesPerWorkerPerMinute;
    return {
        current: parseInt(current || String(maxValue), 10),
        max: maxValue,
        workerId
    };
}

// ======================================================
// BUDGET CONSUMERS (atomic decrement)
// ======================================================

async function consumeSceneStageBudget(redis, bookId, chapterId, sceneId, stage) {
    const key = getSceneStageBudgetKey(bookId, chapterId, sceneId, stage);
    const current = await redis.get(key);
    const value = parseInt(current || String(PER_SCENE_LIMITS[stage] || 10), 10);

    if (value <= 0) {
        return { consumed: false, remaining: 0, exceeded: true };
    }

    const remaining = value - 1;
    await redis.set(key, remaining.toString());
    log(`BUDGET_CONSUMED: ${bookId}/${chapterId}/${sceneId}:${stage} (remaining: ${remaining})`);
    return { consumed: true, remaining, exceeded: false };
}

async function consumeGlobalBudget(redis) {
    const key = getGlobalBudgetKey();
    const current = await redis.get(key);
    const currentValue = parseInt(current || String(GLOBAL_LIMITS.retriesPerMinute), 10);

    if (currentValue <= 0) {
        return { consumed: false, remaining: 0, exceeded: true, global: true };
    }

    const remaining = currentValue - 1;
    await redis.set(key, remaining.toString(), 'EX', 60);
    return { consumed: true, remaining, exceeded: false, global: true };
}

async function consumeFailureTypeBudget(redis, failureType) {
    const key = getFailureTypeBudgetKey(failureType);
    const current = await redis.get(key);
    const maxValue = FAILURE_TYPE_LIMITS[failureType] || 50;
    const currentValue = parseInt(current || String(maxValue), 10);

    if (currentValue <= 0) {
        return { consumed: false, remaining: 0, exceeded: true, failureType };
    }

    const remaining = currentValue - 1;
    await redis.set(key, remaining.toString(), 'EX', 300);
    return { consumed: true, remaining, exceeded: false, failureType };
}

async function consumeWorkerBudget(redis, workerId) {
    if (!workerId) return { consumed: true, skipped: true };
    const key = getWorkerBudgetKey(workerId);
    const current = await redis.get(key);
    const maxValue = GLOBAL_LIMITS.retriesPerWorkerPerMinute;
    const currentValue = parseInt(current || String(maxValue), 10);

    if (currentValue <= 0) {
        return { consumed: false, remaining: 0, exceeded: true, workerId };
    }

    const remaining = currentValue - 1;
    await redis.set(key, remaining.toString(), 'EX', 60);
    return { consumed: true, remaining, exceeded: false, workerId };
}

// ======================================================
// CHECK + CONSUME (production API)
// ======================================================

/**
 * Check if a retry is allowed before dispatching.
 * Returns: { allowed, reason, budgets }
 *
 * Order: scene → failureType → global → worker. First exhausted wins.
 */
async function checkRetryBudget(redis, bookId, chapterId, sceneId, stage, failureType, workerId) {
    const sceneBudget = await getSceneStageBudget(redis, bookId, chapterId, sceneId, stage);
    const budgets = {
        sceneStage: { current: sceneBudget, limit: PER_SCENE_LIMITS[stage], allowed: sceneBudget > 0 }
    };

    if (sceneBudget <= 0) {
        return { allowed: false, reason: 'scene_budget_exceeded', budgets };
    }

    const typeBudget = await getFailureTypeBudget(redis, failureType);
    budgets.byType = { current: typeBudget.current, max: typeBudget.max, allowed: typeBudget.current > 0 };
    if (typeBudget.current <= 0 && FAILURE_TYPE_LIMITS[failureType] !== 0) {
        return { allowed: false, reason: 'type_budget_exceeded', budgets };
    }

    const globalBudget = await getGlobalBudget(redis);
    budgets.global = { current: globalBudget.current, max: globalBudget.max, allowed: globalBudget.current > 0 };
    if (globalBudget.current <= 0) {
        return { allowed: false, reason: 'global_budget_exceeded', budgets };
    }

    if (workerId) {
        const workerBudget = await getWorkerBudget(redis, workerId);
        budgets.worker = { current: workerBudget.current, max: workerBudget.max, allowed: workerBudget.current > 0 };
        if (workerBudget.current <= 0) {
            return { allowed: false, reason: 'worker_budget_exceeded', budgets };
        }
    }

    return { allowed: true, reason: 'budget_available', budgets };
}

/**
 * Consume retry budget after a failed dispatch finalization (called once per failure).
 * Returns: { consumed, budgets }
 */
async function consumeRetryBudget(redis, bookId, chapterId, sceneId, stage, failureType, workerId) {
    const budgets = {
        sceneStage: { ...await consumeSceneStageBudget(redis, bookId, chapterId, sceneId, stage), limit: PER_SCENE_LIMITS[stage] },
        byType: await consumeFailureTypeBudget(redis, failureType),
        global: await consumeGlobalBudget(redis),
        worker: await consumeWorkerBudget(redis, workerId)
    };
    return { consumed: true, budgets };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Config (для диагностики)
    PER_SCENE_LIMITS,
    GLOBAL_LIMITS,
    FAILURE_TYPE_LIMITS,

    // Production API
    checkRetryBudget,
    consumeRetryBudget
};
