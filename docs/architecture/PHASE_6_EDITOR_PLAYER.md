# Phase 6 — Editor / Player Architectural Boundaries

Status: implemented (minimal seams over the Canonical Book Model; legacy edges
pinned, not eliminated — see §6).
Predecessors: [Phase 1 guardrails](PHASE_1_GUARDRAILS.md),
[Phase 2 contracts](PHASE_2_CONTRACTS.md),
[Phase 3 provider gateway](PHASE_3_PROVIDER_GATEWAY.md),
[Phase 4 book model](PHASE_4_BOOK_MODEL.md),
[Phase 5 orchestration/runtime](PHASE_5_ORCHESTRATION_RUNTIME.md).

Recon date: 2026-09-04, against commit `b4035318` (Phase 5 close).

## 1. What the recon found

There is **no `backend/src/player/` and no `backend/src/editor/`** in the code
— "Player" and "Editor" are *logical* modules living inside route files:

| Logical module | Actual code | Backend deps it touched directly |
|---|---|---|
| **Player** (playback) | `routes/generation-routes.cjs` (media serving: `/scene/*/audio\|video\|image`, `/preview`, `/iu-image`, `/scene/*/status`, storyboard, timings), `routes/book/chunks-routes.cjs` (playback queue) | `book.loadBook` (raw loader), PG repos (`iu-repo`, `scene-assets-repo`, `book-repo`, `task-repo`), Redis (injected), runtime internals (`runtime/scene-window`, `job-schema`, `dispatch-engine`, `worker-health`), services (`ai-service`, orchestrators, `progress-pubsub`) |
| **Editor** (editing) | `routes/book/core-routes.cjs` (GET/PUT/PATCH book, metadata, cover, DELETE), `routes/book/entity-crud-routes.cjs` (add/delete characters/locations/voices/behaviors/chapters/scenes/units, blank book) | `book.loadBook` / `book.saveBookBundle` (raw loader + writer), PG repos, `orchestration/scene-restoration`, services (`source-coverage-audit`, `entity-cleanup`, `agent-prompts`) |
| **Book Model / VBook** | `backend/src/book/book-model.cjs` (Phase 4 facade) + `book/index.js` (canonical bundle load/save) + `book/lazy-book/**` (draft load) | canonical bundle on disk; identity via `manifest.json` |

The frontend Player/Editor consumers are `pages/PlayPage.tsx`,
`pages/NavigatePage.tsx`, `pages/EditPage.tsx`, `state/playbackStore.ts` and
friends; their network seam is `frontends/app/src/api/client.ts`.

Dependency direction before Phase 6:

```
Book Model → Player   : nothing (Player pulled from the raw book loader directly)
Book Model → Editor   : nothing (Editor pulled from the raw loader/writer directly)
Player/Editor → PG, Redis, runtime, orchestration, services : scattered direct deps
```

The facades below turn this into an explicit seam **without rewriting any of
those modules** (per phase constraints — no route rewrites, no file moves, no
behavior changes).

## 2. Player boundary

New facade: `backend/src/player/index.cjs` → `createPlayerModel(deps)`.

```
Player routes ──▶ playerModel ──▶ Canonical Book Model (book-model.cjs) ──▶ disk bundle
```

Contract (read-only by design):

| Method | Purpose |
|---|---|
| `loadBook(bookId, { mode })` | playback book content; `'full'` (canonical bundle) default, `'lazy'` (canonical-first, draft fallback) for in-progress books |
| `getBookIdentity(bookId)` | identity-only read (manifest), no content load |
| `getBookManifest(bookId)` | `manifest.json` read only |

- Delegates 1:1 to the Phase 4 Canonical Book Model facade; adds **no** new
  data source, **no** Redis/PG/runtime access of its own.
- The Player never mutates the model (that is the Editor boundary) and never
  writes runtime state (that belongs to runtime/orchestration).

Wiring: `backend.cjs` creates `playerModel = createPlayerModel({ bookModel })`
and passes it to routes via `routeDeps` (same DI pattern as `bookModel`).

Consumers migrated (Player contour reads):

- `routes/generation-routes.cjs` — `getEffectiveBuildId` (manifest is the
  single source of truth for `build_id`), scene type resolution in
  `/scene/*/status`, book-JSON fallbacks in storyboard/timings, cover lookup
  in `chunks-routes.cjs` assets-state.
- `routes/book/chunks-routes.cjs` — playback queue cover chapter read.

## 3. Editor boundary

New facade: `backend/src/editor/index.cjs` → `createEditorModel(deps)`.

```
Editor routes ──▶ editorModel ──▶ Canonical Book Model (book-model.cjs) ──▶ disk bundle
                     │
                     └─ commit ──▶ injected persistBook (book.saveBookBundle) ──▶ disk bundle
```

The three edit phases are explicit:

1. **READ** — `editorModel.read(bookId, { mode })`: loads the model via the
   Canonical Book Model (`'full'` default; `'lazy'` for draft books). `null`
   when the book does not exist.
2. **MODIFY** — deliberately **not** a facade operation: handlers transform
   the plain JSON-shaped model object they received from `read()`. Keeping
   mutation at the call site keeps the seam minimal and does not hide
   business rules (passport merge, prompt guards, id resolution) inside the
   boundary.
3. **COMMIT** — `editorModel.commit(book, files)`: persists through the ONE
   canonical bundle writer (`book.saveBookBundle`), injected at the
   composition root. **No new DB, no new format, no parallel storage path.**

`createEditorModel` throws without `persistBook` — an Editor facade that
cannot write canonically is a construction error, not a silent fallback.

Wiring: `editorModel = createEditorModel({ bookModel, persistBook:
book.saveBookBundle })` in `backend.cjs`.

Consumers migrated (Editor contour reads/saves):

- `routes/book/core-routes.cjs` — all 10 `book.loadBook` reads and all 7
  `book.saveBookBundle` writes now go through `editorModel.read/commit`
  (GET book, PUT book, scene PATCH, metadata, locations, characters, voices,
  behaviors, cover, source-coverage context).
- `routes/book/entity-crud-routes.cjs` — all entity CRUD reads/commits +
  blank-book create go through the facade.

## 4. Frontend API seam

`frontends/app/src/api/client.ts` owns the `/api/v1` base (`API_BASE`).
A new `mediaUrl(path)` seam covers DOM-embedded media (the fetch-based
helpers cannot serve `<img src>` / `new Audio()` / download links):

- `pages/NavigatePage.tsx` — `/api/v1/preview/...` unit thumbnails →
  `mediaUrl('/preview/...')`.
- `pages/EditPage.tsx` — `/api/v1/scene/.../audio` (waveform playback),
  `/api/v1/iu-image/...` (zoom), `previewUrl()` helper → `mediaUrl(...)`.
- `pages/AiAssistantPage.tsx` — `/api/v1/book/.../download` link →
  `mediaUrl('/book/...')`.

Only these five obvious violations were migrated (the task explicitly rules
out a mass frontend migration). `state/playbackStore.ts` already used
`API_BASE + scenePath(...)` through the client.

## 5. Allowed / forbidden dependencies

Allowed (from both facades and their layers):

```
Player/Editor  →  Canonical Book Model / VBook contract (backend/src/book/**)
Player/Editor  →  node builtins
Editor         →  injected canonical bundle writer (book.saveBookBundle)
Player/Editor routes → existing API/client seams (frontend: api/client.ts)
```

Forbidden (enforced statically for `backend/src/player/**` and
`backend/src/editor/**`; baselined for the route files, see §6):

- orchestration (`backend/src/orchestration/**`)
- runtime internals (`backend/src/runtime/**`)
- Redis (`ioredis`, Redis key families)
- PG / storage internals (`backend/src/storage/**`, raw `pg`)
- provider implementations (`services/provider-gateway.js`, `ai-service`,
  `ai-loader`, …)
- generation / workflows / video / audio / image pipeline internals

Architecture tests: `backend/tests/architecture/phase6-editor-player.test.js`
(T1–T7):

- **T1** Player facade exists, delegates to the injected Book Model, never a
  raw loader.
- **T2** Editor facade exists, `read`/`commit` only, throws without the
  injected canonical writer, requires no raw backend internals.
- **T3** structural scan: `player/**` and `editor/**` contain zero requires
  outside the Book Model layer (orchestration / runtime / Redis / PG /
  providers / services / routes / pipelines all rejected).
- **T4** composition-root wiring (`createPlayerModel`/`createEditorModel`
  with `bookModel` / `persistBook: book.saveBookBundle`) + routeDeps
  exposure + route destructuring.
- **T5** Editor contour routes have **no** direct `book.loadBook` /
  `book.saveBookBundle` calls; Player media routes read via `playerModel`;
  the legacy import leg in `generation-routes.cjs` is pinned at exactly 3
  direct calls so it cannot grow silently.
- **T6** frozen baseline of the remaining relative requires on the four
  contour route files — a NEW implementation-detail dep on any of them fails.
  Also: no route opens raw `pg`/`ioredis` connections.
- **T7** frontend `pages/` and `state/` contain no hardcoded `/api/v1/`
  string literals (comments excluded); `api/client.ts` owns the base and the
  `mediaUrl` seam.

## 6. Legacy edges that still exist (deliberately NOT migrated)

Phase 6 creates the seam; it does **not** rewrite the routes. These remain,
pinned by the T5/T6 baselines:

Player contour (`routes/generation-routes.cjs`):

1. The **import/generation leg** (`POST /generate`, `POST /book/:id/regenerate`,
   cancel/generate-next, hub result callbacks) still uses `book.loadBook`
   directly (3 pinned call sites: `diskCopyExists`, `existingBook`,
   `loadedBook` after save) and requires `runtime/scene-window`,
   `runtime/job-schema`, `runtime/dispatch-engine`, `runtime/worker-health`,
   PG repos (`book-repo`, `task-repo`, `generation-cancel-repo`), services
   (`ai-service`, `workspace-ai-provider`, `progress-pubsub.cjs`,
   `audio-orchestrator`, `video-orchestrator`), `middleware/auth-context`,
   `middleware/workspace-ownership`, `video/video-timeline`. Splitting
   generation away from playback serving is a **generation-pipeline
   refactor** — explicitly out of scope.
2. `routes/book/chunks-routes.cjs` keeps PG (`scene-assets-repo`) +
   `iu-progress-utils` — the playback queue merges derived PG progress with
   canonical content; separating the two is future work.

Editor contour (`routes/book/core-routes.cjs`, `routes/book/entity-crud-routes.cjs`):

3. `core-routes.cjs` still requires `storage/postgres/scene-assets-repo`,
   `orchestration/scene-restoration` (post-save derived-state sync),
   `services/source-coverage-audit`, `services/agent-prompts`, and local
   helpers (`scene-patch-utils.cjs`, `recover-chunks.cjs`). The
   read-modify-commit *model* flow now goes through the facade; the
   *derived-state fan-out* after a commit does not — moving it behind a
   "post-commit hooks" port is future work.
4. `entity-crud-routes.cjs` keeps `services/entity-cleanup.cjs` (Redis/PG
   purge on entity delete), `book/lazy-book/paths` (id generators — canonical
   helpers), `utils/entity-id`, `middleware/workspace-ownership` (wired lazily
   inside `POST /book/blank`).

Frontend:

5. Media embedding (`<img>`/`<audio>`/download URLs) now goes through
   `mediaUrl`, but no deeper frontend Player/Editor module split exists —
   the frontend remains a thin client by design.

Not touched at all (per constraints): VBook format, Book Model internals,
Provider Gateway, generation pipeline, runtime/orchestration, Redis protocol,
DB schema, public API shapes. Route registration order, HTTP paths, payloads
and behavior are unchanged — `routeDeps` merely grew two entries.

## 7. Honest status

The boundaries are real but thin: they change **where the Player/Editor get
the model** (one canonical source instead of scattered loaders), not **what
the Player/Editor are**. The route files still mix playback/generation/edit
concerns; the guardrails freeze their current dependency set so it cannot
grow, while `player/` and `editor/` are the anchor points future phases can
migrate toward (generation split, post-commit hook port, entity-cleanup port).
