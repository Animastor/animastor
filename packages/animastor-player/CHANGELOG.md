# Changelog

## 0.1.0 — 2026-09-08

### Release preparation (npm publication)

- `@animastor/vbook-runtime` dependency switched from the monorepo
  `file:` link to the published registry range `^0.1.0` (0.1.0 is live on
  npm) — `npm install @animastor/player` now resolves cleanly on a fresh
  environment. The host backend is unaffected: it injects the bookModel,
  so the package's default facade instance is inert inside the backend
  process; the monorepo `file:` links at `backend/package.json` are
  unchanged.
- Consumer metadata completed: keywords, homepage, README installation
  section + Node >= 18 requirement + absolute doc links (relative
  `../../docs/...` links do not resolve on npmjs.com).
- `files` narrowed to production content (`src/` + metadata) — tests stay
  in the repository checkout and run via `npm test`, matching the
  repo-wide package standard (no tests in published tarballs).

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
