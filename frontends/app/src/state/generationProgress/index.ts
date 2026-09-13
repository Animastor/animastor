// ═══════════════════════════════════════════════════════════════
//  GENERATION-PROGRESS — domain entry point
// ═══════════════════════════════════════════════════════════════
//  Step-1 domain slice of the web-generator extraction
//  (docs/architecture/web-generator-extraction-audit.md §4.3.1):
//  the analysis/progress pure logic is grouped under one internal
//  module contour, ready to be cut physically into a package LATER.
//  NO new package is created at this stage — this is the in-repo
//  preparation: generateStore delegates its progress computation
//  here and keeps only host ownership (identity, phase, auth stash,
//  playback events, transport).
//
//  Boundary rules (pinned by architecture/generation-progress-contour.guard.test.ts):
//   - imports allowed: api/models types only (wire contract, vendored
//     at package-cut time — precedent: web-player models.ts)
//   - NO signals, NO api/client, NO app/* (router/i18n/desktop/icons),
//     NO host state stores, NO pages, NO @animastor/* — the slice stays
//     host-free and package-portable.
//   - all mutable state arrives as explicit state objects
//     (ProgressTrackingState / GenerationTimerState) owned by the host.
// ═══════════════════════════════════════════════════════════════

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

export {
  applyAgentStatus,
  createAnalyzingVBookProgress,
  createIdleVBookProgress,
  vbookProgressFromEvent,
} from './vbookProgress';
export type { AgentStatusLike, VBookProgress, VBookStage } from './vbookProgress';

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

export {
  createGenerationTimer,
  elapsedSeconds,
  formatTimerText,
  startGenerationTimer,
  stopGenerationTimer,
} from './timer';
export type { GenerationTimerState } from './timer';

export { routeProgressEvent } from './sseRouting';
export type { ProgressEventSink } from './sseRouting';
