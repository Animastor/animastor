# Experimental Beta — Private Worker / GPU Hub: Architectural Reconnaissance

> **Status:** Reconnaissance / Design only — **no code changed, no commits**.
> **Date:** 2026-08-20
> **Base commit:** `11b3468` (final verification of workspace AI security remediation)
> **Method:** code-first reading of `gpu-hub/`, `worker/`, `backend/src/**`, `proxy/conf/default.conf`,
> `docker-compose.yml`, plus **live inspection of running containers** (`docker exec` env audit).
> Prior audit documents were cross-referenced but NOT trusted — every claim below is verified against code.
> **Deployment fact (from user):** workers run on a **remote GPU server**, not on the VPS. The VPS hosts
> backend + gpu-hub + redis + postgres + nginx only. All worker-facing endpoints are therefore reached
> **over the public internet** through nginx.

---

## 1. Current Architecture

### 1.1 Components

```text
User's GPU server (remote)                     VPS
+----------------------------+      +------------------------------------------+
| ComfyUI + worker.cjs       |      | nginx (proxy/conf/default.conf)          |
|  - beacon every 10s        |----->|   /api/  -> backend:3000                 |
|  - poll /task/next         | https|   /gpu/  -> gpu-hub:5000  (NO auth_basic)|
|  - POST /task/result       |      |                                          |
+----------------------------+      | backend (Express:3000)                   |
                                    |   dispatch -> POST /gpu/task (x-api-key) |
                                    | gpu-hub (Express:5000)                   |
                                    |   Redis queues / registry / heartbeats   |
                                    | PostgreSQL 16 (durable truth)            |
                                    | Redis 7 (operational state)              |
                                    +------------------------------------------+
```

| Component | Location | Role |
|---|---|---|
| `gpu-hub/gpu-hub.js` (829 lines) | VPS, docker | Dumb task transport: queue, claim, result/error relay, timeout watchdog |
| `worker/worker/worker.cjs` (559 lines) | **remote GPU server** | ComfyUI driver: beacon -> poll -> run workflow -> upload base64 result |
| `backend/src/runtime/gpu-dispatcher.js` | VPS | Backend -> hub submission (`POST /task`) |
| `backend/src/runtime/dispatch-engine.js` (1373 lines) | VPS | Dispatch lifecycle: lease, dispatch_id, retry budget, callback identity check |
| `backend/src/runtime/worker-health.js` | VPS | Heartbeat counting for UI (`/api/v1/worker/status`, `/worker/counts`) |
| `worker/new/start-worker.sh` | remote GPU server | Manual bootstrap: hardcodes `HUB_URL="https://animastor.in/gpu"`, no credential |

### 1.2 Redis key map (GPU transport layer)

| Key | Writer | Meaning |
|---|---|---|
| `animastor:queue:{audio\|image\|video}` | hub `/task` | Global per-type FIFO (single list per type, **all tenants**) |
| `animastor:processing` | hub `/task/next` (rpoplpush) | Claimed-but-not-finished tasks |
| `animastor:running` (hash, job_id -> JSON) | hub `/task/next` | Running task record incl. `worker` (client-supplied), `dispatch_id`, `task_raw` |
| `animastor:gpu-hub:workers` (hash) | hub `/beacon` | Worker registry, 15-min TTL on the whole hash |
| `animastor:worker:heartbeat:{type}:{id}` | hub (beacon + 10s refresh) | 30s-TTL heartbeat, `current_job_id` = busy flag |
| `animastor:job:{dispatch_id}:{job_id}` | hub `/task` | Enqueue dedup (best-effort) |
| `animastor:result:{build_id}:{book}:{ch}:{sc}:{type}` | hub `/task/result` | Result mailbox (1h TTL), fallback for missed callbacks |
| `animastor:error:{job_id}` | hub (error-delivery fallback) | Error mailbox |
| `animastor:dispatch-lease:{b}:{ch}:{sc}:{stage}` | backend dispatch-engine | Renewable scene:stage lease (15/20/30 min) |
| `animastor:dispatch-meta:...` | backend dispatch-engine | Dispatch metadata incl. authoritative `dispatch_id` |

### 1.3 Identity & ownership stack (Auth MVP + Guest MVP + Beta Milestone 1)

- `users`, `workspaces` (`personal`|`temporary`|`team`), `workspace_members` — `schema.js:10-51`.
- Sessions: cookie `animastor_sid` = `sid.<session_id_b64url>.<secret_b64url>`; **DB stores SHA-256 hash only** (`session-repo.js:22-31`).
- Guests: cookie `animastor_gid` = `gst.<guest_id>.<secret>`; same hash-only pattern (`guest-repo.js:55-88`); one guest <-> one `temporary` workspace.
- Ownership axis: `identity -> workspace -> books.workspace_id` (`workspace-ownership.js:57-81`, `auth-context.js`).
- **Beta Milestone 1 precedent:** `workspace_ai_providers` (`schema.js:69-78`) — one row per workspace, AES-256-GCM encrypted secret, `ON DELETE CASCADE` from `workspaces`, workspace id **never client-supplied** (`settings-ai-routes.cjs:12-33`). This is the house pattern the Private Worker milestone must copy.

### 1.4 Dormant / unused infrastructure

- **`workers` PG table exists but is completely unused** (`schema.js:206-215`): no repository, zero INSERT/SELECT anywhere in `backend/src` (grep-verified). Columns: `worker_id TEXT PK, worker_type, capabilities JSONB, status, last_seen, version, metadata`. The roadmap (`docs/architecture/roadmap.md:10`) even lists it as a drop candidate.
- **`generation_tasks.worker_id` column exists and is never populated** (`schema.js:192`, `task-repo.js` — no code path sets it).

---

## 2. Current Worker Flow (verified)

### 2.1 Dispatch (backend -> hub)

```text
runtime-scheduler tick
  -> dispatch-engine.dispatchStage(bookId, chapterId, sceneId, stage)
      lease acquired (15/20/30 min), dispatch_id = `dispatch-${Date.now()}-${Math.random().toString(36).slice(2,10)}`
  -> orchestration.dispatchStage -> audio/generation.js:351,550 | image/iu-processor.js:203 | scene-orchestrator.js:423
  -> gpu-dispatcher.sendUnified (gpu-dispatcher.js:29-100)
      POST {HUB_URL}/task  header x-api-key: GPU_HUB_API_KEY (if set)
      payload: job_id, params(ComfyUI workflow), job_type, build_id, dispatch_id,
               book_id/chapter_id/scene_id/stage (parsed from job_id), timeout_ms
  -> hub: dedup key + LPUSH animastor:queue:{type}          (gpu-hub.js:297-382)
```

### 2.2 Claim (worker -> hub)

```text
worker.cjs loop (every 2s..15s backoff):
  GET /task/next?worker=<WORKER_ID>&type=<WORKER_TYPE>     (gpu-hub.js:388-472)
    hub checks: worker registered in animastor:gpu-hub:workers (self-registered via /beacon),
                protocol_version match, type match
    RPOPLPUSH animastor:queue:{type} -> animastor:processing
    HSET animastor:running job_id -> { worker: <client-supplied>, dispatch_id, task_raw, ... }
  -> worker runs ComfyUI /prompt, polls /history, reads output file
```

### 2.3 Result / error (worker -> hub -> backend)

```text
POST /task/result {job_id, build_id, dispatch_id, result_base64}   (gpu-hub.js:478-585)
  hub: runningInfo must exist AND runningInfo.dispatch_id === dispatch_id (else 409)
  hub: write result mailbox key, HDEL running, LREM processing, clear busy heartbeat
  hub: POST {BACKEND_URL}/gpu/task/result (5 retries)
backend /gpu/task/result (generation-routes.cjs:1255-1339):
  verifyDispatchIdentity(redis, book, ch, sc, stage, dispatch_id)  (dispatch-engine.js:226-249)
  dedup animastor:result-processed:{dispatch_id}:{job_id}:{build_id}
  -> taskHandler.handleTaskResult
POST /task/error -> same shape -> orchestrator.failStage           (generation-routes.cjs:1343-1407)
```

### 2.4 Heartbeat / liveness

- Worker -> hub `POST /beacon` every 10s (`worker.cjs:134-157`); hub additionally **refreshes heartbeats itself every 10s** for all running jobs (`gpu-hub.js:146-176`).
- Backend counts heartbeats for the UI: `GET /api/v1/worker/status`, `/api/v1/worker/counts` (`generation-routes.cjs:505-540`).
- Backend also exposes an **unauthenticated** `POST /api/v1/worker/heartbeat` (`generation-routes.cjs:490-503`) — legacy; real workers do not call it (the hub writes heartbeats).

### 2.5 Timeout / recovery (existing mechanisms)

| Failure | Detector | Effect |
|---|---|---|
| Job exceeds `timeout_ms` | hub 10s sweep, level 1 (`gpu-hub.js:186-205`) | HDEL running, notify backend `worker_timeout` |
| GPU/worker stale (`last_seen` > GPU_TIMEOUT_MS) | hub sweep level 2 (`gpu-hub.js:207-240`) | fail its jobs, delete registry entry |
| Backend callback undeliverable | hub retries x5, then mailbox key `animastor:error:{job_id}` / `animastor:result:*` | picked up by recovery (`audio-recovery.cjs`, reconciliation) |
| Stale callback (old dispatch) | `verifyDispatchIdentity` -> `stale_dispatch` | rejected (audio/video: accepted while scene still WAITING_CHUNKS/MERGING) |
| Backend restart | `backend.cjs` deletes all dispatch leases on boot; `startup-resume.js` resumes sessions | scenes re-dispatched by scheduler |
| Redis loss | documented `docs/architecture/redis-failure-model.md` | reconciliation + client-triggered work-list rebuild |
| Retry decision | backend `retry-budget-manager.js` (hub never re-enqueues — "hub is dumb transport") | bounded retries, circuit breaker |

**Key property:** a dead worker never keeps a task forever — hub per-job timeout + lease expiry + scheduler re-dispatch already close that loop. This must be preserved for private queues.

---

## 3. Current Security Gaps (verified against code AND live containers)

### 3.1 CRITICAL — the entire GPU surface is public and unauthenticated

1. **nginx exposes `/gpu/` with no auth at all** on both `animastor.in` and `app.animastor.in`
   (`proxy/conf/default.conf:102-115, 226-239`). No `auth_basic`, no allow-list. Every hub endpoint is
   reachable from the internet.
2. **`GPU_HUB_API_KEY` is EMPTY in the running deployment** (verified via `docker exec` on both
   `animastor-backend` and `gpu-hub` containers; `.env` does not define it). `requireApiKey`
   (`gpu-hub.js:33-41`) explicitly degrades to **open access** when the key is unset:
   `if (!GPU_HUB_API_KEY) return next();`
   -> **`POST /task` (enqueue arbitrary jobs) and `DELETE /queue/clear` (wipe all queues of all tenants) are currently open to anyone.**
3. **`/beacon` has no authentication** (`gpu-hub.js:248-291`): anyone can register a fake worker with any
   `id`/`type` — worker identity is entirely client-invented (`worker.cjs:21`: `WORKER_ID || "gpu-" + os.hostname()`).
4. **`/task/next` has no authentication** (`gpu-hub.js:388-472`): the only gate is "worker id present in the
   registry" — which anyone can self-create via `/beacon` one request earlier. **Any internet client can drain
   any queue and receive other users' jobs** (full ComfyUI workflow = prompts, plus base64 reference images in
   `assets`).
5. **`/task/result` and `/task/error` have no authentication** (`gpu-hub.js:478, 591`): the only check is
   `dispatch_id` equality with the running record. Anyone who pulled a task via `/task/next` legitimately owns
   the `dispatch_id`; anyone who observes/guesses one can inject. `dispatch_id` is
   `dispatch-${Date.now()}-${Math.random().toString(36).slice(2,10)}` (`dispatch-engine.js:106-108`) —
   **non-cryptographic PRNG, ~41 bit of entropy**, and `job_id` structure is fully documented
   (`job-schema.js`: `{bookId}_{chapterId}_{sceneId}_{NNNN}:audio` etc.) -> enumerable.
6. **Backend callbacks `POST /gpu/task/result|error` have no authentication either**
   (`generation-routes.cjs:1255, 1343`). They are not directly exposed by nginx (only `/api/*`, `/health`,
   `/gpu/*` are proxied), so today the protection is **routing obscurity + docker network isolation**, not auth.
7. **`POST /api/v1/worker/heartbeat` is unauthenticated** (`generation-routes.cjs:490`): anyone can forge
   heartbeats and inflate/fake the worker counts shown in the UI.

### 3.2 CRITICAL — no workspace dimension in the GPU path

- Job payload carries `book_id/chapter_id/scene_id/stage/dispatch_id` but **no `workspace_id`**
  (`gpu-dispatcher.js:53-62`).
- Queues are **global per type** (`animastor:queue:image` etc.) — one FIFO shared by every tenant; the hub has
  no notion of who may pop.
- `animastor:running.worker` is the **client-supplied** query string from `/task/next` — forgeable, and never
  checked again anywhere (result/error do not verify that the submitter is the claimer).
- There is **no worker -> workspace binding anywhere** (no table, no key, no code path).

### 3.3 Operational gaps (adjacent, must be fixed before Beta)

- **`WORKSPACE_SECRET_KEY` is EMPTY in the running backend container** (verified) — Milestone-1 workspace AI
  keys are currently encrypted with the documented insecure dev fallback key
  (`workspace-ai-provider.js:29-39`). The current `docker-compose.yml` already declares it required
  (`:?set WORKSPACE_SECRET_KEY`); the live container predates that compose file. Restart with a real key will
  invalidate any provider rows written under the fallback key.
- `.env` lacks both `GPU_HUB_API_KEY` and `WORKSPACE_SECRET_KEY` entries entirely.

### 3.4 What currently authenticates / identifies a worker — direct answers

| Question | Answer (current code) |
|---|---|
| What authenticates a worker? | **Nothing.** No credential exists. |
| What identifies a worker? | Self-chosen `WORKER_ID` env (default `gpu-<hostname>`), sent in query/body. |
| How does a worker get identity? | Invents it locally; hub accepts any id via `/beacon`. |
| Where is worker identity stored? | Redis only (`animastor:gpu-hub:workers`, 15-min TTL). The PG `workers` table is dormant. |
| How does backend know workspace? | **It doesn't** — the GPU path has no workspace concept. |
| How does backend know owner? | Only via `job_id -> bookId -> books.workspace_id` at callback time (used for AI/book guards, not for worker authz). |
| How is a task linked to a worker? | `animastor:running.worker` = whatever the poller claimed; never verified afterwards. |
| Can a worker be forged? | **Yes, trivially** (beacon with any id). |
| Can someone take another's task? | **Yes** — poll the global queue. |
| Can someone submit a result for another's task? | **Yes** — with a valid/observed `dispatch_id` (or after claiming the task themselves). |

---

## 4. Worker Identity Proposal

Reuse the established house credential pattern (`sid.*` sessions, `gst.*` guests): a **prefixed opaque token**,
DB stores **hash only**, identity resolved server-side. No new credential *system* — same primitives
(`crypto.randomBytes` + SHA-256 + PG row), new table.

### 4.1 Table (repurpose the dormant `workers` table)

The dormant `workers` table (`schema.js:206-215`) is the natural home; the roadmap planned to drop it precisely
because it is unused — instead we give it its intended job. Migration (idempotent `ALTER`s in `schema.js` style):

```sql
-- workers (repurposed: Private Worker registry — durable source of truth)
worker_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),   -- server-generated (was TEXT self-chosen)
workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,  -- THE ownership anchor
name             TEXT NOT NULL,                                -- user-given label ("Home RTX 4090")
worker_type      TEXT NOT NULL CHECK (... 'audio','image','video'),  -- kept: one type per worker process
capabilities     JSONB,                                        -- kept (gpu model, vram — reported by beacon)
mode             TEXT NOT NULL DEFAULT 'private' CHECK (mode IN ('private','share')),  -- section 8
status           TEXT NOT NULL DEFAULT 'offline',              -- kept (derived, UI-facing)
token_hash       TEXT NOT NULL UNIQUE,                         -- SHA-256 of the secret part (hash only, like sessions/guests)
token_prefix     TEXT,                                         -- first chars for UI display ("wrk_ab12...")
created_by       UUID REFERENCES users(user_id),
revoked_at       BIGINT,                                       -- revoke = set timestamp (soft), row kept for audit
last_seen        BIGINT,                                       -- kept
version          TEXT, metadata JSONB, created_at              -- kept
```

- `ON DELETE CASCADE` from `workspaces` -> **guest purge automatically deletes the worker row** (section 13).
- `token_hash UNIQUE` -> lookup by hash is O(1); raw token never stored, never logged, never returned after
  issuance (identical contract to sessions/guests).

### 4.2 Credential format

```text
wrk.<worker_id_b64url>.<secret_b64url>     (secret = 32 random bytes)
```

- Mirrors `sid.`/`gst.` parsing (`session-repo.js:36-48`): the token self-locates the row, the hash proves it.
- Sent as `Authorization: Bearer wrk....` on every hub call (`/beacon`, `/task/next`, `/task/result`, `/task/error`).
- **Worker token != user session:** it resolves to a worker row, never to `req.user`; it cannot call `/api/v1/*`
  user endpoints, and a session cookie cannot poll the hub. Two disjoint identity namespaces.

### 4.3 Hub-side resolution (Redis mirror, PG authoritative)

gpu-hub today is Redis-only and must stay a dumb transport (no PG dependency added). The backend, which owns
the PG table, maintains an auth mirror:

```text
animastor:worker-auth          (hash: token_hash -> JSON {worker_id, workspace_id, mode, worker_type, name})
```

- Backend writes the mirror on create/rotate/revoke and re-syncs **all** valid rows on startup + periodically
  (Redis-loss recovery consistent with `redis-failure-model.md`: Redis empty -> backend rebuilds from PG).
- Hub resolves `Bearer token -> sha256 -> HGET animastor:worker-auth` per request.
- **Revocation is immediate**: backend deletes the mirror field + sets `revoked_at` in PG in one operation.
- Unknown/expired hash -> `401 worker_unknown`. All identity fields (`worker_id`, `workspace_id`) come **only**
  from the mirror — never from request bodies/queries.

---

## 5. Workspace Ownership Model

### 5.1 The invariant

```text
A PRIVATE worker belongs to exactly one workspace and can receive jobs ONLY of that workspace.
Workspace A's worker can NEVER receive Workspace B's job — even if worker_id / workspace_id / task_id
are forged, because none of those values are accepted from the client.
```

### 5.2 Chain (target state)

```text
generation request (authenticated user/guest, req.workspace)
  -> book (books.workspace_id — already enforced by existing guards)
  -> dispatch-engine resolves workspace_id server-side (book -> workspace, never client-supplied)
  -> gpu-dispatcher adds workspace_id to the job payload
  -> hub /task (authenticated by GPU_HUB_API_KEY, backend only) routes to the workspace queue
  -> worker polls /task/next with its token
  -> hub derives {worker_id, workspace_id} from the token
  -> hub pops ONLY from animastor:queue:{type}:ws:{workspace_id}
```

The client-supplied `?worker=` and `?type=` query parameters of `/task/next` become **informational at best**;
selection keys come from the credential.

### 5.3 Queue topology (minimal change to existing keys)

| Queue | Purpose | Who pops |
|---|---|---|
| `animastor:queue:{type}` (existing, unchanged) | **System pool** — jobs of workspaces that have no registered private worker | system workers (the current deployment) authenticated with a **system credential** (see 9.3) |
| `animastor:queue:{type}:ws:{workspace_id}` (new) | **Private pool** — jobs of a workspace that has >=1 active private worker of that type | only workers whose token resolves to that workspace_id |

Routing decision is made **at dispatch time in the backend** (it already knows `books.workspace_id` and the
worker registry): workspace has an active (non-revoked) worker of the needed type -> workspace queue; otherwise
-> system pool. This keeps the hub dumb: it only enqueues to the key the backend names, and only lets a worker
pop its own key.

**Beta policy (PRIVATE):** if the private worker is offline, its workspace's jobs **wait in the workspace
queue** — they must never silently leak into the system pool (that would violate the invariant). The UI shows
"worker offline — jobs waiting" (worker status is already surfaced in Settings, section 10). A configurable
wait-timeout -> fail with a clear reason is an open question (section 19 Q6).

### 5.4 Multi-workspace scenario

```text
User A / Workspace A / Worker A1 (token -> ws A)
User B / Workspace B / Worker B1 (token -> ws B)
```

- A1 polls -> hub pops only `queue:*:ws:A`. B's jobs physically live in different Redis lists -> **no cross-read possible**.
- A cannot control B1: worker management routes are guarded by workspace membership (the
  `settings-ai-routes.cjs` identityGuard pattern — workspace id from `req.workspace`, never from body).
  Knowing B1's `worker_id` (a UUID) grants nothing: every hub operation requires B1's **token**.
- A cannot submit a result for B's running task: hub checks `runningInfo.worker === authenticated worker_id` (section 7).

---

## 6. Task Ownership Model (lifecycle audit)

| State | Where | Who owns it | How ownership is verified (target) |
|---|---|---|---|
| create | backend dispatch-engine | the **workspace** owning the book (`books.workspace_id`) | existing book guards + server-side resolution |
| queued | Redis queue list | workspace (list key embeds `ws:{workspace_id}`) | only the owning workspace's workers can pop |
| claimed | `animastor:running` | workspace + **the specific worker** that popped (`worker_id` written by hub from the token) | hub writes `worker` from credential, not from client |
| running | `animastor:running` + hub heartbeat refresh | same worker | heartbeat refreshed by hub; per-job timeout watchdog |
| result | hub `/task/result` -> backend callback | only the **claiming worker** may submit | hub: `runningInfo.worker === auth.worker_id` AND `dispatch_id` match; backend: `verifyDispatchIdentity` (kept) |
| error | hub `/task/error` -> backend `failStage` | same | same |
| completed | `generation_tasks` (PG) | workspace | **populate `generation_tasks.worker_id`** (column already exists, never written) for audit |
| retry | backend retry-budget-manager | workspace | re-dispatch routes to the same workspace queue |
| timeout | hub sweep | — | task freed (HDEL running, LREM processing), backend notified, re-dispatched |
| cancellation | backend `cancelActiveDispatch` + `queue/clear?dispatch_id=` | workspace | hub cleanup already filtered by dispatch_id/book_id; extend filter to workspace scope |

**The workspace ownership boundary lives at the queue key + the credential resolution.** Everything downstream
(claim, result, error) is pinned to the worker identity the hub derived from the token at claim time.

---

## 7. Result Submission — Minimal Authorization Mechanism

Target check in hub `/task/result` and `/task/error` (two added conditions, both from already-available data):

```text
1. authenticate Bearer token -> {worker_id, workspace_id}        (401 if unknown/revoked)
2. runningInfo = HGET animastor:running job_id                   (existing)
3. runningInfo.dispatch_id === body.dispatch_id                  (existing)
4. runningInfo.worker === auth.worker_id                         (NEW — claimer-only submission)
5. runningInfo.workspace_id === auth.workspace_id                (NEW — belt & braces, stored at claim time)
```

- A stolen-but-valid token of Worker A still cannot submit for Worker B's task (check 4).
- Backend callbacks (`/gpu/task/result|error`) keep `verifyDispatchIdentity` and additionally require a
  **backend-internal shared secret** (`x-api-key`, same mechanism the backend already uses toward the hub) so
  the hub->backend hop is authenticated in both directions. Hub forwards the verified `worker_id` for audit
  logging / `generation_tasks.worker_id`.
- `dispatch_id` generation should move from `Math.random()` to `crypto.randomBytes` (`dispatch-engine.js:106`)
  — cheap hardening once submission is claimer-bound anyway.

---

## 8. Private Mode / Future Share Boundary

```sql
mode TEXT NOT NULL DEFAULT 'private' CHECK (mode IN ('private','share'))
```

- **Beta implements `private` only.** `share` exists solely as a schema value; every code path treats
  `mode !== 'private'` as unsupported -> such a worker is never scheduled (fail closed).
- No marketplace, credits, pricing, quotas, reputation, rental — nothing is built.
- The queue topology already accommodates SHARE later: a shared worker would additionally pop a **shared pool**
  key under a future policy module; the private queue invariant is untouched. The only future change is
  "which keys may this worker pop", i.e. scheduler/selection policy — not identity or ownership.
- UI: mode is displayed read-only as "Private". No toggle exists in Beta.

---

## 9. Credential Model & Registration

### 9.1 Credential contract (all requirements satisfied)

| Requirement | How |
|---|---|
| Secret issued once | Returned only in the POST create response; never stored raw |
| Backend stores hash only | `token_hash` SHA-256 UNIQUE (sessions/guests pattern) |
| No re-retrieval | GET endpoints return `token_prefix` mask only (`wrk_ab12...`), like `api_key_masked` in Milestone 1 |
| Revocable | `revoked_at` + mirror-field delete -> next hub request 401 |
| Rotatable | "Rotate" = issue new secret for the same worker row, invalidate old hash (atomic swap) |
| Not a user password | Separate namespace (`wrk.` prefix), no login/session semantics |
| Cannot use user API | Resolves to a worker row only; `/api/v1/*` guards require session/guest cookies |

**Worker token vs API key:** a **worker token** (per-worker, revocable, hash-only) rather than one shared API
key — because revocation/rotation must act on a single worker without rotating secrets of every other worker,
and because per-worker identity is needed for the claimer-only result check (section 7). The existing shared
`GPU_HUB_API_KEY` keeps its different job: authenticating the **backend->hub** and **hub->backend**
server-to-server hops.

### 9.2 Registration flow (Settings -> Workers)

```text
Settings -> Workers (new section, pattern of /settings/ai)
  Add Worker: name + type (audio|image|video)
    -> POST /api/v1/workers            (requireAuth + workspace from req.workspace)
    <- { worker_id, token }            <- shown ONCE with a copy box + docker run snippet
  Worker list: name, type, online/offline (heartbeat age), last_seen, current job, token_prefix
    Rotate -> new token shown once     Revoke -> immediate
```

- **Beta restriction: workers may be created only by authenticated users (`requireAuth`), not guests** (section 13).
- Online status = heartbeat freshness (hub already maintains it; Settings reads a workspace-scoped variant of
  the existing `/worker/counts` data).

### 9.3 System workers (the current deployment)

The operator's own workers on the remote GPU server keep working through the **system pool**: they receive a
`mode='private'` row bound to the seeded developer workspace (or a dedicated system credential — decision in
section 19 Q2). Jobs of workspaces without a registered worker continue to flow through the unchanged global
queue, so **existing generation is not broken on day one**.

---

## 10. Docker / Home UI — Minimal Configuration Contract

The worker today reads (`worker.cjs:16-34`): `HUB_URL`, `WORKER_TYPE`, `WORKER_ID`, `COMFY_PORT`,
`NOTEBOOK_PATH`, timeouts. The **only new required input is the token**; `WORKER_ID` becomes optional
(server-assigned identity wins; local value may remain as a display hint).

```text
ANIMASTOR_HUB_URL=https://animastor.in/gpu     (renamed from HUB_URL for clarity; keep HUB_URL as alias)
ANIMASTOR_WORKER_TOKEN=wrk.<worker_id>.<secret>
ANIMASTOR_WORKER_TYPE=image|audio|video        (kept)
```

- Same contract works for: local PC, Home UI box, dedicated GPU server (current reality), rented cloud GPU
  (RunPod direction — `docs/04-planning/RunPod_Integration_GPU_Hub.md` keeps its place: hub owns infra
  concerns, this milestone only adds identity to the existing protocol).
- `worker/new/start-worker.sh` currently hardcodes `HUB_URL` and has no token concept — it becomes the
  template for the user-facing bootstrap (token passed via env/file, never hardcoded).
- A minimal `worker/Dockerfile` + compose snippet is the delivery artifact (Phase 5); ComfyUI itself stays
  user-managed (worker talks to `127.0.0.1:COMFY_PORT` only).

---

## 11. Capabilities & Scheduling

- Today: one worker process = one ComfyUI = **one type** (`WORKER_TYPE`), beacon declares it, hub matches
  `type` on `/task/next` (`gpu-hub.js:407-413`). Scheduler "selection" is implicit: whoever pops the type queue.
- Beta keeps this exactly: registration fixes `worker_type`; the queue key already separates types; the
  workspace segment is the only new dimension. **No scheduler rewrite** — `runtime-scheduler`/`dispatch-engine`
  gain one lookup ("does this workspace have an active worker of this type?") to pick the target queue key via
  `gpu-dispatcher`.
- Beacon-reported `gpu`/`vram` stay informational (stored in `capabilities` JSONB for the Settings UI).

---

## 12. Heartbeat — Target Hardening

| Aspect | Current | Beta target |
|---|---|---|
| Auth | none (`/beacon` open) | Bearer worker token required |
| Worker identity | body `id` (client) | from token |
| Workspace identity | absent | from token; heartbeat key gains workspace awareness |
| last_seen/status | Redis registry, 15-min hash TTL | unchanged mechanism; mirrored to `workers.last_seen` best-effort for Settings |
| Capabilities | body `gpu`/`vram` | unchanged, stored in `capabilities` |
| Stale handling | hub sweep level 2 + registry prune | unchanged (works, keep it) |
| Forged worker_id / workspace_id | trivially possible | **impossible** — both come from the credential |
| `POST /api/v1/worker/heartbeat` | open, unused by real workers | **remove or require a worker token** (forged UI counts today) |

---

## 13. Guest Workspace Interaction

- **Beta decision: guests cannot create workers** (`requireAuth` on all `/api/v1/workers` routes). A guest
  workspace therefore never has a worker; its jobs use the system pool — zero new surface for the guest purge.
- If worker creation is ever opened to guests, the design is already safe by construction:
  `workers.workspace_id` FK `ON DELETE CASCADE` -> `guest-repo.purgeExpired` (`guest-repo.js:176-214`) deletes
  the workspace -> worker row cascades away -> backend mirror sync drops the auth entry -> credential dead.
  Pending tasks: purge must additionally clear the workspace queue + running entries (extend the existing
  `queue/clear` ownership filter with `workspace_id`) and fail in-flight stages via the existing
  `cancelActiveDispatch` path — same machinery as book deletion, no new recovery system.
- Guest -> registered conversion (`convertTemporaryWorkspace`) keeps `workspace_id` stable -> workers (future)
  would survive conversion untouched.

---

## 14. Failure / Recovery Model (what changes, what is kept)

| Scenario | Behavior in the private-worker design |
|---|---|
| worker dies mid-task | unchanged chain: hub per-job timeout -> `worker_timeout` -> backend `failStage` -> retry budget -> **re-dispatch into the same workspace queue**; another pop by the same (restarted) worker or wait |
| network gone / heartbeat stops | heartbeat TTL 30s expires -> worker shown offline; hub stale-GPU sweep frees its running tasks (existing) |
| task result never arrives | per-job timeout + dispatch-lease expiry + scheduler re-dispatch (existing); result mailbox recovery (existing) |
| backend restart | leases wiped on boot (existing), mirror re-synced from PG on startup (new, mirrors redis-failure-model doctrine) |
| Redis restart/loss | queues lost (existing documented behavior); **worker auth mirror rebuilt from PG** (new); workers simply re-beacon and re-poll |
| worker reconnects | beacon with token -> registry + heartbeat restored; no re-registration needed |
| task owned by dead worker forever | **impossible** — hub timeout sweep + `animastor:running` cleanup already prevent it; private queue only means the re-dispatched job waits for its workspace's worker instead of leaking to the pool |
| revoked worker mid-task | its in-flight result is still accepted iff claimer-check passes and the dispatch is current (decision: revocation blocks new polls immediately; finishing the current job is allowed — avoids wasting 30-min video gens; section 19 Q5) |

**Minimal recovery addition:** one backend startup/periodic job — "sync `animastor:worker-auth` from PG" —
reusing the existing reconciliation loop home (`runtime/reconciliation-engine.js`), no new storage architecture.

---

## 15. Redis vs Database Placement (existing doctrine preserved)

| Data | Store | Rationale |
|---|---|---|
| Worker registration, credential hash, mode, revocation | **PG** (`workers`) | durable source of truth; cascades with workspace |
| Worker auth fast-path mirror | **Redis** (`animastor:worker-auth`) | hot per-request lookup in the hub; rebuilt from PG |
| Online status / last_seen / busy | **Redis** (existing heartbeat keys) | ephemeral operational state, TTL-driven |
| Task queues (system + per-workspace) | **Redis** (existing + `:ws:` keys) | unchanged doctrine |
| Claim/running records, leases, dedup | **Redis** (unchanged) | unchanged |
| Task history incl. `worker_id` | **PG** `generation_tasks` | durable audit (column exists, finally populated) |

---

## 16. Threat Model

| # | Threat | Current protection | Required Beta protection |
|---|---|---|---|
| 1 | Stolen worker token | none (no token exists) | revocation + rotation from Settings; hash-only storage limits DB-leak value; token != user session; per-worker scope limits blast radius |
| 2 | Forged worker_id | none — id is client-supplied | identity derived from token only; body/query ids ignored |
| 3 | Forged workspace_id | none — concept absent from GPU path | workspace derived from token; queue key chosen by hub from credential; payload workspace_id set by backend only |
| 4 | task_id / job_id guessing | job_id format public; dispatch_id ~41-bit Math.random | claimer-only result check (knowing job_id insufficient); dispatch_id from `crypto.randomBytes` |
| 5 | Result injection | dispatch_id equality only | token auth + `runningInfo.worker === auth.worker_id` + dispatch match; backend hop gets x-api-key |
| 6 | Task stealing | anyone can `/task/next` any queue | per-workspace queues + token-scoped pop |
| 7 | Cross-workspace polling | possible (global queues) | physically separate queue keys; hub pops only the caller's workspace key |
| 8 | Replay (resubmit old result) | dedup keys + stale_dispatch rejection | kept (dedup, `verifyDispatchIdentity`, running-record deletion on completion) |
| 9 | Revoked worker keeps working | n/a | mirror field deleted on revoke -> next request 401; in-flight policy per section 14 |
| 10 | Stale/dead worker holds tasks | hub timeout sweep (works) | kept unchanged; re-dispatch confined to workspace queue |
| 11 | Malicious worker (owns valid token) | n/a | confined to own workspace's jobs by construction; result size/type validation stays in backend task-handler (existing); it can only harm its own workspace's generation |
| 12 | Malicious workspace user | book guards exist | can only create workers in own workspace (membership guard); cannot enumerate/attack other workspaces (tokens unguessable, ids useless); own-GPU jobs are his own assets |
| 13 | Open admin surface (`/queue/clear`, `/task`) | **GPU_HUB_API_KEY empty in prod** | set the key (operational prerequisite, Phase 0); nginx: keep `/gpu/` public for workers but admin endpoints stay key-gated |

---

## 17. Minimal Implementation Plan (6 phases)

**Phase 0 — Operational prerequisites (no feature code).**
Set `GPU_HUB_API_KEY` and `WORKSPACE_SECRET_KEY` in `.env`, restart stack; verify `/task` and `/queue/clear`
answer 401 without the key. (Without this, everything else is moot.)

**Phase 1 — Worker identity & credential (backend).**
Repurpose `workers` table (migration in `schema.js` style); new `worker-repo.js`; token issue/rotate/revoke
following `session-repo`/`guest-repo` pattern; `animastor:worker-auth` mirror sync (startup + reconcile loop).

**Phase 2 — Hub authentication & workspace queues (gpu-hub + dispatcher).**
Bearer-token middleware on `/beacon`, `/task/next`, `/task/result`, `/task/error`; identity from credential;
`/task` accepts `workspace_id` from the (key-authenticated) backend and enqueues to
`queue:{type}:ws:{workspace_id}` when present; `/task/next` pops the caller's workspace key; system pool and
`GPU_HUB_API_KEY` semantics unchanged. `gpu-dispatcher`/`dispatch-engine`: resolve workspace (book ->
`books.workspace_id`), pick target queue, add `workspace_id` to payload; `crypto.randomBytes` dispatch_id.

**Phase 3 — Task authorization & callback hardening.**
Claimer-only result/error checks (section 7); store `workspace_id` in `animastor:running` at claim; hub->backend
hop gets `x-api-key`; populate `generation_tasks.worker_id`; lock down `POST /api/v1/worker/heartbeat`.

**Phase 4 — Registration & Settings UI.**
`/api/v1/workers` CRUD (requireAuth, workspace from `req.workspace`, settings-ai-routes guard pattern);
Settings -> Workers section (list/add/rotate/revoke, online/last_seen) in `SettingsPage.tsx` following the
`/settings/ai` implementation.

**Phase 5 — Worker client & deployment artifacts.**
`worker.cjs`: `Authorization` header on all hub calls, token env (`ANIMASTOR_WORKER_TOKEN`, `HUB_URL` alias),
server-assigned identity; updated `start-worker.sh` template; minimal Dockerfile + run instructions
(remote-GPU-first, per deployment reality).

**Phase 6 — Tests & security verification.**
Mocha suite (real PG + fetch-stub pattern of `workspace-ai-provider.test.js`, `gpu-hub-cleanup.test.js`):
token lifecycle, cross-workspace isolation (A1 cannot take B jobs), claimer-only results, revocation
immediacy, guest non-access, redis-loss mirror rebuild; then an independent red-team audit round as done for
Milestone 1.

---

## 18. Change Surface

### MUST change

| File / module | Change |
|---|---|
| `gpu-hub/gpu-hub.js` | token auth middleware; workspace-scoped queue keys; claimer-check in result/error; workspace_id in running record |
| `worker/worker/worker.cjs` | Authorization header; token env; identity from server |
| `backend/src/storage/postgres/schema.js` | `workers` table migration (workspace_id, token_hash, mode, revoked_at, UUID pk) |
| `backend/src/storage/postgres/repositories/` | **new** `worker-repo.js` |
| `backend/src/services/` | **new** workspace-worker service (issue/rotate/revoke/mirror sync) — pattern of `workspace-ai-provider.js` |
| `backend/src/runtime/gpu-dispatcher.js` | workspace_id in payload, target-queue hint |
| `backend/src/runtime/dispatch-engine.js` | workspace resolution for routing; crypto dispatch_id; mirror sync hook |
| `backend/src/routes/` | **new** `worker-routes.cjs` (Settings CRUD); harden `/gpu/task/result\|error` (x-api-key); lock `/api/v1/worker/heartbeat` |
| `frontends/app/src/pages/SettingsPage.tsx` (+ i18n, router) | Workers section |
| `worker/new/start-worker.sh`, `.env.example`, `docker-compose.yml` | token env, key enforcement |
| `proxy/conf/default.conf` | (optional) nothing new exposed; app-layer auth lands on `/gpu/` worker endpoints |

### SHOULD NOT change (explicitly preserved)

- Orchestration: `orchestration/*`, `audio-orchestrator.js`, `video-orchestrator.js`, scene pipeline,
  `audio/generation.js`, `image/iu-processor.js` — they call `gpu.send/sendUnified` and never touch queues.
- Job schema & protocol: `job-schema.js` format, `PROTOCOL_VERSION` semantics (bump only if payload changes).
- Redis doctrine: existing keys keep their meaning; only **additions** (`:ws:` queues, `worker-auth` mirror).
- Recovery machinery: `reconciliation-engine`, `lease-manager`, `retry-budget-manager`, `audio-recovery`,
  `startup-resume` — reused as-is.
- Auth stack: sessions/guests/book guards untouched; worker identity is a parallel namespace.
- Existing workers of the current deployment keep running through the system pool (section 9.3).

---

## 19. Open Questions

1. **System pool policy for Beta:** should workspaces *without* a registered worker keep using the operator's
   GPU (system pool) at all, or is Beta "own GPU only" from day one? This document assumes the system pool
   stays (backward compatibility) — product decision needed.
2. **System worker credential:** bind the operator's workers to the seeded developer workspace as ordinary
   private workers, or introduce a dedicated `mode='system'` credential? Recommendation: ordinary private
   workers of the developer workspace (no new concept).
3. **One worker per type per workspace?** Multiple workers of the same type in one workspace already work
   (any of them may pop). No limit proposed for Beta — confirm.
4. **Worker registration for guests:** this document forbids it (section 13). Confirm.
5. **Revocation mid-task:** allow the in-flight job to finish (recommended, avoids wasting long video gens)
   or hard-kill it immediately? Recommendation: finish allowed, new polls blocked.
6. **Offline private worker:** jobs wait indefinitely in the workspace queue (recommended) or fail after a
   configurable wait timeout? Recommendation: wait + UI warning; no auto-fallback to system pool.
7. **`/gpu/` exposure:** keep the whole hub public (worker endpoints now token-authenticated, admin endpoints
   key-gated) or additionally IP-restrict? Recommendation: app-layer auth is sufficient for Beta.
8. **`animastor:processing` list:** currently a single global claimed-task list; with workspace queues it
   becomes per-queue or stays global (it is only a crash-recovery aid). Recommendation: keep global, it
   carries no tenant data beyond the task payload itself.

---

## 20. Final Recommended Scheme

```text
User (session cookie, sid.*)
  |
Workspace (workspaces.id — ownership boundary, books.workspace_id)
  |
Worker (workers row: UUID, workspace_id FK CASCADE, worker_type, mode='private')
  |
Credential (wrk.<worker_id>.<secret> — shown once; PG stores SHA-256 hash only;
            Redis mirror animastor:worker-auth for hub fast-path)
  |
Hub (gpu-hub: Bearer auth -> identity from credential;
     enqueues by backend to queue:{type}:ws:{workspace_id};
     worker pops ONLY its own workspace queue;
     result/error accepted ONLY from the claiming worker)
  |
Job (payload carries server-resolved workspace_id; dispatch_id crypto-random;
     lease + retry budget + verifyDispatchIdentity unchanged)
  |
GPU (user's ComfyUI on user's hardware — local PC / Home UI / GPU server / cloud)
```

- **Identity:** token-derived, never client-supplied; worker token and user session are disjoint namespaces.
- **Authorization:** queue-key isolation (workspace) + claimer-only submission (worker) + dispatch identity (job).
- **Ownership:** `workspaces -> workers` CASCADE; `books.workspace_id` resolved server-side at dispatch.
- **Lifecycle:** create/rotate/revoke in Settings; online/offline via existing heartbeats; audit via
  `generation_tasks.worker_id`.
- **Failure recovery:** existing timeout/lease/re-dispatch chain preserved; new mirror rebuild from PG covers
  Redis loss; a dead worker can never hold a task permanently.
- **SHARE boundary:** `mode` column exists, `private` is default and the only scheduled mode; SHARE is a
  future queue-pop policy change, not an identity change.

