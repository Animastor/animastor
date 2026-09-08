// ======================================================
// @animastor/player — PACKAGE ENTRYPOINT (public API)
// ======================================================
// The playback HTTP contour of the Animastor backend, physically extracted
// from the host (backend/src/routes/player/ + backend/src/player/ — deleted
// by the extraction commit; docs/architecture/PLAYER_ROUTE_SPLIT_CHECKLIST.md
// §PHYSICAL MOVE COMPLETE).
//
// The package owns: route registration, Range/206/ETag/If-Range media
// streaming, scene status/storyboard/timings handlers, IU media, the
// playback queue (chunk dedup, cover_chunk_id, chunk_positions) and the
// assets-state readiness projection, plus the artifact-naming grammar
// (read-side expression of the generation⇄player filename contract).
//
// The package imports NOTHING from the backend host: no config, no
// generation implementation, no workflows/, no middleware, no waveform/
// video-timeline host modules, no Redis/PG internals, no backend storage.
// Book content is reached ONLY through the injected playerModel (the
// VBook boundary — the facade itself lives here over the Book Model of
// @animastor/vbook-runtime); the two pure read projections arrive as the
// injected bookProjections.
//
// Host dependencies (ports/adapters — injected by the composition root):
//   playerModel       { loadBook(bookId, opts?), getBookIdentity(bookId),
//                       getBookManifest(bookId) }        (VBook boundary)
//   outputRoot        string — artifact root (host config injected)
//   playerPorts       { assertBookAccess(req, bookId) → workspace|null,
//                       computeVideoStartMs(ius, buildId, bookId, ch, sc,
//                       outputRoot) → Promise<boolean>,
//                       computeWaveform(audioPath) → Promise<number[]> }
//   computeIuReady    (redis, sceneAssetsRepo, bookId, ch, sc, total)
//   bookProjections   { findSceneRuntimeData(loadedBook, ch, sc),
//                       collectSceneUnits(scenePayload) } (pure VBook reads)
//   redis/getChunk/getAllChunks/getBookWindowStatus             (runtime state)
//   iuRepo/sceneAssetsRepo/layerConfig/image/state/activeScenes/
//   placeholderAudio/utils ({ log })                            (host seams)
//
// Public API:
//   const { createPlayerModel, createPlayerRoutes } = require('@animastor/player');
//   const playerModel = createPlayerModel({ bookModel });
//   createPlayerRoutes(app, redis, routeDeps);
//
// Guards: backend/tests/architecture/player-route-split.test.js (P1–P9),
//         backend/tests/architecture/phase6-editor-player.test.js (T1–T7).

const { createPlayerModel } = require('./player-model.cjs');
const createPlayerRoutes = require('./player-routes.cjs');

module.exports = { createPlayerModel, createPlayerRoutes };
