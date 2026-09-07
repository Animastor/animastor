# ComfyUI Workflow Connector — Extraction Readiness

**Status:** EXTRACTED. The narrow core is physically extracted as the
`animastor-comfyui-workflow-connector` package (`packages/animastor-comfyui-workflow-connector`);
host consumers switched to the package specifier; old `backend/src/workflows/*` core files deleted.
**Date:** 2026-09-07 (extraction commit follows the preparation commit `9322ce7`)
**Candidate:** `animastor-comfyui-workflow-connector` (now a real package — `packages/`)
**Basis:** `COMFYUI_WORKFLOW_CONNECTOR_RECONNAISSANCE.md` (2026-09-06, read-only recon) + this preparation phase.
**Verdict:** the module was **READY for physical extraction** without behavior change — see §9; extraction is now DONE (§12).

---

## 1. Frozen extraction boundary

### 1.1 IN (first extraction — the "narrow core")

| Component | Current location | LOC | Notes |
|---|---|---|---|
| workflow-loader | `packages/animastor-comfyui-workflow-connector/src/workflow-loader.js` (was `backend/src/workflows/workflow-loader.js`) | ~120 | load/list/hash workflows; fail-closed semantics; `configure()` DI added |
| connector-loader | `packages/animastor-comfyui-workflow-connector/src/connector-loader.js` (was `backend/src/workflows/connector-loader.js`) | ~950 | connector registry, validation, compatibility, binding application, hash; `configure()` DI + `validateConnector` export added |
| entity-schema | `packages/animastor-comfyui-workflow-connector/src/entity-schema.js` (was `backend/src/workflows/entity-schema.js`) | 340 | entity catalog (public vocabulary), pure data |
| public API facade | `packages/animastor-comfyui-workflow-connector/src/index.js` (was `backend/src/workflows/connector-api.js`) | ~250 | the package entry point; factory + typed errors + compat re-exports |
| workflow JSON assets | `backend/ai/workflows/*.json` (7 active; `old_*` ignored by loader) | — | module data; OR host-injected dirs |
| connector JSON assets | `backend/ai/connectors/conn-*.json` (7) | — | module data; OR host-injected dirs |
| workflow hashing | `computeWorkflowHash` + `stableStringify` (connector-loader) | — | content-sensitive, fully key-sorted; fixed in this phase (§8) |
| compatibility checking | `checkCompatibility` (connector-loader) | — | hash + nodeClass + per-binding expectedClass + guideNodes |
| binding/application logic | `applyBinding` / `setValue` / `getBinding` / `getBinding` multi-fanout | — | node ids never cross the API boundary |

### 1.2 OUT (stays host-side; explicitly excluded)

- `backend/src/runtime/gpu-dispatcher.js` — routing policy, PG repos, retries (PW-2/SH-2 lanes).
- Job Protocol / queues — already `@animastor/contracts` (Job Protocol v2).
- GPU Hub routing + `gpu-hub/` — separate extracted package.
- Business generation builders: `audio/generation.js`, `image/iu-processor.js`, `workflows/video/video-workflows.js`, `orchestration/scene-orchestrator.js` — stay in the Animastor generation domain.
- `services/workflow-manager.js` — host consumer (admin/API orchestration), NOT module internals.
- `services/profile-override.js` — host consumer (reads connector profiles; read-port migration is a follow-up, §7).
- Result ingestion / task-handler / Redis reconciliation — host business logic.
- `services/provider-gateway.js`, `generation/comfyui-provider.js` — host seams; comfyui-provider becomes a thin adapter over the package (migration step 3, §6).
- Worker transport (`worker/worker/worker.cjs`) — already physically separate.
- Installer / compatibility-resolver — separate ComfyUI-environment concern.

### 1.3 Dependency direction (post-extraction)

```
backend business layer ──requires──▶ animastor-comfyui-workflow-connector ──▶ fs/path/crypto ONLY
        (host)                        workflowsDir/connectorsDir injected      (zero host deps,
                                       by the host at boot                     zero network)
```

---

## 2. Public API (designed and implemented as `connector-api.js`)

```js
const { createWorkflowConnector } = require('animastor-comfyui-workflow-connector');

const wf = createWorkflowConnector({
    workflowsDir: '/host/ai/workflows',     // injected (host-owned); env WF_DIR fallback pre-extraction
    connectorsDir: '/host/ai/connectors',   // injected; env CONNECTOR_DIR fallback pre-extraction
    logger,                                  // injected (defaults console)
});

wf.listWorkflows()  // → [{ name, hash, hasConnector, type, label, compatible }]   (no node ids)
wf.getWorkflow(n)   // → deep-cloned workflow JSON; throws WorkflowNotFoundError
wf.getConnector(n)  // → entity-level VIEW { inputs, outputs, parameters, profile, … }
                    //   nodeId/field/expectedClass STRIPPED; throws ConnectorMissingError
wf.validate(n)      // → { compatible, warnings }; throws WorkflowNotFound/ConnectorMissing
wf.build({ workflow, inputs, parameters })
                    // → { workflowJson, workflowHash }; connector defaults applied;
                    //   unknown entity keys → BuildError; incompatible → IncompatibleWorkflowError
```

Typed errors: `WorkflowNotFoundError` (`WORKFLOW_NOT_FOUND`), `ConnectorMissingError` (`CONNECTOR_MISSING`), `IncompatibleWorkflowError` (`INCOMPATIBLE_WORKFLOW`), `BuildError` (`BUILD_FAILED`), base `ConnectorApiError`.

**Hidden inside the module** (never in the external API): ComfyUI node ids, field paths, `class_type`, `Save*` node names, connector JSON raw format, file naming conventions. Guard: `CB-T2` in `tests/architecture/comfyui-connector-core-boundary.test.js` + `tests/workflows/connector-core.test.js` T7.

**DI adapters added this phase (minimal, behavior-preserving):**
- `workflow-loader.configure({ workflowsDir, logger })`, `getWorkflowsDir()`
- `connector-loader.configure({ connectorsDir, logger })`
- Resolution order everywhere: explicit injection → env (`WF_DIR` / `CONNECTOR_DIR`) → host default. Defaults remain pre-extraction; after extraction the host passes dirs explicitly.

---

## 3. Inputs / outputs

**Inputs:** workflow JSON files (ComfyUI API format, `{ "nodeId": { class_type, inputs } }`), connector JSON files (`conn-*.json`, de-facto schema documented in `docs/06-workflows/CONNECTORS.md`), entity keys (the public vocabulary from `entity-schema.js`).

**Outputs:** loaded workflow JSON clones, entity-level connector views, compatibility verdicts, sha256 workflow hashes, fully-built workflow JSON (`build()` — the only module output that contains node ids, and only in the payload the host itself dispatches).

---

## 4. Dependencies of the core (measured, guard-enforced)

- Runtime: `fs`, `path`, `crypto` — nothing else. Zero DB, zero Redis, zero HTTP, zero business imports.
- Internal edges: `workflow-loader → connector-loader → entity-schema`; `connector-api → workflow-loader + connector-loader`. No cycles.
- Guard: `CB-T1` freezes this set; adding any host import fails CI.

---

## 5. Coupling points audited this phase

| Coupling point | Status | Action |
|---|---|---|
| `WF_DIR` / `CONNECTOR_DIR` env, module-load-time constants | **resolved** | `configure()` DI; env + defaults preserved |
| `console.*` hardcoded logging | **resolved** | injectable logger |
| `validateConnector` not exported (workflow-manager validate/add paths would throw) | **resolved** | exported (latent bug fix) |
| `loadWorkflows()` additive across dirs (phantom entries after dir switch) | **resolved** | fresh-load semantics (clears registry first) |
| Content-blind hash (`JSON.stringify` replacer drops node contents) | **resolved** | `stableStringify` recursive key-sort; all runtime hashes change value, none persisted (connectors ship `workflowHash: ""`, auto-populated at boot) — no behavioral impact |
| Hardcoded node-id fallbacks in `audio/generation.js:492,521-524,543-546` (`wfAudio["108"]`, `["71"]`, `["80"]`, `["74"]`) | **OPEN — extraction blocker B1** | fixing requires business-logic change (make connectors truly mandatory + voice-payload rework). NOT touched per task instruction. Pinned in place by `phase3-provider-gateway.test.js` T6 |
| `comfyui-provider → gpu-dispatcher` direct require | OPEN — pre-existing, intentional (P7-T8 baseline) | dispatcher injection happens with the provider-seam migration (§6 step 3), not in the narrow core |
| Connector-as-config-store (`profile-override` reads, `workflow-manager` mutates) | OPEN — host two-way coupling | read-port/mutation-ownership decision is a follow-up (§7); does NOT block the narrow-core extraction because the host keeps requiring the package the same way |
| Startup fail-closed at `backend.cjs:366` | kept | host keeps calling `loadWorkflows()` (package re-export); semantics unchanged |

---

## 6. Migration order (physical extraction — EXECUTED, see §12 for the actual record)

1. **Create package** `packages/animastor-comfyui-workflow-connector` (repo-root `node_modules` symlink pattern, same as `@animastor/contracts`; mind the docker build-context caveat documented in `backend/src/runtime/job-schema.js`).
   Move: `workflow-loader.js`, `connector-loader.js`, `entity-schema.js`, `connector-api.js` (→ `index.js`), fixtures + `tests/workflows/connector-core.test.js` (import paths + fixture dir only).
   Expose: `createWorkflowConnector`, all loader functions re-exported (compat surface), typed errors.
2. **Switch host imports** — the exact 9-file consumer baseline frozen by `CB-T1`:
   `backend.cjs`, `generation/comfyui-provider.js`, `audio/generation.js`, `audio/connector-utils.js`, `image/iu-processor.js`, `image/connector-utils.js`, `orchestration/scene-orchestrator.js`, `services/workflow-manager.js`, `services/profile-override.js` — replace `require('../workflows/…')` with the package specifier. No logic changes.
3. **Assets:** either move `backend/ai/{workflows,connectors}` into the package with host dirs injected as the compatibility default, or keep assets host-side and inject dirs (recommended first step — zero asset-path risk).
4. **Update guards** (only then): `CB-T1` consumer baseline → package specifier set; `phase3-provider-gateway.test.js:36,263` (workflowLoaderPath pin + seam require assertion) → package require; `phase7-extraction-readiness.test.js:307` bypass baseline entry stays (comfyui-provider still requires gpu-dispatcher host-side).
5. **Delete** `backend/src/workflows/{workflow-loader,connector-loader,entity-schema,connector-api}.js` shims.

**Deliberately NOT in the migration:** gpu-dispatcher injection into comfyui-provider, node-id fallback removal (B1), profile-override read port, workflow-manager ownership split — these are behavior-affecting and belong to later phases.

## 7. Follow-ups (post-extraction, each independently shippable)

1. **B1:** remove hardcoded node-id fallbacks in `audio/generation.js` (connectors mandatory; fallback paths become errors).
2. **profile-override read port:** host passes profile data in; module stops being a settings store.
3. **workflow-manager mutation ownership:** decide `addConnector`/`updateConnectorParameter`/`updateConnectorBinding` fate (module CRUD API vs host-side file management).
4. **C12 media-generation provider contract** (`MODULAR_PRODUCT_ARCHITECTURE.md:874`, Phase 12) — the module becomes replaceable only after C12 exists.
5. Optional transport half (`execute()`): direct ComfyUI client (/prompt, /history, /view, /system_stats) — currently lives in the worker; out of scope here.

## 8. Behavioral changes made in this preparation phase (all verified safe)

| Change | Why it is safe |
|---|---|
| `computeWorkflowHash` now hashes full content (was: top-level keys only) | hashes are runtime-ephemeral: connectors ship `workflowHash: ""`, values auto-populate at boot from the same (fixed) function, so checks remain self-consistent; nothing persisted, no cross-boot comparison exists |
| `validateConnector` exported | fixes a latent crash path in workflow-manager validate/add; no caller semantics change |
| `loadWorkflows()` clears registry before loading | single-dir behavior identical; multi-dir re-load no longer accumulates phantoms |
| `configure()` DI on both loaders | no-op unless called; defaults/env preserved; host startup unchanged |
| `connector-api.js` added | purely additive; no existing caller uses it yet |

## 9. Readiness verdict

**READY — and EXTRACTED (§12).** The narrow core (trio + API + hash/compat/binding) was physically extracted as `animastor-comfyui-workflow-connector` with **zero system behavior change**:

- core has zero host dependencies (CB-T1 enforced);
- all 9 host consumers are enumerated and frozen (CB-T1 baseline = migration list §6.2);
- dirs/logger are injectable; env + defaults keep host boot identical;
- the package-owned test suite (34 tests) proves the core works with no DB/Redis/GPU Hub;
- guard updates required after extraction are enumerated (§6.4), none block the move.

**Blockers for the FULL module vision (not for this extraction):** B1 node-id fallbacks, profile-override port, dispatcher injection, C12 contract — all deferred by design.

## 10. Test plan

| Suite | What it proves | Status |
|---|---|---|
| `packages/animastor-comfyui-workflow-connector/tests/connector-core.test.js` (34) | loading (injected dirs), connector loading, malformed connector, missing connector fail-closed, entity schema, hash determinism/content-sensitivity, compatibility (pass/missing-node/class-drift), binding application (incl. multi-binding), public API (list/get/getConnector/validate/build, typed errors, node-id hiding, determinism), core purity | ✅ 34/34 |
| `backend/tests/architecture/comfyui-connector-core-boundary.test.js` (4) | CB-T1 package purity + consumer freeze (incl. stale-import detector); CB-T2 API surface hides ComfyUI internals | ✅ 4/4 |
| Full backend suite (`npm test`) | no regression anywhere; host suites (audio-profile, profile-override, image-ghost) keep passing against the package | ✅ 323/323 |
| Architecture suite (`npm run test:arch`) | all pre-existing guards intact (323 incl. the 4 boundary tests) | ✅ 323/323 |

Post-extraction acceptance (§12): suites above pass **unchanged in semantics** (import paths only) + `npm run test:connector-core` inside the new package + full backend `npm test` green.

## 12. Extraction record (physical move — DONE)

Commit after `9322ce7` ("ComfyUI Workflow Connector: extraction preparation phase"):

1. **Package created:** `packages/animastor-comfyui-workflow-connector`
   — `package.json` (main `src/index.js`, dev deps mocha/chai for the package-owned suite),
   `README.md`, `LICENSE` (copied from repo root), `src/{workflow-loader,connector-loader,entity-schema,index}.js`
   (git-mv), `tests/connector-core.test.js` + `tests/fixtures/{workflows,connectors}/` (git-mv).
   Package resolution mirrors `@animastor/contracts`: repo-root/host `node_modules` symlink
   + read-only docker-compose mount into the backend container
   (`./packages/animastor-comfyui-workflow-connector:/app/node_modules/animastor-comfyui-workflow-connector:ro`).
   Package dev-deps resolve via `backend/node_modules` symlinks (no duplicate tree).
2. **Compat surface in `src/index.js`:** `createWorkflowConnector` + typed errors + `workflowLoader`,
   `connectorLoader`, `entitySchema` re-exports so every migrated consumer keeps its exact call shape.
3. **Host switch (§6.2 list + 1 internal edge):** all 9 frozen consumers now require the package
   specifier (`require('animastor-comfyui-workflow-connector').workflowLoader / .connectorLoader / .entitySchema`).
   The host-side business file `backend/src/workflows/video/video-workflows.js` (NOT part of the package)
   was switched to the package too, as was `tests/orchestration-stabilization.test.js` (module-cache stub)
   and the host suites `audio-profile` / `profile-override` / `image-ghost-no-jobs-sent` (loader require + host-dir injection in `before()`).
4. **Host boot injects dirs:** `backend.cjs startServer()` calls
   `wfLoader.configure({ workflowsDir, connectorsDir })` with `<backend>/ai/{workflows,connectors}` —
   the package itself now has NO host default dir (resolution: injection → env `WF_DIR`/`CONNECTOR_DIR` → none).
   `backend/package.json` `test:connector-core` now delegates to the package suite.
5. **Old files deleted:** `backend/src/workflows/{workflow-loader,connector-loader,entity-schema,connector-api}.js`
   and `backend/tests/workflows/` (suite + fixtures moved). Only the host business file
   `backend/src/workflows/video/video-workflows.js` remains under that path (explicitly out of scope, §1.2).
6. **Guards updated:** `comfyui-connector-core-boundary.test.js` now points CB-T1 at the package source,
   flags STALE `backend/src/workflows/*` core imports, and freezes the package-specifier consumer
   baseline (9 host consumers + video-workflows); `phase3-provider-gateway.test.js` loader pin +
   seam require assertion switched to the package.
7. **Assets stayed host-side (§6.3 option B):** `backend/ai/{workflows,connectors}` untouched;
   dirs injected at boot; fixtures for package tests live inside the package.
8. **Verification (all green):** package suite 34/34; architecture suite 323/323; full backend suite
   323/323; zero stale `backend/src/workflows/*` core imports in production code; clean standalone
   package import from the backend (no host state needed); all 7 existing connector/workflow JSON
   pairs validate COMPATIBLE through the package; hash (content-sensitive, key-order-stable),
   `validateConnector` export, fresh-load (no phantoms), DI and typed errors re-verified against
   the §8 preparation-phase fixes — no regression.

## 11. Rollback strategy

- Physical extraction is a pure move + import swap; rollback = `git revert` of the extraction commit (files return, imports restore, guards restore). No data migration, no protocol change, no persisted state involved (hashes are ephemeral, §8).
- Shims were NOT kept (single-commit move + switch); rollback is the revert itself.
- Rollback trigger: any failure in the §10 post-extraction acceptance, or any behavior diff observed in the host suites.

---

*Preparation phase: production behavior preserved (verified by full suite); only the changes enumerated in §8 were made, each minimal and reversible.*
