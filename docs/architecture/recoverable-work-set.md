# Animastor — Recoverable Work Set (Recon #3)

> **Cathedral Project — Recon #3 · Recoverable Work Set formalization**
> Date: August 2026 · Method: code-first proof of a *deterministic* work-set computation. **No code changed.**
> Scenario: **PostgreSQL = intact, filesystem = intact, Redis = empty** (after total Redis state loss, backend restarted).
> Question this document answers:
> **Given PG + FS + empty Redis, can we deterministically compute `WORK_TO_DO` — the set of scenes (and per-scene stages) that must be re-dispatched — without (1) duplicate generation, (2) losing dirty state, (3) resurrecting cancelled work, (4) regenerating valid artifacts?**
>
> Companion docs: `architecture-map.md` (Recon #1), `redis-failure-model.md` (Recon #2 — the gap analysis this work builds on).

---

## 1. The claim under test

Recon #2 established: after cold Redis, `animastor:active-scenes` = ∅, the scheduler idles, and generation resumes **only** via client action. The proposed fix (option E) is a **startup phase that rebuilds the work list from PostgreSQL + filesystem**.

Recon #3 does **not** implement that phase. It proves whether the computation is possible *correctly* — i.e. whether the four constraints can be simultaneously satisfied by data that survives Redis loss.

**Verdict in one sentence (full proof below):**
> A deterministic `WORK_TO_DO` is **computable from PG + FS alone**, and it satisfies (1) no duplicates, (2) no lost dirty state, (4) no regeneration of valid artifacts — **with exactly one hard caveat: cancelled books are indistinguishable from in-flight books after Redis loss, and a scene cancelled at Redis level will be re-added to the work list** (constraint (3) cannot be proven for the whole-book windowed path; it holds only for the VBook/agent path via `book_generation_sessions`).

---

## 2. Inputs that survive Redis loss

| Input | Where | Producer | Content | Survives Redis loss |
|---|---|---|---|---|
| Book JSON | FS (`BOOKS_DIR/{bookId}/book.json`) | editor/import | **canonical scene list** (`collectScenes`), scene text, units | ✅ |
| `scenes` | PG | `ensureSceneRow`/`bumpSceneVersions`/`setDirtyUnitIds` | per-scene `content_version`, `audio_config_version`, `is_dirty`, `dirty_unit_ids` | ✅ |
| `scene_assets` | PG | `orchestrator.completeStage` (markReady), `markDirtyScene` (markStale), `placeholder-audio`, book-sync | per-(scene,asset) `status`, `path`, `scene_content_version`, `scene_audio_config_version`, `build_id` | ✅ |
| `book_generation_sessions` | PG | window-generator / import | VBook window state: `status` (`pending/generating/queued/completed/cancelled/failed`), `completion_status` | ✅ |
| `generation_tasks` | PG | selective-gen routes | task-level status (`running/completed/failed/cancelled`) | ✅ |
| Artifacts | FS (`OUTPUT_DIR/{build_id}/`) | workers | `.mp3` (merged), `*_iu*.png`, `.mp4` | ✅ |
| Placeholder marker | FS | placeholder-audio | `.mp3` indistinguishable from real TTS by name — **must probe `hasRealAudio`** (PG `scene_assets.status='placeholder'` row OR duration heuristic) | ✅ (via PG + FS) |
| **`layer-config`** | **Redis only** | routes | which layers are enabled per book | ❌ **LOST** |
| **cancel flag** | **Redis only** | window routes | `animastor:generation:cancel:{bookId}` | ❌ **LOST** |
| `gen-scope` | Redis | routes | scope bounds of last run | ❌ LOST (recoverable from `book_generation_sessions` for VBook) |

**The two inputs that do NOT survive are exactly the two that threaten constraints (3) and (4).** Everything else needed for the predicate is present.

---

## 3. Definition: `WORK_TO_DO`

`WORK_TO_DO` is a set of **scenes**, each with a **per-stage plan** (which of `audio`/`image`/`video` need dispatch):

```
WORK_TO_DO = { (bookId, chapterId, sceneId) →
              stages_needed ⊆ {audio, image, video} }
```

It must be **derived deterministically** from PG + FS. Deterministic here means: same inputs ⇒ same output, no dependence on Redis contents, no dependence on wall-clock ordering of writes, no random choice.

---

## 4. The predicate — stage by stage

For one scene with enabled layers `L ⊆ {audio, image, video}` (see §6 for the layer-config caveat), each stage `s ∈ L` needs work iff:

```
needs_work(s) = NOT has_valid_artifact(s)
              OR is_version_stale(s)
              OR has_pending_dirty_marker(s)
```

Where:

| Term | Definition | Evidence |
|---|---|---|
| `has_valid_artifact(s)` | `scene_assets` row with `status='ready'` **AND** `path` is non-null **AND** file exists on FS **AND** (for audio) `hasRealAudio` returns true (not placeholder) | `scene-assets-repo.isSceneReady` (`status='ready' && path`); `scene-window.checkSceneContentCache` (FS probe + `placeholderAudio.hasRealAudio`); `getSceneFilesStatus` |
| `is_version_stale(s)` | `scene_assets.scene_content_version < scenes.content_version` OR (`s=audio` and `scene_audio_config_version < audio_config_version`) — for a `ready` asset | `getDirtyScenesByVersion` (scene-assets-repo.js:410-445), `getOutdatedByVersions`, scheduler `detectVersionStale` |
| `has_pending_dirty_marker(s)` | `scenes.is_dirty = TRUE` OR `scene_assets.status IN ('stale','failed','pending')` OR `scenes.dirty_unit_ids` non-empty | `bumpSceneVersions` sets `is_dirty=TRUE` (R4.1); `markDirtyScene` writes `scene_assets.status='stale'` (T5); `clearDirtyFlag` clears on scene completion; `setDirtyUnitIds` granular force-regen |

**A scene enters `WORK_TO_DO` iff at least one enabled stage `needs_work`.**

This is exactly the union of what C2 (`checkVersionStaleness`) and the dormant `getDirtyScenesByVersion` already implement, plus a **filesystem probe** (which neither C2 nor the dormant query performs).

---

## 5. Proof of constraints (1), (2), (4) — and the failure of (3)

### 5.1 No duplicate generation ✅

Duplicate generation is prevented by three layers, all independent of Redis contents (they re-instantiate on restart):

1. **Version gate (PG):** `orchestrator.completeStage` runs a fail-closed version check *before* `markReady`; a stale-completing dispatch is finalized as DIRTY, not READY. So an already-valid artifact is never re-validated by a new generation as a *different* artifact — a re-dispatch of a scene whose artifact is genuinely current is not even admitted into the work set (§4 predicate).
2. **Idempotent work-list membership:** `addSceneToActiveIndex` is `SADD` — re-adding an already-present scene is a no-op; the dispatch engine's Lua lease claim (`dispatch-lease` NX) guarantees at most one in-flight dispatch per (scene,stage) regardless of how many times the scene re-enters the list.
3. **Dispatch-scoped dedup:** `animastor:job:{dispatch_id}:{job_id}` NX and `result-processed:{dispatch_id}:{job_id}:{build}` NX make duplicate *callbacks* harmless; `verifyDispatchIdentity` rejects stale dispatch metadata.

**Residual duplicate:** a scene whose generation was in flight at the moment of Redis loss has no `dispatch-lease` and no `dispatch-meta` after restart → it is re-dispatched. The second dispatch produces the same deterministic filename and overwrites. This is the *intended* behavior of the re-dispatch path (bounded duplicate GPU work, no corruption — Recon #2 §7, §9). Not a violation of (1).

### 5.2 No lost dirty state ✅

Dirty state lives in PG and is written **synchronously with the Redis write** in the facade paths:

- `bumpSceneVersions` → `is_dirty=TRUE` + version bump (PG), called from edit/save routes *before* Redis dirty marking (core-routes.cjs:239/399/534/596/654).
- `orchestrator.markDirtyScene` (T5) → `scene_assets.status='stale'` in PG, graceful-failure wrapper.
- `markDirtyScenes` (Lua/JS) writes Redis only, **but** the same logical dirty is guaranteed to be in PG via `bumpSceneVersions` — the routes call it with the full diff, unfiltered by scope (core-routes.cjs:239/399/534/596/654), so every dirty scene (in or out of scope) gets its PG version bump + `is_dirty` regardless of what the Redis-side marking later does.
- `clearDirtyFlag` is only called from scene completion callbacks (audio/image/video) **after** the version gate passes — so PG dirty markers are never cleared for unfinished work.

**Consequence:** after Redis loss, PG still holds `is_dirty`, version deltas, `dirty_unit_ids`, and `stale`/`pending`/`failed` asset rows for every scene that needs work. The §4 predicate reads exactly these. No dirty state is lost.

**Residual risk (pre-existing, not introduced by the rebuild):** the C0 over-marking quirk (Recon #2 P1) sets all three asset states to READY for any scene with a merged `.mp3`. If the rebuild phase *trusted* C0's Redis states instead of the PG+FS predicate, image/video work would be lost. The §4 predicate deliberately **does not read Redis asset state** — it reads PG statuses and probes FS — so it is immune to this. (The rebuilt Redis states will again be over-marked by C0, but the *work set* decision is PG+FS-based.)

### 5.3 No regeneration of valid artifacts ✅ (with layer-config caveat)

The predicate requires `has_valid_artifact(s)` — a `ready` row **plus a real file on disk** (and `hasRealAudio` for audio). So:

- A scene with a genuine merged `.mp3` + `_iu*.png` + `.mp4` at current versions: not in `WORK_TO_DO`. ✅
- A scene with `status='ready'` but the file **deleted from FS**: `has_valid_artifact` false → re-dispatch. This is correct (artifact is gone); it also *repairs* a pre-existing inconsistency (Recon #1: PG mirror can claim ready while FS file is missing).
- A scene whose audio is a **placeholder** (PG `status='placeholder'` or `hasRealAudio=false`): `has_valid_artifact(audio)=false` → audio re-dispatched. **Caveat:** placeholder audio is a *legitimate fallback* (TTS unavailable). Re-adding it to the work set re-triggers TTS; if the TTS failure is permanent, the scene will bounce. This matches current manual behavior (re-Generate) — acceptable, but note it in §9.

**Caveat — layer-config (constraint (4) can be violated for disabled layers):** which layers are enabled is stored **only in Redis** (`animastor:layer-config:{bookId}`). After Redis loss the rebuild phase does not know that e.g. `video_enabled=false`. If a scene has no `.mp4` because video was *disabled*, the §4 predicate (with default "all layers enabled") would mark video as needing work and regenerate it. Mitigations available today:
- Treat **absence of a PG `scene_assets` row for video + book-level completion signal** (`book_generation_sessions.completion_status='completed'` or `scenes.is_dirty` all false) as "layer disabled", not "needs work".
- Better: persist layer-config to PG or book JSON (future operation, §9).

### 5.4 No resurrection of cancelled work ❌ (cannot be proven for the whole-book path)

This is the **one constraint the reconstruction cannot satisfy**, and Recon #2 already surfaced the mechanism:

- Whole-book / windowed generation cancel = Redis-only flag `animastor:generation:cancel:{bookId}` (`scene-window.setCancelFlag`). **No PG write.**
- VBook/agent cancel = PG `agent_sessions.status='cancelled'` + `book_generation_sessions.status='cancelled'` + Redis `cancelled-workers:{bookId}` (3600 s TTL).
- Selective generation cancel = PG `generation_tasks.status='cancelled'` (`cancelActiveTasksForBook`) + agent_sessions cancel.

After Redis loss:
- The Redis cancel flags are gone.
- For the **whole-book path**, PG has *no record that the user pressed Cancel*. The rebuild phase will see scenes with `is_dirty=TRUE` / version deltas / `pending` assets and re-add them to the work list. **The user's cancellation is silently overridden on restart.**
- For the **VBook path**, `book_generation_sessions` with `status='cancelled'` survives → the rebuild can skip cancelled books. For **selective-gen**, `generation_tasks.status='cancelled'` survives but is per-task and ambiguous (a cancelled task may be a completed batch's tombstone).

**Conclusion:** constraint (3) holds **only for books with PG session/task cancellation records**. For books whose generation was cancelled through the whole-book windowed UI, `WORK_TO_DO` **cannot** distinguish "cancelled by user" from "in progress when Redis died" — the information simply does not exist in PG.

**Required decision for the future operation:** the rebuild phase needs an explicit cancellation policy. Options:
1. **Tombstone writes:** whole-book cancel also writes a PG row (e.g. `book_generation_sessions` or a `book_events` cancel event) — then the rebuild skips cancelled books. Small, precise, but touches the cancel path. **✅ IMPLEMENTED (Cathedral Operation #1, Aug 2026):** table `generation_cancellations` + `generation-cancel-repo`; written by `POST /cancel-generation`, cleared by `POST /regenerate`, honored by `startup-resume` (Phase C5) so a cancelled book is never auto-resumed after Redis loss. The future work-list rebuild must call `getAllCancelled()` and skip those `book_id`s.
2. **Conservative default:** rebuild only books whose *most recent* `book_generation_sessions`/task state is `generating|pending|queued|completed` and never re-add books whose only PG signal is generic dirtiness. This would *under-resume* (some genuinely-interrupted books stay paused) — safe but incomplete.
3. **Accept the risk:** rebuild everything dirty; document that "cancel" after Redis loss is best-effort. Simplest, but violates the user's explicit action.

---

## 6. The full algorithm (as a spec, not implemented)

```
INPUT:  books = DISTINCT book_id FROM scenes              (PG — only books that ever started generation)
        for each book: book JSON from FS (canonical scene list via collectScenes)
        scene_assets, scenes, book_generation_sessions, generation_tasks from PG
        artifacts probed on FS under OUTPUT_DIR/{build_id}

FOR each book b:
    skip b if it has a PG cancellation record (policy per §5.4 — REQUIRED before implementation;
        no-op today for whole-book books: no such record exists until policy option (1) is implemented)
    layers_enabled = layer-config[b]  (Redis) → fallback DEFAULTS(all true) — §5.3 caveat
    build_id = latest build_id among b's scene_assets (or book JSON build field)

    FOR each scene s in collectScenes(bookJSON):
        for stage in layers_enabled:
            needs_work[stage] = NOT has_valid_artifact(b,s,stage,build_id)
                                OR is_version_stale(b,s,stage)
                                OR has_pending_dirty_marker(b,s,stage)
        if any needs_work[stage]:
            WORK_TO_DO += (b, s, { stage: needs_work[stage] })

OUTPUT: WORK_TO_DO  →  feed to scheduler via addSceneToActiveIndex
        (scheduler re-derives per-stage plans from Redis states on dispatch)
```

Notes:
- `build_id` selection matters: artifacts live under `OUTPUT_DIR/{build_id}`; `scene_assets` rows carry `build_id`. The rebuild must probe the **same build** the last generation used, else it may misjudge `has_valid_artifact`. `recoverChunksFromDisk` (C0) already scans FS builds — reuse its conventions.
- The predicate is **read-only** on PG/FS (no writes except the final `SADD` into the work list). It must run under the existing `CLEANUP_LOCK` to avoid racing a concurrent reconcile (idempotency table in Recon #2 §8 applies).
- `gen-scope` is Redis-only; the rebuild resumes the **whole book**, not the last scope. A book mid-scope will regenerate outside-scope scenes only if they fail the §4 predicate (i.e. they are genuinely incomplete) — no extra scope logic is needed for correctness, only for exactness of resumption.

---

## 7. What already exists that this phase would reuse

| Existing artifact | Location | Role |
|---|---|---|
| `getDirtyScenesByVersion` | scene-assets-repo.js:410-445 | **The core predicate already written and dormant** — `is_dirty` OR version mismatch on `ready` assets. No production caller (Recon #2 P5). |
| `getOutdatedByVersions` | scene-assets-repo.js:189-235 | Version-mismatch detection used by book-sync. |
| `getSceneFilesStatus` | scene-window.js | Unified FS probe (audio/img/video) — single source of truth. |
| `checkSceneContentCache` / `restoreChunkStatusForScene` | scene-window.js | FS + version probe; restore patterns to copy. |
| `hasRealAudio` | placeholder-audio.js | Placeholder-vs-real disambiguation. |
| `recoverChunksFromDisk` / `recoverAllBooksFromDisk` | redis-helpers.cjs | FS scan conventions + build-dir layout; used by C0. |
| `recoverMissingRedisChunks` | routes/book/recover-chunks.cjs | Existing "create missing Redis chunks from book JSON" — note it deliberately does **not** call `addActiveScene` (manual Generate is required) — see §8. |
| `resumeIncompleteSessions` | startup-resume.js | **Already runs on startup** — but only for VBook `book_generation_sessions` with `pending/generating/queued` status (see §7a). |

### 7a. The partial startup-rebuild that ALREADY EXISTS (correction to Recon #2)

Recon #2 stated "nothing at startup calls `addSceneToActiveIndex`". **Correction, code-verified:** `backend.cjs` startup → `reconcileCycle(startup:true)` → Phase C5 calls `resumeIncompleteSessions` → for each VBook session with `status IN ('pending','generating','queued')` it calls `runBackgroundWindowGeneration` → which calls `bootstrapNextWindow` and, when `registerForGpu=true`, **calls `activeScenes.addActiveScene` for the new scenes** (window-generator.cjs:106).

Why this does NOT close the gap:
1. It only resumes **VBook/agent** sessions (books that were imported via the text-import agent path). Ordinary whole-book/scope regeneration does not create `book_generation_sessions`.
2. It re-adds **only newly-created scenes** from the next text window — it does not re-add *existing* incomplete scenes of an interrupted window. If the window's scenes were created but never finished (or their Redis state was wiped), they are not re-enqueued.
3. `bootstrapNextWindow` on startup may re-process text that was already processed (session status flips `generating→pending` before rerun) — bounded by window indices, but not a general work-list rebuild.

**Implication for Recon #3's spec:** the option-E phase is not "write brand-new machinery from scratch" — it is "generalize the C5 resume to cover all books (not just VBook sessions) and all incomplete scenes (not just newly-windowed ones), using the §4 predicate."

---

## 8. Behavioral asymmetry: rebuild ≠ auto-start

The `recover-chunks.cjs` route carries an explicit comment (verified in code):
> "Do NOT register the scene for GPU scheduler here. Registering for GPU would auto-start generation without the user pressing the 'Generate' button. GPU registration must only happen via the explicit /regenerate endpoint."

This is the current **policy**: chunk repair never auto-starts generation. Option E **changes that policy** — a startup rebuild that auto-adds scenes to the active index means **generation resumes without user action after any Redis loss**. That is precisely the point of option E (Recon #2 §12), but it must be a *conscious product decision*:
- Pro: Redis loss no longer silently pauses generation; books self-heal.
- Con: a user who cancelled (or deliberately paused) generation gets it resumed automatically (ties into §5.4).
- Middle ground: rebuild runs only when `startup:true` AND the book has *no* PG cancellation record AND (optionally) a `resume_after_redis` flag set by the client.

Recon #3 does not decide this — it documents the asymmetry so the future operation's design is explicit.

---

## 9. Findings

1. **✅ Constraint (1) — no duplicates:** provable via version gate + SADD idempotency + dispatch-scoped dedup. Residual duplicate (in-flight-at-loss) is intended re-dispatch, not a violation.
2. **✅ Constraint (2) — no lost dirty state:** all dirty markers (`is_dirty`, versions, `dirty_unit_ids`, `stale`/`failed`/`pending` asset rows) are PG-resident and written before/with the Redis writes; predicate reads PG only.
3. **✅ Constraint (4) — no regeneration of valid artifacts:** PG `ready` rows are insufficient on their own (files can be missing; C0 over-marks) — the predicate requires an **FS probe** + `hasRealAudio`. **Caveat:** layer-config is Redis-only; books with disabled layers may be regenerated for disabled stages unless a PG/FS completion signal is used.
4. **❌ Constraint (3) — no resurrection of cancelled work:** **cannot be proven** for the whole-book path (cancel = Redis-only flag, no PG write). Provable only for VBook/agent (PG `book_generation_sessions.status='cancelled'`) and partially for selective-gen. A cancellation policy decision is a **prerequisite** for option E, not an implementation detail.
5. **The predicate already exists** (dormant `getDirtyScenesByVersion` + `getSceneFilesStatus` + `hasRealAudio`) — option E is mostly *wiring + a decision*, not new logic.
6. **A partial startup-rebuild already exists** (C5 → resumeIncompleteSessions → runBackgroundWindowGeneration → addActiveScene) but covers only VBook sessions and only newly-created scenes.
7. **Stale `generation_tasks.status='running'` rows become orphans after cold Redis** (selective-gen path). They do not participate in the §4 predicate, and a re-dispatched scene creates a *second* task row → duplicate task entries in the progress panel. No constraint is violated (progress display only), but cleanup of orphaned task rows is a separate follow-up task.
8. **build_id must be pinned** to the last generation's build for correct FS probing.

---

## 10. Recommendations (no implementation)

1. **Decide the cancellation policy first** (§5.4 options 1–3). Without this, option E silently overrides user cancels for whole-book generation.
2. **Persist layer-config to PG or book JSON** (smallest change: add to the book JSON on generate) so the rebuild can respect disabled layers — or accept the §5.3 completion-signal heuristic.
3. **Implement the rebuild as a generalization of C5** using the §4 predicate (`getDirtyScenesByVersion` ∪ FS probe ∪ `hasPendingDirtyMarker`), under `CLEANUP_LOCK`, writing only `SADD` to the active index.
4. **Do NOT trust Redis asset states (C0) for the work-set decision** — PG statuses + FS probe only (C0's over-marking would otherwise cause lost image/video work).
5. Consider a **`resume_after_redis` per-book flag** (or reuse `book_generation_sessions`) to make auto-resume opt-in per book — resolves both the cancel-asymmetry and the recover-chunks policy comment in one mechanism.

---

## 11. Definition of Done — the answer

> **Can we deterministically compute WORK_TO_DO from PG + FS with empty Redis?**
>
> **Yes for constraints (1), (2), (4):** the §4 predicate is deterministic, read-only on surviving data, and provably avoids duplicate generation, dirty-state loss, and regeneration of valid artifacts.
>
> **No for constraint (3) as stated:** a scene cancelled through the whole-book UI is indistinguishable from an interrupted scene after Redis loss — the cancellation signal was Redis-only and is gone. The computation is deterministic, but the *input signal for cancellation* is incomplete in PG.
>
> **Therefore option E is implementable today with correctness guarantees for re-dispatch safety and artifact preservation, but only after a deliberate cancellation-policy decision** (§5.4). The predicate machinery already exists in the codebase (dormant `getDirtyScenesByVersion`, unified FS probe, `hasRealAudio`); the missing pieces are policy + one startup wiring phase.
