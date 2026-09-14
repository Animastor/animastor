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

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  loadLayerConfig,
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
