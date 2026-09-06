# PHASE 10G — GPU Hub Registry Dependency Migration

**Status: PASS**
**HEAD:** `dc5cb894` → current
**Predecessors:** 10F (contracts publish) → 10G (registry migration)
**Principle:** *Migrate GPU Hub from monorepo `file:../contracts` to published npm registry dependency.*

---

## 1. Dependency migration

### Before

```json
"optionalDependencies": {
  "@animastor/contracts": "file:../contracts"
}
```

### After

```json
"dependencies": {
  "@animastor/contracts": "^0.1.0",
  "cors": "^2.8.5",
  "express": "^4.19.2",
  "ioredis": "^5.10.0"
}
```

**Key change:** `@animastor/contracts` moved from optional to regular dependency with npm registry specifier.

---

## 2. package-lock.json

Regenerated via `npm install`. Registry resolution confirmed:

```
"node_modules/@animastor/contracts": {
  "version": "0.1.0",
  "resolved": "https://registry.npmjs.org/@animastor/contracts/-/contracts-0.1.0.tgz",
  "integrity": "sha512-..."
}
```

No `file:../contracts` references remain.

---

## 3. Docker mount cleanup

### gpu-hub service

**REMOVED:** `./contracts:/app/node_modules/@animastor/contracts:ro`

Rationale: GPU Hub now resolves `@animastor/contracts` from npm registry via its `dependencies`. The bind mount is no longer needed.

### backend service

**PRESERVED:** `./contracts:/app/node_modules/@animastor/contracts:ro`

Rationale: Backend has no npm dependency on contracts (Docker build context constraint). The bind mount remains the resolution seam for backend.

---

## 4. Standalone install verification

### Test environment

```
/tmp/gpu-hub-consumer-test/
├── node_modules/@animastor/contracts/  (from npm registry)
├── node_modules/@animastor/gpu-hub/    (from local tarball)
├── package.json
└── package-lock.json
```

### Results

| Check | Result |
|---|---|
| `npm pack` GPU Hub | ✅ PASS (9 files, 118 kB) |
| `npm install` tarball in clean dir | ✅ PASS (81 packages) |
| `@animastor/contracts` resolved from registry | ✅ PASS (0.1.0 from registry.npmjs.org) |
| No monorepo fallback in node_modules | ✅ PASS |
| Protocol parity (hub ↔ contracts) | ✅ PASS |

---

## 5. Test results

| Suite | Result |
|---|---|
| GPU Hub package tests | **19/19 PASS** |
| Contracts tests | **37/37 PASS** |
| Worker tests | **45/45 PASS** |
| Protocol parity | **PASS** |
| Worker sync-protocol --check | **PASS** |
| Syntax smoke (gpu-hub + contracts) | **PASS** |

---

## 6. Post-migration invariants

| Check | Result |
|---|---|
| Job Protocol v2 still from `@animastor/contracts` | ✅ PASS |
| API/14 routes unchanged | ✅ PASS |
| Redis contract unchanged | ✅ PASS |
| Auth unchanged | ✅ PASS |
| Worker contract unchanged | ✅ PASS |
| No protocol copies/refactors | ✅ PASS |

---

## 7. Docker mount summary

| Service | Contracts mount | Status |
|---|---|---|
| backend | `./contracts:/app/node_modules/@animastor/contracts:ro` | **PRESERVED** (backend has no npm dep on contracts) |
| gpu-hub | ~~`./contracts:/app/node_modules/@animastor/contracts:ro`~~ | **REMOVED** (registry dependency resolves) |
| nginx | N/A | N/A |
| postgres | N/A | N/A |
| redis | N/A | N/A |

---

## 8. Files changed

| File | Change |
|---|---|
| `gpu-hub/package.json` | `optionalDependencies` → `dependencies` with `"@animastor/contracts": "^0.1.0"` |
| `gpu-hub/package-lock.json` | Regenerated from npm registry |
| `gpu-hub/tests/run-all.cjs` | Updated dependency set check and contracts resolution check |
| `docker-compose.yml` | Removed contracts bind mount from gpu-hub service |

---

## 9. Verdict

**PHASE 10G: PASS**

Blocker B1 (Phase 10E) is now closed. GPU Hub is fully registry-resolved and ready for independent publish after physical extraction.

---

## Commit

```
gpu-hub: Phase 10G — migrate to @animastor/contracts registry dependency
docker: remove contracts bind mount from gpu-hub service
docs(arch): update Phase 10E — blocker B1 closed by Phase 10G
```
