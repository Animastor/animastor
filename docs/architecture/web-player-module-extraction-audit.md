# Web Player Module Extraction Audit — Web Player contour → `@animastor/web-player`

> **Package scope (fixed):** `@animastor/web-player` is a **specialized Preact/Web UI + engine module** for the browser frontend (`frontends/app`): the playback engine (`playbackStore.ts` — queue/preload/gapless/IU-cycling/state machine/video buffer gate) plus the Play surface (`PlayPage.tsx`). It is **not** a platform-independent or domain module: media elements (`HTMLAudioElement`/`HTMLVideoElement`), Cache API, `requestAnimationFrame`, `sessionStorage`, `document.visibilitychange` and the desktop shell fork are web-browser specifics. The Android player (`PlaybackViewModel.kt`/`PlayFragment.kt`) is a separate parity implementation — it is **out of scope** and is not consumed or shared by this package (parity is contractual, per `ANDROID_WEB_PARITY.md`). The backend playback contour already lives in `@animastor/player` — HTTP is the contract.

**Status:** READ-ONLY reconnaissance. No production code changed, no files moved, no package created (`packages/animastor-web-player` does NOT exist), no extraction started.
**Date:** 2026-09-12
**Baseline:** HEAD `88cd791e` ("arch(orchestration): introduce persistence port").
**Context:** File and Navigator are physically extracted from the web frontend (`packages/animastor-web-file`, `packages/animastor-web-navigator` — both consumed via `file:` deps + Vite `dedupe`). Web Player is the natural next candidate in the `animastor-web-*` queue. This audit measures whether the contour can follow the same playbook.
**Related:** `file-module-extraction-audit.md` + `navigator-module-extraction-audit.md` (the two reference extractions), `PLAYER_PACKAGE_EXTRACTION_READINESS_AUDIT.md` (backend Player → `@animastor/player`), `PLAYER_ROUTE_SPLIT_CHECKLIST.md`, `docs/05-frontend/PLAYER_STATE_MACHINE_DESIGN.md`, `docs/03-audit/PLAYER_AUDIT.md`, `ANDROID_WEB_PARITY.md`.
**Guards today:** `frontends/app/src/architecture/file-navigator-contour.guard.test.ts` (File/Navigator only — **no Player guard exists yet**); package-side `test/boundary.test.ts` in both reference packages.

---

## Executive summary

The Web Player is **the heaviest feature contour in the web app and the first one that is stateful**: unlike File and Navigator (view surfaces over host state), Player *owns* a 2117-LOC module-scoped engine (`playbackStore.ts`) that survives route changes, holds DOM media elements in a hidden host `div`, drives `requestAnimationFrame` loops and manages a 7-state machine. Its companion `PlayPage.tsx` (307 LOC) is a clean leaf. The engine is cohesive and exceptionally well-tested (48 tests across 8 dedicated suites + 19 gate/media-cache tests), but its boundary is **asymmetric**: it consumes 8 host modules directly, and 7 host files consume it back — including two host modules that have *runtime dependencies on Player-internal behavior semantics* (Editor's carousel seeks; the whole app's `phase` bounce routing). It also owns two app-shared signals (`uiState`-adjacent identity: `bookId`/`buildId` inside the store) that the rest of the app must NOT fork.

The extraction is viable — every host dependency has a precedent port shape already proven by `web-navigator`/`web-file` — but it is a **different class of extraction** than both references: File/Navigator were *page-first* extractions where state stayed host-side; here the **state IS the module** (the page is the leaf). The correct cut is: engine + page move together behind `PlayerPorts`, with shared signals (`bookId`/`buildId`/`phase` from `generateStore`) received by injection — not copied — and the `playbackStore → generateStore.onPlaybackPrepared` edge (the surviving half of the dissolved cycle) inverted into a port.

**Verdict: READY WITH CONDITIONS (MEDIUM-HIGH 3.5/5).** Structurally ready — clean leaf page, cohesive engine, zero state-module cycles since the B1 split, no deep imports anywhere, all seams enumerable and precedented. Not READY today because: (1) `playbackStore` still directly imports `generateStore`/`positionStore`/`resourceInvalidations` (no ports exist yet — the Navigator-style Phase-1 prep has NOT been done for Player); (2) five external consumers (Edit/Settings/fileAdapters/navigatorAdapters/auth-book-session tests) import `playbackStore` internals directly; (3) shared CSS (~45 `play-*` rules + the `/theater_curtains.png` public asset) is host-owned — the packages have a documented no-CSS convention that needs a decision; (4) `phase`-value ownership across Player/Generation/File is contract-documented but Player's writes (`PLAYING`/`PAUSED`/`DOWNLOADING`) are exactly the values two other modules read for shell routing — the seam must be inverted, not duplicated.

| Question | Answer (measured) |
|---|---|
| Is Web Player an independent feature contour | **YES** — playback engine + Play surface is a coherent domain; route `/play`, tab + desktop transport console |
| Contour size | **4 source files, 2590 LOC**: `playbackStore.ts` (2117), `PlayPage.tsx` (307), `playbackGate.ts` (83), `mediaCache.ts` (83) + 9 test files (48 + 19 tests) |
| State-module cycles | **ZERO** (since the File B1 split dissolved `generateStore ⇄ playbackStore`; the surviving edge `playbackStore → generateStore` is one-way — guard-frozen, `file-navigator-contour.guard.test.ts:331-365`) |
| Deep imports / inbound coupling | **ZERO deep imports** (all imports are the module entry `state/playbackStore`); **7 host consumer files** (main, AppShell-path via generateStore only — no PlayPage import, Edit, Settings, fileAdapters, navigatorAdapters, + test mocks) |
| Dedicated tests | **YES — 67 tests** (48 playback + 14 gate + 5 mediaCache) — the best-tested contour in the app |
| Host dependencies of the contour | **10 direct host modules** (generateStore, positionStore, resourceInvalidations, api/client, api/models, mediaCache\*, i18n, desktop, icons, router\*) — of which mediaCache moves WITH the package |
| Hidden dependencies | **YES** — shared `phase` values written by Player and read by AppShell routing; `sessionStorage` key `animastor:playbackPosition`; Cache API name `animastor-media`; URL grammar `/scene/:b/:ch/:sc/:kind?build_id=` duplicated with EditPage; curtains asset; hidden DOM host div; `video_version` mtime cache semantics |
| Frontend engine part of `@animastor/player` (backend)? | **NO — by standing decision** (`PLAYER_PACKAGE_EXTRACTION_READINESS_AUDIT.md` §12: "web playbackStore/PlayPage … stay app-side thin clients by design"). This audit refines that decision for the *web-package* axis (see §11) |
| Blocking upstream steps | **None architectural** — the extraction prep itself (ports + boundary) IS the remaining work |

\* router is NOT imported by the contour today (PlayPage never navigates; the shell does). i18n/desktop/icons are PlayPage-only; the engine imports none of them.

---

## 1. Current Web Player contour (measured at HEAD)

### 1.1 Composition

```
main.tsx ──route──▶ <PlayPage path="/play" />          (router.ts: TAB_ROUTES includes '/play')
                       │ attaches <video> (attachVideo), restores position,
                       │ auto-inits from generateStore identity
                       ▼
state/playbackStore.ts (2117 LOC — the ENGINE; module-scoped, survives route changes)
  ├─ queue + preloadAhead(3), parallel fetch, retryWithBackoff
  ├─ gapless: two <audio> in hidden host div + −200ms early switch
  ├─ IU cycling: RAF over audio.currentTime (audio) / setTimeout (silent scenes)
  ├─ 7-state machine (T6): IDLE/LOADING_SCENE/SHOWING_STORYBOARD/SEEKING/VIDEO_READY/PLAYING/PAUSED
  ├─ video: streamed from API_BASE+scenePath (progressive Range), buffer gate (adaptive 6→20s)
  ├─ lifecycle: visibilitychange pause, sessionStorage position save/restore
  └─ wiring: wirePlaybackCoordination (onPlaybackPrepared → prepare/refresh),
             onResourceInvalidated(book:*) → invalidateBookContent
state/playbackGate.ts (83) — pure reveal-gate math (T2.2), zero imports
cache/mediaCache.ts (83) — Cache API blobs keyed `${buildId}_${sceneKey}_${kind}`
```

### 1.2 File inventory

| File | LOC | Role | Player-exclusive? |
|---|---|---|---|
| `state/playbackStore.ts` | 2117 | Engine: queue/preload/gapless/IU cycling/state machine/video buffer gate/lifecycle | mostly; imports shared modules (§2) |
| `state/playbackGate.ts` | 83 | Pure gate math (`unitStartMs/unitEndMs/unitRevealGateSec/shouldRevealSeekVideo`) | **YES — zero imports, fully self-contained** |
| `pages/PlayPage.tsx` | 307 | Play surface: viewport layers, chips, transport console, fullscreen anchoring | **YES** |
| `cache/mediaCache.ts` | 83 | Cache API media blobs | **NO** — `SettingsPage.tsx:10` uses `clearCache` for the settings "clear cache" button (2 external consumers: playbackStore + Settings) |
| `state/positionStore.ts` | 27 | Shared active position (SharedPositionManager) | NO — 5 consumers (Play/Edit/Generate/AiAssistant/fileStore + navigatorAdapters) |
| `state/resourceInvalidations.ts` | 69 | Invalidation bus | NO — app-wide (producers: Edit, AiAssistant; consumers: Navigator, playback) |
| `state/generateStore.ts` | 1323 | Session identity + generation | NO — the app hub (§6.2) |
| `api/client.ts` | 250 | HTTP seam (API_BASE/getJson/getBlob/retryWithBackoff) | NO — 10 consumers |
| `api/models.ts` | 835 | Shared types (`BookData/SceneStatusResponse/StoryboardResponse/sceneRefs/SceneRef`) | NO — shared |

### 1.3 Exports of the engine (62 `export` statements)

The public surface splits into three groups:

1. **Signals (11):** `uiState`, `bookId`, `buildId`, `sceneQueue`, `missingIuPosition`, `pendingExternalSeek`, `layerAudio/Image/Video/Subtitles`, `coverImage`, `previewImage`, `currentIuBlobUrl`, `subtitleText`, `iuMissing`, `videoVisible` — consumed by PlayPage (render), EditPage (none directly), tests.
2. **Player commands (~30):** `preparePlayback`, `refreshContent`, `ensureInitialized`, `playSceneQueue`, `resumeFromCurrentScene`, `pausePlayback`, `resumePlayback`, `handlePlayButton`, `seekToPosition`, `executePendingSeek`, `checkPendingExternalSeek`, `closeBook`, `invalidateDeleted*`, `invalidateBookContent`, `setLayer*`, `attachVideo/detachVideo`, `stopAll`, `restoreSavedPositionIfAny`, `rotationRecovery`, … — consumed by PlayPage (mount), main.tsx (wire*), EditPage (`seekToPosition`, `invalidateDeletedScene/Chapter`), SettingsPage (`closeBook`), fileAdapters (`closeBook` — the `player` seam), navigatorAdapters (`seekToPosition` — the `seek` port).
3. **Accessors:** `getPlayerState`, `getPendingVideoTargetSec`, `currentChapterId/currentSceneId/getCurrentSceneKey/sceneQueueSize/currentSceneIndex` (tests + Navigator-adjacent reads).

Notably **`bookId`/`buildId` signals inside playbackStore are a DUPLICATE IDENTITY of `generateStore.bookId/buildId`** (§6.2) — kept in sync by `preparePlayback`/`refreshContent`, never by direct assignment. This is the single most delicate seam in the contour.

---

## 2. Dependency closure of the Web Player

### 2.1 Engine outbound (playbackStore.ts imports, lines 22–32)

| Dependency | What is used | Moves with package? | Disposition |
|---|---|---|---|
| `@preact/signals` (`signal`) | engine state | NO — peerDependency (navigator/file precedent) | peer |
| `api/client` (`API_BASE, getJson, getBlob, retryWithBackoff`) | 4 fns; `API_BASE` used directly for video URL (`API_BASE + scenePath` :1668) | NO | **HttpPort** (getJson/getBlob/retryWithBackoff **+ videoUrl(path)** — the `API_BASE` reach must become a port method, mirroring `mediaUrl` in NavigatorPorts) |
| `api/models` (`BookData/SceneStatusResponse/StoryboardResponse/sceneRefs` — types + 1 pure fn) | scene parsing | types: vendored structural copies (navigator `models.ts` precedent — types must not drift) | models adapter |
| `state/playbackGate` | pure math | **YES — moves** (internal dep, zero-import leaf) | internal |
| `state/generateStore` (`onPlaybackPrepared` + type `SceneRef` re-export) | generation-completion event | NO | **PlaybackPreparedPort** (host: `generateStore.onPlaybackPrepared` — payload `{bookId, buildId, scenes, coverImage?, softRefresh?}` narrowed to what the engine reads: ALL fields incl. `scenes: SceneRef[]` — wider than Navigator's `{bookId, buildId}`) |
| `state/positionStore` (`navigateTo`, type `ActivePosition`) | engine WRITES position on every advance/seek (12 call sites) | NO | **PositionPort** (write-direction — inverse of the Navigator's read-direction port; passes the host signal/fn) |
| `cache/mediaCache` (`getMedia/putMedia/clearCache/evictSceneMedia/evictChapterMedia`) | 5 fns | **YES — moves** (Player-owned media cache; ONE external consumer: SettingsPage `clearCache` — see §6.8) | internal + a `clearMediaCache` exposure via port |
| `state/resourceInvalidations` (`onResourceInvalidated`, `BOOK_RESOURCE_PREFIX`) | invalidation subscription (wirePlaybackCoordination) | NO | **InvalidationPort** (pure consumer — same shape as Navigator's) |

### 2.2 Page outbound (PlayPage.tsx imports, lines 7–27)

| Dependency | What is used | Disposition |
|---|---|---|
| `preact`, `preact/hooks`, `@preact/signals` (`useSignalEffect`) | runtime | peer |
| `app/i18n` (`t`) | 17 keys: `play_placeholder`, `play_placeholder_no_generation`, `play_loading`, `play_ready`, `play_playing`, `play_paused`, `play_play`, `play_pause`, `play_fullscreen`, `play_generate_hint`, `layer_audio`, `layer_image`, `layer_video`, `layer_subtitles`, `iu_not_generated`, `empty_state`, `empty_state_book_loaded` | **I18nPort** (FilePorts precedent: `PlayerI18nKey` union type — dictionary stays host) |
| `app/desktop` (`useDesktopShell`) | desktop/mobile fork (transport console vs mobile chips) | **ShellModePort** (navigator precedent — the adapter carries a live-reactive signal; page's `useDesktopShell` hook must be injected or ported to the port's signal) |
| `state/playbackStore` (14 named imports + type) | render + controls | internal after the move |
| `state/generateStore` (`bookId`, `buildId` as `genBookId/genBuildId`) | **placeholder-text logic + auto-init** (empty state distinguishes "no book at all" vs "book open, not generated" — `:47-48`, `:221-222`) | **SessionPort** (identity signals — same objects as generateStore's; no fork) |
| `app/icons` (10 icons + `IconProps`) | Play/Pause/Volume/Image/Video/Subtitles/Fullscreen chips | **IconsPort** (navigator/file precedent) |

### 2.3 Inbound (who imports the contour)

| Consumer | What it imports | Post-extraction shape |
|---|---|---|
| `main.tsx:19` | `wirePlaybackCoordination`, `wirePlaybackLifecycle` | stays — becomes **composition-root wiring** (`app/playerAdapters.ts` wires ports; main calls the wires) |
| `main.tsx:7` | `PlayPage` | `<PlayPage ports={playerPorts} />` — route mount stays in main |
| `pages/EditPage.tsx:43` | `seekToPosition`, `invalidateDeletedScene`, `invalidateDeletedChapter` | **PlayerEnginePort on the EDIT side** (Edit imports the package entry, or receives it via an adapter — decision §9) |
| `pages/SettingsPage.tsx:9` | `closeBook as closePlayerBook` | same — via package entry |
| `app/fileAdapters.ts:39` | `closeBook as closePlayerBook` (the `player` seam of fileStore) | same — via package entry |
| `app/navigatorAdapters.ts:19` | `seekToPosition` (the `seek` port) | same — via package entry |
| Tests (7 playback suites mock `../api/client`, `../cache/mediaCache`, `./generateStore`, `./positionStore` — `playbackStore.test.ts:15-40`) | module identity | move with the package, mocks re-aimed at the package's port injection (they become fake ports — navigator characterization-test pattern) |
| `state/__tests__/auth-book-session.test.ts:30` | `vi.mock('../playbackStore')` (wires) | stays host-side, mocks the package entry |

**Zero deep imports** — every inbound reference is the module entry `state/playbackStore` (verified: no `playbackStore/`-suffixed specifiers exist). No reverse dependency on `PlayPage` other than `main.tsx` (AppShell does NOT mount PlayPage — desktop `/play` is a routed workspace mode, not a persistent panel; `AppShell.tsx` has no PlayPage import).

### 2.4 Cycles

- **State-module cycles: ZERO.** The historical `generateStore ⇄ playbackStore` cycle was dissolved by the File B1 split (2026-09-09); the surviving edge `playbackStore → generateStore` (onPlaybackPrepared) is one-way, guard-frozen (`file-navigator-contour.guard.test.ts:331-365` asserts "NO state-module cycle exists at all" and pins the exact one-directional edge). **Critically: this is the first web extraction whose package-internal engine imports a host store — the cycle guard must extend to the package boundary (port-only imports, boundary.test.ts pattern), otherwise a new package→host cycle would be invisible to the host-side guard.**
- DOM/engine cycles: none (engineHost div is engine-created; PlayPage's `<video>` is adopted/detached, not referenced elsewhere).
- Test cycles: none.

### 2.5 Hidden dependencies (measured)

1. **Shared `phase` contract (the biggest)** — Player writes `PLAYING/PAUSED/DOWNLOADING` into `uiState.phase` (its OWN signal, 14 write sites), while `generateStore.phase` (separate signal) is written by File/Generation and read by `AppShell` for `/play` vs `/generate` bounce routing (`AppShell.tsx:117`). The two signals are NOT the same object — but the *value vocabulary* is shared (`PlayerPhase` type re-declared in both stores; `FilePorts.FilePhase` is a third copy — file audit B6). Post-extraction the package must own its `uiState.phase` and expose it via port; the *identity* signals (`bookId/buildId`) must stay host-singletons.
2. **`sessionStorage` key `animastor:playbackPosition`** (`playbackStore.ts:145`) — a persistent cross-reload contract with the shell (pagehide/pageshow/bfcache). Port shape: a `StoragePort` (or keep `sessionStorage` inside the package with a documented key prefix — navigator has no precedent; file keeps localStorage host-side in generateStore). Recommendation: keep storage INSIDE the package (it is player-internal state) but document the key in README like a data contract.
3. **Cache API name `animastor-media`** (`mediaCache.ts:6`) + key grammar `/${buildId|_blank}/${sceneKey}/${kind}` — host-visible (Settings "clear cache" counts entries; a user's browser stores it). Moves with the package; Settings consumes it via port (§6.8).
4. **Scene media URL grammar** `/scene/:b/:ch/:sc/{status,storyboard,audio,video}?build_id=` (`scenePath` :264, `iuPath` :267) — **duplicated** with `EditPage.tsx:693,766,822` (waveform/timings/audio use the same grammar inline) and Navigator's preview grammar (via `mediaUrl` port). The grammar is the wire contract with `@animastor/player` (backend). Post-extraction the package keeps its own `scenePath/iuPath` internally (it IS the player client), Edit keeps its copies (Editor-surface concern), and the shared knowledge is the HTTP contract — same resolution as File's B4.
5. **`theater_curtains.png`** (`public/`, md5-parity with Android) — rendered by `.play-curtains` CSS (`base.css:2911-2922`). CSS + asset stay host (§8.3).
6. **Hidden engine host div** — the engine appends `position:fixed;width:0;height:0;overflow:hidden` to `document.body` (`ensureHost` :1218). A browser-environment assumption; package README must document it (it survives package extraction harmlessly — the engine is mounted exactly once via `wirePlayback*`).
7. **`video_version` mtime ETag semantics** — Android parity contract through the backend (`PLAYER_PACKAGE_EXTRACTION_READINESS_AUDIT.md` §4); pure HTTP, no code coupling.
8. **Desktop transport console** (`isDesktop` fork in PlayPage :100,278) — same ShellModePort treatment as Navigator's hidden dep #1.

---

## 3. Proposed package boundary

```
packages/animastor-web-player/               (@animastor/web-player, L1 — internal web-UI package)
├── src/
│   ├── index.ts                  public API: PlayPage, PlayerPorts, engine wires
│   ├── ports.ts                  PlayerPorts contract (imports only Preact types — navigator/file pattern)
│   ├── models.ts                 vendored structural types (SceneRef, SceneStatusResponse,
│   │                               StoryboardResponse, BookData subset) — navigator models.ts pattern
│   ├── playbackStore.ts          the engine (61→~40 public exports; see below)
│   ├── playbackGate.ts           pure math (moves verbatim)
│   ├── mediaCache.ts              Cache API blobs (moves verbatim)
│   └── PlayPage.tsx               the surface (ports-injected, no host imports)
├── test/
│   ├── boundary.test.ts           package boundary guard (navigator pattern: FORBIDDEN_IMPORTS =
│   │                               every host store/infra module + ../.. paths + deep self paths)
│   ├── playbackStore.test.ts      + 7 engine suites (moved, mocks → fake ports)
│   ├── playbackGate.test.ts       moved verbatim (pure)
│   └── mediaCache.test.ts         moved verbatim
├── package.json                   peerDeps: preact, @preact/signals; tsup/vitest/happy-dom toolchain
│                                   (byte-identical to web-file/web-navigator manifests)
├── tsup.config.ts / vitest.config.ts / tsconfig.json   (copied from reference packages)
└── README.md                      contour + ports + contracts (curtains/storage/cache keys/URL grammar)
```

**What moves (4 files + 9 tests):** `state/playbackStore.ts`, `state/playbackGate.ts`, `cache/mediaCache.ts`, `pages/PlayPage.tsx`; tests `playbackStore/BookSwitch/CacheInvalidation/Gate/RevealOvershoot/StickySeeking/TargetCleanup/VideoListener.test.ts`, `mediaCache.test.ts`.

**What stays in `frontends/app`:**

| Stays | Why |
|---|---|
| `main.tsx` route mount + `wirePlayback*()` calls | composition root (navigator/file precedent) |
| `app/playerAdapters.ts` (NEW at prep) | the ONLY host file importing host stores AND the package (navigator/file precedent) |
| `state/generateStore.ts`, `state/positionStore.ts`, `state/resourceInvalidations.ts`, `state/fileStore.ts`, `state/resilientReloader.ts` | shared app infrastructure (audits of File/Navigator froze this repeatedly) |
| `api/client.ts`, `api/models.ts` | shared seams |
| `app/i18n`, `app/icons`, `app/desktop`, `app/router` | shared UI kit / shell |
| `pages/EditPage.tsx`, `pages/SettingsPage.tsx`, `pages/GeneratePage.tsx`, `AppShell.tsx` | other surfaces; consume the package via entry only |
| `styles/base.css` (~45 `.play-*` rules + curtains) + `public/theater_curtains.png` | §8.3 decision — CSS stays host-side (both reference packages already render host-owned classes without bundling CSS) |
| `lib/waveform.tsx` | Editor timeline (NOT part of the playback contour — confirmed: PlayPage has zero waveform imports) |

**Internal (hidden) after extraction:** the 7-state machine, preload/inflight-asset dedup, buffer-gate escalation, `SAVED_POS_KEY` semantics, media cache key grammar, `scenePath/iuPath` builders, `SelectedUnit` selection model.

---

## 4. PlayerPorts — the required contract

The contract mirrors the two references in shape but is **wider on the engine side** (the package owns state, not just a view). Draft (to be finalized in Phase-1 prep):

```ts
export interface PlayerPorts {
  // session identity — HOST SINGLETONS passed as signals (never copied):
  // generateStore.bookId/buildId. PlayPage placeholder logic + ensureInitialized guard read them.
  session: {
    readonly bookId: Signal<string>;
    readonly buildId: Signal<string>;
  };
  // generation completion — host: generateStore.onPlaybackPrepared.
  // Payload carries scenes: SceneRef[] + coverImage?/softRefresh? (engine consumes ALL of them).
  generation: {
    onPlaybackPrepared(fn: (p: PlaybackPreparedEvent) => void): () => void;
  };
  // shared position — host: positionStore. ENGINE WRITES on every advance (navigateTo).
  position: {
    readonly position: Signal<ActivePosition>;
    navigateTo(p: Partial<ActivePosition>): void;
  };
  // invalidation bus — host: resourceInvalidations. Pure consumer (book:* prefix).
  invalidations: {
    onResourceInvalidated(fn: (e: ResourceInvalidationEvent) => void): () => void;
    bookResource(bookId: string): string;
  };
  // http — host: api/client. NOTE videoUrl: engine builds the direct <video> src
  // (API_BASE + scenePath) — must be a port method (mediaUrl precedent), not API_BASE.
  http: {
    getJson<T>(path: string): Promise<T>;
    getBlob(path: string): Promise<Blob>;
    retryWithBackoff<T>(fn: () => Promise<T>, attempts?: number, minMs?: number, maxMs?: number): Promise<T>;
    videoUrl(path: string): string;   // = API_BASE + path (host: api/client)
  };
  // shell mode — host: app/desktop (matchMedia 1180px, live-reactive; navigator precedent)
  shellMode: { isDesktop(): boolean };
  // i18n — 17 PlayerI18nKey literals (FilePorts precedent: typed key union)
  i18n: { t(key: PlayerI18nKey, fallback?: string): string };
  // icons — 10 components (IconsPort precedent)
  icons: { Play: I; Pause: I; VolumeUp: I; VolumeOff: I; Image: I; ImageOff: I;
           Videocam: I; VideocamOff: I; Subtitles: I; SubtitlesOff: I;
           Fullscreen: I; FullscreenExit: I };  // I = PlayerIconComponent
}
```

**Engine-side exports exposed through `index.ts` (host consumers):** `PlayPage`, `PlayerPorts` types, plus the **engine-port object** — either (a) individual functions (`seekToPosition`, `closeBook`, `invalidateDeletedScene/Chapter`, `clearMediaCache` (Settings), `getPlayerState`) or (b) a single `engine: PlayerEnginePort` object. Recommendation: (a) individual named exports from the entry — matches how Edit/Settings/fileAdapters/navigatorAdapters consume today (import-path change only, no call-site rewrite).

**Wiring functions:** `wirePlaybackCoordination`/`wirePlaybackLifecycle` move into the package but take the ports object (`wirePlayer(ports)`); the host composition root calls them once (main.tsx) — the package must not self-wire to host modules.

**Composition root:** `frontends/app/src/app/playerAdapters.ts` (NEW) — the single seam file, exactly like `fileAdapters.ts`/`navigatorAdapters.ts`; guards pin that it wires every host module (`state/generateStore`, `state/positionStore`, `state/resourceInvalidations`, `api/client`, `app/i18n`, `app/desktop`, `app/icons`) and that ONLY `main.tsx`/`app/playerAdapters.ts` (+Edit/Settings adapters' import sites, see §9) reference `@animastor/web-player`.

---

## 5. Player ↔ Web Host seam (what the host must provide)

| Host capability | Current reach | Port |
|---|---|---|
| HTTP (`fetch` with base `/api/v1`) | `api/client` 4 fns + `API_BASE` literal (video src) | `http` port (+`videoUrl`) |
| Session identity signals | `generateStore.bookId/buildId` (page) + internal duplicated signals (engine) | `session` port (identity stays host-singleton) |
| Generation completion | `generateStore.onPlaybackPrepared` (engine wire) | `generation` port |
| Shared position | `positionStore.navigateTo` ×12 engine write sites | `position` port |
| Invalidation bus | `resourceInvalidations.onResourceInvalidated/BOOK_RESOURCE_PREFIX` | `invalidations` port |
| i18n dictionary (RU/EN, 1780 LOC) | `t` ×17 keys | `i18n` port |
| Desktop shell query | `useDesktopShell` (matchMedia) | `shellMode` port |
| SVG icon kit | 10 icons | `icons` port |
| CSS + static assets | `.play-*` classes, curtains png | stays host (class-name contract documented in README — §8.3) |
| Browser APIs (DOM/Cache/RAF/sessionStorage/Audio/Video) | inside engine | stays INSIDE package (browser-only package, declared) |

**Where composition lives today:** implicitly — `main.tsx` (`wirePlaybackCoordination/Lifecycle` + route), `PlayPage` mount effect (attach/restore/auto-init/seek), module load (engine state). Post-extraction: `main.tsx` + `app/playerAdapters.ts` (host), `wirePlayer(ports)` (package). No other composition points exist (verified: no PlayPage mount in AppShell).

---

## 6. Player ↔ other modules (all 8 directions, measured)

### 6.1 Player → Editor
**Direct: NONE.** The engine and PlayPage import nothing from EditPage/`entityEditor`/`waveform`. `invalidateDeleted*` are Player-side APIs *consumed by* Editor (below). No transitive reach. **Architecturally clean — no boundary action.**

### 6.2 Editor → Player
**Direct: YES — `EditPage.tsx:43`** imports `seekToPosition`, `invalidateDeletedScene`, `invalidateDeletedChapter` (carousel unit navigation :904,950,986 + entity-delete invalidation :1788-1794). Transitive: none beyond those. **Admissible** (Edit is a legal external-seek source + the delete-invalidations keep the queue coherent — documented in the engine's own comments). Post-extraction: Edit imports the package entry; no port needed on the Edit side beyond the package's public API (decision §9 — direct entry import recommended, like navigatorAdapters does today).

### 6.3 Player → Generation
**Direct: YES — `playbackStore.ts:29-30`** imports `onPlaybackPrepared` + `SceneRef` (type re-export) from `generateStore`. This is the surviving one-way edge of the dissolved cycle, guard-frozen as one-directional. The engine consumes the FULL payload (scenes list + coverImage + softRefresh — `wirePlaybackCoordination` :2091-2110). Also **identity duplication**: engine-internal `bookId/buildId` signals are re-set by `preparePlayback` from the event — they are a *projection* of `generateStore`'s identity, read by PlayPage placeholders only. Post-extraction: `generation` + `session` ports; the internal projection MUST stay internal (the package must not export its `bookId` signal as a second source of truth — PlayPage reads the port's session signals for placeholder logic instead). **Admissible after inversion.**

### 6.4 Generation → Player
**Direct: NONE** (generateStore imports no playback module — B1 split). Indirect-but-real: `generateStore.phase` vocabulary (`PLAYING`/`PAUSED` are Player-owned values in the *FilePorts.FilePhase* sense; file audit B6 documents Player as the writer of `PLAYING`/`PAUSED` for the *generateStore.phase* signal — but measured today: **playbackStore writes its OWN `uiState.phase`, never generateStore.phase** (grep-verified: zero `generateStore.phase` writes from playbackStore; AppShell reads `generateStore.phase` for routing and its `PLAYING`/`PAUSED` values are currently written by NOBODY post-B1 — a latent dead-vocabulary residue of the shared-type union, not a runtime edge). **No boundary action needed for extraction**; recommend recording the phase-ownership note in the prep commit (the `PlayerPhase` type triplication: playbackStore/generateStore/FilePorts narrows to: package owns its `PlayerPhase`, host keeps its union).

### 6.5 Player → Navigator
**Direct: NONE** (playbackStore/PlayPage import nothing navigator-ish). Route knowledge: none (Player never navigates). **Clean.**

### 6.6 Navigator → Player
**Direct: YES — via adapter only** (`app/navigatorAdapters.ts:19` imports `seekToPosition`; the package-side `NavigatorPorts.seek` is a 1:1 passthrough — frozen by the Navigator audit). Post-extraction: the adapter re-aims at `@animastor/web-player` entry. **Admissible — seam already exists and is the exact shape the Player package will expose.** Note: this makes `web-navigator` (package) → `web-player` (package) a **host-mediated edge** (both sides stay package-clean; the adapter is the only place they meet). No package→package dependency is introduced — correct for two independent web modules.

### 6.7 Player → Web File
**Direct: NONE.** The playback engine imports nothing from the File contour. Route/deep-link knowledge: none. **Clean.**

### 6.8 Web File → Player
**Direct: YES — `app/fileAdapters.ts:39`** (`closeBook as closePlayerBook`, wired into fileStore's `player` seam :54). This is the *dissolved-cycle* residue: fileStore (host) calls Player's `closeBook` when a book closes. Also `SettingsPage.tsx:9` (`closeBook`) + `SettingsPage.tsx:10` (`clearCache` from mediaCache — the one non-playback consumer of the media cache, for the "clear N cached files" button). Post-extraction: adapters import the package entry; Settings' clear-cache reaches the package's `clearMediaCache` export (the cache moves WITH the package — the export must stay in the public API). **Admissible — composition-root-mediated.**

**Summary matrix:**

| Direction | Direct | Shape | Verdict |
|---|---|---|---|
| Player → Editor | none | — | clean |
| Editor → Player | `EditPage.tsx:43` | seek + delete-invalidations | admissible; entry import post-cut |
| Player → Generation | `playbackStore.ts:29` | onPlaybackPrepared + identity projection | **requires inversion** (generation+session ports) |
| Generation → Player | none (type vocabulary only) | — | clean; note phase-type ownership |
| Player → Navigator | none | — | clean |
| Navigator → Player | `navigatorAdapters.ts:19` | seek port (already seam-shaped) | admissible; adapter re-aims |
| Player → File | none | — | clean |
| File → Player | `fileAdapters.ts:39` | player-release seam (already seam-shaped) | admissible; adapter re-aims |

---

## 7. Player ↔ Backend/API boundary

Pure HTTP contract; the backend playback contour is already the `@animastor/player` package (route split + physical move complete). Endpoints consumed by the web engine (all via `api/client` — zero `/api/v1` literals outside the client, Phase 6 T7):

| Endpoint | Used by (web) | Backend owner |
|---|---|---|
| `GET /book/:bookId` | `ensureInitialized`, `seekToPosition` refresh | `@animastor/editor` (book JSON read) + model via player |
| `GET /scene/:b/:ch/:sc/status` | `fetchSceneAssets` (audio/video readiness) | `@animastor/player` scene-data |
| `GET /scene/:b/:ch/:sc/storyboard` | `fetchIuSequence`, cover load | `@animastor/player` scene-data |
| `GET /scene/:b/:ch/:sc/audio` | `getSceneAudioBlob` (Cache API) | `@animastor/player` scene-media (Range/206/ETag) |
| `GET /scene/:b/:ch/:sc/video` | `ensureSceneVideo` — DIRECT `<video>` src (progressive streaming, no fetch) | `@animastor/player` scene-media |
| `GET /iu-image/:b/:ch/:sc/:unit` | `getIuImageBlob` (Cache API) | `@animastor/player` iu-media |

Not used by the contour (verified): timings PUT, waveform, chunk-keyed legacy routes, `/book/:id/chunks`, `assets-state` (those are Edit/Generate-side). **The web engine's surface is a strict 6-endpoint subset of `@animastor/player`'s contract — no new boundary, no duplication.** The relation to `@animastor/player` is client↔server over frozen HTTP; there is NO code dependency and NONE should be created (the npm package must not depend on `@animastor/player`).

---

## 8. Reference comparison — what to adopt from `web-file`/`web-navigator`, what not

### 8.1 Adopt (proven, applies directly)

| Reference decision | Applies to web-player |
|---|---|
| **Package naming/type** — `@animastor/web-*`, `"type": "module"`, ESM-only, tsup build, `dist/index.js` entry | yes — verbatim |
| **peerDependencies: preact + @preact/signals only; everything else devDeps** | yes — the engine adds NO new runtime deps (verified: only preact/signals + host ports) |
| **Ports contract file (`ports.ts`)** — imports ONLY Preact types; structural payload types (not host-store imports); host adapter bridges and TS rejects drift | yes — §4 draft follows it; the *engine-side* additions (wider event payload, videoUrl) stay within the pattern |
| **Host adapter as single composition seam** (`app/*Adapters.ts`) + guard-pinned required-import list | yes — `app/playerAdapters.ts` |
| **Boundary guard (`test/boundary.test.ts`)** — FORBIDDEN_IMPORTS scan over src/ + dist leak scan (absolute paths, host specifiers) + only-peer externals | yes — PLUS a new rule: the *engine* is inside the package, so the guard must additionally forbid imports of `state/`, `api/`, `app/` host paths from EVERY file (navigator's guard mostly worried about the page; here the engine is the risk) |
| **Host-side contour guard** (`architecture/*.guard.test.ts`) — zero reverse deps beyond main/adapter; no deep imports; no relative-path resolution of the package; no duplicate implementation remnants | yes — extend `file-navigator-contour.guard.test.ts` (or a sibling `player-contour.guard.test.ts`) |
| **Vite `dedupe: ['preact', …, '@preact/signals']`** — already in `vite.config.ts` for both packages | yes — needed identically (a second preact copy breaks hooks + signals) |
| **`file:` dependency wiring + own package-lock/node_modules** | yes |
| **Vendored structural models (`models.ts`)** instead of importing `api/models` | yes — types only (`SceneRef`, status/storyboard/book subsets); the pure `sceneRefs()` helper moves in (it is already duplicated as generateStore's re-export) |
| **Characterization tests via fake ports** | yes — the 48 existing engine tests already mock exactly the four host modules (`api/client`, `mediaCache`, `generateStore`, `positionStore` — `playbackStore.test.ts:15-40`); converting mocks→ports is mechanical |
| **Versioned `0.1.0` + CHANGELOG + README documenting ports & contracts** | yes |

### 8.2 Adapt (differs from references)

| Aspect | Reference shape | Web-player shape |
|---|---|---|
| **State ownership** | state stayed HOST (File: B1 split first; Navigator: zero state) | **the state MOVES** (the engine IS the module). This is the first web package owning app-shared runtime state (queue, players, phases). Consequences: (a) module-scope singletons move into the package — the host must import the SAME instance (entry point, not per-route copies); (b) the host cycle guard needs its package-side twin (boundary.test.ts) — a host→package→host cycle must fail package tests too. |
| **Page wires via props** | `ports` prop on the page | PlayPage also takes `ports`; BUT the engine is wired separately (`wirePlayer(ports)`) because it outlives the page. Two wiring moments: module-load wire (engine) + render-time props (page) — main.tsx keeps both calls. |
| **Event payload width** | Navigator narrowed `onPlaybackPrepared` to `{bookId, buildId}` | the engine needs the FULL event (scenes, coverImage, softRefresh) — the port must not narrow it |
| **models drift risk** | Navigator: `unitIndex` shared with AiAssistant | Player: `SceneRef/sceneRefs` shared with generateStore/Edit — vendored copy must be characterization-pinned (types only, no logic fork) |

### 8.3 Deliberately NOT adopted

- **No CSS bundling** — both reference packages render host-owned class names (`file-*`, `nav-*` rules live in host `base.css`); the ~45 `.play-*` rules + curtains stay host-side. The class-name set becomes the documented contract (README section), exactly like File/Navigator (their class names — `file-card`, `nav-tree`, etc. — already work this way). Do NOT move `base.css` fragments into the package.
- **No `tsconfig` path tricks / no aliasing host modules in tests** — reference packages test against fake ports only; the Player engine tests must do the same (they are 90% there already).
- **No bundling of `@animastor/player` (backend) or any `@animastor/*` runtime dep** — zero-dependency runtime besides peers.

---

## 9. Tests

### 9.1 Ownership split

| Test file | Tests | Disposition |
|---|---|---|
| `state/playbackStore.test.ts` | 2 | **moves** (P1-1 silent-scene pause contract) |
| `state/playbackBookSwitch.test.ts` | 4 | **moves** |
| `state/playbackCacheInvalidation.test.ts` | 10 | **moves** |
| `state/playbackRevealOvershoot.test.ts` | 5 | **moves** |
| `state/playbackStickySeeking.test.ts` | 5 | **moves** |
| `state/playbackTargetCleanup.test.ts` | 5 | **moves** |
| `state/playbackVideoListener.test.ts` | 3 | **moves** |
| `state/playbackGate.test.ts` | 14 | **moves verbatim** (pure) |
| `cache/mediaCache.test.ts` | 5 | **moves verbatim** |
| `state/__tests__/auth-book-session.test.ts` | 9 | **stays host** (mocks `../playbackStore` wires — re-aims mock at `@animastor/web-player` entry) |
| `architecture/file-navigator-contour.guard.test.ts` | (suite) | **stays host + EXTENDED** (§9.2) |
| `state/fileStore.test.ts` (21) / `app/fileAdapters.test.ts` (7) | 28 | stay (File) — `player` seam assertions re-aim at package import |
| `state/generateStore.analysis.test.ts`, resilientReloader/resourceInvalidations suites | — | stay (shared infra) |

Baseline at HEAD: `npx vitest run src/state src/cache src/architecture` → **147/147 green**; full app 312/313 (1 pre-existing unrelated failure `privateWorkers.test.ts` — worker-bundle URL expectation, same as the backend Player audit's R14).

### 9.2 Architecture guards required (new/extended)

1. **Host contour guard** (extend `file-navigator-contour.guard.test.ts` or new `architecture/player-contour.guard.test.ts`):
   - `main.tsx` imports `PlayPage` from `@animastor/web-player` only; `pages/PlayPage.tsx` deleted; no `modules/player/` residue;
   - zero reverse deps: only `main.tsx`, `app/playerAdapters.ts`, `app/fileAdapters.ts`, `app/navigatorAdapters.ts`, `pages/EditPage.tsx`, `pages/SettingsPage.tsx` (+ test files) may reference `@animastor/web-player` — **this differs from File/Navigator (2 consumers): Player has 6** because Edit/Settings consume engine functions. Recommended tightening during prep: route Edit/Settings consumption through their own thin adapters too, OR accept the wider consumer set explicitly in the guard with an import-surface assertion (they may import only the entry, never deep paths);
   - adapter wires every host module (required-import list: generateStore, positionStore, resourceInvalidations, api/client, i18n, desktop, icons);
   - no deep imports (`@animastor/web-player/src|dist|test`), no relative-path resolution (`../../packages/animastor-web-player`);
   - cycle guard extended: `app/playerAdapters.ts` must import the package AND host stores — but the package must not import host stores (that half is package-side, below).
2. **Package boundary test** (`test/boundary.test.ts`, navigator pattern, hardened for the engine):
   - FORBIDDEN: `state/playbackStore`-style host specifiers are impossible post-move, so the frozen list = any `../..`-reaching specifier, `frontends/app`, `@animastor/web-file`, `@animastor/web-navigator` (sibling web modules — host-mediated only), `@animastor/player` (backend), and any external beyond `preact`/`preact/hooks`/`@preact/signals`;
   - the ENGINE files (`playbackStore.ts`, `mediaCache.ts`) must import host modules ONLY via `./ports` types — no direct `generateStore`/`positionStore`/`resourceInvalidations`/`api/client` specifiers (this is the test that catches a re-introduced package→host edge);
   - dist scan: no absolute monorepo paths, no host specifiers, peers only.
3. **Keep frozen:** existing shared guards (zero state-module cycles; `playbackStore → generateStore` one-way) — they must be updated from "playbackStore imports generateStore" (module path) to the adapter + port shape.

---

## 10. NPM extraction readiness checklist

| Criterion | State | Evidence |
|---|---|---|
| Self-contained source | **YES after ports prep** | 4 files; only host imports are the 8 in §2.1/§2.2 |
| Production dependencies | **preact + @preact/signals only** (peer) | engine imports `signal` only; page preact/hooks/signals |
| Browser-specific deps | declared browser-only package (DOM, Cache API, RAF, sessionStorage, media elements) — acceptable for a `web-*` module (File/Navigator precedent: happy-dom in tests, DOM types in src) | `ensureHost` :1218, `caches.open` :8, RAF :1408, sessionStorage :2035 |
| Public API | enumerable: `PlayPage`, `PlayerPorts` types, engine commands (~15 named exports needed by host: seek/close/invalidate×3/clearCache/state accessors) + `wirePlayer` | §1.3, §2.3 |
| Deep imports | none exist today (module-entry-only consumers) — guard keeps it that way | §2.3 |
| Host dependencies | all behind 7 ports after prep | §4 |
| Package closure | complete: gate + mediaCache move WITH the engine; nothing else Player-owned exists outside the 4 files | §3 |
| Tests standalone | after mock→port conversion (mechanical; 48 tests already isolate exactly the 4 host modules) | §9 |
| Precedent infrastructure | tsup/vitest/happy-dom configs + guard patterns copy verbatim from reference packages | §8 |
| Publish blockers | none structural; `publishConfig.access: public` per repo convention; version `0.1.0` | — |

---

## 11. Relation to the existing `packages/animastor-player` (backend)

**What it is:** `@animastor/player@0.1.0` — the backend **playback HTTP contour**, physically extracted from `backend/src/routes/player/` + `backend/src/player/` per the route split (`PLAYER_ROUTE_SPLIT_CHECKLIST.md` §PHYSICAL MOVE COMPLETE; commit `4d1f6f0e` split, then the move). CJS/Node (`src/*.cjs`), deps: `@animastor/vbook-runtime` only; serves scene media (Range/206/ETag), scene data, IU media, playback queue, assets-state. Consumed by `backend/src/backend.cjs:114` (`createPlayerModel`, `createPlayerRoutes`).

**Responsibility today:** server-side media/data serving for playback. It has **zero** code relationship to the web engine — the web contour reaches it exclusively through HTTP endpoints (§7).

**Overlap with the future `@animastor/web-player`:** NONE in code; the relation is client↔server over the frozen 6-endpoint HTTP subset. No naming collision exists because the axes are explicit: `animastor-player` (backend, no `web-` prefix — the backend module convention) vs `animastor-web-player` (web frontend module convention — `animastor-web-*`, established by the two renamed packages, commits `28321b95`/`b09ce727`).

**Architectural dependency direction check:** the web package must NOT depend on `@animastor/player` (nor the reverse). The de-facto shared contract (URL grammar, `build_id` cache-key semantics, `video_version` mtime semantics, Range streaming behavior) is *wire-level* — same resolution as File's B4: document as the HTTP contract in both READMEs; optionally later a `@animastor/contracts` entry (out of scope here).

**Consistency with the standing decision:** `PLAYER_PACKAGE_EXTRACTION_READINESS_AUDIT.md` §12 ruled "web playbackStore/PlayPage … stay app-side thin clients by design … revisit only if a standalone '.vbook player' product is greenlit". This audit refines rather than contradicts: extracting `@animastor/web-player` as a *web-frontend module package* (the `animastor-web-*` queue — host composition, same app, no new product surface) does not create the cross-platform coupling that decision rejected. The web engine remains host-composed; Android remains untouched. No duplication results: `animastor-player` = server contour, `animastor-web-player` = browser client module; responsibilities are disjoint and named accordingly. **No changes to `animastor-player` are required or proposed.**

---

## 12. Blockers & risks

| # | Blocker/risk | Severity | Resolution (pre-extraction work) |
|---|---|---|---|
| **P1** | No ports exist — engine directly imports `generateStore` (event + `SceneRef`), `positionStore` (12 write sites), `resourceInvalidations` (subscription); page imports i18n/desktop/icons/generateStore identity | **HIGH** | Phase-1 prep in-app: create `src/modules/player/ports.ts` + `app/playerAdapters.ts`, refactor engine/page to injected ports (navigator playbook steps 1–2; no package yet, instantly rollbackable) |
| **P2** | Identity projection: engine-internal `bookId/buildId` signals mirror `generateStore`'s | **HIGH** | keep the projection internal; PlayPage placeholder logic switches to the port's session signals; package exports must NOT expose a second identity source (guard assertion) |
| **P3** | 6 host consumers (Edit, Settings, fileAdapters, navigatorAdapters, main, auth-book-session mock) import engine functions directly | MEDIUM | import-path re-aim to package entry (no call-site changes — signatures 1:1); guard pins the consumer list; optionally route Edit/Settings through adapters for symmetry (recommended, not required) |
| **P4** | First web package that OWNS shared runtime state (module-scope singletons, DOM media elements, RAF loops) | MEDIUM | host must import the entry instance only (Vite dedupe + entry-only guard); document single-instance requirement in README; extend cycle guards both host-side and package-side (§9.2) |
| **P5** | `API_BASE` used directly for the video src (:1668) — a base-URL assumption outside `api/client` seam | LOW | `videoUrl(path)` port method (navigator `mediaUrl` precedent) |
| **P6** | CSS/asset contract: `.play-*` rules + `theater_curtains.png` stay host | LOW | document class-name contract in package README (File/Navigator already work this way); no CSS moves |
| **P7** | Test mock re-aim: 7 suites mock host modules by specifier; auth-book-session mocks `../playbackStore` | LOW | mechanical: vi.mock targets become fake ports (navigator characterization pattern); auth-book-session re-aims at `@animastor/web-player` |
| **P8** | `phase`-type vocabulary triplication (`PlayerPhase` in playbackStore + generateStore + FilePorts) with `PLAYING`/`PAUSED` values that post-B1 nobody writes into `generateStore.phase` | LOW | no extraction blocker; record the ownership note during prep; optionally narrow `generateStore.PlayerPhase` later (separate cleanup, out of scope) |
| **P9** | Engine behavioral contracts that silently couple host tests (SAVED_POS_KEY sessionStorage, `animastor-media` cache name, `data-*`/DOM host div) | LOW | README data-contracts section (keys, cache name, hidden div); no code change |
| **P10** | Pre-existing unrelated test failure (`privateWorkers.test.ts` 1/313) | LOW | record as baseline noise (same as backend Player audit R14); do not gate on it |

**No architectural blockers are unresolved-in-principle**: every item has a precedented shape inside the two reference packages. The work is preparation, not redesign.

---

## 13. Recommended extraction phasing (future work — NOT executed here)

| Phase | Work | Exit criteria | Risk |
|---|---|---|---|
| **0. Characterize (optional, mostly done)** | the 67 existing tests already pin engine behavior; add port-level characterization only for the seams (session placeholders, generation-event full payload incl. coverImage/softRefresh, position writes) | seam contracts tested through fake ports | LOW |
| **1. Ports in-app (the big prep)** | create `src/modules/player/ports.ts` (`PlayerPorts` §4) + `src/app/playerAdapters.ts`; refactor `playbackStore` (event/position/invalidation/http injection), `PlayPage` (i18n/shellMode/icons/session props), re-aim Edit/Settings/fileAdapters/navigatorAdapters/main wiring; extend host contour guards | zero direct host-store imports from the 4 contour files (guard-green); full suite green; behavior byte-identical | MEDIUM (mechanical but wide — 62 exports, 12 position write sites) |
| **2. In-app relocation** | move the 4 files to `src/modules/player/` + tests; host keeps adapters | guards re-pinned to new paths; suite green | LOW |
| **3. Physical cut** | create `packages/animastor-web-player` (manifests copied from web-navigator, §8); move files; `frontends/app/package.json` gains `file:` dep; Vite dedupe already in place; adapters import `@animastor/web-player` | package `npm test` standalone green; host vitest + `tsc --noEmit` green; entry-only imports (guards §9.2) | MEDIUM (P4 single-instance verification: dev + build smoke that hooks/signals render against ONE preact copy) |
| **4. Hardening & release** | `prepublishOnly` (typecheck+test+build), CHANGELOG, README contracts (ports, class names, storage/cache keys, HTTP surface, single-instance requirement); npm pack dry-run | `npm pack --dry-run` clean; repo convention checklist (web-navigator precedent) | LOW |

Steps 1–2 are pure in-app motion (instantly rollbackable, no package); step 3 follows the two-time-proven physical-move playbook. Nothing in this sequence requires behavior change.

---

## 14. Final verdict

# **READY WITH CONDITIONS**

**Why not READY:** the PlayerPorts seam does not exist yet. Unlike Navigator (which had its ports prep landed *before* the audit's final verdict) and File (B1 split + ports + blockers closed before the cut), Web Player is at **Phase 0**: the engine still imports `generateStore`/`positionStore`/`resourceInvalidations`/`api/client` directly and the page still imports i18n/desktop/icons/identity directly; six host files consume the engine by module path; the package-side boundary guard and the wider host consumer set (6 vs the references' 2–3) need explicit guard design because this is the first stateful web package. Extracting physically today would produce a package with hard host imports or force a rushed port inversion inside the move commit — exactly what the phased playbook exists to avoid.

**Why not NOT READY:** the contour is measured, cohesive, best-tested (67 dedicated green tests), cycle-free (post-B1), deep-import-free, and every single dependency has an implemented, guard-frozen precedent shape in `web-navigator`/`web-file` — including the hard ones (identity-as-signals, event port, seek passthrough, invalidation consumer, shell-mode, i18n keys, icons, mediaUrl). The backend side is already a frozen HTTP contract (`@animastor/player`), and the relation to that package is clean and non-duplicative. The extraction is preparation-shaped, not redesign-shaped.

**Conditions to fulfill before physical extraction (all are Phase 1 prep, §13):**

1. Introduce `PlayerPorts` in-app (`src/modules/player/ports.ts`) + host composition root (`src/app/playerAdapters.ts`); engine consumes ONLY injected ports: generation-event (`onPlaybackPrepared` full payload), position (write-direction), invalidations (consumer), http (`getJson`/`getBlob`/`retryWithBackoff`/`videoUrl`), and PlayPage consumes session/i18n/shellMode/icons via ports.
2. Dissolve the identity projection from the public surface: the package must not export `bookId`/`buildId` signals as a second source of truth; PlayPage placeholder logic reads the port's session signals.
3. Re-aim the six host consumers (Edit, Settings, fileAdapters, navigatorAdapters, main, auth-book-session mock) at the (future) package boundary — in-app this means the adapters/wiring files only; pin the consumer list and entry-only import rule in guards.
4. Extend the host contour guard suite for the Player contour (entry points, reverse deps, no-deep-imports, no-relative-path resolution, cycle-guard re-aim from module path to port shape) and create the package-side `boundary.test.ts` with the engine-specific rule (no host-store specifiers in any src file).
5. Move the 4 files + 9 test files in-app (`src/modules/player/`) and re-pin guards (Phase 2) before any package directory is created.
6. Document the non-code contracts in the future README: `.play-*` CSS class names + curtains asset (host-owned), `animastor:playbackPosition` sessionStorage key, `animastor-media` Cache API name + key grammar, the 6-endpoint HTTP surface, single-instance requirement.

**Recommended boundary (recorded decision):** engine + gate + mediaCache + PlayPage as `@animastor/web-player` — a browser-only Preact/web-UI module over `PlayerPorts`; all shared signals/stores/infra stay host; CSS/assets stay host; Android stays a parallel parity implementation; `@animastor/player` (backend) untouched and unrelated by code. Sequence: prep (ports in-app) → in-app relocation → physical cut — the two-reference playbook.

---

*Verification (read-only, executed during this reconnaissance):* `frontends/app` — `npx vitest run src/state src/cache src/architecture` (147/147 pass), full `npx vitest run` (312/313, 1 pre-existing unrelated `privateWorkers` failure), package suites `animastor-web-navigator` (41/41) and `animastor-web-file` (31/31). Import-graph scans: `grep` over `frontends/app/src` for `playbackStore|playbackGate|mediaCache|positionStore|resourceInvalidations` consumers and contour outbound imports (`playbackStore.ts:22-32`, `PlayPage.tsx:7-27`); cycle state verified against the frozen guard (`file-navigator-contour.guard.test.ts:331-365`); backend consumption verified via `backend/src/backend.cjs:114` + `packages/animastor-player/src/*`. Nothing in the repository was modified by this reconnaissance (audit document excepted).
