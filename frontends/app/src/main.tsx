import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import Router from "preact-router";
import { AppShell } from './app/AppShell';
import { FilePage } from '@animastor/web-file';
import { GeneratePage } from './pages/GeneratePage';
import { PlayPage } from './pages/PlayPage';
import { EditPage } from './pages/EditPage';
import { NavigatePage } from '@animastor/web-navigator';
import { SettingsPage } from './pages/SettingsPage';
import { LibraryPage } from './pages/LibraryPage';
import { WorkflowsPage } from './pages/WorkflowsPage';
import { WorkflowTypeListPage } from './pages/WorkflowTypeListPage';
import { WorkflowDetailsPage } from './pages/WorkflowDetailsPage';
import { DeveloperViewPage } from './pages/DeveloperViewPage';
import { AiAssistantPage } from './pages/AiAssistantPage';
import { AdminPage } from './pages/AdminPage';
import { applyTheme, applyLanguage } from './app/theme';
import { wirePlaybackCoordination, wirePlaybackLifecycle } from './state/playbackStore';
import { playerPorts } from './app/playerAdapters';
import { bookId } from './state/generateStore';
import { restoreBookSession } from './state/fileStore';
import { authMe } from './state/authStore';
import { navigatorPorts } from './app/navigatorAdapters';
import { filePorts } from './app/fileAdapters';

// MainActivity.setupPlaybackCoordination() equivalent — forwards
// generateStore.playbackPrepared to PlaybackViewModel (stage 4). Phase 1
// extraction prep: the engine receives ALL host dependencies through the
// injected PlayerPorts (composition root: app/playerAdapters.ts).
wirePlaybackCoordination(playerPorts);
// PlayFragment.onPause/onResume equivalent — pause on document.hidden, save /
// restore playback position via sessionStorage (stage 7, 06 §1.8).
wirePlaybackLifecycle();
// MainActivity cold-start session restore equivalent — reopen the last book
// (validated against the server, falling back to the most recent server book)
// so a page reload / new device keeps the open book.
void restoreBookSession();

function Routes() {
  return (
    <Router>
      <FilePage path="/" ports={filePorts} />
      <FilePage path="/file" ports={filePorts} />
      <GeneratePage path="/generate" />
      <PlayPage path="/play" ports={playerPorts} />
      <EditPage path="/edit" />
      <NavigatePage path="/navigate" ports={navigatorPorts} />
      <SettingsPage path="/settings" />
      <SettingsPage path="/settings/vbook" section="vbook" />
      <SettingsPage path="/settings/worker" section="worker" />
      <SettingsPage path="/settings/ai" section="ai" />
      <SettingsPage path="/settings/private-workers" section="private-workers" />
      <SettingsPage path="/settings/local-ai" section="local-ai" />
      <AiAssistantPage path="/ai" />
      <LibraryPage path="/library" />
      <WorkflowsPage path="/workflows" />
      {/* Declare the more specific type route BEFORE /:name (preact-router
          matches in declaration order) */}
      <WorkflowTypeListPage path="/workflows/type/:type" />
      <WorkflowDetailsPage path="/workflows/:name" />
      <DeveloperViewPage path="/dev" />
      <AdminPage path="/admin" />
    </Router>
  );
}

function Root() {
  useEffect(() => {
    applyTheme();
    applyLanguage();
    function onPop() { applyTheme(); applyLanguage(); }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Restore the user's last-opened book when they log in (auth transition
  // from anonymous → authenticated). restoreBookSession() reads the persisted
  // book ID from localStorage and validates it against the server.
  useEffect(() => {
    if (authMe.value.authenticated && !bookId.value) {
      void restoreBookSession();
    }
  }, [authMe.value.authenticated]);

  return (
    <AppShell>
      <Routes />
    </AppShell>
  );
}

render(<Root />, document.getElementById('app')!);
