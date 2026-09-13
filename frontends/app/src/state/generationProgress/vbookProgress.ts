// ═══════════════════════════════════════════════════════════════
//  GENERATION-PROGRESS DOMAIN — VBook progress state + mappings
// ═══════════════════════════════════════════════════════════════
//  Step-1 domain slice of the web-generator extraction
//  (docs/architecture/web-generator-extraction-audit.md §4.3.1).
//  The structured VBookProgress shape the progress panel renders,
//  plus the two pure mappings that produce it: from SSE progress
//  events (state/generateStore.ts handleProgressEvent 'vbook' branch)
//  and from /agent-status polls (updateVBookProgress). Pure functions
//  of (event|status, prev) — no signals, no transport, no identity.
// ═══════════════════════════════════════════════════════════════

import type { ProgressEvent } from '../../api/models';

export type VBookStage = 'IDLE' | 'ANALYZING' | 'CREATING_SCENES' | 'COMPLETED';

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
  /** Human-readable PROGRESS_STAGES message from the backend (Russian fallback). */
  message: string | null;
  /** Machine stage id (SSE `stage` / agent-status `step_type`) — mapped to a
   *  localized status via vbookStageLabel; null when the backend didn't report one. */
  stepType: string | null;
}

/** Idle state (the host signal's initial value + clearVBookProgress reset). */
export function createIdleVBookProgress(): VBookProgress {
  return { stage: 'IDLE', sceneIndex: -1, scenesInWindow: 0, totalScenes: null, windowIndex: 0, message: null, stepType: null };
}

/** Fresh ANALYZING state at generation start (startVBookGeneration). */
export function createAnalyzingVBookProgress(): VBookProgress {
  return { stage: 'ANALYZING', sceneIndex: -1, scenesInWindow: 1, totalScenes: null, windowIndex: 0, message: null, stepType: null };
}

/** Map an SSE `vbook` progress event to a fresh VBookProgress (1:1 port of
 *  the non-heartbeat 'vbook' branch in generateStore.handleProgressEvent). */
export function vbookProgressFromEvent(ev: ProgressEvent): VBookProgress {
  const stage: VBookStage = ev.stage === 'creating_units' || ev.stage === 'creating_visuals'
    ? 'CREATING_SCENES' : 'ANALYZING';
  const windowTotal = Math.max(1, ev.window_total_scenes ?? ev.window_size ?? 1);
  const sceneIdx = ev.window_scene_index != null
    ? Math.min(Math.max(ev.window_scene_index - 1, 0), windowTotal - 1)
    : -1;
  const totalScenes = Math.max(1, ev.total_scenes ?? ev.scene_index ?? 1);
  return {
    stage,
    sceneIndex: sceneIdx,
    scenesInWindow: windowTotal,
    totalScenes,
    windowIndex: 0,
    message: ev.message?.trim() ? ev.message : null,
    stepType: ev.stage ?? null,
  };
}

/** Subset of /agent-status the mapping needs (AgentStatusResponse shape,
 *  narrowed to the fields updateVBookProgress reads). */
export interface AgentStatusLike {
  active?: boolean;
  session_status?: string | null;
  progress_msg?: string | null;
  step_type?: string | null;
  window_total_scenes?: number | null;
  window_size?: number | null;
  window_scene_index?: number | null;
  created_scenes?: number | null;
  window_start_scene?: number | null;
  total_scenes?: number | null;
  window_index?: number | null;
}

/** Merge an /agent-status poll into the current progress (1:1 port of
 *  generateStore.updateVBookProgress — near-pure: merges with prev). */
export function applyAgentStatus(prev: VBookProgress, status: AgentStatusLike): VBookProgress {
  const stage: VBookStage = status.step_type === 'create_units' || status.step_type === 'create_visual_prompts'
    ? 'CREATING_SCENES'
    : 'ANALYZING';
  const windowTotal = Math.max(1, status.window_total_scenes ?? status.window_size ?? 1);
  const windowSceneIndex = status.window_scene_index != null
    ? status.window_scene_index
    : status.created_scenes != null && status.window_start_scene != null
      ? Math.max(1, status.created_scenes - status.window_start_scene + 1)
      : null;
  const fallbackIdx = prev.sceneIndex;
  const sceneIndex = windowSceneIndex != null
    ? Math.min(windowSceneIndex - 1, windowTotal - 1)
    : fallbackIdx;
  const messageText = status.progress_msg?.trim() ? status.progress_msg : null;
  return {
    stage,
    sceneIndex,
    scenesInWindow: windowTotal,
    totalScenes: status.created_scenes ?? status.total_scenes ?? null,
    windowIndex: status.window_index ?? 0,
    message: messageText,
    // Preserve the last known stage id when agent-status reports none (between
    // steps / at window end the running-step lookup returns null) — otherwise
    // every poll would fall back to the backend's Russian progress message in
    // English UIs for a render cycle. The value is nulled on each new
    // generation start (startVBookGeneration), so it never leaks across runs.
    stepType: status.step_type ?? prev.stepType,
  };
}
