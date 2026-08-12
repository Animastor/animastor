import type { JSX } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { t } from './i18n';
import { navigate, START_ROUTE, TAB_ROUTES } from './router';
import { secondaryTitle, secondaryAction } from './titleStore';
import { generationStatus } from '../state/generateStore';
import type { GenerationStatus } from '../state/generateStore';
import { IconFile, IconGenerate, IconPlay, IconEdit, IconMap, IconChevronLeft, IconChevronRight } from './icons';
import type { IconProps } from './icons';
import { FilePage } from '../pages/FilePage';
import { NavigatePage } from '../pages/NavigatePage';

const DESKTOP_SHELL_QUERY = '(min-width: 1180px)';

function useDesktopShell(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia(DESKTOP_SHELL_QUERY).matches);

  useEffect(() => {
    const media = window.matchMedia(DESKTOP_SHELL_QUERY);
    const update = () => setIsDesktop(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return isDesktop;
}

export function AppShell({ children }: { children: JSX.Element }) {
  const [, setPath] = useState(location.pathname);
  const isDesktop = useDesktopShell();
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // Normalize the start route so the File tab is active on "/".
  const path = location.pathname === '/' ? START_ROUTE : location.pathname;
  const isSecondary = !TAB_ROUTES.some((r) => path === r || path.startsWith(r + '/'));
  // NOTE: Android re-runs updateNavIconStatus on tab switches because Material
  // Components loses the custom tint/pulse during re-layout — a platform
  // workaround. The web keeps the CSS pulse class across re-renders, so there is
  // deliberately NO re-arm here: re-arming the 22s countdown on every navigation
  // kept the green SUCCESS indicator alive forever while the user browsed tabs.
  // generateStore anchors the auto-reset to the SUCCESS timestamp (watchdog).

  if (isDesktop && !isSecondary) {
    return <DesktopWorkspace path={path}>{children}</DesktopWorkspace>;
  }

  return (
    <div class="app-shell">
      <Toolbar path={path} isSecondary={isSecondary} />
      <div class="app-content">
        {isSecondary ? <div class="secondary">{children}</div> : children}
      </div>
      {!isSecondary && <TabBar path={path} />}
    </div>
  );
}

function DesktopWorkspace({ path, children }: { path: string; children: JSX.Element }) {
  const [filePanelCollapsed, setFilePanelCollapsed] = useState(false);
  const [navigatorPanelCollapsed, setNavigatorPanelCollapsed] = useState(false);
  const modes: { route: '/generate' | '/play' | '/edit'; key: 'tab_generate' | 'tab_play' | 'tab_edit'; Icon: (p: IconProps) => JSX.Element }[] = [
    { route: '/generate', key: 'tab_generate', Icon: IconGenerate },
    { route: '/play', key: 'tab_play', Icon: IconPlay },
    { route: '/edit', key: 'tab_edit', Icon: IconEdit },
  ];
  const hasWorkspaceMode = modes.some((mode) => path === mode.route || path.startsWith(mode.route + '/'));

  return (
    <div class="app-shell desktop-shell">
      <header class="desktop-header">
        <span class="desktop-header__brand">Animastor</span>
        <nav class="desktop-modes" aria-label="Workspace mode">
          {modes.map(({ route, key, Icon }) => {
            const active = path === route || path.startsWith(route + '/');
            return (
              <button
                type="button"
                class={'desktop-modes__item' + (active ? ' desktop-modes__item--active' : '')}
                aria-current={active ? 'page' : undefined}
                onClick={() => navigate(route)}
              >
                <Icon width={18} height={18} />
                <span>{t(key)}</span>
              </button>
            );
          })}
        </nav>
        <div class="desktop-header__actions">
          <button class="toolbar__ai-chip" aria-label={t('toolbar_ai')} onClick={() => navigate('/ai')}>
            {t('toolbar_ai')}
          </button>
          <button class="toolbar__btn" aria-label={t('settings')} onClick={() => navigate('/settings')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="22" height="22"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0 .33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.33 1.82l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z" /></svg>
          </button>
        </div>
      </header>
      <div class={'desktop-layout' + (filePanelCollapsed ? ' desktop-layout--file-collapsed' : '') + (navigatorPanelCollapsed ? ' desktop-layout--navigator-collapsed' : '')}>
        <aside class={'desktop-panel desktop-panel--file' + (filePanelCollapsed ? ' desktop-panel--collapsed' : '')} aria-label={t('tab_file')}>
          <div class="desktop-panel__title">
            <IconFile width={18} height={18} />
            <span class="desktop-panel__title-label">{t('tab_file')}</span>
            <button
              class="desktop-panel__collapse"
              type="button"
              aria-label={filePanelCollapsed ? t('edit_expand') : t('edit_collapse')}
              aria-expanded={!filePanelCollapsed}
              onClick={() => setFilePanelCollapsed((collapsed) => !collapsed)}
            >
              {filePanelCollapsed ? <IconChevronRight width={18} height={18} /> : <IconChevronLeft width={18} height={18} />}
            </button>
          </div>
          <FilePage />
        </aside>
        <main class="desktop-main">
          {hasWorkspaceMode ? children : <DesktopStartState />}
        </main>
        <aside class={'desktop-panel desktop-panel--navigator' + (navigatorPanelCollapsed ? ' desktop-panel--collapsed' : '')} aria-label={t('tab_navigate')}>
          <div class="desktop-panel__title">
            <IconMap width={18} height={18} />
            <span class="desktop-panel__title-label">{t('tab_navigate')}</span>
            <button
              class="desktop-panel__collapse"
              type="button"
              aria-label={navigatorPanelCollapsed ? t('edit_expand') : t('edit_collapse')}
              aria-expanded={!navigatorPanelCollapsed}
              onClick={() => setNavigatorPanelCollapsed((collapsed) => !collapsed)}
            >
              {navigatorPanelCollapsed ? <IconChevronLeft width={18} height={18} /> : <IconChevronRight width={18} height={18} />}
            </button>
          </div>
          <NavigatePage />
        </aside>
      </div>
    </div>
  );
}

function DesktopStartState() {
  return (
    <div class="desktop-start-state">
      <IconFile width={28} height={28} />
      <span>{t('file_from_device')}</span>
      <small>{t('file_from_device_desc')}</small>
    </div>
  );
}

function Toolbar({ path, isSecondary }: { path: string; isSecondary: boolean }) {
  // The AI assistant draws its own header row (back/session-list/new-chat) 1:1
  // with fragment_ai_assistant.xml — no standard toolbar, like the Android screen.
  if (path.startsWith('/ai')) return null;
  if (isSecondary) {
    // Pages may override the title and add a trailing action chip (e.g. the "</>"
    // dev chip on WorkflowDetails) — mirroring Android fragments calling
    // b.toolbar.title = ... / b.toolbar.addView(devChip).
    const title = secondaryTitle.value ?? secondaryTitleByPath(path);
    const action = secondaryAction.value;
    return (
      <header class="toolbar">
        <button class="toolbar__btn" aria-label={t('back')} onClick={() => history.back()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <span class="toolbar__title toolbar__title--secondary">{title}</span>
        {action && (
          <button
            class="toolbar__chip"
            aria-label={action.ariaLabel ?? action.label}
            onClick={action.onClick}
          >{action.label}</button>
        )}
      </header>
    );
  }
  return (
    <header class="toolbar">
      <span class="toolbar__title">Animastor</span>
      {/* AI chip — 1:1 with activity_main.xml toolbarAiButton (MaterialCardView 48x40dp,
          radius 10dp, outline stroke, bold text in accent color) */}
      <button
        class="toolbar__ai-chip"
        aria-label={t('toolbar_ai')}
        onClick={() => navigate('/ai')}
      >
        {t('toolbar_ai')}
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

function secondaryTitleByPath(path: string): string {
  if (path.startsWith('/settings/vbook')) return t('vbook_settings_title');
  if (path.startsWith('/settings/worker')) return t('worker_settings_title');
  if (path.startsWith('/settings')) return t('settings_title');
  if (path.startsWith('/ai')) return t('ai');
  if (path.startsWith('/library')) return t('library_title');
  if (path.startsWith('/workflows/type')) return t('workflow');
  if (path.startsWith('/workflows/')) return t('workflow');
  if (path.startsWith('/workflows')) return t('workflow_manager_title');
  if (path.startsWith('/dev')) return t('developer_tools');
  return '';
}

function TabBar({ path }: { path: string }) {
  const status: GenerationStatus = generationStatus.value;
  const items: { route: typeof TAB_ROUTES[number]; key: 'tab_file' | 'tab_generate' | 'tab_play' | 'tab_edit' | 'tab_navigate'; Icon: (p: IconProps) => JSX.Element }[] = [
    { route: '/file', key: 'tab_file', Icon: IconFile },
    { route: '/generate', key: 'tab_generate', Icon: IconGenerate },
    { route: '/play', key: 'tab_play', Icon: IconPlay },
    { route: '/edit', key: 'tab_edit', Icon: IconEdit },
    { route: '/navigate', key: 'tab_navigate', Icon: IconMap }
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
            <span class="tabbar__icon-box">
              <it.Icon class={'tabbar__icon' + (pulseClass ? ' ' + pulseClass : '')} width={24} height={24} />
            </span>
            <span class="tabbar__label">{t(it.key)}</span>
          </button>
        );
      })}
    </nav>
  );
}
