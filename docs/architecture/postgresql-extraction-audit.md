# PostgreSQL Host-Side Infrastructure Audit — Boundary Freeze

**Status:** READ-ONLY audit + boundary guards. No production behavior changed, no files moved, no package created, no SQL rewritten, no migrations touched.
**Date:** 2026-09-11
**Baseline:** branch `c21.4-physically-extract-analysis-from-backend`, HEAD `6895d135` (during the audit the in-flight S-7 generation extraction was committed as `6895d135`; the audit was performed against the working tree that became exactly this HEAD — all measurements below reflect it). Generation S-6 was NOT touched.
**Method:** static require-graph tracing over `backend/src/**`, `packages/**` (full transitive require/import closure per package, not first-level grep); repository/table audit (`storage/postgres/**`, `schema.js`); storage barrel re-export audit; route registration audit (`backend.cjs`); cross-checked against `tests/architecture/sql-boundary.test.js`, `s6-generation-host-ports.test.js`, `generation-package-boundary.test.js`, `ai-assistant-and-postgresql-extraction-audit.md`, `generation-module-extraction-reconnaissance.md`. Where docs and code disagree, **the code wins**.

**Question this audit answers:** *"How to definitively freeze PostgreSQL as HOST-SIDE infrastructure and remove the hidden DB dependency from the extracted / being-extracted modules."*

---

## 1. Executive Summary

**PostgreSQL is NOT a product module and must never become one.** It is host-side infrastructure: one pool factory (`database.js`, 42 LOC, the only `require('pg')` in the entire repo), one DDL/migrations owner (`schema.js`, 1809 LOC, 50 `CREATE TABLE IF NOT EXISTS` + migration stages), 17 repositories under `storage/postgres/repositories/`, one nested barrel (`repositories/index.js`, 11 repos) and one storage barrel (`storage/index.js`) that — critically — also re-exports five **services**. PG is the declared "canonical persistent truth" (decision D4); Redis is runtime transport; filesystem is immutable artifacts.

**All 14+1 extracted npm packages are CLEAN at the require-closure level.** Zero `pg` requires, zero `storage/postgres` requires, zero SQL statements, zero PG table names in code, zero `process.env.PG_*` reads, zero host storage barrels. The two flag-worthy findings inside packages are **comment-only** (see §8). The ports pattern is not aspirational — it is already implemented for Generation (4 frozen ports, S-6/S-7), AI Agent (`assertHostPorts`, C21), Assistant (`AssistantPorts.sessionRepo` + contract), Editor (`editorPorts`), Player (`playerPorts`).

**The hidden dependency lives in the backend host legs**, not in the packages. 52 backend files touch PG through some channel. Of these:
- 15 files hold a **direct `database.query` handle** (raw SQL) — the frozen `sql-boundary.test.js` whitelist; documented debt, shrinking only.
- 8 files use **`storage.postgres.query(...)`** — the raw handle arriving via the **storage barrel**, a channel the existing SQL guard does NOT cover. This is the single real architectural gap (§9, L1–L8).
- ~44 files reach PG **through repositories** — the correct channel.

**Verdict on the rule (§5):** CONFIRMED. «PostgreSQL остаётся host-side infrastructure. Product packages не знают о PostgreSQL, SQL, pool, конкретных таблицах или storage implementation. Они получают необходимые persistence capabilities через узкие domain ports/repositories, реализованные host'ом» — this is already the de-facto state for every package; the guards below (PG-1…PG-5) freeze it mechanically.

**One exception (documented, necessary):** `storage/postgres/repositories/worker-repo.js:35` requires `@animastor/generation` mediaRegistry (`listMediaTypes`) to validate worker types, and `storage/filesystem-store.js:26` requires `artifactNaming` from the same package. This is an **infrastructure → shared domain-contract** dependency (single source of truth for the media-type list / artifact naming), the same direction as a contract package; it is NOT a module→storage leak and does NOT create a cycle (generation never imports storage). It stays.

---

## 2. PostgreSQL Map (as measured)

### 2.1 The DB contours and their real owners

| Contour | Files | Role |
|---|---|---|
| Pool factory | `storage/postgres/database.js` | the ONLY `require('pg')` in the repo; `getPool/closePool/query`; `process.env.PG_*` config — the only PG-env reader |
| DDL / migrations | `storage/postgres/schema.js` | the ONLY file issuing `CREATE/ALTER/DROP TABLE` (verified: zero DDL outside it); 50 tables + index/migration stages |
| Repositories | `storage/postgres/repositories/*.js` (17) | all SQL for books, scenes, assets, users, workspaces, workers, AI connectors/endpoints, sessions, events, generation sessions/cancels |
| Repo barrel | `repositories/index.js` | re-exports 11 repos: book, task, iu, sceneAssets, events, genSession, bookSource, generationCancel, user, workspace, aiConnector |
| PG entry | `storage/postgres/index.js` | `initialize()` (migrations + pool + repos), re-exports `query/getPool/closePool/repos` |
| Storage barrel | `storage/index.js` | re-exports `postgres`, filesystem, registry + **five services** (bookEventLog, bookSource, bookSync, layerConfig, genScope) — see §10 |

Repositories NOT in the barrel (consumed by direct path only): `ai-endpoint-repo`, `session-repo`, `worker-repo`, `guest-repo`, `chat-session-repo`.

### 2.2 Table → owner repository map

| Table | Owning repository(s) |
|---|---|
| `books`, `book_snapshots` | `book-repo` |
| `book_source` | `book-source-repo` |
| `scenes`, `scene_assets` | `scene-assets-repo` (join queries); raw writes in book-sync/runtime (§9) |
| `generation_tasks` | `task-repo` |
| `book_generation_sessions` | `gen-session-repo` |
| `generation_cancellations` | `generation-cancel-repo` |
| `image_units` | `iu-repo` |
| `book_events` | `events-repo` |
| `users`, `sessions`, `workspaces`, `workspace_members` | `user-repo`, `session-repo`, `workspace-repo` |
| `guests` | `guest-repo` |
| `workers`, `share_policies`, `share_policy_grants` | `worker-repo` (+ route purge lists) |
| `ai_connectors` | `ai-connector-repo` |
| `ai_endpoints`, `ai_endpoint_share_policies` | `ai-endpoint-repo` |
| `ai_chat_sessions` | `chat-session-repo` (Assistant port) |
| `agent_sessions`, `agent_steps`, `agent_conversations`, `agent_messages` | NO repository — raw SQL in services/agent/** (§9, L9–L11) |
| `workspace_ai_providers`, `system_settings`, `system_ai_providers` | NO repository — raw SQL in workspace-ai-provider.js / system-ai.js (whitelisted) |
| `character_resolution_runs`, `character_window_candidates`, `sentence_resolutions`, `character_mentions`, `character_aliases` | NO repository — purge-list strings + sync SQL (§9, L5) |
| `asset_states`, `cache_entries`, `asset_dependencies`, `storyboard_elements`, `audio_layers`, `output_manifests`, `reconciliation_events` | NO repository — referenced only inside dynamic `DELETE FROM ${table}` purge loops |
| `scene_assets_cache` | **GHOST** — read by `cache-routes.cjs:24` but created nowhere (§11, DEAD/LEGACY) — **RESOLVED in Phase 2: the ghost read is removed** |

### 2.3 The four PG access channels (measured surface)

1. **Channel A — direct handle**: `require('.../storage/postgres/database')` → `query(...)`. 15 files (the frozen `sql-boundary.test.js` whitelist). Includes one `getPool().connect()` transaction (auth-service.js).
2. **Channel B — repository**: direct repo path requires. ~44 files. The correct channel.
3. **Channel C — storage barrel**: `storage.postgres.query(...)` / `const { postgres } = storage`. 9 files (8 doing raw SQL — frozen by PG-4 — plus backend.cjs which only wires initialize/closePool/deps, no SQL). NOT covered by any guard before this audit; now frozen by PG-4.
4. **Channel D — composition-root injection**: `deps.postgres` passed into `reconciliation-engine` (backend.cjs:683). 1 file. Raw SQL via injected handle.

Total: **52 unique backend files** reach PG by any channel (full list in §16).

---

## 3. DB Consumers by Module (matrix module → PostgreSQL)

Legend for how each module touches PG: **A** raw SQL in module, **B** direct pg import, **C** pool/database via host storage, **D** repository direct, **E** storage barrel, **F** helper/service hiding PG, **G** table names in module logic, **H** cycle module→storage→module.

| Module | Extracted? | A | B | C | D | E | F | G | H | Classification |
|---|---|---|---|---|---|---|---|---|---|---|
| VBook Runtime (`@animastor/vbook-runtime`) | yes | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗* | ✗ | HOST-side repos only. *book-model.cjs carries a comment mentioning storage/postgres — comment, not code |
| Parser (`@animastor/parser`) | yes | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | pure; zero persistence |
| AI Connector (`@animastor/ai-connector`) | yes | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | WS transport; host legs (`services/ai-connector/discovery.js` → aiConnectorRepo, `shared-pool.js` → endpointRepo) are HOST_ADAPTER |
| ComfyUI Workflow Connector (`@animastor/comfyui-workflow-connector`) | yes | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | pure JSON/FS |
| Worker (`@animastor/worker`) | yes | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | node builtins only (guard-pinned); talks HTTP to hub |
| GPU Hub (`@animastor/gpu-hub`) | yes | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗* | ✗ | Redis + HTTP only; *gpu-hub.js:64 carries a SYNC comment referencing worker-repo token format — intentional contract sync, comment-only |
| Editor (`@animastor/editor`) | yes | ✗ | ✗ | ✗ | ✗ | ✗ | via ports | ✗ | ✗ | `editorPorts` carries `sceneAssetsRepo` + `purge` (entity-cleanup) — HOST_ADAPTER; entity-cleanup SQL stays host-side |
| Player (`@animastor/player`) | yes | ✗ | ✗ | ✗ | ✗ | ✗ | via ports | ✗ | ✗ | `playerPorts` HOST_ADAPTER |
| Navigator (`@animastor/navigator`) | yes | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | web UI, no persistence |
| File (`@animastor/file`) | yes | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | web UI, no persistence |
| AI Agent (`@animastor/ai-agent`) | yes | ✗ | ✗ | ✗ | ✗ | ✗ | via ports | ✗ | ✗ | mechanism only; PG session/step bookkeeping injected via `assertHostPorts` — HOST_ADAPTER (pipeline-steps.js injects updateSession/createStep/completeStep/failStep/logConversation) |
| AI Analysis (`@animastor/ai-analysis`) | yes | ✗ | ✗ | ✗ | ✗ | ✗ | via ports | ✗ | ✗ | tasks receive host ports; zero persistence |
| AI Assistant (`@animastor/assistant`) | yes | ✗ | ✗ | ✗ | ✗ | ✗ | via ports | ✗ | ✗ | `AssistantPorts.sessionRepo` → chat-session-repo; contract in package, PG impl host-side — the model case |
| Generation (`@animastor/generation`) | yes (S-7, landed as `6895d135` during this audit) | ✗ | ✗ | ✗ | ✗ | ✗ | via ports | ✗ | ✗ | 4 frozen ports (dispatch-transport, generation-config, profile-store, book-data); guards G7-C bans `postgres`/`storage/`/`database` specs in closure |
| Generation — host legs (`backend/src/{runtime,orchestration,audio,image,video,workflows,services}`) | no (host) | ✓ | ✓(host files) | ✓ | ✓ | ✓ | — | ✓ | ✗ | HOST_INFRASTRUCTURE for the monolith host; see §6 for the boundary vs the package |

The backend-side Generation contour is the biggest PG consumer cluster: dispatch-engine, gpu-dispatcher, reconciliation-engine, runtime-scheduler, scene-window, orchestrator, scene-orchestrator, scene-callbacks, scene-restoration, audio/generation, image/iu-processor, video/video-merge, video-workflows, placeholder-audio, scene-asset-registry, task-handler (via repos) — **all host legs of the Generation package** (per S-6: "host adapters implement the ports"). They are NOT module leaks *today* because the module contour is the package and the package is clean; but they are the concentration of raw SQL that must not silently move into the package (guards G7/S6 already prevent that).

---

## 4. Direct SQL hotspots (raw SQL outside `storage/postgres`)

| # | File | Tables touched raw | Nature |
|---|---|---|---|
| 1 | `services/book-sync.js` (8 queries) | scenes, storyboard_elements, audio_layers, asset_states, cache_entries + scene_assets via repo | scene hash/version reconciliation |
| 2 | `services/agent/bootstrap.js` (5 requires) | agent_sessions | window resume/dedup/cancel cleanup |
| 3 | `services/agent/ai-caller.js` | agent_conversations, agent_messages | conversation log |
| 4 | `services/agent-session.js` + `agent-session-control.js` | agent_sessions, agent_steps | session/step CRUD (no repo exists) |
| 5 | `services/workspace-ai-provider.js` (5) | workspace_ai_providers | provider resolution + AES envelope |
| 6 | `services/system-ai.js` (6) | system_settings, system_ai_providers | kill switch + system provider |
| 7 | `routes/ai-endpoint-routes.cjs` (4) | ai_connectors | enrichment read joining repo output |
| 8 | `routes/book/agent-routes.cjs` (3× barrel) | agent_sessions, agent_steps, book_generation_sessions | status reads |
| 9 | `routes/book/generation-routes.cjs` (1× barrel + repos) | scenes | dirty-scene fallback |
| 10 | `routes/book/import-routes.cjs` (2× barrel) | agent_sessions | active-session check |
| 11 | `routes/book/versions-routes.cjs` (2× barrel) | scenes, scene_assets | version panel |
| 12 | `routes/book/cache-routes.cjs` (2× barrel + purge loop) | scene_assets_cache (ghost), + 11 purge-list tables | cache status/purge |
| 13 | `runtime/scene-window.js` + `orchestration/scene-restoration.js` + `orchestration/orchestrator.js` + `services/placeholder-audio.js` (same query ×4 copies) | scenes | version-staleness read |
| 14 | `runtime/runtime-scheduler.js` | scenes, scene_assets (join) | version-stale detection |
| 15 | `runtime/reconciliation-engine.js` (deps.postgres + barrel) | scenes, scene_assets, image_units, agent_sessions, generation_cancellations | startup reconcile/worklist |
| 16 | `services/book-deletion.cjs` + `entity-cleanup.cjs` (barrel purge loops) | 15+ tables by name in array literals | book/unit purge |
| 17 | `image/iu-processor.js` (4) | scene_assets, image_units | scene duration resolution |
| 18 | `workflows/video/video-workflows.js` | image_units | IU metadata read |
| 19 | `auth/auth-service.js` | users, workspaces, workspace_members | signup transaction (pool client) |
| 20 | `services/system-ai.js` / `workspace-ai-provider.js` | (see 5/6) | whitelisted infra |

All 15 `database.js`-handle files are pinned by `sql-boundary.test.js` (frozen whitelist, shrink-only). The barrel-channel files (agent-routes, cache-routes, generation-routes, import-routes, versions-routes, reconciliation-engine, book-deletion, entity-cleanup) are the **unguarded channel** — closed by PG-4 below.

---

## 5. The Rule — confirmed

> «PostgreSQL остаётся host-side infrastructure. Product packages не знают о PostgreSQL, SQL, pool, конкретных таблицах или storage implementation. Они получают необходимые persistence capabilities через узкие domain ports/repositories, реализованные host'ом.»

**CONFIRMED — and already implemented at the package boundary.** Verified per package by full require-closure scan (not first-level grep): no `pg`, no `postgres`, no `storage/postgres`, no host barrel, no SQL strings, no PG table names, no `process.env.PG_*`. Packages that need persistence receive it via narrow ports with fail-closed wiring (`assertHostPorts`, `AssistantPorts` contract check, Generation port setters wired in backend.cjs:24-30, editorPorts/playerPorts factories).

**Necessary exceptions (both host-side, both correct):**
1. `worker-repo.js` → `@animastor/generation` mediaRegistry: the repo validates worker types against the single media-type list. Direction infra→domain-contract, no cycle (generation's closure never reaches storage). Alternative (duplicating the list in SQL check constraints) would create two sources of truth.
2. `filesystem-store.js` → `@animastor/generation` artifactNaming: artifact path naming is a shared frozen contract; the FS store must produce the same paths as the package. Same direction argument.

**What is NOT an exception:** business SQL knowledge (scene staleness, window resume, provider resolution) — it stays in the host, expressed either in repositories or, during the documented transition, in the whitelisted raw-SQL files.

---

## 6. Extracted package closure verification (§5 of the brief)

Method: transitive require/import closure per package entrypoint, resolving `@animastor/*` workspace links, checking every reachable file for: `pg` require, `postgres` substring in specs, SQL statements, PG table names as SQL tokens, `process.env.PG_*`, host barrel requires, hidden helper requires reaching PG.

| Package | Closure verdict | Notes |
|---|---|---|
| `@animastor/contracts` | CLEAN | wire protocol only |
| `@animastor/vbook-runtime` | CLEAN | book-model.cjs:24 comment mentions storage/postgres repositories (documentation of ownership, not a require) |
| `@animastor/parser` | CLEAN | |
| `@animastor/ai-connector` | CLEAN | ws only |
| `@animastor/comfyui-workflow-connector` | CLEAN | env reads: WF_DIR/CONNECTOR_DIR — package-local FS roots, not DB config |
| `@animastor/worker` | CLEAN | builtins only (guard-pinned) |
| `@animastor/gpu-hub` | CLEAN | Redis/HTTP only; gpu-hub.js:64 SYNC comment references worker-repo token format — intentional cross-repo contract documentation |
| `@animastor/editor` | CLEAN | editor-ports.cjs carries repo references as PORTS (functions injected by backend.cjs), not requires |
| `@animastor/player` | CLEAN | |
| `@animastor/navigator` | CLEAN | |
| `@animastor/file` | CLEAN | |
| `@animastor/ai-agent` | CLEAN | zero requires beyond `./ports` |
| `@animastor/ai-analysis` | CLEAN | tasks are port-driven |
| `@animastor/assistant` | CLEAN | session-repo-contract.cjs documents the host-side PG repo by path — contract doc, not a require |
| `@animastor/generation` (S-7, `6895d135`) | CLEAN | G7-C bans postgres/database/storage specs in closure; deps frozen to contracts + comfyui connector |

`process.env` inside packages (WF_DIR, CONNECTOR_DIR, REDIS_URL, GPU_* in gpu-hub, ORPHAN_GRace_MS etc.) — all are the packages' OWN runtime infrastructure knobs, none are DB config; no `PG_*` anywhere outside `database.js` (verified repo-wide).

---

## 7. Repository consumers (Channel B — the correct channel)

| Repository | Backend consumers (host legs) |
|---|---|
| `book-repo` | auth-service, middleware/auth-context, middleware/workspace-ownership, routes: book/generation-routes, book/import-routes, book/recent-books-routes, generation-routes, runtime/gpu-dispatcher |
| `task-repo` | routes: book/generation-routes, generation-routes, runtime/reconciliation-engine, runtime/runtime-scheduler |
| `gen-session-repo` | backend.cjs, services/agent-session-control, startup-resume |
| `generation-cancel-repo` | routes: book/generation-routes, generation-routes, runtime/reconciliation-engine, services/agent/bootstrap, startup-resume |
| `scene-assets-repo` | audio/generation, backend.cjs, orchestration/{orchestrator, scene-callbacks, scene-orchestrator, scene-restoration}, routes: book/{generation-routes, progress-panel}, runtime/{reconciliation-engine, scene-window}, services/{book-sync, placeholder-audio, scene-asset-registry}, state/scene-state-ops |
| `iu-repo` | backend.cjs, orchestration/scene-callbacks, services/placeholder-audio, video/video-merge |
| `events-repo` | services/book-event-log (itself re-exported by the barrel) |
| `book-source-repo` | backend.cjs |
| `worker-repo` | routes: admin, worker, worker-setup; runtime/gpu-dispatcher; services/worker-auth |
| `ai-connector-repo` | routes: ai-connector, settings-ai; services/ai-connector/discovery; services/provider-gateway (lazy) |
| `ai-endpoint-repo` | routes/ai-endpoint, services/ai-connector/shared-pool |
| `user-repo` | auth-service, middleware/workspace-ownership, routes: users, worker |
| `workspace-repo` | auth-service, middleware/{auth-context, workspace-ownership}, routes/worker, runtime/gpu-dispatcher |
| `guest-repo` | auth-service, backend.cjs, routes/auth |
| `session-repo` | auth-service, backend.cjs |
| `chat-session-repo` | backend.cjs (→ AssistantPorts), middleware/ai-book-guard (swappable seam), services/assistant-ports |
| `repositories/` barrel | image/iu-processor (one lazy `{ iu }` — repo-level barrel, acceptable) |

---

## 8. Hidden / transitive dependencies found

| # | Channel | Finding | Severity |
|---|---|---|---|
| T1 | storage barrel | `storage/index.js` re-exports 5 **services** (bookEventLog, bookSource, bookSync, layerConfig, genScope), so `require('../storage')` transitively loads PG SQL (book-sync) and service logic. The barrel is a **facade over services**, not a storage layer. | architectural smell (E/F); no package reaches it |
| T2 | storage barrel | `storage.postgres` re-exports `query`/`getPool` — any barrel consumer can do raw SQL invisibly. 8 files currently do (§9) | real gap → PG-4 |
| T3 | repo barrel | `repositories/index.js` re-exports repos — fine as a repo catalog; only 1 consumer uses it lazily | none |
| T4 | deps injection | `deps.postgres` (reconciliation-engine) — raw handle passed as a dependency | documented (§9 L7) |
| T5 | comment-only | package files referencing PG by path in comments (vbook-runtime book-model, gpu-hub SYNC, assistant contract, editor-ports) | intentional documentation; keep |
| T6 | helper hiding PG | `provider-gateway` (lazy getConnector), `scene-asset-registry`, `worker-auth`, `book-event-log`, `assistant-ports` — all are HOST adapters by design; packages never reach them | correct pattern |

**Transitively, no extracted package reaches PostgreSQL through ANY chain** (verified by closure, §6). The hidden dependency exists only host-internally (T1/T2).

---

## 9. Leakage register (classified)

Categories: `HOST_INFRASTRUCTURE` / `HOST_ADAPTER` / `MODULE_LEAK` / `SHARED_DOMAIN_REPOSITORY` / `DEAD-LEGACY`.

| # | Item | Category | Decision |
|---|---|---|---|
| L1 | `routes/book/agent-routes.cjs` — 3× `storage.postgres.query` on agent_sessions/agent_steps/book_generation_sessions | HOST_INFRASTRUCTURE (barrel channel) | move off the barrel onto a repository (agent-status repo or the existing AgentSessionControl port) **when touched next**; frozen by PG-4. **RESOLVED in Phase 2 (§15): migrated to `agentSession.getLatestSessionForBook` / `getRunningStepType` + `genSessionRepo.getLatestActiveSession`** |
| L2 | `routes/book/cache-routes.cjs` — barrel query + purge loop | HOST_INFRASTRUCTURE (barrel channel) | same; purge loop stays host-side forever (cross-domain book purge is host composition logic). **Phase 2 (§15): the ghost `scene_assets_cache` read removed; only the purge loop remains (whitelisted)** |
| L3 | `routes/book/generation-routes.cjs:464` — barrel query on scenes | HOST_INFRASTRUCTURE (barrel channel) | fold into scene-assets-repo (already has getDirtyUnitIds) when touched. **RESOLVED in Phase 2 (§15): migrated to `sceneAssetsRepo.getFlaggedDirtyScenes`** |
| L4 | `routes/book/import-routes.cjs`, `routes/book/versions-routes.cjs` — barrel queries | HOST_INFRASTRUCTURE (barrel channel) | same freeze. **RESOLVED in Phase 2 (§15): import-routes → `agentSession.getActiveSessionForBook` / `getLatestSessionForBook`; versions-routes → `sceneAssetsRepo.getSceneVersions` / `getSceneAssetVersions`** |
| L5 | `services/book-deletion.cjs` + `entity-cleanup.cjs` + `cache-routes.cjs` purge loops — 15+ table names in array literals | HOST_INFRASTRUCTURE | the purge lists ARE the domain knowledge of a book's full PG footprint; keep host-side, optionally extract to a `storage/postgres/book-purge.js` repo later (not now) |
| L6 | `runtime/reconciliation-engine.js` — deps.postgres + barrel raw SQL (scenes/scene_assets/image_units/agent_sessions) | HOST_INFRASTRUCTURE | startup reconcile is host recovery logic; S-6 guards already forbid it moving into the package. **Phase 2 verdict (§15.2): KEEP — see §15.2 for the reason** |
| L7 | `services/agent/**` raw SQL on agent_sessions/agent_steps/agent_conversations/agent_messages (no repo) | SHARED_DOMAIN_REPOSITORY (to-be) | proposed narrow port `AgentSessionStore` (§12) — host impl; NOT implemented now. **Phase 2 (§15): the route-level reads moved into `services/agent-session.js` (the de-facto store); the full AgentSessionStore port remains future work** |
| L8 | `services/workspace-ai-provider.js` + `system-ai.js` raw SQL (workspace_ai_providers/system_settings/system_ai_providers) | HOST_INFRASTRUCTURE | platform-level AI config is host; candidate repos (`workspace-ai-repo`, `system-ai-repo`) noted, not created |
| L9 | `auth/auth-service.js` — pool client transaction (users/workspaces/workspace_members) | HOST_INFRASTRUCTURE | account domain is host; transaction needs the client handle — a repo with a transaction API is the long-term shape |
| L10 | `worker-repo.js` → `@animastor/generation` mediaRegistry | SHARED_DOMAIN_REPOSITORY (direction infra→contract) | KEEP — single source of truth; no cycle |
| L11 | `filesystem-store.js` → `@animastor/generation` artifactNaming | SHARED_DOMAIN_REPOSITORY (direction infra→contract) | KEEP — shared frozen naming contract |
| L12 | `image/iu-processor.js` — 4 direct queries (scene_assets/image_units) + repo barrel | HOST_INFRASTRUCTURE (whitelisted) | duration resolution could become an iu-repo/scene-assets-repo op later |
| L13 | version-staleness SELECT duplicated ×4 (scene-window, scene-restoration, orchestrator, placeholder-audio) + runtime-scheduler + book-sync | HOST_INFRASTRUCTURE | dedup into `scene-assets-repo.getSceneVersions` is a nice-to-have; not required for the freeze |
| L14 | `cache-routes.cjs:24` reads `scene_assets_cache` which is created NOWHERE | **DEAD-LEGACY** | the GET /cache status endpoint returns empty on any current DB (table absent → catch → empty counts). Fix path: drop the query or point at real cache state — **flagged only, no runtime change made** (needs a product decision). **RESOLVED in Phase 2 (§15): the ghost read is removed; on every real DB the response shape was already the empty one, so runtime behavior is identical** |
| L15 | `storage/index.js` barrel re-exporting services (bookEventLog/bookSource/bookSync/layerConfig/genScope) | HOST_INFRASTRUCTURE (layering smell) | barrel consumers (dispatch-engine, scene-callbacks, backend.cjs, reconciliation-engine) use it for filesystem/registry legs mostly; keep, but the barrel must not grow; PG-4 stops the `postgres.query` leg |
| L16 | Generation host legs holding raw SQL (§4 rows 1,8–15) | HOST_INFRASTRUCTURE | these are exactly the "host adapters implement the ports" legs of S-6; G7 guards forbid them entering the package |

**MODULE_LEAK count: 0.** No extracted package contains SQL, a pg import, a table name in code, or reaches storage transitively. The remaining risk is *regression*, which the guards close.

---

## 10. Dependency cycles (module → storage → module)

Scanned: every require edge out of `storage/**`, plus every package closure edge back.

- **storage/postgres/repositories → modules:** only `worker-repo.js → @animastor/generation` (L10). Generation's own closure (G7-C) contains no storage/postgres/backend edge → **no cycle**.
- **storage barrel → services:** `storage/index.js` requires `services/{book-event-log, book-source, book-sync, layer-config, gen-scope}`; `book-sync` requires `storage/postgres/database` + `scene-assets-repo` back. This is an internal host layering cycle (barrel ⇄ services), NOT a module→storage→module cycle — no extracted package participates. Same for `services/book-source → book` (facade to package, correct direction).
- **runtime ⇄ orchestration ⇄ storage:** dispatch-engine requires the barrel (for filesystem legs — verified it never dereferences `storage.postgres`), scene-callbacks requires the barrel for filesystem/registry legs + repos directly. reconciliation-engine holds both repo requires and injected `deps.postgres`. All host-internal.
- **packages → backend:** zero (verified per-closure; guard-pinned for generation G7-B/K, worker, gpu-hub, editor, player, vbook).

**Verdict: no module → storage → module cycles exist.** The single host-internal barrel⇄service cycle (T1) is a layering smell documented above, kept frozen.

---

## 11. What is already clean (no action)

- The `pg` driver is required in exactly ONE file (`database.js`); `process.env.PG_*` read in exactly ONE file.
- All DDL lives in exactly ONE file (`schema.js`); no ad-hoc `CREATE/ALTER/DROP TABLE` anywhere else (repo-wide verified).
- All 14 extracted packages + in-flight generation package: PG-free at closure level.
- Persistence reaches packages only through ports: Generation (4 frozen ports + fail-closed wiring in backend.cjs:24-30), AI Agent (`assertHostPorts` — every task validates its ports before running), Assistant (`AssistantPorts` contract-checked at composition root), Editor/Player (port factories).
- `sql-boundary.test.js` keeps the direct-handle whitelist frozen and shrinking (it caught the S-1 and Assistant removals already — the mechanism works).
- Frontends (web/android/website): zero PG references.

## 12. Proposed narrow ports (documented — NOT implemented)

Per the brief, only fixed as proposals; none created:

1. **`AgentSessionStore`** (host port for the agent contour): `createSession / updateSession / isSessionCancelled / createStep / completeStep / failStep / getLatestWindow / countRunning / listStatus`. Implementations: `agent-session.js` + `agent-session-control.js` + the bootstrap raw SQL (L7). Owners: VBook-generation host legs. This is the largest remaining repo-less SQL family (4 tables, 5 files).
2. **`WorkspaceAiProviderStore` + `SystemAiProviderStore`** (L8): thin repos mirroring the existing repo style — the SQL stays byte-identical, only the handle moves behind a repo. Needed only if/when AI-connector settings contour is extracted further.
3. **`getSceneVersions(bookId, chapterId, sceneId)`** on `scene-assets-repo` (L13): dedups the ×4–6 copies of the version-staleness SELECT. Low priority; zero behavior change if done.
4. **`ai-endpoint-routes` connector enrichment** (L7 row §4-7): one `getConnectorMeta` op on `ai-connector-repo` removes the route's raw `ai_connectors` read.

Explicitly NOT proposed: a generic `DatabasePort`, `@animastor/postgres`, moving `schema.js`/migrations, rewriting repos, any SQL change without necessity.

## 13. What requires hardening (and got it)

The single unguarded channel was **Channel C** (`storage.postgres.query` through the barrel) + regression risk at the package boundary. Closed by the new guard suite `tests/architecture/postgres-host-infrastructure.test.js`:

- **PG-1** — the pg driver is required ONLY by `storage/postgres/database.js` (repo-wide).
- **PG-2** — no file under `packages/**` requires `pg`, `postgres`, any `storage/postgres` path, or any host barrel spec (first-level AND closure-level; complement to G7-C which covers only generation).
- **PG-3** — `process.env.PG_*` appears only in `storage/postgres/database.js` (no DB config leaks into modules/frontends).
- **PG-4** — the barrel raw-SQL channel is frozen: outside `backend/src/storage/**`, only the 8 current `storage.postgres.query` users may keep doing raw SQL through the barrel (whitelist mirrors sql-boundary semantics: shrink-only, no new entries without an ADR).
- **PG-5** — all DDL stays in `storage/postgres/schema.js` (no CREATE/ALTER/DROP TABLE/INDEX anywhere else in backend or packages).

These pin the reached state without changing runtime behavior. Together with `sql-boundary.test.js` (Channel A) and the per-package boundary suites (G7/S6/editor/player/vbook/gpu-hub/worker/assistant), every channel is now guarded: A by sql-boundary, B by convention+repo catalog, C by PG-4, D correct by design, packages by PG-2 + per-package suites.

## 14. What is normal host infrastructure (leave alone)

Everything in §2.1; auth/signup transaction; provider resolution SQL (workspace/system AI); kill switch; agent session bookkeeping (until the port in §12 lands); reconciliation/startup recovery SQL; book purge loops; scene version/staleness SQL; worker/token management; all repositories; `schema.js` + migrations; the barrel as a filesystem/registry facade (minus the raw-query leg, frozen by PG-4).

## 15. Phase 2 — PostgreSQL boundary cleanup

**Date:** 2026-09-11 · **Scope:** the 8 frozen barrel-SQL consumers (audit §9 L1–L8) + the one flagged DEAD-LEGACY table. **No new package, no port invented, no runtime behavior change, no schema/migration change.** The architectural model stays: `npm module → narrow domain port ← host adapter → PostgreSQL` — never `module → postgres`, never `module → generic storage → postgres`. No generic `DatabasePort`/`PostgresPort`/`StoragePort`, no `pool` or universal `query(sql)` crossing module boundaries — only specific domain operations moved into the modules that already own that domain's SQL.

### 15.1 `scene_assets_cache` — final verdict: REMOVE (dead)

Proof of deadness: the table is created NOWHERE (`schema.js` has no `scene_assets_cache` DDL — repo-wide grep finds zero creation); the only code reference was the read in `cache-routes.cjs:24`; no tests reference it; frontends never heard of it. On every real database the query threw (`relation does not exist`), the catch swallowed it, and the GET /cache endpoint returned exactly `{ chapters: {}, summary: { stale: 0, pending: 0, ready: 0 } }`. Removing the read produces the identical response on every real DB — runtime behavior preserved. The query and its try/catch are deleted; the empty-summary computation stays (endpoint contract unchanged).

### 15.2 The 8 barrel-SQL consumers — verdicts

| # | File | SQL that was there | Verdict | What changed / why it stays |
|---|---|---|---|---|
| 1 | `routes/book/agent-routes.cjs` | latest agent_session per book; running agent_step; latest active book_generation_session | **MIGRATE TO REPOSITORY** (done) | → `agentSession.getLatestSessionForBook(bookId)` + `agentSession.getRunningStepType(sessionId)` (services/agent-session.js — the canonical VBook session store, already the DIRECT_SQL_WHITELIST owner of agent_sessions/agent_steps SQL) and `genSessionRepo.getLatestActiveSession(bookId)` (gen-session-repo already owns book_generation_sessions). SQL byte-identical, moved not rewritten. The route now knows the status surface, not SQL. Off the PG-4 baseline. |
| 2 | `routes/book/import-routes.cjs` | active agent session check (resume-bootstrap); latest agent session (trigger-next-window) | **MIGRATE TO REPOSITORY** (done) | → `agentSession.getActiveSessionForBook(bookId)` / `getLatestSessionForBook(bookId)` (same store). Off the PG-4 baseline. |
| 3 | `routes/book/generation-routes.cjs` | flagged-dirty scenes fallback (scenes) | **MIGRATE TO REPOSITORY** (done) | → `sceneAssetsRepo.getFlaggedDirtyScenes(bookId)` (scene-assets-repo already owns scenes/scene_assets SQL incl. `getDirtyScenesByVersion`). Off the PG-4 baseline. |
| 4 | `routes/book/versions-routes.cjs` | per-scene versions (scenes); per-asset versions (scene_assets) | **MIGRATE TO REPOSITORY** (done) | → `sceneAssetsRepo.getSceneVersions(bookId)` + `sceneAssetsRepo.getSceneAssetVersions(bookId)` — this realizes §12 proposal 3 (`getSceneVersions`) in the per-book form the version panel actually needs. Off the PG-4 baseline. |
| 5 | `routes/book/cache-routes.cjs` | ghost `scene_assets_cache` read (dead) + purge loop | **REMOVE** (ghost, done) + **KEEP** (purge loop) | The ghost read is gone (§15.1). The purge loop (`DELETE FROM ${table}` × 18) IS the domain knowledge of a book's derived PG footprint — cross-domain host composition; extracting it into a repo would just relocate the same table list. Stays whitelisted (PG-4). |
| 6 | `runtime/reconciliation-engine.js` | `SELECT DISTINCT book_id FROM scenes` ×2; scenes⇄scene_assets staleness join (all books); dirty-unit/status markers per book | **KEEP** | Startup/recovery host infrastructure, fail-closed by design (audit L6): the cross-book staleness join cannot be replaced by the per-book `getDirtyScenesByVersion` without an N+1 rewrite (a behavior change), and the recovery seams (`deps.postgres`) are exercised as-is by the reconciliation runtime tests. The engine already uses repositories where the domain op exists (`getDirtyScenesByVersion`, `generationCancelRepo.getAllCancelled`). Partial migration would leave the file whitelisted anyway — churn without boundary gain. Stays whitelisted (PG-4). |
| 7 | `services/book-deletion.cjs` | agent-session cancel UPDATE + purge loop | **MIGRATE** (cancel, done) + **KEEP** (purge loop) | The cancel UPDATE was a byte-identical duplicate of `agentSessionControl.cancelSessions(bookId)` — the frozen S-1 port impl already serving cancel-worker/generation routes. The cascade now injects `agentSessionControl` (single owner of the cancel SQL; wired in backend.cjs). The purge loop stays (same reason as #5). Still whitelisted (PG-4) for the purge loop only. |
| 8 | `services/entity-cleanup.cjs` | image_units delete per unit; scenes dirty_unit_ids scrub per unit | **KEEP** (with reason) | This service is the HOST implementation of the editor `purge` port, and the editor package seam test verifies the purge contract through the postgres-handle seam (asserting the DELETE/UPDATE statements it must issue). Migrating the two statements into iu-repo/scene-assets-repo would require injecting `sceneAssetsRepo` here — which would also activate the currently-dormant `bumpSceneVersions` branch (production wiring does not pass sceneAssetsRepo to entity-cleanup), i.e. a runtime behavior change. The statements are per-entity purge composition, not domain reads. Stays whitelisted (PG-4). |

**Net effect:** PG-4 barrel-SQL baseline 8 → 4 files (agent-routes, import-routes, generation-routes, versions-routes left the baseline; the remaining 4 are purge/recovery host composition, each with a documented reason). All new SQL homes already existed: `services/agent-session.js`, `gen-session-repo`, `scene-assets-repo` — no new repos, no new ports, no generic seams.

### 15.3 Agent contour — why no `AgentSessionStore` port yet

The brief's priority candidates were examined before any implementation:

- **`AgentSessionStore`** — the route-level reads (agent-routes, import-routes) now go through `services/agent-session.js`, which IS the de-facto host-side agent-session store (it already owned createSession/updateSession/getSession/createStep/completeStep/failStep and stays inside the DIRECT_SQL_WHITELIST). This is a coupling reduction without a new seam: the SQL family is now concentrated in one owner. The full port (per §12 #1: folding `agent-session-control.js` + `services/agent/bootstrap.js` + `ai-caller.js` behind a single contract) is justified only when the npm `@animastor/ai-agent`/VBook contour needs it for extraction — implementing it now would create a port with exactly the same single consumer (the host) it has today, i.e. no boundary improvement. **Not implemented — proof documented.**
- **`WorkspaceAi/SystemAi provider stores`** — these are Channel A whitelisted files (NOT barrel consumers, outside this Phase's 8). The tables (`workspace_ai_providers`, `system_settings`, `system_ai_providers`) have no repo; the SQL is platform-level provider resolution + kill switch. A `workspace-ai-repo`/`system-ai-repo` is warranted only if/when the AI-connector settings contour is extracted (audit §12 #2). **Documented, not implemented — no package consumes them.**
- **`getSceneVersions`** — implemented in Phase 2 (§15.2 #4) because it had an immediate consumer with a real win: the versions route left the barrel channel behind an already-existing repo. This is exactly the "specific operation, not generic storage" model.

### 15.4 Guards after Phase 2

- **PG-4 baseline** shrunk 8 → 4 in `BARREL_SQL_WHITELIST` (shrink-only discipline unchanged: no new entries without an ADR; entries must exist and be exact). PG-1/PG-2/PG-3/PG-5 untouched and passing.
- `sql-boundary.test.js` DIRECT_SQL_WHITELIST unchanged (agent-session.js was already whitelisted; the moved SQL went INTO an already-listed file; repos are inside storage/ by design).
- Runtime seams verified by tests: `agent-status.test.js` (agent-status behavior via the new store fakes), `phase4-book-model.test.js` (cancellation-signal-before-reset contract through the injected `agentSessionControl`), `txt-import-ownership.test.js`, `vbook-package-boundary.test.js` — all passing; the editor entity-cleanup seam test unchanged (its host contract did not change).



## 16. Final verdict

**PostgreSQL is and stays HOST-SIDE infrastructure.** It is not a product module, not an npm package, not a shared library: it is the canonical persistence truth of the host, reachable by host legs through repositories (preferred), a frozen whitelist of raw SQL (documented Phase-3 debt), and a now-frozen barrel channel. Product packages receive persistence exclusively through narrow, fail-closed, host-implemented ports — already true for all 14+1 packages, now enforced by guards on every channel. **No MODULE_LEAK exists. The one DEAD-LEGACY table reference (`scene_assets_cache`) was removed in Phase 2 (§15.1); the barrel raw-SQL baseline shrank 8 → 4 (§15.2), all remaining entries documented host composition. The rule from §5 is confirmed with two documented, necessary infra→contract exceptions.**

---

## 17. Appendix — full backend PG consumer list (52 files)

auth/auth-service.js; backend.cjs; audio/generation.js; image/iu-processor.js; middleware/ai-book-guard.js; middleware/auth-context.js; middleware/workspace-ownership.js; orchestration/{orchestrator,scene-callbacks,scene-orchestrator,scene-restoration}.js; routes/{admin,ai-connector,ai-endpoint,auth,generation,settings-ai,users,worker,worker-setup}-routes.cjs; routes/book/{agent,cache,generation,import,progress-panel,recent-books,versions}-routes(.cjs); runtime/{gpu-dispatcher,reconciliation-engine,runtime-scheduler,scene-window}.js; services/agent/{ai-caller,bootstrap}.js; services/agent-session{,-control}.js; services/ai-connector/{discovery,shared-pool}.js; services/{assistant-ports,book-deletion,book-event-log,book-sync,entity-cleanup,placeholder-audio,provider-gateway,scene-asset-registry,system-ai,worker-auth,workspace-ai-provider}(.js/.cjs); startup-resume.js; state/scene-state-ops.js; video/video-merge.js; workflows/video/video-workflows.js.
