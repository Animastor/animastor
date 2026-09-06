# PHASE 10J — GPU Hub Cutover Preparation Audit

**Status: PASS — verdict B (READY AFTER PREPARATION; cutover = Phase 10K)**
**Date:** 2026-09-06
**Monorepo HEAD (baseline):** `83ae64b25fe5bff3a12f8fd507aada6fb302a732`
**Standalone repo:** `Animastor/animastor-gpu-hub` (CI added; no publish)
**Package:** `@animastor/gpu-hub@0.1.0`
**Scope:** debt removal + cutover preparation ONLY. No `gpu-hub/` deletion, no
production switch, no npm/GHCR publish, no API/Redis/auth/protocol/worker/nginx
`/gpu/` changes, no artifact mount target changes, no artifact service, no
split-host deployment, no unrelated refactors.

---

## 1. Executive Summary

All five stale architecture anchors left behind by the Phase 10G registry
migration are fixed, and the backend suite is green again (306 passing / 0
failing — was 289/5). New guards freeze the transitional contract:
`gpu-hub/` is a fixture, backend runtime may never import it, the compose
`gpu-hub` service keeps the local build as default but now carries a pinned
image override seam (`GPU_HUB_IMAGE` + overlay file). The standalone repo
received a self-verifying CI workflow (tests, pack surface, Docker smoke,
protocol parity — deliberately no publish). Living documentation now
separates standalone source of truth from the transitional fixture.

**Nothing in production behavior changed.**

## 2. What was fixed — stale anchors (Phase 10I findings)

| # | Finding (10I §8) | Fix | Guard kept strong? |
|---|---|---|---|
| 1 | `phase10d` dependency set expected `cors/express/ioredis` + optional `file:../contracts` | Now freezes the post-10G set: `@animastor/contracts ^0.1.0` REQUIRED registry dep + cors/express/ioredis; `optionalDependencies` must NOT return (reintroduction of the `file:` seam fails) | ✅ stronger |
| 2 | `phase10d` lockfile expected `file:` resolution | Now requires registry resolution `https://registry.npmjs.org/…/contracts-0.1.0.tgz` + pinned sha512 integrity; `file:` link forbidden | ✅ stronger |
| 3 | `phase10d` PB7 expected realpath === monorepo `contracts/src` | Now: resolution must land INSIDE the hub tree (self-contained install; root-fallback forbidden) + identity `@animastor/contracts@0.1.0` + NEW protocol-parity test (hub copy `PROTOCOL_VERSION` === monorepo canonical — a diverging copy is a fork) | ✅ parity-based, monorepo-root fallback now explicitly forbidden |
| 4 | `phase9c` C7 required the `./contracts` mount in the gpu-hub compose section | INVERTED: the gpu-hub compose section must NOT contain a contracts mount (a mount would shadow the registry copy and silently reintroduce the monorepo coupling). Backend mount unchanged. Same inversion in `phase10d` PB6. | ✅ stronger (shadow-mount regression is now guarded) |
| 5 | LAC anchor `is a stale trace` failed (comment line-wrapped in `shared-pool.js`) | Wrap-tolerant anchor `is a stale *(//)?* trace` + NEW second anchor `NEVER consulted here` — the invariant (PG status stale, `registry.isLive` authoritative) stays enforced regardless of comment layout | ✅ stronger (two anchors, layout-independent) |

Also corrected in passing (same files, semantics only):
- `phase9c` C5: the hub is no longer listed as a relative consumer of
  monorepo `contracts/` sources (10G registry dependency); NEW test forbids
  any `backend/src` file bypassing the facade via the bare npm specifier
  (closes a previously dead-code check).
- `phase10d` file header rewritten to describe the CURRENT (post-10G/10H)
  invariants PB1–PB7.

## 3. New guard — transitional fixture (`phase10j-gpu-hub-transitional-fixture.test.js`, 10 checks)

- **TF1** `gpu-hub/` must exist (removal is a Phase 10K decision) with the
  frozen package identity; backend `package.json` must not declare
  `@animastor/gpu-hub` as a dependency.
- **TF2** No runtime imports from `backend/src` into `gpu-hub/` — relative
  paths AND bare specifiers (`@animastor/gpu-hub`, `gpu-hub/...`);
  `docker/e2e` tooling may not source-require the hub either. Backend ↔ Hub
  coupling stays wire-level (HTTP `HUB_URL` + shared Redis + API key).
  (Complements the existing physical-path guard P7-T3.)
- **TF3** Compose parameterization frozen: `build: ./gpu-hub` default stays
  (production NOT switched), `image: ${GPU_HUB_IMAGE:-animastor-gpu-hub:local}`
  present, moving tags forbidden, `.env.example` documents the opt-in
  variable, the cutover overlay exists and requires a pinned image.
- **TF4** The five artifact mounts stay frozen (targets AND monorepo
  sources) while the fixture exists.

## 4. Docker cutover preparation (NOT activated)

| Piece | State |
|---|---|
| Single image reference | `docker-compose.yml` gpu-hub service: `image: ${GPU_HUB_IMAGE:-animastor-gpu-hub:local}` added alongside `build: ./gpu-hub` — default behavior byte-identical (local build, only the auto-generated image name becomes explicit) |
| Overlay file | `docker/compose/overlay-gpu-hub-standalone.yml` — `build: !reset null` + `image: ${GPU_HUB_IMAGE:?…}`; requires compose ≥ 2.24.4 (`!reset`); used ONLY on cutover day; refuses to apply without a pinned `GPU_HUB_IMAGE` |
| Pinned reference rule | documented in overlay + `.env.example` + audit: pin by digest (`ghcr.io/animastor/animastor-gpu-hub@sha256:<digest>`), moving tags forbidden; record the digest in the cutover audit |
| Verified | `docker compose config` OK (base); overlay merges cleanly with a pinned var and removes `build:` (both checked); GPU_HUB_IMAGE intentionally NOT in the runtime-audit secret redaction list (not a secret) |

## 5. Standalone GPU Hub CI (repo `Animastor/animastor-gpu-hub`)

`.github/workflows/ci.yml` (push/PR, node 20, no publish steps):

1. **package job** — `npm ci` (registry resolution of contracts),
   standalone suite `node tests/run-all.cjs` (19 checks: package smoke,
   dependency isolation, canonical contracts, protocol parity, 14-route
   freeze, Redis ownership), `npm pack --dry-run` (frozen 9-file surface).
2. **docker job** — image build; isolated smoke on a disposable redis:7
   network (all steps executed and verified locally during this phase):
   `/health` → 200 ok; `/task` no-key → 401; bad-key → 401; v1 envelope →
   409 `protocol_version_mismatch`; artifact routes without mounts →
   frozen 404 tokens (`worker_bundle_unavailable`, `installer_unavailable`,
   workflow 404); `/task/next` unauth → 401; `PROTOCOL_VERSION === 2`
   asserted INSIDE the container.
3. **Publishing deliberately absent** — npm/GHCR push requires the separate
   decision recorded in the cutover audit (a warning comment in the
   workflow says exactly this).

## 6. Test transition plan (recorded split — no moves in this phase)

**Standalone repo (already true, keep):** runtime/behavioral hub suites
(artifacts, bootstrap installer E2E, worker-source, cleanup, orphan, auth
planes, dedup, lane routing), route freeze, Redis ownership constants,
artifact 404 behavior, Docker smoke, package boundary, protocol parity.

**Monorepo (keep):** cross-module contract guards (`gpu-hub-contract`,
`phase2-hub-worker-boundary`, `phase2-job-protocol-v2`,
`phase2-redis-ownership-contract`, `redis-ownership`, `phase9c/9d`,
`phase10a`, `phase10d`, `phase10j`, `dependency-guardrails` R1/R2/R7,
P7-T3), backend↔hub integration via `gpu-hub` module where behavioral
suites exercise the real hub code, deployment guards (compose anchors).

**Transitional fixture (`gpu-hub/`, until Phase 10K):** all monorepo suites
that `require('../../gpu-hub/…')` — `gpu-hub-artifacts`,
`gpu-hub-bootstrap`, `gpu-hub-worker-source`, `orchestration-stabilization`,
`fail-closed-worker-auth`, `private-worker-phase2`,
`private-worker-visibility`, `worker-setup-api`, `worker-share-grants`,
`worker-share-policy`, `installer-platform`, `gpu-hub-cleanup` (dispatch
engine), plus the architecture guards reading the physical dir
(`gpu-hub-contract`, `phase2-hub-worker-boundary`, `phase10a`, `phase10d`,
`phase9c` hub anchors). **Cutover rule (10K):** these suites move to the
standalone repo (behavioral) or re-point at the npm package (contract
guards) BEFORE `gpu-hub/` is deleted — enforced by TF1 (fixture must
exist) and documented in GPU_HUB_CONTRACT.md.

## 7. Documentation updates (living docs only)

- `GPU_HUB_CONTRACT.md` — new "Source of truth (Phase 10J)" scope block
  (standalone repo = source of truth; monorepo `gpu-hub/` = transitional
  fixture; wire contracts unchanged); canonical-ownership row updated to
  registry consumption; §12: Phase 10B contracts mount marked
  `[RETIRED IN PHASE 10G]` with the shadow-mount warning.
- `docs/01-overview/SYSTEM_MAP.md` — GPU Hub row: standalone source of
  truth + transitional fixture note + wire-level coupling.
- `docs/01-overview/PROJECT_STRUCTURE.md` — `gpu-hub/` marked
  `[TRANSITIONAL FIXTURE — Phase 10J]` with the cutover conditions.
- `docs/architecture/architecture-map.md` — §8 GPU Hub heading updated
  (source of truth + fixture).
- Historical audit documents were NOT rewritten.

## 8. Verification results

| Check | Result |
|---|---|
| Backend suite (`backend/ npm test`) | ✅ **306 passing / 0 failing** (was 289/5) |
| New phase10j guard | ✅ 10/10 |
| Contracts (`contracts/ npm test`) | ✅ 37/37 |
| Worker (`worker/ tests/run-all.cjs`) | ✅ 45/45 |
| GPU Hub standalone (`animastor-gpu-hub`) | ✅ 19/19 |
| Protocol parity | ✅ contracts=2, hub registry copy=2, worker generated copy=2 |
| `scripts/syntax-smoke.sh` | ✅ all production JS/CJS pass |
| `docker compose config` (base) | ✅ OK — default unchanged (builds `./gpu-hub`, local image tag) |
| Overlay merge (pinned var) | ✅ `build:` removed, pinned image applied, mounts/env untouched |
| Standalone CI | ✅ committed & pushed; all smoke steps executed locally beforehand |
| Backend → gpu-hub runtime imports | ✅ 0 (relative + bare scans) |

## 9. Intentionally NOT done (per constraints)

- `gpu-hub/` NOT deleted; production NOT switched (compose still builds the
  fixture by default; `GPU_HUB_IMAGE` unset).
- No npm/GHCR publish (CI has no push steps).
- No changes to API routes, Redis key families, auth, Job Protocol v2,
  Worker Protocol, nginx `/gpu/`, artifact mount targets.
- No artifact service/object storage, no split-host deployment.
- No test migration executed (plan recorded in §6 only).
- No historical audit doc rewrites.

## 10. Remaining blockers (for Phase 10K cutover)

1. **Publish strategy undecided** — `@animastor/gpu-hub` npm package and/or
   GHCR image publication (requires a GitHub Actions publish job + secret
   setup + digest pinning policy).
2. **Test migration** — the transitional fixture suites (§6) must move to
   the standalone repo / re-point at the npm package before `gpu-hub/`
   removal.
3. **Artifact distribution flow** — the five artifact mounts still source
   monorepo trees; a versioned artifact release flow (Phase 10I option D)
   is required for any deployment where the monorepo checkout is absent.
4. **Image digest pin** — actual digest available only after the first
   published image build.
5. **Split-host items (NOT needed for same-host cutover)** — Redis
   auth/TLS `REDIS_URL`, `BACKEND_URL` callback reachability, network
   planning (Phase 10I §7/§9).

## 11. Exact Phase 10K plan (cutover)

1. Decide + wire publishing: standalone repo CI gains an explicit publish
   job (npm on version tag; GHCR image on every commit + version tags).
   Record the first pinned digest.
2. Migrate behavioral hub suites to the standalone repo; re-point monorepo
   contract guards at the npm package (pinned version).
3. Monorepo: set `GPU_HUB_IMAGE=<digest>` + apply the overlay; verify the
   image runtime files are sha256-identical to the standalone repo HEAD;
   run the full verification gate (§8 list) against the image-backed hub.
4. Remove `build: ./gpu-hub` from the base compose; keep `gpu-hub/` one
   more phase as a cold fallback OR delete it in the same phase once the
   fixture suites are gone (TF1 guard updated by the same commit).
5. Update living docs to remove the "transitional" marker; run the full
   gate; final cutover audit with verdict A/B/C.

## 12. Verdict

**B — READY AFTER PREPARATION** (expected). The monorepo is now
debt-free and prepared for the cutover; the remaining blockers are
publication + test migration + artifact flow — all Phase 10K work items,
none architectural.
