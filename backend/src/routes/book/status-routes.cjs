// Book status / state read-only routes.
//
// Split out of book-routes.cjs (Architectural Debt #3, sub-registrar pattern).
//   require('./book/status-routes.cjs')(app, ctx);
//
// ctx fields used here: { genSessionRepo, lazyBook, txtImporter }

module.exports = function registerStatusRoutes(app, ctx) {
    const { genSessionRepo, lazyBook, txtImporter, log } = ctx;

    // GET /api/v1/book/:bookId/generation-state
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

    // GET /api/v1/book/:bookId/status
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

    // GET /api/v1/book/:bookId/source-chapters
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

    // GET /api/v1/book/:bookId/chapters-summary
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

    log('[ROUTES] Book status routes loaded');
};
