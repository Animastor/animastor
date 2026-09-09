// ======================================================
// Independent generation task registry — host Redis adapter (S-4 correction)
// ======================================================
// The pure task-registry domain logic (task ids, scope/target normalization,
// record creation, task-map validation/retention, registry queries) lives in
// the Generation core: generation/generation-progress.js.
//
// THIS module is the host/infrastructure adapter: it owns the Redis key
// namespace (`animastor:generation-progress:*`) and implements the registry
// persistence (HSET/HGET/HGETALL/HDEL/DEL/EXPIRE) over the redis client
// injected by the callers. Redis keys, TTLs, lifecycle/progress behavior and
// the public API are unchanged (S-6 will formalize this seam as a port).

const core = require('../generation/generation-progress');

const KEY_PREFIX = 'animastor:generation-progress';
const TTL_SECONDS = 4 * 60 * 60;
const TERMINAL_RETENTION_MS = core.TERMINAL_RETENTION_MS;

function key(bookId) {
    return `${KEY_PREFIX}:${bookId}`;
}

async function writeTask(redis, bookId, task) {
    await redis.hset(key(bookId), task.task_id, JSON.stringify(task));
    await redis.expire(key(bookId), TTL_SECONDS);
    return task;
}

async function createTasks(redis, bookId, workerTypes, scope, dirtyScenes) {
    if (!redis || !bookId) return [];
    const created = core.createTaskRecords(workerTypes, scope, dirtyScenes);
    for (const task of created) {
        await writeTask(redis, bookId, task);
    }
    return created;
}

async function listTasks(redis, bookId) {
    if (!redis || !bookId) return [];
    const raw = await redis.hgetall(key(bookId));
    const { tasks, expiredIds } = core.filterTaskMap(raw);
    for (const id of expiredIds) {
        await redis.hdel(key(bookId), id);
    }
    return tasks;
}

async function getTask(redis, bookId, id) {
    if (!redis || !bookId || !id) return null;
    const raw = await redis.hget(key(bookId), id);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (_) {
        await redis.hdel(key(bookId), id);
        return null;
    }
}

async function updateTask(redis, bookId, id, updates) {
    const task = await getTask(redis, bookId, id);
    if (!task) return null;
    return writeTask(redis, bookId, { ...task, ...updates, task_id: task.task_id || id });
}

async function markCompleted(redis, bookId, id) {
    const task = await getTask(redis, bookId, id);
    if (!task || task.status !== 'active') return task;
    return updateTask(redis, bookId, id, {
        status: 'completed',
        completed_at: Date.now(),
    });
}

async function markCancelled(redis, bookId, id) {
    const task = await getTask(redis, bookId, id);
    if (!task || task.status === 'cancelled') return task;
    return updateTask(redis, bookId, id, {
        status: 'cancelled',
        cancelled_at: Date.now(),
    });
}

async function getSceneTaskState(redis, bookId, chapterId, sceneId) {
    return core.sceneTaskState(await listTasks(redis, bookId), chapterId, sceneId);
}

async function hasActiveTasks(redis, bookId) {
    return core.hasActiveTasks(await listTasks(redis, bookId));
}

async function getActiveTasksByType(redis, bookId, type) {
    return core.activeTasksByType(await listTasks(redis, bookId), type);
}

async function reconcileCompletedTasks(redis, bookId, getAssetStates) {
    if (typeof getAssetStates !== 'function') return [];

    const tasks = (await listTasks(redis, bookId))
        .filter(task => task.status === 'active' && (task.targets || []).length > 0);
    const stateCache = new Map();
    const completed = [];

    for (const task of tasks) {
        let allReady = true;
        for (const target of task.targets) {
            const targetKey = `${target.chapter_id}:${target.scene_id}`;
            let assetStates = stateCache.get(targetKey);
            if (!assetStates) {
                assetStates = await getAssetStates(
                    redis,
                    bookId,
                    target.chapter_id,
                    target.scene_id
                );
                stateCache.set(targetKey, assetStates);
            }
            if (assetStates?.[task.type] !== 'ready') {
                allReady = false;
                break;
            }
        }
        if (!allReady) continue;

        const updated = await markCompleted(redis, bookId, task.task_id);
        if (updated?.status === 'completed') completed.push(updated);
    }

    return completed;
}

async function removeTask(redis, bookId, id) {
    if (!redis || !bookId || !id) return;
    await redis.hdel(key(bookId), id);
}

async function clear(redis, bookId) {
    if (!redis || !bookId) return;
    await redis.del(key(bookId));
}

module.exports = {
    KEY_PREFIX,
    TTL_SECONDS,
    TERMINAL_RETENTION_MS,
    key,
    createTasks,
    listTasks,
    getTask,
    updateTask,
    markCompleted,
    markCancelled,
    getSceneTaskState,
    hasActiveTasks,
    getActiveTasksByType,
    reconcileCompletedTasks,
    removeTask,
    clear,
};
