// ======================================================
// ANIMASTOR BACKEND — BOOK ROUTES
// ======================================================
// All /api/v1/book/* endpoints.
//
// Usage:
//   require('./routes/book-routes.cjs')(app, redis, deps);

const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sceneAssetsRepo = require('../storage/postgres/repositories/scene-assets-repo');
const { restoreSceneChunkStatus } = require('../orchestration/scene-restoration');
const registerVersionRoutes = require('./book/versions-routes.cjs');
const registerCacheRoutes = require('./book/cache-routes.cjs');
const registerStatusRoutes = require('./book/status-routes.cjs');
const registerParseRoutes = require('./book/parse-routes.cjs');
const { setDeep, findUnitInScene } = require('./book/scene-patch-utils.cjs');
const { recoverMissingRedisChunks } = require('./book/recover-chunks.cjs');
const { computeIuReady } = require('./book/iu-progress-utils.cjs');

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

    // In-flight TXT trigger guard to prevent concurrent window processing
    const inFlightTriggers = new Set();

    // ======================================================
    // GET BOOK DATA (used by frontend Editor & Navigator)
    // ======================================================
    app.get('/api/v1/book/:bookId', async (req, res) => {
        try {
            const { bookId } = req.params;
            const bookData = book.loadBook(bookId);
            if (!bookData) return res.status(404).json({ error: 'Book not found' });

            // Auto-recovery: check for missing placeholder MP3s + missing Redis chunks
            // Run synchronously (not setImmediate) so files exist before frontend queries.
            // This is fast — placeholder generation takes <100ms.
            const buildId = bookData?.manifest?.build_id || 'default';
            try {
                const phResult = await placeholderAudio.recoverMissingPlaceholders(buildId, bookId);
                if (phResult.created > 0 || phResult.errors.length > 0) {
                    log(`[BOOK-RECOVER] ${bookId}: ${phResult.created} placeholders created, ${phResult.errors.length} errors`);
                }
            } catch (recErr) {
                console.warn(`[BOOK-RECOVER] ${bookId}: placeholder recovery failed: ${recErr.message}`);
            }

            // Also create missing Redis chunks for scenes that exist in the book
            // but don't have corresponding chunks in Redis (e.g., from window generation
            // that created scenes on disk but failed to create chunks).
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

    // clearBookLeases / clearBookDispatchMeta removed in Phase 2 (Force Lease Release).
    // Replaced by dispatchEngine.clearAllLeasesForBook().

    // ======================================================
    // UPDATE BOOK DATA (used by frontend Editor save)
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

            // Load old book before saving to compute diff
            const oldBook = book.loadBook(bookId);

            // CRITICAL: Merge incoming book data with existing book on disk
            // to preserve top-level fields that the frontend may not send:
            //   - characters (character passports with appearance descriptions)
            //   - bible (locations, lore)
            //   - manifest (build_id, metadata)
            //
            // The frontend's PUT request typically only sends chapter/scene
            // data. Without this merge, characters and bible are overwritten
            // with empty/null, permanently losing character passports.
            //
            // Additionally, the frontend's CharDef model does NOT include
            // the `passport` field, so when the frontend round-trips
            // character data, passport fields (base_appearance,
            // detailed_appearance, clothing_base, clothing_details) are
            // silently dropped. We detect this case and do a per-character
            // deep merge of passport data from the old book.
            if (oldBook) {
                const oldChars = oldBook.characters;
                if (updatedBookData.characters && Array.isArray(updatedBookData.characters)) {
                    if (updatedBookData.characters.length === 0 && oldChars && oldChars.length > 0) {
                        // Empty array: full replace with old book's characters
                        updatedBookData.characters = oldChars;
                        log(`[UPDATE BOOK] ${bookId}: preserved ${oldChars.length} character passports from existing book (empty array)`);
                    } else if (oldChars && oldChars.length > 0) {
                        // Non-empty: deep-merge passport data per character
                        let mergedCount = 0;
                        const mergedChars = updatedBookData.characters.map(incomingChar => {
                            const oldChar = oldChars.find(c => c && c.id === incomingChar.id);
                            if (oldChar && oldChar.passport) {
                                const ip = incomingChar.passport;
                                const hasPassportData = ip && (
                                    ip.base_appearance ||
                                    ip.detailed_appearance ||
                                    ip.clothing_base ||
                                    ip.clothing_details
                                );
                                if (!hasPassportData) {
                                    mergedCount++;
                                    return { ...incomingChar, passport: oldChar.passport };
                                }
                            }
                            return incomingChar;
                        });
                        // Add any characters from old book missing in incoming
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

            // Save new book
            book.saveBookBundle(updatedBookData, null);
            log(`[UPDATE BOOK] ${bookId}: ${updatedBookData.chapters?.length || 0} chapters saved`);

            // Load saved book from disk to get post-save state for hash computation
            const newBook = book.loadBook(bookId) || updatedBookData;

            // Reconcile PG state (hashes, asset status, tasks) via book-diff
            try {
                const diff = bookDiff.computeBookDiff(oldBook || { chapters: [] }, newBook);
                if (diff.dirty_scenes.length > 0) {
                    const syncResult = await storage.bookSync.reconcileFromDiff(bookId, diff.dirty_scenes, newBook);
                    log(`[UPDATE BOOK] ${bookId}: reconciled ${syncResult.reconciled} scenes`);

                    // R13: Bump version counters for changed scenes
                    // Uses shared function from scene-assets-repo
                    try {
                        await sceneAssetsRepo.bumpSceneVersions(bookId, diff.dirty_scenes);

                        // R16: Log cross-cutting source when version is bumped by entity changes
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

                        // Store per-unit dirty IDs in PG for granular force-regen
                        for (const ds of diff.dirty_scenes) {
                            const unitIds = ds.changes?.units?.unit_ids;
                            if (unitIds && Array.isArray(unitIds) && unitIds.length > 0) {
                                await sceneAssetsRepo.setDirtyUnitIds(bookId, ds.chapter_id, ds.scene_id, unitIds);
                                log(`[DIRTY-UNITS] ${bookId}/${ds.chapter_id}/${ds.scene_id}: ${unitIds.length} dirty unit(s): ${unitIds.join(', ')}`);
                            }
                        }
                    } catch (verErr) {
                        // Non-fatal: version bump failure shouldn't block
                        console.warn(`[UPDATE BOOK] Version bump/failed: ${verErr.message}`);
                    }
                }
            } catch (syncErr) {
                // Non-fatal: PG reconciliation should not block the save
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
    // Unlike PUT which sends the entire book (causing field loss when
    // frontend models drop unknown fields like character passports),
    // PATCH sends only what changed. Two modes:
    //
    // Mode A — Unit field patch (most common for editing visual.prompt):
    //   Body: { "unit_id": "iu-xxx", "visual.prompt": "...", "text": "..." }
    //   Applies fields directly to the unit. No key mapping needed —
    //   unit fields are exact dot-paths (visual.prompt, visual.negative, etc.)
    //
    // Mode B — Full scene replacement (when scene-level fields change):
    //   Body: { "scene": { ... full scene object ... } }
    //   Replaces the scene entirely. Frontend builds it via applyFieldValues().
    //
    // Both modes support optional "chapter_title" for chapter-level changes.

    // setDeep / findUnitInScene moved to ./book/scene-patch-utils.cjs (Debt #3).

    /**
     * PATCH /api/v1/book/:bookId/scene/:chapterId/:sceneId
     *
     * Two modes (see above for details).
     */
    app.patch('/api/v1/book/:bookId/scene/:chapterId/:sceneId', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const { scene: incomingScene, unit_id, chapter_title } = req.body;

            if (!incomingScene && !unit_id) {
                return res.status(400).json({ error: 'Provide either "scene" (full replace) or "unit_id" with fields (targeted patch)' });
            }

            const oldBook = book.loadBook(bookId);
            if (!oldBook) return res.status(404).json({ error: 'Book not found' });

            // SNAPSHOT: deep-clone before any mutations so computeBookDiff
            // can accurately detect what changed (PATCH mutates oldBook in-place,
            // making a post-hoc comparison against itself return empty).
            const bookBeforePatch = JSON.parse(JSON.stringify(oldBook));

            // Find scene + chapter
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

            if (unit_id) {
                // Mode A: targeted unit field patch
                const unit = findUnitInScene(targetScene, unit_id);
                if (!unit) {
                    return res.status(404).json({ error: `Unit ${unit_id} not found in scene` });
                }
                const unitFields = {};
                for (const [key, value] of Object.entries(req.body)) {
                    if (key === 'unit_id' || key === 'chapter_title' || key === 'scene') continue;
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
                // Mode B: full scene replacement
                oldBook.chapters.find(ch => ch.chapter === chapterId).scenes[sceneIndex] = incomingScene;
                log(`[PATCH BOOK] ${bookId}/${chapterId}/${sceneId}: full scene replaced`);
            }

            if (chapter_title !== undefined && chapter_title !== null && targetChapter) {
                targetChapter.chapter_title = chapter_title;
            }

            book.saveBookBundle(oldBook, null);

            const newBook = book.loadBook(bookId) || oldBook;
            // Compare against the pre-mutation snapshot — always accurate
            // for both Mode A (targeted unit field) and Mode B (full scene).
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
                saved: true,
                book_id: bookId,
                chapter_id: chapterId,
                scene_id: sceneId,
                unit_id: unit_id || null,
                dirty_scenes: diff.dirty_scenes.length,
            });
        } catch (err) {
            console.error('[PATCH BOOK] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // LOAD VBOOK
    // ======================================================
    app.post('/api/v1/book/load-vbook', multer().single('file'), async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'file missing' });

            const files = book.extractBookBundle(req.file.buffer);
            log('[LOAD-VBOOK] bundle loaded:', Object.keys(files));

            const bookData = book.buildBookFromBundle(files);
            const bookId = bookData.manifest.book_id;
            const buildId = bookData.manifest.build_id || 'default';

            const existingBook = book.loadBook(bookId);
            let loadedBook;
            if (existingBook) {
                log(`[LOAD-VBOOK] Book ${bookId} already exists — keeping existing (edited) version`);
                loadedBook = existingBook;

                const existingScenes = book.collectScenes(existingBook);
                const chunks = await getAllChunks(bookId);
                if (chunks.length === 0) {
                    log(`[LOAD-VBOOK] No chunks in Redis — attempting recovery from disk for ${existingScenes.length} scenes`);
                    const recovered = await recoverChunksFromDisk(bookId, buildId, existingScenes);
                    if (recovered.length > 0) {
                        log(`[LOAD-VBOOK] Recovered ${recovered.length}/${existingScenes.length} chunks from disk for ${bookId}`);
                        await redis.set(config.BOOK_SCENE_TOTAL(bookId), existingScenes.length);
                        await redis.set(config.BOOK_SCENE_NEXT(bookId), recovered.length);
                    } else {
                        log(`[LOAD-VBOOK] No files on disk for ${bookId} — generation needed`);
                    }
                } else {
                    log(`[LOAD-VBOOK] Found ${chunks.length} chunks in Redis for ${bookId}`);
                }
            } else {
                await book.resetBook(bookId);
                book.saveBookBundle(bookData, files);
                loadedBook = book.loadBook(bookId);
                console.log(`[LOAD-VBOOK] Loaded book from disk: ${bookId}, chapters: ${loadedBook?.chapters?.length}`);
            }

            const scenes = book.collectScenes(loadedBook || bookData);
            const chapterCount = loadedBook?.chapters?.length || bookData.chapters?.length || 0;
            const sceneCount = scenes.length;
            const title = bookData.manifest?.title || loadedBook?.manifest?.title || bookId;

            log(`[LOAD-VBOOK] ${bookId}: ${chapterCount} chapters, ${sceneCount} scenes`);

            const existingChunksAfterLoad = await getAllChunks(bookId);
            if (existingChunksAfterLoad.length === 0) {
                log(`[LOAD-VBOOK] Creating chunks + placeholder audio for ${scenes.length} scenes...`);
                for (const s of scenes) {
                    const chunkId = `${bookId}_${s.chapter_id}_${s.scene_id}_0001`;
                    try {
                        await saveChunk(chunkId, {
                            build_id: buildId, book_id: bookId, scene_order: s.scene_order || 0,
                            chapter_id: s.chapter_id, scene_id: s.scene_id, chunk_index: '0001',
                            expected_chunk_count: 1, scene_type: s.scene_type || 'narration',
                            audio: true, audio_status: 'placeholder', image: false, video: false,
                            video_status: 'pending', padded_text: false,
                        });
                    } catch (chunkErr) {
                        console.warn(`[LOAD-VBOOK] Failed to create chunk ${chunkId}: ${chunkErr.message}`);
                    }
                }
                const phScenes = scenes.map(s => ({ chapter_id: s.chapter_id, scene_id: s.scene_id }));
                const phResult = await placeholderAudio.ensureAllPlaceholderAudio(buildId, bookId, phScenes);
                log(`[LOAD-VBOOK] Placeholder audio: ${phResult.created} created, ${phResult.skipped} skipped`);
                try {
                    await redis.set(config.BOOK_SCENE_TOTAL(bookId), scenes.length);
                    await redis.set(config.BOOK_SCENE_NEXT(bookId), scenes.length);
                } catch (idxErr) {
                    console.warn(`[LOAD-VBOOK] Failed to set scene index: ${idxErr.message}`);
                }
            } else {
                log(`[LOAD-VBOOK] ${existingChunksAfterLoad.length} chunks exist — async placeholder generation`);
                setImmediate(async () => {
                    try {
                        const phScenes = scenes.map(s => ({ chapter_id: s.chapter_id, scene_id: s.scene_id }));
                        const phResult = await placeholderAudio.ensureAllPlaceholderAudio(buildId, bookId, phScenes);
                        log(`[LOAD-VBOOK] Placeholder audio: ${phResult.created} created, ${phResult.skipped} skipped`);
                    } catch (phErr) {
                        console.warn(`[LOAD-VBOOK] Placeholder audio generation failed: ${phErr.message}`);
                    }
                });
            }

            return res.json({
                book_id: bookId, build_id: buildId, title,
                chapter_count: chapterCount, scene_count: sceneCount,
                was_existing: !!existingBook,
            });
        } catch (err) {
            console.error('LOAD-VBOOK ERROR:', err);
            return res.status(400).json({ error: err.message || 'unknown error' });
        }
    });

    // ======================================================
    // RESUME BOOTSTRAP — recover from interrupted bootstrap
    // ======================================================
    app.post('/api/v1/book/:bookId/resume-bootstrap', async (req, res) => {
        try {
            const { bookId } = req.params;

            const draft = lazyBook.loadDraftBook(bookId);
            if (!draft) return res.status(404).json({ error: 'Book not found' });

            // If already bootstrapped/active with chapters on disk, done
            if ((draft.manifest.state === lazyBook.BookState.BOOTSTRAPPED ||
                 draft.manifest.state === lazyBook.BookState.ACTIVE) &&
                draft.chapters.length > 0) {
                log(`[RESUME-BOOTSTRAP] ${bookId}: already ${draft.manifest.state}, returning status`);
                return res.json({
                    book_id: bookId, state: draft.manifest.state,
                    characters: draft.characters.length,
                    locations: Object.keys(draft.bible?.locations || {}).length,
                    scenes: draft.chapters.reduce((sum, ch) => sum + (ch.scenes?.length || 0), 0),
                });
            }

            // Check if there's an active agent session
            const { postgres } = storage;
            const activeSessions = await postgres.query(`
                SELECT session_id, status, progress_msg, window_data
                FROM agent_sessions
                WHERE book_id = $1 AND status IN ('running', 'pending')
                ORDER BY created_at DESC LIMIT 1
            `, [bookId]);

            if (activeSessions.rows.length > 0) {
                const session = activeSessions.rows[0];
                log(`[RESUME-BOOTSTRAP] ${bookId}: active session ${session.session_id} (${session.status})`);
                return res.json({
                    book_id: bookId, state: 'resuming',
                    session_id: session.session_id, session_status: session.status,
                    progress_msg: session.progress_msg || 'Resuming...',
                });
            }

            // No active session — re-bootstrap
            log(`[RESUME-BOOTSTRAP] ${bookId}: no active session, re-bootstrapping...`);
            const result = await txtImporter.bootstrapImportedText(bookId);

            return res.json({
                book_id: result.bookId, state: result.state,
                title: result.title, author: result.author,
                characters: result.characters, locations: result.locations,
                scenes: result.scenes,
            });
        } catch (err) {
            console.error('[RESUME-BOOTSTRAP] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // IMPORT TXT
    // ======================================================
    app.post('/api/v1/book/import-txt', multer().single('file'), async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'file missing' });

            const crypto = require('crypto');
            const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

            const decoded = txtImporter.decodeTxtBuffer(req.file.buffer);
            if (decoded.error) return res.status(400).json({ error: decoded.error });

            const sourceText = decoded.text;
            const title = path.basename(req.file.originalname, '.txt');

            let existingBookId = null;
            try {
                const candidates = await bookSourceRepo.findCandidateBySize(req.file.buffer.length);
                if (candidates && candidates.length > 0) {
                    const existing = await bookSourceRepo.findByHash(fileHash);
                    if (existing) {
                        const existingStatus = lazyBook.getBookStatus(existing.book_id);
                        if (existingStatus && existingStatus.state) {
                            const completionStatus = await genSessionRepo.getBookCompletionStatus(existing.book_id);
                            if (completionStatus !== 'completed') {
                                existingBookId = existing.book_id;
                            } else {
                                await bookSourceRepo.deleteByBookId(existing.book_id);
                                log(`[IMPORT-TXT] DEDUP: completed book ${existing.book_id} — cleaning up for new import`);
                            }
                        } else {
                            await bookSourceRepo.deleteByBookId(existing.book_id);
                            log(`[IMPORT-TXT] DEDUP: book ${existing.book_id} not on disk — cleaning up reference`);
                        }
                    }
                }
            } catch (pgErr) {
                console.warn(`[IMPORT-TXT] PG dedup check failed (non-fatal): ${pgErr.message}`);
            }

            if (existingBookId) {
                log(`[IMPORT-TXT] DEDUP: returning existing book ${existingBookId} for hash ${fileHash}`);
                return res.json({
                    book_id: existingBookId, title, state: lazyBook.BookState.RAW_IMPORTED, dedup: true,
                });
            }

            const draft = lazyBook.createDraftBook(sourceText, lazyBook.SourceType.TXT, title);
            const bookDir = lazyBook.getBookDir(draft.bookId);
            const mp = lazyBook.getManifestPath(bookDir);
            const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
            m.import_meta.original_filename = req.file.originalname;
            fs.writeFileSync(mp, JSON.stringify(m, null, 2));

            try {
                await bookSourceRepo.registerSource(fileHash, req.file.originalname, req.file.buffer.length, draft.bookId, 'txt');
                log(`[IMPORT-TXT] Registered source: ${fileHash} → ${draft.bookId}`);
            } catch (pgErr) {
                console.warn(`[IMPORT-TXT] Failed to register source (non-fatal): ${pgErr.message}`);
            }

            log(`[IMPORT-TXT] RAW_IMPORTED: ${draft.bookId} (${Buffer.byteLength(sourceText, 'utf8')} bytes)`);
            return res.json({ book_id: draft.bookId, title, state: lazyBook.BookState.RAW_IMPORTED });
        } catch (err) {
            console.error('IMPORT-TXT ERROR:', err);
            return res.status(400).json({ error: err.message || 'unknown error' });
        }
    });

    // ======================================================
    // BOOTSTRAP
    // ======================================================
    app.post('/api/v1/book/:bookId/bootstrap', async (req, res) => {
        try {
            const { bookId } = req.params;
            const result = await txtImporter.bootstrapImportedText(bookId);

            try {
                const scenesCount = result.scenes || 0;
                await genSessionRepo.markFirstWindowCompleted(bookId, scenesCount);
                log(`[BOOTSTRAP] Marked window 0 completed in PG for ${bookId}`);
            } catch (pgErr) {
                console.warn(`[BOOTSTRAP] Failed to mark window 0 in PG: ${pgErr.message}`);
            }

            log(`[BOOTSTRAP] ${bookId}: ${result.characters} chars, ${result.locations} locs, ${result.scenes} scenes`);

            if (result.chapter && result.chapter.scenes && result.chapter.scenes.length > 0) {
                const draftBook = lazyBook.loadDraftBook(bookId);
                const buildId = draftBook?.manifest?.build_id || 'default';
                const chapterId = result.chapter.chapter;

                // Create chunks in Redis (synchronous — fast Redis ops)
                log(`[BOOTSTRAP] Creating ${result.chapter.scenes.length} chunks for ${bookId}...`);
                for (let i = 0; i < result.chapter.scenes.length; i++) {
                    const s = result.chapter.scenes[i];
                    const chunkId = `${bookId}_${chapterId}_${s.scene_id}_0001`;
                    try {
                        await saveChunk(chunkId, {
                            build_id: buildId, book_id: bookId, scene_order: i,
                            chapter_id: chapterId, scene_id: s.scene_id, chunk_index: '0001',
                            expected_chunk_count: 1, scene_type: s.type || 'narration',
                            audio: true, audio_status: 'placeholder', image: false, video: false,
                            video_status: 'pending', padded_text: false,
                        });
                    } catch (chunkErr) {
                        console.warn(`[BOOTSTRAP] Failed to create chunk ${chunkId}: ${chunkErr.message}`);
                    }
                }

                // Set scene counters
                try {
                    await redis.set(config.BOOK_SCENE_TOTAL(bookId), result.chapter.scenes.length);
                    await redis.set(config.BOOK_SCENE_NEXT(bookId), result.chapter.scenes.length);
                } catch (idxErr) {
                    console.warn(`[BOOTSTRAP] Failed to set scene index: ${idxErr.message}`);
                }

                // Placeholder audio (synchronous — ensures audio files exist when frontend queries)
                try {
                    const phScenes = result.chapter.scenes.map(s => ({ chapter_id: chapterId, scene_id: s.scene_id }));
                    log(`[BOOTSTRAP] Generating placeholder audio for ${phScenes.length} scenes...`);
                    const phResult = await placeholderAudio.ensureAllPlaceholderAudio(buildId, bookId, phScenes);
                    log(`[BOOTSTRAP] Placeholder audio: ${phResult.created} created, ${phResult.skipped} skipped`);
                } catch (phErr) {
                    console.warn(`[BOOTSTRAP] Placeholder audio generation failed: ${phErr.message}`);
                }
            }

            res.json({
                book_id: result.bookId, title: result.title, author: result.author,
                language: result.language, state: result.state,
                characters: result.characters, locations: result.locations,
                scenes: result.scenes, session_id: result.session_id || null,
                total_scenes_found: result.total_scenes_found || null,
                remaining_scenes: result.remaining_scenes || null,
                chapters: result.chapter ? [{
                    chapter: result.chapter.chapter, chapter_title: result.chapter.chapter_title,
                    chapter_index: result.chapter.chapter_index, status: result.chapter.status,
                    scene_count: result.chapter.scenes ? result.chapter.scenes.length : 0,
                }] : [],
            });

            // Background window processing is intentionally disabled:
            // subsequent windows are triggered by WindowTriggerManager
            // when the user navigates to the last 3 units of the last scene.
            // This ensures visible progress (1/3, 2/3, 3/3) for every window.
        } catch (err) {
            console.error('BOOTSTRAP ERROR:', err);
            return res.status(400).json({ error: err.message || 'unknown error' });
        }
    });

    // ======================================================
    // BOOTSTRAP NEXT WINDOW
    // ======================================================
    app.post('/api/v1/book/:bookId/bootstrap-next-window', async (req, res) => {
        try {
            const { bookId } = req.params;
            const result = await txtImporter.bootstrapNextWindow(bookId);
            log(`[BOOTSTRAP-NEXT] ${bookId}: added ${result.added_scenes} scenes, cached=${result.cached}, all_done=${result.all_done}`);
            return res.json(result);
        } catch (err) {
            console.error('BOOTSTRAP-NEXT ERROR:', err);
            return res.status(400).json({ error: err.message || 'unknown error' });
        }
    });

    // ======================================================
    // TRIGGER NEXT WINDOW — with detailed logging
    // ======================================================
    app.post('/api/v1/book/:bookId/trigger-next-window', async (req, res) => {
        try {
            const { bookId } = req.params;
            const { chapter_id, scene_id, unit_id, register_for_gpu = true } = req.body || {};

            log(`[TRIGGER] next-window called for ${bookId} (params: chapter_id=${chapter_id} scene_id=${scene_id})`);

            if (!bookId) return res.status(400).json({ error: 'bookId required' });

            const draft = lazyBook.loadDraftBook(bookId);
            if (!draft || !draft.sourceText) {
                log(`[TRIGGER] ❌ book ${bookId} not found or no source text`);
                return res.status(404).json({ error: 'Book not found' });
            }

            if (draft.manifest.state !== lazyBook.BookState.BOOTSTRAPPED &&
                draft.manifest.state !== lazyBook.BookState.ACTIVE) {
                log(`[TRIGGER] ❌ book state=${draft.manifest.state} not BOOTSTRAPPED or ACTIVE`);
                return res.status(400).json({ error: 'Book not ready for next window, state: ' + draft.manifest.state });
            }

            if (chapter_id && scene_id) {
                const draft = lazyBook.loadDraftBook(bookId);
                const chapters = draft?.chapters || [];
                if (chapters.length > 0) {
                    let found = false;
                    for (const ch of chapters) {
                        if (ch.chapter === chapter_id) {
                            for (const sc of (ch.scenes || [])) {
                                if (sc.scene_id === scene_id) { found = true; break; }
                            }
                            if (!found) log(`[TRIGGER] ⚠️ scene ${scene_id} not in chapter ${chapter_id}, continuing anyway`);
                            break;
                        }
                    }
                    if (found) log(`[TRIGGER] ✅ chapter ${chapter_id}/scene ${scene_id} validated`);
                }
            }

            // TXT import path: use txtImporter.bootstrapNextWindow
            // Detect TXT book by checking for agent_sessions rows
            const agentResult = await storage.postgres.query(`
                SELECT session_id, status, window_data
                FROM agent_sessions
                WHERE book_id = $1
                ORDER BY created_at DESC LIMIT 1
            `, [bookId]);

            if (agentResult.rows.length > 0) {
                const agentSession = agentResult.rows[0];
                const windowData = agentSession.window_data
                    ? (typeof agentSession.window_data === 'string' ? JSON.parse(agentSession.window_data) : agentSession.window_data)
                    : null;

                if (agentSession.status === 'completed' ||
                    (windowData && windowData.remaining_scenes && windowData.remaining_scenes.length === 0 && !windowData.remaining_text)) {
                    log(`[TRIGGER] all done for TXT book ${bookId}`);
                    return res.json({ triggered: false, all_done: true, message: 'All windows processed' });
                }

                // Concurrency guard: one in-flight trigger per book
                if (inFlightTriggers.has(bookId)) {
                    log(`[TRIGGER] ⏳ TXT book ${bookId} already has an in-flight trigger, queuing`);
                    return res.json({ triggered: false, queued: true, book_id: bookId, source: 'txt_import' });
                }
                inFlightTriggers.add(bookId);

                log(`[TRIGGER] TXT book ${bookId}: calling bootstrapNextWindow`);
                setImmediate(async () => {
                    try {
                        const nextRes = await txtImporter.bootstrapNextWindow(bookId);
                        log(`[TRIGGER] TXT window done: added=${nextRes.added_scenes || 0} all_done=${nextRes.all_done}`);

                        if (nextRes.chapter) {
                            const chapterId = nextRes.chapter.chapter;
                            const allScenes = nextRes.chapter.scenes || [];
                            const added = nextRes.added_scenes || 0;
                            const newScenes = allScenes.slice(-added);
                            const draftTrigger = lazyBook.loadDraftBook(bookId);
                            const buildId = draftTrigger?.manifest?.build_id || 'default';
                            for (let si = 0; si < newScenes.length; si++) {
                                const s = newScenes[si];
                                const chunkId = `${bookId}_${chapterId}_${s.scene_id}_0001`;
                                try {
                                    await saveChunk(chunkId, {
                                        build_id: buildId, book_id: bookId, scene_order: allScenes.indexOf(s),
                                        chapter_id: chapterId, scene_id: s.scene_id, chunk_index: '0001',
                                        expected_chunk_count: 1, scene_type: s.type || 'narration',
                                        audio: true, audio_status: 'placeholder', image: false, video: false,
                                        video_status: 'pending', padded_text: false,
                                    });
                                } catch (chunkErr) {
                                    console.warn(`[TRIGGER] Chunk creation failed for ${chunkId}: ${chunkErr.message}`);
                                }
                            }
                            try {
                                const existingTotal = parseInt(await redis.get(config.BOOK_SCENE_TOTAL(bookId)) || '0', 10);
                                await redis.set(config.BOOK_SCENE_TOTAL(bookId), existingTotal + newScenes.length);
                                await redis.set(config.BOOK_SCENE_NEXT(bookId), existingTotal + newScenes.length);
                            } catch (idxErr) {
                                console.warn(`[TRIGGER] Failed to update scene counters: ${idxErr.message}`);
                            }
                            try {
                                const phScenes = newScenes.map(s => ({ chapter_id: chapterId, scene_id: s.scene_id }));
                                await placeholderAudio.ensureAllPlaceholderAudio(buildId, bookId, phScenes);
                            } catch (phErr) {
                                console.warn(`[TRIGGER] Placeholder audio failed: ${phErr.message}`);
                            }
                        }
                    } catch (err) {
                        console.error(`[TRIGGER] ❌ TXT bootstrapNextWindow failed: ${err.message}`);
                    } finally {
                        inFlightTriggers.delete(bookId);
                    }
                });

                return res.json({ triggered: true, source: 'txt_import', session_id: agentSession.session_id });
            }

            // VBook / windowGenerator path (existing logic)
            const lastWindow = await genSessionRepo.getHighestCompletedWindow(bookId);
            const nextWindowIndex = lastWindow + 1;
            log(`[TRIGGER] 📊 lastWindow=${lastWindow} nextWindow=${nextWindowIndex}`);

            const chapters = lazyBook.splitIntoChapters(draft.sourceText);
            if (nextWindowIndex >= chapters.length) {
                log(`[TRIGGER] 📗 all done: nextWindow=${nextWindowIndex} >= total=${chapters.length}`);
                return res.json({ triggered: false, error: 'No more text to process', all_done: true });
            }

            const activeSessions = await genSessionRepo.getSessionsByStatus(bookId, 'generating');
            const pendingSessions = await genSessionRepo.getSessionsByStatus(bookId, 'pending');
            log(`[TRIGGER] 📊 activeSessions=${activeSessions.length} pendingSessions=${pendingSessions.length}`);

            if (activeSessions.length > 0 || pendingSessions.length > 0) {
                const queuedSession = await genSessionRepo.createSession(bookId, nextWindowIndex, 3);
                await genSessionRepo.updateSession(queuedSession.id, { status: 'queued' });
                log(`[TRIGGER] 📦 queued window ${nextWindowIndex} (generation already active) session=${queuedSession.id}`);
                return res.json({ triggered: false, queued: true, session_id: queuedSession.id, window_index: nextWindowIndex });
            }

            log(`[TRIGGER] 🚀 No active sessions — proceeding with new session for window ${nextWindowIndex}`);
            const session = await genSessionRepo.createSession(bookId, nextWindowIndex, 3);
            const chInfo = chapters[nextWindowIndex];
            const sourceOffsetStart = chInfo ? chInfo.startOffset || 0 : 0;
            const sourceOffsetEnd = chInfo ? chInfo.endOffset || 0 : 0;
            await genSessionRepo.updateSession(session.id, {
                source_offset_start: sourceOffsetStart, source_offset_end: sourceOffsetEnd,
            });

            setImmediate(() => {
                log(`[TRIGGER] ▶️ Running background gen for session=${session.id} (register_for_gpu=${register_for_gpu})`);
                const bgBuildId = draft?.manifest?.build_id || 'default';
                windowGenerator.runBackgroundWindowGeneration(bookId, session.id, { registerForGpu, buildId: bgBuildId }).catch(err => {
                    console.error(`[TRIGGER] ❌ Background gen crashed: ${err.message}`);
                });
            });

            log(`[TRIGGER] ✅ started background window ${nextWindowIndex}, session=${session.id} (from PG ${lastWindow})`);
            return res.json({ triggered: true, session_id: session.id, window_index: nextWindowIndex });
        } catch (err) {
            console.error('[TRIGGER-NEXT-WINDOW] ❌ Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // AGENT STATUS
    // ======================================================
    app.get('/api/v1/book/:bookId/agent-status', async (req, res) => {
        try {
            const { bookId } = req.params;

            // 1. Check agent_sessions (AI agent pipeline)
            const agentResult = await storage.postgres.query(`
                SELECT session_id, status as session_status, progress_msg,
                       window_data, knowledge_base, source_type
                FROM agent_sessions
                WHERE book_id = $1
                ORDER BY created_at DESC
                LIMIT 1
            `, [bookId]);

            const agentRow = agentResult.rows[0];

            // If agent session is actively running, return it with full data
            if (agentRow && agentRow.session_status === 'running') {
                let windowData = null;
                let windowIndex = null;
                let createdScenes = null;
                let totalScenes = null;
                let remainingCached = null;

                if (agentRow.window_data) {
                    try {
                        windowData = typeof agentRow.window_data === 'string' ? JSON.parse(agentRow.window_data) : agentRow.window_data;
                        windowIndex = windowData.window_index;
                        createdScenes = windowData.created_scenes;
                        totalScenes = windowData.total_scenes;
                        remainingCached = windowData.remaining_scenes ? windowData.remaining_scenes.length : 0;
                    } catch (e) { /* ignore */ }
                }

                return res.json({
                    active: true, session_id: agentRow.session_id,
                    session_status: 'running', progress_msg: agentRow.progress_msg || 'Working...',
                    source_type: agentRow.source_type, window_index: windowIndex,
                    created_scenes: createdScenes, total_scenes: totalScenes, remaining_cached: remainingCached,
                });
            }

            // 2. Fallback: check book_generation_sessions (window generator path for vbook)
            const genResult = await storage.postgres.query(`
                SELECT id, status, progress_msg, window_index, error
                FROM book_generation_sessions
                WHERE book_id = $1 AND status IN ('generating', 'pending', 'queued')
                ORDER BY created_at DESC
                LIMIT 1
            `, [bookId]);

            const genRow = genResult.rows[0];
            if (genRow) {
                return res.json({
                    active: true,
                    session_id: genRow.id,
                    session_status: genRow.status,
                    progress_msg: genRow.progress_msg || 'Processing...',
                    source_type: 'window_generator',
                    window_index: genRow.window_index,
                    created_scenes: null,
                    total_scenes: null,
                    remaining_cached: null,
                });
            }

            // 3. Fallback to agent session (even if completed) for stale data
            if (agentRow) {
                let windowData = null;
                let windowIndex = null;
                let createdScenes = null;
                let totalScenes = null;
                let remainingCached = null;

                if (agentRow.window_data) {
                    try {
                        windowData = typeof agentRow.window_data === 'string' ? JSON.parse(agentRow.window_data) : agentRow.window_data;
                        windowIndex = windowData.window_index;
                        createdScenes = windowData.created_scenes;
                        totalScenes = windowData.total_scenes;
                        remainingCached = windowData.remaining_scenes ? windowData.remaining_scenes.length : 0;
                    } catch (e) { /* ignore */ }
                }

                return res.json({
                    active: agentRow.session_status === 'running', session_id: agentRow.session_id,
                    session_status: agentRow.session_status, progress_msg: agentRow.progress_msg || 'Working...',
                    source_type: agentRow.source_type, window_index: windowIndex,
                    created_scenes: createdScenes, total_scenes: totalScenes, remaining_cached: remainingCached,
                });
            }

            return res.json({ active: false, message: 'No active agent session' });
        } catch (err) {
            console.error('[AGENT-STATUS] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // Status / state read-only routes — extracted to ./book/status-routes.cjs
    // (Architectural Debt #3 split, sub-registrar pattern).
    registerStatusRoutes(app, { genSessionRepo, lazyBook, txtImporter, log });

    // Parse / source / snapshot routes — extracted to ./book/parse-routes.cjs
    // (Architectural Debt #3 split, sub-registrar pattern).
    registerParseRoutes(app, { config, txtImporter, lazyBook, placeholderAudio, taskHandler, log });

    // ======================================================
    // BOOK CHUNKS
    // ======================================================
    app.get('/api/v1/book/:bookId/chunks', async (req, res) => {
        const allIds = await getAllChunks(req.params.bookId);
        const windowStatus = await getBookWindowStatus(req.params.bookId);
        res.json({ chunk_ids: allIds, total: allIds.length, ...windowStatus });
    });

    // ======================================================
    // ASSETS STATE
    // ======================================================
    app.get('/api/v1/book/:bookId/assets-state', async (req, res) => {
        try {
            const { bookId } = req.params;
            const { scope, chapter_id, scene_id } = req.query;

            const allChunkIds = await getAllChunks(bookId);
            const totalChunks = allChunkIds.length;

            // Batch-load all chunk metadata in ONE round-trip instead of N
            // sequential getChunk() calls. We then filter by scope and tally
            // status from the in-memory objects, so each chunk is read once.
            const chunkById = new Map();
            if (allChunkIds.length > 0) {
                try {
                    const raw = await redis.mget(allChunkIds.map(id => `animastor:chunk:${id}`));
                    for (let i = 0; i < allChunkIds.length; i++) {
                        if (!raw[i]) continue;
                        try {
                            const c = JSON.parse(raw[i]);
                            if (!c.audio_status) c.audio_status = 'pending';
                            if (!c.image_status) c.image_status = c.image ? 'ready' : 'pending';
                            if (!c.video_status) c.video_status = 'pending';
                            chunkById.set(allChunkIds[i], c);
                        } catch (_) {}
                    }
                } catch (mgetErr) {
                    // Fall back to per-chunk reads if the pipeline fails.
                    for (const cid of allChunkIds) {
                        try { const c = await getChunk(cid); if (c) chunkById.set(cid, c); } catch (_) {}
                    }
                }
            }

            let filteredIds = allChunkIds;
            if ((scope === 'current_chapter' || scope === 'chapter') && chapter_id) {
                filteredIds = allChunkIds.filter(cid => chunkById.get(cid)?.chapter_id === chapter_id);
            } else if ((scope === 'current_scene' || scope === 'scene') && chapter_id && scene_id) {
                filteredIds = allChunkIds.filter(cid => {
                    const c = chunkById.get(cid);
                    return c?.chapter_id === chapter_id && c?.scene_id === scene_id;
                });
            }

            let audioReady = 0;          // any audio including placeholder (for completion/playback)
            let audioReadyReal = 0;      // real audio only (status = 'ready', for progress display)
            let imageReady = 0;
            let videoReady = 0;
            let audioError = 0;
            let imageError = 0;
            let videoError = 0;
            let hasAudio = false;
            let hasImage = false;
            let hasVideo = false;

            const isErr = (s) => s === 'error' || s === 'failed';
            for (const cid of filteredIds) {
                const chunk = chunkById.get(cid);
                if (!chunk) continue;
                if (chunk.audio_status === 'ready' || chunk.audio_status === 'placeholder') {
                    audioReady++;
                    hasAudio = true;
                    if (chunk.audio_status === 'ready') audioReadyReal++;
                } else if (isErr(chunk.audio_status)) {
                    audioError++;
                }
                if (chunk.image_status === 'ready') {
                    imageReady++;
                    hasImage = true;
                } else if (isErr(chunk.image_status)) {
                    imageError++;
                }
                if (chunk.video_status === 'ready') {
                    videoReady++;
                    hasVideo = true;
                } else if (isErr(chunk.video_status)) {
                    videoError++;
                }
            }

            let scopeIuTotal = 0;
            let scopeIuReady = 0;
            let coverIuTotal = 0;
            let coverIuReady = 0;
            try {
                // Reuse the already-loaded chunk metadata — no extra reads.
                let buildId = chunkById.get(filteredIds[0])?.build_id;
                if (!buildId) {
                    for (const cid of allChunkIds) {
                        const b = chunkById.get(cid)?.build_id;
                        if (b) { buildId = b; break; }
                    }
                }

                if (buildId) {
                    const uniqueScenes = new Map();
                    for (const cid of filteredIds) {
                        const chunk = chunkById.get(cid);
                        if (chunk?.chapter_id && chunk?.scene_id) {
                            uniqueScenes.set(`${chunk.chapter_id}:${chunk.scene_id}`, {
                                chapter_id: chunk.chapter_id,
                                scene_id: chunk.scene_id,
                            });
                        }
                    }
                    
                    for (const { chapter_id: ch, scene_id: sc } of uniqueScenes.values()) {
                        const rows = await iuRepo.getImageUnitsForScene(buildId, bookId, ch, sc);
                        if (rows.length > 0) {
                            scopeIuTotal += rows.length;
                            scopeIuReady += await computeIuReady(redis, sceneAssetsRepo, bookId, ch, sc, rows.length);
                        }
                    }
                    
                    // Cover IU counts — read from book data (not from filteredIds, since Cover may be outside scope)
                    // Only compute if images are enabled in the layer config
                    const layerCfg = await layerConfig.get(redis, bookId);
                    const imagesEnabled = layerCfg?.image_enabled !== false;
                    if (imagesEnabled) {
                        const coverCh = book.loadBook(bookId)?.chapters?.find(ch => ch.type === 'cover');
                        if (coverCh && coverCh.scenes && coverCh.scenes.length > 0) {
                            const coverScene = coverCh.scenes[0];
                            const coverChapterId = coverCh.chapter;
                            const coverSceneId = coverScene.scene_id;
                            const rows = await iuRepo.getImageUnitsForScene(buildId, bookId, coverChapterId, coverSceneId);
                            if (rows.length > 0) {
                                coverIuTotal = rows.length;
                                coverIuReady = await computeIuReady(redis, sceneAssetsRepo, bookId, coverChapterId, coverSceneId, rows.length);
                            } else {
                                // Fallback: count from book data units
                                const units = coverScene.units || [];
                                coverIuTotal = units.length;
                                if (coverIuTotal > 0) {
                                    coverIuReady = await computeIuReady(redis, sceneAssetsRepo, bookId, coverChapterId, coverSceneId, units.length);
                                }
                            }
                        }
                    }
                }
            } catch (_) {}

            res.json({
                book_id: bookId,
                scope: scope || 'book',
                total_chunks: totalChunks,
                audio_ready: audioReady,
                audio_ready_real: audioReadyReal,
                image_ready: imageReady,
                video_ready: videoReady,
                has_audio: hasAudio,
                has_image: hasImage,
                has_video: hasVideo,
                all_audio_ready: audioReady === filteredIds.length && filteredIds.length > 0,
                all_image_ready: imageReady === filteredIds.length && filteredIds.length > 0,
                all_video_ready: videoReady === filteredIds.length && filteredIds.length > 0,
                has_assets: audioReady > 0 || imageReady > 0 || videoReady > 0,
                scope_total: filteredIds.length,
                scope_audio_ready: audioReady,
                scope_audio_ready_real: audioReadyReal,
                scope_image_ready: imageReady,
                scope_video_ready: videoReady,
                scope_all_audio_ready: audioReady === filteredIds.length && filteredIds.length > 0,
                scope_all_image_ready: imageReady === filteredIds.length && filteredIds.length > 0,
                scope_all_video_ready: videoReady === filteredIds.length && filteredIds.length > 0,
                scope_iu_total: scopeIuTotal,
                scope_iu_ready: scopeIuReady,
                cover_iu_total: coverIuTotal,
                cover_iu_ready: coverIuReady,
                // Per-layer error counts (chunks with status 'error'/'failed').
                // Lets the frontend surface a failed worker instead of showing
                // a silently stalled progress bar that never completes.
                audio_error: audioError,
                image_error: imageError,
                video_error: videoError,
            });
        } catch (err) {
            console.error('[ASSETS-STATE] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

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
            const windowModule = require('../runtime/scene-window');
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

            const windowModule = require('../runtime/scene-window');
            await windowModule.setCancelFlag(redis, bookId);

            // Remove any in-flight scenes from the active index
            const scheduler = require('../runtime/runtime-scheduler');
            await scheduler.clearBookFromActiveIndex(redis, bookId);

            // Reset concurrent worker counters to prevent stale "active worker" pulse
            // in the frontend. These counters are incremented on dispatch and
            // decremented on completion — cancelled jobs may leak them.
            await redis.del('animastor:runtime:active-audio');
            await redis.del('animastor:runtime:active-image');
            await redis.del('animastor:runtime:active-video');

            // CRITICAL: Stale dispatch-lease keys cause the frontend worker toggle
            // to pulse even when no real GPU work is happening. Each lease has a
            // TTL of 30-120 minutes — without explicit cleanup the toggle would
            // pulse for up to 2 hours after cancel, wasting GPU credits.
            // Uses centralized clearAllLeasesForBook (Phase 2: Force Lease Release)
            const dispatchEngine = require('../runtime/dispatch-engine');
            await dispatchEngine.clearAllLeasesForBook(redis, bookId);

            log(`[CANCEL-GENERATION] ${bookId}: generation cancelled, counters + leases reset`);
            res.json({ ok: true, book_id: bookId });
        } catch (err) {
            console.error('[CANCEL-GENERATION] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // CACHE ENDPOINTS (GET + DELETE)
    // ======================================================
    // Cache inspection + teardown routes — extracted to ./book/cache-routes.cjs
    // (Architectural Debt #3 split, sub-registrar pattern).
    registerCacheRoutes(app, {
        redis, config, storage, path, fs,
        getAllChunks, getChunk, cleanBookRedisKeys, log,
    });

    // ======================================================
    // DELETE BOOK — completely remove book + all associated data
    // ======================================================
    app.delete('/api/v1/book/:bookId', async (req, res) => {
        try {
            const { bookId } = req.params;

            log('[DELETE-BOOK] Deleting', bookId);

            // 1. Delete book files from disk
            await book.resetBook(bookId);
            // Also remove snapshot file
            const snapshotPath = path.join(config.BOOKS_DIR || '/data/books', `${bookId}.snapshot.json`);
            if (fs.existsSync(snapshotPath)) {
                try { fs.unlinkSync(snapshotPath); } catch (_) {}
            }

            // 2. Delete output/build directories
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
            // Also delete any directory starting with bookId in output
            if (fs.existsSync(OUTPUT_DIR)) {
                for (const entry of fs.readdirSync(OUTPUT_DIR)) {
                    if (entry.startsWith(bookId)) {
                        const entryPath = path.join(OUTPUT_DIR, entry);
                        try { fs.rmSync(entryPath, { recursive: true, force: true }); } catch (_) {}
                    }
                }
            }

            // 3. Cancel any active generation for this book first
            const windowModule = require('../runtime/scene-window');
            await windowModule.setCancelFlag(redis, bookId);

            // Reset global concurrency counters — they may be inflated by
            // in-flight tasks from this book. Same as cancel-generation does.
            await redis.del('animastor:runtime:active-audio');
            await redis.del('animastor:runtime:active-image');
            await redis.del('animastor:runtime:active-video');

            // 4. Delete all Redis keys for this book using the comprehensive helper
            await cleanBookRedisKeys(redis, bookId);

            // 5. Delete all PostgreSQL data for this book
            try {
                await storage.postgres.query('DELETE FROM scene_assets_cache WHERE book_id = $1', [bookId]);
                await storage.postgres.query('DELETE FROM scene_assets_state WHERE book_id = $1', [bookId]);
                await storage.postgres.query('DELETE FROM scene_images WHERE book_id = $1', [bookId]);
                await storage.postgres.query('DELETE FROM scene_videos WHERE book_id = $1', [bookId]);
                await storage.postgres.query('DELETE FROM scene_assets WHERE book_id = $1', [bookId]);
                await storage.postgres.query('DELETE FROM book_snapshots WHERE book_id = $1', [bookId]);
                await storage.postgres.query('DELETE FROM book_events WHERE book_id = $1', [bookId]);
                await storage.postgres.query('DELETE FROM cache_entries WHERE book_id = $1', [bookId]);
                await storage.postgres.query('DELETE FROM book_source WHERE book_id = $1', [bookId]);
                await storage.postgres.query('DELETE FROM chat_messages WHERE book_id = $1', [bookId]);
                await storage.postgres.query('DELETE FROM chat_sessions WHERE book_id = $1', [bookId]);
                await storage.postgres.query('DELETE FROM agent_sessions WHERE book_id = $1', [bookId]);
                await storage.postgres.query('DELETE FROM book_generation_sessions WHERE book_id = $1', [bookId]);
                await storage.postgres.query('DELETE FROM books WHERE book_id = $1', [bookId]);
            } catch (dbErr) {
                console.warn('[DELETE-BOOK] DB cleanup error:', dbErr.message);
            }

            // 6. Clear GPU hub queue — cancel all in-flight and queued jobs
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

    // ======================================================
    // GET BOOK COVER DATA
    // ======================================================
    // Cover is now a regular chapter (chapters[0]), use /api/v1/book/:bookId
    // to get the full book data including the Cover chapter.
    // This endpoint is kept for backward compatibility but returns
    // the first scene of the first chapter if it's a cover chapter.
    app.get('/api/v1/book/:bookId/cover', async (req, res) => {
        try {
            const { bookId } = req.params;
            const bookData = book.loadBook(bookId);
            if (!bookData) {
                return res.status(404).json({ error: 'Book not found' });
            }
            // Find the cover chapter (first chapter with type 'cover')
            const coverCh = (bookData.chapters || []).find(ch => ch.type === 'cover');
            if (!coverCh || !coverCh.scenes || coverCh.scenes.length === 0) {
                return res.status(404).json({ error: 'Cover not found for this book' });
            }
            // Return the first scene of the cover chapter (same format as legacy cover.json)
            return res.json(coverCh.scenes[0]);
        } catch (err) {
            console.error('[GET COVER] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // SELECTIVE REGENERATION
    // ======================================================
    app.post('/api/v1/book/:bookId/regenerate', async (req, res) => {
        // Redis lock: prevent concurrent /regenerate for the same book
        const REGENERATE_LOCK_PREFIX = 'animastor:regenerate-lock';
        const LOCK_TTL = 120; // 2 min — generous for any regenerate operation
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

        // Release lock helper
        const releaseRegenerateLock = async () => {
            try {
                const current = await redis.get(lockKey);
                if (current === lockToken) {
                    await redis.del(lockKey);
                }
            } catch (_) { /* best-effort */ }
        };

        try {
            const { bookId } = req.params;
            const { scope, chapter_id, scene_id, profile, rebuild_all } = req.body || {};

            const loadedBook = book.loadBook(bookId);
            if (!loadedBook) return res.status(404).json({ error: 'book not found' });

            const buildId = loadedBook.manifest?.build_id || 'default';

            // Clear any previous cancel flag so new generation can proceed
            const windowModule = require('../runtime/scene-window');
            await windowModule.clearCancelFlag(redis, bookId);
            const scheduler = require('../runtime/runtime-scheduler');
            await scheduler.clearBookFromActiveIndex(redis, bookId);

            // CRITICAL: Remove stale dispatch leases so the frontend worker toggle
            // doesn't pulse after cancel/regenerate. Leases persist for 30-120 min
            // TTL and would cause false "active worker" pulse toggles.
            // Uses centralized clearAllLeasesForBook (Phase 2: Force Lease Release)
            const dispatchEngine = require('../runtime/dispatch-engine');
            await dispatchEngine.clearAllLeasesForBook(redis, bookId);

            // Reset global active counters — they may be leaked from a previous
            // incomplete dispatch (e.g. crash, failed callback). Without reset,
            // backpressure quota blocks ALL new dispatches because the counter
            // shows maxActiveImage (2) even though no tasks are actually running.
            // cancel-generation does this; regenerate must too.
            await redis.del('animastor:runtime:active-audio');
            await redis.del('animastor:runtime:active-image');
            await redis.del('animastor:runtime:active-video');

            // Set force-dispatch flag for the scheduler tick.
            // The scheduler checks this flag and passes force=true to dispatchStage(),
            // ensuring any race-condition lease is cleared before dispatch.
            await redis.set(`animastor:force-dispatch:${bookId}`, '1', 'EX', 120);

            // Apply scope
            const effectiveScope = scope || 'WHOLE_BOOK';
            await genScope.setScope(redis, bookId, effectiveScope, chapter_id, scene_id);

            // Apply profile
            const layerCfg = profile
                ? await bookDiff.applyProfileToLayerConfig(redis, bookId, profile)
                : await layerConfig.get(redis, bookId);
            if (!layerCfg) {
                return res.status(400).json({ error: 'No layer config found for this book' });
            }

            const allScenes = book.collectScenes(loadedBook);

            let filteredDirty;

            if (rebuild_all) {
                // Full rebuild: mark ALL scenes as dirty regardless of diff
                log(`[REGENERATE] ${bookId}: full rebuild — marking all ${allScenes.length} scenes as dirty`);
                const allDirty = allScenes.map(s => ({
                    chapter_id: s.chapter_id,
                    scene_id: s.scene_id,
                    reason: 'rebuild',
                    dirty_layers: ['audio', 'image', 'video'],
                }));

                filteredDirty = bookDiff.filterDirtyScenesByScope(
                    allDirty, effectiveScope, chapter_id, scene_id, allScenes
                );
            } else {
                // Diff-based: compare current book with the same book
                const existingBook = book.loadBook(bookId);
                const diff = bookDiff.computeBookDiff(existingBook, loadedBook);
                log(`[REGENERATE] ${bookId}: ${diff.changes.added} added, ${diff.changes.removed} removed, ${diff.changes.modified} modified`);

                filteredDirty = bookDiff.filterDirtyScenesByScope(
                    diff.dirty_scenes, effectiveScope, chapter_id, scene_id, allScenes
                );

                // FALLBACK: If diff is empty (book already saved by PUT — both loads
                // return identical data), query PG directly for dirty scenes via
                // is_dirty flag and dirty_unit_ids. The PUT handler correctly stores
                // these before /regenerate is called.
                if (filteredDirty.length === 0) {
                    log(`[REGENERATE] ${bookId}: diff is empty (already saved by PUT) — querying PG for dirty scenes`);
                    try {
                        const pgResult = await storage.postgres.query(`
                            SELECT chapter_id, scene_id, is_dirty, dirty_unit_ids
                            FROM scenes
                            WHERE book_id = $1
                              AND (
                                  is_dirty = TRUE
                                  OR (dirty_unit_ids IS NOT NULL AND array_length(dirty_unit_ids, 1) > 0)
                              )
                            ORDER BY chapter_id, scene_id
                        `, [bookId]);

                        if (pgResult.rows.length > 0) {
                            filteredDirty = pgResult.rows.map(row => ({
                                chapter_id: row.chapter_id,
                                scene_id: row.scene_id,
                                reason: row.is_dirty ? 'version_stale' : 'dirty_units',
                                // Image layer is always regenerated for visual changes.
                                // Audio is left as-is (visual prompt changes don't affect audio).
                                dirty_layers: ['image'],
                                changes: row.dirty_unit_ids && row.dirty_unit_ids.length > 0
                                    ? { units: { unit_ids: row.dirty_unit_ids } }
                                    : null,
                            }));

                            filteredDirty = bookDiff.filterDirtyScenesByScope(
                                filteredDirty, effectiveScope, chapter_id, scene_id, allScenes
                            );
                            log(`[REGENERATE] ${bookId}: PG fallback found ${filteredDirty.length} dirty scene(s) via is_dirty/dirty_unit_ids`);
                        } else {
                            log(`[REGENERATE] ${bookId}: PG fallback also empty — no dirty scenes in PG`);
                        }
                    } catch (pgErr) {
                        console.warn(`[REGENERATE] PG fallback query failed: ${pgErr.message}`);
                    }

                    // THIRD FALLBACK: vbook not in PG — use request params + book data
                    if (filteredDirty.length === 0 && chapter_id && scene_id) {
                        // Find the scene in the book data to get IU info
                        const targetScene = allScenes.find(s =>
                            s.chapter_id === chapter_id && s.scene_id === scene_id
                        );
                        if (targetScene) {
                            // Collect unit IDs from scene (inline of collectSceneUnits)
                            const scenePayload = targetScene.payload || targetScene;
                            const changedUnitIds = [];
                            // If frontend sent unit_id in body, use that;
                            // otherwise regenerate all units in the scene
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
                                chapter_id,
                                scene_id,
                                reason: 'vbook_regen',
                                dirty_layers: ['image'],
                                changes: changedUnitIds.length > 0
                                    ? { units: { unit_ids: changedUnitIds } }
                                    : null,
                            }];
                            log(`[REGENERATE] ${bookId}: vbook fallback — created dirty entry for ${chapter_id}/${scene_id} (${changedUnitIds.length} units)`);
                        } else {
                            log(`[REGENERATE] ${bookId}: vbook fallback — scene ${chapter_id}/${scene_id} not found in book data`);
                        }
                    }
                }
            }

            // Check Cover chapter — always generate Cover first if missing images
            const coverCh = (loadedBook.chapters || []).find(ch => ch.type === 'cover');
            let coverNeedsGeneration = false;
            if (coverCh && coverCh.scenes && coverCh.scenes.length > 0 && layerCfg.image_enabled !== false) {
                const coverScene = coverCh.scenes[0];
                const coverChapterId = coverCh.chapter;
                const coverSceneId = coverScene.scene_id;
                const buildDir = path.join(config.OUTPUT_DIR, buildId);
                let coverHasImages = false;
                if (fs.existsSync(buildDir)) {
                    const iuPrefix = `${bookId}_${coverChapterId}_${coverSceneId}_iu`;
                    const files = fs.readdirSync(buildDir).filter(f => f.startsWith(iuPrefix) && f.endsWith('.png'));
                    const iuCount = (coverScene.units || []).length;
                    coverHasImages = files.length >= iuCount && iuCount > 0;
                }
                if (!coverHasImages) {
                    const alreadyDirty = filteredDirty.some(d => d.chapter_id === coverChapterId && d.scene_id === coverSceneId);
                    if (!alreadyDirty) {
                        const coverLayers = ['audio', 'image'];
                        if (layerCfg.video_enabled !== false) {
                            coverLayers.push('video');
                        }
                        filteredDirty.unshift({
                            chapter_id: coverChapterId,
                            scene_id: coverSceneId,
                            reason: 'cover',
                            dirty_layers: coverLayers,
                        });
                        coverNeedsGeneration = true;
                        log(`[REGENERATE] ${bookId}: Cover prepended to dirty scenes (layers=${coverLayers.join(',')})`);
                    }
                }
            }

            // Pre-delete stale PNGs for known dirty units BEFORE the scheduler
            // picks them up. This ensures the first assets-state poll correctly
            // reflects what needs regeneration, avoiding a 100% → drop pattern.
            for (const ds of filteredDirty) {
                const unitIds = ds.changes?.units?.unit_ids;
                if (unitIds && Array.isArray(unitIds) && unitIds.length > 0) {
                    const buildDir = path.join(config.OUTPUT_DIR, buildId);
                    if (fs.existsSync(buildDir)) {
                        for (const uid of unitIds) {
                            const pngPath = path.join(buildDir, `${bookId}_${ds.chapter_id}_${ds.scene_id}_${uid}.png`);
                            try {
                                if (fs.existsSync(pngPath)) {
                                    fs.unlinkSync(pngPath);
                                    log(`[REGENERATE-PRE-DELETE] Deleted stale PNG: ${pngPath}`);
                                }
                            } catch (delErr) {
                                console.warn(`[REGENERATE-PRE-DELETE] Failed to delete ${pngPath}: ${delErr.message}`);
                            }
                            // Also delete stale preview thumbnail (pr-*.png) so getOrCreatePreview
                            // regenerates it from the new IU image instead of returning the old one.
                            const strippedUid = uid.replace(/^iu/, '');
                            const previewPath = path.join(buildDir, `${bookId}_${ds.chapter_id}_${ds.scene_id}_pr${strippedUid}.png`);
                            try {
                                if (fs.existsSync(previewPath)) {
                                    fs.unlinkSync(previewPath);
                                    log(`[REGENERATE-PRE-DELETE] Deleted stale preview: ${previewPath}`);
                                }
                            } catch (delErr) {
                                console.warn(`[REGENERATE-PRE-DELETE] Failed to delete ${previewPath}: ${delErr.message}`);
                            }
                        }
                    }
                }
            }

            // Reset per-IU progress counters for each dirty scene so assets-state
            // doesn't see stale counts from a previous regen cycle.
            for (const ds of filteredDirty) {
                const progKey = `animastor:iu-progress:${bookId}:${ds.chapter_id}:${ds.scene_id}:image`;
                try { await redis.del(progKey); } catch (_) {}
            }

            // Clear in-flight markers for dirty scenes so processSingleIU doesn't
            // skip the dirty unit. In-flight markers are normally cleared by
            // handleImageCompleted when the scene completes, but if the scene
            // didn't fully complete (e.g. only some IUs were generated), stale
            // markers persist for their 1200s TTL and block re-dispatch.
            for (const ds of filteredDirty) {
                try {
                    const scenePrefix = `${bookId}_${ds.chapter_id}_${ds.scene_id}_iu-`;
                    let cursor = '0';
                    do {
                        const [nextCursor, keys] = await redis.scan(
                            cursor, 'MATCH', `animastor:iu-in-flight:${scenePrefix}*`, 'COUNT', 50
                        );
                        cursor = nextCursor;
                        if (keys.length > 0) {
                            await redis.del(...keys);
                            log(`[REGENERATE-IU-IN-FLIGHT-CLEAR] ${bookId}/${ds.chapter_id}/${ds.scene_id}: cleared ${keys.length} markers`);
                        }
                    } while (cursor !== '0');
                } catch (e) {
                    console.warn(`[REGENERATE-IU-IN-FLIGHT-CLEAR] Failed for ${bookId}/${ds.chapter_id}/${ds.scene_id}: ${e.message}`);
                }
            }

            // Mark dirty scenes (Redis) — routed through the Orchestrator facade
            // (Шаг 0, docs-claude/03_Orchestrator.md): markDirty is the single
            // entry point for declaring "needs regeneration". Delegates back to
            // bookDiff.markDirtyScenes, so behaviour is identical for now.
            const { orchestrator } = require('../orchestration');
            const marked = await orchestrator.markDirty({ bookDiff }, redis, bookId, buildId, filteredDirty, layerCfg);


            // Reconcile PG state (hashes, asset status, tasks) via book-sync
            try {
                await storage.bookSync.reconcileFromDiff(bookId, filteredDirty, loadedBook);

                // R14: Bump version counters for dirty scenes (shared function)
                try {
                    await sceneAssetsRepo.bumpSceneVersions(bookId, filteredDirty);

                    // Store per-unit dirty IDs in PG for granular force-regen
                    for (const ds of filteredDirty) {
                        const unitIds = ds.changes?.units?.unit_ids;
                        if (unitIds && Array.isArray(unitIds) && unitIds.length > 0) {
                            await sceneAssetsRepo.setDirtyUnitIds(bookId, ds.chapter_id, ds.scene_id, unitIds);
                            log(`[DIRTY-UNITS] ${bookId}/${ds.chapter_id}/${ds.scene_id}: ${unitIds.length} dirty unit(s): ${unitIds.join(', ')}`);
                        }
                    }

                    // R16: Log cross-cutting source when version is bumped by entity changes
                    for (const ds of filteredDirty) {
                        if (ds.reason === 'removed') continue;
                        if (ds.changes && typeof ds.changes === 'object') {
                            const crossKeys = Object.keys(ds.changes).filter(k =>
                                k.includes('Character') || k.includes('Location') ||
                                k.includes('characters') || k.includes('bible') ||
                                k.includes('passport') || k.includes('voice')
                            );
                            if (crossKeys.length > 0) {
                                log(`[REGENERATE-CROSS-CUTTING] ${bookId}/${ds.chapter_id}/${ds.scene_id}: version bump triggered by ${crossKeys.join(', ')}`);
                            }
                        }
                    }
                } catch (verErr) {
                    console.warn(`[REGENERATE] Version bump failed: ${verErr.message}`);
                }
            } catch (syncErr) {
                // Non-fatal: PG reconciliation should not block regeneration
                console.warn(`[REGENERATE] PG reconcile failed for ${bookId}: ${syncErr.message}`);
            }

            // Restore chunk metadata for scenes with existing content.
            // Delegated to orchestrator.restoreSceneChunkStatus() (Phase 3: R3.2).
            let restoredCount = 0;
            for (const ds of filteredDirty) {
                const hasDirtyUnits = ds.changes?.units?.unit_ids && ds.changes.units.unit_ids.length > 0;
                const unitIds = hasDirtyUnits ? ds.changes.units.unit_ids : [];
                const result = await restoreSceneChunkStatus(
                    redis, buildId, bookId,
                    ds.chapter_id, ds.scene_id,
                    hasDirtyUnits, unitIds
                );
                if (result.restored) restoredCount++;
            }
            if (restoredCount > 0) {
                log(`[REGENERATE] ${bookId}: restored chunk metadata for ${restoredCount}/${filteredDirty.length} scenes with existing content`);
            }

            // CRITICAL: Add all dirty scenes to active index so runtime scheduler processes them.
            // clearBookFromActiveIndex() at the top removes everything — without this loop
            // the scheduler sees Active: 0 and never dispatches any generation tasks.
            for (const ds of filteredDirty) {
                await scheduler.addSceneToActiveIndex(redis, bookId, ds.chapter_id, ds.scene_id);
            }
            log(`[REGENERATE] ${bookId}: added ${filteredDirty.length} scenes to active index for scheduling`);

            res.json({
                book_id: bookId, scope: effectiveScope,
                dirty_scenes: filteredDirty,
                marked: marked.marked,
                cover_needs_generation: coverNeedsGeneration,
            });
        } catch (err) {
            console.error('[REGENERATE] Error:', err.message);
            res.status(500).json({ error: err.message });
        } finally {
            await releaseRegenerateLock();
        }
    });

    // ======================================================
    // RECOVER PLACEHOLDERS — fix missing placeholder MP3 files
    // ======================================================
    app.post('/api/v1/book/:bookId/recover-placeholders', async (req, res) => {
        try {
            const { bookId } = req.params;
            const { build_id = 'default' } = req.body || {};

            log(`[RECOVER-PLACEHOLDERS] Starting recovery for ${bookId}...`);
            const result = await placeholderAudio.recoverMissingPlaceholders(build_id, bookId);
            log(`[RECOVER-PLACEHOLDERS] ${bookId}: ${result.created} created, ${result.skipped} skipped, ${result.errors.length} errors`);

            return res.json({
                book_id: bookId, build_id,
                checked: result.checked,
                created: result.created,
                skipped: result.skipped,
                errors: result.errors,
                recovered: result.created > 0,
            });
        } catch (err) {
            console.error('[RECOVER-PLACEHOLDERS] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // VERSIONS — diagnostic: view PG version counters per scene
    // ======================================================
    // Version-introspection routes — extracted to ./book/versions-routes.cjs
    // (Architectural Debt #3 split, sub-registrar pattern).
    registerVersionRoutes(app, { storage, sceneAssetsRepo, log });

    log('[ROUTES] Book routes loaded');
};
