# @animastor/web-generator-vbook

VBook agent lifecycle orchestration for Animastor web frontend — the real VBook decision logic: bootstrap-vs-next-window choice, agent-status polling loop, and paused/inactive/safety-cap terminal-state classification.

> **Scope — Pure domain logic.** This package contains **no UI components, no signals, no JSX, and no SSE implementation**. All host capabilities arrive through the injected `VBookAgentPorts` bundle (identity, transport, poll state, host state callbacks, lifecycle callbacks). The package imports only `@animastor/web-generator` and never touches host stores, `api/client`, navigation, or playback.

## Install

```sh
npm install @animastor/web-generator-vbook
```

Runtime dependency: `@animastor/web-generator` (`^0.1.0`).

## Usage

```ts
import {
  createVBookPollState,
  startVBookGeneration,
  checkAgentStatus,
  type VBookAgentPorts,
} from '@animastor/web-generator-vbook';

// Host binds its own capabilities; the package decides WHEN and WHAT,
// the host decides how each write lands (signals, navigation, playback).
const ports: VBookAgentPorts = {
  identity: { getBookId: () => bookId.value },
  transport: {
    getJson: (path) => api.getJson(path),
    postJsonLong: (path, body) => api.postJsonLong(path, body),
  },
  poll: createVBookPollState(), // host-owned; bumping the token cancels stale polls
  state: {
    getVBookProgress: () => vbookProgress.value,
    setVBookProgress: (p) => (vbookProgress.value = p),
    setGenerationStatus: (s) => (generationStatus.value = s),
    getIsRegenerating: () => isRegenerating.value,
    setIsRegenerating: (v) => (isRegenerating.value = v),
    setNewGenerationPending: (v) => (progressTracking.newGenerationPending = v),
    setImportCompleteReceived: (v) => (progressTracking.importCompleteReceived = v),
    getImportCompleteReceived: () => progressTracking.importCompleteReceived,
  },
  lifecycle: {
    startTimer, stopTimer,
    startStream: (bid) => startProgressStream(bid), // SSE stays host-side
    onVBookCleared: clearVBookProgress,
    onGenerationFinalized: applyGenerationResults,
  },
};

// One click = one window: bootstrap / bootstrap-next-window + poll to completion
await startVBookGeneration(ports);

// The GeneratePage 1.5s panel poll
await checkAgentStatus(ports);
```

On success the package sets `setGenerationStatus('SUCCESS')`, stops the timer (unless the session is still regenerating), and hands finalization back to the host via `onGenerationFinalized`.

## Public API

| Export | Kind | Purpose |
|---|---|---|
| `startVBookGeneration` | function | Bootstrap-vs-next-window decision + long-timeout POST + poll loop |
| `pollVBookProgress` | function | 2s poll loop — inactive×2 / `paused` / import-handshake finalization, 60min safety cap with agent re-probe |
| `checkAgentStatus` | function | One `/agent-status` poll + merge + ANALYZING/CREATING_SCENES→COMPLETED classification |
| `updateVBookProgress` | function | Merge an `/agent-status` payload into the current VBookProgress |
| `createVBookPollState` | function | Fresh host-owned poll-state object (`{ token: 0 }`) |
| `VBookAgentPorts` | interface | Full capability bundle (identity / transport / poll / state / lifecycle) |
| `VBookIdentityPort` | interface | `getBookId()` |
| `VBookTransportPort` | interface | `getJson` / `postJsonLong` |
| `VBookPollState` / `VBookPollContract` | interfaces | Explicit poll-token state (host-owned, passed by reference) |
| `VBookHostState` | interface | Host state callbacks (progress, status, regenerating, latches) |
| `VBookLifecycleCallbacks` | interface | `startTimer` / `stopTimer` / `startStream` / `onVBookCleared` / `onGenerationFinalized` |
| `VBookPollConfig` | interface | Tuning: `pollIntervalMs`, `errorIntervalMs`, `maxInactive`, `maxPollMs` |
| `AgentStatusWire` / `BookStatusWire` | types | Vendored wire contracts (`/agent-status`, `/status`) |
| `AgentStatusLike` / `VBookProgress` | types | Re-exported from `@animastor/web-generator` |

## Package boundary

- Runtime dependency: `@animastor/web-generator` ONLY (for `applyAgentStatus`, `createAnalyzingVBookProgress`, types).
- Host stores, `api/client`, `app/*`, `pages/*`, `@preact/signals`, and other `@animastor/*` packages are **forbidden** inside the package (enforced by architecture guard tests).
- Transport and identity only through the injected ports; the host binds `api/client`'s `getJson`/`postJsonLong`.
- No module-global mutable state — all mutable state is explicit (`VBookPollState` / `VBookPollContract`), owned by the host.
- Wire types are vendored locally (`src/models.ts`).
- `@animastor/web-generator-vbook → host` = forbidden; `host → @animastor/web-generator-vbook` = allowed through the public entry point only.

## Place in the Animastor architecture

Part of the web-generator package family extracted from the generation-progress contour of the Animastor web frontend:

- `@animastor/web-generator` — analysis state machine, progress rows, SSE event routing, timer
- `@animastor/web-generator-config` — layer-config load/persist
- `@animastor/web-generator-vbook` — VBook agent lifecycle orchestration (this package)
- `@animastor/web-generator-sse` — SSE reconnect loop and epoch-guarded event routing

The host owns `vbookProgress` (written via the `setVBookProgress` callback), the poll-token authority, the timer, the SSE AbortController/epoch lifecycle, and `applyGenerationResults`; finalization hands back to the host via `onGenerationFinalized`.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run test        # vitest (domain unit tests)
npm run build       # tsup → dist/ (ESM + d.ts + sourcemaps)
```

## License

MIT
