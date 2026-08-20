# Experimental Beta — Workspace-Scoped AI Provider: Independent Implementation Verification

**Audit type:** Independent QA / Security / Integration verification (no code changes).
**Reviewed commit:** `1da0e1f7eea29607e1ebba20d3fd2eff34950280` — `feat(beta): add workspace-scoped AI providers`
**Base for diff:** `813e761` (reconnaissance) / `fa1b902` (red-team audit).
**Date:** 2026-08-20
**Rule followed:** source code was NOT modified; findings are recorded only.

> Priority: the actual code was treated as ground truth. Documents
> (EXPERIMENTAL_BETA_VERSION.md, RECONNAISSANCE_AUDIT, REDTEAM_AUDIT) were
> cross-referenced but not trusted blindly.

---

## 1. Scope of the diff

| Area | File | Change |
|---|---|---|
| Service | `backend/src/services/workspace-ai-provider.js` | NEW — CRUD, AES-256-GCM store, resolver, 30s cache, testConnection |
| Service | `backend/src/services/ai-service.js` | `callAI(..., provider)`, per-provider health cache |
| Agent | `backend/src/services/agent/ai-caller.js` | `runWithProvider` (AsyncLocalStorage) |
| Agent | `backend/src/services/agent/bootstrap.js` | resolve provider per book; wrap pipeline in ALS context |
| Routes | `backend/src/routes/ai-routes.cjs` | chat/stream/prompt use `resolveChatAI(bookId)`; `parsed.reply` fix |
| Routes | `backend/src/routes/settings-ai-routes.cjs` | NEW — GET/PUT/DELETE provider, POST test |
| Routes | `backend/src/routes/generation-routes.cjs` | workspace-aware `/worker/counts` health |
| DB | `backend/src/storage/postgres/schema.js` | `workspace_ai_providers` table (PK, CASCADE FK) |
| Infra | `.env.example`, `docker-compose.yml` | `OPENROUTER_API_KEY` optional; `WORKSPACE_SECRET_KEY` required |
| Frontend | `SettingsPage.tsx`, `i18n.ts`, `router.ts`, `AppShell.tsx`, `main.tsx` | `/settings/ai` UI |
| Tests | `backend/tests/workspace-ai-provider.test.js` | NEW — 12 tests (real PG, mocked LLM) |

Architecture decisions made: workspace id is **never** client-supplied for the settings
surface (derived from `req.workspace`), providers are resolved **server-side per book** via
`books.workspace_id` (matches the red-team §7 recommendation), agent pipeline runs inside an
AsyncLocalStorage provider context, global env config remains the fallback. These decisions are
sound and match the audit docs.

---

## 2. Findings

### 2.1 CRITICAL — guard/handler `book_id` source mismatch → cross-tenant AI provider use, book data disclosure and book write

- **Class:** SECURITY ISSUE (REAL BUG)
- **File / lines:**
  - Guard: `backend/src/backend.cjs:127-147` (aiBookGuard), esp. `:131`
    `bookId = (req.query && req.query.book_id) || (req.body && req.body.book_id) || null;`
  - Handlers (read `book_id` from **body only**, and body wins over session):
    - `/ai/chat`: `backend/src/routes/ai-routes.cjs:240,273`
    - `/ai/chat/stream`: `ai-routes.cjs:493,503`
    - `/ai/prompt`: `ai-routes.cjs:735,758`
- **Evidence:**
  - Guard checks `req.query.book_id` **first**; the handlers never read `req.query.book_id`.
  - An attacker who owns **any** book `A` in their own workspace (a guest can create one via
    `POST /api/v1/book/blank`) calls:
    `POST /api/v1/ai/prompt?book_id=A` with body `{ "book_id": "VICTIM_BOOK_B", "prompt": "..." }`.
  - Guard authorizes on `A` (passes); the handler resolves the provider and loads book data for `B`:
    `resolveChatAI(B)` → `resolveAIForBook(B)` → **Workspace B's provider** (B's endpoint + B's API key)
    is used for the fetch (`ai-routes.cjs:760-771`).
- **Consequence:**
  1. **Credential/resource theft** — server acts as a proxy for victim workspace's paid AI quota.
  2. **Cross-tenant data disclosure** — `bookData` for B is loaded server-side and `buildBookContext`
     is placed in the system prompt; the attacker can prompt the model to repeat it (`ai-routes.cjs:744-749`).
  3. **Cross-tenant write** — in `/ai/prompt` (and `/ai/chat`), `parseAIResponse` patches are applied
     and `book.json` of the victim book is written to disk (`ai-routes.cjs:789-801`; chat equivalent
     `:392-450`). The attacker steers the AI to emit a patch block → arbitrary edit of victim book files.
  4. Streaming path mirrors the same mismatch.
- **Recommended (NOT applied — report only):** the guard and the handler must resolve the book from the
  same single source and the handler must re-verify ownership of the book it actually operates on
  (e.g. guard sets `req.scopedBookId` and handlers use only that).

### 2.2 HIGH — SSRF via user-controlled AI endpoint (no private-address protection)

- **Class:** SECURITY ISSUE
- **File / lines:** `settings-ai-routes.cjs:35-41,63-96` (PUT), `:113-141` (POST test);
  `workspace-ai-provider.js:282-312` (testConnection fetch); guest auto-provision
  `middleware/auth-context.js:79-87`.
- **Evidence:**
  - Endpoint validation is only `^https?://` (`settings-ai-routes.cjs:39`). No blocklist of
    private/link-local/metadata ranges, no DNS-rebinding protection, redirects are followed
    (Node fetch default `follow`).
  - A guest (auto-provisioned on the first anonymous `POST`/`PUT`) can PUT a provider with
    `endpoint: "http://169.254.169.254"` or any internal address and then call
    `POST /api/v1/settings/ai/test` (or any chat/prompt/stream on their own book).
  - The server fetches `${endpoint}/chat/completions` (`workspace-ai-provider.js:289`) and returns
    up to 200 chars of the internal response body in the error (`:306`), or the LLM-shaped response
    when the target answers. `POST /test` runs for any identity incl. the auto-provisioned guest.
  - The workspace API key is sent as `Authorization: Bearer` to the internal target (`:293`).
- **Consequence:** internal network/port probing, cloud metadata access, and (for the first hop) key
  delivery to a host the user chose. Rate limit is the global 500 req/min (`backend.cjs:69`), which
  slows but does not stop scanning.
- **Recommended (report only):** block private/loopback/link-local ranges, require HTTPS, restrict
  redirects, cap response bodies.

### 2.3 MEDIUM — "Test Connection" of a saved provider tests the wrong base URL

- **Class:** REAL BUG (functional)
- **File / lines:** `settings-ai-routes.cjs:118-133`; `workspace-ai-provider.js:283`.
- **Evidence:** the route falls back to the **stored key** when the body has none
  (`:124-127`, documented intent: "re-test without re-typing"), but when the body has no `endpoint`
  it passes `endpoint: undefined` (`:130`), and `testConnection` then defaults to
  `process.env.AI_API_BASE_URL` (`workspace-ai-provider.js:283`) — **not** to the stored provider's
  endpoint. So re-testing a saved custom provider (empty endpoint field) hits the global default
  base with the workspace key → misleading result and key sent to an unintended host.
- **Consequence:** wrong success/failure verdict; provider key transmitted to the default endpoint.

### 2.4 MEDIUM — `/ai/prompt` fetch has no timeout

- **Class:** REAL BUG (availability)
- **File / lines:** `ai-routes.cjs:760` — `fetch(...)` without `signal`; contrast chat `:332` and
  stream `:530` (60s AbortController).
- **Evidence:** the prompt endpoint never aborts a hung provider connection; a slow/stalled endpoint
  holds the request (and the process) indefinitely.
- **Consequence:** slow-loris style exhaustion of the request thread; no deadline for the operator.

### 2.5 MEDIUM — insecure dev key fallback when `WORKSPACE_SECRET_KEY` is missing

- **Class:** ARCHITECTURAL RISK
- **File / lines:** `workspace-ai-provider.js:28-38`.
- **Evidence:** without the env var the code silently encrypts all provider keys with the public
  hardcoded key `'animastor-dev-workspace-secret-key-do-not-use-in-prod'` after a one-time warning.
  docker-compose hard-requires the variable (`docker-compose.yml`), but any non-compose deployment
  (or a dropped env var) degrades to this.
- **Consequence:** all stored provider keys become decryptable by anyone who knows the constant.

### 2.6 MEDIUM — secret-key rotation silently breaks every workspace provider

- **Class:** ARCHITECTURAL RISK
- **File / lines:** `workspace-ai-provider.js:95-100`; `:180-181`.
- **Evidence:** after rotation, `decryptSecret` returns null for every stored key; `buildWorkspaceProvider`
  logs a warn and **silently returns the global fallback** (`:99`). The settings GET keeps reporting
  `has_api_key: true` with an empty mask (`:180`), so the UI looks configured while the provider is dead.
- **Consequence:** on rotation the workspace silently switches to the global provider; no re-encryption
  path, no per-row failure surfacing.

### 2.7 LOW — unbounded in-memory provider/health caches

- **Class:** ARCHITECTURAL RISK
- **File / lines:** `workspace-ai-provider.js:113-122` (resolver `_cache`), `ai-service.js:457-463` (`_healthCacheMap`).
- **Evidence:** both Maps have a TTL check but **never evict entries**. The resolver caches a provider
  (including the decrypted API key) per workspace id forever; guest-workspace churn (auto-provisioned
  on every anonymous write) grows both maps without bound, and purge of a guest workspace does not
  remove its cached entry.
- **Consequence:** slow memory growth on a busy server; decrypted keys retained in process memory
  longer than necessary.

### 2.8 LOW — health cache ignores endpoint/model changes within the 60s TTL

- **Class:** REAL BUG (minor)
- **File / lines:** `ai-service.js:459-463` (key = `workspaceId:keyLast6`).
- **Evidence:** changing the endpoint or model while keeping the same key does not invalidate the
  health cache, so `/worker/counts` reports stale liveness for up to 60s.

### 2.9 LOW — `bootstrapNextWindow` misses the fail-fast key check that `bootstrapWithAgent` has

- **Class:** TEST GAP / minor inconsistency
- **File / lines:** `bootstrap.js:308-325` vs `:43-49`.
- **Evidence:** `bootstrapWithAgent` throws a clear error when no key exists; `bootstrapNextWindow`
  proceeds and the failure surfaces later inside `ai-service.callAI` ("No AI provider configured").
- **Consequence:** confusing late error in window continuation; behavior otherwise correct.

### 2.10 LOW — no length cap on `endpoint`; `/v1` not auto-appended; `http://` allowed

- **Class:** INFO / usability
- **File / lines:** `settings-ai-routes.cjs:63-96`; `workspace-ai-provider.js:70-74`.
- **Evidence:** endpoint is unbounded (model is capped at 256); a bare `https://host` (no `/v1`)
  silently produces `https://host/chat/completions`, which most OpenAI-compatible endpoints reject;
  `http://` sends the key in cleartext (user's own choice, but noteworthy for a hosted product).

### 2.11 INFO — chat and agent defaults use different base URLs

- **Class:** INFO (pre-existing)
- **File / lines:** `chat-engine.cjs:15` (`integrate.api.nvidia.com/v1`) vs `ai-service.js:10`
  (`api.aicredits.in/v1`). Not introduced by this commit; surfaced by `resolveChatAI`.

### 2.12 INFO — pre-existing flaky test `guest-workspace.test.js:397`

- **Class:** TEST GAP (flaky, not caused by this commit)
- **Evidence:** `findByToken(created.token.replace(/.$/, 'x'))` can match because the last base64url
  character of the 32-byte secret contributes padding bits only; changing it sometimes decodes to the
  same bytes, so the wrong token is "found". Observed 1 failure in ~5 full-suite runs
  (`AssertionError: expected { …(6) } to equal null`), 0 failures in the other runs; `auth-mvp` +
  `guest-workspace` run in isolation 5× clean.

---

## 3. Checks that passed

- **Secret lifecycle:** plaintext key never returned (GET/PUT/DELETE/test return masks; verified by
  test + code); AES-256-GCM (iv:tag:data, random 12-byte IV, auth tag verified); no plaintext in the
  PG row (`workspace-ai-provider.test.js` #2). Errors/logs contain no keys (only status + truncated
  sanitized provider text).
- **Settings auth:** workspace id always from `req.workspace` (never client-supplied); anonymous GET
  → 401; expired guest → 410; empty key rejected on insert.
- **DB:** PK `workspace_id` enforces one provider per workspace at the DB level (not just app level);
  FK `ON DELETE CASCADE` verified; guest purge cascade verified by test #8.
- **AI resolution:** workspace provider reaches the final fetch in chat, stream, prompt, agent
  pipeline (incl. unit-splitter), TXT import, and background window generation — all paths re-derive
  the provider from `books.workspace_id` per the red-team design; global fallback intact (verified by
  tests #4b, #6).
- **AsyncLocalStorage:** set once per bootstrap/window run (`bootstrap.js:54,322`), read in
  `ai-caller.callAI` (`ai-caller.js:31`); the pipeline is plain async/await (no setTimeout/setImmediate/
  child-process breaks); the only `setTimeout` (retry delay, `ai-caller.js:54`) is awaited, preserving
  context; parallel runs get independent contexts. Provider is a frozen snapshot per run (matches the
  "snapshot at session start" requirement).
- **Health cache:** now per-provider (`ai-service.js:459-463`); cross-workspace health shadowing from
  the red-team §12.3 is fixed.
- **`/ai/prompt` `parsed.reply`:** the reported ReferenceError is fixed (`ai-routes.cjs:786`); the
  unconditional parse is safe (`parseAIResponse` returns `{reply:'',patches:[]}` on empty input).
- **Global-key removal:** `OPENROUTER_API_KEY` is now optional in compose; `WORKSPACE_SECRET_KEY`
  required — matches red-team §12.1.
- **Frontend:** `/settings/ai` shows only masked key; typecheck passes; 53 vitest tests pass.

---

## 4. Test execution results

| Command | Result |
|---|---|
| `npx mocha tests/workspace-ai-provider.test.js` | 12/12 pass |
| `npx mocha 'tests/**/*.test.js'` | 1276 pass, 0 fail (4 of 5 clean runs); 1 run had 1 pre-existing flaky failure: `guest-workspace.test.js:397` (see 2.12) |
| `npm run typecheck` (frontends/app) | pass |
| `npm test` (frontends/app, vitest) | 53 pass |

**Test gaps (no coverage for the findings above):**
1. guard/handler `book_id` mismatch (2.1) — the new suite tests `/ai/prompt` and settings, but never
   the `?book_id=` vs body `book_id` divergence;
2. SSRF/private-address endpoints (2.2);
3. test-connection endpoint fallback (2.3);
4. missing `/ai/prompt` timeout (2.4);
5. `WORKSPACE_SECRET_KEY` rotation behavior (2.6).

---

## 5. Final verdict

### Implementation status

**FAIL** (security gate) — the architecture and most of the implementation are solid, but two
exploitable issues (2.1 CRITICAL cross-tenant, 2.2 HIGH SSRF) must be resolved before this feature
is exposed to unauthenticated/anonymous traffic. If they are accepted as known-beta risks, the rest
is **PASS WITH ISSUES**.

### Critical findings
- 2.1 Guard/handler `book_id` source mismatch → cross-tenant provider use + book data disclosure + book write.

### High findings
- 2.2 SSRF via user-controlled endpoint (no private-address protection, anonymous guests included).

### Medium findings
- 2.3 Test-Connection tests the wrong base URL for a stored provider.
- 2.4 `/ai/prompt` fetch without timeout.
- 2.5 Insecure hardcoded dev key when `WORKSPACE_SECRET_KEY` is missing.
- 2.6 Secret-key rotation silently degrades all workspace providers to global.

### Low findings
- 2.7 Unbounded in-memory caches (incl. decrypted keys held forever).
- 2.8 Health cache ignores endpoint/model changes within TTL.
- 2.9 `bootstrapNextWindow` lacks the fail-fast key check.
- 2.10 Endpoint length cap / `/v1` append / plaintext `http://`.

### Test results
- Backend 1276 pass (new suite 12/12); one pre-existing flaky test (`guest-workspace.test.js:397`);
  frontend typecheck + 53 tests pass. See §4.

### Security verdict
- Encryption at rest, key masking, DB-level single-row invariant, per-provider health, and the
  "workspace id from `req.workspace`" rule are implemented correctly. The isolation invariant
  **Workspace A cannot use Workspace B's provider** is broken by 2.1, and the user-controlled endpoint
  opens internal-network access (2.2). The other secrets questions (frontend/log/exception/DB plaintext/
  test-connection/malformed request) are all answered safely.

### Architecture verdict
- Follows the red-team minimal architecture (book-anchored resolution, transport separation,
  AsyncLocalStorage provider context, env fallback). Sound. Remaining risks are mostly hardening
  (SSRF, request timeouts, cache eviction, key rotation UX).

### Recommended next action
1. Fix 2.1: make the guard and the handler use the same, single book id and enforce ownership on the
   book the handler actually processes (guard sets `req.scopedBookId`; handlers must not re-derive it
   from body).
2. Fix 2.2: private-IP blocklist + HTTPS requirement + redirect policy on user endpoints.
3. Add the missing timeouts (2.4) and correct the test-connection fallback (2.3).
4. Add regression tests for 2.1/2.2 (see test gaps).

---

## 6. Final verification of the remediation (FINAL VERIFICATION)

**Reviewed commit:** `85d24144d1461343541e2f78d608d6d7ca2f7a4e` — `fix(beta): remediate workspace AI security findings`
**Base for diff:** `4698147b9ad8b6847323db7084416d0009707705` (independent verification audit, §1–5 above).
**Date:** 2026-08-20
**Rule followed:** source code was NOT modified; verification only (read-only + test runs).

### 6.1 Remediation mapping

| Finding | Remediation | Verified |
|---|---|---|
| 2.1 CRITICAL guard/handler `book_id` mismatch | Guard extracted to `middleware/ai-book-guard.js`, sets `req.scopedBookId`; all `/api/v1/ai` handlers consume `req.scopedBookId` first and never re-derive from body | PASS |
| 2.2 HIGH SSRF | New `services/url-safety.js` (`assertPublicEndpoint` + `safeFetch`); save-time + per-fetch + per-redirect validation; applied to every workspace-controlled fetch (chat, stream, prompt, test, ai-service/agent, health) | PASS |
| 2.3 MEDIUM test-connection wrong base URL | `/settings/ai/test` builds ONE snapshot: endpoint, key AND model all come from the same source (explicit body wins, else stored provider) | PASS |
| 2.4 MEDIUM `/ai/prompt` no timeout | `AI_FETCH_TIMEOUT_MS` (60s) AbortController; AbortError → 504 `ai_timeout` | PASS |

### 6.2 Book isolation (2.1)

Production middleware chain (`backend.cjs:126-133`): `/api/v1/ai/sessions/:id` → `aiBookGuard`;
all other `/api/v1/ai/*` → `aiBookGuard`. The guard resolves the book once
(`query.book_id` || `body.book_id` || session lookup) and sets `req.scopedBookId`.

Matrix verified against the real-PG HTTP suite (`backend/tests/workspace-ai-security.test.js`):

| Scenario | Expected | Result |
|---|---|---|
| Workspace A → own book → own provider | ALLOW (provider A) | PASS — attacker.example + sk-attacker used |
| Workspace A → book B (body) | DENY | PASS — 403, no provider contact |
| Workspace A → book B (query) | DENY | PASS — 403 |
| query.book_id=A, body.book_id=B | DENY | PASS — 400 `book_id_mismatch`, no fetch |
| session(B) + body.book_id(A) | DENY | PASS — 400 `session_book_mismatch`, no fetch |
| /ai/lock query/body mismatch | DENY | PASS — 400 `book_id_mismatch` |
| /ai/chat own book | ALLOW | PASS — attacker provider used |

`req.scopedBookId` is consumed first in every handler: `/ai/chat` (:285), `/ai/chat/stream` (:520),
`/ai/prompt` (:764), `/ai/lock` (:672), `/ai/sessions` create (:215). Provider resolution
(`resolveChatAI` → `resolveAIForBook` → `resolveWorkspaceForBook({allowCreate:false})`) is strictly
server-side via `books.workspace_id`; a foreign book_id never reaches it because the guard denies
before the handler runs.

### 6.3 Pre-auth / legacy path (2.1 + 2.4)

- `if (!hasIdentity(req)) return next()` (`ai-book-guard.js:30`) fires only when `req.user` AND
  `req.guest` are both absent. An authenticated user/guest always has identity → guard enforces.
- All three audited endpoints are POST under `/api/v1`, and `authContext` auto-provisions a guest on
  every content write (`auth-context.js:79-87`), so even an anonymous POST gets an identity and the
  guard runs. The pass-through is reachable only on pre-auth GETs (`/ai/sessions`, `/ai/sessions/:id`,
  `/:id/messages`) — read-only, no provider fetch, matching the app-wide legacy pre-auth behaviour.
- Legacy fallback `req.scopedBookId || book_id || session.book_id` is reachable only when
  `req.scopedBookId` is unset (pre-auth GET or guard pass-through with no scope). When identity is
  present and a scope exists, `scopedBookId` is always set to the authorized book, so the fallback
  never re-introduces a cross-tenant provider/data/write path. A guest cannot reach a victim book
  (`checkBookAccess` → `resolveGuestBookWorkspace`).

### 6.4 SSRF (2.2)

`url-safety.js` empirically verified (node REPL against the real module, plus the suite):

- Blocked: `127.0.0.1`, `127.1`, `0x7f000001`, `0x7f.1`, `017700000001`, `0177.0.0.1`,
  `0x7f.0.0.1`, `2130706433`, `10.0.0.1`, `169.254.169.254`, `0.0.0.0`, `[::1]`,
  `[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`, `[::7f00:1]`, `[fc00::1]`, `[fe80::1]`,
  `255.255.255.255`, trailing-dot `127.0.0.1.`/`10.0.0.1.`, `localhost` (resolves to `::1`),
  `ftp:`, `file:`.
- DNS: a hostname resolving (any A/AAAA record) to a private/special address is blocked (DNS-rebinding
  shape); unresolvable hostnames fail closed; round-robin with one private record is blocked.
- Redirects: `safeFetch` follows `redirect:'manual'` and re-validates every hop; public → private
  redirect raises `ENDPOINT_NOT_PUBLIC`.
- Public OpenAI-compatible HTTPS endpoint: ALLOW (`api.openai.com`, `api.anthropic.com`).
- Coverage: `validatePublic` is `provider.source === 'workspace' && !!provider.endpoint` in
  ai-routes (chat/stream/prompt), ai-service (`callAI`, `checkAIHealth`), and testConnection
  (`!!endpoint`). Operator-controlled env endpoints are exempt by design (documented).
- Residual (LOW, acknowledged, not introduced by this fix): guard-lookup→undici-connect TOCTOU
  (check-then-connect) is the standard limitation of DNS-based SSRF filters; a DNS-rebinding
  domain with sub-millisecond TTL could race the two lookups. Practical exploitability is low;
  hardening would require connect-then-validate.

### 6.5 Test Connection snapshot (2.3)

Saved provider (endpoint + key + model) is re-tested against its own endpoint with its own key and
model — never the global default. Verified: empty body → `attacker.example/v1/chat/completions` +
`Bearer sk-attacker` + `att-model`; explicit endpoint (no key) → new endpoint + stored key;
explicit endpoint+key+model → full override. A stored workspace provider always has a non-empty
endpoint (PUT requires it), so the saved key cannot reach the global base URL.

### 6.6 `/ai/prompt` timeout (2.4)

`AI_FETCH_TIMEOUT_MS = 60000`; the route attaches an AbortController and maps AbortError to
504 `ai_timeout`. Verified by test (mocked hanging provider → 504) and by code inspection; the
normal response path is unchanged (clearTimeout after a successful fetch).

### 6.7 Test execution

| Command | Result |
|---|---|
| `npx mocha tests/workspace-ai-security.test.js` | 38/38 pass |
| `npx mocha tests/workspace-ai-provider.test.js` | 12/12 pass |
| `npx mocha tests/auth-mvp.test.js tests/guest-workspace.test.js tests/account-workspace.test.js` | 71 pass, 1 pre-existing flaky (guest-workspace.test.js:397, finding 2.12; passes in isolation) |
| `npx mocha 'tests/**/*.test.js'` (full backend suite) | **1314 pass, 0 fail** |
| `npm run test:syntax` (syntax-smoke.sh, full repo) | all OK |
| `npm run typecheck` (frontends/app) | pass |

### 6.8 Final verdict (remediation)

### CRITICAL
None remaining.

### HIGH
None remaining.

### MEDIUM
None remaining.

### LOW
- DNS-rebinding TOCTOU in `safeFetch` (check-then-connect window between `assertPublicEndpoint`'s
  DNS lookup and undici's independent lookup). Acknowledged limitation of DNS-based SSRF filtering;
  not a blocker.

### Tests
PASS — full backend suite 1314/1314; security regression 38/38; one pre-existing flaky test
(`guest-workspace.test.js:397`, documented in 2.12) that passes in isolation.

### Production readiness
READY

### Remaining issues
No remaining security blocker found. The only open item is the documented LOW DNS-rebinding TOCTOU
residual (recommended hardening: connect-then-validate), and the pre-existing non-security findings
2.5–2.11 from the first audit (dev-key fallback, key rotation UX, cache eviction, endpoint length
cap) which were intentionally out of scope for this remediation.