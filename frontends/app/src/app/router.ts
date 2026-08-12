// SPA router on top of preact-router. Keeps tab state because pages persist their
// state in module-level stores (not in component state), exactly like Android
// Fragment.hide/show preserves Fragment instances.
export type Route =
  | '/file' | '/generate' | '/play' | '/edit' | '/navigate'
  | '/settings' | '/ai' | '/library'
  | '/workflows' | '/workflows/:name'
  | '/workflows/type/:type' | '/dev'
  | '/settings/vbook' | '/settings/worker';

export const TAB_ROUTES: Route[] = ['/file', '/generate', '/play', '/edit', '/navigate'];
export const START_ROUTE: Route = '/file';

export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const url = typeof route === 'string' ? route : route;
  if (opts.replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  dispatchEvent(new PopStateEvent('popstate'));
}
