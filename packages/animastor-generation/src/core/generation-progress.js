// ======================================================
// Independent generation task registry — PURE core (S-4 correction)
// ======================================================
// Every user command gets its own task id, worker type, scope, and exact scene
// targets. This is intentionally separate from book-wide layer preferences:
// multiple Audio/Image/Video commands can coexist without overwriting state.
//
// This module is the pure task-registry DOMAIN logic: task ids, scope/target
// normalization, task-record creation, task-map validation with terminal
// retention, and registry queries over task lists. It knows NOTHING about
// Redis — no client calls, no key namespaces. The Redis persistence lives in
// the host adapter: services/generation-progress.js (formalized as a port in
// S-6).

const { randomUUID } = require('crypto');

// S-2 COMPLETION: WORKER_TYPES always resolved from registry (no hardcoded fallback)
const { resolveValidWorkerTypes } = require('./media-registry');
const WORKER_TYPES = resolveValidWorkerTypes();

// Terminal tasks are retained this long so cancel/complete observers can still
// see the final state before the record is dropped from the registry.
const TERMINAL_RETENTION_MS = 30 * 1000;

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

/** Build one active task record (pure). */
function buildTask(type, selectedScope, targets) {
    return {
        task_id: taskId(type),
        type,
        status: 'active',
        ...selectedScope,
        targets,
        started_at: Date.now(),
        completed_at: null,
        cancelled_at: null,
    };
}

/**
 * Pure creation pass: task records for the selected worker types/scope.
 * Unknown worker types and types without targets are skipped (same
 * semantics as the previous inline createTasks loop).
 */
function createTaskRecords(workerTypes, scope, dirtyScenes) {
    const selectedScope = normalizeScope(scope);
    const created = [];
    for (const type of [...new Set(workerTypes || [])]) {
        if (!WORKER_TYPES.has(type)) continue;
        const targets = targetsForType(dirtyScenes, type);
        if (targets.length === 0) continue;
        created.push(buildTask(type, selectedScope, targets));
    }
    return created;
}

/**
 * Validate/filter a raw task map (id -> serialized task record).
 * Returns the live tasks sorted by start time plus the ids that must be
 * dropped from the store: unknown worker type, malformed record, or terminal
 * tasks past the retention window.
 */
function filterTaskMap(raw, now = Date.now()) {
    const tasks = [];
    const expiredIds = [];

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

    tasks.sort((a, b) => (a.started_at || 0) - (b.started_at || 0));
    return { tasks, expiredIds };
}

/** Registry query: task state scoped to one scene. */
function sceneTaskState(tasks, chapterId, sceneId) {
    const matching = (tasks || []).filter(task =>
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

/** Registry query: any active task? */
function hasActiveTasks(tasks) {
    return (tasks || []).some(task => task.status === 'active');
}

/** Registry query: active tasks of one worker type. */
function activeTasksByType(tasks, type) {
    return (tasks || []).filter(task => task.status === 'active' && task.type === type);
}

module.exports = {
    WORKER_TYPES,
    TERMINAL_RETENTION_MS,
    taskId,
    normalizeScope,
    targetsForType,
    buildTask,
    createTaskRecords,
    filterTaskMap,
    sceneTaskState,
    hasActiveTasks,
    activeTasksByType,
};
