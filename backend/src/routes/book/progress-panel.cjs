// ======================================================
// Progress Panel Route — independent generation task list
// ======================================================
//
// Every row represents one user-started generation task. Rows are keyed by
// task_id rather than worker type, so multiple Audio/Image/Video commands can
// run concurrently with different scopes and target scenes.
//
// Contract: JSON field "workers" in the API response is legacy, retained for
// backward compatibility. In new code use `rows`/`taskRows`; rename the JSON
// field only in a coordinated frontend+backend release (see
// docs/05-frontend/TASK_ARCHITECTURE.md §6).

const sceneAssetsRepo = require('../../storage/postgres/repositories/scene-assets-repo');
const { computeIuReady } = require('./iu-progress-utils.cjs');
const generationProgress = require('../../services/generation-progress');

module.exports = function(app, redis, deps) {
    const {
        state, activeScenes, iuRepo, book,
        utils, getChunk, getAllChunks,
    } = deps;
    const { log } = utils;

    /**
     * Resolve human-readable scene and chapter labels from the book JSON.
     * Parameters accept the already-loaded book data to avoid re-reading
     * the book file for each scene in a multi-target task.
     *
     * @param {object|null} bookData — result of book.loadBook(bookId)
     * @returns {{ scene_label: string|null, chapter_label: string|null }}
     */
    function resolveLabels(bookData, chapterId, sceneId) {
        if (!bookData || !chapterId) return { scene_label: null, chapter_label: null };

        const ch = (bookData.chapters || []).find(c => c.chapter === chapterId);
        if (!ch) return { scene_label: null, chapter_label: null };

        // Chapter label: "Chapter 2" or chapter_title or both
        let chapterLabel = null;
        if (ch.display_number != null) {
            chapterLabel = `Chapter ${ch.display_number}`;
        }
        if (ch.chapter_title && ch.chapter_title.trim()) {
            if (chapterLabel) {
                chapterLabel += ` — ${ch.chapter_title.trim()}`;
            } else {
                chapterLabel = ch.chapter_title.trim();
            }
        }

        // Scene label: "Scene 3" or scene_title or both
        let sceneLabel = null;
        if (!sceneId) return { scene_label: null, chapter_label: chapterLabel };

        const sc = (ch.scenes || []).find(s => s.scene_id === sceneId);
        if (!sc) return { scene_label: null, chapter_label: chapterLabel };

        const scIdx = sc.display_index;
        const scTitle = sc.scene_title && sc.scene_title.trim() ? sc.scene_title.trim() : null;

        if (scIdx > 0) {
            sceneLabel = `Scene ${scIdx}`;
            if (scTitle) sceneLabel += ` — ${scTitle}`;
        } else if (scTitle) {
            sceneLabel = scTitle;
        } else if (sc.type === 'cover') {
            sceneLabel = 'Cover';
        }

        return { scene_label: sceneLabel, chapter_label: chapterLabel };
    }

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

    async function buildTaskRows(bookId, task, chunkData, buildId) {
        const targets = task.targets || [];

        // Load book data once — reused across all resolveLabels calls
        const bookData = (() => { try { return book.loadBook(bookId); } catch (_) { return null; } })();

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

                const labels = resolveLabels(bookData, target.chapter_id, target.scene_id);
                result.push({
                    task_id: task.task_id || null,
                    type: task.type,
                    scope: task.scope || 'whole_book',
                    chapter_id: target.chapter_id,
                    scene_id: target.scene_id,
                    scene_label: labels.scene_label,
                    chapter_label: labels.chapter_label,
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

        const labels = resolveLabels(bookData, task.chapter_id || null, task.scene_id || null);

        // ── For range scopes (from_current_scene): resolve end labels from the last target ──
        // targets is an ordered array of { chapter_id, scene_id } fixed at task creation time.
        // The last entry represents the final scene in the scope. We resolve its labels so
        // the frontend can display a range like "Scene 12 — Scene 48".
        let endSceneLabel = null;
        let endChapterLabel = null;
        const lastTarget = targets.length > 0 ? targets[targets.length - 1] : null;
        if (lastTarget) {
            const endLabels = resolveLabels(bookData, lastTarget.chapter_id, lastTarget.scene_id);
            endSceneLabel = endLabels.scene_label;
            endChapterLabel = endLabels.chapter_label;
        }

        return [{
            task_id: task.task_id || null,
            type: task.type,
            scope: task.scope || 'whole_book',
            chapter_id: task.chapter_id || null,
            scene_id: task.scene_id || null,
            scene_label: labels.scene_label,
            chapter_label: labels.chapter_label,
            end_scene_label: endSceneLabel,
            end_chapter_label: endChapterLabel,
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

            const rows = [];
            for (const task of tasks) {
                const taskRows = await buildTaskRows(bookId, task, chunkData, buildId);
                rows.push(...taskRows);
            }

            const visibleTasks = rows.filter(t => t.visible);
            const anyIncomplete = visibleTasks.some(t => !t.done && !t.cancelled);
            const overallPercent = visibleTasks.length > 0
                ? Math.round(
                    visibleTasks.reduce((sum, t) => sum + t.percent, 0) /
                    visibleTasks.length
                )
                : 0;

            res.json({
                book_id: bookId,
                tasks: visibleTasks,
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
