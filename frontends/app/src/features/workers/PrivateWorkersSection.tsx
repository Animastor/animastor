// ─────────────────────────────────────────────────────────────────────────
// /settings/private-workers — Private Worker Management (Experimental Beta Phase 3)
// ─────────────────────────────────────────────────────────────────────────
// List + create + rotate + revoke for the CALLER's workspace workers, served
// by /api/v1/workers (server-resolves workspace_id — never from the client).
//
// SECURITY: the plaintext worker credential (token) is a ONE-TIME disclosure
// from the server. It lives ONLY transiently in React `useState` (component
// memory) while the one-time modal is open. Closing "Done" clears it to null.
// It is NEVER written to localStorage / sessionStorage / the URL / IndexedDB.
import { useState, useCallback, useEffect } from 'preact/hooks';
import { getJson, postJson, deleteJson, ApiError } from '../../api/client';
import type { StrKey } from '../../app/i18n';
import { t } from '../../app/i18n';
import { Modal, toast } from '../../lib/ui';
import {
  type PrivateWorker, type WorkerType, type WorkerStatus,
  WORKER_TYPE_OPTIONS, validateCreateInput, looksLikeWorkerToken,
  statusClass, statusKey, formatLastSeen, buildSetupContract,
} from './privateWorkers';

export function PrivateWorkersSection() {
  const [workers, setWorkers] = useState<PrivateWorker[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Create form state (transient — not persisted).
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<WorkerType>('audio');

  // The ONE-TIME credential lives here only while the disclosure modal is
  // open. Cleared to null on Done / close. Never reaches persistent storage.
  const [credential, setCredential] = useState<{ token: string; worker: PrivateWorker; mode: 'create' } | null>(null);

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

  const onCreate = useCallback(async () => {
    if (busy) return;
    const v = validateCreateInput(name, type);
    if (!v.ok) { setError(t(v.error as StrKey)); return; }
    setBusy(true); setError('');
    try {
      const res = await postJson<{ worker: PrivateWorker; token: string }>('/workers', {
        name: v.name, worker_type: v.worker_type,
      });
      // Disclose the credential ONE time, then drop it from memory on Done.
      setCredential({ token: res.token, worker: res.worker, mode: 'create' });
      setName(''); setType('audio'); setShowCreate(false);
      await load();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }, [busy, name, type, load]);

  const onRotate = useCallback(async (worker: PrivateWorker) => {
    if (busy || !confirm(t('worker_rotate_confirm'))) return;
    setBusy(true); setError('');
    try {
      const res = await postJson<{ worker: PrivateWorker; token: string }>(
        `/workers/${worker.worker_id}/rotate`, {});
      // Rotating disconnects the current worker until it receives the new
      // credential — disclose the new one-time token, exactly as on create.
      setCredential({ token: res.token, worker: res.worker, mode: 'create' as const });
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

  const closeCredential = useCallback(() => {
    // Drop the one-time credential from memory immediately.
    setCredential(null);
  }, []);

  return (
    <section class="page settings-page">
      <div class="settings-page__scroll">
        <div class="card card--stack">
          <h3 class="card__title">{t('worker_mgmt_title')}</h3>
          <p class="card__hint card__hint--wrap">{t('worker_mgmt_desc')}</p>

          <div class="settings__group">
            <button class="btn" onClick={() => setShowCreate(true)} disabled={busy}>
              {t('worker_add')}
            </button>
          </div>

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
                  <div class="settings__group">
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
                  </div>
                </div>
              ))}
            </div>
          )}

          {error && <p class="settings-page__error">{error}</p>}
        </div>
      </div>

      {/* ── Add Worker modal ── */}
      {showCreate && (
        <Modal
          title={t('worker_add')}
          onClose={() => { if (!busy) setShowCreate(false); }}
        >
          <>
            <div class="settings__group settings__group--stack">
              <p class="card__label">{t('worker_name')}</p>
              <input
                class="settings__input"
                value={name}
                placeholder={t('worker_name_hint')}
                aria-label={t('worker_name')}
                disabled={busy}
                onInput={(e) => setName((e.target as HTMLInputElement).value)}
              />
              <p class="card__label">{t('worker_type_label')}</p>
              <select
                class="select"
                value={type}
                disabled={busy}
                aria-label={t('worker_type_label')}
                onChange={(e) => setType((e.target as HTMLSelectElement).value as WorkerType)}
              >
                {WORKER_TYPE_OPTIONS.map(({ type: wt, label }) => (
                  <option key={wt} value={wt}>{t(label)}</option>
                ))}
              </select>
            </div>
            {error && <p class="settings-page__error">{error}</p>}
            <div class="modal__footer">
              <button class="btn btn--outlined" onClick={() => { if (!busy) setShowCreate(false); }} disabled={busy}>
                {t('dialog_cancel')}
              </button>
              <button class="btn" onClick={() => void onCreate()} disabled={busy || !name.trim()}>
                {busy ? t('play_loading') : t('worker_create')}
              </button>
            </div>
          </>
        </Modal>
      )}

      {/* ── One-time credential disclosure ── */}
      {credential && looksLikeWorkerToken(credential.token) && (
        <CredentialDisclosure
          token={credential.token}
          worker={credential.worker}
          onDone={closeCredential}
        />
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// One-time credential disclosure modal.
// The token is shown ONCE. Copy uses a transient in-memory string only.
// Closing this component clears the token from parent state (onDone).
// ─────────────────────────────────────────────────────────────────────────
function CredentialDisclosure({ token, worker, onDone }: {
  token: string;
  worker: PrivateWorker;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const contract = buildSetupContract(token, worker.worker_type, worker.name);

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
    <Modal
      title={t('worker_created_title')}
      onClose={onDone}
    >
      <>
        <p class="modal__notice worker__warn">{t('worker_credential_warning')}</p>

        <p class="card__label">{t('worker_credential')}</p>
        <div class="worker__cred">
          <code class="worker__token">{token}</code>
          <button class="btn btn--outlined" onClick={() => void onCopy()}>
            {copied ? t('worker_copied') : t('worker_copy')}
          </button>
        </div>

        <p class="card__label">{t('worker_setup_title')}</p>
        <ol class="worker__steps">
          {contract.steps.map((s, i) => (
            <li key={i}>{t(s as StrKey)}</li>
          ))}
        </ol>
        <pre class="settings__debug worker__env">{[
          `HUB_URL=${contract.env.HUB_URL}`,
          `ANIMASTOR_WORKER_TOKEN=${contract.env.ANIMASTOR_WORKER_TOKEN}`,
          `WORKER_TYPE=${contract.env.WORKER_TYPE}`,
          `WORKER_ID=${contract.env.WORKER_ID}`,
        ].join('\n')}</pre>
        <p class="card__hint card__hint--wrap">{t('worker_setup_hint')}</p>

        <div class="modal__footer">
          <button class="btn" onClick={onDone}>{t('worker_done')}</button>
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

export type { WorkerStatus };
