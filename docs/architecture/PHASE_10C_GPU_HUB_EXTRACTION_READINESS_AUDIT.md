# PHASE 10C — GPU Hub Extraction Readiness Audit (final pre-extraction)

**Status:** COMPLETE — audit only. No physical extraction, no package
publication, no production behavior change, zero source/config/guard
changes.
**Date:** 2026-09-06
**Baseline:** HEAD `e67b0014` ("gpu-hub: Phase 10B — consume Job Protocol v2
from @animastor/contracts (Docker seam + guard re-anchoring)")
**Scope decision recorded:** GPU Hub **stays in the monorepo** after 10C.
Physical extraction (Phase 10D) is **planned but not scheduled**; this audit
fixes the boundary so the future extraction is a mechanical move.
**Related:** GPU_HUB_CONTRACT.md (frozen contract),
PHASE_10A_GPU_HUB_CONTRACT_FREEZE_AUDIT.md,
PHASE_10B_GPU_HUB_PROTOCOL_MIGRATION_AUDIT.md,
PHASE_10_GPU_HUB_EXTRACTION_READINESS_AUDIT.md (verdict B).

---

## 0. Final verdict

**READY AFTER PREPARATION.**

The GPU Hub is **code-extraction-ready** (zero outbound imports, one
sanctioned package dependency, frozen 14-route contract, machine-enforced
Redis ownership, dependency tree properly untracked) but **not yet
package-extraction-ready**. The remaining items are declarative 10D work,
not 10C work:

| # | Item | Severity | Fixed in 10C |
|---|---|---|---|
| 1 | `@animastor/contracts` consumed via the Phase 10B compose mount but
not declared in `gpu-hub/package.json` | MEDIUM (works in the monorepo via
repo-root symlink + compose mount; breaks only in a standalone registry
install) | No — recorded as the designed 10D step (§9 step 1). |
| 2 | `animastor:worker-auth` read-side dependency on a backend-maintained
Redis key | MEDIUM (frozen known limitation, contract §8.2) | No — frozen
debt; recorded, not fixed (out of scope). |
| 3 | Five artifact inputs are fed by sibling-repo bind mounts with no
published-artifact pipeline | MEDIUM (deployment coupling, §2.1/§3.3) | No —
feed options designed (§3.3); hub code needs no change under any option. |

Everything else in this document is a **map**, not a blocker: deployment
coupling (compose/nginx service name `gpu-hub:5000` + public `/gpu/`
prefix), the five read-only artifact mounts, and the cross-owner Redis
writes are all contract-frozen seams that survive extraction unchanged.

**Negative finding recorded (checked and cleared):** during the audit a
suspected defect — `gpu-hub/node_modules/` (81 packages, 2 879 files)
being physically committed because the root `.gitignore` rule might not
match the nested path — was **disproved**: gitignore rules without a
leading slash match at any depth, `git check-ignore` confirms
`gpu-hub/node_modules/**` is ignored, and `git ls-files gpu-hub/` lists
exactly the 7 source/manifest files (`Dockerfile`, `bootstrap.js`,
`gpu-hub.js`, `package.json`, `package-lock.json`, `server.js`,
`tarball.js`). The vendored tree on disk is a working-tree-only artifact
rebuilt by `npm ci` from the committed lockfile — and as such it doubles
as the offline extraction vehicle for 10D (§6.1). No `.gitignore` change
was needed or made.

---

## 1. Dependency boundary (code level)

**Method:** exhaustive `require()`/`import` scan of the 4 hub source files
(`gpu-hub.js` 2 036 lines, `bootstrap.js` 406, `tarball.js` 112,
`server.js` 39) + `package.json` + runtime resolution checks. Enforced
going forward by `dependency-guardrails.test.js` R2 (no new backend/code
deps) and `phase7-extraction-readiness.test.js` P7-T3 (nothing requires
INTO gpu-hub/).

### 1.1 Node built-ins

| Module | Location |
|---|---|
| `crypto` | gpu-hub.js:26 |
| `fs` | gpu-hub.js:27 |
| `path` | gpu-hub.js:28 |
| `zlib` | tarball.js:14 |

### 1.2 npm packages

| Package | Declared in gpu-hub/package.json | Required at |
|---|---|---|
| `express ^4.19.2` | ✅ | gpu-hub.js:24 |
| `cors ^2.8.5` | ✅ | gpu-hub.js:25 |
| `ioredis ^5.10.0` | ✅ | server.js:6, gpu-hub.js:1988 (standalone-start branch) |
| `@animastor/contracts` | ❌ **NOT declared** (by design, Phase 10B Option A) | gpu-hub.js:39 |

`@animastor/contracts` resolution paths today:
- **Local dev:** Node walks up from `gpu-hub/` to the repo root and finds
  `node_modules/@animastor/contracts -> ../../contracts` (symlink).
- **Container:** compose read-only mount
  `./contracts:/app/node_modules/@animastor/contracts:ro`
  (docker-compose.yml:128) — the Phase 10B seam, identical to the backend
  service's mount (line 98).
- **Docker build:** NOT resolvable at build time (build context is
  `./gpu-hub` only; `file:../contracts` cannot resolve) — which is exactly
  why Option A (mount, not package.json dependency) was chosen in 10B and
  why the dependency stays undeclared.
- No `NODE_PATH` is used anywhere.

### 1.3 Outbound relative imports

**NONE.** The only relative requires are internal:
`gpu-hub.js:29 → ./tarball`, `gpu-hub.js:30 → ./bootstrap`,
`server.js:3 → ./gpu-hub`.

Confirmed absence (verified by scan + P7-T3 + dependency-guardrails R2):
- ❌ no runtime `require` of backend — **backend coupling is HTTP
  (`BACKEND_URL` callbacks) + shared Redis keys only**;
- ❌ no `require` of worker (the worker source is consumed as a **file**
  via mounts, never as a module);
- ❌ no `require` of frontend;
- ❌ no hidden relative imports leaving `gpu-hub/`.

### 1.4 Env vars read by the hub process

| Var | Default (server.js / gpu-hub.js) | Purpose |
|---|---|---|
| `REDIS_URL` | `redis://animastor-redis:6379` | Redis connection (URL-only; no host/port/password split) |
| `PORT` | `5000` | HTTP listen port |
| `BACKEND_URL` | `http://animastor-backend:3000` | result/error callback base |
| `GPU_HUB_API_KEY` | null | backend-plane key, fail-closed |
| `GPU_HUB_ALLOW_OPEN` | null | dev-only fail-open opt-out |
| `GPU_TIMEOUT_MS` / `GPU_TIMEOUT` | `600000` | per-job/per-GPU timeout (legacy fallback chain) |
| `SHARE_FEATURES_ENABLED` | off | SH-1/SH-2 kill-switch (must match backend) |
| `ORPHAN_GRACE_MS` | `60000` | orphan sweep grace (read at require time, module scope) |
| `MAX_ORPHAN_REQUEUES` | `3` | orphan requeue cap → dead-letter (module scope) |

Env names referenced by the **generated bootstrap launchers** (part of the
public installer contract, not hub config): `ANIMASTOR_HUB_URL`,
`ANIMASTOR_PROFILE`, `ANIMASTOR_MODE`; actively rejected credential vars
`ANIMASTOR_WORKER_TOKEN` / `WORKER_TOKEN` / `WORKER_KEY` (bootstrap.js:79, 266).

### 1.5 External services (runtime)

| Service | Address | Protocol | Direction |
|---|---|---|---|
| Redis | `animastor-redis:6379` (REDIS_URL) | RESP (ioredis) | data-plane transport + auth mirror |
| Backend | `animastor-backend:3000` (BACKEND_URL) | HTTP POST | hub → backend only: `/gpu/task/result`, `/gpu/task/error` (5 retries × 500 ms, x-api-key) |
| Filesystem | 5 read-only mounts (§3) | file reads | hub performs ZERO filesystem writes |

No PostgreSQL. No WebSocket. No pub/sub, no keyspace notifications, no
blocking pops, no Redis modules (contract §8, machine-enforced by
`redis-ownership.test.js` command allowlist).

### 1.6 Dependency-boundary verdict

The code-level boundary is **complete and clean**: one sanctioned monorepo
package dependency (`@animastor/contracts`, compose-mount seam, undeclared
by design until 10D publishes it), three declared npm deps, four built-ins,
zero outbound code imports. `dependency-guardrails.test.js` R2 freezes
"no new package/code deps" and `phase7` P7-T3 freezes "no inbound
requires". The only undeclared item (`@animastor/contracts`) is a
documented Phase 10B decision with a mandatory runtime seam — after
extraction it becomes a normal `dependencies` entry (§9 step 1).

---

## 2. Deployment coupling map ("who → knows what → survives extraction?")

Full literal scan of every non-`gpu-hub/` file mentioning the hub (docs/
excluded — 686 doc matches are informational only and never executed).

### 2.1 docker-compose.yml (runtime-critical)

| Line | What it knows | Survives extraction? |
|---|---|---|
| :52 | backend env `HUB_URL=http://gpu-hub:5000` (compose DNS name) | ✅ if the standalone container joins the same Docker network with name/alias `gpu-hub`; else a one-line env change (contract §15.4 requires coordinated rollout) |
| :69 | backend `GPU_HUB_API_KEY=${GPU_HUB_API_KEY:-}` | ✅ env contract, no path knowledge |
| :85 | backend `SHARE_FEATURES_ENABLED` must match hub's | ✅ env contract |
| :105-107 | service `gpu-hub:`, `build: ./gpu-hub`, `container_name: gpu-hub` | ❌ becomes a registry image / external compose include; name `gpu-hub` must be preserved as network alias |
| :113,:116,:121 | hub env `GPU_HUB_API_KEY`, `GPU_TIMEOUT`, `SHARE_FEATURES_ENABLED` | ✅ moves with the service definition |
| :128 | contracts mount `./contracts:/app/node_modules/@animastor/contracts:ro` | ⚠️ replaced by a real npm dependency (or a version-pinned mount) in 10D |
| :133 | `./worker/worker/worker.cjs:/app/worker-source/worker.cjs:ro` | ❌ cross-repo mount after extraction → must become a published artifact or a CI-synced volume |
| :136 | `./worker/worker:/app/worker-bundle:ro` | ❌ same |
| :138 | `./backend/ai/workflows:/app/workflows:ro` | ❌ same |
| :140 | `./backend/src/installer:/app/installer-src:ro` | ❌ same |
| :141 | `./backend/ai/install-manifests:/app/install-manifests:ro` | ❌ same |

No `depends_on: gpu-hub` anywhere (backend depends only on
postgres/redis) — startup order is already decoupled.

### 2.2 nginx proxy (public exposure)

| File:line | What it knows | Survives? |
|---|---|---|
| `proxy/conf/default.conf:13-15` | `upstream gpu_hub_upstream { server gpu-hub:5000 resolve; }` | ✅ with preserved network alias; else one-line upstream change |
| `proxy/conf/default.conf:127-141, :309-320` | two `location /gpu/` blocks → `proxy_pass http://gpu_hub_upstream/` | ✅ public `/gpu/` prefix is FROZEN (contract §15.4); consumed by worker, frontends, installer, book-deletion |
| `proxy/docker-compose.yml:46-51` | dev-proxy `location /gpu/` → `http://gpu-hub:5000/` | ✅ same condition |

### 2.3 backend source (consumers of the hub)

| File | Coupling | Type |
|---|---|---|
| `src/config/runtime-config.js:236` | `GPU_HUB_API_KEY` env read (:217 SYNC comment) | env contract ✅ |
| `src/runtime/gpu-dispatcher.js:197-200` | `POST {HUB_URL}/task` + x-api-key (T9) | HTTP contract ✅ |
| `src/runtime/dispatch-engine.js:833-1360` | `DELETE {HUB_URL}/queue/clear` cleanup calls | HTTP contract ✅ |
| `src/routes/generation-routes.cjs:48-56` | `requireHubCallbackAuth` for hub→backend callbacks | HTTP contract ✅ |
| `src/routes/worker-routes.cjs:414` | **direct Redis write**: `hdel('animastor:gpu-hub:workers', …)` on worker purge | cross-owner Redis write (frozen debt, registry line 106-112) ⚠️ survives only while both share Redis |
| `src/routes/worker-routes.cjs:411` | `DEL animastor:worker:heartbeat:*` on purge | same (frozen debt) |
| `src/services/worker-auth.js:29` | writes `animastor:worker-auth` — the hub's auth source | Redis contract ✅ (frozen §8.2) |
| `src/book/book-deletion.cjs:184-186` | `HUB_URL` + `GPU_HUB_API_KEY` for artifact deletion probes | env + HTTP ✅ |
| `src/installer/engine/worker.js` | downloads `/worker-bundle`, `/worker-source` fallback | public HTTP ✅ |
| `src/installer/safety-rules.js:48` | `GPU_HUB_API_KEY` in redaction list | env contract ✅ |
| `src/runtime/worker-health.js` | reads `animastor:worker:heartbeat:*` | Redis contract ✅ |
| `src/services/audio-recovery.cjs`, `redis-helpers.cjs` | read/DEL `animastor:result:*` / `animastor:error:*` / `animastor:job:*` | Redis contracts (registry-baselined cross-owner writes, §4.4) ✅ |
| `src/runtime/job-schema.js` | contracts facade (hub has its own direct import) | package seam ✅ |

### 2.4 worker / frontends / scripts / docker tooling

| Consumer | Knowledge | Survives? |
|---|---|---|
| `worker/worker/worker.cjs:28` | `HUB_URL` env, default `https://animastor.in/gpu`; uses `/beacon`, `/task/next`, `/task/result`, `/task/error` | ✅ pure HTTP; public `/gpu/` prefix frozen |
| `worker/start-worker.sh:191`, `worker/new/start-worker.sh:133`, `worker/worker/.env.example:7` | `HUB_URL` default | ✅ |
| `frontends/app/src/features/workers/privateWorkers.ts:106-124` | `${origin}/gpu`, `${HUB_URL}/worker-source` | ✅ public URL contract |
| `frontends/app/.../workerSetup.ts:206` | `/gpu/installer` artifact URL | ✅ |
| `gpu-hub-rebuild.sh:11-23` | `docker compose build/up/restart/logs gpu-hub` | ❌ monorepo dev tooling; moves/retires with extraction |
| `scripts/syntax-smoke.sh:57-84` | source-lints `ROOT_DIR/gpu-hub` | ⚠️ dev-only; harmless until extraction, then updated |
| `scripts/animastor-runtime-audit.sh:72,427,691` | `GPU_HUB_API_KEY` secret-scan + doc text | ✅ env contract |
| `docker/e2e/dispatch-task.cjs:19` | `docker exec gpu-hub printenv GPU_HUB_API_KEY` | ⚠️ dev e2e tool; container name coupling, update at 10D |
| `.env` / `.env.example` | `GPU_HUB_API_KEY`, `GPU_TIMEOUT`, `HUB_URL` | ✅ env contract (frozen §12) |

### 2.5 Deployment-coupling verdict

Deployment coupling is **name-level, not path-level**, except the five
compose source mounts. Three coupling classes after extraction:
1. **Preserve names** (zero code change): Docker network alias `gpu-hub`,
   port 5000, public prefix `/gpu/`, env var names — all contract-frozen
   (§15.4).
2. **Replace the build stanza**: `build: ./gpu-hub` → `image:
   <registry>/gpu-hub:<tag>` (10D step 4).
3. **Replace the five artifact mounts** (§3): they are monorepo
   development couplings, not runtime requirements — the hub only needs
   *some* directory content at those mount points. Post-extraction options
   are ranked in §3.3.

---

## 3. Filesystem / artifact coupling

### 3.1 Mount inventory (all read-only; hub performs ZERO filesystem writes)

| Container path | Config var (gpu-hub.js) | Compose source | Consumer route |
|---|---|---|---|
| `/app/worker-source/worker.cjs` | `WORKER_SOURCE_PATH` (:1296-1297) | `./worker/worker/worker.cjs` | GET /worker-source (deprecated) |
| `/app/worker-bundle` | `WORKER_BUNDLE_DIR` (:1328) | `./worker/worker/` | GET /worker-bundle(+/sha256) |
| `/app/workflows` | `WORKFLOW_DIR` (:1329) | `./backend/ai/workflows/` | GET /workflow/:id |
| `/app/installer-src` | `INSTALLER_SRC_DIR` (:1330) | `./backend/src/installer/` | GET /installer(+/bundle,/sha256) |
| `/app/install-manifests` | `INSTALLER_MANIFESTS_DIR` / `INSTALLER_WORKFLOWS_DIR` (:1331-1332) | `./backend/ai/install-manifests/` | allowlist for /workflow + /installer content |
| `/app/node_modules/@animastor/contracts` | — | `./contracts/` (10B seam) | require at module load |

All five artifact paths are **config-object overridable** (contract §12
`[IMPLEMENTATION DETAIL]`) — none is a hardcoded host path.

### 3.2 Classification: runtime vs monorepo coupling

**Mandatory runtime couplings (the standalone hub keeps these):**
- The **role** of each mount: artifact inputs read at request time, secret
  filtering on the fly (`isServableBundleFile` never serves `.env` /
  `.env.*` except `.env.example`, tarball walk excludes `node_modules` and
  `.git` — tarball.js:103, gpu-hub.js:1370-1374).
- The **tarball layout literals** the hub authors
  (`animastor-worker/…`, `animastor-installer/src/installer/…`,
  `animastor-installer/ai/install-manifests/…`,
  `animastor-installer/backend/ai/workflows/…`,
  `animastor-installer/worker/worker/…`, gpu-hub.js:1406-1718) — frozen
  contract §15.4; the installer engine depends on the prefix
  (worker.js:251).
- **Version sources**: `WORKER_BUNDLE_DIR/package.json` (worker bundle),
  `INSTALLER_SRC_DIR/package.json` (installer) — read at request time;
  missing → 404, never a versionless artifact (contract §6.2/§6.5).
- Write access: **none**. The hub never writes the host filesystem
  (contract §12 frozen).

**Monorepo/development couplings (do NOT survive extraction as-is):**
- The compose *bind-mount sources* pointing at sibling repo dirs
  (`./worker/…`, `./backend/…`) — pure development convenience.
- `gpu-hub/node_modules/` vendored tree — working-tree-only (git-ignored,
  verified), rebuilt by `npm ci`; a build-time (not git-level) coupling.
- `/worker-bundle` **as a compose source path** (`./worker/worker`) — the
  string `/worker-bundle` inside hub code is just the container mount
  target; the coupling to the repo's `worker/` directory lives only in
  docker-compose.yml.

### 3.3 Post-extraction feed options for the five artifact inputs (10D decision, recorded not chosen)

1. **Versioned artifact mounts (recommended):** CI in the backend/worker
   repos publishes `worker-bundle.tgz`, `installer.tgz`, workflows and
   manifests as release artifacts; the hub deployment pulls/mounts pinned
   versions. Preserves "hub is a dumb artifact server" with zero hub-code
   change (dirs stay, sources change).
2. **Registry images as mount sources:** build `animastor/artifacts`
   images; compose mounts named volumes from them.
3. **Mirror sync:** a scheduled job rsyncs from the sibling repos (weakest:
   reintroduces deployment-order coupling).

Hub code needs **no change** under any option (mount-target contract
frozen).

---

## 4. Backend ↔ GPU Hub contract (extraction survivability)

The Phase 10A frozen contract (GPU_HUB_CONTRACT.md) is exactly the
extraction contract. Verified against the current code:

### 4.1 HTTP — frozen 14 routes, re-verified at this HEAD

| # | Method | Path | Auth | gpu-hub.js |
|---|---|---|---|---|
| 1 | POST | `/beacon` | Worker Bearer | :672 |
| 2 | POST | `/task` | x-api-key | :741 |
| 3 | GET | `/task/next` | Worker Bearer | :869 |
| 4 | POST | `/task/result` | Worker Bearer + claimer | :1057 |
| 5 | POST | `/task/error` | Worker Bearer + claimer | :1206 |
| 6 | GET | `/worker-source` | none (DEPRECATED, `Deprecation` header) | :1299 |
| 7 | GET | `/worker-bundle` | none | :1420 |
| 8 | GET | `/worker-bundle/sha256` | none | :1443 |
| 9 | GET | `/workflow/:id` | none (allowlist) | :1500 |
| 10 | GET | `/installer` | none | :1593 |
| 11 | GET | `/installer/bundle` | none | :1760 |
| 12 | GET | `/installer/sha256` | none | :1777 |
| 13 | GET | `/health` | none | :1796 |
| 14 | DELETE | `/queue/clear` | x-api-key | :1823 |

Set equality is pinned by `phase10a-gpu-hub-contract-freeze.test.js` —
route set verified identical to §3 of GPU_HUB_CONTRACT.md at this HEAD.
**No new API added in 10C.** All routes survive extraction: HTTP has no
path-level coupling to the monorepo; the public `/gpu/` prefix and service
name are deployment-identity items (§15.4), not code items.

### 4.2 Redis — the shared data-plane contract

Transport-only usage (no pub/sub, no streams, no blocking ops) means the
hub's Redis contract needs only: network reachability + the same
credentials + the same key families. All three are config, not code.

### 4.3 Env contract

All 9 hub env vars (§1.4) are deployment-identity frozen (§15.4). The
backend-side parity vars (`GPU_HUB_API_KEY`, `SHARE_FEATURES_ENABLED`,
`GPU_TIMEOUT` invariant vs `STALL_FAILSAFE_MS = GPU_TIMEOUT_MS × 3`,
runtime-config.js:143-163) are cross-service env pairs — they survive as
long as both deployments set them, which the compose file already
orchestrates and a future standalone compose/manifest will replicate.

### 4.4 Cross-owner Redis writes (frozen debt — recorded, NOT fixed)

Baselined in `redis-ownership.test.js` `CROSS_OWNER_WRITE_BASELINE` (new
ones fail the guard):
- `drainPolicyLane()` RPOPLPUSH/LREM/LPUSH on hub policy lanes +
  task-body mutation (worker-routes.cjs);
- `HDEL animastor:gpu-hub:workers` (worker purge, worker-routes.cjs:414);
- `DEL animastor:worker:heartbeat:*` (purge; TTL-benign);
- `DEL animastor:job:*` before legitimate re-dispatch (iu-processor,
  orchestrators, entity-cleanup, generation/debug routes);
- `DEL animastor:result:*` purge cleanup (redis-helpers.cjs).

**Extraction implication:** these remain valid **only while the standalone
hub and the backend share one Redis**. That is the case in every planned
deployment topology (the hub is an edge transport for THIS backend). If a
future phase splits Redis instances, the Phase 5/12 hub-API replacement
becomes mandatory — recorded as a 10D+ constraint, not a 10C blocker.

---

## 5. Redis ownership map

Registry source of truth: `backend/tests/architecture/redis-registry.js`
(machine-enforced). Hub command surface (ioredis): `set/get, hget/hgetall/
hset/hdel/hlen/hscan, lpush/rpush/rpoplpush/lrange/llen/lrem, del, expire,
scan` — nothing else.

| Family | Owner | Hub ops | Written also by | Read also by | Survives extraction? |
|---|---|---|---|---|---|
| `animastor:queue:{type}` | gpu-hub | lpush/rpush/rpoplpush/llen/lrange/del/scan | backend `drainPolicyLane()` (debt) | hub only | ✅ while Redis is shared |
| `animastor:queue:{type}:ws:{workspace_id}` | gpu-hub | same | — | hub only | ✅ |
| `animastor:queue:{type}:policy:{policy_id}` | gpu-hub | lpush/rpoplpush | backend `drainPolicyLane()` (debt) | hub only | ✅ while shared |
| `animastor:processing` | gpu-hub | rpoplpush/lrem/lrange/llen/del | — | hub only | ✅ |
| `animastor:running` | gpu-hub | hset/hget/hgetall/hdel/hlen/hscan/del | — | hub only | ✅ |
| `animastor:processing-claimed` | gpu-hub | hset/hget/hdel/del | — | hub only | ✅ |
| `animastor:dead-letter` (TTL 7d) | gpu-hub | lpush/expire | — | hub only (audit sink) | ✅ |
| `animastor:job:{dispatch}:{job}` (TTL 3600, SET NX) | gpu-hub | set/del/scan | **backend DELs** before re-dispatch (debt) | backend | ✅ while shared |
| `animastor:result:{build}:{book}:{chapter}:{scene}:{stage}` (TTL 3600) | gpu-hub | set/scan/get/del | backend DELs (purge) | **backend recovery/reconciliation** | ✅ while shared |
| `animastor:error:{job_id}` (TTL 3600) | gpu-hub | set | — | **backend recovery** | ✅ |
| `animastor:gpu-hub:workers` (EXPIRE 900) | gpu-hub | hget/hgetall/hset/expire/hdel | **backend hdel** (purge, worker-routes.cjs:414) | backend registry views | ✅ while shared |
| `animastor:worker:heartbeat:{type}:{worker_id}` (TTL 30) | gpu-hub | set | backend purge DEL + legacy `worker-health.reportHeartbeat()` write (debt) | **backend worker-health.js** | ✅ |
| `animastor:worker-auth` | **backend** | hub: **hget only** (read-only, `WORKER_AUTH_MIRROR_KEY`, gpu-hub.js:47; mirror-write-ban guard phase10a) | backend worker-auth.js ONLY (PG source of truth, 5-min resync) | hub hot path | ⚠️ see below |

### 5.1 The known debt: `animastor:worker-auth` — RECORDED, NOT FIXED

- The hub's **entire worker-auth plane** resolves identity by
  `hget animastor:worker-auth sha256(secret)` → `{worker_id, workspace_id,
  worker_type, mode, name, share_policy}`.
- The key is **backend-owned** (worker-auth.js:29; PG is the source of
  truth; mirror rebuilt on startup + every 5 min + point updates on
  create/rotate/revoke/policy events).
- Contract §8.2 freezes this as a READ-ONLY dependency with a SYNC pair on
  key name + value shape (gpu-hub.js:39-41 ↔ worker-auth.js:29,57); the
  phase10a mirror-write-ban guard enforces hub read-only posture.
- **Known limitation (frozen):** a standalone hub trusts the Redis-stored
  identity mirror authored by the backend. After extraction the coupling
  becomes "two independently deployed services sharing one Redis keyspace
  family" — operationally fine while Redis is shared, but it means the
  hub can never be deployed against a Redis that the backend does not
  also populate. Long-term options (all out of 10C scope): token
  introspection endpoint on the backend, moving the grammar+mirror
  contract into `@animastor/contracts`, or a signed-credential scheme.
- Expiry semantics survive: hub re-checks `share_policy.expiry` on every
  read — a stale mirror can never extend a policy (contract §8.2).

### 5.2 Redis ownership verdict

12 hub-owned families + 1 backend-owned read. Zero pub/sub, zero streams.
Ownership is machine-enforced on both sides (`redis-ownership.test.js` +
phase2-redis-ownership-contract). The scheme survives extraction
**unchanged** in the shared-Redis topology; cross-owner writes are already
baselined as debt with a Phase 5/12 replacement path.

---

## 6. Package boundary (PROPOSED — not created)

### 6.1 Vendored dependencies: verified state

The hub vendors its full dependency tree on disk
(`gpu-hub/node_modules/`, 81 packages) next to a committed
`package-lock.json`. Verified git state: the root `.gitignore` rule
`node_modules/` matches at any depth, so `gpu-hub/node_modules/**` is
ignored — `git ls-files gpu-hub/` lists exactly the 7 source/manifest
files and `git check-ignore` confirms the tree is untracked
(`git check-ignore -v gpu-hub/node_modules/express/index.js` →
`.gitignore:2:node_modules/`). A fresh clone reproduces the tree with
`npm ci` inside `gpu-hub/`. Consequence for 10D: the vendored tree is the
**sanctioned offline extraction vehicle** — `npm ci` + tar of `gpu-hub/`
yields a complete standalone package with zero registry access, and the
extraction carries no hidden git history from dependencies.

One genuine gap noted for 10D: `gpu-hub/` has **no `.dockerignore`** —
the Docker build (`COPY . .`) copies the working-tree `node_modules/`
into the build context. Harmless today (the image then runs its own
`npm install`), but a `.dockerignore` should be added when the package
stands alone to keep build contexts lean and hermetic.

### 6.2 Proposed package identity (design only — nothing created)

```
gpu-hub/
  package.json          # EXISTS — see proposed fields below
  package-lock.json     # EXISTS (lockfile = reproducible vendor source)
  README.md             # NEW at 10D (install, env, routes, ops)
  LICENSE               # NEW at 10D (match repo THIRD_PARTY_NOTICES.md)
  Dockerfile            # EXISTS — node:20, WORKDIR /app, EXPOSE 5000, CMD node server.js
  .dockerignore         # NEW at 10D (exclude node_modules from build context — currently absent; build relies on COPY . .)
  server.js             # entrypoint (39 lines: Redis wiring + env + listen)
  gpu-hub.js            # app factory `buildHubApp(config)` (2036 lines)
  bootstrap.js          # installer launcher generator (406 lines)
  tarball.js            # dependency-free ustar/gzip builder (112 lines)
  node_modules/         # vendored working tree (git-ignored; npm ci restores)
  tests/                # moved at 10D step 2 (§8)
```

| Field | Proposed value | Rationale |
|---|---|---|
| name | `@animastor/gpu-hub` | scoped, consistent with `@animastor/contracts`; current `gpu-hub/package.json` says `gpu-hub` (never published, rename is free) |
| version | `0.1.0` → `1.0.0` at first release | current 0.1.0; contract freeze justifies 1.0.0 on publish |
| private | `true` until 10D step 7 | prevents accidental publish |
| dependencies | `cors ^2.8.5`, `express ^4.19.2`, `ioredis ^5.10.0`, **`@animastor/contracts ^0.1.0`** (added at 10D step 1 when the contracts package is published/file-resolvable) | current declared set + the undeclared 10B seam made explicit |
| engines.node | `>=20 <21` | Dockerfile pins `node:20`; worker bootstrap pins runtime v22.23.2 separately (installer-side, not hub-side) |
| scripts.start | `node server.js` | matches Dockerfile CMD |
| scripts.test | `mocha --exit tests/**/*.test.js` (mirrors backend) | moved tests stay runnable in-package |
| health check | `GET /health` (HTTP 200, queue/running depths; no auth) | existing route #13; standalone compose adds a wget/curl healthcheck against it |
| required env | `REDIS_URL`, `BACKEND_URL`, `GPU_HUB_API_KEY`, `GPU_TIMEOUT_MS`/`GPU_TIMEOUT`, `SHARE_FEATURES_ENABLED` + optional `PORT`, `GPU_HUB_ALLOW_OPEN` (dev), `ORPHAN_GRACE_MS`, `MAX_ORPHAN_REQUEUES`, `PUBLIC_HUB_URL` | §1.4; fail-closed posture when API key unset |
| required external services | Redis (REDIS_URL), backend HTTP (BACKEND_URL), 5 artifact directories mounted at frozen container paths | §1.5, §3.1 |
| Docker | existing Dockerfile + (10D) standalone compose: same network alias `gpu-hub`, same env, artifact mounts per §3.3 option 1 | deployment identity frozen §15.4 |

### 6.3 Package-boundary verdict

The directory is already a self-contained runtime unit (4 files, 3 deps,
1 undeclared seam with a working Docker mount, dependency tree untracked
in git). The remaining 10D work is declarative only: package.json fields,
README, LICENSE, .dockerignore, contracts dependency declaration.

---

## 7. Test ownership map (backend/tests/)

134 test files in `backend/tests/`. Classification of everything touching
the hub (physical move deferred to 10D step 2 — nothing moved in 10C).

### 7.1 Hub-owned (must move with the package; ~24 files)

They require hub source directly (`require('../../gpu-hub/…')` → breaks on
extraction) or scan `REPO_ROOT/gpu-hub` as their subject:

| File | Coupling |
|---|---|
| `gpu-hub-artifacts.test.js` | requires hub source; tarball layouts/determinism |
| `gpu-hub-bootstrap.test.js` | requires `../../gpu-hub/bootstrap`; launcher generation |
| `gpu-hub-worker-source.test.js` | requires `../../gpu-hub/gpu-hub` buildHubApp |
| `fail-closed-worker-auth.test.js` | hub auth plane (requireApiKey fail-closed, mirror auth) |
| `gpu-hub-cleanup.test.js` | hub queue-clear semantics (spins buildHubApp) |
| `worker-setup-api.test.js` | requires hub source (setup contract surface) |
| `installer-platform.test.js` | :370,:417 require hub bootstrap for platform fixtures |
| `private-worker-phase2.test.js` | hub lane routing + sharing (requires hub source) |
| `private-worker-visibility.test.js` | hub visibility rules |
| `worker-share-grants.test.js` | SH grants via hub lanes |
| `worker-share-policy.test.js` | SH policy lanes via hub |
| `architecture/gpu-hub-contract.test.js` | contract SYNC anchors (scans hub source) |
| `architecture/phase10a-gpu-hub-contract-freeze.test.js` | route-surface/token/redis freezes (scans hub) |
| `architecture/phase2-hub-worker-boundary.test.js` | hub↔worker boundary scans |
| `architecture/phase2-job-protocol-v2.test.js` | protocol parity incl. hub import |
| `architecture/phase2-redis-ownership-contract.test.js` | hub-side key family scan |
| `architecture/dependency-guardrails.test.js` | R2 hub outbound freeze (HUB_DIR scan) |
| `architecture/phase7-extraction-readiness.test.js` | P7-T3 hub inbound isolation |
| `architecture/phase9c-contracts.test.js` | C5/C6/C7 + 10B hub canonical-import guard (parses compose gpu-hub section too) |
| `architecture/redis-ownership.test.js` | scans hub literals against registry |
| `architecture/lac-legacy-path-guard.test.js` | :27,:67 references hub dir in legacy-path rules |
| `architecture/redis-registry.js` | registry itself (hub families + cross-owner baselines) — moves as the hub's ownership manifest |
| `architecture/phase9d-worker-package.test.js` | :22,:119 references hub dir in worker-package checks |
| `mocks/redis-mock.js` | shared mock used by the hub suites above — moves with them (backend keeps its own copy if still needed) |

**Shared-fixture note:** several of the private-worker/share suites also
exercise backend routes; they need a split at 10D (hub-side suites move;
backend-side route fixtures stay) — flagged as 10D step 2 sub-task, not a
10C blocker.

### 7.2 Backend-owned (stay; reference the hub only via HTTP/env/Redis contracts)

`generation-routes.test.js` (hub URL literals `http://gpu-hub.invalid`),
`gpu-hub-cleanup.test.js` backend half (dispatch-engine cleanup — split
candidate), `dispatch-meta-lease-lifecycle.test.js`,
`image-orphan-generating-repair.test.js`, `private-worker-phase3.test.js`,
`ai-connector-auth/-discovery.test.js` (`runtimeType: 'gpu-hub'`
rejection), `installer-*` suites except platform (installer engine is
backend code), `audio-recovery`-related suites, `worker-health`-related
suites — all treat the hub as an external HTTP/Redis peer.

### 7.3 Cross-system contract tests (split or duplicate at 10D)

`architecture/phase9c-contracts.test.js` (backend facade + worker copy +
hub import + compose section — one suite guarding three repos),
`architecture/phase2-job-protocol-v2.test.js` (three-way parity),
`architecture/phase10a-gpu-hub-contract-freeze.test.js` (hub surface +
backend consumers), `architecture/redis-ownership.test.js` (registry
covers backend+hub+worker+ai-connector). Recommendation: keep the
three-way suites in the monorepo as integration contract tests AND move a
hub-local copy of the hub-side assertions with the package.

### 7.4 Minimal move set for 10D step 2

The 24 files of §7.1 minus the three-way suites (§7.3 stay + copy) = **21
files + redis-mock.js**, adjusted by the shared-fixture split.

---

## 8. Security boundary

Threat model shift at extraction: the hub moves from "a service inside a
trusted compose project" to "an independently deployed service that must
not extend trust to what mounts/config it is given".

### 8.1 What already holds (verified at this HEAD)

| Control | Status |
|---|---|
| Backend plane fail-closed | `GPU_HUB_API_KEY` unset → 503 `hub_api_key_not_configured` on /task + /queue/clear; mismatch → 401; header-only (never query/body) — gpu-hub.js:1996, :209, contract §4.1 |
| Worker plane fail-closed | Bearer-only; identity ONLY via `hget animastor:worker-auth` by sha256(secret); token self-locator cross-checked; no uncredentialed lane — contract §4.2 |
| `GPU_HUB_ALLOW_OPEN` | dev-only opt-out; documented "must NOT be set in production"; standalone deployment checklist must assert it is unset |
| Artifact endpoints secret-free | `isServableBundleFile` never serves `.env`/`.env.*` (except `.env.example`); tarball walk excludes `node_modules`/`.git`; Worker Key never part of installer exchange — contract §6 |
| Path traversal | `/workflow/:id` resolved-path containment + id regex; manifest allowlist — contract §6.4 |
| Callback auth | hub attaches x-api-key to backend callbacks; backend re-verifies job→book→workspace itself (audit-only forwarded fields) — contract §4.3 |
| Filesystem | read-only mounts; hub performs zero writes — contract §12 |
| Ownership discipline | workspace_id/policy_id always backend/server-authored, never client-supplied — contract scope note |

### 8.2 Extraction risk register (what could turn an internal service public)

| # | Risk | Current guard | 10D requirement |
|---|---|---|---|
| R1 | Standalone compose/manifest publishes port 5000 on 0.0.0.0 (today: no `ports:` — network-internal only, public only via nginx `/gpu/`) | compose has no host port mapping | standalone compose MUST keep `expose`-only or bind 127.0.0.1; public exposure only behind the proxy `/gpu/` prefix |
| R2 | CORS `app.use(cors())` is global-wildcard | frozen current behavior (contract §2) | acceptable while `/gpu/` proxy terminates TLS + origin policy lives at nginx; a standalone public hub MUST add nginx origin/allowlist rules before any direct exposure |
| R3 | Unauthenticated routes (6 artifact routes + /health) | by-design secret-free (§6) + `/health` info-disclosure debt (queue depths, GPU count — contract §7) | keep unauthenticated ONLY behind `/gpu/` proxy; /health disclosure stays LOW debt |
| R4 | Redis credentials | today `redis://animastor-redis:6379` — **no password** on the compose network | standalone hub MUST get an authenticated REDIS_URL (ACL user, read perms on `animastor:worker-auth`, rw on hub families); URL-only config already supports this |
| R5 | Secrets leaking via artifact mounts | `.env` filter + node_modules/git exclusion in tarball walk | mount sources at 10D must be CI-built artifact trees (§3.3), never raw repo checkouts containing `.env` |
| R6 | API-key parity drift | `.env` single source for backend+hub; runtime-audit script scans for weak defaults | standalone deployment checklist: `GPU_HUB_API_KEY` set + non-default; `GPU_HUB_ALLOW_OPEN` unset |
| R7 | `animastor:worker-auth` trust | hub trusts the mirror (frozen §8.2); share_policy expiry re-checked per read | unchanged while Redis shared; if Redis ACLs are introduced, hub needs read on this family — recorded |
| R8 | Internal-only endpoints reachable directly | `/task`, `/queue/clear`, callbacks are x-api-key'd, but e.g. `/beacon`/`/task/next` are worker-Bearer — fine publicly; `/worker-source` deprecated-but-open | none of the 14 routes requires network-internal placement, so the hub can sit public-behind-proxy without a private lane; the x-api-key plane must never be dropped |
| R9 | Installer bootstrap downloads over TLS | generated launchers fetch `${HUB_URL}/installer/bundle` + verify sha256 against `/installer/sha256` | keep sha256 verification step; PUBLIC_HUB_URL must stay https in prod |

### 8.3 Security verdict

No new attack surface is created by extraction itself. The dangerous
mistake available at 10D is a standalone compose file that publishes 5000
publicly (R1) or a Redis URL without credentials (R4). Both are
checklist items for 10D step 4, recorded here.

---

## 9. Extraction plan (Phase 10D — future; steps only, not scheduled)

| Step | Content | Blockers / gates |
|---|---|---|
| 1. Package preparation | Add `@animastor/contracts` as a real dependency (requires publishing contracts to a registry OR a committed `file:`/vendored copy decision — **GATE: contracts publish path**); add scripts/engines/repository fields, README, LICENSE, `.dockerignore`; decide version `1.0.0` | contracts package has no registry home yet (Phase 9C shipped a compose mount, not a publish); vendored copy fallback exists (§6.1) |
| 2. Test migration | Move the §7.1 set into `gpu-hub/tests/` (or a new repo), split shared fixtures with backend route suites, keep three-way contract suites in monorepo + hub-local copies; update `scripts/syntax-smoke.sh` path | shared-fixture split for private-worker/share suites; CI wiring for the new location |
| 3. Physical extraction | `git mv`/new-repo with history preservation; verify no dependency tree in history (already clean, §6.1); archive the monorepo directory with a pointer README | none if 1–2 done; monorepo guards (P7-T3, R2, phase9c, phase10a) must be re-homed in the same commit |
| 4. Docker standalone | Publish image; replace compose `build: ./gpu-hub` with `image:`; keep network alias `gpu-hub`, port 5000 internal-only, env parity; artifact feeds per §3.3 option 1; security checklist §8.2 R1/R4/R6 | artifact CI pipelines for the 5 inputs; Redis ACL decision |
| 5. Contract verification | Run the frozen-surface guards against the standalone image: 14-route set equality, error tokens, protocol 409s, artifact sha256 determinism, worker token parity matrix, Redis family scan against registry | the guards themselves must already live in the extracted package (step 2) |
| 6. Integration verification | Full stack: dispatch → queue → worker → result callback → recovery; orphan sweep; cancel path; installer end-to-end from the public `/gpu/` URL; fail-closed checks (unset API key → 503) | staging environment with public TLS endpoint |
| 7. npm/package release readiness | `npm publish --access public` (or private registry), tag, changelog; retire the vendored-tree fallback if registry is adopted | publish target decision (public npm vs private registry); secrets scan of the published tarball |

Dependency order: 1 → 2 → 3 → 4 → 5/6 → 7. Steps 5–6 gate the cutover of
the production compose file.

---

## 10. Verification performed in 10C

- Full require/import scan of gpu-hub/*.js (4 files, 2 593 lines) — §1.
- Full literal scan of all non-gpu-hub references (905 matches reviewed,
  docs excluded) — §2.
- Route surface re-verified against GPU_HUB_CONTRACT.md §3 (14/14 match) —
  §4.1.
- Redis families cross-checked against `redis-registry.js` + hub code — §5.
- Git hygiene: `git ls-files gpu-hub/` → exactly 7 tracked files;
  `git check-ignore` confirms `gpu-hub/node_modules/**` ignored (§6.1).
- Test suites run (results in the phase report): architecture, GPU Hub,
  contracts, worker, Phase 10A/10B guards, syntax smoke — all green.

## 11. Blockers (post-10C remainder)

1. **`@animastor/contracts` has no publish path** — the hub's one undeclared
   dependency. 10D step 1 gate. Mitigation until then: compose mount seam
   (works today) or vendored copy (§6.1).
2. **`animastor:worker-auth` shared-Redis trust** — frozen known limitation;
   constrains the standalone hub to a shared-Redis topology until a
   backend introspection/contracts-based credential scheme exists.
3. **Five artifact mounts lack CI artifact pipelines** — §3.3 option 1 is
   the 10D step 4 gate.

None of the three blocks Phase 10C completion; all are forward gates with
recorded mitigations.
