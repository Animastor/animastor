# Experimental Beta — Private Worker / GPU Hub: Independent Red-Team Audit

> **Status:** Audit / Verification only — **no code changed, no commits**.
> **Date:** 2026-08-20
> **Base commit:** `433f78c` (the reconnaissance commit being audited).
> **Subject:** independent verification of
> `docs/architecture/EXPERIMENTAL_BETA_PRIVATE_WORKER_RECONNAISSANCE.md`
> **Method:** the recon document was read fully, then every critical claim was
> re-derived from source (`gpu-hub/gpu-hub.js`, `worker/worker/worker.cjs`,
> `backend/src/runtime/gpu-dispatcher.js`, `dispatch-engine.js`,
> `worker-health.js`, `generation-routes.cjs`, `task-repo.js`, `schema.js`,
> `workspace-ownership.js`, `auth-context.js`, `guest-repo.js`, `session-repo.js`,
> `proxy/conf/default.conf`, `docker-compose.yml`, `job-schema.js`) and from
> the **live containers** (`docker exec printenv` on `animastor-backend`,
> `gpu-hub`, `animastor-redis`). Code and live state were treated as ground
> truth; the recon document was treated as an unverified hypothesis.

---

## 1. Executive Verdict

**The Qwen reconnaissance is substantially correct and can serve as the basis
for the implementation — with corrections.** Of the material claims, the vast
majority are CONFIRMED against code and live containers. The core conclusions
are sound and match an independent red-team derivation:

1. The entire GPU surface is **public and unauthenticated**; `GPU_HUB_API_KEY`
   and `WORKSPACE_SECRET_KEY` are **empty in the live deployment**, and
   `requireApiKey` **fails open**.
2. The GPU path has **no workspace dimension** (verified: `dispatch-engine.js`
   and `runtime-scheduler.js` contain zero workspace references; the payload,
   queues, and running records carry no workspace; no worker→workspace binding
   exists anywhere).
3. Worker identity is **entirely client-invented** and forgeable in one request.
4. The proposed `User → Workspace → Worker → Job` ownership model with
   per-workspace queues + token-derived identity + claimer-bound result
   submission is the **minimal correct model** and closes the attack surface.

Three findings need correction or deepening (see §3): the `worker/heartbeat`
forgery is worse than reported (it churns DB rows via guest auto-provision),
the `dispatch_id` entropy question is a **hardening item, not a Beta blocker**
(and the real ownership check must be the hub-side claimer binding, not
`verifyDispatchIdentity` — which is weak for audio/video chunked stages), and
`animastor:processing` has **no recovery reader at all** (silent orphan leak),
plus the guest-purge dangling Redis state is a confirmed gap the recon only
touched on.

The proposed **fail-closed** doctrine ("identity from token, never from client;
queue key = ownership boundary; claimer-only results; PG = durable truth, Redis =
operational mirror") is endorsed. The implementation plan in §12 differs from
Qwen's in ordering and adds two MUST items the recon missed.

---

## 2. Confirmed Findings

Every item below was re-derived independently and matches Qwen.

### 2.1 GPU surface exposure — CONFIRMED

| Claim | Evidence |
|---|---|
| `/gpu/` exposed with no auth on both `animastor.in` and `app.animastor.in` | `proxy/conf/default.conf:102-115, 226-239` — no `auth_basic`, no allowlist. |
| `GPU_HUB_API_KEY` empty in live deployment | `docker exec animastor-backend printenv GPU_HUB_API_KEY` → unset (exit 1); same for `gpu-hub`. `.env` (809 B, Aug 15) has no such key. |
| `requireApiKey` degrades to open when unset | `gpu-hub.js:33-41`: `if (!GPU_HUB_API_KEY) return next();` — fail-open. |
| `/task` (enqueue) and `DELETE /queue/clear` open to anyone today | both are `requireApiKey`-gated → open. Full clear wipes ALL tenants' queues (`gpu-hub.js:768-802`). |
| `/beacon` unauthenticated, id client-invented | `gpu-hub.js:248-291`; `worker.cjs:21` `WORKER_ID || "gpu-" + os.hostname()`. |
| `/task/next` gate is only "id in registry", self-registrable one request earlier | `gpu-hub.js:388-472`. `?worker=` / `?type=` are client query params; nothing ties them to a credential. |
| `/task/result`, `/task/error` check only `runningInfo.dispatch_id === dispatch_id` | `gpu-hub.js:496, 608`. `runningInfo.worker` is client-supplied at claim time and **never verified against the submitter**. |
| Backend callbacks `/gpu/task/result\|error` unauthenticated; protected only by routing obscurity + docker network | `generation-routes.cjs:1255, 1343` — no auth, no key. nginx proxies `/gpu/` only to the hub (`proxy_pass http://gpu_hub_upstream/;` strips the prefix), so `backend:3000/gpu/*` is unreachable externally. Hub→backend fetches carry no `x-api-key` (`gpu-hub.js:93-133, 551-578`). |
| `POST /api/v1/worker/heartbeat` unauthenticated → forged counts | `generation-routes.cjs:490-503`, no guard. |

### 2.2 Workspace isolation — CONFIRMED

- Job payload has **no `workspace_id`** (`gpu-dispatcher.js:53-62`).
- Queues are **global per type** (`animastor:queue:{audio\|image\|video}`), one FIFO for all tenants (`gpu-hub.js:355, 418`).
- `animastor:running.worker` = client-supplied, never checked later.
- **No worker→workspace binding exists** in schema, Redis, or code. The `workers`
  PG table is dormant (zero SQL references), and `generation_tasks.worker_id`
  is never written (`task-repo.js` has no worker_id anywhere).
- `dispatch-engine.js`, `runtime-scheduler.js`, `reconciliation-engine.js`,
  `retry-budget-manager.js` contain **zero workspace references**. The GPU path
  is workspace-agnostic end to end. Qwen's "GPU path has no workspace dimension"
  is exactly right.

### 2.3 Identity & ownership claims — CONFIRMED

- House credential pattern: `sid.<id_b64url>.<secret_b64url>`, 32-byte secret,
  DB stores SHA-256 hash only (`session-repo.js:12-49`); guests mirror it.
- Ownership chain `identity → workspace → books.workspace_id`
  (`workspace-ownership.js:57-81`, `auth-context.js`); `books.workspace_id`
  exists and `bookRepo.getWorkspaceId()` is a single-query resolution.
- Milestone-1 precedent (`workspace_ai_providers`, workspace id never
  client-supplied, `ON DELETE CASCADE`) matches code
  (`schema.js:69-78`, `settings-ai-routes.cjs:12-34`).
- `dispatch_id = dispatch-${Date.now()}-${Math.random().toString(36).slice(2,10)}`
  (`dispatch-engine.js:106-108`) — ~41 bits (36^8 ≈ 2^41.3) of non-crypto PRNG.
- `verifyDispatchIdentity` is the backend callback boundary: dispatch-meta
  comparison (`dispatch-engine.js:226-247`), with dedup + `stale_dispatch`
  rejection (`generation-routes.cjs:1281-1313`).
- `job_id` format is public/enumerable (`job-schema.js`: `{book}_{ch}_{sc}_{NNNN}:audio` etc.).
- Hub is a dumb transport: timeout sweep notifies `worker_timeout`, never
  re-enqueues; retry decisions live in the backend (`gpu-hub.js:146-242`,
  `retry-budget-manager.js`).
- `WORKSPACE_SECRET_KEY` empty in live backend container (`docker exec printenv`
  → unset), so the documented insecure dev fallback key is in use
  (`workspace-ai-provider.js:29-39`); `.env` lacks it; `docker-compose.yml:67`
  declares it required `:?` — the running container predates that compose file.
- `worker/new/start-worker.sh:133` hardcodes `HUB_URL="https://animastor.in/gpu"`
  with no credential concept.
- roadmap.md:10 lists `workers` as a drop candidate — consistent with "dormant".

### 2.4 Operational facts — CONFIRMED

- Hub heartbeat refresh every 10s for running jobs + 15-min registry TTL + 30s
  heartbeat TTL — matches code.
- `animastor:dispatch-lease:*`, `animastor:dispatch-meta:*`,
  `animastor:dispatch-completed:*`, `animastor:runtime:active:*` prefixes match.
- Redis `gpu-hub:workers` registry currently empty; `animastor:running` empty
  (no live jobs at audit time). No `animastor:worker-auth*` key exists — the
  mirror concept is new, as the recon states.

---

## 3. Incorrect / Partial Findings

### 3.1 `POST /api/v1/worker/heartbeat` — UNDERSTATED (worse than reported)

The recon calls it "anyone can forge heartbeats and inflate worker counts."
True, but understated: `authContext` is mounted globally (`backend.cjs:83`) and
**auto-provisions a brand-new guest + temporary workspace on every POST under
`/api/v1`** (`auth-context.js:79-87`). Therefore each forged heartbeat also
inserts a `guests` row + `workspaces` row + `workspace_members` row and sets a
`Set-Cookie`. This is not just a UI-count forgery — it is a **DB churn / row
spam vector** (rate-limit on `/api/` exists at `backend.cjs:69` but this is a
per-IP limit, trivially bypassed). Fix must (a) remove the endpoint or token-gate
it, and (b) ensure it is exempt from guest auto-provision (or never under
`/api/v1` write semantics).

### 3.2 `dispatch_id` entropy — classification corrected (hardening, not a blocker)

The recon's arithmetic is right (~41 bits, non-crypto PRNG) but the conclusion
it *implies* (treating `dispatch_id` guessing as a primary Beta risk, and
"verifyDispatchIdentity is sufficient identity") is only partially correct:

- An attacker does **not** need to guess `dispatch_id` to attack the current
  system — they obtain it **legitimately** by polling `/task/next` (which is
  open). Queue draining, result injection, and DoS all work with zero guessing.
- Once the hub-side **claimer check** is in place (worker identity from token),
  a guessed `dispatch_id` for a *foreign* task is useless (worker mismatch).
- `Math.random()` in V8 is xorshift128+ and is in principle reconstructible from
  ~2 consecutive outputs, enabling *prediction* of future ids — but acting on a
  predicted id still requires either the backend callback (internal-only) or a
  matching `running` record, i.e. another privilege. **Not exploitable today
  without a second bug.**
- **Real finding the recon missed:** for **audio/video**, the backend **accepts
  stale dispatch ids** while the scene is in `WAITING_CHUNKS/MERGING`
  (`generation-routes.cjs:1300-1313`). So `verifyDispatchIdentity` is *not* a
  reliable per-job ownership proof for chunked stages — dispatch identity is
  per scene:stage, not per job. The actual ownership guarantee must come from
  the **hub-side claimer binding** (`runningInfo.worker === auth.worker_id`),
  which the recon proposes but labels as belt-and-braces. It is the **primary**
  control for audio/video, not secondary.

Conclusion: move `dispatch_id` to `crypto.randomBytes` (cheap, good hygiene) —
**SHOULD**, not MUST; and treat the claimer check as **the** result-ownership
control, with `verifyDispatchIdentity` as a replay/staleness guard only.

### 3.3 `animastor:processing` — recon calls it a "crash-recovery aid", it has NO recovery reader

- `RPOPLPUSH queue → processing` then `HSET running` (`gpu-hub.js:420-451`) is
  two steps; a worker crash between them orphans the task in `processing` with
  no `running` record.
- The hub timeout sweep iterates **only** `running` (`gpu-hub.js:156-240`); the
  backend has **zero** references to `animastor:processing` (grep-verified);
  nothing ever reads/re-enqueues `processing`. The only consumers are the
  result/error/`queue/clear` paths that *remove* entries.
- So `processing` is not an aid — it is a **silent orphan sink**. With
  per-workspace queues, an orphaned private job leaks forever. **MUST/SHOULD
  FIX:** a hub sweep for `processing` entries older than `GPU_TIMEOUT_MS` with
  no corresponding `running` record → notify backend `worker_timeout` (existing
  `notifyBackendError` path) and drop the entry.

### 3.4 "Revocation is immediate" — PARTIALLY CONFIRMED

`revoked_at` (PG) + mirror-field delete (Redis) in one operation is *not*
atomic across two stores. A Redis blip at revoke time leaves the mirror entry
stale until the next resync; during that window the worker's token still
resolves. Practical window is seconds-to-reconcile-cycle. Acceptable for Beta,
but the recon's word "immediate" overstates it. Also the (reasonable) policy of
"in-flight job finishes after revoke" means a revoked worker *may still submit
its in-flight result* — a conscious trade-off, correctly flagged as Q5, not an
error.

### 3.5 "Repurpose the dormant workers table" — PARTIALLY CONFIRMED

The table is genuinely dormant (easy to repurpose), but the migration sketch is
under-specified: the existing table has `worker_id TEXT PRIMARY KEY`, a
`worker_type` CHECK that **includes `'upscale'`** (`schema.js:206-215`), and no
workspace/token columns. Changing PK type (TEXT→UUID) and the CHECK list, plus
adding `workspace_id FK`, `token_hash UNIQUE`, `mode`, `revoked_at`, is a
real migration (new table + copy is cleaner than ALTERs). Not a blocker; just
not as "free" as the doc implies. No existing rows exist, so either approach
works.

### 3.6 Trust boundary not stated — PARTIAL

The recon never says it explicitly: **the security model trusts the hub
process completely.** The hub resolves tokens against a Redis mirror, enforces
claimer checks, and routes queues. A compromised hub (or Redis) = every
workspace compromised (token mirror forgeable, queues drainable, running
records forgeable). For a single-operator VPS with Redis unpublished and
network-isolated (confirmed: `docker-compose.yml` publishes no Redis port) this
is acceptable — but it must be documented as the model's root trust assumption,
and "Redis compromise" must be scored accordingly (§9). Worker tokens protect
against *internet attackers and other tenants*, not against hub/Redis
compromise.

---

## 4. Security Analysis (current state, independent)

### 4.1 Attack walkthrough — queue drain + result injection (works today)

1. `POST /gpu/beacon {id:"pwn", type:"image", protocol_version:2}` → registry entry (open).
2. `GET /gpu/task/next?worker=pwn&type=image` → pops **any tenant's** image job;
   response contains the full ComfyUI workflow (prompts) + base64 reference
   assets + `dispatch_id` + `job_id`.
3. `POST /gpu/task/result {job_id, build_id, dispatch_id, result_base64, protocol_version:2}`
   → accepted (dispatch match), forwarded to backend, `handleTaskResult` marks
   the scene ready with attacker-controlled content.
   → **Prompt exfiltration, content injection, GPU-cost drain, and job theft are
   all live today.** `DELETE /queue/clear` (no filter) additionally wipes every
   tenant's queues.

This chain is exactly what the proposed model must close, and does:
authentication (token) kills step 1's forged identity; workspace queues kill
step 2's cross-tenant pop; claimer-check kills step 3's foreign submission.

### 4.2 Authoritative ownership placement

- **DB is the durable truth:** `workers.workspace_id` (worker→workspace),
  `books.workspace_id` (book→workspace, already the anchor).
- **Redis is operational state:** queues, running records, heartbeats, mirror,
  leases, dedup. Nothing durable depends on Redis.
- **Do NOT move task queues to PG.** The existing Redis doctrine (documented in
  `redis-failure-model.md`) already handles Redis loss via reconciliation +
  rebuild; per-workspace queue keys stay Redis lists. Only the new worker-auth
  mirror is a Redis addition, and it is rebuildable from PG on startup/interval.
  Qwen's placement table (§15 of recon) is endorsed unchanged.

### 4.3 The "hidden link" job → book → workspace

`job_id` embeds `book_id`; `bookRepo.getWorkspaceId(bookId)` returns
`books.workspace_id` in one indexed query. This link **already exists and is
already used** by ownership guards (`workspace-ownership.js`,
`workspace-ai-provider.js:263`). The GPU path simply never consumed it. It can
therefore be used to resolve the workspace **server-side at dispatch time**
without any client-supplied value — this is the safe source for both payload
and queue routing (§7).

---

## 5. Worker Identity Recommendation

Endorsed with refinements.

**Model: per-worker bearer token `wrk.<worker_id_b64url>.<secret_b64url>`,
32-byte secret, PG stores SHA-256 hash only, Redis mirror
`animastor:worker-auth` (token_hash → {worker_id, workspace_id, worker_type,
mode}) for the hub's hot path.**

- **Why token (not API key / session):** an API key shared per workspace cannot
  express per-worker identity (breaks the claimer check) or per-worker
  revocation/rotation. A user session is wrong on three axes: it is a user
  credential (mixing identity namespaces), it expires and rotates like a login
  (wrong lifecycle for a long-lived remote daemon), and it would need cookie
  flow on a headless GPU box. A dedicated, revocable, hash-only worker
  credential is the correct primitive for remote GPU / Docker / Home UI.
- **Refinement 1 — bind `worker_type` into the token resolution:** the hub must
  pop the queue keyed by the **registered** type, not the client-supplied
  `?type=`. The token resolves to a row with a fixed `worker_type`; `/task/next`
  `?worker`/`?type` become display hints and MUST be ignored for selection.
- **Refinement 2 — the token must not unlock user API:** token resolution lives
  in the hub; backend `/api/v1/*` guards remain session/guest-only. The token
  must never be accepted as `req.user`. This is what Qwen proposes; confirm it
  is enforced at the backend callback too (the hub→backend hop authenticates the
  **hub** via a shared key, and forwards `worker_id` only for audit).
- **Refinement 3 — revocation ordering:** revoke = PG `revoked_at` + mirror
  field delete, then a periodic resync to heal the Redis-blip race (§3.4). Fine
  for Beta.
- **Refinement 4 — guest policy:** the recon's `requireAuth` (users only, no
  guests) is the right call and is a *deviation* from the Milestone-1
  `identityGuard` (which admits guests, `settings-ai-routes.cjs:20-34`).
  Document that deviation explicitly; do not silently "reuse the house pattern".
- **Scope check — does the token open the whole workspace API?** No: it resolves
  only inside the hub to {worker_id, workspace_id, worker_type}. It cannot call
  `/api/v1/*`. It CAN read its own workspace's queued jobs (prompts + assets),
  fail them, and submit results — that is the worker's job. Blast radius =
  one workspace's generation, and only for content the workspace itself owns.
  Acceptable.

---

## 6. Workspace Ownership Recommendation

**Endorsed:** the ownership boundary is the **queue key** (workspace segment)
plus **credential resolution** (identity from token). Downstream controls
(claim, result, error) are pinned to the worker identity derived from the token
at claim time.

- Worker A → Job A (own): claimer check passes. ✓
- Worker A → Job B (same workspace, another worker): blocked by
  `runningInfo.worker === auth.worker_id`. ✓
- Worker A impersonates Worker B: requires B's token. ✓
- Worker A claims an arbitrary task: pops only its own workspace queue. ✓
- Worker A submits result/error for B: blocked (claimer check). ✓
- Worker A replays an old result: running record already deleted → hub 409
  `stale_or_unknown_dispatch`; backend dedup + `verifyDispatchIdentity`.
  ✓ (Note the audio/video stale-acceptance exception, §3.2.)
- Worker A uses a guessed `task_id` / `dispatch_id`: needs a live `running`
  record with matching dispatch AND (post-fix) matching worker. ✓
- Revoked worker → old task: new polls 401; in-flight result per policy. ✓

**The one place ownership must also be enforced is the backend callback.** The
hub is the primary gate, but the backend `/gpu/task/result|error` must:
(a) require the hub's shared key (`x-api-key`) so nobody else can call them;
(b) optionally re-verify `job → book → workspace` equals the forwarded
`workspace_id` (cheap, belt-and-braces). Where to check: **both** — hub for the
per-worker/per-dispatch gate (hot path, must be fast), backend for the durable
workspace invariant (authoritative, has PG). The hub alone is sufficient
against internet attackers; the backend check protects against a *misbehaving
hub* (trust boundary, §3.6).

---

## 7. Private Mode — Option A vs Option B

The task asks to compare `job.workspace_id` (A) with `job.book_id →
book.workspace_id` (B).

**Result: they are architecturally equivalent; A is the explicit, simpler form.**

- `job_id` **already embeds `book_id`** (`job-schema.js`). So under B the
  "workspace field" is implicit, and the backend must still resolve
  `book → workspace` server-side (it needs PG, which the hub does not have).
- The hub is Redis-only and must stay a dumb transport. Whatever the source, the
  queue key needs the resolved workspace at pop time → the hub must receive it
  in the queue item. That is Option A's payload field, whatever it is named.
- Security is identical *provided*: (1) the backend resolves the workspace
  **server-side from `books.workspace_id`**, never from the client; (2) the hub
  only ever enqueues what the key-authenticated backend sends; (3) the hub pops
  only the token-derived workspace key and **cross-checks the popped queue
  item's stored workspace against the token workspace** (a poison-write guard
  against backend bugs — cheap and worth adding).
- Race conditions: the only dispatch-time race is "has registered worker"
  checked at t0; worker revoked before pop → job waits forever in the private
  queue. Mitigation = a per-type wait TTL → fail (recommended) — same for A and B.
- Performance: one more Redis list per (type, workspace); lists are O(1) ops;
  negligible. Keyspace growth is fine.
- Implementation surface: A = add `workspace_id` to payload + `:ws:` key + store
  in running. B = same, just derived from the book row. No difference.
- Retries/recovery: unchanged for both; re-dispatch lands in the same workspace
  queue.

**Recommendation: Option A** (explicit `job.workspace_id`, server-resolved from
`book → workspace` at dispatch, never client-supplied), with the hub-side
poison-write cross-check. Option B adds indirection without adding security.

---

## 8. Redis / Task Analysis

1. **Can global queues coexist with strict isolation? No.** A single FIFO per
   type cannot be popped workspace-scoped without per-workspace keys or an
   O(n) client-side filter that is racy under `RPOPLPUSH`. **Partitioning
   (per-workspace keys, or the two-tier system/private scheme) is required.**
2. **Queue topology:** keep `queue:{type}` as the operator "system pool" for
   workspaces without a registered worker; add `queue:{type}:ws:{ws}` for
   private workspaces. Routing decision at dispatch time in the backend
   ("has a registered, non-revoked worker of the type" → private; else system
   pool). This is deterministic and race-free at dispatch time. The recon's
   Beta policy (jobs wait in the private queue when the worker is offline —
   never silently leak to the system pool) applies to *registered* workspaces;
   unregistered ones legitimately use the system pool. Product decision (Q1)
   remains: is the system pool enabled for guest workspaces in Beta? (See §10.)
3. **Failure matrix:**

   | Event | Behavior | Verdict |
   |---|---|---|
   | Worker crash mid-task | hub per-job timeout → `worker_timeout` → backend failStage → retry → re-dispatch to same ws queue | sound |
   | Worker crash between RPOPLPUSH and HSET | task orphaned in `processing`, **nothing recovers it** | **GAP — add sweep (§3.3)** |
   | Redis restart/loss | queues/running/registry lost (documented); mirror rebuilt from PG; workers re-beacon | sound |
   | Backend restart | leases wiped on boot; scheduler re-dispatches; mirror resync on startup | sound |
   | Duplicate claim | impossible — `RPOPLPUSH` is atomic | sound |
   | Duplicate dispatch | possible (two leases → two dispatch_ids); hub dedup per dispatch; backend `verifyDispatchIdentity` rejects stale | sound (existing) |
   | Retry | backend retry-budget-manager only; hub never re-enqueues | sound |
   | Stale worker | hub sweep level 2 frees its jobs + deletes registry entry | sound |
   | Stale task | hub sweep level 1 + lease expiry | sound |

4. **Authoritative ownership lives in PG:** `workers.workspace_id`,
   `books.workspace_id`. Redis holds only operational state + a rebuildable
   mirror. This matches the house doctrine; **no migration of queues to PG**.

---

## 9. Threat Model

Severity: C=Critical, H=High, M=Medium, L=Low. Current = exposure today.
Beta = required control before experimental Beta. Later = hardening.

| # | Threat | Sev | Current exposure | Beta requirement | Later hardening |
|---|---|---|---|---|---|
| 1 | Stolen worker credential | H | n/a (no credential exists) | token revocation + rotation; hash-only storage; per-worker scope | token binding to worker_type; short-lived tokens |
| 2 | Forged worker_id | C | trivial (`/beacon` any id) | identity from token only; body/query ids ignored | — |
| 3 | Forged workspace_id | C | concept absent from GPU path | workspace from token; queue key from credential; payload ws from backend only | hub poison-write cross-check |
| 4 | Task enumeration (job_id) | M | format public; payloads exposed via `/task/next` | claimer-only result; ws-scoped queues hide other tenants | unguessable task ids (later, not needed) |
| 5 | Queue draining | C | any internet client can pop any queue | per-ws queues + token-scoped pop | rate limit `/task/next` |
| 6 | Task stealing | C | as #5 | as #5 | — |
| 7 | Result injection | C | dispatch_id equality only (obtainable by polling) | token auth + claimer check + dispatch match; hub→backend x-api-key | backend ws re-verify; signed results |
| 8 | Replay (old result) | M | dedup + stale_dispatch rejection; audio/video stale-accept exception | keep dedup + running-record deletion | per-job nonce |
| 9 | Malicious worker (owns valid token) | M | n/a | confined to own ws by construction; result size/type validation in backend | job-level resource quotas |
| 10 | Malicious workspace member | M | book guards exist | worker CRUD gated by workspace membership; ids useless without tokens | — |
| 11 | Revoked worker | M | n/a | mirror delete → 401; in-flight finish policy | hard-kill option |
| 12 | Dead/stale worker holds tasks | M | hub sweep works | kept; re-dispatch confined to ws queue | — |
| 13 | Compromised GPU server | H | worker sees full payloads (prompts+assets), can fail jobs | accepted (one-ws blast radius) | per-job encryption / signed tasks |
| 14 | Malicious public endpoint | C | whole `/gpu/` open | token auth (worker) + x-api-key (admin); `requireApiKey` fail-closed | nginx rate limits (§11) |
| 15 | Redis compromise | H | not published, docker-net isolated; but hub fully trusts Redis | keep isolation; document trust boundary | hub-side signed lease; Redis ACL |

---

## 10. Guest Workspace Interaction

Current facts:

- `purgeExpired` (`guest-repo.js:176-214`) deletes only PG rows: guests, then
  `books` (by `workspace_id`), then the `workspaces` row. **It touches no Redis
  GPU state.**
- Guests currently have **no workers** (no worker creation exists at all), so
  their jobs use the **system pool**. Under Beta routing, a guest workspace with
  queued/running jobs that gets purged leaves **dangling Redis state**: queue
  entries in `queue:{type}` for its books, `running` records, result mailboxes
  (`animastor:result:*`), dedup keys — all pointing at deleted books.

**Confirmed dangling ownership.** The fix the recon sketches (extend
`queue/clear`'s ownership filter with a workspace scope and invoke it on purge,
failing in-flight stages via `cancelActiveDispatch`) is correct and must be a
Beta item, because guests *do* put jobs into the system pool. Note: `queue/clear`
currently filters by `book_id`/`dispatch_id` only, so a workspace-scoped filter
(book→workspace) is new logic; iterate books of the deleted workspace and clear
each, or add a `workspace_id` filter to the hub.

Worker rows: if worker creation is ever opened to guests, `ON DELETE CASCADE`
on `workers.workspace_id` makes the row die with the workspace, and the mirror
sync drops the auth entry. Sound by construction (consistent with the recon).

---

## 11. nginx / Remote GPU Workers

- **Must nginx authenticate workers?** No. nginx cannot resolve worker tokens
  without the mirror; the authz boundary belongs at the **hub** (app-layer).
  nginx's job is TLS + routing + coarse limits.
- **Should auth be in the hub or both?** Primary: hub. nginx additions are
  defense-in-depth only.
- **IP allowlist?** **Not viable.** Workers are remote GPU servers with
  variable IPs; a allowlist would break the deployment reality the recon
  correctly anchors on. Do not add.
- **Can remote public GPU workers be used safely?** Yes, once worker endpoints
  are token-authenticated and admin endpoints are key-gated. Token transit is
  over TLS; the token is a long-lived secret on the GPU box — same trust as any
  agent credential.
- **Recommended nginx (SHOULD):** `limit_req` on `/gpu/beacon` and
  `/gpu/task/next` (blunts enumeration/queue-drain attempts); keep
  `client_max_body_size` sane; ensure backend `/gpu/*` is never proxied (it
  isn't today — keep it that way). `proxy_read_timeout 300s` on `/gpu/` may
  need a bump for large result uploads.

---

## 12. Minimal Implementation Plan (6 phases)

**Phase 0 — Operational prerequisites (ops + one code change).**
Set `GPU_HUB_API_KEY` and `WORKSPACE_SECRET_KEY` in `.env`; restart the stack;
verify `/task` and `/queue/clear` return 401 without the key. **Code change:**
make `requireApiKey` **fail closed** when the key is unset (reject, with a loud
startup warning) so the open-by-default landmine is removed, not just
configured away.

**Phase 1 — Worker credential & identity (backend).**
Repurpose/rebuild `workers` table (workspace_id FK CASCADE, token_hash UNIQUE,
mode, revoked_at, UUID PK); `worker-repo.js`; issue/rotate/revoke following
session/guest pattern; `animastor:worker-auth` mirror (startup + reconcile
loop); resolve `worker_type` server-side.

**Phase 2 — Hub authentication & workspace queues.**
Bearer-token middleware on `/beacon`, `/task/next`, `/task/result`,
`/task/error`; identity from token only; backend resolves workspace at dispatch
(`book → workspace`, never client-supplied), passes `workspace_id` in `/task`
(key-gated) → hub enqueues to `queue:{type}:ws:{ws}`; `/task/next` pops only
the token-derived workspace+type key; keep system pool + GPU_HUB_API_KEY
semantics; hub poison-write cross-check on pop.

**Phase 3 — Task authorization & callback hardening.**
Claimer-only result/error (worker + dispatch + workspace match); store
`workspace_id` in `running` at claim; hub→backend hop gets `x-api-key`; backend
re-verifies `job→book→workspace`; populate `generation_tasks.worker_id`;
`crypto.randomBytes` dispatch_id; **remove or token-gate
`/api/v1/worker/heartbeat` and exempt it from guest auto-provision**; **add the
`processing` orphan sweep**; **workspace-scoped `queue/clear` + guest purge
integration**.

**Phase 4 — Registration & Settings UI.**
`/api/v1/workers` CRUD (`requireAuth`, workspace from `req.workspace` —
document the guest deviation); Settings → Workers section (add/rotate/revoke,
online/last_seen via workspace-scoped heartbeat data).

**Phase 5 — Worker client & deployment artifacts.**
`worker.cjs`: `Authorization: Bearer` on all hub calls; `ANIMASTOR_WORKER_TOKEN`
(+ `HUB_URL` alias); server-assigned identity; updated `start-worker.sh`;
minimal Dockerfile + run instructions (remote-GPU-first).

**Phase 6 — Tests & independent verification.**
Mocha: token lifecycle, cross-workspace isolation (A1 cannot take B jobs),
claimer-only results, revocation, guest non-access, redis-loss mirror rebuild,
purge-clears-GPU-state; then an independent red-team round as done for
Milestone 1.

---

## 13. MUST / SHOULD / CAN WAIT

### MUST FIX BEFORE EXPERIMENTAL BETA

1. Set `GPU_HUB_API_KEY`, `WORKSPACE_SECRET_KEY` in `.env` + restart; verify 401
   without key (Phase 0).
2. **`requireApiKey` fail-closed in code** (removes the open-by-default landmine).
3. Worker credential + hub Bearer auth on all worker endpoints (identity from
   token; never client-supplied).
4. Workspace-scoped queues (`queue:{type}:ws:{ws}`) + server-side workspace
   resolution at dispatch (book → workspace).
5. Claimer-only result/error at the hub (worker + dispatch + workspace match).
6. Hub→backend callback authentication (`x-api-key`) + backend workspace
   re-verify; populate `generation_tasks.worker_id`.
7. Guest-purge clears Redis GPU state (workspace-scoped `queue/clear` +
   in-flight cancellation) — guests use the system pool today.

### SHOULD FIX DURING BETA

8. `crypto.randomBytes` for `dispatch_id`.
9. Remove / token-gate `POST /api/v1/worker/heartbeat` and exempt from guest
   auto-provision (row-churn DoS).
10. `animastor:processing` orphan sweep (no recovery reader exists today).
11. nginx rate limits on `/gpu/beacon`, `/gpu/task/next`.
12. Hub poison-write cross-check (popped item's workspace === token workspace).
13. Mirror resync job + revoke-during-Redis-blip healing; per-type wait-TTL →
    fail for offline private workers.
14. `worker_type` binding: hub pops only the registered type, ignores `?type=`.

### CAN WAIT (later hardening)

15. Signed/encrypted job payloads; per-job nonces; worker attestation; SHARE
    mode; IP allowlists; resource quotas; UI audit trail for worker activity.

---

## 14. Future Share Boundary

The proposed model does **not** close the SHARE door. `mode` as a schema value
with `private` as the only schedulable mode is fail-closed, and the invariant
"worker pops only keys it is allowed to pop" is exactly the seam SHARE extends:

- SHARE later = the **backend** tells the hub an additional set of allowed pool
  keys for a shared worker (a scheduler/policy decision in the backend, where
  the market/pool logic will live anyway). The hub stays dumb: it only honors
  the allowed-keys list it receives. Identity, ownership, claimer-check, and
  queue mechanics are untouched.
- The private queue invariant must remain: a private worker's queue is never
  poppable by a shared pool worker and vice versa. The `:ws:` key segment
  preserves this trivially.
- Requirement to preserve today: **never hard-code the set of pop-able keys
  into the hub** in a way that assumes a single workspace; pass the workspace
  (and later, the allowed pool) as data. The proposed design already does.

---

## 15. Open Questions

1. **System pool in Beta:** do workspaces without a private worker (esp.
   guests) keep flowing to the operator's GPU, or is Beta own-GPU-only?
   Recommended: keep (backward compatibility), surface "using operator GPU"
   in the UI.
2. **System worker credential:** bind operator workers as private workers of
   the seeded developer workspace (recommended) vs a new `mode='system'`.
3. **One worker per type per workspace:** multiple workers of the same type
   already work (any may pop) — confirm no limit for Beta.
4. **Guest worker creation:** forbid (recommended, `requireAuth`) — confirm;
   this is a deliberate deviation from the Milestone-1 `identityGuard`.
5. **Revocation mid-task:** finish in-flight (recommended) vs hard-kill.
6. **Offline private worker:** wait with UI warning (recommended) + per-type
   wait TTL → fail; confirm the TTL default (e.g. 24h).
7. **`/gpu/` exposure:** app-layer auth sufficient (recommended) + nginx rate
   limits; no IP allowlist (breaks remote GPU servers).
8. **Processing orphan sweep:** confirm it belongs in the hub sweep interval
   and reuses the `notifyBackendError` path.
9. **Backend callback re-verify:** accept the forwarded `worker_id` as
   audit-only, or enforce `job→book→workspace` equality server-side
   (recommended: enforce — it is one indexed query).

---

## 16. Final Verdict on the Reconnaissance

1. **Can it be the basis for implementation?** **Yes.** Its architecture —
   token identity from a DB row, workspace-scoped queues, claimer-bound result
   submission, PG durable / Redis operational split, dumb hub, SHARE-seam via
   mode — is the minimal correct model and matches an independent derivation.
2. **What to change before implementing:** (a) fail-closed `requireApiKey`;
   (b) treat the hub claimer check as the *primary* result-ownership control
   (not belt-and-braces), given the audio/video stale-dispatch acceptance;
   (c) add the `processing` orphan sweep; (d) fix/remove
   `/api/v1/worker/heartbeat` including the guest-auto-provision side effect;
   (e) make guest purge clear Redis GPU state; (f) resolve workspace
   server-side from `book → workspace` and treat `job.workspace_id` as
   backend-authored, never client-supplied; (g) nginx rate limits.
3. **Which conclusions are wrong:** none are flatly wrong; three are
   understated (`worker/heartbeat` row-churn, `processing` orphan, hub trust
   boundary) and one is over-classified (`dispatch_id` entropy is hardening,
   not a blocker).
4. **Minimal recommended architecture:** see §5–§7 and §12 — in one line:
   *worker token (hash-only, DB truth, Redis mirror) → hub Bearer auth →
   backend-resolved `book→workspace` → `queue:{type}:ws:{ws}` → token-scoped
   pop → claimer-bound result/error (hub) + key-authenticated, workspace-re-
   verified callback (backend)*.
5. **Implementation order:** the 6 phases of §12, with Phase 0 strictly first.