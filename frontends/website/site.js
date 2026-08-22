// Animastor public website (animastor.in).
// Public landing page — no auth on this site itself. The application at
// app.animastor.in still has its own authentication, but this page is open
// to anyone. Handles Android version badge + theme toggle.
(function () {
  'use strict';

  var PREFS = 'animastor_settings';
  var btn = document.getElementById('theme-toggle');

  // Read current theme (set by the pre-paint inline script in index.html).
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  // Mirror the toggle state onto the button: pressed = currently dark.
  function syncAria() {
    if (!btn) return;
    var isDark = currentTheme() === 'dark';
    btn.setAttribute('aria-pressed', String(isDark));
    btn.title = isDark ? 'Switch to light theme' : 'Switch to dark theme';
  }

  function readStoredPrefs() {
    try {
      var raw = localStorage.getItem(PREFS);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function writeStoredPrefs(p) {
    try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch (e) { /* noop */ }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    syncAria();
  }

  function toggle() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    var prefs = readStoredPrefs();
    prefs.theme = next; // explicit user choice — overrides 'auto' elsewhere
    writeStoredPrefs(prefs);
  }

  if (btn) {
    syncAria();
    btn.addEventListener('click', toggle);
  }

  // Fetch Android version from downloads/version.json
  var versionEl = document.getElementById('android-version');
  if (versionEl) {
    fetch('/downloads/version.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (v) {
        if (v && v.version) versionEl.textContent = 'v' + v.version;
      })
      .catch(function () { /* keep default */ });
  }
})();
