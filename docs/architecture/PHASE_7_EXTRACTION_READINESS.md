# Phase 7 — Optional Extraction Readiness Audit

Status: audit + guardrails only. **Nothing was extracted.** No files moved, no
behavior changed, no protocol/DB/API changes (per phase constraints).
Date: 2026-09-04. Audit performed against commit `ed4d692f` (Phase 6 close).

Predecessors: [Phase 1 guardrails](PHASE_1_GUARDRAILS.md),
[Phase 2 contracts](PHASE_2_CONTRACTS.md),
[Phase 3 provider gateway](PHASE_3_PROVIDER_GATEWAY.md),
[Phase 4 book model](PHASE_4_BOOK_MODEL.md),
[Phase 5 orchestration/runtime](PHASE_5_ORCHESTRATION_RUNTIME.md),
[Phase 6 editor/player](PHASE_6_EDITOR_PLAYER.md).

Purpose: measure which logical modules are already isolated enough to become
independent packages/products in the future, and which dependencies still
block extraction. This document records the **measured current state**; it
does not prescribe refactoring.

Legend: 🟢 Ready · 🟡 Near-ready · 🟠 Coupled · 🔴 Not ready.

---

## 1. Method

Static source scan (requires/imports, Redis key literals, raw SQL, filesystem
constants) plus SCC cycle analysis over `backend/src`, `gpu-hub/`,
`worker/worker/`, `local-ai-connector/`, `frontends/app/src`. Every claim
below is derived from code at the audit commit; existing Phase 1–6
reconnaissance (`architecture-map.md`, `audit.md`) was used as context only.

For each contour we measured:

- public entry points (facade/contract surface);
- allowed dependencies;
- forbidden dependencies (would break the boundary);
- direct outward imports (measured);
- cycles (measured via SCC);
- DB / Redis / filesystem coupling (measured);
- frontend coupling (measured);
- runtime-specific coupling;
- extraction feasibility **without behavior change**.

---

## 2. Per-contour audit

### 2.1 VBook / Book Runtime (`backend/src/book/`) — 🟡

- **Public entry points (contract, Phase 2):** `book.loadBook`,
  `saveBookBundle`, `resetBook`, `extractBookBundle`, `buildBookFromBundle`,
  `collectScenes/collectSceneList`, `bundle-validator.cjs`; the Phase 4 facade
  `book-model.cjs` (`loadBook/getBookIdentity/getBookManifest/BookModelError`)
  and the Phase 4 deletion seam `book-deletion.cjs` (`deleteBook`).
- **Allowed deps:** node builtins, `adm-zip`, intra-domain files.
- **Forbidden:** orchestration, runtime, routes, raw `pg`/`ioredis`.
- **Outward imports (measured):** `config/runtime-config` (2),
  `services/language-detector` + `services/structure-detector` (3),
  `utils/*` (3) — all pinned in the Phase 1 `BOOK_ALLOWLIST`.
- **Cycles:** none (book is not in any SCC).
- **DB/Redis/FS:** disk bundle is the canonical store; zero direct Redis.
  The only SQL text lives in `book-deletion.cjs` and executes through the
  **injected** storage adapter (the book layer never requires `pg`).
- **Frontend coupling:** none (frontends reach the bundle only via API).
- **Runtime coupling:** none upward; runtime imports book, not vice versa.
- **Extraction verdict:** realistic as a standalone "VBook runtime" library.
  Blockers: (1) language/structure detectors are parsing-domain code living
  in `services/`; (2) `config/runtime-config` constants (paths); (3) the
  `manifest.book_id`/PG `books` ownership handshake remains host-provided.

### 2.2 Book Model (`backend/src/book/book-model.cjs` facade) — 🟢

- **Public entry points:** `loadBook(bookId,{mode})`, `getBookIdentity`,
  `getBookManifest`, `BookModelError`, `MODE_FULL/MODE_LAZY`.
- **Deps (measured):** only `../book/index.js` + `../book/lazy-book/draft.js`.
  No Redis, no PG, no runtime — exactly as specified in Phase 4 (T4).
- **Extraction verdict:** the facade itself is already a zero-coupling seam;
  its extraction readiness is bounded only by the book domain beneath it (🟡).

### 2.3 Player — 🟠 (facade 🟢 / contour 🟠)

- **Public entry points:** facade `backend/src/player/index.cjs`
  (`createPlayerModel` → read-only Book Model delegation); HTTP media surface
  (`/scene/*/audio|video|image`, `/preview`, `/iu-image`, `/scene/*/status`,
  chunks/playback queue); frontend seam `api/client.ts` + `mediaUrl` (Phase 6).
- **Allowed:** Book Model layer, node builtins, injected deps.
- **Forbidden (Phase 6 T3):** orchestration, runtime, Redis, PG, providers,
  generation internals — enforced for `backend/src/player/**`.
- **Outward imports (measured):** facade → `book-model.cjs` only. The
  **contour** routes still carry the Phase 6 pinned legacy edges:
  `generation-routes.cjs` mixes playback serving with the import/generation
  leg (runtime `scene-window`/`job-schema`/`dispatch-engine`/`worker-health`,
  PG repos, `ai-service`, orchestrators); `chunks-routes.cjs` merges derived
  PG progress (`scene-assets-repo`, `iu-progress-utils`) with canonical
  content.
- **DB/Redis/FS:** facade none; contour serves artifacts from `OUTPUT_DIR`
  and PG-derived progress (15 direct `OUTPUT_DIR` hits in
  `routes/generation-routes.cjs`).
- **Frontend coupling:** thin client by design (`playbackStore.ts` via the
  client seam; zero `/api/v1` literals in pages/state — Phase 6 T7).
- **Extraction verdict:** the *playback model* is extractable today; the
  *playback HTTP contour* is not, until the generation leg is split out of
  `generation-routes.cjs` and the PG-derived queue merge is ported.

### 2.4 Editor — 🟠 (facade 🟢 / contour 🟠)

- **Public entry points:** facade `backend/src/editor/index.cjs`
  (`createEditorModel` — `read`/`commit`, writer injected).
- **Outward imports (measured):** facade → `book-model.cjs` only.
- **Contour legacy edges (pinned, Phase 6 T6):**
  `core-routes.cjs` → `scene-assets-repo`, `orchestration/scene-restoration`
  (post-save derived-state sync), `source-coverage-audit`, `agent-prompts`;
  `entity-crud-routes.cjs` → `entity-cleanup.cjs` (Redis/PG purge),
  `book/lazy-book/paths`, `middleware/workspace-ownership`.
- **DB/Redis/FS:** canonical writes go through the one bundle writer
  (`book.saveBookBundle`, injected); the derived-state fan-out after a commit
  still touches PG/Redis directly from routes.
- **Extraction verdict:** the edit *model* (read → modify → commit) is
  extractable; the *post-commit derived-state hooks* (restoration, cleanup,
  coverage audit) need ports before the contour can move.

### 2.5 Provider Gateway (`backend/src/services/provider-gateway.js`) — 🟡

- **Public entry points:** `resolve.*` (workspace/book/purpose/system),
  `agent.*` (callAI/parseJsonResponse/callForPipeline/runWithProvider),
  `chat.*` (resolveProvider/sourceToken/runSharedInference/describeSharedError/
  SSE_EVENTS/SOURCE_TOKENS), `generation.sendJob`, `generation.comfyui.*`.
- **Deps (measured):** exactly five delegates — `ai-service`,
  `agent/ai-caller`, `workspace-ai-provider`, `runtime/gpu-dispatcher`,
  `generation/comfyui-provider`. Delegation-only facade, no state.
- **Consumers (measured):** only `routes/ai-routes.cjs` (the Phase 3
  demonstration consumer) — the rest of the app still calls the underlying
  implementations directly.
- **Known bypasses (documented Phase 3 §12):** `audio/generation.js`,
  `image/iu-processor.js`, `orchestration/scene-orchestrator.js` call
  `gpu.send/sendUnified` directly (8 measured `gpu-dispatcher` call sites);
  ComfyUI raw node knowledge still in `audio/generation.js`.
- **Internal coupling:** `workspace-ai-provider ⇄ system-ai` form a 2-module
  SCC (documented seam, Phase 3 §6).
- **Extraction verdict:** as a *contract/boundary* it is near-ready (stable
  surface, one consumer migrated). As an *independent package* it is blocked
  by the direct generation dispatch call sites and by the shared-pool/system-ai
  coupling inside the resolver.

### 2.6 Local AI Connector (`local-ai-connector/`) — 🟢

- **Public entry points:** standalone CLI (`index.cjs` + `lib/`), LAC
  protocol v1 frames (Phase 2 §5 — pinned by tests).
- **Deps (measured):** `ws` only + node builtins (`crypto`, `fs`, `path`,
  `http`, `https`, `url`, `util`, `events`, `stream`). **Zero** relative
  requires outside its directory; **zero** inbound requires from the repo.
  Own `package.json` (`animastor-ai-connector`).
- **DB/Redis/FS:** none (WS-only; backend keeps the Redis liveness mirror).
- **Frontend/runtime coupling:** none. Runtime-specific logic is behind the
  allowlisted local runtime adapter (`{base}/v1/models`,
  `{base}/chat/completions`).
- **Extraction verdict:** **already a standalone distributable package.**
  Remaining work is packaging/release only (publish LAC v1 as the contract).

### 2.7 Worker (`worker/worker/`) — 🟢

- **Public entry points:** the worker bundle (`worker.cjs` + cleanup/journal/
  env), Job Protocol v2 + hub HTTP contract (Phase 2 §7).
- **Deps (measured):** node builtins only (`child_process`, `fs`, `os`,
  `path`). **Zero** relative requires outside its directory; **zero** inbound
  requires from the repo; no Redis, no PG, no backend code (Phase 1 R1).
  Own `package.json` (`animastor-worker` v2).
- **Coupling:** talks HTTP to the hub only (`/beacon`, `/task/next`,
  `/task/result`, `/task/error`); ComfyUI is its local runtime concern.
- **Extraction verdict:** **already a standalone distributable bundle.**
  Blockers are protocol-level only: the Job Protocol v2 `job_id` grammar is
  synced across three copies (backend job-schema / hub / worker) — extraction
  requires publishing that grammar as the contract (no code change needed).

### 2.8 GPU Hub / Compute (`gpu-hub/`) — 🟢

- **Public entry points:** hub HTTP API (`POST /task`, `GET /task/next`,
  `POST /task/result`, `POST /task/error`, `POST /beacon`,
  `DELETE /queue/clear`) + Redis queue/result transport.
- **Deps (measured):** `express`, `cors`, `ioredis` + builtins. **Zero**
  code-level deps on backend/worker/book/generation (Phase 1 R2); **zero**
  inbound requires from the repo. Own `package.json`, own process/container.
- **DB/Redis/FS:** Redis queues/registries (shared key contract with the
  backend — see blockers); no PG; no book filesystem access.
- **Runtime-specific coupling:** none (deliberately dumb transport; backend
  owns retries/scheduling).
- **Extraction verdict:** **already an independent service.** Blockers are
  contract-level: (1) shared Redis key families with the backend
  (`animastor:queue/result/error/job/worker*` — cross-component literal usage
  measured, ownership documented in Phase 2 §9); (2) worker-auth mirror read;
  (3) the book-identity envelope fields (documented coupling core, Phase 2
  §7.3); (4) three synced Job Protocol v2 copies.

### 2.9 Cache — 🔴

- **What it is today:** not a module — a cross-cutting concern spread over
  `routes/book/cache-routes.cjs`, Redis chunk key families
  (`animastor:chunk:*`), the artifact filesystem (`OUTPUT_DIR`), and the
  runtime recovery paths (`scene-restoration`, `reconciliation-engine` C0,
  `cleanup-service`).
- **Outward imports (measured):** `cache-routes.cjs` pulls storage (11),
  services (7), middleware (5), orchestration, runtime, book, video, utils.
  Chunk-state writers span runtime/orchestration/services.
- **Coupling:** deep Redis + FS + PG tri-coupling; the same chunk keys are
  written by book-diff, task-handler, scene-window, callbacks and read by
  scheduler, iu-processor and the player.
- **Extraction verdict:** **not extractable** without inventing the module
  first. It is also not a product candidate — it exists to serve the runtime
  and the player. Any extraction here is out of scope indefinitely.

### 2.10 Generation (`generation/`, `audio/`, `image/`, `video/`, `workflows/`) — 🔴

- **Public entry points:** none formalized beyond the Phase 3
  `generation/comfyui-provider.js` seam and `generation.sendJob`.
- **Outward imports (measured):** `audio/` → runtime (2), workflows (7),
  state, storage, services, image; `image/` → runtime (7), storage (5),
  workflows (4), config (3), services (2); `video/` → config (3), workflows
  (2), runtime (2), image, services, storage; `workflows/` → **book domain
  (frozen violation, Phase 1 R4)**, services, storage, image.
- **Cycles:** `image/iu-processor.js` and `image/image-service.js` are inside
  the 14-module orchestration↔runtime↔services SCC.
- **DB/Redis/FS:** PG repos, Redis chunk/IU progress keys, `OUTPUT_DIR`
  artifact writes and validation — all direct.
- **Extraction verdict:** **not ready.** Generation is the least isolated
  contour: it is simultaneously a provider consumer (ComfyUI), a runtime
  participant, a state owner and a filesystem producer. Deliberately **not
  rewritten** in this phase (hard constraint).

### 2.11 Orchestration / Runtime — 🔴

- **Public entry points:** orchestrator facade (single lifecycle-state write
  owner), `dispatch-engine` (single dispatch authority), `finalizeDispatch`
  (single finalization point), Runtime Result Contract (`contracts/` +
  emitter/consumer seam, Phase 5).
- **Cycles (measured SCC):** a **14-module cycle** spanning
  `runtime/` + `orchestration/` + `services/` (task-handler, audio/video
  orchestrators, placeholder-audio, scene-asset-registry) + `image/`
  (iu-processor, image-service). Plus the 2-module
  `workspace-ai-provider ⇄ system-ai` SCC. All runtime→orchestration edges
  are frozen by the Phase 1 R5 baseline; the result path was extracted via
  the Phase 5 contract seam; residual edges are documented debt (Phase 5 §7).
- **DB/Redis/FS:** both layers own the Redis runtime state machine
  (`state/` consumed by 20+ files), 15 direct PG-repo imports in runtime,
  heavy `OUTPUT_DIR` usage in reconciliation/scene-window.
- **Frontend coupling:** none direct (SSE via `progress-pubsub`).
- **Extraction verdict:** **not ready — orchestration and runtime are one
  inseparable unit today.** Their boundary exists as a *direction* (frozen
  baselines + the contracts seam), not as an isolation boundary. Extraction
  would first require: journal port, executor port, scheduler/window write
  ports, services-leg unwind (Phase 5 §7 list) — explicitly out of scope.

---

## 3. Extraction matrix

| Module | Boundary | Coupling | Extraction readiness | Main blockers |
|---|---|---|---|---|
| Local AI Connector | standalone CLI, LAC v1 WS contract | none (ws-only, zero repo edges) | 🟢 Ready | none in code; publish protocol + package release |
| Worker | standalone bundle, Job Protocol v2 over HTTP | none (builtins only, zero repo edges) | 🟢 Ready | job_id grammar synced in 3 copies; publish as contract |
| GPU Hub / Compute | separate service, hub HTTP + Redis transport | Redis key families shared with backend; envelope carries book identity | 🟢 Ready | shared Redis contract; 3-way protocol copies; book-identity fields in envelope |
| Book Model (facade) | `book-model.cjs` read/deletion seams | none beyond book domain | 🟢 Ready | bounded by book domain below (🟡) |
| VBook / Book Runtime | canonical bundle CRUD + validator + manifest | detectors in `services/`, config constants, PG ownership handshake host-provided | 🟡 Near-ready | language/structure detector decoupling; config paths; ownership handshake interface |
| Provider Gateway | resolve/agent/chat/generation contracts | delegates to 5 modules; generation call sites bypass the seam; resolver↔shared-pool/system-ai coupling | 🟡 Near-ready | migrate direct `gpu.send` call sites; shared-pool/system-ai behind resolver interface |
| Player | player facade + media HTTP contour | facade clean; contour mixed with generation leg + PG-derived queue | 🟠 Coupled | split generation out of `generation-routes.cjs`; port the PG queue merge |
| Editor | editor facade (read/commit) | facade clean; post-commit derived-state fan-out in routes | 🟠 Coupled | post-commit hook port (restoration/cleanup/coverage) |
| Cache | none (cross-cutting) | Redis chunk families + OUTPUT_DIR + PG, written by 4+ subsystems | 🔴 Not ready | not a module; would need to be invented first — no product candidate |
| Generation | ComfyUI seam only | runtime + state + storage + FS + workflows→book violation; inside the big SCC | 🔴 Not ready | full seam migration (Phase 3 §12), state ownership, artifact pipeline ownership |
| Orchestration | orchestrator facade + result contract seam | 14-module SCC with runtime/services/image; Redis/PG/FS owners | 🔴 Not ready | journal/executor/scheduler write ports; services-leg unwind |
| Runtime | dispatch/scheduler/reconcile core | same SCC; runtime→services imports; Redis/PG/FS owners | 🔴 Not ready | same as orchestration — the two extract together or not at all |

---

## 4. Best extraction candidates

Confirmed by the audit (not aspirations):

### 4.1 Local AI Connector (🟢)

1. **Already isolated:** own package, `ws`-only, zero repo edges in either
   direction, sanitized LAC v1 protocol, no Redis/PG/FS.
2. **Before extraction:** nothing functional — versioning/CHANGELOG and
   publishing the LAC v1 frame contract as its public spec.
3. **Dependencies to replace with interfaces:** none required; the local
   runtime adapter allowlist already is the interface.
4. **Host-provided:** credential/registration issuance, shared-pool policy,
   Redis liveness mirror (backend side).
5. **Future format:** standalone npm package / distributable CLI
   (`animastor-ai-connector`).

### 4.2 Worker (🟢)

1. **Already isolated:** own package, node-builtins-only, HTTP-to-hub only,
   no Redis/PG, Job Protocol v2 enforced on both sides.
2. **Before extraction:** extract-and-publish the Job Protocol v2 grammar
   (job_id families, envelope, timeout semantics) as a versioned spec/package
   shared by hub/backend/worker instead of 3 synced copies.
3. **Dependencies to replace with interfaces:** none — hub HTTP is the
   interface; ComfyUI adapter is already worker-internal.
4. **Host-provided:** workflow tarball delivery (`/worker-bundle*`,
   `/workflow/:id`), worker credentials (registry mirror).
5. **Future format:** distributable worker bundle / npm package
   (`animastor-worker`), optionally a standalone installer.

### 4.3 GPU Hub / Compute (🟢)

1. **Already isolated:** own package + process, express/ioredis only, zero
   backend code deps, dumb-transport role (no scheduling, no business logic).
2. **Before extraction:** formalize the Redis key-family contract
   (`queue/result/error/job/worker*`) and the worker-auth mirror as a
   published interface (currently implicit, measured cross-component);
   decouple book-identity envelope fields into opaque `payload.meta`.
3. **Dependencies to replace with interfaces:** shared Redis keys → owned
   queue API; envelope identity → opaque dispatch metadata.
4. **Host-provided:** Redis instance, backend callback URL, worker registry
   policy sources.
5. **Future format:** independent service/package (`animastor-gpu-hub`) — it
   already runs as one; extraction is contractual, not structural.

### 4.4 VBook Runtime + Book Model (🟡)

1. **Already isolated:** canonical bundle CRUD + validator + manifest
   identity; `book-model.cjs` facade with zero outward coupling; deletion
   behind injected adapters; no Redis, no upward deps, no cycles.
2. **Before extraction:** move `language-detector`/`structure-detector` out
   of `services/` (or behind a parser interface); lift path constants
   (`config/runtime-config`) into module options; define the PG ownership
   handshake (`books` table) as a host-provided port.
3. **Dependencies to replace with interfaces:** detector services, runtime
   config, ownership/auth (assumes caller authorized today — keep that way,
   documented).
4. **Host-provided:** filesystem root (`BOOKS_DIR`), ownership checks,
   derived PG projections (book-sync).
5. **Future format:** shared library package (`@animastor/vbook-runtime`)
   consumed by backend, and later by a standalone player/editor.

### 4.5 Provider Gateway (🟡)

1. **Already isolated:** stable three-direction contract surface
   (agent/chat/generation), delegation-only facade, no state.
2. **Before extraction:** migrate the 8 direct `gpu-dispatcher` call sites
   behind `generation.sendJob` / `ComfyUIProvider`; move ComfyUI node
   knowledge out of `audio/generation.js` behind the seam (Phase 3 §12 debt).
3. **Dependencies to replace with interfaces:** shared-pool + system-ai
   inside the resolver (replace `selectSharedAI` behind the seam — the
   Phase 2 hook); `gpu-dispatcher` becomes an injected transport port.
4. **Host-provided:** workspace provider storage (PG), credential vaulting,
   the GPU Hub itself.
5. **Future format:** library package (`@animastor/provider-gateway`) with
   pluggable transports (cloud HTTP, connector WS, ComfyUI).

### 4.6 Player (longer-term, 🟠)

1. **Already isolated:** the read-only player facade over the Book Model;
   frontend thin-client seam (`api/client.ts`/`mediaUrl`).
2. **Before extraction:** split the generation leg out of
   `routes/generation-routes.cjs`; port the PG-derived playback-queue merge
   (chunks-routes) behind a player-facing projection; then the media-serving
   contour becomes a pure "VBook + assets → playback projection" module.
3. **Dependencies to replace with interfaces:** PG progress repos →
   playback-projection port; runtime `worker-health`/`scene-window` reads →
   injected read models.
4. **Host-provided:** artifact HTTP serving (or move it into the player
   package later), position persistence.
5. **Future format:** `@animastor/player` consuming `@animastor/vbook-runtime`
   — the standalone "open a .vbook" product direction from
   `MODULAR_PRODUCT_ARCHITECTURE.md` §6.

**Not candidates (audit-confirmed):** Cache (🔴, not a module), Generation
(🔴), Orchestration/Runtime (🔴) — listed in the matrix for completeness.

---

## 5. Phase 7 architecture guards

New suite: `backend/tests/architecture/phase7-extraction-readiness.test.js`.
It freezes the *measured* boundaries above and does not duplicate Phase 1–6
tests (worker/hub/LAC outbound allowlists, R4/R5 edge freezes, Phase 6 T1–T7
facades stay as they are):

- **P7-T1** — LAC package isolation, both directions: no file outside
  `local-ai-connector/` requires into it; no file inside requires out;
  manifest stays dependency-minimal (`ws`).
- **P7-T2** — Worker inbound isolation: nothing in the repo requires into
  `worker/worker/` (Phase 1 R1 guards only the outbound direction).
- **P7-T3** — GPU Hub inbound code isolation: nothing in backend/worker/LAC
  requires into `gpu-hub/` (Phase 1 R2 guards only the outbound direction).
- **P7-T4** — VBook internals consumer freeze: the exact set of files
  reaching into `book/lazy-book/**` / raw `book.loadBook` outside the
  facades is pinned; a NEW direct consumer of VBook internals fails.
- **P7-T5** — Book Model facade edge freeze: `book-model.cjs` requires only
  inside `backend/src/book/` (the facade cannot grow implementation deps).
- **P7-T6** — Provider Gateway boundary: its delegate module set is frozen
  (the five known delegates) and its consumer set stays explicit; new
  delegates or new direct consumers must be conscious decisions.
- **P7-T7** — Cycle membership freeze: the orchestration↔runtime↔services↔image
  SCC member set is pinned by name; **no new module may join the cycle**
  (stricter and more future-proof than the R5 edge freeze, which only stops
  new runtime→orchestration edges).
- **P7-T8** — Facade bypass freeze: modules that call `runtime/gpu-dispatcher`
  directly (the Provider Gateway bypass set) are pinned; migration to the
  gateway seam must be a conscious baseline update, not silent drift.

---

## 6. Hard constraints honored

No microservices, no new services, no Docker decomposition, no DB schema
changes, no API breaking changes, no file moves, no Generation rewrite, no
Runtime/Orchestration rewrite, no Redis/GPU Hub/Worker protocol changes, no
VBook format changes, no frontend refactor, no consumer mass-migration.
Phase 7 = audit + guardrails + this document.

## 7. Verification

- `cd backend && npm test` — full suite (incl. `tests/architecture/*`).
- `cd backend && npm run test:arch`.
- Frontend `npm run typecheck` (tsc) — available; backend has no lint script.
- No GitHub CI in this repository (no `.github/`) — CI cannot be run;
  verification is local only (documented requirement).
