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
import { Modal, toast } from '../../lib/ui';
import {
  type PrivateWorker,
  validateCreateInput, looksLikeWorkerToken,
  statusClass, statusKey, formatLastSeen, buildSetupContract,
  renderEnvBlock, OFFLINE_TROUBLESHOOT_KEYS,
} from './privateWorkers';
import {
  type SetupProfile, type SetupMethod, type SetupWorkflow, type SetupInstructions,
  type SetupWorkerDetail, type WizardState,
  fetchSetupProfiles, fetchSetupMethods, fetchSetupWorkflows,
  fetchSetupInstructions, fetchSetupWorkerStatus,
  resolveArtifactUrl, groupProfilesByType, platformOptions, pickMethod,
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

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await getJson<{ workers: PrivateWorker[] }>('/workers');
      setWorkers(res.workers);
    } catch (e) {
      setError(humanError(e));
    }
  }, []);

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

  return (
    <section class="page settings-page">
      <div class="settings-page__scroll">
        <div class="card card--stack">
          <h3 class="card__title">{t('worker_mgmt_title')}</h3>
          <p class="card__hint card__hint--wrap">{t('worker_mgmt_desc')}</p>

          <button class="btn btn--block" onClick={() => setWizardOpen(true)} disabled={busy}>
            {t('worker_add')}
          </button>

          {!workers ? (
            <p class="card__hint">{t('play_loading')}</p>
          ) : workers.length === 0 ? (
            <p class="card__hint">{t('worker_empty')}</p>
          ) : (
            <div class="worker__list">
              {workers.map((w) => (
                <div class="worker__row" key={w.worker_id}>
                  <div class="worker__row-main">
                    <span class="worker__name">{w.name}</span>
                    <span class={'worker__status ' + statusClass(w.status)}>{t(statusKey(w.status))}</span>
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
                      <span class="worker__revoked">{t('worker_revoked_label')}</span>
                    )}
                    {/* Repair / Reinstall — UI extension point (Phase 3.1 §20).
                        Hidden until the backend/installer expose the capability;
                        never render a fake action. */}
                  </div>
                </div>
              ))}
            </div>
          )}

          {error && <p class="settings-page__error">{error}</p>}
        </div>
      </div>

      {wizardOpen && (
        <SetupWizard
          onClose={() => { if (!busy) { setWizardOpen(false); void load(); } }}
        />
      )}

      {detailsFor && (
        <WorkerDetailsModal worker={detailsFor} onClose={() => setDetailsFor(null)} />
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
      } catch (e) {
        if (alive) setLoadError(humanError(e));
      }
    })();
    return () => { alive = false; };
  }, []);

  const profile = profiles?.find((p) => p.id === state.profileId) ?? null;
  const method = methods && state.platform ? pickMethod(methods, state.platform) : null;
  const platforms = methods ? platformOptions(methods) : [];
  const installerSelectable = !!(method && method.installer.available);

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
      // (compatibility path) if the Setup Contract endpoint fails.
      void (async () => {
        try {
          const [wf, ins] = await Promise.all([
            fetchSetupWorkflows(profile.id),
            fetchSetupInstructions(profile.id, state.platform ?? 'linux', state.mode ?? 'managed'),
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
  }, [busy, profile, name, state.platform, state.mode, goto]);

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
  const canNext = canGoNext(state, { installerSelectable, nameValid });

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
            <label class="setup__choice">
              <input
                type="radio" name="setup-mode" value="managed"
                checked={state.mode === 'managed'}
                onChange={() => setState((s) => ({ ...s, mode: 'managed' }))}
              />
              <span class="setup__choice-main">
                <span class="setup__choice-title">{t('worker_setup_mode_managed')}</span>
                <span class="card__hint card__hint--wrap">{t('worker_setup_mode_managed_desc')}</span>
              </span>
            </label>
            <label class="setup__choice">
              <input
                type="radio" name="setup-mode" value="existing"
                checked={state.mode === 'existing'}
                onChange={() => setState((s) => ({ ...s, mode: 'existing' }))}
              />
              <span class="setup__choice-main">
                <span class="setup__choice-title">{t('worker_setup_mode_existing')}</span>
                <span class="card__hint card__hint--wrap">{t('worker_setup_mode_existing_desc')}</span>
              </span>
            </label>
            {state.mode === 'existing' && (
              <p class="modal__notice setup__notice">{t('worker_setup_existing_warning')}</p>
            )}
          </div>
        )}

        {/* ── Step 3: platform ── */}
        {state.step === 'platform' && (
          <div class="setup__step">
            <p class="card__label">{t('worker_setup_platform_title')}</p>
            {platforms.map((p) => (
              <label class={'setup__choice' + (p.selectable ? '' : ' setup__choice--disabled')} key={p.platform}>
                <input
                  type="radio" name="setup-platform" value={p.platform}
                  disabled={!p.selectable}
                  checked={state.platform === p.platform}
                  onChange={() => { if (p.selectable) setState((s) => ({ ...s, platform: p.platform })); }}
                />
                <span class="setup__choice-main">
                  <span class="setup__choice-title">
                    {p.platform === 'linux' ? 'Linux' : p.platform === 'windows' ? 'Windows' : 'Docker'}
                  </span>
                  <span class="card__hint">
                    {t(p.stateKey)}
                    {p.selectable && p.installerVersion ? ` · v${p.installerVersion}` : ''}
                  </span>
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
// Install step: one-time Worker Key + installer artifact + workflows +
// API-driven instructions. Versions/URLs/checksums all come from the API.
// ─────────────────────────────────────────────────────────────────────────
function InstallStep({ created, method, workflows, instructions, instructionsFailed, copied, onCopyKey }: {
  created: { token: string; worker: PrivateWorker };
  method: SetupMethod | null;
  workflows: SetupWorkflow[] | null;
  instructions: SetupInstructions | null;
  instructionsFailed: boolean;
  copied: boolean;
  onCopyKey: () => void;
}) {
  const installer = method?.installer ?? null;
  const installerUrl = resolveArtifactUrl(installer?.download_url ?? null);
  const bundle = method?.worker_bundle ?? null;

  return (
    <div class="setup__step setup__install">
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

      {/* Installer artifact — single artifact, version from the contract */}
      <p class="card__label">{t('worker_setup_installer_title')}</p>
      {installer && installer.available && installerUrl ? (
        <div class="setup__artifact">
          <span class="setup__artifact-meta">
            {tf('worker_setup_version_fmt', installer.version ?? '—')}
            {installer.sha256 ? ` · SHA-256: ${installer.sha256.slice(0, 12)}…` : ''}
          </span>
          <a class="btn" href={installerUrl} download>
            {t('worker_setup_download_installer')}
          </a>
        </div>
      ) : (
        <p class="card__hint card__hint--wrap">{t('worker_setup_installer_unavailable')}</p>
      )}
      {bundle && bundle.available && bundle.version && (
        <p class="card__hint card__hint--wrap">{tf('worker_setup_bundle_note', bundle.version)}</p>
      )}

      {/* Baseline workflows — editable starting points (Phase 3.1 §17) */}
      <p class="card__label">{t('worker_setup_workflows_title')}</p>
      {workflows === null ? (
        <p class="card__hint">{t('play_loading')}</p>
      ) : workflows.length === 0 ? (
        <p class="card__hint">—</p>
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
          <p class="card__hint card__hint--wrap">{t('worker_setup_workflow_editable')}</p>
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
                <div class="setup__checksum">
                  {t('worker_setup_checksum')}: <code>{s.checksum.value}</code>
                </div>
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

      <p class="card__hint card__hint--wrap">{t('worker_setup_verify_hint')}</p>
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
function WorkerDetailsModal({ worker, onClose }: { worker: PrivateWorker; onClose: () => void }) {
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
          {detail ? (
            <span class={'worker__status ' + setupStatusClass(detail.status)}>
              {t(setupStatusKey(detail.status))}
            </span>
          ) : (
            <span class={'worker__status ' + statusClass(worker.status)}>{t(statusKey(worker.status))}</span>
          )}
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
