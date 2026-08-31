# Worker Sharing Model — Design Document (v2)

> 2026-08-31 · Revision 2 — clarified & simplified before implementation.
> Research / design only — **no production code or database changes**.
> Companion to `shared-workers-feature-report.md` (minimum shared-worker
> visibility change; separate feature).
>
> **Reading guide.** This document strictly separates two layers:
> - **CURRENT IMPLEMENTATION** — facts about the code as it exists today
>   (verified against files; nothing proposed).
> - **PROPOSED FUTURE MODEL** — design intent. Tables, endpoints and queues
>   in those sections **do not exist yet** and must not be assumed to exist.

---

## 1. The Three-Mode Model (clarified)

The three modes are **three different ownership/governance models**, not
variants of one generic "shared worker" concept. They must not be collapsed.

| Mode | Owner | Governance | Available to | Mutated by |
|---|---|---|---|---|
| `private` | user's workspace | the owner's will | the owner only (workspace queue) | the owner |
| `share` | user's workspace (ownership never transfers) | the owner's will, expressed as a **contribution** to the community pool | the shared/community pool | the owner (contribute/stop) |
| `system` | **Animastor / platform** — no user owner | **Animastor's policy** (platform rules, operator capacity planning) | the community pool per platform rules | administrators only (`requireAdmin`) |

### 1.1 Why "system" and "share" are different concepts

| Question | `system` | `share` |
|---|---|---|
| Whose hardware/money runs it? | Animastor / cloud | an individual user |
| Who decides availability? | Platform policy (admin) | The owning user |
| Who answers for abuse/quality? | Animastor | The owner (can stop anytime) |
| Can a user ever manage it? | Never | Only if they own it |
| Workspace_id | NULL (enforced by `workers_scope_check`) | Always set |

Both end up serving the same community **queue lane**, but that is a
routing detail — not a governance relationship. A consumer of a `share`
worker has **no** authority over it; they are routed to it by the
dispatcher, never by editing it. A consumer of a `system` worker likewise
has no authority — but for the opposite reason: it is nobody's user-owned
resource to begin with.

### 1.2 Invariants to preserve forever

1. **Ownership never transfers** — sharing (either kind) never re-parents
   a worker. `workers.workspace_id` is immutable for the worker's life.
2. **Mode is the ownership story** — `private`/`share`/`system` remain the
   only three values. No fourth mode, no generic "shared" alias.
3. **Consumers are not stakeholders** — no consumer ever gains write
   authority on a worker row or its policies.
4. **Fail-closed identity** — worker identity always comes from the
   credential, never from request fields.

---

## 2. CURRENT IMPLEMENTATION (facts)

What exists in the codebase today regarding `share`.

### 2.1 Registration

- `POST /api/v1/workers` accepts `mode: 'share'` with explicit
  `confirm_share: true` (`worker-routes.cjs:158-173`). workspace_id is
  server-resolved; cross-workspace registration is impossible.
- `workers.mode CHECK ('private','share','system')` and
  `workers_scope_check` (`mode='system' OR workspace_id IS NOT NULL`)
  already exist (`schema.js:1283,1293`).
- Credentials (`wrk.*` tokens), auth mirror and rotation are identical
  for all three modes.

### 2.2 Visibility / heartbeat

- `worker-health.isSystemScope` (`worker-health.js:99`) counts `system`
  **and** `share` heartbeats as global capacity. `isPrivateScopeOf`
  matches only `mode='private'` — a share worker is never private, not
  even for its owner.
- `/api/v1/worker/counts` reports the global pool (`audio/image/video`)
  and the caller's own `private_*` separately.

### 2.3 Dispatch / queues

- The backend dispatcher (`gpu-dispatcher.js:128`) stamps a job with
  `workspace_id` only when the book's workspace has an active **private**
  worker of the type (`hasActivePrivateWorkerOfType`, `worker-repo.js:200`,
  queries `mode='private'`). Otherwise the job goes to the system pool.
- The hub pop (`gpu-hub.js:754`) is mode-driven:
  `private → queue:{type}:ws:{ws}`; `share`/`system → queue:{type}`
  (system pool). Poison-write cross-check rejects scope mismatches
  (dead-letter).

### 2.4 What this means today

- A user **can** create a permanent `mode='share'` worker (community
  contribution, until revoke).
- A user **cannot** temporarily share, scope sharing to anyone, or share
  a `private` worker while keeping its private lane — the only way to
  change availability is revoke + recreate.
- The frontends are share-blind: the Setup wizard never offers `share`,
  `WorkerMode` in `privateWorkers.ts:14` is `'private' | 'share'`
  (no `'system'`), and Settings has no sharing controls. Counts lump
  share+system into one global bucket.

### 2.5 Hard-coded assumptions (must be preserved or consciously revised)

| Location | Assumption | Future model |
|---|---|---|
| `worker-routes.cjs:158` | `mode` fixed at create; no flip endpoint | Preserve — sharing becomes a **policy**, not a mode flip |
| `worker-repo.js:200` | workspace routing checks `mode='private'` only | Preserve — share never creates a private lane |
| `worker-health.js:99` | share+system = global bucket | Extend consciously (see §7.4) |
| `gpu-hub.js:754` | pop = private→ws, else system pool | Extend: private **with active public policy** also pops system pool |
| `gpu-dispatcher.js:128` | dispatch ignores share workers | **Unchanged in V1** (see §7) |

---

## 3. PROPOSED — Architectural Decision: mode stays; sharing is a policy

> **Decision (the core of this revision):**
> **A `private` worker may have an active `share_policy` without changing
> its `mode`.**

The worker remains owned by the user's workspace and keeps serving the
owner's private workload, while **additionally** exposing available
capacity to other users according to the policy.

```
private worker
    │
    ├── owner's private workload        (always; never taken away)
    │
    └── active share_policy             (voluntary, time-bounded)
          ├── public                    (V1)
          └── specific users            (V2)
```

### 3.1 Two different things: `mode` vs `share_policy`

| | `mode` | `share_policy` |
|---|---|---|
| Answers | *Who owns this resource and which lane is theirs?* | *Who else may consume spare capacity, until when?* |
| Nature | Ownership / resource lane | Access & capacity exposure |
| Values | `private` \| `share` \| `system` | A separate record with scope + lifetime |
| Changes | Only via revoke + recreate (ownership event) | Anytime by the owner (availability event) |
| Transfers ownership? | Never | Never |

A share policy is **not** an ownership transfer, not a lease, not a
delegation of control. It is the owner saying: "spare capacity on my
worker may serve X until T."

### 3.2 When to use permanent `mode='share'` vs a policy on a `private` worker

| Situation | Use |
|---|---|
| "I dedicate this machine to the Animastor community" — long-lived, no private lane needed | **`mode='share'`** (existing behavior) |
| "I normally use this machine myself, but occasionally contribute spare capacity" | **`private` + share_policy** |
| "Share only for 2 hours / while I'm away" | **`private` + share_policy(expires_at)** |
| "Share only with my friend" (V2) | **`private` + share_policy(users=[friend])** |
| "Share, but keep my own jobs prioritized" | **`private` + share_policy** (lane priority is inherent, §6) |

Rule of thumb: **`mode='share'` = the worker's lane IS the community
pool. A policy = the worker's lane stays private, and the community pool
may borrow spare capacity.** A `mode='share'` worker has no private lane
at all (current, unchanged).

---

## 4. Intended User Scenarios

The design must support these **without ownership transfer**:

| # | Scenario (user's words) | Mechanism | Version |
|---|---|---|---|
| A | «I use my Worker myself.» | `private`, no policy (today's default) | exists |
| B | «I am not using my GPU for the next 2 hours, so I share it with everyone for 2 hours.» | `private` + public policy, `expires_at = now+2h`; auto-return to private-only | **V1** |
| C | «I continue using my Worker, but allow other users to consume available capacity.» | `private` + public policy, no expiry ("until stopped"); owner's lane keeps priority | **V1** |
| D | «My friend needs GPU capacity, so I share my Worker with that specific user.» | `private` + policy scoped to a user allowlist | **V2** |
| E | «I permanently contribute this Worker to the Animastor shared pool.» | `mode='share'` (existing) — or equivalently a public policy with no expiry | exists |

Notes:

- B and C are the **same mechanism** with different `expires_at`
  (`expires_at = NULL` means "until I stop it"). UI presets: 1 hour,
  4 hours, until stopped.
- C is "share **available** capacity": the owner's jobs always win
  (§6). No capacity reservation exists in V1.
- D is deliberately **out of V1** (see §5, §10).

---

## 5. PROPOSED — Data Model (simplified for V1)

> Schema sketch for design only — **do not deploy**. Deliberately
> minimal; extensibility comes from a clear seam, not from pre-built
> tables for hypothetical features.

### 5.1 V1-required: `share_policies` (the only new table)

```sql
CREATE TABLE share_policies (
  policy_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id    UUID NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_kind   TEXT NOT NULL CHECK (scope_kind IN ('public')),  -- V1: public only; V2 widens to ('public','users')
  starts_at    BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint * 1000),
  expires_at   BIGINT,          -- NULL = "until manually stopped"
  revoked_at   BIGINT,          -- soft revoke / auto-expiry marker
  note         TEXT,
  created_by   UUID REFERENCES users(user_id),
  created_at   BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint * 1000)
);
CREATE UNIQUE INDEX idx_share_policies_one_active
  ON share_policies(worker_id) WHERE revoked_at IS NULL;
```

- `scope_kind CHECK ('public')` — V1 intentionally supports only public.
  V2 widens the CHECK to add `'users'`; that is a one-line migration, not
  a redesign.
- The partial UNIQUE index enforces **one active policy per worker** —
  the largest simplification vs. revision 1 (which allowed N). One
  policy per worker removes all dispatch ambiguity for V1.
- `workspace_id` is denormalized from the worker row for the same
  workspace-scoped SQL guard used everywhere else
  (`WHERE workspace_id = $2`).
- **No quota fields in V1** (`max_concurrent`, `max_jobs_total`,
  `max_minutes_cpu` are dropped from revision 1 — V1 has no quotas;
  "available capacity" is enforced by lane priority, not by counters).

### 5.2 Explicitly NOT in V1 (future concepts)

| Component | Verdict | Why / when it returns |
|---|---|---|
| `share_policy_grants` | **V2** | Only needed when scope `users` exists |
| groups / projects (tables, scope kinds) | **V3** | Needs a relationship model that does not exist; do not pre-create |
| `share_usage` ledger | **V3/V4** | Needed by dashboards/quotas (V3) and credits (V4); V1 has no consumption accounting |
| `share_audit` table | **V1: no** | V1 logs policy events through the existing backend log/journal pattern; a dedicated audit table is V3 infrastructure if ever needed |
| quotas / enforcement counters | **V3** | Not in V1 |
| credits / pricing / marketplace | **V4** | Not in V1 |
| `workers.has_active_share_policy` generated column | **dropped** | Compute on read (single indexed query); avoid premature schema complexity. Revisit only if pop-path profiling demands it |

Nothing in V1 touches the `workers` table. The schema change is exactly
**one new table**.

---

## 6. Owner Behavior (V1 semantics)

Explicit answers, then the recommended simple V1 model.

| Question | V1 answer |
|---|---|
| Can the owner keep using the worker while shared? | **Yes, always.** The private lane is never removed or paused by a policy. |
| "Share all capacity" or "share available capacity"? | **Available capacity.** The owner's lane has strict priority. |
| Worker already busy with owner's job when a consumer's job arrives? | The consumer's job waits in the system pool queue; it is claimed only when the worker is free **and** its private lane is empty. No preemption, ever. |
| Sharing starts while jobs are running? | Running jobs are unaffected. The policy affects only **future** dispatch/claims. |
| Owner stops sharing? | The worker simply stops claiming from the system pool (within one hub policy-cache TTL, ≤ ~30s). The owner's own queued/running jobs are untouched. |
| Consumer jobs already queued? | In V1 (public scope) queued jobs sit in the **shared system pool**, not in a per-worker queue — other pool workers serve them. No dead-lettering, no orphan handling needed. |
| Consumer jobs already running? | They **finish normally** (claim + result path is unchanged; the claim is bound to the credential, not the policy). |

### 6.1 The recommended simple V1 behavior: lane priority

The hub pop for a `private` worker with an active public policy becomes:

```
1. pop queue:{type}:ws:{workspace_id}     (owner's lane — strict priority)
2. if empty → pop queue:{type}            (system pool — spare capacity)
```

This reuses the **existing** queue topology verbatim. Consequences:

- **No new queues in V1.** The per-policy queue
  (`queue:{type}:policy:{id}`) from revision 1 is **deferred to V2**,
  where targeted sharing genuinely needs a per-audience lane (so that
  revoking a `users` policy can quarantine its queued jobs). Public
  sharing needs no such lane: the system pool is already shared by all
  `share`/`system` workers, and a worker leaving the pool just stops
  popping it.
- **No dispatch changes in V1.** The backend dispatcher already sends
  non-private-lane jobs to the system pool (`gpu-dispatcher.js:128`);
  it neither knows nor cares which worker eventually claims them.
- **"Stop sharing" is trivially safe** — no queued-job cleanup exists to
  do (§6 table, row 6).

### 6.2 In-flight worker revoke (unchanged from today)

Revoking the **worker** (not the policy) keeps today's semantics: the
credential dies; a running claim is eventually reclaimed by
`sweepProcessingOrphans` after `ORPHAN_GRACE_MS` and requeued to its own
lane. Policies do not interact with this path.

---

## 7. PROPOSED — Access Model, Dispatch & Visibility (V1)

### 7.1 Scope model

V1 implements exactly one scope: **public** — any authenticated user may
have jobs served by a policy-active private worker's spare capacity.
`users` (specific users/friends) is V2; `groups`/`projects` are V3
possibilities only.

### 7.2 Resolution at dispatch time

Because V1 sharing rides the existing system pool, the backend dispatch
path is **unchanged**. The gate lives at the **hub claim**:

```
worker claims work (credential → mode, workspace, active policy)
  private + no active policy   → pop ws queue only          (today)
  private + active public policy → pop ws queue, else system pool   (V1, new)
  share                        → pop system pool            (today)
  system                       → pop system pool            (today)
```

The active-policy fact travels to the hub the same way `mode` does today:
the worker's identity payload (auth mirror / beacon registration) gains
`share_policy: { policy_id, scope } | null`, refreshed on beacon from PG
(≤ 30s staleness, same TTL discipline as the existing mirror). The
**policy row in PG is the only source of truth**; the mirror is a cache.
Expiry is re-checked on read — a stale mirror can never extend a policy.

### 7.3 API surface (proposed, V1)

```
POST   /api/v1/workers/:workerId/share        — start sharing (body: { expires_at? })
DELETE /api/v1/workers/:workerId/share        — stop sharing
GET    /api/v1/workers/:workerId/share        — current policy (owner view)
```

Thin wrappers over the `share_policies` table (create active policy /
set `revoked_at` / read). A single active policy per worker makes a
separate policy-id CRUD surface unnecessary in V1 — the worker id is the
address. Authorization reuses `userWorkspaceGuard` and the existing
`WHERE workspace_id = $2` pattern; a user can never read or mutate
another user's sharing state, and `mode='system'` workers are unreachable
here exactly as they are unreachable by every workspace-scoped route
today.

### 7.4 Counts & visibility

- **One conscious invariant relaxation is required**: today "a private
  heartbeat is never in the global count". A policy-active private
  worker *is* contributing global capacity, so the heartbeat payload
  gains an optional `share_policy` marker and `worker-health` counts such
  a worker in **both** the owner's `private_*` bucket and the global
  pool. The invariant is restated as: *"a private worker **without an
  active public policy** is never in the global count."* This must be an
  explicit, test-covered decision — see §12 (decision D3).
- Heartbeats from workers without a policy are byte-identical to today;
  the parser must treat the field as optional (forward/backward
  compatibility).
- Web/Android visibility in V1 is deliberately minimal: a **"Shared"**
  badge + start/stop control on the owner's worker row (Settings), and
  nothing new on the Generate page (global counts already surface pool
  capacity).

---

## 8. Security (V1 focus)

1. **Authorization** — policy routes are workspace-scoped with the same
   SQL guard as every other worker route (`workspace_id = $2` from the
   session, never the body). Guessing a worker id gains nothing: foreign
   ids 404 indistinctly (existing convention).
2. **No cross-user policy mutation** — `share_policies.workspace_id` is
   denormalized from the worker row and every statement is
   workspace-scoped; one user cannot start/stop/read another user's
   sharing.
3. **No access-policy spoofing** — the consumer never names a policy;
   the hub derives eligibility from the **credential-resolved worker**
   and the PG policy row. There is no client-supplied field that could
   influence which policy applies.
4. **`system` workers stay untouchable** — the policy routes address
   workers through the same workspace-scoped predicates as today;
   workspace-less `system` rows can never match. Admin CRUD remains the
   only system mutator.
5. **Queued jobs when sharing ends** — public sharing uses the system
   pool; no per-worker queue exists to clean. Nothing is dropped,
   nothing is orphaned.
6. **Credentials/secrets** — unchanged. No new credential type, no
   token in any policy payload, one-time disclosure lifecycle untouched.
7. **Kill-switch** — a config flag (`SHARE_FEATURES_ENABLED`, default
   off) gates the hub's step-2 pop and the policy routes; disabling
   returns the system bit-for-bit to today's behavior.

---

## 9. Monetization Compatibility (non-goals in V1)

V1 must not *prevent* future models, and must not *build* them:

- **Free altruistic sharing** — that IS V1 (scenarios B/C/E).
- **Quotas** (V3 possibility) — would need the `share_usage` ledger +
  counters; V1 records nothing, which is acceptable because V1 makes no
  promises about consumption accounting.
- **Credits / paid sharing / marketplace / commissions** (V4
  possibilities) — would settle against a usage ledger joined on
  `(policy, consumer, owner, duration)`. Nothing in the V1 dispatch or
  claim path precludes adding that ledger later: the claim already
  records worker + workspace identities in `animastor:running`, and
  policy identity would ride the same structures.

Rule: **no payment, metering, or pricing logic in the dispatch/claim
path, ever.** Economics attach at the ledger/ledger-consumer layer.

---

## 10. Android / Web Implications (V1)

| Client | Change |
|---|---|
| Web | `WorkerMode` widened with `'system'` for type-safety; Settings worker row gains a "Shared" badge and Start/Stop sharing control (owner only) with expiry presets (1h / 4h / until stopped); i18n EN/RU; error mapping for 403/404. |
| Android | Parity: `PrivateWorkerModels.kt` widened; `BackendApi.kt` + `Repository.kt` gain the three share endpoints; `PrivateWorkersFragment` row gains the same badge + actions; strings EN/RU; update `ANDROID_WEB_PARITY.md`. |
| Both | Generate page: **no change** in V1. Setup wizard: **no change** (create remains `private`; sharing is a post-creation action, which also matches the wizard-permanent-share rule from revision 1). |

No new pages, no new navigation, no consumer-facing UI in V1 beyond the
global counts that already exist.

---

## 11. Migration Concerns (V1)

- **One new table** (`share_policies`) — additive, no `workers` change,
  no data backfill. Fresh and long-lived DBs migrate identically.
- **Mirror payload extension** (`share_policy` field) must be optional in
  both directions: old hubs ignore it; new hubs tolerate its absence
  (old workers).
- **Heartbeat field** optional; parser accepts payloads without it.
- **Kill-switch default-off** means the migration can ship fully dormant:
  schema + code land, behavior changes only when the flag is enabled.
- **Rollback** = flip the flag off (policies remain rows; nothing decays).

---

## 12. Architectural Decisions to Finalize Before Coding

| # | Decision | Recommendation |
|---|---|---|
| D1 | One active policy per worker (UNIQUE index) | **Yes** — removes all dispatch ambiguity |
| D2 | V1 scope = `public` only, CHECK-enforced | **Yes** — V2 widens the CHECK |
| D3 | Relax "private never in global count" for policy-active workers (double-count into private + global) | **Yes**, with tests; document the invariant change |
| D4 | Policy state reaches the hub via auth-mirror/beacon payload (≤30s TTL), PG authoritative | **Yes** |
| D5 | `expires_at = NULL` allowed ("until stopped") | **Yes**; UI offers presets |
| D6 | Stop-sharing semantics: worker just stops popping the system pool (no queue cleanup) | **Yes** — direct consequence of V1 lane reuse |
| D7 | Policy routes shaped as `POST/DELETE/GET /workers/:id/share` (worker-addressed, single active policy) | **Yes** for V1; revisit if V2 needs parallel policies |
| D8 | Counts: keep share+system bucketed together in `/worker/counts` | **Yes** for V1 |

---

## 13. Implementation Recommendation

### 13.1 What to implement first (smallest safe V1)

1. `share_policies` table (§5.1) + migrations.
2. Policy read/refresh helper in `worker-repo` (single indexed query:
   active policy for worker; expiry-checked).
3. `POST/DELETE/GET /workers/:id/share` routes (§7.3), flag-gated.
4. Hub: mirror/beacon carries `share_policy`; pop gains step 2
   (§7.2); heartbeat payload optional field; `worker-health` counts
   policy-active private workers in the global pool (D3).
5. Web + Android owner controls (§10) — badge, start/stop, presets.
6. Tests: policy CRUD authz matrix (owner yes / foreign 404 / system
   unreachable), hub pop precedence, expiry re-check, mirror staleness
   ≤ TTL, kill-switch off = today's behavior exactly, counts invariant
   (D3).

### 13.2 What explicitly NOT to implement yet

- `share_policy_grants`, `users`/friends scope (V2).
- Per-policy queues `queue:{type}:policy:{id}` (V2 — only needed once a
  policy has its own audience to quarantine).
- groups, projects (V3 possibilities — no tables, no fields, no enum
  values).
- `share_usage` ledger, quotas, dashboards, reputation (V3
  possibilities).
- credits, pricing, marketplace, commissions (V4 possibilities).
- Dedicated audit tables (V1 logs via existing patterns).
- `workers.has_active_share_policy` generated column.
- Any consumer-facing "who served my book" UI.

### 13.3 Existing Animastor functionality reused (unchanged)

- Worker identity, `wrk.*` credentials, auth mirror, rotation, revoke
  (`worker-repo`, `worker-auth`).
- Workspace-scoped SQL authorization pattern (`userWorkspaceGuard`).
- Queue topology and the hub's poison-write guard (`gpu-hub`).
- Dispatch routing (`gpu-dispatcher`) — untouched in V1.
- Heartbeat scanning/classification (`worker-health`) — extended, not
  rewritten.
- Frontend worker list/row components and the one-time-key security
  lifecycle (untouched; sharing adds no secrets).

### 13.4 Smallest safe V1 (one sentence)

A flag-gated, single-table feature where the owner can turn public
borrowing of their private worker's spare capacity on (optionally with
an auto-expiry) and off, with the owner's lane always prioritized,
system workers untouched, and zero dispatch-path changes.

### 13.5 Decisions to finalize before coding

The D1–D8 table in §12. D3 (counts invariant relaxation) and D4 (mirror
transport) are the two with real behavioral risk; both need signed-off
tests before the flag is ever enabled.

---

## Appendix — Glossary

- **Mode** — `private` | `share` | `system`; the ownership/resource-lane
  story. Immutable without revoke + recreate.
- **Share policy** — a V1 record granting *public* consumption of a
  private worker's spare capacity, optionally time-bounded. Access
  policy, not ownership.
- **Private lane** — `queue:{type}:ws:{workspace_id}`; the owner's
  exclusive queue.
- **System pool** — `queue:{type}`; served by `share` and `system`
  workers (and, while active, by policy-sharing private workers).
- **Lane priority** — V1 rule: a policy-sharing private worker drains its
  private lane first; the system pool only receives spare capacity.
- **Owner / Consumer** — the workspace that owns the worker / any user
  whose jobs are served by it. Consumers hold zero authority over the
  worker or its policy.
