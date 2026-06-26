// ======================================================
// ORCHESTRATOR — единый владелец жизненного цикла генерации
// ======================================================
// Шаг 0 (см. docs-claude/03_Orchestrator.md §12): тонкий фасад поверх уже
// существующих функций. На этом шаге команды НИЧЕГО не меняют в логике —
// только дают единую точку входа, через которую постепенно (по одному
// вызывающему за коммит) будут проходить все писатели lifecycle-состояния.
//
// Контракт пяти команд (цели последующих шагов в скобках):
//   markDirty(deps, redis, bookId, buildId, dirtyScenes, layerCfg) → { marked }
//   planScene(redis, bookId, chapterId, sceneId)        → { stages, allDone }   (Д.2: сделать чистой)
//   beginStage(redis, scene, loadedBook, buildId, stage) → dispatchResult       (Д.1: GENERATING уже есть)
//   completeStage(redis, bookId, chapterId, sceneId, stage, buildId) → void     (Д.1: idempotent по token)
//   reconcile(redis, bookId, chapterId, sceneId)        → reconcileResult        (Д.3: диск как факт)
//
// Зависимости подтягиваются lazy-require внутри тел команд — это сознательный
// компромисс Шага 0, чтобы не углубить существующий цикл orchestration↔runtime
// (dispatch-engine уже делает require('../orchestration') внутри функции).
// Развязка интерфейсом — отдельная задача (после К.4).

// ── markDirty ─────────────────────────────────────────
// Единственный способ объявить «нужна регенерация». Делегирует в
// deps.bookDiff.markDirtyScenes — это метод DI-инстанса (book-diff.cjs —
// фабрика), поэтому инстанс приходит через deps, а не через require.
async function markDirty(deps, redis, bookId, buildId, dirtyScenes, layerCfg) {
    if (!deps || !deps.bookDiff || typeof deps.bookDiff.markDirtyScenes !== 'function') {
        throw new Error('orchestrator.markDirty: deps.bookDiff.markDirtyScenes is required');
    }
    return deps.bookDiff.markDirtyScenes(redis, bookId, buildId, dirtyScenes, layerCfg);
}

// ── planScene ─────────────────────────────────────────
// Решение «что генерировать». Делегирует в shouldScheduleAssets.
// ЦЕЛЬ Д.2: сделать чистой (убрать побочную version-stale запись).
async function planScene(redis, bookId, chapterId, sceneId) {
    const scheduler = require('../runtime/runtime-scheduler');
    return scheduler.shouldScheduleAssets(redis, bookId, chapterId, sceneId);
}

// ── beginStage ────────────────────────────────────────
// Старт стадии: lease + quota + per-asset GENERATING. Делегирует в
// dispatch-engine.dispatchStage (который сам зовёт назад orchestration.dispatchStage
// для исполнения генерации).
async function beginStage(redis, scene, loadedBook, buildId, stage) {
    const dispatchEngine = require('../runtime/dispatch-engine');
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;
    return dispatchEngine.dispatchStage(redis, bookId, chapterId, sceneId, stage, loadedBook, buildId);
}

// ── completeStage ─────────────────────────────────────
// Завершение стадии: колбэк завершения + release lease/quota (markDispatchCompleted),
// в той же error-safe связке (try/finally), что сейчас повторена в task-handler.cjs
// в шести местах. Фасад даёт ОДНУ реализацию этой пары.
// ЦЕЛЬ Д.1: идемпотентность по dispatch-token (повторный вызов безвреден).
async function completeStage(redis, bookId, chapterId, sceneId, stage, buildId) {
    const callbacks = require('./scene-callbacks');
    const dispatchEngine = require('../runtime/dispatch-engine');

    const handler = {
        audio: callbacks.handleAudioCompleted,
        image: callbacks.handleImageCompleted,
        video: callbacks.handleVideoCompleted,
    }[stage];

    if (!handler) {
        throw new Error(`orchestrator.completeStage: unknown stage '${stage}'`);
    }

    try {
        await handler(redis, bookId, chapterId, sceneId, buildId);
    } finally {
        // Always release lease+quota even if the callback throws — single owner
        // of release (C1). Wrapped so a release error never masks a callback error.
        try {
            await dispatchEngine.markDispatchCompleted(redis, bookId, chapterId, sceneId, stage);
        } catch (dispErr) {
            const { warn } = require('./scene-utils');
            warn(`completeStage: markDispatchCompleted(${stage}) failed: ${dispErr.message}`);
        }
    }
}

// ── reconcile ─────────────────────────────────────────
// Сверка фактов (PG/диск) с состоянием. Делегирует в reconciliation-engine.
// ЦЕЛЬ Д.3: диск становится источником ФАКТА, решение принимает фасад.
async function reconcile(redis, bookId, chapterId, sceneId) {
    const reconciliationEngine = require('../runtime/reconciliation-engine');
    return reconciliationEngine.reconcileScene(redis, bookId, chapterId, sceneId);
}

module.exports = {
    markDirty,
    planScene,
    beginStage,
    completeStage,
    reconcile,
};
