# Architectural Audit: Migrating Frontend Logic → Backend

**Project:** Animastor
**Date:** 2026-07-08
**Frontend:** Android (Kotlin, ~14,600 lines), package `com.example.animastor`
**Backend:** Node.js / Express (modular), Redis + PostgreSQL, GPU orchestration

---

## Implementation Status

Wave 1 is being executed gradually; after each step — commit and git push.

| Step | Finding | Status | Commit |
|---|---|---|---|
| 1 | **F1** — generation profile on server | ✅ Done | server-owned generation profile |
| 2 | **F13** — `duration_ms` for IU on server | ✅ Done | server-computed IU duration_ms |
| 3 | **F9** — `cover_chunk_id` + `chunk_positions` in chunks | ✅ Done | F9: server cover_chunk_id + chunk_positions |
| 4 | **F7** — `chapter_title` always from server | ✅ Done | F7: server chapter_title enrichment |
| 5 | **F5** — `display_number`/`display_index` in book model | ✅ Done | F5: server display_number + display_index |
| 6 | **F3** — SSE vbook normalization (numeric fields) | ✅ Done | F3: server-driven vbook progress |
| 7 | **F2** — server-side progress panel aggregator | ✅ Done | F2: server progress-panel endpoint |
| 8 | **F11** — terminal events `generation_complete/stalled` | ✅ Done | F11: server-pushed generation_complete SSE |
| 9 | **F4** — window trigger decision on server | ✅ Done | F4: server-driven window trigger |
| 10 | **F6** — chat system-prompt assembly on server | ✅ Done | F6: server-side system prompt assembly |

**Note on F1:** During implementation it was discovered that the
`GET/PUT /api/v1/book/:bookId/layer-config` routes were **documented but not
implemented** — the frontend received 404, the error was suppressed by
`runCatching`, and the client operated on its own copy of `computeProfile()`.
Routes implemented, profile now comes from the server (`resolveProfile`),
client duplicate removed.

**Note on F9:** Backend now returns `cover_chunk_id` and `chunk_positions`
in `GET /api/v1/book/:bookId/chunks` in a single batch request. Frontend uses these
fields instead of N individual `getChunkStoryboard` calls. Removed 6 N+1 patterns
in `GenerateViewModel.kt`. Added `ChunkPosition` and fields in `ChunkListResponse.kt`.

**Note on F7:** Backend in `GET /api/v1/book/:bookId` now fills
`chapter_title` from `chapter.intro.text` if the title is missing, using the same
heuristic with delimiters `—, –, ., !, ?`. Frontend no longer calls
`enrichTitles()` / `extractChapterTitleFromIntro()` — all code removed from
`BookModels.kt`, `NavigateFragment.kt`, `AiAssistantFragment.kt`.

**Wave 1 completed (5/5).** All "cheap duplicates" migrated to the server:
generation profile (F1), IU duration (F13), cover+chunks (F9),
chapter_title (F7), display_number/display_index (F5).

**Wave 2 started:** F3 — SSE vbook normalization.

**Note on F3:** SSE handler `vbook` and `updateVBookProgress()` simplified.
Removed regex parsing of Russian text (`Regex("""сцен[ыа][\s]*?(\d+)""")`) and modular
arithmetic (`((globalScene - 1) % windowTotal) + 1`) for scene number inference.
Both paths now use server-side fields `window_scene_index`/`window_total_scenes`/
`window_start_scene`/`scene_index` directly. For the polling path (agent-status, where
`window_scene_index === null`), the index is computed as `created_scenes - window_start_scene + 1`.
Removed ~30 lines of fragile code. All server-side fields are already provided by `pipeline-runner.js`
and `agent-routes.cjs` — no backend changes needed.

---

## 📌 Re-audit — 2026-07-11

Since the first audit (2026-07-08), a major player refactor occurred (scene-based
playback, playing from book JSON). Checking the current code state revealed:

**What is actually closed (verified against code):**
- `computeProfile()` — removed, profile is read from server. ✅
- Regex parsing of Russian text for scene number — removed, clear comment exists. ✅
- N+1 on chunks — no, the book is fetched by a single `getBook`. ✅
- `enrichTitles()` / `extractChapterTitleFromIntro()` — removed from `BookModels.kt`. ✅
- Chat system-prompt — assembled on server (`buildChatSystemPrompt`), no more prompts in `AssistantMode.kt`/
  `ChatTopic.kt`. ✅

**What is only partially closed or claimed but not completed (new findings):**

| # | Finding | Client Side | Server Side | Action |
|---|---|---|---|---|
| **N1** | **`duration_ms ?: 2000L`** — client duplicates IU duration default | `PlaybackViewModel.kt:798` | Server **already** computes `duration_ms` with the same 2000 default (`generation-routes.cjs:417-421,756-760`) | Guarantee `duration_ms` in storyboard response, remove `?: 2000L`. **XS** |
| **N2** | **Timing cascade** recalculated on client (downstream shift, clamp to audio length) | `EditFragment.kt:1144-1179` (`handleRangeChange`) | Server **already** recalculates cascade authoritatively in PUT `/timings` (`generation-routes.cjs:1004-1015`: sort by `scene_order`, cursor, min 50 ms, clamp to `sceneDurationMs`, `recalculated:true`) | F8 only half-closed: merge (`setDeep`) exists but client **duplicates** the cascade. Keep local recalculation **only as drag-preview**; after commit take `units` from server response, not from local recompute. **S** |
| **N3** | **Scene index** computed by enumeration on client + hardcoded `cover`/`prologue` | `BookModels.kt:504-514` (`sceneIndex()`), `NavigateFragment.kt:188,286,308` (`isSpecial = type=="cover"||"prologue"`) | Server provides `display_number` for chapter, but **no** `display_index` for scene and **no** `is_special` flag | F5 only half-closed. Add `display_index` to scene model and `is_special` to chapter; remove `sceneIndex()` and type hardcoding. **S** |
| **N4** | **"Book ready" detection** by string state matching | `GenerateViewModel.kt:544-548` (`state in ["BOOTSTRAPPED","ACTIVE"] && parsedChapters>0`) | Server knows the state | Provide an explicit boolean `ready`/`complete` in import status, don't match strings on client. **S** |
| **N5** | **Stuck heuristic** auto-complete generation by timer | `MainActivity.kt:594-618,653` (`STUCK_FALLBACK_MS=30_000`, poll `active_scenes==0` → `applyGenerationResults`) | Server sends `generation_complete` SSE (F11), but client keeps 30s fallback as "insurance" | Keep fallback **only** as emergency if SSE delivery is guaranteed; log trigger frequency. Do not remove until SSE is reliable. **S** |
| **N6** | **Dev workflow screen**: type coercion, node filtering by `expectedClass`, default `"LTXVAddGuide"`, multi-binding key reversal `key[0]`, `guessConnectorName` (`conn-` prefix) | `WorkflowDetailsFragment.kt:398-401,712-719,1045-1066,1158-1175`; `WorkflowTypeListFragment.kt:138-182`; multi-binding duplicated in `WorkflowDetailsViewModel.kt` and `DeveloperViewViewModel.kt` | Partially on server (`*_active_count` computed by server) | **Low priority** — tool screen, not user path. Extract type coercion and synthetic multi-binding keys when convenient. **M, incremental** |

**Next wave priority:** N1 (XS, pure duplicate) → N3 (S, finishes F5) → N2 (S, finishes
F8) → N4 (S). N5 only touch alongside SSE hardening. N6 — background.

The principle remains: **if the server already knows the answer — provide the ready value, not fields for
recalculation.** N1 and N2 are particularly illustrative — the server already computes the same thing, the client computes it a second time.

---

## 0. Summary (TL;DR)

The frontend is a native Android client, not a "thin" display layer. Over time,
a significant amount of **business logic** has leaked into it that should belong to the server:
generation profile computation, progress panel state machine, VBook progress inference from
Russian text using regexes, next window trigger decision, chapter numbering, chat system-prompt
assembly, and edit reconciliation.

Key finding: **the backend already contains canonical versions of some of this logic** (e.g.,
`resolveProfile()` in `layer-config.js` — an exact copy of the client's `computeProfile()`),
but does not always expose it, causing the client to duplicate computations. This is the cheapest and
safest class of migrations: the logic is already written on the server.

When a second/third client appears (Web, Desktop), all this logic will be rewritten from scratch
on each platform — with inevitable behavioral divergence. This is the main argument in favor.

**Scope estimate:** from ~14,600 lines of frontend, ~1,500–2,000 lines of logic can potentially be
eliminated/simplified. The heaviest files (`GenerateViewModel` 1744, `PlaybackViewModel` 926,
`EditFragment` 1228) lose the most.

Prioritized task list is in section 4.

---

## 1. Classification Principle

For each section, 5 questions from the spec are asked. To avoid bloating the report, they are condensed into fields:
**Where / Current / Via backend / Pros / Cons / Recommendation / Complexity.*

What **remains on the client by definition** (legitimate client responsibility, not migrated):

- Playback timing, buffering, `MediaPlayer` chaining, volume, seek.
- IU image looping under player position (real-time, local `MediaPlayer.position`).
- Screen rotation recovery (local sequence counter).
- Layout calculations (card height from screen density, aspect).
- "Typing..." animation, typing indicators.
- `status → color/string` and `dataType → InputType` mapping (localization and UI widgets).
- `Bundle` serialization between fragments (Android limitation).

All of these are marked as **KEEP** in the report and not detailed further.

---

## 2. Findings (by decreasing value)

### F1. Generation Profile Computation — Exact Duplicate of Server Logic 🔴

- **Where:** `GenerateViewModel.kt:195–211` (`computeProfile()`), plus usage at
  `250–264` (`persistLayerConfig`), `259`, `307–315`.
- **Current:** Client computes a profile string (`full` / `storyboard` / `image_only` / `audio_only` / `video_only`) from three boolean flags (audio/image/video) using an 8-branch `if`.
- **Via backend:** This function **already exists** — `backend/src/services/layer-config.js:77–84`
  (`resolveProfile`). Moreover, `PUT /api/v1/book/{id}/layer-config` and
  `AssetsStateResponse` **already contain a `profile` field** (see `LayerConfig.kt`).
  The client should simply read `response.profile`, sending only the toggles.
- **Pros:** Remove the duplicate invariant; single source of truth for what "profile" means; new clients don't rewrite the 8-state table.
- **Cons:** Practically none. Need to ensure all responses that need the profile return it (currently `assets-state` in `chunks-routes.cjs` does **not** put it in JSON — one field needs adding).
- **Recommendation:** **MIGRATE.** Pure win: remove dead code duplicating an already-written server function.
- **Complexity:** Very low (backend: +1 field in `assets-state`; frontend: remove function).

---

### F2. Progress Panel State Machine ("Workers") 🔴

- **Where:** `GenerateViewModel.kt:1378–1576` — `computeWorkers()` (~170 lines),
  `getProgressTotal()` (1378–1385), `getAnyLayerIncomplete()` (1387–1396),
  plus state fields `workerReadyFloor`, `workerCompletedAt`, `_workerPermanentlyDone`,
  `gpuProgressDoneAt`.
- **Current:** Client assembles a worker list and their percentages from the "raw" `AssetsStateResponse`. Business rules are hardcoded:
  - which layers are visible for which profile (`audioNeeded = profile in [...]`);
  - IU vs legacy image counter selection (`if scope_iu_total > 0`);
  - monotonous "floor" for progress so % doesn't roll back;
  - "show Done for N seconds then hide" timings (`COMPLETED_WORKER_DISPLAY_MS`);
  - percentage computation `r * 100 / total`, done detection `r >= total`.
- **Via backend:** Introduce a `progress` endpoint/field (or extend `assets-state`) returning a **ready worker array**: `[{type, ready, total, percent, done, visible, indeterminate, label_key}]` and aggregates `overall_percent`, `any_incomplete`. "Layer visibility per profile" and "IU vs image" rules are already known to the server (it generates them). Backend can also guarantee progress monotonicity.
- **Pros:** The most complex and fragile frontend part (regular bug source — see git history: "scene counter 1/1", "broken counter", "Idle leaking") moves to server; consistency across clients; easier to test (server unit tests already exist — `iu-progress-utils.test.js`).
- **Cons:** "Show Done for N seconds" timing is UI policy; better kept on client (client decides how long to hold the completed row). So we migrate *computation* but not *display cosmetics*. Slight risk of field count growth in response.
- **Recommendation:** **MIGRATE computation** (percentages, visibility, done, monotonicity, IU/image selection). **KEEP** only the "done" highlight duration on client.
- **Complexity:** Medium (backend: aggregator on top of existing `assets-state`; frontend: replace `computeWorkers` with rendering a ready list).

---

### F3. VBook Progress Inference via Regex on Russian Text 🔴

- **Where:** `GenerateViewModel.kt:968–1024` (`updateVBookProgress`) and `1293–1315`
  (SSE event handling); `step_type → VBookStage` mapping (969–976).
- **Current:** Client **parses the human-readable progress message** using regex
  `Regex("""сцен[ыа][\s]*?(\d+)""")`, then with a cascade of `?:` fallbacks and modular
  arithmetic (`((globalScene - 1) % windowTotal) + 1`) reconstructs the scene index
  within the window, window start scene, and total count. This is inferring server state from its own logs.
- **Via backend:** The `vbook` SSE event must carry **already-computed** numeric fields:
  `stage`, `window_scene_index`, `window_total_scenes`, `window_start_scene`,
  `global_scene_index`. Some fields already exist in the event (client reads them first);
  the task is to guarantee they are always present and **remove the regex fallback**.
- **Pros:** Eliminate the most fragile point (parsing localized strings — breaks when wording changes; git history confirms counter breakages); i18n stops affecting logic; new clients don't parse Russian text.
- **Cons:** Need to clean up the SSE event schema on the server (unified contract). Practically no performance downside.
- **Recommendation:** **MIGRATE.** Regex on localized messages is a clear anti-pattern.
- **Complexity:** Low–medium (backend: populate event fields; frontend: remove parsing).

---

### F4. Next Window Generation Trigger Decision 🔴

- **Where:** `WindowTriggerManager.kt:93–179` (`checkEndOfWindow`), 180 lines total.
- **Current:** Client decides when to fire `trigger-next-window` based on player position:
  - unit must be among the last 3 scenes (`last3Start`);
  - position must match the "generation frontier" — client **enumerates all chapters/scenes**, filters `chapter_intro`/`cover`, finds the last scene;
  - dedup by window key (`triggeredWindows`), one-shot per unit, 60s cooldown.
- **Via backend:** The `POST /trigger-next-window` endpoint **already exists**
  (`import-routes.cjs:361`). The client only needs to **report the current position**
  (which it already knows), and the server makes the "now / not now / already done" decision,
  owning the true frontier, dedup, and rate-limiting. Ideally, the server returns a
  `should_prefetch_next` flag in the progress stream or handles everything itself based on position.
- **Pros:** Dedup and cooldown become server state (survive client crash/rotation, not re-triggered from multiple clients); frontier is not duplicated; ~130 lines of client logic removed; behavior identical across all platforms.
- **Cons:** Increased frequency of position messages to server (can be throttled to once every N seconds — cheap). Need to handle idempotency carefully (server already provides it via leases — see `lease-manager.js`).
- **Recommendation:** **MIGRATE the decision.** Client sends position; "last-3 / frontier / dedup / cooldown" — server-side.
- **Complexity:** Medium (need position channel + server evaluation; trigger endpoint is ready).

---

### F5. Chapter Numbering and Position Label Assembly (duplicated 3×) 🟠

- **Where:** `NavigateFragment.kt:185–217, 258–301`; `EditFragment.kt:237–272`;
  `AiAssistantFragment.kt:684–730` — same calculation in three places.
- **Current:** Client computes "real chapter number," excluding `cover`/`prologue`:
  `chapters.take(chIdx).count { it.type != "cover" && it.type != "prologue" } + 1`,
  truncates titles (`take(60)`), normalizes line breaks, builds nested conditional labels
  "Chapter X / Scene Y — Title / Unit Z".
- **Via backend:** Server already numbers chapters internally (`chapter-utils.js:10`
  `createChapterIntroScene(chapterTitle, chapterNumber, …)`) but **does not expose** display numbers.
  Add `display_number` (chapter), `display_index` (scene/unit) and ready `path_label` to book model when serving `getBook`. Client only substitutes localized words "Chapter/Scene/Unit".
- **Pros:** Triple duplication eliminated, divergence risk removed; "cover/prologue not counted" is a business rule that belongs on the server.
- **Cons:** Localization of "Chapter/Scene" words remains on client (correct). Server provides numbers/indices, client provides words. Slight increase in book model.
- **Recommendation:** **MIGRATE number/index computation** (numbers and structure); words stay on client for i18n.
- **Complexity:** Low–medium.

---

### F6. Chat System-Prompt Assembly on Client 🟠

- **Where:** `AiAssistantFragment.kt:666–800` (`sendMessage`), assembly at `746–748`;
  language instruction `739–744`; position resolution `684–730`.
- **Current:** Client concatenates the full system-prompt: app name + mode
  (`mode.systemPrompt`) + topic (`topic.systemPrompt`) + resolved position +
  language instruction (`when(lang) "ru"/"en"/"auto"`). Mode/topic definitions
  are hardcoded in client (`AssistantMode.kt`, `ChatTopic.kt`).
- **Via backend:** Client sends `{ sessionId, mode, topic, message, position }`; server
  assembles system-prompt from its own mode/topic definitions and session language.
  Server already has `services/agent-prompts.js` and SSE chat (`ai-routes.cjs:292`).
- **Pros:** Prompts (core product) edited on server without app release; unified prompt for all clients; security (prompt rules not "hardcoded" in APK).
- **Cons:** Less flexibility for client to build prompt offline; position/mode must be sent in structured form. Mode/topic definitions for *display* (names, icons) may remain on client.
- **Recommendation:** **MIGRATE prompt assembly.** Client sends parameters, not prompt text.
- **Complexity:** Medium.

---

### F7. Chapter Title Parsing from Intro Text (`enrichTitles`) 🟠

- **Where:** `BookModels.kt:133–145` (`extractChapterTitleFromIntro`), `405–433`
  (`enrichTitles`); called across the frontend (`NavigateFragment:234`,
  `AiAssistantFragment:348,508`, etc.).
- **Current:** If `chapter_title == null`, client parses intro text using a list of
  delimiters `[" — ", " – ", ". ", "! ", "? "]`, extracts candidate, cleans punctuation.
- **Via backend:** Chapter title should be computed during book parsing on the server and
  stored in the model (`parse.js` already sets `chapter_title` from `chInfo.title`).
  `getBook` should always return a populated `chapter_title`, not force the client
  to reconstruct it via string heuristics.
- **Pros:** String heuristic removed from client; consistency; `enrichTitles()`
  is called from dozens of places — all simplified.
- **Cons:** Need to run heuristic on server for old books (migration/lazy on read).
- **Recommendation:** **MIGRATE.**
- **Complexity:** Low (logic is short, ports 1:1 to `lazy-book/parse.js`).

---

### F8. Edit Reconciliation: Dotted-Path Merge, Patch Routing, Timing Cascade 🟠

- **Where:** `EditFragment.kt` — `applyFieldValues` (766–839, merging flat field map into
  nested `LocationData`/`EnvironmentData`, `participants = v.split(", ")`),
  routing "unit-only vs full scene" (878–901), cascade timing recalculation
  (`handleRangeChange` 1142–1177), boundary clamping (1044–1049).
- **Current:** Client knows the entity schema (which fields go where), decides the patch format,
  recalculates timings for all subsequent units when one shifts, and clamps boundaries to valid range.
- **Via backend:** Send a **flat set of changed fields** (`{path: value}`) to the server;
  server assembles the nested structure per schema (it has `workflows/entity-schema.js`),
  determines the minimal patch, and **recalculates the timing cascade itself**
  (the `updateSceneTimings` endpoint already exists — `TimingBoundary`). Validation/clamping done by server.
- **Pros:** Entity schema knowledge leaves the client (currently duplicated with server);
  timing cascade is a pure business rule; less chance of desync when fields are added.
- **Cons:** Editor may become slightly less "responsive" (cascade computed by server) — resolved with optimistic UI + server confirmation. Some immediate visual feedback (drag boundary) stays on client for smoothness.
- **Recommendation:** **MIGRATE merge/validation/cascade**; local drag preview — KEEP.
- **Complexity:** Medium–high (most coupled piece of the editor).

---

### F9. Cover Identification and Chunk → (Chapter, Scene) Mapping 🟡

- **Where:** `GenerateViewModel.kt:477–497` (enumerating all chunks, `N` calls to
  `getChunkStoryboard`, finding `scene_type == "cover"`), duplicated at 561–572, 783–796;
  fallback `coverId = coverChunkId ?: chunkIds.firstOrNull()`.
- **Current:** To find the cover and chunk positions, client makes one request per chunk
  and builds a `chunkId → (chapter_id, scene_id)` map + determines cover via heuristic.
- **Via backend:** `getAllChunks` / `assets-state` should return `cover_chunk_id` and
  `chunk_positions` map **in a single response**.
- **Pros:** N network calls eliminated (performance win!), cover heuristic removed; less code.
- **Cons:** Slightly more data in one response (negligible).
- **Recommendation:** **MIGRATE** — this is both simplification and acceleration.
- **Complexity:** Low.

---

### F10. Import Dedup/Resume Orchestration and "Book Ready" Detection 🟡

- **Where:** `GenerateViewModel.kt:652–689` (dedup → state check → resume →
  conditional polling), ready detection `659–663` (`state in [BOOTSTRAPPED, ACTIVE] &&
  parsedChapters > 0`), `pollAgentProgress` 836–909 ("3 consecutive inactive" counter, 10 min timeout).
- **Current:** Client implements an idempotent import state machine and determines
  "completion" by string states and counters; decides when to stop polling.
- **Via backend:** `POST /import-txt` (and `resume-bootstrap`, `import-routes.cjs`) should
  handle dedup/resume internally and return an explicit status (`{resumed, complete, ready}`).
  Readiness — explicit boolean flag from server, not string matching on client. Replace polling
  with SSE completion signal (stream already exists).
- **Pros:** Complex state machine moves to server; magic thresholds disappear ("3 inactive", "10 minutes"); simpler and more reliable.
- **Cons:** Requires endpoint contract work.
- **Recommendation:** **MIGRATE.**
- **Complexity:** Medium.

---

### F11. Client "Stuck" Detection and Auto-Complete Generation 🟡

- **Where:** `MainActivity.kt:610–623`.
- **Current:** If progress hasn't changed for 120s (`STUCK_TIMEOUT_MS`), client polls
  `getWorkerCounts()` and, if `active_scenes == 0`, **independently** stops the stream
  and calls `applyGenerationResults()` — i.e., decides that generation is finished.
- **Via backend:** Server owns the true queue/lease state and should send terminal events
  `generation_complete` / `generation_stalled` in the progress stream.
  Client reacts to events, not timer heuristics.
- **Pros:** Race condition and "magic" 120s removed; correct with multiple clients; server already knows about stalls (`worker-health.js`, `circuit-breaker.js`).
- **Cons:** Need to add terminal events to stream.
- **Recommendation:** **MIGRATE** (replace heuristic with server event).
- **Complexity:** Low–medium.

---

### F12. Workflow/Connector Screen Logic (dev-facing) 🟡

- **Where:** `WorkflowManagerViewModel.kt:47–76` (grouped→flat fallback + type filtering),
  `WorkflowManagerFragment.kt:49–90` ("active" count = `status in [compatible, registered]`),
  `WorkflowDetailsViewModel.kt:141–215` (multi-binding expansion, synthetic key generation `key[0]`),
  `WorkflowDetailsFragment.kt:1045–1175` (compatible node filtering by `expectedClass`, default `"LTXVAddGuide"`, fallback cascades),
  `WorkflowTypeListFragment.kt:114–195` (JSON connector parsing, name guessing, `conn-` prefix),
  `parseInputValue`/`parseAny` (712–718) — type coercion.
- **Current:** Client groups/filters connectors, counts "active," expands multi-binding to flat list with synthetic keys, filters compatible nodes, sets defaults, extracts/guesses connector name, coerces value types.
- **Via backend:** Grouped endpoint should always return grouped data (no client fallback); "active" count on server; multi-binding served flat; node compatibility and defaults — server-side validation; connector name — mandatory field validated by server; type coercion/validation on server at save time.
- **Pros:** Consistency, server-side config validation (currently client sends values without type/compatibility check).
- **Cons:** Screen is **tool/developer-facing** — secondary for end clients (Web/Mobile "reader" won't see it). Lower priority than user screens.
- **Recommendation:** **MIGRATE selectively** (grouping, counters, multi-binding, type validation), but **low priority** — not on the user path.
- **Complexity:** Medium, but fragmented.

---

### F13. IU Duration Fallback 🟡

- **Where:** `PlaybackViewModel.kt:849–855, 907–912` (`fallbackDurationMs`).
- **Current:** Client derives IU duration: `end_ms - start_ms`, else
  `estimated_duration_sec * 1000`, else default 2000ms.
- **Via backend:** Return already-computed `duration_ms` in the IU response (deterministic, no client state).
- **Pros:** Rule (interval → estimate → 2s) computed once on server.
- **Cons:** Minimal; ~20 lines.
- **Recommendation:** **MIGRATE** (cheap, while we're at it).
- **Complexity:** Very low.

---

### F14. File Format Detection (vbook vs txt) and Dispatch 🟢/KEEP-ish

- **Where:** `MainActivity.kt:786–809`, `FileFragment.kt:80–101`, `VbookFileUtils.kt:8–31`,
  `NavigateFragment.kt:551–553`.
- **Current:** Client checks zip header and presence of `manifest.json`/`book.json`, decides
  `loadBookFromFile` or `importTxtFromFile`.
- **Via backend:** Could load file to a single `POST /import` endpoint; server determines format and routes.
- **Pros:** Unification; new formats added on server.
- **Cons:** Local `.vbook` bundle check saves uploading provably wrong files; "is this a zip?" check is reasonable on client. Borderline case.
- **Recommendation:** **Optional** — move format detection to server (unified `/import`), keep lightweight "is this an archive?" check. Low priority.
- **Complexity:** Low.

---

### F15. Retry/Backoff and Caching — Primarily KEEP 🟢

- **Where:** `Repository.kt:78–117` (multi-level cache mem→disk→net, composite key
  `id_buildId`), `pollWithBackoff` (GenerateViewModel:1244–1254), SSE-reconnect
  (`ProgressStream.kt:176–201`), error extraction from JSON (`Repository.kt:34–43`).
- **Assessment:** This is **client network resilience and caching** — legitimate client
  responsibility. Backoff/reconnect/cache **stays**. The only thing — where polling
  and retry *mask absence of server push signal* (F10, F11), they will naturally go away
  when switching to SSE events.
- **Recommendation:** **KEEP** (except cases covered by F10/F11). `error` extraction from body is
  fine, but server should always send structured errors `{error, code}`.
- **Complexity:** —

---

## 3. What Stays on the Client (Summary)

| Area | File(s) | Why KEEP |
|---|---|---|
| Player timing, chaining, seek | PlaybackViewModel, PlayFragment | Real-time, local `MediaPlayer` |
| IU image looping under position | PlayFragment:893–927 | Bound to local playback position |
| Screen rotation recovery | PlayFragment:399–404 | Local sequence, Android-specific |
| Layout/density/aspect | EditFragment:356–387 | Pure UI |
| "Typing..." animation | AiAssistantFragment:650–657 | Cosmetic |
| `status→color/string`, `dataType→InputType` | Workflow*, ChatAdapter | Localization and widgets |
| Fragment Bundle serialization | WorkflowDetailsFragment:323–401 | Platform constraint |
| Cache/backoff/reconnect | Repository, ProgressStream | Client network resilience |
| "Done" highlight duration | GenerateViewModel | Display UI policy |

---

## 4. Final Plan (by priority, for gradual migration)

Priority = (multi-client value × bug elimination) ÷ complexity.

### Wave 1 — "Cheap Duplicates" (max win / min risk)

| # | Task | Finding | Complexity | Type |
|---|---|---|---|---|
| 1 | Return `profile` in all needed responses; remove `computeProfile()` from frontend | F1 | XS | Duplicate |
| 2 | Return `duration_ms` for IU; remove `fallbackDurationMs` | F13 | XS | Duplicate |
| 3 | Return `cover_chunk_id` + `chunk_positions` in `getAllChunks`; remove N requests | F9 | S | Duplicate + perf |
| 4 | Always populate `chapter_title` on server; remove `enrichTitles`/`extractChapterTitleFromIntro` | F7 | S | Duplicate |
| 5 | Add `display_number`/`display_index`/`path_label` to book model; remove numbering from 3 screens | F5 | S–M | Duplicate |

### Wave 2 — "Progress and Generation State" (eliminates a class of bugs)

| # | Task | Finding | Complexity | Type |
|---|---|---|---|---|
| 6 | Normalize SSE `vbook` event (numeric fields); remove regex parsing | F3 | S–M | Logic |
| 7 | Server-side progress panel aggregator (`progress`); replace `computeWorkers` with render | F2 | M | Logic |
| 8 | Terminal `generation_complete/stalled` events in stream; remove "stuck-120s" | F11 | S–M | Logic |
| 9 | Explicit import status (`resumed/complete/ready`) + completion signal; remove `pollAgentProgress` state machine | F10 | M | Logic |

### Wave 3 — "Decisions and Reconciliation" (architecturally valuable)

| # | Task | Finding | Complexity | Type | Status |
|---|---|---|---|---|---|
| 10 | Move window trigger decision to server (client sends position) | F4 | M | Logic | ✅ Done |
| 11 | Chat system-prompt assembly on server (client sends parameters) | F6 | M | Logic | ✅ Done |
| 12 | Server-side edit merge + timing cascade (client sends flat fields) | F8 | M–H | Logic | ✅ Done |

### Wave 4 — "Tool Screens" (low priority)

| # | Task | Finding | Complexity | Type |
|---|---|---|---|---|
| 13 | Server-side grouping/counters/validation for connectors and workflows | F12 | M | Logic (dev) | ✅ Done |
| 14 | Unified `/import` with server-side format detection | F14 | S | Optional | ✅ Done |

### Do Not Migrate (KEEP)

F15 (client cache/backoff/reconnect) and everything in section 3 — keep on client.

---

## 5. General Contract Recommendations

1. **Don't serve "raw data" for client computation.** If the server knows the answer (profile, chapter number, percentage, readiness) — return the ready value, not fields for computation.
2. **Localization ≠ business logic.** Numbers/structure/decisions computed by server; words ("Chapter", "Scene") and colors substituted by client.
3. **Push instead of poll.** Where client polls and decides "is it done" (F10/F11) — replace with terminal SSE events. Backoff polling as fallback — keep.
4. **Single source of truth for schemas.** Entity schema (`entity-schema.js`) and profile/mode definitions should live only on server; client does not duplicate them.
5. **Version the contract.** When migrating logic, add fields without breaking old clients (additive), so APK and future Web can coexist.

---

*This report is advisory. No refactoring was performed — only an audit prepared on request. Ready to detail the contract for any item or start with Wave 1.*
