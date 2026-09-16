# @animastor/web-generator-sse

SSE stream orchestration for Animastor generation progress — the reconnect loop with exponential backoff, epoch-guarded stale-session detection, and event routing through the `@animastor/web-generator` domain router.

> **Scope — Pure domain logic.** This package contains **no UI components, no signals, no JSX, and no SSE transport**. The host owns the AbortController, the SSE connection, the epoch counter, and the host signals; this package consumes the stream as an async iterable and routes events. It imports only `@animastor/web-generator` and never touches host stores, `api/client`, or `@preact/signals`.

## Install

```sh
npm install @animastor/web-generator-sse
```

Runtime dependency: `@animastor/web-generator` (`^0.1.0`).

## Usage

```ts
import {
  runSseStream,
  handleProgressEvent,
  type SseStreamPort,
} from '@animastor/web-generator-sse';

// Host owns the actual SSE connection and AbortController
const streamPort: SseStreamPort = {
  start: (bookId) => api.startProgressStream(bookId), // AsyncIterable<SseEvent>
  stop: () => abortController.abort(),
};

await runSseStream(
  streamPort,
  () => epoch.value,                 // host bumps epoch on cancel/new generation
  progressEventSink,                 // host signal bridge
  progressTracking,                  // host-owned tracking state
  bookId.value,
  { initialDelayMs: 1000, maxDelayMs: 15000, maxExponent: 4 }, // optional
);
```

Reconnect triggers: normal stream close and stream error — both retry with exponential backoff (1s → 2s → 4s → 8s → 15s cap by default). Exit condition: epoch mismatch (host bumped epoch → cancel / new generation).

For manual event dispatch (testing or one-off routing):

```ts
handleProgressEvent(sink, tracking, rawData);
```

## Public API

| Export | Kind | Purpose |
|---|---|---|
| `runSseStream` | function | Reconnect loop: iterate the host stream, route events, backoff-reconnect, exit on epoch mismatch |
| `handleProgressEvent` | function | Route a single SSE payload through the domain router (convenience wrapper) |
| `SseStreamPort` | interface | Host stream capabilities — `start(bookId)` → `AsyncIterable<SseEvent>`, `stop()` |
| `SseEvent` | interface | Minimal SSE event shape — `{ data: string }` |
| `SseStreamConfig` | interface | Tuning: `initialDelayMs`, `maxDelayMs`, `maxExponent` |
| `ProgressEventSink` / `ProgressTrackingState` | types | Re-exported from `@animastor/web-generator` |

## Package boundary

- Runtime dependency: `@animastor/web-generator` ONLY (for `routeProgressEvent`, `ProgressEventSink`, `ProgressTrackingState`).
- Host stores, `api/client`, `app/*`, `pages/*`, `@preact/signals`, and other `@animastor/*` packages are **forbidden** inside the package (enforced by architecture guard tests).
- The host owns the AbortController + SSE connection, the epoch counter, host signals, and `ProgressTrackingState`; the package owns the reconnect loop, epoch checking, and event routing.
- `@animastor/web-generator-sse → host` = forbidden; `host → @animastor/web-generator-sse` = allowed through the public entry point only.

## Place in the Animastor architecture

Part of the web-generator package family extracted from the generation-progress contour of the Animastor web frontend:

- `@animastor/web-generator` — analysis state machine, progress rows, SSE event routing, timer
- `@animastor/web-generator-config` — layer-config load/persist
- `@animastor/web-generator-vbook` — VBook agent lifecycle orchestration
- `@animastor/web-generator-sse` — SSE reconnect loop and epoch-guarded event routing (this package)

The host's `startProgressStream` arrives as the `startStream` lifecycle callback of `@animastor/web-generator-vbook`; the VBook lifecycle starts the stream, this package runs it.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run test        # vitest (domain unit tests)
npm run build       # tsup → dist/ (ESM + d.ts + sourcemaps)
```

## License

MIT
