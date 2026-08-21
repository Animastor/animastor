import { useEffect, useState } from 'preact/hooks';
import { getJson, putJson, postJson } from '../api/client';
import { Switch, ErrorText } from '../lib/ui';
import {
  type ProviderType,
  type SystemAiState,
  type SystemProviderMeta,
  type SystemAiTest,
  VALID_PROVIDER_TYPES,
  OPENROUTER_DEFAULT_ENDPOINT,
  normalizeSystemMeta,
  validateSystemProviderInput,
  describeTestResult,
  statusLabel,
} from '../features/admin/systemAi';

// AdminPage — System AI Control (Admin Foundation).
// Served on admin.animastor.in (nginx Basic Auth + backend requireAdmin).
// Two concerns:
//   1. Kill switch — toggle platform/system AI on or off. Personal (workspace)
//      providers are unaffected.
//   2. System provider — the admin-configured endpoint/key/model used as the
//      platform fallback. The key is one-time entry, never persisted client-side.

export function AdminPage(props: { path?: string }) {
  void props;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saved, setSaved] = useState<SystemProviderMeta | null>(null);
  const [providerType, setProviderType] = useState<ProviderType>('openai-compatible');
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await getJson<SystemAiState>('/admin/system-ai');
        if (!alive) return;
        setEnabled(res.enabled);
        const meta = normalizeSystemMeta(res.provider);
        setSaved(meta);
        if (meta) {
          setProviderType(meta.provider_type || 'openai-compatible');
          setEndpoint(meta.endpoint || '');
          setModel(meta.model || '');
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => { alive = false; };
  }, []);

  const onToggle = async (next: boolean) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const res = await putJson<SystemAiState>('/admin/system-ai', { enabled: next });
      setEnabled(res.enabled);
      setNotice(next ? 'System AI enabled' : 'System AI disabled');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onSave = async () => {
    if (busy) return;
    const v = validateSystemProviderInput({
      providerType, endpoint, apiKey, model, isExisting: !!saved,
    });
    if (!v.ok) { setError(v.error || 'Invalid input'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const res = await putJson<SystemAiState>('/admin/system-ai', { provider: v.body });
      const meta = normalizeSystemMeta(res.provider);
      setSaved(meta);
      // SECURITY INVARIANT: drop the plaintext key from state immediately.
      setApiKey('');
      setNotice('System provider saved');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onTest = async () => {
    if (testing || busy) return;
    setTesting(true); setError(''); setNotice('');
    try {
      const body: Record<string, unknown> = {};
      if (endpoint) body.endpoint = endpoint;
      if (apiKey.trim()) body.api_key = apiKey.trim();
      if (model) body.model = model;
      const res = await postJson<SystemAiTest>('/admin/system-ai/test', body);
      const r = describeTestResult(res);
      if (r.kind === 'ok') setNotice('Connection OK' + (res.model ? ` · ${res.model}` : ''));
      else setError(`Connection failed: ${r.text}`);
    } catch (e) {
      setError(`Connection failed: ${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  const onTypeChange = (next: ProviderType) => {
    setProviderType(next);
    if (next === 'openrouter' && (!endpoint || endpoint === 'https://api.example.com/v1')) {
      setEndpoint(OPENROUTER_DEFAULT_ENDPOINT);
    } else if (next !== 'openrouter' && endpoint === OPENROUTER_DEFAULT_ENDPOINT) {
      setEndpoint('');
    }
  };

  const statusPill = saved ? statusLabel(saved.status) : null;

  return (
    <section class="page settings-page">
      <div class="settings-page__scroll">
        <div class="card card--stack">
          <h3 class="card__title">System AI Control</h3>
          <p class="card__hint card__hint--wrap">
            Platform-level AI. Turning this off blocks all system/provider AI
            calls. Personal (workspace) providers are not affected.
          </p>

          {!loaded ? (
            <p class="card__hint">Loading…</p>
          ) : (
            <>
              <div class="settings__group" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Switch
                  checked={enabled === true}
                  onChange={(v) => onToggle(v)}
                  ariaLabel="System AI enabled"
                />
                <span class="card__label" style={{ margin: 0 }}>
                  {enabled === true ? 'System AI: ON' : 'System AI: OFF'}
                </span>
              </div>

              <hr style={{ opacity: 0.15, margin: '12px 0' }} />

              <h3 class="card__title">System Provider</h3>
              <p class="card__hint card__hint--wrap">
                {saved
                  ? `${saved.endpoint}${saved.model ? ` · ${saved.model}` : ''} · ${saved.api_key_masked}`
                  : 'No system provider configured (env fallback applies when enabled).'}
              </p>

              {saved && statusPill && (
                <p class="card__hint">Status: {statusPill.text}</p>
              )}

              <p class="card__label">Provider type</p>
              <select
                class="select"
                value={providerType}
                aria-label="Provider type"
                disabled={busy}
                onChange={(e) => onTypeChange((e.target as HTMLSelectElement).value as ProviderType)}
              >
                {VALID_PROVIDER_TYPES.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>

              <p class="card__label">Endpoint</p>
              <input
                class="settings__input"
                value={endpoint}
                placeholder={providerType === 'openrouter' ? OPENROUTER_DEFAULT_ENDPOINT : 'https://api.example.com/v1'}
                aria-label="Endpoint"
                disabled={busy}
                onInput={(e) => setEndpoint((e.target as HTMLInputElement).value)}
              />

              <p class="card__label">API key</p>
              <input
                class="settings__input"
                type="password"
                autocomplete="off"
                value={apiKey}
                placeholder={saved?.configured ? '•••• (leave empty to keep)' : 'sk-...'}
                aria-label="API key"
                disabled={busy}
                onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
              />
              {saved?.configured && (
                <p class="card__hint">Configured — key is stored encrypted and never shown.</p>
              )}

              <p class="card__label">Model</p>
              <input
                class="settings__input"
                value={model}
                placeholder="e.g. qwen/qwen3-32b"
                aria-label="Model"
                disabled={busy}
                onInput={(e) => setModel((e.target as HTMLInputElement).value)}
              />

              <div class="settings__group">
                <button class="btn" onClick={onSave} disabled={busy || !endpoint}>
                  {busy ? 'Saving…' : 'Save provider'}
                </button>
                <button class="btn btn--outlined" onClick={onTest} disabled={testing || busy}>
                  {testing ? 'Testing…' : 'Test connection'}
                </button>
              </div>

              {notice && <p class="card__hint" style={{ color: 'var(--color-accent, #4caf50)' }}>{notice}</p>}
              {error && <ErrorText message={error} />}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
