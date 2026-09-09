# @animastor/navigator

Book-structure navigation tree (chapters → scenes → units) for Animastor, packaged as a standalone Preact module.

> **Scope — Preact/Web UI module.** This package is a **specialized Web/Frontend UI module** built on **Preact** (+ `@preact/signals`), for embedding into browser-based Animastor hosts (`frontends/app`). It is **not** a platform-independent or domain module: it renders DOM through Preact JSX, and its rendering semantics (desktop/mobile fork, thumbnails, `scrollIntoView`, `matchMedia`-driven shell mode) are web-specific. It is **not intended for Android/native UI** — the Android Navigator (`NavigateFragment` / `fragment_navigate.xml`) remains a separate native implementation; this package does not target it directly. Domain logic (book model, seek, reload, invalidations) stays host-owned behind the ports — extracting a cross-platform `navigator-core` is a possible future task, not part of this package.

The Navigator owns no runtime infrastructure. Every host dependency — playback seek, book source, shared position, invalidation bus, reload pipeline, desktop/mobile shell mode, navigation, HTTP, i18n, icons — arrives through the [`NavigatorPorts`](#navigatorports) contract injected as a prop. The package never imports host stores, the API client, router, i18n or icon kit, so it can be mounted by any **Preact** host that implements the ports.

## Install

```sh
npm install @animastor/navigator
```

Peer dependencies (must be provided by the host):

- `preact` >= 10.5
- `@preact/signals` >= 1

## Usage

```tsx
import { render } from 'preact';
import { NavigatePage, type NavigatorPorts } from '@animastor/navigator';

const ports: NavigatorPorts = {
  seek: { seekToPosition: (ch, sc, idx, unitId) => myPlayer.seek(ch, sc, idx, unitId) },
  bookSource: { bookId, buildId, onPlaybackPrepared },
  position: { position: positionSignal, navigateTo },
  invalidations: { onResourceInvalidated, bookResource: (id) => `book:${id}` },
  reload: { resilientReload, sharedRecovery },
  shellMode: { isDesktop: () => window.matchMedia('(min-width: 1180px)').matches },
  navigation: { navigateToPlay: () => router.go('/play') },
  http: { getJson, mediaUrl },
  i18n: { t },
  icons: { Play: IconPlay, ImageOff: IconImageOff },
};

render(<NavigatePage ports={ports} />, document.getElementById('app'));
```

## Public API

| Export | Kind | Purpose |
|---|---|---|
| `NavigatePage` | component | The Navigator surface; takes `{ path?: string; ports: NavigatorPorts }` |
| `buildStructure` | function | Pure chapters→scenes→units tree builder (Android-parity labels) |
| `chapterLabel`, `sceneLabel`, `unitLabel` | functions | Label grammar helpers |
| `NavigatorPorts` | type | The full host contract (10 ports, see below) |
| `NavItem` | type | Tree item union rendered by the list |
| `BookData`, `BookChapter`, `BookScene`, `BookUnit` | types | Structural book models the Navigator reads |
| Port payload types | types | `ActivePosition`, `PlaybackPreparedEvent`, `ResourceInvalidationEvent`, `NetworkRecoverySignal`, `ReloadResult`, `NavigatorT`, `NavigatorI18nKey`, `NavigatorIconProps` |
| Individual port types | types | `SeekPort`, `BookSourcePort`, `PositionPort`, `InvalidationPort`, `ReloadPort`, `ShellModePort`, `NavigationPort`, `HttpPort`, `I18nPort`, `IconsPort` |

### NavigatorPorts

| Port | Role |
|---|---|
| `seek` (`SeekPort`) | External seek — 1:1 with the host player's `seekToPosition` (same async/error semantics) |
| `bookSource` (`BookSourcePort`) | Session identity: `bookId`/`buildId` signals + generation-completion subscription |
| `position` (`PositionPort`) | Shared navigation position signal + `navigateTo` |
| `invalidations` (`InvalidationPort`) | External freshness events (`EXTERNAL`/`LOCAL`) for the open book |
| `reload` (`ReloadPort`) | Bounded backoff reload + connectivity recovery signal |
| `shellMode` (`ShellModePort`) | Desktop/mobile behavioral fork (`isDesktop()`) |
| `navigation` (`NavigationPort`) | `navigateToPlay()` — router knowledge stays host-owned |
| `http` (`HttpPort`) | `getJson` + `mediaUrl` (preview URL grammar stays host-owned) |
| `i18n` (`I18nPort`) | `t` for the Navigator's i18n keys |
| `icons` (`IconsPort`) | `Play` / `ImageOff` icon components |

## Behavior contract

- Desktop: unit tap selects only (position + seek, no route change); double-click or the active-row play button seeks and navigates to the player.
- Mobile: unit tap selects, seeks and navigates to the player (`switchToPlayTab` parity).
- The current position's scene auto-expands on mount and follows position changes.
- The tree reloads on: `bookId` change, generation completion for the same book, `EXTERNAL` invalidation of the open book.
- Unit thumbnails use `http.mediaUrl` with the `/preview/{book}/{ch}/{sc}/{iu}?build_id=` grammar; failures fall back to the `ImageOff` icon.

## Package boundary

- The package imports only `preact`, `preact/hooks`, `preact/jsx-runtime` and `@preact/signals`.
- Host stores, `api/client`, router, i18n, icons, `AppShell` and adapter modules are **forbidden** inside the package (enforced by boundary tests in the repository).
- `@animastor/navigator → host` = forbidden; `host → @animastor/navigator` = allowed through the public entry point only.
- **Technology boundary**: `@animastor/navigator` is a **Preact/Web UI module** — not a cross-platform or domain package. No `navigator-core` split exists yet; the Android/native Navigator is out of scope for this package.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run test        # vitest (27 characterization + boundary tests)
npm run build       # tsup → dist/ (ESM + d.ts + sourcemaps)
```

## License

MIT
