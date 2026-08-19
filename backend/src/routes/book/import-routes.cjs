// ======================================================
// Book Import Routes — VBook load, TXT import, Bootstrap
// ======================================================

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { publishProgress } = require('../../services/progress-pubsub.cjs');

// ======================================================
// FALLBACK DEDUP: scan books dir for lazy books matching file hash
// Used when book_source PG record was already deleted (e.g. by old bug).
// ======================================================
function findLazyBookByHash(fileHash, booksDir, fileSize) {
    try {
        if (!fs.existsSync(booksDir)) return null;
        const entries = fs.readdirSync(booksDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const bookDir = path.join(booksDir, entry.name);
            const sourcePath = path.join(bookDir, 'source.txt');
            if (!fs.existsSync(sourcePath)) continue;
            try {
                // Quick size filter: stat is cheap (metadata only, no data read).
                // This eliminates 99% of books before any SHA256 computation.
                const sourceStat = fs.statSync(sourcePath);
                if (fileSize != null && sourceStat.size !== fileSize) continue;

                // Full SHA256 verification — only runs for size-matched candidates (0-2).
                const sourceBuf = fs.readFileSync(sourcePath);
                const sourceHash = crypto.createHash('sha256').update(sourceBuf).digest('hex');
                if (sourceHash === fileHash) {
                    return entry.name;
                }
            } catch (_) {
                // skip unreadable books
            }
        }
    } catch (_) {
        // books dir may not exist
    }
    return null;
}

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
    const { log } = utils;

    // Workspace ownership (Account System foundation): every imported/loaded
    // book gets a books row with a workspace. Non-fatal: PG down must not
    // break imports — ownership self-heals via GET /api/v1/books.
    const workspaceOwnership = deps.workspaceOwnership
        || require('../../middleware/workspace-ownership');
    const attachBookWorkspace = async (bookId, bookTitle, wsId) => {
        try {
            await workspaceOwnership.resolveWorkspaceForBook(bookId, {
                bookTitle,
                preferredWorkspaceId: wsId || null,
            });
        } catch (err) {
            console.warn(`[IMPORT] Ownership attach failed for ${bookId} (non-fatal): ${err.message}`);
        }
    };

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
// UNIFIED IMPORT — server-side format detection
// ======================================================
app.post('/api/v1/book/import', multer().single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'file missing' });

        const buf = req.file.buffer;
        const format = detectFileFormat(buf);

        if (format === 'vbook') {
            // ── VBOOK path — same logic as /load-vbook ──
            const files = book.extractBookBundle(buf);
            log('[UNIFIED-IMPORT] vbook bundle loaded:', Object.keys(files));

            const bookData = book.buildBookFromBundle(files);
            const bookId = bookData.manifest.book_id;
            const buildId = bookData.manifest.build_id || 'default';

            const existingBook = book.loadBook(bookId);
            let loadedBook;
            if (existingBook) {
                log(`[UNIFIED-IMPORT] Book ${bookId} already exists — keeping existing (edited) version`);
                loadedBook = existingBook;

                const existingScenes = book.collectScenes(existingBook);
                const chunks = await getAllChunks(bookId);
                if (chunks.length === 0) {
                    log(`[UNIFIED-IMPORT] No chunks in Redis — attempting recovery from disk for ${existingScenes.length} scenes`);
                    const recovered = await recoverChunksFromDisk(bookId, buildId, existingScenes);
                    if (recovered.length > 0) {
                        log(`[UNIFIED-IMPORT] Recovered ${recovered.length}/${existingScenes.length} chunks from disk for ${bookId}`);
                        await redis.set(config.BOOK_SCENE_TOTAL(bookId), existingScenes.length);
                        await redis.set(config.BOOK_SCENE_NEXT(bookId), recovered.length);
                    } else {
                        log(`[UNIFIED-IMPORT] No files on disk for ${bookId} — generation needed`);
                    }
                } else {
                    log(`[UNIFIED-IMPORT] Found ${chunks.length} chunks in Redis for ${bookId}`);
                }
            } else {
                await book.resetBook(bookId);
                book.saveBookBundle(bookData, files);
                loadedBook = book.loadBook(bookId);
                log(`[UNIFIED-IMPORT] Loaded book from disk: ${bookId}, chapters: ${loadedBook?.chapters?.length}`);
            }

            const scenes = book.collectScenes(loadedBook || bookData);
            const chapterCount = loadedBook?.chapters?.length || bookData.chapters?.length || 0;
            const sceneCount = scenes.length;
            const title = bookData.manifest?.title || loadedBook?.manifest?.title || bookId;

            log(`[UNIFIED-IMPORT] ${bookId}: ${chapterCount} chapters, ${sceneCount} scenes`);

            const existingChunksAfterLoad = await getAllChunks(bookId);
            if (existingChunksAfterLoad.length === 0) {
                log(`[UNIFIED-IMPORT] Creating chunks + placeholder audio for ${scenes.length} scenes...`);
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
                        console.warn(`[UNIFIED-IMPORT] Failed to create chunk ${chunkId}: ${chunkErr.message}`);
                    }
                }
                const phScenes = scenes.map(s => ({ chapter_id: s.chapter_id, scene_id: s.scene_id }));
                const phResult = await placeholderAudio.ensureAllPlaceholderAudio(buildId, bookId, phScenes);
                log(`[UNIFIED-IMPORT] Placeholder audio: ${phResult.created} created, ${phResult.skipped} skipped`);
                try {
                    await redis.set(config.BOOK_SCENE_TOTAL(bookId), scenes.length);
                    await redis.set(config.BOOK_SCENE_NEXT(bookId), scenes.length);
                } catch (idxErr) {
                    console.warn(`[UNIFIED-IMPORT] Failed to set scene index: ${idxErr.message}`);
                }
            } else {
                log(`[UNIFIED-IMPORT] ${existingChunksAfterLoad.length} chunks exist — async placeholder generation`);
                setImmediate(async () => {
                    try {
                        const phScenes = scenes.map(s => ({ chapter_id: s.chapter_id, scene_id: s.scene_id }));
                        const phResult = await placeholderAudio.ensureAllPlaceholderAudio(buildId, bookId, phScenes);
                        log(`[UNIFIED-IMPORT] Placeholder audio: ${phResult.created} created, ${phResult.skipped} skipped`);
                    } catch (phErr) {
                        console.warn(`[UNIFIED-IMPORT] Placeholder audio generation failed: ${phErr.message}`);
                    }
                });
            }

            await attachBookWorkspace(bookId, title, req.workspace?.id);
            return res.json({
                format: 'vbook',
                book_id: bookId, build_id: buildId, title,
                chapter_count: chapterCount, scene_count: sceneCount,
                was_existing: !!existingBook,
            });
        } else {
            // ── TXT path — same logic as /import-txt ──
            const decoded = txtImporter.decodeTxtBuffer(buf);
            if (decoded.error) return res.status(400).json({ error: decoded.error });

            const sourceText = decoded.text;
            const title = path.basename(req.file.originalname, '.txt');

            // ⚠️ Hash MUST be computed from the DECODED text (UTF-8), NOT from the
            // raw buffer. Source files may be in CP1251/koi8/etc — the raw bytes
            // differ from the UTF-8 bytes written to source.txt on disk. Using the
            // raw buffer hash would make the disk-fallback never find a match.
            const fileHash = crypto.createHash('sha256').update(Buffer.from(sourceText, 'utf8')).digest('hex');
            const sourceSize = Buffer.byteLength(sourceText, 'utf8');

            let existingBookId = null;
            // ── Phase 1: PG book_source lookup ──
            try {
                const candidates = await bookSourceRepo.findCandidateBySize(sourceSize);
                if (candidates && candidates.length > 0) {
                    const existing = await bookSourceRepo.findByHash(fileHash);
                    if (existing) {
                        const existingStatus = lazyBook.getBookStatus(existing.book_id);
                        if (existingStatus && existingStatus.state) {
                            // Always return existing book on dedup — even if completed.
                            // User re-importing the same file expects to get the same book back,
                            // not a brand new import.
                            existingBookId = existing.book_id;
                        } else {
                            await bookSourceRepo.deleteByBookId(existing.book_id);
                            log(`[UNIFIED-IMPORT] DEDUP: book ${existing.book_id} not on disk — cleaning up reference`);
                        }
                    }
                }
            } catch (pgErr) {
                console.warn(`[UNIFIED-IMPORT] PG dedup check failed (non-fatal): ${pgErr.message}`);
            }

            // ── Phase 2: Fallback — scan books on disk (covers deleted book_source records) ──
            // Optimisation: pre-filter by file size (cheap stat) then by SHA256.
            // This only runs once per book — after PG record is re-registered,
            // subsequent imports use the fast PG path.
            if (!existingBookId) {
                const diskFound = findLazyBookByHash(fileHash, lazyBook.getBooksDir(), sourceSize);
                if (diskFound) {
                    const existingStatus = lazyBook.getBookStatus(diskFound);
                    if (existingStatus && existingStatus.state) {
                        existingBookId = diskFound;
                        log(`[UNIFIED-IMPORT] DEDUP (disk fallback): found ${existingBookId} for hash ${fileHash}`);
                        // Re-register PG record so next import uses fast path
                        try {
                            await bookSourceRepo.registerSource(fileHash, req.file.originalname, sourceSize, existingBookId, 'txt');
                            log(`[UNIFIED-IMPORT] Re-registered book_source for ${existingBookId}`);
                        } catch (regErr) {
                            console.warn(`[UNIFIED-IMPORT] Failed to re-register book_source (non-fatal): ${regErr.message}`);
                        }
                    }
                }
            }

            if (existingBookId) {
                log(`[UNIFIED-IMPORT] DEDUP: returning existing book ${existingBookId} for hash ${fileHash}`);
                let existingBuildId = null;
                try {
                    const em = JSON.parse(fs.readFileSync(lazyBook.getManifestPath(lazyBook.getBookDir(existingBookId)), 'utf8'));
                    existingBuildId = em.build_id || null;
                } catch (_) {}
                await attachBookWorkspace(existingBookId, title, req.workspace?.id);
                return res.json({
                    format: 'txt',
                    book_id: existingBookId, build_id: existingBuildId, title, state: lazyBook.BookState.RAW_IMPORTED, dedup: true,
                });
            }

            const draft = lazyBook.createDraftBook(sourceText, lazyBook.SourceType.TXT, title);
            const bookDir = lazyBook.getBookDir(draft.bookId);
            const mp = lazyBook.getManifestPath(bookDir);
            const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
            m.import_meta.original_filename = req.file.originalname;
            fs.writeFileSync(mp, JSON.stringify(m, null, 2));

            try {
                await bookSourceRepo.registerSource(fileHash, req.file.originalname, sourceSize, draft.bookId, 'txt');
                log(`[UNIFIED-IMPORT] Registered source: ${fileHash} → ${draft.bookId}`);
            } catch (pgErr) {
                console.warn(`[UNIFIED-IMPORT] Failed to register source (non-fatal): ${pgErr.message}`);
            }
            await attachBookWorkspace(draft.bookId, title, req.workspace?.id);

            log(`[UNIFIED-IMPORT] RAW_IMPORTED: ${draft.bookId} (${sourceSize} bytes)`);
            return res.json({
                format: 'txt',
                book_id: draft.bookId, build_id: m.build_id, title, state: lazyBook.BookState.RAW_IMPORTED,
            });
        }
    } catch (err) {
        console.error('UNIFIED-IMPORT ERROR:', err);
        return res.status(400).json({ error: err.message || 'unknown error' });
    }
});

/**
 * Detect file format from buffer: 'vbook' if it's a valid ZIP containing
 * manifest.json and book.json, otherwise 'txt'.
 */
function detectFileFormat(buf) {
    // Check ZIP magic bytes (PK\x03\x04)
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4B || buf[2] !== 0x03 || buf[3] !== 0x04) {
        return 'txt';
    }

    try {
        // Use extractBookBundle to attempt reading as vbook — it will throw if invalid
        const files = book.extractBookBundle(buf);
        if (files && files['manifest.json'] && files['book.json']) {
            return 'vbook';
        }
        return 'txt';
    } catch (e) {
        return 'txt';
    }
}

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

            await attachBookWorkspace(bookId, title, req.workspace?.id);
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
                // N4: server decides readiness so the client doesn't match state strings.
                return res.json({
                    book_id: bookId, state: draft.manifest.state, ready: true,
                    characters: draft.characters.length,
                    locations: Object.keys(draft.locations || {}).length,
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
                    book_id: bookId, state: 'resuming', ready: false,
                    session_id: session.session_id, session_status: session.status,
                    progress_msg: session.progress_msg || 'Resuming...',
                });
            }

            log(`[RESUME-BOOTSTRAP] ${bookId}: no active session, re-bootstrapping...`);
            const result = await txtImporter.bootstrapImportedText(bookId);
            const resultReady = (result.state === lazyBook.BookState.BOOTSTRAPPED ||
                                 result.state === lazyBook.BookState.ACTIVE);
            return res.json({
                book_id: result.bookId, state: result.state, ready: resultReady,
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

            const decoded = txtImporter.decodeTxtBuffer(req.file.buffer);
            if (decoded.error) return res.status(400).json({ error: decoded.error });

            const sourceText = decoded.text;
            const title = path.basename(req.file.originalname, '.txt');

            // ⚠️ Hash MUST be computed from the DECODED text (UTF-8), NOT from the
            // raw buffer. Source files may be in CP1251/koi8/etc — the raw bytes
            // differ from the UTF-8 bytes written to source.txt on disk. Using the
            // raw buffer hash would make the disk-fallback never find a match.
            const fileHash = crypto.createHash('sha256').update(Buffer.from(sourceText, 'utf8')).digest('hex');
            const sourceSize = Buffer.byteLength(sourceText, 'utf8');

            let existingBookId = null;
            // ── Phase 1: PG book_source lookup ──
            try {
                const candidates = await bookSourceRepo.findCandidateBySize(sourceSize);
                if (candidates && candidates.length > 0) {
                    const existing = await bookSourceRepo.findByHash(fileHash);
                    if (existing) {
                        const existingStatus = lazyBook.getBookStatus(existing.book_id);
                        if (existingStatus && existingStatus.state) {
                            // Always return existing book on dedup — even if completed.
                            // User re-importing the same file expects to get the same book back,
                            // not a brand new import.
                            existingBookId = existing.book_id;
                        } else {
                            await bookSourceRepo.deleteByBookId(existing.book_id);
                            log(`[IMPORT-TXT] DEDUP: book ${existing.book_id} not on disk — cleaning up reference`);
                        }
                    }
                }
            } catch (pgErr) {
                console.warn(`[IMPORT-TXT] PG dedup check failed (non-fatal): ${pgErr.message}`);
            }

            // ── Phase 2: Fallback — scan books on disk (covers deleted book_source records) ──
            // Optimisation: pre-filter by file size (cheap stat) then by SHA256.
            // This only runs once per book — after PG record is re-registered,
            // subsequent imports use the fast PG path.
            if (!existingBookId) {
                const diskFound = findLazyBookByHash(fileHash, lazyBook.getBooksDir(), sourceSize);
                if (diskFound) {
                    const existingStatus = lazyBook.getBookStatus(diskFound);
                    if (existingStatus && existingStatus.state) {
                        existingBookId = diskFound;
                        log(`[IMPORT-TXT] DEDUP (disk fallback): found ${existingBookId} for hash ${fileHash}`);
                        // Re-register PG record so next import uses fast path
                        try {
                            await bookSourceRepo.registerSource(fileHash, req.file.originalname, sourceSize, existingBookId, 'txt');
                            log(`[IMPORT-TXT] Re-registered book_source for ${existingBookId}`);
                        } catch (regErr) {
                            console.warn(`[IMPORT-TXT] Failed to re-register book_source (non-fatal): ${regErr.message}`);
                        }
                    }
                }
            }

            if (existingBookId) {
                log(`[IMPORT-TXT] DEDUP: returning existing book ${existingBookId} for hash ${fileHash}`);
                let existingBuildId = null;
                try {
                    const em = JSON.parse(fs.readFileSync(lazyBook.getManifestPath(lazyBook.getBookDir(existingBookId)), 'utf8'));
                    existingBuildId = em.build_id || null;
                } catch (_) {}
                await attachBookWorkspace(existingBookId, title, req.workspace?.id);
                return res.json({
                    book_id: existingBookId, build_id: existingBuildId, title, state: lazyBook.BookState.RAW_IMPORTED, dedup: true,
                });
            }

            const draft = lazyBook.createDraftBook(sourceText, lazyBook.SourceType.TXT, title);
            const bookDir = lazyBook.getBookDir(draft.bookId);
            const mp = lazyBook.getManifestPath(bookDir);
            const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
            m.import_meta.original_filename = req.file.originalname;
            fs.writeFileSync(mp, JSON.stringify(m, null, 2));

            try {
                await bookSourceRepo.registerSource(fileHash, req.file.originalname, sourceSize, draft.bookId, 'txt');
                log(`[IMPORT-TXT] Registered source: ${fileHash} → ${draft.bookId}`);
            } catch (pgErr) {
                console.warn(`[IMPORT-TXT] Failed to register source (non-fatal): ${pgErr.message}`);
            }
            await attachBookWorkspace(draft.bookId, title, req.workspace?.id);

            log(`[IMPORT-TXT] RAW_IMPORTED: ${draft.bookId} (${sourceSize} bytes)`);
            return res.json({ book_id: draft.bookId, build_id: m.build_id, title, state: lazyBook.BookState.RAW_IMPORTED });
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
            const result = await txtImporter.bootstrapImportedText(bookId, null, publishVBook, redis);

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
            const result = await txtImporter.bootstrapNextWindow(bookId, null, publishVBook, redis);
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
            const { chapter_id, scene_id, unit_index, register_for_gpu = true } = req.body || {};

            log(`[TRIGGER] next-window called for ${bookId} (ch=${chapter_id} sc=${scene_id} unit=${unit_index})`);

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

            // ── Server-side trigger decision logic (replaces client-side WindowTriggerManager) ──
            let targetScene, targetUnits;
            if (chapter_id && scene_id) {
                const chapters = draft?.chapters || [];
                let found = false;
                for (const ch of chapters) {
                    if (ch.chapter_id === chapter_id) {
                        for (const sc of (ch.scenes || [])) {
                            if (sc.scene_id === scene_id) {
                                found = true;
                                targetScene = sc;
                                targetUnits = sc.units || [];
                                break;
                            }
                        }
                        if (!found) log(`[TRIGGER] ⚠️ scene ${scene_id} not in chapter ${chapter_id}, continuing anyway`);
                        break;
                    }
                }

                if (found) {
                    // 1. Content tail check: is this the last non-cover, non-intro scene?
                    const allContentScenes = [];
                    for (const ch of chapters) {
                        for (const sc of (ch.scenes || [])) {
                            if (sc.type !== 'cover' && sc.type !== 'chapter_intro') {
                                allContentScenes.push({ chapter: ch.chapter_id, sceneId: sc.scene_id });
                            }
                        }
                    }
                    const contentTail = allContentScenes[allContentScenes.length - 1];
                    if (!contentTail || contentTail.chapter !== chapter_id || contentTail.sceneId !== scene_id) {
                        log(`[TRIGGER] ❌ not at content tail`);
                        return res.json({ triggered: false, reason: 'not_at_content_tail' });
                    }

                    // 2. Last-3 units check
                    if (targetUnits.length > 3 && unit_index != null && unit_index >= 0) {
                        const last3Start = targetUnits.length - 3;
                        if (unit_index < last3Start) {
                            log(`[TRIGGER] ❌ unit ${unit_index} not in last 3 of ${targetUnits.length} units`);
                            return res.json({ triggered: false, reason: 'not_last_units', unit_index, last3_start: last3Start });
                        }
                    }

                    // 3. Cooldown check (60s in Redis)
                    const cooldownKey = `trigger_cooldown:${bookId}`;
                    const lastTrigger = await redis.get(cooldownKey);
                    if (lastTrigger) {
                        const elapsed = Date.now() - parseInt(lastTrigger, 10);
                        if (elapsed < 60000) {
                            log(`[TRIGGER] ⏳ cooldown: ${Math.round(elapsed / 1000)}s`);
                            return res.json({ triggered: false, reason: 'cooldown', remaining_ms: 60000 - elapsed });
                        }
                    }

                    // 4. Dedup check: has this frontier already triggered?
                    const dedupKey = `trigger_dedup:${bookId}`;
                    const windowKey = `${chapter_id}:${scene_id}`;
                    const alreadyTriggered = await redis.sismember(dedupKey, windowKey);
                    if (alreadyTriggered) {
                        log(`[TRIGGER] 🔁 already triggered for frontier ${windowKey}`);
                        return res.json({ triggered: false, reason: 'already_triggered' });
                    }
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
                    agentSession.status === 'cancelled' ||
                    (windowData && windowData.remaining_scenes && windowData.remaining_scenes.length === 0 && !windowData.remaining_text)) {
                    log(`[TRIGGER] all done for TXT book ${bookId} (status=${agentSession.status})`);
                    return res.json({ triggered: false, all_done: true, message: 'All windows processed' });
                }

                // Even if the last session has status='running' (created after cancel-worker),
                // check if the book was cancelled by the user (via Redis cancelled-workers set).
                // Without this check, trigger-next-window would call bootstrapNextWindow in a loop
                // (it returns all_done=true due to Redis check, but frontend sees triggered=true and retries).
                try {
                    const wasCancelled = await redis.sismember(`animastor:cancelled-workers:${bookId}`, 'vbook');
                    if (wasCancelled) {
                        log(`[TRIGGER] book ${bookId} was cancelled (vbook) — stopping trigger loop`);
                        return res.json({ triggered: false, all_done: true, reason: 'cancelled', message: 'Generation stopped by user' });
                    }
                } catch (redisErr) {
                    console.warn(`[TRIGGER] Redis cancelled check failed: ${redisErr.message}`);
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
                        const nextRes = await txtImporter.bootstrapNextWindow(bookId, null, publishVBook, redis);
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

                // Record trigger dedup + cooldown
                const wKey = `${req.body?.chapter_id || ''}:${req.body?.scene_id || ''}`;
                if (wKey !== ':') {
                    await redis.sadd(`trigger_dedup:${bookId}`, wKey);
                    await redis.expire(`trigger_dedup:${bookId}`, 86400);
                }
                await redis.set(`trigger_cooldown:${bookId}`, Date.now().toString());

                return res.json({ triggered: true, source: 'txt_import', session_id: agentSession.session_id });
            }

            // VBook / windowGenerator path — also check cancellation
            try {
                const wasCancelled = await redis.sismember(`animastor:cancelled-workers:${bookId}`, 'vbook');
                if (wasCancelled) {
                    log(`[TRIGGER] book ${bookId} was cancelled (vbook) — VBook path aborting`);
                    return res.json({ triggered: false, all_done: true, reason: 'cancelled', message: 'Generation stopped by user' });
                }
            } catch (redisErr) {
                console.warn(`[TRIGGER] Redis cancelled check failed (VBook path): ${redisErr.message}`);
            }

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
                windowGenerator.runBackgroundWindowGeneration(bookId, session.id, { register_for_gpu, buildId: bgBuildId }).catch(err => {
                    console.error(`[TRIGGER] ❌ Background gen crashed: ${err.message}`);
                });
            });

            // Record trigger dedup + cooldown
            const wKey2 = `${req.body?.chapter_id || ''}:${req.body?.scene_id || ''}`;
            if (wKey2 !== ':') {
                await redis.sadd(`trigger_dedup:${bookId}`, wKey2);
                await redis.expire(`trigger_dedup:${bookId}`, 86400);
            }
            await redis.set(`trigger_cooldown:${bookId}`, Date.now().toString());

            log(`[TRIGGER] ✅ started background window ${nextWindowIndex}, session=${session.id} (from PG ${lastWindow})`);
            return res.json({ triggered: true, session_id: session.id, window_index: nextWindowIndex });
        } catch (err) {
            console.error('[TRIGGER-NEXT-WINDOW] ❌ Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });
};
