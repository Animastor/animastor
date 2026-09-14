// ═══════════════════════════════════════════════════════════════
//  GENERATION-PROGRESS DOMAIN — worker progress panel rows tests
// ═══════════════════════════════════════════════════════════════
//  computeProgressRows against an EXPLICIT tracking state: the
//  previously module-scope Maps/latches (taskReadyFloor /
//  taskCompletedAt / taskFrozenElapsed / generationCompleted /
//  newGenerationPending) are created fresh per test — no store, no
//  signals, no transport. The side-effect ports are recorders.
// ═══════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest';
import {
  computeProgressRows, createProgressTrackingState, hasAnyProgress, resetProgressTracking,
} from '../src/progressRows';
import type { ProgressRowContext, TaskLabels } from '../src/progressRows';
import { createGenerationTimer, startGenerationTimer } from '../src/timer';
import { createAnalyzingVBookProgress, createIdleVBookProgress } from '../src/vbookProgress';
import type { ProgressPanelResponse, ProgressTask } from '../src/models';

const NOW = 1_000_000;

const LABELS: TaskLabels = {
  cover: 'Cover', audio: 'Audio', image: 'Image', video: 'Video',
  generationDone: 'Done', vbookLabel: 'VBook, scenes',
  vbookAnalyzing: 'Analyzing…', vbookScenesFormat: (r, t) => `${r}/${t}`,
};

interface Harness {
  ctx: ProgressRowContext;
  effects: {
    regenerating: boolean[];
    finalized: number;
    idleCleared: number;
  };
}

function harness(overrides: Partial<ProgressRowContext> = {}): Harness {
  const tracking = createProgressTrackingState();
  const timer = createGenerationTimer();
  const effects = { regenerating: [] as boolean[], finalized: 0, idleCleared: 0 };
  const ctx: ProgressRowContext = {
    tracking,
    timer,
    now: NOW,
    vbookStage: 'IDLE',
    isRunning: false,
    vbookStageLabel: () => null,
    setRegenerating: (v) => { effects.regenerating.push(v); },
    onGenerationFinalized: () => { effects.finalized++; },
    onRunningIdle: () => { effects.idleCleared++; },
    ...overrides,
  };
  return { ctx, effects };
}

function task(partial: Partial<ProgressTask>): ProgressTask {
  return {
    task_id: 't1', type: 'image', scope: 'whole_book',
    chapter_id: null, scene_id: null,
    scene_label: null, chapter_label: null, end_scene_label: null, end_chapter_label: null,
    target_count: 1, started_at: NOW - 1_000,
    ready: 0, total: 5, percent: 0, done: false,
    visible: true, indeterminate: false, cancelled: false,
    ...partial,
  };
}

function panel(tasks: ProgressTask[], anyIncomplete = true): ProgressPanelResponse {
  return { tasks, overall_percent: 0, any_incomplete: anyIncomplete };
}

describe('computeProgressRows — server rows', () => {
  it('builds a running row and marks the session regenerating', () => {
    const h = harness();
    const state = computeProgressRows(h.ctx, panel([task({ ready: 2, total: 5, percent: 40 })]), null, LABELS);
    expect(state.kind).toBe('rows');
    if (state.kind !== 'rows') return;
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].ready).toBe(2);
    expect(state.rows[0].done).toBe(false);
    expect(state.rows[0].percent).toBe(40);
    expect(h.effects.regenerating).toEqual([true]);
  });

  it('ready floor is monotonic — a backend dip never lowers it', () => {
    const h = harness();
    computeProgressRows(h.ctx, panel([task({ ready: 3 })]), null, LABELS);
    const state = computeProgressRows(h.ctx, panel([task({ ready: 1 })]), null, LABELS);
    expect(state.kind).toBe('rows');
    if (state.kind !== 'rows') return;
    expect(state.rows[0].ready).toBe(3);
  });

  it('done row freezes its elapsed at first sighting and reports 100%', () => {
    const h = harness();
    startGenerationTimer(h.ctx.timer, NOW - 10_000);
    const state = computeProgressRows(h.ctx, panel([task({ ready: 5, done: true })]), null, LABELS);
    expect(state.kind).toBe('rows');
    if (state.kind !== 'rows') return;
    expect(state.rows[0].done).toBe(true);
    expect(state.rows[0].percent).toBe(100);
    expect(state.rows[0].frozen).toBe(true);
    expect(state.rows[0].elapsedSeconds).toBe(10);
    // Later calls keep the frozen value even as wall clock advances.
    h.ctx.now = NOW + 50_000;
    const later = computeProgressRows(h.ctx, panel([task({ ready: 5, done: true })]), null, LABELS);
    if (later.kind !== 'rows') return;
    expect(later.rows[0].elapsedSeconds).toBe(10);
  });

  it('STALE-DONE GATE: done rows from a previous session are skipped (timer never started)', () => {
    const h = harness();
    const state = computeProgressRows(h.ctx, panel([task({ ready: 5, done: true })]), null, LABELS);
    expect(state.kind).toBe('hidden');
    expect(hasAnyProgress(h.ctx.tracking)).toBe(false);
  });

  it('STALE-DONE GATE: done rows started before the session clock are skipped', () => {
    const h = harness();
    startGenerationTimer(h.ctx.timer, NOW);
    const state = computeProgressRows(h.ctx, panel([task({ ready: 5, done: true, started_at: NOW - 60_000 })]), null, LABELS);
    expect(state.kind).toBe('hidden');
  });

  it('STALE-DONE GATE tolerance: done rows started just after the session clock render', () => {
    const h = harness();
    startGenerationTimer(h.ctx.timer, NOW);
    const state = computeProgressRows(h.ctx, panel([task({ ready: 5, done: true, started_at: NOW - 1_000 })]), null, LABELS);
    expect(state.kind).toBe('rows');
  });

  it('a sole cancelled row trips the all-cancelled guard → hidden + tracking cleared', () => {
    const h = harness();
    startGenerationTimer(h.ctx.timer, NOW);
    const state = computeProgressRows(h.ctx, panel([task({ ready: 5, done: true, cancelled: true })]), null, LABELS);
    expect(state.kind).toBe('hidden');
    expect(h.effects.regenerating).toContain(false);
    expect(h.ctx.tracking.taskCompletedAt.size).toBe(0);
  });

  it('a cancelled row alongside a live sibling keeps rendering (failure isolation)', () => {
    const h = harness();
    startGenerationTimer(h.ctx.timer, NOW);
    const state = computeProgressRows(h.ctx, panel([
      task({ ready: 5, done: true, cancelled: true }),
      task({ task_id: 't2', ready: 2 }),
    ]), null, LABELS);
    expect(state.kind).toBe('rows');
    if (state.kind !== 'rows') return;
    expect(state.rows).toHaveLength(2);
  });

  it('sibling rows of one task key separately — completion of one does not expire the other', () => {
    const h = harness();
    startGenerationTimer(h.ctx.timer, NOW);
    const fast: ProgressTask = task({ task_id: 'T', type: 'image', scene_id: 'cover-scene', ready: 1, total: 1, done: true });
    const slow: ProgressTask = task({ task_id: 'T', type: 'image', scene_id: 'real-scene', ready: 3, total: 5 });
    const state = computeProgressRows(h.ctx, panel([fast, slow]), null, LABELS);
    expect(state.kind).toBe('rows');
    if (state.kind !== 'rows') return;
    expect(state.rows).toHaveLength(2);
    // 10s later the fast sibling expired, the running sibling stays.
    h.ctx.now = NOW + 10_001;
    const later = computeProgressRows(h.ctx, panel([fast, slow]), null, LABELS);
    expect(later.kind).toBe('rows');
    if (later.kind !== 'rows') return;
    expect(later.rows).toHaveLength(1);
    expect(later.rows[0].sceneId).toBe('real-scene');
    expect(later.rows[0].done).toBe(false);
  });

  it('invisible tasks never render', () => {
    const h = harness();
    const state = computeProgressRows(h.ctx, panel([task({ visible: false })]), null, LABELS);
    expect(state.kind).toBe('hidden');
  });

  it('all-cancelled guard: clears tracking, stops regenerating, hides', () => {
    const h = harness();
    startGenerationTimer(h.ctx.timer, NOW);
    const state = computeProgressRows(h.ctx, panel([
      task({ ready: 5, done: true, cancelled: true }),
      task({ task_id: 't2', ready: 5, done: true, cancelled: true }),
    ]), null, LABELS);
    expect(state.kind).toBe('hidden');
    expect(h.effects.regenerating).toContain(false);
    expect(h.ctx.tracking.taskCompletedAt.size).toBe(0);
  });
});

describe('computeProgressRows — finalisation', () => {
  it('all done rows expired → generationCompleted latch + onGenerationFinalized', () => {
    const h = harness();
    startGenerationTimer(h.ctx.timer, NOW);
    const done = task({ ready: 5, done: true });
    computeProgressRows(h.ctx, panel([done]), null, LABELS);
    h.ctx.now = NOW + 10_001;
    const state = computeProgressRows(h.ctx, panel([done]), null, LABELS);
    expect(state.kind).toBe('hidden');
    expect(h.ctx.tracking.generationCompleted).toBe(true);
    expect(h.effects.finalized).toBe(1);
    // Subsequent calls stay hidden without firing finalize again.
    const again = computeProgressRows(h.ctx, panel([done]), null, LABELS);
    expect(again.kind).toBe('hidden');
    expect(h.effects.finalized).toBe(1);
  });

  it('done rows inside the 10s display window keep rendering rows', () => {
    const h = harness();
    startGenerationTimer(h.ctx.timer, NOW);
    const done = task({ ready: 5, done: true });
    computeProgressRows(h.ctx, panel([done]), null, LABELS);
    h.ctx.now = NOW + 9_999;
    const state = computeProgressRows(h.ctx, panel([done]), null, LABELS);
    expect(state.kind).toBe('rows');
    expect(h.effects.finalized).toBe(0);
  });

  it('no workers at all → hidden; RUNNING pulse cleared only when no incomplete work and VBook idle', () => {
    const hIdle = harness({ isRunning: true });
    const s1 = computeProgressRows(hIdle.ctx, panel([], false), null, LABELS);
    expect(s1.kind).toBe('hidden');
    expect(hIdle.effects.idleCleared).toBe(1);

    const hActive = harness({ isRunning: true });
    const s2 = computeProgressRows(hActive.ctx, panel([], true), null, LABELS);
    expect(s2.kind).toBe('hidden');
    expect(hActive.effects.idleCleared).toBe(0); // any_incomplete keeps the pulse

    const hVbook = harness({ isRunning: true, vbookStage: 'ANALYZING' });
    const s3 = computeProgressRows(hVbook.ctx, panel([], false), null, LABELS);
    expect(s3.kind).toBe('hidden');
    expect(hVbook.effects.idleCleared).toBe(0); // live VBook keeps the pulse
  });
});

describe('computeProgressRows — new-generation gate', () => {
  it('newGenerationPending hides stale 100% rows until real activity appears', () => {
    const h = harness();
    h.ctx.tracking.newGenerationPending = true;
    const staleDone = task({ ready: 5, done: true, started_at: NOW - 60_000 });
    // No activity → hidden even though the panel reports the stale done row.
    const s1 = computeProgressRows(h.ctx, panel([staleDone], false), null, LABELS);
    expect(s1.kind).toBe('hidden');
    // GPU activity (a running task) opens the gate.
    const s2 = computeProgressRows(h.ctx, panel([task({ ready: 1 })]), null, LABELS);
    expect(s2.kind).toBe('rows');
    expect(h.ctx.tracking.newGenerationPending).toBe(false);
  });

  it('VBook activity (ANALYZING/CREATING_SCENES) opens the gate too', () => {
    const h = harness();
    h.ctx.tracking.newGenerationPending = true;
    const vbook = { ...createAnalyzingVBookProgress() };
    const s = computeProgressRows(h.ctx, null, vbook, LABELS);
    expect(s.kind).toBe('rows');
    expect(h.ctx.tracking.newGenerationPending).toBe(false);
  });

  it('a previously completed generation stays hidden until the next gate opens', () => {
    const h = harness();
    h.ctx.tracking.generationCompleted = true;
    const s = computeProgressRows(h.ctx, panel([task({ ready: 1 })]), null, LABELS);
    expect(s.kind).toBe('hidden');
  });
});

describe('computeProgressRows — VBook row', () => {
  it('ANALYZING → indeterminate row with the localized label', () => {
    const h = harness({ vbookStageLabel: () => 'Analyzing characters' });
    startGenerationTimer(h.ctx.timer, NOW - 4_000);
    const s = computeProgressRows(h.ctx, null, createAnalyzingVBookProgress(), LABELS);
    expect(s.kind).toBe('rows');
    if (s.kind !== 'rows') return;
    expect(s.rows[0].type).toBe('vbook');
    expect(s.rows[0].label).toBe('Analyzing characters');
    expect(s.rows[0].indeterminate).toBe(true);
    expect(s.rows[0].elapsedSeconds).toBe(4);
    expect(s.rows[0].frozen).toBe(false);
  });

  it('label fallback: stage label → backend message → generic label', () => {
    const h = harness({ vbookStageLabel: () => null });
    const vbook = { ...createAnalyzingVBookProgress(), message: '  Анализ  ' };
    const s = computeProgressRows(h.ctx, null, vbook, LABELS);
    if (s.kind !== 'rows') return;
    expect(s.rows[0].label).toBe('Анализ');
    const h2 = harness({ vbookStageLabel: () => null });
    const s2 = computeProgressRows(h2.ctx, null, createAnalyzingVBookProgress(), LABELS);
    if (s2.kind !== 'rows') return;
    expect(s2.rows[0].label).toBe('VBook, scenes');
  });

  it('CREATING_SCENES → determinate row with ready/total and count text', () => {
    const h = harness();
    const vbook = { ...createAnalyzingVBookProgress(), stage: 'CREATING_SCENES' as const, sceneIndex: 1, scenesInWindow: 3 };
    const s = computeProgressRows(h.ctx, null, vbook, LABELS);
    if (s.kind !== 'rows') return;
    expect(s.rows[0].done).toBe(false);
    expect(s.rows[0].ready).toBe(2);
    expect(s.rows[0].total).toBe(3);
    expect(s.rows[0].percent).toBe(66);
    expect(s.rows[0].countText).toBe('2/3');
    expect(s.rows[0].indeterminate).toBe(false);
  });

  it('COMPLETED → done 100% row preserving the final window counter (3/3, not 1/1)', () => {
    const h = harness();
    startGenerationTimer(h.ctx.timer, NOW);
    const vbook = { ...createAnalyzingVBookProgress(), stage: 'COMPLETED' as const, sceneIndex: 2, scenesInWindow: 3 };
    const s = computeProgressRows(h.ctx, null, vbook, LABELS);
    if (s.kind !== 'rows') return;
    expect(s.rows[0].done).toBe(true);
    expect(s.rows[0].percent).toBe(100);
    expect(s.rows[0].ready).toBe(3);
    expect(s.rows[0].total).toBe(3);
    expect(s.rows[0].frozen).toBe(true);
  });

  it('COMPLETED without scene-level progress shows the full window count', () => {
    const h = harness();
    const vbook = { ...createAnalyzingVBookProgress(), stage: 'COMPLETED' as const, sceneIndex: -1, scenesInWindow: 2 };
    const s = computeProgressRows(h.ctx, null, vbook, LABELS);
    if (s.kind !== 'rows') return;
    expect(s.rows[0].ready).toBe(2);
    expect(s.rows[0].total).toBe(2);
  });

  it('IDLE VBook renders no row', () => {
    const h = harness();
    const s = computeProgressRows(h.ctx, null, createIdleVBookProgress(), LABELS);
    expect(s.kind).toBe('hidden');
  });
});

describe('tracking state helpers', () => {
  it('resetProgressTracking clears Maps + the generationCompleted latch (import latch untouched — host owns it)', () => {
    const tracking = createProgressTrackingState();
    tracking.taskReadyFloor.set('a', 1);
    tracking.taskCompletedAt.set('a', 2);
    tracking.taskFrozenElapsed.set('a', 3);
    tracking.generationCompleted = true;
    tracking.importCompleteReceived = true;
    resetProgressTracking(tracking);
    expect(tracking.taskReadyFloor.size).toBe(0);
    expect(tracking.taskCompletedAt.size).toBe(0);
    expect(tracking.taskFrozenElapsed.size).toBe(0);
    expect(tracking.generationCompleted).toBe(false);
    expect(tracking.importCompleteReceived).toBe(true); // markImportIncomplete owns this one
  });

  it('hasAnyProgress reflects recorded floors/completions', () => {
    const tracking = createProgressTrackingState();
    expect(hasAnyProgress(tracking)).toBe(false);
    tracking.taskReadyFloor.set('a', 0);
    expect(hasAnyProgress(tracking)).toBe(false);
    tracking.taskReadyFloor.set('a', 1);
    expect(hasAnyProgress(tracking)).toBe(true);
    resetProgressTracking(tracking);
    tracking.taskCompletedAt.set('b', 1);
    expect(hasAnyProgress(tracking)).toBe(true);
  });
});
