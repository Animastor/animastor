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
// S-6/S-7: GENERATION HOST PORTS — composition-root wiring
// ======================================================
// The Generation package (@animastor/generation — packages/animastor-
// generation, extracted from backend/src/generation/** in S-7) depends only
// on Generation-owned ports (generation.ports.*); the host implements them
// via the adapters below. Wired FIRST — before any generation module loads
// (default-registrations reads the config port at load time).
// Ownership: ports belong to the package, adapters to the host.
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §28–29
require('./config/generation-config-adapter').bindGenerationConfig();
require('@animastor/generation').ports.dispatchTransport.setDispatchTransport({
    dispatch: (taskSpec) => require('./runtime/gpu-dispatcher').sendUnified(taskSpec),
});
require('@animastor/generation').ports.profileStore.setProfileStore({
    getAssemblyProfile: require('./services/ai-loader').getAssemblyProfile,
});
require('@animastor/generation').ports.bookData.setBookData({
    collectSceneUnits: require('./book').collectSceneUnits,
    tokensToString: require('./book/lazy-book/appearance').tokensToString,
});
// O-2: PERSISTENCE PORT — runtime/orchestration persistence composition.
// The two tiers consume PG/Redis-registry/filesystem persistence ONLY
// through runtime/persistence-port; the host adapter (storage/runtime-
// persistence-adapter) owns every repository, SQL string and table and is
// bound here, before any runtime module loads.
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.9
require('./runtime/persistence-port').setPersistencePort(
    require('./storage/runtime-persistence-adapter')
);
// O-3: SCENE DATA PORT — runtime/orchestration scene-content composition.
// The two tiers consume book/scene reads ONLY through runtime/scene-data-port;
// the host adapter (storage/scene-data-adapter) owns the Book Model facade
// (backend/src/book → @animastor/vbook-runtime) and is bound here, before any
// runtime module loads.
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.11
require('./runtime/scene-data-port').setSceneDataPort(
    require('./storage/scene-data-adapter')
);
// O-4: PLACEHOLDER AUDIO PORT — runtime/orchestration placeholder-audio
// composition. The two tiers consume the three placeholder-audio operations
// they use ONLY through runtime/placeholder-audio-port; the host adapter
// (storage/placeholder-audio-adapter) owns the ffmpeg/fs/scene_assets
// service (services/placeholder-audio) and is bound here, before any
// runtime/orchestration module loads.
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.7 (O-P7)
require('./runtime/placeholder-audio-port').setPlaceholderAudioPort(
    require('./storage/placeholder-audio-adapter')
);
// O-5: PROGRESS EVENTS PORT — runtime/orchestration progress-observer
// composition. The two tiers consume progress events (SSE layer-advance
// pub/sub) and selective-task reads ONLY through runtime/progress-events-
// port; the host adapter (storage/progress-events-adapter) owns the Redis
// progress host services (services/progress-pubsub, services/generation-
// progress) and is bound here, before any runtime/orchestration module
// loads.
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.7 (O-P4)
require('./runtime/progress-events-port').setProgressEventsPort(
    require('./storage/progress-events-adapter')
);
// O-7: AUDIO FSM PORT — runtime/orchestration audio-FSM composition. The
// two tiers drive the audio scene FSM (phase transitions, chunk-completeness
// merge drive, stall watchdog, startup recovery) ONLY through
// runtime/audio-fsm-port; the host adapter (storage/audio-fsm-adapter)
// owns the audio-orchestrator host service (Redis key grammar, state
// envelope, transition map, merge/hub-dedup logic) and is bound here,
// before any runtime/orchestration module loads. The video FSM stays a
// separate seam (O-8 below — never merged into this port).
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.24
require('./runtime/audio-fsm-port').setAudioFsmPort(
    require('./storage/audio-fsm-adapter')
);
// O-8: VIDEO FSM PORT — runtime/orchestration video-FSM composition. The
// two tiers drive the video scene FSM (group dispatch init, cache-hit
// group marking, stall watchdog, invariant checks, startup recovery) ONLY
// through runtime/video-fsm-port; the host adapter (storage/video-fsm-
// adapter) owns the video-orchestrator host service (Redis key grammar,
// state envelope, transition map, group-file validation, merge/source-cap
// pipeline, hub-dedup cleanup) and is bound here, before any
// runtime/orchestration module loads. Never merged with the audio FSM.
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.25
require('./runtime/video-fsm-port').setVideoFsmPort(
    require('./storage/video-fsm-adapter')
);
// O-9: HUB CANCEL PORT — runtime/orchestration hub-queue-cleanup
// composition. The two tiers purge cancelled dispatches from the GPU Hub
// queue ONLY through runtime/hub-cancel-port; the host adapter
// (storage/hub-cancel-adapter) owns the hub-HTTP cleanup channel
// (dispatch-engine clearHubDispatches — hub URL/API-key resolution, the
// DELETE /queue/clear endpoint shape, per-id best-effort accounting) and
// is bound here, before any runtime/orchestration module loads. Lease
// cancellation itself stays a direct dispatch-engine call (Redis domain,
// not hub HTTP).
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.26
require('./runtime/hub-cancel-port').setHubCancelPort(
    require('./storage/hub-cancel-adapter')
);
// O-10: LAYER CONFIG PORT — runtime/orchestration per-book layer-config
// composition. The two tiers read per-book layer config ONLY through
// runtime/layer-config-port; the host adapter (storage/layer-config-
// adapter) owns the layer-config host service (Redis key grammar,
// normalize/clamp pipeline, durable book.json recovery scan —
// services/layer-config) and is bound here, before any
// runtime/orchestration module loads. Tier-local RAW Redis reads of the
// same key (bespoke fallback semantics) and the routes/agent host
// consumers keep calling the service directly — host-side by design.
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.27
require('./runtime/layer-config-port').setLayerConfigPort(
    require('./storage/layer-config-adapter')
);

// ======================================================
// MODULE IMPORTS
// ======================================================
const state = require('./state');
const audio = require('./audio');
const image = require('./image');
const video = require('./video');

// S-2: Initialize media registry with default registrations.
// Must run before any module that consumes the registry (runtime, orchestration, routes).
// S-7: the default registrations live in the package (bootstrap() is the
// eager startup entry; the registry also self-bootstraps lazily on first access).
require('@animastor/generation').bootstrap();
const { resumeIncompleteSessions } = require('./startup-resume');
const orchestrator = require('./orchestration');
// S-5: runtime receives orchestration behavior (stage executor + FSM facade
// writers) ONLY through the seam registry — dependency direction is outward
// through the composition root, never a runtime→orchestration import.
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §26
require('./runtime/orchestration-seams').registerOrchestrationSeams({
    dispatchStage: orchestrator.dispatchStage,
    rollbackStageToPending: orchestrator.rollbackStageToPending,
    markDirtyScene: orchestrator.markDirtyScene,
    setScenePending: orchestrator.setScenePending,
    setSceneAllReady: orchestrator.setSceneAllReady,
    setScenePlaceholder: orchestrator.setScenePlaceholder,
});
const wfManager = require('./services/workflow-manager');
const journal = require('./state/event-journal');
const storage = require('./storage');
const runtime = require('./runtime');
const activeScenes = require('./runtime/active-scenes-index');
const book = require('./book');
const config = require('./config/runtime-config');

// ── VBook runtime package (@animastor/vbook-runtime) — composition root ──
// The VBook runtime lives in packages/animastor-vbook-runtime and must not
// read host config/env: the composition root injects the filesystem root
// (booksRoot) and the structure-detector implementation once, before any
// book operation. The live provider keeps today's read-per-call semantics
// of config.BOOKS_DIR.
// Docs: docs/03-audit/VBOOK_EXTRACTION_READINESS_AUDIT.md §2.6/§3.3,
//       docs/architecture/VBOOK_RUNTIME_RELOCATION_CHECKLIST.md
const { configureBooksRoot } = require('@animastor/vbook-runtime/books-root');
configureBooksRoot(() => config.BOOKS_DIR);
const { setStructureDetector } = require('@animastor/parser');
setStructureDetector(require('./services/structure-detector'));

const txtImporter = require('./services/txt-importer');
const lazyBook = require('./book/lazy-book');
const bookModel = require('./book/book-model.cjs');
const { createBookDeletion } = require('./services/book-deletion.cjs');
// Phase 6: Editor/Player boundaries — facades over the Canonical Book Model.
// The Player (model facade + playback HTTP contour) is physically extracted
// to packages/animastor-player (@animastor/player); the host consumes ONLY
// the package entrypoint — never package internals
// (docs/architecture/PLAYER_ROUTE_SPLIT_CHECKLIST.md, physical move COMPLETE).
// The Editor (model facade + book-editing HTTP contour) is physically
// extracted the same way to packages/animastor-editor (@animastor/editor)
// since the Phase 4 physical move
// (docs/architecture/editor-module-extraction-audit.md — Phase 4).
const { createPlayerModel, createPlayerRoutes } = require('@animastor/player');
// Editor API comes ONLY through the package root (Phase 4.1 — no deep
// imports): the model facade + the frozen-7-port seam factory.
const { createEditorModel, createEditorPorts } = require('@animastor/editor');
// Player package ports (host implementations injected into the playback
// contour — the player package must not import these directly: they carry
// generation-domain knowledge: workflows/ alignment tax, ffmpeg/ffprobe,
// auth middleware).
const videoTimeline = require('./video/video-timeline');
const authContextMiddleware = require('./middleware/auth-context');
const { computeWaveform } = require('./services/waveform-service');
const { computeIuReady } = require('./routes/book/iu-progress-utils.cjs');
const genSessionRepo = require('./storage/postgres/repositories/gen-session-repo');
const bookSourceRepo = require('./storage/postgres/repositories/book-source-repo');
// Assistant extraction: the chat-session repository is the ONLY
// ai_chat_sessions owner (its PG implementation stays host-side); the
// Assistant contour (@animastor/assistant package) and the purge flows
// reach it through ports (assistantPorts below / purgeForBook), never via
// SQL.
const chatSessionRepo = require('./storage/postgres/repositories/chat-session-repo');
// Assistant ports — the HOST adapter half of the seam (contracts live in
// the @animastor/assistant package; this module binds the concrete host
// legs: Book Model, saveBookBundle, lazyBook dir, bundle validator,
// Provider Gateway, PG chat-session repo, url-safety + shared-pool
// transports).
const { createAssistantPorts } = require('./services/assistant-ports.cjs');
// @animastor/assistant — the physically extracted Assistant contour
// (chat engine + /api/v1/ai/* HTTP routes + contracts). Consumed ONLY
// through the package root; every host dependency arrives through the
// assistantPorts seam below (docs/architecture/ai-assistant-extraction.md).
const { createChatEngine, createAssistantRoutes } = require('@animastor/assistant');
const placeholderAudio = require('./services/placeholder-audio');
const utils = require('./helpers/utils.cjs');

const filesystem = storage.filesystem;
const layerConfig = storage.layerConfig;
const genScope = storage.genScope;

// Phase 5: Runtime Result Contract — composition-root wiring. Runtime reports
// dispatch finalizations (completed/failed/cancelled) through the contracts
// seam; orchestration consumes them via this injected callback. Runtime never
// imports orchestration for result reporting.
// Docs: docs/architecture/PHASE_5_ORCHESTRATION_RUNTIME.md
const runtimeResultEmitter = require('./runtime/runtime-result-emitter');
const { createRuntimeResultConsumer } = require('./orchestration/runtime-result-consumer');
runtimeResultEmitter.setConsumer(createRuntimeResultConsumer());


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

// Trust the single reverse proxy (nginx in docker-compose) so express-rate-limit
// and req.ip use the real client IP from X-Forwarded-For. Without this,
// express-rate-limit v8 throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every
// proxied request (the header is present but trust proxy is false).
// 1 = trust only the immediately preceding hop (nginx) — nothing else.
app.set('trust proxy', 1);

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

// Auth context middleware (session cookie → req.user / req.workspace).
// Requests without a valid session stay anonymous (pre-auth compatibility —
// no global requireAuth); authenticated requests get real identity.
const { authContext, requireBookAccess } = require('./middleware/auth-context');
app.use(authContext);

// Authentication MVP: strict rate limit on credential endpoints (brute-force
// surface), registered BEFORE the auth route handlers.
app.use('/api/v1/auth/login', rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts, try again later' },
}));
app.use('/api/v1/auth/register', rateLimit({
    windowMs: 60_000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts, try again later' },
}));

// Auth endpoints (public/pre-auth): register, login, logout, me.
require('./routes/auth-routes.cjs')(app, redis, { utils: { log: (m) => console.log(m) } });

// Book ownership guards (Authentication MVP): every /api/v1/book/:bookId/*
// endpoint plus book-keyed media serving requires workspace membership when
// authenticated. Pre-auth requests pass through unchanged. Book-CREATION
// paths (import/blank/load-vbook) are exempt — they must run so ownership can
// attach to the caller's workspace inside the handler.
const CREATE_BOOK_SUBPATHS = new Set(['import', 'import-txt', 'import-text', 'load-vbook', 'blank']);
const bookAccessGuard = requireBookAccess('bookId');
app.use('/api/v1/book/:bookId', (req, res, next) => {
    if (CREATE_BOOK_SUBPATHS.has(req.params.bookId)) return next();
    return bookAccessGuard(req, res, next);
});
app.use('/api/v1/scene/:bookId', requireBookAccess('bookId'));
app.use('/api/v1/iu-image/:bookId', requireBookAccess('bookId'));
app.use('/api/v1/preview/:bookId', requireBookAccess('bookId'));

// AI chat endpoints are book-scoped too (session contents belong to a book).
// The target book comes from query/body/session lookup rather than the URL,
// so it is resolved here pre-route. Pre-auth passes through; authenticated
// callers must own the book (fail closed when ownership cannot be proven).
// The guard sets `req.scopedBookId` — the single authorized book identity
// that every /api/v1/ai handler MUST operate on.
const { aiBookGuard } = require('./middleware/ai-book-guard');
// /sessions/:id and /sessions/:id/messages carry the id in the path.
app.use('/api/v1/ai/sessions/:id', aiBookGuard);
// The rest resolve the book from query/body (session_id or book_id).
app.use('/api/v1/ai', (req, res, next) => {
    if (/^\/sessions\/[^/]+/.test(req.path)) return next(); // handled above
    return aiBookGuard(req, res, next);
});

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
// Assistant contour: the chat engine lives in the @animastor/assistant
// package now; the bundle-contract validator and the persona profile path
// are HOST legs injected here (composition-root binding). The engine
// holds no host requires.
const chatEngine = createChatEngine(config, {
    validateBundleObject: require('./book/bundle-validator.cjs').validateBundleObject,
    // Persona markdown is host-owned CONTENT (backend/ai tree); the HOST
    // reads the file here and injects the ready string — the package has
    // no fs/path knowledge. Env override (AI_PROFILE_PATH) unchanged.
    aiProfile: require('./services/assistant-profile-loader.cjs').loadAssistantProfile(),
    // Chat fallback base URL — operator env knob passed as injected config.
    aiApiBaseUrl: process.env.AI_API_BASE_URL,
});
const windowGenerator = require('./services/window-generator.cjs')({
    redis, txtImporter, genSessionRepo, state, activeScenes,
    placeholderAudio, saveChunk, config,
});

const iuRepo = require('./storage/postgres/repositories/iu-repo');
const sceneAssetsRepo = require('./storage/postgres/repositories/scene-assets-repo');

const taskHandlerDeps = {
    audio, image, video, state, book, orchestrator, activeScenes, placeholderAudio,
    cleanupService, utils, iuRepo, saveIURegistry,
    saveChunk, getChunk,
};
const taskHandler = require('./services/task-handler.cjs')(redis, config, taskHandlerDeps);

const bookDiffDeps = { state, book, layerConfig, genScope, activeScenes, getChunk, saveChunk, utils };
const bookDiff = require('./services/book-diff.cjs')(redis, config, bookDiffDeps);

const entityCleanup = require('./services/entity-cleanup.cjs')(redis, config, {
    utils, storage, runtime, bookDiff, book,
});

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
    // Phase 4: Canonical Book Model facade + deletion/purge boundary
    bookModel,
    bookDeletion: createBookDeletion({
        book, redis, config, storage,
        getAllChunks, getChunk, cleanBookRedisKeys,
        log: utils.log,
        setCancelFlag: (redisClient, id) => require('./runtime/scene-window').setCancelFlag(redisClient, id),
        // Agent-session cancel port: the cascade delivers the cancellation
        // signal through the same frozen VBook session port as cancel-worker
        // (single owner of the agent_sessions cancel SQL).
        agentSessionControl: require('./services/agent-session-control').createAgentSessionControl(),
        // Assistant-data purge seam: the deletion cascade must not know the
        // ai_chat_sessions table — it purges Assistant data through the port.
        purgeAssistantForBook: (bookId) => assistantPorts.purgeForBook(bookId),
    }),
    // Assistant contour ports (the playerPorts analog — extraction COMPLETE):
    // the AI Assistant HTTP contour (@animastor/assistant package) gets its
    // host legs ONLY through this narrow seam. No storage barrel, no SQL,
    // no whole Book/VBook services cross into the Assistant object graph:
    //   loadBook       — canonical||draft read (Book Model facade, lazy mode)
    //   persistBook    — ONE book-save semantics (full bundle save + the
    //                    zero-chapter targeted fallback behind a single port)
    //   validateBundle / validateBundleFile — bundle-contract validation
    //   resolveChatAI  — chat provider resolution (Provider Gateway seam)
    //   sessionRepo    — chat-session repository port (list/get/create/
    //                    append/rename/delete/purge) — PG impl host-side
    //   purgeForBook   — Assistant-data purge for book deletion/cache teardown
    //   chatTransport  — safeFetch (url-safety) + shared-pool inference +
    //                    describeSharedError + chat source token (gateway)
    //   log            — host logger
    // Guarded by tests/architecture/assistant-contour.test.js (A1–A7) and
    // assistant-package-boundary.test.js (PB1–PB4).
    assistantPorts: createAssistantPorts({
        bookModel, book, lazyBook,
        bundleValidator: require('./book/bundle-validator.cjs'),
        providerGateway: require('./services/provider-gateway'),
        chatEngine,
        sessionRepo: chatSessionRepo,
        urlSafety: require('./services/url-safety'),
        sharedPool: require('./services/ai-connector/shared-pool'),
        log: utils.log,
    }),
    // Phase 6: Player/Editor boundaries — book access via the Canonical
    // Book Model.
    // playerModel comes from the extracted @animastor/player package; the
    // composition root binds it to the host Book Model (VBook runtime shim).
    playerModel: createPlayerModel({ bookModel }),
    editorModel: createEditorModel({ bookModel, persistBook: book.saveBookBundle }),
    // Player package ports: the playback contour (packages/animastor-player)
    // gets its dependencies ONLY through these seams (composition root —
    // no hidden host requires inside the package, guarded by
    // player-route-split.test.js):
    //   outputRoot     — the artifact root (config.OUTPUT_DIR injected; the
    //                    player package never reads config directly; path
    //                    semantics unchanged: path.join(outputRoot, buildId, …))
    //   playerPorts    — host implementations that carry generation-domain or
    //                    host-infra knowledge the player must not import:
    //                    auth (checkBookAccess), video-timeline (ffprobe +
    //                    workflows alignment tax), waveform (ffmpeg)
    //   computeIuReady — pure IU progress math (routes/book/iu-progress-utils)
    //   bookProjections — the two pure VBook-runtime read projections
    //                    (findSceneRuntimeData / collectSceneUnits), passed
    //                    as a narrow port; the whole book module surface
    //                    never enters the player object graph.
    // Final boundary audit: the wide `videoTimeline` module seam was removed —
    // the player contour receives ONLY the port functions above; the host
    // video-timeline module (which imports workflows/ + config) never enters
    // the playback contour object graph.
    outputRoot: config.OUTPUT_DIR,
    playerPorts: {
        assertBookAccess: authContextMiddleware.checkBookAccess,
        computeVideoStartMs: videoTimeline.computeVideoStartMs,
        computeWaveform,
    },
    computeIuReady,
    bookProjections: {
        findSceneRuntimeData: book.findSceneRuntimeData,
        collectSceneUnits: book.collectSceneUnits,
    },
    // Editor contour ports (Phase 1 of the Editor extraction —
    // docs/architecture/editor-module-extraction-audit.md §6/§13): the
    // edit HTTP contour (routes/editor/**) gets its host legs ONLY through
    // this seam (the playerPorts analog — no hidden host requires inside
    // the contour, guarded by editor-route-split.test.js E2/E3):
    //   sceneAssetsRepo   — PG scene-assets (bumpSceneVersions/setDirtyUnitIds)
    //   placeholderAudio  — read-time placeholder recovery (GET /book/:id)
    //   auditCoverage     — POST source-coverage audit service
    //   promptLimit       — IMAGE_PROMPT_MAX_CHARS (agent-domain constant)
    //   purge             — entity-cleanup purgeScene/purgeUnit (structure deletes)
    //   resolveOwnership  — workspace-ownership attach (POST /book/blank)
    //   recoveryCtx       — read-recovery dependencies (redis chunk repair)
    //   The four host legs that were previously required inside
    //   editor-ports.cjs (entity-cleanup, source-coverage-audit,
    //   agent-prompts, workspace-ownership) are now constructed in the
    //   composition root and passed as ready-made references so that
    //   editor-ports.cjs holds zero host require() calls (Phase 1.1).
    editorPorts: createEditorPorts({
        deps: {
            sceneAssetsRepo,
            placeholderAudio,
            // Host implementations — already created/resolved above or below;
            // editor-ports.cjs must not require them itself.
            auditCoverage: require('./services/source-coverage-audit'),
            promptLimit: require('./services/agent-prompts').IMAGE_PROMPT_MAX_CHARS,
            purge: entityCleanup,
            resolveOwnership: async (bookId, meta) => {
                const workspaceOwnership = require('./middleware/workspace-ownership');
                return workspaceOwnership.resolveWorkspaceForBook(bookId, meta);
            },
            recoveryCtx: {
                redis, book, state, activeScenes, config, getAllChunks, saveChunk,
                log: (utils && utils.log) || ((...a) => console.log(new Date().toISOString(), ...a)),
            },
        },
    }),
};

require('./routes/book-routes.cjs')(app, redis, { ...routeDeps, taskHandler, bookDiff, windowGenerator });
// Player (playback) routes — registered through the @animastor/player
// package API (the playback HTTP contour lives in
// packages/animastor-player; the host must not require package internals —
// docs/architecture/PLAYER_ROUTE_SPLIT_CHECKLIST.md).
createPlayerRoutes(app, redis, routeDeps);
// Generation routes — import/generation leg, worker status/counts, progress
// SSE, GPU Hub callbacks. No playback handlers remain here.
require('./routes/generation-routes.cjs')(app, redis, { ...routeDeps, taskHandler });
// AI Assistant routes — registered through the @animastor/assistant
// package API (the Assistant HTTP contour lives in
// packages/animastor-assistant; the host must not require package
// internals — docs/architecture/ai-assistant-extraction.md). The contour
// gets ONLY its narrow seams (chatEngine + assistantPorts + utils): no
// storage barrel, no whole Book/VBook services, no task/generation deps
// ride into the Assistant object graph.
createAssistantRoutes(app, redis, {
    chatEngine,
    assistantPorts: routeDeps.assistantPorts,
    utils,
});
require('./routes/debug-routes.cjs')(app, redis, {
    ...routeDeps, taskHandler, bookDiff, iuRepo, computeWaveform, journal,
});

// Workflow Manager routes
require('./routes/connector-routes.cjs')(app, redis, routeDeps);
require('./routes/workflow-routes.cjs')(app, redis, routeDeps);

// Editor limits / app config
require('./routes/config-routes.cjs')(app, redis, routeDeps);

// Workspace AI provider settings (Experimental Beta — Milestone 1)
require('./routes/settings-ai-routes.cjs')(app);

// Local AI Connector (LAC V1): registration & lifecycle routes for the
// caller's workspace (users only — guests never own long-lived credentials;
// the WS handler below shares this module). Mounted right after the settings
// AI routes (§15 Phase 2 wiring point).
// Registration-flooding rate limit (§10.2) FIRST: the create/re-arm surface
// mints one-time tokens — stricter than the generic /api/ limiter.
app.use(['/api/v1/ai-connector/registrations', '/api/v1/ai-connector/registrations/:connectorId/token'], rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many registration attempts, try again later' },
}));
require('./routes/ai-connector-routes.cjs').createAiConnectorRoutes({ redis })(app);

// LLM Sharing Phase 1 — Control Plane (SH-AI-1): workspace-owner lifecycle
// routes for shareable inference endpoints (Private by default; users only;
// foreign ids indistinguishable 404). The shared-pool resolver seam lives in
// services/ai-connector/shared-pool.js — consumer-side shared discovery is a
// later phase by design.
require('./routes/ai-endpoint-routes.cjs').createAiEndpointRoutes()(app);

// Admin foundation: system AI control (kill switch + system provider) +
// SYSTEM worker registry (Animastor-operated pool, PW-4 fail-closed model).
// Guarded by requireAdmin; served on admin.animastor.in behind Basic Auth.
require('./routes/admin-routes.cjs')(app, redis);

// Private worker registration & lifecycle (Experimental Beta — Private Worker
// Phase 1). Users only; workspace always resolved server-side.
require('./routes/worker-routes.cjs')(app, redis);

// User lookup (Experimental Beta — SH-2, worker sharing V2): minimal
// exact-username recipient picker behind the same kill-switch.
require('./routes/users-routes.cjs')(app);

// Private worker SETUP CONTRACT (Phase 3) — the unified UI-safe contract for
// Web and Android: profiles, installation methods, artifacts, workflows,
// instructions, worker setup status, installation plan. Additive layer; the
// existing worker API above is unchanged. Same session/workspace guards.
require('./routes/worker-setup-routes.cjs')(app, redis);

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
        const wfLoader = require('animastor-comfyui-workflow-connector').workflowLoader;
        // Host-owned asset directories are injected (extraction §1.3/§2):
        // the package has no host default — the backend passes the AI tree
        // paths at boot. Env WF_DIR / CONNECTOR_DIR still take precedence
        // only when configure() has not set the dirs (package resolution
        // order: explicit injection → env).
        wfLoader.configure({
            workflowsDir: path.join(__dirname, '../ai/workflows'),
            connectorsDir: path.join(__dirname, '../ai/connectors'),
        });
        await wfLoader.loadWorkflows();
        log('[STARTUP] Workflows loaded');
    } catch (wfErr) {
        console.error('[FATAL] Workflow loading failed:', wfErr.message);
        console.error('[FATAL] Every workflow must have a matching connector in the AI connectors dir.');
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

    // Authentication MVP: periodic housekeeping for expired/revoked sessions
    // (PG stays bounded; failures are harmless and only logged).
    try {
        const sessionRepo = require('./storage/postgres/repositories/session-repo');
        setInterval(async () => {
            try {
                const n = await sessionRepo.purgeExpired();
                if (n > 0) log(`[SESSIONS] Purged ${n} expired sessions`);
            } catch (err) {
                console.warn('[SESSIONS] purge failed (non-fatal):', err.message);
            }
        }, 6 * 60 * 60 * 1000).unref(); // every 6h
    } catch (err) {
        console.warn('[SESSIONS] periodic purge setup failed (non-fatal):', err.message);
    }

    // Guest Workspace MVP: expired guest identities + temporary workspaces
    // past TTL+grace are hard-deleted. Duplication-safe by design (each
    // backend process purges, inner-loop lock contention is harmless).
    try {
        const guestRepo = require('./storage/postgres/repositories/guest-repo');
        setInterval(async () => {
            try {
                const deleted = await guestRepo.purgeExpired();
                if ((deleted && deleted.guests) || (deleted && deleted.workspaces)) {
                    log(`[GUESTS] Purged ${deleted.guests} stale guest identities, ${deleted.workspaces} expired temporary workspaces`);
                }
            } catch (err) {
                console.warn('[GUESTS] purge failed (non-fatal):', err.message);
            }
        }, 6 * 60 * 60 * 1000).unref(); // every 6h
    } catch (err) {
        console.warn('[GUESTS] periodic purge setup failed (non-fatal):', err.message);
    }

    // Private Worker (Experimental Beta Phase 1): keep the Redis worker-auth
    // mirror in sync with PG (startup rebuild + periodic resync — heals Redis
    // loss and revoke-during-blip races). Non-fatal.
    try {
        const workerAuth = require('./services/worker-auth');
        workerAuth.startWorkerAuthMirrorSync(redis);
    } catch (err) {
        console.warn('[WORKER-AUTH] mirror sync setup failed (non-fatal):', err.message);
    }

    // LAC-2: Local AI Connector WebSocket endpoint (Phase 2 — WS Foundation).
    // Must be attached before the listen callback (the upgrade event fires
    // after listen, but the listener must be registered before it).
    let aiConnectorWs = null;
    try {
        const { createWsHandler } = require('./routes/ai-connector-routes.cjs');
        aiConnectorWs = createWsHandler({ redis, logger: console });
        log('[STARTUP] Local AI Connector WS handler created');
    } catch (err) {
        console.warn('[STARTUP] Local AI Connector WS setup failed (non-fatal):', err.message);
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
                // O-2: the raw postgres handle left reconcileDeps — C2/C4 read
                // PG through the PersistencePort (wired above).
                const reconcileDeps = {
                    orchestrator,
                    taskHandler,
                    state,
                    recoverAllBooksFromDisk,
                    resumeIncompleteSessions,
                    runBackgroundWindowGeneration: windowGenerator.runBackgroundWindowGeneration,
                    entityCleanup,
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
                const scopeMigration = await genScope.migrateLegacyScopes(redis);
                if (scopeMigration.expiry_added > 0 || scopeMigration.invalid_removed > 0) {
                    log(
                        `[STARTUP] Generation scope migration: ` +
                        `${scopeMigration.expiry_added} expiry added, ` +
                        `${scopeMigration.invalid_removed} invalid removed`
                    );
                }

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

    // LAC-2: Attach the WebSocket upgrade handler to the HTTP server.
    // Must happen after server.listen() returns — the server object must
    // exist. The upgrade event listener is safe to attach at any point
    // after the server is created; events only arrive after listen.
    if (aiConnectorWs) {
        aiConnectorWs.attachUpgrade(server);
        log('[STARTUP] Local AI Connector WS upgrade handler attached');
    }

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

            // 2.5 Close all live Local AI Connector WS sessions (marks each
            // connector offline; sockets get a server_shutdown close).
            try {
                if (aiConnectorWs) {
                    aiConnectorWs.shutdown();
                    log('[SHUTDOWN] Local AI Connector WS sessions closed');
                }
            } catch (wsErr) {
                console.warn(`[SHUTDOWN] AI Connector WS shutdown failed: ${wsErr.message}`);
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
