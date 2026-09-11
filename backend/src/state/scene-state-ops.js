// ======================================================
// Scene State Ops — guarded per-asset FSM transition writers (S-5)
// ======================================================
// S-5 ownership move: these five functions are PURE asset-FSM transition
// helpers (validate transition → unsafe write → journal event) with no
// orchestration policy inside — no stage sequencing, no dispatch, no
// completion semantics. Their canonical owner is the state layer, next to
// the Redis adapter (asset-state-store.js) they drive and the pure FSM
// contract (generation/scene-state.js) they enforce. Previously they lived
// in orchestration/orchestrator.js, which made the facade the only path to
// plain FSM writes and kept a services→orchestration edge
// (placeholder-audio) inside the runtime↔orchestration SCC.
//
// Bodies moved VERBATIM from orchestration/orchestrator.js (S-5, audit of
// the R5 edge list): Redis keys, FSM semantics, journal event shapes and
// console log bytes are unchanged. The orchestrator facade re-exports them
// (orchestrator.markDirtyScene === this module's markDirtyScene), so every
// facade caller keeps its exact API. rollbackStageToPending STAYS on the
// facade: it additionally reports the runtime-owned `stateRollbackFailures`
// metric (runtime/runtime-metrics) and must not pull a runtime dependency
// into the state layer.
//
// Lifecycle writes still flow through the single-writer discipline
// (STATE_WRITERS_MAP): the facade command surface is unchanged.

// S-5: the journal is the append-only observability sink (host adapter)
const journal = require('./event-journal');
// S-2: registered stage list resolved from the media registry
const mediaRegistry = require('@animastor/generation').mediaRegistry;

// Log prefix preserved from the former orchestrator-facade location —
// console output stays byte-identical.
const logPrefix = '[ORCH]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
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
async function markDirtyScene(redis, bookId, chapterId, sceneId, assets = mediaRegistry.listMediaTypes(), buildId = null) {
    const state = require('./asset-state-store');
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
        warn(`markDirtyScene: PG stale write failed for ${bookId}/${chapterId}/${sceneId}: ${pgErr.message}`);
    }
}

// ── setScenePending ──────────────────────────────────
// Set an asset to PENDING. R1: validateAssetTransition + journal event.
// Used by scene-window when starting a scene.
// T8: syncLinearState удалён — per-asset state единственный source of truth.
async function setScenePending(redis, bookId, chapterId, sceneId, asset, buildId = null) {
    const state = require('./asset-state-store');

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
    const state = require('./asset-state-store');

    const states = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    for (const asset of mediaRegistry.listMediaTypes()) {
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
        { assets: mediaRegistry.listMediaTypes(), buildId }).catch(() => {});
}

// ── setSceneGenerating ──────────────────────────────
// Set an asset to GENERATING. R1: validateAssetTransition + journal event.
// T7+T8: syncLinearState удалён — per-asset state единственный source of truth.
//
// CONTRACT (fix: video-retry-targeted-investigation-2026-08-26):
// returns { changed: false, reason } when the transition is invalid —
// callers MUST abort the dispatch before sending any GPU job.
// Sending a job from a state that cannot reach GENERATING turns the later
// successful callback into 'invalid_asset_state' FAILURE (retry budget burn
// + circuit breaker). See scene-orchestrator.ensureStageDispatchable.
async function setSceneGenerating(redis, bookId, chapterId, sceneId, asset, buildId = null) {
    const state = require('./asset-state-store');

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
    const state = require('./asset-state-store');

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

module.exports = {
    markDirtyScene,
    setScenePending,
    setSceneGenerating,
    setSceneAllReady,
    setScenePlaceholder,
};
