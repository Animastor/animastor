# @animastor/web-settings

Pure AI provider and Local AI Connector helpers for Animastor web frontend.

## Scope

This package provides pure functions and types for AI settings UI:

### AI Provider helpers

- **`normalizeMeta`** — defensive normalizer for provider meta from API
- **`validateProviderInput`** — form validation before PUT
- **`describeTestResult`** — test connection result to safe UI string
- **`statusLabel`** — status badge for saved-state pill
- **`formatLastTested`** — epoch-seconds timestamp to relative string
- **`canSave`** — save button disable logic

### Local AI Connector helpers

- **`validateCreateInput`** — create-connector form validation
- **`looksLikeRegToken`** — registration token shape check
- **`looksLikeConnectorCredential`** — credential shape check
- **`statusKey` / `statusClass`** — connector status badge mapping
- **`runtimeReachable`** — runtime reachability check
- **`connectorErrorKey`** — sanitized error code → i18n key
- **`buildRunCommand`** — npx launch command builder
- **`shareStatus` / `shareStatusKey` / `shareStatusClass`** — sharing badge mapping

**Zero host dependencies.** The package imports nothing but its own internal modules. No host stores, no `api/client`, no i18n, no DOM APIs.

## Install

```sh
npm install @animastor/web-settings
```

No peer dependencies required — pure functions and types only.

## Usage

```ts
import { normalizeMeta, validateProviderInput, statusKey, shareStatus } from '@animastor/web-settings';

// Normalize provider meta from API response
const meta = normalizeMeta(rawJson);

// Validate provider form input
const result = validateProviderInput({ providerType: 'openrouter', endpoint: '...', apiKey: '...', model: '...', isExisting: false });

// Get connector status badge key
const badgeKey = statusKey({ status: 'online', live: true }); // 'local_ai_status_online'

// Get sharing badge state
const share = shareStatus({ sharing_enabled: true, connector_live: true, runtime_reachable: true }); // 'shared'
```

## Public API

See [src/index.ts](./src/index.ts) for the complete public API surface.

## Package boundary

- The package imports only its own internal modules — zero host imports.
- `@animastor/web-settings → host` = forbidden; `host → @animastor/web-settings` = allowed through the public entry point only.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run test        # vitest (pure function tests)
npm run build       # tsup → dist/ (ESM + d.ts + sourcemaps)
```

## License

MIT
