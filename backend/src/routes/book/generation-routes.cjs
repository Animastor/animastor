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
        placeholderAudio, layerConfig, genScope, activeScenes,
        utils, saveChunk, getChunk, getAllChunks, getBookWindowStatus,
        detectAvailableMode, recoverChunksFromDisk, recoverAllBooksFromDisk,
        cleanupService, bookDiff, taskHandler, windowGenerator,
        iuRepo, cleanBookRedisKeys,
    } = deps;
    const { log, pad, collectScenes, buildSegments } = utils;

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
            const scheduler = require('../../runtime/runtime-scheduler');
            await scheduler.clearBookFromActiveIndex(redis, bookId);

            const dispatchEngine = require('../../runtime/dispatch-engine');
            await dispatchEngine.clearAllLeasesForBook(redis, bookId);

            await redis.del('animastor:runtime:active-audio');
            await redis.del('animastor:runtime:active-image');
            await redis.del('animastor:runtime:active-video');

            await redis.set(`animastor:force-dispatch:${bookId}`, '1', 'EX', 120);

            const effectiveScope = scope || 'WHOLE_BOOK';
            await genScope.setScope(redis, bookId, effectiveScope, chapter_id, scene_id);

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
                        filteredDirty.unshift({
                            chapter_id: coverChapterId, scene_id: coverSceneId,
                            reason: 'cover', dirty_layers: coverLayers,
                        });
                        coverNeedsGeneration = true;
                        log(`[REGENERATE] ${bookId}: Cover prepended to dirty scenes (layers=${coverLayers.join(',')})`);
                    }
                }
            }

            filteredDirty = filteredDirty.filter(ds => {
                const resetAudio = layerCfg.audio_enabled !== false && ds.dirty_layers.includes('audio');
                const resetImage = layerCfg.image_enabled !== false && ds.dirty_layers.includes('image');
                const resetVideo = layerCfg.video_enabled !== false && ds.dirty_layers.includes('video');
                return resetAudio || resetImage || resetVideo;
            });

            // Pre-delete stale PNGs
            for (const ds of filteredDirty) {
                const unitIds = ds.changes?.units?.unit_ids;
                if (unitIds && Array.isArray(unitIds) && unitIds.length > 0) {
                    const buildDir = path.join(config.OUTPUT_DIR, buildId);
                    if (fs.existsSync(buildDir)) {
                        for (const uid of unitIds) {
                            const pngPath = path.join(buildDir, `${bookId}_${ds.chapter_id}_${ds.scene_id}_${uid}.png`);
                            try {
                                if (fs.existsSync(pngPath)) { fs.unlinkSync(pngPath); log(`[REGENERATE-PRE-DELETE] Deleted stale PNG: ${pngPath}`); }
                            } catch (delErr) { console.warn(`[REGENERATE-PRE-DELETE] Failed to delete ${pngPath}: ${delErr.message}`); }
                            const strippedUid = uid.replace(/^iu/, '');
                            const previewPath = path.join(buildDir, `${bookId}_${ds.chapter_id}_${ds.scene_id}_pr${strippedUid}.png`);
                            try {
                                if (fs.existsSync(previewPath)) { fs.unlinkSync(previewPath); log(`[REGENERATE-PRE-DELETE] Deleted stale preview: ${previewPath}`); }
                            } catch (delErr) { console.warn(`[REGENERATE-PRE-DELETE] Failed to delete ${previewPath}: ${delErr.message}`); }
                        }
                    }
                }
            }

            // Reset IU progress and in-flight markers
            for (const ds of filteredDirty) {
                const progKey = `animastor:iu-progress:${bookId}:${ds.chapter_id}:${ds.scene_id}:image`;
                try { await redis.del(progKey); } catch (_) {}
            }
            for (const ds of filteredDirty) {
                try {
                    const scenePrefix = `${bookId}_${ds.chapter_id}_${ds.scene_id}_iu-`;
                    let cursor = '0';
                    do {
                        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `animastor:iu-in-flight:${scenePrefix}*`, 'COUNT', 50);
                        cursor = nextCursor;
                        if (keys.length > 0) { await redis.del(...keys); log(`[REGENERATE-IU-IN-FLIGHT-CLEAR] ${bookId}/${ds.chapter_id}/${ds.scene_id}: cleared ${keys.length} markers`); }
                    } while (cursor !== '0');
                } catch (e) { console.warn(`[REGENERATE-IU-IN-FLIGHT-CLEAR] Failed for ${bookId}/${ds.chapter_id}/${ds.scene_id}: ${e.message}`); }
            }

            const { orchestrator: orch } = require('../../orchestration');
            const marked = await orch.markDirty({ bookDiff }, redis, bookId, buildId, filteredDirty, layerCfg);

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

            for (const ds of filteredDirty) {
                await scheduler.addSceneToActiveIndex(redis, bookId, ds.chapter_id, ds.scene_id);
            }
            log(`[REGENERATE] ${bookId}: added ${filteredDirty.length} scenes to active index for scheduling`);

            res.json({ book_id: bookId, scope: effectiveScope, dirty_scenes: filteredDirty, marked: marked.marked, cover_needs_generation: coverNeedsGeneration });
        } catch (err) {
            console.error('[REGENERATE] Error:', err.message);
            res.status(500).json({ error: err.message });
        } finally {
            await releaseRegenerateLock();
        }
    });
};
