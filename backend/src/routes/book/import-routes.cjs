// ======================================================
// Book Import Routes — VBook load, TXT import, Bootstrap
// ======================================================

const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { publishProgress } = require('../../services/progress-pubsub.cjs');

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

    // In-flight TXT trigger guard
    const inFlightTriggers = new Set();

    const buildWindowProgressMeta = (createdScenes, totalScenes) => {
        const toFiniteNumber = (value) => {
            if (value == null) return null;
            const num = Number(value);
            return Number.isFinite(num) ? num : null;
        };
        const created = toFiniteNumber(createdScenes);
        const total = toFiniteNumber(totalScenes);
        if (created == null || total == null || total <= 0) {
            return { window_start_scene: null, window_total_scenes: total, window_scene_index: null };
        }
        return {
            window_start_scene: Math.max(1, created - total + 1),
            window_total_scenes: total,
            window_scene_index: null,
        };
    };

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
    // RESUME BOOTSTRAP
    // ======================================================
    app.post('/api/v1/book/:bookId/resume-bootstrap', async (req, res) => {
        try {
            const { bookId } = req.params;
            const draft = lazyBook.loadDraftBook(bookId);
            if (!draft) return res.status(404).json({ error: 'Book not found' });

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
            const publishVBook = (bid, event) => { publishProgress(redis, bid, event); };
            const result = await txtImporter.bootstrapImportedText(bookId, null, publishVBook);

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

                try {
                    await redis.set(config.BOOK_SCENE_TOTAL(bookId), result.chapter.scenes.length);
                    await redis.set(config.BOOK_SCENE_NEXT(bookId), result.chapter.scenes.length);
                } catch (idxErr) {
                    console.warn(`[BOOTSTRAP] Failed to set scene index: ${idxErr.message}`);
                }

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
            const publishVBook = (bid, event) => { publishProgress(redis, bid, event); };
            const result = await txtImporter.bootstrapNextWindow(bookId, null, publishVBook);
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

                if (inFlightTriggers.has(bookId)) {
                    log(`[TRIGGER] ⏳ TXT book ${bookId} already has an in-flight trigger, queuing`);
                    return res.json({ triggered: false, queued: true, book_id: bookId, source: 'txt_import' });
                }
                inFlightTriggers.add(bookId);

                log(`[TRIGGER] TXT book ${bookId}: calling bootstrapNextWindow`);
                const publishVBook = (bid, event) => { publishProgress(redis, bid, event); };
                setImmediate(async () => {
                    try {
                        const nextRes = await txtImporter.bootstrapNextWindow(bookId, null, publishVBook);
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

            // VBook / windowGenerator path
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
};
