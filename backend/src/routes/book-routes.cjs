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
    } = deps;
    const { log, pad, collectScenes, buildSegments } = utils;

    // ======================================================
    // GET BOOK DATA (used by frontend Editor & Navigator)
    // ======================================================
    app.get('/api/v1/book/:bookId', async (req, res) => {
        try {
            const { bookId } = req.params;
            const bookData = book.loadBook(bookId);
            if (!bookData) return res.status(404).json({ error: 'Book not found' });
            return res.json(bookData);
        } catch (err) {
            console.error('[GET BOOK] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

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
                setImmediate(async () => {
                    try {
                        const buildId = 'default';
                        const scenes = result.chapter.scenes.map(s => ({ chapter_id: result.chapter.chapter, scene_id: s.scene_id }));
                        log(`[BOOTSTRAP] Generating placeholder audio for ${scenes.length} scenes...`);
                        const phResult = await placeholderAudio.ensureAllPlaceholderAudio(buildId, bookId, scenes);
                        log(`[BOOTSTRAP] Placeholder audio: ${phResult.created} created, ${phResult.skipped} skipped`);
                    } catch (phErr) {
                        console.warn(`[BOOTSTRAP] Placeholder audio generation failed: ${phErr.message}`);
                    }
                });
            }

            return res.json({
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
    // TRIGGER NEXT WINDOW
    // ======================================================
    app.post('/api/v1/book/:bookId/trigger-next-window', async (req, res) => {
        try {
            const { bookId } = req.params;
            const { chapter_id, scene_id, unit_id } = req.body || {};

            if (!bookId) return res.status(400).json({ error: 'bookId required' });

            const draft = lazyBook.loadDraftBook(bookId);
            if (!draft || !draft.sourceText) return res.status(404).json({ error: 'Book not found' });

            if (draft.manifest.state !== lazyBook.BookState.BOOTSTRAPPED) {
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
                            if (!found) log(`[TRIGGER] ${bookId}: scene ${scene_id} not in chapter ${chapter_id}, continuing anyway`);
                            break;
                        }
                    }
                }
            }

            const lastWindow = await genSessionRepo.getHighestCompletedWindow(bookId);
            const nextWindowIndex = lastWindow + 1;

            const chapters = lazyBook.splitIntoChapters(draft.sourceText);
            if (nextWindowIndex >= chapters.length) {
                return res.json({ triggered: false, error: 'No more text to process', all_done: true });
            }

            const activeSessions = await genSessionRepo.getSessionsByStatus(bookId, 'generating');
            const pendingSessions = await genSessionRepo.getSessionsByStatus(bookId, 'pending');

            if (activeSessions.length > 0 || pendingSessions.length > 0) {
                const queuedSession = await genSessionRepo.createSession(bookId, nextWindowIndex, 3);
                await genSessionRepo.updateSession(queuedSession.id, { status: 'queued' });
                log(`[TRIGGER] ${bookId}: queued window ${nextWindowIndex} (generation already active)`);
                return res.json({ triggered: false, queued: true, session_id: queuedSession.id, window_index: nextWindowIndex });
            }

            const session = await genSessionRepo.createSession(bookId, nextWindowIndex, 3);
            const chInfo = chapters[nextWindowIndex];
            const sourceOffsetStart = chInfo ? chInfo.startOffset || 0 : 0;
            const sourceOffsetEnd = chInfo ? chInfo.endOffset || 0 : 0;
            await genSessionRepo.updateSession(session.id, {
                source_offset_start: sourceOffsetStart, source_offset_end: sourceOffsetEnd,
            });

            setImmediate(() => {
                windowGenerator.runBackgroundWindowGeneration(bookId, session.id).catch(err => {
                    console.error(`[TRIGGER] Background gen crashed: ${err.message}`);
                });
            });

            log(`[TRIGGER] ${bookId}: started background window ${nextWindowIndex}, session=${session.id} (from PG ${lastWindow})`);
            return res.json({ triggered: true, session_id: session.id, window_index: nextWindowIndex });
        } catch (err) {
            console.error('[TRIGGER-NEXT-WINDOW] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // AGENT STATUS
    // ======================================================
    app.get('/api/v1/book/:bookId/agent-status', async (req, res) => {
        try {
            const { bookId } = req.params;
            const result = await storage.postgres.query(`
                SELECT session_id, status as session_status, progress_msg,
                       window_data, knowledge_base, source_type
                FROM agent_sessions
                WHERE book_id = $1
                ORDER BY created_at DESC
                LIMIT 1
            `, [bookId]);

            const row = result.rows[0];
            if (!row) return res.json({ active: false, message: 'No active agent session' });

            let windowData = null;
            let windowIndex = null;
            let createdScenes = null;
            let totalScenes = null;
            let remainingCached = null;

            if (row.window_data) {
                try {
                    windowData = typeof row.window_data === 'string' ? JSON.parse(row.window_data) : row.window_data;
                    windowIndex = windowData.window_index;
                    createdScenes = windowData.created_scenes;
                    totalScenes = windowData.total_scenes;
                    remainingCached = windowData.remaining_scenes ? windowData.remaining_scenes.length : 0;
                } catch (e) { /* ignore */ }
            }

            return res.json({
                active: row.session_status === 'running', session_id: row.session_id,
                session_status: row.session_status, progress_msg: row.progress_msg || 'Working...',
                source_type: row.source_type, window_index: windowIndex,
                created_scenes: createdScenes, total_scenes: totalScenes, remaining_cached: remainingCached,
            });
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
                    const buildId = 'default';
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

            // Clean up Redis keys
            const patterns = [
                `animastor:chunk:${bookId}_*`,
                `animastor:chunks:${bookId}`,
                `animastor:scene-state:${bookId}:*`,
                `animastor:scene:*:*:${bookId}`,
                `animastor:layer-config:${bookId}`,
                `animastor:scope:${bookId}`,
                `animastor:asset:*:${bookId}:*`,
                `animastor:snapshot:${bookId}`,
                `animastor:lease:*:${bookId}:*`,
                `animastor:audio-scene-lock:${bookId}:*`,
                `animastor:audio-scene-failsafe:*:${bookId}:*`,
                `animastor:job:${bookId}_*`,
                `animastor:mode:${bookId}`,
                `animastor:book:${bookId}:*`,
            ];

            for (const pattern of patterns) {
                try {
                    let cursor = 0;
                    do {
                        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
                        cursor = parseInt(result[0], 10);
                        const keys = result[1];
                        if (keys.length > 0) await redis.del(...keys);
                    } while (cursor !== 0);
                } catch (_) {}
            }

            // Clean up PostgreSQL
            try {
                await storage.postgres.query('DELETE FROM scene_assets_cache WHERE book_id = $1', [bookId]);
                await storage.postgres.query('DELETE FROM scene_assets_state WHERE book_id = $1', [bookId]);
                await storage.postgres.query('DELETE FROM scene_images WHERE book_id = $1', [bookId]);
                await storage.postgres.query('DELETE FROM scene_videos WHERE book_id = $1', [bookId]);
            } catch (dbErr) {
                console.warn('[CACHE] DB cleanup failed:', dbErr.message);
            }

            // Reset active scenes
            await redis.srem('animastor:active-scenes', ...(chunkIds.map(id => `${bookId}:*`)));
            try {
                const reconcileCounters = require('../runtime/counter-reconciliation');
                await reconcileCounters.reconcileCounters(redis);
            } catch (_) {}

            // Clear gpu-hub queue
            try {
                const HUB_URL = process.env.HUB_URL || 'https://animastor.in/gpu';
                await fetch(`${HUB_URL}/api/v1/queue/${bookId}`, { method: 'DELETE' }).catch(() => {});
            } catch (_) {}

            log('[CACHE] Cache cleared for', bookId);
            res.json({ cleared: true, book_id: bookId, builds_removed: buildIds.size });
        } catch (err) {
            console.error('[CACHE] Delete error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // SELECTIVE REGENERATION
    // ======================================================
    app.post('/api/v1/book/:bookId/regenerate', async (req, res) => {
        try {
            const { bookId } = req.params;
            const { scope, chapter_id, scene_id, profile } = req.body || {};

            const loadedBook = book.loadBook(bookId);
            if (!loadedBook) return res.status(404).json({ error: 'book not found' });

            const buildId = loadedBook.manifest?.build_id || 'default';

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

            // Compute diff between current and existing book
            const existingBook = book.loadBook(bookId);
            const diff = bookDiff.computeBookDiff(existingBook, loadedBook);
            log(`[REGENERATE] ${bookId}: ${diff.changes.added} added, ${diff.changes.removed} removed, ${diff.changes.modified} modified`);

            // Filter by scope
            const allScenes = book.collectScenes(loadedBook);
            const filteredDirty = bookDiff.filterDirtyScenesByScope(
                diff.dirty_scenes, effectiveScope, chapter_id, scene_id, allScenes
            );

            // Mark dirty scenes
            const marked = await bookDiff.markDirtyScenes(redis, bookId, buildId, filteredDirty, layerCfg);

            res.json({
                book_id: bookId, scope: effectiveScope,
                diff: diff.changes, dirty_scenes: filteredDirty.length,
                marked: marked.marked,
            });
        } catch (err) {
            console.error('[REGENERATE] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    log('[ROUTES] Book routes loaded');
};
