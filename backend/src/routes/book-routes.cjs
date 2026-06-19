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
                await recoverMissingRedisChunks(buildId, bookId);
            } catch (chunkErr) {
                console.warn(`[BOOK-RECOVER] ${bookId}: chunk recovery failed: ${chunkErr.message}`);
            }

            return res.json(bookData);
        } catch (err) {
            console.error('[GET BOOK] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

/**
 * Create Redis chunks for scenes that exist in the book JSON but don't
 * have corresponding chunks in Redis. Also updates scene counters.
 */
async function recoverMissingRedisChunks(buildId, bookId) {
    const loadedBook = book.loadBook(bookId);
    if (!loadedBook) return;

    const allScenes = book.collectScenes(loadedBook);
    if (allScenes.length === 0) return;

    const existingChunkIds = await getAllChunks(bookId);
    const existingKeys = new Set(existingChunkIds);

    let created = 0;
    for (const s of allScenes) {
        const chunkId = `${bookId}_${s.chapter_id}_${s.scene_id}_0001`;
        if (existingKeys.has(chunkId)) continue;

        try {
            await saveChunk(chunkId, {
                build_id: buildId, book_id: bookId, scene_order: s.scene_order || 0,
                chapter_id: s.chapter_id, scene_id: s.scene_id, chunk_index: '0001',
                expected_chunk_count: 1, scene_type: s.scene_type || 'narration',
                audio: true, audio_status: 'placeholder', image: false, video: false,
                video_status: 'pending', padded_text: false,
            });
            created++;
        } catch (chunkErr) {
            console.warn(`[BOOK-RECOVER] Failed to create chunk ${chunkId}: ${chunkErr.message}`);
        }

        // Also ensure scene is registered in activeScenes for GPU scheduler
        try {
            await state.setSceneStateWithBuildId(
                redis, bookId, s.chapter_id, s.scene_id,
                state.SceneState.AUDIO_PENDING, buildId
            );
            await activeScenes.addActiveScene(
                redis, bookId, s.chapter_id, s.scene_id
            );
        } catch (regErr) {
            console.warn(`[BOOK-RECOVER] Failed to register scene ${s.chapter_id}/${s.scene_id}: ${regErr.message}`);
        }
    }

    if (created > 0) {
        // Update scene counters
        try {
            const totalStr = await redis.get(config.BOOK_SCENE_TOTAL(bookId));
            const nextStr = await redis.get(config.BOOK_SCENE_NEXT(bookId));
            const existingTotal = parseInt(totalStr || '0', 10);
            const existingNext = parseInt(nextStr || '0', 10);
            await redis.set(config.BOOK_SCENE_TOTAL(bookId), existingTotal + created);
            await redis.set(config.BOOK_SCENE_NEXT(bookId), existingNext + created);
        } catch (idxErr) {
            console.warn(`[BOOK-RECOVER] Failed to update scene indices: ${idxErr.message}`);
        }
        log(`[BOOK-RECOVER] ${bookId}: created ${created} missing Redis chunks`);
    }
}

/**
 * Delete all dispatch-lease keys for a book.
 * Stale leases cause the frontend worker toggle to pulse even when
 * no real GPU work is happening — leases have 30-120 min TTL.
 */
async function clearBookLeases(redis, bookId) {
    const DISPATCH_LEASE_PREFIX = 'animastor:dispatch-lease';
    const pattern = `${DISPATCH_LEASE_PREFIX}:${bookId}:*`;
    let cursor = 0;
    let deleted = 0;
    do {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = parseInt(result[0], 10);
        const keys = result[1];
        if (keys.length > 0) {
            await redis.del(...keys);
            deleted += keys.length;
        }
    } while (cursor !== 0);
    if (deleted > 0) {
        log(`[CLEAR-BOOK-LEASES] ${bookId}: deleted ${deleted} stale dispatch leases`);
    }
}

/**
 * Delete all dispatch-meta keys for a book.
 */
async function clearBookDispatchMeta(redis, bookId) {
    const DISPATCH_META_PREFIX = 'animastor:dispatch-meta';
    const pattern = `${DISPATCH_META_PREFIX}:${bookId}:*`;
    let cursor = 0;
    let deleted = 0;
    do {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = parseInt(result[0], 10);
        const keys = result[1];
        if (keys.length > 0) {
            await redis.del(...keys);
            deleted += keys.length;
        }
    } while (cursor !== 0);
    if (deleted > 0) {
        log(`[CLEAR-BOOK-META] ${bookId}: deleted ${deleted} dispatch metadata keys`);
    }
}

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
            book.saveBookBundle(updatedBookData, null);
            log(`[UPDATE BOOK] ${bookId}: ${updatedBookData.chapters?.length || 0} chapters saved`);
            return res.json({ saved: true, book_id: bookId });
        } catch (err) {
            console.error('[UPDATE BOOK] Error:', err.message);
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
                SELECT id, status, progress_msg, window_data
                FROM agent_sessions
                WHERE book_id = $1 AND status IN ('running', 'pending')
                ORDER BY created_at DESC LIMIT 1
            `, [bookId]);

            if (activeSessions.rows.length > 0) {
                const session = activeSessions.rows[0];
                log(`[RESUME-BOOTSTRAP] ${bookId}: active session ${session.id} (${session.status})`);
                return res.json({
                    book_id: bookId, state: 'resuming',
                    session_id: session.id, session_status: session.status,
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

            // Process remaining windows in background so the frontend can
            // see all scenes immediately without manual trigger.
            if (result.has_more) {
                setImmediate(async () => {
                    try {
                        log(`[BOOTSTRAP] Starting background window processing for ${bookId}`);
                        for (let w = 0; w < 100; w++) {
                            const nextRes = await txtImporter.bootstrapNextWindow(bookId);
                            if (nextRes.all_done) break;
                            const added = nextRes.added_scenes || 0;
                            log(`[BOOTSTRAP] Background window ${w + 1}: ${added} scenes, remaining_cached=${nextRes.remaining_cached || 0}, all_done=${nextRes.all_done}`);

                            const chapterId = nextRes.chapter?.chapter;
                            const allScenes = nextRes.chapter?.scenes || [];
                            const newScenes = allScenes.slice(-added);
                            if (chapterId && newScenes.length > 0) {
                                const draftBg = lazyBook.loadDraftBook(bookId);
                                const buildId = draftBg?.manifest?.build_id || 'default';
                                for (let si = 0; si < newScenes.length; si++) {
                                    const s = newScenes[si];
                                    const chunkId = `${bookId}_${chapterId}_${s.scene_id}_0001`;
                                    const sceneOrder = allScenes.indexOf(s);
                                    try {
                                        await saveChunk(chunkId, {
                                            build_id: buildId, book_id: bookId, scene_order: sceneOrder,
                                            chapter_id: chapterId, scene_id: s.scene_id, chunk_index: '0001',
                                            expected_chunk_count: 1, scene_type: s.type || 'narration',
                                            audio: true, audio_status: 'placeholder', image: false, video: false,
                                            video_status: 'pending', padded_text: false,
                                        });
                                    } catch (chunkErr) {
                                        console.warn(`[BOOTSTRAP] Background chunk creation failed for ${chunkId}: ${chunkErr.message}`);
                                    }
                                }
                                try {
                                    const existingTotal = parseInt(await redis.get(config.BOOK_SCENE_TOTAL(bookId)) || '0', 10);
                                    const existingNext = parseInt(await redis.get(config.BOOK_SCENE_NEXT(bookId)) || '0', 10);
                                    await redis.set(config.BOOK_SCENE_TOTAL(bookId), existingTotal + newScenes.length);
                                    await redis.set(config.BOOK_SCENE_NEXT(bookId), existingNext + newScenes.length);
                                } catch (idxErr) {
                                    console.warn(`[BOOTSTRAP] Failed to update scene counters: ${idxErr.message}`);
                                }
                                try {
                                    const phScenes = newScenes.map(s => ({ chapter_id: chapterId, scene_id: s.scene_id }));
                                    const phResult = await placeholderAudio.ensureAllPlaceholderAudio(buildId, bookId, phScenes);
                                    log(`[BOOTSTRAP] Background placeholder audio: ${phResult.created} created, ${phResult.skipped} skipped`);
                                } catch (phErr) {
                                    console.warn(`[BOOTSTRAP] Background placeholder audio failed: ${phErr.message}`);
                                }
                            }
                        }
                        log(`[BOOTSTRAP] Background window processing complete for ${bookId}`);
                    } catch (bgErr) {
                        console.error(`[BOOTSTRAP] Background window chain failed for ${bookId}: ${bgErr.message}`);
                    }
                }, 0);
            }
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
                const bookData = lazyBook.loadBook(bookId);
                if (bookData) {
                    let found = false;
                    for (const ch of (bookData.chapters || [])) {
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

    // ======================================================
    // GENERATION STATE
    // ======================================================
    app.get('/api/v1/book/:bookId/generation-state', async (req, res) => {
        try {
            const { bookId } = req.params;
            const state_data = await genSessionRepo.getGenerationState(bookId);
            const bookStatus = lazyBook.getBookStatus(bookId);
            const totalChapters = bookStatus?.totalChapters || 0;
            const parsedChapters = bookStatus?.parsedChapters || 0;

            return res.json({
                ...state_data, book_id: bookId,
                total_chapters: totalChapters, parsed_chapters: parsedChapters,
                remaining: totalChapters - parsedChapters,
            });
        } catch (err) {
            console.error('[GENERATION-STATE] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // BOOK STATUS
    // ======================================================
    app.get('/api/v1/book/:bookId/status', async (req, res) => {
        try {
            const { bookId } = req.params;
            const status = lazyBook.getBookStatus(bookId);
            if (!status) return res.status(404).json({ error: 'Book not found' });

            const genState = await genSessionRepo.getGenerationState(bookId);
            return res.json({
                ...status, generation_status: genState.status,
                last_window_index: genState.last_window_index,
                generation_error: genState.error,
                active_generation: genState.active_status,
            });
        } catch (err) {
            console.error('BOOK STATUS ERROR:', err);
            return res.status(400).json({ error: err.message || 'unknown error' });
        }
    });

    // ======================================================
    // SOURCE CHAPTERS
    // ======================================================
    app.get('/api/v1/book/:bookId/source-chapters', async (req, res) => {
        try {
            const { bookId } = req.params;
            const draft = lazyBook.loadDraftBook(bookId);
            if (!draft) return res.status(404).json({ error: 'Book not found' });
            if (!draft.sourceText) return res.status(400).json({ error: 'Book has no source text' });
            const chapters = lazyBook.splitIntoChapters(draft.sourceText);
            return res.json({ chapters, total: chapters.length });
        } catch (err) {
            console.error('SOURCE-CHAPTERS ERROR:', err);
            return res.status(400).json({ error: err.message || 'unknown error' });
        }
    });

    // ======================================================
    // CHAPTERS SUMMARY
    // ======================================================
    app.get('/api/v1/book/:bookId/chapters-summary', async (req, res) => {
        try {
            const { bookId } = req.params;
            const summary = txtImporter.getParsedChaptersSummary(bookId);
            if (!summary) return res.status(404).json({ error: 'Book not found' });
            return res.json(summary);
        } catch (err) {
            console.error('CHAPTERS SUMMARY ERROR:', err);
            return res.status(400).json({ error: err.message || 'unknown error' });
        }
    });

    // ======================================================
    // LAZY PARSE
    // ======================================================
    app.post('/api/v1/book/:bookId/lazy-parse', async (req, res) => {
        try {
            const { bookId } = req.params;
            const windowSize = req.body?.windowSize || config.LAZY_WINDOW_SIZE;
            const result = txtImporter.lazyParseNext(bookId, windowSize);
            log(`[LAZY-PARSE] ${bookId}: parsed ${result.parsed} chapters (window ${result.windowStart}-${result.windowEnd}, complete=${result.complete})`);

            setImmediate(async () => {
                try {
                    const draftLazy = lazyBook.loadDraftBook(bookId);
                    const buildId = draftLazy?.manifest?.build_id || 'default';
                    const scenes = await placeholderAudio.getScenesNeedingPlaceholder(bookId);
                    log(`[LAZY-PARSE] Checking placeholder audio for ${scenes.length} total scenes...`);
                    const phResult = await placeholderAudio.ensureAllPlaceholderAudio(buildId, bookId, scenes);
                    log(`[LAZY-PARSE] Placeholder audio: ${phResult.created} created, ${phResult.skipped} skipped`);
                } catch (phErr) {
                    console.warn(`[LAZY-PARSE] Placeholder audio generation failed: ${phErr.message}`);
                }
            });

            return res.json({
                parsed: result.parsed, window_start: result.windowStart, window_end: result.windowEnd,
                complete: result.complete,
                chapters: result.chapters.map(ch => ({
                    chapter: ch.chapter, chapter_title: ch.chapter_title,
                    chapter_index: ch.chapter_index, status: ch.status,
                    scene_count: ch.scenes ? ch.scenes.length : 0,
                })),
            });
        } catch (err) {
            console.error('LAZY-PARSE ERROR:', err);
            return res.status(400).json({ error: err.message || 'unknown error' });
        }
    });

    // ======================================================
    // LAZY PARSE TO
    // ======================================================
    app.post('/api/v1/book/:bookId/lazy-parse-to', async (req, res) => {
        try {
            const { bookId } = req.params;
            const chapterIndex = req.body?.chapterIndex;
            const windowSize = req.body?.windowSize || config.LAZY_WINDOW_SIZE;
            if (chapterIndex === undefined || chapterIndex === null) {
                return res.status(400).json({ error: 'chapterIndex is required' });
            }
            const result = txtImporter.lazyParseToPosition(bookId, chapterIndex, windowSize);
            log(`[LAZY-PARSE-TO] ${bookId}: parsed chapter ${chapterIndex}`);
            return res.json({
                chapter: result.chapter, was_existing: result.wasExisting,
                pre_parsed_ahead: result.preParsedAhead || 0,
            });
        } catch (err) {
            console.error('LAZY-PARSE-TO ERROR:', err);
            return res.status(400).json({ error: err.message || 'unknown error' });
        }
    });

    // ======================================================
    // IMPORT TEXT (via AI)
    // ======================================================
    app.post('/api/v1/book/import-text', async (req, res) => {
        try {
            const { text, title } = req.body;
            if (!text) return res.status(400).json({ error: 'text is required' });

            const validation = txtImporter.validateAiText(text);
            if (!validation.valid) return res.status(400).json({ error: validation.errors.join('; ') });

            const draft = lazyBook.createDraftBook(text, lazyBook.SourceType.AI_IMPORT, title || 'Imported Text');
            log(`[IMPORT-TEXT] RAW_IMPORTED: ${draft.bookId} (${Buffer.byteLength(text, 'utf8')} bytes)`);
            return res.json({ book_id: draft.bookId, title: title || 'Imported Text', state: lazyBook.BookState.RAW_IMPORTED });
        } catch (err) {
            console.error('IMPORT-TEXT ERROR:', err);
            return res.status(400).json({ error: err.message || 'unknown error' });
        }
    });

    // ======================================================
    // BOOK SOURCE TEXT
    // ======================================================
    app.get('/api/v1/book/:bookId/source', async (req, res) => {
        try {
            const { bookId } = req.params;
            const draft = lazyBook.loadDraftBook(bookId);
            if (!draft || !draft.sourceText) return res.status(404).json({ error: 'Source text not found' });
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.send(draft.sourceText);
        } catch (err) {
            console.error('SOURCE ERROR:', err);
            return res.status(400).json({ error: err.message || 'unknown error' });
        }
    });

    // ======================================================
    // BOOK SNAPSHOT
    // ======================================================
    app.post('/api/v1/book/:bookId/snapshot', async (req, res) => {
        try {
            const { bookId } = req.params;
            const result = await taskHandler.saveBookSnapshot(bookId);
            if (!result) return res.status(404).json({ error: 'Book not found' });
            return res.json({ saved: true, path: result });
        } catch (err) {
            console.error('SNAPSHOT ERROR:', err);
            return res.status(400).json({ error: err.message || 'unknown error' });
        }
    });

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

            let filteredIds = allChunkIds;
            if ((scope === 'current_chapter' || scope === 'chapter') && chapter_id) {
                filteredIds = [];
                for (const cid of allChunkIds) {
                    try {
                        const chunk = await getChunk(cid);
                        if (chunk?.chapter_id === chapter_id) {
                            filteredIds.push(cid);
                        }
                    } catch (_) {}
                }
            } else if ((scope === 'current_scene' || scope === 'scene') && chapter_id && scene_id) {
                filteredIds = [];
                for (const cid of allChunkIds) {
                    try {
                        const chunk = await getChunk(cid);
                        if (chunk?.chapter_id === chapter_id && chunk?.scene_id === scene_id) {
                            filteredIds.push(cid);
                        }
                    } catch (_) {}
                }
            }

            let audioReady = 0;
            let imageReady = 0;
            let videoReady = 0;
            let hasAudio = false;
            let hasImage = false;
            let hasVideo = false;

            for (const cid of filteredIds) {
                try {
                    const chunk = await getChunk(cid);
                    if (chunk) {
                        if (chunk.audio_status === 'ready' || chunk.audio_status === 'placeholder') {
                            audioReady++;
                            hasAudio = true;
                        }
                        if (chunk.image_status === 'ready') {
                            imageReady++;
                            hasImage = true;
                        }
                        if (chunk.video_status === 'ready') {
                            videoReady++;
                            hasVideo = true;
                        }
                    }
                } catch (_) {}
            }

            let scopeIuTotal = 0;
            let scopeIuReady = 0;
            let coverIuTotal = 0;
            let coverIuReady = 0;
            try {
                const firstChunk = await getChunk(filteredIds[0]);
                let buildId = firstChunk?.build_id;
                
                // If filteredIds is empty, try to get buildId from any chunk
                if (!buildId) {
                    const anyChunk = await getChunk((await getAllChunks(bookId))[0]);
                    buildId = anyChunk?.build_id;
                }
                
                if (buildId) {
                    const buildDir = path.join(config.OUTPUT_DIR, buildId);
                    const uniqueScenes = new Map();
                    for (const cid of filteredIds) {
                        const chunk = await getChunk(cid);
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
                            const prefix = `${bookId}_${ch}_${sc}_iu`;
                            let files = [];
                            try { files = fs.readdirSync(buildDir); } catch (_) {}
                            const ready = files.filter(f => f.startsWith(prefix) && f.endsWith('.png')).length;
                            scopeIuReady += Math.min(ready, rows.length);
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
                                const coverPrefix = `${bookId}_${coverChapterId}_${coverSceneId}_iu`;
                                let files = [];
                                try { files = fs.readdirSync(buildDir); } catch (_) {}
                                coverIuReady = Math.min(files.filter(f => f.startsWith(coverPrefix) && f.endsWith('.png')).length, rows.length);
                            } else {
                                // Fallback: count from book data units
                                const units = coverScene.units || [];
                                coverIuTotal = units.length;
                                if (coverIuTotal > 0) {
                                    const coverPrefix = `${bookId}_${coverChapterId}_${coverSceneId}_iu`;
                                    let files = [];
                                    try { files = fs.readdirSync(buildDir); } catch (_) {}
                                    coverIuReady = Math.min(files.filter(f => f.startsWith(coverPrefix) && f.endsWith('.png')).length, units.length);
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
                scope_image_ready: imageReady,
                scope_video_ready: videoReady,
                scope_all_audio_ready: audioReady === filteredIds.length && filteredIds.length > 0,
                scope_all_image_ready: imageReady === filteredIds.length && filteredIds.length > 0,
                scope_all_video_ready: videoReady === filteredIds.length && filteredIds.length > 0,
                scope_iu_total: scopeIuTotal,
                scope_iu_ready: scopeIuReady,
                cover_iu_total: coverIuTotal,
                cover_iu_ready: coverIuReady,
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
            // Also reset the scheduler's own backpressure counters (different keys)
            await redis.del('animastor:concurrent-audio');
            await redis.del('animastor:concurrent-image');
            await redis.del('animastor:concurrent-video');

            // CRITICAL: Stale dispatch-lease keys cause the frontend worker toggle
            // to pulse even when no real GPU work is happening. Each lease has a
            // TTL of 30-120 minutes — without explicit cleanup the toggle would
            // pulse for up to 2 hours after cancel, wasting GPU credits.
            // Delete all dispatch leases + metadata for this book.
            await clearBookLeases(redis, bookId);
            // Also clean up dispatch metadata keys for this book
            await clearBookDispatchMeta(redis, bookId);

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
    app.get('/api/v1/book/:bookId/cache', async (req, res) => {
        try {
            const { bookId } = req.params;
            const cacheStatus = {};
            try {
                const pgRows = await storage.postgres.query(`
                    SELECT chapter_id, scene_id, status, layer
                    FROM scene_assets_cache
                    WHERE book_id = $1
                `, [bookId]);
                for (const row of pgRows.rows) {
                    if (!cacheStatus[row.chapter_id]) cacheStatus[row.chapter_id] = {};
                    if (!cacheStatus[row.chapter_id][row.scene_id]) cacheStatus[row.chapter_id][row.scene_id] = [];
                    cacheStatus[row.chapter_id][row.scene_id].push({ status: row.status, layer: row.layer });
                }
            } catch (dbErr) {
                console.warn('[CACHE] DB query failed:', dbErr.message);
            }
            const totalStale = Object.values(cacheStatus).reduce((acc, ch) =>
                acc + Object.values(ch).reduce((acc2, sc) => acc2 + sc.filter(s => s.status === 'stale').length, 0), 0);
            const totalPending = Object.values(cacheStatus).reduce((acc, ch) =>
                acc + Object.values(ch).reduce((acc2, sc) => acc2 + sc.filter(s => s.status === 'pending').length, 0), 0);
            const totalReady = Object.values(cacheStatus).reduce((acc, ch) =>
                acc + Object.values(ch).reduce((acc2, sc) => acc2 + sc.filter(s => s.status === 'ready').length, 0), 0);
            res.json({ book_id: bookId, chapters: cacheStatus, summary: { stale: totalStale, pending: totalPending, ready: totalReady } });
        } catch (err) {
            console.error('[CACHE] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/api/v1/book/:bookId/cache', async (req, res) => {
        try {
            const { bookId } = req.params;

            // Get build IDs from chunks
            const chunkIds = await getAllChunks(bookId);
            const buildIds = new Set();
            for (const cid of chunkIds) {
                try {
                    const chunk = await getChunk(cid);
                    if (chunk?.build_id) buildIds.add(chunk.build_id);
                } catch (_) {}
            }

            // Clean up build directories
            const OUTPUT_DIR = config.OUTPUT_DIR;
            for (const buildId of buildIds) {
                const buildPath = path.join(OUTPUT_DIR, buildId);
                if (fs.existsSync(buildPath)) {
                    try { fs.rmSync(buildPath, { recursive: true, force: true }); } catch (e) {
                        console.warn('[CACHE] Failed to delete build dir:', buildPath);
                    }
                }
            }

            // Clean up ALL Redis keys for this book using the comprehensive helper
            await cleanBookRedisKeys(redis, bookId);

            // Clean up PostgreSQL
            try {
                await storage.postgres.query('DELETE FROM scene_assets_cache WHERE book_id = $1', [bookId]);
                await storage.postgres.query('DELETE FROM scene_assets_state WHERE book_id = $1', [bookId]);
                await storage.postgres.query('DELETE FROM scene_images WHERE book_id = $1', [bookId]);
                await storage.postgres.query('DELETE FROM scene_videos WHERE book_id = $1', [bookId]);
            } catch (dbErr) {
                console.warn('[CACHE] DB cleanup failed:', dbErr.message);
            }

            // Clear gpu-hub queue
            try {
                const HUB_URL = process.env.HUB_URL || 'https://animastor.in/gpu';
                await fetch(`${HUB_URL}/queue/clear?book_id=${bookId}`, { method: 'DELETE' }).catch(() => {});
            } catch (_) {}

            log('[CACHE] Cache cleared for', bookId);
            res.json({ cleared: true, book_id: bookId, builds_removed: buildIds.size });
        } catch (err) {
            console.error('[CACHE] Delete error:', err.message);
            res.status(500).json({ error: err.message });
        }
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
            await redis.del('animastor:concurrent-audio');
            await redis.del('animastor:concurrent-image');
            await redis.del('animastor:concurrent-video');

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
            await clearBookLeases(redis, bookId);
            await clearBookDispatchMeta(redis, bookId);

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

            // Mark dirty scenes
            const marked = await bookDiff.markDirtyScenes(redis, bookId, buildId, filteredDirty, layerCfg);

            // Immediately restore chunk metadata for scenes that already have
            // valid content on disk. Otherwise /assets-state would report stale
            // 'pending' status until the runtime scheduler tick (up to 5s later)
            // processes each scene via executeAudioDispatch.
            // Also promote scene state to VIDEO_READY and remove from active index
            // so the runtime tick skips them entirely.
            let restoredCount = 0;
            for (const ds of filteredDirty) {
                if (await windowModule.sceneHasValidContent(redis, buildId, bookId, ds.chapter_id, ds.scene_id)) {
                    await windowModule.restoreChunkStatusForScene(redis, buildId, bookId, ds.chapter_id, ds.scene_id);
                    await state.setSceneStateWithBuildId(redis, bookId, ds.chapter_id, ds.scene_id, state.SceneState.VIDEO_READY, buildId);
                    await scheduler.removeSceneFromActiveIndex(redis, bookId, ds.chapter_id, ds.scene_id);
                    restoredCount++;
                }
            }
            if (restoredCount > 0) {
                log(`[REGENERATE] ${bookId}: restored chunk metadata for ${restoredCount}/${filteredDirty.length} scenes with existing content`);
            }

            res.json({
                book_id: bookId, scope: effectiveScope,
                dirty_scenes: filteredDirty,
                marked: marked.marked,
                cover_needs_generation: coverNeedsGeneration,
            });
        } catch (err) {
            console.error('[REGENERATE] Error:', err.message);
            res.status(500).json({ error: err.message });
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

    log('[ROUTES] Book routes loaded');
};
