// ======================================================
// ANIMASTOR BACKEND — DEBUG ROUTES
// ======================================================
// All /api/v1/debug/* endpoints.

const path = require('path');
const fs = require('fs');

module.exports = function(app, redis, deps) {
    const {
        config, state, audio, image, video, book, orchestrator, storage,
        runtime, activeScenes, layerConfig, genScope, placeholderAudio,
        utils, saveChunk, getChunk, getAllChunks, getBookWindowStatus,
        detectAvailableMode, recoverChunksFromDisk, recoverAllBooksFromDisk,
        cleanupService, iuRepo, computeWaveform,
        taskHandler, bookDiff, journal,
    } = deps;
    const { log } = utils;
    const { stats } = cleanupService;
    const OUTPUT_DIR = config.OUTPUT_DIR;

    // Create audioRecovery instance once (R6.3: trigger-based)
    const audioRecovery = require('../services/audio-recovery.cjs')(redis, config, {
        audio, image, state, book, orchestrator,
        taskHandler,
        getChunk, saveChunk,
        // saveIURegistry: not needed for per-scene recovery
        utils,
    });

    // ======================================================
    // DEBUG ROUTES — middleware for runtime access
    // ======================================================
    app.use('/api/v1/debug/runtime', (req, res) => {
        res.locals.redis = redis;
        res.locals.runtime = runtime;
        res.locals.config = config;
        res.locals.state = state;
    });

    // ======================================================
    // SCENE STATES (via per-asset states)
    // ======================================================
    app.get('/api/v1/debug/scene-states', async (req, res) => {
        try {
            const { book_id } = req.query;
            if (!book_id) return res.status(400).json({ error: 'book_id required' });
            return res.json({ book_id, states: {}, count: 0 });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // ASSET STATES (per-asset, replaces legacy scene-state)
    // ======================================================
    app.get('/api/v1/debug/asset-states/:bookId/:chapterId/:sceneId', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
            res.json({ book_id: bookId, chapter_id: chapterId, scene_id: sceneId, asset_states: assetStates });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // SCENE EVENTS (event journal)
    // ======================================================
    app.get('/api/v1/debug/scene-events/:bookId/:chapterId/:sceneId', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const events = await journal.getSceneEvents(bookId, chapterId, sceneId);
            res.json({ book_id: bookId, chapter_id: chapterId, scene_id: sceneId, events });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // SCENE ASSETS
    // ======================================================
    app.get('/api/v1/debug/scene-assets/:bookId/:chapterId/:sceneId', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const buildId = req.query.build_id || 'default';

            const dir = path.join(OUTPUT_DIR, buildId);
            let files = [];
            try { files = fs.readdirSync(dir).filter(f => f.startsWith(`${bookId}_${chapterId}_${sceneId}`)); } catch (_) {}

            const chunkId = `${bookId}_${chapterId}_${sceneId}_0001`;
            const chunk = await getChunk(chunkId);

            const sceneBook = book.loadBook(bookId);
            let sceneData = null;
            if (sceneBook) {
                for (const ch of sceneBook.chapters || []) {
                    if (ch.chapter === chapterId) {
                        for (const sc of ch.scenes || []) {
                            if (sc.scene_id === sceneId) { sceneData = sc; break; }
                        }
                        break;
                    }
                }
            }

            res.json({
                book_id: bookId, chapter_id: chapterId, scene_id: sceneId, build_id: buildId,
                files, chunk,                asset_states: null, scene_data: sceneData,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // ASSET REGISTRY
    // ======================================================
    app.get('/api/v1/debug/asset-registry/status', async (req, res) => {
        try {
            const { book_id } = req.query;
            if (!book_id) return res.status(400).json({ error: 'book_id required' });

            const registry = storage.assetRegistry;
            const status = await registry.getStatus(redis, book_id);
            res.json({ book_id, status });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/v1/debug/asset-registry/orphans', async (req, res) => {
        try {
            const { book_id } = req.query;
            if (!book_id) return res.status(400).json({ error: 'book_id required' });

            const registry = storage.assetRegistry;
            const orphans = await registry.findOrphans(redis, book_id);
            res.json({ book_id, orphan_count: orphans.length, orphans: orphans.slice(0, 100) });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/v1/debug/asset-registry/cleanup', async (req, res) => {
        try {
            const { book_id, dry_run } = req.body || {};
            if (!book_id) return res.status(400).json({ error: 'book_id required' });

            const registry = storage.assetRegistry;
            const result = await registry.cleanupOrphans(redis, book_id, { dry_run: dry_run !== false });
            res.json({ book_id, dry_run: dry_run !== false, ...result });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // METRICS
    // ======================================================
    app.get('/api/v1/debug/runtime/metrics', async (req, res) => {
        try {
            const runtimeMetrics = {};
            try {
                const raw = await redis.get('animastor:runtime:metrics');
                if (raw) Object.assign(runtimeMetrics, JSON.parse(raw));
            } catch (_) {}

            res.json({
                stats,
                runtime: runtimeMetrics,
                active_scenes: (await redis.scard('animastor:active-scenes').catch(() => 0)),
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/v1/debug/runtime/counters', async (req, res) => {
        try {
            const counters = {};
            const counterKeys = [
                'animastor:runtime:active-audio', 'animastor:runtime:active-image',
                'animastor:runtime:active-video', 'animastor:runtime:total-dispatched',
                'animastor:runtime:total-completed', 'animastor:runtime:total-failed',
            ];
            for (const key of counterKeys) {
                counters[key.replace('animastor:runtime:', '')] = parseInt(await redis.get(key) || '0', 10);
            }
            res.json(counters);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/v1/debug/runtime/leases', async (req, res) => {
        try {
            const leases = {};
            let cursor = 0;
            do {
                const result = await redis.scan(cursor, 'MATCH', 'animastor:lease:*', 'COUNT', 200);
                cursor = parseInt(result[0], 10);
                for (const key of result[1]) {
                    try { leases[key] = JSON.parse(await redis.get(key)); } catch (_) {}
                }
            } while (cursor !== 0);
            res.json({ leases, count: Object.keys(leases).length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/v1/debug/runtime/dispatches', async (req, res) => {
        try {
            const dispatches = [];
            let cursor = 0;
            do {
                const result = await redis.scan(cursor, 'MATCH', 'animastor:job:*', 'COUNT', 200);
                cursor = parseInt(result[0], 10);
                for (const key of result[1]) {
                    try { dispatches.push({ key, data: JSON.parse(await redis.get(key)) }); } catch (_) {}
                }
            } while (cursor !== 0);
            res.json({ dispatches, count: dispatches.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/v1/debug/runtime/quotas', async (req, res) => {
        try {
            const quotas = {};
            try {
                const raw = await redis.get('animastor:runtime:quotas');
                if (raw) Object.assign(quotas, JSON.parse(raw));
            } catch (_) {}
            res.json(quotas);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/v1/debug/runtime/failures', async (req, res) => {
        try {
            const failures = [];
            let cursor = 0;
            do {
                const result = await redis.scan(cursor, 'MATCH', 'animastor:failure:*', 'COUNT', 200);
                cursor = parseInt(result[0], 10);
                for (const key of result[1]) {
                    try { failures.push({ key, data: JSON.parse(await redis.get(key)) }); } catch (_) {}
                }
            } while (cursor !== 0);
            res.json({ failures: failures.slice(-100), count: failures.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/v1/debug/runtime/drift', async (req, res) => {
        try {
            const drift = [];
            let cursor = 0;
            do {
                const result = await redis.scan(cursor, 'MATCH', 'animastor:drift:*', 'COUNT', 200);
                cursor = parseInt(result[0], 10);
                for (const key of result[1]) {
                    try { drift.push({ key, data: JSON.parse(await redis.get(key)) }); } catch (_) {}
                }
            } while (cursor !== 0);
            res.json({ drifts: drift.slice(-50), count: drift.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/v1/debug/runtime/retries', async (req, res) => {
        try {
            const retries = [];
            let cursor = 0;
            do {
                const result = await redis.scan(cursor, 'MATCH', 'animastor:retry:*', 'COUNT', 200);
                cursor = parseInt(result[0], 10);
                for (const key of result[1]) {
                    try { retries.push({ key, data: JSON.parse(await redis.get(key)) }); } catch (_) {}
                }
            } while (cursor !== 0);
            res.json({ retries: retries.slice(-50), count: retries.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/v1/debug/runtime/snapshots', async (req, res) => {
        try {
            const { book_id } = req.query;
            const snapshots = [];
            let cursor = 0;
            do {
                const match = book_id ? `animastor:snapshot:${book_id}` : 'animastor:snapshot:*';
                const result = await redis.scan(cursor, 'MATCH', match, 'COUNT', 200);
                cursor = parseInt(result[0], 10);
                for (const key of result[1]) {
                    try { snapshots.push({ key, data: JSON.parse(await redis.get(key)) }); } catch (_) {}
                }
            } while (cursor !== 0);
            res.json({ snapshots, count: snapshots.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/v1/debug/runtime/stuck-scenes', async (req, res) => {
        try {
            return res.json({ stuck_scenes: [], count: 0, message: 'scene-state removed' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // POST /api/v1/debug/runtime — recovery actions
    // ======================================================
    app.post('/api/v1/debug/runtime/recover-video', async (req, res) => {
        try {
            const { book_id, chapter_id, scene_id } = req.body || {};
            if (!book_id || !chapter_id || !scene_id) {
                return res.status(400).json({ error: 'book_id, chapter_id, scene_id required' });
            }

            const buildId = req.body.build_id || 'default';

            // L7: Set per-asset (audio+image READY, video DIRTY to force regen), then derive
            await state.unsafeRestoreAssetStates(redis, book_id, chapter_id, scene_id, {
                audio: state.AssetState.READY,
                image: state.AssetState.READY,
                video: state.AssetState.DIRTY
            });
            // T8: syncLinearState удалён

            // Clean up stale Redis state
            const lockKey = `animastor:video-lock:${book_id}:${chapter_id}:${scene_id}`;
            await redis.del(lockKey);
            const dedupKey = `animastor:video-dedup:${book_id}:${chapter_id}:${scene_id}`;
            await redis.del(dedupKey);
            const jobKey = `animastor:job:${book_id}_${chapter_id}_${scene_id}:video`;
            await redis.del(jobKey);
            const leaseKey = `animastor:lease:*:${book_id}:${chapter_id}:${scene_id}`;
            let cursor = 0;
            do {
                const result = await redis.scan(cursor, 'MATCH', leaseKey, 'COUNT', 100);
                cursor = parseInt(result[0], 10);
                if (result[1].length > 0) await redis.del(...result[1]);
            } while (cursor !== 0);

            // Reset chunk video flag
            const chunkId = `${book_id}_${chapter_id}_${scene_id}_0001`;
            const chunk = await getChunk(chunkId);
            if (chunk) {
                chunk.video = false;
                chunk.video_status = 'pending';
                await saveChunk(chunkId, { ...chunk, video: false, video_status: 'pending', build_id: buildId });
            }

            // Add back to active scenes for redispatch
            await activeScenes.addActiveScene(redis, book_id, chapter_id, scene_id);

            log('[DEBUG] Video recovery triggered for', `${book_id}/${chapter_id}/${scene_id}`);
            res.json({ recovered: true, book_id, chapter_id, scene_id });
        } catch (err) {
            console.error('[DEBUG RECOVER VIDEO] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/v1/debug/runtime/reset-scene', async (req, res) => {
        try {
            const { book_id, chapter_id, scene_id, target_state, build_id } = req.body || {};
            if (!book_id || !chapter_id || !scene_id || !target_state) {
                return res.status(400).json({ error: 'book_id, chapter_id, scene_id, target_state required' });
            }

            // Validate target state
            const validStates = ['new','audio_pending','audio_generating','audio_ready','image_pending','image_generating','image_ready','video_pending','video_generating','video_ready','failed'];
            if (!validStates.includes(target_state)) {
                return res.status(400).json({ error: `Invalid state. Valid: ${validStates.join(', ')}` });
            }

            // Clear stale locks and jobs
            const lockKey = `animastor:scene-lock:${book_id}:${chapter_id}:${scene_id}`;
            await redis.del(lockKey);
            const jobKey = `animastor:job:${book_id}_${chapter_id}_${scene_id}_*`;
            let cursor = 0;
            do {
                const result = await redis.scan(cursor, 'MATCH', jobKey, 'COUNT', 100);
                cursor = parseInt(result[0], 10);
                if (result[1].length > 0) await redis.del(...result[1]);
            } while (cursor !== 0);

            // Reset per-asset states — debug route
            await state.unsafeRestoreAssetStates(redis, book_id, chapter_id, scene_id, {
                audio: state.AssetState.PENDING,
                image: state.AssetState.PENDING,
                video: state.AssetState.PENDING
            });

            // Reset chunk flags
            const chunkId = `${book_id}_${chapter_id}_${scene_id}_0001`;
            const chunk = await getChunk(chunkId);
            if (chunk) {
                const updates = { build_id: build_id || chunk.build_id || 'default' };
                if (target_state === 'audio_pending' || target_state === 'raw') {
                    updates.audio = false; updates.audio_status = 'pending';
                }
                if (target_state === 'image_pending' || target_state === 'audio_pending' || target_state === 'raw') {
                    updates.image = false;
                }
                if (target_state === 'video_pending' || target_state === 'raw') {
                    updates.video = false; updates.video_status = 'pending';
                }
                await saveChunk(chunkId, { ...chunk, ...updates });
            }

            await activeScenes.addActiveScene(redis, book_id, chapter_id, scene_id);
            log('[DEBUG] Scene reset:', `${book_id}/${chapter_id}/${scene_id} → ${target_state}`);
            res.json({ reset: true, book_id, chapter_id, scene_id, target_state });
        } catch (err) {
            console.error('[DEBUG RESET SCENE] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // CLEANUP RETENTION
    // ======================================================
    app.post('/api/v1/debug/cleanup/retention', async (req, res) => {
        try {
            const { build_ttl_hours } = req.body || {};
            const ttlHours = build_ttl_hours || 48;
            const now = Date.now();
            const ttlMs = ttlHours * 60 * 60 * 1000;

            const builds = [];
            try {
                const dirs = fs.readdirSync(OUTPUT_DIR).filter(name => {
                    const fullPath = path.join(OUTPUT_DIR, name);
                    try { return fs.statSync(fullPath).isDirectory(); } catch (_) { return false; }
                });

                for (const dir of dirs) {
                    const dirPath = path.join(OUTPUT_DIR, dir);
                    const stat = fs.statSync(dirPath);
                    const ageMs = now - stat.mtimeMs;
                    if (ageMs > ttlMs) {
                        builds.push({ build_id: dir, age_hours: (ageMs / 3600000).toFixed(1) });
                    }
                }
            } catch (_) {}

            res.json({
                builds_to_cleanup: builds.length,
                builds: builds.slice(0, 50),
                ttl_hours: ttlHours,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // RUNTIME STATUS OVERVIEW
    // ======================================================
    app.get('/api/v1/debug/runtime/status', async (req, res) => {
        try {
            const runtimeMetrics = {};
            try {
                const raw = await redis.get('animastor:runtime:metrics');
                if (raw) Object.assign(runtimeMetrics, JSON.parse(raw));
            } catch (_) {}

            const activeAudio = parseInt(await redis.get('animastor:runtime:active-audio') || '0', 10);
            const activeImage = parseInt(await redis.get('animastor:runtime:active-image') || '0', 10);
            const activeVideo = parseInt(await redis.get('animastor:runtime:active-video') || '0', 10);
            const activeScenesCount = await redis.scard('animastor:active-scenes').catch(() => 0);

            res.json({
                stats,
                runtime: {
                    ...runtimeMetrics,
                    active_audio: activeAudio,
                    active_image: activeImage,
                    active_video: activeVideo,
                },
                active_scenes: activeScenesCount,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // AUDIO RECOVERY — on-demand per-scene (R6.3: trigger-based)
    // ======================================================
    app.post('/api/v1/debug/audio/recover', async (req, res) => {
        try {
            const { book_id, chapter_id, scene_id, build_id } = req.body || {};
            if (!book_id || !chapter_id || !scene_id) {
                return res.status(400).json({ error: 'book_id, chapter_id, scene_id required' });
            }

            const result = await audioRecovery.recoverAudioForScene(book_id, chapter_id, scene_id, build_id || 'default');
            log(`[DEBUG AUDIO RECOVER] ${book_id}/${chapter_id}/${scene_id}: ${result.reason}`);
            res.json(result);
        } catch (err) {
            console.error('[DEBUG AUDIO RECOVER] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // APPLY FIX — manual reconciliation fix (Phase 1: Passive Recovery)
    // ======================================================
    app.post('/api/v1/debug/runtime/apply-fix', async (req, res) => {
        try {
            const { book_id, chapter_id, scene_id, issue } = req.body || {};
            if (!book_id || !chapter_id || !scene_id || !issue) {
                return res.status(400).json({ error: 'book_id, chapter_id, scene_id, issue required' });
            }

            const reconciliationEngine = runtime.reconciliation;
            if (!reconciliationEngine) {
                return res.status(500).json({ error: 'reconciliation engine not available' });
            }

            // Run reconciliation for this scene to get the report
            const report = await reconciliationEngine.reconcileScene(redis, book_id, chapter_id, scene_id);

            // Find the matching inconsistency
            const inconsistent = report.inconsistentScenes.find(s =>
                s.scene.bookId === book_id &&
                s.scene.chapterId === chapter_id &&
                s.scene.sceneId === scene_id &&
                s.issue === issue
            );

            if (!inconsistent) {
                return res.status(404).json({
                    error: 'No matching inconsistency found',
                    report: report.toSummary(),
                });
            }

            // Generate fix and apply it
            const fixes = reconciliationEngine.getFixRecommendations([inconsistent]);
            const results = [];

            for (const fix of fixes) {
                try {
                    const result = await reconciliationEngine.applyFix(redis, fix);
                    results.push(result);
                    log(`[APPLY-FIX] ${fix.action} for ${book_id}/${chapter_id}/${scene_id}: ${result.success ? 'OK' : 'FAILED'} (${result.details})`);
                } catch (fixErr) {
                    results.push({ success: false, action: fix.action, details: fixErr.message });
                }
            }

            res.json({ applied: true, book_id, chapter_id, scene_id, issue, results });
        } catch (err) {
            console.error('[APPLY-FIX] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    log('[ROUTES] Debug routes loaded');
};
