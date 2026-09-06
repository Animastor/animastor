# PHASE 10A — GPU Hub Contract Freeze & Isolation Preparation — Audit

**Status:** COMPLETE. Contract freeze only — no runtime, wire, Redis, auth,
deployment, or Docker changes.
**Date:** 2026-09-06
**Baseline:** HEAD `ddb35bc8` ("docs: add Phase 10 GPU Hub extraction
readiness audit (READY AFTER PREPARATION)")
**Predecessor:** PHASE_10_GPU_HUB_EXTRACTION_READINESS_AUDIT.md (verdict
**B — READY AFTER PREPARATION**)
**Deliverables:** `docs/architecture/GPU_HUB_CONTRACT.md` (frozen contract),
`backend/tests/architecture/phase10a-gpu-hub-contract-freeze.test.js` (13
guards), this audit.

---

## 1. What became frozen

### 1.1 `docs/architecture/GPU_HUB_CONTRACT.md` — the hub's actual contract

Documented from source at HEAD (nothing invented, no new API):

| Area | Sections | Status |
|---|---|---|
| Canonical ownership map (9 contract rows: protocol, routes, token, mirror, Redis families, heartbeat, result/error keys, tarball layouts, artifact versions) | §1 | `[NORMATIVE — FROZEN]` canonicals + named duplicate copies |
| Service identity & transport (Docker service, DNS, nginx `/gpu/`, 3 npm deps, no PG/WS/pub-sub, 500 mb JSON) | §2 | FROZEN deployment identity + `[KNOWN LIMITATION]` (no rate limiting) |
| **Exact HTTP route surface — 14 routes** (6 core + deprecated `/worker-source` + 7 artifact/health routes) | §3 | `[NORMATIVE — FROZEN]`, set-equality pinned by guard |
| Auth planes: backend `x-api-key` (header-only, fail-closed 503), worker Bearer (fail-closed 401, mirror-resolved, never query/body), hub→backend callback asymmetry | §4 | FROZEN + `[KNOWN LIMITATION]` recorded (backend callback open-when-unset) |
| Worker token contract `wrk.<id>.<secret>`: grammar, canonical owner, hub consumer copy, fail-closed parse semantics | §5 | Format `[NORMATIVE — FROZEN]` |
| Artifact endpoints: `/worker-source` (DEPRECATED, `Deprecation`+`Link` headers), `/worker-bundle(+/sha256)` (deterministic, `animastor-worker/` prefix, version from canonical package.json, `.env` never served), `/workflow/:id` (allowlist + traversal defense), `/installer` family (launcher gates, fail-closed query validation, Host-derived URL) | §6 | FROZEN |
| `/health` payload shape | §7 | `[CURRENT BEHAVIOR]` + `[KNOWN LIMITATION]` (unauthenticated disclosure) |
| **Redis contracts**: 12 hub-owned families with types/TTLs/value shapes; backend-owned `animastor:worker-auth` (hub READS, never writes — expiry re-checked on read); backend reads of hub families; **reverse writes from backend frozen as debt** (drainPolicyLane, registry hdel, heartbeat del, `animastor:job:*` dedup dels, result purge); cancellation flow | §8 | FROZEN (registry `redis-registry.js` stays the machine-enforced canonical) |
| Worker ↔ Hub flow (beacon → poll → result/error with exact payloads, statuses, lane semantics) | §9 | FROZEN |
| Backend ↔ Hub flow (dispatch envelope incl. backend-authored workspace/policy stamps, callbacks, cancel, setup probes) | §10 | FROZEN |
| Error semantics: full token table (24 tokens × HTTP status × endpoint × condition) | §11 | FROZEN |
| Environment & config: 9 env vars with defaults + invariants (`GPU_TIMEOUT_MS < STALL_FAILSAFE_MS`, `GPU_HUB_API_KEY`/`SHARE_FEATURES_ENABLED` compose parity), 9 test-only config overrides, 5 read-only mount targets, zero FS writes | §12 | FROZEN names/semantics |
| Timeout/retry/cancel semantics: per-job timeout floor, per-GPU timeout, cleanup order, orphan sweep (grace 60 s / cap 3 → dead-letter), 5×500 ms delivery retries, dedup release rules | §13 | FROZEN division of responsibility (backend owns re-dispatch) |
| Job Protocol v2 hub status + **the Docker blocker** + two documented migration seams (10B Option A compose mount / Option B generated copy) | §14 | FROZEN behavior; blocker `[KNOWN LIMITATION]` |
| Compatibility requirements: 6 invariant groups any 10B–10F change must preserve | §15 | FROZEN |

### 1.2 Protocol ownership — hub demoted from independent source of truth

- The canonical `PROTOCOL_VERSION` is `@animastor/contracts`
  (`contracts/src/job-protocol-v2.js`; normative spec JOB_PROTOCOL_V2.md).
  The hub's inline literal is now a **parity-guarded mirror**, not an
  independent source:
  - existing guard pinned all three literal copies to `2`
    (gpu-hub-contract.test.js);
  - **new:** runtime import equality — `gpu-hub.PROTOCOL_VERSION ===
    contracts.PROTOCOL_VERSION === worker generated copy` (a refactor that
    changes how the literal is computed can no longer silently drift), plus
    a single-literal guard (no accidental second copy in gpu-hub.js).
- Job_id grammar: documented that the hub never parses job_id (identity
  segments come from the backend-authored envelope); result-key layout is
  frozen in the contract doc; the grammar itself stays canonical in
  contracts. No hub code change required — no grammar implementation exists
  hub-side to migrate.

### 1.3 Worker token contract — canonical ownership fixed

- **Canonical:** `backend/src/storage/postgres/repositories/worker-repo.js`
  (`parseToken` + `generateCredential`; PG stores `sha256(secret)` only).
- **Hub consumer copy:** `gpu-hub.js parseWorkerToken` — hand-synced.
- **New guard (behavioral parity):** both implementations run against an
  11-fixture matrix (valid token, uppercase UUID, empty secret, wrong
  prefix, 2/4 segments, non-UUID self-locator, empty string, null,
  undefined, non-string) — identical accept/reject decisions, identical
  `workerId`/`secretHash`. Format itself untouched (`[NORMATIVE — FROZEN]`).
- Extracting the grammar helper into `@animastor/contracts` was evaluated
  and **deferred** (see §4 "intentionally not changed"): it would expand the
  contracts package beyond its frozen Job Protocol v2 scope, and the hub
  cannot consume contracts until the §14 Docker seam is resolved — so the
  extraction would create a third, unconsumed copy this phase. Recorded as
  the next step instead.

---

## 2. Canonical ownership (post-10A state)

| Contract | Canonical | Mirrors |
|---|---|---|
| Job Protocol v2 | `@animastor/contracts` | backend facade (re-export), worker generated copy (sync tool), hub inline literal (**parity-guarded; removal = 10B**) |
| Hub HTTP API | hub itself + GPU_HUB_CONTRACT.md §3 | consumer literals (worker.cjs, gpu-dispatcher.js) — guard-pinned |
| Worker token grammar | backend `worker-repo.js` | hub `parseWorkerToken` (**parity-guarded**) |
| Worker-auth mirror shape | backend `services/worker-auth.js mirrorValue` | hub `authenticateWorkerMirror`/`sanitizeSharePolicy` (SYNC anchors guard-pinned) |
| Redis keyspace ownership | `backend/tests/architecture/redis-registry.js` (machine-enforced) | key literals hub+backend (registration + cross-owner-write guards) |
| Hub contract document | GPU_HUB_CONTRACT.md | — (guards tie route set, key constants, parity to it) |

---

## 3. Remaining coupling (unchanged, now documented + guarded)

1. **Hub inline `PROTOCOL_VERSION = 2`** (gpu-hub.js:33) — Phase 9C residue;
   the last hand-synced protocol copy. Parity-guarded now; physical removal
   = 10B (needs the Docker seam).
2. **Hub inline token parser** — parity-guarded now; consolidation into
   contracts = next step after the seam.
3. **Backend reverse writes into hub-owned Redis families** — frozen debt
   (drainPolicyLane, registry hdel, heartbeat del, dedup dels); baselined in
   redis-ownership.test.js; Phase 5/12 hub-API item. Cannot move with the
   hub; documented in GPU_HUB_CONTRACT.md §8.4.
4. **Deployment coupling** — 5 monorepo-relative compose mounts feeding the
   artifact endpoints, compose service name, nginx `/gpu/`, env var names.
   Deployment identity frozen in the contract doc; unchanged.
5. **Test ownership** — hub suites still live in `backend/tests/` (10C item,
   untouched here).

---

## 4. Changed vs intentionally NOT changed

### Changed (3 files, all docs/guards)

| File | Change |
|---|---|
| `docs/architecture/GPU_HUB_CONTRACT.md` | NEW — frozen contract (§1 above) |
| `backend/tests/architecture/phase10a-gpu-hub-contract-freeze.test.js` | NEW — 13 guards: import isolation (no backend/worker/frontend/monorepo requires; frozen npm set incl. an explicit "no `@animastor/contracts` require before the 10B seam" pin), protocol runtime equality + single-literal + 3-way no-drift, EXACT 14-route set equality (additions AND removals fail), deprecated `/worker-source` presence, hub-owned key constants freeze, worker-auth mirror write-ban + read/SYNC anchors, token parity matrix (3 tests) |
| `docs/architecture/PHASE_10A_GPU_HUB_CONTRACT_FREEZE_AUDIT.md` | NEW — this audit |

### Intentionally NOT changed (hard constraints honored)

- `gpu-hub/` physically untouched — not moved, no npm package, no publish,
  no package.json/Dockerfile edit.
- HTTP API: zero changes (route set frozen by new guard; every endpoint's
  semantics byte-identical).
- Job Protocol v2: value stays 2; no wire change; hub keeps its inline
  literal (blocker §14 of the contract doc — direct package consumption
  would require a compose mount or break the `./gpu-hub` Docker build
  context; both are deployment/build changes forbidden this phase).
- Redis: no ownership moves, no behavior change; `redis-registry.js` and
  all keys/TTLs/payloads byte-identical.
- Auth: token format, mirror, fail-closed lanes untouched.
- Timeout/retry/cancel semantics untouched.
- Docker deployment: `docker-compose.yml`, Dockerfiles, mounts, scripts —
  untouched.
- No old paths removed (`/worker-source` stays; guard-pinned).
- No unrelated refactors.
- **F1/F2/F6 not touched** (pre-existing findings remain exactly as
  recorded by Phase 10; the only arch failure in the baseline is the
  pre-existing LAC guard regression `phase2-lac-transport-contract.test.js:219`
  — unrelated to the hub, recorded in the Phase 10 audit §8.4, deliberately
  not fixed here).

---

## 5. Test baseline (measured at HEAD + 10A additions)

| Suite | Command | Result |
|---|---|---|
| Architecture guards (incl. 13 new phase10a) | `cd backend && npx mocha --exit tests/architecture/*.test.js` | **275 passing / 1 failing** — the 1 failure is the pre-existing LAC guard regression (phase2-lac-transport-contract.test.js:219, `/is a stale trace/` regex vs reflowed comment; unrelated to GPU Hub, recorded in Phase 10 audit §8.4). 262 → 275 = +13 new guards, 0 regressions. |
| GPU Hub contract suites | `cd backend && npx mocha --exit "tests/gpu-hub-*.test.js" tests/fail-closed-worker-auth.test.js tests/private-worker-visibility.test.js` | **84 passing** |
| Phase2/share/setup/installer suites | `cd backend && npx mocha --exit tests/private-worker-phase2.test.js tests/worker-share-grants.test.js tests/worker-share-policy.test.js tests/worker-setup-api.test.js tests/installer-platform.test.js` | **186 passing** |
| Contracts package | `cd contracts && npm test` | **37 pass / 0 fail** |
| Worker package | `cd worker && node tests/run-all.cjs` | **45 pass / 0 fail** |
| Worker protocol parity | `cd worker && node tools/sync-protocol.cjs --check` | **SYNC OK** |
| Syntax smoke | `bash scripts/syntax-smoke.sh` | **All production JS/CJS files pass** (backend/src, gpu-hub, worker, ai-connector, contracts) |

No new failures appeared; the only failing test is the pre-existing,
previously-recorded LAC one. Backend contract suites for the hub are fully
green.

---

## 6. Blockers before Phase 10B (protocol migration)

| # | Blocker | Type | Resolution path (10B) |
|---|---|---|---|
| B1 | Hub Docker build context is `./gpu-hub` only — `@animastor/contracts` is not resolvable inside the image (no registry package, no mount; a `file:../contracts` dep breaks `npm install` in the build). Backend solves this with a compose read-only mount (docker-compose.yml:95-98); replicating it for gpu-hub is a **docker-compose deployment change**, which was out of scope for 10A. | Deployment seam | **Option A (recommended):** add `./contracts:/app/node_modules/@animastor/contracts:ro` to the gpu-hub compose service + switch gpu-hub.js to `require('@animastor/contracts').jobProtocolV2` (drop inline literal; update G-guards: remove the "no contracts require" pin, keep equality). **Option B:** worker-style generated copy `gpu-hub/job-protocol-v2.cjs` + sync tool + parity guard. Value stays 2 either way; zero wire change. |
| B2 | Hub inline token parser cannot consume contracts either (same B1 seam); consolidation into `@animastor/contracts` would also expand the package's published scope beyond the frozen Job Protocol v2 (package description/`files` are protocol-scoped). | Scope decision | After B1: add `contracts/src/worker-token.js` (additive), rewire hub + optionally worker-repo to consume, keep the parity matrix as the regression net. |
| B3 | Hub suites live in `backend/tests/` (`require('../../gpu-hub/...')`); guards reference `REPO_ROOT/gpu-hub` paths. | Sequencing | 10C (test-ownership migration) before/with 10F; guards stay in the monorepo as cross-package seam guards. |
| B4 | Package identity debt (unscoped `gpu-hub@0.1.0`, lock drift `1.0.0`, no files/README/LICENSE) — npm-public only. | 10D | Per Phase 10 §10 plan (10D → 10H). |

---

## 7. Verdict

**PHASE 10A: PASS.** The GPU Hub's real behavior is now a written, tagged,
guard-enforced contract; Job Protocol v2 and the worker token grammar have
single canonical owners with the hub's hand-synced copies demoted to
parity-guarded mirrors; Redis ownership is documented with the reverse-write
debt explicitly baselined; route surface is exact-set frozen. Production
behavior, wire protocol, Redis semantics, auth, timeout/retry/cancel and the
Docker deployment are byte-identical to baseline `ddb35bc8`. Ready for
Phase 10B (protocol migration via the documented seam).
