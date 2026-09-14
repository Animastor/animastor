// ═══════════════════════════════════════════════════════════════
//  GENERATION-PROGRESS DOMAIN — SSE event routing tests
// ═══════════════════════════════════════════════════════════════
//  routeProgressEvent: parse + dispatch. The sink records the writes
//  (host signals in production, a recorder here) — no transport, no
//  DOM, no store. import_complete sets the tracking-state latch the
//  host VBook poll loop consumes.
// ═══════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest';
import { routeProgressEvent } from '../src/sseRouting';
import type { ProgressEventSink } from '../src/sseRouting';
import { createInitialAnalysisProgress } from '../src/analysis';
import type { AnalysisProgress } from '../src/analysis';
import type { VBookProgress } from '../src/vbookProgress';
import { createProgressTrackingState } from '../src/progressRows';

function makeSink(): ProgressEventSink & {
  analysis: AnalysisProgress;
  vbook: VBookProgress | null;
  analysisWrites: number;
  vbookWrites: number;
} {
  const state = {
    analysis: createInitialAnalysisProgress(),
    vbook: null as VBookProgress | null,
    analysisWrites: 0,
    vbookWrites: 0,
  };
  return {
    ...state,
    getAnalysisProgress: () => state.analysis,
    setAnalysisProgress: (p) => { state.analysis = p; state.analysisWrites++; },
    setVBookProgress: (p) => { state.vbook = p; state.vbookWrites++; },
    get analysis() { return state.analysis; },
    get vbook() { return state.vbook; },
    get analysisWrites() { return state.analysisWrites; },
    get vbookWrites() { return state.vbookWrites; },
  };
}

describe('routeProgressEvent', () => {
  it('drops malformed JSON silently (no sink writes)', () => {
    const sink = makeSink();
    const tracking = createProgressTrackingState();
    routeProgressEvent(sink, tracking, '{not json');
    expect(sink.analysisWrites).toBe(0);
    expect(sink.vbookWrites).toBe(0);
    expect(tracking.importCompleteReceived).toBe(false);
  });

  it('type=analysis → routes through applyAnalysisEvent into the analysis sink', () => {
    const sink = makeSink();
    routeProgressEvent(sink, createProgressTrackingState(),
      JSON.stringify({ type: 'analysis', task: 'characters', status: 'running' }));
    expect(sink.analysis.tasks.characters.status).toBe('running');
    expect(sink.analysis.active).toBe(true);
    expect(sink.vbookWrites).toBe(0);
  });

  it('type=analysis with unknown task id → analysis state untouched (identity write-through)', () => {
    const sink = makeSink();
    const before = sink.analysis;
    routeProgressEvent(sink, createProgressTrackingState(),
      JSON.stringify({ type: 'analysis', task: 'bogus', status: 'running' }));
    // The transition returns `prev` unchanged — same reference, no state drift.
    expect(sink.analysis).toBe(before);
    expect(sink.analysis.tasks.characters.status).toBe('pending');
  });

  it('type=vbook heartbeat (stage=analysis_parallel) → counters into the analysis sink + vbook progress from the event', () => {
    const sink = makeSink();
    routeProgressEvent(sink, createProgressTrackingState(),
      JSON.stringify({ type: 'vbook', stage: 'analysis_parallel', analysis_completed: 2, analysis_failed: 0, analysis_total: 3 }));
    expect(sink.analysis.completedTasks).toBe(2);
    expect(sink.analysis.active).toBe(true);
    // The vbook branch still maps the event into VBookProgress.
    expect(sink.vbook?.stage).toBe('ANALYZING');
    expect(sink.vbook?.stepType).toBe('analysis_parallel');
  });

  it('type=vbook normal event → VBookProgress write only', () => {
    const sink = makeSink();
    routeProgressEvent(sink, createProgressTrackingState(),
      JSON.stringify({ type: 'vbook', stage: 'creating_units', window_total_scenes: 3, window_scene_index: 1 }));
    expect(sink.vbookWrites).toBe(1);
    expect(sink.vbook?.stage).toBe('CREATING_SCENES');
    expect(sink.vbook?.scenesInWindow).toBe(3);
    expect(sink.analysisWrites).toBe(0);
  });

  it('type=generation_complete → no-op (the panel poll is authoritative)', () => {
    const sink = makeSink();
    const tracking = createProgressTrackingState();
    routeProgressEvent(sink, tracking, JSON.stringify({ type: 'generation_complete' }));
    expect(sink.analysisWrites).toBe(0);
    expect(sink.vbookWrites).toBe(0);
    expect(tracking.importCompleteReceived).toBe(false);
  });

  it('type=import_complete → sets the tracking latch (consumed by the host poll loop)', () => {
    const sink = makeSink();
    const tracking = createProgressTrackingState();
    expect(tracking.importCompleteReceived).toBe(false);
    routeProgressEvent(sink, tracking, JSON.stringify({ type: 'import_complete' }));
    expect(tracking.importCompleteReceived).toBe(true);
    expect(sink.analysisWrites).toBe(0);
    expect(sink.vbookWrites).toBe(0);
  });

  it('full analysis lifecycle over the router → 3/3 completed, phase finished', () => {
    const sink = makeSink();
    const tracking = createProgressTrackingState();
    const send = (ev: object) => routeProgressEvent(sink, tracking, JSON.stringify(ev));
    send({ type: 'analysis', task: 'characters', status: 'running' });
    send({ type: 'analysis', task: 'locations', status: 'running' });
    send({ type: 'analysis', task: 'characters', status: 'completed', duration_ms: 1200 });
    send({ type: 'analysis', task: 'locations', status: 'completed', duration_ms: 800 });
    send({ type: 'analysis', task: 'voices', status: 'running' });
    send({ type: 'analysis', task: 'voices', status: 'completed', duration_ms: 500 });
    expect(sink.analysis.completedTasks).toBe(3);
    expect(sink.analysis.failedTasks).toBe(0);
    expect(sink.analysis.phaseFinishedAt).not.toBeNull();
  });
});
