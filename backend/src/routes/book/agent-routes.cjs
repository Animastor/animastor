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
    const { log } = utils;

    const buildWindowProgressMeta = (createdScenes, totalScenes, vbookSceneIdx) => {
        const toFiniteNumber = (value) => {
            if (value == null) return null;
            const num = Number(value);
            return Number.isFinite(num) ? num : null;
        };
        const created = toFiniteNumber(createdScenes);
        const total = toFiniteNumber(totalScenes);
        // Prefer live scene index from Redis (set per-scene by pipeline-runner).
        // Fall back to computed value from cumulative counters.
        if (vbookSceneIdx != null) {
            const idx = parseInt(vbookSceneIdx, 10);
            if (Number.isFinite(idx) && idx > 0) {
                const totalVal = toFiniteNumber(total);
                // When total is null (window_data not yet saved), return null
                // so the frontend falls back to window_size (the per-book
                // configured chunk size reported in the base response).
                return {
                    window_start_scene: totalVal != null ? Math.max(1, (toFiniteNumber(created) || 0) - totalVal + 1) : null,
                    window_total_scenes: totalVal,
                    window_scene_index: idx,
                };
            }
        }
        if (created == null || total == null || total <= 0) {
            return { window_start_scene: null, window_total_scenes: total, window_scene_index: null };
        }
        const windowTotal = Math.max(1, total);
        const windowStart = Math.max(1, created - windowTotal + 1);
        return {
            window_start_scene: windowStart,
            window_total_scenes: windowTotal,
            window_scene_index: created - windowStart + 1,
        };
    };

    // ======================================================
    // AGENT STATUS
    // ======================================================
    app.get('/api/v1/book/:bookId/agent-status', async (req, res) => {
        try {
            const { bookId } = req.params;

            // Per-book configured chunk size (shared with bootstrap via
            // layerConfig.getChunkSize) — used as the window_size fallback so
            // the frontend scene counter shows the real window size (e.g.
            // "3/3") instead of the hardcoded MAX_SCENES_PER_CHUNK (2) while
            // window_data isn't saved yet during the pipeline.
            let configuredWindowSize = await layerConfig.getChunkSize(redis, bookId);

            const agentResult = await storage.postgres.query(`
                SELECT session_id, status as session_status, progress_msg,
                       window_data, knowledge_base, source_type
                FROM agent_sessions
                WHERE book_id = $1
                ORDER BY created_at DESC
                LIMIT 1
            `, [bookId]);

            const agentRow = agentResult.rows[0];

            // Fetch current step_type from the latest agent_steps row
            let stepType = null;
            if (agentRow) {
                try {
                    const stepsResult = await storage.postgres.query(`
                        SELECT step_type FROM agent_steps
                        WHERE session_id = $1 AND status = 'running'
                        ORDER BY created_at DESC
                        LIMIT 1
                    `, [agentRow.session_id]);
                    if (stepsResult.rows.length > 0) {
                        stepType = stepsResult.rows[0].step_type;
                    }
                } catch (e) { /* best-effort */ }
            }

            const baseResponse = (extra) => ({
                active: false, session_id: null, session_status: null,
                progress_msg: null, source_type: null, window_index: null,
                created_scenes: null, total_scenes: null, remaining_cached: null,
                window_size: configuredWindowSize,
                window_start_scene: null, window_total_scenes: null, window_scene_index: null,
                step_type: stepType,
                ...extra,
            });

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
                const vbookSceneIdx = await redis.get(`animastor:vbook-scene-idx:${bookId}`);
                const windowProgressMeta = buildWindowProgressMeta(createdScenes, totalScenes, vbookSceneIdx);

                return res.json(baseResponse({
                    active: true, session_id: agentRow.session_id,
                    session_status: 'running', progress_msg: agentRow.progress_msg || 'Working...',
                    source_type: agentRow.source_type, window_index: windowIndex,
                    created_scenes: createdScenes, total_scenes: totalScenes, remaining_cached: remainingCached,
                    ...windowProgressMeta,
                }));
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
                return res.json(baseResponse({
                    active: true, session_id: genRow.id, session_status: genRow.status,
                    progress_msg: genRow.progress_msg || 'Processing...',
                    source_type: 'window_generator', window_index: genRow.window_index,
                    window_size: config.WINDOW_SIZE,
                }));
            }

            if (agentRow) {
                let windowData = null, windowIndex = null, createdScenes = null, totalScenes = null, remainingCached = null;
                if (agentRow.window_data) {
                    try {
                        windowData = typeof agentRow.window_data === 'string' ? JSON.parse(agentRow.window_data) : agentRow.window_data;
                        windowIndex = windowData.window_index;
                        createdScenes = windowData.created_scenes;
                        totalScenes = windowData.total_scenes;
                        remainingCached = Array.isArray(windowData.cached_scenes) ? windowData.cached_scenes.length : 0;
                    } catch (e) { /* ignore */ }
                }
                // A 'paused' session with unprocessed source text or cached scenes
                // is BETWEEN windows: the agent is still working, so report it as
                // ACTIVE. Treating paused as finished made the frontends finalize
                // COMPLETED (green 100% row) between windows, freezing the counter
                // on the last window's value (e.g. "1/1") while more windows were
                // still pending. Only a session with nothing left (or a
                // completed/failed/cancelled session) is truly inactive.
                let hasRemainingWork = false;
                if (windowData) {
                    const remText = typeof windowData.remaining_text === 'string' ? windowData.remaining_text.trim() : '';
                    const cached = Array.isArray(windowData.cached_scenes) ? windowData.cached_scenes : [];
                    hasRemainingWork = remText.length > 0 || cached.length > 0;
                }
                const sessionActive = agentRow.session_status === 'running'
                    || (agentRow.session_status === 'paused' && hasRemainingWork);
                const vbookSceneIdx = await redis.get(`animastor:vbook-scene-idx:${bookId}`);
                const windowProgressMeta = buildWindowProgressMeta(createdScenes, totalScenes, vbookSceneIdx);
                return res.json(baseResponse({
                    active: sessionActive, session_id: agentRow.session_id,
                    session_status: agentRow.session_status, progress_msg: agentRow.progress_msg || 'Working...',
                    source_type: agentRow.source_type, window_index: windowIndex,
                    created_scenes: createdScenes, total_scenes: totalScenes, remaining_cached: remainingCached,
                    ...windowProgressMeta,
                }));
            }

            return res.json(baseResponse({ message: 'No active agent session' }));
        } catch (err) {
            console.error('[AGENT-STATUS] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });
};
