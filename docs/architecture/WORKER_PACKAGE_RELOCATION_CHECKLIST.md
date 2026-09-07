# WORKER PACKAGE RELOCATION — MIGRATION CHECKLIST

**Purpose:** checklist for the NEXT commit — the physical move
`worker/worker/` → `packages/animastor-worker/`.
**Basis:** docs/architecture/WORKER_PACKAGE_RELOCATION_AUDIT.md (verdict:
MOVE AFTER PREPARATION) + the preparation commit
"Prepare worker package relocation" (this checklist's baseline).
**Layout:** Option A (wholesale boundary move — internal structure preserved):
`git mv worker packages/animastor-worker` → `packages/animastor-worker/{worker/
(bundle), tests/, tools/, README.md, *.sh, new/, image/}`. The bundle dir is
`packages/animastor-worker/worker/` — THE canonical bundle source path.

## Already prepared (this commit — nothing to redo)

| Ref | Prepared how |
|---|---|
| P1 hub Dockerfile | `ARG WORKER_BUNDLE_SRC=worker/worker` + `COPY ${WORKER_BUNDLE_SRC}/` — flip the default (step 2 below) |
| P2 compose overlay | mount already points at `./packages/animastor-worker/worker` (breaks only for pre-move checkouts — flip together with the move) |
| P3–P5 install manifests ×3 | `source.options[].path`, `env.template`, provenance already point at `packages/animastor-worker/worker/` |
| P6 `engine/worker.js` | `resolveRepoBundleDir()` — canonical first, legacy `worker/worker` fallback (inert after the move) |
| P7 `engine/engine.js` | same resolver (missing-from-repo check) |
| P8 `setup-contract.js` | canonical candidate + legacy fallback for the version resolver |
| P9 hub installer tar | entries already `animastor-installer/packages/animastor-worker/worker/*` — switched IN LOCKSTEP with P6/P7 (two-sided; never change one without the other) |
| W4 `worker/tools/sync-protocol.cjs` | relocation-independent: bundle target is boundary-relative, contracts found via repo-root depth candidates |
| T1–T17 test pins | resolved via `backend/tests/architecture/helpers.js` (`WORKER_PKG_DIR/WORKER_BUNDLE_DIR/...`) — green before AND after the move; installer fixtures already on `/tmp/repo/packages/animastor-worker/worker/` |
| P10/P11 scripts | `syntax-smoke.sh` + `animastor-runtime-audit.sh` resolve canonical-first, legacy kept |

## Move commit — exact steps

1. `git mv worker packages/animastor-worker`
2. Flip the Dockerfile default: `ARG WORKER_BUNDLE_SRC=packages/animastor-worker/worker`
3. `worker/worker/package.json` → `repository.directory: "packages/animastor-worker/worker"` (W1)
4. `packages/animastor-worker/worker/worker.cjs` header comment (W2): update the
   generated-copy path + regen command to `packages/animastor-worker/tools/sync-protocol.cjs`
5. Regenerate the copy: `node packages/animastor-worker/tools/sync-protocol.cjs`
   (W3 — header's generator path flips; body unchanged)
6. Version policy (9E): bundle bytes change in steps 4–5 → bump
   `2.1.0 → 2.1.1` in `packages/animastor-worker/worker/package.json`
   (phase9d D1 pins the version — update the pin in the same commit)
7. Optional tightening in the same commit: phase9d D4 header pin → new
   generator path only; phase9d D6 manifest pin → canonical only
8. Normative docs (F4): `docs/01-overview/ARCHITECTURE.md`,
   `docs/architecture/JOB_PROTOCOL_V2.md`, `docs/architecture/GPU_HUB_CONTRACT.md`,
   `packages/animastor-worker/README.md` (paths worker/worker/ → packages/animastor-worker/worker/)
9. Root `node_modules`: NO symlink — inbound isolation (P7-T2) forbids code
   requiring the worker; nothing to do

## Regression checklist (post-move)

- [ ] R1 `cd packages/animastor-worker && node tests/run-all.cjs` → 45/0
- [ ] R2 `node packages/animastor-worker/tools/sync-protocol.cjs --check` → exit 0
- [ ] R3 backend architecture suites (phase9d/9c/2-job-protocol/2-hub-worker/
      gpu-hub-contract/phase7/phase10a/phase10d/phase10t-1/lac-guard/
      dependency-guardrails/redis-ownership) → all pass
- [ ] R4 installer suites (setup-contract/cpu/prereq/resume/security/engine/
      uninstall/management-tools/platform) → all pass (fixtures already
      expect the canonical layout)
- [ ] R5 hub artifacts + orchestration + private-worker-phase2 + worker-setup-api
      + gpu-hub-bootstrap → pass
- [ ] R6 `cd packages/animastor-gpu-hub && node tests/run-all.cjs` → pass
- [ ] R7 full `cd backend && npm test` → no NEW failures vs baseline
- [ ] R8 `docker compose build gpu-hub` (ARG default flipped) → "artifact
      bake-in verified: 4 groups present"
- [ ] R9 compose up with `overlay-gpu-hub-local.yml` → `GET /worker-bundle/sha256` 200
- [ ] R10 `npm pack` from packages/animastor-worker/worker → clean dir → boot →
      `Protocol version: 2`
- [ ] R11 `GET /installer/bundle` tar → confirm
      `animastor-installer/packages/animastor-worker/worker/*` layout → engine
      dry-run installs the bundle
- [ ] R12 rollback = `git revert` (no data migrations involved)

## Transitional residues (intentional — cleanup is a separate follow-up)

- `worker/worker` legacy fallbacks: `backend/src/installer/worker-bundle-source.js`
  (`REPO_BUNDLE_DIRS`), `setup-contract.js` candidates, phase9d D4/D6 two-way
  pins, `lac-legacy-path-guard` roots, `syntax-smoke.sh` + `runtime-audit.sh`
  candidates, phase10t-1 comment — all existsSync/existence-guarded, inert
  after the move; prune (optionally) once the relocation has settled.
- `worker/start-worker.sh`, `worker/new/`, `worker/image/` — move with the
  boundary; installed/deployed layout `~/animastor/worker/...` is NOT touched.
- Archive/historical docs (`docs/99-archive/`, phase audits, `MEMORY.md`)
  keep their historical references by convention.
