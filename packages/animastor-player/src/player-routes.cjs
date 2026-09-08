// ======================================================
// @animastor/player — PLAYER ROUTES (playback HTTP contour)
// ======================================================// The playback contour, physically extracted from the host backend
// (Player route split 4d1f6f0e → packages/animastor-player move; see
// docs/architecture/PLAYER_ROUTE_SPLIT_CHECKLIST.md).
//
// Serves (byte-identical to the pre-split handlers — URLs, headers, status
// codes and response bodies unchanged):
//   scene media:    /api/v1/scene/:b/:ch/:sc/audio|video|image  (+ Range)
//   scene data:     /api/v1/scene/:b/:ch/:sc/status|storyboard|waveform|timings
//   iu media:       /api/v1/iu-image/*, /api/v1/preview/*
//   chunk-keyed:    /api/v1/chunk/:id (status), /api/v1/chunk/:id/audio|image|video|storyboard
//   playback queue: /api/v1/book/:bookId/chunks, /api/v1/book/:bookId/assets-state
//
// Dependencies arrive EXCLUSIVELY through deps (composition root — host
// backend.cjs):
//   playerModel   — Phase 6 facade over the Canonical Book Model (book reads)
//   outputRoot    — artifact root (config.OUTPUT_DIR injected; no direct
//                   config reads in the player contour)
//   playerPorts   — { assertBookAccess, computeVideoStartMs, computeWaveform }
//                   host implementations (auth middleware, video-timeline,
//                   waveform-service) injected as ports; the contour must
//                   NOT import generation/host implementation modules
//                   (workflows/, video-timeline, middleware, waveform-service)
//                   and must not receive the video-timeline MODULE — only the
//                   port functions (final boundary audit: the module seam was
//                   narrowed away; scene-data reads ports via playerPorts)
//   redis/getChunk/getAllChunks/iuRepo — runtime state (infrastructural,
//                   host-side; a full playback-projection port is
//                   deliberately premature — recorded in the split checklist)
//   image/state/activeScenes/placeholderAudio/layerConfig — host
//                   generation-pipeline seams (documented intentional deps)
//   bookProjections — the two pure VBook-runtime read projections
//                   (findSceneRuntimeData / collectSceneUnits); the package
//                   never receives the whole book module surface (loaders/
//                   writers stay host-side; book CONTENT reads go through
//                   playerModel only)
//
// Usage:
//   const { createPlayerRoutes } = require('@animastor/player');
//   createPlayerRoutes(app, redis, deps);
//
// Guards: backend/tests/architecture/player-route-split.test.js +
//         backend/tests/architecture/phase6-editor-player.test.js (re-aimed T4/T5/T6).

const { createPlayerShared } = require('./player-shared.cjs');

module.exports = function(app, redis, deps) {
    const {
        state, image, utils,
        getChunk, getAllChunks, getBookWindowStatus,
        activeScenes, placeholderAudio, layerConfig, iuRepo,
        sceneAssetsRepo, playerModel,
        // Player-route seams (composition root provides them):
        outputRoot,            // = config.OUTPUT_DIR (injected)
        playerPorts,           // { assertBookAccess, computeVideoStartMs, computeWaveform }
        computeIuReady,        // pure IU math (host routes/book/iu-progress-utils.cjs)
        bookProjections,       // { findSceneRuntimeData, collectSceneUnits } — the two
                               // pure VBook-runtime read projections; the whole book
                               // module surface is NOT handed to the package
    } = deps;
    const { log } = utils;

    if (!bookProjections || typeof bookProjections.findSceneRuntimeData !== 'function'
        || typeof bookProjections.collectSceneUnits !== 'function') {
        throw new Error('createPlayerRoutes: bookProjections { findSceneRuntimeData, collectSceneUnits } is a required port');
    }

    const ctx = createPlayerShared({
        playerModel,
        playerPorts,
        outputRoot,
        redis,
        getChunk,
        iuRepo,
        log,
    });

    require('./scene-media.cjs')(app, ctx);
    require('./scene-data.cjs')(app, ctx, {
        image,
        // Pure read projections over the Canonical Book Model (VBook runtime);
        // the whole book module surface is NOT handed to the player contour.
        bookProjections,
    });
    require('./iu-media.cjs')(app, ctx, {
        image, state, activeScenes, placeholderAudio,
    });
    require('./playback-queue.cjs')(app, ctx, {
        getAllChunks, getBookWindowStatus, layerConfig, sceneAssetsRepo, computeIuReady,
    });

    log('[ROUTES] Player routes loaded');
};
