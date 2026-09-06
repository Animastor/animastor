# PHASE 10B — GPU Hub Protocol Migration (@animastor/contracts seam) — Audit

**Status:** COMPLETE. The GPU Hub no longer carries an independent Job
Protocol v2 source — it consumes the canonical `@animastor/contracts`
package. Wire protocol, HTTP API, Redis semantics, auth, timeout/retry/
cancel, worker token format: byte-identical to the Phase 10A baseline.
**Date:** 2026-09-06
**Baseline:** HEAD `aec16dee` ("docs(arch): Phase 10A — freeze GPU Hub
contract, guards for protocol/token/Redis boundaries")
**Deliverables:** gpu-hub protocol import (gpu-hub/gpu-hub.js), Docker seam
(docker-compose.yml gpu-hub service), guard updates (phase10a suite + 4
legacy suites), GPU_HUB_CONTRACT.md §14/§14.1/§1/§5/§12 updates, this audit.

---

## 1. What was migrated

### 1.1 gpu-hub/gpu-hub.js — canonical consumption

Before (Phase 9C residue, frozen in 10A):

```js
// SYNC: backend/src/runtime/job-schema.js (PROTOCOL_VERSION)
const PROTOCOL_VERSION = 2;
```

After:

```js
const { PROTOCOL_VERSION } = require('@animastor/contracts').jobProtocolV2;
```

- The inline `PROTOCOL_VERSION = 2` literal is **removed** — the hub carries
  no local protocol implementation or literal anymore. The hand-synced copy
  (the last one on the backend↔hub↔worker seam, Phase 9C residue) is gone.
- The stale `// SYNC: backend/src/runtime/job-schema.js (PROTOCOL_VERSION)`
  comments (hub header block + the `:758` repeat) are replaced by a comment
  documenting the canonical consumption and the mount seam.
- **Scope kept minimal by design:** the hub's actual protocol usage is only
  `PROTOCOL_VERSION` (identity checks on `/beacon`, `/task`, `/task/next`,
  result/error guards, `notifyBackendError` payloads + fallback error key).
  No artificial wider refactor: no envelope helpers, no grammar imports —
  the hub's runtime validation behavior is NOT rewritten (the advisory
  helpers in contracts are not consumed; the hub's own check order and
  error tokens are untouched). The `module.exports` of the hub still exposes
  `PROTOCOL_VERSION` (same value 2) — the 10A test surface is unchanged.
- The worker-token parser (`parseWorkerToken`) is intentionally NOT migrated
  (see §5).

### 1.2 Why this does not change the wire protocol

- `@animastor/contracts` exports `PROTOCOL_VERSION = 2` — the exact literal
  the hub used to carry. The import is a **source change, not a value
  change**: every `protocol_version` check, comparison, 409 response and
  callback payload is computed from the same value 2 as before.
- No `protocol_version` semantics touched: mismatch → 409
  `protocol_version_mismatch` / 400 `invalid` on result/error — identical
  code paths, identical tokens, identical statuses.
- The diff to gpu-hub.js is limited to: the import line replacing the
  literal, and two comment lines. Zero behavioral statements changed.
- Runtime proof (container): hub `PROTOCOL_VERSION === 2 === contracts`
  canonical; app builds with the frozen 14-route surface.

---

## 2. Docker seam (Option A, as recommended by 10A §6 B1)

- `docker-compose.yml` gpu-hub service gained exactly one volume:
  `./contracts:/app/node_modules/@animastor/contracts:ro` — the same pattern
  the backend service has used since Phase 9C. Added with a comment
  explaining the seam. **All 5 pre-existing artifact mounts are untouched**
  (`/app/worker-source/worker.cjs`, `/app/worker-bundle`, `/app/workflows`,
  `/app/installer-src`, `/app/install-manifests`), as are the 6 backend
  mounts and the nginx mounts. Old deployment paths preserved.
- `gpu-hub/Dockerfile` and `gpu-hub/package.json` are **untouched** — the
  `./gpu-hub` build context stays self-contained (no `file:../contracts`
  dependency — it would break `npm install` in the build, exactly the
  blocker recorded in 10A). No npm package created, nothing published.
- Resolution inside the container: the bind mount lands at the
  `node_modules/@animastor/contracts` path Node resolves bare specifiers
  from `/app` — verified:
  - **Negative control (image without mount):**
    `require('@animastor/contracts')` → `MODULE_NOT_FOUND` (fail fast —
    the seam is mandatory, mirroring the backend container).
  - **With the compose seam:** resolves to
    `/app/node_modules/@animastor/contracts/src/index.js`;
    `c.jobProtocolV2.PROTOCOL_VERSION === hub.PROTOCOL_VERSION === 2`;
    `buildHubApp` constructs successfully with all 14 frozen routes.
- Local/dev resolution unchanged via the Phase 9C repo-root symlink
  (`node_modules/@animastor/contracts` → `../../contracts`) — no new
  install steps required.

---

## 3. Ownership before / after

| Contract | Before (10A) | After (10B) |
|---|---|---|
| Job Protocol v2 | `@animastor/contracts` canonical; backend facade re-export (OK); worker generated copy + sync tool (OK); **hub inline literal `PROTOCOL_VERSION = 2` — parity-guarded hand-synced mirror, removal = 10B** | `@animastor/contracts` canonical; backend facade, worker generated copy, **hub direct import** — `PROTOCOL_VERSION` now has a SINGLE runtime source consumed by all three components; no hand-synced protocol copy remains anywhere |
| Worker token grammar | backend `worker-repo.js` canonical; hub `parseWorkerToken` hand-synced copy (behavioral parity-guarded) | **unchanged** (contracts NOT extended this phase — see §5) |
| Hub HTTP API / routes | hub itself + GPU_HUB_CONTRACT.md §3 (14 routes) | unchanged (set-equality guards re-run green) |
| Redis ownership | registry-frozen families; hub reads backend-owned mirror | unchanged |
| Deployment identity | compose service `gpu-hub`, nginx `/gpu/`, env names, 5 ro mounts | unchanged + 1 new ro mount (the protocol seam, §14.1-updated in the contract doc) |

---

## 4. Guards (Phase 10A suite updated, legacy suites re-anchored)

### phase10a-gpu-hub-contract-freeze.test.js (13 → 13 tests, semantics updated)

- **Removed** the old guard pinning "no `@animastor/contracts` require
  before the 10B seam" (the frozen npm-dep allowlist test now admits the
  canonical package as the ONE sanctioned import; every other new bare
  specifier still fails).
- **New 10B guard:** `GPU Hub MUST import Job Protocol from
  '@animastor/contracts'; no local protocol implementation/literal allowed`
  — asserts the canonical require is present AND the file carries zero
  `PROTOCOL_VERSION = <n>` literals AND the runtime value equals canonical.
- The 10A "exactly one literal" pin is now a **zero-literal** guard.
- 3-way runtime parity kept (Worker generated copy ↔ Hub import ↔
  Contracts canonical).
- Route freeze (exact 14-route set equality), deprecated `/worker-source`
  presence, Redis ownership freeze (hub-owned constants, mirror write-ban,
  mirror-read + SYNC anchors — the protocol SYNC anchor assertion updated to
  the canonical require), Worker token parity matrix: all preserved.

### Legacy suites updated in the same commit (no guard removed)

- `gpu-hub-contract.test.js` + `phase2-job-protocol-v2.test.js`: the
  "literal = 2 in hub" pins became "hub has NO literal + consumes the
  canonical package"; contracts (canonical) + worker generated copy pins
  unchanged; SYNC-anchor assertions updated to the canonical require.
- `phase9c-contracts.test.js`: literal allowlist no longer lists the hub
  (C3); dependency-direction C5 now allows exactly two production
  consumers (backend facade + gpu-hub.js); C6 parity pins updated
  (hub = no local literal); **C7 gained a new deployment guard**: the
  gpu-hub compose service must mount `./contracts:/app/node_modules/
  @animastor/contracts:ro` (section-scoped assertion — the mount cannot
  silently disappear).
- `orchestration-stabilization.test.js`: strict-version-2 guard re-anchored
  (hub consumes contracts; `PROTOCOL_VERSION = \d` banned in hub source).
- `dependency-guardrails.test.js`: hub dependency allowlist admits the
  canonical package (same semantics as the 10A suite).

---

## 5. Worker token parser — intentionally NOT migrated (per phase constraints)

- `parseWorkerToken` stays a hand-synced hub copy; **`@animastor/contracts`
  is NOT extended this phase** (no `worker-token.js` added, package scope
  stays frozen to Job Protocol v2).
- The existing 10A behavioral parity matrix (11 fixtures × hub vs
  `worker-repo.parseToken`) is preserved and green — the regression net for
  the future consolidation.
- Recorded as the next step after the seam (10A §6 B2): adding
  `contracts/src/worker-token.js` (additive) and rewiring hub +
  optionally worker-repo. Now unblocked by the seam resolved here; remains
  a separate, deliberate scope decision.

---

## 6. Tests (measured at HEAD + 10B changes)

| Suite | Command | Result |
|---|---|---|
| Architecture guards (incl. updated phase10a) | `cd backend && npx mocha --exit tests/architecture/*.test.js` | **277 passing / 1 failing** — the 1 failure is the pre-existing LAC guard regression (`phase2-lac-transport-contract.test.js:219`, recorded in Phase 10 §8.4 and 10A §5; deliberately NOT fixed here). 275 → 277: +2 (phase9c C7 gpu-hub mount guard; phase10a new canonical-import guard net of renamed assertions), 0 regressions. |
| GPU Hub contract suites | `cd backend && npx mocha --exit "tests/gpu-hub-*.test.js" tests/fail-closed-worker-auth.test.js tests/private-worker-visibility.test.js` | **84 passing** |
| Phase2/share/setup/installer suites | `cd backend && npx mocha --exit tests/private-worker-phase2.test.js tests/worker-share-grants.test.js tests/worker-share-policy.test.js tests/worker-setup-api.test.js tests/installer-platform.test.js` | **186 passing** |
| Contracts package baseline | `cd contracts && npm test` | **37 pass / 0 fail** (untouched) |
| Worker package | `cd worker && node tests/run-all.cjs` | **45 pass / 0 fail** (untouched) |
| Worker protocol parity | `cd worker && tools/sync-protocol.cjs --check` | **SYNC OK** |
| Syntax smoke | `bash scripts/syntax-smoke.sh` | **All production JS/CJS pass** (backend/src, gpu-hub, worker, ai-connector, contracts) |
| Focused re-anchored suites | phase10a + gpu-hub-contract + phase2-job-protocol + phase9c + orchestration-stabilization | **69 passing** |

---

## 7. Deployment verification

| Check | Result |
|---|---|
| `docker compose config` | Valid; the resolved gpu-hub service carries the new bind mount (`/home/animastor/animastor/contracts` → `/app/node_modules/@animastor/contracts`, `read_only: true`) plus all 5 pre-existing artifact mounts; backend/nginx sections unchanged; env vars unchanged (`GPU_HUB_API_KEY`, `GPU_TIMEOUT`, `SHARE_FEATURES_ENABLED` parity with backend preserved). |
| GPU Hub image build | `docker compose build gpu-hub` — success (context still `./gpu-hub` only; no package.json/Dockerfile change needed). |
| Container resolution | Negative control (no mount): `MODULE_NOT_FOUND` fail-fast. With the seam: `require.resolve('@animastor/contracts')` → `/app/node_modules/@animastor/contracts/src/index.js`; hub PROTOCOL_VERSION = 2 = canonical. |
| Minimal container smoke | `buildHubApp` constructs inside the container with a redis stub → HTTP app with the 14 frozen routes. |
| Existing Worker bundle / `/worker-source` / `/worker-bundle` / installer / nginx `/gpu/` | No code or config touched — mounts and routes byte-identical (route-set guard re-verified). |
| Old deployment paths | None removed: `/worker-source` still served (deprecation headers guard intact), 5 artifact mounts, backend mounts, `gpu-hub-rebuild.sh` flow unchanged. |

---

## 8. Remaining blockers before 10C (test-ownership migration)

| # | Item | Status |
|---|---|---|
| B2 (10A) | Hub inline token parser → contracts (`worker-token.js`, additive). Seam now resolved; only the scope decision remains. | Deferred (separate phase step, per constraints) |
| B3 (10A) | Hub suites live in `backend/tests/`; guards reference `REPO_ROOT/gpu-hub`. | 10C scope (untouched here) |
| B4 (10A) | Package identity debt (unscoped `gpu-hub@0.1.0`, lock drift). | 10D scope |
| — | Backend reverse writes into hub-owned Redis families. | Frozen debt, baselined; Phase 5/12 item |
| — | Pre-existing LAC guard regression (`phase2-lac-transport-contract.test.js:219`) + F1/F2/F6 findings. | Deliberately not touched, per phase constraints |

**Hard-constraint compliance:** protocol semantics/value (2) unchanged; no
HTTP API/Redis/auth/timeout-retry-cancel/worker-token changes; no physical
hub move, no npm package/publish; `/worker-source` kept; no unrelated
refactor; old F1/F2/F6 and the LAC regression untouched; the only
production-behavior-adjacent change is the documented compose mount (Option
A, sanctioned by the 10A audit) — had the seam not been safely implementable,
the phase would have stopped as BLOCKED with no workaround (it was).

---

## 9. Verdict

**PHASE 10B: PASS.** `@animastor/contracts` is now the single runtime source
of Job Protocol v2 for backend, hub and worker; the hub's Phase 9C residue
(the last hand-synced protocol literal on the seam) is physically removed
under the documented Docker seam; guards enforce the new invariant
("canonical import mandatory, no local protocol implementation/literal");
wire behavior, deployment identity and all frozen contracts are
byte-identical to the 10A baseline. Ready for Phase 10C.
