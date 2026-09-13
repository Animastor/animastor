# @animastor/web-ai-chat

Pure AI chat streaming UX helpers for Animastor web frontend.

## Scope

This package provides pure functions and types for AI chat streaming UX:

- **`sourceBadgeKey`** — maps `ai_source` tokens to honest Private/Shared/Cloud/System badge i18n keys
- **`streamErrorKey`** — maps sanitized backend error codes to localized state i18n keys
- **`isUserCancelled`** — distinguishes user-initiated cancel from other aborts

**Zero host dependencies.** The package imports nothing but its own internal modules. No host stores, no `api/client`, no i18n, no DOM APIs.

## Install

```sh
npm install @animastor/web-ai-chat
```

No peer dependencies required — pure functions and types only.

## Usage

```ts
import { sourceBadgeKey, streamErrorKey, isUserCancelled } from '@animastor/web-ai-chat';

// Map an ai_source token to a badge i18n key
const badgeKey = sourceBadgeKey('shared'); // 'ai_source_shared'

// Map a backend error code to a localized state key
const errorKey = streamErrorKey('connector_offline'); // 'ai_state_offline'

// Check if the stream was cancelled by the user
const cancelled = isUserCancelled(err, { current: true });
```

## Public API

| Export | Kind | Purpose |
|---|---|---|
| `AiSource` | type | `'private-local' | 'shared' | 'cloud' | 'system'` |
| `sourceBadgeKey` | function | Maps `ai_source` token → badge i18n key |
| `streamErrorKey` | function | Maps sanitized backend error code → i18n key |
| `isUserCancelled` | function | Detects user-initiated cancel vs other aborts |

## Behavior contract

- `sourceBadgeKey` maps only the four known tokens (`private-local`, `shared`, `cloud`, `system`); unknown tokens return `null`.
- `streamErrorKey` maps only known sanitized backend codes; unknown codes return `null` (fall back to backend message).
- `isUserCancelled` returns `true` when `cancelledRef.current` is `true` OR the error is an `AbortError`/`TimeoutError`.

## Package boundary

- The package imports only its own internal modules — zero host imports.
- `@animastor/web-ai-chat → host` = forbidden; `host → @animastor/web-ai-chat` = allowed through the public entry point only.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run test        # vitest (pure function tests)
npm run build       # tsup → dist/ (ESM + d.ts + sourcemaps)
```

## License

MIT
