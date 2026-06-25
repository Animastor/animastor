# Changelog

All notable changes to Animastor are documented here.

---

## [Unreleased] — 2026-06-25

### Fixed

- **AI chat errors & VBook progress polling** (`backend/src/routes/ai-routes.cjs`, `backend/src/services/ai-service.js`, `frontend/.../GenerateViewModel.kt`):
  - Fixed AI chat error handling and trigger endpoint.
  - Fixed VBook progress polling from frontend.
  - Fixed missing `gpuProgressDoneAt` reset after `clearVBookProgress`.

- **Trigger dedup & background loop** (`frontend/.../WindowTriggerManager.kt`, `frontend/.../MainActivity.kt`):
  - Fixed trigger deduplication to prevent duplicate window triggers.
  - Fixed background polling loop for VBook progress.
  - Fixed position label rendering in EditFragment.

- **AI JSON parse error — CoT think tags** (`backend/src/services/ai-service.js`):
  - Strip chain-of-thought XML tags (`<think>`, `<reasoning>`) from AI responses before JSON parsing.
  - Increased `maxTokens` from 2048 to 4096 for analysis steps.

- **VBook agent status polling** (`frontend/.../GenerateViewModel.kt`, `frontend/.../AiAssistantFragment.kt`):
  - Fixed `poll checkVBookAgentStatus` to work in the active VBook branch.
  - Fixed chapter numbering for special types (cover, prologue) in `AiAssistantFragment`.

### Chore

- **Dead code removal** (`backend/src/helpers/utils.cjs`): Removed unused `safeBuildPath` and `safeBuildPathAbsolute` functions (duplicated in `cleanup-service.cjs`).

---

## [2026-06-24]

### Fixed

- **Infinite window-trigger loop** (`frontend/.../WindowTriggerManager.kt`, `backend/src/services/agent-service.js`):
  - Frontend: removed `isLastChapterScene` condition that fired on every last scene of a chapter, not just window boundaries. Added 60s cooldown between triggers. Added one-shot guard per unit position.
  - Backend (`bootstrapNextWindow`): added dedup check — if the latest session is 'completed' or 'paused' with no remaining text/scenes, return `all_done`. Added offset dedup via DB query to prevent processing the same text offset twice.

- **Cover chapter ordering** (`backend/src/book/lazy-book/index.js`): `createOrAppendScenes()` no longer overwrites `chapters_order` with a simple `readdirSync().sort()`. Now scans chapter files for `type: 'cover'` and ensures the cover chapter stays at position 0.

- **`bootstrapNextWindow()` window_data lookup** (`backend/src/services/agent-service.js`): The function creates a *new* `agent_sessions` row for each window, which has null `window_data`. Now it queries the previous session's `window_data` (`SELECT ... WHERE window_data IS NOT NULL ORDER BY created_at DESC LIMIT 1`) to recover `currentOffset`, `all_characters`, and `all_locations`. Previously each new window restarted from offset 0, overwriting already-processed scenes.

- **CHECK constraint: `'paused'` status** (`backend/src/storage/postgres/schema.js`): Added `'paused'` to the `agent_sessions.status` CHECK constraint (`IN ('running','paused','completed','failed')`). A `runMigrations()` step drops and recreates the constraint on existing tables. Previously `updateSession()` with `status = 'paused'` failed atomically, preventing `progress_msg` from being saved — the chat showed only three dots instead of generation stages.

- **Null-preserving IU timing insert** (`backend/src/storage/postgres/repositories/iu-repo.js`): Changed `data.start_ms || 0` → `data.start_ms != null ? Number(data.start_ms) : null` so that null timings remain null in PostgreSQL instead of being stored as `0`. This fixed downstream checks that treat `0` as a valid timing value.

- **Timing persistence** (`backend/src/routes/generation-routes.cjs`):
  - **Storyboard endpoint**: After computing `estimated_duration_sec`, now also computes cumulative `start_ms`/`end_ms` boundaries and persists them to `image_units` immediately.
  - **GET /timings endpoint**: After computing timing boundaries in memory, persists them via `upsertIuTiming()` so subsequent calls don't recompute from scratch.

- **End-of-window trigger restored** (`frontend/app/src/main/java/com/example/animastor/ui/EditFragment.kt`): Recreated `checkEndOfWindowAndTrigger()` — detects the user selecting one of the last 3 units of the last scene in a window and calls `repository.triggerNextWindow()`. The function was previously removed during a refactor with a note that it was moved to `PlaybackViewModel`, but was never re-implemented there.

### Feat

- **Per-window reconnaissance** (`backend/src/services/agent-service.js`, `backend/src/book/lazy-book/parser.js`):
  - Characters and locations are now extracted and merged from each window, not just the first.
  - ALL-CAPS chapter headings detection without explicit `Глава` marker.
  - `injectChapterMarkers()` auto-inserts `[ГЛАВА: TITLE]` markers into source text.

- **Unified GPU+VBook progress panel** (`frontend/.../MainActivity.kt`, `frontend/.../GenerateViewModel.kt`):
  - VBook agent shown alongside GPU workers in the same progress panel.
  - Each worker type gets its own row (name + count + percent + progress bar).
  - Completed workers auto-hide after 10 seconds.

- **Global window trigger** (`frontend/.../WindowTriggerManager.kt`):
  - `WindowTriggerManager` observes `SharedPositionManager` from any screen.
  - Triggers next-window generation when user navigates to last 3 units of the last scene in a window.
  - 60s cooldown, dedup per window, one-shot per unit position.

### Chore

- **TTL 14400 for iu-progress** (`backend/src/.../iu-repo.js`): TTL increased from 3600 to 14400 seconds.
- **Remove shouldGenerateIUImage dead code**: Removed unused function that was already dead.
- **PATCH snapshot-based diff**: Updated diff algorithm to work with PATCH endpoint.
- **Update docs**: CHANGELOG.md, PROJECT_STRUCTURE.md.
