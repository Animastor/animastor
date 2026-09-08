# Editor Module Extraction Audit — Editor contour → `packages/animastor-editor/`

**Status:** READ-ONLY reconnaissance. No production code changed, no refactor performed, no files moved, no package created. Only this document was added.
**Date:** 2026-09-08
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
| Forced upstream step | Player physical move **landing** (staged, in flight) → Editor route split → post-commit port → package |
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
| R1 | **In-flight Player physical move** (staged, uncommitted) collides with any Editor action in `backend.cjs`/`package.json` | P0 until landed | Do not start Editor prep until the Player move commits; audit re-baselined against it |
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

Precondition **P0**: the staged Player physical move lands as its atomic commit (working tree is dirty with it — do not touch `backend.cjs`/`package.json` until it does).

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
| Blockers | 1 sequencing (P0: Player move in flight), 0 structural |
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

**After the Player physical move lands (P0):** run the Editor route split (step 1 of §13) as a single behavior-neutral commit with E1–E3 guard tests authored first — the exact shape of the Player's `4d1f6f0e`. In parallel (doc-only, no code): the `EDITOR_HTTP_CONTRACT.md` freeze. Then the seam narrowing (step 2) lands as its own commit, and the physical move becomes a low-risk mechanical step.

Do **not** start while the Player move is uncommitted: both edit `backend.cjs` registration and `backend/package.json`.

---

## Verification (read-only commands executed during this audit)

- Endpoint enumeration: `grep -rh "app\.(get|put|patch|post|delete)('/api/v1/book" backend/src/routes/book/*.cjs | sort -u` (26 edit endpoints in the two contour files + snapshot + /config inventoried).
- Reverse-dep scans: `editorModel`/`core-routes`/`entity-crud` across `backend/src/**` and `backend/tests/**`; `playerModel` inside editor files (zero); editor requires inside player files (zero).
- Require inventories: `core-routes.cjs` (6 top-level requires), `entity-crud-routes.cjs` (4 + lazy workspace-ownership), sub-registrar wiring in `routes/book-routes.cjs` + `backend.cjs:255,280`.
- Frontend: EditPage import block + 35 API call sites (all via `api/client`); playbackStore invalidation exports; Android `BackendApi.kt` editor/structure endpoint declarations; `EditFragment.kt` size.
- Tests: 8 editor-family suites + 4 architecture guards read; frontend state test inventory.
- Working tree: `git status` (12 staged player-move entries — the P0 baseline caveat).
- VBook package exports (`packages/animastor-vbook-runtime/package.json`) — `lazy-book/paths` export confirmed.

Nothing in the repository was modified by this reconnaissance.
