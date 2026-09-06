# PHASE 10I — External GPU Hub Integration Readiness Audit

**Status: PASS — verdict B (READY AFTER PREPARATION)**
**Date:** 2026-09-06
**Monorepo HEAD:** `1916e80799914534ac7b4739953b8e702ace1c90` (runtime baseline; doc HEAD `94fb8869` on top)
**Standalone repo:** `Animastor/animastor-gpu-hub`, HEAD `87982b674e4eece90015c28aa905524fcf664cd1`
**Package:** `@animastor/gpu-hub@0.1.0` (runtime sources sha256-identical to monorepo `gpu-hub/`)
**Scope:** reconnaissance only — no moves, no deletions, no API/Redis/auth/protocol/nginx changes, no npm publish, no refactoring.

---

## 1. Executive Summary

The GPU Hub is **already code-independent** of the monorepo: the standalone repo is a
byte-identical extraction (Phase 10H), consumes Job Protocol v2 from the published
`@animastor/contracts@0.1.0` npm package, has zero monorepo imports, and its container
smoke test verified `/app` contains no monorepo files. Runtime coupling between Backend
and Hub is **purely wire-level** (HTTP + shared Redis) — backend `src/` contains no
`require` into `gpu-hub/` (references are comments only).

What is NOT yet independent is the **deployment and test scaffolding** of the monorepo:
`docker-compose.yml` builds the hub from the physical `./gpu-hub` directory, ~20 backend
test suites hard-require `../../gpu-hub/…`, five artifact mounts read monorepo-owned
trees, and the reference deployment assumes one Docker network / one Redis / one host.

**Verdict: B — READY AFTER PREPARATION.** The blockers are operational (compose build
context, test cutover, artifact distribution, Redis/network reachability), not
architectural. No contracts, protocols, or hub code need to change.

## 2. Current Architecture

```
                    nginx (animastor.in)
        /gpu/ ──────────────┐   /api/ ──────────┐
                            ▼                   ▼
   ┌─────────────┐   ┌──────────────┐   ┌─────────────────┐
   │ GPU Worker  │   │   gpu-hub    │   │     backend     │
   │ (external   │◄──┤  :5000       │──►│  :3000          │
   │  machines)  │   └──────┬───────┘   └───┬─────────┬───┘
   └─────▲───────┘          │               │         │
         │  Bearer wrk.*    │  x-api-key    │         │
         └────── callbacks  │  callbacks    ▼         ▼
              + artifacts   │  (result/error)  postgres   redis:7
                            ▼                   ▲        (single shared instance)
                       redis:7 ─────────────────┘
                     animastor:queue:* / running / gpu-hub:workers / dead-letter
                     animastor:worker-auth  (backend-owned, hub READS)
```

- **Backend → Hub:** `POST {HUB_URL}/task`, `DELETE {HUB_URL}/queue/clear` with `x-api-key: GPU_HUB_API_KEY` (`backend/src/runtime/gpu-dispatcher.js:197-209`, `dispatch-engine.js:1347`).
- **Hub → Backend callbacks:** `POST {BACKEND_URL}/gpu/task/result`, `/gpu/task/error`, authenticated `x-api-key`, 5 retries × 500 ms, error fallback Redis key TTL 1 h (`gpu-hub.js:201,389-405,1163,1994`; backend guard `requireHubCallbackAuth`, `generation-routes.cjs:52,1340,1437`).
- **Worker → Hub:** `GET /beacon`, `GET /task/next`, `POST /task/result|error` (Bearer `wrk.<id>.<secret>`), artifact GETs (`worker/worker/worker.cjs:228,260,527,546`).
- **Redis:** one instance, shared; hub owns its key families, reads (never writes) backend-owned `animastor:worker-auth`.

## 3. Dependency Inventory — all remaining `gpu-hub` references in the monorepo

### 3.1 Runtime dependency (backend `src/`)
| Location | Reference | Classification |
|---|---|---|
| `backend/src/config/runtime-config.js:62,236,284,313` | `HUB_URL`, `GPU_HUB_API_KEY` env vars | **Deployment reference** — must remain (wire contract) |
| `backend/src/runtime/gpu-dispatcher.js`, `dispatch-engine.js`, `reconciliation-engine.js`, `orchestrator.js`, `job-schema.js`, `layer-config.js` | comments + HTTP usage | **Deployment reference** — comments may be updated cosmetically |
| `backend/src/installer/*`, `setup-contract.js`, `safety-rules.js` | `HUB_URL` / hub artifact URL construction | **Deployment reference** — installer talks to the public `/gpu/` prefix |
| `backend/src/storage/postgres/schema.js`, `ai-connector-repo.js` | comments (AD-9: LLM never rides gpu-hub) | Documentation only |

**No `require()` from backend `src/` into `gpu-hub/` exists.** Runtime code is already external-ready.

### 3.2 Docker/Compose
| Location | Reference | Must disappear after cutover? |
|---|---|---|
| `docker-compose.yml:105-106` | `gpu-hub: build: ./gpu-hub` | **YES** — replace with registry image (e.g. `ghcr.io/animastor/animastor-gpu-hub:<sha>`) or remote service definition |
| `docker-compose.yml:52,69` | `HUB_URL=http://gpu-hub:5000`, `GPU_HUB_API_KEY` | Keep (values may change to cross-host URL) |
| `docker-compose.yml:112-135` | hub service env + **five artifact mounts** (see §6) | Mounts stay short-term (A), long-term per §6 decision |
| `gpu-hub-rebuild.sh` | `docker compose build gpu-hub` | Replace with `pull`/redeploy flow for external image |
| `docker/e2e/dispatch-task.cjs:19` | `docker exec gpu-hub printenv GPU_HUB_API_KEY` | Dev-only; works only while hub is a local compose service |

### 3.3 nginx
| Location | Reference | Verdict |
|---|---|---|
| `proxy/conf/default.conf:13-15` | `upstream gpu_hub_upstream { server gpu-hub:5000 resolve; }` | Deployment reference — must become a cross-host address (or stay Docker DNS while hub remains co-hosted) |
| `proxy/conf/default.conf:130-144,312-326` | two `location /gpu/` proxies | Keep — public path contract is frozen |
| `proxy/docker-compose.yml:51` | legacy copy `proxy_pass http://gpu-hub:5000/;` | Same as above |

### 3.4 Installer / deployment scripts
| Location | Reference | Verdict |
|---|---|---|
| `scripts/syntax-smoke.sh:57,65-66,83-84` | checks `$ROOT_DIR/gpu-hub` sources | Development-only; must be updated/removed at cutover |
| `scripts/animastor-runtime-audit.sh:72,427,691` | `GPU_HUB_API_KEY` secret allowlist | Keep |

### 3.5 Tests (see §8 for full list)
~20 suites in `backend/tests/` hard-require `../../gpu-hub/gpu-hub` or scan the physical dir — **must be migrated/kept in sync before any directory deletion**.

### 3.6 Documentation
`ARCHITECTURE.md`, `README.md`, `docs/architecture/*` (30+ files), `docs/01-overview/*`, `docs/02-orchestration/*`, `docs/04-planning/*` — the majority are historical audit/planning records (keep as-is); living documents (`GPU_HUB_CONTRACT.md`, `SYSTEM_MAP.md`, `PROJECT_STRUCTURE.md`, `architecture-map.md`) need a pointer update at cutover only.

### 3.7 Development-only
`gpu-hub/node_modules/` (local registry install of contracts), `gpu-hub-rebuild.sh`, `scripts/syntax-smoke.sh`, `docker/e2e/`.

## 4. Deployment Coupling

| Coupling | Today | External hub impact |
|---|---|---|
| Docker Compose project | one project builds backend, hub, nginx, pg, redis from monorepo paths | Hub can live in a **separate compose project/server**; only wire endpoints matter |
| Build context | `build: ./gpu-hub` requires monorepo sources on the deploy host | Remove at cutover; switch to image pull |
| Networks | all services on one bridge `net`; DNS names `gpu-hub`, `animastor-backend` | Cross-host: `HUB_URL` and `BACKEND_URL` must become routable URLs (public HTTPS or VPN); nginx upstream must point at the hub host |
| Redis | **single shared instance** on the monorepo host | This is the hardest coupling: hub and backend MUST share one logical Redis. Split-host requires exposing Redis with password/TLS (`REDIS_URL` supports `redis://:pass@host:6379` and `rediss://`) or keeping hub co-hosted |
| Health/readiness | hub exposes `GET /health` (`gpu-hub.js:1796`); backend `depends_on` only pg+redis, NOT hub; hub has no `depends_on` either | Ordering is already loose — dispatch fails soft at runtime and recovery re-drives; no startup-order change needed |
| Artifact mounts | five read-only mounts from monorepo trees | see §6 |

**Can the external hub run standalone?** Verified from the repo contents + Phase 10H smoke:
- ✅ separate compose project (`DEPLOYMENT.md` §2 reference fragment);
- ✅ separate server (all seams are URLs/env: `REDIS_URL`, `BACKEND_URL`, `GPU_HUB_API_KEY`);
- ✅ HTTP API + Redis only — no backend filesystem access, no monorepo sources in image;
- ⚠️ the five artifact artifacts must be shipped to it (not available from its own repo) — §6.

## 5. API / Redis / Auth Contracts (verified unchanged, frozen)

- HTTP route surface: exactly **14 frozen routes** (route-freeze guard in standalone `tests/run-all.cjs` — 19/19 PASS on standalone HEAD).
- Auth planes: backend `x-api-key` (fail-closed 503 `hub_api_key_not_configured` when unset; 401 on mismatch); worker `Bearer wrk.*` via `animastor:worker-auth` mirror (fail-closed 401); dev bypass `GPU_HUB_ALLOW_OPEN=1` (must never be set in prod).
- Redis ownership: hub-owned families frozen (`animastor:gpu-hub:workers`, `animastor:queue:*`, `running`, `processing`, `processing-claimed`, `dead-letter`, heartbeats, `result/error/job/dedup`); hub never writes `animastor:worker-auth` (guarded).
- Job Protocol v2: standalone hub consumes `@animastor/contracts ^0.1.0` from the npm registry (`package-lock.json` resolves `registry.npmjs.org`); `PROTOCOL_VERSION === 2` parity hub/worker/contracts. **No local Job Protocol v2 copy exists in the hub** — item 10 of the task is satisfied. The only remaining generated copy is the worker bundle's `worker/worker/job-protocol-v2.cjs` (byte-exact codegen from contracts, Phase 9D — intentional, ships to npm-less GPU boxes, parity-guarded).
- Worker-token grammar: hub carries the hand-synced `parseWorkerToken` copy — known frozen debt (parity-guarded), unaffected by this phase.

## 6. Artifact Mount Analysis (five mounts — options, no changes made)

Frozen targets (`GPU_HUB_CONTRACT.md` §12; standalone `DEPLOYMENT.md`):
`/app/worker-source/worker.cjs`, `/app/worker-bundle`, `/app/workflows`, `/app/installer-src`, `/app/install-manifests` — all `:ro`, all serving secret-free content, missing mounts degrade to frozen 404 tokens (hub never crashes).

| Option | Description | Pros | Cons |
|---|---|---|---|
| **A. Keep shared mounts** | external deployment mounts artifact dirs from wherever they are synced | zero code change; already the documented contract (`DEPLOYMENT.md`); fail-soft | deployment must obtain monorepo-derived artifacts; off-host needs a sync step |
| **B. Artifact service / object storage** | artifacts published to S3-compatible storage; hub reads via HTTP(S) on boot/on-demand | fully decoupled; versioned; checksums already exist (`/worker-bundle/sha256`) | new infra; hub code/config change (new fetch path); route surface may grow → contract-freeze violation needs explicit decision |
| **C. HTTP artifact API (push)** | deployment pushes artifacts into the hub (authenticated PUT) | single-plane ops | new routes on a frozen 14-route surface — direct contract violation; hub gains filesystem writes (currently zero) |
| **D. Versioned artifact image / release bundle (hybrid)** | CI packages the five trees into a versioned tarball or OCI sidecar image (published from monorepo CI); deployment mounts/downloads it; targets stay frozen | no hub code change; no contract change; deterministic versioning; works on any host | requires a CI/release step (small) |

**Recommendation: D now, B later.**
- D matches the modular architecture best in the near term: the hub remains a pure read-only artifact *serving* boundary, targets stay `[NORMATIVE — FROZEN]`, and the monorepo remains the single source of artifact truth with explicit versioned releases. A) is simply D without the packaging step and is what the reference deployment keeps doing today.
- B is the long-term end-state (true external artifact plane) but requires an ADR because it touches hub config surface and possibly adds routes — do **not** fold it into the cutover.

## 7. Security Boundary (external hub)

| Plane | State | Notes |
|---|---|---|
| Backend → Hub API key | ✅ fail-closed (`x-api-key`, 401/503 tokens) | `GPU_HUB_API_KEY` must be provisioned in both planes of the external deployment |
| Hub → Backend callbacks | ✅ backend `requireHubCallbackAuth` validates `x-api-key` on `/gpu/task/result|error`; hub with unset key sends none → backend rejects (fail-closed) | callback URL must be reachable from the hub host — plan this before split-host |
| Worker auth | ✅ `Bearer wrk.*` against backend-owned Redis mirror (hub cannot mint tokens; no PG access) | unchanged |
| Redis credentials/network | ⚠️ reference compose runs `redis:7` **without password**, exposed only on the internal bridge. Split-host REQUIRES `REDIS_URL` with password + TLS (`rediss://`) or a private tunnel. Hub code already accepts any Redis URL — config-only fix | **hidden gap #1** |
| Backend filesystem access | ✅ none — hub talks HTTP+Redis only; verified no mounts of backend data into hub | |
| Monorepo source access | ✅ standalone image contains no monorepo files (Phase 10H smoke: `/app` audit PASS); `.dockerignore` excludes docs | |
| Public exposure | ✅ contract: never expose hub directly; always behind nginx `/gpu/` + API key | external nginx (if any) must keep this rule |
| Dev bypass | `GPU_HUB_ALLOW_OPEN=1` disables auth — must stay unset in prod runbooks | |

## 8. Test Coupling

**Standalone repo:** self-contained, ZERO external deps — `tests/run-all.cjs` (19 checks: package smoke, dependency isolation, contracts resolution, protocol parity, 14-route freeze, Redis ownership). **PASS 19/19** on standalone HEAD. Needs nothing from the monorepo.

**Monorepo suites requiring `../../gpu-hub/…` (physical dir) — must be migrated/duplicated before deleting `gpu-hub/`:**

Runtime/behavioral (`require('../../gpu-hub/gpu-hub')` or `bootstrap`):
`gpu-hub-artifacts`, `gpu-hub-bootstrap`, `gpu-hub-worker-source`, `gpu-hub-cleanup` (uses dispatch-engine, hub paths), `orchestration-stabilization`, `fail-closed-worker-auth`, `private-worker-phase2`, `private-worker-visibility`, `worker-setup-api`, `worker-share-grants`, `worker-share-policy`, `installer-platform`.

Architecture/guards (read the physical dir):
`architecture/gpu-hub-contract`, `architecture/phase2-hub-worker-boundary`, `architecture/phase2-job-protocol-v2`, `architecture/phase2-redis-ownership-contract`, `architecture/phase3-provider-gateway` (harness), `architecture/phase7-extraction-readiness`, `architecture/phase9c-contracts`, `architecture/phase9d-worker-package`, `architecture/phase10a-gpu-hub-contract-freeze`, `architecture/phase10d-gpu-hub-package-boundary`, `architecture/dependency-guardrails`, `architecture/redis-ownership` (+`redis-registry.js` helper).

**Migration options (next phase decision):** (1) point suites at the npm package via a workspace/devDependency, (2) move hub behavioral suites into the standalone repo and keep only contract/freeze guards in the monorepo, or (3) keep monorepo `gpu-hub/` as a test fixture until (1)/(2) land. Option (2) matches the modular direction; keep the frozen-contract guard suites in the monorepo regardless.

**Pre-existing drift found during this audit (monorepo `npm test`, 5 failures, NOT caused by this phase):**
1. `phase10d` frozen dependency set expects `cors/express/ioredis` only — package.json already carries `@animastor/contracts` (Phase 10G).
2. `phase10d` expects a `file:` lockfile entry — lockfile now resolves from the registry (Phase 10G).
3. `phase10d` expects `require.resolve('@animastor/contracts')` to land in `/contracts/src` — it now resolves inside `gpu-hub/node_modules` (registry).
4. `phase9c` C7 expects the `./contracts` read-only mount in the gpu-hub compose section — removed by the Phase 10G registry migration.
5. `phase7`/LAC anchor drift (`is a stale trace` comment anchor in ai-connector).

These are stale Phase-10B-era anchors that Phase 10G/10H did not update. **Fixing them is part of the cutover phase, not this audit.**

## 9. Hidden Dependencies (would break an external hub)

1. **Shared Redis assumption** — hub + backend MUST share one logical Redis (queues, dedup, `worker-auth` mirror). Two separate Redis instances = silently broken system (workers register in hub Redis but never authenticate). Split-host needs password/TLS + network exposure.
2. **Callback reachability** — `BACKEND_URL` (default `http://animastor-backend:3000`) must resolve FROM the hub host; on a separate server this becomes a public HTTPS endpoint or VPN address. Missed callbacks fall back to Redis error keys (TTL 1 h), but result delivery itself degrades.
3. **Docker DNS names** — `http://gpu-hub:5000` in compose/nginx and `gpu-hub` container name assumptions (`gpu-hub-rebuild.sh`, `docker/e2e/dispatch-task.cjs`, `scripts/*`).
4. **nginx `upstream … resolve`** — Docker-internal DNS; cross-host needs a routable address and the `resolve` parameter semantics re-checked.
5. **`GPU_HUB_API_KEY` provisioning symmetry** — both directions (task submit AND callbacks) use the same key; splitting deployments must replicate it in both environments.
6. **`SHARE_FEATURES_ENABLED` / `GPU_TIMEOUT` sync** — compose comments mandate backend/hub values match; a split deployment loses this compile-time adjacency (audit script `animastor-runtime-audit.sh` helps).
7. **Artifact freshness coupling** — hub serves worker bundles/installers versioned from monorepo trees; an external hub silently keeps serving stale artifacts unless the artifact pipeline (§6-D) is versioned.
8. **Frontends build `{origin}/gpu/...` URLs** (`frontends/app/src/features/workers/*`) — public path must stay `/gpu/` on the backend origin (nginx stays the front door).
9. **Installer instructions baked into hub responses** (`gpu-hub.js` bootstrap script) reference backend API URLs derived from env — verify `BACKEND_URL` public value when split.
10. **`GPU_HUB_ALLOW_OPEN`** — dev-only bypass; a prod external deployment with this set is an open relay for task submission.

## 10. Migration Plan (next phase — concrete, ordered, safe)

**Step 0 — preconditions (monorepo)**
- Fix the 5 stale test anchors (§8) so the backend suite is green BEFORE any cutover (safe, behavior-free).
- Decide artifact distribution option (recommend §6-D) and publish strategy for `@animastor/gpu-hub` (npm + `ghcr.io` image from the standalone repo CI). No publish in this phase.

**Step 1 — monorepo changes (safe, independent)**
- Update living docs (`GPU_HUB_CONTRACT.md` §12 note, `PROJECT_STRUCTURE.md`, `SYSTEM_MAP.md`, `architecture-map.md`): hub sources now live in `Animastor/animastor-gpu-hub`; `gpu-hub/` marked as transitional test fixture.
- Update `scripts/syntax-smoke.sh` to tolerate a missing `gpu-hub/` (guard, not requirement).

**Step 2 — standalone repo changes**
- Add CI: `npm ci && npm test`, `npm pack --dry-run`, Docker build, publish image to GHCR tagged by short SHA + semver. (No npm publish until separately decided.)
- Add a minimal cross-repo contract test: boot hub container + disposable redis, assert the frozen smoke set (mirror of Phase 10H §7).

**Step 3 — Docker/Compose cutover (monorepo)**
- Replace `gpu-hub: build: ./gpu-hub` with `image: ghcr.io/animastor/animastor-gpu-hub:<pinned-sha>`.
- Keep the five artifact mounts (option A) with sources unchanged — still valid while co-hosted.
- Remove the contracts-mount expectation from compose-related guards (done in step 0).

**Step 4 — test cutover (monorepo)**
- Adopt option (2): move hub behavioral suites to the standalone repo; keep contract-freeze/Redis-ownership guards in the monorepo pointing at the npm package (workspace devDependency or pinned tarball).

**Step 5 — verification checklist**
- `docker compose up` full stack: task submit → result callback → worker onboarding E2E (`docker/e2e/dispatch-task.cjs` adapted to image-based hub).
- Hub on separate host (staging): `REDIS_URL` with auth, `BACKEND_URL` public HTTPS, artifact mounts populated — run the same E2E + `/health` + route-freeze smoke.
- Fail-closed checks: wrong/missing keys → 401/503; missing mounts → frozen 404 tokens; hub down → backend dispatch degradation + recovery.
- Backend suite green (0 failures).

**Not allowed before separate decisions (do NOT bundle):**
- Changing the 14-route surface, Redis key families, auth grammar, `animastor:worker-auth` mirror direction, frozen `/app/*` mount targets, Job Protocol v2, nginx public path `/gpu/`.
- Artifact re-architecture (option B) and worker-token consolidation into contracts — separate ADR phases.
- Deleting monorepo `gpu-hub/` before Step 4 lands.

## 11. Risk Matrix

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Split Redis breaks queue/worker-auth coupling | med | **high** (silent) | deploy checklist: single logical Redis; auth+TLS; ownership test run against prod Redis |
| R2 | Callbacks unreachable from hub host | med | high (results lost → 1 h Redis fallback) | `BACKEND_URL` reachability test in deployment script |
| R3 | Stale/missing artifacts on external hub | high (if unsynced) | med (fail-soft 404s, onboarding broken) | option D versioned artifact releases |
| R4 | Test suites break when `gpu-hub/` is deleted | certain (if unmanaged) | med (CI only) | Step 4 before any deletion; transitional fixture period |
| R5 | 5 pre-existing failing backend tests mask new regressions | certain today | med | fix in Step 0 |
| R6 | Key/config desync (`GPU_HUB_API_KEY`, `SHARE_FEATURES_ENABLED`, `GPU_TIMEOUT`) across split envs | med | med (401s / lease mismatch) | runtime-audit script extension for split deployments |
| R7 | `GPU_HUB_ALLOW_OPEN=1` in prod | low | **high** (open task relay) | prod runbook + audit script check |
| R8 | Route-surface drift between repos | low | high (contract) | existing route-freeze guard in standalone suite + monorepo guards against npm package |

## 12. Exact Next-Step Recommendation

Proceed with **Phase 10J "Cutover Preparation"** — a single, behavior-free monorepo phase:
1. Fix the 5 stale test anchors (green suite baseline).
2. Stand up standalone-repo CI producing a pinned GHCR image.
3. Switch `docker-compose.yml` to the pinned image; keep artifact mounts as-is.
4. Migrate hub behavioral tests to the standalone repo; re-point monorepo guards at the npm package.
5. Only after 1–4: plan the split-host deployment runbook (Redis auth/TLS + `BACKEND_URL` + artifact release flow) and the artifact option-B ADR.

## 13. Verdict

**B — READY AFTER PREPARATION.**

The hub is architecturally and contractually external already (wire-level only, zero code imports, published contracts, self-contained repo + tests). Blockers are operational:

1. `docker-compose.yml` still builds the hub from the physical `./gpu-hub` directory (needs pinned image).
2. ~20 monorepo test suites hard-require `../../gpu-hub/…` — migration required before any directory removal.
3. Five artifact mounts still source monorepo trees — need a versioned artifact distribution flow (§6-D) for off-host deployment.
4. Reference Redis runs without credentials — split-host requires auth/TLS `REDIS_URL` and network exposure planning.
5. Hub→Backend callback reachability (`BACKEND_URL`) must be engineered for cross-host.
6. Backend suite currently has 5 pre-existing failures (stale Phase 10G/10H anchors) — must be green before cutover.
7. Publish strategy for `@animastor/gpu-hub` (npm/GHCR) is undecided — cutover needs a pinned, pullable image.
