# Backend Final Architecture Audit — end of physical decomposition (c21.4+)

**Status:** AUDIT / RECONNAISSANCE ONLY. No source code, package manifests, or tests were changed by this document.
**Date:** 2026-09-26
**Branch:** `c21.4-physically-extract-analysis-from-backend` (HEAD `fed721ff`)
**Predecessor:** `docs/architecture/backend-decomposition-reconnaissance.md` (2026-09-25)
**Method:** fresh inventory of `backend/src` (179 files, **40,796 LOC**), full static require-graph scan with Tarjan SCC detection (179 nodes, 423 internal edges), per-file external-dependency and `process.env` census, consumer tracing for every candidate block, byte-level reading of every plausible seam, stale-path sweep of `backend/src` and `backend/tests`, and reverse-dependency scan of all 30 `packages/*` trees (src + tests, node_modules excluded).

**Question answered:** *Остался ли в backend ещё код, который действительно имеет смысл физически выделить в существующий или новый npm-пакет?*

---

## 1. Executive conclusion

**Extraction phase is factually complete.** After `@animastor/generation` (dirty grammar/adoptions), `@animastor/parser` (source-coverage/encoding-detect), deletion of the stale ai-agent task copies, and the physical `@animastor/url-safety` package (`c3175549`), **no module remaining in `backend/src` passes the strict extraction test**.

Measured this pass:

- **0 new EXTRACT candidates** (no new npm packages justified).
- **0 ADOPT candidates above low-value threshold.** The previous reconnaissance's adoption backlog (§6 of that document) is fully executed; the media-tier adoptions that remained "MEDIUM/pending" there were re-audited and **downgraded to KEEP HOST-BOUND** (see §4.2 — each carries a host coupling that extraction would merely relocate, not remove).
- **1 real file-level SCC remains** (`system-ai.js ⇄ workspace-ai-provider.js`, lazy requires) — blocking only the AI-provider plane, which has independent host-bound reasons.
- **0 stale imports of old backend paths** in production code; **0 reverse (host-pulling) dependencies in any extracted package.**
- What remains is, almost entirely, the host's *execution plane*: HTTP contour, port adapters, SQL/Redis/FS legs, composition root, and FSM orchestrators — code whose home is the host by design.

The only actionable items found are **low-value cleanup** (shim retirements, one synthetic barrel, a hidden transitive dependency) — worth doing as hygiene, not as decomposition, and explicitly **not** proposed as packages.

---

## 2. Current backend map (measured)

### 2.1 Size and shape

| Area | Files | LOC | Content (verified) |
|---|---|---|---|
| `services/` (flat) | 53 | 15,936 | book-state legs, AI-provider plane, media service wrappers, worker-auth, workflow-manager, agent-session |
| `services/agent/` | 8 | 4,632 | ingest/agent pipeline (pipeline-runner 1,371; pipeline-steps 1,342; bootstrap 805; parallel-analysis-orchestrator 441; unit-splitter 301; text-utils 186; window-generator-adjacent text utils) |
| `storage/` | 32 | 7,353 | `postgres/` (schema 1,809 + 17 repos incl. `index.js` barrel), 9 O-port adapters (by design), filesystem-store 337, asset-registry 358, runtime-persistence-adapter 233 |
| `routes/` (+`book/`, `editor/`) | 27 | 8,065 | HTTP contour (import 985, ai-connector 919, worker 814, generation 659+593, debug 578 …) |
| `audio/` | 11 | 1,839 | TTS pipeline (segments 363, pipeline 300 with 3 env reads, generation 599, silence, chunks, validation, ffmpeg grammar) |
| `video/` + `workflows/video/` | 5 | 1,860 | video-merge 665 (ffmpeg+env), video-timeline 322 (env), video-service 217 (Redis), video-workflows 649 (LTX builders, 3 env reads) |
| `image/` | 7 | 1,086 | prompt-builder 406, iu-processor 360 (orchestration driver), preview 81 (sharp), registry 84, image-service 67 |
| `runtime/` | 4 | 693 | runtime-loop 351, gpu-dispatcher 224 (PW-2 policy + hub HTTP), orchestration-seams 87, job-schema facade |
| `state/` | 5 | 611 | asset-state-store (Redis FSM persistence), scene-state-ops 190 (PG sync, lazy repo), event-journal 248 (Redis), scene-state shim, index barrel |
| `middleware/` | 4 | 588 | auth-context 349, workspace-ownership, ai-book-guard, worker-auth-middleware |
| `helpers/` | 2 | 502 | redis-helpers 435 (book/runtime Redis grammar), utils (log) |
| `config/` | 2 | 370 | runtime-config (18 `process.env` reads — the env epicenter), generation-config-adapter (S-6) |
| `metrics/` | 1 | 274 | prom-client registry (consumers: `backend.cjs`, `runtime-loop`) |
| `utils/` | 4 | 43 | string-utils 31 (getOutputPath→config + escapeRegExp), 3 one-line shims → vbook-runtime (4 LOC each) |
| `auth/` | 2 | 168 | composition-root shim → `@animastor/auth` (5 env reads) |
| `book/` (15 files, 66 LOC), `editor/`, `contracts/` | 17 | 96 | pure compatibility shims |
| root (`backend.cjs`, `startup-resume.js`) | 2 | 1,052 | composition root (995 LOC, fan-out 76, 23 `@animastor/*` specifiers) + startup resume (PG repos) |
| `scripts/` | 1 | 260 | dev-only test script |
| **Total** | **179** | **40,796** | |

(Down from 192 files / ~43,058 LOC at the reconnaissance: dirty-grammar, source-coverage, encoding-detect, url-safety and the stale ai-agent task copies have physically left.)

### 2.2 Require-graph shape (measured, static)

- **179 nodes, 423 internal edges.** Hub: `backend.cjs` fan-out 76. Secondary hubs: `agent/bootstrap` (13), `routes/book-routes` (12), `routes/generation-routes` (12), `agent/pipeline-runner` (11), `storage/postgres/repositories/index` (11).
- Highest fan-in: `storage/postgres/database.js` (31), `config/runtime-config.js` (27), `services/agent-prompts.js` (11), `scene-assets-repo` (10), `book-repo` (8), `agent-session` (8), `middleware/workspace-ownership` (7).
- **File-level SCCs: exactly one** (see §5).
- **Env epicenter:** 19 files read `process.env`; by count — `config/runtime-config` (18), `workspace-ai-provider` (7), `auth/index.cjs` shim (5), `storage/postgres/database` (5), `ai-loader` (3), `backend.cjs` (3), `audio/pipeline` (3), `workflows/video/video-workflows` (3). Every candidate-grade pure module reads **zero** env.

### 2.3 What has left the host (verified live)

| Package | Status this pass |
|---|---|
| `@animastor/contracts`, `vbook-runtime`, `parser`, `player`, `editor`, `generation`, `orchestration`, `ai-agent`, `ai-analysis`, `assistant`, `auth`, `gpu-hub`, `installer`, `url-safety` | all consumed via specifiers from `backend/src`; host copies deleted (single canonical owners) |
| `animastor-worker`, `animastor-comfyui-workflow-connector`, `animastor-ai-connector`, 15 `web-*` packages | independent; no host-path imports |

---

## 3. Candidate screen — method

A candidate passes only if extraction creates a *real* boundary (`host → package → explicit ports → adapters`) where the package:

- has **no** `backend/src/**` requires, Express, PG/Redis internals, `process.env`, host fs paths (`AI_DIR`, `OUTPUT_DIR`), or implicit singletons;
- has **real consumers** (≥2, or a cross-contour contract) — a package for a single host consumer adds publication/boundary overhead without a boundary gain;
- is **domain logic** (grammar, policy, analysis) rather than a **host adapter** (the concrete leg of a port — the leg *is* the host file by design);
- does not sit inside an SCC with host-bound code without prior seam work that itself has standalone value.

Every remaining module was re-tested against these criteria. Results below.

---

## 4. Verdicts

### 4.1 Candidates table (everything that even partially qualified)

| # | Candidate | LOC | Couplings found (verified) | Real consumers | Verdict | Reasoning in |
|---|---|---|---|---|---|---|
| 1 | `services/agent/parallel-analysis-orchestrator.js` | 441 | only `p-limit`; zero internal requires | 1 (`pipeline-runner`) | **KEEP HOST-BOUND** | §4.2.1 |
| 2 | `services/share-events.js` | 74 | zero requires — fully pure; in-memory sink set + payload builder | 1 (`routes/worker-routes`) | **KEEP HOST-BOUND** (deferred) | §4.2.2 |
| 3 | `image/prompt-builder.js` | 406 | `image/helpers` (getOutputPath→`config.OUTPUT_DIR`, sharp-based `normalizeForMatch` via `sharp` dep in image/ tier) | 3 host files | **KEEP HOST-BOUND** (downgraded from ADOPT) | §4.2.3 |
| 4 | `workflows/video/video-workflows.js` | 649 | `profile-override` (Redis singleton + connector loader), `utils/string-utils` (config reach-in), **3 `process.env` reads** (VIDEO_FPS, LTX_FRAME_ALIGN, VIDEO_CHUNK_MAX_SEC — module-level `const`), 1 lazy PG `query` fallback, `generation.ports.bookData` **global port reach-in** | 2 (`video/service`, `video/timeline`) | **KEEP HOST-BOUND** (downgraded from ADOPT-WITH-SEAM-WORK) | §4.2.4 |
| 5 | `audio/` pure core (segments 363, silence 176+, ffmpeg 176, chunks, validation) | ~860 | `audio/helpers` → `utils/string-utils.getOutputPath` → `config.OUTPUT_DIR`; `chunks`/`validation` → `generation.artifactNaming` global; `validation` → `music-metadata` (call-time); module-level `fs`/`path` on artifact paths | intra-`audio/` + 1 (`audio-orchestrator` lazy) | **KEEP HOST-BOUND** (downgraded from ADOPT-WITH-SEAM-WORK) | §4.2.5 |
| 6 | `utils/string-utils.js` | 31 | `getOutputPath` → `config.OUTPUT_DIR` (host reach-in); `escapeRegExp` pure | 3 (`audio/helpers`, `image/helpers`, `video-workflows`) | **KEEP HOST-BOUND** (low-value cleanup listed) | §4.2.6 |
| 7 | `utils/{snake-guard,scene-title-utils,character-identity}.js` shims | 12 | zero — 1-line re-exports of `@animastor/vbook-runtime` subpaths | 3 (1 each) | **KEEP HOST-BOUND (shims)** — low-value cleanup | §4.2.7 |
| 8 | `services/ai-agent/index.js` barrel | 17 | delegates to `@animastor/ai-analysis` | 1 (`pipeline-steps`) | **KEEP HOST-BOUND (shim)** — low-value cleanup | §4.2.7 |
| 9 | `book/` shims (15 files), `editor/index.cjs`, `contracts/runtime-result.js`, `runtime/job-schema.js`, `state/scene-state.js`, `state/index.js`, `services/language-detector.js` | ~96 | all 1-line re-export facades to packages | backend.cjs + a few routes | **KEEP HOST-BOUND (shims)** — low-value cleanup | §4.2.7 |
| 10 | `services/profile-override.js` | 123 | Redis singleton (`setRedis` primed at route registration) + connector loader | 6 (4 media + routes + bootstrap) | **KEEP HOST-BOUND** | §4.2.8 |
| 11 | `metrics/prometheus.js` | 274 | `prom-client` + `generation.mediaRegistry` | 2 (`backend.cjs`, `runtime-loop`) | **KEEP HOST-BOUND** | §4.2.9 |
| 12 | AI-provider plane (`ai-service` 656, `workspace-ai-provider` 754, `system-ai` 230, `provider-gateway` 174, `ai-loader` 252, `prompt-profile-loader` 107, `ai-connector/` 1,296) | ~3,470 | SCC (§5.1), 12 env reads across plane, 5 lazy PG sites, host `AI_DIR` content contract, 5 route files, `url-safety` consumed at call sites | routes, agent bootstrap, schema | **KEEP HOST-BOUND** | §4.2.10 |
| 13 | Ingest/agent pipeline (`services/agent/` core, `agent-session`, `txt-importer`, `window-generator`, `source-coverage-audit`) | ~5,300 | direct SQL sessions, Redis cancellation, config windowing, `ai-loader` host prompt content, orchestration dispatch | routes, backend.cjs | **KEEP HOST-BOUND** | §4.2.11 |
| 14 | `services/workflow-manager.js` | 557 | wraps connector loader/workflow loader; connector hot-reload over host fs (`ai/connectors/**`) | 1 (`routes/connector-routes`) | **KEEP HOST-BOUND** | §4.2.12 |
| 15 | `storage/postgres` schema + 17 repos, 9 O-2..O-10 adapters, `filesystem-store`, `asset-registry`, `runtime-persistence-adapter` | ~7,300 | SQL by doctrine; Redis/FS legs; adapters ARE the port implementations | everything | **KEEP HOST-BOUND (by design)** | §4.2.13 |
| 16 | Worker domain core (`worker-auth` 215, middleware, `routes/worker-routes` 814, `structure-detector` 46) | ~1,200 | Redis key grammar contractually shared with GPU Hub (frozen contract tests) | routes, hub | **KEEP HOST-BOUND** | §4.2.14 |
| 17 | Composition/root plane (`backend.cjs`, `config/`, `runtime/`, `helpers/`, `state/` executors, `book-deletion`, `task-handler`, `book-sync`, `book-diff` host half, `cleanup-service`, `entity-cleanup`, `startup-resume`, `scripts/`) | ~5,600 | port wiring, transport, host doctrine | — | **KEEP HOST-BOUND (deliberate)** | §4.2.15 |

**Zero EXTRACT verdicts. Zero ADOPT verdicts above low-value threshold.** Items 1–2 are the two *purest* files left in `services/`; both still fail the consumer/owner test (§4.2). This is the strongest possible negative result: even the best-shaped leftovers don't justify a package.

### 4.2 KEEP HOST-BOUND — technical reasons (per the task requirement: reasons, not labels)

**4.2.1 `services/agent/parallel-analysis-orchestrator.js` (441 LOC).** The only internal require is `p-limit`; the file is concurrency strategy over injected callbacks. Two technical blockers, re-verified: (a) its only consumer is `agent/pipeline-runner.js` — single-consumer packages fail the boundary test; (b) `p-limit` is **not declared in `backend/package.json`** — it resolves only as a transitive dependency of another package (present in `node_modules` at 3.1.0, absent from every manifest). Adopting it into the zero-dependency `@animastor/ai-agent` would import p-limit into a package whose doctrine is zero runtime deps, and would *legitimize* an undeclared transitive. Fixing the manifest is a one-line hygiene fix, not a decomposition reason.

**4.2.2 `services/share-events.js` (74 LOC).** Zero requires; pure payload builder + in-memory sink set. Technically formable as a micro-package, but: exactly **one** consumer (`routes/worker-routes.cjs`), the "sink" seam exists *inside the file itself* (`setSink`) rather than across a package boundary, and the event payload grammar is a worker-sharing V2 host contract awaiting a V3 notification consumer that does not exist yet. A package today would have one consumer, zero external API pressure, and 74 LOC — publication overhead without a boundary. Deferred until a second consumer (notification subsystem) actually appears; then it is a 30-minute extract with tests already pure.

**4.2.3 `image/prompt-builder.js` (406 LOC).** Previously floated as ADOPT INTO `@animastor/generation` (prompt-profiles orbit). Downgraded on measured couplings: it consumes `image/helpers.js`, which provides `getOutputPath` (→ `config.OUTPUT_DIR`, host config) *and* `normalizeForMatch`, which is implemented over the image tier's `sharp`-based normalizer (sharp is a backend-host dependency, not a generation-package dependency). Extraction would require either dragging `sharp` into `@animastor/generation` (a native/binary dependency into a pure package — a doctrine regression) or inventing a normalize port + a path port for a module whose three consumers all live in the same host tier. The coupling is real but *tier-local*; the boundary gain is negative.

**4.2.4 `workflows/video/video-workflows.js` (649 LOC).** Previously ADOPT-WITH-SEAM-WORK. Measured couplings now include: `services/profile-override` (Redis-backed singleton, primed at route registration — §4.2.8), `utils/string-utils.getOutputPath` (host config), **three module-level `process.env` reads** (`VIDEO_FPS`, `LTX_FRAME_ALIGN`, `VIDEO_CHUNK_MAX_SEC` — read once at require time, i.e. load-order-sensitive host config), one lazy PG `query` fallback (frame-refs), and `generation.ports.bookData` consumed as a *global reach-in* rather than an injected port (the S-7 port is bound in backend.cjs and read at call time — adopting the file would pull the host's port-object identity into the package). Seam work = 5 ports for 2 consumers. The boundary produced would be thinner than the ports it needs.

**4.2.5 `audio/` pure core (segments/silence/ffmpeg-grammar/chunks/validation, ~860 LOC).** The previously identified blocker persists and is structural: `audio/helpers.js` re-exports `getOutputPath` from `utils/string-utils` (→ `config.OUTPUT_DIR`), so *every* segment/chunk/silence/validation module inherits a host-config path reach-in; `chunks` and `validation` also consume `generation.artifactNaming` as a global, and `validation` calls `music-metadata` (host dep, call-time) against files on the host OUTPUT_DIR. The genuinely pure remainder (`splitTextIntoChunks`/`splitDialogueIntoChunks` in `segments.js`) is ~80 LOC inside a 363-LOC file — sub-threshold for adoption, and its home grammar (`estimateSpeechDurationSec` contract) already lives in the generation dirty-grammar package.

**4.2.6 `utils/string-utils.js` (31 LOC).** Two functions with opposite coupling: `escapeRegExp` is pure and already has a byte-parity twin in `@animastor/generation/src/utils/escape-regexp.js` (guarded by G7-M), while `getOutputPath` reads `config.OUTPUT_DIR`. The file cannot move as a unit; splitting it yields two micro-fragments with no package home (the pure half is *already mirrored* in the package; the host half is host by definition). **Low-value cleanup option:** re-point the 3 consumers' `escapeRegExp` import to the generation package and delete the host duplicate — cosmetic churn, no boundary change.

**4.2.7 Compatibility shims — bookkeeping, not extraction.** Verified inventory with exact consumer counts: `book/` 15 files→vbook-runtime (backend.cjs itself, `routes/book/export-routes`, `routes/book-routes`, `agent/bootstrap`, `agent/pipeline-runner`, `agent/pipeline-steps`, `agent/text-utils`, `agent-prompts`, `placeholder-audio`, `source-coverage-audit`, `txt-importer`), `editor/index.cjs` (1: `routes/book-routes`), `contracts/runtime-result.js` (**0 production src consumers — only 2 architecture tests**), `runtime/job-schema.js` (4 src consumers), `state/scene-state.js` (1: `state/index.js`), `state/index.js` (3), `services/language-detector.js` (1: `agent-prompts`), `services/ai-agent/index.js` (1: `pipeline-steps`), `utils/` 3 one-liners (1 each). These are intentional §2.4-pattern facades; their retirement is consumer re-pointing + deletion (LOW, hygiene). Not extraction in any sense — the packages already exist.

**4.2.8 `services/profile-override.js` (123 LOC).** Redis-backed singleton: `setRedis(redis)` is called at connector-route registration and the cache is primed asynchronously from `animastor:prompt-profiles`; reads are synchronous at assembly time *because of* the primed singleton. Resolution policy depends on `animastor-comfyui-workflow-connector.workflowLoader` disk state. Six consumers across four tiers. Moving it would relocate a stateful singleton, not extract a domain; the generation package deliberately models this surface as a port instead.

**4.2.9 `metrics/prometheus.js` (274 LOC).** Aggregates host counters from `generation.mediaRegistry` and is consumed by exactly the composition root and the runtime loop. Metrics registries are deployment-plane by nature; a package would invert the dependency (package would need host counters as ports) for no second consumer.

**4.2.10 AI-provider plane (~3,470 LOC).** Three independent, individually sufficient reasons: (a) the `system-ai ⇄ workspace-ai-provider` SCC (§5.1) with shared crypto helpers; (b) 12 `process.env` reads across the plane (workspace secret key, OpenRouter keys, AI_DIR, AI_CACHE_TTL) including module-level; (c) 5 lazy PG sites and 5 route files consuming it; (d) `ai-loader`/`knowledge-base` own the host `backend/ai/**` *content* contract (prompt files are host data, not package data). The plane is the host half of the provider contract until a contract-first gateway is built — a product decision, not a refactor.

**4.2.11 Ingest/agent pipeline (~5,300 LOC).** The host executor of the AI-analysis contour: PG session/step bookkeeping (`agent-session` direct SQL, `agent/ai-caller` direct `pg` query + AsyncLocalStorage), PG+Redis cancellation flags, config-driven windowing, prompt-content loading via `ai-loader` (host `AI_DIR`), and generation dispatch into orchestration. Everything pure in this pipeline has already been extracted (tasks → ai-analysis, coverage → parser, estimation → generation dirty-grammar). What remains is the executor the packages are injected *into*.

**4.2.12 `services/workflow-manager.js` (557 LOC).** API-facing wrapper over the connector package's loaders, including hot-reload against host-fs connector JSON and UI-shape projection for a single route consumer. All domain logic it exercises is already in `animastor-comfyui-workflow-connector`; what's left is presentation + fs, i.e. host.

**4.2.13 Storage tier (~7,300 LOC).** `postgres-host-infrastructure` doctrine: schema and repos are host doctrine files; identity repos already sit behind `@animastor/auth` ports. The 9 O-port adapters (`audio-fsm-adapter`, `video-fsm-adapter`, `hub-cancel-adapter`, `layer-config-adapter`, `placeholder-audio-adapter`, `progress-events-adapter`, `scene-data-adapter`, `runtime-persistence-adapter`, + `asset-registry`) are *the concrete implementations of `@animastor/orchestration` ports* — by construction they belong to the host. `filesystem-store` wraps `generation.artifactNaming` + `config.OUTPUT_DIR`. Moving any of these relocates host internals without creating a boundary.

**4.2.14 Worker domain core (~1,200 LOC).** The Redis key grammar (worker auth mirrors, ownership, heartbeats) is contractually shared with the GPU Hub and frozen by `gpu-hub-contract.test.js` / `phase2-redis-ownership-contract.test.js`. Extraction would require re-negotiating a frozen cross-system contract to move ~500 LOC of policy with 4 host consumers. Negative expected value.

**4.2.15 Composition/root plane (~5,600 LOC).** `backend.cjs` (fan-out 76, binds all 23 `@animastor/*` surfaces before packages load — measured), `config/runtime-config` (the env epicenter, 18 reads), `runtime/runtime-loop` + `gpu-dispatcher` (PW-2 policy + hub HTTP transport), `helpers/redis-helpers` (book/runtime-specific Redis grammar incl. lazy requires into book/orchestration), `state/asset-state-store` + `event-journal` + `scene-state-ops` (Redis/PG FSM persistence legs), `book-deletion` (7-step cancellation cascade composing host adapters), `task-handler` (media executor composition), `book-sync` (SQL auditor), `book-diff` host half (Redis chunk grammar + FSM transitions), `cleanup-service`, `entity-cleanup`, `startup-resume` (PG repos). All are wiring/transport/doctrine by design — the destination of extractions, not extraction candidates.

---

## 5. Remaining SCC / cycles

### 5.1 File-level SCC (measured — exactly one)

```
services/system-ai.js  ⇄  services/workspace-ai-provider.js
```

`workspace-ai-provider.js:184` lazily requires `system-ai` (call-time); `system-ai.js` lazily requires `workspace-ai-provider` at 4 sites (`decryptSecret`, `maskKey`, `encryptSecret`, `normalizeProviderType`). Statically a real SCC; at runtime safe due to call-time resolution. **Substance = the shared crypto/helper seam.** This is the only cycle blocking the AI-provider plane, and the plane has independent host-bound reasons (§4.2.10), so breaking it has no standalone extraction value today. If the plane is ever revisited: move the 4 crypto helpers to a leaf module first — that dissolves the SCC mechanically.

### 5.2 Domain-level near-cycles (no file SCC, verified by edge census)

- **`services ⇄ media tiers` via `profile-override`:** `video/video-merge`, `audio/generation`, `image/iu-processor` require `../services/profile-override` upward, while `services/audio-orchestrator` lazily requires `../audio/chunks` and `services/video-orchestrator` requires `../video/video-merge` downward. The media tier is one SCC-shaped cluster *by composition* (executors + shared profile seam). This is why §4.2.3–4.2.5 downgraded the media adoptions: any single-module extraction leaves the cluster intact.
- **`storage/index.js` barrel → services:** the barrel re-exports 5 domain services (`bookEventLog`, `bookSource`, `bookSync`, `layerConfig`, `genScope`) that live under `storage/` and themselves require postgres+config. **Exactly one production consumer remains (`backend.cjs:187`).** Synthetic cycle-maker; dissolving it is a one-file LOW cleanup that removes the only storage→services synthetic edge.
- **`state → storage/postgres`:** `state/scene-state-ops.js:63` lazily requires `scene-assets-repo` (PG sync leg). Lazy, one-directional, no return edge — not a cycle.

### 5.3 Lazy requires (documented, intentional)

`system-ai`↔`workspace-ai-provider` (§5.1), `scene-state-ops`→asset-state-store/PG, `redis-helpers`→book/gpu-dispatcher/orchestration runtime, `window-generator`→progress-pubsub, storage adapters→services (all call-time, cycle-breaking by design in the O-port layer).

---

## 6. Duplicate / legacy / stale findings (post-extraction sweep)

| Check | Result |
|---|---|
| `require` of `services/url-safety`, `services/source-coverage`, `services/encoding-detect`, `services/prompt-dependency-registry`, `utils/scene-hash`, `utils/speech-estimation`, `utils/cyr-latin-map`, `ai-agent/tasks/*`, host `dependency-graph` in **production src** | **ZERO. All clean.** No stale imports of any extracted module remain. |
| Same paths in **tests** | Only intentional, correct references: `url-safety-package-boundary.test.js` *asserts the host file does not exist*; `editor-extraction-readiness`/`editor-package-boundary` reference cyr-latin-map only in comments/docs of the parity guard; `phase7` references `source-coverage-audit` (a host file that legitimately remains); `assistant-package-boundary` lists `services/url-safety` among *forbidden* paths. No stale test pins. |
| Literal `backend/src` strings in src | 11 files — **all in comments** (path documentation, adapter docs, shim explanations). No path-building or dynamic requires off them. |
| Host `cyr-latin-map` duplicate | Deleted at adoption; parity guard re-pointed to canonical `dirty-grammar/cyr-latin-map.js` (verified). |
| `escapeRegExp` duplicate | Host `utils/string-utils` vs package `utils/escape-regexp` — **known, guarded twin** (G7-M byte-parity). Listed as low-value cleanup (§4.2.6), not a defect. |
| `p-limit` | Used by host code, **declared in no manifest** — resolves transitively. Hidden-dependency hygiene finding (§4.2.1); no functional issue today. |
| Relative requires escaping into `packages/` from src | **ZERO** (all cross-boundary consumption goes through `@animastor/*` specifiers). |
| Dead production files | None found. The stale ai-agent task copies, ports.js, context.js were already deleted; every remaining src file has ≥1 live consumer (weakest: `contracts/runtime-result.js` — src-consumer-free, kept only for 2 architecture tests + facade doctrine; see §4.2.7). |

---

## 7. Package-boundary & dependency-direction verification (extracted packages)

Reverse-dependency scan over all 30 package trees (src+tests, pattern-matched, then **manually verified each hit is a comment/doc line, not a require**):

| Package | Host require found? | Notes |
|---|---|---|
| `@animastor/ai-agent`, `ai-analysis`, `ai-connector`, `auth`, `installer`, `parser`, `vbook-runtime`, all 15 `web-*` | **NO** | clean |
| `@animastor/assistant` | **NO** | 5 matches — all doc comments in the ports-contract files describing the host-side binding |
| `@animastor/comfyui-workflow-connector`, `worker`, `gpu-hub` | **NO** | comment-only matches |
| `@animastor/contracts` | **NO** | comment-only |
| `@animastor/editor`, `player`, `orchestration` | **NO** | `orchestration/src/host/host-bindings.js` *documents* the host modules bound into it — via injected parameters, no requires |
| `@animastor/generation` | **NO** | matches are `dirty-grammar/*` file headers ("backend/src/..." provenance comments) and the G7-M parity-guard doc comment |
| `@animastor/parser` | **NO** | provenance comments in `source-coverage.js`/`encoding-detect.js` headers |
| `@animastor/url-safety` | **NO** | zero runtime deps; node-builtins only; call-time `dns` (USB guards live) |
| `@animastor/web-workers` | **NO** | comment-only |

Cross-package dependency direction (verified via require census of `packages/*/src`):

```
ai-analysis → ai-agent, vbook-runtime
editor      → vbook-runtime
player      → vbook-runtime
vbook-runtime → parser
generation  → contracts
gpu-hub     → contracts
orchestration → contracts, generation
(assistant self-reference in grep is its own internal surface; no external edge)
```

**No package pulls the host back in; no cycles between packages.** The dependency direction doctrine (`host → packages → contracts`; packages never reach into `backend/src`, `process.env`, or host stores) holds across the board. `@animastor/url-safety` — the newest package — is the cleanest of all: zero npm deps, node-builtins only, ports injected via `setUrlSafetyPorts`, host copy deleted.

---

## 8. Low-value cleanup list (explicitly NOT packages)

Worth batching as a hygiene pass someday; none justifies a package or a decomposition step:

1. **Dissolve `storage/index.js` barrel** (1 consumer: `backend.cjs:187`) — removes the synthetic storage→services edge (§5.2).
2. **Retire one-line shims with single consumers** where the §2.4 grace period is over: `state/scene-state.js`+`state/index.js`, `services/language-detector.js`, `services/ai-agent/index.js`, `utils/{snake-guard,scene-title-utils,character-identity}.js`, `contracts/runtime-result.js` (0 src consumers — retire after moving the 2 test pins to the package path), `book/` subtree consumer-by-consumer (backend.cjs still uses `./book`).
3. **Re-point `escapeRegExp` consumers to `@animastor/generation`** and split `getOutputPath` into the two `audio/helpers`/`image/helpers` locals — removes the host/package twin (§4.2.6).
4. **Declare `p-limit` in `backend/package.json`** (or drop it by inlining a 10-line concurrency cap in `parallel-analysis-orchestrator`) — removes the hidden transitive dependency.
5. **`share-events.js`** — revisit as a micro-extract *only when* a second consumer (V3 notification subsystem) materializes (§4.2.2).

---

## 9. Final decomposition map

```
                    ┌──────────────────────────────────────────────────┐
                    │              BACKEND HOST (terminal state)       │
                    │ backend.cjs (root, fan-out 76, binds 23 pkg      │
                    │              surfaces) · config (env epicenter)  │
                    │ routes/ (HTTP contour) · middleware/             │
                    │ runtime/ (loop, gpu-dispatcher, seams)           │
                    │ storage/ (schema, 17 repos, 9 O-port adapters,   │
                    │           fs/redis legs)                         │
                    │ services/ agent pipeline executor · AI-provider  │
                    │           plane (last SCC) · worker-auth ·       │
                    │           book-state legs · workflow-manager     │
                    │ audio/ image/ video/ workflows/ (media executors)│
                    │ state/ helpers/ metrics/ · shims (§4.2.7)        │
                    └──────────────────────────────────────────────────┘
                        │ ports bound at composition root; zero reverse edges
                        ▼
   ┌────────────────────────────────────────────────────────────────────┐
   │ @animastor/* — 14 domain/mechanism packages + worker/connector/web │
   │ contracts ← generation, gpu-hub, orchestration                     │
   │ parser ← vbook-runtime ← ai-analysis, editor, player               │
   │ ai-agent ← ai-analysis                                             │
   │ generation · orchestration · assistant · auth · installer ·        │
   │ url-safety (zero-dep) · gpu-hub · ai-connector · worker · web-*    │
   └────────────────────────────────────────────────────────────────────┘

   HOST-BOUND FOREVER (by doctrine, verified §4.2): postgres schema+repos ·
   O-port adapters · runtime loop/gpu-dispatcher/seams · config doctrine ·
   Redis grammars (helpers, book-diff host half, gen-scope, event-journal) ·
   HTTP routes · middleware shells · agent pipeline executor · AI-provider
   plane (SCC + env + PG + host prompt content) · worker-auth (frozen hub
   key-grammar contract) · media executors (profile-override singleton
   cluster) · book-deletion cascade · metrics registry
```

---

## 10. Final verdict

**Есть ли ещё осмысленная физическая декомпозиция? — Нет. Extraction phase фактически завершена.**

- The strongest remaining evidence for this is the *quality* of the rejects: the two purest files left (`parallel-analysis-orchestrator`, `share-events`) fail on consumers/ownership, not on coupling; the media-tier "adoptions" left over from the previous audit fail on *measured* couplings (sharp, env, Redis singleton, global port identity) that extraction would relocate rather than remove.
- The single remaining SCC is a two-file lazy-require pair whose substance (4 crypto helpers) is the only seam left in the entire host, and it gates a plane that is host-bound for four other reasons.
- No stale imports, no unresolved duplicates, no reverse dependencies, no hidden host coupling in packages — the boundaries created by the extraction phase are clean and holding.
- Remaining work in `backend/src` is **hygiene** (§8: barrel, shims, twin helper, one undeclared dep) — cumulative value is a slightly smaller, slightly cleaner host, not a new boundary. None of it is worth an npm package.

Recommendation: close the physical-decomposition workstream on this branch. Future decomposition (AI-provider plane contract-first gateway, worker/hub key-grammar renegotiation, share-events V3) should be driven by product decisions, at which point the seams documented in §4.2.10/§4.2.14/§4.2.2 are the entry points.
