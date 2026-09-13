# Final NPM-Release Audit — `@animastor/orchestration`

**Date:** 2026-09-13 · **Baseline SHA:** `066ddaae7ec6359d74bfee1fe375a652c5391e40` · **Branch:** `c21.4-physically-extract-analysis-from-backend` · **Tree:** clean, HEAD = baseline.

**Scope:** AUDIT ONLY of the physically extracted package (`packages/animastor-orchestration`) ahead of npm release. No production refactor, no API change, no publish, no version bump. All findings below are measured on the exact baseline tree (command output captured during the audit session, 2026-09-13).

**Verdict: BLOCKED** — one release blocker (B-1: published `@animastor/contracts@0.1.0` is stale, missing `runtimeResult`, so a clean install of this package cannot load). Details in §8. Everything else is release-clean.

---

## 1. Package boundary

- Self-sufficient: `package.json` present; `name: @animastor/orchestration`; `version: 0.1.0`; `main: src/index.js`; `exports: { ".": "./src/index.js" }` (root-only); `files: ["src/", "test/", "README.md", "LICENSE"]`; `publishConfig.access: public`; `engines >=18`; MIT `LICENSE` present.
- `src/` = 30 files (20 runtime + 8 port contracts + host seam + 2 barrels incl. root); `test/` = 3 files. No stray dev/test debris in `src/`.
- **Zero** references to `backend/`, `storage`, `book/`, `routes/`, `services`, `express`, PG, or Redis *imports* anywhere in `src/` (Redis/token mentions are parameter names and comments only — no require resolves outside the package or to a forbidden host module).
- **Zero** `file:` dependencies. Deps: `@animastor/contracts ^0.1.0`, `@animastor/generation ^0.1.0`, `music-metadata ^11.12.3` (real, used at `src/orchestration/scene-callbacks.js:112,147`). Dev: mocha, chai.
- `node_modules/` exists on disk (workspace symlinks: `music-metadata` → backend; `chai`; `@animastor/*`) but is **excluded from the tarball** by `files` — verified in §7. No `.env`, no logs, no temp files in the package tree.

## 2. Dependency audit (static + lazy require graph)

- Every require in `src/` enumerated (literal; dynamic/computed require scan = **0**; `import()` = **0**): all relative requires resolve inside the package; externals = `music-metadata` + node builtins (`fs`, `path`, `crypto`); `@animastor/contracts` (2 files: `runtime-result-emitter.js:24`, `scene-orchestrator.js:408`); `@animastor/generation` in 13 files / 17 sites — **root specifier only, 0 deep imports** (no `@animastor/*/<path>` string anywhere in `src/`).
- Package → backend: **0**. Package → storage/book/routes/services/PG/Redis/Express: **0** (all former host legs are reached exclusively through `src/host/host-bindings.js`).
- Intra-package cycles: only the pre-existing, documented lazy pair `orchestrator.js ↔ scene-orchestrator.js` (both directions are inside function bodies, Node handles them; behavior preserved from pre-move). `scripts/o3-scc-audit.cjs` on the baseline tree: `runtime→orchestration 0`, `services→orchestration 0`, `orchestration→book 0`, `orchestration→storage 0`, SCCs>1 = 0 (PASS, verdict lines all green). The former host-side SCC pair no longer appears in the audit scope — no new SCC from the move.

## 3. Public API audit (measured runtime surface)

Root `require('@animastor/orchestration')` returns:
- Facade (21 ops, lazy getters over `orchestration/index.js` facade-wins merge of `scene-orchestrator` + `orchestrator`): `ensureStageDispatchable, dispatchStage, restoreSceneChunkStatus, handleAudioCompleted, handleImageCompleted, handleVideoCompleted, completeStage, failStage, markDirty, markDirtyScene, planScene, beginStage, completeStageWithoutVideo, completeStageWithoutImage, setScenePending, setSceneGenerating, setSceneAllReady, setScenePlaceholder, rollbackStageToPending, reconcile, resetScenes` + `orchestrator` namespace.
- `createRuntimeResultConsumer` (used: `backend.cjs:270-271`), `ports` (8: persistence, sceneData, placeholderAudio, progressEvents, audioFsm, videoFsm, hubCancel, layerConfig — all 8 bound in `backend.cjs:40-121`), binding surface (7 members, used: `bindHostModules` `backend.cjs:154`), `runtime` namespace (11 members: scheduler, activeScenes, reconciliation, dispatch, leaseManager, counterReconciliation, metrics, workerHealth, sceneWindow, failureTaxonomy, runtimeResultEmitter).
- Host consumption measured: facade ops via `orchestrator.*` (completeStage×8, failStage×6, markDirtyScene×3, resetScenes×2, dispatchStage×2, setScenePlaceholder/Pending/AllReady, rollbackStageToPending, ensureStageDispatchable — each has a real consumer; the `orchestrator.test`/`orchestrator.completeChunk` grep hits are comments, not calls) + `runtime.*` via `backend.cjs:190-196` spread and 24 direct `require('@animastor/orchestration').runtime.*` call sites (dispatch×13, sceneWindow×6, workerHealth×3, scheduler, reconciliation, metrics, counterReconciliation, activeScenes) + result-consumer + 8 port setters + bindHostModules.
- **Not consumed by host today:** `runtime.leaseManager` and `runtime.failureTaxonomy` (carried from the old `backend/src/runtime/index.js` barrel for surface parity — legacy-but-harmless; recorded, NOT removed per audit mandate). `ports` are consumed only at the composition root (by design — that is their consumer).
- `exports` map blocks deep imports: verified live — `require('@animastor/orchestration/src/runtime/dispatch-engine')` → `ERR_PACKAGE_PATH_NOT_EXPORTED`. Host uses the root specifier at **39 string sites / 38 require sites** in 9 files (matches §32.30's "38"; the +1 string is a comment line in `backend/src/runtime/runtime-loop.js:8`).

## 4. Host binding audit (`src/host/host-bindings.js`)

- 9 named bindings (`config, state, stateOps, journal, media, genScope, seams, artifactRoot, resolveWorkspaceForBook`); unknown names rejected; resolvers must be zero-arg functions; fail-fast on unwired resolution; call-time (resolver-invocation) semantics preserve the former lazy-require deferral, so host-side `require.cache` test stubs stay visible — verified by the passing host integration suites and the package `test-bindings.js` fixture.
- Every binding has ≥1 package consumer (grep counts): config×5, state×13, stateOps×2, journal×4, media×14, genScope×1 (scene-window, the documented single consumer), seams×4, artifactRoot×2, resolveWorkspaceForBook×1 (scene-window — the §32.29 step-4b closure). No god-interface, no dead binding.
- No bypass: the package contains **0** requires of host modules (§2); the only path to host state is this seam.
- Optional-load semantics preserved: `resolveWorkspaceForBook` is injected host-side in `backend.cjs` as an async wrapper with try/catch → `null` fallback ("system pool availability only"), matching the former scene-window→gpu-dispatcher lazy optional-load behavior. `artifactRoot` is injected as `config.OUTPUT_DIR || '/data/output'` — identical value/fallback to the former in-package `process.env.OUTPUT_DIR` reads (host `runtime-config.js:60` keeps the same expression), so OUTPUT_DIR/artifact-root behavior is unchanged.
- Composition root (`backend/src/backend.cjs`) order verified correct: generation config bind (l.31) → 8 port bindings (ll.40-121, all before any runtime module loads) → generation bootstrap → `require('@animastor/orchestration')` (l.140) → `bindHostModules` (l.154; `config` already required at l.198 for the closure but only *read* at resolver call time) → S-5 seam registration (l.167) → runtime facade spread (ll.190-195) → result consumer (ll.269-271). All consumers (routes/services) load after this; the first orchestration *function* runs post-listen (reconcile `setImmediate`), after wiring. Lazy facade getters fire only on access — no binding resolution at require time (root `index.js` uses `defineProperties`, not spread).

## 5. Physical extraction audit vs §32.29/§32.30

- All 28 MOVE_SET files are in the package: 21 runtime (active-scenes-index, audio-fsm-port, circuit-breaker, counter-reconciliation, dispatch-engine, failure-taxonomy, hub-cancel-port, layer-config-port, lease-manager, persistence-port, placeholder-audio-port, progress-events-port, reconciliation-engine, retry-budget-manager, runtime-metrics, runtime-result-emitter, runtime-scheduler, scene-data-port, scene-window, video-fsm-port, worker-health) + 7 orchestration (index, orchestrator, runtime-result-consumer, scene-orchestrator, scene-callbacks, scene-restoration, scene-utils) — enumerated on disk at `src/runtime/` and `src/orchestration/`.
- Host-stays remain in `backend/src/runtime/`: `gpu-dispatcher.js, runtime-loop.js, index.js, orchestration-seams.js, job-schema.js` (exactly the 5 classified stays; `runtime-persistence.js`/`retention-manager.js` deleted per plan).
- Old physical paths absent: `backend/src/orchestration/` does not exist. Compatibility shims: **none** (grep over both trees finds no re-export shims; PM-G suite pins this).
- No accidental copies of moved files in backend (PM-G2/PN suite green; `git status` clean at baseline).
- Counter-reconciliation tests live at `packages/animastor-orchestration/test/counter-reconciliation.test.js` (+ `test/mocks/redis-mock.js`, `test/test-bindings.js`) — correct package location; nothing left in `backend/tests/`.
- Old architecture guards adapted: PM-G suite (PM-G1..PM-G10) rewritten as the post-move boundary guard and green; O-2..O-10 port guards, S-5, dependency-guardrails, §32 recon guards all pass inside `test:arch` 949/0.

## 6. Runtime / behavior audit

Startup order, port wiring, orchestration/scheduler initialization, reconciliation, scene orchestration, result consumer, Generation integration, audio/image/video completion paths, reset/cancel paths, PW-2 workspace resolution, and OUTPUT_DIR/artifact-root behavior were compared pre-move vs post-move at the composition root:

- The move is `git mv` + specifier re-points + the two planned injections (4a OUTPUT_DIR → `artifactRoot` binding, 4b workspace resolver → injected wrapper). No logic changes in moved files beyond the mechanical re-points and the documented lazy-getter conversion of FSM-writer re-exports (semantics preserved — access-time `stateOps` resolution).
- Evidence: full backend suite green except the documented env-dependent set (§8/§9); §32.30 composition-root smoke (bind chain → package load → bindHostModules → 8 ports → seams → planScene/markDirtyScene on mock Redis) recorded ALL PASS; the lazy-getter design was re-verified by reading `src/index.js`, `src/orchestration/index.js`, `orchestrator.js` exports (getters fire on access, not at require).
- Same caveat as §32.30: full HTTP startup with real Redis/PG was not exercised in this audit session (environment); covered indirectly by the host integration suites that exercise the composition root against mock Redis.

## 7. Release readiness

- `npm pack --dry-run` (baseline tree): **35 files**, 130.2 kB packed / 530.4 kB unpacked — `package.json`, `LICENSE`, 30 `src/**`, 3 `test/**`, `README.md`. **No** `node_modules`, `.env`, logs, `package-lock.json` in the tarball (verified by listing). Note: `README.md` is in `files` but **does not exist on disk** — npm packs it as a missing-file no-op today, but it will break `npm publish` on npm ≥ stricter versions / leaves the registry page empty. Cosmetic blocker noted as B-3 (see §8).
- Clean install probe (tarball → empty project, registry deps): **install succeeds; require CRASHES** — see B-1 in §8. With the workspace-resolved `@animastor/contracts` the require succeeds (root loads, all namespaces present, deep import blocked), so the package itself is installable and self-contained; the failure is a stale published dependency.
- No repository-relative paths inside the package (§2). No unpublished workspace-only deps by specifier (`^0.1.0` semver ranges; both `@animastor` deps exist on the public registry — `@animastor/contracts@0.1.0` content is stale, B-1; `@animastor/generation@0.1.0` is current: its registry tarball lacks `runtime-result` and nothing in it requires it).
- Version `0.1.0` matches the project-wide release policy (all 21 `packages/*` at 0.1.0; no version bumps in this branch).
- `npm publish` NOT executed (mandate).

## 8. Blockers

| # | Severity | Finding | Location | Why it blocks |
|---|---|---|---|---|
| **B-1** | **Blocker** | The **published** `@animastor/contracts@0.1.0` (registry tarball) does not export `runtimeResult`; the workspace copy does (`packages/animastor-contracts/src/index.js:6` → `src/runtime-result.js`). `@animastor/orchestration` depends on `@animastor/contracts ^0.1.0`, which resolves to the stale registry artifact in any clean install. | Dependency path: `@animastor/orchestration` → `src/runtime/runtime-result-emitter.js:24` (`require('@animastor/contracts').runtimeResult`) ← reached at load time from `src/index.js` → `./orchestration` → `orchestrator.js:32` → `dispatch-engine.js:32`. | Reproduced: `npm install <orchestration tarball>` in an empty project then `require('@animastor/orchestration')` → `TypeError: Cannot destructure property 'createRuntimeResult' of 'require(...).runtimeResult' as it is undefined`. A clean npm release of this package would be uninstallable. Fix (out of scope here): republish `@animastor/contracts` with the `runtimeResult` module (or bump its version and raise the orchestration dep floor). |
| B-2 | Non-blocking (post-fix verify) | After republishing contracts, re-run the clean-install probe; until then "installable from registry" is unproven. | — | Sequencing note, not an independent defect. |
| B-3 | Cosmetic / publish hygiene | `README.md` is listed in `files` but absent from the package directory. | `packages/animastor-orchestration/package.json` `files` array | No functional impact today (pack succeeds), but npm will warn and the registry page ships empty; every other extracted package in this repo ships a README. |
| B-4 | Latent (host-side, pre-existing) | `backend/src/runtime/index.js` still lazy-requires moved local paths (`./runtime-scheduler`, `./dispatch-engine`, `./lease-manager`, `./counter-reconciliation`, `./metrics`, `./worker-health`, `./scene-window`, `./active-scenes-index`, `./reconciliation-engine`, `./failure-taxonomy` — lines ~48-73) that no longer exist there. **Zero consumers** of the barrel were found in `backend/src` and `backend/tests` (composition root builds its own `runtime` object from the package), so nothing breaks today — but any future `require('../runtime')` throws MODULE_NOT_FOUND. §32.30 says the facade "re-points into the package"; it actually re-points only in `backend.cjs`, not in the barrel file. | `backend/src/runtime/index.js` | Recorded, not fixed (audit-only). Recommend deleting or re-pointing the barrel in a follow-up host-side commit. |

## 9. Tests (executed on the baseline tree, this session)

| Suite | Result | vs baseline |
|---|---|---|
| `@animastor/orchestration` package tests | **13 passing / 0 failing** | = §32.30 (13/0) |
| `@animastor/generation` package tests | **11 passing / 0 failing** | = §32.30 (11/0) |
| `backend` `test:arch` (incl. PM-G1..PM-G10, O-2..O-10 guards) | **949 passing / 0 failing** | = §32.30 (949/0) |
| `backend` full suite (`tests/**/*.test.js`, explicit glob) | **3382 passing / 13 failing** | = §32.30 exactly; the 13 are the documented environment-dependent set (LLM Sharing ×2, PW-4 ×4, private-worker/share ×7 — network/infra-class, green in isolation). **No regression vs baseline.** |
| Deep-import guard (live probe) | `ERR_PACKAGE_PATH_NOT_EXPORTED` | exports map effective |
| SCC/graph guard (`scripts/o3-scc-audit.cjs`) | PASS (runtime→orch 0, orchestration→book/storage 0, no new SCC) | consistent |

Notes: the package's own `npm test` fails with `mocha: not found` on this machine because the package has no local mocha install (workspace `node_modules` symlinks mocha's deps but not the bin into the package; run via `backend/node_modules/.bin/mocha` or after a package-local `npm i`). Environment note, not a code defect — but a fresh `npm i` inside the package before publishing would make `npm test` self-contained (recommended pre-publish step, out of scope here). The backend `npm test` script glob (`tests/**/*.test.js` unquoted) only reaches `tests/architecture/` under this shell; the true full-suite numbers above come from an explicit quoted glob — same class as the documented baseline runs.

## 10. Documentation audit (§32.29 / §32.30)

Corroborated: 28-file MOVE_SET ✓; host-stays list ✓ (5 files); deleted dead files ✓; no shims ✓; host-bindings 9 names + semantics ✓; both §32.29 exceptions closed (PW-2 resolver, OUTPUT_DIR) ✓; package→host 0 ✓; Generation root-only ✓; exports map blocks deep imports ✓; graph table (0 package→host, no new SCC) ✓; music-metadata declared dep ✓ (found-during-move story accurate); test numbers 13/11/949/3382+13 ✓ (reproduced exactly); PM-G1..G10 layout ✓.

Discrepancies (recorded, not corrected):
1. §32.30 "Baseline: `37362f22`" — the extraction commit `066ddaae`'s parent is `7ddf670d` ("fix(web-local-ai): finalize npm dependency release metadata"), not `37362f22` ("complete physical move gate", which is further back). The stated baseline SHA is wrong/stale; branch name is right.
2. §32.30 §"Public API" lists the `runtime` namespace as 7 members (`scheduler, reconciliation, dispatch, metrics, counterReconciliation, workerHealth, sceneWindow`); the actual root `runtime` namespace exposes **11** (adds `activeScenes, leaseManager, failureTaxonomy, runtimeResultEmitter`). `activeScenes` and `runtimeResultEmitter` are consumed by the host (backend.cjs:196/269), so the frozen-surface claim is understated; `leaseManager`/`failureTaxonomy` are unconsumed legacy members. PM-G3 in the guard suite pins the true superset, so the guard is right and the doc is imprecise.
3. §32.30 "38 host require sites" — correct as require sites (39 raw string occurrences incl. one comment). No change needed; noted for exactness.
4. §32.29 "31-target host-stays allowlist … `runtime/index` (host facade barrel, single consumer backend.cjs:154 — re-points to the package root)": the barrel file was never re-pointed (B-4). §32.30 inherits this inaccuracy via "the runtime barrel re-points into the package".

## 11. Verdict

**BLOCKED — B-1:** `@animastor/orchestration` cannot be released to npm until `@animastor/contracts` is republished with the `runtimeResult` module its workspace copy already has (dependency path and repro in §8). The package itself passes every boundary, dependency, API, host-binding, physical-move, behavior, and test check on this baseline; after the contracts republish (and re-running the clean-install probe), the only remaining pre-publish hygiene items are B-3 (add `README.md`) and optionally B-4 (host-side barrel cleanup, separate host commit).

No code, API, binding, Generation, or protocol change was made in this audit; no publish/version-bump/release commit was performed.
