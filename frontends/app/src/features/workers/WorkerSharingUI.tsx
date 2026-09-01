// ─────────────────────────────────────────────────────────────────────────
// Worker Sharing V2 — user-facing components (SH-2 UX layer)
// ─────────────────────────────────────────────────────────────────────────
// Built strictly on the existing design language (card/worker/seg/setup
// classes, Modal + toast primitives) and the existing V2 backend contract.
// The backend is the source of truth: every mutation re-reads
// GET /workers/:id/share (or /workers/shared-with-me) and REPLACES the
// local state — the UI never "knows better" than the server response.
//
// Start flow note: the backend derives scope from the presence of `users`
// and rejects a users policy with an empty audience. Recipients are
// therefore staged (exact-username lookup) BEFORE POST /share; they can be
// extended/removed afterwards via /share/users.
// ─────────────────────────────────────────────────────────────────────────
import { useState, useCallback, useEffect } from 'preact/hooks';
import { t, tf } from '../../app/i18n';
import type { StrKey } from '../../app/i18n';
import { getJson, ApiError } from '../../api/client';
import { Modal, toast } from '../../lib/ui';
import { formatLastSeen, type PrivateWorker } from './privateWorkers';
import {
  type ShareState, type ShareMode, type ShareGrant, type SharedWithMeWorker, type LookupUser,
  fetchShareState, startShare, stopShare, addShareUsers, removeShareUser, lookupUser,
  shareModeOf, isPolicyExpired, sharedByLabel, normalizeUsername, isDuplicateRecipient,
  datetimeLocalToEpoch, formatExpiry, shareErrorKey, sharedStatusClass,
} from './sharing';

/** Map any share-flow failure to a localized message; hide internals. */
function toErrorText(e: unknown): string {
  return t(shareErrorKey(e) as StrKey);
}

// ─────────────────────────────────────────────────────────────────────────
// Owner controls: SharingModal (off → public/users, recipients, stop)
// The UI never changes ownership or `mode` — only share policies.
// ─────────────────────────────────────────────────────────────────────────
export function SharingModal({ worker, onClose, onChanged }: {
  worker: PrivateWorker;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [state, setState] = useState<ShareState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await fetchShareState(worker.worker_id));
    } catch (e) {
      setError(toErrorText(e));
    }
  }, [worker.worker_id]);

  useEffect(() => { void load(); }, [load]);

  const mode: ShareMode = state ? shareModeOf(state.policy) : 'off';
  const policy = state?.policy ?? null;

  const afterChange = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  const onStart = useCallback(async (scope: 'public' | 'users', users: string[], expiry: string) => {
    if (busy) return;
    if (scope === 'users' && users.length === 0) {
      setError(t('share_err_invalid_users'));
      return;
    }
    const exp = datetimeLocalToEpoch(expiry);
    if (!exp.ok) { setError(t(exp.error as StrKey)); return; }
    setBusy(true); setError('');
    try {
      await startShare(worker.worker_id, { scope, users: scope === 'users' ? users : undefined, expiresAt: exp.expiresAt });
      toast(t(scope === 'public' ? 'share_started_public' : 'share_started_users'));
      await afterChange();
    } catch (e) {
      setError(toErrorText(e));
    }
  }, [busy, worker.worker_id, afterChange]);

  const onStop = useCallback(async () => {
    if (busy || !confirm(t('share_stop_confirm'))) return;
    setBusy(true); setError('');
    try {
      await stopShare(worker.worker_id);
      toast(t('share_stopped'));
      await afterChange();
    } catch (e) {
      setError(toErrorText(e));
    } finally {
      setBusy(false);
    }
  }, [busy, worker.worker_id, afterChange]);

  return (
    <Modal title={`${t('share_modal_title')} — ${worker.name}`} onClose={onClose}>
      {!state ? (
        <p class="card__hint">{error || t('play_loading')}</p>
      ) : (
        <>
          {/* Mode + expiry — always rendered from the fetched state */}
          <p class="card__label">{t('share_mode_label')}</p>
          <p class="card__hint">
            {mode === 'off' && t('share_mode_off')}
            {mode === 'public' && t('share_mode_public')}
            {mode === 'users' && t('share_mode_users')}
            {policy && policy.expires_at != null && !isPolicyExpired(policy)
              ? ` · ${tf('share_expires_until', formatExpiry(policy.expires_at))}` : ''}
          </p>

          {error && <p class="settings-page__error">{error}</p>}

          {mode === 'off' && (
            <OffView busy={busy} onStart={(scope, users, expiry) => void onStart(scope, users, expiry)} />
          )}

          {mode === 'public' && (
            <PublicView policy={policy} onStop={() => void onStop()} busy={busy} />
          )}

          {mode === 'users' && (
            <UsersView
              workerId={worker.worker_id}
              grants={state.grants}
              onChanged={afterChange}
              onStop={() => void onStop()}
              busy={busy}
              setModalError={setError}
            />
          )}

          <div class="modal__footer">
            <button class="btn" onClick={onClose}>{t('worker_done')}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ── Off view: choose scope + optional expiry (+ staged recipients) ────────
function OffView({ busy, onStart }: {
  busy: boolean;
  onStart: (scope: 'public' | 'users', users: string[], expiry: string) => void;
}) {
  const [scope, setScope] = useState<'public' | 'users'>('users');
  const [expiry, setExpiry] = useState('');
  const [staged, setStaged] = useState<LookupUser[]>([]);

  return (
    <div class="setup__step">
      <label class="setup__choice">
        <input
          type="radio" name="share-scope" value="public"
          checked={scope === 'public'}
          onChange={() => setScope('public')}
        />
        <span class="setup__choice-main">
          <span class="setup__choice-title">{t('share_mode_public')}</span>
          <span class="card__hint card__hint--wrap">{t('share_mode_public_desc')}</span>
        </span>
      </label>
      <label class="setup__choice">
        <input
          type="radio" name="share-scope" value="users"
          checked={scope === 'users'}
          onChange={() => setScope('users')}
        />
        <span class="setup__choice-main">
          <span class="setup__choice-title">{t('share_mode_users')}</span>
          <span class="card__hint card__hint--wrap">{t('share_mode_users_desc')}</span>
        </span>
      </label>

      {scope === 'users' && (
        <StagedRecipients
          staged={staged}
          onStaged={setStaged}
          disabled={busy}
        />
      )}

      <p class="card__label">{t('share_expires_label')}</p>
      <input
        class="settings__input"
        type="datetime-local"
        value={expiry}
        aria-label={t('share_expires_label')}
        disabled={busy}
        onInput={(e) => setExpiry((e.target as HTMLInputElement).value)}
      />
      <p class="card__hint card__hint--wrap">{t('share_expires_none')}</p>

      <button
        class="btn btn--block"
        disabled={busy || (scope === 'users' && staged.length === 0)}
        onClick={() => onStart(scope, staged.map((u) => u.username), expiry)}
      >
        {busy ? t('play_loading') : t('share_btn')}
      </button>
    </div>
  );
}

// Shared recipient-picker (exact username lookup, no fuzzy/directory search).
// Used by OffView (staged before start) — UsersView reuses addShareUsers.
function StagedRecipients({ staged, onStaged, disabled }: {
  staged: LookupUser[];
  onStaged: (users: LookupUser[]) => void;
  disabled: boolean;
}) {
  const [username, setUsername] = useState('');
  const [found, setFound] = useState<LookupUser | null>(null);
  const [error, setError] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);

  const onLookup = useCallback(async () => {
    const v = normalizeUsername(username);
    if (!v.ok) { setError(t(v.error as StrKey)); setFound(null); return; }
    if (staged.some((u) => u.username === v.username)) {
      setError(t('share_err_duplicate'));
      setFound(null);
      return;
    }
    setLookupBusy(true); setError('');
    try {
      const user = await lookupUser(v.username);
      if (!user) { setError(t('share_lookup_not_found')); setFound(null); return; }
      setFound(user);
    } catch (e) {
      setError(toErrorText(e));
      setFound(null);
    } finally {
      setLookupBusy(false);
    }
  }, [username, staged]);

  const addStaged = useCallback((user: LookupUser) => {
    onStaged([...staged, user]);
    setFound(null);
    setUsername('');
  }, [staged, onStaged]);

  return (
    <div class="setup__step">
      <p class="card__label">{t('share_recipients_label')}</p>
      {staged.length === 0 ? (
        <p class="card__hint card__hint--wrap">{t('share_recipients_empty')}</p>
      ) : (
        <div class="worker__list">
          {staged.map((u) => (
            <div class="worker__row" key={u.user_id}>
              <div class="worker__row-main">
                <span class="worker__name">{u.username}</span>
                {u.display_name && <span class="card__hint">{u.display_name}</span>}
              </div>
              <div class="worker__actions">
                <button
                  class="btn btn--outlined btn--error"
                  disabled={disabled}
                  onClick={() => onStaged(staged.filter((x) => x.user_id !== u.user_id))}
                >{t('worker_revoke')}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <p class="card__label">{t('share_add_user_label')}</p>
      <div class="worker__cred">
        <input
          class="settings__input"
          value={username}
          placeholder={t('share_add_user_placeholder')}
          aria-label={t('share_add_user_label')}
          disabled={disabled || lookupBusy}
          onInput={(e) => { setUsername((e.target as HTMLInputElement).value); setFound(null); setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void onLookup(); } }}
        />
        <button class="btn btn--outlined" onClick={() => void onLookup()} disabled={disabled || lookupBusy}>
          {lookupBusy ? t('play_loading') : t('worker_details_title')}
        </button>
      </div>
      {found && (
        <p class="card__hint">
          {tf('share_lookup_ok', found.display_name ? `${found.username} · ${found.display_name}` : found.username)}
          {' '}
          <button class="btn btn--outlined" onClick={() => addStaged(found)} disabled={disabled}>
            {t('share_add_btn')}
          </button>
        </p>
      )}
      {error && <p class="settings-page__error">{error}</p>}
    </div>
  );
}

function PublicView({ policy, onStop, busy }: { policy: ShareState['policy']; onStop: () => void; busy: boolean }) {
  return (
    <div class="setup__step">
      <p class="modal__notice setup__notice">{t('share_mode_public_desc')}</p>
      {policy?.expires_at != null && (
        <p class="card__hint">{tf('share_expires_until', formatExpiry(policy.expires_at))}</p>
      )}
      <button class="btn btn--outlined btn--error btn--block" onClick={onStop} disabled={busy}>
        {busy ? t('play_loading') : t('share_stop_btn')}
      </button>
    </div>
  );
}

// ── Users view: recipients of the ACTIVE policy + add/remove/stop ─────────
function UsersView({ workerId, grants, onChanged, onStop, busy, setModalError }: {
  workerId: string;
  grants: ShareGrant[];
  onChanged: () => Promise<void> | void;
  onStop: () => void;
  busy: boolean;
  setModalError: (msg: string) => void;
}) {
  const [username, setUsername] = useState('');
  const [found, setFound] = useState<LookupUser | null>(null);
  const [localError, setLocalError] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [removeBusyFor, setRemoveBusyFor] = useState<string | null>(null);

  const onLookup = useCallback(async () => {
    const v = normalizeUsername(username);
    if (!v.ok) { setLocalError(t(v.error as StrKey)); setFound(null); return; }
    if (isDuplicateRecipient(v.username, grants)) {
      setLocalError(t('share_err_duplicate'));
      setFound(null);
      return;
    }
    setLookupBusy(true); setLocalError(''); setModalError('');
    try {
      const user = await lookupUser(v.username);
      if (!user) { setLocalError(t('share_lookup_not_found')); setFound(null); return; }
      setFound(user);
    } catch (e) {
      setLocalError(toErrorText(e));
      setFound(null);
    } finally {
      setLookupBusy(false);
    }
  }, [username, grants, setModalError]);

  const onAdd = useCallback(async () => {
    if (!found || busy) return;
    setLocalError(''); setModalError('');
    try {
      await addShareUsers(workerId, [found.username]);
      toast(t('share_user_added'));
      setFound(null);
      setUsername('');
      await onChanged();
    } catch (e) {
      setLocalError(toErrorText(e));
    }
  }, [found, busy, workerId, onChanged, setModalError]);

  const onRemove = useCallback(async (g: ShareGrant) => {
    if (removeBusyFor) return;
    setRemoveBusyFor(g.username); setModalError('');
    try {
      await removeShareUser(workerId, g.username);
      toast(t('share_user_removed'));
      await onChanged();
    } catch (e) {
      setModalError(toErrorText(e));
    } finally {
      setRemoveBusyFor(null);
    }
  }, [removeBusyFor, workerId, onChanged, setModalError]);

  return (
    <div class="setup__step">
      <p class="card__label">{t('share_recipients_label')}</p>
      {grants.length === 0 ? (
        <p class="card__hint card__hint--wrap">{t('share_recipients_empty')}</p>
      ) : (
        <div class="worker__list">
          {grants.map((g) => (
            <div class="worker__row" key={g.grant_id}>
              <div class="worker__row-main">
                <span class="worker__name">{g.username}</span>
                {g.display_name && <span class="card__hint">{g.display_name}</span>}
              </div>
              <div class="worker__actions">
                <button
                  class="btn btn--outlined btn--error"
                  disabled={busy || removeBusyFor !== null}
                  onClick={() => void onRemove(g)}
                >{removeBusyFor === g.username ? t('play_loading') : t('worker_revoke')}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <p class="card__label">{t('share_add_user_label')}</p>
      <div class="worker__cred">
        <input
          class="settings__input"
          value={username}
          placeholder={t('share_add_user_placeholder')}
          aria-label={t('share_add_user_label')}
          disabled={lookupBusy || busy}
          onInput={(e) => {
            setUsername((e.target as HTMLInputElement).value);
            setFound(null); // a stale lookup result never survives new input
            setLocalError('');
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void onLookup(); } }}
        />
        <button class="btn btn--outlined" onClick={() => void onLookup()} disabled={lookupBusy || busy}>
          {lookupBusy ? t('play_loading') : t('share_add_btn')}
        </button>
      </div>
      {found && (
        <p class="card__hint">
          {tf('share_lookup_ok', found.display_name ? `${found.username} · ${found.display_name}` : found.username)}
          {' '}
          <button class="btn btn--outlined" onClick={() => void onAdd()} disabled={busy}>
            {t('share_add_btn')}
          </button>
        </p>
      )}
      {localError && <p class="settings-page__error">{localError}</p>}

      <button class="btn btn--outlined btn--error btn--block" onClick={onStop} disabled={busy}>
        {busy ? t('play_loading') : t('share_stop_btn')}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Shared with me view (§14.2): personal grants with the access reason.
// "Open/use" is implicit in this architecture: a granted worker serves the
// recipient's jobs automatically (policy-lane dispatch) — no fake action
// buttons are rendered (same rule as PrivateWorkersSection §20).
// ─────────────────────────────────────────────────────────────────────────
export function SharedWithMeView({ entries, loading, error }: {
  entries: SharedWithMeWorker[];
  loading: boolean;
  error: string;
}) {
  if (loading && entries.length === 0) {
    return <p class="card__hint">{t('play_loading')}</p>;
  }
  if (error && entries.length === 0) {
    return <p class="settings-page__error">{error}</p>;
  }
  if (entries.length === 0) {
    return (
      <div>
        <p class="card__hint card__hint--wrap">{t('share_swm_empty')}</p>
        <p class="card__hint card__hint--wrap">{t('share_swm_hint')}</p>
      </div>
    );
  }
  return (
    <div class="worker__list">
      {entries.map((w) => {
        const by = sharedByLabel(w);
        const online = sharedStatusClass(w) === 'online';
        return (
          <div class="worker__row" key={w.worker_id}>
            <div class="worker__row-main">
              <span class="worker__name">{w.name}</span>
              <span class={'worker__status ' + (online ? 'worker__status--online' : 'worker__status--offline')}>
                {online ? t('worker_status_online') : t('worker_status_offline')}
              </span>
            </div>
            <div class="worker__row-meta share__reason-row">
              {by && <span class="share__reason">{tf('share_shared_by', by)}</span>}
              {w.share_policy.expires_at != null && !isPolicyExpired(w.share_policy) && (
                <span> · {tf('share_expires_until', formatExpiry(w.share_policy.expires_at))}</span>
              )}
              <span> · {t('worker_last_seen')} {formatLastSeen(w.last_seen)}</span>
            </div>
            <div class="worker__row-meta">
              <span>{t(w.worker_type === 'audio' ? 'layer_audio' : w.worker_type === 'image' ? 'layer_image' : 'layer_video')}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Community view: public sharing manifests as the shared system pool.
// Per design D3 the global counts are a CAPACITY indicator, not a physical
// inventory — V1/V2 deliberately has no browsable public-worker directory,
// so this view renders the pool availability and never invents entries.
// ─────────────────────────────────────────────────────────────────────────
interface CommunityCounts {
  audio: number; image: number; video: number;
  active_audio: number; active_image: number; active_video: number;
}

export function CommunityView() {
  const [counts, setCounts] = useState<CommunityCounts | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await getJson<Partial<CommunityCounts>>('/worker/counts');
        if (alive) {
          setCounts({
            audio: res.audio ?? 0, image: res.image ?? 0, video: res.video ?? 0,
            active_audio: res.active_audio ?? 0, active_image: res.active_image ?? 0, active_video: res.active_video ?? 0,
          });
        }
      } catch (e) {
        if (alive) setError(e instanceof ApiError ? e.message : (e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, []);

  const empty = counts && counts.audio === 0 && counts.image === 0 && counts.video === 0;

  return (
    <div>
      <p class="card__hint card__hint--wrap">{t('share_community_hint')}</p>
      {error && <p class="settings-page__error">{error}</p>}
      {!counts ? (
        <p class="card__hint">{t('play_loading')}</p>
      ) : empty ? (
        <p class="card__hint card__hint--wrap">{t('share_community_empty')}</p>
      ) : (
        <div class="worker__list">
          {(['audio', 'image', 'video'] as const).filter((k) => counts[k] > 0).map((k) => (
            <div class="worker__row" key={k}>
              <div class="worker__row-main">
                <span class="worker__name">{t(k === 'audio' ? 'layer_audio' : k === 'image' ? 'layer_image' : 'layer_video')}</span>
              </div>
              <div class="worker__row-meta">
                <span>{tf('worker_counts_fmt', counts[k], counts[k === 'audio' ? 'active_audio' : k === 'image' ? 'active_image' : 'active_video'])}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
