// ======================================================
// Book Generation Routes — Regenerate, Cancel, Generate Next
// ======================================================

const path = require('path');
const fs = require('fs');
const sceneAssetsRepo = require('../../storage/postgres/repositories/scene-assets-repo');
const generationProgress = require('../../services/generation-progress');
const dispatchEngine = require('../../runtime/dispatch-engine');
const taskRepo = require('../../storage/postgres/repositories/task-repo');

module.exports = function(app, redis, deps) {
    const {
        config, state, audio, image, video, book, orchestrator, storage,
        runtime,
        txtImporter, lazyBook, genSessionRepo, bookSourceRepo,
        placeholderAudio, layerConfig, activeScenes,
        utils, saveChunk, getChunk, getAllChunks, getBookWindowStatus,
        detectAvailableMode, recoverChunksFromDisk, recoverAllBooksFromDisk,
        cleanupService, bookDiff, taskHandler, windowGenerator,
        iuRepo, cleanBookRedisKeys,
    } = deps;
    const { log } = utils;

    // ======================================================
    // GENERATE NEXT (slide window)
    // ======================================================
    app.post('/api/v1/book/:bookId/generate-next', async (req, res) => {
        try {
            const bookId = req.params.bookId;
            const loadedBook = book.loadBook(bookId);
            if (!loadedBook) return res.status(404).json({ error: 'book not found' });

            const ids = await getAllChunks(bookId);
            let buildId = loadedBook.manifest?.build_id || 'default';
            if (ids.length > 0) {
                const firstChunk = await getChunk(ids[0]);
                if (firstChunk?.build_id) buildId = firstChunk.build_id;
            }
            const result = await runtime.sceneWindow.slideWindow(redis, bookId, loadedBook, buildId);
            const newIds = await getAllChunks(bookId);
            res.json({ started: result.started, remaining: result.remaining, chunk_ids: newIds });
        } catch (err) {
            console.error('❌ GENERATE-NEXT ERROR:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // LAYER CONFIG (read / write) — defaults for initial/bulk generation
    // ======================================================
    app.get('/api/v1/book/:bookId/layer-config', async (req, res) => {
        try {
            const { bookId } = req.params;
            const cfg = await layerConfig.get(redis, bookId);
            res.json({
                book_id: bookId,
                audio_enabled: cfg.audio_enabled,
                image_enabled: cfg.image_enabled,
                video_enabled: cfg.video_enabled,
                chunk_size: cfg.chunk_size,
                audio_timeout_minutes: cfg.audio_timeout_minutes,
                image_timeout_minutes: cfg.image_timeout_minutes,
                video_timeout_minutes: cfg.video_timeout_minutes,
            });
        } catch (err) {
            console.error('[LAYER-CONFIG] GET error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    app.put('/api/v1/book/:bookId/layer-config', async (req, res) => {
        try {
            const { bookId } = req.params;
            const { audio_enabled, image_enabled, video_enabled, chunk_size, audio_timeout_minutes, image_timeout_minutes, video_timeout_minutes } = req.body || {};
            const cfg = await layerConfig.set(redis, bookId, {
                audio_enabled, image_enabled, video_enabled,
                chunk_size, audio_timeout_minutes, image_timeout_minutes, video_timeout_minutes,
            });
            log(`[LAYER-CONFIG] book=${bookId} → a=${cfg.audio_enabled} i=${cfg.image_enabled} v=${cfg.video_enabled} cs=${cfg.chunk_size} ato=${cfg.audio_timeout_minutes} ito=${cfg.image_timeout_minutes} vto=${cfg.video_timeout_minutes}`);
            res.json({
                book_id: bookId,
                audio_enabled: cfg.audio_enabled,
                image_enabled: cfg.image_enabled,
                video_enabled: cfg.video_enabled,
                chunk_size: cfg.chunk_size,
                audio_timeout_minutes: cfg.audio_timeout_minutes,
                image_timeout_minutes: cfg.image_timeout_minutes,
                video_timeout_minutes: cfg.video_timeout_minutes,
            });
        } catch (err) {
            console.error('[LAYER-CONFIG] PUT error:', err.message);
            console.error('[LAYER-CONFIG] PUT error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // CANCEL WORKER (task-aware; type remains as bulk fallback)
    // ======================================================
    // A row-level stop sends task_id and cancels only that task's stage/scene
    // targets. A section-level stop sends type and cancels every active task of
    // that type. Other task ids, including the same worker type, stay intact.
    app.post('/api/v1/book/:bookId/cancel-worker', async (req, res) => {
        try {
            const { bookId } = req.params;
            const { type, task_id: taskId } = req.body || {};

            if (!taskId && (!type || !['audio', 'image', 'video', 'cover', 'vbook'].includes(type))) {
                return res.status(400).json({
                    error: 'Provide task_id or a worker type: audio, image, video, cover, vbook',
                });
            }

            let resolvedType = type;
            let tasks = [];
            if (taskId) {
                const task = await generationProgress.getTask(redis, bookId, taskId);
                if (!task) return res.status(404).json({ error: 'Generation task not found' });
                resolvedType = task.type;
                tasks = task.status === 'active' ? [task] : [];
            } else if (['audio', 'image', 'video'].includes(type)) {
                tasks = await generationProgress.getActiveTasksByType(redis, bookId, type);
            }

            log(`[CANCEL-WORKER] ${bookId}: cancelling type=${resolvedType} task=${taskId || 'all'}`);

            if (resolvedType === 'vbook') {
                // Cancel VBook/AI agent: update agent session status to 'cancelled'
                await redis.sadd(`animastor:cancelled-workers:${bookId}`, 'vbook');
                await redis.expire(`animastor:cancelled-workers:${bookId}`, 3600);
                try {
                    const { query } = require('../../storage/postgres/database');
                    await query(
                        `UPDATE agent_sessions SET status = 'cancelled', updated_at = $1
                         WHERE book_id = $2 AND status IN ('running', 'paused')`,
                        [Math.floor(Date.now() / 1000), bookId]
                    );
                    log(`[CANCEL-WORKER] ${bookId}: VBook agent sessions cancelled`);
                } catch (pgErr) {
                    console.warn(`[CANCEL-WORKER] Failed to cancel VBook session: ${pgErr.message}`);
                }
            } else if (resolvedType === 'cover') {
                // Cover uses both audio + image stages — cancel both
                await dispatchEngine.clearLeasesForBookByStage(redis, bookId, 'audio');
                await dispatchEngine.clearLeasesForBookByStage(redis, bookId, 'image');
                log(`[CANCEL-WORKER] ${bookId}: cover (audio+image) leases cleared`);
            } else {
                for (const task of tasks) {
                    await generationProgress.markCancelled(redis, bookId, task.task_id);
                    try {
                        await taskRepo.updateTaskStatus(task.task_id, 'cancelled');
                    } catch (pgErr) {
                        console.warn(`[CANCEL-WORKER] Failed to persist cancellation for ${task.task_id}: ${pgErr.message}`);
                    }
                }

                const scenesToCancel = [];
                const seen = new Set();
                for (const task of tasks) {
                    for (const target of task.targets || []) {
                        const remaining = await generationProgress.getSceneTaskState(
                            redis,
                            bookId,
                            target.chapter_id,
                            target.scene_id
                        );
                        if (remaining.activeTypes.has(resolvedType)) continue;
                        const sceneKey = `${target.chapter_id}:${target.scene_id}`;
                        if (seen.has(sceneKey)) continue;
                        seen.add(sceneKey);
                        scenesToCancel.push({
                            chapter_id: target.chapter_id,
                            scene_id: target.scene_id,
                            stages: [resolvedType],
                        });
                    }
                }

                let cancellation;
                if (scenesToCancel.length > 0) {
                    cancellation = await dispatchEngine.clearLeasesForScenes(redis, bookId, scenesToCancel);
                } else if (tasks.length === 0 && !taskId) {
                    // Backward compatibility for work started before task ids existed.
                    cancellation = await dispatchEngine.clearLeasesForBookByStage(redis, bookId, resolvedType);
                } else {
                    cancellation = { dispatchIds: [] };
                }
                await dispatchEngine.clearHubDispatches(cancellation.dispatchIds, {
                    hubUrl: config.HUB_URL,
                    apiKey: config.GPU_HUB_API_KEY,
                    context: 'CANCEL-WORKER',
                    warn: message => console.warn(message),
                });
                log(`[CANCEL-WORKER] ${bookId}: ${resolvedType} cancelled for ${scenesToCancel.length} scene(s)`);
            }

            log(`[CANCEL-WORKER] ${bookId}: type=${resolvedType} cancelled successfully`);
            res.json({
                ok: true,
                book_id: bookId,
                cancelled: [resolvedType],
                task_ids: tasks.map(task => task.task_id),
            });
        } catch (err) {
            console.error('[CANCEL-WORKER] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // CANCEL GENERATION (global — stops everything)
    // ======================================================
    app.post('/api/v1/book/:bookId/cancel-generation', async (req, res) => {
        try {
            const { bookId } = req.params;
            log(`[CANCEL-GENERATION] ${bookId}: cancelling generation`);

            await runtime.sceneWindow.setCancelFlag(redis, bookId);

            await runtime.scheduler.clearBookFromActiveIndex(redis, bookId);

            await redis.del('animastor:runtime:active-audio');
            await redis.del('animastor:runtime:active-image');
            await redis.del('animastor:runtime:active-video');

            await dispatchEngine.clearAllLeasesForBook(redis, bookId);

            // Clear per-worker cancel tracking (if any was set)
            await redis.del(`animastor:cancelled-workers:${bookId}`);
            await generationProgress.clear(redis, bookId);

            // Persist terminal state for GPU tasks.
            try {
                const cancelledTasks = await taskRepo.cancelActiveTasksForBook(bookId);
                if (cancelledTasks > 0) {
                    log(`[CANCEL-GENERATION] ${bookId}: ${cancelledTasks} generation task row(s) cancelled`);
                }
            } catch (pgErr) {
                console.warn(`[CANCEL-GENERATION] Failed to cancel generation task rows: ${pgErr.message}`);
            }

            // Cancel VBook/AI agent sessions too.
            try {
                const { query: pgQuery } = require('../../storage/postgres/database');
                await pgQuery(
                    `UPDATE agent_sessions SET status = 'cancelled', updated_at = $1
                     WHERE book_id = $2 AND status IN ('running', 'paused')`,
                    [Math.floor(Date.now() / 1000), bookId]
                );
                log(`[CANCEL-GENERATION] ${bookId}: VBook agent sessions cancelled`);
            } catch (pgErr) {
                console.warn(`[CANCEL-GENERATION] Failed to cancel VBook session: ${pgErr.message}`);
            }

            // Also clear GPU hub stale jobs via HTTP endpoint (T4: владелец ключей — gpu-hub)
            try {
                const hubUrl = `${config.HUB_URL}/queue/clear?book_id=${bookId}`;
                const hubOptions = { method: 'DELETE', headers: {} };
                if (config.GPU_HUB_API_KEY) {
                    hubOptions.headers['x-api-key'] = config.GPU_HUB_API_KEY;
                }
                const hubRes = await fetch(hubUrl, hubOptions);
                if (hubRes.ok) {
                    log(`[CANCEL-GENERATION] GPU hub queues cleared via HTTP for ${bookId}`);
                } else {
                    throw new Error(`GPU hub queue clear returned ${hubRes.status}`);
                }
            } catch (hubErr) {
                throw new Error(`GPU hub cleanup failed: ${hubErr.message}`);
            }

            log(`[CANCEL-GENERATION] ${bookId}: generation cancelled, counters + leases reset`);
            res.json({ ok: true, book_id: bookId });
        } catch (err) {
            console.error('[CANCEL-GENERATION] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // SELECTIVE REGENERATION
    // ======================================================
    app.post('/api/v1/book/:bookId/regenerate', async (req, res) => {
        const REGENERATE_LOCK_PREFIX = 'animastor:regenerate-lock';
        const LOCK_TTL = 120;
        const lockKey = `${REGENERATE_LOCK_PREFIX}:${req.params.bookId}`;
        const lockToken = `lock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const lockAcquired = await redis.set(lockKey, lockToken, 'NX', 'EX', LOCK_TTL);
        if (!lockAcquired) {
            log(`[REGENERATE] 🔒 Lock held for ${req.params.bookId} — rejecting duplicate`);
            return res.status(429).json({
                error: 'Regeneration already in progress for this book',
                retry_after_seconds: LOCK_TTL,
            });
        }

        const releaseRegenerateLock = async () => {
            try {
                const current = await redis.get(lockKey);
                if (current === lockToken) await redis.del(lockKey);
            } catch (_) { /* best-effort */ }
        };

        try {
            const { bookId } = req.params;
            const {
                scope,
                chapter_id,
                scene_id,
                worker_types: workerTypes,
                rebuild_all,
            } = req.body || {};

            const loadedBook = book.loadBook(bookId);
            if (!loadedBook) return res.status(404).json({ error: 'book not found' });

            const buildId = loadedBook.manifest?.build_id || 'default';

            await runtime.sceneWindow.clearCancelFlag(redis, bookId);
            // force-dispatch is owned by orchestrator.resetScenes().

            const effectiveScope = scope || 'whole_book';
            const persistedLayerCfg = await layerConfig.get(redis, bookId);
            const validWorkerTypes = new Set(['audio', 'image', 'video']);
            let requestedWorkerTypes;
            if (workerTypes !== undefined) {
                if (!Array.isArray(workerTypes) || workerTypes.length === 0 ||
                    workerTypes.some(type => !validWorkerTypes.has(type))) {
                    return res.status(400).json({
                        error: 'worker_types must be a non-empty array containing audio, image, or video',
                    });
                }
                requestedWorkerTypes = [...new Set(workerTypes)];
            } else {
                requestedWorkerTypes = ['audio', 'image', 'video'].filter(
                    type => persistedLayerCfg[`${type}_enabled`] !== false
                );
            }
            const requestedTypeSet = new Set(requestedWorkerTypes);
            const requestLayerCfg = {
                audio_enabled: requestedTypeSet.has('audio'),
                image_enabled: requestedTypeSet.has('image'),
                video_enabled: requestedTypeSet.has('video'),
            };

            const allScenes = book.collectScenes(loadedBook);
            let filteredDirty;

            if (rebuild_all) {
                const allDirty = allScenes.map(s => ({
                    chapter_id: s.chapter_id, scene_id: s.scene_id,
                    reason: 'rebuild', dirty_layers: requestedWorkerTypes,
                }));
                filteredDirty = bookDiff.filterDirtyScenesByScope(allDirty, effectiveScope, chapter_id, scene_id, allScenes);
                log(`[REGENERATE] ${bookId}: full rebuild — ${filteredDirty.length} scenes marked dirty`);
            } else if (chapter_id && scene_id) {
                const targetScene = allScenes.find(s => s.chapter_id === chapter_id && s.scene_id === scene_id);
                if (!targetScene) {
                    filteredDirty = [];
                } else {
                    const scenePayload = targetScene.payload || targetScene;
                    const changedUnitIds = [];
                    if (req.body.unit_id) {
                        changedUnitIds.push(req.body.unit_id);
                    } else {
                        const allUnits = [...(scenePayload.units || [])];
                        for (const db of (scenePayload.dialogue_blocks || [])) {
                            if (db.units) allUnits.push(...db.units);
                        }
                        for (const u of allUnits) {
                            if (u.id) changedUnitIds.push(String(u.id));
                        }
                    }
                    filteredDirty = [{
                        chapter_id, scene_id, reason: 'explicit_regen',
                        dirty_layers: requestedWorkerTypes,
                        changes: changedUnitIds.length > 0 ? { units: { unit_ids: changedUnitIds } } : null,
                    }];
                    log(`[REGENERATE] ${bookId}: primary path — created dirty entry for ${chapter_id}/${scene_id} (${changedUnitIds.length} units)`);
                    filteredDirty = bookDiff.filterDirtyScenesByScope(filteredDirty, effectiveScope, chapter_id, scene_id, allScenes);
                }
            } else {
                const existingBook = book.loadBook(bookId);
                const diff = bookDiff.computeBookDiff(existingBook, loadedBook);
                log(`[REGENERATE] ${bookId}: fallback diff — ${diff.changes.added} added, ${diff.changes.removed} removed, ${diff.changes.modified} modified`);
                filteredDirty = bookDiff.filterDirtyScenesByScope(diff.dirty_scenes, effectiveScope, chapter_id, scene_id, allScenes);

                if (filteredDirty.length === 0) {
                    log(`[REGENERATE] ${bookId}: diff empty — querying PG for dirty scenes`);
                    try {
                        const pgResult = await storage.postgres.query(`
                            SELECT chapter_id, scene_id, is_dirty, dirty_unit_ids
                            FROM scenes
                            WHERE book_id = $1
                              AND (is_dirty = TRUE OR (dirty_unit_ids IS NOT NULL AND array_length(dirty_unit_ids, 1) > 0))
                            ORDER BY chapter_id, scene_id
                        `, [bookId]);
                        if (pgResult.rows.length > 0) {
                            filteredDirty = pgResult.rows.map(row => ({
                                chapter_id: row.chapter_id, scene_id: row.scene_id,
                                reason: row.is_dirty ? 'version_stale' : 'dirty_units',
                                dirty_layers: ['image'],
                                changes: row.dirty_unit_ids && row.dirty_unit_ids.length > 0 ? { units: { unit_ids: row.dirty_unit_ids } } : null,
                            }));
                            filteredDirty = bookDiff.filterDirtyScenesByScope(filteredDirty, effectiveScope, chapter_id, scene_id, allScenes);
                            log(`[REGENERATE] ${bookId}: PG fallback found ${filteredDirty.length} dirty scene(s)`);
                        } else {
                            log(`[REGENERATE] ${bookId}: PG fallback also empty`);
                        }
                    } catch (pgErr) {
                        console.warn(`[REGENERATE] PG fallback query failed: ${pgErr.message}`);
                    }
                }
            }

            filteredDirty = filteredDirty
                .map(ds => ({
                    ...ds,
                    dirty_layers: (ds.dirty_layers || requestedWorkerTypes)
                        .filter(type => requestedTypeSet.has(type)),
                }))
                .filter(ds => ds.dirty_layers.length > 0);

            // ── Cover check — ensure cover scene is included in generation ──
            const coverCh = (loadedBook.chapters || []).find(ch => ch.type === 'cover');
            if (coverCh && coverCh.scenes && coverCh.scenes.length > 0 && requestedTypeSet.has('image')) {
                const coverScene = coverCh.scenes[0];
                const coverChapterId = coverCh.chapter;
                const coverSceneId = coverScene.scene_id;
                const alreadyDirty = filteredDirty.some(d => d.chapter_id === coverChapterId && d.scene_id === coverSceneId);
                if (!alreadyDirty && filteredDirty.length > 0) {
                    const buildDir = path.join(config.OUTPUT_DIR, buildId);
                    let coverHasImages = false;
                    try {
                        if (fs.existsSync(buildDir)) {
                            const iuPrefix = `${bookId}_${coverChapterId}_${coverSceneId}_iu`;
                            const files = fs.readdirSync(buildDir).filter(f => f.startsWith(iuPrefix) && f.endsWith('.png'));
                            const iuCount = (coverScene.units || []).length +
                                (coverScene.dialogue_blocks || []).reduce((sum, db) => sum + (db.units || []).length, 0);
                            coverHasImages = files.length >= iuCount && iuCount > 0;
                        }
                    } catch (_) {}
                    if (!coverHasImages) {
                        const coverLayers = ['image'];
                        if (requestedTypeSet.has('audio')) coverLayers.push('audio');
                        if (requestedTypeSet.has('video')) coverLayers.push('video');
                        filteredDirty.unshift({
                            chapter_id: coverChapterId, scene_id: coverSceneId,
                            reason: 'cover', dirty_layers: coverLayers,
                        });
                        log(`[REGENERATE] ${bookId}: Cover prepended to dirty scenes (ch=${coverChapterId} sc=${coverSceneId})`);
                    }
                }
            }

            // ── State management через единую команду фасада ──
            // T4 консолидации: resetScenes заменяет ручной ритуал очистки
            // force-dispatch, gen-scope, active index, lease, GPU queues,
            // iu-progress/in-flight, markDirty, re-add to active index.
            // Собираем мапу unit_id для pre-delete stale PNG.
            const cleanPngUnitIds = {};
            for (const ds of filteredDirty) {
                if (!ds.dirty_layers.includes('image')) continue;
                const unitIds = ds.changes?.units?.unit_ids;
                if (unitIds && Array.isArray(unitIds) && unitIds.length > 0) {
                    cleanPngUnitIds[`${ds.chapter_id}_${ds.scene_id}`] = unitIds;
                }
            }

            const marked = await orchestrator.resetScenes(redis, bookId, buildId, filteredDirty, requestLayerCfg, {
                scope: effectiveScope,
                chapterId: chapter_id || null,
                sceneId: scene_id || null,
                bookDiff,
                cleanPngUnitIds: Object.keys(cleanPngUnitIds).length > 0 ? cleanPngUnitIds : null,
                readdToActiveIndex: false,
            });

            // /regenerate is an execution command, not a content change. The
            // runtime reset above already marks the requested layers pending.
            // Running book-sync here would invalidate unrelated parallel tasks
            // for the same scene and bump content versions without an edit.
            for (const ds of filteredDirty) {
                if (!ds.dirty_layers.includes('image')) continue;
                const unitIds = ds.changes?.units?.unit_ids;
                if (!unitIds || !Array.isArray(unitIds) || unitIds.length === 0) continue;
                try {
                    await sceneAssetsRepo.setDirtyUnitIds(
                        bookId,
                        ds.chapter_id,
                        ds.scene_id,
                        unitIds
                    );
                } catch (pgErr) {
                    console.warn(
                        `[REGENERATE] Failed to persist dirty image units for ` +
                        `${ds.chapter_id}/${ds.scene_id}: ${pgErr.message}`
                    );
                }
            }

            const generationTasks = await generationProgress.createTasks(
                redis,
                bookId,
                requestedWorkerTypes,
                {
                    scope: effectiveScope,
                    chapterId: chapter_id || null,
                    sceneId: scene_id || null,
                },
                filteredDirty
            );

            for (const task of generationTasks) {
                for (const target of task.targets || []) {
                    try {
                        await taskRepo.createTask(
                            task.task_id,
                            bookId,
                            target.chapter_id,
                            target.scene_id,
                            task.type,
                            {
                                scope: task.scope,
                                chapter_id: task.chapter_id,
                                scene_id: task.scene_id,
                            }
                        );
                        await taskRepo.updateTaskStatus(task.task_id, 'running');
                    } catch (pgErr) {
                        console.warn(`[REGENERATE] Failed to persist task ${task.task_id}: ${pgErr.message}`);
                        break;
                    }
                }
            }

            // The scene stays outside the active index until task metadata is
            // complete. Missing an intermediate scheduler tick is harmless; the
            // next tick sees the fully registered command after this re-add.
            for (const ds of filteredDirty) {
                await runtime.scheduler.addSceneToActiveIndex(
                    redis,
                    bookId,
                    ds.chapter_id,
                    ds.scene_id
                );
            }

            res.json({
                book_id: bookId,
                scope: effectiveScope,
                dirty_scenes: filteredDirty,
                marked: marked.marked,
                tasks: generationTasks.map(task => ({
                    task_id: task.task_id,
                    type: task.type,
                    target_count: task.targets.length,
                })),
            });
        } catch (err) {
            console.error('[REGENERATE] Error:', err.message);
            res.status(500).json({ error: err.message });
        } finally {
            await releaseRegenerateLock();
        }
    });
};
