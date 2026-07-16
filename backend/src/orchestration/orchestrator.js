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
// Решение «что генерировать». Делегирует в shouldScheduleAssets — теперь это
// ЧИСТАЯ функция (Д.2): только читает per-asset состояния и layer-config, ничего
// не пишет. Version-stale reset вынесен в явный пред-проход attemptDispatch
// (detectVersionStale → markVersionStaleDirty).
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
    const state = require('../state');
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;
    const result = await dispatchEngine.dispatchStage(redis, bookId, chapterId, sceneId, stage, loadedBook, buildId);
    // M5 Шаг 3: syncLinearState — автоматически после dispatchStage (который выставляет PENDING/GENERATING).
    // dispatchStage вызывает scene-orchestrator.dispatchStage → executeAudio/Image/VideoDispatch,
    // которые больше не вызывают syncLinearState сами — это делает beginStage.
    await state.syncLinearState(redis, bookId, chapterId, sceneId);
    return result;
}

// ── completeStage ─────────────────────────────────────
// Завершение стадии: колбэк завершения + release lease/quota (markDispatchCompleted),
// в той же error-safe связке (try/finally), что сейчас повторена в task-handler.cjs
// в шести местах. Фасад даёт ОДНУ реализацию этой пары.
// ЦЕЛЬ Д.1: идемпотентность по dispatch-token (повторный вызов безвреден).
async function completeStage(redis, bookId, chapterId, sceneId, stage, buildId) {
    const callbacks = require('./scene-callbacks');
    const dispatchEngine = require('../runtime/dispatch-engine');
    const state = require('../state');
    const { log, warn } = require('./scene-utils');

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

        // M5 Шаг 5: Version gate — проверяем PG версию перед READY.
        // Если asset_version < scene_version, пишем DIRTY вместо READY,
        // чтобы stale GPU callback не отменял force-regen.
        // Graceful fallback: если PG недоступен, пропускаем gate (log warning).
        let shouldWriteReady = true;
        try {
            const { query: pgQuery } = require('../storage/postgres/database');
            const sceneAssetsRepo = require('../storage/postgres/repositories/scene-assets-repo');

            const sceneResult = await pgQuery(`
                SELECT content_version, audio_config_version FROM scenes
                WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
            `, [bookId, chapterId, sceneId]);

            if (sceneResult.rows.length > 0) {
                const sv = sceneResult.rows[0];
                const asset = await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, stage, buildId)
                    || await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, stage);

                if (asset) {
                    if (asset.scene_content_version != null && sv.content_version != null &&
                        asset.scene_content_version < sv.content_version) {
                        shouldWriteReady = false;
                    }
                    if (asset.scene_audio_config_version != null && sv.audio_config_version != null &&
                        asset.scene_audio_config_version < sv.audio_config_version) {
                        shouldWriteReady = false;
                    }
                }
            }
        } catch (pgErr) {
            warn(`[VERSION-GATE] PG query failed for ${bookId}/${chapterId}/${sceneId}: ${pgErr.message} — allowing READY`);
        }

        if (shouldWriteReady) {
            await state.setAssetState(redis, bookId, chapterId, sceneId, stage, state.AssetState.READY);
            await state.syncLinearState(redis, bookId, chapterId, sceneId, buildId);
        } else {
            log(`[VERSION-GATE] ${bookId}/${chapterId}/${sceneId}: ${stage} stale — DIRTY instead of READY`);
            await state.setAssetState(redis, bookId, chapterId, sceneId, stage, state.AssetState.DIRTY);
            await state.syncLinearState(redis, bookId, chapterId, sceneId, buildId);
        }
    } finally {
        // Always release lease+quota even if the callback throws — single owner
        // of release (C1). Wrapped so a release error never masks a callback error.
        try {
            await dispatchEngine.markDispatchCompleted(redis, bookId, chapterId, sceneId, stage);
        } catch (dispErr) {
            warn(`completeStage: markDispatchCompleted(${stage}) failed: ${dispErr.message}`);
        }
    }
}

// ── failStage ─────────────────────────────────────────
// T3 консолидации: единственный способ зафиксировать «генерация упала».
// Вызывается endpoint'ом /gpu/task/error (ошибка воркера, форвард через
// gpu-hub, включая worker_timeout) и внутренними обработчиками сбоев.
// Делает: asset-state → FAILED (с валидацией перехода — поздняя ошибка
// после успешного retry не сбивает READY), событие *_FAILED в journal,
// release lease+quota через идемпотентный markDispatchCompleted.
// После FAILED (если redispatch=true, по умолчанию) ассет переводится в
// PENDING — планировщик передиспатчит на следующем тике под защитой
// circuit-breaker и retry-budget (dispatch-engine). Это зеркалит проверенный
// путь исчерпания merge-ретраев в task-handler; сам failStage retry-политику
// не содержит.
async function failStage(redis, bookId, chapterId, sceneId, stage, buildId, reason = 'unknown', { redispatch = true } = {}) {
    const state = require('../state');
    const dispatchEngine = require('../runtime/dispatch-engine');
    const journal = require('./event-journal');
    const { log, warn } = require('./scene-utils');

    const eventType = {
        audio: journal.EventType.AUDIO_FAILED,
        image: journal.EventType.IMAGE_FAILED,
        video: journal.EventType.VIDEO_FAILED,
    }[stage];
    if (!eventType) {
        throw new Error(`orchestrator.failStage: unknown stage '${stage}'`);
    }

    try {
        const states = await state.getAssetStates(redis, bookId, chapterId, sceneId);
        const current = states ? states[stage] : null;
        const check = state.validateAssetTransition(current, state.AssetState.FAILED);

        if (!check.valid) {
            // Например READY→FAILED: результат уже принят (поздний/повторный
            // сигнал ошибки) — фиксируем в журнале, состояние не трогаем.
            log(`[FAIL-STAGE] ${bookId}/${chapterId}/${sceneId}: ${stage} ${current}→failed отклонён (${check.reason}) — ignoring late error (reason=${reason})`);
            await journal.appendSceneEvent(redis, bookId, chapterId, sceneId,
                journal.EventType.INVALID_STATE_CALLBACK, current,
                { stage, reason, attempted: 'failed', ignored: true }).catch(() => {});
            return { failed: false, reason: check.reason, current };
        }

        await state.setAssetState(redis, bookId, chapterId, sceneId, stage, state.AssetState.FAILED);
        log(`[FAIL-STAGE] ${bookId}/${chapterId}/${sceneId}: ${stage} → FAILED (reason=${reason})`);
        await journal.appendSceneEvent(redis, bookId, chapterId, sceneId,
            eventType, state.AssetState.FAILED, { stage, reason, buildId }).catch(() => {});

        if (redispatch) {
            // FAILED → PENDING: планировщик передиспатчит на следующем тике.
            await state.setAssetState(redis, bookId, chapterId, sceneId, stage, state.AssetState.PENDING);
            log(`[FAIL-STAGE] ${bookId}/${chapterId}/${sceneId}: ${stage} → PENDING (re-dispatch queued)`);
        }
        await state.syncLinearState(redis, bookId, chapterId, sceneId, buildId);
        return { failed: true, reason, redispatch };
    } finally {
        // Как в completeStage: единый владелец release (C1), идемпотентно (Д.1).
        try {
            await dispatchEngine.markDispatchCompleted(redis, bookId, chapterId, sceneId, stage);
        } catch (dispErr) {
            warn(`failStage: markDispatchCompleted(${stage}) failed: ${dispErr.message}`);
        }
    }
}

// ── markDirtyScene ────────────────────────────────────
// M5: Direct per-scene DIRTY writer — единственный способ выставить
// per-asset DIRTY напрямую (без bookDiff/regen). Заменяет P4/P5/P6.
// В отличие от markDirty (который регенерирует сцену через bookDiff),
// этот метод просто маркирует assets как DIRTY, оставляя активный индекс
// scheduler'у. Разница: markDirty → for regeneration, markDirtyScene → for recovery.
async function markDirtyScene(redis, bookId, chapterId, sceneId, assets = ['audio', 'image', 'video']) {
    const state = require('../state');
    for (const asset of assets) {
        await state.setAssetState(redis, bookId, chapterId, sceneId, asset, state.AssetState.DIRTY);
    }
    // M5: syncLinearState — автоматически после setAssetState (Шаг 3 prep)
    await state.syncLinearState(redis, bookId, chapterId, sceneId);
}

// ── setScenePending ──────────────────────────────────
// Set an asset to PENDING and sync linear state.
// Used by scene-window when starting a scene.
// M5: Единственный владелец перехода в PENDING.
async function setScenePending(redis, bookId, chapterId, sceneId, asset, buildId = null) {
    const state = require('../state');
    await state.setAssetState(redis, bookId, chapterId, sceneId, asset, state.AssetState.PENDING);
    return await state.syncLinearState(redis, bookId, chapterId, sceneId, buildId);
}

// ── setSceneAllReady ─────────────────────────────────
// Set all three assets to READY and sync linear state.
// Used by scene-window when valid content found on disk (cache hit).
// M5: Единственный владелец перехода в READY для cache-попаданий.
async function setSceneAllReady(redis, bookId, chapterId, sceneId, buildId = null) {
    const state = require('../state');
    await state.setAssetStates(redis, bookId, chapterId, sceneId, {
        audio: state.AssetState.READY,
        image: state.AssetState.READY,
        video: state.AssetState.READY,
    });
    return await state.syncLinearState(redis, bookId, chapterId, sceneId, buildId);
}

// ── setScenePlaceholder ──────────────────────────────
// Set audio to PLACEHOLDER and sync linear state.
// Used by scene-window when audio is disabled by layer config.
// M5: Единственный владелец перехода в PLACEHOLDER.
async function setScenePlaceholder(redis, bookId, chapterId, sceneId, buildId = null) {
    const state = require('../state');
    await state.setAssetState(redis, bookId, chapterId, sceneId, 'audio', state.AssetState.PLACEHOLDER);
    return await state.syncLinearState(redis, bookId, chapterId, sceneId, buildId);
}

// ── completeStageWithoutVideo ────────────────────────
// When video is disabled by layer config, mark video as READY
// and complete remaining scene lifecycle (cleanup, slide).
// Callback function handles cleanup only — state is set here in the facade.
async function completeStageWithoutVideo(redis, loadedBook, bookId, chapterId, sceneId, buildId) {
    const state = require('../state');
    const callbacks = require('./scene-callbacks');
    await state.setAssetState(redis, bookId, chapterId, sceneId, 'video', state.AssetState.READY);
    await state.syncLinearState(redis, bookId, chapterId, sceneId, buildId);
    await callbacks.completeSceneWithoutVideo(redis, loadedBook, bookId, chapterId, sceneId, buildId);
}

// ── completeStageWithoutImage ─────────────────────────
// When image is disabled by layer config, mark image as READY
// and complete remaining scene lifecycle.
async function completeStageWithoutImage(redis, loadedBook, bookId, chapterId, sceneId, buildId) {
    const state = require('../state');
    const callbacks = require('./scene-callbacks');
    await state.setAssetState(redis, bookId, chapterId, sceneId, 'image', state.AssetState.READY);
    await state.syncLinearState(redis, bookId, chapterId, sceneId, buildId);
    await callbacks.completeSceneWithoutImage(redis, loadedBook, bookId, chapterId, sceneId, buildId);
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
    markDirtyScene,
    planScene,
    beginStage,
    completeStage,
    failStage,
    completeStageWithoutVideo,
    completeStageWithoutImage,
    setScenePending,
    setSceneAllReady,
    setScenePlaceholder,
    reconcile,
};
