# @animastor/web-player

The browser playback engine and Play surface for Animastor, packaged as a standalone Preact module.

> **Scope — Preact/Web UI + engine module.** This package is a **specialized Web/Frontend UI module** built on **Preact** (+ `@preact/signals`), for embedding into browser-based Animastor hosts (`frontends/app`). It is **not** a platform-independent or domain module: it renders DOM through Preact JSX and drives browser media APIs (`HTMLAudioElement`/`HTMLVideoElement`, Cache API, `requestAnimationFrame`, `sessionStorage`, `document.visibilitychange`). It is **not intended for Android/native UI** — the Android player (`PlaybackViewModel.kt` / `PlayFragment.kt`) remains a separate native implementation with contractual parity (`ANDROID_WEB_PARITY.md`); this package does not target it directly and shares no code with it. The **backend playback contour** is a separate package (`@animastor/player`) — the two relate only over frozen HTTP endpoints, and this package must never depend on it.

The Player owns no host infrastructure. Every host dependency — session identity (`bookId`/`buildId`), generation-completion events, shared position writes, the invalidation bus, HTTP with the `/api/v1` base, desktop-shell detection, i18n, the icon kit — arrives through the [`PlayerPorts`](#playerports) contract injected as a prop / at wiring time. The package never imports host stores, the API client, i18n, the desktop module or the icon kit, so it can be mounted by any **Preact** host that implements the ports.

## Install

```sh
npm install @animastor/web-player
```

Peer dependencies (must be provided by the host):

- `preact` >= 10.5
- `@preact/signals` >= 1

## Usage

The engine outlives the page, so wiring has two moments: wire the engine once at composition-root load, and render the page with the same ports object.

```tsx
import { render } from 'preact';
import { PlayPage, wirePlaybackCoordination, wirePlaybackLifecycle, type PlayerPorts } from '@animastor/web-player';

const ports: PlayerPorts = {
  session: { bookId, buildId },                          // generateStore singletons, passed by reference
  generation: { onPlaybackPrepared },                    // full payload: scenes + coverImage + softRefresh
  position: { navigateTo },                              // shared position writes
  invalidations: { onResourceInvalidated, isBookResource }, // pure consumer of the freshness bus
  http: { getJson, getBlob, retryWithBackoff, videoUrl },   // videoUrl: direct <video> src builder
  shellMode: { isDesktop },                              // desktop/mobile shell fork
  i18n: { t },                                           // typed Player i18n keys
  icons: { Play, Pause, VolumeUp, VolumeOff, Image, ImageOff, Videocam, VideocamOff, Subtitles, SubtitlesOff, Fullscreen, FullscreenExit },
};

wirePlaybackCoordination(ports);   // engine composition (runs once, before engine use)
wirePlaybackLifecycle();           // visibility/pagehide lifecycle listeners

render(<PlayPage path="/play" ports={ports} />, document.getElementById('app'));
```

## Public API

| Export | Kind | Purpose |
|---|---|---|
| `PlayPage` | component | The Play surface; takes `{ path?: string; ports: PlayerPorts }` |
| `wirePlaybackCoordination` | function | Wires the engine to the host ports (call once at composition root) |
| `wirePlaybackLifecycle` | function | Installs document visibility + pagehide/pageshow lifecycle listeners |
| `seekToPosition` | function | External seek entry (host navigator/Edit carousel parity) |
| `closeBook` | function | Player release on book close (host fileStore `player` seam) |
| `invalidateDeletedScene` | function | Queue/cache eviction when a scene is deleted |
| `invalidateDeletedChapter` | function | Queue/cache eviction when a chapter is deleted |
| `clearMediaCache` | function | Cache API media eviction (Settings "clear cache") |
| `PlayerPorts` | type | The full host contract (8 ports, see below) |
| Individual port types | types | `PlayerSessionPort`, `PlayerGenerationPort`, `PlayerPositionPort`, `PlayerInvalidationsPort`, `PlayerHttpPort`, `PlayerShellModePort`, `PlayerI18nPort`, `PlayerIconsPort` |
| Payload types | types | `PlayerActivePosition`, `PlaybackPreparedEvent`, `PlayerResourceInvalidationEvent`, `PlayerI18nKey`, `PlayerIconProps`, `PlayerIconComponent` |

### PlayerPorts

| Port | Role |
|---|---|
| `session` (`PlayerSessionPort`) | Shared session identity signals (`bookId`/`buildId`) — host singletons passed by reference; the package keeps only an internal projection and is not a second source of truth |
| `generation` (`PlayerGenerationPort`) | Generation-completion events (full payload — deliberately not narrowed) |
| `position` (`PlayerPositionPort`) | Shared active position — write direction |
| `invalidations` (`PlayerInvalidationsPort`) | Resource invalidation bus — pure consumer |
| `http` (`PlayerHttpPort`) | JSON/blob fetch with retry/backoff + `videoUrl` for the direct `<video>` src |
| `shellMode` (`PlayerShellModePort`) | Desktop/mobile shell fork (host `matchMedia`) |
| `i18n` (`PlayerI18nPort`) | `t` for the Player's i18n keys (dictionary stays host-owned) |
| `icons` (`PlayerIconsPort`) | 12 icon components (Play, Pause, VolumeUp/Off, Image/Off, Videocam/Off, Subtitles/Off, Fullscreen/Exit) |

## Behavior contract

- Engine state (queue, preload, gapless transitions, IU cycling, video buffer gate) lives in module-scope singletons and survives tab switches; the engine mounts a hidden host `div` to `document.body` exactly once via `wirePlayback*` (single-instance requirement — one package instance per host).
- Session identity: `bookId`/`buildId` are **host-owned** (the port signals are the host singletons); the package's internal projection is set by the generation event and never re-exported.
- Position restore: the last playback position is persisted under the `animastor:playbackPosition` `sessionStorage` key and re-attached on mount (bfcache restores via `pageshow`).
- Media cache: scene audio/video/IU images are cached in the browser Cache API under the `animastor-media` cache name with a `buildId`-scoped key grammar; deleted scene/chapter invalidations evict entries; `clearMediaCache` clears the cache (the count is user-visible in host Settings).
- Video: the direct `<video>` src is built by the host-provided `videoUrl` (progressive Range streaming — no fetch).
- CSS/asset contract: the surface renders host-owned `.play-*` class names and the host-owned curtains asset; no CSS is bundled in the package.
- HTTP surface: the engine consumes a strict 6-endpoint subset of the backend playback contract (`GET /book/:bookId`, scene `status`/`storyboard`/`audio`/`video`, `iu-image`) — wire-level only; no code dependency on any backend package.

## Package boundary

- The package imports only `preact`, `preact/hooks`, `preact/jsx-runtime` and `@preact/signals`.
- Host stores, `api/client`, i18n, desktop, icons and adapter modules are **forbidden** inside the package (enforced by boundary tests in the repository and in the package itself).
- `@animastor/web-player → host` = forbidden; `host → @animastor/web-player` = allowed through the public entry point only.
- **Technology boundary**: `@animastor/web-player` is a **Preact/Web module** — not a cross-platform package. The Android player is a separate parity implementation, and the backend playback contour is the separate `@animastor/player` package.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run test        # vitest (engine characterization + boundary tests)
npm run build       # tsup → dist/ (ESM + d.ts + sourcemaps)
```

## License

MIT
