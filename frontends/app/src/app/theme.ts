// Theme manager — mirrors Android MainActivity.applyTheme(). 'auto' resolves by hour.
export type ThemePref = 'auto' | 'dark' | 'light';
const PREFS = 'animastor_settings';

interface Settings {
  theme?: ThemePref;
  language?: 'auto' | 'ru' | 'en';
}

export function readPrefs(): Settings {
  try { return JSON.parse(localStorage.getItem(PREFS) || '{}') as Settings; }
  catch { return {}; }
}
export function writePrefs(patch: Partial<Settings>): void {
  const p = { ...readPrefs(), ...patch };
  localStorage.setItem(PREFS, JSON.stringify(p));
}

function resolveTheme(pref: ThemePref): 'dark' | 'light' {
  if (pref === 'auto') {
    const h = new Date().getHours();
    return h >= 6 && h <= 19 ? 'light' : 'dark';
  }
  return pref;
}

export function applyTheme(pref: ThemePref = readPrefs().theme ?? 'auto'): void {
  const r = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', r);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const css = getComputedStyle(document.documentElement).getPropertyValue('--theme-color');
    if (css) meta.setAttribute('content', css.trim());
  }
}

export function resolveLanguage(pref: 'auto' | 'ru' | 'en' = readPrefs().language ?? 'auto'): 'ru' | 'en' {
  if (pref === 'auto') return (navigator.language || 'en').indexOf('ru') === 0 ? 'ru' : 'en';
  return pref;
}

export function applyLanguage(pref: 'auto' | 'ru' | 'en' = readPrefs().language ?? 'auto'): void {
  document.documentElement.setAttribute('lang', resolveLanguage(pref));
}
