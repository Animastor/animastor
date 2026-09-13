// GenerateViewModel equivalent (stages 0/3/4). Holds bookId/buildId, generation
// status (RUNNING/ERROR/SUCCESS/IDLE), VBookStage, layer-config toggles, worker
// progress panel state (computeProgressRows), the generation timer, the SSE
// progress stream, and emits `playbackPrepared` which the playback coordinator
// (playbackStore.wirePlaybackCoordination) forwards to PlaybackViewModel.
// Stage 4 adds the Generate screen slice: layer config, worker counts, VBook
// progress, task-aware progress panel, and generation start/cancel actions.
// The File-screen slice (import/open/create/close flows + import/export
// bookkeeping) moved to state/fileStore.ts (audit blocker B1 split) — this
// store keeps ONLY the shared session identity (bookId/buildId + loadBook) and
// the shared status signals (phase/errorMessage) written by both slices.
//
// GENERATION-PROGRESS DOMAIN SPLIT (web-generator-extraction-audit.md §4.3.1,
// Step 1 of the preparation sequence): the pure/near-pure progress logic —
// applyAnalysisEvent/analysisOverallPercent/resetAnalysisProgress (analysis
// state machine), computeProgressRows + tracking Maps/latches, the analysis/
// progress SSE event routing, and the generation-timer math — physically
// lives in state/generationProgress/ and is parameterized by EXPLICIT state
// objects (progressTracking, generationTimer) owned HERE. This store remains
// the host: identity (bookId/buildId), loadBook/persistence/stash-restore,
// phase/errorMessage (SessionSeam contract), onPlaybackPrepared, transport
// (api/client) and the VBook orchestration actions. No behavior changed.
import { signal } from '@preact/signals';
import { getJson, postJson, postJsonLong, putJson, sse } from '../api/client';
import type {
  AssetsStateResponse, BookData, BookStatus, DiffSummary, LayerConfigResponse,
  ProgressPanelResponse, RegenerateResponse, WorkerCounts,
} from '../api/models';
import { sceneRefs } from '../api/models';
import type { SceneRef } from '../api/models';
import { navigateTo, position } from './positionStore';
import { vbookStageLabel } from '../app/i18n';
import {
  applyAgentStatus, applyAnalysisEvent, analysisOverallPercent as analysisOverallPercentDomain,
  computeProgressRows as computeProgressRowsDomain, createAnalyzingVBookProgress,
  createGenerationTimer, createIdleVBookProgress, createInitialAnalysisProgress,
  createProgressTrackingState, elapsedSeconds, formatTimerText,
  hasAnyProgress as hasAnyProgressDomain, resetProgressTracking, routeProgressEvent,
  startGenerationTimer, stopGenerationTimer,
} from './generationProgress';
import type {
  AgentStatusLike, AnalysisProgress, AnalysisStatus, AnalysisTaskRow,
  GenerationTimerState, ProgressEventSink, ProgressPanelState, ProgressTrackingState,
  TaskLabels, TaskRow, VBookProgress, VBookStage,
} from './generationProgress';

export type GenerationStatus = 'IDLE' | 'RUNNING' | 'ERROR' | 'SUCCESS';
export type { VBookStage };

// Re-export (playbackStore imports SceneRef from this module; single source of
// truth lives in api/models.ts).
export type { SceneRef };
export interface PlaybackPrepared {
  bookId: string;
  buildId: string;
  scenes: SceneRef[];
  coverImage?: Blob;
  softRefresh?: boolean;
}

export const bookId = signal('');
export const buildId = signal('');
export const generationStatus = signal<GenerationStatus>('IDLE');
/** Set to true after createBlankBook() succeeds, cleared when the user
 *  navigates to AI or dismisses the bubble. Used by the toolbar AI helper
 *  bubble to show contextual onboarding once. */
export const blankBookJustCreated = signal(false);

// Replays the `playbackPrepared` SharedFlow from MainActivity coordinator.
const playbackPreparedListeners = new Set<(prep: PlaybackPrepared) => void>();

export function onPlaybackPrepared(fn: (prep: PlaybackPrepared) => void): () => void {
  playbackPreparedListeners.add(fn);
  return () => {
    playbackPreparedListeners.delete(fn);
  };
}
export function emitPlaybackPrepared(prep: PlaybackPrepared): void {
  playbackPreparedListeners.forEach((f) => f(prep));
}

// ── Nav-icon generation status (MainActivity.updateNavIconStatus port) ──
// SUCCESS is self-clearing: pulse green ~12s (8 × 1.5s), hold solid green ~10s,
// then auto-reset to IDLE — matching Android's finite pulse animator + the
// autoResetJob delay(1500*8 + 10_000) in updateNavIconStatus.
const SUCCESS_PULSE_MS = 12_000;
const SUCCESS_HOLD_MS = 10_000;
const SUCCESS_TOTAL_MS = SUCCESS_PULSE_MS + SUCCESS_HOLD_MS;
let navStatusTimer: ReturnType<typeof setTimeout> | null = null;
let navWatchdog: ReturnType<typeof setInterval> | null = null;
/** Wall-clock time of the last SUCCESS set. The auto-reset deadline is anchored
 *  to this timestamp (not to "now" at each arming), so tab-switch navigation or
 *  a re-armed one-shot timer can never push the SUCCESS → IDLE transition
 *  indefinitely into the future. */
let successSince = 0;

function clearNavStatusTimer(): void {
  if (navStatusTimer != null) {
    clearTimeout(navStatusTimer);
    navStatusTimer = null;
  }
}

function armNavResetTimer(): void {
  clearNavStatusTimer();
  navStatusTimer = setTimeout(() => {
    navStatusTimer = null;
    if (generationStatus.value === 'SUCCESS') resetGenerationStatus();
  }, SUCCESS_TOTAL_MS);
}

/** Self-healing SUCCESS watchdog: even if the one-shot timer above is cleared
 *  or throttled, the icon returns to IDLE within ~1s after the 22s pulse+hold
 *  window elapsed (foreground; in a background tab browsers clamp intervals, so
 *  it self-heals as soon as timers resume — exactly when the user can see the
 *  icon again). The green indicator can never be left stuck. */
function ensureNavWatchdog(): void {
  if (navWatchdog != null) return;
  navWatchdog = setInterval(() => {
    if (generationStatus.value !== 'SUCCESS') return;
    if (Date.now() - successSince >= SUCCESS_TOTAL_MS) resetGenerationStatus();
  }, 1000);
}

function setGenerationStatus(status: GenerationStatus): void {
  clearNavStatusTimer();
  generationStatus.value = status;
  if (status === 'SUCCESS') {
    successSince = Date.now();
    armNavResetTimer();
    ensureNavWatchdog();
  } else {
    successSince = 0;
    // Watchdog is only needed while SUCCESS is on screen; stop it when the
    // status leaves SUCCESS so it is not left ticking forever in the module.
    if (navWatchdog != null) {
      clearInterval(navWatchdog);
      navWatchdog = null;
    }
  }
}

export function resetGenerationStatus(): void { setGenerationStatus('IDLE'); }

// ── Persisted book session (localStorage) ──
// The open book survives a page reload / app restart: loadBook() writes it,
// closeBook() clears it, and restoreBookSession() (called from main.tsx on
// boot) re-validates it against the server and falls back to the most recent
// server book (GET /api/v1/books) — so a book imported on another device (e.g.
// the web app) shows up here too. Mirrors SharedPreferences bookId/buildId on
// Android (GenerateViewModel.persistBookId).
const BOOK_STORE_KEY = 'animastor:currentBook';

function persistBookSession(id: string, build: string): void {
  try {
    localStorage.setItem(BOOK_STORE_KEY, JSON.stringify({ id, build }));
  } catch { /* storage unavailable */ }
}
function clearBookSession(): void {
  try { localStorage.removeItem(BOOK_STORE_KEY); } catch { /* ignore */ }
}

// ── Per-user session stash (logout/login isolation) ──
// The live session belongs to whoever is currently viewing. Logging out must
// never leak the previous authenticated user's open book into the anonymous /
// guest context, so the session is stashed under a user-scoped key and the
// live key is cleared. The stash lets the SAME user get their book back on
// next login (book ownership in the DB is untouched).
function userStashKey(userId: string): string {
  return `${BOOK_STORE_KEY}:user:${userId}`;
}

/** Logout: stash the current book session for `userId` and clear the live
 *  session + open-book signals. No-op stash when nothing is open. */
export function stashBookSessionForUser(userId: string | null | undefined): void {
  const raw = (() => { try { return localStorage.getItem(BOOK_STORE_KEY); } catch { return null; } })();
  if (userId) {
    try {
      if (raw) localStorage.setItem(userStashKey(userId), raw);
      else localStorage.removeItem(userStashKey(userId));
    } catch { /* storage unavailable */ }
  }
  loadBook('', '');
}

/** Login: re-attach the book session this user had open before their last
 *  logout, unless a live session already exists (never clobber a newer one). */
export function restoreStashedBookSessionForUser(userId: string | null | undefined): void {
  if (!userId) return;
  try {
    if (localStorage.getItem(BOOK_STORE_KEY)) return;
    const raw = localStorage.getItem(userStashKey(userId));
    if (raw) localStorage.setItem(BOOK_STORE_KEY, raw);
  } catch { /* storage unavailable */ }
}

export function loadBook(id: string, build: string = ''): void {
  bookId.value = id;
  buildId.value = build;
  if (id) persistBookSession(id, build);
  else clearBookSession();
}

// ── Edit dirty indicator (GenerateViewModel.dirtySummary) ──
// Populated from the /regenerate response summary (server-computed book diff) and
// cleared on import/close — EditPage shows "Dirty: N changed…" while set.
export const dirtySummary = signal<DiffSummary | null>(null);
export function setDirtySummary(s: DiffSummary | null): void { dirtySummary.value = s; }

// ═══════════════════════════════════════════════════════════════
//  FILE SLICE SEAMS (audit blocker B1 split)
//  The File contour moved to state/fileStore.ts; the File flows still reset
//  generation internals that live in THIS module. Those internals are exposed
//  here as a narrow, documented surface — wired into fileStore by the
//  composition root (app/fileAdapters.ts). Nothing here changes generation
//  behavior. The old closeBook's player release (the File leg of the
//  generateStore ⇄ playbackStore cycle) is now an injected call through
//  fileStore's `player` seam — this module no longer imports playbackStore.
// ═══════════════════════════════════════════════════════════════

/** Full generation-session teardown used by fileStore.closeBook: stops the
 *  SSE progress stream + wall-clock timer, invalidates the VBook agent poll,
 *  clears in-flight worker tracking and the nav-icon generation status.
 *  (Previously inlined in the File-slice closeBook.) */
export function stopGenerationSession(): void {
  vbookPollToken++;
  stopProgressStream();
  stopTimer();
  setGenerationStatus('IDLE');
  resetProgressState();
}

/** Mirror isRegenerating (File open flows reset it before a new transition). */
export function setRegenerating(v: boolean): void { isRegenerating.value = v; }

/** Invalidate an in-flight VBook agent poll (module-scope token bump — the
 *  poller aborts on token mismatch; used by every File open flow). */
export function bumpVBookPollToken(): void { vbookPollToken++; }

/** Mark the SSE import_complete handshake as not-yet-received so a stale
 *  latch from the previous import can't instantly finish the next poll. */
export function markImportIncomplete(): void { progressTracking.importCompleteReceived = false; }

// ═══════════════════════════════════════════════════════════════
//  SHARED BOOK-SESSION STATUS (audit B6 — single source of truth)
//  `phase`/`errorMessage` are written by BOTH slices: the File flows
//  (now in state/fileStore.ts — LOADING_BOOK / IMPORTING_TXT / SCENE_READY /
//  IDLE + error) and the generation slice below (GENERATING on restore,
//  SCENE_READY on build finish, IDLE on cancel). AppShell reads `phase` as the
//  desktop bounce mirror, GeneratePage mirrors it too. The signals stay HERE;
//  fileStore writes them through the injected session seam — never a fork.
// ═══════════════════════════════════════════════════════════════

export type PlayerPhase =
  | 'IDLE' | 'LOADING_BOOK' | 'GENERATING' | 'DOWNLOADING'
  | 'SCENE_READY' | 'PLAYING' | 'PAUSED' | 'IMPORTING_TXT';

export const phase = signal<PlayerPhase>('IDLE');
export const errorMessage = signal<string | null>(null);

// ═══════════════════════════════════════════════════════════════
//  GENERATE SCREEN STATE (stage 4) — 1:1 with GenerateViewModel
//  uiState (GenUiState), isRegenerating, timer, layer config
// ═══════════════════════════════════════════════════════════════

export type { VBookProgress, TaskRow, TaskLabels, ProgressPanelState, AgentStatusLike };

export const vbookProgress = signal<VBookProgress>(createIdleVBookProgress());
export const isRegenerating = signal(false);

// ── Parallel AI Analysis per-task progress (Milestone #2) ──
// One row per AI analysis task (characters / locations / voices).
// The orchestrator emits { type:'analysis', task, status, ... } events
// over the existing SSE channel; this signal mirrors the orchestrator's
// view of the world so the UI can render one row per task with its
// own timer + status. resetAnalysisProgress() wipes the signal — called
// on cancel / new generation / book close.
//
// Wire contract is intentionally minimal: each row records its status
// and startedAt / finishedAt timestamps (epoch ms). duration_ms from
// the orchestrator is the final authoritative value when a task ends
// (the orchestrator computes it on the backend clock).
//
// The state machine itself is pure domain logic in
// state/generationProgress/analysis.ts; this section keeps only the
// host signal + the reset wrapper (the domain exposes the factory).
export type { AnalysisStatus, AnalysisTaskRow, AnalysisProgress };

/** Pure per-task analysis transition (domain fn — previously inline here).
 *  Re-exported to keep the store's public surface stable; the implementation
 *  and its unit tests live in state/generationProgress/analysis.ts. */
export { applyAnalysisEvent };

export const vbookAnalysisProgress = signal<AnalysisProgress>(createInitialAnalysisProgress());

/** Reset to a fresh empty state. Idempotent. */
export function resetAnalysisProgress(): void {
  vbookAnalysisProgress.value = createInitialAnalysisProgress();
}

/** Aggregate health flag for the overall row (domain fn re-exported
 *  for the existing host consumers; tests live in generationProgress/). */
export function analysisOverallPercent(p: AnalysisProgress): number {
  return analysisOverallPercentDomain(p);
}

// ── Layer config (GenerateFragment toggle chips) ──
export const vbookEnabled = signal(true);
export const audioEnabled = signal(true);
export const imageEnabled = signal(true);
export const videoEnabled = signal(true);
export const layerConfigLoaded = signal(false);
export const hasAssets = signal(false);

// ── Parallel / Subagent AI Analysis (Milestone #2) ──
// analysisMode governs the orchestrator path the backend uses for the
// first AI phase (characters + locations). Defaults to 'sequential' so
// every existing book / user keeps legacy behaviour until the Settings
// page opts them in. analysisParallelism caps the number of concurrent
// LLM requests the orchestrator will dispatch (1..8). Both are sourced
// from /book/:id/layer-config on every loadLayerConfig call and from
// /agent-status on every progress poll so the Generate page always
// reflects the live backend decision.
export const analysisMode = signal<'sequential' | 'parallel'>('sequential');
export const analysisParallelism = signal<number>(3);
export const analysisConfigLoaded = signal(false);

export function setVBookEnabled(v: boolean): void { vbookEnabled.value = v; void persistLayerConfig(); }
export function setAudioEnabled(v: boolean): void { audioEnabled.value = v; void persistLayerConfig(); }
export function setImageEnabled(v: boolean): void { imageEnabled.value = v; void persistLayerConfig(); }
export function setVideoEnabled(v: boolean): void { videoEnabled.value = v; void persistLayerConfig(); }

export async function loadLayerConfig(): Promise<void> {
  const currentBook = bookId.value;
  if (!currentBook) { layerConfigLoaded.value = true; analysisConfigLoaded.value = true; return; }
  try {
    const cfg = await getJson<LayerConfigResponse>(`/book/${encodeURIComponent(currentBook)}/layer-config`);
    audioEnabled.value = cfg.audio_enabled;
    imageEnabled.value = cfg.image_enabled;
    videoEnabled.value = cfg.video_enabled;
    vbookEnabled.value = cfg.vbook_enabled;
    // Milestone #2 — backend authoritative. Defaults match layer-config
    // DEFAULTS on the server (sequential, parallelism=3) so a missing
    // field doesn't flip the UI to a non-default value.
    analysisMode.value = cfg.analysis_mode === 'parallel' ? 'parallel' : 'sequential';
    const p = cfg.analysis_parallelism;
    if (typeof p === 'number' && Number.isFinite(p)) {
      analysisParallelism.value = Math.min(8, Math.max(1, p));
    }
  } catch (e) {
    console.warn('loadLayerConfig failed:', (e as Error).message);
  }
  layerConfigLoaded.value = true;
  analysisConfigLoaded.value = true;
}

async function persistLayerConfig(): Promise<void> {
  const currentBook = bookId.value;
  if (!currentBook) return;
  try {
    await putJson(`/book/${encodeURIComponent(currentBook)}/layer-config`, {
      audio_enabled: audioEnabled.value,
      image_enabled: imageEnabled.value,
      video_enabled: videoEnabled.value,
      vbook_enabled: vbookEnabled.value,
    });
  } catch (e) {
    console.warn('persistLayerConfig failed:', (e as Error).message);
  }
}

export async function refreshAssetsState(): Promise<void> {
  const currentBook = bookId.value;
  if (!currentBook) { hasAssets.value = false; return; }
  try {
    const s = await getJson<AssetsStateResponse>(`/book/${encodeURIComponent(currentBook)}/assets-state`);
    hasAssets.value = s.has_assets ?? false;
  } catch (e) {
    console.warn('refreshAssetsState failed:', (e as Error).message);
  }
}

// ── Generation timer (wall-clock; Android: timerStartedAt/finalElapsedSeconds) ──
// Explicit state object (generationProgress/timer.ts) — the host owns ONE
// instance; all computation lives in the domain module.
const generationTimer: GenerationTimerState = createGenerationTimer();

export function getTimerStartedAt(): number { return generationTimer.startedAt; }
export function getFinalElapsedSeconds(): number { return generationTimer.finalElapsedSeconds; }
export { formatTimerText };
export function liveElapsedSeconds(): number { return elapsedSeconds(generationTimer); }

function startTimer(): void {
  startGenerationTimer(generationTimer);
}
function stopTimer(): void {
  stopGenerationTimer(generationTimer);
}

// ── Worker progress panel tracking (computeProgressRows state) ──
// Explicit state object (generationProgress/progressRows.ts): the previously
// module-scope Maps (taskReadyFloor/taskCompletedAt/taskFrozenElapsed) and
// latches (generationCompleted/newGenerationPending/importCompleteReceived)
// live here — passed into every domain computeProgressRows call.
const progressTracking: ProgressTrackingState = createProgressTrackingState();

/** Clear in-flight generation tracking (GenerateViewModel.resetProgressState).
 *  Used by the Settings clear-storyboard flow — the book stays open, only the
 *  progress-panel tracking and playback state are reset. */
export function resetProgressState(): void {
  resetProgressTracking(progressTracking);
}

function hasAnyProgress(): boolean {
  return hasAnyProgressDomain(progressTracking);
}

/**
 * Build the progress panel state from server-computed worker list + local VBook
 * (port of GenerateViewModel.computeProgressRows — the pure computation lives
 * in generationProgress/progressRows.ts). This host wrapper binds the shared
 * session state (progressTracking + generationTimer), reads the host signals
 * at call time, and routes the finalize/idle side effects to this store. No
 * behavior change: the wiring is 1:1 with the previous inline implementation.
 */
export function computeProgressRows(
  panel: ProgressPanelResponse | null,
  vbookProg: VBookProgress | null,
  labels: TaskLabels
): ProgressPanelState {
  return computeProgressRowsDomain({
    tracking: progressTracking,
    timer: generationTimer,
    now: Date.now(),
    vbookStage: vbookProgress.value.stage,
    isRunning: generationStatus.value === 'RUNNING',
    vbookStageLabel,
    setRegenerating: (v) => { isRegenerating.value = v; },
    onGenerationFinalized: () => {
      stopProgressStream();
      if (vbookProg?.stage === 'COMPLETED') {
        vbookProgress.value = { ...vbookProgress.value, stage: 'IDLE' };
      }
      setGenerationStatus('SUCCESS');
      isRegenerating.value = false;
      void applyGenerationResults();
    },
    onRunningIdle: () => { setGenerationStatus('IDLE'); },
  }, panel, vbookProg, labels);
}

// ── VBook agent status → structured VBookProgress ──
// (pure mapping lives in generationProgress/vbookProgress.ts applyAgentStatus)
function updateVBookProgress(status: AgentStatusLike): void {
  vbookProgress.value = applyAgentStatus(vbookProgress.value, status);
}

/** Poll /agent-status once and update vbookProgress (checkVBookAgentStatus). */
export async function checkVBookAgentStatus(): Promise<VBookProgress> {
  const bid = bookId.value;
  if (!bid) return vbookProgress.value;
  try {
    const status = await getJson<{
      active: boolean; session_status?: string | null; progress_msg?: string | null; step_type?: string | null;
      window_total_scenes?: number | null; window_size?: number | null;
      window_scene_index?: number | null; created_scenes?: number | null;
      window_start_scene?: number | null; total_scenes?: number | null; window_index?: number | null;
    }>(`/book/${encodeURIComponent(bid)}/agent-status`);
    // 'paused' = the CURRENT window finished and the agent is idle, waiting for
    // the user to press "Генерировать далее" (manual continuation) — that is a
    // terminal state for this window, so it counts as inactive and finalizes
    // COMPLETED with the real window counter (e.g. "3/3", not "1/1").
    if (status.active && status.progress_msg != null) {
      updateVBookProgress(status);
    } else if (!status.active) {
      const current = vbookProgress.value;
      if (current.stage === 'ANALYZING' || current.stage === 'CREATING_SCENES') {
        // The agent just finished — re-read the now-saved window counters
        // (window_total_scenes from window_data) before marking COMPLETED, so
        // the final counter reflects the real window size (e.g. "3/3", or
        // "2/2" for a partial final window), not the mid-pipeline estimate.
        if (status.progress_msg != null) updateVBookProgress(status);
        vbookProgress.value = { ...vbookProgress.value, stage: 'COMPLETED' };
      }
    }
  } catch { /* keep current */ }
  return vbookProgress.value;
}

export function clearVBookProgress(): void {
  vbookProgress.value = createIdleVBookProgress();
  // Parallel AI Analysis (Milestone #2): clear per-task rows in lockstep
  // with the legacy signal so a new generation / re-open never shows stale
  // per-task rows from the previous run. resetAnalysisProgress() is
  // idempotent — safe to call here even when the analysis signal was never
  // touched (e.g. sequential mode).
  resetAnalysisProgress();
}

// ═══════════════════════════════════════════════════════════════
//  SSE PROGRESS STREAM (ProgressStream.kt equivalent)
//  Advisory push channel; the 1.5s progress-panel poll reconciles.
// ═══════════════════════════════════════════════════════════════

let sseController: AbortController | null = null;
let sseEpoch = 0;

export function startProgressStream(bId: string): void {
  stopProgressStream();
  if (!bId) return;
  const epoch = ++sseEpoch;
  const controller = new AbortController();
  sseController = controller;
  void runProgressStream(bId, epoch, controller);
}

export function stopProgressStream(): void {
  sseEpoch++;
  sseController?.abort();
  sseController = null;
}

async function runProgressStream(bId: string, epoch: number, controller: AbortController): Promise<void> {
  let attempt = 0;
  while (epoch === sseEpoch && !controller.signal.aborted) {
    try {
      for await (const ev of sse(`/book/${encodeURIComponent(bId)}/progress-stream`, controller.signal)) {
        if (epoch !== sseEpoch) return;
        if (ev.data) handleProgressEvent(ev.data);
      }
      // Stream closed — reconnect (server keeps it open; close = drop).
    } catch { /* will retry below */ }
    if (epoch !== sseEpoch || controller.signal.aborted) return;
    const delayMs = Math.min(15_000, 1000 * (1 << Math.min(attempt, 4)));
    attempt++;
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

// Analysis/progress SSE event routing (JSON parse + dispatch) lives in
// generationProgress/sseRouting.ts routeProgressEvent; this host adapter
// binds it to the store signals + the shared tracking state's
// importCompleteReceived latch. Malformed payloads are dropped silently.
const progressEventSink: ProgressEventSink = {
  getAnalysisProgress: () => vbookAnalysisProgress.value,
  setAnalysisProgress: (p) => { vbookAnalysisProgress.value = p; },
  setVBookProgress: (p) => { vbookProgress.value = p; },
};

function handleProgressEvent(data: string): void {
  routeProgressEvent(progressEventSink, progressTracking, data);
}

// ═══════════════════════════════════════════════════════════════
//  GENERATION ACTIONS (GenerateViewModel equivalents)
// ═══════════════════════════════════════════════════════════════

export interface GenerationRequest {
  workerTypes: string[];
  scope: string;
  chapterId: string | null;
  sceneId: string | null;
}
export type GenerationResult =
  | { ok: true; dirty: number; scope: string }
  | { ok: false; message: string };

export async function startGeneration(req: GenerationRequest): Promise<GenerationResult> {
  const bId = bookId.value;
  if (!bId) return { ok: false, message: 'No book' };
  setGenerationStatus('RUNNING');
  isRegenerating.value = true;
  progressTracking.newGenerationPending = true;
  if (generationTimer.startedAt <= 0) startTimer();
  startProgressStream(bId);
  try {
    const res = await postJson<RegenerateResponse>(`/book/${encodeURIComponent(bId)}/regenerate`, {
      rebuild_all: true,
      worker_types: req.workerTypes,
      scope: req.scope,
      chapter_id: req.chapterId,
      scene_id: req.sceneId,
    });
    if (res.build_id) buildId.value = res.build_id;
    phase.value = 'SCENE_READY';
    dirtySummary.value = res.summary ?? null;
    const dirty = res.dirty_scenes?.length ?? 0;
    void refreshAssetsState();
    return { ok: true, dirty, scope: res.scope ?? req.scope };
  } catch (e) {
    setGenerationStatus('ERROR');
    return { ok: false, message: (e as Error).message };
  }
}

let vbookPollToken = 0;

/** Start VBook AI-agent generation (bootstrap / bootstrap-next-window + poll). */
export async function startVBookGeneration(): Promise<void> {
  const bid = bookId.value;
  if (!bid) return;
  setGenerationStatus('RUNNING');
  // VBook is part of the same generation session as the GPU stages — mark the
  // session regenerating (mirrors startGeneration) so the shared wall-clock
  // timer is NOT stopped when the VBook agent finishes while audio/image/video
  // stages are still running (Android GenerateViewModel fix, 1:1 parity).
  isRegenerating.value = true;
  progressTracking.newGenerationPending = true;
  vbookProgress.value = createAnalyzingVBookProgress();
  // Manual per-window mode: one click = one window = one generation. The timer
  // always starts fresh for the new window (no survival across windows); the
  // previous window's finalise already stopped it.
  startTimer();
  startProgressStream(bid);
  progressTracking.importCompleteReceived = false;
  const token = ++vbookPollToken;
  try {
    const status = await getJson<BookStatus>(`/book/${encodeURIComponent(bid)}/status`).catch(() => null);
    const needsBootstrap = status?.ready !== true;
    // These routes BLOCK for the whole AI window (minutes) — a 30s default
    // timeout would abort them client-side while the backend keeps generating,
    // freezing the progress block and timer. Use the long timeout (15 min,
    // matching the Android OkHttp config).
    if (needsBootstrap) {
      await postJsonLong(`/book/${encodeURIComponent(bid)}/bootstrap`);
    } else {
      await postJsonLong(`/book/${encodeURIComponent(bid)}/bootstrap-next-window`);
    }
    await pollVBookProgress(bid, token);
  } catch (e) {
    if (token !== vbookPollToken) return;
    console.warn('startVBookGeneration failed:', (e as Error).message);
    // A client-side abort (timeout/network blip) does NOT stop the backend
    // agent — the bootstrap route keeps processing the window. Before tearing
    // the progress UI down, reconcile with the real agent state: if it is still
    // running, keep the block + timer alive and let the poller track it to
    // completion. Only tear down on a genuine failure (no active session).
    try {
      const status = await getJson<{ active: boolean; session_status?: string | null }>(`/book/${encodeURIComponent(bid)}/agent-status`);
      // Keep the UI alive if the agent is still running, or if the window
      // already finished (paused) — pollVBookProgress finalizes a paused
      // window immediately with the real counter (green "3/3").
      if (status.active || status.session_status === 'paused') {
        await pollVBookProgress(bid, token);
        return;
      }
    } catch { /* agent-status unavailable — fall through to teardown */ }
    clearVBookProgress();
    stopTimer();
  }
}

async function pollVBookProgress(bId: string, token: number): Promise<void> {
  let consecutiveInactive = 0;
  const maxInactive = 2;
  // Safety net against a stuck backend (agent-status reports active forever).
  // NOT a generation deadline: the loop terminates on its own once the agent
  // reports inactive twice. Long multi-window runs must never be cut short by
  // this cap, so it sits far above any realistic generation.
  const maxPollMs = 60 * 60 * 1000;
  const startTime = Date.now();
  let safetyCapTripped = false;
  while (consecutiveInactive < maxInactive) {
    if (token !== vbookPollToken) return;
    if (progressTracking.importCompleteReceived) {
      vbookProgress.value = { ...vbookProgress.value, stage: 'COMPLETED' };
      break;
    }
    if (Date.now() - startTime > maxPollMs) {
      safetyCapTripped = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
    if (token !== vbookPollToken) return;
    try {
      const status = await getJson<{
        active: boolean; session_status?: string | null; progress_msg?: string | null; step_type?: string | null;
        window_total_scenes?: number | null; window_size?: number | null;
        window_scene_index?: number | null; created_scenes?: number | null;
        window_start_scene?: number | null; total_scenes?: number | null; window_index?: number | null;
      }>(`/book/${encodeURIComponent(bId)}/agent-status`);
      // 'paused' = the current window is complete; the agent is idle, waiting
      // for the user to press "Генерировать далее" (manual continuation — one
      // window per click). Finalize this window immediately with the real
      // counter (e.g. "3/3") — never auto-advance to the next window.
      if (status.session_status === 'paused') {
        if (status.progress_msg != null) updateVBookProgress(status);
        vbookProgress.value = { ...vbookProgress.value, stage: 'COMPLETED' };
        break;
      }
      if (status.active && status.progress_msg != null) {
        consecutiveInactive = 0;
        updateVBookProgress(status);
      } else if (!status.active) {
        consecutiveInactive++;
        if (status.progress_msg != null) updateVBookProgress(status);
        if (consecutiveInactive >= maxInactive) {
          vbookProgress.value = { ...vbookProgress.value, stage: 'COMPLETED' };
        }
      } else {
        consecutiveInactive = 0;
      }
    } catch {
      consecutiveInactive++;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (token !== vbookPollToken) return;
  // If the safety cap tripped, probe the real agent state before deciding: a
  // still-running agent must NOT be finalised (SUCCESS + stopTimer would freeze
  // the timer mid-generation) — the 1.5s panel poll + checkVBookAgentStatus keep
  // tracking it. But if the agent actually finished (backend stuck reporting
  // active), finalise normally so the generation is not left dangling.
  if (safetyCapTripped) {
    console.warn('pollVBookProgress: safety cap reached — probing agent state');
    try {
      const status = await getJson<{ active: boolean }>(`/book/${encodeURIComponent(bId)}/agent-status`);
      if (!status.active) {
        vbookProgress.value = { ...vbookProgress.value, stage: 'COMPLETED' };
        setGenerationStatus('SUCCESS');
        if (!isRegenerating.value) stopTimer();
        await applyGenerationResults();
        return;
      }
    } catch { /* leave UI alive */ }
    console.warn('pollVBookProgress: agent still active after safety cap — leaving UI alive');
    return;
  }
  setGenerationStatus('SUCCESS');
  if (!isRegenerating.value) stopTimer();
  await applyGenerationResults();
}

/**
 * Apply whatever generation results are available — refresh the player with the
 * latest scenes (soft refresh). Port of applyGenerationResults: builds the scene
 * list from book JSON, emits playbackPrepared with softRefresh=true.
 * The cover bitmap is fetched by the playback coordinator (loadCoverIntoState)
 * on this soft refresh — the Android loadCoverBitmap equivalent — so a cover
 * that finishes generating replaces the theater-curtains fallback automatically.
 */
export async function applyGenerationResults(): Promise<void> {
  if (!isRegenerating.value) stopTimer();
  const bid = bookId.value;
  if (!bid) return;
  try {
    const bookData = await getJson<BookData>(`/book/${encodeURIComponent(bid)}`);
    const scenes = sceneRefs(bookData);
    if (scenes.length === 0) {
      console.warn('applyGenerationResults: book has 0 scenes — skipping playback refresh');
      return;
    }
    // Android parity (EditFragment.loadBookAndAutoPosition): a fresh generation
    // can finish with NO position selected — the RAW_IMPORTED book had no scenes
    // at import time, so importBookFromFile navigated to null. Without a position
    // the Edit screen would open empty (it only loads when chapterId+sceneId are
    // set). When nothing is selected yet, anchor the position at the very
    // beginning of the visual book (cover-first, same as importBookFromFile).
    if (!position.value.chapterId) {
      const first = scenes.find((s) => s.sceneType === 'cover') ?? scenes[0] ?? null;
      if (first) {
        navigateTo({ chapterId: first.chapterId, sceneId: first.sceneId, unitId: null, chunkId: null, unitIndex: 0 });
      }
    }
    emitPlaybackPrepared({ bookId: bid, buildId: buildId.value, scenes, softRefresh: true });
  } catch (e) {
    console.warn('applyGenerationResults failed:', (e as Error).message);
  }
}

/** Stop all generation (Stop All button + cancelGeneration). */
export async function cancelGeneration(): Promise<void> {
  const bId = bookId.value;
  if (!bId) return;
  setGenerationStatus('IDLE');
  progressTracking.newGenerationPending = false;
  stopTimer();
  stopProgressStream();
  resetProgressState();
  vbookPollToken++;
  // Parallel AI Analysis (Milestone #2): when the user cancels mid-run,
  // any in-flight analysis rows must be frozen as 'cancelled' so the UI
  // stops spinning. Backend will publish a 'cancelled' SSE event for
  // each running task shortly after; here we proactively freeze the
  // timers by clearing the signal. New events from the orchestrator
  // will re-populate the signal on the next run.
  resetAnalysisProgress();
  try {
    await postJson(`/book/${encodeURIComponent(bId)}/cancel-generation`);
  } catch (e) {
    console.warn('cancelGeneration: backend call failed:', (e as Error).message);
  }
  isRegenerating.value = false;
  phase.value = 'IDLE';
  errorMessage.value = null;
  if (hasAnyProgress()) {
    await applyGenerationResults();
  }
}

/** Cancel a specific worker type or task (row stop / section stop). */
export async function cancelTask(type: string, taskId?: string | null): Promise<void> {
  const bId = bookId.value;
  if (!bId) return;
  if (type === 'vbook') {
    clearVBookProgress();
    vbookPollToken++;
  }
  try {
    await postJson(`/book/${encodeURIComponent(bId)}/cancel-worker`, {
      type,
      task_id: taskId ?? null,
    });
  } catch (e) {
    console.warn('cancelTask: backend call failed:', (e as Error).message);
  }
}

/**
 * On entering the Generate screen — restore UI state if active generation work
 * survived a backend restart (checkAndRestoreGenerationState). Called once,
 * ~2.5s after the page mounts (mirrors GenerateFragment's delayed call).
 */
export async function checkAndRestoreGenerationState(): Promise<void> {
  const currentBookId = bookId.value;
  if (!currentBookId) return;
  if (isRegenerating.value) return;
  try {
    const [panel, counts] = await Promise.all([
      getJson<ProgressPanelResponse>(`/book/${encodeURIComponent(currentBookId)}/progress-panel`),
      getJson<WorkerCounts>('/worker/counts'),
    ]);
    const hasActiveGpuTasks = panel.any_incomplete;
    const hasActiveWorkers = hasActiveGpuTasks || (counts.active_vbook ?? 0) > 0;
    if (hasActiveWorkers) {
      console.log('checkAndRestoreGenerationState: active workers found — restoring generation state');
      isRegenerating.value = hasActiveGpuTasks;
      setGenerationStatus('RUNNING');
      if (generationTimer.startedAt <= 0) startTimer();
      startProgressStream(currentBookId);
      resetProgressState();
      phase.value = 'GENERATING';
    }
  } catch (e) {
    console.warn('checkAndRestoreGenerationState failed:', (e as Error).message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  FILE SLICE SEAMS (audit blocker B1 split — see the section above
//  "FILE SLICE SEAMS" near the top of this file for the contract).
//  importBookFromFile / openBookById / closeBook / createBlankBook /
//  restoreBookSession and the File screen bookkeeping signals
//  (importMessages/isExporting/exportProgress/navigationEvent) now live in
//  state/fileStore.ts. Shared state (bookId/buildId/phase/errorMessage +
//  the persisted session) stays HERE as the single source of truth; fileStore
//  writes it through the seams wired in app/fileAdapters.ts.
// ═══════════════════════════════════════════════════════════════
