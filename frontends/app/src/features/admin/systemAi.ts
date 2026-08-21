// ─────────────────────────────────────────────────────────────────────────
// System AI Control helpers (Admin Foundation)
// ─────────────────────────────────────────────────────────────────────────
// Pure helpers shared by the /admin UI and its tests. No DOM / no React —
// the AdminPage component imports these.
//
// SECURITY INVARIANT: the plaintext system API key is a ONE-TIME entry. The
// admin sends it via PUT /admin/system-ai (provider.api_key body field) and
// the UI immediately forgets it — it is never persisted client-side. After
// save, all UI is driven only by the meta response (configured + masked).

export type ProviderType = 'openrouter' | 'openai-compatible' | 'custom';
export type ProviderStatus = 'untested' | 'ok' | 'failed';

/** System provider meta returned by GET /api/v1/admin/system-ai.
 *  NEVER contains the plaintext key — only safe metadata + masked hint. */
export interface SystemProviderMeta {
  provider_type: ProviderType;
  endpoint: string;
  model: string | null;
  configured: boolean;
  api_key_masked: string;
  status: ProviderStatus;
  last_tested_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Shape returned by GET /api/v1/admin/system-ai. */
export interface SystemAiState {
  enabled: boolean;
  provider: SystemProviderMeta | null;
}

export interface SystemAiTest {
  ok: boolean;
  model?: string;
  status?: number;
  error?: string;
}

export const VALID_PROVIDER_TYPES: ProviderType[] = ['openrouter', 'openai-compatible', 'custom'];

export const OPENROUTER_DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1';

/** Defensive normalizer for the provider meta (backend may omit fields on
 *  older deploys). Returns null when there is no configured provider. */
export function normalizeSystemMeta(raw: unknown): SystemProviderMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!r.endpoint && r.configured !== true) return null;
  return {
    provider_type: (r.provider_type || 'openai-compatible') as ProviderType,
    endpoint: typeof r.endpoint === 'string' ? r.endpoint : '',
    model: r.model == null ? null : String(r.model),
    configured: r.configured === true,
    api_key_masked: typeof r.api_key_masked === 'string' ? r.api_key_masked : '',
    status: (r.status || 'untested') as ProviderStatus,
    last_tested_at: r.last_tested_at == null ? null : Number(r.last_tested_at),
    created_at: Number(r.created_at || 0),
    updated_at: Number(r.updated_at || 0),
  };
}

export function endpointPlaceholderFor(providerType: ProviderType): string {
  if (providerType === 'openrouter') return OPENROUTER_DEFAULT_ENDPOINT;
  return 'https://api.example.com/v1';
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  body: {
    provider_type: ProviderType;
    endpoint: string;
    api_key?: string;
    model: string | null;
  };
}

/** Validate the system provider form before PUT.
 *  - endpoint must be a non-empty http(s) URL
 *  - provider_type must be allowed
 *  - apiKey REQUIRED on first create; empty on edit = keep stored credential
 *  - model is optional free text */
export function validateSystemProviderInput(input: {
  providerType: string;
  endpoint: string;
  apiKey: string;
  model: string;
  isExisting: boolean;
}): ValidationResult {
  const providerType = VALID_PROVIDER_TYPES.includes(input.providerType as ProviderType)
    ? (input.providerType as ProviderType) : null;
  if (!providerType) return { ok: false, error: 'admin_invalid_type', body: { provider_type: 'openai-compatible', endpoint: '', model: null } };

  const endpoint = input.endpoint.trim();
  if (!endpoint) return { ok: false, error: 'admin_endpoint_required', body: { provider_type: providerType, endpoint: '', model: null } };
  if (!/^https?:\/\//i.test(endpoint)) return { ok: false, error: 'admin_endpoint_http', body: { provider_type: providerType, endpoint, model: null } };

  const trimmedKey = input.apiKey.trim();
  if (!input.isExisting && !trimmedKey) {
    return { ok: false, error: 'admin_api_key_required', body: { provider_type: providerType, endpoint, model: input.model || null } };
  }

  const body: ValidationResult['body'] = {
    provider_type: providerType,
    endpoint,
    model: input.model || null,
  };
  if (trimmedKey) body.api_key = trimmedKey;
  return { ok: true, body };
}

export function describeTestResult(r: SystemAiTest): { kind: 'ok' | 'fail'; text: string } {
  if (r && r.ok) return { kind: 'ok', text: r.model ? `model: ${r.model}` : 'connection ok' };
  const msg = (r && typeof r.error === 'string' && r.error) || 'unknown error';
  return { kind: 'fail', text: msg };
}

export function statusLabel(status: ProviderStatus): { kind: 'ok' | 'fail' | 'untested'; text: string } {
  if (status === 'ok') return { kind: 'ok', text: 'OK' };
  if (status === 'failed') return { kind: 'fail', text: 'FAILED' };
  return { kind: 'untested', text: 'UNTESTED' };
}
