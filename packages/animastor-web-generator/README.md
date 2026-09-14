# @animastor/web-generator

Generation-progress domain slice for Animastor web frontend — the pure/near-pure analysis state machine, progress panel rows, SSE event routing, and generation timer.

> **Scope — Pure domain logic.** This package contains **no UI components, no signals, no JSX**. It is a pure/near-pure TypeScript domain module: state machines, data transformations, and timer math. All host capabilities — session identity (`bookId`/`buildId`), transport (`api/client`), i18n, navigation, phase/error management — arrive through the injected `ProgressRowContext` and `ProgressEventSink` contracts. The package never imports host stores, the API client, i18n, or any `@animastor/*` package.

## Install

```sh
npm install @animastor/web-generator
```

No peer dependencies required — the package is pure TypeScript with zero runtime dependencies.

## Usage

```ts
import {
  computeProgressRows,
  createProgressTrackingState,
  createGenerationTimer,
  routeProgressEvent,
  type ProgressRowContext,
  type ProgressEventSink,
} from '@animastor/web-generator';

// Host owns the state objects
const progressTracking = createProgressTrackingState();
const generationTimer = createGenerationTimer();

// Build the progress panel via the domain function
const ctx: ProgressRowContext = {
  tracking: progressTracking,
  timer: generationTimer,
  now: Date.now(),
  vbookStage: 'IDLE',
  isRunning: false,
  vbookStageLabel: (stepType, sceneIndex) => /* i18n lookup */,
  setRegenerating: (v) => { /* host signal write */ },
  onGenerationFinalized: () => { /* stop stream, apply results */ },
  onRunningIdle: () => { /* clear nav-icon status */ },
};

const panelState = computeProgressRows(ctx, serverPanel, vbookProgress, labels);
```

## Public API

| Export | Kind | Purpose |
|---|---|---|
| `applyAnalysisEvent` | function | Pure per-task transition for parallel AI analysis |
| `applyAnalysisHeartbeat` | function | Forward-only wave counters (parallel mode) |
| `analysisOverallPercent` | function | Aggregate health flag for the overall row |
| `createInitialAnalysisProgress` | function | Fresh empty phase state (reset) |
| `isAnalysisTaskId` | function | Type guard for task IDs |
| `vbookProgressFromEvent` | function | Map SSE `vbook` event to VBookProgress |
| `applyAgentStatus` | function | Merge `/agent-status` poll into progress |
| `createIdleVBookProgress` | function | Idle state factory |
| `createAnalyzingVBookProgress` | function | ANALYZING state factory |
| `computeProgressRows` | function | Build progress panel from server rows + VBook |
| `createProgressTrackingState` | function | Fresh explicit tracking state |
| `resetProgressTracking` | function | Clear in-flight tracking (Settings clear cache) |
| `hasAnyProgress` | function | Any in-flight work ever recorded? |
| `routeProgressEvent` | function | Parse + dispatch SSE progress-stream payload |
| `createGenerationTimer` | function | Fresh wall-clock timer |
| `startGenerationTimer` | function | Anchor the session start |
| `stopGenerationTimer` | function | Freeze final elapsed |
| `elapsedSeconds` | function | Live elapsed while running; frozen final once stopped |
| `formatTimerText` | function | `hh:mm:ss` formatter |
| Types | types | `AnalysisProgress`, `AnalysisStatus`, `AnalysisTaskId`, `AnalysisTaskRow`, `VBookProgress`, `VBookStage`, `AgentStatusLike`, `ProgressTrackingState`, `GenerationTimerState`, `ProgressRowContext`, `ProgressEventSink`, `ProgressPanelState`, `TaskRow`, `TaskLabels`, `ProgressPanelResponse`, `ProgressTask`, `ProgressEvent` |

## Package boundary

- The package imports **nothing** at runtime — zero `dependencies` and zero `peerDependencies`.
- Host stores, `api/client`, i18n, router, icons, signals, and `@animastor/*` packages are **forbidden** inside the package (enforced by architecture guard tests).
- `@animastor/web-generator → host` = forbidden; `host → @animastor/web-generator` = allowed through the public entry point only.
- Wire types (`ProgressEvent`, `ProgressPanelResponse`, `ProgressTask`) are vendored locally (`src/models.ts`) following the `@animastor/web-player` `models.ts` precedent.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run test        # vitest (domain unit tests)
npm run build       # tsup → dist/ (ESM + d.ts + sourcemaps)
```

## License

MIT
