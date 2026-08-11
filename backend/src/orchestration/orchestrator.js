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
    // T8: syncLinearState удалён — per-asset state единственный source of truth
    const result = await dispatchEngine.dispatchStage(redis, bookId, chapterId, sceneId, stage, loadedBook, buildId);
    return result;
}

// ── completeStage ─────────────────────────────────────
// Завершение стадии: колбэк завершения + release lease/quota (markDispatchCompleted),
// в той же error-safe связке (try/finally), что сейчас повторена в task-handler.cjs
// в шести местах. Фасад даёт ОДНУ реализацию этой пары.
// ЦЕЛЬ Д.1: идемпотентность по dispatch-token (повторный вызов безвреден).
//
// ======================================================
// T1: Callback completion contract
// --------------------------------------
// 1. Handler вызывается, возвращает { ok, retryable, reason, artifact }
// 2. READY/DIRTY пишется ТОЛЬКО после handler.ok === true
// 3. PG markReady вызывается ПОСЛЕ версионного gate (fail-closed)
// 4. Исключение handler → failure, не success
// 5. ok:false → НЕ ставит READY, не пишет PG
// ======================================================
async function completeStage(redis, bookId, chapterId, sceneId, stage, buildId, dispatchId) {
    const callbacks = require('./scene-callbacks');
    const dispatchEngine = require('../runtime/dispatch-engine');
    const state = require('../state');
    const { log, warn, error } = require('./scene-utils');
    const sceneAssetsRepo = require('../storage/postgres/repositories/scene-assets-repo');

    const handler = {
        audio: callbacks.handleAudioCompleted,
        image: callbacks.handleImageCompleted,
        video: callbacks.handleVideoCompleted,
    }[stage];

    if (!handler) {
        throw new Error(`orchestrator.completeStage: unknown stage '${stage}'`);
    }

    const identity = await dispatchEngine.verifyDispatchIdentity(
        redis,
        bookId,
        chapterId,
        sceneId,
        stage,
        dispatchId
    );
    if (!identity.valid) {
        warn(`[COMPLETE-STAGE] Rejected ${bookId}/${chapterId}/${sceneId} ${stage}: ${identity.reason}`);
        return { completed: false, reason: identity.reason };
    }

    let handlerResult;
    let handlerError = null;
    let handlerOk = false;  // T2: true если handler вернул ok:true

    let phaseCompleted = false;
    let phaseReason = 'handler_rejected';

    try {
        try {
            handlerResult = await handler(redis, bookId, chapterId, sceneId, buildId);
        } catch (err) {
            // T1.7: Исключение handler → failure path, не success
            handlerError = err;
            error(`completeStage: handler threw for ${bookId}/${chapterId}/${sceneId} ${stage}: ${err.message}`);
        }

        // ── Check handler result (T1.6) ────────────────────
        if (handlerError || !handlerResult || handlerResult.ok !== true) {
            const reason = handlerResult?.reason || (handlerError ? handlerError.message : 'unknown');
            phaseReason = reason;
            handlerOk = false;
            log(`[COMPLETE-STAGE] ${bookId}/${chapterId}/${sceneId} ${stage}: rejected (reason=${reason}) — NOT setting READY`);
        } else {
            handlerOk = true;

            // ── Handler succeeded — version gate (T1.11: fail-closed) ────
            let shouldWriteReady = false;
            try {
                const { query: pgQuery } = require('../storage/postgres/database');

                const sceneResult = await pgQuery(`
                    SELECT content_version, audio_config_version FROM scenes
                    WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
                `, [bookId, chapterId, sceneId]);

                if (sceneResult.rows.length === 1) {
                    const sv = sceneResult.rows[0];
                    const asset = await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, stage, buildId);

                    if (asset) {
                        const contentVersionConfirmed =
                            asset.scene_content_version != null &&
                            sv.content_version != null &&
                            asset.scene_content_version >= sv.content_version;
                        const audioVersionConfirmed =
                            stage !== 'audio' || (
                                asset.scene_audio_config_version != null &&
                                sv.audio_config_version != null &&
                                asset.scene_audio_config_version >= sv.audio_config_version
                            );
                        shouldWriteReady = contentVersionConfirmed && audioVersionConfirmed;
                    }
                }
            } catch (pgErr) {
                // T1.11: Fail-closed — ошибка PG не разрешает READY
                shouldWriteReady = false;
                warn(`[VERSION-GATE] PG query failed for ${bookId}/${chapterId}/${sceneId}: ${pgErr.message} — blocking READY (fail-closed)`);
            }

            if (shouldWriteReady) {
                // T1.10: PG markReady ПОСЛЕ version gate
                const artifactPath = handlerResult.artifact?.path;
                if (!artifactPath) {
                    handlerOk = false;
                    phaseReason = 'artifact_path_missing';
                } else {
                    await sceneAssetsRepo.markReady(bookId, chapterId, sceneId, stage, artifactPath);
                    log(`[PG-${stage.toUpperCase()}-READY] ${bookId}/${chapterId}/${sceneId}: status=ready`);

                    await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, stage, state.AssetState.READY);
                    log(`[COMPLETE-STAGE] ${bookId}/${chapterId}/${sceneId}: ${stage} → READY`);
                    phaseCompleted = true;
                    phaseReason = null;
                }
            } else {
                // T2: version gate stale — dispatch успешен, но artifact устарел.
                // Финализируем как success (диспетчеризация выполнена), просто не ставим READY.
                log(`[VERSION-GATE] ${bookId}/${chapterId}/${sceneId}: ${stage} stale — DIRTY instead of READY`);
                await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, stage, state.AssetState.DIRTY);
                phaseCompleted = false;
                phaseReason = 'stale';
                // handlerOk остаётся true — финализируем как success
            }
        }
    } catch (completionErr) {
        handlerOk = false;
        phaseCompleted = false;
        phaseReason = `completion_error:${completionErr.message}`;
        error(`completeStage failed for ${bookId}/${chapterId}/${sceneId} ${stage}: ${completionErr.message}`);
    } finally {
        // T2: finalizeDispatch — handlerOk определяет success/failure
        // Если handler вернул ok:true (handlerOk = true) — всегда success,
        // даже при version gate stale. Failure только при ok:false/error handler.
        try {
            const outcome = handlerOk ? 'success' : 'failure';
            await dispatchEngine.finalizeDispatch(redis, bookId, chapterId, sceneId, stage, {
                outcome,
                dispatchId,
                reason: handlerOk ? (phaseReason || undefined) : (phaseReason || 'handler_rejected')
            });
        } catch (dispErr) {
            warn(`completeStage: finalizeDispatch(${stage}) failed: ${dispErr.message}`);
        }
    }

    return { completed: phaseCompleted, reason: phaseReason };
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
async function failStage(redis, bookId, chapterId, sceneId, stage, buildId, reason = 'unknown', { redispatch = true, dispatchId } = {}) {
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

    const identity = await dispatchEngine.verifyDispatchIdentity(
        redis,
        bookId,
        chapterId,
        sceneId,
        stage,
        dispatchId
    );
    if (!identity.valid) {
        log(`[FAIL-STAGE] Rejected ${bookId}/${chapterId}/${sceneId} ${stage}: ${identity.reason}`);
        return { failed: false, reason: identity.reason };
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

        await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, stage, state.AssetState.FAILED);
        // F2: sync audio-orch/video-orch phase → FAILED through the orchestrator facade
        try {
            if (stage === 'audio') {
                const audioOrch = require('../services/audio-orchestrator');
                await audioOrch.setFailed(redis, bookId, chapterId, sceneId, reason);
            } else if (stage === 'video') {
                const videoOrch = require('../services/video-orchestrator');
                await videoOrch.setFailed(redis, bookId, chapterId, sceneId, reason);
            }
        } catch (_) {}
        log(`[FAIL-STAGE] ${bookId}/${chapterId}/${sceneId}: ${stage} → FAILED (reason=${reason})`);
        await journal.appendSceneEvent(redis, bookId, chapterId, sceneId,
            eventType, state.AssetState.FAILED, { stage, reason, buildId }).catch(() => {});

        // T8: syncLinearState удалён — per-asset state единственный source of truth
        if (redispatch) {
            await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, stage, state.AssetState.PENDING);
            log(`[FAIL-STAGE] ${bookId}/${chapterId}/${sceneId}: ${stage} → PENDING (re-dispatch queued)`);
        }
        return { failed: true, reason, redispatch };
    } finally {
        // T2: finalizeDispatch('failure') — recordFailure + consumeRetryBudget,
        // НЕ recordSuccess, НЕ DISPATCH_COMPLETED.
        try {
            const failureTaxonomy = require('../runtime/failure-taxonomy');
            const failureClass = failureTaxonomy.classifyFailure(new Error(reason || 'unknown'));
            await dispatchEngine.finalizeDispatch(redis, bookId, chapterId, sceneId, stage, {
                outcome: 'failure',
                dispatchId,
                reason: reason || 'unknown',
                failureType: failureClass.type
            });
        } catch (dispErr) {
            warn(`failStage: finalizeDispatch(${stage}) failed: ${dispErr.message}`);
        }
    }
}

// ── markDirtyScene ────────────────────────────────────
// M5: Direct per-scene DIRTY writer — единственный способ выставить
// per-asset DIRTY напрямую (без bookDiff/regen). Заменяет P4/P5/P6.
// В отличие от markDirty (который регенерирует сцену через bookDiff),
// этот метод просто маркирует assets как DIRTY, оставляя активный индекс
// scheduler'у. Разница: markDirty → for regeneration, markDirtyScene → for recovery.
//
// T5: PG side-effect — синхронно пишет scene_assets.status='stale' для каждого ассета.
// Это зеркалит то, как completeStage пишет status='ready'. Если PG недоступен —
// только warning в лог, Redis write не откатывается.
async function markDirtyScene(redis, bookId, chapterId, sceneId, assets = ['audio', 'image', 'video'], buildId = null) {
    const state = require('../state');
    for (const asset of assets) {
        await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, asset, state.AssetState.DIRTY);
    }

    // T8: syncLinearState удалён — per-asset state единственный source of truth

    // T5: PG side-effect — запись stale статуса (graceful failure)
    try {
        const sceneAssetsRepo = require('../storage/postgres/repositories/scene-assets-repo');
        for (const asset of assets) {
            await sceneAssetsRepo.markStale(bookId, chapterId, sceneId, asset, buildId);
        }
    } catch (pgErr) {
        const { log, warn } = require('./scene-utils');
        warn(`markDirtyScene: PG stale write failed for ${bookId}/${chapterId}/${sceneId}: ${pgErr.message}`);
    }
}

// ── setScenePending ──────────────────────────────────
// Set an asset to PENDING. R1: validateAssetTransition + journal event.
// Used by scene-window when starting a scene.
// T8: syncLinearState удалён — per-asset state единственный source of truth.
async function setScenePending(redis, bookId, chapterId, sceneId, asset, buildId = null) {
    const state = require('../state');
    const journal = require('./event-journal');
    const { log, warn } = require('./scene-utils');

    const states = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const current = states?.[asset];
    const check = state.validateAssetTransition(current, state.AssetState.PENDING);

    if (!check.valid && current !== state.AssetState.PENDING) {
        warn(`[SET-PENDING] ${bookId}/${chapterId}/${sceneId} ${asset}: ${current}→pending rejected (${check.reason})`);
        await journal.appendSceneEvent(redis, bookId, chapterId, sceneId,
            journal.EventType.INVALID_STATE_CALLBACK, current,
            { asset, attempted: 'pending', ignored: true }).catch(() => {});
        return { changed: false, reason: check.reason };
    }

    await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, asset, state.AssetState.PENDING);
    await journal.appendSceneEvent(redis, bookId, chapterId, sceneId,
        journal.EventType.SCENE_PENDING, state.AssetState.PENDING,
        { asset, buildId }).catch(() => {});
    return { changed: true };
}

// ── setSceneAllReady ─────────────────────────────────
// Set all three assets to READY. R1: validateAssetTransition + journal event.
// Used by scene-window when valid content found on disk (cache hit).
// T8: syncLinearState удалён — per-asset state единственный source of truth.
async function setSceneAllReady(redis, bookId, chapterId, sceneId, buildId = null) {
    const state = require('../state');
    const journal = require('./event-journal');
    const { log, warn } = require('./scene-utils');

    const states = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    for (const asset of ['audio', 'image', 'video']) {
        const current = states?.[asset];
        const check = state.validateAssetTransition(current, state.AssetState.READY);
        if (!check.valid && current !== state.AssetState.READY) {
            warn(`[SET-ALL-READY] ${bookId}/${chapterId}/${sceneId} ${asset}: ${current}→ready rejected (${check.reason}) — skipping`);
            await journal.appendSceneEvent(redis, bookId, chapterId, sceneId,
                journal.EventType.INVALID_STATE_CALLBACK, current,
                { asset, attempted: 'ready', ignored: true }).catch(() => {});
        }
    }

    await state.unsafeRestoreAssetStates(redis, bookId, chapterId, sceneId, {
        audio: state.AssetState.READY,
        image: state.AssetState.READY,
        video: state.AssetState.READY,
    });
    await journal.appendSceneEvent(redis, bookId, chapterId, sceneId,
        journal.EventType.SCENE_ALL_READY, state.AssetState.READY,
        { assets: ['audio', 'image', 'video'], buildId }).catch(() => {});
}

// ── setSceneGenerating ──────────────────────────────
// Set an asset to GENERATING. R1: validateAssetTransition + journal event.
// T7+T8: syncLinearState удалён — per-asset state единственный source of truth.
async function setSceneGenerating(redis, bookId, chapterId, sceneId, asset, buildId = null) {
    const state = require('../state');
    const journal = require('./event-journal');
    const { log, warn } = require('./scene-utils');

    const states = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const current = states?.[asset];
    const check = state.validateAssetTransition(current, state.AssetState.GENERATING);

    if (!check.valid && current !== state.AssetState.GENERATING) {
        warn(`[SET-GENERATING] ${bookId}/${chapterId}/${sceneId} ${asset}: ${current}→generating rejected (${check.reason})`);
        await journal.appendSceneEvent(redis, bookId, chapterId, sceneId,
            journal.EventType.INVALID_STATE_CALLBACK, current,
            { asset, attempted: 'generating', ignored: true }).catch(() => {});
        return { changed: false, reason: check.reason };
    }

    await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, asset, state.AssetState.GENERATING);
    await journal.appendSceneEvent(redis, bookId, chapterId, sceneId,
        journal.EventType.SCENE_GENERATING, state.AssetState.GENERATING,
        { asset, buildId }).catch(() => {});
    return { changed: true };
}

// ── setScenePlaceholder ──────────────────────────────
// Set audio to PLACEHOLDER. R1: validateAssetTransition + journal event.
// T8: syncLinearState удалён — per-asset state единственный source of truth.
async function setScenePlaceholder(redis, bookId, chapterId, sceneId, buildId = null) {
    const state = require('../state');
    const journal = require('./event-journal');
    const { log, warn } = require('./scene-utils');

    const states = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const current = states?.audio;
    const check = state.validateAssetTransition(current, state.AssetState.PLACEHOLDER);

    if (!check.valid && current !== state.AssetState.PLACEHOLDER) {
        warn(`[SET-PLACEHOLDER] ${bookId}/${chapterId}/${sceneId} audio: ${current}→placeholder rejected (${check.reason})`);
        await journal.appendSceneEvent(redis, bookId, chapterId, sceneId,
            journal.EventType.INVALID_STATE_CALLBACK, current,
            { asset: 'audio', attempted: 'placeholder', ignored: true }).catch(() => {});
        return { changed: false, reason: check.reason };
    }

    await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, 'audio', state.AssetState.PLACEHOLDER);
    await journal.appendSceneEvent(redis, bookId, chapterId, sceneId,
        journal.EventType.SCENE_PLACEHOLDER, state.AssetState.PLACEHOLDER,
        { buildId }).catch(() => {});
    return { changed: true };
}

// ── completeStageWithoutVideo ────────────────────────
// When video is disabled by layer config, mark video as READY
// and complete remaining scene lifecycle (cleanup, slide).
// Callback function handles cleanup only — state is set here in the facade.
async function completeStageWithoutVideo(redis, loadedBook, bookId, chapterId, sceneId, buildId) {
    const state = require('../state');
    const callbacks = require('./scene-callbacks');
    await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, 'video', state.AssetState.READY);
    await callbacks.completeSceneWithoutVideo(redis, loadedBook, bookId, chapterId, sceneId, buildId);
}

// ── completeStageWithoutImage ─────────────────────────
// When image is disabled by layer config, mark image as READY
// and complete remaining scene lifecycle.
async function completeStageWithoutImage(redis, loadedBook, bookId, chapterId, sceneId, buildId) {
    const state = require('../state');
    const callbacks = require('./scene-callbacks');
    await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, 'image', state.AssetState.READY);
    await callbacks.completeSceneWithoutImage(redis, loadedBook, bookId, chapterId, sceneId, buildId);
}

// ── reconcile ─────────────────────────────────────────
// Сверка фактов (PG/диск) с состоянием. Делегирует в reconciliation-engine.
// ЦЕЛЬ Д.3: диск становится источником ФАКТА, решение принимает фасад.
async function reconcile(redis, bookId, chapterId, sceneId) {
    const reconciliationEngine = require('../runtime/reconciliation-engine');
    return reconciliationEngine.reconcileScene(redis, bookId, chapterId, sceneId);
}

// ── resetScenes ───────────────────────────────────────
// T4 консолидации: единственная команда для reset'а сцен при регенерации.
// Собирает ритуал из /regenerate роута (очистка iu-progress/iu-in-flight,
// снятие lease, чистка очередей gpu-hub, markDirty) в одну команду фасада.
//
// Параметры:
//   scenes — [{chapter_id, scene_id}] — список сцен для reset'а
//   options.cleanPngUnitIds — мапу {chapterId_sceneId: [unitId, ...]} для удаления stale PNG
//   options.bookDiff — DI-инстанс book-diff (передаётся из route)
//   options.readdToActiveIndex — вернуть сцены планировщику после reset (default true)
//
// Что делает:
//   1. force-dispatch флаг
//   2. событие SCENE_RESET в journal
//   3. удаление из active index
//   4. снятие dispatch leases только для сбрасываемых стадий
//   5. очистка очередей gpu-hub (HTTP DELETE /queue/clear)
//   6. pre-delete stale PNG для указанных unit_id
//   7. очистка iu-progress + iu-in-flight
//   8. markDirty (через bookDiff.markDirtyScenes)
//   9. добавление сцен обратно в active index
//   10. событие SCENE_RESET_COMPLETED в journal
async function resetScenes(redis, bookId, buildId, scenes, layerCfg, options = {}) {
    // force — зарезервировано для будущего использования (например, пропуск
    // version-проверок на PG при полном reset). Сейчас resetScenes всегда
    // очищает всё безусловно — это корректно для регенерации.
    const {
        scope = 'WHOLE_BOOK',
        chapterId = null,
        sceneId = null,
        bookDiff = null,
        cleanPngUnitIds = null,
        readdToActiveIndex = true,
    } = options;
    const { log, warn } = require('./scene-utils');
    const journal = require('./event-journal');

    if (!scenes || scenes.length === 0) {
        log('[RESET-SCENES] No scenes to reset');
        return { marked: 0, reset_scenes: 0 };
    }

    const scopeDisplay = `${scope}${chapterId ? '/' + chapterId : ''}${sceneId ? '/' + sceneId : ''}`;
    log(`[RESET-SCENES] ${bookId}: ${scenes.length} scenes, scope=${scopeDisplay}`);

    // 1. Force-dispatch flag (T1: TTL из TIMEOUTS)
    const runtimeConfig = require('../config/runtime-config');
    await redis.set(
        `animastor:force-dispatch:${bookId}`, '1',
        'EX', runtimeConfig.TIMEOUTS.FORCE_DISPATCH_TTL_S
    );

    // 2. Event journal — start
    await journal.appendSceneEvent(redis, bookId, chapterId || bookId, sceneId || 'all',
        journal.EventType.SCENE_RESET, 'INITIATED',
        { scenes_count: scenes.length, scope, force: !!options.force }
    ).catch(() => {});

    // 3. Remove from active index
    const scheduler = require('../runtime/runtime-scheduler');
    await scheduler.removeScenesFromActiveIndex(redis, bookId, scenes);

    // 4. Clear dispatch leases only for stages requested by this regeneration.
    // A parallel Image request must not cancel an already-running Audio lease
    // for the same scene.
    const dispatchEngine = require('../runtime/dispatch-engine');
    const leaseResetScenes = scenes.map(ds => ({
        chapter_id: ds.chapter_id,
        scene_id: ds.scene_id,
        stages: (ds.dirty_layers || ['audio', 'image', 'video']).filter(stage =>
            layerCfg?.[`${stage}_enabled`] !== false
        ),
    }));
    const resetStagesByScene = new Map(leaseResetScenes.map(s => [
        `${s.chapter_id}:${s.scene_id}`,
        s.stages,
    ]));
    const cancellation = await dispatchEngine.clearLeasesForScenes(redis, bookId, leaseResetScenes);

    // 5. Clear only jobs belonging to the cancelled dispatches.
    await dispatchEngine.clearHubDispatches(cancellation.dispatchIds, {
        context: 'RESET-SCENES',
        warn,
    });

    // 6. Pre-delete stale PNGs for specific unit IDs
    const path = require('path');
    const fs = require('fs');
    if (cleanPngUnitIds && typeof cleanPngUnitIds === 'object' && buildId) {
        const buildDir = path.join(runtimeConfig.OUTPUT_DIR, buildId);
        if (fs.existsSync(buildDir)) {
            let deletedCount = 0;
            for (const ds of scenes) {
                const sceneKey = `${ds.chapter_id}_${ds.scene_id}`;
                const unitIds = cleanPngUnitIds[sceneKey] || [];
                for (const uid of unitIds) {
                    const pngPath = path.join(buildDir, `${bookId}_${ds.chapter_id}_${ds.scene_id}_${uid}.png`);
                    try { if (fs.existsSync(pngPath)) { fs.unlinkSync(pngPath); deletedCount++; } } catch (_) {}
                    const strippedUid = uid.replace(/^iu/, '');
                    const previewPath = path.join(buildDir, `${bookId}_${ds.chapter_id}_${ds.scene_id}_pr${strippedUid}.png`);
                    try { if (fs.existsSync(previewPath)) { fs.unlinkSync(previewPath); } } catch (_) {}
                }
            }
            if (deletedCount > 0) log(`[RESET-SCENES] Deleted ${deletedCount} stale PNG files`);
        }
    }

    // 7. Clear image-specific IU progress only for scenes whose image stage is reset.
    for (const ds of scenes) {
        const resetStages = resetStagesByScene.get(`${ds.chapter_id}:${ds.scene_id}`) || [];
        if (!resetStages.includes('image')) continue;

        const progKey = `animastor:iu-progress:${bookId}:${ds.chapter_id}:${ds.scene_id}:image`;
        try { await redis.del(progKey); } catch (_) {}

        try {
            let cursor = '0';
            const scenePrefix = `${bookId}_${ds.chapter_id}_${ds.scene_id}_iu-`;
            do {
                const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `animastor:iu-in-flight:${scenePrefix}*`, 'COUNT', 50);
                cursor = nextCursor;
                if (keys.length > 0) await redis.del(...keys);
            } while (cursor !== '0');
        } catch (_) {}
    }

    // 8. markDirty (через bookDiff.markDirtyScenes — обязательный DI-инстанс из route)
    // R7: bookDiff обязателен — неатомарный fallback удалён.
    if (!bookDiff || typeof bookDiff.markDirtyScenes !== 'function') {
        throw new Error(`resetScenes: bookDiff.markDirtyScenes is required for book ${bookId}`);
    }
    // W1: try/catch вокруг markDirty гарантирует, что addSceneToActiveIndex
    // (шаг 9) выполнится даже при runtime-ошибке (PG failure, Redis timeout).
    // Сцена без dirty не страшна; сцена вне active index — scheduler её не
    // увидит, и она зависнет навсегда. Programming error (bookDiff missing)
    // валидируется выше и падает жёстко — это контракт, а не runtime-сбой.
    let marked = { marked: 0 };
    try {
        marked = await markDirty({ bookDiff }, redis, bookId, buildId, scenes, layerCfg);
    } catch (mdErr) {
        warn(`[RESET-SCENES] markDirty failed for ${bookId}: ${mdErr.message} — continuing to re-add scenes to active index`);
    }

    // 9. Re-add to active index (планировщик подберёт на следующем тике).
    // Selective generation can defer this until its task registry is ready.
    // Гарантированно выполняется даже при ошибке markDirty (шаг 8).
    if (readdToActiveIndex) {
        for (const ds of scenes) {
            await scheduler.addSceneToActiveIndex(redis, bookId, ds.chapter_id, ds.scene_id);
        }
        log(`[RESET-SCENES] ${bookId}: ${scenes.length} scenes re-added to active index`);
    } else {
        log(`[RESET-SCENES] ${bookId}: activation deferred for ${scenes.length} scenes`);
    }

    // 10. Event journal — completion
    await journal.appendSceneEvent(redis, bookId, chapterId || bookId, sceneId || 'all',
        journal.EventType.SCENE_RESET_COMPLETED, 'DONE',
        { scenes_count: scenes.length, marked: marked.marked }
    ).catch(() => {});

    return { ...marked, reset_scenes: scenes.length };
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
    setSceneGenerating,
    setSceneAllReady,
    setScenePlaceholder,
    reconcile,
    resetScenes,
};
