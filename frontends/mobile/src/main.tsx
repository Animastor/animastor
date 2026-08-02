import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import Router from "preact-router";
import { AppShell } from './app/AppShell';
import { FilePage } from './pages/FilePage';
import { GeneratePage } from './pages/GeneratePage';
import { PlayPage } from './pages/PlayPage';
import { EditPage } from './pages/EditPage';
import { NavigatePage } from './pages/NavigatePage';
import { SettingsPage } from './pages/SettingsPage';
import { LibraryPage } from './pages/LibraryPage';
import { WorkflowsPage } from './pages/WorkflowsPage';
import { WorkflowTypeListPage } from './pages/WorkflowTypeListPage';
import { WorkflowDetailsPage } from './pages/WorkflowDetailsPage';
import { DeveloperViewPage } from './pages/DeveloperViewPage';
import { AiAssistantPage } from './pages/AiAssistantPage';
import { applyTheme, applyLanguage } from './app/theme';
import { wirePlaybackCoordination } from './state/playbackStore';

// MainActivity.setupPlaybackCoordination() equivalent — forwards
// generateStore.playbackPrepared to PlaybackViewModel (stage 4).
wirePlaybackCoordination();

function Routes() {
  return (
    <Router>
      <FilePage path="/" />
      <FilePage path="/file" />
      <GeneratePage path="/generate" />
      <PlayPage path="/play" />
      <EditPage path="/edit" />
      <NavigatePage path="/navigate" />
      <SettingsPage path="/settings" />
      <SettingsPage path="/settings/vbook" section="vbook" />
      <SettingsPage path="/settings/worker" section="worker" />
      <AiAssistantPage path="/ai" />
      <LibraryPage path="/library" />
      <WorkflowsPage path="/workflows" />
      {/* Declare the more specific type route BEFORE /:name (preact-router
          matches in declaration order) */}
      <WorkflowTypeListPage path="/workflows/type/:type" />
      <WorkflowDetailsPage path="/workflows/:name" />
      <DeveloperViewPage path="/dev" />
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
  return (
    <AppShell>
      <Routes />
    </AppShell>
  );
}

render(<Root />, document.getElementById('app')!);
