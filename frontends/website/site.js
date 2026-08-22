// Animastor public website (animastor.in).
// Public landing page — no auth on this site itself. The application at
// app.animastor.in still has its own authentication, but this page is open
// to anyone. We only fetch the Android version badge here.
(function () {
  'use strict';

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
