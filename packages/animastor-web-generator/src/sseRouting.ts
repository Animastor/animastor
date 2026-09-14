// ═══════════════════════════════════════════════════════════════
//  GENERATION-PROGRESS DOMAIN — SSE progress event routing
// ═══════════════════════════════════════════════════════════════
//  Step-1 domain slice of the web-generator extraction
//  (docs/architecture/web-generator-extraction-audit.md §4.3.1).
//  Port of generateStore.handleProgressEvent: JSON-parse + dispatch of
//  the /book/:id/progress-stream channel. Routing decisions and pure
//  payload mappings live HERE; the host-owned signals are written
//  through an explicit ProgressEventSink. The import_complete latch is
//  the domain's ProgressTrackingState field (set here, read by the
//  host's VBook poll loop, reset by markImportIncomplete).
// ═══════════════════════════════════════════════════════════════

import type { ProgressEvent } from './models';
import type { AnalysisProgress } from './analysis';
import { applyAnalysisEvent, applyAnalysisHeartbeat } from './analysis';
import type { VBookProgress } from './vbookProgress';
import { vbookProgressFromEvent } from './vbookProgress';
import type { ProgressTrackingState } from './progressRows';

/** Host bridge: the signals the router writes. generateStore implements
 *  this with its own vbookAnalysisProgress / vbookProgress signals. */
export interface ProgressEventSink {
  /** Current parallel-analysis progress (host signal read). */
  getAnalysisProgress(): AnalysisProgress;
  setAnalysisProgress(p: AnalysisProgress): void;
  setVBookProgress(p: VBookProgress): void;
}

/** Route one SSE progress-stream payload (previously handleProgressEvent).
 *  Malformed JSON is dropped silently, exactly as before. */
export function routeProgressEvent(
  sink: ProgressEventSink,
  tracking: ProgressTrackingState,
  data: string
): void {
  let ev: ProgressEvent;
  try { ev = JSON.parse(data); } catch { return; }
  if (ev.type === 'vbook') {
    // Parallel-mode heartbeat (Milestone #2): orchestrator publishes one
    // { stage: 'analysis_parallel', analysis_completed, ... } event between
    // waves. We forward it to the analysis progress so the per-task rows
    // can render an "Analysis: N/M" progress line. The existing vbook
    // signal is unaffected — sequential mode never emits this heartbeat.
    if (ev.stage === 'analysis_parallel') {
      sink.setAnalysisProgress(applyAnalysisHeartbeat(sink.getAnalysisProgress(), ev));
    }
    sink.setVBookProgress(vbookProgressFromEvent(ev));
  } else if (ev.type === 'analysis') {
    // Parallel AI Analysis per-task event (Milestone #2). Add new branch
    // BEFORE the existing vbook/generation_complete/import_complete switch
    // so unknown task ids don't fall through silently.
    sink.setAnalysisProgress(applyAnalysisEvent(sink.getAnalysisProgress(), ev));
  } else if (ev.type === 'generation_complete') {
    // A completion event belongs to one generation scope — the progress-panel
    // poll remains authoritative and finalises only after all workers are done.
  } else if (ev.type === 'import_complete') {
    tracking.importCompleteReceived = true;
  }
}
