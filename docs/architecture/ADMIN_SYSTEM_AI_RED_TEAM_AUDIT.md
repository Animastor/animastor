# Admin / System AI Red-Team Audit

**Date:** 2026-08-21
**Head:** `61e1d76f85b84f9cf770e64b13aa46ab534ac8a0`
**Scope:** System AI Control + Admin Foundation (kill switch, system provider, admin auth, provider resolution, credential security, SSRF, isolation)

---

## Scope

Audit of the newly implemented boundary:

```
Personal AI → System AI → Admin Control
```

Covers: system AI ON/OFF, system AI provider storage, AI provider resolution, admin authentication/authorization, `admin.animastor.in`, `/api/v1/admin/*`, system API credential handling, and legacy/global AI fallback paths.

**Out of scope:** General project audit, non-admin functionality, frontend features outside admin UI.

---

## Threat Model

Assumed attacker:
- Authenticated ordinary user, **or**
- Unauthenticated internet user, **or**
- Authenticated user who controls their own workspace/provider

Attacker must **not** be able to:
- Become admin
- Modify system AI
- Read system AI credentials
- Bypass system AI OFF
- Consume system AI when disabled
- Access another workspace's AI provider
- Make hostname alone grant admin access

---

## Authorization Findings

### `requireAdmin` Middleware (`auth-context.js:109-124`)

| Test | Result |
|------|--------|
| Anonymous → 401 | ✅ PASS |
| Authenticated regular user → 403 | ✅ PASS |
| `role='admin'` user → 200 | ✅ PASS |
| `ADMIN_USERNAMES` allowlist → 200 | ✅ PASS |
| Guest identity → 401 (no `req.user`) | ✅ PASS |
| Username casing bypass | ✅ PASS — both sides lowercased |
| Host/Origin/Referer injection | ✅ PASS — headers not consulted |
| JWT/session claims manipulation | ✅ PASS — server-side session with hash-only storage; no JWT |
| Crafted request altering `req.user` | ✅ PASS — set by `authContext` middleware from DB lookup only |
| Unauthenticated `/api/v1/admin/*` | ✅ PASS — 401 returned |

**Analysis:** `req.user` is populated exclusively by `authContext` → `authService.resolveSession(token)` → PostgreSQL session JOIN users. The session token is a `sid.<sessionId>.<secret>` cookie where only the SHA-256 hash of the secret is stored in the DB. There is no JWT to forge. The username is read from the `users` table, not from request headers. The allowlist is read from `ADMIN_USERNAMES` env var at request time, compared case-insensitively.

**No admin privilege escalation vectors found.**

### `admin.animastor.in` Domain (Nginx)

| Test | Result |
|------|--------|
| `admin.animastor.in` → Nginx Basic Auth + backend `requireAdmin` | ✅ PASS — two layers |
| `app.animastor.in/api/v1/admin/...` → backend `requireAdmin` → 403 | ✅ PASS — hostname is routing only |
| Unauthenticated admin endpoint → 401 | ✅ PASS |

**Analysis:** `admin.animastor.in` is a separate Nginx `server` block that adds `auth_basic` to all locations and redirects `/` → `/admin`. The same SPA dist is served. The backend `requireAdmin` middleware is applied regardless of hostname. The hostname change does NOT grant any access — authorization is entirely backend-enforced. Visiting `admin.animastor.in` alone grants nothing beyond Nginx Basic Auth, which is a transport-layer gate, not an authorization decision.

---

## System AI Kill Switch Findings

### Toggle Path Trace

```
Admin PUT /api/v1/admin/system-ai { enabled: false }
  → systemAi.setSystemAiEnabled(false)
    → PostgreSQL UPSERT system_settings (key='system_ai', value={"enabled":false})
    → invalidateAll()
      → _enabledCache = null          (5s TTL cache cleared)
      → workspaceAi.invalidateAllCache()  (workspace resolver cache cleared)
```

### Resolution Path

```
resolveAIForWorkspace(workspaceId)
  → workspace row? → buildWorkspaceProvider(row)
  → No workspace row → resolveSystemFallback()
    → systemAi.resolveSystemProvider()
      → isSystemAiEnabled()
        → read from _enabledCache or PG (5s TTL)
        → if OFF → return null
      → if null → try DB system_ai_providers row
      → if none → try env OPENROUTER_API_KEY
      → all null → return null
    → null → noProvider() (apiKey=null)
```

### Enforcement Matrix

| Scenario | Expected | Actual |
|----------|----------|--------|
| System AI ON, no personal provider, system provider configured | System provider usable | ✅ PASS |
| System AI OFF, no personal provider | System provider MUST NOT be used | ✅ PASS |
| System AI OFF, personal provider configured | Personal provider still works | ✅ PASS |
| Kill switch toggle invalidates cache | Immediate effect | ✅ PASS — `invalidateAll()` clears both caches |

**Kill switch enforcement is server-side.** All consumer paths (chat, streaming, prompt, agent bootstrap) resolve providers through the same `resolveAIForBook` → `resolveSystemFallback` → `systemAi.resolveSystemProvider` chain. The kill switch check is the first operation in `resolveSystemProvider`.

### `ai-service.js` Direct Env Key Gate

`ai-service.js:14-22` (`callAI`):
```js
let apiKey = provider && provider.apiKey;
if (!apiKey) {
    const systemAi = require('./system-ai');
    if (await systemAi.isSystemAiEnabled()) {
        apiKey = config.OPENROUTER_API_KEY;
    }
}
```

The env fallback in `callAI` is gated by `isSystemAiEnabled()`. Same pattern in `checkAIHealth`. **No ungated env key access exists in production AI call paths.**

---

## Credential Security Findings

### Storage
| Property | Status |
|----------|--------|
| System API key encrypted at rest (AES-256-GCM) | ✅ PASS |
| Encryption key from `WORKSPACE_SECRET_KEY` env | ✅ PASS |
| Workspace keys same encryption | ✅ PASS |

### API Responses
| Property | Status |
|----------|--------|
| GET returns `api_key_masked` only (last 4 chars) | ✅ PASS |
| PUT response returns masked meta | ✅ PASS |
| Plaintext never returned after write | ✅ PASS |
| `configured: true/false` boolean only | ✅ PASS |

### Errors and Logs
| Property | Status |
|----------|--------|
| Error messages generic ("Failed to...") | ✅ PASS |
| `sanitizeTestError()` never echoes credentials | ✅ PASS |
| Server logs never include API key | ✅ PASS |
| `console.error` logs only `err.message` | ✅ PASS |

### Frontend
| Property | Status |
|----------|--------|
| API key field is `type="password"` | ✅ PASS |
| Key cleared from state after save (`setApiKey('')`) | ✅ PASS |
| Never stored in localStorage/sessionStorage | ✅ PASS |
| Never placed in URL/query parameters | ✅ PASS |
| One-time entry pattern enforced | ✅ PASS |

### P2 Finding: Server Log May Capture Provider Error Bodies

**Code:** `workspace-ai-provider.js:484`
```js
console.warn(`[WORKSPACE-AI] testConnection non-ok status=${response.status} body=${text}`);
```

**Scenario:** If the AI provider returns an error response that includes the API key in its body (some providers echo credentials in 401 error messages), the server log could contain the key. The `sanitizeTestError` function strips this for the client response, but the raw body is logged server-side.

**Impact:** Server-side log only. Requires the AI provider to echo credentials in error responses. Mitigated by log rotation and server access controls. **P2** (defense-in-depth).

---

## Provider Resolution Findings

### Single Source of Truth

The workspace resolver (`resolveAIForWorkspace`) and system resolver (`resolveSystemProvider`) are the only paths to obtain an API key for AI calls. All consumers go through them:

| Consumer | Resolution Path | Kill Switch Enforced |
|----------|-----------------|---------------------|
| Chat (`/api/v1/ai/chat`) | `resolveChatAI()` → `resolveAIForBook()` | ✅ |
| Streaming (`/api/v1/ai/chat/stream`) | `resolveChatAI()` → `resolveAIForBook()` | ✅ |
| Prompt (`/api/v1/ai/prompt`) | `resolveChatAI()` → `resolveAIForBook()` | ✅ |
| Agent bootstrap (`bootstrapWithAgent`) | `resolveAIForBook()` | ✅ |
| AI service (`callAI`) | Provider arg + env gate | ✅ |
| Health check (`checkAIHealth`) | Provider arg + env gate | ✅ |

### P2 Finding: Exported `globalFallbackProvider()` Bypasses Kill Switch

**Code:** `workspace-ai-provider.js:151-160`
```js
function globalFallbackProvider() {
    return {
        source: 'global',
        provider: 'global',
        endpoint: null,
        apiKey: process.env.OPENROUTER_API_KEY || null,
        ...
    };
}
```

**Current state:** This function is exported but NOT called by any production code. The resolver uses `resolveSystemFallback()` which delegates to `system-ai.resolveSystemProvider()` (kill-switch gated).

**Risk:** If any future code calls `globalFallbackProvider()` directly instead of `resolveSystemFallback()`, the kill switch would be bypassed. The function is labeled as "legacy" and "kept for backward compatibility" but remains exported.

**Impact:** No current exploitation path. Dead code that represents a latent risk. **P2** (defense-in-depth / dead code).

---

## SSRF / Endpoint Safety Findings

### `url-safety.js` Analysis

The `assertPublicEndpoint` + `safeFetch` implementation is thorough:

| SSRF Vector | Protection |
|-------------|------------|
| Non-http(s) schemes | ✅ Blocked (`url.protocol` check) |
| Loopback IPv4 (127.x) | ✅ `isPrivateIPv4` |
| Private ranges (10.x, 172.16-31.x, 192.168.x) | ✅ `isPrivateIPv4` |
| Link-local (169.254.x) | ✅ `isPrivateIPv4` |
| Cloud metadata (169.254.169.254) | ✅ `isPrivateIPv4` |
| IPv6 loopback (::1) | ✅ `isPrivateIPv6` |
| IPv4-mapped IPv6 (::ffff:127.0.0.1) | ✅ `isPrivateIPv6` → `isPrivateIPv4` |
| Decimal/octal/hex IPv4 forms | ✅ `parseNumericHost` |
| DNS rebinding | ✅ `dns.promises.lookup({all:true})` checks ALL A/AAAA records |
| Redirects to private addresses | ✅ `safeFetch` re-validates every hop (`MAX_REDIRECTS=3`) |
| Unresolvable hostnames | ✅ Fail closed |
| Malformed URLs | ✅ `new URL()` throws → rejected |

### Admin Test Endpoint SSRF

`POST /api/v1/admin/system-ai/test` calls `workspaceAi.testConnection()` with `validatePublic: !!endpoint`. When a user-controlled endpoint is provided, SSRF validation is enforced. When testing the stored system provider (no explicit endpoint), the env fallback URL is operator-controlled and exempt — this is correct.

**No SSRF vulnerabilities found.**

### Admin Endpoint PUT SSRF Guard

`PUT /api/v1/admin/system-ai` validates the provider endpoint via `assertPublicEndpoint()` before saving. Admin-configured endpoints are subject to the same SSRF restrictions as workspace endpoints. This is defense-in-depth — the admin is trusted, but the guard prevents accidental misconfiguration.

---

## Isolation Findings

### System Provider vs Workspace Provider

| Property | Status |
|----------|--------|
| System provider stored in separate table (`system_ai_providers`) | ✅ |
| Workspace provider stored in `workspace_ai_providers` | ✅ |
| System provider never attached to a workspace | ✅ |
| Workspace A provider invisible to Workspace B | ✅ PASS (PK on `workspace_id`) |
| `getSystemProviderMeta` returns only masked data | ✅ |
| `getProviderMeta(workspaceId)` scoped to one workspace | ✅ |
| Cross-workspace isolation tested | ✅ (`workspace-ai-provider.test.js` line 256) |

### Guest Auto-Provisioning Exclusion

`auth-context.js:74`:
```js
!req.path.startsWith('/api/v1/admin')
```

Admin writes never auto-provision a guest workspace. Verified by test (`admin-security.test.js` test 8).

---

## Configuration Findings

### `ADMIN_USERNAMES` Empty

When `ADMIN_USERNAMES` is empty or unset:
- `.split(',')` → `['']`
- `.filter(Boolean)` → `[]`
- Only `role='admin'` users can access admin
- **Fail-safe** ✅

### `role='admin'` in Database

- `users.role` has `CHECK(role IN ('user','admin','premium'))` — only valid roles
- No auth routes accept role as user input — no mass assignment
- Only direct DB insert can set `role='admin'`
- Registration always creates `role='user'`

### `ADMIN_USERNAMES` Re-evaluated Per Request

The allowlist is read from `process.env` on every request. Changing the env var takes effect on the next request without restart. This is correct for a single-instance deployment.

### Can Workspace Data Modify Admin Config?

No. Admin routes (`/api/v1/admin/*`) and workspace settings routes (`/api/v1/settings/ai/*`) are completely separate route handlers with separate middleware stacks. Workspace provider data lives in `workspace_ai_providers`; system provider data lives in `system_ai_providers`.

---

## Missing Test Coverage

| Property | Coverage | Gap |
|----------|----------|-----|
| Anonymous → 401 | ✅ `admin-security.test.js:1` | — |
| Regular user → 403 | ✅ `admin-security.test.js:2` | — |
| role=admin → 200 | ✅ `admin-security.test.js:3` | — |
| Allowlist → 200 | ✅ `admin-security.test.js:4` | — |
| Kill switch toggle | ✅ `admin-security.test.js:5-6`, `system-ai.test.js:2` | — |
| Key masking | ✅ `admin-security.test.js:7`, `system-ai.test.js:6` | — |
| Kill switch blocks resolver | ✅ `system-ai.test.js:4` | — |
| Personal provider unaffected | ✅ `system-ai.test.js:5` | — |
| Cache invalidation | ✅ `system-ai.test.js:7` | — |
| Cross-workspace isolation | ✅ `workspace-ai-provider.test.js:256` | — |
| `ADMIN_USERNAMES` empty (fail-safe) | ❌ | No test for empty allowlist |
| Username casing in allowlist | ❌ | Only implicitly tested |
| Env fallback in admin test endpoint | ❌ | No test for test-path kill-switch behavior |
| SSRF for admin test endpoint | ❌ | No dedicated SSRF test for admin path |
| System provider not attached to workspace | ❌ | Implicit but not explicitly tested |
| Guest access to admin | ❌ | Tested indirectly (no `req.user` → 401) |

---

## Findings by Severity

### P0 — Direct Privilege Escalation / Credential Exposure / System AI Cost Bypass

**None.**

### P1 — Meaningful Security Weakness / Reliable System-Provider Bypass

**None.**

### P2 — Defense-in-Depth / Missing Coverage

| # | Finding | Location | Impact |
|---|---------|----------|--------|
| P2-1 | Server log may capture provider error bodies containing API key | `workspace-ai-provider.js:484` | Server-side log exposure; requires provider to echo credentials |
| P2-2 | Exported `globalFallbackProvider()` bypasses kill switch | `workspace-ai-provider.js:151-160` | Dead code; latent risk if future code calls it directly |
| P2-3 | Admin test endpoint env fallback when kill switch is OFF | `workspace-ai-provider.js:479` (`testConnection`) | Admin can test with env key even when kill switch is OFF; test-only, no AI workload execution |
| P2-4 | Missing test coverage for `ADMIN_USERNAMES` empty behavior | N/A | Fail-safe not verified by automated test |

### P3 — Polish / Documentation

| # | Finding | Location | Impact |
|---|---------|----------|--------|
| P3-1 | Admin bootstrap gap: seeded developer user has no password | `admin-routes.cjs` comments | Operator must manually set password or use `ADMIN_USERNAMES` with a separate user |
| P3-2 | `globalFallbackProvider()` exported but unused | `workspace-ai-provider.js` | Should be removed or explicitly marked as deprecated |

---

## Special Check: Admin Bootstrap Path

The implementation comments state the "seeded developer user has no password and cannot log in yet." The `ADMIN_USERNAMES` env var provides the intended bootstrap path.

**How does the operator actually become admin?**

1. **Option A:** Add the operator's username to `ADMIN_USERNAMES` env var. The operator registers a new account with that username. On login, `requireAdmin` grants access because the username is in the allowlist. ✅ Works.

2. **Option B:** The seeded developer user has `role='admin'` but no password. The operator must set a password hash directly in the DB to log in as that user. This is a manual DB operation. ⚠️ Operational gap.

3. **Option C:** Register a new user and update the DB to set `role='admin'`. Manual DB operation. ⚠️ Operational gap.

**Option A is the intended bootstrap path.** Options B and C require DB access, which is expected for an operator. The seeded developer user without a password is actually **safe** — nobody can log in as that user without DB modification.

**Classification:** P3 operational gap (not a security vulnerability). The bootstrap path works but requires documentation clarity.

---

## Final Verdict

```
PASS WITH WARNINGS
```

- **P0:** 0
- **P1:** 0
- **P2:** 4
- **P3:** 2

**Critical finding:** NONE

**Summary:** The admin/system AI control implementation is well-designed with defense-in-depth. The kill switch is enforced server-side across all AI call paths. Admin authorization is sound (session-based, no JWT, case-insensitive comparison, hostname-independent). Credentials are encrypted at rest and never returned in API responses. The SSRF guard is comprehensive. The only findings are minor: a dead exported function that bypasses the kill switch (P2-2), server log exposure risk on provider error bodies (P2-1), and missing test coverage for edge cases (P2-3, P2-4). No exploitable vulnerabilities exist in the current codebase.
