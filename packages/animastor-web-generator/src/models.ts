// Player-local vendored wire types for the generation-progress domain
// (the web-player models.ts precedent — docs/architecture/web-generator-extraction-audit.md §10).
//
// These are structural (NOT nominal) — they mirror the subset of api/models
// types that the generation-progress domain reads. The host passes the real
// wire payloads through the ProgressEventSink / ProgressRowContext contracts;
// TypeScript enforces structural compatibility without the package importing
// the host's api/models module. Any drift from the api/models shapes is
// rejected at the host adapter bridge.

/** GET /book/{id}/progress-panel — ProgressPanelResponse (api/models.ts:540). */
export interface ProgressPanelResponse {
  book_id?: string | null;
  tasks: ProgressTask[];
  overall_percent: number;
  any_incomplete: boolean;
}

/** ProgressTask row within ProgressPanelResponse (api/models.ts:547). */
export interface ProgressTask {
  task_id?: string | null;
  type: string;
  scope: string;
  chapter_id?: string | null;
  scene_id?: string | null;
  scene_label?: string | null;
  chapter_label?: string | null;
  end_scene_label?: string | null;
  end_chapter_label?: string | null;
  target_count: number;
  started_at?: number | null;
  ready: number;
  total: number;
  percent: number;
  done: boolean;
  visible: boolean;
  indeterminate: boolean;
  cancelled: boolean;
}

/** SSE /book/{id}/progress-stream — ProgressEvent (api/models.ts:701).
 *  Mirrors the ProgressStream.kt JSON shape. snake_case fields are
 *  preserved as the server emits them; the handler reads the few it needs. */
export interface ProgressEvent {
  type?: string;
  layer?: string;
  chapterId?: string | null;
  sceneId?: string | null;
  ready?: number | null;
  // VBook fields (type == "vbook")
  stage?: string | null;
  scene_index?: number | null;
  total_scenes?: number | null;
  window_size?: number | null;
  window_scene_index?: number | null;
  window_total_scenes?: number | null;
  window_start_scene?: number | null;
  message?: string | null;
  // Parallel analysis fields (type == "analysis")
  task?: string | null;
  status?: string | null;
  completed_tasks?: number | null;
  failed_tasks?: number | null;
  total_tasks?: number | null;
  duration_ms?: number | null;
  error?: string | null;
  // analysis_parallel heartbeat (type == "vbook", stage == "analysis_parallel")
  analysis_completed?: number | null;
  analysis_failed?: number | null;
  analysis_total?: number | null;
  analysis_mode?: string | null;
}
