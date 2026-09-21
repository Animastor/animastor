# Changelog

## 0.1.0 — 2026-09-21

### Initial publishable release

- Initial extraction from the Animastor backend host
  ([auth-extraction-readiness-audit](https://github.com/Animastor/animastor/blob/main/docs/architecture/auth-extraction-readiness-audit.md) §16):
  `createAuthService` lifecycle (register with guest→account in-place
  conversion, login/logout, session + guest identity, legacy-name
  self-heal), the canonical book-access decision layer, the frozen cookie
  grammar (`animastor_sid`/`animastor_gid`), the config contract
  (`normalizeAuthConfig`/`normalizeCookieDomain`), `AuthError` +
  `WorkspaceExpiredError` and the scrypt password primitives.
- Host-agnostic: zero runtime dependencies (`node:crypto` only), no
  Express, no PostgreSQL, no `process.env`, no filesystem — persistence,
  the registration unit-of-work, the book-ownership resolver and config
  arrive only as injected ports (`assertAuthPorts`) and a normalized
  config object.
- Single `.` export root; the frozen 12-name public API is pinned by
  repository boundary guards (APB-G7) and the package contract suite.
