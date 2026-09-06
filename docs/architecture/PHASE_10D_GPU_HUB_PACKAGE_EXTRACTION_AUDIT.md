# PHASE 10D — GPU Hub Package Extraction Audit

**Status: PASS — package boundary established, deployment preserved**
**HEAD at start:** `37f1203e5a6165d6157a53b9fa682c971516461c` (Phase 10C)
**Predecessors:** 10A (contract freeze) → 10B (canonical Job Protocol v2 consumption) → 10C (extraction readiness)
**Principle:** *GPU Hub becomes a self-contained npm package; existing production behavior and the current monorepo deployment are NOT changed.*

---

## 1. Package identity

| Field | Value |
|---|---|
| Name | `@animastor/gpu-hub` (scoped — technically fine, package is private, no publish in this phase) |
| Version | `0.1.0` |
| License | MIT (`gpu-hub/LICENSE`, root LICENSE copyright duplicated into the boundary) |
| Main | `server.js` (unchanged) |
| Runtime files | `gpu-hub.js`, `server.js`, `tarball.js`, `bootstrap.js` (unchanged sources — **zero refactoring**) |
| Package files | `README.md`, `LICENSE`, `Dockerfile`, `.dockerignore`, `package.json`, `package-lock.json` |
| `files` allowlist | the 9 entries above (pack surface, frozen by guard) |

The old stale lockfile identity (`gpu-hub@1.0.0`) is corrected to `@animastor/gpu-hub@0.1.0`.

## 2. Dependency boundary

`gpu-hub/package.json` now **declares** what the code already required:

| Dependency | Declared as | Rationale |
|---|---|---|
| `express` `^4.19.2` | `dependencies` | runtime (unchanged ranges) |
| `cors` `^2.8.5` | `dependencies` | runtime (unchanged ranges) |
| `ioredis` `^5.10.0` | `dependencies` | runtime (unchanged ranges) |
| `@animastor/contracts` `file:../contracts` | `optionalDependencies` | canonical Job Protocol v2 — a real package dependency resolving via the hub's **own** `node_modules` (npm symlink), not a hidden walk-up to monorepo root |

Decision record — why `optionalDependencies`:

- **Not vendored, not copied.** The `file:` protocol installs a symlink to
  `<repo>/contracts`; the canonical implementation stays the single source
  (guard `PB7` asserts `require.resolve` lands in `contracts/src/index.js`).
  No second Job Protocol implementation exists.
- **Why "optional" and not a hard dependency:** `docker-compose.yml` builds
  with `build: ./gpu-hub` — the build context cannot contain `../contracts`,
  and compose must not be modified in this phase. npm skips a missing
  `optionalDependencies` target with a warning (verified), so the image build
  succeeds and contracts are still provided at runtime by the **unchanged
  Phase 10B compose mount** (`./contracts:/app/node_modules/@animastor/contracts:ro`).
  Inside the monorepo (`npm ci`) the target always exists and the link is real.
- **Registry publish** (removing both the `file:` seam and the "optional"
  compromise) is the recorded gate — see §9.

No `devDependencies` — the package stays runtime-only. The zero-dependency
test runner (`gpu-hub/tests/run-all.cjs`) uses node builtins only.

## 3. Standalone install result

```
cd gpu-hub && rm -rf node_modules && npm ci   →  added 82 packages, exit 0
```

- `gpu-hub/node_modules/@animastor/contracts` → symlink to `../../contracts`.
- **Root-independence proven:** with monorepo root `node_modules/@animastor`
  temporarily removed, `require('@animastor/contracts')` from the hub tree
  still resolves and the full package test suite passes (19/19).
- Caveat (honest): *outside* the monorepo the `file:../contracts` target does
  not exist; until the registry publish gate, a standalone checkout needs the
  package provided at `node_modules/@animastor/contracts` manually (e.g. bind
  mount — exactly what compose does). This is documented in `gpu-hub/README.md`.

## 4. npm pack result

`npm pack --dry-run` → `animastor-gpu-hub-0.1.0.tgz`, **9 files / 117.8 kB unpacked**:

```
.dockerignore  Dockerfile  LICENSE  README.md
bootstrap.js  gpu-hub.js  package.json  server.js  tarball.js
```

Excluded (verified by guard `PB4` set-equality + banned-pattern scan):
`node_modules`, `tests/`, backend/worker/frontend trees, `workflows`,
install manifests, `.env`/secrets, `package-lock.json`, generated artifacts.

## 5. Docker result

- `docker build gpu-hub/` → **success** (standalone context, unchanged
  `Dockerfile` build steps; `.dockerignore` added — `node_modules`/`tests`
  no longer leak into the build context; runtime deps come from
  `npm install` of the declared manifest).
- **Runtime smoke (isolated network + ephemeral Redis, production untouched):**
  - `require('/app/gpu-hub.js')` → `buildHubApp` function; `@animastor/contracts`
    resolves via the compose-style mount; `PROTOCOL_VERSION = 2`.
  - `GET /health` → normal JSON (`gpus/queues/workspace_queues/running`).
  - `POST /task` without configured key → **503 `hub_api_key_not_configured`**
    (PW-4 fail-closed, unchanged); wrong key → **401**; valid key + invalid
    payload → **409** (protocol validation intact).
  - `GET /worker-source`, `GET /worker-bundle` with mounts absent → **404**
    (never 500 — fail-closed artifact semantics).
- `docker compose config` → **VALID**; `./contracts` mount seam, all five
  artifact mounts and the `gpu-hub` service definition unchanged.
- The running production `gpu-hub` container was never restarted (verified
  `Up 2 days` before/after).

## 6. Test result

| Suite | Result |
|---|---|
| `gpu-hub` package tests (`node tests/run-all.cjs`) | **19 / 19** — package smoke, import isolation, canonical contracts import, protocol parity, route freeze, Redis ownership |
| Contracts (`contracts` npm test) | **37 / 37** |
| Worker (`worker/tests/run-all.cjs`) | **45 / 45** |
| Hub behavior suites (backend `tests/gpu-hub-*.test.js`) | **43 / 43** |
| Backend architecture guards (incl. new `phase10d` boundary guard, 10A freeze) | **passing** (new guard: 16/16) |
| Backend full suite | **293 passing / 1 failing** — the 1 failure is the **pre-existing** `phase2-lac-transport-contract.test.js:219` regression (fails on clean HEAD too; recorded in the 10A audit; unrelated to GPU Hub) |
| Syntax smoke (`scripts/syntax-smoke.sh gpu-hub`) | all files OK |
| Protocol parity | hub ↔ contracts ↔ worker copy all equal `PROTOCOL_VERSION = 2` (10A guard G2 + package tests) |

New guard: `backend/tests/architecture/phase10d-gpu-hub-package-boundary.test.js`
(PB1 identity, PB2 frozen manifest deps, PB3 lockfile sync + contracts link,
PB4 pack surface set-equality, PB5 runtime file-set freeze, PB6 Docker
contract, PB7 canonical resolution). Existing 10A/dependency guards pass
unmodified — the package runner's requires (`fs/path/crypto`) are inside
their frozen allowlists.

## 7. Deployment compatibility — PRESERVED

- `docker-compose.yml`: **byte-untouched** (verified `git diff`).
- `./contracts:/app/node_modules/@animastor/contracts:ro` mount: kept (both
  backend and gpu-hub services).
- All five Phase 10C artifact mounts: kept, **not** replaced (explicitly
  out of scope).
- `nginx /gpu/` prefix, HTTP routes (14, frozen), Redis keys, auth (API key +
  worker credentials), Job Protocol v2, worker protocol, `worker-auth` debt
  ownership: **unchanged**.
- `gpu-hub-rebuild.sh` and compose build are path-based — unaffected by the
  npm scope rename.
- Limitation (honest): no full production integration test was executed
  (requires secrets/external services). Closest smoke = isolated-network
  container test in §5 + compose config validation + untouched running stack.

## 8. Remaining extraction blockers

1. **`@animastor/contracts` registry publish** — the only gate that upgrades
   the `file:../contracts` optional seam into a hard registry dependency and
   enables a truly standalone (out-of-monorepo) `npm ci`. After that:
   `optionalDependencies` → `dependencies`, drop the "optional" caveat.
2. **Test migration (10C step 2)** — hub behavior suites still live in
   `backend/tests/gpu-hub-*.test.js`; moving them into `gpu-hub/tests/` with
   devDependencies (or registry dev deps) is the next physical step. The
   zero-dep package runner already covers boundary checks in the meantime.
3. **Artifact mounts (5)** — cross-repo artifact delivery still relies on
   monorepo bind mounts; replacement by an artifact registry/pipeline is
   explicitly deferred (task item 8).
4. **`animastor:worker-auth`** — frozen cross-owner debt, unchanged by design
   (task item 9).

## 9. Next step (10E proposal)

Publish `@animastor/contracts` to a registry (or a committed private registry
path), then in one coordinated step: hard-pin the registry version in
`gpu-hub/package.json` `dependencies`, switch the Dockerfile to
`npm ci` (lockfile-installed contracts instead of the runtime mount), keep
the compose mount as a shadow/rollback seam, and begin migrating the hub
behavior suites into `gpu-hub/tests/`.
