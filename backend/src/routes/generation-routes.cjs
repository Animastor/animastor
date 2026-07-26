// ======================================================
// ANIMASTOR BACKEND — GENERATION ROUTES
// ======================================================
// /api/v1/generate, /api/v1/chunk/*, /api/v1/scene/*,
// /api/v1/worker/*, /api/v1/iu-image, /api/v1/preview,
// media serving, storyboard, audio timeline.
//
// Usage:
//   require('./routes/generation-routes.cjs')(app, redis, deps);

const path = require('path');
const fs = require('fs');
const multer = require('multer');

module.exports = function(app, redis, deps) {
    const {
        config, state, audio, image, video, book, orchestrator, storage,
        runtime, activeScenes, layerConfig, genScope, placeholderAudio,
        utils, saveChunk, getChunk, getAllChunks, getBookWindowStatus,
        detectAvailableMode, recoverChunksFromDisk, recoverAllBooksFromDisk,
        cleanupService, iuRepo, computeWaveform,
    } = deps;
    const { log } = utils;
    const OUTPUT_DIR = config.OUTPUT_DIR;

    // ======================================================
    // BUILD ID RESOLUTION
    // ======================================================
    // manifest.json is the single source of truth for build_id. The frontend is a
    // thin client: it may send a build_id (for its own cache keys) but the backend
    // never trusts it for addressing — it always resolves from the book manifest.
    // The requested value is used only as a fallback when the manifest can't be read.
    function getEffectiveBuildId(bookId, requestedBuildId, logFn) {
        const _log = logFn || (() => {});
        try {
            const loadedBook = book.loadBook(bookId);
            if (loadedBook && loadedBook.manifest && loadedBook.manifest.build_id) {
                const manifestBuildId = loadedBook.manifest.build_id;
                if (requestedBuildId && manifestBuildId !== requestedBuildId) {
                    _log(`buildId resolved: "${requestedBuildId}" → "${manifestBuildId}" for ${bookId}`);
                }
                return manifestBuildId;
            }
        } catch (_) {}
        return requestedBuildId || 'default';
    }

    // ======================================================
    // GENERATE (legacy full-book endpoint)
    // ======================================================
    app.post('/api/v1/generate', multer().single('file'), async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'file missing' });

            const files = book.extractBookBundle(req.file.buffer);
            log('📦 bundle loaded:', Object.keys(files));
            const bookData = book.buildBookFromBundle(files);
            const bookId = bookData.manifest.book_id;

            await genScope.setScope(redis, bookId, layerConfig.SCOPES.WHOLE_BOOK, null, null);

            const existingBook = book.loadBook(bookId);
            if (existingBook) {
                log(`Book ${bookId} already exists — keeping existing (edited) version`);
                const buildId = existingBook.manifest?.build_id || bookData.manifest.build_id || 'default';
                const layerCfgBody = {
                    audio_enabled: req.body.audio_enabled !== 'false',
                    image_enabled: req.body.image_enabled !== 'false',
                    video_enabled: req.body.video_enabled !== 'false',
                };
                await layerConfig.set(redis, bookId, layerCfgBody);
                const scenes = book.collectScenes(existingBook);
                const ids = await getAllChunks(bookId);
                if (ids.length === 0) {
                    log(`No chunks in Redis for existing book ${bookId} — recovering from disk`);
                    const recovered = await recoverChunksFromDisk(bookId, buildId, scenes);
                    if (recovered.length > 0) {
                        log(`Recovered ${recovered.length}/${scenes.length} chunks from disk`);
                        ids.push(...recovered);
                        await redis.set(config.BOOK_SCENE_TOTAL(bookId), scenes.length);
                        await redis.set(config.BOOK_SCENE_NEXT(bookId), recovered.length);
                        if (recovered.length < scenes.length) {
                            log(`Sliding window to process remaining ${scenes.length - recovered.length} scenes`);
                            const windowModule = require('../runtime/scene-window');
                            await windowModule.slideWindow(redis, bookId, existingBook, buildId);
                        }
                    } else {
                        log(`No files on disk — starting pipeline for ${scenes.length} scenes`);
                        const windowModule = require('../runtime/scene-window');
                        const started = await windowModule.initSceneWindow(redis, scenes, existingBook, buildId, bookId);
                        log(`Window init: ${started}/${scenes.length} scenes started`);
                        const newIds = await getAllChunks(bookId);
                        ids.push(...newIds);
                    }
                }
                if (ids.length === 0) {
                    log(`⚠️ Still no chunks after init — waiting 500ms and retrying for ${bookId}`);
                    await new Promise(r => setTimeout(r, 500));
                    const retry = await getAllChunks(bookId);
                    if (retry.length > 0) { log(`✅ Retry found ${retry.length} chunks`); ids.push(...retry); }
                }
                const mode = await detectAvailableMode(redis, bookId);
                return res.json({ book_id: bookId, build_id: buildId, chunk_ids: ids, mode });
            }

            await book.resetBook(bookId);
            book.saveBookBundle(bookData, files);

            const buildId = bookData.manifest.build_id || 'default';
            const loadedBook = book.loadBook(bookId);
            console.log(`[API] Loaded book from disk: ${bookId}, chapters: ${loadedBook.chapters?.length}`);

            const layerCfgBody = {
                audio_enabled: req.body.audio_enabled !== 'false',
                image_enabled: req.body.image_enabled !== 'false',
                video_enabled: req.body.video_enabled !== 'false',
            };
            await layerConfig.set(redis, bookId, layerCfgBody);
            console.log(`[LAYER] book=${bookId} audio=${layerCfgBody.audio_enabled} image=${layerCfgBody.image_enabled} video=${layerCfgBody.video_enabled}`);

            const scenes = book.collectScenes(loadedBook);
            console.log(`[API] Collected ${scenes.length} scenes from book`);

            const ids = await getAllChunks(bookId);
            if (ids.length === 0) {
                log(`No chunks in Redis — recovering from disk for book ${bookId}`);
                const recovered = await recoverChunksFromDisk(bookId, buildId, scenes);
                if (recovered.length > 0) {
                    log(`Recovered ${recovered.length}/${scenes.length} chunks from disk`);
                    ids.push(...recovered);
                    await redis.set(config.BOOK_SCENE_TOTAL(bookId), scenes.length);
                    await redis.set(config.BOOK_SCENE_NEXT(bookId), recovered.length);
                    if (recovered.length < scenes.length) {
                        log(`Sliding window to process remaining ${scenes.length - recovered.length} scenes`);
                        const windowModule = require('../runtime/scene-window');
                        await windowModule.slideWindow(redis, bookId, loadedBook, buildId);
                    }
                } else {
                    log(`No files on disk — starting pipeline for ${scenes.length} scenes`);
                    const windowModule = require('../runtime/scene-window');
                    const started = await windowModule.initSceneWindow(redis, scenes, loadedBook, buildId, bookId);
                    log(`Window init: ${started}/${scenes.length} scenes started`);
                    const newIds = await getAllChunks(bookId);
                    ids.push(...newIds);
                }
            } else {
                log(`Chunks found in Redis: ${ids.length}/${scenes.length}`);
                await redis.set(config.BOOK_SCENE_TOTAL(bookId), scenes.length);
                await redis.set(config.BOOK_SCENE_NEXT(bookId), ids.length);
                if (ids.length < scenes.length) {
                    log(`Sliding window to process remaining ${scenes.length - ids.length} scenes`);
                    const windowModule = require('../runtime/scene-window');
                    await windowModule.slideWindow(redis, bookId, loadedBook, buildId);
                }
            }
            const mode = await detectAvailableMode(redis, bookId);
            return res.json({ book_id: bookId, build_id: buildId, chunk_ids: ids, mode });
        } catch (err) {
            console.error('❌ GENERATE ERROR:', err);
            return res.status(400).json({ error: err.message || 'unknown error' });
        }
    });

    // ======================================================
    // CHUNK STATUS
    // ======================================================
    app.get('/api/v1/chunk/:id', async (req, res) => {
        try {
            const c = await getChunk(req.params.id);
            if (!c) return res.json({ status: 'processing' });

            const buildDir = path.join(OUTPUT_DIR, c.build_id);
            const audioPath = path.join(buildDir, `${c.book_id}_${c.chapter_id}_${c.scene_id}.mp3`);
            const imagePath = path.join(buildDir, `${c.book_id}_${c.chapter_id}_${c.scene_id}.png`);
            const videoPath = path.join(buildDir, `${c.book_id}_${c.chapter_id}_${c.scene_id}.mp4`);

            // Auto-redispatch if audio flag says ready but file is missing
            if (c.audio && !fs.existsSync(audioPath)) {
                try {
                    const phResult = await placeholderAudio.ensurePlaceholderAudio(
                        c.build_id || 'default', c.book_id, c.chapter_id, c.scene_id
                    );
                    const phOk = !!phResult && (phResult.created || (phResult.reason === 'already_exists' && phResult.path));
                    if (phOk && fs.existsSync(audioPath)) {
                        log(`Placeholder audio on-demand for ${req.params.id} — keeping chunk ready`);
                        c.audio_status = 'placeholder';
                        await redis.set(`animastor:chunk:${req.params.id}`, JSON.stringify(c));
                    } else {
                        // Don't reset c.audio = false — the chunk has audio: true,
                        // and audio_ready is computed as !!(c.audio || fileExists).
                        // Resetting permanently breaks the scene for the player.
                        log(`Placeholder audio generation returned ${JSON.stringify(phResult)} for ${req.params.id} — keeping chunk as-is`);
                    }
                } catch (phErr) {
                    log(`Placeholder audio check failed for ${req.params.id}: ${phErr.message} — keeping chunk as-is`);
                    if (c.chapter_id && c.scene_id) {
                        const jobKey = `animastor:job:${c.book_id}_${c.chapter_id}_${c.scene_id}_0001:audio`;
                        await redis.del(jobKey);
                        await activeScenes.addActiveScene(redis, c.book_id, c.chapter_id, c.scene_id);
                    }
                }
            }

            // Reverse: file exists but flag says not ready
            if (!c.audio && fs.existsSync(audioPath)) {
                log(`Audio file exists for ${req.params.id} — updating flag`);
                c.audio = true;
                c.audio_status = 'ready';
                await redis.set(`animastor:chunk:${req.params.id}`, JSON.stringify(c));
            }

            // Auto-redispatch for image
            if (c.image && !fs.existsSync(imagePath)) {
                const iuPrefix = `${c.book_id}_${c.chapter_id}_${c.scene_id}_iu`;
                let hasIuFiles = false;
                try {
                    const dirFiles = fs.readdirSync(buildDir);
                    hasIuFiles = dirFiles.some(f => f.startsWith(iuPrefix) && f.endsWith('.png'));
                } catch {}
                if (!hasIuFiles) {
                    log(`Missing image file for ${req.params.id} — resetting state for redispatch`);
                    c.image = false;
                    await redis.set(`animastor:chunk:${req.params.id}`, JSON.stringify(c));
                    if (c.chapter_id && c.scene_id) {
                        const jobKey = `animastor:job:${c.book_id}_${c.chapter_id}_${c.scene_id}_0002:image`;
                        await redis.del(jobKey);
                        await activeScenes.addActiveScene(redis, c.book_id, c.chapter_id, c.scene_id);
                    }
                }
            }

            const audioReady = !!(c.audio || fs.existsSync(audioPath));
            let imageReady = !!c.image;
            if (!imageReady && c.chapter_id && c.scene_id) {
                // Check per-asset state for image readiness
                try {
                    const assetStates = await state.getAssetStates(redis, c.book_id, c.chapter_id, c.scene_id);
                    if (assetStates.image === state.AssetState.READY || assetStates.image === state.AssetState.PLACEHOLDER) {
                        imageReady = true;
                        c.image = true;
                        await redis.set(`animastor:chunk:${req.params.id}`, JSON.stringify(c));
                    }
                } catch (_) {}
                if (!imageReady) {
                    imageReady = fs.existsSync(imagePath);
                    if (!imageReady) {
                        const iuPrefix = `${c.book_id}_${c.chapter_id}_${c.scene_id}_iu`;
                        try {
                            const dirFiles = fs.readdirSync(buildDir);
                            imageReady = dirFiles.some(f => f.startsWith(iuPrefix) && f.endsWith('.png'));
                        } catch {}
                    }
                }
            }
            const videoReady = !!(c.video && fs.existsSync(videoPath));
            const allReady = audioReady;

            res.json({
                status: allReady ? 'ready' : 'processing', image_ready: imageReady,
                audio_ready: audioReady, video_ready: videoReady,
                audio_status: c.audio_status || 'pending',
                video_status: c.video_status || 'pending',
                scene_type: c.scene_type || 'narration',
                scene_id: c.scene_id,
                chapter_id: c.chapter_id,
            });
        } catch (err) {
            console.error('❌ CHUNK STATUS ERROR:', err.message);
            res.status(500).json({ error: 'Internal error fetching chunk status' });
        }
    });

    // ======================================================
    // STORYBOARD
    // ======================================================
    app.get('/api/v1/chunk/:id/storyboard', async (req, res) => {
        try {
            const { id } = req.params;
            const c = await getChunk(id);
            if (!c) return res.status(404).json({ error: 'chunk not found' });

            const { build_id, book_id, chapter_id, scene_id } = c;
            const dir = path.join(OUTPUT_DIR, build_id);
            if (!fs.existsSync(dir)) return res.status(404).json({ error: 'build directory not found' });

            let ius = [];
            try {
                const pgRows = await iuRepo.getImageUnitsForScene(build_id, book_id, chapter_id, scene_id);
                if (pgRows && pgRows.length > 0) {
                    ius = pgRows.map(r => ({
                        unit_id: r.unit_id, scene_id: r.scene_id, text: r.text,
                        text_proportion: r.text_proportion, estimated_duration_sec: r.estimated_duration_sec,
                        audio_file: r.scene_audio_file,
                        start_ms: r.start_ms != null && (Number(r.start_ms) || 0) > 0 ? Number(r.start_ms) : null,
                        end_ms: r.end_ms != null && (Number(r.end_ms) || 0) > 0 ? Number(r.end_ms) : null,
                    }));
                }
            } catch (dbErr) {
                console.warn('[STORYBOARD] PG read failed, falling back to book data:', dbErr.message);
            }

            if (ius.length === 0) {
                try {
                    const b = book.loadBook(book_id);
                    if (b) {
                        for (const ch of b.chapters || []) {
                            if (ch.chapter !== chapter_id) continue;
                            for (const sc of ch.scenes || []) {
                                if (sc.scene_id !== scene_id) continue;
                                let order = 0;
                                for (const u of sc.units || []) {
                                    ius.push({ unit_id: u.id, scene_id, text: u.text, text_proportion: 0, estimated_duration_sec: 0, audio_file: null, start_ms: null, end_ms: null, _order: order });
                                    order++;
                                }
                                for (const db of sc.dialogue_blocks || []) {
                                    for (const u of db.units || []) {
                                        ius.push({ unit_id: u.id, scene_id, text: u.text, text_proportion: 0, estimated_duration_sec: 0, audio_file: null, start_ms: null, end_ms: null, _order: order });
                                        order++;
                                    }
                                }
                                const totalTextLen = ius.reduce((s, i) => s + (i.text || '').length, 0);
                                ius.sort((a, b) => a._order - b._order);
                                for (const iu of ius) {
                                    iu.text_proportion = totalTextLen > 0 ? (iu.text || '').length / totalTextLen : 1;
                                    delete iu._order;
                                    delete iu._text;
                                }
                                break;
                            }
                        }
                    }
                } catch (bookErr) {
                    console.warn('[STORYBOARD] Book data fallback failed:', bookErr.message);
                }
            }

            const needsDuration = ius.every(iu => !iu.estimated_duration_sec || iu.estimated_duration_sec === 0);
            if (needsDuration && ius.length > 0) {
                const sceneDuration = await image.getSceneDuration(build_id, book_id, chapter_id, scene_id);
                if (sceneDuration > 0) {
                    for (const iu of ius) {
                        iu.estimated_duration_sec = parseFloat((sceneDuration * (iu.text_proportion || 0)).toFixed(3));
                    }
                }
                // Compute timing boundaries (start_ms/end_ms) from cumulative durations
                const sceneDurationMs = Math.round(sceneDuration * 1000);
                let cursorMs = 0;
                for (const iu of ius) {
                    const durMs = Math.max(200, Math.round((iu.estimated_duration_sec || 1) * 1000));
                    iu._start_ms = cursorMs;
                    let endMs = cursorMs + durMs;
                    if (sceneDurationMs > 0 && endMs > sceneDurationMs) endMs = sceneDurationMs;
                    iu._end_ms = endMs;
                    cursorMs = endMs;
                }
                for (const [idx, iu] of ius.entries()) {
                    try {
                        await iuRepo.upsertImageUnit(build_id, book_id, chapter_id, scene_id, iu.unit_id, {
                            scene_order: idx, text: iu.text, text_length: (iu.text || '').length,
                            text_proportion: iu.text_proportion || 0, scene_duration_sec: sceneDuration || 0,
                            estimated_duration_sec: iu.estimated_duration_sec || 0,
                            scene_audio_file: `${book_id}_${chapter_id}_${scene_id}.mp3`,
                            start_ms: iu._start_ms != null ? iu._start_ms : null,
                            end_ms: iu._end_ms != null ? iu._end_ms : null,
                        });
                    } catch (pgErr) {
                        console.warn('[STORYBOARD] Failed to persist IU to PG:', pgErr.message);
                    }
                }
            }

            try {
                const pgRows = await iuRepo.getImageUnitsForScene(build_id, book_id, chapter_id, scene_id);
                if (pgRows && pgRows.length > 0) {
                    const pgMap = {};
                    for (const r of pgRows) {
                        if ((r.start_ms || 0) > 0 || (r.end_ms || 0) > 0) pgMap[r.unit_id] = r;
                    }
                    for (const iu of ius) {
                        const pg = pgMap[iu.unit_id];
                        if (pg) { iu.start_ms = pg.start_ms; iu.end_ms = pg.end_ms; }
                    }
                }
            } catch (dbErr) {
                console.warn('[STORYBOARD] DB timing merge failed:', dbErr.message);
            }

            // Server-computed playback duration per IU so clients never re-derive it.
            // Rule: real interval (end-start) if positive, else estimated_duration_sec,
            // else a 2000ms default. Mirrors the former client fallbackDurationMs().
            for (const iu of ius) {
                const real = (iu.start_ms != null && iu.end_ms != null) ? (iu.end_ms - iu.start_ms) : 0;
                if (real > 0) {
                    iu.duration_ms = real;
                } else if (iu.estimated_duration_sec && iu.estimated_duration_sec > 0) {
                    iu.duration_ms = Math.round(iu.estimated_duration_sec * 1000);
                } else {
                    iu.duration_ms = 2000;
                }
            }

            res.json({ chunk_id: id, book_id, chapter_id, scene_id, build_id, scene_type: c.scene_type || 'narration', ius });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // IU IMAGE
    // ======================================================
    app.get('/api/v1/iu-image/:bookId/:chapterId/:sceneId/:iuId', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId, iuId } = req.params;
            const buildId = getEffectiveBuildId(bookId, req.query.build_id, log);
            const imagePath = path.join(OUTPUT_DIR, buildId, `${bookId}_${chapterId}_${sceneId}_${iuId}.png`);
            if (!fs.existsSync(imagePath)) return res.status(404).json({ error: 'IU image not found' });
            res.setHeader('Content-Type', 'image/png');
            fs.createReadStream(imagePath).pipe(res);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // PREVIEW
    // ======================================================
    app.get('/api/v1/preview/:bookId/:chapterId/:sceneId/:iuId', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId, iuId } = req.params;
            const buildId = getEffectiveBuildId(bookId, req.query.build_id, log);
            const result = await image.getOrCreatePreview(bookId, chapterId, sceneId, iuId, buildId);
            if (!result) return res.status(404).json({ error: 'IU image not found, cannot generate preview' });
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('X-Preview-Created', String(result.created));
            fs.createReadStream(result.path).pipe(res);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // WORKER HEARTBEAT
    // ======================================================
    app.post('/api/v1/worker/heartbeat', async (req, res) => {
        try {
            const workerHealth = require('../runtime/worker-health');
            const { type, worker_id, current_job_id } = req.body || {};
            if (!type || !worker_id) return res.status(400).json({ error: 'type and worker_id required' });
            if (!config.WORKER_HEARTBEAT_TYPES.includes(type)) {
                return res.status(400).json({ error: `invalid type, must be one of: ${config.WORKER_HEARTBEAT_TYPES.join(', ')}` });
            }
            await workerHealth.reportHeartbeat(redis, type, worker_id, current_job_id || null);
            res.json({ ok: true, type, worker_id, current_job_id: current_job_id || null, ttl: config.WORKER_HEARTBEAT_TTL });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/v1/worker/status', async (req, res) => {
        try {
            const workerHealth = require('../runtime/worker-health');
            const status = await workerHealth.getStatus(redis);
            res.json({ workers: status, heartbeat_ttl_sec: config.WORKER_HEARTBEAT_TTL });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/v1/worker/counts', async (req, res) => {
        try {
            const workerHealth = require('../runtime/worker-health');
            const status = await workerHealth.getStatus(redis);

            const [busyAudio, busyImage, busyVideo, activeCount] = await Promise.all([
                workerHealth.getBusyCount(redis, 'audio'),
                workerHealth.getBusyCount(redis, 'image'),
                workerHealth.getBusyCount(redis, 'video'),
                redis.scard('animastor:active-scenes').catch(() => 0),
            ]);

            // Only pulse when worker reports actual busy status via heartbeat (current_job_id).
            // Dispatch-lease keys are NOT a proxy for active work — they exist from dispatch
            // to completion (up to 30 min for video) and do NOT indicate worker activity.
            // Using leases would cause false toggle pulse whenever a heartbeat expires
            // during a long-running GPU job (heartbeat TTL=30s, image gen can be 15 min).
            // GPU hub refreshes heartbeat every 10s for running tasks, keeping busy accurate.
            const activeAudio = status.audio > 0 ? busyAudio : 0;
            const activeImage = status.image > 0 ? busyImage : 0;
            const activeVideo = status.video > 0 ? busyVideo : 0;

            // VBook agent: check if the AI API is alive (key set + responds).
            // vbook = number of available AI agents (1 if alive, 0 if not).
            // active_vbook = 1 when a VBook agent session is actually running.
            const aiService = require('../services/ai-service');
            const vbookCount = await aiService.checkAIHealth(config);
            let activeVBook = 0;
            try {
                const result = await storage.postgres.query(
                    `SELECT COUNT(*)::int as cnt FROM agent_sessions WHERE status = 'running'`
                );
                activeVBook = (result.rows[0]?.cnt || 0) > 0 ? 1 : 0;
            } catch (pgErr) {
                console.warn('[WORKER-COUNTS] Failed to query agent_sessions:', pgErr.message);
            }

            res.json({
                audio: status.audio || 0,
                image: status.image || 0,
                video: status.video || 0,
                vbook: vbookCount,
                active_audio: activeAudio,
                active_image: activeImage,
                active_video: activeVideo,
                active_vbook: activeVBook,
                active_scenes: activeCount || 0,
            });
        } catch (err) {
            res.json({ audio: 0, image: 0, video: 0, active_audio: 0, active_image: 0, active_video: 0, vbook: 0, active_vbook: 0 });
        }
    });

    // ======================================================
    // PROGRESS STREAM (SSE) — real-time GPU generation progress
    // ======================================================
    // Pushes per-layer increment events as the GPU confirms work, so the
    // frontend advances immediately instead of waiting for the next poll.
    // Polling /assets-state remains the source of truth / reconcile path;
    // these events are advisory hints. Mirrors the SSE pattern in ai-routes.cjs.
    const { channel: progressChannel } = require('../services/progress-pubsub.cjs');
    app.get('/api/v1/book/:bookId/progress-stream', async (req, res) => {
        const { bookId } = req.params;

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
        res.flushHeaders?.();

        // Tell the client we're connected (also primes proxies).
        res.write(`event: open\ndata: ${JSON.stringify({ book_id: bookId })}\n\n`);

        // Dedicated subscriber connection — a SUBSCRIBE-mode client cannot run
        // normal commands, so we duplicate rather than reuse the shared client.
        const sub = redis.duplicate();
        const ch = progressChannel(bookId);

        const onMessage = (chan, message) => {
            if (chan !== ch) return;
            try { res.write(`data: ${message}\n\n`); } catch (_) {}
        };

        sub.on('message', onMessage);
        sub.on('error', (err) => {
            console.warn('[PROGRESS-STREAM] subscriber error:', err.message);
        });
        try {
            await sub.subscribe(ch);
        } catch (err) {
            console.warn('[PROGRESS-STREAM] subscribe failed:', err.message);
            try { res.end(); } catch (_) {}
            try { sub.disconnect(); } catch (_) {}
            return;
        }

        // Heartbeat comment keeps the connection alive through idle periods and
        // proxy timeouts. SSE comments (lines starting with ':') are ignored by
        // the client's event parser.
        const heartbeat = setInterval(() => {
            try { res.write(`: ping\n\n`); } catch (_) {}
        }, 15_000);

        const cleanup = () => {
            clearInterval(heartbeat);
            try { sub.removeListener('message', onMessage); } catch (_) {}
            try { sub.unsubscribe(ch).catch(() => {}); } catch (_) {}
            try { sub.disconnect(); } catch (_) {}
        };
        req.on('close', cleanup);
        res.on('error', cleanup);
    });

    // ======================================================
    // MEDIA SERVING
    // ======================================================
    app.get('/api/v1/chunk/:id/audio', async (req, res) => {
        try {
            const c = await getChunk(req.params.id);
            if (!c) return res.status(404).json({ error: 'chunk not found' });
            const audioPath = path.join(OUTPUT_DIR, c.build_id, `${c.book_id}_${c.chapter_id}_${c.scene_id}.mp3`);
            if (!fs.existsSync(audioPath)) return res.status(404).json({ error: 'audio not ready' });
            res.setHeader('Content-Type', 'audio/mpeg');
            fs.createReadStream(audioPath).pipe(res);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/v1/chunk/:id/image', async (req, res) => {
        const c = await getChunk(req.params.id);
        if (!c) return res.status(404).json({ error: 'chunk not found' });
        if (!c.image) return res.status(404).json({ error: 'image not ready' });
        const dir = path.join(OUTPUT_DIR, c.build_id);
        if (!fs.existsSync(dir)) return res.status(404).json({ error: 'build directory not found' });
        const files = fs.readdirSync(dir).filter(f => f.startsWith(`${c.book_id}_${c.chapter_id}_${c.scene_id}`) && f.endsWith('.png'));
        if (!files.length) return res.status(404).json({ error: 'no image files' });
        const filePath = path.join(dir, files[0]);
        res.setHeader('Content-Type', 'image/png');
        fs.createReadStream(filePath).pipe(res);
    });

    app.get('/api/v1/chunk/:id/video', async (req, res) => {
        try {
            const c = await getChunk(req.params.id);
            if (!c) return res.status(404).json({ error: 'chunk not found' });
            const dir = path.join(OUTPUT_DIR, c.build_id);
            if (!fs.existsSync(dir)) return res.status(404).json({ error: 'build directory not found' });
            const prefix = `${c.book_id}_${c.chapter_id}_${c.scene_id}`;
            const files = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.mp4'));
            if (!files.length) return res.status(404).json({ error: 'video not ready' });
            const filePath = path.join(dir, files[0]);
            res.setHeader('Content-Type', 'video/mp4');
            fs.createReadStream(filePath).pipe(res);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // SCENE AUDIO
    // ======================================================
    app.get('/api/v1/scene/:bookId/:chapterId/:sceneId/audio', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const buildId = getEffectiveBuildId(bookId, req.query.build_id, log);
            const audioPath = path.join(OUTPUT_DIR, buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);
            if (!fs.existsSync(audioPath)) return res.status(404).json({ error: 'audio not ready' });
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Accept-Ranges', 'bytes');
            fs.createReadStream(audioPath).pipe(res);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // SCENE STORYBOARD (scene-based, not chunk-based)
    // ======================================================
    app.get('/api/v1/scene/:bookId/:chapterId/:sceneId/storyboard', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const buildId = getEffectiveBuildId(bookId, req.query.build_id, log);
            const dir = path.join(OUTPUT_DIR, buildId);

            let ius = [];
            try {
                const pgRows = await iuRepo.getImageUnitsForScene(buildId, bookId, chapterId, sceneId);
                // Only use PG rows if they have text — stale rows with null/empty text
                // (e.g. after DELETE /cache) should fall back to book JSON which has the real text.
                if (pgRows && pgRows.length > 0 && pgRows.some(r => r.text != null && r.text !== '')) {
                    ius = pgRows.map(r => ({
                        unit_id: r.unit_id, scene_id: r.scene_id, text: r.text,
                        text_proportion: r.text_proportion, estimated_duration_sec: r.estimated_duration_sec,
                        audio_file: r.scene_audio_file,
                        start_ms: r.start_ms != null && (Number(r.start_ms) || 0) > 0 ? Number(r.start_ms) : null,
                        end_ms: r.end_ms != null && (Number(r.end_ms) || 0) > 0 ? Number(r.end_ms) : null,
                    }));
                }
            } catch (dbErr) {
                console.warn('[SCENE STORYBOARD] PG read failed, falling back to book data:', dbErr.message);
            }

            if (ius.length === 0) {
                try {
                    const b = book.loadBook(bookId);
                    if (b) {
                        const sceneData = book.findSceneRuntimeData(b, chapterId, sceneId);
                        if (sceneData && sceneData.payload) {
                            const sceneUnits = book.collectSceneUnits(sceneData.payload);
                            let order = 0;
                            for (const u of sceneUnits) {
                                ius.push({ unit_id: u.id, scene_id: sceneId, text: u.text, text_proportion: 0, estimated_duration_sec: 0, audio_file: null, start_ms: null, end_ms: null, _order: order });
                                order++;
                            }
                            const totalTextLen = ius.reduce((s, i) => s + (i.text || '').length, 0);
                            ius.sort((a, b) => a._order - b._order);
                            for (const iu of ius) {
                                iu.text_proportion = totalTextLen > 0 ? (iu.text || '').length / totalTextLen : 1;
                                delete iu._order;
                            }
                        }
                    }
                } catch (bookErr) {
                    console.warn('[SCENE STORYBOARD] Book data fallback failed:', bookErr.message);
                }
            }

            const needsDuration = ius.every(iu => !iu.estimated_duration_sec || iu.estimated_duration_sec === 0);
            if (needsDuration && ius.length > 0) {
                const sceneDuration = await image.getSceneDuration(buildId, bookId, chapterId, sceneId);
                if (sceneDuration > 0) {
                    for (const iu of ius) {
                        iu.estimated_duration_sec = parseFloat((sceneDuration * (iu.text_proportion || 0)).toFixed(3));
                    }
                }
                const sceneDurationMs = Math.round(sceneDuration * 1000);
                let cursorMs = 0;
                for (const iu of ius) {
                    const durMs = Math.max(200, Math.round((iu.estimated_duration_sec || 1) * 1000));
                    iu._start_ms = cursorMs;
                    let endMs = cursorMs + durMs;
                    if (sceneDurationMs > 0 && endMs > sceneDurationMs) endMs = sceneDurationMs;
                    iu._end_ms = endMs;
                    cursorMs = endMs;
                }
                for (const [idx, iu] of ius.entries()) {
                    try {
                        await iuRepo.upsertImageUnit(buildId, bookId, chapterId, sceneId, iu.unit_id, {
                            scene_order: idx, text: iu.text, text_length: (iu.text || '').length,
                            text_proportion: iu.text_proportion || 0, scene_duration_sec: sceneDuration || 0,
                            estimated_duration_sec: iu.estimated_duration_sec || 0,
                            scene_audio_file: `${bookId}_${chapterId}_${sceneId}.mp3`,
                            start_ms: iu._start_ms != null ? iu._start_ms : null,
                            end_ms: iu._end_ms != null ? iu._end_ms : null,
                        });
                    } catch (pgErr) {
                        console.warn('[SCENE STORYBOARD] Failed to persist IU to PG:', pgErr.message);
                    }
                }
            }

            try {
                const pgRows = await iuRepo.getImageUnitsForScene(buildId, bookId, chapterId, sceneId);
                if (pgRows && pgRows.length > 0) {
                    const pgMap = {};
                    for (const r of pgRows) {
                        if ((r.start_ms || 0) > 0 || (r.end_ms || 0) > 0) pgMap[r.unit_id] = r;
                    }
                    for (const iu of ius) {
                        const pg = pgMap[iu.unit_id];
                        if (pg) { iu.start_ms = pg.start_ms; iu.end_ms = pg.end_ms; }
                    }
                }
            } catch (dbErr) {
                console.warn('[SCENE STORYBOARD] DB timing merge failed:', dbErr.message);
            }

            for (const iu of ius) {
                const real = (iu.start_ms != null && iu.end_ms != null) ? (iu.end_ms - iu.start_ms) : 0;
                if (real > 0) {
                    iu.duration_ms = real;
                } else if (iu.estimated_duration_sec && iu.estimated_duration_sec > 0) {
                    iu.duration_ms = Math.round(iu.estimated_duration_sec * 1000);
                } else {
                    iu.duration_ms = 2000;
                }
            }

            res.json({ book_id: bookId, chapter_id: chapterId, scene_id: sceneId, build_id: buildId, ius });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // SCENE VIDEO (scene-based, not chunk-based)
    // ======================================================
    app.get('/api/v1/scene/:bookId/:chapterId/:sceneId/video', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const buildId = getEffectiveBuildId(bookId, req.query.build_id, log);
            const dir = path.join(OUTPUT_DIR, buildId);
            if (!fs.existsSync(dir)) return res.status(404).json({ error: 'build directory not found' });
            const prefix = `${bookId}_${chapterId}_${sceneId}`;
            const files = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.mp4'));
            if (!files.length) return res.status(404).json({ error: 'video not ready' });
            const filePath = path.join(dir, files[0]);
            res.setHeader('Content-Type', 'video/mp4');
            fs.createReadStream(filePath).pipe(res);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // SCENE IMAGE (scene-based, not chunk-based)
    // ======================================================
    app.get('/api/v1/scene/:bookId/:chapterId/:sceneId/image', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const buildId = getEffectiveBuildId(bookId, req.query.build_id, log);
            const dir = path.join(OUTPUT_DIR, buildId);
            if (!fs.existsSync(dir)) return res.status(404).json({ error: 'build directory not found' });
            const files = fs.readdirSync(dir).filter(f => f.startsWith(`${bookId}_${chapterId}_${sceneId}`) && f.endsWith('.png'));
            if (!files.length) return res.status(404).json({ error: 'no image files' });
            const filePath = path.join(dir, files[0]);
            res.setHeader('Content-Type', 'image/png');
            fs.createReadStream(filePath).pipe(res);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // SCENE STATUS (ready/placeholder for audio/video)
    // ======================================================
    app.get('/api/v1/scene/:bookId/:chapterId/:sceneId/status', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const buildId = getEffectiveBuildId(bookId, req.query.build_id, log);
            const buildDir = path.join(OUTPUT_DIR, buildId);
            const audioPath = path.join(buildDir, `${bookId}_${chapterId}_${sceneId}.mp3`);
            const videoPath = path.join(buildDir, `${bookId}_${chapterId}_${sceneId}.mp4`);
            const imagePath = path.join(buildDir, `${bookId}_${chapterId}_${sceneId}.png`);

            const audioReady = fs.existsSync(audioPath);
            const videoReady = fs.existsSync(videoPath);

            // Image readiness: check for either the scene .png file or IU images
            let imageReady = fs.existsSync(imagePath);
            if (!imageReady && fs.existsSync(buildDir)) {
                const iuPrefix = `${bookId}_${chapterId}_${sceneId}_iu`;
                try {
                    const dirFiles = fs.readdirSync(buildDir);
                    imageReady = dirFiles.some(f => f.startsWith(iuPrefix) && f.endsWith('.png'));
                } catch {}
            }

            // Scene type from book JSON
            let sceneType = 'narration';
            try {
                const b = book.loadBook(bookId);
                if (b) {
                    for (const ch of b.chapters || []) {
                        if (ch.chapter !== chapterId) continue;
                        for (const sc of ch.scenes || []) {
                            if (sc.scene_id === sceneId) {
                                sceneType = sc.type || sc.scene_type || 'narration';
                                break;
                            }
                        }
                    }
                }
            } catch {}

            res.json({
                book_id: bookId, chapter_id: chapterId, scene_id: sceneId,
                build_id: buildId, scene_type: sceneType,
                audio_ready: audioReady, video_ready: videoReady, image_ready: imageReady,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // SCENE WAVEFORM
    // ======================================================
    app.get('/api/v1/scene/:bookId/:chapterId/:sceneId/waveform', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const buildId = getEffectiveBuildId(bookId, req.query.build_id, log);
            const audioPath = path.join(OUTPUT_DIR, buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);
            if (!fs.existsSync(audioPath)) return res.status(404).json({ error: 'audio not ready' });
            const peaks = await computeWaveform(audioPath);
            const duration = await image.getSceneDuration(buildId, bookId, chapterId, sceneId);
            res.json({ peaks, duration_sec: Math.round(duration * 1000) / 1000, peak_count: peaks.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // SCENE TIMINGS (GET + PUT)
    // ======================================================
    app.get('/api/v1/scene/:bookId/:chapterId/:sceneId/timings', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const buildId = getEffectiveBuildId(bookId, req.query.build_id, log);

            let ius = [];
            try {
                const pgRows = await iuRepo.getImageUnitsForScene(buildId, bookId, chapterId, sceneId);
                if (pgRows && pgRows.length > 0) {
                    ius = pgRows.map(r => ({
                        unit_id: r.unit_id, scene_order: r.scene_order || 0,
                        start_ms: r.start_ms != null && (Number(r.start_ms) || 0) > 0 ? Number(r.start_ms) : null,
                        end_ms: r.end_ms != null && (Number(r.end_ms) || 0) > 0 ? Number(r.end_ms) : null,
                        estimated_duration_sec: r.estimated_duration_sec || 0,
                        text_proportion: r.text_proportion || 0,
                    }));
                }
            } catch (dbErr) {
                console.warn('[TIMINGS] PG read failed, falling back to book data:', dbErr.message);
            }

            if (ius.length === 0) {
                try {
                    const b = book.loadBook(bookId);
                    if (b) {
                        for (const ch of b.chapters || []) {
                            if (ch.chapter !== chapterId) continue;
                            for (const sc of ch.scenes || []) {
                                if (sc.scene_id !== sceneId) continue;
                                let order = 0;
                                for (const u of sc.units || []) {
                                    ius.push({ unit_id: u.id, scene_order: order, start_ms: null, end_ms: null, estimated_duration_sec: 0, text_proportion: 0, _text: u.text || '' });
                                    order++;
                                }
                                for (const db of sc.dialogue_blocks || []) {
                                    for (const u of db.units || []) {
                                        ius.push({ unit_id: u.id, scene_order: order, start_ms: null, end_ms: null, estimated_duration_sec: 0, text_proportion: 0, _text: u.text || '' });
                                        order++;
                                    }
                                }
                                const totalTextLen = ius.reduce((s, i) => s + i._text.length, 0);
                                for (const iu of ius) {
                                    iu.text_proportion = totalTextLen > 0 ? iu._text.length / totalTextLen : 1;
                                    delete iu._order;
                                    delete iu._text;
                                }
                                break;
                            }
                        }
                    }
                } catch (bookErr) {
                    console.warn('[TIMINGS] Book data fallback failed:', bookErr.message);
                }
            }

            if (ius.length === 0) return res.json({ units: [], total_duration_ms: 0 });

            const sceneDuration = await image.getSceneDuration(buildId, bookId, chapterId, sceneId);
            const sceneDurationMs = Math.round(sceneDuration * 1000);

            const needsDuration = ius.every(iu => !iu.estimated_duration_sec || iu.estimated_duration_sec === 0);
            if (needsDuration && ius.length > 0) {
                if (sceneDuration > 0) {
                    for (const iu of ius) {
                        iu.estimated_duration_sec = parseFloat((sceneDuration * (iu.text_proportion || 0)).toFixed(3));
                    }
                }
            }

            ius.sort((a, b) => a.scene_order - b.scene_order);

            let cursorMs = 0;
            const needsCompute = ius.some(iu => iu.start_ms == null || iu.end_ms == null || (Number(iu.end_ms) - Number(iu.start_ms)) <= 0);
            // When needsCompute is true, always recompute ALL units from scratch
            // using cumulative cursorMs. Trusting existing start_ms/end_ms values
            // when some units are being recomputed creates inconsistent gaps:
            // unit0 may be recomputed with the current scene_duration_sec, but
            // unit1's "valid" timings from a different audio duration are kept
            // unchanged, causing overlaps or gaps.
            const units = ius.map(iu => {
                if (!needsCompute && iu.start_ms != null && iu.end_ms != null && (Number(iu.end_ms) - Number(iu.start_ms)) > 0) {
                    cursorMs = iu.end_ms;
                    const clampedEndMs = sceneDurationMs > 0 ? Math.min(iu.end_ms, sceneDurationMs) : iu.end_ms;
                    return { unit_id: iu.unit_id, scene_order: iu.scene_order, start_ms: iu.start_ms, end_ms: clampedEndMs, estimated_duration_sec: iu.estimated_duration_sec, text_proportion: iu.text_proportion };
                }
                const durMs = Math.max(200, Math.round((iu.estimated_duration_sec || 1) * 1000));
                const start = cursorMs;
                let end = cursorMs + durMs;
                if (sceneDurationMs > 0 && end > sceneDurationMs) end = sceneDurationMs;
                cursorMs = end;
                return { unit_id: iu.unit_id, scene_order: iu.scene_order, start_ms: start, end_ms: end, estimated_duration_sec: iu.estimated_duration_sec || 0, text_proportion: iu.text_proportion || 0 };
            });

            // Persist computed start_ms/end_ms back to PG so subsequent calls
            // don't recompute from scratch.
            if (needsCompute && units.length > 0) {
                for (const u of units) {
                    try {
                        await iuRepo.upsertIuTiming(buildId, bookId, chapterId, sceneId, u.unit_id, u.start_ms, u.end_ms);
                    } catch (persistErr) {
                        console.warn('[TIMINGS] Failed to persist timing:', persistErr.message);
                    }
                }
                log(`[TIMINGS] Persisted ${units.length} timing boundaries for ${bookId}/${chapterId}/${sceneId}`);
            }

            const totalMs = units.reduce((sum, u) => sum + (u.end_ms - u.start_ms), 0);
            res.json({ units, total_duration_ms: totalMs });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.put('/api/v1/scene/:bookId/:chapterId/:sceneId/timings', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const { build_id: rawBuildId, units } = req.body || {};
            const build_id = getEffectiveBuildId(bookId, rawBuildId, log);
            if (!units || !Array.isArray(units)) return res.status(400).json({ error: 'units array required' });

            const rows = await iuRepo.getImageUnitsForScene(build_id, bookId, chapterId, sceneId);
            const existingMap = {};
            for (const r of rows) existingMap[r.unit_id] = r;

            const sorted = [...units].sort((a, b) => (existingMap[a.unit_id]?.scene_order ?? 0) - (existingMap[b.unit_id]?.scene_order ?? 0));

            const sceneDuration = await image.getSceneDuration(build_id, bookId, chapterId, sceneId);
            const sceneDurationMs = Math.round(sceneDuration * 1000);

            const recalculated = [];
            let cursorMs = 0;

            for (const unit of sorted) {
                const preferredStart = unit.start_ms;
                const preferredEnd = unit.end_ms;
                const startMs = Math.max(preferredStart, cursorMs);
                let endMs = Math.max(startMs + 50, preferredEnd);
                if (sceneDurationMs > 0 && endMs > sceneDurationMs) endMs = sceneDurationMs;
                recalculated.push({ unit_id: unit.unit_id, start_ms: startMs, end_ms: endMs });
                cursorMs = endMs;
            }

            for (const u of recalculated) {
                await iuRepo.upsertIuTiming(build_id, bookId, chapterId, sceneId, u.unit_id, u.start_ms, u.end_ms);
            }

            res.json({ units: recalculated, recalculated: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // GPU TASK RESULT — T4: dispatch identity check
    // ======================================================
    // Н.1: Idempotent callback handling.
    // T4: dispatch_id проверяется перед обработкой — stale callback
    // от предыдущего dispatch отклоняется, не влияя на текущий.
    app.post('/gpu/task/result', async (req, res) => {
        try {
            const jobSchema = require('../runtime/job-schema');
            const { job_id, result_base64, build_id, dispatch_id, protocol_version } = req.body || {};
            log(`[GPU RESULT] Received: job_id=${job_id} build_id=${build_id} dispatch_id=${dispatch_id} proto=${protocol_version} size=${(result_base64 || '').length}B`);

            if (
                !job_id ||
                !result_base64 ||
                !build_id ||
                !dispatch_id ||
                protocol_version !== jobSchema.PROTOCOL_VERSION
            ) {
                const msg = 'valid job_id, result_base64, build_id, dispatch_id and protocol_version required';
                log(`[GPU RESULT] Validation failed: ${msg} (job_id=${!!job_id} base64=${!!result_base64} build_id=${!!build_id} dispatch_id=${!!dispatch_id} proto=${protocol_version} expected=${jobSchema.PROTOCOL_VERSION})`);
                return res.status(400).json({ error: msg });
            }

            const parsed = jobSchema.parseJobId(job_id);
            const stage = parsed ? jobSchema.STAGE_BY_KIND[parsed.kind] : null;
            if (!parsed || !stage) {
                log(`[GPU RESULT] parseJobId failed for ${job_id}`);
                return res.status(400).json({ error: 'invalid job_id' });
            }
            log(`[GPU RESULT] Parsed: kind=${parsed.kind} book=${parsed.bookId} ch=${parsed.chapterId} sc=${parsed.sceneId} stage=${stage}`);

            const dispatchEngine = require('../runtime/dispatch-engine');
            const identity = await dispatchEngine.verifyDispatchIdentity(
                redis,
                parsed.bookId,
                parsed.chapterId,
                parsed.sceneId,
                stage,
                dispatch_id
            );
            log(`[GPU RESULT] verifyDispatchIdentity: valid=${identity.valid} reason=${identity.reason}`);
            if (!identity.valid) {
                // 🔧 FIX: Audio chunks can arrive with stale dispatch_id when batch
                // dispatch reorders narration→dialogue. By the time dialogue chunks
                // complete, the original dispatch lease may have expired and the
                // scheduler created a new dispatch. Accept audio chunks as long as
                // the scene is still in WAITING_CHUNKS/MERGING (actively collecting chunks).
                if (stage === 'audio' && identity.reason === 'stale_dispatch') {
                    const audioOrch = require('../services/audio-orchestrator');
                    const orchState = await audioOrch.getState(redis, parsed.bookId, parsed.chapterId, parsed.sceneId);
                    if (orchState && (orchState.phase === audioOrch.PHASES.WAITING_CHUNKS || orchState.phase === audioOrch.PHASES.MERGING)) {
                        log(`[GPU RESULT] Stale dispatch ACCEPTED for ${job_id} (scene still ${orchState.phase})`);
                    } else {
                        log(`[GPU RESULT] Rejected ${job_id}: ${identity.reason} (scene phase=${orchState?.phase || 'none'})`);
                        return res.json({ ok: true, rejected: true, reason: identity.reason });
                    }
                } else {
                    log(`[GPU RESULT] Rejected ${job_id}: ${identity.reason}`);
                    return res.json({ ok: true, rejected: true, reason: identity.reason });
                }
            }

            // Н.1: Dedup
            const dedupKey = `animastor:result-processed:${dispatch_id}:${job_id}:${build_id}`;
            const alreadyProcessed = await redis.set(dedupKey, '1', 'NX', 'EX', 3600);
            if (!alreadyProcessed) {
                log(`[GPU RESULT] Dedup: ${job_id} (build=${build_id}) already processed — skipping`);
                return res.json({ ok: true, deduped: true });
            }
            log(`[GPU RESULT] Dedup acquired for ${job_id}`);

            try {
                log(`[GPU RESULT] Calling handleTaskResult for ${job_id}...`);
                await deps.taskHandler.handleTaskResult(job_id, result_base64, build_id, dispatch_id);
                log(`[GPU RESULT] handleTaskResult OK: ${job_id}`);
            } catch (procErr) {
                log(`[GPU RESULT] handleTaskResult FAILED: ${job_id} — ${procErr.message}`);
                await redis.del(dedupKey).catch(() => {});
                throw procErr;
            }
            res.json({ ok: true });
        } catch (err) {
            console.error('[GPU RESULT] Error:', err.message);
            console.error('[GPU RESULT] Stack:', err.stack);
            res.status(500).json({ error: err.message });
        }
    });

    // ── GPU task error callback ─────────────────────────
    // T4: dispatch_id проверяется перед обработкой
    app.post('/gpu/task/error', async (req, res) => {
        try {
            const jobSchema = require('../runtime/job-schema');
            const { job_id, build_id, reason, dispatch_id, protocol_version } = req.body || {};
            if (
                !job_id ||
                !build_id ||
                !dispatch_id ||
                protocol_version !== jobSchema.PROTOCOL_VERSION
            ) {
                return res.status(400).json({
                    error: 'valid job_id, build_id, dispatch_id and protocol_version required'
                });
            }

            const parsed = jobSchema.parseJobId(job_id);
            if (!parsed) {
                console.warn(`[GPU ERROR] Unparseable job_id: ${job_id} (reason=${reason})`);
                return res.json({ ok: true, ignored: true });
            }

            const stage = jobSchema.STAGE_BY_KIND[parsed.kind];
            const { bookId, chapterId, sceneId } = parsed;
            if (!stage) {
                return res.status(400).json({ error: 'unsupported job type' });
            }

            const dispatchEngine = require('../runtime/dispatch-engine');
            const identity = await dispatchEngine.verifyDispatchIdentity(
                redis,
                bookId,
                chapterId,
                sceneId,
                stage,
                dispatch_id
            );
            if (!identity.valid) {
                log(`[GPU ERROR] Rejected ${job_id}: ${identity.reason}`);
                return res.json({ ok: true, rejected: true, reason: identity.reason });
            }

            // Короткий dedup
            const dedupKey = `animastor:error-processed:${dispatch_id}:${job_id}:${build_id}`;
            const first = await redis.set(dedupKey, '1', 'NX', 'EX', 60);
            if (!first) return res.json({ ok: true, deduped: true });

            log(`[GPU ERROR] ${bookId}/${chapterId}/${sceneId} ${stage} failed: ${reason || 'unknown'} (job=${job_id})`);

            if (parsed.kind === 'audio_chunk') {
                try {
                    const audioOrch = require('../services/audio-orchestrator');
                    await audioOrch.setFailed(redis, bookId, chapterId, sceneId,
                        `chunk_error:${parsed.chunkIndex}:${reason || 'unknown'}`);
                } catch (orchErr) {
                    console.warn(`[GPU ERROR] audio-orch setFailed failed: ${orchErr.message}`);
                }
            }

            const result = await orchestrator.failStage(
                redis,
                bookId,
                chapterId,
                sceneId,
                stage,
                build_id,
                reason || 'worker_error',
                { dispatchId: dispatch_id }
            );
            res.json({ ok: true, ...result });
        } catch (err) {
            console.error('[GPU ERROR] Handler error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    log('[ROUTES] Generation routes loaded');
};
