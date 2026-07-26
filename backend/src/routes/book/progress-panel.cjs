// ======================================================
// Progress Panel Route — independent generation task list
// ======================================================
//
// Every row represents one user-started generation task. Rows are keyed by
// task_id rather than worker type, so multiple Audio/Image/Video commands can
// run concurrently with different scopes and target scenes.

const sceneAssetsRepo = require('../../storage/postgres/repositories/scene-assets-repo');
const { computeIuReady } = require('./iu-progress-utils.cjs');
const generationProgress = require('../../services/generation-progress');

module.exports = function(app, redis, deps) {
    const {
        state, activeScenes, iuRepo,
        utils, getChunk, getAllChunks,
    } = deps;
    const { log } = utils;

    function sceneKey(chapterId, sceneId) {
        return `${chapterId}:${sceneId}`;
    }

    async function loadChunks(bookId) {
        const ids = await getAllChunks(bookId);
        const chunkById = new Map();
        if (ids.length === 0) return { ids, chunkById };

        try {
            const raw = await redis.mget(ids.map(id => `animastor:chunk:${id}`));
            for (let i = 0; i < ids.length; i++) {
                if (!raw[i]) continue;
                try {
                    chunkById.set(ids[i], JSON.parse(raw[i]));
                } catch (_) {}
            }
        } catch (_) {
            for (const id of ids) {
                try {
                    const chunk = await getChunk(id);
                    if (chunk) chunkById.set(id, chunk);
                } catch (_) {}
            }
        }
        return { ids, chunkById };
    }

    async function loadTargetStates(bookId, targets) {
        const result = new Map();
        for (const target of targets) {
            const key = sceneKey(target.chapter_id, target.scene_id);
            result.set(key, await state.getAssetStates(
                redis,
                bookId,
                target.chapter_id,
                target.scene_id
            ));
        }
        return result;
    }

    function chunksForTargets(ids, chunkById, targets) {
        const targetKeys = new Set(
            targets.map(target => sceneKey(target.chapter_id, target.scene_id))
        );
        return ids
            .map(id => chunkById.get(id))
            .filter(chunk => chunk && targetKeys.has(sceneKey(chunk.chapter_id, chunk.scene_id)));
    }

    function countAudio(targets, chunks, targetStates) {
        let ready = 0;
        let total = 0;

        for (const target of targets) {
            const key = sceneKey(target.chapter_id, target.scene_id);
            const sceneChunks = chunks.filter(chunk =>
                chunk.chapter_id === target.chapter_id && chunk.scene_id === target.scene_id
            );
            const expected = sceneChunks.reduce((max, chunk) => {
                const value = parseInt(chunk.expected_chunk_count, 10);
                return Number.isFinite(value) && value > max ? value : max;
            }, 0);

            if (expected > 0) {
                total += expected;
                ready += sceneChunks.filter(chunk => chunk.audio_status === 'ready').length;
            } else {
                total += 1;
                if (targetStates.get(key)?.audio === state.AssetState.READY) ready += 1;
            }
        }
        return { ready: Math.min(ready, total), total, indeterminate: total === 0 };
    }

    async function countImage(bookId, buildId, targets, chunks, targetStates) {
        let ready = 0;
        let total = 0;
        let usedIu = false;

        for (const target of targets) {
            let rows = [];
            if (buildId) {
                try {
                    rows = await iuRepo.getImageUnitsForScene(
                        buildId,
                        bookId,
                        target.chapter_id,
                        target.scene_id
                    );
                } catch (_) {}
            }

            if (rows.length > 0) {
                usedIu = true;
                total += rows.length;
                ready += await computeIuReady(
                    redis,
                    sceneAssetsRepo,
                    bookId,
                    target.chapter_id,
                    target.scene_id,
                    rows.length
                );
                continue;
            }

            total += 1;
            const key = sceneKey(target.chapter_id, target.scene_id);
            const sceneReady = targetStates.get(key)?.image === state.AssetState.READY ||
                chunks.some(chunk =>
                    chunk.chapter_id === target.chapter_id &&
                    chunk.scene_id === target.scene_id &&
                    chunk.image_status === 'ready'
                );
            if (sceneReady) ready += 1;
        }

        return {
            ready: Math.min(ready, total),
            total,
            indeterminate: usedIu && total === 0,
        };
    }

    function countSceneStage(type, targets, chunks, targetStates) {
        let ready = 0;
        for (const target of targets) {
            const key = sceneKey(target.chapter_id, target.scene_id);
            const sceneReady = targetStates.get(key)?.[type] === state.AssetState.READY ||
                chunks.some(chunk =>
                    chunk.chapter_id === target.chapter_id &&
                    chunk.scene_id === target.scene_id &&
                    chunk[`${type}_status`] === 'ready'
                );
            if (sceneReady) ready += 1;
        }
        return { ready, total: targets.length, indeterminate: targets.length === 0 };
    }

    async function buildWorker(bookId, task, chunkData, buildId) {
        const targets = task.targets || [];

        // ── current_scene: expand into per-target (one row per scene) ──
        // All other scopes (whole_book, current_chapter, from_current_scene)
        // are ONE task → one aggregated row.
        if (task.scope === 'current_scene') {
            const allTargetStates = await loadTargetStates(bookId, targets);
            const result = [];

            for (const target of targets) {
                const single = [target];
                const chunks = chunksForTargets(chunkData.ids, chunkData.chunkById, single);
                const targetStates = new Map();
                const key = sceneKey(target.chapter_id, target.scene_id);
                if (allTargetStates.has(key)) {
                    targetStates.set(key, allTargetStates.get(key));
                }

                let counts;
                if (task.type === 'audio') {
                    counts = countAudio(single, chunks, targetStates);
                } else if (task.type === 'image') {
                    counts = await countImage(bookId, buildId, single, chunks, targetStates);
                } else {
                    counts = countSceneStage(task.type, single, chunks, targetStates);
                }

                const cancelled = task.status === 'cancelled';
                const doneByProgress = counts.total > 0 && counts.ready >= counts.total;
                const done = task.status === 'completed' || (!cancelled && doneByProgress);
                const ready = task.status === 'completed' ? counts.total : counts.ready;
                const percent = done
                    ? 100
                    : Math.round(ready * 100 / Math.max(1, counts.total));

                result.push({
                    task_id: task.task_id || null,
                    type: task.type,
                    scope: task.scope || 'whole_book',
                    chapter_id: target.chapter_id,
                    scene_id: target.scene_id,
                    target_count: 1,
                    started_at: task.started_at || null,
                    ready,
                    total: counts.total,
                    percent,
                    done,
                    visible: true,
                    indeterminate: counts.indeterminate,
                    cancelled,
                });
            }

            return result;
        }

        // ── All other scopes: one aggregated row per type ──
        const targetStates = await loadTargetStates(bookId, targets);
        const chunks = chunksForTargets(chunkData.ids, chunkData.chunkById, targets);

        let counts;
        if (task.type === 'audio') {
            counts = countAudio(targets, chunks, targetStates);
        } else if (task.type === 'image') {
            counts = await countImage(bookId, buildId, targets, chunks, targetStates);
        } else {
            counts = countSceneStage(task.type, targets, chunks, targetStates);
        }

        const cancelled = task.status === 'cancelled';
        const doneByProgress = counts.total > 0 && counts.ready >= counts.total;
        const done = task.status === 'completed' || (!cancelled && doneByProgress);
        const ready = task.status === 'completed' ? counts.total : counts.ready;
        const percent = done
            ? 100
            : Math.round(ready * 100 / Math.max(1, counts.total));

        return [{
            task_id: task.task_id || null,
            type: task.type,
            scope: task.scope || 'whole_book',
            chapter_id: task.chapter_id || null,
            scene_id: task.scene_id || null,
            target_count: targets.length,
            started_at: task.started_at || null,
            ready,
            total: counts.total,
            percent,
            done,
            visible: true,
            indeterminate: counts.indeterminate,
            cancelled,
        }];
    }

    async function legacyTasks(bookId) {
        const grouped = new Map([
            ['audio', []],
            ['image', []],
            ['video', []],
        ]);
        try {
            const activeKeys = await activeScenes.getAllActiveSceneKeys(redis);
            for (const key of activeKeys) {
                const parsed = activeScenes.parseSceneKey(key);
                if (!parsed || parsed.bookId !== bookId) continue;
                const assetStates = await state.getAssetStates(
                    redis,
                    parsed.bookId,
                    parsed.chapterId,
                    parsed.sceneId
                );
                for (const type of grouped.keys()) {
                    if (assetStates[type] === state.AssetState.PENDING ||
                        assetStates[type] === state.AssetState.GENERATING) {
                        grouped.get(type).push({
                            chapter_id: parsed.chapterId,
                            scene_id: parsed.sceneId,
                        });
                    }
                }
            }
        } catch (err) {
            console.warn(`[PROGRESS-PANEL] Legacy active-state lookup failed for ${bookId}: ${err.message}`);
        }

        return [...grouped.entries()]
            .filter(([, targets]) => targets.length > 0)
            .map(([type, targets]) => ({
                task_id: null,
                type,
                status: 'active',
                scope: 'whole_book',
                chapter_id: null,
                scene_id: null,
                targets,
                started_at: null,
            }));
    }

    app.get('/api/v1/book/:bookId/progress-panel', async (req, res) => {
        try {
            const { bookId } = req.params;
            let tasks = await generationProgress.listTasks(redis, bookId);
            if (tasks.length === 0) {
                tasks = await legacyTasks(bookId);
            }

            const chunkData = await loadChunks(bookId);
            let buildId = null;
            for (const id of chunkData.ids) {
                buildId = chunkData.chunkById.get(id)?.build_id || buildId;
                if (buildId) break;
            }

            const workers = [];
            for (const task of tasks) {
                const taskWorkers = await buildWorker(bookId, task, chunkData, buildId);
                workers.push(...taskWorkers);
            }

            const visibleWorkers = workers.filter(worker => worker.visible);
            const anyIncomplete = visibleWorkers.some(worker => !worker.done && !worker.cancelled);
            const overallPercent = visibleWorkers.length > 0
                ? Math.round(
                    visibleWorkers.reduce((sum, worker) => sum + worker.percent, 0) /
                    visibleWorkers.length
                )
                : 0;

            res.json({
                book_id: bookId,
                workers: visibleWorkers,
                overall_percent: overallPercent,
                any_incomplete: anyIncomplete,
            });
        } catch (err) {
            console.error('[PROGRESS-PANEL] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    log('[ROUTES] Progress panel route loaded');
};
