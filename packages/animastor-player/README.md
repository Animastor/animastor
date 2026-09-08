# @animastor/player

Animastor **Player** — the playback HTTP contour of the Animastor backend:
scene media serving (HTTP Range / 206 / ETag / If-Range streaming), scene
data (status / storyboard / timings / waveform), IU media (iu-image /
preview / chunk storyboard), the playback queue (chunk dedup,
`cover_chunk_id`, `chunk_positions`) and the assets-state readiness
projection. Includes the `createPlayerModel` facade over the Canonical Book
Model and the read-side artifact-naming grammar.

**Status: EXTRACTED (0.1.0).** The playback contour physically lives in this
package (`src/`); the host backend consumes it only through the package
entrypoint. See
[`docs/architecture/PLAYER_ROUTE_SPLIT_CHECKLIST.md`](https://github.com/Animastor/animastor/blob/main/docs/architecture/PLAYER_ROUTE_SPLIT_CHECKLIST.md)
(physical move COMPLETE) and
[`docs/architecture/PLAYER_PACKAGE_EXTRACTION_READINESS_AUDIT.md`](https://github.com/Animastor/animastor/blob/main/docs/architecture/PLAYER_PACKAGE_EXTRACTION_READINESS_AUDIT.md).

## Requirements

- Node.js >= 18
- [`@animastor/vbook-runtime`](https://www.npmjs.com/package/@animastor/vbook-runtime)
  (installed automatically as the only runtime dependency — the Player Model
  facade over its Canonical Book Model)

## Installation

```bash
npm install @animastor/player
```

## Public API

The package exposes a single entrypoint — `require('@animastor/player')`
returns `{ createPlayerModel, createPlayerRoutes }`. Deep imports
(`@animastor/player/src/...`) are intentionally not exported.

## Boundary

The package imports **nothing** from the backend host: no config, no
generation implementation, no `workflows/`, no middleware, no
waveform/video-timeline host modules, no Redis/PG internals, no backend
storage. Book content is reached only through the injected `playerModel`
(VBook boundary — the facade over `@animastor/vbook-runtime`'s Book Model).
Every host dependency arrives as an injected port at registration time.

## Standalone use (repository checkout)

```bash
npm install        # dep: @animastor/vbook-runtime (dev: mocha + chai)
npm test           # 17 behavioral tests, no host needed
```

## Host integration (composition root)

```js
const { createPlayerModel, createPlayerRoutes } = require('@animastor/player');

const playerModel = createPlayerModel({ bookModel });
createPlayerRoutes(app, redis, {
    playerModel,                                  // VBook boundary (book content reads)
    outputRoot: config.OUTPUT_DIR,                // artifact root (no config reads inside)
    playerPorts: {                                // host-owned implementations
        assertBookAccess,                         //   auth middleware
        computeVideoStartMs,                      //   ffprobe + workflows alignment tax
        computeWaveform,                          //   ffmpeg
    },
    computeIuReady,                               // pure IU-progress math (host)
    bookProjections: { findSceneRuntimeData, collectSceneUnits }, // pure VBook reads
    redis, getChunk, getAllChunks, getBookWindowStatus,
    iuRepo, sceneAssetsRepo, layerConfig,
    image, state, activeScenes, placeholderAudio,
    utils: { log },
});
```

## Frozen HTTP surface (17 endpoints)

```
GET  /api/v1/chunk/:id                     GET  /api/v1/chunk/:id/audio
GET  /api/v1/chunk/:id/image               GET  /api/v1/chunk/:id/video
GET  /api/v1/chunk/:id/storyboard          GET  /api/v1/scene/:b/:ch/:sc/audio
GET  /api/v1/scene/:b/:ch/:sc/video        GET  /api/v1/scene/:b/:ch/:sc/image
GET  /api/v1/scene/:b/:ch/:sc/status       GET  /api/v1/scene/:b/:ch/:sc/storyboard
GET  /api/v1/scene/:b/:ch/:sc/waveform     GET  /api/v1/scene/:b/:ch/:sc/timings
PUT  /api/v1/scene/:b/:ch/:sc/timings      GET  /api/v1/iu-image/:b/:ch/:sc/:iuId
GET  /api/v1/preview/:b/:ch/:sc/:iuId      GET  /api/v1/book/:bookId/chunks
GET  /api/v1/book/:bookId/assets-state
```

Guards: [`backend/tests/architecture/player-route-split.test.js`](https://github.com/Animastor/animastor/blob/main/backend/tests/architecture/player-route-split.test.js) (P1–P9) and
[`backend/tests/architecture/phase6-editor-player.test.js`](https://github.com/Animastor/animastor/blob/main/backend/tests/architecture/phase6-editor-player.test.js) (T1–T7).

## License

MIT
