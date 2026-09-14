// ═══════════════════════════════════════════════════════════════
//  GENERATE STORE — host-side progress wiring tests
// ═══════════════════════════════════════════════════════════════
//  Step-1 domain split: the pure state-machine suites (applyAnalysisEvent,
//  analysisOverallPercent, reset semantics, SSE routing, timer math,
//  progress rows) moved to state/generationProgress/*.test.ts and run
//  against the domain module directly. THIS file keeps the HOST-side
//  integration contract only:
//   1. the analysis/progress domain module must not appear to regress
//      the store wiring — analysis events arriving through the store's
//      SSE seam still update vbookAnalysisProgress;
//   2. analysis-mode + parallelism roundtrip via /book/:id/layer-config
//      (a host action — stays here).
// ═══════════════════════════════════════════════════════════════

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({
  API_BASE: 'http://test',
  getJson: vi.fn(async () => ({
    audio_enabled: true,
    image_enabled: true,
    video_enabled: true,
    vbook_enabled: true,
    chunk_size: 3,
    analysis_mode: 'parallel',
    analysis_parallelism: 4,
  })),
  putJson: vi.fn(async () => ({})),
  postJson: vi.fn(async () => ({})),
  postJsonLong: vi.fn(async () => ({})),
  deleteJson: vi.fn(async () => ({})),
  getBlob: vi.fn(async () => new Blob([])),
  retryWithBackoff: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  sse: vi.fn(),
}));

import {
  analysisMode,
  analysisOverallPercent,
  analysisParallelism,
  applyAnalysisEvent,
  bookId,
  cancelGeneration,
  errorMessage,
  generationStatus,
  isRegenerating,
  loadLayerConfig,
  phase,
  resetAnalysisProgress,
  vbookAnalysisProgress,
} from './generateStore';
import { createProgressTrackingState, routeProgressEvent } from '@animastor/web-generator';
import type { AnalysisProgress } from './generateStore';

// Pin bookId so loadLayerConfig has a current book.
beforeEach(() => {
  bookId.value = 'test-book';
});

describe('loadLayerConfig — analysis_mode roundtrip', () => {
  it('parses analysis_mode=parallel and analysis_parallelism=4 from the response', async () => {
    const { getJson } = await import('../api/client');
    (getJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      audio_enabled: true,
      image_enabled: true,
      video_enabled: true,
      vbook_enabled: true,
      chunk_size: 3,
      analysis_mode: 'parallel',
      analysis_parallelism: 4,
    });
    await loadLayerConfig();
    expect(analysisMode.value).toBe('parallel');
    expect(analysisParallelism.value).toBe(4);
  });

  it('defaults analysis_mode to sequential when missing or unknown', async () => {
    const { getJson } = await import('../api/client');
    (getJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      audio_enabled: true,
      image_enabled: true,
      video_enabled: true,
      vbook_enabled: true,
      chunk_size: 3,
      // analysis_mode deliberately omitted
    });
    await loadLayerConfig();
    expect(analysisMode.value).toBe('sequential');
  });

  it('clamps analysis_parallelism to [1, 8] from server-supplied value', async () => {
    const { getJson } = await import('../api/client');
    (getJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      audio_enabled: true,
      image_enabled: true,
      video_enabled: true,
      vbook_enabled: true,
      chunk_size: 3,
      analysis_mode: 'parallel',
      analysis_parallelism: 999,
    });
    await loadLayerConfig();
    expect(analysisParallelism.value).toBe(8);
  });
});

describe('host SSE seam — analysis events through the domain router', () => {
  it('events routed through routeProgressEvent update the store signal end-to-end', async () => {
    resetAnalysisProgress();
    // The store's private sink binds getAnalysis/setAnalysis to the signal;
    // the wiring is exercised through the exported domain router with a
    // minimal sink mirroring the store adapter (the full stream machinery
    // is transport and stays host-side).
    const sink = {
      getAnalysisProgress: () => vbookAnalysisProgress.value,
      setAnalysisProgress: (p: AnalysisProgress) => { vbookAnalysisProgress.value = p; },
      setVBookProgress: () => { /* not exercised here */ },
    };
    const send = (ev: object) => routeProgressEvent(sink, createProgressTrackingState(), JSON.stringify(ev));
    send({ type: 'analysis', task: 'characters', status: 'running' });
    send({ type: 'analysis', task: 'locations', status: 'running' });
    send({ type: 'analysis', task: 'characters', status: 'completed', duration_ms: 1200 });
    send({ type: 'analysis', task: 'locations', status: 'completed', duration_ms: 800 });
    send({ type: 'analysis', task: 'voices', status: 'running' });
    send({ type: 'analysis', task: 'voices', status: 'completed', duration_ms: 500 });
    expect(vbookAnalysisProgress.value.completedTasks).toBe(3);
    expect(vbookAnalysisProgress.value.failedTasks).toBe(0);
    expect(vbookAnalysisProgress.value.phaseFinishedAt).not.toBeNull();
    expect(analysisOverallPercent(vbookAnalysisProgress.value)).toBe(100);
  });

  it('resetAnalysisProgress wipes the signal (host wrapper over the domain factory)', () => {
    resetAnalysisProgress();
    let s: AnalysisProgress = vbookAnalysisProgress.value;
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'characters', status: 'running' });
    s = applyAnalysisEvent(s, { type: 'analysis', task: 'characters', status: 'completed', duration_ms: 500 });
    vbookAnalysisProgress.value = s;
    expect(vbookAnalysisProgress.value.completedTasks).toBe(1);
    resetAnalysisProgress();
    expect(vbookAnalysisProgress.value.completedTasks).toBe(0);
    expect(vbookAnalysisProgress.value.active).toBe(false);
    expect(vbookAnalysisProgress.value.phaseStartedAt).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════
//  CANCEL — observable state ordering (Step 14A contract, audit §24)
// ═════════════════════════════════════════════════════════════
//  The pre-Step-14 cancelGeneration performed its state writes in exactly
//  two phases separated by `await postJson(...)`:
//    pre-await : status→IDLE, tracking reset, analysis freeze (teardown)
//    post-await: isRegenerating=false, phase=IDLE, errorMessage=null (settle)
//  `await` yields to the event loop — anything a consumer (signal effect,
//  poll tick, SSE event) runs while the request is in flight MUST observe
//  the pre-cancel state. This suite freezes that split: a future refactor
//  that moves the settle writes BEFORE the await (or teardown AFTER it)
//  fails here.
describe('cancelGeneration — observable state ordering (Step 14A)', () => {
  const preCancel = {
    generationStatus: 'RUNNING' as const,
    isRegenerating: true,
    phase: 'GENERATING' as const,
    errorMessage: 'stale error' as string | null,
  };

  beforeEach(() => {
    bookId.value = 'test-book';
    generationStatus.value = preCancel.generationStatus;
    isRegenerating.value = preCancel.isRegenerating;
    phase.value = preCancel.phase;
    errorMessage.value = preCancel.errorMessage;
  });

  afterEach(() => {
    generationStatus.value = 'IDLE';
    isRegenerating.value = false;
    phase.value = 'IDLE';
    errorMessage.value = null;
    resetAnalysisProgress();
  });

  function snapshot() {
    return {
      generationStatus: generationStatus.value,
      isRegenerating: isRegenerating.value,
      phase: phase.value,
      errorMessage: errorMessage.value,
    };
  }

  it('does NOT settle phase/errorMessage/isRegenerating before the cancel request resolves', async () => {
    const { postJson } = await import('../api/client');
    let resolveRequest!: () => void;
    const requestPromise = new Promise<void>((res) => { resolveRequest = res; });
    const observedAtRequestStart = vi.fn(() => snapshot());
    (postJson as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      // Called synchronously inside cancelGeneration — BEFORE any await.
      observedAtRequestStart();
      return requestPromise;
    });

    const done = cancelGeneration();
    // The request is in flight: cancelGeneration is suspended at its await.
    await Promise.resolve();
    const whileInFlight = snapshot();

    // Pre-await teardown legs ran (old contract: they were before postJson)…
    expect(observedAtRequestStart).toHaveBeenCalledTimes(1);
    expect(observedAtRequestStart.mock.results[0].value).toEqual({
      generationStatus: 'IDLE', // teardown leg ran BEFORE the request
      isRegenerating: true,     // settle leg did NOT run early
      phase: 'GENERATING',      // settle leg did NOT run early
      errorMessage: 'stale error',
    });
    // …and while the request is in flight the settle writes have still NOT
    // happened — observers must see the pre-cancel state.
    expect(whileInFlight).toEqual({
      generationStatus: 'IDLE',
      isRegenerating: true,
      phase: 'GENERATING',
      errorMessage: 'stale error',
    });

    resolveRequest();
    await done;
    // After the request resolves the settle legs produce the OLD end state.
    expect(snapshot()).toEqual({
      generationStatus: 'IDLE',
      isRegenerating: false,
      phase: 'IDLE',
      errorMessage: null,
    });
  });

  it('settles to the old end state even when the cancel request FAILS (error tolerated)', async () => {
    const { postJson } = await import('../api/client');
    (postJson as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await cancelGeneration();
      expect(snapshot()).toEqual({
        generationStatus: 'IDLE',
        isRegenerating: false,
        phase: 'IDLE',
        errorMessage: null,
      });
      expect(warn).toHaveBeenCalledWith(
        'cancelGeneration: backend call failed:', 'network down',
      );
    } finally {
      warn.mockRestore();
    }
  });
});
