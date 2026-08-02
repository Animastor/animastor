// Shared TS models — 1:1 with frontend/.../repository/{ConnectorModels,AiChatModels,
// ChatSessionModels,BookModels}.kt. Mapped when the consuming screen is implemented
// (per 04-MAPPING-TABLES §4). JSON field names use snake_case as served by backend.

// ─────────────────────────────────────────────────────
// Connectors
// ─────────────────────────────────────────────────────

export interface ConnectorSummary {
  name: string;
  label: string;
  type: string;
  workflow: string;
  status: string; // "compatible" | "incompatible" | "registered" | "unknown"
  version: string;
  description: string;
  enabled: boolean;
}

export interface ConnectorListResponse {
  connectors: ConnectorSummary[];
}

export interface ConnectorGroupedResponse {
  audio: ConnectorSummary[];
  image: ConnectorSummary[];
  video: ConnectorSummary[];
  unknown: ConnectorSummary[];
  audio_active_count: number;
  image_active_count: number;
  video_active_count: number;
}

export interface SubBinding {
  nodeId?: string | null;
  label?: string | null;
  entityType?: string | null;
  required?: boolean;
  arrayPosition?: number | null;
  expectedClass?: string | null;
  nodeClass?: string | null;
}

export interface BindingDef {
  nodeId?: string | null;
  field?: string | null;
  label: string;
  entityType?: string | null;
  required: boolean;
  dataType?: string | null;
  kind?: string | null;
  defaultValue?: unknown;
  min?: unknown;
  max?: unknown;
  type?: string | null; // "multi" for multi-bindings
  bindings?: SubBinding[] | null;
  expectedClass?: string | null;
  nodeClass?: string | null;
}

export interface GuideFieldDef {
  frameIdx?: string | null;
  strength?: string | null;
  imageSource?: string | null;
}

export interface GuideBinding {
  label: string;
  nodeId?: string | null;
  nodeClass?: string | null;
  fields?: GuideFieldDef | null;
}

export interface GuideNodes {
  nodeType: string;
  bindings: GuideBinding[];
}

export interface ConnectorDetail {
  name: string;
  workflow: string;
  workflowHash?: string | null;
  label: string;
  description: string;
  type: string;
  version: string;
  metadata?: Record<string, unknown> | null;
  inputs: Record<string, BindingDef>;
  outputs: Record<string, BindingDef>;
  parameters: Record<string, BindingDef>;
  guideNodes?: GuideNodes | null;
  hasGuideNodes: boolean;
}

export interface CompatibilityStatus {
  name?: string;
  workflow?: string;
  compatible: boolean;
  hashMatch?: boolean;
  nodesChecked?: number;
  nodesTotal?: number;
  warnings: string[];
  errors: string[];
  workflowHash?: string | null;
  lastValidated?: string | null;
}

export interface ConnectorStatusRequest {
  enabled: boolean;
}
export interface ConnectorStatusResponse {
  ok: boolean;
  error?: string | null;
  enabled?: boolean | null;
}

export interface UpdateBindingRequest {
  section: string;
  entityKey: string;
  nodeId?: string | null;
  field?: string | null;
}
export interface UpdateBindingResponse {
  ok: boolean;
  error?: string | null;
}

export interface UpdateParameterRequest {
  paramKey: string;
  value: unknown;
}
export interface UpdateParameterResponse {
  ok: boolean;
  error?: string | null;
  previousValue?: unknown;
  currentValue?: unknown;
  warnings?: string[] | null;
}

export interface ConnectorParameterValues {
  values: Record<string, unknown>;
}

export interface AddConnectorRequest {
  name: string;
  connector: Record<string, unknown>;
}
export interface AddConnectorResponse {
  ok: boolean;
  error?: string | null;
  name?: string | null;
  warnings?: string[] | null;
  message?: string | null;
}

export interface ConnectorReloadResult {
  ok: boolean;
  connectorsLoaded?: number;
  warnings?: string[];
  errors?: string[];
}

// ─────────────────────────────────────────────────────
// Workflows
// ─────────────────────────────────────────────────────

export interface WorkflowDetail {
  name: string;
  nodes: number;
  nodeTypes: Record<string, string>;
  hash?: string | null;
  hasConnector: boolean;
  connectorName?: string | null;
}

export interface WorkflowHashResponse {
  name: string;
  hash?: string | null;
}

// ─────────────────────────────────────────────────────
// AI chat
// ─────────────────────────────────────────────────────

export interface AiMessage {
  role: string;
  content: string;
}

export interface AiChatRequest {
  messages: AiMessage[];
  book_id?: string | null;
  lang?: string | null;
  mode?: string | null;
  topic_id?: string | null;
  scene_id?: string | null;
  character_id?: string | null;
  session_id?: string | null;
}

export interface ToolCallResult {
  tool: string;
  result?: string | null;
  error?: string | null;
  applied?: number | null;
  book_id?: string | null;
}

export interface AiChatResponse {
  reply: string;
  book_edited: boolean;
  book_id?: string | null;
  session_id?: string | null;
  tool_results?: ToolCallResult[] | null;
  patches_applied: number;
}

export interface ChatSessionApi {
  id: string;
  book_id?: string;
  title: string;
  mode: string;
  topic_id: string;
  message_count: number;
  created_at: number;
  updated_at: number;
}

export interface SessionListResponse {
  sessions: ChatSessionApi[];
}

export interface SessionResponse {
  session: ChatSessionApi;
}

export interface CreateSessionRequest {
  book_id: string;
  title?: string | null;
  topic_id?: string | null;
  mode?: string | null;
}

export interface SessionMessagesResponse {
  messages: SessionMessageApi[];
}

export interface SessionMessageApi {
  id: number;
  book_id: string;
  session_id?: string | null;
  scene_id?: string | null;
  role: string;
  message: string;
  created_at: number;
}

// ─────────────────────────────────────────────────────
// Book (subset used by AI position bar)
// ─────────────────────────────────────────────────────

export interface BookData {
  manifest?: { book_id?: string | null; build_id?: string | null } | null;
  book?: { title?: string | null; book_id?: string | null } | null;
  chapters?: BookChapter[] | null;
  /** Server-computed flat scene list (thin-client contract) — preferred over traversal. */
  scene_list?: { chapter_id?: string | null; scene_id?: string | null; type?: string | null }[] | null;
}

export interface BookChapter {
  chapter_id?: string | null;
  chapter_title?: string | null;
  type?: string | null;
  is_special?: boolean;
  display_number?: number | null;
  scenes?: BookScene[] | null;
}

export interface BookScene {
  scene_id?: string | null;
  scene_title?: string | null;
  display_index?: number | null;
  type?: string | null;
  style?: string | null;
  units?: BookUnit[] | null;
}

// SceneUnit.kt equivalent (Navigate tree leaf)
export interface BookUnit {
  id?: string | null;
  type?: string | null;
  text?: string | null;
  participants?: string[] | null;
}

// ─────────────────────────────────────────────────────
// Book import / export (File screen, stage 3)
// ─────────────────────────────────────────────────────

export interface ImportResponse {
  format: 'vbook' | 'txt';
  book_id: string;
  build_id?: string | null;
  title?: string | null;
  state?: string | null;
  chapter_count?: number;
  scene_count?: number;
  was_existing?: boolean;
  dedup?: boolean;
}

export interface AssetsStateResponse {
  book_id?: string | null;
  scope?: string | null;
  total_chunks?: number;
  audio_ready?: number;
  image_ready?: number;
  video_ready?: number;
  has_audio?: boolean;
  has_image?: boolean;
  has_video?: boolean;
  all_audio_ready?: boolean;
  all_image_ready?: boolean;
  all_video_ready?: boolean;
  has_assets?: boolean;
  scope_total?: number;
  scope_audio_ready?: number;
  scope_audio_ready_real?: number;
  scope_image_ready?: number;
  scope_video_ready?: number;
  scope_all_audio_ready?: boolean;
}

// Flat scene list in book order — port of BookData.sceneRefs() (BookModels.kt):
// prefers the server-computed scene_list, falls back to chapter→scene traversal
// (scene type comes from the scene itself, like the Android fallback).
export interface SceneRef {
  chapterId: string;
  sceneId: string;
  sceneType?: string;
}

export function sceneRefs(book: BookData): SceneRef[] {
  const flat = book.scene_list;
  if (flat && flat.length) {
    return flat.map((f) => ({
      chapterId: f.chapter_id ?? '',
      sceneId: f.scene_id ?? '',
      sceneType: f.type ?? undefined,
    }));
  }
  const out: SceneRef[] = [];
  for (const ch of book.chapters ?? []) {
    for (const sc of ch.scenes ?? []) {
      out.push({ chapterId: ch.chapter_id ?? '', sceneId: sc.scene_id ?? '', sceneType: sc.type ?? undefined });
    }
  }
  return out;
}


// unitIndex() equivalent — Android returns unitOffset+1 when the scene exists.
export function unitIndex(book: BookData | null, chapterId: string | null, sceneId: string | null, unitOffset: number): number {
  if (!book || !chapterId || !sceneId) return 0;
  for (const ch of book.chapters ?? []) {
    if (ch.chapter_id === chapterId) {
      for (const sc of ch.scenes ?? []) {
        if (sc.scene_id === sceneId) return unitOffset + 1;
      }
    }
  }
  return 0;
}

// ─────────────────────────────────────────────────────
// Generate screen (stage 4) — worker counts / progress panel /
// agent status / layer config / regenerate
// ─────────────────────────────────────────────────────

// GET /worker/counts — WorkerCounts.kt
export interface WorkerCounts {
  audio: number;
  image: number;
  video: number;
  vbook: number;
  active_audio: number;
  active_image: number;
  active_video: number;
  active_vbook: number;
  active_scenes: number;
}

// GET /book/{id}/progress-panel — ProgressPanelResponse/ProgressTask
export interface ProgressPanelResponse {
  book_id?: string | null;
  tasks: ProgressTask[];
  overall_percent: number;
  any_incomplete: boolean;
}

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

// GET /book/{id}/agent-status — AgentStatusResponse
export interface AgentStatusResponse {
  active: boolean;
  session_id?: string | null;
  session_status?: string | null;
  progress_msg?: string | null;
  source_type?: string | null;
  window_index?: number | null;
  created_scenes?: number | null;
  total_scenes?: number | null;
  remaining_cached?: number | null;
  window_size?: number | null;
  window_start_scene?: number | null;
  window_total_scenes?: number | null;
  window_scene_index?: number | null;
  step_type?: string | null;
}

// GET/PUT /book/{id}/layer-config — LayerConfigResponse / LayerConfigUpdate
export interface LayerConfigResponse {
  book_id?: string | null;
  audio_enabled: boolean;
  image_enabled: boolean;
  video_enabled: boolean;
  vbook_enabled: boolean;
  chunk_size: number;
  audio_timeout_minutes?: number | null;
  image_timeout_minutes?: number | null;
  video_timeout_minutes?: number | null;
}

export interface LayerConfigUpdate {
  audio_enabled?: boolean | null;
  image_enabled?: boolean | null;
  video_enabled?: boolean | null;
  vbook_enabled?: boolean | null;
  chunk_size?: number | null;
  audio_timeout_minutes?: number | null;
  image_timeout_minutes?: number | null;
  video_timeout_minutes?: number | null;
}

// GET /book/{id}/status — BookStatus (lazy book; served camelCase by backend)
export interface BookStatus {
  bookId?: string | null;
  state?: string | null;
  source?: string | null;
  title?: string | null;
  author?: string | null;
  language?: string | null;
  hasSource?: boolean;
  hasCharacters?: boolean;
  hasBible?: boolean;
  totalChapters?: number;
  parsedChapters?: number;
  totalScenes?: number;
  parsedScenes?: number;
  characterCount?: number;
  locationCount?: number;
  sourceSize?: number;
  updatedAt?: string | null;
  ready?: boolean;
}

// POST /book/{id}/regenerate — RegenerateRequest / RegenerateResponse
export interface RegenerateRequest {
  new_book?: BookData | null;
  rebuild_all?: boolean;
  worker_types?: string[] | null;
  scope?: string | null;
  chapter_id?: string | null;
  scene_id?: string | null;
}

export interface RegenerateResponse {
  book_id?: string | null;
  build_id?: string | null;
  message?: string | null;
  dirty_scenes?: { chapter_id?: string; scene_id?: string; reason?: string; dirty_layers?: string[] }[] | null;
  marked?: number;
  scope?: string | null;
  tasks?: { task_id: string; type: string; target_count: number }[];
}

// POST /book/{id}/cancel-worker — CancelWorkerRequest
export interface CancelWorkerRequest {
  type?: string | null;
  task_id?: string | null;
}

// SSE /book/{id}/progress-stream — ProgressEvent (ProgressStream.kt)
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
}
