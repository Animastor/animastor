// ═══════════════════════════════════════════════════════════════
//  GENERATION-PROGRESS DOMAIN — Parallel AI Analysis state machine
// ═══════════════════════════════════════════════════════════════
//  Step-1 domain slice of the web-generator extraction
//  (docs/architecture/web-generator-extraction-audit.md §4.3.1).
//  Pure logic, zero host reach: no signals, no api/client, no app/*,
//  no identity (bookId/buildId stay host-owned in generateStore).
//  The only import is the wire type ProgressEvent from models —
//  vendored locally following the web-player models.ts precedent.
//
//  Wire contract: the orchestrator emits { type:'analysis', task,
//  status, ... } events over the SSE channel (see backend
//  parallel-analysis-orchestrator.js). applyAnalysisEvent is the
//  transition function — same input produces the same output; the
//  SSE handler (state/generateStore.ts handleProgressEvent) wraps
//  it once the payload has been JSON-parsed (sseRouting.ts).
// ═══════════════════════════════════════════════════════════════

import type { ProgressEvent } from './models';

export type AnalysisStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AnalysisTaskId = 'characters' | 'locations' | 'voices';

export interface AnalysisTaskRow {
  id: AnalysisTaskId;
  status: AnalysisStatus;
  /** Epoch ms — set when status first transitions to 'running'. */
  startedAt: number | null;
  /** Epoch ms — set when status transitions to a terminal state. */
  finishedAt: number | null;
  /** Wall-clock ms the task spent in 'running' state. Authoritative value
   *  from the orchestrator (`task.duration_ms`) when finished. */
  durationMs: number | null;
  /** Set only when status === 'failed'. */
  error: string | null;
}

export interface AnalysisProgress {
  /** Total tasks the orchestrator has scheduled (3 today: characters, locations, voices). */
  totalTasks: number;
  /** Tasks that have transitioned to 'completed'. */
  completedTasks: number;
  /** Tasks that have transitioned to 'failed' (failure isolation — siblings still run). */
  failedTasks: number;
  /** Tasks that have transitioned to 'cancelled'. */
  cancelledTasks: number;
  /** Epoch ms — when the analysis phase started (first task → running).
   *  Null until then. Used by the overall timer in the UI. */
  phaseStartedAt: number | null;
  /** Epoch ms — when the analysis phase finished (all tasks terminal).
   *  Null until then. Used to freeze the overall timer. */
  phaseFinishedAt: number | null;
  /** Total elapsed wall-clock ms for the analysis phase. Authoritative
   *  when phaseFinishedAt is set; live `now - phaseStartedAt`
   *  while running. */
  phaseDurationMs: number | null;
  /** Per-task rows, keyed by id. Inserted in PENDING on first sighting
   *  of an event for that task id; updated on each transition. */
  tasks: Record<AnalysisTaskId, AnalysisTaskRow>;
  /** Set when an event reports analysis_mode === 'parallel' (truth from
   *  backend). Sequential mode never populates this signal — callers
   *  fall back to the legacy single-row VBook UI. */
  active: boolean;
}

const ANALYSIS_TASK_IDS: readonly AnalysisTaskId[] = ['characters', 'locations', 'voices'];

export function isAnalysisTaskId(v: unknown): v is AnalysisTaskId {
  return typeof v === 'string' && (ANALYSIS_TASK_IDS as readonly string[]).includes(v);
}

const EMPTY_ANALYSIS_TASK: AnalysisTaskRow = {
  id: 'characters', status: 'pending', startedAt: null, finishedAt: null, durationMs: null, error: null,
};

function makeEmptyTaskRow(id: AnalysisTaskId): AnalysisTaskRow {
  return { ...EMPTY_ANALYSIS_TASK, id };
}

/** Fresh empty phase state (generateStore.resetAnalysisProgress writes this
 *  into the host signal; also the signal's initial value). Idempotent. */
export function createInitialAnalysisProgress(): AnalysisProgress {
  return {
    totalTasks: 3,
    completedTasks: 0,
    failedTasks: 0,
    cancelledTasks: 0,
    phaseStartedAt: null,
    phaseFinishedAt: null,
    phaseDurationMs: null,
    tasks: {
      characters: makeEmptyTaskRow('characters'),
      locations:  makeEmptyTaskRow('locations'),
      voices:     makeEmptyTaskRow('voices'),
    },
    active: false,
  };
}

function transition(prev: AnalysisTaskRow, ev: ProgressEvent, now: number): AnalysisTaskRow {
  const next: AnalysisTaskRow = { ...prev };
  if (typeof ev.status === 'string') {
    next.status = (['pending', 'running', 'completed', 'failed', 'cancelled'] as const)
      .includes(ev.status as AnalysisStatus) ? (ev.status as AnalysisStatus) : prev.status;
  }
  if (next.status === 'running' && prev.startedAt == null) {
    next.startedAt = now;
  }
  // A task transitioning out of 'running' gets a finishedAt stamp.
  // Also handle the edge case where a task was 'pending' and the orchestrator
  // reports it cancelled / failed directly (no 'running' ever fired) —
  // finishedAt is still recorded so the overall phaseFinishedAt detection works.
  const isTerminal = next.status === 'completed' || next.status === 'failed' || next.status === 'cancelled';
  if (isTerminal && next.finishedAt == null) {
    next.finishedAt = now;
  }
  if (typeof ev.duration_ms === 'number' && Number.isFinite(ev.duration_ms)) {
    next.durationMs = ev.duration_ms;
    if (next.startedAt != null) next.finishedAt = next.startedAt + ev.duration_ms;
  }
  if (typeof ev.error === 'string' && ev.error.length > 0 && next.status === 'failed') {
    next.error = ev.error;
  }
  return next;
}

/** Pure per-task transition (generateStore.applyAnalysisEvent, moved).
 *  `now` is injectable for tests; production callers use the default clock. */
export function applyAnalysisEvent(prev: AnalysisProgress, ev: ProgressEvent, now: number = Date.now()): AnalysisProgress {
  if (!isAnalysisTaskId(ev.task)) return prev;
  const id = ev.task;
  const prevRow = prev.tasks[id];
  const nextRow = transition(prevRow, ev, now);

  // Recompute totals from the per-row statuses — never trust the
  // orchestrator's counters blindly because a late event with a stale
  // counter could roll the numbers backwards. The single source of
  // truth is the row statuses.
  const tasks = { ...prev.tasks, [id]: nextRow };
  let completed = 0, failed = 0, cancelled = 0;
  let phaseStartedAt = prev.phaseStartedAt;
  let phaseFinishedAt = prev.phaseFinishedAt;
  for (const t of Object.values(tasks)) {
    if (t.status === 'completed') completed++;
    else if (t.status === 'failed') failed++;
    else if (t.status === 'cancelled') cancelled++;
  }
  if (phaseStartedAt == null && Object.values(tasks).some((t) => t.startedAt != null)) {
    phaseStartedAt = Math.min(...Object.values(tasks).map((t) => t.startedAt ?? Infinity));
    if (!Number.isFinite(phaseStartedAt)) phaseStartedAt = null;
  }
  const allTerminal = Object.values(tasks).every((t) =>
    t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled'
  );
  if (allTerminal && phaseFinishedAt == null) {
    // Degenerate case: all tasks cancelled/failed/completed without ever
    // entering 'running' (orchestrator reported terminal state directly).
    // In that case there is no phaseStartedAt to anchor against, but we
    // still set phaseFinishedAt so the UI's overall timer shows 00:00:00
    // and the 'All tasks terminal' detection fires.
    if (phaseStartedAt == null) {
      const earliestFinish = Math.min(
        ...Object.values(tasks).map((t) => t.finishedAt ?? Infinity)
      );
      phaseStartedAt = Number.isFinite(earliestFinish) ? earliestFinish : now;
    }
    phaseFinishedAt = now;
  }
  const phaseDurationMs = phaseStartedAt != null
    ? (phaseFinishedAt ?? now) - phaseStartedAt
    : null;

  return {
    ...prev,
    completedTasks: completed,
    failedTasks: failed,
    cancelledTasks: cancelled,
    phaseStartedAt,
    phaseFinishedAt,
    phaseDurationMs,
    tasks,
    active: true,
  };
}

/** Aggregate health flag for the overall row. */
export function analysisOverallPercent(p: AnalysisProgress): number {
  if (p.totalTasks === 0) return 0;
  const completed = p.completedTasks;
  const failed = p.failedTasks;
  // Failed tasks count as "done" for progress (the row stops moving) but
  // not as success — the UI surfaces the failure separately.
  return Math.round(((completed + failed) / p.totalTasks) * 100);
}

/** Parallel-mode heartbeat (SSE `vbook` event with stage 'analysis_parallel'):
 *  one event between waves carrying aggregate counters. Counters only move
 *  FORWARD (Math.max) so a stale heartbeat can never roll the rows back;
 *  per-task rows and phase timestamps are preserved. */
export function applyAnalysisHeartbeat(prev: AnalysisProgress, ev: ProgressEvent): AnalysisProgress {
  return {
    ...prev,
    totalTasks: Math.max(prev.totalTasks, ev.analysis_total ?? prev.totalTasks),
    completedTasks: Math.max(prev.completedTasks, ev.analysis_completed ?? prev.completedTasks),
    failedTasks: Math.max(prev.failedTasks, ev.analysis_failed ?? prev.failedTasks),
    active: true,
  };
}
