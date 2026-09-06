# PHASE 9E — NPM Public Release Audit

**Status:** PUBLIC NPM READY
**Date:** 2026-09-06
**Package:** `animastor-worker@2.1.0`
**Baseline commit:** `78774a3af4e08be6268704e313dd3293f01e9f01`
**Scope:** npm public-release readiness of `worker/worker/package.json`
**npm publish executed:** NO

---

## Verdict

| Question | Answer |
|---|---|
| Package metadata ready for public npm? | **YES** |
| Tarball clean of secrets/stray files? | **YES** |
| Security audit passed? | **YES** |
| License matches repo? | **YES — MIT** |
| README complete? | **YES** |
| Standalone from tarball? | **YES** |
| Protocol v2 intact? | **YES** |
| Deployment channels intact? | **YES** |
| Tests pass? | **YES (45/45)** |
| Public npm ready? | **YES** |

---

## 1. Changes Made

### `worker/worker/package.json`

| Change | Before | After |
|---|---|---|
| `private` | `true` | **removed** (defaults to `false`) |
| `license` | `"ISC"` | `"MIT"` |
| `description` | `"...Animastor Private GPU Worker..."` | `"...Animastor GPU Worker..."` |
| `repository` | *(absent)* | `https://github.com/Animastor/animastor.git` (directory: `worker/worker`) |
| `bugs` | *(absent)* | `https://github.com/Animastor/animastor/issues` |
| `homepage` | *(absent)* | `https://animastor.in` |

### `worker/README.md`

- Added **"Install from npm"** section with `npm install animastor-worker` instructions.
- Added **"License"** section (MIT, links to repo LICENSE).
- Removed stale `private: true` line from architecture invariants.

### Test guards updated

| File | Change |
|---|---|
| `backend/tests/architecture/phase9d-worker-package.test.js:67` | `expect(pkg.private).to.equal(true)` → `expect(pkg.private).to.not.equal(true)` |
| `worker/tests/package.test.cjs:38` | `pkg.private === true` → `pkg.private !== true` |

---

## 2. Final Package Metadata

```json
{
  "name": "animastor-worker",
  "version": "2.1.0",
  "description": "Animastor GPU Worker runtime bundle...",
  "main": "worker.cjs",
  "files": ["worker.cjs", "worker-env.cjs", "worker-cleanup.cjs", "worker-cleanup-journal.cjs", "job-protocol-v2.cjs", ".env.example"],
  "scripts": { "start": "node worker.cjs", "test": "node ../tests/run-all.cjs", "sync:protocol": "node ../tools/sync-protocol.cjs", "check:protocol": "node ../tools/sync-protocol.cjs --check" },
  "engines": { "node": ">=18" },
  "repository": { "type": "git", "url": "https://github.com/Animastor/animastor.git", "directory": "worker/worker" },
  "bugs": { "url": "https://github.com/Animastor/animastor/issues" },
  "homepage": "https://animastor.in",
  "license": "MIT",
  "type": "module"
}
```

Key properties:
- **`private`:** field removed → defaults to `false` → publishable
- **`license`:** `MIT` — matches repo LICENSE
- **`version`:** `2.1.0`
- **`dependencies`:** none (zero-dep)
- **`engines.node`:** `>=18`

---

## 3. Tarball Contents

`npm pack --dry-run` and real `npm pack` — 7 files, 17.5 kB packed, 57.0 kB unpacked:

| File | Size |
|---|---|
| `.env.example` | 1.9 kB |
| `job-protocol-v2.cjs` | 11.5 kB |
| `package.json` | 1.1 kB |
| `worker-cleanup-journal.cjs` | 8.9 kB |
| `worker-cleanup.cjs` | 2.4 kB |
| `worker-env.cjs` | 1.7 kB |
| `worker.cjs` | 29.5 kB |

**Excluded:** `package-lock.json`, tests, tools, docs, `.git`, monorepo artifacts.
No hidden files, no absolute paths, no debug fixtures.

---

## 4. Security Audit

| Check | Result |
|---|---|
| Credentials/tokens in source | NONE (env vars only) |
| `.env` in tarball | NO (only `.env.example`) |
| Developer absolute paths | NONE |
| Internal URLs | `https://animastor.in/gpu` (public service default) |
| `127.0.0.1` references | ONLY `comfyUrl()` — localhost ComfyUI, expected |
| Debug artifacts | NONE |
| Test fixtures | NONE |
| Package scripts | `start`, `test`, `sync:protocol`, `check:protocol` — safe |
| `ANIMASTOR_WORKER_TOKEN` | Runtime env var, never hardcoded |
| External requires | NONE (only node builtins + `./`-relative) |

---

## 5. License

| Source | License |
|---|---|
| Repo `LICENSE` | MIT |
| `package.json` `license` | **MIT** ✓ |

---

## 6. README

`worker/README.md` now covers:
- ✅ Installation (`cp .env.example .env`, `node worker.cjs`)
- ✅ **npm install** (`npm install animastor-worker`)
- ✅ Runtime requirements (Node ≥ 18, ComfyUI, token)
- ✅ Standalone use instructions
- ✅ Job Protocol v2 explanation
- ✅ Test instructions
- ✅ Delivery channels (4 documented)
- ✅ Architecture invariants
- ✅ **License section** (MIT)

---

## 7. Standalone Verification

1. `npm pack` → `animastor-worker-2.1.0.tgz` (17.5 kB)
2. Extracted to `/tmp/animastor-npm-standalone/` (outside repo)
3. `node worker.cjs` → **exit 1** (no credentials) — expected fail-closed behavior
4. No monorepo requires, no crash, clean error messages
5. All `require()` calls resolve to `./`-relative files or node builtins only

**PASS** — tarball runs standalone without the monorepo.

---

## 8. Protocol Integrity

- `node worker/tools/sync-protocol.cjs --check` → **exit 0** ("in sync")
- Generated copy `worker/job-protocol-v2.cjs` byte-matches canonical source
- `PROTOCOL_VERSION = 2` in both canonical and generated copy
- No protocol changes in this audit

---

## 9. Deployment Compatibility

All 4 channels remain intact:

| Channel | Status |
|---|---|
| Hub volume mounts (`docker-compose.yml`) | PASS |
| Install manifests ×3 | PASS |
| Installer repo fallback | PASS |
| Deprecated `/worker-source` | PASS |

---

## 10. Test Results

| Suite | Result |
|---|---|
| Worker package (`worker/tests/run-all.cjs`) | **45/45 PASS** |
| Protocol parity (`sync-protocol --check`) | **PASS** |
| Syntax smoke (`node --check` ×5) | **OK** |
| Standalone boot smoke | **PASS** |

---

## 11. Guard Updates

Two test guards explicitly asserted `private: true` as an architectural invariant. Updated to reflect the new public release policy:

| Guard | File | Old assertion | New assertion |
|---|---|---|---|
| D1 | `phase9d-worker-package.test.js:67` | `pkg.private === true` | `pkg.private !== true` |
| package | `package.test.cjs:38` | `pkg.private === true` | `pkg.private !== true` |

No other guards depend on `private: true`. No new guards needed — the existing test matrix covers all other invariants.

---

## 12. Blockers

**None.** All previous blockers resolved:

| # | Blocker | Resolution |
|---|---|---|
| B1 | `private: true` prevents `npm publish` | **RESOLVED** — field removed |
| B2 | `license: "ISC"` mismatches repo MIT | **RESOLVED** — changed to `"MIT"` |

---

## 13. Confirmation

- **`npm publish` was NOT executed.**
- **No npm tokens were created.**
- **No runtime behavior was changed.**
- **Protocol v2 untouched.**
- **Deployment paths untouched.**

---

## 14. Next Step (Manual `npm publish`)

```sh
cd worker/worker

# 1. Verify pack
npm pack --dry-run

# 2. Create tarball
npm pack

# 3. Test install from tarball
mkdir /tmp/test-install && cd /tmp/test-install
npm init -y
npm install /path/to/animastor-worker-2.1.0.tgz
node -e "console.log(require('animastor-worker/package.json').version)"
# → 2.1.0

# 4. Publish (when ready — requires npm auth)
npm login
npm publish
```

**Note:** The package name `animastor-worker` must be available on the npm registry. If taken, consider `@animastor/worker` scope.
