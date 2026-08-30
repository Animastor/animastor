# Audit: ComfyUI Temp File Recovery/Cleanup via Orchestration State

> Reconnaissance before implementing recovery cleanup after worker crash/restart.
> Investigation of existing job lifecycle orchestration and how to safely
> perform cleanup of unfinished tasks (delivered=true, cleaned=false).
>
> **Read-only**: nothing was fixed. Based on source code reading.
> Date: 2026-08-24. Branch: `master` (`b860162`).
> Related document: `COMFYUI_TEMP_FILES_CLEANUP_AUDIT.md` (first audit),
> targeted cleanup implementation — commit `b860162`.
>
> ## Implementation Status
>
> Recommendation from this audit **implemented** in commit **`e874761`**:
> - `worker/worker/worker-cleanup-journal.cjs` — worker-local persistent journal
>   (one record per job, only concrete absolute paths, atomic writes
>   tmp→fsync→rename). API: `createJob` / `addInputFile` / `setOutputAndGenerated`
>   / `setDelivered` / `removeJob` / `recoverCleanupJournal`.
> - `worker.cjs`: journal created BEFORE first input file; each input path
>   recorded; output+`generated` — after `waitResult`; `delivered` — only
>   after HTTP 200 from hub `/task/result`; journal deleted only on full
>   cleanup success (partial cleanup retains record for next recovery).
> - Startup: `recoverCleanupJournal()` called after `waitForComfyUI()`,
>   before `workerLoop()`. delivered → input+output; created/generated → only
>   input (output without DELIVERED proof untouched).
> - Backend orchestration / Redis / PG unchanged. Idempotent: ENOENT = success.
> - Tests: `backend/tests/worker-cleanup-journal.test.js` (16 scenarios) + basic
>   cleanup tests `worker-cleanup.test.js`.

---

## 1. Where Job State Is Currently Stored

| Layer | What It Stores | Durability |
|---|---|---|
| **Worker** (`worker.cjs`) | Nothing. Fully stateless, HTTP-only to hub, no Redis/DB/files (except temp files themselves) | — |
| **Hub** (Redis, `gpu-hub.js`) | `animastor:queue:{type}[:ws:{ws}]`, `animastor:processing`, `animastor:running` (claim), `animastor:result:{build}:{book}:{chapter}:{scene}:{stage}` (base64, `EX 3600`), dedup `animastor:job:{dispatch}:{job}` | Redis has persisted volume `redis-data:/data` (docker-compose) — survives restart but TTL applies |
| **Backend** (Redis) | `animastor:asset-state:{book}:{ch}:{scene}` (per-asset: new/dirty/pending/generating/ready/failed/placeholder), `animastor:audio-orch:*`, `animastor:video-orch:*` (phase machines), dedup `animastor:result-processed:{dispatch}:{job}:{build}` (`EX 3600`), event-journal | Redis persisted |
| **Backend** (PostgreSQL) | `scene_assets` (status='ready', artifact path, build_id), `image_units`, `scenes` (content_version), workers | Durable, source of truth |

## 2. Existing Statuses/Flags

- **Per-asset** (`scene-state.js:19-27`): `NEW → DIRTY → PENDING → GENERATING → READY / FAILED / PLACEHOLDER`.
- **audio-orch PHASES**: `PLACEHOLDER_READY → GENERATING → WAITING_CHUNKS → MERGING → DONE` (+ FAILED).
- **video-orch PHASES**: `GENERATING → WAITING_CHUNKS → MERGING → DONE` (+ FAILED).
- **Hub claim**: job in `animastor:running` (with fields job_id, dispatch_id, assets, build_id, started_at). No delivered/cleaned fields.
- **Hub result key** `animastor:result:*` — only "delivered-analog", but per `scene:stage`, not per job.

**No `delivered`/`cleaned`/`acknowledged` flags exist at worker/job level anywhere.**

## 3. Image/Audio/Video Job Lifecycle (End-to-End)

```
backend dispatch-engine → gpu-dispatcher.sendUnified → hub /task (enqueue)
  → worker GET /task/next (rpoplpush → processing → running)
  → worker saves reference images to ComfyUI input  (image/video; audio — none)
  → worker POST /prompt → prompt_id
  → ComfyUI generates → output/ (or output/audio, output/video)
  → worker waitResult() → finds meta {filename, subfolder}
  → worker downloadResult() → reads file locally → base64
  → worker POST /task/result (hub)
      hub: writes animastor:result:*  (→ FIRST "durable" result snapshot)
      hub: removes from running/processing
      hub: forwards to backend /gpu/task/result (best-effort, 5 retry)
        backend: verifyDispatchIdentity → dedup → handleTaskResult
                 → writes file to /data/output/{build}/... → completeStage → asset READY + PG ready
  → worker receives HTTP 200 from hub → (b860162) finally deletes input+output
```

## 4. Key: GENERATED / DELIVERED Moments

- **GENERATED**: when `waitResult` found output file in ComfyUI (file exists on worker disk). No official marker — signal is file-only/local.
- **DELIVERED (worker perspective)**: when `POST /task/result` returned HTTP 200.
  **IMPORTANT**: hub writes `animastor:result:*` to Redis **BEFORE** 200 response (`gpu-hub.js:888-894` → `:961`). So moment 200 = result is **already durable in hub Redis** (full base64, TTL 1h) — even if forward to backend later fails (hub returns 200 in this scenario too, relying on `recoverResultKeys`).
- **DELIVERED (backend perspective)**: `animastor:result-processed:{dispatch}:{job}:{build}` (dedup, EX 3600) + file on disk + `scene_assets.status='ready'`.
- **Delivery confirmation exists**: worker has no access to these keys (no Redis). Worker only sees HTTP 200 from hub.

**Conclusion for §5**: reliably saying "durable result saved, ComfyUI output can be deleted" is possible when hub returned 200 `/task/result` — because at that moment hub already holds full base64 in `animastor:result:*`. This is the safety boundary.

## 6. Existing Recovery/Reconciliation

- `reconcileCycle()` (`reconciliation-engine.js:1256`): **single cycle** with distributed `animastor:cleanup-lock`. Phases: A=recoverResultKeys (scans `animastor:result:*` → re-invokes `handleTaskResult`), B1/B2=watchdog for stuck audio/video, C=startup phases (audio/video orch recovery, version staleness, worklist rebuild), D=full scene reconciliation + auto-fix. Called on startup and periodically (60s).
- This is a **backend-side** mechanism. It covers "result delivered to hub Redis but backend didn't receive" — does NOT cover "worker didn't delete ComfyUI temp files".
- **Cannot be extended for worker-side cleanup directly** — reconcile lives in backend process, ComfyUI files are on worker host. Worker's local file is inaccessible to backend.

## 7. Redis vs DB

- Cleanup state must be visible to **worker process** (the one performing deletion). Worker has neither Redis nor PG.
- Hub Redis survives restart (persisted volume), but: (a) worker doesn't access it; (b) result keys TTL 1h.
- DB (`scene_assets`) — scene-level, not job-level, also inaccessible to worker.
- **Conclusion**: new "orchestration state" for cleanup must live **on worker disk** (persistent per `SYSTEM.md` §1: entire `~/` survives instance reloads). This is the only storage accessible to the process that deletes files.

## 8. Idempotency

Already ensured by b860162 implementation: `safeUnlink` treats `ENOENT` as success. Repeat cleanup = no-op. Journal (below) must be idempotent: repeated `cleaned` writes or record deletion harmless.

## 9. Race Conditions

- **Single process per host**: on restart old process is dead → no competition. If supervisor started new worker while old was alive (briefly) — protection: recovery run processes only records with `phase=delivered` (set ONLY by the process that received 200 from hub) + age-guard (don't touch records younger than N seconds).
- **Two workers on one machine** (image+video) share one ComfyUI: file names unique by job_id (`baseId`/`scenePrefix`), no overlaps.
- **Repeat dispatch of same job** (hub requeue): input files recreated from `task.assets` (stored in claim) — deleting old input safe.

## 10. Video

- One scene = N reference images in input (one per IU) + 1 output mp4.
- All N input paths recorded in `createdInputFiles[]` (already done in b860162).
- Output = exactly the mp4 that `waitResult` selected (history / fallback / fs-scan) — meta already carries exact `{filename, subfolder}`.
- Journal must store **list of all input paths + single output path**.

---

# Proposed Lifecycle Model

```
CREATED   → worker wrote input files to ComfyUI input (and recorded journal)
GENERATED → waitResult found output in ComfyUI output
DELIVERED → sendResult returned 200 (hub durably wrote animastor:result:*)
CLEANED   → temp files deleted, journal finalized
```

Model **introduces no new backend statuses** — it is worker-local and builds on top of existing delivery signal (HTTP 200 from hub = durable result in hub Redis).

## A. Where to Store Cleanup State
**Worker-local journal** on host persistent disk: directory/file next to worker.cjs, e.g. `~/animastor/cleanup-journal/` with one record per job (JSON sidecar file). Lives longer than worker process, survives restart. Independent of Redis/PG.

Record:
```json
{ "job_id": "...", "dispatch_id": "...", "phase": "delivered",
  "input_files": [".../input/base_iu1.png", "..."],
  "output_file": ".../output/video/LTX-2_00001_.mp4",
  "created_at": 0, "updated_at": 0 }
```

## B. How to Link State to Paths
Names already tied to job_id: input = `${baseId}.png` / `${scenePrefix}_{unitId}.png`; output = `COMFY_OUTPUT_DIR + subfolder + filename`. Journal stores **absolute paths** (same as `createdInputFiles[]` / `outputPath` from b860162). No glob/prefix deletion.

## C. When to Set Delivered
Immediately after `sendResult()` returned success (HTTP 200), **synchronously write journal `phase=delivered` + fsync**. Window "hub accepted → worker wrote" = milliseconds; on crash in this window record stays `created`/`generated` → file NOT deleted (safe leak, not data loss).

## D. When to Set Cleaned
After actual deletion of all input files + output file (already in `finally` from b860162) → mark `cleaned` (or delete sidecar). File cleanup and `cleaned` write are idempotent.

## E. What to Do on Worker Crash
- **Before delivered**: journal in `created`/`generated`. On recovery input files can always be deleted (recreated from task.assets on re-dispatch), output — DON'T touch (no delivery confirmation; this is the only copy).
- **After delivered, before cleaned**: journal = `delivered` → recovery deletes input+output and sets `cleaned`. This is the target scenario for the task.

## F. What to Do on Worker Restart
On startup (after `waitForComfyUI`, before `workerLoop`) run `recoverCleanupJournal()`:
- `cleaned` → delete record (no-op).
- `delivered` → delete files, mark `cleaned`.
- `created`/`generated` → delete input files; output untouched (safe). Optionally: query hub about delivery to close the window "hub accepted but journal didn't record it."

## G. Repeat Cleanup
Safe: `safeUnlink` ENOENT→ok; `phase=cleaned` → skip. Journal is idempotent.

## H. How to Avoid Deleting Active Job Files
- Recovery processes only journal records (which don't exist for active job — it creates record on start and holds until cleanup).
- Age-guard: don't process records younger than ~60s (safety against live old process).
- `dispatch_id` in record → recovery won't touch job if dispatch_id doesn't match terminal state.
- No "delete by prefix/age everything in input/output" — only explicit paths from journal.

## I. Orphan Files Without Orchestration State
For files without journal record (old worker before implementation, journal loss) — **age-based sweep by worker's own name pattern** (name contains `baseId` from job_id) with conservative threshold (e.g., >24h), and only if file not in active `animastor:running`/`processing` (check via hub). This is a separate option; safer to start with journal, enable orphan-sweep later.

---

# Brief Recommendation

I propose implementing a **worker-local cleanup journal** (created/updated synchronously with lifecycle, stored on worker's persistent disk, idempotent) on top of existing delivery signal — **HTTP 200 from hub `/task/result`**, which at that moment already guaranteedly holds durable result copy in hub Redis (`animastor:result:*`). This:
- requires no backend/PG/Redis model changes (no new flags in existing orchestration);
- survives both worker-restart and Redis-restart;
- covers target scenario (delivered=true, cleaned=false → cleanup on startup) and safely degrades to leak (not loss) in reverse window;
- uses existing b860162 primitives (`cleanupJobArtifacts`, `createdInputFiles[]`, `outputPath`, `safeUnlink`), extending them with journal and `recoverCleanupJournal()` on startup;
- single new link needed if closing window "hub accepted → journal didn't record" — lightweight hub endpoint `GET /task/status` (optional).

Why not Redis/PG for this state: worker is the only process with access to ComfyUI files, but it has no access to Redis/PG; existing backend mechanisms (reconcileCycle, audio-recovery) treat "result in hub Redis but not in backend" and don't see files on worker host. Therefore cleanup state must belong to worker and live on its disk.
