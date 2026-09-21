# Auth Extraction Readiness Audit — `@animastor/auth`

**Status:** AUDIT / RECONNAISSANCE ONLY. No production code changed, no package created, no physical extraction, no API changed.
**Date:** 2026-09-21
**Branch:** `c21.4-physically-extract-analysis-from-backend`
**Baseline commit:** `958bfd7c` ("docs(architecture): audit remaining backend host for extraction candidates")
**Parent audit:** `backend-extraction-audit.md` (2026-09-20) — classified auth as its Top-1 candidate, **B (NEAR READY)**. This document re-measures that verdict at the dedicated depth the parent audit recommended.
**Question answered:** *is the auth domain ready to be physically extracted into an npm package `@animastor/auth`, and what exactly must be prepared first?*

**Inputs (measured, not assumed):**

- Full read of `backend/src/auth/auth-service.js` (434 LOC), `backend/src/auth/password.js` (106), `backend/src/middleware/auth-context.js` (387), `backend/src/routes/auth-routes.cjs` (145).
- Full read of the four PG repositories auth uses: `session-repo.js` (120), `guest-repo.js` (226), `user-repo.js` (151), `workspace-repo.js` (151); plus the adjacent policy modules `workspace-ownership.js` (88), `ai-book-guard.js` (98), `worker-auth-middleware.js` (53), `services/worker-auth.js` (215).
- Require-graph scans: every consumer of `auth-service`, `auth-context`, `AuthError`, `bookAccessDecision`, cookie helpers, `publicUser`/`publicWorkspace`, guest/session primitives, across `backend/src`, `backend/tests`, `packages/`, `frontends/`.
- All `process.env` reads in auth files; the `DIRECT_SQL_WHITELIST` guard (`tests/architecture/sql-boundary.test.js`).
- Dedicated test suites: `auth-mvp.test.js` (529), `guest-workspace.test.js` (410), `account-workspace.test.js` (318), `admin-security.test.js` (212).
- Port/boundary precedents: `@animastor/assistant` `session-repo-contract.cjs`, `@animastor/player` `playerPorts.assertBookAccess` injection, `@animastor/editor` `resolveOwnership` port, `installer-package-boundary.test.js` guard pattern.

---

## 1. Executive summary

The parent audit's B-verdict **survives re-measurement, with two corrections that materially change the preparation work**:

1. **The assumed "single authorization contract" is not single.** `bookAccessDecision(identity, bookId)` — the function the parent audit called the decision/middleware split template — has **zero production consumers** (grep-verified: only its definition and docs). The authorization path every route actually uses is `middleware/auth-context.checkBookAccess(req, bookId)`, which is *Express-coupled* and *semantically divergent* from `bookAccessDecision` in the user path (ownership self-heal + membership fallback vs. plain `workspaceRepo.checkBookAccess`). Extraction must consolidate these two paths first, or the package freezes the wrong contract.
2. **`auth-service.js` holds a raw SQL handle and a multi-table transaction.** `register()` runs `getPool().connect()` / `BEGIN` / `INSERT users` / workspace insert-or-convert / `workspace_members` / `COMMIT` inline (it is a frozen entry in `DIRECT_SQL_WHITELIST`). The repo-port contract needs a **registration unit-of-work port**, not just flat per-table ports, or atomicity (user without workspace must never exist) is lost.

Everything else measured confirms the domain's package-readiness: the core is `node:crypto`-only, stateless in-process, has 1,257 LOC of dedicated tests, a small consumer list, and precedented port patterns on three sides.

**Verdict: B — READY AFTER SMALL PREPARATION** (§14). The preparation is bounded, concrete and precedented: decision-path consolidation, repo ports + registration unit-of-work, env → injected config, decision/identity split from `req`, test-move plan, boundary guard.

---

## 2. Current architecture

### 2.1 File inventory (measured LOC)

| File | LOC | Role | External deps |
|---|---|---|---|
| `auth/auth-service.js` | 434 | register/login/logout/session/guest identity lifecycle, `bookAccessDecision`, cookie header builders, `AuthError`, `publicUser`/`publicWorkspace`, `readCookie` | 4 PG repos + **raw `getPool/query`** + lazy `book-repo` |
| `auth/password.js` | 106 | scrypt hash/verify/policy | `node:crypto` only |
| `middleware/auth-context.js` | 387 | `authContext` (session/guest resolution + guest auto-provision), `requireAuth`, `requireAdmin`, `requireWorkspaceMembership`, `checkBookAccess`, `requireBookAccess`, `getAccessibleBookWorkspace`, `dedupOwnedByCaller`, `importBookAllowed`, `hasIdentity`, `WorkspaceExpiredError` | `workspace-repo`, `auth-service`, lazy `workspace-ownership`, lazy `book-repo` |
| `routes/auth-routes.cjs` | 145 | HTTP contour: register/login/logout/me; injectable `authService`/`guestRepo` | Express, `guest-repo` (logout revoke) |
| `storage/postgres/repositories/{session,guest,user,workspace}-repo.js` | 120/226/151/151 | PG implementations (token-hash-only storage, transactional guest create/convert/purge) | `pg` pool |
| `middleware/workspace-ownership.js` | 88 | book→workspace resolution + self-heal writes (`ensureBook`, `attachWorkspaceIfMissing`) | user/workspace/book repos |
| `services/worker-auth.js` + `middleware/worker-auth-middleware.js` | 215 + 53 | worker credential boundary (separate domain — §2.4) | `worker-repo`, Redis mirror |
| Dedicated tests | 1,257 | `auth-mvp` 529, `guest-workspace` 410, `account-workspace` 318 (+ `admin-security` 212 host-surface) | real PG + Express |

### 2.2 Domain behaviour (the contract as it really runs)

- **Sessions:** server-side in PG. Cookie `animastor_sid = sid.<session_id_b64url>.<secret_b64url>`; the DB stores only SHA-256(secret). `findByToken` joins `users` and filters `revoked_at IS NULL AND expires_at > now`. Logout is idempotent revoke. TTL: hardcoded 30 days (`SESSION_TTL_MS`), not env-tunable.
- **Guests:** cookie `animastor_gid = gst.<guest_id_b64url>.<secret_b64url>`, same hash-only discipline. One guest ↔ one `temporary` workspace created atomically. Expired workspaces **still resolve** (identity valid, data past TTL) — guards answer 410 `workspace_expired` so the client renders a real "expired" state. Activity bumps the workspace deadline (`touchWorkspaceActivity`, write-only-when-extending). Hard deletion only past TTL + grace (23d), books deleted before workspace, inside one transaction per workspace.
- **Registration:** input validation (username 2–32 no-whitespace, optional email, password policy 8–512) → uniqueness pre-check (canonical `lower(username)` + email) → guest token pre-resolution (a stale guest token is a hard 410, never a silent fresh workspace) → **one atomic transaction**: user insert (`ON CONFLICT (lower(username)) DO NOTHING`) + personal workspace (created fresh, or the guest's temporary workspace **converted in place** — same `workspace_id`, zero book copying) + owner membership → post-commit: session create, guest token revoke, guest cookies cleared. Race on canonical uniqueness → 409 `register_conflict`.
- **Identity resolution (`authContext`):** session → guest → (on content-generating WRITE under `/api/v1` with exemptions for `/auth`, `/worker`, `/ai-connector`, `/admin`) auto-provisioned guest + Set-Cookie. Any lookup failure degrades to anonymous for that request (never 500s the world during a PG blip). `req.user`/`req.guest`/`req.workspace`/`req.auth.kind` are the universal identity vocabulary of the host.
- **Authorization (`checkBookAccess`):** pre-auth → anonymous allow-all; guest → book must live in the guest's workspace (expired → throw 410); user → `workspace-ownership.resolveWorkspaceForBook(allowCreate:false)` (which still **attaches** a workspace to rows with `NULL workspace_id` — a write inside an authorization path) with cross-workspace membership fallback, then the legacy direct `workspaceRepo.checkBookAccess` fallback. Fail-closed on DB error for authenticated identities.
- **Cookies:** builders guarantee `Path=/; HttpOnly; SameSite=Lax` + `Max-Age` from TTLs + optional `; Domain=<COOKIE_DOMAIN>` (strict charset regex — attribute injection impossible) + `Secure` flag passed by the caller. `readCookie(req, name)` is a no-dependency header parser.

### 2.3 The `bookAccessDecision` divergence (key finding)

| | `auth-service.bookAccessDecision(identity, bookId)` | `auth-context.checkBookAccess(req, bookId)` |
|---|---|---|
| Production consumers | **0** (grep-verified) | `requireBookAccess` guards (backend.cjs ×4 route families), `ai-book-guard`, `dedupOwnedByCaller`, `importBookAllowed`, player `assertBookAccess` port |
| User path | `workspaceRepo.checkBookAccess(bookId, userId)` → `findById` | `workspace-ownership.resolveWorkspaceForBook(allowCreate:false)` (self-heal attach) + `getMembership` cross-workspace fallback + legacy `checkBookAccess` fallback |
| Guest path | `book-repo.getWorkspaceId` (lazy require) | same lookup via `resolveGuestBookWorkspace` (lazy require) |
| Result shape | `{ok, status?, mode, workspace?}` (`mode: pre-auth/user/guest/expired/denied`) | workspace row / null / throws `WorkspaceExpiredError` |
| Coupling | identity objects — req-free | takes `req` (reads `req.user/guest/workspace`) |

The parent audit's proposed public API (`bookAccessDecision(identity, bookId)`) is **the right shape but the wrong implementation** — today it is the *unused* twin. The extraction must port the real semantics (`checkBookAccess` user-path incl. self-heal and membership fallback) into the identity-based decision function, keep `{ok, status, mode, workspace}` as the package result shape, and have the Express guards become thin wrappers over it.

### 2.4 Worker-auth: separate domain (confirmed)

`services/worker-auth.js` + `worker-auth-middleware.js` share the auth domain's *vocabulary* (fail-closed, token-hash-only, disjoint identity namespaces) but none of its code, storage or identity space:

- credential grammar `wrk.<worker_id>.<secret>` vs `sid.*`/`gst.*`; a worker token never sets `req.user`, and `requireAuth` endpoints stay unreachable with it (disjoint namespaces, documented invariant);
- source of truth is `workers` PG table + the `animastor:worker-auth` Redis mirror (hub-facing **contractual key family**, PG always authoritative);
- consumers are worker-routes, admin-routes, backend.cjs mirror sync, GPU hub (via Redis, not a require).

**Disposition:** worker-auth is **not** part of `@animastor/auth`. It remains the parked C-candidate (`worker-domain` core) from the parent audit — its extraction value is capped while the credential lifecycle lives in `worker-routes.cjs` (814 LOC). What *does* touch the auth package boundary: the guest auto-provision **exemptions** for `/api/v1/worker*` and `/api/v1/ai-connector*` are host policy (path-shape knowledge) living inside `authContext` — they stay host-side (see §7).

---

## 3. Dependency map (measured)

### 3.1 Outbound (what auth depends on)

```
auth/auth-service.js ──→ storage/postgres/repositories/{user,workspace,session,guest}-repo
        │             ──→ storage/postgres/database            (getPool, query — RAW SQL, whitelisted debt)
        │             ──→ ./password                            (node:crypto)
        │             ──→ [lazy] storage/.../book-repo          (guest bookAccessDecision path)
        │             ──→ process.env ×4                        (COOKIE_DOMAIN, GUEST_*_DAYS ×3)
middleware/auth-context.js ──→ auth/auth-service
        │                  ──→ storage/.../workspace-repo       (getMembership, findById, checkBookAccess, getWorkspaceIdForBook)
        │                  ──→ [lazy] middleware/workspace-ownership  (self-heal resolver)
        │                  ──→ [lazy] storage/.../book-repo
        │                  ──→ process.env ×2                   (NODE_ENV, ADMIN_USERNAMES)
routes/auth-routes.cjs ──→ auth/auth-service, [injectable] guest-repo, process.env ×1 (NODE_ENV)
```

No Redis. No filesystem. No orchestrator/media/hub. No `@animastor/*` requires. No back-references into `backend.cjs`. The **only host coupling class is persistence + env**, exactly what ports and injected config replace.

### 3.2 Inbound (what depends on auth)

| Consumer | Uses | Surface type |
|---|---|---|
| `backend.cjs` | global `authContext` mount; `requireBookAccess` guards on `/api/v1/book|scene|iu-image|preview/:bookId`; rate limits before `/auth/login|register`; player port `assertBookAccess = authContext.checkBookAccess`; 6h session/guest purge timers | Express + host wiring |
| `routes/auth-routes.cjs` | full auth-service surface (cookies, AuthError, register/login/logout) | direct require |
| `routes/admin-routes.cjs` | `requireAdmin` | direct require |
| `routes/book/import-routes.cjs` | `importBookAllowed`, `hasIdentity` (+ `req.workspace.status === 'expired'` checks inline) | direct require |
| `routes/generation-routes.cjs` | `importBookAllowed` | direct require |
| `middleware/ai-book-guard.js` | `hasIdentity`, `checkBookAccess`, `WorkspaceExpiredError` (assistant contract, host-stay) | direct require |
| `@animastor/player` | `playerPorts.assertBookAccess(req, bookId)` — **injected** at composition root, package-agnostic | port injection (no require) |
| `frontends/app`, `frontends/android` | HTTP only: `/auth/me`, `/auth/login`, `/auth/register`, `/auth/logout`; cookie names; error bodies | wire contract (no code dep) |
| 15+ backend test files | `authContext` via real HTTP login (identity bootstrap), cookie names `animastor_sid`/`animastor_gid` | integration |

### 3.3 Circular dependency risk

**None in the proposed shape.** `@animastor/auth` depends on nothing (ports injected); the host depends on it. The one anti-pattern to avoid: `middleware/workspace-ownership.js` must **not** move into the package — it is consumed by 8+ non-auth sites (import/parse/generation/recent-books routes, gpu-dispatcher, editor port, orchestration host-binding, workspace-ai-provider) and moving it would force auth to export a general book-registry service. It stays host-side and enters the package only as the `bookOwnership` port.

---

## 4. Proposed package boundary

### 4.1 INTO `@animastor/auth`

| Unit | From | Notes |
|---|---|---|
| Domain core: `register`, `login`, `logout`, `resolveSession`, `resolveGuest`, `createGuest`, `touchGuestWorkspace`, `resolveDefaultWorkspace`, `findByUsernameCanonical` | `auth-service.js` | as `createAuthService({ ports, config, clock?, logger? })` |
| `bookAccessDecision(identity, bookId)` — **consolidated semantics** (§2.3) | `auth-service` + `auth-context.checkBookAccess` | the single decision contract, req-free |
| `password.js` verbatim | `auth/password.js` | zero changes — already package-grade |
| Cookie grammar: 4 header builders + `parseCookieHeader(header, name)` | `auth-service` | `readCookie(req, name)` splits into a string-level parser (req peeled off) |
| Contracts: `AuthError`, `WorkspaceExpiredError`, `publicUser`, `publicWorkspace`, decision result shape | `auth-service`, `auth-context` | frozen exports |
| Identity/session primitives: `sid.`/`gst.` token grammar, hash-only storage contract, `workspaceStatus`, TTL policy, cookie/TTL constants | `auth-service`, `session-repo`, `guest-repo` | token grammar functions move; the SQL stays host |
| Repo port contracts + runtime validators (`assertUserRepo` etc.) | **new** | assistant `session-repo-contract.cjs` precedent |

### 4.2 STAYS in the backend host

| Unit | Why |
|---|---|
| PG repositories (`session/guest/user/workspace-repo`) | storage is host infrastructure; they become the concrete port adapters (assistant precedent: contract in package, SQL host-side) |
| `auth-context.js` Express wrappers: `authContext`, `requireAuth`, `requireAdmin`, `requireBookAccess`, `getAccessibleBookWorkspace`, `dedupOwnedByCaller`, `importBookAllowed`, `hasIdentity` | HTTP adapter layer; each becomes a thin shell over the package's decision functions; `req` never enters the package |
| Guest auto-provision policy (WRITE-under-`/api/v1` + exemptions incl. `/worker`, `/ai-connector`) | host path-shape doctrine, worker/LAC coupling (§2.4) |
| `routes/auth-routes.cjs` | the HTTP contour extracts with a domain only when the domain is Express-free and the contour is its only consumer (player precedent); optional phase-2 move as `createAuthRoutes(app, deps)` |
| `workspace-ownership.js` | shared host resolver (8+ non-auth consumers, self-heal writes) |
| `admin` allowlist policy (`ADMIN_USERNAMES`) | admin-surface policy, not identity policy; stays in the host middleware (config-injectable if ever needed by a second host) |
| Rate limiting (login/register) + purge timers | host runtime concerns in `backend.cjs` |
| `services/worker-auth.js` | separate domain (§2.4) |

### 4.3 Boundary rule (the one-sentence test)

> The package answers **"who is this identity and what may it do"** from (identity, credentials, bookId, ports, config); the host answers **"how did this HTTP request carry that identity, and what do we do with the answer"**.

---

## 5. Proposed public API (verified against real consumers)

```js
// ── factory ─────────────────────────────────────────────────────────────
createAuthService({ ports, config, clock?, logger? }) → Auth

// ── contracts (errors / projections) ────────────────────────────────────
class AuthError extends Error { status; reason }        // verified: auth-routes instanceof + {error, reason} body
class WorkspaceExpiredError extends Error { status: 410; code: 'workspace_expired' }
publicUser(row)        → { id, username, display_name, role }        // verified shape, consumers: register/login/resolveSession
publicWorkspace(ws)    → { id, name, type }

// ── authentication / session lifecycle ──────────────────────────────────
Auth.register({ username, password, email, guestToken })
  → { user, workspace, session: { sessionId, token, expiresAt }, converted }   // shape verified (auth-routes, tests)
Auth.login({ username, password })        → { user, workspace, session }
Auth.logout(token)                        → { ok: true }                       // idempotent
Auth.resolveSession(token) → { user: {userId, username, displayName, role}, workspace } | null
Auth.resolveGuest(token)   → { guest: {guestId, sessionExpiresAt},
                               workspace: { id, name, type, status: 'active'|'expired', expiresAt } } | null
Auth.createGuest()        → { guestId, token, workspace, workspaceExpiresAt, sessionExpiresAt }
Auth.touchGuestWorkspace(workspaceId)     // best-effort, never throws

// ── authorization (the consolidated decision contract) ──────────────────
Auth.bookAccessDecision(identity, bookId)
  → { ok: boolean, status?: 403|410, mode: 'pre-auth'|'user'|'guest'|'expired'|'denied', workspace? }
// identity = { user } | { guest, workspace } | null  (plain objects — NOT req)
// MUST carry checkBookAccess's real user-path semantics (§2.3): self-heal-resolved
// ownership + cross-workspace membership fallback; fail-closed on DB error;
// expired guest workspace → 410 'expired'.

// ── cookie grammar (string-level; HTTP-flag decisions stay caller-side) ─
sessionCookieHeader(token, { secure }) / clearSessionCookieHeader({ secure })
guestCookieHeader(token, { secure })    / clearGuestCookieHeader({ secure })
parseCookieHeader(headerString, name) → value|null        // replaces readCookie(req, name)
SESSION_COOKIE_NAME = 'animastor_sid'; GUEST_COOKIE_NAME = 'animastor_gid'

// ── primitives ──────────────────────────────────────────────────────────
password: hashPassword / verifyPassword / validatePasswordPolicy / PASSWORD_MIN_LENGTH|MAX
workspaceStatus(expiresAt, now?) → 'active'|'expired'
token grammar: parseSessionToken / parseGuestToken (hash-only storage contract documented)
```

**Corrections vs the parent audit's sketch:** `bookAccessDecision` must be the *consolidated* implementation (today's version is consumer-less and semantically weaker); `readCookie` enters as `parseCookieHeader(header, name)`; the token grammars are explicitly included (they are the session/guest primitives the host repos implement against); `resolveDefaultWorkspace` stays exported (self-heal semantics must remain observable to the host).

---

## 6. Repository ports (exact methods)

Six injected ports (validated at wiring time, assistant `assertSessionRepo` precedent). Every method below is the **exact historical usage** — nothing speculative:

```js
users: {
  findByUsernameCanonical(username) → userRow|null        // lower(username) unique; auth-service L61 (raw SQL today)
  findByEmail(email) → userRow|null                       // auth-service L146
}
sessions: {
  createSession(userId, expiresAtMs) → { sessionId, token, expiresAt }   // L221/255
  findByToken(token) → { session_id, user_id, expires_at, username, display_name, email, role }|null
                                                          // joined live-session lookup, L268
  revokeByToken(token) → boolean                          // idempotent, L224/262
}
guests: {
  createGuest({ workspaceTtlMs, sessionTtlMs }) → { guestId, token, workspace, workspaceExpiresAt, sessionExpiresAt }  // L285
  findByToken(token) → { guest_id, session_expires_at, workspace_id, workspace_name, workspace_type, workspace_expires_at }|null  // L155/298
  touchWorkspaceActivity(workspaceId, workspaceTtlMs)     // extend-only write, L316
  revokeByToken(token) → boolean                          // L224 + auth-routes logout
}
workspaces: {
  findById(workspaceId) → workspaceRow|null               // L342
  checkBookAccess(bookId, userId) → workspaceId|null      // membership chain, L340 + legacy fallback
  getMembership(workspaceId, userId) → membershipRow|null // cross-workspace fallback (auth-context L220)
  getWorkspaceIdForBook(bookId) → workspaceId|null        // importBookAllowed foreign-book check (auth-context L336)
  findPersonalWorkspace(userId) → workspaceRow|null       // resolveDefaultWorkspace L105
}
bookOwnership: {
  getWorkspaceId(bookId) → workspaceId|null               // guest decision path (lazy require today)
}
registrationTx: {                                          // ← the unit-of-work port (see blocker §13.2)
  registerUserWithWorkspace({ username, passwordHash, email,
                              guestConversion?: { workspaceId, username } })
    → { userRow, workspaceRow, converted }
  // one PG transaction: INSERT users (ON CONFLICT lower(username) DO NOTHING)
  // + INSERT workspaces | UPDATE-style in-place conversion (type→'personal', expires_at→NULL,
  //   owner→user, all guests of ws revoked) + INSERT workspace_members owner
  // + canonical-race surfacing (unique violation → caller maps to 409 register_conflict)
}
```

Optional ports: `clock` (`now()` — guest-repo already threads `now` params; auth-service uses `Date.now()` inline) and `logger` (auth logs `[AUTH] ...` lines with a strict no-secrets discipline — replaced by an injected logger, console default).

**Hidden DB dependencies found (must be routed through ports, not overlooked):**

1. `auth-service` raw handle: `findByUsernameCanonical` (raw SELECT), `register()` (raw transaction), `resolveDefaultWorkspace` legacy-name self-heal (raw `UPDATE workspaces SET name` in a catch-all). The first two are whitelisted in `DIRECT_SQL_WHITELIST`; the self-heal UPDATE is a third, easily-missed site.
2. `bookAccessDecision`'s **lazy `require('.../book-repo')`** inside the function body — an invisible persistence edge that require-graph scans of module headers miss.
3. `auth-context.checkBookAccess` user path performs **writes during authorization**: `workspace-ownership.resolveWorkspaceForBook(allowCreate:false)` still calls `bookRepo.attachWorkspaceIfMissing` (attaches a workspace to rows with `NULL workspace_id`). Behaviour-preserving extraction must expose this as an explicit port capability (e.g. `bookOwnership.resolveAccessWorkspace(bookId, { preferredWorkspaceId })` implemented host-side over workspace-ownership) — not silently drop it.
4. `resolveSession` → `resolveDefaultWorkspace` can **create/rename a workspace during a read endpoint** (first login after migration, legacy names). Surprising but real; preserved as-is, documented in the port contract.

---

## 7. Config contract (all `process.env` reads, measured)

| Env var | Read site | Package treatment |
|---|---|---|
| `COOKIE_DOMAIN` | auth-service L34 | → `config.cookieDomain`; the strict charset regex + leading-dot normalization + fallback-to-host-only validation **moves into the package verbatim** (it is cookie grammar, security-relevant: attribute-injection guard, tested by auth-mvp §Cookie domain) |
| `GUEST_WORKSPACE_TTL_DAYS` (7) | auth-service L44 | → `config.guestWorkspaceTtlMs` |
| `GUEST_WORKSPACE_GRACE_PERIOD_DAYS` (23) | auth-service L45 | → `config.guestWorkspaceGraceMs` (consumed by host purge wiring) |
| `GUEST_SESSION_TTL_DAYS` (30) | auth-service L46 | → `config.guestSessionTtlMs` |
| `SESSION_TTL_MS` (hardcoded 30d) | auth-service L21 | → `config.sessionTtlMs` (default 30d) — today *not env-tunable*; keep that property unless an ADR says otherwise |
| `NODE_ENV === 'production'` | auth-context L109, auth-routes L26 (duplicated `isHttpsRequest`/`isSecure` helpers) | stays host: Secure-flag detection is a transport concern; package keeps the `{ secure }` parameter it already has |
| `ADMIN_USERNAMES` | auth-context L139 | stays host (`requireAdmin` is host middleware) |

Minimal injected config object:

```js
config = {
  sessionCookieName: 'animastor_sid',
  guestCookieName:   'animastor_gid',
  sessionTtlMs:          30 * 24 * 3600e3,
  guestWorkspaceTtlMs:    7 * 24 * 3600e3,
  guestWorkspaceGraceMs: 23 * 24 * 3600e3,
  guestSessionTtlMs:     30 * 24 * 3600e3,
  cookieDomain: '',        // validated/normalized in-package, '' → host-only cookies
}
```

**Duplication finding:** `config/runtime-config.js` L274–276 re-reads and exports the same three `GUEST_*` values. Auth does not consume them (it reads env directly). After extraction, the host composes *one* config source (runtime-config → createAuthService) and the duplicate env reads collapse to one site — a preparation-step cleanup, not a blocker.

---

## 8. HTTP / Express boundary

**Express-shaped today (stays host):**

- `authContext(req,res,next)` — resolution order, guest auto-provision with path/method exemptions, Set-Cookie on provisioning, anonymous-degrade on error;
- `requireAuth`, `requireAdmin`, `requireWorkspaceMembership` — 401/403 shells;
- `requireBookAccess(param)` — 400/403/410 shells over `checkBookAccess`, sets `req.bookWorkspace`;
- `getAccessibleBookWorkspace`, `dedupOwnedByCaller`, `importBookAllowed`, `hasIdentity` — take `req` and map results into `{ok, status, mode}` / `{allowed, status, error}` shapes;
- `readCookie(req, name)`, `isHttpsRequest(req)`, `isSecure(req)`;
- `routes/auth-routes.cjs` — the whole HTTP contour.

**Req-free today (moves as-is):** `password.js` entirely; `bookAccessDecision(identity, bookId)` (after consolidation); all four cookie header builders; `publicUser`/`publicWorkspace`; `workspaceStatus`; `AuthError`/`WorkspaceExpiredError`; TTL/policy math.

**The mechanical split (the `bookAccessDecision`/`checkBookAccess` pair, generalized):** every host wrapper becomes `read identity from req → call package decision → translate to status/json/next`. The package never sees `req`; the host never re-implements policy. Post-split, the host wrappers shrink by roughly the policy half of `auth-context.js` (~180 LOC), which moves into the package.

**Pre-auth compatibility is a frozen contract:** no identity → allow-all books (`{id:'anonymous', name:'Anonymous', type:'temporary'}` sentinel), guest auto-provision only on content-generating writes, `importBookAllowed`/`dedupOwnedByCaller` pre-auth passthrough, recent-books anonymous listing of unowned books. All of these are consumed by player/editor/assistant surfaces and 15+ test suites — they must survive extraction byte-for-byte (§9).

---

## 9. Security invariants (must not change under extraction)

1. **Password hashing:** scrypt `N=16384, r=8, p=1`, keylen 64, salt 16B, self-describing format `scrypt$N=...,r=...,p=...$salt.b64$hash.b64`; `timingSafeEqual` comparison; **constant-cost dummy derivation when the stored hash is missing** (username-enumeration timing guard — the invariant most at risk in a refactor).
2. **Login error uniformity:** unknown user and wrong password → identical `401 'Invalid username or password'` + reason `login_invalid_credentials`; reason categories never reveal which half failed (verified by auth-mvp test 8).
3. **Token handling:** raw tokens exist only in cookies and function args; DB stores SHA-256 hash only; malformed/tampered/expired/revoked → unauthenticated; tokens never appear in API response bodies (verified by tests 12b).
4. **Cookie attributes:** `Path=/; HttpOnly; SameSite=Lax; Max-Age=<TTL>` on all four builders; `Secure` in production/HTTPS; `Domain` only from a strictly charset-validated, normalized `COOKIE_DOMAIN` (no attribute injection); clear-cookies use `Max-Age=0` with identical attributes.
5. **Guest model:** guest is never a fake user (`req.user` stays null); identity from a cryptographically random token, never IP/fingerprint/book-ids; expired workspaces keep resolving but every access answers 410 `workspace_expired`; activity extends TTL write-only-when-extending; hard purge only past TTL+grace, books-before-workspace deletion order, per-workspace transaction.
6. **Conversion atomicity:** guest → account keeps the same `workspace_id` (zero book copying); old guest token revoked after conversion; guest cookie cleared; user+workspace+membership never exist in a partial state.
7. **Workspace isolation:** the ownership chain is always `identity → workspace → book` (`books.workspace_id` → `workspace_members`); cross-workspace access requires explicit membership; unknown book / DB error for an authenticated identity → **deny (fail closed)**; import dedup may never hand an identity another identity's book; a disk copy without an ownership row fails closed for authenticated callers.
8. **Authorization failure semantics:** 401 unauthenticated / 403 authenticated-but-foreign / 410 expired-guest-workspace / 400 missing book id — exact status codes and error bodies are consumer-visible contracts (guards, `ai-book-guard`, import routes, tests 16/7/8).
9. **Namespace disjointness:** `sid.*`/`gst.*`/`wrk.*` never cross-authenticate; worker tokens never set `req.user`; guest auto-provision never fires on `/auth`, `/worker`, `/ai-connector`, `/admin`.

---

## 10. Consumer map (per-consumer disposition)

| Consumer | What it uses | Via `@animastor/auth`? | Shim? | Circular risk |
|---|---|---|---|---|
| `routes/auth-routes.cjs` | register/login/logout + all cookie builders + AuthError + parseCookie | **Yes** — becomes the package's reference HTTP adapter | `auth-service` require re-pointed by shim | none |
| `middleware/auth-context.js` | resolveSession/resolveGuest/createGuest/touch + decision fns + WorkspaceExpiredError | **Yes** — wrappers call package decisions | module stays, body slims | none |
| `backend.cjs` | guard mounting, player `assertBookAccess` injection, purge timers, rate limits | Indirectly (through auth-context) | none needed (consumes middleware, not the package) | none |
| `routes/admin-routes.cjs` | `requireAdmin` | No — host middleware shell | stays | none |
| `routes/book/import-routes.cjs`, `routes/generation-routes.cjs` | `importBookAllowed`, `hasIdentity` | No — host wrappers over package decisions | stays (same require path) | none |
| `middleware/ai-book-guard.js` | `hasIdentity`, `checkBookAccess`, `WorkspaceExpiredError` | No — host-stay (assistant contract) | stays | none |
| `@animastor/player` | injected `assertBookAccess` port | **No require** — host keeps injecting the (now package-backed) `checkBookAccess` | none | none (and must stay injection-based — the package must never require the player) |
| `services/worker-auth.js` | nothing from auth (vocabulary only) | No — separate domain | n/a | none |
| `config/runtime-config.js` | duplicate GUEST_* env reads | No — host composes config | cleanup site | none |
| 15+ test suites | `authContext` via real HTTP, cookie names, login flows | No — they test host behaviour through the shim | unaffected | none |
| `frontends/app`, `frontends/android` | HTTP endpoints + cookie names | No — wire contract only | none | none |

**Compatibility shim:** `backend/src/auth/auth-service.js` becomes a thin wiring module: `module.exports = createAuthService({ ports: boundHostRepos, config: fromRuntimeConfig() })` plus re-export of the package's static surface (`AuthError`, cookie builders, constants). All existing require sites (`auth-context`, `auth-routes`, tests) keep working unchanged. Direction is strictly one-way: host → package. **No compatibility risk found**: no consumer requires auth internals beyond the two modules being shimmed; no consumer is a package that would need republishing.

---

## 11. Test ownership

**Move INTO the package (with in-memory port adapters + fake clock):**

- password primitives: hash/verify round-trip, non-determinism (per-hash salt), NULL/legacy hash safety, **timing-equalization invariant**, policy boundaries (8/512) — from auth-mvp §Password storage;
- cookie grammar: all four builders' attribute matrix (`HttpOnly`/`SameSite=Lax`/`Path`/`Max-Age`/`Secure`), `COOKIE_DOMAIN` validation matrix (unset → host-only; set → all four builders; leading-dot normalization; injection attempts → host-only) — from auth-mvp §Cookie domain (unit-half only);
- `AuthError`/`WorkspaceExpiredError` semantics; `publicUser`/`publicWorkspace` shapes; `workspaceStatus`; `sid.`/`gst.` token parse grammar + hash-only property;
- decision-contract tests over fake ports: pre-auth/guest/user/expired/denied matrix, fail-closed on port errors, membership fallback, foreign-book 403;
- **new port contract tests** (`assertUserRepo`/`assertSessionsRepo`/... runtime validators + behavioural conformance suite the host adapters must pass).

**Stay host-side (real PG + real Express):**

- `auth-mvp.test.js` HTTP integration half (register→login→me→logout over real PG, workspace-filtered listing, duplicate/case-variant 409s, atomicity invariants, pre-auth regression);
- `guest-workspace.test.js` entirely (provisioning-on-write, exemptions, 410 lifecycle, in-place conversion, purge against real FK order);
- `account-workspace.test.js` (repo-level user/workspace/book semantics + ownership resolver);
- `admin-security.test.js` (`requireAdmin` host surface + ADMIN_USERNAMES);
- all worker/tenant-guard suites (`private-worker-*`, `txt-import-ownership`, `workspace-ai-security`, …) — they consume auth via HTTP and guard host wiring.

**New tests required:**

- `backend/tests/architecture/auth-package-boundary.test.js` (installer-pattern guards: package exists at `packages/animastor-auth`; zero npm deps; node:crypto-only requires; no requires into `backend/**`; no host imports of package internals; frozen public exports; host consumes the specifier; host adapters satisfy port contracts);
- package security regression suite (§9 items 1–5 as executable tests inside the package — they become the frozen contract);
- host regression that the shim wiring fails fast on a port adapter missing a method (composition-root guard, assistant precedent).

---

## 12. Compatibility strategy — migration path `backend → @animastor/auth`

Four phases, each independently shippable and reversible:

1. **Contract freeze (no physical move).** Write the port contracts + validators and the consolidated `bookAccessDecision` inside `backend/src/auth/` (new files), switch `auth-context.checkBookAccess` to call the consolidated decision, delete the dead duplicate semantics. Verification: full auth suite green, decision matrix tests added. **This phase alone resolves blocker §13.1.**
2. **Ports in host (still no move).** Introduce `createAuthService({ports, config})` wiring in the shim module; repos + registrationTx implemented by the existing host repos; env reads collapse into runtime-config → injected config; exit `DIRECT_SQL_WHITELIST` (the guard's stale-entry rule auto-enforces). Verification: sql-boundary + auth suites green.
3. **Physical move.** `git mv` core + password + cookie grammar into `packages/animastor-auth` (assistant package.json template; zero deps; engines node>=20); shim re-exports; auth-context wrappers delegate; move the unit test half per §11. Add the boundary guard test.
4. **Post-move cleanup (optional, later).** `auth-routes.cjs` → `createAuthRoutes(app, deps)` inside the package (player precedent) once the contour proves stable; runtime-config GUEST_* duplication removal; worker-domain core revisit stays parked per the parent audit.

The shim (phase 3) lives at `backend/src/auth/auth-service.js` — the exact current require path — so zero consumer churn.

---

## 13. Risks / blockers

| # | Risk / blocker | Severity | Resolution |
|---|---|---|---|
| 13.1 | **Two divergent authorization paths.** `bookAccessDecision` (0 consumers) vs `checkBookAccess` (all consumers, Express-coupled, richer semantics). Extracting as-is freezes a contract nobody uses and leaves the real one host-bound. | **Blocker** | Phase 1 consolidation: one decision function with `checkBookAccess`'s real semantics, identity-based; guards become wrappers. Small, precedented, testable. |
| 13.2 | **Raw-SQL registration transaction** (whitelisted `DIRECT_SQL_WHITELIST` debt): atomicity of user+workspace+membership+conversion must survive port-ification. Naive per-table ports would lose it. | **Blocker** | `registrationTx.registerUserWithWorkspace` unit-of-work port (§6); canonical-race → 409 mapping preserved; whitelist exit verified by the existing stale-entry guard rule. |
| 13.3 | **Hidden writes / lazy requires in authorization paths**: lazy `book-repo` inside `bookAccessDecision` + `resolveGuestBookWorkspace`; `resolveWorkspaceForBook(allowCreate:false)` still attaching workspaces; `resolveDefaultWorkspace` self-heal on read paths. | High | Route every one through named ports with the behaviour documented in the port contract; preserve semantics exactly (no "fixing" during extraction). |
| 13.4 | **Timing-equalization invariant** (dummy scrypt derivation on missing hash) could be lost in refactor. | High | Move `password.js` verbatim; lock with an in-package regression test before any further edit. |
| 13.5 | **Pre-auth legacy surface** (`anonymous` sentinel workspace, allow-all, provisioning exemptions) consumed by 3 packages + 15 suites. | Medium | Freeze as documented contract tests; host wrappers keep exact status codes/bodies. |
| 13.6 | **Config duplication** (runtime-config vs auth-service env reads) — drift risk if only one site is updated post-extraction. | Low | Single composition site in the host during phase 2. |
| 13.7 | **Duplicated HTTPS detection** (`isHttpsRequest` vs `isSecure`) — two implementations of the Secure-flag decision. | Low | Keep host-side, dedupe during phase 2; package keeps `{ secure }`. |

No circular-dependency, licensing, or publish-blocking risk was found. The package will have **zero npm dependencies** (`node:crypto` only) — the strongest isolation score of any remaining candidate.

---

## 14. Final verdict

### **B — READY AFTER SMALL PREPARATION**

The domain is cohesive, crypto-only, stateless in-process, owns its contract embryo (`AuthError`, cookie grammar, public projections, decision-result shape), carries 1,257 LOC of dedicated tests, and has a small, fully-mapped consumer list with one-way dependency direction. Nothing measured this pass argues for C: every blocker is a bounded seam, and every seam has an in-repo precedent (assistant sessionRepo contract, registration via explicit port method, player/editor port injection, installer boundary guards).

**Why not A:** the two blockers (§13.1, §13.2) are real contract decisions that must be made *before* a freeze — extracting first would cement the wrong authorization contract and either lose registration atomicity or force a breaking second migration of a security-critical surface.

### Preparation steps (in order, each independently verifiable)

1. **Consolidate the book-access decision** into one identity-based `bookAccessDecision(identity, bookId)` carrying `checkBookAccess`'s real user-path semantics (self-heal-resolved ownership, membership fallback, fail-closed); re-point guards; delete the dead duplicate. *(§13.1)*
2. **Repo ports ADR + validators**: users / sessions / guests / workspaces / bookOwnership / registrationTx exactly as specified in §6; host repos become adapters. *(§13.2, §13.3)*
3. **Env → injected config** per §7; collapse the runtime-config duplication; dedupe HTTPS detection. *(§13.6, §13.7)*
4. **Test split** per §11: move the unit half with in-memory adapters; keep PG/HTTP integration host-side; write the package security regression suite.
5. **Physical move + shim + boundary guard** per §12 phases 3–4.

Recommended execution size: phases 1–2 are ~1–2 focused sessions (all inside `backend/src/auth` + `middleware`, zero external churn); phase 3 is the mechanical `git mv` + shim the installer/assistant moves already templated.

---

## 15. Implementation Phase 1 — Contract Preparation (LANDED)

**Status:** IMPLEMENTED (this section documents the code change that followed the audit). Commit on `c21.4-physically-extract-analysis-from-backend`, parent commit `9cea2a0e`. No npm package created, no physical extraction, no public API change, no schema change, no semantics change.

### 15.1 What changed

**New domain core — `backend/src/auth/` (Express-free, env-free, PG-free):**

| File | Content |
|---|---|
| `auth-errors.js` | `AuthError(status, message, reason)` + `WorkspaceExpiredError` (410 `workspace_expired`) — the frozen error contract, previously duplicated in auth-service/auth-context |
| `auth-config.js` | `DEFAULT_AUTH_CONFIG` (frozen historical values) + pure `normalizeAuthConfig` / `normalizeCookieDomain` (the strict charset validation moved verbatim-semantics here). No `process.env`. |
| `cookies.js` | String-level cookie grammar: the 4 Set-Cookie builders (config-parameterized: name/TTL/Domain) + `parseCookieHeader(header, name)` + the frozen constants (`animastor_sid`, `animastor_gid`, TTLs). No `req`. |
| `book-access.js` | **The canonical decision layer** (blocker §13.1 resolved): `decideBookAccess(identity, bookId, ports)` — user path carries the real checkBookAccess semantics (resolver self-heal + cross-workspace membership fallback + legacy chain fallback, fail-closed 403), guest path unchanged (expired → 410 before any port call, foreign → 403, port error → 410 fail-closed), pre-auth → anonymous sentinel. Plus `authorizedWorkspace` (workspace|null + `WorkspaceExpiredError` on 410, throws BEFORE port calls — the historical ordering). |
| `ports.js` | `assertAuthPorts` runtime validators for the six ports (assistant `assertSessionRepo` pattern) — fail-fast at composition, exact historical method lists (§6). |
| `core.js` | `createAuthService({ ports, config, logger })` — the whole lifecycle (register/login/logout/resolveSession/resolveDefaultWorkspace/createGuest/resolveGuest/touchGuestWorkspace + guestWorkspaceStatus + decision + config-bound cookie wrappers). No Express/env/PG. Registration race → 409 email/username discrimination preserved via a marked `registerRace` error from the port. |

**New host adapters:**

| File | Content |
|---|---|
| `storage/postgres/repositories/registration-tx.js` | **The registration unit-of-work** (blocker §13.2 resolved): `registerUserWithWorkspace({username, passwordHash, email, displayName, guestConversion})` — ONE PG transaction (user INSERT ON CONFLICT lower(username) DO NOTHING → workspace INSERT or in-place guest conversion via `guestRepo.convertTemporaryWorkspace` → owner membership). Rollback/error behaviour identical to the former inline transaction; race surfaces as a marked error the core maps to the exact historical 409s. |
| `auth/index.cjs` | The single wiring point: `authConfigFromEnv()` (the ONLY `process.env` reads left in auth/**) + `buildAuthPorts()` binding user/session/guest/workspace repos, `registrationTx`, and `bookOwnership` (`workspace-ownership.resolveWorkspaceForBook` for the access leg + `book-repo.getWorkspaceId` for the guest leg) → `createAuthService`. Exposes the wired singleton in the historical `authService` shape + a per-call `COOKIE_DOMAIN` re-resolution bridge (the historical call-time env semantics that the auth-mvp cookie suite pins). |

**Rewritten (same require paths, same exports — zero consumer churn):**

- `auth/auth-service.js` — now the compatibility shim re-exporting the wired singleton (`buildAuthService` test seam exported). The former raw SQL (register transaction, canonical username SELECT, self-heal UPDATE) moved to `registration-tx.js` / `user-repo.findByUsernameCanonical` / `workspace-repo.renameWorkspace`. **`auth-service.js` exited `DIRECT_SQL_WHITELIST`** (stale-entry removal, sql-boundary guard enforces). Also re-exports `WorkspaceExpiredError` (new: previously only on auth-context).
- `middleware/auth-context.js` — now a pure HTTP adapter: `identityOf(req)` projection + delegation to `accessibleBookWorkspace` / `getWorkspaceIdForBook`; `requireAuth/requireAdmin/requireWorkspaceMembership` (admin/workspace-surface policy, host-owned per §4.2) and the guest auto-provision block (path-shape doctrine incl. worker/LAC exemptions) unchanged; `authContext` now uses `parseCookieHeader` with a `readCookie` fallback. No authorization logic remains here.
- `user-repo.js` +`findByUsernameCanonical` (raw SELECT moved in, semantics identical); `workspace-repo.js` +`renameWorkspace` (self-heal UPDATE moved in).

### 15.2 Boundaries created

- **Decision boundary:** exactly one canonical authorization layer (`auth/book-access.js`); the dead `bookAccessDecision` twin is gone (its result shape absorbed); `requireBookAccess`/`checkBookAccess`/`getAccessibleBookWorkspace`/`dedupOwnedByCaller`/`importBookAllowed` and the player `assertBookAccess` port all flow through it.
- **Transaction boundary:** registration atomicity lives behind the `registrationTx` port; the domain core has zero SQL.
- **Config boundary:** auth/** reads `process.env` in exactly one file (`auth/index.cjs` wiring); the domain consumes `normalizeAuthConfig`-normalized config. `ADMIN_USERNAMES`/`NODE_ENV`/rate-limits stay host (§7 disposition).
- **HTTP boundary:** no domain file imports Express; middleware files import only the domain (no repos, no raw PG).

### 15.3 Blockers resolved / remaining

| Blocker | Status |
|---|---|
| §13.1 divergent decision paths | **RESOLVED** — consolidated in `book-access.js`, guards are adapters |
| §13.2 raw-SQL registration transaction | **RESOLVED** — `registration-tx.js` unit-of-work port; `DIRECT_SQL_WHITELIST` entry removed |
| §13.3 hidden writes / lazy requires in auth paths | **RESOLVED** — all behind named ports (`bookOwnership.resolveAccessWorkspace` documents the self-heal attach; `resolveDefaultWorkspace` self-heal routed through `workspace-repo.renameWorkspace`) |
| §13.4 timing-equalization invariant | **PRESERVED** — `password.js` untouched, pinned by contract tests |
| §13.5 pre-auth legacy surface | **PRESERVED** — pinned by auth-mvp/guest-workspace suites (65 tests green) + 12 new decision-matrix tests |
| §13.6 config duplication (runtime-config) | **PARTIALLY RESOLVED** — auth-side env reads collapsed into one wiring file; `config/runtime-config.js` L274–276 still duplicates the GUEST_* reads for its own consumers (host-internal cleanup, pre-extraction hygiene, not a blocker) |
| §13.7 duplicated HTTPS detection | **UNCHANGED (accepted)** — both helpers remain host-side transport concerns |

### 15.4 Extraction sanity check (post-implementation)

- **Imports left in the domain core:** `node:crypto` only (password.js); intra-auth requires. Zero npm deps, zero Express, zero storage requires, zero `backend.cjs` back-references (verified by scan: no violations).
- **Repositories remaining (host adapters):** user/session/guest/workspace repos + `registration-tx.js` + `book-repo.getWorkspaceId` + `workspace-ownership.resolveWorkspaceForBook` — all bound in `buildAuthPorts()`.
- **Env dependencies remaining:** `auth/index.cjs` only (COOKIE_DOMAIN live re-resolution + GUEST_* TTLs).
- **Express remaining:** `middleware/auth-context.js` (adapter) + `routes/auth-routes.cjs` (contour) — exactly the §4.2 host-side disposition.
- **Circular dependencies:** none (fresh-require smoke over all 9 auth files passes; dependency direction is strictly host → domain).
- **Consumers migrating at physical extraction:** domain files (`auth/{core,book-access,cookies,auth-errors,auth-config,password,ports}.js`) move to the package; `auth/index.cjs` becomes the host shim; `auth-context.js`/`auth-routes.cjs` require-path unchanged; test suites `auth-contract.test.js` + the unit halves move per §11.

### 15.5 Tests

- **New:** `backend/tests/auth-contract.test.js` — 37 tests over in-memory ports: config normalization, cookie grammar matrix, the full decision matrix (pre-auth/user/guest/expired/foreign/membership-fallback/DB-failure fail-closed × user and guest), registration (race 409s, unique 409, atomic rollback = no session after tx failure, in-place conversion + token revocation, stale token 410, validation 400s), login/logout/session, guest lifecycle, port-validator fail-fast.
- **Regression (unchanged, all green):** `auth-mvp` + `guest-workspace` + `admin-security` + `txt-import-ownership` (65), `account-workspace` + `workspace-ai-security` + `private-worker-auth` + `fail-closed-worker-auth` (108), `generation-routes` (6), full architecture suite (965 passing; the only 2 failures — installer IB-G15 `private` pin and phase5 `runtime/index.js` read — pre-exist on the base commit `9cea2a0e`, unrelated to auth), `sql-boundary` (whitelist now excludes auth-service; stale-entry rule green), syntax smoke (all production files).
- **Pre-extraction requirement (unchanged from §12):** move `auth-contract.test.js` + the unit halves into the package; keep PG/HTTP suites host-side.

**Updated verdict: B → B+ (preparation complete; the domain is extraction-ready).** Phase 1–2 of §12 are landed; what remains is the mechanical phase 3 (physical move + shim flip + package manifest + boundary guard test) and the optional phase 4.

---

## Appendix A — verdict legend

**A** READY · **B** READY AFTER SMALL PREPARATION (bounded seam work first) · **C** HOST-BOUND (domain exists, coupling too strong today) · **D** NOT A PACKAGE

## Appendix B — measured facts this audit rests on

- LOC (wc): auth-service 434, password 106, auth-context 387, auth-routes 145, worker-auth 215, workspace-ownership 88, ai-book-guard 98; repos session/guest/user/workspace 120/226/151/151; tests auth-mvp/guest-workspace/account-workspace/admin-security 529/410/318/212.
- `bookAccessDecision`: 1 definition, 0 production call sites (rg across repo; only docs references).
- `auth-service.js` is an entry of `DIRECT_SQL_WHITELIST` (`tests/architecture/sql-boundary.test.js`, frozen baseline) for the register transaction + raw SELECT; the legacy-name self-heal `UPDATE workspaces SET name` is an additional raw write in the same file.
- Env reads in auth: COOKIE_DOMAIN + GUEST_{WORKSPACE,WORKSPACE_GRACE,SESSION}_TTL_DAYS (auth-service), NODE_ENV ×2 + ADMIN_USERNAMES (auth-context/auth-routes); `config/runtime-config.js` L274–276 duplicates the GUEST_* reads.
- Inbound require edges: auth-service ← auth-context, auth-routes, 3 test suites; auth-context ← backend.cjs ×2, admin-routes, import-routes, generation-routes, ai-book-guard, 15 test suites; `@animastor/player` receives `checkBookAccess` via `playerPorts.assertBookAccess` injection (no require).
- Cookie names `animastor_sid`/`animastor_gid` appear in backend, both frontends, docker-compose docs and 10+ test files — a cross-cutting wire contract that must not drift.
- Port precedents verified in-repo: `packages/animastor-assistant/src/session-repo-contract.cjs` (`assertSessionRepo`, 9-method validator), `packages/animastor-player` port injection pattern, `backend/tests/architecture/installer-package-boundary.test.js` (17 guard clauses).
