// Tests for the Personal AI Provider pure helpers (Experimental Beta — Phase 4).
// Covers provider_type validation, masked-credential flow, status lifecycle
// (untested/ok/failed), last-tested formatting, and the security invariant
// that the plaintext key vanishes from frontend state after save.
import { describe, expect, it } from 'vitest';
import {
  VALID_PROVIDER_TYPES,
  OPENROUTER_DEFAULT_ENDPOINT,
  normalizeMeta,
  endpointPlaceholderFor,
  validateProviderInput,
  describeTestResult,
  statusLabel,
  formatLastTested,
  canSave,
} from './aiProviders';

describe('VALID_PROVIDER_TYPES', () => {
  it('exposes the spec §3 / §14 allowed values', () => {
    expect(VALID_PROVIDER_TYPES).toEqual(['openrouter', 'openai-compatible', 'custom']);
  });
});

describe('endpointPlaceholderFor', () => {
  it('returns the OpenRouter default endpoint for openrouter', () => {
    expect(endpointPlaceholderFor('openrouter')).toBe(OPENROUTER_DEFAULT_ENDPOINT);
    expect(OPENROUTER_DEFAULT_ENDPOINT).toBe('https://openrouter.ai/api/v1');
  });
  it('returns a generic placeholder for openai-compatible / custom', () => {
    expect(endpointPlaceholderFor('openai-compatible')).toBe('https://api.example.com/v1');
    expect(endpointPlaceholderFor('custom')).toBe('https://api.example.com/v1');
  });
});

describe('normalizeMeta', () => {
  it('defensively accepts meta with all new fields', () => {
    const m = normalizeMeta({
      workspace_id: 'ws1',
      provider_type: 'openrouter',
      endpoint: 'https://x.example/v1',
      model: null,
      enabled: true,
      configured: true,
      has_api_key: true,
      api_key_masked: '••••last',
      status: 'ok',
      last_tested_at: 1700000000,
      created_at: 1700000000,
      updated_at: 1700000000,
    });
    expect(m?.provider_type).toBe('openrouter');
    expect(m?.configured).toBe(true);
    expect(m?.status).toBe('ok');
    expect(m?.last_tested_at).toBe(1700000000);
  });

  it('returns null when essential fields are missing', () => {
    expect(normalizeMeta(null)).toBe(null);
    expect(normalizeMeta({})).toBe(null);
    expect(normalizeMeta({ workspace_id: 'ws1' })).toBe(null);
  });

  it('falls back to the legacy `provider` field when provider_type is absent (back-compat)', () => {
    const m = normalizeMeta({
      workspace_id: 'ws1',
      provider: 'openai-compatible',
      endpoint: 'https://x.example/v1',
    });
    expect(m?.provider_type).toBe('openai-compatible');
    expect(m?.provider).toBe('openai-compatible');
  });

  it('NEVER exposes the plaintext key — only the masked hint', () => {
    const m = normalizeMeta({
      workspace_id: 'ws1',
      provider_type: 'openrouter',
      endpoint: 'https://x.example/v1',
      // A bug in the backend MUST NOT reveal the key here:
      api_key: 'sk-leaked-plaintext',
      api_key_enc: 'iv:tag:cipher',
      api_key_masked: '••••only',
    });
    expect(JSON.stringify(m)).not.toContain('sk-leaked-plaintext');
    expect(JSON.stringify(m)).not.toContain('cipher');
    expect(m?.api_key_masked).toBe('••••only');
  });
});

describe('validateProviderInput', () => {
  const base = { providerType: 'openrouter', endpoint: 'https://or.example/v1', apiKey: 'sk-new', model: 'qwen/x', isExisting: false };

  it('accepts a fully-formed ADD with key + endpoint + provider_type + model', () => {
    const v = validateProviderInput(base);
    expect(v.ok).toBe(true);
    expect(v.body.provider_type).toBe('openrouter');
    expect(v.body.endpoint).toBe('https://or.example/v1');
    expect(v.body.api_key).toBe('sk-new');
    expect(v.body.model).toBe('qwen/x');
  });

  it('accepts EDIT with empty key (keep existing credential) — spec §5', () => {
    const v = validateProviderInput({ ...base, apiKey: '   ', isExisting: true });
    expect(v.ok).toBe(true);
    expect(v.body.api_key).toBeUndefined();
  });

  it('rejects ADD with no key — spec §5 (credential required)', () => {
    const v = validateProviderInput({ ...base, apiKey: '' });
    expect(v.ok).toBe(false);
    expect(v.error).toBe('ai_provider_api_key_required');
  });

  it('rejects endpoint that is not http(s) (spec §16)', () => {
    const v = validateProviderInput({ ...base, endpoint: 'ftp://somewhere' });
    expect(v.ok).toBe(false);
    expect(v.error).toBe('ai_provider_endpoint_http');
    // javascript:, file:, data: also rejected:
    expect(validateProviderInput({ ...base, endpoint: 'javascript:alert(1)' }).ok).toBe(false);
    expect(validateProviderInput({ ...base, endpoint: 'file:///etc/passwd' }).ok).toBe(false);
  });

  it('rejects unknown provider_type', () => {
    const v = validateProviderInput({ ...base, providerType: 'anthropic' });
    expect(v.ok).toBe(false);
    expect(v.error).toBe('ai_provider_invalid_type');
  });

  it('trims endpoint + key before sending — so leading whitespace cannot smuggle a non-http scheme', () => {
    const v = validateProviderInput({ ...base, endpoint: '  https://or.example/v1  ', apiKey: '  sk-new  ' });
    expect(v.ok).toBe(true);
    expect(v.body.endpoint).toBe('https://or.example/v1');
    expect(v.body.api_key).toBe('sk-new');
  });
});

describe('describeTestResult', () => {
  it('returns kind=ok and includes the model name on success', () => {
    const r = describeTestResult({ ok: true, model: 'qwen/test' });
    expect(r.kind).toBe('ok');
    expect(r.text).toBe('model: qwen/test');
  });
  it('returns the sanitized error on failure (never echoes the key)', () => {
    const r = describeTestResult({ ok: false, error: 'Authentication failed' });
    expect(r.kind).toBe('fail');
    expect(r.text).toBe('Authentication failed');
    expect(r.text).not.toContain('sk-');
  });
  it('falls back to a generic message on weird shapes', () => {
    const r = describeTestResult({} as never);
    expect(r.kind).toBe('fail');
    expect(r.text).toBe('unknown error');
  });
});

describe('statusLabel', () => {
  it('maps status to the UI badge keys', () => {
    expect(statusLabel('ok').kind).toBe('ok');
    expect(statusLabel('ok').i18nKey).toBe('ai_provider_status_ok');
    expect(statusLabel('failed').kind).toBe('fail');
    expect(statusLabel('failed').i18nKey).toBe('ai_provider_status_failed');
    expect(statusLabel('untested').kind).toBe('untested');
    expect(statusLabel('untested').i18nKey).toBe('ai_provider_status_untested');
  });
});

describe('formatLastTested', () => {
  const now = 1_700_000_000_000;
  it('null → em dash', () => {
    expect(formatLastTested(null, now)).toBe('—');
  });
  it('recent (< 60s) → seconds', () => {
    // backend writes epoch SECONDS, not ms — this multiplies internally.
    expect(formatLastTested((now - 5_000) / 1000, now)).toBe('5s');
  });
  it('minutes / hours / days', () => {
    expect(formatLastTested(Math.floor((now - 5 * 60_000) / 1000), now)).toBe('5m');
    expect(formatLastTested(Math.floor((now - 3 * 3_600_000) / 1000), now)).toBe('3h');
    expect(formatLastTested(Math.floor((now - 2 * 86_400_000) / 1000), now)).toBe('2d');
  });
});

describe('canSave', () => {
  it('true for a fully-formed ADD', () => {
    expect(canSave({ providerType: 'openrouter', endpoint: 'https://or/v1', apiKey: 'sk-x', isExisting: false })).toBe(true);
  });
  it('true for EDIT with empty key', () => {
    expect(canSave({ providerType: 'openrouter', endpoint: 'https://or/v1', apiKey: '', isExisting: true })).toBe(true);
  });
  it('false for ADD with empty key', () => {
    expect(canSave({ providerType: 'openrouter', endpoint: 'https://or/v1', apiKey: '', isExisting: false })).toBe(false);
  });
  it('false for bad endpoint / type', () => {
    expect(canSave({ providerType: 'openrouter', endpoint: 'not-a-url', apiKey: 'sk', isExisting: true })).toBe(false);
    expect(canSave({ providerType: 'weird', endpoint: 'https://or/v1', apiKey: 'sk', isExisting: true })).toBe(false);
  });
});
