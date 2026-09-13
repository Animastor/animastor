// ═══════════════════════════════════════════════════════════════
//  GENERATION-PROGRESS DOMAIN — worker progress panel rows
// ═══════════════════════════════════════════════════════════════
//  Step-1 domain slice of the web-generator extraction
//  (docs/architecture/web-generator-extraction-audit.md §4.3.1).
//  Port of GenerateViewModel.computeProgressRows. All previously
//  module-scope tracking state — the monotonic ready floor Map, the
//  per-row completion Map, the frozen-elapsed Map, and the
//  generationCompleted / newGenerationPending / importCompleteReceived
//  latches — lives in an EXPLICIT ProgressTrackingState object the
//  host owns and passes in. The host signals the compute result is
//  routed to (isRegenerating, generationStatus, vbookProgress,
//  stopProgressStream, applyGenerationResults) arrive as the
//  ProgressRowContext callbacks — the domain never touches a signal.
// ═══════════════════════════════════════════════════════════════

import type { ProgressPanelResponse, ProgressTask } from '../../api/models';
import type { VBookProgress, VBookStage } from './vbookProgress';
import type { GenerationTimerState } from './timer';

// Row display window for done rows (Android COMPLETED_TASK_DISPLAY_MS).
const COMPLETED_TASK_DISPLAY_MS = 10_000;
// Tolerance for comparing server task started_at against the client session
// clock (Date.now()): absorbs small client/server clock skew so a task that
// legitimately started right after the user clicked Generate is never wrongly
// classified as stale. Safe against the reported flash: the no-session branch
// (startedAt <= 0) still suppresses every done row on fresh page open.
const STALE_DONE_TOLERANCE_MS = 3_000;

/** Explicit tracking state (previously module-scope Maps + latches in
 *  generateStore.ts — audit §6 blocker 6: "parameterized into a state
 *  object instead of module scope"). One instance per host session;
 *  the host (generateStore) owns it, resets it, and passes it to every
 *  computeProgressRows call. */
export interface ProgressTrackingState {
  /** Monotonic ready-count floor per row key — the backend can briefly
   *  report a lower ready count during a task restart; the floor never goes
   *  backwards. */
  taskReadyFloor: Map<string, number>;
  /** First-seen completion timestamp per row key (drives the 10s done window). */
  taskCompletedAt: Map<string, number>;
  /** Elapsed seconds frozen at completion per row key (done rows keep their
   *  final timer value). */
  taskFrozenElapsed: Map<string, number>;
  /** Latch: the generation finalised (all rows expired) — the panel hides
   *  until the next new-generation gate opens. */
  generationCompleted: boolean;
  /** Latch: a new generation was requested but no new activity has been
   *  observed yet — stale 100% rows from the previous run stay hidden. */
  newGenerationPending: boolean;
  /** Latch: the SSE `import_complete` handshake for the current import run
   *  (set by sseRouting, consumed by the host VBook poll loop). */
  importCompleteReceived: boolean;
}

export function createProgressTrackingState(): ProgressTrackingState {
  return {
    taskReadyFloor: new Map(),
    taskCompletedAt: new Map(),
    taskFrozenElapsed: new Map(),
    generationCompleted: false,
    newGenerationPending: false,
    importCompleteReceived: false,
  };
}

/** Clear in-flight generation tracking (GenerateViewModel.resetProgressState).
 *  Used by the Settings clear-storyboard flow — the book stays open, only the
 *  progress-panel tracking is reset. Also clears the importComplete latch
 *  (markImportIncomplete). */
export function resetProgressTracking(s: ProgressTrackingState): void {
  s.taskCompletedAt.clear();
  s.taskReadyFloor.clear();
  s.taskFrozenElapsed.clear();
  s.generationCompleted = false;
}

/** Any in-flight work ever recorded? (drives the post-cancel soft refresh). */
export function hasAnyProgress(s: ProgressTrackingState): boolean {
  return [...s.taskReadyFloor.values()].some((v) => v > 0) || s.taskCompletedAt.size > 0;
}

/**
 * Row-unique tracking key for one progress row.
 *
 * A generation task can emit MULTIPLE rows: the backend's progress-panel emits
 * one row per target scene for `current_scene` tasks, and a task can legitimately
 * span several scenes. Keying the monotonic floor / completion timestamp by
 * task_id ALONE made sibling rows of the same task share one record: when the
 * first sibling finished (e.g. the cover's fast 1/1 row), its `completedAt` was
 * recorded under the shared key, and the 10s done-row expiry then dropped the
 * STILL-RUNNING sibling (the real scene) the moment it reached 5/5 — so the
 * final green "5/5 → 100%" row never rendered and the panel finalised early
 * (the reported "4/5 → drop, no final 100%" bug). The shared floor also leaked
 * ready counts across rows (e.g. a cover row showing "4/1").
 */
function rowTaskKey(taskId: string | null, type: string, chapterId: string | null, sceneId: string | null): string {
  return taskId ? `${taskId}:${type}:${chapterId ?? ''}:${sceneId ?? ''}` : `legacy:${type}`;
}

/** One row in the GPU progress panel (TaskRow.kt). */
export interface TaskRow {
  taskId: string | null;
  type: string;
  label: string;
  scope: string;
  chapterId: string | null;
  sceneId: string | null;
  sceneLabel: string | null;
  chapterLabel: string | null;
  endSceneLabel: string | null;
  endChapterLabel: string | null;
  ready: number;
  total: number;
  percent: number;
  done: boolean;
  countText: string | null;
  indeterminate: boolean;
  cancelled: boolean;
  /** Frozen elapsed (done) vs live (active): -1 live, >= 0 frozen. */
  elapsedSeconds: number;
  /** true when elapsedSeconds is frozen at completion (Android row.tag >= 0). */
  frozen: boolean;
}

/** Localized label strings for the worker progress panel (TaskLabels.kt). */
export interface TaskLabels {
  cover: string;
  audio: string;
  image: string;
  video: string;
  generationDone: string;
  vbookLabel: string;
  vbookAnalyzing: string;
  vbookScenesFormat: (ready: number, total: number) => string;
}

export type ProgressPanelState =
  | { kind: 'rows'; rows: TaskRow[] }
  | { kind: 'done' }
  | { kind: 'hidden' };

/** Host bridge for one computeProgressRows call: the explicit tracking +
 *  timer state, the host-owned values read at call time, and the side-effect
 *  ports for the branches that previously wrote generateStore signals
 *  directly. The domain calls back; it never reaches a signal or a store. */
export interface ProgressRowContext {
  tracking: ProgressTrackingState;
  timer: GenerationTimerState;
  /** Wall-clock now (epoch ms) — injected so tests are deterministic. */
  now: number;
  /** Host's vbookProgress.stage at call time (read for the no-rows RUNNING
   *  pulse self-heal). */
  vbookStage: VBookStage;
  /** Host's generationStatus === 'RUNNING' at call time. */
  isRunning: boolean;
  /** i18n stage label (app/i18n vbookStageLabel) — port-shaped injection. */
  vbookStageLabel: (stepType: string | null, sceneIndex: number) => string | null;
  /** Host isRegenerating writes (panel tracks in-flight work state). */
  setRegenerating: (v: boolean) => void;
  /** All rows expired → finalise the generation host-side: stop the SSE
   *  stream, clear a COMPLETED VBook stage, set SUCCESS, apply results. */
  onGenerationFinalized: () => void;
  /** RUNNING pulse with no work in flight → clear the nav-icon status. */
  onRunningIdle: () => void;
}

/**
 * Build the progress panel state from server-computed worker list + local VBook
 * (port of GenerateViewModel.computeProgressRows). Mutates the EXPLICIT
 * tracking state (monotonic floor, 10s done-window, new-gen gate) and
 * finalises the generation via the context callbacks when all rows expire.
 */
export function computeProgressRows(
  ctx: ProgressRowContext,
  panel: ProgressPanelResponse | null,
  vbookProg: VBookProgress | null,
  labels: TaskLabels
): ProgressPanelState {
  const tracking = ctx.tracking;
  const timer = ctx.timer;

  // NEW-GEN GATE: wait for actual new activity before showing stale 100% rows.
  if (tracking.newGenerationPending) {
    const hasVBook = vbookProg != null &&
      (vbookProg.stage === 'ANALYZING' || vbookProg.stage === 'CREATING_SCENES');
    const hasGpuActivity = panel?.tasks?.some((t) => !t.done && !t.cancelled && t.visible) === true;
    if (hasVBook || hasGpuActivity) {
      tracking.generationCompleted = false;
      tracking.newGenerationPending = false;
    } else {
      return { kind: 'hidden' };
    }
  }

  if (tracking.generationCompleted) return { kind: 'hidden' };

  const now = ctx.now;
  const rows: TaskRow[] = [];

  const addFromServer = (sw: ProgressTask, label: string) => {
    if (sw.total <= 0) return;
    // Per-ROW key: sibling rows of one task (per-target rows) keep their own
    // floor and their own 10s done-window — a fast sibling can never expire a
    // still-running one, and ready counts never cross-pollute.
    const taskKey = rowTaskKey(sw.task_id ?? null, sw.type, sw.chapter_id ?? null, sw.scene_id ?? null);
    const ready = Math.max(sw.ready, tracking.taskReadyFloor.get(taskKey) ?? 0);
    const done = sw.done || (ready >= sw.total && ready > 0);
    // STALE-DONE GATE — the backend keeps recently-completed tasks in the panel
    // for ~30s (TERMINAL_RETENTION_MS) and can report a task whose assets are all
    // ready as done. On page open these done rows from a PREVIOUS generation must
    // NOT flash as fresh green 100% bars: only work that started within the current
    // session (timer.startedAt) may render its "Done" state. Rows started before
    // the session (or with no session at all) are skipped before they reach the
    // ready-floor / completedAt maps, so they can never look freshly finished.
    // (Complementary to the newGenerationPending gate, which covers stale rows
    // right after starting a NEW generation from this page.)
    const staleDone = done && !sw.cancelled && (
      timer.startedAt <= 0 ||
      (sw.started_at != null && sw.started_at + STALE_DONE_TOLERANCE_MS < timer.startedAt)
    );
    if (staleDone) return;
    tracking.taskReadyFloor.set(taskKey, ready);
    if (done && !sw.cancelled && !tracking.taskCompletedAt.has(taskKey)) tracking.taskCompletedAt.set(taskKey, now);
    const frozen = done && !tracking.taskFrozenElapsed.has(taskKey);
    const elapsedSeconds: number = done
      ? (tracking.taskFrozenElapsed.get(taskKey) ?? (timer.startedAt > 0 ? Math.floor((now - timer.startedAt) / 1000) : 0))
      : (timer.startedAt > 0 ? Math.floor((now - timer.startedAt) / 1000) : 0);
    if (frozen) tracking.taskFrozenElapsed.set(taskKey, elapsedSeconds);
    rows.push({
      taskId: sw.task_id ?? null,
      type: sw.type,
      label,
      scope: sw.scope || 'whole_book',
      chapterId: sw.chapter_id ?? null,
      sceneId: sw.scene_id ?? null,
      sceneLabel: sw.scene_label ?? null,
      chapterLabel: sw.chapter_label ?? null,
      endSceneLabel: sw.end_scene_label ?? null,
      endChapterLabel: sw.end_chapter_label ?? null,
      ready,
      total: sw.total,
      percent: done ? 100 : sw.percent,
      done,
      countText: null,
      indeterminate: sw.indeterminate,
      cancelled: sw.cancelled,
      elapsedSeconds,
      frozen: done,
    });
  };

  if (panel != null) {
    for (const sw of panel.tasks) {
      if (!sw.visible) continue;
      const label = sw.type === 'cover' ? labels.cover
        : sw.type === 'audio' ? labels.audio
        : sw.type === 'image' ? labels.image
        : sw.type === 'video' ? labels.video
        : sw.type;
      addFromServer(sw, label);
    }
  }

  // ── VBook worker (local state) ──
  if (vbookProg != null && vbookProg.stage !== 'IDLE') {
    const vbookElapsed = timer.startedAt > 0 ? Math.floor((now - timer.startedAt) / 1000) : 0;
    if (vbookProg.stage === 'COMPLETED') {
      const vbookKey = rowTaskKey('vbook', 'vbook', null, null);
      if (!tracking.taskCompletedAt.has(vbookKey)) tracking.taskCompletedAt.set(vbookKey, now);
      if (!tracking.taskFrozenElapsed.has(vbookKey)) tracking.taskFrozenElapsed.set(vbookKey, vbookElapsed);
      // Preserve the final window counter (e.g. "3/3") instead of resetting to
      // "1/1": derive ready/total from the last known window state. When no
      // scene-level index was ever reported, show the full window count (best
      // available estimate).
      const finalTotal = Math.max(1, vbookProg.scenesInWindow);
      const hasSceneProgress = vbookProg.sceneIndex >= 0 && vbookProg.scenesInWindow > 0;
      const finalReady = hasSceneProgress
        ? Math.min(vbookProg.sceneIndex + 1, finalTotal)
        : finalTotal;
      rows.push({
        taskId: 'vbook', type: 'vbook', label: labels.vbookLabel, scope: 'whole_book',
        chapterId: null, sceneId: null, sceneLabel: null, chapterLabel: null,
        endSceneLabel: null, endChapterLabel: null,
        ready: finalReady, total: finalTotal, percent: 100, done: true, countText: null,
        indeterminate: false, cancelled: false,
        elapsedSeconds: tracking.taskFrozenElapsed.get(rowTaskKey('vbook', 'vbook', null, null)) ?? vbookElapsed, frozen: true,
      });
    } else {
      const stageMsg = vbookProg.message?.trim() || null;
      // Localize by machine stage id first (follows the UI language); fall back
      // to the backend's Russian progress message, then the generic label.
      const label = ctx.vbookStageLabel(vbookProg.stepType, vbookProg.sceneIndex) ?? stageMsg ?? labels.vbookLabel;
      let ready: number; let total: number; let pct: number;
      let countText: string | null = null; let indeterminate: boolean;
      if (vbookProg.stage === 'ANALYZING') {
        ready = 0; total = 1; pct = 0; indeterminate = true;
      } else if (vbookProg.stage === 'CREATING_SCENES') {
        total = Math.max(1, vbookProg.scenesInWindow);
        ready = Math.max(0, Math.min(vbookProg.sceneIndex + 1, total));
        pct = ready >= total ? 100 : Math.floor((ready * 100) / total);
        countText = labels.vbookScenesFormat(ready, total);
        indeterminate = false;
      } else {
        ready = 0; total = 1; pct = 0; indeterminate = true;
      }
      rows.push({
        taskId: 'vbook', type: 'vbook', label, scope: 'whole_book',
        chapterId: null, sceneId: null, sceneLabel: null, chapterLabel: null,
        endSceneLabel: null, endChapterLabel: null,
        ready, total, percent: pct, done: false, countText, indeterminate,
        cancelled: false, elapsedSeconds: vbookElapsed, frozen: false,
      });
    }
  }

  // ── All-cancelled guard ──
  const allCancelled = rows.length > 0 && rows.every((r) => r.cancelled);
  if (allCancelled) {
    tracking.taskCompletedAt.clear();
    ctx.setRegenerating(false);
    return { kind: 'hidden' };
  }

  // ── No workers at all → Hidden ──
  if (rows.length === 0) {
    tracking.taskCompletedAt.clear();
    ctx.setRegenerating(false);
    // A restored/straggler generation that finished while this page was closed
    // may leave the nav icon pulsing RUNNING with nothing actually in flight —
    // clear it. Only fires when the backend reports nothing incomplete AND no
    // VBook agent is active: a live restored generation whose panel is
    // transiently empty between windows must keep its RUNNING pulse.
    if (ctx.isRunning
      && !panel?.any_incomplete
      && ctx.vbookStage === 'IDLE') {
      ctx.onRunningIdle();
    }
    return { kind: 'hidden' };
  }

  // ── Per-worker expiry: drop done rows whose 10s display window expired ──
  // Uses the ROW-unique key (task + type + target), so each sibling row of a
  // multi-target task expires by its OWN completion time — the real scene's
  // green 5/5 stays visible for its full 10s window and only then finalises.
  const filtered = rows.filter((row) => {
    if (row.done && !row.cancelled) {
      const taskKey = rowTaskKey(row.taskId, row.type, row.chapterId, row.sceneId);
      const completedAt = tracking.taskCompletedAt.get(taskKey);
      return !(completedAt != null && (now - completedAt) >= COMPLETED_TASK_DISPLAY_MS);
    }
    return true;
  });
  rows.length = 0;
  rows.push(...filtered);

  // ── All workers expired → finalise generation ──
  if (rows.length === 0) {
    tracking.generationCompleted = true;
    tracking.taskCompletedAt.clear();
    ctx.onGenerationFinalized();
    return { kind: 'hidden' };
  }

  // Check if any worker is still active (non-done, non-cancelled)
  const anyActive = rows.some((r) => !r.done && !r.cancelled);
  if (!anyActive) {
    // All remaining workers done but still within the 10s display window
    return { kind: 'rows', rows };
  }

  ctx.setRegenerating(true);
  return { kind: 'rows', rows };
}
