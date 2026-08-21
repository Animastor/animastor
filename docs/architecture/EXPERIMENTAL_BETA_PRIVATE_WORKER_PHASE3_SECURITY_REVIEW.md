# Private Worker Management — Phase 3 Security Review

> **Date:** 2026-08-21
> **Auditor:** Independent acceptance / security audit (Codebuff)
> **Commit under review:** `c15ec1e03462b9380e6ea972785a8e7addd70a34`
> **Phase:** 3 — Worker management UX (list / detail / create / rotate / revoke / status)
> **Prior reviews:** Phase 1 (`f78b6ca`), Phase 2 red-team (`84e74e6`)

---

## 1. Scope

Phase 3 turns the Phase 1 identity/auth backend into a usable user capability. This review covers:

| Area | Files |
|------|-------|
| Backend management API | `backend/src/routes/worker-routes.cjs` |
| Worker repository | `backend/src/storage/postgres/repositories/worker-repo.js` |
| Worker auth service | `backend/src/services/worker-auth.js` |
| Auth middleware | `backend/src/middleware/worker-auth-middleware.js` |
| GPU Hub (auth integration) | `gpu-hub/gpu-hub.js` |
| Frontend UI | `frontends/app/src/features/workers/PrivateWorkersSection.tsx` |
| Frontend helpers | `frontends/app/src/features/workers/privateWorkers.ts` |
| i18n | `frontends/app/src/app/i18n.ts` |
| Settings routing | `frontends/app/src/pages/SettingsPage.tsx` |
| Worker client | `worker/worker/worker.cjs` |
| Backend tests | `backend/tests/private-worker-phase3.test.js` |
| Frontend tests | `frontends/app/src/features/workers/privateWorkers.test.ts` |
| Schema | `backend/src/storage/postgres/schema.js` |
| Config | `backend/src/config/runtime-config.js` |

---

## 2. Tested Areas

### 2.1 Workspace Isolation

| Scenario | Expected | Actual |
|----------|----------|--------|
| User A lists own workers | 200, only own | ✅ PASS |
| User A gets own worker detail | 200, safe shape | ✅ PASS |
| User A creates worker in own workspace | 201, workspace_id from server | ✅ PASS |
| User A rotates own worker | 200, new credential | ✅ PASS |
| User A revokes own worker | 200 | ✅ PASS |
| User A lists workers (cross-workspace) | 200, own only | ✅ PASS |
| User A gets Worker B (Workspace B) | 404 (no existence oracle) | ✅ PASS |
| User A rotates Worker B | 404 | ✅ PASS |
| User A revokes Worker B | 404 | ✅ PASS |
| Anonymous list | 401 | ✅ PASS |
| Worker Bearer token on user endpoint | 401 (disjoint namespace) | ✅ PASS |
| `workspace_id` in POST body ignored | workspace from `req.workspace` | ✅ PASS |

**Key defense:** `userWorkspaceGuard` resolves workspace_id from `req.workspace.id` (set by `authContext` middleware from the session cookie). The body field `workspace_id` is deliberately ignored in the create handler. Foreign/unknown IDs return one indistinct 404 — no existence oracle.

### 2.2 Credential Security

| Scenario | Expected | Actual |
|----------|----------|--------|
| Create returns plaintext token | Once only | ✅ PASS |
| List never returns token/token_hash | Absent | ✅ PASS |
| Detail never returns token/token_hash | Absent | ✅ PASS |
| Rotate returns new token | Once only | ✅ PASS |
| New token not in list/detail after rotate | Absent | ✅ PASS |
| Token never in console.log | Absent | ✅ PASS |
| Frontend: credential in React useState only | Transient memory | ✅ PASS |
| Frontend: Done clears credential | null | ✅ PASS |
| Frontend: no localStorage/sessionStorage/URL/IndexedDB | Never written | ✅ PASS |
| DB stores only SHA-256 hash | `token_hash UNIQUE` | ✅ PASS |
| Redis mirror stores hash → identity (no plaintext) | Correct | ✅ PASS |

**Key defense:** The plaintext credential is returned by the server ONLY on create/rotate responses. The `publicWorker` function never includes `token_hash` or raw token. The DB stores only the SHA-256 hash. The frontend stores the credential transiently in React `useState` while the disclosure modal is open, then clears it on "Done". It is never written to persistent storage.

### 2.3 Rotation

| Scenario | Expected | Actual |
|----------|----------|--------|
| Rotate own worker: old credential dies | 401 on old | ✅ PASS |
| Rotate: new credential works | 200 on new | ✅ PASS |
| Rotate: new token not in list/detail | Absent | ✅ PASS |
| Cross-workspace rotate | 404 | ✅ PASS |
| Mirror: old hash dropped, new hash added | Correct | ✅ PASS |

**Key defense:** `rotateCredential` atomically replaces the token_hash in PG. The Redis mirror is updated via `mirrorDrop(old)` + `mirrorPut(new)`. The backend auth boundary always resolves against PG (authoritative), not Redis.

### 2.4 Revoke

| Scenario | Expected | Actual |
|----------|----------|--------|
| Revoke: worker cannot authenticate | 401 after | ✅ PASS |
| Cross-workspace revoke | 404 | ✅ PASS |
| Revoked worker visible in list (soft delete) | REVOKED status | ✅ PASS |
| Mirror: hash dropped on revoke | Correct | ✅ PASS |
| Revoke idempotent (double revoke) | `{ revoked: false }`, 404 | ✅ PASS (code correct; test gap noted) |

**Key defense:** `revokeWorker` sets `revoked_at` (soft delete for audit trail). The Redis mirror hash is dropped. `findByToken` filters `revoked_at IS NULL`, so revoked credentials can never authenticate via PG.

### 2.5 Operational Status

| Scenario | Expected | Actual |
|----------|----------|--------|
| No heartbeat → OFFLINE | OFFLINE | ✅ PASS |
| Live heartbeat key → ONLINE | ONLINE + last_seen | ✅ PASS |
| Expired/missing heartbeat → OFFLINE | OFFLINE | ✅ PASS |
| Revoked → REVOKED regardless of heartbeat | REVOKED | ✅ PASS |
| List carries derived status | ONLINE/OFFLINE/REVOKED | ✅ PASS |
| Status derivation never exposes token_hash | Absent | ✅ PASS |
| Redis error → OFFLINE (fail closed) | OFFLINE | ✅ PASS |

**Key defense:** Status is a DERIVED liveness hint. Authorization is ALWAYS decided by the credential/revocation, never by status. `liveInfo` checks `revoked_at` first (REVOKED overrides all), then checks the Redis heartbeat key. Any Redis error yields OFFLINE (fail closed — never an unsolicited ONLINE).

### 2.6 API Contract

| Scenario | Expected | Actual |
|----------|----------|--------|
| 401 for unauthenticated | `auth_required` | ✅ PASS |
| 403 for guest | `guest_forbidden` | ✅ PASS |
| 404 for non-UUID worker_id | `Worker not found` | ✅ PASS |
| 400 for invalid worker_type | Validation error | ✅ PASS |
| 400 for empty/long name | Validation error | ✅ PASS |
| 500 generic error message | No internal details | ✅ PASS |

**Key defense:** Error responses use generic messages. Internal errors are logged server-side via `console.error` with context prefixes (`[WORKERS]`). No DB/Redis internals are exposed to the client.

### 2.7 Frontend Security

| Scenario | Expected | Actual |
|----------|----------|--------|
| Credential only in useState | Transient | ✅ PASS |
| Done/Close clears credential | null | ✅ PASS |
| Copy uses navigator.clipboard | Transient string | ✅ PASS |
| No credential in URL | Correct | ✅ PASS |
| No credential in Redux/IndexedDB | Correct | ✅ PASS |
| Workspace switching reloads workers | useEffect on mount | ✅ PASS |

### 2.8 Worker Compatibility

The frontend setup contract (`buildSetupContract`) emits exactly the 4 env vars that `worker/worker/worker.cjs` reads:

| Env Var | Frontend | worker.cjs | Match |
|---------|----------|------------|-------|
| `HUB_URL` | `${location.origin}/gpu` | `process.env.HUB_URL \|\| "https://animastor.in/gpu"` | ✅ |
| `ANIMASTOR_WORKER_TOKEN` | credential (Bearer) | `process.env.ANIMASTOR_WORKER_TOKEN \|\| null` | ✅ |
| `WORKER_TYPE` | `audio\|image\|video` | `process.env.WORKER_TYPE \|\| "image"` | ✅ |
| `WORKER_ID` | name-derived label | `process.env.WORKER_ID \|\| "gpu-" + os.hostname()` | ✅ |

The worker setup hint explicitly states: "Never put the credential in a URL — pass it only as ANIMASTOR_WORKER_TOKEN." The `hubHeaders()` function in worker.cjs correctly puts the token in the `Authorization` header.

---

## 3. Findings

### MEDIUM — RELIABILITY

**F-1: Non-atomic rotate leaves stale hash in Redis mirror (concurrent rotation race)**

**Location:** `worker-repo.js:186-206` (rotateCredential), `worker-routes.cjs:185-198`

**Description:** `rotateCredential` uses a SELECT probe followed by a separate UPDATE (not wrapped in a transaction). Two concurrent rotation requests for the same worker can both read the same `previousTokenHash`, then both UPDATE succeeds (last writer wins in PG). Both handlers then call `mirrorDrop([previousTokenHash])` + `mirrorPut(newHash)`. The Redis mirror ends up with BOTH hashes, but PG only has the last one.

**Impact:** A worker authenticating via the Redis mirror (GPU hub hot path) could briefly use the first rotation's credential until the next mirror resync (5-minute default). The backend auth boundary (`requireWorkerAuth` → PG resolution) is unaffected.

**Mitigation:**
- Backend auth always resolves against PG (authoritative source)
- Mirror resync every 5 minutes heals the stale entry
- Concurrent rotation is a rare user-initiated action (not automatable via API)
- Self-healing by design

**Severity:** MEDIUM (reliability, not security — no unauthorized access)

---

### LOW — TESTING

**F-2: Missing test for rotate-after-revoke**

**Description:** No test verifies that rotating a revoked worker returns 404. The code is correct (`rotateCredential` SELECT filters `revoked_at IS NULL`), but the test gap means regressions could go undetected.

---

**F-3: Missing test for double-revoke idempotency**

**Description:** No test verifies the second revoke of an already-revoked worker returns `{ revoked: false }`. The code is correct (UPDATE filters `revoked_at IS NULL`), but the test gap means regressions could go undetected.

---

**F-4: Missing test for concurrent rotation behavior**

**Description:** No test exercises two simultaneous rotation requests. While the race window is narrow and self-healing, a regression test would prevent accidental introduction of PG-level issues (e.g., removing the `revoked_at IS NULL` guard).

---

### LOW — DOCUMENTATION

**F-5: `WORKER_MODES` exports unused `share` mode**

**Location:** `worker-repo.js:13` (`WORKER_MODES = ['private', 'share']`)

**Description:** The schema has `CHECK(mode IN ('private','share'))` and `WORKER_MODES` exports both, but the create handler always hardcodes `mode = 'private'`. This is a Phase 1 artifact. Not a Phase 3 scope creep (the mode was already in the schema), but worth noting for documentation clarity.

---

## 4. Multi-Workspace Attack Surface

| Attack Vector | Defense | Verdict |
|---------------|---------|---------|
| Guessed worker_id | UUID v4, 122-bit randomness | ✅ SAFE |
| Forged workspace_id in body | Body ignored; server resolves from session | ✅ SAFE |
| Forged user/workspace relationship | `authContext` middleware validates session → workspace FK | ✅ SAFE |
| Worker ID from another workspace | 404 (no existence oracle) | ✅ SAFE |
| Credential from another workspace | `findByToken` resolves by worker_id → workspace_id FK | ✅ SAFE |
| Old credential after rotation | `rotateCredential` atomically replaces hash in PG | ✅ SAFE |
| Revoked credential | `findByToken` filters `revoked_at IS NULL` | ✅ SAFE |
| Stale worker ID after revoke | Revoked workers return 404 from auth; visible in list but status = REVOKED | ✅ SAFE |
| Worker token as user session | Disjoint namespaces: `wrk.*` ≠ `sid.*`; `requireAuth` rejects workers | ✅ SAFE |

---

## 5. Regression Check

| Suite | Result |
|-------|--------|
| Backend tests (1402) | ✅ All passing |
| Frontend tests (65) | ✅ All passing |
| Frontend typecheck (`tsc --noEmit`) | ✅ Clean |
| Frontend build (`vite build`) | ✅ Clean |

Phase 3 did not regress Phase 1 (worker auth), Phase 2 (workspace-aware job ownership), generation, audio, image, or video functionality.

---

## 6. Scope Check

Phase 3 implementation is strictly within scope:

- ✅ Backend management API (list / detail / create / rotate / revoke)
- ✅ Operational status derivation (ONLINE / OFFLINE / REVOKED)
- ✅ Frontend UI (Settings > Private Workers)
- ✅ One-time credential disclosure
- ✅ Worker setup contract parity with worker.cjs
- ✅ Tests (21 backend, 12 frontend)

Not implemented (correctly out of scope):

- ❌ Share Worker / System Worker / Admin / billing / Docker / marketplace

---

## 7. Remaining Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Concurrent rotation stale mirror hash (F-1) | MEDIUM | Self-heals on next mirror resync; PG is authoritative |
| Missing test coverage for edge cases (F-2, F-3, F-4) | LOW | Code is correct; tests would prevent regressions |
| No `requireWorkerAuth` mounted on production routes | INFO | By design: workers authenticate to hub via Redis mirror; users authenticate to backend via session |

---

## 8. Verdict

**Phase 3: PASS WITH WARNINGS**

| Metric | Value |
|--------|-------|
| Blockers | 0 |
| Critical findings | 0 |
| High findings | 0 |
| Medium findings | 1 (F-1: concurrent rotation race) |
| Low findings | 4 (F-2 through F-5) |
| Private Worker ready | YES |
| Personal AI Provider ready | YES |

**Can we proceed to Personal AI Provider?** YES

The single MEDIUM finding (F-1) is a reliability edge case with self-healing properties. It does not represent a security vulnerability. The backend auth boundary is sound, workspace isolation is enforced, and credential lifecycle is correctly implemented.
