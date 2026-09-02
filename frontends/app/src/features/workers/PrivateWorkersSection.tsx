// ─────────────────────────────────────────────────────────────────────────
// /settings/private-workers — Private Worker Setup Center (Phase 3.1)
// ─────────────────────────────────────────────────────────────────────────
// Canonical onboarding flow: Setup Contract driven wizard
//   profile → installation mode → platform → create worker (one-time key)
//   → installer/workflows/instructions (all metadata from the API).
//
// The legacy single-file flow (download worker.cjs / node worker.cjs) is NO
// LONGER the main path; its helpers + strings remain as a compatibility
// fallback (rendered only if the Setup Contract instructions fail).
//
// SECURITY: the Worker Key is a ONE-TIME disclosure held in transient
// component state only — never persisted (localStorage/URL) or logged.
import { useState, useCallback, useEffect } from 'preact/hooks';
import { getJson, postJson, deleteJson, ApiError } from '../../api/client';
import type { StrKey } from '../../app/i18n';
import { t, tf } from '../../app/i18n';
import { IconAdd } from '../../app/icons';
import { authMe } from '../../state/authStore';
import { Modal, toast } from '../../lib/ui';
import {
  type PrivateWorker,
  validateCreateInput, looksLikeWorkerToken,
  statusClass, statusKey, formatLastSeen, buildSetupContract,
  renderEnvBlock, OFFLINE_TROUBLESHOOT_KEYS,
} from './privateWorkers';
import { SharingModal, SharedWithMeView, CommunityView } from './WorkerSharingUI';
import {
  type SharedWithMeWorker,
  probeShareFeature, shareFeatureEnabled, fetchSharedWithMe, fetchShareState, shareModeOf, canBeShared,
} from './sharing';
import { sharedWithMeCount, sharedUnreadCount, syncSharedWithMe, markSharedSeen, onShareNotice } from './shareNotifications';
import {
  type SetupProfile, type SetupMethod, type SetupWorkflow, type SetupInstructions,
  type SetupWorkerDetail, type WizardState, type DeploymentCapability,
  fetchSetupProfiles, fetchSetupMethods, fetchSetupWorkflows,
  fetchSetupInstructions, fetchSetupWorkerStatus,
  resolveArtifactUrl, installerDownloadUrl, installerVersion, installerSha256,
  groupProfilesByType, deploymentOptions, pickMethod,
  linuxModeAvailability,
  setupStatusKey, setupStatusClass, initialWizardState, canGoNext,
  nextStep, prevStep, stepTitleKey, stepBodyKey, formatDiskBudget,
} from './workerSetup';

export function PrivateWorkersSection() {
  const [workers, setWorkers] = useState<PrivateWorker[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Setup Center wizard (replaces the old name+type modal as the main path).
  const [wizardOpen, setWizardOpen] = useState(false);

  // Extended worker details (Setup Contract status model).
  const [detailsFor, setDetailsFor] = useState<PrivateWorker | null>(null);

  // One-time key disclosure after a rotation (secure lifecycle unchanged:
  // transient state only, cleared on close).
  const [rotated, setRotated] = useState<{ token: string; worker: PrivateWorker } | null>(null);

  // ── SH-2 sharing layer (kill-switch aware) ────────────────────────────
  // The capability probe runs once; when SHARE_FEATURES_ENABLED is off the
  // tabs below never render and NO V2 endpoint is ever called (every row
  // then simply renders its true Private badge — nothing can be shared).
  const [tab, setTab] = useState<'my' | 'shared' | 'community'>('my');
  const [shared, setShared] = useState<SharedWithMeWorker[] | null>(null);
  const [sharedLoading, setSharedLoading] = useState(false);
  const [sharedError, setSharedError] = useState('');
  // Per-own-worker sharing mode for row badges (server truth, re-read).
  const [shareStates, setShareStates] = useState<Record<string, 'off' | 'public' | 'users'>>({});
  const [sharingFor, setSharingFor] = useState<PrivateWorker | null>(null);

  const shareOn = shareFeatureEnabled.value === true;
  const authed = !!authMe.value.authenticated;

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await getJson<{ workers: PrivateWorker[] }>('/workers');
      setWorkers(res.workers);
      // Row badges: read the active policy per private worker (a personal
      // list is small — bounded N parallel reads, all owner-scoped).
      if (shareFeatureEnabled.value === true) {
        const entries = await Promise.all(res.workers
          .filter(canBeShared)
          .map(async (w) => {
            try {
              const s = await fetchShareState(w.worker_id);
              return [w.worker_id, shareModeOf(s.policy)] as const;
            } catch { return [w.worker_id, 'off'] as const; }
          }));
        setShareStates(Object.fromEntries(entries));
      } else {
        setShareStates({});
      }
    } catch (e) {
      setError(humanError(e));
    }
  }, []);

  // "Shared with me" — ALWAYS a fresh server read (never a cached grant):
  // revocation and expiry simply stop the entry from arriving.
  const loadShared = useCallback(async (markSeen: boolean) => {
    if (shareFeatureEnabled.value !== true || !authMe.value.authenticated) return;
    setSharedLoading(true); setSharedError('');
    try {
      const list = await fetchSharedWithMe();
      setShared((prev) => {
        syncSharedWithMe(prev ?? [], list);
        return list;
      });
      if (markSeen) markSharedSeen(list);
    } catch (e) {
      setSharedError(humanError(e));
      setShared([]);
    } finally {
      setSharedLoading(false);
    }
  }, []);

  useEffect(() => {
    void probeShareFeature().then((on) => { if (on) void loadShared(false); });
  }, [loadShared]);

  // Notification seam: until a real transport exists, notices are derived
  // from the state diff (syncSharedWithMe) — rendered as toasts here.
  useEffect(() => (
    onShareNotice((n) => {
      toast(tf('share_notification', n.actor_username ?? '—', n.worker_name ?? '—'), 4000);
    })
  ), []);

  const onTab = useCallback((next: 'my' | 'shared' | 'community') => {
    setTab(next);
    if (next === 'shared') void loadShared(true);
  }, [loadShared]);

  useEffect(() => { void load(); }, [load]);

  const onRotate = useCallback(async (worker: PrivateWorker) => {
    if (busy || !confirm(t('worker_rotate_confirm'))) return;
    setBusy(true); setError('');
    try {
      const res = await postJson<{ worker: PrivateWorker; token: string }>(
        `/workers/${worker.worker_id}/rotate`, {});
      // Rotating disconnects the current worker until it receives the new
      // credential — disclose the new one-time key exactly as on create.
      setRotated({ token: res.token, worker: res.worker });
      await load();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }, [busy, load]);

  const onRevoke = useCallback(async (worker: PrivateWorker) => {
    if (busy || !confirm(t('worker_revoke_confirm'))) return;
    setBusy(true); setError('');
    try {
      await deleteJson(`/workers/${worker.worker_id}`);
      toast(t('worker_revoked'));
      await load();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }, [busy, load]);

  // Permanent delete of an ALREADY REVOKED worker — the backend hard-deletes
  // the registry row and clears every derived state (auth mirror, heartbeat,
  // hub GPU registry), so the worker can never resurface (reload/re-login).
  const onDelete = useCallback(async (worker: PrivateWorker) => {
    if (busy || !confirm(t('worker_delete_confirm'))) return;
    setBusy(true); setError('');
    try {
      await deleteJson(`/workers/${worker.worker_id}/purge`);
      toast(t('worker_deleted'));
      await load();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }, [busy, load]);

  return (
    <section class="page settings-page">
      <div class="settings-page__scroll">
        <div class="card card--stack">
          <h3 class="card__title">{t('worker_mgmt_title')}</h3>
          <p class="card__hint card__hint--wrap">{t('worker_mgmt_desc')}</p>

          {/* «Добавить воркер» always sits ABOVE the three section selectors
              (Мои воркеры / Поделились со мной / Community). */}
          <button class="btn btn--block" onClick={() => setWizardOpen(true)} disabled={busy}>
            <IconAdd width={18} height={18} /> {t('worker_add')}
          </button>

          {/* ── SH-2: three views (My / Shared with me / Community) ──
              Rendered ONLY when the kill-switch is on (no V2 endpoint is
              ever called while it is off; rows then render their Private
              badge — nothing can be shared). */}
          {shareOn && (
            <div class="seg seg--block worker__tabs" role="tablist" aria-label={t('share_btn')}>
              <button
                role="tab" aria-selected={tab === 'my'}
                class={'seg__btn' + (tab === 'my' ? ' seg__btn--active' : '')}
                onClick={() => onTab('my')}
              >{t('share_tab_my')}</button>
              <button
                role="tab" aria-selected={tab === 'shared'}
                class={'seg__btn' + (tab === 'shared' ? ' seg__btn--active' : '')}
                onClick={() => onTab('shared')}
              >
                {t('share_tab_shared_with_me')}
                {sharedUnreadCount.value > 0 && (
                  <span class="share__badge" aria-label={t('share_badge_title')}>{sharedUnreadCount.value}</span>
                )}
                {sharedWithMeCount.value > 0 && sharedUnreadCount.value === 0 && (
                  <span class="share__badge share__badge--muted">{sharedWithMeCount.value}</span>
                )}
              </button>
              <button
                role="tab" aria-selected={tab === 'community'}
                class={'seg__btn' + (tab === 'community' ? ' seg__btn--active' : '')}
                onClick={() => onTab('community')}
              >{t('share_tab_community')}</button>
            </div>
          )}

          {shareOn && tab === 'shared' && (
            <div class="card card--stack">
              <h3 class="card__title">{t('share_swm_title')}</h3>
              {!authed && <p class="card__hint card__hint--wrap">{t('share_login_required')}</p>}
              <SharedWithMeView
                entries={shared ?? []}
                loading={sharedLoading}
                error={sharedError}
              />
            </div>
          )}

          {shareOn && tab === 'community' && (
            <div class="card card--stack">
              <h3 class="card__title">{t('share_community_title')}</h3>
              <CommunityView />
            </div>
          )}

          {(tab === 'my' || !shareOn) && (!workers ? (
            <p class="card__hint">{t('play_loading')}</p>
          ) : workers.length === 0 ? (
            <p class="card__hint">{t('worker_empty')}</p>
          ) : (
            <div class="worker__list">
              {workers.map((w) => (
                <div class="worker__row" key={w.worker_id}>
                  <div class="worker__row-main">
                    <span class="worker__name">{w.name}</span>
                    {/* Access-mode badge (Private/Public) sits immediately to
                        the LEFT of the Online/Offline status pill. */}
                    <span class="worker__row-badges">
                      <span
                        class={'worker__badge ' + (shareStates[w.worker_id] === 'public' ? 'worker__badge--public' : 'worker__badge--private')}
                        aria-label={t(shareStates[w.worker_id] === 'public' ? 'worker_access_public' : 'worker_access_private')}
                      >
                        {shareStates[w.worker_id] === 'public' ? t('share_public_badge') : t('worker_access_private')}
                      </span>
                      <span class={'worker__status ' + statusClass(w.status)}>{t(statusKey(w.status))}</span>
                    </span>
                  </div>
                  <div class="worker__row-meta">
                    <span>{t(w.worker_type === 'audio' ? 'layer_audio' : w.worker_type === 'image' ? 'layer_image' : 'layer_video')}</span>
                    <span>·</span>
                    <span>{t('worker_last_seen')} {formatLastSeen(w.last_seen)}</span>
                  </div>
                  {w.status === 'OFFLINE' && (
                    <details class="worker__trouble">
                      <summary>{t('worker_trouble_title')}</summary>
                      <p class="card__hint card__hint--wrap">{t('worker_offline_hint')}</p>
                      <ul class="worker__steps">
                        {OFFLINE_TROUBLESHOOT_KEYS.map((k) => (
                          <li key={k}>{t(k)}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <div class="worker__actions">
                    <button class="btn btn--outlined" disabled={busy} onClick={() => setDetailsFor(w)}>
                      {t('worker_details_title')}
                    </button>
                    {/* SH-2: owner sharing controls — private, non-revoked
                        workers only (ownership/mode are never editable here). */}
                    {shareOn && canBeShared(w) && (
                      <button class="btn btn--outlined" disabled={busy} onClick={() => setSharingFor(w)}>
                        {t('share_btn')}
                      </button>
                    )}
                    {w.status !== 'REVOKED' && (
                      <>
                        <button class="btn btn--outlined" disabled={busy} onClick={() => void onRotate(w)}>
                          {busy ? t('play_loading') : t('worker_rotate')}
                        </button>
                        <button class="btn btn--outlined btn--error" disabled={busy} onClick={() => void onRevoke(w)}>
                          {t('worker_revoke')}
                        </button>
                      </>
                    )}
                    {w.status === 'REVOKED' && (
                      <button class="btn btn--outlined btn--error" disabled={busy} onClick={() => void onDelete(w)}>
                        {t('worker_delete')}
                      </button>
                    )}
                    {/* Repair / Reinstall — UI extension point (Phase 3.1 §20).
                        Hidden until the backend/installer expose the capability;
                        never render a fake action. */}
                  </div>
                </div>
              ))}
            </div>
          ))}

          {error && <p class="settings-page__error">{error}</p>}
        </div>
      </div>

      {wizardOpen && (
        <SetupWizard
          onClose={() => { if (!busy) { setWizardOpen(false); void load(); } }}
        />
      )}

      {detailsFor && (
        <WorkerDetailsModal
          worker={detailsFor}
          isPublicShare={shareStates[detailsFor.worker_id] === 'public'}
          onClose={() => setDetailsFor(null)}
        />
      )}

      {sharingFor && (
        <SharingModal
          worker={sharingFor}
          onClose={() => setSharingFor(null)}
          onChanged={() => { void load(); }}
        />
      )}

      {rotated && looksLikeWorkerToken(rotated.token) && (
        <OneTimeKeyModal
          token={rotated.token}
          workerName={rotated.worker.name}
          onClose={() => setRotated(null)}
        />
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// One-time key disclosure after rotation. The key is shown once, copied
// from transient state only, and dropped from memory on close. The worker
// reconnects when the installer/worker process receives the new key.
// ─────────────────────────────────────────────────────────────────────────
function OneTimeKeyModal({ token, workerName, onClose }: {
  token: string; workerName: string; onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (_) {
      toast(t('worker_copy_failed'));
    }
  }, [token]);

  return (
    <Modal title={`${t('worker_rotate')} — ${workerName}`} onClose={onClose}>
      <>
        <p class="modal__notice worker__warn">{t('worker_credential_warning')}</p>
        <p class="card__label">{t('worker_setup_key_title')}</p>
        <div class="worker__cred">
          <code class="worker__token">{token}</code>
          <button class="btn btn--outlined" onClick={() => void onCopy()}>
            {copied ? t('worker_copied') : t('worker_copy')}
          </button>
        </div>
        <p class="card__hint card__hint--wrap">{t('worker_setup_key_installer_note')}</p>
        <div class="modal__footer">
          <button class="btn" onClick={onClose}>{t('worker_done')}</button>
        </div>
      </>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Setup Center wizard — the canonical onboarding flow (Phase 3.1 §10-17).
// Every fact (profiles, versions, URLs, checksums, instructions) comes from
// the Setup Contract API; nothing is hardcoded.
// ─────────────────────────────────────────────────────────────────────────
function SetupWizard({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<WizardState>(initialWizardState);
  const [profiles, setProfiles] = useState<SetupProfile[] | null>(null);
  const [methods, setMethods] = useState<SetupMethod[] | null>(null);
  // The single backend capability model (Platform × Deployment × Availability)
  // — the SAME source of truth the Android client renders.
  const [capabilities, setCapabilities] = useState<DeploymentCapability[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);

  // Worker creation result — the ONE-TIME key lives here only while the
  // wizard is open; closing the wizard drops it from memory.
  const [created, setCreated] = useState<{ token: string; worker: PrivateWorker } | null>(null);
  const [name, setName] = useState('');

  // Install-step data (fetched once the worker exists).
  const [workflows, setWorkflows] = useState<SetupWorkflow[] | null>(null);
  const [instructions, setInstructions] = useState<SetupInstructions | null>(null);
  const [instructionsFailed, setInstructionsFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [p, m] = await Promise.all([fetchSetupProfiles(), fetchSetupMethods()]);
        if (!alive) return;
        setProfiles(p.profiles);
        setMethods(m.methods);
        setCapabilities(m.capabilities ?? null);
      } catch (e) {
        if (alive) setLoadError(humanError(e));
      }
    })();
    return () => { alive = false; };
  }, []);

  const profile = profiles?.find((p) => p.id === state.profileId) ?? null;
  const method = methods && state.platform ? pickMethod(methods, state.platform) : null;
  const deploymentOpts = methods ? deploymentOptions(methods, capabilities, state.mode) : [];
  const selectedOption = deploymentOpts.find(
    (o) => o.platform === state.platform && o.deployment === state.deployment,
  ) ?? null;
  const modeAvail = methods ? linuxModeAvailability(methods) : { managed: false, existing: false };
  const platformOk = !!selectedOption?.selectable;

  const goto = useCallback((step: WizardState['step']) => {
    setState((s) => ({ ...s, step }));
  }, []);

  const onNext = useCallback(() => {
    const n = nextStep(state);
    if (n) goto(n);
  }, [state, goto]);

  const onBack = useCallback(() => {
    const p = prevStep(state);
    if (p) goto(p);
  }, [state, goto]);

  const onCreate = useCallback(async () => {
    if (busy || !profile) return;
    const v = validateCreateInput(name, profile.worker_type);
    if (!v.ok) { setLoadError(t(v.error as StrKey)); return; }
    setBusy(true); setLoadError('');
    try {
      const res = await postJson<{ worker: PrivateWorker; token: string }>('/workers', {
        name: v.name, worker_type: v.worker_type,
      });
      setCreated({ token: res.token, worker: res.worker });
      goto('install');
      // Install-step data — instructions fall back to the legacy contract
      // (compatibility path) if the Setup Contract endpoint fails. The
      // selected platform AND deployment travel together (one capability).
      void (async () => {
        try {
          const [wf, ins] = await Promise.all([
            fetchSetupWorkflows(profile.id),
            fetchSetupInstructions(
              profile.id,
              state.platform ?? 'linux',
              state.mode ?? 'managed',
              state.deployment ?? 'native',
            ),
          ]);
          setWorkflows(wf.workflows);
          setInstructions(ins);
        } catch (_) {
          setInstructionsFailed(true);
        }
      })();
    } catch (e) {
      setLoadError(humanError(e));
    } finally {
      setBusy(false);
    }
  }, [busy, profile, name, state.platform, state.deployment, state.mode, goto]);

  const onCopyKey = useCallback(async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (_) {
      toast(t('worker_copy_failed'));
    }
  }, [created]);

  const nameValid = validateCreateInput(name, profile?.worker_type ?? 'image').ok;
  const canNext = canGoNext(state, { platformSelectable: platformOk, nameValid });

  return (
    <Modal title={t('worker_setup_center_title')} onClose={onClose}>
      <>
        {loadError && <p class="settings-page__error">{loadError}</p>}

        {/* ── Step 1: profile ── */}
        {state.step === 'profile' && (
          !profiles ? <p class="card__hint">{loadError || t('play_loading')}</p> : (
            <div class="setup__step">
              <p class="card__label">{t('worker_setup_choose_profile')}</p>
              <div class="setup__grid">
                {groupProfilesByType(profiles).map(({ worker_type, recommended }) => (
                  <div class="setup__card" key={worker_type}>
                    <span class="setup__card-type">
                      {t(worker_type === 'audio' ? 'layer_audio' : worker_type === 'image' ? 'layer_image' : 'layer_video')}
                    </span>
                    <span class="setup__card-name">{recommended.name}</span>
                    <span class="setup__card-hint">{t('worker_setup_recommended')}</span>
                    {formatDiskBudget(recommended.disk_budget_bytes_approx) && (
                      <span class="setup__card-hint">
                        {tf('worker_setup_disk_budget', formatDiskBudget(recommended.disk_budget_bytes_approx)!)}
                      </span>
                    )}
                    {recommended.status === 'draft' && (
                      <span class="setup__badge">{t('worker_setup_draft_badge')}</span>
                    )}
                    <button
                      class="btn setup__card-btn"
                      onClick={() => { setState((s) => ({ ...s, profileId: recommended.id })); goto('mode'); }}
                    >
                      {t('worker_setup_set_up')}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )
        )}

        {/* ── Step 2: installation mode ── */}
        {state.step === 'mode' && profile && (
          <div class="setup__step">
            <p class="card__label">{t('worker_setup_mode_title')}</p>
            <label class={'setup__choice' + (modeAvail.managed ? '' : ' setup__choice--disabled')}>
              <input
                type="radio" name="setup-mode" value="managed"
                disabled={!modeAvail.managed}
                checked={state.mode === 'managed'}
                onChange={() => { if (modeAvail.managed) setState((s) => ({ ...s, mode: 'managed' })); }}
              />
              <span class="setup__choice-main">
                <span class="setup__choice-title">{t('worker_setup_mode_managed')}</span>
                <span class="card__hint card__hint--wrap">
                  {modeAvail.managed ? t('worker_setup_mode_managed_desc') : t('worker_setup_mode_managed_unavailable')}
                </span>
              </span>
            </label>
            <label class={'setup__choice' + (modeAvail.existing ? '' : ' setup__choice--disabled')}>
              <input
                type="radio" name="setup-mode" value="existing"
                disabled={!modeAvail.existing}
                checked={state.mode === 'existing'}
                onChange={() => { if (modeAvail.existing) setState((s) => ({ ...s, mode: 'existing' })); }}
              />
              <span class="setup__choice-main">
                <span class="setup__choice-title">{t('worker_setup_mode_existing')}</span>
                <span class="card__hint card__hint--wrap">
                  {modeAvail.existing ? t('worker_setup_mode_existing_desc') : t('worker_setup_mode_existing_unavailable')}
                </span>
              </span>
            </label>
            {state.mode === 'existing' && (
              <p class="modal__notice setup__notice">{t('worker_setup_existing_warning')}</p>
            )}
          </div>
        )}

        {/* ── Step 3: platform × deployment (one capability model) ── */}
        {state.step === 'platform' && (
          <div class="setup__step">
            <p class="card__label">{t('worker_setup_platform_title')}</p>
            {deploymentOpts.map((o) => (
              <label class={'setup__choice' + (o.selectable ? '' : ' setup__choice--disabled')} key={o.key}>
                <input
                  type="radio" name="setup-deployment" value={o.key}
                  disabled={!o.selectable}
                  checked={state.platform === o.platform && state.deployment === o.deployment}
                  onChange={() => {
                    if (o.selectable) setState((s) => ({ ...s, platform: o.platform, deployment: o.deployment }));
                  }}
                />
                <span class="setup__choice-main">
                  <span class="setup__choice-title">
                    {o.label}
                    {' '}· {t(o.availabilityKey)}
                  </span>
                  <span class="card__hint">
                    {t(o.stateKey)}
                    {o.selectable && o.installerVersion ? ` · v${o.installerVersion}` : ''}
                  </span>
                  {/* Preview/Experimental: informational notice, never blocking */}
                  {o.selectable && o.notice && (
                    <span class="card__hint card__hint--wrap">{o.notice}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        )}

        {/* ── Step 4: create worker ── */}
        {state.step === 'create' && profile && (
          <div class="setup__step">
            <p class="card__label">{t('worker_setup_create_title')}</p>
            <p class="card__hint card__hint--wrap">{t('worker_setup_create_body')}</p>
            <p class="card__label">{t('worker_name')}</p>
            <input
              class="settings__input"
              value={name}
              placeholder={t('worker_name_hint')}
              aria-label={t('worker_name')}
              disabled={busy}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
            />
          </div>
        )}

        {/* ── Step 5: install ── */}
        {state.step === 'install' && created && profile && (
          <InstallStep
            created={created}
            method={method}
            mode={state.mode ?? 'managed'}
            workflows={workflows}
            instructions={instructions}
            instructionsFailed={instructionsFailed}
            copied={copied}
            onCopyKey={() => void onCopyKey()}
          />
        )}

        <div class="modal__footer">
          {state.step !== 'profile' && state.step !== 'install' && (
            <button class="btn btn--outlined" onClick={onBack} disabled={busy}>
              {t('worker_setup_back')}
            </button>
          )}
          {state.step !== 'install' && state.step !== 'create' && (
            <button class="btn" onClick={onNext} disabled={!canNext}>
              {t('worker_setup_next')}
            </button>
          )}
          {state.step === 'create' && (
            <button class="btn" onClick={() => void onCreate()} disabled={busy || !nameValid}>
              {busy ? t('play_loading') : t('worker_create')}
            </button>
          )}
          {state.step === 'install' && (
            <button class="btn" onClick={onClose}>{t('worker_done')}</button>
          )}
        </div>
      </>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Install step: one-time Worker Key + profile-embedded bootstrap installer
// + workflows + API-driven instructions. Versions/URLs/checksums all come
// from the Setup Contract; the profile/mode are already embedded in the
// bootstrap — nothing is typed. The worker is ALWAYS created before this
// step (wizard 'create') — there is no "create a worker" instruction.
// ─────────────────────────────────────────────────────────────────────────
function InstallStep({ created, method, mode, workflows, instructions, instructionsFailed, copied, onCopyKey }: {
  created: { token: string; worker: PrivateWorker };
  method: SetupMethod | null;
  mode: 'managed' | 'existing';
  workflows: SetupWorkflow[] | null;
  instructions: SetupInstructions | null;
  instructionsFailed: boolean;
  copied: boolean;
  onCopyKey: () => void;
}) {
  // The instructions contract carries the profile-embedded bootstrap URL —
  // the canonical download; the generic method artifact is only a fallback
  // for the loading state.
  const installerUrl = resolveArtifactUrl(installerDownloadUrl(instructions, method));
  const installerVersionStr = installerVersion(instructions, method);
  const installerSha = installerSha256(instructions, method);
  const bundle = method?.worker_bundle ?? null;
  const bundleUrl = resolveArtifactUrl(bundle?.download_url ?? null);
  // Existing ComfyUI without the installer: the runtime bundle is THE artifact.
  const bundlePrimary = mode === 'existing' && !!bundle?.available && !installerUrl;

  return (
    <div class="setup__step setup__install">
      {/* Preview/Experimental deployment — informational notice from the
          backend capability model, never blocking (same copy as the
          installer prints). */}
      {instructions?.availability && instructions.availability !== 'stable' && instructions.notice && (
        <p class="modal__notice setup__notice">{instructions.notice}</p>
      )}

      {/* One-time Worker Key (existing secure lifecycle — Phase 3.1 §14) */}
      <p class="modal__notice worker__warn">{t('worker_credential_warning')}</p>
      <p class="card__label">{t('worker_setup_key_title')}</p>
      <div class="worker__cred">
        <code class="worker__token">{created.token}</code>
        <button class="btn btn--outlined" onClick={onCopyKey}>
          {copied ? t('worker_copied') : t('worker_copy')}
        </button>
      </div>
      <p class="card__hint card__hint--wrap">{t('worker_setup_key_installer_note')}</p>

      {/* Bootstrap installer — version prominent, checksum collapsed (once) */}
      <p class="card__label">{t('worker_setup_installer_title')}</p>
      {installerUrl ? (
        <div class="setup__artifact">
          <span class="setup__artifact-meta">
            {installerVersionStr ? tf('worker_setup_installer_version_line', installerVersionStr) : tf('worker_setup_version_fmt', '—')}
          </span>
          <a class="btn" href={installerUrl} download>
            {t('worker_setup_download_installer')}
          </a>
          {installerSha && (
            <details class="setup__checksum-details">
              <summary>{t('worker_setup_checksum')}</summary>
              <code class="setup__checksum-value">{installerSha}</code>
            </details>
          )}
        </div>
      ) : (
        <p class="card__hint card__hint--wrap">
          {bundle?.available ? t('worker_setup_installer_down_existing_hint') : t('worker_setup_installer_unavailable')}
        </p>
      )}

      {/* Worker runtime bundle — primary artifact for the bundle-based
          Existing ComfyUI flow; otherwise a note (installer provisions it). */}
      {bundle && bundle.available && bundleUrl && bundlePrimary ? (
        <>
          <p class="card__label">{t('worker_setup_bundle_title')}</p>
          <div class="setup__artifact">
            <span class="setup__artifact-meta">
              {tf('worker_setup_version_fmt', bundle.version ?? '—')}
              {bundle.sha256 ? ` · SHA-256: ${bundle.sha256.slice(0, 12)}…` : ''}
            </span>
            <a class="btn" href={bundleUrl} download>
              {t('worker_setup_download_bundle')}
            </a>
          </div>
        </>
      ) : bundle && bundle.available && bundle.version ? (
        <p class="card__hint card__hint--wrap">{tf('worker_setup_bundle_note', bundle.version)}</p>
      ) : null}

      {/* Baseline workflows — OPTIONAL artifacts (never a runtime dependency):
          the installer fetches the profile's workflows itself; these downloads
          exist only for manual experiments in the ComfyUI editor. */}
      <p class="card__label">{t('worker_setup_workflows_title')}</p>
      {workflows === null ? (
        <p class="card__hint">{t('play_loading')}</p>
      ) : workflows.length === 0 ? (
        <p class="card__hint card__hint--wrap">{t('worker_setup_workflow_none')}</p>
      ) : (
        <div class="setup__workflows">
          {workflows.map((wf) => {
            const url = resolveArtifactUrl(wf.download_url);
            return (
              <div class="setup__workflow" key={wf.id}>
                <span class="setup__workflow-name">{wf.name}</span>
                {wf.baseline_available && url ? (
                  <a class="btn btn--outlined" href={url} download>
                    {t('worker_setup_workflow_download')}
                  </a>
                ) : (
                  <span class="card__hint">{t('worker_setup_workflow_unavailable')}</span>
                )}
              </div>
            );
          })}
          <p class="card__hint card__hint--wrap">{t('worker_setup_workflow_optional')}</p>
        </div>
      )}

      {/* Instructions — generated from API metadata (Phase 3.1 §15) */}
      <p class="card__label">{t('worker_setup_instructions_title')}</p>
      {instructions ? (
        <ol class="worker__steps">
          {instructions.steps.map((s) => (
            <li key={s.id}>
              <strong>{t((stepTitleKey(s.id) ?? '') as StrKey, s.title)}</strong>
              <div>{t((stepBodyKey(s.id) ?? '') as StrKey, s.body)}</div>
              {s.code && <pre class="settings__debug worker__env">{s.code}</pre>}
              {s.checksum && (
                <details class="setup__checksum-details">
                  <summary>{t('worker_setup_checksum')}: <code>{s.checksum.value.slice(0, 12)}…</code></summary>
                  <code class="setup__checksum-value">{s.checksum.value}</code>
                  {s.checksum.verify_code && <pre class="settings__debug worker__env">{s.checksum.verify_code}</pre>}
                </details>
              )}
            </li>
          ))}
        </ol>
      ) : instructionsFailed ? (
        // Compatibility path — legacy single-file contract (kept, not canonical).
        <LegacyInstructions token={created.token} worker={created.worker} />
      ) : (
        <p class="card__hint">{t('play_loading')}</p>
      )}

      {/* Optional terminal diagnostics — never a required step: the page
          itself shows the worker status (ONLINE after the first heartbeat). */}
      {instructions?.verify_command && (
        <details class="setup__checksum-details">
          <summary>{t('worker_setup_verify_command_label')}</summary>
          <pre class="settings__debug worker__env">{instructions.verify_command}</pre>
        </details>
      )}

      <p class="card__hint card__hint--wrap">{t('worker_setup_verify_hint')}</p>

      {/* Preview/Experimental installs: a direct path for testers to report
          real installation problems (informational — diagnostics above never
          contain the Worker Key). */}
      {instructions?.availability && instructions.availability !== 'stable' && (
        <p class="card__hint card__hint--wrap">
          {t('worker_setup_report_problem_hint')}{' '}
          <a href="https://github.com/Animastor/animastor/issues" target="_blank" rel="noreferrer">
            {t('worker_setup_report_problem')}
          </a>
        </p>
      )}
    </div>
  );
}

// Legacy compatibility instructions (old single-file model). Rendered ONLY
// when the Setup Contract instructions endpoint is unreachable — the old
// helpers/strings stay functional but are no longer the canonical flow.
function LegacyInstructions({ token, worker }: { token: string; worker: PrivateWorker }) {
  const contract = buildSetupContract(token, worker.worker_type, worker.name);
  return (
    <ol class="worker__steps">
      {contract.steps.map((s, i) => (
        <li key={i}>
          {t(s as StrKey)}
          {i === 0 && <pre class="settings__debug worker__env">{contract.downloadCommand}</pre>}
          {i === 3 && <pre class="settings__debug worker__env">{contract.runCommand}</pre>}
        </li>
      ))}
      <li>
        <pre class="settings__debug worker__env">{renderEnvBlock(contract.env)}</pre>
      </li>
    </ol>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Worker details — extended Setup Contract status model (Phase 3.1 §18/19).
// Shows ONLY real backend fields: extended status, last seen, capabilities
// (profiles/workflows/GPU/VRAM when reported). Null data is never invented.
// ─────────────────────────────────────────────────────────────────────────
function WorkerDetailsModal({ worker, isPublicShare, onClose }: {
  worker: PrivateWorker;
  isPublicShare: boolean;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<SetupWorkerDetail | null>(null);
  const [error, setError] = useState('');
  const [uninstallUrl, setUninstallUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetchSetupWorkerStatus(worker.worker_id);
        if (alive) setDetail(res.worker);
      } catch (e) {
        if (alive) setError(humanError(e));
      }
      // Uninstall action exists ONLY if the backend says the uninstaller
      // artifact is actually available (Phase 3.1 §19 — no fake actions).
      try {
        const { methods } = await fetchSetupMethods();
        const linux = methods.find((m) => m.platform === 'linux');
        if (alive && linux && linux.uninstaller.available) {
          setUninstallUrl(resolveArtifactUrl(linux.uninstaller.download_url));
        }
      } catch (_) { /* stay hidden */ }
    })();
    return () => { alive = false; };
  }, [worker.worker_id]);

  const caps = detail?.capabilities ?? null;

  return (
    <Modal title={t('worker_details_title')} onClose={onClose}>
      <>
        <div class="worker__row-main">
          <span class="worker__name">{worker.name}</span>
          {/* Same access-mode + status badge pair as the worker card row:
              access-mode badge immediately LEFT of the status pill. */}
          <span class="worker__row-badges">
            <span
              class={'worker__badge ' + (isPublicShare ? 'worker__badge--public' : 'worker__badge--private')}
              aria-label={t(isPublicShare ? 'worker_access_public' : 'worker_access_private')}
            >
              {isPublicShare ? t('share_public_badge') : t('worker_access_private')}
            </span>
            {detail ? (
              <span class={'worker__status ' + setupStatusClass(detail.status)}>
                {t(setupStatusKey(detail.status))}
              </span>
            ) : (
              <span class={'worker__status ' + statusClass(worker.status)}>{t(statusKey(worker.status))}</span>
            )}
          </span>
        </div>
        <div class="worker__row-meta">
          <span>{t(worker.worker_type === 'audio' ? 'layer_audio' : worker.worker_type === 'image' ? 'layer_image' : 'layer_video')}</span>
          <span>·</span>
          <span>{t('worker_last_seen')} {formatLastSeen(detail ? detail.last_seen : worker.last_seen)}</span>
        </div>

        {error && <p class="settings-page__error">{error}</p>}

        {detail && (
          caps ? (
            <div class="setup__caps">
              {caps.gpu && (caps.gpu.name || caps.gpu.vram_gb != null) && (
                <p class="card__hint">
                  {t('worker_details_gpu')}: {caps.gpu.name ?? '—'}
                  {caps.gpu.vram_gb != null ? ` · ${t('worker_details_vram')}: ${caps.gpu.vram_gb} GB` : ''}
                </p>
              )}
              {caps.profiles && caps.profiles.length > 0 && (
                <p class="card__hint">{t('worker_details_profiles')}: {caps.profiles.join(', ')}</p>
              )}
              {caps.workflows && caps.workflows.length > 0 && (
                <p class="card__hint">{t('worker_details_workflows')}: {caps.workflows.join(', ')}</p>
              )}
            </div>
          ) : (
            <p class="card__hint card__hint--wrap">{t('worker_details_capabilities_empty')}</p>
          )
        )}

        <div class="modal__footer">
          {uninstallUrl && (
            <a class="btn btn--outlined btn--error" href={uninstallUrl} download>
              {t('worker_details_uninstall')}
            </a>
          )}
          <button class="btn" onClick={onClose}>{t('worker_done')}</button>
        </div>
      </>
    </Modal>
  );
}

/** Map an ApiError to a user-facing localized message; hide DB/Redis internals. */
function humanError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return t('worker_err_auth_required');
    if (e.status === 403) return t('worker_err_forbidden');
    if (e.status === 404) return t('worker_err_not_found');
    if (e.status >= 500) return t('worker_err_unavailable');
    return e.message || t('worker_err_unavailable');
  }
  return (e as Error)?.message || t('worker_err_unavailable');
}

export type { WorkerStatus } from './privateWorkers';
