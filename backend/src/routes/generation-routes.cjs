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
    const { log, pad, collectScenes } = utils;
    const OUTPUT_DIR = config.OUTPUT_DIR;

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
                        const stateKey = `animastor:scene-state:${c.book_id}:${c.chapter_id}:${c.scene_id}`;
                        await redis.set(stateKey, JSON.stringify({
                            state: state.SceneState.AUDIO_PENDING, updated_at: Date.now(),
                            build_id: c.build_id || 'default', error: null,
                        }));
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
                if (c.chapter_id && c.scene_id) {
                    const stateKey = `animastor:scene-state:${c.book_id}:${c.chapter_id}:${c.scene_id}`;
                    const raw = await redis.get(stateKey);
                    if (raw) {
                        const st = JSON.parse(raw);
                        if (st.state !== 'image_ready' && st.state !== 'video_ready') {
                            st.state = 'audio_ready';
                            st.updated_at = Date.now();
                            await redis.set(stateKey, JSON.stringify(st));
                        }
                    }
                }
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
                        const stateKey = `animastor:scene-state:${c.book_id}:${c.chapter_id}:${c.scene_id}`;
                        await redis.set(stateKey, JSON.stringify({
                            state: state.SceneState.IMAGE_PENDING, updated_at: Date.now(),
                            build_id: c.build_id || 'default', error: null,
                        }));
                        const jobKey = `animastor:job:${c.book_id}_${c.chapter_id}_${c.scene_id}_0002:image`;
                        await redis.del(jobKey);
                        await activeScenes.addActiveScene(redis, c.book_id, c.chapter_id, c.scene_id);
                    }
                }
            }

            const audioReady = !!(c.audio || fs.existsSync(audioPath));
            let imageReady = !!c.image;
            if (!imageReady && c.chapter_id && c.scene_id) {
                const stateKey = `animastor:scene-state:${c.book_id}:${c.chapter_id}:${c.scene_id}`;
                const stateRaw = await redis.get(stateKey);
                if (stateRaw) {
                    const st = JSON.parse(stateRaw);
                    if (st.state === 'image_ready' || st.state === 'video_pending' ||
                        st.state === 'video_generating' || st.state === 'video_ready') {
                        imageReady = true;
                        c.image = true;
                        await redis.set(`animastor:chunk:${req.params.id}`, JSON.stringify(c));
                    }
                } else {
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
                for (const [idx, iu] of ius.entries()) {
                    try {
                        await iuRepo.upsertImageUnit(build_id, book_id, chapter_id, scene_id, iu.unit_id, {
                            scene_order: idx, text: iu.text, text_length: (iu.text || '').length,
                            text_proportion: iu.text_proportion || 0, scene_duration_sec: sceneDuration || 0,
                            estimated_duration_sec: iu.estimated_duration_sec || 0,
                            scene_audio_file: `${book_id}_${chapter_id}_${scene_id}.mp3`,
                            start_ms: null, end_ms: null,
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
            const buildId = req.query.build_id;
            if (!buildId) return res.status(400).json({ error: 'build_id query param required' });
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
            const buildId = req.query.build_id;
            if (!buildId) return res.status(400).json({ error: 'build_id query param required' });
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

            // Use actual dispatch-lease keys as source of truth for active workers.
            // A dispatch-lease (set with TTL) exists ONLY while a real GPU task is
            // in flight. Quota counters (animastor:runtime:active-*) can leak on
            // cancelled jobs — leases expire cleanly via TTL even if completion
            // handler was never called.
            const countLeases = async (stage) => {
                const pattern = `animastor:dispatch-lease:*:*:*:${stage}`;
                let cursor = '0';
                let count = 0;
                try {
                    do {
                        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
                        cursor = result[0];
                        count += result[1].length;
                    } while (cursor !== '0');
                } catch (_) {}
                return count;
            };

            const [leaseAudio, leaseImage, leaseVideo, busyAudio, busyImage, busyVideo] = await Promise.all([
                countLeases('audio'),
                countLeases('image'),
                countLeases('video'),
                workerHealth.getBusyCount(redis, 'audio'),
                workerHealth.getBusyCount(redis, 'image'),
                workerHealth.getBusyCount(redis, 'video'),
            ]);

            // Pulse when a worker reports an active job via heartbeat (current_job_id).
            // If workers don't report jobs (old GPU workers), fall back to
            // dispatch-lease keys as a proxy for in-flight work.
            // Both checks require at least one alive worker to prevent stale signals.
            const activeAudio = status.audio > 0 ? (busyAudio > 0 ? busyAudio : leaseAudio) : 0;
            const activeImage = status.image > 0 ? (busyImage > 0 ? busyImage : leaseImage) : 0;
            const activeVideo = status.video > 0 ? (busyVideo > 0 ? busyVideo : leaseVideo) : 0;

            res.json({
                audio: status.audio || 0,
                image: status.image || 0,
                video: status.video || 0,
                active_audio: activeAudio,
                active_image: activeImage,
                active_video: activeVideo,
            });
        } catch (err) {
            res.json({ audio: 0, image: 0, video: 0, active_audio: 0, active_image: 0, active_video: 0 });
        }
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
            const buildId = req.query.build_id;
            if (!buildId) return res.status(400).json({ error: 'build_id query param required' });
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
    // SCENE WAVEFORM
    // ======================================================
    app.get('/api/v1/scene/:bookId/:chapterId/:sceneId/waveform', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const buildId = req.query.build_id;
            if (!buildId) return res.status(400).json({ error: 'build_id query param required' });
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
            const buildId = req.query.build_id;
            if (!buildId) return res.status(400).json({ error: 'build_id query param required' });

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
            const units = ius.map(iu => {
                if (iu.start_ms != null && iu.end_ms != null) {
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

            const totalMs = units.reduce((sum, u) => sum + (u.end_ms - u.start_ms), 0);
            res.json({ units, total_duration_ms: totalMs });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.put('/api/v1/scene/:bookId/:chapterId/:sceneId/timings', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const { build_id, units } = req.body || {};
            if (!build_id) return res.status(400).json({ error: 'build_id required' });
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
    // GPU TASK RESULT
    // ======================================================
    app.post('/gpu/task/result', async (req, res) => {
        try {
            const { job_id, result_base64, build_id } = req.body || {};
            if (!job_id || !result_base64) return res.status(400).json({ error: 'job_id and result_base64 required' });

            await deps.taskHandler.handleTaskResult(job_id, result_base64, build_id);
            res.json({ ok: true });
        } catch (err) {
            console.error('[GPU RESULT] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    log('[ROUTES] Generation routes loaded');
};
