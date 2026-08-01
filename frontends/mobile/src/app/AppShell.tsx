import type { JSX } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { t } from './i18n';
import { navigate, TAB_ROUTES } from './router';
import { generationStatus } from '../state/generateStore';
import type { GenerationStatus } from '../state/generateStore';

export function AppShell({ children }: { children: JSX.Element }) {
  const [, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const path = location.pathname;

  return (
    <div class="app-shell">
      <Toolbar path={path} />
      <div class="app-content">
        {children}
      </div>
      <TabBar path={path} />
    </div>
  );
}

function Toolbar({ path }: { path: string }) {
  const isSecondary = !TAB_ROUTES.some((r) => path === r || path.startsWith(r + '/'));
  if (isSecondary) {
    return (
      <header class="toolbar">
        <button class="toolbar__btn" aria-label={t('back')} onClick={() => history.back()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <span class="toolbar__title">{secondaryTitle(path)}</span>
      </header>
    );
  }
  return (
    <header class="toolbar">
      <span class="toolbar__title">Animastor</span>
      <button
        class="toolbar__btn"
        aria-label={t('ai')}
        onClick={() => navigate('/ai')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="22" height="22"><path d="M12 2l2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5z" /></svg>
      </button>
      <button
        class="toolbar__btn"
        aria-label={t('settings')}
        onClick={() => navigate('/settings')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="22" height="22"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
      </button>
    </header>
  );
}

function secondaryTitle(path: string): string {
  if (path.startsWith('/settings/vbook')) return 'VBook';
  if (path.startsWith('/settings/worker')) return 'Workers';
  if (path.startsWith('/settings')) return t('settings');
  if (path.startsWith('/ai')) return t('ai');
  if (path.startsWith('/library')) return 'Library';
  if (path.startsWith('/workflows/type')) return 'Workflow';
  if (path.startsWith('/workflows/')) return 'Workflow';
  if (path.startsWith('/workflows')) return 'Workflows';
  if (path.startsWith('/dev')) return 'Developer';
  return '';
}

function TabBar({ path }: { path: string }) {
  const status: GenerationStatus = generationStatus.value;
  const items: { route: typeof TAB_ROUTES[number]; key: 'tab_file' | 'tab_generate' | 'tab_play' | 'tab_edit' | 'tab_navigate'; icon: string }[] = [
    { route: '/file', key: 'tab_file', icon: '/assets/icons/ic_file.svg' },
    { route: '/generate', key: 'tab_generate', icon: '/assets/icons/ic_spiral.svg' },
    { route: '/play', key: 'tab_play', icon: '/assets/icons/ic_play.svg' },
    { route: '/edit', key: 'tab_edit', icon: '/assets/icons/ic_edit.svg' },
    { route: '/navigate', key: 'tab_navigate', icon: '/assets/icons/ic_map.svg' }
  ];

  return (
    <nav class="tabbar">
      {items.map((it) => {
        const active = path === it.route || path.startsWith(it.route + '/');
        const isGenerate = it.route === '/generate';
        const pulseClass = isGenerate && status === 'RUNNING' ? 'tabbar__pulse'
          : isGenerate && status === 'ERROR' ? 'tabbar__pulse tabbar__pulse--error'
          : isGenerate && status === 'SUCCESS' ? 'tabbar__pulse tabbar__pulse--success'
          : '';
        return (
          <button
            class={'tabbar__item' + (active ? ' tabbar__item--active' : '')}
            onClick={() => navigate(it.route)}
            aria-label={t(it.key)}
            aria-current={active ? 'page' : undefined}
          >
            <img class={`tabbar__icon ${pulseClass}`} src={it.icon} alt="" />
            <span>{t(it.key)}</span>
          </button>
        );
      })}
    </nav>
  );
}
