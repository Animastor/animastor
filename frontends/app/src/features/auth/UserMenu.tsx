// Account & Workspace MVP — user menu + login/register dialog.
// Concept (§19-21 of ACCOUNT_WORKSPACE_CONCEPT): a user/workspace control in
// the top-right, separate from Settings. Anonymous → "Anonymous"; logged in →
// username + Personal workspace + Logout. Minimal by design: no account
// management, no workspace switcher (future stages).
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../app/i18n';
import { authMe, authLoading, authError, fetchMe, login, register, logout } from '../../state/authStore';

// Simple person SVG (concept §19: user-circle, NOT a group icon).
function IconUser(props: JSX.SVGAttributes<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="22" height="22" aria-hidden="true" {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
    </svg>
  );
}

export type AuthMode = 'login' | 'register';

/**
 * Login/Register dialog. Calls the auth endpoints; the session lives in an
 * HttpOnly cookie set by the backend (localStorage is never auth truth).
 */
export function AuthDialog({ mode, onClose, onModeChange }: { mode: AuthMode; onClose: () => void; onModeChange: (m: AuthMode) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => { submitRef.current?.focus(); setError(null); }, [mode]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(authError.value = null);
    try {
      if (mode === 'register') await register(username.trim(), password, email.trim() || undefined);
      else await login(username.trim(), password);
      onClose();
    } catch (err) {
      setError(authError.value || (err instanceof Error ? err.message : t('auth_error')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form class="modal auth-form" role="dialog" aria-modal="true" aria-label={mode === 'login' ? t('auth_login') : t('auth_register')} onSubmit={submit}>
        <div class="modal__title">{mode === 'login' ? t('auth_login') : t('auth_register')}</div>
        <div class="modal__body">
          <label class="wf-dialog__label" htmlFor="auth-username">{t('auth_username')}</label>
          <input id="auth-username" class="settings__input wf-dialog__input" type="text" autocomplete="username"
            value={username} onInput={(e) => setUsername((e.target as HTMLInputElement).value)} required autoFocus />
          <label class="wf-dialog__label" htmlFor="auth-password">{t('auth_password')}</label>
          <input id="auth-password" class="settings__input wf-dialog__input" type="password"
            autocomplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} required />
          {mode === 'register' && (
            <>
              <label class="wf-dialog__label" htmlFor="auth-email">{t('auth_email_optional')}</label>
              <input id="auth-email" class="settings__input wf-dialog__input" type="email" autocomplete="email"
                value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
              <span class="auth-form__hint">{t('auth_email_hint')}</span>
            </>
          )}
          {(error || authError.value) && <div class="auth-form__error" role="alert">{error || authError.value}</div>}
        </div>
        <div class="modal__footer">
          <button type="button" class="btn btn--outlined" onClick={onClose}>{t('back')}</button>
          <button
            type="button"
            class="auth-form__switch"
            onClick={() => onModeChange(mode === 'login' ? 'register' : 'login')}
          >
            {mode === 'login' ? t('auth_switch_to_register') : t('auth_switch_to_login')}
          </button>
          <button ref={submitRef} type="submit" class="btn" disabled={busy || authLoading.value}>
            {mode === 'login' ? t('auth_login') : t('auth_register')}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * User button + dropdown panel. Shows Anonymous or username; panel exposes
 * the personal workspace label and logout. Mounted in desktop header
 * actions and the mobile toolbar.
 */
export function UserMenu() {
  const me = authMe.value;
  const [open, setOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<AuthMode | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { void fetchMe(); }, []);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const onLogout = async () => {
    setOpen(false);
    await logout();
  };

  return (
    <span class="user-menu" ref={wrapRef}>
      <button
        class="toolbar__btn"
        aria-label={t('auth_menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        title={me.authenticated && me.user ? me.user.username : t('auth_anonymous')}
        onClick={() => setOpen((v) => !v)}
      >
        <IconUser />
      </button>
      {open && (
        <div class="user-menu__panel" role="menu">
          <div class="user-menu__head">
            <strong>{me.authenticated && me.user ? me.user.username : t('auth_anonymous')}</strong>
            {me.authenticated && me.workspace && (
              <>
                <small class="user-menu__workspace">{t('auth_personal_workspace')}</small>
                <small class="user-menu__workspace">{me.workspace.name}</small>
              </>
            )}
          </div>
          {me.authenticated ? (
            <button class="user-menu__item" role="menuitem" onClick={onLogout}>{t('auth_logout')}</button>
          ) : (
            <>
              <button class="user-menu__item user-menu__item--primary" role="menuitem" onClick={() => { setOpen(false); setDialogMode('login'); }}>
                {t('auth_login')}
              </button>
              <button class="user-menu__item" role="menuitem" onClick={() => { setOpen(false); setDialogMode('register'); }}>
                {t('auth_register')}
              </button>
              <small class="user-menu__note">{t('auth_register_hint')}</small>
            </>
          )}
        </div>
      )}
      {dialogMode !== null && (
        <AuthDialog
          mode={dialogMode}
          onClose={() => setDialogMode(null)}
          onModeChange={(m) => setDialogMode(m)}
        />
      )}
    </span>
  );
}
