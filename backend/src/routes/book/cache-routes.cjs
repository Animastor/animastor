// Book cache inspection + teardown routes.
//
// Split out of book-routes.cjs (Architectural Debt #3, sub-registrar pattern).
//
// ctx fields used here:
//   { redis, config, storage, path, fs, getAllChunks, getChunk, cleanBookRedisKeys, log }

module.exports = function registerCacheRoutes(app, ctx) {
    const { redis, config, storage, path, fs, getAllChunks, getChunk, cleanBookRedisKeys, log } = ctx;

    // GET /api/v1/book/:bookId/cache — report per-scene asset cache status.
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

    // DELETE /api/v1/book/:bookId/cache — wipe build dirs, Redis keys, PG cache rows, hub queue.
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

            // ── Clean PG tables — each with individual try/catch so one
            //    failure doesn't block the rest. Only generated/cache tables are
            //    cleared — book identity data (book_source, book_snapshots),
            //    user chat history (chat_messages, chat_sessions) and event logs
            //    (book_events) are preserved so the book stays loadable and
            //    dedup works on re-import.
            const pgTables = [
                'image_units',
                'scenes',
                'asset_states',
                'asset_dependencies',
                'generation_tasks',
                'reconciliation_events',
                'output_manifests',
                'cache_entries',
                'agent_sessions',
                'book_generation_sessions',
                'ai_chat_sessions',
                'scene_assets',
                'character_resolution_runs',
                'character_window_candidates',
                'sentence_resolutions',
                'character_mentions',
                'character_aliases',
                'storyboard_elements',
                'audio_layers',
                // NOTE: 'books', 'book_source', 'book_snapshots',
                // 'chat_messages', 'chat_sessions', 'book_events' are NOT deleted
                // on cache clear — they are book identity data, not generated cache.
            ];
            for (const table of pgTables) {
                try {
                    await storage.postgres.query(`DELETE FROM ${table} WHERE book_id = $1`, [bookId]);
                } catch (tblErr) {
                    console.warn(`[CACHE] DB cleanup: ${table}: ${tblErr.message}`);
                }
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

    log('[ROUTES] Book cache routes loaded');
};
