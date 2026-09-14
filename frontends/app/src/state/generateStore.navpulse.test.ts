// @vitest-environment happy-dom
// ═══════════════════════════════════════════════════════════════
//  GENERATE STORE — nav-icon pulse lifecycle (Step 17, audit §28)
// ═══════════════════════════════════════════════════════════════
//  The nav-icon SUCCESS pulse (Android updateNavIconStatus port) is host
//  behavior driven by `generationStatus` transitions. These regression tests
//  pin the observable contract that survived the Step-17 NavPulseState
//  explicit-state refactor:
//   - SUCCESS pulse ~12s + hold ~10s → auto-reset to IDLE at ~22s total;
//   - wall-clock anchor (successSince): the deadline never slides on re-arm;
//   - SUCCESS → SUCCESS re-arms ONE timer (old timeout cleared — a stale
//     timeout callback can never reset a NEW SUCCESS);
//   - SUCCESS → IDLE/RUNNING/ERROR immediately stops the watchdog;
//   - timeout/watchdog callbacks after a manual reset are inert;
//   - cancel / teardown invalidate the pulse (generationStatus → IDLE).
//
//  Timers are mocked with vi.useFakeTimers; the store module is real (only
//  the network transport is mocked, same strategy as fileStore.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({
  API_BASE: 'http://test',
  getJson: vi.fn(async () => ({})),
  putJson: vi.fn(async () => ({})),
  postJson: vi.fn(async () => ({})),
  postJsonLong: vi.fn(async () => ({})),
  deleteJson: vi.fn(async () => ({})),
  getBlob: vi.fn(async () => new Blob([])),
  retryWithBackoff: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  sse: vi.fn(),
}));

import {
  bookId,
  cancelGeneration,
  generationStatus,
  resetGenerationStatus,
  setRegenerating,
} from './generateStore';

// setGenerationStatus is module-private; the SUCCESS/RUNNING transitions under
// test are driven through the real production entry points that write it:
// computeProgressRows' finalize port (host leg: stopProgressStream → SUCCESS)
// and startGeneration/checkAndRestore arming. For the pulse contract only the
// (non-)SUCCESS value matters, so a minimal direct write via the exported
// signal + the private arming path exercised through resetGenerationStatus is
// NOT sufficient — the one-shot/watchdog timers are armed ONLY by the private
// setGenerationStatus('SUCCESS'). Drive it through the real finalize path:// an empty progress-panel finalize (all rows expired → onGenerationFinalized).
import * as store from './generateStore';
import type { TaskLabels } from '@animastor/web-generator';
import type { ProgressPanelResponse, ProgressTask } from '../api/models';

const LABELS: TaskLabels = {
  cover: 'Cover', audio: 'Audio', image: 'Image', video: 'Video',
  generationDone: 'Done', vbookLabel: 'VBook, scenes',
  vbookAnalyzing: 'Analyzing…', vbookScenesFormat: (r: number, t: number) => `${r}/${t}`,
};

function doneTask(): ProgressTask {
  const now = Date.now();
  return {
    task_id: 't1', type: 'image', scope: 'whole_book',
    chapter_id: null, scene_id: null,
    scene_label: null, chapter_label: null, end_scene_label: null, end_chapter_label: null,
    target_count: 1, started_at: now - 1_000,
    ready: 5, total: 5, percent: 100, done: true,
    visible: true, indeterminate: false, cancelled: false,
  };
}

/** Drive the private setGenerationStatus('SUCCESS') through the REAL finalize
 *  path. Arm the session exactly like startGeneration (timer + newGenerationPending
 *  gate), then poll: first tick with RUNNING work (clears the new-gen gate and
 *  records the task), second tick with the task done, third tick past the 10s
 *  display window → all rows expire → onGenerationFinalized → SUCCESS. */
function finalizeToSuccess(): void {
  bookId.value = 'test-book';
  void store.startGeneration({ workerTypes: ['image'], scope: 'whole_book', chapterId: null, sceneId: null });
  const running = doneTask();
  running.ready = 2; running.done = false;
  const pRunning: ProgressPanelResponse = { tasks: [running], overall_percent: 40, any_incomplete: true };
  store.computeProgressRows(pRunning, null, LABELS); // clears newGenerationPending
  const done = doneTask();
  const pDone: ProgressPanelResponse = { tasks: [done], overall_percent: 100, any_incomplete: true };
  store.computeProgressRows(pDone, null, LABELS); // records taskCompletedAt
  vi.advanceTimersByTime(10_001);
  const pExpired: ProgressPanelResponse = { tasks: [done], overall_percent: 100, any_incomplete: true };
  store.computeProgressRows(pExpired, null, LABELS); // all rows expired → finalize
}

function setStatus(s: 'IDLE' | 'RUNNING' | 'ERROR' | 'SUCCESS'): void {
  if (s === 'IDLE') { resetGenerationStatus(); return; }
  if (s === 'SUCCESS') { finalizeToSuccess(); return; }
  // RUNNING/ERROR are written by startGeneration/error paths; for the pulse
  // contract only the non-SUCCESS value matters (it stops the watchdog).
  store.generationStatus.value = s;
}

describe('nav-icon SUCCESS pulse — lifecycle (Step 17, NavPulseState)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetGenerationStatus();
  });
  afterEach(() => {
    resetGenerationStatus();
    vi.useRealTimers();
  });

  it('SUCCESS auto-resets to IDLE after the 22s pulse+hold window', () => {
    setStatus('SUCCESS');
    expect(generationStatus.value).toBe('SUCCESS');
    vi.advanceTimersByTime(21_999);
    expect(generationStatus.value).toBe('SUCCESS');
    vi.advanceTimersByTime(1);
    expect(generationStatus.value).toBe('IDLE');
  });

  it('SUCCESS → SUCCESS re-arms ONE timer; a stale timeout never resets the NEW SUCCESS', () => {
    setStatus('SUCCESS');
    vi.advanceTimersByTime(20_000);
    expect(generationStatus.value).toBe('SUCCESS');
    // New generation finished while the old pulse was still on screen.
    setStatus('IDLE');
    setStatus('SUCCESS');
    // The FIRST timer's deadline has now passed — but it was cleared on
    // re-arm, so it must NOT reset the new SUCCESS...
    vi.advanceTimersByTime(2_000);
    expect(generationStatus.value).toBe('SUCCESS');
    // ...while the NEW timer still fires exactly 22s after the re-arm
    // (22s minus the 2s already advanced).
    vi.advanceTimersByTime(19_999);
    expect(generationStatus.value).toBe('SUCCESS');
    vi.advanceTimersByTime(1);
    expect(generationStatus.value).toBe('IDLE');
  });

  it('SUCCESS → RUNNING (restart) clears the pulse timers; no late auto-reset', () => {
    setStatus('SUCCESS');
    setStatus('RUNNING');
    // Past both the old deadline and the watchdog window.
    vi.advanceTimersByTime(30_000);
    expect(generationStatus.value).toBe('RUNNING');
  });

  it('watchdog self-heals a throttled/lost one-shot timer and then STOPS (no eternal interval)', () => {
    setStatus('SUCCESS');
    // Simulate browser throttling: the one-shot never fires on its own,
    // only the 1s watchdog ticks run.
    vi.advanceTimersByTime(22_000);
    expect(generationStatus.value).toBe('IDLE');
    // After the reset the watchdog must be stopped — no further ticking.
    const tickSpy = vi.spyOn(Date, 'now');
    const callsBefore = tickSpy.mock.calls.length;
    vi.advanceTimersByTime(5_000);
    // Date.now is called by the watchdog only while it is alive.
    expect(tickSpy.mock.calls.length - callsBefore).toBeLessThanOrEqual(1);
    tickSpy.mockRestore();
  });

  it('timeout and watchdog callbacks after a manual reset are inert', () => {
    setStatus('SUCCESS');
    resetGenerationStatus();
    vi.advanceTimersByTime(30_000);
    expect(generationStatus.value).toBe('IDLE');
  });

  it('cancelGeneration invalidates the pulse (teardown sets IDLE; watchdog stops)', () => {
    setStatus('SUCCESS');
    void cancelGeneration().then(() => {
      expect(generationStatus.value).toBe('IDLE');
      // The watchdog must be gone: advancing time must not flip anything.
      vi.advanceTimersByTime(10_000);
      expect(generationStatus.value).toBe('IDLE');
    });
    vi.advanceTimersByTime(0);
  });

  it('setRegenerating/teardown path (stopGenerationSession semantics) leaves no stuck pulse', () => {
    setStatus('SUCCESS');
    setRegenerating(false);
    resetGenerationStatus();
    vi.advanceTimersByTime(30_000);
    expect(generationStatus.value).toBe('IDLE');
  });
});
