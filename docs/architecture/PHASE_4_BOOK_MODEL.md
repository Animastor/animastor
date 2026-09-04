# Phase 4 — Canonical Book Model

Status: implemented. Commit series: `arch: add phase 4 canonical book model`.
Predecessors: [Phase 1 guardrails](PHASE_1_GUARDRAILS.md), [Phase 2 contracts](PHASE_2_CONTRACTS.md), [Phase 3 provider gateway](PHASE_3_PROVIDER_GATEWAY.md).

## 1. Canonical Book Model

The Canonical Book Model is a **facade**, not a rewrite: `backend/src/book/book-model.cjs`.
It gives every consumer one stable internal entry point for book access instead of
letting them choose between independent loaders:

```
                    ┌─────────────────────┐
                    │   Book Model API     │
                    │ loadBook(id, mode)   │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        Canonical Bundle   PG derived      Runtime state
        / content          indexes         / ephemeral
```

The facade hides the internal difference between the two existing loaders:

| Internal loader | Lives in | Reads | Historical use |
|---|---|---|---|
| canonical bundle load | `backend/src/book/index.js` (`loadBook`) | `manifest.json`, `book.json`, `bible.json`, `locations.json`, `voices.json`, `behavior.json`, `characters.json`, `chapters/<chapter>.json` (per `chapters_order`) | "what is canonically on disk" |
| draft load | `backend/src/book/lazy-book/draft.js` (`loadDraftBook`) | `manifest.json`, `book.json`, `source.txt`, characters/mentions/bible/locations/voices, **all** files in `chapters/` (skips bad ones) | in-progress import / agent state |

## 2. Full vs Lazy loading

```js
bookModel.loadBook(bookId, { mode: 'full' }); // canonical bundle representation
bookModel.loadBook(bookId, { mode: 'lazy' }); // lazy representation, no clean full load required
```

- **full** — delegates to the canonical bundle load (`book.loadBook`). Returns the
  book exactly as canonically stored on disk; `null` when the book is absent.
- **lazy** — canonical-first, draft-fallback: the canonical bundle when it loads,
  otherwise the draft/import state (`loadDraftBook`). This is the unified semantics
  that consumers previously inlined as
  `book.loadBook(bookId) || lazyBook.loadDraftBook(bookId)` (the AI-chat context
  fallback chain). A corrupt/absent canonical chapter set does not prevent lazy
  access — the draft loader tolerates bad chapter files, so an in-progress book
  remains servable without a full canonical load.
- **Defaults** — `mode` defaults to `'full'` when omitted.

Error contract (both modes):

- `BookModelError` with stable `code`:
  - `INVALID_BOOK_ID` — bookId missing / not a non-empty string;
  - `INVALID_MODE` — mode is not `'full'` / `'lazy'`.
- `null` — book not found (never throws for absence; identical to both loaders today).
- Loader-internal failures resolve to `null` (lazy mode falls through to the draft path).

## 3. Identity / ownership boundary

- **Book identity** = `manifest.book_id` from the single canonical `manifest.json`.
  Both full and lazy modes resolve identity from the same manifest — there is no
  per-mode identity. `bookModel.getBookIdentity(bookId)` reads only the manifest and
  returns `{ bookId, canonicalBookId, vbookVersion, state }`;
  `bookModel.getBookManifest(bookId)` returns the parsed manifest only.
- **Ownership is PostgreSQL-primary**: `books`, workspace membership, source relation
  are owned by `backend/src/storage/postgres/**` (and the ownership guards in
  `backend.cjs`). The Book Model does **not** read or decide ownership; it assumes the
  caller is authorized (route-level workspace guards run before the model is used).

## 4. Canonical bundle vs derived PG

| Layer | Storage | Contents | Rebuildable? |
|---|---|---|---|
| Canonical | disk bundle (`BOOKS_DIR/<bookId>/`) | chapters, scenes, asset references, manifest, bible, locations, voices, behaviors, characters, source text | source of truth — never derived |
| Derived | PostgreSQL | `scenes` rows, `image_units`, `asset_states`, `generation_tasks`, search/content indexes, snapshots, caches | yes — derived from the bundle |

The canonical bundle is what full/lazy modes return. PG rows are projections used by
the runtime/editor for querying; they may be rebuilt from the bundle. The Book Model
never writes derived PG data (that remains the job of the sync/cleanup services).

## 5. Runtime / Redis boundary

Redis and other ephemeral state are **not part of the Canonical Book Model**:

- active audio/image/video (`animastor:runtime:active-*`), queues, dispatch leases,
  chunk caches, retry/fairness/scenario state, runtime execution data;
- the Book Model facade contains no Redis dependencies (enforced by
  `tests/architecture/phase4-book-model.test.js`, T4);
- runtime-state cleanup belongs to the **deletion boundary** (below), not to loading.

## 6. `loadBook(bookId, { mode })` contract

Single source of truth: `backend/src/book/book-model.cjs`.

| Method | Purpose |
|---|---|
| `loadBook(bookId, { mode })` | unified loader, modes `full` / `lazy` (see §2) |
| `getBookIdentity(bookId)` | identity-only read (manifest) — §3 |
| `getBookManifest(bookId)` | manifest-only read — §3 |
| `BookModelError` | stable error codes `INVALID_BOOK_ID` / `INVALID_MODE` |
| `MODE_FULL` / `MODE_LAZY` | mode constants |

Wiring: `backend.cjs` adds `bookModel` to `routeDeps`; route modules receive it via
dependency injection (same pattern as `book`, `lazyBook`).

## 7. Delete / purge boundary

New seam: `backend/src/book/book-deletion.cjs` → `createBookDeletion(deps).deleteBook(bookId, options)`.

- `DELETE /api/v1/book/:bookId` (`backend/src/routes/book/core-routes.cjs`) no longer
  implements the cascade itself — it calls `bookDeletion.deleteBook(bookId)` and maps
  result/exception to HTTP.
- The full cascade was moved **verbatim** (behavior preserved, no DB migrations):
  1. canonical: disk bundle removal (`book.resetBook`) + snapshot file;
  2. build output dirs;
  3. cancel-first ordering (Redis `cancelled-workers` signal + PG agent-session
     cancel **before** purge — the agent must observe cancellation);
  4. runtime/ephemeral: scene-window cancel flag, active-audio/image/video keys,
     all book-keyed key families (`cleanBookRedisKeys`);
  5. derived PG: per-table deletes (`image_units` … `book_snapshots`, `books` last
     for FK order), each individually try/caught;
  6. best-effort GPU-hub queue clear.
- Adapters (`redis`, `storage`, `getAllChunks`, `getChunk`, `cleanBookRedisKeys`,
  `setCancelFlag`) are injected from `backend.cjs`; the book layer itself does not
  require runtime/Redis modules.
- `options` is reserved for future decomposition (e.g. selective purge); today
  `deleteBook(bookId)` has the exact historical behavior.

## 8. Consumers already using the facade

- `backend/src/routes/ai-routes.cjs` — both chat context loads
  (`POST /api/v1/ai/chat`, `POST /api/v1/ai/chat/stream`) now use
  `bookModel.loadBook(bookId, { mode: 'lazy' })` instead of the inline
  `book.loadBook(...) || lazyBook.loadDraftBook(...)` chain.
- `backend/src/routes/book/core-routes.cjs` — book deletion goes through
  `bookDeletion.deleteBook`.

## 9. Consumers not yet migrated (deliberately)

Per "boundary first, migration later":

- **Draft-only pipeline consumers** (`import-routes.cjs`, `parse-routes.cjs`,
  `status-routes.cjs`, `recent-books-routes.cjs`, `agent/bootstrap.js`,
  `txt-importer.js`, `source-coverage-audit.js`, `placeholder-audio.js`) — they call
  `loadDraftBook` directly because their intent **is** the lazy/draft state
  (bootstrap, resume, coverage). Not a loader-ambiguity; migrating them adds no value
  yet. Candidates later: `getBookManifest` instead of hand-rolled manifest reads.
- **Canonical-content read seam** (`services/book-source.js`) already wraps
  `book.loadBook`; migrating it to the facade is a no-op today and can happen when
  full/lazy diverge further.
- **Post-write reload fallbacks** in `core-routes.cjs`
  (`book.loadBook(id) || updatedBookData`) are in-memory fallbacks, not loader
  selection — out of scope.
- **Runtime orchestration** (`scene-orchestrator.js`, `scene-window.js`,
  `redis-helpers.cjs`, `reconciliation-engine.js`) loads books inside runtime loops;
  migration belongs to a later runtime-facing phase.

## 10. Known technical debt / next steps

- The "lazy" mode still loads all draft chapter files; true incremental (windowed)
  lazy loading would be a lazy-book internals change behind the same facade.
- `getBookIdentity`/`getBookManifest` re-read `manifest.json` per call; caching can be
  added inside the facade without changing the contract.
- Deletion cascade still fans out over ~24 PG tables inline; next decomposition step
  is per-domain purge services behind the same `deleteBook` contract (no schema
  changes needed).
- Architecture-test note: `npm test`'s mocha glob `tests/**/*.test.js` is expanded by
  the shell without globstar, so root-level `tests/*.test.js` are skipped by the
  script (pre-existing; `npx mocha --exit "tests/**/*.test.js"` quoted runs them).
  Two arch suites fail on master and are unrelated to this phase:
  `phase2-job-protocol-v2.test.js` (job_id type family anchor) and
  `phase2-lac-transport-contract.test.js` (LAC registry doc pin).
