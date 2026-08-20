# Experimental Beta — Private Worker / GPU Hub: Phase 1 Security Review

> **Status:** Targeted security review — **no code changed, no commits, no push**.
> **Date:** 2026-08-20
> **Implementation commit under review:** `6c3a3d2` `feat(beta): add private worker identity and auth`
> **Subject:** Phase 1 — Worker Identity & Authentication
> (worker identity, auth, credential, workspace binding, registration, rotation,
> revoke, guest restrictions, legacy heartbeat removal, Redis worker-state
> mirror, PostgreSQL worker persistence).
> **Method:** the commit diff was read in full and every claim re-derived from the
> working-tree source (`worker-repo.js`, `worker-auth.js`,
> `worker-auth-middleware.js`, `worker-routes.cjs`, `auth-context.js`,
> `auth-service.js`, `workspace-repo.js`, `schema.js`, `backend.cjs`,
> `generation-routes.cjs`, `gpu-hub.js`, `proxy/conf/default.conf`) and from the
> test suite (`private-worker-auth.test.js` and the related auth/workspace/guest/
> generation suites). Live PostgreSQL was used to execute the tests. The commit
> message was treated as an unverified hypothesis; the code and tests were
> treated as ground truth.
> **Test evidence:** `private-worker-auth.test.js` — 27 passing; full backend
> suite — 1341 passing; syntax smoke — all production files OK. No lint/typecheck
> script exists in `backend/package.json` (only `test`, `test:coverage`,
> `test:syntax`).

---

## 1. Executive Verdict

**Phase 1 security status: PASS WITH WARNINGS.**

**Can Phase 2 safely build on this implementation? YES.**

The Phase 1 boundary is sound and fail-closed by construction:

- Credentials are 256-bit random (`crypto.randomBytes(32)`), stored **hash-only**
  (SHA-256 hex), shown exactly once at issuance, never logged, never returned by
  list/status endpoints.
- **PostgreSQL is the sole authentication authority.** `authenticateWorker`
  always resolves against PG; the Redis mirror (`animastor:worker-auth`) is
  written but **never read for authentication** in Phase 1. Stale, forged or
  rebuilt Redis state therefore cannot mint, extend or revive a worker identity.
- Identity (`worker_id`, `workspace_id`) is derived exclusively from the
  validated credential row; `req.body`/`req.query` worker/workspace fields are
  never consulted anywhere (verified by grep — zero consumers in `backend/src`).
- Cross-workspace escalation (registration, rotate, revoke, list, authenticate)
  is impossible: management routes derive `workspace_id` from the authenticated
  session's personal workspace and every mutate SQL re-checks it.
- The legacy unauthenticated heartbeat POST is removed with no proxy path, no
  worker-side dependency, and the guest auto-provision DB-churn vector is closed
  (`/api/v1/worker*` exempted from guest auto-provision in `authContext`).
- Migration PW-1 cannot create silent orphan workers (NOT NULL workspace FK,
  `ON DELETE CASCADE`, `token_hash UNIQUE NOT NULL`, loud skip on non-empty
  legacy table).

No CRITICAL, HIGH or MEDIUM findings. All findings below are LOW or
INFORMATIONAL hardening items that do not block Phase 2.

---

## 2. Credential Security

| Check | Result | Evidence |
|---|---|---|
| Token entropy | **PASS** — 32 bytes CSPRNG (`crypto.randomBytes`, `worker-repo.js:63`) | test asserts secret decodes to ≥32 bytes |
| Token generation | **PASS** — `wrk.<b64url(worker_id)>.<b64url(secret)>`, no timestamp/weakness | `worker-repo.js:67` |
| Hashing | **PASS** — SHA-256 of the secret, hex; DB stores hash only | `worker-repo.js:74`; test asserts 64-hex, never the token |
| Comparison | **PASS** — `crypto.timingSafeEqual` on equal-length hex buffers, length pre-check | `worker-repo.js:123-126` |
| Plaintext exposure | **PASS** — token returned only by `POST /api/v1/workers` and rotate responses; list never returns it (`publicWorker` omits token + token_hash) | `worker-routes.cjs:58-71,140-150`; test asserts list never contains the token |
| Logs | **PASS** — no token in app logs; HTTP access log logs URL only, never the `Authorization` header | `backend.cjs:135-145`; grep over the new files shows zero token logging |
| Errors | **PASS** — auth errors return generic 401s, no oracle detail | `worker-auth-middleware.js:36-47` |
| API responses | **PASS** — one-time disclosure only; `token_prefix` (first 8 b64url chars ≈ 48 bits) is display-only, not secret-reconstructing | `worker-routes.cjs:60` |
| DB storage | **PASS** — hash only | `worker-repo.js` insert/select |
| Rotation | **PASS** — new hash replaces old in one UPDATE; old token dead on commit; mirror point-dropped | `worker-repo.js:180-190`, `worker-routes.cjs:155-162` |
| Revocation | **PASS** — `revoked_at` set, `findByToken` filters `revoked_at IS NULL`; mirror point-dropped | `worker-repo.js:200-207`, `worker-routes.cjs:176-181` |

**Question 2 — can DB / Redis / log compromise yield a working plaintext
credential?**

- **DB compromise → hash only.** A dumped `workers` table yields 256-bit SHA-256
  hashes. Offline brute-force of a 32-byte random secret is infeasible. No
  plaintext is ever persisted. **No credential recoverable.**
- **Redis compromise → no reusable secret.** The mirror holds `token_hash →
  identity JSON`; the keys are the same non-reversible SHA-256 hashes and the
  values are identity metadata (worker_id/workspace_id/type/mode/name) — no
  secret, and the mirror is never consulted for authentication, so an attacker
  who rewrites the mirror cannot mint an identity. **No credential recoverable.**
- **Application log access → no secret.** No Authorization header, no token, no
  secret is logged anywhere in the Phase 1 code. **No credential recoverable.**

Expected property met: DB → hash only; Redis → no reusable plaintext; logs → no
secret. **CONFIRMED.**

---

## 3. Authentication Boundary

`requireWorkerAuth` + `workerAuth.authenticateWorker` (`worker-auth-middleware.js`,
`worker-auth.js:74-87`).

| Case | Behavior | Evidence |
|---|---|---|
| Missing token | **DENY 401** `worker_credential_missing` | test ✔ |
| Malformed token | **DENY 401** (`parseToken` → null) | test ✔ (garbage, `sid.*`, `gst.*`, `wrk.bad`, non-b64) |
| Invalid token (wrong secret) | **DENY 401** (hash mismatch via `timingSafeEqual`) | test ✔ |
| Unknown worker id | **DENY 401** (no row) | test ✔ |
| Revoked token | **DENY 401** (`revoked_at IS NULL` filter) | test ✔ |
| PG outage / lookup error | **DENY 401** — `authenticateWorker` catches and returns null; middleware catches and 401s | `worker-auth.js:81-86`; test "fails closed" ✔ |
| Valid token | **ALLOW** → `req.authenticatedWorker = { id, workspace_id, worker_type, capabilities, mode, name }` | `worker-auth.js:33-42`; test ✔ |

Identity is always server-side state from the validated PG row. Grep confirms no
consumer of `req.body.worker_id` / `req.query.worker_id` /
`req.body.workspace_id` anywhere in `backend/src`. **CONFIRMED.**

Note: `requireWorkerAuth` is currently mounted only in tests (the `/gpu/__test/
whoami` probe); no production route uses it yet. This is by design — Phase 2
mounts the boundary on the hub-facing surface. The middleware's `redis` argument
is accepted but unused (Phase 2 hook). This is a scope statement, not a finding.

---

## 4. Cross-Workspace Attack

| Scenario | Result | Evidence |
|---|---|---|
| Worker A credential + `worker_id` = B in token | **DENY** — self-locator finds B's row, secret hashes to A's secret → mismatch | test ✔ ("A's credential cannot authenticate as B") |
| Worker A credential + `workspace_id` = B in body | **Ignored** — identity from token only; body/query never read | test ✔ |
| Worker A credential + `workspace_id` = A + forged `worker_id` = B | **Ignored** — worker_id comes from token, not body | test ✔ |
| Worker A credential + another workspace identifier | **Ignored / 404** — rotate/revoke re-check `workspace_id` in the SQL `WHERE`; list is `WHERE workspace_id = $1` | tests ✔ |

Identity remains Worker A in every scenario; rights of Worker B are unreachable
without B's secret. **CONFIRMED.**

---

## 5. Registration

| Check | Result | Evidence |
|---|---|---|
| User from Workspace A creating a Worker in Workspace B | **Impossible** — `workspace_id` always from `req.workspace` (session's personal workspace), body value deliberately ignored | `worker-routes.cjs:107-112`; test ✔ |
| Client-supplied `workspace_id` override | **Ignored** — assert `worker.workspace_id === alice.workspaceId` | test ✔ |
| Guest creating a persistent worker | **DENIED** — `userWorkspaceGuard` requires `req.user` (401) and forbids `req.guest` (403, defensive); anonymous POST does not auto-provision a guest/workspace | `worker-routes.cjs:40-56`; test asserts 401 and zero rows created |
| Duplicate names/credentials | **No identity ambiguity** — identity is server UUID; `token_hash UNIQUE`; duplicate names allowed but distinct workers | test ✔ |
| Invalid input | 400 on missing name / bad `worker_type`; `worker_type` CHECK + route whitelist | tests ✔ |

Authorization (authenticated user, own workspace) is separate from
authentication (session cookie). `req.workspace` for an authenticated user is
their **personal** workspace (`findPersonalWorkspace` by `owner_user_id =
user_id AND type='personal'`, `auth-service.js:86-92`, `workspace-repo.js:69-76`)
— the strictest scope; no member-of-another-workspace path exists for worker
management. **CONFIRMED.**

---

## 6. Rotation

- Old token: dies the moment the single `UPDATE ... SET token_hash` commits
  (`worker-repo.js:185-192`); `findByToken` reads the committed hash. **Immediate.**
- New token: valid immediately. Test ✔.
- Old token after rotation: **401**. Test ✔.
- Repeated rotation: idempotent, each rotation produces a fresh hash; previous
  hashes are dead. Test ✔.
- Concurrent rotation: a probe SELECT followed by UPDATE (TOCTOU) can issue two
  new tokens under two concurrent requests; the last UPDATE wins and the other
  returned token is simply invalid (client retries). No security consequence —
  the `UPDATE ... WHERE worker_id AND workspace_id AND revoked_at IS NULL`
  re-checks the binding, so **rotation cannot re-bind the worker to another
  workspace**. INFORMATIONAL (see §11-F1).
- Mirror: `mirrorDrop(previousTokenHash)` + `mirrorPut(new)` — eventual, healed
  by resync; not auth-critical. 

**CONFIRMED** — rotation behaves as specified; the only edge is a benign
double-issuance race under concurrency.

---

## 7. Revoke

- Revoked token → **DENY** (immediate; `revoked_at IS NULL` in `findByToken`).
  Test ✔.
- DB state: row kept (soft delete, audit), `revoked_at` set; second revoke → 404
  (idempotent-ish, no oracle). Test ✔.
- Redis state: `mirrorDrop(tokenHash)` on revoke; mirror is not consulted for
  auth anyway.
- Restart / Redis loss: auth always resolves against PG; a Redis restart that
  loses or restores any mirror state **cannot un-revoke a worker**. The mirror
  rebuild (`syncWorkerAuthMirror`) lists only `revoked_at IS NULL` rows.
  Test ✔ ("workspace deletion cascades", "mirror present/removed").
- Reconnect: N/A (no live worker-facing endpoint in Phase 1).

**Revoke → Redis restart → worker remains revoked: CONFIRMED.** PostgreSQL is
the durable truth.

---

## 8. Redis Mirror

Architecture as implemented: **PG = durable authority; Redis = operational
mirror, never authoritative, never read for auth in Phase 1.**

- Create → `mirrorPut`. Rotate → `mirrorDrop(old) + mirrorPut(new)`. Revoke →
  `mirrorDrop`. Deletion (workspace cascade) → removed by next resync (or left
  stale — harmless, not consulted).
- Startup + periodic (5 min) full rebuild from PG (`startWorkerAuthMirrorSync`),
  non-fatal on failure, idempotent.
- Stale worker in Redis while DB says revoked → **cannot authenticate** (PG
  filter wins).
- Old credential state in Redis while DB has new state → **cannot authenticate**
  (PG hash comparison wins).
- Redis unavailable → `mirrorPut/Drop` warn and skip; auth unaffected (PG).
- Redis loses all state → rebuilt from PG at startup / next resync.

**CONFIRMED** — the expected architecture holds and no access is possible from
stale Redis state alone. Two hardening items apply (§11-F2, F3): the rebuild is
a non-atomic `del`+`hset` (ioredis `pipeline()` is not `MULTI/EXEC`) and the
mirror has no TTL — both harmless today because the mirror is never read, but
Phase 2 must keep PG authoritative (or add a revocation check) when the hub
starts resolving via the mirror.

---

## 9. Guest Workspace

| Scenario | Result | Evidence |
|---|---|---|
| Guest → create worker | **401** (no `req.user`), and no guest/workspace rows are auto-provisioned | test ✔ (row counts unchanged) |
| Guest → rotate worker | **401** (guard precedes all four handlers) | `userWorkspaceGuard` |
| Guest → revoke worker | **401** | same |
| Guest → persistent worker after session ends | **Impossible** — guests never reach creation; workers are owned by personal workspaces of registered users | |
| Guest auto-provision churn | **Closed** — `/api/v1/worker*` exempted from guest auto-provision in `authContext` (`!req.path.startsWith('/api/v1/worker')`, line 88); the removed heartbeat was the only writer under that prefix | `auth-context.js:80-93`; test ✔ |

The old DB-churn vector does **not** return through the new endpoint surface.
**CONFIRMED.**

---

## 10. Legacy Heartbeat Removal

- Route gone: no `app.post('/api/v1/worker/heartbeat')` remains in
  `generation-routes.cjs` (only an explanatory comment). Test asserts 404 +
  zero rows on a POST to the old path. ✔
- Proxy path: `proxy/conf/default.conf` has no `worker/heartbeat` route; `/api/`
  proxies straight to backend, so the old path falls through to 404. Grep of the
  proxy config shows only unrelated `/worker/error` (hub error-callback block,
  already 403). ✔
- Worker code: `worker/` contains no reference to `/api/v1/worker/heartbeat`. ✔
- No compatibility endpoint: nothing re-creates workspace/guest rows; the
  read-only `GET /api/v1/worker/status` and `/counts` remain and read Redis
  heartbeat keys (pre-existing, unchanged). ✔
- The GPU hub's heartbeat traffic writes `animastor:worker:heartbeat:*` directly
  in Redis (`gpu-hub.js:140-278`) — an internal path, never the removed HTTP
  endpoint. ✔

**CONFIRMED** — removal is complete with no residual path.

---

## 11. Admin / User Boundary

Model as implemented: **any authenticated registered user manages workers in
their own personal workspace.** `users.role` (`user`/`admin`/`premium`) is not
consulted by worker routes — but there is no cross-workspace, cross-tenant or
admin-granted capability to escalate: `req.workspace` is always the caller's own
personal workspace and every worker SQL re-checks `workspace_id`. An ordinary
user cannot touch another workspace's workers, and there is no "system admin"
privilege to gain. **No privilege escalation found. CONFIRMED.**

INFORMATIONAL hardening (not required for Phase 1, no escalation today): when
team workspaces / workspace switching arrive, worker management scope must be
decided (owner-only vs member); the current personal-workspace-only scope is the
safe default.

---

## 12. Migration (PW-1)

| Check | Result |
|---|---|
| workspace FK | **PASS** — `workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE` |
| worker_type constraint | **PASS** — `CHECK (worker_type IN ('audio','image','video'))` (legacy `'upscale'` removed) |
| mode constraint | **PASS** — `CHECK (mode IN ('private','share'))`, default `'private'` |
| unique constraints | **PASS** — `token_hash TEXT NOT NULL UNIQUE` (indexed); worker_id UUID PK |
| token hash index | **PASS** — via UNIQUE |
| nullability | **PASS** — workspace_id/token_hash NOT NULL; created_by/revoked_at/last_seen nullable by design |
| cascade behavior | **PASS** — workspace delete cascades workers (tested); `created_by` FK has NO ACTION (default) — blocks user deletion while workers exist (prevents orphans, no orphan risk) |
| existing rows | **PASS** — loud skip (`console.error`) + manual-migration notice if the legacy table has rows; DROP only when verified empty |
| rollback safety | **WARN** — `DROP TABLE` + `CREATE` are not wrapped in a transaction (LOW, see F4) |
| orphan workers | **None possible** — NOT NULL FK + CASCADE; created_by is advisory metadata only |

**No silent orphan workers. CONFIRMED.**

---

## 13. Tests

Executed against live PostgreSQL:

- `private-worker-auth.test.js` — **27 passing** (registration, auth boundary,
  lifecycle, durability/mirror, legacy heartbeat, token internals).
- Related suites `auth-mvp`, `account-workspace`, `guest-workspace`,
  `generation-routes` — **78 passing**.
- Full backend suite — **1341 passing** (matches the commit message claim).
- `scripts/syntax-smoke.sh backend` — all production JS/CJS **OK**.
- Lint / typecheck / build: no such scripts exist in `backend/package.json`
  (only `test`, `test:coverage`, `test:syntax`). No lint/typecheck gate is
  configured; this is an INFORMATIONAL gap, not a Phase 1 blocker.

---

## 14. Finding Classification

### CRITICAL — 0

None.

### HIGH — 0

None.

### MEDIUM — 0

None.

### LOW / INFORMATIONAL — hardening (5)

- **F1 — INFORMATIONAL · CONFIRMED · Rotation double-issuance TOCTOU**
  (`worker-repo.js:174-183`). Probe `SELECT` then `UPDATE` allows two concurrent
  rotates to return two new tokens; the last commit wins, the other token is
  dead-on-arrival. No security consequence (binding is re-checked in the UPDATE
  `WHERE`; old tokens die immediately). Recommended future hardening: single
  statement `UPDATE ... RETURNING` (or `ON CONFLICT`) to serialize issuance.
- **F2 — INFORMATIONAL · CONFIRMED · Mirror rebuild is not atomic**
  (`worker-auth.js:108-117`). `pipeline.del` + `hset` without `MULTI/EXEC` can
  be observed half-written. Zero impact today (mirror never read for auth).
  Phase 2 MUST keep PG authoritative (resolve against PG, or add a
  revocation/consistency check) before the hub hot path reads the mirror.
- **F3 — INFORMATIONAL · CONFIRMED · Mirror has no TTL / key-level expiry.**
  Stale mirror entries heal only via the 5-min resync. Harmless today; combine
  with F2 when Phase 2 reads the mirror.
- **F4 — LOW · CONFIRMED · Migration PW-1 non-transactional DROP+CREATE**
  (`schema.js:1200-1222`). If two instances race on the legacy empty-table path,
  the second `DROP TABLE` can fail and throw at startup (loud, no data loss);
  there is a theoretical COUNT→DROP window for a concurrent writer that no
  pre-migration code exercises. Robustness item only — the code correctly
  refuses to DROP a non-empty table.
- **F5 — INFORMATIONAL · CONFIRMED · `touchLastSeen` is unscoped**
  (`worker-repo.js:200-204`). Exported but unused by any route in Phase 1. Any
  future caller must gate on workspace membership before invoking it, or it
  becomes a liveness-spoofing primitive. Also note `findByToken` ignores the
  `status` column (online/offline/busy/error) — a future "disabled" model must
  be enforced inside `findByToken`, not only `revoked_at`.

---

## 15. Final Verdict

```
Phase 1 security status:  PASS WITH WARNINGS
Can Phase 2 build safely:  YES
Critical: 0   High: 0   Medium: 0   Low/Info: 5 (all hardening)
```

**Main finding (one sentence):** the Phase 1 boundary is sound — credentials are
hash-only and entropy-strong, PostgreSQL is the sole authentication authority
(the Redis mirror is never read), cross-workspace identity/binding is impossible
in every tested scenario, and the legacy heartbeat guest-churn vector is closed —
leaving only non-blocking hardening items (rotation TOCTOU, non-atomic mirror
rebuild, mirror without TTL, non-transactional migration DROP, unscoped
`touchLastSeen`).

**Phase 2 preconditions (must-do before the hub hot path trusts the mirror):**
1. Keep PG authoritative for authentication; if the mirror is used as a fast
   path, add an explicit revocation/consistency check (or read PG on revoke
   and on any 5-min boundary).
2. Mount `requireWorkerAuth` on every worker-facing hub route and enforce the
   `req.authenticatedWorker` contract; never reintroduce an unauthenticated
   worker endpoint (heartbeat pattern).

**Hardening items that can wait (max 3):**
1. Single-statement credential rotation to close the TOCTOU double-issuance.
2. Wrap mirror rebuild in `MULTI/EXEC` (atomic swap) and add TTL to mirror
   entries.
3. Wrap migration PW-1 DROP+CREATE in a transaction and gate `touchLastSeen`
   behind a workspace-membership check.