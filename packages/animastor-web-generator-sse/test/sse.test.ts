// ═══════════════════════════════════════════════════════════════
//  @animastor/web-generator-sse — unit tests
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { runSseStream, handleProgressEvent } from '../src/index';
import type { SseStreamPort, SseEvent } from '../src/index';
import type { ProgressTrackingState, ProgressEventSink } from '@animastor/web-generator';
import type { AnalysisProgress } from '@animastor/web-generator';

// ── Helpers ─────────────────────────────────────────────────

function defaultAnalysisProgress(): AnalysisProgress {
  return {
    totalTasks: 3,
    completedTasks: 0,
    failedTasks: 0,
    cancelledTasks: 0,
    phaseStartedAt: null,
    phaseFinishedAt: null,
    phaseDurationMs: null,
    tasks: {
      characters: { id: 'characters', status: 'pending', startedAt: null, finishedAt: null, durationMs: null, error: null },
      locations:  { id: 'locations', status: 'pending', startedAt: null, finishedAt: null, durationMs: null, error: null },
      voices:     { id: 'voices', status: 'pending', startedAt: null, finishedAt: null, durationMs: null, error: null },
    },
    active: false,
  };
}

function mockSink(): ProgressEventSink & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getAnalysisProgress: () => defaultAnalysisProgress(),
    setAnalysisProgress: () => { calls.push('setAnalysisProgress'); },
    setVBookProgress: () => { calls.push('setVBookProgress'); },
  };
}

function mockTracking(): ProgressTrackingState {
  return {
    taskReadyFloor: new Map(),
    taskCompletedAt: new Map(),
    taskFrozenElapsed: new Map(),
    generationCompleted: false,
    newGenerationPending: false,
    importCompleteReceived: false,
  };
}

function finiteStream(events: SseEvent[]): AsyncIterable<SseEvent> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < events.length) {
            return { done: false, value: events[index++] };
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function errorStream(): AsyncIterable<SseEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() { throw new Error('stream error'); },
      };
    },
  };
}

// ── Tests: handleProgressEvent (pure routing) ───────────────

describe('handleProgressEvent', () => {
  it('routes a vbook event', () => {
    const sink = mockSink();
    const tracking = mockTracking();
    handleProgressEvent(sink, tracking, JSON.stringify({ type: 'vbook', stage: 'ANALYZING' }));
    expect(sink.calls).toContain('setVBookProgress');
  });

  it('routes an analysis event', () => {
    const sink = mockSink();
    const tracking = mockTracking();
    handleProgressEvent(sink, tracking, JSON.stringify({ type: 'analysis', task: 'characters', status: 'running' }));
    expect(sink.calls).toContain('setAnalysisProgress');
  });

  it('sets import_complete latch', () => {
    const sink = mockSink();
    const tracking = mockTracking();
    handleProgressEvent(sink, tracking, JSON.stringify({ type: 'import_complete' }));
    expect(tracking.importCompleteReceived).toBe(true);
  });

  it('silently drops malformed JSON', () => {
    const sink = mockSink();
    const tracking = mockTracking();
    handleProgressEvent(sink, tracking, 'not json');
    expect(sink.calls).toHaveLength(0);
  });
});

// ── Tests: runSseStream (reconnect + epoch) ─────────────────

describe('runSseStream', () => {
  it('reconnects on normal stream close and processes second stream', async () => {
    let connectCount = 0;
    const port: SseStreamPort = {
      start: () => {
        connectCount++;
        if (connectCount === 1) {
          return finiteStream([{ data: JSON.stringify({ type: 'vbook', stage: 'ANALYZING' }) }]);
        }
        return finiteStream([{ data: JSON.stringify({ type: 'vbook', stage: 'GENERATING' }) }]);
      },
      stop() {},
    };
    const sink = mockSink();
    const tracking = mockTracking();
    let epoch = 0;

    const done = runSseStream(port, () => epoch, sink, tracking, 'book-1', { initialDelayMs: 1 });

    // Wait for two connections then bump epoch to stop
    while (connectCount < 2) await new Promise((r) => setTimeout(r, 1));
    epoch = 1;
    await done;

    expect(connectCount).toBe(2);
    expect(sink.calls).toContain('setVBookProgress');
  });

  it('reconnects after stream error', async () => {
    let connectCount = 0;
    const port: SseStreamPort = {
      start: () => {
        connectCount++;
        if (connectCount === 1) return errorStream();
        return finiteStream([{ data: JSON.stringify({ type: 'vbook', stage: 'ANALYZING' }) }]);
      },
      stop() {},
    };
    const sink = mockSink();
    const tracking = mockTracking();
    let epoch = 0;

    const done = runSseStream(port, () => epoch, sink, tracking, 'book-1', { initialDelayMs: 1 });

    while (connectCount < 2) await new Promise((r) => setTimeout(r, 1));
    epoch = 1;
    await done;

    expect(connectCount).toBe(2);
    expect(sink.calls).toContain('setVBookProgress');
  });

  it('exits when epoch changes mid-stream', async () => {
    let processed = 0;
    const port: SseStreamPort = {
      start: () => ({
        [Symbol.asyncIterator]() {
          let index = 0;
          const events: SseEvent[] = [
            { data: JSON.stringify({ type: 'vbook', stage: 'ANALYZING' }) },
            { data: JSON.stringify({ type: 'vbook', stage: 'GENERATING' }) },
          ];
          return {
            async next() {
              if (index < events.length) {
                processed++;
                return { done: false, value: events[index++] };
              }
              return { done: true, value: undefined };
            },
          };
        },
      }),
      stop() {},
    };
    const sink = mockSink();
    const tracking = mockTracking();
    let epoch = 0;

    const done = runSseStream(port, () => epoch, sink, tracking, 'book-1');

    await new Promise((r) => setTimeout(r, 10));
    epoch = 1;
    await done;

    expect(processed).toBeLessThanOrEqual(2);
  });

  it('does not reconnect after epoch bump during reconnect delay', async () => {
    let connectCount = 0;
    const port: SseStreamPort = {
      start: () => { connectCount++; return finiteStream([]); },
      stop() {},
    };
    const sink = mockSink();
    const tracking = mockTracking();
    let epoch = 0;

    const done = runSseStream(port, () => epoch, sink, tracking, 'book-1', { initialDelayMs: 100 });

    await new Promise((r) => setTimeout(r, 10));
    epoch = 1;
    await done;

    expect(connectCount).toBe(1);
  });

  it('uses exponential backoff on reconnect', async () => {
    let connectCount = 0;
    const port: SseStreamPort = {
      start: () => {
        connectCount++;
        if (connectCount <= 3) return errorStream();
        return finiteStream([{ data: JSON.stringify({ type: 'vbook', stage: 'ANALYZING' }) }]);
      },
      stop() {},
    };
    const sink = mockSink();
    const tracking = mockTracking();
    let epoch = 0;

    const done = runSseStream(port, () => epoch, sink, tracking, 'book-1', { initialDelayMs: 1 });

    while (connectCount < 4) await new Promise((r) => setTimeout(r, 1));
    epoch = 1;
    await done;

    expect(connectCount).toBe(4);
    expect(sink.calls).toContain('setVBookProgress');
  });

  it('skips events with empty data', async () => {
    let connectCount = 0;
    const port: SseStreamPort = {
      start: () => {
        connectCount++;
        if (connectCount === 1) {
          return finiteStream([
            { data: '' },
            { data: JSON.stringify({ type: 'vbook', stage: 'ANALYZING' }) },
          ]);
        }
        return finiteStream([]);
      },
      stop() {},
    };
    const sink = mockSink();
    const tracking = mockTracking();
    let epoch = 0;

    const done = runSseStream(port, () => epoch, sink, tracking, 'book-1', { initialDelayMs: 1 });
    while (connectCount < 2) await new Promise((r) => setTimeout(r, 1));
    epoch = 1;
    await done;

    expect(sink.calls.filter((c) => c === 'setVBookProgress')).toHaveLength(1);
  });
});
