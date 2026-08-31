# Worker Sharing Model — Design Document

> 2026-08-31 · Research / design only — no production code or schema modified.
> Companion to `shared-workers-feature-report.md` (which scopes the
> minimum shared-worker visibility change). This document opens the wider
> design space for the **share** mode as a future resource-sharing system.

---

## 0. Conceptual Model — three modes, three ownership stories

The three modes are conceptually **distinct along the ownership/availability axis**, not just labels:

| Mode | Owner | Scope of authority over the worker | Available to | Mutated by |
|---|---|---|---|---|
| `private` | the user's workspace | the owner only | the owner only (workspace queue) | the owner |
| `share` | the user's workspace (ownership never transfers) | the owner + a **policy** governing others | the community/system pool, filtered by the policy | the owner (policy) + system (no row-level mutation by consumers) |
| `system` | Animastor / platform (no user owner) | Animastor | the community pool, platform policy | admin (`requireAdmin`) |

Key invariants to preserve forever:

- **Ownership never transfers** — `share` never re-parents a worker. The owning
  workspace keeps all record-level authority (rotate, revoke, delete).
- **System and Share are different concepts** — `system` is platform-owned
  infrastructure governed by Animastor policy; `share` is user-owned
  infrastructure governed by the owner's policy.
- **Share consumers are not stakeholders** — a user consuming a shared
  worker's GPU has *no* write authority on the worker row. They are routed
  to it by the dispatcher, never by editing it.

---

## 1. Current `share` Implementation — what actually works today

### 1.1 Identity / registration

- `POST /api/v1/workers` accepts `mode: 'share'` with `confirm_share: true`
  (`worker-routes.cjs:158-173`). The workspace_id is server-resolved; the
  caller cannot inject a foreign workspace.
- The `workers` table already has `mode CHECK ('private','share','system')`
  and `workers_scope_check` enforces `mode='system' OR workspace_id IS NOT NULL`
  (`schema.js:1283,1293`).
- Tokens, `wrk.*` credential format, and the auth-mirror lifecycle are
  identical for all three modes (no share-specific credentialing).

### 1.2 Visibility / heartbeat classification

- `worker-health.isSystemScope` (`worker-health.js:99`) treats both `system`
  and `share` heartbeats as "global capacity" — share workers are visible
  in the public counts.
- `isPrivateScopeOf` only matches `mode='private'` — **share workers are
  not counted as private for any workspace, not even the owner's**.
- `getAvailability` returns only `system.*` and `private.*` buckets — there
  is no `share.*` bucket in the public model.

### 1.3 Dispatch / queue routing

- `gpu-dispatcher.sendUnified` (`gpu-dispatcher.js:128`) routes a job to a
  **workspace queue** only if the workspace has an **active `private`**
  worker of the type (`hasActivePrivateWorkerOfType` queries
  `mode='private'`). A workspace that has *only* a share worker does
  **not** get a workspace queue — its jobs flow to the system pool.
- The gpu-hub `task/next` pop (`gpu-hub.js:750-775`) selects the queue by
  mode: `private → queue:{type}:ws:{ws}`, `share`/`system →
  queue:{type}` (system pool only). Poison-write guard rejects jobs
  whose `workspace_id` doesn't match the worker's expected scope.

### 1.4 What works (status: ✅)

- A user can create a `mode='share'` worker via the existing user-facing
  endpoint with a one-time confirmation.
- The worker authenticates, beacons, and serves the community pool.
- The worker is **invisible to the owner as a private lane** — the owner
  cannot "use their own share worker" for their workspace's exclusive
  traffic. Owner has no private lane; their own traffic also flows to
  the system pool (or to a separate `private` worker if they also
  register one).
- Counts: share workers inflate the global pool `audio/image/video` in
  `/worker/counts`.

### 1.5 What is missing (status: ❌)

- **No policy / no scoping** — share workers are effectively "shared
  publicly with everyone" *and only* that. There is no model for
  friends, groups, projects, user-specific grants, or per-type
  partial sharing.
- **No temporal semantics** — `mode` is permanent until the owner
  revokes the worker. There is no concept of "share for 1h" or "share
  until manually stopped" at the row level.
- **No revocation semantics for in-flight jobs** — a revoke at the
  worker level kills the credential; a claim already running on the
  hub continues (the hub's `running` hash is not pruned by revoke).
  `sweepProcessingOrphans` will eventually time the orphaned claim out
  (`ORPHAN_GRACE_MS`) and requeue to the **last known** queue.
- **No ownership/credit tracking** — there is no per-job record of
  "this job was served by a share worker owned by workspace X for user
  Y". Future monetization/quotas/credits have no data source.
- **No quotas/limits** — nothing caps how much a foreign user can
  drain from a share worker.
- **Frontend is share-blind** — `WorkerMode` in `privateWorkers.ts:14`
  is `'private' | 'share'` (no `'system'`), the Setup Center wizard
  never offers `share` (only the legacy `confirm_share` body field on
  create), and the Settings page has no UI to flip a worker between
  private and share. Counts lump share+system as one bucket
  ("system/shared" in Settings labels).
- **No audit trail of policy changes** — there is no `share_audit`
  table or log of who shared what with whom and when.

### 1.6 Hard-coded assumptions

These are places where the current code embeds assumptions that the
future design must either preserve or consciously revise:

| Location | Assumption | Compatible with future model? |
|---|---|---|
| `worker-routes.cjs:158` | `mode` is set on create only; no flip endpoint | **Incompatible** — need a policy/lifecycle endpoint |
| `worker-repo.js:39` | `WORKER_MODES = ['private', 'share', 'system']` | ✅ — extend by adding a `policy` column, not a new mode |
| `worker-health.js:99` | `isSystemScope` lumps `share` + `system` | ⚠ — fine for counts; new policy-aware routing must extend, not rewrite |
| `worker-health.js:102-105` | share is NEVER "private to the owner" | ✅ — the future model must preserve this |
| `gpu-dispatcher.js:64` | workspace routing only checks `private` | ✅ — share workers never create a private lane |
| `gpu-hub.js:754` | pop queue = `(private → ws) : (share/system → system pool)` | ⚠ — fine for current global sharing, but a future "share to a specific user/group" requires a per-target queue, not just the system pool |
| `worker-repo.js:99-100` | create throws if `mode != 'private' && mode != 'share'` | ✅ — `'system'` is admin-only, no share model change needed |
| `privateWorkers.ts:14` | TS `WorkerMode` excludes `'system'` | ⚠ — UI doesn't need `'system'` in the user-facing list, but the type should accept it for safety (server may return it) |
| Setup wizard (web/Android) | does not offer `share` as a setup path | ⚠ — for the future model, the wizard should *not* offer share-by-create; share is a policy you apply **after** the worker is online. Keeping create = `private` simplifies the wizard. |

---

## 2. Proposed Conceptual Model

### 2.1 The pivot: `mode` stays; a new `share_policy` describes sharing

The `mode` column already carries the ownership story. We do **not**
add a fourth mode. Instead, we add an **opt-in policy** that says
"this `private` worker is *also* available to X under conditions Y
until time Z".

```
mode      — who owns the resource  (private | share | system)
share     — volunteering by the owner
policy    — to whom, how much, for how long (only meaningful when
            a sharing window is active)
```

Conceptually: a worker is always one of the three modes. A
**sharing window** is a policy record attached to a `private` (or
`share`) worker that turns it, for a period, into additional capacity
for the targets the policy names.

This keeps:

- the auth model (token-derived mode; fail-closed heartbeat
  classification);
- the queue model (the gpu-hub already uses mode to choose the pop
  queue);
- the auth-mirror lifecycle (no new credential type);
- the SQL invariants (`workers_scope_check`).

### 2.2 Two ways to enter a sharing state

1. **Voluntary share (current `mode='share'`)** — owner commits the
   worker to the community pool permanently (or until revoked). Used
   for altruistic, ongoing contributions. This is the current
   behavior; we keep it.

2. **Time-bounded share (new)** — owner activates a `share_policy`
   on a worker that is otherwise `private` (or already `share`),
   with a scope (public / specific users / groups) and a duration
   (expires-at or "until stopped"). The worker keeps its `mode`;
   the policy is a **separate object** with its own lifecycle.

Both share the same dispatch path (queue selection by mode) and the
same credential (no new credential type). The difference is
**who can route to it**:

- `mode='private'`, no active policy → workspace queue only (current).
- `mode='private'`, active policy → **additionally** routed to a
  **policy-scoped queue** (or to the system pool if `public`) — the
  private queue stays.
- `mode='share'`, no policy → system pool only (current).
- `mode='share'`, active policy → still system pool, but the policy
  may filter which users may consume (quota, allowlist).

### 2.3 Owner vs. consumer — clear separation

- **Owner**: the workspace that owns the worker row. Full CRUD on the
  worker. Authority over `share_policy`. Always the same workspace as
  `workers.workspace_id`.
- **Consumer**: a user (could be the owner themselves) who has a
  book/workspace whose dispatch lands on a shared worker. The
  consumer has **no** record-level authority on the worker. Their
  consumption is recorded in the usage log (for quotas/credits)
  but the row is read-only to them.

---

## 3. Suggested Data Model

> Schema shown for design only — **do not deploy**.

### 3.1 `workers` (unchanged columns, plus a derivation flag)

The existing `mode` enum is the source of truth for the lane. Add a
**derived** column for fast filtering (optional, can be a view):

```sql
ALTER TABLE workers ADD COLUMN has_active_share_policy BOOLEAN
  GENERATED ALWAYS AS (
    EXISTS (SELECT 1 FROM share_policies p
             WHERE p.worker_id = workers.worker_id
               AND p.revoked_at IS NULL
               AND (p.expires_at IS NULL OR p.expires_at > EXTRACT(EPOCH FROM NOW())::bigint * 1000)
               AND p.starts_at <= EXTRACT(EPOCH FROM NOW())::bigint * 1000)
  ) STORED;
CREATE INDEX idx_workers_active_policy ON workers(worker_id) WHERE has_active_share_policy;
```

(Or: compute on read. Pick one and document the choice. The
generated column is convenient for the hub's pop path but adds
migration complexity. A view over `workers` + `share_policies` is
equally defensible.)

### 3.2 `share_policies` (new table)

```sql
CREATE TABLE share_policies (
  policy_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id        UUID NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- scope (who is allowed to consume via this policy)
  scope_kind       TEXT NOT NULL CHECK(scope_kind IN ('public', 'users', 'groups', 'projects')),
  -- the actual targets; NULL for public; structure depends on scope_kind
  scope_targets    JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- which worker types the policy covers (null/[] = all types the worker can serve)
  worker_types     TEXT[] NOT NULL DEFAULT ARRAY['audio','image','video'],
  -- temporal
  starts_at        BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint * 1000),
  expires_at       BIGINT,  -- NULL = "until manually stopped"
  revoked_at       BIGINT,  -- soft-revoke
  -- resource envelope
  max_concurrent   INTEGER, -- NULL = unlimited
  max_jobs_total   BIGINT,  -- NULL = unlimited
  max_minutes_cpu  BIGINT,  -- NULL = unlimited (used for quotas/credits)
  -- metadata
  note             TEXT,    -- owner-supplied label
  created_by       UUID REFERENCES users(user_id),
  created_at       BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint * 1000)
);
CREATE INDEX idx_share_policies_worker ON share_policies(worker_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_share_policies_active
  ON share_policies(worker_id)
  WHERE revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > EXTRACT(EPOCH FROM NOW())::bigint * 1000);
```

`scope_targets` semantics:

- `public` → `[]` (no entries needed; any user is allowed)
- `users` → `[user_id, user_id, ...]`
- `groups` → `[group_id, ...]` (requires a `groups` table — out of scope of v1; **open question**)
- `projects` → `[project_id, ...]` (same caveat as groups)

### 3.3 `share_policy_grants` (optional, for fine-grained per-user overrides)

```sql
CREATE TABLE share_policy_grants (
  grant_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id    UUID NOT NULL REFERENCES share_policies(policy_id) ON DELETE CASCADE,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('user', 'group', 'project')),
  subject_id   UUID NOT NULL,
  -- per-subject override of the envelope
  max_jobs     BIGINT,
  max_minutes  BIGINT,
  UNIQUE (policy_id, subject_kind, subject_id)
);
```

### 3.4 `share_usage` (append-only audit / quota ledger)

```sql
CREATE TABLE share_usage (
  usage_id     BIGSERIAL PRIMARY KEY,
  worker_id    UUID NOT NULL,
  policy_id    UUID NOT NULL REFERENCES share_policies(policy_id) ON DELETE CASCADE,
  consumer_workspace_id UUID NOT NULL REFERENCES workspaces(id),
  job_id       TEXT NOT NULL,
  dispatch_id  TEXT NOT NULL,
  started_at   BIGINT NOT NULL,
  ended_at     BIGINT,           -- set on completion / error
  duration_ms  BIGINT,           -- denormalised for fast aggregation
  outcome      TEXT,             -- completed | error | cancelled | timeout
  UNIQUE (job_id, dispatch_id)
);
CREATE INDEX idx_share_usage_policy_window ON share_usage(policy_id, started_at);
CREATE INDEX idx_share_usage_consumer ON share_usage(consumer_workspace_id, started_at);
```

This table is the **only** source of truth for: how much of a
worker's capacity was consumed by whom, and for what outcome. Quotas,
credits, and any future payment settle against this table.

### 3.5 `share_audit` (lifecycle audit)

```sql
CREATE TABLE share_audit (
  audit_id   BIGSERIAL PRIMARY KEY,
  policy_id  UUID NOT NULL,
  worker_id  UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  event      TEXT NOT NULL,   -- created | updated | revoked | expired | auto_revoked_quota
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ts         BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint * 1000)
);
```

### 3.6 Heartbeat payload extension (no protocol change)

The hub-authored heartbeat already carries `mode` and `workspace_id`
(`worker.cjs`, mirrored in `worker-health.parseHeartbeat`). We do
**not** add a new field. Instead, when a hub beacons a worker that
has an active policy, the hub consults a fast cache (Redis set) to
include a `policy_id` in the heartbeat:

```
{ type, worker_id, ts, current_job_id,
  workspace_id, mode,
  policy_id: <uuid>|null }
```

The presence of `policy_id` is the **dispatch signal**: the gpu-hub's
pop path inspects it to choose a per-policy queue (see §6).

---

## 4. Access-Policy Model

### 4.1 Scope taxonomy

```
public    — any authenticated user (matches today's share mode)
users     — explicit user_id allowlist
groups    — explicit group_id allowlist (future; out of v1)
projects  — explicit project_id allowlist (future; out of v1)
```

`public` is the only scope implemented in v1. `users` requires
`share_policy_grants` plus a relationship service. `groups` and
`projects` are deliberately **deferred** — they need a separate
`groups` and `projects` table that this document does not design.

### 4.2 Resolution at dispatch time

For a job with `(consumer_workspace_id, worker_type)` the dispatch
gate asks, in order:

1. Does the consumer have a `private` worker of this type and an
   active lane? → use the workspace queue. (current behavior)
2. Else, is there a `share_policy` covering this consumer (via
   `share_policy_grants` or `scope='public'`) on **any** worker of
   the right type whose `revoked_at IS NULL` and
   `expires_at > now`? → use the policy's queue. (new)
3. Else, fall back to the system pool. (current behavior)

The decision in step 2 must be **deterministic and bounded**:
- A worker may only ever match **one** active policy for a given
  `(worker_type, consumer)` — multiple simultaneous policies for
  the same worker are not supported in v1 (one active policy per
  worker; the table permits N but the API contract restricts it).
- If a consumer matches multiple workers through different
  policies, the dispatcher picks deterministically (e.g.
  `ORDER BY policy_id`) — fairness and stability are the contract.

### 4.3 Policy lifecycle

```
draft  →  active  →  expired | revoked
                       ↑
                       auto-revoked by quota / time
```

- **Activate**: a `share_policy` row is created with
  `starts_at <= now`, optional `expires_at`, no `revoked_at`.
  Authorization: the worker row's owning workspace only.
- **Update**: owner may change `expires_at`, `max_*`, `note`, and
  `scope_targets` while the policy is active. Audit every change.
- **Revoke (manual)**: set `revoked_at`. Audit. In-flight jobs
  on this policy are handled per §5.
- **Expire (automatic)**: a background sweeper sets `revoked_at` on
  policies whose `expires_at < now`. The sweeper is **best-effort**:
  the dispatch gate also re-checks `expires_at` on every decision
  (the policy is never trusted to be "expired" in the absence of a
  sweep record).

### 4.4 Resource envelope (forward-looking but v1-shaped)

The envelope fields are **stored now, enforced lazily**:

- `max_concurrent` — capped in the dispatch path: if the worker is
  already at `max_concurrent` active jobs under this policy, route
  elsewhere.
- `max_jobs_total` — counted from `share_usage` rows; the dispatcher
  increments and checks a Redis counter keyed on `policy_id`. When
  the counter exceeds `max_jobs_total`, the policy is auto-revoked
  and `share_audit` records the event.
- `max_minutes_cpu` — aggregated from `share_usage.duration_ms / 60000`
  on each completion; same auto-revoke mechanism.

In v1 these are **observed but not enforced** (recommended for
shippability): the dispatcher records usage but the counters
trigger only an admin flag, not an auto-revoke. This is a
configurable toggle (`SHARE_ENFORCE_QUOTAS=0` default).

### 4.5 Owner self-consumption

**Decision (recommended for v1)**: when a policy is `public`, the
owner's jobs **may** land on the worker's queue (they participate
in the system pool, like today). When a policy is `users` or
narrower, the owner is **not** in the scope by default — the owner
is supposed to use the worker's private lane (their
`private`-mode worker) or the system pool separately. This avoids
the policy being used to dodge the workspace lane.

This is a design decision, not a hard constraint — record it as
"**owner_is_target = true for scope='public' only**" in the v1
contract.

---

## 5. Private ↔ Share Lifecycle

### 5.1 Today (status)

- A `private` worker can be created with `mode='private'`. The
  owner can never flip it to `share` (or vice versa) — the only way
  to change the mode is to revoke + recreate.
- `mode='share'` is permanent until revoke. No time-based return.

### 5.2 Proposed transitions

```
                (recreate — mode change not allowed in place)
  private  ────────────────────────────────────►  share
     ▲   ◄────────────────────────────────────
     │           (revoke + create)
     │
     │  +share_policy(active)         share_policy(revoked|expired)
  private ───────────────────────────────►  private+policy  ────────► private
     ▲                                          │
     │                                          │  expires_at / manual revoke
     │                                          ▼
     │                                  (worker keeps mode=private;
     │                                   the policy just becomes inactive)
     │
  private  +share_policy(scope=public, expires_at=...) + owner-revoke
  ─────►  private (mode unchanged, policy revoked)
```

The model deliberately **does not** mutate `mode`. The lifecycle
is:

- **Create** — owner creates a `private` worker (existing flow).
- **Activate sharing** — owner opens a `share_policy` (one or more;
  v1 restricts to one active policy per worker).
- **Deactivate / revoke** — owner revokes the policy; the worker
  returns to its baseline behavior (private lane only).
- **Time-bound share** — owner sets `expires_at`; the sweeper (and
  every dispatch decision) re-checks expiry.
- **Mode change (rare)** — owner revokes + creates a new worker
  with the desired `mode`. The old worker is dead (credential
  rotates, row is preserved for audit).

### 5.3 API surface (proposed, not for v1 unless asked)

- `POST   /api/v1/workers/:id/policies` — create a policy
- `GET    /api/v1/workers/:id/policies` — list policies on a worker
- `PATCH  /api/v1/workers/:id/policies/:policyId` — update fields
- `DELETE /api/v1/workers/:id/policies/:policyId` — revoke

Authorization: workspace-scoped (`userWorkspaceGuard`); the SQL
predicate is `worker_id = $1 AND workspace_id = $2`, the same
guarantee that today prevents cross-workspace worker access.

### 5.4 Row ownership during the share window

The owner is **always** the worker row's `workspace_id`. The
policy does not move ownership; it adds reachability.

---

## 6. Queue / Job Behavior

### 6.1 The current queue model (recap)

- System pool: `animastor:queue:{type}` (no `ws`).
- Workspace pool: `animastor:queue:{type}:ws:{ws_id}`.
- The hub's pop is mode-driven:
  `private → ws queue, share/system → system pool` (`gpu-hub.js:754`).

### 6.2 What needs to change for time-bound, scoped sharing

A worker in `private` mode that has an active public policy must
be **reachable from both its workspace queue AND the system pool**.
A worker with an active `users` policy must be reachable from a
**policy queue** keyed on `policy_id` (so that we can revoke the
policy and dead-letter in-flight poison writes consistently).

#### Proposed queue topology (v1)

```
private worker, no policy       → queue:{type}:ws:{ws}            (current)
private worker, public policy   → queue:{type}:ws:{ws}            (lane)
                                  + queue:{type}:policy:{policy_id} (new)
                                  + queue:{type}                  (system, optional)
share worker, no policy         → queue:{type}                    (current)
share worker, public policy     → queue:{type}                    (current; policy
                                                                     shapes quota only)
share worker, users policy      → queue:{type}:policy:{policy_id} (new; NOT
                                                                     the system pool)
```

#### Hub pop precedence

```
1. If auth.mode === 'private' → pop from queue:{type}:ws:{auth.workspace_id}
                                (the worker's own lane)
2. Else if auth has active policy_id 'p' and auth.mode === 'private'
                              → pop from queue:{type}:ws:{auth.workspace_id}
                                 (fall through to own lane; the worker is
                                 first a private worker for its owner)
3. Else if auth has active policy_id 'p'
                              → pop from queue:{type}:policy:{p}
4. Else (system or share-without-policy)
                              → pop from queue:{type} (system pool)
```

The **policy row is the source of truth for the queue key** — never
client-supplied. The gpu-hub resolves the policy from PG (cached in
Redis) on every pop.

#### Poison-write / scope-mismatch guard

A worker must never pop a job whose `policy_id` does not match the
worker's currently active policy. The hub's existing
`expectedWs` cross-check (`gpu-hub.js:770-776`) extends to
`expectedPolicy`. Mismatch → dead-letter (same as today).

#### Revocation mid-flight

When a policy is revoked:

1. The Redis policy cache is invalidated (TTL + active purge).
2. The hub's `next/pop` immediately stops using the queue. Within
   one TTL (≤ 30s) no new claims happen.
3. **Already-claimed jobs continue to completion** — the
   `running` hash is not pruned by policy revoke. They are
   attributed to the (now-revoked) policy in `share_usage` for
   accounting.
4. **Queued (not yet claimed) jobs** in `queue:{type}:policy:{p}`
   are dead-lettered with reason `policy_revoked` and a backend
   error hop is sent. The job is **not** silently requeued —
   revocation is a deliberate user action.
5. The dispatcher (backend) on receiving the dead-letter event
   marks the generation task as `ERRORED` with reason
   `worker_unavailable` so the UI can re-prompt or re-dispatch.

The owner does **not** lose their in-flight private-lane work —
the private queue is unaffected by a policy revoke.

### 6.3 Orphan recovery interaction

The existing `sweepProcessingOrphans` (`gpu-hub.js`) requeues
orphaned processing entries to "their own" queue. With policy
revoke, an orphan whose policy was revoked is **dead-lettered**,
not requeued (the policy is gone). The sweeper needs a small
extension: check whether the policy was revoked between claim
and sweep, and dead-letter if so. This is a small, isolated
change.

### 6.4 Hub-authored heartbeat: the `policy_id` field

The hub needs a fast lookup of `(worker_id) → (active policy_id)`
on every beacon. The implementation is a Redis cache populated on
beacon: `animastor:worker:policy:<worker_id> = policy_id|null`,
TTL = `WORKER_HEARTBEAT_TTL` (30s). The hub refreshes this from PG
on beacon start (and on a 60s background refresh). The heartbeat
JSON includes `policy_id` (or omits it). The backend dispatch path
reads it from the heartbeat to pick the right queue for the worker.

---

## 7. Security Considerations

### 7.1 Threat model

Adversaries:

- **A malicious owner** — tries to make their worker consume other
  users' jobs without consent, or to read other users' books via
  the worker (it cannot — the worker only gets job params and
  book_id/chapter_id/scence_id, not the book's content; assets
  are referenced by path, never read by the worker except for
  the inputs the dispatcher explicitly hands it).
- **A malicious consumer** — tries to drain a share worker's
  capacity, to forge a `policy_id`, or to consume a private
  worker's lane.
- **A passive observer** — tries to discover policy structure
  (who is sharing with whom).

### 7.2 Authorization boundaries (enforced in the SQL)

| Operation | Authorization | SQL guard |
|---|---|---|
| `POST /workers/:id/policies` | worker owner only | `WHERE worker_id = $1 AND workspace_id = $2` |
| `PATCH/DELETE /workers/:id/policies/:p` | worker owner only | same |
| `GET /workers/:id/policies` | worker owner only | same |
| `GET /workers/shared` | any authenticated user | `mode='system'` only (unchanged today) |
| `GET /workers/shared/:id` | any authenticated user | `mode='system'` only |
| `GET /workers/:id` (existing) | worker owner only | `workspace_id = $2` (current) |

The share-policies routes **must** reuse `userWorkspaceGuard` and
the same `WHERE workspace_id = $2` predicate. A user can never
read or modify another user's policies. A malicious user who
guesses a `policy_id` cannot consume via it because:

- the hub's `next/pop` derives the target queue from the
  authenticated worker's policy (not the consumer's request);
- the dispatch path on the **backend** stamps `policy_id` from
  the resolved policy, never from the consumer's job;
- a forged `policy_id` in a job payload is overwritten by the
  backend (`gpu-dispatcher.js:128-132` overwrites client-supplied
  `workspace_id`; the same overwrite pattern applies to
  `policy_id`).

### 7.3 Specific risks and mitigations

1. **Cross-scope modification of a worker via policy API**
   - Mitigation: every policy route is workspace-scoped; a user
     cannot list, create, update, or delete a policy for a
     worker they don't own.
2. **Access-policy spoofing**
   - The policy is a row with `policy_id`; it is selected by the
     dispatcher from PG. A consumer's job contains
     `(consumer_workspace_id, worker_type)`, not a `policy_id`.
     The dispatcher resolves policy_id from PG and stamps it
     onto the job before enqueue. Clients never name a policy.
3. **Credential / secret leakage**
   - The worker token is unchanged; the policy does not add
     credentials. Token rotation/revocation is the existing
     path. The `share_policy_grants` table contains no secrets.
4. **In-flight job orphaning on revoke**
   - Already-claimed jobs **finish** under the (now-revoked)
     policy for accounting. The dispatcher must mark the
     generation task with the policy that **served** it (not
     the policy that was active at dispatch, which is the
     same today and under the new design).
   - Recommended: the hub already records the
     `claim.policy_id` in the `running` hash, so the
     accounting is intact even if the policy is revoked mid-run.
5. **In-flight job orphaning on worker revoke**
   - Today's behavior: revoke kills the credential → the hub
     detects (next beacon) and the running job is left in
     `processing` until `sweepProcessingOrphans` reclaims it
     after `ORPHAN_GRACE_MS`. Requeue to the **last known**
     queue. The new design preserves this for the private
     lane; a policy-revoked job is dead-lettered instead.
6. **Poisoning the policy queue**
   - The hub's `expectedPolicy` cross-check (the new
     equivalent of `expectedWs`) prevents a worker from
     popping a policy queue it doesn't have. Mismatches
     dead-letter.
7. **Quota bypass via repeated policy creation/revocation**
   - The `share_usage` row is keyed on `(job_id, dispatch_id)`
     and counts **per actual job**, not per policy. Revoking
     a policy mid-run does not delete the usage row, so the
     counter is preserved. A new policy starts with
     `total_used = 0` from a fresh `share_usage` aggregation.
8. **Force the public pool to be the system pool**
   - Public policy + a private worker → the worker IS
     reachable from the system pool. This is desired (the
     owner is contributing capacity), but it can be abused
     by a malicious owner to absorb jobs they don't want
     served (DoS by starvation of *other* public workers).
     Mitigations: (a) the dispatcher uses a fair scheduler
     across all system-eligible workers; (b) the owner
     can revoke the policy at any time. A future hardening
     pass can add per-policy fair-share weights; v1
     accepts the simple FIFO.
9. **Bypassing private lanes by sharing**
   - The owner's own jobs continue to use the private queue
     if a private-mode worker exists. The policy does not
     steal the owner's lane. (See §4.5 — owner_is_target
     only for `public` scope.)
10. **Privacy: which users are in a group**
    - v1 implements only `public` and `users` (explicit
      user_id allowlist). `groups`/`projects` are deferred
      until the relationship service is designed. The
      `share_policy_grants` table permits per-user overrides
      but no group semantics yet.

### 7.4 Audit + observability

- Every policy CRUD operation writes to `share_audit`.
- Every claim on a policy writes a `share_usage` row on
  completion.
- The dispatch path logs policy_id when stamping jobs; this is
  not user-visible but is the source of attribution.
- The frontend never sees `policy_id` directly — it sees
  "shared with you" / "shared with everyone" / "shared with
  <n> users" via aggregate endpoints.

---

## 8. Future Monetization Compatibility

The data model and dispatch path are designed to **not** paint
the system into a corner. The following are *not* implemented but
are made possible by the v1 design:

- **Free altruistic sharing** — already works (`mode='share'`
  and `scope='public'` policy). No additional change.
- **Usage quotas** — `max_jobs_total` and `max_minutes_cpu` are
  stored. The dispatcher increments the counters and the sweeper
  auto-revokes. The toggle is `SHARE_ENFORCE_QUOTAS` (off by
  default in v1).
- **Credits** — `share_usage.duration_ms` is the unit. A future
  `credit_ledger` table (out of scope here) joins on
  `consumer_workspace_id` and `worker_owner_workspace_id` to
  transfer credits.
- **Paid resource sharing** — the policy already has a
  `note` and a `created_by`. A `price_per_minute` column or a
  separate `share_pricing` table can be added without touching
  the dispatch or auth paths. The dispatcher would need to
  consult the pricing service before accepting a job; the
  decoupling is the key: pricing never gates auth, only
  acceptance.
- **Capacity reservation** — `max_concurrent` is the first
  cut. Future: a `reservations` table that holds a job's
  reserved slot under a policy for a bounded time before the
  claim is recorded.

Key non-goal: the v1 model **does not** bake payments into the
dispatch path. The dispatch path is "policy-allowed → enqueue";
payment is a separate concern (the `note` field is the
acknowledged placeholder).

---

## 9. Android / Web Implications

### 9.1 Web

- **WorkerMode type** in `privateWorkers.ts:14` stays
  `'private' | 'share' | 'system'` (add `'system'` for safety —
  the backend may return it for completeness). The frontend
  never creates a worker in `share` or `system` mode via the
  user-facing routes; the type just exists to avoid `any`.
- **Settings page** gains a "Sharing" section per worker (where
  the owner can create/revoke policies). The section is
  read-only for non-owners (the worker list is already
  workspace-scoped).
- **Settings → worker list rows** show a "Sharing" badge if a
  policy is active. The detail modal shows the active policy
  (scope, expires, target count).
- **Generate page** — counts stay the same
  (`audio/image/video` already include share). A new optional
  `shared_for_you` field could surface "this book was served by
  a shared worker owned by workspace X" for transparency. v1
  does not need this.
- **i18n** — new keys for scope kinds, time bounds, errors.

### 9.2 Android

- **Parity** — `PrivateWorkerModels.kt:14` mirrors the same
  type widening. `BackendApi.kt` gets the policy endpoints.
- **Mirror the Web UI** — same read-only + owner-write split.
- The Setup Center (`WorkerSetupWizardFragment`) is unchanged:
  create is always `private`. Sharing is a separate
  post-creation flow.

### 9.3 No new "shared frontend"

- A new "Shared workers" page (the previous report's
  recommendation for the system-mode read-only list) is a
  **separate feature** from this design. The two reports are
  complementary, not conflicting.

---

## 10. Migration Concerns

The goal is: **the existing `mode='share'` rows and the existing
system-mode rows must keep working unchanged.** No production
migration in this design document — only the contract.

### 10.1 What is forward-compatible today

- `mode='share'` rows behave exactly as they do today; the new
  `share_policies` table is empty for them. They continue to
  contribute to the system pool. ✅
- `mode='private'` rows are unchanged; policies may be added
  but no behavior changes if no policy is active. ✅
- `mode='system'` rows are unchanged. ✅
- Heartbeat classification (`worker-health.js`) is unchanged
  for the legacy `mode` semantics. The new `policy_id` field
  in the heartbeat is **optional** — old workers omit it and
  the legacy path runs. ✅
- Dispatch path (`gpu-dispatcher.js`) is unchanged when
  `hasActiveSharePolicy` returns false for all workers (the
  default after migration). ✅

### 10.2 What is NOT forward-compatible (must be done before the feature ships)

- The `share_policies`, `share_policy_grants`, `share_usage`,
  `share_audit` tables and the optional `workers.has_active_share_policy`
  column must be **migration-only** — they must not break a
  fresh DB or a long-lived DB.
- The new `policy_id` field in the heartbeat must be **optional
  in the parser** (existing workers do not send it; the parser
  must accept heartbeats without it).
- The gpu-hub's pop path must **fall through** to the current
  behavior when the worker has no active policy (the pop is
  identical to today's logic).
- The dispatcher must **fall through** to the system pool when
  no policy matches (today's behavior).

### 10.3 What is deliberately not in v1 (deferred to a follow-up)

- `groups` and `projects` scopes (no relationship service
  yet).
- Payments / credits / quota enforcement (counters are
  observed but not enforced).
- The `Shared workers` user-facing read-only list (separate
  design).
- Reservation system.
- Per-policy fair-share weights in the dispatcher.

### 10.4 Risk: cached/derived state

`workers.has_active_share_policy` is a generated column. It
is recomputed by Postgres on insert/update of `share_policies`.
A background sweep is not needed for the column itself. The
**Redis** mirror of the worker's active policy_id (the
`animastor:worker:policy:<id>` key) has a 30s TTL and is
refreshed on beacon — this is the only derived state that
needs care. If a policy is revoked, the next beacon (or a
forced hub refresh) will update the mirror. The dispatch path
also re-checks the policy on the hub's claim, so a stale
mirror entry cannot persist for long.

---

## 11. Open Architectural Questions

These are the decisions that block implementation; each one is
called out in the sections above but listed here as a single
checklist:

1. **Generated column or view?** `workers.has_active_share_policy`
   as a generated column vs. a view vs. on-read computation.
   Pick one and document.
2. **v1 scope kinds.** Implement only `public` and `users`, or
   also stub `groups`/`projects` rows in the schema without a
   UI?
3. **Owner self-consumption.** Is the owner a target of their
   own `public` policy? Recommended: yes for `public`, no
   otherwise. Confirm.
4. **Quota enforcement toggle.** Is `SHARE_ENFORCE_QUOTAS=0`
   acceptable for v1? (Recommended yes — it makes the rollout
   safer.)
5. **Multiple active policies per worker.** Allow N>1, or
   restrict to 1 in v1? (Recommended 1 for v1; multiple
   policies dramatically increase dispatch ambiguity.)
6. **Revoke + in-flight.** Should revocation also kill the
   in-flight job, or only the queued jobs? (Recommended: only
   queued jobs; in-flight finish for accounting, marked as
   `policy_revoked` in `share_usage`.)
7. **Mode change semantics.** Is a future "flip private → share"
   allowed (with a credential rotation), or is the only path
   "revoke + create"? (Recommended: revoke + create; the
   v1 model preserves the current behavior exactly.)
8. **Heartbeat `policy_id` field.** Optional in v1 (workers
   that don't have an active policy omit it) or required
   when a policy is active? (Recommended optional — the
   fallback is the legacy lane.)
9. **Default `expires_at`.** Should the API require an
   `expires_at` (i.e., every policy must be time-bounded), or
   allow NULL (= "until manually stopped")? (Recommended:
   allow NULL; document the safety implications.)
10. **Public counts and visibility.** Should the public
    `/worker/counts` separate `system` from `share`, or keep
    them bucketed together? (Recommended keep together in v1
    for parity; split later as a follow-up.)
11. **Self-resolution on owner.** When a workspace has both a
    private worker AND a public-policy share worker, does the
    owner consume the private lane (current behavior) or get
    routed to the share queue? (Recommended: keep current —
    private lane takes precedence.)
12. **Audit visibility.** Should the owner see who used their
    shared worker (i.e., the `share_usage` rows attributed to
    their policy)? (Recommended yes — aggregate only, with
    full rows hidden by default; this is the source of any
    future "your worker helped N books" UI.)

---

## 12. Recommended Implementation Phases

The phases are **time-sequenced and independently shippable**.
Each phase leaves the system in a state that is no worse than
the previous one — a phase can be abandoned without breaking
the user-facing behavior.

### Phase 0 — Documentation + contracts (this document)

- Sign off the conceptual model, the `share_policies` data
  shape, the access-policy taxonomy, the queue topology, the
  security model, and the open questions. **No code or schema
  changes.**

### Phase 1 — Observability foundation (no behavior change)

- Add `share_audit` table only.
- Log every `mode='share'` create / revoke as an audit row
  (no new endpoints).
- Validate that the existing share flows still work unchanged
  (regression suite green).

### Phase 2 — Schema + read-only API (no behavior change)

- Add `share_policies`, `share_policy_grants`, `share_usage`
  tables. Schema-only, no application code consumes them yet.
- Add `workers.has_active_share_policy` generated column.
- Add `GET /api/v1/workers/:id/policies` (workspace-scoped,
  read-only) so the existing `private` workers list can surface
  "no policies yet" without code changes.
- Backend tests: schema migrates cleanly, view is consistent,
  existing data is unaffected.

### Phase 3 — Heartbeat + hub support (no dispatch change)

- Extend `worker.cjs` to fetch the active policy_id (via a
  new `/api/v1/workers/whoami` enrichment on `/worker/verify`)
  and include it in the heartbeat JSON.
- Update `worker-health.parseHeartbeat` to accept (and ignore
  in counts) the optional `policy_id`.
- Update the hub to refresh the
  `animastor:worker:policy:<id>` Redis mirror on beacon.
- No dispatch change. Counts unchanged.

### Phase 4 — Policy CRUD + queue topology (new behavior, opt-in)

- Add `POST/GET/PATCH/DELETE /api/v1/workers/:id/policies`.
- Add `dispatch-engine` queue keys
  `queue:{type}:policy:{policy_id}`.
- Add gpu-hub pop: when a worker has an active policy, pop
  from the policy queue (after the private lane, before the
  system pool). Public policies also pop from the system pool.
- Add `share_usage` writes on completion/error.
- Add `share_policy_revoke` dead-letter path in
  `sweepProcessingOrphans` (small, isolated).
- Add the **owner self-consumption** semantics.
- Toggle: `SHARE_FEATURES_ENABLED=0` default; flip to 1 for
  beta.

### Phase 5 — Owner UI (Settings)

- Web: a "Sharing" section per worker on the Settings page.
- Android: parity. Mirror the Settings worker rows.
- i18n parity (EN/RU).
- The owner's usage of their own shared worker is visible
  (aggregate only).

### Phase 6 — Consumer UI (transparency)

- Web/Android: optional indicator in the Generate page: "this
  book was served by a shared worker owned by workspace X".
  Toggleable per workspace; off by default.

### Phase 7 — Quotas (enforcement)

- `SHARE_ENFORCE_QUOTAS=1` toggle. When on: the dispatcher
  checks the counter on every decision; the sweeper
  auto-revokes when `max_jobs_total` or `max_minutes_cpu` is
  reached. Audit the auto-revoke.

### Phase 8 — Future monetization (out of scope for v1)

- `share_pricing` table; `credit_ledger`; payment integration.
  None of this changes the dispatch or auth path.

### Phase 9 — Groups / projects (out of scope for v1)

- Requires a `groups` and `projects` table design (out of
  scope here).

---

## Appendix A — Compatibility matrix

| Component | Today | After Phase 0 | After Phase 3 | After Phase 4 | After Phase 7 |
|---|---|---|---|---|---|
| `mode='private'` create/revoke/recovery | ✅ | ✅ | ✅ | ✅ | ✅ |
| `mode='share'` create/revoke/recovery | ✅ | ✅ | ✅ | ✅ | ✅ |
| `mode='system'` admin CRUD | ✅ | ✅ | ✅ | ✅ | ✅ |
| Share-policy CRUD | — | — | — | ✅ (opt-in) | ✅ |
| Public policy reaches system pool | — | — | — | ✅ | ✅ |
| `users` scope | — | — | — | ✅ | ✅ |
| Quota auto-revoke | — | — | — | — | ✅ |
| Per-consumer attribution | — | — | partial (read-only) | ✅ | ✅ |
| Pricing/credits | — | — | — | — | — (Phase 8) |

## Appendix B — Files that will need to change (forward-looking list, not for this document)

> This is a non-exhaustive list of the files that the **future
> implementation phases** will touch. **Do not change them
> now.**

- `backend/src/storage/postgres/schema.js` — new tables, new
  generated column.
- `backend/src/storage/postgres/repositories/worker-repo.js`
  — new helpers for policies and usage.
- `backend/src/routes/worker-routes.cjs` — new policy CRUD
  routes.
- `backend/src/runtime/dispatch-engine.js` — new policy queue
  keys.
- `backend/src/runtime/worker-health.js` — accept optional
  `policy_id` in heartbeat (counts unchanged).
- `backend/src/runtime/gpu-dispatcher.js` — extend
  `workspaceHasPrivateWorker` to also resolve active policy
  for the consumer.
- `backend/tests/*` — new tests for policy CRUD, scope
  resolution, hub lane separation, dead-letter on revoke.
- `worker/worker/worker.cjs` — include `policy_id` in
  heartbeat.
- `gpu-hub/gpu-hub.js` — pop from policy queue; mirror policy
  in `animastor:worker:policy:<id>`; extended poison check.
- `frontends/app/src/features/workers/*` — Sharing section in
  Settings.
- `frontends/android/app/src/main/java/com/example/animastor/*`
  — mirror.
- `docs/04-planning/` — follow-up design notes per phase.

## Appendix C — Glossary

- **Mode** — `private` | `share` | `system`. The ownership
  story of a worker. Source of truth in `workers.mode`.
- **Share Policy** — A `share_policies` row that describes who
  is allowed to consume a worker (and under what envelope)
  for a given time window.
- **Public** — a scope meaning "any authenticated user".
- **Owner** — the workspace that owns the worker
  (`workers.workspace_id`). Has full CRUD on the row and on
  its policies.
- **Consumer** — a user (workspace) that is using a shared
  worker's GPU. Has no record-level authority on the worker.
- **Lane** — a Redis list key where jobs of a given type and
  scope are enqueued. Workers pop from their eligible lane(s).
- **Envelope** — the resource limit on a policy
  (`max_concurrent`, `max_jobs_total`, `max_minutes_cpu`).
