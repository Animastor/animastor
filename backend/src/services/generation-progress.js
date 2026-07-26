// Independent generation task registry.
//
// Every user command gets its own task id, worker type, scope, and exact scene
// targets. This is intentionally separate from book-wide layer preferences:
// multiple Audio/Image/Video commands can coexist without overwriting state.

const { randomUUID } = require('crypto');

const KEY_PREFIX = 'animastor:generation-progress';
const TTL_SECONDS = 4 * 60 * 60;
const TERMINAL_RETENTION_MS = 30 * 1000;
const WORKER_TYPES = new Set(['audio', 'image', 'video']);

function key(bookId) {
    return `${KEY_PREFIX}:${bookId}`;
}

function taskId(type) {
    return `generation-${type}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function normalizeScope(scope) {
    return {
        scope: scope?.scope || 'whole_book',
        chapter_id: scope?.chapterId || scope?.chapter_id || null,
        scene_id: scope?.sceneId || scope?.scene_id || null,
    };
}

function targetsForType(dirtyScenes, type) {
    const unique = new Map();
    for (const scene of dirtyScenes || []) {
        if (!scene?.chapter_id || !scene?.scene_id) continue;
        if (Array.isArray(scene.dirty_layers) && !scene.dirty_layers.includes(type)) continue;
        const sceneKey = `${scene.chapter_id}:${scene.scene_id}`;
        unique.set(sceneKey, {
            chapter_id: scene.chapter_id,
            scene_id: scene.scene_id,
        });
    }
    return [...unique.values()];
}

async function writeTask(redis, bookId, task) {
    await redis.hset(key(bookId), task.task_id, JSON.stringify(task));
    await redis.expire(key(bookId), TTL_SECONDS);
    return task;
}

async function createTasks(redis, bookId, workerTypes, scope, dirtyScenes) {
    if (!redis || !bookId) return [];

    const selectedScope = normalizeScope(scope);
    const created = [];
    for (const type of [...new Set(workerTypes || [])]) {
        if (!WORKER_TYPES.has(type)) continue;
        const targets = targetsForType(dirtyScenes, type);
        if (targets.length === 0) continue;

        const task = {
            task_id: taskId(type),
            type,
            status: 'active',
            ...selectedScope,
            targets,
            started_at: Date.now(),
            completed_at: null,
            cancelled_at: null,
        };
        await writeTask(redis, bookId, task);
        created.push(task);
    }
    return created;
}

async function listTasks(redis, bookId) {
    if (!redis || !bookId) return [];
    const raw = await redis.hgetall(key(bookId));
    const tasks = [];
    const expiredIds = [];
    const now = Date.now();

    for (const [id, value] of Object.entries(raw || {})) {
        try {
            const task = JSON.parse(value);
            if (!task.task_id) task.task_id = id;
            if (!WORKER_TYPES.has(task.type) || !Array.isArray(task.targets)) {
                expiredIds.push(id);
                continue;
            }
            const terminalAt = task.completed_at || task.cancelled_at;
            if (terminalAt && now - terminalAt >= TERMINAL_RETENTION_MS) {
                expiredIds.push(id);
                continue;
            }
            tasks.push(task);
        } catch (_) {
            expiredIds.push(id);
        }
    }

    for (const id of expiredIds) {
        await redis.hdel(key(bookId), id);
    }

    return tasks.sort((a, b) => (a.started_at || 0) - (b.started_at || 0));
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
    const tasks = await listTasks(redis, bookId);
    const matching = tasks.filter(task =>
        (task.targets || []).some(target =>
            target.chapter_id === chapterId && target.scene_id === sceneId
        )
    );
    return {
        managed: matching.length > 0,
        activeTypes: new Set(
            matching
                .filter(task => task.status === 'active')
                .map(task => task.type)
        ),
    };
}

async function hasActiveTasks(redis, bookId) {
    return (await listTasks(redis, bookId)).some(task => task.status === 'active');
}

async function getActiveTasksByType(redis, bookId, type) {
    return (await listTasks(redis, bookId))
        .filter(task => task.status === 'active' && task.type === type);
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
