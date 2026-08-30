# 03. Proposed `frontends/mobile/` Architecture

> Web version skeleton.
>
> **Stack locked (stage 0):** **Preact + Vite + TypeScript**.
> Preact provides React-compatible component model with minimal runtime
> (~3KB) — suitable for multiplex player/canvas and target mobile browsers.
> Reactive state — `@preact/signals` (equivalent to `StateFlow.collect`).
> Router — `preact-router` (hash/history mode).
>
> **Deployment:** Vite builds `frontends/mobile/src` → `frontends/mobile/dist`;
> `dist/` content served by nginx from `m.animastor.in` (see §6 — only expected
> proxy change: SPA-fallback + MIME `application/javascript` for
> ESM bundle). Source remains in repository; build artifacts (`dist/`,
> `node_modules/`) ignored (see `.gitignore`).

---

## 1. Skeleton requirements

| Requirement | Source | Priority |
|---|---|---|
| SPA navigation "tabs as pages" with state preservation | `MainActivity` hide/show by tags | high |
| Reactive state (equivalent to `StateFlow.collect`) | `ViewModel.uiState` | high |
| SSE / streaming responses (generation progress) | `ProgressStream.kt`, `/progress-panel` | high |
| Multiple synchronized media sources with seek | `PlayFragment` 3×`MediaPlayer` | high |
| Scene preloading (3 ahead) + retry/backoff | `PlaybackViewModel.preloadAhead` | high |
| i18n ru/en + auto | `strings.xml`/`values-ru` | high |
| Design tokens (dark/light/auto) | `themes.xml` | high |
| Local media cache | `SimpleDiskCache` | medium |
| Weak connection / offline placeholder | IU `NOT_GENERATED` overlay | medium |
| Tests + type-safe API models | `BackendApi`/`*Models.kt` | medium |

## 2. Architecture layers

```
frontends/mobile/
├── index.html                 ← SPA entry point, meta viewport, theme
├── assets/
│   └── fonts/                 ← (icons — inline in src/app/icons.tsx, see above)
├── src/
│   ├── app/                   ← shell: router, tab bar, toolbar, themes
│   │   ├── router.ts          ← routes /file /generate /play /edit /navigate + secondary
│   │   ├── icons.tsx          ← inline SVG tab icons 1:1 from res/drawable (ic_*.xml), currentColor tint
│   │   ├── theme.ts           ← dark/light/auto (by hour, like Android)
│   │   └── i18n.ts            ← ru/en/auto, dictionaries from strings.xml
│   ├── pages/                 ← Fragment equivalents (one per screen)
│   │   ├── FilePage.*
│   │   ├── GeneratePage.*
│   │   ├── PlayPage.*         ← most complex, see 06-RISKS §Player
│   │   ├── EditPage.*
│   │   ├── NavigatePage.*
│   │   ├── SettingsPage.*
│   │   ├── AiAssistantPage.*
│   │   ├── LibraryPage.*
│   │   ├── WorkflowManagerPage.* / WorkflowDetailsPage.* / WorkflowTypeListPage.*
│   │   ├── DeveloperViewPage.*
│   │   ├── VBookSettingsPage.*
│   │   └── WorkerSettingsPage.*
│   ├── features/              ← shared reusable UI blocks (see 04-MAPPING §2)
│   │   ├── player/            ← Player engine, IUCycling, layers, fullscreen
│   │   ├── timeline/          ← edit: waveform, scene units, timings
│   │   ├── navigate/          ← map: chapters/scenes/units → seek
│   │   ├── generation/        ← generate: SSE progress, status indicator
│   │   └── ai-chat/           ← assistant: sessions, messages, typing
│   ├── api/                   ← HTTP client + endpoints (1:1 with BackendApi.kt)
│   │   ├── client.ts          ← fetch wrapper, base `/api/v1`, SSE, timeout/retry
│   │   ├── book.ts scene.ts ai.ts worker.ts connector.ts workflow.ts
│   │   └── types.ts           ← models from repository/*Models.kt (BookData, StoryboardResponse, SceneStatus, WaveformData, …)
│   ├── state/                 ← app store (equivalent to ViewModel/StateFlow)
│   │   ├── bookStore.ts
│   │   ├── generateStore.ts   ← playbackPrepared signal (coordination, like MainActivity)
│   │   ├── playbackStore.ts   ← PlaybackUiState, sceneQueue, phase, seek
│   │   └── positionStore.ts   ← SharedPositionManager (ActivePosition)
│   ├── cache/                 ← Cache API + IndexedDB (equivalent to SimpleDiskCache)
│   │   └── mediaCache.ts      ← audio/video/iuBlobs with TTL and clearCache()
│   ├── lib/
│   │   ├── waveform.ts        ← canvas renderer WaveformView (WaveformData)
│   │   ├── bitmap.ts          ← createImageBitmap (MediaDecoder.decodeBitmap)
│   │   └── retry.ts           ← retryWithBackoff
│   └── styles/
│       ├── tokens.css         ← cinema_* from colors.xml
│       ├── theme-dark.css theme-light.css
│       └── components.css      ← button/chip/card/tab/toolbar
└── tests/
```

## 3. State and reactivity

- Single **store** with subscriptions (analogous to `StateFlow.collect`) for:
  - `generateStore` — handles generation and emits `playbackPrepared`.
  - `playbackStore` — `PlaybackUiState{phase, coverImage, errorMessage,
    chunkSequence, missingIuPosition}`, `sceneQueue[]`, `currentIndex`,
    `currentUnitIndex`, `pendingSceneAudio/Video/IuSequence`, layer toggles,
    preload cache.
  - `positionStore` — `SharedPositionManager` (`ActivePosition`:
    `chapterId/sceneId/unitId/chunkId/unitIndex`).
- **"Generation → player" coordination** reproduces
  `MainActivity.setupPlaybackCoordination()`: on `playbackPrepared` call
  `playbackStore.preparePlayback(bookId, buildId, scenes)` (or `refreshContent`
  for soft refresh).
- Player phase mapping `PlayerPhase` (IDLE/LOADING_BOOK/GENERATING/DOWNLOADING/
  SCENE_READY/PLAYING/PAUSED/IMPORTING_TXT) preserved as enum in store and
  used by UI play/pause button and status text (1:1 with strings).

## 4. API layer

- `api/client.ts` — single `fetch` wrapper:
  - base `/api/v1/` (proxied by nginx from `m.animastor.in/api/`).
  - SSE client for progress (equivalent to `ProgressStream.kt`).
  - `retryWithBackoff` (3 attempts, 1s→2→5s) as in `PlaybackViewModel`.
  - streaming large byte responses (audio/video) into Blob with write to
    `mediaCache`.
- `types.ts` — auto-generated/manual TypeScript type set based on
  `repository/*Models.kt`. All endpoints cataloged in
  [`04-MAPPING-TABLES.md`](04-MAPPING-TABLES.md) §4.

## 5. Routing

| Route | Android | Type |
|---|---|---|
| `/file` | `FileFragment` | tab #1 (home) |
| `/generate` | `GenerateFragment` | tab #2 |
| `/play` | `PlayFragment` | tab #3 |
| `/edit` | `EditFragment` | tab #4 |
| `/navigate` | `NavigateFragment` | tab #5 |
| `/settings` | `SettingsFragment` | secondary (back stack) |
| `/ai` | `AiAssistantFragment` | secondary |
| `/library` | `LibraryFragment` | secondary (contains WebView) |
| `/workflows` | `WorkflowManagerFragment` | secondary |
| `/workflows/:name` | `WorkflowDetailsFragment` | secondary |
| `/workflows/type/:type` | `WorkflowTypeListFragment` | secondary |
| `/dev` | `DeveloperViewFragment` | secondary |
| `/settings/vbook` | `VBookSettingsFragment` | secondary |
| `/settings/worker` | `WorkerSettingsFragment` | secondary |

Tab state preserved on switch (like `hide/show`), not destroyed — for this
store lives outside page component (at shell level).

## 6. Deployment infrastructure

Already configured in `proxy/conf/default.conf`:
- `m.animastor.in` → `root /usr/share/nginx/frontends/mobile`, `index index.html`.
- `/api/` and `/gpu/` proxied to same upstreams as desktop.
- `try_files $uri $uri/ =404` — SPA needs fallback to `index.html` for
  HTML5 route (controlled by router history mode). This is the only expected
  proxy change — implement **after** router selection and document here.
- Temporary Basic Auth (until development complete) — keep.

## 7. Open questions (resolved when work starts)

1. SPA framework/router selection (requirement: heavy player + reactivity).
2. SSE client under mobile network interruptions (reconnect, monotonicity from
   `docs/05-frontend/PROGRESS_HANDOFF.md`).
3. Media cache strategy: Cache API (HTTP cache) vs IndexedDB (byte-blob cache with
   manual invalidation by `buildId` — like `clearCache()` in `preparePlayback`).
4. Background pause/deferred seek support via `Page Visibility` (analogous to
   `onHiddenChanged` / `onPause` in `PlayFragment`).
