# @animastor/web-generator-config

Layer-config load/persist domain logic for Animastor web frontend — fetching and saving book layer configuration (audio/image/video/vbook toggles, analysis mode/parallelism) and asset-state queries.

> **Scope — Pure domain logic.** This package contains **no UI components, no signals, no JSX**. All host capabilities arrive through injected ports: identity (`IdentityPort`) and JSON HTTP transport (`TransportPort`). The package never imports host stores, `api/client`, `app/*` (router/i18n/desktop/icons), pages, `@preact/signals`, or any `@animastor/*` package.

## Install

```sh
npm install @animastor/web-generator-config
```

No peer dependencies required — the package is pure TypeScript with zero runtime dependencies.

## Usage

```ts
import {
  loadLayerConfig,
  persistLayerConfig,
  getAssetsState,
  type IdentityPort,
  type TransportPort,
} from '@animastor/web-generator-config';

const identity: IdentityPort = {
  getBookId: () => bookId.value, // host-owned signal read
};

const transport: TransportPort = {
  getJson: (path) => api.getJson(path),       // host binds api/client
  putJson: (path, body) => api.putJson(path, body),
};

// Load the config for the current book (null if no book open / request failed)
const config = await loadLayerConfig(identity, transport);

// Persist the toggles back to the server
await persistLayerConfig(transport, bookId.value, {
  audio_enabled: true,
  image_enabled: false,
  video_enabled: true,
  vbook_enabled: true,
});

// Asset-state query (drives the "already generated" UI hints)
const assets = await getAssetsState(identity, transport);
```

The caller (host) applies returned values to host-owned signals; this package only performs the load/persist decision logic.

## Public API

| Export | Kind | Purpose |
|---|---|---|
| `loadLayerConfig` | function | Fetch `/book/{id}/layer-config`; `null` on no book / failure |
| `persistLayerConfig` | function | PUT `/book/{id}/layer-config`; no-op on empty bookId, errors logged and swallowed |
| `getAssetsState` | function | Fetch `/book/{id}/assets-state`; `null` on no book / failure |
| `IdentityPort` | interface | Read-only identity — `getBookId()` |
| `TransportPort` | interface | JSON HTTP transport — `getJson` / `putJson` |
| `LayerConfig` | type | Layer-config wire contract (vendored from `api/models.ts`) |
| `AssetsState` | type | Asset-state wire contract (vendored from `api/models.ts`) |

## Package boundary

- Zero `dependencies` and zero `peerDependencies` — pure functions parameterized by explicit ports.
- Host stores, `api/client`, `app/*`, `pages/*`, signals, and `@animastor/*` packages are **forbidden** inside the package (enforced by architecture guard tests).
- Wire types are vendored locally (`src/models.ts`), following the `@animastor/web-player` `models.ts` precedent.
- `@animastor/web-generator-config → host` = forbidden; `host → @animastor/web-generator-config` = allowed through the public entry point only.

## Place in the Animastor architecture

Part of the web-generator package family extracted from the generation-progress contour of the Animastor web frontend:

- `@animastor/web-generator` — analysis state machine, progress rows, SSE event routing, timer
- `@animastor/web-generator-config` — layer-config load/persist (this package)
- `@animastor/web-generator-vbook` — VBook agent lifecycle orchestration
- `@animastor/web-generator-sse` — SSE reconnect loop and epoch-guarded event routing

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run test        # vitest (domain unit tests)
npm run build       # tsup → dist/ (ESM + d.ts + sourcemaps)
```

## License

MIT
