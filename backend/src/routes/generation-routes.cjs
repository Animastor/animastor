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
const videoTimeline = require('../video/video-timeline');
const authContextMiddleware = require('../middleware/auth-context');

module.exports = function(app, redis, deps) {
    const {
        config, state, audio, image, video, book, orchestrator, storage,
        runtime, activeScenes, layerConfig, genScope, placeholderAudio,
        utils, saveChunk, getChunk, getAllChunks, getBookWindowStatus,
        detectAvailableMode, recoverChunksFromDisk, recoverAllBooksFromDisk,
        cleanupService, iuRepo, computeWaveform, playerModel,
    } = deps;
    const { log } = utils;
    const OUTPUT_DIR = config.OUTPUT_DIR;

    // Book ownership guard for chunk-keyed (Redis-backed) routes: the target
    // book comes from the chunk record, not the URL, so it is verified
    // in-handler after the chunk is loaded. Pre-auth passes through (existing
    // behaviour); authenticated requests must own the book.
    // Returns true (and responds 403) when access is denied.
    async function rejectIfChunkBookDenied(req, res, bookId) {
        const ws = await authContextMiddleware.checkBookAccess(req, bookId);
        if (!ws) {
            res.status(403).json({ error: 'Access denied: not a member of the book\'s workspace' });
            return true;
        }
        return false;
    }

    // ======================================================
    // PW-2: GPU HUB → BACKEND CALLBACK GUARD
    // ======================================================
    // The hub forwards worker_id/workspace_id with result/error callbacks.
    // These fields are AUDIT-ONLY: the backend re-verifies job→book→workspace
    // itself (one indexed query) and never trusts the forwarded identity for
    // authorization. When GPU_HUB_API_KEY is configured the hop is
    // key-authenticated (header-only); unset keeps the legacy open behaviour.
    function requireHubCallbackAuth(req, res, next) {
        if (!config.GPU_HUB_API_KEY) return next();
        if (req.headers['x-api-key'] !== config.GPU_HUB_API_KEY) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        next();
    }

    /**
     * Re-verify the forwarded workspace against the book's owning workspace.
     * Rules (fail closed on mismatch, permissive on degraded lanes):
     *   - forwarded workspace_id present → MUST equal books.workspace_id;
     *   - forwarded null (system-lane claim) → accepted (backward compat;
     *     routing may have degraded to the system pool);
     *   - book unattached (no workspace row) → accepted.
     * @returns {Promise<{ok:boolean, reason?:string, workspaceId:string|null}>}
     */
    async function verifyCallbackWorkspace(bookId, forwardedWorkspaceId) {
        const bookRepo = require('../storage/postgres/repositories/book-repo');
        let bookWorkspaceId = null;
        try {
            bookWorkspaceId = await bookRepo.getWorkspaceId(bookId);
        } catch (err) {
            // PG outage on the re-verify path: fail closed for workspace-scoped
            // callbacks (a mismatch cannot be ruled out), accept system-lane.
            if (forwardedWorkspaceId) {
                return { ok: false, reason: 'workspace_reverify_unavailable', workspaceId: null };
            }
            return { ok: true, workspaceId: null };
        }
        if (forwardedWorkspaceId && forwardedWorkspaceId !== bookWorkspaceId) {
            return { ok: false, reason: 'workspace_mismatch', workspaceId: bookWorkspaceId };
        }
        return { ok: true, workspaceId: bookWorkspaceId };
    }

    /** Best-effort persistence of the claimer on running tasks (PW-2). */
    async function persistTaskClaim(bookId, chapterId, sceneId, stage, workerId, workspaceId) {
        try {
            const taskRepo = require('../storage/postgres/repositories/task-repo');
            await taskRepo.recordTaskClaim(bookId, chapterId, sceneId, stage, workerId, workspaceId);
        } catch (err) {
            console.warn(`[GPU] recordTaskClaim failed for ${bookId}/${chapterId}/${sceneId}:${stage}: ${err.message}`);
        }
    }

    // ======================================================
    // BUILD ID RESOLUTION
    // ======================================================
    // manifest.json is the single source of truth for build_id. The frontend is a
    // thin client: it may send a build_id (for its own cache keys) but the backend
    // never trusts it for addressing — it always resolves from the book manifest.
    // The requested value is used only as a fallback when the manifest can't be read.
    // Phase 6: the manifest read goes through the Player boundary
    // (playerModel → Canonical Book Model), not through a raw loader.
    function getEffectiveBuildId(bookId, requestedBuildId, logFn) {
        const _log = logFn || (() => {});
        try {
            const loadedBook = playerModel.loadBook(bookId);
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

            // Cross-workspace guard for authenticated callers: the bundle
            // book_id is client-controlled — never overwrite a foreign book.
            const generateImportCheck = await authContextMiddleware.importBookAllowed(req, bookId, {
                diskCopyExists: !!book.loadBook(bookId),
            });
            if (!generateImportCheck.allowed) {
                return res.status(generateImportCheck.status).json({ error: generateImportCheck.error });
            }
            try {
                const workspaceOwnership = require('../middleware/workspace-ownership');
                await workspaceOwnership.resolveWorkspaceForBook(bookId, { preferredWorkspaceId: req.workspace?.id || null });
            } catch (wsErr) {
                console.warn(`[GENERATE] Ownership attach failed for ${bookId} (non-fatal): ${wsErr.message}`);
            }

            // Cathedral Recon #3 §5.4 option 1: an explicit full-book generate is a
            // new run — clear any cancellation tombstone so it can't linger and be
            // skipped by startup-resume on a later restart. Best-effort.
            try {
                const generationCancelRepo = require('../storage/postgres/repositories/generation-cancel-repo');
                await generationCancelRepo.clear(bookId);
            } catch (tombErr) {
                console.warn(`[GENERATE] Failed to clear cancellation tombstone for ${bookId}: ${tombErr.message}`);
            }

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
            if (await rejectIfChunkBookDenied(req, res, c.book_id)) return;

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
            if (await rejectIfChunkBookDenied(req, res, c.book_id)) return;

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
                        // Note: start_ms=0 maps to null here, but unlike the
                        // timings GET route this is self-corrected by the pgMap
                        // merge below (rows with end_ms>0 override the nulls).
                        start_ms: r.start_ms != null && (Number(r.start_ms) || 0) > 0 ? Number(r.start_ms) : null,
                        end_ms: r.end_ms != null && (Number(r.end_ms) || 0) > 0 ? Number(r.end_ms) : null,
                    }));
                }
            } catch (dbErr) {
                console.warn('[STORYBOARD] PG read failed, falling back to book data:', dbErr.message);
            }

            if (ius.length === 0) {
                try {
                    const b = playerModel.loadBook(book_id);
                    if (b) {
                        for (const ch of b.chapters || []) {
                            if (ch.chapter_id !== chapter_id) continue;
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
    // NOTE: the legacy POST /api/v1/worker/heartbeat endpoint was REMOVED
    // (Experimental Beta — Private Worker Phase 1). It was unauthenticated,
    // unused by real workers (the GPU hub writes heartbeats itself), and —
    // worse — every anonymous POST auto-provisioned a guest + temporary
    // workspace via authContext, making it a DB row-churn vector. Worker
    // liveness now flows through the token-authenticated hub path; the
    // read-only status/counts endpoints below remain.

    // VISIBILITY: global operational view — SYSTEM/shared pool only. Private
    // workers of any workspace never appear in these numbers (worker-health
    // classifies heartbeats by the hub-authored scope fields).
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

            // VISIBILITY: availability = liveness ∧ scope. The global fields
            // carry the SYSTEM/shared pool ONLY; the caller's OWN private
            // workers are reported separately (private_*) and are never mixed
            // into the global numbers. Guests/anonymous get zeros — workers
            // can only be created by registered users.
            const workspaceId = (req.user && req.workspace && req.workspace.id)
                ? req.workspace.id
                : null;
            const avail = await workerHealth.getAvailability(redis, workspaceId);

            const activeCount = await redis.scard('animastor:active-scenes').catch(() => 0);

            // Only pulse when worker reports actual busy status via heartbeat (current_job_id).
            // Dispatch-lease keys are NOT a proxy for active work — they exist from dispatch
            // to completion (up to 30 min for video) and do NOT indicate worker activity.
            // Using leases would cause false toggle pulse whenever a heartbeat expires
            // during a long-running GPU job (heartbeat TTL=30s, image gen can be 15 min).
            // GPU hub refreshes heartbeat every 10s for running tasks, keeping busy accurate.
            const activeAudio = avail.system.audio > 0 ? avail.system_busy.audio : 0;
            const activeImage = avail.system.image > 0 ? avail.system_busy.image : 0;
            const activeVideo = avail.system.video > 0 ? avail.system_busy.video : 0;

            // VBook agent: check if the AI API is alive (key set + responds).
            // vbook = number of available AI agents (1 if alive, 0 if not).
            // active_vbook = 1 when a VBook agent session is actually running.
            // Health is workspace-aware: an authenticated workspace provider
            // (Experimental Beta) can be alive while the global env key is not
            // (and vice versa) — cache is keyed per provider inside ai-service.
            const aiService = require('../services/ai-service');
            let workspaceProvider = null;
            if (req.workspace && req.workspace.id) {
                try {
                    const workspaceAi = require('../services/workspace-ai-provider');
                    workspaceProvider = await workspaceAi.resolveAIForWorkspace(req.workspace.id);
                } catch (_) { /* global fallback below */ }
            }
            const vbookCount = await aiService.checkAIHealth(config, workspaceProvider);
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
                // SYSTEM/shared pool — what every caller may use. A foreign
                // workspace's private worker is never part of these numbers.
                audio: avail.system.audio || 0,
                image: avail.system.image || 0,
                video: avail.system.video || 0,
                vbook: vbookCount,
                active_audio: activeAudio,
                active_image: activeImage,
                active_video: activeVideo,
                active_vbook: activeVBook,
                active_scenes: activeCount || 0,
                // The caller's OWN private workers (registered users only).
                private_audio: avail.private.audio || 0,
                private_image: avail.private.image || 0,
                private_video: avail.private.video || 0,
                private_active_audio: avail.private_busy.audio || 0,
                private_active_image: avail.private_busy.image || 0,
                private_active_video: avail.private_busy.video || 0,
                // PHYSICAL union for UI counters: system pool ∪ own private
                // workers, each PHYSICAL worker counted ONCE (dedup by
                // worker_id). Never sum audio+private_audio: per D3 a
                // policy-active private worker is in BOTH capacity buckets
                // but is ONE physical unit. Sharing grants access to an
                // existing worker — it does not create a new one.
                available_audio: avail.available.audio || 0,
                available_image: avail.available.image || 0,
                available_video: avail.available.video || 0,
                available_active_audio: avail.available_busy.audio || 0,
                available_active_image: avail.available_busy.image || 0,
                available_active_video: avail.available_busy.video || 0,
            });
        } catch (err) {
            res.json({
                audio: 0, image: 0, video: 0,
                active_audio: 0, active_image: 0, active_video: 0,
                vbook: 0, active_vbook: 0,
                private_audio: 0, private_image: 0, private_video: 0,
                private_active_audio: 0, private_active_image: 0, private_active_video: 0,
                available_audio: 0, available_image: 0, available_video: 0,
                available_active_audio: 0, available_active_image: 0, available_active_video: 0,
            });
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
            if (await rejectIfChunkBookDenied(req, res, c.book_id)) return;
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
        if (await rejectIfChunkBookDenied(req, res, c.book_id)) return;
        if (!c.image) return res.status(404).json({ error: 'image not ready' });
        const dir = path.join(OUTPUT_DIR, c.build_id);
        if (!fs.existsSync(dir)) return res.status(404).json({ error: 'build directory not found' });
        const files = fs.readdirSync(dir).filter(f => f.startsWith(`${c.book_id}_${c.chapter_id}_${c.scene_id}`) && f.endsWith('.png'));
        if (!files.length) return res.status(404).json({ error: 'no image files' });
        const filePath = path.join(dir, files[0]);
        res.setHeader('Content-Type', 'image/png');
        fs.createReadStream(filePath).pipe(res);
    });

    // Resolve the best video file for a scene: the merged `scene.mp4` (result of
    // group concat for the player) takes priority; otherwise the first group
    // file `_gN.mp4` (scene mid-generation). Returns null when none exists.
    function resolveSceneVideoFile(buildDir, bookId, chapterId, sceneId) {
        const prefix = `${bookId}_${chapterId}_${sceneId}`;
        const mergedPath = path.join(buildDir, `${prefix}.mp4`);
        if (fs.existsSync(mergedPath)) {
            log(`[VIDEO-SERVE] ${bookId}/${chapterId}/${sceneId}: merged scene.mp4 → ${path.basename(mergedPath)}`);
            return mergedPath;
        }
        let files = [];
        try {
            files = fs.readdirSync(buildDir).filter(f =>
                f.startsWith(prefix) && f.endsWith('.mp4') && f !== `${prefix}.mp4`
            );
        } catch (_) {}
        if (files.length === 0) {
            log(`[VIDEO-SERVE] ${bookId}/${chapterId}/${sceneId}: no video files found`);
            return null;
        }
        files.sort((a, b) => {
            const na = parseInt((a.match(/_g(\d+)/) || [0, 0])[1], 10);
            const nb = parseInt((b.match(/_g(\d+)/) || [0, 0])[1], 10);
            return na - nb;
        });
        log(`[VIDEO-SERVE] ${bookId}/${chapterId}/${sceneId}: no merged file, serving first group → ${files[0]}`);
        return path.join(buildDir, files[0]);
    }

    app.get('/api/v1/chunk/:id/video', async (req, res) => {
        try {
            const c = await getChunk(req.params.id);
            if (!c) return res.status(404).json({ error: 'chunk not found' });
            if (await rejectIfChunkBookDenied(req, res, c.book_id)) return;
            const dir = path.join(OUTPUT_DIR, c.build_id);
            if (!fs.existsSync(dir)) return res.status(404).json({ error: 'build directory not found' });
            const filePath = resolveSceneVideoFile(dir, c.book_id, c.chapter_id, c.scene_id);
            if (!filePath) return res.status(404).json({ error: 'video not ready' });
            streamFileWithRange(req, res, filePath, 'video/mp4');
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // SCENE AUDIO
    // ======================================================
    /**
     * Stream a media file with HTTP Range support (206 Partial Content).
     * The browser <audio>/<video> engine seeks (currentTime = X) by issuing
     * Range requests; without 206 handling the seek silently fails and playback
     * restarts from position 0. This broke the Edit-page waveform range playback
     * (unit start→end markers) and the Play-page seek bar — Android's MediaPlayer
     * buffers the whole file and seeks internally, so it never hit this.
     */
    function streamFileWithRange(req, res, filePath, contentType) {
        const stat = fs.statSync(filePath);
        const fileSize = stat.size;
        // Content is served per build_id URL, but the backend REGENERATES files
        // IN PLACE (same build_id → same URL, new bytes). So responses are
        // cacheable but MUST be revalidated: ETag/Last-Modified + If-None-Match /
        // If-Range let a browser media cache serve repeat plays and resume
        // buffered ranges WITHOUT re-downloading the whole 20-43 MB file, while a
        // regenerated file still propagates (changed ETag → full fresh 200).
        const etag = `"${fileSize.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
        const lastModified = stat.mtime.toUTCString();
        const lastModifiedSec = Math.floor(stat.mtimeMs / 1000) * 1000;
        res.setHeader('Content-Type', contentType);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('ETag', etag);
        res.setHeader('Last-Modified', lastModified);
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');

        const range = req.headers.range;
        if (!range) {
            // Conditional GET: 304 when the cached entity is still current.
            const inm = (req.headers['if-none-match'] || '').split(',').map((s) => s.trim());
            if (inm.includes(etag) || inm.includes('*')) {
                res.status(304).end();
                return;
            }
            const ims = req.headers['if-modified-since'];
            if (ims && Date.parse(ims) >= lastModifiedSec) {
                res.status(304).end();
                return;
            }
            res.setHeader('Content-Length', fileSize);
            fs.createReadStream(filePath).pipe(res);
            return;
        }

        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) {
            res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
            return;
        }
        let start = match[1] ? parseInt(match[1], 10) : 0;
        let end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
        if (match[1] === '' && match[2] !== '') {
            // Suffix range "bytes=-N" — last N bytes.
            start = Math.max(0, fileSize - parseInt(match[2], 10));
            end = fileSize - 1;
        }
        if (start >= fileSize || start > end) {
            res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
            return;
        }
        // If-Range: the client's cached entity must still match ours (ETag or
        // date) — otherwise the Range is ignored and the full 200 entity is
        // served. Media players send this to resume buffered ranges without
        // re-downloading; a regenerated file gets the full fresh body.
        let ifRangeOk = true;
        const ifRange = req.headers['if-range'];
        if (ifRange) {
            if (ifRange.startsWith('"') || ifRange.startsWith('W/')) {
                ifRangeOk = ifRange === etag;
            } else {
                ifRangeOk = Date.parse(ifRange) === lastModifiedSec;
            }
        }
        if (!ifRangeOk) {
            res.setHeader('Content-Length', fileSize);
            fs.createReadStream(filePath).pipe(res);
            return;
        }
        end = Math.min(end, fileSize - 1);
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', end - start + 1);
        fs.createReadStream(filePath, { start, end }).pipe(res);
    }

    app.get('/api/v1/scene/:bookId/:chapterId/:sceneId/audio', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const buildId = getEffectiveBuildId(bookId, req.query.build_id, log);
            const audioPath = path.join(OUTPUT_DIR, buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);
            if (!fs.existsSync(audioPath)) return res.status(404).json({ error: 'audio not ready' });
            streamFileWithRange(req, res, audioPath, 'audio/mpeg');
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
                        // Note: start_ms=0 maps to null here, but unlike the
                        // timings GET route this is self-corrected by the pgMap
                        // merge below (rows with end_ms>0 override the nulls).
                        start_ms: r.start_ms != null && (Number(r.start_ms) || 0) > 0 ? Number(r.start_ms) : null,
                        end_ms: r.end_ms != null && (Number(r.end_ms) || 0) > 0 ? Number(r.end_ms) : null,
                    }));
                }
            } catch (dbErr) {
                console.warn('[SCENE STORYBOARD] PG read failed, falling back to book data:', dbErr.message);
            }

            if (ius.length === 0) {
                try {
                    const b = playerModel.loadBook(bookId);
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

            // Per-unit positions on the WHOLE-SCENE VIDEO timeline. Players seek
            // the scene video by video_start_ms (its real timeline, measured from
            // the merged/group files) instead of start_ms (the audio timeline) —
            // on LTX builds the video drifts ahead of audio, and seeking to
            // start_ms lands in the previous unit. Model-agnostic: on exact-timed
            // builds (e.g. Minimax H3) the measurement equals start_ms and is a
            // no-op. Best-effort: failures leave video_start_ms absent.
            try {
                await videoTimeline.computeVideoStartMs(ius, buildId, bookId, chapterId, sceneId, OUTPUT_DIR);
            } catch (tlErr) {
                console.warn(`[SCENE STORYBOARD] video_start_ms failed for ${bookId}/${chapterId}/${sceneId}: ${tlErr.message}`);
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
            const filePath = resolveSceneVideoFile(dir, bookId, chapterId, sceneId);
            if (!filePath) return res.status(404).json({ error: 'video not ready' });
            streamFileWithRange(req, res, filePath, 'video/mp4');
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

            // Content version of the scene video: the file mtime (same source as
            // the ETag in streamFileWithRange). build_id is immutable per book and
            // regeneration replaces files IN PLACE (same URL, new bytes), so a
            // client-side video cache keyed by URL alone would serve STALE video
            // after a regeneration. The Android player appends this as ?v= to the
            // video URL → the cache key changes exactly when the content changes
            // (no wholesale cache wipe). 0 = no video file.
            let videoVersion = 0;
            if (videoReady) {
                try {
                    videoVersion = Math.floor(fs.statSync(videoPath).mtimeMs);
                } catch {}
            }

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
                const b = playerModel.loadBook(bookId);
                if (b) {
                    for (const ch of b.chapters || []) {
                        if (ch.chapter_id !== chapterId) continue;
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
                video_version: videoVersion,
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
                        // start_ms=0 is VALID — the first unit of every scene starts
                        // at 0. Treating it as null made needsCompute true on every
                        // GET, and the recompute-all path (5a401fb) then wiped the
                        // user-saved timings right after PUT. Rows that were never
                        // timed are 0/0 and still fail the end>start check below.
                        start_ms: r.start_ms != null ? Number(r.start_ms) : null,
                        end_ms: r.end_ms != null ? Number(r.end_ms) : null,
                        estimated_duration_sec: r.estimated_duration_sec || 0,
                        text_proportion: r.text_proportion || 0,
                    }));
                }
            } catch (dbErr) {
                console.warn('[TIMINGS] PG read failed, falling back to book data:', dbErr.message);
            }

            if (ius.length === 0) {
                try {
                    const b = playerModel.loadBook(bookId);
                    if (b) {
                        for (const ch of b.chapters || []) {
                            if (ch.chapter_id !== chapterId) continue;
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
                const preferredStart = unit.start_ms ?? 0;
                const preferredEnd = unit.end_ms ?? 0;
                let endMs = Math.max(preferredStart + 50, preferredEnd);
                if (sceneDurationMs > 0 && endMs > sceneDurationMs) endMs = sceneDurationMs;
                // Gapless boundary model: the handles are SHARED boundaries — the
                // right handle of a unit is the left handle of the next one. When a
                // unit would start AFTER the previous unit ended (a gap — e.g. the
                // user dragged the shared boundary earlier and the next unit's start
                // didn't follow), pull the start back to the previous unit's end so
                // the timeline stays gapless and the next unit's left handle tracks
                // the drag. Net effect: every non-first unit starts exactly where
                // the previous one ends, so a client that reports a later start for
                // a non-first unit (didn't cascade a shared boundary) is corrected
                // server-side. cursorMs === 0 marks the FIRST unit — its left edge
                // may intentionally sit after 0 (lead-in silence), so its preferred
                // start is kept.
                let startMs = Math.max(preferredStart, cursorMs);
                if (cursorMs > 0 && preferredStart > cursorMs) {
                    startMs = cursorMs;
                }
                // Clamp the start so the interval is never zero-width or inverted
                // (e.g. a handle dragged to the very end of the audio). A saved
                // row with start >= end would make the next GET treat the whole
                // scene as needsCompute and recompute ALL timings from text
                // proportions — discarding the user's edits.
                startMs = Math.min(startMs, Math.max(0, endMs - 50));
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
    app.post('/gpu/task/result', requireHubCallbackAuth, async (req, res) => {
        try {
            const jobSchema = require('../runtime/job-schema');
            const { job_id, result_base64, build_id, dispatch_id, protocol_version, worker_id, workspace_id } = req.body || {};
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

            // PW-2: re-verify job→book→workspace (forwarded identity is
            // audit-only; the backend never trusts it for authorization).
            const wsCheck = await verifyCallbackWorkspace(parsed.bookId, workspace_id || null);
            if (!wsCheck.ok) {
                log(`[GPU RESULT] Rejected ${job_id}: ${wsCheck.reason} (forwarded_ws=${workspace_id || 'null'} book_ws=${wsCheck.workspaceId || 'null'})`);
                return res.status(403).json({ error: wsCheck.reason });
            }
            await persistTaskClaim(parsed.bookId, parsed.chapterId, parsed.sceneId, stage, worker_id || null, wsCheck.workspaceId);

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
                // VIDEO: то же самое — группы сцены приходят последовательно, и после
                // re-dispatch поздние группы от старого dispatch должны приниматься,
                // пока video-orch в WAITING_CHUNKS/MERGING.
                if ((stage === 'audio' || stage === 'video') && identity.reason === 'stale_dispatch') {
                    const orchMod = stage === 'audio' ? require('../services/audio-orchestrator') : require('../services/video-orchestrator');
                    const orchState = await orchMod.getState(redis, parsed.bookId, parsed.chapterId, parsed.sceneId);
                    if (orchState && (orchState.phase === orchMod.PHASES.WAITING_CHUNKS || orchState.phase === orchMod.PHASES.MERGING)) {
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
    app.post('/gpu/task/error', requireHubCallbackAuth, async (req, res) => {
        try {
            const jobSchema = require('../runtime/job-schema');
            const { job_id, build_id, reason, dispatch_id, protocol_version, worker_id, workspace_id } = req.body || {};
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

            // PW-2: re-verify job→book→workspace (forwarded identity is
            // audit-only; the backend never trusts it for authorization).
            const wsCheck = await verifyCallbackWorkspace(bookId, workspace_id || null);
            if (!wsCheck.ok) {
                log(`[GPU ERROR] Rejected ${job_id}: ${wsCheck.reason} (forwarded_ws=${workspace_id || 'null'} book_ws=${wsCheck.workspaceId || 'null'})`);
                return res.status(403).json({ error: wsCheck.reason });
            }
            await persistTaskClaim(bookId, chapterId, sceneId, stage, worker_id || null, wsCheck.workspaceId);

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

            // F2: raw audioOrch.setFailed removed — orchestrator.failStage handles audio-orch sync
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
