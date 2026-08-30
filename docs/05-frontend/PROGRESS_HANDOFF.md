# GPU Progress — Frontend Handoff (F1–F7)

> **Status as of 2026-06-27.** Backend part (B1–B5) and frontend part (F1–F7)
> are fully implemented and committed (branch `feat/orchestrator-facade`, build
> `assembleDebug` successful). This document is an archival reference.
> **All GPU Progress tasks are closed.**
>
> **Source:** `docs-claude/PROGRESS_FRONTEND_HANDOFF.md`

## Motivation

Users reported GPU generation progress inaccuracies/crashes in the Android UI:
progress jumping, rolling back, showing false "Done", sometimes freezing and
auto-completing even though assets were not ready.

## What is already done on the backend (contract for the frontend)

1. **`/assets-state` is now deterministic and monotonic.** `ready` values do not
   decrease within a single generation. Disk file scanning has been removed.
   Source of truth is the Redis counter `animastor:iu-progress:...`.
2. **New fields in `AssetsStateResponse`** (backend already returns them):
   `audio_error`, `image_error`, `video_error` (Int, count of chunks with
   `error`/`failed` status).
3. **New SSE endpoint:** `GET /api/v1/book/{bookId}/progress-stream`.
   - `Content-Type: text/event-stream`
   - `event: open` event on connection
   - Progress events `data: {"type":"progress",...}`
   - Heartbeat comments `: ping\n\n` every 15 seconds

## Frontend map (where things are)

- `frontend/app/build.gradle.kts` — dependencies. OkHttp **4.12.0** is already present.
- `frontend/.../RetrofitClient.kt` — `object RetrofitClient`
- `frontend/.../BackendApi.kt` — Retrofit interface
- `frontend/.../LayerConfig.kt` — `data class AssetsStateResponse`
- `frontend/.../Repository.kt` — wrapper classes
- `frontend/.../MainActivity.kt` — poller, progress state
- `frontend/.../GenerateViewModel.kt` — ActiveGeneration, StateFlow
- `frontend/.../item_worker_progress.xml` — worker row
- `frontend/.../strings.xml` — strings `progress_*`

## Implemented steps

### VBook progress contract (2026-07-02)

TXT/VBook import progress is separate from GPU asset progress but uses the same
panel row.

- Backend SSE events with `type="vbook"` expose cumulative 1-based
  `scene_index` plus current-block metadata: `window_scene_index`,
  `window_total_scenes`, `window_start_scene`.
- `/agent-status` returns the same block metadata when it can derive it from
  `agent_sessions.window_data`.
- `window_size` is an advisory cap / legacy fallback. It is not a source-text
  boundary and must not be used to infer where the book import should continue.
- Android normalizes these fields into `VBookProgress`: `sceneIndex` is 0-based
  inside the current generated block; `-1` means the agent is preparing scenes
  but has not started a concrete scene yet.
- `WindowTriggerManager` triggers the next import window when the user reaches
  the last units of the currently loaded tail scene. It does not trigger every
  fixed third scene.
- On VBook completion the frontend calls `applyGenerationResults()` so newly
  appended chunks/scenes soft-refresh into playback.

### ✅ F7. Error fields in the response model
Added `audio_error: Int = 0`, `image_error: Int = 0`, `video_error: Int = 0`
to `AssetsStateResponse`.

### ✅ F3. Monotonic progress (no rollbacks)
Added `workerReadyFloor: MutableMap<String, Int>` in `MainActivity.kt`.

### ✅ F4. Stuck detection (false auto-complete)
`STUCK_TIMEOUT_MS = 120_000L`. Check `!lastPollFailed` before stuck branch.

### ✅ F5. Layer completion by flags, not heuristics
Parameter `doneFlag` in `add()`.

### ✅ F6. Poller resilience
Backoff: 1.5s → 3s → 6s (cap), reset on success.

### ✅ F1. SSE client
Created `network/ProgressStream.kt`.

### ✅ F2. Logic extraction to ViewModel
Optional refactoring.

## Final verification

- `./gradlew assembleDebug` — compilation.
- Manual run with `full` profile: progress grows smoothly, no rollbacks.
- Network interruption during generation: UI does not auto-complete on stuck.
