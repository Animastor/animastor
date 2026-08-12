// desktop.ts — shared desktop-shell helpers.
//
// Lives outside AppShell so pages (NavigatePage, EditPage) can ask whether the
// desktop shell is active WITHOUT importing AppShell, which itself imports
// pages to render them in panels — importing AppShell from a page would create
// a module cycle (AppShell → page → AppShell).

import { useState, useEffect } from 'preact/hooks';

// Must match the AppShell switch: below this width the mobile composition
// (toolbar + tab bar) is used, at/above it the DesktopWorkspace renders.
export const DESKTOP_SHELL_QUERY = '(min-width: 1180px)';

export function useDesktopShell(): boolean {
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
