# AI Assistant Extraction — Preparation (A-1…A-5)

**Status:** LANDED (seams/ports/adapters only — no `@animastor/assistant` package yet, no production files moved between packages).
**Baseline:** on top of S-5 (`f7e64131` "arch(generation): reduce runtime orchestration cycle") + the in-flight S-6 generation host-ports work in the working tree (see §7 Blockers).
**Predecessor audit:** `docs/architecture/ai-assistant-and-postgresql-extraction-audit.md` (A-1…A-5 preparation plan, §10 AssistantPorts contract, §16 MOVE/STAY lists).
**Guard suite:** `backend/tests/architecture/assistant-contour.test.js` (A1…A7).

## 0. Generation S-5 status (precondition check)

S-5 (orchestration ↔ runtime cycle unwinding) is **DONE** before this stage started:

- HEAD at preparation start: `f7e64131` — the S-5 landing commit ("arch(generation): reduce runtime orchestration cycle").
- `tests/architecture/s5-runtime-orchestration-cycle.test.js` (S5-A…S5-G): **7/7 passing**.
- The 14-module SCC is dissolved (documented §27 of the generation reconnaissance doc).
- The working tree additionally carries **in-flight S-6** work by another coder (generation host ports); it does not touch the Assistant contour and does not conflict with this preparation (shared-file edits are disjoint).

Verdict: no blocker — full Assistant preparation was safe to proceed.

## 1. Seams created

### 1.1 `chat-session-repo` (A-1) — the only ai_chat_sessions owner

`backend/src/storage/postgres/repositories/chat-session-repo.js`

- `listSessionsForBook(bookId)` — session metadata list (message_count, title COALESCE)
- `getSession(id)` — full row, messages normalized to a JS array
- `getMessages(id)` — messages-only read (failed-turn persistence)
- `createSession(session)` — column-optional INSERT (both historical shapes byte-identical)
- `setMessages(id, messages, updatedAt)` — append/merge write (route owns merge semantics)
- `renameSession(id, title)` — PATCH parity
- `deleteSession(id)`
- `getBookIdForSession(id)` — authz guard lookup
- `purgeSessionsForBook(bookId)` — the purge seam

All 16 inline `storage.postgres.query` sites in `routes/ai-routes.cjs` and the raw-handle query in `middleware/ai-book-guard.js` were moved here. The route and the guard now hold **zero SQL, zero postgres, zero storage-barrel references**.

### 1.2 `AssistantPorts` (A-2) — the narrow host contract

`backend/src/services/assistant-ports.cjs` — `createAssistantPorts({...})`, wired in `backend.cjs` (composition root):

| Port | Binding | Notes |
|---|---|---|
| `loadBook(bookId)` | `bookModel.loadBook(bookId, { mode: 'lazy' })` | canonical‖draft fallback stays inside the Book Model facade |
| `persistBook(bookId, bundle)` | `book.saveBookBundle(bundle)` **or** targeted file save | ONE semantics for both chat routes — see 1.3 |
| `validateBundle(bundle)` / `validateBundleFile(name, data)` | `book/bundle-validator.cjs` | same validator instance as the chat-engine pipeline |
| `resolveChatAI(bookId)` | `providerGateway.chat.resolveProvider(bookId, { fallbackBaseUrl: chatEngine.AI_API_BASE_URL })` | Provider Gateway seam (Phase 3), fallback URL binding stays host-side |
| `sessionRepo` | `chat-session-repo` | the A-1 repository |
| `purgeForBook(bookId)` | `sessionRepo.purgeSessionsForBook(bookId)` | reverse-edge purge seam |
| `log` | `utils.log` | |

`routes/ai-routes.cjs` now destructures exactly `{ chatEngine, assistantPorts, utils }` — the wide `...routeDeps` spread (storage barrel, whole Book/VBook services, task/generation deps) no longer rides into the Assistant object graph.

### 1.3 Unified `persistBook` semantics (H2 closed)

The historical save block existed TWICE (non-streaming route + `processChatReply` in the stream route), each with a full bundle save + a zero-chapter targeted fallback (`lazyBook.getBookDir` + per-file `validateBundleFile` + `fs.writeFileSync`). Both are now ONE port call:

- chapters intact → `book.saveBookBundle(bundle)` (full multi-file save)
- chapters empty (corrupted load) → targeted save of manifest/book/bible/locations/voices/characters, chapters deliberately skipped, every file validated **before** the first write

No duplicated fallback logic remains in the route.

### 1.4 Purge flows de-coupled (A-3)

- `services/book-deletion.cjs`: `'ai_chat_sessions'` removed from the `pgTables` purge list; a new required `purgeAssistantForBook` adapter (injected from `backend.cjs`, bound to `assistantPorts.purgeForBook`) runs after the PG cascade step. The deletion cascade no longer knows the Assistant's table.
- `routes/book/cache-routes.cjs`: same removal; the port is passed via `book-routes.cjs` (`deps.assistantPorts`). The stale comment claiming chat history is preserved on cache-clear was corrected (sessions ARE deleted — historical behavior kept).
- `middleware/ai-book-guard.js`: session→book resolution via `sessionRepo.getBookIdForSession`; the direct `storage/postgres/database` require is gone — the file was **removed from the DIRECT_SQL_WHITELIST baseline** (17 → 16 entries, whitelist only shrinks).

### 1.5 chat-engine validator injection (H1 partly closed)

`services/chat-engine.cjs` now accepts `(config, deps)` with `validateBundleObject` injectable; the composition root binds the host validator so the Assistant save gate and the patch pipeline share one contract. The direct `../book/bundle-validator.cjs` require remains only as the standalone/test fallback (baseline-frozen in phase7 P7-T4).

## 2. Dependencies eliminated

| Dependency | Before | After |
|---|---|---|
| 16× inline SQL in ai-routes | `storage.postgres.query` (storage barrel) | `sessionRepo` port |
| Guard SQL | raw `storage/postgres/database` handle (whitelisted) | `sessionRepo.getBookIdForSession` (whitelist entry removed) |
| Book read | `bookModel.loadBook` direct dep in route | `ports.loadBook` |
| Book write | `book.saveBookBundle` + `lazyBook.getBookDir` + `validateBundleFile` + `fs.writeFileSync` in route | `ports.persistBook` |
| Provider resolution | in-route gateway require + chatEngine constant | `ports.resolveChatAI` |
| purge flows → Assistant table | `'ai_chat_sessions'` in two pgTables lists | `purgeAssistantForBook` port |
| routeDeps width | 40+ fields spread into the route | `{ chatEngine, assistantPorts, utils }` |

## 3. What remains before the physical extraction

1. **Persona file relocation** — `backend/ai/ai-assistant-profile.md` (loaded via `AI_PROFILE_PATH`, chat-engine fallback) should move with the package; the `ai/` content tree itself is generation-domain.
2. **`resolveChatAI` transport legs** — `services/provider-gateway`, `services/ai-connector/shared-pool`, `services/url-safety` are still host-side requires inside the route (transport branch). A package-owned adapter or port injection is the next seam (mirrors the Player `playerPorts` precedent).
3. **Route HTTP shell** — the express route registration stays host-side for now (same pattern as Player/Editor before their physical moves); the future package exposes `createAssistantRoutes(app, { ports })`.
4. **Package test ownership** — the 12 ai-*/workspace-ai-* test files exercise the route through the narrow seam already (this stage rewired them); they need relocation to the package at extraction time.
5. **`ai-book-guard` mounting** — stays host-side (composition root middleware order, `backend.cjs:188-195`); the package will receive the guard as an injected middleware or export it behind the seam.
6. **Frontend contract freeze** — `/api/v1/ai/*`, SSE `meta/delta/done/error` frames, session CRUD shapes, `ai_source` tokens: unchanged (pinned by A6 + chat-transport guards); web/Android clients untouched.

## 4. Architecture guards

New: `backend/tests/architecture/assistant-contour.test.js`

- **A1/A1b** — no SQL/postgres/storage-barrel in the Assistant contour (routes, engine, guard, ports)
- **A2** — `ai_chat_sessions` SQL only in chat-session-repo (+ schema.js migrations)
- **A3/A3b** — narrow route wiring + AssistantPorts surface completeness
- **A4** — Book/VBook access via ports only (no bookModel/book/lazyBook/bundle-validator/FS in the route)
- **A5** — purge flows use `purgeAssistantForBook`, no table-name coupling
- **A6** — chat transport contract intact (SSE frames, tools, AbortController, shared-pool connector path)
- **A7** — chat-engine validator injectable + composition-root bound

Updated baselines: `sql-boundary.test.js` (whitelist −1), `phase4-book-model.test.js` (T5 facade form via ports; T6 deletion fixture gains the purge port), `phase2-vbook-contract.test.js` (AI/chat load seam), `phase7-extraction-readiness.test.js` (RAW_BOOK_BASELINE: `ai-routes.cjs: ../book/bundle-validator.cjs` removed; `backend.cjs: ./book/bundle-validator.cjs` added as a composition-root edge).

## 5. Explicitly NOT done (per stage constraints)

- No `@animastor/assistant` package created; no production files moved between packages.
- No `@animastor/postgres`/`@animastor/database` package — PostgreSQL stays host infrastructure.
- No HTTP/SSE contract changes; auth/guard behavior and book mutation semantics preserved.
- No unrelated cleanup.

## 6. Parallel PG debt track (separate from Assistant extraction)

The audit's Option D continues independently: the direct-SQL whitelist shrunk by one entry this stage (`middleware/ai-book-guard.js` — Assistant-motivated but a legitimate whitelist shrink). The remaining 16 entries (agent-tables cluster first) are NOT part of this track.

## 7. Remaining blockers

1. **In-flight S-6 work (another coder)** in the working tree: generation host ports (`generation/ports/*`, config adapter, comfyui-provider dispatch port, video-workflows BookDataPort). Its own guard suite (`s6-generation-host-ports.test.js`) and three baseline pins (P7-T4 raw-book set incl. `video-workflows`, P7-T6 gateway consumer set, Phase 9C contracts facade choke point) are currently RED on its own baseline drift — not caused by and not blocking the Assistant preparation. Coordinate the commit order (S-6 first, or this stage rebased onto it).
2. Persona file + transport legs (see §3) — the remaining hard host edges before the physical move.

## 8. Verification summary

- Assistant contour guards: 9/9 (assistant-contour.test.js)
- Assistant-relevant existing guards: phase2, phase3, phase4, phase7 (T4/T6 partial S-6 red), sql-boundary, chat-transport, dependency-guardrails — green for the Assistant changes
- Assistant/chat runtime tests: ai-patch-validation, ai-editor-mode, behavior-edit-book, ai-participants-doctrine (41), workspace-ai-security (38), ai-model-propagation (14), ai-connector-provider (21), personal-ai-provider-phase4 (19), workspace-ai-provider (12), ai-shared-stream (28), ai-connector-acceptance (9), ai-shared-inference (22 + 1 pre-existing environment failure `16b`, byte-identical on clean HEAD)
- Architecture suite: 799 passing / 3 failing — all three failures are the in-flight S-6 baseline drifts documented above
