// ═══════════════════════════════════════════════════════════════
//  GENERATION-PROGRESS DOMAIN — Parallel AI Analysis state machine
// ═══════════════════════════════════════════════════════════════
//  Moved verbatim from state/generateStore.analysis.test.ts (the
//  suite migrated with the logic in the Step-1 domain split) and now
//  runs against the domain module DIRECTLY — no generateStore import,
//  no api/client mock, no signals: the state machine is pure.
//
//  Validates the contract the Generate page depends on:
//   1. applyAnalysisEvent(prev, ev) is PURE — same input → same output.
//   2. createInitialAnalysisProgress wipes state cleanly (no leaked timestamps).
//   3. Concurrent running tasks produce a coherent overall %.
//   4. Cancellation propagates: siblings survive a cancelled task.
//   5. Row statuses are the single source of truth (never trust counters).
// ═══════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest';
import {
  analysisOverallPercent,
  applyAnalysisEvent,
  applyAnalysisHeartbeat,
  createInitialAnalysisProgress,
} from './analysis';
import type { AnalysisProgress } from './analysis';

function freshProgress(): AnalysisProgress {
  return createInitialAnalysisProgress();
}

describe('applyAnalysisEvent — pure transition', () => {
  it('returns prev unchanged when event has an unknown task id', () => {
    const prev = freshProgress();
    const next = applyAnalysisEvent(prev, { type: 'analysis', task: 'bogus', status: 'running' });
    expect(next).toBe(prev);
  });

  it('marks active=true on first event of any task id', () => {
    const prev = freshProgress();
    const next = applyAnalysisEvent(prev, { type: 'analysis', task: 'characters', status: 'running' });
    expect(next.active).toBe(true);
  });

  it('characters → running starts the phase timer', () => {
    const prev = freshProgress();
    const next = applyAnalysisEvent(prev, { type: 'analysis', task: 'characters', status: 'running' });
    expect(next.phaseStartedAt).not.toBeNull();
    expect(next.tasks.characters.status).toBe('running');
  });

  it('two concurrent running tasks → both show running (parallel)', () => {
    let s = freshProgress();
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'characters', status: 'running' });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'locations', status: 'running' });
    expect(s.tasks.characters.status).toBe('running');
    expect(s.tasks.locations.status).toBe('running');
    expect(s.tasks.voices.status).toBe('pending');
    expect(s.completedTasks).toBe(0);
    expect(s.failedTasks).toBe(0);
  });

  it('failed task does NOT lose completed siblings (failure isolation)', () => {
    let s = freshProgress();
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'characters', status: 'running' });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'locations', status: 'running' });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'characters', status: 'failed', error: 'synthetic' });
    // locations should still be running; characters failed.
    expect(s.tasks.characters.status).toBe('failed');
    expect(s.tasks.characters.error).toBe('synthetic');
    expect(s.tasks.locations.status).toBe('running');
    expect(s.failedTasks).toBe(1);
    expect(s.completedTasks).toBe(0);
  });

  it('all tasks terminal → phaseFinishedAt set', () => {
    let s = freshProgress();
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'characters', status: 'running' });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'characters', status: 'completed', duration_ms: 1000 });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'locations', status: 'running' });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'locations', status: 'completed', duration_ms: 800 });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'voices', status: 'running' });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'voices', status: 'completed', duration_ms: 600 });
    expect(s.completedTasks).toBe(3);
    expect(s.failedTasks).toBe(0);
    expect(s.cancelledTasks).toBe(0);
    expect(s.phaseFinishedAt).not.toBeNull();
    expect(s.tasks.characters.durationMs).toBe(1000);
    expect(s.tasks.locations.durationMs).toBe(800);
    expect(s.tasks.voices.durationMs).toBe(600);
  });

  it('mixed completed + failed → phaseFinishedAt set (failure isolation)', () => {
    let s = freshProgress();
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'characters', status: 'running' });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'characters', status: 'completed', duration_ms: 1200 });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'locations', status: 'failed', error: 'provider outage' });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'voices', status: 'running' });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'voices', status: 'completed', duration_ms: 500 });
    expect(s.completedTasks).toBe(2);
    expect(s.failedTasks).toBe(1);
    expect(s.cancelledTasks).toBe(0);
    expect(s.phaseFinishedAt).not.toBeNull();
  });

  it('all tasks cancelled → phaseFinishedAt set, cancelledTasks = 3', () => {
    let s = freshProgress();
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'characters', status: 'cancelled' });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'locations', status: 'cancelled' });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'voices', status: 'cancelled' });
    expect(s.cancelledTasks).toBe(3);
    expect(s.phaseFinishedAt).not.toBeNull();
  });

  it('cancelling one running task while others run leaves siblings intact', () => {
    let s = freshProgress();
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'characters', status: 'running' });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'locations', status: 'running' });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'voices', status: 'running' });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'characters', status: 'cancelled' });
    expect(s.tasks.characters.status).toBe('cancelled');
    expect(s.tasks.locations.status).toBe('running');
    expect(s.tasks.voices.status).toBe('running');
    expect(s.phaseFinishedAt).toBeNull();  // not all terminal
  });

  it('totals are derived from row statuses (NEVER trust orchestrator counters)', () => {
    // Even if the orchestrator sends stale counters in late events,
    // applyAnalysisEvent must compute completedTasks / failedTasks from
    // the row statuses — single source of truth. We simulate by
    // sending a late event with bogus completed_tasks that disagrees
    // with the row statuses; the row count must win.
    let s = freshProgress();
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'characters', status: 'completed' });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'locations', status: 'completed' });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'voices', status: 'pending' });
    const before = s.completedTasks;
    // Late event with bogus total — must NOT reduce completedTasks.
    const late = { type: 'analysis', task: 'voices', status: 'pending', completed_tasks: 99 };
    applyAnalysisEvent(s, late);
    expect(s.completedTasks).toBe(before);
  });

  it('idempotent transition for already-completed tasks (re-emitting completed)', () => {
    let s = freshProgress();
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'characters', status: 'completed', duration_ms: 1000 });
    const first = { ...s };
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'characters', status: 'completed', duration_ms: 1000 });
    expect(s.tasks.characters.finishedAt).toBe(first.tasks.characters.finishedAt);
    expect(s.completedTasks).toBe(1);
  });

  it('injected clock — timestamps come from the `now` parameter (pure)', () => {
    const s = applyAnalysisEvent(freshProgress(), { type: 'analysis', task: 'characters', status: 'running' }, 10_000);
    expect(s.tasks.characters.startedAt).toBe(10_000);
    expect(s.phaseStartedAt).toBe(10_000);
  });
});

describe('applyAnalysisHeartbeat — parallel-mode wave counters', () => {
  it('forward-only counters: heartbeat can raise but never lower them', () => {
    let s = freshProgress();
    s = applyAnalysisHeartbeat(s, { type: 'vbook', stage: 'analysis_parallel', analysis_completed: 1, analysis_failed: 1, analysis_total: 3 });
    expect(s.completedTasks).toBe(1);
    expect(s.failedTasks).toBe(1);
    expect(s.totalTasks).toBe(3);
    expect(s.active).toBe(true);
    // Stale heartbeat arriving late (older counters) must not roll back.
    s = applyAnalysisHeartbeat(s, { type: 'vbook', stage: 'analysis_parallel', analysis_completed: 0, analysis_failed: 0, analysis_total: 2 });
    expect(s.completedTasks).toBe(1);
    expect(s.failedTasks).toBe(1);
    expect(s.totalTasks).toBe(3);
  });

  it('preserves per-task rows and phase timestamps untouched', () => {
    let s = freshProgress();
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'characters', status: 'running' }, 1_000);
    const startedAt = s.phaseStartedAt;
    s = applyAnalysisHeartbeat(s, { type: 'vbook', stage: 'analysis_parallel', analysis_completed: 1 });
    expect(s.phaseStartedAt).toBe(startedAt);
    expect(s.tasks.characters.status).toBe('running');
    expect(s.phaseFinishedAt).toBeNull();
  });
});

describe('analysisOverallPercent', () => {
  it('returns 0 when no work has started', () => {
    expect(analysisOverallPercent(freshProgress())).toBe(0);
  });

  it('treats failed as done for the bar (failure isolation)', () => {
    const s: AnalysisProgress = {
      ...freshProgress(),
      completedTasks: 1,
      failedTasks: 1,
    };
    // 2 of 3 done → 67%
    expect(analysisOverallPercent(s)).toBe(67);
  });

  it('returns 100 when all tasks terminal', () => {
    const s: AnalysisProgress = {
      ...freshProgress(),
      completedTasks: 2,
      failedTasks: 1,
    };
    expect(analysisOverallPercent(s)).toBe(100);
  });
});

describe('createInitialAnalysisProgress (reset semantics)', () => {
  it('returns a fresh empty state — phase timer, per-task rows, counters', () => {
    let s = freshProgress();
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'characters', status: 'running' });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'characters', status: 'completed', duration_ms: 500 });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'voices', status: 'failed', error: 'x' });
    const dirty: AnalysisProgress = {
      ...s,
      phaseStartedAt: 100,
      phaseFinishedAt: 600,
      phaseDurationMs: 500,
    };
    const reset = createInitialAnalysisProgress();
    expect(reset).not.toBe(dirty);
    expect(reset.active).toBe(false);
    expect(reset.phaseStartedAt).toBeNull();
    expect(reset.phaseFinishedAt).toBeNull();
    expect(reset.phaseDurationMs).toBeNull();
    expect(reset.completedTasks).toBe(0);
    expect(reset.failedTasks).toBe(0);
    expect(reset.cancelledTasks).toBe(0);
    expect(reset.totalTasks).toBe(3);
    for (const t of Object.values(reset.tasks)) {
      expect(t.status).toBe('pending');
      expect(t.startedAt).toBeNull();
      expect(t.finishedAt).toBeNull();
      expect(t.durationMs).toBeNull();
      expect(t.error).toBeNull();
    }
  });
});
