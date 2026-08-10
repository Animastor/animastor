import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { getJson } from '../api/client';
import type { BookData, BookChapter, BookScene, ProgressPanelResponse, WorkerCounts } from '../api/models';
import { t, tf } from '../app/i18n';
import { navigate } from '../app/router';
import { workerType } from '../app/routeState';
import {
  bookId, phase, vbookProgress, isRegenerating,
  audioEnabled, imageEnabled, videoEnabled, vbookEnabled,
  setAudioEnabled, setImageEnabled, setVideoEnabled, setVBookEnabled,
  startGeneration, startVBookGeneration, cancelGeneration, cancelTask,
  checkAndRestoreGenerationState, checkVBookAgentStatus, computeProgressRows,
  resetGenerationStatus, onPlaybackPrepared,
  getTimerStartedAt, getFinalElapsedSeconds,
} from '../state/generateStore';
import type { TaskLabels, TaskRow } from '../state/generateStore';
import { position as positionSignal } from '../state/positionStore';
import { toast } from '../lib/ui';
import { IconPlay, IconStop, IconSettings, IconLibrary, IconVolumeUp, IconVolumeOff, IconImage, IconImageOff, IconVideocam, IconVideocamOff } from '../app/icons';

// GeneratePage — 1:1 with GenerateFragment + fragment_generate.xml (stage 4).
//  - Position bar (include_position_bar) → tap navigates to /navigate.
//  - Global section: Generate All + Stop All.
//  - 4 worker sections (VBook/Audio/Image/Video): header row (accent bar, icon,
//    label "Audio Workers: N", settings gear, toggle chip On/Off), progress rows
//    (item_worker_progress), action buttons (Generate/Stop).
//  - Worker counts polled every 5s (updateSectionHeader icon states).
//  - Progress panel polled every 1.5s (computeProgressRows), timer 500ms.
//  - checkAndRestoreGenerationState 2.5s after mount.
//  - Scope dialog before Audio/Image/Video generation (DialogGenerateScopeBinding).

const POLL_COUNTS_MS = 5_000;
const POLL_PANEL_MS = 1_500;
const TIMER_TICK_MS = 500;
const RESTORE_DELAY_MS = 2_500;

// mode = "full" — GenUiState.mode default; isNeeded per layer mirrors Android.
type WorkerType = 'vbook' | 'audio' | 'image' | 'video';

export function GeneratePage(props: { path?: string }) {
  void props;
  const [counts, setCounts] = useState<WorkerCounts | null>(null);
  const [panel, setPanel] = useState<ReturnType<typeof computeProgressRows>>({ kind: 'hidden' });
  const [bookData, setBookData] = useState<BookData | null>(null);
  const [, setTimerTick] = useState(0);
  const [scopeFor, setScopeFor] = useState<WorkerType | 'all' | null>(null);
  const [popupRow, setPopupRow] = useState<TaskRow | null>(null);

  const bid = bookId.value;
  const currentPhase = phase.value;

  // ── Position bar (observePosition + updatePositionBar) ──
  const pos = positionSignal.value;
  const [posLabel, setPosLabel] = useState(t('navigate_no_position'));
  const [posUnitCount, setPosUnitCount] = useState<string | null>(null);

  // ── Load book data (loadBook) + reload on playbackPrepared ──
  const loadBook = useCallback(async () => {
    const bId = bookId.value;
    if (!bId) { setBookData(null); return; }
    try { setBookData(await getJson<BookData>(`/book/${encodeURIComponent(bId)}`)); } catch { /* keep stale */ }
  }, []);

  useEffect(() => {
    void loadBook();
    return onPlaybackPrepared(() => { void loadBook(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bid]);

  // ── Position bar label (updatePositionBar equivalent) ──
  useEffect(() => {
    const p = positionSignal.value;
    if (!p.chapterId || !bookData) { setPosLabel(t('navigate_no_position')); setPosUnitCount(null); return; }
    const ch: BookChapter | undefined = bookData.chapters?.find((c) => c.chapter_id === p.chapterId);
    const sc: BookScene | undefined = ch?.scenes?.find((s) => s.scene_id === p.sceneId);
    const isSpecial = ch?.is_special === true;
    const scIdx = sc?.display_index ?? 0;
    const allUnits = sc?.units ?? [];
    const uIdx = allUnits.length ? Math.min(Math.max(p.unitIndex, 0), allUnits.length - 1) : 0;
    const chTitle = ch?.chapter_title?.trim();
    const scTitle = sc?.scene_title?.trim();
    const chLabel = isSpecial
      ? (chTitle || (ch?.type?.charAt(0).toUpperCase() + (ch?.type ?? '').slice(1) || ''))
      : chTitle || (ch?.display_number != null ? `${t('navigate_chapter')} ${ch.display_number}` : t('navigate_no_position'));
    const scLabel = scIdx > 0 ? `${t('navigate_scene')} ${scIdx}` : '';
    const unitLabel = uIdx >= 0 && allUnits.length ? `${t('navigate_unit')} ${uIdx + 1}` : '';
    const full = scTitle
      ? `${chLabel} / ${scLabel} — ${scTitle}${unitLabel ? ' / ' + unitLabel : ''}`
      : `${chLabel} / ${scLabel}${unitLabel ? ' / ' + unitLabel : ''}`;
    setPosLabel(full || t('navigate_no_position'));
    setPosUnitCount(allUnits.length ? tf('navigate_units_count', allUnits.length) : null);
  }, [positionSignal.value, bookData]);

  // ── Auto-detect active generation from previous sessions (2.5s delay) ──
  useEffect(() => {
    const t0 = setTimeout(() => { void checkAndRestoreGenerationState(); }, RESTORE_DELAY_MS);
    return () => clearTimeout(t0);
  }, []);

  // ── Reset nav status when opening Generate tab with no active work
  //    (MainActivity bottom-nav onItemSelected logic) ──
  useEffect(() => {
    const hasActiveWork = isRegenerating.value ||
      (vbookProgress.value.stage !== 'IDLE' && vbookProgress.value.stage !== 'COMPLETED');
    if (!hasActiveWork) resetGenerationStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Worker counts poll (5s) — updateSectionHeader ──
  useEffect(() => {
    let alive = true;
    const loop = async () => {
      while (alive) {
        try {
          const c = await getJson<WorkerCounts>('/worker/counts');
          if (alive) setCounts(c);
        } catch { /* connection error — leave chips as-is */ }
        await new Promise((r) => setTimeout(r, POLL_COUNTS_MS));
      }
    };
    void loop();
    return () => { alive = false; };
  }, []);

  // ── Progress panel poll (1.5s) — refreshProgressUi ──
  useEffect(() => {
    let alive = true;
    const loop = async () => {
      while (alive) {
        const labels = buildLabels();
        const bId = bookId.value;
        if (bId) {
          try {
            const panelRes = await getJson<ProgressPanelResponse>(`/book/${encodeURIComponent(bId)}/progress-panel`);
            const vbookProg = vbookProgress.value;
            const hasVBook = vbookProg != null && vbookProg.stage !== 'IDLE';
            let vbookToShow = vbookProg;
            if (hasVBook) {
              const updated = await checkVBookAgentStatus();
              if (updated.stage !== 'IDLE') vbookToShow = updated;
            }
            const state = computeProgressRows(panelRes, vbookToShow, labels);
            if (alive) setPanel(state);
          } catch { /* next cycle */ }
        }
        await new Promise((r) => setTimeout(r, POLL_PANEL_MS));
      }
    };
    void loop();
    return () => { alive = false; };
  }, []);

  // ── Timer display refresh (500ms) ──
  useEffect(() => {
    const id = setInterval(() => setTimerTick((n) => n + 1), TIMER_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // ── Section header state (updateSectionHeader) ──
  const isGenerating = currentPhase === 'GENERATING' || currentPhase === 'LOADING_BOOK' || isRegenerating.value;
  const mode: string = 'full'; // GenUiState.mode default
  const isNeeded = (type: 'audio' | 'image' | 'video') =>
    type === 'video' ? mode === 'full' : (mode === 'storyboard' || mode === 'full' || mode === 'image_only');

  type IconState = 'error' | 'active' | 'normal' | 'off';
  function sectionState(type: WorkerType): { total: number; active: number; iconState: IconState; enabled: boolean } {
    const c = counts;
    const total = c ? (type === 'vbook' ? c.vbook : c[type]) : 0;
    const active = c ? (type === 'vbook' ? c.active_vbook : c[`active_${type}`]) : 0;
    const enabled = type === 'vbook' ? vbookEnabled.value
      : type === 'audio' ? audioEnabled.value
      : type === 'image' ? imageEnabled.value
      : videoEnabled.value;
    let iconState: IconState;
    if (type !== 'vbook' && isGenerating && active === 0 && isNeeded(type) && total === 0) {
      iconState = 'error';
    } else if (active > 0) {
      iconState = 'active';
    } else if (total > 0 && enabled) {
      iconState = 'normal';
    } else {
      iconState = 'off';
    }
    return { total, active, iconState, enabled };
  }

  // ── Actions ──
  const onGenerateAll = () => {
    if (!bookId.value) { toast(t('file_status_opening')); return; }
    setScopeFor('all');
  };

  const onStopAll = () => { void cancelGeneration(); };

  const onGenerateVBook = () => {
    if (!bookId.value) { toast(t('file_status_opening')); return; }
    void startVBookGeneration();
    toast(t('generate_started_vbook'));
  };

  const onGenerateLayer = (type: 'audio' | 'image' | 'video') => {
    if (!bookId.value) { toast(t('file_status_opening')); return; }
    const enabled = type === 'audio' ? audioEnabled.value
      : type === 'image' ? imageEnabled.value : videoEnabled.value;
    if (!enabled) {
      toast(type === 'audio' ? t('generate_audio_disabled')
        : type === 'image' ? t('generate_image_disabled') : t('generate_video_disabled'));
      return;
    }
    setScopeFor(type);
  };

  const onStopSection = (type: WorkerType) => { void cancelTask(type); };

  const onOpenSettings = (type: WorkerType) => {
    if (type === 'vbook') { navigate('/settings/vbook'); return; }
    workerType.value = type;
    navigate('/settings/worker');
  };

  // ── VBook button text (updateVBookButtonText) ──
  const hasExistingContent = bookData?.chapters?.some((ch) => (ch.scenes?.length ?? 0) > 0) === true;
  // Manual per-window mode: while a window's green COMPLETED row is shown the
  // session is still regenerating (isRegenerating stays true until the row's
  // 10s display window finalises it) — the button must still offer "Next"
  // (start the next window, fresh timer) during that display.
  const vbookBtnText = hasExistingContent && (!isRegenerating.value || vbookProgress.value.stage === 'COMPLETED') ? t('generate_vbook_next') : t('generate_vbook');

  // ── Rows per section container (renderTaskRowsToSections) ──
  const rowsFor = (type: WorkerType): TaskRow[] => {
    if (panel.kind !== 'rows') return [];
    return panel.rows.filter((r) => {
      if (r.type === 'vbook') return type === 'vbook';
      if (r.type === 'audio') return type === 'audio';
      if (r.type === 'cover' || r.type === 'image') return type === 'image';
      if (r.type === 'video') return type === 'video';
      return false;
    });
  };

  const showDoneRow = panel.kind === 'done';

  return (
    <section class="page gen-page">
      {/* Position bar (include_position_bar) */}
      <button class="gen-posbar" onClick={() => navigate('/navigate')}>
        <span class="gen-posbar__label">{posLabel}</span>
        {posUnitCount && <span class="gen-posbar__units">{posUnitCount}</span>}
      </button>

      {/* Global section */}
      <div class="card gen-card">
        <span class="gen-card__label">{t('generate_global_section')}</span>
        <div class="gen-global-row">
          <button class="btn gen-btn gen-btn--global" onClick={onGenerateAll}>
            <IconPlay width={20} height={20} /> {t('generate_all')}
          </button>
          <button class="btn gen-btn gen-btn--stop" onClick={onStopAll}>
            <IconStop width={20} height={20} /> {t('stop_all')}
          </button>
        </div>
      </div>

      {/* VBook section */}
      <WorkerSection
        label={tf('generate_section_vbook', sectionState('vbook').total)}
        iconActive={<IconLibrary width={24} height={24} />}
        iconInactive={<IconLibrary width={24} height={24} />}
        state={sectionState('vbook')}
        onToggle={() => { setVBookEnabled(!vbookEnabled.value); }}
        enabled={vbookEnabled.value}
        onSettings={() => onOpenSettings('vbook')}
        onGenerate={onGenerateVBook}
        genLabel={vbookBtnText}
        onStop={() => onStopSection('vbook')}
        rows={rowsFor('vbook')}
        showDoneRow={showDoneRow}
        onRowStop={setPopupRow}
      />

      {/* Audio section */}
      <WorkerSection
        label={tf('generate_section_audio', sectionState('audio').total)}
        iconActive={<IconVolumeUp width={24} height={24} />}
        iconInactive={<IconVolumeOff width={24} height={24} />}
        state={sectionState('audio')}
        onToggle={() => { setAudioEnabled(!audioEnabled.value); }}
        enabled={audioEnabled.value}
        onSettings={() => onOpenSettings('audio')}
        onGenerate={() => onGenerateLayer('audio')}
        genLabel={t('generate_audio')}
        onStop={() => onStopSection('audio')}
        rows={rowsFor('audio')}
        showDoneRow={showDoneRow}
        onRowStop={setPopupRow}
      />

      {/* Image section */}
      <WorkerSection
        label={tf('generate_section_image', sectionState('image').total)}
        iconActive={<IconImage width={24} height={24} />}
        iconInactive={<IconImageOff width={24} height={24} />}
        state={sectionState('image')}
        onToggle={() => { setImageEnabled(!imageEnabled.value); }}
        enabled={imageEnabled.value}
        onSettings={() => onOpenSettings('image')}
        onGenerate={() => onGenerateLayer('image')}
        genLabel={t('generate_images')}
        onStop={() => onStopSection('image')}
        rows={rowsFor('image')}
        showDoneRow={showDoneRow}
        onRowStop={setPopupRow}
      />

      {/* Video section */}
      <WorkerSection
        label={tf('generate_section_video', sectionState('video').total)}
        iconActive={<IconVideocam width={24} height={24} />}
        iconInactive={<IconVideocamOff width={24} height={24} />}
        state={sectionState('video')}
        onToggle={() => { setVideoEnabled(!videoEnabled.value); }}
        enabled={videoEnabled.value}
        onSettings={() => onOpenSettings('video')}
        onGenerate={() => onGenerateLayer('video')}
        genLabel={t('generate_video')}
        onStop={() => onStopSection('video')}
        rows={rowsFor('video')}
        showDoneRow={showDoneRow}
        onRowStop={setPopupRow}
      />

      {/* Scope dialog (DialogGenerateScopeBinding) */}
      {scopeFor != null && (
        <ScopeDialog
          hasPosition={pos.chapterId != null}
          onCancel={() => setScopeFor(null)}
          onStart={(scope) => {
            setScopeFor(null);
            const chId = scope !== 'whole_book' ? pos.chapterId : null;
            const scId = (scope === 'current_scene' || scope === 'from_current_scene') ? pos.sceneId : null;
            if (scopeFor === 'all') {
              const layers = [
                vbookEnabled.value && t('worker_vbook'), audioEnabled.value && t('progress_label_audio'),
                imageEnabled.value && t('progress_label_image'), videoEnabled.value && t('progress_label_video'),
              ].filter(Boolean).join(' → ');
              const scopeLabel = scope === 'current_scene' ? t('scope_current_scene')
                : scope === 'current_chapter' ? t('scope_current_chapter')
                : scope === 'from_current_scene' ? t('scope_from_current_scene') : t('scope_whole_book');
              void onGenerateVBook();
              toast(tf('generate_all_started', layers, scopeLabel));
            } else if (scopeFor === 'audio' || scopeFor === 'image' || scopeFor === 'video') {
              void (async () => {
                const res = await startGeneration({ workerTypes: [scopeFor], scope, chapterId: chId, sceneId: scId });
                if (res.ok) toast(tf('generate_started_layer', t(scopeFor === 'audio' ? 'progress_label_audio' : scopeFor === 'image' ? 'progress_label_image' : 'progress_label_video')));
                else toast(tf('generate_start_failed', res.message));
              })();
            }
          }}
        />
      )}

      {/* Row stop popup (PopupMenu — worker_stop_menu_cancel) */}
      {popupRow && (
        <div class="gen-popup-backdrop" onClick={() => setPopupRow(null)}>
          <div class="gen-popup" role="menu">
            <button
              class="gen-popup__item"
              role="menuitem"
              onClick={() => { void cancelTask(popupRow.type, popupRow.taskId); setPopupRow(null); }}
            >
              {t('worker_stop_menu_cancel')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════
//  WORKER SECTION — one card (fragment_generate.xml section block)
// ═══════════════════════════════════════════════════════════════

function WorkerSection({ label, iconActive, iconInactive, state, enabled, onToggle, onSettings, onGenerate, genLabel, onStop, rows, showDoneRow, onRowStop }: {
  label: string;
  iconActive: JSX.Element;
  iconInactive: JSX.Element;
  state: { total: number; active: number; iconState: 'error' | 'active' | 'normal' | 'off'; enabled: boolean };
  enabled: boolean;
  onToggle: () => void;
  onSettings: () => void;
  onGenerate: () => void;
  genLabel: string;
  onStop: () => void;
  rows: TaskRow[];
  showDoneRow: boolean;
  onRowStop: (row: TaskRow) => void;
}) {
  const showActiveIcon = state.iconState !== 'off' && state.iconState !== 'error';
  const pulse = state.iconState === 'active';
  return (
    <div class="card gen-card">
      {/* Header row — updateHeaderPanelStyle (accent bar + bg) */}
      <div class={'gen-header' + (enabled ? ' gen-header--on' : '')} onClick={onToggle}>
        <span class={'gen-header__bar' + (enabled ? ' gen-header__bar--on' : '')} />
        <span class={'gen-header__icon gen-header__icon--' + state.iconState + (pulse ? ' gen-header__icon--pulse' : '')}>
          {showActiveIcon ? iconActive : iconInactive}
        </span>
        <span class="gen-header__label">{label}</span>
        <button
          class="gen-header__gear"
          aria-label={t('settings_title')}
          onClick={(e) => { e.stopPropagation(); onSettings(); }}
        >
          <IconSettings width={22} height={22} />
        </button>
        <button
          class={'gen-toggle' + (enabled ? ' gen-toggle--on' : '')}
          aria-pressed={enabled}
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
        >
          {enabled ? t('toggle_on') : t('toggle_off')}
        </button>
      </div>

      {/* Progress rows */}
      <div class="gen-rows">
        {showDoneRow && <DoneRow />}
        {!showDoneRow && rows.map((row, i) => (
          <WorkerRow key={row.taskId ?? `${row.type}-${i}`} row={row} onStop={() => onRowStop(row)} />
        ))}
      </div>

      {/* Action buttons */}
      <div class="gen-actions">
        <button class="btn gen-btn" onClick={onGenerate}>
          <IconPlay width={20} height={20} /> {genLabel}
        </button>
        <button class="btn gen-btn gen-btn--stop" onClick={onStop}>
          <IconStop width={20} height={20} /> {t('generate_stop')}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  WORKER ROW — item_worker_progress.xml
// ═══════════════════════════════════════════════════════════════

function WorkerRow({ row, onStop }: { row: TaskRow; onStop: () => void }) {
  const elapsed = row.frozen ? row.elapsedSeconds : liveElapsedSeconds();
  const name = scopedTaskLabel(row);
  // Android renderTaskRowsToSections: workerCount = countText ?: "${ready}/${total}"
  // (GPU workers have no server countText → shows the ready/total chunk counter,
  // e.g. "2/5" — same format as progress_vbook_scenes). Hidden for indeterminate.
  const countText = row.countText ?? (row.total > 0 ? `${row.ready}/${row.total}` : null);
  if (row.cancelled) {
    return (
      <div class="gen-row">
        <span class="gen-row__name gen-row__name--cancelled">
          {t('generation_done')} — {name}
        </span>
      </div>
    );
  }
  if (row.indeterminate) {
    return (
      <div class="gen-row">
        <div class="gen-row__line">
          <span class="gen-row__name">{name}</span>
          <span class="gen-row__timer">{formatTimerText(elapsed)}</span>
          <button class="gen-row__stop" aria-label={t('worker_stop_desc')} onClick={onStop}>
            <IconStop width={18} height={18} />
          </button>
        </div>
        <div class="gen-row__bar"><div class="gen-row__bar-ind" /></div>
      </div>
    );
  }
  if (row.done) {
    return (
      <div class="gen-row">
        <div class="gen-row__line">
          <span class="gen-row__name gen-row__name--done">{t('generation_done')} — {name}</span>
          {countText != null && <span class="gen-row__count gen-row__count--done">{countText}</span>}
          <span class="gen-row__pct gen-row__pct--done">100%</span>
          <span class="gen-row__timer">{formatTimerText(elapsed)}</span>
        </div>
        <div class="gen-row__bar"><div class="gen-row__bar-fill gen-row__bar-fill--done" style={{ width: '100%' }} /></div>
      </div>
    );
  }
  return (
    <div class="gen-row">
      <div class="gen-row__line">
        <span class="gen-row__name">{name}</span>
        {countText != null && <span class="gen-row__count">{countText}</span>}
        <span class="gen-row__pct">{row.percent}%</span>
        <span class="gen-row__timer">{formatTimerText(elapsed)}</span>
        <button class="gen-row__stop" aria-label={t('worker_stop_desc')} onClick={onStop}>
          <IconStop width={18} height={18} />
        </button>
      </div>
      <div class="gen-row__bar">
        <div class="gen-row__bar-fill" style={{ width: `${Math.min(100, Math.max(0, row.percent))}%` }} />
      </div>
    </div>
  );
}

// showSingleDoneRow — one green Done row across all section containers.
function DoneRow() {
  return (
    <div class="gen-row">
      <div class="gen-row__line">
        <span class="gen-row__name gen-row__name--done">{t('generation_done')}</span>
        <span class="gen-row__pct gen-row__pct--done">100%</span>
        <span class="gen-row__timer">{formatTimerText(globalElapsedSeconds())}</span>
      </div>
      <div class="gen-row__bar"><div class="gen-row__bar-fill gen-row__bar-fill--done" style={{ width: '100%' }} /></div>
    </div>
  );
}

// scopedTaskLabel — label with scope target appended (current_scene etc).
function scopedTaskLabel(row: TaskRow): string {
  const target = row.scope === 'current_scene' ? row.sceneLabel
    : row.scope === 'current_chapter' ? row.chapterLabel
    : row.scope === 'from_current_scene'
      ? (row.sceneLabel && row.endSceneLabel && row.sceneLabel !== row.endSceneLabel
        ? `${row.sceneLabel} — ${row.endSceneLabel}`
        : row.sceneLabel ? `${row.sceneLabel}+` : null)
      : null;
  return target ? `${row.label} · ${target}` : row.label;
}

// Timer helpers — formatTimerText + live/frozen elapsed (Android formatTimerText).
function liveElapsedSeconds(): number {
  const started = getTimerStartedAt();
  if (started > 0) return Math.floor((Date.now() - started) / 1000);
  return getFinalElapsedSeconds();
}
function globalElapsedSeconds(): number {
  const started = getTimerStartedAt();
  if (started > 0) return Math.floor((Date.now() - started) / 1000);
  return getFinalElapsedSeconds();
}
function formatTimerText(elapsedSeconds: number): string {
  const sec = Math.max(0, Math.floor(elapsedSeconds));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}`;
}

// buildLabels — TaskLabels for computeProgressRows (localized).
function buildLabels(): TaskLabels {
  return {
    cover: t('progress_cover_generating'),
    audio: t('progress_label_audio'),
    image: t('progress_label_image'),
    video: t('progress_label_video'),
    generationDone: t('generation_done'),
    vbookLabel: 'VBook, scenes',
    vbookAnalyzing: t('progress_vbook_analyzing'),
    vbookScenesFormat: (ready, total) => tf('progress_vbook_scenes', ready, total),
  };
}

// ═══════════════════════════════════════════════════════════════
//  SCOPE DIALOG — DialogGenerateScopeBinding (radio group)
// ═══════════════════════════════════════════════════════════════

function ScopeDialog({ hasPosition, onCancel, onStart }: {
  hasPosition: boolean;
  onCancel: () => void;
  onStart: (scope: string) => void;
}) {
  const [scope, setScope] = useState('whole_book');
  const options: { id: string; label: string; needsPosition: boolean }[] = [
    { id: 'current_scene', label: t('scope_current_scene'), needsPosition: true },
    { id: 'current_chapter', label: t('scope_current_chapter'), needsPosition: true },
    { id: 'from_current_scene', label: t('scope_from_current_scene'), needsPosition: true },
    { id: 'whole_book', label: t('scope_whole_book'), needsPosition: false },
  ];
  return (
    <div class="modal-backdrop" onClick={onCancel} role="presentation">
      <div class="modal" role="dialog" aria-modal="true" aria-label={t('generate_dialog_title')} onClick={(e) => e.stopPropagation()}>
        <div class="modal__title">{t('generate_dialog_title')}</div>
        <div class="modal__body">
          {options.map((o) => {
            const disabled = o.needsPosition && !hasPosition;
            return (
              <label class={'gen-scope' + (disabled ? ' gen-scope--disabled' : '')} key={o.id}>
                <input
                  type="radio"
                  name="gen-scope"
                  value={o.id}
                  checked={scope === o.id}
                  disabled={disabled}
                  onChange={() => setScope(o.id)}
                />
                <span>{o.label}</span>
              </label>
            );
          })}
        </div>
        <div class="modal__footer">
          <button class="btn btn--outlined" onClick={onCancel}>{t('dialog_cancel')}</button>
          <button class="btn" onClick={() => onStart(scope)}>{t('dialog_start')}</button>
        </div>
      </div>
    </div>
  );
}
