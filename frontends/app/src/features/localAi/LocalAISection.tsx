// ─────────────────────────────────────────────────────────────────────────
// Local AI Connector section — /settings/local-ai (Local AI Connector V1, Phase 6)
// ─────────────────────────────────────────────────────────────────────────
// The USER-FACING flow for the Local AI Connector V1 (docs/04-planning/
// local-ai-connector-v1.md §15 Phase 6):
//
//   create connector → one-time registration token (+ CLI instruction)
//   → status (Pending / Online / Offline; runtime reachability distinct)
//   → Refresh Models (explicit discovery — never automatic, AD-7)
//   → bind as the workspace AI provider (existing PUT /settings/ai/provider
//     singleton — Connector ≠ Provider, AD-2)
//   → Test Connection (user-initiated max_tokens:1 probe, cold-load warning)
//   → rotate / revoke (existing atomic lifecycle).
//
// Model honesty (§7): "discovered" models are reported ids — NEVER shown as
// loaded/warm. No inference probe runs on page open.
//
// SECURITY INVARIANT: llmcreg.*/llmc.* plaintext appears ONLY in the one-time
// disclosure modal, held in transient `useState`, dropped on close — never
// persisted, never re-displayable. The status/models responses never carry
// credential material (not even the prefix mask).
// ─────────────────────────────────────────────────────────────────────────

import { useState, useCallback, useEffect, useRef } from 'preact/hooks';
import { t, tf } from '../../app/i18n';
import type { StrKey } from '../../app/i18n';
import { getJson, postJson, putJson, deleteJson, ApiError } from '../../api/client';
import { Modal, toast } from '../../lib/ui';
import { formatLastTested } from '../aiProviders/aiProviders';
import {
  RUNTIME_TYPE_OPTIONS,
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
  REGISTRATION_STEP_KEYS,
  OFFLINE_TROUBLESHOOT_KEYS,
  shareStatus,
  shareStatusKey,
  shareStatusClass,
} from './localAi';
import type {
  AiConnectorStatus,
  AiConnectorModels,
  RegistrationResponse,
  RotateResponse,
  RefreshModelsResponse,
  ConnectorTestResponse,
  LocalProviderMeta,
  AiEndpoint,
} from './localAi';

interface ProviderRead { provider: LocalProviderMeta | null; has_workspace_provider: boolean }

/** One-time credential disclosure (registration token or rotated llmc.*).
 *  The plaintext lives ONLY here, in transient component state. */
function OneTimeCredentialModal({ kind, token, connectorName, regExpiresAt, wsUrl, onClose }: {
  kind: 'register' | 'rotate';
  token: string;
  connectorName: string;
  regExpiresAt?: number | null;
  wsUrl?: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const origin = typeof location !== 'undefined' ? location.origin : '';
  const runCommand = kind === 'register' && wsUrl ? buildRunCommand(token, wsUrl, origin) : null;

  const onCopy = useCallback(async (text: string, mark: (v: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(text);
      mark(true);
      setTimeout(() => mark(false), 1800);
    } catch (_) {
      toast(t('worker_copy_failed'));
    }
  }, []);

  return (
    <Modal
      title={kind === 'register' ? t('local_ai_reg_title') : `${t('worker_rotate')} — ${connectorName}`}
      onClose={onClose}
    >
      <>
        <p class="modal__notice worker__warn">{t('local_ai_credential_warning')}</p>
        {kind === 'register' && regTokenExpired(regExpiresAt) && (
          <p class="settings-page__error">{t('local_ai_reg_expired')}</p>
        )}
        <p class="card__label">{t('local_ai_reg_token_label')}</p>
        <div class="worker__cred">
          <code class="worker__token">{token}</code>
          <button class="btn btn--outlined" onClick={() => void onCopy(token, setCopied)}>
            {copied ? t('worker_copied') : t('worker_copy')}
          </button>
        </div>

        {kind === 'register' && (
          <>
            <p class="card__label">{t('local_ai_setup_title')}</p>
            <p class="card__hint card__hint--wrap">{t('local_ai_setup_intro')}</p>
            <ol class="worker__steps">
              {REGISTRATION_STEP_KEYS.map((k) => (
                <li key={k}>{t(k)}</li>
              ))}
            </ol>
            {runCommand && (
              <>
                <p class="card__label">{t('local_ai_run_command_label')}</p>
                <div class="worker__cred">
                  <code class="worker__token">{runCommand}</code>
                  <button class="btn btn--outlined" onClick={() => void onCopy(runCommand, setCopiedCmd)}>
                    {copiedCmd ? t('worker_copied') : t('worker_copy')}
                  </button>
                </div>
              </>
            )}
            <p class="card__hint card__hint--wrap">{t('local_ai_reg_ttl_hint')}</p>
          </>
        )}
        {kind === 'rotate' && (
          <p class="card__hint card__hint--wrap">{t('local_ai_rotate_hint')}</p>
        )}
        <div class="modal__footer">
          <button class="btn" onClick={onClose}>{t('worker_done')}</button>
        </div>
      </>
    </Modal>
  );
}

export function LocalAISection() {
  const [connectors, setConnectors] = useState<AiConnectorStatus[] | null>(null);
  const [modelsBy, setModelsBy] = useState<Record<string, string[]>>({});
  const [provider, setProvider] = useState<LocalProviderMeta | null>(null);
  const [name, setName] = useState('');
  const [runtimeType, setRuntimeType] = useState<string>('ollama');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [testOk, setTestOk] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<AiConnectorStatus | null>(null);
  // One-time disclosure — transient state only (never persisted).
  const [disclosure, setDisclosure] = useState<
    { kind: 'register' | 'rotate'; token: string; connectorName: string; regExpiresAt?: number | null; wsUrl?: string } | null
  >(null);
  // Per-connector model selection for the provider binding (transient).
  const [bindingModel, setBindingModel] = useState<Record<string, string>>({});
  // LLM Sharing Phase 1 — endpoints by connector id (owner view).
  const [endpointsBy, setEndpointsBy] = useState<Record<string, AiEndpoint[]>>({});
  const [confirmShare, setConfirmShare] = useState<AiEndpoint | null>(null);

  // Fresh-value refs so the polling interval (mounted once) actually sees
  // the CURRENT busy/confirmRevoke state — a stale closure here would keep
  // polling during operations and let slow polls overlap.
  const busyRef = useRef(false);
  const confirmRevokeRef = useRef<AiConnectorStatus | null>(null);
  const pollInFlight = useRef(false);

  const loadStatus = useCallback(async () => {
    // In-flight dedup: a slow poll never stacks on top of a newer one.
    if (pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      const [st, models, prov, eps] = await Promise.all([
        getJson<{ connectors: AiConnectorStatus[] }>('/ai-connector/status'),
        getJson<{ connectors: AiConnectorModels[] }>('/ai-connector/models'),
        getJson<ProviderRead>('/settings/ai/provider'),
        // LLM Sharing Phase 1: owner's endpoint rows (401/404 silently
        // ignored — an account without endpoints sees none).
        getJson<{ endpoints: AiEndpoint[] }>('/ai-endpoints').catch(() => ({ endpoints: [] as AiEndpoint[] })),
      ]);
      setConnectors(st.connectors);
      const by: Record<string, string[]> = {};
      for (const c of models.connectors) by[c.connector_id] = c.models;
      setModelsBy(by);
      setProvider(prov.provider && prov.provider.provider_type === 'local-ai' ? prov.provider : null);
      const eby: Record<string, AiEndpoint[]> = {};
      for (const e of eps.endpoints || []) {
        (eby[e.connector_id] = eby[e.connector_id] || []).push(e);
      }
      setEndpointsBy(eby);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pollInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    // Keep the refs current for the mounted-once interval below.
    busyRef.current = busy;
    confirmRevokeRef.current = confirmRevoke;
  }, [busy, confirmRevoke]);

  useEffect(() => {
    let alive = true;
    (async () => {
      await loadStatus();
      if (alive) setLoaded(true);
    })();
    // Read-only status polling (PG + in-memory registry — no runtime probe,
    // no inference; AD-7 intact). Light cadence; paused while busy or while
    // a confirm/revoke dialog is open.
    const timer = setInterval(() => {
      if (!busyRef.current && !confirmRevokeRef.current) void loadStatus();
    }, 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const onCreate = async () => {
    if (creating) return;
    const v = validateCreateInput(name, runtimeType);
    if (!v.ok) { setError(t(v.error as StrKey)); return; }
    setCreating(true); setError(''); setNotice(''); setTestOk(null);
    try {
      const res = await postJson<RegistrationResponse>('/ai-connector/registrations', {
        name: v.name,
        runtime_type: v.runtime_type,
      });
      // One-time disclosure — the ONLY place the plaintext token appears.
      if (looksLikeRegToken(res.reg_token)) {
        setDisclosure({
          kind: 'register',
          token: res.reg_token,
          connectorName: res.connector.name,
          regExpiresAt: res.reg_expires_at,
          wsUrl: res.ws_url,
        });
      }
      setName('');
      await loadStatus();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setCreating(false);
    }
  };

  const onReissueToken = async (c: AiConnectorStatus) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice(''); setTestOk(null);
    try {
      const res = await getJson<RegistrationResponse>(
        `/ai-connector/registrations/${encodeURIComponent(c.connector_id)}/token`
      );
      if (looksLikeRegToken(res.reg_token)) {
        setDisclosure({
          kind: 'register',
          token: res.reg_token,
          connectorName: c.name,
          regExpiresAt: res.reg_expires_at,
          wsUrl: res.ws_url,
        });
      }
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const onRefreshModels = async (c: AiConnectorStatus) => {
    if (refreshingId) return;
    setRefreshingId(c.connector_id); setError(''); setNotice(''); setTestOk(null);
    try {
      const res = await postJson<RefreshModelsResponse>(
        `/ai-connector/connectors/${encodeURIComponent(c.connector_id)}/models/refresh`
      );
      if (res.ok && res.models) {
        setModelsBy((m) => ({ ...m, [c.connector_id]: res.models! }));
        setNotice(tf('local_ai_models_refreshed', String(res.models.length)));
      } else {
        setError(t(connectorErrorKey(res.code || '') as StrKey));
      }
    } catch (e) {
      setError(humanError(e));
    } finally {
      setRefreshingId(null);
    }
  };

  const onBind = async (c: AiConnectorStatus) => {
    if (busy) return;
    const model = (bindingModel[c.connector_id] ?? '').trim();
    if (!model && !(modelsBy[c.connector_id] ?? []).length) {
      setError(t('local_ai_err_no_models'));
      return;
    }
    setBusy(true); setError(''); setNotice(''); setTestOk(null);
    try {
      await putJson<ProviderRead>('/settings/ai/provider', {
        provider_type: 'local-ai',
        connector_id: c.connector_id,
        model,
      });
      setNotice(tf('local_ai_bound', c.name));
      await loadStatus();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const onUnbind = async () => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await deleteJson('/settings/ai/provider');
      setProvider(null);
      setNotice(t('local_ai_unbound'));
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const onTest = async (c: AiConnectorStatus) => {
    if (testingId) return;
    setTestingId(c.connector_id); setError(''); setNotice(''); setTestOk(null);
    try {
      const body: Record<string, unknown> = { provider_type: 'local-ai', connector_id: c.connector_id };
      const model = (bindingModel[c.connector_id] ?? '').trim();
      if (model) body.model = model;
      const res = await postJson<ConnectorTestResponse>('/settings/ai/test', body);
      if (res.ok) {
        setTestOk(res.model || c.name);
      } else {
        setError(tf('local_ai_test_fail', t(connectorErrorKey(res.code || '') as StrKey)));
      }
      await loadStatus(); // status pill reflects the persisted test outcome
    } catch (e) {
      setError(tf('local_ai_test_fail', humanError(e)));
    } finally {
      setTestingId(null);
    }
  };

  const onRotate = async (c: AiConnectorStatus) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice(''); setTestOk(null);
    try {
      const res = await postJson<RotateResponse>(
        `/ai-connector/connectors/${encodeURIComponent(c.connector_id)}/rotate`
      );
      if (looksLikeConnectorCredential(res.token)) {
        setDisclosure({ kind: 'rotate', token: res.token, connectorName: c.name });
      }
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const onRevoke = async (c: AiConnectorStatus) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice(''); setTestOk(null);
    try {
      await deleteJson(`/ai-connector/connectors/${encodeURIComponent(c.connector_id)}`);
      setConfirmRevoke(null);
      setNotice(tf('local_ai_revoked', c.name));
      await loadStatus();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  // ── LLM Sharing Phase 1 — Share this AI ─────────────────────────────────
  // Minimal owner-side control plane: create endpoint (Private), enable /
  // disable sharing, delete. NEVER shows credentials, local IP, runtime URL
  // or filesystem info — the backend endpoint shape has none of it.

  const onCreateEndpoint = async (c: AiConnectorStatus) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice(''); setTestOk(null);
    try {
      const res = await postJson<{ endpoint: AiEndpoint }>('/ai-endpoints', {
        name: `${c.name} endpoint`,
        connector_id: c.connector_id,
        runtime_type: c.runtime_type,
      });
      setNotice(tf('share_ai_endpoint_created', res.endpoint.name));
      await loadStatus();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const onShare = async (e: AiEndpoint) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice(''); setTestOk(null);
    try {
      await postJson(`/ai-endpoints/${encodeURIComponent(e.endpoint_id)}/share`, {
        confirm_share: true,
      });
      setConfirmShare(null);
      setNotice(t('share_ai_enabled_notice'));
      await loadStatus();
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  const onUnshare = async (e: AiEndpoint) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice(''); setTestOk(null);
    try {
      await deleteJson(`/ai-endpoints/${encodeURIComponent(e.endpoint_id)}/share`);
      setNotice(t('share_ai_disabled_notice'));
      await loadStatus();
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  const onDeleteEndpoint = async (e: AiEndpoint) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice(''); setTestOk(null);
    try {
      await deleteJson(`/ai-endpoints/${encodeURIComponent(e.endpoint_id)}`);
      setNotice(t('share_ai_endpoint_deleted'));
      await loadStatus();
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  const boundConnectorId = provider?.connector_id ?? null;

  return (
    <section class="page settings-page">
      <div class="settings-page__scroll">
        {/* ── Active provider binding (Connector ≠ Provider, AD-2) ── */}
        <div class="card card--stack">
          <h3 class="card__title">{t('local_ai_title')}</h3>
          <p class="card__hint card__hint--wrap">{t('local_ai_desc')}</p>
          {!loaded ? (
            <p class="card__hint">{t('play_loading')}</p>
          ) : provider ? (
            <>
              <p class="card__hint card__hint--wrap">
                {t('local_ai_binding_active')}
                {` · ${provider.model ?? t('local_ai_model_auto')}`}
                {` · ${t('ai_provider_last_tested')}: ${formatLastTested(provider.last_tested_at)}`}
              </p>
              <div class="settings__actions">
                <button class="btn btn--outlined btn--error" onClick={() => void onUnbind()} disabled={busy}>
                  {t('local_ai_unbind')}
                </button>
              </div>
            </>
          ) : (
            <p class="card__hint card__hint--wrap">{t('local_ai_binding_none')}</p>
          )}
        </div>

        {/* ── Add connector ── */}
        <div class="card card--stack">
          <h3 class="card__title">{t('local_ai_add_title')}</h3>
          <p class="card__label">{t('local_ai_name_label')}</p>
          <input
            class="settings__input"
            value={name}
            placeholder={t('local_ai_name_hint')}
            aria-label={t('local_ai_name_label')}
            disabled={creating}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
          <p class="card__label">{t('local_ai_runtime_label')}</p>
          <select
            class="select"
            value={runtimeType}
            aria-label={t('local_ai_runtime_label')}
            disabled={creating}
            onChange={(e) => setRuntimeType((e.target as HTMLSelectElement).value)}
          >
            {RUNTIME_TYPE_OPTIONS.map(({ type, labelKey }) => (
              <option key={type} value={type}>{t(labelKey)}</option>
            ))}
          </select>
          <p class="card__hint card__hint--wrap">{t('local_ai_add_hint')}</p>
          <div class="settings__actions">
            <button class="btn btn--block" onClick={() => void onCreate()} disabled={creating}>
              {creating ? t('play_loading') : t('local_ai_create')}
            </button>
          </div>
        </div>

        {/* ── Connector list ── */}
        <div class="card card--stack">
          <h3 class="card__title">{t('local_ai_list_title')}</h3>
          {!loaded ? (
            <p class="card__hint">{t('play_loading')}</p>
          ) : !connectors || connectors.length === 0 ? (
            <p class="card__hint card__hint--wrap">{t('local_ai_empty')}</p>
          ) : (
            <div class="worker__list">
              {connectors.map((c) => {
                const models = modelsBy[c.connector_id] ?? [];
                const isBound = boundConnectorId === c.connector_id;
                const reachable = runtimeReachable(c);
                const rtInfo = runtimeInfo(c);
                const endpoints = endpointsBy[c.connector_id] ?? [];
                return (
                  <div class="worker__row" key={c.connector_id}>
                    <div class="worker__row-main">
                      <span class="worker__name">{c.name}</span>
                      <span class="worker__row-badges">
                        {isBound && (
                          <span class="worker__badge worker__badge--private">{t('local_ai_bound_badge')}</span>
                        )}
                        <span class={'worker__status ' + statusClass(c)}>{t(statusKey(c))}</span>
                      </span>
                    </div>
                    <div class="worker__row-meta">
                      <span>{t(RUNTIME_TYPE_OPTIONS.find((o) => o.type === c.runtime_type)?.labelKey ?? 'local_ai_runtime_openai_compatible')}</span>
                      <span>·</span>
                      <span>{t('worker_last_seen')} {formatLastSeen(c.last_seen)}</span>
                      <span>·</span>
                      {/* Runtime reachability — distinct from Online (§7) */}
                      <span>{reachable ? t('local_ai_runtime_ok') : t('local_ai_runtime_unknown')}</span>
                      {rtInfo.length > 0 && (<><span>·</span><span>{rtInfo.join(' · ')}</span></>)}
                    </div>

                    {/* Discovered models — reported ids, NOT loaded/warm */}
                    <div class="worker__row-meta">
                      <span>{tf('local_ai_models_count', String(c.models_count))}</span>
                      {models.length > 0 && (
                        <>
                          <span>·</span>
                          <span class="local-ai__model-hint">{models.slice(0, 4).join(', ')}{models.length > 4 ? '…' : ''}</span>
                        </>
                      )}
                    </div>
                    <p class="card__hint">{t('local_ai_models_disclaimer')}</p>

                    {/* ── LLM Sharing Phase 1: Share this AI (minimal
                        owner-side control plane — no marketplace) ── */}
                    <div class="worker__row-meta">
                      <span class="card__label">{t('share_ai_title')}</span>
                    </div>
                    {endpoints.length === 0 ? (
                      <>
                        <p class="card__hint card__hint--wrap">{t('share_ai_no_endpoint_hint')}</p>
                        {c.status !== 'pending' && (
                          <div class="settings__actions">
                            <button
                              class="btn btn--outlined"
                              disabled={busy}
                              title={t('share_ai_create_endpoint_hint')}
                              onClick={() => void onCreateEndpoint(c)}
                            >
                              {t('share_ai_create_endpoint')}
                            </button>
                          </div>
                        )}
                      </>
                    ) : (
                      endpoints.map((ep) => {
                        const ss = shareStatus(ep);
                        return (
                          <div class="worker__row-meta" key={ep.endpoint_id}>
                            <span>{ep.name}</span>
                            <span>·</span>
                            <span class={'worker__status ' + shareStatusClass(ss)}>{t(shareStatusKey(ss) as StrKey)}</span>
                            <span>·</span>
                            <span>{tf('share_ai_concurrency_label', String(ep.concurrency_limit))}</span>
                            <span>·</span>
                            <span>{tf('local_ai_models_count', String(ep.models_discovered))}</span>
                            {ep.model && (
                              <>
                                <span>·</span>
                                <span>{tf('share_ai_models_label', ep.model)}</span>
                              </>
                            )}
                            <div class="settings__actions">
                              {!ep.sharing_enabled ? (
                                <button
                                  class="btn btn--outlined"
                                  disabled={busy}
                                  onClick={() => setConfirmShare(ep)}
                                >
                                  {t('share_ai_share_button')}
                                </button>
                              ) : (
                                <button class="btn btn--outlined" disabled={busy} onClick={() => void onUnshare(ep)}>
                                  {t('share_ai_unshare_button')}
                                </button>
                              )}
                              <button
                                class="btn btn--outlined btn--error"
                                disabled={busy}
                                onClick={() => void onDeleteEndpoint(ep)}
                              >
                                {t('worker_delete')}
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}

                    {/* Model picker for the provider binding (free text or a
                        discovered id — the no-registry principle). */}
                    <p class="card__label">{t('ai_provider_model')}</p>
                    <input
                      class="settings__input"
                      value={bindingModel[c.connector_id] ?? ''}
                      placeholder={models.length ? models[0] : t('local_ai_model_pick_hint')}
                      aria-label={t('ai_provider_model')}
                      disabled={busy}
                      onInput={(e) => setBindingModel((m) => ({
                        ...m, [c.connector_id]: (e.target as HTMLInputElement).value,
                      }))}
                    />

                    {c.status === 'pending' && (
                      <p class="card__hint card__hint--wrap">{t('local_ai_pending_hint')}</p>
                    )}
                    {statusKey(c) === 'local_ai_status_offline' && (
                      <details class="worker__trouble">
                        <summary>{t('worker_trouble_title')}</summary>
                        <ul class="worker__steps">
                          {OFFLINE_TROUBLESHOOT_KEYS.map((k) => (
                            <li key={k}>{t(k)}</li>
                          ))}
                        </ul>
                      </details>
                    )}

                    <div class="worker__actions">
                      {c.status === 'pending' && (
                        <button class="btn btn--outlined" disabled={busy} onClick={() => void onReissueToken(c)}>
                          {t('local_ai_reissue_token')}
                        </button>
                      )}
                      <button
                        class="btn btn--outlined"
                        disabled={refreshingId === c.connector_id}
                        onClick={() => void onRefreshModels(c)}
                      >
                        {refreshingId === c.connector_id ? t('play_loading') : t('local_ai_refresh_models')}
                      </button>
                      <button
                        class="btn btn--outlined"
                        disabled={testingId === c.connector_id || c.status === 'pending'}
                        title={t('local_ai_test_cold_warning')}
                        onClick={() => void onTest(c)}
                      >
                        {testingId === c.connector_id ? t('play_loading') : t('ai_provider_test')}
                      </button>
                      <button class="btn" disabled={busy} onClick={() => void onBind(c)}>
                        {isBound ? t('local_ai_rebind') : t('local_ai_bind')}
                      </button>
                      {c.status !== 'pending' && (
                        <>
                          <button class="btn btn--outlined" disabled={busy} onClick={() => void onRotate(c)}>
                            {t('worker_rotate_short')}
                          </button>
                        </>
                      )}
                      <button class="btn btn--outlined btn--error" disabled={busy} onClick={() => setConfirmRevoke(c)}>
                        {t('worker_revoke')}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {(testOk || notice || error) && (
            <div class="settings__feedback">
              {testOk && (
                <p class="settings-page__success">
                  <svg class="settings-page__success-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="16" height="16"><path d="M20 6L9 17l-5-5" /></svg>
                  {t('ai_provider_test_ok')}{testOk ? ` · ${testOk}` : ''}
                </p>
              )}
              {notice && <p class="card__hint">{notice}</p>}
              {error && <p class="settings-page__error">{error}</p>}
            </div>
          )}
        </div>
      </div>

      {/* One-time credential disclosure modal(s) */}
      {disclosure && (
        <OneTimeCredentialModal
          kind={disclosure.kind}
          token={disclosure.token}
          connectorName={disclosure.connectorName}
          regExpiresAt={disclosure.regExpiresAt}
          wsUrl={disclosure.wsUrl}
          onClose={() => setDisclosure(null)}
        />
      )}

      {/* Revoke confirmation */}
      {confirmRevoke && (
        <Modal
          title={t('worker_revoke')}
          onClose={() => { if (!busy) setConfirmRevoke(null); }}
        >
          <>
            <p class="modal__notice">{tf('local_ai_revoke_confirm', confirmRevoke.name)}</p>
            <p class="card__hint card__hint--wrap">{t('local_ai_revoke_hint')}</p>
            <div class="modal__footer">
              <button class="btn btn--outlined" onClick={() => { if (!busy) setConfirmRevoke(null); }} disabled={busy}>
                {t('dialog_cancel')}
              </button>
              <button class="btn btn--error" onClick={() => void onRevoke(confirmRevoke)} disabled={busy}>
                {busy ? t('play_loading') : t('worker_revoke')}
              </button>
            </div>
          </>
        </Modal>
      )}

      {/* Share confirmation (LLM Sharing Phase 1 — explicit owner consent) */}
      {confirmShare && (
        <Modal
          title={t('share_ai_share_button')}
          onClose={() => { if (!busy) setConfirmShare(null); }}
        >
          <>
            <p class="modal__notice">{t('share_ai_enable_confirm')}</p>
            <p class="card__hint card__hint--wrap">{t('share_ai_create_endpoint_hint')}</p>
            <div class="modal__footer">
              <button class="btn btn--outlined" onClick={() => { if (!busy) setConfirmShare(null); }} disabled={busy}>
                {t('dialog_cancel')}
              </button>
              <button class="btn" onClick={() => void onShare(confirmShare)} disabled={busy}>
                {busy ? t('play_loading') : t('share_ai_share_button')}
              </button>
            </div>
          </>
        </Modal>
      )}
    </section>
  );
}

/** Sanitized error surface: no raw stack traces, no URLs, no secrets. */
function humanError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return t('local_ai_err_not_found');
    if (e.status === 401) return t('local_ai_err_auth');
    if (e.status === 403) return t('local_ai_err_forbidden');
    if (e.status === 429) return t('local_ai_err_rate_limited');
    return e.message || t('local_ai_err_generic');
  }
  return (e as Error).message || t('local_ai_err_generic');
}
