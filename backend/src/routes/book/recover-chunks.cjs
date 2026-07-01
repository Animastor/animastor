// recoverMissingRedisChunks — create Redis chunks for scenes that exist in the
// book JSON but lack chunks in Redis (e.g. window generation wrote scenes to
// disk but failed to create chunks), and reconcile scene counters.
//
// Extracted from book-routes.cjs (Architectural Debt #3). Previously a function
// nested in the route module's closure; now takes its dependencies explicitly
// via `ctx` so the coupling is visible and testable.
//
// ctx fields used: { redis, book, state, activeScenes, config, getAllChunks, saveChunk, log }

async function recoverMissingRedisChunks(ctx, buildId, bookId) {
    const { redis, book, state, activeScenes, config, getAllChunks, saveChunk, log } = ctx;

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
        }            // NOTE: Do NOT register the scene for GPU scheduler here.
            // Registering for GPU would auto-start generation without the user
            // pressing the "Generate" button. GPU registration (activeScenes.addActiveScene)
            // must only happen via the explicit /regenerate endpoint triggered by the user.
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

module.exports = { recoverMissingRedisChunks };
