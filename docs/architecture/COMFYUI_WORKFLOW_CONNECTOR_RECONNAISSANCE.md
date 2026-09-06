# ComfyUI Workflow Connector — Module Extraction Reconnaissance

**Status:** READ-ONLY reconnaissance. No production code changed, no files moved, no package created, no extraction started.
**Date:** 2026-09-06
**Candidate:** standalone module `animastor-comfyui-workflow-connector`
**Context:** Worker physically extracted (Phase 9D); GPU Hub audit in flight (parallel coder); next-candidate recon ranked VBook Runtime #1 (see `PHASE_NEXT_MODULE_EXTRACTION_RECONNAISSANCE.md`). This document measures the ComfyUI workflow-integration contour specifically, per the same discipline.

**Inputs:**

- `backend/src/workflows/**`, `backend/src/generation/comfyui-provider.js`, `backend/src/runtime/gpu-dispatcher.js` + `job-schema.js`, `backend/src/services/{workflow-manager.js,profile-override.js,provider-gateway.js}`
- `backend/ai/workflows/*.json`, `backend/ai/connectors/conn-*.json`
- `gpu-hub/gpu-hub.js`, `worker/worker/worker.cjs`, `worker/worker/job-protocol-v2.cjs`
- `contracts/` (Job Protocol v2 canonical), `backend/tests/architecture/phase3-provider-gateway.test.js`, `phase7-extraction-readiness.test.js`
- `MODULAR_PRODUCT_ARCHITECTURE.md` (§Generation, C12), `PHASE_NEXT_MODULE_EXTRACTION_RECONNAISSANCE.md`

---

## 1. Where the ComfyUI integration actually lives

Four layers, measured at HEAD:

| Layer | Files | Role |
|---|---|---|
| Workflow mapping (backend) | `backend/src/workflows/workflow-loader.js` (100 LOC), `connector-loader.js` (934), `entity-schema.js` (340); assets `backend/ai/workflows/*.json` (7 active: `tts-qwen-narrator`, `tts-qwen-dialogue`, `img-qwen-image`, `video-ltx-1p/2p/3p/4p`), `backend/ai/connectors/conn-*.json` (7) | Load ComfyUI workflow JSON; declarative entity→nodeId/field mapping ("connector" files); sha256 workflow hash + compatibility check; binding application (`setValue`/`applyBinding`); connector registry CRUD |
| Provider seam | `backend/src/generation/comfyui-provider.js` (95) | Phase 3 seam: `loadWorkflow`/`getConnector`/`getWorkflowHash`/`generate` (delegates to `gpu-dispatcher.sendUnified`)/`buildJobId`. Pinned by arch tests |
| Dispatch | `backend/src/runtime/gpu-dispatcher.js` (239), `job-schema.js` (facade re-export of `@animastor/contracts`) | `POST {HUB_URL}/task`, Job Protocol v2 envelope, retry ×3, per-type timeouts, **server-derived routing** (book→workspace→private lane / grant-policy lane / system pool; PG repos via lazy requires) |
| ComfyUI transport | `worker/worker/worker.cjs` (750) | The **real** transport: `waitForComfyUI` (GET `/system_stats`), `runWorkflow` (POST `/prompt`), `waitResult` (**polling** GET `/history/{prompt_id}` — no WebSocket anywhere), `downloadResult` (local FS first, GET `/view` fallback), `findOutputNodes` (SaveImage/SaveAudio/SaveVideo/CreateVideo), input-asset staging to `COMFY_INPUT_DIR`, crash-safe cleanup journal |
| Hub | `gpu-hub/gpu-hub.js` (2029) | Redis queues/lanes, `/task/next` pop, `/task/result`/`/task/error` → backend (`routes/generation-routes.cjs:1340,1437`), workflow allowlist serving for installer, beacon/timeout sweeps |

**Status/results/errors path (backend side):** result arrives as `result_base64` via gpu-hub → `POST /gpu/task/result` (`routes/generation-routes.cjs:1340`) → `taskHandler.handleTaskResult` (business logic); errors via `/task/error` → `notifyBackendError`. Additionally Redis-based reconciliation (`runtime/reconciliation-engine.js:1733`, `services/audio-recovery.cjs`).

---

## 2. Dependency map

### 2.1 Callers of the integration (backend)

- `audio/generation.js:481-556` — builds TTS workflow, patches via connector, `gpu.send` (also fallback node ids, see §2.4)
- `image/iu-processor.js:252-284` — image workflow build + `gpu.send`, interleaved with Redis in-flight markers / dedup keys
- `image/connector-utils.js`, `audio/connector-utils.js` — thin connector helpers
- `workflows/video/video-workflows.js` (658 LOC) — multi-image LTX workflow builder
- `orchestration/scene-orchestrator.js:469` — direct `gpu.sendUnified` (bypass)
- `services/workflow-manager.js` (557) — admin/API orchestration over the registry (statuses, validation, hot-reload, binding/parameter edits)
- `services/profile-override.js:96` — reads connector parameters as user-facing settings
- `backend.cjs:366` — startup `loadWorkflows()` (fatal throw when a workflow lacks its connector)

### 2.2 The clean core (measured)

`workflow-loader + connector-loader + entity-schema` (~1,400 LOC) depend on **fs/path/crypto only**. Zero DB, zero Redis, zero business imports. `WF_DIR`/`CONNECTOR_DIR` are already env-overridable. This trio is the natural package seed.

### 2.3 Hidden dependencies (extraction blockers)

1. **Connector-as-config-store.** `services/profile-override.js` reads connector `parameters[*].default` as persistent user settings; `workflow-manager.js` mutates them (`updateConnectorParameter` — in-memory) and `addConnector` writes connector files to disk. The registry is simultaneously data AND a settings store — a two-way host coupling.
2. **Hardcoded node-id fallbacks in business code.** `audio/generation.js:492,521-524` patch nodes directly (`wfAudio["108"]`, `["71"]`, `["80"]`, `["74"]`) when no connector resolves — raw ComfyUI node ids leak into the generation domain.
3. **`comfyui-provider` → `gpu-dispatcher` direct require** — dispatch is not injectable yet.
4. **4 dispatch bypass sites** (P7-T8 set): `scene-orchestrator.js:469`, `iu-processor.js:278`, `audio/generation.js:351,550` — traffic flows around the Provider Gateway seam.
5. **Architecture guard tests pin file paths**: `phase3-provider-gateway.test.js:263,285` (seam requires workflow-loader; LLM files must not), `phase7-extraction-readiness.test.js:190,307` (comfyui-provider edges). Any move requires guard updates (Phase 9D pattern).
6. **Startup fail-closed** at `backend.cjs:366` — workflow/connector loading is part of host boot semantics.

### 2.4 Cycles and mixing

- No cycles inside the mapping trio. The wider generation contour sits inside the 14-module SCC (orchestration↔runtime↔services↔image; Phase 7 P7-T7) — unchanged from the prior recon.
- Business/ComfyUI mixing points: `video-workflows.js` (video_tokens, passport reconciliation, `book` domain — the frozen Phase 1 R4 violation), `audio/generation.js` (voice fallback + speaker parsing interleaved with workflow patching), `iu-processor.js` (Redis markers around dispatch).

---

## 3. Proposed module boundary

```
animastor-comfyui-workflow-connector
├── IN:
│   ├── workflow-loader / connector-loader / entity-schema
│   ├── workflow + connector JSON assets (or injected dirs)
│   ├── hash + compatibility checking
│   ├── workflow building from an entity-keyed spec
│   └── (optional) direct ComfyUI client: /prompt, /history, /view, /system_stats
└── OUT:
    ├── gpu-dispatcher routing policy (workspace/PG lanes) — host concern
    ├── job_id / queues / envelopes — already @animastor/contracts (Job Protocol v2)
    ├── business builders (voices, prompts, video_tokens) — Animastor generation domain
    ├── profile-override, workflow-manager — host consumers, not module internals
    ├── result ingestion / task-handler — host business logic
    └── installer / compatibility-resolver — separate ComfyUI environment concern
```

Principle: **connector = workflow definitions + node mapping + (optionally) transport**; the host decides *what to inject and when*.

---

## 4. Proposed public API (concept only, no implementation)

```
Animastor (generation domain) ──▶ animastor-comfyui-workflow-connector ──▶ ComfyUI / GPU Hub

createConnector({ workflowsDir, connectorsDir, logger })
  .listWorkflows() / .getStatuses()
  .getWorkflow(name) → deep clone
  .getConnector(name)
  .validate(name) → { compatible, warnings }
  .build({ workflow: name, inputs: { entityKey: value }, parameters: {…} })
      → { workflowJson, workflowHash }              // node ids/fields stay hidden
  .execute({ workflowJson, baseUrl | transport, timeoutMs, assets })
      → { promptId, result: { type, data | meta } } // optional transport half

Errors (typed): WorkflowNotFound | ConnectorMissing | IncompatibleWorkflow | ComfyUIError
Hidden inside: nodeId, field paths, class_type, Save* node names, ComfyUI endpoints,
file naming conventions, MIME mapping
```

---

## 5. Fate of the workflow-part categories

| Category | Disposition | Notes |
|---|---|---|
| workflow definitions / templates | **module** | core asset |
| node/input mapping (connectors) | **module** | connector JSON schema is the de-facto contract |
| entity catalog (`entity-schema.js`) | module; keys are the public vocabulary | consumed by host UI (workflow-manager) |
| generation parameters / assembly defaults | **above** (host) | module only applies values |
| checkpoint/model references | in workflow JSON (module data) | model *installation/compatibility* stays with installer |
| queue/job IDs | **not** module | Job Protocol v2 (`@animastor/contracts`) |
| output references (`meta {filename, subfolder, type}`) | transport half of the module | conversion to business artifacts stays host |
| metadata / result ingestion | **not** module | hub + host task-handler |

---

## 6. Autonomy assessment

- ✅ The mapping trio is independently testable today (pure functions + injectable dirs).
- ⚠️ `comfyui-provider` needs dispatcher **injection** (currently a direct require).
- ⚠️ Tests are host-owned (`backend/tests/`) — a package-owned suite is required (§26.5 graduation rule).
- ✅ Replaceability by another backend connector becomes real only after contract **C12 (media generation provider contract)** exists — currently **MISSING** (`MODULAR_PRODUCT_ARCHITECTURE.md:874`, slated Phase 12).
- ✅ Packaging precedent established: `@animastor/contracts` repo-root node_modules symlink + the docker build-context caveat documented in `job-schema.js`.

**Changes required for autonomy:** inject dirs (trivial), inject dispatch transport, port for profile-override reads, eliminate hardcoded node-id fallbacks (make connectors mandatory), decide ownership of registry-mutation APIs (add/update/enable), package-owned tests, guard-test path updates.

---

## 7. Extraction complexity: MEDIUM

- **Near-risk-free (LOW):** the trio + JSON assets + hash logic. Zero host dependencies beyond fs/path/crypto.
- **Small adapter:** comfyui-provider (injected dispatcher), workflow-manager (consumer), profile-override (read port).
- **Architectural rework:** migrating the 4 bypass sites, removing hardcoded node-id fallbacks in `audio/generation.js`, splitting `video-workflows.js` business logic.
- **Dangerous to touch now:** `gpu-dispatcher` (PW-2/SH-2 routing policy with PG reads), result ingestion path, Redis in-flight markers in `iu-processor`.

---

## 8. Fit with the modular architecture

- `MODULAR_PRODUCT_ARCHITECTURE.md` §Generation: "generation should gradually become a provider-independent module" — the proposed boundary matches the intent; C12 is the interface to define first.
- Scope is neither too wide (no queues/routing/business) nor too narrow (includes definitions + mapping).
- Pre-extraction dependency removals: profile-override reads, node-id fallbacks, direct gpu-dispatcher require.
- **Caveat:** `PHASE_NEXT_MODULE_EXTRACTION_RECONNAISSANCE.md` ranks the full Generation contour 🔴 (readiness 0/5, SCC member) and names VBook Runtime as the #1 next candidate. The mapping trio measured here is far cleaner than the full contour, so a narrow-scope extraction is viable — but as a module-priority decision it ranks **behind VBook** and behind the (in-flight) GPU Hub audit.

---

## 9. Verdict

1. **Found:** 4 layers (mapping trio / provider seam / dispatch / worker transport); full pipeline uses polling, no WebSocket.
2. **Current architecture:** the gateway is a facade without traffic (4 bypasses); the wire is contract-owned (Job Protocol v2).
3. **Boundary:** mapping + definitions (+ optional transport) in the module; routing, queues, business builders outside.
4. **Public API:** `createConnector → validate / build / execute`, typed errors, node ids hidden.
5. **Dependencies:** core is clean (fs/path/crypto); hidden — profile-override, node-id fallbacks, arch-test pins.
6. **Problems:** bypass call sites, connector-as-config-store, missing C12.
7. **Extraction risks:** low for the core, high for migrating the audio/video call sites.
8. **Score: MEDIUM** (core LOW, full extraction HIGH).
9. **Extract first:** trio + assets, then the provider seam with dispatcher injection.
10. **Next step:** an extraction-readiness phase (Phase 9D pattern): freeze the connector schema + entity catalog as a contract, ADRs for the ports (profile-override, dispatch), package-owned tests; design C12 in parallel. Legitimate candidate **after** the GPU Hub audit, but in module priority it follows VBook Runtime.

---

*Nothing in the repository was modified by this reconnaissance (code).*
