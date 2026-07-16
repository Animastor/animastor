// ======================================================
// Book Generation Routes — Regenerate, Cancel, Generate Next
// ======================================================

const path = require('path');
const fs = require('fs');
const sceneAssetsRepo = require('../../storage/postgres/repositories/scene-assets-repo');
const { restoreSceneChunkStatus } = require('../../orchestration/scene-restoration');
const { computeIuReady } = require('./iu-progress-utils.cjs');

module.exports = function(app, redis, deps) {
    const {
        config, state, audio, image, video, book, orchestrator, storage,
        txtImporter, lazyBook, genSessionRepo, bookSourceRepo,
        placeholderAudio, layerConfig, activeScenes,
        utils, saveChunk, getChunk, getAllChunks, getBookWindowStatus,
        detectAvailableMode, recoverChunksFromDisk, recoverAllBooksFromDisk,
        cleanupService, bookDiff, taskHandler, windowGenerator,
        iuRepo, cleanBookRedisKeys,
    } = deps;
    const { log, pad, collectScenes, buildSegments } = utils;

    // ── Clear GPU hub stale jobs ────────────────────────
    // Shared between regenerate and cancel-generation.
    // Without this, old jobs (possibly with wrong build_id) stay in the
    // GPU hub queue and get processed, and new submissions with the same
    // job_id are rejected (animastor:job:* SET NX EX 3600 dedup).
    // Since backend & GPU hub share the same Redis, we clean up directly.
    //
    // @param {Array<{chapter_id:string,scene_id:string}>} [sceneFilter]
    //   If provided, only clears jobs for these specific scenes.
    //   Used by regenerate with filteredDirty so other scenes' jobs survive.
    //   cancel-generation omits this to wipe everything.
    async function clearGpuHubQueues(redis, bookId, sceneFilter) {
        // Build per-scene prefixes: bookId_chapterId_sceneId_ (used for precise filtering)
        const hasFilter = sceneFilter && sceneFilter.length > 0;
        const scenePrefixes = hasFilter
            ? new Set(sceneFilter.map(s => `${bookId}_${s.chapter_id}_${s.scene_id}_`))
            : null;
        const jobIdMatch = scenePrefixes
            ? (jobId) => { for (const p of scenePrefixes) { if (jobId.startsWith(p)) return true; } return false; }
            : (jobId) => jobId.startsWith(bookId + '_');

        // 1. Clear animastor:job:* dedup keys
        let cursor = '0';
        let total = 0;
        do {
            const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `animastor:job:${bookId}_*`, 'COUNT', 100);
            cursor = nextCursor;
            const toDelete = [];
            for (const key of keys) {
                const jobId = key.replace(/^animastor:job:/, '');
                if (jobIdMatch(jobId)) toDelete.push(key);
            }
            if (toDelete.length > 0) {
                await redis.del(toDelete);
                total += toDelete.length;
            }
        } while (cursor !== '0');
        if (total > 0) log(`[GPU-HUB] Cleared ${total} animastor:job:* dedup keys`);

        // 2. Clear animastor:result-processed:* dedup keys
        cursor = '0';
        total = 0;
        do {
            const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `animastor:result-processed:${bookId}_*`, 'COUNT', 100);
            cursor = nextCursor;
            const toDelete = [];
            for (const key of keys) {
                const jobId = key.replace(/^animastor:result-processed:/, '').split(':')[0];
                if (jobIdMatch(jobId)) toDelete.push(key);
            }
            if (toDelete.length > 0) {
                await redis.del(toDelete);
                total += toDelete.length;
            }
        } while (cursor !== '0');
        if (total > 0) log(`[GPU-HUB] Cleared ${total} animastor:result-processed:* keys`);

        // 3. Clear GPU hub task queues (filter by scene prefix in job_id)
        const queueKeys = ['animastor:queue:audio', 'animastor:queue:image', 'animastor:queue:video'];
        for (const qkey of queueKeys) {
            const items = await redis.lrange(qkey, 0, -1);
            const remaining = [];
            let cleaned = 0;
            for (const item of items) {
                try {
                    const parsed = JSON.parse(item);
                    if (parsed.job_id && jobIdMatch(parsed.job_id)) {
                        cleaned++;
                    } else {
                        remaining.push(item);
                    }
                } catch (_) { remaining.push(item); }
            }
            if (cleaned > 0) {
                await redis.del(qkey);
                if (remaining.length > 0) {
                    await redis.rpush(qkey, ...remaining);
                }
                log(`[GPU-HUB] Cleaned ${cleaned} stale jobs from ${qkey}`);
            }
        }

        // 4. Clear animastor:running entries (filter by scene prefix)
        let hcursor = '0';
        let runningCleaned = 0;
        do {
            const [nextCursor, entries] = await redis.hscan('animastor:running', hcursor, 'COUNT', 100);
            hcursor = nextCursor;
            for (let i = 0; i < entries.length; i += 2) {
                if (jobIdMatch(entries[i])) {
                    await redis.hdel('animastor:running', entries[i]);
                    runningCleaned++;
                }
            }
        } while (hcursor !== '0');
        if (runningCleaned > 0) log(`[GPU-HUB] Removed ${runningCleaned} running jobs`);

        // 5. Clear GPU hub result keys for this book.
        // Key format: animastor:result:{build_id}:{bookId}:{chapterId}:{sceneId}:{type}
        // We need to match results that contain :{scene_chapter_scene}_ in the suffix.
        cursor = '0';
        total = 0;
        do {
            const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `animastor:result:*:${bookId}_*`, 'COUNT', 100);
            cursor = nextCursor;
            const toDelete = [];
            for (const key of keys) {
                // Key format: animastor:result:{bid}:{bookId}:{chapterId}:{sceneId}:{type}
                // Extract the chapterId:sceneId part after bookId
                const parts = key.split(':');
                // parts[0]='animastor', parts[1]='result', parts[2]=build_id, parts[3]=bookId, parts[4]=chapterId, parts[5]=sceneId
                if (parts.length >= 6 && parts[3] === bookId) {
                    if (!hasFilter || scenePrefixes.has(`${bookId}_${parts[4]}_${parts[5]}_`)) {
                        toDelete.push(key);
                    }
                }
            }
            if (toDelete.length > 0) {
                await redis.del(toDelete);
                total += toDelete.length;
            }
        } while (cursor !== '0');
        if (total > 0) log(`[GPU-HUB] Cleared ${total} animastor:result:* keys`);
    }

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
            const windowModule = require('../../runtime/scene-window');
            const result = await windowModule.slideWindow(redis, bookId, loadedBook, buildId);
            const newIds = await getAllChunks(bookId);
            res.json({ started: result.started, remaining: result.remaining, chunk_ids: newIds });
        } catch (err) {
            console.error('❌ GENERATE-NEXT ERROR:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // LAYER CONFIG (read / write) — canonical generation profile
    //
    // The `profile` field is computed server-side (resolveProfile) so clients
    // never re-derive it from the audio/image/video toggles. Clients send only
    // the toggles; the server owns the 8-state profile mapping.
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
                profile: layerConfig.resolveProfile(cfg),
            });
        } catch (err) {
            console.error('[LAYER-CONFIG] GET error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    app.put('/api/v1/book/:bookId/layer-config', async (req, res) => {
        try {
            const { bookId } = req.params;
            const { audio_enabled, image_enabled, video_enabled } = req.body || {};
            const cfg = await layerConfig.set(redis, bookId, {
                audio_enabled, image_enabled, video_enabled,
            });
            const profile = layerConfig.resolveProfile(cfg);
            log(`[LAYER-CONFIG] book=${bookId} → a=${cfg.audio_enabled} i=${cfg.image_enabled} v=${cfg.video_enabled} profile=${profile}`);
            res.json({
                book_id: bookId,
                audio_enabled: cfg.audio_enabled,
                image_enabled: cfg.image_enabled,
                video_enabled: cfg.video_enabled,
                profile,
            });
        } catch (err) {
            console.error('[LAYER-CONFIG] PUT error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // CANCEL GENERATION
    // ======================================================
    app.post('/api/v1/book/:bookId/cancel-generation', async (req, res) => {
        try {
            const { bookId } = req.params;
            log(`[CANCEL-GENERATION] ${bookId}: cancelling generation`);

            const windowModule = require('../../runtime/scene-window');
            await windowModule.setCancelFlag(redis, bookId);

            const scheduler = require('../../runtime/runtime-scheduler');
            await scheduler.clearBookFromActiveIndex(redis, bookId);

            await redis.del('animastor:runtime:active-audio');
            await redis.del('animastor:runtime:active-image');
            await redis.del('animastor:runtime:active-video');

            const dispatchEngine = require('../../runtime/dispatch-engine');
            await dispatchEngine.clearAllLeasesForBook(redis, bookId);

            // Also clear GPU hub stale jobs via HTTP endpoint (T4: владелец ключей — gpu-hub)
            try {
                const hubUrl = `${config.HUB_URL}/queue/clear?book_id=${bookId}`;
                const hubRes = await fetch(hubUrl, { method: 'DELETE' });
                if (hubRes.ok) {
                    log(`[CANCEL-GENERATION] GPU hub queues cleared via HTTP for ${bookId}`);
                } else {
                    log(`[CANCEL-GENERATION] GPU hub queue clear returned ${hubRes.status} — falling back to direct`);
                    await clearGpuHubQueues(redis, bookId);
                }
            } catch (hubErr) {
                log(`[CANCEL-GENERATION] GPU hub HTTP error: ${hubErr.message} — falling back to direct`);
                await clearGpuHubQueues(redis, bookId);
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
            const { scope, chapter_id, scene_id, profile, rebuild_all } = req.body || {};

            const loadedBook = book.loadBook(bookId);
            if (!loadedBook) return res.status(404).json({ error: 'book not found' });

            const buildId = loadedBook.manifest?.build_id || 'default';

            const windowModule = require('../../runtime/scene-window');
            await windowModule.clearCancelFlag(redis, bookId);
            // Note: force-dispatch и gen-scope устанавливаются внутри
            // orchestrator.resetScenes() — не дублировать здесь (T4).

            const effectiveScope = scope || 'WHOLE_BOOK';

            const layerCfg = profile
                ? await bookDiff.applyProfileToLayerConfig(redis, bookId, profile)
                : await layerConfig.get(redis, bookId);
            if (!layerCfg) {
                return res.status(400).json({ error: 'No layer config found for this book' });
            }

            const allScenes = book.collectScenes(loadedBook);
            let filteredDirty;

            if (rebuild_all) {
                const buildDir = path.join(config.OUTPUT_DIR, buildId);
                let allDiskFiles = [];
                if (fs.existsSync(buildDir)) {
                    allDiskFiles = fs.readdirSync(buildDir).filter(f => f.endsWith('.png'));
                }
                const needsRebuild = [];
                const alreadyComplete = [];
                for (const s of allScenes) {
                    const iuPrefix = `${bookId}_${s.chapter_id}_${s.scene_id}_iu`;
                    const pngCount = allDiskFiles.filter(f => f.startsWith(iuPrefix)).length;
                    const iuCount = (s.units || []).length + ((s.dialogue_blocks || []).reduce((sum, db) => sum + (db.units || []).length, 0));
                    if (pngCount >= iuCount && iuCount > 0) {
                        alreadyComplete.push(s);
                        continue;
                    }
                    needsRebuild.push(s);
                }

                if (alreadyComplete.length > 0) {
                    log(`[REGENERATE] ${bookId}: full rebuild — ${alreadyComplete.length}/${allScenes.length} scenes already have images, skipping`);
                }

                const allDirty = needsRebuild.map(s => ({
                    chapter_id: s.chapter_id, scene_id: s.scene_id,
                    reason: 'rebuild', dirty_layers: ['audio', 'image', 'video'],
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
                        dirty_layers: ['image'],
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

            // Cover check
            const coverCh = (loadedBook.chapters || []).find(ch => ch.type === 'cover');
            let coverNeedsGeneration = false;
            if (coverCh && coverCh.scenes && coverCh.scenes.length > 0 && layerCfg.image_enabled !== false) {
                const coverScene = coverCh.scenes[0];
                const coverChapterId = coverCh.chapter;
                const coverSceneId = coverScene.scene_id;
                const alreadyDirty = filteredDirty.some(d => d.chapter_id === coverChapterId && d.scene_id === coverSceneId);
                if (!alreadyDirty) {
                    const buildDir = path.join(config.OUTPUT_DIR, buildId);
                    let coverHasImages = false;
                    if (fs.existsSync(buildDir)) {
                        const iuPrefix = `${bookId}_${coverChapterId}_${coverSceneId}_iu`;
                        const files = fs.readdirSync(buildDir).filter(f => f.startsWith(iuPrefix) && f.endsWith('.png'));
                        const iuCount = (coverScene.units || []).length;
                        coverHasImages = files.length >= iuCount && iuCount > 0;
                    }
                    if (!coverHasImages) {
                        const coverLayers = ['audio', 'image'];
                        if (layerCfg.video_enabled !== false) coverLayers.push('video');
                        const coverUnits = [...(coverScene.units || [])];
                        for (const db of (coverScene.dialogue_blocks || [])) {
                            if (db.units) coverUnits.push(...db.units);
                        }
                        const coverUnitIds = coverUnits.map(u => String(u.id)).filter(Boolean);
                        filteredDirty.unshift({
                            chapter_id: coverChapterId, scene_id: coverSceneId,
                            reason: 'cover', dirty_layers: coverLayers,
                            changes: coverUnitIds.length > 0 ? { units: { unit_ids: coverUnitIds } } : null,
                        });
                        coverNeedsGeneration = true;
                        log(`[REGENERATE] ${bookId}: Cover prepended to dirty scenes (units=${coverUnitIds.length})`);
                    }
                }
            }

            filteredDirty = filteredDirty.filter(ds => {
                const resetAudio = layerCfg.audio_enabled !== false && ds.dirty_layers.includes('audio');
                const resetImage = layerCfg.image_enabled !== false && ds.dirty_layers.includes('image');
                const resetVideo = layerCfg.video_enabled !== false && ds.dirty_layers.includes('video');
                return resetAudio || resetImage || resetVideo;
            });

            // ── State management через единую команду фасада ──
            // T4 консолидации: resetScenes заменяет ручной ритуал очистки
            // force-dispatch, gen-scope, active index, lease, GPU queues,
            // iu-progress/in-flight, markDirty, re-add to active index.
            // Собираем мапу unit_id для pre-delete stale PNG.
            const cleanPngUnitIds = {};
            for (const ds of filteredDirty) {
                const unitIds = ds.changes?.units?.unit_ids;
                if (unitIds && Array.isArray(unitIds) && unitIds.length > 0) {
                    cleanPngUnitIds[`${ds.chapter_id}_${ds.scene_id}`] = unitIds;
                }
            }

            const { orchestrator: orch } = require('../../orchestration');
            const marked = await orch.resetScenes(redis, bookId, buildId, filteredDirty, layerCfg, {
                scope: effectiveScope,
                chapterId: chapter_id || null,
                sceneId: scene_id || null,
                bookDiff,
                cleanPngUnitIds: Object.keys(cleanPngUnitIds).length > 0 ? cleanPngUnitIds : null,
            });

            try {
                await storage.bookSync.reconcileFromDiff(bookId, filteredDirty, loadedBook);
                try {
                    await sceneAssetsRepo.bumpSceneVersions(bookId, filteredDirty);
                    for (const ds of filteredDirty) {
                        const unitIds = ds.changes?.units?.unit_ids;
                        if (unitIds && Array.isArray(unitIds) && unitIds.length > 0) {
                            await sceneAssetsRepo.setDirtyUnitIds(bookId, ds.chapter_id, ds.scene_id, unitIds);
                        }
                    }
                } catch (verErr) { console.warn(`[REGENERATE] Version bump failed: ${verErr.message}`); }
            } catch (syncErr) { console.warn(`[REGENERATE] PG reconcile failed for ${bookId}: ${syncErr.message}`); }

            let restoredCount = 0;
            for (const ds of filteredDirty) {
                const hasDirtyUnits = ds.changes?.units?.unit_ids && ds.changes.units.unit_ids.length > 0;
                const unitIds = hasDirtyUnits ? ds.changes.units.unit_ids : [];
                const result = await restoreSceneChunkStatus(redis, buildId, bookId, ds.chapter_id, ds.scene_id, hasDirtyUnits, unitIds);
                if (result.restored) restoredCount++;
            }
            if (restoredCount > 0) {
                log(`[REGENERATE] ${bookId}: restored chunk metadata for ${restoredCount}/${filteredDirty.length} scenes with existing content`);
            }

            // Note: addSceneToActiveIndex выполняется внутри orchestrator.resetScenes() —
            // не дублировать, чтобы не добавить сцены дважды.

            res.json({ book_id: bookId, scope: effectiveScope, dirty_scenes: filteredDirty, marked: marked.marked, cover_needs_generation: coverNeedsGeneration });
        } catch (err) {
            console.error('[REGENERATE] Error:', err.message);
            res.status(500).json({ error: err.message });
        } finally {
            await releaseRegenerateLock();
        }
    });
};
