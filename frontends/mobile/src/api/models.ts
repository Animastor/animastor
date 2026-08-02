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
  manifest?: { book_id?: string | null } | null;
  book?: { title?: string | null; book_id?: string | null } | null;
  chapters?: BookChapter[] | null;
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
  units?: { id?: string | null; type?: string | null; text?: string | null }[] | null;
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
