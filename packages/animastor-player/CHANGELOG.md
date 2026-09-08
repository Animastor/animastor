# Changelog

## 0.1.0 — 2026-09-08

### Physical extraction (route split 4d1f6f0e → boundary audit → move)

- The playback HTTP contour physically moved from the backend host into
  `src/` of this package: the registrar (`player-routes.cjs`), shared
  contour helpers (`player-shared.cjs`), scene media (`scene-media.cjs`),
  scene data (`scene-data.cjs`), IU media (`iu-media.cjs`), playback queue
  (`playback-queue.cjs`), the artifact-naming grammar
  (`artifact-naming.cjs`) and the Player Model facade (`player-model.cjs`,
  from the host `backend/src/player/index.cjs`) — final boundary audit
  MOVE list.
- Behavior, URLs, headers (Range / 206 / ETag / If-Range / 304 / 416),
  status codes and response bodies unchanged (17 frozen endpoints, pinned
  by `backend/tests/architecture/player-route-split.test.js` P1).
- Legacy backend copies deleted: `backend/src/routes/player/`,
  `backend/src/player/`, and the empty `routes/book/chunks-routes.cjs`
  registrar stub.
- Every host dependency arrives as an injected port (composition-root
  contract in the README); the package's only dependency is
  `@animastor/vbook-runtime` (Player Model facade).
- Behavior tests moved into the package: `test/scene-timings.test.js`,
  `test/scene-audio-range.test.js`.
