// ======================================================
// Animastor Backend - v1.0.0 (MODULAR)
// ======================================================
//
// Description:
//   Модульный бэкенд — оркестратор загружает сервисы и монтирует
//   маршруты из отдельных файлов в backend/src/routes/* и services/*.
//
// ======================================================

const path = require('path');

// ======================================================
// MODULE IMPORTS
// ======================================================
const state = require('./state');
const audio = require('./audio');
const image = require('./image');
const video = require('./video');
const { resumeIncompleteSessions } = require('./startup-resume');
const orchestrator = require('./orchestration');
const wfManager = require('./services/workflow-manager');
const journal = require('./orchestration/event-journal');
const storage = require('./storage');
const runtime = require('./runtime');
const activeScenes = require('./runtime/active-scenes-index');
const book = require('./book');
const config = require('./config/runtime-config');
const txtImporter = require('./services/txt-importer');
const lazyBook = require('./book/lazy-book');
const genSessionRepo = require('./storage/postgres/repositories/gen-session-repo');
const bookSourceRepo = require('./storage/postgres/repositories/book-source-repo');
const placeholderAudio = require('./services/placeholder-audio');
const utils = require('./helpers/utils.cjs');

const filesystem = storage.filesystem;
const layerConfig = storage.layerConfig;
const genScope = storage.genScope;


// ======================================================
// [02] CORE INIT
// ======================================================
const Redis = require('ioredis');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const { PORT = 3000, HUB_URL = 'https://animastor.in/gpu', BUILD_TTL_HOURS = 48 } = process.env;
const crypto = require('crypto');

const redis = new Redis({ host: 'redis', port: 6379 });
const app = express();

// Security headers
const helmet = require('helmet');
app.use(helmet());

// Rate limiting
const rateLimit = require('express-rate-limit');
app.use('/api/', rateLimit({
    windowMs: 60_000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
}));

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Request ID + HTTP logging
app.use((req, res, next) => {
    req.requestId = crypto.randomUUID().slice(0, 8);
    const start = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - start;
        const size = res.get('Content-Length') || '-';
        console.log(`[HTTP] [${req.requestId}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms, ${size}B)`);
    });
    next();
});

const OUTPUT_DIR = config.OUTPUT_DIR;

// ======================================================
// HELPERS
// ======================================================
const { log, warn } = utils;

// Redis helpers (factory, initialized with redis instance)
const {
    saveChunk, getChunk, getAllChunks, getBookWindowStatus,
    detectAvailableMode, saveIURegistry,
    recoverChunksFromDisk, recoverAllBooksFromDisk,
    cleanBookRedisKeys,
} = require('./helpers/redis-helpers.cjs')(redis);

// ======================================================
// SERVICES (factory pattern)
// ======================================================
const cleanupService = require('./services/cleanup-service.cjs')(redis, config, { log });
const chatEngine = require('./services/chat-engine.cjs')(config);
const windowGenerator = require('./services/window-generator.cjs')({
    redis, txtImporter, genSessionRepo, state, activeScenes,
    placeholderAudio, saveChunk, config,
});

const iuRepo = require('./storage/postgres/repositories/iu-repo');
const sceneAssetsRepo = require('./storage/postgres/repositories/scene-assets-repo');
const { computeWaveform } = require('./services/waveform-service');

const taskHandlerDeps = {
    audio, image, video, state, book, orchestrator, activeScenes, placeholderAudio,
    cleanupService, utils, iuRepo, saveIURegistry,
    saveChunk, getChunk,
};
const taskHandler = require('./services/task-handler.cjs')(redis, config, taskHandlerDeps);

const bookDiffDeps = { state, book, layerConfig, genScope, activeScenes, getChunk, saveChunk, utils };
const bookDiff = require('./services/book-diff.cjs')(redis, config, bookDiffDeps);

// ======================================================
// SERVICES — start periodic tasks
// ======================================================
// T6: Periodic lock cleanup moved into reconcileCycle (reconciliation-engine).
// cleanupService is still used for build/file operations.
// audio-recovery.cjs logic merged into reconcileCycle Phase A.

// ======================================================
// ROUTES (each registers endpoints on app)
// ======================================================
const routeDeps = {
    config, state, audio, image, video, book, orchestrator, storage,
    runtime, activeScenes, layerConfig, genScope, placeholderAudio,
    txtImporter, lazyBook, genSessionRepo, bookSourceRepo,
    utils, saveChunk, getChunk, getAllChunks, getBookWindowStatus,
    detectAvailableMode, recoverChunksFromDisk, recoverAllBooksFromDisk,
    cleanBookRedisKeys,
    cleanupService, taskHandler, bookDiff, windowGenerator, chatEngine,
    iuRepo, computeWaveform, journal,
    wfManager, sceneAssetsRepo,
};

require('./routes/book-routes.cjs')(app, redis, { ...routeDeps, taskHandler, bookDiff, windowGenerator });
require('./routes/generation-routes.cjs')(app, redis, { ...routeDeps, taskHandler, iuRepo, computeWaveform });
require('./routes/ai-routes.cjs')(app, redis, {
    ...routeDeps, taskHandler, bookDiff, chatEngine,
    iuRepo, genSessionRepo, lazyBook, txtImporter, bookSourceRepo,
});
require('./routes/debug-routes.cjs')(app, redis, {
    ...routeDeps, taskHandler, bookDiff, iuRepo, computeWaveform, journal,
});

// Workflow Manager routes
require('./routes/connector-routes.cjs')(app, redis, routeDeps);
require('./routes/workflow-routes.cjs')(app, redis, routeDeps);

// ======================================================
// PROMETHEUS METRICS
// ======================================================
const prometheus = require('./metrics/prometheus');

app.get('/metrics', async (req, res) => {
    try {
        const metrics = await prometheus.getMetricsContent();
        res.set('Content-Type', prometheus.getContentType());
        res.end(metrics);
    } catch (err) {
        console.error('[METRICS] Error:', err.message);
        res.status(500).send('Internal Server Error');
    }
});

// ======================================================
// HEALTH ENDPOINT (S3.2, 2026-07-19)
// ======================================================
// Lightweight liveness probe. No auth — public endpoint.
// Returns 200 if runtime loop is running AND Redis responds to PING,
// 503 otherwise. Used by container orchestrators (docker healthcheck,
// k8s liveness probe) to decide whether to restart the container.

let _isShuttingDown = false;

app.get('/health', async (req, res) => {
    const ts = Date.now();
    if (_isShuttingDown) {
        return res.status(503).json({
            status: 'shutting_down',
            loop: false,
            redis: 'unknown',
            ts
        });
    }

    let redisStatus = 'PONG';
    let loopRunning = false;
    try {
        const pong = await redis.ping();
        redisStatus = pong === 'PONG' ? 'PONG' : 'DOWN';
    } catch (err) {
        redisStatus = 'DOWN';
    }
    try {
        loopRunning = runtime.loop.isRunning();
    } catch (_) {
        loopRunning = false;
    }

    const ok = redisStatus === 'PONG' && loopRunning;
    res.status(ok ? 200 : 503).json({
        status: ok ? 'ok' : 'degraded',
        loop: loopRunning,
        redis: redisStatus,
        ts
    });
});

// ======================================================
// [14] SERVER STARTUP
// ======================================================

async function startServer() {
    // Load workflow templates (connectors are required — failure is fatal)
    try {
        const wfLoader = require('./workflows/workflow-loader');
        await wfLoader.loadWorkflows();
        log('[STARTUP] Workflows loaded');
    } catch (wfErr) {
        console.error('[FATAL] Workflow loading failed:', wfErr.message);
        console.error('[FATAL] Every workflow must have a matching connector in /data/connectors/.');
        console.error('[FATAL] Starting the server without valid workflows would cause silent failures.');
        process.exit(1);
    }

    // Initialize PostgreSQL storage
    try {
        await storage.postgres.initialize();
        log('[STARTUP] PostgreSQL initialized');
    } catch (pgErr) {
        console.error('[STARTUP] PostgreSQL initialization failed (non-fatal):', pgErr.message);
    }

    // Start server
    const server = app.listen(PORT, () => {
        log(`[STARTUP] Backend server running on port ${PORT}`);
        log(`[STARTUP] GPU HUB URL: ${HUB_URL}`);
        log(`[STARTUP] Output directory: ${OUTPUT_DIR}`);

        // Post-listen initialization
        try {
            runtime.loop.start(redis);
            log('[STARTUP] Runtime loop started');
        } catch (loopErr) {
            console.warn('[STARTUP] Runtime loop start failed:', loopErr.message);
        }

        // T6: Единый reconciliation-цикл (заменяет startup-recovery, audio-recovery, cleanup-service)
        setImmediate(async () => {
            try {
                const reconcileEngine = require('./runtime/reconciliation-engine');
                const reconcileDeps = {
                    postgres: storage.postgres,
                    orchestrator,
                    taskHandler,
                    state,
                    recoverAllBooksFromDisk,
                    resumeIncompleteSessions,
                    runBackgroundWindowGeneration: windowGenerator.runBackgroundWindowGeneration,
                };

                // T7: Передаём deps в runtime loop для периодического reconcileCycle
                runtime.loop.setReconcileDeps(reconcileDeps);

                const recResult = await reconcileEngine.reconcileCycle(redis, reconcileDeps, {
                    startup: true,
                });
                log(`[STARTUP] Reconcile cycle: ${recResult.phases.join(', ')}`);
                if (recResult.summary.errors.length > 0) {
                    console.warn('[STARTUP] Reconcile errors:', recResult.summary.errors.join('; '));
                }
            } catch (recErr) {
                console.warn('[STARTUP] Reconcile cycle failed:', recErr.message);
            }
        });

        // Reset stale active counters and reconcile
        setImmediate(async () => {
            try {
                // Force-reset active counters to 0 on startup. These are runtime
                // optimizations (backpressure), not source of truth — leases are.
                // Prevents stale counters from previous sessions keeping pulse alive.
                await redis.del('animastor:runtime:active-audio');
                await redis.del('animastor:runtime:active-image');
                await redis.del('animastor:runtime:active-video');
                log('[STARTUP] Stale active counters reset to 0');

                // Clean up stale dispatch leases to prevent DISPATCH_SKIPPED_DUPLICATE loops
                // Leases that survive a restart are orphans (no worker will complete them).
                try {
                    let cursor = '0';
                    let cleaned = 0;
                    do {
                        const scan = await redis.scan(cursor, 'MATCH', 'animastor:dispatch-lease:*', 'COUNT', 200);
                        cursor = scan[0];
                        if (scan[1].length > 0) {
                            await redis.del(scan[1]);
                            cleaned += scan[1].length;
                        }
                    } while (cursor !== '0');
                    if (cleaned > 0) log(`[STARTUP] Cleared ${cleaned} stale dispatch leases`);
                } catch (leaseErr) {
                    warn(`[STARTUP] Failed to clear stale leases: ${leaseErr.message}`);
                }

                const reconcileCounters = require('./runtime/counter-reconciliation');
                await reconcileCounters.reconcileCounters(redis);
                log('[STARTUP] Counter reconciliation complete');


            } catch (cErr) {
                console.warn('[STARTUP] Counter reconciliation failed:', cErr.message);
            }
        });
    });

    // Graceful shutdown (S3.1, 2026-07-19)
    // SIGTERM  — Kubernetes/docker stop.  Cancel dispatches, stop loop,
    //            close HTTP server, close Redis & PG. Hard timeout 10s.
    // SIGINT   — Ctrl+C in dev.  Same path.
    // S2UP:    — uncaught exception.  Try to log + exit non-zero.
    async function gracefulShutdown(signal) {
        if (_isShuttingDown) return;
        _isShuttingDown = true;
        log(`[SHUTDOWN] ${signal} received, shutting down gracefully...`);

        const HARD_TIMEOUT_MS = 10000;
        const hardExit = setTimeout(() => {
            console.error('[SHUTDOWN] Hard timeout — forcing exit');
            process.exit(1);
        }, HARD_TIMEOUT_MS);
        hardExit.unref();

        try {
            // 1. Stop runtime loop (scheduler + reconcile timers)
            try {
                runtime.loop.stop();
                log('[SHUTDOWN] Runtime loop stopped');
            } catch (loopErr) {
                console.warn(`[SHUTDOWN] Runtime loop stop failed: ${loopErr.message}`);
            }

            // 2. Cancel active dispatches so leases/quota are released cleanly
            // (instead of waiting for TTL). Stale callbacks after this will be
            // rejected by verifyDispatchIdentity.
            try {
                const dispatchEngine = require('./runtime/dispatch-engine');
                const leases = await dispatchEngine.getActiveLeases(redis);
                for (const l of leases) {
                    if (!l.scene) continue;
                    try {
                        await dispatchEngine.cancelActiveDispatch(
                            redis, l.scene.bookId, l.scene.chapterId,
                            l.scene.sceneId, l.scene.stage, 'graceful_shutdown'
                        );
                        log(`[SHUTDOWN] Cancelled: ${l.scene.bookId}/${l.scene.chapterId}/${l.scene.sceneId}:${l.scene.stage}`);
                    } catch (cancelErr) {
                        console.warn(`[SHUTDOWN] Cancel failed: ${cancelErr.message}`);
                    }
                }
                log(`[SHUTDOWN] Cancelled ${leases.length} active dispatches`);
            } catch (leaseErr) {
                console.warn(`[SHUTDOWN] Lease inspection failed: ${leaseErr.message}`);
            }

            // 3. Stop accepting new HTTP connections
            try {
                await new Promise((resolve) => server.close(() => {
                    log('[SHUTDOWN] HTTP server closed');
                    resolve();
                }));
            } catch (_) {}

            // 4. Close Redis & PG pools
            try { await redis.quit(); log('[SHUTDOWN] Redis closed'); } catch (_) {}
            try { await storage.postgres.closePool(); log('[SHUTDOWN] PostgreSQL closed'); } catch (_) {}

            log('[SHUTDOWN] Goodbye');
            clearTimeout(hardExit);
            process.exit(0);
        } catch (shutdownErr) {
            console.error('[SHUTDOWN] Error during shutdown:', shutdownErr.message);
            clearTimeout(hardExit);
            process.exit(1);
        }
    }

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
}

startServer().catch(err => {
    console.error('[FATAL] Server startup failed:', err.message);
    process.exit(1);
});

// ======================================================
// EXPORTS (for testing)
// ======================================================
module.exports = { app, redis, config, state, book, audio, image, video, storage, runtime };
