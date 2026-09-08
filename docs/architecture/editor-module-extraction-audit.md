# Editor Module Extraction Audit — Editor contour → `packages/animastor-editor/`

**Status:** Phase 4 COMPLETE (physical move landed — `@animastor/editor@0.1.0`, see §Phase 4). Phase 3 COMPLETE (B1 resolved: `CYR_LATIN_MAP` + `cyrToLatin` extracted to the pure `cyr-latin-map` module, closure reduced from 5 to 3 host files — now moved INTO the package). Phase 2 (contract freeze + extraction-readiness audit). Phase 1 (route split) landed as `f24987ed`; Phase 1.1 (editor-ports.cjs zero host requires) landed as `c2b0fc2d`.
**Date:** 2026-09-08 (Phases 1/1.1/2/3)
**Baseline:** HEAD after Phase 3 (B1 resolved, all tests passing).
**Baseline:** HEAD `f41f0aad` ("arch(player): extract Player package" — the Player physical move landed **during** this audit; the measurement started against `9a794464` + the staged move and was re-verified against the landed commit, which is byte-identical to the staged set). All Editor-contour claims are measured against the landed tree, where Player files resolve from `packages/animastor-player/src/`.
**Context:** VBook runtime physically extracted (`@animastor/vbook-runtime@0.1.0`, commit `7175099d`); Player physically extracted (`@animastor/player@0.1.0`, commit `f41f0aad`); Editor is the next candidate in the extraction queue per `PHASE_NEXT_MODULE_EXTRACTION_RECONNAISSANCE.md` §4.7 / §6 (ranked #5, "after Player", shares the post-commit-hook port problem).
**Related:** `PHASE_6_EDITOR_PLAYER.md` (Editor facade T1–T7 guards), `PHASE_7_EXTRACTION_READINESS.md` §2.4 (Editor 🟠 verdict: facade 🟢 / contour 🟠), `PLAYER_ROUTE_SPLIT_CHECKLIST.md` (the route-split + physical-move playbook this audit follows), `VBOOK_EXTRACTION_READINESS_AUDIT.md` (upstream, COMPLETE), `MODULAR_PRODUCT_ARCHITECTURE.md` §6/§26 (graduation checklist).

---

## Executive summary

"Editor" in this repo is **one backend editing HTTP contour + three client editors over one shared API surface**, not a module:

1. **Backend edit model facade** — `backend/src/editor/index.cjs` (50 LOC, `createEditorModel` → `read`/`commit`, canonical writer injected). 🟢 Clean, guarded (Phase 6 T2/T3/T5), physically extractable the day the contour is — it is 1:1 analogous to `player-model.cjs` which just moved with the Player package.
2. **Backend editing HTTP contour** — `routes/book/core-routes.cjs` (753 LOC, 11 endpoints) + `routes/book/entity-crud-routes.cjs` (731 LOC, 15 endpoints) + local helpers (`scene-patch-utils.cjs` 93, `recover-chunks.cjs` 61). 🟡 The model flow already goes through `editorModel.read/commit` (Phase 6 T5); what still lives in the routes is the **read-time enrichment** (chapter titles, `is_special`, display indices, `scene_list`, placeholder/chunk recovery), the **post-commit derived-state fan-out** (bookSync reconcile, scene-asset version bumps, dirty-unit marking) and the **post-delete deep purge** (`entity-cleanup` → PG+Redis+FS+in-flight cancellation) — all via direct requires and `routeDeps`, exactly the shape the Player audit had pre-split, except Editor's legs are *ports*, not a 3-responsibility file mix.
3. **Web editor** — `pages/EditPage.tsx` (2895 LOC, the largest page in the app) + `lib/entityEditor.tsx` (424) + shared thin-client state (`playbackStore`, `generateStore`, `positionStore`, `resourceInvalidations`, `resilientReloader`, `api/client`). 🟡 Deliberately thin-client by design (same verdict as the Player audit §2: frontend stays app code, Android stays monolith).
4. **Android editor** — `EditFragment.kt` (3525 LOC) in a single-gradle-module app. 🟡 Parity is contractual (same 28-endpoint surface in `BackendApi.kt`), not code-shared.

**Verdict: READY AFTER PREPARATION (Medium 3/5)** — the same playbook the repo has now executed six times (worker, hub, contracts, LAC, vbook, player) applies directly: the Editor contour needs a **route split** (out of `book-routes.cjs` into `routes/editor/`), a **post-commit fan-out port** (one seam replacing 5 scattered derived-state legs — the exact item Phase 6 §6 named as future work), and an **entity-id/id-grammar port** (`utils/entity-id` + `book/lazy-book/paths` id generators → `@animastor/vbook-runtime`, which already exports `lazy-book/paths`). No file mixes three responsibilities; no cycles exist (Editor→Player reverse edge measured **ZERO**); the de-facto API contract is fully enumerable from three consumers (web/Android/tests).

| Question | Answer |
|---|---|
| Editor model facade extractable today | **YES** — 50 LOC, one dependency (`@animastor/vbook-runtime/book-model.cjs`), writer injected |
| Editing HTTP contour extractable today | **NO** — read-enrichment + post-commit fan-out + post-delete purge live in routes behind direct requires (7 host legs, §6) |
| De-facto Editor API contract enumerable | **YES** — 28 edit endpoints (11 core + 15 entity/structure CRUD + snapshot + /config), 3 consumers (web, Android, tests); no formal contract doc |
| Editor imports anything from Player | **NO** — reverse direction measured ZERO (§8); the two contours share only VBook + `GET /scene/*/timings`-family **Player routes** the web Editor *consumes over HTTP* (waveform/timings/IU-media/preview) |
| Player imports anything from Editor | **NO** — `playerModel`/player routes never touch `editorModel` or editor route files (grep-verified, both directions) |
| Can Editor⇄Player be one-directional | **YES, trivially** — it already is: `Editor(facade) → VBook ← Player(facade)`; the only Player⇄Editor runtime touchpoint is *frontend* invalidation callbacks, not code deps |
| Frontend part of the package | **NO (recommended)** — same verdict as Player audit: thin client stays app code; `lib/entityEditor` stays shared app-side |
| Hidden dependencies found | **YES** — id grammar (`entity-id` + `lazy-book/paths`) shared with VBook package; `IMAGE_PROMPT_MAX_CHARS` shared with `config-routes`/agent-prompts; `bookDiff`/`bookSync` shared with ai-routes/agent pipeline; entity-cleanup shared with book deletion flow |
| Forced upstream step | ~~Player physical move~~ **landed during this audit** (`f41f0aad`) → Editor route split → post-commit port → package |
| Extraction risk after preparation | **MEDIUM (3/5)** — same as Player post-split; below Hub (no cross-service Redis writes), above VBook (wider host fan-out: PG, Redis, FS purge, in-flight cancellation) |

---

## 1. Current Editor boundary (measured at HEAD + staged player move)

Phase 6 created the *model* seam (`read`/`commit` only, MODIFY stays at call site); Phase 6 T5/T6 froze the contour's legacy require set. Measured today:

```
                    ┌──────────────────────────────────────────────┐
                    │ backend/src/editor/index.cjs  (facade, 🟢)  │
                    │ createEditorModel({bookModel, persistBook}) │
                    │   read(bookId,{mode}) / commit(book,files)   │
                    └───────────────┬──────────────────────────────┘
                                    │ editorModel (routeDeps)
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           │
routes/book/core-routes.cjs   routes/book/entity-crud-routes.cjs │
(753 LOC, 11 endpoints:        (731 LOC, 15 endpoints:          │
 GET/PUT book, PATCH scene/     entity add/delete ×8,            │
  metadata/locations/characters/ chapter/scene/unit CRUD ×6,     │
  voices/behaviors, cover,      POST /book/blank)                 │
  DELETE book, source-coverage)                                   │
        │                           │                           │
        │  scene-patch-utils.cjs (93) ← both require (setDeep,  │
        │  findUnitInScene, normalizeFieldValue, rebuildFullText)
        │  recover-chunks.cjs (61) ← core-routes only            │
        ▼                           ▼                           │
  Direct host requires (§6): sceneAssetsRepo, scene-restoration, │
  source-coverage-audit, agent-prompts, entity-cleanup,          │
  entity-id, lazy-book/paths, workspace-ownership (lazy)        │
  + routeDeps: bookDiff, storage.bookSync, placeholderAudio,    │
    recoverMissingPlaceholders, saveChunk/getChunk/getAllChunks │
```

Frontend (web):

```
main.tsx ──route /edit──▶ pages/EditPage.tsx (2895)
    │ imports                        │ API calls (all through api/client seam — T7-guarded)
    ├▶ lib/entityEditor.tsx (424)    ├▶ GET/PUT /book/:id, PATCH scene/metadata/locations/
    ├▶ lib/waveform.tsx             │   characters/voices/behaviors, POST/DELETE entities,
    ├▶ lib/idgen.ts (ch-/sc-/iu-    │   chapters/scenes/units, POST /book/blank,
    │   hex8 client previews)       │   POST /book/:id/snapshot, GET /config
    ├▶ state/generateStore (bookId, ├▶ mediaUrl(): /scene/*/{audio,waveform}, /iu-image/*,
    │   buildId, dirtySummary)      │   /preview/*  ← PLAYER routes (HTTP, not code)
    ├▶ state/playbackStore          └▶ idempotent refetch → emitLocal(bookResource(id))
    │   (seekToPosition, invalidate-      → playbackStore.invalidateBookContent()
    │    DeletedScene/Chapter)
    ├▶ state/positionStore (navigateTo), state/resourceInvalidations,
    ├▶ state/resilientReloader (resilientReload on getJson<BookData>)
    └▶ api/client (getJson/putJson/patchJson/postJson/deleteJson/mediaUrl)
```

**Key property:** every canonical book read/write in the contour goes through `editorModel` (T5: 0 direct `book.loadBook`/`saveBookBundle` in `core-routes`/`entity-crud`); every frontend URL goes through `api/client.ts` (T7). The seams exist and are frozen — what does not exist is a *physical* `routes/editor/` contour and a port for the derived-state legs.

---

## 2. File / directory inventory

### 2.1 Backend — core Editor code

| File | LOC | Role | State |
|---|---|---|---|
| `backend/src/editor/index.cjs` | 50 | Phase 6 facade: `createEditorModel({bookModel, persistBook})` → `read`/`commit`; throws without writer | 🟢 guarded T2/T3 |
| `backend/src/routes/book/core-routes.cjs` | 753 | 11 endpoints: GET/PUT book, PATCH scene/metadata/locations/characters/voices/behaviors, GET cover, DELETE book, GET source-coverage | 🟡 model flow via facade; enrichment + fan-out in-route |
| `backend/src/routes/book/entity-crud-routes.cjs` | 731 | 15 endpoints: entity CRUD ×8, structure CRUD ×6, POST /book/blank | 🟡 model flow via facade; purge fan-out in-route |
| `backend/src/routes/book/scene-patch-utils.cjs` | 93 | Pure helpers: `setDeep`, `findUnitInScene`, `normalizeFieldValue`, `rebuildFullText` | 🟢 zero requires, shared by both route files + 4 test suites |
| `backend/src/routes/book/recover-chunks.cjs` | 61 | `recoverMissingRedisChunks` (read-time chunk repair, ctx-injected deps) | 🟡 touches `book.loadBook` raw (pre-T5 shape, ctx seam) |
| `backend/src/routes/config-routes.cjs` | 34 | `GET /api/v1/config` — editor limits (`IMAGE_PROMPT_MAX_CHARS`) + share flag | 🟡 Editor-adjacent; shared const with agent-prompts |

Editor-contour host legs (used **by** the routes, owned by services/orchestration/storage):

| Module | LOC | Role in Editor contour |
|---|---|---|
| `services/book-diff.cjs` | 513 | `computeBookDiff(old,new)` → dirty_scenes; **shared** with ai-routes, debug-routes, agent-routes, import-routes, recovery-routes, orchestrator, scene-state |
| `services/entity-cleanup.cjs` | 445 | `purgeScene`/`purgeUnit` deep cleanup (PG+Redis+FS+in-flight); **shared** with backend.cjs wiring (deletion/orchestrator flows) |
| `services/book-sync.js` (`storage.bookSync`) | — | `reconcileFromDiff`, `purgeRemovedSceneRows` — PG scene-asset reconciliation |
| `services/source-coverage-audit.js` | 147 | `auditBookCoverage` — GET source-coverage only |
| `orchestration/scene-restoration.js` | 114 | `restoreSceneChunkStatus` — **imported by core-routes but NOT CALLED at any route site** (vestigial require, §7 finding F3) |
| `utils/entity-id.js` | 40 | `toEntityId`, `isCanonicalEntityId` (transliteration → snake_case) — Editor-only consumer set |
| `services/agent-prompts.js` (const) | — | `IMAGE_PROMPT_MAX_CHARS` (save guard + `/config` limit — shared with config-routes) |
| `book/lazy-book/paths` | (VBook pkg) | `chapterId`/`sceneId`/`unitId`/`generateBookId` id generators — **already exported by `@animastor/vbook-runtime`** |
| `services/book-deletion.cjs` | 201 | `deleteBook` cascade — DELETE /book handler (adapters injected) |

### 2.2 Frontend (web) — Editor code

| File | LOC | Role |
|---|---|---|
| `frontends/app/src/pages/EditPage.tsx` | 2895 | The whole web Editor: entity tables, structure tree, passport editing, waveform/timings panel, scene editing, dialog flows |
| `frontends/app/src/lib/entityEditor.tsx` | 424 | Editor dialogs: `EntityEditorDialog`, `StructureAddDialog`, `BehaviorAddDialog`, `DeleteConfirmDialog`, `ENTITY_SCHEMAS` |
| `frontends/app/src/lib/idgen.ts` | ~30 | Client-side `ch-/sc-/iu-` hex8 previews (mirrors server grammar; server remains authority) |
| `frontends/app/src/lib/waveform.tsx` | ~150 | Waveform canvas component (shared with Player's Play page usage pattern) |

Shared state consumed (NOT editor-owned): `playbackStore` (invalidateDeletedScene/Chapter, seekToPosition, invalidateBookContent), `generateStore` (bookId/buildId/dirtySummary/onPlaybackPrepared), `positionStore`, `resourceInvalidations`, `resilientReloader`, `api/client`, `api/models`.

### 2.3 Android — Editor code

| File | LOC | Role |
|---|---|---|
| `frontends/android/.../ui/EditFragment.kt` | 3525 | The whole Android Editor (entity tables, structure CRUD, scene editing) |
| `frontends/android/.../repository/BackendApi.kt` | ~430 | 28 Editor endpoints declared (Retrofit surface) + Player endpoints adjacent |

---

## 3. Editor HTTP surface (de-facto contract: 26 endpoints in the two contour files + snapshot + /config = 28)

### 3.1 From `core-routes.cjs` (11) + adjacent editor-serving routes (2)

```
GET    /api/v1/book/:bookId                                  (read + enrichment + recovery)
GET    /api/v1/book/:bookId/source-coverage
GET    /api/v1/book/:bookId/cover
PUT    /api/v1/book/:bookId                                   (full replace + passport/bible merge)
PATCH  /api/v1/book/:bookId/scene/:chapterId/:sceneId         (scene | unit fields | full replace)
PATCH  /api/v1/book/:bookId/metadata
PATCH  /api/v1/book/:bookId/locations/:locationId
PATCH  /api/v1/book/:bookId/characters/:characterId
PATCH  /api/v1/book/:bookId/voices/:voiceId
PATCH  /api/v1/book/:bookId/behaviors/:characterId
DELETE /api/v1/book/:bookId                                   (via bookDeletion.deleteBook)
POST   /api/v1/book/:bookId/snapshot                          (parse-routes.cjs — EditPage autosave)
GET    /api/v1/config                                         (config-routes.cjs — editor limits)
```

### 3.2 From `entity-crud-routes.cjs` (15)

```
POST   /api/v1/book/:bookId/characters            DELETE /api/v1/book/:bookId/characters/:characterId
POST   /api/v1/book/:bookId/locations             DELETE /api/v1/book/:bookId/locations/:locationId
POST   /api/v1/book/:bookId/voices                DELETE /api/v1/book/:bookId/voices/:voiceId
POST   /api/v1/book/:bookId/behaviors             DELETE /api/v1/book/:bookId/behaviors/:characterId
POST   /api/v1/book/:bookId/chapters              DELETE /api/v1/book/:bookId/chapters/:chapterId
POST   /api/v1/book/:bookId/chapters/:chapterId/scenes
DELETE /api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId
POST   /api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId/units
DELETE /api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId/units/:unitId
POST   /api/v1/book/blank
```

### 3.3 Editor-consumed but Player-owned endpoints (HTTP, not code)

`GET/PUT /scene/:b/:ch/:sc/timings`, `GET /scene/:b/:ch/:sc/waveform`, `GET /scene/:b/:ch/:sc/audio`, `GET /iu-image/*`, `GET /preview/*` — the web Editor's waveform/timing panel and media previews call the **Player package routes**. This is the entire Player⇄Editor runtime integration on the web side (§8).

Consumers of the Editor surface: **web** (`EditPage.tsx`, 35 API call sites), **Android** (`EditFragment.kt` via `BackendApi.kt`), **tests** (§12). Auth: app-level ownership guards already apply at `backend.cjs` for book routes (same `requireBookAccess` family as Player).

---

## 4. Dependency map (backend)

### 4.1 Editor contour → inside

```
core-routes ──▶ scene-patch-utils (pure, shared w/ entity-crud + 4 test suites)
core-routes ──▶ recover-chunks (read-time repair; ctx-injected deps)
entity-crud ──▶ scene-patch-utils
both       ──▶ editorModel (facade) ──▶ @animastor/vbook-runtime/book-model.cjs (host shim)
entity-crud ─▶ @animastor/vbook-runtime/lazy-book/paths (id generators, via host shim book/lazy-book)
```

### 4.2 Editor contour → host (direct requires + routeDeps, the extraction cost)

| Edge | Via | What | Classification |
|---|---|---|---|
| `sceneAssetsRepo` (PG) | direct require (core) | `bumpSceneVersions`, `setDirtyUnitIds` | PORT (post-commit fan-out) |
| `storage.bookSync` | routeDeps | `reconcileFromDiff` | PORT (post-commit fan-out) |
| `bookDiff` | routeDeps | `computeBookDiff` | STAY host (shared w/ ai-routes etc.) → PORT as `computeDiff(old,new)` |
| `orchestration/scene-restoration` | direct require (core) | `restoreSceneChunkStatus` — **ZERO call sites** (vestigial) | DELETE (dead edge) |
| `services/source-coverage-audit` | direct require (core) | `auditBookCoverage` | PORT (`auditCoverage(bookId)`); service STAYS host |
| `services/agent-prompts` | direct require (core) | `IMAGE_PROMPT_MAX_CHARS` const | MOVE const → shared limits seam (config-routes already serves it over HTTP) |
| `services/entity-cleanup` | direct require (entity-crud) | `purgeScene`, `purgeUnit` | PORT (post-delete deep cleanup); service STAYS host |
| `utils/entity-id` | direct require (entity-crud) | `toEntityId`, `isCanonicalEntityId` | MOVE (Editor-only consumer set; or into vbook-runtime long-term — ADR) |
| `book/lazy-book/paths` | direct require (entity-crud) | `chapterId/sceneId/unitId/generateBookId` | VBOOK — import from `@animastor/vbook-runtime` directly (export exists) |
| `middleware/workspace-ownership` | lazy require (entity-crud, POST /blank) | `resolveWorkspaceForBook` | PORT (host ownership handshake) |
| `services/book-deletion` | routeDeps | `deleteBook(bookId)` | PORT (already adapter-injected service) |
| `placeholderAudio` | routeDeps (core) | `recoverMissingPlaceholders` (read-time repair) | PORT (read-repair leg) |
| `redis`, `saveChunk/getChunk/getAllChunks` | routeDeps (core) | read-time chunk recovery | PORT (read-repair leg) |
| `multer` (npm) | not needed | — | none (multer used by import routes only) |

### 4.3 Editor contour → Player

**ZERO code dependencies in both directions.** Verified:
- `grep editorModel backend/src/routes/player/**` (and now `packages/animastor-player/src/**`) → no hits;
- `grep playerModel backend/src/routes/book/core-routes.cjs entity-crud-routes.cjs` → no hits;
- Player route files require only intra-contour + node builtins (guard P2);
- `generation-routes.cjs` (the file that kept generation + editor-adjacent legs) registers no editor endpoints.

### 4.4 Cycles / SCC

**None.** The Editor contour is not a member of any SCC (the 14-module orchestration↔runtime↔services↔image SCC is pinned by P7-T7 and contains no editor route files; facade requires only the VBook shim). The frontend has one documented cycle (`generateStore ⇄ playbackStore`, runtime-only) — shared app state, not Editor-owned.

### 4.5 Host → Editor (inbound)

Today the only inbound consumer of `editorModel` outside the contour is `backend.cjs` (DI wiring). Frontends consume over HTTP. The AI assistant's `edit_book` tool (`chat-engine.cjs` + `routes/ai-routes.cjs`) writes books via `book.saveBookBundle` directly — **not** through `editorModel`; it is a *parallel editor-class writer* (§10 risk R5, same class as the pinned generation-leg calls the Player audit found).

---

## 5. Proposed module boundary

### 5.1 Editor Core (must move into the package)

```
packages/animastor-editor/            (@animastor/editor)
├── src/
│   ├── index.cjs                     package entry: createEditorModel + registrar export
│   ├── editor-model.cjs              ← backend/src/editor/index.cjs (moved, like player-model.cjs)
│   ├── editor-routes.cjs             ← routes/book/core-routes.cjs (registrar)
│   ├── entity-crud-routes.cjs        ← routes/book/entity-crud-routes.cjs
│   ├── scene-patch-utils.cjs         ← routes/book/scene-patch-utils.cjs (pure)
│   ├── read-recovery.cjs             ← routes/book/recover-chunks.cjs (ports arrive via ctx)
│   └── entity-id.cjs                 ← utils/entity-id.js (Editor-only consumers; ADR alt: vbook-runtime)
└── test/                             moved suites (§12.1)
```

Declarations for `bookDeletion.deleteBook`, `auditCoverage`, `purgeScene/purgeUnit`, `resolveWorkspaceForBook`, `/config` limits: these are **ports** (host implements) or **stay host-side** (config-routes serves `/config` — shared with non-editor clients; move only if ADR says so).

### 5.2 Shared/common (stays host or shared)

- `bookDiff` (513 LOC, 8+ consumers) — stays; injected as `computeDiff` port.
- `entity-cleanup` (445 LOC, shared with orchestrator) — stays; injected as `purgeScene/purgeUnit` port.
- `book-sync`, `scene-assets-repo`, `placeholder-audio`, `scene-restoration`, `source-coverage-audit` — stay host (PG/Redis/FS infra).
- `config-routes.cjs` — stays host (serves `/config` globally; the *limit constant* moves to the seam).
- `agent-prompts.js` — stays (agent domain); constant flows via the seam.
- Frontend: `EditPage.tsx` + `lib/entityEditor`, `lib/idgen`, `lib/waveform` stay app-side (thin client verdict); Android stays monolith.
- `state/{playbackStore,generateStore,positionStore,resourceInvalidations,resilientReloader}` — shared app state, stays.

### 5.3 External dependencies (Editor only uses)

- `@animastor/vbook-runtime` (book-model facade + `lazy-book/paths` id grammar) — package dependency, declared in package.json.
- node builtins only otherwise (the contour has no other npm requires — verified).

### 5.4 Doubtful places (need architectural decision)

| Item | Question |
|---|---|
| `utils/entity-id` home | Move with Editor vs move into vbook-runtime (id grammar territory)? Both defensible; see §11 |
| `IMAGE_PROMPT_MAX_CHARS` | Move constant into the package (Editor owns the save guard) and have host `/config` + agent-prompts import it? Direction reversal needs ADR |
| `scene-restoration` dead require | Delete at split time (behavior-neutral) or preserve frozen T6 baseline? Recommend delete + baseline update |
| `POST /book/blank` | Editor-scaffold (File page "Create visual book") — belongs to the contour; but it resolves *ownership* (workspace-ownership port) — keep as Editor endpoint with port |
| AI `edit_book` writer | Migrate to `editorModel.commit` in a later phase (contract change for chat-engine) or pin as parallel writer? Recommend pin + document, migrate post-extraction |
| Read-time recovery legs (`GET /book/:id`) | Port them (as `readRepair` port) or move the repair out of the read path entirely? The Player precedent ports generation-side effects (preview generation) — recommend port |

---

## 6. Post-commit / post-delete fan-out — the single architectural cost

One commit in the Editor triggers up to five derived-state legs, today inline in the routes:

```
editorModel.commit(book)
  ├─ bookDiff.computeBookDiff(old,new)                    (routeDeps)
  ├─ storage.bookSync.reconcileFromDiff(bookId, dirty, n) (routeDeps → PG)
  ├─ sceneAssetsRepo.bumpSceneVersions(bookId, dirty)      (direct require → PG)
  ├─ sceneAssetsRepo.setDirtyUnitIds(...)                   (direct require → PG)
  └─ [structure deletes only] entity-cleanup.purgeScene/purgeUnit
       (PG rows + Redis keys + FS files + in-flight GPU cancellation)
```

**Proposed port** (one seam, mirrors `playerPorts` exactly):

```js
editorPorts = {
    afterCommit: async ({ bookId, oldBook, newBook }) → { reconciled, dirtyScenes },
        // host impl: bookDiff + bookSync + sceneAssetsRepo bumps (PG writes stay host-side)
    afterStructureDelete: async ({ bookId, chapterId, sceneId?, unitId? }) → { complete, failed_steps },
        // host impl: entity-cleanup.purgeScene/purgeUnit (PG+Redis+FS+dispatch stays host-side)
    readRepair: async ({ buildId, bookId }) → void,
        // host impl: placeholderAudio.recoverMissingPlaceholders + recoverMissingRedisChunks
    auditCoverage: (bookId) → report,
        // host impl: services/source-coverage-audit
    deleteBook: (bookId) → result,
        // host impl: services/book-deletion (already adapter-injected)
    resolveOwnership: async (bookId, meta) → void,
        // host impl: middleware/workspace-ownership.resolveWorkspaceForBook (POST /blank)
}
```

All five are already function-shaped and DI-adjacent (T6 froze the require set; `bookDeletion` and `bookDiff` already arrive via routeDeps). No behavior change: same function references wired at the composition root, same call sites renamed to `ctx.editorPorts.*` — this is byte-for-byte the `playerPorts` narrowing that commit `9a794464` performed for the Player.

---

## 7. Additional findings (F1–F5)

- **F1 — Route parity contract exists de-facto.** 28 endpoints enumerable from three consumers; the Player split proved P1-style route-surface freezing works for this repo. Editor's split test can be authored before any move.
- **F2 — No express middlewares live in the contour.** Auth is app-level (backend.cjs `requireBookAccess` family wraps `/api/v1/book`), so the registrar needs zero auth knowledge — cleaner than the Player split (which had in-handler chunk-keyed ownership).
- **F3 — Vestigial require.** `core-routes.cjs:6` imports `restoreSceneChunkStatus` (114 LOC orchestration module) but **no route handler calls it**. Dead since an earlier migration; safe to delete at split (behavior-neutral, T6 baseline update required).
- **F4 — `scene-patch-utils` is the natural shared unit.** Pure, zero requires, consumed by both future Editor route files and 4 existing test suites (`scene-patch-utils`, `character-passport-patch`, `scene-passport-patch`, and indirectly `behavior-crud`). Moves cleanly.
- **F5 — Frontend invalidation contract is implicit.** After deletes, EditPage calls `playbackStore.invalidateDeletedScene/Chapter` *then* refetches; the AI assistant path uses `resourceInvalidations.emitLocal(bookResource(id))` → `playbackStore.invalidateBookContent`. Two parallel invalidation dialects; documenting this as the frontend "Editor⇄Player integration" contract (§8) is required before any future frontend packaging — but no change needed now.

---

## 8. Player ↔ Editor integration

| Direction | Code deps | Runtime touchpoints |
|---|---|---|
| Editor → Player (backend) | **NONE** | none (no shared modules; different route prefixes) |
| Player → Editor (backend) | **NONE** | none |
| Web Editor → Player (HTTP) | — | `GET/PUT /scene/:b/:ch/:sc/timings`, `GET /scene/.../waveform`, `GET /scene/.../audio`, `GET /iu-image/*`, `GET /preview/*` (EditPage waveform/timing panel, previews, audio playback via `mediaUrl`) |
| Web Editor → Player (frontend state) | — | `seekToPosition`, `invalidateDeletedScene/Chapter`, `invalidateBookContent` (via `resourceInvalidations`); `positionStore` shared read |
| Android Editor → Player | — | `PlaybackViewModel` shared scene/timings/waveform fetches (`BackendApi.kt` Player endpoints) |

**Dependency directionality: ALREADY one-directional and zero at the code level.** Both facades sit on the VBook runtime:

```
Editor (facade + contour) ──▶ @animastor/vbook-runtime ◀── Player (facade + contour)
```

**Contracts better in shared/core:** none are missing today. The only *candidates* for `@animastor/contracts`/vbook-runtime territory:
1. the entity-id / structure-id grammar (`utils/entity-id` + `lazy-book/paths` generators + the client-side mirror `lib/idgen.ts`) — a three-place duplication of one grammar (server authority, package generators, client preview);
2. the 28-endpoint HTTP surface — a contract doc (not necessarily code) should freeze it before the split, exactly as the Player checklist §2.6 did.

**Conclusion:** unlike Player (which needed a 3-responsibility file split first), Editor's Player relationship needs **no work at all** — extraction order Player-then-Editor is already satisfied by construction.

---

## 9. Editor vs VBook / other modules

- **VBook:** Editor's only book-content access is `editorModel.read/commit` → `@animastor/vbook-runtime` (host shims already in place). `lazy-book/paths` id generators: direct package import post-extraction (export exists). Extraction pulls **zero** VBook files with it.
- **Generator (generateStore, generation routes):** web-only coupling via shared signals (`bookId`/`buildId`/`dirtySummary`) and the *dirty-scene* protocol the fan-out produces — that is the HTTP/DB contract, not a code dep. Backend `generation-routes.cjs` shares only `routeDeps` plumbing with book-routes registration.
- **AI assistant (`ai-routes`, `chat-engine`):** parallel writer via `book.saveBookBundle` (§4.5, R5) + consumer of `bookDiff`. Stays host-side; pin, don't migrate now.
- **Config/limits:** `config-routes` + `agent-prompts` share the `IMAGE_PROMPT_MAX_CHARS` constant (§5.4).
- **Admin/website/mobile-web:** no code deps on the Editor contour (Admin uses its own routes; the editor endpoints are per-book).

**Nothing big gets dragged along:** total Editor Core is ~1,700 LOC backend + (frontend stays) — versus the extraction's port list of ~6 host functions. The extraction does **not** pull VBook, Player, generation, orchestration or services modules; they stay host-side behind ports.

---

## 10. Risks & blockers

| # | Risk/Blocker | Severity | Mitigation |
|---|---|---|---|
| R1 | ~~Player physical move in flight~~ **RESOLVED during this audit**: the move landed as `f41f0aad` before this document was committed; no `backend.cjs`/`package.json` collision remains | ~~P0~~ closed | Editor prep can start immediately; re-verify `backend.cjs` wiring against `f41f0aad` first (one-line registrar require now points at `@animastor/player`) |
| R2 | Post-commit fan-out is *behavioral* (version bumps drive regeneration) — port must preserve exact call order and best-effort semantics (warnings, not failures) | High | Port = same function references, composition-root wiring; pin with existing suites + new split parity test |
| R3 | `PUT /book` merge semantics (passport/bible preservation) are load-bearing for both clients | High | Character-passport/behavior suites already cover; add explicit PUT-merge cases before move |
| R4 | `bookDiff`/`bookSync` PG writes assume the diff contract (`dirty_scenes[].changes.units.unit_ids`) — an implicit schema between Editor and Generator | Medium | Document in the contract doc; keep both host-side (only the function reference crosses) |
| R5 | AI `edit_book` parallel writer bypasses `editorModel` (2 sites in ai-routes) | Medium | Pin (baseline guard "AI writer ≤ 2 direct saveBookBundle sites"), migrate post-extraction |
| R6 | Id grammar three-way duplication (server/port/client) | Medium | ADR: vbook-runtime as the single home vs Editor package owning `entity-id` |
| R7 | Android `EditFragment` (3525 LOC) parity relies on the same 28 endpoints | Medium | Route-parity freeze test (P1 analog) before the split |
| R8 | Test ownership: 9+ suites live in `backend/tests/` (§12) | Medium | Package-owned test dir per worker/player pattern (dual-location path helpers) |
| R9 | `POST /book/blank` resolves workspace ownership inside the Editor contour | Low | `resolveOwnership` port; ownership middleware stays host |
| R10 | `recover-chunks.cjs` reads via raw `book.loadBook` (pre-T5 shape) | Low | Re-point to `editorModel.read` at split time (behavior-neutral) |

**No cycles. No reverse deps into Player. No Redis/PG/raw `pg` opened by contour routes** (T6: "no contour route opens Redis or raw PG client connections directly" — verified). The contour is *narrower* than the Player contour was pre-split: its host legs are 6 function ports + 2 shared services + 1 dead require.

---

## 11. Files/components disposition summary

**MOVE** (physically transferable, no code change beyond import re-pointing):
`backend/src/editor/index.cjs` → `src/editor-model.cjs`; `routes/book/core-routes.cjs` → `src/editor-routes.cjs`; `routes/book/entity-crud-routes.cjs` → `src/entity-crud-routes.cjs`; `routes/book/scene-patch-utils.cjs` → `src/scene-patch-utils.cjs`; `routes/book/recover-chunks.cjs` → `src/read-recovery.cjs`; `utils/entity-id.js` → `src/entity-id.cjs` (or vbook-runtime per ADR).

**PORT** (host provides at composition root):
`editorModel` (VBook-backed), `editorPorts.{afterCommit, afterStructureDelete, readRepair, auditCoverage, deleteBook, resolveOwnership}`, `redis` + `saveChunk/getChunk/getAllChunks` (read-recovery ctx).

**STAY** (host infrastructure): `backend.cjs` wiring, `services/{book-diff,entity-cleanup,book-sync,source-coverage-audit,book-deletion,placeholder-audio,agent-prompts}.cjs`, `storage/postgres/repositories/scene-assets-repo`, `orchestration/scene-restoration` (its Editor edge deleted), `middleware/workspace-ownership`, `routes/config-routes.cjs`, frontend state modules, `pages/EditPage.tsx` + `lib/*` (thin client), Android app.

**VBOOK** (from `@animastor/vbook-runtime`): book-model facade, `lazy-book/paths` id generators.

**DELETE**: the `restoreSceneChunkStatus` require in core-routes (F3); `routes/book/chunks-routes.cjs` stub already slated by the Player move (not Editor's).

---

## 12. Tests

### 12.1 Existing coverage of the Editor contour (all in `backend/tests/`, host-owned)

| Suite | Covers |
|---|---|
| `entity-crud-routes.test.js` | entity create/delete, id transliteration, 409/404/400 paths (mounts real registrar) |
| `behavior-crud.test.js` | behaviors CRUD + dangling-entry cleanup (mounts real registrar) |
| `book-metadata-patch.test.js` | PATCH /metadata semantics, field preservation |
| `character-passport-patch.test.js` | passport patch paths + normalizeFieldValue (simulates handler) |
| `scene-passport-patch.test.js` | scene passport overrides + bookDiff dirty detection |
| `scene-patch-utils.test.js` | setDeep/findUnitInScene/rebuildFullText pure helpers |
| `behavior-edit-book.test.js` | AI edit_book ⇄ behavior contract (chat-engine) |
| `ai-editor-mode.test.js` | AI edit_book patch application + saveBookBundle bible preservation |
| `vbook-test-bindings.cjs` | shared BOOKS_DIR temp fixture |
| Architecture: `phase6-editor-player.test.js` T2/T3/T4/T5/T6, `phase7-extraction-readiness.test.js` | facade + frozen contour require baselines |

Frontend: `resourceInvalidations.test.ts` covers the invalidation dialect; **no EditPage component tests exist** (consistent with repo policy — pages are thin clients tested via state suites).

### 12.2 To move with the package

`entity-crud-routes`, `behavior-crud`, `book-metadata-patch`, `character-passport-patch`, `scene-passport-patch`, `scene-patch-utils` (+ `vbook-test-bindings` helper, dual-location pattern). `behavior-edit-book`/`ai-editor-mode` stay host-side (they test the AI writer, not the contour).

### 12.3 Missing before physical extraction (write-first, all behavior-neutral)

1. **Route-surface parity test** (E1, P1 analog): freeze the 28-endpoint surface from the three consumers (web grep + Android `BackendApi.kt` + tests) — protects against accidental registration loss at the split.
2. **Route-split require-isolation + reverse-direction guard** (E2/E3, P2/P3 analog): editor contour requires only intra-contour + node builtins + `@animastor/vbook-runtime`; generation/ai routes import no editor implementation.
3. **PUT /book merge regression cases** (passport preservation, bible preservation, manifest preservation) — currently exercised only end-to-end; make explicit before the move.
4. **POST /book/blank contract case** (ownership attach failure is non-fatal) — currently only covered indirectly.
5. **T6 baseline update test** at split time (new seam shape: `editorPorts` keys pinned exactly).

---

## 13. Migration plan (proposed; NOTHING executed by this audit)

Precondition ~~P0~~ **satisfied**: the Player physical move landed as `f41f0aad` during this audit (staged set → identical commit). Step 0 before starting: re-read `backend.cjs` registration against the landed Player wiring (the registrar require now resolves from `@animastor/player`) — Editor steps touch the same file.

1. **Route split** (behavior-neutral, mirrors `4d1f6f0e`): create `backend/src/routes/editor/` with `editor-routes.cjs`, `entity-crud-routes.cjs`, `editor-ports.cjs` (port shape from §6); move `scene-patch-utils`/`recover-chunks` alongside; delete the dead `scene-restoration` require (F3); update `book-routes.cjs` to delegate; **E1/E2/E3 guard tests authored first** (Player playbook P1–P3). Baselines T5/T6 re-pinned.
2. **Seam narrowing** (mirrors `9a794464`): replace the five scattered legs with `editorPorts` at the composition root — same function references, zero behavior change; `recover-chunks` re-pointed to `editorModel.read` (R10); `lazy-book/paths` import re-aimed at `@animastor/vbook-runtime`.
3. **Contract doc** (zero runtime change): `EDITOR_HTTP_CONTRACT.md` — the 28 endpoints + payloads + merge semantics + dirty-scene protocol + frontend invalidation dialect (F5) + AI-writer pin (R5).
4. **Test ownership split** (§12.2): package-side test dir; dual-location path helpers per worker/player precedent.
5. **Physical move**: `packages/animastor-editor/` skeleton (package.json: dep `@animastor/vbook-runtime` only); `git mv` MOVE list; `backend.cjs` requires the registrar from `@animastor/editor`; delete vacated stubs; run full backend + player + architecture suites; single atomic commit.
6. **Post-landing**: architecture guard extension (`editor-package-boundary.test.js`, the phase10d/`vbook-package-boundary` analog); optional later phases: AI-writer migration to `editorModel`, `entity-id`→vbook-runtime ADR.

Steps 1–3 are independently landable; each is guarded and reversible.

---

## 14. Estimated complexity

| Dimension | Rating |
|---|---|
| **Overall** | **Medium (3/5)** — after preparation steps 1–3 |
| Route split (step 1) | **Low** — 2 registrars + 2 pure helpers, no file mixes three responsibilities (Player's split was harder) |
| Seam narrowing (step 2) | **Medium** — the post-commit fan-out port is 6 functions but behavior-sensitive (R2/R4); read-repair port is mechanical |
| Contract + tests (steps 3–4) | **Low** — enumerable surface, existing suites |
| Physical move (step 5) | **Low** — the repo's 6th execution of the same playbook; zero reverse deps |
| Blockers | 0 structural (the sequencing blocker closed: Player move landed `f41f0aad` during this audit) |
| Extractable without behavior change | Everything in the MOVE list; `scene-restoration` edge deletion |
| Requires contract change first | `editorPorts` seam (new, behavior-neutral), T5/T6 baseline updates (ADR-class per §27.2.3 convention) |

---

## 15. Public API / contracts of the future package

**Package exports** (`@animastor/editor`):

- `createEditorModel({ bookModel, persistBook })` → `{ read(bookId, opts?), commit(book, files?) }` (unchanged, Phase 6 T2)
- `createEditorRoutes(app, ctx)` / `createEntityCrudRoutes(app, ctx)` — registrars, byte-identical HTTP surface
- `scenePatchUtils` — `{ setDeep, findUnitInScene, normalizeFieldValue, rebuildFullText }` (pure, re-exported for tests)
- `entityId` — `{ toEntityId, isCanonicalEntityId }` (or delegated to vbook-runtime per ADR)
- `editorPorts` interface (the §6 contract — host implements)

**The rest of the system sees** (instead of Editor internals): the 28-endpoint HTTP surface (frozen by E1), `editorModel` (VBook-aligned read/commit), and `editorPorts` implementations at the composition root. Nothing outside the package may require its route internals (E3).

**Host-owned contracts Editor participates in but does not own:** dirty-scene diff protocol (bookDiff), `/config` limits, artifact naming (Player package), workspace ownership handshake.

---

## 16. Recommended next step

**The Player physical move has landed (`f41f0aad`, during this audit).** Next: run the Editor route split (step 1 of §13) as a single behavior-neutral commit with E1–E3 guard tests authored first — the exact shape of the Player's `4d1f6f0e`. In parallel (doc-only, no code): the `EDITOR_HTTP_CONTRACT.md` freeze. Then the seam narrowing (step 2) lands as its own commit, and the physical move becomes a low-risk mechanical step.

Before starting, re-verify `backend.cjs`/`backend/package.json` against the landed Player wiring — the Editor steps edit the same files (registrar require, dependency block).

---

# Phase 4 — Physical Move (`packages/animastor-editor/`, `@animastor/editor`)

**Scope:** the single atomic physical-move commit of §13 step 5. The frozen Editor contour (Phase 1 route split + Phase 1.1 ports seam + Phase 2 contract freeze + Phase 3 B1 resolution) is carried verbatim into `packages/animastor-editor/` as `@animastor/editor@0.1.0`. NO behavior change, NO HTTP change, NO port change, NO business-logic refactor — this is extraction, not redesign.
**Date:** 2026-09-08
**Baseline:** HEAD after Phase 3 (`d27529d9`).
**Playbook:** the Player physical move (`f41f0aad`), executed without deviation.

## P4.1 What moved

Production code (all `git mv`, byte-identical except header comments + import re-pointing):

| Old host path | New package path | Notes |
|---|---|---|
| `backend/src/routes/editor/editor-routes.cjs` | `packages/animastor-editor/src/editor-routes.cjs` | 11 endpoints, handlers unchanged |
| `backend/src/routes/editor/entity-crud-routes.cjs` | `packages/animastor-editor/src/entity-crud-routes.cjs` | 15 endpoints, handlers unchanged |
| `backend/src/routes/editor/editor-ports.cjs` | `packages/animastor-editor/src/editor-ports.cjs` | the frozen 7-port seam, carried as-is |
| `backend/src/routes/editor/scene-patch-utils.cjs` | `packages/animastor-editor/src/scene-patch-utils.cjs` | pure, zero requires |
| `backend/src/routes/editor/read-recovery.cjs` | `packages/animastor-editor/src/read-recovery.cjs` | ctx-injected, zero requires |
| `backend/src/editor/index.cjs` | `packages/animastor-editor/src/editor-model.cjs` | the Phase 6 facade (T2) |
| `backend/src/utils/entity-id.js` | `packages/animastor-editor/src/entity-id.js` | Editor-only consumer set (audit §5.1 ADR) |
| `backend/src/utils/cyr-latin-map.js` | `packages/animastor-editor/src/cyr-latin-map.js` | B1 pure module — now INSIDE the package |
| (new) | `packages/animastor-editor/src/index.cjs` | package entrypoint (public API) |

Import re-pointing (the only production-code edits):
- `entity-crud-routes.cjs`: `../../utils/entity-id` → `./entity-id.js`; `../../book/lazy-book/paths` → `@animastor/vbook-runtime/lazy-book/paths` (the export already existed — the host shim is no longer in the closure);
- `editor-model.cjs`: `../book/book-model.cjs` → `@animastor/vbook-runtime/book-model.cjs` (same dependency the Player facade uses);
- `backend/src/image/helpers.js` (host consumer of the moved map): `../utils/cyr-latin-map` → `@animastor/editor/cyr-latin-map.js` — the map's canonical home is the package; the host image domain follows it (B1 stays resolved: still a pure zero-dependency module).

Tests moved (ownership transfer — zero assertion changes; see P4.5):

| Old host path | New package path |
|---|---|
| `backend/tests/entity-crud-routes.test.js` | `packages/animastor-editor/test/entity-crud-routes.test.js` |
| `backend/tests/behavior-crud.test.js` | `packages/animastor-editor/test/behavior-crud.test.js` |
| `backend/tests/character-passport-patch.test.js` | `packages/animastor-editor/test/character-passport-patch.test.js` |
| `backend/tests/scene-passport-patch.test.js` | `packages/animastor-editor/test/scene-passport-patch.test.js` |
| `backend/tests/scene-patch-utils.test.js` | `packages/animastor-editor/test/scene-patch-utils.test.js` |
| `backend/tests/vbook-test-bindings.cjs` | `packages/animastor-editor/test/vbook-test-bindings.cjs` (thin wrapper) + canonical source restored at `backend/tests/vbook-test-bindings.cjs` |

Per Phase 2 §P2.4 the prompt-builder assertions in `character-passport-patch`/`scene-passport-patch` moved WITH the suites but still require the host `image/prompt-builder` + host `book-diff` through explicit repo-relative paths — the package test closure drags no host module INTO the package; the host-side assertion split recommendation is satisfied by keeping the requires host-pinned (they resolve via `../../../backend/src/...`).

`vbook-test-bindings` becomes the dual-location fixture (worker/player pattern): the canonical host-owned source stays at `backend/tests/vbook-test-bindings.cjs` (required by `.mocharc.json` + 9+ host suites); the package copy is a one-line re-export so the fixture cannot fork.

## P4.2 Package public API

`@animastor/editor` (main: `src/index.cjs`) exports exactly:

```js
const { createEditorModel, createEditorRoutes, createEntityCrudRoutes } = require('@animastor/editor');
```

Internal modules are reachable ONLY through the export map (`./editor-routes.cjs`, `./entity-crud-routes.cjs`, `./editor-ports.cjs`, `./scene-patch-utils.cjs`, `./read-recovery.cjs`, `./editor-model.cjs`, `./entity-id.js`, `./cyr-latin-map.js`) — no `src/` deep imports. Declared dependency: `@animastor/vbook-runtime` ONLY.

Host consumption (composition root, `backend.cjs` + `routes/book-routes.cjs`):
- `createEditorModel` from the package entrypoint;
- `editorPorts` assembled via `require('@animastor/editor/editor-ports.cjs')({ deps })`;
- registration via `require('@animastor/editor/editor-routes.cjs')` / `entity-crud-routes.cjs` through the package export map.

Host shims kept (relocation checklist §2.4, one-line re-exports, guard E3 freezes them):
- `backend/src/routes/editor/index.cjs` → `module.exports = require('@animastor/editor');`
- `backend/src/editor/index.cjs` → `module.exports = require('@animastor/editor');`

The old contour paths (`routes/editor/{editor-routes,entity-crud-routes,editor-ports,scene-patch-utils,read-recovery}.cjs`, `routes/book/{core-routes,entity-crud-routes}.cjs`, `routes/book/{scene-patch-utils,recover-chunks}.cjs`, `utils/entity-id.js`, `utils/cyr-latin-map.js`) are **deleted** — no parallel Editor implementation exists.

## P4.3 Final dependency closure (verified, not assumed)

```
packages/animastor-editor/src/**  (9 files)
├─ node builtins only (0 otherwise)
├─ @animastor/vbook-runtime/book-model.cjs     (editor-model.cjs)
├─ @animastor/vbook-runtime/lazy-book/paths    (entity-crud-routes.cjs)
└─ intra-package requires (index/registrars/helpers/entity-id→cyr-latin-map)
```

- **ZERO host modules reachable** from the package require closure (E6 walk: registrars + helpers reach only intra-package files; the former 3-file host shim chain — `book/lazy-book/paths.js`, `utils/entity-id.js`, `utils/cyr-latin-map.js` — is fully absorbed).
- **B1 stays resolved:** no `image/helpers`, no `utils/string-utils`, no `config/runtime-config` anywhere in the package (guard scans every package file).
- **editorPorts frozen:** the same 7 ports (`sceneAssetsRepo`, `placeholderAudio`, `auditCoverage`, `promptLimit`, `purge`, `resolveOwnership`, `recoveryCtx`), identity pass-through, mandatory ports fail-closed (E5 re-verified against the moved seam); wiring still happens ONLY at the composition root (`backend.cjs` E5 wiring test re-pinned to the package path).
- **No editorPorts bypass:** zero lazy requires in handler bodies, single deps destructuring, no agent/generation/AI imports (E8 unchanged).
- **Editor ⇄ Player: ZERO code deps in both directions** (grep-verified over both package src trees; the only `player` mentions in the Editor package are doc comments referencing the `playerPorts` precedent).
- **`git mv` rename detection:** all 8 moved production files + 6 test files land as renames (R status) — byte-level provenance proven.

## P4.4 Host integration changes

| File | Change |
|---|---|
| `backend/package.json` | + `"@animastor/editor": "file:../packages/animastor-editor"` |
| `backend/src/backend.cjs` | `createEditorModel` from `@animastor/editor`; `editorPorts` via the package export map |
| `backend/src/routes/book-routes.cjs` | the two registrar requires now go through `@animastor/editor/...` |
| `backend/src/image/helpers.js` | imports the moved cyr-latin map from the package |
| `backend/tests/vbook-test-bindings.cjs` | restored (canonical fixture; the move landed it in the package, the host .mocharc requires it here) |

## P4.5 Tests — what changed and why (ownership, not behavior)

| Change | Kind |
|---|---|
| 6 suites moved to `packages/animastor-editor/test/` with re-pointed requires (`../src/...` → package exports / `../../../backend/src/...` for host collaborators) | **ownership** — same assertions, same fixtures, same expectations (75 passing before and after) |
| E1–E3 + E4–E8 guards re-pinned to the physical boundary (`EDITOR_DIR` → package src; E2 allowlist gains the `@animastor/vbook-runtime/` bare specifier; E3 sanctioned edges become the package export map; E6 closure = ZERO host files; E7 flips the move gate: package EXISTS, manifest pinned; E5 wiring regex → package path) | **ownership/boundary** — the guards now guard the real package boundary instead of the pre-move staging boundary |
| T-baselines (phase6) + P7-T4 raw-book baseline: `routes/editor/...` paths → `packages/animastor-editor/src/...`; the `entity-crud` entry leaves the raw-book baseline (id grammar is now a package export, not a `backend/src/book` path) | **ownership** — same rule, new physical location |
| `phase4-book-model.test.js` + `vbook-bundle-schema.test.js`: source-scan paths re-pointed to the package files | **ownership** — the scanned producers moved |
| NO test asserting HTTP semantics, status codes, payloads, merge rules, purge behavior or port shape had its expectation edited | — (0 behavior changes) |

## P4.6 Endpoint verification

Functional registration through the package entrypoint (the exact host wiring): **26 endpoints** — `get:3, put:1, patch:6, delete:8, post:8` — byte-identical surface to the Phase 2 freeze; guard E1 re-verifies the frozen 26-pair table against the moved registrars on every run.

## P4.7 New architectural decisions (explicit)

1. **`entity-id` + `cyr-latin-map` live in the Editor package** (the audit §5.4 ADR resolves to "move with Editor", not vbook-runtime): `entity-id` is Editor-only; the host image domain imports the map through the package export map (`@animastor/editor/cyr-latin-map.js`), keeping ONE canonical source.
2. **The `lazy-book/paths` host shim leaves the Editor closure:** the package imports the VBook runtime export directly (the shim stays for other host consumers, untouched).
3. **Test fixture dual-location:** `vbook-test-bindings` canonical source stays host-side (`backend/tests/`), package copy is a re-export wrapper — same pattern as worker/player.
4. **Host shims kept** at `routes/editor/index.cjs` + `editor/index.cjs` (one-line re-exports, frozen by E3) per the relocation checklist §2.4.

## P4.8 Verdict

**READY — extraction complete.** `@animastor/editor@0.1.0` is the single Editor implementation; the host consumes only the package entrypoint + export map; ports, HTTP surface and behavior are unchanged and guarded.

## P4.9 Verification (Phase 4 commands + exact results)

- Package tests: `cd packages/animastor-editor && npm test` → **75 passing, 0 failing** (301ms).
- Package/Editor suites via backend workspace: `cd backend && npx mocha --exit ../packages/animastor-editor/test/scene-patch-utils.test.js ../packages/animastor-editor/test/entity-crud-routes.test.js ../packages/animastor-editor/test/behavior-crud.test.js ../packages/animastor-editor/test/character-passport-patch.test.js ../packages/animastor-editor/test/scene-passport-patch.test.js` → **75 passing, 0 failing**.
- Architecture guards (ALL suites, not a subset): `cd backend && npm run test:arch` → **635 passing, 0 failing** (2s).
- Editor guards specifically: `cd backend && npx mocha --exit tests/architecture/editor-route-split.test.js` → **11 passing** (E1–E3); `tests/architecture/editor-extraction-readiness.test.js` → **20 passing** (E4–E8 + B1); `tests/architecture/phase6-editor-player.test.js` → **18 passing** (T1–T7); `tests/architecture/phase7-extraction-readiness.test.js` → **12 passing** (P7-T1..T8).
- Full backend suite: `cd backend && npx mocha --exit "tests/**/*.test.js"` → **3162 passing, 5 failing** (2m). The 5 failures are **pre-existing and unrelated** (identical on the unmodified tree, verified by `git stash` before/after): 3× LLM-sharing suites + 1× worker-share-policy (PG/env-dependent integration suites failing the same way on HEAD), 1× flaky C21 timeout observed only under the full-suite run. Count delta vs Phase 3's "575": the Phase 3 figure was the mocha default config (`npm test` = `.mocharc.json` pretest + `tests/**/*.test.js` at that tree state); the tree has since gained the C19/C19.1/C20/C21 AI-contour suites, LLM-sharing suites and worker-share suites (measured HEAD baseline: **3214 passing / 10 failing** on the PRE-move tree vs **3162 passing / 5 failing** post-move — the same 5 pre-existing failures, with the C21 suites now stable in the post-move run; 75 Editor functional tests moved OUT of the backend glob into the package's own runner).
- Syntax smoke: `bash scripts/syntax-smoke.sh backend` → **all production JS/CJS files pass**.
- Endpoint contract: functional mount via the package entrypoint → **26 endpoints** (`get:3 put:1 patch:6 delete:8 post:8`), identical to the frozen table; E1 asserts it every run.
- Boundary greps: package src requires → only builtins + `@animastor/vbook-runtime/*` + intra-package; Editor→Player and Player→Editor source scans → **ZERO**; old host contour paths → deleted (`src/editor/index.cjs` + `src/routes/editor/index.cjs` remain as one-line shims).
- Ports: identity pass-through + fail-closed re-verified against the moved `createEditorPorts` (E5).

---

## Verification (read-only commands executed during this audit)

- Endpoint enumeration: `grep -rh "app\.(get|put|patch|post|delete)('/api/v1/book" backend/src/routes/book/*.cjs | sort -u` (26 edit endpoints in the two contour files + snapshot + /config inventoried).
- Reverse-dep scans: `editorModel`/`core-routes`/`entity-crud` across `backend/src/**` and `backend/tests/**`; `playerModel` inside editor files (zero); editor requires inside player files (zero).
- Require inventories: `core-routes.cjs` (6 top-level requires), `entity-crud-routes.cjs` (4 + lazy workspace-ownership), sub-registrar wiring in `routes/book-routes.cjs` + `backend.cjs:255,280`.
- Frontend: EditPage import block + 35 API call sites (all via `api/client`); playbackStore invalidation exports; Android `BackendApi.kt` editor/structure endpoint declarations; `EditFragment.kt` size.
- Tests: 8 editor-family suites + 4 architecture guards read; frontend state test inventory.
- Working tree: `git status` (12 staged player-move entries at measurement time; the move landed as `f41f0aad` before this document was committed — baseline caveat resolved, claims re-checked against the landed commit).
- VBook package exports (`packages/animastor-vbook-runtime/package.json`) — `lazy-book/paths` export confirmed.

Nothing in the repository was modified by this reconnaissance.

---

# Phase 2 — Contract Freeze & Extraction Readiness Audit

**Scope:** full dependency/contract/test audit of `backend/src/routes/editor/**` + `editor-ports.cjs` after Phase 1 (route split `f24987ed`) and Phase 1.1 (ports seam zero host requires `c2b0fc2d`). No runtime behavior changed, no physical move, no `packages/animastor-editor` created (guarded — E7).
**Guards added:** `backend/tests/architecture/editor-extraction-readiness.test.js` (E4–E8, 17 tests) extending the Phase 1 E1–E3 suite (`editor-route-split.test.js`).
**Method:** static require-closure walk + member-access matrix (E4) + functional port-object validation (E5) + HTTP parity re-verification against the pre-split tree (`f24987ed~1`) + test-consumer enumeration (web `EditPage.tsx`, Android `BackendApi.kt`, backend suites).

## P2.1 Dependency matrix (measured, frozen)

The contour = 5 files (1,742 LOC total): `editor-routes.cjs` (764, 11 endpoints), `entity-crud-routes.cjs` (738, 15 endpoints), `editor-ports.cjs` (83, seam), `scene-patch-utils.cjs` (93, pure), `read-recovery.cjs` (64, ctx-injected), plus the model facade `backend/src/editor/index.cjs` (50, 🟢 Phase 6).

### P2.1.1 require() edges (module scope — zero host requires in the contour)

| File | requires | Classification |
|---|---|---|
| `editor-routes.cjs` | `./scene-patch-utils.cjs`, `./read-recovery.cjs` | intra-contour |
| `entity-crud-routes.cjs` | `../../utils/entity-id`, `./scene-patch-utils.cjs`, `../../book/lazy-book/paths` | id grammar (see B1) |
| `scene-patch-utils.cjs` | **none** | pure |
| `read-recovery.cjs` | **none** (ctx-injected) | pure |
| `editor-ports.cjs` | **none** (Phase 1.1) | seam |

### P2.1.2 Transitive closure — B1 (RESOLVED in Phase 3)

The require closure of the contour (registrars + helpers) reaches exactly:

```
routes/editor/** (intra-contour)
└─ backend/src/book/lazy-book/paths.js       — PURE SHIM: one-line re-export of
                                               @animastor/vbook-runtime/lazy-book/paths
└─ backend/src/utils/entity-id.js           — Editor-only transliteration (move candidate)
    └─ backend/src/utils/cyr-latin-map.js   — PHASE 3: pure CYR_LATIN_MAP + cyrToLatin
                                               (zero deps; extracted from image/helpers.js)
```

**B1 — RESOLVED in Phase 3:** the old hidden chain (`entity-id → image/helpers → string-utils → runtime-config`) is gone. `cyrToLatin` is now imported from the standalone `utils/cyr-latin-map.js` (pure data + function, zero dependencies). The closure contains 3 host files (down from 5), all pure/editor-domain. See §P3.

### P2.1.3 deps legs (injected at registration — frozen by E4)

`editor-routes.cjs(app, redis, deps)` consumes **exactly** (12 legs):
`book.collectSceneList`, `bookDeletion.deleteBook`, `bookDiff.computeBookDiff`, `editorModel.{read,commit}`, `editorPorts.{auditCoverage, placeholderAudio, promptLimit, recoveryCtx, sceneAssetsRepo}`, `storage.bookSync`, `utils.log`. (`redis` is accepted but NOT destructured/used — pre-split signature shape.)

`entity-crud-routes.cjs(app, redis, deps)` consumes **exactly** (5 legs):
`editorModel.{read,commit}`, `editorPorts.{purge, resolveOwnership}`, `utils.log`. (`redis` likewise unused.)

`read-recovery.cjs` ctx (8 fields, contract in header): `{ redis, book, state, activeScenes, config, getAllChunks, saveChunk, log }` — consumed: `book.loadBook`, `book.collectScenes`, `redis.get/set`, `config.{BOOK_SCENE_TOTAL, BOOK_SCENE_NEXT}`, `getAllChunks()`, `saveChunk()`, `log()`. `state`/`activeScenes` ride the ctx for wiring-completeness (documented, unused by the repair itself — the GPU-scheduler registration note).

### P2.1.4 Cross-contour dependencies (measured)

| Direction | Result |
|---|---|
| Editor → Player (code) | **0** — no `animastor-player`/`playerModel`/`playerPorts` specifiers anywhere in the contour (E2 + E6 closure) |
| Player → Editor (code) | **0** — no package file requires an editor module (E7) |
| Editor → generation/AI/agent domain | **0** — no `agent|generation|ai-` specifiers (E8) |
| Packages → Editor | **0** across player/vbook-runtime/worker/parser/contracts (E7) |
| Host → contour implementation | **2 sanctioned edges only**: `book-routes.cjs` delegation + `backend.cjs` ports wiring (E3, Phase 1) |
| Global state / `process.env` / direct Redis-PG clients in contour | **0** (E2 + T6 re-verified) |
| Cycles | **0** — contour is not in any SCC |

## P2.2 Public API / contract freeze

### P2.2.1 Editor ports (the seam — frozen by E5, functional)

`createEditorPorts({ deps })` → port object with **exactly 7 keys** (identity pass-through, no wrapping — the pre-split host function references flow through):

| Port | Host implementation (stays host-side forever) |
|---|---|
| `sceneAssetsRepo` | `storage/postgres/repositories/scene-assets-repo` (`bumpSceneVersions`, `setDirtyUnitIds`) — mandatory, fail-closed |
| `placeholderAudio` | `services/placeholder-audio` (`recoverMissingPlaceholders`) — mandatory, fail-closed |
| `auditCoverage` | `services/source-coverage-audit` (`auditBookCoverage`) |
| `promptLimit` | `services/agent-prompts.IMAGE_PROMPT_MAX_CHARS` (agent-domain constant, value 2000 — shared with `GET /config`) |
| `purge` | `services/entity-cleanup` (`purgeScene`, `purgeUnit`) |
| `resolveOwnership` | `middleware/workspace-ownership.resolveWorkspaceForBook` (POST /blank) |
| `recoveryCtx` | `{ redis, book, state, activeScenes, config, getAllChunks, saveChunk, log }` (read-recovery) |

### P2.2.2 Route registrars (frozen by E1, Phase 1 — re-verified byte-identical vs `f24987ed~1`)

`editor-routes.cjs` — 11 endpoints; `entity-crud-routes.cjs` — 15 endpoints; **26 total, method+path parity exact vs the pre-split tree** (verified functionally by E1 and re-diffed against `git show f24987ed~1` during this audit — identical). Registration order, handlers, HTTP semantics unchanged.

### P2.2.3 Models that STAY host-side (never move)

`bookModel`/VBook runtime (the facade wraps it), `bookDiff` (8+ host consumers), `entity-cleanup`, `book-sync`/`scene-assets-repo` (PG), `placeholder-audio`, `source-coverage-audit`, `book-deletion`, `book-model`/`saveBookBundle` writer, `workspace-ownership`, `agent-prompts` (agent domain), `config-routes` (`GET /config` serves the shared limit globally), `image/helpers` (image domain — B1 target), all Redis/PG/FS infrastructure, auth middleware (app-level `requireBookAccess` family).

### P2.2.4 Internal implementation — NOT public API

Everything inside the contour files below the registrar surface: `setDeep`/`findUnitInScene`/`normalizeFieldValue`/`rebuildFullText` (pure helpers, re-exported for tests only), `recoverMissingRedisChunks`, prompt-guard internals (`assertPromptLength`/`findOversizedPromptInScene`/`PROMPT_PATH_KEYS`), entity CRUD helpers (`resolveId`/`buildPassport`/`buildLocation`/`resolveStructureId`), the read-time enrichment rules (F5/F7 chapter titles, `is_special`, display indices, `scene_list`). The future package exports **only**: `createEditorModel`, the two route registrars, and (for tests) the pure helpers — mirroring `@animastor/player`'s `index.cjs` surface.

## P2.3 HTTP contract (frozen)

26 endpoints — the E1 `EDITOR_ROUTES` table is the canonical freeze (11 core + 15 entity/structure CRUD). Verified in Phase 2:
- **No changes vs baseline**: registered surface re-diffed against the pre-split files — identical method+path pairs, byte-for-byte.
- **No Player/generation leakage**: `NON_EDITOR_ROUTE_LITERALS` guard (E1) — zero hits; the player-owned paths (`/scene/*/timings`, `/scene/*/waveform`, `/iu-image/`, `/preview/`, `/book/:id/chunks`, `/book/:id/assets-state`) and generation paths (`/generate`, `/worker/*`) never appear in contour registrations or literals.
- **Consumers**: web `EditPage.tsx` (all 26 via `api/client` seam — T7), Android `BackendApi.kt` (all 26 declared), backend suites. `POST /book/:id/snapshot` (parse-routes) and `GET /config` (config-routes) remain host-side by design (Phase 1 decision, unchanged).
- **Editor→Player integration is HTTP-only** (waveform/timings/IU-media/preview endpoints consumed by the web Editor's panel) — no code dependency either direction.

## P2.4 Test ownership

### Move with the package (Phase 3, per the worker/player dual-location precedent)

| Suite | Mounts | Notes |
|---|---|---|
| `entity-crud-routes.test.js` | real registrar + real entity-cleanup over mocked storage/runtime | pure-port stubs; already seam-shaped |
| `behavior-crud.test.js` | both real registrars | editorPorts stub |
| `character-passport-patch.test.js` | handler simulation + real `scene-patch-utils` | also requires `image/prompt-builder` (host read-side check — split the assertions at move time) |
| `scene-passport-patch.test.js` | handler simulation + real `scene-patch-utils` + real bookDiff | same split note |
| `scene-patch-utils.test.js` | pure helpers only | moves as-is |
| `vbook-test-bindings.cjs` | shared temp-BOOKS_DIR fixture | dual-location helper |

### Stay host-side (backend/integration)

`book-metadata-patch.test.js` (simulates the handler against the host book module — no contour file mounted; rewrite as registrar-mounted before the move or it stays as a host model test), `config-routes.test.js` (host `/config` endpoint; asserts the shared constant), `ai-editor-mode.test.js` + `behavior-edit-book.test.js` (AI writer, not the contour), `book-diff-unit.test.js` (host service), `phase4-book-model.test.js` / `vbook-bundle-schema.test.js` (host model/schema; they *read* contour source for version pins — keep host-side), architecture guards E1–E8/T2–T6 (host-owned by design; they guard the host↔package boundary).

### Tests accidentally checking host internals — found and classified

- `character-passport-patch`/`scene-passport-patch` call `image/prompt-builder` (host read-side) to assert regeneration effects — legitimate as host integration tests; flagged so they are NOT moved with the package (they would drag `image/` into the package test closure). Recommendation: at move time, split the prompt-builder assertions into a host-side suite.
- No suite asserts contour internals beyond the pure helpers + registrar mounts — no test depends on host implementation details *through* the contour.

## P2.5 Architecture guards (Phase 2 additions)

New suite `backend/tests/architecture/editor-extraction-readiness.test.js`:

| Guard | Freezes |
|---|---|
| **E4** | deps member matrix of both registrars + read-recovery ctx fields (a new host leg = conscious matrix update) |
| **E5** | editorPorts shape: exactly 7 keys, identity pass-through, fail-closed on missing mandatory legs, composition-root wiring of all 7 |
| **E6** | the transitive require closure: only intra-contour + the 3 pinned host files (B1 resolved: `entity-id → cyr-latin-map`, no image/string-utils/runtime-config); `lazy-book/paths` stays a pure shim; `scene-patch-utils` stays pure |
| **E7** | package future boundary: contour = exactly 5 files; no package requires editor modules; `packages/animastor-editor` does NOT exist yet (physical-move gate) |
| **E8** | no editorPorts bypass: zero `require()` inside handler bodies (lazy host legs), deps destructured once (no secondary `deps.*` access), no agent/generation domain imports |

Together with Phase 1's E1 (26-endpoint surface + no leakage), E2 (require isolation + ports zero-require + no Redis/PG + no Player), E3 (reverse direction), and Phase 6's T2/T3/T4/T5/T6, the boundary is now fully pinned: **any new Editor→host edge, host→Editor edge, port-shape change, or HTTP surface change fails CI**.

## P2.6 Extraction readiness — can Editor move without host modules?

**YES.** The move set is exactly: 5 contour files + `backend/src/editor/index.cjs` (facade) + 6 test files (+ fixture) + the id-grammar legs (`entity-id.js` + `cyr-latin-map.js`). Everything else — every PG repo, Redis helper, service, middleware, orchestration/runtime module — arrives through the frozen ports seam and **stays host-side forever**. B1 is resolved: `entity-id` → `cyr-latin-map` is a pure, zero-dependency module — the cleanest possible extraction boundary.

## P2.7 Blockers

| # | Item | Severity | Status |
|---|---|---|---|
| B1 | `utils/entity-id` transitive closure reaches `image/helpers` → `utils/string-utils` → `config/runtime-config` (the `cyrToLatin` map) | ~~Medium~~ | **RESOLVED in Phase 3**: `CYR_LATIN_MAP` + `cyrToLatin` extracted to `utils/cyr-latin-map.js` (pure, zero deps). Closure reduced from 5 to 3 host files. See §P3. |
| — | No other blockers: zero reverse deps, zero cycles, zero Player/generation coupling, zero globals, HTTP surface frozen, ports frozen, test ownership enumerable | — | clear |

## P2.8 Verdict

**READY FOR PHYSICAL MOVE** — B1 resolved in Phase 3 (§P3.7). The 6 test files move per P2.4 with the prompt-builder assertions split out host-side; the move is executed as the single atomic playbook commit (skeleton → `git mv` → registrar require swap → E7 package-boundary gate flipped to the new path, mirroring the Player's `phase10d`/`vbook-package-boundary` pattern).

## P2.9 Verification (Phase 2 commands — pre-B1-resolve baseline)

- Guards: `npx mocha --exit tests/architecture/editor-extraction-readiness.test.js` → **17 passing** (E4–E8, pre-B1-resolve).
- Editor suites: `entity-crud-routes`, `behavior-crud`, `character-passport-patch`, `scene-passport-patch`, `scene-patch-utils`, `book-metadata-patch`, `config-routes`, `ai-editor-mode` → **108 passing**.
- Editor-family combined run (guards E1–E8 + T1–T7 + 5 functional suites) → **154 passing, 0 failing**.
- Full backend suite at freeze time: **572 passing, 0 failing** (two earlier C17/C18-boundary failures observed mid-audit were resolved by the parallel C19/C19.1 AI commits `aeb8b775`/`dd85db71`; re-verified clean after rebase of the working state — no Editor-related failures at any point).
- HTTP parity: E1 functional registration (26 pairs) + `git show f24987ed~1` endpoint diff — identical.
- Closure walk: E6 pins the 5-file host closure; `book/lazy-book/paths.js` verified as the exact one-line shim.

**Post-B1-resolve (Phase 3):** guards → 21 passing; combined → 124 passing; full suite → 575 passing, 0 failing. See §P3.8.

Nothing in the Editor runtime changed in Phase 2: zero production-code edits — only the new guard suite and this document.

---

# Phase 3 — Resolve B1 Extraction Boundary

**Scope:** eliminate blocker B1 (`entity-id → image/helpers → string-utils → runtime-config`) by extracting the pure transliteration map into a zero-dependency module. No runtime behavior change, no HTTP semantics change, no physical package move, no port contract change.
**Date:** 2026-09-08
**Baseline:** HEAD after Phase 2 commit (`358c2155`).

## P3.1 What B1 was

The Phase 2 audit found a single hidden dependency chain in the Editor contour's transitive require closure:

```
entity-crud-routes.cjs → utils/entity-id.js → image/helpers.js (cyrToLatin)
    → utils/string-utils.js → config/runtime-config.js
```

`entity-id.js` imported only `cyrToLatin` from `image/helpers.js`. But `image/helpers.js` also imported `getOutputPath`/`escapeRegExp` from `string-utils.js`, which in turn imported `config.OUTPUT_DIR` from `runtime-config.js`. This dragged the entire host config/utility chain into the Editor contour's closure — the single hidden host implementation edge.

## P3.2 Chosen resolution

Extract `CYR_LATIN_MAP` + `cyrToLatin` into `utils/cyr-latin-map.js` — a **pure data + one pure function** module with **zero** dependencies. Both `entity-id.js` and `image/helpers.js` import from this canonical source. The transitive chain collapses:

```
BEFORE (B1):
  entity-id → image/helpers → string-utils → runtime-config   (4 host modules)

AFTER (B1 resolved):
  entity-id → cyr-latin-map                                    (1 host module, pure)
```

**Why this is safe:**
- `CYR_LATIN_MAP` and `cyrToLatin` are pure data + a one-line char-by-char mapper — zero side effects, zero config, zero I/O.
- Both consumers (`entity-id.js` and `image/helpers.js`) already used only this function + map from `image/helpers.js`. No behavioral change.
- `image/helpers.js` re-exports `CYR_LATIN_MAP` + `cyrToLatin` so its existing consumers (`character-utils.js`, `prompt-builder.js`, `video-workflows.js`) are unaffected.
- `utils/cyr-latin-map.js` has zero `require()` calls — it is the simplest possible module in the codebase.

## P3.3 Changed files

| File | Change |
|---|---|
| `backend/src/utils/cyr-latin-map.js` | **NEW** — canonical `CYR_LATIN_MAP` + `cyrToLatin` (zero deps) |
| `backend/src/utils/entity-id.js` | `require('../image/helpers')` → `require('./cyr-latin-map')` (1 line) |
| `backend/src/image/helpers.js` | imports `CYR_LATIN_MAP`/`cyrToLatin` from `../utils/cyr-latin-map` instead of defining inline; re-exports unchanged |
| `backend/tests/architecture/editor-extraction-readiness.test.js` | E6 closure walk updated: ALLOWED_HOST_FILES reduced from 5 to 3 (removed `image/helpers.js`, `string-utils.js`, `runtime-config.js`); 4 new B1-resolution guards added |

## P3.4 Dependency closure (post-B1-resolve)

The contour's transitive require closure now reaches exactly **3 host files** (down from 5):

```
routes/editor/** (5 intra-contour files)
└─ book/lazy-book/paths.js       — pure shim: re-export of @animastor/vbook-runtime
└─ utils/entity-id.js            — Editor-only id transliteration
    └─ utils/cyr-latin-map.js    — pure CYR_LATIN_MAP + cyrToLatin (zero deps)
```

**Gone:** `image/helpers.js`, `utils/string-utils.js`, `config/runtime-config.js` — no longer in the closure.

## P3.5 Ports / contract

No port changes. `editorPorts` is unchanged (7 ports, same shape). `entity-id.js` is a module-scope require, not a port — it stays as-is. The `promptLimit` port (`IMAGE_PROMPT_MAX_CHARS`) is unrelated to B1 and unchanged.

## P3.6 Guards (strengthened E6)

New E6 assertions in `editor-extraction-readiness.test.js`:

| Guard | Freezes |
|---|---|
| E6 closure walk | closure = exactly 3 host files (lazy-book/paths + entity-id + cyr-latin-map); no image/string-utils/runtime-config |
| **B1-resolution** (new) | explicit check: `image/helpers.js`, `string-utils.js`, `runtime-config.js` NOT in closure |
| **cyr-latin-map purity** (new) | `utils/cyr-latin-map.js` has zero requires, exports `CYR_LATIN_MAP` + `cyrToLatin` |
| **entity-id import path** (new) | `entity-id.js` requires `./cyr-latin-map`, NOT `../image/helpers` |

Total E6 tests: 7 (up from 4 in Phase 2). Total editor-extraction-readiness suite: 21 (up from 17).

## P3.7 Verdict

**READY FOR PHYSICAL MOVE** — B1 is resolved. The contour's transitive closure contains only pure/intra-contour modules + the vbook-runtime shim. No `config/runtime-config`, no `utils/string-utils`, no `image/helpers` anywhere in the closure. The single remaining host dependency beyond the shim is `entity-id.js` + its pure `cyr-latin-map` — both are editor-domain id-grammar modules that move with the package at Phase 3 time.

## P3.8 Verification (Phase 3 commands)

- B1 guards: `cd backend && npx mocha --exit tests/architecture/editor-extraction-readiness.test.js` → **21 passing** (E4–E8 + 4 B1-resolution tests).
- Editor-family combined run (E1–E8 + T1–T7 + functional suites): `cd backend && npx mocha --exit tests/architecture/editor-extraction-readiness.test.js tests/architecture/editor-route-split.test.js tests/architecture/phase6-editor-player.test.js tests/entity-crud-routes.test.js tests/behavior-crud.test.js tests/character-passport-patch.test.js tests/scene-passport-patch.test.js tests/scene-patch-utils.test.js` → **124 passing, 0 failing**.
- Full backend suite: `cd backend && npm test` → **575 passing, 0 failing**.
- Syntax smoke: `bash scripts/syntax-smoke.sh backend` → all production JS/CJS files pass.
- Functional verification: `node -e "const e = require('./src/utils/entity-id'); console.log(e.toEntityId('Привет мир'))"` → `privet_mir` (identical to pre-B1-resolve).`/
