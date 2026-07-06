// ======================================================
// Book Agent Status Route
// ======================================================

const { MAX_SCENES_PER_CHUNK } = require('../../services/agent-prompts');

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
    // AGENT STATUS
    // ======================================================
    app.get('/api/v1/book/:bookId/agent-status', async (req, res) => {
        try {
            const { bookId } = req.params;

            const agentResult = await storage.postgres.query(`
                SELECT session_id, status as session_status, progress_msg,
                       window_data, knowledge_base, source_type
                FROM agent_sessions
                WHERE book_id = $1
                ORDER BY created_at DESC
                LIMIT 1
            `, [bookId]);

            const agentRow = agentResult.rows[0];
            console.log('[AGENT-STATUS-DEBUG] bookId=' + bookId + ' agentRow=', JSON.stringify(agentRow || { noRow: true }));

            if (agentRow && agentRow.session_status === 'running') {
                let windowData = null;
                let windowIndex = null, createdScenes = null, totalScenes = null, remainingCached = null;

                if (agentRow.window_data) {
                    try {
                        windowData = typeof agentRow.window_data === 'string' ? JSON.parse(agentRow.window_data) : agentRow.window_data;
                        windowIndex = windowData.window_index;
                        createdScenes = windowData.created_scenes;
                        totalScenes = windowData.total_scenes;
                        remainingCached = windowData.remaining_scenes ? windowData.remaining_scenes.length : 0;
                    } catch (e) { /* ignore */ }
                }
                const windowProgressMeta = buildWindowProgressMeta(createdScenes, totalScenes);

                const response = {
                    active: true, session_id: agentRow.session_id,
                    session_status: 'running', progress_msg: agentRow.progress_msg || 'Working...',
                    source_type: agentRow.source_type, window_index: windowIndex,
                    created_scenes: createdScenes, total_scenes: totalScenes, remaining_cached: remainingCached,
                    window_size: MAX_SCENES_PER_CHUNK,
                    ...windowProgressMeta,
                };
                console.log('[AGENT-STATUS-DEBUG] running response:', JSON.stringify(response));
                return res.json(response);
            }

            const genResult = await storage.postgres.query(`
                SELECT id, status, progress_msg, window_index, error
                FROM book_generation_sessions
                WHERE book_id = $1 AND status IN ('generating', 'pending', 'queued')
                ORDER BY created_at DESC
                LIMIT 1
            `, [bookId]);

            const genRow = genResult.rows[0];
            if (genRow) {
                const response = {
                    active: true, session_id: genRow.id, session_status: genRow.status,
                    progress_msg: genRow.progress_msg || 'Processing...',
                    source_type: 'window_generator', window_index: genRow.window_index,
                    created_scenes: null, total_scenes: null, remaining_cached: null,
                    window_size: config.WINDOW_SIZE,
                    window_start_scene: null, window_total_scenes: null, window_scene_index: null,
                };
                console.log('[AGENT-STATUS-DEBUG] gen response:', JSON.stringify(response));
                return res.json(response);
            }

            if (agentRow) {
                let windowData = null, windowIndex = null, createdScenes = null, totalScenes = null, remainingCached = null;
                if (agentRow.window_data) {
                    try {
                        windowData = typeof agentRow.window_data === 'string' ? JSON.parse(agentRow.window_data) : agentRow.window_data;
                        windowIndex = windowData.window_index;
                        createdScenes = windowData.created_scenes;
                        totalScenes = windowData.total_scenes;
                        remainingCached = windowData.remaining_scenes ? windowData.remaining_scenes.length : 0;
                    } catch (e) { /* ignore */ }
                }
                const windowProgressMeta = buildWindowProgressMeta(createdScenes, totalScenes);
                const response = {
                    active: agentRow.session_status === 'running', session_id: agentRow.session_id,
                    session_status: agentRow.session_status, progress_msg: agentRow.progress_msg || 'Working...',
                    source_type: agentRow.source_type, window_index: windowIndex,
                    created_scenes: createdScenes, total_scenes: totalScenes, remaining_cached: remainingCached,
                    window_size: MAX_SCENES_PER_CHUNK,
                    ...windowProgressMeta,
                };
                console.log('[AGENT-STATUS-DEBUG] paused/completed response:', JSON.stringify(response));
                return res.json(response);
            }

            console.log('[AGENT-STATUS-DEBUG] no session found for bookId=' + bookId);
            return res.json({
                active: false, message: 'No active agent session',
                window_size: config.WINDOW_SIZE,
                window_start_scene: null, window_total_scenes: null, window_scene_index: null,
            });
        } catch (err) {
            console.error('[AGENT-STATUS] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });
};
