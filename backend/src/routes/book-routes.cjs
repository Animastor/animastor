// ======================================================
// ANIMASTOR BACKEND — BOOK ROUTES
// ======================================================
// All /api/v1/book/* endpoints.
// Split into sub-route modules for maintainability.
//
// Sub-modules (routes/book/):
//   import-routes.cjs    - load-vbook, import-txt, bootstrap, resume-bootstrap, bootstrap-next-window, trigger-next-window
//   generation-routes.cjs - regenerate, cancel-generation, generate-next
//   agent-routes.cjs     - GET agent-status
//   recovery-routes.cjs  - recover-placeholders
//
// Editor contour (routes/editor/ — Phase 1 of the Editor extraction,
// docs/architecture/editor-module-extraction-audit.md §13): core book
// CRUD + entity/structure CRUD moved there, registered below.
//   editor-routes.cjs       - GET/PUT/PATCH book, DELETE, source-coverage, cover
//   entity-crud-routes.cjs  - add/delete characters, locations, voices,
//                             behaviors, chapters, scenes, units; POST /blank
//
// Previously extracted sub-registrars:
//   status-routes.cjs    - status endpoints
//   parse-routes.cjs     - parse/source/snapshot endpoints
//   cache-routes.cjs     - cache inspection + teardown
//   versions-routes.cjs  - version endpoints
//   chunks-routes.cjs    - GET chunks, GET assets-state → moved to the
//                          player contour (packages/animastor-player,
//                          registered by backend.cjs); the empty registrar
//                          stub was deleted with the physical move.

module.exports = function(app, redis, deps) {
    // Editor contour — core book CRUD (GET/PUT/PATCH book, DELETE, cover,
    // source-coverage) + entity/structure CRUD. Same endpoints, same
    // handlers, same registration order as before the split (4d1f6f0e
    // playbook — behavior-neutral move). Since the Phase 4 physical move
    // the contour lives in @animastor/editor (packages/animastor-editor);
    // the legacy ./editor/ directory is a one-line re-export shim of the
    // package (relocation checklist §2.4).
    // Since Phase 4.1 the package exposes ONLY its root entrypoint — the
    // editor routes are registered through the public API re-export shim
    // (backend/src/routes/editor/index.cjs → require('@animastor/editor')).
    require('./editor/index.cjs')(app, redis, deps);

    // Import and bootstrap routes
    require('./book/import-routes.cjs')(app, redis, deps);

    // Export / download routes (vbook, storyboard, audio, video)
    require('./book/export-routes.cjs')(app, redis, deps);

    // Regeneration and generation control routes
    require('./book/generation-routes.cjs')(app, redis, deps);

    // (chunks + assets-state moved to the player contour — packages/animastor-player)

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

    // (entity CRUD now lives in the editor contour — see above)

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
