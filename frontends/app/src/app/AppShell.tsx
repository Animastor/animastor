import type { JSX } from 'preact';
import { useCallback, useState, useEffect, useRef } from 'preact/hooks';
import { t } from './i18n';
import { navigate, START_ROUTE, TAB_ROUTES } from './router';
import { secondaryTitle, secondaryAction } from './titleStore';
import { generationStatus } from '../state/generateStore';
import type { GenerationStatus } from '../state/generateStore';
import { IconFile, IconGenerate, IconPlay, IconEdit, IconMap, IconChevronLeft, IconChevronRight, IconFolder, IconAdd } from './icons';
import type { IconProps } from './icons';
import { FilePage } from '../pages/FilePage';
import { NavigatePage } from '../pages/NavigatePage';
import { AiAssistantPage } from '../pages/AiAssistantPage';
import { UserMenu } from '../features/auth/UserMenu';
import { bookId as openBookId, phase as playerPhase, blankBookJustCreated } from '../state/generateStore';
import { getJson } from '../api/client';
import type { BookData } from '../api/models';
import { sceneRefs } from '../api/models';
import { useDesktopShell } from './desktop';

const DESKTOP_PANEL_PREFS_KEY = 'animastor_desktop_panels';

interface DesktopPanelPrefs {
  filePanelCollapsed: boolean;
  navigatorPanelCollapsed: boolean;
}

function readDesktopPanelPrefs(): DesktopPanelPrefs {
  const fallback: DesktopPanelPrefs = { filePanelCollapsed: false, navigatorPanelCollapsed: false };
  try {
    const value = JSON.parse(localStorage.getItem(DESKTOP_PANEL_PREFS_KEY) || '{}') as Partial<DesktopPanelPrefs>;
    return {
      filePanelCollapsed: value.filePanelCollapsed === true,
      navigatorPanelCollapsed: value.navigatorPanelCollapsed === true,
    };
  } catch {
    return fallback;
  }
}

function writeDesktopPanelPrefs(prefs: DesktopPanelPrefs): void {
  try { localStorage.setItem(DESKTOP_PANEL_PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage may be unavailable */ }
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

  if (isDesktop) {
    return <DesktopWorkspace path={path} isSecondary={isSecondary}>{children}</DesktopWorkspace>;
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

function DesktopWorkspace({ path, isSecondary, children }: { path: string; isSecondary: boolean; children: JSX.Element }) {
  const [panelPrefs, setPanelPrefs] = useState<DesktopPanelPrefs>(readDesktopPanelPrefs);
  const { filePanelCollapsed, navigatorPanelCollapsed } = panelPrefs;
  useEffect(() => { writeDesktopPanelPrefs(panelPrefs); }, [panelPrefs]);
  // Panel routes (/file, /navigate) are side wings in the desktop shell — the
  // central workspace must always be one of the three work screens (Генератор /
  // Плеер / Редактор), never a duplicate of a wing. When the route lands on a
  // panel page while a book is open, bounce the center to the matching screen:
  // Плеер when the book already has parsed/generated scenes, Генератор when it
  // is still a raw unparsed import (first-import scenario). Mirrors the mobile
  // import flow (navigationEvent → Play/Generate tab), extended to session
  // restore and manual /file visits, which never emitted the event.
  useEffect(() => {
    if (path !== '/file' && path !== '/navigate') return;
    const bId = openBookId.value;
    if (!bId) return;
    let disposed = false;
    void getJson<BookData>(`/book/${encodeURIComponent(bId)}`)
      .then((bd) => {
        if (disposed) return;
        navigate(sceneRefs(bd).length > 0 ? '/play' : '/generate', { replace: true });
      })
      .catch(() => {
        // Book fetch failed (transient network / stale id) — fall back to the
        // store's phase mirror, which import/restore already settled.
        if (disposed) return;
        navigate(playerPhase.value === 'SCENE_READY' ? '/play' : '/generate', { replace: true });
      });
    return () => { disposed = true; };
  }, [path, openBookId.value]);
  // Assistant dock (plan §8): contextual overlay opened from the header — never
  // a route change, so the workspace below keeps its state. Escape + close
  // button + header toggle dismiss it; focus returns to the invoking chip.
  const [assistantOpen, setAssistantOpen] = useState(false);
  const assistantBtnRef = useRef<HTMLButtonElement | null>(null);
  // Single dismissal path (Escape / close button) so focus always returns to the
  // invoking chip (plan §8) and the dock never unmounts with focus inside it.
  const closeAssistant = useCallback(() => {
    setAssistantOpen(false);
    assistantBtnRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!assistantOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeAssistant(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [assistantOpen, closeAssistant]);
  const modes: { route: '/generate' | '/play' | '/edit'; key: 'tab_generate' | 'tab_play' | 'tab_edit'; Icon: (p: IconProps) => JSX.Element }[] = [
    { route: '/generate', key: 'tab_generate', Icon: IconGenerate },
    { route: '/play', key: 'tab_play', Icon: IconPlay },
    { route: '/edit', key: 'tab_edit', Icon: IconEdit },
  ];
  const hasWorkspaceMode = modes.some((mode) => path === mode.route || path.startsWith(mode.route + '/'));

  return (
    <div class="app-shell desktop-shell">
      <header class="desktop-header">
        <div class="desktop-header__identity">
          {/* Brand: existing app logo (website/logo.png) + wordmark. The logo's
              square cream canvas is circle-cropped in CSS (border-radius:50%
              + object-fit:cover — the Android launcher's round-container
              treatment) so it reads as a small app-icon, not a stuck-out
              square. */}
          <img class="desktop-header__logo" src="/logo.png" alt="" width="40" height="40" />
          <span class="desktop-header__brand">Animastor</span>
        </div>
        <nav class="desktop-modes" aria-label="Workspace mode">
          {modes.map(({ route, key, Icon }) => {
            const active = path === route || path.startsWith(route + '/');
            // Generation status lives on the Generator mode item's icon itself —
            // the mobile bottom-nav pattern (tabbar__pulse*) ported 1:1, so the
            // desktop keeps ONE Generator navigation item (plan §4.1 revisited:
            // no separate header status button next to the AI chip).
            const pulse = navIconPulseClass(route === '/generate', generationStatus.value);
            return (
              <button
                type="button"
                class={'desktop-modes__item' + (active ? ' desktop-modes__item--active' : '')}
                aria-current={active ? 'page' : undefined}
                onClick={() => navigate(route)}
              >
                <Icon class={pulse || undefined} width={18} height={18} />
                <span>{t(key)}</span>
              </button>
            );
          })}
        </nav>
        <div class="desktop-header__actions">
          <button
            ref={assistantBtnRef}
            class={'toolbar__ai-chip' + (assistantOpen ? ' toolbar__ai-chip--active' : '')}
            aria-label={t('toolbar_ai')}
            aria-expanded={assistantOpen}
            onClick={() => setAssistantOpen((open) => !open)}
          >
            {t('toolbar_ai')}
          </button>
          {/* Account & Workspace MVP (§19): [ User ] before [ Settings ] */}
          <UserMenu />
          <button
            class="toolbar__btn"
            aria-label={t('settings')}
            title={t('settings')}
            onClick={() => navigate('/settings')}
          >            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="22" height="22"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0 .33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.33 1.82l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z" /></svg>
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
              title={filePanelCollapsed ? t('edit_expand') : t('edit_collapse')}
              aria-expanded={!filePanelCollapsed}
              onClick={() => setPanelPrefs((prefs) => ({ ...prefs, filePanelCollapsed: !prefs.filePanelCollapsed }))}
            >
              {filePanelCollapsed ? <IconChevronRight width={18} height={18} /> : <IconChevronLeft width={18} height={18} />}
            </button>
          </div>
          <FilePage />
        </aside>
        <main class="desktop-main">
          {hasWorkspaceMode ? children
            : isSecondary ? <DesktopSecondary path={path}>{children}</DesktopSecondary>
            // A panel route with a book open never renders the wing in the
            // center — the redirect above bounces to the matching work screen;
            // this brief loading state covers the in-flight book fetch.
            : openBookId.value ? (
              <div class="desktop-start-state" role="status" aria-live="polite">
                <div class="progress desktop-start-state__progress"><div class="progress__bar" /></div>
                <small>{t('file_status_opening')}</small>
              </div>
            )
            : <DesktopStartState
                onOpenFile={() => {
                  // Show the File panel and let its always-mounted picker open.
                  setPanelPrefs((prefs) => ({ ...prefs, filePanelCollapsed: false }));
                  window.dispatchEvent(new CustomEvent('animastor:open-file'));
                }}
                onCreateAI={() => setAssistantOpen(true)}
              />}
        </main>
        <aside class={'desktop-panel desktop-panel--navigator' + (navigatorPanelCollapsed ? ' desktop-panel--collapsed' : '')} aria-label={t('tab_navigate')}>
          <div class="desktop-panel__title">
            <IconMap width={18} height={18} />
            <span class="desktop-panel__title-label">{t('tab_navigate')}</span>
            <button
              class="desktop-panel__collapse"
              type="button"
              aria-label={navigatorPanelCollapsed ? t('edit_expand') : t('edit_collapse')}
              title={navigatorPanelCollapsed ? t('edit_expand') : t('edit_collapse')}
              aria-expanded={!navigatorPanelCollapsed}
              onClick={() => setPanelPrefs((prefs) => ({ ...prefs, navigatorPanelCollapsed: !prefs.navigatorPanelCollapsed }))}
            >
              {navigatorPanelCollapsed ? <IconChevronLeft width={18} height={18} /> : <IconChevronRight width={18} height={18} />}
            </button>
          </div>
          <NavigatePage />
        </aside>
      </div>
      {/* Assistant dock — contextual overlay below the header (plan §8). The
          embedded AiAssistantPage keeps its session list / modes / context;
          only the back arrow becomes a close action. */}
      {assistantOpen && (
        <div class="assistant-dock" role="complementary" aria-label={t('ai')}>
          <AiAssistantPage embedded onClose={closeAssistant} />
        </div>
      )}
    </div>
  );
}

// Desktop containment for secondary routes (plan §4.4/§8): settings, library,
// workflows, dev and the /ai deep link render inside the desktop shell as full
// central content with a compact back bar — they no longer drop to the mobile
// toolbar composition on desktop.
function DesktopSecondary({ path, children }: { path: string; children: JSX.Element }) {
  const title = secondaryTitle.value ?? secondaryTitleByPath(path);
  return (
    <div class="desktop-secondary">
      <div class="desktop-secondary-bar">
        <button class="toolbar__btn toolbar__btn--back" aria-label={t('back')} title={t('back')} onClick={() => history.back()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <span class="desktop-secondary-bar__title">{title}</span>
      </div>
      {children}
    </div>
  );
}

function DesktopStartState({ onOpenFile, onCreateAI }: { onOpenFile: () => void; onCreateAI: () => void }) {
  return (
    <div class="desktop-start-state">
      <IconFile width={32} height={32} />
      <span class="desktop-start-state__title">{t('desktop_empty_title')}</span>
      <small>{t('desktop_empty_desc')}</small>
      <span class="desktop-start-state__actions">
        <button type="button" class="btn desktop-start-state__btn" onClick={onOpenFile}>
          <IconFolder width={18} height={18} /> {t('file_from_device')}
        </button>
        <button type="button" class="btn btn--outlined desktop-start-state__btn" onClick={onCreateAI}>
          <IconAdd width={18} height={18} /> {t('file_create')}
        </button>
      </span>
    </div>
  );
}

function Toolbar({ path, isSecondary }: { path: string; isSecondary: boolean }) {
  // The AI assistant draws its own header row (back/session-list/new-chat) 1:1
  // with fragment_ai_assistant.xml — no standard toolbar, like the Android screen.
  if (path.startsWith('/ai')) return null;

  // AI helper bubble: shown once after creating a blank book (editor opened).
  // Dismissed by clicking the bubble or the AI chip; persists for the session only.
  const AI_BUBBLE_DISMISSED = 'animastor_ai_bubble_dismissed';
  const [aiBubbleDismissed, setAiBubbleDismissed] = useState(() => {
    try { return sessionStorage.getItem(AI_BUBBLE_DISMISSED) === '1'; } catch { return false; }
  });
  const showAiBubble = !aiBubbleDismissed && path === '/edit' && blankBookJustCreated.value;
  if (isSecondary) {
    // Pages may override the title and add a trailing action chip (e.g. the "</>"
    // dev chip on WorkflowDetails) — mirroring Android fragments calling
    // b.toolbar.title = ... / b.toolbar.addView(devChip).
    const title = secondaryTitle.value ?? secondaryTitleByPath(path);
    const action = secondaryAction.value;
    return (
      <header class="toolbar">
        <button class="toolbar__btn toolbar__btn--back" aria-label={t('back')} title={t('back')} onClick={() => history.back()}>
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
      <span class="toolbar__ai-wrap">
        {showAiBubble && (
          <span class="toolbar__ai-bubble" onClick={() => {
            try { sessionStorage.setItem(AI_BUBBLE_DISMISSED, '1'); } catch { /* ignore */ }
            blankBookJustCreated.value = false;
            setAiBubbleDismissed(true);
            navigate('/ai');
          }}>
            {t('ai_helper_hint')}
          </span>
        )}
        <button
          class="toolbar__ai-chip"
          aria-label={t('toolbar_ai')}
          onClick={() => {
            if (showAiBubble) {
              try { sessionStorage.setItem(AI_BUBBLE_DISMISSED, '1'); } catch { /* ignore */ }
              blankBookJustCreated.value = false;
              setAiBubbleDismissed(true);
            }
            navigate('/ai');
          }}
        >
          {t('toolbar_ai')}
        </button>
      </span>
      <UserMenu />
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

/** Nav-icon generation status — MainActivity.updateNavIconStatus port, shared
 *  by the mobile TabBar and the desktop mode bar (ONE Generator navigation item
 *  in both shells, plan §4.1): RUNNING pulses gold, ERROR turns red, SUCCESS
 *  pulses green then holds solid (CSS `tabbar__pulse*` classes; SUCCESS auto-
 *  resets via generateStore's 22s watchdog). Empty string = no pulse. */
function navIconPulseClass(isGenerate: boolean, status: GenerationStatus): string {
  if (!isGenerate) return '';
  if (status === 'RUNNING') return 'tabbar__pulse';
  if (status === 'ERROR') return 'tabbar__pulse tabbar__pulse--error';
  if (status === 'SUCCESS') return 'tabbar__pulse tabbar__pulse--success';
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
        const pulseClass = navIconPulseClass(it.route === '/generate', status);
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
