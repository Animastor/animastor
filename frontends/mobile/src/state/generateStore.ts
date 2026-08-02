// GenerateViewModel equivalent (stages 0/3/4). Holds bookId/buildId, generation
// status (RUNNING/ERROR/SUCCESS/IDLE), VBookStage, layer-config toggles, worker
// progress panel state (computeProgressRows), the generation timer, the SSE
// progress stream, and emits `playbackPrepared` which the playback coordinator
// (playbackStore.wirePlaybackCoordination) forwards to PlaybackViewModel.
// Stage 3 adds the File-screen slice of GenUiState (phase, importMessages,
// errorMessage), isExporting/exportProgress, and the unified import flow
// (importBookFromFile / openBookById / closeBook) with one-shot navigation events.
// Stage 4 adds the Generate screen slice: layer config, worker counts, VBook
// progress, task-aware progress panel, and generation start/cancel actions.
import { signal } from '@preact/signals';
import { getJson, postJson, postMultipart, putJson, sse } from '../api/client';
import type {
  AssetsStateResponse, BookData, BookStatus, ImportResponse, LayerConfigResponse,
  ProgressPanelResponse, ProgressTask, RegenerateResponse, WorkerCounts, ProgressEvent,
} from '../api/models';
import { sceneRefs } from '../api/models';
import type { SceneRef } from '../api/models';
import { navigateTo, clearPosition } from './positionStore';

export type GenerationStatus = 'IDLE' | 'RUNNING' | 'ERROR' | 'SUCCESS';
export type VBookStage = 'IDLE' | 'ANALYZING' | 'CREATING_SCENES' | 'COMPLETED';

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

export function resetGenerationStatus(): void { generationStatus.value = 'IDLE'; }
export function loadBook(id: string, build: string = ''): void {
  bookId.value = id;
  buildId.value = build;
}

// ═══════════════════════════════════════════════════════════════
//  FILE SCREEN STATE (stage 3) — 1:1 with the GenUiState slice
//  FileFragment consumes + GenerateViewModel.isExporting/exportProgress
// ═══════════════════════════════════════════════════════════════

export type PlayerPhase =
  | 'IDLE' | 'LOADING_BOOK' | 'GENERATING' | 'DOWNLOADING'
  | 'SCENE_READY' | 'PLAYING' | 'PAUSED' | 'IMPORTING_TXT';

export const phase = signal<PlayerPhase>('IDLE');
export const importMessages = signal<string[]>([]);
export const errorMessage = signal<string | null>(null);
export const isExporting = signal(false);
export const exportProgress = signal(0);

/** One-shot navigation request emitted by the import/deep-link flow
 *  (GenerateViewModel.NavigationEvent equivalent). Consumed by FilePage,
 *  which resets it — so a new import never double-navigates. */
export const navigationEvent = signal<'play' | 'generate' | null>(null);

export function setExporting(v: boolean): void {
  isExporting.value = v;
  if (!v) exportProgress.value = 0;
}
export function setExportProgress(v: number): void {
  exportProgress.value = v;
}

// ═══════════════════════════════════════════════════════════════
//  GENERATE SCREEN STATE (stage 4) — 1:1 with GenerateViewModel
//  uiState (GenUiState), isRegenerating, timer, layer config
// ═══════════════════════════════════════════════════════════════

export interface VBookProgress {
  stage: VBookStage;
  /** 0-based scene index within the current generated block; -1 = no scene yet. */
  sceneIndex: number;
  /** Backend-reported actual scene count for the current generated block. */
  scenesInWindow: number;
  /** Total scenes known so far across generated blocks (can grow). */
  totalScenes: number | null;
  /** Current window index (0-based). */
  windowIndex: number;
  /** Human-readable PROGRESS_STAGES message from the backend. */
  message: string | null;
}

export const vbookProgress = signal<VBookProgress>({
  stage: 'IDLE', sceneIndex: -1, scenesInWindow: 0, totalScenes: null, windowIndex: 0, message: null,
});

export const isRegenerating = signal(false);

// ── Layer config (GenerateFragment toggle chips) ──
export const vbookEnabled = signal(true);
export const audioEnabled = signal(true);
export const imageEnabled = signal(true);
export const videoEnabled = signal(true);
export const layerConfigLoaded = signal(false);
export const hasAssets = signal(false);

export function setVBookEnabled(v: boolean): void { vbookEnabled.value = v; void persistLayerConfig(); }
export function setAudioEnabled(v: boolean): void { audioEnabled.value = v; void persistLayerConfig(); }
export function setImageEnabled(v: boolean): void { imageEnabled.value = v; void persistLayerConfig(); }
export function setVideoEnabled(v: boolean): void { videoEnabled.value = v; void persistLayerConfig(); }

export async function loadLayerConfig(): Promise<void> {
  const currentBook = bookId.value;
  if (!currentBook) { layerConfigLoaded.value = true; return; }
  try {
    const cfg = await getJson<LayerConfigResponse>(`/book/${encodeURIComponent(currentBook)}/layer-config`);
    audioEnabled.value = cfg.audio_enabled;
    imageEnabled.value = cfg.image_enabled;
    videoEnabled.value = cfg.video_enabled;
    vbookEnabled.value = cfg.vbook_enabled;
  } catch (e) {
    console.warn('loadLayerConfig failed:', (e as Error).message);
  }
  layerConfigLoaded.value = true;
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
let timerStartedAt = 0;        // 0 = not running
let finalElapsedSeconds = 0;   // final value when stopped (-1)

export function getTimerStartedAt(): number { return timerStartedAt; }
export function getFinalElapsedSeconds(): number { return finalElapsedSeconds; }

function startTimer(): void {
  timerStartedAt = Date.now();
  finalElapsedSeconds = 0;
}
function stopTimer(): void {
  if (timerStartedAt > 0) finalElapsedSeconds = Math.floor((Date.now() - timerStartedAt) / 1000);
  timerStartedAt = -1;
}

// ── Worker progress panel tracking (computeProgressRows state) ──
const COMPLETED_TASK_DISPLAY_MS = 10_000;
const taskReadyFloor = new Map<string, number>();
const taskCompletedAt = new Map<string, number>();
const taskFrozenElapsed = new Map<string, number>();
let generationCompleted = false;
let newGenerationPending = false;
let importCompleteReceived = false;

function resetProgressState(): void {
  taskCompletedAt.clear();
  taskReadyFloor.clear();
  taskFrozenElapsed.clear();
  generationCompleted = false;
}

function hasAnyProgress(): boolean {
  return [...taskReadyFloor.values()].some((v) => v > 0) || taskCompletedAt.size > 0;
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

/**
 * Build the progress panel state from server-computed worker list + local VBook
 * (port of GenerateViewModel.computeProgressRows). Mutates module tracking
 * state (monotonic floor, 10s done-window, new-gen gate) and finalises the
 * generation (SUCCESS + playbackPrepared soft refresh) when all rows expire.
 */
export function computeProgressRows(
  panel: ProgressPanelResponse | null,
  vbookProg: VBookProgress | null,
  labels: TaskLabels
): ProgressPanelState {
  // NEW-GEN GATE: wait for actual new activity before showing stale 100% rows.
  if (newGenerationPending) {
    const hasVBook = vbookProg != null &&
      (vbookProg.stage === 'ANALYZING' || vbookProg.stage === 'CREATING_SCENES');
    const hasGpuActivity = panel?.tasks?.some((t) => !t.done && !t.cancelled && t.visible) === true;
    if (hasVBook || hasGpuActivity) {
      generationCompleted = false;
      newGenerationPending = false;
    } else {
      return { kind: 'hidden' };
    }
  }

  if (generationCompleted) return { kind: 'hidden' };

  const now = Date.now();
  const rows: TaskRow[] = [];

  const addFromServer = (sw: ProgressTask, label: string) => {
    if (sw.total <= 0) return;
    const taskKey = sw.task_id ?? `legacy:${sw.type}`;
    const ready = Math.max(sw.ready, taskReadyFloor.get(taskKey) ?? 0);
    taskReadyFloor.set(taskKey, ready);
    const done = sw.done || (ready >= sw.total && ready > 0);
    if (done && !sw.cancelled && !taskCompletedAt.has(taskKey)) taskCompletedAt.set(taskKey, now);
    const frozen = done && !taskFrozenElapsed.has(taskKey);
    const elapsedSeconds: number = done
      ? (taskFrozenElapsed.get(taskKey) ?? (timerStartedAt > 0 ? Math.floor((now - timerStartedAt) / 1000) : 0))
      : (timerStartedAt > 0 ? Math.floor((now - timerStartedAt) / 1000) : 0);
    if (frozen) taskFrozenElapsed.set(taskKey, elapsedSeconds);
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
    const vbookElapsed = timerStartedAt > 0 ? Math.floor((now - timerStartedAt) / 1000) : 0;
    if (vbookProg.stage === 'COMPLETED') {
      if (!taskCompletedAt.has('vbook')) taskCompletedAt.set('vbook', now);
      if (!taskFrozenElapsed.has('vbook')) taskFrozenElapsed.set('vbook', vbookElapsed);
      rows.push({
        taskId: 'vbook', type: 'vbook', label: labels.vbookLabel, scope: 'whole_book',
        chapterId: null, sceneId: null, sceneLabel: null, chapterLabel: null,
        endSceneLabel: null, endChapterLabel: null,
        ready: 1, total: 1, percent: 100, done: true, countText: null,
        indeterminate: false, cancelled: false,
        elapsedSeconds: taskFrozenElapsed.get('vbook') ?? vbookElapsed, frozen: true,
      });
    } else {
      const stageMsg = vbookProg.message?.trim() || null;
      const label = stageMsg || labels.vbookLabel;
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
    taskCompletedAt.clear();
    isRegenerating.value = false;
    return { kind: 'hidden' };
  }

  // ── No workers at all → Hidden ──
  if (rows.length === 0) {
    taskCompletedAt.clear();
    isRegenerating.value = false;
    return { kind: 'hidden' };
  }

  // ── Per-worker expiry: drop done rows whose 10s display window expired ──
  const filtered = rows.filter((row) => {
    if (row.done && !row.cancelled) {
      const taskKey = row.taskId ?? `legacy:${row.type}`;
      const completedAt = taskCompletedAt.get(taskKey);
      return !(completedAt != null && (now - completedAt) >= COMPLETED_TASK_DISPLAY_MS);
    }
    return true;
  });
  rows.length = 0;
  rows.push(...filtered);

  // ── All workers expired → finalise generation ──
  if (rows.length === 0) {
    generationCompleted = true;
    stopProgressStream();
    taskCompletedAt.clear();
    if (vbookProg?.stage === 'COMPLETED') {
      vbookProgress.value = { ...vbookProgress.value, stage: 'IDLE' };
    }
    generationStatus.value = 'SUCCESS';
    isRegenerating.value = false;
    void applyGenerationResults();
    return { kind: 'hidden' };
  }

  // Check if any worker is still active (non-done, non-cancelled)
  const anyActive = rows.some((r) => !r.done && !r.cancelled);
  if (!anyActive) {
    // All remaining workers done but still within the 10s display window
    return { kind: 'rows', rows };
  }

  isRegenerating.value = true;
  return { kind: 'rows', rows };
}

// ── VBook agent status → structured VBookProgress ──
function updateVBookProgress(status: { step_type?: string | null; window_total_scenes?: number | null; window_size?: number | null; window_scene_index?: number | null; created_scenes?: number | null; window_start_scene?: number | null; total_scenes?: number | null; window_index?: number | null; progress_msg?: string | null }): void {
  const stage: VBookStage = status.step_type === 'create_units' || status.step_type === 'create_visual_prompts'
    ? 'CREATING_SCENES'
    : 'ANALYZING';
  const windowTotal = Math.max(1, status.window_total_scenes ?? status.window_size ?? 1);
  const windowSceneIndex = status.window_scene_index != null
    ? status.window_scene_index
    : status.created_scenes != null && status.window_start_scene != null
      ? Math.max(1, status.created_scenes - status.window_start_scene + 1)
      : null;
  const fallbackIdx = vbookProgress.value.sceneIndex;
  const sceneIndex = windowSceneIndex != null
    ? Math.min(windowSceneIndex - 1, windowTotal - 1)
    : fallbackIdx;
  const messageText = status.progress_msg?.trim() ? status.progress_msg : null;
  vbookProgress.value = {
    stage,
    sceneIndex,
    scenesInWindow: windowTotal,
    totalScenes: status.created_scenes ?? status.total_scenes ?? null,
    windowIndex: status.window_index ?? 0,
    message: messageText,
  };
}

/** Poll /agent-status once and update vbookProgress (checkVBookAgentStatus). */
export async function checkVBookAgentStatus(): Promise<VBookProgress> {
  const bid = bookId.value;
  if (!bid) return vbookProgress.value;
  try {
    const status = await getJson<{
      active: boolean; progress_msg?: string | null; step_type?: string | null;
      window_total_scenes?: number | null; window_size?: number | null;
      window_scene_index?: number | null; created_scenes?: number | null;
      window_start_scene?: number | null; total_scenes?: number | null; window_index?: number | null;
    }>(`/book/${encodeURIComponent(bid)}/agent-status`);
    if (status.active && status.progress_msg != null) {
      updateVBookProgress(status);
    } else if (!status.active) {
      const current = vbookProgress.value;
      if (current.stage === 'ANALYZING' || current.stage === 'CREATING_SCENES') {
        vbookProgress.value = { ...current, stage: 'COMPLETED' };
      }
    }
  } catch { /* keep current */ }
  return vbookProgress.value;
}

export function clearVBookProgress(): void {
  vbookProgress.value = { stage: 'IDLE', sceneIndex: -1, scenesInWindow: 0, totalScenes: null, windowIndex: 0, message: null };
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

function handleProgressEvent(data: string): void {
  let ev: ProgressEvent;
  try { ev = JSON.parse(data); } catch { return; }
  if (ev.type === 'vbook') {
    const stage: VBookStage = ev.stage === 'creating_units' || ev.stage === 'creating_visuals'
      ? 'CREATING_SCENES' : 'ANALYZING';
    const windowTotal = Math.max(1, ev.window_total_scenes ?? ev.window_size ?? 1);
    const sceneIdx = ev.window_scene_index != null
      ? Math.min(Math.max(ev.window_scene_index - 1, 0), windowTotal - 1)
      : -1;
    const totalScenes = Math.max(1, ev.total_scenes ?? ev.scene_index ?? 1);
    vbookProgress.value = {
      stage,
      sceneIndex: sceneIdx,
      scenesInWindow: windowTotal,
      totalScenes,
      windowIndex: 0,
      message: ev.message?.trim() ? ev.message : null,
    };
  } else if (ev.type === 'generation_complete') {
    // A completion event belongs to one generation scope — the progress-panel
    // poll remains authoritative and finalises only after all workers are done.
  } else if (ev.type === 'import_complete') {
    importCompleteReceived = true;
  }
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
  generationStatus.value = 'RUNNING';
  isRegenerating.value = true;
  newGenerationPending = true;
  if (timerStartedAt <= 0) startTimer();
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
    const dirty = res.dirty_scenes?.length ?? 0;
    void refreshAssetsState();
    return { ok: true, dirty, scope: res.scope ?? req.scope };
  } catch (e) {
    generationStatus.value = 'ERROR';
    return { ok: false, message: (e as Error).message };
  }
}

let vbookPollToken = 0;

/** Start VBook AI-agent generation (bootstrap / bootstrap-next-window + poll). */
export async function startVBookGeneration(): Promise<void> {
  const bid = bookId.value;
  if (!bid) return;
  generationStatus.value = 'RUNNING';
  newGenerationPending = true;
  vbookProgress.value = { stage: 'ANALYZING', sceneIndex: -1, scenesInWindow: 1, totalScenes: null, windowIndex: 0, message: null };
  startTimer();
  startProgressStream(bid);
  importCompleteReceived = false;
  const token = ++vbookPollToken;
  try {
    const status = await getJson<BookStatus>(`/book/${encodeURIComponent(bid)}/status`).catch(() => null);
    const needsBootstrap = status?.ready !== true;
    if (needsBootstrap) {
      await postJson(`/book/${encodeURIComponent(bid)}/bootstrap`);
    } else {
      await postJson(`/book/${encodeURIComponent(bid)}/bootstrap-next-window`);
    }
    await pollVBookProgress(bid, token);
  } catch (e) {
    if (token !== vbookPollToken) return;
    console.warn('startVBookGeneration failed:', (e as Error).message);
    clearVBookProgress();
    stopTimer();
  }
}

async function pollVBookProgress(bId: string, token: number): Promise<void> {
  let consecutiveInactive = 0;
  const maxInactive = 2;
  const maxPollMs = 5 * 60 * 1000;
  const startTime = Date.now();
  while (consecutiveInactive < maxInactive) {
    if (token !== vbookPollToken) return;
    if (importCompleteReceived) {
      vbookProgress.value = { ...vbookProgress.value, stage: 'COMPLETED' };
      break;
    }
    if (Date.now() - startTime > maxPollMs) break;
    await new Promise((r) => setTimeout(r, 2000));
    if (token !== vbookPollToken) return;
    try {
      const status = await getJson<{
        active: boolean; progress_msg?: string | null; step_type?: string | null;
        window_total_scenes?: number | null; window_size?: number | null;
        window_scene_index?: number | null; created_scenes?: number | null;
        window_start_scene?: number | null; total_scenes?: number | null; window_index?: number | null;
      }>(`/book/${encodeURIComponent(bId)}/agent-status`);
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
  generationStatus.value = 'SUCCESS';
  if (!isRegenerating.value) stopTimer();
  await applyGenerationResults();
}

/**
 * Apply whatever generation results are available — refresh the player with the
 * latest scenes (soft refresh). Port of applyGenerationResults: builds the scene
 * list from book JSON, emits playbackPrepared with softRefresh=true.
 * Cover image loading is skipped on web — stage 7 wires cover into the player.
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
    emitPlaybackPrepared({ bookId: bid, buildId: buildId.value, scenes, softRefresh: true });
  } catch (e) {
    console.warn('applyGenerationResults failed:', (e as Error).message);
  }
}

/** Stop all generation (Stop All button + cancelGeneration). */
export async function cancelGeneration(): Promise<void> {
  const bId = bookId.value;
  if (!bId) return;
  generationStatus.value = 'IDLE';
  newGenerationPending = false;
  stopTimer();
  stopProgressStream();
  resetProgressState();
  vbookPollToken++;
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
      generationStatus.value = 'RUNNING';
      if (timerStartedAt <= 0) startTimer();
      startProgressStream(currentBookId);
      resetProgressState();
      phase.value = 'GENERATING';
    }
  } catch (e) {
    console.warn('checkAndRestoreGenerationState failed:', (e as Error).message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  UNIFIED IMPORT — POST /book/import (server-side format detection)
//  Mirrors GenerateViewModel.importBookFromFile: loads the book, emits
//  playbackPrepared, and requests navigation to Play/Generate depending on
//  format + scene list + asset availability.
// ═══════════════════════════════════════════════════════════════

export async function importBookFromFile(file: File): Promise<void> {
  // Reset worker tracking and vbook progress from a previous session, so two
  // progress bars never appear when re-opening a book.
  resetProgressState();
  clearVBookProgress();
  vbookPollToken++;
  isRegenerating.value = false;
  importCompleteReceived = false;
  phase.value = 'LOADING_BOOK';
  errorMessage.value = null;
  importMessages.value = [];
  navigationEvent.value = null;
  try {
    const res = await postMultipart<ImportResponse>('/book/import', file, 'file', file.name);
    const bId = res.book_id;
    loadBook(bId, res.build_id ?? '');
    const bookData = await getJson<BookData>(`/book/${encodeURIComponent(bId)}`).catch(() => null);
    const scenes = bookData ? sceneRefs(bookData) : [];
    const first = scenes.find((s) => s.sceneType === 'cover') ?? scenes[0] ?? null;
    navigateTo({ chapterId: first?.chapterId ?? null, sceneId: first?.sceneId ?? null, unitIndex: 0 });

    if (res.format === 'vbook') {
      // snapshot is a server-side convenience — non-fatal if it fails
      void postJson(`/book/${encodeURIComponent(bId)}/snapshot`).catch(() => {});
      emitPlaybackPrepared({ bookId: bId, buildId: buildId.value, scenes });
      phase.value = scenes.length ? 'SCENE_READY' : 'IDLE';
      navigationEvent.value = scenes.length ? 'play' : 'generate';
    } else {
      // TXT path — technical steps shown on the File screen (take(4))
      importMessages.value = ['✓ File selected', '✓ TXT read', '✓ Encoding detected', '✓ VBook structure created'];
      phase.value = 'IMPORTING_TXT';
      emitPlaybackPrepared({ bookId: bId, buildId: buildId.value, scenes });
      const assets = await getJson<AssetsStateResponse>(`/book/${encodeURIComponent(bId)}/assets-state`).catch(() => null);
      phase.value = scenes.length ? 'SCENE_READY' : 'IDLE';
      navigationEvent.value = scenes.length && assets?.has_assets ? 'play' : 'generate';
    }
  } catch (e) {
    phase.value = 'IDLE';
    errorMessage.value = (e as Error).message || 'Import failed';
  }
}

// ═══════════════════════════════════════════════════════════════
//  DEEP LINK — /file?book=<id> (or ?open=<id>)
//  Web equivalent of the .vbook ACTION_VIEW intent: the linked file is already
//  on the server, so we load it by id (GET /book/{id}) instead of uploading
//  bytes, then follow the same importBookFromFile navigation logic. §12.
// ═══════════════════════════════════════════════════════════════

export async function openBookById(param: string): Promise<void> {
  let id = decodeURIComponent(param).trim();
  // tolerate copy-pasted download URLs (…/book/<id>/download → last segment)
  if (id.includes('/')) id = id.split('/').filter(Boolean).pop() ?? id;
  if (!id) return;
  resetProgressState();
  clearVBookProgress();
  vbookPollToken++;
  isRegenerating.value = false;
  importCompleteReceived = false;
  phase.value = 'LOADING_BOOK';
  errorMessage.value = null;
  importMessages.value = [];
  navigationEvent.value = null;
  try {
    const bookData = await getJson<BookData>(`/book/${encodeURIComponent(id)}`);
    const bId = bookData.manifest?.book_id || id;
    loadBook(bId, bookData.manifest?.build_id || '');
    const scenes = sceneRefs(bookData);
    const first = scenes.find((s) => s.sceneType === 'cover') ?? scenes[0] ?? null;
    navigateTo({ chapterId: first?.chapterId ?? null, sceneId: first?.sceneId ?? null, unitIndex: 0 });
    emitPlaybackPrepared({ bookId: bId, buildId: buildId.value, scenes });
    const assets = await getJson<AssetsStateResponse>(`/book/${encodeURIComponent(bId)}/assets-state`).catch(() => null);
    phase.value = scenes.length ? 'SCENE_READY' : 'IDLE';
    navigationEvent.value = scenes.length && assets?.has_assets ? 'play' : 'generate';
  } catch (e) {
    phase.value = 'IDLE';
    errorMessage.value = (e as Error).message || 'Book not found';
  }
}

/** closeBook() — GenerateViewModel.closeBook equivalent (Create New Book card). */
export function closeBook(): void {
  vbookPollToken++;
  stopProgressStream();
  stopTimer();
  isRegenerating.value = false;
  generationStatus.value = 'IDLE';
  loadBook('', '');
  phase.value = 'IDLE';
  errorMessage.value = null;
  importMessages.value = [];
  navigationEvent.value = null;
  clearVBookProgress();
  clearPosition();
}
