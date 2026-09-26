# Changelog

## 0.1.0 — 2026-09-26

### Initial publishable release

- Physical extraction from the Animastor backend host
  (`backend/src/services/url-safety.js`,
  [backend-decomposition-reconnaissance](https://github.com/Animastor/animastor/blob/main/docs/architecture/backend-decomposition-reconnaissance.md)
  §4.4) with strict behavior parity: `assertPublicEndpoint` (http/https
  only, literal IPv4/IPv6 private/loopback/link-local/metadata
  classification incl. decimal/octal/hex alternative forms and
  IPv4-mapped IPv6, ALL-records DNS resolution, fail-closed on
  resolution errors) and `safeFetch` (per-hop re-validation, manual
  redirect following, `ENDPOINT_NOT_PUBLIC`).
- Host-agnostic: zero runtime dependencies (`net` + call-time `dns`
  only), no `process.env`, no backend config, no Express, no
  filesystem — DNS resolution and fetch arrive only through the
  injected `dnsResolver`/`fetchImpl` ports (`setUrlSafetyPorts`;
  runtime defaults resolved lazily at call time).
- The operator exemption (`validatePublic: false`) is an explicit call
  parameter — the package never reads env itself.
- Single `.` export root; the frozen 7-name public API is pinned by
  repository boundary guards (USB-G*) and the package security suite.
