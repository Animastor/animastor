// ═══════════════════════════════════════════════════════════════
//  PARALLEL AI ANALYSIS PROGRESS PANEL (Milestone #2)
// ═══════════════════════════════════════════════════════════════
// Renders one row per AI analysis task (characters / locations / voices)
// for the Generate page's VBook section when analysis_mode === 'parallel'.
//
// Sequential mode (the legacy default) renders NOTHING — the VBook row
// keeps its existing single-row UI (extracting_chars / voices /
// extracting_locs labels collapsing into one indeterminate bar).
//
// Wire contract: this component reads vbookAnalysisProgress + analysisMode
// from the store. Rows mutate through SSE-driven events; the timer ticks
// from a 500ms setInterval that drives a local `nowMs` signal.
//
// Mobile responsive: row layout uses flex with min-width: 0 — long task
// names truncate with text-overflow: ellipsis. No horizontal overflow.
// ═══════════════════════════════════════════════════════════════

import { useEffect, useState } from 'preact/hooks';
import { t, analysisTaskLabel, analysisTaskStatusLabel, tf } from '../app/i18n';
import {
  vbookAnalysisProgress,
  analysisMode,
  analysisOverallPercent,
  type AnalysisTaskRow,
  type AnalysisStatus,
} from '../state/generateStore';

const TICK_MS = 500;

/** Format mm:ss / hh:mm:ss — same canonical formatter the rest of the
 *  Generate page uses (see formatTimerText in GeneratePage.tsx). */
function formatTimer(seconds: number): string {
  const sec = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}`;
}

function elapsedSeconds(row: AnalysisTaskRow, nowMs: number): number {
  if (row.startedAt == null) return 0;
  const end = row.finishedAt ?? nowMs;
  return Math.max(0, Math.floor((end - row.startedAt) / 1000));
}

function percent(row: AnalysisTaskRow): number {
  switch (row.status) {
    case 'completed': return 100;
    case 'failed':
    case 'cancelled': return 100;  // bar shows full but with error/cancel tint
    case 'running':
      // No granular progress for LLM calls — animate indeterminate.
      // (Bar component renders indeterminate mode for running.)
      return -1;
    default: return 0;
  }
}

/** Maps status → small icon glyph. Reuses the project's Unicode-icon
 *  vocabulary (✓ / ✗ / ● / ○ / ⟳) — no new icon system. */
function statusGlyph(status: AnalysisStatus): string {
  switch (status) {
    case 'completed': return '✓';
    case 'failed':    return '✗';
    case 'cancelled': return '✗';
    case 'running':   return '●';
    default:          return '○';
  }
}

function statusClass(status: AnalysisStatus): string {
  switch (status) {
    case 'completed': return 'analysis-row__icon--done';
    case 'failed':    return 'analysis-row__icon--failed';
    case 'cancelled': return 'analysis-row__icon--cancelled';
    case 'running':   return 'analysis-row__icon--running';
    default:          return 'analysis-row__icon--waiting';
  }
}

function TaskRow({ row, nowMs }: { row: AnalysisTaskRow; nowMs: number }) {
  const elapsed = elapsedSeconds(row, nowMs);
  const pct = percent(row);
  const isIndeterminate = pct < 0;
  const label = analysisTaskLabel(row.id);
  const statusLabel = analysisTaskStatusLabel(row.status);

  return (
    <div class={'analysis-row analysis-row--' + row.status}>
      <div class="analysis-row__line">
        <span class={'analysis-row__icon ' + statusClass(row.status)} aria-hidden="true">
          {statusGlyph(row.status)}
        </span>
        <span class="analysis-row__name" title={label}>{label}</span>
        <span class={'analysis-row__status analysis-row__status--' + row.status}>{statusLabel}</span>
        {!isIndeterminate && (
          <span class="analysis-row__pct">{pct}%</span>
        )}
        <span class="analysis-row__timer">{formatTimer(elapsed)}</span>
      </div>
      <div class="analysis-row__bar">
        {isIndeterminate ? (
          <div class="analysis-row__bar-ind" />
        ) : (
          <div
            class={'analysis-row__bar-fill analysis-row__bar-fill--' + row.status}
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        )}
      </div>
      {row.status === 'failed' && row.error && (
        <p class="analysis-row__error">
          {tf('progress_analysis_failed_detail', row.error)}
        </p>
      )}
    </div>
  );
}

function OverallRow({ nowMs }: { nowMs: number }) {
  const ap = vbookAnalysisProgress.value;
  const phaseStartedAt = ap.phaseStartedAt;
  const phaseFinishedAt = ap.phaseFinishedAt;
  const elapsedSec = phaseStartedAt == null ? 0
    : Math.max(0, Math.floor(((phaseFinishedAt ?? nowMs) - phaseStartedAt) / 1000));
  const pct = analysisOverallPercent(ap);
  const allTerminal = ap.completedTasks + ap.failedTasks + ap.cancelledTasks >= ap.totalTasks;
  const hasFailure = ap.failedTasks > 0;
  const overallStatus: AnalysisStatus = hasFailure
    ? (allTerminal ? 'failed' : 'running')
    : (allTerminal ? 'completed' : 'running');

  return (
    <div class={'analysis-overall analysis-overall--' + overallStatus}>
      <div class="analysis-overall__line">
        <span class="analysis-overall__label">{t('progress_analysis_overall')}</span>
        <span class={'analysis-overall__pct analysis-overall__pct--' + overallStatus}>{pct}%</span>
        <span class="analysis-overall__timer">{formatTimer(elapsedSec)}</span>
      </div>
      <div class="analysis-overall__bar">
        <div
          class={'analysis-overall__bar-fill analysis-overall__bar-fill--' + overallStatus}
          style={{ width: `${pct}%` }}
        />
      </div>
      {allTerminal && (
        <p class="analysis-overall__total">
          {tf('progress_analysis_total_time', formatTimer(elapsedSec))}
        </p>
      )}
    </div>
  );
}

export function AnalysisProgressPanel() {
  // Local tick — drives the timers. Independent of the store: SSE updates
  // bump the row status; this tick only forces a re-render of elapsed text.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const ap = vbookAnalysisProgress.value;
  const mode = analysisMode.value;

  useEffect(() => {
    if (!ap.active) return;  // no work in flight → no tick needed
    const id = window.setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [ap.active, ap.phaseStartedAt]);

  // Sequential mode → render nothing. The VBook section keeps its legacy
  // single indeterminate row UI unchanged.
  if (mode !== 'parallel') return null;
  // No analysis phase yet → render nothing.
  if (!ap.active) return null;

  const tasks: AnalysisTaskRow[] = [
    ap.tasks.characters,
    ap.tasks.locations,
    ap.tasks.voices,
  ];

  return (
    <div class="analysis-panel">
      <div class="analysis-panel__title">{t('progress_analysis_section_title')}</div>
      <div class="analysis-panel__rows">
        {tasks.map((t) => <TaskRow key={t.id} row={t} nowMs={nowMs} />)}
      </div>
      <div class="analysis-panel__divider" />
      <OverallRow nowMs={nowMs} />
    </div>
  );
}