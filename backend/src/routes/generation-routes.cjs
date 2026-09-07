// ======================================================
// ANIMASTOR BACKEND — GENERATION ROUTES
// ======================================================
// Generation / import / worker contours ONLY:
//   /api/v1/generate, /api/v1/worker/*, /api/v1/book/:id/progress-stream,
//   /gpu/task/result|error (GPU Hub callbacks).
//
// The playback (Player) HTTP contour — scene/chunk media serving, scene
// data, iu/preview, playback queue — was physically split into
// routes/player/ (Player route split, see
// docs/architecture/PLAYER_ROUTE_SPLIT_CHECKLIST.md). No playback handlers
// remain here (guarded by tests/architecture/player-route-split.test.js).
//
// Usage:
//   require('./routes/generation-routes.cjs')(app, redis, deps);

const multer = require('multer');
const authContextMiddleware = require('../middleware/auth-context');

module.exports = function(app, redis, deps) {
    const {
        config, state, audio, image, video, book, orchestrator, storage,
        runtime, activeScenes, layerConfig, genScope, placeholderAudio,
        utils, saveChunk, getChunk, getAllChunks, getBookWindowStatus,
        detectAvailableMode, recoverChunksFromDisk, recoverAllBooksFromDisk,
        cleanupService, iuRepo, computeWaveform,
    } = deps;
    const { log } = utils;

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
