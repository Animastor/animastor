// ═══════════════════════════════════════════════════════════════
//  @animastor/web-generator — public API entry point
// ═══════════════════════════════════════════════════════════════
//  Generation-progress domain slice: analysis state machine, progress
//  panel rows, SSE event routing, and generation timer. Pure/near-pure
//  domain logic with zero host reach.
//
//  Boundary rules (pinned by architecture guard):
//   - This package must NOT import host stores, api/client, app/*
//     (router/i18n/desktop/icons), pages, @preact/signals, or any
//     @animastor/* package.
//   - All mutable state arrives as explicit state objects
//     (ProgressTrackingState / GenerationTimerState) owned by the host.
//   - Wire types (ProgressEvent, ProgressPanelResponse, ProgressTask)
//     are vendored locally (web-player models.ts precedent).
// ═══════════════════════════════════════════════════════════════

// ── Analysis state machine ──
export {
  applyAnalysisEvent,
  applyAnalysisHeartbeat,
  analysisOverallPercent,
  createInitialAnalysisProgress,
  isAnalysisTaskId,
} from './analysis';
export type {
  AnalysisProgress,
  AnalysisStatus,
  AnalysisTaskId,
  AnalysisTaskRow,
} from './analysis';

// ── VBook progress ──
export {
  applyAgentStatus,
  createAnalyzingVBookProgress,
  createIdleVBookProgress,
  vbookProgressFromEvent,
} from './vbookProgress';
export type { AgentStatusLike, VBookProgress, VBookStage } from './vbookProgress';

// ── Progress panel rows ──
export {
  computeProgressRows,
  createProgressTrackingState,
  hasAnyProgress,
  resetProgressTracking,
} from './progressRows';
export type {
  ProgressRowContext,
  ProgressPanelState,
  ProgressTrackingState,
  TaskLabels,
  TaskRow,
} from './progressRows';

// ── Timer ──
export {
  createGenerationTimer,
  elapsedSeconds,
  formatTimerText,
  startGenerationTimer,
  stopGenerationTimer,
} from './timer';
export type { GenerationTimerState } from './timer';

// ── SSE routing ──
export { routeProgressEvent } from './sseRouting';
export type { ProgressEventSink } from './sseRouting';

// ── Vendored wire types (for host adapter compatibility checks) ──
export type { ProgressEvent, ProgressPanelResponse, ProgressTask } from './models';
