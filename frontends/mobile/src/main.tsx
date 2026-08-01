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
      <PlaceholderPage path="/ai" title="ai" />
      <PlaceholderPage path="/library" title="library" />
      <PlaceholderPage path="/workflows" title="workflows" />
      <PlaceholderPage path="/workflows/:name" title="workflows/:name" />
      <PlaceholderPage path="/workflows/type/:type" title="workflows/type" />
      <PlaceholderPage path="/dev" title="dev" />
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
