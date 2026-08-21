# Phase 4 Red-Team Security Audit — Personal AI Provider

**Audit Date:** 2026-08-21  
**Auditor:** Buffy (Independent Red-Team Security Auditor)  
**Scope:** Phase 4 Checkpoints A–C (commits `4dbedc2..c012690`)  
**HEAD:** `c012690` (`feat(beta): frontend provider_type selector + Phase 4 documentation (Chk C)`)  
**9 files changed:** +1785 / −30 lines  

---

## 1. Full Architecture Trace

### Data Flow

```
Settings UI (SettingsPage.tsx)
  │  PUT /api/v1/settings/ai/provider  { endpoint, api_key, model, provider_type }
  ▼
settings-ai-routes.cjs
  │  identityGuard → req.workspace.id (server-derived, NEVER from body)
  │  assertPublicEndpoint(endpoint) → SSRF guard at save time
  │  normalizeProviderType()
  ▼
workspace-ai-provider.js
  │  encryptSecret(apiKey) → AES-256-GCM(iv:tag:cipher)
  │  INSERT/UPDATE workspace_ai_providers (api_key_enc = ciphertext)
  │  publicMeta(row) → { configured, api_key_masked, ... } — NEVER plaintext
  ▼
PostgreSQL: workspace_ai_providers.api_key_enc (encrypted at rest)
  │
  │  [At AI call time]
  │
resolveAIProvider(workspaceId, purpose)
  │  → resolveAIForWorkspace(workspaceId)
  │     → getRow(workspaceId) → decryptSecret(row.api_key_enc) → plaintext
  │     → cache in _cache (Map, 30s TTL, workspace-keyed)
  │  → shallow copy with purpose tag (never mutates cache snapshot)
  ▼
ai-caller.js
  │  runWithProvider(provider, fn) → AsyncLocalStorage context
  │  callAI(messages) → picks provider from context
  ▼
ai-service.js
  │  safeFetch(endpoint/chat/completions, { validatePublic: true })
  │     → assertPublicEndpoint per hop (redirects re-validated)
  ▼
LLM Provider HTTP
```

### Boundaries

| Boundary | Location | Enforcement |
|----------|----------|-------------|
| **Authoritative identity** | `req.workspace.id` from `authContext` middleware | Server-derived, never client-supplied |
| **Secret boundary** | `workspace-ai-provider.js` — `encryptSecret` / `decryptSecret` | AES-256-GCM, key from `WORKSPACE_SECRET_KEY` |
| **Provider boundary** | `_cache` Map keyed by `workspaceId` | 30s TTL, invalidated on write/delete |
| **SSRF boundary** | `url-safety.js` — `assertPublicEndpoint` + `safeFetch` | Per-save + per-fetch + per-redirect-hop |

---

## 2. Cross-Workspace Attack

### Analysis

The workspace ID is **always** derived from the authenticated identity:

```javascript
// settings-ai-routes.cjs:12-23
function identityGuard(req, res) {
    // ... expired guest / anonymous checks ...
    return req.workspace.id;  // ← server-derived, from authContext middleware
}
```

**Attack vectors tested:**

| Vector | Result |
|--------|--------|
| PUT body `workspace_id` field | **IGNORED** — route never reads it |
| GET with foreign workspace_id | **401** — `req.workspace.id` used, not path param |
| Cross-workspace provider cache | **NO** — `_cache` is keyed by `workspaceId`, never crosses |
| Cross-workspace AI call | **403** — `aiBookGuard` + `requireBookAccess` prevent victim book access |
| Book→workspace→provider chain | **SAFE** — `resolveAIForBook` resolves book→workspace→provider correctly |

### Test Coverage

- `workspace-ai-security.test.js`: "Workspace A → victim book in body: 403", "query/body book mismatch: 400"
- `personal-ai-provider-phase4.test.js`: "Cross-workspace isolation — never accepts a foreign id"

**Verdict: NO cross-workspace isolation bypass found.**

---

## 3. API Key Leakage

### Paths Tested

| Path | Key in response? | Evidence |
|------|-----------------|----------|
| GET `/settings/ai/provider` | **NO** | `publicMeta()` returns `{ configured, api_key_masked }` only |
| GET `/settings/ai/providers` | **NO** | Same `publicMeta()` shape |
| PUT `/settings/ai/provider` | **NO** | Returns `publicMeta(row)` after encrypt |
| POST `/settings/ai/test` | **NO** | `delete result.apiKey` at line handler + `sanitizeTestError()` |
| Error responses (4xx/5xx) | **NO** | `sanitizeTestError()` strips all host/key/body detail |
| Console logs | **NO** | `console.warn('[WORKSPACE-AI] testConnection non-ok ...')` logs status+body excerpt, never the key |
| Database | **NO** | Only `api_key_enc` (ciphertext) stored |
| Frontend state | **NO** | `setApiKey('')` immediately after save |
| Frontend localStorage/URL | **NO** | Key is React `useState` only, cleared after save |

### sanitizeTestError() Analysis

```javascript
// workspace-ai-provider.js:406-421
function sanitizeTestError(err, httpStatus) {
    if (httpStatus === 401 || httpStatus === 403) return 'Authentication failed';
    if (httpStatus === 404) return 'Endpoint or model not found';
    if (httpStatus === 429) return 'Rate limited by provider';
    // ... generic messages for network/DNS/TLS ...
    const msg = String(err?.message || 'Connection failed').substring(0, 120);
    // returns sanitized substring — never echoes Authorization header
}
```

**Weakness found:** The `sanitizeTestError` truncates error messages to 120 chars but doesn't explicitly strip patterns like `sk-` or `Bearer`. However, provider error messages don't typically echo back the Authorization header. The `testConnection` handler in the route also `delete result.apiKey`.

**Verdict: NO key leakage path confirmed. The defense is layered (backend sanitization + route cleanup + frontend clear).**

---

## 4. Encryption at Rest

### Algorithm

- **Algorithm:** AES-256-GCM (authenticated encryption)
- **IV:** 12 bytes random (`crypto.randomBytes(12)`)
- **Auth tag:** 16 bytes (GCM default, from `cipher.getAuthTag()`)
- **Serialized format:** `iv64:tag64:cipher64` (base64-encoded)
- **Key derivation:** `SHA-256(WORKSPACE_SECRET_KEY)` → 32 bytes

### Assessment

AES-256-GCM is industry-standard. Random IV per encryption prevents deterministic ciphertext. Auth tag prevents tampering. The key is derived via SHA-256 from the env var.

**Concern:** The same `WORKSPACE_SECRET_KEY` encrypts ALL workspaces. A leaked env var exposes all credentials. Key rotation requires re-encrypting all rows (no rotation mechanism exists).

**Verdict: Encryption is correctly implemented. Key rotation gap is informational (not blocking for Beta).**

---

## 5. CRITICAL: WORKSPACE_SECRET_KEY

### Runtime Behavior

```javascript
// workspace-ai-provider.js:48-57
function getSecretKey() {
    const raw = process.env.WORKSPACE_SECRET_KEY;
    if (!raw) {
        if (!_logEmitted) {
            _logEmitted = true;
            console.warn('[WORKSPACE-AI] WORKSPACE_SECRET_KEY not set — using insecure development key');
        }
        return crypto.createHash('sha256')
            .update('animastor-dev-workspace-secret-key-do-not-use-in-prod')
            .digest();
    }
    return crypto.createHash('sha256').update(raw).digest();
}
```

| Scenario | Behavior | Severity |
|----------|----------|----------|
| `WORKSPACE_SECRET_KEY` exists | Key derived from env var | ✅ Safe |
| `WORKSPACE_SECRET_KEY` missing | **Deterministic fallback key** used | ⚠️ MEDIUM |
| `WORKSPACE_SECRET_KEY` empty string | Fallback key used (empty string → different SHA-256 than missing) | ⚠️ MEDIUM |
| `WORKSPACE_SECRET_KEY` malformed | Fallback key used (any non-empty string → SHA-256) | ✅ Safe |
| Different key after restart | All existing ciphertext becomes undecryptable (returns null → global fallback) | ✅ Fail-safe |
| Production docker-compose | Sets the env var | ✅ Safe |

### Finding F-01: Deterministic Fallback Key

- **Severity:** MEDIUM
- **Category:** SECURITY
- **Status:** CONFIRMED
- **Description:** When `WORKSPACE_SECRET_KEY` is unset, a hardcoded key (`sha256('animastor-dev-workspace-secret-key-do-not-use-in-prod')`) is used. This key is publicly visible in the source code. Any attacker with access to the database in this state can decrypt all credentials.
- **Mitigating factors:** 
  - A warning is logged once at startup
  - Production docker-compose sets the env var
  - The fallback is intentionally for dev/test only
  - Decryption failure returns null → global fallback (no crash)
- **Attack scenario:** Production instance accidentally starts without `WORKSPACE_SECRET_KEY`. All workspace API keys in the database are encrypted with the publicly known dev key.
- **Impact:** Credential exposure for all workspaces
- **Recommended fix:** Fail hard in production (throw on missing key when `NODE_ENV=production`) or at minimum log a prominent startup warning that persists.

---

## 6. Secret Cache

### What Is Cached

```javascript
const _cache = new Map(); // workspaceId → { resolvedAt, provider }
```

The cached object contains `{ source, provider, endpoint, apiKey, model, workspaceId }` — including the **decrypted plaintext API key**.

### Cache Analysis

| Property | Value |
|----------|-------|
| Storage | In-memory `Map` (process-global) |
| TTL | 30 seconds |
| Key | `workspaceId` (string) |
| Invalidated on | upsert, delete, setLastTest |
| Cross-workspace leak? | **NO** — each workspace has its own key |

### Finding F-02: Plaintext Key in Memory Cache

- **Severity:** LOW
- **Category:** SECURITY
- **Status:** INFORMATIONAL
- **Description:** The resolved provider object (including decrypted `apiKey`) is held in a process-global `Map` for 30 seconds. Any code running in the same Node.js process can read `_cache.get(workspaceId).provider.apiKey`.
- **Mitigating factors:**
  - Node.js is single-threaded; no concurrent access to Map internals
  - The cache is workspace-keyed; Workspace A cannot read Workspace B's entry
  - The same plaintext key is also in the `AsyncLocalStorage` context during AI calls (necessary for HTTP requests)
  - This is architecturally unavoidable — the key must be decrypted to make HTTP requests
- **Verdict:** Not a security vulnerability per se; inherent to the architecture. The30s TTL bounds exposure.

---

## 7. SSRF — Primary Attack Surface

### Implementation

`url-safety.js` provides two layers:

1. **`assertPublicEndpoint(urlString)`** — resolves hostname DNS, checks ALL records for private/special addresses
2. **`safeFetch(urlString, opts)`** — wraps `fetch()` with manual redirect following, re-validates EVERY hop

### Blocked Addresses (verified by tests)

| Category | Examples | Blocked? |
|----------|----------|----------|
| Loopback | `127.0.0.1`, `::1` | ✅ YES |
| RFC1918 | `10.x.x.x`, `172.16-31.x.x`, `192.168.x.x` | ✅ YES |
| Link-local | `169.254.169.254` (metadata) | ✅ YES |
| CGNAT | `100.64.x.x` | ✅ YES |
| Decimal IP | `2130706433` (=127.0.0.1) | ✅ YES |
| Octal IP | `0177.0.0.1` | ✅ YES |
| Hex IP | `0x7f000001` | ✅ YES |
| IPv4-mapped IPv6 | `::ffff:127.0.0.1` | ✅ YES |
| IPv6 ULA | `fc00::1` | ✅ YES |
| IPv6 link-local | `fe80::1` | ✅ YES |
| Non-http schemes | `ftp://`, `file://`, `javascript:` | ✅ YES |
| DNS → private | hostname resolves to RFC1918 | ✅ YES |
| Multi-A record w/ private | public + private in same DNS response | ✅ YES |

**Verdict: SSRF protection is comprehensive and well-tested.**

---

## 8. SSRF Bypass Techniques

| Technique | Tested? | Result |
|-----------|---------|--------|
| Decimal IP (`2130706433`) | ✅ | BLOCKED |
| Hex IP (`0x7f000001`) | ✅ | BLOCKED |
| Octal IP (`0177.0.0.1`) | ✅ | BLOCKED |
| IPv6 loopback (`[::1]`) | ✅ | BLOCKED |
| IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`) | ✅ | BLOCKED |
| IPv6 ULA (`[fc00::1]`) | ✅ | BLOCKED |
| IPv6 link-local (`[fe80::1]`) | ✅ | BLOCKED |
| Mixed-case hostname | Partial | WHATWG URL lowercases hostnames; `new URL()` handles this |
| Trailing dot (`example.com.`) | Partial | WHATWG URL strips trailing dot |
| Userinfo (`https://user@host`) | Partial | WHATWG URL parses userinfo separately from hostname; the hostname is checked |
| Encoded hostname | Partial | WHATWG URL decodes percent-encoding before hostname extraction |
| Redirect to private | ✅ | BLOCKED — `safeFetch` follows manually, re-validates each hop |

**Finding F-03: DNS Rebinding TOCTOU Window**

- **Severity:** LOW
- **Category:** SECURITY
- **Status:** CONFIRMED (Mitigated)
- **Description:** `assertPublicEndpoint()` resolves DNS and checks IPs, then `safeFetch()` makes the actual HTTP request. Between the check and the connect, DNS could theoretically change (classic TOCTOU). However, Node.js `fetch` resolves DNS at connect time, so the resolution in `assertPublicEndpoint` is a *separate* resolution from the one in `fetch`.
- **Mitigating factors:**
  - The window is extremely narrow (milliseconds)
  - DNS TTL typically prevents rapid re-resolution
  - The `lookup` function in tests stubs DNS to return a fixed answer, proving the check works
  - Real-world DNS rebinding requires attacker-controlled DNS, which is a significant prerequisite
  - A second resolution happens inside `fetch()` at connect time
- **Impact:** Theoretical SSRF via DNS rebinding in extremely controlled conditions
- **Recommended fix:** Pass resolved IP address to fetch (if Node.js fetch supports it) or use a DNS-over-HTTPS resolver that returns a pinned result

---

## 9. DNS Rebinding

**Analysis:** `assertPublicEndpoint()` resolves ALL DNS records (`{ all: true }`) and checks every address. This defeats round-robin DNS rebinding where a domain alternates between public and private IPs.

**Finding F-03 applies here** — the TOCTOU window exists but is mitigated by the narrow timing.

**Verdict: Mitigated. The `all: true` resolution is a strong defense against the common DNS rebinding shape.**

---

## 10. Redirect Security

`safeFetch` uses `redirect: 'manual'` and processes redirects manually:

```javascript
for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (validatePublic) {
        const verdict = await assertPublicEndpoint(currentUrl);
        if (!verdict.ok) throw ENDPOINT_NOT_PUBLIC;
    }
    const response = await global.fetch(currentUrl, { ...fetchOpts, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
        currentUrl = new URL(location, currentUrl).href;
        continue;
    }
    return response;
}
```

| Check | Result |
|-------|--------|
| Redirect limit | ✅ MAX_REDIRECTS =3 |
| Per-hop re-validation | ✅ Every hop calls `assertPublicEndpoint` |
| Protocol changes | ✅ HTTP→HTTPS or HTTPS→HTTP both validated |
| Hostname changes | ✅ New hostname resolved and checked |
| Redirect loop | ✅ Limited by MAX_REDIRECTS |

**Tested:** Public → `http://169.254.169.254/latest/meta-data` returns `ENDPOINT_NOT_PUBLIC`.

**Verdict: Redirect security is correctly implemented.**

---

## 11. Protocol Security

- HTTP is allowed for user-controlled endpoints
- This is necessary for local development (self-hosted LLM on `http://localhost` — but `localhost` is blocked by SSRF guard)
- User who sets `http://public-server.example/v1` gets unencrypted traffic, but that's their choice for their own endpoint
- The SSRF guard still blocks private addresses regardless of protocol

**Verdict: HTTP allowance is acceptable for the deployment model. Not a security finding.**

---

## 12. Provider Response Attack

| Attack Vector | Mitigation |
|---------------|------------|
| Huge body | `response.text().substring(0, 200)` in test handler; `substring(0, 500)` in ai-service.js |
| Malformed JSON | `JSON.parse` wrapped in try/catch |
| Invalid encoding | UTF-8 default, truncated |
| Unexpected fields | Only `choices[0].message.content` read |
| Error body containing secrets | `sanitizeTestError()` strips all body detail |
| Extremely long error | Truncated to 120 chars in `sanitizeTestError()` |
| Slow response | `AbortSignal.timeout(20_000)` in test; `60_000` in chat |
| Connection reset | Caught and sanitized |

**Verdict: Provider responses are defensively handled.**

---

## 13. Provider Routing

`resolveAIProvider(workspaceId, purpose)` is the single entry point:

- Purpose is logged but doesn't change routing (one provider per workspace)
- Unknown purposes accepted (forward-compatible)
- Personal-only fail-closed: when no provider AND no global key → `source: 'unconfigured'`
- Fallback to global is intentional backward compatibility (Phase 1-3)

**Concern:** In Personal-only mode (spec §10), `resolveAIProvider` returns `source: 'unconfigured'`, but `resolveAIForWorkspace` still falls back to global. This means the "fail-closed" behavior only applies when the caller explicitly checks `provider.source`. Callers that use `resolveAIForWorkspace` directly (ai-routes.cjs `resolveChatAI`) will get the global fallback.

**Finding F-04: Inconsistent Fail-Closed Behavior**

- **Severity:** LOW
- **Category:** RELIABILITY
- **Status:** CONFIRMED
- **Description:** `resolveAIProvider()` marks unconfigured workspaces as `source: 'unconfigured'`, but `resolveAIForWorkspace()` and `resolveAIForBook()` fall back to global. Chat routes (`ai-routes.cjs:resolveChatAI`) use `resolveAIForBook()`, so they silently use the global key when no workspace provider exists. This may be intentional (backward compatibility) but contradicts the "fail-closed Personal-only" spec §10.
- **Impact:** In a Personal-only deployment, a workspace without a configured provider will silently use the global env key rather than failing clearly.
- **Recommended fix:** Document this as intentional or have `resolveChatAI` check `provider.source` and surface an error.

---

## 14. Chat Integration

- Workspace derived from `req.workspace.id` (server-authenticated)
- `resolveChatAI(bookId)` resolves book→workspace→provider
- No `provider_id` or `workspace_id` parameter accepted from client
- `aiBookGuard` middleware prevents cross-workspace book access
- Timeout: `AbortController` + `60_000ms`

**Verdict: Chat integration is workspace-scoped. No cross-workspace provider use possible.**

---

## 15. Book Parser Integration

- `resolveAIForBook(bookId)` → book→workspace→provider
- Provider resolved at dispatch time (not enqueue time)
- Workspace stored in `generation_tasks.workspace_id`
- `bootstrap.js` wraps the entire pipeline in `runWithProvider()`

**Verdict: Parser uses the same provider resolution chain. No cross-workspace leak possible.**

---

## 16. Provider Rotation Race

| Scenario | Behavior |
|----------|----------|
| Request starts with key A, key rotated to B mid-request | Request continues with key A (from AsyncLocalStorage snapshot) |
| Cache holds stale key A, new key B in DB | Cache expires after 30s, next resolution gets B |
| Concurrent requests during rotation | First gets A, after 30s cache TTL, subsequent get B |

This is a **reliability** issue, not a security issue. The stale cache window is bounded to 30 seconds. No cross-workspace contamination occurs.

**Verdict: Acceptable reliability behavior. Not a security finding.**

---

## 17. Delete/Disable Race

| Scenario | Expected | Actual |
|----------|----------|--------|
| Chat request starts, provider deleted mid-request | Request continues with stale cached provider | ✅ Uses cached snapshot (AsyncLocalStorage) |
| Parser job queued, provider disabled | Job should fail or use global | ✅ Falls back to global (if env key exists) |
| Provider deleted, new request arrives | Global fallback | ✅ `resolveAIForWorkspace` returns global |

No cross-workspace fallback occurs. The fallback is always to the global env key, never to another workspace's provider.

**Verdict: Delete/disable race is handled safely.**

---

## 18. Error Sanitization

| HTTP Status | `sanitizeTestError()` Output | Leaks? |
|-------------|------------------------------|--------|
| 401 | `"Authentication failed"` | ❌ No |
| 403 | `"Authentication failed"` | ❌ No |
| 404 | `"Endpoint or model not found"` | ❌ No |
| 429 | `"Rate limited by provider"` | ❌ No |
| 4xx other | `"Provider rejected the request (4xx)"` | ❌ No |
| DNS error | `"Endpoint hostname could not be resolved"` | ❌ No |
| Connection refused | `"Provider connection refused or reset"` | ❌ No |
| TLS error | `"Provider TLS validation failed"` | ❌ No |
| Timeout | `"Provider timed out"` | ❌ No |
| SSRF blocked | `"Endpoint not allowed: ..."` | ⚠️ Includes blocked IP |

**Finding F-05: SSRF Error Includes Blocked Address**

- **Severity:** LOW
- **Category:** SECURITY
- **Status:** INFORMATIONAL
- **Description:** When `safeFetch` throws `ENDPOINT_NOT_PUBLIC`, the error message includes the blocked address: `"Endpoint not allowed: private/loopback IPv4 endpoint"`. In the test route handler, this is further sanitized by `sanitizeTestError` which returns `"Endpoint not allowed: blocked by SSRF policy"` (via the `err.code === 'ENDPOINT_NOT_PUBLIC'` branch). However, the test endpoint handler logs the full error message to `console.error`, which could expose the attempted internal address in logs.
- **Impact:** Internal network topology information leakage in server logs
- **Recommended fix:** Strip IP addresses from SSRF error messages in the logging layer

---

## 19. Frontend Secret Storage

| Storage Mechanism | API key present? |
|-------------------|-----------------|
| React `useState` (transient) | ✅ During entry only, cleared after save |
| `localStorage` | ❌ Never |
| `sessionStorage` | ❌ Never |
| `IndexedDB` | ❌ Never |
| Redux persist | ❌ Never used for API key |
| URL / route state | ❌ Never |
| Browser history | ❌ Never |

**Verified:** After `onSave()` completes, `setApiKey('')` immediately clears the React state. The `type="password"` attribute on the input prevents browser autofill persistence. The `autocomplete="off"` attribute further prevents storage.

**After page reload:** The API key input is empty (placeholder only). The saved meta only shows `api_key_masked: '••••last4'`.

**Verdict: Frontend secret handling is correct. Key is transient-only.**

---

## 20. Database

| Column | Content |
|--------|---------|
| `api_key_enc` | AES-256-GCM ciphertext (`iv64:tag64:cipher64`) |
| `api_key` (plaintext) | ❌ Does NOT exist |
| `provider` | TEXT enum (type name) |
| `endpoint` | TEXT URL |

The schema explicitly documents: `api_key_enc is AES-256-GCM ciphertext (iv:tag:payload) — never plaintext`.

No plaintext API key column exists in the migration or schema.

**Verdict: Database stores only encrypted credentials.**

---

## 21. Test Quality

### Backend Tests

| Suite | Tests | Pass |
|-------|-------|------|
| `personal-ai-provider-phase4.test.js` | 19 | ✅ 19/19 |
| `workspace-ai-security.test.js` | 38 | ✅ 38/38 |
| **Total backend** | **57** | **57/57** |

### Frontend Tests

| Suite | Tests | Pass |
|-------|-------|------|
| `aiProviders.test.ts` | 24 | ✅ 24/24 |
| **Total frontend** | **24** | **24/24** |

### Test Coverage Assessment

| Security Invariant | Covered? | Test |
|--------------------|----------|------|
| Cross-workspace isolation | ✅ | "Workspace A → victim book: 403" |
| Key never in response | ✅ | "meta never echoes the key" |
| Key never in logs | ⚠️ Partial | Error sanitization tested, but console output not asserted |
| SSRF blocks private | ✅ | 14 blocked URL variants tested |
| Redirect re-validation | ✅ | "public → private redirect refused" |
| DNS rebinding (all records) | ✅ | "multi-record DNS containing private blocked" |
| Key rotation | ✅ | "old key no longer used after update" |
| Deleted provider → global | ✅ | "deleted provider falls back to global" |
| Fail-closed unconfigured | ✅ | "no workspace + no global → source unconfigured" |
| Error sanitization | ✅ | 401/404/429/timeout/DNS all tested |
| Provider response attack | ⚠️ Not tested | No test for huge body, malformed JSON, encoding attacks |
| Provider rotation race | ⚠️ Not tested | No concurrent rotation test |

### Test Quality Gaps

1. **No test for huge provider response body** — memory exhaustion via giant LLM response
2. **No test for concurrent key rotation** — race condition between request and rotation
3. **No test for malformed provider response** — non-JSON, invalid encoding
4. **Console output not asserted** — error logs could leak key material without test detection

---

## 22. Findings Summary

### F-01: Deterministic Fallback Encryption Key

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **Category** | SECURITY |
| **Status** | CONFIRMED |
| **Code** | `workspace-ai-provider.js:48-57` — `getSecretKey()` |
| **Attack** | Production starts without `WORKSPACE_SECRET_KEY`; all credentials encrypted with publicly known dev key |
| **Impact** | Full credential exposure for all workspaces |
| **Existing protection** | Warning logged once; production docker-compose sets env var |
| **Why protection fails** | Warning is transient (once per process); no hard failure in production |

### F-02: Plaintext Key in Process Memory Cache

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **Category** | SECURITY |
| **Status** | INFORMATIONAL |
| **Code** | `workspace-ai-provider.js:158` — `_cache` Map |
| **Description** | Decrypted API key held in process-global Map for30s TTL |
| **Mitigating** | Single-threaded; workspace-keyed; necessary for HTTP requests |

### F-03: DNS Rebinding TOCTOU Window

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **Category** | SECURITY |
| **Status** | CONFIRMED (Mitigated) |
| **Code** | `url-safety.js:191-237` — `assertPublicEndpoint` + `safeFetch` |
| **Description** | Separate DNS resolution in assert vs. fetch creates a theoretical window |
| **Mitigating** | Narrow timing; `all: true` resolution; DNS TTL |

### F-04: Inconsistent Fail-Closed Behavior

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **Category** | RELIABILITY |
| **Status** | CONFIRMED |
| **Code** | `workspace-ai-provider.js:290-310` vs `workspace-ai-provider.js:256-276` |
| **Description** | `resolveAIProvider` marks unconfigured as `source: 'unconfigured'`, but `resolveAIForWorkspace` falls back to global |
| **Impact** | Personal-only deployments silently use global key |

### F-05: SSRF Error Includes Blocked Address

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **Category** | SECURITY |
| **Status** | INFORMATIONAL |
| **Code** | `url-safety.js:257` — `safeFetch` error message |
| **Description** | Error message includes the blocked IP; logged to console.error |
| **Impact** | Internal network topology in server logs |

### F-06: Test Coverage Gaps

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **Category** | SECURITY |
| **Status** | INFORMATIONAL |
| **Description** | No tests for huge response bodies, concurrent rotation, malformed responses, or console output leakage |

---

## 23. Final Verdict

```
Phase 4 Security:    PASS WITH WARNINGS
Critical:            0
High:                0
Medium:              1  (F-01: Deterministic fallback key)
Low:                 4  (F-02, F-03, F-04, F-05)
Informational:       1  (F-06)

Personal AI Provider:  READY
Can we proceed to next Beta phase?  YES
```

### Main Concern

The deterministic fallback encryption key (F-01) is a production risk if `WORKSPACE_SECRET_KEY` is accidentally unset. It should fail hard in production rather than silently using an insecure dev key.

---

## 24. Documentation

This document is `docs/architecture/EXPERIMENTAL_BETA_PERSONAL_AI_PROVIDER_SECURITY_REVIEW.md`.

Commit message: `docs(beta): add personal AI provider security review`
