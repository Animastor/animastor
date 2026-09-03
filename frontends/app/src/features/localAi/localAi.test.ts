// ─────────────────────────────────────────────────────────────────────────
// Local AI Connector UI helper tests (Phase 6)
// ─────────────────────────────────────────────────────────────────────────
import { describe, expect, it } from 'vitest';
import {
  VALID_RUNTIME_TYPES,
  validateCreateInput,
  looksLikeRegToken,
  looksLikeConnectorCredential,
  statusKey,
  statusClass,
  runtimeReachable,
  runtimeInfo,
  formatLastSeen,
  connectorErrorKey,
  regTokenExpired,
  buildRunCommand,
  buildBindingBody,
  REGISTRATION_STEP_KEYS,
  OFFLINE_TROUBLESHOOT_KEYS,
  shareStatus,
  shareStatusKey,
  shareStatusClass,
} from './localAi';

describe('localAi runtime types', () => {
  it('covers exactly the backend RUNTIME_TYPES allowlist (ollama/vllm/llamacpp/lmstudio/openai-compatible)', () => {
    expect([...VALID_RUNTIME_TYPES].sort()).toEqual([
      'llamacpp', 'lmstudio', 'ollama', 'openai-compatible', 'vllm',
    ]);
  });
});

describe('validateCreateInput', () => {
  it('accepts a valid name + runtime type and returns the backend contract', () => {
    const v = validateCreateInput('  Home Ollama ', 'ollama');
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.name).toBe('Home Ollama');
      expect(v.runtime_type).toBe('ollama');
    }
  });

  it('rejects an empty/whitespace name', () => {
    expect(validateCreateInput('   ', 'ollama').ok).toBe(false);
    expect(validateCreateInput('', 'vllm').ok).toBe(false);
  });

  it('rejects a name longer than 120 chars (backend cap)', () => {
    expect(validateCreateInput('x'.repeat(121), 'ollama').ok).toBe(false);
    expect(validateCreateInput('x'.repeat(120), 'ollama').ok).toBe(true);
  });

  it('rejects an unknown runtime type', () => {
    const v = validateCreateInput('Home', 'anthropic');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toBe('local_ai_runtime_invalid');
  });
});

describe('token shapes (llmcreg.*/llmc.*)', () => {
  it('looksLikeRegToken accepts only llmcreg.<id>.<secret>', () => {
    expect(looksLikeRegToken('llmcreg.abc.def')).toBe(true);
    expect(looksLikeRegToken('llmc.abc.def')).toBe(false);
    expect(looksLikeRegToken('wrk.abc.def')).toBe(false);
    expect(looksLikeRegToken('')).toBe(false);
    expect(looksLikeRegToken('llmcreg.onlyonepart')).toBe(false);
  });

  it('looksLikeConnectorCredential accepts only llmc.<id>.<secret>', () => {
    expect(looksLikeConnectorCredential('llmc.abc.def')).toBe(true);
    expect(looksLikeConnectorCredential('llmcreg.abc.def')).toBe(false);
    expect(looksLikeConnectorCredential('llmc.abc')).toBe(false);
  });
});

describe('statusKey / statusClass — the registry `live` flag is authoritative', () => {
  // The full status × live matrix. `live` (an authenticated WS session)
  // always wins → Online. Without a live session only a `pending` PG row
  // shows Pending; a stale `online` row (crash / heartbeat timeout) is
  // shown honestly as Offline.

  it('pending + live=false → Pending', () => {
    expect(statusKey({ status: 'pending', live: false })).toBe('local_ai_status_pending');
    expect(statusClass({ status: 'pending', live: false })).toBe('worker__status--offline');
  });

  it('pending + live=true → Online', () => {
    expect(statusKey({ status: 'pending', live: true })).toBe('local_ai_status_online');
    expect(statusClass({ status: 'pending', live: true })).toBe('worker__status--online');
  });

  it('online + live=true → Online', () => {
    expect(statusKey({ status: 'online', live: true })).toBe('local_ai_status_online');
    expect(statusClass({ status: 'online', live: true })).toBe('worker__status--online');
  });

  it('offline + live=true → Online', () => {
    expect(statusKey({ status: 'offline', live: true })).toBe('local_ai_status_online');
    expect(statusClass({ status: 'offline', live: true })).toBe('worker__status--online');
  });

  it('online + live=false → Offline (stale PG row after a crash)', () => {
    expect(statusKey({ status: 'online', live: false })).toBe('local_ai_status_offline');
    expect(statusClass({ status: 'online', live: false })).toBe('worker__status--offline');
  });

  it('offline + live=false → Offline', () => {
    expect(statusKey({ status: 'offline', live: false })).toBe('local_ai_status_offline');
    expect(statusClass({ status: 'offline', live: false })).toBe('worker__status--offline');
  });
});

describe('runtime reachability is DISTINCT from connector online (§7)', () => {
  it('runtime_ok true → reachable', () => {
    expect(runtimeReachable({ runtime_meta: { runtime_ok: true } })).toBe(true);
  });

  it('runtime_ok missing/false → NOT reachable (fail honest, not optimistic)', () => {
    expect(runtimeReachable({ runtime_meta: {} })).toBe(false);
    expect(runtimeReachable({ runtime_meta: { runtime_ok: false } })).toBe(false);
    expect(runtimeReachable({ runtime_meta: null })).toBe(false);
    expect(runtimeReachable({})).toBe(false);
  });

  it('runtimeInfo returns the version label only — never a URL', () => {
    const parts = runtimeInfo({ runtime_meta: { runtime: { type: 'ollama', version: '0.5.7' } } });
    expect(parts).toEqual(['0.5.7']);
    expect(runtimeInfo({ runtime_meta: null })).toEqual([]);
    expect(parts.every((p) => !/https?:|127\.0\.0\.1|localhost/.test(p))).toBe(true);
  });
});

describe('formatLastSeen (epoch ms)', () => {
  const now = 1_700_000_000_000;
  it('formats relative s/m/h/d and — for null', () => {
    expect(formatLastSeen(null, now)).toBe('—');
    expect(formatLastSeen(now - 5_000, now)).toBe('5s');
    expect(formatLastSeen(now - 5 * 60_000, now)).toBe('5m');
    expect(formatLastSeen(now - 3 * 3_600_000, now)).toBe('3h');
    expect(formatLastSeen(now - 2 * 86_400_000, now)).toBe('2d');
  });
});

describe('connectorErrorKey — sanitized code → i18n key mapping', () => {
  it('maps every known backend code to a dedicated key', () => {
    const known = [
      'connector_offline', 'session_closed', 'timeout', 'runtime_unreachable',
      'model_not_found', 'busy', 'context_length', 'bad_response', 'runtime_error',
      'response_too_large', 'request_too_large', 'invalid_request', 'stream_failed',
      'no_models', 'connector_not_bound', 'discovery_failed', 'persist_failed',
      'registration_expired', 'registration_already_used', 'local_ai_not_ready',
    ];
    for (const code of known) {
      expect(connectorErrorKey(code)).toMatch(/^local_ai_err_/);
      expect(connectorErrorKey(code)).not.toBe('local_ai_err_generic');
    }
  });

  it('unknown codes degrade to the generic key — never raw text', () => {
    expect(connectorErrorKey('something_new')).toBe('local_ai_err_generic');
    expect(connectorErrorKey('')).toBe('local_ai_err_generic');
  });
});

describe('regTokenExpired', () => {
  it('flags expired tokens and leaves future ones usable', () => {
    const now = 1_700_000_000_000;
    expect(regTokenExpired(now - 1, now)).toBe(true);
    expect(regTokenExpired(now + 60_000, now)).toBe(false);
    expect(regTokenExpired(null, now)).toBe(false);
    expect(regTokenExpired(undefined, now)).toBe(false);
  });
});

describe('buildRunCommand — mirrors the local-ai-connector CLI contract', () => {
  it('builds the npx command against the caller origin + ws path', () => {
    const cmd = buildRunCommand('llmcreg.abc.def', '/api/v1/ai-connector/ws', 'https://animastor.example');
    expect(cmd).toBe('npx animastor-ai-connector --url https://animastor.example/api/v1/ai-connector/ws --token llmcreg.abc.def');
  });

  it('strips trailing slashes from the origin', () => {
    const cmd = buildRunCommand('llmcreg.a.b', '/api/v1/ai-connector/ws', 'https://x.example/');
    expect(cmd).toContain('--url https://x.example/api/v1/ai-connector/ws');
  });
});

describe('buildBindingBody — the provider-binding contract', () => {
  it('carries provider_type local-ai, the connector id and a trimmed model', () => {
    expect(buildBindingBody('c-1', '  qwen3:32b ')).toEqual({
      provider_type: 'local-ai',
      connector_id: 'c-1',
      model: 'qwen3:32b',
    });
    expect(buildBindingBody('c-1', '').model).toBe('');
  });
});

describe('UI key lists are non-empty and i18n-shaped', () => {
  it('registration steps + offline hints are defined', () => {
    expect(REGISTRATION_STEP_KEYS.length).toBeGreaterThan(0);
    expect(OFFLINE_TROUBLESHOOT_KEYS.length).toBeGreaterThan(0);
    expect(REGISTRATION_STEP_KEYS.every((k) => k.startsWith('local_ai_'))).toBe(true);
    expect(OFFLINE_TROUBLESHOOT_KEYS.every((k) => k.startsWith('local_ai_'))).toBe(true);
  });
});

// ── LLM Sharing Phase 1 — Share this AI ────────────────────────────────────

describe('shareStatus — availability outranks sharing state', () => {
  it('offline connector → Offline even when sharing is enabled', () => {
    expect(shareStatus({ sharing_enabled: true, connector_live: false, runtime_reachable: false })).toBe('offline');
    expect(shareStatus({ sharing_enabled: true, connector_live: false, runtime_reachable: true })).toBe('offline');
  });

  it('live but runtime unreachable → Runtime unavailable (honest, never optimistic)', () => {
    expect(shareStatus({ sharing_enabled: true, connector_live: true, runtime_reachable: false })).toBe('runtime_unavailable');
    expect(shareStatus({ sharing_enabled: false, connector_live: true, runtime_reachable: false })).toBe('runtime_unavailable');
  });

  it('fully available → Private or Shared per the policy', () => {
    expect(shareStatus({ sharing_enabled: false, connector_live: true, runtime_reachable: true })).toBe('private');
    expect(shareStatus({ sharing_enabled: true, connector_live: true, runtime_reachable: true })).toBe('shared');
  });
});

describe('shareStatusKey / shareStatusClass — badge mapping', () => {
  it('maps the four states to their i18n keys', () => {
    expect(shareStatusKey('private')).toBe('share_ai_status_private');
    expect(shareStatusKey('shared')).toBe('share_ai_status_shared');
    expect(shareStatusKey('offline')).toBe('share_ai_status_offline');
    expect(shareStatusKey('runtime_unavailable')).toBe('share_ai_status_runtime_unavailable');
  });

  it('only Shared renders the online pill class', () => {
    expect(shareStatusClass('shared')).toBe('worker__status--online');
    expect(shareStatusClass('private')).toBe('worker__status--offline');
    expect(shareStatusClass('offline')).toBe('worker__status--offline');
    expect(shareStatusClass('runtime_unavailable')).toBe('worker__status--offline');
  });
});
