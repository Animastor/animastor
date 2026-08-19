// Book parse / source / snapshot routes (non-upload text ingestion).
//
// Split out of book-routes.cjs (Architectural Debt #3, sub-registrar pattern).
//
// ctx fields used here:
//   { config, txtImporter, lazyBook, placeholderAudio, taskHandler, log }
//
// NOTE: multipart upload ingestion (load-vbook, import-txt) stays in the parent
// for now — those use multer middleware and live elsewhere in the file.

module.exports = function registerParseRoutes(app, ctx) {
    const { config, txtImporter, lazyBook, placeholderAudio, taskHandler, log } = ctx;
    const workspaceOwnership = require('../../middleware/workspace-ownership');

    // POST /api/v1/book/:bookId/lazy-parse — parse next window of chapters.
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
                    chapter_id: ch.chapter_id, chapter_title: ch.chapter_title,
                    chapter_index: ch.chapter_index, status: ch.status,
                    scene_count: ch.scenes ? ch.scenes.length : 0,
                })),
            });
        } catch (err) {
            console.error('LAZY-PARSE ERROR:', err);
            return res.status(400).json({ error: err.message || 'unknown error' });
        }
    });

    // POST /api/v1/book/:bookId/lazy-parse-to — parse up to a specific chapter index.
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

    // POST /api/v1/book/import-text — create a draft book from raw AI text.
    app.post('/api/v1/book/import-text', async (req, res) => {
        try {
            const { text, title } = req.body;
            if (!text) return res.status(400).json({ error: 'text is required' });

            const validation = txtImporter.validateAiText(text);
            if (!validation.valid) return res.status(400).json({ error: validation.errors.join('; ') });

            const draft = lazyBook.createDraftBook(text, lazyBook.SourceType.AI_IMPORT, title || 'Imported Text');
            try {
                await workspaceOwnership.resolveWorkspaceForBook(draft.bookId, {
                    bookTitle: title || 'Imported Text',
                    preferredWorkspaceId: req.workspace?.id || null,
                });
            } catch (err) {
                console.warn(`[IMPORT-TEXT] Ownership attach failed for ${draft.bookId} (non-fatal): ${err.message}`);
            }
            log(`[IMPORT-TEXT] RAW_IMPORTED: ${draft.bookId} (${Buffer.byteLength(text, 'utf8')} bytes)`);
            return res.json({ book_id: draft.bookId, title: title || 'Imported Text', state: lazyBook.BookState.RAW_IMPORTED });
        } catch (err) {
            console.error('IMPORT-TEXT ERROR:', err);
            return res.status(400).json({ error: err.message || 'unknown error' });
        }
    });

    // GET /api/v1/book/:bookId/source — raw source text of a draft book.
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

    // POST /api/v1/book/:bookId/snapshot — persist a book snapshot to disk.
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

    log('[ROUTES] Book parse routes loaded');
};
