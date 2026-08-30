# Task Architecture (Progress Panel)

> **Date:** 2026-07-26
> **Context:** After ChatGPT 5.5 redesign (F15 parallel generation) and subsequent worker→task terminology refactoring.

---

## 1. Terminology

| Term | Description |
|---|---|
| **Task** | A single generation job created by the user. Has a type (`audio`/`image`/`video`), scope, and list of targets (scenes). |
| **TaskRow** | A single row in the UI progress panel. One task may produce one or more rows (see scope). |
| **GPU Worker** | Remote process on the GPU Hub performing work. Do not confuse with UI rows. |
| **Scope** | Generation scope: `current_scene`, `current_chapter`, `from_current_scene`, `whole_book`. |

---

## 2. Task Lifecycle

```
User selects scope and type
         │
         ▼
  Frontend: startGeneration()
         │
         ▼
  Backend: /regenerate → generation-routes.cjs
         │  checks dirty_scenes, adds cover if needed
         ▼
  Backend: generation-progress.js → createTasks()
         │  creates a task for each type × scope
         │  task has task_id, type, scope, targets[scenes]
         ▼
  Backend: scheduler + dispatch-engine → GPU Hub
         │  perform work, update asset states
         ▼
  Backend: progress-panel.cjs → buildTaskRows()
         │  reads tasks from redis, calculates ready/total
         │  returns TaskRow array (JSON)
         ▼
  Frontend: computeProgressRows()
         │  builds UI rows with progress, timers, expiry
         ▼
  Frontend: renderTaskRowsToSections()
         │  renders rows into containers by type
```

---

## 3. Scope → Number of Rows

The main rule: **one job — one row**, except when the user explicitly selected a specific scene.

| Scope | Behavior | Example |
|---|---|---|
| `current_scene` | **Per-target**: each target → separate row | Image for scene5 + cover → 2 Image rows |
| `current_chapter` | **Aggregated**: one row per type | Audio for chapter3 (5 scenes) → 1 Audio row |
| `from_current_scene` | **Aggregated**: one row per type | Same 5 scenes → 1 row |
| `whole_book` | **Aggregated**: one row per type | 20 scenes → 1 Image row |

### Why?

- **current_scene**: if cover is added to dirty, it is a **different scene**. It has its own progress, its own timer. Showing both in one row is incorrect.
- **whole_book / chapter / from_current**: this is **one job** with multiple targets. The user wants to see overall job progress, not 20 separate rows.

Implemented in `backend/src/routes/book/progress-panel.cjs` — `buildTaskRows()`:

```javascript
if (task.scope === 'current_scene') {
    // per-target expansion
    for (const target of targets) {
        // calculate ready/total for ONE scene
        result.push({ task_id, type, scene_id, ready, total, ... })
    }
    return result
} else {
    // aggregated: one worker for all targets
    return [{ task_id, type, ready, total, ... }]
}
```

---

## 4. Per-Task Timer (Frontend)

Each row (TaskRow) has its own timer:

```
Map<String, Long> taskFrozenElapsed   // taskKey → frozen seconds
Map<String, Long> taskCompletedAt     // taskKey → time of 100%
```

### Mechanics

1. **Task is active**: timer runs from `timerStartedAt` (global session start)
2. **Task reaches 100%**:
   - `taskCompletedAt[taskKey] = now` — record completion time
   - `taskFrozenElapsed.getOrPut(taskKey) { ... }` — freeze time at this point
3. **Task is displayed for 10 seconds** after reaching 100%
4. **After 10 seconds** past 100%:
   - `rows.removeAll { row.done && (now - taskCompletedAt) >= 10s }`
   - Row disappears independently of other rows
5. **When all rows disappear** → `applyGenerationResults()`, finalization

### Why independent expiry?

- Audio finishes before Image → Audio row disappears after 10s, Image continues to display
- If one generation is stuck, completed ones do not hang forever
- The user does not wait for all jobs to finish to see Done

---

## 5. Data Models (Frontend)

```kotlin
// Single progress row
data class TaskRow(
    val taskId: String?,
    val type: String,          // "audio" | "image" | "video" | "vbook"
    val label: String,         // localized name
    val scope: String,
    val chapterId: String?,
    val sceneId: String?,      // for per-scene rows
    val ready: Int,
    val total: Int,
    val percent: Int,
    val done: Boolean,
    val countText: String?,
    val indeterminate: Boolean, // spinner (VBook analyzing)
    val cancelled: Boolean,
    val elapsedSeconds: Long    // frozen for done, live for active
)

// Progress panel state
sealed class ProgressPanelState {
    data class Rows(val rows: List<TaskRow>)  // one or more rows
    object DoneRow                              // all Done (legacy, not used)
    object Hidden                               // no active tasks
}

// Localized labels
data class TaskLabels(
    val cover: String,
    val audio: String,
    val image: String,
    val video: String,
    val generationDone: String,
    val vbookLabel: String,
    val vbookAnalyzing: String,
    val vbookScenesFormat: (Int, Int) -> String
)
```

---

## 6. Backend (progress-panel.cjs)

**Endpoint:** `GET /api/v1/book/:bookId/progress-panel`

Response — task row array:

```json
{
  "workers": [
    {
      "task_id": "generation-image-1712345678901-a1b2c3d4",
      "type": "image",
      "scope": "current_scene",
      "chapter_id": "ch01",
      "scene_id": "scene_cover",
      "target_count": 1,
      "ready": 5,
      "total": 5,
      "percent": 100,
      "done": true,
      "visible": true,
      "indeterminate": false,
      "cancelled": false
    },
    {
      "task_id": "generation-image-1712345678901-a1b2c3d4",
      "type": "image",
      "scope": "current_scene",
      "chapter_id": "ch01",
      "scene_id": "scene_005",
      "target_count": 1,
      "ready": 3,
      "total": 5,
      "percent": 60,
      "done": false,
      "visible": true,
      "indeterminate": false,
      "cancelled": false
    }
  ]
}
```

**Note:** The `workers` field in the JSON response was kept for backward compatibility. On the frontend these objects are called `ProgressWorker` in API models, but displayed as `TaskRow`.

---

## 7. Files

| File | Role |
|---|---|
| `backend/src/services/generation-progress.js` | Creates tasks, stores in Redis, tracks status |
| `backend/src/routes/book/progress-panel.cjs` | Builds response for /progress-panel, aggregates or expands per-target |
| `frontend/.../GenerateViewModel.kt` | `computeProgressRows()`, timers, expiry, `TaskRow` model |
| `frontend/.../GenerateFragment.kt` | `renderTaskRowsToSections()`, render, Stop buttons |
| `frontend/.../SettingsFragment.kt` | `resetProgressState()` on cache clear |

---

## 8. Rename history

Was (from ChatGPT 5.5) | Became | Reason
---|---|---
`WorkerUi` | `TaskRow` | Confusion with GPU Worker
`computeWorkers()` | `computeProgressRows()` | Function does not compute workers
`workerReadyFloor` | `taskReadyFloor` | Relates to task, not worker
`workerCompletedAt` | `taskCompletedAt` | -"-
`workerFrozenElapsed` | `taskFrozenElapsed` | -"-
`COMPLETED_WORKER_DISPLAY_MS` | `COMPLETED_TASK_DISPLAY_MS` | -"-
`gpuProgressDoneAt` | *(removed)* | Dead variable
`resetWorkerState()` | `resetProgressState()` | Resets progress state
`cancelWorker()` | `cancelTask()` | Cancels task, not worker
`WorkerLabels` | `TaskLabels` | Labels for rows, not workers
`ProgressPanelState.Workers` | `ProgressPanelState.Rows` | List of rows, not workers
`buildWorker()` (backend) | `buildTaskRows()` | Builds rows, not workers
`renderWorkersToSections()` | `renderTaskRowsToSections()` | Renders rows
`setupWorkerStopButton()` | `setupTaskStopButton()` | Task cancel button
`scopedWorkerLabel()` | `scopedTaskLabel()` | Label for task
