# Experimental Beta — Personal AI Provider (Phase 4)

> **Status:** Phase 4 — implemented, audited **READY** (independent verification
> `EXPERIMENTAL_BETA_IMPLEMENTATION_VERIFICATION.md`); spec §2/§3/§7/§8 model
> fields, `resolveAIProvider(workspace, purpose)` routing, frontend
> provider_type selector, and this document added in Phase 4 checkpoints A/B/C.
> **Scope:** server-side encrypted storage of a workspace-owned LLM provider
> credential + an addressable routing abstraction shared by chat, the TXT book
> parser, and future agents. **Phase 4 explicitly does NOT cover** billing,
> usage metering, marketplace, system/admin providers, Share Worker, Docker
> packaging, GPU Hub changes, or provider auto-discovery.

This document is the canonical reference for the Phase 4 implementation.

---

## 1. Goal

Give the user the ability to plug in **their own** AI API and use it inside
their own workspace.

```
User
  ↓
Workspace
  ↓
Personal AI Provider
  ↓
import TXT
  ↓
book parsing agent
  ↓
chat assistant
  ↓
existing generation pipeline
```

The user pays for / operates their own key. Animastor **must not require** a
system-wide AI API for this scenario.

---

## 2. Architecture principle

The system distinguishes two provider classes:

- **SYSTEM provider** — operator-controlled, env-configured (`OPENROUTER_API_KEY`,
  `AI_API_BASE_URL`, `OPENROUTER_MODEL`). Phase 4 does NOT redesign it. It stays
  available as a back-compat fallback (spec §26).
- **PERSONAL provider** — owned by `(User, Workspace)`. Stored encrypted at rest
  in PostgreSQL, scoped to the workspace, NEVER a global credential.

Phase 4 implements only the **PERSONAL provider** path. Admin / system provider
management will be a separate future phase.

---

## 3. Provider type

A personal provider row carries `provider_type` — a TEXT field with a CHECK
constraint value set. The default is `openai-compatible`.

| `provider_type`      | Use case                                   |
|----------------------|--------------------------------------------|
| `openrouter`         | First documented example; spec §14. The OpenRouter default endpoint `https://openrouter.ai/api/v1` is exposed as a UI placeholder only — no architectural coupling. |
| `openai-compatible`  | Generic OpenAI-compatible endpoint: any other aggregator, hosted API, or a user-hosted server. |
| `custom`             | Legacy alias of `openai-compatible` (back-compat with the first Phase B rollout). Saved rows that still carry `custom` keep working. |

The legacy `provider` column stays alongside `provider_type` for one release so
old callers reading the former keep seeing the same value.

The `model` field is a **plain free-text string** — never a hardcoded registry
(spec §15). The user can type `qwen/qwen3-32b`, `deepseek/deepseek-v3`,
`anthropic/claude-3-5-sonnet`, or any future model without a code change.

---

## 4. Provider model (DB)

Table `workspace_ai_providers` (Phase 4 extension over the original Milestone 1
schema):

| Column             | Type      | Notes                                                                 |
|--------------------|-----------|-----------------------------------------------------------------------|
| `workspace_id`     | UUID, PK  | FK → `workspaces(id) ON DELETE CASCADE`. Enforces one row per workspace at the DB level. |
| `provider`         | TEXT      | Legacy duplicate of `provider_type` (one-release bridge).             |
| `provider_type`    | TEXT      | `openrouter` \| `openai-compatible` \| `custom`.                     |
| `endpoint`         | TEXT      | `http(s)://…` user-controlled. Validated by `assertPublicEndpoint` at save time AND re-validated per fetch AND per redirect hop. |
| `api_key_enc`      | TEXT      | AES-256-GCM ciphertext, `iv:tag:payload` (base64). NEVER plaintext.   |
| `model`            | TEXT      | Free-text user-entered model identifier. NULL → consumer default.     |
| `enabled`          | BOOLEAN   | Disabled provider degrades to global env fallback (legacy chat path). |
| `status`           | TEXT      | `untested` \| `ok` \| `failed`. CHECK-constrained. Derived from the most recent Test Connection. |
| `last_tested_at`   | BIGINT    | Epoch-seconds timestamp of the most recent Test Connection.          |
| `created_at` / `updated_at` | BIGINT | Epoch-seconds.                           |

Migration `PAP-1` (`backend/src/storage/postgres/schema.js`) adds the new columns
and CHECK on existing databases; brand-new databases get them in `SCHEMA_SQL`.

---

## 5. Credential security

- **Encryption at rest:** AES-256-GCM, 12-byte random IV per row, auth tag
  verified on decrypt. Key material is derived from
  `WORKSPACE_SECRET_KEY` (server env var, see `docker-compose.yml`:
  `${WORKSPACE_SECRET_KEY:?...}` — fail-closed required). Without it, a
  one-time warning is logged and an insecure dev key is used — this MUST NOT
  happen in production.
- **Server-side only** decrypt. The plaintext key:
  - never persists in DB (`api_key_enc` is the only on-disk form);
  - never enters Redis (only non-secret metadata may use the 30s resolver cache);
  - never appears in logs (errors are sanitized);
  - never leaves through any GET endpoint (meta responses return
    `api_key_masked: '••••last4'` + `configured: true` — spec §5).
- **Plaintext lifetime:** only inside the in-memory resolver cache (30s TTL,
  invalidated on writes) and the `AsyncLocalStorage` provider context for the
  duration of one AI call. After Test Connection the response strips the
  `apiKey` field — the client only sees `ok`/`model`/`status`/sanitized error.

---

## 6. Frontend credential flow

`/settings/ai` (Preact `SettingsPage.tsx` → `AIProviderSection`):

```
[ Provider type ▼ ]   openrouter | openai-compatible | custom
[ Endpoint       ]    https://openrouter.ai/api/v1   ← autofilled for openrouter
[ API Key        ]    ******** (password)              ← never echoed back
[ Model          ]    qwen/…                          ← free text
```

After Save:
- POST body keeps the provider_type / endpoint / model + (optional) `api_key`.
- API key field is cleared from `useState` IMMEDIATELY; the saved meta only
  carries `configured: true` and `api_key_masked`.
- API key, when sent, is stored encrypted server-side and next request returns
  the masked hint only.

**Edit semantic (spec §5):**
- A blank `api_key` body field means *keep the stored credential* — the row's
  `api_key_enc` is left untouched.
- A non-blank `api_key` rotates the credential (the old encrypted value is
  overwritten; the resolved cache is invalidated; the old plaintext never
  reaches the network again from this server).

**Status pill:** `OK` / `Failed` / `Untested` + `last tested: <relative>`. After
the Test Connection call the section re-reads the meta so the pill reflects the
backend-persisted `status` / `last_tested_at`.

---

## 7. Provider CRUD

| Method   | Path                            | Body / Effect                                             | Returns                                                            |
|----------|---------------------------------|-----------------------------------------------------------|-------------------------------------------------------------------|
| `GET`    | `/api/v1/settings/ai/provider`  | —                                                          | `{ provider, has_workspace_provider }` — `provider` is null or meta (NO key). |
| `GET`    | `/api/v1/settings/ai/providers`  | spec §7 list parity (singleton array)                     | `{ providers: [meta] \| [] }`.                                     |
| `PUT`    | `/api/v1/settings/ai/provider`   | `{ provider_type?, endpoint, api_key?, model?, enabled? }` | `{ provider: meta }` — back-compat `provider` body field accepted as alias of `provider_type`. |
| `DELETE` | `/api/v1/settings/ai/provider`  | —                                                          | `{ deleted, has_workspace_provider: false }`.                       |
| `POST`   | `/api/v1/settings/ai/test`       | `{ endpoint?, api_key?, model? }` — empty body re-tests the saved snapshot with its own endpoint+key+model | `{ ok, model?, status?, error? }` — never `apiKey`. Also stamps `status` + `last_tested_at` on the row. |

**Workspace isolation:** `workspace_id` is ALWAYS resolved server-side from
`req.workspace` (auth-context). A `workspace_id` from the request body is NEVER
authoritative. Cross-workspace access is refused; foreign book access is refused
(`aiBookGuard` → `req.scopedBookId`).

### Metadata response shape

```json
{
  "workspace_id": "uuid",
  "provider": "openrouter",
  "provider_type": "openrouter",
  "endpoint": "https://openrouter.ai/api/v1",
  "model": "qwen/qwen3-32b",
  "enabled": true,
  "configured": true,
  "has_api_key": true,
  "api_key_masked": "••••last",
  "status": "ok",
  "last_tested_at": 1787288464,
  "created_at": ...,
  "updated_at": ...
}
```

No `api_key` / `api_key_enc` field is ever present.

---

## 8. Test Connection

Backend (`workspace-ai-provider.testConnection`):
- Decrypts the stored credential **only** server-side (or uses an explicit
  body `api_key` for a "test before save" UX).
- POSTs `{ messages: [{role:'user', content:'ok'}], max_tokens: 1, temperature: 0 }`
  to `${endpoint}/chat/completions`.
- Returns `{ ok: boolean, model?, status?, error? }` — never the raw provider
  response body, never the key, never the Authorization header.

**Sanitized error mapping** (`sanitizeTestError`):

| Condition                                  | Returned message                              |
|--------------------------------------------|------------------------------------------------|
| `401` / `403`                              | `Authentication failed`                       |
| `404`                                      | `Endpoint or model not found`                 |
| `429`                                      | `Rate limited by provider`                    |
| other 4xx                                  | `Provider rejected the request (4xx)`        |
| `ENDPOINT_NOT_PUBLIC` (SSRF guard)         | `Endpoint not allowed: blocked by SSRF policy` — never echoes the host address. |
| `AbortError` / `TimeoutError`              | `Provider timed out`                         |
| `ENOTFOUND` / `EAI_AGAIN`                  | `Endpoint hostname could not be resolved`    |
| `ECONNREFUSED` / `ECONNRESET` / `EPIPE`     | `Provider connection refused or reset`       |
| `certificate` / `ssl` / `tls`              | `Provider TLS validation failed`             |
| anything else                              | `Provider connection failed: <truncated msg>` |

On success/failure the route also calls `setLastTest(workspaceId, ok)`, which
updates the row's `status` (`ok`/`failed`) and `last_tested_at`; the resolver
cache is then invalidated so the next call sees the new state.

---

## 9. Provider routing — `resolveAIProvider(workspace, purpose)`

One addressable entry point (spec §9, §13) for every consumer:

```ts
workspaceAi.resolveAIProvider(workspaceId, purpose /* 'chat' | 'parser' | 'agent' */)
  → Promise<{ source, provider, endpoint, apiKey, model, purpose, workspaceId }>
```

Today per-workspace selection is identical for all purposes — one active provider
per workspace is the spec §9/§10 contract. `purpose` is tagged onto the returned
snapshot so future per-purpose routing, fallback chains, or per-agent provider
trees can be added HERE without touching every call site. (Spec §13: avoid
premature complexity — interesting extension points are deferred.)

The returned snapshot is a **shallow copy** of the cached resolved provider; the
`purpose` / `source` tags never mutate the cached entry, so a parser call cannot
leak a `purpose: 'chat'` tag into the next caller.

**Personal-only fail-closed (spec §10):** when a workspace has no provider AND
the operator has NOT configured a global `OPENROUTER_API_KEY`, `resolveAIProvider`
returns a snapshot with `apiKey: null` and `source: 'unconfigured'` (or
`'workspace-unconfigured'` when a provider row exists but its credential failed
to decrypt). Callers can branch on this hint and surface a clear error rather than
pretending the AI call will work.

**Back-compat:** `resolveAIForWorkspace` / `resolveAIForBook` keep their existing
global-fallback behaviour for Phase 1-3 paths. Phase 4 does NOT remove the global
fallback (spec §26).

---

## 10. Provider selection — one Active Provider per Workspace

The single-row PK invariant (`workspace_id` PRIMARY KEY) makes the
"workspace selects its Active AI Provider" story simple: the saved row IS the
active provider. UI exposes a single provider editor; a future multi-provider
phase would extend the table and the UI without breaking the CRUD contract.

If the row is deleted or disabled, the resolver falls back to the global env
provider (legacy compatibility). If neither exists, the AI feature fails
clearly: `bootstrapWithAgent` throws "AI assistant is not available — cannot
import book (no workspace provider, no global key)" and `resolveAIProvider`
returns `source: 'unconfigured'` (chat path). There is **no silent fallback to a
configured-system-key in Personal-only mode** — when the global env is gone, the
Personal mode is honest about its state.

---

## 11. Book parser integration (TXT → book) — spec §11

`backend/src/services/agent/bootstrap.js`:

```
TXT
  ↓
authenticated workspace (book ownership guard / workspace-ownership middleware)
  ↓
resolveAIForBook(bookId)  ← book → books.workspace_id → resolveAIForWorkspace
  ↓
runWithProvider(resolved, () => bootstrapWithAgentInner(…))   ← AsyncLocalStorage
  ↓
parser agent (pipeline-steps.accumulateCharacterCandidates, etc.)
  ↓
parsed book (scenes / units / characters / locations) saved to disk + PG
```

The provider is resolved once per bootstrap / next-window run and the entire
agent pipeline (incl. the unit-splitter AI calls and any cached-scene path) runs
inside `runWithProvider(...)`. `ai-caller.callAI` reads the provider from the
AsyncLocalStorage context and passes it down to `ai-service.callAI`, which in
turn calls `safeFetch` with `validatePublic` per the workspace source.

---

## 12. Chat agent integration — spec §12

`backend/src/routes/ai-routes.cjs` (`/api/v1/ai/chat`, `/ai/chat/stream`,
`/ai/prompt`):

```
Chat request
  ↓
authenticated workspace (req.scopedBookId from aiBookGuard)
  ↓
resolveAIProvider(workspace, 'chat')
  ↓
provider endpoint + key + model
  ↓
provider API
  ↓
JSON / SSE response
```

Chat uses the SAME provider abstraction as the parser — there is no
chat-specific credential storage. The `/ai/prompt` route (and chat) wrap their
fetches in `safeFetch`; the `/ai/prompt` endpoint also has an explicit 60s
`AI_FETCH_TIMEOUT_MS` AbortController (regression remediated during Phase 4
audit).

---

## 13. OpenRouter — first documented example, NOT architecture

OpenRouter is exposed in the UI as the recommended starting option (spec §14),
with the base URL `https://openrouter.ai/api/v1` autofilled when `provider_type
= 'openrouter'`. Beyond that UX hint, the architecture is **generic
OpenAI-compatible**: the chat-completions (`/chat/completions`) HTTP shape is the
only protocol assumption.

> **Important — do not promise free models.**
> Animastor's documentation and UI do NOT advertise a free model or quota.
> Availability and pricing of OpenRouter models, an OpenAI-compatible
> aggregator, or a self-hosted server are entirely the user's choice and
> cost. The architecture does not depend on any specific model being free.

---

## 14. Model field — spec §15

`model` is an ordinary string. There is **no hardcoded model registry**.
Suggested placeholder text is `provider/model` (e.g. `qwen/…`, `deepseek/…`,
`anthropic/…`). The user types any string. This is essential for future models
the project has not seen yet.

---

## 15. Base URL — spec §16

- For `openrouter`: the UI offers the OpenRouter default URL as a placeholder.
  The user can still edit it (e.g. a self-hosted OpenRouter proxy).
- For `openai-compatible` / `custom`: the user supplies an arbitrary URL.

**Validation:** `http://` and `https://` schemes only (`normalizeEndpoint`
rejects `javascript:`, `file:`, `data:`, `ftp:`, etc.). SSRF protection
additionally requires the resolved IP to be public (next section).

---

## 16. SSRF policy — spec §17

Because a personal provider's `endpoint` is **user-controlled**, the backend
becomes a potential SSRF proxy unless endpoints are restricted. The policy
implemented in `backend/src/services/url-safety.js`:

- **HTTPS by default** — `http://` is accepted at the validation gate so users
  running a local OpenAI-compatible server can still hit `http://localhost:…` in
  dev, but the operator can tighten this by intercepting at deployment.
  Production-grade deployments should restrict to HTTPS via TLS termination
  policy.
- **Forbidden IP ranges (literal + numeric alternatives):**
  - `127.0.0.0/8` (loopback, including `127.1`, `0x7f000001`,
    `0177.0.0.1`, `2130706433`, etc.)
  - `0.0.0.0/8` (this-network)
  - `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC1918)
  - `100.64.0.0/10` (CGNAT)
  - `169.254.0.0/16` (link-local / **cloud metadata IP** `169.254.169.254`)
  - `198.18.0.0/15` (benchmarking), `192.0.0.0/24`+`192.0.2.0/24` (TEST-NET)
  - `224.0.0.0/4` (multicast / reserved), `255.255.255.255` (broadcast)
- **Forbidden IPv6 ranges:** `::` (unspecified), `::1` (loopback), `fc00::/7`
  (unique local), `fe80::/10` (link-local), `ff00::/8` (multicast), IPv4-mapped
  `::ffff:a.b.c.d` (delegates to the IPv4 classifier), IPv4-compatible
  `::a.b.c.d`.
- **DNS-rebinding protection:** all A/AAAA records are inspected; ANY private
  address makes the endpoint blocked (round-robin cannot smuggle a private
  address in). Unresolvable hostnames fail closed.
- **Per-hop re-validation:** `safeFetch` follows redirects manually, never
  blindly. A public endpoint redirecting to a private address is refused with
  `ENDPOINT_NOT_PUBLIC`.
- **Decision on localhost/private:** the production policy is **deny** by
  default. Local OpenAI-compatible servers require a deliberate operator
  decision (set the global `AI_API_BASE_URL` env var, or run with an explicit
  exemption). Personal provider rows cannot self-authorize a private endpoint.

Residual (acknowledged LOW): a DNS-rebinding domain with sub-millisecond
TTL could win the check-then-connect race between `assertPublicEndpoint`'s
lookup and the underlying fetch's lookup. Standard limitation of DNS-based
SSRF filtering; connect-then-validate would close it.

---

## 17. Error handling (spec §18)

The implementation distinguishes:

| Failure                         | Detection point                        | Frontend sees                                                  |
|---------------------------------|----------------------------------------|----------------------------------------------------------------|
| Invalid key (401/403)           | provider response                      | "Authentication failed"                                        |
| Invalid model (404)             | provider response                      | "Endpoint or model not found"                                   |
| Provider timeout                | Aborted fetch (test: 20s; chat/prompt: 60s) | "Provider timed out"                                       |
| Provider 4xx                    | response.status                        | "Provider rejected the request (4xx)"                          |
| Provider 5xx                    | response.status                        | re-thrown by ai-service (retry semantics preserved)            |
| Malformed JSON response         | ai-service.parseJsonResponse           | "Failed to parse AI response as JSON"                          |
| Network error                   | connection error                       | first matched network error category (DNS refused / reset / TLS) |
| Endpoint private (SSRF)         | url-safety asserts                     | "Endpoint not allowed: blocked by SSRF policy"                 |

The frontend receives a **safe human-readable error**. Stack traces, the
provider's raw response body, the API key, and the Authorization header never
appear in client-facing responses or server logs (logs truncate provider bodies
to 200 chars on the server side at warn level and never log headers).

---

## 18. Rate / token limits (spec §19)

Phase 4 does **NOT** implement billing or a quota system. Provider API errors
do not break the generation queue: the agent pipeline's existing retry
semantics continue to apply (`ai-caller.callAI` retries with exponential
backoff on 5xx and network errors, and re-throws 4xx immediately — no
infinite retry loops). The TXT/agent paths surface a clear `Error` and
session failure marker so the user gets a meaningful "AI analysis failed"
message in the import progress UI.

---

## 19. Redis (spec §20)

**Plaintext API key is never placed in Redis.** The resolver cache
(`workspace-ai-provider.js`) stores only the decrypted-resolution snapshot in a
process-local `Map` keyed by `workspace_id` with a 30s TTL; it is invalidated
on every write (upsert/delete). Per-provider health cache
(`ai-service.checkAIHealth`) is keyed by `${workspaceId}:${keyLast6-bits}`, so
one workspace's health state cannot shadow another's. If a future provider
metadata cache is introduced, only non-secret metadata may be cached.

---

## 20. Personal vs System provider — clean separation

Even though Phase 4 implements only the PERSONAL path, the codebase already has
a clean distinction:

| Source                   | Config origin                              | Owner       | Routing path                             |
|--------------------------|--------------------------------------------|-------------|-------------------------------------------|
| `workspace` (`personal`)| `workspace_ai_providers` row               | user + ws   | `resolveAIProvider(ws, purpose)` → row    |
| `global` (legacy env)    | env (`OPENROUTER_API_KEY`/`AI_API_BASE_URL`/`OPENROUTER_MODEL`) | operator | global env fallback when no ws row, OR `unconfigured` when neither exists |

A future Admin Phase will introduce an explicit `system_ai_providers` table and
route entries there as a third `source` value; the per-purpose resolver entry
point (`resolveAIProvider`) is the only point of extension needed.

---

## 21. Out of scope (spec §27 explicit)

Not in Phase 4 (and explicitly deferred):

- Admin / system AI providers (`system_ai_providers`, system provider UI)
- System fallback redesign
- Billing (subscriptions, payments, credits marketplace, invoices)
- Usage metering / quotas
- Marketplace, model marketplace, GPU Hub changes
- Share Worker (Phase 5+)
- Docker packaging improvements
- GPU discovery / provider auto-discovery
- Subscription management

---

## 22. Tests

Backend (real PG, mocked LLM — no real provider call):

| File | Tests | Coverage |
|---|---|---|
| `backend/tests/personal-ai-provider-phase4.test.js` | 19 | §2 model fields, §3 provider_type allowlist + legacy alias, §7 CRUD list, §8 Test-Connection sanitized errors (401/404/429/timeout/DNS/SSRF), §21 key rotation (old key no longer used; disabled/deleted falls back to global), §6 cross-workspace isolation (A cannot read B's provider), §9 `resolveAIProvider` purpose tagging + fail-closed, §11+§12 chat AND parser consume the same provider snapshot, `resolveAIForBook` routing via `book.workspace_id` |
| `backend/tests/workspace-ai-security.test.js` | 38 | 2.1 cross-tenant book_id mismatch (CRITICAL), 2.2 SSRF (private endpoints / DNS rebinding / redirect→private), 2.3 test-connection snapshot mismatch, 2.4 `/ai/prompt` timeout (504), book guard matrix |
| `backend/tests/workspace-ai-provider.test.js` | 12 | Schema contract, encryption roundtrip, single-row invariant + delete, resolver precedence + cache, ai-caller AsyncLocalStorage, per-provider health cache, guest-purge cascade, HTTP routes (chat + settings identity) |

Frontend:

| File | Tests | Coverage |
|---|---|---|
| `frontends/app/src/features/aiProviders/aiProviders.test.ts` | 24 | Provider_type allowlist, endpoint placeholder, meta defensive parsing (never echoes key), input validation (http(s), key-required-on-add, edit-keeps-credential), test-result descriptions, status label, last-tested formatting, canSave gating |
| `frontends/app` (full vitest suite) | 89 | Includes the 24 above + Workers + Playback + Cache etc. |

Run locally:

```bash
# Backend
cd backend && npx mocha tests/personal-ai-provider-phase4.test.js \
                          tests/workspace-ai-security.test.js \
                          tests/workspace-ai-provider.test.js

# Frontend
cd frontends/app && npx vitest run src/features/aiProviders/aiProviders.test.ts
```

---

## 23. Phase 4 commit checkpoints

| Checkpoint | Commit | Subject | Pushed |
|---|---|---|---|
| A | `4dbedc2` | feat(beta): personal AI provider — model + encryption + CRUD (Phase 4 Chk A) — schema PAP-1, provider_type/status/last_tested_at, sanitizeTestError, list endpoint | yes |
| B | `8982da9` | feat(beta): resolveAIProvider — addressable routing for chat/parser (Phase 4 Chk B) | yes |
| C | `<TBD>` | feat(beta): frontend provider_type selector + this document (Phase 4 Chk C) | yes |

---

## 24. Acceptance summary

- Spec §2 — provider model fields present (provider_type, status, last_tested_at).
- Spec §3 — openrouter / openai-compatible / custom, no huge enum, no proprietary binding.
- Spec §4 — credential security (AES-256-GCM, server-side only, no plaintext anywhere client-facing).
- Spec §5 — frontend credential flow: certainly clears state, masked + configured as the only echoes.
- Spec §6 — workspace isolation enforced server-side (workspace_id from req.workspace; never body).
- Spec §7 — CRUD list/get/create/update/test/delete complete; metadata never returns plaintext key.
- Spec §8 — Test Connection uses decrypted key server-side; sanitized errors; persists last_tested_at + status.
- Spec §9/§13 — `resolveAIProvider(workspace, purpose)` addressable entry point.
- Spec §10 — Active provider selection (one row per workspace); no silent fallback in Personal-only mode.
- Spec §11/§12 — book parser AND chat agent both use the same provider abstraction.
- Spec §14/§15/§16 — OpenRouter first example; model field is free text; base URL validated as http(s) only.
- Spec §17 — SSRF policy explicit and documented; localhost/private/metadata variants refused.
- Spec §18 — error handling: safe human-readable messages, no stack trace / key / header leak.
- Spec §19/§20 — no billing; no plaintext in Redis.
- Spec §21/§22/§23 — security + SSRF + integration tests in place.
- Spec §24 — frontend tests in place (provider_type selector, masked credential, no persistence).
- Spec §25 — this document.
- Spec §26 — system fallback untouched (legacy env config still works).
- Spec §27 — regression tests pass (Phase 1-3 paths intact).

**Verdict:** Phase 4 scope complete; system ready for Phase 5.
