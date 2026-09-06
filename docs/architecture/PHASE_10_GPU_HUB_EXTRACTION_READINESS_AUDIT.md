# PHASE 10 — GPU Hub Extraction Readiness Audit

**Status:** READINESS AUDIT ONLY. No extraction executed, no files moved, no
package created, no runtime/protocol/deployment changes made.
**Date:** 2026-09-06
**Baseline:** HEAD `acafe15e` ("feat(worker): prepare animastor-worker@2.1.0 for public npm release")
**Context:** Phase 8 (LAC → `animastor-ai-connector@0.1.0`) and Phase 9
(Worker → `animastor-worker@2.1.0`, `@animastor/contracts@0.1.0`) complete.
**Related:** MODULAR_PRODUCT_ARCHITECTURE.md §10/§22/§24/§26/§30,
JOB_PROTOCOL_V2.md (normative, FROZEN), PHASE_2_CONTRACTS.md §7,
PHASE_7_EXTRACTION_READINESS.md (P7-T3), PHASE_9C/9D/9E reports,
PHASE_NEXT_MODULE_EXTRACTION_RECONNAISSANCE.md §4.3 (cross-check).

---

## Executive summary

GPU Hub (`gpu-hub/`) is **already a physically standalone service** with a
**complete code-level isolation**: zero inbound requires (P7-T3), zero
outbound monorepo requires (R2), no PG, its own Dockerfile/compose service,
and a frozen HTTP route surface pinned by architecture guards. Its runtime
coupling to the rest of the system is **contractual only** — the Job
Protocol v2 wire contract, the backend-owned `animastor:worker-auth` Redis
mirror, the shared hub-owned Redis key families, and five read-only
deployment volume mounts that feed its artifact-delivery endpoints.

What GPU Hub has NOT yet received (compared to Worker after Phase 9D):

1. **Phase 9C migration residue** — `PROTOCOL_VERSION = 2` and the job_id
   grammar knowledge live as an inline literal + SYNC comments in
   `gpu-hub.js:32-33`, not fed from `@animastor/contracts` (backend got the
   facade in 9C; worker got the generated copy in 9D; the hub got neither).
2. **No package identity** — unscoped generic name `gpu-hub@0.1.0`,
   `package-lock.json` drift (lock says `1.0.0`), no `files` allowlist, no
   README/LICENSE, `npm install` (not `npm ci`) in the Dockerfile.
3. **No package-owned tests** — all 12+ hub test suites live in
   `backend/tests/` and require the hub via `../../gpu-hub/...`; the worker
   by contrast owns `worker/tests/` with a zero-dep harness.
4. **Deployment/artifact coupling** — the hub serves the Worker bundle, the
   backend installer sources, workflows and install manifests via compose
   volume mounts from the monorepo tree. This is by-design (Setup Contract)
   and is a **D-class deployment contract**, not a code dependency — but it
   means a standalone hub is not self-sufficient without an artifact-input
   decision (Phase 12 territory: "artifact delivery via API instead of
   volume mounts").
5. **Shared-Redis cross-owner writes from the backend** —
   `drainPolicyLane()` RPOPLPUSHes hub-owned policy lanes
   (`worker-routes.cjs:146-165`) and `hdel`s the hub workers registry
   (`worker-routes.cjs:414`); backend deletes hub dedup keys
   (`animastor:job:*`, documented Phase 5 debt). These cannot move with the
   hub and remain frozen cross-module contracts.

**Verdict: B — READY AFTER PREPARATION** (Section 11). Code-level extraction
is low-risk and could follow the Phase 8/9 pattern almost mechanically, but
the preparation steps (10A–10E below) are required first; npm-public release
additionally needs a package-name ADR and the artifact-input decision.

---

## 1. GPU Hub boundary

### 1.1 Runtime boundary (measured at HEAD)

| Aspect | Value |
|---|---|
| Physical location | `gpu-hub/` (5 runtime files: `server.js` 39 L, `gpu-hub.js` 2029 L, `bootstrap.js` 406 L, `tarball.js` 112 L + `package.json`) |
| Process model | own Docker service `gpu-hub` (docker-compose.yml:105-135), `node:20`, EXPOSE 5000, `CMD node server.js` |
| Network exposure | nginx `/gpu/` → `gpu_hub_upstream` (`proxy/conf/default.conf:13-15,130-143,312-314`; proxy compose `:49-51`) + docker network `net` |
| npm runtime deps | exactly 3: `express ^4.19.2`, `cors ^2.8.5`, `ioredis ^5.10.0` (+ Node builtins `crypto/fs/path/zlib`) |
| Inbound code requires | **0** (P7-T3: no backend/worker/LAC file requires into `gpu-hub/`) |
| Outbound code requires | **0** monorepo; only npm deps + own files (R2, dependency-guardrails.test.js:86-106) |
| DB dependency | **none** — "hub has no pg" (gpu-hub.js:6); identity exclusively via the backend-maintained Redis mirror |
| WebSocket | none |

### 1.2 Inbound dependencies (consumers → hub), all over HTTP `/gpu/*`

| Consumer | Call | Location |
|---|---|---|
| backend `gpu-dispatcher` | `POST /task` (x-api-key) | backend/src/runtime/gpu-dispatcher.js:197-209 |
| backend `dispatch-engine` | `DELETE /queue/clear?dispatch_id=` | backend/src/runtime/dispatch-engine.js:1332-1365 |
| backend book routes | `DELETE /queue/clear?book_id=` | generation-routes.cjs:309-316; cache-routes.cjs:109-117; book-deletion.cjs:182-190 |
| backend installer setup-contract | `GET /worker-bundle/sha256`, `GET /installer/sha256` (probe) | installer/setup-contract.js:359-389 |
| backend installer engine | `GET /worker-bundle` (+sha256 verify), `GET /worker-source` (fallback) | installer/engine/worker.js:71-78, 223-260 |
| backend installer workflows | `GET /workflow/:id` | installer/engine/workflows.js:49-54 |
| installer CLI | `--hub-url` (default `https://animastor.in/gpu`) | installer/cli.js:89,132 |
| Worker package | `POST /beacon`, `GET /task/next`, `POST /task/result`, `POST /task/error` (Bearer) | worker/worker/worker.cjs:228,260,527,546 |
| e2e smoke | `POST /task` + Redis result poll | docker/e2e/dispatch-task.cjs:17-56 |
| frontends (indirect) | artifact URLs `/gpu/installer`, `/gpu` origin | frontends/app/src/features/workers/workerSetup.ts:206-235, privateWorkers.ts:107-108 |

### 1.3 Outbound dependencies (hub → world)

| Target | Mechanism | Location |
|---|---|---|
| backend result callback | `POST ${BACKEND_URL}/gpu/task/result` (x-api-key) | gpu-hub.js:1153-1184 (5 retries) |
| backend error callback | `POST ${BACKEND_URL}/gpu/task/error` (x-api-key) | gpu-hub.js:395-440 via `notifyBackendError` (5 retries; fallback key `animastor:error:{job_id}`) |
| Redis | ioredis, data structures only (hash/list/string/set TTL + SCAN/HSCAN) — **no pub/sub** | gpu-hub.js throughout |
| filesystem | READ-ONLY of the 5 mounted dirs (Section 6) | gpu-hub.js:1289-1327 |
| npm registry | none at runtime | — |

### 1.4 Public API surface (hub-owned, frozen by guards)

| Method | Path | Auth | Line (gpu-hub.js) | Guard |
|---|---|---|---|---|
| POST | `/beacon` | Bearer (fail-closed) | 666 | C4 pins |
| POST | `/task` | x-api-key (fail-closed 503) | 735 | C4 pins |
| GET | `/task/next` | Bearer | 862 | C4 pins |
| POST | `/task/result` | Bearer + claimer-only | 1050 | C4 pins |
| POST | `/task/error` | Bearer + claimer-only | 1199 | C4 pins |
| DELETE | `/queue/clear` | x-api-key | 1816 | C4 pins |
| GET | `/worker-source` | none — DEPRECATED | 1292 | gpu-hub-worker-source.test.js |
| GET | `/worker-bundle` (+`/sha256`) | none (secret-free artifact) | 1413/1436 | gpu-hub-artifacts.test.js |
| GET | `/workflow/:id` | none (allowlist) | 1493 | gpu-hub-artifacts.test.js |
| GET | `/installer` (+`/bundle`, `/sha256`) | none (secret-free) | 1586/1753/1770 | gpu-hub-bootstrap.test.js, installer-platform.test.js |
| GET | `/health` | none | 1789 | — |

Internal/test surface: `module.exports` (16 exports: `PROTOCOL_VERSION`,
`WORKER_AUTH_MIRROR_KEY`, `PROCESSING_CLAIMED_KEY`, `DEAD_LETTER_KEY`,
`ORPHAN_GRACE_MS`, `MAX_ORPHAN_REQUEUES`, `parseWorkerToken`,
`extractBearerToken`, `authenticateWorkerMirror`, `requireWorkerCredential`,
`buildHubApp`, `sanitizeSharePolicy`, `activeSharePolicy`) and the
`app.__hub` lifecycle handle (gpu-hub.js:1965-1970, 2014-2029).

### 1.5 Redis dependencies (ownership per redis-registry.js)

Hub-OWNED families (writers `gpu-hub`): `animastor:queue:{type}[...ws|policy]`,
`animastor:processing`, `animastor:running`, `animastor:processing-claimed`,
`animastor:dead-letter`, `animastor:job:{dispatch}:{job}`, `animastor:result:*`,
`animastor:error:*`, `animastor:gpu-hub:workers`, `animastor:worker:heartbeat:*`.

Backend-OWNED, hub READS: `animastor:worker-auth` (mirror hash; written only
by `services/worker-auth.js:29`, rebuilt from PG every 5 min).

Backend READS hub-owned: `result:*`, `error:*` (recovery/reconciliation),
`worker:heartbeat:*` (worker-health.js), `gpu-hub:workers` (registry views).

**Cross-owner writes from backend (frozen debt, cannot move with hub):**
`drainPolicyLane()` RPOPLPUSH between hub lanes (worker-routes.cjs:146-165);
`hdel` on the hub workers registry (worker-routes.cjs:414); deletion of hub
dedup keys `animastor:job:*` before legitimate re-dispatch
(iu-processor.js:271,303; redis-helpers.cjs:370; documented in
redis-registry entries — Phase 5 replaces with a hub API).

### 1.6 Environment/config dependencies

`REDIS_URL` (default `redis://animastor-redis:6379`), `PORT` (5000),
`BACKEND_URL` (default `http://animastor-backend:3000`),
`GPU_HUB_API_KEY` (fail-closed if unset; must match the backend compose
section), `GPU_HUB_ALLOW_OPEN` (dev-only opt-out), `GPU_TIMEOUT_MS`/`GPU_TIMEOUT`
(default 600000; INVARIANT: < backend `STALL_FAILSAFE_MS = GPU_TIMEOUT_MS*3`,
runtime-config.js:143-163), `SHARE_FEATURES_ENABLED` (SH-1 kill-switch; must
match backend), `ORPHAN_GRACE_MS` (60s), `MAX_ORPHAN_REQUEUES` (3).
Config-object-only overrides (tests): `WORKER_SOURCE_PATH`,
`WORKER_BUNDLE_DIR`, `WORKFLOW_DIR`, `INSTALLER_SRC_DIR`,
`INSTALLER_MANIFESTS_DIR`, `INSTALLER_WORKFLOWS_DIR`, `PUBLIC_HUB_URL`,
`WORKER_BUNDLE_VERSION`, `INSTALLER_VERSION`.

### 1.7 Filesystem dependencies (in-container, all read-only mounts)

| Constant (gpu-hub.js) | Default | Compose mount (docker-compose.yml) |
|---|---|---|
| `WORKER_SOURCE_PATH` | `/app/worker-source/worker.cjs` | `./worker/worker/worker.cjs:ro` (L127) |
| `WORKER_BUNDLE_DIR` | `/app/worker-bundle` | `./worker/worker:ro` (L130) |
| `WORKFLOW_DIR` / `INSTALLER_WORKFLOWS_DIR` | `/app/workflows` | `./backend/ai/workflows:ro` (L132) |
| `INSTALLER_SRC_DIR` | `/app/installer-src` | `./backend/src/installer:ro` (L134) |
| `INSTALLER_MANIFESTS_DIR` | `/app/install-manifests` | `./backend/ai/install-manifests:ro` (L135) |

The hub performs **zero filesystem writes** (in-memory artifact caches only).

### 1.8 Docker/deployment dependencies

`gpu-hub/Dockerfile` (node:20, `npm install`, COPY, EXPOSE 5000);
`docker-compose.yml` service `gpu-hub` (env + 5 mounts; no depends_on — hub
tolerates Redis latency by design); nginx upstream + 3 `/gpu/` locations;
`gpu-hub-rebuild.sh`; `scripts/syntax-smoke.sh` (`check_dir gpu-hub`);
`scripts/animastor-runtime-audit.sh:427-434`; e2e scripts.

---

## 2. Dependency classification

| # | Dependency | Class | Notes |
|---|---|---|---|
| 1 | express / cors / ioredis / node builtins | **A** | standalone-safe npm deps, already minimal and frozen by R2 allowlist |
| 2 | `./tarball`, `./bootstrap` (own files) | **A** | self-contained, zero external requires |
| 3 | Redis server (connection) | **A** (infra) | any Redis; no pub/sub, no modules, no keyspace notifications |
| 4 | Job Protocol v2 (wire fields, `PROTOCOL_VERSION=2`, 409 semantics) | **B** | frozen external contract, canonical in `@animastor/contracts`; BUT hub carries an **inline SYNC copy (C-residue)** — see #10 |
| 5 | Hub HTTP API (14 endpoints, headers, statuses) | **B** | this IS the hub's own published contract (C4/C5 candidate); pinned by guards |
| 6 | `GPU_HUB_API_KEY` shared secret backend↔hub | **B** | standard external contract dependency (header-only, fail-closed both sides) |
| 7 | Worker Bearer token grammar `wrk.<id>.<secret>` | **B** wire-wise, **C** as code | defined in backend `worker-repo.js`, duplicated in hub `parseWorkerToken` (gpu-hub.js:58-84) with only a SYNC comment; no parity guard |
| 8 | `animastor:worker-auth` mirror contract (key name + value shape incl. `share_policy`) | **B** | backend-owned Redis hash the hub READS; shape duplicated in worker-auth.js ↔ gpu-hub.js with SYNC anchors, no parity guard |
| 9 | Shared Redis key families (queue/running/result/error/heartbeat/registry/dedup) | **B** | ownership registry is canonical + machine-checked (redis-ownership.test.js); formats (result key layout) duplicated in backend readers — acceptable C-level debt |
| 10 | Inline `PROTOCOL_VERSION = 2` (gpu-hub.js:33) + inline job_id grammar knowledge | **C** | Phase 9C migration residue — the ONLY remaining hand-synced protocol literal on the backend↔hub↔worker seam; worker got the generated copy (9D), backend got the facade (9C), hub got neither |
| 11 | Backend cross-owner Redis writes (`drainPolicyLane`, registry `hdel`, dedup dels) | **C** (reverse coupling) | backend reaches into hub-owned families; frozen debt, stays in backend at extraction |
| 12 | Compose volume mounts of `worker/worker`, `backend/src/installer`, `backend/ai/*` | **D** | deployment/path coupling feeding the artifact endpoints; the hub reads them as opaque dirs (config-overridable) — contract is the mount TARGET path, not the source |
| 13 | Worker bundle version read from `worker/worker/package.json`; tarball prefix `animastor-worker/`; installer layout `animastor-installer/src/installer/...` | **D** | artifact-layout contract consumed by the installer engine (worker.js:251 checks the `animastor-worker/` prefix); version coupling is deliberate (single canonical source) |
| 14 | compose service name `gpu-hub` (DNS), nginx upstream, `/gpu/` public path, env var names | **D** | deployment identity — cannot be renamed at extraction without coordinated rollout |
| 15 | Hub tests living in `backend/tests/**` with `require('../../gpu-hub/...')` | **C** | test-ownership coupling (graduation checklist §26.5 requires package-owned `npm test`) |
| 16 | `package.json` identity: unscoped generic `gpu-hub`, version drift (lock `1.0.0`), no `files` allowlist, no README/LICENSE, `npm install` in Dockerfile | **C** | package hygiene blockers for npm-public release (same class worker resolved in 9D/9E) |
| 17 | Artifact delivery requiring monorepo sources (installer src from backend tree) | **D/E-ish** | by-design Setup Contract; standalone hub needs an artifact-input decision (Phase 12 "delivery via API") — NOT a code blocker, but a product-scope decision |
| 18 | No PG, no backend code, no worker code requires | **A** (negative) | the entire hard-dependency graph is absent; enforced |

**Class summary:** A: #1-3, #18 · B: #4(partially)-9 · C: #7(shape)-11, #15, #16 ·
D: #12-14, #17. There is **no class-E architectural blocker**: nothing in the
hub's code structurally prevents extraction; the C/D items are preparation
work and documented contracts.

---

## 3. Protocols / contracts

### 3.1 Canonical ownership map

| Contract | Canonical source | Duplicated copies | Guard |
|---|---|---|---|
| Job Protocol v2 (constants, grammar, envelope helpers) | `contracts/src/job-protocol-v2.js` (`@animastor/contracts`), normative doc JOB_PROTOCOL_V2.md | backend facade `backend/src/runtime/job-schema.js` (re-export, OK); worker `worker/worker/job-protocol-v2.cjs` (GENERATED byte-copy + parity guard, OK); **hub `gpu-hub.js:33` inline literal (SYNC comment only — NOT OK, residue)** | gpu-hub-contract.test.js:59-75, phase9d parity + negative control, worker/tests/job-protocol.test.cjs, `sync-protocol.cjs --check` |
| Worker token grammar | backend `storage/postgres/repositories/worker-repo.js` | hub `parseWorkerToken` (gpu-hub.js:71-84, SYNC:58) | fail-closed-worker-auth.test.js (behavioral only, no parity guard) |
| Worker-auth mirror value shape | backend `services/worker-auth.js` (`mirrorValue`) | hub `authenticateWorkerMirror` + `sanitizeSharePolicy` (gpu-hub.js:39-41,104-162) | behavioral tests; SYNC anchors pinned by gpu-hub-contract.test.js:77-85 |
| Hub HTTP API | hub itself (`gpu-hub/gpu-hub.js`) | consumer literals in worker.cjs / gpu-dispatcher.js | gpu-hub-contract.test.js + phase2-hub-worker-boundary.test.js (route surface + consumer-side literals) |
| Redis key families | `backend/tests/architecture/redis-registry.js` (ownership registry) | literals in hub + backend readers/writers | redis-ownership.test.js (all literals must be registered; cross-owner writes frozen) |
| Heartbeat payload | hub (author) | backend worker-health.js (reader) | worker-health tests, shared-pool-lifecycle.test.js |
| Result/error handoff keys | hub (author) | backend audio-recovery/reconciliation-engine/redis-helpers (readers) | registry + reader tests |
| Artifacts (bundle/installer/workflow) | worker `package.json` (bundle version), `backend/src/installer/package.json` (installer version), manifests (allowlists) | none — hub reads canonical sources at request time | gpu-hub-artifacts.test.js determinism, setup-contract probe |

### 3.2 Protocol elements — status

- **Registration (`POST /beacon`)** — worker registers with Bearer; identity
  is server-derived (mirror); body `gpu/vram/version/image_tag/protocol_version`
  are labels; 409 on version mismatch. Frozen by guards.
- **Heartbeat** — dual: beacon writes `animastor:worker:heartbeat:{type}:{id}`
  (TTL 30s) AND the hub's 10s sweep re-stamps heartbeats for running tasks
  (gpu-hub.js:452-501). Backend reads for the workers panel. Payload carries
  scope fields (`workspace_id`, `mode`, `share_policy` marker). Contract is
  behavioral-tested but **not yet a frozen schema** — candidate for 10A.
- **Dispatch (`POST /task` + `GET /task/next`)** — backend-authored envelope
  (job_id, params, assets, build_id, protocol_version, dispatch_id, book/
  chapter/scene/stage identity, workspace_id/policy_id routing, timeout_ms);
  NX dedup key `animastor:job:{dispatch}:{job}` (TTL 1h, best-effort);
  RPOPLPUSH into `animastor:processing`; running-record claim; poison-write
  lane cross-check; SH-1/SH-2 lane priority (kill-switch gated).
- **Result delivery (`POST /task/result`)** — claimer-only; result key
  `animastor:result:{build}:{book}:{chapter}:{scene}:{stage}` (TTL 1h) + HTTP
  forward to backend `/gpu/task/result` (5 retries).
- **Error delivery (`POST /task/error`)** — claimer-only; dedup key released;
  forward to backend `/gpu/task/error`; fallback key `animastor:error:{job}`.
- **Health/capabilities** — `/health` reports queue depths (system + discovered
  workspace lanes via SCAN), running count, GPU count. Capabilities = worker
  type only (audio|image|video); no richer capability model.
- **Auth** — dual-plane: x-api-key (backend plane, fail-closed 503 when unset,
  header-only), Bearer mirror-resolved (worker plane, fail-closed 401, never
  query/body identity). Hub→backend callbacks carry x-api-key when configured.
- **Retry/timeout/cancel** — retry: backend owns re-dispatch (dispatch-lease
  expiry); hub does per-job `timeout_ms` (≥ `GPU_TIMEOUT_MS`) + per-GPU
  `last_seen` sweep → `notifyBackendError("worker_timeout")`; orphan sweep
  (grace 60s, max 3 requeues → dead-letter); cancel: backend clears hub
  queues via `DELETE /queue/clear` (book/dispatch/workspace-scoped or full).
- **Redis contracts** — data-structure only, no pub/sub; ownership registry is
  the canonical map and is machine-enforced.
- **HTTP/WebSocket** — 14 HTTP endpoints (1.4); **no WebSocket**.

### 3.3 Duplicated protocol definitions — findings

1. `PROTOCOL_VERSION = 2` — 3 copies: contracts (canonical ✓), worker
   generated copy (guarded ✓), **hub inline literal (unguarded SYNC — the one
   real residue)**. Canonical ownership: `@animastor/contracts`. The hub copy
   MUST become either an import (hub has npm install, so option A is viable
   — unlike the worker) or a generated byte-copy with parity guard (option B,
   symmetric with worker). The value stays 2; no protocol change.
2. Token grammar — 2 hand-synced implementations (worker-repo.js ↔ hub
   gpu-hub.js). Canonical: worker-repo.js (PG side). Safe fix: extract the
   grammar constant/parser into `@animastor/contracts` (additive, no wire
   change) or add a parity guard.
3. Mirror value shape — 2 hand-synced shape definitions (worker-auth.js ↔
   hub). Same options as #2.
4. Result-key layout — hub writes, backend readers re-implement the parse
   (`key.split(':')`, audio-recovery.cjs:49-59, redis-helpers purge, dispatch
   cleanup). Canonical: hub (author). Acceptable B-level duplication;
   a contracts-level key-builder helper would remove it (additive).
5. Hub route surface — defined once in the hub, pinned twice in guards
   (gpu-hub-contract.test.js, phase2-hub-worker-boundary.test.js) — duplicate
   GUARDS, not duplicate definitions; benign.

---

## 4. Compare with Worker (post-Phase 9 state)

### 4.1 What already became contract/package after Phase 9

- `@animastor/contracts@0.1.0` — Job Protocol v2 canonical (37 tests);
  backend consumes via the `job-schema.js` facade (compose mounts the package
  into the backend container, docker-compose.yml:95-98).
- `animastor-worker@2.1.0` — physical package boundary: canonical version,
  zero-dep freeze, `files` allowlist, generated protocol copy + parity guard,
  package-owned tests (`worker/tests/`, zero-dep harness, 45 tests),
  npm-public-ready per Phase 9E.
- Compose mounts pinned to `worker/worker/` (Phase 9D D7 guard) — the
  physical location every deployment channel consumes.
- Hub's bundle serving already versioned from the canonical worker
  `package.json` (single version source — no manual duplication).

### 4.2 Where GPU Hub still "knows" about physical `worker/worker/`

The hub knows the Worker ONLY through mounts, names, and layout constants —
**never via require** (banned by dependency-guardrails.test.js:100-105 and
phase2-hub-worker-boundary.test.js:94-101):

- `docker-compose.yml:127,130` — the mounts themselves (pinned by D7);
- `gpu-hub.js:1287,1330` — comments documenting the mount sources;
- `gpu-hub.js:1344-1347` — fallback artifact name `"animastor-worker"`;
- `gpu-hub.js:1399` — tarball entry prefix `animastor-worker/${f}` (a wire
  format the installer engine depends on, worker.js:251);
- `gpu-hub.js:1681-1693` — installer layout mirrors the repo
  (`animastor-installer/worker/worker/...`) because the installer engine
  resolves manifest paths against that layout;
- install manifests (`backend/ai/install-manifests/**`) —
  `worker_bundle.source.options` path `"worker/worker/"`.

### 4.3 Where GPU Hub depends on Worker internals — replaceable by public contract?

| Coupling | Public-contract replaceable? |
|---|---|
| Serving the bundle dir (opaque dir walk) | **Yes** — already config-overridable (`WORKER_BUNDLE_DIR`); the contract is the tarball layout + version source, both frozen. Extraction must keep the mount/`WORKER_BUNDLE_DIR` input, whatever feeds it. |
| Version from worker `package.json` | **Yes** — deliberate single-source; keep as the artifact input contract (or `WORKER_BUNDLE_VERSION` override). |
| Deprecated `/worker-source` single-file | **Yes** — kept for backward compat (installer engine fallback); removal is a future coordinated deprecation, NOT part of extraction. |
| Installer sources from `backend/src/installer` | **Partially** — the hub packages another component's code; the endpoint layout is frozen (installer consumes it). A standalone hub keeps this as an explicit artifact INPUT (mount/build-arg/registry), not code knowledge. |

### 4.4 Where GPU Hub depends on Backend internals

- None at code level. Contractual: worker-auth mirror (Redis), result/error
  callbacks (HTTP), `/queue/clear` callers, GPU_HUB_API_KEY,
  `GPU_TIMEOUT_MS < STALL_FAILSAFE_MS` invariant (commented at
  gpu-hub.js:196-198, enforced in runtime-config.js:143-163),
  `SHARE_FEATURES_ENABLED` sync. All B-class external contracts.
- Reverse: backend writes hub-owned Redis families (Section 1.5 debt).

---

## 5. Extraction seam (future structure — NOT created now)

```
gpu-hub/                          # or packages/gpu-hub after ADR
  src/
    server.js                     # entrypoint (wires redis + env)
    gpu-hub.js                    # app factory (unchanged)
    bootstrap.js                  # launcher generators
    tarball.js                    # deterministic tar.gz
  tests/                          # migrated hub suites (Section 8) + zero-dep or mocha harness
  protocol/                       # OPTION A: dependency on @animastor/contracts in package.json
                                  # OPTION B: generated job-protocol-v2 copy + sync tool (worker-style)
  contracts-doc/ or README        # hub HTTP API freeze (endpoints, auth, semantics)
  config/                         # env contract documentation (.env.example for hub vars)
  package.json                    # name per ADR (@animastor/gpu-hub | animastor-gpu-hub), version, files, private first
  package-lock.json               # regenerated, in sync
  Dockerfile                      # npm ci; artifact inputs as volumes/build-args (targets unchanged)
  README.md, LICENSE
```

Invariants for the move: mount targets (`/app/worker-bundle`, etc.), the
`/gpu/` public path, compose service name, all endpoint paths, Redis key
families, and env var names stay **byte-identical**.

---

## 6. Deployment audit (all launch paths)

| Path | Mechanism | Break-risk at extraction |
|---|---|---|
| Docker | `gpu-hub/Dockerfile` (node:20, `npm install`, CMD `node server.js`) | LOW — self-contained build; switch to `npm ci` after lock sync |
| docker-compose | service `gpu-hub` (build `./gpu-hub`, 3 env vars, 5 ro mounts, network `net`); backend mounts `@animastor/contracts` separately | **MEDIUM — the 5 source paths are monorepo-relative**; must keep working verbatim (they are the artifact inputs). Pinned by phase9d D7 for the two worker mounts. |
| nginx proxy | `gpu_hub_upstream` → `gpu-hub:5000`; 3 `location /gpu/` blocks (+ proxy compose standalone) | service name + port are deployment identity — must not change |
| Local dev | `node server.js` with `REDIS_URL`; `GPU_HUB_ALLOW_OPEN=1` dev opt-out; tests boot `buildHubApp` with mock redis | LOW |
| Production | compose up + nginx; `gpu-hub-rebuild.sh` (build --no-cache, up, restart, logs) | LOW — script only references the compose service |
| Worker bundle delivery | `GET /worker-bundle` (deterministic tar.gz, version from canonical worker package.json, sha256 header + `/sha256`, `.env*` never included, fingerprint cache) | mount `./worker/worker:/app/worker-bundle:ro` must keep working |
| `/worker-bundle/sha256` | probe target of backend setup-contract (setup-contract.js:365-366) | endpoint frozen |
| `/worker-source` | DEPRECATED single-file endpoint (Deprecation + Link headers); still the fallback in installer engine worker.js:71-78 and old manifests | **must NOT be removed at extraction** (constraint honored) |
| `/installer` family | launcher (bash/PowerShell) + self-contained tarball (installer src + manifests + workflows + worker bundle + generated package.json/README) | heaviest input surface: 4 monorepo dirs; extraction keeps them as inputs |
| Env vars | Section 1.6; `.env.example:19,25,31`; compose passes GPU_HUB_API_KEY to backend (L69) AND hub (L113) — must match | names frozen |
| Volume mounts / FS paths | Section 1.7 (5 ro mounts); hub writes nothing | targets frozen; sources are the monorepo coupling |
| Frontend artifact URLs | `/gpu/installer` etc. via origin (`workerSetup.ts:206`) | public path `/gpu/` frozen |

**Deployment paths that must NOT break:** everything in the table above —
all 14 endpoints, the 5 mount targets, compose service name, nginx `/gpu/`
routing, env var names, tarball layouts (`animastor-worker/`,
`animastor-installer/...`), bootstrap flow, version sources.

---

## 7. Security audit (recorded, not fixed here)

| Area | Status | Evidence |
|---|---|---|
| Auth token boundaries | OK (frozen) | dual-plane fail-closed: x-api-key 503-when-unset (gpu-hub.js:272-286), Bearer 401 mirror-resolved (:170-183); header-only, never query/body |
| Worker trust model | OK (frozen, PW-4) | identity only from mirror; claimer-only result/error; lane poison cross-check; claim bound to credential; dead-letter audit |
| Hub→backend callbacks | OK | x-api-key when configured (backend re-verifies ownership; forwarded fields audit-only) |
| Exposed endpoints | By design | artifact endpoints (bundle/installer/workflow) are secret-free and unauthenticated by Setup Contract design; `/health` leaks queue depths + GPU count (LOW info disclosure — recorded) |
| SSRF | OK | hub fetches only `${BACKEND_URL}` (config); no user-controlled URL fetching hub-side |
| Path traversal | OK | `/workflow/:id`: allowlist + `WORKFLOW_ID_RE` + resolve-prefix check (gpu-hub.js:1502-1506); bundle serving walks a fixed dir with sanitized relpaths; tested (gpu-hub-artifacts.test.js) |
| Arbitrary command/process exec | OK hub-side | hub executes nothing; bootstrap launchers run on the user's GPU machine with sha256 verification before execution, fail-closed profile/mode/platform allowlists, HOSTNAME_RE-sanitized Host embedding (recorded: Host-header influence on the embedded hub URL is validated to a DNS shape) |
| Filesystem access | OK | read-only mounts; `.env`/`.env.*` never servable (isServableBundleFile, defense in depth) |
| Secrets | OK | GPU_HUB_API_KEY shared only via compose env; Worker Key never in any artifact (installer asks interactively); no secrets in `/health` or error payloads |
| Environment leakage | OK (recorded) | no env echo endpoints; 500mb JSON body limit and absence of rate limiting recorded as existing (unrelated) debt — not addressed per audit constraints |

No unrelated security debt was modified.

---

## 8. Tests — inventory and migration set

### 8.1 Hub unit/contract tests (all in `backend/tests/`, require `../../gpu-hub/gpu-hub`)

| Suite | Covers | Migrate with hub? |
|---|---|---|
| gpu-hub-artifacts.test.js | bundle/workflow/installer determinism, .env exclusion, traversal, deprecated endpoint | **YES** (uses real repo dirs as fixture inputs — keep as integration fixtures or fixture-ize) |
| gpu-hub-bootstrap.test.js | launcher scripts, gates, determinism | **YES** |
| gpu-hub-worker-source.test.js | deprecated `/worker-source` contract | **YES** |
| gpu-hub-cleanup.test.js | `/queue/clear` + dispatch-engine integration | SPLIT — hub half migrates, backend half stays |
| fail-closed-worker-auth.test.js | token parse, mirror auth, 401 lanes | **YES** |
| private-worker-{phase2,phase3,visibility}.test.js, private-worker-auth.test.js | hub lanes, claimer checks, share policies | **YES** (hub halves; route halves stay with backend) |
| worker-share-grants.test.js, worker-share-policy.test.js | SH-1/SH-2 lane semantics | **YES** |
| worker-setup-api.test.js | boots the real hub + backend routes | SPLIT |
| installer-platform.test.js | hub `/installer` platform selection (:370,:417) | hub halves **YES** |

### 8.2 Architecture guards (hub-relevant)

- gpu-hub-contract.test.js — route surface, protocol version 3-copy check, SYNC anchors, envelope fields, consumer literals. SPLIT (hub half migrates).
- phase2-hub-worker-boundary.test.js — role separation, isolation rules. SPLIT (stays as a cross-package guard in the monorepo, mirroring phase2 pattern for extracted packages).
- phase2-job-protocol-v2.test.js, phase9c-contracts.test.js, phase9d-worker-package.test.js (incl. D7 mount pins + parity negative control), phase7-extraction-readiness.test.js (P7-T3 hub inbound isolation), dependency-guardrails.test.js (R2 hub outbound allowlist), redis-ownership.test.js + redis-registry.js — **stay in the monorepo** as cross-package guards; a phase10 suite would be ADDED at extraction.
- lac-legacy-path-guard.test.js, lac-contract-sync.test.js — LAC-only, unaffected.

### 8.3 Worker/backend contract & parity tests

- `worker/tests/` (45 pass): job-protocol parity, standalone boot, package contour, cleanup journal.
- `contracts/tests/` (37 pass): canonical grammar/envelope.
- `worker/tools/sync-protocol.cjs --check` — **SYNC OK** at audit time.
- Backend contract suites exercised for this audit: 84 passing
  (gpu-hub*/fail-closed/private-worker-visibility) + 186 passing
  (phase2/share/setup-api/installer-platform) — all green.

### 8.4 Baseline (measured at HEAD during this audit)

- `backend test:arch`: **262 passing / 1 failing — pre-existing, LAC-related**
  (phase2-lac-transport-contract.test.js:219: a line-wrapped comment in
  `shared-pool.js:53-55` no longer matches the `/is a stale trace/` regex;
  introduced by the Phase 8C file move comment reflow — **unrelated to GPU
  Hub**, recorded for the next LAC touch; not fixed here per constraints).
- All hub-related suites: **green** (84 + 186 backend, 45 worker, 37 contracts, parity OK).

---

## 9. Risk matrix

| BLOCKER | SEVERITY | CURRENT COUPLING | SAFE FIX | RISK |
|---|---|---|---|---|
| Inline `PROTOCOL_VERSION` + grammar SYNC (gpu-hub.js:33) | HIGH (protocol) | hand-synced literal; the last unguarded protocol copy on the seam | import `@animastor/contracts` (hub has npm install — option A) or generated copy + parity guard (option B, worker-symmetric); value stays 2 | LOW — guarded by gpu-hub-contract.test.js:59-75 before/after |
| Protocol coupling (wire) | MEDIUM | hub ↔ backend ↔ worker share frozen Job Protocol v2 | already contract-owned; keep frozen; no change needed at extraction | LOW |
| Redis coupling | MEDIUM | shared key families + backend-owned worker-auth mirror; backend cross-owner writes (drainPolicyLane/hdel/dedup-dels) | keep families byte-identical; document as C4/C5 published contracts; cross-owner writes stay in backend (frozen debt) | LOW at extraction (keys unchanged); MEDIUM long-term until Phase 12 hub-API migration |
| Backend coupling | LOW | HTTP callbacks + mirror read + `/queue/clear` callers + GPU_TIMEOUT invariant + SHARE_FEATURES_ENABLED sync | all B-class external contracts; document env invariant; no change | LOW |
| Worker coupling | LOW | artifact serving (bundle dir + version + tarball prefix + deprecated worker-source) | keep as artifact INPUT contract; no require exists | LOW |
| Deployment coupling | MEDIUM | 5 monorepo-relative compose mounts; service name; nginx `/gpu/`; scripts | extraction keeps compose verbatim (hub dir stays the build context until 10F); D7 guard pins worker mounts | MEDIUM if paths change; LOW if verbatim |
| Filesystem coupling | LOW | read-only of 5 dirs; zero writes | unchanged; config-overridable already | LOW |
| Authentication coupling | LOW-MEDIUM | shared GPU_HUB_API_KEY; token grammar + mirror shape hand-synced with backend | extract grammar/mirror-shape into contracts or add parity guards (additive, no wire change) | LOW |
| Test ownership | MEDIUM | 12+ hub suites live in backend/tests | migrate hub suites to package-owned tests (10C), keep cross-package guards in monorepo | LOW (mechanical, mirrors Phase 9D) |
| Package identity | MEDIUM (for npm only) | unscoped `gpu-hub@0.1.0`, lock drift (1.0.0), no files/README/LICENSE, `npm install` | 10D hardening + name ADR per §22.2; publish gate like Phase 9E | LOW |
| Artifact-input scope | MEDIUM (product decision) | hub serves worker/installer/workflows/manifests from monorepo mounts | decide: keep mounts (status quo, documented) vs Phase 12 API delivery; NOT required for package extraction | MEDIUM (decision, not code) |
| LAC guard pre-existing failure | INFO | unrelated to hub | fix in a LAC-scoped change (one-line comment/guard alignment) | none for hub |

---

## 10. Extraction plan (proposed sequence, numbers adjusted to code reality)

**10A — Contract freeze (docs+guards only, no runtime change).** Freeze the
hub-owned contracts not yet frozen as schemas: heartbeat payload shape,
worker-auth mirror value shape, token grammar, result/error key layouts,
`/queue/clear` semantics, artifact metadata responses. Additive guards in
the existing suites; canonical home either `@animastor/contracts` (additive
exports) or a hub contract doc. Zero wire change.

**10B — Protocol migration (the 9C residue).** Replace the hub's inline
`PROTOCOL_VERSION`/grammar knowledge with consumption of
`@animastor/contracts` — recommended **option A (real dependency)** because
the hub is the only consumer with an npm install step and a lockfile; compose
gains the same read-only mount the backend already uses
(docker-compose.yml:98). Alternative: worker-style generated copy. Either way
value stays 2 and guards stay green. Do FIRST — it is the only protocol-risk
item.

**10C — Test-ownership migration.** Move the hub suites (Section 8.1 YES
rows) into `gpu-hub/tests/` with a package-owned runner (mirror
worker/tests harness); split dual suites; keep cross-package guards
(gpu-hub-contract hub-half, phase2-hub-worker-boundary, P7-T3, R2, D7,
redis-ownership) in `backend/tests/architecture/` — they guard the SEAM, not
the package.

**10D — Package hardening.** Name ADR (`@animastor/gpu-hub` vs
`animastor-gpu-hub` per §22.2), version 0.x/1.x decision, regenerate
package-lock (currently drifts at 1.0.0), `files` allowlist
(server.js/gpu-hub.js/bootstrap.js/tarball.js), README + LICENSE, `engines`,
`private: true` until the release decision, Dockerfile `npm ci`.

**10E — Deployment decoupling documentation (no wiring change).** Document
the artifact inputs as an explicit input contract (the 5 mounts), the
deployment identity (service name, `/gpu/`, env names) and the version
sources as frozen; register the future Phase 12 "delivery via API" item.
Compose stays verbatim.

**10F — Physical extraction.** `git mv` to the target dir (keep `gpu-hub/`
unless the ADR moves it), rewire the 12 test require-paths, compose
build-context path, syntax-smoke dir, rebuild script; guards updated in the
same change (Phase 8C pattern). Rollback = revert; mounts keep working.

**10G — Standalone verification.** Fresh-clone boot (compose build gpu-hub
with the contracts mount if 10B-A), hub suites standalone, e2e
dispatch-task smoke, guard sweep incl. D7 mount pins.

**10H — npm release readiness (optional, later).** Phase 9E-style audit:
files/pack dry-run, name availability, versioning policy, scope decision.
Publishing is NOT required for architectural extraction — the hub ships as a
container in every real deployment.

Ordering rationale: 10B before 10F because protocol residue is the only
extraction-risk item; 10C/10D before 10F because moving tests with the code is
what made Phase 9D verifiable; 10E keeps the D-class couplings explicit
instead of discovered.

---

## 11. Final verdict

### **B — READY AFTER PREPARATION**

**Why not A (READY NOW):** three concrete preparation gaps remain between
the hub and the graduation checklist (§26): (1) the Phase 9C protocol
migration residue — the last hand-synced `PROTOCOL_VERSION` copy on the
backend↔hub↔worker seam (gpu-hub.js:33), which is exactly the class of
coupling Phases 9A–9D eliminated everywhere else; (2) test ownership — no
package-owned `npm test`, 12+ suites require the hub from `backend/tests/`;
(3) package identity/hygiene — unscoped generic name, lockfile drift, no
files allowlist, blocking npm-public release until an ADR. Additionally the
artifact-input surface (worker bundle, installer sources, workflows,
manifests) must be consciously accepted as a deployment contract (documented,
unchanged) rather than silently carried.

**Why not C (NOT READY / HIGH RISK):** the hard parts are already done and
machine-guarded: zero inbound/outbound code requires (P7-T3 + R2), no PG,
Redis families registry-owned and enforced, HTTP API frozen by contract
tests, fail-closed dual-plane auth, deployment channels pinned by D7, and the
Worker extraction already hardened the shared seam from the other side
(generated protocol copy, canonical version source). The remaining work is
mechanical, follows the executed Phase 8C/9D playbook, and touches no wire
semantics, no Redis keys, no endpoints, no mounts.

**Confidence:** HIGH. Every claim above was measured at HEAD `acafe15e`
(require-graph scans, Redis-literal scans, guard-suite execution: 262 arch
passing with 1 pre-existing LAC failure unrelated to the hub, 270 backend
hub-contract tests passing, 45 worker + 37 contracts package tests passing,
protocol parity sync verified).

---

## Appendix A — Evidence commands (reproducible at HEAD)

```
git log --oneline -15                                   # baseline
npx mocha --exit tests/architecture/*.test.js           # backend/: 262 pass, 1 pre-existing LAC fail
npx mocha --exit tests/gpu-hub-*.test.js tests/fail-closed-worker-auth.test.js tests/private-worker-visibility.test.js   # 84 pass
npx mocha --exit tests/private-worker-phase2.test.js tests/worker-share-grants.test.js tests/worker-share-policy.test.js tests/worker-setup-api.test.js tests/installer-platform.test.js   # 186 pass
(cd worker  && node tests/run-all.cjs)                 # 45 pass
(cd contracts && node tests/run-all.cjs)               # 37 pass
node worker/tools/sync-protocol.cjs --check             # SYNC OK
```

## Appendix B — Files measured

`gpu-hub/{server.js,gpu-hub.js,bootstrap.js,tarball.js,package.json,package-lock.json,Dockerfile}`;
`docker-compose.yml`; `proxy/conf/default.conf`; `worker/worker/{worker.cjs,package.json,job-protocol-v2.cjs}`;
`worker/tools/sync-protocol.cjs`; `contracts/src/job-protocol-v2.js`;
`backend/src/runtime/{gpu-dispatcher.js,dispatch-engine.js,job-schema.js}`;
`backend/src/services/worker-auth.js`; `backend/src/routes/{generation-routes.cjs,worker-routes.cjs}`;
`backend/src/installer/{setup-contract.js,engine/worker.js,engine/workflows.js,cli.js}`;
`backend/tests/**` (hub suites + `tests/architecture/**` incl. redis-registry.js);
`scripts/{syntax-smoke.sh,animastor-runtime-audit.sh}`; `gpu-hub-rebuild.sh`;
`docker/e2e/dispatch-task.cjs`; `frontends/app/src/features/workers/*`;
docs: MODULAR_PRODUCT_ARCHITECTURE.md, JOB_PROTOCOL_V2.md,
PHASE_9C/9D/9E reports, PHASE_NEXT_MODULE_EXTRACTION_RECONNAISSANCE.md.
