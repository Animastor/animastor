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
const workflows = require('./workflows');
const { resumeIncompleteSessions } = require('./startup-resume');
const orchestrator = require('./orchestration');
const journal = require('./orchestration/event-journal');
const storage = require('./storage');
const runtime = require('./runtime');
const activeScenes = require('./runtime/active-scenes-index');
const book = require('./book');
const config = require('./config/runtime-config');
const aiLoader = require('./services/ai-loader');
const txtImporter = require('./services/txt-importer');
const lazyBook = require('./book/lazy-book');
const genSessionRepo = require('./storage/postgres/repositories/gen-session-repo');
const bookSourceRepo = require('./storage/postgres/repositories/book-source-repo');
const placeholderAudio = require('./services/placeholder-audio');
const utils = require('./helpers/utils.cjs');

const filesystem = storage.filesystem;
const layerConfig = storage.layerConfig;
const genScope = storage.genScope;

const SCENE_STATE_KEY_PREFIX = state.SCENE_STATE_KEY_PREFIX;
const SCENE_TRANSITION_LOCK_PREFIX = state.SCENE_TRANSITION_LOCK_PREFIX;
const SCENE_TRANSITION_LOCK_TTL = state.SCENE_TRANSITION_LOCK_TTL || 15;
const SCENE_STUCK_THRESHOLDS = config.STUCK_THRESHOLDS;

// ======================================================
// [02] CORE INIT
// ======================================================
const Redis = require('ioredis');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const fetch = global.fetch || require('node-fetch');

const { PORT = 3000, HUB_URL = 'https://animastor.in/gpu', BUILD_TTL_HOURS = 48 } = process.env;

const redis = new Redis({ host: 'redis', port: 6379 });
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const OUTPUT_DIR = config.OUTPUT_DIR;

// ======================================================
// STATE WRAPPERS (inject global redis)
// ======================================================
const transitionSceneState = (bookId, chapterId, sceneId, newState) =>
    state.transitionSceneState(redis, bookId, chapterId, sceneId, newState);
const sceneHeartbeat = (bookId, chapterId, sceneId) =>
    state.sceneHeartbeat(redis, bookId, chapterId, sceneId);
const startSceneHeartbeatTimer = (bookId, chapterId, sceneId, intervalMs) =>
    state.startSceneHeartbeatTimer(redis, bookId, chapterId, sceneId, intervalMs);
const stopSceneHeartbeatTimer = (bookId, chapterId, sceneId) =>
    state.stopSceneHeartbeatTimer(bookId, chapterId, sceneId);
const getSceneState = (bookId, chapterId, sceneId) =>
    state.getSceneState(redis, bookId, chapterId, sceneId);
const isSceneAudioReady = (buildId, bookId, chapterId, sceneId) =>
    audio.isSceneAudioReady(buildId, bookId, chapterId, sceneId);

// ======================================================
// HELPERS
// ======================================================
const { log, pad, parseChunkId, collectScenes, findSceneRuntimeData, buildSegments } = utils;

// Redis helpers (factory, initialized with redis instance)
const {
    saveChunk, getChunk, getAllChunks, getBookWindowStatus,
    detectAvailableMode, saveIURegistry,
    recoverChunksFromDisk, recoverAllBooksFromDisk,
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
const { computeWaveform } = require('./services/waveform-service');

const taskHandlerDeps = {
    audio, image, video, state, book, orchestrator, activeScenes, placeholderAudio,
    cleanupService, utils, iuRepo, saveIURegistry,
    saveChunk, getChunk,
};
const taskHandler = require('./services/task-handler.cjs')(redis, config, taskHandlerDeps);

const bookDiffDeps = { state, book, layerConfig, genScope, activeScenes, getChunk, saveChunk, utils };
const bookDiff = require('./services/book-diff.cjs')(redis, config, bookDiffDeps);

const audioRecoveryDeps = {
    audio, image, state, book, orchestrator, taskHandler,
    getChunk, saveChunk, saveIURegistry, utils,
};
const audioRecovery = require('./services/audio-recovery.cjs')(redis, config, audioRecoveryDeps);

// ======================================================
// SERVICES — start periodic tasks
// ======================================================
cleanupService.startCleanupInterval();
audioRecovery.startRecoveryInterval();

// ======================================================
// ROUTES (each registers endpoints on app)
// ======================================================
const routeDeps = {
    config, state, audio, image, video, book, orchestrator, storage,
    runtime, activeScenes, layerConfig, genScope, placeholderAudio,
    txtImporter, lazyBook, genSessionRepo, bookSourceRepo,
    utils, saveChunk, getChunk, getAllChunks, getBookWindowStatus,
    detectAvailableMode, recoverChunksFromDisk, recoverAllBooksFromDisk,
    cleanupService, taskHandler, bookDiff, windowGenerator, chatEngine,
    iuRepo, computeWaveform, journal,
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

// ======================================================
// [14] SERVER STARTUP
// ======================================================

async function startServer() {
    // Load workflow templates
    try {
        const wfLoader = require('./workflows/workflow-loader');
        await wfLoader.loadWorkflows();
        log('[STARTUP] Workflows loaded');
    } catch (wfErr) {
        console.warn('[STARTUP] Workflow loading failed (non-fatal):', wfErr.message);
    }

    // Initialize PostgreSQL storage
    try {
        await storage.postgres.initialize();
        log('[STARTUP] PostgreSQL initialized');
    } catch (pgErr) {
        console.error('[STARTUP] PostgreSQL initialization failed:', pgErr.message);
        process.exit(1);
    }

    // Resume incomplete sessions
    try {
        await resumeIncompleteSessions(redis);
        log('[STARTUP] Incomplete sessions resumed');
    } catch (resumeErr) {
        console.warn('[STARTUP] Session resume failed (non-fatal):', resumeErr.message);
    }

    // Start server
    app.listen(PORT, () => {
        log(`[STARTUP] Backend server running on port ${PORT}`);
        log(`[STARTUP] GPU HUB URL: ${HUB_URL}`);
        log(`[STARTUP] Output directory: ${OUTPUT_DIR}`);

        // Post-listen initialization
        try {
            runtime.loop.start();
            log('[STARTUP] Runtime loop started');
        } catch (loopErr) {
            console.warn('[STARTUP] Runtime loop start failed:', loopErr.message);
        }

        // Recover books from disk
        setImmediate(async () => {
            try {
                await recoverAllBooksFromDisk();
                log('[STARTUP] Disk recovery complete');
            } catch (recErr) {
                console.warn('[STARTUP] Disk recovery failed:', recErr.message);
            }
        });

        // Reconcile counters
        setImmediate(async () => {
            try {
                const reconcileCounters = require('./runtime/counter-reconciliation');
                await reconcileCounters.reconcileCounters(redis);
                log('[STARTUP] Counter reconciliation complete');
            } catch (cErr) {
                console.warn('[STARTUP] Counter reconciliation failed:', cErr.message);
            }
        });
    });
}

startServer().catch(err => {
    console.error('[FATAL] Server startup failed:', err.message);
    process.exit(1);
});

// ======================================================
// EXPORTS (for testing)
// ======================================================
module.exports = { app, redis, config, state, book, audio, image, video, storage, runtime };
