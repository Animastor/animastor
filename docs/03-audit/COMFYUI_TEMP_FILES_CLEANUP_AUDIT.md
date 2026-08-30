# ComfyUI Temp Files Audit in Worker

> Full audit of ComfyUI temp file lifecycle (input/output) created by
> worker.cjs during image / audio / video generation. Research conducted
> before implementing post-job cleanup.
>
> **Read-only**: nothing was fixed. Based on source code reading.
> Date: 2026-08-24. Branch: `master` (`90b9d22`).
>
> ## Implementation Status
>
> Audit implemented in two commits:
> - **`b860162`** — per-job targeted cleanup (`cleanupJobArtifacts`, try/finally):
>   input+output deleted after successful result delivery.
> - **`e874761`** — crash-safe recovery via worker-local journal
>   (`worker-cleanup-journal.cjs`): lifecycle CREATED→GENERATED→DELIVERED→CLEANED
>   persisted on worker's persistent disk; on restart `recoverCleanupJournal()`
>   cleans up files of jobs whose result was already delivered to hub (delivered), and
>   removes input files of undelivered jobs (output preserved). Details in
>   `COMFYUI_CLEANUP_RECOVERY_AUDIT.md` and the code itself.

---

## 1. Executors

**Single universal worker**: `worker/worker/worker.cjs` (657 lines, CJS).

Type set by `WORKER_TYPE` (image | audio | video) and only affects:
- timeouts (`VIDEO_RESULT_TIMEOUT_MS` vs `RESULT_TIMEOUT_MS`);
- result search logic in `waitResult` (fs-scan for video).

No separate worker files per type.

---

## 2. Path Configuration

| Variable | Default Value | Purpose |
|---|---|---|
| `COMFY_INPUT_DIR` | `/home/jovyan/ComfyUI/input` | Where worker places reference images |
| `COMFY_OUTPUT_DIR` | `path.resolve(COMFY_INPUT_DIR, "../output")` | Where worker reads results |

---

## 3. Full Task Lifecycle

### 3.1 Image (IU Image)

```
Job received (task.assets.image: base64)
  → saveBase64ImageSafe(base64, "{baseId}.png") → COMFY_INPUT_DIR/{baseId}.png
  → waitForFileReady(inputPath, expectedSize)
  → runWorkflow(task.params) → ComfyUI /prompt → prompt_id
  → waitResult(prompt_id)
      → /history/{prompt_id} → outputs[SaveImage].images[0] → {filename, subfolder: "", type}
  → downloadResult(meta)
      → reads COMFY_OUTPUT_DIR/{filename} (locally, OOM-safe)
      → base64 → data URL
  → sendResult(task, base64) → hub → backend
      → backend writes to /data/output/{buildId}/{bookId}_{chapterId}_{sceneId}_{iuId}.png
  → Done
```

**Input file**: `COMFY_INPUT_DIR/{baseId}.png`
**Output file**: `COMFY_OUTPUT_DIR/ComfyUI_XXXXX_.png`
**Backend file**: `/data/output/{buildId}/{bookId}_{chapterId}_{sceneId}_{iuId}.png`

### 3.2 Audio (Audio Chunk)

```
Job received (no assets)
  → runWorkflow(task.params) → ComfyUI /prompt → prompt_id
  → waitResult(prompt_id)
      → /history/{prompt_id} → outputs[SaveAudioMP3].audio → {filename, subfolder: "audio", type}
  → downloadResult(meta)
      → reads COMFY_OUTPUT_DIR/audio/{filename}
      → base64 → data URL
  → sendResult(task, base64) → hub → backend
      → backend writes to /data/output/{buildId}/{bookId}_{chapterId}_{sceneId}_{chunkIndex}.mp3
  → Done
```

**Input file**: none
**Output file**: `COMFY_OUTPUT_DIR/audio/tts_XXXXX_.mp3` or `COMFY_OUTPUT_DIR/audio/dialogue_XXXXX_.mp3`

### 3.3 Video (Scene Video, Multi-Image I2V)

```
Job received (task.assets.images: { [unitId]: base64 })
  → for each unitId: saveBase64ImageSafe(base64, "{scenePrefix}_{unitId}.png")
      → COMFY_INPUT_DIR/{scenePrefix}_{unitId}.png  (×N)
  → waitForFileReady for each
  → runWorkflow(task.params) → ComfyUI /prompt → prompt_id
  → waitResult(prompt_id)
      → 1) /history → outputs[SaveVideo].videos[0].filename
      → or 2) outputs[*].[*].filename where .endsWith('.mp4')
      → or 3) fs-scan: output/video/ → new .mp4 → filter by prefix "LTX-2"
  → downloadResult(meta)
      → reads COMFY_OUTPUT_DIR/video/{filename}
      → base64 → data URL
  → sendResult(task, base64) → hub → backend
      → backend writes to /data/output/{buildId}/{bookId}_{chapterId}_{sceneId}_gN.mp4
  → Done
```

**Input files**: `COMFY_INPUT_DIR/{scenePrefix}_{unitId}.png` (same count as IUs)
**Output file**: `COMFY_OUTPUT_DIR/video/LTX-2_XXXXX_.mp4`
**Backend file**: `/data/output/{buildId}/{bookId}_{chapterId}_{sceneId}_gN.mp4`

---

## 4. Input File Name Formation

```js
// job_id examples:
//   "bookId_chapterId_sceneId_iu1:iu_image"  — IU image
//   "bookId_chapterId_sceneId_0001:audio"     — audio chunk
//   "bookId_chapterId_sceneId_g1:video"      — video group

// Base ID (without type suffix):
const [baseId] = task.job_id.split(/:(iu_image|image|audio|video)$/);

// For multi-image (video) — strip group suffix _gN:
const scenePrefix = baseId.replace(/_g\d+$/, '');

// Final input file name:
//   single image:  "{baseId}.png"
//   multi-image:   "{scenePrefix}_{unitId}.png"
```

Input names contain `job_id` → unique per task.

---

## 5. Output File Detection

### Image
`/history/{prompt_id}` → `outputs[nodeId].images[0]`:
```json
{ "filename": "ComfyUI_00001_.png", "subfolder": "", "type": "output" }
```
→ `COMFY_OUTPUT_DIR/ComfyUI_00001_.png`

### Audio
`/history/{prompt_id}` → `outputs[nodeId].audio`:
```json
{ "filename": "tts_00001_.mp3", "subfolder": "audio", "type": "output" }
```
→ `COMFY_OUTPUT_DIR/audio/tts_00001_.mp3`

### Video (3 mechanisms)
1. `/history` → `outputs[nodeId].videos[0].filename`:
   ```json
   { "filename": "LTX-2_00001_.mp4", "subfolder": "video", "type": "output" }
   ```
2. Fallback: `outputs[*].[*].filename` where `.endsWith('.mp4')`
3. Fs-scan: `output/video/` → new `.mp4` → `prefix` = `path.basename("video/LTX-2")` = `"LTX-2"`

---

## 6. What Gets Deleted Currently

**Worker.cjs: NOTHING.** Neither input nor output deleted after success, error, or in `finally`.

**Backend (not ComfyUI-related):**
- `cleanupService.cleanupBuild(buildId)` — deletes `/data/output/{buildId}` entirely (REST API / regeneration / reconciliation).
- Pre-delete stale PNG during dirty regeneration (`iu-processor.js:145-163`, `scene-orchestrator.js:381-387`).

**Result**: each task leaves on worker machine disk:
- 1 PNG in `input/` (image) or N PNGs (video multi-image)
- 1 PNG/MP3/MP4 in `output/` (or `output/audio/`, `output/video/`)

Trash accumulates indefinitely.

---

## 7. Output Files: Format and Subfolder

| Type | Node | filename_prefix | Actual Path | subfolder |
|---|---|---|---|---|
| Image | `SaveImage` | `ComfyUI` | `output/ComfyUI_XXXXX_.png` | `""` |
| Audio | `SaveAudioMP3` | `audio/tts` | `output/audio/tts_XXXXX_.mp3` | `audio` |
| Audio (dialogue) | `SaveAudioMP3` | `audio/dialogue` | `output/audio/dialogue_XXXXX_.mp3` | `audio` |
| Video | `SaveVideo` | `video/LTX-2` | `output/video/LTX-2_XXXXX_.mp4` | `video` |

---

## 8. Competition and Name Safety

| Scenario | Risk | Comment |
|---|---|---|
| Single worker, sequential tasks | None | Worker.cjs processes tasks in loop, one at a time. Names contain job_id → unique. |
| Two workers on one machine | None | Each is separate process with unique job_id. |
| image + video worker on one ComfyUI | None | Different file names (different unitIds). |
| Two tasks with same job_id | None | job_id is unique — contains bookId + chapterId + sceneId + chunkIndex/IUId. |
| Worker restart during task | Yes | Orphaned files remain. Not critical, but accumulates. |
| Single task, multiple groups (video _g1, _g2) | None | Each group is separate job with unique job_id. |

---

## 9. Error Handling

| Situation | What Happens | Output Exists? | Cleanup Needed |
|---|---|---|---|
| ComfyUI error (no prompt_id) | `runWorkflow` → throw | No | Input cleanup |
| Timeout in waitResult | `waitResult` → throw (60s / 2h) | Possibly partial | Input cleanup |
| Output not found in history | Timeout → throw | No | Input cleanup |
| Worker restart | Process killed → orphan | Yes, all | Orphan cleanup (startup) |
| Task cancellation (backend) | Worker learns via timeout | Possibly | Input cleanup |
| Download error | `downloadResult` → throw | Yes (ComfyUI created) | Input + output cleanup |

---

## 10. Proposed Cleanup Architecture

### 10.1 Where to Place

In `workerLoop()`, in `try { ... } finally { ... }` block:

```js
async function workerLoop() {
  while (true) {
    const task = await getTask();
    // ...
    const createdInputFiles = [];
    let outputFile = null;

    try {
      // save input files → push to createdInputFiles
      if (task.assets?.images) { /* ... push each path */ }
      else if (task.assets?.image) { /* ... push path */ }

      const prompt_id = await runWorkflow(task.params);
      const result = await waitResult(prompt_id, task.params, task.timeout_ms);
      const base64 = await downloadResult(result);

      // remember output for cleanup
      outputFile = {
        path: path.resolve(COMFY_OUTPUT_DIR, result.meta.subfolder || '', result.meta.filename),
        meta: result.meta,
      };

      await sendResult(task, base64);
    } catch (err) {
      await sendTaskError(task, err.message);
    } finally {
      // cleanup input files
      for (const fp of createdInputFiles) {
        await fsp.unlink(fp).catch(() => {});
      }
      // cleanup output file
      if (outputFile) {
        await fsp.unlink(outputFile.path).catch(() => {});
      }
    }
  }
}
```

### 10.2 What to Delete

**Input files**: only those worker itself created (list `createdInputFiles`).
**Output file**: only single specific file obtained from `downloadResult`.

### 10.3 What NOT to Do

- `rm -rf COMFY_INPUT_DIR/*` — would delete other workers' files.
- `rm -rf COMFY_OUTPUT_DIR/video/*` — would delete all videos, including others'.
- Delete output before `sendResult` — `sendResult` may fail, result lost.
- Delete output on error before `downloadResult` — output may not exist.

### 10.4 Job Binding

- **Input**: names contain `baseId` / `scenePrefix` from `job_id` → unique per task.
- **Output**: determined via `waitResult` → `{filename, subfolder}` → full path.
- **Key principle**: delete only what we created (input) and only what we read (output).

### 10.5 Edge Cases

| Edge Case | Handling |
|---|---|
| File already deleted (by other process) | `unlink` in `catch` → ignore |
| Worker restart during task | Files remain (orphan) — resolved by startup sweep |
| Two workers on one machine, one task | Impossible — job_id unique |
| Output in subfolder `audio` or `video` | Full path = `COMFY_OUTPUT_DIR/subfolder/filename` |
| Video multi-image (N input files) | All N recorded in `createdInputFiles` |
| Audio (no input files) | `createdInputFiles` empty → cleanup only output |
| Error after waitResult, before downloadResult | Output exists but not read. Delete? **No** — if error is temporary, re-dispatch will find file. |
| Error before waitResult | Output doesn't exist → only input cleanup |

### 10.6 Additional (Startup Sweep)

On worker startup, can add sweep of orphaned files older than N hours.
Caution: sweep must only delete files whose `job_id` is inactive (not in `animastor:running`).
This option is outside post-job cleanup scope, but recommended for production.

### 10.7 Graceful Shutdown

On `SIGTERM`/`SIGINT`:
- Delete input files of current task (if any).
- Don't touch output file — result may be useful for recovery.
- Don't wait for generation to complete.
