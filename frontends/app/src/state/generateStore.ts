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
// IDENTITY PACKAGE EXTRACTION (web-generator-extraction-audit.md §21, Step
// 12): the identity contour — bookId/buildId signals, loadBook, the persisted
// session (localStorage write path + key constants), and the per-user
// stash/restore pair — is now PHYSICALLY OWNED by the
// @animastor/web-book-session package. This module RE-EXPORTS it 1:1 so every
// existing consumer (pages, adapters, main.tsx, authStore, fileStore seams,
// guards, tests) is untouched. buildId has two legal writers: loadBook
// (identity/file flows) and startGeneration via the controlled
// setGenerationBuildId adapter — no fork, one signal.
import { signal } from '@preact/signals';
import { getJson, postJson, postJsonLong, putJson, sse } from '../api/client';
import type {
  BookData, DiffSummary,
  ProgressPanelResponse, RegenerateResponse, WorkerCounts,
} from '../api/models';
import {
  loadLayerConfig as loadLayerConfigDomain,
  persistLayerConfig as persistLayerConfigDomain,
  getAssetsState,
} from '@animastor/web-generator-config';
import { sceneRefs } from '../api/models';
import type { SceneRef } from '../api/models';
import { navigateTo, position } from './positionStore';
import { vbookStageLabel } from '../app/i18n';
// ── Identity contour (owned by @animastor/web-book-session — re-exported 1:1) ──
// Single source of truth for book identity; this module is only a
// consumption/re-export surface so existing consumer imports keep resolving.
export {
  bookId, buildId, loadBook,
  stashBookSessionForUser, restoreStashedBookSessionForUser,
  setGenerationBuildId, readPersistedBookSession,
} from '@animastor/web-book-session';
export type { PersistedBookSession } from '@animastor/web-book-session';
import {
  bookId, buildId, setGenerationBuildId,
} from '@animastor/web-book-session';
import {
  applyAnalysisEvent, analysisOverallPercent as analysisOverallPercentDomain,
  computeProgressRows as computeProgressRowsDomain, createGenerationTimer, createIdleVBookProgress,
  createInitialAnalysisProgress, createProgressTrackingState, elapsedSeconds, formatTimerText,
  hasAnyProgress as hasAnyProgressDomain, resetProgressTracking,
  startGenerationTimer, stopGenerationTimer,
} from '@animastor/web-generator';
import {
  checkAgentStatus as checkVBookAgentStatusDomain,
  createVBookPollState,
  startVBookGeneration as startVBookGenerationDomain,
} from '@animastor/web-generator-vbook';
import type { VBookAgentPorts } from '@animastor/web-generator-vbook';
import type {
  AgentStatusLike, AnalysisProgress, AnalysisStatus, AnalysisTaskRow,
  GenerationTimerState, ProgressEventSink, ProgressPanelState, ProgressTrackingState,
  TaskLabels, TaskRow, VBookProgress, VBookStage,
} from '@animastor/web-generator';

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

// ── Persisted book session ──
// MOVED to @animastor/web-book-session (Step 12 physical extraction): the
// localStorage write path, the key constants, the stash pair, and the
// controlled setGenerationBuildId adapter all live there now. This store
// consumes identity through the package re-exports above — no inline copy
// remains in the host.

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

// VBook poll-session state (host-owned, explicit object). Declared before the
// seams because they bump the token; the full agent-ports composition that
// consumes it lives below (see "VBook agent lifecycle").
const vbookPollState = createVBookPollState();

/** Full generation-session teardown used by fileStore.closeBook: stops the
 *  SSE progress stream + wall-clock timer, invalidates the VBook agent poll,
 *  clears in-flight worker tracking and the nav-icon generation status.
 *  (Previously inlined in the File-slice closeBook.) */
export function stopGenerationSession(): void {
  vbookPollState.token++;
  stopProgressStream();
  stopTimer();
  setGenerationStatus('IDLE');
  resetProgressState();
}

/** Mirror isRegenerating (File open flows reset it before a new transition). */
export function setRegenerating(v: boolean): void { isRegenerating.value = v; }

/** Invalidate an in-flight VBook agent poll (poll-token bump on the explicit
 *  VBookPollState — the poller aborts on token mismatch; used by every File
 *  open flow). */
export function bumpVBookPollToken(): void { vbookPollState.token++; }

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
  const cfg = await loadLayerConfigDomain(
    { getBookId: () => bookId.value },
    { getJson, putJson },
  );
  if (cfg) {
    audioEnabled.value = cfg.audio_enabled;
    imageEnabled.value = cfg.image_enabled;
    videoEnabled.value = cfg.video_enabled;
    vbookEnabled.value = cfg.vbook_enabled;
    analysisMode.value = cfg.analysis_mode === 'parallel' ? 'parallel' : 'sequential';
    const p = cfg.analysis_parallelism;
    if (typeof p === 'number' && Number.isFinite(p)) {
      analysisParallelism.value = Math.min(8, Math.max(1, p));
    }
  }
  layerConfigLoaded.value = true;
  analysisConfigLoaded.value = true;
}

async function persistLayerConfig(): Promise<void> {
  await persistLayerConfigDomain(
    { getJson, putJson },
    bookId.value,
    {
      audio_enabled: audioEnabled.value,
      image_enabled: imageEnabled.value,
      video_enabled: videoEnabled.value,
      vbook_enabled: vbookEnabled.value,
    },
  );
}

export async function refreshAssetsState(): Promise<void> {
  const s = await getAssetsState(
    { getBookId: () => bookId.value },
    { getJson, putJson },
  );
  hasAssets.value = s?.has_assets ?? false;
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

// ── VBook agent lifecycle (host composition over @animastor/web-generator-vbook) ──
// The orchestration DECISIONS (bootstrap-vs-next-window, agent-status merge,
// paused/inactive/safety-cap terminal classification, stale-token aborts)
// physically live in packages/animastor-web-generator-vbook. THIS store is
// only the composition seam: it binds host-owned capabilities (identity
// getter, api/client transport, poll-token authority, signal reads/writes,
// timer + SSE stream starts) into the package's ports. The poll token
// authority is the explicit VBookPollState object declared with the File
// seams above — bumpVBookPollToken / stopGenerationSession / cancelTask
// write it; the package's loops read it through the poll contract.
const vbookAgentPorts: VBookAgentPorts = {
  identity: { getBookId: () => bookId.value },
  transport: { getJson, postJsonLong },
  poll: {
    getPollToken: () => vbookPollState.token,
    bumpPollToken: () => { return ++vbookPollState.token; },
  },
  state: {
    getVBookProgress: () => vbookProgress.value,
    setVBookProgress: (p) => { vbookProgress.value = p; },
    setGenerationStatus,
    getIsRegenerating: () => isRegenerating.value,
    setIsRegenerating: (v) => { isRegenerating.value = v; },
    setNewGenerationPending: (v) => { progressTracking.newGenerationPending = v; },
    setImportCompleteReceived: (v) => { progressTracking.importCompleteReceived = v; },
    getImportCompleteReceived: () => progressTracking.importCompleteReceived,
  },
  lifecycle: {
    startTimer,
    stopTimer,
    startStream: startProgressStream,
    onVBookCleared: clearVBookProgress,
    // Host-owned finalization leg (applyGenerationResults stays HERE):
    // fetch/extract final book state, position/anchor checks, navigation
    // decision, playback notification. The package decides WHEN the window
    // finalized; the host decides WHAT happens next.
    onGenerationFinalized: () => applyGenerationResults(),
  },
};

/** Poll /agent-status once and update vbookProgress (checkVBookAgentStatus). */
export async function checkVBookAgentStatus(): Promise<VBookProgress> {
  return checkVBookAgentStatusDomain(vbookAgentPorts);
}

/** Start VBook AI-agent generation (bootstrap / bootstrap-next-window + poll). */
export async function startVBookGeneration(): Promise<void> {
  await startVBookGenerationDomain(vbookAgentPorts);
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

import { runSseStream } from '@animastor/web-generator-sse';
import type { SseStreamPort } from '@animastor/web-generator-sse';

// Explicit host-owned stream state (Step 14 prep — see
// docs/architecture/web-generator-extraction-audit.md §23): the former
// module-scope pair (`let sseController` / `let sseEpoch`) is folded into ONE
// explicit object with a single owner. The shape is exactly what a future
// extraction would pass by reference. Epoch semantics are UNCHANGED:
// monotonic counter, bumped on every start/stop, compared by
// @animastor/web-generator-sse to detect stale sessions.
interface SseStreamState {
  controller: AbortController | null;
  epoch: number;
}
function createSseStreamState(): SseStreamState {
  return { controller: null, epoch: 0 };
}
const sseStream = createSseStreamState();

const sseStreamPort: SseStreamPort = {
  start(bId: string) {
    if (!sseStream.controller) sseStream.controller = new AbortController();
    return sse(`/book/${encodeURIComponent(bId)}/progress-stream`, sseStream.controller.signal);
  },
  stop() {
    sseStream.controller?.abort();
    sseStream.controller = null;
  },
};

export function startProgressStream(bId: string): void {
  stopProgressStream();
  if (!bId) return;
  ++sseStream.epoch;
  sseStream.controller = new AbortController();
  void runSseStream(
    sseStreamPort,
    () => sseStream.epoch,
    progressEventSink,
    progressTracking,
    bId,
  );
}

export function stopProgressStream(): void {
  sseStream.epoch++;
  sseStream.controller?.abort();
  sseStream.controller = null;
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
    if (res.build_id) setGenerationBuildId(res.build_id);
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

// ── Cancel: request vs local session teardown (Step 14 prep, §23) ──
// The future extracted cancel contour owns ONLY the backend cancellation
// request (transport). Everything else — signal writes, timer/stream teardown,
// poll-token invalidation — is LOCAL SESSION TEARDOWN and stays host
// composition. The navigation/playback bridge (applyGenerationResults) is NOT
// part of a future cancel contour: the host finalization leg runs after the
// request returns, exactly as before. Composition order is preserved
// (teardown → request → conditional finalization); the only micro-reorder is
// that isRegenerating/phase/errorMessage settle before the HTTP call instead
// of after it — same inputs, no cross-function state dependency.

/** Backend cancellation request ONLY (transport; no host-state writes). */
async function requestCancelGeneration(bId: string): Promise<void> {
  try {
    await postJson(`/book/${encodeURIComponent(bId)}/cancel-generation`);
  } catch (e) {
    console.warn('cancelGeneration: backend call failed:', (e as Error).message);
  }
}

/** Local session teardown ONLY (host state resets; no transport calls). */
function teardownGenerationSessionLocal(): void {
  setGenerationStatus('IDLE');
  progressTracking.newGenerationPending = false;
  stopTimer();
  stopProgressStream();
  resetProgressState();
  vbookPollState.token++;
  // Parallel AI Analysis (Milestone #2): when the user cancels mid-run,
  // any in-flight analysis rows must be frozen as 'cancelled' so the UI
  // stops spinning. Backend will publish a 'cancelled' SSE event for
  // each running task shortly after; here we proactively freeze the
  // timers by clearing the signal. New events from the orchestrator
  // will re-populate the signal on the next run.
  resetAnalysisProgress();
  isRegenerating.value = false;
  phase.value = 'IDLE';
  errorMessage.value = null;
}

/** Stop all generation (Stop All button). Composition: local teardown →
 *  backend cancel request → host finalization (navigation/playback bridge —
 *  deliberately NOT owned by the request leg). */
export async function cancelGeneration(): Promise<void> {
  const bId = bookId.value;
  if (!bId) return;
  teardownGenerationSessionLocal();
  await requestCancelGeneration(bId);
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
    vbookPollState.token++;
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
