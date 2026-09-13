// ─────────────────────────────────────────────────────────────────────────
// Worker Sharing V2 — user-facing components (SH-2 UX layer)
// ─────────────────────────────────────────────────────────────────────────
// Adapted for the web-workers package: all host dependencies (api, i18n, ui)
// are accessed through WorkerPorts instead of direct imports.
// ─────────────────────────────────────────────────────────────────────────
import { useState, useCallback, useEffect } from 'preact/hooks';
import type { WorkerPorts, WorkerI18nKey } from './ports';
import { formatLastSeen, type PrivateWorker } from './privateWorkers';
import {
  type ShareState, type ShareMode, type ShareGrant, type SharedWithMeWorker, type LookupUser,
  fetchShareState, startShare, stopShare, addShareUsers, removeShareUser, lookupUser,
  shareModeOf, isPolicyExpired, sharedByLabel, normalizeUsername, isDuplicateRecipient,
  datetimeLocalToEpoch, formatExpiry, shareErrorKey, sharedStatusClass,
} from './sharing';

/** Map any share-flow failure to a localized message; hide internals. */
function toErrorText(e: unknown, ports: WorkerPorts): string {
  return ports.i18n.t(shareErrorKey(e, ports.api.ApiError) as WorkerI18nKey);
}

// ─────────────────────────────────────────────────────────────────────────
// Owner controls: SharingModal (off → public/users, recipients, stop)
// The UI never changes ownership or `mode` — only share policies.
// ─────────────────────────────────────────────────────────────────────────
export function SharingModal({ worker, onClose, onChanged, ports }: {
  worker: PrivateWorker;
  onClose: () => void;
  onChanged: () => void;
  ports: WorkerPorts;
}) {
  const [state, setState] = useState<ShareState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await fetchShareState(ports.api, worker.worker_id));
    } catch (e) {
      setError(toErrorText(e, ports));
    }
  }, [worker.worker_id, ports.api]);

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
      setError(ports.i18n.t('share_err_invalid_users'));
      return;
    }
    const exp = datetimeLocalToEpoch(expiry);
    if (!exp.ok) { setError(ports.i18n.t(exp.error as WorkerI18nKey)); return; }
    setBusy(true); setError('');
    try {
      await startShare(ports.api, worker.worker_id, { scope, users: scope === 'users' ? users : undefined, expiresAt: exp.expiresAt });
      ports.ui.toast(ports.i18n.t(scope === 'public' ? 'share_started_public' : 'share_started_users'));
      await afterChange();
    } catch (e) {
      setError(toErrorText(e, ports));
    } finally {
      // busy MUST always settle — a stuck «Загрузка…» button is worse than
      // any error text (same rule as onStop below).
      setBusy(false);
    }
  }, [busy, worker.worker_id, afterChange, ports.i18n, ports.ui.toast, ports.api]);

  const onStop = useCallback(async () => {
    if (busy || !confirm(ports.i18n.t('share_stop_confirm'))) return;
    setBusy(true); setError('');
    try {
      await stopShare(ports.api, worker.worker_id);
      ports.ui.toast(ports.i18n.t('share_stopped'));
      await afterChange();
    } catch (e) {
      setError(toErrorText(e, ports));
    } finally {
      setBusy(false);
    }
  }, [busy, worker.worker_id, afterChange, ports.i18n, ports.ui.toast, ports.api]);

  return (
    <ports.ui.Modal title={`${ports.i18n.t('share_modal_title')} — ${worker.name}`} onClose={onClose}>
      {!state ? (
        <p class="card__hint">{error || ports.i18n.t('play_loading')}</p>
      ) : (
        <>
          {/* Mode + expiry — always rendered from the fetched state */}
          <p class="card__label">{ports.i18n.t('share_mode_label')}</p>
          <p class="card__hint">
            {mode === 'off' && ports.i18n.t('share_mode_off')}
            {mode === 'public' && ports.i18n.t('share_mode_public')}
            {mode === 'users' && ports.i18n.t('share_mode_users')}
            {policy && policy.expires_at != null && !isPolicyExpired(policy)
              ? ` · ${ports.i18n.tf('share_expires_until', formatExpiry(policy.expires_at))}` : ''}
          </p>

          {error && <p class="settings-page__error">{error}</p>}

          {mode === 'off' && (
            <OffView busy={busy} onStart={(scope, users, expiry) => void onStart(scope, users, expiry)} ports={ports} />
          )}

          {mode === 'public' && (
            <PublicView policy={policy} onStop={() => void onStop()} busy={busy} ports={ports} />
          )}

          {mode === 'users' && (
            <UsersView
              workerId={worker.worker_id}
              grants={state.grants}
              onChanged={afterChange}
              onStop={() => void onStop()}
              busy={busy}
              setModalError={setError}
              ports={ports}
            />
          )}

          <div class="modal__footer">
            <button class="btn" onClick={onClose}>{ports.i18n.t('worker_done')}</button>
          </div>
        </>
      )}
    </ports.ui.Modal>
  );
}

// ── Off view: choose scope + optional expiry (+ staged recipients) ────────
function OffView({ busy, onStart, ports }: {
  busy: boolean;
  onStart: (scope: 'public' | 'users', users: string[], expiry: string) => void;
  ports: WorkerPorts;
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
          <span class="setup__choice-title">{ports.i18n.t('share_mode_public')}</span>
          <span class="card__hint card__hint--wrap">{ports.i18n.t('share_mode_public_desc')}</span>
        </span>
      </label>
      <label class="setup__choice">
        <input
          type="radio" name="share-scope" value="users"
          checked={scope === 'users'}
          onChange={() => setScope('users')}
        />
        <span class="setup__choice-main">
          <span class="setup__choice-title">{ports.i18n.t('share_mode_users')}</span>
          <span class="card__hint card__hint--wrap">{ports.i18n.t('share_mode_users_desc')}</span>
        </span>
      </label>

      {scope === 'users' && (
        <StagedRecipients
          staged={staged}
          onStaged={setStaged}
          disabled={busy}
          ports={ports}
        />
      )}

      <p class="card__label">{ports.i18n.t('share_expires_label')}</p>
      <input
        class="settings__input"
        type="datetime-local"
        value={expiry}
        aria-label={ports.i18n.t('share_expires_label')}
        disabled={busy}
        onInput={(e) => setExpiry((e.target as HTMLInputElement).value)}
      />
      <p class="card__hint card__hint--wrap">{ports.i18n.t('share_expires_none')}</p>

      <button
        class="btn btn--block"
        disabled={busy || (scope === 'users' && staged.length === 0)}
        onClick={() => onStart(scope, staged.map((u) => u.username), expiry)}
      >
        {busy ? ports.i18n.t('play_loading') : ports.i18n.t('share_btn')}
      </button>
    </div>
  );
}

// Shared recipient-picker (exact username lookup, no fuzzy/directory search).
// Used by OffView (staged before start) — UsersView reuses addShareUsers.
function StagedRecipients({ staged, onStaged, disabled, ports }: {
  staged: LookupUser[];
  onStaged: (users: LookupUser[]) => void;
  disabled: boolean;
  ports: WorkerPorts;
}) {
  const [username, setUsername] = useState('');
  const [found, setFound] = useState<LookupUser | null>(null);
  const [error, setError] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);

  const onLookup = useCallback(async () => {
    const v = normalizeUsername(username);
    if (!v.ok) { setError(ports.i18n.t(v.error as WorkerI18nKey)); setFound(null); return; }
    if (staged.some((u) => u.username === v.username)) {
      setError(ports.i18n.t('share_err_duplicate'));
      setFound(null);
      return;
    }
    setLookupBusy(true); setError('');
    try {
      const user = await lookupUser(ports.api, v.username);
      if (!user) { setError(ports.i18n.t('share_lookup_not_found')); setFound(null); return; }
      setFound(user);
    } catch (e) {
      setError(toErrorText(e, ports));
      setFound(null);
    } finally {
      setLookupBusy(false);
    }
  }, [username, staged, ports.api, ports.i18n]);

  const addStaged = useCallback((user: LookupUser) => {
    onStaged([...staged, user]);
    setFound(null);
    setUsername('');
  }, [staged, onStaged]);

  return (
    <div class="setup__step">
      <p class="card__label">{ports.i18n.t('share_recipients_label')}</p>
      {staged.length === 0 ? (
        <p class="card__hint card__hint--wrap">{ports.i18n.t('share_recipients_empty')}</p>
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
                >{ports.i18n.t('worker_revoke')}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <p class="card__label">{ports.i18n.t('share_add_user_label')}</p>
      <div class="worker__cred">
        <input
          class="settings__input"
          value={username}
          placeholder={ports.i18n.t('share_add_user_placeholder')}
          aria-label={ports.i18n.t('share_add_user_label')}
          disabled={disabled || lookupBusy}
          onInput={(e) => { setUsername((e.target as HTMLInputElement).value); setFound(null); setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void onLookup(); } }}
        />
        <button class="btn btn--outlined" onClick={() => void onLookup()} disabled={disabled || lookupBusy}>
          {lookupBusy ? ports.i18n.t('play_loading') : ports.i18n.t('worker_details_title')}
        </button>
      </div>
      {found && (
        <p class="card__hint">
          {ports.i18n.tf('share_lookup_ok', found.display_name ? `${found.username} · ${found.display_name}` : found.username)}
          {' '}
          <button class="btn btn--outlined" onClick={() => addStaged(found)} disabled={disabled}>
            {ports.i18n.t('share_add_btn')}
          </button>
        </p>
      )}
      {error && <p class="settings-page__error">{error}</p>}
    </div>
  );
}

function PublicView({ policy, onStop, busy, ports }: {
  policy: ShareState['policy'];
  onStop: () => void;
  busy: boolean;
  ports: WorkerPorts;
}) {
  return (
    <div class="setup__step">
      <p class="modal__notice setup__notice">{ports.i18n.t('share_mode_public_desc')}</p>
      {policy?.expires_at != null && (
        <p class="card__hint">{ports.i18n.tf('share_expires_until', formatExpiry(policy.expires_at))}</p>
      )}
      <button class="btn btn--outlined btn--error btn--block" onClick={onStop} disabled={busy}>
        {busy ? ports.i18n.t('play_loading') : ports.i18n.t('share_stop_btn')}
      </button>
    </div>
  );
}

// ── Users view: recipients of the ACTIVE policy + add/remove/stop ─────────
function UsersView({ workerId, grants, onChanged, onStop, busy, setModalError, ports }: {
  workerId: string;
  grants: ShareGrant[];
  onChanged: () => Promise<void> | void;
  onStop: () => void;
  busy: boolean;
  setModalError: (msg: string) => void;
  ports: WorkerPorts;
}) {
  const [username, setUsername] = useState('');
  const [found, setFound] = useState<LookupUser | null>(null);
  const [localError, setLocalError] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [removeBusyFor, setRemoveBusyFor] = useState<string | null>(null);

  const onLookup = useCallback(async () => {
    const v = normalizeUsername(username);
    if (!v.ok) { setLocalError(ports.i18n.t(v.error as WorkerI18nKey)); setFound(null); return; }
    if (isDuplicateRecipient(v.username, grants)) {
      setLocalError(ports.i18n.t('share_err_duplicate'));
      setFound(null);
      return;
    }
    setLookupBusy(true); setLocalError(''); setModalError('');
    try {
      const user = await lookupUser(ports.api, v.username);
      if (!user) { setLocalError(ports.i18n.t('share_lookup_not_found')); setFound(null); return; }
      setFound(user);
    } catch (e) {
      setLocalError(toErrorText(e, ports));
      setFound(null);
    } finally {
      setLookupBusy(false);
    }
  }, [username, grants, setModalError, ports.api, ports.i18n]);

  const onAdd = useCallback(async () => {
    if (!found || busy) return;
    setLocalError(''); setModalError('');
    try {
      await addShareUsers(ports.api, workerId, [found.username]);
      ports.ui.toast(ports.i18n.t('share_user_added'));
      setFound(null);
      setUsername('');
      await onChanged();
    } catch (e) {
      setLocalError(toErrorText(e, ports));
    }
  }, [found, busy, workerId, onChanged, setModalError, ports.api, ports.i18n, ports.ui.toast]);

  const onRemove = useCallback(async (g: ShareGrant) => {
    if (removeBusyFor) return;
    setRemoveBusyFor(g.username); setModalError('');
    try {
      await removeShareUser(ports.api, workerId, g.username);
      ports.ui.toast(ports.i18n.t('share_user_removed'));
      await onChanged();
    } catch (e) {
      setModalError(toErrorText(e, ports));
    } finally {
      setRemoveBusyFor(null);
    }
  }, [removeBusyFor, workerId, onChanged, setModalError, ports.api, ports.i18n, ports.ui.toast]);

  return (
    <div class="setup__step">
      <p class="card__label">{ports.i18n.t('share_recipients_label')}</p>
      {grants.length === 0 ? (
        <p class="card__hint card__hint--wrap">{ports.i18n.t('share_recipients_empty')}</p>
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
                >{removeBusyFor === g.username ? ports.i18n.t('play_loading') : ports.i18n.t('worker_revoke')}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <p class="card__label">{ports.i18n.t('share_add_user_label')}</p>
      <div class="worker__cred">
        <input
          class="settings__input"
          value={username}
          placeholder={ports.i18n.t('share_add_user_placeholder')}
          aria-label={ports.i18n.t('share_add_user_label')}
          disabled={lookupBusy || busy}
          onInput={(e) => {
            setUsername((e.target as HTMLInputElement).value);
            setFound(null); // a stale lookup result never survives new input
            setLocalError('');
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void onLookup(); } }}
        />
        <button class="btn btn--outlined" onClick={() => void onLookup()} disabled={lookupBusy || busy}>
          {lookupBusy ? ports.i18n.t('play_loading') : ports.i18n.t('share_add_btn')}
        </button>
      </div>
      {found && (
        <p class="card__hint">
          {ports.i18n.tf('share_lookup_ok', found.display_name ? `${found.username} · ${found.display_name}` : found.username)}
          {' '}
          <button class="btn btn--outlined" onClick={() => void onAdd()} disabled={busy}>
            {ports.i18n.t('share_add_btn')}
          </button>
        </p>
      )}
      {localError && <p class="settings-page__error">{localError}</p>}

      <button class="btn btn--outlined btn--error btn--block" onClick={onStop} disabled={busy}>
        {busy ? ports.i18n.t('play_loading') : ports.i18n.t('share_stop_btn')}
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
export function SharedWithMeView({ entries, loading, error, ports }: {
  entries: SharedWithMeWorker[];
  loading: boolean;
  error: string;
  ports: WorkerPorts;
}) {
  if (loading && entries.length === 0) {
    return <p class="card__hint">{ports.i18n.t('play_loading')}</p>;
  }
  if (error && entries.length === 0) {
    return <p class="settings-page__error">{error}</p>;
  }
  if (entries.length === 0) {
    return (
      <div>
        <p class="card__hint card__hint--wrap">{ports.i18n.t('share_swm_empty')}</p>
        <p class="card__hint card__hint--wrap">{ports.i18n.t('share_swm_hint')}</p>
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
                {online ? ports.i18n.t('worker_status_online' as WorkerI18nKey) : ports.i18n.t('worker_status_offline' as WorkerI18nKey)}
              </span>
            </div>
            <div class="worker__row-meta share__reason-row">
              {by && <span class="share__reason">{ports.i18n.tf('share_shared_by', by)}</span>}
              {w.share_policy.expires_at != null && !isPolicyExpired(w.share_policy) && (
                <span> · {ports.i18n.tf('share_expires_until', formatExpiry(w.share_policy.expires_at))}</span>
              )}
              <span> · {ports.i18n.t('worker_last_seen')} {formatLastSeen(w.last_seen)}</span>
            </div>
            <div class="worker__row-meta">
              <span>{ports.i18n.t(w.worker_type === 'audio' ? 'layer_audio' : w.worker_type === 'image' ? 'layer_image' : 'layer_video')}</span>
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

export function CommunityView({ ports }: { ports: WorkerPorts }) {
  const [counts, setCounts] = useState<CommunityCounts | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await ports.api.getJson<Partial<CommunityCounts>>('/worker/counts');
        if (alive) {
          setCounts({
            audio: res.audio ?? 0, image: res.image ?? 0, video: res.video ?? 0,
            active_audio: res.active_audio ?? 0, active_image: res.active_image ?? 0, active_video: res.active_video ?? 0,
          });
        }
      } catch (e) {
        if (alive) setError(e instanceof ports.api.ApiError ? e.message : (e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [ports.api]);

  const empty = counts && counts.audio === 0 && counts.image === 0 && counts.video === 0;

  return (
    <div>
      <p class="card__hint card__hint--wrap">{ports.i18n.t('share_community_hint')}</p>
      {error && <p class="settings-page__error">{error}</p>}
      {!counts ? (
        <p class="card__hint">{ports.i18n.t('play_loading')}</p>
      ) : empty ? (
        <p class="card__hint card__hint--wrap">{ports.i18n.t('share_community_empty')}</p>
      ) : (
        <div class="worker__list">
          {(['audio', 'image', 'video'] as const).filter((k) => counts[k] > 0).map((k) => (
            <div class="worker__row" key={k}>
              <div class="worker__row-main">
                <span class="worker__name">{ports.i18n.t(k === 'audio' ? 'layer_audio' : k === 'image' ? 'layer_image' : 'layer_video')}</span>
              </div>
              <div class="worker__row-meta">
                <span>{ports.i18n.tf('worker_counts_fmt', counts[k], counts[k === 'audio' ? 'active_audio' : k === 'image' ? 'active_image' : 'active_video'])}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
