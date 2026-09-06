# PHASE 9E — NPM Public Release Audit

**Status:** PASS WITH PREPARATION
**Date:** 2026-09-06
**Package:** `animastor-worker@2.1.0`
**Baseline commit:** `78774a3af4e08be6268704e313dd3293f01e9f01`
**Scope:** npm public-release readiness of `worker/worker/package.json`

---

## Verdict

| Question | Answer |
|---|---|
| Package metadata ready for public npm? | **YES (with 2 metadata changes)** |
| Tarball clean of secrets/stray files? | **YES** |
| Security audit passed? | **YES** |
| License matches repo? | **NO — ISC vs MIT (fixable)** |
| README complete? | **YES** |
| Standalone from tarball? | **YES** |
| Protocol v2 intact? | **YES** |
| Deployment channels intact? | **YES** |
| Tests pass? | **YES (45/45)** |
| Public ready? | **YES (after metadata changes)** |

---

## 1. Package Metadata

| Field | Current | Required for Public npm |
|---|---|---|
| `name` | `animastor-worker` | OK |
| `version` | `2.1.0` | OK |
| `private` | `true` | **BLOCKER** — must be `false` or removed |
| `main` | `worker.cjs` | OK |
| `files` | 6 runtime files + `.env.example` | OK |
| `engines.node` | `>=18` | OK |
| `license` | `ISC` | **MUST match repo: MIT** |
| `type` | `module` | OK |
| `scripts.start` | `node worker.cjs` | OK |
| `scripts.test` | `node ../tests/run-all.cjs` | OK (tests not shipped) |
| `dependencies` | none | OK (zero-dep) |
| `devDependencies` | none | OK |
| `optionalDependencies` | none | OK |

### Changes required

1. **Remove or set `"private": false`** — currently prevents `npm publish`.
2. **Change `"license": "ISC"` → `"license": "MIT"`** — repo LICENSE is MIT.
3. **(Recommended)** Add `repository`, `bugs`, `homepage` fields for npm discoverability.

---

## 2. Tarball Contents

`npm pack --dry-run` and real `npm pack` — 7 files, 17.5 kB unpacked:

```
.env.example           1.9 kB   config template (no secrets)
job-protocol-v2.cjs   11.5 kB   generated protocol copy
package.json           847 B    manifest
worker-cleanup-journal.cjs  8.9 kB   crash-safe journal
worker-cleanup.cjs     2.4 kB   artifact cleanup
worker-env.cjs         1.7 kB   .env loader
worker.cjs            29.5 kB   entrypoint
```

**Excluded:** `package-lock.json`, tests, tools, docs, `.git`, monorepo artifacts.
No hidden files, no absolute paths, no debug fixtures.

---

## 3. Security Audit

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

---

## 4. License

| Source | License |
|---|---|
| Repo `LICENSE` | MIT |
| `package.json` `license` | **ISC** (mismatch) |

**Decision:** Change `license: "ISC"` → `license: "MIT"` in `package.json` to match the repo LICENSE. This is the minimal change needed for npm compliance.

---

## 5. README

`worker/README.md` covers:
- ✅ Installation (`cp .env.example .env`, `node worker.cjs`)
- ✅ Runtime requirements (Node ≥ 18, ComfyUI, token)
- ✅ Standalone use instructions
- ✅ Job Protocol v2 explanation
- ✅ Test instructions
- ✅ Delivery channels (4 documented)
- ✅ Architecture invariants
- ❌ No mention of npm install (`npm install animastor-worker`) — should add
- ❌ No LICENSE section — should add

---

## 6. Standalone Verification

1. `npm pack` → `animastor-worker-2.1.0.tgz`
2. Extracted to `/tmp/animastor-worker-smoke/` (outside repo)
3. `node worker.cjs` → **exit 1** (no credentials) — expected fail-closed behavior
4. No monorepo requires, no crash, clean error messages
5. All `require()` calls resolve to `./`-relative files or node builtins only

**PASS** — tarball runs standalone without the monorepo.

---

## 7. Protocol Integrity

- `node worker/tools/sync-protocol.cjs --check` → **exit 0** ("in sync")
- Generated copy `worker/job-protocol-v2.cjs` byte-matches canonical source
- `PROTOCOL_VERSION = 2` in both canonical and generated copy
- No protocol changes in this audit

---

## 8. Deployment Compatibility

All 4 channels remain intact:

| Channel | Status |
|---|---|
| Hub volume mounts (`docker-compose.yml`) | PASS |
| Install manifests ×3 | PASS |
| Installer repo fallback | PASS |
| Deprecated `/worker-source` | PASS |

---

## 9. Test Results

| Suite | Result |
|---|---|
| Worker package (`worker/tests/run-all.cjs`) | **45/45 PASS** |
| Protocol parity (`sync-protocol --check`) | **PASS** |
| Syntax smoke (`node --check` ×5) | **OK** |
| Standalone boot smoke | **PASS** |

---

## 10. Blockers

| # | Blocker | Severity | Fix |
|---|---|---|---|
| B1 | `private: true` prevents `npm publish` | **HIGH** | Set `"private": false` |
| B2 | `license: "ISC"` mismatches repo MIT | **MEDIUM** | Change to `"license": "MIT"` |

---

## 11. Recommended Changes

### `worker/worker/package.json`

```diff
-  "private": true,
+  "private": false,
...
-  "license": "ISC",
+  "license": "MIT",
```

Optional (recommended for npm discoverability):
```diff
+  "repository": {
+    "type": "git",
+    "url": "https://github.com/animastor/animastor.git",
+    "directory": "worker/worker"
+  },
+  "bugs": {
+    "url": "https://github.com/animastor/animastor/issues"
+  },
+  "homepage": "https://animastor.in",
```

---

## 12. Next Step (Manual `npm publish`)

After applying the metadata changes:

```sh
cd worker/worker

# 1. Verify pack
npm pack --dry-run

# 2. Create tarball
npm pack

# 3. Test install from tarball
mkdir /tmp/test-install && cd /tmp/test-install
npm init -y
npm install ../../../path/to/animastor-worker-2.1.0.tgz
node -e "console.log(require('animastor-worker/package.json').version)"

# 4. Publish (when ready)
npm publish
```

**Note:** `npm publish` requires npm authentication (`npm login`). The package name `animastor-worker` must be available on the npm registry. If taken, consider `@animastor/worker` scope.
