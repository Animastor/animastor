# PLAYER ROUTE SPLIT CHECKLIST — playback contour → `routes/player/` → `packages/animastor-player/`

**Status:** Route split COMPLETE (`4d1f6f0e`). Final package boundary audit COMPLETE (this document — it was referenced by the split commit's code comments but never committed; created by the boundary-audit commit).
**Base commit of the split:** `4d1f6f0ec216f9d50e1a9e93a18b43a79e11b7a6`
**Related:** `PLAYER_PACKAGE_EXTRACTION_READINESS_AUDIT.md` (pre-split reconnaissance), `PHASE_6_EDITOR_PLAYER.md` (facade + frozen legacy edges), `PHASE_7_EXTRACTION_READINESS.md` §4.6 (forced sequence: VBook → route split → Player), `VBOOK_RUNTIME_RELOCATION_CHECKLIST.md` (upstream, COMPLETE).

---

## 1. Route split record (commit `4d1f6f0e`)

The playback HTTP contour was physically separated from the generation contour:

| From | To | Content |
|---|---|---|
| `routes/generation-routes.cjs` (1513 LOC) | `routes/player/{player-routes,player-shared,scene-media,scene-data,iu-media}.cjs` | 15 playback endpoints, byte-identical handlers |
| `routes/book/chunks-routes.cjs` (244 LOC) | `routes/player/playback-queue.cjs` | `GET /book/:id/chunks`, `GET /book/:id/assets-state` |
| — | `routes/player/artifact-naming.cjs` | dependency-free naming-grammar seam extracted |
| `backend/src/backend.cjs` | composition-root seams | `outputRoot`, `playerPorts`, `computeIuReady`, `videoTimeline` (since narrowed — §3) |

Handlers are byte-for-byte relocations: URLs, headers (Range / 206 / ETag / If-Range / 304 / 416), status codes and response bodies unchanged.

---

## 2. FINAL PACKAGE BOUNDARY AUDIT

Measured at the audit commit (working tree on top of `d6c4759d`). Static scan + functional registration probe, guarded by `backend/tests/architecture/player-route-split.test.js` (P1–P7) and `phase6-editor-player.test.js` (T1–T7).

### 2.1 Dependency inventory (classification)

Every require/dep of `backend/src/routes/player/*` and `backend/src/player/*`:

| Dependency | Kind | Classification | Disposition |
|---|---|---|---|
| `path`, `fs` | node builtin | Player-owned | MOVE as-is |
| `./artifact-naming.cjs` | intra-contour, zero requires | Player-owned | MOVE |
| `./player-shared.cjs`, `./scene-media.cjs`, `./scene-data.cjs`, `./iu-media.cjs`, `./playback-queue.cjs` | intra-contour wiring | Player-owned | MOVE |
| `playerModel` (`backend/src/player/index.cjs`) | Phase 6 facade | Player-owned (VBook-backed) | MOVE; its `../book/book-model.cjs` dep is VBOOK |
| `outputRoot` (string) | injected seam | host infrastructure | PORT — `config.OUTPUT_DIR` value injected at composition root |
| `playerPorts.assertBookAccess` | injected port (auth middleware impl) | host infrastructure | PORT — `(req, bookId) → workspace \| null` |
| `playerPorts.computeVideoStartMs` | injected port (video-timeline impl) | host infrastructure (generation-domain knowledge: workflows/ LTX tax, ffprobe) | PORT |
| `playerPorts.computeWaveform` | injected port (waveform-service impl) | host infrastructure (ffmpeg) | PORT |
| `computeIuReady` (`routes/book/iu-progress-utils.cjs`) | injected pure math | shared (used by `routes/book/progress-panel.cjs` too) | STAY host-side; PORT — `(redis, sceneAssetsRepo, bookId, ch, sc, total) → number` |
| `bookProjections` (`findSceneRuntimeData`, `collectSceneUnits`) | injected pure read projections | VBook dependency (`@animastor/vbook-runtime` via `book/index.js` shim) | VBOOK — import from `@animastor/vbook-runtime` after the move; the whole book module surface is NOT handed to the contour |
| `playerModel.loadBook` (book content reads) | facade over Canonical Book Model | VBook dependency | VBOOK |
| `redis`, `getChunk`, `getAllChunks`, `getBookWindowStatus` | runtime state | host infrastructure (Redis chunk keys `animastor:chunk:*`) | STAY host-side; PORT (playback-projection port deliberately premature — readiness audit §4) |
| `iuRepo` (`storage/postgres/repositories/iu-repo`) | PG rows | host infrastructure | STAY; PORT — `{ getImageUnitsForScene, upsertImageUnit, upsertIuTiming }` |
| `sceneAssetsRepo` | PG rows (passed through to `computeIuReady`) | host infrastructure | STAY |
| `image.getSceneDuration` / `image.getOrCreatePreview` | host image-pipeline internals (injected) | host infrastructure | STAY; PORT — `getSceneDuration(buildId,b,c,s) → number`, `getOrCreatePreview(b,c,s,iuId,buildId) → {path,created}\|null` (preview route may GENERATE — documented intentional write, readiness audit §4 R3) |
| `state.getAssetStates`, `state.AssetState` | runtime state (injected) | host infrastructure | STAY; PORT |
| `activeScenes.addActiveScene` | redispatch repair (injected) | host infrastructure (generation side-effect) | STAY; PORT — documented intentional dep |
| `placeholderAudio.ensurePlaceholderAudio` | on-demand repair (injected) | host infrastructure (generation side-effect) | STAY; PORT — documented intentional dep |
| `layerConfig.get` | layer gating (injected) | shared (Generate page gates on the same config) | STAY; PORT |
| `utils.log` | logging (injected) | host infrastructure | PORT — `log(msg)` |

**Zero** generation dependencies found in the contour (§2.2). **Zero** direct `config` reads (audit removed the vestigial `config` destructure in `player-routes.cjs`).

### 2.2 Generation leakage result — CLEAN

| Check | Result |
|---|---|
| `routes/player/*` imports `generation-routes.cjs` | **NONE** (P2 require isolation: only intra-contour + node builtins resolve) |
| `routes/player/*` imports generation implementation (`workflows/*`, `video-timeline`, `waveform-service`, `middleware`, `image/`, `services/`) | **NONE** (P2) |
| `routes/player/*` reads `config.*` directly | **NONE** (P4; `outputRoot` seam) |
| `routes/player/*` uses global host singletons | **NONE** (P2 — singletons are unreachable without requires; all state arrives via DI) |
| `generation-routes.cjs` imports player route implementation | **NONE** (P3; the vestigial `playerModel` destructure was removed) |
| `generation-routes.cjs` registers player endpoints | **NONE** (P3 — none of the 17 route literals present) |
| Cyclic dependency generation ⇄ player | **IMPOSSIBLE** (P2+P3 — no require edge in either direction) |

Generation-leg knowledge (ffprobe, LTX alignment tax, ffmpeg, auth middleware) reaches the contour **only** as `playerPorts` functions.

### 2.3 VBook dependencies

Goal state `Player → playerModel → VBook runtime` holds:

1. `player/index.cjs` → `../book/book-model.cjs` → `@animastor/vbook-runtime/book-model.cjs` (one-line shim). Guarded by phase6 T1/T3.
2. All contour book-content reads go through `playerModel.loadBook` (phase6 T5 + audit P6). No direct `book.loadBook` / `book.saveBookBundle` in the contour.
3. `bookProjections` (`findSceneRuntimeData` / `collectSceneUnits`) — pure read projections; after the physical VBook move the contour receives them from `@animastor/vbook-runtime` (host shims `backend/src/book/index.js` already exist). No new facade created; the VBook API is not duplicated.

No Book dependency of the Player needs to disappear after the VBook move — both paths already resolve to the published package.

### 2.4 Host seams (final shape)

| Seam | Verdict | Note |
|---|---|---|
| `outputRoot` | ✅ minimal, keep | Replaces direct `config.OUTPUT_DIR` reads (booksRoot injection precedent `fb411c61`). Path semantics unchanged. |
| `playerPorts` | ✅ minimal, keep | Exactly `{ assertBookAccess, computeVideoStartMs, computeWaveform }` (P5). |
| `computeIuReady` | ✅ minimal, keep | Pure math, shared owner stays `routes/book/iu-progress-utils.cjs`. |
| `videoTimeline` (module re-export) | ❌ **REMOVED by this audit** | Was wider than needed: it handed the whole host module (imports `workflows/video` + `config`) into the contour while the single needed function already existed as `playerPorts.computeVideoStartMs`. `scene-data.cjs` now calls `ctx.playerPorts.computeVideoStartMs`; the routeDeps key is gone. |

No seam hides a generation dependency: every generation-domain implementation sits behind a port function, and the implementation modules never enter the contour's require graph.

### 2.5 Artifact naming ownership

`routes/player/artifact-naming.cjs` is the **read-side (Player-serving) expression of one cross-domain contract**:

- **Writers (canonical producers):** generation/storage — `storage/filesystem-store.js` (`makeSceneAudioFilename`, `makeChunkAudioFilename`, `makeChunkImageFilename`, `makeIUImageFilename`, `makePreviewFilename` + inline video/image templates) and the video group grammar `${prefix}_gN.mp4` (video-orchestrator).
- **Reader:** `artifact-naming.cjs` — the single place the Player contour reconstructs filenames. Zero requires (P7) → physically moveable with the package.
- **Generation does NOT import the Player module** (P7) — the contract is pinned byte-identical by the guard test instead (`iuImageName('…','iu1') === makeIUImageFilename('…','1')`: the URL `:iuId` carries the `iu` prefix; `preview.js` strips `^iu` before the writer call).
- **Disposition:** MOVE with the Player package. At extraction time generation may keep its own writer functions; the P7 byte-identity pin is the drift guard. Long-term home (optional): `@animastor/vbook-runtime` schema territory — out of scope here.
- No filename string or runtime semantic was changed by this audit.

### 2.6 HTTP route parity — PROVEN

Functional probe P1 registers the player registrar and asserts **exactly** the frozen 17-endpoint surface (method + path), byte-identical to the pre-split inventory extracted from `4d1f6f0e~1` (`git grep app\.` over `generation-routes.cjs` + `chunks-routes.cjs`):

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

Generation leg (`/api/v1/generate`, `/api/v1/worker/*`, `/api/v1/book/:id/progress-stream`, `/gpu/task/*`) unchanged and excluded from the player registrar (P1). Behavioral contract (Range/206/ETag/If-Range/304/416, timings persistence, waveform) covered by `scene-audio-range.test.js` (11 cases), `scene-timings.test.js` (6 cases), `video-timeline.test.js`. Auth semantics unchanged: app-level `requireBookAccess` guards for scene/iu-image/preview stay in `backend.cjs`; chunk-keyed in-handler ownership via `playerPorts.assertBookAccess` (pre-auth passthrough preserved).

### 2.7 Architecture guards

New: `backend/tests/architecture/player-route-split.test.js` (the file the split code referenced but that had never been committed — blocker fixed):

- **P1** route-surface parity (17 frozen endpoints; no generation endpoint registered by the player contour)
- **P2** require isolation (forward direction — also makes player→generation cycles impossible)
- **P3** reverse direction (generation cannot import player implementation or register player endpoints)
- **P4** no direct `config.*` access from the contour; `outputRoot: config.OUTPUT_DIR` wiring pinned
- **P5** seam shape (`playerPorts` exactly 3 ports; wide `videoTimeline` module seam banned from returning)
- **P6** book access through `playerModel` only; `bookProjections` narrow seam; facade depends only on the Book Model layer
- **P7** naming grammar dependency-free, writer-identical, imported by nobody outside the contour

Existing: `phase6-editor-player.test.js` T1–T7 (facades, frozen contour require sets, no direct Redis/PG in contour routes, frontend API seam).

### 2.8 Future package file list — `packages/animastor-player/`

**MOVE** (physically transferable without code changes):
- `backend/src/routes/player/player-routes.cjs`
- `backend/src/routes/player/player-shared.cjs`
- `backend/src/routes/player/scene-media.cjs`
- `backend/src/routes/player/scene-data.cjs`
- `backend/src/routes/player/iu-media.cjs`
- `backend/src/routes/player/playback-queue.cjs`
- `backend/src/routes/player/artifact-naming.cjs`
- `backend/src/player/index.cjs`
- their tests: `scene-timings.test.js`, `scene-audio-range.test.js`, `tests/architecture/player-route-split.test.js` (path constants re-aimed; helpers dual-location pattern like `WORKER_PKG_DIR`)

**PORT** (host provides at composition root; minimal interfaces):
- `playerModel` — `{ loadBook(bookId, opts?), getBookIdentity(bookId), getBookManifest(bookId) }`
- `outputRoot` — `string` (absolute artifact root)
- `playerPorts` — `{ assertBookAccess(req, bookId) → workspace|null; computeVideoStartMs(ius, buildId, bookId, chapterId, sceneId, outputRoot) → Promise<boolean>; computeWaveform(audioPath) → Promise<number[]> }`
- `computeIuReady(redis, sceneAssetsRepo, bookId, chapterId, sceneId, total) → Promise<number>`
- `bookProjections` — `{ findSceneRuntimeData(loadedBook, chapterId, sceneId), collectSceneUnits(scenePayload) }`
- `redis` (client), `getChunk(id)`, `getAllChunks(bookId)`, `getBookWindowStatus(bookId)`
- `iuRepo` — `{ getImageUnitsForScene, upsertImageUnit, upsertIuTiming }`; `sceneAssetsRepo` (pass-through)
- `image` — `{ getSceneDuration(buildId,b,c,s) → Promise<number>; getOrCreatePreview(b,c,s,iuId,buildId) → Promise<{path,created}|null> }`
- `state` — `{ getAssetStates(redis,b,c,s), AssetState }`; `activeScenes` — `{ addActiveScene(redis,b,c,s) }`; `placeholderAudio` — `{ ensurePlaceholderAudio(buildId,b,c,s) }`
- `layerConfig` — `{ get(redis, bookId) }`; `utils` — `{ log(msg) }`

**STAY** (host-side infrastructure): `backend.cjs` wiring, `video/video-timeline.js`, `services/waveform-service.js`, `middleware/auth-context.js`, `routes/book/iu-progress-utils.cjs`, `helpers/redis-helpers.cjs`, `storage/postgres/repositories/{iu-repo,scene-assets-repo}.js`, `image/`, `state/`, `services/{placeholder-audio,active-scenes}`, `config/runtime-config`, app-level auth guards for `/api/v1/scene|iu-image|preview/:bookId`.

**VBOOK** (obtained from `@animastor/vbook-runtime`): book-model facade backing `playerModel`; `findSceneRuntimeData` / `collectSceneUnits` behind `bookProjections`.

**DELETE/OBSOLETE** (after the move): `backend/src/routes/book/chunks-routes.cjs` registrar stub (empty since the split; `routes/book-routes.cjs` require can be dropped at extraction). Nothing else.

### 2.9 Remaining blockers

**None.** Every dependency of the contour is either Player-owned, a node builtin, or arrives through a named DI seam with a documented minimal interface. The only cross-domain knowledge (auth, ffprobe/LTX tax, ffmpeg) enters as `playerPorts` function implementations owned by the host.

### 2.10 Extraction sequence

1. Create `packages/animastor-player/` skeleton (package.json, no runtime deps — the contour requires nothing beyond node builtins; dev deps: mocha/chai per repo pattern).
2. `git mv` the 8 MOVE files + their tests; re-aim test path constants (dual-location helper pattern from the worker relocation).
3. Composition root (`backend.cjs`): require the registrar from `@animastor/player`; seam wiring unchanged (§2.4).
4. VBook edges: swap `book-model.cjs`/`bookProjections` sources to `@animastor/vbook-runtime` imports inside the package.
5. Delete the `chunks-routes.cjs` stub + its `book-routes.cjs` require (DELETE list).
6. Run: player/backend tests, architecture suite (P1–P7, T1–T7 must keep passing), scene timing/audio-range, video timeline, waveform, full backend suite.
7. Commit the move as a single atomic commit (no behavior change — P1 proves the route surface).

---

## 3. Audit-diff summary (this document's commit)

- `scene-data.cjs`: `videoTimelinePort` dep removed → `ctx.playerPorts.computeVideoStartMs`; `deps.book.*` → injected `bookProjections` (pure VBook read projections). Behavior identical (same function references).
- `player-routes.cjs`: dead `config` destructure removed; `videoTimeline` destructure removed; scene-data now receives `bookProjections` instead of the whole book module.
- `backend.cjs`: `videoTimeline` key removed from `routeDeps` (wide module seam narrowed away; `playerPorts.computeVideoStartMs` wiring unchanged).
- `generation-routes.cjs`: dead `playerModel` destructure removed.
- `artifact-naming.cjs`: doc comment clarified for `iuImageName` (URL `:iuId` carries the `iu` prefix) — strings unchanged.
- Tests: `scene-timings` / `scene-audio-range` stubs re-aimed to the narrowed seams; new `tests/architecture/player-route-split.test.js` (P1–P7).
- No HTTP contract, filename, or runtime-semantic change.

## VERDICT: READY FOR PLAYER PHYSICAL MOVE
