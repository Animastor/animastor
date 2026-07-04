// ======================================================
// Book Recovery Routes
// ======================================================

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
    // RECOVER PLACEHOLDERS
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
                checked: result.checked, created: result.created,
                skipped: result.skipped, errors: result.errors,
                recovered: result.created > 0,
            });
        } catch (err) {
            console.error('[RECOVER-PLACEHOLDERS] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });
};
