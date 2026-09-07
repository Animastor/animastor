# PLAYER PACKAGE EXTRACTION READINESS AUDIT — Player → `packages/animastor-player/`

**Status:** READ-ONLY reconnaissance. No production code changed, no files moved, no package created, no extraction started.
**Date:** 2026-09-07
**Baseline:** HEAD `fb411c61` ("arch(vbook): prepare VBook runtime package extraction" — landed during this audit; all claims below were measured against it)
**Context:** Worker physically in `packages/` (9f6b5808), GPU Hub / contracts / ai-connector / comfyui-connector in `packages/`, VBook runtime preparation **COMPLETE** (`fb411c61`: booksRoot port, structure-detector port, package skeleton, C1 schema, VB-T1..T5 guards — physical move is the next task elsewhere). This audit positions Player as the next candidate in that queue.
**Related:** `PHASE_6_EDITOR_PLAYER.md` (facade + pinned legacy edges), `PHASE_7_EXTRACTION_READINESS.md` §2.3/§4.6 (Player contour 🟠 verdict + forced sequence), `PHASE_NEXT_MODULE_EXTRACTION_RECONNAISSANCE.md` §4.6 (Player ranked #3, "blocked two levels down"), `MODULAR_PRODUCT_ARCHITECTURE.md` §6/§13/§18/§26 (Player as future L5 product, graduation checklist), `VBOOK_RUNTIME_RELOCATION_CHECKLIST.md` (upstream prerequisite), `WORKER_PACKAGE_RELOCATION_AUDIT.md` (the `packages/` move playbook), `docs/03-audit/PLAYER_AUDIT.md` + `docs/05-frontend/PLAYER_STATE_MACHINE_DESIGN.md` + `ANDROID_WEB_PARITY.md` (player behavior contracts).

---

## Executive summary

"Player" in this repo is **four partial implementations of one contract**, not a module:

1. **Backend playback model** — `backend/src/player/index.cjs` (51 LOC facade over the Book Model). 🟢 Clean, guarded (Phase 6 T1/T3), extractable the day `@animastor/vbook-runtime` lands.
2. **Backend playback HTTP contour** — media/queue/status serving **mixed into** `routes/generation-routes.cjs` (1513 LOC: 3 responsibilities — playback serving + legacy import/generation + hub callbacks) and `routes/book/chunks-routes.cjs` (playback queue + PG-derived progress). 🔴 The single largest mixing point on the whole boundary (confirmed at HEAD, §8 of PHASE_NEXT recon).
3. **Web playback engine** — `frontends/app/src/state/playbackStore.ts` (2117 LOC engine) + `PlayPage.tsx` + `playbackGate.ts` + `mediaCache.ts`. 🟡 Cohesive and well-tested (11 suites), but circularly coupled with `generateStore.ts` (documented runtime-only cycle) and shares `positionStore` / `resourceInvalidations` / `api/client` / `api/models` with the rest of the app **by design** (thin client, desktop workspace modes).
4. **Android playback** — `PlaybackViewModel.kt` + `PlayFragment.kt` + `PlayerGate.kt` + `VideoCache.kt` (~3,600 LOC) in a single-gradle-module app. 🟡 Deliberately monolith; parity is contractual, not code-shared.

**The forced extraction sequence (established by Phase 7 §4.6, unchanged at HEAD): VBook physical move → route split → Player.** The VBook step is now prepared and merely awaiting its physical move. The route split has not started — that is the only *new* work between today and a physically extractable backend Player contour.

**Verdict: READY AFTER PREPARATION.** Not READY today: the playback contour sits in the same file as the legacy import leg and hub callbacks (Phase 6 T5/T6 pins 15 frozen legacy edges onto `generation-routes.cjs`), serves artifacts via hardcoded `OUTPUT_DIR` + an undeclared **artifact-naming grammar** owned by generation, reads PG/Redis directly, and its readiness endpoints (`assets-state`, `progress-stream`) serve the Generator as much as the Player. Not NOT-READY: the model facade is frozen and guarded, the de-facto HTTP contract is fully enumerable from three consumers (web/Android/tests), every blocker has a documented port/injection shape, and the repo has now executed the same preparation→move playbook five times.

| Question | Answer |
|---|---|
| Player model facade extractable today | **YES** — 51 LOC, one dependency (`book-model.cjs` → `@animastor/vbook-runtime`) |
| Playback HTTP contour extractable today | **NO** — 3-responsibility file mix + PG/Redis/OUTPUT_DIR coupling (15 frozen edges) |
| De-facto Player API contract enumerable | **YES** — 17 playback routes (15 in generation-routes + 2 in chunks-routes), 3 consumers (web, Android, tests); no formal contract doc yet |
| Frontend engine part of the package | **NO (recommended)** — stays thin-client app code by design; Android stays monolith |
| Hidden dependencies found | **YES** — artifact-naming grammar, ffprobe/ffmpeg spawning, `workflows/video` imports in the serving path, frontend `generateStore ⇄ playbackStore` cycle |
| Forced upstream step | VBook physical move (prepared) → `generation-routes.cjs` split (not started) |
| Extraction risk after preparation | **MEDIUM (3/5)** — higher than VBook, below Hub (no cross-service Redis) |

---

## 1. Current Player boundary (measured at HEAD)

Phase 6 created the *model* seam; the HTTP contour was deliberately left mixed and frozen. Measured today:

```
                        ┌────────────────────────────────────────────┐
                        │ backend/src/player/index.cjs  (facade, 🟢)│
                        │ createPlayerModel → Book Model (read-only)│
                        └──────────────┬─────────────────────────────┘
                                       │ playerModel (routeDeps)
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
routes/generation-routes.cjs   routes/book/chunks-routes.cjs   routes/debug-routes.cjs
(1513 LOC, 3 responsibilities) (244 LOC, playback queue +     (waveform dep only —
  • playback media serving       PG progress merge)            shared computeWaveform)
  • legacy import + generation
  • worker status + hub callbacks
```

Frontend:

```
main.tsx ──wire──▶ playbackStore.ts (2117) ◀──cyclic──▶ generateStore.ts (1504)
                     │  imports                        │  closeBook (player reset)
  PlayPage.tsx ◀─────┤  signals + attachVideo
  playbackGate.ts ◀──┤  pure gate math
  mediaCache.ts ◀────┤  Cache API blobs
  positionStore.ts ◀─┤  external seek (shared w/ Navigate + Edit)
  resourceInvalidations ◀─ invalidateBookContent (AI patches)
  api/client.ts ◀────┤  API_BASE + getJson/getBlob/mediaUrl
```

**Key property:** every player data read on the backend goes through `playerModel` (Phase 6 T5) except the pinned import/generation legs (3+3 call sites); every frontend URL goes through `api/client.ts` (Phase 6 T7 — zero `/api/v1` literals in `pages/`/`state/`). The seams exist and are guarded — what does not exist is a *physical* boundary for the contour.

---

## 2. File / directory inventory

### 2.1 Backend — core Player code

| File | LOC | Role | State |
|---|---|---|---|
| `backend/src/player/index.cjs` | 51 | Phase 6 facade: `createPlayerModel({bookModel})` → `loadBook/getBookIdentity/getBookManifest` | 🟢 guarded T1/T3 |
| `backend/src/routes/generation-routes.cjs` | 1513 | Player contour (media serving, ~15 routes) **+** generation/import leg + worker status + `/gpu/task/*` callbacks | 🔴 mixed; T5/T6-pinned; 14 direct `OUTPUT_DIR` joins (+1 in chunks-routes) |
| `backend/src/routes/book/chunks-routes.cjs` | 244 | `GET /book/:id/chunks` (playback queue), `GET /book/:id/assets-state` (readiness) | 🔴 PG + Redis merge |
| `backend/src/routes/book/iu-progress-utils.cjs` | 70 | Pure IU-progress math for assets-state | 🟢 unit-tested, moveable |
| `backend/src/services/waveform-service.js` | 131 | `computeWaveform` — ffmpeg peaks + tmpdir cache | 🟡 ffmpeg dep; shared with debug-routes |
| `backend/src/video/video-timeline.js` | 312 | `computeVideoStartMs` — ffprobe probing of served artifacts; **requires `workflows/video/video-workflows`** (`selectWorkflowGroups`, `toValidLTXFrames`) + `config` | 🔴 generation-domain knowledge in serving path |
| `backend/src/backend.cjs` | — | Composition root: `playerModel: createPlayerModel({ bookModel })` in `routeDeps` (T4) | wiring point |

### 2.2 Backend — support code the contour reaches (via `deps` or require)

| Module | Used for | Owner today |
|---|---|---|
| `storage/postgres/repositories/iu-repo` | storyboard/timings IU rows | storage |
| `storage/postgres/repositories/scene-assets-repo` | assets-state IU ready counts | storage |
| `state/scene-state` + Redis chunk keys (`animastor:chunk:*`) | playback queue + status | runtime/state |
| `services/progress-pubsub.cjs` | progress SSE channel naming | services |
| `middleware/auth-context` | `checkBookAccess` / `importBookAllowed` | middleware |
| `image.getSceneDuration` / `image.getOrCreatePreview` | timings + preview serving | image pipeline |
| `config/runtime-config` (`OUTPUT_DIR`) | artifact root | config |

### 2.3 Frontend (web) — playback engine + UI + controls

| File | LOC | Role | Player-exclusive? |
|---|---|---|---|
| `state/playbackStore.ts` | 2117 | Player engine: queue, preload(3), gapless 2×audio, IU cycling, video reveal state machine (T6), seek, lifecycle wiring | mostly; imports shared stores |
| `state/playbackGate.ts` | 83 | Pure reveal-gate math (T2.2) | **YES** |
| `pages/PlayPage.tsx` | 307 | Player UI surface (viewport, layers, chips, fullscreen) | **YES** |
| `cache/mediaCache.ts` | 83 | Cache API media blobs (SimpleDiskCache parity) | **YES** (Settings "clear cache" uses it) |
| `lib/waveform.tsx` | 326 | Waveform canvas | NO — EditPage timeline |
| `state/positionStore.ts` | 27 | Shared active position | NO — Navigate/Edit/Generate share |
| `state/resourceInvalidations.ts` | 69 | Invalidation bus | NO — app-wide |
| `state/resilientReloader.ts` | 212 | Bounded retry/recovery | NO — Edit/Generate/Assistant use |
| `state/generateStore.ts` | 1504 | Generation VM; owns `bookId/buildId/SceneRef/onPlaybackPrepared` | NO — **co-owner of player state** |
| `api/client.ts` | 250 | `API_BASE`, `getJson/getBlob`, `mediaUrl`, `retryWithBackoff` | NO — app-wide seam |
| `api/models.ts` | 835 | `BookData/SceneRef/sceneRefs/StoryboardResponse/SceneStatusResponse` types | NO — shared |
| Consumers | — | `NavigatePage` (seekToPosition), `EditPage` (seek, waveform, invalidateDeleted*), `SettingsPage` (closeBook, clearCache), `main.tsx` (wirePlayback*), `AppShell` (playerPhase → `/play` routing) | integration points |

### 2.4 Android (parallel implementation, parity contract)

`ui/PlaybackViewModel.kt` (1086), `ui/PlayFragment.kt` (1845), `ui/PlayerGate.kt` (88), `ui/WaveformView.kt` (315), `util/VideoCache.kt` (84), `util/SimpleDiskCache.kt` (76), `util/MediaDecoder.kt` (14), `repository/Repository.kt` fetchers (`getSceneStatus/Storyboard/Audio/Video/Waveform`, `getIuImage/Preview`, `getChunk*`), `test/.../PlayerGateTest.kt` (172). Single gradle module by design — **not** a relocation target; its API consumption is the parity contract.

### 2.5 Tests

**Backend (player-contour behavior, currently host-owned):**

| Suite | Covers | Move at extraction? |
|---|---|---|
| `tests/architecture/phase6-editor-player.test.js` (T1–T7, 18 tests) | facade contract, boundary scan, wiring, facade-bypass pins, frozen require baselines, frontend URL seam | stays host-side (re-aimed), package gets its own boundary guard |
| `tests/scene-timings.test.js` | GET/PUT timings recompute + persistence | **moves** (registers the route factory with stubbed deps) |
| `tests/scene-audio-range.test.js` | Range/206/ETag/If-Range streaming semantics | **moves** |
| `tests/iu-progress-utils.test.js` | pure IU math | **moves** |
| `tests/video-timeline.test.js` | video_start_ms alignment math | **moves** |
| `tests/generation-routes.test.js` (book leg) | regenerate/cancel/generate-next | stays (generation contour) |
| `tests/private-worker-{auth,phase2,visibility}.test.js`, `worker-share-policy.test.js` | register generation-routes for worker status/counts; stub `playerModel` | stays; will consume the split route files |
| `tests/architecture/phase7-extraction-readiness.test.js` | `backend/src/player/index.cjs: ../book/book-model.cjs` in the P7-T4 allowed set | re-aim after move |

**Frontend (engine behavior, app-owned):** 11 playback-related suites in `state/` — `playbackStore.test.ts`, `playbackBookSwitch`, `playbackCacheInvalidation`, `playbackGate`, `playbackRevealOvershoot`, `playbackStickySeeking`, `playbackTargetCleanup`, `playbackVideoListener`, `generateStore.analysis` + `__tests__/auth-book-session` (player wiring) + `resilientReloader` + `resourceInvalidations` — plus `cache/mediaCache.test.ts`. With `src/state + src/cache`: **13 files / 97 tests, all green at HEAD** (1 unrelated pre-existing failure in `features/workers/privateWorkers.test.ts`, see §8-R14).

### 2.6 Build / package / tooling touching the contour

- `docker-compose.yml` — backend image build context = `./backend`, mounts `./backend/src:/app/src`; the repo-root `node_modules` symlink mechanism has a **documented docker build-context caveat** (job-schema.js header / Phase 9C precedent) — applies to a future `packages/animastor-player`.
- `frontends/app/vite.config.ts` — dev proxy `/api` → backend; nothing player-specific.
- `scripts/syntax-smoke.sh` — scans `backend/src` wholesale; a moved package must be added to its target list (worker precedent P11).
- `proxy/conf/default.conf` — nginx routes `/api/v1/*` to backend; player endpoints have no special-casing (only `ai-connector` does).

---

## 3. Dependency map

### 3.1 Who imports Player (inbound)

| Consumer | Via | Notes |
|---|---|---|
| `backend.cjs` | `createPlayerModel` + `routeDeps.playerModel` | composition root only (T4) |
| `routes/generation-routes.cjs`, `routes/book/chunks-routes.cjs` | destructured `playerModel` dep | 7 call sites, all `loadBook` reads |
| Tests T4/T5 + 4 worker suites | require facade / stub `playerModel` | pins |
| **Nobody else requires `backend/src/player/**`** | — | the facade is a leaf; extraction has **zero inbound deep-imports** to rewrite |
| Frontend: `playbackStore` consumed by 7 files (main, AppShell, Play/Navigate/Edit/Settings pages, generateStore) | ES imports | app-internal; not a package boundary question |

### 3.2 What Player imports (outbound)

**Facade (`player/index.cjs`):** exactly 1 — `../book/book-model.cjs`. After the VBook physical move this becomes `@animastor/vbook-runtime`'s model entry (via host shim or direct). Nothing else. **Zero cycles** (book domain is in no SCC; player is not in any SCC).

**Playback contour (measured requires/deps in the player routes):**

| Dependency | Kind | Mandatory / invertible |
|---|---|---|
| `playerModel` (Book Model) | injected dep | **mandatory** — the whole point; becomes the package's model port |
| `config.OUTPUT_DIR` | config const | **mandatory but injectable** — pass `outputRoot` (booksRoot precedent, `fb411c61`) |
| PG: `iu-repo`, `scene-assets-repo` | direct require | **invertible** — behind a `PlaybackProjection` port (Phase 7 §4.6 item 3) |
| Redis: chunk keys, `progress-pubsub` channel | via injected `redis` + deps | **invertible** — playback queue port + progress port |
| `middleware/auth-context` (`checkBookAccess`) | direct require | **mandatory host concern** — inject `assertBookAccess` (host keeps auth) |
| `video/video-timeline` | direct require | **should NOT move with Player** — it imports `workflows/video/video-workflows` (generation domain) + `config`; expose it as an injected `computeVideoStartMs` port |
| `services/waveform-service` (ffmpeg) | injected dep | **decision required** — used by player waveform route + debug-routes + EditPage; either moves (with ffmpeg declared) or stays host-side as an injected `computeWaveform` port |
| `image.getSceneDuration`, `image.getOrCreatePreview` | injected dep | **should NOT move** — generation/image-pipeline internals; inject as ports |
| `multer`, `fs`, `path` | npm/builtins | multer belongs to the import leg (stays), fs/path fine |

**Frontend engine imports:** `api/client` (seam, stays), `api/models` (types, stays), `playbackGate` (moves if ever), `mediaCache` (moves if ever), `positionStore` + `resourceInvalidations` + `generateStore` (**shared app stores — the reason the frontend engine is NOT part of the package**).

### 3.3 Cycles

- Backend: none on the Player path (facade → book only; contour routes are leaves registered by `backend.cjs`).
- Frontend: **one documented cycle** — `playbackStore.ts ⇄ generateStore.ts` (`generateStore.ts:23` imports `closeBook`; `playbackStore.ts:29` imports `onPlaybackPrepared` + `SceneRef`). Comment in source calls it "Runtime-only circular import" mirroring MainActivity. Both modules are app-internal; the cycle is a fact to record, not to break now — but it is disqualifying for moving either module into a package alone.

### 3.4 Dependencies that must NOT move with Player

1. The legacy import/generation leg (`POST /api/v1/generate`, regenerate/cancel/generate-next, `/gpu/task/result|error`) — generation contour, pinned by T5/T6.
2. Worker status/counts (`runtime/worker-health`, `ai-service` health) — runtime contour.
3. Progress SSE (`progress-pubsub`) — serves the Generator UI as much as the Player (generateStore.ts:937 consumes it, not playbackStore).
4. `video-timeline`'s `workflows` dependency, `image` pipeline internals.
5. `assets-state`'s generation-progress half (dirty-unit counters, layer config) — shared with Generator gating.
6. Frontend `generateStore`, `positionStore`, `resourceInvalidations`, `resilientReloader` — app-shared by design.
7. Android app module — stays a monolith; only its **consumed URL set** becomes the parity contract.

---

## 4. De-facto Player API (the contract to freeze before packaging)

Enumerated from all three consumers (web playbackStore/EditPage/NavigatePage, Android Repository, backend tests):

| Endpoint | Used by | Notes |
|---|---|---|
| `GET /book/:bookId` | web, Android | shared with Editor — book JSON |
| `GET /scene/:b/:ch/:sc/status` | web, Android | readiness + `video_version` (mtime ETag semantics — regeneration invalidation) |
| `GET /scene/:b/:ch/:sc/storyboard` | web, Android | PG-first, book-JSON fallback, **writes back computed rows** (upsert — a hidden write!) |
| `GET /scene/:b/:ch/:sc/audio` | web, Android | 206 Range + ETag/If-Range (pinned by scene-audio-range) |
| `GET /scene/:b/:ch/:sc/video` | web, Android | merged `.mp4` → first `_gN.mp4` fallback |
| `GET /scene/:b/:ch/:sc/image` | web | scene png |
| `GET /scene/:b/:ch/:sc/waveform` | web (EditPage), Android | ffmpeg-derived peaks |
| `GET/PUT /scene/:b/:ch/:sc/timings` | web (EditPage), Android | GET is player-facing; PUT is Editor-facing |
| `GET /iu-image/:b/:ch/:sc/:iu` | web (Edit zoom, player IU), Android | |
| `GET /preview/:b/:ch/:sc/:iu` | web (Navigate thumbs, Edit), Android | may *generate* a preview (`getOrCreatePreview`) |
| `GET /chunk/:id` (+`/audio|/image|/video|/storyboard`) | Android legacy, tests | chunk-keyed variants |
| `GET /book/:bookId/chunks` | web (generateStore warm), Android | playback queue w/ dedup + cover_chunk_id |
| `GET /book/:bookId/assets-state` | web (Generate gating), Android | readiness gating — **shared with Generator** |

**Non-endpoint contract elements that MUST be frozen too (the hidden ones):**

- **Artifact naming grammar** — `${book}_${chapter}_${scene}.mp3|.mp4|.png`, `${...}_${iu}.png` (iu images), `${...}_iu*.png` (iu listing glob), `${...}_gN.mp4` (group clips). The player contour *reconstructs* these strings (14+1 `OUTPUT_DIR` joins); generation *writes* them. This grammar is an undeclared C-level contract between Generation and Player — it must become a shared naming module (or move into `@animastor/vbook-runtime` schema territory) **before** the contour can move.
- **`video_version` = file mtime** semantics (scene status route) — Android cache keying depends on it.
- **build_id resolution rule** — manifest is the single source of truth; client `build_id` is cache-key only (getEffectiveBuildId).

---

## 5. Proposed package boundary

```
packages/animastor-player/                    (@animastor/player, L1 — internal package)
├── src/
│   ├── index.js                  public entry: createPlayerModel + createPlayerRoutes(app, deps)
│   ├── model.js                  Player Model facade (from backend/src/player/index.cjs)
│   ├── routes/                   playback media + queue + status routes (AFTER the route split)
│   │   ├── scene-media.js        /scene/*/audio|video|image + Range streaming
│   │   ├── scene-data.js         /scene/*/status|storyboard|timings(GET)
│   │   ├── iu-media.js           /iu-image/*, /preview/*
│   │   └── playback-queue.js     /book/:id/chunks + readiness projection
│   ├── iu-progress.js            pure IU math (from iu-progress-utils.cjs)
│   └── ports/                    REQUIRED injected interfaces (constructor throws without them)
│       ├── playback-projection.js   (getImageUnitsForScene, assets ready counts — PG behind)
│       ├── media-fs.js              (resolveArtifact paths; outputRoot injected — naming grammar lives HERE)
│       ├── waveform.js              (computeWaveform — host impl keeps ffmpeg)
│       ├── video-timeline.js        (computeVideoStartMs — host impl keeps ffprobe+workflows)
│       └── auth.js                  (assertBookAccess — host keeps middleware)
├── test/                         package-owned suite (scene-timings, scene-audio-range,
│                                 iu-progress, queue dedup — moved from backend/tests)
└── package.json                  deps: none beyond host-injected ports (express-free:
                                  route factory receives `app`)
```

**What stays outside:**

| Stays in | Item | Why |
|---|---|---|
| `backend/src/routes/generation-routes.cjs` (split) | import/generation leg, `/gpu/task/*`, worker status/counts, progress SSE | generation + runtime contours (Phase 6 §6.1 — "generation-pipeline refactor" was always a separate task) |
| backend host | `waveform-service`, `video-timeline`, `image` pipeline, PG repos, Redis, auth middleware | injected ports; ffmpeg/ffprobe + workflows are generation-domain |
| `@animastor/vbook-runtime` | book content, manifest, identity | the model port target |
| web app (`frontends/app`) | playbackStore, PlayPage, gate, mediaCache, all shared stores | thin client by design; desktop workspace modes + generateStore cycle make it app-internal; Android parity is maintained at the HTTP-contract level, not code level |
| future `@animastor/contracts`-style registry (optional) | Playback HTTP API contract (the §4 table) | C-registry entry; can start as a frozen doc + contract test in the package |

**Public API of the future package:**

```js
const { createPlayerModel, createPlayerRoutes } = require('@animastor/player');
const playerModel = createPlayerModel({ bookModel });            // vbook-runtime port
createPlayerRoutes(app, { playerModel, ports: { playbackProjection, mediaFs, waveform, videoTimeline, auth }, log });
```

**Internal (hidden) after extraction:** route handlers, IU math internals, Range-streaming helper, naming-grammar builder, queue dedup logic, ETag computation.

**Existing integration points that become package API:** `routeDeps.playerModel` (→ package import in backend.cjs), the route registration call in backend.cjs (→ `createPlayerRoutes`), the `playerModel` destructuring in the two contour route files (→ the split files' constructor args).

---

## 6. External dependencies

| Layer | Dependency | Disposition |
|---|---|---|
| npm | **none new** — express/fs/path arrive via the injected `app`; ffmpeg/ffprobe stay host-side behind ports | package.json declares zero runtime deps (worker precedent) |
| Model | `@animastor/vbook-runtime` (after its physical move) | peer/dependency via repo-root symlink during transition (contracts precedent + documented docker build-context caveat) |
| Infra | PG, Redis | **forbidden in `src/**`** (guard-extend the Phase 6 T3 FORBIDDEN_SPEC) — only behind ports |
| Host config | `OUTPUT_DIR` | injected `outputRoot` (booksRoot precedent from `fb411c61`) |
| Cross-service | none (no hub, no worker protocol, no shared Redis families) | the reason risk is 3/5, not 4-5 |
| Toolchain | mocha (host) / vitest (frontend — unaffected) | package suite uses the ai-connector/worker zero-infra harness pattern |

---

## 7. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | `generation-routes.cjs` 3-responsibility mix — any move before the split drags generation/hub/runtime requires into the package | **HIGH** | route split is precondition step 2; T6 baseline guides the cut (each frozen edge is labeled playback vs generation in §3.2) |
| R2 | **Undeclared artifact-naming grammar** shared with generation (15 `OUTPUT_DIR` joins total, `_gN.mp4` glob, `_iu` prefix) — moving serving without moving naming makes the grammar a cross-package string coupling | **HIGH** | naming module inside the package + generation consumes it (or moves to vbook schema); freeze with a contract test |
| R3 | Hidden **writes** in GET routes (storyboard upserts computed IU rows, preview `getOrCreatePreview` generates media, timings GET persists) — the "read-only player" story is not fully true on the contour | MEDIUM-HIGH | document as port semantics (write-back projection); keep behavior byte-identical |
| R4 | `assets-state` + `progress-stream` serve Generator as much as Player — splitting them out would break Generate gating; keeping them in would drag Redis/PG | MEDIUM | readiness projection port; SSE stays host-side (generation contour) |
| R5 | Docker: backend image build context is `./backend`; a `packages/` player needs compose/mount/bake-in decisions (documented Phase 9C caveat) | MEDIUM | same resolution as contracts/worker (symlink + explicit compose wiring in the move commit) |
| R6 | Guard rewrites: phase6 T1–T7, P7-T4 allowed-set entry, syntax-smoke target list, 4 worker suites re-registering split routes | MEDIUM | one-commit re-aiming playbook (worker T1–T17 precedent); guards stay, only expected values change |
| R7 | Frontend `playbackStore ⇄ generateStore` cycle blocks any *frontend* package split indefinitely | MEDIUM | accept: frontend stays thin client; record as the standing decision (mirrors Android monolith) |
| R8 | `video-timeline` imports `workflows/video/video-workflows` (generation domain) from inside the serving path | MEDIUM | injected `computeVideoStartMs` port; host keeps the module |
| R9 | ffmpeg/ffprobe + tmpdir caches (`animastor-waveforms`) are process-spawning runtime assumptions inside "player" behavior | LOW-MEDIUM | ports keep binaries host-side; package tests use injected fakes |
| R10 | Auth (`checkBookAccess`) inline in chunk-keyed media routes — package must not own authorization | MEDIUM | `auth` port required at construction |
| R11 | Android parity: contract drift between web/Android consumption (e.g. `video_version` semantics) breaks the Android app silently (no shared client) | MEDIUM | freeze §4 table as the contract test input; ANDROID_WEB_PARITY.md rows reference it |
| R12 | Tests currently stub `playerModel` inline in 4 worker suites + 2 scene suites — split changes module identity (`require` cache) | LOW | worker suites keep stubbing via routeDeps (unchanged); scene suites move into the package with fresh stubs |
| R13 | `chunk-keyed` legacy routes (`/chunk/:id/*`) are Android-consumed; dropping them during the split breaks Android | LOW | keep as-is in the package (queue routes) — removal is a separate deprecation with Android |
| R14 | Baseline noise: `privateWorkers.test.ts` has 1 pre-existing failure at HEAD (worker-source URL expectation, unrelated to player) | LOW | record as pre-existing; do not gate the player work on it |

**What can break after a physical move specifically:** compose mounts for the new package dir, syntax-smoke coverage, `.mocharc.json`/test bindings if the package needs host-side require hooks, the P7-T4 allowed-set string, phase6 T4 wiring regexes (if `backend.cjs` line moves), and any doc that hardcodes `backend/src/player` (PHASE_6/PHASE_7 docs are historical — convention says leave them, update normative ones).

---

## 8. Migration plan (future phase — NOT executed here)

| Step | Work | Exit criteria | Risks |
|---|---|---|---|
| **0. Prerequisite (owned elsewhere)** | VBook physical move per `VBOOK_RUNTIME_RELOCATION_CHECKLIST.md` | `@animastor/vbook-runtime` live; `book-model.cjs` shims work; full suite green | none added by this audit |
| **1. Dependency preparation** | (a) naming-grammar module extracted from the 15 `OUTPUT_DIR` joins (14 in generation-routes + 1 in chunks-routes); (b) `outputRoot` injection replaces `config.OUTPUT_DIR` reads in the contour; (c) ports sketched: playbackProjection, mediaFs, waveform, videoTimeline, auth | naming contract test green; zero `config.OUTPUT_DIR` literals in player routes; ports documented | R2, R3 — behavior must stay byte-identical (ETag/mtime, upsert timing) |
| **2. Route split (the big one)** | `generation-routes.cjs` → `player-routes.cjs` (media/queue/status) + slimmed generation file (import, callbacks, worker status, SSE); `chunks-routes.cjs` queue half → player, readiness half stays or goes to projection | every Phase 6 T5/T6 baseline re-pinned to the new files; all 2910 backend tests green; zero URL changes | R1, R4 — pure code motion inside backend/src, no package yet, instant rollback |
| **3. Package boundary** | create `packages/animastor-player/` skeleton (deps: none; ports: required); move facade + split routes + iu-progress; host `backend.cjs` switches to `createPlayerRoutes(app, {...ports})`; backend keeps a `routes/player-shim` only if tests need paths | package suite (`test/`) green standalone (no PG/Redis/host); `npm run test:arch` green with re-aimed guards | R5, R6, R12 |
| **4. Import rewrite** | `backend.cjs` + tests re-aim from `./player/index.cjs` / `./routes/generation-routes.cjs` to the package entry; P7-T4 set updated; phase6 T1–T7 re-aimed (T3 scope becomes package dir) | legacy grep: `backend/src/player`, `generation-routes` (player legs) only in historical docs | R6 |
| **5. Build/install/runtime wiring** | compose: package visible in backend container (symlink or mount — contracts precedent); syntax-smoke adds target; docker build verified | backend image boots, playback e2e (import → generate → play) green in compose | R5 |
| **6. Test migration** | move scene-timings/scene-audio-range/iu-progress/video-timeline(queue math only) into package `test/`; host keeps architecture + worker + integration suites | §26.5: `npm test` inside the package runs without host | R12 |
| **7. Legacy path removal** | delete `backend/src/player/`, old route registration lines; final repo-wide grep sweep | grep clean except historical docs; CHANGELOG entry | none new |

Order note: steps 2 and 3 may land as two commits minimum (code motion, then package motion) — matching the repo's preparation→move two-phase convention.

---

## 9. Test / validation plan (the contract that must hold after extraction)

**Behavior unchanged:**

- `scene-audio-range.test.js` — 206/304/ETag/If-Range semantics byte-identical (moves into the package).
- `scene-timings.test.js` — GET recompute + PUT clamp + PG persist-fallback ordering (moves).
- `iu-progress-utils.test.js` + queue-dedup cases from `chunks-routes` — pure math (moves).
- Frontend: all 13 app-side playback suites untouched and green (engine is not moving — that IS the parity proof for the web client).

**Public API preserved:**

- New package-side contract test pinning the §4 endpoint table: URL shapes, response field names (`audio_ready`, `video_version`, `cover_chunk_id`, `chunk_positions`, `scope_iu_total`, …) — consumed as a fixture by an Android-parity check (ANDROID_WEB_PARITY row).
- `createPlayerModel` facade contract (T1 semantics) re-homed in the package suite.

**Integrations work:**

- Backend integration: worker suites still register the (split) generation routes with stubbed deps — proves the split didn't change route registration contracts.
- E2E: compose `import → generate → play` golden path (§27.2 rule 5: golden E2E gates anything touching playback).
- Docker: backend container serves `/api/v1/scene/*/audio` with Range after the wiring step (R5 proof).

**No legacy imports / boundary enforced:**

- Extended Phase 6 T3-style guard: `packages/animastor-player/src/**` forbids `pg|ioredis|storage/|runtime/|orchestration/|services/|workflows/|middleware/|config` requires (port interfaces only) — with a negative control (the ai-connector/vbook VB-T pattern).
- P7-T1-analog inbound-isolation guard: nothing requires package internals by path.
- Repo grep gate: `backend/src/player`, `chunks-routes` playback legs, player-route requires in `generation-routes.cjs` → zero hits outside historical docs.

**Readiness:** package `npm test` runs with no PG/Redis/host (graduation §26.5); `npm pack --dry-run` clean (§26.10).

---

## 10. Definition of Done

1. `packages/animastor-player/` exists with the §5 layout; `backend/src/player/` and the playback legs of the route files are gone.
2. Zero runtime deps in package.json; all infra behind the 5 documented ports; construction throws on missing ports (editorModel precedent).
3. Package-owned suite green standalone; host architecture suites green with re-aimed pins (phase6, P7-T4, vbook guards unaffected).
4. §4 contract frozen (doc + contract test) and referenced by the Android parity table.
5. Naming grammar lives in one module consumed by both the package and generation.
6. Backend + frontend full suites green (baseline: 2910 backend passing + frontend 255/256 with the one pre-existing unrelated failure R14).
7. Compose e2e golden path green; `syntax-smoke.sh` covers the package dir.
8. Docs: this audit + a move report (the WORKER_PACKAGE_RELOCATION_AUDIT → move-commit pattern); normative docs (ARCHITECTURE.md layout, MODULAR_PRODUCT_ARCHITECTURE §6) updated in the move commit.

---

## 11. Files the future move will touch (concrete list)

**Move (into the package):** `backend/src/player/index.cjs`; playback route halves of `backend/src/routes/generation-routes.cjs` (audio/video/image/status/storyboard/waveform/timings-GET/iu-image/preview/chunk-media) and `backend/src/routes/book/chunks-routes.cjs` (chunks + assets-state projection); `backend/src/routes/book/iu-progress-utils.cjs`; tests `scene-timings.test.js`, `scene-audio-range.test.js`, `iu-progress-utils.test.js` (+ video-timeline math tests stay host-side — module stays host).

**Rewrite in place:** `backend/src/backend.cjs` (route registration + port wiring); `backend/src/routes/generation-routes.cjs` + `routes/book/generation-routes.cjs` (slimmed to generation); `backend/src/routes/book-routes.cjs` (chunks-routes registration line).

**Re-aim guards/tests:** `backend/tests/architecture/phase6-editor-player.test.js`, `phase7-extraction-readiness.test.js` (P7-T4 set), `dependency-guardrails.test.js` (if allowlist mentions), `tests/private-worker-{auth,phase2,visibility}.test.js`, `tests/worker-share-policy.test.js`, `tests/generation-routes.test.js`, `scripts/syntax-smoke.sh`, `docker-compose.yml` (backend mounts), `backend/package.json` (dependency entry).

**Docs:** `ARCHITECTURE.md` (layout), `MODULAR_PRODUCT_ARCHITECTURE.md` §6 normative rows, this file (status header). Historical phase docs stay untouched by convention.

**Explicitly NOT touched:** `frontends/app/**` (all), `frontends/android/**` (all), `backend/src/video/**`, `backend/src/services/waveform-service.js`, `backend/src/image/**`, `backend/src/workflows/**`, middleware, storage, runtime.

---

## 12. Final verdict

# **READY AFTER PREPARATION**

**Why not READY:** the Player's *model* is a 51-LOC leaf ready the day VBook moves, but the Player *as a module* is its HTTP contour, and that contour is physically inseparable today from the legacy import leg, hub callbacks and worker status inside `routes/generation-routes.cjs` (1513 LOC), reads PG/Redis/`OUTPUT_DIR` directly (15 frozen T6 edges), embeds an undeclared artifact-naming grammar shared with generation, and performs hidden writes in GET routes. Phase 7 §4.6's forced sequence — VBook → route split → Player — is still valid at HEAD; only the first link has become prepared.

**Why not NOT READY:** every blocker has a known port/injection shape already proven in this repo (booksRoot port precedent landed *during this audit* in `fb411c61`); the de-facto API contract is fully enumerable from three consumers; the facade is guarded and leaf-like with zero inbound deep imports; the repo has executed preparation→move five times with a written playbook; and the extraction carries **no wire protocols, no cross-service Redis, no deployment artifact formats** — the risks that made Worker/Hub 4-5/5.

**Recommended boundary (recorded decision):** backend-only package — model facade + (post-split) playback routes + IU math + queue, everything infra behind 5 required ports; **web playbackStore/PlayPage and the Android player stay app-side thin clients by design** (frontend cycle + desktop workspace modes + Android monolith make frontend extraction the wrong cut for now; revisit only if a standalone ".vbook player" product is greenlit per MODULAR_PRODUCT_ARCHITECTURE §6 — at which point the §4 contract is the foundation, not this package's internals).

**Sequence for the next coder:** (0) let the VBook physical move land (owned elsewhere); (1) naming-grammar module + outputRoot injection; (2) route split with re-pinned baselines — steps 1-2 are pure backend code motion, instantly rollbackable, no package yet; (3-7) package creation per §8. Nothing in this audit requires behavior change at any step.

---

*Verification (read-only, executed during this audit):* `backend` — `npx mocha tests/architecture/phase6-editor-player.test.js` (18 pass), `dependency-guardrails.test.js + phase7-extraction-readiness.test.js` (25 pass), `vbook-package-boundary.test.js` (18 pass), `scene-timings + scene-audio-range + iu-progress-utils + video-timeline + generation-routes` (43 pass), facade load check; `frontends/app` — vitest `src/state src/cache` (97 pass; full run 255/256 with pre-existing unrelated `privateWorkers` failure). Require-graph scans: `grep require(` over player/routes contour files; consumer scans for `playerModel|createPlayerModel|playbackStore|PlayPage` across backend/src, frontends/app/src, frontends/android. Nothing in the repository was modified by this reconnaissance.
