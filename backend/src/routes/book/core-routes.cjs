// ======================================================
// Core Book Routes — GET/PUT/PATCH/DELETE + Cover
// ======================================================

const path = require('path');
const fs = require('fs');
const sceneAssetsRepo = require('../../storage/postgres/repositories/scene-assets-repo');
const { restoreSceneChunkStatus } = require('../../orchestration/scene-restoration');
const { setDeep, findUnitInScene } = require('./scene-patch-utils.cjs');
const { recoverMissingRedisChunks } = require('./recover-chunks.cjs');
const sourceCoverageAudit = require('../../services/source-coverage-audit');

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
    // GET BOOK DATA
    // ======================================================
    app.get('/api/v1/book/:bookId', async (req, res) => {
        try {
            const { bookId } = req.params;
            const bookData = book.loadBook(bookId);
            if (!bookData) return res.status(404).json({ error: 'Book not found' });

            // ── Enrich chapters (F5+F7): fill missing chapter_title + compute display indices ──
            if (bookData.chapters && Array.isArray(bookData.chapters)) {
                let displayNum = 0;
                for (const ch of bookData.chapters) {
                    // F7: Fill chapter_title from chapter.intro.text if missing.
                    if (!ch.chapter_title && ch.intro && ch.intro.text) {
                        const separators = [' — ', ' – ', '. ', '! ', '? '];
                        for (const sep of separators) {
                            const idx = ch.intro.text.indexOf(sep);
                            if (idx > 0 && idx < ch.intro.text.length - sep.length) {
                                const candidate = ch.intro.text.substring(idx + sep.length).trim()
                                    .replace(/\.$/, '').replace(/!$/, '').replace(/\?$/, '').trim();
                                if (candidate) {
                                    ch.chapter_title = candidate;
                                    break;
                                }
                            }
                        }
                    }
                    // F5: Compute display_number (1-based, excludes cover/prologue).
                    if (ch.type !== 'cover' && ch.type !== 'prologue') {
                        displayNum++;
                        ch.display_number = displayNum;
                    }
                    // F5: Compute display_index for each scene (1-based within chapter).
                    if (ch.scenes && Array.isArray(ch.scenes)) {
                        ch.scenes.forEach((sc, idx) => {
                            sc.display_index = idx + 1;
                        });
                    }
                }
            }

            const buildId = bookData?.manifest?.build_id || 'default';
            try {
                const phResult = await placeholderAudio.recoverMissingPlaceholders(buildId, bookId);
                if (phResult.created > 0 || phResult.errors.length > 0) {
                    log(`[BOOK-RECOVER] ${bookId}: ${phResult.created} placeholders created, ${phResult.errors.length} errors`);
                }
            } catch (recErr) {
                console.warn(`[BOOK-RECOVER] ${bookId}: placeholder recovery failed: ${recErr.message}`);
            }

            try {
                await recoverMissingRedisChunks({ redis, book, state, activeScenes, config, getAllChunks, saveChunk, log }, buildId, bookId);
            } catch (chunkErr) {
                console.warn(`[BOOK-RECOVER] ${bookId}: chunk recovery failed: ${chunkErr.message}`);
            }

            return res.json(bookData);
        } catch (err) {
            console.error('[GET BOOK] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/v1/book/:bookId/source-coverage', async (req, res) => {
        try {
            const { bookId } = req.params;
            const report = sourceCoverageAudit.auditBookCoverage(bookId);
            return res.json(report);
        } catch (err) {
            console.error('[SOURCE-COVERAGE] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // UPDATE BOOK DATA (PUT — full replace with merge)
    // ======================================================
    app.put('/api/v1/book/:bookId', async (req, res) => {
        try {
            const { bookId } = req.params;
            const updatedBookData = req.body;
            if (!updatedBookData || !updatedBookData.manifest || !updatedBookData.manifest.book_id) {
                return res.status(400).json({ error: 'Invalid book data: manifest.book_id required' });
            }
            if (updatedBookData.manifest.book_id !== bookId) {
                return res.status(400).json({ error: 'bookId mismatch' });
            }

            const oldBook = book.loadBook(bookId);

            if (oldBook) {
                const oldChars = oldBook.characters;
                if (updatedBookData.characters && Array.isArray(updatedBookData.characters)) {
                    if (updatedBookData.characters.length === 0 && oldChars && oldChars.length > 0) {
                        updatedBookData.characters = oldChars;
                        log(`[UPDATE BOOK] ${bookId}: preserved ${oldChars.length} character passports from existing book (empty array)`);
                    } else if (oldChars && oldChars.length > 0) {
                        let mergedCount = 0;
                        const mergedChars = updatedBookData.characters.map(incomingChar => {
                            const oldChar = oldChars.find(c => c && c.id === incomingChar.id);
                            if (oldChar && oldChar.passport) {
                                const ip = incomingChar.passport;
                                const hasPassportData = ip && (
                                    ip.base_appearance || ip.detailed_appearance ||
                                    ip.clothing_base || ip.clothing_details
                                );
                                if (!hasPassportData) {
                                    mergedCount++;
                                    return { ...incomingChar, passport: oldChar.passport };
                                }
                            }
                            return incomingChar;
                        });
                        for (const oldChar of oldChars) {
                            if (oldChar && !mergedChars.find(c => c && c.id === oldChar.id)) {
                                mergedChars.push(oldChar);
                            }
                        }
                        if (mergedCount > 0 || mergedChars.length > updatedBookData.characters.length) {
                            updatedBookData.characters = mergedChars;
                            log(`[UPDATE BOOK] ${bookId}: deep-merged passport data for ${mergedCount} characters, added ${mergedChars.length - updatedBookData.characters.length} missing`);
                        }
                    }
                } else if (!updatedBookData.characters) {
                    if (oldChars && oldChars.length > 0) {
                        updatedBookData.characters = oldChars;
                        log(`[UPDATE BOOK] ${bookId}: preserved ${oldChars.length} character passports from existing book (null)`);
                    }
                }
                if (!updatedBookData.bible || (typeof updatedBookData.bible === 'object' && Object.keys(updatedBookData.bible).length === 0)) {
                    if (oldBook.bible && Object.keys(oldBook.bible).length > 0) {
                        updatedBookData.bible = oldBook.bible;
                        log(`[UPDATE BOOK] ${bookId}: preserved bible data from existing book`);
                    }
                }
                if (!updatedBookData.manifest || !updatedBookData.manifest.book_id) {
                    if (oldBook.manifest && oldBook.manifest.book_id) {
                        updatedBookData.manifest = oldBook.manifest;
                        log(`[UPDATE BOOK] ${bookId}: preserved manifest from existing book`);
                    }
                }
            }

            book.saveBookBundle(updatedBookData, null);
            log(`[UPDATE BOOK] ${bookId}: ${updatedBookData.chapters?.length || 0} chapters saved`);

            const newBook = book.loadBook(bookId) || updatedBookData;

            try {
                const diff = bookDiff.computeBookDiff(oldBook || { chapters: [] }, newBook);
                if (diff.dirty_scenes.length > 0) {
                    const syncResult = await storage.bookSync.reconcileFromDiff(bookId, diff.dirty_scenes, newBook);
                    log(`[UPDATE BOOK] ${bookId}: reconciled ${syncResult.reconciled} scenes`);

                    try {
                        await sceneAssetsRepo.bumpSceneVersions(bookId, diff.dirty_scenes);
                        for (const ds of diff.dirty_scenes) {
                            if (ds.reason === 'removed') continue;
                            if (ds.changes && typeof ds.changes === 'object') {
                                const crossKeys = Object.keys(ds.changes).filter(k =>
                                    k.includes('Character') || k.includes('Location') ||
                                    k.includes('characters') || k.includes('bible') ||
                                    k.includes('passport') || k.includes('voice')
                                );
                                if (crossKeys.length > 0) {
                                    log(`[CROSS-CUTTING] ${bookId}/${ds.chapter_id}/${ds.scene_id}: version bump triggered by ${crossKeys.join(', ')}`);
                                }
                            }
                        }
                        for (const ds of diff.dirty_scenes) {
                            const unitIds = ds.changes?.units?.unit_ids;
                            if (unitIds && Array.isArray(unitIds) && unitIds.length > 0) {
                                await sceneAssetsRepo.setDirtyUnitIds(bookId, ds.chapter_id, ds.scene_id, unitIds);
                                log(`[DIRTY-UNITS] ${bookId}/${ds.chapter_id}/${ds.scene_id}: ${unitIds.length} dirty unit(s): ${unitIds.join(', ')}`);
                            }
                        }
                    } catch (verErr) {
                        console.warn(`[UPDATE BOOK] Version bump/failed: ${verErr.message}`);
                    }
                }
            } catch (syncErr) {
                console.warn(`[UPDATE BOOK] PG reconcile failed for ${bookId}: ${syncErr.message}`);
            }

            return res.json({ saved: true, book_id: bookId });
        } catch (err) {
            console.error('[UPDATE BOOK] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // PATCH BOOK DATA (targeted update — no round-trip loss)
    // ======================================================
    app.patch('/api/v1/book/:bookId/scene/:chapterId/:sceneId', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const { scene: incomingScene, unit_id, chapter_title, fields } = req.body;

            if (!incomingScene && !unit_id && !fields) {
                return res.status(400).json({ error: 'Provide "scene", "unit_id", or "fields"' });
            }

            const oldBook = book.loadBook(bookId);
            if (!oldBook) return res.status(404).json({ error: 'Book not found' });

            const bookBeforePatch = JSON.parse(JSON.stringify(oldBook));

            let targetScene = null;
            let targetChapter = null;
            let sceneIndex = -1;
            for (const ch of oldBook.chapters) {
                if (ch.chapter === chapterId && ch.scenes) {
                    for (let i = 0; i < ch.scenes.length; i++) {
                        if (ch.scenes[i].scene_id === sceneId) {
                            targetScene = ch.scenes[i];
                            targetChapter = ch;
                            sceneIndex = i;
                            break;
                        }
                    }
                }
                if (targetScene) break;
            }

            if (!targetScene) {
                return res.status(404).json({ error: 'Scene not found in book' });
            }

            if (fields) {
                // F8: flat dotted-path fields — server merges using setDeep().
                // The frontend sends { fields: { "key": "value", ... } } where keys
                // can be dotted paths like "location.id", "env.time", "visual.prompt".
                if (unit_id) {
                    const unit = findUnitInScene(targetScene, unit_id);
                    if (!unit) {
                        return res.status(404).json({ error: `Unit ${unit_id} not found in scene` });
                    }
                    for (const [key, value] of Object.entries(fields)) {
                        setDeep(unit, key, value === '' ? null : value);
                    }
                    log(`[PATCH BOOK] ${bookId}/${chapterId}/${sceneId}/${unit_id}: fields=${Object.keys(fields).join(', ')}`);
                } else {
                    for (const [key, value] of Object.entries(fields)) {
                        // scene_title → scene_title, location.id → location.id, env.time → location.environment.time
                        const resolvedKey = key.startsWith('env.') ? 'location.environment.' + key.slice(4) : key;
                        setDeep(targetScene, resolvedKey, value === '' ? null : value);
                        // Special handling for participants (comma-separated string → array)
                        if (key === 'participants' && typeof value === 'string') {
                            setDeep(targetScene, 'participants', value ? value.split(', ').map(s => s.trim()) : null);
                        }
                    }
                    log(`[PATCH BOOK] ${bookId}/${chapterId}/${sceneId}: fields=${Object.keys(fields).join(', ')}`);
                }
            } else if (unit_id) {
                const unit = findUnitInScene(targetScene, unit_id);
                if (!unit) {
                    return res.status(404).json({ error: `Unit ${unit_id} not found in scene` });
                }
                const unitFields = {};
                for (const [key, value] of Object.entries(req.body)) {
                    if (key === 'unit_id' || key === 'chapter_title' || key === 'scene' || key === 'fields') continue;
                    unitFields[key] = value;
                }
                if (Object.keys(unitFields).length === 0) {
                    return res.status(400).json({ error: 'No unit fields to update' });
                }
                for (const [key, value] of Object.entries(unitFields)) {
                    setDeep(unit, key, value);
                }
                log(`[PATCH BOOK] ${bookId}/${chapterId}/${sceneId}/${unit_id}: ${Object.keys(unitFields).join(', ')}`);
            } else {
                oldBook.chapters.find(ch => ch.chapter === chapterId).scenes[sceneIndex] = incomingScene;
                log(`[PATCH BOOK] ${bookId}/${chapterId}/${sceneId}: full scene replaced`);
            }

            if (chapter_title !== undefined && chapter_title !== null && targetChapter) {
                targetChapter.chapter_title = chapter_title;
            }

            book.saveBookBundle(oldBook, null);

            const newBook = book.loadBook(bookId) || oldBook;
            const diff = bookDiff.computeBookDiff(bookBeforePatch, newBook);

            if (diff.dirty_scenes.length > 0) {
                try {
                    await storage.bookSync.reconcileFromDiff(bookId, diff.dirty_scenes, newBook);
                    await sceneAssetsRepo.bumpSceneVersions(bookId, diff.dirty_scenes);
                    for (const ds of diff.dirty_scenes) {
                        const ids = ds.changes?.units?.unit_ids;
                        if (ids && Array.isArray(ids) && ids.length > 0) {
                            await sceneAssetsRepo.setDirtyUnitIds(bookId, ds.chapter_id, ds.scene_id, ids);
                        }
                    }
                } catch (syncErr) {
                    console.warn(`[PATCH BOOK] PG reconcile/bump failed: ${syncErr.message}`);
                }
            }

            return res.json({
                saved: true, book_id: bookId, chapter_id: chapterId, scene_id: sceneId,
                unit_id: unit_id || null, dirty_scenes: diff.dirty_scenes.length,
            });
        } catch (err) {
            console.error('[PATCH BOOK] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // GET BOOK COVER DATA
    // ======================================================
    app.get('/api/v1/book/:bookId/cover', async (req, res) => {
        try {
            const { bookId } = req.params;
            const bookData = book.loadBook(bookId);
            if (!bookData) {
                return res.status(404).json({ error: 'Book not found' });
            }
            const coverCh = (bookData.chapters || []).find(ch => ch.type === 'cover');
            if (!coverCh || !coverCh.scenes || coverCh.scenes.length === 0) {
                return res.status(404).json({ error: 'Cover not found for this book' });
            }
            return res.json(coverCh.scenes[0]);
        } catch (err) {
            console.error('[GET COVER] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // DELETE BOOK
    // ======================================================
    app.delete('/api/v1/book/:bookId', async (req, res) => {
        try {
            const { bookId } = req.params;
            log('[DELETE-BOOK] Deleting', bookId);

            await book.resetBook(bookId);
            const snapshotPath = path.join(config.BOOKS_DIR || '/data/books', `${bookId}.snapshot.json`);
            if (fs.existsSync(snapshotPath)) {
                try { fs.unlinkSync(snapshotPath); } catch (_) {}
            }

            const OUTPUT_DIR = config.OUTPUT_DIR;
            const chunkIds = await getAllChunks(bookId).catch(() => []);
            const buildIds = new Set();
            for (const cid of chunkIds) {
                try {
                    const chunk = await getChunk(cid);
                    if (chunk?.build_id) buildIds.add(chunk.build_id);
                } catch (_) {}
            }
            for (const buildId of buildIds) {
                const buildPath = path.join(OUTPUT_DIR, buildId);
                if (fs.existsSync(buildPath)) {
                    try { fs.rmSync(buildPath, { recursive: true, force: true }); } catch (_) {}
                }
            }
            if (fs.existsSync(OUTPUT_DIR)) {
                for (const entry of fs.readdirSync(OUTPUT_DIR)) {
                    if (entry.startsWith(bookId)) {
                        const entryPath = path.join(OUTPUT_DIR, entry);
                        try { fs.rmSync(entryPath, { recursive: true, force: true }); } catch (_) {}
                    }
                }
            }

            const windowModule = require('../../runtime/scene-window');
            await windowModule.setCancelFlag(redis, bookId);
            await redis.del('animastor:runtime:active-audio');
            await redis.del('animastor:runtime:active-image');
            await redis.del('animastor:runtime:active-video');
            await cleanBookRedisKeys(redis, bookId);

            // ── Clean ALL PG tables — each with individual try/catch so one
            //    failure (e.g. table doesn't exist in an older schema) doesn't
            //    block cleanup of the remaining tables.
            const pgTables = [
                // Per-layer & asset tables (book_id as plain TEXT, no FK)
                'image_units',
                'scenes',
                'asset_states',
                'asset_dependencies',
                'generation_tasks',
                'reconciliation_events',
                'output_manifests',
                'cache_entries',
                'book_source',
                'chat_messages',
                'chat_sessions',
                'agent_sessions',
                'book_generation_sessions',
                'ai_chat_sessions',
                'book_events',
                'scene_assets',
                // Coreference resolution tables
                'character_resolution_runs',
                'character_window_candidates',
                'sentence_resolutions',
                'character_mentions',
                'character_aliases',
                // Tables with FK to books — delete before books
                'storyboard_elements',
                'audio_layers',
                'book_snapshots',
                // books LAST (may have FK cascades)
                'books',
            ];
            for (const table of pgTables) {
                try {
                    await storage.postgres.query(`DELETE FROM ${table} WHERE book_id = $1`, [bookId]);
                } catch (tblErr) {
                    // Table may not exist in older schemas — non-fatal
                    console.warn(`[DELETE-BOOK] DB cleanup: ${table}: ${tblErr.message}`);
                }
            }

            try {
                const HUB_URL = process.env.HUB_URL || 'https://animastor.in/gpu';
                await fetch(`${HUB_URL}/queue/clear?book_id=${bookId}`, { method: 'DELETE' }).catch(() => {});
            } catch (_) {}

            log('[DELETE-BOOK] Book completely deleted:', bookId);
            res.json({ deleted: true, book_id: bookId });
        } catch (err) {
            console.error('[DELETE-BOOK] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
};
