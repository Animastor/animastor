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
async function completeStage(redis, bookId, chapterId, sceneId, stage, buildId) {
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
            let shouldWriteReady = true;
            try {
                const { query: pgQuery } = require('../storage/postgres/database');

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
                // T1.11: Fail-closed — ошибка PG не разрешает READY
                shouldWriteReady = false;
                warn(`[VERSION-GATE] PG query failed for ${bookId}/${chapterId}/${sceneId}: ${pgErr.message} — blocking READY (fail-closed)`);
            }

            if (shouldWriteReady) {
                // T1.10: PG markReady ПОСЛЕ version gate
                const artifactPath = handlerResult.artifact?.path;
                if (artifactPath) {
                    try {
                        await sceneAssetsRepo.markReady(bookId, chapterId, sceneId, stage, artifactPath);
                        log(`[PG-${stage.toUpperCase()}-READY] ${bookId}/${chapterId}/${sceneId}: status=ready`);
                    } catch (pgErr) {
                        warn(`Failed to mark ${stage} READY in PG: ${pgErr.message}`);
                    }
                }

                await state.setAssetState(redis, bookId, chapterId, sceneId, stage, state.AssetState.READY);
                log(`[COMPLETE-STAGE] ${bookId}/${chapterId}/${sceneId}: ${stage} → READY`);
                phaseCompleted = true;
                phaseReason = null;
            } else {
                // T2: version gate stale — dispatch успешен, но artifact устарел.
                // Финализируем как success (диспетчеризация выполнена), просто не ставим READY.
                log(`[VERSION-GATE] ${bookId}/${chapterId}/${sceneId}: ${stage} stale — DIRTY instead of READY`);
                await state.setAssetState(redis, bookId, chapterId, sceneId, stage, state.AssetState.DIRTY);
                phaseCompleted = false;
                phaseReason = 'stale';
                // handlerOk остаётся true — финализируем как success
            }
        }
    } finally {
        // T2: finalizeDispatch — handlerOk определяет success/failure
        // Если handler вернул ok:true (handlerOk = true) — всегда success,
        // даже при version gate stale. Failure только при ok:false/error handler.
        try {
            const outcome = handlerOk ? 'success' : 'failure';
            await dispatchEngine.finalizeDispatch(redis, bookId, chapterId, sceneId, stage, {
                outcome,
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

        // T8: syncLinearState удалён — per-asset state единственный source of truth
        if (redispatch) {
            await state.setAssetState(redis, bookId, chapterId, sceneId, stage, state.AssetState.PENDING);
            log(`[FAIL-STAGE] ${bookId}/${chapterId}/${sceneId}: ${stage} → PENDING (re-dispatch queued)`);
        }
        return { failed: true, reason, redispatch };
    } finally {
        // T2: finalizeDispatch('failure') — recordFailure + consumeRetryBudget,
        // НЕ recordSuccess, НЕ DISPATCH_COMPLETED.
        try {
            await dispatchEngine.finalizeDispatch(redis, bookId, chapterId, sceneId, stage, {
                outcome: 'failure',
                reason: reason || 'unknown',
                failureType: 'transient'
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
        await state.setAssetState(redis, bookId, chapterId, sceneId, asset, state.AssetState.DIRTY);
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
// Set an asset to PENDING.
// Used by scene-window when starting a scene.
// T8: syncLinearState удалён — per-asset state единственный source of truth.
async function setScenePending(redis, bookId, chapterId, sceneId, asset, buildId = null) {
    const state = require('../state');
    await state.setAssetState(redis, bookId, chapterId, sceneId, asset, state.AssetState.PENDING);
}

// ── setSceneAllReady ─────────────────────────────────
// Set all three assets to READY.
// Used by scene-window when valid content found on disk (cache hit).
// T8: syncLinearState удалён — per-asset state единственный source of truth.
async function setSceneAllReady(redis, bookId, chapterId, sceneId, buildId = null) {
    const state = require('../state');
    await state.setAssetStates(redis, bookId, chapterId, sceneId, {
        audio: state.AssetState.READY,
        image: state.AssetState.READY,
        video: state.AssetState.READY,
    });
}

// ── setSceneGenerating ──────────────────────────────
// Set an asset to GENERATING.
// T7+T8: syncLinearState удалён — per-asset state единственный source of truth.
async function setSceneGenerating(redis, bookId, chapterId, sceneId, asset, buildId = null) {
    const state = require('../state');
    await state.setAssetState(redis, bookId, chapterId, sceneId, asset, state.AssetState.GENERATING);
}

// ── setScenePlaceholder ──────────────────────────────
// Set audio to PLACEHOLDER.
// T8: syncLinearState удалён — per-asset state единственный source of truth.
async function setScenePlaceholder(redis, bookId, chapterId, sceneId, buildId = null) {
    const state = require('../state');
    await state.setAssetState(redis, bookId, chapterId, sceneId, 'audio', state.AssetState.PLACEHOLDER);
}

// ── completeStageWithoutVideo ────────────────────────
// When video is disabled by layer config, mark video as READY
// and complete remaining scene lifecycle (cleanup, slide).
// Callback function handles cleanup only — state is set here in the facade.
async function completeStageWithoutVideo(redis, loadedBook, bookId, chapterId, sceneId, buildId) {
    const state = require('../state');
    const callbacks = require('./scene-callbacks');
    await state.setAssetState(redis, bookId, chapterId, sceneId, 'video', state.AssetState.READY);
    await callbacks.completeSceneWithoutVideo(redis, loadedBook, bookId, chapterId, sceneId, buildId);
}

// ── completeStageWithoutImage ─────────────────────────
// When image is disabled by layer config, mark image as READY
// and complete remaining scene lifecycle.
async function completeStageWithoutImage(redis, loadedBook, bookId, chapterId, sceneId, buildId) {
    const state = require('../state');
    const callbacks = require('./scene-callbacks');
    await state.setAssetState(redis, bookId, chapterId, sceneId, 'image', state.AssetState.READY);
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
//   options.scope, options.chapterId, options.sceneId — для gen-scope
//   options.cleanPngUnitIds — мапу {chapterId_sceneId: [unitId, ...]} для удаления stale PNG
//   options.bookDiff — DI-инстанс book-diff (передаётся из route)
//
// Что делает:
//   1. force-dispatch флаг
//   2. gen-scope
//   3. событие SCENE_RESET в journal
//   4. удаление из active index
//   5. снятие dispatch leases
//   6. очистка очередей gpu-hub (HTTP DELETE /queue/clear)
//   7. pre-delete stale PNG для указанных unit_id
//   8. очистка iu-progress + iu-in-flight
//   9. markDirty (через bookDiff.markDirtyScenes)
//   10. добавление сцен обратно в active index
//   11. событие SCENE_RESET_COMPLETED в journal
async function resetScenes(redis, bookId, buildId, scenes, layerCfg, options = {}) {
    // force — зарезервировано для будущего использования (например, пропуск
    // version-проверок на PG при полном reset). Сейчас resetScenes всегда
    // очищает всё безусловно — это корректно для регенерации.
    const { scope = 'WHOLE_BOOK', chapterId = null, sceneId = null, bookDiff = null, cleanPngUnitIds = null } = options;
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

    // 2. Gen-scope (единственное место записи — T4 цель)
    const genScope = require('../services/gen-scope');
    await genScope.setScope(redis, bookId, scope, chapterId, sceneId);

    // 3. Event journal — start
    await journal.appendSceneEvent(redis, bookId, chapterId || bookId, sceneId || 'all',
        journal.EventType.SCENE_RESET, 'INITIATED',
        { scenes_count: scenes.length, scope, force: !!options.force }
    ).catch(() => {});

    // 4. Remove from active index
    const scheduler = require('../runtime/runtime-scheduler');
    await scheduler.removeScenesFromActiveIndex(redis, bookId, scenes);

    // 5. Clear dispatch leases for these scenes
    const dispatchEngine = require('../runtime/dispatch-engine');
    await dispatchEngine.clearLeasesForScenes(redis, bookId, scenes);

    // 6. Clear GPU hub queues via HTTP endpoint (gpu-hub владеет ключами)
    try {
        const hubUrl = `${runtimeConfig.HUB_URL}/queue/clear?book_id=${bookId}`;
        const hubHeaders = { method: 'DELETE' };
        // T9: Include API key header for authenticated GPU Hub
        if (runtimeConfig.GPU_HUB_API_KEY) {
            hubHeaders.headers = { 'x-api-key': runtimeConfig.GPU_HUB_API_KEY };
        }
        const hubRes = await fetch(hubUrl, hubHeaders);
        if (hubRes.ok) {
            log(`[RESET-SCENES] GPU hub queues cleared for ${bookId}`);
        } else {
            warn(`[RESET-SCENES] GPU hub queue clear returned ${hubRes.status}`);
        }
    } catch (hubErr) {
        warn(`[RESET-SCENES] GPU hub HTTP error: ${hubErr.message} — queues may have stale entries`);
    }

    // 7. Pre-delete stale PNGs for specific unit IDs
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

    // 8. Clear iu-progress and iu-in-flight Redis keys
    for (const ds of scenes) {
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

    // 9. markDirty (через bookDiff.markDirtyScenes — DI-инстанс из route)
    let marked = { marked: 0 };
    if (bookDiff && typeof bookDiff.markDirtyScenes === 'function') {
        marked = await markDirty({ bookDiff }, redis, bookId, buildId, scenes, layerCfg);
    } else {
        // Fallback: прямой markDirtyScene если bookDiff не передан
        log('[RESET-SCENES] No bookDiff provided — using markDirtyScene fallback');
        for (const ds of scenes) {
            for (const layer of (ds.dirty_layers || ['audio', 'image', 'video'])) {
                await markDirtyScene(redis, bookId, ds.chapter_id, ds.scene_id, [layer]);
            }
        }
    }

    // 10. Re-add to active index (планировщик подберёт на следующем тике)
    for (const ds of scenes) {
        await scheduler.addSceneToActiveIndex(redis, bookId, ds.chapter_id, ds.scene_id);
    }
    log(`[RESET-SCENES] ${bookId}: ${scenes.length} scenes re-added to active index`);

    // 11. Event journal — completion
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
