// ─────────────────────────────────────────────────────────────────────────
// Local AI Connector UI helpers (Local AI Connector V1 — Phase 6)
// ─────────────────────────────────────────────────────────────────────────
// Pure helpers shared by the /settings/local-ai UI and its tests.
// No DOM / no React here — the section component imports these.
//
// Model honesty contract (spec §7): `discovered` models are ids the runtime
// REPORTED via /v1/models — they are NOT loaded/warm. Nothing in this module
// ever claims "loaded"; cold-load state is only learned from real request
// timing. No automatic inference probes run on page open (AD-7).
//
// SECURITY INVARIANT: the one-time registration token (llmcreg.*) and the
// persistent credential (llmc.*) are disclosed ONLY where the backend
// registration/rotate flow already provides them. They live transiently in
// the component's `useState` while the disclosure modal is open — never
// persisted, never re-requestable after dismissal.

export type ConnectorRuntimeType = 'ollama' | 'vllm' | 'llamacpp' | 'lmstudio' | 'openai-compatible';
export type ConnectorStatus = 'pending' | 'online' | 'offline';

/** Status row shape from GET /api/v1/ai-connector/status — no secret
 *  material (not even the token_prefix mask). */
export interface AiConnectorStatus {
  connector_id: string;
  name: string;
  runtime_type: ConnectorRuntimeType;
  status: ConnectorStatus;
  live: boolean;
  last_seen: number | null;
  models_count: number;
  capabilities: { tools?: boolean; vision?: boolean; context?: number } | null;
  runtime_meta: {
    runtime_ok?: boolean;
    latency_ms?: number | null;
    runtime?: { type?: string; version?: string };
  } | null;
  created_at: number | null;
}

/** Models row shape from GET /api/v1/ai-connector/models (PG read-only —
 *  never triggers a runtime fetch). */
export interface AiConnectorModels {
  connector_id: string;
  name: string;
  runtime_type: ConnectorRuntimeType;
  status: ConnectorStatus;
  live: boolean;
  last_seen: number | null;
  models: string[];
}

export interface RegistrationResponse {
  connector: AiConnectorStatus;
  reg_token: string;          // one-time disclosure — never again
  reg_expires_at: number;
  ws_url: string;
}

export interface RotateResponse {
  connector: AiConnectorStatus;
  token: string;              // one-time disclosure — never again
}

export interface RefreshModelsResponse {
  ok: boolean;
  models?: string[];
  code?: string;
}

export interface ConnectorTestResponse {
  ok: boolean;
  model?: string;
  error?: string;
  code?: string;
}

/** Bound local-ai provider meta from GET /settings/ai/provider (only the
 *  fields this UI reads; cloud rows simply have provider_type !== 'local-ai'). */
export interface LocalProviderMeta {
  provider_type: string;
  connector_id: string | null;
  model: string | null;
  status: 'untested' | 'ok' | 'failed';
  last_tested_at: number | null;
}

export const RUNTIME_TYPE_OPTIONS: { type: ConnectorRuntimeType; labelKey: 'local_ai_runtime_ollama' | 'local_ai_runtime_vllm' | 'local_ai_runtime_llamacpp' | 'local_ai_runtime_lmstudio' | 'local_ai_runtime_openai_compatible' }[] = [
  { type: 'ollama', labelKey: 'local_ai_runtime_ollama' },
  { type: 'vllm', labelKey: 'local_ai_runtime_vllm' },
  { type: 'llamacpp', labelKey: 'local_ai_runtime_llamacpp' },
  { type: 'lmstudio', labelKey: 'local_ai_runtime_lmstudio' },
  { type: 'openai-compatible', labelKey: 'local_ai_runtime_openai_compatible' },
];

export const VALID_RUNTIME_TYPES: ConnectorRuntimeType[] = RUNTIME_TYPE_OPTIONS.map((o) => o.type);

/** Validate the create-connector form. Returns the exact backend contract. */
export function validateCreateInput(name: string, runtimeType: string):
  { ok: true; name: string; runtime_type: ConnectorRuntimeType } | { ok: false; error: 'local_ai_name_required' | 'local_ai_name_too_long' | 'local_ai_runtime_invalid' } {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'local_ai_name_required' };
  if (trimmed.length > 120) return { ok: false, error: 'local_ai_name_too_long' };
  if (!VALID_RUNTIME_TYPES.includes(runtimeType as ConnectorRuntimeType)) {
    return { ok: false, error: 'local_ai_runtime_invalid' };
  }
  return { ok: true, name: trimmed, runtime_type: runtimeType as ConnectorRuntimeType };
}

/** A `llmcreg.<id>.<secret>` registration token, as issued one-time. */
export function looksLikeRegToken(token: string): boolean {
  if (!token || token.length < 8) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'llmcreg') return false;
  return parts[1].length > 0 && parts[2].length > 0;
}

/** A `llmc.<id>.<secret>` persistent credential, as disclosed on
 *  activation/rotation. Shape check only — never stored or logged. */
export function looksLikeConnectorCredential(token: string): boolean {
  if (!token || token.length < 8) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'llmc') return false;
  return parts[1].length > 0 && parts[2].length > 0;
}

/** Localized status key for the connector pill. The registry `live` flag
 *  (an authenticated WS session is connected) is the AUTHORITATIVE truth:
 *  whenever it is set the connector is Online. Without a live session the
 *  PG `status` is a stale trace only — a `pending` row renders Pending,
 *  anything else (including a stale `online`, e.g. right after a crash)
 *  renders Offline. */
export function statusKey(c: { status: ConnectorStatus; live: boolean }): 'local_ai_status_pending' | 'local_ai_status_online' | 'local_ai_status_offline' {
  if (c.live) return 'local_ai_status_online';
  if (c.status === 'pending') return 'local_ai_status_pending';
  return 'local_ai_status_offline';
}

/** CSS class suffix for the status pill (worker pill pattern). Same
 *  authoritative rule as statusKey: live → online; no live session → the
 *  offline pill (pending included). */
export function statusClass(c: { status: ConnectorStatus; live: boolean }): string {
  if (c.live) return 'worker__status--online';
  return 'worker__status--offline';
}

/**
 * Runtime reachability — DISTINCT from connector online (§7): the WS session
 * is alive AND the local runtime answered `GET {base}/v1/models` in the last
 * heartbeat (runtime_ok). Unknown → false (fail honest, not optimistic).
 */
export function runtimeReachable(c: { runtime_meta?: { runtime_ok?: boolean } | null }): boolean {
  return c.runtime_meta?.runtime_ok === true;
}

/** Runtime info line parts from runtime_meta (label only — never a URL). */
export function runtimeInfo(c: { runtime_meta?: { runtime?: { type?: string; version?: string } } | null }): string[] {
  const parts: string[] = [];
  const rt = c.runtime_meta?.runtime;
  if (rt?.version) parts.push(String(rt.version).slice(0, 64));
  return parts;
}

/** Format an epoch-ms timestamp as a localized relative/short string
 *  (same shape as the workers list). */
export function formatLastSeen(ts: number | null, now: number = Date.now()): string {
  if (ts == null) return '—';
  const diff = now - ts;
  if (diff < 0) return new Date(ts).toLocaleString();
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  return `${Math.round(diff / 86_400_000)}d`;
}

/** Sanitized connector error code → i18n key. NEVER surface raw runtime
 *  errors, URLs or internal detail — the backend already sanitizes; this
 *  maps the fixed code vocabulary to localized strings. */
export function connectorErrorKey(code: string): string {
  const map: Record<string, string> = {
    connector_offline: 'local_ai_err_offline',
    session_closed: 'local_ai_err_offline',
    timeout: 'local_ai_err_timeout',
    runtime_unreachable: 'local_ai_err_runtime_unreachable',
    model_not_found: 'local_ai_err_model_not_found',
    busy: 'local_ai_err_busy',
    context_length: 'local_ai_err_context_length',
    bad_response: 'local_ai_err_bad_response',
    runtime_error: 'local_ai_err_runtime_error',
    response_too_large: 'local_ai_err_response_too_large',
    request_too_large: 'local_ai_err_request_too_large',
    invalid_request: 'local_ai_err_invalid_request',
    stream_failed: 'local_ai_err_runtime_error',
    no_models: 'local_ai_err_no_models',
    connector_not_bound: 'local_ai_err_offline',
    discovery_failed: 'local_ai_err_discovery_failed',
    persist_failed: 'local_ai_err_discovery_failed',
    registration_expired: 'local_ai_err_registration_expired',
    registration_already_used: 'local_ai_err_registration_used',
    local_ai_not_ready: 'local_ai_err_no_models',
  };
  return map[code] || 'local_ai_err_generic';
}

/** Registration token countdown — expired tokens must guide the user to
 *  reissue instead of presenting a dead token. */
export function regTokenExpired(expiresAt: number | null | undefined, now: number = Date.now()): boolean {
  if (expiresAt == null) return false;
  return now >= expiresAt;
}

/**
 * The copy-paste launch command shown in the one-time registration modal.
 * Mirrors the animastor-ai-connector package README exactly (npx package). Display-only:
 * the command embeds the one-time token the user just received.
 */
export function buildRunCommand(token: string, wsUrl: string, origin: string): string {
  const url = `${origin.replace(/\/+$/, '')}${wsUrl}`;
  return `npx animastor-ai-connector --url ${url} --token ${token}`;
}

/** i18n keys of the setup steps shown with the one-time token. */
export const REGISTRATION_STEP_KEYS = [
  'local_ai_setup_step_1',
  'local_ai_setup_step_2',
  'local_ai_setup_step_3',
  'local_ai_setup_step_4',
] as const;

/** i18n keys of concise troubleshooting hints for an offline connector. */
export const OFFLINE_TROUBLESHOOT_KEYS = [
  'local_ai_trouble_process',
  'local_ai_trouble_runtime',
  'local_ai_trouble_network',
] as const;

/** Map a model selection to the provider-binding body; empty string means
 *  "let the backend default to the first discovered model". */
export function buildBindingBody(connectorId: string, model: string): { provider_type: 'local-ai'; connector_id: string; model: string } {
  return { provider_type: 'local-ai', connector_id: connectorId, model: model.trim() };
}

// ── LLM Sharing Phase 1 — Share this AI (minimal owner-side UI) ──────────────
// Endpoint row shape from GET /api/v1/ai-endpoints — no credentials, no
// runtime URL, no local IP, no filesystem detail (the backend contract
// guarantees this by construction; the type mirrors it).

/** The four sharing-relevant UI states. Derived, not stored: the badge
 *  reflects availability FIRST (offline / runtime unavailable), then the
 *  sharing state (Private / Shared) — lifecycle states stay separate. */
export type ShareStatus = 'private' | 'shared' | 'offline' | 'runtime_unavailable';

export interface AiEndpoint {
  endpoint_id: string;
  workspace_id: string;
  connector_id: string;
  name: string;
  runtime_type: ConnectorRuntimeType;
  model: string | null;
  description: string | null;
  enabled: boolean;
  sharing_enabled: boolean;
  connector_live: boolean;
  runtime_reachable: boolean;
  models_discovered: number;
  concurrency_limit: number;
  created_at: number | null;
  updated_at: number | null;
}

/**
 * Sharing badge state: availability outranks sharing state — an offline
 * shared endpoint shows Offline (the honest "nothing can be served right
 * now" state), a live-but-unreachable shared one shows Runtime unavailable,
 * and only a fully available endpoint shows Private/Shared.
 */
export function shareStatus(
  e: Pick<AiEndpoint, 'sharing_enabled' | 'connector_live' | 'runtime_reachable'>,
): ShareStatus {
  if (!e.connector_live) return 'offline';
  if (!e.runtime_reachable) return 'runtime_unavailable';
  return e.sharing_enabled ? 'shared' : 'private';
}

/** i18n key for the sharing badge. */
export function shareStatusKey(s: ShareStatus): string {
  const map: Record<ShareStatus, string> = {
    private: 'share_ai_status_private',
    shared: 'share_ai_status_shared',
    offline: 'share_ai_status_offline',
    runtime_unavailable: 'share_ai_status_runtime_unavailable',
  };
  return map[s];
}

/** CSS class for the sharing pill (worker pill pattern). */
export function shareStatusClass(s: ShareStatus): string {
  return s === 'shared' ? 'worker__status--online' : 'worker__status--offline';
}
