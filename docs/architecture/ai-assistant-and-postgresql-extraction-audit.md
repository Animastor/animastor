# AI Assistant & PostgreSQL Extraction Audit — Architectural Reconnaissance

**Status:** READ-ONLY audit / reconnaissance. No production code changed, no files moved, no package skeleton created, no refactoring, no API/route/contract/runtime changes.
**Update (A-1…A-5, same date):** the Assistant preparation recommended by this audit (§3.5/A-1…A-5) has since LANDED as a behavior-neutral commit ("arch(assistant): prepare extraction boundary"): chat-session repository + AssistantPorts seam + purgeForBook de-coupling + assistant-contour guard suite. See `docs/architecture/ai-assistant-extraction-preparation.md` for the landed seams, eliminated dependencies, remaining blockers and the physical-extraction checklist.
**Date:** 2026-09-10
**Baseline:** HEAD `d0bf6058` ("fix(generation): close s4 core host-boundary gaps") — with the caveat that the working tree additionally carries **uncommitted in-flight work** by another coder (S-5-style `event-journal` relocation `orchestration/ → state/`, `runtime/orchestration-seams.js`, guard-test updates). That in-flight work is **Generation-domain cycle unwinding**, not Assistant/Database work; it does not change any conclusion below but is flagged where relevant.
**Method:** static require-graph tracing over `backend/src/**`, `frontends/app/src/**`, `frontends/android/**` (source only, no build artifacts), `packages/**`; route registration audit (`backend.cjs`); PG repository/table audit (`storage/postgres/**`, `schema.js`); cross-checked against `generation-module-extraction-reconnaissance.md`, `PHASE_NEXT_MODULE_EXTRACTION_RECONNAISSANCE.md`, `MODULAR_PRODUCT_ARCHITECTURE.md` (§24/§28/§29/§30), `editor-module-extraction-audit.md`, `ai-analyzer-boundary-c17.md`, `ai-agent-contour-extraction-c21.md`, `navigator-module-extraction-audit.md`, guard tests (`tests/architecture/*`). Where docs and code disagree, **the code wins**.

**Question this audit answers:** *"Which extraction — AI Assistant or PostgreSQL/Database layer — gives the maximum monolith-coupling reduction as the next step after Generation, and where does the real boundary run?"*

---

## 1. Executive Summary

**AI Assistant** is a **thin, well-anchored product feature**, not a domain subsystem: 2 frontend pages/components (web + Android parity twins), one backend route file (`ai-routes.cjs`, 1331 LOC), one engine service (`chat-engine.cjs`, 549 LOC), one auth middleware (`ai-book-guard.js`), one PG table family (`ai_chat_sessions`), and a file-based persona profile. Its **transport, provider resolution, and persistence are already borrowed seams**: it consumes the Provider Gateway (`provider-gateway.js`), the connector shared pool (`ai-connector/shared-pool.js`), `ai-service.callAI`-adjacent transport code, `bookModel.loadBook`, and `chatEngine.applyPatchesValidated` → `book.saveBookBundle`. The Assistant **mutates the Book domain** (JSON-patch `edit_book` tool with bundle-contract validation) and is a declared **parallel writer** in the Editor extraction audit. It is small (≈2,600 backend LOC of chat-specific code), has an existing frozen HTTP contract (`/api/v1/ai/*` + SSE protocol with meta/delta/done/error frames, guarded by `tests/architecture/chat-transport.test.js`), zero Redis coupling of its own, and **one dominant hard dependency: the Book/VBook domain (read + write)**.

**PostgreSQL layer** is the opposite shape: it is **not a product module at all — it is infrastructure**, and it is *already deliberately layered*: a single pool factory (`storage/postgres/database.js`, 42 LOC, single `pg.Pool`, env-config), one migrations/schema owner (`schema.js`, 1809 LOC, 30+ tables), 16 repositories (~3,715 LOC), and a **frozen SQL boundary guardrail** (`tests/architecture/sql-boundary.test.js`) whose direct-handle whitelist (17 files at freeze time, now 15+) only shrinks. PG is the declared "canonical persistent truth" (decision D4). 52 backend files reference PG; 50 test files touch PG; the extracted packages (`player`, `editor`, `vbook-runtime`) already receive PG **only via injected repositories** — the ports/adapters pattern is *already implemented* at the package boundary.

**Key asymmetry:** extracting PostgreSQL would **not reduce monolith coupling** — it would relocate it (the coupling is *business SQL knowledge*, which must stay with business modules; the mechanical client is already one file). Extracting AI Assistant **would** remove a whole user-facing contour (routes + engine + UI + its own table) from the host — but its value is bounded because Assistant *is* mostly a consumer of already-extracted/composition-owned seams, and its Book-write leg is an Editor-adjacent contract change.

**Verdict (short):** **Neither is the highest-leverage next extraction on its own terms — but of the two, AI Assistant is the correct next target (READY AFTER PREPARATION, complexity Medium), while PostgreSQL should NOT be extracted as a product package (NOT A GOOD EXTRACTION TARGET as a module; the already-running "shrink the SQL whitelist" debt track is the right PG work).** Recommended sequencing: finish the in-flight Generation seam work → close the small Assistant seam list (§11) → extract `@animastor/assistant` (chat service package, host keeps routes/HTTP shell) → continue SQL-whitelist shrink (Phase-3 debt) in parallel. Full matrix in §7, lists in §16.

---

## 2. Current Architecture (as measured at HEAD)

### 2.1 Extracted packages (do not re-extract)

| Package | Physical home | Boundary type |
|---|---|---|
| `@animastor/contracts` | `packages/animastor-contracts` | wire contracts (Job Protocol v2) |
| `@animastor/vbook-runtime` | `packages/animastor-vbook-runtime` | Book Model / bundle domain |
| `@animastor/parser` | `packages/animastor-parser` | text parsing core |
| `@animastor/ai-connector` | `packages/animastor-ai-connector` | Local AI Connector (LAC, WS) |
| `@animastor/comfyui-workflow-connector` | `packages/animastor-comfyui-workflow-connector` | workflow JSON connector |
| `@animastor/worker` | `packages/animastor-worker` | GPU worker |
| `@animastor/gpu-hub` | `packages/animastor-gpu-hub` | queue dispatcher (Redis-only, **no PG**) |
| `@animastor/editor` | `packages/animastor-editor` | edit HTTP contour + model |
| `@animastor/player` | `packages/animastor-player` | playback HTTP contour |
| `@animastor/navigator` | `packages/animastor-navigator` | web UI navigation tree |
| `@animastor/file` | `packages/animastor-file` | web UI file panel |
| `@animastor/ai-agent` | `packages/animastor-ai-agent` | fail-closed host-port mechanism (C21) |
| `@animastor/ai-analysis` | `packages/animastor-ai-analysis` | analysis tasks (structure/characters/…) (C21.1) |

**Generation** is the *current* work: a documented ~14-module SCC, seam phase S-1…S-4 landed (AgentSessionControl port, media registry, provider transport seam, shared core moves); S-5 (orchestration⇄runtime cycle unwind) is visibly in-flight in the uncommitted working tree. Its reconnaissance verdict was **NOT READY → seam phase first**.

### 2.2 The three storage layers (decision D4)

- **PostgreSQL** — canonical persistent truth: scene state/versions, books/snapshots, users/workspaces/sessions, workers, AI connectors/endpoints, `agent_sessions` (VBook generation), `ai_chat_sessions` (assistant chat), events. One pool, `pg@8.13`, env `PG_HOST/PG_PORT/PG_DB/PG_USER/PG_PASSWORD` (`database.js:4-12`, docker-compose `POSTGRES_*` → `PG_PASSWORD`).
- **Redis** — runtime transport (queues, leases, heartbeats, pubsub); never authoritative.
- **Filesystem** — immutable artifacts (`data/`, `OUTPUT_DIR`), book bundles (`BOOKS_DIR`), AI persona/rules/skills markdown (`backend/ai/**`, env `AI_DIR`).

### 2.3 The AI surface — four distinct things that must NOT be conflated

| Thing | Where | What it is |
|---|---|---|
| **AI infrastructure — transport** | `services/ai-service.js` (656), `services/ai-connector/*` (registry/transport/shared-pool/discovery), `services/url-safety.js` | provider-agnostic LLM call machinery (OpenAI-compatible HTTP + LAC connector WS branch) |
| **AI infrastructure — provider resolution** | `services/provider-gateway.js` (173, facade), `services/workspace-ai-provider.js` (754), `services/system-ai.js` (kill switch + system provider) | which provider serves a workspace/book; C8 contract |
| **AI analysis pipeline (VBook generation)** | `services/agent/**` (4,633 LOC), `services/ai-agent/`→`@animastor/ai-agent`+`@animastor/ai-analysis` (extracted), `agent_sessions`/`agent_messages`/`agent_conversations` tables, `txt-importer`, `window-generator` | the LLM book-authoring pipeline; part of the **Generation/VBook** domain, C17/C19/C20/C21 |
| **AI Assistant (chat product)** | `routes/ai-routes.cjs`, `services/chat-engine.cjs`, `middleware/ai-book-guard.js`, `ai_chat_sessions` table, `AiAssistantPage.tsx` / `AiAssistantFragment.kt`, `ai/ai-assistant-profile.md` | the user-facing conversational assistant with `edit_book` tool |

**The C17/C18/C19/C20/C21 documents and the extracted `ai-agent`/`ai-analysis` packages belong to the *third* row (analysis pipeline). The Assistant has NEVER been part of any of those extractions** — `assistant` appears in the C17–C21 lineage only as a persona string in prompts. This audit is the first time the Assistant is examined as its own contour.

---

## 3. AI Assistant Boundary

### 3.1 The complete Assistant surface (measured)

**Frontend (web):**
- `frontends/app/src/pages/AiAssistantPage.tsx` (642 LOC) — route `/ai` (`main.tsx:52`) + embedded desktop dock (`AppShell.tsx:285`, header AI-chip). Session list, mode chips (6 modes: conversation/edit live; import/director/extraction/validation `soon`), position-context bar, voice input (Web Speech), streaming bubbles with `ai_source` badge, markdown renderer.
- `frontends/app/src/features/aiChat/chatStream.ts` (52 LOC) — pure SSE-contract→UI mapping (`sourceBadgeKey`, `streamErrorKey`, `isUserCancelled`).
- `frontends/app/src/state/resourceInvalidations.ts` — the Assistant **produces** EXTERNAL book invalidations (its motivating case, file header) and consumes them to refresh the position bar.
- Consumer-side read of shared stores: `generateStore.bookId`, `positionStore.position`, `fileStore` (comment: 7 consumers incl. AiAssistant).

**Frontend (Android, parity twin — code-shared: NO):**
- `AiAssistantFragment.kt` (823 LOC), `AssistantMode.kt` (72), `AiChatModels.kt`, `BackendApi.kt` (`/ai/chat`, `/ai/sessions*`, `:id/messages`, PATCH rename, DELETE — the same HTTP contract).

**Backend:**
- `routes/ai-routes.cjs` (1331 LOC): `GET/POST/PATCH/DELETE /api/v1/ai/sessions`, `GET /api/v1/ai/sessions/:id(/messages)`, `POST /api/v1/ai/chat` (non-streaming), `POST /api/v1/ai/chat/stream` (SSE: `meta`/`delta`/`done`/`error` frames, heartbeats, cancel-on-disconnect, think-tag filter, tool-call extraction from content, patch application, session persistence of failed turns).
- `services/chat-engine.cjs` (549 LOC, factory `(config) => api`): `MODE_PROMPTS`/`TOPIC_PROMPTS`, `buildChatSystemPrompt` (identity/mode/topic/position/language), `buildBookContext` (full book JSON into system message) + `buildCompactBookContext` (32 KB connector budget fallback), `getToolsForMode` (only `EDIT_BOOK_TOOL` in edit mode), `parseAIResponse`, JSON-Patch `applyPatches`/`applyPatchesValidated` (+ `normalizeBookParticipants` deterministic guard) — **imports `book/bundle-validator.cjs` (VBook domain)**.
- `middleware/ai-book-guard.js` (79 LOC): book-scoping authz for the whole `/api/v1/ai` surface; sets `req.scopedBookId`; direct PG read of `ai_chat_sessions.book_id`.
- PG table `ai_chat_sessions` (schema.js:600; `messages` JSONB array = the whole history; `book_id`, `mode`, `topic_id`, `title`, `context`, `locked`).
- Filesystem persona: `backend/ai/ai-assistant-profile.md` (env `AI_PROFILE_PATH`), loaded by `chatEngine.loadSystemPrompt` (legacy fallback only).
- Reverse deps into the Assistant: `book-deletion.cjs:157` and `routes/book/cache-routes.cjs:89` **delete** `ai_chat_sessions` rows on book purge/cache-clear (they reference the table by name in a purge list — table-name coupling, not module coupling).

### 3.2 What is genuinely Assistant-owned

1. Session CRUD + history semantics (messages array merge, failed-turn persistence).
2. Prompt persona/mode/topic/position assembly (`buildChatSystemPrompt`).
3. The `edit_book` tool contract (tool definition + patch application pipeline + honest result messages).
4. SSE chat transport behaviors at the route level (meta/delta/done/error contract, heartbeat, cancel) — **frozen by `tests/architecture/chat-transport.test.js`** (Phase-1 guardrail: chat transport must stay separate from `callAI`).
5. The web/Android chat UI surfaces.
6. The `ai_chat_sessions` table + its guard read.

### 3.3 What is shared AI infrastructure (must NOT move with Assistant)

- `provider-gateway.js` (C8), `workspace-ai-provider.js`, `system-ai.js` (kill switch) — provider resolution, consumed by 10 files (admin/generation/settings/ai routes, txt-importer, agent bootstrap, system-ai, provider-gateway).
- `ai-service.js` — agent-pipeline transport (`callAI`, non-streaming JSON, stream:false) — consumed by agent pipeline + gateway; the chat route uses it only for its `AI_API_BASE_URL` default (via chatEngine constant) — an *accidental* dependency, not a real one.
- `ai-connector/*` (registry/transport/shared-pool/discovery) — LAC + LLM-sharing machinery, shared with settings-ai-routes, ai-connector-routes, ai-endpoint-routes.
- `url-safety.js` `safeFetch` — shared SSRF guard.
- `@animastor/ai-agent` / `@animastor/ai-analysis` — analysis-pipeline packages; **the Assistant does not use them at all** (verified: zero requires of `@animastor/ai-*` in `ai-routes.cjs`/`chat-engine.cjs`).

### 3.4 AI Assistant dependency graph (direct, measured)

```
┌─────────────────────────── AI ASSISTANT CONTOUR ────────────────────────────┐
│ AiAssistantPage.tsx (route /ai + AppShell dock)                              │
│   ├── api/client (getJson/postJson/deleteJson/postChatStream)  [host seam]   │
│   ├── state: generateStore.bookId, positionStore, resourceInvalidations      │
│   ├── features/aiChat/chatStream.ts (pure)                                   │
│   └── api/models.ts: AiChatResponse/ChatSessionApi/SessionMessageApi          │
│                                                                              │
│ POST /api/v1/ai/chat(/stream) ── aiBookGuard (book scoping, PG read)         │
│   ├── resolveChatAI → providerGateway.chat.resolveProvider  [C8 seam]        │
│   │     └── workspace-ai-provider → PG (workspace_ai_providers)              │
│   │           └── ai-connector/shared-pool (selectSharedAI, PG endpoints)     │
│   ├── chatEngine (factory):                                                  │
│   │     ├── book/bundle-validator.cjs  [VBook DOMAIN — validate patches]    │
│   │     ├── fs: ai/ai-assistant-profile.md  [AI persona, env override]       │
│   │     └── (prompts/context builders — pure)                                │
│   ├── bookModel.loadBook(bookId, lazy)  [VBook Runtime read]                 │
│   ├── edit_book tool → chatEngine.applyPatchesValidated                     │
│   │     → book.saveBookBundle (or targeted fs.writeFileSync fallback)        │
│   │       [VBook DOMAIN WRITE — parallel writer to Editor, Editor-audit R5]  │
│   ├── connector branch → sharedPool.runSharedInference (SSE, slots, cancel) │
│   ├── cloud branch → safeFetch(baseUrl/chat/completions) [url-safety]        │
│   └── PG: ai_chat_sessions CRUD (16 storage.postgres.query call sites)      │
└──────────────────────────────────────────────────────────────────────────────┘
Reverse deps (host → assistant table):
  book-deletion.cjs / routes/book/cache-routes.cjs: purge lists include
  'ai_chat_sessions' (table-name references)
  frontends: resourceInvalidations (Assistant produces book-invalidation events)
  EditPage/GeneratePage/playbackStore consume those invalidations (generic)
```

### 3.5 Hidden / transitive dependencies (Assistant)

| # | Dependency | Kind | Severity |
|---|---|---|---|
| H1 | `chat-engine → book/bundle-validator.cjs` | VBook domain contract | **Blocker** for a pure package (by design — patch validation must use the canonical contract; solvable via injected port like Editor's) |
| H2 | Route → `book.saveBookBundle` + `lazyBook.getBookDir` + `fs.writeFileSync` fallback | VBook domain write + filesystem | **Blocker** (parallel-writer contract; Editor audit already pinned this: "Stays host-side; pin, don't migrate now") |
| H3 | Route → `bookModel.loadBook` (lazy Book Model facade) | VBook read | Port candidate (Editor/Player already show the pattern: `editorModel: createEditorModel({ bookModel, persistBook })`) |
| H4 | `chatEngine.AI_API_BASE_URL` default `integrate.api.nvidia.com/v1` vs `ai-service` default `aicredits.in/v1` | config divergence, documented (EXPERIMENTAL_BETA P1-7) | Cosmetic; should resolve through the gateway, not a local constant |
| H5 | `ai-book-guard` direct PG (`ai_chat_sessions`) + `auth-context.checkBookAccess` | authz + PG | Fine inside host; a package would need a port |
| H6 | Session-id generator in route module state (`sessionIdCounter`) | global mutable state (process-local) | Trivial, moves with the route |
| H7 | `system-ai` kill switch consult via `ai-service`/resolver chain | governance | Port (resolveProvider output already encodes it) |
| H8 | Assistant invalidation events (`emitExternal(bookResource)`) | frontend event-bus contract | Stays host (the bus is app infrastructure; the Navigator audit froze this pattern) |
| H9 | `ai/ai-assistant-profile.md` filesystem + `AI_DIR` ecosystem (rules/skills/profiles) | config/fs | The profile file is Assistant's; the loader (`ai-loader.js`) is shared with generation prompts — port or copy |
| H10 | `frontend voice input` (Web Speech API) | browser capability | UI-internal |

**Cycles:** none. The Assistant is a leaf consumer: nothing in the host requires `ai-routes`/`chat-engine` back (reverse deps are two purge-list table names + the frontend event bus). `chatEngine ← provider-gateway` is a *comment-only* reference (gateway does not require chat-engine; it documents that the chat default base URL lives there).

### 3.6 Assistant: MOVE / STAY / PORT / BLOCKER (detailed lists in §16)

- **MOVE (candidate package `@animastor/assistant`):** `chat-engine.cjs` (after porting bundle-validator + persist), session repository logic (SQL for `ai_chat_sessions` → injected `sessionRepo` port), prompt builders, tool definitions + patch pipeline, SSE frame semantics (as a service API, not the HTTP route), `chatStream.ts` + page UI (frontend pattern: like Navigator/File — Preact module over ports), `ai-assistant-profile.md`, Android stays parity-contractual.
- **STAY host-side:** HTTP route registration (`ai-routes.cjs` shell or a thin `createAssistantRoutes(app, deps)` in the package with ports — Player/Editor precedent allows moving the route file into the package once ports exist), `ai-book-guard` (authz is host), provider resolution chain (Gateway C8), connector/shared-pool, `ai-service`, invalidation bus, session-id env.
- **PORT candidates:** `loadBook` (lazy read), `persistBook` (`saveBookBundle` + targeted-save fallback), `validateBundleFile/Object`, `resolveChatAI` (already behind the gateway), `sessionRepo` (PG CRUD), `log` — mirrors the already-proven `editorPorts`/`playerPorts` composition in `backend.cjs:261-350`.
- **BLOCKERS (before extraction):** H1+H2 (Book write contract), the 16 inline `storage.postgres.query` call sites in the route file (SQL boundary guardrail requires a repo), and the `ai_chat_sessions` purge coupling (needs a `deleteSessionsForBook(bookId)` port so purge lists stop naming the table).

### 3.7 Is there a self-contained public API / package potential?

- HTTP contract exists and is stable (`/api/v1/ai/*`; SSE frame contract documented in-route and frozen by tests). Web+Android both consume it — that IS the contract.
- PG coupling: exactly one table (`ai_chat_sessions`), accessed inline in the route (16 sites) — thin and easily reposed.
- Redis coupling: **none** of its own (the `redis` arg is received and ignored; the connector liveness mirror in `ai-connector-routes` is shared infra).
- Generation coupling: **none** (no imports of generation/orchestration/runtime; the only proximity is that `generateStore.bookId` seeds the frontend context and `/worker/counts` reports `vbook` health separately).
- Editor/VBook/Parser coupling: **VBook read/write (the real one)**; Parser: none (the Assistant never parses; import-mode is `soon`/disabled).
- AI infra coupling: resolution+transport through documented seams (C8 gateway, shared-pool) — **these are exactly the kind of dependencies that ports/adapters absorb**.
- Test coverage: 6 backend suites exercise the chat route/engine (`ai-shared-stream`, `ai-shared-inference`, `ai-model-propagation`, `ai-connector-acceptance`, `workspace-ai-*`, plus `ai-patch-validation`, `ai-editor-mode`, `behavior-edit-book`, `ai-participants-doctrine`) — a package-owned test set is *assembled from existing tests*, not written from scratch (graduation checklist §26.5 satisfied more cheaply than VBook's case).

**Assistant verdict: READY AFTER PREPARATION — complexity Medium (≈2/5–3/5).** The prep is small and fully enumerable (§3.6/§16): port the Book read/write/validate, repo the session SQL, add the purge port, freeze a `AssistantPorts` contract. No cycles, no SCC membership, no Redis, one table, frozen HTTP contract, existing tests.

---

## 4. PostgreSQL Dependency Graph

### 4.1 The layer as it exists (measured)

```
business code (routes/services/runtime/orchestration/auth/middleware/image/video/workflows)
   │
   ├── sanctioned path ─────────────────► storage/postgres/repositories/* (16 repos, ~3,715 LOC)
   │                                        worker-repo 791 · scene-assets-repo 488 ·
   │                                        ai-connector-repo 438 · ai-endpoint-repo 412 ·
   │                                        guest 226 · gen-session 188 · events 163 ·
   │                                        workspace 151 · user 151 · book 136 ·
   │                                        book-source 129 · task 128 · session 120 ·
   │                                        iu 103 · generation-cancel 78
   │
   ├── frozen-debt path ─────────────────► storage/postgres/database.js directly
   │                                        (tests/architecture/sql-boundary.test.js:
   │                                        DIRECT_SQL_WHITELIST — 17 entries at freeze,
   │                                        S-1 already removed one; only shrinks)
   │
   └── extracted packages ────────────────► receive repos/pool ONLY via injected ports
                                            player (iuRepo via ctx) · editor (sceneAssetsRepo
                                            via editorPorts) · vbook-runtime (source-relation
                                            comment: "Managed by storage/postgres repositories")
                                            gpu-hub: NO PG AT ALL (Redis-only, verified:
                                            package.json deps = contracts+cors+express+ioredis)
                                            worker: NO PG (bundle + Job Protocol)
```

- **Client creation:** exactly one `new Pool(POOL_CONFIG)` in the codebase (`database.js:18`), max 20 conns, 30 s idle, 5 s connect timeout. `query()` checks out a client per call. No second pool. No per-module connections. No ORM. Raw SQL everywhere (parameterized).
- **Transactions:** `BEGIN/COMMIT` on checked-out clients in 7 files (auth-service, guest-repo, workspace-repo, ai-connector-repo ×3 blocks, ai-endpoint-repo ×2, events-repo) — all atomic-credential/policy operations, all **inside the layer already**.
- **Migrations:** `schema.js` `runMigrations()` — imperative, idempotent, 30+ tables, called by `storage/postgres/index.js initialize()` at boot (`backend.cjs:509`); graceful close at shutdown (`backend.cjs:744`).
- **Env/config:** `PG_HOST/PORT/DB/USER/PASSWORD` only, in one file; docker-compose maps `POSTGRES_*`→`PG_PASSWORD`. No PG URLs elsewhere.
- **Test infrastructure:** mocha suites run against a live PG (`tests/*.test.js` call `postgres.initialize()`; 50 test files touch PG; `.mocharc.json` binds `tests/vbook-test-bindings.cjs`). No pg-mem/testcontainers. This is a **host-owned** test convention.

### 4.2 Business module → PG map (who touches what, how)

| Module | Repository path (sanctioned) | DIRECT SQL (frozen whitelist debt) |
|---|---|---|
| **Generation (audio/image/video/runtime/orchestration/state)** | task-repo, gen-session-repo, scene-assets-repo, generation-cancel-repo, iu-repo, book-repo (via lazy requires in `gpu-dispatcher`), worker-repo | `image/iu-processor.js`, `orchestration/orchestrator.js` (+`scene-restoration.js`), `runtime/runtime-scheduler.js`, `runtime/scene-window.js`, `workflows/video/video-workflows.js`, `services/book-sync.js`, `services/placeholder-audio.js` — the version-gate / in-flight-marker / merge-leg reads |
| **VBook agent pipeline** | (agent tables have no repo: see direct) | `services/agent-session.js`, `services/agent-session-control.js` (port), `services/agent/ai-caller.js` (logConversation), `services/agent/bootstrap.js` (windows/cleanup), `services/system-ai.js` (kill switch), `services/workspace-ai-provider.js` (providers) |
| **AI Assistant (chat)** | none yet | `routes/ai-routes.cjs` (16 sites, via `storage.postgres.query` — repo-less but through the storage barrel), `middleware/ai-book-guard.js` |
| **Auth / Workspaces** | user-repo, session-repo, guest-repo, workspace-repo | `auth/auth-service.js` (transaction) |
| **AI Connector infra** | ai-connector-repo, ai-endpoint-repo | `routes/ai-endpoint-routes.cjs` |
| **Editor** | via `editorPorts.sceneAssetsRepo` (injected) | none (package clean) |
| **Player** | via `ctx.iuRepo` (injected) | none (package clean) |
| **Parser / VBook runtime** | — | none (package clean) |
| **Worker / GPU Hub** | — | **none — no PG at all** |
| **Book lifecycle** | book-repo, book-source-repo, events-repo; `book-deletion.cjs` + `cache-routes` purge via `storage.postgres.query` | (purge lists enumerate ~24 tables by name — a table-name coupling, repo-shaped debt) |

**Reading of the map:** Generation is the *heaviest* PG consumer (correctly — it owns task/asset/version truth); the agent pipeline is the biggest *repo-less* direct-SQL cluster; Assistant is small; the already-extracted packages are all clean **because the ports pattern was made a prerequisite of their extraction**.

### 4.3 Is there a PG layer boundary problem at all?

**Mostly no — by design.** The "layer" already exists inside the host (`backend/src/storage/postgres/**`, 5,583 LOC) with a frozen, shrinking direct-SQL whitelist and repo-per-domain organization. The question is only whether it should become an npm package. Options:

| Option | Content | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A. `@animastor/database` (infrastructure package)** | database.js + schema.js + all 16 repos | single owner for pool/migrations; testable in isolation; other future services could reuse | **Repos are business knowledge** (worker policy lanes, scene version gates, connector credentials) — moving them next to the pool does not decouple anything, it just relocates host business logic; every host change to a table now crosses a package boundary; the host is the *only* consumer today (hub/worker have no PG) — a package with one consumer is ceremony; migrations must run at host boot — version skew between package and host SQL usage becomes a release hazard; 50 host test files import repos by relative path (churn for zero behavior gain) | **Rejected now** |
| **B. Database abstraction / repository layer package** | repo interfaces + pool, SQL stays host | clean DI surface | duplicates what `storage/index.js` + guardrail already enforce; abstracting over exactly one DB (PG, no second backend planned) is speculative generality; would touch 52 files for no coupling reduction | **Rejected** |
| **C. `@animastor/postgres` (client/connection only)** | database.js (42 LOC): pool factory, `query`, `closePool`, env contract | tiny, honest; would make the "one pool" rule physically unbreakable; test infra could pin it | near-zero value: the file is already single-owner and guarded; `pg` dep would still live host-side for repos; 42 LOC do not justify a package, versioning, CHANGELOG, guard suite | **Possible but pointless now** — record as the *shape* if a second PG consumer ever appears (e.g. a future standalone stats/report service) |
| **D. Extract nothing; keep DB host-side; continue the debt track** | status quo + keep shrinking `DIRECT_SQL_WHITELIST` (Phase-3 roadmap) | zero risk; the actual coupling (business SQL in business files) is what the whitelist tracks and S-1 already demonstrated the removal pattern (AgentSessionControl port); aligns with D4/D5 and `MODULAR_PRODUCT_ARCHITECTURE` Rule 5 ("consume domain objects, not raw DB details") — which is about *consumers*, not about relocating the client | the whitelist shrink is slow (15 entries left) | **RECOMMENDED** |

### 4.4 PG verdict

**NOT A GOOD EXTRACTION TARGET (as a product module).** PostgreSQL here is **host infrastructure with an already-disciplined boundary**, not a hidden tangle: one pool, one schema owner, repo-per-domain, frozen guardrail, injected ports at every extracted package. Extracting it would create a single-consumer package whose content is the host's own business SQL — a net *increase* in cross-boundary churn, and a migrations/version-skew hazard. The correct "database work" is the existing Phase-3 debt track: **port the remaining 15 direct-SQL whitelist entries to repositories** (the S-1 `AgentSessionControl` pattern), with `agent-session*`/`system-ai`/`workspace-ai-provider` (the VBook/AI cluster) as the natural next batch — which is also exactly the prep the Assistant extraction needs for its own 16 call sites.

---

## 5. Database Boundary Candidates (comparison of the real seams)

For completeness — the four *actual* database-adjacent seams measured, none of which is a "database package":

1. **`ai_chat_sessions` access (Assistant)** — inline in route + guard; first candidate for a repo/port; needed by Assistant extraction (§3).
2. **Agent tables without repos (`agent_sessions/steps/conversations/messages`, `book_generation_sessions`)** — direct-SQL cluster behind `agent-session.js`/`bootstrap.js`; partially ported by S-1 (`AgentSessionControl`); finishing this **removes the largest remaining whitelist cluster** and serves Generation.
3. **Purge lists naming 24 tables** (`book-deletion.cjs`, `cache-routes.cjs`) — a *table-name* leak of every module's schema into one service; candidate for a per-domain `purgeForBook(bookId)` port per module (Assistant included).
4. **`gpu-dispatcher` lazy repo requires** (book/worker/workspace repos with TTL caches) — resolution, not SQL; fine host-side.

---

## 6. Cross-Module Dependency Matrix (measured directions)

| From ▼ / To → | VBook/Book | Generation | Editor | Player | Parser | AI infra (gateway/LAC/pool) | AI analysis (ai-*) | Assistant | PG | Redis | FS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Assistant** | **read+write** (loadBook, saveBookBundle, bundle-validator) | — | parallel-writer kin (shared write contract, no imports) | — | — | **resolve+transport** (C8, shared-pool) | — | — | 1 table, inline (16 sites) | — (own) | persona md (+targeted-save fallback writes bundle files) |
| **Generation (current)** | sessions SQL (S-1 port), Book Model | — (SCC internal) | — | — | structure detector seam | provider seam (S-3) | ai-analysis tasks | — | heavy, mostly reposed | heavy (FSM/queues) | artifacts |
| **Editor (package)** | via `editorModel(bookModel, persistBook)` | — | — | — | — | — | — | — | **only injected `sceneAssetsRepo`** | recovery ports injected | — |
| **Player (package)** | via `playerModel(bookModel)` + injected projections | — | — | — | — | — | — | — | **only injected `iuRepo`** | — | outputRoot injected |
| **VBook runtime (package)** | owns bundle/Book Model | — | — | — | injected detector | — | — | — | none in canonical layer | — | paths injected |
| **PG layer** | hosts book/repos | hosts gen repos | — | — | — | hosts connector/endpoint repos | — | (would host session repo) | — | — | migrations only |

**The pattern is consistent:** every successful extraction was preceded by converting its PG/FS/AI legs into injected ports. Assistant is the only remaining user-facing contour whose legs are *not yet* ports — which is precisely why it is the natural next extraction, and why the "PG question" for it answers itself (a `sessionRepo` port, not a database package).

---

## 7. General Matrix (requested comparison)

| Candidate | Boundary | Dependencies | Reverse deps | PG coupling | Redis coupling | AI coupling | HTTP | Extraction complexity | Reuse potential | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| **AI Assistant** | product contour: chat UI + `/api/v1/ai/*` (REST+SSE) + chat-engine + `ai_chat_sessions` + `edit_book` tool; distinct from ai-agent/ai-analysis/connector (never part of them) | VBook read/write (**blocker→port**), Provider Gateway C8, shared-pool/LAC transport, bundle-validator, ai persona FS; zero Generation/Parser | 2 purge-list table names; frontend invalidation-bus events consumed by Edit/Generate/Navigator/playback | 1 table, 16 inline sites (→ `sessionRepo` port) | **none own** (connector liveness mirror belongs to shared infra) | resolution + transport via documented seams only | yes — stable REST + frozen SSE frame contract (chat-transport guard), web + Android consumers | **Medium** (≈2.5/5): no cycles, no SCC, tests exist; prep = 4 port seams + 1 repo | Medium (any future standalone chat surface / mobile app / assistant tooling; engine+patches are generic) | **READY AFTER PREPARATION** |
| **PostgreSQL / DB layer** | host infrastructure: 1 pool + migrations + 16 repos + guardrail; not a module | business SQL knowledge is the "dependency" — it lives in business modules by right | host is the only consumer (hub/worker: no PG; extracted packages: injected ports) | is the coupling itself | — | — | no (internal) | **High** (52 source files + 50 test files touched for zero behavior gain; migrations/version-skew hazard) | **Low today** (single consumer; a `@animastor/postgres` client pkg becomes justified only when a 2nd PG service appears) | **NOT A GOOD EXTRACTION TARGET** (keep host-side; continue whitelist shrink) |

---

## 8. Hidden Dependencies (consolidated)

1. **Assistant→VBook write fallback:** when a patched bundle has zero chapters, the route hand-writes `manifest/book/bible/locations/voices/characters.json` via `fs.writeFileSync` (both chat routes) — a filesystem write path duplicating `saveBookBundle` semantics "for safety" (route:626-651, 1279-1304). Any Assistant port must absorb both legs.
2. **`storage.postgres` barrel reachability:** the Assistant route receives the whole `storage` barrel via `routeDeps` — a wide object that also carries filesystem-store/registry/bookSync/genScope; a package must take a narrow `sessionRepo` instead.
3. **Persona file location:** `ai/ai-assistant-profile.md` sits in the `backend/ai` tree shared with generation rules/skills/profiles — extraction must move the file (or env-point it) without moving the tree.
4. **Purge coupling:** `book-deletion`/`cache-routes` hardcode `'ai_chat_sessions'` — an extracted Assistant still needs its rows deleted by host purge flows (port required or rows orphan).
5. **`aiBookGuard` ordering:** mounted at `backend.cjs:188-194` with a path-specific regex split (`/sessions/:id` vs body-scoped) — subtle mounting contract that stays with the host shell.
6. **PG-layer hidden consumer — `dependency-graph.js`/`prompt-dependency-registry`:** none (verified — asset-layer semantics only, no SQL).
7. **In-flight S-5 work overlap:** `event-journal.js` relocation touches files (`orchestrator.js`, `runtime/*`) that also carry direct-SQL whitelist entries — the whitelist shrink and the cycle unwind will collide; sequence them (S-5 first, it is already staged).

## 9. Cycles

- **Assistant:** none (leaf contour; reverse edges are table names and frontend events, not requires). The only textual "cycle" is `provider-gateway.js` *documenting* `chatEngine.AI_API_BASE_URL` in a comment — not a require.
- **PG:** none by construction (storage layer requires nothing upstream; repos are leaf modules over `database.js`).
- **Host-wide known cycles (context, not candidates):** orchestration⇄runtime SCC (Generation, S-5 in flight), `generateStore ⇄ playbackStore` frontend (documented Android-parity, port candidate P-2). Extracting neither Assistant nor PG adds or breaks cycles.

## 10. Ports / Adapters Candidates (concrete, minimal)

**`AssistantPorts` (package contract, host-implemented in a composition root — pattern-identical to `editorPorts`/`playerPorts` in `backend.cjs:261-350`):**
- `loadBook(bookId) → bookData|null` (lazy Book Model read)
- `persistBook(bookId, bundle) → void` (saveBookBundle + targeted-save fallback behind one port)
- `validateBundle(obj|file) → {valid, errors}` (bundle-validator injection)
- `resolveChatAI(bookId) → providerSnapshot` (Provider Gateway C8 — already a seam)
- `runSharedInference / safeFetch` (transport injection or keep behind resolveChatAI's `transport` field — the route already branches on `ai.transport`)
- `sessionRepo`: `list(bookId) / get(id) / create(...) / appendMessages(id, msgs) / rename / delete` (replaces the 16 inline sites + guard read)
- `purgeForBook(bookId)` (host purge flows call the Assistant's own delete)
- frontend `AssistantPorts` (Navigator/File precedent): position signal, book-id signal, invalidation bus, http client, i18n, icons, modal/toast.

## 11. Extraction Blockers (ranked)

**Assistant:**
1. Book-write contract decision (H1/H2): pin as parallel writer via `persistBook` port (recommended — matches Editor-audit R5 "pin + document, migrate post-extraction") vs migrate to `editorModel.commit` (contract change, later).
2. Session SQL → repo (mechanical, ~200 LOC).
3. Purge port (small).
4. Package-owned test suite assembly (existing tests already cover the route/engine; needs relocation + the standalone-`npm-test` graduation item).
5. Persona file relocation/env.

**PostgreSQL:** none *for extraction* (nothing blocks making a package) — the finding is that extraction itself is the wrong move; the real blockers are for the **debt track**: 15 whitelist entries, the agent-tables repo cluster, purge lists. These double as Generation-completion and Assistant-prep work.

## 12. Candidate Package Structures

```
@animastor/assistant            (backend, CommonJS, like @animastor/editor)
  src/
    index.cjs            — createAssistant({ ports }) → { chatEngine, routes }
    engine.cjs           — prompts/modes/topics/context (from chat-engine.cjs)
    tools.cjs            — EDIT_BOOK_TOOL + patch pipeline (applyPatchesValidated, normalizeBookParticipants)
    sse-protocol.cjs     — frame contract helpers (think-filter, tool-call extraction, honest terminals)
    session-repo.cjs     — port-shaped PG repo (host injects query) or interface + host impl
    ai-assistant-profile.md
  test/                   — relocated: ai-patch-validation, ai-editor-mode, behavior-edit-book, ai-participants-doctrine, ai-shared-stream (transport subset)

(frontend, later, @animastor/assistant-ui — Navigator/File precedent)
  pages/AiAssistantPage, features/aiChat/*, ports.ts

@animastor/postgres — NOT created (Option C parked; 42-LOC file stays host-side)
@animastor/database — NOT created (Option A/B rejected)
```

## 13. AI Assistant vs PostgreSQL — Comparison

| Question | AI Assistant | PostgreSQL |
|---|---|---|
| Is it a module at all? | Yes — a user-facing product contour with a frozen contract | No — host infrastructure, deliberately layered since Phase 1 |
| Does extraction remove host code? | Yes: ~1,900 backend LOC route+engine+guard concerns, 1 table, 642+823 LOC UI twins (parity), 9+ test files | No: relocates the same code across a boundary; host keeps the business SQL knowledge anyway |
| Does extraction reduce coupling? | Yes: removes a whole HTTP surface + a Book parallel-writer from the route layer; forces the 4 ports that finish its PG story | No: coupling is *between business modules and their tables*; the client is already one file |
| Risk | Low-medium: no cycles, no SCC, contract frozen, tests exist | Medium-high: 52+50 files touched, migration boot-order/version skew, zero behavior gain |
| Precedent fit | Editor/Player/Navigator/File pattern (ports-first, then move) | No precedent — every prior extraction *injected* PG, never extracted it |
| What it unblocks | Assistant-adjacent surfaces (import/director/extraction/validation modes are `soon` chips waiting for tool handlers); completes the last user contour with inline SQL | Nothing that the whitelist-shrink track doesn't already deliver |

## 14. Recommended Next Extraction

**AI Assistant (`@animastor/assistant`), after a short preparation phase.** PostgreSQL extraction is explicitly **not** recommended (Option D: stay host-side; keep shrinking the SQL whitelist).

Why this ordering maximizes monolith-coupling reduction:

1. **Generation must land first** (it is in flight): S-5 cycle unwind is staged in the working tree; its reconnaissance already defines S-6+ and a dedicated extraction-readiness audit. Nothing here should preempt it.
2. **Assistant is the only remaining user-facing contour whose legs are not yet ports** — Editor, Player, Navigator, File all did ports-first and extracted cleanly; Assistant's leg-list is short and fully known (§10).
3. **The Assistant prep *is* a slice of the PG debt track** (its session repo + purge port shrink the same whitelist the roadmap already wants shrunk) — one prep, two goals.
4. **PG extraction would be architecture theater**: a single-consumer package containing the host's own business SQL; it does not match any precedent in the executed roadmap (hub/worker extracted because they had independent consumers and wire contracts; editor/player extracted over injected ports).
5. **Wrong-architecture check (asked in §4 of the brief):** extracting Assistant does not recreate any already-extracted module (it was never part of ai-agent/ai-analysis/LAC), does not collide with Generation (no shared files except none), and its Editor kinship is handled by the same "pin as parallel writer" decision the Editor audit already recorded. Extracting Database *would* create a wrong architecture: an infrastructure package whose consumers are all in one process, and whose "contract" (raw SQL) is precisely what guardrail Rule 5 says not to leak.

## 15. Recommended Extraction Sequence

1. **Finish in-flight Generation work** (S-5 cycle unwind + follow-up guard updates) — already staged; sequence the whitelist-shrink collisions behind it.
2. **Assistant preparation phase** (behavior-neutral, one PR each, guard-test accompanied):
   - A-1: `chatSessionRepo` in `storage/postgres/repositories/` + route/guard switch (16+1 sites) — SQL whitelist style, repo pattern.
   - A-2: `AssistantPorts` composition root (`loadBook`/`persistBook`/`validateBundle`) — Editor-ports pattern; route keeps behavior.
   - A-3: `purgeForBook` port; remove `'ai_chat_sessions'` from the two purge lists.
   - A-4: persona file + `chatEngine` base-URL default cleanup (single source via gateway/config).
   - A-5: architecture guard `assistant-contour.test.js` (freeze ports-only boundary, like editor-route-split/player-route-split).
3. **Extract `@animastor/assistant`** (backend package; routes registered host-side via `createAssistantRoutes(app, { ports })` — Player/Editor precedent).
4. **Continue the PG debt track in parallel** (not a package): next whitelist batch = agent-tables cluster (`agent-session.js`, `agent-session-control.js`, `agent/ai-caller.js`, `agent/bootstrap.js`, `system-ai.js`, `workspace-ai-provider.js`) → `agentSessionRepo`-family; then purge lists per-domain. This simultaneously finishes Generation seam hygiene and preps VBook.
5. **Frontend Assistant UI package** (`@animastor/assistant-ui`) — optional, after Navigator/File precedent stabilizes; Android stays contractual.

## 16. Explicit MOVE / STAY / PORT / BLOCKER Lists

### AI Assistant
| Decision | Items |
|---|---|
| **MOVE** (into `@animastor/assistant`) | `routes/ai-routes.cjs` logic (as package route factory + SSE engine); `services/chat-engine.cjs` → `engine.cjs`+`tools.cjs`; think-filter/tool-call-extraction/persist-turn helpers; `ai-assistant-profile.md`; `AiAssistantPage.tsx` + `features/aiChat/chatStream.ts` (later, UI package); related test files (§12) |
| **STAY** (host) | `backend.cjs` route mounting + `aiBookGuard` mount; `middleware/ai-book-guard.js` (authz; becomes a thin caller of the package's `sessionRepo` port or stays fully host); Provider Gateway + `workspace-ai-provider` + `system-ai` (C8, shared); `ai-connector/*` + shared-pool (shared infra); `ai-service.js` (agent transport — Assistant only borrows its base-URL default); invalidation bus; `api/client.ts`; Android app (parity contract) |
| **PORT** (inject via `AssistantPorts`) | `loadBook`; `persistBook` (both save legs incl. targeted-write fallback); `validateBundle`; `resolveChatAI` (already gateway); transport branch handle (`runSharedInference`/`safeFetch`); `sessionRepo` (PG); `purgeForBook`; `log` |
| **BLOCKER** (resolve before move) | Book parallel-writer contract (pin via `persistBook` — Editor-audit R5 decision, ADR it); inline session SQL (A-1); purge table-name leak (A-3); package test ownership (graduation §26.5) |

### PostgreSQL
| Decision | Items |
|---|---|
| **MOVE** | **Nothing.** (If a second PG consumer service ever appears: only `database.js` (42 LOC) as `@animastor/postgres` — Option C, parked.) |
| **STAY** | `storage/postgres/**` entire layer (pool, schema/migrations, 16 repos, storage barrel); PG env contract; test DB bindings |
| **PORT** (debt track, not extraction) | remaining 15 `DIRECT_SQL_WHITELIST` entries → repositories (agent cluster first); purge lists → per-domain `purgeForBook`; `ai-routes` session SQL → repo (A-1, shared with Assistant prep) |
| **BLOCKER** (for any future package option) | migrations boot-order/version skew host↔package; 50 test files' relative imports; single-consumer futility — all reasons it stays host-side |

---

*Audit produced read-only. No production files were modified. The only artifact is this document.*
