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
import { PlaceholderPage } from './pages/PlaceholderPage';
import { applyTheme, applyLanguage } from './app/theme';

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
      <PlaceholderPage path="/ai" titleKey="ai" />
      <LibraryPage path="/library" />
      <PlaceholderPage path="/workflows" titleKey="workflow_manager_title" />
      <PlaceholderPage path="/workflows/:name" titleKey="workflow" />
      <PlaceholderPage path="/workflows/type/:type" titleKey="workflow" />
      <PlaceholderPage path="/dev" titleKey="developer_tools" />
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
