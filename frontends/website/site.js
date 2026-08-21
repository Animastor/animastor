// Animastor public website — auth entry points.
// Reuses the existing backend authentication (the same /api/v1/auth/*
// endpoints, account model, session cookie and security rules as
// app.animastor.in). This page never stores credentials or tokens: the
// session lives in the HttpOnly cookie set by the backend. On success the
// user is redirected to the authenticated application.
(function () {
  'use strict';

  var APP_URL = 'https://app.animastor.in/';
  var API = '/api/v1';

  var backdrop = document.getElementById('auth-backdrop');
  var form = document.getElementById('auth-form');
  var title = document.getElementById('auth-title');
  var username = document.getElementById('auth-username');
  var password = document.getElementById('auth-password');
  var emailWrap = document.getElementById('auth-email-wrap');
  var email = document.getElementById('auth-email');
  var errorBox = document.getElementById('auth-error');
  var switchBtn = document.getElementById('auth-switch');
  var cancelBtn = document.getElementById('auth-cancel');
  var submitBtn = document.getElementById('auth-submit');
  var loginBtn = document.getElementById('btn-login');
  var registerBtn = document.getElementById('btn-register');
  var headerUser = document.getElementById('header-user');

  var mode = 'login'; // 'login' | 'register'
  var busy = false;

  function setMode(m) {
    mode = m;
    var isLogin = m === 'login';
    title.textContent = isLogin ? 'Sign in' : 'Create account';
    submitBtn.textContent = isLogin ? 'Sign in' : 'Create account';
    switchBtn.textContent = isLogin ? 'No account? Sign up' : 'Have an account? Sign in';
    password.setAttribute('autocomplete', isLogin ? 'current-password' : 'new-password');
    emailWrap.hidden = isLogin;
    hideError();
  }

  function showError(msg) {
    errorBox.textContent = msg || 'Error';
    errorBox.hidden = false;
  }
  function hideError() { errorBox.hidden = true; }

  function openDialog(m) {
    setMode(m);
    backdrop.hidden = false;
    username.value = '';
    password.value = '';
    email.value = '';
    username.focus();
  }
  function closeDialog() { backdrop.hidden = true; }

  function postJson(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) {
          var err = new Error(json.error || json.message || ('Request failed (' + res.status + ')'));
          err.status = res.status;
          throw err;
        }
        return json;
      });
    });
  }

  function submit(e) {
    e.preventDefault();
    if (busy) return;
    busy = true;
    submitBtn.disabled = true;
    hideError();
    var body = { username: username.value.trim(), password: password.value };
    if (mode === 'register' && email.value.trim()) body.email = email.value.trim();
    postJson(mode === 'register' ? '/auth/register' : '/auth/login', body)
      .then(function () {
        // Session cookie is set by the backend (Domain-scoped to
        // animastor.in) — hand over to the authenticated application.
        window.location.href = APP_URL;
      })
      .catch(function (err) {
        showError(err.message);
        busy = false;
        submitBtn.disabled = false;
      });
  }

  // Header state: reflect /auth/me (same source of truth as the app).
  function refreshMe() {
    fetch(API + '/auth/me', { headers: { 'Accept': 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (me) {
        if (me && me.authenticated && me.user) {
          headerUser.textContent = me.user.username;
          headerUser.hidden = false;
          loginBtn.hidden = true;
          registerBtn.hidden = true;
        }
      })
      .catch(function () { /* anonymous — default header stays */ });
  }

  loginBtn.addEventListener('click', function () { openDialog('login'); });
  registerBtn.addEventListener('click', function () { openDialog('register'); });
  cancelBtn.addEventListener('click', closeDialog);
  switchBtn.addEventListener('click', function () { setMode(mode === 'login' ? 'register' : 'login'); });
  form.addEventListener('submit', submit);
  backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeDialog(); });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !backdrop.hidden) closeDialog();
  });

  // "Create an account" links inside the page content.
  Array.prototype.forEach.call(document.querySelectorAll('[data-auth]'), function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault();
      openDialog(el.getAttribute('data-auth') || 'register');
    });
  });

  refreshMe();
})();
