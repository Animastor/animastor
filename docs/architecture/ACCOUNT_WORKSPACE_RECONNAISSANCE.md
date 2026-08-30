# Account & Workspace Reconnaissance

**Status:** Reconnaissance / Research (no code changed)
**Date:** 2026-08-19
**Source of truth:** existing docs + code (`docs/architecture/ACCOUNT_WORKSPACE_CONCEPT.md`, `backend/src/**`, `gpu-hub/**`, `worker/**`, `frontends/**`, `proxy/conf/default.conf`, `docker-compose.yml`)

---

## 1. Executive Summary

### What Already Exists
- **PostgreSQL as canonical state** — 30+ tables (`backend/src/storage/postgres/schema.js`), schema applied idempotently on startup (`runMigrations`), everything keyed on `book_id` as aggregate root.
- **Dormant `users` foundation**: tables `users`, `books.user_id`, `chat_sessions.user_id` exist in the schema, but **no query in the application uses them** (grep across `storage/postgres/repositories/*` and all of `backend/src` yields zero INSERT/SELECT on `users`). This is not auth but a "skeleton for the future."
- **Ready identification layer**: bookId, buildId, chapterId/sceneId/unitId, scene_hash, content_hash/file_hash, job_id, dispatch_id (see §7).
- **Clear backend ↔ GPU Hub boundary**: gpu-hub accepts tasks from backend with **X-API-Key** (`gpu-hub/gpu-hub.js:33-41`, `backend/src/runtime/gpu-dispatcher.js:64-68`). Workers authenticate **keylessly** (beacon + poll).
- **Filesystem**: two roots — `data/books/<bookId>/` (source book, multi-file vbook) and `data/output/<buildId>/` (generated artifacts). Paths built only from server IDs.

### What's Missing
- **No application-level authentication**: no sessions, cookies, JWT, per-user tokens, auth middleware. The only protection is nginx **Basic Auth** on `app.animastor.in` (`proxy/conf/default.conf:282-287`), covering the entire SPA except `/library`. This is a single shared password, **not** identity.
- **No workspace / project / owner concept** at runtime. `GET /api/v1/books` returns **all** books on the server to any client.
- **No identity → filesystem binding**.
- **No migration files**: schema lives in a single `schema.js` file (already 834 lines), migrations are idempotent `ALTER` statements in `runMigrations`.

### How Hard to Add Accounts
- **Medium**. The owner concept nearly everywhere reduces to a single `book_id` axis. All related tables (scenes, scene_assets, image_units, generation_tasks, chat_*, agent_*, character_*) already carry `book_id`, so **adding `workspace_id` to `books`** (and/or `book_source`) is sufficient — everything else is inherited via book.
- Key "gotchas": (1) media-serving routes build paths directly from URL parameters without PG lookup — a unified ownership-resolver will be needed; (2) disk-scan recovery (`recoverAllBooksFromDisk`, `collectRecentBooks`) reads the entire book directory without filtering — becomes unsafe with multi-user; (3) Redis keys indexed by `book_id` will become cross-tenant without workspace scoping.

### Key Integration Points
1. **`books` (and `book_source`) → `workspace_id`** — the single ownership axis.
2. **Unified auth middleware** in the `backend/src/backend.cjs:63-89` chain (helmet → rate-limit → cors → json → request-id).
3. **Unified ownership-resolver** for media-serving routes (`generation-routes.cjs`).
4. **`GET /api/v1/books`** — first endpoint that must become workspace-scoped.
5. **Header/frontend**: `desktop-header__actions` and mobile toolbar — location for user/workspace menu.

---

## 2. Current Architecture

Existing flow diagram (per `docs/01-overview/SYSTEM_OVERVIEW.md`, `ARCHITECTURE.md`, `proxy/conf/default.conf`):

```text
              Internet
                 │
        ┌────────┴────────┐
        │ nginx (proxy)   │  proxy/conf/default.conf
        │ Basic Auth      │  animastor.in = public (no auth)
        │ (app.*, except  │  app.animastor.in = Basic Auth (shared password)
        │  /library)      │  /api/ → backend:3000   /gpu/ → gpu-hub:5000
        └────────┬────────┘
                 │
   ┌─────────────┼──────────────────────────┐
   ▼             ▼                          ▼
Backend       GPU Hub (5000)            Frontend SPA (static)
(Express:3000)  gpu-hub/gpu-hub.js        frontends/app/dist
 backend/src     │                        (behind Basic Auth nginx)
   │             ├── Redis queues animastor:queue:{type}
   │             │    animastor:running / processing
   │             ▼
   │          Workers (worker/worker/worker.cjs)
   │             └── ComfyUI (image/audio/video)
   │
   ├── PostgreSQL 16 (canonical state, schema.js)
   ├── Redis 7 (operational state, AOF persist)
   ├── Filesystem
   │     data/books/<bookId>/        ← source book (vbook multi-file)
   │     data/output/<buildId>/      ← artifacts (mp3/png/mp4)
   └── AI API (aicredits/OpenRouter) ← agents and TTS
```

Key fact: **the application does NOT authenticate users**. Nginx Basic Auth is the only barrier, shared by all. The Express application is open to any request that reaches it.

---

## 3. Current Database

All tables are defined in `backend/src/storage/postgres/schema.js`. The schema is created **by code** (no migration files; `runMigrations()` — idempotent series of `CREATE TABLE IF NOT EXISTS` + `ALTER ... ADD COLUMN IF NOT EXISTS`). Repositories: `backend/src/storage/postgres/repositories/` (12 files).

### Tables

| Table | Role | Key / Notes |
|---|---|---|
| `users` | **Dormant** — future accounts | `user_id UUID PK`, `email UNIQUE NOT NULL`, `password_hash`, `display_name`, `role`, `settings` (schema.js:10-20). **Not used by any query in the application.** |
| `books` | Book registry | `book_id TEXT PK`, **`user_id UUID REFERENCES users`** (schema.js:25), `title`, `author`, `language`, `visibility`, `tags`, `metadata`. **user_id also unused.** |
| `book_snapshots` | Book versions (diff) | FK `books(book_id) ON DELETE CASCADE`, `version`, `snapshot JSONB` |
| `scenes` | Scene metadata | PK `(book_id, chapter_id, scene_id)`, `scene_hash`, `build_id`, `status`, `content_version`, `audio_config_version`, `is_dirty`, `dirty_unit_ids` |
| `asset_states` | Per-layer state | PK `(book_id, chapter_id, scene_id, layer)`, `status`, `hash`, `version` |
| `cache_entries` | Deterministic cache | `asset_key UNIQUE`, `file_path`, `content_hash`, `status`, indexes on book/scene/hash |
| `asset_dependencies` | Dependency graph | `(book_id, source_layer, target_layer)` |
| `generation_tasks` | GPU task history | `task_id`, `book_id`, `scene_id`, `task_type`, `status`, `worker_id`, `retry_count` |
| `workers` | Worker registry | `worker_id PK`, `worker_type`, `status` |
| `reconciliation_events` | Self-healing log | `book_id`, `event_type` |
| `output_manifests` | Per-build manifests | `build_id`, `book_id`, `asset_type`, `UNIQUE(build_id, book_id, asset_type)` |
| `image_units` | Storyboard IU | `book_id`, `build_id`, `chapter_id`, `scene_id`, `unit_id`, timings |
| `storyboard_elements` | (future) | FK `books` |
| `audio_layers` | (future) | FK `books` |
| `scene_assets` | **Source of truth for asset files** | `book_id/chapter_id/scene_id/asset_type`, `path`, `build_id`, `scene_hash`, `status`, versions, `UNIQUE(book_id, chapter_id, scene_id, asset_type, build_id)` |
| `ai_chat_sessions` | Flat AI sessions | `book_id`, `mode`, `messages JSONB` |
| `chat_sessions` | Chat grouping | `session_id UUID PK`, **`user_id REFERENCES users`** (also dormant), `book_id` |
| `chat_messages` | Chat messages | `session_id FK`, `book_id`, `role`, `message` |
| `book_events` | Book audit log | `book_id`, **`actor`** (TEXT — the only existing "who did it", populated in places), `event_type`, `details JSONB` |
| `agent_sessions` | AI import sessions | `book_id`, `source_type`, `status` |
| `agent_steps` | Pipeline steps | FK `agent_sessions`, `step_type` (CHECK list) |
| `agent_conversations` | AI calls | FK `agent_sessions`/`agent_steps` |
| `agent_messages` | prompt/response | FK `agent_conversations` |
| `character_resolution_runs` | Coreference runs | `book_id`, `run_type`, `character_registry_hash`, `source_hash` |
| `character_window_candidates` | Candidates | FK run, `character_id` |
| `sentence_resolutions` | Per-sentence resolutions | FK run, `scene_id` |
| `character_mentions` | Mentions | FK run, `character_id` |
| `character_aliases` | Alias index | PK `(book_id, alias_norm, character_id)` |
| `book_source` | **SHA256 file → book_id** | `file_hash UNIQUE`, `book_id`, `source_type` (schema.js:750-767). Used for import dedup and book list. |
| `book_generation_sessions` | Window-state import | `book_id`, `window_index`, `status` |
| `generation_cancellations` | Cancellation tombstone | `book_id PK`, `created_by` |

### Relationship Map (Current)

```text
books (book_id PK, user_id — dormant)
  ├── book_snapshots            (book_id FK, CASCADE)
  ├── scenes                    (book_id in PK) ── scene_hash, build_id
  ├── asset_states              (book_id in PK)
  ├── cache_entries             (book_id + index)
  ├── asset_dependencies        (book_id)
  ├── generation_tasks          (book_id)
  ├── reconciliation_events     (book_id)
  ├── output_manifests          (book_id + build_id)
  ├── image_units               (book_id + build_id)
  ├── storyboard_elements       (book_id FK)
  ├── audio_layers              (book_id FK)
  ├── scene_assets              (book_id + build_id + scene_hash)
  ├── ai_chat_sessions          (book_id)
  ├── chat_sessions             (book_id, user_id — dormant)
  │     └── chat_messages       (session_id FK)
  ├── book_events               (book_id, actor)
  ├── agent_sessions            (book_id)
  │     ├── agent_steps         (session_id FK)
  │     │     └── agent_conversations → agent_messages
  ├── character_resolution_runs (book_id) → window_candidates / sentence_resolutions / character_mentions
  ├── character_aliases         (book_id)
  ├── book_source               (book_id, file_hash)
  ├── book_generation_sessions  (book_id)
  └── generation_cancellations  (book_id PK)
```

### Conclusions for Workspace Model

- **Will naturally receive `workspace_id`**: `books`, `book_source` (and for cleanliness, `agent_sessions`/`book_events` — but they inherit via book_id). Adding `workspace_id` to `books` + an index is sufficient; all underlying tables get it transitively through `book_id`.
- **Should NOT receive `user_id` directly**: `scenes`, `scene_assets`, `image_units`, `generation_tasks`, `cache_entries`, `asset_states` — their identity should go only through `book → workspace`. Direct `user_id` here would create a parallel ownership system.
- `book_events.actor` — existing "who" attribute; when accounts are introduced, it can be linked to `user_id` (gently, without breaking things).
- `users` already has an incompatible shape: `email NOT NULL` and no `username`. Implementation will require a migration, not using it "as is."

---

## 4. BKN

**Important:** There is no entity named "BKN" in the codebase. The term appears only in `ACCOUNT_WORKSPACE_CONCEPT.md` (lines 265, 922). The closest thing that exists and serves as "canonical book knowledge" is the **VBook multi-file format** (the same one in `MiM.vbook` — ZIP with `manifest.json`, `book.json`, `chapters/*.json`).

### What Is Canonical State

1. **Manifest + book.json on disk** — source of truth for book identity:
   - `manifest.json` contains `vbook_version`, `book_id`, **`build_id`**, `state`, `created_at` (`backend/src/book/lazy-book/draft.js:37-50`).
   - `book.json` — book structure (title, author, language, chapters, defaults).
   - `chapters/*.json` — scenes/chapters.
   - `generation-routes.cjs:34-47` explicitly states: **"manifest.json is the single source of truth for build_id"**; client build_id is not trusted.
2. **PostgreSQL** — canonical state for: book_source (hash→book), scene_assets (asset registry), book_events (audit), generation_tasks, agent_sessions, image_units, cache_entries.
3. **Redis** — operational generation state (per-asset state, queues, lease, progress).

### Where Book ↔ Scenes ↔ Files ↔ Generation State Links Exist

- Book → scenes: **filesystem** `book.json` + `chapters/*.json` (lazy-book) AND **PG** `scenes` (via book_id). Synchronization via `book-sync.js` by `scene_hash`.
- Scene → artifacts: **PG** `scene_assets` (path, build_id, scene_hash) + **filesystem** `data/output/<buildId>/<bookId>_<chapterId>_<sceneId>.*`.
- Generation state: **Redis** per-asset state (`scene-state.js`), **PG** `scene_assets.status`, `generation_tasks`, `output_manifests`.

### Natural Point for Workspace Ownership

The natural point is **`books` + `book_source`**. Everything is inherited through `book_id`. No parallel ownership system needs to be created alongside BKN: `books.workspace_id` covers all child entities, since every scene/asset identifier already includes `book_id`.

---

## 5. Filesystem

### Current Structure

```text
data/books/
  <bookId>/                    ← bookId = <title_slug>_<Date.now()> (paths.js:26-31)
    manifest.json              ← book_id, build_id, state
    book.json                  ← structure (title, chapters)
    source.txt                 ← source text
    characters.json, mentions.json, bible.json,
    locations.json, voices.json, cover.json
    chapters/*.json            ← scenes
data/output/
  <buildId>/                   ← buildId = build_<bookId> (draft.js:36)
    <bookId>_<chapterId>_<sceneId>.mp3        ← scene audio
    <bookId>_<chapterId>_<sceneId>.mp4        ← scene video (+ _gN.mp4 groups)
    <bookId>_<chapterId>_<sceneId>_NNNN.mp3   ← audio chunks
    <bookId>_<chapterId>_<sceneId>_iu<iuId>.png   ← IU images
    <bookId>_<chapterId>_<sceneId>_pr<iuId>.png   ← previews
```

Path helpers: `backend/src/storage/filesystem-store.js` (all file names), `backend/src/book/lazy-book/paths.js` (book paths).

### Identifiers in Paths

- `data/books/<bookId>/` — top-level book folder.
- `data/output/<buildId>/` — top-level artifact folder.
- Inside: `bookId_chapterId_sceneId[...]` in filenames. **No workspace/user in path.**

### How Paths Are Determined

- Book: `getBookDir(bookId) = path.join(BOOKS_DIR, bookId)` — from `bookId` (URL param).
- Artifacts: `path.join(OUTPUT_DIR, buildId, filename)` — `buildId` taken from manifest (`getEffectiveBuildId`, `generation-routes.cjs:34-47`), but **when manifest is unavailable, uses client `req.query.build_id` as fallback**.

### Can Frontend/Worker Influence Paths

- **Yes, indirectly.** Media-serving routes (`/api/v1/iu-image/:bookId/:chapterId/:sceneId/:iuId`, `/api/v1/scene/:bookId/:chapterId/:sceneId/audio|video|image|storyboard|status`, `/api/v1/preview/...`) build paths **directly from URL parameters** without PG lookup: `path.join(OUTPUT_DIR, buildId, \`${bookId}_${chapterId}_${sceneId}_${iuId}.png\`)` (`generation-routes.cjs:429`).
- **`bookId` is generated from title** (`generateBookId`, paths.js:26-31) — title comes from client, so part of bookId is user-controlled (but bookId is unique by timestamp).
- `/api/v1/chunk/:id/...` builds path from Redis data (`c.build_id`, `c.book_id`) — also without ownership check.

### Disk Recovery

- `recoverAllBooksFromDisk` / `recoverChunksFromDisk` (`backend/src/helpers/redis-helpers.cjs`) — scan `data/books` and `data/output/<buildId>` and restore Redis state.
- `reconciliation-engine.js` (startup loop + periodic) compares PG↔Redis↔disk.
- `book-sync.js` — syncs JSON↔DB by `scene_hash`.
- `collectRecentBooks` (`recent-books-routes.cjs`) — **disk scan of entire book directory** as fallback for book list.

### Conclusion for Future `workspace_id → book_id → path`

- Physical layout does **not need to change**: it is sufficient that **backend always resolves workspace through PG before building paths**.
- Need a unified helper `resolveBookPath(bookId)` / `resolveBuildDir(bookId)` that checks ownership in PG before path construction.
- The dangerous `req.query.build_id` fallback in `getEffectiveBuildId` must either die or pass through an ownership check when auth is introduced.
- For deep isolation in the future — prefix `storage/workspaces/<workspace_id>/books/<book_id>/`, but this requires data migration and recovery (`recoverAllBooksFromDisk`). **Not recommended for the first phase** — ownership should live in PG, not in paths.

---

## 6. Current Identity / Authentication

### What Exists

| Mechanism | Location | Protects | "User" |
|---|---|---|---|
| **nginx Basic Auth** | `proxy/conf/default.conf:282-287` | Entire SPA `app.animastor.in` except `/library` | Single shared password (`.htpasswd`) — **not identity** |
| **GPU_HUB_API_KEY** (X-API-Key) | `gpu-hub/gpu-hub.js:33-41`, `backend/src/runtime/gpu-dispatcher.js:64-68` | POST `/task`, DELETE `/queue/clear` | Service-to-service (backend → hub) |
| **AI API keys** | `backend/src/services/ai-service.js`, `ai-caller.js` | AI calls (aicredits/OpenRouter) | Service key |
| `GPU_HUB_API_KEY` when `null` | `gpu-hub.js:34` | — | **"no key configured = open access"** |

### What Does NOT Exist (Confirmed by Search)

- No sessions, cookies, JWT, Bearer, per-user tokens, OIDC, passport, bcrypt/argon2 dependencies.
- No auth endpoints (no `/login`, `/register`, `/logout`).
- No auth middleware in Express: chain `backend.cjs:63-89` = helmet → rate-limit → cors → json → request-id → logger. That's it.
- Frontend `api/client.ts` sends no auth headers — relies on browser Basic Auth.
- Android: Basic Auth likely in OkHttp (check `frontends/android` — not investigated in detail, but no separate tokens found).
- `users` table exists but is **dead**.

### Where Middleware Will Be Plugged In

Natural point — right after `app.set('trust proxy')` / `helmet` in `backend/src/backend.cjs` (after line 65), before rate-limit, or as a separate `app.use('/api/', requireAuth)`.

---

## 7. IDs, Hashes and Build IDs

| Identifier | Meaning | Created by | Stored in | Security Role |
|---|---|---|---|---|
| **`book_id`** | Book identity (aggregate root) | Server: `title_slug + Date.now()` (`paths.js:26-31`); title comes from client | `manifest.json.book_id`, `books.book_id PK`, dir `data/books/<bookId>/`, all tables | **Not auth.** Partially client-controlled (title). |
| **`build_id`** | Build/artifact folder identity | Server: `build_<bookId>` (`draft.js:36`) | `manifest.json.build_id`, `scenes.build_id`, `scene_assets.build_id`, `output_manifests`, dir `data/output/<buildId>/` | **Not auth.** Fallback to client `req.query.build_id` when manifest unavailable. |
| **`chapter_id` / `scene_id` / `unit_id`** | Book structure | Server: `prefix-<8hex>` (`paths.js:19-24`); frontend preview `idgen.ts` (non-authoritative) | Book JSON, `scenes`, `image_units`, filenames | Not auth. |
| **`scene_hash`** | Stable SHA256 of scene content | Server: `scene-hash.js` (canonicalize → sha256) | `scenes.scene_hash`, `scene_assets.scene_hash` | **Dedup/cache invalidation, NOT authorization.** |
| **`content_hash` / `file_hash`** | SHA256 of file/artifact | Server: crypto (`book_source-repo.js`, `cache_entries`) | `book_source.file_hash UNIQUE`, `cache_entries.content_hash` | **Import dedup, NOT authorization.** |
| **`job_id`** | GPU task identity | Server: `${assetId}:${type}` (`job-schema.js`) | Redis (`animastor:job:`, `running`, `queue`), hub payload | Not auth. |
| **`dispatch_id`** | Dispatch identity (lease/dedup) | Server (dispatch-engine) | Redis `animastor:dispatch-lease:`, `animastor:job:<dispatch_id>:<job_id>`, `generation_tasks` | Not auth. |
| **`asset_key`** (cache_entries) | Deterministic cache key | Server | `cache_entries.asset_key UNIQUE` | Not auth. |
| **`chunk id`** | Redis scene chunk key | Server | `animastor:chunk:<id>` | **Used in URL `/api/v1/chunk/:id/*` — knowing the ID grants access.** |
| **`request_id`** | Request tracing | Server (`backend.cjs:81`) | log | None. |
| **`user_id`** | (Dormant) | — | `users`, `books`, `chat_sessions` | Not used. |

### Hidden Assumption "Know ID → Get Resource"

**Yes, this exists**, and it is built into the architecture: all media-serving and status routes identify resources **only by ID in URL / Redis key**, without any verification. See §12. This is fundamental because the entire server is currently a single "tenant."

---

## 8. Generation / GPU Hub

### Task Path

```text
Frontend (POST /api/v1/generate | /book/:id/regenerate)
  → backend routes (generation-routes.cjs)
  → dispatch-engine / scene-orchestrator (lease, quota, governance)
  → gpu-dispatcher.sendUnified (gpu-dispatcher.js:29-100)
       headers: x-api-key = GPU_HUB_API_KEY
  → POST gpu-hub /task (gpu-hub.js:297-382)   ← requireApiKey
       payload: job_id, params, build_id, book_id, chapter_id, scene_id, stage, dispatch_id
  → Redis queue animastor:queue:{audio|image|video}
  → Worker: beacon (registration) → GET /task/next (gpu-hub.js:388-472)
       [Worker WITHOUT key — knowing URL is sufficient]
  → ComfyUI → result (base64)
  → Worker POST /task/result (gpu-hub.js:478-585)
  → gpu-hub saves animastor:result:<build>:<book>:<chapter>:<scene>:<type> + POST /gpu/task/result → backend
  → task-handler → orchestrator.handle*Completed → save asset (filesystem) + scene_assets (PG) + Redis state
```

### Where Authorization Should Be Checked

- **The single correct place is the backend route boundary** (`backend.cjs` middleware + routes). Workers and gpu-hub **should not** decide whether a person has the right to a book — they work with trusted IDs (`book_id`, `job_id`, `dispatch_id`) received from backend. This is already the case: hub passes `book_id/chapter_id/scene_id` transparently and never checks ownership.
- Specific points: middleware on `/api/`; ownership-check inside routes that build paths; in `getEffectiveBuildId`.
- GPU Hub and worker get protection automatically: if backend doesn't issue tasks for someone else's book, hub/worker will never see them.

### Security Issues in This Chain (See §12)

- `/task/next`, `/task/result`, `/task/error`, `/beacon` on gpu-hub are **not protected by key** — anyone who knows the URL can register as a worker and take tasks (including prompts and embedded images).
- Results are passed as base64 through the public hub; TLS protects the channel but does not authenticate the worker.

---

## 9. Redis

### Found Keys (~100 patterns)

**Persistent-ish / semi-persistent operational state (contain book/scene identity):**
- `animastor:chunk:<id>` — scene state (book_id, chapter_id, scene_id, build_id, readiness flags)
- `animastor:asset-state:*`, `animastor:scene-state:*`, `animastor:iu-progress:*`, `animastor:iu-in-flight:*`, `animastor:iu-registry:*`
- `animastor:book:*`, `animastor:book-scenes:*`, `animastor:layer-config:*`, `animastor:gen-scope:*`, `animastor:vbook-scene-idx:*`
- `animastor:cancelled-workers:*`, `animastor:generation-progress:*`, `animastor:runtime:persistence:*`, `animastor:snapshot:*`, `animastor:scope:*`
- `animastor:event-journal:*` (TTL 7d)

**Transient operational state:**
- `animastor:dispatch-lease:*`, `animastor:dispatch-completed:*`, `animastor:dispatch-meta:*`
- `animastor:runtime:active-audio/image/video`, `animastor:runtime:metrics:*`, `animastor:runtime:quotas:*`, `animastor:runtime:retry:*`, `animastor:runtime:recovery:*`
- `animastor:queue:{audio,image,video}`, `animastor:running`, `animastor:processing`, `animastor:result:*`, `animastor:error:*`, `animastor:job:*`
- `animastor:worker:heartbeat:*`, `animastor:gpu-hub:workers`
- `animastor:audio-merge-lock:*`, `animastor:video-lock:*`, `animastor:scene-lock:*`, `animastor:cleanup-lock`, `animastor:regenerate-lock`, `animastor:video-dedup:*`, `animastor:audio-scene-lock:*`, `animastor:circuit:*`, `animastor:failure:*`, `animastor:retry-budget:*`, `animastor:fairness:*`, `animastor:error-processed:*`, `animastor:result-processed:*`, `animastor:priority:queue`, `animastor:force-dispatch:*`, `animastor:scene-heartbeat:*`, `animastor:scene-video:*`, `animastor:audio-orch:*`, `animastor:video-orch:*`, `animastor:drift:*`, `animastor:stuck-scenes`, `animastor:runtime:scheduler:*`, `animastor:lease:*`, `animastor:lease-heartbeat:*`, `animastor:runtime:total-*`, `animastor:mode:*`, `animastor:prompt-profiles:*`, `animastor:pending-purge*`, `animastor:video-merge-lock:*`, `animastor:audio-scene-failsafe:*`

### Conclusions

- **Redis should not be the source of truth for ownership.** Currently no ownership lives in Redis — only `book_id` in operational keys. But `animastor:chunk:*` stores full scene identity and is used to build media paths (`/api/v1/chunk/:id/*`); if these keys are lost, disk recovery exists.
- **Must remain in PostgreSQL** (when accounts are implemented): users, workspaces, workspace_members, books.workspace_id, and all persistent domains (book_source, scene_assets, generation_tasks, book_events, agent_sessions, image_units).
- **Session/anonymous identity must not live only in Redis** — on Redis restart the user would lose access to their work (directly contradicts the concept: "PostgreSQL is source of truth for identity").

---

## 10. Frontend Integration Points

Frontend: `frontends/app` (Preact, responsive: MobileShell/DesktopShell), public site `frontends/website` (no auth needed), Android `frontends/android` (Kotlin, mirrors Web).

### Locations for User/Workspace Menu

- **Desktop header**: `frontends/app/src/app/AppShell.tsx:163` — `<div class="desktop-header__actions">` contains AI chip + Settings button. User/Workspace button goes here (concept: `[ User / Workspace ] [ Settings ]`), next to Settings.
- **Mobile toolbar**: `AppShell.tsx:322-361` — `<header class="toolbar">` with AI chip + Settings. User button goes here too.
- Concept clearly separates: User/Workspace ("who am I / which workspace") vs Settings ("how the application behaves") — do not mix (concept §19).

### API Client / Session

- `frontends/app/src/api/client.ts` — single point for all requests. `API_BASE = '/api/v1'` (relative, hostname not hardcoded). Currently sends NO auth headers. Token/cookie passthrough will be added here.
- Client state storage: `localStorage` (`animastor_desktop_panels`), `sessionStorage` (`animastor_ai_bubble_dismissed`), Preact signals in `frontends/app/src/state/*` (`generateStore.ts`, `playbackStore.ts`, `positionStore.ts`).
- **Future auth-session**: new signal-store (modeled after `generateStore.ts`), persistent in localStorage. But per concept, browser stores only reconnect credential, not data.

### Affected Components

- `AppShell.tsx` (header/toolbar), `api/client.ts` (auth headers), `SettingsPage.tsx` (location for Account sub-settings), `router.ts` (new /login, /account routes), `FilePage.tsx` (book list becomes workspace-scoped), `generateStore.ts` (bookId opening — requires resolve via workspace). Android mirrors: `frontends/android` (cross-reference `docs/08-mobile-web-migration/*`).

---

## 11. API Authorization Map

All routes are mounted in `backend.cjs` (lines 156-171). Groups:

| Endpoint/group | File | Current Access | Future Ownership Check | Notes |
|---|---|---|---|---|
| `GET /health`, `GET /metrics` | `backend.cjs` | public (nginx health) | no | liveness |
| `GET /api/v1/books` | `recent-books-routes.cjs:121` | **anyone** — all server books | **yes (mandatory)** | currently = "shared sandbox" |
| `GET /api/v1/book/:bookId` + `PUT/PATCH` | `core-routes.cjs` | anyone with book_id | yes | |
| `DELETE /api/v1/book/:bookId` | `core-routes.cjs:745` | anyone with book_id | yes | also cleans Redis |
| `POST /api/v1/book/load-vbook` | `import-routes.cjs:302` | anyone | yes (creates workspace binding) | bookId from bundle |
| `POST /api/v1/book/import-txt` (+ bootstrap, resume, next-window, trigger) | `import-routes.cjs` | anyone | yes | creates bookId from title |
| `POST /api/v1/generate` | `generation-routes.cjs:52` | anyone with file | yes | legacy full-book |
| `POST /api/v1/book/:bookId/regenerate`, `cancel-generation`, `generate-next` | `book/generation-routes.cjs` | anyone with book_id | yes | |
| `GET /api/v1/chunk/:id/*` (status, audio, image, video, storyboard) | `generation-routes.cjs:178,287,599,612,654` | **anyone with chunk id** | yes | path built from Redis chunk |
| `GET /api/v1/scene/:bookId/:chapterId/:sceneId/(audio\|video\|image\|storyboard\|status)` | `generation-routes.cjs:756,771,906,923,942` | **anyone with ID in URL** | yes | **path built from URL params without PG lookup** |
| `GET /api/v1/iu-image/...`, `/api/v1/preview/...` | `generation-routes.cjs:425,441` | **anyone with ID** | yes | direct path.join from params |
| `POST /api/v1/worker/heartbeat`, `GET /worker/status`, `GET /worker/counts` | `generation-routes.cjs:458,473,483` | anyone | yes (restrict to workspace scope) | heartbeat from worker |
| `GET /api/v1/book/:bookId/progress-stream` (SSE) | `generation-routes.cjs:544` | anyone with book_id | yes | |
| `/api/v1/book/:bookId/agent-status` | `agent-routes.cjs` | anyone | yes | |
| `/api/v1/book/:bookId/recover-placeholders` | `recovery-routes.cjs:20` | anyone | yes | |
| `/api/v1/book/:bookId/export/*`, `/download` | `export-routes.cjs` | anyone with book_id | yes | serves .vbook zip |
| `/api/v1/book/:bookId/.../versions`, `/parse`, `/snapshot`, `/source`, `/cache` | `versions/parse/cache-routes.cjs` | anyone | yes | |
| `POST /api/v1/book/:bookId/characters\|locations\|voices` (entity CRUD) | `entity-crud-routes.cjs` | anyone | yes | |
| `/api/v1/ai/*`, `/api/v1/agent/*` | `ai-routes.cjs`, `debug-routes.cjs` | anyone | yes | AI chat, sessions |
| `/api/v1/workflows/*`, `/api/v1/connectors/*`, `/api/v1/config/*` | `workflow/connector/config-routes.cjs` | anyone | no (app-level) | config routes |
| `/gpu/task/result`, `/gpu/task/error` (backend, from gpu-hub) | in `generation-routes.cjs` | service (gpu-hub) | service | internal |
| gpu-hub `/task` POST, `/queue/clear` DELETE | `gpu-hub.js` | **X-API-Key** | service | already authorized |
| gpu-hub `/task/next`, `/task/result`, `/task/error`, `/beacon`, `/health` | `gpu-hub.js` | **open** | worker-level | see §12 |
| nginx `/library`, static `animastor.in` | `default.conf` | public | no | public content |

---

## 12. Security Risks Found During Reconnaissance

Documentation only; nothing is fixed.

1. **Media-serving without ownership-check** — path built directly from URL parameters: `/api/v1/scene/:bookId/:chapterId/:sceneId/audio|video|image`, `/api/v1/iu-image/:bookId/...`, `/api/v1/preview/...` (`generation-routes.cjs:429,756,906,923,942`). No PG lookup, no permission check.
2. **Chunk routes without ownership-check** — `/api/v1/chunk/:id/audio|image|video|storyboard|status` (`generation-routes.cjs:178-282,599-666`) — access by knowing Redis chunk id.
3. **`GET /api/v1/books` returns all server books** to any client (`recent-books-routes.cjs:121-133`), including disk-scan of all of `data/books`.
4. **`getEffectiveBuildId` falls back to client `req.query.build_id`** when manifest is unavailable (`generation-routes.cjs:34-47`) — client can influence build addressing.
5. **Worker endpoints on GPU hub without authentication**: `/beacon`, `/task/next`, `/task/result`, `/task/error` (`gpu-hub.js`) — anyone who knows the URL can register as a worker, take tasks (prompts + embedded images), or post results.
6. **`GPU_HUB_API_KEY` defaults to `null` = open `/task` and `/queue/clear`** (`gpu-hub.js:34`).
7. **Public and internal endpoints on one Express server**: `/health`, `/metrics`, `/gpu/*` are not separated into a separate service; on nginx misconfiguration everything is directly accessible.
8. **Redis keys indexed by `book_id` without workspace scope** — with multi-tenancy, review needed to prevent cross-tenant leaks via book_id guessing.
9. **bookId is partially client-controlled** (title → slug in `paths.js:26-31`) — not critical on its own, but without auth it's a trivial collision vector.
10. **`users` table and FK `books.user_id` exist but are unused** — risk of a "half-implemented" security model that future code may treat as working.
11. **`book_events.actor`** — unstructured "who", without identity binding.
12. **Basic Auth (shared password) is not identity** — the entire application protection is a single shared secret in nginx.

---

## 13. Proposed Integration Points

### 13.1 Data (PG)

```text
users            → populate (username, password_hash, email optional, recovery_key_hash)
workspaces       → new table (id, name, owner_user_id, plan)
workspace_members → new table (workspace_id, user_id, role)
books            → + workspace_id  (migrate existing books to "legacy"/first workspace)
book_source      → inherits via book_id (or + workspace_id for direct queries)
sessions/tokens  → new table (or httpOnly cookie + server-side session in PG)
```

**Do NOT add user_id** to scenes/scene_assets/image_units/generation_tasks/cache_entries — only through `book → workspace`.

### 13.2 Backend

- **Auth middleware** in `backend.cjs` after helmet, before routes: resolve identity from cookie/token → `req.user`/`req.workspace`.
- **Ownership resolver** (`requireWorkspaceBook(bookId)`) — single point before: media-serving, chunk routes, export, deletion, generation, SSE, book list.
- **`GET /api/v1/books`** → filter `WHERE workspace_id = $1`.
- **`getEffectiveBuildId`** — remove client fallback or verify ownership before use.
- **Anonymous identity**: on first request create anonymous user + temporary workspace; browser gets reconnect token.

### 13.3 Generation / GPU Hub

- Leave as-is: hub/worker work with trusted IDs. No ownership checks on hub.
- Protect worker endpoints on hub (worker token) — separate from accounts, but desirable before multi-user.
- Task payload already has `book_id`/`chapter_id`/`scene_id`/`stage`/`dispatch_id` — workspace_id can be added transitively (or not at all, since backend already verified).

### 13.4 Filesystem

- Do **not** move to `workspaces/<id>/books/...` in the first phase. Instead: ownership lives in PG; `resolveBookDir()` queries PG.
- Recovery (`recoverAllBooksFromDisk`, `collectRecentBooks`) — scan only workspace-scoped books (or return list from PG and leave disk-scan only as fallback under the same filter).

### 13.5 Frontend

- User/Workspace button in `desktop-header__actions` + mobile toolbar.
- `api/client.ts` — token passthrough.
- New `authStore` (signals + localStorage) modeled after `generateStore`.
- Routes `/login`, `/register`, `/account` in `router.ts`.

---

## 14. Open Questions

1. What to do with the existing dormant `users` table (email NOT NULL, no username) — migrate or replace from scratch?
2. Where to route existing books (currently `books.user_id` is empty) when workspace is introduced — create a "legacy"/system workspace?
3. Anonymous session: cookie (httpOnly) vs token in localStorage; rotation; lifetime.
4. How to authenticate Android (OkHttp Basic Auth today) — migrate to tokens?
5. Anonymous workspace lifetime, storage/GPU limits — numbers needed before implementation.
6. What to do about worker endpoints on gpu-hub (`/task/next` etc.) — introduce worker tokens before accounts?
7. `visibility` in `books` (private/public/shared) — future sharing mechanism; how does it relate to `workspace_members`.
8. Public Library (`/library`) — remains outside accounts?
9. How to workspace-scope Redis keys without full key migration?
10. Is `workspace_id` needed in `book_source` for direct queries, or is joining through `book_id` sufficient?

---

## 15. Recommended Next Step

**Minimal first phase (corresponding to Phase 1+2 of the concept), without changing existing routes:**

1. **Schema design** (not migration!): document with exact `ALTER`/`CREATE` for `users`, `workspaces`, `workspace_members`, `sessions`, `books.workspace_id` — accounting for the current dormant `users`.
2. **Addressing refactor**: introduce unified ownership-resolver in backend, but **with hardcoded "single workspace" for now** — so that media-serving and chunk routes stop building paths directly from URL, without changing behavior.
3. **Anonymous identity**: create anonymous user + temporary workspace on first request + issue reconnect token; bind all created books to it.
4. **`GET /api/v1/books` → workspace-scoped** (first visible and safe step).
5. **UI**: User/Workspace button in header (for now shows "Anonymous / Temporary workspace" and a "Keep my workspace" stub).

This step provides a working ownership layer under the hood, preserves backward compatibility with all current clients, and does not touch generation/GPU Hub.
