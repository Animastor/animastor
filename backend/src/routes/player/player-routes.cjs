// ======================================================
// ANIMASTOR BACKEND — PLAYER ROUTES (playback HTTP contour)
// ======================================================
// The playback contour, physically separated from the generation contour
// (Player route split — preparation for the packages/animastor-player move;
// see docs/architecture/PLAYER_ROUTE_SPLIT_CHECKLIST.md).
//
// Serves (byte-identical to the pre-split handlers — URLs, headers, status
// codes and response bodies unchanged):
//   scene media:    /api/v1/scene/:b/:ch/:sc/audio|video|image  (+ Range)
//   scene data:     /api/v1/scene/:b/:ch/:sc/status|storyboard|waveform|timings
//   iu media:       /api/v1/iu-image/*, /api/v1/preview/*
//   chunk-keyed:    /api/v1/chunk/:id (status), /api/v1/chunk/:id/audio|image|video|storyboard
//   playback queue: /api/v1/book/:bookId/chunks, /api/v1/book/:bookId/assets-state
//
// Dependencies arrive EXCLUSIVELY through deps (composition root — backend.cjs):
//   playerModel   — Phase 6 facade over the Canonical Book Model (book reads)
//   outputRoot    — artifact root (config.OUTPUT_DIR injected; no direct
//                   config reads in the player contour)
//   playerPorts   — { assertBookAccess, computeVideoStartMs, computeWaveform }
//                   host implementations (auth middleware, video-timeline,
//                   waveform-service) injected as ports; the contour must
//                   NOT import generation/host implementation modules
//                   (workflows/, video-timeline, middleware, waveform-service)
//   redis/getChunk/getAllChunks/iuRepo — runtime state (infrastructural,
//                   host-side; a full playback-projection port is
//                   deliberately premature — recorded in the split checklist)
//   image/state/activeScenes/placeholderAudio/layerConfig/book — host
//                   generation-pipeline seams (documented intentional deps)
//
// Usage:
//   require('./routes/player/player-routes.cjs')(app, redis, deps);
//
// Guards: tests/architecture/player-route-split.test.js +
//         tests/architecture/phase6-editor-player.test.js (re-aimed T4/T5/T6).

const { createPlayerShared } = require('./player-shared.cjs');

module.exports = function(app, redis, deps) {
    const {
        config, state, image, book, utils, redis: _redisDepsOk,
        getChunk, getAllChunks, getBookWindowStatus,
        activeScenes, placeholderAudio, layerConfig, iuRepo,
        sceneAssetsRepo, playerModel,
        // Player-route seams (composition root provides them):
        outputRoot,            // = config.OUTPUT_DIR (injected)
        playerPorts,           // { assertBookAccess, computeVideoStartMs, computeWaveform }
        computeIuReady,        // pure IU math (routes/book/iu-progress-utils.cjs)
        videoTimeline,         // host module re-exported as a port object for scene-data
    } = deps;
    const { log } = utils;

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
        book,
        videoTimelinePort: videoTimeline,
    });
    require('./iu-media.cjs')(app, ctx, {
        image, state, activeScenes, placeholderAudio,
    });
    require('./playback-queue.cjs')(app, ctx, {
        getAllChunks, getBookWindowStatus, layerConfig, sceneAssetsRepo, computeIuReady,
    });

    log('[ROUTES] Player routes loaded');
};
