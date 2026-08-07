// ======================================================
// ANIMASTOR BACKEND — BOOK ROUTES
// ======================================================
// All /api/v1/book/* endpoints.
// Split into sub-route modules for maintainability.
//
// Sub-modules (routes/book/):
//   core-routes.cjs      - GET/PUT/PATCH book, DELETE, source-coverage, cover
//   import-routes.cjs    - load-vbook, import-txt, bootstrap, resume-bootstrap, bootstrap-next-window, trigger-next-window
//   generation-routes.cjs - regenerate, cancel-generation, generate-next
//   chunks-routes.cjs    - GET chunks, GET assets-state
//   agent-routes.cjs     - GET agent-status
//   recovery-routes.cjs  - recover-placeholders
//
// Previously extracted sub-registrars:
//   status-routes.cjs    - status endpoints
//   parse-routes.cjs     - parse/source/snapshot endpoints
//   cache-routes.cjs     - cache inspection + teardown
//   versions-routes.cjs  - version endpoints

module.exports = function(app, redis, deps) {
    // Core CRUD routes
    require('./book/core-routes.cjs')(app, redis, deps);

    // Import and bootstrap routes
    require('./book/import-routes.cjs')(app, redis, deps);

    // Export / download routes (vbook, storyboard, audio, video)
    require('./book/export-routes.cjs')(app, redis, deps);

    // Regeneration and generation control routes
    require('./book/generation-routes.cjs')(app, redis, deps);

    // Chunks and asset state routes
    require('./book/chunks-routes.cjs')(app, redis, deps);

    // Agent status route
    require('./book/agent-routes.cjs')(app, redis, deps);

    // Progress panel route (pre-computed worker list)
    require('./book/progress-panel.cjs')(app, redis, deps);

    // Recovery routes
    require('./book/recovery-routes.cjs')(app, redis, deps);

    // Version introspection routes
    require('./book/versions-routes.cjs')(app, {
        storage: deps.storage,
        sceneAssetsRepo: deps.sceneAssetsRepo,
        log: deps.utils.log,
    });

    // Recent books list (session restore across clients)
    require('./book/recent-books-routes.cjs')(app, redis, deps);

    // Already-extracted sub-registrars (kept as-is)
    const registerStatusRoutes = require('./book/status-routes.cjs');
    const registerParseRoutes = require('./book/parse-routes.cjs');
    const registerCacheRoutes = require('./book/cache-routes.cjs');

    const { log } = deps.utils;

    // Status / state read-only routes
    registerStatusRoutes(app, {
        genSessionRepo: deps.genSessionRepo,
        lazyBook: deps.lazyBook,
        txtImporter: deps.txtImporter,
        log,
    });

    // Parse / source / snapshot routes
    registerParseRoutes(app, {
        config: deps.config,
        txtImporter: deps.txtImporter,
        lazyBook: deps.lazyBook,
        placeholderAudio: deps.placeholderAudio,
        taskHandler: deps.taskHandler,
        log,
    });

    // Cache inspection + teardown routes
    registerCacheRoutes(app, {
        redis,
        config: deps.config,
        storage: deps.storage,
        path: require('path'),
        fs: require('fs'),
        getAllChunks: deps.getAllChunks,
        getChunk: deps.getChunk,
        cleanBookRedisKeys: deps.cleanBookRedisKeys,
        log,
    });
};
