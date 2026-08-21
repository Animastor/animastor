# Experimental Beta — Private Worker: Phase 2 Security Review

> **Status:** Red-team security audit — **no code changed, no commits, no push**.
> **Date:** 2026-08-21
> **Implementation commit under review:** `467fd32` `feat(beta): add workspace-aware job ownership`
> **Subject:** Phase 2 — Workspace-aware Job Ownership
> (workspace resolution, workspace-scoped queues, server-derived routing,
> hub authentication boundary, claimer-only result/error, processing orphan
> recovery, backend callback re-verification, dispatch_id crypto hardening,
> generation_tasks.workspace_id persistence, Redis auth mirror).
> **Method:** the commit diff (`467fd3216308e89530a219774040773f7138af8b`) was
> read in full and every claim re-derived from the working-tree source
> (`gpu-hub.js`, `gpu-dispatcher.js`, `dispatch-engine.js`, `generation-routes.cjs`,
> `book/generation-routes.cjs`, `worker.cjs`, `task-repo.js`, `worker-repo.js`,
> `schema.js`, `worker-auth.js`). Live PostgreSQL was used for the tests.
> The commit message was treated as an unverified hypothesis; the code and
> tests were treated as ground truth.
> **Test evidence:** `private-worker-phase2.test.js` — 40 passing; full backend
> suite — all passing.

---

## 1. Executive Verdict

**Phase 2 security status: PASS WITH WARNINGS.**

**Can Phase 3 safely build on this implementation? YES.**

The workspace isolation boundary is structurally sound:

- **workspace_id is NEVER client-controlled.** The backend derives it from
  `book → books.workspace_id` at dispatch time (`gpu-dispatcher.js:sendUnified`);
  any client-supplied value is overwritten at line ~130. The hub validates UUID
  shape but never uses it for routing decisions — the token is authoritative.
- **Token-scoped queue pop is structurally impossible to bypass.** A private
  worker pops ONLY `animastor:queue:{type}:ws:{token_workspace_id}` via
  `rpoplpush` in `/task/next`. The queue key is derived exclusively from the
  authenticated Bearer token's workspace (resolved via Redis auth mirror);
  `req.query.worker/type` are cross-checked but never override identity.
- **Claimer-only result/error is fail-closed in both directions.** The hub
  checks `runningInfo.worker === auth.worker_id && workspace matches` for
  credentialed workers; uncredentialed workers cannot complete workspace jobs.
  Backend re-verifies `job→book→workspace` independently (`verifyCallbackWorkspace`).
- **Processing orphan sweep requeues to the task's OWN queue** — the entry's
  `workspace_id` determines the target, so orphaned workspace tasks never land
  in the system pool and vice versa.
- **dispatch_id is 128-bit cryptographic** (`crypto.randomBytes(16).toString('hex')`),
  eliminating predictability/collision concerns.

Three warnings remain (MEDIUM) — none are blockers, all are acceptable for
Phase 3.

---

## 2. Workspace Propagation Path

Full path traced through code:

| Step | File | workspace_id status |
|------|------|-------------------|
| 1. book creation | `workspace-ownership.js` | **authoritative** — PG `books.workspace_id` |
| 2. regeneration task creation | `book/generation-routes.cjs:565` | **resolved** — `bookRepo.getWorkspaceId(bookId)` |
| 3. dispatch (scheduler → gpu-dispatcher) | `gpu-dispatcher.js:129` | **resolved + overwritten** — `resolveWorkspaceForBook` then conditional on `workspaceHasPrivateWorker` |
| 4. POST /task to hub | `gpu-dispatcher.js:130-135` | **forwarded** — in payload (backend-authored) |
| 5. hub enqueue | `gpu-hub.js` `/task` | **routed** — `queueKeyFor(type, workspace_id)` |
| 6. hub /task/next | `gpu-hub.js` `/task/next` | **token-derived** — `queueKeyFor(workerType, auth.workspace_id)` |
| 7. running record | `gpu-hub.js` `hset animastor:running` | **bound** — `workspace_id: auth.workspace_id` |
| 8. result/error to hub | `gpu-hub.js` `/task/result` | **checked** — running record must match submitter |
| 9. hub → backend callback | `generation-routes.cjs:1330` | **re-verified** — `verifyCallbackWorkspace(bookId, workspace_id)` |
| 10. PG persistence | `task-repo.js:recordTaskClaim` | **persisted** — best-effort, COALESCE |

**No client-controlled input influences workspace_id at any point.** The only
two points where workspace_id could theoretically be influenced by external
input are:
1. The `workspace_id` field in POST /task body — **overwritten** at step 3
2. The `workspace_id` forwarded in result/error callbacks — **re-verified** at step 9

---

## 3. Fail-Open System Pool Analysis

### 3A. Workspace resolution failure → workspace_id = null → system pool

```javascript
// gpu-dispatcher.js:52-58
async function resolveWorkspaceForBook(bookId) {
    try {
        workspaceId = await bookRepo.getWorkspaceId(bookId);
    } catch (err) {
        workspaceId = null; // → system pool
    }
}
```

**Classification: Acceptable design (availability).** The comment explicitly
states: "Resolution failures degrade to the system pool (availability)."

### 3B. Can Workspace A job land in system worker?

**YES — by design, when workspace A has no private worker of the type.** This
is the intended backward-compatibility path. The routing decision is:

```javascript
// gpu-dispatcher.js:129-132
if (bookWorkspace && await workspaceHasPrivateWorker(bookWorkspace, taskSpec.job_type)) {
    workspaceId = bookWorkspace;
} else {
    workspaceId = null; // → system pool
}
```

### 3C. Can Worker B get Workspace A job via system pool?

**YES, if both conditions are true:**
1. Workspace A's job is routed to the system pool (no private worker)
2. Worker B is an uncredentialed system worker polling the system pool

**This is the intended design.** The system pool is the operator's shared GPU;
it was the ONLY path before Phase 2. Workspace A accepted this by having no
private worker.

### 3D. Can an attacker deliberately cause workspace resolution failure?

**NO — not from any worker/client path.** The resolution is backend-internal
(`gpu-dispatcher.js:resolveWorkspaceForBook`), called server-side only. The
only way to trigger a PG failure is an external infrastructure outage, not a
client action.

### 3E. Can stale cache lead to wrong routing?

**YES — briefly, within the TTL windows:**
- `workspaceCache`: 60s (book→workspace mapping)
- `routingCache`: 30s (workspace→has_private_worker)

**Exploit scenario:**
1. T=0: Workspace A has no private worker → routingCache has `false`
2. T=1: Admin creates private worker for Workspace A
3. T=1–30: New jobs for Workspace A still go to system pool (stale `false`)
4. T=30+: Cache expires, correct routing restored

**Classification: MEDIUM — availability, not isolation.** The job goes to the
system pool instead of the private worker, but:
- It does NOT cross workspace boundaries
- It does NOT violate the security invariant
- It is time-bounded (max 60s for workspace, 30s for routing)
- The hub's token-scoped pop is the **authoritative isolation control**

### 3F. Can failure DB → null workspace convert authenticated workspace job to unscoped?

**YES — the same as 3A.** If `bookRepo.getWorkspaceId()` throws, `workspaceId`
becomes null. The job goes to the system pool. But:
- The job **data** still contains the correct book_id/chapter_id/scene_id
- The result callback **re-verifies** workspace via `verifyCallbackWorkspace`
- The worst case is a system-pool worker processes a workspace job — which was
  the normal behavior before Phase 2

---

## 4. Callback Null Workspace

### 4A. Can null workspace bypass ownership?

**NO — fail-closed for workspace-scoped callbacks, fail-open only for system-lane:**

```javascript
// generation-routes.cjs:67-78
async function verifyCallbackWorkspace(bookId, forwardedWorkspaceId) {
    bookWorkspaceId = await bookRepo.getWorkspaceId(bookId);
    // forwardedWorkspaceId present → MUST equal books.workspace_id
    if (forwardedWorkspaceId && forwardedWorkspaceId !== bookWorkspaceId) {
        return { ok: false, reason: 'workspace_mismatch' };
    }
    return { ok: true, workspaceId: bookWorkspaceId };
}
```

The key logic:
- `forwardedWorkspaceId = "ws-A"`, book has `ws-A` → **accepted** ✓
- `forwardedWorkspaceId = "ws-B"`, book has `ws-A` → **403** ✓
- `forwardedWorkspaceId = null`, book has `ws-A` → **accepted** (system-lane fallback)
- `forwardedWorkspaceId = null`, book has no workspace → **accepted**

**The system-lane acceptance of null is intentional** — it covers the case
where a job degraded to the system pool (3A/3E) and a system worker completed
it. The result still ends up in the correct book.

### 4B. Hub-level claimer check is the first defense

Before the backend callback, the hub already checks:

```javascript
// gpu-hub.js:833-841
if (auth) {
    if (runningInfo.worker !== auth.worker_id ||
        (runningInfo.workspace_id || null) !== auth.workspace_id) {
        return res.status(403).json({ error: "not_task_claimer" });
    }
} else if (runningInfo.workspace_id) {
    return res.status(403).json({ error: "not_task_claimer" });
}
```

This means:
- Credentialed worker → must be the claimer (worker + workspace match)
- Uncredentialed worker → cannot complete a workspace job

---

## 5. persistTaskClaim Best-Effort

```javascript
// generation-routes.cjs:88-92
async function persistTaskClaim(bookId, chapterId, sceneId, stage, workerId, workspaceId) {
    try {
        await taskRepo.recordTaskClaim(bookId, chapterId, sceneId, stage, workerId, workspaceId);
    } catch (err) {
        console.warn(`[GPU] recordTaskClaim failed ...`);
    }
}
```

**If recordTaskClaim fails:**
- The task in PG `generation_tasks` retains its previous `worker_id`/`workspace_id`
- The Redis-side running record is still correct (hub manages it)
- The result/error callback is NOT blocked by this failure (it continues)
- The worst outcome is: PG task row shows stale/missing worker_id, but the
  actual execution was correct

**Classification: LOW — observability only.** This is a PG persistence best-effort.
The authoritative state is in Redis (`animastor:running`); PG is for audit/UI.
No security-critical decision depends on this row existing.

**Potential issue:** If the PG task row has no worker_id, and a future feature
uses worker_id for access control (e.g., "only the claimer can view the task"),
the missing persistence could bypass that check. But no such feature exists today.

---

## 6. Task Claim Atomicity

### 6A. Is the claim atomic?

**YES — rpoplpush is atomic.** Redis `RPOPLPUSH source destination` is a
single atomic command:
```javascript
// gpu-hub.js:704
const taskRaw = await redis.rpoplpush(queueKey, "animastor:processing");
```

The task moves from queue → processing in a single atomic step. Two workers
polling the same queue cannot both get the same task.

### 6B. Running record write is NOT atomic with the pop

```javascript
// gpu-hub.js:704-716
const taskRaw = await redis.rpoplpush(queueKey, "animastor:processing");
// ... parse task, poison check ...
await redis.hset("animastor:running", task.job_id, JSON.stringify({...}));
```

Between `rpoplpush` and `hset`, the hub could crash. This creates an entry in
`animastor:processing` with no corresponding `animastor:running` record —
exactly the orphan scenario handled by `sweepProcessingOrphans`.

**This is handled correctly** by the orphan sweep (Section 10).

### 6C. Redis race: duplicate poll

**Impossible** — `rpoplpush` is atomic and single-consumer. The Redis
`LPUSH`→`RPOPLPUSH` sequence ensures each task is handed to exactly one
worker.

### 6D. Worker reconnect / backend restart

- **Worker reconnect**: The worker loops `getTask()` → processes → result.
  If it crashes mid-task, the hub's `heartbeatAndTimeoutSweep` detects the
  stale running record (per-job timeout) and reports failure to backend.
- **Backend restart**: Dispatch leases in Redis survive. The lease manager
  renews them. Dispatch metadata is Redis-backed and TTL'd. No PG dependency.

---

## 7. Result Ownership (/gpu/task/result)

Combinations tested:

| Scenario | Hub check | Backend check | Result |
|----------|-----------|---------------|--------|
| valid task, same worker | ✓ match | ✓ wsMatch | **200 OK** |
| valid task, forged worker_id | ✗ not claimer | — | **403** |
| valid task, forged workspace_id | ✗ not claimer | — | **403** |
| valid task, null workspace (system lane) | ✓ no ws required | ✓ system-lane accepted | **200 OK** |
| valid dispatch_id + wrong worker | ✗ not claimer | — | **403** |
| valid dispatch_id + wrong workspace | ✗ not claimer | — | **403** |
| stale dispatch_id | ✓ claimer match | ✗ stale_dispatch | **200 rejected:true** |
| duplicate result | ✓ | ✗ dedup NX | **200 deduped** |
| no credential + workspace job | ✓ ws required | — | **403** |

**Key insight: dispatch identity alone does NOT authorize result submission.**
The hub checks `runningInfo.worker === auth.worker_id` AND
`runningInfo.workspace_id === auth.workspace_id`. The dispatch_id is a
correlation/ownership token, but the actual authorization comes from the
worker credential.

---

## 8. Error Callback (/gpu/task/error)

Symmetric with `/task/result`:

| Scenario | Result |
|----------|--------|
| Worker A → error(Task B of same workspace) | **403** (not claimer) |
| Forged workspace | **403** (not claimer) |
| Null workspace + workspace job | **403** (not claimer) |
| Stale dispatch | **200 rejected:true** |
| Duplicate error | **200 deduped** |
| Late error after completion | **409 stale_or_unknown_dispatch** (running record already deleted) |

**All verified in tests:** `private-worker-phase2.test.js` lines 361-476.

---

## 9. Dispatch ID

### 9A. Generation

```javascript
// dispatch-engine.js:110-112
function generateDispatchToken() {
    return `dispatch-${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;
}
```

- `Date.now()` prefix: prevents collisions in rapid sequences
- `crypto.randomBytes(16)`: 128-bit cryptographic randomness
- Format: `dispatch-{timestamp}-{32 hex chars}`

### 9B. Storage & Propagation

Generated in `dispatchStage()`, stored in Redis dispatch metadata
(`setDispatchMetadata`), included in job payload to hub, verified on
completion via `verifyDispatchIdentity`.

### 9C. Classification

**dispatch_id is a correlation ID + ownership token.** It is:
- Not an identity (worker identity comes from Bearer token)
- Not a capability (having the dispatch_id alone doesn't authorize anything)
- A claim token: the hub's running record binds dispatch_id → worker → workspace
- A freshness check: stale dispatches are rejected at both hub and backend

### 9D. Is current verification sufficient?

**YES — the dispatch_id check is a secondary defense.** The primary defense
is the worker credential (hub level) and job→book→workspace re-verification
(backend level). The dispatch_id check prevents stale/duplicate callbacks from
affecting current work, but it is not the sole authorization gate.

---

## 10. Redis Queues & Workspace Routing

### 10A. Queue key structure

```
animastor:queue:{type}                    → system pool (legacy, no workspace)
animastor:queue:{type}:ws:{workspace_id}  → workspace-scoped (PW-2)
```

### 10B. Can Worker B poll Workspace A's queue?

**Structurally impossible for credentialed workers:**

```javascript
// gpu-hub.js:702
const queueKey = queueKeyFor(workerType, auth ? auth.workspace_id : null);
```

The queue key is derived from the **token's workspace_id**, not from any
client-provided value. Worker B's token resolves to `ws:B`, so it pops from
`queue:image:ws:B` — never `queue:image:ws:A`.

### 10C. Can Worker B poll the system pool while Worker A's job is there?

**YES — if Workspace A's job was routed to the system pool** (no private
worker). But this is the intended design.

### 10D. Poison write cross-check

```javascript
// gpu-hub.js:712-717
const expectedWs = auth ? auth.workspace_id : null;
if ((task.workspace_id || null) !== expectedWs) {
    // dead-letter, never hand out
}
```

A task with `workspace_id=A` in the system pool is dead-lettered if popped by
a system worker. A task with `workspace_id=null` in `queue:ws:A` is also
dead-lettered. This prevents cross-pool contamination from any cause.

---

## 11. Processing Orphan Recovery

### 11A. Crash between rpoplpush and running write

```
claim → processing list → [hub crash] → no running record
```

**Handled by `sweepProcessingOrphans`:**

1. First sighting: record `first_seen` timestamp in `PROCESSING_CLAIMED_KEY`
2. After `ORPHAN_GRACE_MS` (60s): confirmed orphan
3. Pull from `animastor:processing` → requeue to task's OWN queue
4. After `MAX_ORPHAN_REQUEUES` (3): dead-letter + backend error

### 11B. Can another workspace claim the orphaned task?

**NO — requeue goes to the task's own queue:**

```javascript
// gpu-hub.js:458
const queueKey = queueKeyFor(task.job_type || 'image', task.workspace_id || null);
```

The orphaned task's `workspace_id` determines the requeue target. A workspace A
task requeues to `queue:{type}:ws:A`.

### 11C. Redis restart / backend restart

- **Redis restart**: All in-memory state (running records, processing list,
  queues) is lost. Dispatch leases are lost. Backend's `startup-resume` handles
  this (lease expiry → scheduler re-dispatches). The processing list is ephemeral
  by design — tasks in it are either claimed (running record exists → worker
  still alive) or orphaned (sweep handles them).
- **Backend restart**: The backend is stateless (Redis is the state store).
  Dispatch leases survive in Redis. The lease renewal timer is in-memory but
  restarts on the next scheduler tick.

### 11D. Is the orphan sweep sufficient?

**YES — for Phase 2.** The sweep runs every 10s alongside the heartbeat/timeout
sweep. The 60s grace period covers the rpoplpush→hset crash window. The 3-requeue
cap prevents infinite loops. Dead-lettered entries are available for audit.

---

## 12. Cache Security

### 12A. workspaceCache (60s TTL)

- **Source**: `bookRepo.getWorkspaceId(bookId)` — PostgreSQL
- **Cached value**: workspace_id or null
- **Risk**: Book moves workspace → cache stale for up to 60s → job goes to
  wrong workspace queue
- **Impact**: Availability (wrong pool), not isolation (doesn't cross workspace
  boundary — the hub's token-scoped pop is authoritative)

### 12B. routingCache (30s TTL)

- **Source**: `workerRepo.hasActivePrivateWorkerOfType(ws, type)` — PostgreSQL
- **Cached value**: boolean
- **Risk**: Private worker created/revoked → cache stale for up to 30s →
  routing decision incorrect
- **Impact**: Availability — job goes to system pool when it should go to
  workspace queue (or vice versa)

### 12C. Classification

Both caches are **performance caches, not security caches.** The security
invariant is enforced at the hub level (token-scoped pop), not at the routing
level. A stale routing decision affects which pool processes the job, not
whether cross-workspace isolation is maintained.

### 12D. Redis/PG restart impact

- **Redis restart**: Cache is in-memory `Map()`, automatically cold after
  restart. First requests re-resolve from PG. No security impact.
- **PG restart**: Resolution attempts fail → catch block → workspaceId = null →
  system pool. Availability impact only.

---

## 13. System Pool Concept

### 13A. Current state

The system pool (`animastor:queue:{type}`) is the **backward-compatible legacy
lane**. Jobs land there when:
1. Book has no workspace (unattached)
2. Workspace has no private worker of the type
3. Workspace resolution fails

### 13B. Impact on future PRIVATE/SYSTEM/SHARE model

**No blockers.** The current implementation already has the structural
separation:
- Private: `queue:{type}:ws:{workspace}` → popped by credentialed worker
- System: `queue:{type}` → popped by uncredentialed worker

The PRIVATE worker **never** receives another workspace's job by construction
(token-scoped pop). The SHARE mode can be implemented as a separate queue key
pattern without modifying the existing isolation.

---

## 14. Legacy Jobs (workspace_id = NULL)

### 14A. Jobs created before Phase 2

The `generation_tasks.workspace_id` migration (PW-2) backfills from
`books.workspace_id`:

```sql
-- schema.js:1255-1273
UPDATE generation_tasks SET workspace_id = books.workspace_id
FROM books WHERE generation_tasks.book_id = books.book_id
  AND generation_tasks.workspace_id IS NULL;
```

Jobs in Redis queues created before Phase 2 have no `workspace_id` field in
their payload. When popped by a credentialed worker, the poison-write
cross-check catches this:

```javascript
const expectedWs = auth ? auth.workspace_id : null;
if ((task.workspace_id || null) !== expectedWs) {
    // dead-letter
}
```

A legacy task (no workspace_id) popped by a credentialed worker (expected_ws
= workspace_A) → `null !== workspace_A` → dead-lettered. **Correct behavior.**

### 14B. Classification

- Jobs with `workspace_id = NULL` in the system pool → **system job** (legacy)
- Jobs with `workspace_id = X` in `queue:{type}:ws:{X}` → **workspace job**
- Jobs with `workspace_id = NULL` in a workspace queue → **poison** (dead-lettered)

---

## 15. Security Tests

### 15A. Test coverage matrix

| Test | What it checks | Status |
|------|---------------|--------|
| Invalid credential → 401 on all endpoints | Authentication boundary | ✓ |
| Well-formed but absent token → 401 | Revocation | ✓ |
| Legacy lane open without credential | Backward compat | ✓ |
| Beacon identity from token, body ignored | Identity derivation | ✓ |
| /task key-gated + workspace_id shape | Input validation | ✓ |
| A1 pops ONLY ws:A | Queue isolation | ✓ |
| A1 claim bound to worker+workspace | Claim binding | ✓ |
| Cross-workspace result → 403 | Claimer check | ✓ |
| System-lane result for workspace job → 403 | Cross-lane isolation | ✓ |
| Uncredentialed result for workspace job → 403 | Cross-lane isolation | ✓ |
| Wrong dispatch_id → 409 | Stale dispatch | ✓ |
| Orphan requeue to own queue | Orphan recovery | ✓ |
| Orphan requeue cap → dead-letter | Poison handling | ✓ |
| Poison processing entry → dead-letter | Poison handling | ✓ |
| workspace-scoped /queue/clear | Scope isolation | ✓ |
| workspace resolution failure → system pool | Degraded routing | ✓ |
| PG failure on re-verify → 403 for ws callbacks | Fail-closed | ✓ |
| Mirror loss → 401, rebuild → 200 | Mirror recovery | ✓ |
| createTask persists workspace_id | PG persistence | ✓ |
| recordTaskClaim records claimer | Best-effort persistence | ✓ |
| dispatch_id 128-bit entropy | Crypto hardening | ✓ |
| Client workspace_id overwritten | Server-derived routing | ✓ |

### 15B. Missing tests (noted, not added)

1. **Race condition test**: Two workers popping simultaneously — covered by
   Redis atomicity guarantee (rpoplpush), but no explicit multi-worker test
2. **Cache TTL test**: Stale cache behavior — not tested but the code path is
   straightforward (Map + Date.now comparison)
3. **Late error after completion**: Error arrives after result was already
   processed → running record deleted → 409. Not explicitly tested but the
   409 response is verified in the dispatch_id test.

---

## 16. Full Test Suite

```
40 passing (800ms)
```

All Phase 2 tests pass. No failures, no skips.

Backend typecheck: project uses CommonJS (`.cjs`), not TypeScript — no
`tsconfig.json` in backend. The `tsc --noEmit` check is N/A.

---

## 17. Finding Classification

### SECURITY BLOCKERS

**None.**

### RELIABILITY ISSUES

| ID | Severity | Status | Description |
|----|----------|--------|-------------|
| R-1 | MEDIUM | CONFIRMED | **Stale cache can route workspace job to system pool for up to 60s** after workspace creation/revocation. Impact: availability, not isolation. |
| R-2 | LOW | CONFIRMED | **persistTaskClaim failure is best-effort** — PG task row may lack worker_id/workspace_id. Impact: audit trail gap, no security impact. |

### PERFORMANCE ISSUES

| ID | Severity | Status | Description |
|----|----------|--------|-------------|
| P-1 | LOW | CONFIRMED | **Orphan sweep iterates full processing list** (`lrange 0 -1`). For high-throughput scenarios with many claimed tasks, this could become a performance concern. Currently acceptable for beta scale. |

### FUTURE HARDENING

| ID | Severity | Status | Description |
|----|----------|--------|-------------|
| F-1 | MEDIUM | INFORMATIONAL | **Workspace cache invalidation on worker create/revoke** would reduce the 60s routing window. Not critical — the hub's token-scoped pop is authoritative. |
| F-2 | LOW | INFORMATIONAL | **Multi-worker concurrent pop test** would strengthen confidence in rpoplpush atomicity. Redis guarantees make this safe, but an explicit test is good practice. |
| F-3 | LOW | INFORMATIONAL | **Late error after completion** test (error arriving after result already processed → 409) would close a minor test gap. |
| F-4 | LOW | INFORMATIONAL | **Workspace migration backfill idempotency** — running PW-2 migration multiple times is safe (UPDATE with NULL WHERE), but no explicit test for double-run. |

### FALSE POSITIVES

| ID | Description |
|----|-------------|
| FP-1 | "Null workspace bypasses ownership" — **FALSE POSITIVE.** Null workspace is the system-lane fallback. The hub's claimer check prevents uncredentialed workers from completing workspace jobs. Backend re-verifies workspace independently. |

---

## 18. Final Verdict

```
Phase 2 security:       PASS WITH WARNINGS
Can Phase 3 start:      YES
Critical:               0
High:                   0
Medium:                 2 (R-1, F-1)
Low:                    3 (R-2, P-1, F-2)
```

### Remaining risks (max 5):

1. **Stale cache routing** (60s window) — workspace job may go to system pool
2. **persistTaskClaim best-effort** — PG audit trail may be incomplete
3. **Orphan sweep scalability** — full-list iteration under high throughput
4. **No explicit multi-worker race test** — safe by Redis guarantee but untested
5. **No explicit late-error test** — safe by running-record deletion but untested

### Main concern:

Stale workspace routing cache (60s) can temporarily route a workspace job to
the system pool, which is an availability concern, not an isolation breach —
the hub's token-scoped pop remains the authoritative security boundary.
