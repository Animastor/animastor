// ─────────────────────────────────────────────────────────────────────────
// Personal AI Provider helpers (Experimental Beta — Phase 4)
// ─────────────────────────────────────────────────────────────────────────
// Pure helpers shared by the /settings/ai UI and its tests. No DOM / no
// React — the section component imports these.
//
// SECURITY INVARIANT: the plaintext API key is a ONE-TIME entry. The frontend
// sends it via PUT /settings/ai/provider (api_key body field) and IMMEDIATELY
// forgets it — it is never written to localStorage, sessionStorage, the URL,
// Redux persistence nor IndexedDB. After save, ALL real-time UI is driven
// only by the meta response (configured: true, api_key_masked: '••••last4').

export type ProviderType = 'openrouter' | 'openai-compatible' | 'custom';
export type ProviderStatus = 'untested' | 'ok' | 'failed';

/** Public provider shape returned by GET /api/v1/settings/ai/provider.
 *  NEVER contains `api_key` or `api_key_enc` — only safe metadata + the
 *  masked hint. `configured: true` is the spec §5 "configured" flag. */
export interface AiProviderMeta {
  workspace_id: string;
  provider: ProviderType;
  provider_type: ProviderType;
  endpoint: string;
  model: string | null;
  enabled: boolean;
  configured: boolean;
  has_api_key: boolean;
  api_key_masked: string;
  status: ProviderStatus;
  last_tested_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface AiProviderRead { provider: AiProviderMeta | null; has_workspace_provider: boolean }
export interface AiProviderList { providers: AiProviderMeta[] }

export interface AiProviderTest {
  ok: boolean;
  model?: string;
  status?: number;
  error?: string;
  // never includes `apiKey` — the backend strips it.
}

export const PROVIDER_TYPE_OPTIONS: { type: ProviderType; labelKey: 'ai_provider_type_openrouter' | 'ai_provider_type_openai_compatible' | 'ai_provider_type_custom' }[] = [
  { type: 'openrouter', labelKey: 'ai_provider_type_openrouter' },
  { type: 'openai-compatible', labelKey: 'ai_provider_type_openai_compatible' },
  { type: 'custom', labelKey: 'ai_provider_type_custom' },
];

export const VALID_PROVIDER_TYPES: ProviderType[] = ['openrouter', 'openai-compatible', 'custom'];

/** OpenRouter base URL — the first documented example (spec §14, §16).
 *  OpenAI-compatible gets no default: the user supplies their own endpoint. */
export const OPENROUTER_DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1';

/** Build a typed meta object from raw API JSON (defensive: backend may omit
 *  new fields when running against an older deploy). Returns null for empty. */
export function normalizeMeta(raw: unknown): AiProviderMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!r.workspace_id || !r.endpoint) return null;
  return {
    workspace_id: String(r.workspace_id),
    provider: (r.provider_type || r.provider || 'openai-compatible') as ProviderType,
    provider_type: (r.provider_type || r.provider || 'openai-compatible') as ProviderType,
    endpoint: String(r.endpoint),
    model: r.model == null ? null : String(r.model),
    enabled: r.enabled !== false,
    configured: r.configured === true || r.has_api_key === true,
    has_api_key: r.has_api_key === true || r.configured === true,
    api_key_masked: typeof r.api_key_masked === 'string' ? r.api_key_masked : '',
    status: (r.status || 'untested') as ProviderStatus,
    last_tested_at: r.last_tested_at == null ? null : Number(r.last_tested_at),
    created_at: Number(r.created_at || 0),
    updated_at: Number(r.updated_at || 0),
  };
}

/** Helper given a provider_type, returns the recommended endpoint placeholder */
export function endpointPlaceholderFor(providerType: ProviderType): string {
  if (providerType === 'openrouter') return OPENROUTER_DEFAULT_ENDPOINT;
  return 'https://api.example.com/v1';
}

/** Validate the form input before sending to PUT.
 *  - `endpoint` must be a non-empty http(s) URL
 *  - `provider_type` must be one of the allowed values
 *  - `apiKey` is REQUIRED on a fresh ADD; on edit, empty `apiKey` means
 *    "keep the stored credential" (spec §5).
 *  - `model` is optional and free text (spec §15) */
export interface ValidationResult {
  ok: boolean;
  error?: string;
  // normalized body to PUT —.setModelTrimmed / .provider_type / .api_key_or_undefined
  body: {
    provider_type: ProviderType;
    endpoint: string;
    api_key?: string;
    model: string | null;
  };
}

export function validateProviderInput(input: {
  providerType: string;
  endpoint: string;
  apiKey: string;
  model: string;
  isExisting: boolean;
}): ValidationResult {
  const providerType = VALID_PROVIDER_TYPES.includes(input.providerType as ProviderType)
    ? (input.providerType as ProviderType) : null;
  if (!providerType) return { ok: false, error: 'ai_provider_invalid_type', body: { provider_type: 'openai-compatible', endpoint: '', model: null } };

  const endpoint = input.endpoint.trim();
  if (!endpoint) return { ok: false, error: 'ai_provider_endpoint_required', body: { provider_type: providerType, endpoint: '', model: null } };
  if (!/^https?:\/\//i.test(endpoint)) return { ok: false, error: 'ai_provider_endpoint_http', body: { provider_type: providerType, endpoint, model: null } };

  const trimmedKey = input.apiKey.trim();
  // On ADD the key is mandatory. On EDIT an empty key keeps the stored cred.
  if (!input.isExisting && !trimmedKey) {
    return { ok: false, error: 'ai_provider_api_key_required', body: { provider_type: providerType, endpoint, model: input.model || null } };
  }

  const body: ValidationResult['body'] = {
    provider_type: providerType,
    endpoint,
    model: input.model || null,
  };
  if (trimmedKey) body.api_key = trimmedKey;
  return { ok: true, body };
}

/** Map a Test Connection JSON response to a safe UI string — the backend
 *  already sanitizes the error. This just guards against weird shapes. */
export function describeTestResult(r: AiProviderTest): { kind: 'ok' | 'fail'; text: string } {
  if (r && r.ok) return { kind: 'ok', text: r.model ? `model: ${r.model}` : 'connection ok' };
  const msg = (r && typeof r.error === 'string' && r.error) || 'unknown error';
  return { kind: 'fail', text: msg };
}

/** A short status badge for the saved-state pill — 'OK' / 'FAILED' / 'UNTESTED'. */
export function statusLabel(status: ProviderStatus): { kind: 'ok' | 'fail' | 'untested'; i18nKey: 'ai_provider_status_ok' | 'ai_provider_status_failed' | 'ai_provider_status_untested' } {
  if (status === 'ok') return { kind: 'ok', i18nKey: 'ai_provider_status_ok' };
  if (status === 'failed') return { kind: 'fail', i18nKey: 'ai_provider_status_failed' };
  return { kind: 'untested', i18nKey: 'ai_provider_status_untested' };
}

/** Format an epoch-seconds timestamp as a relative/short string — mirrors
 *  the worker last-seen formatter from privateWorkers.ts. The backend writes
 *  last_tested_at as PG BIGINT (epoch seconds, not ms). */
export function formatLastTested(ts: number | null, nowMs: number = Date.now()): string {
  if (ts == null) return '—';
  const ms = ts * 1000;
  const diff = nowMs - ms;
  if (diff < 0) return new Date(ms).toLocaleString();
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  return `${Math.round(diff / 86_400_000)}d`;
}

/** Disables Save while editing if no endpoint AND no key (avoid the 400 the
 *  backend would reject with). For edit mode, no new key is fine (keep
 *  existing) so the button stays enabled as long as endpoint is non-empty. */
export function canSave(input: {
  providerType: string;
  endpoint: string;
  apiKey: string;
  model?: string;
  isExisting: boolean;
}): boolean {
  const v = validateProviderInput({ ...input, model: input.model || '' });
  return v.ok;
}
