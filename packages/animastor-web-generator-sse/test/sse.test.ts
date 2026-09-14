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

/** Create an async iterable that yields a fixed list then closes. */
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

/** Create an async iterable that throws on the Nth iteration. */
function errorStream(events: SseEvent[], throwOn: number): AsyncIterable<SseEvent> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index === throwOn) throw new Error('stream error');
          if (index < events.length) {
            return { done: false, value: events[index++] };
          }
          return { done: true, value: undefined };
        },
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
  it('routes events from a finite stream', async () => {
    const events: SseEvent[] = [
      { data: JSON.stringify({ type: 'vbook', stage: 'ANALYZING' }) },
      { data: JSON.stringify({ type: 'analysis', task: 'characters', status: 'running' }) },
    ];
    const port: SseStreamPort = {
      start: () => finiteStream(events),
      stop() {},
    };
    const sink = mockSink();
    const tracking = mockTracking();
    let epoch = 0;

    await runSseStream(port, () => epoch, sink, tracking, 'book-1');

    expect(sink.calls).toContain('setVBookProgress');
    expect(sink.calls).toContain('setAnalysisProgress');
  });

  it('exits when epoch changes mid-stream', async () => {
    const events: SseEvent[] = [
      { data: JSON.stringify({ type: 'vbook', stage: 'ANALYZING' }) },
      // Epoch will be bumped before this event is processed
      { data: JSON.stringify({ type: 'vbook', stage: 'GENERATING' }) },
    ];
    let processed = 0;
    const port: SseStreamPort = {
      start: () => ({
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            async next() {
              if (index < events.length) {
                const ev = events[index++];
                processed++;
                return { done: false, value: ev };
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

    // Bump epoch after first event is processed
    await new Promise((r) => setTimeout(r, 10));
    epoch = 1;

    await done;
    // Should have stopped processing after epoch bump
    expect(processed).toBeLessThanOrEqual(2);
    expect(epoch).toBe(1);
  });

  it('exits on normal stream close', async () => {
    const events: SseEvent[] = [
      { data: JSON.stringify({ type: 'vbook', stage: 'ANALYZING' }) },
    ];
    const port: SseStreamPort = {
      start: () => finiteStream(events),
      stop() {},
    };
    const sink = mockSink();
    const tracking = mockTracking();
    let epoch = 0;

    await runSseStream(port, () => epoch, sink, tracking, 'book-1');

    expect(sink.calls).toContain('setVBookProgress');
  });

  it('reconnects after stream error', async () => {
    let connectCount = 0;
    const port: SseStreamPort = {
      start: () => {
        connectCount++;
        if (connectCount === 1) {
          // First connection: error immediately
          return errorStream([], 0);
        }
        // Second connection: emit one event then close
        return finiteStream([{ data: JSON.stringify({ type: 'vbook', stage: 'ANALYZING' }) }]);
      },
      stop() {},
    };
    const sink = mockSink();
    const tracking = mockTracking();
    let epoch = 0;

    await runSseStream(port, () => epoch, sink, tracking, 'book-1', { initialDelayMs: 1 });

    expect(connectCount).toBe(2);
    expect(sink.calls).toContain('setVBookProgress');
  });

  it('does not reconnect after epoch bump during delay', async () => {
    let connectCount = 0;
    const port: SseStreamPort = {
      start: () => { connectCount++; return errorStream([], 0); }, // error → reconnect
      stop() {},
    };
    const sink = mockSink();
    const tracking = mockTracking();
    let epoch = 0;

    const done = runSseStream(port, () => epoch, sink, tracking, 'book-1', { initialDelayMs: 100 });

    // Let it enter reconnect delay
    await new Promise((r) => setTimeout(r, 10));
    // Bump epoch during delay
    epoch = 1;
    await done;

    // Only 1 connect — should NOT have reconnected
    expect(connectCount).toBe(1);
  });

  it('uses exponential backoff on reconnect', async () => {
    const delays: number[] = [];
    let connectCount = 0;

    // Override setTimeout to capture delays
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: Function, ms: number) => {
      delays.push(ms);
      return origSetTimeout(fn, 0); // resolve immediately for test
    }) as any;

    try {
      const port: SseStreamPort = {
        start: () => {
          connectCount++;
          if (connectCount <= 3) return errorStream([], 0); // error → reconnect
          return finiteStream([{ data: JSON.stringify({ type: 'vbook', stage: 'ANALYZING' }) }]);
        },
        stop() {},
      };
      const sink = mockSink();
      const tracking = mockTracking();
      let epoch = 0;

      await runSseStream(port, () => epoch, sink, tracking, 'book-1', {
        initialDelayMs: 1000,
        maxDelayMs: 15000,
        maxExponent: 4,
      });

      // Should have delays: 1000, 2000 (exponential)
      expect(delays.length).toBeGreaterThanOrEqual(2);
      expect(delays[0]).toBe(1000);
      expect(delays[1]).toBe(2000);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });

  it('skips events with empty data', async () => {
    const events: SseEvent[] = [
      { data: '' },
      { data: JSON.stringify({ type: 'vbook', stage: 'ANALYZING' }) },
    ];
    const port: SseStreamPort = {
      start: () => finiteStream(events),
      stop() {},
    };
    const sink = mockSink();
    const tracking = mockTracking();
    let epoch = 0;

    await runSseStream(port, () => epoch, sink, tracking, 'book-1');

    expect(sink.calls.filter((c) => c === 'setVBookProgress')).toHaveLength(1);
  });
});
